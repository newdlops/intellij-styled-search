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
      try { await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } catch {}
    }
  });

  test('DOM fallback preview recovers to Monaco for the same file after capture returns', async function () {
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
          var prewarmStatus = window.__ijFindPrewarmPreviewMonacoEditor
            ? window.__ijFindPrewarmPreviewMonacoEditor('test-dom-preview-recovery', targetSrc)
            : 'missing-prewarm-fn';
          await new Promise(function (resolve) { setTimeout(resolve, 32); });
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
          window.__ijFindOnMessage(Object.assign({}, msg));
          var recovered = null;
          var recoveredHost = false;
          var recoveryElapsedMs = null;
          var deadline = performance.now() + 100;
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
            prewarmStatus: prewarmStatus,
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
        prewarmStatus?: string;
        recoveryElapsedMs?: number | null;
        degraded?: { mode?: string; uri?: string; host?: boolean; hasText?: boolean };
        recovered?: { mode?: string; uri?: string; host?: boolean; modelUri?: string };
      };
      if (parsed.skipped) { this.skip(); return; }
      assert.strictEqual(parsed.err, undefined, `expected DOM recovery probe to run: ${raw}`);
      assert.ok(/^ready:/.test(parsed.prewarmStatus ?? ''), `expected target preview Monaco prewarm before recovery probe: ${raw}`);
      assert.strictEqual(parsed.degraded?.mode, 'dom', `preview should first degrade to DOM fallback: ${raw}`);
      assert.strictEqual(parsed.degraded?.uri, parsed.uri, `DOM fallback should keep the same preview URI: ${raw}`);
      assert.strictEqual(parsed.degraded?.host, false, `DOM fallback should not keep a Monaco host mounted: ${raw}`);
      assert.strictEqual(parsed.degraded?.hasText, true, `DOM fallback should render preview contents: ${raw}`);
      assert.strictEqual(parsed.recovered?.mode, 'monaco', `same preview should recover to Monaco mode: ${raw}`);
      assert.strictEqual(parsed.recovered?.uri, parsed.uri, `recovered Monaco preview should keep the same URI: ${raw}`);
      assert.strictEqual(parsed.recovered?.host, true, `recovered preview should mount a Monaco editor host: ${raw}`);
      assert.ok(
        typeof parsed.recoveryElapsedMs === 'number' && parsed.recoveryElapsedMs <= 100,
        `DOM fallback preview should recover to Monaco within 100ms after capture returns: ${raw}`,
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

  test('preview warmup does not open an extra tab or editor group for capture', async function () {
    if (!cdpAvailable) { this.skip(); return; }
    this.timeout(20_000);
    const { overlay } = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const activeFixture = vscode.Uri.joinPath(folder!.uri, 'alpha.py');
    const previewFixture = vscode.Uri.joinPath(folder!.uri, 'beta.js');
    await vscode.window.showTextDocument(activeFixture, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
    await overlay.show('PreviewNoCaptureColumnProbe', { forceLiteral: true, suppressSearch: true });

    const tabsBefore = snapshotTabCounts();
    const groupsBefore = snapshotTabGroupCount();
    const visibleBefore = visibleNonMemoryEditorUris();
    const activeBefore = vscode.window.activeTextEditor?.document.uri.toString();
    const src = `preview-no-capture-column-${Date.now()}`;

    try {
      await overlay.evalInActiveWindowForTests(
        `(function(){
          window.__ijFindMonaco = null;
          window.__ijFindDisableMonacoProbes = false;
          window.__ijFindCaptureFromDomOriginalForNoColumnTest = window.__ijFindCaptureFromDom;
          window.__ijFindCaptureFromDom = function(){ return 'test-dom-capture-disabled'; };
          return window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'no-status';
        })()`,
      );
      overlay.injectRendererEventForTests(JSON.stringify({
        type: 'requestPreview',
        uri: previewFixture.toString(),
        line: 0,
        contextLines: 0,
        ranges: [{ start: 0, end: 4 }],
        previewSeq: 991,
        __src: src,
        __seq: 1,
      }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.strictEqual(
        snapshotTabGroupCount(),
        groupsBefore,
        'preview warmup should not create an extra editor group/column for Monaco capture',
      );
      assertNoAddedTabs(tabsBefore, 'preview warmup capture');
      assert.deepStrictEqual(
        visibleNonMemoryEditorUris(),
        visibleBefore,
        'preview warmup should not introduce extra visible workbench editors',
      );
      assert.ok(
        !visibleEditorUris().includes(previewFixture.toString()),
        'preview warmup should not open the preview file in a workbench editor',
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        activeBefore,
        'preview warmup should keep the user active editor selected',
      );
    } finally {
      try {
        await overlay.evalInActiveWindowForTests(
          `(function(){
            if (window.__ijFindCaptureFromDomOriginalForNoColumnTest) {
              window.__ijFindCaptureFromDom = window.__ijFindCaptureFromDomOriginalForNoColumnTest;
              delete window.__ijFindCaptureFromDomOriginalForNoColumnTest;
            }
            return 'restored';
          })()`,
        );
      } catch {}
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

  test('preview inlay clicks open spawned result panels within 50ms under repeated load', async function () {
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
      assertTimingsWithin('preview inlay spawned panel latency', timings, 50);
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

  test('search result clicks switch the preview within 50ms under repeated load', async function () {
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
          while (performance.now() - started <= 50) {
            var previewBody = root ? root.querySelector('.ij-find-preview-body') : document.querySelector('.ij-find-overlay.visible:not(.ij-find-detached) .ij-find-preview-body');
            var previewText = previewBody ? previewBody.textContent || '' : '';
            if (previewText.indexOf(uniquePreviewText) >= 0) {
              previewAtMs = performance.now() - started;
              break;
            }
            await new Promise(function (resolve) { setTimeout(resolve, 5); });
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
    assertTimingsWithin('result click preview request latency', parsed.requestTimings, 50);
    assertTimingsWithin('result click preview render latency', parsed.renderTimings, 50);
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
