import * as fs from 'fs';
import * as path from 'path';
import { type ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import {
  compilePathScopeMatcher,
  toRipgrepGlobs,
} from './pathScope';
import {
  type FileMatch,
  type MatchRange,
  type SearchOptions,
  type SearchProgress,
  splitFileMatchChunks,
  getRequestedResultLimit,
  getRequestedResultOffset,
} from './search';
import type {
  ZoektDiagnoseResponse,
  ZoektEngineResponse,
  ZoektInfoResponse,
  ZoektIndexResponse,
  ZoektSearchResponse,
  ZoektUpdateResponse,
} from './zoekProtocol';

type SearchReadiness = {
  ready: boolean;
  reason?: string;
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

const UPDATE_DEBOUNCE_MS = 250;
const PROCESS_KILL_TIMEOUT_MS = 1_500;
const ZOEKT_PROGRESS_PREFIX = '__ZOEK_PROGRESS__';
const ZOEKT_SCHEMA_VERSION = 2;
const ZOEKT_INTERNAL_DIR_NAMES = new Set(['.zoek-rs', '.zoekt-rs']);

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

export class ZoektRuntime implements vscode.Disposable {
  private readonly extensionRoot: string;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifecycleCts = new vscode.CancellationTokenSource();
  private binaryPath: string | undefined;
  private rebuildBinaryPath: string | undefined;
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
  private nextChildId = 1;
  private disposed = false;
  private externalSweepPromise: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.extensionRoot = context.extensionUri.fsPath;
    const workspaceFolder = this.getWorkspaceFolder();
    const watchPattern: vscode.GlobPattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, '**/*')
      : '**/*';
    this.watcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    this.watcher.onDidChange((uri) => { this.queueChanged(uri); });
    this.watcher.onDidCreate((uri) => { this.queueChanged(uri); });
    this.watcher.onDidDelete((uri) => { this.queueDeleted(uri); });
    this.disposables.push(
      this.watcher,
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          this.queueRename(file.oldUri, file.newUri);
        }
      }),
    );
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
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

  async prewarmIfPreferred(): Promise<void> {
    if (this.getConfiguredEngine() !== 'zoekt') { return; }
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return; }
    const binary = await this.resolveBinary(true);
    if (!binary) { return; }
    if (await this.hasReadyIndex(workspaceRoot)) { return; }
    void this.ensureIndexed(workspaceRoot, 'prewarm');
  }

  async rebuildIndex(report?: (message: string, percent?: number) => void): Promise<boolean> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return false; }
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
      this.emitIndexProgress(workspaceRoot, 'zoek-rs: indexing workspace');
      const response = await this.invokeJson([binary, workspaceRoot], undefined, {
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
      if (this.buildPromise) {
        return { ready: false, reason: 'zoek-rs binary build in progress' };
      }
      void this.resolveBinary(true).catch((err) => {
        this.log.appendLine(`zoek-rs background build failed: ${err instanceof Error ? err.message : err}`);
      });
      return { ready: false, reason: 'zoek-rs binary build started' };
    }
    if (await this.hasReadyIndex(workspaceRoot)) {
      return { ready: true };
    }
    if (this.indexPromises.has(workspaceRoot) || this.foregroundIndexPromises.has(workspaceRoot)) {
      return { ready: false, reason: 'zoek-rs index build in progress' };
    }
    void this.ensureIndexed(workspaceRoot, 'search').catch((err) => {
      this.log.appendLine(`zoek-rs background index failed: ${err instanceof Error ? err.message : err}`);
    });
    return { ready: false, reason: 'zoek-rs index incomplete; background build started' };
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
    try {
      const limit = getRequestedResultLimit(options);
      const offset = getRequestedResultOffset(options);
      const response = await this.invokeJson([
        binary,
        'search',
        workspaceRoot,
        this.effectiveQuery(options),
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.useRegex && options.regexMultiline === false ? ['--regex-singleline'] : []),
        ...(!options.useRegex && options.wholeWord ? ['--whole-word'] : []),
        ...(!options.caseSensitive ? [] : ['--case-sensitive']),
        ...this.effectiveIncludeArgs(options),
        '--limit',
        String(limit),
        '--offset',
        String(offset),
      ], token);
      if (response.type !== 'search' || !response.ok) {
        return { ready: false, reason: this.describeEngineFailure(response, 'zoek-rs search failed') };
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
      for (const file of page.matches) {
        if (token.isCancellationRequested) { return { ready: true }; }
        for (const chunk of splitFileMatchChunks(file)) {
          progress.onFile(chunk);
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
    const binary = await this.resolveBinary(true);
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
    const binary = await this.resolveBinary(true);
    if (!binary) { return null; }
    try {
      const response = await this.invokeJson([
        binary,
        'diagnose',
        workspaceRoot,
        this.effectiveQuery(options),
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.useRegex && options.regexMultiline === false ? ['--regex-singleline'] : []),
        ...(!options.useRegex && options.wholeWord ? ['--whole-word'] : []),
        ...(!options.caseSensitive ? [] : ['--case-sensitive']),
        ...this.effectiveIncludeArgs(options),
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
    return normalized.split('/').some((segment) => ZOEKT_INTERNAL_DIR_NAMES.has(segment));
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

  private queueChanged(uri: vscode.Uri): void {
    if (this.disposed) { return; }
    const relPath = this.getRelativePath(uri);
    if (!relPath) { return; }
    this.pendingDeleted.delete(relPath);
    this.pendingChanged.add(relPath);
    this.scheduleFlush();
  }

  private queueDeleted(uri: vscode.Uri): void {
    if (this.disposed) { return; }
    const relPath = this.getRelativePath(uri);
    if (!relPath) { return; }
    this.pendingChanged.delete(relPath);
    this.pendingDeleted.add(relPath);
    this.scheduleFlush();
  }

  private queueRename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    if (this.disposed) { return; }
    const oldRelPath = this.getRelativePath(oldUri);
    const newRelPath = this.getRelativePath(newUri);
    if (!oldRelPath || !newRelPath) { return; }
    this.pendingChanged.delete(oldRelPath);
    this.pendingChanged.delete(newRelPath);
    this.pendingDeleted.delete(oldRelPath);
    this.pendingDeleted.delete(newRelPath);
    this.pendingRenames.push({ oldRelPath, newRelPath });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.disposed) { return; }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingUpdates();
    }, UPDATE_DEBOUNCE_MS);
  }

  private async flushPendingUpdates(): Promise<void> {
    if (this.disposed) {
      this.clearPending();
      return;
    }
    if (
      this.pendingChanged.size === 0 &&
      this.pendingDeleted.size === 0 &&
      this.pendingRenames.length === 0
    ) {
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
    if (
      !binary ||
      !await this.hasReadyIndex(workspaceRoot) ||
      this.indexPromises.has(workspaceRoot) ||
      this.foregroundIndexPromises.has(workspaceRoot)
    ) {
      this.clearPending();
      return;
    }

    const changed = Array.from(this.pendingChanged);
    const deleted = Array.from(this.pendingDeleted);
    const renamed = this.pendingRenames.map((item) => [item.oldRelPath, item.newRelPath] as const);
    this.clearPending();

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
      })
      .catch((err) => {
        if (err instanceof ProcessCancelledError) { return; }
        this.log.appendLine(`zoek-rs update failed: ${err instanceof Error ? err.message : err}`);
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

  private clearPending(): void {
    this.pendingChanged.clear();
    this.pendingDeleted.clear();
    this.pendingRenames = [];
  }

  private async ensureIndexed(workspaceRoot: string, reason: string): Promise<boolean> {
    if (this.disposed) { return false; }
    const existing = this.indexPromises.get(workspaceRoot);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
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

  private async hasReadyIndex(workspaceRoot: string): Promise<boolean> {
    const indexRoot = path.join(workspaceRoot, '.zoek-rs');
    const manifestPath = path.join(indexRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return false;
    }
    try {
      const manifestText = await fs.promises.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestText) as { schemaVersion?: unknown };
      if (manifest.schemaVersion !== ZOEKT_SCHEMA_VERSION) {
        return false;
      }
      const entries = await fs.promises.readdir(indexRoot);
      return entries.some((entry) => /^base-shard-\d+\.zrs$/.test(entry));
    } catch {
      return false;
    }
  }

  private effectiveQuery(options: SearchOptions): string {
    if (options.useRegex && options.wholeWord) {
      return `\\b${options.query}\\b`;
    }
    return options.query;
  }

  private effectiveIncludeArgs(options: SearchOptions): string[] {
    const globs = toRipgrepGlobs(options.includePatterns);
    const args: string[] = [];
    for (const glob of globs) {
      args.push('--include', glob);
    }
    return args;
  }

  private paginateSearchResponse(
    response: ZoektSearchResponse,
    options: SearchOptions,
    workspaceRoot: string,
  ): PaginatedSearchResult {
    const pathScopeMatcher = compilePathScopeMatcher(options.includePatterns, options.excludePatterns);
    const files = response.files
      .map((file): FileMatch => ({
        uri: vscode.Uri.file(path.join(workspaceRoot, file.relPath)).toString(),
        relPath: file.relPath,
        matches: file.matches.map((match) => ({
          line: match.line,
          preview: match.preview,
          ranges: [this.toRange(match)],
        })),
      }))
      .filter((file) => !pathScopeMatcher || pathScopeMatcher(file.relPath));

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
    const parts = [
      `zoek-rs update: generation=${response.generation}`,
      `entries=${response.entriesWritten}`,
      `live=${response.liveEntries}`,
      `tombstones=${response.tombstones}`,
      `journal=${response.journalBytes}`,
    ];
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
    return [
      path.join(this.extensionRoot, 'target', 'debug', `${baseName}${exeSuffix}`),
      path.join(this.extensionRoot, 'target', 'release', `${baseName}${exeSuffix}`),
    ];
  }

  private async resolveBinary(allowBuild: boolean, target: BinaryTarget = 'engine'): Promise<string | null> {
    if (this.disposed) { return null; }
    const cached = target === 'rebuild' ? this.rebuildBinaryPath : this.binaryPath;
    if (cached && fs.existsSync(cached)) {
      return cached;
    }
    const candidates = target === 'engine' ? this.getBinaryCandidates() : this.getBinaryCandidatesFor(target);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.cacheResolvedBinary(target, candidate);
        return candidate;
      }
    }
    if (!allowBuild) {
      return null;
    }
    if (this.buildPromise) {
      await this.buildPromise;
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
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
    this.buildPromise = (async () => {
      this.log.appendLine('zoek-rs build: cargo build -q -p zoek-rs');
      try {
        const result = await this.invokeText(['cargo', 'build', '-q', '-p', 'zoek-rs'], this.extensionRoot, this.lifecycleCts.token);
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
      } catch (err) {
        if (err instanceof ProcessCancelledError) {
          this.log.appendLine('zoek-rs build cancelled.');
          return;
        }
        this.log.appendLine(`zoek-rs build failed: ${err instanceof Error ? err.message : err}`);
        return;
      } finally {
        this.buildPromise = undefined;
      }
      const engineCandidate = this.getBinaryCandidatesFor('engine').find((candidate) => fs.existsSync(candidate));
      if (engineCandidate) {
        this.binaryPath = engineCandidate;
        this.log.appendLine(`zoek-rs build ready: ${engineCandidate}`);
      }
    })();
    await this.buildPromise;
    const builtCandidates = target === 'engine' ? this.getBinaryCandidates() : this.getBinaryCandidatesFor(target);
    for (const candidate of builtCandidates) {
      if (fs.existsSync(candidate)) {
        this.cacheResolvedBinary(target, candidate);
        return candidate;
      }
    }
    return null;
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
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
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
