import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as v8 from 'v8';
import { pathToFileURL } from 'url';
import { gzip, gunzip } from 'zlib';
import * as vscode from 'vscode';
import { compilePathScopeMatcher } from './pathScope';
import { decodeTextBytes, looksBinaryContent } from './textFiles';

export type CallGraphLanguage = 'python' | 'java' | 'kotlin' | 'typescript' | 'javascript' | 'graphql';
export type CallGraphSymbolKind = 'class' | 'interface' | 'enum' | 'type' | 'struct' | 'function' | 'method' | 'constructor' | 'constant' | 'variable' | 'field' | 'property';
export type CallGraphSymbolModifier = 'abstract' | 'interface' | 'property';
export type CallGraphEdgeKind = 'direct' | 'method' | 'constructor' | 'static' | 'virtual' | 'dynamic';
export type CallGraphConfidence = 'exact' | 'resolved' | 'possible' | 'unresolved';
export type CallGraphEdgeSource = 'semantic' | 'heuristic' | 'zoekt-fallback';

export interface CallGraphRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CallGraphSymbol {
  id: string;
  name: string;
  qualifiedName: string;
  kind: CallGraphSymbolKind;
  language: CallGraphLanguage;
  uri: string;
  relPath: string;
  range: CallGraphRange;
  bodyRange: CallGraphRange;
  containerId?: string;
  containerName?: string;
  packageName?: string;
  signature?: string;
  modifiers?: CallGraphSymbolModifier[];
  extendsNames?: string[];
  implementsNames?: string[];
}

export interface CallGraphCallSite {
  name: string;
  receiver?: string;
  rawText: string;
  uri: string;
  relPath: string;
  range: CallGraphRange;
  enclosingSymbolId: string;
}

export interface CallGraphEdge {
  id: string;
  callerId: string;
  calleeId?: string;
  calleeName: string;
  receiver?: string;
  callKind: CallGraphEdgeKind;
  confidence: CallGraphConfidence;
  source: CallGraphEdgeSource;
  callsite: CallGraphCallSite;
  evidence: string[];
}

export interface CallGraphReference {
  symbolId: string;
  name: string;
  rawText: string;
  uri: string;
  relPath: string;
  range: CallGraphRange;
  enclosingSymbolId?: string;
}

export interface CallGraphStats {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  exactEdgeCount: number;
  possibleEdgeCount: number;
  unresolvedEdgeCount: number;
  languageCounts: Record<CallGraphLanguage, number>;
  elapsedMs: number;
  parseConcurrency: number;
  skippedFileCount: number;
  callsiteCount: number;
  skippedPossibleEdgeCount: number;
  skippedUnresolvedEdgeCount: number;
  edgeLimitHit: boolean;
  referenceCount: number;
  minParseConcurrency?: number;
  workerThrottleCount?: number;
  maxHeapUsedMb?: number;
  maxHeapUsageRatio?: number;
}

export interface CallGraphSnapshot {
  workspaceRoot: string;
  builtAtUnixMs: number;
  symbols: CallGraphSymbol[];
  edges: CallGraphEdge[];
  references: CallGraphReference[];
  stats: CallGraphStats;
  warnings: string[];
}

export interface CallGraphQueryResult {
  symbol: CallGraphSymbol;
  edges: CallGraphEdge[];
  relatedSymbols: CallGraphSymbol[];
}

export interface CallGraphSymbolRelationSummary {
  symbol: CallGraphSymbol;
  callerCount: number;
  calleeCount: number;
  implementationCount: number;
  implementations: CallGraphSymbol[];
  usageCount: number;
  usages: CallGraphReference[];
}

export interface CallGraphRebuildProgress {
  stage: 'discovering' | 'parsing' | 'indexing' | 'resolving' | 'deduping' | 'done';
  message: string;
  current: number;
  total: number;
  parsedFiles: number;
  skippedFiles: number;
  warningCount: number;
  elapsedMs: number;
  concurrency: number;
  maxConcurrency?: number;
  heapUsedMb?: number;
  heapLimitMb?: number;
  heapUsageRatio?: number;
  workerThrottleCount?: number;
}

export interface CallGraphRebuildOptions {
  force?: boolean;
}

export interface CallGraphWorkerRebuildInput {
  workspaceRoot: string;
  cacheDirFsPath: string;
  configSignature: string;
  excludeGlobs: string[];
  maxFileSize: number;
  buildLimits: {
    maxCallsites: number;
    maxReferenceCandidates: number;
    memoryBudgetMb: number;
  };
  parseConcurrency: number;
  resolveOptions: {
    includePossibleEdges: boolean;
    includeUnresolvedEdges: boolean;
    maxEdges?: number;
    maxPossibleTargetsPerCall: number;
  };
  parseLimits: {
    maxLineLength: number;
    maxLinesPerFile: number;
    maxReferenceCandidatesPerFile: number;
    maxAssignedFunctionNamesPerFile: number;
  };
  cpuBudget: {
    percent: number;
    maxPauseMs: number;
  };
}

export interface CallGraphWorkerRebuildResult {
  builtAtUnixMs: number;
  stats: CallGraphStats;
  warnings: string[];
  recordIndexCount: number;
  snapshotChunkCount: number;
  symbolRelationBucketCount: number;
  documentSummaryBucketCount: number;
  cacheBytes: number;
}

type CallGraphVariableBinding = {
  variableName: string;
  className: string;
  enclosingSymbolId: string;
  range: CallGraphRange;
};

type VariableBindingCandidate = {
  variableNames: string[];
  className: string;
  range: CallGraphRange;
};

type MutableSymbol = CallGraphSymbol & {
  indent?: number;
};

type ParsedFile = {
  symbols: MutableSymbol[];
  calls: CallGraphCallSite[];
  bindings: CallGraphVariableBinding[];
  referenceCandidates: CallGraphReferenceCandidate[];
  warnings: string[];
};

type CallGraphFileRecord = {
  uri: string;
  relPath: string;
  language: CallGraphLanguage;
  mtime: number;
  size: number;
  parsed: ParsedFile;
};

type CallGraphDocumentSummarySymbol = {
  symbol: CallGraphSymbol;
  callerCount: number;
  calleeCount: number;
  implementationCount: number;
  usageCount: number;
};

type CallGraphDocumentSummaryRecord = {
  uri: string;
  relPath: string;
  symbols: CallGraphDocumentSummarySymbol[];
};

type CallGraphCacheManifest = {
  version: number;
  workspaceRoot: string;
  configSignature: string;
  builtAtUnixMs: number;
  chunks: CallGraphCacheChunk[];
  recordIndex?: CallGraphRecordIndexEntry[];
  recordOverrides?: CallGraphRecordOverrideChunk[];
  symbolRelations?: CallGraphSymbolRelationChunk[];
  documentSummaries?: CallGraphDocumentSummaryChunk[];
  documentSummaryFiles?: CallGraphDocumentSummaryFileChunk[];
  snapshot?: {
    builtAtUnixMs: number;
    stats: CallGraphStats;
    warnings: string[];
    symbols: CallGraphCacheChunk[];
    edges: CallGraphCacheChunk[];
    references: CallGraphCacheChunk[];
  };
};

type CallGraphCacheChunk = {
  file: string;
  count: number;
};

type CallGraphRecordIndexEntry = {
  uri: string;
  relPath: string;
  language: CallGraphLanguage;
  mtime: number;
  size: number;
};

type CallGraphRecordOverrideChunk = CallGraphCacheChunk & {
  uri: string;
  uriHash: string;
  updatedAtUnixMs: number;
};

type CallGraphRecordOverride = {
  uri: string;
  record?: CallGraphFileRecord;
  deleted?: boolean;
  updatedAtUnixMs: number;
};

type CallGraphSymbolRelationRecord = {
  symbolId: string;
  usages: CallGraphReference[];
};

type CallGraphSymbolRelationChunk = CallGraphCacheChunk & {
  bucket: number;
};

type CallGraphDocumentSummaryChunk = CallGraphCacheChunk & {
  bucket: number;
};

type CallGraphDocumentSummaryFileChunk = CallGraphCacheChunk & {
  uri: string;
  uriHash: string;
};

type RustGraphQueryReference = {
  name: string;
  rawText: string;
  uri: string;
  relPath: string;
  range: CallGraphRange;
  enclosingSymbolId?: string;
};

type RustGraphQueryResponse = {
  type?: string;
  ok?: boolean;
  builtAtUnixMs?: number;
  totalReferences?: number;
  references?: RustGraphQueryReference[];
  warnings?: string[];
};

type RustGraphIndexResponse = {
  type?: string;
  ok?: boolean;
  builtAtUnixMs?: number;
  fileCount?: number;
  symbolCount?: number;
  referenceCount?: number;
  bytes?: number;
  warnings?: string[];
};

type RustGraphSymbol = {
  id?: string;
  name?: string;
  qualifiedName?: string;
  kind?: string;
  language?: string;
  uri?: string;
  relPath?: string;
  range?: CallGraphRange;
  bodyRange?: CallGraphRange;
  containerId?: string;
  containerName?: string;
  packageName?: string;
  extendsNames?: string[];
  implementsNames?: string[];
  usageCount?: number;
  implementationCount?: number;
};

type RustGraphSymbolQueryResponse = {
  type?: string;
  ok?: boolean;
  builtAtUnixMs?: number;
  totalSymbols?: number;
  symbols?: RustGraphSymbol[];
  warnings?: string[];
};

type ParsedSourceFileResult = {
  record?: CallGraphFileRecord;
  skipped: boolean;
  reused?: boolean;
  warnings: string[];
};

type CallGraphReferenceCandidate = Omit<CallGraphReference, 'symbolId'> & {
  receiver?: string;
  allowCallableTarget?: boolean;
  allowDeclarationRange?: boolean;
};

type SymbolIndex = {
  byId: Map<string, CallGraphSymbol>;
  byName: Map<string, CallGraphSymbol[]>;
  byQualifiedName: Map<string, CallGraphSymbol[]>;
  byClassName: Map<string, CallGraphSymbol[]>;
  methodsByName: Map<string, CallGraphSymbol[]>;
  methodsByClassName: Map<string, Map<string, CallGraphSymbol[]>>;
  symbolsByFile: Map<string, CallGraphSymbol[]>;
  bindingsBySymbolId: Map<string, Map<string, CallGraphVariableBinding>>;
  typesByReferencedName: Map<string, CallGraphSymbol[]>;
};

type CallGraphResolveOptions = {
  includePossibleEdges: boolean;
  includeUnresolvedEdges: boolean;
  maxEdges?: number;
  maxPossibleTargetsPerCall: number;
};

type CallGraphParseLimits = {
  maxLineLength: number;
  maxLinesPerFile: number;
  maxReferenceCandidatesPerFile: number;
  maxAssignedFunctionNamesPerFile: number;
};

type CallGraphCpuBudget = {
  percent: number;
  maxPauseMs: number;
};

type CallGraphBuildLimits = {
  maxCallsites: number;
  maxReferenceCandidates: number;
  memoryBudgetMb: number;
};

type CallGraphBuildBudgetState = {
  acceptedCallsites: number;
  acceptedReferenceCandidates: number;
  droppedCallsites: number;
  droppedReferenceCandidates: number;
  firstCallsiteLimitRelPath?: string;
  firstReferenceCandidateLimitRelPath?: string;
};

type CallGraphWorkerRuntime = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  source: string;
};

const CALL_GRAPH_HEAP_HIGH_WATERMARK_RATIO = 0.8;
const CALL_GRAPH_HEAP_RESUME_RATIO = 0.72;
const CALL_GRAPH_HEAP_CRITICAL_WATERMARK_RATIO = 0.92;
const CALL_GRAPH_HEAP_THROTTLE_PAUSE_MS = 150;
const CALL_GRAPH_HEAP_STALL_ABORT_MS = 10_000;

type CallGraphHeapPressure = {
  heapUsedBytes: number;
  heapLimitBytes: number;
  heapUsageRatio: number;
  heapUsedMb: number;
  heapLimitMb: number;
};

type CallGraphAdaptiveConcurrencySnapshot = {
  currentConcurrency: number;
  maxConcurrency: number;
  active: number;
  heapUsedMb: number;
  heapLimitMb: number;
  heapUsageRatio: number;
  highWatermarkRatio: number;
  resumeRatio: number;
  throttleCount: number;
  maxHeapUsedMb: number;
  maxHeapUsageRatio: number;
  minConcurrency: number;
};

type CallGraphAdaptiveConcurrencyStats = {
  maxConcurrency: number;
  maxObservedConcurrency: number;
  minObservedConcurrency: number;
  currentConcurrency: number;
  throttleCount: number;
  maxHeapUsedMb: number;
  maxHeapUsageRatio: number;
  heapLimitMb: number;
};

type CallGraphAdaptiveConcurrencyOptions = {
  token?: vscode.CancellationToken;
  highWatermarkRatio?: number;
  resumeRatio?: number;
  criticalWatermarkRatio?: number;
  pauseMs?: number;
  stallAbortMs?: number;
  onStateChange?: (state: CallGraphAdaptiveConcurrencySnapshot) => void;
};

type ResolvedCallTarget = {
  symbol: CallGraphSymbol;
  kind: CallGraphEdgeKind;
  confidence: CallGraphConfidence;
  evidence: string[];
};

type MethodTargetMatch = {
  symbol: CallGraphSymbol;
  owner: CallGraphSymbol;
  inherited: boolean;
};

type ResolveCallsResult = {
  edges: CallGraphEdge[];
  skippedPossibleEdgeCount: number;
  skippedUnresolvedEdgeCount: number;
  edgeLimitHit: boolean;
};

type RelationSummaryIndex = {
  callersBySymbolId: Map<string, Set<string>>;
  calleesBySymbolId: Map<string, Set<string>>;
  usagesBySymbolId: Map<string, CallGraphReference[]>;
};

type ClassDeclaration = {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'type' | 'struct';
  modifiers: CallGraphSymbolModifier[];
  extendsNames: string[];
  implementsNames: string[];
};

type CallableDeclaration = {
  name: string;
  hasBody: boolean;
};

type HeaderSpan = {
  text: string;
  endLine: number;
};

export class CallGraphRebuildCancelledError extends Error {
  constructor() {
    super('Call graph rebuild cancelled.');
    this.name = 'CallGraphRebuildCancelledError';
  }
}

