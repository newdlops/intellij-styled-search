import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

interface SearchState {
  searching: boolean;
  filesCount: number;
  flatCount: number;
  inputValue: string | null;
  rgQuery: string;
  filterQuery: string;
  err?: string;
}

async function probeState(api: ExtensionTestApi): Promise<SearchState> {
  const raw = await api.overlay.evalInActiveWindowForTests(
    `(function(){try{return JSON.stringify(window.__ijFindGetSearchState())}catch(e){return JSON.stringify({err:String(e&&e.message)})}})()`,
  );
  return JSON.parse(raw);
}

async function waitUntil(
  api: ExtensionTestApi,
  predicate: (s: SearchState) => boolean,
  timeoutMs: number,
  label: string,
): Promise<SearchState> {
  const deadline = Date.now() + timeoutMs;
  let last: SearchState | undefined;
  while (Date.now() < deadline) {
    last = await probeState(api);
    if (predicate(last)) { return last; }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`waitUntil timed out (${timeoutMs}ms): ${label}. last=${JSON.stringify(last)}`);
}

let cdpAvailable = false;

suite('Extension-typing filter — client-side narrowing', () => {
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

  setup(async function () {
    if (!cdpAvailable) { return; }
    const api = await getApi();
    await api.overlay.show('');
    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var q = document.querySelector('.ij-find-query');
        if (!q) { return 'no-query'; }
        q.value = '';
        q.dispatchEvent(new Event('input', { bubbles: true }));
        return 'cleared';
      })()`,
    );
    await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === '' && s.filterQuery === '',
      5_000,
      'clear prior renderer search state',
    );
  });

  test('typing an extension of the query does NOT re-run rg', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();

    // First search — sets rgQuery on the renderer side.
    await api.overlay.show('class');
    const afterFirst = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'class',
      10_000,
      'first search to settle with rgQuery=class',
    );
    assert.strictEqual(afterFirst.rgQuery, 'class');
    assert.strictEqual(afterFirst.filterQuery, '', 'filterQuery should be empty after a full rg run');

    // Second search — extension of the first. triggerSearch must take the
    // client-side filter path: state.rgQuery stays 'class', filterQuery
    // becomes the new (longer) string. We poll for filterQuery explicitly
    // so the test isn't racing the 2-RAF delay between show() and
    // triggerSearch().
    await api.overlay.show('class BetaWidget');
    const afterExt = await waitUntil(
      api,
      (s) => s.inputValue === 'class BetaWidget' && s.filterQuery === 'class BetaWidget',
      5_000,
      'extension query to reach input and filterQuery',
    );
    assert.strictEqual(
      afterExt.rgQuery, 'class',
      `rgQuery should stay at the broader query, got ${JSON.stringify(afterExt)}`,
    );
    assert.strictEqual(
      afterExt.filterQuery, 'class BetaWidget',
      `filterQuery should hold the new (narrower) query, got ${JSON.stringify(afterExt)}`,
    );
  });

  test('typing a disjoint query (not a prefix) triggers a fresh rg run', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();

    await api.overlay.show('BetaWidget');
    await waitUntil(api, (s) => !s.searching && s.rgQuery === 'BetaWidget', 10_000, 'first disjoint search');

    // Disjoint query (does NOT start with 'BetaWidget') — must cancel+restart.
    await api.overlay.show('AlphaService');
    const after = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'AlphaService',
      10_000,
      'disjoint second search to replace rgQuery',
    );
    assert.strictEqual(after.rgQuery, 'AlphaService');
    assert.strictEqual(after.filterQuery, '', 'filterQuery should reset on a fresh rg run');
  });

  test('backspacing one char (new is prefix of old) is treated as disjoint, not extension', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();

    await api.overlay.show('class AlphaService');
    await waitUntil(api, (s) => !s.searching && s.rgQuery === 'class AlphaService', 10_000, 'priming search');

    // New query is a PREFIX of the old one — our policy: cancel+restart
    // because in-flight results would be a subset and can't be widened
    // by a client-side filter.
    await api.overlay.show('class AlphaServic');
    const after = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'class AlphaServic',
      10_000,
      'backspace-shorter query to trigger fresh rg',
    );
    assert.strictEqual(after.rgQuery, 'class AlphaServic');
    assert.strictEqual(after.filterQuery, '');
  });

  test('multiline query preserves indentation exactly', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();
    const query = [
      '    def process(self, data: str) -> str:',
      '        self.counter += 1',
    ].join('\n');

    await api.overlay.show(query);
    const after = await waitUntil(
      api,
      (s) => !s.searching && s.inputValue === query && s.rgQuery === query && s.filesCount > 0,
      10_000,
      'multiline query to survive renderer roundtrip without trimming',
    );
    assert.strictEqual(after.inputValue, query);
    assert.strictEqual(after.rgQuery, query);
  });
});
