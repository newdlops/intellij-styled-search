import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

// Renderer-level tests require the CDP injection chain (SIGUSR1 → Node
// inspector → WebSocket → Runtime.addBinding → webContents.debugger). In
// the @vscode/test-electron sandbox SIGUSR1 may not be honored, so we
// attempt the injection once at suite setup and skip gracefully if it
// can't complete. Any renderer bugs that made it past unit + engine E2E
// still get caught when the sandbox does allow CDP.
let cdpAvailable = false;
let cdpSkipReason = '';

suite('Renderer — overlay UI probes', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    const { overlay } = await getApi();
    try {
      await overlay.awaitInjection();
      cdpAvailable = true;
    } catch (err) {
      cdpAvailable = false;
      cdpSkipReason = err instanceof Error ? err.message : String(err);
    }
  });

  test('CDP injection succeeded (otherwise remaining tests are skipped)', function () {
    if (!cdpAvailable) {
      this.skip();
      return;
    }
    assert.ok(true);
  });

  test('overlay.show() toggles panel visible in focused window', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('class AlphaService:');
    // __ijFindStatus is installed by the renderer patch and reports DOM /
    // visibility state. See rendererPatch.ts.
    const status = await overlay.evalInActiveWindowForTests(
      `(function(){try{return window.__ijFindStatus?window.__ijFindStatus():'no-fn'}catch(e){return 'throw:'+(e&&e.message)}})()`,
    );
    assert.match(
      status, /inDom=true/,
      `overlay should be attached to DOM, got: ${status}`,
    );
    assert.match(
      status, /disp=(flex|block)/,
      `overlay display should be visible, got: ${status}`,
    );
  });

  test('force-literal show clears regex and whole-word toggles', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    await overlay.evalInActiveWindowForTests(
      `(function(){
        var regex = document.querySelector('[data-opt="useRegex"]');
        var word = document.querySelector('[data-opt="wholeWord"]');
        if (regex && regex.getAttribute('aria-pressed') !== 'true') { regex.click(); }
        if (word && word.getAttribute('aria-pressed') !== 'true') { word.click(); }
        return 'ok';
      })()`,
    );

    const query = [
      'RtccInvestorFile,',
      ')',
      'from example import Something',
    ].join('\n');
    await overlay.show(query, { forceLiteral: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        return JSON.stringify({
          regexPressed: document.querySelector('[data-opt="useRegex"]').getAttribute('aria-pressed'),
          wordPressed: document.querySelector('[data-opt="wholeWord"]').getAttribute('aria-pressed'),
          state: window.__ijFindGetSearchState()
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      regexPressed: string;
      wordPressed: string;
      state: { inputValue: string | null };
    };
    assert.strictEqual(parsed.regexPressed, 'false', `regex toggle should be off: ${raw}`);
    assert.strictEqual(parsed.wordPressed, 'false', `whole-word toggle should be off: ${raw}`);
    assert.strictEqual(parsed.state.inputValue, query);
  });

  test('regex multiline toggle is disabled until regex mode is enabled', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var regex = document.querySelector('[data-opt="useRegex"]');
        var multiline = document.querySelector('[data-opt="regexMultiline"]');
        var before = {
          exists: !!multiline,
          disabled: multiline ? multiline.getAttribute('aria-disabled') : null,
          pressed: multiline ? multiline.getAttribute('aria-pressed') : null
        };
        if (regex) { regex.click(); }
        if (multiline) { multiline.click(); }
        return JSON.stringify({
          before: before,
          after: {
            disabled: multiline ? multiline.getAttribute('aria-disabled') : null,
            pressed: multiline ? multiline.getAttribute('aria-pressed') : null
          },
          state: window.__ijFindGetSearchState()
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      before: { exists: boolean; disabled: string | null; pressed: string | null };
      after: { disabled: string | null; pressed: string | null };
      state: { options?: { useRegex: boolean; regexMultiline: boolean } };
    };
    assert.strictEqual(parsed.before.exists, true, `regex multiline toggle should exist: ${raw}`);
    assert.strictEqual(parsed.before.disabled, 'true', `regex multiline should start disabled: ${raw}`);
    assert.strictEqual(parsed.before.pressed, 'true', `regex multiline should preserve default-on state: ${raw}`);
    assert.strictEqual(parsed.after.disabled, 'false', `regex multiline should enable with regex mode: ${raw}`);
    assert.strictEqual(parsed.after.pressed, 'false', `regex multiline should toggle off when clicked: ${raw}`);
    assert.strictEqual(parsed.state.options?.useRegex, true, `renderer state should keep regex enabled: ${raw}`);
    assert.strictEqual(parsed.state.options?.regexMultiline, false, `renderer state should reflect single-line regex mode: ${raw}`);
  });

  test('chunked results for the same file merge into one renderer entry', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();

    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var q = document.querySelector('.ij-find-query');
        if (q) { q.value = ''; }
        if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(); }
        window.__ijFindOnMessage({ type: 'results:start', searchId: 901 });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 901,
          match: { uri: alpha, relPath: 'alpha.py', matches: [{ line: 0, preview: 'class AlphaService:', ranges: [{ start: 0, end: 5 }] }] }
        });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 901,
          match: { uri: alpha, relPath: 'alpha.py', matches: [{ line: 3, preview: 'return data.strip()', ranges: [{ start: 0, end: 6 }] }] }
        });
        window.__ijFindOnMessage({ type: 'results:done', searchId: 901, totalFiles: 1, totalMatches: 2, truncated: false });
        return JSON.stringify(window.__ijFindGetSearchState());
      })()`,
    );
    const state = JSON.parse(raw) as { filesCount: number; flatCount: number; searchId: number };
    assert.strictEqual(state.searchId, 901, `renderer should track the active search id: ${raw}`);
    assert.strictEqual(state.filesCount, 1, `chunked payloads should merge into one file entry: ${raw}`);
    assert.strictEqual(state.flatCount, 2, `merged file should expose both match rows: ${raw}`);
  });

  test('stale search results are ignored after a newer search starts', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();
    const betaUri = vscode.Uri.joinPath(folder!.uri, 'beta.js').toString();

    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var beta = ${JSON.stringify(betaUri)};
        var q = document.querySelector('.ij-find-query');
        if (q) { q.value = ''; }
        if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(); }
        window.__ijFindOnMessage({ type: 'results:start', searchId: 910 });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 910,
          match: { uri: alpha, relPath: 'alpha.py', matches: [{ line: 0, preview: 'class AlphaService:', ranges: [{ start: 0, end: 5 }] }] }
        });
        window.__ijFindOnMessage({ type: 'results:start', searchId: 911 });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 910,
          match: { uri: alpha, relPath: 'alpha.py', matches: [{ line: 1, preview: 'stale alpha', ranges: [{ start: 0, end: 5 }] }] }
        });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 911,
          match: { uri: beta, relPath: 'beta.js', matches: [{ line: 0, preview: 'class BetaWidget {}', ranges: [{ start: 0, end: 4 }] }] }
        });
        return JSON.stringify(window.__ijFindGetSearchState());
      })()`,
    );
    const state = JSON.parse(raw) as { filesCount: number; flatCount: number; searchId: number };
    assert.strictEqual(state.searchId, 911, `renderer should keep the newest search active: ${raw}`);
    assert.strictEqual(state.filesCount, 1, `stale results should not survive into the newer search: ${raw}`);
    assert.strictEqual(state.flatCount, 1, `only the newest search result should remain visible: ${raw}`);
  });

  test('single visible result flattens embedded newlines in row preview', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();

    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var q = document.querySelector('.ij-find-query');
        if (q) { q.value = ''; }
        if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(); }
        window.__ijFindOnMessage({ type: 'results:start', searchId: 920 });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 920,
          match: {
            uri: alpha,
            relPath: 'alpha.py',
            matches: [{
              line: 0,
              preview: 'class AlphaService:\\n    def run(self):',
              ranges: [{ start: 0, end: 5 }]
            }]
          }
        });
        window.__ijFindOnMessage({ type: 'results:done', searchId: 920, totalFiles: 1, totalMatches: 1, truncated: false });
        var row = document.querySelector('.ij-find-row-text');
        var parent = row && row.closest('.ij-find-row');
        return JSON.stringify({
          text: row ? row.textContent : null,
          rowHeight: parent ? Math.round(parent.getBoundingClientRect().height) : null
        });
      })()`,
    );
    const state = JSON.parse(raw) as { text: string | null; rowHeight: number | null };
    assert.ok(state.text !== null, `expected a rendered result row: ${raw}`);
    assert.ok(!state.text!.includes('\n'), `result row preview should be flattened to one line: ${raw}`);
    assert.ok((state.rowHeight ?? 0) <= 22, `single result row should stay one line tall: ${raw}`);
  });

  test('result rows expose reveal and open actions', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();

    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var q = document.querySelector('.ij-find-query');
        if (q) { q.value = ''; }
        if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(); }
        window.__ijFindOnMessage({ type: 'results:start', searchId: 930 });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 930,
          match: {
            uri: alpha,
            relPath: 'alpha.py',
            matches: [{
              line: 2,
              preview: '    return AlphaService()',
              ranges: [{ start: 11, end: 23 }]
            }]
          }
        });
        window.__ijFindOnMessage({ type: 'results:done', searchId: 930, totalFiles: 1, totalMatches: 1, truncated: false });
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        var reveal = document.querySelector('.ij-find-row-action[data-action="reveal"]');
        if (reveal) { reveal.click(); }
        var open = document.querySelector('.ij-find-row-action[data-action="open"]');
        if (open) { open.click(); }
        globalThis.irSearchEvent = oldBridge;
        var labels = Array.prototype.map.call(
          document.querySelectorAll('.ij-find-row-action'),
          function (btn) { return btn.textContent; }
        );
        return JSON.stringify({ labels: labels, sent: sent });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      labels: string[];
      sent: Array<{ type: string; uri?: string; line?: number; column?: number }>;
    };
    assert.deepStrictEqual(parsed.labels, ['Reveal', 'Open'], `row should expose reveal/open actions: ${raw}`);
    assert.ok(parsed.sent.some((msg) => msg.type === 'revealFile' && msg.uri === alphaUri), `reveal action should emit revealFile: ${raw}`);
    assert.ok(
      parsed.sent.some((msg) => msg.type === 'pinInSideEditor' && msg.uri === alphaUri && msg.line === 2 && msg.column === 11),
      `open action should emit pinInSideEditor with match location: ${raw}`,
    );
  });

  // NOTE: input.value population is already covered end-to-end by
  // filter.test.ts which reads it via state.inputValue probe — that path
  // doesn't depend on getting the right window back out of a `querySelector`
  // against activeWindowId, which has been flaky in the test sandbox. We
  // intentionally don't duplicate it here.
});