const SOURCE_EXTENSIONS = new Set([
  '.py',
  '.java',
  '.kt',
  '.kts',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const DEFAULT_CALL_GRAPH_PARSE_LIMITS: CallGraphParseLimits = {
  maxLineLength: 0,
  maxLinesPerFile: 0,
  maxReferenceCandidatesPerFile: 0,
  maxAssignedFunctionNamesPerFile: 0,
};

const LANGUAGE_BY_EXTENSION = new Map<string, CallGraphLanguage>([
  ['.py', 'python'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.graphql', 'graphql'],
  ['.gql', 'graphql'],
]);

const CALL_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'function',
  'return',
  'typeof',
  'sizeof',
  'new',
  'class',
  'def',
  'fun',
  'constructor',
  'super',
  'import',
  'require',
]);

const COLLECTION_BINDING_TYPE_NAMES = new Set([
  'Array',
  'ReadonlyArray',
  'Iterable',
  'IterableIterator',
  'Iterator',
  'Generator',
  'Sequence',
  'MutableSequence',
  'List',
  'MutableList',
  'Tuple',
  'Set',
  'MutableSet',
  'Collection',
  'Dict',
  'Map',
  'Record',
  'Optional',
  'Union',
]);

const VALUE_BINDING_TYPE_NAMES = new Set([
  'Any',
  'Boolean',
  'Double',
  'Float',
  'Integer',
  'Long',
  'None',
  'Number',
  'Object',
  'String',
  'Void',
]);

const MAX_CALL_GRAPH_CONCURRENCY = 64;
const MAX_POSSIBLE_EDGES_PER_CALL = 40;
const DEFAULT_CALL_GRAPH_CONCURRENCY = getDefaultCallGraphConcurrency();
const DEFAULT_CALL_GRAPH_MAX_EDGES = 0;
const DEFAULT_CALL_GRAPH_MAX_CALLSITES = 0;
const DEFAULT_CALL_GRAPH_MAX_REFERENCE_CANDIDATES = 0;
const DEFAULT_CALL_GRAPH_MEMORY_BUDGET_MB = 8_192;
const CALL_GRAPH_SOURCE_GLOB = '**/*.{py,java,kt,kts,ts,tsx,js,jsx,mjs,cjs}';
const CALL_GRAPH_CACHE_VERSION = 14;
const CALL_GRAPH_EXTERNAL_INCREMENTAL_DEBOUNCE_MS = 1_500;
const CALL_GRAPH_SAVE_INCREMENTAL_DEBOUNCE_MS = 75;
const CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK = 50_000;
const CALL_GRAPH_SYMBOL_RELATION_BUCKETS = 256;
const CALL_GRAPH_DOCUMENT_SUMMARY_BUCKETS = 256;
const RUST_GRAPH_QUERY_TIMEOUT_MS = 30_000;
const RUST_GRAPH_PROCESS_KILL_TIMEOUT_MS = 2_000;
const INTERNAL_CALL_GRAPH_EXCLUDE_GLOBS = [
  '**/.zoek-rs/**',
  '**/.zoekt-rs/**',
];
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

type RustGraphProcessKind =
  | 'build'
  | 'graph-rebuild'
  | 'graph-update'
  | 'graph-index'
  | 'graph-query'
  | 'graph-symbol-query'
  | 'other';

type RustGraphTrackedChild = {
  id: number;
  child: ChildProcess;
  label: string;
  kind: RustGraphProcessKind;
  cancelled: boolean;
  killTimer: ReturnType<typeof setTimeout> | undefined;
};

type RustGraphInvokeOptions = {
  onStderrLine?: (line: string) => void;
  token?: vscode.CancellationToken;
  timeoutMs?: number;
  cancelError?: Error;
};

export class CallGraphService implements vscode.Disposable {
  private snapshot: CallGraphSnapshot | undefined;
  private rebuildPromise: Promise<CallGraphSnapshot> | undefined;
  private disposed = false;
  private readonly onDidChangeSnapshotEmitter = new vscode.EventEmitter<void>();
  private indexCache: { snapshot: CallGraphSnapshot; index: SymbolIndex } | undefined;
  private relationSummaryCache: { snapshot: CallGraphSnapshot; index: RelationSummaryIndex } | undefined;
  private readonly fileRecordsByUri = new Map<string, CallGraphFileRecord>();
  private readonly pendingChangedUris = new Set<string>();
  private readonly watcher: vscode.FileSystemWatcher | undefined;
  private restorePromise: Promise<void> | undefined;
  private snapshotRestorePromise: Promise<void> | undefined;
  private incrementalTimer: ReturnType<typeof setTimeout> | undefined;
  private incrementalFlushAt = 0;
  private incrementalReason = '';
  private incrementalPromise: Promise<void> | undefined;
  private cacheWritePromise: Promise<void> = Promise.resolve();
  private rustGraphBuildPromise: Promise<string | undefined> | undefined;
  private cacheConfigSignature: string | undefined;
  private cacheManifest: CallGraphCacheManifest | undefined;
  private cacheRecordsLoaded = false;
  private readonly symbolRelationBucketsByIndex = new Map<number, Map<string, CallGraphSymbolRelationRecord>>();
  private readonly symbolRelationLoadedBuckets = new Set<number>();
  private readonly symbolRelationBucketPromises = new Map<number, Promise<void>>();
  private readonly documentSummaryBucketsByIndex = new Map<number, Map<string, CallGraphDocumentSummaryRecord>>();
  private readonly documentSummaryLoadedBuckets = new Set<number>();
  private readonly documentSummaryBucketPromises = new Map<number, Promise<void>>();
  private readonly rustSymbolQueryCache = new Map<string, { builtAtUnixMs: number; symbols: CallGraphSymbol[] }>();
  private readonly rustDocumentSummaryPromises = new Map<string, Promise<boolean>>();
  private readonly rustNativeDocumentSummaryUris = new Set<string>();
  private readonly rustNativeDirtySummaryUris = new Set<string>();
  private readonly rustGraphChildren = new Map<number, RustGraphTrackedChild>();
  private documentSummaryMigrationPromise: Promise<boolean> | undefined;
  private readonly documentSummaryFilePromises = new Map<string, Promise<boolean>>();
  private nextRustGraphChildId = 1;

  readonly onDidChangeSnapshot = this.onDidChangeSnapshotEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    const disposables: vscode.Disposable[] = [];
    if (this.shouldWatchExternalFileChanges()) {
      this.watcher = vscode.workspace.createFileSystemWatcher(CALL_GRAPH_SOURCE_GLOB);
      disposables.push(
        this.watcher,
        this.watcher.onDidCreate((uri) => this.scheduleIncrementalRefresh(uri, 'external-created')),
        this.watcher.onDidChange((uri) => {
          const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
          if (openDocument) { return; }
          this.scheduleIncrementalRefresh(uri, 'external-changed');
        }),
        this.watcher.onDidDelete((uri) => this.scheduleIncrementalRefresh(uri, 'external-deleted')),
      );
    }
    disposables.push(
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          this.scheduleIncrementalRefreshIfSupported(uri, 'created');
        }
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) {
          this.scheduleIncrementalRefreshIfSupported(uri, 'deleted');
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          this.scheduleIncrementalRefreshIfSupported(file.oldUri, 'renamed-old');
          this.scheduleIncrementalRefreshIfSupported(file.newUri, 'renamed-new');
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.scheduleIncrementalRefreshIfSupported(document.uri, 'saved', CALL_GRAPH_SAVE_INCREMENTAL_DEBOUNCE_MS);
      }),
    );
    context.subscriptions.push(
      ...disposables,
    );
    this.restorePromise = this.restorePersistedCacheManifest();
  }

  dispose(): void {
    this.disposed = true;
    if (this.incrementalTimer) {
      clearTimeout(this.incrementalTimer);
      this.incrementalTimer = undefined;
    }
    this.incrementalFlushAt = 0;
    this.incrementalReason = '';
    this.cancelRustGraphProcesses('call graph disposed');
    this.watcher?.dispose();
    this.onDidChangeSnapshotEmitter.dispose();
  }

  getSnapshot(): CallGraphSnapshot | undefined {
    return this.snapshot;
  }

  isRustNativeIndexOnly(snapshot = this.snapshot): boolean {
    return isRustNativeIndexOnlySnapshot(snapshot);
  }

  private hasRustNativePrimaryGraph(): boolean {
    return this.isRustNativeIndexOnly() || isRustNativeGraphManifest(this.cacheManifest);
  }

  async ensureBuilt(): Promise<CallGraphSnapshot> {
    if (this.snapshot) { return this.snapshot; }
    if (this.restorePromise) {
      await this.restorePromise;
      if (this.snapshot) { return this.snapshot; }
    }
    await this.restorePersistedSnapshot();
    if (this.snapshot) { return this.snapshot; }
    return this.rebuild();
  }

  async ensureRestoredSnapshot(): Promise<CallGraphSnapshot | undefined> {
    if (this.snapshot) { return this.snapshot; }
    if (this.restorePromise) {
      await this.restorePromise;
      if (this.snapshot) { return this.snapshot; }
    }
    await this.restorePersistedSnapshot();
    return this.snapshot;
  }

  async ensureDocumentSummariesRestored(uri?: vscode.Uri): Promise<boolean> {
    if (this.snapshot && !this.isRustNativeIndexOnly()) { return true; }
    if (this.restorePromise) {
      await this.restorePromise;
      if (this.snapshot && !this.isRustNativeIndexOnly()) { return true; }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (uri && folder && manifest && this.hasRustNativePrimaryGraph()) {
      return this.ensureRustNativeDocumentSummary(uri);
    }
    if (uri && this.getCachedDocumentSummaryRecord(uri.toString())) { return true; }
    if (folder && manifest && uri) {
      const fileChunk = findDocumentSummaryFileChunk(manifest, uri.toString());
      if (fileChunk) {
        await this.loadDocumentSummaryFile(folder.uri.fsPath, fileChunk);
        return true;
      }
    }
    const chunks = manifest?.documentSummaries;
    if (!folder || !manifest || !Array.isArray(chunks) || chunks.length === 0) {
      if (folder && manifest && uri) {
        if (manifest?.snapshot) {
          void this.ensureDocumentSummaryFileFromSnapshot(uri, 'missing-document-summary-buckets');
        }
      }
      return false;
    }
    if (uri) {
      const bucket = documentSummaryBucketForUri(uri.toString());
      await this.ensureDocumentSummaryBucketLoaded(folder.uri.fsPath, bucket, chunks);
      return true;
    }
    await Promise.all(
      chunks.map((chunk) => this.ensureDocumentSummaryBucketLoaded(folder.uri.fsPath, chunk.bucket, chunks)),
    );
    return true;
  }

  async rebuild(
    report?: (progress: CallGraphRebuildProgress) => void,
    token?: vscode.CancellationToken,
    options: CallGraphRebuildOptions = {},
  ): Promise<CallGraphSnapshot> {
    if (this.rebuildPromise) { return this.rebuildPromise; }
    this.rebuildPromise = this.doRebuild(report, token, options).finally(() => {
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  resolveSymbols(query: string, limit = 20): CallGraphSymbol[] {
    if (!query.trim()) { return []; }
    if (this.isRustNativeIndexOnly()) {
      return this.resolveCachedRustSymbols(query, limit);
    }
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const normalized = query.trim();
    const lower = normalized.toLowerCase();
    const scored = snapshot.symbols
      .map((symbol) => ({ symbol, score: scoreSymbolMatch(symbol, normalized, lower) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName));
    return scored.slice(0, limit).map((entry) => entry.symbol);
  }

  async resolveSymbolsResolved(query: string, limit = 20): Promise<CallGraphSymbol[]> {
    const cached = this.resolveSymbols(query, limit);
    if (cached.length > 0 || !this.isRustNativeIndexOnly() || !query.trim()) { return cached; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest?.builtAtUnixMs) { return cached; }
    const symbols = await this.queryRustGraphSymbolIndex(
      folder.uri.fsPath,
      { query: query.trim(), limit },
      manifest.builtAtUnixMs,
    );
    if (!symbols) { return cached; }
    if (this.cacheManifest?.builtAtUnixMs !== manifest.builtAtUnixMs) { return cached; }
    this.rustSymbolQueryCache.set(rustSymbolQueryCacheKey(query, limit), {
      builtAtUnixMs: manifest.builtAtUnixMs,
      symbols,
    });
    return symbols;
  }

  findEnclosingSymbol(uri: vscode.Uri, position: vscode.Position): CallGraphSymbol | undefined {
    if (this.isRustNativeIndexOnly()) {
      const symbols = this.getCachedDocumentSymbols(uri.toString())
        .filter((symbol) => rangeContainsPosition(symbol.bodyRange, position))
        .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
      return symbols.find((symbol) => symbol.kind === 'method' || symbol.kind === 'function') ?? symbols[0];
    }
    const snapshot = this.snapshot;
    if (!snapshot) { return undefined; }
    const symbols = snapshot.symbols
      .filter((symbol) => symbol.uri === uri.toString() && rangeContainsPosition(symbol.bodyRange, position))
      .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
    return symbols.find((symbol) => symbol.kind === 'method' || symbol.kind === 'function') ?? symbols[0];
  }

  findDeclarationSymbolsAtPosition(uri: vscode.Uri, position: vscode.Position): CallGraphSymbol[] {
    if (this.isRustNativeIndexOnly()) {
      return this.getCachedDocumentSymbols(uri.toString())
        .filter((symbol) => rangeContainsPosition(symbol.range, position))
        .sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
    }
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    return snapshot.symbols
      .filter((symbol) => symbol.uri === uri.toString() && rangeContainsPosition(symbol.range, position))
      .sort((a, b) => rangeSize(a.range) - rangeSize(b.range));
  }

  findCallEdgesAtPosition(uri: vscode.Uri, position: vscode.Position): CallGraphEdge[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    return snapshot.edges
      .filter((edge) => edge.callsite.uri === uri.toString() && rangeContainsPosition(edge.callsite.range, position))
      .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
  }

  findTargetsAtPosition(uri: vscode.Uri, position: vscode.Position): CallGraphSymbol[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const index = this.getIndex(snapshot);
    const declarations = this.findDeclarationSymbolsAtPosition(uri, position);
    if (declarations.length > 0) { return declarations; }
    const edgeTargets = this.findCallEdgesAtPosition(uri, position)
      .map((edge) => edge.calleeId ? index.byId.get(edge.calleeId) : undefined)
      .filter((symbol): symbol is CallGraphSymbol => !!symbol);
    if (edgeTargets.length > 0) { return dedupeSymbols(edgeTargets); }
    const enclosing = this.findEnclosingSymbol(uri, position);
    return enclosing ? [enclosing] : [];
  }

  getCallers(symbolOrQuery: string, limit = 200): CallGraphQueryResult[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const symbols = this.resolveInputSymbols(symbolOrQuery);
    const byId = this.getIndex(snapshot).byId;
    return symbols.map((symbol) => {
      const edges = snapshot.edges
        .filter((edge) => edge.calleeId === symbol.id || (!edge.calleeId && edge.calleeName === symbol.name))
        .slice(0, limit);
      const relatedSymbols = collectRelatedSymbols(edges.map((edge) => edge.callerId), byId);
      return { symbol, edges, relatedSymbols };
    });
  }

  getCallees(symbolOrQuery: string, limit = 200): CallGraphQueryResult[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const symbols = this.resolveInputSymbols(symbolOrQuery);
    const byId = this.getIndex(snapshot).byId;
    return symbols.map((symbol) => {
      const edges = snapshot.edges
        .filter((edge) => edge.callerId === symbol.id)
        .slice(0, limit);
      const relatedSymbols = collectRelatedSymbols(
        edges.map((edge) => edge.calleeId).filter((id): id is string => !!id),
        byId,
      );
      return { symbol, edges, relatedSymbols };
    });
  }

  async getCallersResolved(symbolOrQuery: string, limit = 200): Promise<CallGraphQueryResult[]> {
    const base = this.getCallers(symbolOrQuery, limit);
    return this.mergeProviderResults(base, 'callers', limit);
  }

  async getCalleesResolved(symbolOrQuery: string, limit = 200): Promise<CallGraphQueryResult[]> {
    const base = this.getCallees(symbolOrQuery, limit);
    return this.mergeProviderResults(base, 'callees', limit);
  }

  findUsages(symbolOrQuery: string, limit = 500): CallGraphReference[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const symbols = this.resolveInputSymbols(symbolOrQuery);
    if (symbols.length === 0) { return []; }
    const relationIndex = this.getRelationSummaryIndex(snapshot);
    const out: CallGraphReference[] = [];
    const seen = new Set<string>();
    for (const symbol of symbols) {
      for (const reference of relationIndex.usagesBySymbolId.get(symbol.id) ?? []) {
        const key = referenceLocationKey(reference);
        if (seen.has(key)) { continue; }
        seen.add(key);
        out.push(reference);
        if (out.length >= limit) { return out; }
      }
    }
    return out;
  }

  async findUsagesForSymbolIdFromCache(
    symbolId: string,
    limit = 500,
  ): Promise<CallGraphReference[] | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    const started = Date.now();
    if (folder && manifest?.snapshot && symbolId) {
      const rustUsages = await this.queryRustGraphUsageIndex(
        folder.uri.fsPath,
        symbolId,
        limit,
        manifest.builtAtUnixMs,
      );
      if (rustUsages) {
        if (isRustNativeGraphManifest(manifest)) {
          const usages = rustUsages.slice(0, limit);
          this.log.appendLine(
            `call graph cached usage query: source=rust-native graph-index symbolId=${JSON.stringify(symbolId)} ` +
            `matches=${usages.length} elapsed=${Date.now() - started}ms`,
          );
          return usages;
        }
        const overrides = await this.loadRecordOverrides(folder.uri.fsPath, manifest);
        const overriddenUris = new Set(overrides.map((override) => override.uri));
        const relationIndex: RelationSummaryIndex = {
          callersBySymbolId: new Map(),
          calleesBySymbolId: new Map(),
          usagesBySymbolId: new Map([[
            symbolId,
            rustUsages.filter((reference) => !overriddenUris.has(reference.uri)).slice(0, limit),
          ]]),
        };
        if (overrides.length > 0) {
          await this.mergeRecordOverrideRelationsForSymbolIds(
            folder.uri.fsPath,
            manifest,
            new Set([symbolId]),
            relationIndex,
          );
        }
        const usages = (relationIndex.usagesBySymbolId.get(symbolId) ?? []).slice(0, limit);
        this.log.appendLine(
          `call graph cached usage query: source=rust-graph-index symbolId=${JSON.stringify(symbolId)} ` +
          `matches=${usages.length} elapsed=${Date.now() - started}ms`,
        );
        return usages;
      }
    }
    if (folder && manifest?.snapshot && symbolId && Array.isArray(manifest.symbolRelations)) {
      let baseUsages: CallGraphReference[] = [];
      if (manifest.symbolRelations.length > 0) {
        const bucket = symbolRelationBucketForSymbolId(symbolId);
        await this.ensureSymbolRelationBucketLoaded(folder.uri.fsPath, bucket, manifest.symbolRelations);
        const record = this.getCachedSymbolRelationRecord(symbolId);
        baseUsages = record?.usages ?? [];
      }
      const overrides = await this.loadRecordOverrides(folder.uri.fsPath, manifest);
      const overriddenUris = new Set(overrides.map((override) => override.uri));
      const relationIndex: RelationSummaryIndex = {
        callersBySymbolId: new Map(),
        calleesBySymbolId: new Map(),
        usagesBySymbolId: new Map([[
          symbolId,
          baseUsages.filter((reference) => !overriddenUris.has(reference.uri)).slice(0, limit),
        ]]),
      };
      if (overrides.length > 0) {
        await this.mergeRecordOverrideRelationsForSymbolIds(
          folder.uri.fsPath,
          manifest,
          new Set([symbolId]),
          relationIndex,
        );
      }
      const usages = (relationIndex.usagesBySymbolId.get(symbolId) ?? []).slice(0, limit);
      this.log.appendLine(
        `call graph cached usage query: source=symbol-relations symbolId=${JSON.stringify(symbolId)} ` +
        `matches=${usages.length} elapsed=${Date.now() - started}ms`,
      );
      return usages;
    }
    const snapshot = this.snapshot;
    if (snapshot && this.relationSummaryCache?.snapshot === snapshot) {
      const usages = (this.relationSummaryCache.index.usagesBySymbolId.get(symbolId) ?? []).slice(0, limit);
      this.log.appendLine(
        `call graph cached usage query: source=memory-relation-index symbolId=${JSON.stringify(symbolId)} ` +
        `matches=${usages.length} elapsed=${Date.now() - started}ms`,
      );
      return usages;
    }
    return undefined;
  }

  findImplementations(symbolOrQuery: string, limit = 200): CallGraphSymbol[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const index = this.getIndex(snapshot);
    const out: CallGraphSymbol[] = [];
    for (const symbol of this.resolveInputSymbols(symbolOrQuery)) {
      out.push(...findImplementationSymbols(symbol, index, limit));
      if (out.length >= limit) { break; }
    }
    return dedupeSymbols(out).slice(0, limit);
  }

  findImplementationsAtPosition(uri: vscode.Uri, position: vscode.Position, limit = 200): CallGraphSymbol[] {
    const targets = this.findTargetsAtPosition(uri, position);
    if (targets.length === 0) { return []; }
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const index = this.getIndex(snapshot);
    return dedupeSymbols(targets.flatMap((symbol) => findImplementationSymbols(symbol, index, limit))).slice(0, limit);
  }

  getSymbolRelationSummariesForDocument(
    uri: vscode.Uri,
    range?: vscode.Range,
    limit = 500,
  ): CallGraphSymbolRelationSummary[] {
    if (this.isRustNativeIndexOnly()) {
      return this.getCachedSymbolRelationSummariesForDocument(uri, range, limit);
    }
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const uriString = uri.toString();
    const index = this.getIndex(snapshot);
    const relationIndex = this.getRelationSummaryIndex(snapshot);
    const symbols = snapshot.symbols
      .filter((symbol) => symbol.uri === uriString)
      .filter((symbol) => !range || range.contains(new vscode.Position(symbol.range.startLine, symbol.range.startColumn)))
      .filter((symbol) => isCallableSymbol(symbol) || isTypeSymbol(symbol) || isReferenceableSymbol(symbol))
      .slice(0, limit);
    const summaries: CallGraphSymbolRelationSummary[] = [];
    for (const symbol of symbols) {
      const callable = isCallableSymbol(symbol);
      const implementations = findImplementationSymbols(symbol, index, 20);
      const usages = relationIndex.usagesBySymbolId.get(symbol.id) ?? [];
      const summary = {
        symbol,
        callerCount: callable ? relationIndex.callersBySymbolId.get(symbol.id)?.size ?? 0 : 0,
        calleeCount: callable ? relationIndex.calleesBySymbolId.get(symbol.id)?.size ?? 0 : 0,
        implementationCount: implementations.length,
        implementations,
        usageCount: usages.length,
        usages,
      };
      if (summary.callerCount > 0 || summary.calleeCount > 0 || summary.implementationCount > 0 || summary.usageCount > 0) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  getCachedSymbolRelationSummariesForDocument(
    uri: vscode.Uri,
    range?: vscode.Range,
    limit = 500,
  ): CallGraphSymbolRelationSummary[] {
    if (this.snapshot && !this.isRustNativeIndexOnly()) {
      return this.getSymbolRelationSummariesForDocument(uri, range, limit);
    }
    const uriString = uri.toString();
    const bucket = documentSummaryBucketForUri(uriString);
    const record = this.documentSummaryBucketsByIndex.get(bucket)?.get(uriString);
    if (!record) { return []; }
    return record.symbols
      .filter((summary) => !range || range.contains(new vscode.Position(summary.symbol.range.startLine, summary.symbol.range.startColumn)))
      .slice(0, limit)
      .map((summary) => ({
        symbol: summary.symbol,
        callerCount: summary.callerCount,
        calleeCount: summary.calleeCount,
        implementationCount: summary.implementationCount,
        implementations: [],
        usageCount: summary.usageCount,
        usages: [],
      }));
  }

  private getCachedDocumentSymbols(uriString: string): CallGraphSymbol[] {
    const bucket = documentSummaryBucketForUri(uriString);
    const record = this.documentSummaryBucketsByIndex.get(bucket)?.get(uriString);
    return record?.symbols.map((summary) => summary.symbol) ?? [];
  }

  private resolveCachedRustSymbols(query: string, limit: number): CallGraphSymbol[] {
    const normalized = query.trim();
    const manifestBuiltAt = this.cacheManifest?.builtAtUnixMs;
    const cached = this.rustSymbolQueryCache.get(rustSymbolQueryCacheKey(normalized, limit));
    if (cached && cached.builtAtUnixMs === manifestBuiltAt) {
      return cached.symbols.slice(0, limit);
    }
    const lower = normalized.toLowerCase();
    const symbols: CallGraphSymbol[] = [];
    for (const bucket of this.documentSummaryBucketsByIndex.values()) {
      for (const record of bucket.values()) {
        for (const summary of record.symbols) {
          if (scoreSymbolMatch(summary.symbol, normalized, lower) > 0) {
            symbols.push(summary.symbol);
          }
        }
      }
    }
    return symbols
      .sort((a, b) =>
        scoreSymbolMatch(b, normalized, lower) - scoreSymbolMatch(a, normalized, lower) ||
        a.qualifiedName.localeCompare(b.qualifiedName))
      .slice(0, limit);
  }

  async getContextBundleResolved(symbolOrQuery: string, budget = 12_000): Promise<string> {
    const snapshot = this.snapshot;
    if (!snapshot) { return 'Call graph has not been built yet.'; }
    const symbols = this.resolveInputSymbols(symbolOrQuery);
    if (symbols.length === 0) { return `No symbol matched ${JSON.stringify(symbolOrQuery)}.`; }
    const target = symbols[0];
    const callers = (await this.getCallersResolved(target.id, 80))[0]?.edges ?? [];
    const callees = (await this.getCalleesResolved(target.id, 80))[0]?.edges ?? [];
    const index = this.getIndex(snapshot);
    const lines: string[] = [];
    lines.push(`# ${formatSymbol(target)}`);
    lines.push('');
    lines.push('## Callers');
    appendEdgeSummary(lines, callers, index.byId, 'caller');
    lines.push('');
    lines.push('## Callees');
    appendEdgeSummary(lines, callees, index.byId, 'callee');
    let text = lines.join('\n');
    if (text.length > budget) {
      text = text.slice(0, Math.max(0, budget - 80)) + '\n\n[truncated to requested budget]';
    }
    return text;
  }

  getContextBundle(symbolOrQuery: string, budget = 12_000): string {
    const snapshot = this.snapshot;
    if (!snapshot) { return 'Call graph has not been built yet.'; }
    const symbols = this.resolveInputSymbols(symbolOrQuery);
    if (symbols.length === 0) { return `No symbol matched ${JSON.stringify(symbolOrQuery)}.`; }
    const target = symbols[0];
    const callers = this.getCallers(target.id, 80)[0]?.edges ?? [];
    const callees = this.getCallees(target.id, 80)[0]?.edges ?? [];
    const index = this.getIndex(snapshot);
    const lines: string[] = [];
    lines.push(`# ${formatSymbol(target)}`);
    lines.push('');
    lines.push('## Callers');
    appendEdgeSummary(lines, callers, index.byId, 'caller');
    lines.push('');
    lines.push('## Callees');
    appendEdgeSummary(lines, callees, index.byId, 'callee');
    let text = lines.join('\n');
    if (text.length > budget) {
      text = text.slice(0, Math.max(0, budget - 80)) + '\n\n[truncated to requested budget]';
    }
    return text;
  }

  formatInfoReport(snapshot = this.snapshot): string {
    if (!snapshot) { return 'Call graph has not been built yet.'; }
    const lines = [
      'Call graph info',
      `workspace: ${snapshot.workspaceRoot}`,
      `builtAt: ${new Date(snapshot.builtAtUnixMs).toISOString()}`,
      `files: ${snapshot.stats.fileCount}`,
      `skippedFiles: ${snapshot.stats.skippedFileCount}`,
      `symbols: ${snapshot.stats.symbolCount}`,
      `callsites: ${snapshot.stats.callsiteCount}`,
      `references: ${snapshot.stats.referenceCount}`,
      `edges: ${snapshot.stats.edgeCount} exact=${snapshot.stats.exactEdgeCount} possible=${snapshot.stats.possibleEdgeCount} unresolved=${snapshot.stats.unresolvedEdgeCount}`,
      `skippedEdges: possible=${snapshot.stats.skippedPossibleEdgeCount} unresolved=${snapshot.stats.skippedUnresolvedEdgeCount} limitHit=${snapshot.stats.edgeLimitHit}`,
      `languages: ${Object.entries(snapshot.stats.languageCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      `parseConcurrency: ${snapshot.stats.parseConcurrency}`,
      snapshot.stats.minParseConcurrency !== undefined
        ? `parseConcurrencyRange: ${snapshot.stats.minParseConcurrency}-${snapshot.stats.parseConcurrency}`
        : '',
      snapshot.stats.maxHeapUsedMb !== undefined && snapshot.stats.maxHeapUsageRatio !== undefined
        ? `parseHeapMax: ${snapshot.stats.maxHeapUsedMb}MB (${formatHeapUsagePercent(snapshot.stats.maxHeapUsageRatio)}) throttles=${snapshot.stats.workerThrottleCount ?? 0}`
        : '',
      `elapsedMs: ${snapshot.stats.elapsedMs}`,
    ].filter(Boolean);
    for (const warning of snapshot.warnings.slice(0, 30)) {
      lines.push(`warning: ${warning}`);
    }
    if (snapshot.warnings.length > 30) {
      lines.push(`warning: ... ${snapshot.warnings.length - 30} more`);
    }
    return lines.join('\n');
  }

  async refreshChangedFilesForTests(uris: vscode.Uri[]): Promise<void> {
    await this.refreshChangedFiles(uris, 'test');
  }

  async reloadPersistedSnapshotForTests(): Promise<void> {
    this.snapshot = undefined;
    this.indexCache = undefined;
    this.relationSummaryCache = undefined;
    this.fileRecordsByUri.clear();
    this.cacheRecordsLoaded = false;
    this.cacheManifest = undefined;
    this.clearDocumentSummaryCache();
    await this.restorePersistedCacheManifest();
    await this.restorePersistedSnapshot();
  }

  async reloadPersistedMetadataForTests(): Promise<void> {
    this.snapshot = undefined;
    this.indexCache = undefined;
    this.relationSummaryCache = undefined;
    this.fileRecordsByUri.clear();
    this.cacheRecordsLoaded = false;
    this.cacheManifest = undefined;
    this.clearDocumentSummaryCache();
    await this.restorePersistedCacheManifest();
  }

  dropDocumentSummariesForTests(): void {
    if (this.cacheManifest) {
      this.cacheManifest = { ...this.cacheManifest, documentSummaries: [], documentSummaryFiles: [] };
    }
    this.clearDocumentSummaryCache();
  }

  async waitForDocumentSummaryMigrationForTests(): Promise<boolean> {
    if (this.documentSummaryMigrationPromise) { return this.documentSummaryMigrationPromise; }
    const pending = [...this.documentSummaryFilePromises.values()];
    if (pending.length === 0) { return false; }
    const results = await Promise.all(pending);
    return results.some(Boolean);
  }

  private async ensureRustNativeDocumentSummary(
    uri: vscode.Uri,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const uriString = uri.toString();
    if (
      !options.force &&
      !this.rustNativeDirtySummaryUris.has(uriString) &&
      this.rustNativeDocumentSummaryUris.has(uriString) &&
      this.getCachedDocumentSummaryRecord(uriString)
    ) {
      return true;
    }
    const existing = this.rustDocumentSummaryPromises.get(uriString);
    if (existing) { return existing; }
    const promise = this.doEnsureRustNativeDocumentSummary(uri).finally(() => {
      this.rustDocumentSummaryPromises.delete(uriString);
    });
    this.rustDocumentSummaryPromises.set(uriString, promise);
    return promise;
  }

  private async doEnsureRustNativeDocumentSummary(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest?.builtAtUnixMs) { return false; }
    const uriString = uri.toString();
    const symbols = await this.queryRustGraphSymbolIndex(
      folder.uri.fsPath,
      { uri: uriString, limit: 10_000 },
      manifest.builtAtUnixMs,
    );
    if (!symbols) { return false; }
    if (this.cacheManifest?.builtAtUnixMs !== manifest.builtAtUnixMs) { return false; }
    const record: CallGraphDocumentSummaryRecord = {
      uri: uri.toString(),
      relPath: symbols[0]?.relPath ?? vscode.workspace.asRelativePath(uri, false),
      symbols: symbols.map((symbol) => ({
        symbol,
        callerCount: 0,
        calleeCount: 0,
        implementationCount: Math.max(0, Math.floor(symbol.implementationCount ?? 0)),
        usageCount: Math.max(0, Math.floor(symbol.usageCount ?? 0)),
      })),
    };
    this.putDocumentSummaryRecord(record, 'rust-native');
    this.rustNativeDirtySummaryUris.delete(uriString);
    this.log.appendLine(
      `call graph rust-native document summary loaded: file=${record.relPath} ` +
      `symbols=${record.symbols.length}`,
    );
    return true;
  }

  private scheduleIncrementalRefresh(
    uri: vscode.Uri,
    reason: string,
    delayMs = CALL_GRAPH_EXTERNAL_INCREMENTAL_DEBOUNCE_MS,
  ): void {
    if (this.disposed || isCallGraphExcludedUri(uri)) { return; }
    this.pendingChangedUris.add(uri.toString());
    if (!this.incrementalReason || reason === 'saved' || this.incrementalReason.startsWith('external-')) {
      this.incrementalReason = reason;
    }
    const normalizedDelayMs = Math.max(0, delayMs);
    const flushAt = Date.now() + normalizedDelayMs;
    if (this.incrementalTimer && this.incrementalFlushAt > 0 && this.incrementalFlushAt <= flushAt) {
      return;
    }
    if (this.incrementalTimer) {
      clearTimeout(this.incrementalTimer);
    }
    this.incrementalFlushAt = flushAt;
    this.incrementalTimer = setTimeout(() => {
      this.incrementalTimer = undefined;
      this.incrementalFlushAt = 0;
      const uriStrings = Array.from(this.pendingChangedUris);
      this.pendingChangedUris.clear();
      const flushReason = this.incrementalReason || reason;
      this.incrementalReason = '';
      void this.refreshChangedFiles(uriStrings.map((value) => vscode.Uri.parse(value)), flushReason)
        .catch((err) => this.log.appendLine(`call graph incremental update failed: ${err instanceof Error ? err.message : err}`));
    }, normalizedDelayMs);
  }

  private scheduleIncrementalRefreshIfSupported(uri: vscode.Uri, reason: string, delayMs?: number): void {
    if (uri.scheme !== 'file' || !isSupportedSourceUri(uri) || isCallGraphExcludedUri(uri)) { return; }
    this.scheduleIncrementalRefresh(uri, reason, delayMs);
  }

  private shouldWatchExternalFileChanges(): boolean {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    return cfg.get<boolean>('callGraphWatchExternalFileChanges', false);
  }

  private async refreshChangedFiles(uris: vscode.Uri[], reason: string): Promise<void> {
    if (uris.length === 0 || this.disposed) { return; }
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    }
    if (this.restorePromise) {
      await this.restorePromise;
    }
    if (this.hasRustNativePrimaryGraph()) {
      if (this.incrementalPromise) {
        await this.incrementalPromise;
      }
      this.incrementalPromise = this.refreshRustNativeChangedFiles(uris, reason).finally(() => {
        this.incrementalPromise = undefined;
      });
      await this.incrementalPromise;
      return;
    }
    if (!this.snapshot) {
      await this.refreshChangedFilesWithoutSnapshot(uris, reason);
      return;
    }
    if (this.incrementalPromise) {
      await this.incrementalPromise;
    }
    this.incrementalPromise = this.doRefreshChangedFiles(uris, reason).finally(() => {
      this.incrementalPromise = undefined;
    });
    await this.incrementalPromise;
  }

  private async refreshRustNativeChangedFiles(uris: vscode.Uri[], reason: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest?.builtAtUnixMs) {
      this.log.appendLine(`call graph rust-native incremental ${reason}: no cache metadata available; skipped`);
      return;
    }
    const uniqueUris = dedupeStrings(uris.map((uri) => uri.toString()))
      .map((value) => vscode.Uri.parse(value))
      .filter((uri) => uri.scheme === 'file');
    if (uniqueUris.length === 0) { return; }
    const started = Date.now();
    let updated = false;
    try {
      updated = await this.updateRustNativeGraphIndex(folder.uri.fsPath, manifest, uniqueUris, reason);
    } catch (err) {
      this.log.appendLine(`call graph rust-native incremental ${reason} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!updated) {
      this.log.appendLine(
        `call graph rust-native incremental ${reason}: retained previous summaries for ${uniqueUris.length} changed file(s); ` +
        'run full call graph rebuild if cross-file usage looks stale',
      );
      return;
    }
    for (const uri of uniqueUris) {
      const uriString = uri.toString();
      if (isSupportedSourceUri(uri) && fs.existsSync(uri.fsPath)) {
        this.rustNativeDirtySummaryUris.add(uriString);
      } else {
        this.deleteDocumentSummaryRecord(uriString);
        this.rustNativeDirtySummaryUris.delete(uriString);
      }
    }
    this.rustSymbolQueryCache.clear();
    for (const uri of uniqueUris) {
      if (!isSupportedSourceUri(uri) || !fs.existsSync(uri.fsPath)) { continue; }
      try {
        await this.ensureRustNativeDocumentSummary(uri, { force: true });
      } catch {}
    }
    this.onDidChangeSnapshotEmitter.fire();
    this.log.appendLine(
      `call graph rust-native incremental updated: reason=${reason} files=${uniqueUris.length} ` +
      `elapsed=${Date.now() - started}ms`,
    );
  }

  private async updateRustNativeGraphIndex(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    uris: vscode.Uri[],
    reason: string,
  ): Promise<boolean> {
    const binary = await this.resolveRustGraphBinary(true);
    if (!binary) { return false; }
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const excludeMatcher = createCallGraphExcludeMatcher(cfg);
    const changedPaths: string[] = [];
    const deletedPaths: string[] = [];
    for (const uri of uris) {
      if (!isSupportedSourceUri(uri) || isUriExcludedFromCallGraph(uri, workspaceRoot, excludeMatcher) || !fs.existsSync(uri.fsPath)) {
        deletedPaths.push(uri.fsPath);
      } else {
        changedPaths.push(uri.fsPath);
      }
    }
    if (changedPaths.length === 0 && deletedPaths.length === 0) { return true; }
    const args = [
      binary,
      'graph-update',
      workspaceRoot,
      '--built-at',
      String(manifest.builtAtUnixMs),
      '--max-file-size',
      String(getConfiguredCallGraphMaxFileSize(cfg)),
      '--workers',
      String(getConfiguredCallGraphConcurrency(cfg)),
      ...changedPaths,
    ];
    for (const deletedPath of deletedPaths) {
      args.push('--delete', deletedPath);
    }
    this.log.appendLine(
      `call graph rust-native incremental start: reason=${reason} changed=${changedPaths.length} deleted=${deletedPaths.length}`,
    );
    const response = await this.invokeRustGraphJson(args) as RustGraphIndexResponse;
    if (response.type !== 'graph-index' || response.ok !== true || response.builtAtUnixMs !== manifest.builtAtUnixMs) {
      this.log.appendLine('call graph rust-native incremental skipped: unexpected zoek-rs graph-update response');
      return false;
    }
    for (const warning of response.warnings ?? []) {
      this.log.appendLine(`call graph rust-native incremental warning: ${warning}`);
    }
    return true;
  }

  private async refreshChangedFilesWithoutSnapshot(uris: vscode.Uri[], reason: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest) {
      this.log.appendLine(`call graph incremental ${reason}: no cache metadata available; skipped cold update`);
      return;
    }
    if (this.hasRustNativePrimaryGraph()) {
      await this.refreshRustNativeChangedFiles(uris, reason);
      return;
    }
    const started = Date.now();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const maxFileSize = getConfiguredCallGraphMaxFileSize(cfg);
    const parseLimits = getConfiguredCallGraphParseLimits(cfg);
    const cpuBudget = getConfiguredCallGraphCpuBudget(cfg);
    const excludeMatcher = createCallGraphExcludeMatcher(cfg);
    const uniqueUris = dedupeStrings(uris.map((uri) => uri.toString())).map((value) => vscode.Uri.parse(value));
    const previousOverrides = new Map<string, CallGraphRecordOverride>();
    for (const uri of uniqueUris) {
      const previous = await this.loadRecordOverrideForUri(folder.uri.fsPath, manifest, uri.toString());
      if (previous) {
        previousOverrides.set(uri.toString(), previous);
      }
    }
    const overrides: CallGraphRecordOverride[] = [];
    for (const uri of uniqueUris) {
      const uriString = uri.toString();
      if (!isSupportedSourceUri(uri) || isUriExcludedFromCallGraph(uri, folder.uri.fsPath, excludeMatcher)) {
        overrides.push({ uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
        continue;
      }
      try {
        const parseStarted = Date.now();
        const parsed = await parseSourceFileRecord(uri, maxFileSize, parseLimits);
        await applyCallGraphCpuBudget(Date.now() - parseStarted, cpuBudget);
        overrides.push(parsed.record
          ? { uri: uriString, record: parsed.record, updatedAtUnixMs: Date.now() }
          : { uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
      } catch {
        overrides.push({ uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
      }
    }
    await this.persistRecordOverrides(overrides);
    for (const override of overrides) {
      if (!override.record) { continue; }
      void this.persistFastDocumentSummaryFileForRecord(
        override.record,
        previousOverrides.get(override.uri)?.record,
        `incremental-${reason}-without-snapshot`,
      );
    }
    this.log.appendLine(
      `call graph incremental cold update: reason=${reason} changed=${overrides.length}/${uniqueUris.length} ` +
      `elapsed=${Date.now() - started}ms`,
    );
  }

  private async doRefreshChangedFiles(uris: vscode.Uri[], reason: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    if (!this.snapshot) {
      this.log.appendLine(`call graph incremental ${reason}: no cached graph available; rebuilding`);
      await this.rebuild();
      return;
    }
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const configSignature = getCallGraphConfigSignature(cfg);
    if (this.cacheConfigSignature && this.cacheConfigSignature !== configSignature) {
      this.log.appendLine('call graph incremental: settings changed; rebuilding full graph');
      await this.rebuild();
      return;
    }
    const started = Date.now();
    const maxFileSize = getConfiguredCallGraphMaxFileSize(cfg);
    const resolveOptions = getConfiguredCallGraphResolveOptions(cfg);
    const buildLimits = getConfiguredCallGraphBuildLimits(cfg);
    const parseConcurrency = getConfiguredCallGraphConcurrency(cfg);
    const parseLimits = getConfiguredCallGraphParseLimits(cfg);
    const cpuBudget = getConfiguredCallGraphCpuBudget(cfg);
    const excludeMatcher = createCallGraphExcludeMatcher(cfg);
    const uniqueUris = dedupeStrings(uris.map((uri) => uri.toString())).map((value) => vscode.Uri.parse(value));
    let changed = 0;
    let skipped = 0;
    const warnings: string[] = [];
    const overrides: CallGraphRecordOverride[] = [];
    for (const uri of uniqueUris) {
      const uriString = uri.toString();
      if (!isSupportedSourceUri(uri) || isUriExcludedFromCallGraph(uri, folder.uri.fsPath, excludeMatcher)) {
        if (this.snapshot.symbols.some((symbol) => symbol.uri === uriString) || this.fileRecordsByUri.delete(uriString)) {
          changed += 1;
          overrides.push({ uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
        }
        continue;
      }
      try {
        const parseStarted = Date.now();
        const parsed = await parseSourceFileRecord(uri, maxFileSize, parseLimits);
        await applyCallGraphCpuBudget(Date.now() - parseStarted, cpuBudget);
        if (parsed.record) {
          if (this.fileRecordsByUri.size > 0) {
            this.fileRecordsByUri.set(uriString, parsed.record);
          }
          changed += 1;
          overrides.push({ uri: uriString, record: parsed.record, updatedAtUnixMs: Date.now() });
        } else {
          skipped += 1;
          if (this.snapshot.symbols.some((symbol) => symbol.uri === uriString) || this.fileRecordsByUri.delete(uriString)) {
            changed += 1;
            overrides.push({ uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
          }
        }
        warnings.push(...parsed.warnings);
      } catch (err) {
        if (this.fileRecordsByUri.size > 0) {
          this.fileRecordsByUri.delete(uriString);
        }
        changed += 1;
        overrides.push({ uri: uriString, deleted: true, updatedAtUnixMs: Date.now() });
        warnings.push(`failed to refresh ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (changed === 0 && warnings.length === 0) { return; }
    const { snapshot, index } = await this.buildIncrementalSnapshotFromOverrides({
      baseSnapshot: this.snapshot,
      workspaceRoot: folder.uri.fsPath,
      overrides,
      skippedFileCount: skipped,
      warnings,
      started,
      parseConcurrency,
      resolveOptions,
    });
    this.applySnapshot(snapshot, index, undefined, configSignature, { preserveRecords: true });
    await this.persistRecordOverrides(overrides);
    await this.persistDocumentSummaryFilesForRecords(overrides
      .map((override) => override.record)
      .filter((record): record is CallGraphFileRecord => !!record), snapshot, index);
    this.log.appendLine(
      `call graph incremental updated: reason=${reason} changed=${changed}/${uniqueUris.length} ` +
      `files=${snapshot.stats.fileCount} symbols=${snapshot.stats.symbolCount} edges=${snapshot.stats.edgeCount} ` +
      `elapsed=${snapshot.stats.elapsedMs}ms`,
    );
  }

  private async buildIncrementalSnapshotFromOverrides(input: {
    baseSnapshot: CallGraphSnapshot;
    workspaceRoot: string;
    overrides: CallGraphRecordOverride[];
    skippedFileCount: number;
    warnings: string[];
    started: number;
    parseConcurrency: number;
    adaptiveStats?: CallGraphAdaptiveConcurrencyStats;
    resolveOptions: CallGraphResolveOptions;
  }): Promise<{ snapshot: CallGraphSnapshot; index: SymbolIndex }> {
    const changedUris = new Set(input.overrides.map((override) => override.uri));
    const newRecords = input.overrides
      .map((override) => override.record)
      .filter((record): record is CallGraphFileRecord => !!record);
    const newSymbols = newRecords.flatMap((record) => record.parsed.symbols).map(stripMutableSymbol);
    const retainedSymbols = input.baseSnapshot.symbols.filter((symbol) => !changedUris.has(symbol.uri));
    const symbols = [...retainedSymbols, ...newSymbols];
    const bindingRecords = this.fileRecordsByUri.size > 0
      ? Array.from(this.fileRecordsByUri.values())
      : newRecords;
    const index = buildSymbolIndex(symbols, bindingRecords.flatMap((record) => record.parsed.bindings));
    const validSymbolIds = new Set(symbols.map((symbol) => symbol.id));
    const references = dedupeReferences([
      ...input.baseSnapshot.references.filter((reference) =>
        !changedUris.has(reference.uri) && validSymbolIds.has(reference.symbolId)),
      ...resolveReferenceCandidates(
        newRecords.flatMap((record) => record.parsed.referenceCandidates),
        symbols,
        index,
      ),
    ]);
    const calls = newRecords.flatMap((record) => record.parsed.calls);
    const resolvedCalls = await resolveCallsAsync(calls, index, {
      resolveOptions: input.resolveOptions,
    });
    const edges = dedupeEdges([
      ...input.baseSnapshot.edges.filter((edge) =>
        !changedUris.has(edge.callsite.uri) &&
        validSymbolIds.has(edge.callerId) &&
        (!edge.calleeId || validSymbolIds.has(edge.calleeId))),
      ...resolvedCalls.edges,
    ]);
    const languageCounts: Record<CallGraphLanguage, number> = {
      python: 0,
      java: 0,
      kotlin: 0,
      typescript: 0,
      javascript: 0,
      graphql: 0,
    };
    for (const symbol of symbols) {
      languageCounts[symbol.language] += 1;
    }
    const removedCallsites = input.baseSnapshot.edges
      .filter((edge) => changedUris.has(edge.callsite.uri))
      .map(edgeLocationKey);
    const callsiteCount = Math.max(0, input.baseSnapshot.stats.callsiteCount - new Set(removedCallsites).size + calls.length);
    const warnings = dedupeStrings([
      ...input.baseSnapshot.warnings,
      ...input.warnings,
      ...newRecords.flatMap((record) => record.parsed.warnings),
      ...(resolvedCalls.edgeLimitHit
        ? [`call graph unique edge limit reached at ${input.resolveOptions.maxEdges}; skipped additional materialized edges`]
        : []),
    ]);
    const snapshot: CallGraphSnapshot = {
      workspaceRoot: input.workspaceRoot,
      builtAtUnixMs: Date.now(),
      symbols,
      edges,
      references,
      warnings,
      stats: {
        fileCount: new Set(symbols.map((symbol) => symbol.uri)).size,
        symbolCount: symbols.length,
        edgeCount: edges.length,
        exactEdgeCount: edges.filter((edge) => edge.confidence === 'exact' || edge.confidence === 'resolved').length,
        possibleEdgeCount: edges.filter((edge) => edge.confidence === 'possible').length,
        unresolvedEdgeCount: edges.filter((edge) => edge.confidence === 'unresolved').length,
        languageCounts,
        elapsedMs: Date.now() - input.started,
        parseConcurrency: input.parseConcurrency,
        minParseConcurrency: input.adaptiveStats?.minObservedConcurrency,
        workerThrottleCount: input.adaptiveStats?.throttleCount,
        maxHeapUsedMb: input.adaptiveStats?.maxHeapUsedMb,
        maxHeapUsageRatio: input.adaptiveStats?.maxHeapUsageRatio,
        skippedFileCount: input.baseSnapshot.stats.skippedFileCount + input.skippedFileCount,
        callsiteCount,
        skippedPossibleEdgeCount: input.baseSnapshot.stats.skippedPossibleEdgeCount + resolvedCalls.skippedPossibleEdgeCount,
        skippedUnresolvedEdgeCount: input.baseSnapshot.stats.skippedUnresolvedEdgeCount + resolvedCalls.skippedUnresolvedEdgeCount,
        edgeLimitHit: input.baseSnapshot.stats.edgeLimitHit || resolvedCalls.edgeLimitHit,
        referenceCount: references.length,
      },
    };
    return { snapshot, index };
  }

  private async restorePersistedCacheManifest(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const configSignature = getCallGraphConfigSignature(cfg);
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheManifestUri(folder.uri.fsPath));
      const inflated = await gunzipAsync(Buffer.from(raw));
      const manifest = JSON.parse(inflated.toString('utf8')) as Partial<CallGraphCacheManifest>;
      if (
        manifest.version !== CALL_GRAPH_CACHE_VERSION ||
        manifest.workspaceRoot !== folder.uri.fsPath ||
        manifest.configSignature !== configSignature ||
        !Array.isArray(manifest.chunks)
      ) {
        this.log.appendLine('call graph cache ignored: version, workspace, or settings changed; persisted files preserved until explicit rebuild');
        return;
      }
      if (!Array.isArray(manifest.recordIndex)) {
        this.log.appendLine('call graph cache ignored: missing record index; persisted files preserved until explicit rebuild');
        return;
      }
      if (!Array.isArray(manifest.symbolRelations)) {
        this.log.appendLine('call graph cache metadata loaded without symbol relation buckets; derived relation cache will rebuild lazily');
      }
      this.cacheManifest = manifest as CallGraphCacheManifest;
      this.cacheConfigSignature = configSignature;
      this.cacheRecordsLoaded = false;
      const stats = this.cacheManifest.snapshot?.stats;
      const cachedAt = new Date(this.cacheManifest.builtAtUnixMs).toISOString();
      if (stats) {
        this.log.appendLine(
          `call graph cache metadata loaded: files=${stats.fileCount} symbols=${stats.symbolCount} ` +
          `edges=${stats.edgeCount} references=${stats.referenceCount} recordChunks=${this.cacheManifest.chunks.length} ` +
          `recordIndex=${this.cacheManifest.recordIndex?.length ?? 0} ` +
          `recordOverrides=${this.cacheManifest.recordOverrides?.length ?? 0} ` +
          `snapshotChunks=${countSnapshotChunks(this.cacheManifest)} symbolRelationBuckets=${countSymbolRelationBuckets(this.cacheManifest)} ` +
          `documentSummaryBuckets=${countDocumentSummaryBuckets(this.cacheManifest)} ` +
          `documentSummaryFiles=${countDocumentSummaryFiles(this.cacheManifest)} ` +
          `cachedAt=${cachedAt} restore=lazy`,
        );
      } else {
        this.log.appendLine(
          `call graph cache metadata loaded: recordChunks=${this.cacheManifest.chunks.length} ` +
          `recordIndex=${this.cacheManifest.recordIndex?.length ?? 0} ` +
          `recordOverrides=${this.cacheManifest.recordOverrides?.length ?? 0} ` +
          `symbolRelationBuckets=${countSymbolRelationBuckets(this.cacheManifest)} ` +
          `documentSummaryBuckets=${countDocumentSummaryBuckets(this.cacheManifest)} documentSummaryFiles=${countDocumentSummaryFiles(this.cacheManifest)} ` +
          `cachedAt=${cachedAt} restore=records-fallback`,
        );
      }
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (code !== 'FileNotFound') {
        this.log.appendLine(`call graph cache metadata skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async deleteLegacyCacheDirs(workspaceRoot: string): Promise<void> {
    let deleted = 0;
    for (let version = 1; version < CALL_GRAPH_CACHE_VERSION; version++) {
      if (await this.deleteCacheDir(workspaceRoot, version)) {
        deleted += 1;
      }
    }
    if (deleted > 0) {
      this.log.appendLine(`call graph legacy cache deleted: dirs=${deleted} currentVersion=${CALL_GRAPH_CACHE_VERSION}`);
    }
  }

  private async deleteCacheDir(workspaceRoot: string, version: number): Promise<boolean> {
    try {
      await vscode.workspace.fs.delete(this.cacheDirUriForVersion(workspaceRoot, version), {
        recursive: true,
        useTrash: false,
      });
      return true;
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (code !== 'FileNotFound') {
        this.log.appendLine(`call graph cache delete failed: v${version} ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
  }

  private async restorePersistedSnapshot(): Promise<void> {
    if (this.snapshot) { return; }
    if (this.snapshotRestorePromise) {
      await this.snapshotRestorePromise;
      return;
    }
    this.snapshotRestorePromise = this.doRestorePersistedSnapshot().finally(() => {
      this.snapshotRestorePromise = undefined;
    });
    await this.snapshotRestorePromise;
  }

  private async doRestorePersistedSnapshot(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest) { return; }
    const started = Date.now();
    try {
      if (manifest.snapshot) {
        const [symbols, edges, references] = await Promise.all([
          this.readCacheArrayChunks<CallGraphSymbol>(folder.uri.fsPath, manifest.snapshot.symbols),
          this.readCacheArrayChunks<CallGraphEdge>(folder.uri.fsPath, manifest.snapshot.edges),
          this.readCacheArrayChunks<CallGraphReference>(folder.uri.fsPath, manifest.snapshot.references),
        ]);
        const snapshot: CallGraphSnapshot = {
          workspaceRoot: manifest.workspaceRoot,
          builtAtUnixMs: manifest.snapshot.builtAtUnixMs,
          symbols,
          edges,
          references,
          stats: manifest.snapshot.stats,
          warnings: manifest.snapshot.warnings,
        };
        const restored = await this.applyPersistedRecordOverridesToSnapshot(snapshot, folder.uri.fsPath, manifest);
        this.applySnapshot(restored.snapshot, restored.index, undefined, manifest.configSignature);
        this.log.appendLine(
          `call graph snapshot restored: files=${restored.snapshot.stats.fileCount} symbols=${restored.snapshot.stats.symbolCount} ` +
          `edges=${restored.snapshot.stats.edgeCount} references=${restored.snapshot.stats.referenceCount} snapshotChunks=${countSnapshotChunks(manifest)} ` +
          `recordOverrides=${manifest.recordOverrides?.length ?? 0} ` +
          `elapsed=${Date.now() - started}ms cachedAt=${new Date(manifest.builtAtUnixMs).toISOString()} mode=direct`,
        );
        return;
      }
      const records = await this.loadCacheRecords(folder.uri.fsPath, manifest);
      const { snapshot, index } = await buildSnapshotFromFileRecords({
        workspaceRoot: folder.uri.fsPath,
        records,
        skippedFileCount: 0,
        warnings: [],
        started,
        parseConcurrency: getConfiguredCallGraphConcurrency(),
        resolveOptions: getConfiguredCallGraphResolveOptions(),
      });
      this.applySnapshot(snapshot, index, records, manifest.configSignature);
      this.log.appendLine(
        `call graph cache restored: files=${snapshot.stats.fileCount} symbols=${snapshot.stats.symbolCount} ` +
        `edges=${snapshot.stats.edgeCount} records=${records.length} elapsed=${snapshot.stats.elapsedMs}ms ` +
        `cachedAt=${new Date(manifest.builtAtUnixMs).toISOString()} mode=records-fallback`,
      );
    } catch (err) {
      this.log.appendLine(`call graph snapshot restore skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async applyPersistedRecordOverridesToSnapshot(
    snapshot: CallGraphSnapshot,
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
  ): Promise<{ snapshot: CallGraphSnapshot; index: SymbolIndex | undefined }> {
    if (isRustNativeIndexOnlySnapshot(snapshot) || isRustNativeGraphManifest(manifest)) {
      if ((manifest.recordOverrides?.length ?? 0) > 0) {
        this.log.appendLine(
          `call graph rust-native restore ignored JS record overrides: overrides=${manifest.recordOverrides?.length ?? 0}`,
        );
      }
      return { snapshot, index: undefined };
    }
    const overrides = await this.loadRecordOverrides(workspaceRoot, manifest);
    if (overrides.length === 0) {
      return { snapshot, index: undefined };
    }
    const started = Date.now();
    const { snapshot: updatedSnapshot, index } = await this.buildIncrementalSnapshotFromOverrides({
      baseSnapshot: snapshot,
      workspaceRoot,
      overrides,
      skippedFileCount: 0,
      warnings: [],
      started,
      parseConcurrency: getConfiguredCallGraphConcurrency(),
      resolveOptions: getConfiguredCallGraphResolveOptions(),
    });
    this.log.appendLine(
      `call graph record overrides applied: overrides=${overrides.length} elapsed=${Date.now() - started}ms`,
    );
    return { snapshot: updatedSnapshot, index };
  }

  private async ensureCachedRecordsLoaded(): Promise<boolean> {
    if (this.fileRecordsByUri.size > 0) {
      this.cacheRecordsLoaded = true;
      return true;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest || manifest.chunks.length === 0) { return false; }
    const started = Date.now();
    try {
      const records = await this.loadCacheRecords(folder.uri.fsPath, manifest);
      this.fileRecordsByUri.clear();
      for (const record of records) {
        this.fileRecordsByUri.set(record.uri, record);
      }
      this.cacheRecordsLoaded = true;
      this.indexCache = undefined;
      this.log.appendLine(
        `call graph record cache loaded: records=${records.length} chunks=${manifest.chunks.length} elapsed=${Date.now() - started}ms`,
      );
      return true;
    } catch (err) {
      this.log.appendLine(`call graph record cache load skipped: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async ensureSymbolRelationBucketLoaded(
    workspaceRoot: string,
    bucket: number,
    chunks: CallGraphSymbolRelationChunk[],
  ): Promise<void> {
    if (this.symbolRelationLoadedBuckets.has(bucket)) { return; }
    const existing = this.symbolRelationBucketPromises.get(bucket);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.doLoadSymbolRelationBucket(workspaceRoot, bucket, chunks).finally(() => {
      this.symbolRelationBucketPromises.delete(bucket);
    });
    this.symbolRelationBucketPromises.set(bucket, promise);
    await promise;
  }

  private async doLoadSymbolRelationBucket(
    workspaceRoot: string,
    bucket: number,
    chunks: CallGraphSymbolRelationChunk[],
  ): Promise<void> {
    const chunk = chunks.find((entry) => entry.bucket === bucket);
    if (!chunk) {
      this.symbolRelationLoadedBuckets.add(bucket);
      return;
    }
    const started = Date.now();
    try {
      const records = await this.readCacheArrayChunk<CallGraphSymbolRelationRecord>(workspaceRoot, chunk);
      let bucketRecords = this.symbolRelationBucketsByIndex.get(bucket);
      if (!bucketRecords) {
        bucketRecords = new Map<string, CallGraphSymbolRelationRecord>();
        this.symbolRelationBucketsByIndex.set(bucket, bucketRecords);
      }
      for (const record of records) {
        bucketRecords.set(record.symbolId, record);
      }
      this.symbolRelationLoadedBuckets.add(bucket);
      this.log.appendLine(
        `call graph symbol relation bucket loaded: bucket=${bucket} symbols=${records.length} elapsed=${Date.now() - started}ms`,
      );
    } catch (err) {
      this.log.appendLine(`call graph symbol relation load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getCachedSymbolRelationRecord(symbolId: string): CallGraphSymbolRelationRecord | undefined {
    return this.symbolRelationBucketsByIndex.get(symbolRelationBucketForSymbolId(symbolId))?.get(symbolId);
  }

  private async ensureDocumentSummaryBucketLoaded(
    workspaceRoot: string,
    bucket: number,
    chunks: CallGraphDocumentSummaryChunk[],
  ): Promise<void> {
    if (this.documentSummaryLoadedBuckets.has(bucket)) { return; }
    const existing = this.documentSummaryBucketPromises.get(bucket);
    if (existing) {
      await existing;
      return;
    }
    const promise = this.doLoadDocumentSummaryBucket(workspaceRoot, bucket, chunks).finally(() => {
      this.documentSummaryBucketPromises.delete(bucket);
    });
    this.documentSummaryBucketPromises.set(bucket, promise);
    await promise;
  }

  private async doLoadDocumentSummaryBucket(
    workspaceRoot: string,
    bucket: number,
    chunks: CallGraphDocumentSummaryChunk[],
  ): Promise<void> {
    const chunk = chunks.find((entry) => entry.bucket === bucket);
    if (!chunk) {
      this.documentSummaryLoadedBuckets.add(bucket);
      return;
    }
    const started = Date.now();
    try {
      const records = await this.readCacheArrayChunk<CallGraphDocumentSummaryRecord>(workspaceRoot, chunk);
      let bucketRecords = this.documentSummaryBucketsByIndex.get(bucket);
      if (!bucketRecords) {
        bucketRecords = new Map<string, CallGraphDocumentSummaryRecord>();
        this.documentSummaryBucketsByIndex.set(bucket, bucketRecords);
      }
      for (const record of records) {
        if (this.rustNativeDirtySummaryUris.has(record.uri)) { continue; }
        bucketRecords.set(record.uri, record);
        this.rustNativeDocumentSummaryUris.delete(record.uri);
      }
      this.documentSummaryLoadedBuckets.add(bucket);
      this.log.appendLine(
        `call graph document summary bucket loaded: bucket=${bucket} files=${records.length} elapsed=${Date.now() - started}ms`,
      );
    } catch (err) {
      this.log.appendLine(`call graph document summary load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadDocumentSummaryFile(
    workspaceRoot: string,
    chunk: CallGraphDocumentSummaryFileChunk,
  ): Promise<void> {
    const started = Date.now();
    try {
      const records = await this.readCacheArrayChunk<CallGraphDocumentSummaryRecord>(workspaceRoot, chunk);
      for (const record of records) {
        this.putDocumentSummaryRecord(record);
      }
      this.log.appendLine(
        `call graph document summary file loaded: uri=${chunk.uri} records=${records.length} elapsed=${Date.now() - started}ms`,
      );
    } catch (err) {
      this.log.appendLine(`call graph document summary file load skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async persistFastDocumentSummaryFileForRecord(
    record: CallGraphFileRecord,
    previousRecord: CallGraphFileRecord | undefined,
    reason: string,
  ): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest) { return false; }
    if (this.hasRustNativePrimaryGraph()) {
      this.log.appendLine(`call graph document summary fast update skipped for rust-native graph: reason=${reason} file=${record.relPath}`);
      return false;
    }
    const started = Date.now();
    try {
      const existing = await this.loadDocumentSummaryRecordForUri(folder.uri.fsPath, manifest, record.uri);
      const summaryRecord = await buildFastDocumentSummaryRecord(record, existing, previousRecord);
      await this.persistDocumentSummaryFileRecord(folder.uri.fsPath, manifest, summaryRecord, started);
      this.log.appendLine(
        `call graph document summary file fast updated: reason=${reason} file=${record.relPath} ` +
        `symbols=${summaryRecord.symbols.length} elapsed=${Date.now() - started}ms`,
      );
      this.onDidChangeSnapshotEmitter.fire();
      return true;
    } catch (err) {
      this.log.appendLine(`call graph document summary file fast update failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async loadDocumentSummaryRecordForUri(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    uriString: string,
  ): Promise<CallGraphDocumentSummaryRecord | undefined> {
    const cached = this.getCachedDocumentSummaryRecord(uriString);
    if (cached) { return cached; }
    const fileChunk = findDocumentSummaryFileChunk(manifest, uriString);
    if (fileChunk) {
      await this.loadDocumentSummaryFile(workspaceRoot, fileChunk);
      return this.getCachedDocumentSummaryRecord(uriString);
    }
    const chunks = manifest.documentSummaries;
    if (Array.isArray(chunks) && chunks.length > 0) {
      await this.ensureDocumentSummaryBucketLoaded(workspaceRoot, documentSummaryBucketForUri(uriString), chunks);
      return this.getCachedDocumentSummaryRecord(uriString);
    }
    return undefined;
  }

  private getCachedDocumentSummaryRecord(uriString: string): CallGraphDocumentSummaryRecord | undefined {
    return this.documentSummaryBucketsByIndex.get(documentSummaryBucketForUri(uriString))?.get(uriString);
  }

  private ensureDocumentSummaryFileFromSnapshot(uri: vscode.Uri, reason: string): Promise<boolean> {
    const uriString = uri.toString();
    const existing = this.documentSummaryFilePromises.get(uriString);
    if (existing) { return existing; }
    const promise = this.doEnsureDocumentSummaryFileFromSnapshot(uri, reason).finally(() => {
      this.documentSummaryFilePromises.delete(uriString);
    });
    this.documentSummaryFilePromises.set(uriString, promise);
    return promise;
  }

  private async doEnsureDocumentSummaryFileFromSnapshot(uri: vscode.Uri, reason: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest?.snapshot) { return false; }
    if (isRustNativeGraphManifest(manifest)) { return false; }
    const uriString = uri.toString();
    const started = Date.now();
    this.log.appendLine(
      `call graph document summary file migration started: reason=${reason} file=${vscode.workspace.asRelativePath(uri, false)} ` +
      `cachedAt=${new Date(manifest.builtAtUnixMs).toISOString()}`,
    );
    try {
      const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
      const parsed = await parseSourceFileRecord(
        uri,
        getConfiguredCallGraphMaxFileSize(cfg),
        getConfiguredCallGraphParseLimits(cfg),
      );
      if (!parsed.record) { return false; }
      const symbols = parsed.record.parsed.symbols
        .filter((symbol) => isCallableSymbol(symbol) || isTypeSymbol(symbol) || isReferenceableSymbol(symbol))
        .map(stripMutableSymbol);
      if (symbols.length === 0) {
        const record: CallGraphDocumentSummaryRecord = { uri: uriString, relPath: parsed.record.relPath, symbols: [] };
        await this.persistDocumentSummaryFileRecord(folder.uri.fsPath, manifest, record, started);
        return true;
      }
      const targetIds = new Set(symbols.map((symbol) => symbol.id));
      const relationIndex = await this.buildRelationSummaryIndexForSymbolIds(folder.uri.fsPath, manifest, targetIds);
      await this.mergeRecordOverrideRelationsForSymbolIds(folder.uri.fsPath, manifest, targetIds, relationIndex);
      const implementationCounts = await this.buildImplementationCountsForSymbols(folder.uri.fsPath, manifest, symbols);
      const record = buildDocumentSummaryRecordForSymbols(
        uriString,
        parsed.record.relPath,
        symbols,
        relationIndex,
        implementationCounts,
      );
      await this.persistDocumentSummaryFileRecord(folder.uri.fsPath, manifest, record, started);
      this.onDidChangeSnapshotEmitter.fire();
      return true;
    } catch (err) {
      this.log.appendLine(`call graph document summary file migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async buildRelationSummaryIndexForSymbolIds(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    symbolIds: Set<string>,
  ): Promise<RelationSummaryIndex> {
    const callersBySymbolId = new Map<string, Set<string>>();
    const calleesBySymbolId = new Map<string, Set<string>>();
    const usagesBySymbolId = new Map<string, CallGraphReference[]>();
    const usageKeysBySymbolId = new Map<string, Set<string>>();
    const pushUsage = (reference: CallGraphReference) => {
      if (!symbolIds.has(reference.symbolId)) { return; }
      const key = referenceLocationKey(reference);
      let keys = usageKeysBySymbolId.get(reference.symbolId);
      if (!keys) {
        keys = new Set<string>();
        usageKeysBySymbolId.set(reference.symbolId, keys);
      }
      if (keys.has(key)) { return; }
      keys.add(key);
      pushMap(usagesBySymbolId, reference.symbolId, reference);
    };
    await this.visitCacheArrayChunks<CallGraphEdge>(workspaceRoot, manifest.snapshot?.edges ?? [], async (edges) => {
      for (const edge of edges) {
        const locationKey = edgeLocationKey(edge);
        if (edge.calleeId && symbolIds.has(edge.calleeId)) {
          addSetValue(callersBySymbolId, edge.calleeId, locationKey);
          pushUsage(callsiteReferenceFromEdge(edge, edge.calleeId));
        }
        if (symbolIds.has(edge.callerId)) {
          addSetValue(calleesBySymbolId, edge.callerId, locationKey);
        }
      }
    });
    await this.visitCacheArrayChunks<CallGraphReference>(workspaceRoot, manifest.snapshot?.references ?? [], async (references) => {
      for (const reference of references) {
        pushUsage(reference);
      }
    });
    return { callersBySymbolId, calleesBySymbolId, usagesBySymbolId };
  }

  private async mergeRecordOverrideRelationsForSymbolIds(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    symbolIds: Set<string>,
    relationIndex: RelationSummaryIndex,
  ): Promise<void> {
    const overrides = await this.loadRecordOverrides(workspaceRoot, manifest);
    const records = overrides
      .map((override) => override.record)
      .filter((record): record is CallGraphFileRecord => !!record);
    if (records.length === 0) { return; }
    const overriddenUris = new Set(overrides.map((override) => override.uri));
    const baseSymbols = await this.readCacheArrayChunks<CallGraphSymbol>(workspaceRoot, manifest.snapshot?.symbols ?? []);
    const symbols = [
      ...baseSymbols.filter((symbol) => !overriddenUris.has(symbol.uri)),
      ...records.flatMap((record) => record.parsed.symbols).map(stripMutableSymbol),
    ];
    const index = buildSymbolIndex(symbols, records.flatMap((record) => record.parsed.bindings));
    const references = resolveReferenceCandidates(
      records.flatMap((record) => record.parsed.referenceCandidates),
      symbols,
      index,
    );
    const resolvedCalls = await resolveCallsAsync(records.flatMap((record) => record.parsed.calls), index, {
      resolveOptions: getConfiguredCallGraphResolveOptions(),
    });
    mergeRelationSummaryIndex(
      relationIndex,
      buildRelationSummaryIndexForSymbolIdsFromArrays(resolvedCalls.edges, references, symbolIds),
    );
  }

  private async buildImplementationCountsForSymbols(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    symbols: CallGraphSymbol[],
  ): Promise<Map<string, number>> {
    const targets = symbols.filter(shouldCheckImplementationCount);
    const counts = new Map<string, number>();
    if (targets.length === 0) { return counts; }
    const allSymbols: CallGraphSymbol[] = [];
    await this.visitCacheArrayChunks<CallGraphSymbol>(workspaceRoot, manifest.snapshot?.symbols ?? [], async (chunkSymbols) => {
      allSymbols.push(...chunkSymbols);
    });
    const byId = new Map(allSymbols.map((symbol) => [symbol.id, symbol]));
    for (const symbol of symbols) {
      byId.set(symbol.id, symbol);
    }
    const index = buildSymbolIndex([...byId.values()]);
    for (const symbol of targets) {
      counts.set(symbol.id, findImplementationSymbols(symbol, index, 20).length);
    }
    return counts;
  }

  private async persistDocumentSummaryFileRecord(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    record: CallGraphDocumentSummaryRecord,
    started: number,
  ): Promise<void> {
    let saved = false;
    const write = async () => {
      const currentManifest = this.cacheManifest;
      if (!currentManifest || currentManifest.builtAtUnixMs !== manifest.builtAtUnixMs) {
        this.log.appendLine('call graph document summary file migration skipped: cache manifest changed before write');
        return;
      }
      let totalBytes = 0;
      const chunk = await this.writeDocumentSummaryFileRecord(workspaceRoot, record, (bytes) => { totalBytes += bytes; });
      const existing = (currentManifest.documentSummaryFiles ?? [])
        .filter((entry) => entry.uri !== record.uri && entry.uriHash !== chunk.uriHash);
      const updatedManifest: CallGraphCacheManifest = {
        ...currentManifest,
        documentSummaryFiles: [...existing, chunk],
      };
      const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(updatedManifest), 'utf8'));
      totalBytes += encodedManifest.byteLength;
      await vscode.workspace.fs.writeFile(this.cacheManifestUri(workspaceRoot), encodedManifest);
      this.cacheManifest = updatedManifest;
      this.putDocumentSummaryRecord(record);
      this.log.appendLine(
        `call graph document summary file migration completed: file=${record.relPath} symbols=${record.symbols.length} ` +
        `elapsed=${Date.now() - started}ms bytes=${totalBytes}`,
      );
      saved = true;
    };
    this.cacheWritePromise = this.cacheWritePromise.then(write, write);
    await this.cacheWritePromise;
    if (!saved) {
      throw new Error('document summary file was not saved');
    }
  }

  private migrateDocumentSummaryCacheFromSnapshot(reason: string): Promise<boolean> {
    if (this.documentSummaryMigrationPromise) { return this.documentSummaryMigrationPromise; }
    this.documentSummaryMigrationPromise = this.doMigrateDocumentSummaryCacheFromSnapshot(reason).finally(() => {
      this.documentSummaryMigrationPromise = undefined;
    });
    return this.documentSummaryMigrationPromise;
  }

  private async doMigrateDocumentSummaryCacheFromSnapshot(reason: string): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest?.snapshot) { return false; }
    if (isRustNativeGraphManifest(manifest)) { return false; }
    if (Array.isArray(manifest.documentSummaries) && manifest.documentSummaries.length > 0) { return true; }
    const started = Date.now();
    this.log.appendLine(
      `call graph document summary migration started: reason=${reason} snapshotChunks=${countSnapshotChunks(manifest)} ` +
      `cachedAt=${new Date(manifest.builtAtUnixMs).toISOString()}`,
    );
    try {
      const [symbols, edges, references] = await Promise.all([
        this.readCacheArrayChunks<CallGraphSymbol>(folder.uri.fsPath, manifest.snapshot.symbols),
        this.readCacheArrayChunks<CallGraphEdge>(folder.uri.fsPath, manifest.snapshot.edges),
        this.readCacheArrayChunks<CallGraphReference>(folder.uri.fsPath, manifest.snapshot.references),
      ]);
      if (this.cacheManifest !== manifest) {
        this.log.appendLine('call graph document summary migration skipped: cache manifest changed during migration');
        return false;
      }
      const snapshot: CallGraphSnapshot = {
        workspaceRoot: manifest.workspaceRoot,
        builtAtUnixMs: manifest.snapshot.builtAtUnixMs,
        symbols,
        edges,
        references,
        stats: manifest.snapshot.stats,
        warnings: manifest.snapshot.warnings,
      };
      const index = buildSymbolIndex(symbols);
      const relationIndex = buildRelationSummaryIndex(edges, references);
      const documentSummaryRecords = await buildDocumentSummaryRecords(snapshot, index, relationIndex);
      let migrated = false;
      const write = async () => {
        let totalBytes = 0;
        if (this.cacheManifest !== manifest) {
          this.log.appendLine('call graph document summary migration skipped: cache manifest changed before manifest write');
          return;
        }
        const documentSummaries = await this.writeDocumentSummaryBuckets(
          folder.uri.fsPath,
          documentSummaryRecords,
          (bytes) => { totalBytes += bytes; },
        );
        if (this.cacheManifest !== manifest) {
          this.log.appendLine('call graph document summary migration skipped: cache manifest changed during summary write');
          return;
        }
        const updatedManifest: CallGraphCacheManifest = {
          ...manifest,
          documentSummaries,
        };
        const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(updatedManifest), 'utf8'));
        totalBytes += encodedManifest.byteLength;
        await vscode.workspace.fs.writeFile(this.cacheManifestUri(folder.uri.fsPath), encodedManifest);
        this.cacheManifest = updatedManifest;
        this.replaceDocumentSummaryCache(documentSummaryRecords);
        this.log.appendLine(
          `call graph document summary migration completed: files=${documentSummaryRecords.length} ` +
          `buckets=${documentSummaries.length} elapsed=${Date.now() - started}ms bytes=${totalBytes}`,
        );
        this.onDidChangeSnapshotEmitter.fire();
        migrated = true;
      };
      this.cacheWritePromise = this.cacheWritePromise.then(write, write);
      await this.cacheWritePromise;
      return migrated;
    } catch (err) {
      this.log.appendLine(`call graph document summary migration failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async loadCacheRecords(workspaceRoot: string, manifest: CallGraphCacheManifest): Promise<CallGraphFileRecord[]> {
    const records = await this.readCacheArrayChunks<CallGraphFileRecord>(workspaceRoot, manifest.chunks);
    const overrides = await this.loadRecordOverrides(workspaceRoot, manifest);
    if (overrides.length === 0) { return records; }
    const byUri = new Map(records.map((record) => [record.uri, record]));
    for (const override of overrides) {
      if (override.deleted || !override.record) {
        byUri.delete(override.uri);
      } else {
        byUri.set(override.uri, override.record);
      }
    }
    return [...byUri.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private async loadRecordOverrides(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
  ): Promise<CallGraphRecordOverride[]> {
    const chunks = manifest.recordOverrides ?? [];
    if (chunks.length === 0) { return []; }
    const overrides = await this.readCacheArrayChunks<CallGraphRecordOverride>(workspaceRoot, chunks);
    return overrides.sort((a, b) => a.updatedAtUnixMs - b.updatedAtUnixMs);
  }

  private async loadRecordOverrideForUri(
    workspaceRoot: string,
    manifest: CallGraphCacheManifest,
    uriString: string,
  ): Promise<CallGraphRecordOverride | undefined> {
    const uriHash = stableHash(uriString);
    const chunk = manifest.recordOverrides?.find((entry) => entry.uri === uriString || entry.uriHash === uriHash);
    if (!chunk) { return undefined; }
    return (await this.readCacheArrayChunk<CallGraphRecordOverride>(workspaceRoot, chunk))[0];
  }

  private async readCacheArrayChunk<T>(workspaceRoot: string, chunk: CallGraphCacheChunk): Promise<T[]> {
    if (!chunk.file) { return []; }
    const chunkRaw = await vscode.workspace.fs.readFile(this.cacheChunkUri(workspaceRoot, chunk.file));
    const chunkInflated = await gunzipAsync(Buffer.from(chunkRaw));
    const parsed = JSON.parse(chunkInflated.toString('utf8')) as T[];
    return Array.isArray(parsed) ? parsed : [];
  }

  private async readCacheArrayChunks<T>(workspaceRoot: string, chunks: CallGraphCacheChunk[]): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of chunks) {
      out.push(...await this.readCacheArrayChunk<T>(workspaceRoot, chunk));
    }
    return out;
  }

  private async visitCacheArrayChunks<T>(
    workspaceRoot: string,
    chunks: CallGraphCacheChunk[],
    visitor: (items: T[]) => void | Promise<void>,
  ): Promise<void> {
    for (const chunk of chunks) {
      const items = await this.readCacheArrayChunk<T>(workspaceRoot, chunk);
      if (items.length > 0) {
        await visitor(items);
      }
      await yieldToExtensionHost();
    }
  }

  private applySnapshot(
    snapshot: CallGraphSnapshot,
    index: SymbolIndex | undefined,
    records: CallGraphFileRecord[] | undefined,
    configSignature: string,
    options: { preserveRecords?: boolean } = {},
  ): void {
    this.snapshot = snapshot;
    this.indexCache = index ? { snapshot, index } : undefined;
    this.relationSummaryCache = undefined;
    if (!options.preserveRecords) {
      this.fileRecordsByUri.clear();
    }
    this.clearDocumentSummaryCache();
    if (records) {
      this.fileRecordsByUri.clear();
      for (const record of records) {
        this.fileRecordsByUri.set(record.uri, record);
      }
      this.cacheRecordsLoaded = true;
    } else if (!options.preserveRecords) {
      this.cacheRecordsLoaded = false;
    }
    this.cacheConfigSignature = configSignature;
    this.clearSymbolRelationCache();
    this.onDidChangeSnapshotEmitter.fire();
  }

  private clearSymbolRelationCache(): void {
    this.symbolRelationBucketsByIndex.clear();
    this.symbolRelationLoadedBuckets.clear();
    this.symbolRelationBucketPromises.clear();
  }

  private clearDocumentSummaryCache(): void {
    this.documentSummaryBucketsByIndex.clear();
    this.documentSummaryLoadedBuckets.clear();
    this.documentSummaryBucketPromises.clear();
    this.documentSummaryFilePromises.clear();
    this.rustDocumentSummaryPromises.clear();
    this.rustSymbolQueryCache.clear();
    this.rustNativeDocumentSummaryUris.clear();
    this.rustNativeDirtySummaryUris.clear();
  }

  private async persistCache(
    snapshot: CallGraphSnapshot,
    recordIndex: CallGraphRecordIndexEntry[],
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const workspaceRoot = folder.uri.fsPath;
    const configSignature = this.cacheConfigSignature ?? getCallGraphConfigSignature();
    const write = async () => {
      try {
        const cacheDir = this.cacheDirUri(workspaceRoot);
        await vscode.workspace.fs.createDirectory(cacheDir);
        const chunks: CallGraphCacheManifest['chunks'] = [];
        let totalBytes = 0;
        const snapshotChunks = {
          symbols: await this.writeCacheArrayChunks(
            workspaceRoot,
            'snapshot-symbols',
            snapshot.symbols,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
          edges: await this.writeCacheArrayChunks(
            workspaceRoot,
            'snapshot-edges',
            snapshot.edges,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
          references: await this.writeCacheArrayChunks(
            workspaceRoot,
            'snapshot-references',
            snapshot.references,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
        };
        const manifest: CallGraphCacheManifest = {
          version: CALL_GRAPH_CACHE_VERSION,
          workspaceRoot,
          configSignature,
          builtAtUnixMs: snapshot.builtAtUnixMs,
          chunks,
          recordIndex,
          snapshot: {
            builtAtUnixMs: snapshot.builtAtUnixMs,
            stats: snapshot.stats,
            warnings: snapshot.warnings,
            ...snapshotChunks,
          },
        };
        const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(manifest), 'utf8'));
        totalBytes += encodedManifest.byteLength;
        await vscode.workspace.fs.writeFile(this.cacheManifestUri(workspaceRoot), encodedManifest);
        this.cacheManifest = manifest;
        this.cacheRecordsLoaded = false;
        this.log.appendLine(
          `call graph symbol-first cache saved: files=${recordIndex.length} recordChunks=${chunks.length} ` +
          `snapshotChunks=${countSnapshotChunks(manifest)} bytes=${totalBytes}; derived relation cache scheduled`,
        );
        this.scheduleDerivedCallGraphCacheWrite(snapshot, workspaceRoot, configSignature, snapshot.builtAtUnixMs);
      } catch (err) {
        this.log.appendLine(`call graph cache save skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const cacheWrite = this.cacheWritePromise.then(write, write);
    this.cacheWritePromise = cacheWrite;
    await cacheWrite;
  }

  private scheduleDerivedCallGraphCacheWrite(
    snapshot: CallGraphSnapshot,
    workspaceRoot: string,
    configSignature: string,
    builtAtUnixMs: number,
  ): void {
    const write = async () => {
      const started = Date.now();
      try {
        const currentManifest = this.cacheManifest;
        if (!currentManifest || currentManifest.configSignature !== configSignature || currentManifest.builtAtUnixMs !== builtAtUnixMs) {
          this.log.appendLine('call graph derived cache skipped: cache manifest changed before start');
          return;
        }
        let totalBytes = 0;
        const relationIndex = buildRelationSummaryIndex(snapshot.edges, snapshot.references);
        const index = this.indexCache?.snapshot === snapshot ? this.indexCache.index : buildSymbolIndex(snapshot.symbols);
        const documentSummaryRecords = await buildDocumentSummaryRecords(snapshot, index, relationIndex);
        const documentSummaries = await this.writeDocumentSummaryBuckets(
          workspaceRoot,
          documentSummaryRecords,
          (bytes) => { totalBytes += bytes; },
        );
        const symbolRelationRecords = buildSymbolRelationRecords(relationIndex);
        const symbolRelations = await this.writeSymbolRelationBuckets(
          workspaceRoot,
          symbolRelationRecords,
          (bytes) => { totalBytes += bytes; },
        );
        const rustGraph = await this.writeRustGraphIndex(workspaceRoot, symbolRelationRecords, builtAtUnixMs);
        const manifest = this.cacheManifest;
        if (!manifest || manifest.configSignature !== configSignature || manifest.builtAtUnixMs !== builtAtUnixMs) {
          this.log.appendLine('call graph derived cache skipped: cache manifest changed before commit');
          return;
        }
        const updatedManifest: CallGraphCacheManifest = {
          ...manifest,
          symbolRelations,
          documentSummaries,
        };
        const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(updatedManifest), 'utf8'));
        totalBytes += encodedManifest.byteLength;
        await vscode.workspace.fs.writeFile(this.cacheManifestUri(workspaceRoot), encodedManifest);
        this.cacheManifest = updatedManifest;
        if (this.snapshot === snapshot) {
          this.relationSummaryCache = { snapshot, index: relationIndex };
          this.replaceDocumentSummaryCache(documentSummaryRecords);
          this.onDidChangeSnapshotEmitter.fire();
        }
        this.log.appendLine(
          `call graph derived cache saved: symbolRelationBuckets=${symbolRelations.length} ` +
          `documentSummaryBuckets=${documentSummaries.length} documentSummaryFiles=${documentSummaryRecords.length} ` +
          `${rustGraph ? `rustGraphSymbols=${rustGraph.symbolCount} rustGraphRefs=${rustGraph.referenceCount} ` : ''}` +
          `elapsed=${Date.now() - started}ms bytes=${totalBytes}`,
        );
      } catch (err) {
        this.log.appendLine(`call graph derived cache save skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const derivedWrite = this.cacheWritePromise.then(write, write);
    this.cacheWritePromise = derivedWrite;
    void derivedWrite.catch(() => undefined);
  }

  private async writeRustGraphIndex(
    workspaceRoot: string,
    records: CallGraphSymbolRelationRecord[],
    builtAtUnixMs: number,
  ): Promise<{ symbolCount: number; referenceCount: number; bytes: number } | undefined> {
    const binary = await this.resolveRustGraphBinary(true);
    if (!binary) {
      this.log.appendLine('call graph rust graph index skipped: zoek-rs binary unavailable');
      return undefined;
    }
    const cacheDir = this.cacheDirUri(workspaceRoot).fsPath;
    const exportPath = path.join(cacheDir, `graph-relations-${builtAtUnixMs}.tsv`);
    try {
      await this.writeRustGraphRelationExport(exportPath, records);
      const response = await this.invokeRustGraphJson([
        binary,
        'graph-index',
        workspaceRoot,
        '--input',
        exportPath,
        '--built-at',
        String(builtAtUnixMs),
      ]) as RustGraphIndexResponse;
      if (response.type !== 'graph-index' || response.ok !== true || response.builtAtUnixMs !== builtAtUnixMs) {
        this.log.appendLine('call graph rust graph index skipped: unexpected zoek-rs response');
        return undefined;
      }
      for (const warning of response.warnings ?? []) {
        this.log.appendLine(`call graph rust graph index warning: ${warning}`);
      }
      return {
        symbolCount: response.symbolCount ?? 0,
        referenceCount: response.referenceCount ?? 0,
        bytes: response.bytes ?? 0,
      };
    } catch (err) {
      this.log.appendLine(`call graph rust graph index skipped: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      try { await vscode.workspace.fs.delete(vscode.Uri.file(exportPath), { useTrash: false }); } catch {}
    }
  }

  private async queryRustGraphUsageIndex(
    workspaceRoot: string,
    symbolId: string,
    limit: number,
    builtAtUnixMs: number,
  ): Promise<CallGraphReference[] | undefined> {
    const binary = await this.resolveRustGraphBinary(false);
    if (!binary) { return undefined; }
    try {
      const response = await this.invokeRustGraphJson([
        binary,
        'graph-query',
        workspaceRoot,
        '--symbol-id',
        symbolId,
        '--limit',
        String(Math.max(1, Math.floor(limit))),
      ]) as RustGraphQueryResponse;
      if (
        response.type !== 'graph-query' ||
        response.ok !== true ||
        response.builtAtUnixMs !== builtAtUnixMs ||
        !Array.isArray(response.references)
      ) {
        return undefined;
      }
      for (const warning of response.warnings ?? []) {
        this.log.appendLine(`call graph rust graph query warning: ${warning}`);
      }
      return response.references.map((reference) => ({
        symbolId,
        name: String(reference.name ?? ''),
        rawText: String(reference.rawText ?? ''),
        uri: String(reference.uri ?? ''),
        relPath: String(reference.relPath ?? ''),
        range: normalizeGraphRange(reference.range),
        ...(reference.enclosingSymbolId ? { enclosingSymbolId: String(reference.enclosingSymbolId) } : {}),
      }));
    } catch (err) {
      this.log.appendLine(`call graph rust graph query skipped: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async queryRustGraphSymbolIndex(
    workspaceRoot: string,
    input: { query?: string; uri?: string; limit: number },
    builtAtUnixMs: number,
  ): Promise<(CallGraphSymbol & { usageCount?: number; implementationCount?: number })[] | undefined> {
    const binary = await this.resolveRustGraphBinary(false);
    if (!binary) { return undefined; }
    const args = [
      binary,
      'graph-symbol-query',
      workspaceRoot,
      '--limit',
      String(Math.max(1, Math.floor(input.limit))),
    ];
    if (input.uri) {
      args.push('--uri', input.uri);
    } else {
      args.push('--query', input.query ?? '');
    }
    try {
      const response = await this.invokeRustGraphJson(args) as RustGraphSymbolQueryResponse;
      if (
        response.type !== 'graph-symbol-query' ||
        response.ok !== true ||
        response.builtAtUnixMs !== builtAtUnixMs ||
        !Array.isArray(response.symbols)
      ) {
        return undefined;
      }
      for (const warning of response.warnings ?? []) {
        this.log.appendLine(`call graph rust graph symbol query warning: ${warning}`);
      }
      return response.symbols.map(rustGraphSymbolToCallGraphSymbol);
    } catch (err) {
      this.log.appendLine(`call graph rust graph symbol query skipped: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async resolveRustGraphBinary(allowBuild: boolean): Promise<string | undefined> {
    const existing = this.findRustGraphBinary();
    if (existing || !allowBuild) { return existing; }
    if (this.rustGraphBuildPromise) { return this.rustGraphBuildPromise; }
    const cargoToml = path.join(this.context.extensionUri.fsPath, 'Cargo.toml');
    if (!fs.existsSync(cargoToml)) { return undefined; }
    this.rustGraphBuildPromise = (async () => {
      try {
        this.log.appendLine('call graph rust graph index: building zoek-rs binary');
        await this.invokeRustGraphText(['cargo', 'build', '-q', '-p', 'zoek-rs']);
        const binary = this.findRustGraphBinary();
        if (binary) {
          this.log.appendLine(`call graph rust graph index: zoek-rs binary ready: ${binary}`);
        }
        return binary;
      } catch (err) {
        this.log.appendLine(`call graph rust graph index build skipped: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      } finally {
        this.rustGraphBuildPromise = undefined;
      }
    })();
    return this.rustGraphBuildPromise;
  }

  private findRustGraphBinary(): string | undefined {
    const exeSuffix = process.platform === 'win32' ? '.exe' : '';
    const extensionRoot = this.context.extensionUri.fsPath;
    const candidates = [
      path.join(extensionRoot, 'target', 'debug', `zoek-rs${exeSuffix}`),
      path.join(extensionRoot, 'target', 'release', `zoek-rs${exeSuffix}`),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  private invokeRustGraphJson(
    args: string[],
    options: RustGraphInvokeOptions = {},
  ): Promise<unknown> {
    return this.invokeRustGraphText(args, options).then((stdout) => {
      try {
        return JSON.parse(stdout.trim());
      } catch (err) {
        throw new Error(`failed to parse zoek-rs graph response: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private invokeRustGraphText(
    args: string[],
    options: RustGraphInvokeOptions = {},
  ): Promise<string> {
    const [command, ...rest] = args;
    const kind = this.classifyRustGraphProcess(rest);
    const timeoutMs = options.timeoutMs ?? this.defaultRustGraphTimeoutMs(kind);
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, {
        argv0: this.argv0ForRustGraphProcess(kind),
        cwd: this.context.extensionUri.fsPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const tracked = this.trackRustGraphChild(
        child,
        [path.basename(command), ...rest.slice(0, 2)].join(' '),
        kind,
      );
      let stdout = '';
      let stderr = '';
      let stderrLineBuffer = '';
      let settled = false;
      let forcedError: Error | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let tokenSub: { dispose(): void } = { dispose() {} };
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        tokenSub.dispose();
        if (tracked.killTimer) {
          clearTimeout(tracked.killTimer);
          tracked.killTimer = undefined;
        }
        this.rustGraphChildren.delete(tracked.id);
      };
      const finish = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        cleanup();
        fn();
      };
      const requestCancel = (reason: string, error: Error) => {
        if (!forcedError) {
          forcedError = error;
        }
        this.terminateRustGraphChild(tracked, reason);
      };
      tokenSub = options.token?.onCancellationRequested(() => {
        requestCancel('request cancelled', options.cancelError ?? new Error('zoek-rs graph command cancelled'));
      }) ?? { dispose() {} };
      if (options.token?.isCancellationRequested) {
        requestCancel('request cancelled', options.cancelError ?? new Error('zoek-rs graph command cancelled'));
      }
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          requestCancel(
            `timeout after ${timeoutMs}ms`,
            new Error(`zoek-rs graph command timed out after ${timeoutMs}ms: ${tracked.label}`),
          );
        }, timeoutMs);
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        stderr += text;
        if (!options.onStderrLine) { return; }
        stderrLineBuffer += text;
        const lines = stderrLineBuffer.split(/\r?\n/);
        stderrLineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) { options.onStderrLine(line); }
        }
      });
      child.on('error', (err) => {
        finish(() => reject(err));
      });
      child.on('close', (code, signal) => {
        if (options.onStderrLine && stderrLineBuffer.trim()) {
          options.onStderrLine(stderrLineBuffer);
          stderrLineBuffer = '';
        }
        if (forcedError) {
          finish(() => reject(forcedError));
          return;
        }
        if (code !== 0) {
          finish(() => reject(new Error(
            stderr.trim() ||
            stdout.trim() ||
            (signal ? `${command} terminated by ${signal}` : `${command} exited with code ${code}`),
          )));
          return;
        }
        try {
          finish(() => resolve(stdout));
        } catch (err) {
          finish(() => reject(err));
        }
      });
    });
  }

  private trackRustGraphChild(
    child: ChildProcess,
    label: string,
    kind: RustGraphProcessKind,
  ): RustGraphTrackedChild {
    const tracked: RustGraphTrackedChild = {
      id: this.nextRustGraphChildId++,
      child,
      label,
      kind,
      cancelled: false,
      killTimer: undefined,
    };
    this.rustGraphChildren.set(tracked.id, tracked);
    return tracked;
  }

  private classifyRustGraphProcess(rest: string[]): RustGraphProcessKind {
    if (rest[0] === 'build') { return 'build'; }
    switch (rest[0]) {
      case 'graph-rebuild': return 'graph-rebuild';
      case 'graph-update': return 'graph-update';
      case 'graph-index': return 'graph-index';
      case 'graph-query': return 'graph-query';
      case 'graph-symbol-query': return 'graph-symbol-query';
      default: return 'other';
    }
  }

  private argv0ForRustGraphProcess(kind: RustGraphProcessKind): string | undefined {
    switch (kind) {
      case 'build': return 'ijss-rust-graph-build';
      case 'graph-rebuild': return 'ijss-rust-graph-rebuild';
      case 'graph-update': return 'ijss-rust-graph-update';
      case 'graph-index': return 'ijss-rust-graph-index';
      case 'graph-query': return 'ijss-rust-graph-query';
      case 'graph-symbol-query': return 'ijss-rust-graph-symbol-query';
      default: return undefined;
    }
  }

  private defaultRustGraphTimeoutMs(kind: RustGraphProcessKind): number {
    switch (kind) {
      case 'graph-query':
      case 'graph-symbol-query':
        return RUST_GRAPH_QUERY_TIMEOUT_MS;
      default:
        return 0;
    }
  }

  private cancelRustGraphProcesses(
    reason: string,
    options?: { kinds?: Iterable<RustGraphProcessKind> },
  ): void {
    const kinds = options?.kinds ? new Set(options.kinds) : undefined;
    for (const tracked of this.rustGraphChildren.values()) {
      if (kinds && !kinds.has(tracked.kind)) { continue; }
      this.terminateRustGraphChild(tracked, reason);
    }
  }

  private terminateRustGraphChild(tracked: RustGraphTrackedChild, reason: string): void {
    if (tracked.cancelled) { return; }
    tracked.cancelled = true;
    const pid = tracked.child.pid;
    this.log.appendLine(
      `call graph rust process cancel: ${tracked.label}${typeof pid === 'number' ? ` pid=${pid}` : ''} ` +
      `kind=${tracked.kind} (${reason})`,
    );
    try {
      if (process.platform === 'win32') {
        tracked.child.kill('SIGTERM');
      } else if (typeof pid === 'number' && pid > 0) {
        process.kill(-pid, 'SIGTERM');
      } else {
        tracked.child.kill('SIGTERM');
      }
    } catch {
      try { tracked.child.kill('SIGTERM'); } catch {}
    }
    tracked.killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          tracked.child.kill('SIGKILL');
        } else if (typeof pid === 'number' && pid > 0) {
          process.kill(-pid, 'SIGKILL');
        } else {
          tracked.child.kill('SIGKILL');
        }
      } catch {}
    }, RUST_GRAPH_PROCESS_KILL_TIMEOUT_MS);
  }

  private async writeRustGraphRelationExport(
    exportPath: string,
    records: CallGraphSymbolRelationRecord[],
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(exportPath, { encoding: 'utf8' });
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) { return; }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const done = () => {
        if (settled) { return; }
        settled = true;
        resolve();
      };
      stream.on('error', fail);
      stream.on('finish', done);
      void (async () => {
        try {
          for (const record of records) {
            for (const reference of record.usages) {
              if (!stream.write(formatRustGraphReferenceTsvLine(record.symbolId, reference))) {
                await new Promise<void>((resume) => stream.once('drain', resume));
              }
            }
            await yieldToExtensionHost();
          }
          stream.end();
        } catch (err) {
          stream.destroy();
          fail(err);
        }
      })();
    });
  }

  private async persistRecordOverrides(overrides: CallGraphRecordOverride[]): Promise<void> {
    if (overrides.length === 0) { return; }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !this.cacheManifest) { return; }
    const write = async () => {
      const manifest = this.cacheManifest;
      if (!manifest) { return; }
      const started = Date.now();
      let totalBytes = 0;
      const chunks: CallGraphRecordOverrideChunk[] = [];
      for (const override of overrides) {
        const chunk = await this.writeRecordOverride(folder.uri.fsPath, override, (bytes) => { totalBytes += bytes; });
        chunks.push(chunk);
      }
      const overridden = new Set(chunks.map((chunk) => chunk.uriHash));
      const existing = (manifest.recordOverrides ?? []).filter((chunk) => !overridden.has(chunk.uriHash));
      const recordIndex = Array.isArray(manifest.recordIndex)
        ? applyRecordOverridesToRecordIndex(manifest.recordIndex, overrides)
        : undefined;
      const updatedManifest: CallGraphCacheManifest = {
        ...manifest,
        recordOverrides: [...existing, ...chunks],
        ...(recordIndex ? { recordIndex } : {}),
      };
      const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(updatedManifest), 'utf8'));
      totalBytes += encodedManifest.byteLength;
      await vscode.workspace.fs.writeFile(this.cacheManifestUri(folder.uri.fsPath), encodedManifest);
      this.cacheManifest = updatedManifest;
      this.log.appendLine(
        `call graph incremental cache saved: overrides=${chunks.length} totalOverrides=${updatedManifest.recordOverrides?.length ?? 0} ` +
        `elapsed=${Date.now() - started}ms bytes=${totalBytes}`,
      );
    };
    this.cacheWritePromise = this.cacheWritePromise.then(write, write);
    await this.cacheWritePromise;
  }

  private async persistDocumentSummaryFilesForRecords(
    records: CallGraphFileRecord[],
    snapshot: CallGraphSnapshot,
    index: SymbolIndex,
  ): Promise<void> {
    const manifest = this.cacheManifest;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!manifest || !folder || records.length === 0) { return; }
    const targetSymbols = records
      .flatMap((record) => record.parsed.symbols)
      .map(stripMutableSymbol)
      .filter((symbol) => isCallableSymbol(symbol) || isTypeSymbol(symbol) || isReferenceableSymbol(symbol));
    const targetIds = new Set(targetSymbols.map((symbol) => symbol.id));
    const relationIndex = buildRelationSummaryIndexForSymbolIdsFromArrays(snapshot.edges, snapshot.references, targetIds);
    const implementationCounts = new Map<string, number>();
    for (const symbol of targetSymbols.filter(shouldCheckImplementationCount)) {
      implementationCounts.set(symbol.id, findImplementationSymbols(symbol, index, 20).length);
    }
    for (const record of records) {
      const symbols = record.parsed.symbols
        .map(stripMutableSymbol)
        .filter((symbol) => isCallableSymbol(symbol) || isTypeSymbol(symbol) || isReferenceableSymbol(symbol));
      const summaryRecord = buildDocumentSummaryRecordForSymbols(
        record.uri,
        record.relPath,
        symbols,
        relationIndex,
        implementationCounts,
      );
      await this.persistDocumentSummaryFileRecord(folder.uri.fsPath, manifest, summaryRecord, Date.now());
    }
  }

  private async writeRecordOverride(
    workspaceRoot: string,
    override: CallGraphRecordOverride,
    onBytes: (bytes: number) => void,
  ): Promise<CallGraphRecordOverrideChunk> {
    const uriHash = stableHash(override.uri);
    const file = `record-override-${uriHash}.json.gz`;
    const encoded = await gzipAsync(Buffer.from(JSON.stringify([override]), 'utf8'));
    onBytes(encoded.byteLength);
    await vscode.workspace.fs.writeFile(this.cacheChunkUri(workspaceRoot, file), encoded);
    return { uri: override.uri, uriHash, updatedAtUnixMs: override.updatedAtUnixMs, file, count: 1 };
  }

  private async writeSymbolRelationBuckets(
    workspaceRoot: string,
    records: CallGraphSymbolRelationRecord[],
    onBytes: (bytes: number) => void,
  ): Promise<CallGraphSymbolRelationChunk[]> {
    const buckets = new Map<number, CallGraphSymbolRelationRecord[]>();
    for (const record of records) {
      const bucket = symbolRelationBucketForSymbolId(record.symbolId);
      const bucketRecords = buckets.get(bucket) ?? [];
      bucketRecords.push(record);
      buckets.set(bucket, bucketRecords);
    }
    const chunks: CallGraphSymbolRelationChunk[] = [];
    for (const [bucket, bucketRecords] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      bucketRecords.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
      const file = `symbol-relations-${bucket}.json.gz`;
      const encoded = await gzipAsync(Buffer.from(JSON.stringify(bucketRecords), 'utf8'));
      onBytes(encoded.byteLength);
      await vscode.workspace.fs.writeFile(this.cacheChunkUri(workspaceRoot, file), encoded);
      chunks.push({ bucket, file, count: bucketRecords.length });
      await yieldToExtensionHost();
    }
    return chunks;
  }

  private async writeDocumentSummaryBuckets(
    workspaceRoot: string,
    records: CallGraphDocumentSummaryRecord[],
    onBytes: (bytes: number) => void,
  ): Promise<CallGraphDocumentSummaryChunk[]> {
    const buckets = new Map<number, CallGraphDocumentSummaryRecord[]>();
    for (const record of records) {
      const bucket = documentSummaryBucketForUri(record.uri);
      const bucketRecords = buckets.get(bucket) ?? [];
      bucketRecords.push(record);
      buckets.set(bucket, bucketRecords);
    }
    const chunks: CallGraphDocumentSummaryChunk[] = [];
    for (const [bucket, bucketRecords] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      bucketRecords.sort((a, b) => a.relPath.localeCompare(b.relPath));
      const file = `document-summaries-${bucket}.json.gz`;
      const encoded = await gzipAsync(Buffer.from(JSON.stringify(bucketRecords), 'utf8'));
      onBytes(encoded.byteLength);
      await vscode.workspace.fs.writeFile(this.cacheChunkUri(workspaceRoot, file), encoded);
      chunks.push({ bucket, file, count: bucketRecords.length });
      await yieldToExtensionHost();
    }
    return chunks;
  }

  private async writeDocumentSummaryFileRecord(
    workspaceRoot: string,
    record: CallGraphDocumentSummaryRecord,
    onBytes: (bytes: number) => void,
  ): Promise<CallGraphDocumentSummaryFileChunk> {
    const uriHash = stableHash(record.uri);
    const file = `document-summary-file-${uriHash}.json.gz`;
    const encoded = await gzipAsync(Buffer.from(JSON.stringify([record]), 'utf8'));
    onBytes(encoded.byteLength);
    await vscode.workspace.fs.writeFile(this.cacheChunkUri(workspaceRoot, file), encoded);
    return { uri: record.uri, uriHash, file, count: 1 };
  }

  private replaceDocumentSummaryCache(records: CallGraphDocumentSummaryRecord[]): void {
    this.clearDocumentSummaryCache();
    for (const record of records) {
      this.putDocumentSummaryRecord(record);
    }
  }

  private deleteDocumentSummaryRecord(uriString: string): void {
    const bucket = documentSummaryBucketForUri(uriString);
    this.documentSummaryBucketsByIndex.get(bucket)?.delete(uriString);
    this.rustNativeDocumentSummaryUris.delete(uriString);
  }

  private putDocumentSummaryRecord(
    record: CallGraphDocumentSummaryRecord,
    source: 'cache' | 'rust-native' = 'cache',
  ): void {
    if (source !== 'rust-native' && this.rustNativeDirtySummaryUris.has(record.uri)) {
      return;
    }
    const bucket = documentSummaryBucketForUri(record.uri);
    let bucketRecords = this.documentSummaryBucketsByIndex.get(bucket);
    if (!bucketRecords) {
      bucketRecords = new Map<string, CallGraphDocumentSummaryRecord>();
      this.documentSummaryBucketsByIndex.set(bucket, bucketRecords);
    }
    bucketRecords.set(record.uri, record);
    if (source === 'rust-native') {
      this.rustNativeDocumentSummaryUris.add(record.uri);
    } else {
      this.rustNativeDocumentSummaryUris.delete(record.uri);
    }
  }

  private async writeCacheArrayChunks<T>(
    workspaceRoot: string,
    prefix: string,
    items: T[],
    chunkSize: number,
    onBytes: (bytes: number) => void,
  ): Promise<CallGraphCacheChunk[]> {
    const chunks: CallGraphCacheChunk[] = [];
    for (let offset = 0; offset < items.length; offset += chunkSize) {
      const chunk = items.slice(offset, offset + chunkSize);
      const file = `${prefix}-${Math.floor(offset / chunkSize)}.json.gz`;
      const encoded = await gzipAsync(Buffer.from(JSON.stringify(chunk), 'utf8'));
      onBytes(encoded.byteLength);
      await vscode.workspace.fs.writeFile(this.cacheChunkUri(workspaceRoot, file), encoded);
      chunks.push({ file, count: chunk.length });
      await yieldToExtensionHost();
    }
    return chunks;
  }

  private cacheDirUri(workspaceRoot: string): vscode.Uri {
    return this.cacheDirUriForVersion(workspaceRoot, CALL_GRAPH_CACHE_VERSION);
  }

  private cacheDirUriForVersion(workspaceRoot: string, version: number): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, `callgraph-${stableHash(workspaceRoot)}-v${version}`);
  }

  private cacheManifestUri(workspaceRoot: string): vscode.Uri {
    return vscode.Uri.joinPath(this.cacheDirUri(workspaceRoot), 'manifest.json.gz');
  }

  private cacheChunkUri(workspaceRoot: string, filename: string): vscode.Uri {
    return vscode.Uri.joinPath(this.cacheDirUri(workspaceRoot), filename);
  }

  private applyRecordOverridesToLoadedRecords(overrides: CallGraphRecordOverride[]): void {
    if (!this.cacheRecordsLoaded && this.fileRecordsByUri.size === 0) { return; }
    for (const override of overrides) {
      if (override.deleted || !override.record) {
        this.fileRecordsByUri.delete(override.uri);
      } else {
        this.fileRecordsByUri.set(override.uri, override.record);
      }
    }
  }

  private async persistRecordIndexFromLoadedRecordsIfMissing(): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest || Array.isArray(manifest.recordIndex) || this.fileRecordsByUri.size === 0) {
      return false;
    }
    const started = Date.now();
    const recordIndex = buildRecordIndexFromRecords([...this.fileRecordsByUri.values()]);
    const write = async () => {
      const current = this.cacheManifest;
      if (!current || current.builtAtUnixMs !== manifest.builtAtUnixMs || Array.isArray(current.recordIndex)) {
        return;
      }
      const updatedManifest: CallGraphCacheManifest = { ...current, recordIndex };
      const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(updatedManifest), 'utf8'));
      await vscode.workspace.fs.writeFile(this.cacheManifestUri(folder.uri.fsPath), encodedManifest);
      this.cacheManifest = updatedManifest;
      this.log.appendLine(
        `call graph record index migrated: files=${recordIndex.length} elapsed=${Date.now() - started}ms bytes=${encodedManifest.byteLength}`,
      );
    };
    this.cacheWritePromise = this.cacheWritePromise.then(write, write);
    await this.cacheWritePromise;
    return Array.isArray(this.cacheManifest?.recordIndex);
  }

  private async clearForForceRebuild(workspaceRoot: string): Promise<void> {
    try { await this.cacheWritePromise; } catch {}
    if (this.snapshotRestorePromise) {
      try { await this.snapshotRestorePromise; } catch {}
    }
    this.snapshot = undefined;
    this.indexCache = undefined;
    this.relationSummaryCache = undefined;
    this.fileRecordsByUri.clear();
    this.cacheRecordsLoaded = false;
    this.cacheManifest = undefined;
    this.cacheConfigSignature = undefined;
    this.clearSymbolRelationCache();
    this.clearDocumentSummaryCache();
    const deleted = await this.deleteCacheDir(workspaceRoot, CALL_GRAPH_CACHE_VERSION);
    this.log.appendLine(
      `call graph force rebuild: ${deleted ? 'deleted previous cache' : 'no previous cache to delete'} ` +
      `currentVersion=${CALL_GRAPH_CACHE_VERSION}`,
    );
  }

  private async rebuildInWorkerProcess(input: {
    workspaceRoot: string;
    excludeGlobs: string[];
    maxFileSize: number;
    buildLimits: CallGraphBuildLimits;
    parseConcurrency: number;
    resolveOptions: CallGraphResolveOptions;
    parseLimits: CallGraphParseLimits;
    cpuBudget: CallGraphCpuBudget;
    configSignature: string;
    nodePath: string;
    report?: (progress: CallGraphRebuildProgress) => void;
    token?: vscode.CancellationToken;
  }): Promise<CallGraphSnapshot> {
    const workerPath = path.join(this.context.extensionUri.fsPath, 'out', 'callGraphWorkerProcess.js');
    if (!fs.existsSync(workerPath)) {
      throw new Error(`call graph worker bundle is missing: ${workerPath}`);
    }
    const cacheDirFsPath = this.cacheDirUri(input.workspaceRoot).fsPath;
    await fs.promises.mkdir(cacheDirFsPath, { recursive: true });
    const heapMb = Math.max(512, Math.min(32_768, Math.floor(input.buildLimits.memoryBudgetMb)));
    const runtime = resolveCallGraphWorkerRuntime(workerPath, heapMb, input.nodePath);
    this.log.appendLine(
      `call graph worker start: hostPid=${process.pid} heap=${heapMb}MB workers=${input.parseConcurrency} ` +
      `runtime=${runtime.source} command=${runtime.command} args=${JSON.stringify(runtime.args)}`,
    );
    const result = await new Promise<CallGraphWorkerRebuildResult>((resolve, reject) => {
      const child = spawn(runtime.command, runtime.args, {
        argv0: 'ijss-callgraph-worker',
        cwd: this.context.extensionUri.fsPath,
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      this.log.appendLine(
        `call graph worker spawned: hostPid=${process.pid} workerPid=${child.pid ?? 'unknown'} ` +
        `argv0=ijss-callgraph-worker`,
      );
      let stderr = '';
      let stdout = '';
      let finished = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        tokenSub.dispose();
      };
      const finish = (fn: () => void) => {
        if (finished) { return; }
        finished = true;
        cleanup();
        fn();
      };
      const terminate = () => {
        if (child.killed) { return; }
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2_000);
      };
      const tokenSub = input.token?.onCancellationRequested(() => {
        terminate();
        finish(() => reject(new CallGraphRebuildCancelledError()));
      }) ?? { dispose() {} };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        stderr += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            this.log.appendLine(`call graph worker stderr: ${line}`);
          }
        }
      });
      child.on('message', (message: unknown) => {
        const msg = message as {
          type?: string;
          progress?: CallGraphRebuildProgress;
          result?: CallGraphWorkerRebuildResult;
          error?: string;
          pid?: number;
          ppid?: number;
          title?: string;
          argv0?: string;
          execPath?: string;
          execArgv?: string[];
          heapLimitMb?: number;
          heapUsedMb?: number;
        };
        if (msg.type === 'ready') {
          this.log.appendLine(
            `call graph worker ready: hostPid=${process.pid} workerPid=${msg.pid ?? 'unknown'} ` +
            `workerPpid=${msg.ppid ?? 'unknown'} title=${JSON.stringify(msg.title ?? '')} ` +
            `argv0=${JSON.stringify(msg.argv0 ?? '')} execPath=${JSON.stringify(msg.execPath ?? '')} ` +
            `execArgv=${JSON.stringify(msg.execArgv ?? [])} heap=${msg.heapUsedMb ?? 'unknown'}/${msg.heapLimitMb ?? 'unknown'}MB`,
          );
          if (heapMb > 4_096 && Number.isFinite(msg.heapLimitMb) && (msg.heapLimitMb ?? 0) < heapMb * 0.8) {
            terminate();
            finish(() => reject(new Error(
              `call graph worker heap flag was not applied: requested=${heapMb}MB actualLimit=${msg.heapLimitMb}MB ` +
              `runtime=${runtime.source} command=${runtime.command}. Set intellijStyledSearch.callGraphNodePath to a real Node.js executable.`,
            )));
          }
          return;
        }
        if (msg.type === 'progress' && msg.progress) {
          input.report?.(msg.progress);
          return;
        }
        if (msg.type === 'done' && msg.result) {
          finish(() => resolve(msg.result!));
          return;
        }
        if (msg.type === 'error') {
          finish(() => reject(new Error(msg.error || 'call graph worker failed')));
        }
      });
      child.on('error', (err) => {
        finish(() => reject(err));
      });
      child.on('close', (code, signal) => {
        if (finished) { return; }
        const details = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
        finish(() => reject(new Error(`call graph worker exited before completion: ${details}`)));
      });
      child.send?.({
        type: 'rebuild',
        input: {
          workspaceRoot: input.workspaceRoot,
          cacheDirFsPath,
          configSignature: input.configSignature,
          excludeGlobs: input.excludeGlobs,
          maxFileSize: input.maxFileSize,
          buildLimits: input.buildLimits,
          parseConcurrency: input.parseConcurrency,
          resolveOptions: input.resolveOptions,
          parseLimits: input.parseLimits,
          cpuBudget: input.cpuBudget,
        } satisfies CallGraphWorkerRebuildInput,
      });
    });

    this.log.appendLine(
      `call graph worker done: files=${result.stats.fileCount} symbols=${result.stats.symbolCount} ` +
      `edges=${result.stats.edgeCount} references=${result.stats.referenceCount} ` +
      `recordIndex=${result.recordIndexCount} snapshotChunks=${result.snapshotChunkCount} ` +
      `symbolRelationBuckets=${result.symbolRelationBucketCount} documentSummaryBuckets=${result.documentSummaryBucketCount} ` +
      `cacheBytes=${result.cacheBytes} elapsed=${result.stats.elapsedMs}ms`,
    );
    this.snapshot = undefined;
    this.indexCache = undefined;
    this.relationSummaryCache = undefined;
    this.fileRecordsByUri.clear();
    this.cacheRecordsLoaded = false;
    this.cacheManifest = undefined;
    this.clearSymbolRelationCache();
    this.clearDocumentSummaryCache();
    await this.restorePersistedCacheManifest();
    await this.restorePersistedSnapshot();
    if (!this.snapshot) {
      throw new Error('call graph worker completed but persisted snapshot could not be restored');
    }
    return this.snapshot;
  }

  private async rebuildInRustGraphProcess(input: {
    workspaceRoot: string;
    maxFileSize: number;
    parseConcurrency: number;
    configSignature: string;
    token?: vscode.CancellationToken;
    report?: (progress: CallGraphRebuildProgress) => void;
  }): Promise<CallGraphSnapshot> {
    const binary = await this.resolveRustGraphBinary(true);
    if (!binary) {
      throw new Error('zoek-rs binary is unavailable for rust-native call graph rebuild');
    }
    const started = Date.now();
    const builtAtUnixMs = Date.now();
    input.report?.({
      stage: 'discovering',
      message: 'rust graph rebuild starting',
      current: 0,
      total: 0,
      parsedFiles: 0,
      skippedFiles: 0,
      warningCount: 0,
      elapsedMs: 0,
      concurrency: input.parseConcurrency,
      maxConcurrency: input.parseConcurrency,
    });
    const args = [
      binary,
      'graph-rebuild',
      input.workspaceRoot,
      '--built-at',
      String(builtAtUnixMs),
      '--max-file-size',
      String(Math.max(0, Math.floor(input.maxFileSize))),
      '--workers',
      String(Math.max(1, Math.min(MAX_CALL_GRAPH_CONCURRENCY, Math.floor(input.parseConcurrency)))),
    ];
    this.log.appendLine(`call graph rust-native rebuild start: binary=${binary} args=${JSON.stringify(args.slice(1))}`);
    const response = await this.invokeRustGraphJson(args, {
      token: input.token,
      cancelError: new CallGraphRebuildCancelledError(),
      onStderrLine: (line) => {
        const progress = parseRustGraphRebuildProgressLine(line);
        if (!progress) {
          if (line.trim()) {
            this.log.appendLine(`call graph rust-native stderr: ${line}`);
          }
          return;
        }
        input.report?.({
          stage: progress.stage,
          message: progress.message,
          current: progress.current,
          total: progress.total,
          parsedFiles: progress.stage === 'parsing' ? progress.current : 0,
          skippedFiles: 0,
          warningCount: 0,
          elapsedMs: Date.now() - started,
          concurrency: input.parseConcurrency,
          maxConcurrency: input.parseConcurrency,
        });
      },
    }) as RustGraphIndexResponse;
    if (response.type !== 'graph-index' || response.ok !== true) {
      throw new Error('unexpected zoek-rs graph-rebuild response');
    }
    const warnings = [
      ...(response.warnings ?? []),
      'rust-native graph rebuild stores the primary graph in zoek-rs binary index; JS snapshot arrays are intentionally not materialized',
    ];
    const stats: CallGraphStats = {
      fileCount: response.fileCount ?? 0,
      symbolCount: response.symbolCount ?? 0,
      edgeCount: 0,
      exactEdgeCount: 0,
      possibleEdgeCount: 0,
      unresolvedEdgeCount: 0,
      languageCounts: {
        python: 0,
        java: 0,
        kotlin: 0,
        typescript: 0,
        javascript: 0,
        graphql: 0,
      },
      elapsedMs: Date.now() - started,
      parseConcurrency: input.parseConcurrency,
      skippedFileCount: 0,
      callsiteCount: 0,
      skippedPossibleEdgeCount: 0,
      skippedUnresolvedEdgeCount: 0,
      edgeLimitHit: false,
      referenceCount: response.referenceCount ?? 0,
    };
    const snapshot: CallGraphSnapshot = {
      workspaceRoot: input.workspaceRoot,
      builtAtUnixMs: response.builtAtUnixMs ?? builtAtUnixMs,
      symbols: [],
      edges: [],
      references: [],
      warnings,
      stats,
    };
    await this.persistRustNativeGraphManifest(snapshot, input.configSignature);
    this.applySnapshot(snapshot, undefined, undefined, input.configSignature);
    this.cacheRecordsLoaded = false;
    this.log.appendLine(
      `call graph rust-native rebuild done: symbols=${stats.symbolCount} references=${stats.referenceCount} ` +
      `bytes=${response.bytes ?? 0} elapsed=${stats.elapsedMs}ms`,
    );
    input.report?.({
      stage: 'done',
      message: `rust graph rebuild done in ${stats.elapsedMs}ms`,
      current: stats.referenceCount,
      total: stats.referenceCount,
      parsedFiles: stats.fileCount,
      skippedFiles: stats.skippedFileCount,
      warningCount: warnings.length,
      elapsedMs: stats.elapsedMs,
      concurrency: input.parseConcurrency,
      maxConcurrency: input.parseConcurrency,
    });
    return snapshot;
  }

  private async persistRustNativeGraphManifest(
    snapshot: CallGraphSnapshot,
    configSignature: string,
  ): Promise<void> {
    const manifest: CallGraphCacheManifest = {
      version: CALL_GRAPH_CACHE_VERSION,
      workspaceRoot: snapshot.workspaceRoot,
      configSignature,
      builtAtUnixMs: snapshot.builtAtUnixMs,
      chunks: [],
      recordIndex: [],
      snapshot: {
        builtAtUnixMs: snapshot.builtAtUnixMs,
        stats: snapshot.stats,
        warnings: snapshot.warnings,
        symbols: [],
        edges: [],
        references: [],
      },
    };
    const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(manifest), 'utf8'));
    await vscode.workspace.fs.createDirectory(this.cacheDirUri(snapshot.workspaceRoot));
    await vscode.workspace.fs.writeFile(this.cacheManifestUri(snapshot.workspaceRoot), encodedManifest);
    this.cacheManifest = manifest;
    this.cacheConfigSignature = configSignature;
    this.clearSymbolRelationCache();
    this.clearDocumentSummaryCache();
  }

  private async doRebuild(
    report?: (progress: CallGraphRebuildProgress) => void,
    token?: vscode.CancellationToken,
    options: CallGraphRebuildOptions = {},
  ): Promise<CallGraphSnapshot> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    if (this.restorePromise) {
      await this.restorePromise;
    }
    const workspaceRoot = folder.uri.fsPath;
    this.cancelRustGraphProcesses('call graph rebuild started', {
      kinds: ['graph-query', 'graph-symbol-query', 'graph-index'],
    });
    this.rustSymbolQueryCache.clear();
    this.rustDocumentSummaryPromises.clear();
    if (options.force) {
      await this.clearForForceRebuild(workspaceRoot);
    }
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const maxFileSize = getConfiguredCallGraphMaxFileSize(cfg);
    const parseConcurrency = getConfiguredCallGraphConcurrency(cfg);
    const configSignature = getCallGraphConfigSignature(cfg);
    return this.rebuildInRustGraphProcess({
      workspaceRoot,
      maxFileSize,
      parseConcurrency,
      configSignature,
      token,
      report,
    });
  }

  private resolveInputSymbols(symbolOrQuery: string): CallGraphSymbol[] {
    const snapshot = this.snapshot;
    if (!snapshot) { return []; }
    const byId = this.getIndex(snapshot).byId;
    const exact = byId.get(symbolOrQuery);
    if (exact) { return [exact]; }
    return this.resolveSymbols(symbolOrQuery, 5);
  }

  private async mergeProviderResults(
    base: CallGraphQueryResult[],
    direction: 'callers' | 'callees',
    limit: number,
  ): Promise<CallGraphQueryResult[]> {
    const snapshot = this.snapshot;
    if (!snapshot || base.length === 0) { return base; }
    const index = this.getIndex(snapshot);
    const merged: CallGraphQueryResult[] = [];
    for (const result of base) {
      const providerEdges = direction === 'callers'
        ? await this.providerIncomingEdges(result.symbol, index)
        : await this.providerOutgoingEdges(result.symbol, index);
      const edges = mergeEdges(result.edges, providerEdges).slice(0, limit);
      const relatedIds = direction === 'callers'
        ? edges.map((edge) => edge.callerId)
        : edges.map((edge) => edge.calleeId).filter((id): id is string => !!id);
      const providerSymbols = providerEdges
        .flatMap((edge) => [edge.callerId, edge.calleeId])
        .filter((id): id is string => !!id)
        .map((id) => index.byId.get(id))
        .filter((symbol): symbol is CallGraphSymbol => !!symbol);
      merged.push({
        symbol: result.symbol,
        edges,
        relatedSymbols: dedupeSymbols([
          ...result.relatedSymbols,
          ...collectRelatedSymbols(relatedIds, index.byId),
          ...providerSymbols,
        ]),
      });
    }
    return merged;
  }

  private async providerIncomingEdges(symbol: CallGraphSymbol, index: SymbolIndex): Promise<CallGraphEdge[]> {
    const item = await this.prepareCallHierarchy(symbol);
    if (!item) { return []; }
    try {
      const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        'vscode.provideIncomingCalls',
        item,
      );
      if (!Array.isArray(incoming)) { return []; }
      const edges: CallGraphEdge[] = [];
      for (const call of incoming) {
        const caller = findIndexedSymbolForProviderItem(call.from, index);
        if (!caller) { continue; }
        for (const range of call.fromRanges.length > 0 ? call.fromRanges : [call.from.selectionRange]) {
          edges.push(makeProviderEdge({
            callerId: caller.id,
            calleeId: symbol.id,
            calleeName: symbol.qualifiedName,
            callName: symbol.name,
            callKind: 'direct',
            uri: call.from.uri,
            range,
            evidence: ['VS Code Call Hierarchy incoming call provider'],
          }));
        }
      }
      return edges;
    } catch (err) {
      this.log.appendLine(`call hierarchy incoming failed for ${symbol.qualifiedName}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async providerOutgoingEdges(symbol: CallGraphSymbol, index: SymbolIndex): Promise<CallGraphEdge[]> {
    const item = await this.prepareCallHierarchy(symbol);
    if (!item) { return []; }
    try {
      const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        'vscode.provideOutgoingCalls',
        item,
      );
      if (!Array.isArray(outgoing)) { return []; }
      const edges: CallGraphEdge[] = [];
      for (const call of outgoing) {
        const callee = findIndexedSymbolForProviderItem(call.to, index)
          ?? symbolFromCallHierarchyItem(call.to);
        for (const range of call.fromRanges.length > 0 ? call.fromRanges : [call.to.selectionRange]) {
          edges.push(makeProviderEdge({
            callerId: symbol.id,
            calleeId: callee.id,
            calleeName: callee.qualifiedName,
            callName: callee.name,
            callKind: 'direct',
            uri: item.uri,
            range,
            evidence: ['VS Code Call Hierarchy outgoing call provider'],
          }));
        }
      }
      return edges;
    } catch (err) {
      this.log.appendLine(`call hierarchy outgoing failed for ${symbol.qualifiedName}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async prepareCallHierarchy(symbol: CallGraphSymbol): Promise<vscode.CallHierarchyItem | undefined> {
    try {
      const uri = vscode.Uri.parse(symbol.uri);
      const position = new vscode.Position(symbol.range.startLine, symbol.range.startColumn);
      const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        uri,
        position,
      );
      if (!Array.isArray(items) || items.length === 0) { return undefined; }
      return items.find((item) => item.name === symbol.name) ?? items[0];
    } catch {
      return undefined;
    }
  }

  private getIndex(snapshot: CallGraphSnapshot): SymbolIndex {
    if (this.indexCache?.snapshot === snapshot) { return this.indexCache.index; }
    const bindings = this.snapshot === snapshot
      ? Array.from(this.fileRecordsByUri.values()).flatMap((record) => record.parsed.bindings)
      : [];
    const index = buildSymbolIndex(snapshot.symbols, bindings);
    this.indexCache = { snapshot, index };
    return index;
  }

  private getRelationSummaryIndex(snapshot: CallGraphSnapshot): RelationSummaryIndex {
    if (this.relationSummaryCache?.snapshot === snapshot) { return this.relationSummaryCache.index; }
    const index = buildRelationSummaryIndex(snapshot.edges, snapshot.references);
    this.relationSummaryCache = { snapshot, index };
    return index;
  }
}

function countSnapshotChunks(manifest: CallGraphCacheManifest): number {
  const snapshot = manifest.snapshot;
  if (!snapshot) { return 0; }
  return snapshot.symbols.length + snapshot.edges.length + snapshot.references.length;
}

function countSymbolRelationBuckets(manifest: CallGraphCacheManifest): number {
  return manifest.symbolRelations?.length ?? 0;
}

function countDocumentSummaryBuckets(manifest: CallGraphCacheManifest): number {
  return manifest.documentSummaries?.length ?? 0;
}

function countDocumentSummaryFiles(manifest: CallGraphCacheManifest): number {
  return manifest.documentSummaryFiles?.length ?? 0;
}

function findDocumentSummaryFileChunk(
  manifest: CallGraphCacheManifest,
  uriString: string,
): CallGraphDocumentSummaryFileChunk | undefined {
  const uriHash = stableHash(uriString);
  return manifest.documentSummaryFiles?.find((chunk) => chunk.uri === uriString || chunk.uriHash === uriHash);
}

function buildSymbolRelationRecords(relationIndex: RelationSummaryIndex): CallGraphSymbolRelationRecord[] {
  const records: CallGraphSymbolRelationRecord[] = [];
  for (const [symbolId, usages] of relationIndex.usagesBySymbolId) {
    if (usages.length === 0) { continue; }
    records.push({ symbolId, usages });
  }
  return records.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
}

function formatRustGraphReferenceTsvLine(symbolId: string, reference: CallGraphReference): string {
  return [
    'U',
    encodeRustGraphTsvField(symbolId),
    encodeRustGraphTsvField(reference.name),
    encodeRustGraphTsvField(reference.rawText),
    encodeRustGraphTsvField(reference.uri),
    encodeRustGraphTsvField(reference.relPath),
    safeGraphRangeNumber(reference.range.startLine),
    safeGraphRangeNumber(reference.range.startColumn),
    safeGraphRangeNumber(reference.range.endLine),
    safeGraphRangeNumber(reference.range.endColumn),
    encodeRustGraphTsvField(reference.enclosingSymbolId ?? ''),
  ].join('\t') + '\n';
}

function encodeRustGraphTsvField(value: string): string {
  return encodeURIComponent(value);
}

function normalizeGraphRange(range: CallGraphRange | undefined): CallGraphRange {
  return {
    startLine: safeGraphRangeNumber(range?.startLine),
    startColumn: safeGraphRangeNumber(range?.startColumn),
    endLine: safeGraphRangeNumber(range?.endLine),
    endColumn: safeGraphRangeNumber(range?.endColumn),
  };
}

function rustGraphSymbolToCallGraphSymbol(symbol: RustGraphSymbol): CallGraphSymbol & { usageCount?: number; implementationCount?: number } {
  const range = normalizeGraphRange(symbol.range);
  const bodyRange = normalizeGraphRange(symbol.bodyRange ?? symbol.range);
  return {
    id: String(symbol.id ?? ''),
    name: String(symbol.name ?? ''),
    qualifiedName: String(symbol.qualifiedName ?? symbol.name ?? ''),
    kind: normalizeCallGraphSymbolKind(symbol.kind),
    language: normalizeCallGraphLanguage(symbol.language),
    uri: String(symbol.uri ?? ''),
    relPath: String(symbol.relPath ?? ''),
    range,
    bodyRange,
    ...(symbol.containerId ? { containerId: String(symbol.containerId) } : {}),
    ...(symbol.containerName ? { containerName: String(symbol.containerName) } : {}),
    ...(symbol.packageName ? { packageName: String(symbol.packageName) } : {}),
    ...(Array.isArray(symbol.extendsNames) ? { extendsNames: symbol.extendsNames.map(String).filter(Boolean) } : {}),
    ...(Array.isArray(symbol.implementsNames) ? { implementsNames: symbol.implementsNames.map(String).filter(Boolean) } : {}),
    ...(Number.isFinite(symbol.usageCount) ? { usageCount: Math.max(0, Math.floor(symbol.usageCount as number)) } : {}),
    ...(Number.isFinite(symbol.implementationCount) ? { implementationCount: Math.max(0, Math.floor(symbol.implementationCount as number)) } : {}),
  };
}

function normalizeCallGraphLanguage(value: unknown): CallGraphLanguage {
  const language = String(value ?? '');
  if (language === 'python' || language === 'java' || language === 'kotlin' || language === 'typescript' || language === 'javascript' || language === 'graphql') {
    return language;
  }
  return 'javascript';
}

function normalizeCallGraphSymbolKind(value: unknown): CallGraphSymbolKind {
  const kind = String(value ?? '');
  if (
    kind === 'class' ||
    kind === 'interface' ||
    kind === 'enum' ||
    kind === 'type' ||
    kind === 'struct' ||
    kind === 'function' ||
    kind === 'method' ||
    kind === 'constructor' ||
    kind === 'constant' ||
    kind === 'variable' ||
    kind === 'field' ||
    kind === 'property'
  ) {
    return kind;
  }
  return 'function';
}

function rustSymbolQueryCacheKey(query: string, limit: number): string {
  return `${query.trim()}\n${Math.max(1, Math.floor(limit))}`;
}

function parseRustGraphRebuildProgressLine(line: string): {
  stage: CallGraphRebuildProgress['stage'];
  current: number;
  total: number;
  message: string;
} | undefined {
  const match = /^graph-rebuild progress: stage=(\S+) current=(\d+) total=(\d+) message=(.*)$/.exec(line.trim());
  if (!match) { return undefined; }
  const stage = normalizeRustGraphProgressStage(match[1]);
  if (!stage) { return undefined; }
  return {
    stage,
    current: Math.max(0, Number.parseInt(match[2], 10) || 0),
    total: Math.max(0, Number.parseInt(match[3], 10) || 0),
    message: match[4] || stage,
  };
}

function normalizeRustGraphProgressStage(stage: string): CallGraphRebuildProgress['stage'] | undefined {
  if (
    stage === 'discovering' ||
    stage === 'parsing' ||
    stage === 'indexing' ||
    stage === 'resolving' ||
    stage === 'deduping' ||
    stage === 'done'
  ) {
    return stage;
  }
  return undefined;
}

function isRustNativeIndexOnlySnapshot(snapshot: CallGraphSnapshot | undefined): boolean {
  if (!snapshot) { return false; }
  return snapshot.symbols.length === 0 &&
    snapshot.edges.length === 0 &&
    snapshot.references.length === 0 &&
    snapshot.warnings.some((warning) => warning.includes('rust-native graph rebuild'));
}

function isRustNativeGraphManifest(manifest: CallGraphCacheManifest | undefined): boolean {
  return !!manifest?.snapshot?.warnings?.some((warning) => warning.includes('rust-native graph rebuild'));
}

function safeGraphRangeNumber(value: unknown): number {
  if (!Number.isFinite(value)) { return 0; }
  return Math.max(0, Math.floor(value as number));
}

async function buildDocumentSummaryRecords(
  snapshot: CallGraphSnapshot,
  index: SymbolIndex,
  relationIndex: RelationSummaryIndex,
): Promise<CallGraphDocumentSummaryRecord[]> {
  const recordsByUri = new Map<string, CallGraphDocumentSummaryRecord>();
  let visited = 0;
  for (const symbol of snapshot.symbols) {
    visited += 1;
    if (visited % 5_000 === 0) {
      await yieldToExtensionHost();
    }
    if (!isCallableSymbol(symbol) && !isTypeSymbol(symbol) && !isReferenceableSymbol(symbol)) {
      continue;
    }
    const callable = isCallableSymbol(symbol);
    const callerCount = callable ? relationIndex.callersBySymbolId.get(symbol.id)?.size ?? 0 : 0;
    const calleeCount = callable ? relationIndex.calleesBySymbolId.get(symbol.id)?.size ?? 0 : 0;
    const usageCount = relationIndex.usagesBySymbolId.get(symbol.id)?.length ?? 0;
    const implementationCount = shouldCheckImplementationCount(symbol)
      ? findImplementationSymbols(symbol, index, 20).length
      : 0;
    if (callerCount === 0 && calleeCount === 0 && usageCount === 0 && implementationCount === 0) {
      continue;
    }
    let record = recordsByUri.get(symbol.uri);
    if (!record) {
      record = { uri: symbol.uri, relPath: symbol.relPath, symbols: [] };
      recordsByUri.set(symbol.uri, record);
    }
    record.symbols.push({ symbol, callerCount, calleeCount, implementationCount, usageCount });
  }
  const records = [...recordsByUri.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const record of records) {
    record.symbols.sort((a, b) =>
      a.symbol.range.startLine - b.symbol.range.startLine ||
      a.symbol.range.startColumn - b.symbol.range.startColumn ||
      a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName));
  }
  return records;
}

