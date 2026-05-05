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

  test('call graph inlay click hook ignores other extension inlay DOM', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var node = document.createElement('span');
        node.className = 'third-party-inline-inlay-hint';
        node.textContent = 'third party hover target';
        node.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647;background:transparent;';
        var received = false;
        node.addEventListener('click', function () { received = true; });
        document.body.appendChild(node);
        var ev = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24
        });
        var dispatchResult = node.dispatchEvent(ev);
        var out = {
          received: received,
          prevented: ev.defaultPrevented || !dispatchResult
        };
        node.remove();
        return JSON.stringify(out);
      })()`,
    );
    const parsed = JSON.parse(raw) as { received: boolean; prevented: boolean };
    assert.strictEqual(parsed.received, true, `third-party inlay click should still bubble to its owner: ${raw}`);
    assert.strictEqual(parsed.prevented, false, `third-party inlay click should not be suppressed: ${raw}`);
  });

  test('call graph inlay click hook resolves plain no-position clicks through visible line', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(async function(){
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        var editor = document.createElement('div');
        editor.className = 'monaco-editor';
        editor.style.cssText = 'position:fixed;left:30px;top:30px;width:160px;height:30px;z-index:2147483647;';
        var lines = document.createElement('div');
        lines.className = 'view-lines';
        var line = document.createElement('div');
        line.className = 'view-line';
        var hint = document.createElement('span');
        hint.className = 'inline-hints-widget';
        hint.textContent = 'usages 2';
        hint.style.cssText = 'display:inline-block;padding:2px;';
        var pointerReceived = false;
        var clickReceived = false;
        hint.addEventListener('pointerdown', function () { pointerReceived = true; });
        hint.addEventListener('click', function () { clickReceived = true; });
        line.appendChild(hint);
        lines.appendChild(line);
        editor.appendChild(lines);
        document.body.appendChild(editor);
        var pointer = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 36,
          clientY: 36
        });
        var pointerDispatch = hint.dispatchEvent(pointer);
        var click = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 36,
          clientY: 36
        });
        var clickDispatch = hint.dispatchEvent(click);
        await new Promise(function (resolve) { setTimeout(resolve, 25); });
        editor.remove();
        globalThis.irSearchEvent = oldBridge;
        return JSON.stringify({
          pointerReceived: pointerReceived,
          clickReceived: clickReceived,
          pointerPrevented: pointer.defaultPrevented || !pointerDispatch,
          clickPrevented: click.defaultPrevented || !clickDispatch,
          sent: sent
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      pointerReceived: boolean;
      clickReceived: boolean;
      pointerPrevented: boolean;
      clickPrevented: boolean;
      sent: Array<{ type?: string; command?: string }>;
    };
    assert.strictEqual(parsed.pointerReceived, false, `plain no-position pointerdown should be handled by visible-line fallback: ${raw}`);
    assert.strictEqual(parsed.clickReceived, false, `duplicate click should be suppressed after visible-line fallback: ${raw}`);
    assert.strictEqual(parsed.pointerPrevented, true, `plain no-position inlay pointerdown should be suppressed after fallback command: ${raw}`);
    assert.strictEqual(parsed.clickPrevented, true, `duplicate click should be suppressed after fallback command: ${raw}`);
    assert.ok(
      !parsed.sent.some((msg) => msg.type === 'runCommand' && msg.command === 'intellijStyledSearch.activateCallGraphInlayAtPosition'),
      `no-position inlay should not run active-cursor fallback command: ${raw}`,
    );
    assert.ok(
      parsed.sent.some((msg) => msg.type === 'runCommand' && msg.command === 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine'),
      `plain no-position inlay should run visible-line command: ${raw}`,
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

  test('option shortcuts use physical key code when Alt changes the typed character', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var query = document.querySelector('.ij-find-query');
        var word = document.querySelector('[data-opt="wholeWord"]');
        if (word && word.getAttribute('aria-pressed') === 'true') { word.click(); }
        if (query && query.focus) { query.focus(); }
        var ev = new KeyboardEvent('keydown', {
          key: '∑',
          code: 'KeyW',
          altKey: true,
          bubbles: true,
          cancelable: true
        });
        var dispatched = query ? query.dispatchEvent(ev) : false;
        return JSON.stringify({
          dispatched: dispatched,
          prevented: ev.defaultPrevented,
          wordPressed: word ? word.getAttribute('aria-pressed') : null,
          state: window.__ijFindGetSearchState()
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      dispatched: boolean;
      prevented: boolean;
      wordPressed: string | null;
      state: { options?: { wholeWord: boolean } };
    };
    assert.strictEqual(parsed.dispatched, false, `Alt+W should be consumed by the option shortcut: ${raw}`);
    assert.strictEqual(parsed.prevented, true, `Alt+W should prevent the typed Option-W character: ${raw}`);
    assert.strictEqual(parsed.wordPressed, 'true', `whole-word button should be pressed after Alt+W: ${raw}`);
    assert.strictEqual(parsed.state.options?.wholeWord, true, `renderer state should enable whole-word: ${raw}`);
  });

  test('option buttons restart search immediately with updated options', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('');
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var q = document.querySelector('.ij-find-query');
        var word = document.querySelector('[data-opt="wholeWord"]');
        var caseSensitive = document.querySelector('[data-opt="caseSensitive"]');
        if (!q || !word || !caseSensitive) { return JSON.stringify({ err: 'missing controls' }); }
        q.value = '';
        if (word.getAttribute('aria-pressed') === 'true') { word.click(); }
        if (caseSensitive.getAttribute('aria-pressed') === 'true') { caseSensitive.click(); }
        q.value = 'Beta';
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        word.click();
        caseSensitive.click();
        globalThis.irSearchEvent = oldBridge;
        return JSON.stringify({
          wordPressed: word.getAttribute('aria-pressed'),
          caseSensitivePressed: caseSensitive.getAttribute('aria-pressed'),
          caseSensitiveText: caseSensitive.textContent,
          caseSensitiveTitle: caseSensitive.getAttribute('title'),
          sent: sent,
          state: window.__ijFindGetSearchState()
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      wordPressed?: string;
      caseSensitivePressed?: string;
      caseSensitiveText?: string;
      caseSensitiveTitle?: string | null;
      sent?: Array<{ type?: string; options?: { query?: string; wholeWord?: boolean; caseSensitive?: boolean } }>;
      state?: { options?: { wholeWord: boolean; caseSensitive: boolean } };
    };
    assert.strictEqual(parsed.err, undefined, `expected search option controls: ${raw}`);
    assert.strictEqual(parsed.wordPressed, 'true', `whole-word button should stay pressed: ${raw}`);
    assert.strictEqual(parsed.caseSensitiveText, 'aA', `case-sensitive button should use its own icon text: ${raw}`);
    assert.match(parsed.caseSensitiveTitle || '', /Case Sensitive/, `case-sensitive button should be labelled as Case Sensitive: ${raw}`);
    assert.ok(
      parsed.sent?.some((msg) => msg.type === 'search' &&
        msg.options?.query === 'Beta' &&
        msg.options.wholeWord === true &&
        msg.options.caseSensitive === false),
      `whole-word click should emit a fresh ignore-case search with updated options: ${raw}`,
    );
    assert.strictEqual(parsed.caseSensitivePressed, 'true', `case-sensitive button should toggle on after click: ${raw}`);
    assert.ok(
      parsed.sent?.some((msg) => msg.type === 'search' &&
        msg.options?.query === 'Beta' &&
        msg.options.wholeWord === true &&
        msg.options.caseSensitive === true),
      `case-sensitive click should emit a fresh case-sensitive search with updated options: ${raw}`,
    );
    assert.strictEqual(parsed.state?.options?.wholeWord, true, `renderer state should enable whole-word: ${raw}`);
    assert.strictEqual(parsed.state?.options?.caseSensitive, true, `case-sensitive on should set caseSensitive=true: ${raw}`);
  });

  test('spawned show opens an independent live panel without degrading existing panels', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('AlphaLive', { forceLiteral: true, suppressSearch: true });
    await overlay.evalInActiveWindowForTests(
      `(function(){
        window.__ijFindOnMessage({
          type: 'preview',
          uri: 'file:///independent-preview-alpha.ts',
          relPath: 'independent-preview-alpha.ts',
          languageId: 'typescript',
          focusLine: 1,
          fullFile: true,
          lines: [
            { lineNumber: 0, text: 'function independentPreviewAlpha() {' },
            { lineNumber: 1, text: '  return "visible selectable code";' },
            { lineNumber: 2, text: '}' }
          ],
          ranges: [{ start: 9, end: 35 }]
        });
        return 'ok';
      })()`,
    );
    await overlay.show('BetaLive', { forceLiteral: true, suppressSearch: true, spawn: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        function infoFor(root) {
          var query = root.querySelector('.ij-find-query');
          var preview = root.querySelector('.ij-find-preview-body');
          var rect = root.getBoundingClientRect();
          return {
            src: root.getAttribute('data-ij-find-src') || '',
            query: query ? query.value : '',
            queryReadOnly: query ? !!query.readOnly : null,
            detached: root.classList.contains('ij-find-detached'),
            opacity: getComputedStyle(root).opacity,
            z: parseInt(getComputedStyle(root).zIndex || '0', 10),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            previewText: preview ? preview.textContent : '',
            previewSnapshot: preview ? preview.classList.contains('ij-find-detached-preview-snapshot') : false,
            previewMonacoCount: preview ? preview.querySelectorAll('.monaco-editor').length : -1
          };
        }
        var roots = Array.from(document.querySelectorAll('.ij-find-overlay.visible'));
        var infos = roots.map(infoFor);
        var alphaRoot = roots.find(function (root) {
          var q = root.querySelector('.ij-find-query');
          return q && q.value === 'AlphaLive';
        });
        var betaRoot = roots.find(function (root) {
          var q = root.querySelector('.ij-find-query');
          return q && q.value === 'BetaLive';
        });
        function ensureOverflowInfo(root) {
          var src = root && root.getAttribute('data-ij-find-src') || '';
          var inst = src && window.__ijFindInstances && window.__ijFindInstances[src];
          var host = inst && inst.getPreviewOverflowHostForTests ? inst.getPreviewOverflowHostForTests() : null;
          var overflowRoot = host && host.closest ? host.closest('.ij-find-preview-overflow-root') : null;
          return {
            src: src,
            hostSrc: host && host.getAttribute ? host.getAttribute('data-ij-find-src') || '' : '',
            rootSrc: overflowRoot && overflowRoot.getAttribute ? overflowRoot.getAttribute('data-ij-find-src') || '' : '',
            rootInBody: !!(overflowRoot && overflowRoot.parentElement === document.body),
            rootZ: overflowRoot ? parseInt(getComputedStyle(overflowRoot).zIndex || '0', 10) : 0,
            rootPointerEvents: overflowRoot ? getComputedStyle(overflowRoot).pointerEvents : '',
            hostPointerEvents: host ? getComputedStyle(host).pointerEvents : ''
          };
        }
        var alphaOverflowBeforeFocus = ensureOverflowInfo(alphaRoot);
        var betaOverflowBeforeFocus = ensureOverflowInfo(betaRoot);
        var alphaBeforeFocusZ = alphaRoot ? parseInt(getComputedStyle(alphaRoot).zIndex || '0', 10) : 0;
        var betaBeforeFocusZ = betaRoot ? parseInt(getComputedStyle(betaRoot).zIndex || '0', 10) : 0;
        if (alphaRoot) {
          alphaRoot.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
        }
        var alphaAfterFocusZ = alphaRoot ? parseInt(getComputedStyle(alphaRoot).zIndex || '0', 10) : 0;
        var betaAfterFocusZ = betaRoot ? parseInt(getComputedStyle(betaRoot).zIndex || '0', 10) : 0;
        var alphaOverflowAfterFocus = ensureOverflowInfo(alphaRoot);
        var betaOverflowAfterFocus = ensureOverflowInfo(betaRoot);
        var visibleBeforeClose = document.querySelectorAll('.ij-find-overlay.visible').length;
        var alphaClose = alphaRoot && alphaRoot.querySelector('.ij-find-close');
        if (alphaClose) {
          alphaClose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        var visibleAfterAlphaClose = document.querySelectorAll('.ij-find-overlay.visible').length;
        var betaStillVisible = !!(betaRoot && betaRoot.classList.contains('visible'));
        var overflowAfterAlphaClose = Array.from(document.querySelectorAll('.ij-find-preview-overflow-root')).map(function (node) {
          return node.getAttribute('data-ij-find-src') || '';
        });
        var betaClose = betaRoot && betaRoot.querySelector('.ij-find-close');
        if (betaClose) {
          betaClose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        var overflowAfterAllClose = Array.from(document.querySelectorAll('.ij-find-preview-overflow-root')).map(function (node) {
          return node.getAttribute('data-ij-find-src') || '';
        });
        return JSON.stringify({
          instanceCount: window.__ijFindInstances ? Object.keys(window.__ijFindInstances).length : 0,
          infos: infos,
          alphaOverflowBeforeFocus: alphaOverflowBeforeFocus,
          betaOverflowBeforeFocus: betaOverflowBeforeFocus,
          alphaBeforeFocusZ: alphaBeforeFocusZ,
          betaBeforeFocusZ: betaBeforeFocusZ,
          alphaAfterFocusZ: alphaAfterFocusZ,
          betaAfterFocusZ: betaAfterFocusZ,
          alphaOverflowAfterFocus: alphaOverflowAfterFocus,
          betaOverflowAfterFocus: betaOverflowAfterFocus,
          visibleBeforeClose: visibleBeforeClose,
          visibleAfterAlphaClose: visibleAfterAlphaClose,
          betaStillVisible: betaStillVisible,
          overflowAfterAlphaClose: overflowAfterAlphaClose,
          overflowAfterAllClose: overflowAfterAllClose,
          finalVisible: document.querySelectorAll('.ij-find-overlay.visible').length
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      instanceCount: number;
      infos: Array<{
        src: string;
        query: string;
        queryReadOnly: boolean | null;
        detached: boolean;
        opacity: string;
        z: number;
        left: number;
        top: number;
        previewText: string;
        previewSnapshot: boolean;
        previewMonacoCount: number;
      }>;
      alphaBeforeFocusZ: number;
      betaBeforeFocusZ: number;
      alphaAfterFocusZ: number;
      betaAfterFocusZ: number;
      alphaOverflowBeforeFocus: {
        src: string;
        hostSrc: string;
        rootSrc: string;
        rootInBody: boolean;
        rootZ: number;
        rootPointerEvents: string;
        hostPointerEvents: string;
      };
      betaOverflowBeforeFocus: {
        src: string;
        hostSrc: string;
        rootSrc: string;
        rootInBody: boolean;
        rootZ: number;
        rootPointerEvents: string;
        hostPointerEvents: string;
      };
      alphaOverflowAfterFocus: { rootZ: number };
      betaOverflowAfterFocus: { rootZ: number };
      visibleBeforeClose: number;
      visibleAfterAlphaClose: number;
      betaStillVisible: boolean;
      overflowAfterAlphaClose: string[];
      overflowAfterAllClose: string[];
      finalVisible: number;
    };
    const alpha = parsed.infos.find((info) => info.query === 'AlphaLive');
    const beta = parsed.infos.find((info) => info.query === 'BetaLive');
    assert.strictEqual(parsed.visibleBeforeClose, 2, `spawn should keep the existing panel and open another visible panel: ${raw}`);
    assert.ok(parsed.instanceCount >= 2, `renderer should register independent panel instances: ${raw}`);
    assert.ok(alpha, `expected original Alpha panel to remain visible: ${raw}`);
    assert.ok(beta, `expected spawned Beta panel to be visible: ${raw}`);
    assert.notStrictEqual(alpha?.src, beta?.src, `panels should have distinct renderer sources: ${raw}`);
    assert.strictEqual(alpha?.detached, false, `original panel should not be converted into a detached clone: ${raw}`);
    assert.strictEqual(beta?.detached, false, `spawned panel should be a live panel, not a detached clone: ${raw}`);
    assert.strictEqual(alpha?.queryReadOnly, false, `original query should remain editable: ${raw}`);
    assert.strictEqual(beta?.queryReadOnly, false, `spawned query should remain editable: ${raw}`);
    assert.strictEqual(alpha?.opacity, '1', `original panel should not become translucent: ${raw}`);
    assert.strictEqual(beta?.opacity, '1', `spawned panel should not become translucent: ${raw}`);
    assert.strictEqual(alpha?.previewSnapshot, false, `original preview should not be degraded into a snapshot: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.src, alpha?.src, `original overflow host should be owned by original panel: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.src, beta?.src, `spawned overflow host should be owned by spawned panel: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.rootSrc, alpha?.src, `original overflow root should carry original src: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.rootSrc, beta?.src, `spawned overflow root should carry spawned src: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.hostSrc, alpha?.src, `original overflow host should carry original src: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.hostSrc, beta?.src, `spawned overflow host should carry spawned src: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.rootInBody, true, `original overflow root should be body-level: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.rootInBody, true, `spawned overflow root should be body-level: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.rootPointerEvents, 'none', `overflow root should not steal panel focus: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.rootPointerEvents, 'none', `spawned overflow root should not steal panel focus: ${raw}`);
    assert.strictEqual(parsed.alphaOverflowBeforeFocus.hostPointerEvents, 'none', `overflow host should not steal panel focus: ${raw}`);
    assert.strictEqual(parsed.betaOverflowBeforeFocus.hostPointerEvents, 'none', `spawned overflow host should not steal panel focus: ${raw}`);
    assert.ok(
      Math.abs((beta?.left ?? 0) - (alpha?.left ?? 0)) >= 24 ||
        Math.abs((beta?.top ?? 0) - (alpha?.top ?? 0)) >= 24,
      `spawned panel should be visibly offset from the existing panel: ${raw}`,
    );
    assert.ok(parsed.betaBeforeFocusZ > parsed.alphaBeforeFocusZ, `spawned panel should be topmost initially: ${raw}`);
    assert.ok(parsed.alphaAfterFocusZ > parsed.betaAfterFocusZ, `clicking original panel should bring it to front: ${raw}`);
    assert.ok(parsed.alphaOverflowAfterFocus.rootZ > parsed.betaOverflowAfterFocus.rootZ, `focused panel should raise its own overflow root: ${raw}`);
    assert.strictEqual(parsed.visibleAfterAlphaClose, 1, `closing original panel should not close the spawned panel: ${raw}`);
    assert.strictEqual(parsed.betaStillVisible, true, `spawned panel should remain visible after original closes: ${raw}`);
    assert.ok(!parsed.overflowAfterAlphaClose.includes(alpha?.src ?? ''), `closing original should remove only original overflow root: ${raw}`);
    assert.ok(parsed.overflowAfterAlphaClose.includes(beta?.src ?? ''), `spawned overflow root should remain after original closes: ${raw}`);
    assert.ok(!parsed.overflowAfterAllClose.includes(beta?.src ?? ''), `closing spawned panel should remove spawned overflow root: ${raw}`);
    assert.strictEqual(parsed.finalVisible, 0, `each live panel should close independently: ${raw}`);
  });

  test('minimize button compacts and restores one live panel independently', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('MinimizeAlpha', { forceLiteral: true, suppressSearch: true });
    await overlay.show('MinimizeBeta', { forceLiteral: true, suppressSearch: true, spawn: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        function rootFor(queryText) {
          return Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (root) {
            var q = root.querySelector('.ij-find-query');
            return q && q.value === queryText;
          });
        }
        function snap(root) {
          var rect = root ? root.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
          var toolbar = root && root.querySelector('.ij-find-toolbar');
          var results = root && root.querySelector('.ij-find-results');
          var preview = root && root.querySelector('.ij-find-preview');
          var resizer = root && root.querySelector('.ij-find-resizer');
          var button = root && root.querySelector('.ij-find-minimize');
          return {
            exists: !!root,
            minimized: !!(root && root.classList.contains('ij-find-minimized')),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
            resultsDisplay: results ? getComputedStyle(results).display : '',
            previewDisplay: preview ? getComputedStyle(preview).display : '',
            resizerDisplay: resizer ? getComputedStyle(resizer).display : '',
            buttonPressed: button ? button.getAttribute('aria-pressed') : '',
            buttonText: button ? button.textContent : '',
            buttonTitle: button ? button.getAttribute('title') : ''
          };
        }
        var alphaRoot = rootFor('MinimizeAlpha');
        var betaRoot = rootFor('MinimizeBeta');
        var beforeAlpha = snap(alphaRoot);
        var beforeBeta = snap(betaRoot);
        var betaMinimize = betaRoot && betaRoot.querySelector('.ij-find-minimize');
        if (betaMinimize) {
          betaMinimize.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        var minimizedAlpha = snap(alphaRoot);
        var minimizedBeta = snap(betaRoot);
        if (betaMinimize) {
          betaMinimize.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        var restoredAlpha = snap(alphaRoot);
        var restoredBeta = snap(betaRoot);
        var alphaClose = alphaRoot && alphaRoot.querySelector('.ij-find-close');
        var betaClose = betaRoot && betaRoot.querySelector('.ij-find-close');
        if (alphaClose) { alphaClose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        if (betaClose) { betaClose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        return JSON.stringify({
          beforeAlpha: beforeAlpha,
          beforeBeta: beforeBeta,
          minimizedAlpha: minimizedAlpha,
          minimizedBeta: minimizedBeta,
          restoredAlpha: restoredAlpha,
          restoredBeta: restoredBeta,
          finalVisible: document.querySelectorAll('.ij-find-overlay.visible').length
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      beforeAlpha: { exists: boolean; minimized: boolean; width: number; height: number };
      beforeBeta: { exists: boolean; minimized: boolean; width: number; height: number };
      minimizedAlpha: { minimized: boolean; width: number; height: number; toolbarDisplay: string; previewDisplay: string };
      minimizedBeta: {
        minimized: boolean;
        width: number;
        height: number;
        toolbarDisplay: string;
        resultsDisplay: string;
        previewDisplay: string;
        resizerDisplay: string;
        buttonPressed: string;
        buttonTitle: string;
      };
      restoredAlpha: { minimized: boolean; width: number; height: number };
      restoredBeta: {
        minimized: boolean;
        width: number;
        height: number;
        toolbarDisplay: string;
        previewDisplay: string;
        buttonPressed: string;
        buttonTitle: string;
      };
      finalVisible: number;
    };
    assert.strictEqual(parsed.beforeAlpha.exists, true, `expected first panel before minimizing: ${raw}`);
    assert.strictEqual(parsed.beforeBeta.exists, true, `expected second panel before minimizing: ${raw}`);
    assert.strictEqual(parsed.beforeAlpha.minimized, false, `first panel should start restored: ${raw}`);
    assert.strictEqual(parsed.beforeBeta.minimized, false, `second panel should start restored: ${raw}`);
    assert.strictEqual(parsed.minimizedAlpha.minimized, false, `minimizing second panel should not minimize first: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.minimized, true, `second panel should enter minimized state: ${raw}`);
    assert.ok(parsed.minimizedBeta.width <= 330, `minimized panel should shrink horizontally: ${raw}`);
    assert.ok(parsed.minimizedBeta.height <= 34, `minimized panel should shrink vertically: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.toolbarDisplay, 'none', `minimized panel toolbar should be hidden: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.resultsDisplay, 'none', `minimized panel results should be hidden: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.previewDisplay, 'none', `minimized panel preview should be hidden: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.resizerDisplay, 'none', `minimized panel resizer should be hidden: ${raw}`);
    assert.strictEqual(parsed.minimizedBeta.buttonPressed, 'true', `minimize button should expose pressed state: ${raw}`);
    assert.match(parsed.minimizedBeta.buttonTitle, /Restore/, `minimize button should become restore toggle: ${raw}`);
    assert.strictEqual(parsed.restoredBeta.minimized, false, `second panel should restore from minimized state: ${raw}`);
    assert.ok(parsed.restoredBeta.width >= parsed.beforeBeta.width - 4, `restored panel width should return: ${raw}`);
    assert.ok(parsed.restoredBeta.height >= parsed.beforeBeta.height - 4, `restored panel height should return: ${raw}`);
    assert.notStrictEqual(parsed.restoredBeta.toolbarDisplay, 'none', `restored panel toolbar should be visible: ${raw}`);
    assert.notStrictEqual(parsed.restoredBeta.previewDisplay, 'none', `restored panel preview should be visible: ${raw}`);
    assert.strictEqual(parsed.restoredBeta.buttonPressed, 'false', `restore should clear pressed state: ${raw}`);
    assert.match(parsed.restoredBeta.buttonTitle, /Minimize/, `restore toggle should return to minimize title: ${raw}`);
    assert.strictEqual(parsed.restoredAlpha.minimized, false, `first panel should remain restored: ${raw}`);
    assert.strictEqual(parsed.finalVisible, 0, `test should close both panels: ${raw}`);
  });

  test('call graph inlay hook still works inside the preview editor', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewInlayHost', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var body = document.querySelector('.ij-find-overlay.visible:not(.ij-find-detached) .ij-find-preview-body');
        if (!body) { return JSON.stringify({ err: 'missing preview body' }); }
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        var editor = document.createElement('div');
        editor.className = 'monaco-editor';
        editor.style.cssText = 'position:absolute;left:16px;top:16px;width:240px;height:40px;z-index:2;';
        var nativeEdit = document.createElement('div');
        nativeEdit.className = 'native-edit-context';
        nativeEdit.tabIndex = 0;
        editor.appendChild(nativeEdit);
        var lines = document.createElement('div');
        lines.className = 'view-lines';
        var line = document.createElement('div');
        line.className = 'view-line';
        line.style.cssText = 'height:20px;';
        var hint = document.createElement('span');
        hint.className = 'inline-hints-widget ijss-callgraph';
        hint.textContent = 'usages 2';
        hint.style.cssText = 'display:inline-block;padding:2px 4px;';
        line.appendChild(hint);
        lines.appendChild(line);
        editor.appendChild(lines);
        body.appendChild(editor);
        nativeEdit.focus();
        var spawnSelection = window.__ijFindShouldSpawnSearchSelection ? window.__ijFindShouldSpawnSearchSelection() : '';
        var rect = hint.getBoundingClientRect();
        var ev = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: rect.left + 2,
          clientY: rect.top + 2
        });
        var dispatchResult = hint.dispatchEvent(ev);
        globalThis.irSearchEvent = oldBridge;
        editor.remove();
        return JSON.stringify({
          spawnSelection: spawnSelection,
          prevented: ev.defaultPrevented || !dispatchResult,
          sent: sent
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      prevented?: boolean;
      spawnSelection?: string;
      sent?: Array<{ type?: string; command?: string; args?: unknown[] }>;
    };
    assert.strictEqual(parsed.err, undefined, `expected preview body: ${raw}`);
    assert.strictEqual(parsed.spawnSelection, 'preview', `preview editor focus should request a spawned searchSelection panel: ${raw}`);
    assert.strictEqual(parsed.prevented, true, `preview inlay click should be consumed by the call graph hook: ${raw}`);
    assert.ok(
      parsed.sent?.some((msg) =>
        msg.type === 'runCommand' &&
        msg.command === 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine'),
      `preview inlay click should dispatch the call graph command: ${raw}`,
    );
  });

  test('suppressed initial search keeps the full panel layout mounted', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('DirectWorkspaceFileOptions', {
      forceLiteral: true,
      suppressSearch: true,
      statusText: 'Loading call graph results...',
      loading: true,
    });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var panel = document.querySelector('.ij-find-overlay');
        return JSON.stringify({
          shell: !!(panel && panel.classList.contains('ij-find-shell')),
          results: !!document.querySelector('.ij-find-overlay > .ij-find-results'),
          splitter: !!document.querySelector('.ij-find-overlay > .ij-find-splitter'),
          preview: !!document.querySelector('.ij-find-overlay > .ij-find-preview'),
          resizer: !!document.querySelector('.ij-find-overlay > .ij-find-resizer'),
          statusText: document.querySelector('.ij-find-status') ? document.querySelector('.ij-find-status').textContent : '',
          spinnerHidden: document.querySelector('.ij-find-spinner') ? document.querySelector('.ij-find-spinner').classList.contains('hidden') : true
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      shell: boolean;
      results: boolean;
      splitter: boolean;
      preview: boolean;
      resizer: boolean;
      statusText: string;
      spinnerHidden: boolean;
    };
    assert.strictEqual(parsed.shell, false, `suppressed show should not shrink to shell mode: ${raw}`);
    assert.strictEqual(parsed.results, true, `results pane should remain mounted: ${raw}`);
    assert.strictEqual(parsed.splitter, true, `splitter should remain mounted: ${raw}`);
    assert.strictEqual(parsed.preview, true, `preview pane should remain mounted: ${raw}`);
    assert.strictEqual(parsed.resizer, true, `resizer should remain mounted: ${raw}`);
    assert.strictEqual(parsed.statusText, 'Loading call graph results...', `custom loading status should render: ${raw}`);
    assert.strictEqual(parsed.spinnerHidden, false, `loading spinner should render: ${raw}`);
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
