use crate::config::{ENGINE_NAME, PROTOCOL_VERSION, SCHEMA_VERSION};

#[derive(Clone, Debug)]
pub struct EngineInfo {
    pub name: String,
    pub protocol_version: u32,
    pub schema_version: u32,
}

#[derive(Clone, Debug)]
pub struct IndexRequest {
    pub workspace_root: String,
    pub index_dir: Option<String>,
    pub force: bool,
}

#[derive(Clone, Debug, Default)]
pub struct IndexStats {
    pub total_files: usize,
    pub indexed_files: usize,
    pub skipped_binary: usize,
    pub skipped_too_large: usize,
    pub shard_count: usize,
    pub overlay_entries: usize,
    pub total_grams: usize,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeStats {
    pub peak_rss_bytes: u64,
    pub minor_page_faults: u64,
    pub major_page_faults: u64,
}

#[derive(Clone, Debug)]
pub struct IndexResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub workspace_root: String,
    pub index_dir: String,
    pub indexed_at_unix_secs: u64,
    pub stats: IndexStats,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ShardDiagnostic {
    pub file_name: String,
    pub shard_id: u32,
    pub doc_count: usize,
    pub gram_count: usize,
    pub source_bytes: u64,
    pub file_bytes: u64,
    pub created_unix_secs: u64,
    pub valid: bool,
}

#[derive(Clone, Debug)]
pub struct InfoResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub workspace_root: String,
    pub index_dir: String,
    pub manifest_present: bool,
    pub recovered_overlay: bool,
    pub total_document_count: usize,
    pub total_gram_count: usize,
    pub total_shard_bytes: u64,
    pub overlay_generation: u64,
    pub overlay_entries: usize,
    pub overlay_live_entries: usize,
    pub overlay_tombstones: usize,
    pub journal_bytes: u64,
    pub compaction_suggested: bool,
    pub cleaned_temp_files: Vec<String>,
    pub warnings: Vec<String>,
    pub process: RuntimeStats,
    pub shards: Vec<ShardDiagnostic>,
}

#[derive(Clone, Debug)]
pub struct SearchRequest {
    pub workspace_root: String,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub include: Vec<String>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Clone, Debug)]
pub struct SearchMatch {
    pub line: usize,
    pub start_column: usize,
    pub end_line: Option<usize>,
    pub end_column: usize,
    pub preview: String,
}

#[derive(Clone, Debug)]
pub struct SearchFileResult {
    pub rel_path: String,
    pub byte_len: u64,
    pub modified_unix_secs: u64,
    pub score: i64,
    pub matches: Vec<SearchMatch>,
}

#[derive(Clone, Debug)]
pub struct SearchResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub query_mode: String,
    pub total_files_scanned: usize,
    pub total_files_matched: usize,
    pub total_matches: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
    pub files: Vec<SearchFileResult>,
}

#[derive(Clone, Debug)]
pub struct GramDiagnostic {
    pub gram: String,
    pub doc_freq: usize,
}

#[derive(Clone, Debug)]
pub struct DiagnoseResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub workspace_root: String,
    pub query: String,
    pub effective_query: String,
    pub query_mode: String,
    pub include: Vec<String>,
    pub required_literals: Vec<String>,
    pub required_grams: Vec<String>,
    pub grams: Vec<GramDiagnostic>,
    pub base_document_count: usize,
    pub base_candidate_count: usize,
    pub overlay_live_entries: usize,
    pub overlay_candidate_count: usize,
    pub final_candidate_count: usize,
    pub candidate_sample: Vec<String>,
    pub fallback_reason: Option<String>,
    pub warnings: Vec<String>,
    pub process: RuntimeStats,
}

#[derive(Clone, Debug)]
pub struct OverlayUpdateRequest {
    pub workspace_root: String,
    pub changed_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
    pub renamed_paths: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct OverlayUpdateResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub generation: u64,
    pub entries_written: usize,
    pub live_entries: usize,
    pub tombstones: usize,
    pub overlay_total_entries: usize,
    pub latest_visible_entries: usize,
    pub journal_bytes: u64,
    pub compaction_suggested: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct BenchmarkCase {
    pub label: String,
    pub file_count: usize,
    pub index_ms: u64,
    pub update_p50_ms: u64,
    pub update_p95_ms: u64,
    pub query_p50_ms: u64,
    pub query_p95_ms: u64,
    pub process: RuntimeStats,
}

#[derive(Clone, Debug)]
pub struct BenchmarkResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub warnings: Vec<String>,
    pub cases: Vec<BenchmarkCase>,
}

#[derive(Clone, Debug)]
pub struct ErrorResponse {
    pub ok: bool,
    pub engine: EngineInfo,
    pub message: String,
}

