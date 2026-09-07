import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { serializeV3 } from '../../codesearch/binaryIndex';
import { TrigramIndex } from '../../trigramIndex';

type IndexInternals = {
  ready: boolean;
  postingCacheMaxBytes: number;
  postingCacheMaxEntries: number;
  postingCacheBytes: number;
  postingCache: Map<string, Uint32Array>;
  tris: Map<string, { kind: 'lazy'; length: number } | Uint32Array | Set<number>>;
  load(): Promise<void>;
  addToPosting(tri: string, id: number): void;
};

suite('Trigram index resource bounds', () => {
  const log = vscode.window.createOutputChannel('Trigram resource tests');
  let storage: vscode.Uri;
  let index: TrigramIndex;
  let internal: IndexInternals;

  suiteTeardown(() => log.dispose());

  setup(async () => {
    storage = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-trigram-resources-')));
    index = new TrigramIndex(storage, log);
    internal = index as unknown as IndexInternals;
    internal.postingCacheMaxBytes = 16;
    internal.postingCacheMaxEntries = 2;
    const image = serializeV3({
      nextId: 7,
      fileMeta: new Map(Array.from({ length: 6 }, (_, i) => [i + 1, {
        uri: vscode.Uri.joinPath(storage, `${i + 1}.txt`).toString(), mtime: 1, size: 1,
      }])),
      tris: new Map([
        ['aaa', Uint32Array.of(1, 2)], ['bbb', Uint32Array.of(2, 3)],
        ['ccc', Uint32Array.of(3, 4)], ['ddd', Uint32Array.of(1, 2, 3, 4, 5)],
      ]),
    });
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(storage, index.persistedIndexFileName), image);
    await internal.load();
    internal.ready = true;
  });

  teardown(async () => {
    index.dispose();
    await vscode.workspace.fs.delete(storage, { recursive: true, useTrash: false });
  });

  function candidates(query: string, options = { useRegex: false }): number[] {
    const result = index.candidatesFor(query, options);
    assert.ok(result.uris, result.reason);
    return [...result.uris!].map((uri) => Number(path.basename(vscode.Uri.parse(uri).fsPath, '.txt'))).sort();
  }

  test('eviction, oversized reads and repeated queries preserve literal and regex candidates', () => {
    assert.deepStrictEqual(candidates('aaa'), [1, 2]);
    assert.deepStrictEqual(candidates('bbb'), [2, 3]);
    assert.deepStrictEqual(candidates('aaa'), [1, 2]); // refresh LRU order
    assert.deepStrictEqual(candidates('ccc'), [3, 4]);
    assert.deepStrictEqual([...internal.postingCache.keys()], ['aaa', 'ccc']);
    assert.strictEqual(internal.postingCacheBytes, 16);
    assert.deepStrictEqual(candidates('ddd'), [1, 2, 3, 4, 5]);
    assert.ok(!internal.postingCache.has('ddd'), 'oversized postings must not be retained');
    assert.deepStrictEqual(candidates('bbb'), [2, 3], 'evicted posting must reload');
    assert.deepStrictEqual(candidates('aaa|ccc', { useRegex: true }), [1, 2, 3, 4]);
    assert.deepStrictEqual(candidates('aaa.*bbb', { useRegex: true }), [2]);
    for (const posting of internal.tris.values()) {
      assert.strictEqual((posting as { kind?: string }).kind, 'lazy', 'queries must preserve reloadable disk references');
    }
    assert.ok(internal.postingCacheBytes <= 16);
    assert.ok(internal.postingCache.size <= 2);
    index.dispose();
    assert.strictEqual(internal.postingCache.size, 0);
    assert.strictEqual(internal.postingCacheBytes, 0);
  });

  test('entry cap also bounds tiny postings independently of the byte cap', () => {
    internal.postingCacheMaxBytes = 1024;
    for (const query of ['aaa', 'bbb', 'ccc']) { candidates(query); }
    assert.deepStrictEqual([...internal.postingCache.keys()], ['bbb', 'ccc']);
    assert.strictEqual(internal.postingCacheBytes, 16);
  });

  test('unchanged additions stay compact and changed postings survive eviction, save and reload', async () => {
    internal.addToPosting('aaa', 1);
    assert.strictEqual((internal.tris.get('aaa') as { kind: string }).kind, 'lazy');
    internal.addToPosting('aaa', 6);
    assert.ok(internal.tris.get('aaa') instanceof Set, 'new IDs must remain resident until persisted');
    assert.ok(!internal.postingCache.has('aaa'), 'promotion must release the clean cached array');
    for (const query of ['bbb', 'ccc', 'ddd']) { candidates(query); }
    assert.deepStrictEqual(candidates('aaa'), [1, 2, 6]);
    await index.flushToDisk();
    assert.strictEqual(internal.postingCache.size, 0, 'new offsets invalidate the read cache');
    assert.strictEqual(internal.postingCacheBytes, 0);
    assert.deepStrictEqual(candidates('aaa'), [1, 2, 6]);
    const reloaded = new TrigramIndex(storage, log);
    try {
      const state = reloaded as unknown as IndexInternals;
      await state.load();
      state.ready = true;
      assert.deepStrictEqual(reloaded.candidatesFor('aaa', { useRegex: false }).uris, index.candidatesFor('aaa', { useRegex: false }).uris);
    } finally { reloaded.dispose(); }
  });
});
