import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import WebSocket from 'ws';
import {
  runSearch,
  SearchOptions,
  FileMatch,
  MatchRange,
  prioritizeFiles,
  mergeFileMatches,
  getConfiguredResultLimit,
  getRequestedResultLimit,
  isRegexMultilineEnabled,
  getConfiguredSearchEngine,
  searchQueryTerms,
  type SearchForTestsResult,
  type SearchEngine,
} from './search';
import { configureRipgrepInstall, ensureRipgrepInstalled, findRipgrepPath, runRgSearch } from './rgSearch';
import { getRendererPatchScript, RENDERER_PATCH_VERSION } from './rendererPatch';
import { runMonacoCaptureDiagnostic, type CaptureDiagnosticOptions } from './preview/monacoCapture';
import {
  TextMateGrammarCatalog,
  type PreviewTextMateGrammarCatalog,
} from './preview/textMateGrammarCatalog';
import { TrigramIndex, extractTrigramsLower } from './trigramIndex';
import { compilePathScopeMatcher } from './pathScope';
import { ZoektRuntime, type ZoektFreshnessStatus } from './zoekRuntime';
import type { ZoektInfoResponse } from './zoekProtocol';

type RendererEvent =
  | { type: 'search'; options: SearchOptions; recordHistory?: boolean }
  | { type: 'loadMore' }
  | { type: 'cancel' }
  | { type: 'panelHidden' }
  | { type: 'panelDisposed' }
  | { type: 'trace'; phase: string; data?: unknown; light?: unknown; ir?: unknown; perf?: number }
  | { type: 'openFile'; uri: string; line: number; column: number }
  | { type: 'previewFile'; uri: string; line: number; column: number }
  | { type: 'requestPreview'; uri: string; line: number; ranges?: MatchRange[]; contextLines: number; previewSeq?: number }
  | { type: 'requestStandaloneMonaco' }
  | {
      type: 'requestPreviewNativeRecovery';
      uri: string;
      previewSeq?: number;
      attempt?: number;
      reason?: string;
    }
  | {
      type: 'requestPreviewLanguageFeature';
      requestId: number;
      feature: PreviewLanguageFeature;
      uri: string;
      line?: number;
      column?: number;
      context?: Record<string, unknown>;
    }
  | {
      type: 'requestPreviewTextMateGrammar';
      requestId: number;
      kind: 'catalog';
      languageId: string;
    }
  | {
      type: 'requestPreviewTextMateGrammar';
      requestId: number;
      kind: 'asset';
      generation: number;
      assetId: string;
    }
  | { type: 'revealFile'; uri: string }
  | { type: 'openInSideEditor'; uri: string; line: number; column: number }
  | { type: 'pinInSideEditor'; uri: string; line: number; column: number }
  // 'requestHover' was removed in #32 along with the DIY $hoverTooltip.
  | { type: 'runCommand'; command: string; args: unknown[] }
  | {
      type: 'saveFile';
      uri: string;
      content: string;
      requestId?: number;
      expectedContentHash?: string;
    }
  | { type: 'saveFileTooLarge'; uri: string; requestId: number; bytes: number }
  // Compatibility event for renderer patches injected by older builds.
  // Current renderers never emit this because automatic provider probes
  // duplicate Monaco's real hover/completion work.
  | { type: 'requestIntellisenseProbe'; uri: string; line: number; column: number; source: string }
  | { type: 'log'; msg: string };

type PreviewLine = { lineNumber: number; text: string };
export type PreviewCallGraphInlay = {
  line: number;
  column?: number;
  kind: 'usages' | 'callees' | 'impl';
  text: string;
  symbolId: string;
  label?: string;
  count?: number;
};
export type PreviewCallGraphInlayProvider = (
  uri: vscode.Uri,
  document: vscode.TextDocument,
  range: vscode.Range,
) => Promise<PreviewCallGraphInlay[]> | PreviewCallGraphInlay[];
// HoverContent type removed in #32 along with sendHover()/$hoverTooltip.

type PreviewLanguageFeature =
  | 'hover'
  | 'completion'
  | 'signatureHelp'
  | 'definition'
  | 'declaration'
  | 'typeDefinition'
  | 'implementation'
  | 'references'
  | 'documentHighlight'
  | 'documentSymbol'
  | 'foldingRange'
  | 'semanticTokens';

type SerializedPosition = { line: number; character: number };
type SerializedRange = { start: SerializedPosition; end: SerializedPosition };
type SerializedMarkdown = {
  value: string;
  isTrusted?: boolean | { enabledCommands: readonly string[] };
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  baseUri?: string;
};

type RendererMessageRoute = {
  windowId?: number;
  rendererSrc?: string;
};

type OverlayMessage =
  | { type: 'estimatedToggle'; visible: boolean; pressed: boolean }
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
  | {
      type: 'preview';
      uri: string;
      relPath: string;
      focusLine: number;
      ranges?: MatchRange[];
      previewSeq?: number;
      lines: PreviewLine[];
      languageId: string;
      baseLine: number;
      fullFile: boolean;
      eol: '\n' | '\r\n';
      diagnostics?: unknown[];
      callGraphInlays?: PreviewCallGraphInlay[];
    }
  | {
      type: 'preview:inlays';
      uri: string;
      previewSeq?: number;
      callGraphInlays: PreviewCallGraphInlay[];
    }
  | {
      type: 'preview:languageFeature';
      requestId: number;
      feature: PreviewLanguageFeature;
      uri: string;
      value?: unknown;
      error?: string;
      documentHash?: string;
    }
  | {
      type: 'preview:textMateGrammar';
      requestId: number;
      kind: 'catalog';
      value?: PreviewTextMateGrammarCatalog;
      error?: string;
    }
  | { type: 'preview:textMateGrammarInvalidated' }
  | {
      type: 'preview:textMateGrammar';
      requestId: number;
      kind: 'asset';
      generation: number;
      assetId: string;
      chunkIndex?: number;
      chunkCount?: number;
      base64?: string;
      byteLength?: number;
      sha256?: string;
      pathHint?: string;
      error?: string;
    }
  | {
      type: 'preview:diagnostics';
      uri: string;
      diagnostics: unknown[];
      documentHash?: string;
    }
  | {
      type: 'preview:saveResult';
      uri: string;
      requestId: number;
      ok: boolean;
      error?: string;
      diagnostics?: unknown[];
      documentHash?: string;
      savedContent?: string;
    }
  // 'hover' renderer message was removed in #32 (DIY hover tooltip is gone).
  ;

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
  rendererSrc?: string;
};

export interface ShowOptions {
  forceLiteral?: boolean;
  suppressSearch?: boolean;
  preferredWindowId?: number;
  spawn?: boolean;
  statusText?: string;
  loading?: boolean;
  preservePreview?: boolean;
}

type PendingShow = {
  query: string;
  options?: ShowOptions;
};

type PreviewRequestEvent = Extract<RendererEvent, { type: 'requestPreview' }>;
type PreviewNativeRecoveryRequestEvent = Extract<RendererEvent, { type: 'requestPreviewNativeRecovery' }>;
type PreviewLanguageFeatureRequestEvent = Extract<RendererEvent, { type: 'requestPreviewLanguageFeature' }>;
type PreviewTextMateGrammarRequestEvent = Extract<RendererEvent, { type: 'requestPreviewTextMateGrammar' }>;
type QueuedPreviewRequest = {
  evt: PreviewRequestEvent;
  seq: number;
  route: RendererMessageRoute;
  routeKey: string;
  routeGeneration: number;
  resolve: () => void;
};

type PendingPreviewForceOpen = {
  evt: PreviewRequestEvent;
  seq: number;
  windowId: number;
  route: RendererMessageRoute;
  epoch: number;
};

type PendingStaticResults = {
  query: string;
  matches: FileMatch[];
  requestId: number;
  sourceWindowId?: number;
  resolve: () => void;
  reject: (err: unknown) => void;
};

type PatchScriptOptions = {
  ignoreTargetMarker?: boolean;
  additionalInstance?: boolean;
  forceInstall?: boolean;
};

const BRIDGE_BINDING = 'irSearchMainBridge';
const RENDERER_BINDING = 'irSearchEvent';
const SEARCH_HISTORY_KEY = 'intellijStyledSearch.searchHistory';
const DEFAULT_SEARCH_HISTORY_LIMIT = 100;
const HARD_SEARCH_HISTORY_LIMIT = 1000;
const PREVIEW_FORCE_OPEN_DEBOUNCE_MS = 750;
// Cold-start latency optimization: the first force-open after a session
// starts has no burst to coalesce, so we run it almost immediately. Only
// repeated attempts inside the same session pay the full 750ms debounce.
const PREVIEW_FORCE_OPEN_FIRST_ATTEMPT_DEBOUNCE_MS = 30;
const PREVIEW_FORCE_OPEN_COOLDOWN_MS = 2_000;
// A bundled preview must not become a permanent terminal state merely
// because the first tab-free native capture happened during a cold/workbench
// transition. Keep the retries sparse and bounded: every attempt briefly
// installs then restores the passive capture hooks, and none opens an editor.
const PREVIEW_NATIVE_PASSIVE_RETRY_DELAYS_MS = [120, 450, 1_000, 2_000, 4_000, 8_000] as const;
const LARGE_LITERAL_MULTILINE_SEARCH_CHARS = 512;
const LARGE_LITERAL_MULTILINE_SEARCH_LINES = 16;
const LARGE_LITERAL_MULTILINE_SEARCH_COALESCE_MS = 1_000;
const MONACO_CAPTURE_RECOVERY_PAUSE_MS = 2500;
const RENDERER_INLAY_WARMUP_MAX_FAILURES = 5;
const PREVIEW_LANGUAGE_MAX_COMPLETION_ITEMS = 256;
const PREVIEW_LANGUAGE_MAX_RESULT_ITEMS = 1_000;
const PREVIEW_LANGUAGE_MAX_SYMBOL_NODES = 1_000;
const PREVIEW_LANGUAGE_MAX_DIAGNOSTICS = 500;
const PREVIEW_LANGUAGE_MAX_MARKDOWN_PARTS = 32;
const PREVIEW_LANGUAGE_MAX_TEXT_CHARS = 16_384;
const PREVIEW_LANGUAGE_MAX_SEMANTIC_TOKEN_INTS = 100_000;
const PREVIEW_LANGUAGE_MAX_PAYLOAD_CHARS = 2_000_000;
const PREVIEW_TEXT_MATE_ASSET_CHUNK_BYTES = 96 * 1024;

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

type LargeLiteralMultilineSearchBurst = {
  key: string;
  chars: number;
  lines: number;
};