function buildDocumentSummaryRecordForSymbols(
  uri: string,
  relPath: string,
  symbols: CallGraphSymbol[],
  relationIndex: RelationSummaryIndex,
  implementationCounts: Map<string, number>,
): CallGraphDocumentSummaryRecord {
  const record: CallGraphDocumentSummaryRecord = { uri, relPath, symbols: [] };
  for (const symbol of symbols) {
    const callable = isCallableSymbol(symbol);
    const callerCount = callable ? relationIndex.callersBySymbolId.get(symbol.id)?.size ?? 0 : 0;
    const calleeCount = callable ? relationIndex.calleesBySymbolId.get(symbol.id)?.size ?? 0 : 0;
    const usageCount = relationIndex.usagesBySymbolId.get(symbol.id)?.length ?? 0;
    const implementationCount = implementationCounts.get(symbol.id) ?? 0;
    if (callerCount === 0 && calleeCount === 0 && usageCount === 0 && implementationCount === 0) {
      continue;
    }
    record.symbols.push({ symbol, callerCount, calleeCount, implementationCount, usageCount });
  }
  record.symbols.sort((a, b) =>
    a.symbol.range.startLine - b.symbol.range.startLine ||
    a.symbol.range.startColumn - b.symbol.range.startColumn ||
    a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName));
  return record;
}

