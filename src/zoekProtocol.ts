export interface ZoektEngineInfo {
  name: string;
  protocolVersion: number;
  schemaVersion: number;
}

export interface ZoektRuntimeStats {
  peakRssBytes: number;
  minorPageFaults: number;
  majorPageFaults: number;
}

export interface ZoektIndexRequest {
  workspaceRoot: string;
  indexDir?: string;
  force?: boolean;
}

export interface ZoektIndexStats {
  totalFiles: number;
  indexedFiles: number;
  skippedBinary: number;
  skippedTooLarge: number;
  shardCount: number;
  overlayEntries: number;
  totalGrams: number;
}

export interface ZoektIndexResponse {
  type: 'index';
  ok: boolean;
  engine: ZoektEngineInfo;
  workspaceRoot: string;
  indexDir: string;
  indexedAtUnixSecs: number;
  stats: ZoektIndexStats;
  warnings: string[];
}

export interface ZoektShardDiagnostic {
  fileName: string;
  shardId: number;
  docCount: number;
  gramCount: number;
  sourceBytes: number;
  fileBytes: number;
  createdUnixSecs: number;
  valid: boolean;
}

export interface ZoektInfoResponse {
  type: 'info';
  ok: boolean;
  engine: ZoektEngineInfo;
  workspaceRoot: string;
  indexDir: string;
  manifestPresent: boolean;
  recoveredOverlay: boolean;
  totalDocumentCount: number;
  totalGramCount: number;
  totalShardBytes: number;
  overlayGeneration: number;
  overlayEntries: number;
  overlayLiveEntries: number;
  overlayTombstones: number;
  journalBytes: number;
  compactionSuggested: boolean;
  cleanedTempFiles: string[];
  warnings: string[];
  process: ZoektRuntimeStats;
  shards: ZoektShardDiagnostic[];
}

export interface ZoektSearchRequest {
  workspaceRoot: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  include: string[];
  limit: number;
  offset: number;
}

export interface ZoektSearchMatch {
  line: number;
  startColumn: number;
  endLine?: number;
  endColumn: number;
  preview: string;
}

export interface ZoektSearchFileResult {
  relPath: string;
  byteLen: number;
  modifiedUnixSecs: number;
  score: number;
  matches: ZoektSearchMatch[];
}

export interface ZoektSearchResponse {
  type: 'search';
  ok: boolean;
  engine: ZoektEngineInfo;
  queryMode: 'literal' | 'regex';
  totalFilesScanned: number;
  totalFilesMatched: number;
  totalMatches: number;
  truncated: boolean;
  warnings: string[];
  files: ZoektSearchFileResult[];
}

export interface ZoektGramDiagnostic {
  gram: string;
  docFreq: number;
}

export interface ZoektDiagnoseResponse {
  type: 'diagnose';
  ok: boolean;
  engine: ZoektEngineInfo;
  workspaceRoot: string;
  query: string;
  effectiveQuery: string;
  queryMode: 'literal' | 'regex';
  include: string[];
  requiredLiterals: string[];
  requiredGrams: string[];
  grams: ZoektGramDiagnostic[];
  baseDocumentCount: number;
  baseCandidateCount: number;
  overlayLiveEntries: number;
  overlayCandidateCount: number;
  finalCandidateCount: number;
  candidateSample: string[];
  fallbackReason?: string;
  warnings: string[];
  process: ZoektRuntimeStats;
}

export interface ZoektUpdateRequest {
  workspaceRoot: string;
  changedPaths: string[];
  deletedPaths: string[];
  renamedPaths: Array<[string, string]>;
}

export interface ZoektUpdateResponse {
  type: 'update';
  ok: boolean;
  engine: ZoektEngineInfo;
  generation: number;
  entriesWritten: number;
  liveEntries: number;
  tombstones: number;
  overlayTotalEntries: number;
  latestVisibleEntries: number;
  journalBytes: number;
  compactionSuggested: boolean;
  warnings: string[];
}

export interface ZoektBenchmarkCase {
  label: string;
  fileCount: number;
  indexMs: number;
  updateP50Ms: number;
  updateP95Ms: number;
  queryP50Ms: number;
  queryP95Ms: number;
  process: ZoektRuntimeStats;
}

export interface ZoektBenchmarkResponse {
  type: 'benchmark';
  ok: boolean;
  engine: ZoektEngineInfo;
  warnings: string[];
  cases: ZoektBenchmarkCase[];
}

export interface ZoektErrorResponse {
  type: 'error';
  ok: boolean;
  engine: ZoektEngineInfo;
  message: string;
}

export type ZoektEngineResponse =
  | ZoektIndexResponse
  | ZoektInfoResponse
  | ZoektSearchResponse
  | ZoektDiagnoseResponse
  | ZoektUpdateResponse
  | ZoektBenchmarkResponse
  | ZoektErrorResponse;
