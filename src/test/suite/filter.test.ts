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
  scopeValue?: string | null;
  rgQuery: string;
  rgScope?: string;
  filterQuery: string;
  historyCount?: number;
  history?: string[];
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
let priorEngineSetting: string | undefined;

suite('Extension-typing filter — client-side narrowing', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    const api = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    priorEngineSetting = cfg.inspect<string>('engine')?.workspaceValue;
    await cfg.update('engine', 'codesearch', vscode.ConfigurationTarget.Workspace);
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
        var scope = document.querySelector('.ij-find-scope');
        if (!q || !scope) { return 'no-query'; }
        q.value = '';
        scope.value = '';
        ['caseSensitive', 'wholeWord', 'useRegex'].forEach(function (key) {
          var btn = document.querySelector('[data-opt="' + key + '"]');
          if (btn && btn.getAttribute('aria-pressed') === 'true') { btn.click(); }
        });
        q.dispatchEvent(new Event('input', { bubbles: true }));
        scope.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof window.__ijFindRefreshSearch === 'function') { window.__ijFindRefreshSearch(); }
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

  suiteTeardown(async function () {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    await cfg.update('engine', priorEngineSetting, vscode.ConfigurationTarget.Workspace);
  });

  // Later test suites (e.g. preview highlight) reuse the overlay's scope
  // input across suites — if this suite leaves scope=nested/ set in the
  // DOM, the next suite's multi-line search runs with that scope and
  // returns 0 matches. Clear scope explicitly in teardown so suite order
  // doesn't matter.
  teardown(async function () {
    if (!cdpAvailable) { return; }
    const api = await getApi();
    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var scope = document.querySelector('.ij-find-scope');
        if (!scope) { return 'no-scope'; }
        scope.value = '';
        scope.dispatchEvent(new Event('input', { bubbles: true }));
        return 'cleared';
      })()`,
    );
  });

  test('changing the query via overlay.show updates renderer state to the new query', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();

    // First search — sets rgQuery on the renderer side. Keep the seed
    // query narrow so the test doesn't depend on scanning every common
    // `class` token in the repo and bundled VS Code test install.
    await api.overlay.show('Beta');
    const afterFirst = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'Beta',
      10_000,
      'first search to settle with rgQuery=Beta',
    );
    assert.strictEqual(afterFirst.rgQuery, 'Beta');
    assert.strictEqual(afterFirst.filterQuery, '', 'filterQuery should be empty after a full rg run');

    // Second search — extension of the first. Depending on the exact
    // renderer path, this may stay as a client-side narrowing pass or
    // become a fresh rg run. What must hold is that the renderer lands on
    // the new query and drives search state from it.
    await api.overlay.show('BetaWidget');
    const afterExt = await waitUntil(
      api,
      (s) => s.inputValue === 'BetaWidget' && (s.filterQuery === 'BetaWidget' || s.rgQuery === 'BetaWidget'),
      5_000,
      'extension query to reach input and active search state',
    );
    assert.strictEqual(afterExt.inputValue, 'BetaWidget');
    assert.ok(
      afterExt.filterQuery === 'BetaWidget' || afterExt.rgQuery === 'BetaWidget',
      `new query did not propagate into renderer state: ${JSON.stringify(afterExt)}`,
    );
  });

  test('refresh button is rendered in the toolbar', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    const api = await getApi();
    await api.overlay.show('class');
    const raw = await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var btn = document.querySelector('.ij-find-refresh');
        return JSON.stringify({
          hasButton: !!btn,
          text: btn ? btn.textContent : null,
          hasHelper: typeof window.__ijFindRefreshSearch === 'function',
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as { hasButton: boolean; text: string | null; hasHelper: boolean };
    assert.strictEqual(parsed.hasButton, true, `refresh button missing: ${raw}`);
    assert.strictEqual(parsed.text, 'Run', `unexpected refresh button text: ${raw}`);
    assert.strictEqual(parsed.hasHelper, true, `refresh helper missing: ${raw}`);
  });

  test('typing query waits for Enter and records history', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const api = await getApi();
    const query = 'history_no_auto_' + Date.now();

    await api.overlay.show('Beta');
    await waitUntil(api, (s) => !s.searching && s.rgQuery === 'Beta', 10_000, 'seed search before typing');

    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var q = document.querySelector('.ij-find-query');
        if (!q) { return 'no-query'; }
        q.value = ${JSON.stringify(query)};
        q.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
      })()`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const typed = await probeState(api);
    assert.strictEqual(typed.inputValue, query);
    assert.strictEqual(typed.rgQuery, 'Beta', `typing should not start a new search: ${JSON.stringify(typed)}`);

    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var q = document.querySelector('.ij-find-query');
        if (!q) { return 'no-query'; }
        q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        return 'entered';
      })()`,
    );
    const searched = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === query && !!(s.history && s.history.indexOf(query) >= 0),
      10_000,
      'Enter-triggered search and history update',
    );
    assert.ok(searched.history && searched.history.indexOf(query) >= 0, `history missing query: ${JSON.stringify(searched)}`);

    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var q = document.querySelector('.ij-find-query');
        var h = document.querySelector('.ij-find-history');
        var menu = document.querySelector('.ij-find-history-menu');
        if (!q || !h || !menu) { return 'missing'; }
        q.value = '';
        q.dispatchEvent(new Event('input', { bubbles: true }));
        h.click();
        var items = menu.querySelectorAll('.ij-find-history-item');
        for (var i = 0; i < items.length; i++) {
          if (items[i].title === ${JSON.stringify(query)}) {
            items[i].click();
            return q.value;
          }
        }
        return 'not-found';
      })()`,
    );
    const selected = await probeState(api);
    assert.strictEqual(selected.inputValue, query);
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

  test('scope input is rendered and readable from renderer state', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    const api = await getApi();

    await api.overlay.show('class');
    await waitUntil(api, (s) => s.inputValue === 'class', 10_000, 'seed search for scope test');
    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var scope = document.querySelector('.ij-find-scope');
        if (!scope) { return 'no-scope'; }
        scope.value = 'tests/fixtures/workspace/**/*.py';
        return 'ok';
      })()`,
    );
    const after = await probeState(api);
    assert.strictEqual(after.scopeValue, 'tests/fixtures/workspace/**/*.py');
  });

  test('scope input filters rg results after Run', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const api = await getApi();

    await api.overlay.show('class');
    const baseline = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'class' && s.filesCount > 0,
      10_000,
      'baseline search for class (no scope) to settle',
    );
    assert.ok(baseline.filesCount >= 2, `baseline should hit multiple files, got ${JSON.stringify(baseline)}`);

    // Apply scope by user-typed input. Search should not start until Run.
    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var scope = document.querySelector('.ij-find-scope');
        if (!scope) { return 'no-scope'; }
        scope.value = 'nested/';
        scope.dispatchEvent(new Event('input', { bubbles: true }));
        return 'dispatched';
      })()`,
    );
    const dirty = await probeState(api);
    assert.strictEqual(dirty.scopeValue, 'nested/');
    assert.strictEqual(dirty.rgScope, '', `scope typing should not start a search: ${JSON.stringify(dirty)}`);

    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var btn = document.querySelector('.ij-find-refresh');
        if (!btn) { return 'no-run'; }
        btn.click();
        return 'clicked';
      })()`,
    );
    const scoped = await waitUntil(
      api,
      (s) => !s.searching && s.rgQuery === 'class' && s.scopeValue === 'nested/' && s.rgScope === 'nested/',
      10_000,
      'scope-narrowed search to settle with scope=nested/',
    );
    assert.strictEqual(
      scoped.rgScope,
      'nested/',
      `renderer-side rgScope should have advanced to nested/. got ${JSON.stringify(scoped)}`,
    );
    assert.strictEqual(
      scoped.filesCount,
      1,
      `scoping to nested/ should yield exactly one file (delta.js). got ${JSON.stringify(scoped)}`,
    );
  });
});
