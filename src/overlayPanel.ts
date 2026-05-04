import * as vscode from 'vscode';
import * as http from 'http';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import {
  runSearch,
  SearchOptions,
  FileMatch,
  MatchRange,
  prioritizeFiles,
  mergeFileMatches,
  getConfiguredResultLimit,
  isRegexMultilineEnabled,
  getConfiguredSearchEngine,
  type SearchForTestsResult,
  type SearchEngine,
} from './search';
import { configureRipgrepInstall, ensureRipgrepInstalled, findRipgrepPath, runRgSearch } from './rgSearch';
import { getRendererPatchScript, RENDERER_PATCH_VERSION } from './rendererPatch';
import { TrigramIndex, extractTrigramsLower } from './trigramIndex';
import { compilePathScopeMatcher } from './pathScope';
import { ZoektRuntime } from './zoekRuntime';
import { findWorkspaceFilesDirect } from './fileDiscovery';

type RendererEvent =
  | { type: 'search'; options: SearchOptions; recordHistory?: boolean }
  | { type: 'loadMore' }
  | { type: 'cancel' }
  | { type: 'panelHidden' }
  | { type: 'trace'; phase: string; data?: unknown; light?: unknown; ir?: unknown; perf?: number }
  | { type: 'openFile'; uri: string; line: number; column: number }
  | { type: 'previewFile'; uri: string; line: number; column: number }
  | { type: 'requestPreview'; uri: string; line: number; ranges?: MatchRange[]; contextLines: number }
  | { type: 'revealFile'; uri: string }
  | { type: 'openInSideEditor'; uri: string; line: number; column: number }
  | { type: 'pinInSideEditor'; uri: string; line: number; column: number }
  | { type: 'requestHover'; reqId: number; uri: string; line: number; column: number; x: number; y: number }
  | { type: 'runCommand'; command: string; args: unknown[] }
  | { type: 'saveFile'; uri: string; content: string }
  | { type: 'log'; msg: string };

type PreviewLine = { lineNumber: number; text: string };
type HoverContent = { value: string; isTrusted: boolean; allowedCommands?: readonly string[] };

type OverlayMessage =
  | { type: 'results:start'; searchId: number }
  | { type: 'results:candidates'; searchId: number; candidates: Array<{ uri: string; relPath: string }>; total: number }
  | { type: 'results:file'; searchId: number; match: FileMatch }
  | { type: 'results:batch'; searchId: number; matches: FileMatch[] }
  | {
      type: 'results:done';
      searchId: number;
      totalFiles: number;
      totalMatches: number;
      truncated: boolean;
      pageSize: number;
      pageFiles: number;
      pageMatches: number;
      offset: number;
    }
  | { type: 'results:error'; searchId: number; message: string }
  | { type: 'history:update'; entries: string[]; limit: number }
  | { type: 'preview'; uri: string; relPath: string; focusLine: number; ranges?: MatchRange[]; lines: PreviewLine[]; languageId: string }
  | { type: 'hover'; reqId: number; uri: string; line: number; column: number; x: number; y: number; contents: HoverContent[] };

type SearchSession = {
  searchId: number;
  options: SearchOptions;
  requestedEngine: SearchEngine;
  effectiveEngine: SearchEngine;
  pageSize: number;
  loadedMatches: number;
  loadedUris: Set<string>;
  hasMore: boolean;
  orderedCandidatePaths: string[] | null;
  scopedCandidateUris: Set<string> | null;
};

export interface ShowOptions {
  forceLiteral?: boolean;
  suppressSearch?: boolean;
}

type PendingShow = {
  query: string;
  options?: ShowOptions;
};

type CaptureDiagnosticOptions = {
  allowForceOpen?: boolean;
  reason?: string;
};

const BRIDGE_BINDING = 'irSearchMainBridge';
const RENDERER_BINDING = 'irSearchEvent';
const SEARCH_HISTORY_KEY = 'intellijStyledSearch.searchHistory';
const DEFAULT_SEARCH_HISTORY_LIMIT = 100;
const HARD_SEARCH_HISTORY_LIMIT = 1000;

