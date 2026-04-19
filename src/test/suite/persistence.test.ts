import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import { TrigramIndex } from '../../trigramIndex';
import { MAGIC, VERSION_V3 } from '../../codesearch/binaryIndex';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function makeTempStorage(): vscode.Uri {
  const dir = path.join(os.tmpdir(), `ij-find-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return vscode.Uri.file(dir);
}

function findIndexFile(storageDir: vscode.Uri): string | null {
  try {
    const entries = fs.readdirSync(storageDir.fsPath);
    const hit = entries.find((n) => n.startsWith('trigram-') && n.endsWith('.v2.bin'));
    return hit ? path.join(storageDir.fsPath, hit) : null;
  } catch { return null; }
}

suite('Persistence — v3 format round-trip', () => {
  const log = vscode.window.createOutputChannel('ij-find-test');

  suiteSetup(async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.rebuildIndex();
    await overlay.waitForIndexReady(30_000);
  });

  test('save() writes a file whose header identifies as v3', async function () {
    this.timeout(30_000);
    const storage = makeTempStorage();
    const idx = new TrigramIndex(storage, log);
    await idx.init();
    await idx.rebuild();
    await idx.flushToDisk();

    const filePath = findIndexFile(storage);
    assert.ok(filePath, 'no index file was written');
    const header = fs.readFileSync(filePath!).slice(0, 8);
    assert.strictEqual(
      header.slice(0, MAGIC.length).toString('utf-8'),
      'TRIG',
      'file magic is not TRIG',
    );
    assert.strictEqual(
      header.readUInt32LE(4),
      VERSION_V3,
      `file version is ${header.readUInt32LE(4)}, expected ${VERSION_V3}`,
    );
    idx.dispose();
  });

  test('save → reload preserves candidate set (exercises v3 lazy path)', async function () {
    this.timeout(30_000);
    const storage = makeTempStorage();
    const buildIdx = new TrigramIndex(storage, log);
    await buildIdx.init();
    await buildIdx.rebuild();
    await buildIdx.flushToDisk();

    // A fresh instance against the same storage reads the v3 file from
    // disk — postings stay lazy until resolvePosting() pulls them. If the
    // lazy read path is broken, candidates will come back empty or wrong.
    const reloadIdx = new TrigramIndex(storage, log);
    await reloadIdx.init();

    const opts = { useRegex: false, caseSensitive: false, wholeWord: false } as const;
    const queries = [
      'class AlphaService:',
      'class BetaWidget',
      'Fixture Documentation',
      '한국어 지원',
    ];
    for (const q of queries) {
      const a = buildIdx.candidatesFor(q, opts);
      const b = reloadIdx.candidatesFor(q, opts);
      const aSet = a.uris ? Array.from(a.uris).sort() : null;
      const bSet = b.uris ? Array.from(b.uris).sort() : null;
      assert.deepStrictEqual(
        bSet, aSet,
        `v3 reload diverged from in-memory result for query ${JSON.stringify(q)}`,
      );
    }

    buildIdx.dispose();
    reloadIdx.dispose();
  });

  test('multiple save cycles stay idempotent', async function () {
    // Catch regressions in relazyFromImage offset math — each save()
    // re-lays out the postings section, so a buggy offset table would
    // corrupt results on the *second* save (still readable on the first).
    this.timeout(30_000);
    const storage = makeTempStorage();
    const idx = new TrigramIndex(storage, log);
    await idx.init();
    await idx.rebuild();
    await idx.flushToDisk();
    const opts = { useRegex: false, caseSensitive: false, wholeWord: false } as const;
    const before = idx.candidatesFor('class AlphaService:', opts);

    await idx.flushToDisk();       // second save round-trip
    const after1 = idx.candidatesFor('class AlphaService:', opts);

    await idx.flushToDisk();       // third
    const after2 = idx.candidatesFor('class AlphaService:', opts);

    const snap = (s: { uris: Set<string> | null }) => (s.uris ? Array.from(s.uris).sort() : null);
    assert.deepStrictEqual(snap(after1), snap(before));
    assert.deepStrictEqual(snap(after2), snap(before));
    idx.dispose();
  });
});