async function buildFastDocumentSummaryRecord(
  record: CallGraphFileRecord,
  existing: CallGraphDocumentSummaryRecord | undefined,
  previousRecord: CallGraphFileRecord | undefined,
): Promise<CallGraphDocumentSummaryRecord> {
  const existingById = new Map((existing?.symbols ?? []).map((summary) => [summary.symbol.id, summary]));
  const existingByQualifiedName = new Map((existing?.symbols ?? []).map((summary) => [summary.symbol.qualifiedName, summary]));
  const previousLocal = previousRecord ? await buildLocalRelationCountsByQualifiedName(previousRecord) : undefined;
  const currentLocal = previousLocal ? await buildLocalRelationCountsByQualifiedName(record) : undefined;
  const summary: CallGraphDocumentSummaryRecord = { uri: record.uri, relPath: record.relPath, symbols: [] };
  for (const symbol of record.parsed.symbols.map(stripMutableSymbol)) {
    if (!isCallableSymbol(symbol) && !isTypeSymbol(symbol) && !isReferenceableSymbol(symbol)) { continue; }
    const existingSummary = existingById.get(symbol.id) ?? existingByQualifiedName.get(symbol.qualifiedName);
    const oldLocal = previousLocal?.get(symbol.qualifiedName);
    const newLocal = currentLocal?.get(symbol.qualifiedName);
    const callerCount = applyCountDelta(existingSummary?.callerCount ?? 0, oldLocal?.callerCount, newLocal?.callerCount);
    const calleeCount = applyCountDelta(existingSummary?.calleeCount ?? 0, oldLocal?.calleeCount, newLocal?.calleeCount);
    const usageCount = applyCountDelta(existingSummary?.usageCount ?? 0, oldLocal?.usageCount, newLocal?.usageCount);
    const implementationCount = existingSummary?.implementationCount ?? 0;
    if (callerCount === 0 && calleeCount === 0 && usageCount === 0 && implementationCount === 0) {
      continue;
    }
    summary.symbols.push({
      symbol,
      callerCount,
      calleeCount,
      implementationCount,
      usageCount,
    });
  }
  summary.symbols.sort((a, b) =>
    a.symbol.range.startLine - b.symbol.range.startLine ||
    a.symbol.range.startColumn - b.symbol.range.startColumn ||
    a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName));
  return summary;
}

