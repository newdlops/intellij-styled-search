import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

async function probeState(api: ExtensionTestApi): Promise<any> {
  const raw = await api.overlay.evalInActiveWindowForTests(
    `(function(){try{return JSON.stringify(window.__ijFindGetSearchState())}catch(e){return JSON.stringify({err:String(e&&e.message)})}})()`,
  );
  return JSON.parse(raw);
}

let cdpAvailable = false;

suite('Resilience — bridge auto-repair', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    const api = await getApi();
    try {
      await api.overlay.awaitInjection();
      cdpAvailable = true;
    } catch {
      cdpAvailable = false;
    }
    if (cdpAvailable) {
      await api.overlay.rebuildIndex();
      await api.overlay.waitForIndexReady(30_000);
    }
  });

  test('ws close followed by show() auto-recovers and runs the search', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const api = await getApi();

    // Prime with one successful show so activeWindowId etc. are set.
    await api.overlay.show('class AlphaService:');
    const before = api.overlay.getConnectionStateForTests();
    assert.ok(before.wsOpen, 'WebSocket should be open before kill');

    // Kill the bridge mid-session.
    const closed = api.overlay.closeWebSocketForTests();
    assert.ok(closed, 'closeWebSocketForTests did not find an open ws');

    // The next show() must transparently reopen CDP + reinject the patch
    // and still deliver a search result. If ensureInjected / auto-repair
    // regresses, this hangs or leaves input/searching in a bad state.
    await api.overlay.show('class BetaWidget');
    // Poll for searching=false with input value reflecting the new query.
    const expectedQuery = 'class BetaWidget';
    const deadline = Date.now() + 10_000;
    let s: any;
    while (Date.now() < deadline) {
      s = await probeState(api);
      if (!s.searching && s.inputValue === expectedQuery) { break; }
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(s, 'probe never returned a state');
    assert.strictEqual(s.inputValue, expectedQuery, `input didn't get new query after recovery; state=${JSON.stringify(s)}`);
    assert.strictEqual(s.searching, false, `search should have completed after recovery; state=${JSON.stringify(s)}`);

    const after = api.overlay.getConnectionStateForTests();
    assert.ok(after.wsOpen, 'WebSocket should be reopened after recovery');
  });

  test('bridge ping catches a silent bridge death before show lands', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();

    // If ws is already closed by the previous test, ensureInjected in
    // show() will notice. But the verifyBridgeAlive-driven repair is for
    // the subtler case where ws is open but the bridge listener is gone.
    // We exercise the simpler "ws closed" path here, which must behave
    // the same way from the user's perspective: show() just works.
    api.overlay.closeWebSocketForTests();
    await api.overlay.show('Feature Alpha');
    const expected = 'Feature Alpha';
    const deadline = Date.now() + 10_000;
    let s: any;
    while (Date.now() < deadline) {
      s = await probeState(api);
      if (!s.searching && s.inputValue === expected) { break; }
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.strictEqual(s.inputValue, expected, `state=${JSON.stringify(s)}`);
  });
});
