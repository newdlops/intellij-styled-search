import * as fs from 'fs';
import * as path from 'path';
import { type ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import {
  compilePathScopeMatcher,
  toRipgrepGlobs,
} from './pathScope';
import { findRipgrepPath } from './rgSearch';
import {
  type FileMatch,
  type MatchRange,
  type SearchOptions,
  type SearchProgress,
  splitFileMatchChunks,
  getRequestedResultLimit,
  getRequestedResultOffset,
  compileSearchPathRegex,
  searchQueryTerms,
} from './search';
import type {
  ZoektDiagnoseResponse,
  ZoektEngineResponse,
  ZoektSearchFileResult,
  ZoektSearchFileStreamEvent,
  ZoektInfoResponse,
  ZoektIndexResponse,
  ZoektSearchResponse,
  ZoektUpdateResponse,
} from './zoekProtocol';

type SearchReadiness = {
  ready: boolean;
  reason?: string;
  /** True when the failure is a regex the engine can't compile (bad syntax,
   *  backreference, look-around). The caller should surface this as a user
   *  error rather than falling back to another engine. */
  invalidPattern?: boolean;
};

export type ZoektFreshnessStatus = {
  dirty_open_files: number;
  pending_changed_files: number;
  pending_deleted_files: number;
  pending_renames: number;
  update_in_flight: boolean;
  update_scheduled: boolean;
  updates_paused: boolean;
  last_update_finished_at: string | null;
};

type QueuedRename = {
  oldRelPath: string;
  newRelPath: string;
};

type PaginatedSearchResult = {
  matches: FileMatch[];
  totalFiles: number;
  totalMatches: number;
  availableMatches: number;
  truncated: boolean;
  warnings: string[];
};

const DEFAULT_UPDATE_DEBOUNCE_MS = 5_000;
const DEFAULT_UPDATE_COOLDOWN_MS = 5_000;
const DEFAULT_UPDATE_LOG_MIN_INTERVAL_MS = 10_000;
// The opt-in switches already protect users from unexpected background work.
// Once enabled, an additional fixed delay only makes the runtime look stalled.
const DEFAULT_BACKGROUND_BUILD_DELAY_MS = 0;
const DEFAULT_BACKGROUND_INDEX_DELAY_MS = 0;
const UPDATE_RETRY_WHILE_INDEXING_MS = 1_000;
// A suspended window must retain enough detail for a small incremental update,
// but a large event burst is cheaper and bounded as one workspace sync.
const SUSPENDED_UPDATE_PATH_LIMIT = 200;
const AUTO_BASE_REFRESH_MIN_INTERVAL_MS = 60_000;
const PROCESS_KILL_TIMEOUT_MS = 1_500;
const ZOEKT_PROGRESS_PREFIX = '__ZOEK_PROGRESS__';
const ZOEKT_SEARCH_EVENT_PREFIX = '__ZOEK_SEARCH__';
const ZOEKT_PROTOCOL_VERSION = 1;
// MUST match `SCHEMA_VERSION` in crates/zoek-rs/src/config.rs — the rust binary
// stamps it into .zoek-rs/manifest.json and hasReadyIndex() rejects any other
// value as "incomplete" (→ codesearch fallback). The rust schema was bumped to
// 20 in af9eafb (2026-05-30) without updating this constant, which left every
// freshly-built index looking incomplete and forced the fallback path.
const ZOEKT_SCHEMA_VERSION = 22;
const ZOEKT_WORKSPACE_METADATA_HASH_VERSION = 3;
const ZOEKT_WORKSPACE_INDEX_SCOPE = 'workspace';
const ZOEKT_ALL_FILES_INDEX_SCOPE = 'all';
const ZOEKT_INCLUDE_IGNORED_ENV = 'ZOEK_INDEX_INCLUDE_IGNORED';
const ZOEKT_RG_PATH_ENV = 'ZOEK_RG_PATH';
const ZOEKT_SHARD_HEADER_BYTES = 88;
const ZOEKT_SHARD_MAGIC = Buffer.from('ZKSHRD01', 'ascii');
const MAX_U64_AS_NUMBER = Number(0xffff_ffff_ffff_ffffn);
const ZOEKT_UPDATE_IGNORED_DIR_NAMES = new Set([
  '.zoek-rs',
  '.zoekt-rs',
]);

type ZoektBaseShardManifest = {
  engine?: unknown;
  schemaVersion?: unknown;
  workspaceMetadataHashVersion?: unknown;
  indexScope?: unknown;
  workspaceRoot?: unknown;
  indexRoot?: unknown;
  createdUnixSecs?: unknown;
  buildId?: unknown;
  fingerprint?: unknown;
  workspaceMetadataFingerprint?: unknown;
  configFingerprint?: unknown;
  shardMetadataFingerprint?: unknown;
  stats?: unknown;
  baseShards?: unknown;
};

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveJsonInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parsePositiveJsonU64String(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= 0xffff_ffff_ffff_ffffn ? parsed : null;
  } catch {
    return null;
  }
}

function baseShardFileName(shardId: number): string {
  return `base-shard-${String(shardId).padStart(4, '0')}.zrs`;
}

function normalizedPathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  if (normalizedPathIdentity(left) === normalizedPathIdentity(right)) {
    return true;
  }
  try {
    const [realLeft, realRight] = await Promise.all([
      fs.promises.realpath(left),
      fs.promises.realpath(right),
    ]);
    return normalizedPathIdentity(realLeft) === normalizedPathIdentity(realRight);
  } catch {
    return false;
  }
}

function isValidZoektOverlay(value: unknown): boolean {
  const generation = isJsonRecord(value) ? value.generation : undefined;
  if (!isJsonRecord(value) ||
      !isNonNegativeSafeInteger(generation) ||
      !isNonNegativeSafeInteger(value.updatedUnixSecs) ||
      !Array.isArray(value.entries)) {
    return false;
  }
  return value.entries.every((entry) =>
    isJsonRecord(entry) &&
    typeof entry.relPath === 'string' &&
    isNonNegativeSafeInteger(entry.generation) &&
    entry.generation <= generation &&
    typeof entry.tombstone === 'boolean' &&
    isNonNegativeSafeInteger(entry.modifiedUnixSecs) &&
    typeof entry.contentHash === 'number' &&
    Number.isInteger(entry.contentHash) &&
    entry.contentHash >= 0 &&
    entry.contentHash <= MAX_U64_AS_NUMBER &&
    typeof entry.gramIncomplete === 'boolean' &&
    Array.isArray(entry.grams) &&
    entry.grams.every((gram) => typeof gram === 'string'));
}

const ZOEKT_READINESS_CACHE_TTL_MS = 2_000;
const zoektReadinessCache = new Map<string, { signature: string; expiresAt: number }>();

/**
 * Verify that a manifest describes the complete base-shard set currently on
 * disk. Read only the fixed-size header: readiness must remain cheap even for
 * very large indexes.
 */
export async function hasValidZoektBaseShards(
  indexRoot: string,
  manifest: ZoektBaseShardManifest,
  workspaceRoot: string,
  expectedIndexScope?: 'workspace' | 'all',
): Promise<boolean> {
  const buildId = parsePositiveJsonU64String(manifest.buildId);
  const indexScope = manifest.indexScope;
  if (manifest.engine !== 'zoek-rs' ||
      manifest.schemaVersion !== ZOEKT_SCHEMA_VERSION ||
      manifest.workspaceMetadataHashVersion !== ZOEKT_WORKSPACE_METADATA_HASH_VERSION ||
      (indexScope !== ZOEKT_WORKSPACE_INDEX_SCOPE && indexScope !== ZOEKT_ALL_FILES_INDEX_SCOPE) ||
      (expectedIndexScope !== undefined && indexScope !== expectedIndexScope) ||
      typeof manifest.workspaceRoot !== 'string' ||
      typeof manifest.indexRoot !== 'string' ||
      !isPositiveJsonInteger(manifest.createdUnixSecs) ||
      buildId === null ||
      !isPositiveJsonInteger(manifest.fingerprint) ||
      !isPositiveJsonInteger(manifest.workspaceMetadataFingerprint) ||
      !isPositiveJsonInteger(manifest.configFingerprint) ||
      !isPositiveJsonInteger(manifest.shardMetadataFingerprint) ||
      !isJsonRecord(manifest.stats) ||
      !Array.isArray(manifest.baseShards)) {
    return false;
  }
  const [workspaceMatches, indexMatches] = await Promise.all([
    pathsReferToSameLocation(manifest.workspaceRoot, workspaceRoot),
    pathsReferToSameLocation(manifest.indexRoot, indexRoot),
  ]);
  if (!workspaceMatches || !indexMatches) {
    return false;
  }
  const createdUnixSecs = manifest.createdUnixSecs;

  const shardCount = manifest.stats.shardCount;
  const visitedFiles = manifest.stats.visitedFiles;
  const indexedFiles = manifest.stats.indexedFiles;
  const skippedBinary = manifest.stats.skippedBinary;
  const skippedBinaryExtension = manifest.stats.skippedBinaryExtension;
  const skippedTooLarge = manifest.stats.skippedTooLarge;
  const decodedUtf16Files = manifest.stats.decodedUtf16Files;
  const totalGrams = manifest.stats.totalGrams;
  const totalSourceBytes = manifest.stats.totalSourceBytes;
  const totalShardBytes = manifest.stats.totalShardBytes;
  if (!isPositiveJsonInteger(shardCount) ||
      !isNonNegativeSafeInteger(visitedFiles) ||
      !isNonNegativeSafeInteger(indexedFiles) ||
      !isNonNegativeSafeInteger(skippedBinary) ||
      !isNonNegativeSafeInteger(skippedBinaryExtension) ||
      !isNonNegativeSafeInteger(skippedTooLarge) ||
      !isNonNegativeSafeInteger(decodedUtf16Files) ||
      !isNonNegativeSafeInteger(totalGrams) ||
      !isNonNegativeSafeInteger(totalSourceBytes) ||
      !isNonNegativeSafeInteger(totalShardBytes) ||
      indexedFiles > visitedFiles ||
      decodedUtf16Files > indexedFiles ||
      skippedBinary > visitedFiles ||
      skippedBinaryExtension > visitedFiles ||
      skippedTooLarge > visitedFiles ||
      manifest.baseShards.length !== shardCount) {
    return false;
  }

  const shards: Array<{
    shardId: number;
    fileName: string;
    fileBytes: number;
    docCount: number;
    gramCount: number;
    sourceBytes: number;
  }> = [];
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    const shard = manifest.baseShards[shardId];
    const expectedFileName = baseShardFileName(shardId);
    if (!isJsonRecord(shard) ||
        shard.shardId !== shardId ||
        shard.fileName !== expectedFileName ||
        typeof shard.fileBytes !== 'number' ||
        !Number.isSafeInteger(shard.fileBytes) ||
        shard.fileBytes < ZOEKT_SHARD_HEADER_BYTES ||
        !isNonNegativeSafeInteger(shard.docCount) ||
        !isNonNegativeSafeInteger(shard.gramCount) ||
        !isNonNegativeSafeInteger(shard.sourceBytes)) {
      return false;
    }
    shards.push({
      shardId,
      fileName: expectedFileName,
      fileBytes: shard.fileBytes,
      docCount: shard.docCount,
      gramCount: shard.gramCount,
      sourceBytes: shard.sourceBytes,
    });
  }
  const totalDocs = shards.reduce((sum, shard) => sum + shard.docCount, 0);
  const shardTotalGrams = shards.reduce((sum, shard) => sum + shard.gramCount, 0);
  const shardTotalSourceBytes = shards.reduce((sum, shard) => sum + shard.sourceBytes, 0);
  const shardTotalBytes = shards.reduce((sum, shard) => sum + shard.fileBytes, 0);
  if (indexedFiles !== totalDocs ||
      totalGrams !== shardTotalGrams ||
      totalSourceBytes !== shardTotalSourceBytes ||
      totalShardBytes !== shardTotalBytes) {
    return false;
  }

  try {
    const overlayPath = path.join(indexRoot, 'hot-overlay.json');
    const [overlayText, overlayStats, indexEntries, indexStats, lockStats] = await Promise.all([
      fs.promises.readFile(overlayPath, 'utf8'),
      fs.promises.stat(overlayPath),
      fs.promises.readdir(indexRoot),
      fs.promises.stat(indexRoot),
      fs.promises.stat(path.join(indexRoot, 'search-index.lock')),
    ]);
    const overlay = JSON.parse(overlayText) as unknown;
    if (!isValidZoektOverlay(overlay) ||
        !overlayStats.isFile() ||
        !indexStats.isDirectory() ||
        !lockStats.isFile()) {
      return false;
    }
    const actualShardNames = indexEntries
      .filter((name) => name.startsWith('base-shard-') && name.endsWith('.zrs'))
      .sort();
    const expectedShardNames = shards.map((shard) => shard.fileName).sort();
    if (actualShardNames.length !== expectedShardNames.length ||
        actualShardNames.some((name, index) => name !== expectedShardNames[index])) {
      return false;
    }

    const cacheKey = normalizedPathIdentity(indexRoot);
    const readinessSignature = [
      manifest.buildId,
      manifest.createdUnixSecs,
      manifest.shardMetadataFingerprint,
      indexScope,
      shardCount,
      totalDocs,
      totalGrams,
      totalSourceBytes,
      totalShardBytes,
      shards.map((shard) => [
        shard.shardId,
        shard.fileBytes,
        shard.docCount,
        shard.gramCount,
        shard.sourceBytes,
      ].join(':')).join(','),
      actualShardNames.join(','),
      indexStats.mtimeMs,
      indexStats.ctimeMs,
      overlayStats.size,
      overlayStats.mtimeMs,
      overlayStats.ctimeMs,
    ].join('|');
    const cached = zoektReadinessCache.get(cacheKey);
    if (cached?.signature === readinessSignature && cached.expiresAt > Date.now()) {
      return true;
    }

    const validateShard = async (shard: typeof shards[number]): Promise<boolean> => {
      const shardPath = path.join(indexRoot, shard.fileName);
      const stats = await fs.promises.stat(shardPath);
      if (!stats.isFile() || stats.size !== shard.fileBytes) {
        return false;
      }

      const header = Buffer.alloc(ZOEKT_SHARD_HEADER_BYTES);
      const handle = await fs.promises.open(shardPath, 'r');
      let bytesRead = 0;
      try {
        while (bytesRead < header.length) {
          const result = await handle.read(
            header,
            bytesRead,
            header.length - bytesRead,
            bytesRead,
          );
          if (result.bytesRead === 0) { break; }
          bytesRead += result.bytesRead;
        }
      } finally {
        await handle.close();
      }
      if (bytesRead !== ZOEKT_SHARD_HEADER_BYTES) { return false; }
      const docIdsCount = header.readUInt32LE(32);
      const docsOffset = header.readBigUInt64LE(40);
      const postingsOffset = header.readBigUInt64LE(48);
      const docIdsOffset = header.readBigUInt64LE(56);
      const stringsOffset = header.readBigUInt64LE(64);
      const fileBytes = BigInt(shard.fileBytes);
      const expectedPostingsOffset = BigInt(ZOEKT_SHARD_HEADER_BYTES) +
        (BigInt(shard.docCount) * 48n);
      const expectedDocIdsOffset = expectedPostingsOffset + (BigInt(shard.gramCount) * 16n);
      return header.subarray(0, ZOEKT_SHARD_MAGIC.length).equals(ZOEKT_SHARD_MAGIC) &&
        header.readUInt32LE(8) === ZOEKT_SCHEMA_VERSION &&
        header.readUInt32LE(12) === shard.shardId &&
        header.readBigUInt64LE(16) === BigInt(createdUnixSecs) &&
        header.readBigUInt64LE(80) === buildId &&
        header.readUInt32LE(24) === shard.docCount &&
        header.readUInt32LE(28) === shard.gramCount &&
        docsOffset === BigInt(ZOEKT_SHARD_HEADER_BYTES) &&
        postingsOffset === expectedPostingsOffset &&
        docIdsOffset === expectedDocIdsOffset &&
        stringsOffset === docIdsOffset + BigInt(docIdsCount) &&
        stringsOffset <= fileBytes &&
        header.readBigUInt64LE(72) === fileBytes;
    };
    const validationBatchSize = 16;
    for (let offset = 0; offset < shards.length; offset += validationBatchSize) {
      const validity = await Promise.all(
        shards.slice(offset, offset + validationBatchSize).map(validateShard),
      );
      if (validity.some((valid) => !valid)) { return false; }
    }
    if (zoektReadinessCache.size >= 32 && !zoektReadinessCache.has(cacheKey)) {
      const oldestKey = zoektReadinessCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) { zoektReadinessCache.delete(oldestKey); }
    }
    zoektReadinessCache.set(cacheKey, {
      signature: readinessSignature,
      expiresAt: Date.now() + ZOEKT_READINESS_CACHE_TTL_MS,
    });
    return true;
  } catch {
    return false;
  }
}

class ProcessCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessCancelledError';
  }
}

type InvokeTextResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
};

type InvokeTextHooks = {
  onStderrLine?: (line: string) => boolean | void;
  env?: NodeJS.ProcessEnv;
};

type IndexProgressListener = (message: string, percent?: number) => void;

type IndexProgressState = {
  message: string;
  percent: number | undefined;
};

type BinaryTarget = 'engine' | 'rebuild';

type ProcessKind =
  | 'build'
  | 'search'
  | 'index'
  | 'rebuild'
  | 'update'
  | 'info'
  | 'diagnose'
  | 'benchmark'
  | 'other';

type TrackedChild = {
  id: number;
  child: ChildProcess;
  label: string;
  kind: ProcessKind;
  cancelled: boolean;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

type BinaryPairManifest = {
  formatVersion?: unknown;
  sourceFingerprint?: unknown;
  platform?: unknown;
  artifactId?: unknown;
  files?: Record<string, unknown>;
};

export class ZoektRuntime implements vscode.Disposable {
  private readonly extensionRoot: string;
  private readonly watcher: vscode.FileSystemWatcher | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifecycleCts = new vscode.CancellationTokenSource();
  private binaryPath: string | undefined;
  private rebuildBinaryPath: string | undefined;
  private rustSourceFingerprint: string | undefined;
  private packagedBinaryPairValid: boolean | undefined;
  private readonly globalBinaryPairValidity = new Map<string, { signature: string; valid: boolean }>();
  private readonly binaryCompatibility = new Map<string, boolean>();
  private buildPromise: Promise<void> | undefined;
  private readonly indexPromises = new Map<string, Promise<boolean>>();
  private readonly foregroundIndexPromises = new Map<string, Promise<boolean>>();
  private readonly indexProgressState = new Map<string, IndexProgressState>();
  private readonly indexProgressListeners = new Map<string, Set<IndexProgressListener>>();
  private updatePromise: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingChanged = new Set<string>();
  private pendingDeleted = new Set<string>();
  private pendingRenames: QueuedRename[] = [];
  private readonly activeChildren = new Map<number, TrackedChild>();
  private readonly lastAutoBaseRefreshAt = new Map<string, number>();
  private workspaceSyncNeeded = false;
  private readonly lastWorkspaceSyncAt = new Map<string, number>();
  private readonly lastGitState = new Map<string, string>();
  private nextChildId = 1;
  private disposed = false;
  private externalSweepPromise: Promise<void> | undefined;
  private updatePauseDepth = 0;
  private updatePausedReason = '';
  private updateInFlight = false;
  private lastUpdateFinishedAt = 0;
  private lastUpdateLogAt = 0;
  private suppressedUpdateLogCount = 0;
  private backgroundBuildTimer: ReturnType<typeof setTimeout> | undefined;
  private windowFocusedForTests: boolean | undefined;
  private readonly backgroundIndexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private excludeMatcherCache: {
    key: string;
    matcher: ((relPath: string) => boolean) | null;
  } | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.extensionRoot = context.extensionUri.fsPath;
    const watchExternalChanges = this.shouldWatchExternalFileChanges();
    const watchExternalDeletes = this.shouldWatchExternalFileDeletes();
    if (watchExternalChanges || watchExternalDeletes) {
      const workspaceFolder = this.getWorkspaceFolder();
      const watchPattern: vscode.GlobPattern = workspaceFolder
        ? new vscode.RelativePattern(workspaceFolder, '**/*')
        : '**/*';
      this.watcher = vscode.workspace.createFileSystemWatcher(
        watchPattern,
        !watchExternalChanges,
        !watchExternalChanges,
        !watchExternalDeletes,
      );
      this.watcher.onDidCreate((uri) => { this.queueChanged(uri, 'external-create'); });
      this.watcher.onDidChange((uri) => { this.queueChanged(uri, 'external-change'); });
      this.watcher.onDidDelete((uri) => { this.queueDeleted(uri, 'external-delete'); });
    }
    this.disposables.push(
      ...(this.watcher ? [this.watcher] : []),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          this.queueChanged(uri, 'create');
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.queueSavedDocument(document);
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
          this.queueDeleted(uri, 'delete');
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          this.queueRename(file.oldUri, file.newUri);
        }
      }),
      vscode.window.onDidChangeWindowState((state) => this.handleWindowStateChange(state.focused)),
    );
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.backgroundBuildTimer) {
      clearTimeout(this.backgroundBuildTimer);
      this.backgroundBuildTimer = undefined;
    }
    for (const timer of this.backgroundIndexTimers.values()) {
      clearTimeout(timer);
    }
    this.backgroundIndexTimers.clear();
    this.lifecycleCts.cancel();
    this.clearPending();
    this.cancelRunningProcesses('runtime disposed');
    for (const disposable of this.disposables) {
      try { disposable.dispose(); } catch {}
    }
  }

  cancelRunningProcesses(
    reason = 'cancelled',
    options?: {
      kinds?: Iterable<ProcessKind>;
      sweepPatterns?: string[];
    },
  ): void {
    const kinds = options?.kinds ? new Set(options.kinds) : null;
    for (const tracked of this.activeChildren.values()) {
      if (kinds && !kinds.has(tracked.kind)) { continue; }
      this.terminateTrackedChild(tracked, reason);
    }
    void this.sweepExternalZoektProcesses(reason, options?.sweepPatterns ?? this.sweepPatternsForKinds(kinds));
  }

  pauseFileUpdates(reason: string, options?: { cancelIndexing?: boolean }): vscode.Disposable {
    this.updatePauseDepth += 1;
    this.updatePausedReason = reason;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const cancelKinds: ProcessKind[] = options?.cancelIndexing
      ? ['update', 'index', 'rebuild']
      : ['update'];
    this.cancelRunningProcesses(`paused file updates: ${reason}`, { kinds: cancelKinds });
    this.log.appendLine(`zoek-rs updates paused: ${reason}`);
    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) { return; }
      disposed = true;
      this.updatePauseDepth = Math.max(0, this.updatePauseDepth - 1);
      if (this.updatePauseDepth > 0) { return; }
      const pausedReason = this.updatePausedReason;
      this.updatePausedReason = '';
      this.log.appendLine(`zoek-rs updates resumed: ${pausedReason || reason}`);
      if (
        this.pendingChanged.size > 0 ||
        this.pendingDeleted.size > 0 ||
        this.pendingRenames.length > 0
      ) {
        this.scheduleFlush(2_000);
      }
    });
  }

  async prewarmIfPreferred(): Promise<void> {
    if (this.getConfiguredEngine() !== 'zoekt') { return; }
    if (!this.shouldPrewarmOnActivation()) {
      return;
    }
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return; }
    const binary = await this.resolveBinary(false);
    if (!binary) {
      this.scheduleBackgroundBuild('prewarm');
      return;
    }
    if (await this.hasReadyIndex(workspaceRoot)) { return; }
    this.scheduleBackgroundIndex(workspaceRoot, 'prewarm');
  }

  async rebuildIndex(report?: (message: string, percent?: number) => void): Promise<boolean> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return false; }
    report?.('zoek-rs: preparing indexer runtime');
    this.cancelScheduledBackgroundPreparation();
    const existing = this.foregroundIndexPromises.get(workspaceRoot);
    if (existing) {
      report?.('zoek-rs: waiting for in-flight rebuild');
      const detach = this.attachIndexProgressListener(workspaceRoot, report);
      try {
        return await existing;
      } finally {
        detach();
      }
    }
    const background = this.indexPromises.get(workspaceRoot);
    if (background) {
      report?.('zoek-rs: stopping in-flight background index');
      this.cancelRunningProcesses('explicit rebuild requested', {
        kinds: ['index'],
      });
      try {
        await background;
      } catch {}
    }
    const binary = await this.resolveBinary(true, 'rebuild');
    if (!binary) {
      this.log.appendLine('zoek-rs rebuild skipped: dedicated rebuild binary unavailable.');
      return false;
    }
    const detach = this.attachIndexProgressListener(workspaceRoot, report);
    const promise = (async () => {
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: force rebuilding workspace index');
      const response = await this.invokeJson([binary, workspaceRoot, '--force'], undefined, {
        onStderrLine: (line) => this.handleIndexProgressLine(
          line,
          (message, percent) => this.emitIndexProgress(workspaceRoot, message, percent),
        ),
      });
      if (response.type !== 'index' || !response.ok) {
        throw new Error(this.describeEngineFailure(response, 'zoek-rs index failed'));
      }
      this.logIndexWarnings(response);
      this.log.appendLine(
        `zoek-rs index ready: files=${response.stats.indexedFiles} shards=${response.stats.shardCount} grams=${response.stats.totalGrams}`,
      );
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: index ready', 100);
      return true;
    })().finally(() => {
      this.foregroundIndexPromises.delete(workspaceRoot);
      this.indexProgressState.delete(workspaceRoot);
      detach();
    });
    this.foregroundIndexPromises.set(workspaceRoot, promise);
    return promise;
  }

  async getSearchReadiness(): Promise<SearchReadiness> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) {
      return { ready: false, reason: 'no workspace folder' };
    }
    const binary = await this.resolveBinary(false);
    if (!binary) {
      if (this.buildPromise || this.backgroundBuildTimer) {
        return { ready: false, reason: 'zoek-rs binary build pending' };
      }
      if (this.shouldBuildBinaryInBackgroundOnSearch()) {
        this.scheduleBackgroundBuild('search');
        return { ready: false, reason: 'zoek-rs binary unavailable; background build scheduled' };
      }
      return { ready: false, reason: 'zoek-rs binary unavailable; run Rebuild Search Index to build it' };
    }
    if (this.indexPromises.has(workspaceRoot) || this.foregroundIndexPromises.has(workspaceRoot)) {
      return { ready: false, reason: 'zoek-rs index build in progress' };
    }
    if (await this.hasReadyIndex(workspaceRoot)) {
      return { ready: true };
    }
    if (this.shouldIndexInBackgroundOnSearch()) {
      this.scheduleBackgroundIndex(workspaceRoot, 'search');
      return { ready: false, reason: 'zoek-rs index incomplete; background index scheduled' };
    }
    return { ready: false, reason: 'zoek-rs index incomplete; run Rebuild Search Index to build it' };
  }

  getFreshnessStatus(): ZoektFreshnessStatus {
    return {
      dirty_open_files: vscode.workspace.textDocuments
        .filter((document) => document.uri.scheme === 'file' && document.isDirty)
        .length,
      pending_changed_files: this.pendingChanged.size,
      pending_deleted_files: this.pendingDeleted.size,
      pending_renames: this.pendingRenames.length,
      update_in_flight: this.updateInFlight,
      update_scheduled: !!this.flushTimer,
      updates_paused: this.updatePauseDepth > 0,
      last_update_finished_at: this.lastUpdateFinishedAt > 0
        ? new Date(this.lastUpdateFinishedAt).toISOString()
        : null,
    };
  }

  async runSearch(
    options: SearchOptions,
    token: vscode.CancellationToken,
    progress: SearchProgress,
  ): Promise<SearchReadiness> {
    const readiness = await this.getSearchReadiness();
    if (!readiness.ready) {
      return readiness;
    }
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) {
      return { ready: false, reason: 'no workspace folder' };
    }
    const binary = await this.resolveBinary(false);
    if (!binary) {
      return { ready: false, reason: 'zoek-rs binary disappeared' };
    }
    // Race the workspace sync against a short budget so search doesn't get
    // stuck behind a slow git/incremental update — better to search the
    // slightly stale index now and let sync finish in the background than
    // make the user wait. We still wait for any already-queued incremental
    // file updates because those reflect known edits the user just made.
    const syncBudgetMs = 1_500;
    await Promise.race([
      this.syncWorkspaceIndexIfNeeded(workspaceRoot, binary, 'search'),
      new Promise<void>((resolve) => setTimeout(resolve, syncBudgetMs)),
    ]);
    if (this.hasPendingUpdates()) {
      await this.flushPendingUpdates();
    }
    await this.drainPendingUpdatesBeforeSearch(token);
    try {
      const limit = getRequestedResultLimit(options);
      const offset = getRequestedResultOffset(options);
      const queryArgs = this.effectiveQueryArgs(options);
      const pathScopeMatcher = compilePathScopeMatcher(options.includePatterns, options.excludePatterns);
      const pathRegexMatcher = compileSearchPathRegex(options.pathRegex);
      let sawStreamingSearchEvent = false;
      const emitFileResult = (file: ZoektSearchFileResult): void => {
        const fileMatch = this.toFileMatch(file, workspaceRoot);
        if (
          (pathScopeMatcher && !pathScopeMatcher(fileMatch.relPath)) ||
          (pathRegexMatcher && !pathRegexMatcher(fileMatch.relPath))
        ) {
          return;
        }
        for (const chunk of splitFileMatchChunks(fileMatch)) {
          if (token.isCancellationRequested) { return; }
          progress.onFile(chunk);
        }
      };
      const response = await this.invokeJson([
        binary,
        'search',
        workspaceRoot,
        ...queryArgs,
        '--stream',
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.useRegex && options.regexMultiline === true ? ['--regex-multiline'] : []),
        ...(!options.useRegex && options.wholeWord ? ['--whole-word'] : []),
        ...(!options.caseSensitive ? [] : ['--case-sensitive']),
        ...this.effectiveIncludeArgs(options),
        ...this.effectiveExcludeArgs(options),
        ...this.effectivePathRegexArgs(options),
        '--limit',
        String(limit),
        '--offset',
        String(offset),
      ], token, {
        onStderrLine: (line) => {
          if (!line.startsWith(ZOEKT_SEARCH_EVENT_PREFIX)) {
            return false;
          }
          sawStreamingSearchEvent = true;
          const payload = line.slice(ZOEKT_SEARCH_EVENT_PREFIX.length);
          try {
            const event = JSON.parse(payload) as ZoektSearchFileStreamEvent;
            if (
              event.type === 'search:file' &&
              event.file &&
              typeof event.file.relPath === 'string' &&
              Array.isArray(event.file.matches)
            ) {
              emitFileResult(event.file);
            }
          } catch (err) {
            this.log.appendLine(`zoek-rs search stream parse failed: ${err instanceof Error ? err.message : err}`);
          }
          return true;
        },
      });
      if (response.type !== 'search' || !response.ok) {
        const reason = this.describeEngineFailure(response, 'zoek-rs search failed');
        // A regex the engine (Rust `regex` crate / RE2) can't compile — bad
        // syntax, backreference, or look-around — is a user error, not an
        // engine-readiness problem. Flag it so the caller surfaces the error
        // instead of silently falling back to codesearch (which uses the same
        // regex engine and would fail or, worse, return misleading results).
        const invalidPattern = options.useRegex === true && /regex parse error/i.test(reason);
        return { ready: false, reason, invalidPattern };
      }
      if (token.isCancellationRequested) { return { ready: true }; }
      const page = this.paginateSearchResponse(response, options, workspaceRoot);
      if (page.matches.length === 0 && page.availableMatches > offset) {
        // Engine internal bug: paginator produced an empty page despite
        // the result set not being exhausted. Fall back so the user still
        // gets results. Legitimate "zero matches" is handled below as a
        // normal empty onDone (ready=true) — NOT a fallback, so the UI
        // shows "0 matches" instead of silently running codesearch.
        return {
          ready: false,
          reason: 'zoek-rs returned an empty page before the result set was exhausted; verifying with codesearch',
        };
      }
      for (const warning of page.warnings) {
        this.log.appendLine(`zoek-rs warning: ${warning}`);
      }
      if (!sawStreamingSearchEvent) {
        for (const file of page.matches) {
          if (token.isCancellationRequested) { return { ready: true }; }
          for (const chunk of splitFileMatchChunks(file)) {
            progress.onFile(chunk);
          }
        }
      }
      if (!token.isCancellationRequested) {
        progress.onDone({
          totalFiles: page.totalFiles,
          totalMatches: page.totalMatches,
          truncated: page.truncated,
        });
      }
      return { ready: true };
    } catch (err) {
      if (token.isCancellationRequested || err instanceof ProcessCancelledError) {
        return { ready: true };
      }
      return {
        ready: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async waitForIdle(timeoutMs = 60_000): Promise<void> {
    const start = Date.now();
    while (true) {
      const pendingBuild = this.buildPromise;
      const pendingIndex = [
        ...this.indexPromises.values(),
        ...this.foregroundIndexPromises.values(),
      ];
      const stillFlushing = !!this.flushTimer;
      if (!pendingBuild && pendingIndex.length === 0 && !stillFlushing) {
        await this.updatePromise;
        return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`zoek-rs did not become idle within ${timeoutMs}ms`);
      }
      if (pendingBuild || pendingIndex.length > 0) {
        await Promise.race([
          Promise.allSettled([
            ...(pendingBuild ? [pendingBuild] : []),
            ...pendingIndex,
          ]),
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async collectInfo(): Promise<ZoektInfoResponse | null> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return null; }
    const binary = await this.resolveBinary(false);
    if (!binary) { return null; }
    try {
      const response = await this.invokeJson([binary, 'info', workspaceRoot]);
      if (response.type === 'info' && response.ok) {
        return response;
      }
      this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs info failed'));
      return null;
    } catch (err) {
      this.log.appendLine(`zoek-rs info failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async diagnoseQuery(options: SearchOptions): Promise<ZoektDiagnoseResponse | null> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot || !options.query) { return null; }
    const binary = await this.resolveBinary(false);
    if (!binary) { return null; }
    try {
      const queryArgs = this.effectiveQueryArgs(options);
      const response = await this.invokeJson([
        binary,
        'diagnose',
        workspaceRoot,
        ...queryArgs,
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.useRegex && options.regexMultiline === true ? ['--regex-multiline'] : []),
        ...(!options.useRegex && options.wholeWord ? ['--whole-word'] : []),
        ...(!options.caseSensitive ? [] : ['--case-sensitive']),
        ...this.effectiveIncludeArgs(options),
        ...this.effectiveExcludeArgs(options),
        ...this.effectivePathRegexArgs(options),
      ]);
      if (response.type === 'diagnose' && response.ok) {
        return response;
      }
      this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs diagnose failed'));
      return null;
    } catch (err) {
      this.log.appendLine(`zoek-rs diagnose failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  formatInfoReport(info: ZoektInfoResponse): string {
    const lines = [
      `zoek-rs info`,
      `workspace: ${info.workspaceRoot}`,
      `index: ${info.indexDir}`,
      `manifest: ${info.manifestPresent ? 'present' : 'missing'} recoveredOverlay=${info.recoveredOverlay}`,
      `shards: ${info.shards.length} docs=${info.totalDocumentCount} grams=${info.totalGramCount} bytes=${info.totalShardBytes}`,
      `overlay: generation=${info.overlayGeneration} entries=${info.overlayEntries} live=${info.overlayLiveEntries} tombstones=${info.overlayTombstones} journalBytes=${info.journalBytes}`,
      `compactionSuggested: ${info.compactionSuggested}`,
      `process: peakRss=${info.process.peakRssBytes} minorFaults=${info.process.minorPageFaults} majorFaults=${info.process.majorPageFaults}`,
    ];
    if (info.cleanedTempFiles.length > 0) {
      lines.push(`cleaned temp files: ${info.cleanedTempFiles.join(', ')}`);
    }
    if (info.shards.length > 0) {
      lines.push('shards:');
      for (const shard of info.shards.slice(0, 20)) {
        lines.push(
          `  - ${shard.fileName} valid=${shard.valid} docs=${shard.docCount} grams=${shard.gramCount} fileBytes=${shard.fileBytes} sourceBytes=${shard.sourceBytes}`,
        );
      }
      if (info.shards.length > 20) {
        lines.push(`  - ... ${info.shards.length - 20} more shards`);
      }
    }
    for (const warning of info.warnings) {
      lines.push(`warning: ${warning}`);
    }
    return lines.join('\n');
  }

  formatDiagnoseReport(response: ZoektDiagnoseResponse): string {
    const lines = [
      `zoek-rs diagnose`,
      `workspace: ${response.workspaceRoot}`,
      `query: ${JSON.stringify(response.query)}`,
      `effectiveQuery: ${JSON.stringify(response.effectiveQuery)}`,
      `mode: ${response.queryMode}`,
      `include: ${response.include.length > 0 ? response.include.join(', ') : '(none)'}`,
      `requiredLiterals: ${response.requiredLiterals.length > 0 ? response.requiredLiterals.join(' | ') : '(none)'}`,
      `requiredGrams: ${response.requiredGrams.length > 0 ? response.requiredGrams.join(' | ') : '(none)'}`,
      `baseDocs=${response.baseDocumentCount} baseCandidates=${response.baseCandidateCount} overlayLive=${response.overlayLiveEntries} overlayCandidates=${response.overlayCandidateCount} finalCandidates=${response.finalCandidateCount}`,
      `process: peakRss=${response.process.peakRssBytes} minorFaults=${response.process.minorPageFaults} majorFaults=${response.process.majorPageFaults}`,
    ];
    if (response.fallbackReason) {
      lines.push(`fallbackReason: ${response.fallbackReason}`);
    }
    if (response.grams.length > 0) {
      lines.push('gramDocFreq:');
      for (const gram of response.grams.slice(0, 20)) {
        lines.push(`  - ${gram.gram}: ${gram.docFreq}`);
      }
    }
    if (response.candidateSample.length > 0) {
      lines.push('candidateSample:');
      for (const relPath of response.candidateSample) {
        lines.push(`  - ${relPath}`);
      }
    }
    for (const warning of response.warnings) {
      lines.push(`warning: ${warning}`);
    }
    return lines.join('\n');
  }

  async runBenchmarkForTests(
    fileCounts: number[],
    options?: { profile?: 'synthetic' | 'mixed'; searchOnly?: boolean; virtualIndex?: boolean },
  ): Promise<import('./zoekProtocol').ZoektBenchmarkResponse | null> {
    let binary = await this.resolveBinary(false);
    if (!binary) { return null; }
    const counts = fileCounts
      .map((value) => Math.max(0, Math.floor(value)))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (counts.length === 0) { return null; }
    const runBenchmark = async (engineBinary: string): Promise<ZoektEngineResponse> => this.invokeJson([
      engineBinary,
      'benchmark',
      '--files',
      counts.join(','),
      '--profile',
      options?.profile ?? 'synthetic',
      ...(options?.searchOnly ? ['--search-only'] : []),
      ...(options?.virtualIndex ? ['--virtual-index'] : []),
    ]);
    try {
      let response = await runBenchmark(binary);
      if (
        response.type === 'error' &&
        options?.virtualIndex &&
        /unknown benchmark flag: --virtual-index/.test(response.message)
      ) {
        this.binaryCompatibility.set(binary, false);
        this.clearResolvedBinary('engine', binary);
        binary = await this.resolveBinary(true) ?? binary;
        response = await runBenchmark(binary);
      }
      if (response.type === 'benchmark' && response.ok) {
        return response;
      }
      this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs benchmark failed'));
      return null;
    } catch (err) {
      this.log.appendLine(`zoek-rs benchmark failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private getConfiguredEngine(): 'zoekt' | 'codesearch' {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const raw = cfg.get<string>('engine', 'zoekt');
    return raw === 'codesearch' ? 'codesearch' : 'zoekt';
  }

  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private getWorkspaceRootPath(): string | undefined {
    return this.getWorkspaceFolder()?.uri.fsPath;
  }

  private normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+/g, '/');
  }

  private isIgnoredRelativePath(normalized: string): boolean {
    if (!normalized || normalized === '.') {
      return true;
    }
    if (normalized.split('/').some((segment) => ZOEKT_UPDATE_IGNORED_DIR_NAMES.has(segment))) {
      return true;
    }
    const matcher = this.getUpdateExcludeMatcher();
    return !!matcher && !matcher(normalized);
  }

  private getUpdateExcludeMatcher(): ((relPath: string) => boolean) | null {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const excludeGlobs = cfg.get<string[]>('excludeGlobs', []);
    const key = JSON.stringify(excludeGlobs);
    if (this.excludeMatcherCache?.key === key) {
      return this.excludeMatcherCache.matcher;
    }
    const matcher = compilePathScopeMatcher(undefined, excludeGlobs);
    this.excludeMatcherCache = { key, matcher };
    return matcher;
  }

  private shouldRunIncrementalFileUpdates(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektIncrementalFileUpdates', true);
  }

  private shouldIncludeIgnoredFiles(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektIncludeIgnoredFiles', false);
  }

  private configuredPersistentIndexScope(): 'workspace' | 'all' {
    return this.shouldIncludeIgnoredFiles()
      ? ZOEKT_ALL_FILES_INDEX_SCOPE
      : ZOEKT_WORKSPACE_INDEX_SCOPE;
  }

  private shouldWatchExternalFileDeletes(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektWatchExternalFileDeletes', false);
  }

  private shouldWatchExternalFileChanges(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektWatchExternalFileChanges', true);
  }

  private shouldPrewarmOnActivation(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektPrewarmOnActivation', false);
  }

  private shouldBuildBinaryInBackgroundOnSearch(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektBuildBinaryInBackgroundOnSearch', false);
  }

  private shouldIndexInBackgroundOnSearch(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('zoektIndexInBackgroundOnSearch', false);
  }

  private getConfiguredUpdateDebounceMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('zoektUpdateDebounceMs', DEFAULT_UPDATE_DEBOUNCE_MS);
    if (!Number.isFinite(raw)) { return DEFAULT_UPDATE_DEBOUNCE_MS; }
    return Math.max(250, Math.min(Math.floor(raw), 60_000));
  }

  private getConfiguredUpdateCooldownMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('zoektUpdateCooldownMs', DEFAULT_UPDATE_COOLDOWN_MS);
    if (!Number.isFinite(raw)) { return DEFAULT_UPDATE_COOLDOWN_MS; }
    return Math.max(0, Math.min(Math.floor(raw), 60_000));
  }

  private getConfiguredUpdateLogMinIntervalMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('zoektUpdateLogMinIntervalMs', DEFAULT_UPDATE_LOG_MIN_INTERVAL_MS);
    if (!Number.isFinite(raw)) { return DEFAULT_UPDATE_LOG_MIN_INTERVAL_MS; }
    return Math.max(0, Math.min(Math.floor(raw), 300_000));
  }

  private getConfiguredBackgroundBuildDelayMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('zoektBackgroundBuildDelayMs', DEFAULT_BACKGROUND_BUILD_DELAY_MS);
    if (!Number.isFinite(raw)) { return DEFAULT_BACKGROUND_BUILD_DELAY_MS; }
    return Math.max(0, Math.min(Math.floor(raw), 300_000));
  }

  private getConfiguredBackgroundIndexDelayMs(): number {
    const raw = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<number>('zoektBackgroundIndexDelayMs', DEFAULT_BACKGROUND_INDEX_DELAY_MS);
    if (!Number.isFinite(raw)) { return DEFAULT_BACKGROUND_INDEX_DELAY_MS; }
    return Math.max(0, Math.min(Math.floor(raw), 300_000));
  }

  private getRelativePath(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') { return null; }
    const folder = this.getWorkspaceFolder();
    if (!folder) { return null; }
    const rootPath = folder.uri.fsPath;
    const relPath = path.relative(rootPath, uri.fsPath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
      return null;
    }
    const normalized = this.normalizeRelativePath(relPath);
    if (this.isIgnoredRelativePath(normalized)) {
      return null;
    }
    return normalized;
  }

  private queueSavedDocument(document: vscode.TextDocument): void {
    if (document.isUntitled || document.uri.scheme !== 'file') { return; }
    this.queueChanged(document.uri, 'save');
  }

  /** @internal Deterministic file-change notification for tests. Queues
   *  through the same path as the file watcher but does NOT auto-flush —
   *  call `flushPendingUpdatesForTests()` once after queueing all the
   *  changes for a single test step so the binary runs one batched update
   *  instead of one per file. */
  notifyFileChangedForTests(uri: vscode.Uri, kind: 'changed' | 'deleted' = 'changed'): void {
    if (kind === 'deleted') {
      this.queueDeleted(uri, 'test-notify');
    } else {
      this.queueChanged(uri, 'test-notify');
    }
  }

  /** @internal Deterministic lifecycle seam for foreground scheduling tests. */
  setWindowFocusedForTests(focused: boolean | undefined): void {
    this.windowFocusedForTests = focused;
  }

  /** @internal Tests use this to decide whether to skip a full rebuild. */
  async hasReadyIndexForTests(): Promise<boolean> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return false; }
    return this.hasReadyIndex(workspaceRoot);
  }

  /** @internal Immediately flush every queued change for tests, bypassing
   *  the user-configured debounce/cooldown so the next searchForTests sees
   *  the new state. The VS Code file watcher fires asynchronously after a
   *  fs.writeFile/delete, so we drain it in a short loop: after flushing
   *  what's already queued we yield to the event loop so any pending
   *  watcher callbacks can enqueue their changes, then flush again. */
  async flushPendingUpdatesForTests(): Promise<void> {
    const yieldOnce = () => new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      const beforeChanged = this.pendingChanged.size;
      const beforeDeleted = this.pendingDeleted.size;
      const beforeRenamed = this.pendingRenames.length;
      await this.flushPendingUpdates();
      if (this.updatePromise) {
        try { await this.updatePromise; } catch {}
      }
      await yieldOnce();
      const stillPending = this.pendingChanged.size > 0 ||
        this.pendingDeleted.size > 0 ||
        this.pendingRenames.length > 0 ||
        !!this.flushTimer;
      const movedThisRound = beforeChanged + beforeDeleted + beforeRenamed > 0;
      if (!stillPending && !movedThisRound) { return; }
      if (!stillPending) { return; }
    }
  }

  private queueChanged(uri: vscode.Uri, reason: string): void {
    if (this.disposed) { return; }
    if (!this.shouldRunIncrementalFileUpdates()) { return; }
    const relPath = this.getRelativePath(uri);
    if (!relPath) { return; }
    this.pendingDeleted.delete(relPath);
    this.pendingChanged.add(relPath);
    this.boundSuspendedPendingUpdates();
    this.logQueuedUpdate(reason);
    this.scheduleFlush();
  }

  private queueDeleted(uri: vscode.Uri, reason: string): void {
    if (this.disposed) { return; }
    if (!this.shouldRunIncrementalFileUpdates()) { return; }
    const relPath = this.getRelativePath(uri);
    if (!relPath) { return; }
    this.pendingChanged.delete(relPath);
    this.pendingDeleted.add(relPath);
    this.boundSuspendedPendingUpdates();
    this.logQueuedUpdate(reason);
    this.scheduleFlush();
  }

  private queueRename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    if (this.disposed) { return; }
    if (!this.shouldRunIncrementalFileUpdates()) { return; }
    const oldRelPath = this.getRelativePath(oldUri);
    const newRelPath = this.getRelativePath(newUri);
    if (!oldRelPath && !newRelPath) { return; }
    if (!oldRelPath) {
      if (!newRelPath) { return; }
      this.pendingDeleted.delete(newRelPath);
      this.pendingChanged.add(newRelPath);
      this.boundSuspendedPendingUpdates();
      this.logQueuedUpdate('rename-create');
      this.scheduleFlush();
      return;
    }
    if (!newRelPath) {
      this.pendingChanged.delete(oldRelPath);
      this.pendingDeleted.add(oldRelPath);
      this.boundSuspendedPendingUpdates();
      this.logQueuedUpdate('rename-delete');
      this.scheduleFlush();
      return;
    }
    this.pendingChanged.delete(oldRelPath);
    this.pendingChanged.delete(newRelPath);
    this.pendingDeleted.delete(oldRelPath);
    this.pendingDeleted.delete(newRelPath);
    this.pendingRenames.push({ oldRelPath, newRelPath });
    this.boundSuspendedPendingUpdates();
    this.logQueuedUpdate('rename');
    this.scheduleFlush();
  }

  private hasPendingUpdates(): boolean {
    return this.workspaceSyncNeeded ||
      this.pendingChanged.size > 0 ||
      this.pendingDeleted.size > 0 ||
      this.pendingRenames.length > 0;
  }

  private isWindowFocused(): boolean {
    return this.windowFocusedForTests ?? vscode.window.state.focused;
  }

  private handleWindowStateChange(focused: boolean): void {
    if (!focused) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      return;
    }
    if (this.hasPendingUpdates()) {
      this.scheduleFlush();
    }
  }

  private logQueuedUpdate(reason: string): void {
    if (this.getConfiguredUpdateLogMinIntervalMs() === 0) {
      this.log.appendLine(`zoek-rs update queued: reason=${reason}`);
    }
  }

  private scheduleFlush(delayMs = this.getConfiguredUpdateDebounceMs()): void {
    if (this.disposed) { return; }
    if (this.updatePauseDepth > 0) { return; }
    if (!this.isWindowFocused()) { return; }
    const cooldownMs = this.getConfiguredUpdateCooldownMs();
    if (cooldownMs > 0 && this.lastUpdateFinishedAt > 0) {
      const remainingCooldownMs = cooldownMs - (Date.now() - this.lastUpdateFinishedAt);
      if (remainingCooldownMs > 0) {
        delayMs = Math.max(delayMs, remainingCooldownMs);
      }
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingUpdates(true);
    }, delayMs);
  }

  private async drainPendingUpdatesBeforeSearch(token: vscode.CancellationToken): Promise<void> {
    if (token.isCancellationRequested || this.disposed) { return; }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (token.isCancellationRequested || this.disposed) { return; }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.hasPendingUpdates()) {
      await this.flushPendingUpdates();
    }
    if (this.updateInFlight) {
      try { await this.updatePromise; } catch {}
    }
  }

  private async flushPendingUpdates(automatic = false): Promise<void> {
    if (this.disposed) {
      this.clearPending();
      return;
    }
    if (
      !this.workspaceSyncNeeded &&
      this.pendingChanged.size === 0 &&
      this.pendingDeleted.size === 0 &&
      this.pendingRenames.length === 0
    ) {
      return;
    }
    if (this.updatePauseDepth > 0) {
      return;
    }
    // A blur can race an already-fired debounce timer. Keep the queue intact;
    // focus will arm exactly one replacement timer, while explicit drains pass
    // automatic=false and remain fresh in every window.
    if (automatic && !this.isWindowFocused()) { return; }
    if (!this.shouldRunIncrementalFileUpdates()) {
      this.clearPending();
      return;
    }
    if (this.updateInFlight) {
      this.scheduleFlush();
      return;
    }
    if (this.getConfiguredEngine() !== 'zoekt') {
      this.clearPending();
      return;
    }
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) {
      this.clearPending();
      return;
    }
    const binary = await this.resolveBinary(false);
    if (!binary) {
      this.clearPending();
      return;
    }
    if (automatic && !this.isWindowFocused()) { return; }
    if (this.workspaceSyncNeeded) {
      await this.syncWorkspaceIndexIfNeeded(workspaceRoot, binary, automatic ? 'foreground catch-up' : 'explicit drain', automatic);
    }
    if (
      this.pendingChanged.size === 0 &&
      this.pendingDeleted.size === 0 &&
      this.pendingRenames.length === 0
    ) {
      return;
    }
    const indexBusy = this.indexPromises.has(workspaceRoot) || this.foregroundIndexPromises.has(workspaceRoot);
    const ready = !indexBusy && await this.hasReadyIndex(workspaceRoot);
    if (indexBusy || !ready) {
      if (indexBusy) {
        this.scheduleFlush(UPDATE_RETRY_WHILE_INDEXING_MS);
        return;
      }
      this.clearPending();
      this.log.appendLine('zoek-rs update skipped: index is not ready; run Rebuild Search Index to refresh saved changes');
      return;
    }
    if (automatic && !this.isWindowFocused()) { return; }

    const changed = Array.from(this.pendingChanged);
    const deleted = Array.from(this.pendingDeleted);
    const renamed = this.pendingRenames.map((item) => [item.oldRelPath, item.newRelPath] as const);
    this.clearPending();

    this.updateInFlight = true;
    this.updatePromise = this.updatePromise
      .then(async () => {
        const args: string[] = [binary, 'update', workspaceRoot];
        for (const relPath of changed) {
          args.push(relPath);
        }
        for (const relPath of deleted) {
          args.push('--delete', relPath);
        }
        for (const [oldRelPath, newRelPath] of renamed) {
          args.push('--rename', oldRelPath, newRelPath);
        }
        if (args.length <= 3) { return; }
        const response = await this.invokeJson(args, this.lifecycleCts.token);
        if (response.type !== 'update' || !response.ok) {
          this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs update failed'));
          return;
        }
        this.logUpdateWarnings(response);
        this.maybeStartBaseRefresh(workspaceRoot, binary, response);
      })
      .catch((err) => {
        if (err instanceof ProcessCancelledError) { return; }
        this.log.appendLine(`zoek-rs update failed: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.updateInFlight = false;
        this.lastUpdateFinishedAt = Date.now();
      });

    await this.updatePromise;
    if (
      this.pendingChanged.size > 0 ||
      this.pendingDeleted.size > 0 ||
      this.pendingRenames.length > 0
    ) {
      this.scheduleFlush();
    }
  }

  private boundSuspendedPendingUpdates(): void {
    if (this.isWindowFocused()) { return; }
    const pendingCount = this.pendingChanged.size + this.pendingDeleted.size + this.pendingRenames.length;
    if (pendingCount <= SUSPENDED_UPDATE_PATH_LIMIT) { return; }
    this.clearPending();
    this.workspaceSyncNeeded = true;
  }

  private async syncWorkspaceIndexIfNeeded(
    workspaceRoot: string,
    binary: string,
    reason: string,
    automatic = false,
  ): Promise<void> {
    if (this.disposed || !this.shouldRunIncrementalFileUpdates()) { return; }
    if (this.getConfiguredEngine() !== 'zoekt') { return; }
    const gitState = await this.readGitState(workspaceRoot);
    const previousGitState = this.lastGitState.get(workspaceRoot);
    if (!this.workspaceSyncNeeded && (!gitState || previousGitState === gitState)) {
      if (gitState && previousGitState === undefined) {
        this.lastGitState.set(workspaceRoot, gitState);
      }
      return;
    }
    if (!await this.hasReadyIndex(workspaceRoot)) { return; }
    if (automatic && !this.isWindowFocused()) { return; }

    const previousHead = previousGitState ? this.gitHeadFromState(previousGitState) : undefined;
    const currentHead = gitState ? this.gitHeadFromState(gitState) : undefined;
    // If we have a previous head and a different current head we may be
    // able to ask git for the exact diff; otherwise (first observation of
    // the repo OR git couldn't compute the diff) fall back to a workspace
    // --sync so the index doesn't miss the change.
    const changes = previousHead && currentHead && previousHead !== currentHead
      ? await this.collectGitBranchChanges(workspaceRoot, previousHead, currentHead)
      : null;
    const branchChangeNeedsSync = !!gitState && previousGitState !== gitState && !changes;
    const started = Date.now();
    try {
      if (changes && (changes.changed.length > 0 || changes.deleted.length > 0 || changes.renamed.length > 0)) {
        await this.invokeJson(this.buildUpdateArgs(binary, workspaceRoot, changes), this.lifecycleCts.token);
      } else if (this.workspaceSyncNeeded || branchChangeNeedsSync) {
        await this.invokeJson([binary, 'update', workspaceRoot, '--sync'], this.lifecycleCts.token);
      }
      this.lastWorkspaceSyncAt.set(workspaceRoot, Date.now());
      if (gitState) {
        this.lastGitState.set(workspaceRoot, gitState);
      }
      this.workspaceSyncNeeded = false;
      this.log.appendLine(`zoek-rs workspace sync complete: reason=${reason} elapsed=${Date.now() - started}ms`);
    } catch (err) {
      if (err instanceof ProcessCancelledError) { return; }
      this.log.appendLine(`zoek-rs workspace sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private buildUpdateArgs(
    binary: string,
    workspaceRoot: string,
    changes: { changed: string[]; deleted: string[]; renamed: QueuedRename[] },
  ): string[] {
    const args = [binary, 'update', workspaceRoot];
    for (const relPath of changes.changed) {
      args.push(relPath);
    }
    for (const relPath of changes.deleted) {
      args.push('--delete', relPath);
    }
    for (const rename of changes.renamed) {
      args.push('--rename', rename.oldRelPath, rename.newRelPath);
    }
    return args;
  }

  private async readGitState(workspaceRoot: string): Promise<string | null> {
    const gitDir = await this.resolveGitDir(workspaceRoot);
    if (!gitDir) { return null; }
    try {
      const headPath = path.join(gitDir, 'HEAD');
      const head = (await fs.promises.readFile(headPath, 'utf8')).trim();
      let ref = '';
      const match = /^ref:\s+(.+)$/.exec(head);
      if (match) {
        const refPath = path.join(gitDir, match[1]);
        try {
          ref = (await fs.promises.readFile(refPath, 'utf8')).trim();
        } catch {
          ref = await this.readPackedRef(gitDir, match[1]) ?? '';
        }
      } else {
        ref = head;
      }
      return `HEAD ${head}\nREF ${ref}`;
    } catch {
      return null;
    }
  }

  private async resolveGitDir(workspaceRoot: string): Promise<string | null> {
    const gitPath = path.join(workspaceRoot, '.git');
    try {
      const stat = await fs.promises.stat(gitPath);
      if (stat.isDirectory()) { return gitPath; }
      if (!stat.isFile()) { return null; }
      const text = await fs.promises.readFile(gitPath, 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
      if (!match) { return null; }
      return path.resolve(workspaceRoot, match[1]);
    } catch {
      return null;
    }
  }

  private async readPackedRef(gitDir: string, refName: string): Promise<string | null> {
    try {
      const text = await fs.promises.readFile(path.join(gitDir, 'packed-refs'), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#') || line.startsWith('^')) { continue; }
        const [hash, ref] = line.trim().split(/\s+/, 2);
        if (ref === refName && /^[0-9a-f]{40}$/i.test(hash)) {
          return hash;
        }
      }
    } catch {}
    return null;
  }

  private gitHeadFromState(state: string): string | undefined {
    const refMatch = /^REF ([0-9a-f]{40})$/im.exec(state);
    if (refMatch) { return refMatch[1]; }
    const headMatch = /^HEAD ([0-9a-f]{40})$/im.exec(state);
    return headMatch?.[1];
  }

  private async collectGitBranchChanges(
    workspaceRoot: string,
    previousHead: string,
    currentHead: string,
  ): Promise<{ changed: string[]; deleted: string[]; renamed: QueuedRename[] } | null> {
    const result = await this.invokeText([
      'git',
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      previousHead,
      currentHead,
    ], workspaceRoot, this.lifecycleCts.token);
    if (result.cancelled || result.code !== 0) {
      return null;
    }
    return this.parseGitNameStatusZ(result.stdout);
  }

  private parseGitNameStatusZ(stdout: string): { changed: string[]; deleted: string[]; renamed: QueuedRename[] } {
    const parts = stdout.split('\0').filter((part) => part.length > 0);
    const changed: string[] = [];
    const deleted: string[] = [];
    const renamed: QueuedRename[] = [];
    for (let idx = 0; idx < parts.length;) {
      const status = parts[idx++] ?? '';
      const code = status[0] ?? '';
      if (code === 'R' || code === 'C') {
        const oldRelPath = parts[idx++];
        const newRelPath = parts[idx++];
        if (oldRelPath && newRelPath) {
          renamed.push({
            oldRelPath: this.normalizeRelativePath(oldRelPath),
            newRelPath: this.normalizeRelativePath(newRelPath),
          });
        }
        continue;
      }
      const relPath = parts[idx++];
      if (!relPath) { continue; }
      const normalized = this.normalizeRelativePath(relPath);
      if (this.isIgnoredRelativePath(normalized)) { continue; }
      if (code === 'D') {
        deleted.push(normalized);
      } else {
        changed.push(normalized);
      }
    }
    return { changed, deleted, renamed };
  }

  private clearPending(): void {
    this.pendingChanged.clear();
    this.pendingDeleted.clear();
    this.pendingRenames = [];
  }

  private maybeStartBaseRefresh(
    workspaceRoot: string,
    binary: string,
    update: ZoektUpdateResponse,
  ): void {
    if (!update.compactionSuggested || this.disposed) { return; }
    if (this.indexPromises.has(workspaceRoot) || this.foregroundIndexPromises.has(workspaceRoot)) {
      return;
    }
    const now = Date.now();
    const lastRefresh = this.lastAutoBaseRefreshAt.get(workspaceRoot) ?? 0;
    if (now - lastRefresh < AUTO_BASE_REFRESH_MIN_INTERVAL_MS) {
      this.log.appendLine(
        `zoek-rs base refresh skipped: overlay still large but a refresh was started recently (latest=${update.latestVisibleEntries})`,
      );
      return;
    }
    this.lastAutoBaseRefreshAt.set(workspaceRoot, now);
    const promise = (async () => {
      this.log.appendLine(
        `zoek-rs background base refresh start: overlay latest=${update.latestVisibleEntries} total=${update.overlayTotalEntries}`,
      );
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: refreshing search index');
      try {
        const response = await this.invokeJson([binary, 'compact', workspaceRoot], this.lifecycleCts.token, {
          onStderrLine: (line) => this.handleIndexProgressLine(
            line,
            (message, percent) => this.emitIndexProgress(workspaceRoot, message, percent),
          ),
        });
        if (response.type !== 'index' || !response.ok) {
          this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs base refresh failed'));
          return false;
        }
        this.logIndexWarnings(response);
        this.log.appendLine(
          `zoek-rs background base refresh ready: files=${response.stats.indexedFiles} shards=${response.stats.shardCount}`,
        );
        this.emitIndexProgress(workspaceRoot, 'zoek-rs: index ready', 100);
        return true;
      } catch (err) {
        if (err instanceof ProcessCancelledError) { return false; }
        this.log.appendLine(`zoek-rs base refresh failed: ${err instanceof Error ? err.message : err}`);
        return false;
      } finally {
        this.indexPromises.delete(workspaceRoot);
        this.indexProgressState.delete(workspaceRoot);
      }
    })();
    this.indexPromises.set(workspaceRoot, promise);
  }

  private async ensureIndexed(workspaceRoot: string, reason: string): Promise<boolean> {
    if (this.disposed) { return false; }
    const existing = this.indexPromises.get(workspaceRoot);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: preparing indexer runtime');
      const binary = await this.resolveBinary(true);
      if (!binary) { return false; }
      this.log.appendLine(`zoek-rs background index start (${reason})`);
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: indexing workspace');
      try {
        const response = await this.invokeJson([binary, 'index', workspaceRoot], this.lifecycleCts.token, {
          onStderrLine: (line) => this.handleIndexProgressLine(
            line,
            (message, percent) => this.emitIndexProgress(workspaceRoot, message, percent),
          ),
        });
        if (response.type !== 'index' || !response.ok) {
          this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs background index failed'));
          return false;
        }
        this.logIndexWarnings(response);
        this.log.appendLine(
          `zoek-rs background index ready: files=${response.stats.indexedFiles} shards=${response.stats.shardCount}`,
        );
        this.emitIndexProgress(workspaceRoot, 'zoek-rs: index ready', 100);
        return true;
      } catch (err) {
        if (err instanceof ProcessCancelledError) { return false; }
        this.log.appendLine(`zoek-rs background index failed: ${err instanceof Error ? err.message : err}`);
        return false;
      } finally {
        this.indexPromises.delete(workspaceRoot);
        this.indexProgressState.delete(workspaceRoot);
      }
    })();
    this.indexPromises.set(workspaceRoot, promise);
    return promise;
  }

  private scheduleBackgroundBuild(reason: string): void {
    if (this.disposed || this.backgroundBuildTimer || this.buildPromise || this.binaryPath) {
      return;
    }
    const delayMs = this.getConfiguredBackgroundBuildDelayMs();
    this.log.appendLine(`zoek-rs background build scheduled: reason=${reason} delay=${delayMs}ms`);
    this.backgroundBuildTimer = setTimeout(() => {
      this.backgroundBuildTimer = undefined;
      if (this.disposed) { return; }
      void this.resolveBinary(true).catch((err) => {
        this.log.appendLine(`zoek-rs background build failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
  }

  private scheduleBackgroundIndex(workspaceRoot: string, reason: string): void {
    if (
      this.disposed ||
      this.indexPromises.has(workspaceRoot) ||
      this.foregroundIndexPromises.has(workspaceRoot) ||
      this.backgroundIndexTimers.has(workspaceRoot)
    ) {
      return;
    }
    const delayMs = this.getConfiguredBackgroundIndexDelayMs();
    this.log.appendLine(`zoek-rs background index scheduled: reason=${reason} delay=${delayMs}ms`);
    const timer = setTimeout(() => {
      this.backgroundIndexTimers.delete(workspaceRoot);
      if (this.disposed) { return; }
      void this.ensureIndexed(workspaceRoot, reason).catch((err) => {
        this.log.appendLine(`zoek-rs background index failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
    this.backgroundIndexTimers.set(workspaceRoot, timer);
  }

  private cancelScheduledBackgroundPreparation(): void {
    if (this.backgroundBuildTimer) {
      clearTimeout(this.backgroundBuildTimer);
      this.backgroundBuildTimer = undefined;
    }
    for (const timer of this.backgroundIndexTimers.values()) {
      clearTimeout(timer);
    }
    this.backgroundIndexTimers.clear();
  }

  private async hasReadyIndex(workspaceRoot: string): Promise<boolean> {
    const indexRoot = path.join(workspaceRoot, '.zoek-rs');
    const manifestPath = path.join(indexRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return false;
    }
    try {
      const manifestText = await fs.promises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestText) as ZoektBaseShardManifest;
      return hasValidZoektBaseShards(
        indexRoot,
        manifest,
        workspaceRoot,
        this.configuredPersistentIndexScope(),
      );
    } catch {
      return false;
    }
  }

  private effectiveQueryArgs(options: SearchOptions): string[] {
    const terms = searchQueryTerms(options).map((term) => this.effectiveQueryTerm(options, term));
    if (terms.length === 0) { return ['']; }
    const [first, ...rest] = terms;
    return [first, ...rest.flatMap((term) => ['--or-query', term])];
  }

  private effectiveQueryTerm(options: SearchOptions, term: string): string {
    if (options.useRegex && options.wholeWord) {
      return `\\b${term}\\b`;
    }
    return term;
  }

  private effectiveIncludeArgs(options: SearchOptions): string[] {
    const globs = toRipgrepGlobs(options.includePatterns);
    const args: string[] = [];
    for (const glob of globs) {
      args.push('--include', glob);
    }
    return args;
  }

  private effectiveExcludeArgs(options: SearchOptions): string[] {
    const perQueryGlobs = toRipgrepGlobs(options.excludePatterns);
    // Configured workspace-wide excludes (intellijStyledSearch.excludeGlobs)
    // must reach the zoekt search step too — the index itself stays
    // unfiltered (full rebuild walks every file), so without this the user's
    // configured cache paths would still surface in zoekt search results
    // even though the codesearch fallback hides them.
    let configuredGlobs: string[] = [];
    if (!options.ignoreConfiguredExcludes) {
      const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
      configuredGlobs = toRipgrepGlobs(cfg.get<string[]>('excludeGlobs', []));
    }
    const args: string[] = [];
    for (const glob of perQueryGlobs) { args.push('--exclude', glob); }
    for (const glob of configuredGlobs) { args.push('--exclude', glob); }
    return args;
  }

  private effectivePathRegexArgs(options: SearchOptions): string[] {
    return options.pathRegex ? ['--path-regex', options.pathRegex] : [];
  }

  private paginateSearchResponse(
    response: ZoektSearchResponse,
    options: SearchOptions,
    workspaceRoot: string,
  ): PaginatedSearchResult {
    const pathScopeMatcher = compilePathScopeMatcher(options.includePatterns, options.excludePatterns);
    const pathRegexMatcher = compileSearchPathRegex(options.pathRegex);
    const files = response.files
      .map((file): FileMatch => this.toFileMatch(file, workspaceRoot))
      .filter((file) => (!pathScopeMatcher || pathScopeMatcher(file.relPath)) && (!pathRegexMatcher || pathRegexMatcher(file.relPath)));

    const pageMatchCount = files.reduce((sum, file) => sum + file.matches.length, 0);

    return {
      matches: files,
      totalFiles: response.totalFilesMatched,
      availableMatches: response.totalMatches,
      totalMatches: pageMatchCount,
      truncated: response.truncated,
      warnings: response.warnings,
    };
  }

  private toFileMatch(file: ZoektSearchFileResult, workspaceRoot: string): FileMatch {
    return {
      uri: vscode.Uri.file(path.join(workspaceRoot, file.relPath)).toString(),
      relPath: file.relPath,
      matches: file.matches.map((match) => ({
        line: match.line,
        preview: match.preview,
        ranges: [this.toRange(match)],
      })),
    };
  }

  private toRange(match: ZoektSearchResponse['files'][number]['matches'][number]): MatchRange {
    return {
      start: match.startColumn,
      end: match.endColumn,
      ...(typeof match.endLine === 'number'
        ? { endLine: match.endLine, endCol: match.endColumn }
        : {}),
    };
  }

  private logIndexWarnings(response: ZoektIndexResponse): void {
    for (const warning of response.warnings) {
      this.log.appendLine(`zoek-rs warning: ${warning}`);
    }
  }

  private logUpdateWarnings(response: ZoektUpdateResponse): void {
    const now = Date.now();
    const minIntervalMs = this.getConfiguredUpdateLogMinIntervalMs();
    if (response.warnings.length === 0 && minIntervalMs > 0 && now - this.lastUpdateLogAt < minIntervalMs) {
      this.suppressedUpdateLogCount += 1;
      return;
    }
    const parts = [
      `zoek-rs update: generation=${response.generation}`,
      `entries=${response.entriesWritten}`,
      `live=${response.liveEntries}`,
      `tombstones=${response.tombstones}`,
      `overlay=${response.overlayTotalEntries}`,
      `latest=${response.latestVisibleEntries}`,
      `journal=${response.journalBytes}`,
    ];
    if (this.suppressedUpdateLogCount > 0) {
      parts.push(`suppressedLogs=${this.suppressedUpdateLogCount}`);
      this.suppressedUpdateLogCount = 0;
    }
    this.lastUpdateLogAt = now;
    this.log.appendLine(parts.join(' '));
    for (const warning of response.warnings) {
      this.log.appendLine(`zoek-rs warning: ${warning}`);
    }
  }

  private describeEngineFailure(response: ZoektEngineResponse, fallback: string): string {
    if (response.type === 'error') {
      return response.message || fallback;
    }
    return fallback;
  }

  private getBinaryCandidates(): string[] {
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    return this.getBinaryCandidatesFor('engine', exeSuffix);
  }

  private getBinaryCandidatesFor(target: BinaryTarget, exeSuffix = process.platform === 'win32' ? '.exe' : ''): string[] {
    const baseName = target === 'rebuild' ? 'ijss-rebuild' : 'zoek-rs';
    const candidates: string[] = [];
    for (const globalCacheDir of this.getCompleteGlobalBinaryCacheDirs(exeSuffix)) {
      candidates.push(path.join(globalCacheDir, `${baseName}${exeSuffix}`));
    }
    if (this.isPackagedBinaryPairValid()) {
      candidates.push(path.join(this.getPackagedBinaryDir(), `${baseName}${exeSuffix}`));
    }
    candidates.push(
      path.join(this.extensionRoot, 'target', 'release', `${baseName}${exeSuffix}`),
      path.join(this.extensionRoot, 'target', 'debug', `${baseName}${exeSuffix}`),
    );
    return candidates;
  }

  private getBinaryPlatformKey(): string {
    return `${process.platform}-${process.arch}`;
  }

  private getGlobalBinaryCacheDir(): string {
    return path.join(
      this.context.globalStorageUri.fsPath,
      'zoek-rs',
      'runtime',
      this.getBinaryPlatformKey(),
      this.getRustSourceFingerprint(),
    );
  }

  private getPackagedBinaryDir(): string {
    return path.join(
      this.extensionRoot,
      'resources',
      'bin',
      this.getBinaryPlatformKey(),
    );
  }

  private isPackagedBinaryPairValid(): boolean {
    if (this.packagedBinaryPairValid !== undefined) { return this.packagedBinaryPairValid; }
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    try {
      const packagedDir = this.getPackagedBinaryDir();
      const manifest = JSON.parse(fs.readFileSync(path.join(packagedDir, 'manifest.json'), 'utf8')) as {
        formatVersion?: unknown;
        platformKey?: unknown;
        protocolVersion?: unknown;
        schemaVersion?: unknown;
        sourceFingerprint?: unknown;
        artifactId?: unknown;
        files?: Record<string, unknown>;
      };
      if (manifest.formatVersion !== 2 ||
          manifest.platformKey !== this.getBinaryPlatformKey() ||
          manifest.protocolVersion !== ZOEKT_PROTOCOL_VERSION ||
          manifest.schemaVersion !== ZOEKT_SCHEMA_VERSION ||
          manifest.sourceFingerprint !== this.getRustSourceFingerprint()) {
        this.packagedBinaryPairValid = false;
        return false;
      }
      const files: Record<string, string> = {};
      for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
        const expected = manifest.files?.[baseName];
        if (typeof expected !== 'string') {
          this.packagedBinaryPairValid = false;
          return false;
        }
        const binaryPath = path.join(packagedDir, `${baseName}${exeSuffix}`);
        const actual = createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
        if (actual !== expected) {
          this.packagedBinaryPairValid = false;
          return false;
        }
        files[baseName] = actual;
      }
      if (manifest.artifactId !== this.binaryPairArtifactId(files)) {
        this.packagedBinaryPairValid = false;
        return false;
      }
      this.packagedBinaryPairValid = true;
      return true;
    } catch {
      this.packagedBinaryPairValid = false;
      return false;
    }
  }

  private getSharedCargoTargetDir(): string {
    // Cargo already fingerprints source inputs and serializes writers inside a
    // target directory. Keeping our source hash in this path forced a cold
    // dependency rebuild after every Rust edit; only the published binary cache
    // needs source-fingerprinted isolation.
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) {
      // Share the checkout's normal Cargo cache in development/test modes;
      // those workflows have usually compiled the same crate already.
      return path.join(this.extensionRoot, 'target');
    }
    return path.join(
      this.context.globalStorageUri.fsPath,
      'zoek-rs',
      'cargo-target',
      this.getBinaryPlatformKey(),
    );
  }

  private getRustSourceFingerprint(): string {
    if (this.rustSourceFingerprint) { return this.rustSourceFingerprint; }
    const hash = createHash('sha256');
    const inputs: string[] = [];
    const addFile = (filePath: string) => {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { return; }
      inputs.push(filePath);
    };
    const walk = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) { return; }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) { walk(entryPath); }
        else if (entry.isFile() && (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml')) {
          addFile(entryPath);
        }
      }
    };
    addFile(path.join(this.extensionRoot, 'Cargo.lock'));
    addFile(path.join(this.extensionRoot, 'Cargo.toml'));
    walk(path.join(this.extensionRoot, 'crates', 'zoek-rs'));
    inputs.sort();
    if (inputs.length === 0) {
      hash.update(String(this.context.extension?.packageJSON?.version ?? 'unknown'));
    } else {
      for (const input of inputs) {
        hash.update(path.relative(this.extensionRoot, input).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(input));
        hash.update('\0');
      }
    }
    this.rustSourceFingerprint = hash.digest('hex').slice(0, 24);
    return this.rustSourceFingerprint;
  }

  private getCompleteGlobalBinaryCacheDirs(exeSuffix: string): string[] {
    const rootDir = this.getGlobalBinaryCacheDir();
    try {
      return fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
        .map((entry) => path.join(rootDir, entry.name))
        .filter((dirPath) => this.isCompleteGlobalBinaryCache(dirPath, exeSuffix))
        .sort();
    } catch {
      return [];
    }
  }

  private binaryPairArtifactId(files: Record<string, string>): string {
    const hash = createHash('sha256');
    for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
      hash.update(baseName);
      hash.update('\0');
      hash.update(files[baseName] ?? '');
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private isCompleteGlobalBinaryCache(dirPath: string, exeSuffix: string): boolean {
    try {
      const manifestPath = path.join(dirPath, 'install.json');
      const manifestText = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestText) as BinaryPairManifest;
      const binaryPaths = ['zoek-rs', 'ijss-rebuild'].map((baseName) =>
        path.join(dirPath, `${baseName}${exeSuffix}`),
      );
      const stats = binaryPaths.map((binaryPath) => fs.statSync(binaryPath));
      if (stats.some((stat) => !stat.isFile())) { return false; }
      if (process.platform !== 'win32') {
        for (const binaryPath of binaryPaths) {
          fs.accessSync(binaryPath, fs.constants.X_OK);
        }
      }
      const signature = [
        manifestText,
        ...stats.map((stat) => `${stat.size}:${stat.mtimeMs}:${stat.mode}`),
      ].join('\0');
      const cached = this.globalBinaryPairValidity.get(dirPath);
      if (cached?.signature === signature) { return cached.valid; }
      const files: Record<string, string> = {};
      for (let index = 0; index < binaryPaths.length; index += 1) {
        files[index === 0 ? 'zoek-rs' : 'ijss-rebuild'] = createHash('sha256')
          .update(fs.readFileSync(binaryPaths[index]))
          .digest('hex');
      }
      const artifactId = this.binaryPairArtifactId(files);
      const valid = manifest.formatVersion === 2 &&
        manifest.sourceFingerprint === this.getRustSourceFingerprint() &&
        manifest.platform === this.getBinaryPlatformKey() &&
        manifest.artifactId === artifactId &&
        manifest.files?.['zoek-rs'] === files['zoek-rs'] &&
        manifest.files?.['ijss-rebuild'] === files['ijss-rebuild'];
      this.globalBinaryPairValidity.set(dirPath, { signature, valid });
      return valid;
    } catch {
      return false;
    }
  }

  private async materializePackagedBinaryPair(): Promise<void> {
    if (!this.isPackagedBinaryPairValid()) { return; }
    await this.installBinaryPairFromDir(this.getPackagedBinaryDir());
  }

  private async installBuiltBinaryPair(cargoTargetDir: string, cargoStdout = ''): Promise<void> {
    const artifacts = this.parseCargoBinaryArtifacts(cargoStdout);
    if (artifacts['zoek-rs'] && artifacts['ijss-rebuild']) {
      await this.installBinaryPairFromPaths(artifacts);
      return;
    }
    await this.installBinaryPairFromDir(path.join(cargoTargetDir, 'release'));
  }

  private parseCargoBinaryArtifacts(stdout: string): Record<string, string> {
    const artifacts: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) { continue; }
      try {
        const message = JSON.parse(line) as {
          reason?: unknown;
          executable?: unknown;
          target?: { name?: unknown; kind?: unknown };
        };
        const name = message.target?.name;
        if (message.reason !== 'compiler-artifact' ||
            typeof message.executable !== 'string' ||
            (name !== 'zoek-rs' && name !== 'ijss-rebuild') ||
            !Array.isArray(message.target?.kind) ||
            !message.target.kind.includes('bin')) {
          continue;
        }
        artifacts[name] = message.executable;
      } catch {}
    }
    return artifacts;
  }

  private async installBinaryPairFromDir(sourceDir: string): Promise<void> {
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    await this.installBinaryPairFromPaths({
      'zoek-rs': path.join(sourceDir, `zoek-rs${exeSuffix}`),
      'ijss-rebuild': path.join(sourceDir, `ijss-rebuild${exeSuffix}`),
    });
  }

  private async installBinaryPairFromPaths(sourcePaths: Record<string, string>): Promise<void> {
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const files: Record<string, string> = {};
    for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
      const source = sourcePaths[baseName];
      if (!source) { throw new Error(`missing Cargo artifact path for ${baseName}`); }
      files[baseName] = createHash('sha256').update(await fs.promises.readFile(source)).digest('hex');
    }
    const artifactId = this.binaryPairArtifactId(files);
    const cacheRoot = this.getGlobalBinaryCacheDir();
    const finalDir = path.join(cacheRoot, artifactId);
    if (this.getCompleteGlobalBinaryCacheDirs(exeSuffix).some((dirPath) => {
      const name = path.basename(dirPath);
      return name === artifactId || name.startsWith(`${artifactId}-repair-`);
    })) { return; }
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    const stageDir = await fs.promises.mkdtemp(path.join(cacheRoot, '.tmp-'));
    try {
      for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
        const source = sourcePaths[baseName];
        const destination = path.join(stageDir, `${baseName}${exeSuffix}`);
        await fs.promises.copyFile(source, destination);
        if (process.platform !== 'win32') {
          await fs.promises.chmod(destination, 0o755);
        }
      }
      await fs.promises.writeFile(
        path.join(stageDir, 'install.json'),
        `${JSON.stringify({
          formatVersion: 2,
          sourceFingerprint: this.getRustSourceFingerprint(),
          platform: this.getBinaryPlatformKey(),
          artifactId,
          files,
        })}\n`,
        'utf8',
      );
      if (!this.isCompleteGlobalBinaryCache(stageDir, exeSuffix)) {
        throw new Error('zoek-rs binary pair changed while it was being installed');
      }
      try {
        await fs.promises.rename(stageDir, finalDir);
      } catch (err) {
        if (this.isCompleteGlobalBinaryCache(finalDir, exeSuffix)) { return; }
        // A corrupt directory must never be removed in place: another
        // extension host may be resolving it concurrently. Publish the valid
        // repair as another immutable artifact instead.
        const repairDir = path.join(
          cacheRoot,
          `${artifactId}-repair-${path.basename(stageDir).slice('.tmp-'.length)}`,
        );
        await fs.promises.rename(stageDir, repairDir);
      }
    } finally {
      this.globalBinaryPairValidity.delete(stageDir);
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private isUnstampedCheckoutBuildCandidate(candidate: string): boolean {
    const relative = path.relative(path.join(this.extensionRoot, 'target'), candidate);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /** Public entry point used by the "Install zoek-rs binaries" command and
   *  by tests. Reports progress through the optional callback and returns
   *  a structured result so the UI can show a clear "missing Rust" message
   *  instead of a generic stack trace when cargo isn't on PATH. */
  async resolveEngineBinaryForGraph(allowBuild: boolean): Promise<string | undefined> {
    return (await this.resolveBinary(allowBuild, 'engine')) ?? undefined;
  }

  async installBinary(report?: (message: string) => void): Promise<{
    ok: boolean;
    alreadyInstalled?: boolean;
    engineBinary?: string;
    rebuildBinary?: string;
    requiresCargoToolchain?: boolean;
    message?: string;
  }> {
    const cached = {
      engine: await this.resolveBinary(false, 'engine'),
      rebuild: await this.resolveBinary(false, 'rebuild'),
    };
    if (cached.engine && cached.rebuild) {
      return {
        ok: true,
        alreadyInstalled: true,
        engineBinary: cached.engine,
        rebuildBinary: cached.rebuild,
      };
    }
    report?.('building zoek-rs binaries with Cargo');
    let engineBinary: string | null;
    let rebuildBinary: string | null;
    try {
      engineBinary = await this.resolveBinary(true, 'engine');
      rebuildBinary = await this.resolveBinary(true, 'rebuild');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || /spawn cargo ENOENT/.test(message)) {
        return {
          ok: false,
          requiresCargoToolchain: true,
          message:
            'Rust/Cargo toolchain is not installed or not on PATH. Install it from https://rustup.rs/ and retry.',
        };
      }
      return { ok: false, message };
    }
    if (!engineBinary || !rebuildBinary) {
      // Build "succeeded" but the candidates still don't resolve — usually
      // cargo missing from PATH so resolveBinary returned null silently.
      return {
        ok: false,
        requiresCargoToolchain: true,
        message:
          'Rust/Cargo toolchain is not installed or not on PATH. Install it from https://rustup.rs/ and retry.',
      };
    }
    report?.('zoek-rs binaries ready');
    return {
      ok: true,
      alreadyInstalled: false,
      engineBinary,
      rebuildBinary,
    };
  }

  private async resolveBinary(allowBuild: boolean, target: BinaryTarget = 'engine'): Promise<string | null> {
    if (this.disposed) { return null; }
    if (allowBuild && !this.buildPromise) {
      const previousFingerprint = this.rustSourceFingerprint;
      this.rustSourceFingerprint = undefined;
      this.packagedBinaryPairValid = undefined;
      const currentFingerprint = this.getRustSourceFingerprint();
      if (previousFingerprint && previousFingerprint !== currentFingerprint) {
        this.log.appendLine(
          `zoek-rs Rust source changed: ${previousFingerprint} -> ${currentFingerprint}`,
        );
      }
      // Re-resolve source-stamped candidates after refreshing the fingerprint.
      this.binaryPath = undefined;
      this.rebuildBinaryPath = undefined;
    }
    const cached = target === 'rebuild' ? this.rebuildBinaryPath : this.binaryPath;
    if (cached && fs.existsSync(cached) && !(allowBuild && this.isUnstampedCheckoutBuildCandidate(cached))) {
      if (await this.isBinaryCompatible(cached, target)) {
        return cached;
      }
      this.log.appendLine(`zoek-rs binary skipped: incompatible or stale runtime at ${cached}`);
      this.clearResolvedBinary(target, cached);
    }
    try {
      await this.materializePackagedBinaryPair();
    } catch (err) {
      this.log.appendLine(
        `zoek-rs packaged binary cache skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
    const candidates = target === 'engine' ? this.getBinaryCandidates() : this.getBinaryCandidatesFor(target);
    for (const candidate of candidates) {
      if (allowBuild && this.isUnstampedCheckoutBuildCandidate(candidate)) {
        continue;
      }
      if (fs.existsSync(candidate) && await this.isBinaryCompatible(candidate, target)) {
        this.cacheResolvedBinary(target, candidate);
        return candidate;
      }
    }
    if (!allowBuild) {
      return null;
    }
    if (this.buildPromise) {
      await this.buildPromise;
      // The completed build installs a source-fingerprinted global cache that
      // did not exist when this waiter captured `candidates` above.
      const builtCandidates = target === 'engine'
        ? this.getBinaryCandidates()
        : this.getBinaryCandidatesFor(target);
      for (const candidate of builtCandidates) {
        if (this.isUnstampedCheckoutBuildCandidate(candidate)) { continue; }
        if (fs.existsSync(candidate) && await this.isBinaryCompatible(candidate, target, true)) {
          this.cacheResolvedBinary(target, candidate);
          return candidate;
        }
      }
      return null;
    }
    const cargoToml = path.join(this.extensionRoot, 'Cargo.toml');
    if (!fs.existsSync(cargoToml)) {
      return null;
    }
    const buildPromise = (async () => {
      const buildSourceFingerprint = this.getRustSourceFingerprint();
      const cargoTargetDir = this.getSharedCargoTargetDir();
      const developmentRuntimeBuild = this.context.extensionMode !== vscode.ExtensionMode.Production;
      const cargoProfileArgs = developmentRuntimeBuild
        ? ['--profile', 'runtime']
        : ['--release'];
      this.log.appendLine(
        `zoek-rs build: cargo build -q ${cargoProfileArgs.join(' ')} -p zoek-rs --bins target=${cargoTargetDir}`,
      );
      try {
        await fs.promises.mkdir(cargoTargetDir, { recursive: true });
        const result = await this.invokeText(
          [
            'cargo',
            'build',
            '-q',
            ...cargoProfileArgs,
            '-p',
            'zoek-rs',
            '--bins',
            '--message-format=json-render-diagnostics',
          ],
          this.extensionRoot,
          this.lifecycleCts.token,
          {
            env: {
              ...process.env,
              CARGO_TARGET_DIR: cargoTargetDir,
              ...(developmentRuntimeBuild
                ? { CARGO_INCREMENTAL: '1' }
                : {}),
            },
          },
        );
        if (result.cancelled) {
          throw new ProcessCancelledError('cargo build cancelled');
        }
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() ||
            result.stdout.trim() ||
            (result.signal ? `cargo build terminated by ${result.signal}` : `cargo build exited with code ${result.code}`),
          );
        }
        this.rustSourceFingerprint = undefined;
        this.packagedBinaryPairValid = undefined;
        const currentSourceFingerprint = this.getRustSourceFingerprint();
        if (currentSourceFingerprint !== buildSourceFingerprint) {
          throw new Error(
            `Rust sources changed while Cargo was building (${buildSourceFingerprint} -> ${currentSourceFingerprint})`,
          );
        }
        await this.installBuiltBinaryPair(cargoTargetDir, result.stdout);
      } catch (err) {
        if (err instanceof ProcessCancelledError) {
          this.log.appendLine('zoek-rs build cancelled.');
          return;
        }
        this.log.appendLine(`zoek-rs build failed: ${err instanceof Error ? err.message : err}`);
        return;
      }
    })();
    this.buildPromise = buildPromise;
    try {
      await buildPromise;
    } finally {
      if (this.buildPromise === buildPromise) {
        this.buildPromise = undefined;
      }
    }
    const builtCandidates = target === 'engine' ? this.getBinaryCandidates() : this.getBinaryCandidatesFor(target);
    for (const candidate of builtCandidates) {
      if (this.isUnstampedCheckoutBuildCandidate(candidate)) { continue; }
      if (fs.existsSync(candidate) && await this.isBinaryCompatible(candidate, target, true)) {
        this.cacheResolvedBinary(target, candidate);
        return candidate;
      }
    }
    return null;
  }

  private async isBinaryCompatible(candidate: string, target: BinaryTarget, forceProbe = false): Promise<boolean> {
    if (!forceProbe && this.binaryCompatibility.has(candidate)) {
      return this.binaryCompatibility.get(candidate) === true;
    }
    const compatible = target === 'rebuild'
      ? await this.probeBinaryCapabilities(
        candidate,
        ['--capabilities'],
        ['index'],
        ['force-index-rebuild'],
      )
      : await this.probeBinaryCapabilities(
        candidate,
        ['capabilities'],
        [
          'index',
          'compact',
          'update',
          'search',
          'info',
          'diagnose',
          'benchmark',
          'graph-rebuild',
          'graph-index',
          'graph-update',
          'graph-overlay-update',
          'graph-compact',
          'graph-query',
          'graph-callees',
          'graph-symbol-query',
          'graph-implementations',
        ],
        [
          'force-index-rebuild',
          'search-exclude-globs',
          'streaming-search',
          'rust-native-call-graph',
        ],
      );
    this.binaryCompatibility.set(candidate, compatible);
    return compatible;
  }

  private async probeBinaryCapabilities(
    candidate: string,
    args: string[],
    requiredCommands: string[],
    requiredFeatures: string[],
  ): Promise<boolean> {
    try {
      const result = await this.invokeText(
        [candidate, ...args],
        this.extensionRoot,
        this.lifecycleCts.token,
      );
      if (result.code !== 0 || result.cancelled) { return false; }
      const parsed = JSON.parse(result.stdout.trim() || '{}') as {
        type?: unknown;
        ok?: unknown;
        engine?: { name?: unknown; protocolVersion?: unknown; schemaVersion?: unknown };
        commands?: unknown;
        features?: unknown;
      };
      if (parsed.type !== 'capabilities' || parsed.ok !== true ||
          parsed.engine?.name !== 'zoek-rs' ||
          parsed.engine.protocolVersion !== ZOEKT_PROTOCOL_VERSION ||
          parsed.engine.schemaVersion !== ZOEKT_SCHEMA_VERSION ||
          !Array.isArray(parsed.commands) || !Array.isArray(parsed.features)) {
        return false;
      }
      const commands = new Set(parsed.commands.filter((value): value is string => typeof value === 'string'));
      const features = new Set(parsed.features.filter((value): value is string => typeof value === 'string'));
      return requiredCommands.every((command) => commands.has(command)) &&
        requiredFeatures.every((feature) => features.has(feature));
    } catch (err) {
      this.log.appendLine(
        `zoek-rs capabilities probe failed for ${candidate}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  private async invokeJson(
    args: string[],
    token?: vscode.CancellationToken,
    hooks?: InvokeTextHooks,
  ): Promise<ZoektEngineResponse> {
    const [command, ...rest] = args;
    const { stdout, stderr, code, signal, cancelled } = await this.invokeText(
      [command, ...rest],
      this.extensionRoot,
      token,
      hooks,
    );
    if (cancelled) {
      throw new ProcessCancelledError(`${command} cancelled`);
    }
    if (code !== 0) {
      throw new Error(
        stderr.trim() ||
        stdout.trim() ||
        (signal ? `${command} terminated by ${signal}` : `${command} exited with code ${code}`),
      );
    }
    const payload = stdout.trim();
    if (!payload) {
      throw new Error(`${command} produced no JSON response`);
    }
    try {
      return JSON.parse(payload) as ZoektEngineResponse;
    } catch (err) {
      throw new Error(`failed to parse zoek-rs response: ${err instanceof Error ? err.message : err}`);
    }
  }

  private invokeText(
    args: string[],
    cwd: string,
    token?: vscode.CancellationToken,
    hooks?: InvokeTextHooks,
  ): Promise<InvokeTextResult> {
    if (this.disposed) {
      return Promise.reject(new ProcessCancelledError('zoek-rs runtime disposed'));
    }
    const [command, ...rest] = args;
    const kind = this.classifyChild(command, rest);
    const argv0 = this.argv0ForKind(kind);
    const childEnv: NodeJS.ProcessEnv = {
      ...(hooks?.env ?? process.env),
      [ZOEKT_INCLUDE_IGNORED_ENV]: this.shouldIncludeIgnoredFiles() ? '1' : '0',
    };
    const ripgrepPath = findRipgrepPath();
    if (ripgrepPath) {
      childEnv[ZOEKT_RG_PATH_ENV] = ripgrepPath;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: childEnv,
        ...(argv0 ? { argv0 } : {}),
      });
      const tracked = this.trackChild(child, [path.basename(command), ...rest.slice(0, 2)].join(' '), kind);
      let stdout = '';
      let stderr = '';
      let stderrLineBuf = '';
      let finished = false;
      const cleanup = () => {
        if (finished) { return; }
        finished = true;
        tokenSub.dispose();
        disposeSub.dispose();
        if (tracked.killTimer) {
          clearTimeout(tracked.killTimer);
          tracked.killTimer = undefined;
        }
        this.activeChildren.delete(tracked.id);
      };
      const cancel = (reason: string) => {
        this.terminateTrackedChild(tracked, reason);
      };
      const tokenSub = token?.onCancellationRequested(() => {
        cancel('request cancelled');
      }) ?? { dispose() {} };
      const disposeSub = this.lifecycleCts.token.onCancellationRequested(() => {
        cancel('runtime disposed');
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderrLineBuf += chunk;
        while (true) {
          const newline = stderrLineBuf.indexOf('\n');
          if (newline < 0) { break; }
          const line = stderrLineBuf.slice(0, newline).replace(/\r$/, '');
          stderrLineBuf = stderrLineBuf.slice(newline + 1);
          const consumed = hooks?.onStderrLine?.(line) === true;
          if (!consumed) {
            stderr += `${line}\n`;
          }
        }
      });
      child.on('error', (err) => {
        cleanup();
        reject(err);
      });
      child.on('close', (code, signal) => {
        cleanup();
        if (stderrLineBuf.length > 0) {
          const line = stderrLineBuf.replace(/\r$/, '');
          const consumed = hooks?.onStderrLine?.(line) === true;
          if (!consumed) {
            stderr += line;
          }
        }
        resolve({
          stdout,
          stderr,
          code: code ?? -1,
          signal: signal ?? null,
          cancelled: tracked.cancelled,
        });
      });
    });
  }

  private trackChild(child: ChildProcess, label: string, kind: ProcessKind): TrackedChild {
    const tracked: TrackedChild = {
      id: this.nextChildId++,
      child,
      label,
      kind,
      cancelled: false,
      killTimer: undefined,
    };
    this.activeChildren.set(tracked.id, tracked);
    return tracked;
  }

  private classifyChild(command: string, rest: string[]): ProcessKind {
    const base = path.basename(command);
    if (base === 'cargo' && rest[0] === 'build' && rest.includes('zoek-rs')) {
      return 'build';
    }
    if (base === 'ijss-rebuild') {
      return 'rebuild';
    }
    if (!base.startsWith('zoek-rs')) {
      return 'other';
    }
    switch (rest[0]) {
      case 'search': return 'search';
      case 'index': return 'index';
      case 'compact': return 'index';
      case 'update': return 'update';
      case 'info': return 'info';
      case 'diagnose': return 'diagnose';
      case 'benchmark': return 'benchmark';
      default: return 'other';
    }
  }

  private argv0ForKind(kind: ProcessKind): string | undefined {
    switch (kind) {
      case 'search': return 'zoek-rs-search';
      case 'index': return 'zoek-rs-index';
      case 'rebuild': return 'ijss-rebuild';
      case 'update': return 'zoek-rs-update';
      case 'info': return 'zoek-rs-info';
      case 'diagnose': return 'zoek-rs-diagnose';
      case 'benchmark': return 'zoek-rs-benchmark';
      default: return undefined;
    }
  }

  private sweepPatternsForKinds(kinds: ReadonlySet<ProcessKind> | null): string[] {
    if (!kinds || kinds.size === 0) {
      return ['zoek-rs'];
    }
    const patterns = new Set<string>();
    for (const kind of kinds) {
      const argv0 = this.argv0ForKind(kind);
      if (argv0) {
        patterns.add(argv0);
      }
    }
    return Array.from(patterns);
  }

  private handleIndexProgressLine(
    line: string,
    report?: (message: string, percent?: number) => void,
  ): boolean {
    const parsed = this.parseIndexProgressLine(line);
    if (!parsed) {
      return false;
    }
    report?.(parsed.detail, parsed.percent);
    return true;
  }

  private attachIndexProgressListener(
    workspaceRoot: string,
    report?: IndexProgressListener,
  ): () => void {
    if (!report) {
      return () => {};
    }
    let listeners = this.indexProgressListeners.get(workspaceRoot);
    if (!listeners) {
      listeners = new Set();
      this.indexProgressListeners.set(workspaceRoot, listeners);
    }
    listeners.add(report);
    const current = this.indexProgressState.get(workspaceRoot);
    if (current) {
      report(current.message, current.percent);
    }
    return () => {
      const existing = this.indexProgressListeners.get(workspaceRoot);
      if (!existing) { return; }
      existing.delete(report);
      if (existing.size === 0) {
        this.indexProgressListeners.delete(workspaceRoot);
      }
    };
  }

  private emitIndexProgress(workspaceRoot: string, message: string, percent?: number): void {
    this.indexProgressState.set(workspaceRoot, { message, percent });
    const listeners = this.indexProgressListeners.get(workspaceRoot);
    if (!listeners) { return; }
    for (const listener of listeners) {
      listener(message, percent);
    }
  }

  private parseIndexProgressLine(
    line: string,
  ): { phase: string; current: number; total: number; percent: number; detail: string } | null {
    if (!line.startsWith(ZOEKT_PROGRESS_PREFIX)) {
      return null;
    }
    try {
      const payload = JSON.parse(line.slice(ZOEKT_PROGRESS_PREFIX.length)) as {
        phase?: unknown;
        current?: unknown;
        total?: unknown;
        percent?: unknown;
        detail?: unknown;
      };
      if (
        typeof payload.phase !== 'string' ||
        typeof payload.current !== 'number' ||
        typeof payload.total !== 'number' ||
        typeof payload.percent !== 'number' ||
        typeof payload.detail !== 'string'
      ) {
        return null;
      }
      return {
        phase: payload.phase,
        current: payload.current,
        total: payload.total,
        percent: Math.max(0, Math.min(100, Math.round(payload.percent))),
        detail: payload.detail,
      };
    } catch {
      return null;
    }
  }

  private cacheResolvedBinary(target: BinaryTarget, candidate: string): void {
    if (target === 'rebuild') {
      this.rebuildBinaryPath = candidate;
      return;
    }
    this.binaryPath = candidate;
  }

  private clearResolvedBinary(target: BinaryTarget, candidate: string): void {
    if (target === 'rebuild') {
      if (this.rebuildBinaryPath === candidate) { this.rebuildBinaryPath = undefined; }
      return;
    }
    if (this.binaryPath === candidate) { this.binaryPath = undefined; }
  }

  private terminateTrackedChild(tracked: TrackedChild, reason: string): void {
    const { child } = tracked;
    if (tracked.cancelled) { return; }
    tracked.cancelled = true;
    const pid = child.pid;
    this.log.appendLine(
      `zoek-rs process cancel: ${tracked.label}${typeof pid === 'number' ? ` pid=${pid}` : ''} (${reason})`,
    );
    try {
      if (process.platform === 'win32') {
        child.kill();
      } else if (typeof pid === 'number' && pid > 0) {
        process.kill(-pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
    tracked.killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          child.kill('SIGKILL');
        } else if (typeof pid === 'number' && pid > 0) {
          process.kill(-pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
    }, PROCESS_KILL_TIMEOUT_MS);
  }

  private async sweepExternalZoektProcesses(reason: string, patterns: string[]): Promise<void> {
    if (process.platform === 'win32') { return; }
    if (this.externalSweepPromise) { return this.externalSweepPromise; }
    const workspaceRoot = this.getWorkspaceRootPath();
    // Without a known workspace root we can't tell our zoekt processes from
    // a sibling workspace's. Refuse to sweep — better to leak stragglers
    // than to torpedo the developer's other VS Code window.
    if (!workspaceRoot) {
      this.log.appendLine(`zoek-rs sweep skipped: no workspace root (${reason})`);
      return;
    }
    const promise = (async () => {
      const lines = await this.listZoektProcesses(patterns);
      if (lines.length === 0) { return; }
      const trackedPids = new Set<number>();
      for (const tracked of this.activeChildren.values()) {
        if (typeof tracked.child.pid === 'number') {
          trackedPids.add(tracked.child.pid);
        }
      }
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) { continue; }
        const pid = parseInt(match[1], 10);
        const command = match[2] ?? '';
        if (!Number.isFinite(pid) || pid <= 0) { continue; }
        if (pid === process.pid) { continue; }
        if (trackedPids.has(pid)) { continue; }
        if (/\bpgrep\b/.test(command)) { continue; }
        // Scope the sweep to processes targeting THIS workspace root. The
        // developer's main VS Code instance may be running its own zoekt for
        // a sibling workspace; killing those by pattern alone would torpedo
        // an unrelated extension host.
        if (!this.commandTargetsWorkspaceRoot(command, workspaceRoot)) {
          continue;
        }
        this.log.appendLine(`zoek-rs sweep kill: pid=${pid} (${reason}) cmd=${command}`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          continue;
        }
        setTimeout(() => {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }, PROCESS_KILL_TIMEOUT_MS);
      }
    })().finally(() => {
      this.externalSweepPromise = undefined;
    });
    this.externalSweepPromise = promise;
    return promise;
  }

  /**
   * Returns true iff `commandLine` contains `workspaceRoot` as a standalone
   * positional argument (not as part of a longer path, a flag value like
   * `--workspace=`, or a nested subdirectory). Used by sweep to avoid
   * killing zoekt processes that belong to a different workspace.
   */
  commandTargetsWorkspaceRoot(commandLine: string, workspaceRoot: string): boolean {
    if (!commandLine || !workspaceRoot) { return false; }
    const tokens = this.tokenizeCommandLine(commandLine);
    return tokens.includes(workspaceRoot);
  }

  private tokenizeCommandLine(line: string): string[] {
    const tokens: string[] = [];
    const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
      tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return tokens;
  }

  private async listZoektProcesses(patterns: string[]): Promise<string[]> {
    if (patterns.length === 0) {
      return [];
    }
    const results = await Promise.all(patterns.map(async (pattern) => new Promise<string[]>((resolve) => {
      const child = spawn('pgrep', ['-fl', pattern], {
        cwd: this.extensionRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', () => resolve([]));
      child.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
      });
    })));
    return Array.from(new Set(results.flat()));
  }
}
