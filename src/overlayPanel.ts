import * as vscode from 'vscode';
import * as http from 'http';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { runSearch, SearchOptions, FileMatch, MatchRange, prioritizeFiles } from './search';
import { configureRipgrepInstall, ensureRipgrepInstalled, findRipgrepPath, runRgSearch } from './rgSearch';
import { getRendererPatchScript } from './rendererPatch';
import { TrigramIndex, extractTrigramsLower } from './trigramIndex';

type RendererEvent =
  | { type: 'search'; options: SearchOptions }
  | { type: 'cancel' }
  | { type: 'openFile'; uri: string; line: number; column: number }
  | { type: 'previewFile'; uri: string; line: number; column: number }
  | { type: 'requestPreview'; uri: string; line: number; ranges?: MatchRange[]; contextLines: number }
  | { type: 'openInSideEditor'; uri: string; line: number; column: number }
  | { type: 'pinInSideEditor'; uri: string; line: number; column: number }
  | { type: 'requestHover'; reqId: number; uri: string; line: number; column: number; x: number; y: number }
  | { type: 'runCommand'; command: string; args: unknown[] }
  | { type: 'saveFile'; uri: string; content: string }
  | { type: 'log'; msg: string };

type PreviewLine = { lineNumber: number; text: string };
type HoverContent = { value: string; isTrusted: boolean; allowedCommands?: readonly string[] };

type OverlayMessage =
  | { type: 'results:start' }
  | { type: 'results:candidates'; candidates: Array<{ uri: string; relPath: string }>; total: number }
  | { type: 'results:file'; match: FileMatch }
  | { type: 'results:done'; totalFiles: number; totalMatches: number; truncated: boolean }
  | { type: 'results:error'; message: string }
  | { type: 'preview'; uri: string; relPath: string; focusLine: number; ranges?: MatchRange[]; lines: PreviewLine[]; languageId: string }
  | { type: 'hover'; reqId: number; uri: string; line: number; column: number; x: number; y: number; contents: HoverContent[] };

const BRIDGE_BINDING = 'irSearchMainBridge';
const RENDERER_BINDING = 'irSearchEvent';

export class OverlayPanel {
  private static instance: OverlayPanel | undefined;
  private ws: WebSocket | undefined;
  private msgId = 1;
  private pending = new Map<number, (resp: any) => void>();
  private activeSearch: vscode.CancellationTokenSource | undefined;
  private injectPromise: Promise<void> | undefined;
  private log: vscode.OutputChannel;
  private activeWindowId: number | undefined;
  private trigramIndex: TrigramIndex;
  private pendingShow: string | null = null;
  private showInFlight = false;
  private capturePromise: Promise<void> | undefined;
  // Per-source lastSeenSeq: each renderer patch install has its own instance
  // id (`__src`) and monotonic `__seq`. We dedup duplicates delivered by
  // accumulated CDP `message` listeners *within the same source*, but never
  // across sources — a single shared counter would drop legit events when
  // different windows' __seqs interleave (see V50 patch comment).
  private lastSeenSeqBySrc = new Map<string, number>();
  // Pending bridge-liveness pings awaiting their own log echo back through
  // the bridge chain. See verifyBridgeAlive() for why we need this.
  private bridgePings = new Map<string, () => void>();

  static get(context: vscode.ExtensionContext): OverlayPanel {
    if (!OverlayPanel.instance) {
      OverlayPanel.instance = new OverlayPanel(context);
    }
    return OverlayPanel.instance;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('IntelliJ Styled Search');
    context.subscriptions.push(this.log);
    context.subscriptions.push({ dispose: () => this.dispose() });
    configureRipgrepInstall(context);
    void ensureRipgrepInstalled((msg) => this.log.appendLine(msg));
    // Kick off the trigram index in the background. Search remains available
    // (via full scan) while the initial build runs.
    this.trigramIndex = new TrigramIndex(context.globalStorageUri, this.log);
    void this.trigramIndex.init().catch((err) => {
      this.log.appendLine(`TrigramIndex init failed: ${err instanceof Error ? err.message : err}`);
    });
    context.subscriptions.push({ dispose: () => this.trigramIndex.dispose() });
  }