async function buildLocalRelationCountsByQualifiedName(record: CallGraphFileRecord): Promise<Map<string, {
  callerCount: number;
  calleeCount: number;
  usageCount: number;
}>> {
  const symbols = record.parsed.symbols.map(stripMutableSymbol);
  const index = buildSymbolIndex(symbols, record.parsed.bindings);
  const references = resolveReferenceCandidates(record.parsed.referenceCandidates, symbols, index);
  const resolvedCalls = await resolveCallsAsync(record.parsed.calls, index, {
    resolveOptions: getConfiguredCallGraphResolveOptions(),
  });
  const relationIndex = buildRelationSummaryIndex(resolvedCalls.edges, references);
  const out = new Map<string, { callerCount: number; calleeCount: number; usageCount: number }>();
  for (const symbol of symbols) {
    out.set(symbol.qualifiedName, {
      callerCount: isCallableSymbol(symbol) ? relationIndex.callersBySymbolId.get(symbol.id)?.size ?? 0 : 0,
      calleeCount: isCallableSymbol(symbol) ? relationIndex.calleesBySymbolId.get(symbol.id)?.size ?? 0 : 0,
      usageCount: relationIndex.usagesBySymbolId.get(symbol.id)?.length ?? 0,
    });
  }
  return out;
}

function applyCountDelta(base: number, previous: number | undefined, current: number | undefined): number {
  if (previous === undefined || current === undefined) { return Math.max(0, base); }
  return Math.max(0, base - previous + current);
}

function shouldCheckImplementationCount(symbol: CallGraphSymbol): boolean {
  return isTypeSymbol(symbol) || ((symbol.kind === 'method' || symbol.kind === 'constructor') && !!symbol.containerName);
}

function documentSummaryBucketForUri(uriString: string): number {
  const parsed = Number.parseInt(stableHash(uriString), 36);
  if (!Number.isFinite(parsed)) { return 0; }
  return Math.abs(parsed) % CALL_GRAPH_DOCUMENT_SUMMARY_BUCKETS;
}

function symbolRelationBucketForSymbolId(symbolId: string): number {
  const parsed = Number.parseInt(stableHash(symbolId), 36);
  if (!Number.isFinite(parsed)) { return 0; }
  return Math.abs(parsed) % CALL_GRAPH_SYMBOL_RELATION_BUCKETS;
}

function parseFile(
  language: CallGraphLanguage,
  uri: vscode.Uri,
  relPath: string,
  text: string,
  limits: CallGraphParseLimits = DEFAULT_CALL_GRAPH_PARSE_LIMITS,
): ParsedFile {
  switch (language) {
    case 'python':
      return parsePythonFile(language, uri, relPath, text, limits);
    case 'java':
    case 'kotlin':
    case 'typescript':
    case 'javascript':
      return parseBraceFile(language, uri, relPath, text, limits);
    case 'graphql':
      return { symbols: [], calls: [], bindings: [], referenceCandidates: [], warnings: [] };
  }
}

async function parseSourceFileRecord(
  uri: vscode.Uri,
  maxFileSize: number,
  limits: CallGraphParseLimits = DEFAULT_CALL_GRAPH_PARSE_LIMITS,
): Promise<ParsedSourceFileResult> {
  if (!isSupportedSourceUri(uri)) {
    return { skipped: true, warnings: [] };
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) {
    return { skipped: true, warnings: [] };
  }
  if (maxFileSize > 0 && stat.size > maxFileSize) {
    return { skipped: true, warnings: [] };
  }
  const language = LANGUAGE_BY_EXTENSION.get(path.extname(uri.fsPath).toLowerCase());
  if (!language) {
    return { skipped: true, warnings: [] };
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinaryContent(bytes)) {
    return { skipped: true, warnings: [] };
  }
  const text = decodeTextBytes(bytes);
  const relPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const lineCheck = checkParseLineLimits(text, limits);
  if (lineCheck) {
    return { skipped: true, warnings: [`skipped call graph parse for ${relPath}: ${lineCheck}`] };
  }
  const parseStarted = Date.now();
  const parsed = parseFile(language, uri, relPath, text, limits);
  const parseElapsed = Date.now() - parseStarted;
  const warnings = parseElapsed > 2_500
    ? [`slow call graph parse: ${relPath} ${parseElapsed}ms size=${stat.size}`]
    : [];
  return {
    skipped: false,
    warnings,
    record: {
      uri: uri.toString(),
      relPath,
      language,
      mtime: stat.mtime,
      size: stat.size,
      parsed,
    },
  };
}

function checkParseLineLimits(text: string, limits: CallGraphParseLimits): string | undefined {
  let lineCount = 1;
  let currentLineLength = 0;
  let maxLineLength = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 /* \n */) {
      if (currentLineLength > maxLineLength) { maxLineLength = currentLineLength; }
      if (limits.maxLineLength > 0 && currentLineLength > limits.maxLineLength) {
        return `line length ${currentLineLength} > ${limits.maxLineLength}`;
      }
      lineCount += 1;
      if (limits.maxLinesPerFile > 0 && lineCount > limits.maxLinesPerFile) {
        return `line count ${lineCount} > ${limits.maxLinesPerFile}`;
      }
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }
  if (currentLineLength > maxLineLength) { maxLineLength = currentLineLength; }
  if (limits.maxLineLength > 0 && maxLineLength > limits.maxLineLength) {
    return `line length ${maxLineLength} > ${limits.maxLineLength}`;
  }
  return undefined;
}

function isSupportedSourceUri(uri: vscode.Uri): boolean {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext) && !uri.fsPath.endsWith('.d.ts');
}

async function buildSnapshotFromFileRecords(input: {
  workspaceRoot: string;
  records: CallGraphFileRecord[];
  skippedFileCount: number;
  warnings: string[];
  started: number;
  parseConcurrency: number;
  resolveOptions: CallGraphResolveOptions;
  token?: vscode.CancellationToken;
  onResolveProgress?: (current: number, total: number) => void;
  consumeRecords?: boolean;
}): Promise<{ snapshot: CallGraphSnapshot; index: SymbolIndex }> {
  const fileCount = input.records.length;
  const symbols: CallGraphSymbol[] = [];
  const bindings: CallGraphVariableBinding[] = [];
  const referenceCandidates: CallGraphReferenceCandidate[] = [];
  const calls: CallGraphCallSite[] = [];
  const warnings = [...input.warnings];
  for (const record of input.records) {
    for (const symbol of record.parsed.symbols) {
      symbols.push(stripMutableSymbol(symbol));
    }
    bindings.push(...record.parsed.bindings);
    referenceCandidates.push(...record.parsed.referenceCandidates);
    calls.push(...record.parsed.calls);
    warnings.push(...record.parsed.warnings);
    if (input.consumeRecords) {
      clearParsedFileRecord(record);
    }
  }
  const index = buildSymbolIndex(symbols, bindings);
  bindings.length = 0;
  const references = resolveReferenceCandidates(
    referenceCandidates,
    symbols,
    index,
  );
  referenceCandidates.length = 0;
  const callsiteCount = calls.length;
  const resolvedCalls = await resolveCallsAsync(calls, index, {
    token: input.token,
    resolveOptions: input.resolveOptions,
    onProgress: input.onResolveProgress,
  });
  calls.length = 0;
  if (resolvedCalls.edgeLimitHit) {
    warnings.push(`call graph unique edge limit reached at ${input.resolveOptions.maxEdges}; skipped additional materialized edges`);
  }
  if (!input.resolveOptions.includePossibleEdges && resolvedCalls.skippedPossibleEdgeCount > 0) {
    warnings.push(`skipped ${resolvedCalls.skippedPossibleEdgeCount} possible edges; enable intellijStyledSearch.callGraphIncludePossibleEdges to materialize them`);
  }
  if (!input.resolveOptions.includeUnresolvedEdges && resolvedCalls.skippedUnresolvedEdgeCount > 0) {
    warnings.push(`skipped ${resolvedCalls.skippedUnresolvedEdgeCount} unresolved callsites; enable intellijStyledSearch.callGraphIncludeUnresolvedEdges to materialize them`);
  }
  const languageCounts: Record<CallGraphLanguage, number> = {
    python: 0,
    java: 0,
    kotlin: 0,
    typescript: 0,
    javascript: 0,
    graphql: 0,
  };
  for (const symbol of symbols) {
    languageCounts[symbol.language] += 1;
  }
  const edges = resolvedCalls.edges;
  return {
    index,
    snapshot: {
      workspaceRoot: input.workspaceRoot,
      builtAtUnixMs: Date.now(),
      symbols,
      edges,
      references,
      warnings,
      stats: {
        fileCount,
        symbolCount: symbols.length,
        edgeCount: edges.length,
        exactEdgeCount: edges.filter((edge) => edge.confidence === 'exact' || edge.confidence === 'resolved').length,
        possibleEdgeCount: edges.filter((edge) => edge.confidence === 'possible').length,
        unresolvedEdgeCount: edges.filter((edge) => edge.confidence === 'unresolved').length,
        languageCounts,
        elapsedMs: Date.now() - input.started,
        parseConcurrency: input.parseConcurrency,
        skippedFileCount: input.skippedFileCount,
        callsiteCount,
        skippedPossibleEdgeCount: resolvedCalls.skippedPossibleEdgeCount,
        skippedUnresolvedEdgeCount: resolvedCalls.skippedUnresolvedEdgeCount,
        edgeLimitHit: resolvedCalls.edgeLimitHit,
        referenceCount: references.length,
      },
    },
  };
}

function clearParsedFileRecord(record: CallGraphFileRecord): void {
  record.parsed.symbols.length = 0;
  record.parsed.calls.length = 0;
  record.parsed.bindings.length = 0;
  record.parsed.referenceCandidates.length = 0;
  record.parsed.warnings.length = 0;
}

function clearSymbolIndex(index: SymbolIndex | undefined): void {
  if (!index) { return; }
  index.byId.clear();
  index.byName.clear();
  index.byQualifiedName.clear();
  index.byClassName.clear();
  index.methodsByName.clear();
  index.methodsByClassName.clear();
  index.symbolsByFile.clear();
  index.bindingsBySymbolId.clear();
  index.typesByReferencedName.clear();
}

function clearRelationSummaryIndex(index: RelationSummaryIndex | undefined): void {
  if (!index) { return; }
  index.callersBySymbolId.clear();
  index.calleesBySymbolId.clear();
  index.usagesBySymbolId.clear();
}

function clearCallGraphSnapshotPayload(snapshot: CallGraphSnapshot): void {
  snapshot.symbols.length = 0;
  snapshot.edges.length = 0;
  snapshot.references.length = 0;
  snapshot.warnings.length = 0;
}

type NodeFileUri = {
  scheme: 'file';
  fsPath: string;
  toString(): string;
};

export async function rebuildCallGraphWorker(
  input: CallGraphWorkerRebuildInput,
  report: (progress: CallGraphRebuildProgress) => void = () => undefined,
): Promise<CallGraphWorkerRebuildResult> {
  const started = Date.now();
  const adaptiveMemoryOptions = getCallGraphAdaptiveMemoryOptions(input.buildLimits.memoryBudgetMb);
  const initialHeapPressure = getCallGraphHeapPressure();
  const progressState = {
    current: 0,
    total: 0,
    parsedFiles: 0,
    skippedFiles: 0,
    warningCount: 0,
    lastReportAt: 0,
    currentConcurrency: input.parseConcurrency,
    maxConcurrency: input.parseConcurrency,
    heapUsedMb: initialHeapPressure.heapUsedMb,
    heapLimitMb: initialHeapPressure.heapLimitMb,
    heapUsageRatio: initialHeapPressure.heapUsageRatio,
    workerThrottleCount: 0,
  };
  const applyAdaptiveProgressState = (state?: CallGraphAdaptiveConcurrencySnapshot) => {
    if (!state) { return; }
    progressState.currentConcurrency = state.currentConcurrency;
    progressState.maxConcurrency = state.maxConcurrency;
    progressState.heapUsedMb = state.heapUsedMb;
    progressState.heapLimitMb = state.heapLimitMb;
    progressState.heapUsageRatio = state.heapUsageRatio;
    progressState.workerThrottleCount = state.throttleCount;
  };
  const refreshHeapProgressState = () => {
    const pressure = getCallGraphHeapPressure();
    progressState.heapUsedMb = pressure.heapUsedMb;
    progressState.heapLimitMb = pressure.heapLimitMb;
    progressState.heapUsageRatio = pressure.heapUsageRatio;
  };
  const emitProgress = (
    stage: CallGraphRebuildProgress['stage'],
    message: string,
    force = false,
  ) => {
    const now = Date.now();
    if (!force && now - progressState.lastReportAt < 250) {
      return;
    }
    progressState.lastReportAt = now;
    report({
      stage,
      message,
      current: progressState.current,
      total: progressState.total,
      parsedFiles: progressState.parsedFiles,
      skippedFiles: progressState.skippedFiles,
      warningCount: progressState.warningCount,
      elapsedMs: now - started,
      concurrency: progressState.currentConcurrency,
      maxConcurrency: progressState.maxConcurrency,
      heapUsedMb: progressState.heapUsedMb,
      heapLimitMb: progressState.heapLimitMb,
      heapUsageRatio: progressState.heapUsageRatio,
      workerThrottleCount: progressState.workerThrottleCount,
    });
  };

  emitProgress('discovering', 'worker discovering source files', true);
  const sourceFiles = await findCallGraphSourceFilesNode(input.workspaceRoot, input.excludeGlobs, (count) => {
    progressState.current = count;
    emitProgress('discovering', `worker discovered ${count} source files`);
  });
  const warnings: string[] = [];
  const records: CallGraphFileRecord[] = [];
  const buildBudgetState = createCallGraphBuildBudgetState();
  progressState.current = 0;
  progressState.total = sourceFiles.length;
  emitProgress(
    'parsing',
    `worker parsing ${sourceFiles.length} source files with up to ${input.parseConcurrency} workers`,
    true,
  );
  const parseStats = await forEachWithAdaptiveConcurrency(sourceFiles, input.parseConcurrency, async (uri) => {
    let result: ParsedSourceFileResult;
    try {
      const parseStarted = Date.now();
      result = await parseSourceFileRecordFromFs(uri, input.workspaceRoot, input.maxFileSize, input.parseLimits);
      await applyCallGraphCpuBudget(Date.now() - parseStarted, input.cpuBudget);
      progressState.current += 1;
      if (result.record) {
        progressState.parsedFiles += 1;
      } else {
        progressState.skippedFiles += 1;
      }
      progressState.warningCount += result.warnings.length;
      emitProgress('parsing', `worker parsed ${progressState.current}/${progressState.total}`);
    } catch (err) {
      const warning = `failed to parse ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`;
      progressState.current += 1;
      progressState.skippedFiles += 1;
      progressState.warningCount += 1;
      emitProgress('parsing', `worker parsed ${progressState.current}/${progressState.total}`);
      result = { record: undefined, warnings: [warning], skipped: true };
    }
    if (result.record) {
      applyCallGraphBuildBudgetsToRecord(result.record, input.buildLimits, buildBudgetState);
      records.push(result.record);
    }
    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
  }, {
    ...adaptiveMemoryOptions,
    onStateChange: (state) => {
      applyAdaptiveProgressState(state);
      emitProgress('parsing', `worker parsed ${progressState.current}/${progressState.total}`);
    },
  });
  emitProgress('parsing', `worker parsed ${progressState.current}/${progressState.total}`, true);
  sourceFiles.length = 0;
  appendCallGraphBuildBudgetWarnings(warnings, input.buildLimits, buildBudgetState);
  progressState.warningCount = warnings.length;
  progressState.current = 0;
  progressState.total = records.reduce((sum, record) => sum + record.parsed.symbols.length, 0);
  emitProgress('indexing', `worker indexing ${progressState.total} symbols`, true);
  const recordIndex = buildRecordIndexFromRecords(records);
  const snapshotBuild = await buildSnapshotFromFileRecords({
    workspaceRoot: input.workspaceRoot,
    records,
    skippedFileCount: progressState.skippedFiles,
    warnings,
    started,
    parseConcurrency: input.parseConcurrency,
    resolveOptions: input.resolveOptions,
    onResolveProgress: (current, total) => {
      progressState.current = current;
      progressState.total = total;
      emitProgress('resolving', `worker resolved ${current}/${total} callsites`);
    },
    consumeRecords: true,
  });
  const snapshot = snapshotBuild.snapshot;
  snapshot.stats.minParseConcurrency = parseStats.minObservedConcurrency;
  snapshot.stats.workerThrottleCount = parseStats.throttleCount;
  snapshot.stats.maxHeapUsedMb = parseStats.maxHeapUsedMb;
  snapshot.stats.maxHeapUsageRatio = parseStats.maxHeapUsageRatio;
  records.length = 0;
  maybeRunGarbageCollection();
  refreshHeapProgressState();
  emitProgress('indexing', 'worker released parsed file records', true);
  emitProgress('indexing', 'worker writing call graph cache', true);
  const cacheResult = await writeCallGraphWorkerCache({
    cacheDirFsPath: input.cacheDirFsPath,
    workspaceRoot: input.workspaceRoot,
    configSignature: input.configSignature,
    snapshot,
    recordIndex,
    index: snapshotBuild.index,
  });
  const resultBuiltAtUnixMs = snapshot.builtAtUnixMs;
  const resultStats: CallGraphStats = {
    ...snapshot.stats,
    languageCounts: { ...snapshot.stats.languageCounts },
  };
  const resultWarnings = [...snapshot.warnings];
  const recordIndexCount = recordIndex.length;
  clearCallGraphSnapshotPayload(snapshot);
  recordIndex.length = 0;
  warnings.length = 0;
  maybeRunGarbageCollection();
  refreshHeapProgressState();
  progressState.current = progressState.total;
  progressState.parsedFiles = resultStats.fileCount;
  progressState.skippedFiles = resultStats.skippedFileCount;
  progressState.warningCount = resultWarnings.length;
  emitProgress('done', `worker done in ${resultStats.elapsedMs}ms`, true);
  return {
    builtAtUnixMs: resultBuiltAtUnixMs,
    stats: resultStats,
    warnings: resultWarnings,
    recordIndexCount,
    snapshotChunkCount: cacheResult.snapshotChunkCount,
    symbolRelationBucketCount: cacheResult.symbolRelationBucketCount,
    documentSummaryBucketCount: cacheResult.documentSummaryBucketCount,
    cacheBytes: cacheResult.cacheBytes,
  };
}

async function findCallGraphSourceFilesNode(
  workspaceRoot: string,
  excludeGlobs: string[],
  onProgress: (count: number) => void,
): Promise<NodeFileUri[]> {
  const out: NodeFileUri[] = [];
  const excludeMatcher = compilePathScopeMatcher(undefined, excludeGlobs);
  await walkCallGraphSourceFilesNode(workspaceRoot, '', out, excludeMatcher, onProgress);
  return out;
}

async function walkCallGraphSourceFilesNode(
  workspaceRoot: string,
  relDir: string,
  out: NodeFileUri[],
  excludeMatcher: ((relPath: string) => boolean) | null,
  onProgress: (count: number) => void,
): Promise<void> {
  const absDir = relDir ? path.join(workspaceRoot, relDir) : workspaceRoot;
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(absDir);
  } catch {
    return;
  }
  try {
    for await (const entry of dir) {
      if (entry.name === '.' || entry.name === '..') { continue; }
      const relPath = (relDir ? path.join(relDir, entry.name) : entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (excludeMatcher && !excludeMatcher(`${relPath}/__ijss_probe__`)) { continue; }
        await walkCallGraphSourceFilesNode(workspaceRoot, relPath, out, excludeMatcher, onProgress);
        continue;
      }
      if (!entry.isFile()) { continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts')) { continue; }
      if (excludeMatcher && !excludeMatcher(relPath)) { continue; }
      out.push(nodeFileUri(path.join(workspaceRoot, relPath)));
      onProgress(out.length);
    }
  } finally {
    try { await dir.close(); } catch {}
  }
}

async function parseSourceFileRecordFromFs(
  uri: NodeFileUri,
  workspaceRoot: string,
  maxFileSize: number,
  limits: CallGraphParseLimits,
): Promise<ParsedSourceFileResult> {
  const stat = await fs.promises.stat(uri.fsPath);
  if (stat.isDirectory()) {
    return { skipped: true, warnings: [] };
  }
  if (maxFileSize > 0 && stat.size > maxFileSize) {
    return { skipped: true, warnings: [] };
  }
  const language = LANGUAGE_BY_EXTENSION.get(path.extname(uri.fsPath).toLowerCase());
  if (!language) {
    return { skipped: true, warnings: [] };
  }
  const bytes = await fs.promises.readFile(uri.fsPath);
  if (looksBinaryContent(bytes)) {
    return { skipped: true, warnings: [] };
  }
  const text = decodeTextBytes(bytes);
  const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
  const lineCheck = checkParseLineLimits(text, limits);
  if (lineCheck) {
    return { skipped: true, warnings: [`skipped call graph parse for ${relPath}: ${lineCheck}`] };
  }
  const parseStarted = Date.now();
  const parsed = parseFile(language, uri as unknown as vscode.Uri, relPath, text, limits);
  const parseElapsed = Date.now() - parseStarted;
  const warnings = parseElapsed > 2_500
    ? [`slow call graph parse: ${relPath} ${parseElapsed}ms size=${stat.size}`]
    : [];
  return {
    skipped: false,
    warnings,
    record: {
      uri: uri.toString(),
      relPath,
      language,
      mtime: Math.trunc(stat.mtimeMs),
      size: stat.size,
      parsed,
    },
  };
}

async function writeCallGraphWorkerCache(input: {
  cacheDirFsPath: string;
  workspaceRoot: string;
  configSignature: string;
  snapshot: CallGraphSnapshot;
  recordIndex: CallGraphRecordIndexEntry[];
  index: SymbolIndex;
}): Promise<{
  snapshotChunkCount: number;
  symbolRelationBucketCount: number;
  documentSummaryBucketCount: number;
  cacheBytes: number;
}> {
  await fs.promises.mkdir(input.cacheDirFsPath, { recursive: true });
  let totalBytes = 0;
  const snapshotChunks = {
    symbols: await writeCacheArrayChunksNode(
      input.cacheDirFsPath,
      'snapshot-symbols',
      input.snapshot.symbols,
      CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
      (bytes) => { totalBytes += bytes; },
    ),
    edges: await writeCacheArrayChunksNode(
      input.cacheDirFsPath,
      'snapshot-edges',
      input.snapshot.edges,
      CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
      (bytes) => { totalBytes += bytes; },
    ),
    references: await writeCacheArrayChunksNode(
      input.cacheDirFsPath,
      'snapshot-references',
      input.snapshot.references,
      CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
      (bytes) => { totalBytes += bytes; },
    ),
  };
  const relationIndex = buildRelationSummaryIndex(input.snapshot.edges, input.snapshot.references);
  const documentSummaryRecords = await buildDocumentSummaryRecords(input.snapshot, input.index, relationIndex);
  clearSymbolIndex(input.index);
  const documentSummaries = await writeDocumentSummaryBucketsNode(
    input.cacheDirFsPath,
    documentSummaryRecords,
    (bytes) => { totalBytes += bytes; },
  );
  documentSummaryRecords.length = 0;
  maybeRunGarbageCollection();
  const symbolRelationRecords = buildSymbolRelationRecords(relationIndex);
  const symbolRelations = await writeSymbolRelationBucketsNode(
    input.cacheDirFsPath,
    symbolRelationRecords,
    (bytes) => { totalBytes += bytes; },
  );
  symbolRelationRecords.length = 0;
  clearRelationSummaryIndex(relationIndex);
  maybeRunGarbageCollection();
  const manifest: CallGraphCacheManifest = {
    version: CALL_GRAPH_CACHE_VERSION,
    workspaceRoot: input.workspaceRoot,
    configSignature: input.configSignature,
    builtAtUnixMs: input.snapshot.builtAtUnixMs,
    chunks: [],
    recordIndex: input.recordIndex,
    symbolRelations,
    documentSummaries,
    snapshot: {
      builtAtUnixMs: input.snapshot.builtAtUnixMs,
      stats: input.snapshot.stats,
      warnings: input.snapshot.warnings,
      ...snapshotChunks,
    },
  };
  const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(manifest), 'utf8'));
  totalBytes += encodedManifest.byteLength;
  await fs.promises.writeFile(path.join(input.cacheDirFsPath, 'manifest.json.gz'), encodedManifest);
  return {
    snapshotChunkCount: countSnapshotChunks(manifest),
    symbolRelationBucketCount: symbolRelations.length,
    documentSummaryBucketCount: documentSummaries.length,
    cacheBytes: totalBytes,
  };
}

async function writeCacheArrayChunksNode<T>(
  cacheDirFsPath: string,
  prefix: string,
  items: T[],
  chunkSize: number,
  onBytes: (bytes: number) => void,
): Promise<CallGraphCacheChunk[]> {
  const chunks: CallGraphCacheChunk[] = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    const file = `${prefix}-${Math.floor(offset / chunkSize)}.json.gz`;
    const encoded = await gzipAsync(Buffer.from(JSON.stringify(chunk), 'utf8'));
    onBytes(encoded.byteLength);
    await fs.promises.writeFile(path.join(cacheDirFsPath, file), encoded);
    chunks.push({ file, count: chunk.length });
    await yieldToExtensionHost();
  }
  return chunks;
}

async function writeSymbolRelationBucketsNode(
  cacheDirFsPath: string,
  records: CallGraphSymbolRelationRecord[],
  onBytes: (bytes: number) => void,
): Promise<CallGraphSymbolRelationChunk[]> {
  const buckets = new Map<number, CallGraphSymbolRelationRecord[]>();
  for (const record of records) {
    const bucket = symbolRelationBucketForSymbolId(record.symbolId);
    const bucketRecords = buckets.get(bucket) ?? [];
    bucketRecords.push(record);
    buckets.set(bucket, bucketRecords);
  }
  const chunks: CallGraphSymbolRelationChunk[] = [];
  for (const [bucket, bucketRecords] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bucketRecords.sort((a, b) => a.symbolId.localeCompare(b.symbolId));
    const file = `symbol-relations-${bucket}.json.gz`;
    const encoded = await gzipAsync(Buffer.from(JSON.stringify(bucketRecords), 'utf8'));
    onBytes(encoded.byteLength);
    await fs.promises.writeFile(path.join(cacheDirFsPath, file), encoded);
    chunks.push({ bucket, file, count: bucketRecords.length });
    await yieldToExtensionHost();
  }
  return chunks;
}

async function writeDocumentSummaryBucketsNode(
  cacheDirFsPath: string,
  records: CallGraphDocumentSummaryRecord[],
  onBytes: (bytes: number) => void,
): Promise<CallGraphDocumentSummaryChunk[]> {
  const buckets = new Map<number, CallGraphDocumentSummaryRecord[]>();
  for (const record of records) {
    const bucket = documentSummaryBucketForUri(record.uri);
    const bucketRecords = buckets.get(bucket) ?? [];
    bucketRecords.push(record);
    buckets.set(bucket, bucketRecords);
  }
  const chunks: CallGraphDocumentSummaryChunk[] = [];
  for (const [bucket, bucketRecords] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bucketRecords.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const file = `document-summaries-${bucket}.json.gz`;
    const encoded = await gzipAsync(Buffer.from(JSON.stringify(bucketRecords), 'utf8'));
    onBytes(encoded.byteLength);
    await fs.promises.writeFile(path.join(cacheDirFsPath, file), encoded);
    chunks.push({ bucket, file, count: bucketRecords.length });
    await yieldToExtensionHost();
  }
  return chunks;
}

function nodeFileUri(fsPath: string): NodeFileUri {
  const normalized = path.resolve(fsPath);
  return {
    scheme: 'file',
    fsPath: normalized,
    toString: () => pathToFileURL(normalized).toString(),
  };
}

function parsePythonFile(
  language: CallGraphLanguage,
  uri: vscode.Uri,
  relPath: string,
  text: string,
  limits: CallGraphParseLimits,
): ParsedFile {
  const lines = text.split(/\r?\n/);
  const symbols: MutableSymbol[] = [];
  const warnings: string[] = [];
  const classStack: MutableSymbol[] = [];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const indent = indentationOf(line);
    while (classStack.length > 0 && (classStack[classStack.length - 1].indent ?? 0) >= indent) {
      classStack.pop();
    }
    const header = readPythonHeader(lines, lineNo);
    const classMatch = /^\s*class\s+([A-Za-z_]\w*)(?:\s*\(([^)]*)\))?\s*:/.exec(header.text);
    if (classMatch) {
      const name = classMatch[1];
      const bodyEnd = findPythonBlockEnd(lines, lineNo, indent);
      const symbol = makeSymbol({
        language,
        uri,
        relPath,
        name,
        qualifiedName: name,
        kind: 'class',
        lineNo,
        column: line.indexOf(name),
        endLine: bodyEnd,
        indent,
        signature: header.text.trim(),
        extendsNames: parseTypeReferenceList(classMatch[2] ?? ''),
      });
      symbols.push(symbol);
      classStack.push(symbol);
      lineNo = header.endLine;
      continue;
    }
    const defMatch = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(header.text);
    if (defMatch) {
      const name = defMatch[1];
      const container = classStack[classStack.length - 1];
      const qualifiedName = container ? `${container.qualifiedName}.${name}` : name;
      const bodyEnd = findPythonBlockEnd(lines, lineNo, indent);
      const decorators = collectPythonDecorators(lines, lineNo, indent);
      const modifiers = decorators.some(isPythonPropertyDecorator) ? ['property' as const] : undefined;
      symbols.push(makeSymbol({
        language,
        uri,
        relPath,
        name,
        qualifiedName,
        kind: container ? 'method' : 'function',
        lineNo,
        column: line.indexOf(name),
        endLine: bodyEnd,
        indent,
        containerId: container?.id,
        containerName: container?.qualifiedName,
        signature: header.text.trim(),
        modifiers,
      }));
      lineNo = header.endLine;
    }
  }
  symbols.push(...extractPythonLambdaFunctions(lines, symbols, uri, relPath, language));
  symbols.push(...extractPythonConstants(lines, symbols, uri, relPath, language));
  const calls = extractCalls(lines, symbols, uri, relPath, language);
  const bindings = extractVariableBindings(lines, symbols, language);
  const referenceCandidates = extractReferenceCandidates(lines, symbols, uri, relPath, language, warnings, limits);
  return { symbols, calls, bindings, referenceCandidates, warnings };
}

