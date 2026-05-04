import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import * as vscode from 'vscode';
import { findWorkspaceFilesDirect } from './fileDiscovery';

export type CallGraphLanguage = 'python' | 'java' | 'kotlin' | 'typescript' | 'javascript';
export type CallGraphSymbolKind = 'class' | 'interface' | 'enum' | 'type' | 'struct' | 'function' | 'method' | 'constructor' | 'constant';
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

type CallGraphDocumentSummaryChunk = CallGraphCacheChunk & {
  bucket: number;
};

type CallGraphDocumentSummaryFileChunk = CallGraphCacheChunk & {
  uri: string;
  uriHash: string;
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
  maxEdges: number;
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
  maxLineLength: 20_000,
  maxLinesPerFile: 50_000,
  maxReferenceCandidatesPerFile: 50_000,
  maxAssignedFunctionNamesPerFile: 500,
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

const MAX_CALL_GRAPH_CONCURRENCY = 32;
const MAX_POSSIBLE_EDGES_PER_CALL = 40;
const DEFAULT_CALL_GRAPH_CONCURRENCY = getDefaultCallGraphConcurrency();
const DEFAULT_CALL_GRAPH_MAX_EDGES = 10_000_000;
const CALL_GRAPH_SOURCE_GLOB = '**/*.{py,java,kt,kts,ts,tsx,js,jsx,mjs,cjs}';
const CALL_GRAPH_CACHE_VERSION = 9;
const CALL_GRAPH_INCREMENTAL_DEBOUNCE_MS = 1_500;
const CALL_GRAPH_CACHE_RECORDS_PER_CHUNK = 1_000;
const CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK = 50_000;
const CALL_GRAPH_DOCUMENT_SUMMARY_BUCKETS = 256;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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
  private incrementalPromise: Promise<void> | undefined;
  private cacheWritePromise: Promise<void> = Promise.resolve();
  private cacheConfigSignature: string | undefined;
  private cacheManifest: CallGraphCacheManifest | undefined;
  private cacheRecordsLoaded = false;
  private readonly documentSummaryBucketsByIndex = new Map<number, Map<string, CallGraphDocumentSummaryRecord>>();
  private readonly documentSummaryLoadedBuckets = new Set<number>();
  private readonly documentSummaryBucketPromises = new Map<number, Promise<void>>();
  private documentSummaryMigrationPromise: Promise<boolean> | undefined;
  private readonly documentSummaryFilePromises = new Map<string, Promise<boolean>>();

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
        this.scheduleIncrementalRefreshIfSupported(document.uri, 'saved');
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
    this.watcher?.dispose();
    this.onDidChangeSnapshotEmitter.dispose();
  }

  getSnapshot(): CallGraphSnapshot | undefined {
    return this.snapshot;
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
    if (this.snapshot) { return true; }
    if (this.restorePromise) {
      await this.restorePromise;
      if (this.snapshot) { return true; }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
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
  ): Promise<CallGraphSnapshot> {
    if (this.rebuildPromise) { return this.rebuildPromise; }
    this.rebuildPromise = this.doRebuild(report, token).finally(() => {
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  resolveSymbols(query: string, limit = 20): CallGraphSymbol[] {
    const snapshot = this.snapshot;
    if (!snapshot || !query.trim()) { return []; }
    const normalized = query.trim();
    const lower = normalized.toLowerCase();
    const scored = snapshot.symbols
      .map((symbol) => ({ symbol, score: scoreSymbolMatch(symbol, normalized, lower) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName));
    return scored.slice(0, limit).map((entry) => entry.symbol);
  }

  findEnclosingSymbol(uri: vscode.Uri, position: vscode.Position): CallGraphSymbol | undefined {
    const snapshot = this.snapshot;
    if (!snapshot) { return undefined; }
    const symbols = snapshot.symbols
      .filter((symbol) => symbol.uri === uri.toString() && rangeContainsPosition(symbol.bodyRange, position))
      .sort((a, b) => rangeSize(a.bodyRange) - rangeSize(b.bodyRange));
    return symbols.find((symbol) => symbol.kind === 'method' || symbol.kind === 'function') ?? symbols[0];
  }

  findDeclarationSymbolsAtPosition(uri: vscode.Uri, position: vscode.Position): CallGraphSymbol[] {
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
    if (this.snapshot) {
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
      `elapsedMs: ${snapshot.stats.elapsedMs}`,
    ];
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

  private scheduleIncrementalRefresh(uri: vscode.Uri, reason: string): void {
    if (this.disposed) { return; }
    this.pendingChangedUris.add(uri.toString());
    if (this.incrementalTimer) {
      clearTimeout(this.incrementalTimer);
    }
    this.incrementalTimer = setTimeout(() => {
      this.incrementalTimer = undefined;
      const uriStrings = Array.from(this.pendingChangedUris);
      this.pendingChangedUris.clear();
      void this.refreshChangedFiles(uriStrings.map((value) => vscode.Uri.parse(value)), reason)
        .catch((err) => this.log.appendLine(`call graph incremental update failed: ${err instanceof Error ? err.message : err}`));
    }, CALL_GRAPH_INCREMENTAL_DEBOUNCE_MS);
  }

  private scheduleIncrementalRefreshIfSupported(uri: vscode.Uri, reason: string): void {
    if (uri.scheme !== 'file' || !isSupportedSourceUri(uri)) { return; }
    this.scheduleIncrementalRefresh(uri, reason);
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

  private async refreshChangedFilesWithoutSnapshot(uris: vscode.Uri[], reason: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const manifest = this.cacheManifest;
    if (!folder || !manifest) {
      this.log.appendLine(`call graph incremental ${reason}: no cache metadata available; skipped cold update`);
      return;
    }
    const started = Date.now();
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const maxFileSize = cfg.get<number>('maxFileSize', 1_048_576);
    const parseLimits = getConfiguredCallGraphParseLimits(cfg);
    const cpuBudget = getConfiguredCallGraphCpuBudget(cfg);
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
      if (!isSupportedSourceUri(uri)) {
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
    const maxFileSize = cfg.get<number>('maxFileSize', 1_048_576);
    const resolveOptions = getConfiguredCallGraphResolveOptions(cfg);
    const parseConcurrency = getConfiguredCallGraphConcurrency(cfg);
    const parseLimits = getConfiguredCallGraphParseLimits(cfg);
    const cpuBudget = getConfiguredCallGraphCpuBudget(cfg);
    const uniqueUris = dedupeStrings(uris.map((uri) => uri.toString())).map((value) => vscode.Uri.parse(value));
    let changed = 0;
    let skipped = 0;
    const warnings: string[] = [];
    const overrides: CallGraphRecordOverride[] = [];
    for (const uri of uniqueUris) {
      const uriString = uri.toString();
      if (!isSupportedSourceUri(uri)) {
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
    await this.deleteLegacyCacheDirs(folder.uri.fsPath);
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
        this.log.appendLine('call graph cache deleted: version, workspace, or settings changed');
        await this.deleteCacheDir(folder.uri.fsPath, CALL_GRAPH_CACHE_VERSION);
        return;
      }
      if (!Array.isArray(manifest.recordIndex)) {
        this.log.appendLine('call graph cache deleted: missing record index');
        await this.deleteCacheDir(folder.uri.fsPath, CALL_GRAPH_CACHE_VERSION);
        return;
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
          `snapshotChunks=${countSnapshotChunks(this.cacheManifest)} documentSummaryBuckets=${countDocumentSummaryBuckets(this.cacheManifest)} ` +
          `documentSummaryFiles=${countDocumentSummaryFiles(this.cacheManifest)} ` +
          `cachedAt=${cachedAt} restore=lazy`,
        );
      } else {
        this.log.appendLine(
          `call graph cache metadata loaded: recordChunks=${this.cacheManifest.chunks.length} ` +
          `recordIndex=${this.cacheManifest.recordIndex?.length ?? 0} ` +
          `recordOverrides=${this.cacheManifest.recordOverrides?.length ?? 0} ` +
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
        bucketRecords.set(record.uri, record);
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
    const uriString = uri.toString();
    const started = Date.now();
    this.log.appendLine(
      `call graph document summary file migration started: reason=${reason} file=${vscode.workspace.asRelativePath(uri, false)} ` +
      `cachedAt=${new Date(manifest.builtAtUnixMs).toISOString()}`,
    );
    try {
      const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
      const parsed = await parseSourceFileRecord(uri, cfg.get<number>('maxFileSize', 1_048_576));
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
    this.onDidChangeSnapshotEmitter.fire();
  }

  private clearDocumentSummaryCache(): void {
    this.documentSummaryBucketsByIndex.clear();
    this.documentSummaryLoadedBuckets.clear();
    this.documentSummaryBucketPromises.clear();
    this.documentSummaryFilePromises.clear();
  }

  private async persistCache(snapshot: CallGraphSnapshot): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return; }
    const configSignature = this.cacheConfigSignature ?? getCallGraphConfigSignature();
    const records = Array.from(this.fileRecordsByUri.values()).sort((a, b) => a.relPath.localeCompare(b.relPath));
    const recordIndex = buildRecordIndexFromRecords(records);
    const write = async () => {
      try {
        const cacheDir = this.cacheDirUri(folder.uri.fsPath);
        await vscode.workspace.fs.createDirectory(cacheDir);
        const chunks: CallGraphCacheManifest['chunks'] = [];
        let totalBytes = 0;
        chunks.push(...await this.writeCacheArrayChunks(
          folder.uri.fsPath,
          'records',
          records,
          CALL_GRAPH_CACHE_RECORDS_PER_CHUNK,
          (bytes) => { totalBytes += bytes; },
        ));
        const summaryStarted = Date.now();
        const documentSummaryRecords = await buildDocumentSummaryRecords(
          snapshot,
          this.getIndex(snapshot),
          this.getRelationSummaryIndex(snapshot),
        );
        const documentSummaries = await this.writeDocumentSummaryBuckets(
          folder.uri.fsPath,
          documentSummaryRecords,
          (bytes) => { totalBytes += bytes; },
        );
        const snapshotChunks = {
          symbols: await this.writeCacheArrayChunks(
            folder.uri.fsPath,
            'snapshot-symbols',
            snapshot.symbols,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
          edges: await this.writeCacheArrayChunks(
            folder.uri.fsPath,
            'snapshot-edges',
            snapshot.edges,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
          references: await this.writeCacheArrayChunks(
            folder.uri.fsPath,
            'snapshot-references',
            snapshot.references,
            CALL_GRAPH_CACHE_SNAPSHOT_ITEMS_PER_CHUNK,
            (bytes) => { totalBytes += bytes; },
          ),
        };
        const manifest: CallGraphCacheManifest = {
          version: CALL_GRAPH_CACHE_VERSION,
          workspaceRoot: folder.uri.fsPath,
          configSignature,
          builtAtUnixMs: snapshot.builtAtUnixMs,
          chunks,
          recordIndex,
          documentSummaries,
          snapshot: {
            builtAtUnixMs: snapshot.builtAtUnixMs,
            stats: snapshot.stats,
            warnings: snapshot.warnings,
            ...snapshotChunks,
          },
        };
        const encodedManifest = await gzipAsync(Buffer.from(JSON.stringify(manifest), 'utf8'));
        totalBytes += encodedManifest.byteLength;
        await vscode.workspace.fs.writeFile(this.cacheManifestUri(folder.uri.fsPath), encodedManifest);
        this.cacheManifest = manifest;
        this.cacheRecordsLoaded = true;
        this.replaceDocumentSummaryCache(documentSummaryRecords);
        this.log.appendLine(
          `call graph cache saved: files=${records.length} recordChunks=${chunks.length} snapshotChunks=${countSnapshotChunks(manifest)} ` +
          `documentSummaryBuckets=${documentSummaries.length} documentSummaryFiles=${documentSummaryRecords.length} ` +
          `documentSummaryElapsed=${Date.now() - summaryStarted}ms bytes=${totalBytes}`,
        );
      } catch (err) {
        this.log.appendLine(`call graph cache save skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    this.cacheWritePromise = this.cacheWritePromise.then(write, write);
    await this.cacheWritePromise;
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

  private putDocumentSummaryRecord(record: CallGraphDocumentSummaryRecord): void {
    const bucket = documentSummaryBucketForUri(record.uri);
    let bucketRecords = this.documentSummaryBucketsByIndex.get(bucket);
    if (!bucketRecords) {
      bucketRecords = new Map<string, CallGraphDocumentSummaryRecord>();
      this.documentSummaryBucketsByIndex.set(bucket, bucketRecords);
    }
    bucketRecords.set(record.uri, record);
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

  private async tryRebuildFromIndexedCache(input: {
    workspaceRoot: string;
    sourceFiles: vscode.Uri[];
    maxFileSize: number;
    parseConcurrency: number;
    parseLimits: CallGraphParseLimits;
    cpuBudget: CallGraphCpuBudget;
    resolveOptions: CallGraphResolveOptions;
    configSignature: string;
    started: number;
    token?: vscode.CancellationToken;
    onProgress?: (stage: 'checking' | 'parsing', current: number, total: number, message: string) => void;
  }): Promise<CallGraphSnapshot | undefined> {
    const manifest = this.cacheManifest;
    const recordIndex = manifest?.recordIndex;
    if (
      !manifest?.snapshot ||
      manifest.configSignature !== input.configSignature ||
      !Array.isArray(recordIndex) ||
      recordIndex.length === 0
    ) {
      return undefined;
    }
    if (!this.snapshot) {
      await this.restorePersistedSnapshot();
    }
    const baseSnapshot = this.snapshot;
    if (!baseSnapshot) { return undefined; }
    const throwIfCancelled = () => {
      if (input.token?.isCancellationRequested) {
        throw new CallGraphRebuildCancelledError();
      }
    };
    const indexedByUri = new Map(recordIndex.map((entry) => [entry.uri, entry]));
    const sourceSet = new Set(input.sourceFiles.map((uri) => uri.toString()));
    const statConcurrency = Math.min(64, Math.max(input.parseConcurrency, 8));
    let checked = 0;
    const statResults = await mapWithConcurrency<vscode.Uri, {
      uri: vscode.Uri;
      stat?: vscode.FileStat;
      warning?: string;
    }>(input.sourceFiles, statConcurrency, async (uri) => {
      throwIfCancelled();
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        checked += 1;
        input.onProgress?.('checking', checked, input.sourceFiles.length, `checked ${checked}/${input.sourceFiles.length} source files`);
        return { uri, stat };
      } catch (err) {
        checked += 1;
        input.onProgress?.('checking', checked, input.sourceFiles.length, `checked ${checked}/${input.sourceFiles.length} source files`);
        return {
          uri,
          warning: `failed to stat ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
    const changedUris: vscode.Uri[] = [];
    const warnings: string[] = [];
    let reusedFiles = 0;
    for (const result of statResults) {
      if (result.warning || !result.stat) {
        if (result.warning) { warnings.push(result.warning); }
        changedUris.push(result.uri);
        continue;
      }
      const cached = indexedByUri.get(result.uri.toString());
      if (cached && fileMetadataMatches(cached, result.stat)) {
        reusedFiles += 1;
        continue;
      }
      changedUris.push(result.uri);
    }
    const deletedOverrides: CallGraphRecordOverride[] = [];
    for (const entry of recordIndex) {
      if (!sourceSet.has(entry.uri)) {
        deletedOverrides.push({ uri: entry.uri, deleted: true, updatedAtUnixMs: Date.now() });
      }
    }
    if (changedUris.length === 0 && deletedOverrides.length === 0) {
      this.log.appendLine(
        `call graph rebuild reused indexed cache: files=${baseSnapshot.stats.fileCount} checked=${input.sourceFiles.length} ` +
        `reused=${reusedFiles} elapsed=${Date.now() - input.started}ms`,
      );
      return baseSnapshot;
    }
    let parsedCount = 0;
    let skippedCount = 0;
    const parsedResults = await mapWithConcurrency(changedUris, input.parseConcurrency, async (uri) => {
      throwIfCancelled();
      try {
        const parseStarted = Date.now();
        const parsed = await parseSourceFileRecord(uri, input.maxFileSize, input.parseLimits);
        await applyCallGraphCpuBudget(Date.now() - parseStarted, input.cpuBudget, input.token);
        parsedCount += 1;
        if (!parsed.record) { skippedCount += 1; }
        input.onProgress?.('parsing', parsedCount, changedUris.length, `parsed changed ${parsedCount}/${changedUris.length}`);
        return parsed;
      } catch (err) {
        parsedCount += 1;
        skippedCount += 1;
        input.onProgress?.('parsing', parsedCount, changedUris.length, `parsed changed ${parsedCount}/${changedUris.length}`);
        return {
          record: undefined,
          skipped: true,
          warnings: [`failed to parse ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`],
        } satisfies ParsedSourceFileResult;
      }
    });
    const overrides: CallGraphRecordOverride[] = [
      ...deletedOverrides,
      ...parsedResults.map((result, index) => {
        const uriString = changedUris[index].toString();
        return result.record
          ? { uri: uriString, record: result.record, updatedAtUnixMs: Date.now() }
          : { uri: uriString, deleted: true, updatedAtUnixMs: Date.now() };
      }),
    ];
    warnings.push(...parsedResults.flatMap((result) => result.warnings));
    this.applyRecordOverridesToLoadedRecords(overrides);
    const { snapshot, index } = await this.buildIncrementalSnapshotFromOverrides({
      baseSnapshot,
      workspaceRoot: input.workspaceRoot,
      overrides,
      skippedFileCount: skippedCount,
      warnings,
      started: input.started,
      parseConcurrency: input.parseConcurrency,
      resolveOptions: input.resolveOptions,
    });
    this.applySnapshot(snapshot, index, undefined, input.configSignature, { preserveRecords: true });
    await this.persistRecordOverrides(overrides);
    await this.persistDocumentSummaryFilesForRecords(
      parsedResults.map((result) => result.record).filter((record): record is CallGraphFileRecord => !!record),
      snapshot,
      index,
    );
    this.log.appendLine(
      `call graph indexed rebuild updated: reused=${reusedFiles} changed=${changedUris.length} deleted=${deletedOverrides.length} ` +
      `files=${snapshot.stats.fileCount} symbols=${snapshot.stats.symbolCount} edges=${snapshot.stats.edgeCount} ` +
      `elapsed=${snapshot.stats.elapsedMs}ms`,
    );
    return snapshot;
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

  private async doRebuild(
    report?: (progress: CallGraphRebuildProgress) => void,
    token?: vscode.CancellationToken,
  ): Promise<CallGraphSnapshot> {
    const started = Date.now();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    if (this.restorePromise) {
      await this.restorePromise;
    }
    const workspaceRoot = folder.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const excludeGlobs = [
      ...cfg.get<string[]>('excludeGlobs', []),
      ...cfg.get<string[]>('callGraphExcludeGlobs', []),
    ];
    const maxFileSize = cfg.get<number>('maxFileSize', 1_048_576);
    const parseConcurrency = getConfiguredCallGraphConcurrency(cfg);
    const resolveOptions = getConfiguredCallGraphResolveOptions(cfg);
    const parseLimits = getConfiguredCallGraphParseLimits(cfg);
    const cpuBudget = getConfiguredCallGraphCpuBudget(cfg);
    const configSignature = getCallGraphConfigSignature(cfg);
    const progressState = {
      current: 0,
      total: 0,
      parsedFiles: 0,
      skippedFiles: 0,
      warningCount: 0,
      lastReportAt: 0,
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
      report?.({
        stage,
        message,
        current: progressState.current,
        total: progressState.total,
        parsedFiles: progressState.parsedFiles,
        skippedFiles: progressState.skippedFiles,
        warningCount: progressState.warningCount,
        elapsedMs: now - started,
        concurrency: parseConcurrency,
      });
    };
    const throwIfCancelled = () => {
      if (token?.isCancellationRequested) {
        throw new CallGraphRebuildCancelledError();
      }
    };
    throwIfCancelled();
    emitProgress('discovering', 'discovering source files', true);
    const files = await findWorkspaceFilesDirect({
      workspaceFolders: [folder],
      excludeGlobs,
      extensions: SOURCE_EXTENSIONS,
      maxResults: 200_000,
      token,
      onProgress: (count) => {
        progressState.current = count;
        emitProgress('discovering', `discovered ${count} source files`);
      },
    });
    throwIfCancelled();
    const warnings: string[] = [];
    progressState.current = 0;
    const sourceFiles = files.filter((uri) => {
      const ext = path.extname(uri.fsPath).toLowerCase();
      return SOURCE_EXTENSIONS.has(ext) && !uri.fsPath.endsWith('.d.ts');
    });
    progressState.total = sourceFiles.length;
    progressState.current = 0;
    emitProgress('indexing', 'checking call graph cache metadata', true);
    let cachedRecordsAvailable = false;
    const fastSnapshot = await this.tryRebuildFromIndexedCache({
      workspaceRoot,
      sourceFiles,
      maxFileSize,
      parseConcurrency,
      parseLimits,
      cpuBudget,
      resolveOptions,
      configSignature,
      started,
      token,
      onProgress: (stage, current, total, message) => {
        progressState.current = current;
        progressState.total = total;
        emitProgress(stage === 'checking' ? 'indexing' : 'parsing', message);
      },
    });
    if (fastSnapshot) {
      progressState.current = progressState.total;
      progressState.parsedFiles = fastSnapshot.stats.fileCount;
      progressState.skippedFiles = fastSnapshot.stats.skippedFileCount;
      progressState.warningCount = fastSnapshot.warnings.length;
      emitProgress('done', `done in ${Date.now() - started}ms`, true);
      return fastSnapshot;
    }
    if (this.cacheManifest?.configSignature === configSignature) {
      cachedRecordsAvailable = await this.ensureCachedRecordsLoaded();
      if (cachedRecordsAvailable && await this.persistRecordIndexFromLoadedRecordsIfMissing()) {
        progressState.current = 0;
        progressState.total = sourceFiles.length;
        const migratedFastSnapshot = await this.tryRebuildFromIndexedCache({
          workspaceRoot,
          sourceFiles,
          maxFileSize,
          parseConcurrency,
          parseLimits,
          cpuBudget,
          resolveOptions,
          configSignature,
          started,
          token,
          onProgress: (stage, current, total, message) => {
            progressState.current = current;
            progressState.total = total;
            emitProgress(stage === 'checking' ? 'indexing' : 'parsing', message);
          },
        });
        if (migratedFastSnapshot) {
          progressState.current = progressState.total;
          progressState.parsedFiles = migratedFastSnapshot.stats.fileCount;
          progressState.skippedFiles = migratedFastSnapshot.stats.skippedFileCount;
          progressState.warningCount = migratedFastSnapshot.warnings.length;
          emitProgress('done', `done in ${Date.now() - started}ms`, true);
          return migratedFastSnapshot;
        }
      }
    }
    const cachedRecordsByUri = cachedRecordsAvailable ? new Map(this.fileRecordsByUri) : new Map<string, CallGraphFileRecord>();
    let reusedFiles = 0;
    progressState.current = 0;
    progressState.total = sourceFiles.length;
    emitProgress(
      'parsing',
      `parsing ${sourceFiles.length} source files with ${parseConcurrency} workers`,
      true,
    );
    const parsedResults = await mapWithConcurrency(sourceFiles, parseConcurrency, async (uri) => {
      throwIfCancelled();
      if (this.disposed) {
        progressState.current += 1;
        progressState.skippedFiles += 1;
        emitProgress('parsing', `parsed ${progressState.current}/${progressState.total}`);
        return { record: undefined, warnings: [] as string[], skipped: true } satisfies ParsedSourceFileResult;
      }
      try {
        const cachedRecord = cachedRecordsByUri.get(uri.toString());
        if (cachedRecord) {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (fileMetadataMatches(cachedRecord, stat)) {
              progressState.current += 1;
              progressState.parsedFiles += 1;
              reusedFiles += 1;
              emitProgress('parsing', `reused ${reusedFiles}, parsed ${progressState.current}/${progressState.total}`);
              return { record: cachedRecord, warnings: [] as string[], skipped: false, reused: true } satisfies ParsedSourceFileResult;
            }
          } catch {
            // Fall through to parsing; parseSourceFileRecord will surface a useful warning if the file vanished.
          }
        }
        const parseStarted = Date.now();
        const parsed = await parseSourceFileRecord(uri, maxFileSize, parseLimits);
        await applyCallGraphCpuBudget(Date.now() - parseStarted, cpuBudget, token);
        throwIfCancelled();
        progressState.current += 1;
        if (parsed.record) {
          progressState.parsedFiles += 1;
        } else {
          progressState.skippedFiles += 1;
        }
        progressState.warningCount += parsed.warnings.length;
        emitProgress('parsing', `reused ${reusedFiles}, parsed ${progressState.current}/${progressState.total}`);
        return parsed;
      } catch (err) {
        const warning = `failed to parse ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`;
        progressState.current += 1;
        progressState.skippedFiles += 1;
        progressState.warningCount += 1;
        emitProgress('parsing', `reused ${reusedFiles}, parsed ${progressState.current}/${progressState.total}`);
        return { record: undefined, warnings: [warning], skipped: true } satisfies ParsedSourceFileResult;
      }
    });
    emitProgress('parsing', `reused ${reusedFiles}, parsed ${progressState.current}/${progressState.total}`, true);
    const records = parsedResults
      .map((result) => result.record)
      .filter((result): result is CallGraphFileRecord => !!result);
    warnings.push(...parsedResults.flatMap((result) => result.warnings));
    const parsedWarnings = records.flatMap((record) => record.parsed.warnings);
    warnings.push(...parsedWarnings);
    progressState.warningCount = warnings.length;
    progressState.current = 0;
    progressState.total = records.reduce((sum, record) => sum + record.parsed.symbols.length, 0);
    emitProgress('indexing', `indexing ${progressState.total} symbols`, true);
    throwIfCancelled();
    const index = buildSymbolIndex(records.flatMap((record) => record.parsed.symbols), records.flatMap((record) => record.parsed.bindings));
    const references = resolveReferenceCandidates(
      records.flatMap((record) => record.parsed.referenceCandidates),
      records.flatMap((record) => record.parsed.symbols),
      index,
    );
    const calls = records.flatMap((record) => record.parsed.calls);
    progressState.current = 0;
    progressState.total = calls.length;
    emitProgress('resolving', `resolving ${calls.length} callsites`, true);
    const resolvedCalls = await resolveCallsAsync(calls, index, {
      token,
      resolveOptions,
      onProgress: (current, total) => {
        progressState.current = current;
        progressState.total = total;
        emitProgress('resolving', `resolved ${current}/${total} callsites`);
      },
    });
    const edges = resolvedCalls.edges;
    if (resolvedCalls.edgeLimitHit) {
      warnings.push(`call graph unique edge limit reached at ${resolveOptions.maxEdges}; skipped additional materialized edges`);
    }
    if (!resolveOptions.includePossibleEdges && resolvedCalls.skippedPossibleEdgeCount > 0) {
      warnings.push(`skipped ${resolvedCalls.skippedPossibleEdgeCount} possible edges; enable intellijStyledSearch.callGraphIncludePossibleEdges to materialize them`);
    }
    if (!resolveOptions.includeUnresolvedEdges && resolvedCalls.skippedUnresolvedEdgeCount > 0) {
      warnings.push(`skipped ${resolvedCalls.skippedUnresolvedEdgeCount} unresolved callsites; enable intellijStyledSearch.callGraphIncludeUnresolvedEdges to materialize them`);
    }
    const languageCounts: Record<CallGraphLanguage, number> = {
      python: 0,
      java: 0,
      kotlin: 0,
      typescript: 0,
      javascript: 0,
    };
    const symbols = records.flatMap((record) => record.parsed.symbols);
    for (const symbol of symbols) {
      languageCounts[symbol.language] += 1;
    }
    const snapshot: CallGraphSnapshot = {
      workspaceRoot,
      builtAtUnixMs: Date.now(),
      symbols: symbols.map(stripMutableSymbol),
      edges,
      references,
      warnings,
      stats: {
        fileCount: records.length,
        symbolCount: symbols.length,
        edgeCount: edges.length,
        exactEdgeCount: edges.filter((edge) => edge.confidence === 'exact' || edge.confidence === 'resolved').length,
        possibleEdgeCount: edges.filter((edge) => edge.confidence === 'possible').length,
        unresolvedEdgeCount: edges.filter((edge) => edge.confidence === 'unresolved').length,
        languageCounts,
        elapsedMs: Date.now() - started,
        parseConcurrency,
        skippedFileCount: progressState.skippedFiles,
        callsiteCount: calls.length,
        skippedPossibleEdgeCount: resolvedCalls.skippedPossibleEdgeCount,
        skippedUnresolvedEdgeCount: resolvedCalls.skippedUnresolvedEdgeCount,
        edgeLimitHit: resolvedCalls.edgeLimitHit,
        referenceCount: references.length,
      },
    };
    this.applySnapshot(snapshot, index, records, configSignature);
    await this.persistCache(snapshot);
    this.log.appendLine(
      `call graph rebuilt: files=${snapshot.stats.fileCount} skipped=${snapshot.stats.skippedFileCount} reused=${reusedFiles} symbols=${snapshot.stats.symbolCount} edges=${snapshot.stats.edgeCount} references=${snapshot.stats.referenceCount} workers=${snapshot.stats.parseConcurrency} elapsed=${snapshot.stats.elapsedMs}ms`,
    );
    progressState.current = progressState.total;
    progressState.parsedFiles = snapshot.stats.fileCount;
    progressState.skippedFiles = snapshot.stats.skippedFileCount;
    progressState.warningCount = snapshot.warnings.length;
    emitProgress('done', `done in ${snapshot.stats.elapsedMs}ms`, true);
    return snapshot;
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
  if (stat.size > maxFileSize) {
    return { skipped: true, warnings: [] };
  }
  const language = LANGUAGE_BY_EXTENSION.get(path.extname(uri.fsPath).toLowerCase());
  if (!language) {
    return { skipped: true, warnings: [] };
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString('utf8');
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
}): Promise<{ snapshot: CallGraphSnapshot; index: SymbolIndex }> {
  const symbols = input.records.flatMap((record) => record.parsed.symbols);
  const index = buildSymbolIndex(symbols, input.records.flatMap((record) => record.parsed.bindings));
  const references = resolveReferenceCandidates(
    input.records.flatMap((record) => record.parsed.referenceCandidates),
    symbols,
    index,
  );
  const calls = input.records.flatMap((record) => record.parsed.calls);
  const resolvedCalls = await resolveCallsAsync(calls, index, {
    token: input.token,
    resolveOptions: input.resolveOptions,
    onProgress: input.onResolveProgress,
  });
  const warnings = [
    ...input.warnings,
    ...input.records.flatMap((record) => record.parsed.warnings),
  ];
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
      symbols: symbols.map(stripMutableSymbol),
      edges,
      references,
      warnings,
      stats: {
        fileCount: input.records.length,
        symbolCount: symbols.length,
        edgeCount: edges.length,
        exactEdgeCount: edges.filter((edge) => edge.confidence === 'exact' || edge.confidence === 'resolved').length,
        possibleEdgeCount: edges.filter((edge) => edge.confidence === 'possible').length,
        unresolvedEdgeCount: edges.filter((edge) => edge.confidence === 'unresolved').length,
        languageCounts,
        elapsedMs: Date.now() - input.started,
        parseConcurrency: input.parseConcurrency,
        skippedFileCount: input.skippedFileCount,
        callsiteCount: calls.length,
        skippedPossibleEdgeCount: resolvedCalls.skippedPossibleEdgeCount,
        skippedUnresolvedEdgeCount: resolvedCalls.skippedUnresolvedEdgeCount,
        edgeLimitHit: resolvedCalls.edgeLimitHit,
        referenceCount: references.length,
      },
    },
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
    if (edgeKeys.size >= options.resolveOptions.maxEdges) {
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
  return isTypeSymbol(symbol) || symbol.kind === 'constant' || isAnonymousFunctionAssignmentSymbol(symbol);
}

function isExternalApiSymbol(symbol: CallGraphSymbol): boolean {
  if (symbol.containerId) { return false; }
  if (!isCallableSymbol(symbol) && !isTypeSymbol(symbol) && symbol.kind !== 'constant') { return false; }
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

function getDefaultCallGraphConcurrency(): number {
  const availableParallelism = (os as typeof os & { availableParallelism?: () => number }).availableParallelism?.();
  const cpuCount = Number.isFinite(availableParallelism) && availableParallelism && availableParallelism > 0
    ? availableParallelism
    : os.cpus().length || 4;
  return Math.max(2, Math.min(MAX_CALL_GRAPH_CONCURRENCY, Math.max(cpuCount, cpuCount * 2)));
}

function getConfiguredCallGraphConcurrency(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): number {
  const raw = cfg.get<number>('callGraphConcurrency', 0);
  if (!Number.isFinite(raw) || raw <= 0) { return DEFAULT_CALL_GRAPH_CONCURRENCY; }
  return Math.max(1, Math.min(Math.floor(raw), MAX_CALL_GRAPH_CONCURRENCY));
}

function getConfiguredCallGraphResolveOptions(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): CallGraphResolveOptions {
  const includePossibleEdges = cfg.get<boolean>('callGraphIncludePossibleEdges', false);
  const includeUnresolvedEdges = cfg.get<boolean>('callGraphIncludeUnresolvedEdges', true);
  const rawMaxEdges = cfg.get<number>('callGraphMaxEdges', DEFAULT_CALL_GRAPH_MAX_EDGES);
  const rawMaxPossibleTargets = cfg.get<number>('callGraphMaxPossibleTargetsPerCall', 8);
  const maxEdges = Number.isFinite(rawMaxEdges) && rawMaxEdges > 0
    ? Math.max(1_000, Math.floor(rawMaxEdges))
    : DEFAULT_CALL_GRAPH_MAX_EDGES;
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
    maxFileSize: cfg.get<number>('maxFileSize', 1_048_576),
    excludeGlobs: cfg.get<string[]>('excludeGlobs', []),
    callGraphExcludeGlobs: cfg.get<string[]>('callGraphExcludeGlobs', []),
    resolveOptions: getConfiguredCallGraphResolveOptions(cfg),
  });
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

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stableHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