  /** Kick CDP + patch install off the critical path of the first command. */
  async prewarm(): Promise<void> {
    try {
      const rgPath = findRipgrepPath();
      this.log.appendLine(`ripgrep: ${rgPath || '(not found — will fall back to JS scan)'}`);
      await this.ensureInjected();
      this.log.appendLine('Prewarm complete (CDP attached, patch installed).');
      // Do NOT run capture diagnostic here. Opening/closing a file at
      // activation time is user-visible and competes for CPU with other
      // extensions starting up. Capture runs lazily on the first show().
    } catch (err) {
      this.log.appendLine(`Prewarm failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private lastCaptureAttemptAt = 0;
  /** Start Monaco capture after the overlay is attached. The first preview
   * request awaits the same promise, so it does not render the non-editable
   * DOM fallback just because capture is still racing in the background. */
  private scheduleLazyCapture(preferredWindowId?: number): void {
    void this.ensureMonacoCapture(preferredWindowId).catch((err) => {
      this.log.appendLine(`Monaco capture failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private async ensureMonacoCapture(preferredWindowId?: number): Promise<void> {
    if (preferredWindowId !== undefined && await this.isMonacoReadyInWindow(preferredWindowId)) { return; }
    if (preferredWindowId === undefined && await this.isMonacoReadyAnywhere()) { return; }
    if (this.capturePromise) {
      await this.capturePromise;
      if (preferredWindowId !== undefined && await this.isMonacoReadyInWindow(preferredWindowId)) { return; }
      if (preferredWindowId === undefined && await this.isMonacoReadyAnywhere()) { return; }
    }
    const now = Date.now();
    if (now - this.lastCaptureAttemptAt < 1500) { return; }
    this.lastCaptureAttemptAt = now;
    try {
      this.capturePromise = this.triggerCaptureDiagnostic(preferredWindowId);
      await this.capturePromise;
    } finally {
      this.capturePromise = undefined;
    }
  }

  private async isMonacoReadyInWindow(winId: number): Promise<boolean> {
    try {
      const r = await this.evalInWindow(winId,
        `(function(){try{var m=window.__ijFindMonaco;return m&&m.ctor&&m.inst&&m.modelSvc?'ready':'not-ready'}catch(e){return 'err:'+(e&&e.message)}})()`,
      );
      return r === 'ready';
    } catch {
      return false;
    }
  }

  private async isMonacoReadyAnywhere(): Promise<boolean> {
    try {
      const wins = await this.listWorkbenchWindowIds();
      for (const id of wins) {
        if (await this.isMonacoReadyInWindow(id)) { return true; }
      }
    } catch {}
    return false;
  }

  /** Fire a sentinel-tagged log event from the first patched workbench
   *  window through `globalThis.irSearchEvent` and wait for the same
   *  payload to round-trip back through the bridge into
   *  `handleRendererEvent`. Returns false if the echo doesn't arrive
   *  within `timeoutMs` — the caller typically forces a reinject at that
   *  point. */
  private async verifyBridgeAlive(timeoutMs = 400): Promise<boolean> {
    const wins = await this.listWorkbenchWindowIds();
    if (wins.length === 0) { return false; }
    const pingId = '__ij-bridge-ping-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const pong = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.bridgePings.delete(pingId);
        resolve(false);
      }, timeoutMs);
      this.bridgePings.set(pingId, () => { clearTimeout(timer); resolve(true); });
    });
    const expr = `try { globalThis.irSearchEvent && globalThis.irSearchEvent(JSON.stringify({type:'log',msg:${JSON.stringify(pingId)}})); } catch (e) {}`;
    // Fire the ping into whichever window is first — bridges forward
    // from ANY window back to the ext host, so one ping is enough to
    // prove the chain is alive.
    try { await this.evalInWindow(wins[0], expr); }
    catch { return false; }
    return pong;
  }

  private async listWorkbenchWindowIds(): Promise<number[]> {
    const script = `
      (function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var out = [];
        for (var i = 0; i < wins.length; i++) {
          try {
            var url = (wins[i].webContents && wins[i].webContents.getURL && wins[i].webContents.getURL()) || '';
            if (/workbench\\.(?:esm\\.)?html/.test(url)) { out.push(wins[i].id); }
          } catch (e) {}
        }
        return out;
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const v = resp?.result?.value;
    return Array.isArray(v) ? v as number[] : [];
  }

  private async triggerCaptureDiagnostic(preferredWindowId?: number): Promise<void> {
    this.log.appendLine('Capture diagnostic: starting...');
    const windowIds = await this.listWorkbenchWindowIds();
    this.log.appendLine(
      `Workbench windows: [${windowIds.join(', ')}]` +
      (preferredWindowId !== undefined ? ` preferred=${preferredWindowId}` : ''),
    );
    if (windowIds.length === 0) { return; }

    // Renderer globals persist across extension-host restarts. If a previous
    // session already captured the real CodeEditorWidget class + services,
    // there's nothing to redo — skip force-open + TEST widget entirely.
    const monacoPeek = `(function(){
      try {
        var m = window.__ijFindMonaco;
        if (!m) return 'none';
        return 'ctor=' + (!!(m.ctor)) + ' inst=' + (!!(m.inst)) + ' modelSvc=' + (!!(m.modelSvc));
      } catch(e){ return 'peek-err:' + (e && e.message); }
    })()`;
    // Check all windows in parallel — if ANY already has globals populated
    // (renderer persisted them across the extension-host restart), we skip
    // the whole diagnostic. Serial check added ~150ms before we could bail.
    const monacoVals = new Map<number, string>();
    await Promise.all(windowIds.map(async (id) => {
      try { monacoVals.set(id, await this.evalInWindow(id, monacoPeek)); }
      catch {}
    }));
    let alreadyReadyWin: number | null = null;
    for (const [id, v] of monacoVals) {
      this.log.appendLine(`Monaco globals win=${id}: ${v}`);
      if (alreadyReadyWin === null &&
          (preferredWindowId === undefined || id === preferredWindowId) &&
          /ctor=true inst=true modelSvc=true/.test(v)) {
        alreadyReadyWin = id;
      }
    }
    if (alreadyReadyWin !== null) {
      this.log.appendLine(`Monaco globals already present in win=${alreadyReadyWin} — skipping capture diagnostic.`);
      return;
    }

    const peek = `(function(){
      try {
        var c = window.__ijFindCaptures || {};
        return 'widgets=' + ((c.widgets||[]).length) +
          ' services=' + ((c.services||[]).length) +
          ' ctors=' + ((c.widgetCtors||[]).length) +
          ' installed=' + !!window.__ijFindCaptureInstalled;
      } catch(e){ return 'peek-err:' + (e && e.message); }
    })()`;

    const peekAll = async (stage: string, silent = false) => {
      const results = new Map<number, string>();
      // Run peeks in parallel — one CDP eval per window; serial would add
      // ~50ms per additional window for no reason.
      await Promise.all(windowIds.map(async (id) => {
        try { results.set(id, await this.evalInWindow(id, peek)); }
        catch (err) { results.set(id, 'err:' + (err instanceof Error ? err.message : err)); }
      }));
      if (!silent) {
        this.log.appendLine(`${stage}: ${[...results.entries()].map(([id, v]) => `win=${id} ${v}`).join(' | ')}`);
      }
      return results;
    };

    try {
      await peekAll('Capture peek initial (boot-time, likely dummies)');
      // Boot-time captures are almost always DI stubs (getModel()=null).
      // Clear them everywhere and force a real editor creation so fresh
      // Map/Array/Set writes land in a clean capture buffer.
      const clearExpr = `(function(){
        try {
          if (window.__ijFindCaptures) {
            window.__ijFindCaptures.widgets = [];
            window.__ijFindCaptures.services = [];
            window.__ijFindCaptures.widgetCtors = [];
            window.__ijFindCaptures.serviceMaps = [];
          }
          return 'cleared';
        } catch (e) { return 'clear-err:' + (e && e.message); }
      })()`;
      await Promise.all(windowIds.map(async (id) => {
        try { await this.evalInWindow(id, clearExpr); } catch {}
      }));
      // First try to grab widget/service refs from any editor the user
      // already has open, straight from the live DOM. Success here means
      // we can skip the file force-open entirely — no `client.md` (or
      // whatever the first .md in the workspace is) gets briefly opened
      // and torn down.
      const domCaptureExpr = `(function(){try{return window.__ijFindCaptureFromDom?window.__ijFindCaptureFromDom():'no-fn'}catch(e){return 'throw:'+(e&&e.message)}})()`;
      let domCaptureSummaries: string[] = [];
      await Promise.all(windowIds.map(async (id) => {
        try {
          const r = await this.evalInWindow(id, domCaptureExpr);
          domCaptureSummaries.push(`win=${id} ${r}`);
        } catch (err) { domCaptureSummaries.push(`win=${id} err:${err instanceof Error ? err.message : err}`); }
      }));
      this.log.appendLine(`Capture via DOM scan: ${domCaptureSummaries.join(' | ')}`);

      // Peek again to see if DOM scan gave us enough to run the widget-
      // creation test without needing to force-open a file.
      const afterDomPeek = await peekAll('Capture peek after DOM scan', true);
      let bestDomWin: number | null = null;
      let bestDomWidgets = 0;
      for (const [id, v] of afterDomPeek) {
        const widgetsMatch = /widgets=(\d+)/.exec(v);
        const servicesMatch = /services=(\d+)/.exec(v);
        const widgets = widgetsMatch ? parseInt(widgetsMatch[1], 10) : 0;
        const services = servicesMatch ? parseInt(servicesMatch[1], 10) : 0;
        if (preferredWindowId !== undefined && id === preferredWindowId && widgets > 0 && services > 0) {
          bestDomWidgets = widgets;
          bestDomWin = id;
          break;
        }
        if (widgets > 0 && services > 0 && widgets > bestDomWidgets) {
          bestDomWidgets = widgets;
          bestDomWin = id;
        }
      }
      if (bestDomWin !== null && (preferredWindowId === undefined || bestDomWin === preferredWindowId)) {
        this.log.appendLine(`DOM scan yielded widgets=${bestDomWidgets} in win=${bestDomWin} — skipping force-open.`);
        // Run TEST widget create directly.
        const testExpr = `(function(){ try { return window.__ijFindTestCreateWidget ? window.__ijFindTestCreateWidget() : 'no-test-fn'; } catch(e){ return 'test-throw:' + (e && e.message); } })()`;
        try {
          const testResult = await this.evalInWindow(bestDomWin, testExpr);
          this.log.appendLine(`TEST widget create (win=${bestDomWin}, DOM path): ${String(testResult).slice(0, 2000)}`);
        } catch (err) {
          this.log.appendLine(`TEST widget eval failed: ${err instanceof Error ? err.message : err}`);
        }
        // Stop capture in every window so prototype monkey-patches revert.
        const stopExpr = `(function(){ try { return window.__ijFindStopCapture && window.__ijFindStopCapture(); } catch(e){ return 'stop-err:' + (e && e.message); } })()`;
        await Promise.all(windowIds.map(async (id) => {
          try {
            const r = await this.evalInWindow(id, stopExpr);
            this.log.appendLine(`Capture stop win=${id}: ${r}`);
          } catch {}
        }));
        return;
      }
      if (bestDomWin !== null && preferredWindowId !== undefined) {
        this.log.appendLine(
          `DOM scan yielded widgets in win=${bestDomWin}, but preview is in win=${preferredWindowId}; forcing capture in the preview window.`,
        );
      }
      this.log.appendLine('Captures cleared — no DOM-visible widgets, forcing real editor creation via file open/close...');
      const t0 = Date.now();
      let tFind = 0, tShow = 0, tPoll = 0, tClose = 0, pollIters = 0, pollPeekMaxMs = 0;
      try {
        const tFind0 = Date.now();
        const candidates = await vscode.workspace.findFiles(
          '**/*.{json,md,txt,ts,js,py}',
          '{**/node_modules/**,**/.git/**}',
          1,
        );
        tFind = Date.now() - tFind0;
        if (candidates.length > 0) {
          // Record which tabs already existed so we DON'T close them when
          // tearing down our capture-only editor. Previously we used
          // `workbench.action.closeEditorsInGroup` which nukes every tab
          // in the active group — that silently destroyed the user's
          // other open tabs if our `Beside` happened to land on an
          // already-populated column.
          const fileUri = candidates[0];
          const fileUriStr = fileUri.toString();
          const preExistingUris = new Set<string>();
          let userAlreadyHadThisTab = false;
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              const input = tab.input as unknown as { uri?: vscode.Uri };
              if (input && input.uri && typeof input.uri.toString === 'function') {
                const u = input.uri.toString();
                preExistingUris.add(u);
                if (u === fileUriStr) { userAlreadyHadThisTab = true; }
              }
            }
          }
          this.log.appendLine(
            `Capture diagnostic: opening ${fileUriStr}` +
            (userAlreadyHadThisTab ? ' (already open — will NOT close afterwards)' : ''),
          );
          const tShow0 = Date.now();
          await vscode.window.showTextDocument(fileUri, {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
            preview: true,
          });
          tShow = Date.now() - tShow0;
          // Poll every 100ms instead of sleeping a flat 1s. As soon as ANY
          // window has enough real widgets + services to run the widget-
          // creation test, close and move on.
          const tPoll0 = Date.now();
          let sawCaptures = false;
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const tPeek0 = Date.now();
            const p = await peekAll('poll', true);
            const peekMs = Date.now() - tPeek0;
            if (peekMs > pollPeekMaxMs) { pollPeekMaxMs = peekMs; }
            pollIters = i + 1;
            for (const v of p.values()) {
              const m = /widgets=(\d+)/.exec(v);
              if (m && parseInt(m[1], 10) >= 5) { sawCaptures = true; break; }
            }
            if (sawCaptures) { break; }
          }
          tPoll = Date.now() - tPoll0;
          const tClose0 = Date.now();
          // Close ONLY tabs we introduced, leaving every pre-existing
          // tab (including the one we landed beside) intact.
          if (!userAlreadyHadThisTab) {
            const targets: vscode.Tab[] = [];
            for (const group of vscode.window.tabGroups.all) {
              for (const tab of group.tabs) {
                const input = tab.input as unknown as { uri?: vscode.Uri };
                if (input && input.uri && typeof input.uri.toString === 'function' &&
                    input.uri.toString() === fileUriStr && !preExistingUris.has(input.uri.toString())) {
                  // Above condition is strict: file URI matches AND it
                  // wasn't in preExistingUris snapshot — i.e., the tab
                  // we just created.
                  targets.push(tab);
                }
              }
            }
            if (targets.length > 0) {
              try { await vscode.window.tabGroups.close(targets, true); }
              catch (errClose) { this.log.appendLine(`Capture close tab failed: ${errClose instanceof Error ? errClose.message : errClose}`); }
            }
          }
          tClose = Date.now() - tClose0;
        } else {
          this.log.appendLine('Capture diagnostic: no files found to open');
        }
      } catch (err) {
        this.log.appendLine(`Capture trigger failed: ${err instanceof Error ? err.message : err}`);
      }
      this.log.appendLine(
        `Capture force-open phase: ${Date.now() - t0}ms ` +
        `(findFiles=${tFind}ms showTextDocument=${tShow}ms ` +
        `poll=${tPoll}ms iters=${pollIters} peekMax=${pollPeekMaxMs}ms ` +
        `closeEditors=${tClose}ms)`,
      );
      const peeked = await peekAll('Capture peek after clear+force');

      // Find the window with most captures and run the widget-creation test there.
      let bestWin: number | null = null;
      let bestScore = 0;
      for (const [id, peekStr] of peeked) {
        const m = /services=(\d+)/.exec(peekStr);
        const svcCount = m ? parseInt(m[1], 10) : 0;
        if (preferredWindowId !== undefined && id === preferredWindowId && svcCount > 0) {
          bestWin = id;
          bestScore = svcCount;
          break;
        }
        if (svcCount > bestScore) { bestScore = svcCount; bestWin = id; }
      }
      if (bestWin !== null && bestScore > 0) {
        this.log.appendLine(`Running TEST widget create in win=${bestWin} (services=${bestScore})...`);
        const testExpr = `(function(){ try { return window.__ijFindTestCreateWidget ? window.__ijFindTestCreateWidget() : 'no-test-fn'; } catch(e){ return 'test-throw:' + (e && e.message); } })()`;
        try {
          const testResult = await this.evalInWindow(bestWin, testExpr);
          this.log.appendLine(`TEST widget create (win=${bestWin}): ${String(testResult).slice(0, 2000)}`);
        } catch (err) {
          this.log.appendLine(`TEST widget eval failed: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        this.log.appendLine('No window has captures — skipping widget creation test.');
      }

      // Stop capture in every window (best-effort) so Map.prototype etc.
      // are back to normal. Parallel for a small (~100ms) additional win.
      const stopExpr = `(function(){ try { return window.__ijFindStopCapture && window.__ijFindStopCapture(); } catch(e){ return 'stop-err:' + (e && e.message); } })()`;
      const stops = new Map<number, string>();
      await Promise.all(windowIds.map(async (id) => {
        try { stops.set(id, await this.evalInWindow(id, stopExpr)); }
        catch (err) { stops.set(id, 'err:' + (err instanceof Error ? err.message : err)); }
      }));
      for (const [id, v] of stops) {
        this.log.appendLine(`Capture stop win=${id}: ${v}`);
      }
    } catch (err) {
      this.log.appendLine(`Capture diagnostic failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** @internal Used by E2E tests to wait for the index to finish its
   *  initial disk load + reconcile before asserting search behaviour. */
  async waitForIndexReady(timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (!this.trigramIndex.isReady) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Trigram index did not become ready within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** @internal Run the same search pipeline runSearch() uses, but collect
   *  FileMatch events synchronously and return them. Skips the overlay UI
   *  (no CDP, no renderer) — tests get deterministic results independent
   *  of the VSCode window state. */
  async searchForTests(options: SearchOptions): Promise<FileMatch[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return []; }
    const matches: FileMatch[] = [];
    const { uris: candidates } = this.trigramIndex.candidatesFor(options.query, {
      useRegex: options.useRegex,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
    });
    let paths: string[] | null = null;
    if (candidates) {
      if (candidates.size === 0) { return []; }
      const uris: vscode.Uri[] = [];
      for (const u of candidates) {
        try { uris.push(vscode.Uri.parse(u)); } catch {}
      }
      paths = prioritizeFiles(uris).map((u) => u.fsPath);
    }
    const cts = new vscode.CancellationTokenSource();
    await new Promise<void>((resolve, reject) => {
      runRgSearch(
        options,
        cts.token,
        {
          onFile: (m) => { matches.push(m); },
          onDone: () => { resolve(); },
          onError: (err) => { reject(err); },
        },
        paths,
      ).catch(reject);
    });
    return matches;
  }

  /** @internal Exposed so tests can drive the index directly. */
  getTrigramIndex(): TrigramIndex {
    return this.trigramIndex;
  }

  /** @internal Await the CDP attach + renderer patch install. Tests that
   *  exercise the overlay UI call this first and skip (via assert.skip-like
   *  try/catch) if the test environment can't open the inspector. */
  async awaitInjection(): Promise<void> {
    await this.ensureInjected();
  }

  /** @internal Run the capture diagnostic synchronously (no lazy delay)
   *  and report what state `__ijFindMonaco` ended up in. Tests use this
   *  instead of relying on `scheduleLazyCapture` racing their setup. */
  async forceCaptureForTests(): Promise<string> {
    try { await this.triggerCaptureDiagnostic(); }
    catch (err) {
      return 'capture-threw:' + (err instanceof Error ? err.message : String(err));
    }
    try {
      const wins = await this.listWorkbenchWindowIds();
      for (const id of wins) {
        const r = await this.evalInWindow(id,
          `(function(){try{var m=window.__ijFindMonaco;return m?('ctor='+(!!m.ctor)+' inst='+(!!m.inst)+' modelSvc='+(!!m.modelSvc)):'no-monaco'}catch(e){return 'err:'+(e&&e.message)}})()`,
        );
        if (/ctor=true inst=true modelSvc=true/.test(r)) { return 'ready:win=' + id; }
      }
    } catch {}
    return 'not-ready';
  }

  /** @internal Poll renderer globals until `__ijFindMonaco` is populated
   *  (ctor + instantiation service + model service). Tests that assert on
   *  monaco decorations call this so they don't race the lazy capture
   *  diagnostic (which takes ~1.5–3 s after the first show()). */
  async waitForMonacoReadyForTests(timeoutMs = 20_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const wins = await this.listWorkbenchWindowIds();
        for (const id of wins) {
          const result = await this.evalInWindow(
            id,
            `(function(){try{var m=window.__ijFindMonaco;return m&&m.ctor&&m.inst&&m.modelSvc?'ready':'not-ready'}catch(e){return 'err:'+(e&&e.message)}})()`,
          );
          if (result === 'ready') { return true; }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  /** @internal Evaluate an expression in the currently-active workbench
   *  window and return its String() result. Used by renderer-level tests
   *  to probe `window.__ijFindStatus` and similar. Throws if the overlay
   *  hasn't latched onto a window yet (call `show()` first). */
  async evalInActiveWindowForTests(jsExpr: string): Promise<string> {
    if (this.activeWindowId === undefined) {
      throw new Error('no active workbench window — call overlay.show(...) first');
    }
    return this.evalInWindow(this.activeWindowId, jsExpr);
  }

  /** @internal Forcibly close the current CDP WebSocket — simulates the
   *  bridge dying mid-session (e.g. another extension detaching the
   *  webContents debugger). `ensureInjected()` on the next operation
   *  should notice and reopen. Returns whether a socket was actually
   *  closed. */
  closeWebSocketForTests(): boolean {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
      return true;
    }
    return false;
  }

  /** @internal Snapshot of connection state, for assertions after a
   *  bridge-kill + recover cycle. */
  getConnectionStateForTests(): { wsOpen: boolean; activeWindowId: number | undefined } {
    return {
      wsOpen: !!(this.ws && this.ws.readyState === (this.ws as any).constructor.OPEN),
      activeWindowId: this.activeWindowId,
    };
  }

  /** @internal Deliver a raw RendererEvent payload to handleRendererEvent
   *  as if it had arrived through the bridge. Tests use this to probe the
   *  per-source dedup logic without needing two separate windows. */
  injectRendererEventForTests(payload: string): void {
    this.handleRendererEvent(payload);
  }

  /** @internal Return a snapshot of the per-source dedup map so tests can
   *  assert on its contents after injectRendererEventForTests calls. */
  getDedupStateForTests(): Array<[string, number]> {
    return Array.from(this.lastSeenSeqBySrc.entries());
  }

  logActivation() {
    this.log.show(true);
    this.log.appendLine(`[${new Date().toISOString()}] Extension activated. Ext host pid=${process.pid}, ppid=${process.ppid}`);
  }

  logCommand(name: string) {
    this.log.show(true);
    this.log.appendLine(`[${new Date().toISOString()}] Command invoked: ${name}`);
  }

  async forceReinject(): Promise<void> {
    this.log.appendLine('Forcing reinject...');
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
    this.injectPromise = undefined;
    await this.ensureInjected();
  }

  private rebuildInFlight = false;
  async rebuildIndex(): Promise<void> {
    if (this.rebuildInFlight) {
      // Coalesce mash-presses into one user-facing rebuild operation.
      this.log.appendLine('rebuildIndex: already in progress; ignoring duplicate invocation.');
      return;
    }
    this.rebuildInFlight = true;
    this.cancelActive();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'IntelliJ Styled Search: rebuilding index',
          cancellable: false,
        },
        async (ui) => {
          try {
            await this.trigramIndex.rebuild({
              report: (stage, current, total) => {
                if (total > 0) {
                  const pct = Math.min(100, Math.round((current / total) * 100));
                  ui.report({ message: `${stage} ${current}/${total} (${pct}%)` });
                } else {
                  ui.report({ message: stage });
                }
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`Rebuild failed: ${msg}`);
            throw err;
          }
        },
      );
    } finally {
      this.rebuildInFlight = false;
    }
  }

  /** Debug-only: compare a query against what the index thinks about the
   *  currently-active file. Prints whether the file is in the index, how
   *  many of the query's trigrams are recorded for it, and the first few
   *  trigrams that are "in the file but not in the index" — which is the
   *  exact explanation for a failed literal search. */
  async diagnoseCurrentFile(query: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a file first so we know which to diagnose.');
      return;
    }
    const uri = editor.document.uri.toString();
    const qtris = query.length >= 3 ? extractTrigramsLower(query) : new Set<string>();
    const report = this.trigramIndex.diagnoseFile(uri, qtris);
    const lines: string[] = [];
    lines.push(`File: ${vscode.workspace.asRelativePath(editor.document.uri, false)}`);
    lines.push(`URI:  ${uri}`);
    lines.push(`Query: ${JSON.stringify(query.slice(0, 120))}${query.length > 120 ? '…' : ''}`);
    lines.push(`Query trigrams: ${qtris.size}`);
    if (!report.inIndex) {
      lines.push('❌ File NOT in index. (Possible reasons: >1MB, binary, excludeGlobs, reconcile still running.)');
    } else {
      lines.push(`✓ File in index. fileId=${report.fileId}, mtime=${report.mtime}, size=${report.size} bytes`);
      lines.push(`Query trigrams present in file posting: ${report.presentInFile}/${report.totalChecked}`);
      if (report.missingFromFile.length > 0) {
        const sample = report.missingFromFile.slice(0, 20)
          .map((t) => JSON.stringify(t)).join(' ');
        lines.push(`Missing-in-file trigrams (up to 20): ${sample}`);
        lines.push('→ If literal IS in the file, these are the trigrams the index wasn\'t given — either extraction bug or file changed after index.');
      } else if (report.totalChecked > 0) {
        lines.push('→ Every query trigram is recorded for this file. If rg still reports 0 matches, it\'s a rg-level issue (path, flags, or file content on disk differs from what rg sees).');
      }
    }
    this.log.show(true);
    for (const l of lines) { this.log.appendLine(l); }
  }

  async show(initialQuery: string): Promise<void> {
    // Coalesce a burst of command invocations (user mashing a shortcut)
    // into one effective show; we just remember the last query.
    this.pendingShow = initialQuery;
    if (this.showInFlight) { return; }
    this.showInFlight = true;
    try {
      while (this.pendingShow !== null) {
        const q = this.pendingShow;
        this.pendingShow = null;
        await this.doShow(q);
      }
    } finally {
      this.showInFlight = false;
    }
  }

  private async doShow(initialQuery: string): Promise<void> {
    const tShow = Date.now();
    this.log.appendLine(
      `doShow: initialQueryLen=${initialQuery.length} preview=${JSON.stringify(initialQuery.slice(0, 80))}`,
    );
    try {
      await this.ensureInjected();
      // Bridge state in the main process can go stale between command
      // invocations — another extension may detach webContents.debugger,
      // our bridge listener may be dropped, or a test VSCode instance may
      // have contended for the same inspector port. A quick ping catches
      // these cases so we can force-reinject before the user sees a
      // broken search pane.
      const alive = await this.verifyBridgeAlive(400);
      if (!alive) {
        this.log.appendLine('Bridge ping failed — forcing reinject before show');
        try { await this.forceReinject(); }
        catch (err) { this.log.appendLine(`forceReinject threw: ${err instanceof Error ? err.message : err}`); }
      }
      const tInjected = Date.now();
      // Single-roundtrip fast path: in one CDP message we locate the focused
      // workbench window, send __ijFindShow into it (awaited), and fire-and-
      // forget __ijFindHide into every other window. Prior version did three
      // serial roundtrips and cost ~200–400 ms of visible lag on cold start.
      const showExpr = `(function(){ try { return window.__ijFindShow ? window.__ijFindShow(${JSON.stringify(initialQuery)}) : 'no-show-fn'; } catch (e) { return 'show-throw:' + (e && e.message); } })()`;
      const hideExpr = `try { window.__ijFindHide && window.__ijFindHide(); } catch (e) {}`;
      const script = `
        (async function () {
          var BW = require('electron').BrowserWindow;
          var focused = BW.getFocusedWindow();
          if (!focused) {
            var ws = BW.getAllWindows();
            for (var i = 0; i < ws.length; i++) {
              try {
                var url = (ws[i].webContents && ws[i].webContents.getURL && ws[i].webContents.getURL()) || '';
                if (/workbench\\.(?:esm\\.)?html/.test(url)) { focused = ws[i]; break; }
              } catch (e) {}
            }
          }
          if (!focused) { return { fid: 0, result: 'no-focus' }; }
          var fid = focused.id;
          var showR;
          try {
            var r = await focused.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(showExpr)}, returnByValue: true });
            if (r && r.exceptionDetails) {
              showR = 'exc:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '').split('\\n')[0].slice(0, 150);
            } else {
              showR = (r && r.result && r.result.value) || 'ok';
            }
          } catch (e) { showR = 'show-err:' + (e && e.message); }
          var wins = BW.getAllWindows();
          for (var j = 0; j < wins.length; j++) {
            if (wins[j].id === fid) { continue; }
            try { wins[j].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(hideExpr)} }); } catch (e) {}
          }
          return { fid: fid, result: String(showR) };
        })()
      `.trim();
      let resp = await this.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      let v = resp?.result?.value as { fid: number; result: string } | undefined;
      // Brand-new VSCode windows may have missed the initial patch run
      // because their renderer wasn't ready yet ("No target available" in
      // the Injection log). Detect that via `no-show-fn` and run the patch
      // script again — already-patched windows no-op with 'already patched'.
      if (v && v.fid && v.result === 'no-show-fn') {
        this.log.appendLine(`Show(win=${v.fid}): missing patch, re-running inject script...`);
        try {
          const report = await this.runPatchScript();
          this.log.appendLine(`Re-inject: ${report}`);
        } catch (e) {
          this.log.appendLine(`Re-inject failed: ${e instanceof Error ? e.message : e}`);
        }
        resp = await this.send('Runtime.evaluate', {
          expression: script,
          awaitPromise: true,
          returnByValue: true,
          includeCommandLineAPI: true,
        });
        v = resp?.result?.value as { fid: number; result: string } | undefined;
      }
      if (!v || !v.fid) {
        this.log.appendLine('show() aborted: no focused VSCode window');
        return;
      }
      this.activeWindowId = v.fid;
      const tRendered = Date.now();
      this.log.appendLine(
        `Show(win=${v.fid}): ${v.result} [ensureInjected=${tInjected - tShow}ms showEval=${tRendered - tInjected}ms total=${tRendered - tShow}ms]`,
      );
      // After the overlay is visible, kick off Monaco capture for the same
      // renderer window that owns the preview pane. requestPreview awaits
      // this when needed, so the first preview can mount as Monaco instead
      // of permanently rendering the non-editable DOM fallback.
      this.scheduleLazyCapture(v.fid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`show() failed: ${err instanceof Error ? err.stack : msg}`);
      vscode.window.showErrorMessage(`IntelliJ Styled Search: ${msg}`);
    }
  }

  private async evalInWindow(winId: number, expr: string): Promise<string> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.fromId(${winId});
        if (!w || !w.webContents) { return 'no-window:' + ${winId}; }
        try {
          var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)}, returnByValue: true });
          if (r && r.exceptionDetails) {
            return 'exc:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '').split('\\n')[0].slice(0, 200);
          }
          var v = (r && r.result) ? r.result.value : undefined;
          return v === undefined ? '' : String(v);
        } catch (e) { return 'err:' + (e && e.message); }
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const value = resp?.result?.value;
    return typeof value === 'string' ? value : String(value ?? '');
  }

  private async evalInAllWindowsCollect(expr: string): Promise<string> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var results = [];
        for (var i = 0; i < wins.length; i++) {
          var wid = wins[i].id;
          try {
            var r = await wins[i].webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(expr)}, returnByValue: true });
            if (r && r.exceptionDetails) {
              results.push(wid + ':exc:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '').split('\\n')[0].slice(0, 150));
            } else {
              var v = (r && r.result) ? r.result.value : '(no-result)';
              if (v !== undefined && v !== null && String(v) !== '') { results.push(wid + ':' + v); }
            }
          } catch (e) { /* debugger not attached for this window */ }
        }
        return results.join(' || ');
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    const value = resp?.result?.value;
    if (typeof value === 'string') { return value; }
    if (value === undefined || value === null) { return '(no output)'; }
    return `(non-string value: ${JSON.stringify(value).slice(0, 200)}; resp=${JSON.stringify(resp).slice(0, 200)})`;
  }

  private dispose() {
    this.cancelActive();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
  }

  private async ensureInjected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { return; }
    if (this.injectPromise) { return this.injectPromise; }
    this.injectPromise = this.inject().finally(() => { this.injectPromise = undefined; });
    return this.injectPromise;
  }

  private async inject(): Promise<void> {
    const mainPid = this.findMainPid();
    if (!mainPid) { throw new Error('Could not locate VSCode main (Electron) process'); }
    const tStart = Date.now();
    this.log.appendLine(`Main PID ${mainPid}: sending SIGUSR1`);
    try { process.kill(mainPid, 'SIGUSR1'); } catch (e) {
      throw new Error(`SIGUSR1 to pid ${mainPid} failed: ${e instanceof Error ? e.message : e}`);
    }

    // Wait for the inspector listener to open. Tight-loop with 25ms backoff
    // instead of the old 200ms — the inspector is usually up in <100ms, so
    // the extra wall-clock savings are 150–350ms per prewarm.
    let wsUrl: string | undefined;
    let attempts = 0;
    for (let i = 0; i < 80; i++) {
      try {
        attempts++;
        const targets = await fetchJson('http://127.0.0.1:9229/json/list');
        if (Array.isArray(targets) && targets.length > 0 && targets[0].webSocketDebuggerUrl) {
          wsUrl = targets[0].webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await delay(25);
    }
    if (!wsUrl) { throw new Error('CDP inspector did not come up on 127.0.0.1:9229'); }
    const tInspector = Date.now();
    this.log.appendLine(`Inspector up after ${tInspector - tStart}ms (${attempts} polls)`);

    this.log.appendLine('Connecting CDP WebSocket');
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = (err: Error) => { cleanup(); reject(err); };
      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onErr);
      };
      ws.once('open', onOpen);
      ws.once('error', onErr);
    });
    const tWs = Date.now();
    this.log.appendLine(`WebSocket open after ${tWs - tInspector}ms`);
    this.ws = ws;
    ws.on('message', (data) => this.handleWsMessage(data));
    ws.on('close', () => {
      this.log.appendLine('CDP WebSocket closed');
      this.ws = undefined;
    });

    await this.send('Runtime.enable', {});
    await this.send('Runtime.addBinding', { name: BRIDGE_BINDING });

    const report = await this.runPatchScript();
    this.log.appendLine(`Injection: ${report}`);
    if (!/\bok:/.test(String(report))) {
      throw new Error(`Renderer patch did not install: ${report}`);
    }
    // Immediately sample renderer state via __ijFindStatus to confirm DOM install.
    try {
      const status = await this.evalInAllWindowsCollect(
        `(function(){ try { return window.__ijFindStatus ? window.__ijFindStatus() : 'no-status-fn'; } catch(e){ return 'status-throw:' + (e && e.message); } })()`,
      );
      this.log.appendLine(`Post-install status: ${status}`);
    } catch (e) {
      this.log.appendLine(`Post-install status probe failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Re-run the renderer patch in every workbench window. Windows that
   *  already have the patch return 'already patched' and are no-ops; windows
   *  that missed the initial injection (e.g., a brand-new VSCode window whose
   *  renderer wasn't ready yet) get a fresh attempt. */
  private async runPatchScript(): Promise<string> {
    // Pass the patch script directly as the expression — no base64/atob round-trip,
    // which previously corrupted any non-ASCII characters (they arrived as raw UTF-8
    // bytes through atob and broke the parser).
    const patchExpr = getRendererPatchScript();

    const injectScript = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var wins = BW.getAllWindows();
        var results = [];
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            var url = '';
            try { url = (w.webContents && w.webContents.getURL && w.webContents.getURL()) || ''; } catch (eu) {}
            // Only patch the main workbench windows.
            if (!/workbench\\.(?:esm\\.)?html(?:\\?|#|$)/.test(url)) {
              results.push('skip:' + w.id + ':url=' + url.split('?')[0].split('/').pop());
              continue;
            }
            // ── Cooperative debugger attachment ──
            // Other extensions (e.g. intellisense-recursion) use the SAME
            // webContents.debugger to install their own bindings/listeners
            // (irGoToType for cmd+click navigation, etc.). If we detach +
            // reattach, we evict their session and break their plugin.
            // Only attach if the debugger isn't already attached, and add our
            // binding/listener on top of whatever's there. Both bindings can
            // coexist on a single CDP session.
            var alreadyAttached = false;
            try { alreadyAttached = w.webContents.debugger.isAttached(); } catch (eIs) {}
            if (!alreadyAttached) {
              try { w.webContents.debugger.attach('1.3'); }
              catch (eAtt) { results.push('attach-fail:' + w.id + ':' + eAtt.message); continue; }
            }
            try { await w.webContents.debugger.sendCommand('Runtime.enable'); } catch (eRe) {}
            var r = await w.webContents.debugger.sendCommand('Runtime.evaluate', { expression: ${JSON.stringify(patchExpr)}, returnByValue: true });
            if (r && r.exceptionDetails) {
              var ed = r.exceptionDetails;
              var exStr = ed.exception && ed.exception.description ? ed.exception.description : (ed.text || JSON.stringify(ed));
              results.push('exc:' + w.id + ':' + String(exStr).split('\\n')[0].slice(0, 200));
              try { w.webContents.debugger.detach(); } catch (e3) {}
              continue;
            }
            var val = r && r.result ? r.result.value : undefined;
            if (val === 'ij-find patch installed' || val === 'already patched') {
              results.push('ok:' + w.id + ':' + val);
              try {
                await w.webContents.debugger.sendCommand('Runtime.addBinding', { name: ${JSON.stringify(RENDERER_BINDING)} });
                // CRITICAL: the 'message' listener accumulates across
                // extension-host reloads (main-process state persists while
                // the extension host restarts), and Electron's
                // webContents.debugger inherits every prior session's
                // listener. N listeners = 1 renderer send becomes N
                // runSearch calls. Track our registration per-window and
                // remove the previous one before adding the new.
                if (!global.__ijFindBridgeListeners) { global.__ijFindBridgeListeners = new Map(); }
                var prev = global.__ijFindBridgeListeners.get(w.id);
                if (prev) {
                  try { w.webContents.debugger.removeListener('message', prev); } catch (eRm) {}
                }
                var bridge = function (ev, method, params) {
                  if (method === 'Runtime.bindingCalled' && params && params.name === ${JSON.stringify(RENDERER_BINDING)}) {
                    if (typeof global.${BRIDGE_BINDING} === 'function') {
                      global.${BRIDGE_BINDING}(params.payload);
                    }
                  }
                };
                w.webContents.debugger.on('message', bridge);
                global.__ijFindBridgeListeners.set(w.id, bridge);
              } catch (eb) { results.push('bind-err:' + w.id + ':' + eb.message); }
            } else {
              var type = r && r.result ? r.result.type : 'no-result';
              results.push('skip:' + w.id + ':type=' + type + ':val=' + String(val));
              try { w.webContents.debugger.detach(); } catch (e3) {}
            }
          } catch (e) { results.push('err:' + w.id + ':' + e.message); }
        }
        return results.join(' | ');
      })()
    `.trim();

    const resp = await this.send('Runtime.evaluate', {
      expression: injectScript,
      includeCommandLineAPI: true,
      returnByValue: true,
      awaitPromise: true,
    });
    return String(resp?.result?.value ?? '(no result)');
  }

  private handleWsMessage(data: WebSocket.RawData) {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const cb = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      cb(msg);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled') {
      // Log every binding-called event we see on this CDP session. When
      // renderer events mysteriously fail to reach handleRendererEvent, this
      // tells us whether they even left the main-process bridge.
      const name = msg.params?.name;
      const payloadLen = String(msg.params?.payload ?? '').length;
      this.log.appendLine(`[cdp] bindingCalled name=${name} payloadLen=${payloadLen}`);
      if (name === BRIDGE_BINDING) {
        this.handleRendererEvent(String(msg.params.payload));
      }
    }
  }

  private handleRendererEvent(payload: string) {
    let evt: RendererEvent & { __seq?: number; __src?: string };
    try { evt = JSON.parse(payload); }
    catch {
      this.log.appendLine(`handleRendererEvent: JSON parse failed, payload=${payload.slice(0, 120)}`);
      return;
    }
    // Bridge-liveness ping echo. See verifyBridgeAlive(). Handled before
    // dedup because ping uses a sentinel msg we want to match even if a
    // stale listener delivers it more than once.
    if (evt.type === 'log' && typeof (evt as any).msg === 'string') {
      const m: string = (evt as any).msg;
      const pingCb = this.bridgePings.get(m);
      if (pingCb) { this.bridgePings.delete(m); pingCb(); return; }
    }
    if (typeof evt.__seq === 'number' && typeof evt.__src === 'string') {
      const last = this.lastSeenSeqBySrc.get(evt.__src) ?? -1;
      if (evt.__seq <= last) {
        this.log.appendLine(`dedup drop: type=${(evt as any).type} src=${evt.__src.slice(0, 14)} seq=${evt.__seq} last=${last}`);
        return;
      }
      this.lastSeenSeqBySrc.set(evt.__src, evt.__seq);
    } else {
      this.log.appendLine(`handleRendererEvent: no __seq/__src, type=${(evt as any).type}`);
    }
    switch (evt.type) {
      case 'search': void this.runSearch(evt.options); break;
      case 'cancel': this.cancelActive(); break;
      case 'openFile': void this.openFile(evt.uri, evt.line, evt.column, false); break;
      case 'previewFile': void this.openFile(evt.uri, evt.line, evt.column, true); break;
      case 'requestPreview': void this.handlePreviewRequest(evt); break;
      case 'openInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, true, true); break;
      case 'pinInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, false, false); break;
      case 'requestHover': void this.sendHover(evt.reqId, evt.uri, evt.line, evt.column, evt.x, evt.y); break;
      case 'runCommand': void this.runHoverCommand(evt.command, evt.args); break;
      case 'saveFile': void this.saveFile(evt.uri, evt.content); break;
      case 'log': this.log.appendLine(`[renderer] ${evt.msg}`); break;
    }
  }

  private async openInSideEditor(uriStr: string, line: number, column: number, preview: boolean, preserveFocus: boolean) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      // Open in Beside; the renderer immediately hides that editor-group
      // container so the user never sees a new column/tab. We steal the
      // monaco widget out of the hidden group. The widget shares VSCode's
      // TextModel, so edits in our preview propagate to any tab the user
      // already has open on the same file (and vice-versa).
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus,
        preview,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      this.log.appendLine(`openInSideEditor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async saveFile(uriStr: string, content: string) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // Use a WorkspaceEdit so VSCode's edit pipeline tracks the change (undo
      // history, dirty state on any open editor, etc). Fall back to direct
      // fs.writeFile if applyEdit fails.
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange, content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        const refreshed = await vscode.workspace.openTextDocument(uri);
        await refreshed.save();
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      }
      vscode.window.setStatusBarMessage(
        `IJ Find: saved ${vscode.workspace.asRelativePath(uri)}`, 2000,
      );
    } catch (err) {
      this.log.appendLine(`saveFile failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async runHoverCommand(command: string, args: unknown[]) {
    if (typeof command !== 'string' || !command) { return; }
    try {
      const safeArgs = Array.isArray(args) ? args : (args === undefined || args === null ? [] : [args]);
      await vscode.commands.executeCommand(command, ...safeArgs);
    } catch (err) {
      this.log.appendLine(`runHoverCommand(${command}) failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Command failed: ${command}`);
    }
  }

  private async handlePreviewRequest(evt: Extract<RendererEvent, { type: 'requestPreview' }>) {
    if (this.activeWindowId !== undefined) {
      await this.ensureMonacoCapture(this.activeWindowId);
    }
    await this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges);
  }

  private async sendPreview(uriStr: string, line: number, _contextLines: number, ranges: MatchRange[] | undefined) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const allLines = doc.getText().split(/\r?\n/);
      // Send the entire file. Cap at 10k lines to avoid massive payloads /
      // DOM blowups; for huge files we still fall back to a window around the
      // focus line.
      const HARD_CAP = 10000;
      let lines: PreviewLine[];
      if (allLines.length <= HARD_CAP) {
        lines = allLines.map((text, lineNumber) => ({ lineNumber, text: text ?? '' }));
      } else {
        const half = Math.floor(HARD_CAP / 2);
        const start = Math.max(0, line - half);
        const end = Math.min(allLines.length, start + HARD_CAP);
        lines = [];
        for (let i = start; i < end; i++) {
          lines.push({ lineNumber: i, text: allLines[i] ?? '' });
        }
      }
      const relPath = vscode.workspace.asRelativePath(uri, false);
      await this.postToRenderer({
        type: 'preview',
        uri: uriStr,
        relPath,
        focusLine: line,
        ranges,
        lines,
        languageId: doc.languageId,
      });
    } catch (err) {
      this.log.appendLine(`preview fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sendHover(reqId: number, uriStr: string, line: number, column: number, x: number, y: number) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // Make sure the document is loaded so language services pick it up.
      await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(line, column);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, pos,
      );
      // Preserve markdown structure: each hover provider's contents become one
      // group, joined into a single markdown string (with code-fences for
      // MarkedString language hints). Groups are sent separately so the
      // renderer can place a horizontal rule between them, matching the real
      // hover widget.
      // Build per-hover groups, preserving the trust flag for each
      // MarkdownString. Trusted markdown gets its `command:` links activated;
      // untrusted gets them rendered as inert text. This mirrors how VSCode's
      // own hover widget treats command links.
      const groups: HoverContent[] = [];
      if (hovers) {
        for (const h of hovers) {
          const parts: HoverContent[] = [];
          for (const c of h.contents) {
            if (typeof c === 'string') {
              parts.push({ value: c, isTrusted: false });
            } else if (c instanceof vscode.MarkdownString) {
              const trustedRaw = (c as any).isTrusted;
              const isTrusted = trustedRaw === true ||
                (typeof trustedRaw === 'object' && trustedRaw !== null);
              const allowedCommands = (typeof trustedRaw === 'object' && trustedRaw !== null && Array.isArray(trustedRaw.enabledCommands))
                ? trustedRaw.enabledCommands as readonly string[]
                : undefined;
              parts.push({ value: c.value, isTrusted, allowedCommands });
            } else if (c && typeof (c as any).language === 'string' && typeof (c as any).value === 'string') {
              parts.push({
                value: '```' + (c as any).language + '\n' + (c as any).value + '\n```',
                isTrusted: false,
              });
            } else if (c && typeof (c as any).value === 'string') {
              parts.push({ value: (c as any).value, isTrusted: false });
            }
          }
          const valid = parts.filter((p) => p.value && p.value.trim().length > 0);
          if (valid.length === 0) { continue; }
          groups.push({
            value: valid.map((p) => p.value).join('\n\n').trim(),
            isTrusted: valid.some((p) => p.isTrusted),
            allowedCommands: valid.flatMap((p) => p.allowedCommands ?? []) as readonly string[],
          });
        }
      }
      const contents = groups.filter((g) => g.value.length > 0);
      await this.postToRenderer({ type: 'hover', reqId, uri: uriStr, line, column, x, y, contents });
    } catch (err) {
      this.log.appendLine(`hover fetch failed: ${err instanceof Error ? err.message : err}`);
      await this.postToRenderer({ type: 'hover', reqId, uri: uriStr, line, column, x, y, contents: [] });
    }
  }

  private cancelActive() {
    if (this.activeSearch) {
      this.activeSearch.cancel();
      this.activeSearch.dispose();
      this.activeSearch = undefined;
    }
  }

  private async runSearch(options: SearchOptions) {
    this.cancelActive();
    const cts = new vscode.CancellationTokenSource();
    this.activeSearch = cts;
    await this.postToRenderer({ type: 'results:start' });
    const progress = {
      onFile: (m: FileMatch) => { if (!cts.token.isCancellationRequested) { void this.postToRenderer({ type: 'results:file', match: m }); } },
      onDone: (s: { totalFiles: number; totalMatches: number; truncated: boolean }) => {
        if (!cts.token.isCancellationRequested) { void this.postToRenderer({ type: 'results:done', ...s }); }
      },
      onError: (e: Error) => { void this.postToRenderer({ type: 'results:error', message: e.message }); },
    };
    const t0 = Date.now();
    const optTags = [
      options.useRegex ? 'regex' : '',
      options.caseSensitive ? 'case' : '',
      options.wholeWord ? 'word' : '',
      options.query.includes('\n') ? 'multiline' : '',
    ].filter(Boolean).join(',') || 'plain';
    this.log.appendLine(
      `search start: len=${options.query.length} flags=[${optTags}] indexReady=${this.trigramIndex.isReady} indexSize=${this.trigramIndex.size}`,
    );
    try {
      // Cox's codesearch planner narrows rg's file set. If the index
      // returns null, the planner couldn't constrain — rg walks the whole
      // workspace. If the index returns an empty set, the regex can't
      // match anything.
      const { uris: candidates, reason } = this.trigramIndex.candidatesFor(options.query, {
        useRegex: options.useRegex,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
      });
      if (candidates) {
        this.log.appendLine(
          `TrigramIndex candidates: ${candidates.size} via ${reason}`,
        );
      } else {
        this.log.appendLine(`TrigramIndex candidates: null (${reason}) — rg will full-scan workspace`);
      }
      // Primary engine: the same ripgrep that VSCode's built-in "Find in
      // Files" uses. Byte-for-byte result parity + multi-thread speed.
      // Falls back to the JS+trigram path only if rg isn't locatable.
      const rgPath = findRipgrepPath();
      if (rgPath) {
        let paths: string[] | null = null;
        if (candidates) {
          if (candidates.size === 0) {
            this.log.appendLine(`search done: 0 matches (candidates empty) in ${Date.now() - t0}ms`);
            progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
            return;
          }
          // Order candidates by relevance: open tabs → user code (shallow
          // depth first) → library-ish paths (.venv, node_modules, locks,
          // caches). Both rg scan order and the pending-row UI use this
          // order, so user's real files appear first in every view.
          const uris: vscode.Uri[] = [];
          for (const u of candidates) {
            try { uris.push(vscode.Uri.parse(u)); } catch {}
          }
          const ordered = prioritizeFiles(uris);
          paths = ordered.map((u) => u.fsPath);
          const MAX_PENDING = 400;
          const head = ordered.slice(0, MAX_PENDING);
          const sample = head.map((u) => ({
            uri: u.toString(),
            relPath: vscode.workspace.asRelativePath(u, false),
          }));
          // Log a handful of candidate paths so we can tell when rg returns
          // 0 matches whether the issue is "wrong files picked" (user's
          // real file isn't in the list) vs "right files, content doesn't
          // match the literal". Paths are relative to workspace.
          const relPaths = ordered.map((u) => vscode.workspace.asRelativePath(u, false));
          const head3 = relPaths.slice(0, 3).join(' | ');
          const tail3 = relPaths.length > 6 ? ' ... ' + relPaths.slice(-3).join(' | ') : '';
          this.log.appendLine(
            `candidates sample [${relPaths.length}]: ${head3}${tail3}`,
          );
          void this.postToRenderer({
            type: 'results:candidates',
            candidates: sample,
            total: paths.length,
          });
        }
        const rgStart = Date.now();
        const wrappedProgress = {
          onFile: progress.onFile,
          onDone: (s: { totalFiles: number; totalMatches: number; truncated: boolean }) => {
            this.log.appendLine(
              `search done: ${s.totalMatches} matches in ${s.totalFiles} files, rg=${Date.now() - rgStart}ms total=${Date.now() - t0}ms`,
            );
            progress.onDone(s);
          },
          onError: progress.onError,
        };
        await runRgSearch(options, cts.token, wrappedProgress, paths, (m) => this.log.appendLine(m));
      } else {
        this.log.appendLine('rg not found — falling back to JS scan.');
        await runSearch(options, cts.token, progress, candidates);
      }
    } finally {
      if (this.activeSearch === cts) {
        this.activeSearch.dispose();
        this.activeSearch = undefined;
      }
    }
  }

  private async postToRenderer(msg: OverlayMessage) {
    if (this.activeWindowId === undefined) { return; }
    const payload = JSON.stringify(msg);
    const js = `try { window.__ijFindOnMessage && window.__ijFindOnMessage(${payload}); } catch (e) {}`;
    try {
      await this.evalInWindow(this.activeWindowId, js);
    } catch (err) {
      this.log.appendLine(`postToRenderer failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async openFile(uriStr: string, line: number, column: number, preview: boolean) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: preview,
        preview,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to open file: ${err instanceof Error ? err.message : err}`);
    }
  }

  private send(method: string, params: any): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (resp) => {
        if (resp.error) { reject(new Error(resp.error.message || 'CDP error')); }
        else { resolve(resp.result); }
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private findMainPid(): number | null {
    // Match the Electron main process of VSCode on macOS/Linux via `ps`.
    // Accepts stable, insiders, OSS, and raw Electron dev-host binaries.
    try {
      const out = execSync('ps -o pid=,command= -ax', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const lines = out.split('\n');
      const patterns: RegExp[] = [
        /\/Visual Studio Code\.app\/Contents\/MacOS\/(?:Electron|Code)\s*$/,
        /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\/(?:Electron|Code - Insiders)\s*$/,
        /\/VSCodium\.app\/Contents\/MacOS\/(?:Electron|VSCodium)\s*$/,
        /\/Code - OSS\.app\/Contents\/MacOS\/(?:Electron|Code - OSS)\s*$/,
        /\/Electron\.app\/Contents\/MacOS\/Electron\s*$/,
      ];
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) { continue; }
        const cmd = m[2];
        if (/Helper/.test(cmd)) { continue; }
        if (patterns.some((p) => p.test(cmd))) {
          return parseInt(m[1], 10);
        }
      }
    } catch (e) {
      this.log.appendLine(`findMainPid ps error: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(new Error('HTTP timeout')); });
  });
}