function parseBraceFile(
  language: CallGraphLanguage,
  uri: vscode.Uri,
  relPath: string,
  text: string,
  limits: CallGraphParseLimits,
): ParsedFile {
  const lines = text.split(/\r?\n/);
  const symbols: MutableSymbol[] = [];
  const warnings: string[] = [];
  const packageName = readPackageName(language, lines);
  const classSymbols: MutableSymbol[] = [];

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) { continue; }
    const header = couldStartClassHeader(language, trimmed) ? readBraceHeader(lines, lineNo, language) : undefined;
    const classDeclaration = header ? matchClassDeclaration(language, header.text) : undefined;
    if (header && classDeclaration) {
      const endLine = findBraceBlockEnd(lines, lineNo);
      const qualifiedName = packageName ? `${packageName}.${classDeclaration.name}` : classDeclaration.name;
      const nameLocation = findNameLocation(lines, lineNo, header.endLine, classDeclaration.name);
      const symbol = makeSymbol({
        language,
        uri,
        relPath,
        name: classDeclaration.name,
        qualifiedName,
        kind: classDeclaration.kind,
        lineNo: nameLocation.lineNo,
        column: nameLocation.column,
        endLine,
        packageName,
        signature: header.text.trim(),
        modifiers: classDeclaration.modifiers,
        extendsNames: classDeclaration.extendsNames,
        implementsNames: classDeclaration.implementsNames,
      });
      symbols.push(symbol);
      classSymbols.push(symbol);
      lineNo = header.endLine;
    }
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) { continue; }
    const container = innermostClassAt(classSymbols, lineNo);
    if (!couldStartCallableHeader(language, trimmed, container)) { continue; }
    const header = readBraceHeader(lines, lineNo, language);
    const method = matchCallable(language, header.text, container);
    if (!method) { continue; }
    const isConstructor = !!container && (method.name === container.name || method.name === 'constructor' || method.name === 'init');
    const kind: CallGraphSymbolKind = isConstructor ? 'constructor' : container ? 'method' : 'function';
    const qualifiedBase = container
      ? container.qualifiedName
      : packageName;
    const qualifiedName = qualifiedBase ? `${qualifiedBase}.${method.name}` : method.name;
    const endLine = method.hasBody ? findBraceBlockEnd(lines, lineNo) : lineNo;
    const nameLocation = findNameLocation(lines, lineNo, header.endLine, method.name);
    symbols.push(makeSymbol({
      language,
      uri,
      relPath,
      name: method.name,
      qualifiedName,
      kind,
      lineNo: nameLocation.lineNo,
      column: nameLocation.column,
      endLine,
      containerId: container?.id,
      containerName: container?.qualifiedName,
      packageName,
      signature: header.text.trim(),
    }));
    lineNo = header.endLine;
  }

  symbols.push(...extractBraceConstants(language, lines, symbols, uri, relPath, packageName));
  const calls = extractCalls(lines, symbols, uri, relPath, language);
  const bindings = extractVariableBindings(lines, symbols, language);
  const referenceCandidates = extractReferenceCandidates(lines, symbols, uri, relPath, language, warnings, limits);
  return { symbols, calls, bindings, referenceCandidates, warnings };
}

function makeSymbol(input: {
  language: CallGraphLanguage;
  uri: vscode.Uri;
  relPath: string;
  name: string;
  qualifiedName: string;
  kind: CallGraphSymbolKind;
  lineNo: number;
  column: number;
  endLine: number;
  indent?: number;
  containerId?: string;
  containerName?: string;
  packageName?: string;
  signature?: string;
  modifiers?: CallGraphSymbolModifier[];
  extendsNames?: string[];
  implementsNames?: string[];
}): MutableSymbol {
  const column = Math.max(0, input.column);
  const id = `${input.language}:${input.relPath}:${input.qualifiedName}:${input.lineNo + 1}`;
  return {
    id,
    name: input.name,
    qualifiedName: input.qualifiedName,
    kind: input.kind,
    language: input.language,
    uri: input.uri.toString(),
    relPath: input.relPath,
    range: {
      startLine: input.lineNo,
      startColumn: column,
      endLine: input.lineNo,
      endColumn: column + input.name.length,
    },
    bodyRange: {
      startLine: input.lineNo,
      startColumn: 0,
      endLine: Math.max(input.lineNo, input.endLine),
      endColumn: Number.MAX_SAFE_INTEGER,
    },
    indent: input.indent,
    containerId: input.containerId,
    containerName: input.containerName,
    packageName: input.packageName,
    signature: input.signature,
    modifiers: input.modifiers,
    extendsNames: input.extendsNames,
    implementsNames: input.implementsNames,
  };
}

function extractPythonConstants(
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
): MutableSymbol[] {
  const constants: MutableSymbol[] = [];
  const seen = new Set<string>();
  const classSymbols = symbols.filter(isTypeSymbol);
  const callContainers = symbols.filter(isCallableSymbol);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (isInsideCallableBody(lineNo, callContainers)) { continue; }
    const line = stripInlineCommentsAndStrings(lines[lineNo], language);
    const match = /^(\s*)([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/.exec(line);
    if (!match) { continue; }
    const name = match[2];
    const container = innermostClassAt(classSymbols, lineNo);
    const qualifiedName = container ? `${container.qualifiedName}.${name}` : name;
    const key = `${qualifiedName}:${lineNo}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    constants.push(makeSymbol({
      language,
      uri,
      relPath,
      name,
      qualifiedName,
      kind: 'constant',
      lineNo,
      column: lines[lineNo].indexOf(name),
      endLine: lineNo,
      containerId: container?.id,
      containerName: container?.qualifiedName,
      signature: lines[lineNo].trim(),
    }));
  }
  return constants;
}

function extractPythonLambdaFunctions(
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
): MutableSymbol[] {
  const functions: MutableSymbol[] = [];
  const seen = new Set<string>();
  const classSymbols = symbols.filter(isTypeSymbol);
  const callContainers = symbols.filter(isCallableSymbol);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (isInsideCallableBody(lineNo, callContainers)) { continue; }
    const rawLine = lines[lineNo];
    const line = stripInlineCommentsAndStrings(rawLine, language);
    const match = /^(\s*)([A-Za-z_]\w*)\s*=\s*lambda\b/.exec(line);
    if (!match) { continue; }
    const name = match[2];
    const container = innermostClassAt(classSymbols, lineNo);
    const qualifiedName = container ? `${container.qualifiedName}.${name}` : name;
    const key = `${qualifiedName}:${lineNo}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    functions.push(makeSymbol({
      language,
      uri,
      relPath,
      name,
      qualifiedName,
      kind: 'function',
      lineNo,
      column: rawLine.indexOf(name),
      endLine: lineNo,
      containerId: container?.id,
      containerName: container?.qualifiedName,
      signature: rawLine.trim(),
    }));
  }
  return functions;
}

function extractBraceConstants(
  language: CallGraphLanguage,
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  packageName?: string,
): MutableSymbol[] {
  const constants: MutableSymbol[] = [];
  const seen = new Set<string>();
  const classSymbols = symbols.filter(isTypeSymbol);
  const callContainers = symbols.filter(isCallableSymbol);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (isInsideCallableBody(lineNo, callContainers)) { continue; }
    const rawLine = lines[lineNo];
    const line = stripInlineCommentsAndStrings(rawLine, language);
    const matched = matchConstantDeclaration(language, line);
    if (!matched) { continue; }
    const container = innermostClassAt(classSymbols, lineNo);
    const qualifiedBase = container?.qualifiedName ?? packageName;
    const qualifiedName = qualifiedBase ? `${qualifiedBase}.${matched.name}` : matched.name;
    const key = `${qualifiedName}:${lineNo}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    constants.push(makeSymbol({
      language,
      uri,
      relPath,
      name: matched.name,
      qualifiedName,
      kind: 'constant',
      lineNo,
      column: rawLine.indexOf(matched.name),
      endLine: lineNo,
      containerId: container?.id,
      containerName: container?.qualifiedName,
      packageName,
      signature: rawLine.trim(),
    }));
  }
  return constants;
}

function extractCalls(
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
): CallGraphCallSite[] {
  const callsites: CallGraphCallSite[] = [];
  const propertyNames = new Set(
    symbols
      .filter((symbol) => symbol.language === language && symbol.modifiers?.includes('property'))
      .map((symbol) => symbol.name),
  );
  const callContainers = symbols
    .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor')
    .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
  for (const caller of callContainers) {
    for (let lineNo = caller.bodyRange.startLine; lineNo <= caller.bodyRange.endLine && lineNo < lines.length; lineNo++) {
      const rawLine = lines[lineNo];
      const line = stripInlineCommentsAndStrings(rawLine, language);
      for (const call of findCallsInLine(line, rawLine, lineNo, uri, relPath, caller.id, language, propertyNames)) {
        if (lineNo === caller.range.startLine && declarationContainsName(caller, call.name, rawLine)) {
          continue;
        }
        callsites.push(call);
      }
    }
  }
  return dedupeCallSites(callsites);
}

function extractVariableBindings(
  lines: string[],
  symbols: MutableSymbol[],
  language: CallGraphLanguage,
): CallGraphVariableBinding[] {
  const bindings: CallGraphVariableBinding[] = [];
  const callContainers = symbols
    .filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor')
    .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
  bindings.push(...extractParameterBindings(symbols, language));
  for (const owner of callContainers) {
    for (let lineNo = owner.bodyRange.startLine; lineNo <= owner.bodyRange.endLine && lineNo < lines.length; lineNo++) {
      const rawLine = lines[lineNo];
      const line = stripInlineCommentsAndStrings(rawLine, language);
      for (const binding of findVariableBindingsInLine(line, lineNo, owner.id, language)) {
        bindings.push(binding);
      }
    }
  }
  bindings.push(...extractMemberVariableBindings(lines, symbols, callContainers, language));
  return dedupeVariableBindings(bindings);
}

function extractReferenceCandidates(
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
  warnings: string[],
  limits: CallGraphParseLimits,
): CallGraphReferenceCandidate[] {
  const references: CallGraphReferenceCandidate[] = [];
  const callContainers = symbols
    .filter(isCallableSymbol)
    .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
  const tokenRegex = /\b[A-Z][A-Za-z0-9_$]*\b/g;
  let assignedFunctionNames = dedupeStrings(symbols
    .filter(isAnonymousFunctionAssignmentSymbol)
    .map((symbol) => symbol.name));
  if (limits.maxAssignedFunctionNamesPerFile > 0 &&
      assignedFunctionNames.length > limits.maxAssignedFunctionNamesPerFile) {
    warnings.push(
      `limited assigned function usage scan in ${relPath}: ` +
      `${assignedFunctionNames.length} names > ${limits.maxAssignedFunctionNamesPerFile}`,
    );
    assignedFunctionNames = assignedFunctionNames.slice(0, limits.maxAssignedFunctionNamesPerFile);
  }
  references.push(...extractExportedApiReferenceCandidates(lines, symbols, uri, relPath, language));
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
    const rawLine = lines[lineNo];
    const line = stripInlineCommentsAndStrings(rawLine, language);
    const enclosing = innermostCallableAt(callContainers, lineNo);
    references.push(...findExternalReferenceCandidatesInLine(line, rawLine, lineNo, uri, relPath, language));
    if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
    for (const match of line.matchAll(tokenRegex)) {
      const name = match[0];
      const start = match.index ?? 0;
      const end = start + name.length;
      references.push({
        name,
        rawText: rawLine.slice(start, Math.min(rawLine.length, end)),
        uri: uri.toString(),
        relPath,
        range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: end },
        enclosingSymbolId: enclosing?.id,
        receiver: readReferenceReceiver(line, start),
      });
      if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
    }
    if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
    for (const name of assignedFunctionNames) {
      if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) { continue; }
      for (const start of findIdentifierOccurrences(line, name)) {
        const end = start + name.length;
        references.push({
          name,
          rawText: rawLine.slice(start, Math.min(rawLine.length, end)),
          uri: uri.toString(),
          relPath,
          range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: end },
          enclosingSymbolId: enclosing?.id,
          receiver: readReferenceReceiver(line, start),
        });
        if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
      }
      if (isReferenceCandidateLimitReached(references, limits, warnings, relPath)) { break; }
    }
  }
  return references;
}

function extractExportedApiReferenceCandidates(
  lines: string[],
  symbols: MutableSymbol[],
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
): CallGraphReferenceCandidate[] {
  const references: CallGraphReferenceCandidate[] = [];
  for (const symbol of symbols) {
    if (!isExternalApiSymbol(symbol)) { continue; }
    const line = lines[symbol.range.startLine] ?? symbol.signature ?? symbol.name;
    references.push({
      name: symbol.name,
      rawText: line.trim(),
      uri: uri.toString(),
      relPath,
      range: symbol.range,
      allowCallableTarget: true,
      allowDeclarationRange: true,
    });
  }
  if (language === 'python') {
    references.push(...findPythonAllReferenceCandidates(lines, uri, relPath));
  }
  return references;
}

function isReferenceCandidateLimitReached(
  references: readonly CallGraphReferenceCandidate[],
  limits: CallGraphParseLimits,
  warnings: string[],
  relPath: string,
): boolean {
  if (limits.maxReferenceCandidatesPerFile <= 0) { return false; }
  if (references.length < limits.maxReferenceCandidatesPerFile) { return false; }
  if (!warnings.some((warning) => warning.includes(`limited reference candidates in ${relPath}:`))) {
    warnings.push(`limited reference candidates in ${relPath}: reached ${limits.maxReferenceCandidatesPerFile}`);
  }
  return true;
}

function findExternalReferenceCandidatesInLine(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
  language: CallGraphLanguage,
): CallGraphReferenceCandidate[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return findEcmaImportExportReferenceCandidates(line, rawLine, lineNo, uri, relPath);
    case 'python':
      return findPythonImportReferenceCandidates(line, rawLine, lineNo, uri, relPath);
    case 'java':
    case 'kotlin':
      return findStaticImportReferenceCandidates(line, rawLine, lineNo, uri, relPath);
    case 'graphql':
      return [];
  }
}

function findEcmaImportExportReferenceCandidates(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
): CallGraphReferenceCandidate[] {
  const trimmed = line.trim();
  const references: CallGraphReferenceCandidate[] = [];
  const importNamed = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\b/.exec(trimmed);
  if (importNamed) {
    references.push(...namesFromImportExportList(importNamed[1]).flatMap((name) =>
      makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, name, true)));
  }
  const exportNamed = /^export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\b)?/.exec(trimmed);
  if (exportNamed) {
    references.push(...namesFromImportExportList(exportNamed[1]).flatMap((name) =>
      makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, name, true)));
  }
  const defaultImport = /^import\s+([A-Za-z_$][\w$]*)\s+from\b/.exec(trimmed);
  if (defaultImport) {
    references.push(...makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, defaultImport[1], true));
  }
  const defaultExport = /^export\s+default\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed);
  if (defaultExport && !CALL_KEYWORDS.has(defaultExport[1])) {
    references.push(...makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, defaultExport[1], true));
  }
  return references;
}

function findPythonImportReferenceCandidates(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
): CallGraphReferenceCandidate[] {
  const match = /^\s*from\s+[\w.]+\s+import\s+(.+)/.exec(line);
  if (!match) { return []; }
  const names = match[1].split(',')
    .map((part) => part.trim())
    .filter((part) => part && part !== '*')
    .map((part) => part.split(/\s+as\s+/)[0]?.trim())
    .filter((name): name is string => !!name && /^[A-Za-z_]\w*$/.test(name));
  return names.flatMap((name) => makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, name, true));
}

function findPythonAllReferenceCandidates(
  lines: string[],
  uri: vscode.Uri,
  relPath: string,
): CallGraphReferenceCandidate[] {
  const references: CallGraphReferenceCandidate[] = [];
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const match = /^\s*__all__\s*=\s*\[([^\]]*)\]/.exec(rawLine);
    if (!match) { continue; }
    for (const item of match[1].matchAll(/(['"])([A-Za-z_]\w*)\1/g)) {
      const name = item[2];
      const quoteOffset = item.index ?? 0;
      const start = rawLine.indexOf(name, (match.index ?? 0) + quoteOffset);
      if (start < 0) { continue; }
      references.push({
        name,
        rawText: rawLine.slice(start, start + name.length),
        uri: uri.toString(),
        relPath,
        range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: start + name.length },
        allowCallableTarget: true,
      });
    }
  }
  return references;
}

function findStaticImportReferenceCandidates(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
): CallGraphReferenceCandidate[] {
  const javaStatic = /^\s*import\s+static\s+[\w.]+\.([A-Za-z_$][\w$*]*)\s*;/.exec(line);
  const kotlinStatic = /^\s*import\s+[\w.]+\.([A-Za-z_]\w*)\s*$/.exec(line);
  const name = javaStatic?.[1] !== '*' ? javaStatic?.[1] : kotlinStatic?.[1];
  if (!name) { return []; }
  return makeReferenceCandidatesForName(line, rawLine, lineNo, uri, relPath, name, true);
}

function namesFromImportExportList(list: string): string[] {
  return list.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name] = part.split(/\s+as\s+/);
      return name?.trim();
    })
    .filter((name): name is string => !!name && /^[A-Za-z_$][\w$]*$/.test(name));
}

function makeReferenceCandidatesForName(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
  name: string,
  allowCallableTarget: boolean,
): CallGraphReferenceCandidate[] {
  return findIdentifierOccurrences(line, name).map((start) => ({
    name,
    rawText: rawLine.slice(start, Math.min(rawLine.length, start + name.length)),
    uri: uri.toString(),
    relPath,
    range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: start + name.length },
    allowCallableTarget,
  }));
}

function extractParameterBindings(
  symbols: MutableSymbol[],
  language: CallGraphLanguage,
): CallGraphVariableBinding[] {
  const bindings: CallGraphVariableBinding[] = [];
  const callContainers = symbols.filter(isCallableSymbol);
  for (const owner of callContainers) {
    const signature = owner.signature ?? '';
    const parameterList = readParameterList(signature);
    if (!parameterList) { continue; }
    for (const candidate of findParameterBindingCandidates(parameterList, owner.range.startLine, language)) {
      for (const variableName of candidate.variableNames) {
        bindings.push({
          variableName: normalizeReceiver(variableName),
          className: normalizeBindingClassName(candidate.className),
          enclosingSymbolId: owner.id,
          range: candidate.range,
        });
      }
    }
  }
  return bindings;
}

function extractMemberVariableBindings(
  lines: string[],
  symbols: MutableSymbol[],
  callContainers: MutableSymbol[],
  language: CallGraphLanguage,
): CallGraphVariableBinding[] {
  const bindings: CallGraphVariableBinding[] = [];
  const classSymbols = symbols.filter(isTypeSymbol);
  for (const classSymbol of classSymbols) {
    const owners = callContainers.filter((owner) => owner.containerName === classSymbol.qualifiedName);
    if (owners.length === 0) { continue; }
    for (let lineNo = classSymbol.bodyRange.startLine; lineNo <= classSymbol.bodyRange.endLine && lineNo < lines.length; lineNo++) {
      if (innermostClassAt(classSymbols, lineNo)?.id !== classSymbol.id) { continue; }
      const rawLine = lines[lineNo];
      const line = stripInlineCommentsAndStrings(rawLine, language);
      const insideCallable = !!innermostCallableAt(callContainers, lineNo);
      for (const candidate of findMemberBindingCandidates(line, lineNo, language, !insideCallable)) {
        for (const owner of owners) {
          for (const variableName of candidate.variableNames) {
            bindings.push({
              variableName: normalizeReceiver(variableName),
              className: normalizeBindingClassName(candidate.className),
              enclosingSymbolId: owner.id,
              range: candidate.range,
            });
          }
        }
      }
    }
  }
  return bindings;
}

function findParameterBindingCandidates(
  parameterList: string,
  lineNo: number,
  language: CallGraphLanguage,
): VariableBindingCandidate[] {
  const candidates: VariableBindingCandidate[] = [];
  for (const rawParameter of splitParameterList(parameterList)) {
    const parameter = stripParameterDefault(rawParameter).trim();
    if (!parameter || /^[{[]/.test(parameter)) { continue; }
    let match: RegExpExecArray | null = null;
    const add = (variableName: string, className: string | undefined, column: number, width?: number) => {
      if (!variableName || variableName === 'self' || variableName === 'cls') { return; }
      const normalizedClassName = extractLikelyBindingClassName(className);
      if (!normalizedClassName) { return; }
      candidates.push(variableCandidate([variableName], normalizedClassName, lineNo, column, width ?? variableName.length));
    };

    if (language === 'python') {
      match = /^(\*{0,2})([A-Za-z_]\w*)\s*:\s*([^=]+)$/.exec(parameter);
      if (match) {
        const column = parameter.indexOf(match[2]);
        add(match[2], match[3], column, match[2].length);
      }
      continue;
    }
    if (language === 'java') {
      match = /^(?:(?:final)\s+)*(?:@\w+(?:\([^)]*\))?\s+)*([A-Z][\w$.]*(?:<[^>]+>)?(?:\[\])?)\s*\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(parameter);
      if (match) {
        add(match[2], match[1], parameter.indexOf(match[2]), match[2].length);
        continue;
      }
      match = /^(?:(?:final)\s+)*(?:@\w+(?:\([^)]*\))?\s+)*([A-Z][\w$.]*(?:<[^>]+>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)$/.exec(parameter);
      if (match) {
        add(match[2], match[1], parameter.indexOf(match[2]), match[2].length);
      }
      continue;
    }
    match = /^(?:(?:public|private|protected|readonly|override|final|open|val|var|vararg|crossinline|noinline)\s+)*(?:\.\.\.)?([A-Za-z_$][\w$]*)\??\s*:\s*([A-Z][\w$.]*(?:<[^>]+>)?(?:\[\])?)/.exec(parameter);
    if (match) {
      add(match[1], match[2], parameter.indexOf(match[1]), match[1].length);
    }
  }
  return candidates.filter((candidate) => !!candidate.className);
}

function findMemberBindingCandidates(
  line: string,
  lineNo: number,
  language: CallGraphLanguage,
  includeFieldDeclarations: boolean,
): VariableBindingCandidate[] {
  const candidates: VariableBindingCandidate[] = [];
  const add = (variableNames: string[], className: string | undefined, column: number, width?: number) => {
    if (!className) { return; }
    const normalized = normalizeBindingClassName(className);
    if (!normalized) { return; }
    candidates.push(variableCandidate(variableNames, normalized, lineNo, column, width ?? variableNames[0]?.length ?? 1));
  };

  if (language === 'python') {
    const memberAssignment = /\b((?:self|cls)\.[A-Za-z_]\w*)\s*(?::\s*([A-Z][\w.]*)(?:\[[^\]]*\])?)?\s*=\s*([A-Z][A-Za-z_]\w*)?\s*\(/g;
    for (const match of line.matchAll(memberAssignment)) {
      add([match[1]], match[2] || match[3], match.index ?? 0, match[1].length);
    }
    if (includeFieldDeclarations) {
      const typedField = /^\s*([A-Za-z_]\w*)\s*:\s*([A-Z][\w.]*)(?:\[[^\]]*\])?/.exec(line);
      if (typedField) {
        add([`self.${typedField[1]}`, `cls.${typedField[1]}`, typedField[1]], typedField[2], line.indexOf(typedField[1]), typedField[1].length);
      }
      const constructedField = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Z][A-Za-z_]\w*)\s*\(/.exec(line);
      if (constructedField) {
        add([`self.${constructedField[1]}`, `cls.${constructedField[1]}`, constructedField[1]], constructedField[2], line.indexOf(constructedField[1]), constructedField[1].length);
      }
    }
    return candidates;
  }

  if (language === 'typescript' || language === 'javascript') {
    const memberAssignment = /\b(this\.[A-Za-z_$][\w$]*)\s*(?::\s*([A-Z][\w$.]*(?:<[^>]+>)?))?\s*=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)?\s*\(/g;
    for (const match of line.matchAll(memberAssignment)) {
      add([match[1]], match[2] || match[3], match.index ?? 0, match[1].length);
    }
    if (includeFieldDeclarations) {
      const constructorParams = /\bconstructor\s*\((.*)\)/.exec(line)?.[1];
      if (constructorParams) {
        for (const candidate of findParameterBindingCandidates(constructorParams, lineNo, language)) {
          const names = candidate.variableNames.flatMap((name) => [`this.${name}`]);
          add(names, candidate.className, candidate.range.startColumn, names[0]?.length);
        }
      }
      const field = /^(?:\s*)(?:(?:public|private|protected|static|readonly|declare|override|accessor)\s+)*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Z][\w$.]*(?:<[^>]+>)?))?\s*(?:=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)\s*\()?/.exec(line);
      if (field && (field[2] || field[3]) && !CALL_KEYWORDS.has(field[1])) {
        add([`this.${field[1]}`], field[2] || field[3], line.indexOf(field[1]), field[1].length);
      }
    }
    return candidates;
  }

  if (language === 'kotlin') {
    const memberAssignment = /\b(this\.[A-Za-z_]\w*)\s*(?::\s*([A-Z][\w.]*(?:<[^>]+>)?))?\s*=\s*([A-Z][A-Za-z_]\w*)?\s*\(/g;
    for (const match of line.matchAll(memberAssignment)) {
      add([match[1]], match[2] || match[3], match.index ?? 0, match[1].length);
    }
    if (includeFieldDeclarations) {
      const classParams = /\bclass\s+[A-Za-z_]\w*[^{(]*\((.*)\)/.exec(line)?.[1];
      if (classParams) {
        for (const candidate of findParameterBindingCandidates(classParams, lineNo, language)) {
          const names = candidate.variableNames.flatMap((name) => [name, `this.${name}`]);
          add(names, candidate.className, candidate.range.startColumn, names[0]?.length);
        }
      }
      const field = /^\s*(?:(?:private|public|protected|internal|override|lateinit|const)\s+)*(?:val|var)\s+([A-Za-z_]\w*)\s*(?::\s*([A-Z][\w.]*(?:<[^>]+>)?))?\s*(?:=\s*([A-Z][A-Za-z_]\w*)\s*\()?/.exec(line);
      if (field && (field[2] || field[3])) {
        add([field[1], `this.${field[1]}`], field[2] || field[3], line.indexOf(field[1]), field[1].length);
      }
    }
    return candidates;
  }

  const memberAssignment = /\b(this\.[A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of line.matchAll(memberAssignment)) {
    add([match[1]], match[2], match.index ?? 0, match[1].length);
  }
  if (includeFieldDeclarations) {
    const field = /^(?:\s*)(?:(?:public|private|protected|static|final|volatile|transient)\s+)*([A-Z][\w$.]*(?:<[^>]+>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:[=;]|$)/.exec(line);
    if (field) {
      add([field[2], `this.${field[2]}`], field[1], line.indexOf(field[2]), field[2].length);
    }
  }
  return candidates;
}

function variableCandidate(
  variableNames: string[],
  className: string,
  lineNo: number,
  column: number,
  width: number,
): VariableBindingCandidate {
  return {
    variableNames: variableNames.filter(Boolean),
    className,
    range: {
      startLine: lineNo,
      startColumn: Math.max(0, column),
      endLine: lineNo,
      endColumn: Math.max(0, column) + Math.max(1, width),
    },
  };
}

function findVariableBindingsInLine(
  line: string,
  lineNo: number,
  enclosingSymbolId: string,
  language: CallGraphLanguage,
): CallGraphVariableBinding[] {
  const out: CallGraphVariableBinding[] = [];
  const add = (variableName: string, className: string, column: number) => {
    if (!variableName || !className) { return; }
    const normalizedClassName = normalizeBindingClassName(className);
    if (!normalizedClassName) { return; }
    out.push({
      variableName: normalizeReceiver(variableName),
      className: normalizedClassName,
      enclosingSymbolId,
      range: {
        startLine: lineNo,
        startColumn: Math.max(0, column),
        endLine: lineNo,
        endColumn: Math.max(0, column) + variableName.length,
      },
    });
  };

  if (language === 'python') {
    const assignment = /\b((?:self|cls)\.[A-Za-z_]\w*|[A-Za-z_]\w*)\s*(?::\s*([A-Z][\w.]*)(?:\[[^\]]*\])?)?\s*=\s*([A-Z][A-Za-z_]\w*)?\s*\(/g;
    for (const match of line.matchAll(assignment)) {
      add(match[1], match[2] || match[3], match.index ?? 0);
    }
    return out;
  }

  if (language === 'kotlin') {
    const kotlin = /\b(?:val|var)\s+([A-Za-z_]\w*)\s*(?::\s*([A-Z][\w.]*(?:<[^>]+>)?))?\s*(?:=\s*([A-Z][A-Za-z_]\w*)?\s*\()?/g;
    for (const match of line.matchAll(kotlin)) {
      add(match[1], match[2] || match[3], match.index ?? 0);
    }
    return out;
  }

  if (language === 'typescript' || language === 'javascript') {
    const variable = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Z][\w$.]*(?:<[^>]+>)?))?\s*(?:=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)?\s*\()?/g;
    for (const match of line.matchAll(variable)) {
      add(match[1], match[2] || match[3], match.index ?? 0);
    }
    const property = /\b(this\.[A-Za-z_$][\w$]*)\s*(?::\s*([A-Z][\w$.]*(?:<[^>]+>)?))?\s*=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)?\s*\(/g;
    for (const match of line.matchAll(property)) {
      add(match[1], match[2] || match[3], match.index ?? 0);
    }
    return out;
  }

  const java = /\b([A-Z][A-Za-z_$][\w$<>.\[\]]*)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:new\s+)?([A-Z][A-Za-z_$][\w$]*)?\s*\()?/g;
  for (const match of line.matchAll(java)) {
    add(match[2], match[3] || match[1], match.index ?? 0);
  }
  return out;
}

function findCallsInLine(
  line: string,
  rawLine: string,
  lineNo: number,
  uri: vscode.Uri,
  relPath: string,
  enclosingSymbolId: string,
  language: CallGraphLanguage,
  propertyNames: ReadonlySet<string>,
): CallGraphCallSite[] {
  const calls: CallGraphCallSite[] = [];
  const receiverHead = String.raw`(?:super\s*\(\s*\)|[A-Za-z_$][\w$]*|this|self|cls)(?:\s*(?:\?\.)?\[[^\]]+\])*`;
  const receiverTail = String.raw`(?:\s*(?:\.|\?\.|!!\.)\s*[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\[[^\]]+\])*)*`;
  const memberRegex = new RegExp(String.raw`\b(${receiverHead}${receiverTail})\s*(?:\.|\?\.|!!\.)\s*([A-Za-z_$][\w$]*)\s*(?:\(|\?\.\()`, 'g');
  for (const match of line.matchAll(memberRegex)) {
    const receiver = normalizeReceiver(match[1]);
    const name = match[2];
    if (CALL_KEYWORDS.has(name)) { continue; }
    const start = match.index ?? 0;
    const rawText = rawLine.slice(start, Math.min(rawLine.length, start + match[0].length));
    calls.push({
      name,
      receiver,
      rawText,
      uri: uri.toString(),
      relPath,
      enclosingSymbolId,
      range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: start + match[0].length },
    });
  }

  if (language === 'python' && propertyNames.size > 0) {
    const propertyReceiverHead = String.raw`(?:[A-Za-z_$][\w$]*|self|cls)(?:\s*(?:\?\.)?\[[^\]]+\])*`;
    const propertyReceiverTail = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\[[^\]]+\])*)*`;
    const propertyRegex = new RegExp(String.raw`\b(${propertyReceiverHead}${propertyReceiverTail})\s*\.\s*([A-Za-z_$][\w$]*)\b`, 'g');
    for (const match of line.matchAll(propertyRegex)) {
      const name = match[2];
      if (!propertyNames.has(name)) { continue; }
      const end = (match.index ?? 0) + match[0].length;
      if (line.slice(end).match(/^\s*\(/)) { continue; }
      const alreadyCall = calls.some((call) => call.range.startLine === lineNo && end >= call.range.startColumn && end <= call.range.endColumn);
      if (alreadyCall) { continue; }
      const start = match.index ?? 0;
      calls.push({
        name,
        receiver: normalizeReceiver(match[1]),
        rawText: rawLine.slice(start, Math.min(rawLine.length, end)),
        uri: uri.toString(),
        relPath,
        enclosingSymbolId,
        range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: end },
      });
    }
  }

  const constructorRegex = language === 'python'
    ? /\b([A-Z][A-Za-z_$][\w$]*)\s*\(/g
    : /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of line.matchAll(constructorRegex)) {
    const name = match[1];
    const start = match.index ?? 0;
    calls.push({
      name,
      rawText: rawLine.slice(start, Math.min(rawLine.length, start + match[0].length)),
      uri: uri.toString(),
      relPath,
      enclosingSymbolId,
      range: { startLine: lineNo, startColumn: start, endLine: lineNo, endColumn: start + match[0].length },
    });
  }

  const directRegex = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?:\(|\?\.\()/g;
  for (const match of line.matchAll(directRegex)) {
    const name = match[2];
    if (CALL_KEYWORDS.has(name)) { continue; }
    const prefix = match[1] ?? '';
    const nameStart = (match.index ?? 0) + prefix.length;
    const alreadyMember = calls.some((call) => call.range.startLine === lineNo && nameStart >= call.range.startColumn && nameStart <= call.range.endColumn);
    if (alreadyMember) { continue; }
    calls.push({
      name,
      rawText: rawLine.slice(nameStart, Math.min(rawLine.length, nameStart + name.length + 1)),
      uri: uri.toString(),
      relPath,
      enclosingSymbolId,
      range: { startLine: lineNo, startColumn: nameStart, endLine: lineNo, endColumn: nameStart + name.length + 1 },
    });
  }
  return calls;
}

