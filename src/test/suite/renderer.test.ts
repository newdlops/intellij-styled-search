import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function tabInputKey(input: unknown): string {
  const value = input as {
    uri?: vscode.Uri;
    modified?: vscode.Uri;
    original?: vscode.Uri;
  } | undefined;
  if (value?.uri) { return `uri:${value.uri.toString()}`; }
  if (value?.modified || value?.original) {
    return `diff:${value.modified?.toString() ?? ''}:${value.original?.toString() ?? ''}`;
  }
  return `input:${Object.prototype.toString.call(input)}`;
}

function snapshotTabCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const key = tabInputKey(tab.input);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function snapshotTabGroupCount(): number {
  return vscode.window.tabGroups.all.length;
}

function addedTabKeys(before: Map<string, number>, after: Map<string, number>): string[] {
  const added: string[] = [];
  for (const [key, count] of after) {
    const previous = before.get(key) ?? 0;
    for (let i = previous; i < count; i++) {
      added.push(key);
    }
  }
  return added.sort();
}

function visibleEditorUris(): string[] {
  return vscode.window.visibleTextEditors
    .map((editor) => editor.document.uri.toString())
    .sort();
}

function visibleNonMemoryEditorUris(): string[] {
  return vscode.window.visibleTextEditors
    .map((editor) => editor.document.uri.toString())
    .filter((uri) => !uri.startsWith('inmemory:'))
    .sort();
}

async function probeRendererSearchState(overlay: ExtensionTestApi['overlay']): Promise<any> {
  const raw = await overlay.evalInActiveWindowForTests(
    `(function(){try{return JSON.stringify(window.__ijFindGetSearchState())}catch(e){return JSON.stringify({err:String(e&&e.message)})}})()`,
  );
  return JSON.parse(raw);
}

function assertNoAddedTabs(before: Map<string, number>, label: string): void {
  const after = snapshotTabCounts();
  const added = addedTabKeys(before, after);
  assert.deepStrictEqual(added, [], `${label} should not open additional editor tabs; added=${JSON.stringify(added)}`);
}

async function closeTabsByUri(uri: vscode.Uri): Promise<void> {
  const uriStr = uri.toString();
  const tabs: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri?.toString() === uriStr) {
        tabs.push(tab);
      }
    }
  }
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