type LargeLiteralMultilineSearchMarker = {
  burst: LargeLiteralMultilineSearchBurst;
  startedAt: number;
  completedAt?: number;
  promise: Promise<void>;
  resolve: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

function largeLiteralMultilineSearchBurst(
  options: SearchOptions,
  queryTerms: readonly string[],
): LargeLiteralMultilineSearchBurst | undefined {
  if (options.useRegex) { return undefined; }
  let chars = 0;
  let lines = 0;
  let large = false;
  for (const term of queryTerms) {
    if (!term.includes('\n')) { continue; }
    const lineCount = term.split(/\r?\n/).length;
    chars += term.length;
    lines += lineCount;
    if (term.length > LARGE_LITERAL_MULTILINE_SEARCH_CHARS || lineCount > LARGE_LITERAL_MULTILINE_SEARCH_LINES) {
      large = true;
    }
  }
  if (!large) { return undefined; }
  const payload = JSON.stringify({
    queryTerms,
    caseSensitive: !!options.caseSensitive,
    wholeWord: !!options.wholeWord,
    includePatterns: options.includePatterns ?? [],
    excludePatterns: options.excludePatterns ?? [],
    pathRegex: options.pathRegex ?? '',
    resultLimit: options.resultLimit ?? null,
    resultOffset: options.resultOffset ?? null,
  });
  return {
    key: `${chars}:${lines}:${stableSearchHash(payload)}`,
    chars,
    lines,
  };
}

function stableSearchHash(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function buildPreviewPayload(
  doc: vscode.TextDocument,
  requestedLine: number,
  ranges: MatchRange[] | undefined,
): {
  focusLine: number;
  start: number;
  end: number;
  lines: PreviewLine[];
  ranges: MatchRange[] | undefined;
  fullFile: boolean;
  eol: '\n' | '\r\n';
} {
  const lineCount = Math.max(1, doc.lineCount);
  const normalizedLine = Number.isFinite(requestedLine) ? Math.floor(requestedLine) : 0;
  const focusLine = Math.max(0, Math.min(normalizedLine, lineCount - 1));
  const lines: PreviewLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push({ lineNumber: i, text: doc.lineAt(i).text });
  }
  return {
    focusLine,
    start: 0,
    end: lineCount,
    lines,
    ranges,
    fullFile: true,
    eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
  };
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
  private readonly textMateGrammarCatalog: TextMateGrammarCatalog;
  private pendingShow: PendingShow | null = null;
  private showInFlight = false;
  private capturePromise: Promise<void> | undefined;
  private backgroundCapturePromise: Promise<void> | undefined;
  private backgroundCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  private previewCaptureHoldTabs: vscode.Tab[] = [];
  private previewCaptureHoldTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPreviewRequests = new Map<string, QueuedPreviewRequest>();
  private previewRequestGenerationByRoute = new Map<string, number>();
  private previewRequestTimer: ReturnType<typeof setTimeout> | undefined;
  private previewRequestSeq = 0;
  private previewPumpActive = false;
  private previewWarmupPromise: Promise<void> | undefined;
  private rendererPreviewRecoveryPromise: Promise<void> | undefined;
  private pendingPreviewForceOpen: PendingPreviewForceOpen | undefined;
  private previewForceOpenTimer: ReturnType<typeof setTimeout> | undefined;
  private previewForceOpenPromise: Promise<void> | undefined;
  private previewForceOpenCooldownUntil = 0;
  private previewCaptureEpoch = 0;
  private standaloneMonacoInjectionPromises = new Map<number, Promise<void>>();
  private standaloneMonacoReadyWindows = new Set<number>();
  private previewForceOpenAttemptCount = 0;
  private previewForceOpenSuppressedCount = 0;
  private lastPreviewForceOpenUri: string | undefined;
  private lastCaptureDiagnosticOpenUri: string | undefined;
  // Spawn-instance injection telemetry. The renderer-side fast path runs
  // `(0, eval)(__ijFindAdditionalPatchExpr)` inside the workbench window; on
  // Code's Trusted Types policy that throws and we silently fall back to
  // runPatchScript via webContents.executeJavaScript. Tests use these counters
  // to assert when the fast path is unexpectedly broken.
  private spawnInjectionAttempts = 0;
  private spawnInjectionFastSuccess = 0;
  private spawnInjectionFastSkipped = 0;
  private spawnInjectionFallbackSuccess = 0;
  private spawnInjectionFallbackFailed = 0;
  private lastSpawnInjectionFastReport: string | undefined;
  private lastSpawnInjectionFallbackReport: string | undefined;
  private cdpIdleCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private cdpSearchIdleCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private monacoCaptureDisabledLogged = false;
  private monacoCaptureStoppedForSession = false;
  private monacoCaptureRecoveryPauseUntil = 0;
  private monacoCaptureRecoveryPauseTimer: ReturnType<typeof setTimeout> | undefined;
  private rendererRecoveryUntil = 0;
  private searchSeq = 0;
  private currentSearchSession: SearchSession | undefined;
  private largeLiteralMultilineSearch: LargeLiteralMultilineSearchMarker | undefined;
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
  private rendererInlayClickWarmupTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRendererInlayClickWarmupAt = 0;
  private rendererInlayClickHookReady = false;
  private rendererInlayClickHookReadyWindows = new Set<number>();
  private rendererInlayClickWarmupFailureCount = 0;
  private pendingStaticResults: PendingStaticResults | undefined;
  private pendingStaticResultsTimer: ReturnType<typeof setTimeout> | undefined;
  private staticResultsRequestSeq = 0;
  private staticResultsChain: Promise<void> = Promise.resolve();
  private rendererCommandWindowId: number | undefined;
  private rendererCommandPendingPanelWindowId: number | undefined;
  private rendererCommandPendingPanelExpiresAt = 0;
  private activeRendererSrc: string | undefined;
  private currentSearchRendererSrc: string | undefined;
  private previewCallGraphInlayProvider: PreviewCallGraphInlayProvider | undefined;
  private previewLanguageTargets = new Map<string, {
    rendererSrc: string;
    windowId: number;
    uri: string;
    updatedAt: number;
  }>();
  private previewSaveChains = new Map<string, Promise<void>>();
  // Dedup map for inlay fetches: a single user-driven preview event flows
  // through both deliverLatestPreview() and refreshLatestPreviewAfterCapture()
  // which each call sendPreview() → sendPreviewCallGraphInlays(). Without
  // dedup the call graph provider runs the identical query twice. Key by
  // `${uri}#${previewSeq}` and reuse the in-flight promise.
  private inFlightInlayFetches = new Map<string, Promise<void>>();
  private inlayFetchInitiatedCount = 0;
  private inlayFetchSkippedDuplicatesCount = 0;
  // Per-source lastSeenSeq: each renderer patch install has its own instance
  // id (`__src`) and monotonic `__seq`. We dedup duplicates delivered by
  // accumulated CDP `message` listeners *within the same source*, but never
  // across sources — a single shared counter would drop legit events when
  // different windows' __seqs interleave (see V50 patch comment).
  private lastSeenSeqBySrc = new Map<string, number>();
  // Pending bridge-liveness pings awaiting their own log echo back through
  // the bridge chain. See verifyBridgeAlive() for why we need this.
  private bridgePings = new Map<string, () => void>();
  private lastZoektIndexPromptAt = 0;

  static get(context: vscode.ExtensionContext): OverlayPanel {
    if (!OverlayPanel.instance) {
      OverlayPanel.instance = new OverlayPanel(context);
    }
    return OverlayPanel.instance;
  }

  getLogChannel(): vscode.OutputChannel {
    return this.log;
  }

  setPreviewCallGraphInlayProvider(provider: PreviewCallGraphInlayProvider | undefined): void {
    this.previewCallGraphInlayProvider = provider;
  }

  getRendererCommandWindowIdForShow(): number | undefined {
    return this.rendererCommandWindowId;
  }

  /** @internal E2E diagnostics for preview capture resource throttling. */
  getPreviewCaptureStatsForTests(): {
    forceOpenAttempts: number;
    forceOpenSuppressed: number;
    forceOpenActive: boolean;
    forceOpenTimerActive: boolean;
    forceOpenCooldownUntil: number;
    lastForceOpenUri?: string;
    lastCaptureOpenUri?: string;
  } {
    return {
      forceOpenAttempts: this.previewForceOpenAttemptCount,
      forceOpenSuppressed: this.previewForceOpenSuppressedCount,
      forceOpenActive: !!this.previewForceOpenPromise || !!this.rendererPreviewRecoveryPromise,
      forceOpenTimerActive: !!this.previewForceOpenTimer,
      forceOpenCooldownUntil: this.previewForceOpenCooldownUntil,
      lastForceOpenUri: this.lastPreviewForceOpenUri,
      lastCaptureOpenUri: this.lastCaptureDiagnosticOpenUri,
    };
  }

  /** @internal E2E diagnostics for renderer/capture recovery behaviour. */
  getMonacoCaptureStateForTests(): {
    enabled: boolean;
    disabledBySetting: boolean;
    stoppedForSession: boolean;
    recoveryPauseRemainingMs: number;
  } {
    const recoveryPauseRemainingMs = Math.max(0, this.monacoCaptureRecoveryPauseUntil - Date.now());
    return {
      enabled: this.isMonacoCaptureEnabled(),
      disabledBySetting: this.isMonacoCaptureDisabledBySetting(),
      stoppedForSession: this.monacoCaptureStoppedForSession,
      recoveryPauseRemainingMs,
    };
  }

  /** @internal E2E diagnostics for inlay-click warmup behaviour. */
  getRendererInlayClickHookStateForTests(): {
    ready: boolean;
    readyForActiveWindow: boolean;
    cdpOpen: boolean;
    idleCloseTimerActive: boolean;
    warmupTimerActive: boolean;
    warmupFailures: number;
  } {
    return {
      ready: this.rendererInlayClickHookReady,
      readyForActiveWindow: this.isRendererInlayClickHookReadyFor(this.activeWindowId),
      cdpOpen: !!this.ws && this.ws.readyState === WebSocket.OPEN,
      idleCloseTimerActive: !!this.cdpIdleCloseTimer,
      warmupTimerActive: !!this.rendererInlayClickWarmupTimer,
      warmupFailures: this.rendererInlayClickWarmupFailureCount,
    };
  }

  /** @internal E2E hook; do not use in production code paths. */
  resetRendererInlayClickHookWarmupForTests(): void {
    if (this.rendererInlayClickWarmupTimer) {
      clearTimeout(this.rendererInlayClickWarmupTimer);
      this.rendererInlayClickWarmupTimer = undefined;
    }
    this.rendererInlayClickHookReady = false;
    this.rendererInlayClickHookReadyWindows.clear();
    this.rendererInlayClickWarmupFailureCount = 0;
    this.lastRendererInlayClickWarmupAt = 0;
  }

  /** @internal E2E hook; do not use in production code paths. */
  resumeMonacoCaptureForTests(): void {
    this.monacoCaptureStoppedForSession = false;
    this.monacoCaptureRecoveryPauseUntil = 0;
    this.monacoCaptureDisabledLogged = false;
    if (this.monacoCaptureRecoveryPauseTimer) {
      clearTimeout(this.monacoCaptureRecoveryPauseTimer);
      this.monacoCaptureRecoveryPauseTimer = undefined;
    }
  }

  /** @internal E2E hook; do not use in production code paths. */
  resetPreviewCaptureStatsForTests(): void {
    if (this.previewForceOpenTimer) {
      clearTimeout(this.previewForceOpenTimer);
      this.previewForceOpenTimer = undefined;
    }
    this.pendingPreviewForceOpen = undefined;
    this.previewForceOpenCooldownUntil = 0;
    this.previewForceOpenAttemptCount = 0;
    this.previewForceOpenSuppressedCount = 0;
    this.lastPreviewForceOpenUri = undefined;
    this.lastCaptureDiagnosticOpenUri = undefined;
  }

  /** @internal E2E diagnostics for spawn-instance fast-inject path. */
  getSpawnInjectionStatsForTests(): {
    attempts: number;
    fastSuccess: number;
    fastSkipped: number;
    fallbackSuccess: number;
    fallbackFailed: number;
    lastFastReport?: string;
    lastFallbackReport?: string;
  } {
    return {
      attempts: this.spawnInjectionAttempts,
      fastSuccess: this.spawnInjectionFastSuccess,
      fastSkipped: this.spawnInjectionFastSkipped,
      fallbackSuccess: this.spawnInjectionFallbackSuccess,
      fallbackFailed: this.spawnInjectionFallbackFailed,
      lastFastReport: this.lastSpawnInjectionFastReport,
      lastFallbackReport: this.lastSpawnInjectionFallbackReport,
    };
  }

  /** @internal E2E hook; do not use in production code paths. */
  resetSpawnInjectionStatsForTests(): void {
    this.spawnInjectionAttempts = 0;
    this.spawnInjectionFastSuccess = 0;
    this.spawnInjectionFastSkipped = 0;
    this.spawnInjectionFallbackSuccess = 0;
    this.spawnInjectionFallbackFailed = 0;
    this.lastSpawnInjectionFastReport = undefined;
    this.lastSpawnInjectionFallbackReport = undefined;
  }

  markRendererCommandPendingPanel(windowId: number | undefined): void {
    if (windowId === undefined) { return; }
    this.rendererCommandPendingPanelWindowId = windowId;
    this.rendererCommandPendingPanelExpiresAt = Date.now() + 30_000;
  }

  async getSearchSelectionShowContext(): Promise<Pick<ShowOptions, 'preferredWindowId' | 'spawn'>> {
    // Only renderer-originated commands need the preview/spawn probe. A normal
    // workbench keybinding may still have an old activeWindowId, but probing it
    // here performs a full renderer liveness check before show() can even start.
    const windowId = this.rendererCommandWindowId;
    if (windowId === undefined) { return {}; }
    try {
      await this.ensureRendererPatchAlive(windowId, 'search-selection-context');
      const result = await this.evalInWindow(
        windowId,
        `(function(){try{return window.__ijFindShouldSpawnSearchSelection?window.__ijFindShouldSpawnSearchSelection():''}catch(e){return 'err:'+(e&&e.message)}})()`,
        1000,
      );
      if (result === 'preview') {
        this.log.appendLine(`searchSelection source: preview editor in search UI win=${windowId}; spawning new panel`);
        return { preferredWindowId: windowId, spawn: true };
      }
    } catch (err) {
      this.log.appendLine(`searchSelection source probe skipped: ${err instanceof Error ? err.message : err}`);
    }
    return {};
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
    this.textMateGrammarCatalog = new TextMateGrammarCatalog();
    context.subscriptions.push(this.textMateGrammarCatalog);
    context.subscriptions.push(this.textMateGrammarCatalog.onDidInvalidate(() => {
      void this.postPreviewTextMateGrammarInvalidated().catch((error) => {
        this.log.appendLine(`TextMate grammar invalidation relay failed: ${error instanceof Error ? error.message : error}`);
      });
    }));
    const initialEngine = getConfiguredSearchEngine();
    if (initialEngine === 'codesearch') {
      this.startTrigramIndexInit('activation');
    } else {
      this.log.appendLine('zoekt selected on activation; preserving existing codesearch trigram cache.');
    }
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('intellijStyledSearch.engine')) {
        const engine = getConfiguredSearchEngine();
        this.log.appendLine(`search engine changed: ${engine}`);
        if (engine === 'zoekt') {
          this.log.appendLine('zoekt selected in settings; preserving existing codesearch trigram cache.');
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
        const disabled = this.isMonacoCaptureDisabledBySetting();
        this.log.appendLine(`disableMonacoCapture changed: ${disabled}`);
        this.monacoCaptureDisabledLogged = false;
        if (disabled) {
          void this.cancelPendingPreviewCapture('Monaco capture disabled');
          void this.stopMonacoCapture('setting changed').catch((err) => {
            this.log.appendLine(`stopMonacoCapture after setting change failed: ${err instanceof Error ? err.message : err}`);
          });
        } else {
          this.monacoCaptureStoppedForSession = false;
          this.monacoCaptureRecoveryPauseUntil = 0;
          if (this.monacoCaptureRecoveryPauseTimer) {
            clearTimeout(this.monacoCaptureRecoveryPauseTimer);
            this.monacoCaptureRecoveryPauseTimer = undefined;
          }
          void this.resumeRendererMonacoCapturePolicy('capture-setting-enabled');
        }
      }
      if (event.affectsConfiguration('intellijStyledSearch.allowTransientPreviewCaptureEditor') &&
          !this.shouldAllowTransientPreviewCaptureEditor()) {
        void this.cancelPendingPreviewCapture('transient capture editor disabled');
      }
    }));
    context.subscriptions.push(vscode.languages.onDidChangeDiagnostics((event) => {
      void this.postPreviewDiagnosticUpdates(event.uris).catch((err) => {
        this.log.appendLine(`preview diagnostics update failed: ${err instanceof Error ? err.message : err}`);
      });
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
      this.log.appendLine('Prewarm complete (lightweight only; zoekt build/index and CDP/Monaco capture disabled on activation).');
    } catch (err) {
      this.log.appendLine(`Prewarm failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  pauseZoektFileUpdates(reason: string, options?: { cancelIndexing?: boolean }): vscode.Disposable {
    return this.zoektRuntime.pauseFileUpdates(reason, options);
  }

  private lastCaptureAttemptAt = 0;
  private lastBackgroundCaptureAttemptAt = 0;

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

  private async ensureMonacoCapture(
    preferredWindowId?: number,
    forceOpenUri?: vscode.Uri,
    options: {
      allowForceOpen?: boolean;
      holdForceOpenedTab?: boolean;
      reason?: string;
      bypassThrottle?: boolean;
      shouldContinue?: () => boolean;
    } = {},
  ): Promise<void> {
    if (options.shouldContinue && !options.shouldContinue()) { return; }
    if (!this.isMonacoCaptureEnabled()) {
      this.logMonacoCaptureDisabled(this.getMonacoCaptureDisabledReason() ?? 'foreground');
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
    if (!forceOpenUri && !options.bypassThrottle && now - this.lastCaptureAttemptAt < 1500) { return; }
    if (options.shouldContinue && !options.shouldContinue()) { return; }
    this.lastCaptureAttemptAt = now;
    try {
      const allowForceOpen = options.allowForceOpen === true;
      this.capturePromise = this.triggerCaptureDiagnostic(preferredWindowId, {
        allowForceOpen,
        forceOpenUri,
        holdForceOpenedTab: options.holdForceOpenedTab ?? false,
        reason: options.reason ?? (forceOpenUri ? `preview:${forceOpenUri.toString()}` : 'foreground'),
        shouldContinue: options.shouldContinue,
      });
      await this.capturePromise;
    } finally {
      this.capturePromise = undefined;
    }
  }

  private holdPreviewCaptureTabs(tabs: vscode.Tab[]): void {
    for (const tab of tabs) {
      if (!this.previewCaptureHoldTabs.includes(tab)) {
        this.previewCaptureHoldTabs.push(tab);
      }
    }
  }

  private releasePreviewCaptureTabsSoon(reason: string, delayMs = 1500): void {
    if (this.previewCaptureHoldTabs.length === 0) { return; }
    if (this.previewCaptureHoldTimer) {
      clearTimeout(this.previewCaptureHoldTimer);
    }
    this.previewCaptureHoldTimer = setTimeout(() => {
      this.previewCaptureHoldTimer = undefined;
      const tabs = this.previewCaptureHoldTabs.splice(0);
      if (tabs.length === 0) { return; }
      void vscode.window.tabGroups.close(tabs, true).then(
        () => this.log.appendLine(`Capture diagnostic: released ${tabs.length} held preview capture tab(s) (${reason}).`),
        (err) => this.log.appendLine(`Capture diagnostic: release held tabs failed (${reason}): ${err instanceof Error ? err.message : err}`),
      );
    }, delayMs);
  }

  private closeHeldPreviewCaptureTabs(reason: string): Promise<void> {
    if (this.previewCaptureHoldTimer) {
      clearTimeout(this.previewCaptureHoldTimer);
      this.previewCaptureHoldTimer = undefined;
    }
    const tabs = this.previewCaptureHoldTabs.splice(0);
    if (tabs.length === 0) { return Promise.resolve(); }
    return Promise.resolve(vscode.window.tabGroups.close(tabs, true)).then(
      () => this.log.appendLine(`Capture diagnostic: closed ${tabs.length} held preview capture tab(s) (${reason}).`),
      (err) => this.log.appendLine(`Capture diagnostic: close held tabs failed (${reason}): ${err instanceof Error ? err.message : err}`),
    );
  }

  private cancelPendingPreviewCapture(reason: string): Promise<void> {
    this.previewCaptureEpoch++;
    if (this.previewForceOpenTimer) {
      clearTimeout(this.previewForceOpenTimer);
      this.previewForceOpenTimer = undefined;
    }
    this.pendingPreviewForceOpen = undefined;
    return this.closeHeldPreviewCaptureTabs(reason);
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

  /** Whether the renderer is allowed to retain/use the native capture
   *  capability. A short renderer-recovery pause must not be represented as
   *  a permanent disable flag: the latter clears the captured factory and is
   *  intentionally terminal until the setting/session policy changes. */
  private shouldEnableRendererMonacoProbes(): boolean {
    return !this.monacoCaptureStoppedForSession && !this.isMonacoCaptureDisabledBySetting();
  }

  private isMonacoCaptureTemporarilyPaused(): boolean {
    return this.shouldEnableRendererMonacoProbes() &&
      this.monacoCaptureRecoveryPauseUntil > Date.now();
  }

  private isMonacoCaptureDisabled(): boolean {
    return this.getMonacoCaptureDisabledReason() !== undefined;
  }

  private isMonacoCaptureDisabledBySetting(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('disableMonacoCapture', false);
  }

  private shouldAllowTransientPreviewCaptureEditor(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('allowTransientPreviewCaptureEditor', true) === true;
  }

  private getMonacoCaptureDisabledReason(): string | undefined {
    if (this.monacoCaptureStoppedForSession) { return 'session stopped'; }
    if (this.isMonacoCaptureDisabledBySetting()) { return 'setting disabled'; }
    const pauseRemaining = this.monacoCaptureRecoveryPauseUntil - Date.now();
    if (pauseRemaining > 0) { return `recovery pause (${Math.ceil(pauseRemaining)}ms left)`; }
    return undefined;
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
      .get<boolean>('rendererInlayClickHook', true);
  }

  // #47 default ON: captain log proved isSimpleWidget=true silently
  // suppresses Pylance hover (hoverWidgetVisibleAfter350ms=0/13). Users
  // expect language features in preview, so isSimpleWidget=false is the
  // right default. The workbench-takeover regression is now mitigated by
  // #46/A-path preserving the editor across hide/show; if a takeover
  // surfaces, users can flip this back to false in settings.json.
  private shouldEnablePreviewLanguageFeatures(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('previewLanguageFeatures', true);
  }

  private shouldDisposeRendererPatchOnHide(): boolean {
    if (this.shouldEnableRendererInlayClickHook()) { return false; }
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('disposeRendererPatchOnHide', true);
  }

  private shouldKeepCdpOpenWhileSearchUiVisible(): boolean {
    return vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('keepCdpOpenWhileSearchUiVisible', true);
  }

  private getRendererBridgeSingletonIdleMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('rendererBridgeSingletonIdleMs', 30_000);
    if (!Number.isFinite(raw)) { return 30_000; }
    return Math.max(1_000, Math.min(300_000, Math.floor(raw)));
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
      `Native Monaco capture disabled (${reason}); previews use bundled Monaco without editor tabs or prototype capture.`,
    );
  }

  scheduleRendererInlayClickHookWarmup(reason = 'inlay-hints', delayMs = 700, bypassThrottle = false): void {
    if (!this.shouldEnableRendererInlayClickHook()) { return; }
    if (this.activeWindowId !== undefined && this.isRendererInlayClickHookReadyFor(this.activeWindowId)) { return; }
    const now = Date.now();
    if (!bypassThrottle && now - this.lastRendererInlayClickWarmupAt < 5000) { return; }
    if (this.rendererInlayClickWarmupTimer) { return; }
    this.rendererInlayClickWarmupTimer = setTimeout(() => {
      this.rendererInlayClickWarmupTimer = undefined;
      this.runRendererInlayClickHookWarmup(reason);
    }, delayMs);
  }

  private runRendererInlayClickHookWarmup(reason: string): void {
    if (this.showInFlight || this.pendingShow) {
      this.scheduleRendererInlayClickHookWarmup(reason, 1000, true);
      return;
    }
    this.lastRendererInlayClickWarmupAt = Date.now();
    void this.ensureInjected({ ignoreTargetMarker: true })
      .then(async () => {
        const targetWindowId = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
        if (!this.isRendererInlayClickHookReadyFor(targetWindowId)) {
          const report = await this.runPatchScript(targetWindowId, { ignoreTargetMarker: true });
          this.markRendererInlayClickHookReady(String(report), 'warmup-refresh');
        }
        this.rendererInlayClickWarmupFailureCount = 0;
        if (!this.showInFlight && !this.pendingShow &&
            this.activeWindowId === undefined &&
            this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.scheduleCdpIdleClose();
        }
      })
      .catch((err) => {
        this.rendererInlayClickWarmupFailureCount++;
        const message = err instanceof Error ? err.message : err;
        if (this.rendererInlayClickWarmupFailureCount >= RENDERER_INLAY_WARMUP_MAX_FAILURES) {
          this.log.appendLine(
            `renderer inlay click warmup failed (${reason}); ` +
            `will retry on the next inlay hint request: ${message}`,
          );
          return;
        }
        const retryMs = Math.min(30_000, 1000 * (2 ** Math.max(0, this.rendererInlayClickWarmupFailureCount - 1)));
        this.log.appendLine(
          `renderer inlay click warmup failed (${reason}); retrying in ${retryMs}ms: ${message}`,
        );
        this.scheduleRendererInlayClickHookWarmup(reason, retryMs, true);
      });
  }

  private isRendererInlayClickHookReadyFor(windowId: number | undefined): boolean {
    if (!this.shouldEnableRendererInlayClickHook()) { return false; }
    if (windowId === undefined) { return this.rendererInlayClickHookReady; }
    return this.rendererInlayClickHookReadyWindows.has(windowId);
  }

  private markRendererInlayClickHookReadyWindow(windowId: number): void {
    if (!Number.isFinite(windowId)) { return; }
    this.rendererInlayClickHookReadyWindows.add(Math.floor(windowId));
    this.rendererInlayClickHookReady = this.rendererInlayClickHookReadyWindows.size > 0;
  }

  private markRendererInlayClickHookReady(report: string, reason: string): void {
    if (!this.shouldEnableRendererInlayClickHook()) { return; }
    if (!/\bok:/.test(report)) { return; }
    const beforeSize = this.rendererInlayClickHookReadyWindows.size;
    const okMatches = String(report).matchAll(/\bok:(\d+):/g);
    for (const match of okMatches) {
      const windowId = Number(match[1]);
      if (Number.isFinite(windowId)) {
        this.markRendererInlayClickHookReadyWindow(windowId);
      }
    }
    if (this.rendererInlayClickHookReadyWindows.size === 0) {
      this.rendererInlayClickHookReady = true;
    }
    this.rendererInlayClickWarmupFailureCount = 0;
    if (this.rendererInlayClickHookReadyWindows.size !== beforeSize || beforeSize === 0) {
      this.log.appendLine(
        `renderer inlay click hook ready (${reason})` +
        (this.rendererInlayClickHookReadyWindows.size > 0
          ? ` windows=${Array.from(this.rendererInlayClickHookReadyWindows).sort((a, b) => a - b).join(',')}`
          : '') +
        '.',
      );
    }
  }

  private invalidateRendererInlayClickHookReady(reason: string): void {
    if (!this.rendererInlayClickHookReady) { return; }
    this.rendererInlayClickHookReady = false;
    this.rendererInlayClickHookReadyWindows.clear();
    this.log.appendLine(`renderer inlay click hook invalidated (${reason}).`);
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
      const expectedDisableMonacoProbes = !this.shouldEnableRendererMonacoProbes();
      const expectedCapturePaused = this.isMonacoCaptureTemporarilyPaused();
      const expectedPreviewLanguageFeatures = this.shouldEnablePreviewLanguageFeatures();
      const r = await this.evalInWindow(winId,
        `(function(){try{return window.__ijFindShow&&window.__ijFindOnMessage&&window.__ijFindStatus&&` +
        `window.__ijFindPatchVersion===${RENDERER_PATCH_VERSION}&&` +
        `window.__ijFindDisableMonacoProbes===${expectedDisableMonacoProbes ? 'true' : 'false'}&&` +
        `window.__ijFindMonacoCapturePaused===${expectedCapturePaused ? 'true' : 'false'}&&` +
        `window.__ijFindEnablePreviewLanguageFeatures===${expectedPreviewLanguageFeatures ? 'true' : 'false'}` +
        `?'ready':'missing'}catch(e){return 'err:'+(e&&e.message)}})()`,
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
    await runMonacoCaptureDiagnostic({
      resolveTargetWorkbenchWindowId: (preferred) => this.resolveTargetWorkbenchWindowId(preferred),
      evalInWindow: (winId, expr) => this.evalInWindow(winId, expr),
      isMonacoReadyInWindow: (winId) => this.isMonacoReadyInWindow(winId),
      log: (message) => this.log.appendLine(message),
      setLastCaptureDiagnosticOpenUri: (uri) => { this.lastCaptureDiagnosticOpenUri = uri; },
      holdPreviewCaptureTabs: (tabs) => this.holdPreviewCaptureTabs(tabs),
    }, preferredWindowId, options);
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

  async getSearchReadinessForHealth(): Promise<{ ready: boolean; reason?: string }> {
    if (getConfiguredSearchEngine() === 'zoekt') {
      return this.zoektRuntime.getSearchReadiness();
    }
    return { ready: this.trigramIndex.isReady, reason: this.trigramIndex.isReady ? undefined : 'codesearch trigram index not ready' };
  }

  async resolveZoekEngineBinaryForGraph(allowBuild: boolean): Promise<string | undefined> {
    return this.zoektRuntime.resolveEngineBinaryForGraph(allowBuild);
  }

  collectZoektFreshnessForHealth(): ZoektFreshnessStatus {
    return this.zoektRuntime.getFreshnessStatus();
  }

  /** @internal Run the same search pipeline runSearch() uses, but collect
   *  FileMatch events synchronously and return them. Skips the overlay UI
   *  (no CDP, no renderer) — tests get deterministic results independent
   *  of the VSCode window state. */
  async searchForTestsDetailed(options: SearchOptions, token?: vscode.CancellationToken): Promise<SearchForTestsResult> {
    const folders = vscode.workspace.workspaceFolders;
    const requestedEngine = getConfiguredSearchEngine();
    const ownedCts = token ? undefined : new vscode.CancellationTokenSource();
    const effectiveToken = token ?? ownedCts!.token;
    const fallbackPolicy: SearchFallbackPolicy = options.fallbackPolicy ?? 'always';
    try {
    if (!folders || folders.length === 0) {
      return {
        matches: [],
        requestedEngine,
        effectiveEngine: requestedEngine,
        fallbackReason: 'no workspace folder',
      };
    }
    const queryTerms = searchQueryTerms(options);
    if (queryTerms.length === 0) {
      return {
        matches: [],
        requestedEngine,
        effectiveEngine: requestedEngine,
      };
    }
    const matches: FileMatch[] = [];
    let effectiveEngine: SearchEngine = requestedEngine;
    let fallbackReason: string | undefined;
    if (requestedEngine === 'zoekt' && !options.forceFullScan) {
      const readiness = await this.zoektRuntime.runSearch(
        options,
        effectiveToken,
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
      if (readiness.invalidPattern) {
        // Invalid/unsupported pattern: surface the error, do not fall back
        // (the fallback engine shares the same regex semantics and would fail
        // or mislead). Mirrors the live runSearchPage results:error path.
        return {
          matches: [],
          requestedEngine,
          effectiveEngine: requestedEngine,
          error: readiness.reason,
        };
      }
      if (fallbackPolicy === 'never') {
        return {
          matches: mergeFileMatches(matches),
          requestedEngine,
          effectiveEngine: requestedEngine,
          fallbackReason: appendFallbackReason(readiness.reason, fallbackPolicySkipReason(fallbackPolicy, null)),
        };
      }
      effectiveEngine = 'codesearch';
      fallbackReason = readiness.reason;
    } else if (requestedEngine === 'zoekt' && options.forceFullScan) {
      if (!shouldUseSearchFallback(fallbackPolicy, null)) {
        return {
          matches: [],
          requestedEngine,
          effectiveEngine: requestedEngine,
          fallbackReason: appendFallbackReason('scope override requires full workspace scan', fallbackPolicySkipReason(fallbackPolicy, null)),
        };
      }
      effectiveEngine = 'codesearch';
      fallbackReason = 'scope override requires full workspace scan';
    }
    const { uris: candidates } = options.forceFullScan || queryTerms.length > 1 ? { uris: null } : this.trigramIndex.candidatesFor(options.query, {
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
      if (fallbackReason && !shouldUseSearchFallback(fallbackPolicy, candidates.size)) {
        return {
          matches: mergeFileMatches(matches),
          requestedEngine,
          effectiveEngine: requestedEngine,
          fallbackReason: appendFallbackReason(fallbackReason, fallbackPolicySkipReason(fallbackPolicy, candidates.size)),
        };
      }
      const uris: vscode.Uri[] = [];
      for (const u of candidates) {
        try { uris.push(vscode.Uri.parse(u)); } catch {}
      }
      paths = prioritizeFiles(uris).map((u) => u.fsPath);
    } else if (fallbackReason && !shouldUseSearchFallback(fallbackPolicy, null)) {
      return {
        matches: mergeFileMatches(matches),
        requestedEngine,
        effectiveEngine: requestedEngine,
        fallbackReason: appendFallbackReason(fallbackReason, fallbackPolicySkipReason(fallbackPolicy, null)),
      };
    }
    await new Promise<void>((resolve, reject) => {
      runRgSearch(
        options,
        effectiveToken,
        {
          onFile: (m) => { matches.push(m); },
          onDone: () => { resolve(); },
          onError: (err) => { reject(err); },
        },
        paths,
      ).catch(reject);
    });
    if (paths && countFileMatches(matches) < getRequestedResultLimit(options)) {
      if (fallbackReason && fallbackPolicy !== 'always') {
        return {
          matches: mergeFileMatches(matches),
          requestedEngine,
          effectiveEngine,
          fallbackReason: appendFallbackReason(fallbackReason, fallbackPolicySkipReason(fallbackPolicy, null)),
        };
      }
      const verifiedMatches: FileMatch[] = [];
      await new Promise<void>((resolve, reject) => {
        runRgSearch(
          options,
          effectiveToken,
          {
            onFile: (m) => { verifiedMatches.push(m); },
            onDone: () => { resolve(); },
            onError: (err) => { reject(err); },
          },
          null,
        ).catch(reject);
      });
      return {
        matches: mergeFileMatches(verifiedMatches),
        requestedEngine,
        effectiveEngine,
        fallbackReason: appendFallbackReason(fallbackReason, 'trigram candidate set underfilled; verified with full scan'),
      };
    }
    return {
      matches: mergeFileMatches(matches),
      requestedEngine,
      effectiveEngine,
      fallbackReason,
    };
    } finally {
      ownedCts?.dispose();
    }
  }

  async searchForTests(options: SearchOptions): Promise<FileMatch[]> {
    const result = await this.searchForTestsDetailed(options);
    return result.matches;
  }

  /** @internal Runs the Rust engine benchmark through the production runtime path. */
  async runZoektBenchmarkForTests(
    fileCounts: number[],
    options?: { profile?: 'synthetic' | 'mixed'; searchOnly?: boolean; virtualIndex?: boolean },
  ) {
    return this.zoektRuntime.runBenchmarkForTests(fileCounts, options);
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
  /** Notify the renderer that the workbench just observed an editor-side
   *  activity burst (tab switch, group focus change, …). The renderer
   *  suspends IntelliSense Recursion capture for ~1s after each call so
   *  the LSP doesn't kick off a heavy re-index while the user is still
   *  navigating. Exposed on the test API so e2e probes can simulate the
   *  activity without subscribing to real workbench events. */
  noteWorkbenchEditorActivity(reason: string): void {
    const winId = this.activeWindowId;
    if (winId === undefined) { return; }
    const expr = `(function(){
      try {
        if (typeof window.__ijFindNoteWorkbenchEditorActivity === 'function') {
          window.__ijFindNoteWorkbenchEditorActivity(${JSON.stringify(reason)});
          return 'ok';
        }
        return 'no-handler';
      } catch (e) { return 'err:' + (e && e.message); }
    })()`;
    void this.evalInWindow(winId, expr).catch(() => {});
  }

  async forceCaptureForTests(): Promise<string> {
    const preferredWindowId = this.activeWindowId;
    try {
      await this.triggerCaptureDiagnostic(preferredWindowId, {
        allowForceOpen: true,
        reason: 'force-capture-test',
      });
    }
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
  async evalInActiveWindowForTests(jsExpr: string, timeoutMs?: number): Promise<string> {
    const resolved = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
    if (resolved === undefined) {
      throw new Error('no active workbench window — call overlay.show(...) first');
    }
    this.activeWindowId = resolved;
    const result = await this.evalInWindow(resolved, jsExpr, timeoutMs);
    if (!/^no-window:|^err:No target with given id found\b/.test(result)) {
      return result;
    }
    this.activeWindowId = undefined;
    const retryWindowId = await this.resolveTargetWorkbenchWindowId();
    if (retryWindowId === undefined || retryWindowId === resolved) {
      return result;
    }
    this.activeWindowId = retryWindowId;
    return this.evalInWindow(retryWindowId, jsExpr, timeoutMs);
  }

  /** @internal Send Chromium-trusted mouse movement to the active workbench.
   *  Renderer-level tests use this instead of dispatchEvent(), whose events
   *  are synthetic and bypass Electron/Chromium hit testing (including
   *  ShadowRoot retargeting). Coordinates are workbench client pixels. */
  async sendMouseMovesInActiveWindowForTests(
    points: ReadonlyArray<{ x: number; y: number }>,
    intervalMs = 25,
  ): Promise<string> {
    const normalizedPoints = points.map((point) => ({
      x: Math.max(0, Math.round(Number(point.x) || 0)),
      y: Math.max(0, Math.round(Number(point.y) || 0)),
    }));
    if (normalizedPoints.length === 0) {
      throw new Error('sendMouseMovesInActiveWindowForTests requires at least one point');
    }
    const resolved = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
    if (resolved === undefined) {
      throw new Error('no active workbench window — call overlay.show(...) first');
    }
    this.activeWindowId = resolved;
    const safeIntervalMs = Math.max(0, Math.min(250, Math.round(intervalMs) || 0));
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var w = BW.fromId(${resolved});
        if (!w || !w.webContents) { return 'no-window:' + ${resolved}; }
        var points = ${JSON.stringify(normalizedPoints)};
        var intervalMs = ${safeIntervalMs};
        var previous = null;
        for (var i = 0; i < points.length; i++) {
          var point = points[i];
          w.webContents.sendInputEvent({
            type: 'mouseMove',
            x: point.x,
            y: point.y,
            movementX: previous ? point.x - previous.x : 0,
            movementY: previous ? point.y - previous.y : 0,
            modifiers: []
          });
          previous = point;
          if (intervalMs > 0 && i + 1 < points.length) {
            await new Promise(function (resolve) { setTimeout(resolve, intervalMs); });
          }
        }
        return JSON.stringify({ sent: points.length, windowId: w.id });
      })()
    `.trim();
    const response = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'trusted mouse move evaluation failed');
    }
    return String(response?.result?.value ?? '');
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
    this.log.appendLine(`Extension activated. Ext host pid=${process.pid}, ppid=${process.ppid}`);
  }

  logCommand(name: string) {
    this.log.appendLine(`Command invoked: ${name}`);
  }

  async forceReinject(): Promise<void> {
    this.log.appendLine('Forcing reinject...');
    // The renderer patch can deliberately reject an older Monaco bundle
    // during upgrade. Re-verify the per-window bundle on the next preview.
    this.standaloneMonacoReadyWindows.clear();
    if (this.ws) {
      try { await this.releaseRendererBridge('force reinject', undefined, 1500); }
      catch (err) { this.log.appendLine(`forceReinject release failed: ${err instanceof Error ? err.message : err}`); }
      if (this.ws) {
        this.closeCdpWebSocket('force reinject');
      }
    }
    this.injectPromise = undefined;
    await this.ensureInjected({ forceInstall: true });
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
    this.pauseMonacoCaptureForRecovery(`recover:${reason}`);
    this.invalidateRendererInlayClickHookReady(`recover:${reason}`);
    const rendererReport = await this.tryRendererEmergencyRecoverViaExistingBridge(`recover:${reason}`);
    const bridgeReport = await this.releaseRendererBridgeSafely('renderer UI recovery', 1000);
    this.activeWindowId = undefined;
    return [
      'active-search=cancelled',
      `future-monaco-capture=paused:${MONACO_CAPTURE_RECOVERY_PAUSE_MS}ms`,
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
    this.monacoCaptureRecoveryPauseUntil = 0;
    if (this.monacoCaptureRecoveryPauseTimer) {
      clearTimeout(this.monacoCaptureRecoveryPauseTimer);
      this.monacoCaptureRecoveryPauseTimer = undefined;
    }
    this.monacoCaptureDisabledLogged = false;
    if (this.backgroundCaptureTimer) {
      clearTimeout(this.backgroundCaptureTimer);
      this.backgroundCaptureTimer = undefined;
    }
    this.log.appendLine(`Monaco capture disabled for this extension-host session (${reason}).`);
  }

  private pauseMonacoCaptureForRecovery(reason: string, delayMs = MONACO_CAPTURE_RECOVERY_PAUSE_MS): void {
    const until = Date.now() + delayMs;
    this.monacoCaptureRecoveryPauseUntil = Math.max(this.monacoCaptureRecoveryPauseUntil, until);
    this.monacoCaptureDisabledLogged = false;
    if (this.backgroundCaptureTimer) {
      clearTimeout(this.backgroundCaptureTimer);
      this.backgroundCaptureTimer = undefined;
    }
    if (this.monacoCaptureRecoveryPauseTimer) {
      clearTimeout(this.monacoCaptureRecoveryPauseTimer);
    }
    this.monacoCaptureRecoveryPauseTimer = setTimeout(() => {
      this.monacoCaptureRecoveryPauseTimer = undefined;
      if (Date.now() < this.monacoCaptureRecoveryPauseUntil) {
        this.pauseMonacoCaptureForRecovery(`${reason}:extend`, this.monacoCaptureRecoveryPauseUntil - Date.now());
        return;
      }
      this.monacoCaptureRecoveryPauseUntil = 0;
      this.monacoCaptureDisabledLogged = false;
      this.log.appendLine(`Monaco capture recovery pause elapsed (${reason}); future previews may capture again.`);
      void this.resumeRendererMonacoCapturePolicy(`recovery-pause-elapsed:${reason}`);
    }, delayMs);
    this.log.appendLine(`Monaco capture paused for renderer recovery (${reason}; ${delayMs}ms).`);
  }

  /** Synchronize a retained renderer after a temporary pause or policy
   *  change. In particular this wakes bundled previews that were mounted
   *  while capture was paused; no new preview selection is required. */
  private async resumeRendererMonacoCapturePolicy(reason: string): Promise<void> {
    if (!this.shouldEnableRendererMonacoProbes() || this.isMonacoCaptureTemporarilyPaused()) { return; }
    try {
      // Renderer recovery deliberately closes CDP, so establish the bridge
      // before trying to resolve a BrowserWindow through it.
      await this.ensureRendererPatchAlive(undefined, reason);
      const targetWindowId = await this.resolveTargetWorkbenchWindowId(this.activeWindowId);
      if (targetWindowId !== undefined && !(await this.isRendererPatchedInWindow(targetWindowId))) {
        await this.ensureRendererPatchAlive(targetWindowId, reason);
      }
      if (targetWindowId !== undefined) {
        try {
          await this.evalInWindow(
            targetWindowId,
            `(function(){try{return window.__ijFindResumeStandaloneNativePromotion` +
              `?window.__ijFindResumeStandaloneNativePromotion(${JSON.stringify(reason)})` +
              `:'no-resume-hook'}catch(e){return 'resume-err:'+(e&&e.message)}})()`,
          );
        } catch (err) {
          this.log.appendLine(
            `Renderer native promotion resume signal failed (${reason}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      this.scheduleBackgroundCaptureWarmup(reason, 0);
    } catch (err) {
      this.log.appendLine(
        `Renderer Monaco capture policy resume failed (${reason}): ${err instanceof Error ? err.message : err}`,
      );
      // A later preview request will retry the same synchronization path.
    }
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

  /** @internal Test helper: queue a single-file change/delete notification
   *  on both index pathways (zoekt incremental sync queue + trigram index)
   *  without depending on the workspace file watcher's debounce. Pair with
   *  waitForIndexReady() to flush the update before the next search. */
  async notifyFileChangedForTests(uri: vscode.Uri, kind: 'changed' | 'deleted' = 'changed'): Promise<void> {
    if (kind === 'deleted') {
      this.trigramIndex.removeFileForTests(uri);
    } else {
      try { await this.trigramIndex.indexFileForTests(uri); } catch {}
    }
    this.zoektRuntime.notifyFileChangedForTests(uri, kind);
  }

  /** @internal Flush every queued zoekt incremental update right now. Pair
   *  with notifyFileChangedForTests() to batch many file notifications into
   *  a single index update step. */
  async flushPendingUpdatesForTests(): Promise<void> {
    await this.zoektRuntime.flushPendingUpdatesForTests();
  }

  /** @internal Build the search index only if no usable index exists yet.
   *  When suites run together in one VSCode session, the dedicated
   *  index-speed test (activation.test) does the rebuild and subsequent
   *  suites short-circuit here. When a suite runs alone the workspace
   *  has no prior index — this helper produces one so the suite isn't
   *  blocked on a non-existent index. Engine-aware: zoekt persists to
   *  disk, codesearch's trigram index lives in-memory and has to be
   *  rebuilt on every cold start. */
  async ensureIndexBuiltForTests(): Promise<void> {
    const engine = getConfiguredSearchEngine();
    if (engine === 'codesearch') {
      if (this.trigramIndex.isReady) { return; }
      await this.rebuildIndex();
      return;
    }
    if (await this.zoektRuntime.hasReadyIndexForTests()) { return; }
    await this.rebuildIndex();
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
              this.log.appendLine(
                'zoekt rebuild requested; preserving the independent codesearch trigram cache.',
              );
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

  private maybePromptZoektIndexRecommendation(reason: string | undefined): void {
    if (!reason) { return; }
    const lower = reason.toLowerCase();
    const needsIndex = lower.includes('zoek-rs index incomplete') || lower.includes('zoek-rs binary unavailable');
    if (!needsIndex) { return; }
    const now = Date.now();
    if (now - this.lastZoektIndexPromptAt < 30_000) { return; }
    this.lastZoektIndexPromptAt = now;
    const action = 'Force Rebuild Search + Graph Index';
    const subject = lower.includes('binary unavailable') ? 'zoekt search engine' : 'zoekt search index';
    void vscode.window.showWarningMessage(
      `IntelliJ Styled Search: ${subject} is not ready. Search will use codesearch fallback until the index is rebuilt.`,
      action,
    ).then((picked) => {
      if (picked === action) {
        void vscode.commands.executeCommand('intellijStyledSearch.rebuildIndex');
      }
    });
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

  async collectZoektInfoForHealth(): Promise<ZoektInfoResponse | null> {
    return this.zoektRuntime.collectInfo();
  }

  formatZoektInfoForHealth(info: ZoektInfoResponse): string {
    return this.zoektRuntime.formatInfoReport(info);
  }

  async benchmarkAgainstRgForCommand(token?: vscode.CancellationToken): Promise<string> {
    const cases: Array<{ name: string; query: string; useRegex: boolean; includePatterns: string[] }> = [
      { name: 'common_literal', query: 'useQuery', useRegex: false, includePatterns: ['**/*.ts', '**/*.tsx'] },
      { name: 'rare_literal', query: 'WhtBook', useRegex: false, includePatterns: ['**/*.py'] },
      { name: 'regex_class_view', query: 'class\\s+\\w+View', useRegex: true, includePatterns: ['**/*.py', '**/*.ts', '**/*.tsx'] },
      { name: 'no_match', query: 'ZZZ_NOPE', useRegex: false, includePatterns: ['**/*.py', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'] },
    ];
    const lines = ['query | tool | matches | files | latency_ms | chars | verdict'];
    for (const item of cases) {
      if (token?.isCancellationRequested) {
        lines.push(`${item.name} | cancelled | 0 | 0 | 0 | 0 | cancelled`);
        break;
      }
      const options: SearchOptions = {
        query: item.query,
        caseSensitive: false,
        wholeWord: false,
        useRegex: item.useRegex,
        regexMultiline: item.useRegex,
        includePatterns: item.includePatterns,
        excludePatterns: [],
        resultLimit: 200,
        fallbackPolicy: 'never',
      };
      const indexed = await this.runIndexedBenchmarkCase(options, token);
      const rg = await this.runRgBenchmarkCase({ ...options, fallbackPolicy: 'always' }, token);
      lines.push(formatBenchmarkRow(item.name, 'indexed', indexed, verdictForBenchmark(indexed, rg)));
      lines.push(formatBenchmarkRow(item.name, 'rg', rg, rg.cancelled ? 'cancelled' : 'baseline'));
    }
    return lines.join('\n');
  }

  private async runIndexedBenchmarkCase(
    options: SearchOptions,
    token?: vscode.CancellationToken,
  ): Promise<SearchBenchmarkMeasurement> {
    const started = Date.now();
    const matches: FileMatch[] = [];
    const ownedCts = token ? undefined : new vscode.CancellationTokenSource();
    try {
      const readiness = await this.zoektRuntime.runSearch(options, token ?? ownedCts!.token, {
        onFile: (match) => { matches.push(match); },
        onDone: () => {},
        onError: (err) => { throw err; },
      });
      const merged = mergeFileMatches(matches);
      return {
        files: merged.length,
        matches: countFileMatches(merged),
        latencyMs: Date.now() - started,
        chars: benchmarkOutputChars(merged),
        warning: readiness.ready ? undefined : readiness.reason ?? 'index unavailable',
      };
    } catch (err) {
      return {
        files: 0,
        matches: 0,
        latencyMs: Date.now() - started,
        chars: 0,
        warning: err instanceof Error ? err.message : String(err),
        cancelled: token?.isCancellationRequested,
      };
    } finally {
      ownedCts?.dispose();
    }
  }

  private async runRgBenchmarkCase(
    options: SearchOptions,
    token?: vscode.CancellationToken,
  ): Promise<SearchBenchmarkMeasurement> {
    const started = Date.now();
    const matches: FileMatch[] = [];
    const ownedCts = token ? undefined : new vscode.CancellationTokenSource();
    try {
      await new Promise<void>((resolve, reject) => {
        runRgSearch(
          options,
          token ?? ownedCts!.token,
          {
            onFile: (match) => { matches.push(match); },
            onDone: () => { resolve(); },
            onError: (err) => { reject(err); },
          },
          null,
        ).catch(reject);
      });
      const merged = mergeFileMatches(matches);
      return {
        files: merged.length,
        matches: countFileMatches(merged),
        latencyMs: Date.now() - started,
        chars: benchmarkOutputChars(merged),
        cancelled: token?.isCancellationRequested,
      };
    } catch (err) {
      return {
        files: 0,
        matches: 0,
        latencyMs: Date.now() - started,
        chars: 0,
        warning: err instanceof Error ? err.message : String(err),
        cancelled: token?.isCancellationRequested,
      };
    } finally {
      ownedCts?.dispose();
    }
  }

  async explainZoektQuery(options: SearchOptions): Promise<void> {
    const queryTerms = searchQueryTerms(options);
    if (queryTerms.length === 0) {
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
    void this.cancelPendingPreviewCapture('new overlay show');
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
    const requestId = ++this.staticResultsRequestSeq;
    if (this.pendingStaticResultsTimer) {
      clearTimeout(this.pendingStaticResultsTimer);
      this.pendingStaticResultsTimer = undefined;
    }
    if (this.pendingStaticResults) {
      this.pendingStaticResults.resolve();
      this.pendingStaticResults = undefined;
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingStaticResults = {
        query: initialQuery,
        matches,
        requestId,
        sourceWindowId: this.rendererCommandWindowId,
        resolve,
        reject,
      };
      this.pendingStaticResultsTimer = setTimeout(() => {
        this.pendingStaticResultsTimer = undefined;
        const pending = this.pendingStaticResults;
        this.pendingStaticResults = undefined;
        if (!pending) { return; }
        const run = () => this.showStaticResultsNow(
          pending.query,
          pending.matches,
          pending.requestId,
          pending.sourceWindowId,
        );
        const next = this.staticResultsChain.then(run, run);
        this.staticResultsChain = next.then(() => undefined, () => undefined);
        void next.then(pending.resolve, pending.reject);
      }, 45);
    });
  }

  // Drive the in-panel "Estimated" toggle button from the extension: `visible`
  // shows/hides it (only when a low-confidence envelope exists), `pressed` marks
  // whether the envelope is currently shown. Fire-and-forget; harmless if the
  // renderer is not up yet.
  setEstimatedToggleState(state: { visible: boolean; pressed: boolean }): void {
    void this.postToRenderer({
      type: 'estimatedToggle',
      visible: state.visible,
      pressed: state.pressed,
    });
  }

  private async showStaticResultsNow(
    initialQuery: string,
    matches: FileMatch[],
    requestId: number,
    sourceWindowId?: number,
  ): Promise<void> {
    if (requestId !== this.staticResultsRequestSeq) { return; }
    this.cancelActive();
    this.currentSearchSession = undefined;
    const reusePendingPanel = sourceWindowId !== undefined &&
      this.rendererCommandPendingPanelWindowId === sourceWindowId &&
      Date.now() <= this.rendererCommandPendingPanelExpiresAt;
    if (reusePendingPanel) {
      this.rendererCommandPendingPanelWindowId = undefined;
      this.rendererCommandPendingPanelExpiresAt = 0;
    }
    await this.show(initialQuery, {
      forceLiteral: true,
      suppressSearch: true,
      preferredWindowId: sourceWindowId,
      spawn: sourceWindowId !== undefined && !reusePendingPanel,
      preservePreview: reusePendingPanel,
    });
    if (requestId !== this.staticResultsRequestSeq) { return; }
    const searchId = ++this.searchSeq;
    const totalMatches = matches.reduce((sum, match) => sum + match.matches.length, 0);
    const messages: OverlayMessage[] = [{ type: 'results:start', searchId }];
    const batchSize = 64;
    for (let i = 0; i < matches.length; i += batchSize) {
      if (requestId !== this.staticResultsRequestSeq) { return; }
      messages.push({
        type: 'results:batch',
        searchId,
        matches: matches.slice(i, i + batchSize),
      });
    }
    if (requestId !== this.staticResultsRequestSeq) { return; }
    messages.push({
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
    await this.postMessagesToRenderer(messages);
    this.scheduleCdpSearchIdleClose('static-results-done');
  }

  private async doShow(initialQuery: string, options: ShowOptions = {}): Promise<void> {
    const tShow = Date.now();
    this.log.appendLine(
      `doShow: initialQueryLen=${initialQuery.length} preview=${JSON.stringify(initialQuery.slice(0, 80))}`,
    );
    const directWindowId = options.preferredWindowId ?? this.rendererCommandWindowId ?? this.activeWindowId;
    const useDirectWindow = directWindowId !== undefined && this.shouldEnableRendererInlayClickHook();
    const targetMarker = useDirectWindow ? new vscode.Disposable(() => undefined) : this.beginTargetWindowMarker();
    try {
      const showSeq = ++this.showSeq;
      await this.ensureInjected();
      const tInjected = Date.now();
      let v = useDirectWindow
        ? await this.evaluateShowInWindow(directWindowId, initialQuery, options)
        : await this.evaluateShowInFocusedWindow(initialQuery, options);
      // Brand-new VSCode windows may have missed the initial patch run
      // because their renderer wasn't ready yet ("No target available" in
      // the Injection log). Detect that via `no-show-fn` and run the patch
      // script again — already-patched windows no-op with 'already patched'.
      if (v && v.fid && v.result === 'no-show-fn') {
        this.log.appendLine(`Show(win=${v.fid}): missing patch, re-running inject script...`);
        try {
          const report = await this.runPatchScript(v.fid);
          this.log.appendLine(`Re-inject: ${report}`);
          this.markRendererInlayClickHookReady(report, 'reinject-show');
        } catch (e) {
          this.log.appendLine(`Re-inject failed: ${e instanceof Error ? e.message : e}`);
        }
        v = useDirectWindow
          ? await this.evaluateShowInWindow(directWindowId, initialQuery, options)
          : await this.evaluateShowInFocusedWindow(initialQuery, options);
      }
      if (!v || !v.fid) {
        this.log.appendLine('show() aborted: no focused VSCode window');
        return;
      }
      this.activeWindowId = v.fid;
      const shownRendererSrc = this.extractRendererSource(v.result);
      if (shownRendererSrc) {
        this.activeRendererSrc = shownRendererSrc;
      }
      this.cdpCloseDeferredReasons.clear();
      this.cancelCdpIdleClose();
      const tRendered = Date.now();
      this.log.appendLine(
        `Show(win=${v.fid}): ${v.result} [ensureInjected=${tInjected - tShow}ms showEval=${tRendered - tInjected}ms total=${tRendered - tShow}ms]`,
      );
      if (this.isRendererSafetyDiagnosticsEnabled()) {
        void this.probeRendererSafety('show-complete', 700);
      }
      if (!options.suppressSearch) {
        void this.postSearchHistoryToRenderer().catch((err) => {
          this.log.appendLine(`post search history failed: ${err instanceof Error ? err.message : err}`);
        });
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.scheduleBridgeRepairAfterVisible(showSeq, initialQuery, options);
        const shellOnly = !initialQuery || !!options.suppressSearch;
        this.scheduleCdpSearchIdleClose(shellOnly ? 'show-shell-idle' : 'show-idle', shellOnly ? 250 : 900, shellOnly);
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
        }
        if (!focused) {
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

  private async evaluateShowInWindow(
    windowId: number,
    initialQuery: string,
    options: ShowOptions,
  ): Promise<{ fid: number; result: string } | undefined> {
    if (options.spawn) {
      this.spawnInjectionAttempts++;
      let spawnedFast = false;
      try {
        // Call the pre-installed installer function rather than eval'ing a
        // cached source string. The installer was registered through main's
        // privileged executeJavaScript and is just a normal JS function
        // from the renderer's perspective, so Trusted Types doesn't object.
        const fastReport = await this.evalInWindow(windowId, `
          (function(){
            try {
              if (window.__ijFindAdditionalPatchVersion !== ${JSON.stringify(RENDERER_PATCH_VERSION)}) {
                return 'missing:version';
              }
              var fn = window.__ijFindAdditionalPatchInstaller;
              if (typeof fn !== 'function') { return 'missing:fn'; }
              var value = fn();
              return String(value || '');
            } catch (e) {
              return 'err:' + (e && e.message);
            }
          })()
        `.trim());
        this.lastSpawnInjectionFastReport = fastReport;
        if (fastReport === 'ij-find patch installed' || fastReport.indexOf('already patched') === 0) {
          this.log.appendLine(`Spawn instance fast injection(win=${windowId}): ${fastReport}`);
          this.spawnInjectionFastSuccess++;
          spawnedFast = true;
        } else {
          this.log.appendLine(`Spawn instance fast injection skipped(win=${windowId}): ${fastReport}`);
          this.spawnInjectionFastSkipped++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastSpawnInjectionFastReport = `throw:${message}`;
        this.log.appendLine(`Spawn instance fast injection failed(win=${windowId}): ${message}`);
        this.spawnInjectionFastSkipped++;
      }
      if (!spawnedFast) {
        try {
          const report = await this.runPatchScript(windowId, {
            additionalInstance: true,
            ignoreTargetMarker: true,
          });
          this.lastSpawnInjectionFallbackReport = report;
          this.log.appendLine(`Spawn instance injection(win=${windowId}): ${report}`);
          this.spawnInjectionFallbackSuccess++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.lastSpawnInjectionFallbackReport = `throw:${message}`;
          this.log.appendLine(`Spawn instance injection failed(win=${windowId}): ${message}`);
          this.spawnInjectionFallbackFailed++;
        }
      }
    }
    const showExpr = `(function(){ try { return window.__ijFindShow ? window.__ijFindShow(${JSON.stringify(initialQuery)}, ${JSON.stringify(options)}) : 'no-show-fn'; } catch (e) { return 'show-throw:' + (e && e.message); } })()`;
    const result = await this.evalInWindow(windowId, showExpr);
    if (/^no-window:/.test(result)) { return undefined; }
    return { fid: windowId, result: result || 'ok' };
  }

  private extractRendererSource(result: string | undefined): string | undefined {
    const match = /\bsrc=([A-Za-z0-9._:-]+)/.exec(String(result ?? ''));
    return match?.[1];
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
    await this.cancelPendingPreviewCapture('overlay disposed');
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
    if (this.rendererInlayClickWarmupTimer) {
      clearTimeout(this.rendererInlayClickWarmupTimer);
      this.rendererInlayClickWarmupTimer = undefined;
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

  private scheduleCdpSearchIdleClose(reason: string, delayMs = 350, allowWhileVisible = false): void {
    if (this.shouldAutoCloseCdpForTests()) { return; }
    if (!allowWhileVisible && this.shouldKeepCdpOpenWhileSearchUiVisible() && this.activeWindowId !== undefined) {
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
    const keepRendererSingleton = this.shouldEnableRendererInlayClickHook();
    const delayMs = keepRendererSingleton ? this.getRendererBridgeSingletonIdleMs() : 1500;
    this.cdpIdleCloseTimer = setTimeout(() => {
      this.cdpIdleCloseTimer = undefined;
      if (sourceWindowId !== undefined && this.activeWindowId !== undefined && this.activeWindowId !== sourceWindowId) { return; }
      if (this.showInFlight || this.pendingShow || this.activeSearch) { return; }
      if (keepRendererSingleton) {
        this.log.appendLine(`Renderer bridge singleton idle close after ${delayMs}ms`);
        this.closeCdpWebSocket('renderer singleton idle');
        if (sourceWindowId === undefined || this.activeWindowId === sourceWindowId) {
          this.activeWindowId = undefined;
        }
        this.cdpCloseDeferredReasons.clear();
        return;
      }
      void this.releaseRendererBridge('panel hidden', sourceWindowId, 1500).catch((err) => {
        this.log.appendLine(`Renderer bridge release failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
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
    const keepConsoleBridgeForInlay = this.shouldEnableRendererInlayClickHook() &&
      /panel hidden/i.test(reason);
    const closeMainInspector = this.shouldCloseMainInspector() && !keepConsoleBridgeForInlay;
    const script = `
      (function () {
        var BW = require('electron').BrowserWindow;
        var closeMainInspector = ${JSON.stringify(closeMainInspector)};
        var keepConsoleBridgeForInlay = ${JSON.stringify(keepConsoleBridgeForInlay)};
        var wins = BW.getAllWindows();
        var removed = 0;
        var detached = 0;
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            var consoleBridge = global.__ijFindConsoleBridgeListeners && global.__ijFindConsoleBridgeListeners.get(w.id);
            if (consoleBridge) {
              if (!keepConsoleBridgeForInlay) {
                try { w.webContents.removeListener('console-message', consoleBridge); removed++; } catch (eConsoleRm) {}
                try { global.__ijFindConsoleBridgeListeners.delete(w.id); } catch (eConsoleDel) {}
                try { if (global.__ijFindConsoleBridgeTargets) { global.__ijFindConsoleBridgeTargets.delete(w.id); } } catch (eConsoleTargetDel) {}
              }
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

  private async ensureInjected(options: PatchScriptOptions = {}): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { return; }
    if (this.injectPromise) { return this.injectPromise; }
    this.injectPromise = this.inject(options).finally(() => { this.injectPromise = undefined; });
    return this.injectPromise;
  }

  /** Reconnect to an already-patched renderer without resending/parsing the
   * nearly 1 MB main + additional installers. The console/HTTP bridge survives
   * the extension's idle CDP close, so a small readiness probe is sufficient. */
  private async probeRetainedRendererPatch(options: PatchScriptOptions): Promise<string | undefined> {
    if (options.additionalInstance || options.forceInstall || !this.localBridgeServer || this.localBridgePort === undefined) {
      return undefined;
    }
    const expectedDisableMonacoProbes = !this.shouldEnableRendererMonacoProbes();
    const expectedCapturePaused = this.isMonacoCaptureTemporarilyPaused();
    const expectedPreviewLanguageFeatures = this.shouldEnablePreviewLanguageFeatures();
    const rendererReadyExpr =
      `(function(){try{return window.__ijFindShow&&window.__ijFindOnMessage&&` +
      `window.__ijFindLightStatus&&window.__ijFindPatchVersion===${RENDERER_PATCH_VERSION}` +
      `&&window.__ijFindDisableMonacoProbes===${expectedDisableMonacoProbes ? 'true' : 'false'}` +
      `&&window.__ijFindMonacoCapturePaused===${expectedCapturePaused ? 'true' : 'false'}` +
      `&&window.__ijFindEnablePreviewLanguageFeatures===${expectedPreviewLanguageFeatures ? 'true' : 'false'}` +
      `?'ready':'missing'}catch(e){return 'err:'+(e&&e.message)}})()`;
    const workspaceName = this.getExpectedWorkspaceName();
    const markerText = options.ignoreTargetMarker ? '' : (this.targetWindowMarkerText || '');
    const markerProbeExpr = this.buildTargetMarkerProbeExpression(markerText);
    const preferredWindowId = this.activeWindowId;
    const script = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var preferredWindowId = ${preferredWindowId === undefined ? 'undefined' : JSON.stringify(preferredWindowId)};
        var expectedWorkspace = ${JSON.stringify(workspaceName.toLowerCase())};
        var markerText = ${JSON.stringify(markerText)};
        var markerProbeExpr = ${JSON.stringify(markerProbeExpr)};
        var expectedLocalBridgePort = ${JSON.stringify(this.localBridgePort)};
        var expectedLocalBridgeToken = ${JSON.stringify(this.localBridgeToken)};
        function isWorkbench(win) {
          try { return !!win && /workbench\\.(?:esm\\.)?html/.test(win.webContents.getURL() || ''); }
          catch (e) { return false; }
        }
        function titleMatches(win) {
          if (!expectedWorkspace) { return true; }
          try { return String(win.getTitle() || '').toLowerCase().indexOf(expectedWorkspace) >= 0; }
          catch (e) { return false; }
        }
        async function hasMarker(win) {
          if (!markerText) { return false; }
          try { return await win.webContents.executeJavaScript(markerProbeExpr, true) === true; }
          catch (e) { return false; }
        }
        var all = BW.getAllWindows().filter(isWorkbench);
        var target = null;
        if (markerText) {
          for (var i = 0; i < all.length; i++) {
            if (await hasMarker(all[i])) { target = all[i]; break; }
          }
        }
        if (!target && typeof preferredWindowId === 'number') {
          var preferred = BW.fromId(preferredWindowId);
          if (isWorkbench(preferred) && titleMatches(preferred)) { target = preferred; }
        }
        if (!target) {
          var focused = BW.getFocusedWindow();
          if (isWorkbench(focused) && titleMatches(focused)) { target = focused; }
        }
        if (!target && all.length === 1) { target = all[0]; }
        if (!target) { return 'missing:no-target'; }
        var bridge = global.__ijFindConsoleBridgeListeners && global.__ijFindConsoleBridgeListeners.get(target.id);
        var bridgeTarget = global.__ijFindConsoleBridgeTargets && global.__ijFindConsoleBridgeTargets.get(target.id);
        var bridgeReady = !!bridge && !!bridgeTarget &&
          bridgeTarget.port === expectedLocalBridgePort && bridgeTarget.token === expectedLocalBridgeToken;
        if (!bridgeReady) { return 'missing:stale-console-bridge:' + target.id; }
        var status = await target.webContents.executeJavaScript(${JSON.stringify(rendererReadyExpr)}, true);
        return status === 'ready'
          ? 'ok:' + target.id + ':already patched:retained'
          : 'missing:renderer:' + target.id + ':' + status;
      })()
    `.trim();
    try {
      const response = await this.send('Runtime.evaluate', {
        expression: script,
        includeCommandLineAPI: true,
        returnByValue: true,
        awaitPromise: true,
      }, 1500);
      const report = String(response?.result?.value ?? '');
      return /\bok:\d+:already patched:retained\b/.test(report) ? report : undefined;
    } catch {
      return undefined;
    }
  }

  private async inject(options: PatchScriptOptions = {}): Promise<void> {
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

    const retainedReport = await this.probeRetainedRendererPatch(options);
    if (retainedReport) {
      this.log.appendLine(`Injection: ${retainedReport}`);
      this.markRendererInlayClickHookReady(retainedReport, 'retained-fast-path');
      return;
    }

    const report = await this.runPatchScript(undefined, options);
    this.log.appendLine(`Injection: ${report}`);
    if (!/\bok:/.test(String(report))) {
      throw new Error(`Renderer patch did not install: ${report}`);
    }
    this.markRendererInlayClickHookReady(String(report), options.ignoreTargetMarker ? 'warmup' : 'inject');
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
  private async runPatchScript(targetWindowId?: number, options: PatchScriptOptions = {}): Promise<string> {
    // Pass the patch script directly as the expression — no base64/atob round-trip,
    // which previously corrupted any non-ASCII characters (they arrived as raw UTF-8
    // bytes through atob and broke the parser).
    const localBridge = await this.ensureLocalBridgeServer();
    const rendererMonacoProbesEnabled = this.shouldEnableRendererMonacoProbes();
    const rendererMonacoCapturePaused = this.isMonacoCaptureTemporarilyPaused();
    const patchExpr = getRendererPatchScript(
      rendererMonacoProbesEnabled,
      this.isRendererPerfDiagnosticsEnabled(),
      this.shouldSuspendIntelliSenseRecursionCapture(),
      this.shouldEnableRendererInlayClickHook(),
      this.shouldDisposeRendererPatchOnHide(),
      !!options.additionalInstance,
      this.shouldEnablePreviewLanguageFeatures(),
      rendererMonacoCapturePaused,
    );
    const additionalPatchExpr = getRendererPatchScript(
      rendererMonacoProbesEnabled,
      this.isRendererPerfDiagnosticsEnabled(),
      this.shouldSuspendIntelliSenseRecursionCapture(),
      this.shouldEnableRendererInlayClickHook(),
      this.shouldDisposeRendererPatchOnHide(),
      true,
      this.shouldEnablePreviewLanguageFeatures(),
      rendererMonacoCapturePaused,
    );
    // Readiness gate for the inject fast-path. Beyond the basic patch-version
    // marker, also confirm that renderer-side runtime flags match what this
    // inject would set. This prevents a retained closure from silently keeping
    // the bundled provider bridge disabled after an extension/settings reload.
    // Recovery paths such as __ijFindForceStopMonacoCapture mutate that flag
    // to true while leaving the patch version intact; without re-running the
    // patch script we'd report 'ready' and never reset the flag back to its
    // intended value.
    const expectedDisableMonacoProbes = !rendererMonacoProbesEnabled;
    const expectedCapturePaused = rendererMonacoCapturePaused;
    const expectedPreviewLanguageFeatures = this.shouldEnablePreviewLanguageFeatures();
    const rendererReadyExpr =
      `(function(){try{return window.__ijFindShow&&window.__ijFindOnMessage&&` +
      `window.__ijFindLightStatus&&window.__ijFindPatchVersion===${RENDERER_PATCH_VERSION}` +
      `&&window.__ijFindDisableMonacoProbes===${expectedDisableMonacoProbes ? 'true' : 'false'}` +
      `&&window.__ijFindMonacoCapturePaused===${expectedCapturePaused ? 'true' : 'false'}` +
      `&&window.__ijFindEnablePreviewLanguageFeatures===${expectedPreviewLanguageFeatures ? 'true' : 'false'}` +
      `?'ready':'missing'}catch(e){return 'err:'+(e&&e.message)}})()`;
    const workspaceName = this.getExpectedWorkspaceName();
    const markerText = options.ignoreTargetMarker ? '' : (this.targetWindowMarkerText || '');
    const markerProbeExpr = this.buildTargetMarkerProbeExpression(markerText);

    const injectScript = `
      (async function () {
        var BW = require('electron').BrowserWindow;
        var patchExpr = ${JSON.stringify(patchExpr)};
        var additionalPatchExpr = ${JSON.stringify(additionalPatchExpr)};
        var rendererReadyExpr = ${JSON.stringify(rendererReadyExpr)};
        var rendererBindingName = ${JSON.stringify(RENDERER_BINDING)};
        var mainBridgeBindingName = ${JSON.stringify(BRIDGE_BINDING)};
        var localBridgePort = ${JSON.stringify(localBridge.port)};
        var localBridgeToken = ${JSON.stringify(localBridge.token)};
        var closeMainInspector = ${JSON.stringify(this.shouldCloseMainInspector())};
        var keepConsoleBridgeForInlay = ${JSON.stringify(this.shouldEnableRendererInlayClickHook())};
        var forcePatchInstall = ${JSON.stringify(!!(options.additionalInstance || options.forceInstall))};
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
          if (!global.__ijFindConsoleBridgeTargets) { global.__ijFindConsoleBridgeTargets = new Map(); }
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
                if (keepConsoleBridgeForInlay) { return; }
                setTimeout(function () {
                  try { w.webContents.removeListener('console-message', bridge); } catch (eConsoleSelfRm) {}
                  try {
                    if (global.__ijFindConsoleBridgeListeners &&
                        global.__ijFindConsoleBridgeListeners.get(bridgeWinId) === bridge) {
                      global.__ijFindConsoleBridgeListeners.delete(bridgeWinId);
                      if (global.__ijFindConsoleBridgeTargets) { global.__ijFindConsoleBridgeTargets.delete(bridgeWinId); }
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
                // console-message callbacks are ordered, but independent
                // fetches are not. Serialize posts per BrowserWindow so the
                // renderer's __seq order remains meaningful for stateful
                // events such as search/cancel/save.
                if (!global.__ijFindConsoleBridgeChains) { global.__ijFindConsoleBridgeChains = new Map(); }
                var chains = global.__ijFindConsoleBridgeChains;
                var previousPost = chains.get(bridgeWinId) || Promise.resolve();
                var postPayload = String(payload);
                var forwardThroughBinding = function () {
                  try {
                    if (typeof global[mainBridgeBindingName] === 'function') {
                      global[mainBridgeBindingName](postPayload);
                    }
                  } catch (eBindingFallback) {}
                };
                var post = function () {
                  var controller = typeof AbortController === 'function' ? new AbortController() : null;
                  var abortTimer = controller ? setTimeout(function () {
                    try { controller.abort(); } catch (eAbortPost) {}
                  }, 2000) : null;
                  var request;
                  try {
                    request = fetch('http://127.0.0.1:' + localBridgePort + '/ijss-bridge', {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        'x-ijss-token': localBridgeToken,
                      },
                      body: postPayload,
                      signal: controller ? controller.signal : undefined,
                    });
                  } catch (eStartPost) {
                    if (abortTimer) { clearTimeout(abortTimer); }
                    forwardThroughBinding();
                    return Promise.resolve();
                  }
                  return Promise.resolve(request).then(function () {
                    if (abortTimer) { clearTimeout(abortTimer); }
                  }, function () {
                    if (abortTimer) { clearTimeout(abortTimer); }
                    // The loopback endpoint belongs to the extension host and
                    // can disappear briefly during a reload. If CDP is open,
                    // its main-process binding is a safe ordered fallback;
                    // duplicate delivery is removed by renderer __src/__seq.
                    forwardThroughBinding();
                  });
                };
                var nextPost = previousPost.then(post, post);
                chains.set(bridgeWinId, nextPost);
                var clearPost = function () {
                  try {
                    if (chains.get(bridgeWinId) === nextPost) { chains.delete(bridgeWinId); }
                  } catch (eClearPostChain) {}
                };
                nextPost.then(clearPost, clearPost);
              }
              releaseSelfIfPanelHidden();
              return;
            } catch (eHttpBridge) {}
            try { if (hasMainBridgeBinding) { global[mainBridgeBindingName](payload); } } catch (eForward) {}
            releaseSelfIfPanelHidden();
          };
          w.webContents.on('console-message', bridge);
          global.__ijFindConsoleBridgeListeners.set(w.id, bridge);
          global.__ijFindConsoleBridgeTargets.set(w.id, {
            port: localBridgePort,
            token: localBridgeToken,
          });
        }
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          try {
            installConsoleBridge(w);
            try {
              // Cache the spawn-instance installer as a function so the
              // renderer-side fast path can call it directly. Source-string
              // + (0, eval)(expr) trips Trusted Types on every call; calling
              // a real function is a regular invocation, not eval. Wrap the
              // patch IIFE in parens so the surrounding return parses as one
              // expression (the patch source begins with a newline, which
              // would otherwise let ASI insert a semicolon after return).
              await w.webContents.executeJavaScript(
                'window.__ijFindAdditionalPatchVersion=' + ${JSON.stringify(RENDERER_PATCH_VERSION)} + ';' +
                'window.__ijFindAdditionalPatchInstaller=function(){return(' + additionalPatchExpr.trim() + ');};' +
                '"cached"',
                true
              );
            } catch (eCacheAdditionalPatch) {}
            var status = 'missing';
            try { status = await w.webContents.executeJavaScript(rendererReadyExpr, true); } catch (eStatus) { status = 'status-err:' + eStatus.message; }
            var val = status === 'ready' && !forcePatchInstall
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
	      evt.type !== 'trace' &&
	      evt.type !== 'requestStandaloneMonaco' &&
	      evt.type !== 'requestPreviewNativeRecovery' &&
	      evt.type !== 'requestPreviewLanguageFeature'
	    ) {
	      this.log.appendLine(`ignore renderer event from inactive win=${evt.__win} active=${this.activeWindowId} type=${(evt as any).type}`);
	      return;
	    }
    switch (evt.type) {
      case 'search':
        if (evt.__src) {
          this.activeRendererSrc = evt.__src;
          this.currentSearchRendererSrc = evt.__src;
        }
        if (typeof evt.__win === 'number') {
          this.activeWindowId = evt.__win;
        }
        if (evt.recordHistory) {
          void this.recordSearchHistory(evt.options.query).catch((err) => {
            this.log.appendLine(`record search history failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        void this.runSearch(evt.options);
        break;
      case 'loadMore':
        if (evt.__src) { this.activeRendererSrc = evt.__src; }
        if (typeof evt.__win === 'number') { this.activeWindowId = evt.__win; }
        void this.loadMoreSearch();
        break;
      case 'cancel':
        if (!evt.__src || !this.currentSearchRendererSrc || evt.__src === this.currentSearchRendererSrc) {
          this.currentSearchSession = undefined;
          this.currentSearchRendererSrc = undefined;
          this.cancelActive();
        }
        break;
      case 'panelHidden':
        if (evt.__src) {
          this.previewLanguageTargets.delete(evt.__src);
          this.previewRequestGenerationByRoute.delete(evt.__src);
          this.pendingPreviewRequests.get(evt.__src)?.resolve();
          this.pendingPreviewRequests.delete(evt.__src);
        }
        void this.cancelPendingPreviewCapture('panel hidden');
        if (!evt.__src || !this.currentSearchRendererSrc || evt.__src === this.currentSearchRendererSrc) {
          this.currentSearchSession = undefined;
          this.currentSearchRendererSrc = undefined;
          this.cancelActive();
        }
        if (evt.__src && this.activeRendererSrc === evt.__src) {
          this.activeRendererSrc = undefined;
        }
        if (this.shouldDisposeRendererPatchOnHide() && !this.shouldEnableRendererInlayClickHook()) {
          this.invalidateRendererInlayClickHookReady('panel hidden');
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.scheduleCdpIdleClose(evt.__win);
        }
        break;
      case 'panelDisposed':
        if (evt.__src) {
          this.previewLanguageTargets.delete(evt.__src);
          this.previewRequestGenerationByRoute.delete(evt.__src);
          this.pendingPreviewRequests.get(evt.__src)?.resolve();
          this.pendingPreviewRequests.delete(evt.__src);
          if (this.activeRendererSrc === evt.__src) { this.activeRendererSrc = undefined; }
        }
        break;
      case 'openFile': void this.openFile(evt.uri, evt.line, evt.column, false); break;
      case 'previewFile': void this.openFile(evt.uri, evt.line, evt.column, true); break;
      case 'requestPreview':
        if (evt.__src) { this.activeRendererSrc = evt.__src; }
        if (typeof evt.__win === 'number') { this.activeWindowId = evt.__win; }
        this.rememberPreviewLanguageTarget(evt.__src, evt.__win, evt.uri);
        void this.handlePreviewRequest(evt, {
          windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
          rendererSrc: evt.__src,
        });
        break;
      case 'requestStandaloneMonaco':
        if (typeof evt.__win === 'number') {
          // A renderer only asks when its global bundle is absent, so bypass
          // the optimistic window cache (the renderer may have reloaded while
          // retaining the same BrowserWindow id).
          void this.injectStandaloneMonacoBundle(evt.__win, true);
        }
        break;
      case 'requestPreviewNativeRecovery':
        void this.handleRendererPreviewNativeRecoveryRequest(evt, {
          windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
          rendererSrc: evt.__src,
        });
        break;
      case 'requestPreviewLanguageFeature':
        // Do not let a delayed feature request from the previous model move
        // the live diagnostics subscription back to an older URI.
        this.rememberPreviewLanguageTarget(evt.__src, evt.__win, evt.uri, false);
        void this.handlePreviewLanguageFeatureRequest(evt, {
          windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
          rendererSrc: evt.__src,
        });
        break;
      case 'requestPreviewTextMateGrammar':
        void this.handlePreviewTextMateGrammarRequest(evt, {
          windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
          rendererSrc: evt.__src,
        });
        break;
      case 'requestIntellisenseProbe':
        // Compatibility no-op for a renderer injected by an older extension
        // build. Auto-probing executed both hover and completion providers in
        // addition to Monaco's real hover request, which could restart costly
        // language analysis and destabilize the preview widget.
        break;
      case 'revealFile': void this.revealFile(evt.uri); break;
      case 'openInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, true, true); break;
      case 'pinInSideEditor': void this.openInSideEditor(evt.uri, evt.line, evt.column, false, false); break;
	      // 'requestHover' message + sendHover() were removed in #32. The
	      // embedded preview Monaco editor now drives hover natively
	      // through VSCode's language services, so the renderer never
	      // asks the extension host for hover content.
	      case 'runCommand': void this.runHoverCommand(evt.command, evt.args, evt.__win); break;
	      case 'saveFile':
          void this.enqueuePreviewSave(evt.uri, evt.content, evt.requestId, evt.expectedContentHash, {
            windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
            rendererSrc: evt.__src,
          });
          break;
        case 'saveFileTooLarge':
          void this.rejectOversizedPreviewSave(evt.uri, evt.requestId, evt.bytes, {
            windowId: typeof evt.__win === 'number' ? evt.__win : undefined,
            rendererSrc: evt.__src,
          });
          break;
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

  private injectStandaloneMonacoBundle(windowId: number, verifyRenderer = false): Promise<void> {
    if (!verifyRenderer && this.standaloneMonacoReadyWindows.has(windowId)) {
      return Promise.resolve();
    }
    const existing = this.standaloneMonacoInjectionPromises.get(windowId);
    if (existing) { return existing; }
    const promise = this.injectStandaloneMonacoBundleOnce(windowId).finally(() => {
      if (this.standaloneMonacoInjectionPromises.get(windowId) === promise) {
        this.standaloneMonacoInjectionPromises.delete(windowId);
      }
    });
    this.standaloneMonacoInjectionPromises.set(windowId, promise);
    return promise;
  }

  private async injectStandaloneMonacoBundleOnce(windowId: number): Promise<void> {
    const bundlePath = path.join(this.context.extensionPath, 'resources', 'monaco.bundle.js');
    if (!fs.existsSync(bundlePath)) {
      this.log.appendLine(`standalone Monaco injection failed: missing ${bundlePath}`);
      await this.notifyStandaloneMonacoFailure(windowId, 'bundled editor is missing');
      return;
    }
    try {
      await this.ensureInjected({ ignoreTargetMarker: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`standalone Monaco injection failed before load: ${message}`);
      await this.notifyStandaloneMonacoFailure(windowId, message);
      return;
    }
    const script = `
      (async function () {
        var fs = require('fs');
        var BW = require('electron').BrowserWindow;
        var target = BW.fromId(${JSON.stringify(windowId)});
        var bundlePath = ${JSON.stringify(bundlePath)};
        function isWorkbench(win) {
          try {
            var url = (win && win.webContents && win.webContents.getURL && win.webContents.getURL()) || '';
            return /workbench\\.(?:esm\\.)?html(?:\\?|#|$)/.test(url);
          } catch (e) { return false; }
        }
        if (!target || !isWorkbench(target)) { return 'skip:no-workbench'; }
        var statusExpr = "(function(){try{var nativeReady=!!(window.__ijFindMonacoStatus&&window.__ijFindMonacoStatus()==='ready');var standaloneReady=!!(globalThis.__ijFindMonacoBundleVersion===6&&typeof globalThis.__ijFindMonacoCssText==='string'&&globalThis.__ijFindMonacoCssText.length>=1000&&globalThis.__ijFindMonacoApi&&globalThis.__ijFindMonacoApi.editor&&typeof globalThis.__ijFindMonacoApi.editor.create==='function');return (nativeReady?'native-ready':'native-missing')+','+(standaloneReady?'standalone-ready-v6':'standalone-missing')}catch(e){return 'err:'+(e&&e.message)}})()";
        var before = await target.webContents.executeJavaScript(statusExpr, true);
        var notify = 'not-run';
        var after = 'missing';
        await target.webContents.executeJavaScript("(function(){globalThis.__ijFindStandaloneMonacoInitializing=true;try{if(window.__ijFindStopCapture){window.__ijFindStopCapture('standalone-monaco-load')}}catch(e){}return 'paused'})()", true);
        try {
          if (String(before).indexOf('standalone-ready') < 0) {
            var code = fs.readFileSync(bundlePath, 'utf8');
            await target.webContents.executeJavaScript(code + "\\n//# sourceURL=ijss-monaco.bundle.js", true);
          }
          var notifyExpr = "(function(){try{return window.__ijFindStandaloneMonacoReady?window.__ijFindStandaloneMonacoReady('bundle-ready'):'no-ready-hook'}catch(e){return 'notify-err:'+(e&&e.message)}})()";
          notify = await target.webContents.executeJavaScript(notifyExpr, true);
          after = await target.webContents.executeJavaScript(statusExpr, true);
        } finally {
          await target.webContents.executeJavaScript("(function(){globalThis.__ijFindStandaloneMonacoInitializing=false;return 'resumed'})()", true);
        }
        return 'win=' + target.id + ' before=' + before + ' after=' + after + ' notify=' + notify;
      })()
    `.trim();
    try {
      const resp = await this.send('Runtime.evaluate', {
        expression: script,
        includeCommandLineAPI: true,
        returnByValue: true,
        awaitPromise: true,
      }, 15_000);
      if (resp?.exceptionDetails) {
        const message = `${resp.exceptionDetails.text || ''}:${resp.exceptionDetails.exception?.description || ''}`;
        this.log.appendLine(`standalone Monaco injection failed: ${message}`);
        await this.notifyStandaloneMonacoFailure(windowId, message);
        return;
      }
      const report = String(resp?.result?.value ?? '(no result)');
      this.log.appendLine(`standalone Monaco injection: ${report}`);
      if (/after=[^ ]*standalone-ready/.test(report)) {
        this.standaloneMonacoReadyWindows.add(windowId);
      } else {
        this.standaloneMonacoReadyWindows.delete(windowId);
        await this.notifyStandaloneMonacoFailure(windowId, report);
      }
    } catch (err) {
      this.standaloneMonacoReadyWindows.delete(windowId);
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`standalone Monaco injection failed: ${message}`);
      await this.notifyStandaloneMonacoFailure(windowId, message);
    }
  }

  private async notifyStandaloneMonacoFailure(windowId: number, message: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return; }
    try {
      await this.evalInWindow(
        windowId,
        `(function(){try{return window.__ijFindStandaloneMonacoFailed?window.__ijFindStandaloneMonacoFailed(${JSON.stringify(message.slice(0, 300))}):'no-failure-hook'}catch(e){return 'failure-hook-err:'+(e&&e.message)}})()`,
        1000,
      );
    } catch {}
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

  private async saveFile(
    uriStr: string,
    content: string,
    expectedContentHash?: string,
  ): Promise<{ ok: true; documentHash: string; actualContent: string } | { ok: false; error: string }> {
    try {
      const uri = vscode.Uri.parse(uriStr);
      // Use a WorkspaceEdit so VSCode's edit pipeline tracks the change (undo
      // history, dirty state on any open editor, etc). Direct byte writes are
      // intentionally avoided: they can desynchronize an open
      // TextDocument and can silently change its encoding/BOM.
      const doc = await vscode.workspace.openTextDocument(uri);
      if (expectedContentHash && stableSearchHash(doc.getText()) !== expectedContentHash) {
        throw new Error('The file changed after this preview was loaded; reopen the preview before saving');
      }
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange, content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        throw new Error('VS Code declined to apply the preview edit');
      }
      const refreshed = await vscode.workspace.openTextDocument(uri);
      const saved = await refreshed.save();
      if (!saved) {
        throw new Error('VS Code declined to save the edited document');
      }
      vscode.window.setStatusBarMessage(
        `IJ Find: saved ${vscode.workspace.asRelativePath(uri)}`, 2000,
      );
      const actualContent = refreshed.getText();
      return { ok: true, documentHash: stableSearchHash(actualContent), actualContent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`saveFile failed: ${message}`);
      vscode.window.showErrorMessage(`Save failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  private enqueuePreviewSave(
    uriStr: string,
    content: string,
    requestId: number | undefined,
    expectedContentHash: string | undefined,
    route: RendererMessageRoute,
  ): Promise<void> {
    // WorkspaceEdit/save is asynchronous. Serialize writes to the same URI so
    // two quick Cmd/Ctrl+S presses cannot complete in reverse order and make
    // the renderer accept an older snapshot as the saved baseline.
    const previous = this.previewSaveChains.get(uriStr) ?? Promise.resolve();
    const run = async () => {
      const result = await this.saveFile(uriStr, content, expectedContentHash);
      if (typeof requestId === 'number') {
        let diagnostics: unknown[] | undefined;
        if (result.ok) {
          try {
            diagnostics = serializePreviewDiagnostics(vscode.languages.getDiagnostics(vscode.Uri.parse(uriStr)));
          } catch {}
        }
        await this.postToRenderer({
          type: 'preview:saveResult',
          uri: uriStr,
          requestId,
          ok: result.ok,
          ...(!result.ok ? { error: result.error } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...(result.ok ? { documentHash: result.documentHash } : {}),
          ...(result.ok && result.actualContent !== content ? { savedContent: result.actualContent } : {}),
        }, route);
      }
    };
    const next = previous.then(run, run);
    this.previewSaveChains.set(uriStr, next);
    void next.finally(() => {
      if (this.previewSaveChains.get(uriStr) === next) {
        this.previewSaveChains.delete(uriStr);
      }
    }).catch(() => undefined);
    return next;
  }

  private async rejectOversizedPreviewSave(
    uriStr: string,
    requestId: number,
    bytes: number,
    route: RendererMessageRoute,
  ): Promise<void> {
    const message = `Preview content is too large to save through the renderer bridge (${Math.max(0, bytes)} bytes)`;
    this.log.appendLine(`saveFile rejected: ${message} uri=${uriStr}`);
    vscode.window.showErrorMessage(`Save failed: ${message}`);
    await this.postToRenderer({
      type: 'preview:saveResult',
      uri: uriStr,
      requestId,
      ok: false,
      error: message,
    }, route);
  }

  private async runHoverCommand(command: string, args: unknown[], sourceWindowId?: number) {
    if (typeof command !== 'string' || !command) { return; }
    const previousWindowId = this.rendererCommandWindowId;
    if (typeof sourceWindowId === 'number') {
      this.rendererCommandWindowId = sourceWindowId;
    }
    try {
      const safeArgs = Array.isArray(args) ? args : (args === undefined || args === null ? [] : [args]);
      await vscode.commands.executeCommand(command, ...safeArgs);
    } catch (err) {
      this.log.appendLine(`runHoverCommand(${command}) failed: ${err instanceof Error ? err.message : err}`);
      vscode.window.showErrorMessage(`Command failed: ${command}`);
    } finally {
      this.rendererCommandWindowId = previousWindowId;
    }
  }

  private handlePreviewRequest(evt: PreviewRequestEvent, route: RendererMessageRoute = {}): Promise<void> {
    this.cancelCdpSearchIdleClose();
    const seq = ++this.previewRequestSeq;
    const routeKey = route.rendererSrc ?? (typeof route.windowId === 'number' ? `window:${route.windowId}` : 'active');
    const routeGeneration = (this.previewRequestGenerationByRoute.get(routeKey) ?? 0) + 1;
    this.previewRequestGenerationByRoute.set(routeKey, routeGeneration);
    this.pendingPreviewRequests.get(routeKey)?.resolve();
    return new Promise((resolve) => {
      this.pendingPreviewRequests.set(routeKey, { evt, seq, route, routeKey, routeGeneration, resolve });
      this.schedulePreviewRequestPump();
    });
  }

  private schedulePreviewRequestPump(): void {
    if (this.previewRequestTimer) { return; }
    this.previewRequestTimer = setTimeout(() => {
      this.previewRequestTimer = undefined;
      void this.drainPreviewRequests();
    }, 16);
  }

  private async drainPreviewRequests(): Promise<void> {
    if (this.previewPumpActive) { return; }
    this.previewPumpActive = true;
    try {
      while (this.pendingPreviewRequests.size > 0) {
        const next = this.pendingPreviewRequests.entries().next();
        if (next.done) { break; }
        const [routeKey, queued] = next.value;
        this.pendingPreviewRequests.delete(routeKey);
        await this.deliverLatestPreview(queued);
      }
    } finally {
      this.previewPumpActive = false;
      if (this.pendingPreviewRequests.size > 0) {
        this.schedulePreviewRequestPump();
      }
    }
  }

  private async deliverLatestPreview(queued: QueuedPreviewRequest): Promise<void> {
    const { evt, seq, route, routeKey, routeGeneration } = queued;
    const isLatest = () => this.previewRequestGenerationByRoute.get(routeKey) === routeGeneration;
    try {
      if (!isLatest()) { return; }
      const sent = await this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges, evt.previewSeq, isLatest, route);
      if (sent === false || !isLatest()) { return; }
      this.releasePreviewCaptureTabsSoon('preview-delivered');
      this.scheduleCdpSearchIdleClose('preview-delivered');
      this.startPreviewWarmup(evt, seq, route);
    } finally {
      queued.resolve();
    }
  }

  private startPreviewWarmup(evt: PreviewRequestEvent, seq: number, route: RendererMessageRoute = {}): void {
    const targetWindowId = route.windowId ?? this.activeWindowId;
    if (targetWindowId === undefined) { return; }
    const captureEpoch = this.previewCaptureEpoch;
    const shouldContinue = () => (
      captureEpoch === this.previewCaptureEpoch &&
      seq === this.previewRequestSeq &&
      this.isMonacoCaptureEnabled()
    );
    // The bundled editor is the guaranteed, tab-free path. Start loading it
    // only once a preview is actually requested so opening an empty overlay
    // stays cheap and can paint before the 3.7 MB editor bundle is evaluated.
    const standaloneLoad = this.injectStandaloneMonacoBundle(targetWindowId);
    if (!this.isMonacoCaptureEnabled()) { return; }
    // Give every latest preview its own recovery run. The sequence/epoch gate
    // cancels an older run before its next attempt, while ensureMonacoCapture
    // still serializes an attempt already in flight.
    const warmup = (async () => {
      // Do not let bundle evaluation stop a capture that just started. Await
      // the bounded injection operation before arming private native hooks.
      try { await standaloneLoad; }
      catch (err) {
        this.log.appendLine(`preview bundled Monaco load failed before native warmup: ${err instanceof Error ? err.message : err}`);
      }
      const passiveAttemptLimit = this.shouldAllowTransientPreviewCaptureEditor()
        ? Math.min(1, PREVIEW_NATIVE_PASSIVE_RETRY_DELAYS_MS.length)
        : PREVIEW_NATIVE_PASSIVE_RETRY_DELAYS_MS.length;
      for (let attempt = 0; attempt < passiveAttemptLimit; attempt++) {
        const inFlightWindowCapture = attempt === 0
          ? (this.capturePromise ?? this.backgroundCapturePromise)
          : undefined;
        if (inFlightWindowCapture) {
          try { await inFlightWindowCapture; } catch {}
          if (!shouldContinue() || await this.isMonacoReadyInWindow(targetWindowId)) { return; }
          // The in-flight window-global diagnostic already consumed the one
          // quick passive probe allowed before an opted-in reliable fallback.
          if (this.shouldAllowTransientPreviewCaptureEditor()) { break; }
        }
        await delay(PREVIEW_NATIVE_PASSIVE_RETRY_DELAYS_MS[attempt]);
        if (!shouldContinue()) { return; }
        try {
          await this.ensureMonacoCapture(targetWindowId, undefined, {
            allowForceOpen: false,
            bypassThrottle: true,
            reason: attempt === 0 ? 'preview-request' : `preview-passive-retry-${attempt}`,
            shouldContinue,
          });
        } catch (err) {
          // A CDP reconnect/eval race is transient. Do not discard the rest of
          // this preview's bounded recovery budget because one probe failed.
          this.log.appendLine(
            `preview Monaco passive capture attempt ${attempt + 1}/${passiveAttemptLimit} failed: ` +
              `${err instanceof Error ? err.message : err}`,
          );
        }
        if (!shouldContinue() || await this.isMonacoReadyInWindow(targetWindowId)) { return; }
      }
    })();
    this.previewWarmupPromise = warmup;
    void warmup.finally(() => {
      if (this.previewWarmupPromise === warmup) {
        this.previewWarmupPromise = undefined;
      }
    }).then(async () => {
      if (!shouldContinue()) { return; }
      if (!(await this.isMonacoReadyInWindow(targetWindowId))) {
        if (!this.shouldAllowTransientPreviewCaptureEditor()) {
          this.log.appendLine(
            `preview native Monaco passive recovery exhausted; keeping bundled Monaco without opening an editor ` +
            `(seq=${seq}, previewSeq=${typeof evt.previewSeq === 'number' ? evt.previewSeq : 'none'})`,
          );
          return;
        }
        this.log.appendLine(
          `preview Monaco warmup not ready; scheduling force-open fallback ` +
          `(seq=${seq}, previewSeq=${typeof evt.previewSeq === 'number' ? evt.previewSeq : 'none'})`,
        );
        this.schedulePreviewForceOpen(evt, seq, targetWindowId, route);
        return;
      }
      if (!shouldContinue()) { return; }
      if (typeof evt.previewSeq !== 'number') { return; }
      const isLatest = shouldContinue;
      const sent = await this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges, evt.previewSeq, isLatest, route);
      if (sent === false || !isLatest()) { return; }
      this.releasePreviewCaptureTabsSoon('preview-refresh');
      this.scheduleCdpSearchIdleClose('preview-refresh');
    });
  }

  private async handleRendererPreviewNativeRecoveryRequest(
    evt: PreviewNativeRecoveryRequestEvent,
    route: RendererMessageRoute,
  ): Promise<void> {
    const targetWindowId = route.windowId ?? this.activeWindowId;
    if (targetWindowId === undefined || !evt.uri || !this.isMonacoCaptureEnabled()) { return; }
    // A normal requestPreview already owns a window-global warmup/fallback
    // coordinator. Renderer polling is only a recovery backstop for previews
    // mounted while that host run was paused or cancelled.
    if (this.previewWarmupPromise || this.previewForceOpenPromise || this.previewForceOpenTimer) { return; }
    const initiallyTrackedTarget = route.rendererSrc
      ? this.previewLanguageTargets.get(route.rendererSrc)
      : undefined;
    if (initiallyTrackedTarget &&
        (initiallyTrackedTarget.windowId !== targetWindowId || initiallyTrackedTarget.uri !== evt.uri)) { return; }
    const stillCurrent = () => {
      if (!this.isMonacoCaptureEnabled()) { return false; }
      if (!route.rendererSrc) { return true; }
      const target = this.previewLanguageTargets.get(route.rendererSrc);
      if (!initiallyTrackedTarget) { return true; }
      return !!target && target.windowId === targetWindowId && target.uri === evt.uri;
    };
    if (this.rendererPreviewRecoveryPromise) {
      await this.rendererPreviewRecoveryPromise;
      return;
    }
    let usedForceOpen = false;
    const recovery = (async () => {
      try {
        const allowForceOpen = (evt.attempt ?? 0) >= 4 &&
          this.shouldAllowTransientPreviewCaptureEditor() &&
          Date.now() >= this.previewForceOpenCooldownUntil;
        let forceOpenUri: vscode.Uri | undefined;
        if (allowForceOpen) {
          try { forceOpenUri = vscode.Uri.parse(evt.uri); } catch {}
        }
        if (forceOpenUri) {
          usedForceOpen = true;
          this.previewForceOpenAttemptCount++;
          this.lastPreviewForceOpenUri = evt.uri;
        }
        await this.ensureMonacoCapture(targetWindowId, forceOpenUri, {
          allowForceOpen: !!forceOpenUri,
          holdForceOpenedTab: !!forceOpenUri,
          reason: `renderer-preview-recovery-${Math.max(0, evt.attempt ?? 0)}`,
          shouldContinue: stillCurrent,
        });
        if (!stillCurrent() || !(await this.isMonacoReadyInWindow(targetWindowId))) { return; }
        await this.evalInWindow(
          targetWindowId,
          `(function(){try{return window.__ijFindResumeStandaloneNativePromotion` +
            `?window.__ijFindResumeStandaloneNativePromotion('native-capture-ready')` +
            `:'no-resume-hook'}catch(e){return 'resume-err:'+(e&&e.message)}})()`,
        );
      } catch (err) {
        this.log.appendLine(
          `Renderer-requested native preview recovery failed: ${err instanceof Error ? err.message : err}`,
        );
      } finally {
        if (usedForceOpen) {
          this.previewForceOpenCooldownUntil = Date.now() + PREVIEW_FORCE_OPEN_COOLDOWN_MS;
          this.releasePreviewCaptureTabsSoon('renderer-preview-recovery');
        }
      }
    })();
    const trackedRecovery = recovery.finally(() => {
      if (this.rendererPreviewRecoveryPromise === trackedRecovery) {
        this.rendererPreviewRecoveryPromise = undefined;
      }
    });
    this.rendererPreviewRecoveryPromise = trackedRecovery;
    await this.rendererPreviewRecoveryPromise;
  }

  private schedulePreviewForceOpen(
    evt: PreviewRequestEvent,
    seq: number,
    windowId: number,
    route: RendererMessageRoute,
  ): void {
    if (!this.isMonacoCaptureEnabled()) { return; }
    if (!this.shouldAllowTransientPreviewCaptureEditor()) { return; }
    if (seq !== this.previewRequestSeq) { return; }
    this.pendingPreviewForceOpen = { evt, seq, windowId, route, epoch: this.previewCaptureEpoch };
    if (this.previewForceOpenPromise) {
      this.previewForceOpenSuppressedCount++;
      return;
    }
    const now = Date.now();
    if (now < this.previewForceOpenCooldownUntil) {
      this.previewForceOpenSuppressedCount++;
      const delayMs = Math.max(0, this.previewForceOpenCooldownUntil - now) + PREVIEW_FORCE_OPEN_DEBOUNCE_MS;
      if (this.previewForceOpenTimer) {
        clearTimeout(this.previewForceOpenTimer);
      }
      this.previewForceOpenTimer = setTimeout(() => {
        this.previewForceOpenTimer = undefined;
        void this.runPreviewForceOpen();
      }, delayMs);
      this.log.appendLine(
        `preview Monaco force-open delayed by cooldown (${Math.max(0, this.previewForceOpenCooldownUntil - now)}ms left)`,
      );
      return;
    }
    if (this.previewForceOpenTimer) {
      clearTimeout(this.previewForceOpenTimer);
    }
    // The 750ms debounce coalesces burst navigation (rapid result-row
    // clicks). On the very first cold force-open there is no burst to
    // coalesce yet — debouncing for that long is pure latency. Run almost
    // immediately when no prior attempts have happened; subsequent
    // attempts keep the full burst-coalescing window.
    const isFirstAttempt = this.previewForceOpenAttemptCount === 0 &&
      this.previewForceOpenSuppressedCount === 0;
    const debounceMs = isFirstAttempt
      ? PREVIEW_FORCE_OPEN_FIRST_ATTEMPT_DEBOUNCE_MS
      : PREVIEW_FORCE_OPEN_DEBOUNCE_MS;
    this.previewForceOpenTimer = setTimeout(() => {
      this.previewForceOpenTimer = undefined;
      void this.runPreviewForceOpen();
    }, debounceMs);
  }

  private async runPreviewForceOpen(): Promise<void> {
    if (this.previewForceOpenPromise) {
      await this.previewForceOpenPromise;
      return;
    }
    const queued = this.pendingPreviewForceOpen;
    this.pendingPreviewForceOpen = undefined;
    if (!queued) { return; }
    const { evt, seq, windowId, route, epoch } = queued;
    if (!this.shouldAllowTransientPreviewCaptureEditor()) { return; }
    if (epoch !== this.previewCaptureEpoch) { return; }
    if (seq !== this.previewRequestSeq) { return; }
    const shouldContinue = () =>
      epoch === this.previewCaptureEpoch &&
      seq === this.previewRequestSeq &&
      this.shouldAllowTransientPreviewCaptureEditor() &&
      this.isMonacoCaptureEnabled();
    let attempted = false;
    this.previewForceOpenPromise = (async () => {
      try {
        if (!shouldContinue()) { return; }
        if (await this.isMonacoReadyInWindow(windowId)) {
          await this.refreshLatestPreviewAfterCapture(evt, seq, route, 'preview-force-open-already-ready');
          return;
        }
        attempted = true;
        this.previewForceOpenAttemptCount++;
        this.lastPreviewForceOpenUri = evt.uri;
        await this.ensureMonacoCapture(windowId, vscode.Uri.parse(evt.uri), {
          allowForceOpen: true,
          holdForceOpenedTab: true,
          reason: 'preview-request-force-open',
          shouldContinue,
        });
        if (!shouldContinue()) { return; }
        const latest = this.pendingPreviewForceOpen && this.pendingPreviewForceOpen.seq === this.previewRequestSeq
          ? this.pendingPreviewForceOpen
          : queued;
        if (latest.seq === this.previewRequestSeq) {
          await this.refreshLatestPreviewAfterCapture(latest.evt, latest.seq, latest.route, 'preview-force-open-refresh');
        }
      } catch (err) {
        this.log.appendLine(`preview Monaco force-open capture failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.pendingPreviewForceOpen = undefined;
        this.releasePreviewCaptureTabsSoon('preview-force-open-complete');
      }
    })().finally(() => {
      if (attempted) {
        this.previewForceOpenCooldownUntil = Date.now() + PREVIEW_FORCE_OPEN_COOLDOWN_MS;
      }
      this.previewForceOpenPromise = undefined;
    });
    await this.previewForceOpenPromise;
  }

  private async refreshLatestPreviewAfterCapture(
    evt: PreviewRequestEvent,
    seq: number,
    route: RendererMessageRoute,
    reason: string,
  ): Promise<void> {
    if (seq !== this.previewRequestSeq) { return; }
    const windowId = route.windowId ?? this.activeWindowId;
    if (windowId === undefined || !(await this.isMonacoReadyInWindow(windowId))) { return; }
    if (seq !== this.previewRequestSeq) { return; }
    const isLatest = () => seq === this.previewRequestSeq;
    const sent = await this.sendPreview(evt.uri, evt.line, evt.contextLines, evt.ranges, evt.previewSeq, isLatest, route);
    if (sent === false || !isLatest()) { return; }
    this.releasePreviewCaptureTabsSoon(reason);
    this.scheduleCdpSearchIdleClose(reason);
  }

  // #47 diagnostic: remember the last URI + line we sent into the
  // preview so the manual probe command can target it.
  private lastPreviewUriForDiagnostics: string | undefined;
  private lastPreviewLineForDiagnostics: number | undefined;
  getLastPreviewUriForDiagnostics(): string | undefined { return this.lastPreviewUriForDiagnostics; }
  getLastPreviewLineForDiagnostics(): number | undefined { return this.lastPreviewLineForDiagnostics; }

  private rememberPreviewLanguageTarget(
    rendererSrc: string | undefined,
    windowId: number | undefined,
    uri: string,
    replaceDifferentUri = true,
  ): void {
    if (!rendererSrc || typeof windowId !== 'number' || !uri) { return; }
    const existing = this.previewLanguageTargets.get(rendererSrc);
    if (existing && existing.uri !== uri && !replaceDifferentUri) { return; }
    this.previewLanguageTargets.set(rendererSrc, {
      rendererSrc,
      windowId,
      uri,
      updatedAt: Date.now(),
    });
  }

  private async postPreviewDiagnosticUpdates(uris: readonly vscode.Uri[]): Promise<void> {
    if (!this.shouldEnablePreviewLanguageFeatures() || uris.length === 0) { return; }
    const changed = new Set(uris.map((uri) => uri.toString()));
    const now = Date.now();
    const pending: Promise<void>[] = [];
    for (const [src, target] of this.previewLanguageTargets) {
      if (now - target.updatedAt > 30 * 60_000) {
        this.previewLanguageTargets.delete(src);
        continue;
      }
      if (!changed.has(target.uri)) { continue; }
      let uri: vscode.Uri;
      try { uri = vscode.Uri.parse(target.uri); } catch { continue; }
      pending.push((async () => {
        const document = await vscode.workspace.openTextDocument(uri);
        await this.postToRenderer({
          type: 'preview:diagnostics',
          uri: target.uri,
          diagnostics: serializePreviewDiagnostics(vscode.languages.getDiagnostics(uri)),
          documentHash: stableSearchHash(document.getText()),
        }, {
          windowId: target.windowId,
          rendererSrc: target.rendererSrc,
        });
      })());
    }
    await Promise.all(pending);
  }

  private async handlePreviewLanguageFeatureRequest(
    evt: PreviewLanguageFeatureRequestEvent,
    route: RendererMessageRoute,
  ): Promise<void> {
    const response = {
      type: 'preview:languageFeature' as const,
      requestId: evt.requestId,
      feature: evt.feature,
      uri: evt.uri,
    };
    try {
      if (!Number.isFinite(evt.requestId)) {
        throw new Error('Invalid preview language feature request id');
      }
      const uri = vscode.Uri.parse(evt.uri);
      // Opening the document activates matching language extensions and also
      // lets us clamp renderer coordinates before invoking provider commands.
      const document = await vscode.workspace.openTextDocument(uri);
      const documentVersion = document.version;
      const value = capPreviewLanguageValue(
        evt.feature,
        await this.executePreviewLanguageFeature(evt, document),
      );
      if (document.version !== documentVersion) {
        throw new Error('The document changed while the language provider was running');
      }
      await this.postToRenderer({
        ...response,
        value: value ?? null,
        documentHash: stableSearchHash(document.getText()),
      }, route);
    } catch (err) {
      const message = limitPreviewLanguageText(err instanceof Error ? err.message : String(err), 2_000);
      this.log.appendLine(
        `preview language feature failed: feature=${evt.feature} uri=${evt.uri} error=${message}`,
      );
      await this.postToRenderer({ ...response, error: message }, route);
    }
  }

  private async handlePreviewTextMateGrammarRequest(
    evt: PreviewTextMateGrammarRequestEvent,
    route: RendererMessageRoute,
  ): Promise<void> {
    if (!Number.isSafeInteger(evt.requestId) || evt.requestId < 0) {
      return;
    }
    if (evt.kind === 'catalog') {
      try {
        const languageId = typeof evt.languageId === 'string' && evt.languageId.length <= 256
          ? evt.languageId
          : '';
        const catalog = languageId
          ? await this.textMateGrammarCatalog.getCatalog(languageId)
          : undefined;
        await this.postToRenderer({
          type: 'preview:textMateGrammar',
          requestId: evt.requestId,
          kind: 'catalog',
          ...(catalog ? { value: catalog } : {}),
        }, route);
      } catch (error) {
        await this.postToRenderer({
          type: 'preview:textMateGrammar',
          requestId: evt.requestId,
          kind: 'catalog',
          error: limitPreviewLanguageText(error instanceof Error ? error.message : String(error), 2_000),
        }, route);
      }
      return;
    }

    const generation = Number(evt.generation);
    const assetId = typeof evt.assetId === 'string' && evt.assetId.length <= 1_000
      ? evt.assetId
      : '';
    try {
      if (!Number.isSafeInteger(generation) || generation < 1 || !assetId) {
        throw new Error('Invalid TextMate grammar asset request.');
      }
      const asset = await this.textMateGrammarCatalog.getAsset(generation, assetId);
      const chunkCount = Math.max(1, Math.ceil(asset.bytes.byteLength / PREVIEW_TEXT_MATE_ASSET_CHUNK_BYTES));
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const start = chunkIndex * PREVIEW_TEXT_MATE_ASSET_CHUNK_BYTES;
        const end = Math.min(asset.bytes.byteLength, start + PREVIEW_TEXT_MATE_ASSET_CHUNK_BYTES);
        const chunk = asset.bytes.subarray(start, end);
        await this.postToRenderer({
          type: 'preview:textMateGrammar',
          requestId: evt.requestId,
          kind: 'asset',
          generation: asset.generation,
          assetId: asset.assetId,
          chunkIndex,
          chunkCount,
          base64: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'),
          byteLength: asset.bytes.byteLength,
          sha256: asset.sha256,
          pathHint: asset.pathHint,
        }, route);
      }
    } catch (error) {
      await this.postToRenderer({
        type: 'preview:textMateGrammar',
        requestId: evt.requestId,
        kind: 'asset',
        generation: Number.isSafeInteger(generation) ? generation : 0,
        assetId,
        error: limitPreviewLanguageText(error instanceof Error ? error.message : String(error), 2_000),
      }, route);
    }
  }

  private async postPreviewTextMateGrammarInvalidated(): Promise<void> {
    const now = Date.now();
    const pending: Promise<void>[] = [];
    for (const [rendererSrc, target] of this.previewLanguageTargets) {
      if (now - target.updatedAt > 30 * 60_000) {
        this.previewLanguageTargets.delete(rendererSrc);
        continue;
      }
      pending.push(this.postToRenderer({ type: 'preview:textMateGrammarInvalidated' }, {
        windowId: target.windowId,
        rendererSrc: target.rendererSrc,
      }));
    }
    await Promise.all(pending);
  }

  private async executePreviewLanguageFeature(
    evt: PreviewLanguageFeatureRequestEvent,
    document: vscode.TextDocument,
  ): Promise<unknown> {
    const uri = document.uri;
    if (evt.feature === 'documentSymbol') {
      const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      return serializePreviewDocumentSymbols(symbols ?? []);
    }
    if (evt.feature === 'foldingRange') {
      const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[] | undefined>(
        'vscode.executeFoldingRangeProvider',
        uri,
      );
      return (ranges ?? []).slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS).map(serializePreviewFoldingRange);
    }
    if (evt.feature === 'semanticTokens') {
      const [legend, tokens] = await Promise.all([
        vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
          'vscode.provideDocumentSemanticTokensLegend',
          uri,
        ),
        vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
          'vscode.provideDocumentSemanticTokens',
          uri,
        ),
      ]);
      if (!legend || !tokens) { return null; }
      const cappedLength = Math.min(
        tokens.data.length - (tokens.data.length % 5),
        PREVIEW_LANGUAGE_MAX_SEMANTIC_TOKEN_INTS,
      );
      return {
        legend: {
          tokenTypes: legend.tokenTypes.slice(0, 1_000).map((part) => limitPreviewLanguageText(part, 256)),
          tokenModifiers: legend.tokenModifiers.slice(0, 1_000).map((part) => limitPreviewLanguageText(part, 256)),
        },
        data: Array.from(tokens.data.slice(0, cappedLength)),
        resultId: tokens.resultId ? limitPreviewLanguageText(tokens.resultId, 4_096) : undefined,
      };
    }

    const position = previewLanguagePosition(document, evt.line, evt.column);
    const triggerCharacter = previewLanguageTriggerCharacter(evt.context);
    switch (evt.feature) {
      case 'hover': {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
          'vscode.executeHoverProvider',
          uri,
          position,
        );
        return (hovers ?? []).slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS).map(serializePreviewHover);
      }
      case 'completion': {
        const resolveCount = previewLanguageResolveCount(evt.context);
        const args: unknown[] = [uri, position];
        if (triggerCharacter !== undefined || resolveCount !== undefined) { args.push(triggerCharacter); }
        if (resolveCount !== undefined) { args.push(resolveCount); }
        const completion = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
          'vscode.executeCompletionItemProvider',
          ...args,
        );
        return serializePreviewCompletionList(completion);
      }
      case 'signatureHelp': {
        const args: unknown[] = [uri, position];
        if (triggerCharacter !== undefined) { args.push(triggerCharacter); }
        const signatureHelp = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
          'vscode.executeSignatureHelpProvider',
          ...args,
        );
        return serializePreviewSignatureHelp(signatureHelp);
      }
      case 'definition':
        return serializePreviewLocations(await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeDefinitionProvider', uri, position,
        ));
      case 'declaration':
        return serializePreviewLocations(await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeDeclarationProvider', uri, position,
        ));
      case 'typeDefinition':
        return serializePreviewLocations(await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeTypeDefinitionProvider', uri, position,
        ));
      case 'implementation':
        return serializePreviewLocations(await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
          'vscode.executeImplementationProvider', uri, position,
        ));
      case 'references':
        return serializePreviewLocations(await vscode.commands.executeCommand<vscode.Location[] | undefined>(
          'vscode.executeReferenceProvider', uri, position,
        ));
      case 'documentHighlight': {
        const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[] | undefined>(
          'vscode.executeDocumentHighlights', uri, position,
        );
        return (highlights ?? []).slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS).map((highlight) => ({
          range: serializePreviewRange(highlight.range),
          kind: highlight.kind,
          kindName: previewLanguageEnumName(vscode.DocumentHighlightKind, highlight.kind),
        }));
      }
      default: {
        const exhaustive: never = evt.feature;
        throw new Error(`Unsupported preview language feature: ${String(exhaustive)}`);
      }
    }
  }

  // #47 auto-probe dedupe: don't fire executeHoverProvider /
  // executeCompletionItemProvider for the same (uri, line, col) more
  // than once per ~3s. The renderer-side hover-linger trace fires once
  // per editor lifetime, but multiple rewires/renders can multiply
  // listeners, so multiple probes can land for the same position.
  private intellisenseProbeRecent: Map<string, number> = new Map();
  private async runIntellisenseProbe(uriStr: string, line: number, column: number, source: string): Promise<void> {
    const key = `${uriStr} ${line} ${column}`;
    const now = Date.now();
    const last = this.intellisenseProbeRecent.get(key);
    if (last !== undefined && now - last < 3000) { return; }
    this.intellisenseProbeRecent.set(key, now);
    // GC the dedupe map occasionally so it doesn't grow unbounded.
    if (this.intellisenseProbeRecent.size > 64) {
      const cutoff = now - 60000;
      for (const [k, t] of this.intellisenseProbeRecent) {
        if (t < cutoff) { this.intellisenseProbeRecent.delete(k); }
      }
    }
    try {
      const uri = vscode.Uri.parse(uriStr);
      const pos = new vscode.Position(Math.max(0, line), Math.max(0, column));
      const hoversP = vscode.commands.executeCommand<vscode.Hover[] | undefined>('vscode.executeHoverProvider', uri, pos);
      const compsP = vscode.commands.executeCommand<vscode.CompletionList | undefined>('vscode.executeCompletionItemProvider', uri, pos);
      const hovers = (await hoversP) || [];
      const completions = await compsP;
      const completionCount = completions && Array.isArray(completions.items) ? completions.items.length : 0;
      const hoverSample = hovers
        .slice(0, 2)
        .map((h) => h.contents
          .map((c) => typeof c === 'string'
            ? c
            : (c as vscode.MarkdownString).value || JSON.stringify(c))
          .join(' | '))
        .join(' // ').slice(0, 220);
      const completionSample = (completions && completions.items ? completions.items : [])
        .slice(0, 4)
        .map((it) => it.label && typeof it.label === 'object' ? (it.label as { label: string }).label : String(it.label || ''))
        .join(', ').slice(0, 180);
      this.log.appendLine(
        `[diag-auto] preview-intellisense uri=${uriStr} line=${line} col=${column} source=${source} ` +
        `hovers=${hovers.length} completions=${completionCount} ` +
        `hoverSample="${hoverSample}" completionSample="${completionSample}"`,
      );
    } catch (err) {
      this.log.appendLine(
        `[diag-auto] preview-intellisense probe err: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async sendPreview(
    uriStr: string,
    line: number,
    _contextLines: number,
    ranges: MatchRange[] | undefined,
    previewSeq?: number,
    shouldSend: () => boolean = () => true,
    route?: RendererMessageRoute,
  ): Promise<boolean> {
    try {
      this.lastPreviewUriForDiagnostics = uriStr;
      this.lastPreviewLineForDiagnostics = line;
      const uri = vscode.Uri.parse(uriStr);
      const doc = await vscode.workspace.openTextDocument(uri);
      const preview = buildPreviewPayload(doc, line, ranges);
      if (!shouldSend()) { return false; }
      const relPath = vscode.workspace.asRelativePath(uri, false);
      if (!shouldSend()) { return false; }
      await this.postToRenderer({
        type: 'preview',
        uri: uriStr,
        relPath,
        focusLine: preview.focusLine,
        ranges: preview.ranges,
        previewSeq,
        lines: preview.lines,
        languageId: doc.languageId,
        baseLine: preview.start,
        fullFile: preview.fullFile,
        eol: preview.eol,
        diagnostics: serializePreviewDiagnostics(vscode.languages.getDiagnostics(uri)),
      }, route);
      this.sendPreviewCallGraphInlays(uri, doc, preview.start, preview.end, previewSeq, shouldSend, route);
      return true;
    } catch (err) {
      this.log.appendLine(`preview fetch failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private sendPreviewCallGraphInlays(
    uri: vscode.Uri,
    doc: vscode.TextDocument,
    start: number,
    end: number,
    previewSeq: number | undefined,
    shouldSend: () => boolean,
    route?: RendererMessageRoute,
  ): void {
    const provider = this.previewCallGraphInlayProvider;
    const relPath = vscode.workspace.asRelativePath(uri, false);
    const seqLabel = typeof previewSeq === 'number' ? String(previewSeq) : 'none';
    if (!provider) {
      this.log.appendLine(`preview inlays skipped: no provider uri=${relPath} previewSeq=${seqLabel}`);
      return;
    }
    // Dedup key: same uri + same previewSeq means same user-driven preview
    // event; the second sendPreview() (from refreshLatestPreviewAfterCapture)
    // would otherwise duplicate the provider query.
    const dedupKey = `${route?.rendererSrc ?? 'active'}#${uri.toString()}#${previewSeq ?? 'none'}`;
    if (this.inFlightInlayFetches.has(dedupKey)) {
      this.inlayFetchSkippedDuplicatesCount++;
      this.log.appendLine(
        `preview inlays fetch dedup: uri=${relPath} previewSeq=${seqLabel} (in-flight)`,
      );
      return;
    }
    this.inlayFetchInitiatedCount++;
    const fetchPromise = (async () => {
      const startedAt = Date.now();
      try {
        const rangeStart = new vscode.Position(start, 0);
        const rangeEnd = end > start ? doc.lineAt(end - 1).range.end : rangeStart;
        const previewRange = new vscode.Range(rangeStart, rangeEnd);
        this.log.appendLine(
          `preview inlays fetch start: uri=${relPath} previewSeq=${seqLabel} ` +
          `range=${previewRange.start.line + 1}:${previewRange.start.character + 1}-${previewRange.end.line + 1}:${previewRange.end.character + 1}`,
        );
        const provided = await provider(uri, doc, previewRange);
        const elapsed = Date.now() - startedAt;
        if (provided.length === 0) {
          this.log.appendLine(`preview inlays fetch empty: uri=${relPath} previewSeq=${seqLabel} elapsed=${elapsed}ms`);
          return;
        }
        if (!shouldSend()) {
          this.log.appendLine(`preview inlays dropped stale: uri=${relPath} previewSeq=${seqLabel} count=${provided.length} elapsed=${elapsed}ms`);
          return;
        }
        await this.postToRenderer({
          type: 'preview:inlays',
          uri: uri.toString(),
          previewSeq,
          callGraphInlays: provided,
        }, route);
        const sample = provided
          .slice(0, 3)
          .map((inlay) => `${inlay.kind}:${inlay.line + 1}:${inlay.symbolId}`)
          .join(' | ');
        this.log.appendLine(
          `preview inlays posted: uri=${relPath} previewSeq=${seqLabel} count=${provided.length} ` +
          `elapsed=${elapsed}ms${sample ? ` sample=${sample}` : ''}`,
        );
      } catch (err) {
        this.log.appendLine(`preview call graph inlay fetch failed: ${err instanceof Error ? err.message : err}`);
      }
    })();
    this.inFlightInlayFetches.set(dedupKey, fetchPromise);
    void fetchPromise.finally(() => {
      if (this.inFlightInlayFetches.get(dedupKey) === fetchPromise) {
        this.inFlightInlayFetches.delete(dedupKey);
      }
    });
  }

  /** @internal E2E diagnostics for preview inlay fetch dedup. */
  getInlayFetchStatsForTests(): {
    initiated: number;
    skippedDuplicates: number;
    inFlight: number;
  } {
    return {
      initiated: this.inlayFetchInitiatedCount,
      skippedDuplicates: this.inlayFetchSkippedDuplicatesCount,
      inFlight: this.inFlightInlayFetches.size,
    };
  }

  /** @internal E2E hook; reset counters before a focused test. */
  resetInlayFetchStatsForTests(): void {
    this.inlayFetchInitiatedCount = 0;
    this.inlayFetchSkippedDuplicatesCount = 0;
  }

  // sendHover() removed in #32 along with the renderer-side DIY hover tooltip.

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
      queries: options.queries ? [...options.queries] : undefined,
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      useRegex: options.useRegex,
      regexMultiline: options.regexMultiline,
      includePatterns: options.includePatterns ? [...options.includePatterns] : undefined,
      excludePatterns: options.excludePatterns ? [...options.excludePatterns] : undefined,
    };
  }

  private beginLargeLiteralMultilineSearch(
    burst: LargeLiteralMultilineSearchBurst | undefined,
  ): { coalesced: true; promise: Promise<void> } | { coalesced: false; marker: LargeLiteralMultilineSearchMarker } | undefined {
    if (!burst) { return undefined; }
    const now = Date.now();
    const existing = this.largeLiteralMultilineSearch;
    if (existing?.burst.key === burst.key) {
      const state = existing.completedAt === undefined
        ? `running=${now - existing.startedAt}ms`
        : `cooldown=${now - existing.completedAt}ms`;
      this.log.appendLine(
        `search coalesced: duplicate large literal multiline query len=${burst.chars} lines=${burst.lines} ${state}`,
      );
      return { coalesced: true, promise: existing.promise };
    }
    if (existing?.cleanupTimer) {
      clearTimeout(existing.cleanupTimer);
    }
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    const marker: LargeLiteralMultilineSearchMarker = {
      burst,
      startedAt: now,
      promise,
      resolve,
    };
    this.largeLiteralMultilineSearch = marker;
    return { coalesced: false, marker };
  }

  private finishLargeLiteralMultilineSearch(marker: LargeLiteralMultilineSearchMarker | undefined): void {
    if (!marker) { return; }
    marker.resolve();
    if (this.largeLiteralMultilineSearch !== marker) { return; }
    marker.completedAt = Date.now();
    marker.cleanupTimer = setTimeout(() => {
      if (this.largeLiteralMultilineSearch === marker) {
        this.largeLiteralMultilineSearch = undefined;
      }
    }, LARGE_LITERAL_MULTILINE_SEARCH_COALESCE_MS);
    const maybeNodeTimer = marker.cleanupTimer as unknown as { unref?: () => void };
    if (typeof maybeNodeTimer.unref === 'function') {
      maybeNodeTimer.unref();
    }
  }

  private async runSearch(options: SearchOptions) {
    const queryTerms = searchQueryTerms(options);
    const largeSearch = this.beginLargeLiteralMultilineSearch(
      largeLiteralMultilineSearchBurst(options, queryTerms),
    );
    if (largeSearch?.coalesced) {
      return largeSearch.promise;
    }
    try {
      this.cancelActive();
      const searchId = ++this.searchSeq;
      const rendererSrc = this.activeRendererSrc;
      this.currentSearchRendererSrc = rendererSrc;
      const requestedEngine = getConfiguredSearchEngine();
      const pageSize = getConfiguredResultLimit();
      if (queryTerms.length === 0) {
        this.currentSearchSession = {
          searchId,
          options: this.baseSearchOptions(options),
          requestedEngine,
          effectiveEngine: requestedEngine,
          pageSize,
          loadedMatches: 0,
          loadedUris: new Set<string>(),
          hasMore: false,
          orderedCandidatePaths: null,
          scopedCandidateUris: null,
          rendererSrc,
        };
        await this.postToRenderer({ type: 'results:start', searchId });
        await this.postToRenderer({
          type: 'results:done',
          searchId,
          totalFiles: 0,
          totalMatches: 0,
          truncated: false,
          pageSize,
          pageFiles: 0,
          pageMatches: 0,
          offset: 0,
        });
        return;
      }
      let effectiveEngine: SearchEngine = requestedEngine;
      let fallbackReason: string | undefined;
      if (requestedEngine === 'zoekt') {
        const readiness = await this.zoektRuntime.getSearchReadiness();
        if (!readiness.ready) {
          effectiveEngine = 'codesearch';
          fallbackReason = readiness.reason;
          this.maybePromptZoektIndexRecommendation(readiness.reason);
        }
      }
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
        rendererSrc,
      };
      this.currentSearchSession = session;
      await this.postToRenderer({ type: 'results:start', searchId });
      const t0 = Date.now();
      const optTags = [
        requestedEngine === effectiveEngine ? `engine=${requestedEngine}` : `engine=${requestedEngine}->${effectiveEngine}`,
        options.useRegex ? 'regex' : '',
        options.caseSensitive ? 'case' : '',
        options.wholeWord ? 'word' : '',
        (isRegexMultilineEnabled(options) || (!options.useRegex && queryTerms.some((term) => term.includes('\n')))) ? 'multiline' : '',
        options.includePatterns && options.includePatterns.length > 0 ? `include=${options.includePatterns.length}` : '',
        options.excludePatterns && options.excludePatterns.length > 0 ? `exclude=${options.excludePatterns.length}` : '',
      ].filter(Boolean).join(',') || 'plain';
      const plannerSummary = effectiveEngine === 'zoekt'
        ? 'planner=zoekt'
        : `indexReady=${this.trigramIndex.isReady} indexSize=${this.trigramIndex.size}`;
      this.log.appendLine(
        `search start: len=${queryTerms.join('').length} terms=${queryTerms.length} flags=[${optTags}] ${plannerSummary}`,
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
        const { uris: candidates, reason } = queryTerms.length > 1
          ? { uris: null, reason: 'multi-query OR uses full codesearch fallback' }
          : this.trigramIndex.candidatesFor(options.query, {
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
    } finally {
      this.finishLargeLiteralMultilineSearch(largeSearch?.coalesced ? undefined : largeSearch?.marker);
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
        if (readiness.invalidPattern && !cts.token.isCancellationRequested) {
          // User pattern can't compile: show the error instead of silently
          // falling back to codesearch (same regex engine → same failure).
          progress.onError(new Error(readiness.reason ?? 'invalid regular expression'));
          return;
        }
        if (!readiness.ready && !cts.token.isCancellationRequested) {
          session.effectiveEngine = 'codesearch';
          this.maybePromptZoektIndexRecommendation(readiness.reason);
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

  private async postToRenderer(msg: OverlayMessage, route?: RendererMessageRoute) {
    await this.postMessagesToRenderer([msg], route);
  }

  private async postMessagesToRenderer(messages: OverlayMessage[], route?: RendererMessageRoute) {
    if (messages.length === 0) { return; }
    const windowId = route?.windowId ?? this.activeWindowId;
    if (windowId === undefined) { return; }
    // An explicit route belongs to the originating renderer, even when it is
    // a spawned/inactive panel. Avoid falling back to activeRendererSrc in
    // that case or a late language-provider response can land in a new panel.
    const targetSrc = route ? route.rendererSrc : this.targetRendererSourceForMessages(messages);
    const routedMessages = targetSrc
      ? messages.map((msg) => ({ ...(msg as object), __targetSrc: targetSrc }))
      : messages;
    const payload = JSON.stringify(routedMessages);
    const js = `(function(){try{if(!window.__ijFindOnMessage){return 'missing-onmessage'};var msgs=${payload};for(var i=0;i<msgs.length;i++){window.__ijFindOnMessage(msgs[i]);}return 'ok'}catch(e){return 'err:'+(e&&e.message)}})()`;
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

  private targetRendererSourceForMessages(messages: OverlayMessage[]): string | undefined {
    for (const msg of messages) {
      if ('searchId' in msg && typeof msg.searchId === 'number') {
        if (this.currentSearchSession?.searchId === msg.searchId) {
          return this.currentSearchSession.rendererSrc ?? this.currentSearchRendererSrc ?? this.activeRendererSrc;
        }
      }
    }
    return this.activeRendererSrc;
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
    // The default Node inspector port is 9229. The developer's own VS Code
    // typically owns that port for THEIR extension host. Probing it from
    // inside the test VS Code (which runs on a different port — we pass
    // --inspect=9239 in .vscode-test.mjs) would target the dev VS Code's
    // bridge listeners and start detaching them; the dev workbench loses
    // its IJSS state or crashes outright. Refuse to run during tests.
    const inTest = process.env.VSCODE_TEST === '1' || !!process.env.IJSS_E2E_WORKSPACE;
    if (inTest) {
      this.log.appendLine(`closeStaleIjFindInspector: skipping in test mode to protect dev VS Code`);
      return false;
    }
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
              try { if (global.__ijFindConsoleBridgeTargets) { global.__ijFindConsoleBridgeTargets.clear(); } } catch (eConsoleTargetsClear) {}
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
      const out = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,command=', '-ax'], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
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

      // When running under @vscode/test-electron, never fall back to a
      // global VS Code main scan — the developer's own VS Code is usually
      // running too and a fallback hit would SIGUSR1 that process (waking
      // up its inspector, hijacking its CDP). Tests must stay inside their
      // own ancestor chain.
      const inTest = process.env.VSCODE_TEST === '1' || !!process.env.IJSS_E2E_WORKSPACE;
      if (!inTest) {
        for (const proc of processes.values()) {
          if (this.isVscodeMainProcessCommand(proc.cmd)) {
            this.log.appendLine(`findMainPid: fallback global main pid=${proc.pid}`);
            return proc.pid;
          }
        }
      } else {
        this.log.appendLine('findMainPid: test mode — skipping global fallback to protect dev VS Code');
      }
    } catch (e) {
      this.log.appendLine(`findMainPid ps error: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

function previewLanguageJsonLength(value: unknown): number {
  try { return JSON.stringify(value).length; }
  catch { return Number.POSITIVE_INFINITY; }
}

function largestPreviewLanguageArrayPrefix<T>(
  items: readonly T[],
  buildValue: (prefix: T[]) => unknown,
  multiple = 1,
): T[] {
  let low = 0;
  let high = Math.floor(items.length / multiple);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const count = middle * multiple;
    if (previewLanguageJsonLength(buildValue(items.slice(0, count))) <= PREVIEW_LANGUAGE_MAX_PAYLOAD_CHARS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return items.slice(0, low * multiple);
}

function capPreviewLanguageValue(feature: PreviewLanguageFeature, value: unknown): unknown {
  if (previewLanguageJsonLength(value) <= PREVIEW_LANGUAGE_MAX_PAYLOAD_CHARS) { return value; }
  if (Array.isArray(value)) {
    return largestPreviewLanguageArrayPrefix(value, (prefix) => prefix);
  }
  if (!value || typeof value !== 'object') { return null; }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const items = largestPreviewLanguageArrayPrefix(record.items, (prefix) => ({
      ...record,
      items: prefix,
      isIncomplete: true,
    }));
    return { ...record, items, isIncomplete: true };
  }
  if (Array.isArray(record.signatures)) {
    const signatures = largestPreviewLanguageArrayPrefix(record.signatures, (prefix) => ({
      ...record,
      signatures: prefix,
    }));
    return { ...record, signatures };
  }
  if (feature === 'semanticTokens' && Array.isArray(record.data)) {
    const data = largestPreviewLanguageArrayPrefix(record.data, (prefix) => ({ ...record, data: prefix }), 5);
    return { ...record, data };
  }
  return null;
}

function limitPreviewLanguageText(value: string, maxChars = PREVIEW_LANGUAGE_MAX_TEXT_CHARS): string {
  if (value.length <= maxChars) { return value; }
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function previewLanguageEnumName(enumObject: object, value: unknown): string | undefined {
  if (typeof value !== 'number') { return undefined; }
  const name = (enumObject as Record<number, unknown>)[value];
  return typeof name === 'string' ? name : undefined;
}

function previewLanguagePosition(
  document: vscode.TextDocument,
  requestedLine: number | undefined,
  requestedColumn: number | undefined,
): vscode.Position {
  const lastLine = Math.max(0, document.lineCount - 1);
  const line = Math.min(lastLine, Math.max(0, Number.isFinite(requestedLine) ? Math.trunc(requestedLine!) : 0));
  const lastColumn = document.lineAt(line).text.length;
  const column = Math.min(lastColumn, Math.max(0, Number.isFinite(requestedColumn) ? Math.trunc(requestedColumn!) : 0));
  return new vscode.Position(line, column);
}

function previewLanguageTriggerCharacter(context: Record<string, unknown> | undefined): string | undefined {
  const value = context?.triggerCharacter;
  if (typeof value !== 'string' || value.length === 0) { return undefined; }
  return Array.from(value)[0];
}

function previewLanguageResolveCount(context: Record<string, unknown> | undefined): number | undefined {
  const value = context?.itemResolveCount ?? context?.resolveCount;
  if (typeof value !== 'number' || !Number.isFinite(value)) { return undefined; }
  return Math.min(PREVIEW_LANGUAGE_MAX_COMPLETION_ITEMS, Math.max(0, Math.trunc(value)));
}

function serializePreviewPosition(position: vscode.Position): SerializedPosition {
  return { line: position.line, character: position.character };
}

function serializePreviewRange(range: vscode.Range): SerializedRange {
  return {
    start: serializePreviewPosition(range.start),
    end: serializePreviewPosition(range.end),
  };
}

function serializePreviewMarkdown(value: unknown): SerializedMarkdown | undefined {
  if (typeof value === 'string') {
    return { value: limitPreviewLanguageText(value) };
  }
  if (!value || typeof value !== 'object') { return undefined; }
  const record = value as Record<string, unknown>;
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    const language = record.language.replace(/[\r\n`]/g, '').slice(0, 64);
    return { value: `\`\`\`${language}\n${limitPreviewLanguageText(record.value)}\n\`\`\`` };
  }
  if (typeof record.value !== 'string') { return undefined; }
  const markdown: SerializedMarkdown = { value: limitPreviewLanguageText(record.value) };
  if (typeof record.isTrusted === 'boolean') {
    markdown.isTrusted = record.isTrusted;
  } else if (record.isTrusted && typeof record.isTrusted === 'object') {
    const commands = (record.isTrusted as { enabledCommands?: unknown }).enabledCommands;
    if (Array.isArray(commands)) {
      markdown.isTrusted = {
        enabledCommands: commands
          .filter((command): command is string => typeof command === 'string')
          .slice(0, 100)
          .map((command) => limitPreviewLanguageText(command, 256)),
      };
    }
  }
  if (typeof record.supportHtml === 'boolean') { markdown.supportHtml = record.supportHtml; }
  if (typeof record.supportThemeIcons === 'boolean') { markdown.supportThemeIcons = record.supportThemeIcons; }
  const baseUri = record.baseUri as { toString?: () => string } | undefined;
  if (baseUri && typeof baseUri.toString === 'function') {
    markdown.baseUri = limitPreviewLanguageText(baseUri.toString(), 32_768);
  }
  return markdown;
}

function serializePreviewHover(hover: vscode.Hover): unknown {
  return {
    contents: hover.contents
      .slice(0, PREVIEW_LANGUAGE_MAX_MARKDOWN_PARTS)
      .map(serializePreviewMarkdown)
      .filter((part): part is SerializedMarkdown => part !== undefined),
    range: hover.range ? serializePreviewRange(hover.range) : undefined,
  };
}

function serializePreviewCompletionRange(range: vscode.CompletionItem['range']): unknown {
  if (!range) { return undefined; }
  if ('inserting' in range && 'replacing' in range) {
    return {
      inserting: serializePreviewRange(range.inserting),
      replacing: serializePreviewRange(range.replacing),
    };
  }
  return serializePreviewRange(range);
}

function serializePreviewTextEdit(edit: vscode.TextEdit): unknown {
  return {
    range: serializePreviewRange(edit.range),
    newText: limitPreviewLanguageText(edit.newText),
  };
}

function serializePreviewUnknown(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set<object>(),
): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') { return value; }
  if (typeof value === 'string') { return limitPreviewLanguageText(value, 4_096); }
  if (typeof value === 'number') { return Number.isFinite(value) ? value : String(value); }
  if (typeof value === 'bigint') { return value.toString(); }
  if (typeof value !== 'object' || depth >= 5 || seen.has(value)) { return undefined; }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value
      .slice(0, 64)
      .map((item) => serializePreviewUnknown(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const candidateUri = value as { scheme?: unknown; path?: unknown; toString?: () => string };
  if (typeof candidateUri.scheme === 'string' && typeof candidateUri.path === 'string' &&
      typeof candidateUri.toString === 'function') {
    seen.delete(value);
    return limitPreviewLanguageText(candidateUri.toString(), 32_768);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    const serialized = serializePreviewUnknown((value as Record<string, unknown>)[key], depth + 1, seen);
    if (serialized !== undefined) { output[key] = serialized; }
  }
  seen.delete(value);
  return output;
}

function serializePreviewCompletionItem(item: vscode.CompletionItem): unknown {
  const rawTextEdit = item.textEdit;
  const rawInsertText = item.insertText;
  const insertTextIsSnippet = rawInsertText instanceof vscode.SnippetString;
  const insertText = typeof rawInsertText === 'string'
    ? rawInsertText
    : rawInsertText instanceof vscode.SnippetString
      ? rawInsertText.value
      : rawTextEdit?.newText;
  const label = typeof item.label === 'string'
    ? limitPreviewLanguageText(item.label, 4_096)
    : {
        label: limitPreviewLanguageText(item.label.label, 4_096),
        detail: item.label.detail ? limitPreviewLanguageText(item.label.detail, 4_096) : undefined,
        description: item.label.description ? limitPreviewLanguageText(item.label.description, 4_096) : undefined,
      };
  return {
    label,
    kind: item.kind,
    kindName: previewLanguageEnumName(vscode.CompletionItemKind, item.kind),
    tags: item.tags?.slice(0, 16),
    detail: item.detail ? limitPreviewLanguageText(item.detail) : undefined,
    documentation: serializePreviewMarkdown(item.documentation),
    sortText: item.sortText ? limitPreviewLanguageText(item.sortText, 4_096) : undefined,
    filterText: item.filterText ? limitPreviewLanguageText(item.filterText, 4_096) : undefined,
    preselect: item.preselect,
    insertText: insertText === undefined ? undefined : limitPreviewLanguageText(insertText),
    insertTextIsSnippet,
    range: serializePreviewCompletionRange(item.range ?? rawTextEdit?.range),
    commitCharacters: item.commitCharacters
      ?.slice(0, 64)
      .map((character) => limitPreviewLanguageText(character, 16)),
    keepWhitespace: item.keepWhitespace,
    textEdit: rawTextEdit ? serializePreviewTextEdit(rawTextEdit) : undefined,
    additionalTextEdits: item.additionalTextEdits
      ?.slice(0, 100)
      .map(serializePreviewTextEdit),
    command: item.command ? {
      title: limitPreviewLanguageText(item.command.title, 4_096),
      command: limitPreviewLanguageText(item.command.command, 1_024),
      arguments: item.command.arguments?.slice(0, 64).map((argument) => serializePreviewUnknown(argument)),
    } : undefined,
  };
}

function serializePreviewCompletionList(completion: vscode.CompletionList | undefined): unknown {
  if (!completion) { return { items: [], isIncomplete: false }; }
  const items = completion.items.slice(0, PREVIEW_LANGUAGE_MAX_COMPLETION_ITEMS);
  return {
    items: items.map(serializePreviewCompletionItem),
    isIncomplete: completion.isIncomplete === true || items.length < completion.items.length,
  };
}

function serializePreviewSignatureHelp(signatureHelp: vscode.SignatureHelp | undefined): unknown {
  if (!signatureHelp) { return undefined; }
  return {
    activeSignature: signatureHelp.activeSignature,
    activeParameter: signatureHelp.activeParameter,
    signatures: signatureHelp.signatures
      .slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS)
      .map((signature) => ({
        label: limitPreviewLanguageText(signature.label),
        documentation: serializePreviewMarkdown(signature.documentation),
        activeParameter: signature.activeParameter,
        parameters: signature.parameters
          .slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS)
          .map((parameter) => ({
            label: typeof parameter.label === 'string'
              ? limitPreviewLanguageText(parameter.label, 4_096)
              : [parameter.label[0], parameter.label[1]],
            documentation: serializePreviewMarkdown(parameter.documentation),
          })),
      })),
  };
}

function serializePreviewLocation(location: vscode.Location | vscode.LocationLink): unknown {
  if ('targetUri' in location) {
    return {
      targetUri: location.targetUri.toString(),
      targetRange: serializePreviewRange(location.targetRange),
      targetSelectionRange: location.targetSelectionRange
        ? serializePreviewRange(location.targetSelectionRange)
        : undefined,
      originSelectionRange: location.originSelectionRange
        ? serializePreviewRange(location.originSelectionRange)
        : undefined,
    };
  }
  return {
    uri: location.uri.toString(),
    range: serializePreviewRange(location.range),
  };
}

function serializePreviewLocations(
  locations: Array<vscode.Location | vscode.LocationLink> | undefined,
): unknown[] {
  return (locations ?? [])
    .slice(0, PREVIEW_LANGUAGE_MAX_RESULT_ITEMS)
    .map(serializePreviewLocation);
}

function serializePreviewDocumentSymbols(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
): unknown[] {
  const budget = { remaining: PREVIEW_LANGUAGE_MAX_SYMBOL_NODES };
  const output: unknown[] = [];
  for (const symbol of symbols) {
    const serialized = serializePreviewDocumentSymbol(symbol, budget, 0);
    if (serialized !== undefined) { output.push(serialized); }
    if (budget.remaining <= 0) { break; }
  }
  return output;
}

function serializePreviewDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
  budget: { remaining: number },
  depth: number,
): unknown | undefined {
  if (budget.remaining <= 0 || depth >= 64) { return undefined; }
  budget.remaining--;
  if ('location' in symbol) {
    return {
      name: limitPreviewLanguageText(symbol.name, 4_096),
      kind: symbol.kind,
      kindName: previewLanguageEnumName(vscode.SymbolKind, symbol.kind),
      tags: symbol.tags?.slice(0, 16),
      containerName: limitPreviewLanguageText(symbol.containerName ?? '', 4_096),
      location: serializePreviewLocation(symbol.location),
    };
  }
  const children: unknown[] = [];
  for (const child of symbol.children ?? []) {
    const serialized = serializePreviewDocumentSymbol(child, budget, depth + 1);
    if (serialized !== undefined) { children.push(serialized); }
    if (budget.remaining <= 0) { break; }
  }
  return {
    name: limitPreviewLanguageText(symbol.name, 4_096),
    detail: limitPreviewLanguageText(symbol.detail ?? ''),
    kind: symbol.kind,
    kindName: previewLanguageEnumName(vscode.SymbolKind, symbol.kind),
    tags: symbol.tags?.slice(0, 16),
    range: serializePreviewRange(symbol.range),
    selectionRange: serializePreviewRange(symbol.selectionRange),
    children,
  };
}

function serializePreviewFoldingRange(range: vscode.FoldingRange): unknown {
  const collapsedText = (range as vscode.FoldingRange & { collapsedText?: unknown }).collapsedText;
  return {
    start: range.start,
    end: range.end,
    kind: range.kind,
    kindName: previewLanguageEnumName(vscode.FoldingRangeKind, range.kind),
    collapsedText: typeof collapsedText === 'string'
      ? limitPreviewLanguageText(collapsedText, 4_096)
      : undefined,
  };
}

function serializePreviewDiagnosticCode(code: vscode.Diagnostic['code']): unknown {
  if (!code || typeof code !== 'object') { return code; }
  return {
    value: code.value,
    target: code.target.toString(),
  };
}

function serializePreviewDiagnostics(diagnostics: readonly vscode.Diagnostic[]): unknown[] {
  return diagnostics
    .slice(0, PREVIEW_LANGUAGE_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      range: serializePreviewRange(diagnostic.range),
      message: limitPreviewLanguageText(diagnostic.message),
      severity: diagnostic.severity,
      severityName: previewLanguageEnumName(vscode.DiagnosticSeverity, diagnostic.severity),
      source: diagnostic.source ? limitPreviewLanguageText(diagnostic.source, 4_096) : undefined,
      code: serializePreviewDiagnosticCode(diagnostic.code),
      tags: diagnostic.tags?.slice(0, 16),
      relatedInformation: diagnostic.relatedInformation
        ?.slice(0, 64)
        .map((related) => ({
          location: serializePreviewLocation(related.location),
          message: limitPreviewLanguageText(related.message),
        })),
    }));
}

type SearchBenchmarkMeasurement = {
  files: number;
  matches: number;
  latencyMs: number;
  chars: number;
  warning?: string;
  cancelled?: boolean;
};

function benchmarkOutputChars(matches: FileMatch[]): number {
  let chars = 0;
  for (const file of matches) {
    for (const match of file.matches) {
      chars += `${file.relPath}:${match.line + 1}:${match.preview}\n`.length;
    }
  }
  return chars;
}

function formatBenchmarkRow(
  queryName: string,
  tool: string,
  measurement: SearchBenchmarkMeasurement,
  verdict: string,
): string {
  const warning = measurement.warning ? ` (${measurement.warning.slice(0, 80)})` : '';
  return `${queryName} | ${tool} | ${measurement.matches} | ${measurement.files} | ${measurement.latencyMs} | ${measurement.chars} | ${verdict}${warning}`;
}

function verdictForBenchmark(indexed: SearchBenchmarkMeasurement, rg: SearchBenchmarkMeasurement): string {
  if (indexed.cancelled || rg.cancelled) { return 'cancelled'; }
  if (indexed.warning) { return 'check'; }
  if (indexed.matches !== rg.matches || indexed.files !== rg.files) { return 'accuracy_check'; }
  if (rg.latencyMs <= 0) { return 'ok'; }
  return indexed.latencyMs <= Math.max(50, rg.latencyMs * 1.25) ? 'ok' : 'slower';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countFileMatches(matches: FileMatch[]): number {
  return matches.reduce((sum, match) => sum + match.matches.length, 0);
}

type SearchFallbackPolicy = NonNullable<SearchOptions['fallbackPolicy']>;

const BOUNDED_SEARCH_FALLBACK_FILE_THRESHOLD = 2_000;

function shouldUseSearchFallback(policy: SearchFallbackPolicy, estimatedFiles: number | null): boolean {
  if (policy === 'always') { return true; }
  if (policy === 'never') { return false; }
  return estimatedFiles !== null && estimatedFiles <= BOUNDED_SEARCH_FALLBACK_FILE_THRESHOLD;
}

function fallbackPolicySkipReason(policy: SearchFallbackPolicy, estimatedFiles: number | null): string {
  if (policy === 'bounded') {
    const estimate = estimatedFiles === null ? 'unknown' : String(estimatedFiles);
    return `fallback skipped by policy=bounded estimated_candidate_files=${estimate} threshold=${BOUNDED_SEARCH_FALLBACK_FILE_THRESHOLD}`;
  }
  return `fallback skipped by policy=${policy}`;
}

function appendFallbackReason(existing: string | undefined, reason: string): string {
  return existing ? `${existing}; ${reason}` : reason;
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