function resolveReferenceCandidates(
  candidates: CallGraphReferenceCandidate[],
  symbols: CallGraphSymbol[],
  index: SymbolIndex,
): CallGraphReference[] {
  const referenceable = symbols.filter(isReferenceableSymbol);
  const callableReferenceable = symbols.filter((symbol) => isReferenceableSymbol(symbol) || isCallableSymbol(symbol));
  if ((referenceable.length === 0 && callableReferenceable.length === 0) || candidates.length === 0) { return []; }
  const symbolsByName = new Map<string, CallGraphSymbol[]>();
  const symbolsByFileAndName = new Map<string, CallGraphSymbol[]>();
  for (const symbol of referenceable) {
    pushMap(symbolsByName, symbol.name, symbol);
    pushMap(symbolsByFileAndName, `${symbol.relPath}:${symbol.name}`, symbol);
  }
  const callableSymbolsByName = new Map<string, CallGraphSymbol[]>();
  const callableSymbolsByFileAndName = new Map<string, CallGraphSymbol[]>();
  for (const symbol of callableReferenceable) {
    pushMap(callableSymbolsByName, symbol.name, symbol);
    pushMap(callableSymbolsByFileAndName, `${symbol.relPath}:${symbol.name}`, symbol);
  }
  const references: CallGraphReference[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const target = candidate.allowCallableTarget
      ? resolveReferenceTarget(candidate, callableSymbolsByName, callableSymbolsByFileAndName, index)
      : resolveReferenceTarget(candidate, symbolsByName, symbolsByFileAndName, index);
    if (!target || (!candidate.allowDeclarationRange && sameRange(candidate.range, target.range))) { continue; }
    const key = `${target.id}:${candidate.uri}:${candidate.range.startLine}:${candidate.range.startColumn}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    references.push({
      symbolId: target.id,
      name: candidate.name,
      rawText: candidate.rawText,
      uri: candidate.uri,
      relPath: candidate.relPath,
      range: candidate.range,
      enclosingSymbolId: candidate.enclosingSymbolId,
    });
  }
  return references;
}

function resolveReferenceTarget(
  candidate: CallGraphReferenceCandidate,
  symbolsByName: Map<string, CallGraphSymbol[]>,
  symbolsByFileAndName: Map<string, CallGraphSymbol[]>,
  index: SymbolIndex,
): CallGraphSymbol | undefined {
  const sameFile = symbolsByFileAndName.get(`${candidate.relPath}:${candidate.name}`) ?? [];
  if (candidate.receiver) {
    const receiverTypes = index.byClassName.get(lastQualifiedPart(candidate.receiver)) ?? [];
    for (const type of receiverTypes) {
      const match = sameFile.find((symbol) => symbol.containerName === type.qualifiedName && symbol.name === candidate.name)
        ?? (symbolsByName.get(candidate.name) ?? []).find((symbol) => symbol.containerName === type.qualifiedName);
      if (match) { return match; }
    }
  }
  if (sameFile.length === 1) { return sameFile[0]; }
  const global = symbolsByName.get(candidate.name) ?? [];
  const sameLanguage = global.filter((symbol) => symbol.language === languageFromRelPath(candidate.relPath));
  if (sameLanguage.length === 1) { return sameLanguage[0]; }
  return global.length === 1 ? global[0] : undefined;
}

async function resolveCallsAsync(
  calls: CallGraphCallSite[],
  index: SymbolIndex,
  options: {
    token?: vscode.CancellationToken;
    resolveOptions: CallGraphResolveOptions;
    onProgress?: (current: number, total: number) => void;
  },
): Promise<ResolveCallsResult> {
  const edges: CallGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let skippedPossibleEdgeCount = 0;
  let skippedUnresolvedEdgeCount = 0;
  let edgeLimitHit = false;
  const chunkSize = 2_000;
  const pushEdge = (edge: CallGraphEdge): void => {
    const key = edgeIdentityKey(edge);
    if (edgeKeys.has(key)) { return; }
    if (options.resolveOptions.maxEdges !== undefined && edgeKeys.size >= options.resolveOptions.maxEdges) {
      edgeLimitHit = true;
      return;
    }
    edgeKeys.add(key);
    edges.push(edge);
  };
  for (let i = 0; i < calls.length; i++) {
    if (options.token?.isCancellationRequested) {
      throw new CallGraphRebuildCancelledError();
    }
    const call = calls[i];
    const caller = index.byId.get(call.enclosingSymbolId);
    if (!caller) { continue; }
    const resolvedAll = resolveCall(call, caller, index, options.resolveOptions);
    const possibleCount = resolvedAll.filter((target) => target.confidence === 'possible').length;
    const resolved = options.resolveOptions.includePossibleEdges
      ? resolvedAll
      : resolvedAll.filter((target) => target.confidence !== 'possible');
    if (!options.resolveOptions.includePossibleEdges) {
      skippedPossibleEdgeCount += possibleCount;
    }
    if (resolved.length === 0) {
      if (options.resolveOptions.includeUnresolvedEdges) {
        pushEdge(makeEdge(call, caller.id, undefined, unresolvedCalleeName(call), 'dynamic', 'unresolved', [
          possibleCount > 0
            ? `${possibleCount} possible static target(s) suppressed; retained as dynamic/external call`
            : 'no static target matched indexed symbols; retained as dynamic/external call',
        ]));
      } else {
        skippedUnresolvedEdgeCount += 1;
      }
      continue;
    }
    for (const target of resolved) {
      pushEdge(makeEdge(
        call,
        caller.id,
        target.symbol.id,
        target.symbol.qualifiedName,
        target.kind,
        target.confidence,
        target.evidence,
      ));
    }
    if ((i + 1) % chunkSize === 0) {
      options.onProgress?.(i + 1, calls.length);
      await yieldToExtensionHost();
    }
  }
  options.onProgress?.(calls.length, calls.length);
  return {
    edges,
    skippedPossibleEdgeCount,
    skippedUnresolvedEdgeCount,
    edgeLimitHit,
  };
}

function resolveCall(
  call: CallGraphCallSite,
  caller: CallGraphSymbol,
  index: SymbolIndex,
  options: CallGraphResolveOptions,
): ResolvedCallTarget[] {
  const receiver = call.receiver;
  const className = caller.containerName ? lastQualifiedPart(caller.containerName) : undefined;
  const containerType = caller.containerName ? findTypeSymbol(caller.containerName, index) : undefined;
  if (receiver === 'super') {
    const parentMatches = containerType ? findInheritedMethodMatches(containerType, call.name, index) : [];
    return parentMatches.map((match) => ({
      symbol: match.symbol,
      kind: 'method' as const,
      confidence: 'exact' as const,
      evidence: [`receiver super resolved through parent type ${match.owner.qualifiedName}`],
    }));
  }

  if (receiver === 'this' || receiver === 'self' || receiver === 'cls') {
    const classMethods = containerType ? findMethodMatchesForType(containerType, call.name, index, true) : [];
    return classMethods.map((match) => ({
      symbol: match.symbol,
      kind: 'method' as const,
      confidence: match.inherited ? 'resolved' as const : 'exact' as const,
      evidence: [match.inherited
        ? `receiver ${receiver} resolved to inherited method from ${match.owner.qualifiedName}`
        : `receiver ${receiver} resolved to enclosing class ${className}`],
    }));
  }

  if (receiver) {
    const boundClassName = index.bindingsBySymbolId.get(caller.id)?.get(receiver)?.className;
    if (boundClassName) {
      const boundTargets = findMethodMatchesForTypeName(boundClassName, call.name, index, true);
      if (boundTargets.length > 0) {
        return boundTargets.map((match) => ({
          symbol: match.symbol,
          kind: 'method' as const,
          confidence: match.inherited ? 'resolved' as const : 'exact' as const,
          evidence: [match.inherited
            ? `receiver ${receiver} resolved from binding ${boundClassName} through inherited method ${match.owner.qualifiedName}`
            : `receiver ${receiver} resolved from local constructor/type binding ${boundClassName}`],
        }));
      }
    }
    const receiverClasses = index.byClassName.get(receiver) ?? [];
    const staticTargets = receiverClasses.flatMap((classSymbol) => findMethodMatchesForType(classSymbol, call.name, index, true));
    if (staticTargets.length > 0) {
      return staticTargets.map((match) => ({
        symbol: match.symbol,
        kind: 'static' as const,
        confidence: 'resolved' as const,
        evidence: [match.inherited
          ? `receiver ${receiver} matched indexed class and inherited method from ${match.owner.qualifiedName}`
          : `receiver ${receiver} matched indexed class`],
      }));
    }
    if (!options.includePossibleEdges) {
      return [];
    }
    const possibleMethods = collectMethodNameMatches(call.name, index).slice(0, options.maxPossibleTargetsPerCall);
    return possibleMethods.map((symbol) => ({
      symbol,
      kind: 'virtual' as const,
      confidence: 'possible' as const,
      evidence: [`receiver ${receiver} type is unknown; matched method name`],
    }));
  }

  const enclosingClassTargets = containerType
    ? findMethodMatchesForType(containerType, call.name, index, true)
      .filter((match) => match.symbol.id !== caller.id)
    : [];
  if (enclosingClassTargets.length > 0) {
    return enclosingClassTargets.map((match) => ({
      symbol: match.symbol,
      kind: 'method' as const,
      confidence: match.inherited ? 'resolved' as const : 'exact' as const,
      evidence: [match.inherited
        ? `unqualified call resolved to inherited method from ${match.owner.qualifiedName}`
        : `unqualified call resolved to enclosing class ${className}`],
    }));
  }

  const constructors = (index.byClassName.get(call.name) ?? []).filter((symbol) => symbol.kind === 'class');
  if (constructors.length > 0) {
    return constructors.map((symbol) => ({
      symbol,
      kind: 'constructor' as const,
      confidence: 'exact' as const,
      evidence: ['call name matched indexed class'],
    }));
  }

  const sameFile = (index.byName.get(call.name) ?? [])
    .filter((symbol) => isCallableSymbol(symbol) && symbol.relPath === caller.relPath && symbol.id !== caller.id);
  if (sameFile.length === 1) {
    return [{
      symbol: sameFile[0],
      kind: sameFile[0].kind === 'method' ? 'method' : 'direct',
      confidence: 'exact',
      evidence: ['unique same-file symbol name match'],
    }];
  }
  if (sameFile.length > 1) {
    if (!options.includePossibleEdges) {
      return [];
    }
    return sameFile.slice(0, options.maxPossibleTargetsPerCall).map((symbol) => ({
      symbol,
      kind: symbol.kind === 'method' ? 'method' as const : 'direct' as const,
      confidence: 'possible' as const,
      evidence: ['ambiguous same-file symbol name match'],
    }));
  }

  const globalMatches = (index.byName.get(call.name) ?? []).filter((symbol) => isCallableSymbol(symbol) && symbol.id !== caller.id);
  if (globalMatches.length === 1) {
    return [{
      symbol: globalMatches[0],
      kind: globalMatches[0].kind === 'method' ? 'method' : 'direct',
      confidence: 'resolved',
      evidence: ['unique workspace symbol name match'],
    }];
  }
  if (globalMatches.length > 1) {
    if (!options.includePossibleEdges) {
      return [];
    }
    return globalMatches.slice(0, options.maxPossibleTargetsPerCall).map((symbol) => ({
      symbol,
      kind: symbol.kind === 'method' ? 'method' as const : 'direct' as const,
      confidence: 'possible' as const,
      evidence: ['ambiguous workspace symbol name match'],
    }));
  }
  return [];
}

function unresolvedCalleeName(call: CallGraphCallSite): string {
  return call.receiver ? `${call.receiver}.${call.name}` : call.name;
}

function makeEdge(
  call: CallGraphCallSite,
  callerId: string,
  calleeId: string | undefined,
  calleeName: string,
  kind: CallGraphEdgeKind,
  confidence: CallGraphConfidence,
  evidence: string[],
): CallGraphEdge {
  const rawKey = [
    callerId,
    calleeId ?? calleeName,
    call.relPath,
    call.range.startLine,
    call.range.startColumn,
    confidence,
  ].join('|');
  return {
    id: `edge:${stableHash(rawKey)}`,
    callerId,
    calleeId,
    calleeName,
    receiver: call.receiver,
    callKind: kind,
    confidence,
    source: 'heuristic',
    callsite: call,
    evidence,
  };
}

function buildSymbolIndex(symbols: CallGraphSymbol[], bindings: CallGraphVariableBinding[] = []): SymbolIndex {
  const byId = new Map<string, CallGraphSymbol>();
  const byName = new Map<string, CallGraphSymbol[]>();
  const byQualifiedName = new Map<string, CallGraphSymbol[]>();
  const byClassName = new Map<string, CallGraphSymbol[]>();
  const methodsByName = new Map<string, CallGraphSymbol[]>();
  const methodsByClassName = new Map<string, Map<string, CallGraphSymbol[]>>();
  const symbolsByFile = new Map<string, CallGraphSymbol[]>();
  const bindingsBySymbolId = new Map<string, Map<string, CallGraphVariableBinding>>();
  const typesByReferencedName = new Map<string, CallGraphSymbol[]>();
  for (const symbol of symbols) {
    byId.set(symbol.id, symbol);
    pushMap(byName, symbol.name, symbol);
    pushMap(byQualifiedName, symbol.qualifiedName, symbol);
    pushMap(symbolsByFile, symbol.relPath, symbol);
    if (isTypeSymbol(symbol)) {
      pushMap(byClassName, symbol.name, symbol);
      for (const name of [...symbol.extendsNames ?? [], ...symbol.implementsNames ?? []]) {
        for (const key of typeReferenceKeys(name)) {
          pushMap(typesByReferencedName, key, symbol);
        }
      }
    }
    if ((symbol.kind === 'method' || symbol.kind === 'constructor') && symbol.containerName) {
      pushMap(methodsByName, symbol.name, symbol);
      const className = lastQualifiedPart(symbol.containerName);
      let byMethod = methodsByClassName.get(className);
      if (!byMethod) {
        byMethod = new Map();
        methodsByClassName.set(className, byMethod);
      }
      pushMap(byMethod, symbol.name, symbol);
    }
  }
  for (const binding of bindings) {
    let byVariable = bindingsBySymbolId.get(binding.enclosingSymbolId);
    if (!byVariable) {
      byVariable = new Map();
      bindingsBySymbolId.set(binding.enclosingSymbolId, byVariable);
    }
    byVariable.set(binding.variableName, binding);
  }
  return {
    byId,
    byName,
    byQualifiedName,
    byClassName,
    methodsByName,
    methodsByClassName,
    symbolsByFile,
    bindingsBySymbolId,
    typesByReferencedName,
  };
}

function collectMethodNameMatches(name: string, index: SymbolIndex): CallGraphSymbol[] {
  return index.methodsByName.get(name) ?? [];
}

function findMethodMatchesForTypeName(
  typeName: string,
  methodName: string,
  index: SymbolIndex,
  includeInherited: boolean,
): MethodTargetMatch[] {
  const preferred = findTypeSymbol(typeName, index);
  const simple = lastQualifiedPart(typeName);
  const candidates = dedupeSymbols([
    ...(preferred ? [preferred] : []),
    ...(index.byClassName.get(simple) ?? []),
  ]);
  return dedupeMethodMatches(candidates.flatMap((typeSymbol) => findMethodMatchesForType(typeSymbol, methodName, index, includeInherited)));
}

function findMethodMatchesForType(
  typeSymbol: CallGraphSymbol,
  methodName: string,
  index: SymbolIndex,
  includeInherited: boolean,
): MethodTargetMatch[] {
  const declared = findDeclaredMethodMatches(typeSymbol, methodName, index);
  if (declared.length > 0 || !includeInherited) {
    return declared;
  }
  return findInheritedMethodMatches(typeSymbol, methodName, index);
}

function findDeclaredMethodMatches(
  typeSymbol: CallGraphSymbol,
  methodName: string,
  index: SymbolIndex,
): MethodTargetMatch[] {
  const methods = index.methodsByClassName.get(typeSymbol.name)?.get(methodName) ?? [];
  return methods
    .filter((method) => method.containerName === typeSymbol.qualifiedName)
    .map((symbol) => ({ symbol, owner: typeSymbol, inherited: false }));
}

function findInheritedMethodMatches(
  typeSymbol: CallGraphSymbol,
  methodName: string,
  index: SymbolIndex,
): MethodTargetMatch[] {
  const seen = new Set<string>([typeSymbol.id]);
  let currentNames = [...typeSymbol.extendsNames ?? []];
  while (currentNames.length > 0) {
    const matches: MethodTargetMatch[] = [];
    const nextNames: string[] = [];
    for (const parentName of currentNames) {
      const parent = findTypeSymbol(parentName, index);
      if (!parent || seen.has(parent.id)) { continue; }
      seen.add(parent.id);
      for (const match of findDeclaredMethodMatches(parent, methodName, index)) {
        matches.push({ ...match, inherited: true });
      }
      nextNames.push(...parent.extendsNames ?? []);
    }
    if (matches.length > 0) {
      return dedupeMethodMatches(matches);
    }
    currentNames = nextNames;
  }
  return [];
}

function dedupeMethodMatches(matches: MethodTargetMatch[]): MethodTargetMatch[] {
  const seen = new Set<string>();
  const out: MethodTargetMatch[] = [];
  for (const match of matches) {
    if (seen.has(match.symbol.id)) { continue; }
    seen.add(match.symbol.id);
    out.push(match);
  }
  return out;
}

function appendEdgeSummary(
  lines: string[],
  edges: CallGraphEdge[],
  byId: Map<string, CallGraphSymbol>,
  perspective: 'caller' | 'callee',
): void {
  if (edges.length === 0) {
    lines.push('(none)');
    return;
  }
  for (const edge of edges.slice(0, 50)) {
    const symbolId = perspective === 'caller' ? edge.callerId : edge.calleeId;
    const symbol = symbolId ? byId.get(symbolId) : undefined;
    lines.push([
      `- ${symbol ? formatSymbol(symbol) : edge.calleeName}`,
      `${edge.confidence}/${edge.callKind}`,
      `${edge.callsite.relPath}:${edge.callsite.range.startLine + 1}`,
    ].join(' | '));
  }
  if (edges.length > 50) {
    lines.push(`- ... ${edges.length - 50} more`);
  }
}

export function formatSymbol(symbol: CallGraphSymbol): string {
  return `${symbol.qualifiedName} [${symbol.kind}, ${symbol.language}] ${symbol.relPath}:${symbol.range.startLine + 1}`;
}

export function formatQueryResults(results: CallGraphQueryResult[], direction: 'callers' | 'callees'): string {
  if (results.length === 0) { return 'No matching symbol found. Rebuild the call graph or refine the query.'; }
  const indexSymbols = new Map<string, CallGraphSymbol>();
  for (const result of results) {
    indexSymbols.set(result.symbol.id, result.symbol);
    for (const related of result.relatedSymbols) {
      indexSymbols.set(related.id, related);
    }
  }
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${direction}: ${formatSymbol(result.symbol)}`);
    if (result.edges.length === 0) {
      lines.push('  (none)');
      continue;
    }
    for (const edge of result.edges) {
      const relatedId = direction === 'callers' ? edge.callerId : edge.calleeId;
      const related = relatedId ? indexSymbols.get(relatedId) : undefined;
      const where = `${edge.callsite.relPath}:${edge.callsite.range.startLine + 1}`;
      lines.push(`  - ${related ? formatSymbol(related) : edge.calleeName} | ${edge.confidence}/${edge.callKind} | ${where}`);
    }
  }
  return lines.join('\n');
}

function readPackageName(language: CallGraphLanguage, lines: string[]): string | undefined {
  for (const line of lines.slice(0, 80)) {
    const trimmed = line.trim();
    if (language === 'java') {
      const match = /^package\s+([\w.]+)\s*;/.exec(trimmed);
      if (match) { return match[1]; }
    } else if (language === 'kotlin') {
      const match = /^package\s+([\w.]+)/.exec(trimmed);
      if (match) { return match[1]; }
    }
  }
  return undefined;
}

function collectPythonDecorators(lines: string[], defLineNo: number, indent: number): string[] {
  const decorators: string[] = [];
  for (let i = defLineNo - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { break; }
    if (indentationOf(line) !== indent || !trimmed.startsWith('@')) { break; }
    decorators.unshift(trimmed.slice(1).split(/[ (]/)[0]);
  }
  return decorators;
}

function isPythonPropertyDecorator(decorator: string): boolean {
  const parts = decorator.split('.');
  const last = parts[parts.length - 1];
  return last === 'property' || last === 'cached_property' || last === 'setter' || last === 'deleter';
}

function matchConstantDeclaration(language: CallGraphLanguage, line: string): { name: string } | undefined {
  const trimmed = line.trim();
  if (language === 'kotlin') {
    const match = /\b(?:const\s+)?val\s+([A-Z][A-Z0-9_]{2,})\b/.exec(trimmed);
    return match ? { name: match[1] } : undefined;
  }
  if (language === 'typescript' || language === 'javascript') {
    const exportedVariable = /^(?:export\s+)(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\b/.exec(trimmed);
    if (exportedVariable) { return { name: exportedVariable[1] }; }
    const variable = /^(?:export\s+)?(?:declare\s+)?const\s+([A-Z][A-Z0-9_]{2,})\b/.exec(trimmed);
    if (variable) { return { name: variable[1] }; }
    const classField = /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|declare\s+)*([A-Z][A-Z0-9_]{2,})\s*(?::|=)/.exec(trimmed);
    return classField ? { name: classField[1] } : undefined;
  }
  if (language === 'java') {
    const match = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|transient|volatile)\s+)+[A-Za-z_$][\w$<>\[\].?]*\s+([A-Z][A-Z0-9_]{2,})\s*=/.exec(trimmed);
    return match ? { name: match[1] } : undefined;
  }
  return undefined;
}

function matchClassDeclaration(language: CallGraphLanguage, line: string): ClassDeclaration | undefined {
  const trimmed = line.trim();
  if (language === 'kotlin') {
    const typeAlias = /\btypealias\s+([A-Za-z_]\w*)\b(?:\s*<[^>{}]*>)?(?:\s*=\s*(.*))?/.exec(trimmed);
    if (typeAlias) {
      return {
        name: typeAlias[1],
        kind: 'type',
        modifiers: [],
        extendsNames: parseTypeReferenceList(typeAlias[2] ?? ''),
        implementsNames: [],
      };
    }
    const match = /\b((?:(?:abstract|sealed|data|enum|value|open|inner|public|private|protected|internal)\s+)*)(class|interface|object)\s+([A-Za-z_]\w*)(?:\s*<[^>{}]*>)?([^{}]*)/.exec(trimmed);
    if (!match) { return undefined; }
    const keyword = match[2];
    const modifierText = match[1] ?? '';
    const modifiers: CallGraphSymbolModifier[] = [];
    if (keyword === 'interface') { modifiers.push('interface'); }
    if (/\babstract\b/.test(modifierText) || /\babstract\b/.test(trimmed.slice(0, match.index))) { modifiers.push('abstract'); }
    const heritage = /:\s*([^{}]+)/.exec(match[4] ?? '')?.[1] ?? '';
    return {
      name: match[3],
      kind: /\benum\b/.test(modifierText) ? 'enum' : keyword === 'interface' ? 'interface' : 'class',
      modifiers,
      extendsNames: parseTypeReferenceList(heritage),
      implementsNames: [],
    };
  }

  if (language === 'typescript' || language === 'javascript') {
    const typeAlias = /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)(?:\s*<[^>{}]*>)?(?:\s*=\s*(.*))?/.exec(trimmed);
    if (typeAlias) {
      return {
        name: typeAlias[1],
        kind: 'type',
        modifiers: [],
        extendsNames: parseTypeReferenceList(typeAlias[2] ?? ''),
        implementsNames: [],
      };
    }
  }

  const match = /\b(class|interface|enum|struct)\s+([A-Za-z_$][\w$]*)(?:\s*<[^>{}]*>)?([^{};]*)/.exec(trimmed);
  if (!match) { return undefined; }
  const keyword = match[1];
  const name = match[2];
  const prefix = trimmed.slice(0, match.index);
  const tail = match[3] ?? '';
  const modifiers: CallGraphSymbolModifier[] = [];
  if (keyword === 'interface') { modifiers.push('interface'); }
  if (/\babstract\b/.test(prefix)) { modifiers.push('abstract'); }
  const extendsNames = parseTypeReferenceList(/\bextends\s+([^{};]*?)(?=\s+\bimplements\b|$)/.exec(tail)?.[1] ?? '');
  const implementsNames = parseTypeReferenceList(/\bimplements\s+([^{};]*)/.exec(tail)?.[1] ?? '');
  return {
    name,
    kind: keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'struct' ? 'struct' : 'class',
    modifiers,
    extendsNames,
    implementsNames,
  };
}

function matchCallable(
  language: CallGraphLanguage,
  line: string,
  container?: CallGraphSymbol,
): CallableDeclaration | undefined {
  const trimmed = line.trim();
  const allowDeclarationOnly = !!container && (container.kind === 'interface' || container.modifiers?.includes('abstract'));
  if (language === 'kotlin') {
    const constructor = /^constructor\s*\([^;]*\)\s*\{/.exec(trimmed);
    if (constructor) { return { name: 'constructor', hasBody: true }; }
    if (/^init\s*\{/.test(trimmed)) { return { name: 'init', hasBody: true }; }
    const match = /\bfun\s+(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    return match ? { name: match[1], hasBody: trimmed.includes('{') } : undefined;
  }
  if (language === 'typescript' || language === 'javascript') {
    const fn = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed);
    if (fn) { return { name: fn[1], hasBody: trimmed.includes('{') }; }
    const variable = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(trimmed);
    if (variable) { return { name: variable[1], hasBody: trimmed.includes('{') }; }
    const constructor = /^(?:public\s+|private\s+|protected\s+)?constructor\s*\([^;]*\)\s*\{/.exec(trimmed);
    if (constructor) { return { name: 'constructor', hasBody: true }; }
    const method = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^{]+)?\{/.exec(trimmed);
    if (method && !CALL_KEYWORDS.has(method[1])) { return { name: method[1], hasBody: true }; }
    if (allowDeclarationOnly) {
      const declaredMethod = /^(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?::[^;{]+)?;/.exec(trimmed);
      if (declaredMethod && !CALL_KEYWORDS.has(declaredMethod[1])) {
        return { name: declaredMethod[1], hasBody: false };
      }
    }
    return undefined;
  }
  const javaCtorOrMethod = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[A-Za-z_$][\w$<>\[\],.?@\s]*\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws[^{]+)?\{/.exec(trimmed);
  if (javaCtorOrMethod && !CALL_KEYWORDS.has(javaCtorOrMethod[1])) {
    return { name: javaCtorOrMethod[1], hasBody: true };
  }
  if (allowDeclarationOnly) {
    const javaDeclaration = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[A-Za-z_$][\w$<>\[\],.?@\s]*\s+)?([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?:throws[^;{]+)?;/.exec(trimmed);
    if (javaDeclaration && !CALL_KEYWORDS.has(javaDeclaration[1])) {
      return { name: javaDeclaration[1], hasBody: false };
    }
  }
  return undefined;
}

function innermostClassAt(classSymbols: MutableSymbol[], lineNo: number): MutableSymbol | undefined {
  return classSymbols
    .filter((symbol) => lineNo >= symbol.bodyRange.startLine && lineNo <= symbol.bodyRange.endLine)
    .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange))[0];
}

function innermostCallableAt(symbols: MutableSymbol[], lineNo: number): MutableSymbol | undefined {
  return symbols
    .filter((symbol) => lineNo >= symbol.bodyRange.startLine && lineNo <= symbol.bodyRange.endLine)
    .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange))[0];
}

function isInsideCallableBody(lineNo: number, symbols: MutableSymbol[]): boolean {
  return symbols.some((symbol) => lineNo >= symbol.bodyRange.startLine && lineNo <= symbol.bodyRange.endLine);
}

function readPythonHeader(lines: string[], startLine: number): HeaderSpan {
  const text: string[] = [];
  let parenDepth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const line = stripInlineCommentsAndStrings(lines[i], 'python');
    const trimmed = line.trim();
    text.push(trimmed);
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') {
        parenDepth += 1;
      } else if ((ch === ')' || ch === ']' || ch === '}') && parenDepth > 0) {
        parenDepth -= 1;
      }
    }
    if (parenDepth === 0 && /:\s*$/.test(trimmed)) {
      return { text: text.join(' '), endLine: i };
    }
    if (i > startLine + 40) { break; }
  }
  return { text: text.join(' '), endLine: startLine };
}

function findPythonBlockEnd(lines: string[], startLine: number, indent: number): number {
  const headerEnd = readPythonHeader(lines, startLine).endLine;
  for (let i = headerEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    if (indentationOf(line) <= indent) {
      return Math.max(startLine, i - 1);
    }
  }
  return lines.length - 1;
}

function readBraceHeader(lines: string[], startLine: number, language: CallGraphLanguage): HeaderSpan {
  const text: string[] = [];
  let parenDepth = 0;
  let angleDepth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const line = stripInlineCommentsAndStrings(lines[i], language);
    const trimmed = line.trim();
    text.push(trimmed);
    for (const ch of line) {
      if (ch === '(' || ch === '[') {
        parenDepth += 1;
      } else if ((ch === ')' || ch === ']') && parenDepth > 0) {
        parenDepth -= 1;
      } else if (ch === '<') {
        angleDepth += 1;
      } else if (ch === '>' && angleDepth > 0) {
        angleDepth -= 1;
      } else if ((ch === '{' || ch === ';') && parenDepth === 0) {
        return { text: text.join(' '), endLine: i };
      }
    }
    if (parenDepth === 0 && angleDepth === 0 && /[;{]\s*$/.test(trimmed)) {
      return { text: text.join(' '), endLine: i };
    }
    if (i > startLine + 40) { break; }
  }
  return { text: text.join(' '), endLine: startLine };
}

function findBraceBlockEnd(lines: string[], startLine: number): number {
  let seenOpen = false;
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    const line = stripInlineCommentsAndStrings(lines[i], 'javascript');
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        seenOpen = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenOpen && depth <= 0) {
          return i;
        }
      }
    }
  }
  return startLine;
}

function stripInlineCommentsAndStrings(line: string, language: CallGraphLanguage): string {
  let out = '';
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (!quote && language !== 'python' && ch === '/' && next === '/') {
      out += ' '.repeat(line.length - i);
      break;
    }
    if (!quote && language === 'python' && ch === '#') {
      out += ' '.repeat(line.length - i);
      break;
    }
    if (quote) {
      out += ' ';
      if (!escaped && ch === quote) {
        quote = undefined;
      }
      escaped = !escaped && ch === '\\';
      if (ch !== '\\') { escaped = false; }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function indentationOf(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') { count += 1; }
    else if (ch === '\t') { count += 4; }
    else { break; }
  }
  return count;
}

function declarationContainsName(symbol: CallGraphSymbol, name: string, rawLine: string): boolean {
  if (symbol.name !== name) { return false; }
  return rawLine.includes(`def ${name}`) ||
    rawLine.includes(`function ${name}`) ||
    rawLine.includes(`fun ${name}`) ||
    rawLine.includes(` ${name}(`) ||
    rawLine.trim().startsWith(`${name}(`);
}

function couldStartClassHeader(language: CallGraphLanguage, trimmed: string): boolean {
  if (language === 'kotlin') {
    return /\b(?:typealias|class|interface|object)\s+[A-Za-z_]\w*/.test(trimmed);
  }
  if (language === 'typescript' || language === 'javascript') {
    return /\b(?:type|class|interface|enum|struct)\s+[A-Za-z_$][\w$]*/.test(trimmed);
  }
  return /\b(?:class|interface|enum|struct)\s+[A-Za-z_$][\w$]*/.test(trimmed);
}

function couldStartCallableHeader(
  language: CallGraphLanguage,
  trimmed: string,
  container?: CallGraphSymbol,
): boolean {
  if (language === 'kotlin') {
    return /^(?:(?:public|private|protected|internal|override|open|abstract|final|suspend|inline|operator|infix|tailrec)\s+)*(?:fun|constructor|init)\b/.test(trimmed);
  }
  if (language === 'typescript' || language === 'javascript') {
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(trimmed)) { return true; }
    if (/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(trimmed)) { return true; }
    if (/^(?:public\s+|private\s+|protected\s+)?constructor\b/.test(trimmed)) { return true; }
    if (container) {
      return /^(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*[A-Za-z_$][\w$]*\s*\(/.test(trimmed);
    }
    return false;
  }
  return /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[A-Za-z_$][\w$<>\[\],.?@\s]*\s+)?[A-Za-z_$][\w$]*\s*\(/.test(trimmed);
}

function findNameLocation(lines: string[], startLine: number, endLine: number, name: string): { lineNo: number; column: number } {
  for (let lineNo = startLine; lineNo <= endLine && lineNo < lines.length; lineNo++) {
    const column = lines[lineNo].indexOf(name);
    if (column >= 0) {
      return { lineNo, column };
    }
  }
  return { lineNo: startLine, column: 0 };
}

function dedupeCallSites(calls: CallGraphCallSite[]): CallGraphCallSite[] {
  const seen = new Set<string>();
  const out: CallGraphCallSite[] = [];
  for (const call of calls) {
    const key = `${call.enclosingSymbolId}|${call.name}|${call.receiver ?? ''}|${call.range.startLine}|${call.range.startColumn}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(call);
  }
  return out;
}

function dedupeEdges(edges: CallGraphEdge[]): CallGraphEdge[] {
  const seen = new Set<string>();
  const out: CallGraphEdge[] = [];
  for (const edge of edges) {
    const key = edgeIdentityKey(edge);
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(edge);
  }
  return out;
}

function dedupeReferences(references: CallGraphReference[]): CallGraphReference[] {
  const seen = new Set<string>();
  const out: CallGraphReference[] = [];
  for (const reference of references) {
    const key = referenceLocationKey(reference);
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(reference);
  }
  return out;
}

function edgeIdentityKey(edge: CallGraphEdge): string {
  return `${edge.callerId}|${edge.calleeId ?? edge.calleeName}|${edge.callsite.range.startLine}|${edge.callsite.range.startColumn}|${edge.confidence}`;
}

async function dedupeEdgesAsync(
  edges: CallGraphEdge[],
  options: {
    token?: vscode.CancellationToken;
    onDeduping?: (current: number, total: number) => void;
  },
): Promise<CallGraphEdge[]> {
  const seen = new Set<string>();
  const out: CallGraphEdge[] = [];
  const chunkSize = 10_000;
  for (let i = 0; i < edges.length; i++) {
    if (options.token?.isCancellationRequested) {
      throw new CallGraphRebuildCancelledError();
    }
    const edge = edges[i];
    const key = edgeIdentityKey(edge);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(edge);
    }
    if ((i + 1) % chunkSize === 0) {
      options.onDeduping?.(i + 1, edges.length);
      await yieldToExtensionHost();
    }
  }
  options.onDeduping?.(edges.length, edges.length);
  return out;
}

function mergeEdges(a: CallGraphEdge[], b: CallGraphEdge[]): CallGraphEdge[] {
  return dedupeEdges([...a, ...b])
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence));
}

function dedupeSymbols(symbols: CallGraphSymbol[]): CallGraphSymbol[] {
  const seen = new Set<string>();
  const out: CallGraphSymbol[] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol.id)) { continue; }
    seen.add(symbol.id);
    out.push(symbol);
  }
  return out;
}

function confidenceRank(confidence: CallGraphConfidence): number {
  switch (confidence) {
    case 'exact':
      return 4;
    case 'resolved':
      return 3;
    case 'possible':
      return 2;
    case 'unresolved':
      return 1;
  }
}

function stripMutableSymbol(symbol: MutableSymbol): CallGraphSymbol {
  const { indent: _indent, ...rest } = symbol;
  return rest;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function scoreSymbolMatch(symbol: CallGraphSymbol, query: string, lowerQuery: string): number {
  if (symbol.id === query) { return 1000; }
  if (symbol.qualifiedName === query) { return 900; }
  if (symbol.name === query) { return 800; }
  if (symbol.qualifiedName.endsWith(`.${query}`)) { return 750; }
  if (symbol.qualifiedName.toLowerCase() === lowerQuery) { return 700; }
  if (symbol.name.toLowerCase() === lowerQuery) { return 650; }
  if (symbol.qualifiedName.toLowerCase().includes(lowerQuery)) { return 300; }
  if (symbol.relPath.toLowerCase().includes(lowerQuery)) { return 100; }
  return 0;
}

function rangeContainsPosition(range: CallGraphRange, position: vscode.Position): boolean {
  if (position.line < range.startLine || position.line > range.endLine) { return false; }
  if (position.line === range.startLine && position.character < range.startColumn) { return false; }
  if (position.line === range.endLine && position.character > range.endColumn) { return false; }
  return true;
}

function sameRange(a: CallGraphRange, b: CallGraphRange): boolean {
  return a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn;
}

function rangeSize(range: CallGraphRange): number {
  return (range.endLine - range.startLine) * 100_000 + (range.endColumn - range.startColumn);
}

function collectRelatedSymbols(ids: string[], byId: Map<string, CallGraphSymbol>): CallGraphSymbol[] {
  const out: CallGraphSymbol[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) { continue; }
    const symbol = byId.get(id);
    if (!symbol) { continue; }
    seen.add(id);
    out.push(symbol);
  }
  return out;
}

function buildRelationSummaryIndex(edges: CallGraphEdge[], references: CallGraphReference[]): RelationSummaryIndex {
  const callersBySymbolId = new Map<string, Set<string>>();
  const calleesBySymbolId = new Map<string, Set<string>>();
  const usagesBySymbolId = new Map<string, CallGraphReference[]>();
  const usageKeysBySymbolId = new Map<string, Set<string>>();
  const pushUsage = (reference: CallGraphReference) => {
    const key = referenceLocationKey(reference);
    let keys = usageKeysBySymbolId.get(reference.symbolId);
    if (!keys) {
      keys = new Set<string>();
      usageKeysBySymbolId.set(reference.symbolId, keys);
    }
    if (keys.has(key)) { return; }
    keys.add(key);
    pushMap(usagesBySymbolId, reference.symbolId, reference);
  };
  for (const edge of edges) {
    const locationKey = edgeLocationKey(edge);
    if (edge.calleeId) {
      addSetValue(callersBySymbolId, edge.calleeId, locationKey);
      addSetValue(calleesBySymbolId, edge.callerId, locationKey);
      pushUsage(callsiteReferenceFromEdge(edge, edge.calleeId));
    } else {
      addSetValue(calleesBySymbolId, edge.callerId, locationKey);
    }
  }
  for (const reference of references) {
    pushUsage(reference);
  }
  return { callersBySymbolId, calleesBySymbolId, usagesBySymbolId };
}

function buildRelationSummaryIndexForSymbolIdsFromArrays(
  edges: CallGraphEdge[],
  references: CallGraphReference[],
  symbolIds: Set<string>,
): RelationSummaryIndex {
  const callersBySymbolId = new Map<string, Set<string>>();
  const calleesBySymbolId = new Map<string, Set<string>>();
  const usagesBySymbolId = new Map<string, CallGraphReference[]>();
  const usageKeysBySymbolId = new Map<string, Set<string>>();
  const pushUsage = (reference: CallGraphReference) => {
    if (!symbolIds.has(reference.symbolId)) { return; }
    const key = referenceLocationKey(reference);
    let keys = usageKeysBySymbolId.get(reference.symbolId);
    if (!keys) {
      keys = new Set<string>();
      usageKeysBySymbolId.set(reference.symbolId, keys);
    }
    if (keys.has(key)) { return; }
    keys.add(key);
    pushMap(usagesBySymbolId, reference.symbolId, reference);
  };
  for (const edge of edges) {
    const locationKey = edgeLocationKey(edge);
    if (edge.calleeId && symbolIds.has(edge.calleeId)) {
      addSetValue(callersBySymbolId, edge.calleeId, locationKey);
      pushUsage(callsiteReferenceFromEdge(edge, edge.calleeId));
    }
    if (symbolIds.has(edge.callerId)) {
      addSetValue(calleesBySymbolId, edge.callerId, locationKey);
    }
  }
  for (const reference of references) {
    pushUsage(reference);
  }
  return { callersBySymbolId, calleesBySymbolId, usagesBySymbolId };
}

function mergeRelationSummaryIndex(target: RelationSummaryIndex, source: RelationSummaryIndex): void {
  for (const [symbolId, callers] of source.callersBySymbolId) {
    for (const caller of callers) {
      addSetValue(target.callersBySymbolId, symbolId, caller);
    }
  }
  for (const [symbolId, callees] of source.calleesBySymbolId) {
    for (const callee of callees) {
      addSetValue(target.calleesBySymbolId, symbolId, callee);
    }
  }
  for (const [symbolId, usages] of source.usagesBySymbolId) {
    const existing = target.usagesBySymbolId.get(symbolId) ?? [];
    target.usagesBySymbolId.set(symbolId, dedupeReferences([...existing, ...usages]));
  }
}

function callsiteReferenceFromEdge(edge: CallGraphEdge, symbolId: string): CallGraphReference {
  return {
    symbolId,
    name: edge.calleeName,
    rawText: edge.callsite.rawText,
    uri: edge.callsite.uri,
    relPath: edge.callsite.relPath,
    range: edge.callsite.range,
    enclosingSymbolId: edge.callerId,
  };
}

function referenceLocationKey(reference: CallGraphReference): string {
  return [
    reference.symbolId,
    reference.uri,
    reference.range.startLine,
    reference.range.startColumn,
  ].join(':');
}

function edgeLocationKey(edge: CallGraphEdge): string {
  return [
    edge.callsite.uri,
    edge.callsite.range.startLine,
    edge.callsite.range.startColumn,
    edge.callsite.range.endLine,
    edge.callsite.range.endColumn,
  ].join(':');
}

function findImplementationSymbols(symbol: CallGraphSymbol, index: SymbolIndex, limit: number): CallGraphSymbol[] {
  if (isTypeSymbol(symbol)) {
    return findImplementingTypes(symbol, index, limit);
  }
  if ((symbol.kind === 'method' || symbol.kind === 'constructor') && symbol.containerName) {
    const container = findTypeSymbol(symbol.containerName, index);
    if (!container) { return []; }
    const implementingTypes = findImplementingTypes(container, index, Math.max(limit * 2, limit));
    const implementations = implementingTypes.flatMap((typeSymbol) => {
      const methods = index.methodsByClassName.get(typeSymbol.name)?.get(symbol.name) ?? [];
      return methods.filter((method) => method.containerName === typeSymbol.qualifiedName && method.id !== symbol.id);
    });
    return dedupeSymbols(implementations).slice(0, limit);
  }
  return [];
}

function findImplementingTypes(symbol: CallGraphSymbol, index: SymbolIndex, limit: number): CallGraphSymbol[] {
  const out: CallGraphSymbol[] = [];
  const seen = new Set<string>([symbol.id]);
  const queue: CallGraphSymbol[] = [symbol];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift();
    if (!current) { break; }
    for (const key of typeIdentityKeys(current)) {
      for (const candidate of index.typesByReferencedName.get(key) ?? []) {
        if (seen.has(candidate.id)) { continue; }
        seen.add(candidate.id);
        out.push(candidate);
        queue.push(candidate);
        if (out.length >= limit) { break; }
      }
      if (out.length >= limit) { break; }
    }
  }
  return out;
}

function findTypeSymbol(nameOrQualifiedName: string, index: SymbolIndex): CallGraphSymbol | undefined {
  const exact = index.byQualifiedName.get(nameOrQualifiedName)?.find(isTypeSymbol);
  if (exact) { return exact; }
  const simple = lastQualifiedPart(nameOrQualifiedName);
  return index.byClassName.get(simple)?.find((symbol) => symbol.qualifiedName === nameOrQualifiedName)
    ?? index.byClassName.get(simple)?.[0];
}

function isTypeSymbol(symbol: CallGraphSymbol): boolean {
  return symbol.kind === 'class' ||
    symbol.kind === 'interface' ||
    symbol.kind === 'enum' ||
    symbol.kind === 'type' ||
    symbol.kind === 'struct';
}

function isCallableSymbol(symbol: CallGraphSymbol): boolean {
  return symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'constructor';
}

function isReferenceableSymbol(symbol: CallGraphSymbol): boolean {
  return isTypeSymbol(symbol) ||
    symbol.kind === 'constant' ||
    symbol.kind === 'variable' ||
    symbol.kind === 'field' ||
    symbol.kind === 'property' ||
    isAnonymousFunctionAssignmentSymbol(symbol);
}

function isExternalApiSymbol(symbol: CallGraphSymbol): boolean {
  if (symbol.containerId) { return false; }
  if (!isCallableSymbol(symbol) && !isTypeSymbol(symbol) && !isReferenceableSymbol(symbol)) { return false; }
  const signature = symbol.signature?.trim() ?? '';
  if (symbol.language === 'typescript' || symbol.language === 'javascript') {
    return /^(?:export\s+|export\s+default\s+)/.test(signature);
  }
  if (symbol.language === 'python') {
    return !symbol.name.startsWith('_');
  }
  if (symbol.language === 'java') {
    return /\bpublic\b/.test(signature);
  }
  if (symbol.language === 'kotlin') {
    return !/\b(?:private|internal)\b/.test(signature);
  }
  return false;
}

function isAnonymousFunctionAssignmentSymbol(symbol: CallGraphSymbol): boolean {
  if (symbol.kind !== 'function') { return false; }
  const signature = symbol.signature ?? '';
  if (symbol.language === 'typescript' || symbol.language === 'javascript') {
    return new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(symbol.name)}\\s*=`).test(signature.trim());
  }
  if (symbol.language === 'python') {
    return new RegExp(`^${escapeRegExp(symbol.name)}\\s*=\\s*lambda\\b`).test(signature.trim());
  }
  return false;
}

function typeIdentityKeys(symbol: CallGraphSymbol): string[] {
  return dedupeStrings([
    symbol.qualifiedName,
    symbol.name,
    lastQualifiedPart(symbol.qualifiedName),
  ]);
}

function typeReferenceKeys(name: string): string[] {
  const stripped = stripGenericSuffix(name).replace(/\([^)]*\)/g, '').trim();
  return dedupeStrings([stripped, lastQualifiedPart(stripped)]);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) { continue; }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function findIdentifierOccurrences(line: string, name: string): number[] {
  const out: number[] = [];
  if (!name) { return out; }
  let start = 0;
  while (start < line.length) {
    const index = line.indexOf(name, start);
    if (index < 0) { break; }
    const before = index > 0 ? line[index - 1] : '';
    const after = line[index + name.length] ?? '';
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      out.push(index);
    }
    start = index + Math.max(1, name.length);
  }
  return out;
}

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