#[derive(Clone, Debug)]
pub enum EngineResponse {
    Index(IndexResponse),
    Info(InfoResponse),
    Search(SearchResponse),
    Diagnose(DiagnoseResponse),
    Update(OverlayUpdateResponse),
    Benchmark(BenchmarkResponse),
    Error(ErrorResponse),
}

impl EngineInfo {
    pub fn current() -> Self {
        Self {
            name: ENGINE_NAME.to_string(),
            protocol_version: PROTOCOL_VERSION,
            schema_version: SCHEMA_VERSION,
        }
    }

    pub fn to_json(&self) -> String {
        format!(
            "{{\"name\":{},\"protocolVersion\":{},\"schemaVersion\":{}}}",
            json_string(&self.name),
            self.protocol_version,
            self.schema_version
        )
    }
}

impl EngineResponse {
    pub fn to_json(&self) -> String {
        match self {
            EngineResponse::Index(response) => response.to_json(),
            EngineResponse::Info(response) => response.to_json(),
            EngineResponse::Search(response) => response.to_json(),
            EngineResponse::Diagnose(response) => response.to_json(),
            EngineResponse::Update(response) => response.to_json(),
            EngineResponse::Benchmark(response) => response.to_json(),
            EngineResponse::Error(response) => response.to_json(),
        }
    }
}

impl IndexResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"index\",\"ok\":{},\"engine\":{},\"workspaceRoot\":{},\"indexDir\":{},\"indexedAtUnixSecs\":{},\"stats\":{},\"warnings\":[{}]}}",
            self.ok,
            self.engine.to_json(),
            json_string(&self.workspace_root),
            json_string(&self.index_dir),
            self.indexed_at_unix_secs,
            self.stats.to_json(),
            json_string_vec(&self.warnings)
        )
    }
}

impl IndexStats {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"totalFiles\":{},\"indexedFiles\":{},\"skippedBinary\":{},\"skippedTooLarge\":{},\"shardCount\":{},\"overlayEntries\":{},\"totalGrams\":{}}}",
            self.total_files,
            self.indexed_files,
            self.skipped_binary,
            self.skipped_too_large,
            self.shard_count,
            self.overlay_entries,
            self.total_grams
        )
    }
}

impl RuntimeStats {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"peakRssBytes\":{},\"minorPageFaults\":{},\"majorPageFaults\":{}}}",
            self.peak_rss_bytes,
            self.minor_page_faults,
            self.major_page_faults
        )
    }
}

impl ShardDiagnostic {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"fileName\":{},\"shardId\":{},\"docCount\":{},\"gramCount\":{},\"sourceBytes\":{},\"fileBytes\":{},\"createdUnixSecs\":{},\"valid\":{}}}",
            json_string(&self.file_name),
            self.shard_id,
            self.doc_count,
            self.gram_count,
            self.source_bytes,
            self.file_bytes,
            self.created_unix_secs,
            self.valid
        )
    }
}

impl InfoResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"info\",\"ok\":{},\"engine\":{},\"workspaceRoot\":{},\"indexDir\":{},\"manifestPresent\":{},\"recoveredOverlay\":{},\"totalDocumentCount\":{},\"totalGramCount\":{},\"totalShardBytes\":{},\"overlayGeneration\":{},\"overlayEntries\":{},\"overlayLiveEntries\":{},\"overlayTombstones\":{},\"journalBytes\":{},\"compactionSuggested\":{},\"cleanedTempFiles\":[{}],\"warnings\":[{}],\"process\":{},\"shards\":[{}]}}",
            self.ok,
            self.engine.to_json(),
            json_string(&self.workspace_root),
            json_string(&self.index_dir),
            self.manifest_present,
            self.recovered_overlay,
            self.total_document_count,
            self.total_gram_count,
            self.total_shard_bytes,
            self.overlay_generation,
            self.overlay_entries,
            self.overlay_live_entries,
            self.overlay_tombstones,
            self.journal_bytes,
            self.compaction_suggested,
            json_string_vec(&self.cleaned_temp_files),
            json_string_vec(&self.warnings),
            self.process.to_json(),
            self.shards.iter().map(ShardDiagnostic::to_json).collect::<Vec<_>>().join(",")
        )
    }
}

impl SearchResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"search\",\"ok\":{},\"engine\":{},\"queryMode\":{},\"totalFilesScanned\":{},\"totalFilesMatched\":{},\"totalMatches\":{},\"truncated\":{},\"warnings\":[{}],\"files\":[{}]}}",
            self.ok,
            self.engine.to_json(),
            json_string(&self.query_mode),
            self.total_files_scanned,
            self.total_files_matched,
            self.total_matches,
            self.truncated,
            json_string_vec(&self.warnings),
            self.files.iter().map(SearchFileResult::to_json).collect::<Vec<_>>().join(",")
        )
    }
}