async function useCallGraphBackend(backend: 'rust-native' | 'javascript'): Promise<() => Promise<void>> {
  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  const prior = cfg.inspect<string>('callGraphBackend');
  await cfg.update('callGraphBackend', backend, vscode.ConfigurationTarget.Workspace);
  return async () => {
    await cfg.update('callGraphBackend', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
  };
}

function visibleLineOrdinalForEditorLine(editor: vscode.TextEditor, line: number): number | undefined {
  let remaining = 0;
  const ranges = [...editor.visibleRanges].sort((a, b) => a.start.line - b.start.line);
  for (const range of ranges) {
    const start = Math.max(0, range.start.line);
    const end = Math.min(editor.document.lineCount - 1, range.end.line);
    if (line >= start && line <= end) {
      return remaining + (line - start);
    }
    remaining += Math.max(0, end - start + 1);
  }
  return undefined;
}

function buildTenThousandLineInlayFixture(): string {
  const lines: string[] = [];
  for (let i = 0; i < 1_000; i++) {
    const suffix = String(i).padStart(4, '0');
    lines.push(
      `def ijss_inlay_target_${suffix}():`,
      `    return ${i}`,
      '',
      `def ijss_inlay_user_${suffix}():`,
      `    return ijss_inlay_target_${suffix}()`,
      '',
      `# filler ${suffix} a`,
      `# filler ${suffix} b`,
      `# filler ${suffix} c`,
      `# filler ${suffix} d`,
    );
  }
  assert.strictEqual(lines.length, 10_000, 'fixture generator should produce exactly 10k lines');
  return lines.join('\n');
}

function buildInlayClickLoadFixture(): string {
  const lines: string[] = [];
  for (let i = 0; i < 16; i++) {
    const suffix = String(i).padStart(2, '0');
    lines.push(
      `def ijss_click_target_${suffix}():`,
      `    return ${i}`,
      '',
      `def ijss_click_user_${suffix}():`,
      `    return ijss_click_target_${suffix}()`,
      '',
    );
  }
  return lines.join('\n');
}

function assertTimingsWithin(label: string, timings: number[], budgetMs: number): void {
  assert.ok(timings.length > 0, `${label} should record timings`);
  const sorted = [...timings].sort((a, b) => a - b);
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const p95Ms = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? maxMs;
  const avgMs = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  assert.ok(
    maxMs <= budgetMs,
    `${label} max should stay <= ${budgetMs}ms under load; timings=${timings.join(',')}ms max=${maxMs}ms p95=${p95Ms}ms avg=${Math.round(avgMs)}ms`,
  );
  assert.ok(
    p95Ms <= budgetMs,
    `${label} p95 should stay <= ${budgetMs}ms under load; timings=${timings.join(',')}ms max=${maxMs}ms p95=${p95Ms}ms avg=${Math.round(avgMs)}ms`,
  );
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

  test('first Monaco preview renders from cold capture', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alpha = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');

    try {
      await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
      await vscode.window.showTextDocument(alpha, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await overlay.show('ColdPreviewProbe', { forceLiteral: true, suppressSearch: true });
      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var alpha = ${JSON.stringify(alpha.toString())};
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'ColdPreviewProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          var statusBeforePreview = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
          var started = performance.now();
          window.__ijFindOnMessage({
            type: 'preview',
            __targetSrc: targetSrc,
            uri: alpha,
            relPath: 'alpha.py',
            languageId: 'python',
            focusLine: 0,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'class AlphaService:' },
              { lineNumber: 1, text: '    def __init__(self, name: str) -> None:' },
              { lineNumber: 2, text: '        self.name = name' },
              { lineNumber: 3, text: '        self.counter = 0' }
            ],
            ranges: [{ start: 6, end: 18 }]
          });
          var result = await new Promise(function (resolve) {
            var timer = null;
            function snapshot(reason) {
              var state = window.__ijFindGetSearchState(targetSrc);
              var body = root.querySelector('.ij-find-preview-body');
              var host = body ? body.querySelector('.ij-find-monaco-preview-host .monaco-editor') : null;
              var captureInfo = null;
              try {
                var caps = window.__ijFindCaptures || {};
                captureInfo = {
                  widgets: caps.widgets ? caps.widgets.length : 0,
                  services: caps.services ? caps.services.length : 0,
                  serviceKinds: caps.services ? caps.services.map(function (entry) { return entry && entry.kind || ''; }).slice(0, 10) : [],
                  ctors: caps.widgetCtors ? caps.widgetCtors.length : 0,
                  installed: !!window.__ijFindCaptureInstalled
                };
              } catch (eCapture) {}
              resolve({
                reason: reason,
                elapsedMs: Math.round(performance.now() - started),
                statusBeforePreview: statusBeforePreview,
                statusAfter: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status',
                previewMode: state && state.previewMode,
                previewUri: state && state.previewUri,
                hostVisible: !!host,
                captureInfo: captureInfo
              });
            }
            function check() {
              var state = window.__ijFindGetSearchState(targetSrc);
              var body = root.querySelector('.ij-find-preview-body');
              var host = body ? body.querySelector('.ij-find-monaco-preview-host .monaco-editor') : null;
              if (state && state.previewMode === 'monaco' && state.previewUri === alpha && host) {
                if (timer) { clearTimeout(timer); }
                snapshot('monaco-preview');
                return;
              }
              if (performance.now() - started >= 1500) {
                snapshot('timeout');
                return;
              }
              timer = setTimeout(check, 5);
            }
            check();
          });
          return JSON.stringify(result);
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        err?: string;
        reason?: string;
        elapsedMs?: number;
        statusBeforePreview?: string;
        statusAfter?: string;
        previewMode?: string;
        previewUri?: string;
        hostVisible?: boolean;
      };
      assert.strictEqual(parsed.err, undefined, `expected cold preview probe to run: ${raw}`);
      assert.strictEqual(parsed.reason, 'monaco-preview', `expected first preview to render as Monaco from cold capture: ${raw}`);
      assert.strictEqual(parsed.previewMode, 'monaco', `expected Monaco preview mode: ${raw}`);
      assert.strictEqual(parsed.previewUri, alpha.toString(), `expected preview for alpha.py: ${raw}`);
      assert.strictEqual(parsed.hostVisible, true, `expected Monaco preview host to be mounted: ${raw}`);
      assert.ok(
        (parsed.elapsedMs ?? Number.POSITIVE_INFINITY) <= 1500,
        `cold Monaco capture-to-preview latency should stay bounded even when the workbench event loop is busy; ${raw}`,
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            return 'closed';
          })()`,
        );
      } catch {}
      try { await overlay.forceReinject(); } catch {}
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  // Regression: clicking inside the Monaco preview used to make the editor's
  // DOM detach from our preview host and lose its model. Workbench treats any
  // non-simple editor that gets focused as "the active code editor" and
  // reparents it; isSimpleWidget=true prevents that takeover.
  test('Monaco preview survives a click inside the editor without losing its DOM or model', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected a workspace folder');
    // Workspace-agnostic: pick any plain text file VSCode can open. We only
    // need a real editor in the workbench so Monaco capture has something to
    // bind services to; the preview message itself carries synthetic content
    // and uses a synthetic URI that does not have to exist on disk.
    const captureCandidates = await vscode.workspace.findFiles(
      '**/*.{py,ts,tsx,js,jsx,md,txt,json}',
      '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**,**/.vscode-test/**}',
      8,
    );
    let captureUri: vscode.Uri | undefined;
    for (const candidate of captureCandidates) {
      try {
        const stat = await vscode.workspace.fs.stat(candidate);
        if (stat && stat.size > 0 && stat.size < 200_000) { captureUri = candidate; break; }
      } catch {}
    }
    if (!captureUri) {
      const synthetic = await vscode.workspace.openTextDocument({
        language: 'plaintext',
        content: '// IntelliJ Styled Search preview-click probe capture buffer\n',
      });
      captureUri = synthetic.uri;
    }
    const previewUri = vscode.Uri.parse(
      `file:///${folder!.uri.path.replace(/^\/+/, '').replace(/\/+$/, '')}/__ijss-preview-click-${Date.now()}.py`,
    );
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');

    try {
      await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
      await vscode.window.showTextDocument(captureUri, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await overlay.show('PreviewClickSurvivesProbe', { forceLiteral: true, suppressSearch: true });
      const anyOverlay = overlay as any;
      try {
        await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, undefined, {
          allowForceOpen: true,
          reason: 'test-preview-click-survives',
        });
      } catch {}
      const monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
      if (!monacoReady) { this.skip(); return; }

      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var alpha = ${JSON.stringify(previewUri.toString())};
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewClickSurvivesProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          window.__ijFindActiveInstanceId = targetSrc;
          window.__ijFindOnMessage({
            type: 'preview',
            __targetSrc: targetSrc,
            uri: alpha,
            relPath: '__ijss-preview-click.py',
            languageId: 'python',
            focusLine: 0,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'class AlphaService:' },
              { lineNumber: 1, text: '    def __init__(self, name: str) -> None:' },
              { lineNumber: 2, text: '        self.name = name' },
              { lineNumber: 3, text: '        self.counter = 0' }
            ],
            ranges: [{ start: 6, end: 18 }]
          });
          function probe(label) {
            var snap = window.__ijFindGetPreviewMonacoStateForTests
              ? window.__ijFindGetPreviewMonacoStateForTests()
              : null;
            var body = root.querySelector('.ij-find-preview-body');
            var hostEl = body ? body.querySelector('.ij-find-monaco-preview-host') : null;
            return {
              label: label,
              previewMode: snap && snap.previewMode,
              hostMounted: !!hostEl,
              domInHost: !!(snap && snap.domInHost),
              viewLines: snap && typeof snap.viewLines === 'number' ? snap.viewLines : 0,
              modelOk: !!(snap && snap.modelOk),
            };
          }
          var mountDeadline = performance.now() + 4000;
          var mounted = null;
          while (performance.now() < mountDeadline) {
            mounted = probe('mount');
            if (mounted.previewMode === 'monaco' && mounted.hostMounted && mounted.domInHost && mounted.viewLines > 0 && mounted.modelOk) {
              break;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 16); });
          }
          if (!mounted || !(mounted.previewMode === 'monaco' && mounted.hostMounted && mounted.domInHost && mounted.viewLines > 0 && mounted.modelOk)) {
            return JSON.stringify({ phase: 'mount-failed', mounted: mounted });
          }
          var body = root.querySelector('.ij-find-preview-body');
          var host = body ? body.querySelector('.ij-find-monaco-preview-host') : null;
          var dom = host ? host.querySelector('.monaco-editor') : null;
          if (!host || !dom) { return JSON.stringify({ phase: 'no-dom', mounted: mounted }); }
          var clickTarget = dom.querySelector('.view-line') || dom.querySelector('.view-lines') || dom;
          var rect = clickTarget.getBoundingClientRect();
          var x = rect.left + Math.max(8, Math.round(rect.width / 2));
          var y = rect.top + Math.max(2, Math.round(rect.height / 2));
          function fireMouseEvent(type, target) {
            try {
              var ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y });
              target.dispatchEvent(ev);
            } catch (eMouse) {}
          }
          function firePointerEvent(type, target) {
            try {
              if (typeof PointerEvent === 'function') {
                var ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y });
                target.dispatchEvent(ev);
              }
            } catch (ePointer) {}
          }
          var mutationLog = [];
          var hostMutations = [];
          var bodyMutations = [];
          var hostDetachObserver = null;
          var bodyObserver = null;
          var rootObserver = null;
          try {
            if (typeof MutationObserver === 'function') {
              hostDetachObserver = new MutationObserver(function (records) {
                for (var ri = 0; ri < records.length; ri++) {
                  var rec = records[ri];
                  var removed = rec.removedNodes ? rec.removedNodes.length : 0;
                  var added = rec.addedNodes ? rec.addedNodes.length : 0;
                  if (!removed && !added) { continue; }
                  hostMutations.push({
                    tMs: Math.round(performance.now() - clickStart),
                    targetCls: rec.target && rec.target.className ? String(rec.target.className).slice(0, 80) : '',
                    targetTag: rec.target && rec.target.tagName ? String(rec.target.tagName).toLowerCase() : '',
                    removed: removed,
                    added: added,
                    removedTags: rec.removedNodes ? Array.prototype.map.call(rec.removedNodes, function (n) {
                      return ((n && n.tagName) ? String(n.tagName).toLowerCase() : '#text') + '.' + ((n && n.className) ? String(n.className).slice(0, 40) : '');
                    }).slice(0, 4) : [],
                  });
                }
              });
              hostDetachObserver.observe(host, { childList: true, subtree: true });
              bodyObserver = new MutationObserver(function (records) {
                for (var ri = 0; ri < records.length; ri++) {
                  var rec = records[ri];
                  var removed = rec.removedNodes ? rec.removedNodes.length : 0;
                  var added = rec.addedNodes ? rec.addedNodes.length : 0;
                  if (!removed && !added) { continue; }
                  bodyMutations.push({
                    tMs: Math.round(performance.now() - clickStart),
                    targetCls: rec.target && rec.target.className ? String(rec.target.className).slice(0, 80) : '',
                    targetTag: rec.target && rec.target.tagName ? String(rec.target.tagName).toLowerCase() : '',
                    removed: removed,
                    added: added,
                  });
                }
              });
              bodyObserver.observe(body, { childList: true });
              // Track the editor DOM itself across the body — if it moves, capture the new parent.
              rootObserver = new MutationObserver(function (records) {
                for (var ri = 0; ri < records.length; ri++) {
                  var rec = records[ri];
                  if (!rec.removedNodes || !rec.removedNodes.length) { continue; }
                  for (var ni = 0; ni < rec.removedNodes.length; ni++) {
                    var node = rec.removedNodes[ni];
                    if (node === dom) {
                      mutationLog.push({
                        tMs: Math.round(performance.now() - clickStart),
                        kind: 'editor-dom-removed',
                        fromTag: rec.target && rec.target.tagName ? String(rec.target.tagName).toLowerCase() : '',
                        fromCls: rec.target && rec.target.className ? String(rec.target.className).slice(0, 80) : '',
                      });
                    }
                  }
                }
              });
              rootObserver.observe(document.body, { childList: true, subtree: true });
            }
          } catch (eDetachObs) {}
          var clickStart = performance.now();
          firePointerEvent('pointerdown', clickTarget);
          fireMouseEvent('mousedown', clickTarget);
          firePointerEvent('pointerup', clickTarget);
          fireMouseEvent('mouseup', clickTarget);
          fireMouseEvent('click', clickTarget);
          var afterImmediate = probe('after-click-immediate');
          // Sample state every ~10ms so we can pinpoint when DOM detaches.
          var timeline = [];
          for (var step = 0; step < 26; step++) {
            await new Promise(function (resolve) { setTimeout(resolve, 10); });
            var snap = window.__ijFindGetPreviewMonacoStateForTests
              ? window.__ijFindGetPreviewMonacoStateForTests()
              : null;
            timeline.push({
              tMs: Math.round(performance.now() - clickStart),
              domInHost: !!(snap && snap.domInHost),
              viewLines: snap && typeof snap.viewLines === 'number' ? snap.viewLines : 0,
              modelOk: !!(snap && snap.modelOk),
              disposed: !!(snap && snap.disposed),
              domErr: snap && snap.domErr || '',
            });
            if (snap && !snap.domInHost) { break; }
          }
          var afterShortWait = probe('after-click-250ms');
          await new Promise(function (resolve) { setTimeout(resolve, 750); });
          var afterLongWait = probe('after-click-1000ms');
          try { if (hostDetachObserver) { hostDetachObserver.disconnect(); } } catch (eDetachDisc) {}
          try { if (bodyObserver) { bodyObserver.disconnect(); } } catch (eBodyDisc) {}
          try { if (rootObserver) { rootObserver.disconnect(); } } catch (eRootDisc) {}
          // Capture where the editor's DOM ended up.
          var detachedDomParentChain = [];
          try {
            var cursor = dom;
            while (cursor && cursor.parentNode && detachedDomParentChain.length < 6) {
              cursor = cursor.parentNode;
              detachedDomParentChain.push(((cursor && cursor.tagName) ? String(cursor.tagName).toLowerCase() : '#') + '.' + ((cursor && cursor.className) ? String(cursor.className).slice(0, 60) : ''));
            }
          } catch (eChain) {}
          return JSON.stringify({
            phase: 'measured',
            mounted: mounted,
            afterImmediate: afterImmediate,
            afterShortWait: afterShortWait,
            afterLongWait: afterLongWait,
            timeline: timeline,
            hostMutations: hostMutations.slice(0, 30),
            bodyMutations: bodyMutations.slice(0, 30),
            mutationLog: mutationLog,
            detachedDomParentChain: detachedDomParentChain,
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        phase?: string;
        err?: string;
        mounted?: { previewMode?: string; hostMounted?: boolean; domInHost?: boolean; viewLines?: number; modelOk?: boolean };
        afterImmediate?: { domInHost?: boolean; viewLines?: number; modelOk?: boolean };
        afterShortWait?: { domInHost?: boolean; viewLines?: number; modelOk?: boolean };
        afterLongWait?: { domInHost?: boolean; viewLines?: number; modelOk?: boolean };
      };
      assert.strictEqual(parsed.err, undefined, `expected preview-click probe to run: ${raw}`);
      assert.strictEqual(parsed.phase, 'measured', `expected probe to complete the mount+click sequence: ${raw}`);
      assert.strictEqual(parsed.mounted?.previewMode, 'monaco', `preview should mount in Monaco mode before click: ${raw}`);
      assert.strictEqual(parsed.mounted?.domInHost, true, `editor DOM should be inside the host before click: ${raw}`);
      assert.strictEqual(parsed.mounted?.modelOk, true, `editor should have a model before click: ${raw}`);
      // The actual regression assertions: after a click in the preview editor,
      // its DOM must remain inside our host and its model must stay attached.
      assert.strictEqual(
        parsed.afterShortWait?.domInHost,
        true,
        `editor DOM should remain inside the host 250ms after a click — workbench takeover regression: ${raw}`,
      );
      assert.strictEqual(
        parsed.afterShortWait?.modelOk,
        true,
        `editor model should remain attached 250ms after a click: ${raw}`,
      );
      assert.ok(
        (parsed.afterShortWait?.viewLines ?? 0) > 0,
        `editor should still render view-lines 250ms after a click: ${raw}`,
      );
      assert.strictEqual(
        parsed.afterLongWait?.domInHost,
        true,
        `editor DOM should remain inside the host 1s after a click: ${raw}`,
      );
      assert.strictEqual(
        parsed.afterLongWait?.modelOk,
        true,
        `editor model should remain attached 1s after a click: ${raw}`,
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible')).forEach(function (root) {
              var query = root.querySelector('.ij-find-query');
              if (!query || query.value !== 'PreviewClickSurvivesProbe') { return; }
              var close = root.querySelector('.ij-find-close');
              if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
            });
            return 'closed';
          })()`,
        );
      } catch {}
      try { await overlay.forceReinject(); } catch {}
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('DOM fallback preview auto-recovers to Monaco for the same file after capture returns', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    await overlay.show('DomFallbackRecoveryProbe', { forceLiteral: true, suppressSearch: true });
    const anyOverlay = overlay as any;
    let monacoReady = false;
    try {
      await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, undefined, {
        allowForceOpen: true,
        reason: 'test-dom-preview-recovery',
      });
      monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
    } catch {}
    if (!monacoReady) {
      try {
        const forced = await overlay.forceCaptureForTests();
        monacoReady = /^ready/.test(forced) || await overlay.waitForMonacoReadyForTests(4_000);
      } catch {}
    }
    if (!monacoReady) { this.skip(); return; }
    try {
      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var status = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
          if (status !== 'ready') { return JSON.stringify({ skipped: true, status: status }); }
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'DomFallbackRecoveryProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          window.__ijFindActiveInstanceId = targetSrc;
          var uri = 'file:///tmp/ijss-dom-preview-recovery-' + Date.now() + '.py';
          var msg = {
            type: 'preview',
            __targetSrc: targetSrc,
            uri: uri,
            relPath: 'ijss-dom-preview-recovery.py',
            languageId: 'python',
            focusLine: 1,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'class DomFallbackRecovery:' },
              { lineNumber: 1, text: '    def target(self):' },
              { lineNumber: 2, text: '        return 42' }
            ],
            ranges: [{ start: 8, end: 14 }]
          };
          var oldDisable = window.__ijFindDisableMonacoProbes;
          window.__ijFindDisableMonacoProbes = true;
          var degraded = null;
          var degradedHost = false;
          var degradedText = '';
          var degradeAccepted = '';
          var degradeDeadline = performance.now() + 500;
          while (performance.now() < degradeDeadline) {
            degradeAccepted = String(window.__ijFindOnMessage(msg));
            await new Promise(function (resolve) { setTimeout(resolve, 16); });
            degraded = window.__ijFindGetSearchState(targetSrc);
            degradedHost = !!root.querySelector('.ij-find-monaco-preview-host .monaco-editor');
            degradedText = (root.querySelector('.ij-find-preview-body') || root).textContent || '';
            if (degraded && degraded.previewMode === 'dom' && degraded.previewUri === uri && degradedText.indexOf('DomFallbackRecovery') >= 0) {
              break;
            }
          }
          window.__ijFindDisableMonacoProbes = false;
          var recoveryStarted = performance.now();
          var recovered = null;
          var recoveredHost = false;
          var recoveryElapsedMs = null;
          var deadline = performance.now() + 4000;
          while (performance.now() < deadline) {
            recovered = window.__ijFindGetSearchState(targetSrc);
            recoveredHost = !!root.querySelector('.ij-find-monaco-preview-host .monaco-editor');
            if (recovered && recovered.previewMode === 'monaco' && recovered.previewUri === uri && recoveredHost) {
              recoveryElapsedMs = Math.round(performance.now() - recoveryStarted);
              break;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 16); });
          }
          window.__ijFindDisableMonacoProbes = oldDisable;
          return JSON.stringify({
            uri: uri,
            statusAfterCaptureReturn: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status',
            recoveryElapsedMs: recoveryElapsedMs,
            degraded: {
              mode: degraded && degraded.previewMode,
              uri: degraded && degraded.previewUri,
              host: degradedHost,
              hasText: degradedText.indexOf('DomFallbackRecovery') >= 0,
              accepted: degradeAccepted
            },
            recovered: {
              mode: recovered && recovered.previewMode,
              uri: recovered && recovered.previewUri,
              host: recoveredHost,
              modelUri: recovered && recovered.previewModelUri
            }
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        skipped?: boolean;
        err?: string;
        status?: string;
        uri?: string;
        statusAfterCaptureReturn?: string;
        recoveryElapsedMs?: number | null;
        degraded?: { mode?: string; uri?: string; host?: boolean; hasText?: boolean };
        recovered?: { mode?: string; uri?: string; host?: boolean; modelUri?: string };
      };
      if (parsed.skipped) { this.skip(); return; }
      assert.strictEqual(parsed.err, undefined, `expected DOM recovery probe to run: ${raw}`);
      assert.strictEqual(parsed.statusAfterCaptureReturn, 'ready', `expected Monaco capture to be ready after probes are re-enabled: ${raw}`);
      assert.strictEqual(parsed.degraded?.mode, 'dom', `preview should first degrade to DOM fallback: ${raw}`);
      assert.strictEqual(parsed.degraded?.uri, parsed.uri, `DOM fallback should keep the same preview URI: ${raw}`);
      assert.strictEqual(parsed.degraded?.host, false, `DOM fallback should not keep a Monaco host mounted: ${raw}`);
      assert.strictEqual(parsed.degraded?.hasText, true, `DOM fallback should render preview contents: ${raw}`);
      assert.strictEqual(parsed.recovered?.mode, 'monaco', `same preview should recover to Monaco mode without a second preview message: ${raw}`);
      assert.strictEqual(parsed.recovered?.uri, parsed.uri, `recovered Monaco preview should keep the same URI: ${raw}`);
      assert.strictEqual(parsed.recovered?.host, true, `recovered preview should mount a Monaco editor host: ${raw}`);
      assert.ok(
        typeof parsed.recoveryElapsedMs === 'number' && parsed.recoveryElapsedMs <= 4000,
        `DOM fallback preview should recover to Monaco within 4000ms after capture returns: ${raw}`,
      );
    } finally {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          Array.from(document.querySelectorAll('.ij-find-overlay.visible')).forEach(function (root) {
            var query = root.querySelector('.ij-find-query');
            if (!query || query.value !== 'DomFallbackRecoveryProbe') { return; }
            var close = root.querySelector('.ij-find-close');
            if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          });
          return 'closed';
        })()`,
      );
    }
  });

  test('rapid Monaco preview switches keep the latest preview without resource-model fanout', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewLspThrottleProbe', { forceLiteral: true, suppressSearch: true });
    const anyOverlay = overlay as any;
    let monacoReady = false;
    try {
      await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, undefined, {
        allowForceOpen: true,
        reason: 'test-preview-lsp-throttle',
      });
      monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
    } catch {}
    if (!monacoReady) {
      try {
        const forced = await overlay.forceCaptureForTests();
        monacoReady = /^ready/.test(forced) || await overlay.waitForMonacoReadyForTests(4_000);
      } catch {}
    }
    if (!monacoReady) { this.skip(); return; }
    try {
      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var status = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
          if (status !== 'ready') { return JSON.stringify({ skipped: true, status: status }); }
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewLspThrottleProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          root.setAttribute('data-ijss-test-owner', 'PreviewLspThrottleProbe');
          window.__ijFindActiveInstanceId = targetSrc;
          var before = window.__ijFindGetSearchState(targetSrc);
          var base = 'file:///tmp/ijss-preview-lsp-throttle-' + Date.now() + '-';
          var lastUri = '';
          var switchCount = 64;
          for (var i = 0; i < switchCount; i++) {
            lastUri = base + i + '.ts';
            var lines = [];
            for (var line = 0; line < 80; line++) {
              if (line === 0) {
                lines.push({ lineNumber: line, text: 'export function previewLspThrottle' + i + '() {' });
              } else if (line === 79) {
                lines.push({ lineNumber: line, text: '}' });
              } else {
                lines.push({ lineNumber: line, text: '  const v' + line + ' = ' + i + ' + ' + line + ';' });
              }
            }
            window.__ijFindOnMessage({
              type: 'preview',
              __targetSrc: targetSrc,
              uri: lastUri,
              relPath: 'ijss-preview-lsp-throttle-' + i + '.ts',
              languageId: 'plaintext',
              focusLine: 0,
              fullFile: true,
              lines: lines,
              ranges: [{ start: 16, end: 34 }]
            });
          }
          await new Promise(function (resolve) { setTimeout(resolve, 480); });
          var state = window.__ijFindGetSearchState(targetSrc);
          return JSON.stringify({
            targetSrc: targetSrc,
            counts: {
              resource: (state.previewResourceModelCreates || 0) - (before.previewResourceModelCreates || 0),
              isolated: (state.previewIsolatedModelCreates || 0) - (before.previewIsolatedModelCreates || 0),
              disposed: (state.previewOwnedModelDisposes || 0) - (before.previewOwnedModelDisposes || 0)
            },
            previewUri: state && state.previewUri,
            previewMode: state && state.previewMode,
            modelUri: state && state.previewModelUri,
            lastUri: lastUri,
            switchCount: switchCount,
            lspPressureReason: state && state.lspPressureReason,
            lspPressureUntil: state && state.lspPressureUntil
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        skipped?: boolean;
        err?: string;
        status?: string;
        targetSrc?: string;
        counts?: { resource: number; isolated: number; disposed: number };
        previewUri?: string;
        previewMode?: string;
        modelUri?: string;
        lastUri?: string;
        switchCount?: number;
        lspPressureReason?: string;
        lspPressureUntil?: number;
      };
      if (parsed.skipped) { this.skip(); return; }
      assert.strictEqual(parsed.err, undefined, `expected LSP throttle probe to run: ${raw}`);
      assert.ok((parsed.counts?.isolated ?? 0) >= (parsed.switchCount ?? 64) - 1, `rapid preview switching should render isolated models immediately: ${raw}`);
      assert.ok((parsed.counts?.resource ?? Number.POSITIVE_INFINITY) <= 1, `rapid preview switching should not create one LSP resource model per switch: ${raw}`);
      assert.ok((parsed.counts?.disposed ?? 0) >= (parsed.counts?.isolated ?? 0) - 1, `transient preview models should be disposed instead of accumulating: ${raw}`);
      assert.strictEqual(parsed.previewUri, parsed.lastUri, `final preview should remain on the latest switch: ${raw}`);
      assert.strictEqual(parsed.previewMode, 'monaco', `final preview should remain in Monaco mode: ${raw}`);
      if ((parsed.counts?.resource ?? 0) > 0) {
        assert.strictEqual(parsed.modelUri, parsed.lastUri, `only the final resource model should hydrate when a token is available: ${raw}`);
      }
    } finally {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          Array.from(document.querySelectorAll('.ij-find-overlay.visible')).forEach(function (root) {
            if (root.getAttribute('data-ijss-test-owner') !== 'PreviewLspThrottleProbe') { return; }
            var close = root.querySelector('.ij-find-close');
            if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          });
          return 'closed';
        })()`,
      );
    }
  });

  test('workbench editor activity briefly suppresses recursion capture without disabling LSP', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('EditorActivityGuardProbe', { forceLiteral: true, suppressSearch: true });
    try {
      const setupRaw = await overlay.evalInActiveWindowForTests(
        `(function(){
          if (!window.__ijFindSetIntelliSenseRecursionCaptureSuspended) {
            return JSON.stringify({ err: 'missing suspend setter' });
          }
          window.__ijFindSetIntelliSenseRecursionCaptureSuspended(false, 'search-ui-hidden');
          window.__ijFindEditorActivityGuardStarts = [];
          window.__irCaptureActive = false;
          window.__irStartCapture = function (reason) {
            window.__ijFindEditorActivityGuardStarts.push(String(reason || ''));
            window.__irCaptureActive = true;
            return 'started:' + String(reason || '');
          };
          return JSON.stringify({
            before: window.__ijFindIntelliSenseRecursionCaptureState ? window.__ijFindIntelliSenseRecursionCaptureState() : null
          });
        })()`,
      );
      const setup = JSON.parse(setupRaw) as { err?: string };
      assert.strictEqual(setup.err, undefined, `expected editor activity guard setup: ${setupRaw}`);

      (overlay as any).noteWorkbenchEditorActivity('test-tab-switch');
      await new Promise((resolve) => setTimeout(resolve, 40));

      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var during = window.__irStartCapture ? window.__irStartCapture('during-tab-switch') : 'no-start';
          var stateDuring = window.__ijFindIntelliSenseRecursionCaptureState ? window.__ijFindIntelliSenseRecursionCaptureState() : null;
          await new Promise(function (resolve) { setTimeout(resolve, 1100); });
          var after = window.__irStartCapture ? window.__irStartCapture('after-idle') : 'no-start';
          var stateAfter = window.__ijFindIntelliSenseRecursionCaptureState ? window.__ijFindIntelliSenseRecursionCaptureState() : null;
          return JSON.stringify({
            during: during,
            after: after,
            starts: window.__ijFindEditorActivityGuardStarts || [],
            stateDuring: stateDuring,
            stateAfter: stateAfter
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        during?: string;
        after?: string;
        starts?: string[];
        stateDuring?: { suspended?: boolean; reasons?: string[]; editorActivityCount?: number };
        stateAfter?: { suspended?: boolean; reasons?: string[] };
      };
      assert.match(parsed.during ?? '', /^suppressed:ijss:/, `tab-switch burst should suppress recursion capture: ${raw}`);
      assert.strictEqual(parsed.after, 'started:after-idle', `recursion capture should be allowed again after idle: ${raw}`);
      assert.deepStrictEqual(parsed.starts, ['after-idle'], `suppressed capture should not call the underlying start function: ${raw}`);
      assert.ok(parsed.stateDuring?.suspended, `editor activity should report suspended state: ${raw}`);
      assert.ok(parsed.stateDuring?.reasons?.includes('editor-activity'), `editor activity reason should be tracked: ${raw}`);
      assert.ok((parsed.stateDuring?.editorActivityCount ?? 0) >= 1, `editor activity should be counted: ${raw}`);
      assert.ok(!parsed.stateAfter?.reasons?.includes('editor-activity'), `editor activity reason should clear after idle: ${raw}`);
    } finally {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'EditorActivityGuardProbe';
          });
          var close = root && root.querySelector('.ij-find-close');
          if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          return 'closed';
        })()`,
      );
    }
  });

  test('diagnostics pressure defers preview LSP hydration until cooldown', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(30_000);
    const { overlay } = await getApi();
    await overlay.show('DiagnosticsPressurePreviewProbe', { forceLiteral: true, suppressSearch: true });
    const anyOverlay = overlay as any;
    let monacoReady = false;
    try {
      await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, undefined, {
        allowForceOpen: true,
        reason: 'test-diagnostics-pressure-preview',
      });
      monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
    } catch {}
    if (!monacoReady) { this.skip(); return; }
    try {
      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var status = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
          if (status !== 'ready') { return JSON.stringify({ skipped: true, status: status }); }
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'DiagnosticsPressurePreviewProbe';
          }) || document.querySelector('.ij-find-overlay.visible');
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          root.setAttribute('data-ijss-test-owner', 'DiagnosticsPressurePreviewProbe');
          window.__ijFindActiveInstanceId = targetSrc;
          var queryInput = root.querySelector('.ij-find-query');
          if (queryInput) { queryInput.value = ''; }
          if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(targetSrc); }
          await new Promise(function (resolve) { setTimeout(resolve, 0); });
          var before = window.__ijFindGetSearchState(targetSrc);
          var lastUri = 'file:///tmp/ijss-diagnostics-pressure-preview-' + Date.now() + '.py';
          var pressureUntil = Date.now() + 1000;
          function sendDiagnosticsPressure() {
            var msg = {
              type: 'lspPressure',
              active: true,
              until: pressureUntil,
              delayMs: Math.max(0, pressureUntil - Date.now()),
              reason: 'diagnostics-burst'
            };
            window.__ijFindOnMessage(msg);
            if (targetSrc) {
              window.__ijFindOnMessage(Object.assign({ __targetSrc: targetSrc }, msg));
            }
          }
          sendDiagnosticsPressure();
          var pressureState = window.__ijFindGetSearchState(targetSrc);
          var pressureAckDeadline = Date.now() + 150;
          while ((pressureState.lspPressureUntil || 0) < pressureUntil && Date.now() < pressureAckDeadline) {
            await new Promise(function (resolve) { setTimeout(resolve, 10); });
            sendDiagnosticsPressure();
            pressureState = window.__ijFindGetSearchState(targetSrc);
          }
          for (var i = 0; i < 6; i++) {
            window.__ijFindOnMessage({
              type: 'preview',
              __targetSrc: targetSrc,
              uri: lastUri,
              relPath: 'ijss-diagnostics-pressure-preview.py',
              languageId: 'plaintext',
              focusLine: i,
              fullFile: true,
              lines: [
                { lineNumber: 0, text: 'def diagnostics_pressure_preview():' },
                { lineNumber: 1, text: '    value = ' + i },
                { lineNumber: 2, text: '    return value' }
              ],
              ranges: [{ start: 4, end: 32 }]
            });
          }
          sendDiagnosticsPressure();
          await new Promise(function (resolve) { setTimeout(resolve, 320); });
          var mid = window.__ijFindGetSearchState(targetSrc);
          var waitForCooldownMs = Math.max(
            1100,
            Math.min(3000, ((mid.lspPressureUntil || pressureUntil) - Date.now()) + 1450)
          );
          await new Promise(function (resolve) { setTimeout(resolve, waitForCooldownMs); });
          var finalState = window.__ijFindGetSearchState(targetSrc);
          var hydrateDeadline = Date.now() + 6500;
          while (finalState.previewModelUri !== lastUri && Date.now() < hydrateDeadline) {
            var pressureWait = finalState.lspPressureUntil && finalState.lspPressureUntil > Date.now()
              ? Math.min(500, finalState.lspPressureUntil - Date.now() + 150)
              : 100;
            await new Promise(function (resolve) { setTimeout(resolve, Math.max(80, pressureWait)); });
            finalState = window.__ijFindGetSearchState(targetSrc);
          }
          return JSON.stringify({
            targetSrc: targetSrc,
            lastUri: lastUri,
            pressureUntil: pressureUntil,
            pressureAppliedUntil: pressureState.lspPressureUntil || 0,
            waitForCooldownMs: waitForCooldownMs,
            hydrateWaitMs: Date.now() - (pressureUntil - 650),
            mid: {
              resource: (mid.previewResourceModelCreates || 0) - (before.previewResourceModelCreates || 0),
              isolated: (mid.previewIsolatedModelCreates || 0) - (before.previewIsolatedModelCreates || 0),
              previewUri: mid.previewUri,
              modelUri: mid.previewModelUri,
              reason: mid.lspPressureReason,
              until: mid.lspPressureUntil
            },
            final: {
              resource: (finalState.previewResourceModelCreates || 0) - (before.previewResourceModelCreates || 0),
              isolated: (finalState.previewIsolatedModelCreates || 0) - (before.previewIsolatedModelCreates || 0),
              previewUri: finalState.previewUri,
              modelUri: finalState.previewModelUri,
              reason: finalState.lspPressureReason,
              until: finalState.lspPressureUntil
            }
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        skipped?: boolean;
        err?: string;
        targetSrc?: string;
        lastUri?: string;
        pressureUntil?: number;
        pressureAppliedUntil?: number;
        waitForCooldownMs?: number;
        hydrateWaitMs?: number;
        mid?: { resource: number; isolated: number; previewUri?: string; modelUri?: string; reason?: string; until?: number };
        final?: { resource: number; isolated: number; previewUri?: string; modelUri?: string; reason?: string; until?: number };
      };
      if (parsed.skipped) { this.skip(); return; }
      assert.strictEqual(parsed.err, undefined, `expected diagnostics pressure probe to run: ${raw}`);
      assert.ok((parsed.pressureAppliedUntil ?? 0) >= (parsed.pressureUntil ?? 0), `diagnostics pressure should apply before preview load: ${raw}`);
      assert.strictEqual(parsed.mid?.resource, 0, `diagnostics pressure should prevent resource hydration during burst: ${raw}`);
      assert.ok((parsed.mid?.isolated ?? 0) >= 1, `preview should still render immediately with isolated models: ${raw}`);
      assert.strictEqual(parsed.mid?.previewUri, parsed.lastUri, `preview should stay on the latest URI during pressure: ${raw}`);
      assert.ok(parsed.mid?.reason, `renderer should track an active LSP pressure reason: ${raw}`);
      assert.ok((parsed.mid?.until ?? 0) >= (parsed.pressureUntil ?? 0), `renderer pressure window should cover the diagnostics burst: ${raw}`);
      assert.ok((parsed.final?.resource ?? 0) <= 1, `cooldown should hydrate at most one final resource model: ${raw}`);
      assert.strictEqual(parsed.final?.modelUri, parsed.lastUri, `final resource model should hydrate after cooldown: ${raw}`);
    } finally {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          Array.from(document.querySelectorAll('.ij-find-overlay.visible')).forEach(function (root) {
            if (root.getAttribute('data-ijss-test-owner') !== 'DiagnosticsPressurePreviewProbe') { return; }
            var close = root.querySelector('.ij-find-close');
            if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          });
          return 'closed';
        })()`,
      );
    }
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

  test('overlay.show() preserves the user-open tab set and active editor', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const fixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    await vscode.window.showTextDocument(fixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const tabsBefore = snapshotTabCounts();
    const visibleBefore = visibleNonMemoryEditorUris();
    const activeBefore = vscode.window.activeTextEditor?.document.uri.toString();

    const started = Date.now();
    await overlay.show('TabStabilityProbe', {
      forceLiteral: true,
      suppressSearch: true,
    });
    const elapsedMs = Date.now() - started;
    const status = await overlay.evalInActiveWindowForTests(
      `(function(){try{return window.__ijFindStatus?window.__ijFindStatus():'no-fn'}catch(e){return 'throw:'+(e&&e.message)}})()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.match(status, /inDom=true/, `overlay should be attached to DOM, got: ${status}`);
    assert.match(status, /disp=(flex|block)/, `overlay display should be visible, got: ${status}`);
    assertNoAddedTabs(tabsBefore, 'overlay.show over an already-open editor');
    assert.deepStrictEqual(
      visibleEditorUris(),
      visibleBefore,
      'overlay.show should not introduce extra visible editors',
    );
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      activeBefore,
      'overlay.show should keep the user active editor selected',
    );
    assert.ok(
      elapsedMs <= 120,
      `overlay.show over an already-open editor should render within the 10x tighter budget; elapsed=${elapsedMs}ms`,
    );
  });

  test('preview force-open capture fallback is coalesced during burst navigation', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(30_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const previewFixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    overlay.resumeMonacoCaptureForTests();
    try { await closeTabsByUri(previewFixture); } catch {}
    await vscode.window.showTextDocument(activeFixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await overlay.show('PreviewForceOpenBurstProbe', { forceLiteral: true, suppressSearch: true });
    overlay.resetPreviewCaptureStatsForTests();

    const tabsBefore = snapshotTabCounts();
    const groupsBefore = snapshotTabGroupCount();
    const visibleBefore = visibleNonMemoryEditorUris();
    const activeBefore = vscode.window.activeTextEditor?.document.uri.toString();
    const src = `preview-force-open-burst-${Date.now()}`;

    try {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          window.__ijFindMonaco = null;
          window.__ijFindDisableMonacoProbes = false;
          window.__ijFindMonacoStatusOriginalForForceOpenBurstTest = window.__ijFindMonacoStatus;
          window.__ijFindMonacoStatus = function(){ return 'not-ready:test-forced'; };
          window.__ijFindTestCreateWidgetOriginalForForceOpenBurstTest = window.__ijFindTestCreateWidget;
          window.__ijFindTestCreateWidget = function(){ return 'test-widget-create-disabled-for-force-open-burst'; };
          if (window.__ijFindCaptures) {
            window.__ijFindCaptures.widgets = [];
            window.__ijFindCaptures.services = [];
            window.__ijFindCaptures.widgetCtors = [];
            window.__ijFindCaptures.serviceMaps = [];
          }
          window.__ijFindCaptureFromDomOriginalForForceOpenBurstTest = window.__ijFindCaptureFromDom;
          window.__ijFindCaptureFromDom = function(){ return 'test-dom-capture-disabled'; };
          return window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status';
        })()`,
      );
      let maxGroupCount = groupsBefore;
      let maxAddedTabs: string[] = [];
      let previewFileBecameVisible = false;
      let finalStats = overlay.getPreviewCaptureStatsForTests();
      for (let i = 0; i < 32; i++) {
        overlay.injectRendererEventForTests(JSON.stringify({
          type: 'requestPreview',
          uri: previewFixture.toString(),
          line: i % 4,
          contextLines: 0,
          ranges: [{ start: 0, end: 4 }],
          __src: src,
          __seq: i + 1,
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        maxGroupCount = Math.max(maxGroupCount, snapshotTabGroupCount());
        const added = addedTabKeys(tabsBefore, snapshotTabCounts());
        if (added.length > maxAddedTabs.length) {
          maxAddedTabs = added;
        }
        if (visibleEditorUris().includes(previewFixture.toString())) {
          previewFileBecameVisible = true;
        }
      }
      const pollUntil = Date.now() + 7000;
      while (Date.now() < pollUntil) {
        maxGroupCount = Math.max(maxGroupCount, snapshotTabGroupCount());
        const added = addedTabKeys(tabsBefore, snapshotTabCounts());
        if (added.length > maxAddedTabs.length) {
          maxAddedTabs = added;
        }
        if (visibleEditorUris().includes(previewFixture.toString())) {
          previewFileBecameVisible = true;
        }
        finalStats = overlay.getPreviewCaptureStatsForTests();
        if (finalStats.forceOpenAttempts >= 1 && !finalStats.forceOpenActive && !finalStats.forceOpenTimerActive) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        finalStats.forceOpenAttempts >= 1,
        `preview warmup should fall back to force-opening the requested URI when capture stays unavailable: ${JSON.stringify(finalStats)}`,
      );
      assert.strictEqual(
        finalStats.lastForceOpenUri,
        previewFixture.toString(),
        `preview force-open should target the latest requested preview URI: ${JSON.stringify(finalStats)}`,
      );
      assert.strictEqual(
        finalStats.lastCaptureOpenUri,
        previewFixture.toString(),
        `preview force-open should open the requested preview URI, not an unrelated workspace file: ${JSON.stringify(finalStats)}`,
      );
      assert.ok(
        finalStats.forceOpenAttempts <= 1,
        `burst preview navigation should be coalesced into one force-open capture attempt: ${JSON.stringify(finalStats)}`,
      );
      assert.ok(
        maxGroupCount <= groupsBefore + 1,
        `preview force-open fallback should create at most one transient editor group; before=${groupsBefore} max=${maxGroupCount}`,
      );
      assert.ok(
        maxAddedTabs.length <= 1,
        `preview force-open fallback should open at most one transient capture tab; added=${JSON.stringify(maxAddedTabs)}`,
      );
      assert.deepStrictEqual(
        visibleNonMemoryEditorUris().filter((uri) => uri !== previewFixture.toString()),
        visibleBefore,
        'preview force-open fallback should preserve the original visible editors apart from the transient capture tab',
      );
      assert.ok(
        previewFileBecameVisible,
        'preview force-open fallback should be allowed to transiently open the requested preview file for capture',
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        activeBefore,
        'preview force-open fallback should keep the user active editor selected',
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            if (window.__ijFindCaptureFromDomOriginalForForceOpenBurstTest) {
              window.__ijFindCaptureFromDom = window.__ijFindCaptureFromDomOriginalForForceOpenBurstTest;
              delete window.__ijFindCaptureFromDomOriginalForForceOpenBurstTest;
            }
            if (window.__ijFindMonacoStatusOriginalForForceOpenBurstTest) {
              window.__ijFindMonacoStatus = window.__ijFindMonacoStatusOriginalForForceOpenBurstTest;
              delete window.__ijFindMonacoStatusOriginalForForceOpenBurstTest;
            }
            if (window.__ijFindTestCreateWidgetOriginalForForceOpenBurstTest) {
              window.__ijFindTestCreateWidget = window.__ijFindTestCreateWidgetOriginalForForceOpenBurstTest;
              delete window.__ijFindTestCreateWidgetOriginalForForceOpenBurstTest;
            }
            return 'restored';
          })()`,
        );
      } catch {}
      overlay.resetPreviewCaptureStatsForTests();
      try { await closeTabsByUri(previewFixture); } catch {}
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('spawned preview reuses the Monaco editor factory singleton without force-open capture', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(30_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const previewFixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    overlay.resumeMonacoCaptureForTests();
    try { await closeTabsByUri(previewFixture); } catch {}

    try {
      await vscode.window.showTextDocument(activeFixture, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
      await overlay.show('PreviewFactorySingletonPrime', { forceLiteral: true, suppressSearch: true });
      const anyOverlay = overlay as any;
      let monacoReady = false;
      try {
        await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, undefined, {
          allowForceOpen: true,
          reason: 'test-preview-factory-singleton',
          bypassThrottle: true,
        });
        monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
      } catch {}
      if (!monacoReady) {
        try {
          const forced = await overlay.forceCaptureForTests();
          monacoReady = /^ready/.test(forced) || await overlay.waitForMonacoReadyForTests(4_000);
        } catch {}
      }
      if (!monacoReady) { this.skip(); return; }

      const primeRaw = await overlay.evalInActiveWindowForTests(
        `(function(){
          var m = window.__ijFindMonaco;
          var f = window.__ijFindMonacoFactory;
          return JSON.stringify({
            status: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status',
            hasCurrent: !!(m && m.ctor),
            hasFactory: !!(f && f.ctor),
            factorySingleton: !!(f && f.factorySingleton),
            instCandidates: f && f.instCandidates ? f.instCandidates.length : 0,
            modelSvcCandidates: f && f.modelSvcCandidates ? f.modelSvcCandidates.length : 0
          });
        })()`,
      );
      const prime = JSON.parse(primeRaw) as {
        status?: string;
        hasCurrent?: boolean;
        hasFactory?: boolean;
        factorySingleton?: boolean;
        instCandidates?: number;
        modelSvcCandidates?: number;
      };
      assert.strictEqual(prime.status, 'ready', `expected primed Monaco factory to be ready: ${primeRaw}`);
      assert.strictEqual(prime.hasFactory, true, `capture should persist a factory singleton, not only a widget ref: ${primeRaw}`);
      assert.strictEqual(prime.factorySingleton, true, `factory singleton flag should be set: ${primeRaw}`);
      assert.ok((prime.instCandidates ?? 0) >= 1, `factory should retain instantiation-service candidates: ${primeRaw}`);
      assert.ok((prime.modelSvcCandidates ?? 0) >= 1, `factory should retain model-service candidates: ${primeRaw}`);

      overlay.resetPreviewCaptureStatsForTests();
      const tabsBefore = snapshotTabCounts();
      const groupsBefore = snapshotTabGroupCount();
      const visibleBefore = visibleNonMemoryEditorUris();
      const activeBefore = vscode.window.activeTextEditor?.document.uri.toString();

      await overlay.show('PreviewFactorySingletonSpawnProbe', {
        forceLiteral: true,
        suppressSearch: true,
        spawn: true,
      });
      const spawnRaw = await overlay.evalInActiveWindowForTests(
        `(function(){
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewFactorySingletonSpawnProbe';
          });
          var m = window.__ijFindMonaco;
          var f = window.__ijFindMonacoFactory;
          return JSON.stringify({
            err: root ? undefined : 'missing spawned root',
            src: root ? root.getAttribute('data-ij-find-src') || '' : '',
            status: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status',
            hasCurrent: !!(m && m.ctor),
            hasFactory: !!(f && f.ctor),
            sameObject: !!(m && f && m === f),
            factoryVersion: f && f.factoryVersion,
            instCandidates: f && f.instCandidates ? f.instCandidates.length : 0,
            modelSvcCandidates: f && f.modelSvcCandidates ? f.modelSvcCandidates.length : 0
          });
        })()`,
      );
      const spawned = JSON.parse(spawnRaw) as {
        err?: string;
        src?: string;
        status?: string;
        hasCurrent?: boolean;
        hasFactory?: boolean;
        sameObject?: boolean;
        instCandidates?: number;
        modelSvcCandidates?: number;
      };
      assert.strictEqual(spawned.err, undefined, `expected spawned probe to open: ${spawnRaw}`);
      assert.ok(spawned.src, `expected spawned panel src: ${spawnRaw}`);
      assert.strictEqual(spawned.status, 'ready', `spawn/additional patch install should preserve the ready factory: ${spawnRaw}`);
      assert.strictEqual(spawned.hasFactory, true, `factory should survive spawned patch install: ${spawnRaw}`);
      assert.strictEqual(spawned.sameObject, true, `current Monaco handle should point at the persisted factory: ${spawnRaw}`);
      assert.ok((spawned.instCandidates ?? 0) >= 1, `spawned factory should keep inst candidates: ${spawnRaw}`);
      assert.ok((spawned.modelSvcCandidates ?? 0) >= 1, `spawned factory should keep model candidates: ${spawnRaw}`);

      const src = spawned.src!;
      const previewSeq = Number(await overlay.evalInActiveWindowForTests(
        `(function(){
          var src = ${JSON.stringify(src)};
          var state = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(src) : {};
          var active = state && typeof state.activePreviewSeq === 'number' ? state.activePreviewSeq : 0;
          return String(Math.max(Date.now(), active + 1));
        })()`,
      ));
      overlay.injectRendererEventForTests(JSON.stringify({
        type: 'requestPreview',
        uri: previewFixture.toString(),
        line: 0,
        contextLines: 0,
        ranges: [{ start: 6, end: 16 }],
        previewSeq,
        __src: src,
        __seq: Date.now(),
      }));

      let finalState = '';
      let maxGroupCount = groupsBefore;
      let maxAddedTabs: string[] = [];
      let previewFileBecameVisible = false;
      const started = Date.now();
      while (Date.now() - started < 2500) {
        maxGroupCount = Math.max(maxGroupCount, snapshotTabGroupCount());
        const added = addedTabKeys(tabsBefore, snapshotTabCounts());
        if (added.length > maxAddedTabs.length) {
          maxAddedTabs = added;
        }
        if (visibleEditorUris().includes(previewFixture.toString())) {
          previewFileBecameVisible = true;
        }
        finalState = await overlay.evalInActiveWindowForTests(
          `(function(){
            var src = ${JSON.stringify(src)};
            var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
              return (node.getAttribute('data-ij-find-src') || '') === src;
            });
            if (!root) { return JSON.stringify({ err: 'missing root' }); }
            var state = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(src) : {};
            var body = root.querySelector('.ij-find-preview-body');
            var f = window.__ijFindMonacoFactory;
            return JSON.stringify({
              previewMode: state && state.previewMode,
              previewUri: state && state.previewUri,
              hasMonacoHost: !!(body && body.querySelector('.ij-find-monaco-preview-host .monaco-editor')),
              monacoStatus: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status',
              hasFactory: !!(f && f.ctor),
              instCandidates: f && f.instCandidates ? f.instCandidates.length : 0,
              modelSvcCandidates: f && f.modelSvcCandidates ? f.modelSvcCandidates.length : 0
            });
          })()`,
        );
        const parsed = JSON.parse(finalState) as {
          previewMode?: string;
          previewUri?: string;
          hasMonacoHost?: boolean;
          monacoStatus?: string;
        };
        if (
          parsed.previewMode === 'monaco' &&
          parsed.previewUri === previewFixture.toString() &&
          parsed.hasMonacoHost === true &&
          parsed.monacoStatus === 'ready'
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const parsed = JSON.parse(finalState) as {
        err?: string;
        previewMode?: string;
        previewUri?: string;
        hasMonacoHost?: boolean;
        monacoStatus?: string;
        hasFactory?: boolean;
      };
      const finalStats = overlay.getPreviewCaptureStatsForTests();
      assert.strictEqual(parsed.err, undefined, `expected spawned preview state probe to run: ${finalState}`);
      assert.strictEqual(parsed.monacoStatus, 'ready', `factory should stay ready through preview render: ${finalState}`);
      assert.strictEqual(parsed.hasFactory, true, `factory should still be present after preview render: ${finalState}`);
      assert.strictEqual(parsed.previewMode, 'monaco', `spawned preview should render via Monaco factory, not DOM fallback: ${finalState}`);
      assert.strictEqual(parsed.previewUri, previewFixture.toString(), `spawned preview should render requested file: ${finalState}`);
      assert.strictEqual(parsed.hasMonacoHost, true, `spawned preview should mount a Monaco host: ${finalState}`);
      assert.strictEqual(
        finalStats.forceOpenAttempts,
        0,
        `ready factory should prevent force-open capture while recovering preview: ${JSON.stringify(finalStats)}`,
      );
      assert.strictEqual(finalStats.forceOpenTimerActive, false, `factory path should not leave a force-open timer: ${JSON.stringify(finalStats)}`);
      assert.strictEqual(maxGroupCount, groupsBefore, 'factory preview should not create an extra editor group/column');
      assert.deepStrictEqual(
        maxAddedTabs,
        [],
        `factory preview should not open transient capture tabs; added=${JSON.stringify(maxAddedTabs)}`,
      );
      assert.deepStrictEqual(
        visibleNonMemoryEditorUris(),
        visibleBefore,
        'factory preview should not introduce visible workbench editors',
      );
      assert.ok(!previewFileBecameVisible, 'factory preview should not transiently open the preview file in a workbench editor');
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        activeBefore,
        'factory preview should keep the user active editor selected',
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      overlay.resetPreviewCaptureStatsForTests();
      try { await closeTabsByUri(previewFixture); } catch {}
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            var cleanupQueries = {
              PreviewFactorySingletonPrime: true,
              PreviewFactorySingletonSpawnProbe: true
            };
            var closed = 0;
            var registry = window.__ijFindInstances || {};
            Object.keys(registry).forEach(function (id) {
              var inst = registry[id];
              var panel = inst && inst.panel;
              var query = panel && panel.querySelector ? panel.querySelector('.ij-find-query') : null;
              var value = query && query.value || '';
              if (!cleanupQueries[value]) { return; }
              try {
                var close = panel && panel.querySelector && panel.querySelector('.ij-find-close');
                if (close) {
                  close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  closed++;
                }
              } catch (eClose) {}
            });
            try { window.__ijFindActiveInstanceId = ''; } catch (eActive) {}
            return 'closed=' + closed;
          })()`,
        );
      } catch {}
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('force-open capture uses an untitled buffer when the requested preview file is already open', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(30_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const previewFixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    overlay.resumeMonacoCaptureForTests();
    overlay.resetPreviewCaptureStatsForTests();

    try {
      await vscode.window.showTextDocument(previewFixture, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Two,
      });
      await vscode.window.showTextDocument(activeFixture, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
      await overlay.show('PreviewForceOpenExistingFileProbe', { forceLiteral: true, suppressSearch: true });
      await overlay.evalInActiveWindowForTests(
        `(function(){
          window.__ijFindMonaco = null;
          window.__ijFindDisableMonacoProbes = false;
          window.__ijFindMonacoStatusOriginalForExistingForceOpenTest = window.__ijFindMonacoStatus;
          window.__ijFindMonacoStatus = function(){ return 'not-ready:test-existing-force-open'; };
          window.__ijFindTestCreateWidgetOriginalForExistingForceOpenTest = window.__ijFindTestCreateWidget;
          window.__ijFindTestCreateWidget = function(){ return 'test-widget-create-disabled-for-existing-force-open'; };
          if (window.__ijFindCaptures) {
            window.__ijFindCaptures.widgets = [];
            window.__ijFindCaptures.services = [];
            window.__ijFindCaptures.widgetCtors = [];
            window.__ijFindCaptures.serviceMaps = [];
          }
          window.__ijFindCaptureFromDomOriginalForExistingForceOpenTest = window.__ijFindCaptureFromDom;
          window.__ijFindCaptureFromDom = function(){ return 'test-dom-capture-disabled'; };
          return 'patched';
        })()`,
      );

      const anyOverlay = overlay as any;
      await anyOverlay.ensureMonacoCapture(anyOverlay.activeWindowId, previewFixture, {
        allowForceOpen: true,
        reason: 'test-existing-preview-force-open',
        bypassThrottle: true,
      });
      const stats = overlay.getPreviewCaptureStatsForTests();
      assert.ok(
        stats.lastCaptureOpenUri && /^untitled:/.test(stats.lastCaptureOpenUri),
        `force-open should use a capture-only untitled buffer when the requested preview file is already open: ${JSON.stringify(stats)}`,
      );
      assert.notStrictEqual(
        stats.lastCaptureOpenUri,
        activeFixture.toString(),
        `force-open must not choose an unrelated workspace file: ${JSON.stringify(stats)}`,
      );
    } finally {
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            if (window.__ijFindMonacoStatusOriginalForExistingForceOpenTest) {
              window.__ijFindMonacoStatus = window.__ijFindMonacoStatusOriginalForExistingForceOpenTest;
              delete window.__ijFindMonacoStatusOriginalForExistingForceOpenTest;
            }
            if (window.__ijFindTestCreateWidgetOriginalForExistingForceOpenTest) {
              window.__ijFindTestCreateWidget = window.__ijFindTestCreateWidgetOriginalForExistingForceOpenTest;
              delete window.__ijFindTestCreateWidgetOriginalForExistingForceOpenTest;
            }
            if (window.__ijFindCaptureFromDomOriginalForExistingForceOpenTest) {
              window.__ijFindCaptureFromDom = window.__ijFindCaptureFromDomOriginalForExistingForceOpenTest;
              delete window.__ijFindCaptureFromDomOriginalForExistingForceOpenTest;
            }
            return 'restored';
          })()`,
        );
      } catch {}
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      overlay.resetPreviewCaptureStatsForTests();
      try { await closeTabsByUri(previewFixture); } catch {}
      try { await closeTabsByUri(activeFixture); } catch {}
    }
  });

  test('renderer recovery only pauses Monaco capture and allows later preview capture', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    overlay.resumeMonacoCaptureForTests();

    try {
      await overlay.show('RecoveryCaptureProbe', { forceLiteral: true, suppressSearch: true });
      const report = await overlay.recoverRendererUi('test');
      assert.match(
        report,
        /future-monaco-capture=paused:\d+ms/,
        `renderer recovery should pause, not permanently disable, future Monaco capture: ${report}`,
      );
      let state = overlay.getMonacoCaptureStateForTests();
      assert.strictEqual(state.stoppedForSession, false, `recoverRendererUi should not stop capture for the full session: ${JSON.stringify(state)}`);
      assert.ok(state.recoveryPauseRemainingMs > 0, `recoverRendererUi should apply a short recovery pause: ${JSON.stringify(state)}`);

      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        state = overlay.getMonacoCaptureStateForTests();
        if (state.enabled && state.recoveryPauseRemainingMs === 0) { break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.strictEqual(state.enabled, true, `Monaco capture should resume after renderer recovery pause: ${JSON.stringify(state)}`);

      await overlay.show('RecoveryCaptureProbeAfterPause', { forceLiteral: true, suppressSearch: true });
      const rendererFlag = await overlay.evalInActiveWindowForTests(
        `(function(){
          try {
            return window.__ijFindDisableMonacoProbes === false ? 'capture-enabled' : 'capture-disabled:' + String(window.__ijFindDisableMonacoProbes);
          } catch (e) {
            return 'throw:' + (e && e.message);
          }
        })()`,
      );
      assert.strictEqual(rendererFlag, 'capture-enabled', `renderer patch should be re-enabled for Monaco preview probes after recovery: ${rendererFlag}`);
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      overlay.resumeMonacoCaptureForTests();
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('inlay click warmup keeps the renderer bridge hot for the first spawned header', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorHook = cfg.inspect<boolean>('rendererInlayClickHook');
    const priorIdle = cfg.inspect<number>('rendererBridgeSingletonIdleMs');
    await cfg.update('rendererInlayClickHook', true, vscode.ConfigurationTarget.Workspace);
    await cfg.update('rendererBridgeSingletonIdleMs', 5000, vscode.ConfigurationTarget.Workspace);
    overlay.resetRendererInlayClickHookWarmupForTests();

    try {
      overlay.scheduleRendererInlayClickHookWarmup('test-hot-first-click', 0, true);
      let state = overlay.getRendererInlayClickHookStateForTests();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        state = overlay.getRendererInlayClickHookStateForTests();
        if (state.ready && state.readyForActiveWindow && state.cdpOpen && state.idleCloseTimerActive) { break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.strictEqual(state.ready, true, `renderer inlay click hook should be warmed: ${JSON.stringify(state)}`);
      assert.strictEqual(
        state.readyForActiveWindow,
        true,
        `warmup should install the inlay click hook in the active workbench window, not just any window: ${JSON.stringify(state)}`,
      );
      assert.strictEqual(state.cdpOpen, true, `warmup should keep CDP open for the first inlay click instead of closing immediately: ${JSON.stringify(state)}`);
      assert.strictEqual(state.idleCloseTimerActive, true, `warmup should schedule singleton idle close rather than immediate close: ${JSON.stringify(state)}`);
      assert.strictEqual(state.warmupFailures, 0, `warmup should not exhaust retries in the happy path: ${JSON.stringify(state)}`);
    } finally {
      await cfg.update('rendererInlayClickHook', priorHook?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await cfg.update('rendererBridgeSingletonIdleMs', priorIdle?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      overlay.resetRendererInlayClickHookWarmupForTests();
    }
  });

  test('preview warmup promotes an existing editor object without opening the preview file', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const previewFixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(activeFixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await overlay.show('PreviewExistingEditorWarmupProbe', { forceLiteral: true, suppressSearch: true });

    const tabsBefore = snapshotTabCounts();
    const groupsBefore = snapshotTabGroupCount();
    const visibleBefore = visibleNonMemoryEditorUris();
    const activeBefore = vscode.window.activeTextEditor?.document.uri.toString();
    const src = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewExistingEditorWarmupProbe';
        });
        return root ? root.getAttribute('data-ij-find-src') || '' : '';
        })()`,
      );
      assert.ok(src, 'expected PreviewExistingEditorWarmupProbe renderer source');
      try {
        const previewSeq = Number(await overlay.evalInActiveWindowForTests(
          `(function(){
            var src = ${JSON.stringify(src)};
            var state = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(src) : {};
            var active = state && typeof state.activePreviewSeq === 'number' ? state.activePreviewSeq : 0;
            return String(Math.max(Date.now(), active + 1));
          })()`,
        ));
      await overlay.evalInActiveWindowForTests(
        `(function(){
          window.__ijFindMonaco = null;
          window.__ijFindDisableMonacoProbes = false;
          return window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status';
        })()`,
      );
      overlay.injectRendererEventForTests(JSON.stringify({
        type: 'requestPreview',
        uri: previewFixture.toString(),
        line: 0,
        contextLines: 0,
        ranges: [{ start: 6, end: 16 }],
        previewSeq,
        __src: src,
        __seq: Date.now(),
      }));

      let maxGroupCount = groupsBefore;
      let maxAddedTabs: string[] = [];
      let previewFileBecameVisible = false;
      let finalState = '';
      const started = Date.now();
      while (Date.now() - started < 2500) {
        maxGroupCount = Math.max(maxGroupCount, snapshotTabGroupCount());
        const added = addedTabKeys(tabsBefore, snapshotTabCounts());
        if (added.length > maxAddedTabs.length) {
          maxAddedTabs = added;
        }
        if (visibleEditorUris().includes(previewFixture.toString())) {
          previewFileBecameVisible = true;
        }
        finalState = await overlay.evalInActiveWindowForTests(
          `(function(){
            var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
              var query = node.querySelector('.ij-find-query');
              return query && query.value === 'PreviewExistingEditorWarmupProbe';
            });
            if (!root) { return JSON.stringify({ err: 'missing root' }); }
            var src = root.getAttribute('data-ij-find-src') || '';
            var state = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(src) : {};
            var body = root.querySelector('.ij-find-preview-body');
            return JSON.stringify({
              previewMode: state && state.previewMode,
              previewUri: state && state.previewUri,
              hasMonacoHost: !!(body && body.querySelector('.ij-find-monaco-preview-host .monaco-editor')),
              monacoStatus: window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status'
            });
          })()`,
        );
        const parsed = JSON.parse(finalState) as {
          previewMode?: string;
          previewUri?: string;
          hasMonacoHost?: boolean;
          monacoStatus?: string;
        };
        if (
          parsed.previewMode === 'monaco' &&
          parsed.previewUri === previewFixture.toString() &&
          parsed.hasMonacoHost === true
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const parsed = JSON.parse(finalState) as {
        err?: string;
        previewMode?: string;
        previewUri?: string;
        hasMonacoHost?: boolean;
        monacoStatus?: string;
      };
      assert.strictEqual(parsed.err, undefined, `expected preview state probe to run: ${finalState}`);
      assert.strictEqual(parsed.previewMode, 'monaco', `preview warmup should recover from DOM fallback to Monaco using an existing editor object: ${finalState}`);
      assert.strictEqual(parsed.previewUri, previewFixture.toString(), `preview warmup should refresh the latest requested preview: ${finalState}`);
      assert.strictEqual(parsed.hasMonacoHost, true, `preview warmup should mount a Monaco preview host: ${finalState}`);
      assert.strictEqual(
        maxGroupCount,
        groupsBefore,
        'existing-editor preview warmup should not create an extra editor group/column',
      );
      assert.deepStrictEqual(
        maxAddedTabs,
        [],
        `existing-editor preview warmup should not open additional editor tabs; added=${JSON.stringify(maxAddedTabs)}`,
      );
      assert.deepStrictEqual(
        visibleNonMemoryEditorUris(),
        visibleBefore,
        'existing-editor preview warmup should not introduce extra visible workbench editors',
      );
      assert.ok(
        !previewFileBecameVisible,
        'existing-editor preview warmup should not transiently open the preview file in a workbench editor',
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        activeBefore,
        'existing-editor preview warmup should keep the user active editor selected',
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await closeTabsByUri(previewFixture); } catch {}
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('warm overlay.show() stays fast without opening tabs across repeated invocations', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const fixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    await vscode.window.showTextDocument(fixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await overlay.show('WarmShowProbePriming', {
      forceLiteral: true,
      suppressSearch: true,
    });
    await probeRendererSearchState(overlay);

    const tabsBefore = snapshotTabCounts();
    const timings: number[] = [];
    for (const query of ['WarmShowProbeA', 'WarmShowProbeB', 'WarmShowProbeC']) {
      const started = Date.now();
      await overlay.show(query, {
        forceLiteral: true,
        suppressSearch: true,
      });
      const elapsedMs = Date.now() - started;
      timings.push(elapsedMs);
      const state = await probeRendererSearchState(overlay);
      assert.strictEqual(state.inputValue, query, `renderer should show the latest query after ${query}: ${JSON.stringify(state)}`);
      assertNoAddedTabs(tabsBefore, `warm overlay.show ${query}`);
    }

    const maxMs = Math.max(...timings);
    const avgMs = timings.reduce((sum, value) => sum + value, 0) / timings.length;
    const medianMs = [...timings].sort((a, b) => a - b)[Math.floor(timings.length / 2)] ?? Number.POSITIVE_INFINITY;
    assert.ok(
      maxMs <= 120,
      `warm overlay.show should keep isolated full-run CDP stalls bounded; timings=${timings.join(',')}ms`,
    );
    assert.ok(
      medianMs <= 35,
      `warm overlay.show steady-state median should stay under the 10x tighter 35ms budget; timings=${timings.join(',')}ms avg=${Math.round(avgMs)}ms median=${medianMs}ms`,
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

  test('call graph inlay click hook prefers the clicked widget target over visible-line fallback', async function () {
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
        editor.style.cssText = 'position:fixed;left:30px;top:30px;width:220px;height:50px;z-index:2147483647;';
        editor.__ijssFakeWidget = {
          layout: function(){},
          getDomNode: function(){ return editor; },
          getModel: function(){ return { uri: { toString: function(){ return 'file:///wrong-token-position.py'; } } }; },
          getTargetAtClientPoint: function(){ return { position: { lineNumber: 99, column: 7 } }; }
        };
        var lines = document.createElement('div');
        lines.className = 'view-lines';
        var line = document.createElement('div');
        line.className = 'view-line';
        var hint = document.createElement('span');
        hint.className = 'inline-hints-widget ijss-callgraph';
        hint.textContent = 'usages 2';
        hint.style.cssText = 'display:inline-block;padding:2px;';
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
        var dispatchResult = hint.dispatchEvent(pointer);
        await new Promise(function (resolve) { setTimeout(resolve, 25); });
        editor.remove();
        globalThis.irSearchEvent = oldBridge;
        return JSON.stringify({
          prevented: pointer.defaultPrevented || !dispatchResult,
          sent: sent
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      prevented: boolean;
      sent: Array<{ type?: string; command?: string; args?: unknown[] }>;
    };
    assert.strictEqual(parsed.prevented, true, `inlay pointerdown should be consumed by the call graph hook: ${raw}`);
    assert.ok(
      parsed.sent.some((msg) =>
        msg.type === 'runCommand' &&
        msg.command === 'intellijStyledSearch.activateCallGraphInlayAtPosition' &&
        msg.args?.[1] === 'file:///wrong-token-position.py' &&
        msg.args?.[2] === 98 &&
        msg.args?.[3] === 6),
      `inlay click should pass the clicked Monaco target position instead of a visible-line ordinal: ${raw}`,
    );
    assert.ok(
      !parsed.sent.some((msg) => msg.type === 'runCommand' && msg.command === 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine'),
      `clicked widget target should avoid stale visible-line fallback: ${raw}`,
    );
  });

  test('call graph inlay click hook does not reuse the previous inlay target for the next click', async function () {
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
        var activeTarget = { lineNumber: 11, column: 22 };
        var editor = document.createElement('div');
        editor.className = 'monaco-editor';
        editor.style.cssText = 'position:fixed;left:30px;top:30px;width:260px;height:50px;z-index:2147483647;';
        editor.__ijssFakeWidget = {
          layout: function(){},
          getDomNode: function(){ return editor; },
          getModel: function(){ return { uri: { toString: function(){ return 'file:///clicked-inlay-target.py'; } } }; },
          getTargetAtClientPoint: function(){ return { position: activeTarget }; }
        };
        var lines = document.createElement('div');
        lines.className = 'view-lines';
        var line = document.createElement('div');
        line.className = 'view-line';
        lines.appendChild(line);
        editor.appendChild(lines);
        document.body.appendChild(editor);
        function clickHint(text, target) {
          activeTarget = target;
          line.textContent = '';
          var hint = document.createElement('span');
          hint.className = 'inline-hints-widget ijss-callgraph';
          hint.textContent = text;
          hint.style.cssText = 'display:inline-block;padding:2px;';
          line.appendChild(hint);
          var rect = hint.getBoundingClientRect();
          var pointer = new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: rect.left + 2,
            clientY: rect.top + 2
          });
          var dispatchResult = hint.dispatchEvent(pointer);
          return { prevented: pointer.defaultPrevented || !dispatchResult };
        }
        var first = clickHint('usages 1', { lineNumber: 11, column: 22 });
        var second = clickHint('usages 2', { lineNumber: 41, column: 18 });
        await new Promise(function (resolve) { setTimeout(resolve, 25); });
        editor.remove();
        globalThis.irSearchEvent = oldBridge;
        return JSON.stringify({
          first: first,
          second: second,
          sent: sent
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      first?: { prevented?: boolean };
      second?: { prevented?: boolean };
      sent: Array<{ type?: string; command?: string; args?: unknown[] }>;
    };
    const positionCommands = parsed.sent.filter((msg) =>
      msg.type === 'runCommand' &&
      msg.command === 'intellijStyledSearch.activateCallGraphInlayAtPosition');
    assert.strictEqual(parsed.first?.prevented, true, `first inlay pointerdown should be consumed: ${raw}`);
    assert.strictEqual(parsed.second?.prevented, true, `second inlay pointerdown should be consumed: ${raw}`);
    assert.strictEqual(positionCommands.length, 2, `both inlay clicks should dispatch exact position commands: ${raw}`);
    assert.deepStrictEqual(
      positionCommands.map((msg) => msg.args),
      [
        ['usages', 'file:///clicked-inlay-target.py', 10, 21],
        ['usages', 'file:///clicked-inlay-target.py', 40, 17],
      ],
      `second inlay click must use the clicked target, not the previous inlay target: ${raw}`,
    );
    assert.ok(
      !parsed.sent.some((msg) => msg.type === 'runCommand' && msg.command === 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine'),
      `exact clicked positions should avoid visible-line fallback reuse: ${raw}`,
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

  test('spawned inlay-style show without a base panel uses centered preview-heavy layout', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();

    await overlay.show('SpawnLayoutCleanup', { forceLiteral: true, suppressSearch: true });
    await overlay.evalInActiveWindowForTests(
      `(function(){
        Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        return 'closed';
      })()`,
    );

    await overlay.show('InlaySpawnNoBase', { forceLiteral: true, suppressSearch: true, spawn: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'InlaySpawnNoBase';
        });
        var results = root && root.querySelector('.ij-find-results');
        var preview = root && root.querySelector('.ij-find-preview');
        var rect = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        var resultsRect = results ? results.getBoundingClientRect() : { height: 0 };
        var previewRect = preview ? preview.getBoundingClientRect() : { height: 0 };
        var close = root && root.querySelector('.ij-find-close');
        var out = {
          exists: !!root,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          centerDelta: Math.round(Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2)),
          resultsHeight: Math.round(resultsRect.height),
          previewHeight: Math.round(previewRect.height)
        };
        if (close) {
          close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return JSON.stringify(out);
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      exists: boolean;
      left: number;
      top: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
      centerDelta: number;
      resultsHeight: number;
      previewHeight: number;
    };
    assert.strictEqual(parsed.exists, true, `expected spawned panel to open: ${raw}`);
    assert.ok(parsed.centerDelta <= 6, `spawn without a visible base should use centered default layout, not top-left fallback: ${raw}`);
    assert.ok(parsed.top >= 36, `spawned panel should not use the stale 0x0 top-left offset: ${raw}`);
    assert.ok(parsed.width >= Math.min(820, parsed.viewportWidth - 44), `spawned panel should use the full search layout width: ${raw}`);
    assert.ok(parsed.height >= Math.min(560, parsed.viewportHeight - 84), `spawned panel should use the full search layout height: ${raw}`);
    assert.ok(parsed.previewHeight >= Math.min(320, parsed.height * 0.45), `preview pane should be large enough for code review: ${raw}`);
    assert.ok(parsed.previewHeight > parsed.resultsHeight * 1.5, `preview pane should dominate the result list by default: ${raw}`);
  });

  test('DOM fallback preview render failures keep the panel chrome and resize handle attached', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('DomPreviewChromeFailureProbe', { forceLiteral: true, suppressSearch: true, spawn: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'DomPreviewChromeFailureProbe';
        });
        if (!root) { return JSON.stringify({ err: 'missing root' }); }
        var targetSrc = root.getAttribute('data-ij-find-src') || '';
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        window.__ijFindDisableMonacoProbes = true;
        var badLine = { lineNumber: 0 };
        Object.defineProperty(badLine, 'text', {
          get: function(){ throw new Error('test preview text getter failed'); }
        });
        try {
          window.__ijFindOnMessage({
            type: 'preview',
            __targetSrc: targetSrc,
            uri: 'file:///dom-preview-chrome-failure.py',
            relPath: 'dom-preview-chrome-failure.py',
            languageId: 'python',
            focusLine: 0,
            fullFile: true,
            lines: [badLine],
            ranges: [{ start: 0, end: 4 }]
          });
        } catch (e) {}
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        var rect = root.getBoundingClientRect();
        var header = root.querySelector('.ij-find-header');
        var toolbar = root.querySelector('.ij-find-toolbar');
        var results = root.querySelector('.ij-find-results');
        var splitter = root.querySelector('.ij-find-splitter');
        var preview = root.querySelector('.ij-find-preview');
        var resizer = root.querySelector('.ij-find-resizer');
        var rr = resizer ? resizer.getBoundingClientRect() : { bottom: 0, right: 0 };
        var close = root.querySelector('.ij-find-close');
        var out = {
          shell: root.classList.contains('ij-find-shell'),
          headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
          toolbarAttached: !!toolbar && toolbar.parentElement === root,
          resultsAttached: !!results && results.parentElement === root,
          splitterAttached: !!splitter && splitter.parentElement === root,
          previewAttached: !!preview && preview.parentElement === root,
          resizerAttached: !!resizer && resizer.parentElement === root,
          resizerBottomDelta: Math.round(rect.bottom - rr.bottom),
          resizerRightDelta: Math.round(rect.right - rr.right),
          previewText: preview ? (preview.textContent || '') : ''
        };
        if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        return JSON.stringify(out);
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      shell: boolean;
      headerHeight: number;
      toolbarAttached: boolean;
      resultsAttached: boolean;
      splitterAttached: boolean;
      previewAttached: boolean;
      resizerAttached: boolean;
      resizerBottomDelta: number;
      resizerRightDelta: number;
      previewText: string;
    };
    assert.strictEqual(parsed.err, undefined, `expected DOM preview chrome probe to run: ${raw}`);
    assert.strictEqual(parsed.shell, false, `fallback preview should restore full panel mode: ${raw}`);
    assert.ok(parsed.headerHeight > 20, `panel header should remain visible after fallback render failure: ${raw}`);
    assert.strictEqual(parsed.toolbarAttached, true, `toolbar should remain attached: ${raw}`);
    assert.strictEqual(parsed.resultsAttached, true, `results should remain attached: ${raw}`);
    assert.strictEqual(parsed.splitterAttached, true, `splitter should remain attached: ${raw}`);
    assert.strictEqual(parsed.previewAttached, true, `preview should remain attached: ${raw}`);
    assert.strictEqual(parsed.resizerAttached, true, `resize handle should remain attached: ${raw}`);
    assert.ok(Math.abs(parsed.resizerBottomDelta) <= 2, `resize handle should stay on the panel bottom edge: ${raw}`);
    assert.ok(Math.abs(parsed.resizerRightDelta) <= 2, `resize handle should stay on the panel right edge: ${raw}`);
    assert.match(parsed.previewText, /Preview fallback render failed/, `fallback error should render inside preview body: ${raw}`);
  });

  test('splitter grows results without leaving blank space below preview', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('SplitterBlankSpaceProbe', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'SplitterBlankSpaceProbe';
        });
        if (!root) { return JSON.stringify({ err: 'missing root' }); }
        root.style.height = '720px';
        root.style.width = '860px';
        root.style.maxHeight = 'none';
        var results = root.querySelector('.ij-find-results');
        var splitter = root.querySelector('.ij-find-splitter');
        var preview = root.querySelector('.ij-find-preview');
        if (!results || !splitter || !preview) { return JSON.stringify({ err: 'missing split parts' }); }
        var before = {
          results: Math.round(results.getBoundingClientRect().height),
          preview: Math.round(preview.getBoundingClientRect().height)
        };
        var sr = splitter.getBoundingClientRect();
        splitter.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: sr.left + sr.width / 2,
          clientY: sr.top + sr.height / 2
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: sr.left + sr.width / 2,
          clientY: sr.top + sr.height / 2 + 260
        }));
        document.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: sr.left + sr.width / 2,
          clientY: sr.top + sr.height / 2 + 260
        }));
        void root.offsetHeight;
        var pr = preview.getBoundingClientRect();
        var rr = results.getBoundingClientRect();
        var rootRect = root.getBoundingClientRect();
        var close = root.querySelector('.ij-find-close');
        if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
        return JSON.stringify({
          before: before,
          after: {
            results: Math.round(rr.height),
            preview: Math.round(pr.height),
            previewBottomGap: Math.round(rootRect.bottom - pr.bottom)
          }
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      before: { results: number; preview: number };
      after: { results: number; preview: number; previewBottomGap: number };
    };
    assert.strictEqual(parsed.err, undefined, `expected splitter probe to run: ${raw}`);
    assert.ok(parsed.after.results > Math.max(220, parsed.before.results + 160), `results pane should grow past the old hard cap: ${raw}`);
    assert.ok(parsed.after.preview >= 150, `preview should keep its minimum readable height: ${raw}`);
    assert.ok(parsed.after.previewBottomGap <= 4, `preview should consume remaining panel space without bottom blank gap: ${raw}`);
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

  test('DOM preview call graph inlays dispatch direct symbol commands', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewMetadataInlayHost', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewMetadataInlayHost';
        });
        if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
        var targetSrc = root.getAttribute('data-ij-find-src') || '';
        var oldBridge = globalThis.irSearchEvent;
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        window.__ijFindDisableMonacoProbes = true;
        window.__ijFindOnMessage({
          type: 'preview',
          __targetSrc: targetSrc,
          uri: 'file:///preview-metadata-inlay.py',
          relPath: 'preview-metadata-inlay.py',
          languageId: 'python',
          focusLine: 0,
          fullFile: true,
          lines: [
            { lineNumber: 0, text: 'class PreviewMetadataSymbol:' },
            { lineNumber: 1, text: '    pass' }
          ],
          callGraphInlays: [{
            line: 0,
            column: 28,
            kind: 'usages',
            text: 'usages 2',
            symbolId: 'python:preview-metadata-inlay.py:PreviewMetadataSymbol:1',
            label: 'PreviewMetadataSymbol'
          }]
        });
        var inlay = root.querySelector('[data-ijss-callgraph-symbol-id]');
        if (!inlay) {
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
          return JSON.stringify({ err: 'missing preview inlay', html: root.querySelector('.ij-find-preview-body')?.innerHTML || '' });
        }
        var rect = inlay.getBoundingClientRect();
        var ev = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: rect.left + 2,
          clientY: rect.top + 2
        });
        var dispatchResult = inlay.dispatchEvent(ev);
        globalThis.irSearchEvent = oldBridge;
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        return JSON.stringify({
          prevented: ev.defaultPrevented || !dispatchResult,
          text: inlay.textContent,
          sent: sent
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      prevented?: boolean;
      text?: string;
      sent?: Array<{ type?: string; command?: string; args?: unknown[] }>;
    };
    assert.strictEqual(parsed.err, undefined, `expected preview metadata inlay to render: ${raw}`);
    assert.strictEqual(parsed.text, 'usages 2', `expected preview inlay label: ${raw}`);
    assert.strictEqual(parsed.prevented, true, `preview metadata inlay click should be consumed: ${raw}`);
    assert.ok(
      parsed.sent?.some((msg) =>
        msg.type === 'runCommand' &&
        msg.command === 'intellijStyledSearch.showUsagesForSymbol' &&
        msg.args?.[0] === 'python:preview-metadata-inlay.py:PreviewMetadataSymbol:1' &&
        msg.args?.[1] === 'PreviewMetadataSymbol'),
      `preview metadata inlay click should dispatch direct symbol command: ${raw}`,
    );
    assert.ok(
      !parsed.sent?.some((msg) => msg.type === 'runCommand' && msg.command === 'intellijStyledSearch.activateCallGraphInlayAtVisibleLine'),
      `preview metadata inlay click should not fall back to visible-line registry lookup: ${raw}`,
    );
  });

  test('search restart keeps the current preview visible until replacement arrives', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewRestartPreserveHost', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewRestartPreserveHost';
        });
        if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
        var targetSrc = root.getAttribute('data-ij-find-src') || '';
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        window.__ijFindDisableMonacoProbes = true;
        window.__ijFindOnMessage({
          type: 'preview',
          __targetSrc: targetSrc,
          uri: 'file:///preview-restart-preserve.py',
          relPath: 'preview-restart-preserve.py',
          languageId: 'python',
          focusLine: 0,
          previewSeq: 11,
          fullFile: true,
          lines: [
            { lineNumber: 0, text: 'class PreviewRestartPreserve:' },
            { lineNumber: 1, text: '    pass' }
          ]
        });
        var beforeState = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(targetSrc) : {};
        var beforeText = root.querySelector('.ij-find-preview-body')?.textContent || '';
        window.__ijFindOnMessage({ type: 'results:start', __targetSrc: targetSrc, searchId: 1201 });
        var afterState = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(targetSrc) : {};
        var afterText = root.querySelector('.ij-find-preview-body')?.textContent || '';
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        return JSON.stringify({
          before: { mode: beforeState.previewMode, uri: beforeState.previewUri, text: beforeText },
          after: { mode: afterState.previewMode, uri: afterState.previewUri, text: afterText }
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      before?: { mode?: string; uri?: string; text?: string };
      after?: { mode?: string; uri?: string; text?: string };
    };
    assert.strictEqual(parsed.err, undefined, `expected restart preserve probe to run: ${raw}`);
    assert.strictEqual(parsed.before?.mode, 'dom', `preview should render before search restart: ${raw}`);
    assert.strictEqual(parsed.after?.mode, 'dom', `results:start should not clear preview mode: ${raw}`);
    assert.strictEqual(parsed.after?.uri, 'file:///preview-restart-preserve.py', `results:start should keep preview URI: ${raw}`);
    assert.ok(parsed.after?.text?.includes('PreviewRestartPreserve'), `results:start should keep preview contents: ${raw}`);
  });

  test('async preview inlays render and survive same-preview refresh', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewAsyncInlayRefreshHost', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewAsyncInlayRefreshHost';
        });
        if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
        var targetSrc = root.getAttribute('data-ij-find-src') || '';
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        window.__ijFindDisableMonacoProbes = true;
        var previewMsg = {
          type: 'preview',
          __targetSrc: targetSrc,
          uri: 'file:///preview-async-inlay-refresh.py',
          relPath: 'preview-async-inlay-refresh.py',
          languageId: 'python',
          focusLine: 0,
          previewSeq: 21,
          fullFile: true,
          lines: [
            { lineNumber: 0, text: 'class PreviewAsyncInlayRefresh:' },
            { lineNumber: 1, text: '    pass' }
          ]
        };
        window.__ijFindOnMessage(previewMsg);
        var beforeInlays = root.querySelectorAll('.ij-find-preview-inlay.ijss-callgraph').length;
        window.__ijFindOnMessage({
          type: 'preview:inlays',
          __targetSrc: targetSrc,
          uri: previewMsg.uri,
          previewSeq: previewMsg.previewSeq,
          callGraphInlays: [{
            line: 0,
            column: 31,
            kind: 'usages',
            text: 'usages 3',
            symbolId: 'python:preview-async-inlay-refresh.py:PreviewAsyncInlayRefresh:1',
            label: 'PreviewAsyncInlayRefresh'
          }]
        });
        var afterInlayMsg = root.querySelectorAll('.ij-find-preview-inlay.ijss-callgraph').length;
        window.__ijFindOnMessage(Object.assign({}, previewMsg));
        var afterRefresh = root.querySelectorAll('.ij-find-preview-inlay.ijss-callgraph').length;
        var text = root.querySelector('.ij-find-preview-body')?.textContent || '';
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        return JSON.stringify({
          beforeInlays: beforeInlays,
          afterInlayMsg: afterInlayMsg,
          afterRefresh: afterRefresh,
          text: text
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      beforeInlays?: number;
      afterInlayMsg?: number;
      afterRefresh?: number;
      text?: string;
    };
    assert.strictEqual(parsed.err, undefined, `expected async inlay refresh probe to run: ${raw}`);
    assert.strictEqual(parsed.beforeInlays, 0, `initial preview body should start without metadata inlays: ${raw}`);
    assert.strictEqual(parsed.afterInlayMsg, 1, `preview:inlays should render into the current preview: ${raw}`);
    assert.strictEqual(parsed.afterRefresh, 1, `same-preview refresh should preserve async inlays: ${raw}`);
    assert.ok(parsed.text?.includes('usages 3'), `preview body should contain async inlay text: ${raw}`);
  });

  test('Monaco preview call graph inlays survive call graph result header refresh', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(25_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder.uri, 'alpha.py');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorDisableMonacoCapture = cfg.inspect<boolean>('disableMonacoCapture');
    await cfg.update('disableMonacoCapture', false, vscode.ConfigurationTarget.Workspace);
    overlay.resumeMonacoCaptureForTests();
    await vscode.window.showTextDocument(activeFixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await overlay.show('PreviewMonacoInlayPreserveHost', { forceLiteral: true, suppressSearch: true });

    try {
      const anyOverlay = overlay as unknown as {
        ensureMonacoCapture?: (windowId?: number, forceOpenUri?: vscode.Uri, options?: { reason?: string; allowForceOpen?: boolean }) => Promise<void>;
        activeWindowId?: number;
      };
      try {
        await anyOverlay.ensureMonacoCapture?.(anyOverlay.activeWindowId, undefined, {
          reason: 'monaco-preview-inlay-preserve-test',
          allowForceOpen: false,
        });
      } catch {}
      let monacoReady = await overlay.waitForMonacoReadyForTests(6_000);
      if (!monacoReady) {
        const forced = await overlay.evalInActiveWindowForTests(
          `(function(){
            try { if (typeof window.__ijFindTestCreateWidget === 'function') { window.__ijFindTestCreateWidget(); } } catch (e) {}
            return window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status';
          })()`,
        );
        monacoReady = /^ready/.test(forced) || await overlay.waitForMonacoReadyForTests(4_000);
      }
      assert.ok(monacoReady, 'expected Monaco factory to be ready for preview inlay test');

      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewMonacoInlayPreserveHost';
          });
          if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
          var targetSrc = root.getAttribute('data-ij-find-src') || '';
          var oldBridge = globalThis.irSearchEvent;
          var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
          var sent = [];
          globalThis.irSearchEvent = function (payload) {
            try { sent.push(JSON.parse(String(payload))); } catch (e) {}
          };
          window.__ijFindDisableMonacoProbes = false;
          var stateBefore = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(targetSrc) : {};
          var previewSeq = Math.max(Date.now(), (stateBefore && stateBefore.activePreviewSeq || 0) + 1);
          window.__ijFindOnMessage({
            type: 'preview',
            __targetSrc: targetSrc,
            uri: 'file:///preview-monaco-metadata-inlay.py',
            relPath: 'preview-monaco-metadata-inlay.py',
            languageId: 'python',
            focusLine: 0,
            previewSeq: previewSeq,
            baseLine: 0,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'class PreviewMonacoMetadataSymbol:' },
              { lineNumber: 1, text: '    pass' }
            ],
            callGraphInlays: [{
              line: 0,
              column: 34,
              kind: 'usages',
              text: 'usages 2',
              symbolId: 'python:preview-monaco-metadata-inlay.py:PreviewMonacoMetadataSymbol:1',
              label: 'PreviewMonacoMetadataSymbol'
            }]
          });
          var initial = {};
          var started = Date.now();
          while (Date.now() - started < 2000) {
            var state = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(targetSrc) : {};
            var body = root.querySelector('.ij-find-preview-body');
            initial = {
              mode: state && state.previewMode,
              uri: state && state.previewUri,
              host: !!(body && body.querySelector('.ij-find-monaco-preview-host .monaco-editor')),
              inlayCount: body ? body.querySelectorAll('.ij-find-preview-inlay.ijss-callgraph').length : -1,
              text: body ? body.textContent : ''
            };
            if (initial.mode === 'monaco' && initial.host && initial.inlayCount > 0) { break; }
            await new Promise(function (resolve) { setTimeout(resolve, 50); });
          }
          window.__ijFindShow('Find Usages [call graph cache-index]: PreviewMonacoMetadataSymbol', {
            forceLiteral: true,
            suppressSearch: true,
            preservePreview: true,
            __targetSrc: targetSrc
          });
          await new Promise(function (resolve) { setTimeout(resolve, 80); });
          var afterState = window.__ijFindGetSearchState ? window.__ijFindGetSearchState(targetSrc) : {};
          var afterBody = root.querySelector('.ij-find-preview-body');
          var inlay = afterBody && afterBody.querySelector('.ij-find-preview-inlay.ijss-callgraph');
          var clickPrevented = false;
          if (inlay) {
            var rect = inlay.getBoundingClientRect();
            var ev = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: rect.left + 2,
              clientY: rect.top + 2
            });
            var dispatchResult = inlay.dispatchEvent(ev);
            clickPrevented = ev.defaultPrevented || !dispatchResult;
          }
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
          return JSON.stringify({
            initial: initial,
            after: {
              mode: afterState && afterState.previewMode,
              uri: afterState && afterState.previewUri,
              host: !!(afterBody && afterBody.querySelector('.ij-find-monaco-preview-host .monaco-editor')),
              inlayCount: afterBody ? afterBody.querySelectorAll('.ij-find-preview-inlay.ijss-callgraph').length : -1,
              text: afterBody ? afterBody.textContent : ''
            },
            clickPrevented: clickPrevented,
            sent: sent
          });
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        err?: string;
        initial?: { mode?: string; uri?: string; host?: boolean; inlayCount?: number; text?: string };
        after?: { mode?: string; uri?: string; host?: boolean; inlayCount?: number; text?: string };
        clickPrevented?: boolean;
        sent?: Array<{ type?: string; command?: string; args?: unknown[] }>;
      };
      assert.strictEqual(parsed.err, undefined, `expected Monaco preview inlay probe to run: ${raw}`);
      assert.strictEqual(parsed.initial?.mode, 'monaco', `preview should render through Monaco: ${raw}`);
      assert.strictEqual(parsed.initial?.host, true, `Monaco preview host should mount: ${raw}`);
      assert.ok((parsed.initial?.inlayCount ?? 0) > 0, `Monaco preview should render call graph metadata inlays: ${raw}`);
      assert.strictEqual(parsed.after?.mode, 'monaco', `call graph header refresh should preserve preview mode: ${raw}`);
      assert.strictEqual(parsed.after?.uri, 'file:///preview-monaco-metadata-inlay.py', `call graph header refresh should preserve preview URI: ${raw}`);
      assert.strictEqual(parsed.after?.host, true, `call graph header refresh should keep Monaco preview mounted: ${raw}`);
      assert.ok((parsed.after?.inlayCount ?? 0) > 0, `call graph header refresh should keep preview inlays mounted: ${raw}`);
      assert.strictEqual(parsed.clickPrevented, true, `Monaco preview metadata inlay click should be consumed: ${raw}`);
      assert.ok(
        parsed.sent?.some((msg) =>
          msg.type === 'runCommand' &&
          msg.command === 'intellijStyledSearch.showUsagesForSymbol' &&
          msg.args?.[0] === 'python:preview-monaco-metadata-inlay.py:PreviewMonacoMetadataSymbol:1' &&
          msg.args?.[1] === 'PreviewMonacoMetadataSymbol'),
        `Monaco preview metadata inlay click should dispatch direct symbol command: ${raw}`,
      );
    } finally {
      await cfg.update('disableMonacoCapture', priorDisableMonacoCapture?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('DOM preview inlay clicks respond within one event loop turn after fallback rendering', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    await overlay.show('PreviewMetadataInlayFastHost', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewMetadataInlayFastHost';
        });
        if (!root) { return JSON.stringify({ err: 'missing overlay root' }); }
        var targetSrc = root.getAttribute('data-ij-find-src') || '';
        var oldBridge = globalThis.irSearchEvent;
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        var sent = [];
        var timings = [];
        globalThis.irSearchEvent = function (payload) {
          try { sent.push(JSON.parse(String(payload))); } catch (e) {}
        };
        window.__ijFindDisableMonacoProbes = true;
        window.__ijFindOnMessage({
          type: 'preview',
          __targetSrc: targetSrc,
          uri: 'file:///preview-fast-inlay.py',
          relPath: 'preview-fast-inlay.py',
          languageId: 'python',
          focusLine: 1,
          fullFile: true,
          lines: [
            { lineNumber: 0, text: 'class PreviewFastSymbol:' },
            { lineNumber: 1, text: '    def run(self):' },
            { lineNumber: 2, text: '        return 1' }
          ],
          callGraphInlays: [{
            line: 1,
            column: 18,
            kind: 'usages',
            text: 'usages 4',
            symbolId: 'python:preview-fast-inlay.py:PreviewFastSymbol.run:2',
            label: 'PreviewFastSymbol.run'
          }]
        });
        var inlay = root.querySelector('[data-ijss-callgraph-symbol-id]');
        if (!inlay) {
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
          return JSON.stringify({ err: 'missing preview inlay', html: root.querySelector('.ij-find-preview-body')?.innerHTML || '' });
        }
        var rect = inlay.getBoundingClientRect();
        for (var i = 0; i < 4; i++) {
          var before = sent.length;
          var started = performance.now();
          var ev = new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: rect.left + 3,
            clientY: rect.top + 3
          });
          var dispatchResult = inlay.dispatchEvent(ev);
          timings.push({
            elapsedMs: Math.round(performance.now() - started),
            prevented: ev.defaultPrevented || !dispatchResult,
            before: before,
            after: sent.length
          });
        }
        globalThis.irSearchEvent = oldBridge;
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        return JSON.stringify({ timings: timings, sent: sent });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      timings?: Array<{ elapsedMs: number; prevented: boolean; before: number; after: number }>;
      sent?: Array<{ type?: string; command?: string; args?: unknown[] }>;
    };
    assert.strictEqual(parsed.err, undefined, `expected fast preview inlay probe to run: ${raw}`);
    assert.strictEqual(parsed.timings?.length, 4, `expected four inlay click timings: ${raw}`);
    for (const [index, timing] of (parsed.timings ?? []).entries()) {
      assert.strictEqual(timing.prevented, true, `preview inlay click ${index} should be consumed: ${raw}`);
      assert.strictEqual(timing.after, timing.before + 1, `preview inlay click ${index} should synchronously send one command: ${raw}`);
      assert.ok(timing.elapsedMs <= 10, `preview inlay click ${index} should respond within one event loop turn: ${raw}`);
    }
    const commands = (parsed.sent ?? []).filter((msg) =>
      msg.type === 'runCommand' &&
      msg.command === 'intellijStyledSearch.showUsagesForSymbol' &&
      msg.args?.[0] === 'python:preview-fast-inlay.py:PreviewFastSymbol.run:2');
    assert.strictEqual(commands.length, 4, `every preview inlay click should dispatch a direct symbol command: ${raw}`);
  });

  test('preview inlay clicks expose a pending result header before call graph results resolve', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(30_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const { overlay } = api;
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const fixture = vscode.Uri.joinPath(folder!.uri, 'inlay_pending_header_fixture.py');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorCallGraphInlayHints = cfg.inspect<boolean>('callGraphInlayHints');
    try {
      await cfg.update('callGraphInlayHints', true, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(fixture, Buffer.from(buildInlayClickLoadFixture(), 'utf8'));
      const document = await vscode.workspace.openTextDocument(fixture);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      });
      await api.callGraph.rebuild(undefined, undefined, { force: true });
      const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        fixture,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
      );
      const usageHints = (hints ?? []).filter((hint) => {
        const parts = Array.isArray(hint.label) ? hint.label : [];
        return parts.some((part) => /^usages \d+$/.test(part.value));
      }).sort((a, b) => a.position.line - b.position.line);
      assert.ok(usageHints.length > 0, 'expected at least one usage inlay for pending-header probe');
      const usageHint = usageHints[0]!;

      await overlay.show('PreviewInlayPendingHeaderHost', { forceLiteral: true, suppressSearch: true });
      const hostSrc = await overlay.evalInActiveWindowForTests(
        `(function(){
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewInlayPendingHeaderHost';
          });
          if (!root) { return ''; }
          var hostSrc = root.getAttribute('data-ij-find-src') || '';
          Array.from(document.querySelectorAll('.ij-find-overlay.visible')).forEach(function (panel) {
            if ((panel.getAttribute('data-ij-find-src') || '') === hostSrc) { return; }
            var close = panel.querySelector('.ij-find-close');
            if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
          });
          return hostSrc;
        })()`,
      );
      assert.ok(hostSrc, 'expected pending-header host panel to expose a renderer src');

      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(usageHint.position, usageHint.position),
      });
      await vscode.commands.executeCommand('revealLine', {
        lineNumber: usageHint.position.line,
        at: 'top',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'expected active editor for pending-header inlay resolution');
      assert.strictEqual(editor.document.uri.toString(), fixture.toString(), 'expected pending-header fixture to stay active');
      const lineOrdinal = visibleLineOrdinalForEditorLine(editor, usageHint.position.line);
      assert.notStrictEqual(lineOrdinal, undefined, `expected inlay line ${usageHint.position.line} to be visible`);

      const raw = await overlay.evalInActiveWindowForTests(
        `(async function(){
          var hostSrc = ${JSON.stringify(hostSrc)};
          var host = document.querySelector('.ij-find-overlay.visible[data-ij-find-src="' + hostSrc + '"]');
          var body = host ? host.querySelector('.ij-find-preview-body') : null;
          if (!body) { return JSON.stringify({ err: 'missing preview body' }); }
          var beforeCount = document.querySelectorAll('.ij-find-overlay.visible').length;
          var editor = document.createElement('div');
          editor.className = 'monaco-editor';
          editor.style.cssText = 'position:absolute;left:16px;top:16px;width:320px;height:160px;z-index:2;';
          var nativeEdit = document.createElement('div');
          nativeEdit.className = 'native-edit-context';
          nativeEdit.tabIndex = 0;
          editor.appendChild(nativeEdit);
          var lines = document.createElement('div');
          lines.className = 'view-lines';
          var hint = null;
          var targetOrdinal = ${lineOrdinal};
          for (var i = 0; i <= targetOrdinal; i++) {
            var line = document.createElement('div');
            line.className = 'view-line';
            line.style.cssText = 'height:20px;';
            if (i === targetOrdinal) {
              hint = document.createElement('span');
              hint.className = 'inline-hints-widget ijss-callgraph';
              hint.textContent = 'usages 1';
              hint.style.cssText = 'display:inline-block;padding:2px 4px;';
              line.appendChild(hint);
            } else {
              line.textContent = 'preview line ' + i;
            }
            lines.appendChild(line);
          }
          editor.appendChild(lines);
          body.appendChild(editor);
          nativeEdit.focus();
          var spawnSelection = window.__ijFindShouldSpawnSearchSelection ? window.__ijFindShouldSpawnSearchSelection() : '';
          if (!hint) {
            editor.remove();
            return JSON.stringify({ err: 'missing synthetic hint', spawnSelection: spawnSelection });
          }
          var started = performance.now();
          var dispatchInfo = { prevented: false, dispatchResult: true };
          var result = await new Promise(function (resolve) {
            var done = false;
            var timer = null;
            var interval = null;
            var observer = null;
            function snapshot() {
              return Array.from(document.querySelectorAll('.ij-find-overlay.visible')).map(function (root) {
                var query = root.querySelector('.ij-find-query');
                return {
                  src: root.getAttribute('data-ij-find-src') || '',
                  query: query ? query.value : ''
                };
              });
            }
            function finish(reason, firstPanel) {
              if (done) { return; }
              done = true;
              if (timer) { clearTimeout(timer); }
              if (interval) { clearInterval(interval); }
              if (observer) { observer.disconnect(); }
              resolve({
                reason: reason,
                elapsedMs: Math.round(performance.now() - started),
                beforeCount: beforeCount,
                afterCount: snapshot().length,
                firstPanel: firstPanel || null,
                panels: snapshot()
              });
            }
            function check() {
              var panels = snapshot();
              var first = panels.find(function (panel) {
                return panel.src !== hostSrc && panel.query;
              });
              if (first) { finish('first-extra-header', first); }
            }
            observer = new MutationObserver(check);
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'value'] });
            interval = setInterval(check, 5);
            timer = setTimeout(function () { finish('timeout', null); }, 800);
            var rect = hint.getBoundingClientRect();
            var ev = new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: rect.left + 2,
              clientY: rect.top + 2
            });
            var dispatchResult = hint.dispatchEvent(ev);
            dispatchInfo = { prevented: ev.defaultPrevented || !dispatchResult, dispatchResult: dispatchResult };
            if (!dispatchInfo.prevented) { check(); }
          });
          editor.remove();
          result.spawnSelection = spawnSelection;
          result.dispatchInfo = dispatchInfo;
          return JSON.stringify(result);
        })()`,
      );
      const parsed = JSON.parse(raw) as {
        err?: string;
        reason?: string;
        elapsedMs?: number;
        beforeCount?: number;
        afterCount?: number;
        spawnSelection?: string;
        firstPanel?: { query: string; src: string } | null;
        dispatchInfo?: { prevented: boolean; dispatchResult: boolean };
      };
      assert.strictEqual(parsed.err, undefined, `expected pending-header inlay probe to run: ${raw}`);
      assert.strictEqual(parsed.spawnSelection, 'preview', `preview inlay focus should use spawned panel context: ${raw}`);
      assert.strictEqual(parsed.dispatchInfo?.prevented, true, `preview inlay click should be consumed: ${raw}`);
      assert.strictEqual(parsed.reason, 'first-extra-header', `preview inlay click should expose a result header before final results: ${raw}`);
      assert.strictEqual(
        parsed.afterCount,
        (parsed.beforeCount ?? 0) + 1,
        `preview inlay click should create one spawned result panel: ${raw}`,
      );
      assert.ok(
        parsed.firstPanel?.query.startsWith('Find Usages: '),
        `first spawned panel should show the pending Find Usages header, not wait for final results: ${raw}`,
      );
      assert.ok(
        !parsed.firstPanel?.query.includes('[call graph'),
        `first spawned panel should be the pending header before call graph source labeling: ${raw}`,
      );
      assert.ok(
        (parsed.elapsedMs ?? Number.POSITIVE_INFINITY) <= 75,
        `pending result header should appear promptly after preview inlay click: ${raw}`,
      );
    } finally {
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            return 'closed';
          })()`,
        );
      } catch {}
      await cfg.update('callGraphInlayHints', priorCallGraphInlayHints?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
      try { await vscode.workspace.fs.delete(fixture); } catch {}
      await restoreBackend();
    }
  });

  test('preview inlay clicks open spawned result panels within 75ms under repeated load', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(60_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const { overlay } = api;
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const fixture = vscode.Uri.joinPath(folder!.uri, 'inlay_click_load_fixture.py');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorCallGraphInlayHints = cfg.inspect<boolean>('callGraphInlayHints');
    try {
      await cfg.update('callGraphInlayHints', true, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(fixture, Buffer.from(buildInlayClickLoadFixture(), 'utf8'));
      const document = await vscode.workspace.openTextDocument(fixture);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      });
      await api.callGraph.rebuild(undefined, undefined, { force: true });
      const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        fixture,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
      );
      const usageHints = (hints ?? []).filter((hint) => {
        const parts = Array.isArray(hint.label) ? hint.label : [];
        return parts.some((part) => /^usages \d+$/.test(part.value));
      }).sort((a, b) => a.position.line - b.position.line);
      const loadHints = usageHints.slice(0, 8);
      assert.ok(loadHints.length >= 8, `expected at least 8 usage inlays for load, got ${usageHints.length}`);

      await overlay.show('PreviewInlaySpawnLoadHost', { forceLiteral: true, suppressSearch: true });
      const hostSrc = await overlay.evalInActiveWindowForTests(
        `(function(){
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewInlaySpawnLoadHost';
          });
          return root ? root.getAttribute('data-ij-find-src') || '' : '';
        })()`,
      );
      assert.ok(hostSrc, 'expected preview inlay load host panel to expose a renderer src');
      const timings: number[] = [];
      const warmupIterations = 3;
      const measuredIterations = loadHints.length;
      for (let i = 0; i < warmupIterations + measuredIterations; i++) {
        const usageHint = loadHints[i % loadHints.length]!;
        const measured = i >= warmupIterations;
        await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: false,
          viewColumn: vscode.ViewColumn.One,
          selection: new vscode.Range(usageHint.position, usageHint.position),
        });
        await vscode.commands.executeCommand('revealLine', {
          lineNumber: usageHint.position.line,
          at: 'top',
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'expected active editor for visible-line inlay resolution');
        assert.strictEqual(editor.document.uri.toString(), fixture.toString(), 'expected inlay load fixture to stay active');
        const lineOrdinal = visibleLineOrdinalForEditorLine(editor, usageHint.position.line);
        assert.notStrictEqual(lineOrdinal, undefined, `expected inlay line ${usageHint.position.line} to be visible`);
        const targetLineOrdinal = lineOrdinal!;
        const raw = await overlay.evalInActiveWindowForTests(
          `(async function(){
            var hostSrc = ${JSON.stringify(hostSrc)};
            var host = document.querySelector('.ij-find-overlay.visible[data-ij-find-src="' + hostSrc + '"]');
            var body = host ? host.querySelector('.ij-find-preview-body') : null;
            if (!body) { return JSON.stringify({ err: 'missing preview body' }); }
            var beforeCount = document.querySelectorAll('.ij-find-overlay.visible').length;
            var editor = document.createElement('div');
            editor.className = 'monaco-editor';
            editor.style.cssText = 'position:absolute;left:16px;top:16px;width:320px;height:160px;z-index:2;';
            var nativeEdit = document.createElement('div');
            nativeEdit.className = 'native-edit-context';
            nativeEdit.tabIndex = 0;
            editor.appendChild(nativeEdit);
            var lines = document.createElement('div');
            lines.className = 'view-lines';
            var hint = null;
            var targetOrdinal = ${targetLineOrdinal};
            for (var i = 0; i <= targetOrdinal; i++) {
              var line = document.createElement('div');
              line.className = 'view-line';
              line.style.cssText = 'height:20px;';
              if (i === targetOrdinal) {
                hint = document.createElement('span');
                hint.className = 'inline-hints-widget ijss-callgraph';
                hint.textContent = 'usages 1';
                hint.style.cssText = 'display:inline-block;padding:2px 4px;';
                line.appendChild(hint);
              } else {
                line.textContent = 'preview line ' + i;
              }
              lines.appendChild(line);
            }
            editor.appendChild(lines);
            body.appendChild(editor);
            nativeEdit.focus();
            var spawnSelection = window.__ijFindShouldSpawnSearchSelection ? window.__ijFindShouldSpawnSearchSelection() : '';
            if (!hint) {
              editor.remove();
              return JSON.stringify({ err: 'missing synthetic hint', spawnSelection: spawnSelection });
            }
            var started = performance.now();
            var result = await new Promise(function (resolve) {
              var done = false;
              var timer = null;
              var interval = null;
              var observer = null;
              function snapshot() {
                var roots = Array.from(document.querySelectorAll('.ij-find-overlay.visible'));
                return roots.map(function (root) {
                  var query = root.querySelector('.ij-find-query');
                  return {
                    src: root.getAttribute('data-ij-find-src') || '',
                    detached: root.classList.contains('ij-find-detached'),
                    query: query ? query.value : ''
                  };
                });
              }
              function finish(reason) {
                if (done) { return; }
                done = true;
                if (timer) { clearTimeout(timer); }
                if (interval) { clearInterval(interval); }
                if (observer) { observer.disconnect(); }
                var elapsedMs = Math.round(performance.now() - started);
                setTimeout(function () {
                  var infos = snapshot();
                  resolve({
                    reason: reason,
                    elapsedMs: elapsedMs,
                    beforeCount: beforeCount,
                    afterCount: infos.length,
                    panels: infos
                  });
                }, 120);
              }
              function check() {
                var infos = snapshot();
                if (infos.length > beforeCount) { finish('spawned'); }
              }
              observer = new MutationObserver(check);
              observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
              interval = setInterval(check, 5);
              timer = setTimeout(function () { finish('timeout'); }, 500);
              var rect = hint.getBoundingClientRect();
              var ev = new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: rect.left + 2,
                clientY: rect.top + 2
              });
              var dispatchResult = hint.dispatchEvent(ev);
              if (!ev.defaultPrevented && dispatchResult) { check(); }
            });
            editor.remove();
            result.spawnSelection = spawnSelection;
            return JSON.stringify(result);
          })()`,
        );
        const parsed = JSON.parse(raw) as {
          err?: string;
          reason?: string;
          elapsedMs?: number;
          beforeCount?: number;
          afterCount?: number;
          spawnSelection?: string;
          panels?: Array<{ query: string; detached: boolean; src: string }>;
        };
        assert.strictEqual(parsed.err, undefined, `expected preview inlay spawn probe to run: ${raw}`);
        assert.strictEqual(parsed.spawnSelection, 'preview', `preview inlay focus should use spawned panel context: ${raw}`);
        assert.strictEqual(parsed.reason, 'spawned', `preview inlay click should spawn a search panel on iteration ${i}: ${raw}`);
        assert.strictEqual(
          parsed.afterCount,
          (parsed.beforeCount ?? 0) + 1,
          `preview inlay click should create exactly one additional visible search panel on iteration ${i}: ${raw}`,
        );
        if (measured) {
          timings.push(parsed.elapsedMs ?? Number.POSITIVE_INFINITY);
        }
        const cleanupRaw = await overlay.evalInActiveWindowForTests(
          `(async function(){
            var hostSrc = ${JSON.stringify(hostSrc)};
            function roots() {
              return Array.from(document.querySelectorAll('.ij-find-overlay.visible'));
            }
            function closeExtras() {
              roots().forEach(function (root) {
                if ((root.getAttribute('data-ij-find-src') || '') === hostSrc) { return; }
                var close = root.querySelector('.ij-find-close');
                if (close) { close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
              });
            }
            return await new Promise(function (resolve) {
              var started = performance.now();
              function check() {
                closeExtras();
                var visible = roots();
                var extras = visible.filter(function (root) {
                  return (root.getAttribute('data-ij-find-src') || '') !== hostSrc;
                });
                if (extras.length === 0 || performance.now() - started >= 1000) {
                  resolve(JSON.stringify({ visibleCount: visible.length, extraCount: extras.length }));
                  return;
                }
                setTimeout(check, 10);
              }
              check();
            });
          })()`,
        );
        const cleanup = JSON.parse(cleanupRaw) as { visibleCount: number; extraCount: number };
        assert.strictEqual(cleanup.extraCount, 0, `expected spawned panels to close between load iterations: ${cleanupRaw}`);
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      assert.strictEqual(timings.length, measuredIterations, 'expected every measured preview inlay load iteration to record timing');
      assertTimingsWithin('preview inlay spawned panel latency', timings, 75);
    } finally {
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            Array.from(document.querySelectorAll('.ij-find-overlay.visible .ij-find-close')).forEach(function (btn) {
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            return 'closed';
          })()`,
        );
      } catch {}
      await cfg.update('callGraphInlayHints', priorCallGraphInlayHints?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
      try { await vscode.workspace.fs.delete(fixture); } catch {}
      await restoreBackend();
    }
  });

  test('full-file call graph inlays surface within 200ms for a 10k-line file under repeated load', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(120_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const fixture = vscode.Uri.joinPath(folder!.uri, 'inlay_10k_perf_fixture.py');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const editorCfg = vscode.workspace.getConfiguration('editor');
    const priorCallGraphInlayHints = cfg.inspect<boolean>('callGraphInlayHints');
    const priorEditorInlayHints = editorCfg.inspect<string>('inlayHints.enabled');
    try {
      await cfg.update('callGraphInlayHints', true, vscode.ConfigurationTarget.Workspace);
      await editorCfg.update('inlayHints.enabled', 'on', vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(fixture, Buffer.from(buildTenThousandLineInlayFixture(), 'utf8'));
      const document = await vscode.workspace.openTextDocument(fixture);
      assert.strictEqual(document.lineCount, 10_000, 'expected generated fixture to contain 10k lines');
      await api.callGraph.rebuild(undefined, undefined, { force: true });
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      });
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
      );
      const timings: number[] = [];
      const revealLines = [0, 2_000, 4_000, 6_000, 8_000];
      let expectedUsageHintCount: number | undefined;
      for (let i = 0; i < revealLines.length; i++) {
        let activeEditor = vscode.window.activeTextEditor;
        let visibleOrdinal: number | undefined;
        const revealDeadline = Date.now() + 1_500;
        while (Date.now() < revealDeadline) {
          await vscode.commands.executeCommand('revealLine', { lineNumber: revealLines[i], at: 'top' });
          activeEditor = vscode.window.activeTextEditor;
          if (activeEditor?.document.uri.toString() === fixture.toString()) {
            activeEditor.revealRange(
              new vscode.Range(new vscode.Position(revealLines[i], 0), new vscode.Position(revealLines[i], 0)),
              vscode.TextEditorRevealType.AtTop,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeEditor = vscode.window.activeTextEditor;
          if (activeEditor?.document.uri.toString() === fixture.toString()) {
            visibleOrdinal = visibleLineOrdinalForEditorLine(activeEditor, revealLines[i]);
            if (visibleOrdinal !== undefined) { break; }
          }
        }
        assert.ok(activeEditor, 'expected active editor for 10k inlay load');
        assert.strictEqual(activeEditor.document.uri.toString(), fixture.toString(), 'expected 10k fixture to stay active');
        assert.notStrictEqual(
          visibleOrdinal,
          undefined,
          `expected reveal line ${revealLines[i]} to be visible before requesting inlays`,
        );
        const started = Date.now();
        const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
          'vscode.executeInlayHintProvider',
          fixture,
          fullRange,
        );
        const usageHints = (hints ?? []).filter((hint) => {
          const labels = Array.isArray(hint.label)
            ? hint.label.map((part) => part.value).join(' ')
            : String(hint.label ?? '');
          return /\busages\s+\d+\b/.test(labels);
        });
        const elapsedMs = Date.now() - started;
        timings.push(elapsedMs);
        if (expectedUsageHintCount === undefined) {
          expectedUsageHintCount = usageHints.length;
          assert.ok(expectedUsageHintCount >= 500, `expected a high-load full-file inlay set, got ${expectedUsageHintCount}`);
        } else {
          assert.strictEqual(
            usageHints.length,
            expectedUsageHintCount,
            `expected repeated full-file inlay rounds to return the complete same set; round=${i}`,
          );
        }
      }
      assertTimingsWithin('10k-line full-file inlay provider latency', timings, 200);
    } finally {
      await editorCfg.update('inlayHints.enabled', priorEditorInlayHints?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await cfg.update('callGraphInlayHints', priorCallGraphInlayHints?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
      try { await vscode.workspace.fs.delete(fixture); } catch {}
      await restoreBackend();
    }
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

  test('suppressed show clears stale preview state from the previous result', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();

    await overlay.show('PreviewResetSeed', { forceLiteral: true, suppressSearch: true });
    const seededRaw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        window.__ijFindDisableMonacoProbes = true;
        try {
          window.__ijFindOnMessage({
            type: 'preview',
            uri: alpha,
            relPath: 'alpha.py',
            languageId: 'python',
            focusLine: 0,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'class AlphaService:' },
              { lineNumber: 1, text: '    pass' }
            ],
            ranges: [{ start: 6, end: 18 }]
          });
          return JSON.stringify(window.__ijFindGetSearchState());
        } finally {
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        }
      })()`,
    );
    const seeded = JSON.parse(seededRaw) as { previewMode: string | null; previewUri: string | null };
    assert.strictEqual(seeded.previewMode, 'dom', `seed preview should create non-empty preview state: ${seededRaw}`);
    assert.strictEqual(seeded.previewUri, alphaUri, `seed preview should target alpha.py: ${seededRaw}`);

    await overlay.show('PreviewResetCleared', { forceLiteral: true, suppressSearch: true });
    const cleared = await probeRendererSearchState(overlay);
    assert.strictEqual(cleared.filesCount, 0, `suppressed show should clear result files: ${JSON.stringify(cleared)}`);
    assert.strictEqual(cleared.flatCount, 0, `suppressed show should clear flat results: ${JSON.stringify(cleared)}`);
    assert.strictEqual(cleared.previewMode, null, `suppressed show should clear stale previewMode: ${JSON.stringify(cleared)}`);
    assert.strictEqual(cleared.previewUri, null, `suppressed show should clear stale previewUri: ${JSON.stringify(cleared)}`);
    assert.strictEqual(cleared.lastPreviewKey, null, `suppressed show should clear stale preview key: ${JSON.stringify(cleared)}`);
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

  test('search result clicks switch the preview within 10ms under repeated load', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(15_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();
    const betaUri = vscode.Uri.joinPath(folder!.uri, 'beta.js').toString();

    await overlay.show('PreviewClickProbe', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(async function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var beta = ${JSON.stringify(betaUri)};
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        window.__ijFindDisableMonacoProbes = true;
        var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
          var query = node.querySelector('.ij-find-query');
          return query && query.value === 'PreviewClickProbe';
        }) || document.querySelector('.ij-find-overlay.visible');
        var targetSrc = root ? root.getAttribute('data-ij-find-src') || '' : '';
        var q = root ? root.querySelector('.ij-find-query') : document.querySelector('.ij-find-query');
        if (q) { q.value = ''; }
        if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(targetSrc); }
        window.__ijFindOnMessage({ type: 'results:start', searchId: 940, __targetSrc: targetSrc });
        var alphaMatches = [];
        var betaMatches = [];
        for (var i = 0; i < 16; i++) {
          alphaMatches.push({
            line: i,
            preview: 'class AlphaService load row ' + i,
            ranges: [{ start: 6, end: 18 }]
          });
          betaMatches.push({
            line: i,
            preview: 'class BetaWidget load row ' + i,
            ranges: [{ start: 6, end: 16 }]
          });
        }
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 940,
          __targetSrc: targetSrc,
          match: { uri: alpha, relPath: 'alpha.py', matches: alphaMatches }
        });
        window.__ijFindOnMessage({
          type: 'results:file',
          searchId: 940,
          __targetSrc: targetSrc,
          match: { uri: beta, relPath: 'beta.js', matches: betaMatches }
        });
        window.__ijFindOnMessage({ type: 'results:done', searchId: 940, totalFiles: 2, totalMatches: 32, truncated: false, __targetSrc: targetSrc });
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        globalThis.irSearchEvent = function (payload) {
          try {
            var msg = JSON.parse(String(payload));
            sent.push(msg);
          } catch (e) {}
        };
        var timings = [];
        var requestTimings = [];
        var renderTimings = [];
        for (var idx = 1; idx <= 16; idx++) {
          var row = document.querySelector('.ij-find-row[data-flat="' + idx + '"]');
          if (!row) {
            globalThis.irSearchEvent = oldBridge;
            window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
            return JSON.stringify({ err: 'missing result row ' + idx, state: window.__ijFindGetSearchState(), timings: timings });
          }
          sent.length = 0;
          var started = performance.now();
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
          var previewReq = sent.find(function (msg) { return msg.type === 'requestPreview' && (msg.uri === alpha || msg.uri === beta); });
          var requestAtMs = previewReq ? performance.now() - started : null;
          if (!previewReq) {
            timings.push({ idx: idx, requestAtMs: null, previewAtMs: null, uri: null });
            continue;
          }
          var uniquePreviewText = 'preview click load row ' + idx + ' ' + previewReq.uri;
          window.__ijFindOnMessage({
            type: 'preview',
            uri: previewReq.uri,
            __targetSrc: targetSrc,
            relPath: previewReq.uri === beta ? 'beta.js' : 'alpha.py',
            languageId: previewReq.uri === beta ? 'javascript' : 'python',
            focusLine: 3,
            fullFile: true,
            lines: [
              { lineNumber: 0, text: 'load preview header ' + idx },
              { lineNumber: 1, text: 'load preview filler ' + idx + ' a' },
              { lineNumber: 2, text: 'load preview filler ' + idx + ' b' },
              { lineNumber: 3, text: uniquePreviewText },
              { lineNumber: 40, text: 'load preview tail ' + idx }
            ],
            ranges: [{ start: 4, end: 11 }]
          });
          var previewAtMs = null;
          while (performance.now() - started <= 10) {
            var previewBody = root ? root.querySelector('.ij-find-preview-body') : document.querySelector('.ij-find-overlay.visible:not(.ij-find-detached) .ij-find-preview-body');
            var previewText = previewBody ? previewBody.textContent || '' : '';
            if (previewText.indexOf(uniquePreviewText) >= 0) {
              previewAtMs = performance.now() - started;
              break;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 1); });
          }
          timings.push({
            idx: idx,
            requestAtMs: requestAtMs === null ? null : Math.round(requestAtMs),
            previewAtMs: previewAtMs === null ? null : Math.round(previewAtMs),
            uri: previewReq.uri
          });
          if (requestAtMs !== null) { requestTimings.push(Math.round(requestAtMs)); }
          if (previewAtMs !== null) { renderTimings.push(Math.round(previewAtMs)); }
        }
        var state = window.__ijFindGetSearchState(targetSrc);
        globalThis.irSearchEvent = oldBridge;
        window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        return JSON.stringify({
          activeIndex: state.activeIndex,
          previewUri: state.previewUri,
          requestTimings: requestTimings,
          renderTimings: renderTimings,
          timings: timings
        });
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      err?: string;
      activeIndex: number;
      previewUri: string | null;
      requestTimings: number[];
      renderTimings: number[];
      timings: Array<{ idx: number; requestAtMs: number | null; previewAtMs: number | null; uri: string | null }>;
    };
    assert.strictEqual(parsed.err, undefined, `expected repeated search result rows: ${raw}`);
    assert.strictEqual(parsed.activeIndex, 16, `final click should select the final loaded row: ${raw}`);
    assert.ok(parsed.previewUri === alphaUri || parsed.previewUri === betaUri, `final click should switch preview to a fixture URI: ${raw}`);
    assert.strictEqual(parsed.requestTimings.length, 16, `expected every loaded click to request preview: ${raw}`);
    assert.strictEqual(parsed.renderTimings.length, 16, `expected every loaded click to render preview: ${raw}`);
    assertTimingsWithin('result click preview request latency', parsed.requestTimings, 10);
    assertTimingsWithin('result click preview render latency', parsed.renderTimings, 10);
  });

  test('rapid result clicks ignore stale out-of-order preview responses under load', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();
    const betaUri = vscode.Uri.joinPath(folder!.uri, 'beta.js').toString();

    await overlay.show('PreviewStaleStress', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var beta = ${JSON.stringify(betaUri)};
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        var failures = [];
        window.__ijFindDisableMonacoProbes = true;
        globalThis.irSearchEvent = function (payload) {
          try {
            var msg = JSON.parse(String(payload));
            if (msg.type === 'requestPreview') { sent.push(msg); }
          } catch (e) {}
        };
        try {
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewStaleStress';
          }) || document.querySelector('.ij-find-overlay.visible');
          var targetSrc = root ? root.getAttribute('data-ij-find-src') || '' : '';
          var q = root ? root.querySelector('.ij-find-query') : document.querySelector('.ij-find-query');
          if (q) { q.value = ''; }
          if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(targetSrc); }
          window.__ijFindOnMessage({ type: 'results:start', searchId: 941, __targetSrc: targetSrc });
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 941,
            __targetSrc: targetSrc,
            match: {
              uri: alpha,
              relPath: 'alpha.py',
              matches: [{ line: 0, preview: 'class AlphaService stale stress', ranges: [{ start: 6, end: 18 }] }]
            }
          });
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 941,
            __targetSrc: targetSrc,
            match: {
              uri: beta,
              relPath: 'beta.js',
              matches: [{ line: 0, preview: 'class BetaWidget latest stress', ranges: [{ start: 6, end: 16 }] }]
            }
          });
          window.__ijFindOnMessage({ type: 'results:done', searchId: 941, totalFiles: 2, totalMatches: 2, truncated: false, __targetSrc: targetSrc });
          function clickRow(flatIdx) {
            var row = root && root.querySelector('.ij-find-row[data-flat="' + flatIdx + '"]');
            if (!row) { return { err: 'missing row ' + flatIdx }; }
            sent.length = 0;
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            var req = sent.find(function (msg) { return msg.type === 'requestPreview'; });
            if (!req) { return { err: 'missing request ' + flatIdx }; }
            if (typeof req.previewSeq !== 'number') { return { err: 'missing previewSeq ' + flatIdx, req: req }; }
            return req;
          }
          function deliver(req, label, cycle) {
            window.__ijFindOnMessage({
              type: 'preview',
              __targetSrc: targetSrc,
              uri: req.uri,
              previewSeq: req.previewSeq,
              relPath: req.uri === beta ? 'beta.js' : 'alpha.py',
              languageId: req.uri === beta ? 'javascript' : 'python',
              focusLine: 0,
              fullFile: true,
              lines: [
                { lineNumber: 0, text: label + ' preview cycle ' + cycle + ' seq ' + req.previewSeq }
              ],
              ranges: [{ start: 0, end: 6 }]
            });
          }
          for (var cycle = 0; cycle < 40; cycle++) {
            var staleReq = clickRow(0);
            var latestReq = clickRow(1);
            if (staleReq.err || latestReq.err) {
              failures.push({ cycle: cycle, staleReq: staleReq, latestReq: latestReq });
              break;
            }
            deliver(latestReq, 'latest', cycle);
            deliver(staleReq, 'stale', cycle);
            var state = window.__ijFindGetSearchState(targetSrc);
            var body = root ? root.querySelector('.ij-find-preview-body') : null;
            var text = body ? body.textContent || '' : '';
            if (state.previewUri !== beta ||
                text.indexOf('latest preview cycle ' + cycle) < 0 ||
                text.indexOf('stale preview cycle ' + cycle) >= 0) {
              failures.push({
                cycle: cycle,
                state: state,
                text: text,
                staleSeq: staleReq.previewSeq,
                latestSeq: latestReq.previewSeq
              });
              break;
            }
          }
          var finalState = window.__ijFindGetSearchState(targetSrc);
          var close = root && root.querySelector('.ij-find-close');
          if (close) {
            close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return JSON.stringify({
            failures: failures,
            activeIndex: finalState.activeIndex,
            previewUri: finalState.previewUri,
            activePreviewSeq: finalState.activePreviewSeq
          });
        } finally {
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        }
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      failures: unknown[];
      activeIndex: number;
      previewUri: string | null;
      activePreviewSeq: number;
    };
    assert.deepStrictEqual(parsed.failures, [], `latest click should survive stale preview responses: ${raw}`);
    assert.strictEqual(parsed.activeIndex, 1, `final rapid click should leave beta row selected: ${raw}`);
    assert.strictEqual(parsed.previewUri, betaUri, `final preview should stay on latest clicked row: ${raw}`);
    assert.ok(parsed.activePreviewSeq >= 80, `stress loop should issue many preview requests: ${raw}`);
  });

  test('rapid back-and-forth result switching keeps the newest preview visible', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const alphaUri = vscode.Uri.joinPath(folder!.uri, 'alpha.py').toString();
    const betaUri = vscode.Uri.joinPath(folder!.uri, 'beta.js').toString();

    await overlay.show('PreviewBackAndForth', { forceLiteral: true, suppressSearch: true });
    const raw = await overlay.evalInActiveWindowForTests(
      `(async function(){
        var alpha = ${JSON.stringify(alphaUri)};
        var beta = ${JSON.stringify(betaUri)};
        var oldDisableMonacoProbes = window.__ijFindDisableMonacoProbes;
        var oldBridge = globalThis.irSearchEvent;
        var sent = [];
        var failures = [];
        window.__ijFindDisableMonacoProbes = true;
        globalThis.irSearchEvent = function (payload) {
          try {
            var msg = JSON.parse(String(payload));
            if (msg.type === 'requestPreview') { sent.push(msg); }
          } catch (e) {}
        };
        try {
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            var query = node.querySelector('.ij-find-query');
            return query && query.value === 'PreviewBackAndForth';
          }) || document.querySelector('.ij-find-overlay.visible');
          var targetSrc = root ? root.getAttribute('data-ij-find-src') || '' : '';
          var q = root ? root.querySelector('.ij-find-query') : document.querySelector('.ij-find-query');
          if (q) { q.value = ''; }
          if (window.__ijFindRefreshSearch) { window.__ijFindRefreshSearch(targetSrc); }
          window.__ijFindOnMessage({ type: 'results:start', searchId: 942, __targetSrc: targetSrc });
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 942,
            __targetSrc: targetSrc,
            match: {
              uri: alpha,
              relPath: 'alpha.py',
              matches: [{ line: 0, preview: 'class AlphaService back forth', ranges: [{ start: 6, end: 18 }] }]
            }
          });
          window.__ijFindOnMessage({
            type: 'results:file',
            searchId: 942,
            __targetSrc: targetSrc,
            match: {
              uri: beta,
              relPath: 'beta.js',
              matches: [{ line: 0, preview: 'class BetaWidget back forth', ranges: [{ start: 6, end: 16 }] }]
            }
          });
          window.__ijFindOnMessage({ type: 'results:done', searchId: 942, totalFiles: 2, totalMatches: 2, truncated: false, __targetSrc: targetSrc });
          function row(flatIdx) {
            return root && root.querySelector('.ij-find-row[data-flat="' + flatIdx + '"]');
          }
          function clickAndRequest(flatIdx) {
            var target = row(flatIdx);
            if (!target) { return { err: 'missing row ' + flatIdx }; }
            sent.length = 0;
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            var req = sent.find(function (msg) { return msg.type === 'requestPreview'; });
            if (!req) { return { err: 'missing preview request ' + flatIdx }; }
            return req;
          }
          function deliver(req, label, cycle) {
            window.__ijFindOnMessage({
              type: 'preview',
              __targetSrc: targetSrc,
              uri: req.uri,
              relPath: req.uri === beta ? 'beta.js' : 'alpha.py',
              languageId: req.uri === beta ? 'javascript' : 'python',
              focusLine: 0,
              fullFile: true,
              lines: [{ lineNumber: 0, text: label + ' newest preview cycle ' + cycle }],
              ranges: [{ start: 0, end: 6 }]
            });
          }
          var lastExpected = null;
          for (var cycle = 0; cycle < 60; cycle++) {
            var firstReq = clickAndRequest(1);
            var secondReq = clickAndRequest(0);
            if (firstReq.err || secondReq.err) {
              failures.push({ cycle: cycle, firstReq: firstReq, secondReq: secondReq });
              break;
            }
            lastExpected = secondReq.uri;
            deliver(secondReq, 'latest', cycle);
            deliver(firstReq, 'older', cycle);
            var state = window.__ijFindGetSearchState(targetSrc);
            var body = root ? root.querySelector('.ij-find-preview-body') : null;
            var text = body ? body.textContent || '' : '';
            if (state.previewUri !== lastExpected ||
                text.indexOf('latest newest preview cycle ' + cycle) < 0 ||
                text.indexOf('older newest preview cycle ' + cycle) >= 0) {
              failures.push({
                cycle: cycle,
                expectedUri: lastExpected,
                state: state,
                text: text
              });
              break;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
          }
          var finalState = window.__ijFindGetSearchState(targetSrc);
          var finalBody = root ? root.querySelector('.ij-find-preview-body') : null;
          var finalText = finalBody ? finalBody.textContent || '' : '';
          var close = root && root.querySelector('.ij-find-close');
          if (close) {
            close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return JSON.stringify({
            failures: failures,
            activeIndex: finalState.activeIndex,
            previewUri: finalState.previewUri,
            finalText: finalText,
            expectedUri: lastExpected
          });
        } finally {
          globalThis.irSearchEvent = oldBridge;
          window.__ijFindDisableMonacoProbes = oldDisableMonacoProbes;
        }
      })()`,
    );
    const parsed = JSON.parse(raw) as {
      failures: unknown[];
      activeIndex: number;
      previewUri: string | null;
      finalText: string;
      expectedUri: string | null;
    };
    assert.deepStrictEqual(parsed.failures, [], `rapid back-and-forth preview should keep newest content: ${raw}`);
    assert.strictEqual(parsed.previewUri, parsed.expectedUri, `final preview URI should match the final clicked row: ${raw}`);
    assert.ok(parsed.finalText.includes('latest newest preview cycle 59'), `final preview body should show the newest delivered preview: ${raw}`);
    assert.ok(!parsed.finalText.includes('older newest preview cycle 59'), `final preview body must not be overwritten by stale content: ${raw}`);
    assert.strictEqual(parsed.activeIndex, 0, `60 back-and-forth cycles should leave the final alpha row selected: ${raw}`);
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