function lastQualifiedPart(value: string): string {
  const parts = value.split('.');
  return parts[parts.length - 1] || value;
}

function normalizeReceiver(value: string): string {
  return value
    .replace(/\s+/g, '')
    .replace(/\?\.\[/g, '[')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\?\./g, '.')
    .replace(/!!\./g, '.')
    .replace(/^super\(\)$/, 'super');
}

function readReferenceReceiver(line: string, tokenStart: number): string | undefined {
  let i = tokenStart - 1;
  while (i >= 0 && isFastWhitespace(line.charCodeAt(i))) { i -= 1; }
  if (i < 0 || line.charCodeAt(i) !== 46 /* . */) { return undefined; }
  i -= 1;
  while (i >= 0 && isFastWhitespace(line.charCodeAt(i))) { i -= 1; }
  const end = i + 1;
  while (i >= 0 && isFastIdentifierPart(line.charCodeAt(i))) { i -= 1; }
  const start = i + 1;
  if (start >= end || !isFastIdentifierStart(line.charCodeAt(start))) { return undefined; }
  return line.slice(start, end);
}

function isFastWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isFastIdentifierStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

function isFastIdentifierPart(code: number): boolean {
  return isFastIdentifierStart(code) || (code >= 48 && code <= 57);
}

function readParameterList(signature: string): string | undefined {
  const start = signature.indexOf('(');
  if (start < 0) { return undefined; }
  let depth = 0;
  for (let i = start; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return signature.slice(start + 1, i);
      }
    }
  }
  return undefined;
}

function splitParameterList(parameterList: string): string[] {
  const out: string[] = [];
  let start = 0;
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < parameterList.length; i++) {
    const ch = parameterList[i];
    if (ch === '<') { angleDepth += 1; }
    else if (ch === '>' && angleDepth > 0) { angleDepth -= 1; }
    else if (ch === '(') { parenDepth += 1; }
    else if (ch === ')' && parenDepth > 0) { parenDepth -= 1; }
    else if (ch === '[') { bracketDepth += 1; }
    else if (ch === ']' && bracketDepth > 0) { bracketDepth -= 1; }
    else if (ch === ',' && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      out.push(parameterList.slice(start, i));
      start = i + 1;
    }
  }
  out.push(parameterList.slice(start));
  return out;
}

function stripParameterDefault(parameter: string): string {
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < parameter.length; i++) {
    const ch = parameter[i];
    if (ch === '<') { angleDepth += 1; }
    else if (ch === '>' && angleDepth > 0) { angleDepth -= 1; }
    else if (ch === '(') { parenDepth += 1; }
    else if (ch === ')' && parenDepth > 0) { parenDepth -= 1; }
    else if (ch === '[') { bracketDepth += 1; }
    else if (ch === ']' && bracketDepth > 0) { bracketDepth -= 1; }
    else if (ch === '=' && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      return parameter.slice(0, i);
    }
  }
  return parameter;
}

function extractLikelyBindingClassName(typeText: string | undefined): string {
  if (!typeText) { return ''; }
  const tokens = [...typeText.matchAll(/\b([A-Z][\w$.]*)\b/g)]
    .map((match) => lastQualifiedPart(match[1]))
    .filter((token) => !COLLECTION_BINDING_TYPE_NAMES.has(token) && !VALUE_BINDING_TYPE_NAMES.has(token));
  if (tokens.length > 0) {
    return normalizeBindingClassName(tokens[0]);
  }
  const normalized = normalizeBindingClassName(typeText);
  if (COLLECTION_BINDING_TYPE_NAMES.has(normalized) || VALUE_BINDING_TYPE_NAMES.has(normalized)) {
    return '';
  }
  return normalized;
}

function normalizeBindingClassName(className: string | undefined): string {
  if (!className) { return ''; }
  const withoutDefaults = className.split('=')[0] ?? className;
  const withoutGenerics = stripGenericSuffix(withoutDefaults)
    .replace(/\.\.\./g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\?/g, '')
    .replace(/\[\]/g, '')
    .replace(/[^\w.$]/g, '')
    .trim();
  return lastQualifiedPart(withoutGenerics);
}

function dedupeVariableBindings(bindings: CallGraphVariableBinding[]): CallGraphVariableBinding[] {
  const seen = new Set<string>();
  const out: CallGraphVariableBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.enclosingSymbolId}|${binding.variableName}|${binding.className}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function stripGenericSuffix(value: string): string {
  return value.replace(/[<[].*$/, '');
}

function parseTypeReferenceList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPart of value.split(',')) {
    const normalized = rawPart
      .replace(/\([^)]*\)/g, '')
      .replace(/<[^<>]*>/g, '')
      .replace(/\bwhere\b.*$/i, '')
      .replace(/[{};:].*$/g, '')
      .trim()
      .split(/\s+/)[0]
      ?.replace(/[^\w.$]/g, '');
    if (!normalized || seen.has(normalized)) { continue; }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function makeProviderEdge(input: {
  callerId: string;
  calleeId: string;
  calleeName: string;
  callName: string;
  callKind: CallGraphEdgeKind;
  uri: vscode.Uri;
  range: vscode.Range;
  evidence: string[];
}): CallGraphEdge {
  const callsiteRange = rangeToCallGraphRange(input.range);
  const relPath = vscode.workspace.asRelativePath(input.uri, false).replace(/\\/g, '/');
  const rawKey = [
    input.callerId,
    input.calleeId,
    input.uri.toString(),
    input.range.start.line,
    input.range.start.character,
    'semantic',
  ].join('|');
  return {
    id: `edge:${stableHash(rawKey)}`,
    callerId: input.callerId,
    calleeId: input.calleeId,
    calleeName: input.calleeName,
    callKind: input.callKind,
    confidence: 'exact',
    source: 'semantic',
    callsite: {
      name: input.callName,
      rawText: input.callName,
      uri: input.uri.toString(),
      relPath,
      range: callsiteRange,
      enclosingSymbolId: input.callerId,
    },
    evidence: input.evidence,
  };
}

function findIndexedSymbolForProviderItem(
  item: vscode.CallHierarchyItem,
  index: SymbolIndex,
): CallGraphSymbol | undefined {
  const uri = item.uri.toString();
  const start = item.selectionRange.start;
  const exact = [...index.byId.values()]
    .filter((symbol) => symbol.uri === uri && rangeContainsPosition(symbol.range, start))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0];
  if (exact) { return exact; }
  return [...(index.byName.get(item.name) ?? [])]
    .filter((symbol) => symbol.uri === uri)
    .sort((a, b) => Math.abs(a.range.startLine - start.line) - Math.abs(b.range.startLine - start.line))[0];
}

function symbolFromCallHierarchyItem(item: vscode.CallHierarchyItem): CallGraphSymbol {
  const relPath = vscode.workspace.asRelativePath(item.uri, false).replace(/\\/g, '/');
  const range = rangeToCallGraphRange(item.selectionRange);
  const qualifiedName = item.detail ? `${item.detail}.${item.name}` : item.name;
  return {
    id: `provider:${stableHash(`${item.uri.toString()}:${qualifiedName}:${range.startLine}:${range.startColumn}`)}`,
    name: item.name,
    qualifiedName,
    kind: 'function',
    language: languageFromUri(item.uri),
    uri: item.uri.toString(),
    relPath,
    range,
    bodyRange: rangeToCallGraphRange(item.range),
    signature: item.detail,
  };
}

function rangeToCallGraphRange(range: vscode.Range): CallGraphRange {
  return {
    startLine: range.start.line,
    startColumn: range.start.character,
    endLine: range.end.line,
    endColumn: range.end.character,
  };
}

function languageFromUri(uri: vscode.Uri): CallGraphLanguage {
  const ext = path.extname(uri.fsPath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(ext) ?? 'javascript';
}

function languageFromRelPath(relPath: string): CallGraphLanguage {
  const ext = path.extname(relPath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(ext) ?? 'javascript';
}

function getDefaultCallGraphConcurrency(): number {
  return MAX_CALL_GRAPH_CONCURRENCY;
}

function getConfiguredCallGraphConcurrency(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): number {
  const raw = cfg.get<number>('callGraphConcurrency', 0);
  const requested = !Number.isFinite(raw) || raw <= 0
    ? DEFAULT_CALL_GRAPH_CONCURRENCY
    : Math.max(1, Math.min(Math.floor(raw), MAX_CALL_GRAPH_CONCURRENCY));
  return capCallGraphConcurrencyForMemoryBudget(requested, getConfiguredCallGraphBuildLimits(cfg).memoryBudgetMb);
}

function capCallGraphConcurrencyForMemoryBudget(concurrency: number, memoryBudgetMb: number): number {
  const memoryCap = memoryBudgetMb < 512
    ? 2
    : memoryBudgetMb < 1_024
      ? 4
      : memoryBudgetMb < 2_048
        ? 8
        : memoryBudgetMb < 4_096
          ? 12
          : memoryBudgetMb < 8_192
            ? 16
            : 64;
  return Math.max(1, Math.min(concurrency, memoryCap, MAX_CALL_GRAPH_CONCURRENCY));
}

function getConfiguredCallGraphResolveOptions(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): CallGraphResolveOptions {
  const includePossibleEdges = cfg.get<boolean>('callGraphIncludePossibleEdges', false);
  const includeUnresolvedEdges = cfg.get<boolean>('callGraphIncludeUnresolvedEdges', false);
  const rawMaxEdges = cfg.get<number>('callGraphMaxEdges', DEFAULT_CALL_GRAPH_MAX_EDGES);
  const rawMaxPossibleTargets = cfg.get<number>('callGraphMaxPossibleTargetsPerCall', 8);
  const maxEdges = Number.isFinite(rawMaxEdges) && rawMaxEdges > 0
    ? Math.max(1_000, Math.floor(rawMaxEdges))
    : undefined;
  const maxPossibleTargetsPerCall = Number.isFinite(rawMaxPossibleTargets) && rawMaxPossibleTargets > 0
    ? Math.max(1, Math.min(Math.floor(rawMaxPossibleTargets), MAX_POSSIBLE_EDGES_PER_CALL))
    : 8;
  return {
    includePossibleEdges,
    includeUnresolvedEdges,
    maxEdges,
    maxPossibleTargetsPerCall,
  };
}

function getConfiguredCallGraphBuildLimits(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): CallGraphBuildLimits {
  return {
    maxCallsites: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxCallsites',
      DEFAULT_CALL_GRAPH_MAX_CALLSITES,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    maxReferenceCandidates: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxReferenceCandidates',
      DEFAULT_CALL_GRAPH_MAX_REFERENCE_CANDIDATES,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    memoryBudgetMb: getBoundedIntegerSetting(
      cfg,
      'callGraphMemoryBudgetMb',
      DEFAULT_CALL_GRAPH_MEMORY_BUDGET_MB,
      256,
      32_768,
    ),
  };
}

function getConfiguredCallGraphNodePath(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): string {
  return (cfg.get<string>('callGraphNodePath', '') ?? '').trim();
}

function resolveCallGraphWorkerRuntime(
  workerPath: string,
  heapMb: number,
  configuredNodePath: string,
): CallGraphWorkerRuntime {
  const node = findCallGraphNodeExecutable(configuredNodePath);
  if (!node) {
    throw new Error(
      `call graph rebuild requires a real Node.js executable for an ${heapMb}MB worker heap. ` +
      `VS Code's Electron helper ignores --max-old-space-size above its built-in limit. ` +
      `Set intellijStyledSearch.callGraphNodePath to your Node.js binary path.`,
    );
  }
  return {
    command: node.path,
    args: [`--max-old-space-size=${heapMb}`, '--expose-gc', workerPath],
    env: { ...process.env, IJSS_CALL_GRAPH_WORKER: '1' },
    source: node.source,
  };
}

function findCallGraphNodeExecutable(configuredNodePath: string): { path: string; source: string } | undefined {
  const candidates: Array<{ path: string; source: string }> = [];
  if (configuredNodePath) {
    candidates.push({ path: configuredNodePath, source: 'setting:intellijStyledSearch.callGraphNodePath' });
  }
  if (process.env.IJSS_CALL_GRAPH_NODE) {
    candidates.push({ path: process.env.IJSS_CALL_GRAPH_NODE, source: 'env:IJSS_CALL_GRAPH_NODE' });
  }
  if (process.env.npm_node_execpath) {
    candidates.push({ path: process.env.npm_node_execpath, source: 'env:npm_node_execpath' });
  }
  if (process.execPath && !looksLikeElectronExecutable(process.execPath)) {
    candidates.push({ path: process.execPath, source: 'process.execPath' });
  }
  const pathNode = findExecutableOnPath(process.platform === 'win32' ? 'node.exe' : 'node');
  if (pathNode) {
    candidates.push({ path: pathNode, source: 'PATH' });
  }
  candidates.push(...collectCommonNodeExecutables());
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate.path);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) { continue; }
    seen.add(key);
    if (looksLikeElectronExecutable(normalized) || !isExecutableFile(normalized)) { continue; }
    return { path: normalized, source: candidate.source };
  }
  return undefined;
}

function collectCommonNodeExecutables(): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  const home = os.homedir();
  if (home) {
    out.push(
      { path: path.join(home, '.volta', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), source: 'volta' },
      { path: path.join(home, '.asdf', 'shims', process.platform === 'win32' ? 'node.exe' : 'node'), source: 'asdf-shim' },
      ...collectVersionedNodeExecutables(path.join(home, '.nvm', 'versions', 'node'), 'nvm'),
      ...collectVersionedNodeExecutables(path.join(home, '.asdf', 'installs', 'nodejs'), 'asdf-nodejs'),
      ...collectVersionedNodeExecutables(path.join(home, '.fnm', 'node-versions'), 'fnm'),
    );
  }
  out.push(
    { path: '/opt/homebrew/bin/node', source: 'homebrew-arm64' },
    { path: '/usr/local/bin/node', source: 'homebrew-x64' },
    { path: '/usr/bin/node', source: 'system' },
  );
  return out;
}

function collectVersionedNodeExecutables(root: string, source: string): Array<{ path: string; source: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .sort(compareNodeVersionDirDesc)
    .map((entry) => ({
      path: path.join(root, entry, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      source,
    }));
}

function compareNodeVersionDirDesc(a: string, b: string): number {
  const left = parseNodeVersionDir(a);
  const right = parseNodeVersionDir(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (right[i] ?? 0) - (left[i] ?? 0);
    if (delta !== 0) { return delta; }
  }
  return b.localeCompare(a);
}

function parseNodeVersionDir(value: string): number[] {
  return value.replace(/^v/, '').split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function findExecutableOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(name)
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
    : [name];
  for (const dir of dirs) {
    for (const entry of names) {
      const candidate = path.join(dir, entry);
      if (isExecutableFile(candidate)) { return candidate; }
    }
  }
  return undefined;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) { return false; }
    if (process.platform === 'win32') { return true; }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function looksLikeElectronExecutable(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const base = path.basename(normalized);
  return base.includes('electron') || base.includes('code helper');
}

function getConfiguredCallGraphParseLimits(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): CallGraphParseLimits {
  return {
    maxLineLength: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxLineLength',
      DEFAULT_CALL_GRAPH_PARSE_LIMITS.maxLineLength,
      0,
      1_000_000,
    ),
    maxLinesPerFile: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxLinesPerFile',
      DEFAULT_CALL_GRAPH_PARSE_LIMITS.maxLinesPerFile,
      0,
      2_000_000,
    ),
    maxReferenceCandidatesPerFile: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxReferenceCandidatesPerFile',
      DEFAULT_CALL_GRAPH_PARSE_LIMITS.maxReferenceCandidatesPerFile,
      0,
      2_000_000,
    ),
    maxAssignedFunctionNamesPerFile: getBoundedIntegerSetting(
      cfg,
      'callGraphMaxAssignedFunctionNamesPerFile',
      DEFAULT_CALL_GRAPH_PARSE_LIMITS.maxAssignedFunctionNamesPerFile,
      0,
      100_000,
    ),
  };
}

function getConfiguredCallGraphCpuBudget(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): CallGraphCpuBudget {
  return {
    percent: getBoundedIntegerSetting(cfg, 'callGraphCpuBudgetPercent', 35, 1, 100),
    maxPauseMs: getBoundedIntegerSetting(cfg, 'callGraphMaxParserPauseMs', 2_000, 0, 60_000),
  };
}

function getConfiguredCallGraphMaxFileSize(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): number {
  return getBoundedIntegerSetting(
    cfg,
    'callGraphMaxFileSize',
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
}

function getBoundedIntegerSetting(
  cfg: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = cfg.get<number>(key, defaultValue);
  if (!Number.isFinite(raw)) { return defaultValue; }
  return Math.max(min, Math.min(Math.floor(raw), max));
}

async function applyCallGraphCpuBudget(
  activeMs: number,
  budget: CallGraphCpuBudget,
  token?: vscode.CancellationToken,
): Promise<void> {
  if (!Number.isFinite(activeMs) || activeMs < 10 || budget.percent >= 100) { return; }
  const pauseMs = Math.ceil((activeMs * (100 - budget.percent)) / budget.percent);
  const boundedPauseMs = budget.maxPauseMs > 0 ? Math.min(pauseMs, budget.maxPauseMs) : pauseMs;
  if (boundedPauseMs <= 0) { return; }
  await delayWithCancellation(boundedPauseMs, token);
}

function delayWithCancellation(ms: number, token?: vscode.CancellationToken): Promise<void> {
  if (token?.isCancellationRequested) {
    return Promise.reject(new CallGraphRebuildCancelledError());
  }
  return new Promise((resolve, reject) => {
    let subscription: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      subscription?.dispose();
      resolve();
    }, ms);
    subscription = token?.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription?.dispose();
      reject(new CallGraphRebuildCancelledError());
    });
  });
}

function createCallGraphBuildBudgetState(): CallGraphBuildBudgetState {
  return {
    acceptedCallsites: 0,
    acceptedReferenceCandidates: 0,
    droppedCallsites: 0,
    droppedReferenceCandidates: 0,
  };
}

function applyCallGraphBuildBudgetsToRecord(
  record: CallGraphFileRecord,
  limits: CallGraphBuildLimits,
  state: CallGraphBuildBudgetState,
): void {
  const callsiteAllowance = getRemainingCallGraphBudget(limits.maxCallsites, state.acceptedCallsites);
  if (callsiteAllowance !== undefined && record.parsed.calls.length > callsiteAllowance) {
    state.droppedCallsites += record.parsed.calls.length - callsiteAllowance;
    state.firstCallsiteLimitRelPath ??= record.relPath;
    record.parsed.calls = callsiteAllowance > 0 ? record.parsed.calls.slice(0, callsiteAllowance) : [];
  }
  state.acceptedCallsites += record.parsed.calls.length;

  const referenceAllowance = getRemainingCallGraphBudget(
    limits.maxReferenceCandidates,
    state.acceptedReferenceCandidates,
  );
  if (referenceAllowance !== undefined && record.parsed.referenceCandidates.length > referenceAllowance) {
    state.droppedReferenceCandidates += record.parsed.referenceCandidates.length - referenceAllowance;
    state.firstReferenceCandidateLimitRelPath ??= record.relPath;
    record.parsed.referenceCandidates = referenceAllowance > 0
      ? record.parsed.referenceCandidates.slice(0, referenceAllowance)
      : [];
  }
  state.acceptedReferenceCandidates += record.parsed.referenceCandidates.length;
}

function getRemainingCallGraphBudget(limit: number, accepted: number): number | undefined {
  if (limit <= 0) { return undefined; }
  return Math.max(0, limit - accepted);
}

function appendCallGraphBuildBudgetWarnings(
  warnings: string[],
  limits: CallGraphBuildLimits,
  state: CallGraphBuildBudgetState,
): void {
  if (state.droppedCallsites > 0) {
    warnings.push(
      `call graph callsite budget reached at ${limits.maxCallsites}; dropped ${state.droppedCallsites} callsites starting near ${state.firstCallsiteLimitRelPath ?? 'unknown file'}`,
    );
  }
  if (state.droppedReferenceCandidates > 0) {
    warnings.push(
      `call graph reference candidate budget reached at ${limits.maxReferenceCandidates}; dropped ${state.droppedReferenceCandidates} candidates starting near ${state.firstReferenceCandidateLimitRelPath ?? 'unknown file'}`,
    );
  }
}

function buildRecordIndexFromRecords(records: readonly CallGraphFileRecord[]): CallGraphRecordIndexEntry[] {
  return records
    .map((record) => ({
      uri: record.uri,
      relPath: record.relPath,
      language: record.language,
      mtime: record.mtime,
      size: record.size,
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function applyRecordOverridesToRecordIndex(
  recordIndex: readonly CallGraphRecordIndexEntry[],
  overrides: readonly CallGraphRecordOverride[],
): CallGraphRecordIndexEntry[] {
  const byUri = new Map(recordIndex.map((entry) => [entry.uri, entry]));
  for (const override of overrides) {
    if (override.deleted || !override.record) {
      byUri.delete(override.uri);
      continue;
    }
    byUri.set(override.uri, {
      uri: override.record.uri,
      relPath: override.record.relPath,
      language: override.record.language,
      mtime: override.record.mtime,
      size: override.record.size,
    });
  }
  return [...byUri.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function fileMetadataMatches(
  entry: Pick<CallGraphRecordIndexEntry, 'mtime' | 'size'>,
  stat: vscode.FileStat,
): boolean {
  return entry.size === stat.size && entry.mtime === stat.mtime;
}

function getCallGraphConfigSignature(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): string {
  return JSON.stringify({
    version: CALL_GRAPH_CACHE_VERSION,
    maxFileSize: getConfiguredCallGraphMaxFileSize(cfg),
    excludeGlobs: getConfiguredCallGraphExcludeGlobs(cfg),
    parseLimits: getConfiguredCallGraphParseLimits(cfg),
    buildLimits: getConfiguredCallGraphBuildLimits(cfg),
    resolveOptions: getConfiguredCallGraphResolveOptions(cfg),
  });
}

function getConfiguredCallGraphExcludeGlobs(cfg: vscode.WorkspaceConfiguration): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const glob of [
    ...INTERNAL_CALL_GRAPH_EXCLUDE_GLOBS,
    ...cfg.get<string[]>('excludeGlobs', []),
    ...cfg.get<string[]>('callGraphExcludeGlobs', []),
  ]) {
    const trimmed = glob.trim();
    if (!trimmed || seen.has(trimmed)) { continue; }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function createCallGraphExcludeMatcher(cfg: vscode.WorkspaceConfiguration): ((relPath: string) => boolean) | null {
  return compilePathScopeMatcher(undefined, getConfiguredCallGraphExcludeGlobs(cfg));
}

function isCallGraphExcludedUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') { return false; }
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return false; }
  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  return isUriExcludedFromCallGraph(uri, folder.uri.fsPath, createCallGraphExcludeMatcher(cfg));
}

function isUriExcludedFromCallGraph(
  uri: vscode.Uri,
  workspaceRoot: string,
  excludeMatcher: ((relPath: string) => boolean) | null,
): boolean {
  if (!excludeMatcher) { return false; }
  const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
  if (!relPath || relPath.startsWith('../') || relPath === '..' || path.isAbsolute(relPath)) {
    return false;
  }
  return !excludeMatcher(relPath);
}

function getCallGraphHeapPressure(): CallGraphHeapPressure {
  const memory = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapLimitBytes = Math.max(1, heapStats.heap_size_limit);
  const heapUsedBytes = Math.max(0, memory.heapUsed);
  return {
    heapUsedBytes,
    heapLimitBytes,
    heapUsageRatio: heapUsedBytes / heapLimitBytes,
    heapUsedMb: bytesToWholeMb(heapUsedBytes),
    heapLimitMb: bytesToWholeMb(heapLimitBytes),
  };
}

function getCallGraphAdaptiveMemoryOptions(
  memoryBudgetMb: number,
): Pick<CallGraphAdaptiveConcurrencyOptions, 'highWatermarkRatio' | 'resumeRatio' | 'criticalWatermarkRatio'> {
  const pressure = getCallGraphHeapPressure();
  const heapLimitMb = Math.max(1, pressure.heapLimitMb);
  const budgetMb = Number.isFinite(memoryBudgetMb) && memoryBudgetMb > 0
    ? memoryBudgetMb
    : DEFAULT_CALL_GRAPH_MEMORY_BUDGET_MB;
  const highWatermarkRatio = Math.min(
    CALL_GRAPH_HEAP_HIGH_WATERMARK_RATIO,
    Math.max(0.01, budgetMb / heapLimitMb),
  );
  const resumeRatio = Math.min(
    highWatermarkRatio,
    Math.max(0.005, (budgetMb * 0.8) / heapLimitMb),
  );
  const criticalWatermarkRatio = Math.min(
    CALL_GRAPH_HEAP_CRITICAL_WATERMARK_RATIO,
    Math.max(highWatermarkRatio + 0.01, (budgetMb * 1.5) / heapLimitMb),
  );
  return { highWatermarkRatio, resumeRatio, criticalWatermarkRatio };
}

function bytesToWholeMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function formatHeapUsagePercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function maybeRunGarbageCollection(): void {
  const maybeGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof maybeGc !== 'function') { return; }
  try { maybeGc(); } catch {}
}

function createAdaptiveConcurrencySnapshot(input: {
  currentConcurrency: number;
  maxConcurrency: number;
  active: number;
  pressure: CallGraphHeapPressure;
  highWatermarkRatio: number;
  resumeRatio: number;
  throttleCount: number;
  maxHeapUsedMb: number;
  maxHeapUsageRatio: number;
  minConcurrency: number;
}): CallGraphAdaptiveConcurrencySnapshot {
  return {
    currentConcurrency: input.currentConcurrency,
    maxConcurrency: input.maxConcurrency,
    active: input.active,
    heapUsedMb: input.pressure.heapUsedMb,
    heapLimitMb: input.pressure.heapLimitMb,
    heapUsageRatio: input.pressure.heapUsageRatio,
    highWatermarkRatio: input.highWatermarkRatio,
    resumeRatio: input.resumeRatio,
    throttleCount: input.throttleCount,
    maxHeapUsedMb: input.maxHeapUsedMb,
    maxHeapUsageRatio: input.maxHeapUsageRatio,
    minConcurrency: input.minConcurrency,
  };
}

async function mapWithAdaptiveConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: CallGraphAdaptiveConcurrencyOptions = {},
): Promise<{ results: R[]; stats: CallGraphAdaptiveConcurrencyStats }> {
  const results = new Array<R>(items.length);
  const stats = await forEachWithAdaptiveConcurrency(items, concurrency, async (item, index) => {
    results[index] = await worker(item, index);
  }, options);
  return { results, stats };
}

async function forEachWithAdaptiveConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: CallGraphAdaptiveConcurrencyOptions = {},
): Promise<CallGraphAdaptiveConcurrencyStats> {
  const maxConcurrency = Math.min(Math.max(1, Math.floor(concurrency) || 1), items.length || 1);
  const highWatermarkRatio = options.highWatermarkRatio ?? CALL_GRAPH_HEAP_HIGH_WATERMARK_RATIO;
  const resumeRatio = Math.min(highWatermarkRatio, options.resumeRatio ?? CALL_GRAPH_HEAP_RESUME_RATIO);
  const criticalWatermarkRatio = Math.max(
    highWatermarkRatio,
    options.criticalWatermarkRatio ?? CALL_GRAPH_HEAP_CRITICAL_WATERMARK_RATIO,
  );
  const pauseMs = options.pauseMs ?? CALL_GRAPH_HEAP_THROTTLE_PAUSE_MS;
  const stallAbortMs = options.stallAbortMs ?? CALL_GRAPH_HEAP_STALL_ABORT_MS;
  const running = new Set<Promise<void>>();
  let next = 0;
  let completed = 0;
  let currentConcurrency = maxConcurrency;
  let maxObservedConcurrency = 0;
  let minObservedConcurrency = maxConcurrency;
  let throttleCount = 0;
  let maxHeapUsedMb = 0;
  let maxHeapUsageRatio = 0;
  let heapLimitMb = 0;
  let highPressureSince = 0;
  let lastReportAt = 0;

  const throwIfCancelled = () => {
    if (options.token?.isCancellationRequested) {
      throw new CallGraphRebuildCancelledError();
    }
  };
  const updatePressure = () => {
    const pressure = getCallGraphHeapPressure();
    heapLimitMb = pressure.heapLimitMb;
    maxHeapUsedMb = Math.max(maxHeapUsedMb, pressure.heapUsedMb);
    maxHeapUsageRatio = Math.max(maxHeapUsageRatio, pressure.heapUsageRatio);
    return pressure;
  };
  const reportState = (pressure: CallGraphHeapPressure, force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 250) { return; }
    lastReportAt = now;
    options.onStateChange?.(createAdaptiveConcurrencySnapshot({
      currentConcurrency,
      maxConcurrency,
      active: running.size,
      pressure,
      highWatermarkRatio,
      resumeRatio,
      throttleCount,
      maxHeapUsedMb,
      maxHeapUsageRatio,
      minConcurrency: minObservedConcurrency,
    }));
  };

  if (items.length === 0) {
    const pressure = updatePressure();
    reportState(pressure, true);
    return {
      maxConcurrency,
      maxObservedConcurrency: maxConcurrency,
      minObservedConcurrency: maxConcurrency,
      currentConcurrency,
      throttleCount,
      maxHeapUsedMb,
      maxHeapUsageRatio,
      heapLimitMb,
    };
  }

  while (next < items.length || running.size > 0) {
    throwIfCancelled();
    const pressure = updatePressure();
    if (pressure.heapUsageRatio >= highWatermarkRatio) {
      maybeRunGarbageCollection();
      const reducedConcurrency = Math.max(1, Math.floor(currentConcurrency / 2));
      throttleCount += 1;
      if (reducedConcurrency < currentConcurrency) {
        currentConcurrency = reducedConcurrency;
        minObservedConcurrency = Math.min(minObservedConcurrency, currentConcurrency);
      }
      reportState(updatePressure(), true);
      if (running.size > 0) {
        await Promise.race(running);
        continue;
      }
      const latest = updatePressure();
      if (latest.heapUsageRatio >= criticalWatermarkRatio) {
        highPressureSince = highPressureSince || Date.now();
        if (Date.now() - highPressureSince < stallAbortMs) {
          await delay(pauseMs);
          continue;
        }
        throw new Error(
          `call graph rebuild stopped to avoid OOM: V8 heap ` +
          `${latest.heapUsedMb}/${latest.heapLimitMb}MB (${formatHeapUsagePercent(latest.heapUsageRatio)}) ` +
          `stayed above ${formatHeapUsagePercent(criticalWatermarkRatio)} ` +
          `with workers=${currentConcurrency}/${maxConcurrency}`,
        );
      }
      highPressureSince = 0;
      if (currentConcurrency > 1) {
        currentConcurrency = 1;
        minObservedConcurrency = Math.min(minObservedConcurrency, currentConcurrency);
      }
      await delay(pauseMs);
    }
    highPressureSince = 0;
    if (
      pressure.heapUsageRatio < resumeRatio &&
      currentConcurrency < maxConcurrency &&
      completed > 0 &&
      completed % Math.max(1, currentConcurrency) === 0
    ) {
      currentConcurrency += 1;
      reportState(pressure, true);
    }

    let dispatched = false;
    while (next < items.length && running.size < currentConcurrency) {
      const index = next;
      next += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, running.size + 1);
      const task = (async () => {
        try {
          await worker(items[index], index);
        } finally {
          completed += 1;
          if ((completed & 31) === 31) {
            await yieldToExtensionHost();
          }
        }
      })();
      const tracked = task.finally(() => {
        running.delete(tracked);
      });
      running.add(tracked);
      dispatched = true;
    }
    reportState(updatePressure(), dispatched);
    if (running.size > 0) {
      await Promise.race(running);
    } else if (next < items.length) {
      await yieldToExtensionHost();
    }
  }

  const pressure = updatePressure();
  reportState(pressure, true);
  return {
    maxConcurrency,
    maxObservedConcurrency: Math.max(1, maxObservedConcurrency),
    minObservedConcurrency,
    currentConcurrency,
    throttleCount,
    maxHeapUsedMb,
    maxHeapUsageRatio,
    heapLimitMb,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) { return; }
      results[index] = await worker(items[index], index);
      if ((index & 31) === 31) {
        await yieldToExtensionHost();
      }
    }
  }));
  return results;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) { return; }
      await worker(items[index], index);
      if ((index & 31) === 31) {
        await yieldToExtensionHost();
      }
    }
  }));
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
