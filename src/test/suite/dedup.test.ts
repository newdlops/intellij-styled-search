import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function makeEvent(src: string, seq: number, msg = 'ping-' + seq): string {
  return JSON.stringify({ type: 'log', msg: `[dedup-test] ${msg}`, __seq: seq, __src: src });
}

function dedupStateFor(api: ExtensionTestApi, src: string): number | undefined {
  const entries = api.overlay.getDedupStateForTests();
  const hit = entries.find(([s]) => s === src);
  return hit ? hit[1] : undefined;
}

suite('Per-source seq dedup — cross-window regression', () => {
  suiteSetup(async function () {
    this.timeout(15_000);
    const api = await getApi();
    try { await api.overlay.awaitInjection(); } catch {}
  });

  test('two independent sources starting at seq=1 are BOTH accepted', async () => {
    // Regression for the period where lastSeenSeqBySrc was a single global
    // counter — a second window whose __ijFindSeq happened to be lower
    // than another window's most-recent __seq would have its legitimate
    // events silently dropped.
    const api = await getApi();
    const srcA = 'dedup-src-A-' + Date.now();
    const srcB = 'dedup-src-B-' + Date.now();

    api.overlay.injectRendererEventForTests(makeEvent(srcA, 1, 'a1'));
    api.overlay.injectRendererEventForTests(makeEvent(srcB, 1, 'b1'));

    assert.strictEqual(dedupStateFor(api, srcA), 1, 'src A should be tracked after its first event');
    assert.strictEqual(dedupStateFor(api, srcB), 1, 'src B should be tracked after its first event');
  });

  test('duplicate payloads from the same source are dropped', async () => {
    const api = await getApi();
    const src = 'dedup-same-src-' + Date.now();

    api.overlay.injectRendererEventForTests(makeEvent(src, 1));
    api.overlay.injectRendererEventForTests(makeEvent(src, 1));  // duplicate
    api.overlay.injectRendererEventForTests(makeEvent(src, 1));  // duplicate

    assert.strictEqual(
      dedupStateFor(api, src), 1,
      'lastSeenSeq should stay at 1 even after duplicate deliveries',
    );
  });

  test('later seq for same source advances the watermark', async () => {
    const api = await getApi();
    const src = 'dedup-advancing-' + Date.now();

    api.overlay.injectRendererEventForTests(makeEvent(src, 1));
    api.overlay.injectRendererEventForTests(makeEvent(src, 5));
    api.overlay.injectRendererEventForTests(makeEvent(src, 3));  // old, should be ignored
    api.overlay.injectRendererEventForTests(makeEvent(src, 7));

    assert.strictEqual(
      dedupStateFor(api, src), 7,
      'watermark should reflect the highest seq seen, not the last delivered',
    );
  });

  test('low-seq event from srcB is NOT dropped even if srcA has a high watermark', async () => {
    // This is the EXACT regression test for the silent-drop bug. Under
    // the old single-counter implementation, srcA's seq=999 would poison
    // srcB's first event (seq=1) as "already seen".
    const api = await getApi();
    const srcA = 'dedup-high-src-A-' + Date.now();
    const srcB = 'dedup-low-src-B-' + Date.now();

    // srcA pumps its counter way up.
    for (let i = 1; i <= 100; i++) {
      api.overlay.injectRendererEventForTests(makeEvent(srcA, i));
    }
    assert.strictEqual(dedupStateFor(api, srcA), 100);

    // srcB's fresh counter must not be blocked by srcA's high watermark.
    api.overlay.injectRendererEventForTests(makeEvent(srcB, 1));
    assert.strictEqual(dedupStateFor(api, srcB), 1, 'srcB seq=1 must NOT be dropped');
    api.overlay.injectRendererEventForTests(makeEvent(srcB, 2));
    assert.strictEqual(dedupStateFor(api, srcB), 2);
  });
});
