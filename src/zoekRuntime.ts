import * as fs from 'fs';
import * as path from 'path';
import { type ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import {
  compileIncludeMatcher,
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
  cancelled: boolean;
};

type TrackedChild = {
  id: number;
  child: ChildProcess;
  label: string;
  cancelled: boolean;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

export class ZoektRuntime implements vscode.Disposable {
  private readonly extensionRoot: string;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifecycleCts = new vscode.CancellationTokenSource();
  private binaryPath: string | undefined;
  private buildPromise: Promise<string | null> | undefined;
  private readonly indexPromises = new Map<string, Promise<boolean>>();
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
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
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

  cancelRunningProcesses(reason = 'cancelled'): void {
    for (const tracked of this.activeChildren.values()) {
      this.terminateTrackedChild(tracked, reason);
    }
    void this.sweepExternalZoektProcesses(reason);
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

  async rebuildIndex(report?: (message: string) => void): Promise<boolean> {
    const workspaceRoot = this.getWorkspaceRootPath();
    if (!workspaceRoot) { return false; }
    const binary = await this.resolveBinary(true);
    if (!binary) {
      this.log.appendLine('zoek-rs rebuild skipped: runtime binary unavailable.');
      return false;
    }
    report?.('zoek-rs: indexing workspace');
    const response = await this.invokeJson([binary, 'index', workspaceRoot]);
    if (response.type !== 'index' || !response.ok) {
      throw new Error(this.describeEngineFailure(response, 'zoek-rs index failed'));
    }
    this.logIndexWarnings(response);
    this.log.appendLine(
      `zoek-rs index ready: files=${response.stats.indexedFiles} shards=${response.stats.shardCount} grams=${response.stats.totalGrams}`,
    );
    return true;
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
    if (this.indexPromises.has(workspaceRoot)) {
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
        return {
          ready: false,
          reason: 'zoek-rs returned an empty page before the result set was exhausted; verifying with codesearch',
        };
      }
      if (page.availableMatches === 0 && options.query.trim().length > 0) {
        return { ready: false, reason: 'zoek-rs returned no matches; verifying with codesearch' };
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
      const pendingIndex = Array.from(this.indexPromises.values());
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
    if (!normalized || normalized === '.' || normalized.startsWith('.zoek-rs/')) {
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
    if (!binary || !await this.hasReadyIndex(workspaceRoot) || this.indexPromises.has(workspaceRoot)) {
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
      try {
        const response = await this.invokeJson([binary, 'index', workspaceRoot], this.lifecycleCts.token);
        if (response.type !== 'index' || !response.ok) {
          this.log.appendLine(this.describeEngineFailure(response, 'zoek-rs background index failed'));
          return false;
        }
        this.logIndexWarnings(response);
        this.log.appendLine(
          `zoek-rs background index ready: files=${response.stats.indexedFiles} shards=${response.stats.shardCount}`,
        );
        return true;
      } catch (err) {
        if (err instanceof ProcessCancelledError) { return false; }
        this.log.appendLine(`zoek-rs background index failed: ${err instanceof Error ? err.message : err}`);
        return false;
      } finally {
        this.indexPromises.delete(workspaceRoot);
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
    const includeMatcher = compileIncludeMatcher(options.includePatterns);
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
      .filter((file) => !includeMatcher || includeMatcher(file.relPath));

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
    return [
      path.join(this.extensionRoot, 'target', 'debug', `zoek-rs${exeSuffix}`),
      path.join(this.extensionRoot, 'target', 'release', `zoek-rs${exeSuffix}`),
    ];
  }

  private async resolveBinary(allowBuild: boolean): Promise<string | null> {
    if (this.disposed) { return null; }
    if (this.binaryPath && fs.existsSync(this.binaryPath)) {
      return this.binaryPath;
    }
    for (const candidate of this.getBinaryCandidates()) {
      if (fs.existsSync(candidate)) {
        this.binaryPath = candidate;
        return candidate;
      }
    }
    if (!allowBuild) {
      return null;
    }
    if (this.buildPromise) {
      return this.buildPromise;
    }
    const cargoToml = path.join(this.extensionRoot, 'Cargo.toml');
    if (!fs.existsSync(cargoToml)) {
      return null;
    }
    this.buildPromise = (async () => {
      this.log.appendLine('zoek-rs build: cargo build -q -p zoek-rs');
      try {
        await this.invokeText(['cargo', 'build', '-q', '-p', 'zoek-rs'], this.extensionRoot, this.lifecycleCts.token);
      } catch (err) {
        if (err instanceof ProcessCancelledError) {
          this.log.appendLine('zoek-rs build cancelled.');
          return null;
        }
        this.log.appendLine(`zoek-rs build failed: ${err instanceof Error ? err.message : err}`);
        return null;
      } finally {
        this.buildPromise = undefined;
      }
      for (const candidate of this.getBinaryCandidates()) {
        if (fs.existsSync(candidate)) {
          this.binaryPath = candidate;
          this.log.appendLine(`zoek-rs build ready: ${candidate}`);
          return candidate;
        }
      }
      return null;
    })();
    return this.buildPromise;
  }

  private async invokeJson(args: string[], token?: vscode.CancellationToken): Promise<ZoektEngineResponse> {
    const [command, ...rest] = args;
    const { stdout, stderr, code, cancelled } = await this.invokeText([command, ...rest], this.extensionRoot, token);
    if (cancelled) {
      throw new ProcessCancelledError(`${command} cancelled`);
    }
    if (code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`);
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
  ): Promise<InvokeTextResult> {
    if (this.disposed) {
      return Promise.reject(new ProcessCancelledError('zoek-rs runtime disposed'));
    }
    const [command, ...rest] = args;
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const tracked = this.trackChild(child, [path.basename(command), ...rest.slice(0, 2)].join(' '));
      let stdout = '';
      let stderr = '';
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
        stderr += chunk;
      });
      child.on('error', (err) => {
        cleanup();
        reject(err);
      });
      child.on('close', (code) => {
        cleanup();
        resolve({
          stdout,
          stderr,
          code: code ?? -1,
          cancelled: tracked.cancelled,
        });
      });
    });
  }

  private trackChild(child: ChildProcess, label: string): TrackedChild {
    const tracked: TrackedChild = {
      id: this.nextChildId++,
      child,
      label,
      cancelled: false,
      killTimer: undefined,
    };
    this.activeChildren.set(tracked.id, tracked);
    return tracked;
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

  private async sweepExternalZoektProcesses(reason: string): Promise<void> {
    if (process.platform === 'win32') { return; }
    if (this.externalSweepPromise) { return this.externalSweepPromise; }
    const promise = (async () => {
      const lines = await this.listZoektProcesses();
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

  private listZoektProcesses(): Promise<string[]> {
    return new Promise((resolve) => {
      const child = spawn('pgrep', ['-fl', 'zoek-rs'], {
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
    });
  }
}