function wrapLogWithPrefix(channel: vscode.OutputChannel, version: string): vscode.OutputChannel {
  // Every log line gets `[<ISO ts>] [v<version>]` prefixed so bug reports
  // pasted from the Output panel carry both real time and the running
  // extension version without each call site having to remember.
  const prefix = () => `[${new Date().toISOString()}] [v${version}] `;
  return new Proxy(channel, {
    get(target, prop, receiver) {
      if (prop === 'appendLine') {
        return (value: string) => target.appendLine(prefix() + value);
      }
      if (prop === 'append') {
        return (value: string) => target.append(prefix() + value);
      }
      const out = Reflect.get(target, prop, receiver);
      return typeof out === 'function' ? out.bind(target) : out;
    },
  });
}

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
  private zoektRuntime: ZoektRuntime;
  private pendingShow: PendingShow | null = null;
  private showInFlight = false;
  private capturePromise: Promise<void> | undefined;
  private backgroundCapturePromise: Promise<void> | undefined;
  private backgroundCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  private cdpIdleCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private cdpSearchIdleCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private monacoCaptureDisabledLogged = false;
  private monacoCaptureStoppedForSession = false;
  private rendererRecoveryUntil = 0;
  private searchSeq = 0;
  private currentSearchSession: SearchSession | undefined;
  private rendererPostChain: Promise<void> = Promise.resolve();
  private localBridgeServer: http.Server | undefined;
  private localBridgePort: number | undefined;
  private localBridgePromise: Promise<void> | undefined;
  private readonly localBridgeToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private showSeq = 0;
  private targetWindowMarkerText: string | undefined;
  private targetWindowMarkerItem: vscode.StatusBarItem | undefined;
  private disposePromise: Promise<void> | undefined;
  private cdpCloseDeferredReasons = new Set<string>();
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
    const rawLog = vscode.window.createOutputChannel('IntelliJ Styled Search');
    const version = (context.extension?.packageJSON?.version as string | undefined) ?? 'unknown';
    this.log = wrapLogWithPrefix(rawLog, version);
    context.subscriptions.push(rawLog);
    context.subscriptions.push({ dispose: () => { void this.dispose(); } });
    configureRipgrepInstall(context);
    void ensureRipgrepInstalled((msg) => this.log.appendLine(msg));
    this.trigramIndex = new TrigramIndex(context.globalStorageUri, this.log);
    context.subscriptions.push({ dispose: () => this.trigramIndex.dispose() });
    this.zoektRuntime = new ZoektRuntime(context, this.log);
    context.subscriptions.push({ dispose: () => this.zoektRuntime.dispose() });
    const initialEngine = getConfiguredSearchEngine();
    if (initialEngine === 'codesearch') {
      this.startTrigramIndexInit('activation');
    } else {
      void this.trigramIndex.clear('zoekt selected on activation').catch((err) => {
        this.log.appendLine(`TrigramIndex clear failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('intellijStyledSearch.engine')) {
        const engine = getConfiguredSearchEngine();
        this.log.appendLine(`search engine changed: ${engine}`);
        if (engine === 'zoekt') {
          void this.trigramIndex.clear('zoekt selected in settings').catch((err) => {
            this.log.appendLine(`TrigramIndex clear failed: ${err instanceof Error ? err.message : err}`);
          });
        } else {
          this.zoektRuntime.cancelRunningProcesses('engine switched to codesearch');
          this.startTrigramIndexInit('engine switch');
          this.log.appendLine('codesearch selected; warming local trigram cache in background.');
        }
      }
      if (event.affectsConfiguration('intellijStyledSearch.searchHistoryLimit')) {
        void this.trimSearchHistoryToLimit().then(() => this.postSearchHistoryToRenderer()).catch((err) => {
          this.log.appendLine(`search history limit update failed: ${err instanceof Error ? err.message : err}`);
        });
      }
      if (event.affectsConfiguration('intellijStyledSearch.disableMonacoCapture')) {
        const disabled = this.isMonacoCaptureDisabled();
        this.log.appendLine(`disableMonacoCapture changed: ${disabled}`);
        this.monacoCaptureDisabledLogged = false;
        if (disabled) {
          void this.stopMonacoCapture('setting changed').catch((err) => {
            this.log.appendLine(`stopMonacoCapture after setting change failed: ${err instanceof Error ? err.message : err}`);
          });
        } else {
          this.monacoCaptureStoppedForSession = false;
        }
      }
    }));
  }

  private startTrigramIndexInit(reason: string): void {
    void this.trigramIndex.init().catch((err) => {
      this.log.appendLine(
        `TrigramIndex init failed (${reason}): ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  private getConfiguredSearchHistoryLimit(): number {
    const raw = vscode.workspace
      .getConfiguration('intellijStyledSearch')
      .get<number>('searchHistoryLimit', DEFAULT_SEARCH_HISTORY_LIMIT);
    if (!Number.isFinite(raw)) { return DEFAULT_SEARCH_HISTORY_LIMIT; }
    return Math.max(0, Math.min(Math.floor(raw), HARD_SEARCH_HISTORY_LIMIT));
  }

  private readSearchHistory(limit = this.getConfiguredSearchHistoryLimit()): string[] {
    const raw = this.context.globalState.get<unknown>(SEARCH_HISTORY_KEY, []);
    if (!Array.isArray(raw) || limit <= 0) { return []; }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0 || seen.has(item)) { continue; }
      seen.add(item);
      out.push(item);
      if (out.length >= limit) { break; }
    }
    return out;
  }

  private async recordSearchHistory(query: string): Promise<void> {
    const limit = this.getConfiguredSearchHistoryLimit();
    if (limit <= 0 || query.length === 0) {
      await this.postSearchHistoryToRenderer();
      return;
    }
    const history = this.readSearchHistory(HARD_SEARCH_HISTORY_LIMIT)
      .filter((item) => item !== query);
    history.unshift(query);
    await this.context.globalState.update(SEARCH_HISTORY_KEY, history.slice(0, limit));
    await this.postSearchHistoryToRenderer();
  }

  private async trimSearchHistoryToLimit(): Promise<void> {
    const limit = this.getConfiguredSearchHistoryLimit();
    await this.context.globalState.update(SEARCH_HISTORY_KEY, this.readSearchHistory(limit));
  }

  private async postSearchHistoryToRenderer(): Promise<void> {
    if (this.activeWindowId === undefined) { return; }
    await this.postToRenderer({
      type: 'history:update',
      entries: this.readSearchHistory(),
      limit: this.getConfiguredSearchHistoryLimit(),
    });
  }

  /** Warm search-only backends. CDP/renderer patching stays command-lazy. */
  async prewarm(): Promise<void> {
    try {
      const rgPath = findRipgrepPath();
      this.log.appendLine(`ripgrep: ${rgPath || '(not found — will fall back to JS scan)'}`);
      void this.zoektRuntime.prewarmIfPreferred().catch((err) => {
        this.log.appendLine(`zoek-rs prewarm failed: ${err instanceof Error ? err.message : err}`);
      });
      this.log.appendLine('Prewarm complete (search backend only; CDP/Monaco capture disabled on activation).');
    } catch (err) {
      this.log.appendLine(`Prewarm failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private lastCaptureAttemptAt = 0;
  private lastBackgroundCaptureAttemptAt = 0;
  /** Optional Monaco capture after the overlay is attached. Disabled by
   * default because it touches VSCode renderer internals on the UI thread. */
  private scheduleLazyCapture(preferredWindowId?: number): void {
    if (!this.isMonacoCaptureEnabled()) {
      this.logMonacoCaptureDisabled('lazy');
      return;
    }
    void this.ensureMonacoCapture(preferredWindowId).catch((err) => {
      this.log.appendLine(`Monaco capture failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private scheduleBackgroundCaptureWarmup(reason: string, delayMs = 120): void {
    if (this.backgroundCaptureTimer) {
      clearTimeout(this.backgroundCaptureTimer);
      this.backgroundCaptureTimer = undefined;
    }
    this.backgroundCaptureTimer = setTimeout(() => {
      this.backgroundCaptureTimer = undefined;
      void this.ensureBackgroundMonacoWarmup(reason).catch((err) => {
        this.log.appendLine(`Background Monaco warmup failed (${reason}): ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
  }

  private async ensureBackgroundMonacoWarmup(reason: string): Promise<void> {
    if (!this.isMonacoCaptureEnabled()) {
      this.logMonacoCaptureDisabled(`background:${reason}`);
      return;
    }
    await this.ensureRendererPatchAlive(undefined, `background:${reason}`);
    if (await this.isMonacoReadyAnywhere()) { return; }
    if (this.capturePromise) {
      await this.capturePromise;
      if (await this.isMonacoReadyAnywhere()) { return; }
    }
    if (this.backgroundCapturePromise) {
      await this.backgroundCapturePromise;
      return;
    }
    const now = Date.now();
    if (now - this.lastBackgroundCaptureAttemptAt < 1000) { return; }
    this.lastBackgroundCaptureAttemptAt = now;
    try {
      this.backgroundCapturePromise = this.triggerCaptureDiagnostic(undefined, {
        allowForceOpen: false,
        reason: `background:${reason}`,
      });
      await this.backgroundCapturePromise;
    } finally {
      this.backgroundCapturePromise = undefined;
    }
  }

  private async ensureMonacoCapture(preferredWindowId?: number): Promise<void> {
    if (!this.isMonacoCaptureEnabled()) {
      this.logMonacoCaptureDisabled('foreground');
      return;
    }
    await this.ensureRendererPatchAlive(preferredWindowId, 'monaco-capture');
    if (preferredWindowId !== undefined && await this.isMonacoReadyInWindow(preferredWindowId)) { return; }
    if (preferredWindowId === undefined && await this.isMonacoReadyAnywhere()) { return; }
    if (this.backgroundCapturePromise) {
      await this.backgroundCapturePromise;
      if (preferredWindowId !== undefined && await this.isMonacoReadyInWindow(preferredWindowId)) { return; }
      if (preferredWindowId === undefined && await this.isMonacoReadyAnywhere()) { return; }
    }
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
        `(function(){try{return window.__ijFindMonacoStatus?window.__ijFindMonacoStatus():'not-ready:no-status'}catch(e){return 'err:'+(e&&e.message)}})()`,
      );
      return r === 'ready';
    } catch {
      return false;
    }
  }

  private isMonacoCaptureEnabled(): boolean {
    return !this.isMonacoCaptureDisabled();
  }

  private isMonacoCaptureDisabled(): boolean {
    return this.monacoCaptureStoppedForSession || vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('disableMonacoCapture', true);
  }

  private shouldCloseMainInspector(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('closeMainInspectorAfterSearch', true);
  }

  private isRendererPerfDiagnosticsEnabled(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('rendererPerfDiagnostics', false);
  }

  private isRendererSafetyDiagnosticsEnabled(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('rendererSafetyDiagnostics', false);
  }

  private shouldSuspendIntelliSenseRecursionCapture(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('suspendIntelliSenseRecursionCaptureDuringSearchUi', true);
  }

  private shouldEnableRendererInlayClickHook(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('rendererInlayClickHook', false);
  }

  private shouldDisposeRendererPatchOnHide(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('disposeRendererPatchOnHide', true);
  }

  private shouldKeepCdpOpenWhileSearchUiVisible(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('keepCdpOpenWhileSearchUiVisible', true);
  }

  private shouldCloseInspectorForReason(reason: string): boolean {
    if (!this.shouldCloseMainInspector()) { return false; }
    // Closing Node's shared inspector from inside an active Runtime.evaluate
    // drops the CDP socket before the response can arrive. Doing that while
    // the Search UI is still visible made blank-panel typing fragile because
    // each search result could race a forced inspector shutdown. Keep
    // search/show idle cleanup to the client WebSocket only; panelHidden and
    // explicit recovery still own full bridge/inspector teardown.
    return /panel hidden|overlay disposed|renderer UI recovery|stop monaco capture|force reinject/i.test(reason);
  }

  private logMonacoCaptureDisabled(reason: string): void {
    if (this.monacoCaptureDisabledLogged) { return; }
    this.monacoCaptureDisabledLogged = true;
    this.log.appendLine(
      `Monaco capture disabled (${reason}); previews use DOM fallback to avoid CDP/prototype work on the VSCode UI thread.`,
    );
  }

  private getExpectedWorkspaceName(): string {
    return vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || '';
  }

  private beginTargetWindowMarker(): vscode.Disposable {
    try { this.targetWindowMarkerItem?.dispose(); } catch {}
    const marker = `IJSS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const item = vscode.window.createStatusBarItem(
      `intellijStyledSearch.target.${marker}`,
      vscode.StatusBarAlignment.Left,
      100000,
    );
    item.text = `$(search) ${marker}`;
    item.name = marker;
    item.tooltip = marker;
    item.accessibilityInformation = { label: marker, role: 'status' };
    item.show();
    const message = vscode.window.setStatusBarMessage(marker);
    this.targetWindowMarkerText = marker;
    this.targetWindowMarkerItem = item;
    return new vscode.Disposable(() => {
      if (this.targetWindowMarkerItem === item) {
        this.targetWindowMarkerItem = undefined;
        this.targetWindowMarkerText = undefined;
      }
      try { message.dispose(); } catch {}
      try { item.dispose(); } catch {}
    });
  }

  private buildTargetMarkerProbeExpression(markerText: string): string {
    return `
      (function () {
        try {
          var needle = ${JSON.stringify(markerText)};
          function has(value) {
            return typeof value === 'string' && value.indexOf(needle) >= 0;
          }
          function hasAttrs(el) {
            try {
              return !!el && (
                has(el.id) ||
                has(typeof el.className === 'string' ? el.className : '') ||
                has(el.getAttribute && el.getAttribute('aria-label')) ||
                has(el.getAttribute && el.getAttribute('title')) ||
                has(el.getAttribute && el.getAttribute('data-id')) ||
                has(el.getAttribute && el.getAttribute('data-keybinding-context'))
              );
            } catch (eAttrs) {
              return false;
            }
          }
          function hasNodeText(el) {
            try {
              return !!el && has(el.textContent);
            } catch (eText) {
              return false;
            }
          }
          if (!needle || !document) { return false; }
          var roots = [];
          var rootSelectors = [
            '.monaco-workbench .part.statusbar',
            '.part.statusbar',
            '.monaco-workbench .statusbar',
            '[id="workbench.parts.statusbar"]'
          ];
          for (var rs = 0; rs < rootSelectors.length; rs++) {
            try {
              var root = document.querySelector(rootSelectors[rs]);
              if (root && roots.indexOf(root) < 0) { roots.push(root); }
            } catch (eRoot) {}
          }
          if (roots.length === 0) {
            var direct = document.querySelectorAll('.statusbar-item, .statusbar-entry');
            for (var d = 0; d < direct.length && d < 80; d++) {
              if (hasAttrs(direct[d]) || hasNodeText(direct[d])) { return true; }
            }
            return false;
          }
          for (var r = 0; r < roots.length; r++) {
            if (hasAttrs(roots[r]) || hasNodeText(roots[r])) { return true; }
            var nodes = roots[r].querySelectorAll ? roots[r].querySelectorAll('*') : [];
            for (var i = 0; i < nodes.length && i < 500; i++) {
              if (hasAttrs(nodes[i]) || hasNodeText(nodes[i])) { return true; }
            }
          }
          return false;
        } catch (e) {
          return false;
        }
      })()
    `.trim();
  }

  private async resolveTargetWorkbenchWindowId(preferredWindowId?: number): Promise<number | undefined> {
    const requestedWindowId = preferredWindowId ?? this.activeWindowId;
    const workspaceName = this.getExpectedWorkspaceName();
    const markerText = this.targetWindowMarkerText || '';
    const markerProbeExpr = this.buildTargetMarkerProbeExpression(markerText);
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var requestedWindowId = ${requestedWindowId === undefined ? 'undefined' : JSON.stringify(requestedWindowId)};
        var expectedWorkspaceName = ${JSON.stringify(workspaceName)};
        var expectedWorkspaceNameLower = expectedWorkspaceName.toLowerCase();
        var markerText = ${JSON.stringify(markerText)};
        var markerProbeExpr = ${JSON.stringify(markerProbeExpr)};
        function isWorkbench(win) {
          try {
            var url = (win.webContents && win.webContents.getURL && win.webContents.getURL()) || '';
            return /workbench\\.(?:esm\\.)?html(?:\\?|#|$)/.test(url);
          } catch (e) { return false; }
        }
        function getWorkbenchWindows() {
          var wins = BW.getAllWindows();
          var workbenches = [];
          for (var i = 0; i < wins.length; i++) {
            if (isWorkbench(wins[i])) { workbenches.push(wins[i]); }
          }
          return workbenches;
        }
        function titleMatchesWorkspace(win) {
          if (!expectedWorkspaceNameLower) { return true; }
          try {
            var title = (win.getTitle && win.getTitle()) || '';
            return title.toLowerCase().indexOf(expectedWorkspaceNameLower) >= 0;
          } catch (e) { return false; }
        }
        async function hasMarker(win) {
          if (!markerText) { return false; }
          try {
            return await win.webContents.executeJavaScript(markerProbeExpr, true) === true;
          } catch (e) { return false; }
        }
        if (typeof requestedWindowId === 'number') {
          var requested = BW.fromId(requestedWindowId);
          if (requested && isWorkbench(requested) && (!markerText || await hasMarker(requested))) { return requested.id; }
        }
        var wins = getWorkbenchWindows();
        if (markerText) {
          for (var m = 0; m < wins.length; m++) {
            if (await hasMarker(wins[m])) { return wins[m].id; }
          }
          if (wins.length === 1) { return wins[0].id; }
          return 0;
        }
        var focused = BW.getFocusedWindow();
        if (focused && isWorkbench(focused) && titleMatchesWorkspace(focused)) { return focused.id; }
        var firstWorkbench = null;
        for (var i = 0; i < wins.length; i++) {
          if (!isWorkbench(wins[i])) { continue; }
          if (!firstWorkbench) { firstWorkbench = wins[i]; }
          if (titleMatchesWorkspace(wins[i])) { return wins[i].id; }
        }
        return firstWorkbench ? firstWorkbench.id : 0;
      })()
    `.trim();
    try {
      const resp = await this.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      const id = Number(resp?.result?.value ?? 0);
      return Number.isFinite(id) && id > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private async isMonacoReadyAnywhere(): Promise<boolean> {
    try {
      const id = await this.resolveTargetWorkbenchWindowId();
      return id !== undefined ? this.isMonacoReadyInWindow(id) : false;
    } catch {}
    return false;
  }

  private async isRendererPatchedInWindow(winId: number): Promise<boolean> {
    try {
      const r = await this.evalInWindow(winId,
        `(function(){try{return window.__ijFindShow&&window.__ijFindOnMessage&&window.__ijFindStatus&&window.__ijFindPatchVersion===${RENDERER_PATCH_VERSION}?'ready':'missing'}catch(e){return 'err:'+(e&&e.message)}})()`,
      );
      return r === 'ready';
    } catch {
      return false;
    }
  }

  private async isRendererPatchedAnywhere(): Promise<boolean> {
    try {
      const id = await this.resolveTargetWorkbenchWindowId();
      return id !== undefined ? this.isRendererPatchedInWindow(id) : false;
    } catch {}
    return false;
  }

  private async ensureRendererPatchAlive(preferredWindowId?: number, reason = 'unknown'): Promise<void> {
    await this.ensureInjected();
    if (preferredWindowId !== undefined) {
      if (await this.isRendererPatchedInWindow(preferredWindowId)) { return; }
    } else if (await this.isRendererPatchedAnywhere()) {
      return;
    }
    const report = await this.runPatchScript();
    this.log.appendLine(`Renderer patch refresh (${reason}): ${report}`);
  }

  /** Fire a sentinel-tagged log event from the first patched workbench
   *  window through `globalThis.irSearchEvent` and wait for the same
   *  payload to round-trip back through the bridge into
   *  `handleRendererEvent`. Returns false if the echo doesn't arrive
   *  within `timeoutMs` — the caller typically forces a reinject at that
   *  point. */
  private async verifyBridgeAlive(timeoutMs = 400): Promise<boolean> {
    const winId = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
    if (winId === undefined) { return false; }
    const pingId = '__ij-bridge-ping-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const pong = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.bridgePings.delete(pingId);
        resolve(false);
      }, timeoutMs);
      this.bridgePings.set(pingId, () => { clearTimeout(timer); resolve(true); });
    });
    const expr = `try { globalThis.irSearchEvent && globalThis.irSearchEvent(JSON.stringify({type:'log',msg:${JSON.stringify(pingId)}})); } catch (e) {}`;
    // Fire the ping only into this extension host's target workbench. Pinging
    // every VS Code window made one search panel heat unrelated renderers.
    try { await this.evalInWindow(winId, expr); }
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

  private async triggerCaptureDiagnostic(preferredWindowId?: number, options?: CaptureDiagnosticOptions): Promise<void> {
    const allowForceOpen = options?.allowForceOpen !== false;
    const reason = options?.reason || 'foreground';
    this.log.appendLine(
      `Capture diagnostic: starting (reason=${reason}, forceOpen=${allowForceOpen ? 'yes' : 'no'})...`,
    );
    const targetWindowId = await this.resolveTargetWorkbenchWindowId(preferredWindowId);
    const windowIds = targetWindowId === undefined ? [] : [targetWindowId];
    this.log.appendLine(
      `Target workbench windows: [${windowIds.join(', ')}]` +
      (preferredWindowId !== undefined ? ` preferred=${preferredWindowId}` : ''),
    );
    if (windowIds.length === 0) { return; }

    // Renderer globals persist across extension-host restarts. If a previous
    // session already captured the real CodeEditorWidget class + services,
    // there's nothing to redo — skip force-open + TEST widget entirely.
    const monacoPeek = `(function(){
      try {
        var m = window.__ijFindMonaco;
        var status = window.__ijFindMonacoStatus ? window.__ijFindMonacoStatus() : 'not-ready:no-status';
        if (!m) return 'status=' + status + ' none';
        return 'status=' + status + ' ctor=' + (!!(m.ctor)) + ' inst=' + (!!(m.inst)) + ' modelSvc=' + (!!(m.modelSvc));
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
      // Monaco globals are per-renderer-window, so a ready state in some
      // OTHER window can't satisfy a preview pane living in
      // preferredWindowId. Only treat as already-ready when the ready
      // window is (or could be) the preview window.
      if (alreadyReadyWin === null &&
          (preferredWindowId === undefined || id === preferredWindowId) &&
          /status=ready\b/.test(v)) {
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
    const stopCaptureAll = async () => {
      // Stop capture in every window so prototype monkey-patches revert.
      const stopExpr = `(function(){ try { return window.__ijFindStopCapture && window.__ijFindStopCapture(); } catch(e){ return 'stop-err:' + (e && e.message); } })()`;
      await Promise.all(windowIds.map(async (id) => {
        try {
          const r = await this.evalInWindow(id, stopExpr);
          this.log.appendLine(`Capture stop win=${id}: ${r}`);
        } catch {}
      }));
    };
    const refreshCaptureAll = async () => {
      // A previous diagnostic may have stopped the prototype hooks after a
      // successful capture attempt. Re-arm them before DOM scan / force-open,
      // otherwise opening a real editor produces no fresh captures.
      const captureReason = JSON.stringify(`diagnostic:${reason}`);
      const refreshExpr = `(function(){
        try {
          if (window.__ijFindRefreshCapture) { return window.__ijFindRefreshCapture(${captureReason}); }
          if (window.__ijFindStartCapture) { return window.__ijFindStartCapture(${captureReason}); }
          return 'no-capture-fn';
        } catch(e){ return 'refresh-err:' + (e && e.message); }
      })()`;
      const summaries: string[] = [];
      await Promise.all(windowIds.map(async (id) => {
        try {
          const r = await this.evalInWindow(id, refreshExpr);
          summaries.push(`win=${id} ${r}`);
        } catch (err) {
          summaries.push(`win=${id} err:${err instanceof Error ? err.message : err}`);
        }
      }));
      this.log.appendLine(`Capture refresh: ${summaries.join(' | ')}`);
    };
    const runWidgetCreateTest = async (winId: number, label: string): Promise<boolean> => {
      const testExpr = `(function(){ try { return window.__ijFindTestCreateWidget ? window.__ijFindTestCreateWidget() : 'no-test-fn'; } catch(e){ return 'test-throw:' + (e && e.message); } })()`;
      try {
        const testResult = await this.evalInWindow(winId, testExpr);
        this.log.appendLine(`TEST widget create (win=${winId}, ${label}): ${String(testResult).slice(0, 2000)}`);
      } catch (err) {
        this.log.appendLine(`TEST widget eval failed: ${err instanceof Error ? err.message : err}`);
      }
      return this.isMonacoReadyInWindow(winId);
    };
    const findBestCapturedWindow = (peeked: Map<number, string>): { id: number; widgets: number; services: number; ctors: number } | null => {
      let best: { id: number; widgets: number; services: number; ctors: number } | null = null;
      for (const [id, v] of peeked) {
        const widgetsMatch = /widgets=(\d+)/.exec(v);
        const servicesMatch = /services=(\d+)/.exec(v);
        const ctorsMatch = /ctors=(\d+)/.exec(v);
        const widgets = widgetsMatch ? parseInt(widgetsMatch[1], 10) : 0;
        const services = servicesMatch ? parseInt(servicesMatch[1], 10) : 0;
        const ctors = ctorsMatch ? parseInt(ctorsMatch[1], 10) : 0;
        if (widgets <= 0 || services <= 0) { continue; }
        if (preferredWindowId !== undefined && id === preferredWindowId) {
          return { id, widgets, services, ctors };
        }
        if (preferredWindowId !== undefined) { continue; }
        if (!best || widgets + services + ctors > best.widgets + best.services + best.ctors) {
          best = { id, widgets, services, ctors };
        }
      }
      return best;
    };

    try {
      const initialPeek = await peekAll('Capture peek initial');
      const existingCapture = findBestCapturedWindow(initialPeek);
      if (existingCapture) {
        this.log.appendLine(
          `Existing captures in win=${existingCapture.id} ` +
          `(widgets=${existingCapture.widgets} services=${existingCapture.services} ctors=${existingCapture.ctors}) — refreshing before testing.`,
        );
      }
      await refreshCaptureAll();
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
      if (bestDomWin !== null) {
        // Any window with DOM-visible widgets is enough to skip force-open.
        // This used to require `bestDomWin === preferredWindowId`, but that
        // re-introduced the `client.md` (first workspace doc) flash whenever
        // the preview window differed from the one with open editors —
        // exactly the bug `random doc open bug fix` originally addressed.
        this.log.appendLine(`DOM scan yielded widgets=${bestDomWidgets} in win=${bestDomWin} — skipping force-open.`);
        await runWidgetCreateTest(bestDomWin, 'DOM path');
        await stopCaptureAll();
        return;
      }
      if (!allowForceOpen) {
        this.log.appendLine(
          'Capture warmup: DOM scan did not yield a ready Monaco; skipping force-open and leaving normal foreground capture path intact.',
        );
        await stopCaptureAll();
        return;
      }
      this.log.appendLine('Captures cleared — no DOM-visible widgets, forcing real editor creation via file open/close...');
      const t0 = Date.now();
      let tFind = 0, tShow = 0, tPoll = 0, tClose = 0, pollIters = 0, pollPeekMaxMs = 0;
      try {
        const tFind0 = Date.now();
        const candidates = await findWorkspaceFilesDirect({
          excludeGlobs: ['**/node_modules/**', '**/.git/**'],
          extensions: new Set(['.json', '.md', '.txt', '.ts', '.js', '.py']),
          maxResults: 1,
        });
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
        const widgetMatch = /widgets=(\d+)/.exec(peekStr);
        const serviceMatch = /services=(\d+)/.exec(peekStr);
        const ctorMatch = /ctors=(\d+)/.exec(peekStr);
        const widgetCount = widgetMatch ? parseInt(widgetMatch[1], 10) : 0;
        const svcCount = serviceMatch ? parseInt(serviceMatch[1], 10) : 0;
        const ctorCount = ctorMatch ? parseInt(ctorMatch[1], 10) : 0;
        const score = widgetCount + svcCount + ctorCount;
        if (preferredWindowId !== undefined && id === preferredWindowId && widgetCount > 0 && svcCount > 0) {
          bestWin = id;
          bestScore = score;
          break;
        }
        if (widgetCount > 0 && svcCount > 0 && score > bestScore) { bestScore = score; bestWin = id; }
      }
      if (bestWin !== null && bestScore > 0) {
        this.log.appendLine(`Running TEST widget create in win=${bestWin} (score=${bestScore})...`);
        await runWidgetCreateTest(bestWin, 'force-open');
      } else {
        this.log.appendLine('No window has captures — skipping widget creation test.');
      }

      // Stop capture in every window (best-effort) so Map.prototype etc.
      // are back to normal. Parallel for a small (~100ms) additional win.
      await stopCaptureAll();
    } catch (err) {
      this.log.appendLine(`Capture diagnostic failed: ${err instanceof Error ? err.message : err}`);
      try { await stopCaptureAll(); } catch {}
    }
  }

  /** @internal Used by E2E tests to wait for the index to finish its
   *  initial disk load + reconcile before asserting search behaviour. */
  async waitForIndexReady(timeoutMs = 60_000): Promise<void> {
    const engine = getConfiguredSearchEngine();
    if (engine === 'zoekt') {
      await this.zoektRuntime.waitForIdle(timeoutMs);
      return;
    }

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
  async searchForTestsDetailed(options: SearchOptions): Promise<SearchForTestsResult> {
    const folders = vscode.workspace.workspaceFolders;
    const requestedEngine = getConfiguredSearchEngine();
    if (!folders || folders.length === 0) {
      return {
        matches: [],
        requestedEngine,
        effectiveEngine: requestedEngine,
        fallbackReason: 'no workspace folder',
      };
    }
    if (!options.query) {
      return {
        matches: [],
        requestedEngine,
        effectiveEngine: requestedEngine,
      };
    }
    const matches: FileMatch[] = [];
    let effectiveEngine: SearchEngine = requestedEngine;
    let fallbackReason: string | undefined;
    if (requestedEngine === 'zoekt') {
      if (options.excludePatterns && options.excludePatterns.length > 0) {
        effectiveEngine = 'codesearch';
        fallbackReason = 'scope exclude patterns require codesearch';
      } else {
        const readiness = await this.zoektRuntime.runSearch(
          options,
          new vscode.CancellationTokenSource().token,
          {
            onFile: (m) => { matches.push(m); },
            onDone: () => {},
            onError: (err) => { throw err; },
          },
        );
        if (readiness.ready) {
          return {
            matches: mergeFileMatches(matches),
            requestedEngine,
            effectiveEngine,
          };
        }
        effectiveEngine = 'codesearch';
        fallbackReason = readiness.reason;
      }
    }
    const { uris: candidates } = this.trigramIndex.candidatesFor(options.query, {
      useRegex: options.useRegex,
      regexMultiline: options.regexMultiline,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
    });
    let paths: string[] | null = null;
    if (candidates) {
      if (candidates.size === 0) {
        return {
          matches: [],
          requestedEngine,
          effectiveEngine,
          fallbackReason,
        };
      }
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
    return {
      matches: mergeFileMatches(matches),
      requestedEngine,
      effectiveEngine,
      fallbackReason,
    };
  }

  async searchForTests(options: SearchOptions): Promise<FileMatch[]> {
    const result = await this.searchForTestsDetailed(options);
    return result.matches;
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
    const preferredWindowId = this.activeWindowId;
    try { await this.triggerCaptureDiagnostic(preferredWindowId); }
    catch (err) {
      return 'capture-threw:' + (err instanceof Error ? err.message : String(err));
    }
    try {
      if (preferredWindowId !== undefined) {
        const r = await this.evalInWindow(preferredWindowId,
          `(function(){try{return window.__ijFindMonacoStatus?window.__ijFindMonacoStatus():'not-ready:no-status'}catch(e){return 'err:'+(e&&e.message)}})()`,
        );
        return r === 'ready' ? ('ready:win=' + preferredWindowId) : r;
      }
      const wins = await this.listWorkbenchWindowIds();
      for (const id of wins) {
        const r = await this.evalInWindow(id,
          `(function(){try{return window.__ijFindMonacoStatus?window.__ijFindMonacoStatus():'not-ready:no-status'}catch(e){return 'err:'+(e&&e.message)}})()`,
        );
        if (r === 'ready') { return 'ready:win=' + id; }
      }
    } catch {}
    return 'not-ready';
  }

  /** @internal Poll renderer globals until `__ijFindMonaco` is populated
   *  (ctor + instantiation service + model service). Tests that assert on
   *  monaco decorations call this so they don't race the lazy capture
   *  diagnostic (which takes ~1.5–3 s after the first show()). */
  async waitForMonacoReadyForTests(timeoutMs = 20_000): Promise<boolean> {
    await this.ensureRendererPatchAlive(this.activeWindowId, 'waitForMonacoReadyForTests');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const wins = await this.listWorkbenchWindowIds();
        for (const id of wins) {
          const result = await this.evalInWindow(
            id,
            `(function(){try{return window.__ijFindMonacoStatus?window.__ijFindMonacoStatus():'not-ready:no-status'}catch(e){return 'err:'+(e&&e.message)}})()`,
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
    const resolved = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
    if (resolved === undefined) {
      throw new Error('no active workbench window — call overlay.show(...) first');
    }
    this.activeWindowId = resolved;
    const result = await this.evalInWindow(resolved, jsExpr);
    if (!/^no-window:|^err:No target with given id found\b/.test(result)) {
      return result;
    }
    this.activeWindowId = undefined;
    const retryWindowId = await this.resolveTargetWorkbenchWindowId();
    if (retryWindowId === undefined || retryWindowId === resolved) {
      return result;
    }
    this.activeWindowId = retryWindowId;
    return this.evalInWindow(retryWindowId, jsExpr);
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
    this.log.appendLine(`Extension activated. Ext host pid=${process.pid}, ppid=${process.ppid}`);
  }

  logCommand(name: string) {
    this.log.show(true);
    this.log.appendLine(`Command invoked: ${name}`);
  }

  async forceReinject(): Promise<void> {
    this.log.appendLine('Forcing reinject...');
    if (this.ws) {
      try { await this.releaseRendererBridge('force reinject', undefined, 1500); }
      catch (err) { this.log.appendLine(`forceReinject release failed: ${err instanceof Error ? err.message : err}`); }
      if (this.ws) {
        this.closeCdpWebSocket('force reinject');
      }
    }
    this.injectPromise = undefined;
    await this.ensureInjected();
  }

  async recoverRendererUi(reason = 'manual'): Promise<string> {
    this.log.appendLine(`Recovering renderer UI (${reason})...`);
    this.rendererRecoveryUntil = Date.now() + 1000;
    this.cancelActive();
    this.currentSearchSession = undefined;
    this.pendingShow = null;
    this.cancelCdpIdleClose();
    this.cancelCdpSearchIdleClose();
    this.zoektRuntime.cancelRunningProcesses('renderer UI recovery');
    this.rendererPostChain = Promise.resolve();
    this.disableMonacoCaptureForSession(`recover:${reason}`);
    const rendererReport = await this.tryRendererEmergencyRecoverViaExistingBridge(`recover:${reason}`);
    const bridgeReport = await this.releaseRendererBridgeSafely('renderer UI recovery', 1000);
    this.activeWindowId = undefined;
    return [
      'active-search=cancelled',
      'future-monaco-capture=disabled',
      rendererReport,
      bridgeReport,
      'new-cdp=not-opened',
    ].join('; ');
  }

  async stopMonacoCapture(reason = 'manual'): Promise<string> {
    this.log.appendLine(`Stopping Monaco capture (${reason})...`);
    this.disableMonacoCaptureForSession(reason);
    const bridgeReport = await this.releaseRendererBridgeSafely(`stop monaco capture:${reason}`, 1000);
    return [
      'future-monaco-capture=disabled',
      bridgeReport,
      'new-cdp=not-opened',
    ].join('; ');
  }

  private disableMonacoCaptureForSession(reason: string): void {
    this.monacoCaptureStoppedForSession = true;
    this.monacoCaptureDisabledLogged = false;
    if (this.backgroundCaptureTimer) {
      clearTimeout(this.backgroundCaptureTimer);
      this.backgroundCaptureTimer = undefined;
    }
    this.log.appendLine(`Monaco capture disabled for this extension-host session (${reason}).`);
  }

  private async ensureLocalBridgeServer(): Promise<{ port: number; token: string }> {
    if (this.localBridgeServer && this.localBridgePort !== undefined) {
      return { port: this.localBridgePort, token: this.localBridgeToken };
    }
    if (!this.localBridgePromise) {
      this.localBridgePromise = new Promise<void>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          void this.handleLocalBridgeRequest(req, res);
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (!addr || typeof addr === 'string') {
            try { server.close(); } catch {}
            reject(new Error('local bridge did not receive a TCP port'));
            return;
          }
          server.removeListener('error', reject);
          this.localBridgeServer = server;
          this.localBridgePort = addr.port;
          this.log.appendLine(`Renderer event bridge listening on 127.0.0.1:${addr.port}`);
          resolve();
        });
      }).finally(() => {
        this.localBridgePromise = undefined;
      });
    }
    await this.localBridgePromise;
    if (!this.localBridgeServer || this.localBridgePort === undefined) {
      throw new Error('local renderer bridge failed to start');
    }
    return { port: this.localBridgePort, token: this.localBridgeToken };
  }

  private async handleLocalBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST' || req.url !== '/ijss-bridge') {
        res.writeHead(404).end();
        return;
      }
      if (String(req.headers['x-ijss-token'] || '') !== this.localBridgeToken) {
        res.writeHead(403).end();
        return;
      }
      const body = await readRequestBody(req, 20 * 1024 * 1024);
      this.handleRendererEvent(body);
      res.writeHead(204).end();
    } catch (err) {
      this.log.appendLine(`local renderer bridge failed: ${err instanceof Error ? err.message : err}`);
      try { res.writeHead(500).end(); } catch {}
    }
  }

  private closeLocalBridgeServer(reason: string): void {
    if (!this.localBridgeServer) { return; }
    try { this.localBridgeServer.close(); } catch {}
    this.localBridgeServer = undefined;
    this.localBridgePort = undefined;
    this.log.appendLine(`Renderer event bridge closed (${reason})`);
  }

  private async tryRendererEmergencyRecoverViaExistingBridge(reason: string): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.activeWindowId === undefined) {
      return 'renderer=not-contacted(no-active-bridge)';
    }
    const recoverExpr = `(function(){
      try {
        if (window.__ijFindEmergencyRecover) {
          return 'emergency=' + window.__ijFindEmergencyRecover(${JSON.stringify(reason)});
        }
        if (window.__ijFindHide) {
          window.__ijFindHide();
          return 'hide=ok';
        }
        return 'no-recover-fn';
      } catch (e) {
        return 'recover-err:' + (e && e.message);
      }
    })()`;
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.fromId(${this.activeWindowId});
        if (!w || !w.webContents) { return 'no-window'; }
        try {
          var value = await w.webContents.executeJavaScript(${JSON.stringify(recoverExpr)}, true);
          return value === undefined || value === null ? 'no-result' : String(value);
        } catch (e) {
          return 'renderer-recover-err:' + (e && e.message);
        }
      })()
    `.trim();
    try {
      const resp = await this.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
      }, 800);
      return `renderer=${String(resp?.result?.value ?? '(no result)')}`;
    } catch (err) {
      return `renderer=recover-failed:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async releaseRendererBridgeSafely(reason: string, timeoutMs: number): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.closeCdpWebSocket(`safe release skipped:${reason}`);
      return 'bridge=no-active-bridge';
    }
    try {
      const report = await this.releaseRendererBridge(reason, undefined, timeoutMs);
      return `bridge=${report}`;
    } catch (err) {
      this.log.appendLine(`Renderer bridge safe release failed (${reason}): ${err instanceof Error ? err.message : err}`);
      this.closeCdpWebSocket(`safe release failed:${reason}`);
      return `bridge=release-failed:${err instanceof Error ? err.message : String(err)}`;
    }
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
          const engine = getConfiguredSearchEngine();
          this.log.appendLine(`rebuildIndex: engine=${engine}`);
          try {
            if (engine === 'codesearch') {
              this.zoektRuntime.cancelRunningProcesses('codesearch rebuild requested');
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
            } else {
              this.zoektRuntime.cancelRunningProcesses('zoekt rebuild requested', {
                kinds: ['search', 'update', 'info', 'diagnose', 'benchmark'],
              });
              ui.report({ message: 'clearing codesearch trigram cache' });
              await this.trigramIndex.clear('zoekt rebuild requested');
              try {
                let lastPercent = 0;
                const usedZoekt = await this.zoektRuntime.rebuildIndex((message, percent) => {
                  if (typeof percent === 'number') {
                    const bounded = Math.max(0, Math.min(100, percent));
                    const increment = Math.max(0, bounded - lastPercent);
                    lastPercent = Math.max(lastPercent, bounded);
                    ui.report({ message, increment });
                    return;
                  }
                  ui.report({ message });
                });
                if (!usedZoekt) {
                  this.log.appendLine('zoek-rs rebuild skipped; active zoekt engine remains unavailable.');
                }
              } catch (err) {
                this.log.appendLine(`zoek-rs rebuild failed: ${err instanceof Error ? err.message : err}`);
              }
            }
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

  async showZoektInfo(): Promise<void> {
    const info = await this.zoektRuntime.collectInfo();
    if (!info) {
      vscode.window.showWarningMessage('zoek-rs info is unavailable.');
      return;
    }
    this.log.show(true);
    this.log.appendLine(this.zoektRuntime.formatInfoReport(info));
  }

  async explainZoektQuery(options: SearchOptions): Promise<void> {
    if (!options.query) {
      vscode.window.showWarningMessage('Enter a query first.');
      return;
    }
    const response = await this.zoektRuntime.diagnoseQuery(options);
    if (!response) {
      vscode.window.showWarningMessage('zoek-rs diagnose is unavailable.');
      return;
    }
    this.log.show(true);
    this.log.appendLine(this.zoektRuntime.formatDiagnoseReport(response));
  }

  async show(initialQuery: string, options?: ShowOptions): Promise<void> {
    this.rendererRecoveryUntil = 0;
    this.cancelCdpIdleClose();
    this.cancelCdpSearchIdleClose();
    // Coalesce a burst of command invocations (user mashing a shortcut)
    // into one effective show; we just remember the last query.
    this.pendingShow = { query: initialQuery, options };
    if (this.showInFlight) { return; }
    this.showInFlight = true;
    try {
      while (this.pendingShow !== null) {
        const pending = this.pendingShow;
        this.pendingShow = null;
        await this.doShow(pending.query, pending.options);
      }
    } finally {
      this.showInFlight = false;
    }
  }

  async showStaticResults(initialQuery: string, matches: FileMatch[]): Promise<void> {
    this.cancelActive();
    this.currentSearchSession = undefined;
    await this.show(initialQuery, { forceLiteral: true, suppressSearch: true });
    const searchId = ++this.searchSeq;
    const totalMatches = matches.reduce((sum, match) => sum + match.matches.length, 0);
    await this.postToRenderer({ type: 'results:start', searchId });
      const batchSize = 64;
    for (let i = 0; i < matches.length; i += batchSize) {
      await this.postToRenderer({
        type: 'results:batch',
        searchId,
        matches: matches.slice(i, i + batchSize),
      });
    }
    await this.postToRenderer({
      type: 'results:done',
      searchId,
      totalFiles: matches.length,
      totalMatches,
      truncated: false,
      pageSize: Math.max(totalMatches, getConfiguredResultLimit()),
      pageFiles: matches.length,
      pageMatches: totalMatches,
      offset: 0,
    });
    this.scheduleCdpSearchIdleClose('static-results-done');
  }

  private async doShow(initialQuery: string, options: ShowOptions = {}): Promise<void> {
    const tShow = Date.now();
    this.log.appendLine(
      `doShow: initialQueryLen=${initialQuery.length} preview=${JSON.stringify(initialQuery.slice(0, 80))}`,
    );
    const targetMarker = this.beginTargetWindowMarker();
    try {
      await delay(150);
      const showSeq = ++this.showSeq;
      await this.ensureInjected();
      const tInjected = Date.now();
      let v = await this.evaluateShowInFocusedWindow(initialQuery, options);
      // Brand-new VSCode windows may have missed the initial patch run
      // because their renderer wasn't ready yet ("No target available" in
      // the Injection log). Detect that via `no-show-fn` and run the patch
      // script again — already-patched windows no-op with 'already patched'.
      if (v && v.fid && v.result === 'no-show-fn') {
        this.log.appendLine(`Show(win=${v.fid}): missing patch, re-running inject script...`);
        try {
          const report = await this.runPatchScript(v.fid);
          this.log.appendLine(`Re-inject: ${report}`);
        } catch (e) {
          this.log.appendLine(`Re-inject failed: ${e instanceof Error ? e.message : e}`);
        }
        v = await this.evaluateShowInFocusedWindow(initialQuery, options);
      }
      if (!v || !v.fid) {
        this.log.appendLine('show() aborted: no focused VSCode window');
        return;
      }
      this.activeWindowId = v.fid;
      this.cdpCloseDeferredReasons.clear();
      this.cancelCdpIdleClose();
      const tRendered = Date.now();
      this.log.appendLine(
        `Show(win=${v.fid}): ${v.result} [ensureInjected=${tInjected - tShow}ms showEval=${tRendered - tInjected}ms total=${tRendered - tShow}ms]`,
      );
      if (this.isRendererSafetyDiagnosticsEnabled()) {
        void this.probeRendererSafety('show-complete', 700);
      }
      void this.postSearchHistoryToRenderer().catch((err) => {
        this.log.appendLine(`post search history failed: ${err instanceof Error ? err.message : err}`);
      });
      // After the overlay is visible, kick off Monaco capture for the same
      // renderer window that owns the preview pane. requestPreview awaits
      // this when needed, so the first preview can mount as Monaco instead
      // of permanently rendering the non-editable DOM fallback.
      this.scheduleLazyCapture(v.fid);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.scheduleBridgeRepairAfterVisible(showSeq, initialQuery, options);
        this.scheduleCdpSearchIdleClose('show-idle', initialQuery || options.suppressSearch ? 900 : 250);
      }
      if (this.shouldAutoCloseCdpForTests()) {
        this.scheduleCdpIdleClose(v.fid);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`show() failed: ${err instanceof Error ? err.stack : msg}`);
      vscode.window.showErrorMessage(`IntelliJ Styled Search: ${msg}`);
    } finally {
      targetMarker.dispose();
    }
  }

  private async evaluateShowInFocusedWindow(
    initialQuery: string,
    options: ShowOptions,
  ): Promise<{ fid: number; result: string } | undefined> {
    // Single-roundtrip fast path: in one CDP message we locate this extension
    // host's focused/matching workbench window and send __ijFindShow into it.
    // Do not touch other windows; cross-window hide/evaluate made unrelated
    // VS Code renderers slow when one window opened Search UI.
    const showExpr = `(function(){ try { return window.__ijFindShow ? window.__ijFindShow(${JSON.stringify(initialQuery)}, ${JSON.stringify(options)}) : 'no-show-fn'; } catch (e) { return 'show-throw:' + (e && e.message); } })()`;
    const workspaceName = vscode.workspace.name || vscode.workspace.workspaceFolders?.[0]?.name || '';
    const markerText = this.targetWindowMarkerText || '';
    const markerProbeExpr = this.buildTargetMarkerProbeExpression(markerText);
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var expectedWorkspaceName = ${JSON.stringify(workspaceName)};
        var expectedWorkspaceNameLower = expectedWorkspaceName.toLowerCase();
        var markerText = ${JSON.stringify(markerText)};
        var markerProbeExpr = ${JSON.stringify(markerProbeExpr)};
        function isWorkbench(win) {
          try {
            var url = (win.webContents && win.webContents.getURL && win.webContents.getURL()) || '';
            return /workbench\\.(?:esm\\.)?html/.test(url);
          } catch (e) { return false; }
        }
        function getWorkbenchWindows() {
          var wins = BW.getAllWindows();
          var workbenches = [];
          for (var i = 0; i < wins.length; i++) {
            if (isWorkbench(wins[i])) { workbenches.push(wins[i]); }
          }
          return workbenches;
        }
        function titleMatchesWorkspace(win) {
          if (!expectedWorkspaceNameLower) { return true; }
          try {
            var title = (win.getTitle && win.getTitle()) || '';
            return title.toLowerCase().indexOf(expectedWorkspaceNameLower) >= 0;
          } catch (e) { return false; }
        }
        async function hasMarker(win) {
          if (!markerText) { return false; }
          try {
            return await win.webContents.executeJavaScript(markerProbeExpr, true) === true;
          } catch (e) { return false; }
        }
        var focused = null;
        var ws = getWorkbenchWindows();
        if (markerText) {
          for (var m = 0; m < ws.length; m++) {
            if (await hasMarker(ws[m])) { focused = ws[m]; break; }
          }
          if (!focused && ws.length === 1) { focused = ws[0]; }
        } else {
          focused = BW.getFocusedWindow();
          var focusedUsable = focused && isWorkbench(focused) && titleMatchesWorkspace(focused);
          if (!focusedUsable) {
            var firstWorkbench = null;
            var matchingWorkbench = null;
            for (var i = 0; i < ws.length; i++) {
              if (!isWorkbench(ws[i])) { continue; }
              if (!firstWorkbench) { firstWorkbench = ws[i]; }
              if (titleMatchesWorkspace(ws[i])) { matchingWorkbench = ws[i]; break; }
            }
            focused = matchingWorkbench || (focused && isWorkbench(focused) ? focused : firstWorkbench);
          }
        }
        if (!focused) { return { fid: 0, result: 'no-focus' }; }
        var fid = focused.id;
        var showR;
        try {
          showR = await focused.webContents.executeJavaScript(${JSON.stringify(showExpr)}, true);
          if (showR === undefined || showR === null || showR === '') { showR = 'ok'; }
        } catch (e) { showR = 'show-err:' + (e && e.message); }
        return { fid: fid, result: String(showR) };
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    return resp?.result?.value as { fid: number; result: string } | undefined;
  }

  private scheduleBridgeRepairAfterVisible(
    showSeq: number,
    initialQuery: string,
    options: ShowOptions,
  ): void {
    void this.repairBridgeAfterVisible(showSeq, initialQuery, options).catch((err) => {
      this.log.appendLine(`post-show bridge repair failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private shouldAutoCloseCdpForTests(): boolean {
    return process.env.CODEX_CI === '1' || process.env.VSCODE_TEST === '1';
  }

  private async repairBridgeAfterVisible(
    showSeq: number,
    initialQuery: string,
    options: ShowOptions,
  ): Promise<void> {
    // Keep the panel paint path short: verify/recover the renderer bridge
    // after the UI is visible. If the first search event was lost while the
    // bridge was stale, replaying show() below fires it again.
    if (!initialQuery || options.suppressSearch) { return; }
    await delay(900);
    if (showSeq !== this.showSeq) { return; }
    if (this.activeSearch || this.currentSearchSession) { return; }
    this.log.appendLine('No renderer search event after show — forcing reinject and replaying visible query');
    await this.forceReinject();
    if (showSeq !== this.showSeq) { return; }
    const replay = await this.evaluateShowInFocusedWindow(initialQuery, options);
    if (showSeq !== this.showSeq) { return; }
    if (replay && replay.fid) {
      this.activeWindowId = replay.fid;
      this.log.appendLine(`Bridge repair replay show(win=${replay.fid}): ${replay.result}`);
      this.scheduleLazyCapture(replay.fid);
    }
  }

  private async evalInWindow(winId: number, expr: string, timeoutMs = 10_000): Promise<string> {
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.fromId(${winId});
        if (!w || !w.webContents) { return 'no-window:' + ${winId}; }
        try {
          var v = await w.webContents.executeJavaScript(${JSON.stringify(expr)}, true);
          return v === undefined ? '' : String(v);
        } catch (e) { return 'err:' + (e && e.message); }
      })()
    `.trim();
    const resp = await this.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
    }, timeoutMs);
    const value = resp?.result?.value;
    return typeof value === 'string' ? value : String(value ?? '');
  }

  private async probeRendererSafety(reason: string, timeoutMs = 700): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    const targetWindowId = this.activeWindowId ?? await this.resolveTargetWorkbenchWindowId();
    if (targetWindowId === undefined) { return; }
    const expr = `
      (function () {
        function shortErr(e) { return String(e && e.message || e || '').slice(0, 180); }
        var ij = null;
        var ir = {};
        try {
          ij = typeof window.__ijFindLightStatus === 'function'
            ? window.__ijFindLightStatus()
            : { patchVersion: window.__ijFindPatchVersion || null, hasPanel: !!window.__ijFindShow };
        } catch (eIj) {
          ij = { error: shortErr(eIj) };
        }
        try {
          if (typeof window.__irRendererSafetyReport === 'function') {
            ir.report = window.__irRendererSafetyReport();
          }
        } catch (eReport) {
          ir.reportError = shortErr(eReport);
        }
        try {
          ir.patchVersion = window.__irPatchVersion || null;
          ir.captureActive = !!window.__irCaptureActive;
          ir.captureSessionId = typeof window.__irCaptureSessionId === 'number' ? window.__irCaptureSessionId : null;
          ir.hasStopCapture = typeof window.__irStopCapture === 'function';
          ir.scanTimer = !!window.__irScanTimer;
          ir.scanInterval = !!window.__irScanInterval;
          ir.markdownObserver = !!window.__irMarkdownObserver;
          ir.recaptureScheduled = !!window.__irRecaptureScheduled;
          ir.mdRenderer = !!window.__irMdRenderer;
          ir.monaco = !!window.__irMonaco;
          ir.monacoCaps = !!window.__irMonacoCaps;
        } catch (eIr) {
          ir.error = shortErr(eIr);
        }
        var memory = null;
        try {
          if (performance && performance.memory) {
            memory = {
              used: performance.memory.usedJSHeapSize,
              total: performance.memory.totalJSHeapSize,
              limit: performance.memory.jsHeapSizeLimit
            };
          }
        } catch (eMemory) {}
        return JSON.stringify({
          reason: ${JSON.stringify(reason)},
          at: Date.now(),
          perf: Math.round((performance && performance.now ? performance.now() : 0)),
          ij: ij,
          ir: ir,
          memory: memory
        });
      })()
    `.trim();
    try {
      const snapshot = await this.evalInWindow(targetWindowId, expr, timeoutMs);
      this.log.appendLine(`renderer safety: ${snapshot}`);
    } catch (err) {
      this.log.appendLine(`renderer safety failed (${reason}): ${err instanceof Error ? err.message : err}`);
    }
  }

  private async evalInAllWindowsCollect(expr: string): Promise<string> {
    const targetWindowId = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
    if (targetWindowId === undefined) { return '(no target workbench window)'; }
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var targetWindowId = ${JSON.stringify(targetWindowId)};
        var win = BW.fromId(targetWindowId);
        var wins = win ? [win] : [];
        var results = [];
        for (var i = 0; i < wins.length; i++) {
          var wid = wins[i].id;
          try {
            var v = await wins[i].webContents.executeJavaScript(${JSON.stringify(expr)}, true);
            if (v !== undefined && v !== null && String(v) !== '') { results.push(wid + ':' + v); }
          } catch (e) { results.push(wid + ':err:' + (e && e.message)); }
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

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.disposeInternal();
    }
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.cancelActive();
    this.zoektRuntime.cancelRunningProcesses('overlay disposed');
    if (this.backgroundCaptureTimer) {
      clearTimeout(this.backgroundCaptureTimer);
      this.backgroundCaptureTimer = undefined;
    }
    if (this.cdpIdleCloseTimer) {
      clearTimeout(this.cdpIdleCloseTimer);
      this.cdpIdleCloseTimer = undefined;
    }
    if (this.cdpSearchIdleCloseTimer) {
      clearTimeout(this.cdpSearchIdleCloseTimer);
      this.cdpSearchIdleCloseTimer = undefined;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this.releaseRendererBridge('overlay disposed', undefined, 1500).catch((err) => {
        this.log.appendLine(`Renderer bridge release during dispose failed: ${err instanceof Error ? err.message : err}`);
      });
    } else if (this.ws) {
      this.closeCdpWebSocket('overlay disposed');
    }
    this.closeLocalBridgeServer('overlay disposed');
  }

  private cancelCdpIdleClose(): void {
    if (!this.cdpIdleCloseTimer) { return; }
    clearTimeout(this.cdpIdleCloseTimer);
    this.cdpIdleCloseTimer = undefined;
  }

  private cancelCdpSearchIdleClose(): void {
    if (!this.cdpSearchIdleCloseTimer) { return; }
    clearTimeout(this.cdpSearchIdleCloseTimer);
    this.cdpSearchIdleCloseTimer = undefined;
  }

  private scheduleCdpSearchIdleClose(reason: string, delayMs = 350): void {
    if (this.shouldAutoCloseCdpForTests()) { return; }
    if (this.shouldKeepCdpOpenWhileSearchUiVisible() && this.activeWindowId !== undefined) {
      if (!this.cdpCloseDeferredReasons.has(reason)) {
        this.cdpCloseDeferredReasons.add(reason);
        this.log.appendLine(`CDP close deferred until panel hidden (${reason}).`);
      }
      return;
    }
    this.cancelCdpSearchIdleClose();
    this.cdpSearchIdleCloseTimer = setTimeout(() => {
      this.cdpSearchIdleCloseTimer = undefined;
      if (this.showInFlight || this.pendingShow || this.activeSearch) {
        this.scheduleCdpSearchIdleClose(reason, delayMs);
        return;
      }
      const pendingPosts = this.rendererPostChain;
      void pendingPosts.finally(() => {
        if (this.rendererPostChain !== pendingPosts) {
          this.scheduleCdpSearchIdleClose(reason, delayMs);
          return;
        }
        if (this.showInFlight || this.pendingShow || this.activeSearch) { return; }
        if (this.isRendererSafetyDiagnosticsEnabled()) {
          void this.probeRendererSafety(`before-cdp-close:${reason}`, 500)
            .finally(() => this.closeCdpAndInspectorSoon(reason));
        } else {
          void this.closeCdpAndInspectorSoon(reason);
        }
      });
    }, delayMs);
  }

  private scheduleCdpIdleClose(sourceWindowId?: number): void {
    this.cancelCdpIdleClose();
    this.cdpIdleCloseTimer = setTimeout(() => {
      this.cdpIdleCloseTimer = undefined;
      if (sourceWindowId !== undefined && this.activeWindowId !== sourceWindowId) { return; }
      if (this.showInFlight || this.pendingShow || this.activeSearch) { return; }
      void this.releaseRendererBridge('panel hidden', sourceWindowId, 1500).catch((err) => {
        this.log.appendLine(`Renderer bridge release failed: ${err instanceof Error ? err.message : err}`);
      });
    }, 1500);
  }

  private closeCdpWebSocket(reason: string): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const cb of pending) {
      try { cb({ error: { message: `CDP connection closed (${reason})` } }); } catch {}
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = undefined;
    }
    this.injectPromise = undefined;
  }

  private async closeCdpAndInspectorSoon(reason: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.closeCdpWebSocket(reason);
      return;
    }
    if (!this.shouldCloseInspectorForReason(reason)) {
      this.log.appendLine(`CDP WebSocket closing without inspector.close (${reason}); inspector kept until panel hidden.`);
      this.closeCdpWebSocket(reason);
      return;
    }
    try {
      const resp = await this.send('Runtime.evaluate', {
        expression: `try { require('inspector').close(); 'inspector=closed'; } catch (e) { 'inspector-close-err:' + (e && e.message); }`,
        returnByValue: true,
        includeCommandLineAPI: true,
      }, 500);
      this.log.appendLine(`Inspector close result (${reason}): ${String(resp?.result?.value ?? '(no result)')}`);
    } catch (err) {
      this.log.appendLine(`Inspector close scheduling failed (${reason}): ${err instanceof Error ? err.message : err}`);
    } finally {
      this.closeCdpWebSocket(reason);
    }
  }

  private async releaseRendererBridge(reason: string, sourceWindowId?: number, timeoutMs = 2000): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return 'no-active-bridge'; }
    const closeMainInspector = this.shouldCloseMainInspector();
    const script = `
      (function () {
        var BW = require('electron').BrowserWindow;
        var closeMainInspector = ${JSON.stringify(closeMainInspector)};
        var wins = BW.getAllWindows();
        var removed = 0;
        var detached = 0;
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            var consoleBridge = global.__ijFindConsoleBridgeListeners && global.__ijFindConsoleBridgeListeners.get(w.id);
            if (consoleBridge) {
              try { w.webContents.removeListener('console-message', consoleBridge); removed++; } catch (eConsoleRm) {}
              try { global.__ijFindConsoleBridgeListeners.delete(w.id); } catch (eConsoleDel) {}
            }
            var bridge = global.__ijFindBridgeListeners && global.__ijFindBridgeListeners.get(w.id);
            if (bridge) {
              try { w.webContents.debugger.removeListener('message', bridge); removed++; } catch (eRm) {}
              try { global.__ijFindBridgeListeners.delete(w.id); } catch (eDel) {}
            }
            var reload = global.__ijFindReloadPatchListeners && global.__ijFindReloadPatchListeners.get(w.id);
            if (reload) {
              try { w.webContents.removeListener('did-finish-load', reload); } catch (eR1) {}
              try { w.webContents.removeListener('dom-ready', reload); } catch (eR2) {}
              try { global.__ijFindReloadPatchListeners.delete(w.id); } catch (eR3) {}
            }
            var attachedByUs = global.__ijFindAttachedWindows && global.__ijFindAttachedWindows.has(w.id);
            var ownedByIjFind = !!(attachedByUs || bridge || reload || consoleBridge);
            var hasKnownOtherBridge = !!(global.__irGoToTypeBridgeListeners && global.__irGoToTypeBridgeListeners.has(w.id));
            if (ownedByIjFind && !hasKnownOtherBridge) {
              try {
                if (w.webContents.debugger && w.webContents.debugger.isAttached()) {
                  w.webContents.debugger.detach();
                  detached++;
                }
              } catch (eDetach) {}
            }
            if (ownedByIjFind) {
              try { global.__ijFindAttachedWindows.delete(w.id); } catch (eDelAttached) {}
            }
          } catch (e) {}
        }
        try {
          if (global.__ijFindMainHttpBridge && global.__ijFindMainHttpBridge.server) {
            try { global.__ijFindMainHttpBridge.server.close(); } catch (eMainHttpClose) {}
            try { delete global.__ijFindMainHttpBridge; } catch (eMainHttpDelete) {}
          }
        } catch (eMainHttp) {}
        if (closeMainInspector) {
          try {
            require('inspector').close();
          } catch (eCloseInspector) {}
        }
        return 'removed=' + removed + ' detached=' + detached + ' inspector=' + (closeMainInspector ? 'closed' : 'kept');
      })()
    `.trim();
    try {
      const resp = await this.send('Runtime.evaluate', {
        expression: script,
        includeCommandLineAPI: true,
        returnByValue: true,
      }, timeoutMs);
      const report = String(resp?.result?.value ?? '(no result)');
      this.log.appendLine(`Renderer bridge released (${reason}): ${report}`);
      return report;
    } finally {
      this.closeCdpWebSocket(`renderer bridge released:${reason}`);
      if (sourceWindowId === undefined || this.activeWindowId === sourceWindowId) {
        this.activeWindowId = undefined;
      }
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
    // If VS Code's main inspector is already open, reuse it without sending
    // SIGUSR1 again. Re-signalling the main process on every Search UI open
    // keeps the shared inspector hot and has shown up as renderer jank.
    let inspector = await this.findInspectorWebSocketForPid(mainPid, { rounds: 1, fetchTimeoutMs: 50, probeTimeoutMs: 120 });
    let wsUrl = inspector.wsUrl;
    if (!wsUrl) {
      await this.closeStaleIjFindInspectorBlockingTarget(mainPid);
      this.log.appendLine(`Main PID ${mainPid}: sending SIGUSR1`);
      try { process.kill(mainPid, 'SIGUSR1'); } catch (e) {
        throw new Error(`SIGUSR1 to pid ${mainPid} failed: ${e instanceof Error ? e.message : e}`);
      }
      inspector = await this.findInspectorWebSocketForPid(mainPid);
      wsUrl = inspector.wsUrl;
      if (!wsUrl && await this.closeStaleIjFindInspectorBlockingTarget(mainPid)) {
        this.log.appendLine(`Main PID ${mainPid}: retrying SIGUSR1 after closing stale inspector`);
        try { process.kill(mainPid, 'SIGUSR1'); } catch (e) {
          throw new Error(`SIGUSR1 retry to pid ${mainPid} failed: ${e instanceof Error ? e.message : e}`);
        }
        inspector = await this.findInspectorWebSocketForPid(mainPid);
        wsUrl = inspector.wsUrl;
      }
    } else {
      this.log.appendLine(`Main PID ${mainPid}: reusing existing inspector`);
    }
    if (!wsUrl) { throw new Error(`CDP inspector for VSCode main pid ${mainPid} did not come up`); }
    const tInspector = Date.now();
    this.log.appendLine(
      `Inspector for pid ${mainPid} up on port ${inspector.port ?? '?'} after ${tInspector - tStart}ms ` +
      `(${inspector.attempts} polls)`,
    );

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
      const pending = Array.from(this.pending.values());
      this.pending.clear();
      for (const cb of pending) {
        try { cb({ error: { message: 'CDP WebSocket closed' } }); } catch {}
      }
      this.ws = undefined;
    });

    await this.send('Runtime.enable', {});
    await this.send('Runtime.addBinding', { name: BRIDGE_BINDING });

    const report = await this.runPatchScript();
    this.log.appendLine(`Injection: ${report}`);
    if (!/\bok:/.test(String(report))) {
      throw new Error(`Renderer patch did not install: ${report}`);
    }
    // Keep diagnostics layout-free. The old full status probe touched
    // getBoundingClientRect/getComputedStyle inside the VS Code renderer.
    if (this.isRendererSafetyDiagnosticsEnabled()) {
      void this.probeRendererSafety('post-install', 700);
    }
  }

  /** Re-run the renderer patch in every workbench window. Windows that
   *  already have the patch return 'already patched' and are no-ops; windows
   *  that missed the initial injection (e.g., a brand-new VSCode window whose
   *  renderer wasn't ready yet) get a fresh attempt. */
  private async runPatchScript(targetWindowId?: number): Promise<string> {
    // Pass the patch script directly as the expression — no base64/atob round-trip,
    // which previously corrupted any non-ASCII characters (they arrived as raw UTF-8
    // bytes through atob and broke the parser).
    const localBridge = await this.ensureLocalBridgeServer();
    const patchExpr = getRendererPatchScript(
      this.isMonacoCaptureEnabled(),
      this.isRendererPerfDiagnosticsEnabled(),
      this.shouldSuspendIntelliSenseRecursionCapture(),
      this.shouldEnableRendererInlayClickHook(),
      this.shouldDisposeRendererPatchOnHide(),
    );
    const rendererReadyExpr =
      `(function(){try{return window.__ijFindShow&&window.__ijFindOnMessage&&` +
      `window.__ijFindLightStatus&&window.__ijFindPatchVersion===${RENDERER_PATCH_VERSION}` +
      `?'ready':'missing'}catch(e){return 'err:'+(e&&e.message)}})()`;
    const workspaceName = this.getExpectedWorkspaceName();
    const markerText = this.targetWindowMarkerText || '';
    const markerProbeExpr = this.buildTargetMarkerProbeExpression(markerText);

    const injectScript = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var patchExpr = ${JSON.stringify(patchExpr)};
        var rendererReadyExpr = ${JSON.stringify(rendererReadyExpr)};
        var rendererBindingName = ${JSON.stringify(RENDERER_BINDING)};
        var mainBridgeBindingName = ${JSON.stringify(BRIDGE_BINDING)};
        var localBridgePort = ${JSON.stringify(localBridge.port)};
        var localBridgeToken = ${JSON.stringify(localBridge.token)};
        var closeMainInspector = ${JSON.stringify(this.shouldCloseMainInspector())};
        var targetWindowId = ${targetWindowId === undefined ? 'undefined' : JSON.stringify(targetWindowId)};
        var expectedWorkspaceName = ${JSON.stringify(workspaceName)};
        var expectedWorkspaceNameLower = expectedWorkspaceName.toLowerCase();
        var markerText = ${JSON.stringify(markerText)};
        var markerProbeExpr = ${JSON.stringify(markerProbeExpr)};
        function isWorkbench(win) {
          try {
            var url = (win.webContents && win.webContents.getURL && win.webContents.getURL()) || '';
            return /workbench\\.(?:esm\\.)?html(?:\\?|#|$)/.test(url);
          } catch (e) { return false; }
        }
        function getWorkbenchWindows() {
          var wins = BW.getAllWindows();
          var workbenches = [];
          for (var i = 0; i < wins.length; i++) {
            if (isWorkbench(wins[i])) { workbenches.push(wins[i]); }
          }
          return workbenches;
        }
        function titleMatchesWorkspace(win) {
          if (!expectedWorkspaceNameLower) { return true; }
          try {
            var title = (win.getTitle && win.getTitle()) || '';
            return title.toLowerCase().indexOf(expectedWorkspaceNameLower) >= 0;
          } catch (e) { return false; }
        }
        async function hasMarker(win) {
          if (!markerText) { return false; }
          try {
            return await win.webContents.executeJavaScript(markerProbeExpr, true) === true;
          } catch (e) { return false; }
        }
        async function selectTargetWindow() {
          if (typeof targetWindowId === 'number') {
            var byId = BW.fromId(targetWindowId);
            if (byId && isWorkbench(byId) && (!markerText || await hasMarker(byId))) { return byId; }
          }
          var all = getWorkbenchWindows();
          if (markerText) {
            for (var m = 0; m < all.length; m++) {
              if (await hasMarker(all[m])) { return all[m]; }
            }
            if (all.length === 1) { return all[0]; }
            return null;
          }
          var focused = BW.getFocusedWindow();
          if (focused && isWorkbench(focused) && titleMatchesWorkspace(focused)) { return focused; }
          var firstWorkbench = null;
          for (var s = 0; s < all.length; s++) {
            if (!isWorkbench(all[s])) { continue; }
            if (!firstWorkbench) { firstWorkbench = all[s]; }
            if (titleMatchesWorkspace(all[s])) { return all[s]; }
          }
          return firstWorkbench;
        }
        var target = await selectTargetWindow();
        if (!target) { return 'skip:no-target' + (markerText ? ':marker-miss' : ''); }
        var wins = target ? [target] : [];
        var results = [];
        var bridgePrefix = '__IJSS_BRIDGE__';
        function installConsoleBridge(w) {
          if (!global.__ijFindConsoleBridgeListeners) { global.__ijFindConsoleBridgeListeners = new Map(); }
          var prev = global.__ijFindConsoleBridgeListeners.get(w.id);
          if (prev) {
            try { w.webContents.removeListener('console-message', prev); } catch (eRmPrev) {}
          }
          var bridgeWinId = w.id;
          var bridge = function (event) {
            var message = '';
            try {
              if (event && typeof event.message === 'string') {
                message = event.message;
              } else if (arguments.length >= 3 && typeof arguments[2] === 'string') {
                message = arguments[2];
              } else if (arguments.length >= 2 && typeof arguments[1] === 'string') {
                message = arguments[1];
              }
            } catch (eMsg) {}
            if (!message || message.indexOf(bridgePrefix) !== 0) { return; }
            var hasMainBridgeBinding = typeof global[mainBridgeBindingName] === 'function';
            var payload = message.slice(bridgePrefix.length);
            var parsed = null;
            function releaseSelfIfPanelHidden() {
              try {
                if (!parsed || parsed.type !== 'panelHidden') { return; }
                setTimeout(function () {
                  try { w.webContents.removeListener('console-message', bridge); } catch (eConsoleSelfRm) {}
                  try {
                    if (global.__ijFindConsoleBridgeListeners &&
                        global.__ijFindConsoleBridgeListeners.get(bridgeWinId) === bridge) {
                      global.__ijFindConsoleBridgeListeners.delete(bridgeWinId);
                    }
                  } catch (eConsoleSelfDel) {}
                  try {
                    var hasConsoleBridges = !!(global.__ijFindConsoleBridgeListeners && global.__ijFindConsoleBridgeListeners.size);
                    var hasDebuggerBridges = !!(global.__ijFindBridgeListeners && global.__ijFindBridgeListeners.size);
                    var hasReloadBridges = !!(global.__ijFindReloadPatchListeners && global.__ijFindReloadPatchListeners.size);
                    if (closeMainInspector && !hasConsoleBridges && !hasDebuggerBridges && !hasReloadBridges) {
                      try { if (typeof process._debugEnd === 'function') { process._debugEnd(); } } catch (eDebugEnd) {}
                      try { require('inspector').close(); } catch (eInspectorClose) {}
                    }
                  } catch (eMaybeClose) {}
                }, 0);
              } catch (eReleaseSelf) {}
            }
            try {
              parsed = JSON.parse(String(payload));
              if (parsed && typeof parsed === 'object') {
                parsed.__win = bridgeWinId;
                payload = JSON.stringify(parsed);
              }
            } catch (ePayload) {}
            try {
              if (typeof fetch === 'function') {
                fetch('http://127.0.0.1:' + localBridgePort + '/ijss-bridge', {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-ijss-token': localBridgeToken,
                  },
                  body: String(payload),
                }).catch(function () {});
              }
              releaseSelfIfPanelHidden();
              return;
            } catch (eHttpBridge) {}
            try { if (hasMainBridgeBinding) { global[mainBridgeBindingName](payload); } } catch (eForward) {}
            releaseSelfIfPanelHidden();
          };
          w.webContents.on('console-message', bridge);
          global.__ijFindConsoleBridgeListeners.set(w.id, bridge);
        }
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            installConsoleBridge(w);
            var status = 'missing';
            try { status = await w.webContents.executeJavaScript(rendererReadyExpr, true); } catch (eStatus) { status = 'status-err:' + eStatus.message; }
            var val = status === 'ready'
              ? 'already patched:fast'
              : await w.webContents.executeJavaScript(patchExpr, true);
            if (val === 'ij-find patch installed' || String(val).indexOf('already patched') === 0) {
              results.push('ok:' + w.id + ':' + val);
              try {
                if (!global.__ijFindBridgeListeners) { global.__ijFindBridgeListeners = new Map(); }
                var prev = global.__ijFindBridgeListeners.get(w.id);
                if (prev) {
                  try { w.webContents.debugger.removeListener('message', prev); } catch (eRm) {}
                  try { global.__ijFindBridgeListeners.delete(w.id); } catch (eDelBridge) {}
                }
                if (!global.__ijFindReloadPatchListeners) { global.__ijFindReloadPatchListeners = new Map(); }
                var prevReload = global.__ijFindReloadPatchListeners.get(w.id);
                if (prevReload) {
                  try { w.webContents.removeListener('did-finish-load', prevReload); } catch (eR1) {}
                  try { w.webContents.removeListener('dom-ready', prevReload); } catch (eR2) {}
                  try { global.__ijFindReloadPatchListeners.delete(w.id); } catch (eDelReload) {}
                }
                var attachedByUs = global.__ijFindAttachedWindows && global.__ijFindAttachedWindows.has(w.id);
                if (attachedByUs) {
                  try { w.webContents.debugger.detach(); } catch (eDetachOld) {}
                  try { global.__ijFindAttachedWindows.delete(w.id); } catch (eDelAttachedOld) {}
                }
              } catch (eb) { results.push('cleanup-err:' + w.id + ':' + eb.message); }
            } else {
              results.push('skip:' + w.id + ':val=' + String(val));
            }
          } catch (e) {
            results.push('err:' + w.id + ':' + e.message);
          }
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
    if (resp?.exceptionDetails) {
      return `exception:${resp.exceptionDetails.text || ''}:${resp.exceptionDetails.exception?.description || ''}`;
    }
    const report = String(resp?.result?.value ?? '(no result)');
    return report;
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
      const name = msg.params?.name;
      if (name === BRIDGE_BINDING) {
        this.handleRendererEvent(String(msg.params.payload));
      }
    }
  }

  private handleRendererEvent(payload: string) {
    let evt: RendererEvent & { __seq?: number; __src?: string; __win?: number };
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
    if (Date.now() < this.rendererRecoveryUntil && evt.type !== 'log') {
      this.log.appendLine(`drop renderer event during recovery: type=${(evt as any).type}`);
      return;
    }
	    if (
	      typeof evt.__win === 'number' &&
	      this.activeWindowId !== undefined &&
	      evt.__win !== this.activeWindowId &&
	      evt.type !== 'log' &&
	      evt.type !== 'trace'
	    ) {
	      this.log.appendLine(`ignore renderer event from inactive win=${evt.__win} active=${this.activeWindowId} type=${(evt as any).type}`);
	      return;
	    }
    switch (evt.type) {
      case 'search':
        if (evt.recordHistory) {
          void this.recordSearchHistory(evt.options.query).catch((err) => {
            this.log.appendLine(`record search history failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        void this.runSearch(evt.options);
        break;
      case 'loadMore': void this.loadMoreSearch(); break;
      case 'cancel':
        this.currentSearchSession = undefined;
        this.cancelActive();
        break;
      case 'panelHidden':
        this.currentSearchSession = undefined;
        this.cancelActive();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.scheduleCdpIdleClose(evt.__win);
        }
        break;
      case 'openFile': void this.openFile(evt.uri, evt.line, evt.column, false); break;
      case 'previewFile': void this.openFile(evt.uri, evt.line, evt.column, true); break;
      case 'requestPreview': void this.handlePreviewRequest(evt); break;
      case 'revealFile': void this.revealFile(evt.uri); break;
      case 'openInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, true, true); break;
      case 'pinInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, false, false); break;
	      case 'requestHover': void this.sendHover(evt.reqId, evt.uri, evt.line, evt.column, evt.x, evt.y); break;
	      case 'runCommand': void this.runHoverCommand(evt.command, evt.args); break;
	      case 'saveFile': void this.saveFile(evt.uri, evt.content); break;
	      case 'trace':
	        this.log.appendLine(
	          `[renderer-trace${typeof evt.__win === 'number' ? ` win=${evt.__win}` : ''}` +
	          `${typeof evt.__seq === 'number' ? ` seq=${evt.__seq}` : ''}] ` +
	          `${evt.phase} ${JSON.stringify({ data: evt.data ?? null, light: evt.light ?? null, ir: evt.ir ?? null, perf: evt.perf ?? null })}`,
	        );
	        break;
	      case 'log': this.log.appendLine(`[renderer${typeof evt.__win === 'number' ? ` win=${evt.__win}` : ''}] ${evt.msg}`); break;
	    }
  }

  private async openInSideEditor(uriStr: string, line: number, column: number, preview: boolean, preserveFocus: boolean) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      // Double-click / Enter routing: focus the file's EXISTING tab when
      // it's already open anywhere, otherwise open a fresh non-preview tab
      // in column 1. Prior behaviour was Beside (always split), which left
      // a duplicate tab next to the overlay's stolen preview every time.
      let existingColumn: vscode.ViewColumn | undefined;
      try {
        const groups = (vscode.window as any).tabGroups?.all ?? [];
        outer: for (const group of groups) {
          for (const tab of group.tabs ?? []) {
            const input = tab.input;
            if (input && typeof input === 'object' && 'uri' in input && (input as any).uri?.toString() === uriStr) {
              existingColumn = group.viewColumn;
              break outer;
            }
          }
        }
      } catch {}
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: existingColumn ?? vscode.ViewColumn.One,
        preserveFocus,
        preview,
        selection: new vscode.Range(pos, pos),
      });
    } catch (err) {
      this.log.appendLine(`openInSideEditor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async revealFile(uriStr: string) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch (err) {
      this.log.appendLine(`revealFile failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Failed to reveal file: ${err instanceof Error ? err.message : err}`);
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
    this.cancelCdpSearchIdleClose();
    if (this.activeWindowId !== undefined) {
      await this.ensureMonacoCapture(this.activeWindowId);
    }
    await this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges);
    this.scheduleCdpSearchIdleClose('preview-delivered');
  }

  private async sendPreview(uriStr: string, line: number, contextLines: number, ranges: MatchRange[] | undefined) {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const allLines = doc.getText().split(/\r?\n/);
      // This preview is rendered inside the VS Code workbench renderer. Sending
      // the whole file makes the search overlay compete with the editor UI
      // itself, so keep the payload intentionally small and centered on the hit.
      const DEFAULT_CONTEXT_LINES = 24;
      const MAX_PREVIEW_LINES = 120;
      const MAX_PREVIEW_LINE_CHARS = 1000;
      const requestedContext = Number.isFinite(contextLines)
        ? Math.max(0, Math.floor(contextLines))
        : DEFAULT_CONTEXT_LINES;
      const halfWindow = Math.min(
        requestedContext,
        Math.floor(MAX_PREVIEW_LINES / 2),
      );
      const targetLine = Math.max(0, Math.min(line, Math.max(0, allLines.length - 1)));
      let start = Math.max(0, targetLine - halfWindow);
      let end = Math.min(allLines.length, targetLine + halfWindow + 1);
      if (end - start > MAX_PREVIEW_LINES) {
        end = start + MAX_PREVIEW_LINES;
      }
      if (end - start < MAX_PREVIEW_LINES && start > 0) {
        start = Math.max(0, end - MAX_PREVIEW_LINES);
      }
      const lines: PreviewLine[] = [];
      for (let i = start; i < end; i++) {
        const raw = allLines[i] ?? '';
        const text = raw.length > MAX_PREVIEW_LINE_CHARS
          ? `${raw.slice(0, MAX_PREVIEW_LINE_CHARS)}...`
          : raw;
        lines.push({ lineNumber: i, text });
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
    if (this.isMonacoCaptureDisabled()) {
      return;
    }
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

  private baseSearchOptions(options: SearchOptions): SearchOptions {
    return {
      query: options.query,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      useRegex: options.useRegex,
      regexMultiline: options.regexMultiline,
      includePatterns: options.includePatterns ? [...options.includePatterns] : undefined,
      excludePatterns: options.excludePatterns ? [...options.excludePatterns] : undefined,
    };
  }

  private async runSearch(options: SearchOptions) {
    this.cancelActive();
    const searchId = ++this.searchSeq;
    const requestedEngine = getConfiguredSearchEngine();
    const emptyPageSize = getConfiguredResultLimit();
    if (!options.query) {
      this.currentSearchSession = {
        searchId,
        options: this.baseSearchOptions(options),
        requestedEngine,
        effectiveEngine: requestedEngine,
        pageSize: emptyPageSize,
        loadedMatches: 0,
        loadedUris: new Set<string>(),
        hasMore: false,
        orderedCandidatePaths: null,
        scopedCandidateUris: null,
      };
      await this.postToRenderer({ type: 'results:start', searchId });
      await this.postToRenderer({
        type: 'results:done',
        searchId,
        totalFiles: 0,
        totalMatches: 0,
        truncated: false,
        pageSize: emptyPageSize,
        pageFiles: 0,
        pageMatches: 0,
        offset: 0,
      });
      return;
    }
    let effectiveEngine: SearchEngine = requestedEngine;
    let fallbackReason: string | undefined;
    if (requestedEngine === 'zoekt') {
      if (options.excludePatterns && options.excludePatterns.length > 0) {
        effectiveEngine = 'codesearch';
        fallbackReason = 'scope exclude patterns require codesearch';
      } else {
        const readiness = await this.zoektRuntime.getSearchReadiness();
        if (!readiness.ready) {
          effectiveEngine = 'codesearch';
          fallbackReason = readiness.reason;
        }
      }
    }
    const pageSize = getConfiguredResultLimit();
    const session: SearchSession = {
      searchId,
      options: this.baseSearchOptions(options),
      requestedEngine,
      effectiveEngine,
      pageSize,
      loadedMatches: 0,
      loadedUris: new Set<string>(),
      hasMore: false,
      orderedCandidatePaths: null,
      scopedCandidateUris: null,
    };
    this.currentSearchSession = session;
    await this.postToRenderer({ type: 'results:start', searchId });
    const t0 = Date.now();
    const optTags = [
      requestedEngine === effectiveEngine ? `engine=${requestedEngine}` : `engine=${requestedEngine}->${effectiveEngine}`,
      options.useRegex ? 'regex' : '',
      options.caseSensitive ? 'case' : '',
      options.wholeWord ? 'word' : '',
      (isRegexMultilineEnabled(options) || (!options.useRegex && options.query.includes('\n'))) ? 'multiline' : '',
      options.includePatterns && options.includePatterns.length > 0 ? `include=${options.includePatterns.length}` : '',
      options.excludePatterns && options.excludePatterns.length > 0 ? `exclude=${options.excludePatterns.length}` : '',
    ].filter(Boolean).join(',') || 'plain';
    const plannerSummary = effectiveEngine === 'zoekt'
      ? 'planner=zoekt'
      : `indexReady=${this.trigramIndex.isReady} indexSize=${this.trigramIndex.size}`;
    this.log.appendLine(
      `search start: len=${options.query.length} flags=[${optTags}] ${plannerSummary}`,
    );
    if (requestedEngine === 'zoekt' && effectiveEngine === 'codesearch') {
      this.log.appendLine(
        `Search engine zoekt selected; using codesearch fallback${fallbackReason ? ` (${fallbackReason})` : ''}.`,
      );
    }
    try {
      if (effectiveEngine === 'zoekt') {
        await this.runSearchPage(session, t0);
        return;
      }
      // Cox's codesearch planner narrows rg's file set. If the index
      // returns null, the planner couldn't constrain — rg walks the whole
      // workspace. If the index returns an empty set, the regex can't
      // match anything.
      const { uris: candidates, reason } = this.trigramIndex.candidatesFor(options.query, {
        useRegex: options.useRegex,
        regexMultiline: options.regexMultiline,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
      });
      const pathScopeMatcher = compilePathScopeMatcher(options.includePatterns, options.excludePatterns);
      const scopedCandidates = candidates && pathScopeMatcher
        ? (() => {
            const filtered = new Set<string>();
            for (const u of candidates) {
              try {
                const uri = vscode.Uri.parse(u);
                if (pathScopeMatcher(vscode.workspace.asRelativePath(uri, false))) {
                  filtered.add(u);
                }
              } catch {}
            }
            return filtered;
          })()
        : candidates;
      if (scopedCandidates) {
        this.log.appendLine(
          `TrigramIndex candidates: ${scopedCandidates.size} via ${reason}`,
        );
      } else {
        this.log.appendLine(`TrigramIndex candidates: null (${reason}) — rg will full-scan workspace`);
      }
      session.scopedCandidateUris = scopedCandidates;
      if (scopedCandidates) {
        if (scopedCandidates.size === 0) {
          this.log.appendLine(`search done: 0 matches (candidates empty) in ${Date.now() - t0}ms`);
          await this.postToRenderer({
            type: 'results:done',
            searchId,
            totalFiles: 0,
            totalMatches: 0,
            truncated: false,
            pageSize: session.pageSize,
            pageFiles: 0,
            pageMatches: 0,
            offset: 0,
          });
          return;
        }
        // Order candidates by relevance once per search session. Later
        // pagination reuses the same order so offset-based reruns don't
        // duplicate or skip matches when the user's open tabs change.
        const uris: vscode.Uri[] = [];
        for (const u of scopedCandidates) {
          try { uris.push(vscode.Uri.parse(u)); } catch {}
        }
        const ordered = prioritizeFiles(uris);
        session.orderedCandidatePaths = ordered.map((u) => u.fsPath);
        const MAX_PENDING = 400;
        const head = ordered.slice(0, MAX_PENDING);
        const sample = head.map((u) => ({
          uri: u.toString(),
          relPath: vscode.workspace.asRelativePath(u, false),
        }));
        const relPaths = ordered.map((u) => vscode.workspace.asRelativePath(u, false));
        const head3 = relPaths.slice(0, 3).join(' | ');
        const tail3 = relPaths.length > 6 ? ' ... ' + relPaths.slice(-3).join(' | ') : '';
        this.log.appendLine(
          `candidates sample [${relPaths.length}]: ${head3}${tail3}`,
        );
        void this.postToRenderer({
          type: 'results:candidates',
          searchId,
          candidates: sample,
          total: session.orderedCandidatePaths.length,
        });
      }
      await this.runSearchPage(session, t0);
    } finally {
      if (this.currentSearchSession === session && session.loadedMatches === 0 && !session.hasMore) {
        // Keep the session only while the same query is still the current one.
        // Non-empty sessions are retained so scroll-driven pagination can
        // request the next page after the initial batch completes.
        this.currentSearchSession = session;
      }
    }
  }

  private async loadMoreSearch() {
    const session = this.currentSearchSession;
    if (!session || !session.hasMore) { return; }
    if (this.activeSearch) { return; }
    this.log.appendLine(
      `search loadMore: offset=${session.loadedMatches} pageSize=${session.pageSize} queryLen=${session.options.query.length}`,
    );
    await this.runSearchPage(session, Date.now());
  }

  private async runSearchPage(session: SearchSession, startedAt: number): Promise<void> {
    const cts = new vscode.CancellationTokenSource();
    this.activeSearch = cts;
    const offset = session.loadedMatches;
    let batchMatches = 0;
    const batchUris = new Set<string>();
    let pendingMatches: FileMatch[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushChain: Promise<void> = Promise.resolve();
    const flushPendingMatches = (): Promise<void> => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pendingMatches.length === 0) { return flushChain; }
      const matches = pendingMatches;
      pendingMatches = [];
      flushChain = flushChain.then(() => this.postToRenderer({
        type: 'results:batch',
        searchId: session.searchId,
        matches,
      }));
      return flushChain;
    };
    const scheduleFlush = () => {
      if (flushTimer) { return; }
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushPendingMatches();
      }, 25);
    };
    const progress = {
      onFile: (m: FileMatch) => {
        if (cts.token.isCancellationRequested || this.currentSearchSession !== session) { return; }
        batchMatches += m.matches.length;
        batchUris.add(m.uri);
        pendingMatches.push(m);
        if (pendingMatches.length >= 32) {
          void flushPendingMatches();
        } else {
          scheduleFlush();
        }
      },
      onDone: (s: { totalFiles: number; totalMatches: number; truncated: boolean }) => {
        if (cts.token.isCancellationRequested || this.currentSearchSession !== session) { return; }
        void (async () => {
          await flushPendingMatches();
          if (cts.token.isCancellationRequested || this.currentSearchSession !== session) { return; }
          for (const uri of batchUris) { session.loadedUris.add(uri); }
          session.loadedMatches += batchMatches;
          session.hasMore = s.truncated;
          this.log.appendLine(
            `search page done: batch=${batchMatches} loaded=${session.loadedMatches} files=${session.loadedUris.size} more=${session.hasMore} elapsed=${Date.now() - startedAt}ms offset=${offset}`,
          );
          await this.postToRenderer({
            type: 'results:done',
            searchId: session.searchId,
            totalFiles: session.loadedUris.size,
            totalMatches: session.loadedMatches,
            truncated: session.hasMore,
            pageSize: session.pageSize,
            pageFiles: batchUris.size,
            pageMatches: batchMatches,
            offset,
          });
          if (this.isRendererSafetyDiagnosticsEnabled()) {
            void this.probeRendererSafety('search-page-done', 700);
          }
          this.scheduleCdpSearchIdleClose('search-page-done');
        })();
      },
      onError: (e: Error) => {
        if (this.currentSearchSession !== session) { return; }
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        pendingMatches = [];
        void this.postToRenderer({ type: 'results:error', searchId: session.searchId, message: e.message });
      },
    };
    const pageOptions: SearchOptions = {
      ...session.options,
      resultOffset: offset,
      resultLimit: session.pageSize,
    };
    try {
      if (session.effectiveEngine === 'codesearch') {
        const rgPath = findRipgrepPath();
        if (rgPath) {
          await runRgSearch(
            pageOptions,
            cts.token,
            progress,
            session.orderedCandidatePaths,
            (m) => this.log.appendLine(m),
          );
        } else {
          this.log.appendLine('rg not found — falling back to JS scan.');
          await runSearch(pageOptions, cts.token, progress, session.scopedCandidateUris);
        }
      } else {
        const readiness = await this.zoektRuntime.runSearch(pageOptions, cts.token, progress);
        if (!readiness.ready && !cts.token.isCancellationRequested) {
          session.effectiveEngine = 'codesearch';
          this.log.appendLine(
            `zoek-rs runtime unavailable${readiness.reason ? ` (${readiness.reason})` : ''} — falling back to codesearch.`,
          );
          const rgPath = findRipgrepPath();
          if (rgPath) {
            await runRgSearch(
              pageOptions,
              cts.token,
              progress,
              session.orderedCandidatePaths,
              (m) => this.log.appendLine(m),
            );
          } else {
            await runSearch(pageOptions, cts.token, progress, session.scopedCandidateUris);
          }
        }
      }
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (this.activeSearch === cts) {
        this.activeSearch.dispose();
        this.activeSearch = undefined;
      }
    }
  }

  private async postToRenderer(msg: OverlayMessage) {
    if (this.activeWindowId === undefined) { return; }
    const windowId = this.activeWindowId;
    const payload = JSON.stringify(msg);
    const js = `(function(){try{if(!window.__ijFindOnMessage){return 'missing-onmessage'};window.__ijFindOnMessage(${payload});return 'ok'}catch(e){return 'err:'+(e&&e.message)}})()`;
    const deliver = async () => {
      try {
        await this.ensureInjected();
        const timeoutMs = 1000;
        const result = await Promise.race([
          this.evalInWindow(windowId, js),
          delay(timeoutMs).then(() => {
            throw new Error(`timed out after ${timeoutMs}ms`);
          }),
        ]);
        if (result === 'missing-onmessage') {
          await this.ensureRendererPatchAlive(windowId, 'postToRenderer');
          await this.evalInWindow(windowId, js);
        }
      } catch (err) {
        this.log.appendLine(`postToRenderer failed: ${err instanceof Error ? err.message : err}`);
      }
    };
    const next = this.rendererPostChain.then(deliver, deliver);
    this.rendererPostChain = next.then(() => undefined, () => undefined);
    await next;
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

  private send(method: string, params: any, timeoutMs = 10_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, (resp) => {
        if (timer) { clearTimeout(timer); }
        if (resp.error) { reject(new Error(resp.error.message || 'CDP error')); }
        else { resolve(resp.result); }
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        if (timer) { clearTimeout(timer); }
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private async findInspectorWebSocketForPid(
    pid: number,
    options: { rounds?: number; fetchTimeoutMs?: number; probeTimeoutMs?: number } = {},
  ): Promise<{ wsUrl?: string; port?: number; attempts: number }> {
    const ports: number[] = [];
    for (let port = 9229; port <= 9249; port++) { ports.push(port); }
    const knownWrongTargets = new Set<string>();
    let attempts = 0;
    const rounds = Math.max(1, Math.min(80, options.rounds ?? 80));
    const fetchTimeoutMs = Math.max(25, Math.min(500, options.fetchTimeoutMs ?? 150));
    const probeTimeoutMs = Math.max(50, Math.min(1000, options.probeTimeoutMs ?? 350));
    for (let round = 0; round < rounds; round++) {
      for (const port of ports) {
        let targets: any;
        try {
          attempts++;
          targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, fetchTimeoutMs);
        } catch {
          continue;
        }
        if (!Array.isArray(targets)) { continue; }
        for (const target of targets) {
          const wsUrl = String(target?.webSocketDebuggerUrl || '');
          if (!wsUrl || knownWrongTargets.has(wsUrl)) { continue; }
          const inspectorPid = (await this.probeInspectorInfo(wsUrl, probeTimeoutMs)).pid;
          if (inspectorPid === pid) {
            return { wsUrl, port, attempts };
          }
          if (inspectorPid !== undefined) {
            knownWrongTargets.add(wsUrl);
          }
        }
      }
      await delay(25);
    }
    return { attempts };
  }

  private async closeStaleIjFindInspectorBlockingTarget(targetPid: number): Promise<boolean> {
    let targets: any;
    try {
      targets = await fetchJson('http://127.0.0.1:9229/json/list', 150);
    } catch {
      return false;
    }
    if (!Array.isArray(targets)) { return false; }
    for (const target of targets) {
      const wsUrl = String(target?.webSocketDebuggerUrl || '');
      if (!wsUrl) { continue; }
      const info = await this.probeInspectorInfo(wsUrl, 350);
      if (!info.pid || info.pid === targetPid || !info.ownedByIjFind) { continue; }
      const report = await this.evaluateInspectorExpression(wsUrl, `
        (function () {
          var removed = 0;
          var detached = 0;
          try {
            var BW = require('electron').BrowserWindow;
            if (global.__ijFindConsoleBridgeListeners) {
              try {
                global.__ijFindConsoleBridgeListeners.forEach(function (listener, id) {
                  try {
                    var w = BW.fromId(Number(id));
                    if (w && w.webContents) {
                      w.webContents.removeListener('console-message', listener);
                      removed++;
                    }
                  } catch (eConsoleRemoveOne) {}
                });
              } catch (eConsoleRemoveEach) {}
              try { global.__ijFindConsoleBridgeListeners.clear(); } catch (eConsoleClear) {}
            }
            if (global.__ijFindBridgeListeners) {
              try {
                global.__ijFindBridgeListeners.forEach(function (listener, id) {
                  try {
                    var w = BW.fromId(Number(id));
                    if (w && w.webContents) {
                      w.webContents.debugger.removeListener('message', listener);
                      removed++;
                    }
                  } catch (eRemoveOne) {}
                });
              } catch (eRemoveEach) {}
              try { global.__ijFindBridgeListeners.clear(); } catch (eClear) {}
            }
            if (global.__ijFindReloadPatchListeners) {
              try {
                global.__ijFindReloadPatchListeners.forEach(function (listener, id) {
                  try {
                    var w = BW.fromId(Number(id));
                    if (w && w.webContents) {
                      w.webContents.removeListener('did-finish-load', listener);
                      w.webContents.removeListener('dom-ready', listener);
                    }
                  } catch (eReloadOne) {}
                });
              } catch (eReloadEach) {}
              try { global.__ijFindReloadPatchListeners.clear(); } catch (eReloadClear) {}
            }
            if (global.__ijFindAttachedWindows) {
              try {
                global.__ijFindAttachedWindows.forEach(function (id) {
                  try {
                    var w = BW.fromId(Number(id));
                    if (w && w.webContents && w.webContents.debugger && w.webContents.debugger.isAttached()) {
                      w.webContents.debugger.detach();
                      detached++;
                    }
                  } catch (eDetachOne) {}
                });
              } catch (eDetachEach) {}
              try { global.__ijFindAttachedWindows.clear(); } catch (eAttachedClear) {}
            }
          } catch (eCleanup) {}
          try { delete global[${JSON.stringify(BRIDGE_BINDING)}]; } catch (eDeleteBridge) {}
          try {
            setTimeout(function () {
              try {
                if (typeof process._debugEnd === 'function') { process._debugEnd(); }
              } catch (eDebugEnd) {}
              try { require('inspector').close(); } catch (eCloseInspector) {}
            }, 0);
          } catch (eScheduleClose) {}
          return 'pid=' + process.pid + ' removed=' + removed + ' detached=' + detached + ' inspector=closing';
        })()
      `.trim(), 700);
      const targetId = String(target?.id || '');
      if (targetId) {
        try { await fetchText(`http://127.0.0.1:9229/json/close/${encodeURIComponent(targetId)}`, 150); } catch {}
      }
      this.log.appendLine(
        `Closed stale IJSS inspector blocking pid ${targetPid}: stalePid=${info.pid} report=${String(report)}`,
      );
      await delay(350);
      return true;
    }
    return false;
  }

  private async probeInspectorInfo(
    wsUrl: string,
    timeoutMs: number,
  ): Promise<{ pid?: number; ownedByIjFind: boolean }> {
    const value = await this.evaluateInspectorExpression(wsUrl, `
      (function () {
        try {
          return {
            pid: typeof process !== 'undefined' ? process.pid : 0,
            ownedByIjFind: !!(
              global.__ijFindBridgeListeners ||
              global.__ijFindConsoleBridgeListeners ||
              global.__ijFindAttachedWindows ||
              global.__ijFindReloadPatchListeners ||
              global[${JSON.stringify(BRIDGE_BINDING)}]
            )
          };
        } catch (e) {
          return { pid: 0, ownedByIjFind: false };
        }
      })()
    `.trim(), timeoutMs);
    const pid = Number((value as any)?.pid ?? 0);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      ownedByIjFind: Boolean((value as any)?.ownedByIjFind),
    };
  }

  private evaluateInspectorExpression(wsUrl: string, expression: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve) => {
      let settled = false;
      let ws: WebSocket | undefined;
      const done = (value: any) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        try { ws?.close(); } catch {}
        resolve(value);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      try {
        ws = new WebSocket(wsUrl);
        ws.on('open', () => {
          try {
            ws?.send(JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression,
                returnByValue: true,
              },
            }));
          } catch {
            done(undefined);
          }
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(String(data));
            if (msg.id !== 1) { return; }
            if (msg?.result?.exceptionDetails) {
              done(undefined);
              return;
            }
            done(msg?.result?.result?.value);
          } catch {
            done(undefined);
          }
        });
        ws.on('error', () => done(undefined));
        ws.on('close', () => done(undefined));
      } catch {
        done(undefined);
      }
    });
  }

  private isVscodeMainProcessCommand(cmd: string): boolean {
    if (/Helper(?:\.app|\s|\))/.test(cmd)) { return false; }
    const patterns: RegExp[] = [
      /\/Visual Studio Code\.app\/Contents\/MacOS\/(?:Electron|Code)(?:\s|$)/,
      /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\/(?:Electron|Code - Insiders)(?:\s|$)/,
      /\/VSCodium\.app\/Contents\/MacOS\/(?:Electron|VSCodium)(?:\s|$)/,
      /\/Code - OSS\.app\/Contents\/MacOS\/(?:Electron|Code - OSS)(?:\s|$)/,
      /\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/,
    ];
    return patterns.some((p) => p.test(cmd));
  }

  private findMainPid(): number | null {
    // Prefer the Electron main process in this extension host's parent chain.
    // A global "first Code.app process" match can attach CDP to another VSCode
    // window group and make the Search UI appear in the wrong workspace.
    try {
      const out = execSync('ps -o pid=,ppid=,command= -ax', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      const lines = out.split('\n');
      const processes = new Map<number, { pid: number; ppid: number; cmd: string }>();
      for (const line of lines) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) { continue; }
        const pid = parseInt(m[1], 10);
        const ppid = parseInt(m[2], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) { continue; }
        processes.set(pid, { pid, ppid, cmd: m[3] });
      }

      let cursor = process.pid;
      const visited = new Set<number>();
      while (cursor > 0 && !visited.has(cursor)) {
        visited.add(cursor);
        const proc = processes.get(cursor);
        if (!proc) { break; }
        if (this.isVscodeMainProcessCommand(proc.cmd)) {
          this.log.appendLine(`findMainPid: ancestor main pid=${proc.pid}`);
          return proc.pid;
        }
        cursor = proc.ppid;
      }

      const directParent = processes.get(process.ppid);
      if (directParent && this.isVscodeMainProcessCommand(directParent.cmd)) {
        this.log.appendLine(`findMainPid: direct parent main pid=${directParent.pid}`);
        return directParent.pid;
      }

      for (const proc of processes.values()) {
        if (this.isVscodeMainProcessCommand(proc.cmd)) {
          this.log.appendLine(`findMainPid: fallback global main pid=${proc.pid}`);
          return proc.pid;
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

function fetchJson(url: string, timeoutMs = 2000): Promise<any> {
  return fetchText(url, timeoutMs).then((data) => JSON.parse(data));
}

function fetchText(url: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { resolve(data); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('HTTP timeout')); });
  });
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        reject(new Error(`request body too large: ${size}`));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