impl GramDiagnostic {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"gram\":{},\"docFreq\":{}}}",
            json_string(&self.gram),
            self.doc_freq
        )
    }
}

impl DiagnoseResponse {
    pub fn to_json(&self) -> String {
        let fallback_reason = self
            .fallback_reason
            .as_ref()
            .map(|value| format!(",\"fallbackReason\":{}", json_string(value)))
            .unwrap_or_default();
        format!(
            "{{\"type\":\"diagnose\",\"ok\":{},\"engine\":{},\"workspaceRoot\":{},\"query\":{},\"effectiveQuery\":{},\"queryMode\":{},\"include\":[{}],\"requiredLiterals\":[{}],\"requiredGrams\":[{}],\"grams\":[{}],\"baseDocumentCount\":{},\"baseCandidateCount\":{},\"overlayLiveEntries\":{},\"overlayCandidateCount\":{},\"finalCandidateCount\":{},\"candidateSample\":[{}]{},\"warnings\":[{}],\"process\":{}}}",
            self.ok,
            self.engine.to_json(),
            json_string(&self.workspace_root),
            json_string(&self.query),
            json_string(&self.effective_query),
            json_string(&self.query_mode),
            json_string_vec(&self.include),
            json_string_vec(&self.required_literals),
            json_string_vec(&self.required_grams),
            self.grams.iter().map(GramDiagnostic::to_json).collect::<Vec<_>>().join(","),
            self.base_document_count,
            self.base_candidate_count,
            self.overlay_live_entries,
            self.overlay_candidate_count,
            self.final_candidate_count,
            json_string_vec(&self.candidate_sample),
            fallback_reason,
            json_string_vec(&self.warnings),
            self.process.to_json()
        )
    }
}

impl OverlayUpdateResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"update\",\"ok\":{},\"engine\":{},\"generation\":{},\"entriesWritten\":{},\"liveEntries\":{},\"tombstones\":{},\"overlayTotalEntries\":{},\"latestVisibleEntries\":{},\"journalBytes\":{},\"compactionSuggested\":{},\"warnings\":[{}]}}",
            self.ok,
            self.engine.to_json(),
            self.generation,
            self.entries_written,
            self.live_entries,
            self.tombstones,
            self.overlay_total_entries,
            self.latest_visible_entries,
            self.journal_bytes,
            self.compaction_suggested,
            json_string_vec(&self.warnings)
        )
    }
}

impl BenchmarkCase {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"label\":{},\"fileCount\":{},\"indexMs\":{},\"updateP50Ms\":{},\"updateP95Ms\":{},\"queryP50Ms\":{},\"queryP95Ms\":{},\"process\":{}}}",
            json_string(&self.label),
            self.file_count,
            self.index_ms,
            self.update_p50_ms,
            self.update_p95_ms,
            self.query_p50_ms,
            self.query_p95_ms,
            self.process.to_json()
        )
    }
}

impl BenchmarkResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"benchmark\",\"ok\":{},\"engine\":{},\"warnings\":[{}],\"cases\":[{}]}}",
            self.ok,
            self.engine.to_json(),
            json_string_vec(&self.warnings),
            self.cases.iter().map(BenchmarkCase::to_json).collect::<Vec<_>>().join(",")
        )
    }
}

impl SearchFileResult {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"relPath\":{},\"byteLen\":{},\"modifiedUnixSecs\":{},\"score\":{},\"matches\":[{}]}}",
            json_string(&self.rel_path),
            self.byte_len,
            self.modified_unix_secs,
            self.score,
            self.matches.iter().map(SearchMatch::to_json).collect::<Vec<_>>().join(",")
        )
    }
}

impl SearchMatch {
    pub fn to_json(&self) -> String {
        let end_line = self
            .end_line
            .map(|value| format!(",\"endLine\":{value}"))
            .unwrap_or_default();
        format!(
            "{{\"line\":{},\"startColumn\":{}{},\"endColumn\":{},\"preview\":{}}}",
            self.line,
            self.start_column,
            end_line,
            self.end_column,
            json_string(&self.preview)
        )
    }
}

impl ErrorResponse {
    pub fn to_json(&self) -> String {
        format!(
            "{{\"type\":\"error\",\"ok\":{},\"engine\":{},\"message\":{}}}",
            self.ok,
            self.engine.to_json(),
            json_string(&self.message)
        )
    }
}

fn json_string_vec(values: &[String]) -> String {
    values.iter().map(|value| json_string(value)).collect::<Vec<_>>().join(",")
}

pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}
