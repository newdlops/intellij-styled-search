use crate::config::EngineConfig;
use crate::corpus::{
    decode_bytes, read_file_bytes_with_limit_if_not_binary, CorpusEntry, ReadTextBytesOutcome,
};
use crate::mmap_store::write_atomically;
use ahash::{AHashMap, AHashSet, HashMapExt, HashSetExt};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub type ArcStr = Arc<str>;

/// Phase 1: string interning infrastructure.
///
/// `StrTable` assigns a stable `u32` id to each unique string. After Phase 2
/// migrates the hot loops, HashMap probes that currently key on `&str` will
/// key on `u32` instead — ahash on a 4-byte integer is ~10× faster than on
/// a variable-length string, and per-record memory drops from ~24 bytes (a
/// `String` field) to 4 bytes.
///
/// Workers intern into local tables during parse; tables merge at the end
/// of parse into a canonical table, and worker-local ids are remapped
/// in-place to canonical ids via a per-worker translation table.
///
/// For the initial commit this is foundation only — no callers yet. The
/// follow-up turns add interning at parse time (kind, language, edge_kind,
/// access_kind first, then rel_path/name/id) and read the interned form
/// in resolve.
#[derive(Clone, Debug, Default)]
pub(crate) struct StrTable {
    /// Canonical strings indexed by id. `strings[id as usize]` is the
    /// owning copy; everything else holds the id.
    strings: Vec<String>,
    /// id lookup. Uses ahash for fast `&str` probes.
    map: AHashMap<String, u32>,
}

#[allow(dead_code)]
impl StrTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern `s` and return its id. Allocates a `String` only if the
    /// entry is new.
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        let owned = s.to_string();
        self.strings.push(owned.clone());
        self.map.insert(owned, id);
        id
    }

    /// Resolve `id` back to its canonical string. Panics if `id` is out
    /// of range — callers must use ids from the same table.
    pub fn get(&self, id: u32) -> &str {
        &self.strings[id as usize]
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

    /// Merge another table into this one, returning a translation map
    /// `other.id -> self.id`. Used when worker-local tables roll up into
    /// the canonical table.
    pub fn merge_from(&mut self, other: &StrTable) -> Vec<u32> {
        let mut translation: Vec<u32> = Vec::with_capacity(other.strings.len());
        for s in &other.strings {
            translation.push(self.intern(s));
        }
        translation
    }
}

/// Hard cap on worker count. With streaming spill+merge each worker stays
/// under the spill threshold (~512MB), so 32 workers keep peak at ~16GB
/// plus the main-thread overhead — right at the process budget.
const MAX_GRAPH_WORKERS: usize = 128;

/// Memory-aware worker count. Default 128 (= MAX_GRAPH_WORKERS) — rayon
/// work-stealing handles oversubscription well, and the W12 pool sweep on
/// captain2 placed 128 marginally ahead of 64 (~−1.7s wall). Override with
/// ZOEK_GRAPH_WORKERS=N up to MAX_GRAPH_WORKERS.
fn graph_worker_count(total: usize) -> usize {
    let workers = std::env::var("ZOEK_GRAPH_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(MAX_GRAPH_WORKERS);
    workers.min(MAX_GRAPH_WORKERS).min(total.max(1))
}

/// Phase E worker count. Originally capped at 16 to limit HashMap merge
/// cost / cache contention, but with the LightRef-based working set (Phase
/// 4-Q peak ~13GB) the memory ceiling that justified the cap is no longer
/// the bottleneck — let phase E use the full process worker budget.
fn graph_resolve_e_worker_count(total: usize) -> usize {
    let workers = std::env::var("ZOEK_RESOLVE_E_WORKERS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| graph_worker_count(total));
    workers.min(MAX_GRAPH_WORKERS).min(total.max(1))
}

/// Per-worker memory ceiling. The process RLIMIT_AS (16GB) is the real
/// guardrail; this per-worker check is a soft early-abort. Default 0
/// (disabled) — the spill threshold and RLIMIT_AS together bound peak
/// memory. Set ZOEK_WORKER_MEMORY_LIMIT_BYTES to opt into early abort.
fn worker_memory_limit() -> usize {
    std::env::var("ZOEK_WORKER_MEMORY_LIMIT_BYTES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
}

/// Acquire an exclusive flock on the workspace's graph build lockfile.
/// Subsequent zoek-rs invocations that race to rebuild/update the same
/// graph will block here (kernel-side, no CPU/memory busy-wait) until the
/// first process drops the lock. Drop the returned guard to release.
fn acquire_graph_lock(workspace_root: &Path) -> io::Result<fs::File> {
    let lock_dir = workspace_root.join(".zoek-rs");
    fs::create_dir_all(&lock_dir)?;
    let lock_path = lock_dir.join("graph-rebuild.lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = file.as_raw_fd();
        // Non-blocking try first; if it fails, log once and block.
        let try_now = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
        if try_now != 0 {
            eprintln!(
                "[graph-lock] another zoek-rs is holding {} — waiting",
                lock_path.display()
            );
            let r = unsafe { libc::flock(fd, libc::LOCK_EX) };
            if r != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(file)
}

/// Cap virtual address space for the indexer process. Default 16GB; override
/// with ZOEK_MEMORY_CAP_BYTES. Best-effort: silently ignored on platforms
/// that don't honor RLIMIT_AS (macOS may ignore).
/// Configure the global rayon thread pool. Sized to ZOEK_GRAPH_WORKERS (or
/// the 128 default, matching MAX_GRAPH_WORKERS) so par_iter / par_sort_by_key
/// scale across more threads than the OS reports as physical cores — phase E
/// is HashMap-heavy and more concurrent probes hide memory stalls. Captain2
/// pool sweep (W12) showed 64→128 trims ~1.7s; 15 (physical) is the worst.
fn apply_rayon_pool_size() {
    static APPLIED: std::sync::Once = std::sync::Once::new();
    APPLIED.call_once(|| {
        let workers = std::env::var("ZOEK_GRAPH_WORKERS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(MAX_GRAPH_WORKERS)
            .min(MAX_GRAPH_WORKERS);
        let _ = rayon::ThreadPoolBuilder::new()
            .num_threads(workers)
            .build_global();
    });
}

fn apply_memory_cap() {
    static APPLIED: std::sync::Once = std::sync::Once::new();
    APPLIED.call_once(|| {
        let bytes: u64 = std::env::var("ZOEK_MEMORY_CAP_BYTES")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(16u64 * 1024 * 1024 * 1024);
        #[cfg(unix)]
        unsafe {
            let lim = libc::rlimit {
                rlim_cur: bytes as libc::rlim_t,
                rlim_max: bytes as libc::rlim_t,
            };
            libc::setrlimit(libc::RLIMIT_AS, &lim);
        }
        let _ = bytes;
    });
}

trait ArcStrExt {
    fn as_str(&self) -> &str;
}
impl ArcStrExt for ArcStr {
    #[inline(always)]
    fn as_str(&self) -> &str {
        self
    }
}
type HashMap<K, V> = std::collections::HashMap<K, V, ahash::RandomState>;
type HashSet<T> = std::collections::HashSet<T, ahash::RandomState>;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const GRAPH_VERSION: u32 = 6;
const GRAPH_FILE_NAME: &str = "callgraph-relations.tsv";
const GRAPH_SYMBOL_FILE_NAME: &str = "callgraph-symbols.tsv";
const GRAPH_COUNT_FILE_NAME: &str = "callgraph-counts.tsv";
const GRAPH_MANIFEST_NAME: &str = "callgraph-manifest.json";
const GRAPH_REFERENCE_TARGET_SHARD_PREFIX: &str = "callgraph-reference-targets";
const GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX: &str = "callgraph-reference-enclosing";
const GRAPH_SYMBOL_ID_SHARD_PREFIX: &str = "callgraph-symbols-by-id";
const GRAPH_SYMBOL_URI_SHARD_PREFIX: &str = "callgraph-symbols-by-uri";
const GRAPH_COUNT_ID_SHARD_PREFIX: &str = "callgraph-counts-by-id";
const GRAPH_HIERARCHY_PARENT_SHARD_PREFIX: &str = "callgraph-hierarchy-by-parent";
const GRAPH_METHOD_CONTAINER_SHARD_PREFIX: &str = "callgraph-methods-by-container";
const GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX: &str = "callgraph-ref-sites-by-file";
const GRAPH_FACTS_BY_FILE_SHARD_PREFIX: &str = "callgraph-facts-by-file";
const GRAPH_FILE_TABLE_NAME: &str = "callgraph-file-table.bin";
const GRAPH_SHARD_COUNT: usize = 128;

const BOUND_MAY: u8 = 0b0001;
const BOUND_MUST: u8 = 0b0010;
const _BOUND_OBSERVED: u8 = 0b0100;
const MAX_EAGER_IMPLEMENTATION_SYMBOLS: usize = 50_000;
const MAX_TOKEN_SHAPE_REFERENCE_FANOUT_PER_KEY: usize = 512;
const RETURN_TYPE_FACT_PREFIX: &str = "__ijss_return_of__:";
const DJANGO_MODEL_MANAGER_FACT_PREFIX: &str = "__ijss_django_model_manager_of__:";

#[derive(Clone, Debug)]
pub struct GraphIndexSummary {
    pub workspace_root: String,
    pub index_path: String,
    pub indexed_at_unix_secs: u64,
    pub built_at_unix_ms: u64,
    pub file_count: usize,
    pub symbol_count: usize,
    pub reference_count: usize,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct GraphRebuildProgress {
    pub stage: &'static str,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GraphReference {
    /// All string fields use `Box<str>` to drop the 8-byte capacity word per
    /// field. With 11 string fields × 14.4M references in flight during
    /// resolve+stream, that is roughly 1.15 GB less working-set memory and
    /// correspondingly better cache locality. Test assertions compare these
    /// against literals via `&*reference.field == "..."` so the change is
    /// transparent to tests.
    pub source_ref_id: Box<str>,
    pub target_symbol_id: Option<Box<str>>,
    pub edge_kind: Box<str>,
    pub name: Box<str>,
    pub raw_text: Box<str>,
    pub uri: Box<str>,
    pub rel_path: Box<str>,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub enclosing_symbol_id: Option<Box<str>>,
    pub bound_mask: u8,
    pub confidence: Box<str>,
    pub provenance: Box<str>,
}

/// Compact intermediate representation for a resolved reference. Stores only
/// fields *unique* to the (site, target) pair plus a reference index back
/// into the `ref_sites` array; the consumer (write/stream) reconstructs the
/// remaining fields from that array on demand.
///
/// Per-record size: ~24 bytes vs ~152 bytes for `GraphReference`. With 14.4M
/// in-flight references during resolve, that is ~1.8 GB less working set.
///
/// Variants and a small interned set of `confidence`/`provenance` strings
/// cover all push call sites without per-record `String` allocation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)] // Wired in stages; integration follows in next turns.
pub(crate) struct LightRef {
    /// Position of the source `RefSite` in the `ref_sites` slice that owns
    /// all site-derived fields (rel_path, uri, name, raw_text, etc.).
    pub site_idx: u32,
    /// `target.id` as `Box<str>` because targets do not share allocation
    /// with `RefSite`; the symbol slice owns the canonical String but we
    /// keep an independent Box<str> for serde and cross-thread movement.
    pub target_symbol_id: Option<Box<str>>,
    pub bound_mask: u8,
    pub confidence: LightConfidence,
    pub provenance: LightProvenance,
}

/// Confidence levels — a closed set so the byte representation is
/// sufficient. `as_str` returns the canonical literal used by sidecar
/// writers and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub(crate) enum LightConfidence {
    Possible,
    Exact,
}

#[allow(dead_code)]
impl LightConfidence {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            LightConfidence::Possible => "possible",
            LightConfidence::Exact => "exact",
        }
    }
}

/// Provenance values — a closed set covering all current push call sites
/// (see `push_resolved_reference` callers in phase E / F).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[allow(dead_code)]
pub(crate) enum LightProvenance {
    Import,
    ImportStar,
    ImportNamespace,
    ImportedType,
    ReceiverSelf,
    ReceiverType,
    TypeFact,
    Lexical,
    UniqueName,
    TokenShape,
    ExternalTsv,
}

#[allow(dead_code)]
impl LightProvenance {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            LightProvenance::Import => "import",
            LightProvenance::ImportStar => "import-star",
            LightProvenance::ImportNamespace => "import-namespace",
            LightProvenance::ImportedType => "imported-type",
            LightProvenance::ReceiverSelf => "receiver-self",
            LightProvenance::ReceiverType => "receiver-type",
            LightProvenance::TypeFact => "type-fact",
            LightProvenance::Lexical => "lexical",
            LightProvenance::UniqueName => "unique-name",
            LightProvenance::TokenShape => "token-shape",
            LightProvenance::ExternalTsv => "external-tsv",
        }
    }
}

// Phase 1.4: kind classification cache flags. Stored as u8 on GraphSymbol so
// hot resolve paths can do `sym.kind_flags & KF_TYPE != 0` instead of a
// string match against `sym.kind`. Skipped by serde — recomputed at every
// construction site via compute_kind_flags().
pub(crate) const KF_TYPE: u8 = 1 << 0;
pub(crate) const KF_BARE_FB: u8 = 1 << 1;
pub(crate) const KF_MEMBER_FB: u8 = 1 << 2;

pub(crate) fn compute_kind_flags(kind: &str) -> u8 {
    let mut f = 0u8;
    if is_type_kind(kind) {
        f |= KF_TYPE;
    }
    if is_bare_identifier_fallback_symbol(kind) {
        f |= KF_BARE_FB;
    }
    if is_member_identifier_fallback_symbol(kind) {
        f |= KF_MEMBER_FB;
    }
    f
}

// Phase 1.5: language id interning. Closed set of language strings produced
// by language_for_path(). Mapping these to a small u16 lets HashMap keys go
// from `(&str, &str)` (two string hashes) to `(u16, &str)` (one int + one
// string hash). 0 = unknown (collisions OK since unknown languages don't
// match any real symbol in maps that use this key).
pub(crate) const LANG_UNKNOWN: u16 = 0;
pub(crate) fn compute_language_id(language: &str) -> u16 {
    match language {
        "python" => 1,
        "javascript" => 2,
        "typescript" => 3,
        "java" => 4,
        "kotlin" => 5,
        "graphql" => 6,
        "rust" => 7,
        "go" => 8,
        "csharp" => 9,
        "ruby" => 10,
        "php" => 11,
        "swift" => 12,
        "scala" => 13,
        "cpp" => 14,
        "text" => 15,
        _ => LANG_UNKNOWN,
    }
}

/// Inverse of `compute_language_id` for shard parse paths.
/// Returns None for unknown ids (caller must fall back to in-band string).
fn language_str_from_id(id: u16) -> Option<&'static str> {
    Some(match id {
        1 => "python",
        2 => "javascript",
        3 => "typescript",
        4 => "java",
        5 => "kotlin",
        6 => "graphql",
        7 => "rust",
        8 => "go",
        9 => "csharp",
        10 => "ruby",
        11 => "php",
        12 => "swift",
        13 => "scala",
        14 => "cpp",
        15 => "text",
        _ => return None,
    })
}

// Phase 3 aggressive: encode RefSite enums as u8 ids on disk. 38M ref_sites
// × ~26B saved (lang+edge+access string headers) ≈ ~1GB shard size cut.
// 255 reserved for "string follows inline" (unknown enum value).
const EDGE_KIND_OTHER: u8 = 255;
#[allow(dead_code)]
const EDGE_KIND_USAGE: u8 = 0;
const EDGE_KIND_CALL: u8 = 1;
const EDGE_KIND_CONSTRUCT: u8 = 2;
const ACCESS_KIND_OTHER: u8 = 255;
const ACCESS_KIND_BARE: u8 = 0;
const ACCESS_KIND_MEMBER: u8 = 1;

#[inline]
fn compute_edge_kind_id(s: &str) -> u8 {
    match s {
        "usage" => 0,
        "call" => 1,
        "construct" => 2,
        _ => EDGE_KIND_OTHER,
    }
}

#[inline]
fn edge_kind_str_from_id(id: u8) -> Option<&'static str> {
    Some(match id {
        0 => "usage",
        1 => "call",
        2 => "construct",
        _ => return None,
    })
}

#[inline]
fn compute_access_kind_id(s: &str) -> u8 {
    match s {
        "bare" => 0,
        "member" => 1,
        _ => ACCESS_KIND_OTHER,
    }
}

#[inline]
fn access_kind_str_from_id(id: u8) -> Option<&'static str> {
    Some(match id {
        0 => "bare",
        1 => "member",
        _ => return None,
    })
}

// D1c (W11): confidence/provenance closed-set enum tables. Mirror
// LightConfidence / LightProvenance string canonicalization so the on-disk
// reference shard can store a 1-byte id instead of a u16-prefixed string
// for every reference record (~25 bytes saved per record across 14.4M
// records in captain2 — ~360MB shard size cut + ~30% byte-traffic drop in
// `append_lights_to_both_shards`). 255 = "string follows inline" fallback
// for any value outside the closed set (e.g., legacy TSV inputs).
const CONFIDENCE_OTHER: u8 = 255;
const PROVENANCE_OTHER: u8 = 255;

#[inline]
fn compute_confidence_id(s: &str) -> u8 {
    match s {
        "possible" => 0,
        "exact" => 1,
        _ => CONFIDENCE_OTHER,
    }
}

#[inline]
fn confidence_str_from_id(id: u8) -> Option<&'static str> {
    Some(match id {
        0 => "possible",
        1 => "exact",
        _ => return None,
    })
}

#[inline]
fn compute_provenance_id(s: &str) -> u8 {
    match s {
        "import" => 0,
        "import-star" => 1,
        "import-namespace" => 2,
        "imported-type" => 3,
        "receiver-self" => 4,
        "receiver-type" => 5,
        "type-fact" => 6,
        "lexical" => 7,
        "unique-name" => 8,
        "token-shape" => 9,
        "external-tsv" => 10,
        _ => PROVENANCE_OTHER,
    }
}

#[inline]
fn provenance_str_from_id(id: u8) -> Option<&'static str> {
    Some(match id {
        0 => "import",
        1 => "import-star",
        2 => "import-namespace",
        3 => "imported-type",
        4 => "receiver-self",
        5 => "receiver-type",
        6 => "type-fact",
        7 => "lexical",
        8 => "unique-name",
        9 => "token-shape",
        10 => "external-tsv",
        _ => return None,
    })
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GraphSymbol {
    pub id: String,
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub language: String,
    pub uri: String,
    pub rel_path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub body_start_line: u32,
    pub body_start_column: u32,
    pub body_end_line: u32,
    pub body_end_column: u32,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub package_name: Option<String>,
    pub extends_names: Vec<String>,
    pub implements_names: Vec<String>,
    pub usage_count: Option<usize>,
    pub usage_must_count: Option<usize>,
    pub usage_may_count: Option<usize>,
    pub implementation_count: Option<usize>,
    pub implementation_must_count: Option<usize>,
    pub implementation_may_count: Option<usize>,
    #[serde(skip, default)]
    pub kind_flags: u8,
    #[serde(skip, default)]
    pub language_id: u16,
    /// Phase 3 aggressive: stable_symbol_id u64 hash extracted from
    /// `id`. Used as the HashMap key in phase E `counts` so we skip a
    /// per-insert string hash + clone. Falls back to 0 for non-standard ids.
    #[serde(skip, default)]
    pub id_u64: u64,
    /// W2: precomputed FNV-1a hash of rel_path. Phase E hot loop uses
    /// this for file-locality comparisons instead of per-element string
    /// memcmp (which was the dominant phase E CPU cost — see optimization.md).
    #[serde(skip, default)]
    pub rel_path_hash: u64,
    /// W2c: precomputed FNV-1a hash of name. Used by the imported-candidate
    /// `fallback_already_counts_may` check in phase E (was per-import string compare).
    #[serde(skip, default)]
    pub name_hash: u64,
}

#[derive(Clone, Debug)]
pub struct GraphQueryResult {
    pub workspace_root: String,
    pub symbol_id: String,
    pub built_at_unix_ms: u64,
    pub total_references: usize,
    pub references: Vec<GraphReference>,
}

#[derive(Clone, Debug)]
pub struct GraphSymbolQueryResult {
    pub workspace_root: String,
    pub built_at_unix_ms: u64,
    pub total_symbols: usize,
    pub symbols: Vec<GraphSymbol>,
}

#[derive(Clone, Copy, Debug)]
pub struct GraphSymbolQueryOptions {
    pub include_usage_counts: bool,
    pub include_implementation_counts: bool,
}

impl Default for GraphSymbolQueryOptions {
    fn default() -> Self {
        Self {
            include_usage_counts: true,
            include_implementation_counts: true,
        }
    }
}

#[derive(Clone, Debug)]
struct FileGraph {
    file_id: String,
    content_hash: u64,
    language: String,
    symbol_defs: Vec<SymbolDef>,
    import_facts: Vec<ImportFact>,
    type_facts: Vec<TypeFact>,
    function_return_facts: Vec<FunctionReturnFact>,
    hierarchy_facts: Vec<HierarchyFact>,
    symbols: Vec<GraphSymbol>,
    ref_sites: Vec<RefSite>,
}

#[derive(Clone, Debug)]
struct SymbolDef {
    name: String,
    qualified_name: String,
    kind: String,
    language: String,
    uri: String,
    rel_path: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    container_name: Option<String>,
    package_name: Option<String>,
    extends_names: Vec<String>,
    implements_names: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct HierarchyFact {
    child_qualified_name: String,
    parent_name: String,
    relation: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct ImportFact {
    file_id: String,
    rel_path: String,
    local_name: String,
    imported_name: String,
    module_candidates: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct TypeFact {
    rel_path: String,
    local_name: String,
    type_name: String,
    enclosing_symbol_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct FunctionReturnFact {
    rel_path: String,
    function_name: String,
    type_name: String,
}

#[derive(Clone, Copy, Debug)]
struct MemberExactCandidate<'a> {
    target: &'a GraphSymbol,
    provenance: &'static str,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct RefSite {
    // B6 stage-2: the u64 of "ref:HEX16" (= stable_hash(key)); the string was
    // redundant (always standard at parse) — store the u64, reconstruct the
    // string only on the cold materialize path. The on-disk encoding already
    // used this u64, so shard bytes are unchanged.
    source_ref_id: u64,
    name: String,
    // B6 (RefSite slim, peak RSS was 17GB > 16GB cap): `raw_text` was always
    // == `name` (set so in `extract_ref_sites`; the disk format already encodes
    // the common case as a marker byte and never stores a differing string), so
    // the field is dropped and reconstructed as `name` on the cold read/write
    // paths — saving ~24B inline + a per-site `name` clone (~−1.5–2GB).
    // P1 (parse alloc reduction): `rel_path`/`language`/`edge_kind`/`access_kind`
    // are constant within a file (rel_path/language) or drawn from a tiny fixed
    // set (edge_kind/access_kind). The AoS built one fresh `String` per site —
    // ~38M × these fields, the dominant malloc/memmove + 128-thread allocator
    // lock contention in the parse sample. As `Arc<str>` the per-site write is a
    // refcount bump of a per-file/per-value Arc, not an allocation+copy. Readers
    // deref to `&str` unchanged. (`uri` was dead — never read post-parse and the
    // disk format omits it; `parse_ref_site_binary` already rebuilds it empty —
    // so it is dropped from the struct entirely.)
    rel_path: Arc<str>,
    language: Arc<str>,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    edge_kind: Arc<str>,
    access_kind: Arc<str>,
    is_definition: bool,
    is_import_context: bool,
    receiver_name: Option<String>,
    /// B6 stage-3: the u64 of the enclosing scope's "sym:HEX16" symbol id
    /// (`parse_stable_symbol_id_to_u64`; 0 = no enclosing scope). The prior
    /// `Option<String>` was redundant — the enclosing is always a standard
    /// symbol id at parse, so we keep the u64 and rebuild the string only on the
    /// cold materialize/serialize paths (`enclosing_id_to_string`). It also
    /// replaces the old `enclosing_symbol_id_hash` as the receiver-cache key
    /// component — a bijective relabel (both are deterministic fns of the same
    /// string, so distinct enclosings still map to distinct keys). Unlike the
    /// other precomputed hashes this is NOT `#[serde(skip)]`: once the string is
    /// gone it cannot be rederived after a spill round-trip, so it is serialized
    /// directly and the load FIXUP no longer recomputes it.
    enclosing_id: u64,
    /// W2: precomputed FNV-1a hash of rel_path. See GraphSymbol::rel_path_hash.
    #[serde(skip, default)]
    rel_path_hash: u64,
    /// W2c: precomputed FNV-1a hash of name. See GraphSymbol::name_hash.
    #[serde(skip, default)]
    name_hash: u64,
    /// W9a: precomputed FNV-1a hash of receiver_name (0 if None). Used as
    /// receiver_cache key in phase E so the per-site cache probe is a
    /// u64-triple hash + compare instead of 3 string hashes + memcmps.
    #[serde(skip, default)]
    receiver_name_hash: u64,
    /// W12: precomputed access_kind enum id (ACCESS_KIND_BARE / MEMBER /
    /// OTHER). Replaces `access_kind == "member"` / `== "bare"` memcmps in
    /// phase_e_prefilter (31M sites) + phase E loop (16M sites) + phase C
    /// hot paths.
    #[serde(skip, default)]
    access_kind_id: u8,
    /// W12: precomputed edge_kind enum id (EDGE_KIND_USAGE / CALL /
    /// CONSTRUCT / OTHER). Eliminates the `matches!(edge_kind, "call" |
    /// "construct")` memcmps in `append_lights_to_both_shards` (14.4M
    /// records) and the `compute_edge_kind_id` call in
    /// `serialize_ref_site_binary`.
    #[serde(skip, default)]
    edge_kind_id: u8,
}

/// W17 (Option B / SoA, step B1): string interner for symbol & site names.
///
/// Built once after phase A from the symbol-name set, it maps each distinct
/// name to a dense `u32` id so the SoA hot path can probe `(language_id,
/// name_id)`-keyed maps with an integer key instead of a string. `MISS`
/// (`u32::MAX`) is returned for any name that was never interned (e.g. a site
/// `name` that matches no symbol) — such a name can never match a
/// symbol-keyed map anyway, so the miss is behaviourally identical to the
/// current string probe missing.
///
/// Keys are owned `Box<str>` (no borrow of `symbols`) so the interner can
/// outlive the phase-A scratch maps and feed every later phase. `hashes[id]`
/// carries the precomputed `stable_hash(name)`, letting the eventual SoA
/// columns drop the per-site `name_hash`/`receiver_name_hash` re-derivation.
///
/// B6 stage-4: a reverse `names: Vec<Box<str>>` (id -> &str) is added so the
/// cold reconstruction paths (the 14M write `serialize_reference_binary_from_light`,
/// `materialize_light_ref`/`push_resolved_reference`, and the per-file
/// receiver cache-miss) can rebuild the `name`/`receiver_name` strings from a
/// per-site `u32` id once the `Vec<RefSite>` is dropped (stage-5). The reverse
/// entry is a second `Box<str>` (the forward `ids` map keeps its own key for a
/// collision-free string lookup); the duplication is ~27MB over ~0.6–0.9M
/// unique names — negligible next to the ~7.6GB `Vec<RefSite>` this enables
/// dropping.
struct NameInterner {
    ids: AHashMap<Box<str>, u32>,
    hashes: Vec<u64>,
    names: Vec<Box<str>>,
}

impl NameInterner {
    const MISS: u32 = u32::MAX;

    fn with_capacity(cap: usize) -> Self {
        NameInterner {
            ids: AHashMap::with_capacity(cap),
            hashes: Vec::with_capacity(cap),
            names: Vec::with_capacity(cap),
        }
    }

    /// Intern `name` (assigning a fresh id on first sight), returning its id.
    #[inline]
    fn intern(&mut self, name: &str, name_hash: u64) -> u32 {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = self.hashes.len() as u32;
        let boxed: Box<str> = name.into();
        self.names.push(boxed.clone());
        self.ids.insert(boxed, id);
        self.hashes.push(name_hash);
        id
    }

    /// Look up an existing name's id without inserting; `MISS` if absent.
    #[inline]
    fn get(&self, name: &str) -> u32 {
        self.ids.get(name).copied().unwrap_or(Self::MISS)
    }

    /// Reverse lookup: the interned string for `id` (B6 stage-4 cold
    /// reconstruction). `None` for `MISS` / any out-of-range id.
    #[inline]
    fn name(&self, id: u32) -> Option<&str> {
        self.names.get(id as usize).map(|s| &**s)
    }

    fn len(&self) -> usize {
        self.hashes.len()
    }
}

/// W18 (Option B / SoA, step B2): the dense, all-integer column view of a
/// `RefSite` that every hot resolve pass reads. The prior failed SoA attempts
/// kept the string fields in the per-site struct, so the worker still loaded
/// the ~292B `RefSite` cache lines and the cache-miss pattern was unchanged
/// (net-zero). `SiteCols` is 32B with NO strings — a pass that needs only
/// these fields (the phase-E pre-filter, and later the worker fast paths)
/// touches 32B/site instead of ~292B, a ~9x cut in cache traffic.
///
/// Every field is already precomputed on `RefSite` (the W2/W9/W12 hashes +
/// enum ids), so building this column is a pure copy fused into the existing
/// `site_language_ids` pass — no extra 38M scan (the cost that sank the prior
/// attempts; see B1 finding in optimization.md).
#[derive(Clone, Copy, Debug)]
struct SiteCols {
    name_hash: u64,
    rel_path_hash: u64,
    receiver_name_hash: u64,
    /// W18 / Option B step B4 (+ B6 stage-3): the enclosing scope id as a u64
    /// (was the FNV hash of the id string; now `RefSite.enclosing_id`). The
    /// member receiver cache key is `(receiver_name_hash, enclosing_id)`; having
    /// it here lets the worker build that key without reading the `RefSite`.
    enclosing_id: u64,
    /// B4: precomputed `site_partial_hash(source_ref_id, edge_kind)` — the
    /// per-site invariant prefix of every `(site, target)` dedup key. Computed
    /// once in the column build (same hash fn as before, so dedup keys are
    /// byte-identical) instead of re-reading the two `RefSite` strings per
    /// productive site in the hot loop.
    site_partial: u64,
    language_id: u16,
    access_kind_id: u8,
    /// B4: precomputed edge_kind enum id. `add_resolution_count`'s `is_callish`
    /// (`edge_kind == "call" | "construct"`) becomes `id ∈ {CALL, CONSTRUCT}`,
    /// so the worker need not read `RefSite.edge_kind`.
    edge_kind_id: u8,
    flags: u8,
}

const SITE_FLAG_IS_DEFINITION: u8 = 1;
const SITE_FLAG_HAS_RECEIVER: u8 = 1 << 1;
const SITE_FLAG_IS_IMPORT_CONTEXT: u8 = 1 << 2;

/// B6 stage-5a: the per-site columns the 14M-record reference write path reads,
/// so `append_lights_to_both_shards` / `serialize_reference_binary_from_light`
/// no longer dereference the ~200B `RefSite` (nor call `file_table.get_id`) —
/// the toehold for dropping `Vec<RefSite>` before resolve (stage-5d). `name` is
/// rebuilt from `name_id` via the interner (stage-4), `rel_path` is replaced by
/// the precomputed `file_id` (no per-record `FileTable` probe), and `edge_kind`
/// is rebuilt from `edge_kind_id` (always standard for fresh ref_sites:
/// `extract_ref_sites` only emits `call`/`usage`). Built before the writer
/// scope (the writer thread drains it concurrently with resolve), ~48B/site.
#[derive(Clone, Copy, Debug)]
struct RefWriteCol {
    source_ref_id: u64,
    enclosing_id: u64,
    name_id: u32,
    file_id: u32,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    edge_kind_id: u8,
    // B6 stage-5b: the extra columns the OV1 ref_site DISK writer needs (the
    // reference writer ignores them). With these, `serialize_ref_site_binary`
    // reconstructs the full 38M-site disk record from this column +
    // `site_receiver_name_ids` + the interner — no `RefSite`. `language_id`
    // mirrors `SiteCols`/`compute_language_id`; `flags` mirrors `SiteCols`
    // (is_definition / has_receiver / is_import_context).
    language_id: u16,
    access_kind_id: u8,
    flags: u8,
}

/// B6 stage-4/5c: the columns the resolve worker's cold per-file cache-miss
/// needs to rebuild a site's strings without dereferencing `RefSite`, so the
/// `Vec<RefSite>` can be dropped before resolve (stage-5d). `Some` on the
/// full-rebuild paths (the interner/columns are built there); `None` for
/// incremental/legacy/test, which keep reading `RefSite`.
/// - `receiver_name` ← `interner.name(receiver_name_ids[idx])` (stage-4).
/// - `rel_path` ← `file_table.get_path(file_ids[idx])` when `file` is `Some`
///   (stage-5c, channel path); `None` keeps reading `site.rel_path` (the
///   fallback path still has `ref_sites`, so it need not reconstruct).
#[derive(Clone, Copy)]
struct SiteReconCols<'a> {
    interner: &'a NameInterner,
    receiver_name_ids: &'a [u32],
    file: Option<(&'a FileTable, &'a [u32])>,
}

#[derive(Clone, Debug)]
struct GraphStore {
    workspace_root: String,
    built_at_unix_ms: u64,
    symbols: Vec<GraphSymbol>,
    hierarchy_facts: Vec<HierarchyFact>,
    counts: HashMap<String, GraphCount>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct GraphCount {
    usage_likely: usize,
    usage_must: usize,
    usage_may: usize,
    calls_in_likely: usize,
    calls_in_must: usize,
    calls_in_may: usize,
    calls_out_must: usize,
    calls_out_may: usize,
    impl_must: usize,
    impl_may: usize,
}

#[derive(Clone, Debug, Default)]
struct ResolutionResult {
    references: Vec<GraphReference>,
    /// Parallel LightRef view of `references` for the full-rebuild write
    /// path. Used by `stream_lights_to_sidecars` to skip per-record
    /// materialization. Empty for the incremental update path.
    light_references: Vec<LightRef>,
    /// Spilled phase E / F reference batches (consumed once by the streaming
    /// sidecar writer). For the full-resolve rebuild path; incremental does
    /// not spill so this stays empty there.
    reference_partials: Vec<PathBuf>,
    counts: HashMap<String, GraphCount>,
}

// B5: all fields are owned now (the two site maps hold `u32` indices, not
// `&'a RefSite`), so the intermediate no longer borrows `ref_sites` and needs
// no lifetime — the resolve result outlives the input slices freely.
struct ResolveIntermediate {
    references: Vec<GraphReference>,
    /// Compact LightRef accumulator for the full-rebuild write path. Each
    /// LightRef references the owning `ref_sites` slice by index rather
    /// than duplicating site-derived fields. Populated alongside
    /// `references` so we can validate equivalence; the eventual goal is
    /// to drop `references` in the full-rebuild flow entirely.
    light_references: Vec<LightRef>,
    /// Paths to spilled reference batches (bincode-serialized `Vec<GraphReference>`).
    /// Each is consumed once during streaming sidecar write and then removed.
    reference_partials: Vec<PathBuf>,
    counts: HashMap<String, GraphCount>,
    dedup: AHashSet<u64>,
    // W10: keys changed from (&str language, &str scope, &str name) to
    // (u64 lang_hash, u64 scope_hash, u64 name_hash). Built by
    // phase_c_process_chunk with a micro-cache so each site's hashes are
    // computed at most a handful of times across the chunk; previously the
    // dominant phase F leaf-CPU cost was hashing/comparing 3-string tuples in
    // HashMap lookups (75K leaf samples vs ~17K next contender).
    bare_usage_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize>,
    bare_call_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize>,
    member_usage_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize>,
    member_call_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize>,
    // B5 (Option B / SoA, phase C → columns): stores the global `ref_sites`
    // index (u32) of each token-shape-likely site rather than a `&RefSite`
    // pointer. Phase F reads `ref_sites[idx]` for the (rare) push, so the
    // 38M-site phase-C scan that fills these maps never dereferences the 292B
    // struct — it reads the dense 48B `SiteCols` instead. The prior pointer
    // form also forced phase F to recover the index via `offset_from`; the
    // explicit u32 removes that unsafe step.
    bare_likely_sites_by_scope_and_name: HashMap<(u64, u64, u64), Vec<u32>>,
    member_likely_sites_by_scope_and_name: HashMap<(u64, u64, u64), Vec<u32>>,
    // F1.a: per-target tally accumulated during phase E (keyed by GraphSymbol.id_u64).
    // Replaces the rescan loop at apply_token_shape_likely_count_baseline that built
    // reference_counts_by_symbol_id from light_in. Phase F reads this directly.
    light_target_count_by_id_u64: AHashMap<u64, usize>,
}

pub fn graph_index_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_FILE_NAME)
}

pub fn graph_symbol_index_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config
        .index_root(workspace_root)
        .join(GRAPH_SYMBOL_FILE_NAME)
}

fn graph_count_index_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config
        .index_root(workspace_root)
        .join(GRAPH_COUNT_FILE_NAME)
}

fn graph_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
    shard: usize,
) -> PathBuf {
    config
        .index_root(workspace_root)
        .join(format!("{prefix}-{shard:03}.tsv"))
}

fn graph_reference_target_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_id: &str,
) -> PathBuf {
    let shard_key = symbol_id.to_ascii_lowercase();
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
        shard_index_for_key(&shard_key),
    )
}

fn graph_reference_enclosing_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_id: &str,
) -> PathBuf {
    let shard_key = symbol_id.to_ascii_lowercase();
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
        shard_index_for_key(&shard_key),
    )
}

fn graph_symbol_id_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_id: &str,
) -> PathBuf {
    let shard_key = symbol_id.to_ascii_lowercase();
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_SYMBOL_ID_SHARD_PREFIX,
        shard_index_for_key(&shard_key),
    )
}

fn graph_symbol_uri_shard_path(workspace_root: &Path, config: &EngineConfig, uri: &str) -> PathBuf {
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_SYMBOL_URI_SHARD_PREFIX,
        shard_index_for_key(uri),
    )
}

fn graph_count_id_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_id: &str,
) -> PathBuf {
    let shard_key = symbol_id.to_ascii_lowercase();
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_COUNT_ID_SHARD_PREFIX,
        shard_index_for_key(&shard_key),
    )
}

fn graph_hierarchy_parent_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    parent_key: &str,
) -> PathBuf {
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_HIERARCHY_PARENT_SHARD_PREFIX,
        shard_index_for_key(parent_key),
    )
}

fn graph_method_container_shard_path(
    workspace_root: &Path,
    config: &EngineConfig,
    container_key: &str,
) -> PathBuf {
    graph_shard_path(
        workspace_root,
        config,
        GRAPH_METHOD_CONTAINER_SHARD_PREFIX,
        shard_index_for_key(container_key),
    )
}

fn graph_shard_family_available(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
) -> bool {
    graph_shard_path(workspace_root, config, prefix, 0).exists()
}

fn graph_manifest_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_MANIFEST_NAME)
}

fn graph_index_available(workspace_root: &Path, config: &EngineConfig) -> bool {
    graph_manifest_path(workspace_root, config).exists()
        || graph_symbol_index_path(workspace_root, config).exists()
        || graph_shard_family_available(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX)
}

fn read_all_symbols_from_id_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    file_table: &FileTable,
) -> io::Result<Vec<GraphSymbol>> {
    let mut out = Vec::new();
    for shard in 0..GRAPH_SHARD_COUNT {
        let path = graph_shard_path(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX, shard);
        if !path.exists() {
            continue;
        }
        out.extend(read_symbols(&path, file_table)?);
    }
    Ok(out)
}

fn read_ref_sites_excluding_paths(
    workspace_root: &Path,
    config: &EngineConfig,
    exclude_paths: &HashSet<String>,
    file_table: &FileTable,
) -> io::Result<Vec<RefSite>> {
    let worker_count = graph_worker_count(GRAPH_SHARD_COUNT);
    let shards_per_worker = GRAPH_SHARD_COUNT.div_ceil(worker_count);
    let exclude_ref = exclude_paths;
    let file_table_ref = file_table;
    let chunks: Vec<Vec<RefSite>> = std::thread::scope(|s| -> io::Result<Vec<Vec<RefSite>>> {
        let mut handles = Vec::with_capacity(worker_count);
        for w in 0..worker_count {
            let start = w * shards_per_worker;
            let end = ((w + 1) * shards_per_worker).min(GRAPH_SHARD_COUNT);
            if start >= end {
                continue;
            }
            handles.push(s.spawn(move || -> io::Result<(Vec<RefSite>, u128, u128)> {
                let mut local = Vec::new();
                let mut read_us: u128 = 0;
                let mut parse_us: u128 = 0;
                for shard in start..end {
                    let path = graph_shard_path(
                        workspace_root,
                        config,
                        GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX,
                        shard,
                    );
                    if !path.exists() {
                        continue;
                    }
                    let t1 = std::time::Instant::now();
                    let bytes = fs::read(&path)?;
                    read_us += t1.elapsed().as_micros();
                    let t2 = std::time::Instant::now();
                    let mut cursor = 0;
                    while cursor < bytes.len() {
                        let site = parse_ref_site_binary(&bytes, &mut cursor, file_table_ref)?;
                        if !exclude_ref.contains(&*site.rel_path) {
                            local.push(site);
                        }
                    }
                    parse_us += t2.elapsed().as_micros();
                }
                Ok((local, read_us, parse_us))
            }));
        }
        let mut combined = Vec::new();
        let mut total_read: u128 = 0;
        let mut max_parse: u128 = 0;
        for h in handles {
            let (chunk, r, p) = h.join().expect("ref_sites read worker panicked")?;
            total_read += r;
            max_parse = max_parse.max(p);
            combined.push(chunk);
        }
        if std::env::var("ZOEK_READ_PROBE").is_ok() {
            eprintln!("[read-probe] ref_sites total_read_us={} max_worker_parse_us={}", total_read, max_parse);
        }
        Ok(combined)
    })?;
    let mut out = Vec::new();
    for chunk in chunks {
        out.extend(chunk);
    }
    Ok(out)
}

fn read_facts_excluding_paths(
    workspace_root: &Path,
    config: &EngineConfig,
    exclude_paths: &HashSet<String>,
    file_table: &FileTable,
) -> io::Result<(
    Vec<ImportFact>,
    Vec<TypeFact>,
    Vec<FunctionReturnFact>,
)> {
    let worker_count = graph_worker_count(GRAPH_SHARD_COUNT);
    let shards_per_worker = GRAPH_SHARD_COUNT.div_ceil(worker_count);
    let exclude_ref = exclude_paths;
    let file_table_ref = file_table;
    let chunks: Vec<(Vec<ImportFact>, Vec<TypeFact>, Vec<FunctionReturnFact>)> =
        std::thread::scope(|s| -> io::Result<_> {
            let mut handles = Vec::with_capacity(worker_count);
            for w in 0..worker_count {
                let start = w * shards_per_worker;
                let end = ((w + 1) * shards_per_worker).min(GRAPH_SHARD_COUNT);
                if start >= end {
                    continue;
                }
                handles.push(s.spawn(move || -> io::Result<(Vec<ImportFact>, Vec<TypeFact>, Vec<FunctionReturnFact>)> {
                    let mut imports = Vec::new();
                    let mut types = Vec::new();
                    let mut returns = Vec::new();
                    for shard in start..end {
                        let path = graph_shard_path(
                            workspace_root,
                            config,
                            GRAPH_FACTS_BY_FILE_SHARD_PREFIX,
                            shard,
                        );
                        if !path.exists() {
                            continue;
                        }
                        let bytes = fs::read(&path)?;
                        let mut cursor = 0;
                        while cursor < bytes.len() {
                            let tag = bytes[cursor];
                            cursor += 1;
                            match tag {
                                b'I' => {
                                    let fact = parse_import_fact_binary(
                                        &bytes,
                                        &mut cursor,
                                        file_table_ref,
                                    )?;
                                    if !exclude_ref.contains(&fact.rel_path) {
                                        imports.push(fact);
                                    }
                                }
                                b'T' => {
                                    let fact = parse_type_fact_binary(
                                        &bytes,
                                        &mut cursor,
                                        file_table_ref,
                                    )?;
                                    if !exclude_ref.contains(&fact.rel_path) {
                                        types.push(fact);
                                    }
                                }
                                b'F' => {
                                    let fact = parse_function_return_fact_binary(
                                        &bytes,
                                        &mut cursor,
                                        file_table_ref,
                                    )?;
                                    if !exclude_ref.contains(&fact.rel_path) {
                                        returns.push(fact);
                                    }
                                }
                                _ => {
                                    return Err(invalid_data(format!(
                                        "unknown fact tag {tag}"
                                    )))
                                }
                            }
                        }
                    }
                    Ok((imports, types, returns))
                }));
            }
            let mut combined = Vec::new();
            for h in handles {
                combined.push(h.join().expect("facts read worker panicked")?);
            }
            Ok(combined)
        })?;
    let mut imports = Vec::new();
    let mut types = Vec::new();
    let mut returns = Vec::new();
    for (i, t, r) in chunks {
        imports.extend(i);
        types.extend(t);
        returns.extend(r);
    }
    Ok((imports, types, returns))
}

fn read_references_excluding_paths(
    file_table: &FileTable,
    workspace_root: &Path,
    config: &EngineConfig,
    exclude_paths: &HashSet<String>,
) -> io::Result<Vec<GraphReference>> {
    let worker_count = graph_worker_count(GRAPH_SHARD_COUNT);
    let shards_per_worker = GRAPH_SHARD_COUNT.div_ceil(worker_count);
    let exclude_ref = exclude_paths;
    let chunks: Vec<Vec<GraphReference>> = std::thread::scope(|s| -> io::Result<Vec<Vec<GraphReference>>> {
        let mut handles = Vec::with_capacity(worker_count);
        for w in 0..worker_count {
            let start = w * shards_per_worker;
            let end = ((w + 1) * shards_per_worker).min(GRAPH_SHARD_COUNT);
            if start >= end {
                continue;
            }
            handles.push(s.spawn(move || -> io::Result<Vec<GraphReference>> {
                let mut local = Vec::new();
                for shard in start..end {
                    let path = graph_shard_path(
                        workspace_root,
                        config,
                        GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
                        shard,
                    );
                    if !path.exists() {
                        continue;
                    }
                    local.extend(read_binary_references_matching(&path, file_table, |r| {
                        !exclude_ref.contains(&*r.rel_path)
                    })?);
                }
                Ok(local)
            }));
        }
        let mut combined = Vec::new();
        for h in handles {
            combined.push(h.join().expect("references read worker panicked")?);
        }
        Ok(combined)
    })?;
    let mut out = Vec::new();
    for chunk in chunks {
        out.extend(chunk);
    }
    Ok(out)
}

fn read_symbols_excluding_paths(
    workspace_root: &Path,
    config: &EngineConfig,
    exclude_paths: &HashSet<String>,
    file_table: &FileTable,
) -> io::Result<Vec<GraphSymbol>> {
    let worker_count = graph_worker_count(GRAPH_SHARD_COUNT);
    let shards_per_worker = GRAPH_SHARD_COUNT.div_ceil(worker_count);
    let exclude_ref = exclude_paths;
    let file_table_ref = file_table;
    let chunks: Vec<Vec<GraphSymbol>> = std::thread::scope(|s| -> io::Result<Vec<Vec<GraphSymbol>>> {
        let mut handles = Vec::with_capacity(worker_count);
        for w in 0..worker_count {
            let start = w * shards_per_worker;
            let end = ((w + 1) * shards_per_worker).min(GRAPH_SHARD_COUNT);
            if start >= end {
                continue;
            }
            handles.push(s.spawn(move || -> io::Result<Vec<GraphSymbol>> {
                let mut local = Vec::new();
                for shard in start..end {
                    let path = graph_shard_path(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX, shard);
                    if !path.exists() {
                        continue;
                    }
                    local.extend(read_symbols_matching(&path, file_table_ref, |s| {
                        !exclude_ref.contains(&s.rel_path)
                    })?);
                }
                Ok(local)
            }));
        }
        let mut combined = Vec::new();
        for h in handles {
            combined.push(h.join().expect("symbols read worker panicked")?);
        }
        Ok(combined)
    })?;
    let mut out = Vec::new();
    for chunk in chunks {
        out.extend(chunk);
    }
    Ok(out)
}

fn read_all_counts_from_id_shards(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<HashMap<String, GraphCount>> {
    let mut out = HashMap::new();
    for shard in 0..GRAPH_SHARD_COUNT {
        let path = graph_shard_path(workspace_root, config, GRAPH_COUNT_ID_SHARD_PREFIX, shard);
        if !path.exists() {
            continue;
        }
        for (k, v) in read_counts(&path)? {
            out.insert(k, v);
        }
    }
    Ok(out)
}

pub fn index_graph_from_tsv(
    workspace_root: &Path,
    input_path: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
) -> io::Result<GraphIndexSummary> {
    let mut references = Vec::new();
    let input = fs::File::open(input_path)?;
    let reader = BufReader::new(input);
    for line in reader.lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if !(fields.len() == 11 || fields.len() == 12) || fields[0] != "U" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid graph TSV row with {} fields", fields.len()),
            ));
        }
        let symbol_id = decode_field(fields[1])?;
        let name = decode_field(fields[2])?;
        let rel_path = decode_field(fields[5])?;
        let start_line = parse_u32(fields[6], "startLine")?;
        let start_column = parse_u32(fields[7], "startColumn")?;
        references.push(GraphReference {
            source_ref_id: stable_ref_id(&rel_path, start_line, start_column, &name).into(),
            target_symbol_id: Some(symbol_id.into()),
            edge_kind: fields
                .get(11)
                .map(|value| decode_field(value))
                .transpose()?
                .filter(|value| !value.is_empty())
                .map(Into::into)
                .unwrap_or_else(|| "usage".into()),
            name: name.into(),
            raw_text: decode_field(fields[3])?.into(),
            uri: decode_field(fields[4])?.into(),
            rel_path: rel_path.into(),
            start_line,
            start_column,
            end_line: parse_u32(fields[8], "endLine")?,
            end_column: parse_u32(fields[9], "endColumn")?,
            enclosing_symbol_id: optional_decoded_field(fields[10])?.map(Into::into),
            bound_mask: BOUND_MAY,
            confidence: "possible".into(),
            provenance: "external-tsv".into(),
        });
    }

    let counts = compute_counts(&[], &references, &[]);
    write_store(
        workspace_root,
        built_at_unix_ms,
        config,
        0,
        &[],
        &references,
        &[],
        &[],
        &[],
        &[],
        &counts,
        None,
        false,
        None,
        None,
        false,
    )
}

struct GraphSourceCandidate {
    rel_path: String,
    abs_path: PathBuf,
    size_bytes: u64,
    modified_unix_secs: u64,
}

fn discover_graph_source_files_with_progress<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    progress: &mut F,
) -> io::Result<Vec<GraphSourceCandidate>>
where
    F: FnMut(GraphRebuildProgress),
{
    // Skip pre-count: sequential recursive walk of 100K+ files takes seconds.
    // Progress shows running totals during the actual parallel walk instead.
    let total = 0usize;
    let mut top_level_dirs: Vec<PathBuf> = Vec::new();
    let mut candidates: Vec<GraphSourceCandidate> = Vec::new();
    for item in fs::read_dir(workspace_root)? {
        let item = item?;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if path == config.index_root(workspace_root)
                || config.is_extension_state_dir_name(&name)
                || config.is_excluded_dir_name(&name)
            {
                continue;
            }
            top_level_dirs.push(path);
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let rel_path = normalize_graph_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        if config.is_excluded_normalized_relative_path(&rel_path)
            || !is_graph_source_path(&rel_path)
        {
            continue;
        }
        if metadata.len() > config.max_file_size_bytes || config.is_binary_extension(&path) {
            continue;
        }
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        candidates.push(GraphSourceCandidate {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs,
        });
    }
    if !top_level_dirs.is_empty() {
        let dir_results: Vec<Vec<GraphSourceCandidate>> =
            std::thread::scope(|s| -> io::Result<Vec<Vec<GraphSourceCandidate>>> {
                let mut handles = Vec::with_capacity(top_level_dirs.len());
                for dir in &top_level_dirs {
                    let dir_ref = dir.as_path();
                    handles.push(s.spawn(move || -> io::Result<Vec<GraphSourceCandidate>> {
                        let mut local_candidates: Vec<GraphSourceCandidate> = Vec::new();
                        let mut local_visited = 0usize;
                        let mut noop = |_: GraphRebuildProgress| {};
                        walk_graph_source_dir(
                            dir_ref,
                            workspace_root,
                            config,
                            0,
                            &mut local_visited,
                            &mut local_candidates,
                            &mut noop,
                        )?;
                        Ok(local_candidates)
                    }));
                }
                let mut combined = Vec::with_capacity(top_level_dirs.len());
                for h in handles {
                    combined.push(h.join().expect("discover walk worker panicked")?);
                }
                Ok(combined)
            })?;
        for r in dir_results {
            candidates.extend(r);
        }
    }
    progress(GraphRebuildProgress {
        stage: "discovering",
        current: candidates.len(),
        total,
        message: "discovered graph source files".to_string(),
    });
    candidates.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(candidates)
}

fn read_graph_source_candidate(
    cand: &GraphSourceCandidate,
    config: &EngineConfig,
) -> io::Result<Option<CorpusEntry>> {
    let bytes = match read_file_bytes_with_limit_if_not_binary(
        &cand.abs_path,
        config.max_file_size_bytes,
        Some(cand.size_bytes),
    )? {
        ReadTextBytesOutcome::Text(bytes) => bytes,
        ReadTextBytesOutcome::Binary | ReadTextBytesOutcome::TooLarge => return Ok(None),
    };
    let (text, encoding) = decode_bytes(&bytes);
    Ok(Some(CorpusEntry {
        rel_path: cand.rel_path.clone(),
        abs_path: cand.abs_path.clone(),
        text,
        size_bytes: cand.size_bytes,
        modified_unix_secs: cand.modified_unix_secs,
        encoding,
    }))
}

fn walk_graph_source_dir<F>(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
    total: usize,
    visited: &mut usize,
    candidates: &mut Vec<GraphSourceCandidate>,
    progress: &mut F,
) -> io::Result<()>
where
    F: FnMut(GraphRebuildProgress),
{
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if path == config.index_root(workspace_root)
                || config.is_extension_state_dir_name(&name)
                || config.is_excluded_dir_name(&name)
            {
                continue;
            }
            walk_graph_source_dir(
                &path,
                workspace_root,
                config,
                total,
                visited,
                candidates,
                progress,
            )?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        let rel_path = normalize_graph_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        if config.is_excluded_normalized_relative_path(&rel_path)
            || !is_graph_source_path(&rel_path)
        {
            continue;
        }

        *visited += 1;
        if *visited == 1 || *visited % 128 == 0 || *visited == total {
            progress(GraphRebuildProgress {
                stage: "discovering",
                current: *visited,
                total,
                message: "discovering graph source files".to_string(),
            });
        }

        if metadata.len() > config.max_file_size_bytes || config.is_binary_extension(&path) {
            continue;
        }

        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        candidates.push(GraphSourceCandidate {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs,
        });
    }
    Ok(())
}

fn count_graph_source_candidates(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<usize> {
    let mut total = 0usize;
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if path == config.index_root(workspace_root)
                || config.is_extension_state_dir_name(&name)
                || config.is_excluded_dir_name(&name)
            {
                continue;
            }
            total += count_graph_source_candidates(&path, workspace_root, config)?;
            continue;
        }
        if metadata.is_file() {
            let rel_path =
                normalize_graph_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
            if !config.is_excluded_normalized_relative_path(&rel_path)
                && is_graph_source_path(&rel_path)
            {
                total += 1;
            }
        }
    }
    Ok(total)
}

pub fn rebuild_graph_native<F>(
    workspace_root: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    _worker_count: usize,
    progress: &mut F,
) -> io::Result<GraphIndexSummary>
where
    F: FnMut(GraphRebuildProgress),
{
    apply_memory_cap();
    apply_rayon_pool_size();
    let _graph_lock = acquire_graph_lock(workspace_root)?;
    let started = std::time::Instant::now();
    progress(GraphRebuildProgress {
        stage: "discovering",
        current: 0,
        total: 0,
        message: "discovering source files".to_string(),
    });
    let candidates =
        discover_graph_source_files_with_progress(workspace_root, config, progress)?;
    let discover_ms = started.elapsed().as_millis();

    let parsing_started = std::time::Instant::now();
    let total_entries = candidates.len();
    // ZOEK_PARSE_WORKERS lets memory-constrained environments cap parallelism
    // (each worker holds a ParseAccum with symbol/ref_site/fact Vecs, so peak
    // memory scales linearly with worker count). Default = CPU parallelism.
    let worker_count = graph_worker_count(total_entries);
    progress(GraphRebuildProgress {
        stage: "parsing",
        current: 0,
        total: total_entries,
        message: format!(
            "extracting file graphs with {worker_count} workers (discover {discover_ms}ms)"
        ),
    });
    #[derive(serde::Serialize, serde::Deserialize)]
    struct ParseAccum {
        symbols: Vec<GraphSymbol>,
        ref_sites: Vec<RefSite>,
        import_facts: Vec<ImportFact>,
        type_facts: Vec<TypeFact>,
        function_return_facts: Vec<FunctionReturnFact>,
        hierarchy_facts: Vec<HierarchyFact>,
        fact_generation_hash: u64,
        symbol_def_count: usize,
    }
    impl ParseAccum {
        fn new() -> Self {
            Self {
                symbols: Vec::new(),
                ref_sites: Vec::new(),
                import_facts: Vec::new(),
                type_facts: Vec::new(),
                function_return_facts: Vec::new(),
                hierarchy_facts: Vec::new(),
                fact_generation_hash: 0,
                symbol_def_count: 0,
            }
        }
        fn ingest(&mut self, graph: FileGraph) {
            self.fact_generation_hash ^= graph.content_hash;
            self.fact_generation_hash ^= stable_hash(&graph.file_id);
            self.fact_generation_hash ^= stable_hash(&graph.language);
            self.symbol_def_count += graph.symbol_defs.len();
            self.symbols.extend(graph.symbols);
            self.ref_sites.extend(graph.ref_sites);
            self.import_facts.extend(graph.import_facts);
            self.type_facts.extend(graph.type_facts);
            self.function_return_facts.extend(graph.function_return_facts);
            self.hierarchy_facts.extend(graph.hierarchy_facts);
        }
        fn merge(&mut self, other: ParseAccum) {
            self.fact_generation_hash ^= other.fact_generation_hash;
            self.symbol_def_count += other.symbol_def_count;
            self.symbols.extend(other.symbols);
            self.ref_sites.extend(other.ref_sites);
            self.import_facts.extend(other.import_facts);
            self.type_facts.extend(other.type_facts);
            self.function_return_facts.extend(other.function_return_facts);
            self.hierarchy_facts.extend(other.hierarchy_facts);
        }
        /// Rough peak memory footprint of buffered data, used to trigger
        /// streaming flushes before workers blow the process memory cap.
        /// Per-element constants are empirical averages for the heavyweight
        /// String-bearing structs (GraphSymbol, RefSite, fact records).
        fn estimated_bytes(&self) -> usize {
            self.symbols.len() * 500
                + self.ref_sites.len() * 220
                + self.import_facts.len() * 160
                + self.type_facts.len() * 140
                + self.function_return_facts.len() * 100
                + self.hierarchy_facts.len() * 120
        }
        fn is_empty(&self) -> bool {
            self.symbols.is_empty()
                && self.ref_sites.is_empty()
                && self.import_facts.is_empty()
                && self.type_facts.is_empty()
                && self.function_return_facts.is_empty()
                && self.hierarchy_facts.is_empty()
        }
        /// Stream this buffer out to disk via bincode and return the path.
        /// The buffer becomes empty afterwards so the worker can keep ingesting.
        fn spill_to_file(&mut self, path: &Path) -> io::Result<()> {
            let f = std::fs::File::create(path)?;
            let mut w = std::io::BufWriter::with_capacity(1024 * 1024, f);
            bincode::serialize_into(&mut w, &*self).map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("spill: {e}"))
            })?;
            w.flush()?;
            self.symbols.clear();
            self.ref_sites.clear();
            self.import_facts.clear();
            self.type_facts.clear();
            self.function_return_facts.clear();
            self.hierarchy_facts.clear();
            Ok(())
        }
        fn load_from_file(path: &Path) -> io::Result<Self> {
            let f = std::fs::File::open(path)?;
            let r = std::io::BufReader::with_capacity(1024 * 1024, f);
            let mut accum: ParseAccum = bincode::deserialize_from(r).map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("load: {e}"))
            })?;
            // W2/W9a: hash fields are #[serde(skip)], so re-populate after deserialize.
            for sym in &mut accum.symbols {
                sym.rel_path_hash = stable_hash(&sym.rel_path);
                sym.name_hash = stable_hash(&sym.name);
            }
            for site in &mut accum.ref_sites {
                site.rel_path_hash = stable_hash(&site.rel_path);
                site.name_hash = stable_hash(&site.name);
                site.receiver_name_hash = site
                    .receiver_name
                    .as_deref()
                    .map(stable_hash)
                    .unwrap_or(0);
                // B6 stage-3: enclosing_id is now a serialized (non-skip) field,
                // so it survives the spill round-trip and needs no recompute here
                // (the source string was dropped).
                site.access_kind_id = compute_access_kind_id(&site.access_kind);
                site.edge_kind_id = compute_edge_kind_id(&site.edge_kind);
            }
            Ok(accum)
        }
    }
    let mut accum = if total_entries == 0 || worker_count <= 1 {
        let mut a = ParseAccum::new();
        for cand in &candidates {
            if let Some(entry) = read_graph_source_candidate(cand, config)? {
                a.ingest(build_file_graph(&entry));
            }
        }
        a
    } else {
        // Parse with rayon work-stealing — splits into ~8× more chunks than
        // workers so faster cores can grab additional candidate ranges as
        // slower ones finish (large generated files etc.). Each chunk runs
        // its own ParseAccum + spill logic exactly as before.
        use rayon::prelude::*;
        let candidates_ref: &[GraphSourceCandidate] = &candidates;
        let memory_limit = worker_memory_limit();
        let spill_threshold = std::env::var("ZOEK_PARSE_SPILL_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(512 * 1024 * 1024);
        let spill_dir = workspace_root.join(".zoek-rs").join("graph-spill");
        let _ = fs::create_dir_all(&spill_dir);
        let spill_dir_for_workers = spill_dir.clone();
        let chunks_per_worker = 8usize;
        let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
        let chunk_size = total_entries.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize, usize)> = (0..)
            .map(|i| (i, i * chunk_size, ((i + 1) * chunk_size).min(total_entries)))
            .take_while(|(_, s, _)| *s < total_entries)
            .collect();
        let worker_accums: io::Result<Vec<(ParseAccum, Vec<PathBuf>)>> = ranges
            .into_par_iter()
            .map(|(w, start, end)| -> io::Result<(ParseAccum, Vec<PathBuf>)> {
                let mut a = ParseAccum::new();
                let mut partial_paths: Vec<PathBuf> = Vec::new();
                let probe = std::env::var("ZOEK_MEM_PROBE").is_ok();
                let mut check_counter = 0usize;
                let mut partial_idx = 0usize;
                for cand in &candidates_ref[start..end] {
                    if let Some(entry) = read_graph_source_candidate(cand, config)? {
                        a.ingest(build_file_graph(&entry));
                    }
                    check_counter += 1;
                    if check_counter % 100 == 0 {
                        let used = a.estimated_bytes();
                        if memory_limit > 0 && used > memory_limit {
                            eprintln!(
                                "[fatal] chunk {} exceeded ZOEK_WORKER_MEMORY_LIMIT_BYTES ({} > {}); aborting to protect host",
                                w, used, memory_limit
                            );
                            std::process::abort();
                        }
                        if used > spill_threshold {
                            let path = spill_dir_for_workers
                                .join(format!("chunk_{w}_partial_{partial_idx}.bin"));
                            a.spill_to_file(&path)?;
                            if probe {
                                eprintln!(
                                    "[mem-probe] chunk {} spilled partial_{} bytes={}",
                                    w, partial_idx, used
                                );
                            }
                            partial_paths.push(path);
                            partial_idx += 1;
                        } else if probe {
                            eprintln!(
                                "[mem-probe] chunk {} symbols={} ref_sites={} est_bytes={}",
                                w, a.symbols.len(), a.ref_sites.len(), used
                            );
                        }
                    }
                }
                Ok((a, partial_paths))
            })
            .collect();
        let skip_resolve_fast_path = std::env::var("ZOEK_SKIP_RESOLVE").is_ok();
        if skip_resolve_fast_path {
            // Streaming fast path: never build a full in-memory total.
            // Each worker's final accum + spilled partials are written
            // straight to sidecar shards as they arrive, then dropped.
            let parsing_ms_fp = parsing_started.elapsed().as_millis();
            progress(GraphRebuildProgress {
                stage: "parsing",
                current: total_entries,
                total: total_entries,
                message: format!("parsed {total_entries} files in {parsing_ms_fp}ms"),
            });
            let indexing_started_fp = std::time::Instant::now();
            progress(GraphRebuildProgress {
                stage: "indexing",
                current: 0,
                total: 0,
                message: "streaming sidecars".to_string(),
            });
            let mut file_table_fp = FileTable::default();
            for cand in &candidates {
                file_table_fp.intern(&cand.rel_path);
            }
            let layout_root = config.index_root(workspace_root);
            fs::create_dir_all(&layout_root)?;
            let arc_file_table = Arc::new(file_table_fp);
            let mut symbol_count_fp: usize = 0;
            let mut ref_site_count_fp: usize = 0;
            // Spawn 6 streamer threads, one per sidecar family.
            // Main thread broadcasts each Arc<ParseAccum> to all 6 channels;
            // each streamer appends to its open shard writers in parallel.
            let (tx_sym_id, rx_sym_id) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let (tx_sym_uri, rx_sym_uri) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let (tx_ref_sites, rx_ref_sites) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let (tx_facts, rx_facts) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let (tx_hierarchy, rx_hierarchy) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let (tx_methods, rx_methods) = crossbeam_channel::unbounded::<Arc<ParseAccum>>();
            let ws = workspace_root;
            let cfg = config;
            let ft1 = arc_file_table.clone();
            let ft2 = arc_file_table.clone();
            let ft3 = arc_file_table.clone();
            let ft4 = arc_file_table.clone();
            let shard_bytes: u64 = std::thread::scope(|scope| -> io::Result<u64> {
                let sym_id_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_SYMBOL_ID_SHARD_PREFIX)?;
                    while let Ok(a) = rx_sym_id.recv() {
                        append_symbols_to_id_shards(&a.symbols, &mut w, &ft1)?;
                    }
                    finish_graph_shard_writers(w)
                });
                let sym_uri_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_SYMBOL_URI_SHARD_PREFIX)?;
                    while let Ok(a) = rx_sym_uri.recv() {
                        append_symbols_to_uri_shards(&a.symbols, &mut w, &ft2)?;
                    }
                    finish_graph_shard_writers(w)
                });
                let ref_sites_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX)?;
                    while let Ok(a) = rx_ref_sites.recv() {
                        append_ref_sites_to_file_shards(&a.ref_sites, &mut w, &ft3)?;
                    }
                    finish_graph_shard_writers(w)
                });
                let facts_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_FACTS_BY_FILE_SHARD_PREFIX)?;
                    while let Ok(a) = rx_facts.recv() {
                        append_facts_to_file_shards(&a.import_facts, &a.type_facts, &a.function_return_facts, &mut w, &ft4)?;
                    }
                    finish_graph_shard_writers(w)
                });
                let hierarchy_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_HIERARCHY_PARENT_SHARD_PREFIX)?;
                    while let Ok(a) = rx_hierarchy.recv() {
                        append_hierarchy_to_parent_shards(&a.symbols, &mut w)?;
                    }
                    finish_graph_shard_writers(w)
                });
                let methods_h = scope.spawn(move || -> io::Result<u64> {
                    let mut w = open_graph_shard_writers(ws, cfg, GRAPH_METHOD_CONTAINER_SHARD_PREFIX)?;
                    while let Ok(a) = rx_methods.recv() {
                        append_methods_to_container_shards(&a.symbols, &mut w)?;
                    }
                    finish_graph_shard_writers(w)
                });
                // Main producer: broadcast each accum to all 6 streamers.
                let broadcast = |arc: &Arc<ParseAccum>| {
                    let _ = tx_sym_id.send(arc.clone());
                    let _ = tx_sym_uri.send(arc.clone());
                    let _ = tx_ref_sites.send(arc.clone());
                    let _ = tx_facts.send(arc.clone());
                    let _ = tx_hierarchy.send(arc.clone());
                    let _ = tx_methods.send(arc.clone());
                };
                for (a, partial_paths) in worker_accums? {
                    symbol_count_fp += a.symbols.len();
                    ref_site_count_fp += a.ref_sites.len();
                    let arc_a = Arc::new(a);
                    broadcast(&arc_a);
                    drop(arc_a);
                    for path in partial_paths {
                        let p = ParseAccum::load_from_file(&path)?;
                        symbol_count_fp += p.symbols.len();
                        ref_site_count_fp += p.ref_sites.len();
                        let arc_p = Arc::new(p);
                        broadcast(&arc_p);
                        drop(arc_p);
                        let _ = fs::remove_file(&path);
                    }
                }
                // Drop senders → streamer recv loops exit, finish, return bytes.
                drop(tx_sym_id);
                drop(tx_sym_uri);
                drop(tx_ref_sites);
                drop(tx_facts);
                drop(tx_hierarchy);
                drop(tx_methods);
                let b1 = sym_id_h.join().expect("sym_id streamer panicked")?;
                let b2 = sym_uri_h.join().expect("sym_uri streamer panicked")?;
                let b3 = ref_sites_h.join().expect("ref_sites streamer panicked")?;
                let b4 = facts_h.join().expect("facts streamer panicked")?;
                let b5 = hierarchy_h.join().expect("hierarchy streamer panicked")?;
                let b6 = methods_h.join().expect("methods streamer panicked")?;
                Ok(b1 + b2 + b3 + b4 + b5 + b6)
            })?;
            let _ = fs::remove_dir_all(workspace_root.join(".zoek-rs").join("graph-spill"));
            let file_table_fp = Arc::try_unwrap(arc_file_table)
                .unwrap_or_else(|arc| (*arc).clone());
            let file_table_bytes = write_file_table_binary(
                &graph_file_table_path(workspace_root, config),
                &file_table_fp,
            )?;
            let total_bytes = shard_bytes + file_table_bytes;
            let unique_paths: std::collections::HashSet<&str> =
                candidates.iter().map(|c| c.rel_path.as_str()).collect();
            let file_count = unique_paths.len();
            let indexed_at_unix_secs = unix_secs_now();
            let manifest = format!(
                "{{\"engine\":\"zoek-rs\",\"type\":\"semantic-serving-graph\",\"version\":{},\"workspaceRoot\":{},\"indexedAtUnixSecs\":{},\"builtAtUnixMs\":{},\"fileCount\":{},\"symbolCount\":{},\"referenceCount\":{},\"bytes\":{}}}",
                GRAPH_VERSION,
                crate::protocol::json_string(&workspace_root.to_string_lossy()),
                indexed_at_unix_secs,
                built_at_unix_ms,
                file_count,
                symbol_count_fp,
                0usize,
                total_bytes
            );
            write_atomically(
                &graph_manifest_path(workspace_root, config),
                manifest.as_bytes(),
            )?;
            let relation_path = layout_root.join(GRAPH_FILE_NAME);
            let indexing_ms_fp = indexing_started_fp.elapsed().as_millis();
            let total_ms_fp = started.elapsed().as_millis();
            progress(GraphRebuildProgress {
                stage: "done",
                current: 0,
                total: 0,
                message: format!(
                    "wrote graph index files={} symbols={} references=0 discover={}ms parse={}ms resolve=0ms index={}ms total={}ms",
                    file_count, symbol_count_fp, discover_ms, parsing_ms_fp, indexing_ms_fp, total_ms_fp
                ),
            });
            let _ = ref_site_count_fp;
            return Ok(GraphIndexSummary {
                workspace_root: workspace_root.to_string_lossy().into_owned(),
                index_path: relation_path.to_string_lossy().into_owned(),
                indexed_at_unix_secs,
                built_at_unix_ms,
                file_count,
                symbol_count: symbol_count_fp,
                reference_count: 0,
                bytes: total_bytes,
            });
        }
        let mut total = ParseAccum::new();
        for (a, partial_paths) in worker_accums? {
            total.merge(a);
            for path in partial_paths {
                let partial = ParseAccum::load_from_file(&path)?;
                total.merge(partial);
                let _ = fs::remove_file(&path);
            }
        }
        // Clean up the spill dir if it still exists (best-effort).
        let _ = fs::remove_dir_all(workspace_root.join(".zoek-rs").join("graph-spill"));
        total
    };
    let parsing_ms = parsing_started.elapsed().as_millis();
    progress(GraphRebuildProgress {
        stage: "parsing",
        current: total_entries,
        total: total_entries,
        message: format!("parsed {total_entries} files in {parsing_ms}ms"),
    });

    let resolving_started = std::time::Instant::now();
    progress(GraphRebuildProgress {
        stage: "resolving",
        current: 0,
        total: candidates.len(),
        message: format!("materializing serving graph (parsing {parsing_ms}ms)"),
    });
    let symbols = std::mem::take(&mut accum.symbols);
    let mut ref_sites = std::mem::take(&mut accum.ref_sites);
    let import_facts = std::mem::take(&mut accum.import_facts);
    let type_facts = std::mem::take(&mut accum.type_facts);
    let function_return_facts = std::mem::take(&mut accum.function_return_facts);
    let hierarchy_facts = std::mem::take(&mut accum.hierarchy_facts);
    let fact_generation_hash = accum.fact_generation_hash;
    let symbol_def_count = accum.symbol_def_count;
    let skip_resolve = std::env::var("ZOEK_SKIP_RESOLVE").is_ok();
    // B6 stage-4/5b: a NameInterner over symbol names + every site name + every
    // receiver name (with a reverse table), so the per-site `name_id` /
    // `receiver_name_id` columns reconstruct the strings byte-exactly once
    // `Vec<RefSite>` is dropped (stage-5d). Symbols are interned first (their
    // ids are what the resolve maps key on); site/receiver names that aren't
    // symbols get fresh ids used only on the cold reconstruction paths.
    // Interning is string-keyed (collision-free) and idempotent, so the later
    // site/receiver passes never change a symbol name's id — the stage-4
    // reference-writer output (emitted name == a symbol name) stays
    // byte-identical. ALL site names must be interned because the OV1 disk
    // writer (`serialize_ref_site_binary`) serializes every one of the 38M
    // sites' names, not just the ~14M emitted ones (a symbol-only interner
    // would MISS the ~6.7% non-symbol site names). Built before resolve (the
    // channel writer + OV1 disk writer drain it concurrently with resolve).
    let mut name_interner = NameInterner::with_capacity(symbols.len() + 1024);
    for symbol in &symbols {
        name_interner.intern(&symbol.name, symbol.name_hash);
    }
    // wall-W1: the sequential intern of all 38M site names + 16M receivers was
    // ~2.4s of resolve-prep. Collect the DISTINCT (name, hash) pairs in parallel
    // (the unique set is ~1M, not 54M), then intern those. The interner ids are
    // internal only — every consumer round-trips through `name(get(s))`, and the
    // hot resolve maps key on `name_hash`, not the id — so the (nondeterministic)
    // distinct-iteration order that assigns site/receiver ids leaves the output
    // byte-identical (symbols are interned first, in order, keeping their ids).
    {
        use rayon::prelude::*;
        let distinct: AHashMap<&str, u64> = ref_sites
            .par_iter()
            .fold(AHashMap::default, |mut acc: AHashMap<&str, u64>, s| {
                acc.entry(s.name.as_str()).or_insert(s.name_hash);
                if let Some(r) = &s.receiver_name {
                    acc.entry(r.as_str()).or_insert(s.receiver_name_hash);
                }
                acc
            })
            .reduce(AHashMap::default, |mut a, mut b| {
                // Same name -> same hash, so extend (overwrite) is harmless;
                // extend the smaller into the larger to minimize rehashing.
                if a.len() < b.len() {
                    std::mem::swap(&mut a, &mut b);
                }
                a.extend(b);
                a
            });
        for (name, hash) in distinct {
            name_interner.intern(name, hash);
        }
    }
    let (site_name_ids, site_receiver_name_ids): (Vec<u32>, Vec<u32>) = {
        use rayon::prelude::*;
        rayon::join(
            || ref_sites.par_iter().map(|s| name_interner.get(&s.name)).collect(),
            || {
                ref_sites
                    .par_iter()
                    .map(|s| {
                        s.receiver_name
                            .as_deref()
                            .map(|r| name_interner.get(r))
                            .unwrap_or(NameInterner::MISS)
                    })
                    .collect()
            },
        )
    };
    // F1.b: channel-driven write pipeline. file_table + shard writers are
    // prepared before resolve so phase E/F workers can stream LightRef batches
    // into a writer thread that overlaps with the resolve phases. Sequential
    // sum was ~phase_e + phase_f + stream_references; the overlap turns it
    // into ~max(phase_e + phase_f, writer drain). Opt out with
    // ZOEK_DISABLE_LIGHT_CHANNEL=1 to fall back to the legacy sequential
    // stream_lights_to_sidecars path.
    let use_channel_pipeline = !skip_resolve
        && std::env::var("ZOEK_DISABLE_LIGHT_CHANNEL").is_err();
    // W23: overlap the 38M-record ref_site shard write with resolve (on a
    // dedicated rayon pool — W1 pattern, separate from the global pool so no
    // nested-spawn starvation). The ref_site write is the dominant index-phase
    // cost (`serialize_ref_site_binary` was the #1 write leaf); writing it while
    // resolve runs hides it behind the resolve phase. `write_store` then skips
    // it (`skip_ref_sites`). Promoted to the default after paired measurement
    // (index 6544→2802ms −57%, total −2.8s, byte-identical 3,788,145,402, no
    // deadlock). `ZOEK_OVERLAP_STATIC_OFF` reverts to writing ref_sites in the
    // index phase. Only active on the channel pipeline (the writer lives in its
    // scope); falls back automatically when the channel is disabled.
    let overlap_static =
        use_channel_pipeline && std::env::var("ZOEK_OVERLAP_STATIC_OFF").is_err();
    // B6 stage-5d: drop `Vec<RefSite>` before resolve only when every reader is
    // columnized — the channel pipeline (5a/5b/5c readers), SoA on (column
    // resolve paths, else the struct paths read ref_sites), and OV1 on (else the
    // index-phase `write_store` writes ref_sites from the AoS). Otherwise keep it.
    let soa_on = std::env::var("ZOEK_SOA_OFF").is_err();
    let drop_ref_sites = overlap_static
        && soa_on
        // Measurement gate (W26 paired): keep `ref_sites` resident (same columns
        // built + same column path) so a drop-ON/OFF pair isolates the freed
        // 7.6GB's effect on peak RSS. Does not change output.
        && std::env::var("ZOEK_B6_KEEP_REFSITES").is_err();
    // B6 stage-5d: the channel rebuild always resolves via the columns when SoA
    // is on (decoupled from `drop_ref_sites` so the KEEP_REFSITES pair still uses
    // the column path). `ZOEK_SOA_OFF` keeps the struct paths (and `ref_sites`).
    let force_columns_channel = soa_on;
    // W23: bytes written by the overlapped ref_site writer (0 unless overlapped).
    // `write_store` skips ref_sites when overlapping, so its reported `bytes`
    // omits them; add this back so the summary total stays accurate.
    let mut overlap_ref_site_bytes: u64 = 0;
    let mut stream_file_table = FileTable::default();
    let mut counts: HashMap<String, GraphCount>;
    let streamed_reference_count: usize;
    let resolving_ms: u128;
    let indexing_started;
    let stream_started = std::time::Instant::now();
    if use_channel_pipeline {
        // Prep: file_table + shard writers. References are reconstructed from
        // ref_sites via LightRef.site_idx so file_table needs only ref_sites +
        // symbols + facts (no resolution.references rel_paths).
        for site in &ref_sites {
            stream_file_table.intern(&site.rel_path);
        }
        for sym in &symbols {
            stream_file_table.intern(&sym.rel_path);
        }
        for fact in &import_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        for fact in &type_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        for fact in &function_return_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        let layout_root_pre = config.index_root(workspace_root);
        fs::create_dir_all(&layout_root_pre)?;
        let file_table_path_pre = graph_file_table_path(workspace_root, config);
        write_file_table_binary(&file_table_path_pre, &stream_file_table)?;
        clear_graph_shard_families(&layout_root_pre)?;
        let mut target_w = open_graph_shard_writers(
            workspace_root,
            config,
            GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
        )?;
        let mut enclosing_w = open_graph_shard_writers(
            workspace_root,
            config,
            GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
        )?;
        // Bounded queue depth tunable via ZOEK_LIGHT_CHANNEL_CAP. Default 1024
        // batches × LIGHT_BATCH_FLUSH_SIZE records × 24B/record ≈ 96MB max
        // in-flight queue. The writer thread is single-threaded so a small
        // queue (e.g. 64) stalls phase F worker threads waiting for the writer
        // to catch up — the slack lets workers finish before the writer drains
        // (turning phase_f wall back down to ~5s instead of ~17s).
        let channel_cap = std::env::var("ZOEK_LIGHT_CHANNEL_CAP")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1024);
        let (tx, rx) = crossbeam_channel::bounded::<Vec<LightRef>>(channel_cap);
        // B6 stage-5a/5c: file_id column + reference write columns (file_table
        // now complete). The writer thread reads only RefWriteCol; the resolve
        // worker rebuilds rel_path from site_file_ids + file_table (no RefSite).
        let site_file_ids = build_site_file_ids(&ref_sites, &stream_file_table);
        let write_cols = build_ref_write_cols(&ref_sites, &site_file_ids, &site_name_ids);
        // B6 stage-5d: build the hot-path SiteCols column here (was inside
        // resolve) so `Vec<RefSite>` can be freed before the resolve phases —
        // every channel-path reader (reference writer 5a, worker/prefilter 5c,
        // OV1 disk writer 5b) now reads columns, not RefSite.
        let site_cols = build_site_cols(&ref_sites);
        if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
            use rayon::prelude::*;
            let unknown = ref_sites
                .par_iter()
                .filter(|s| compute_language_id(&s.language) == LANG_UNKNOWN)
                .count();
            eprintln!("[b6-5b] unknown_language_sites={unknown} / {}", ref_sites.len());
        }
        // B6 stage-5d: free the ~7.6GB `Vec<RefSite>` before resolve. Guarded on
        // `drop_ref_sites` (= channel + SoA-on + OV1-on): the columns above cover
        // every channel-path reader, and `write_store` skips ref_sites under OV1.
        // When off (ZOEK_SOA_OFF / ZOEK_OVERLAP_STATIC_OFF) ref_sites stays so the
        // struct paths / index-phase ref_site write still work.
        if drop_ref_sites {
            ref_sites = Vec::new();
        }
        let symbols_ref = &symbols;
        let ref_sites_ref = &ref_sites;
        let name_interner_ref = &name_interner;
        let write_cols_ref = &write_cols;
        let site_cols_ref = &site_cols;
        let site_receiver_name_ids_ref = &site_receiver_name_ids;
        let site_file_ids_ref = &site_file_ids;
        let import_facts_ref = &import_facts;
        let type_facts_ref = &type_facts;
        let function_return_facts_ref = &function_return_facts;
        let hierarchy_facts_ref = &hierarchy_facts;
        let stream_file_table_ref = &stream_file_table;
        let resolving_started_inner = resolving_started;
        let (resolution_inner, streamed_total, static_bytes) =
            std::thread::scope(|s| -> io::Result<(ResolutionResult, usize, u64)> {
                let target_w_ref = &mut target_w;
                let enclosing_w_ref = &mut enclosing_w;
                let writer_handle = s.spawn(move || -> io::Result<usize> {
                    write_lights_from_channel(
                        rx,
                        write_cols_ref,
                        name_interner_ref,
                        target_w_ref,
                        enclosing_w_ref,
                    )
                });
                // W23: overlap the ref_site shard write with resolve on its own
                // rayon pool (separate from the global pool the phase-E/F workers
                // saturate, so no nested-spawn starvation — W14 lesson). Uses the
                // same `stream_file_table` as the later `write_store`, so the
                // shard bytes are identical; only the timing moves.
                let static_writer_handle = if overlap_static {
                    Some(s.spawn(move || -> io::Result<u64> {
                        let threads = std::env::var("ZOEK_OVERLAP_STATIC_THREADS")
                            .ok()
                            .and_then(|s| s.parse::<usize>().ok())
                            .filter(|n| *n > 0)
                            .unwrap_or(4)
                            .clamp(1, 8);
                        let pool = rayon::ThreadPoolBuilder::new()
                            .num_threads(threads)
                            .thread_name(|i| format!("static-writer-{i}"))
                            .build()
                            .map_err(|e| {
                                io::Error::new(
                                    io::ErrorKind::Other,
                                    format!("static writer pool: {e}"),
                                )
                            })?;
                        pool.install(|| {
                            // B6 stage-5b: OV1 disk writer reads the columns, not
                            // ref_sites — so ref_sites can be dropped before
                            // resolve (stage-5d).
                            write_ref_sites_by_file_shards_cols(
                                workspace_root,
                                config,
                                write_cols_ref,
                                site_receiver_name_ids_ref,
                                name_interner_ref,
                                stream_file_table_ref,
                            )
                        })
                    }))
                } else {
                    None
                };
                let mut resolution = resolve_ref_sites_for_rebuild(
                    symbols_ref,
                    ref_sites_ref,
                    import_facts_ref,
                    type_facts_ref,
                    function_return_facts_ref,
                    hierarchy_facts_ref,
                    // B6 stage-5c: full column reconstruction (receiver + rel_path
                    // via file_id) so the worker reads no RefSite — toward 5d drop.
                    Some(SiteReconCols {
                        interner: name_interner_ref,
                        receiver_name_ids: site_receiver_name_ids_ref,
                        file: Some((stream_file_table_ref, site_file_ids_ref)),
                    }),
                    // B6 stage-5d: SiteCols pre-built above; force columns so the
                    // struct paths (which would index the dropped ref_sites) are
                    // never taken.
                    Some(site_cols_ref),
                    force_columns_channel,
                    Some(&tx),
                );
                // F1.b: phase F's lights were buffered (phase_f wall avoids
                // backpressure). Drop them into the channel as one big batch
                // before closing — the writer drains while we wait on join.
                let phase_f_lights = std::mem::take(&mut resolution.light_references);
                if !phase_f_lights.is_empty() {
                    let _ = tx.send(phase_f_lights);
                }
                drop(tx);
                let total = writer_handle
                    .join()
                    .expect("F1.b writer thread panicked")?;
                // W23: ensure the overlapped ref_site shard write finished before
                // the index phase (write_store with skip_ref_sites) proceeds, and
                // capture its byte count so the summary total stays accurate.
                let static_bytes = if let Some(h) = static_writer_handle {
                    h.join().expect("W23 static writer thread panicked")?
                } else {
                    0u64
                };
                Ok((resolution, total, static_bytes))
            })?;
        overlap_ref_site_bytes = static_bytes;
        let _ = finish_graph_shard_writers(target_w)?;
        let _ = finish_graph_shard_writers(enclosing_w)?;
        resolving_ms = resolving_started_inner.elapsed().as_millis();
        indexing_started = std::time::Instant::now();
        progress(GraphRebuildProgress {
            stage: "indexing",
            current: streamed_total,
            total: streamed_total,
            message: format!(
                "building count sidecar symbol_defs={symbol_def_count} fact_generation={fact_generation_hash:016x} (resolve {resolving_ms}ms)"
            ),
        });
        counts = resolution_inner.counts;
        compute_native_counts(&symbols, &mut counts, &hierarchy_facts);
        streamed_reference_count = streamed_total;
        let stream_ms = stream_started.elapsed().as_millis();
        if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
            eprintln!(
                "[resolve] stream_references={stream_ms}ms refs_emitted={streamed_reference_count} (channel pipeline)"
            );
        }
    } else {
        let mut resolution = if skip_resolve {
            ResolutionResult {
                references: Vec::new(),
                light_references: Vec::new(),
                reference_partials: Vec::new(),
                counts: HashMap::new(),
            }
        } else {
            resolve_ref_sites_for_rebuild(
                &symbols,
                &ref_sites,
                &import_facts,
                &type_facts,
                &function_return_facts,
                &hierarchy_facts,
                // B6 stage-5c: fallback keeps `ref_sites` (not dropped), so the
                // worker reads `site.rel_path` directly — `file: None`. Receiver
                // still reconstructs from the interner (built before the branch).
                Some(SiteReconCols {
                    interner: &name_interner,
                    receiver_name_ids: &site_receiver_name_ids,
                    file: None,
                }),
                None,  // B6 stage-5d: fallback keeps ref_sites → build SiteCols internally
                false, // force_columns: respect ZOEK_SOA_OFF (ref_sites present)
                None,
            )
        };
        resolving_ms = resolving_started.elapsed().as_millis();
        indexing_started = std::time::Instant::now();
        progress(GraphRebuildProgress {
            stage: "indexing",
            current: resolution.references.len(),
            total: resolution.references.len(),
            message: format!(
                "building count sidecar symbol_defs={symbol_def_count} fact_generation={fact_generation_hash:016x} (resolve {resolving_ms}ms)"
            ),
        });
        counts = resolution.counts;
        compute_native_counts(&symbols, &mut counts, &hierarchy_facts);
        for site in &ref_sites {
            stream_file_table.intern(&site.rel_path);
        }
        for r in &resolution.references {
            stream_file_table.intern(&r.rel_path);
        }
        for sym in &symbols {
            stream_file_table.intern(&sym.rel_path);
        }
        for fact in &import_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        for fact in &type_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        for fact in &function_return_facts {
            stream_file_table.intern(&fact.rel_path);
        }
        let layout_root_pre = config.index_root(workspace_root);
        fs::create_dir_all(&layout_root_pre)?;
        let file_table_path_pre = graph_file_table_path(workspace_root, config);
        write_file_table_binary(&file_table_path_pre, &stream_file_table)?;
        clear_graph_shard_families(&layout_root_pre)?;
        let mut reference_partials_for_stream = resolution.reference_partials;
        let use_light_stream = reference_partials_for_stream.is_empty()
            && !resolution.light_references.is_empty();
        let (_streamed_bytes, refs_emitted) = if use_light_stream {
            drop(resolution.references);
            // B6 stage-5a/5c: file_id + reference write columns (file_table complete).
            let site_file_ids = build_site_file_ids(&ref_sites, &stream_file_table);
            let write_cols =
                build_ref_write_cols(&ref_sites, &site_file_ids, &site_name_ids);
            let r = stream_lights_to_sidecars(
                workspace_root,
                config,
                &[],
                &resolution.light_references,
                &write_cols,
                &name_interner,
            )?;
            resolution.light_references = Vec::new();
            r
        } else {
            if !resolution.references.is_empty() {
                let force_spill_dir = std::env::var("ZOEK_RESOLVE_SPILL_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|_| std::env::temp_dir().join("zoek-rs-resolve-spill"));
                let _ = fs::create_dir_all(&force_spill_dir);
                let path = force_spill_dir.join(format!(
                    "phase_f_tail_main_{}.bin",
                    reference_partials_for_stream.len()
                ));
                let f = fs::File::create(&path)?;
                let mut w = std::io::BufWriter::with_capacity(1024 * 1024, f);
                bincode::serialize_into(&mut w, &resolution.references).map_err(|e| {
                    io::Error::new(io::ErrorKind::InvalidData, format!("tail spill: {e}"))
                })?;
                w.flush()?;
                reference_partials_for_stream.push(path);
                resolution.references.clear();
            }
            drop(resolution.light_references);
            let empty_tail: Vec<GraphReference> = Vec::new();
            stream_references_to_sidecars(
                workspace_root,
                config,
                &reference_partials_for_stream,
                &empty_tail,
                &stream_file_table,
            )?
        };
        streamed_reference_count = refs_emitted;
        let stream_ms = stream_started.elapsed().as_millis();
        if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
            eprintln!("[resolve] stream_references={stream_ms}ms refs_emitted={streamed_reference_count}");
        }
    }
    let empty_refs: Vec<GraphReference> = Vec::new();
    let mut summary = write_store(
        workspace_root,
        built_at_unix_ms,
        config,
        candidates.len(),
        &symbols,
        &empty_refs,
        &ref_sites,
        &import_facts,
        &type_facts,
        &function_return_facts,
        &counts,
        None,
        true,
        Some(streamed_reference_count),
        Some(&stream_file_table),
        overlap_static,
    )?;
    // W23: write_store skipped the overlapped ref_site shards; fold their byte
    // count back in so the reported total matches the non-overlapped path.
    summary.bytes += overlap_ref_site_bytes;
    let indexing_ms = indexing_started.elapsed().as_millis();
    let total_ms = started.elapsed().as_millis();
    dump_parse_profile_if_enabled();
    progress(GraphRebuildProgress {
        stage: "done",
        current: streamed_reference_count,
        total: streamed_reference_count,
        message: format!(
            "wrote graph index files={} symbols={} references={} discover={discover_ms}ms parse={parsing_ms}ms resolve={resolving_ms}ms index={indexing_ms}ms total={total_ms}ms",
            summary.file_count, summary.symbol_count, summary.reference_count
        ),
    });
    Ok(summary)
}

pub fn update_graph_native(
    workspace_root: &Path,
    changed_paths: &[PathBuf],
    deleted_paths: &[PathBuf],
    built_at_unix_ms: u64,
    config: &EngineConfig,
    worker_count: usize,
) -> io::Result<GraphIndexSummary> {
    apply_memory_cap();
    let _graph_lock = acquire_graph_lock(workspace_root)?;
    let built_at = if built_at_unix_ms == 0 {
        unix_millis_now()
    } else {
        built_at_unix_ms
    };
    let sidecars_ready = graph_shard_family_available(
        workspace_root,
        config,
        GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX,
    ) && graph_shard_family_available(
        workspace_root,
        config,
        GRAPH_FACTS_BY_FILE_SHARD_PREFIX,
    ) && graph_shard_family_available(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX)
        && graph_shard_family_available(
            workspace_root,
            config,
            GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
        );
    if !sidecars_ready {
        eprintln!(
            "[graph-update] sidecar set incomplete (ref_sites/facts/symbol_id/refs); \
             falling back to full rebuild — this is the memory-intensive path. \
             If this fires on a small change, the prior index is corrupted or was \
             built in skip-resolve mode."
        );
        let mut noop = |_progress: GraphRebuildProgress| {};
        // Release the update lock before the full-rebuild fallback. flock locks are
        // keyed by open file description, not by process, so `rebuild_graph_native`
        // re-acquiring the same lock on a fresh fd while `_graph_lock` is still held
        // makes this process block forever waiting on *itself* (self-deadlock). That
        // leaks an orphaned graph-update process holding graph-rebuild.lock, and every
        // later zoek-rs invocation then blocks on "another zoek-rs is holding … —
        // waiting". Dropping here lets the nested rebuild re-acquire cleanly; the brief
        // unlocked gap is benign (sidecars were already incomplete → a rebuild is
        // needed regardless, and rebuild is idempotent + re-serialized by the lock).
        drop(_graph_lock);
        return rebuild_graph_native(workspace_root, built_at, config, worker_count, &mut noop);
    }
    let exclude_paths: HashSet<String> = changed_paths
        .iter()
        .chain(deleted_paths.iter())
        .filter_map(|path| {
            let stripped = path.strip_prefix(workspace_root).unwrap_or(path);
            Some(normalize_graph_rel_path(stripped))
        })
        .collect();
    let file_table_path_pre = graph_file_table_path(workspace_root, config);
    let prior_file_table_for_symbols = if file_table_path_pre.exists() {
        read_file_table_binary(&file_table_path_pre).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let probe = std::env::var("ZOEK_FLOW_PROBE").is_ok();
    let _t = std::time::Instant::now();
    let mut symbols = read_symbols_excluding_paths(workspace_root, config, &exclude_paths, &prior_file_table_for_symbols)?;
    if probe { eprintln!("[flow] read_symbols={}ms", _t.elapsed().as_millis()); }
    drop(prior_file_table_for_symbols);
    let file_table_path = graph_file_table_path(workspace_root, config);
    let prior_file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let _t = std::time::Instant::now();
    let mut ref_sites =
        read_ref_sites_excluding_paths(workspace_root, config, &exclude_paths, &prior_file_table)?;
    if probe { eprintln!("[flow] read_ref_sites={}ms n={}", _t.elapsed().as_millis(), ref_sites.len()); }
    let _t = std::time::Instant::now();
    let (mut import_facts, mut type_facts, mut function_return_facts) =
        read_facts_excluding_paths(workspace_root, config, &exclude_paths, &prior_file_table)?;
    if probe { eprintln!("[flow] read_facts={}ms", _t.elapsed().as_millis()); }
    for path in changed_paths {
        let abs_path = if path.is_absolute() {
            path.clone()
        } else {
            workspace_root.join(path)
        };
        let Ok(metadata) = fs::metadata(&abs_path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let rel_path = normalize_graph_rel_path(
            abs_path.strip_prefix(workspace_root).unwrap_or(&abs_path),
        );
        if !is_graph_source_path(&rel_path) {
            continue;
        }
        // Reject paths inside extension/tool state dirs (`.lh`, `.codeidx`,
        // `.django-shell`, `.zoek-rs`, …). Without this filter, sibling
        // extensions writing tmp files in those dirs would trigger an
        // incremental update per change — and if the indexer interpreted the
        // tmp file as source, a corrupted sidecar could then trigger a full
        // rebuild on the next call.
        if rel_path
            .split('/')
            .any(|segment| config.is_extension_state_dir_name(segment))
        {
            continue;
        }
        if config.is_excluded_normalized_relative_path(&rel_path) {
            continue;
        }
        if metadata.len() > config.max_file_size_bytes || config.is_binary_extension(&abs_path) {
            continue;
        }
        let bytes = match read_file_bytes_with_limit_if_not_binary(
            &abs_path,
            config.max_file_size_bytes,
            Some(metadata.len()),
        )? {
            ReadTextBytesOutcome::Text(bytes) => bytes,
            _ => continue,
        };
        let (text, encoding) = decode_bytes(&bytes);
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        let entry = CorpusEntry {
            rel_path: rel_path.clone(),
            abs_path,
            text,
            size_bytes: metadata.len(),
            modified_unix_secs,
            encoding,
        };
        let graph = build_file_graph(&entry);
        symbols.extend(graph.symbols);
        ref_sites.extend(graph.ref_sites);
        import_facts.extend(graph.import_facts);
        type_facts.extend(graph.type_facts);
        function_return_facts.extend(graph.function_return_facts);
    }
    let _t = std::time::Instant::now();
    let hierarchy_facts = hierarchy_facts_from_symbols(&symbols);
    let new_symbol_names: HashSet<String> = symbols
        .iter()
        .filter(|s| exclude_paths.contains(&s.rel_path))
        .map(|s| s.name.clone())
        .collect();
    let mut affected_paths: HashSet<String> = exclude_paths.clone();
    for fact in &import_facts {
        if new_symbol_names.contains(&fact.imported_name)
            && !exclude_paths.contains(&fact.rel_path)
        {
            affected_paths.insert(fact.rel_path.clone());
        }
    }
    let affected_indices: Vec<u32> = ref_sites
        .iter()
        .enumerate()
        .filter_map(|(idx, site)| {
            if affected_paths.contains(&*site.rel_path) {
                Some(idx as u32)
            } else {
                None
            }
        })
        .collect();
    if probe { eprintln!("[flow] affected_calc={}ms affected_paths={} affected_indices={}", _t.elapsed().as_millis(), affected_paths.len(), affected_indices.len()); }
    let _t = std::time::Instant::now();
    let mut intermediate = resolve_ref_sites_a_to_e(
        &symbols,
        &ref_sites,
        Some(&affected_indices),
        &import_facts,
        &type_facts,
        &function_return_facts,
        &hierarchy_facts,
        None, // B6 stage-4: incremental path keeps reading RefSite.receiver_name
        None, // prebuilt_site_cols: build internally
        false, // force_columns: respect ZOEK_SOA_OFF
        None,
    );
    if probe { eprintln!("[flow] resolve_a_to_e={}ms", _t.elapsed().as_millis()); }
    let _t = std::time::Instant::now();
    let unchanged_refs =
        read_references_excluding_paths(&prior_file_table, workspace_root, config, &affected_paths)?;
    if probe { eprintln!("[flow] read_unchanged_refs={}ms n={}", _t.elapsed().as_millis(), unchanged_refs.len()); }
    let _t = std::time::Instant::now();
    let mut all_references = unchanged_refs;
    all_references.append(&mut intermediate.references);
    // Drain phase_e spilled batches into all_references BEFORE phase_f so its
    // reference_count tally is accurate (else token-shape over-pads).
    for path in std::mem::take(&mut intermediate.reference_partials) {
        let bytes_or_err = fs::read(&path);
        let _ = fs::remove_file(&path);
        let bytes = bytes_or_err.expect("read spill");
        let batch: Vec<GraphReference> =
            bincode::deserialize(&bytes).expect("deserialize spill");
        all_references.extend(batch);
    }
    // For the incremental update path, just split the existing light_refs
    // (phase E content) and let phase F append to the same vec at the end.
    let light_in = std::mem::take(&mut intermediate.light_references);
    let mut light_out_f: Vec<LightRef> = Vec::new();
    apply_token_shape_likely_count_baseline(
        &symbols,
        &ref_sites,
        &mut intermediate.counts,
        &intermediate.bare_usage_likely_by_scope_and_name,
        &intermediate.bare_call_likely_by_scope_and_name,
        &intermediate.member_usage_likely_by_scope_and_name,
        &intermediate.member_call_likely_by_scope_and_name,
        &intermediate.bare_likely_sites_by_scope_and_name,
        &intermediate.member_likely_sites_by_scope_and_name,
        &mut all_references,
        &intermediate.light_target_count_by_id_u64,
        &mut light_out_f,
        &mut intermediate.dedup,
        &mut intermediate.reference_partials,
        None,
        None, // B6 stage-5d: incremental path keeps ref_sites (no prebuilt SiteCols)
    );
    intermediate.light_references = light_in;
    intermediate.light_references.append(&mut light_out_f);
    if probe { eprintln!("[flow] phase_f={}ms", _t.elapsed().as_millis()); }
    // Drain phase_f spilled batches.
    for path in std::mem::take(&mut intermediate.reference_partials) {
        let bytes_or_err = fs::read(&path);
        let _ = fs::remove_file(&path);
        let bytes = bytes_or_err.expect("read spill");
        let batch: Vec<GraphReference> =
            bincode::deserialize(&bytes).expect("deserialize spill");
        all_references.extend(batch);
    }
    let _t = std::time::Instant::now();
    let mut counts = std::mem::take(&mut intermediate.counts);
    compute_native_counts(&symbols, &mut counts, &hierarchy_facts);
    let mut unique_paths: HashSet<&str> = HashSet::default();
    for symbol in &symbols {
        unique_paths.insert(symbol.rel_path.as_str());
    }
    let file_count = unique_paths.len();
    if probe { eprintln!("[flow] compute_counts={}ms", _t.elapsed().as_millis()); }
    let _t = std::time::Instant::now();
    let result = write_store(
        workspace_root,
        built_at,
        config,
        file_count,
        &symbols,
        &all_references,
        &ref_sites,
        &import_facts,
        &type_facts,
        &function_return_facts,
        &counts,
        Some(&exclude_paths),
        false,
        None,
        None,
        false,
    );
    if probe { eprintln!("[flow] write_store={}ms", _t.elapsed().as_millis()); }
    result
}

pub fn query_graph_symbols(
    workspace_root: &Path,
    query: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    query_graph_symbols_with_options(
        workspace_root,
        query,
        limit,
        config,
        GraphSymbolQueryOptions::default(),
    )
}

pub fn query_graph_symbols_with_options(
    workspace_root: &Path,
    query: &str,
    limit: usize,
    config: &EngineConfig,
    options: GraphSymbolQueryOptions,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    if query.starts_with("sym:") {
        return query_graph_symbol_id_with_options(workspace_root, query, limit, config, options);
    }
    let Some(store) = read_symbol_store(workspace_root, config)? else {
        return Ok(None);
    };
    let query_lower = query.to_ascii_lowercase();
    let mut symbols: Vec<GraphSymbol> = store
        .symbols
        .iter()
        .filter(|symbol| {
            query.is_empty()
                || symbol.id.eq_ignore_ascii_case(query)
                || symbol.name.eq_ignore_ascii_case(query)
                || symbol.qualified_name.eq_ignore_ascii_case(query)
                || symbol.name.to_ascii_lowercase().contains(&query_lower)
                || symbol
                    .qualified_name
                    .to_ascii_lowercase()
                    .contains(&query_lower)
        })
        .cloned()
        .collect();
    for symbol in &mut symbols {
        apply_count_options(symbol, &store.counts, options);
    }
    symbols.sort_by(|left, right| {
        score_symbol_match(left, query)
            .cmp(&score_symbol_match(right, query))
            .reverse()
            .then_with(|| left.qualified_name.cmp(&right.qualified_name))
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });
    let total_symbols = symbols.len();
    symbols.truncate(limit);
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: store.workspace_root,
        built_at_unix_ms: store.built_at_unix_ms,
        total_symbols,
        symbols,
    }))
}

fn query_graph_symbol_id_with_options(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
    options: GraphSymbolQueryOptions,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    if !graph_index_available(workspace_root, config) {
        return Ok(None);
    }
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    let id_shard_path = graph_symbol_id_shard_path(workspace_root, config, symbol_id);
    let read_path = if id_shard_path.exists() {
        id_shard_path.as_path()
    } else {
        symbol_path.as_path()
    };
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let mut symbols = read_symbols_matching(read_path, &file_table, |s| {
        s.id.eq_ignore_ascii_case(symbol_id)
    })?;
    apply_count_options_for_symbols(workspace_root, config, &mut symbols, options)?;
    symbols.sort_by(|left, right| {
        score_symbol_match(left, symbol_id)
            .cmp(&score_symbol_match(right, symbol_id))
            .reverse()
            .then_with(|| left.qualified_name.cmp(&right.qualified_name))
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });
    let total_symbols = symbols.len();
    symbols.truncate(limit);
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        total_symbols,
        symbols,
    }))
}

pub fn query_graph_document_symbols(
    workspace_root: &Path,
    uri: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    query_graph_document_symbols_with_options(
        workspace_root,
        uri,
        start_line,
        end_line,
        limit,
        config,
        GraphSymbolQueryOptions::default(),
    )
}

pub fn query_graph_document_symbols_with_options(
    workspace_root: &Path,
    uri: &str,
    start_line: Option<u32>,
    end_line: Option<u32>,
    limit: usize,
    config: &EngineConfig,
    options: GraphSymbolQueryOptions,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    if !graph_index_available(workspace_root, config) {
        return Ok(None);
    }
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    let start = start_line.unwrap_or(0);
    let end = end_line.unwrap_or(u32::MAX);
    let uri_shard_path = graph_symbol_uri_shard_path(workspace_root, config, uri);
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    // Phase 3 aggressive: sym_uri shards are no longer written by default
    // (they duplicate sym_id data). Prefer that shard when present, then
    // legacy single-file symbol index, finally scan all sym_id shards.
    let mut symbols = if uri_shard_path.exists() {
        read_symbols_matching(uri_shard_path.as_path(), &file_table, |s| {
            s.uri == uri && s.start_line <= end && s.end_line >= start
        })?
    } else if symbol_path.exists() {
        read_symbols_matching(symbol_path.as_path(), &file_table, |s| {
            s.uri == uri && s.start_line <= end && s.end_line >= start
        })?
    } else {
        read_all_symbols_from_id_shards(workspace_root, config, &file_table)?
            .into_iter()
            .filter(|s| s.uri == uri && s.start_line <= end && s.end_line >= start)
            .collect()
    };
    apply_count_options_for_symbols(workspace_root, config, &mut symbols, options)?;
    symbols.sort_by(|left, right| {
        left.start_line
            .cmp(&right.start_line)
            .then_with(|| left.start_column.cmp(&right.start_column))
            .then_with(|| left.qualified_name.cmp(&right.qualified_name))
    });
    let total_symbols = symbols.len();
    symbols.truncate(limit);
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        total_symbols,
        symbols,
    }))
}

fn query_graph_implementations_from_shards(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    if !graph_index_available(workspace_root, config)
        || !graph_shard_family_available(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX)
        || !graph_shard_family_available(
            workspace_root,
            config,
            GRAPH_HIERARCHY_PARENT_SHARD_PREFIX,
        )
    {
        return Ok(None);
    }
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let target_ids: HashSet<String> = [symbol_id.to_string()].into_iter().collect();
    let target_symbols = read_symbols_for_symbol_ids_indexed(workspace_root, config, &target_ids)?;
    let Some(target) = target_symbols
        .into_iter()
        .find(|symbol| symbol.id.eq_ignore_ascii_case(symbol_id))
    else {
        return Ok(Some(GraphSymbolQueryResult {
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            built_at_unix_ms,
            total_symbols: 0,
            symbols: Vec::new(),
        }));
    };

    let mut out = if is_type_kind_sym(&target) {
        let (descendant_ids, _) =
            descendant_type_ids_and_names_indexed(workspace_root, config, &target)?;
        read_symbols_for_symbol_ids_indexed(workspace_root, config, &descendant_ids)?
            .into_iter()
            .filter(|symbol| symbol.id != target.id && is_type_kind_sym(symbol))
            .collect()
    } else if target.kind == "method" {
        let Some(container_id) = target.container_id.as_deref() else {
            return Ok(None);
        };
        if !graph_shard_family_available(
            workspace_root,
            config,
            GRAPH_METHOD_CONTAINER_SHARD_PREFIX,
        ) {
            return Ok(None);
        }
        let container_ids: HashSet<String> = [container_id.to_string()].into_iter().collect();
        let container_symbols =
            read_symbols_for_symbol_ids_indexed(workspace_root, config, &container_ids)?;
        let Some(container) = container_symbols
            .into_iter()
            .find(|symbol| symbol.id == container_id)
        else {
            return Ok(None);
        };
        let (_, descendant_names) =
            descendant_type_ids_and_names_indexed(workspace_root, config, &container)?;
        read_methods_for_container_names_indexed(
            workspace_root,
            config,
            &descendant_names,
            target.name.as_str(),
        )?
        .into_iter()
        .filter(|symbol| symbol.id != target.id)
        .collect()
    } else {
        Vec::new()
    };

    let mut seen = HashSet::new();
    out.retain(|symbol| seen.insert(symbol.id.clone()));
    apply_count_options_for_symbols(
        workspace_root,
        config,
        &mut out,
        GraphSymbolQueryOptions::default(),
    )?;
    out.sort_by(|left, right| {
        left.qualified_name
            .cmp(&right.qualified_name)
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });
    let total_symbols = out.len();
    out.truncate(limit);
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        total_symbols,
        symbols: out,
    }))
}

pub fn query_graph_implementations(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    if let Some(result) =
        query_graph_implementations_from_shards(workspace_root, symbol_id, limit, config)?
    {
        return Ok(Some(result));
    }
    let Some(store) = read_symbol_store(workspace_root, config)? else {
        return Ok(None);
    };
    let Some(target) = store.symbols.iter().find(|symbol| symbol.id == symbol_id) else {
        return Ok(Some(GraphSymbolQueryResult {
            workspace_root: store.workspace_root,
            built_at_unix_ms: store.built_at_unix_ms,
            total_symbols: 0,
            symbols: Vec::new(),
        }));
    };

    let descendants = descendant_type_names(target, &store.symbols, &store.hierarchy_facts);
    let mut out = Vec::new();
    if is_type_kind_sym(target) {
        for symbol in &store.symbols {
            if symbol.id != target.id && descendants.contains(&symbol.qualified_name) {
                out.push(symbol.clone());
            }
        }
    } else if target.kind == "method" {
        for symbol in &store.symbols {
            if symbol.kind == "method"
                && symbol.name == target.name
                && symbol
                    .container_name
                    .as_ref()
                    .is_some_and(|name| descendants.contains(name))
            {
                out.push(symbol.clone());
            }
        }
    }
    for symbol in &mut out {
        apply_count_options(symbol, &store.counts, GraphSymbolQueryOptions::default());
    }
    out.sort_by(|left, right| {
        left.qualified_name
            .cmp(&right.qualified_name)
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });
    let total_symbols = out.len();
    out.truncate(limit);
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: store.workspace_root,
        built_at_unix_ms: store.built_at_unix_ms,
        total_symbols,
        symbols: out,
    }))
}

pub fn query_graph(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphQueryResult>> {
    if !graph_index_available(workspace_root, config) {
        return Ok(None);
    }
    let relation_path = graph_index_path(workspace_root, config);
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let target_shard_path = graph_reference_target_shard_path(workspace_root, config, symbol_id);
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let mut references = if target_shard_path.exists() {
        read_binary_references_matching(&target_shard_path, &file_table, |r| {
            r.target_symbol_id
                .as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case(symbol_id))
        })?
    } else if relation_path.exists() {
        read_references_matching(&relation_path, |fields, offset| {
            Ok(fields[1 + offset].eq_ignore_ascii_case(symbol_id))
        })?
    } else {
        Vec::new()
    };
    references.sort_by(|left, right| {
        left.rel_path
            .cmp(&right.rel_path)
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.start_column.cmp(&right.start_column))
            .then_with(|| left.target_symbol_id.cmp(&right.target_symbol_id))
    });
    let total_references = references.len();
    references.truncate(limit);
    rebuild_reference_uris(workspace_root, &mut references);
    Ok(Some(GraphQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        symbol_id: symbol_id.to_string(),
        built_at_unix_ms,
        total_references,
        references,
    }))
}

pub fn query_graph_callees(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphQueryResult>> {
    if !graph_index_available(workspace_root, config) {
        return Ok(None);
    }
    let relation_path = graph_index_path(workspace_root, config);
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let enclosing_shard_path =
        graph_reference_enclosing_shard_path(workspace_root, config, symbol_id);
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let mut references = if enclosing_shard_path.exists() {
        read_binary_references_matching(&enclosing_shard_path, &file_table, |r| {
            r.enclosing_symbol_id
                .as_deref()
                .is_some_and(|e| e.eq_ignore_ascii_case(symbol_id))
                && matches!(r.edge_kind.as_ref(), "call" | "construct")
        })?
    } else if relation_path.exists() {
        read_references_matching(&relation_path, |fields, offset| {
            Ok(fields[11 + offset].eq_ignore_ascii_case(symbol_id)
                && matches!(fields[2 + offset], "call" | "construct"))
        })?
    } else {
        Vec::new()
    };
    references.sort_by(|left, right| {
        left.rel_path
            .cmp(&right.rel_path)
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.start_column.cmp(&right.start_column))
    });
    let total_references = references.len();
    references.truncate(limit);
    rebuild_reference_uris(workspace_root, &mut references);
    Ok(Some(GraphQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        symbol_id: symbol_id.to_string(),
        built_at_unix_ms,
        total_references,
        references,
    }))
}

// Profiling counters for Phase 1 (multi-month rework). Atomic add per file is
// nano-second cost; main aggregates and prints when ZOEK_PARSE_PROFILE=1.
use std::sync::atomic::{AtomicU64, Ordering};
static PROFILE_NS_SYMBOL_DEFS: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_IMPORT_FACTS: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_HIERARCHY: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_MATERIALIZE: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_ASSIGN_BODIES: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_TYPE_FACTS: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_FUNCTION_RETURNS: AtomicU64 = AtomicU64::new(0);
static PROFILE_NS_REF_SITES: AtomicU64 = AtomicU64::new(0);

fn build_file_graph(entry: &CorpusEntry) -> FileGraph {
    let profile = std::env::var("ZOEK_PARSE_PROFILE").is_ok();
    let language = language_for_path(&entry.rel_path);
    let uri = file_uri(&entry.abs_path);
    let line_count = entry.text.lines().count().max(1) as u32;
    let file_id = stable_file_id(&entry.rel_path);
    let t = std::time::Instant::now();
    let symbol_defs = extract_symbol_defs(entry, &language, &uri, line_count);
    if profile { PROFILE_NS_SYMBOL_DEFS.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let import_facts = extract_import_facts(entry, &language, &file_id);
    if profile { PROFILE_NS_IMPORT_FACTS.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let hierarchy_facts = hierarchy_facts_from_symbol_defs(&symbol_defs);
    if profile { PROFILE_NS_HIERARCHY.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let mut symbols = materialize_symbols(symbol_defs.clone(), line_count);
    if profile { PROFILE_NS_MATERIALIZE.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    assign_symbol_bodies(&mut symbols, line_count);
    if profile { PROFILE_NS_ASSIGN_BODIES.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let type_facts = extract_type_facts(entry, &language, &symbols);
    if profile { PROFILE_NS_TYPE_FACTS.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let function_return_facts = extract_function_return_facts(entry, &language);
    if profile { PROFILE_NS_FUNCTION_RETURNS.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    let t = std::time::Instant::now();
    let ref_sites = extract_ref_sites(entry, &symbols, &language);
    if profile { PROFILE_NS_REF_SITES.fetch_add(t.elapsed().as_nanos() as u64, Ordering::Relaxed); }
    FileGraph {
        file_id,
        content_hash: stable_hash(&entry.text),
        language,
        symbol_defs,
        import_facts,
        type_facts,
        function_return_facts,
        hierarchy_facts,
        symbols,
        ref_sites,
    }
}

fn dump_parse_profile_if_enabled() {
    if std::env::var("ZOEK_PARSE_PROFILE").is_err() {
        return;
    }
    let to_ms = |ns: u64| ns as f64 / 1_000_000.0;
    eprintln!(
        "[parse-profile] symbol_defs={:.1}ms import_facts={:.1}ms hierarchy={:.1}ms materialize={:.1}ms assign_bodies={:.1}ms type_facts={:.1}ms function_returns={:.1}ms ref_sites={:.1}ms",
        to_ms(PROFILE_NS_SYMBOL_DEFS.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_IMPORT_FACTS.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_HIERARCHY.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_MATERIALIZE.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_ASSIGN_BODIES.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_TYPE_FACTS.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_FUNCTION_RETURNS.load(Ordering::Relaxed)),
        to_ms(PROFILE_NS_REF_SITES.load(Ordering::Relaxed)),
    );
}

fn extract_symbol_defs(
    entry: &CorpusEntry,
    language: &str,
    uri: &str,
    line_count: u32,
) -> Vec<SymbolDef> {
    if language == "python" {
        extract_python_symbol_defs(entry, language, uri, line_count)
    } else {
        extract_brace_symbol_defs(entry, language, uri, line_count)
    }
}

fn extract_python_symbol_defs(
    entry: &CorpusEntry,
    language: &str,
    uri: &str,
    line_count: u32,
) -> Vec<SymbolDef> {
    let mut drafts = Vec::new();
    let mut class_stack: Vec<(usize, String)> = Vec::new();
    let mut package_name = python_package_name(&entry.rel_path);
    for (line_idx, line) in entry.text.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line_indent(line);
        while class_stack
            .last()
            .is_some_and(|(class_indent, _)| indent <= *class_indent)
        {
            class_stack.pop();
        }
        if let Some((name, extends)) = python_class_from_line(trimmed) {
            let column = find_column(line, &name);
            let qualified_name =
                qualify_symbol_name(class_stack.last().map(|(_, name)| name), &name);
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualified_name.clone(),
                kind: "class".to_string(),
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name: class_stack.last().map(|(_, value)| value.clone()),
                package_name: package_name.clone(),
                extends_names: extends,
                implements_names: Vec::new(),
            });
            class_stack.push((indent, qualified_name));
            continue;
        }
        if let Some(name) = python_function_from_line(trimmed) {
            let column = find_column(line, &name);
            let container_name = class_stack.last().map(|(_, value)| value.clone());
            let kind = if container_name.is_some() {
                "method"
            } else {
                "function"
            };
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                kind: kind.to_string(),
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name,
                package_name: package_name.clone(),
                extends_names: Vec::new(),
                implements_names: Vec::new(),
            });
            continue;
        }
        if let Some(name) = simple_assignment_name(trimmed) {
            let column = find_column(line, &name);
            let container_name = class_stack.last().map(|(_, value)| value.clone());
            let kind = if container_name.is_some() {
                "field"
            } else if name.chars().any(|ch| ch.is_ascii_lowercase()) {
                "variable"
            } else {
                "constant"
            };
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                kind: kind.to_string(),
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name,
                package_name: package_name.clone(),
                extends_names: Vec::new(),
                implements_names: Vec::new(),
            });
        }
        if package_name.is_none() {
            package_name = python_package_name(&entry.rel_path);
        }
    }
    if drafts.is_empty() && line_count > 0 {
        package_name.take();
    }
    drafts
}

/// Single-pass extractor for Python: produces symbol_defs + import_facts + function_return_facts
/// in one iteration over text.lines(). Replaces three separate scans.
fn extract_python_pass1(
    entry: &CorpusEntry,
    language: &str,
    uri: &str,
    line_count: u32,
    file_id: &str,
) -> (Vec<SymbolDef>, Vec<ImportFact>, Vec<FunctionReturnFact>) {
    let mut drafts: Vec<SymbolDef> = Vec::new();
    let mut import_facts: Vec<ImportFact> = Vec::new();
    let mut return_types: HashMap<String, String> = HashMap::new();
    let mut class_stack: Vec<(usize, String)> = Vec::new();
    let mut package_name = python_package_name(&entry.rel_path);
    let mut pending_signature: Option<(String, i32)> = None;

    for (line_idx, line) in entry.text.lines().enumerate() {
        // (1) Symbol defs: based on trim_start, not sanitized.
        let trimmed = line.trim_start();
        if !(trimmed.is_empty() || trimmed.starts_with('#')) {
            let indent = line_indent(line);
            while class_stack
                .last()
                .is_some_and(|(class_indent, _)| indent <= *class_indent)
            {
                class_stack.pop();
            }
            if let Some((name, extends)) = python_class_from_line(trimmed) {
                let column = find_column(line, &name);
                let qualified_name =
                    qualify_symbol_name(class_stack.last().map(|(_, name)| name), &name);
                drafts.push(SymbolDef {
                    name: name.clone(),
                    qualified_name: qualified_name.clone(),
                    kind: "class".to_string(),
                    language: language.to_string(),
                    uri: uri.to_string(),
                    rel_path: entry.rel_path.clone(),
                    start_line: line_idx as u32,
                    start_column: column,
                    end_line: line_idx as u32,
                    end_column: column + name.len() as u32,
                    container_name: class_stack.last().map(|(_, value)| value.clone()),
                    package_name: package_name.clone(),
                    extends_names: extends,
                    implements_names: Vec::new(),
                });
                class_stack.push((indent, qualified_name));
            } else if let Some(name) = python_function_from_line(trimmed) {
                let column = find_column(line, &name);
                let container_name = class_stack.last().map(|(_, value)| value.clone());
                let kind = if container_name.is_some() {
                    "method"
                } else {
                    "function"
                };
                drafts.push(SymbolDef {
                    name: name.clone(),
                    qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                    kind: kind.to_string(),
                    language: language.to_string(),
                    uri: uri.to_string(),
                    rel_path: entry.rel_path.clone(),
                    start_line: line_idx as u32,
                    start_column: column,
                    end_line: line_idx as u32,
                    end_column: column + name.len() as u32,
                    container_name,
                    package_name: package_name.clone(),
                    extends_names: Vec::new(),
                    implements_names: Vec::new(),
                });
            } else if let Some(name) = simple_assignment_name(trimmed) {
                let column = find_column(line, &name);
                let container_name = class_stack.last().map(|(_, value)| value.clone());
                let kind = if container_name.is_some() {
                    "field"
                } else if name.chars().any(|ch| ch.is_ascii_lowercase()) {
                    "variable"
                } else {
                    "constant"
                };
                drafts.push(SymbolDef {
                    name: name.clone(),
                    qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                    kind: kind.to_string(),
                    language: language.to_string(),
                    uri: uri.to_string(),
                    rel_path: entry.rel_path.clone(),
                    start_line: line_idx as u32,
                    start_column: column,
                    end_line: line_idx as u32,
                    end_column: column + name.len() as u32,
                    container_name,
                    package_name: package_name.clone(),
                    extends_names: Vec::new(),
                    implements_names: Vec::new(),
                });
            }
            if package_name.is_none() {
                package_name = python_package_name(&entry.rel_path);
            }
        }
        // (2) Import facts: requires sanitize_import_line.
        let sanitized_import = sanitize_import_line(line, language);
        let import_trimmed = sanitized_import.trim();
        if !import_trimmed.is_empty() {
            collect_python_import_facts(import_trimmed, entry, file_id, &mut import_facts);
        }
        // (3) Function return types (top-level only): requires sanitize_code_line.
        let sanitized_code = sanitize_code_line(line, language);
        let code_trimmed = sanitized_code.trim_start();
        if !code_trimmed.is_empty() {
            if let Some((buffer, depth)) = pending_signature.as_mut() {
                buffer.push(' ');
                buffer.push_str(code_trimmed);
                *depth += paren_delta(code_trimmed);
                if *depth <= 0 {
                    if let Some((name, type_name)) = python_function_name_and_return_type(buffer) {
                        return_types.insert(name, type_name);
                    }
                    pending_signature = None;
                }
            } else if line_indent(line) == 0 && starts_python_function_signature(code_trimmed) {
                let depth = paren_delta(code_trimmed);
                if depth > 0 {
                    pending_signature = Some((code_trimmed.to_string(), depth));
                } else if let Some((name, type_name)) =
                    python_function_name_and_return_type(code_trimmed)
                {
                    return_types.insert(name, type_name);
                }
            }
        }
    }
    if drafts.is_empty() && line_count > 0 {
        package_name.take();
    }
    let function_return_facts = return_types
        .into_iter()
        .map(|(function_name, type_name)| FunctionReturnFact {
            rel_path: entry.rel_path.clone(),
            function_name,
            type_name,
        })
        .collect();
    (drafts, import_facts, function_return_facts)
}

fn extract_brace_symbol_defs(
    entry: &CorpusEntry,
    language: &str,
    uri: &str,
    _line_count: u32,
) -> Vec<SymbolDef> {
    let mut drafts = Vec::new();
    let mut package_name = None;
    let mut depth = 0i32;
    let mut type_stack: Vec<(i32, String)> = Vec::new();
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized = sanitize_code_line(line, language);
        let trimmed = sanitized.trim_start();
        if trimmed.is_empty() {
            depth += brace_delta(&sanitized);
            continue;
        }
        if package_name.is_none() {
            package_name = package_from_line(trimmed, language);
        }
        while type_stack
            .last()
            .is_some_and(|(type_depth, _)| depth < *type_depth)
        {
            type_stack.pop();
        }
        if let Some((kind, name, extends, implements)) = brace_type_from_line(trimmed) {
            let column = find_column(line, &name);
            let container_name = type_stack.last().map(|(_, value)| value.clone());
            let qualified_name = qualify_symbol_name(container_name.as_ref(), &name);
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualified_name.clone(),
                kind,
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name,
                package_name: package_name.clone(),
                extends_names: extends,
                implements_names: implements,
            });
            type_stack.push((depth + 1, qualified_name));
        } else if let Some(name) = brace_function_from_line(trimmed) {
            let column = find_column(line, &name);
            let container_name = type_stack.last().map(|(_, value)| value.clone());
            let kind = if container_name.is_some() {
                "method"
            } else {
                "function"
            };
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                kind: kind.to_string(),
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name,
                package_name: package_name.clone(),
                extends_names: Vec::new(),
                implements_names: Vec::new(),
            });
        } else if let Some(name) = brace_assignment_name(trimmed) {
            let column = find_column(line, &name);
            let container_name = type_stack.last().map(|(_, value)| value.clone());
            let kind = if container_name.is_some() {
                "field"
            } else if name.chars().any(|ch| ch.is_ascii_lowercase()) {
                "variable"
            } else {
                "constant"
            };
            drafts.push(SymbolDef {
                name: name.clone(),
                qualified_name: qualify_symbol_name(container_name.as_ref(), &name),
                kind: kind.to_string(),
                language: language.to_string(),
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                start_line: line_idx as u32,
                start_column: column,
                end_line: line_idx as u32,
                end_column: column + name.len() as u32,
                container_name,
                package_name: package_name.clone(),
                extends_names: Vec::new(),
                implements_names: Vec::new(),
            });
        }
        depth += brace_delta(&sanitized);
    }
    drafts
}

fn materialize_symbols(symbol_defs: Vec<SymbolDef>, line_count: u32) -> Vec<GraphSymbol> {
    let mut by_qualified_name: HashMap<String, String> = HashMap::new();
    let mut symbols = Vec::with_capacity(symbol_defs.len());
    for draft in symbol_defs {
        let id = stable_symbol_id(
            &draft.language,
            &draft.rel_path,
            &draft.kind,
            &draft.qualified_name,
            draft.start_line,
            draft.start_column,
        );
        by_qualified_name.insert(draft.qualified_name.clone(), id.clone());
        let container_id = draft
            .container_name
            .as_ref()
            .and_then(|name| by_qualified_name.get(name))
            .cloned();
        let kind_flags = compute_kind_flags(&draft.kind);
        let language_id = compute_language_id(&draft.language);
        let id_u64 = parse_stable_symbol_id_to_u64(&id).unwrap_or(0);
        let rel_path_hash = stable_hash(&draft.rel_path);
        let name_hash = stable_hash(&draft.name);
        symbols.push(GraphSymbol {
            id,
            name: draft.name,
            qualified_name: draft.qualified_name,
            kind: draft.kind,
            language: draft.language,
            uri: draft.uri,
            rel_path: draft.rel_path,
            start_line: draft.start_line,
            start_column: draft.start_column,
            end_line: draft.end_line,
            end_column: draft.end_column,
            body_start_line: draft.start_line,
            body_start_column: draft.start_column,
            body_end_line: line_count.saturating_sub(1),
            body_end_column: 0,
            container_id,
            container_name: draft.container_name,
            package_name: draft.package_name,
            extends_names: draft.extends_names,
            implements_names: draft.implements_names,
            usage_count: None,
            usage_must_count: None,
            usage_may_count: None,
            implementation_count: None,
            implementation_must_count: None,
            implementation_may_count: None,
            kind_flags,
            language_id,
            id_u64,
            rel_path_hash,
            name_hash,
        });
    }
    symbols
}

fn assign_symbol_bodies(symbols: &mut [GraphSymbol], line_count: u32) {
    let mut by_file: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (idx, symbol) in symbols.iter().enumerate() {
        by_file
            .entry(symbol.rel_path.clone())
            .or_default()
            .push(idx);
    }
    for indices in by_file.values_mut() {
        indices.sort_by(|left, right| {
            symbols[*left]
                .start_line
                .cmp(&symbols[*right].start_line)
                .then_with(|| {
                    symbols[*left]
                        .start_column
                        .cmp(&symbols[*right].start_column)
                })
        });
        for pos in 0..indices.len() {
            let idx = indices[pos];
            if !is_lexical_scope_symbol(&symbols[idx].kind) {
                symbols[idx].body_end_line = symbols[idx].start_line;
                continue;
            }
            let next_start = indices
                .iter()
                .skip(pos + 1)
                .find(|next| is_lexical_scope_symbol(&symbols[**next].kind))
                .map(|next| symbols[*next].start_line)
                .unwrap_or(line_count);
            symbols[idx].body_end_line = next_start.saturating_sub(1);
        }
    }
}

fn is_lexical_scope_symbol(kind: &str) -> bool {
    matches!(kind, "class" | "function" | "method" | "interface" | "enum")
}

fn hierarchy_facts_from_symbol_defs(symbol_defs: &[SymbolDef]) -> Vec<HierarchyFact> {
    let mut facts = Vec::new();
    for symbol in symbol_defs {
        for parent_name in &symbol.extends_names {
            facts.push(HierarchyFact {
                child_qualified_name: symbol.qualified_name.clone(),
                parent_name: parent_name.clone(),
                relation: "extends".to_string(),
            });
        }
        for parent_name in &symbol.implements_names {
            facts.push(HierarchyFact {
                child_qualified_name: symbol.qualified_name.clone(),
                parent_name: parent_name.clone(),
                relation: "implements".to_string(),
            });
        }
    }
    facts
}

fn hierarchy_facts_from_symbols(symbols: &[GraphSymbol]) -> Vec<HierarchyFact> {
    let mut facts = Vec::new();
    for symbol in symbols {
        for parent_name in &symbol.extends_names {
            facts.push(HierarchyFact {
                child_qualified_name: symbol.qualified_name.clone(),
                parent_name: parent_name.clone(),
                relation: "extends".to_string(),
            });
        }
        for parent_name in &symbol.implements_names {
            facts.push(HierarchyFact {
                child_qualified_name: symbol.qualified_name.clone(),
                parent_name: parent_name.clone(),
                relation: "implements".to_string(),
            });
        }
    }
    facts
}

fn extract_import_facts(entry: &CorpusEntry, language: &str, file_id: &str) -> Vec<ImportFact> {
    let mut facts = Vec::new();
    for line in entry.text.lines() {
        let sanitized = sanitize_import_line(line, language);
        let trimmed = sanitized.trim();
        if trimmed.is_empty() {
            continue;
        }
        if language == "python" {
            collect_python_import_facts(trimmed, entry, file_id, &mut facts);
        } else if matches!(language, "typescript" | "javascript") {
            collect_ts_import_facts(trimmed, entry, file_id, &mut facts);
        } else if matches!(language, "java" | "kotlin") {
            collect_java_import_facts(trimmed, entry, file_id, &mut facts);
        }
    }
    facts
}

fn collect_python_import_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    file_id: &str,
    out: &mut Vec<ImportFact>,
) {
    if let Some(rest) = trimmed.strip_prefix("from ") {
        let Some((module, names)) = rest.split_once(" import ") else {
            return;
        };
        if names.trim() == "*" {
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name: "*".to_string(),
                imported_name: "*".to_string(),
                module_candidates: python_module_candidates(&entry.rel_path, module.trim()),
            });
            return;
        }
        let module_candidates = python_module_candidates(&entry.rel_path, module.trim());
        for item in split_top_level_commas(strip_grouping_parens(names.trim())) {
            let (imported_name, local_name) = import_alias_pair(&item);
            if imported_name.is_empty() || local_name.is_empty() {
                continue;
            }
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name,
                imported_name,
                module_candidates: module_candidates.clone(),
            });
        }
        return;
    }

    if let Some(rest) = trimmed.strip_prefix("import ") {
        for item in split_top_level_commas(rest.trim()) {
            let (module_name, local_name) = import_alias_pair(&item);
            if module_name.is_empty() || local_name.is_empty() {
                continue;
            }
            let imported_name = type_tail(&module_name).to_string();
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name,
                imported_name,
                module_candidates: python_module_candidates(&entry.rel_path, &module_name),
            });
        }
    }
}

fn collect_ts_import_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    file_id: &str,
    out: &mut Vec<ImportFact>,
) {
    if trimmed.starts_with("export ") {
        collect_ts_reexport_facts(trimmed, entry, file_id, out);
        return;
    }
    if !trimmed.starts_with("import ") {
        collect_ts_require_facts(trimmed, entry, file_id, out);
        return;
    }
    let Some(module_specifier) = quoted_module_specifier(trimmed) else {
        return;
    };
    let module_candidates = ts_module_candidates(&entry.rel_path, &module_specifier);
    if let Some(namespace_name) = ts_namespace_import_name(trimmed) {
        out.push(ImportFact {
            file_id: file_id.to_string(),
            rel_path: entry.rel_path.clone(),
            local_name: namespace_name,
            imported_name: "*".to_string(),
            module_candidates: module_candidates.clone(),
        });
    }
    if let Some((start, end)) = brace_range(trimmed) {
        for item in split_top_level_commas(&trimmed[start + 1..end]) {
            let (imported_name, local_name) = import_alias_pair(&item);
            if imported_name.is_empty() || local_name.is_empty() {
                continue;
            }
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name,
                imported_name,
                module_candidates: module_candidates.clone(),
            });
        }
    }
    let before_from = trimmed
        .split(" from ")
        .next()
        .unwrap_or("")
        .trim_start_matches("import")
        .trim();
    if !before_from.is_empty() && !before_from.starts_with('{') && !before_from.starts_with('*') {
        let default_name = before_from.split(',').next().unwrap_or("").trim();
        if is_identifier(default_name) {
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name: default_name.to_string(),
                imported_name: default_name.to_string(),
                module_candidates,
            });
        }
    }
}

fn collect_ts_reexport_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    file_id: &str,
    out: &mut Vec<ImportFact>,
) {
    let Some(module_specifier) = quoted_module_specifier(trimmed) else {
        return;
    };
    let module_candidates = ts_module_candidates(&entry.rel_path, &module_specifier);
    if trimmed.trim_start().starts_with("export *") {
        out.push(ImportFact {
            file_id: file_id.to_string(),
            rel_path: entry.rel_path.clone(),
            local_name: "*".to_string(),
            imported_name: "*".to_string(),
            module_candidates,
        });
        return;
    }
    if let Some((start, end)) = brace_range(trimmed) {
        for item in split_top_level_commas(&trimmed[start + 1..end]) {
            let (imported_name, local_name) = import_alias_pair(&item);
            if imported_name.is_empty() || local_name.is_empty() {
                continue;
            }
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name,
                imported_name,
                module_candidates: module_candidates.clone(),
            });
        }
    }
}

fn collect_ts_require_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    file_id: &str,
    out: &mut Vec<ImportFact>,
) {
    if !trimmed.contains("require(") {
        return;
    }
    let Some(module_specifier) = quoted_module_specifier(trimmed) else {
        return;
    };
    let module_candidates = ts_module_candidates(&entry.rel_path, &module_specifier);
    if let Some((left, _)) = trimmed.split_once('=') {
        if let Some((start, end)) = brace_range(left) {
            for item in split_top_level_commas(&left[start + 1..end]) {
                let (imported_name, local_name) = destructuring_alias_pair(&item);
                if imported_name.is_empty() || local_name.is_empty() {
                    continue;
                }
                out.push(ImportFact {
                    file_id: file_id.to_string(),
                    rel_path: entry.rel_path.clone(),
                    local_name,
                    imported_name,
                    module_candidates: module_candidates.clone(),
                });
            }
            return;
        }
        if let Some(name) = trailing_identifier(left.trim()) {
            out.push(ImportFact {
                file_id: file_id.to_string(),
                rel_path: entry.rel_path.clone(),
                local_name: name.clone(),
                imported_name: "*".to_string(),
                module_candidates,
            });
        }
    }
}

fn collect_java_import_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    file_id: &str,
    out: &mut Vec<ImportFact>,
) {
    let Some(rest) = trimmed.strip_prefix("import ") else {
        return;
    };
    if rest.contains('*') {
        return;
    }
    let value = rest
        .trim_start_matches("static ")
        .trim_end_matches(';')
        .trim();
    let Some(local_name) = value.rsplit('.').next().filter(|name| is_identifier(name)) else {
        return;
    };
    out.push(ImportFact {
        file_id: file_id.to_string(),
        rel_path: entry.rel_path.clone(),
        local_name: local_name.to_string(),
        imported_name: local_name.to_string(),
        module_candidates: vec![format!("{}.java", value.replace('.', "/"))],
    });
}

fn extract_type_facts(
    entry: &CorpusEntry,
    language: &str,
    symbols: &[GraphSymbol],
) -> Vec<TypeFact> {
    if language == "python" {
        return extract_python_type_facts(entry, language, symbols);
    }
    if matches!(language, "typescript" | "javascript") {
        return extract_ts_type_facts(entry, language, symbols);
    }
    Vec::new()
}

fn extract_function_return_facts(entry: &CorpusEntry, language: &str) -> Vec<FunctionReturnFact> {
    if language != "python" {
        return Vec::new();
    }
    collect_python_top_level_return_types(entry, language)
        .into_iter()
        .map(|(function_name, type_name)| FunctionReturnFact {
            rel_path: entry.rel_path.clone(),
            function_name,
            type_name,
        })
        .collect()
}

fn extract_python_type_facts(
    entry: &CorpusEntry,
    language: &str,
    symbols: &[GraphSymbol],
) -> Vec<TypeFact> {
    let mut facts = Vec::new();
    let mut pending_params: Option<(String, String, i32)> = None;
    // Precompute the enclosing scope per line (sweep over sorted lexical
    // symbols) so the inner loop costs O(1) per line instead of O(symbols).
    let line_count = entry.text.lines().count().max(1) as u32;
    let line_enclosing = precompute_enclosing_per_line(symbols, line_count);
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized = sanitize_code_line(line, language);
        let trimmed = sanitized.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let scope = line_enclosing
            .get(line_idx)
            .cloned()
            .flatten();
        if let Some((buffer, pending_scope, depth)) = pending_params.as_mut() {
            buffer.push(' ');
            buffer.push_str(trimmed);
            *depth += paren_delta(trimmed);
            if *depth <= 0 {
                collect_python_parameter_type_facts(buffer, entry, Some(pending_scope), &mut facts);
                pending_params = None;
            }
            continue;
        }
        if starts_python_function_signature(trimmed) {
            let depth = paren_delta(trimmed);
            if depth > 0 {
                pending_params = Some((
                    trimmed.to_string(),
                    scope.clone().unwrap_or_default(),
                    depth,
                ));
                continue;
            }
            collect_python_parameter_type_facts(trimmed, entry, scope.as_deref(), &mut facts);
        }
        collect_python_local_type_fact(trimmed, entry, scope.as_deref(), &mut facts);
    }
    extend_python_alias_type_facts(entry, language, symbols, &mut facts);
    facts
}

fn extract_ts_type_facts(
    entry: &CorpusEntry,
    language: &str,
    symbols: &[GraphSymbol],
) -> Vec<TypeFact> {
    let mut facts = Vec::new();
    let signature_start_scopes: HashMap<u32, String> = symbols
        .iter()
        .filter(|symbol| matches!(symbol.kind.as_str(), "function" | "method"))
        .map(|symbol| (symbol.start_line, symbol.id.clone()))
        .collect();
    let mut pending_params: Option<(String, String, i32)> = None;
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized = sanitize_code_line(line, language);
        let trimmed = sanitized.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((buffer, pending_scope, depth)) = pending_params.as_mut() {
            buffer.push(' ');
            buffer.push_str(trimmed);
            *depth += paren_delta(trimmed);
            if *depth <= 0 {
                collect_ts_parameter_type_facts(buffer, entry, Some(pending_scope), &mut facts);
                pending_params = None;
            }
            continue;
        }
        let scope = enclosing_type_fact_scope_for_line(symbols, line_idx as u32);
        if let Some(signature_scope) = signature_start_scopes.get(&(line_idx as u32)) {
            let depth = paren_delta(trimmed);
            if depth > 0 {
                pending_params = Some((trimmed.to_string(), signature_scope.clone(), depth));
                continue;
            }
            collect_ts_parameter_type_facts(trimmed, entry, Some(signature_scope), &mut facts);
        }
        collect_ts_local_type_fact(trimmed, entry, scope.as_deref(), &mut facts);
    }
    facts
}

fn collect_python_parameter_type_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    out: &mut Vec<TypeFact>,
) {
    out.extend(python_parameter_type_facts(trimmed, entry, scope));
}

fn python_parameter_type_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Vec<TypeFact> {
    let mut out = Vec::new();
    let Some(params) = python_function_params(trimmed) else {
        return out;
    };
    for param in split_top_level_commas(params) {
        let param = param
            .trim()
            .trim_start_matches('*')
            .trim_start_matches('*')
            .trim();
        let Some((name_part, type_part)) = param.split_once(':') else {
            continue;
        };
        let Some(local_name) = trailing_identifier(name_part.trim()) else {
            continue;
        };
        if matches!(local_name.as_str(), "self" | "cls") {
            continue;
        }
        let type_expr = type_part.split('=').next().unwrap_or("").trim();
        let Some(type_name) = type_name_from_annotation(type_expr) else {
            continue;
        };
        out.push(TypeFact {
            rel_path: entry.rel_path.clone(),
            local_name,
            type_name,
            enclosing_symbol_id: scope.map(str::to_string),
        });
    }
    out
}

fn python_parameter_element_type_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Vec<TypeFact> {
    let mut out = Vec::new();
    let Some(params) = python_function_params(trimmed) else {
        return out;
    };
    for param in split_top_level_commas(params) {
        let param = param
            .trim()
            .trim_start_matches('*')
            .trim_start_matches('*')
            .trim();
        let Some((name_part, type_part)) = param.split_once(':') else {
            continue;
        };
        let Some(local_name) = trailing_identifier(name_part.trim()) else {
            continue;
        };
        if matches!(local_name.as_str(), "self" | "cls") {
            continue;
        }
        let type_expr = type_part.split('=').next().unwrap_or("").trim();
        let Some(type_name) = element_type_name_from_annotation(type_expr) else {
            continue;
        };
        out.push(TypeFact {
            rel_path: entry.rel_path.clone(),
            local_name,
            type_name,
            enclosing_symbol_id: scope.map(str::to_string),
        });
    }
    out
}

fn collect_ts_parameter_type_facts(
    signature: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    out: &mut Vec<TypeFact>,
) {
    let Some(params) = signature_params(signature) else {
        return;
    };
    for param in split_top_level_commas(params) {
        let param = param
            .trim()
            .trim_start_matches("...")
            .trim_start_matches("public ")
            .trim_start_matches("private ")
            .trim_start_matches("protected ")
            .trim_start_matches("readonly ")
            .trim();
        let Some((name_part, type_part)) = param.split_once(':') else {
            continue;
        };
        let Some(local_name) = trailing_identifier(name_part.trim()) else {
            continue;
        };
        let type_expr = type_part
            .split('=')
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(',');
        let Some(type_name) = type_name_from_annotation(type_expr) else {
            continue;
        };
        out.push(TypeFact {
            rel_path: entry.rel_path.clone(),
            local_name,
            type_name,
            enclosing_symbol_id: scope.map(str::to_string),
        });
    }
}

fn collect_python_local_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    out: &mut Vec<TypeFact>,
) {
    if let Some(fact) = python_local_type_fact(trimmed, entry, scope) {
        out.push(fact);
    }
}

fn python_local_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Option<TypeFact> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
    {
        return None;
    }
    let Some(local_name) = leading_identifier(trimmed) else {
        return None;
    };
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let type_name = if let Some(annotation) = rest.strip_prefix(':') {
        let type_expr = annotation.split('=').next().unwrap_or("").trim();
        type_name_from_annotation(type_expr)
    } else if let Some(rhs) = rest.strip_prefix('=') {
        let rhs = rhs.trim_start();
        type_name_from_cast_call(rhs).or_else(|| type_name_from_constructor_call(rhs))
    } else {
        None
    };
    let Some(type_name) = type_name else {
        return None;
    };
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_local_element_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Option<TypeFact> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let type_expr = if let Some(annotation) = rest.strip_prefix(':') {
        annotation
            .split('=')
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    } else if let Some(rhs) = rest.strip_prefix('=') {
        let rhs = rhs.trim_start();
        let open = cast_call_args(rhs)?;
        open.first()?.trim().to_string()
    } else {
        return None;
    };
    let type_name = element_type_name_from_annotation(&type_expr)?;
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn extend_python_alias_type_facts(
    entry: &CorpusEntry,
    language: &str,
    symbols: &[GraphSymbol],
    out: &mut Vec<TypeFact>,
) {
    let return_types = collect_python_top_level_return_types(entry, language);
    let mut known: HashMap<(String, String), String> = HashMap::new();
    let mut known_elements: HashMap<(String, String), String> = HashMap::new();
    let mut pending_params: Option<(String, String, i32)> = None;
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized = sanitize_code_line(line, language);
        let trimmed = sanitized.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        let scope = enclosing_type_fact_scope_for_line(symbols, line_idx as u32);
        if let Some((buffer, pending_scope, depth)) = pending_params.as_mut() {
            buffer.push(' ');
            buffer.push_str(trimmed);
            *depth += paren_delta(trimmed);
            if *depth <= 0 {
                for fact in python_parameter_type_facts(buffer, entry, Some(pending_scope)) {
                    remember_type_fact(&mut known, &fact);
                }
                for fact in python_parameter_element_type_facts(buffer, entry, Some(pending_scope))
                {
                    remember_type_fact(&mut known_elements, &fact);
                }
                pending_params = None;
            }
            continue;
        }
        if starts_python_function_signature(trimmed) {
            let depth = paren_delta(trimmed);
            if depth > 0 {
                pending_params = Some((
                    trimmed.to_string(),
                    scope.clone().unwrap_or_default(),
                    depth,
                ));
                continue;
            }
            for fact in python_parameter_type_facts(trimmed, entry, scope.as_deref()) {
                remember_type_fact(&mut known, &fact);
            }
            for fact in python_parameter_element_type_facts(trimmed, entry, scope.as_deref()) {
                remember_type_fact(&mut known_elements, &fact);
            }
            continue;
        }
        if let Some(fact) =
            python_for_element_type_fact(trimmed, entry, scope.as_deref(), &known_elements)
        {
            remember_type_fact(&mut known, &fact);
            out.push(fact);
            continue;
        }
        if let Some(fact) =
            python_index_element_type_fact(trimmed, entry, scope.as_deref(), &known_elements)
        {
            remember_type_fact(&mut known, &fact);
            out.push(fact);
            continue;
        }
        if let Some(fact) =
            python_django_model_manager_element_call_type_fact(trimmed, entry, scope.as_deref())
        {
            remember_type_fact(&mut known, &fact);
            out.push(fact);
            continue;
        }
        if let Some(element_fact) = python_django_model_manager_preserving_call_element_fact(
            trimmed,
            entry,
            scope.as_deref(),
        ) {
            remember_type_fact(&mut known_elements, &element_fact);
            continue;
        }
        if let Some(fact) =
            python_django_element_call_type_fact(trimmed, entry, scope.as_deref(), &known_elements)
        {
            remember_type_fact(&mut known, &fact);
            out.push(fact);
            continue;
        }
        if let Some((type_fact, element_fact)) = python_django_preserving_call_type_facts(
            trimmed,
            entry,
            scope.as_deref(),
            &known,
            &known_elements,
        ) {
            if let Some(element_fact) = element_fact {
                remember_type_fact(&mut known_elements, &element_fact);
            }
            if let Some(type_fact) = type_fact {
                remember_type_fact(&mut known, &type_fact);
                out.push(type_fact);
            }
            continue;
        }
        if let Some(fact) =
            python_call_return_type_fact(trimmed, entry, scope.as_deref(), &return_types)
        {
            remember_type_fact(&mut known, &fact);
            out.push(fact);
            continue;
        }
        if let Some(fact) = python_local_type_fact(trimmed, entry, scope.as_deref()) {
            remember_type_fact(&mut known, &fact);
            if let Some(element_fact) =
                python_local_element_type_fact(trimmed, entry, scope.as_deref())
            {
                remember_type_fact(&mut known_elements, &element_fact);
            }
            continue;
        }
        if let Some(fact) = python_alias_type_fact(trimmed, entry, scope.as_deref(), &known) {
            if let Some(element_type) = python_alias_source_name(trimmed).and_then(|source_name| {
                known_type_for_local(scope.as_deref(), &source_name, &known_elements)
            }) {
                known_elements.insert(
                    (
                        fact.enclosing_symbol_id.clone().unwrap_or_default(),
                        fact.local_name.clone(),
                    ),
                    element_type,
                );
            }
            remember_type_fact(&mut known, &fact);
            out.push(fact);
        }
    }
}

fn collect_python_top_level_return_types(
    entry: &CorpusEntry,
    language: &str,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut pending_signature: Option<(String, i32)> = None;
    for line in entry.text.lines() {
        let sanitized = sanitize_code_line(line, language);
        let trimmed = sanitized.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        if let Some((buffer, depth)) = pending_signature.as_mut() {
            buffer.push(' ');
            buffer.push_str(trimmed);
            *depth += paren_delta(trimmed);
            if *depth <= 0 {
                if let Some((name, type_name)) = python_function_name_and_return_type(buffer) {
                    out.insert(name, type_name);
                }
                pending_signature = None;
            }
            continue;
        }
        if line_indent(line) != 0 || !starts_python_function_signature(trimmed) {
            continue;
        }
        let depth = paren_delta(trimmed);
        if depth > 0 {
            pending_signature = Some((trimmed.to_string(), depth));
            continue;
        }
        if let Some((name, type_name)) = python_function_name_and_return_type(trimmed) {
            out.insert(name, type_name);
        }
    }
    out
}

fn python_function_name_and_return_type(trimmed: &str) -> Option<(String, String)> {
    let rest = strip_keyword(trimmed, "def").or_else(|| strip_keyword(trimmed, "async def"))?;
    let name = leading_identifier(rest)?;
    let open = rest.find('(')?;
    let close = matching_close_paren(rest, open)?;
    let after_params = rest[close + 1..].trim_start();
    let return_expr = after_params.strip_prefix("->")?;
    let return_expr = return_expr.split(':').next().unwrap_or("").trim();
    let type_name = type_name_from_annotation(return_expr)?;
    Some((name, type_name))
}

fn python_call_return_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    return_types: &HashMap<String, String>,
) -> Option<TypeFact> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("for ")
        || trimmed.starts_with("with ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    if cast_call_args(rhs).is_some() {
        return None;
    }
    let callee = leading_identifier(rhs)?;
    let rhs_tail = rhs[callee.len()..].trim_start();
    if !rhs_tail.starts_with('(') {
        return None;
    }
    let type_name = return_types
        .get(&callee)
        .cloned()
        .unwrap_or_else(|| format!("{RETURN_TYPE_FACT_PREFIX}{callee}"));
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_for_element_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    known_elements: &HashMap<(String, String), String>,
) -> Option<TypeFact> {
    let rest = strip_keyword(trimmed, "for")?;
    let (target_part, source_part) = rest.split_once(" in ")?;
    let local_name = trailing_identifier(target_part.trim())?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let source_expr = source_part.split(':').next().unwrap_or("").trim();
    let source_name = leading_identifier(source_expr)?;
    let source_tail = source_expr[source_name.len()..].trim();
    if !source_tail.is_empty() {
        return None;
    }
    let type_name = known_type_for_local(scope, &source_name, known_elements)?;
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_index_element_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    known_elements: &HashMap<(String, String), String>,
) -> Option<TypeFact> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    let source_name = leading_identifier(rhs)?;
    let source_tail = rhs[source_name.len()..].trim_start();
    if !source_tail.starts_with('[') {
        return None;
    }
    let close = source_tail.find(']')?;
    if !source_tail[close + 1..].trim().is_empty() {
        return None;
    }
    let type_name = known_type_for_local(scope, &source_name, known_elements)?;
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_django_element_call_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    known_elements: &HashMap<(String, String), String>,
) -> Option<TypeFact> {
    let (local_name, receiver_name, member_name) = assignment_member_call(trimmed)?;
    if !is_django_element_returning_member(&member_name) {
        return None;
    }
    let type_name = known_type_for_local(scope, &receiver_name, known_elements)?;
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_django_model_manager_element_call_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Option<TypeFact> {
    let (local_name, model_name, _, member_name) = assignment_django_model_manager_call(trimmed)?;
    if !is_django_element_returning_member(&member_name) {
        return None;
    }
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name: format!("{DJANGO_MODEL_MANAGER_FACT_PREFIX}{model_name}"),
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_django_model_manager_preserving_call_element_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
) -> Option<TypeFact> {
    let (local_name, model_name, _, member_name) = assignment_django_model_manager_call(trimmed)?;
    if !is_django_collection_preserving_member(&member_name) {
        return None;
    }
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name: format!("{DJANGO_MODEL_MANAGER_FACT_PREFIX}{model_name}"),
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_django_preserving_call_type_facts(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    known: &HashMap<(String, String), String>,
    known_elements: &HashMap<(String, String), String>,
) -> Option<(Option<TypeFact>, Option<TypeFact>)> {
    let (local_name, receiver_name, member_name) = assignment_member_call(trimmed)?;
    if !is_django_collection_preserving_member(&member_name) {
        return None;
    }
    let element_type = known_type_for_local(scope, &receiver_name, known_elements);
    let receiver_type = known_type_for_local(scope, &receiver_name, known);
    let type_fact = receiver_type.and_then(|type_name| {
        if element_type.as_deref() == Some(type_name.as_str()) {
            return None;
        }
        Some(TypeFact {
            rel_path: entry.rel_path.clone(),
            local_name: local_name.clone(),
            type_name,
            enclosing_symbol_id: scope.map(str::to_string),
        })
    });
    let element_fact = element_type.map(|type_name| TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    });
    if type_fact.is_none() && element_fact.is_none() {
        return None;
    }
    Some((type_fact, element_fact))
}

fn assignment_django_model_manager_call(trimmed: &str) -> Option<(String, String, String, String)> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("for ")
        || trimmed.starts_with("with ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    let rhs = rhs.strip_prefix("await ").unwrap_or(rhs).trim_start();
    let model_name = leading_identifier(rhs)?;
    let manager_start = rhs[model_name.len()..].trim_start().strip_prefix('.')?;
    let manager_name = leading_identifier(manager_start)?;
    if !is_django_manager_accessor_name(&manager_name) {
        return None;
    }
    let member_start = manager_start[manager_name.len()..]
        .trim_start()
        .strip_prefix('.')?;
    let member_name = leading_identifier(member_start)?;
    let call_tail = member_start[member_name.len()..].trim_start();
    if !call_tail.starts_with('(') {
        return None;
    }
    let close = matching_close_paren(call_tail, 0)?;
    if !call_tail[close + 1..].trim().is_empty() {
        return None;
    }
    Some((local_name, model_name, manager_name, member_name))
}

fn assignment_member_call(trimmed: &str) -> Option<(String, String, String)> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("for ")
        || trimmed.starts_with("with ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    let rhs = rhs.strip_prefix("await ").unwrap_or(rhs).trim_start();
    let receiver_name = leading_identifier(rhs)?;
    let member_start = rhs[receiver_name.len()..].trim_start().strip_prefix('.')?;
    let member_name = leading_identifier(member_start)?;
    let call_tail = member_start[member_name.len()..].trim_start();
    if !call_tail.starts_with('(') {
        return None;
    }
    let close = matching_close_paren(call_tail, 0)?;
    if !call_tail[close + 1..].trim().is_empty() {
        return None;
    }
    Some((local_name, receiver_name, member_name))
}

fn is_django_manager_accessor_name(name: &str) -> bool {
    matches!(name, "_base_manager" | "_default_manager" | "objects")
}

fn is_django_element_returning_member(name: &str) -> bool {
    matches!(
        name,
        "aget" | "afirst" | "alast" | "earliest" | "first" | "get" | "last" | "latest"
    )
}

fn is_django_collection_preserving_member(name: &str) -> bool {
    matches!(
        name,
        "aall"
            | "adefer"
            | "aexclude"
            | "afilter"
            | "alias"
            | "all"
            | "annotate"
            | "complex_filter"
            | "defer"
            | "difference"
            | "distinct"
            | "exclude"
            | "filter"
            | "intersection"
            | "none"
            | "only"
            | "order_by"
            | "prefetch_related"
            | "reverse"
            | "select_for_update"
            | "select_related"
            | "union"
            | "using"
    )
}

fn known_type_for_local(
    scope: Option<&str>,
    local_name: &str,
    known: &HashMap<(String, String), String>,
) -> Option<String> {
    known
        .get(&(
            scope.unwrap_or_default().to_string(),
            local_name.to_string(),
        ))
        .or_else(|| known.get(&(String::new(), local_name.to_string())))
        .cloned()
}

fn remember_type_fact(known: &mut HashMap<(String, String), String>, fact: &TypeFact) {
    known.insert(
        (
            fact.enclosing_symbol_id.clone().unwrap_or_default(),
            fact.local_name.clone(),
        ),
        fact.type_name.clone(),
    );
}

fn python_alias_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    known: &HashMap<(String, String), String>,
) -> Option<TypeFact> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("for ")
        || trimmed.starts_with("with ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    let rhs = rhs.strip_prefix("await ").unwrap_or(rhs).trim_start();
    let source_name = leading_identifier(rhs)?;
    let rhs_tail = rhs[source_name.len()..].trim();
    if !rhs_tail.is_empty() {
        return None;
    }
    let scope_key = scope.unwrap_or_default();
    let type_name = known
        .get(&(scope_key.to_string(), source_name.clone()))
        .or_else(|| known.get(&(String::new(), source_name.clone())))?
        .clone();
    Some(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    })
}

fn python_alias_source_name(trimmed: &str) -> Option<String> {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("def ")
        || trimmed.starts_with("async def ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("from ")
        || trimmed.starts_with("for ")
        || trimmed.starts_with("with ")
    {
        return None;
    }
    let local_name = leading_identifier(trimmed)?;
    if matches!(local_name.as_str(), "self" | "cls") {
        return None;
    }
    let rest = trimmed[local_name.len()..].trim_start();
    let rhs = rest.strip_prefix('=')?.trim_start();
    let rhs = rhs.strip_prefix("await ").unwrap_or(rhs).trim_start();
    let source_name = leading_identifier(rhs)?;
    let rhs_tail = rhs[source_name.len()..].trim();
    rhs_tail.is_empty().then_some(source_name)
}

fn collect_ts_local_type_fact(
    trimmed: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    out: &mut Vec<TypeFact>,
) {
    if trimmed.starts_with("return ")
        || trimmed.starts_with("import ")
        || trimmed.starts_with("export ")
        || trimmed.starts_with("function ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("interface ")
        || trimmed.starts_with("type ")
    {
        return;
    }
    let normalized = trimmed
        .trim_start_matches("public ")
        .trim_start_matches("private ")
        .trim_start_matches("protected ")
        .trim_start_matches("readonly ")
        .trim_start_matches("static ")
        .trim_start_matches("const ")
        .trim_start_matches("let ")
        .trim_start_matches("var ")
        .trim();

    if let Some(rest) = normalized.strip_prefix("this.") {
        collect_ts_member_assignment_type_fact(rest, entry, scope, out);
        return;
    }

    let Some(local_name) = leading_identifier(normalized) else {
        return;
    };
    let rest = normalized[local_name.len()..].trim_start();
    let type_name = if let Some(annotation) = rest.strip_prefix(':') {
        let type_expr = annotation
            .split('=')
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(';');
        type_name_from_annotation(type_expr)
    } else if let Some(rhs) = rest.strip_prefix('=') {
        type_name_from_constructor_call(rhs.trim_start())
    } else {
        None
    };
    let Some(type_name) = type_name else {
        return;
    };
    out.push(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    });
}

fn collect_ts_member_assignment_type_fact(
    rest: &str,
    entry: &CorpusEntry,
    scope: Option<&str>,
    out: &mut Vec<TypeFact>,
) {
    let Some(local_name) = leading_identifier(rest) else {
        return;
    };
    let tail = rest[local_name.len()..].trim_start();
    let type_name = if let Some(annotation) = tail.strip_prefix(':') {
        type_name_from_annotation(annotation.split('=').next().unwrap_or("").trim())
    } else if let Some(rhs) = tail.strip_prefix('=') {
        type_name_from_constructor_call(rhs.trim_start())
    } else {
        None
    };
    let Some(type_name) = type_name else {
        return;
    };
    out.push(TypeFact {
        rel_path: entry.rel_path.clone(),
        local_name,
        type_name,
        enclosing_symbol_id: scope.map(str::to_string),
    });
}

fn python_function_params(trimmed: &str) -> Option<&str> {
    strip_keyword(trimmed, "def")
        .or_else(|| strip_keyword(trimmed, "async def"))
        .and_then(|rest| {
            let open = rest.find('(')?;
            let close = matching_close_paren(rest, open)?;
            Some(&rest[open + 1..close])
        })
}

fn starts_python_function_signature(trimmed: &str) -> bool {
    strip_keyword(trimmed, "def")
        .or_else(|| strip_keyword(trimmed, "async def"))
        .is_some()
}

fn signature_params(signature: &str) -> Option<&str> {
    let open = signature.find('(')?;
    let close = matching_close_paren(signature, open)?;
    Some(&signature[open + 1..close])
}

fn matching_close_paren(value: &str, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in value.char_indices().skip_while(|(idx, _)| *idx < open) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn type_name_from_annotation(value: &str) -> Option<String> {
    if value.contains('{') || value.contains("=>") {
        return None;
    }
    let candidates = qualified_identifier_tokens(value);
    if candidates.is_empty() {
        return None;
    }
    candidates
        .iter()
        .find(|candidate| !is_type_wrapper_name(type_tail(candidate)))
        .cloned()
        .or_else(|| candidates.first().cloned())
}

fn element_type_name_from_annotation(value: &str) -> Option<String> {
    let candidates = qualified_identifier_tokens(value);
    let wrapper = candidates.first()?;
    if !is_iterable_type_wrapper_name(type_tail(wrapper)) {
        return None;
    }
    candidates
        .iter()
        .skip(1)
        .find(|candidate| !is_type_wrapper_name(type_tail(candidate)))
        .cloned()
}

fn type_name_from_constructor_call(value: &str) -> Option<String> {
    let value = value
        .trim_start()
        .strip_prefix("new ")
        .unwrap_or(value.trim_start());
    let callee = leading_qualified_identifier(value)?;
    let rest = value[callee.len()..].trim_start();
    rest.starts_with('(').then_some(callee)
}

fn type_name_from_cast_call(value: &str) -> Option<String> {
    let args = cast_call_args(value)?;
    let type_expr = args.first()?.trim();
    type_name_from_annotation(type_expr)
}

fn cast_call_args(value: &str) -> Option<Vec<String>> {
    let callee = leading_qualified_identifier(value)?;
    if callee != "cast" && !callee.ends_with(".cast") {
        return None;
    }
    let rest = value[callee.len()..].trim_start();
    if !rest.starts_with('(') {
        return None;
    }
    let open = value.find('(')?;
    let close = matching_close_paren(value, open)?;
    let args = split_top_level_commas(&value[open + 1..close]);
    (args.len() >= 2).then_some(args)
}

fn qualified_identifier_tokens(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in value.char_indices() {
        if start.is_none() && is_ident_start(ch) {
            start = Some(idx);
            continue;
        }
        if let Some(token_start) = start {
            if !(is_ident_continue(ch) || ch == '.') {
                out.push(value[token_start..idx].to_string());
                start = None;
            }
        }
    }
    if let Some(token_start) = start {
        out.push(value[token_start..].to_string());
    }
    out
}

fn is_type_wrapper_name(name: &str) -> bool {
    matches!(
        name,
        "Annotated"
            | "Any"
            | "Callable"
            | "ClassVar"
            | "Dict"
            | "Final"
            | "Iterable"
            | "Iterator"
            | "List"
            | "Literal"
            | "Mapping"
            | "None"
            | "Optional"
            | "Promise"
            | "Readonly"
            | "ReadonlyArray"
            | "Record"
            | "Sequence"
            | "Set"
            | "Tuple"
            | "Type"
            | "Union"
            | "any"
            | "boolean"
            | "dict"
            | "frozenset"
            | "keyof"
            | "list"
            | "never"
            | "null"
            | "number"
            | "object"
            | "set"
            | "string"
            | "symbol"
            | "tuple"
            | "undefined"
            | "unknown"
            | "void"
    )
}

fn is_iterable_type_wrapper_name(name: &str) -> bool {
    matches!(
        name,
        "Iterable"
            | "Iterator"
            | "List"
            | "Manager"
            | "QuerySet"
            | "Sequence"
            | "Set"
            | "Tuple"
            | "list"
            | "set"
            | "tuple"
    )
}

fn extract_ref_sites(
    entry: &CorpusEntry,
    symbols: &[GraphSymbol],
    language: &str,
) -> Vec<RefSite> {
    // Borrow the symbol names instead of cloning them into the set, so each
    // membership check only hashes &str (no String allocation per token).
    let definition_positions: HashSet<(u32, u32, &str)> = symbols
        .iter()
        .map(|symbol| (symbol.start_line, symbol.start_column, symbol.name.as_str()))
        .collect();
    let mut ref_sites = Vec::new();
    let rel_path_hash = stable_hash(&entry.rel_path);
    // P1: allocate the per-file-constant / tiny-fixed-set strings ONCE, then
    // hand each site a cheap `Arc<str>` clone (refcount bump) instead of a fresh
    // String. rel_path (~40 chars) + language alone were ~38M redundant allocs.
    let rel_path_arc: Arc<str> = Arc::from(entry.rel_path.as_str());
    let language_arc: Arc<str> = Arc::from(language);
    let arc_call: Arc<str> = Arc::from("call");
    let arc_usage: Arc<str> = Arc::from("usage");
    let arc_member: Arc<str> = Arc::from("member");
    let arc_bare: Arc<str> = Arc::from("bare");
    let mut python_multiline_string_quote = None;
    let line_count = entry.text.lines().count().max(1) as u32;
    let line_enclosing_cache = precompute_enclosing_per_line(symbols, line_count);
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized =
            sanitize_ref_site_code_line(line, language, &mut python_multiline_string_quote);
        let is_import_context = is_import_context_line(sanitized.trim_start(), language);
        // B6 stage-3: enclosing is line-constant; parse the "sym:HEX16" id to
        // its u64 once per line (0 = none) instead of cloning the String per
        // line and re-hashing it per site.
        let line_enclosing_id: u64 = line_enclosing_cache
            .get(line_idx)
            .and_then(|o| o.as_deref())
            .and_then(parse_stable_symbol_id_to_u64)
            .unwrap_or(0);
        for (name, start, end) in identifier_tokens(&sanitized) {
            if is_keyword(&name, language) {
                continue;
            }
            let is_definition =
                definition_positions.contains(&(line_idx as u32, start as u32, name.as_str()));
            let edge_kind = if next_nonspace_char(&sanitized, end) == Some('(') {
                "call"
            } else {
                "usage"
            };
            let receiver_name = member_receiver_name(&sanitized, start);
            let access_kind = if receiver_name.is_some() || has_member_access_dot(&sanitized, start)
            {
                "member"
            } else {
                "bare"
            };
            // B6 stage-2: build the u64 directly (no "ref:HEX16" string alloc).
            let source_ref_id =
                stable_ref_id_u64(&entry.rel_path, line_idx as u32, start as u32, &name);
            let name_hash = stable_hash(&name);
            let receiver_name_hash = receiver_name
                .as_deref()
                .map(stable_hash)
                .unwrap_or(0);
            let access_kind_id = compute_access_kind_id(access_kind);
            let edge_kind_id = compute_edge_kind_id(edge_kind);
            ref_sites.push(RefSite {
                source_ref_id,
                // B6: `raw_text` dropped (== name); move `name` in, no clone.
                name,
                rel_path: rel_path_arc.clone(),
                language: language_arc.clone(),
                start_line: line_idx as u32,
                start_column: start as u32,
                end_line: line_idx as u32,
                end_column: end as u32,
                edge_kind: if edge_kind == "call" {
                    arc_call.clone()
                } else {
                    arc_usage.clone()
                },
                access_kind: if access_kind == "member" {
                    arc_member.clone()
                } else {
                    arc_bare.clone()
                },
                is_definition,
                is_import_context,
                receiver_name,
                enclosing_id: line_enclosing_id,
                rel_path_hash,
                name_hash,
                receiver_name_hash,
                access_kind_id,
                edge_kind_id,
            });
        }
    }
    ref_sites
}

fn resolve_ref_sites(
    symbols: &[GraphSymbol],
    ref_sites: &[RefSite],
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    hierarchy_facts: &[HierarchyFact],
) -> ResolutionResult {
    let mut intermediate = resolve_ref_sites_a_to_e(
        symbols,
        ref_sites,
        None,
        import_facts,
        type_facts,
        function_return_facts,
        hierarchy_facts,
        None, // B6 stage-4: legacy path keeps reading RefSite.receiver_name
        None, // prebuilt_site_cols: build internally
        false, // force_columns: respect ZOEK_SOA_OFF
        None,
    );
    let _t_pf = std::time::Instant::now();
    // phase_f reads `references.iter()` to compute reference_counts_by_symbol_id;
    // any spilled phase E batches must be drained back into references first so
    // the count is correct (else under-count → token-shape over-padding).
    // Streaming sidecar write — Session R3 follow-up — will replace this with a
    // sidecar-aware reference_count tally that doesn't need the data in memory.
    for path in std::mem::take(&mut intermediate.reference_partials) {
        let bytes_or_err = fs::read(&path);
        let _ = fs::remove_file(&path);
        let bytes = bytes_or_err.expect("read spill");
        let batch: Vec<GraphReference> =
            bincode::deserialize(&bytes).expect("deserialize spill");
        intermediate.references.extend(batch);
    }
    let light_in = std::mem::take(&mut intermediate.light_references);
    let mut light_out_f: Vec<LightRef> = Vec::new();
    apply_token_shape_likely_count_baseline(
        symbols,
        ref_sites,
        &mut intermediate.counts,
        &intermediate.bare_usage_likely_by_scope_and_name,
        &intermediate.bare_call_likely_by_scope_and_name,
        &intermediate.member_usage_likely_by_scope_and_name,
        &intermediate.member_call_likely_by_scope_and_name,
        &intermediate.bare_likely_sites_by_scope_and_name,
        &intermediate.member_likely_sites_by_scope_and_name,
        &mut intermediate.references,
        &intermediate.light_target_count_by_id_u64,
        &mut light_out_f,
        &mut intermediate.dedup,
        &mut intermediate.reference_partials,
        None,
        None, // B6 stage-5d: legacy path keeps ref_sites (no prebuilt SiteCols)
    );
    intermediate.light_references = light_in;
    intermediate.light_references.append(&mut light_out_f);
    if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
        eprintln!(
            "[resolve] phase_f={}ms refs_after_f_tail={} f_partials={}",
            _t_pf.elapsed().as_millis(),
            intermediate.references.len(),
            intermediate.reference_partials.len()
        );
    }
    materialize_resolution_for_legacy_callers(intermediate, ref_sites)
}

/// Variant that does not materialize `references` from `light_references`.
/// Used by `rebuild_graph_native` so the production write path skips the
/// per-record materialization (saves ~14.4M × 200B working set). Tests and
/// incremental update keep using `resolve_ref_sites` (above), which calls
/// the materialize helper so `result.references` stays populated.
fn resolve_ref_sites_for_rebuild(
    symbols: &[GraphSymbol],
    ref_sites: &[RefSite],
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    hierarchy_facts: &[HierarchyFact],
    // B6 stage-4/5c: pass-through column reconstruction (receiver + rel_path).
    recon: Option<SiteReconCols>,
    // B6 stage-5d: pass-through pre-built SiteCols + force-columns (channel
    // rebuild that dropped `ref_sites`).
    prebuilt_site_cols: Option<&[SiteCols]>,
    force_columns: bool,
    // F1.b: pass-through. `Some(&sender)` enables the channel-driven write
    // pipeline for phase E workers (their LightRef batches stream into the
    // writer thread). Phase F continues to accumulate into `light_out_f` so
    // its worker wall isn't slowed by channel backpressure; the caller can
    // bulk-send `light_references` into the same channel after this returns.
    light_sender: Option<&crossbeam_channel::Sender<Vec<LightRef>>>,
) -> ResolutionResult {
    let mut intermediate = resolve_ref_sites_a_to_e(
        symbols,
        ref_sites,
        None,
        import_facts,
        type_facts,
        function_return_facts,
        hierarchy_facts,
        recon,
        prebuilt_site_cols,
        force_columns,
        light_sender,
    );
    for path in std::mem::take(&mut intermediate.reference_partials) {
        let bytes_or_err = fs::read(&path);
        let _ = fs::remove_file(&path);
        let bytes = bytes_or_err.expect("read spill");
        let batch: Vec<GraphReference> =
            bincode::deserialize(&bytes).expect("deserialize spill");
        intermediate.references.extend(batch);
    }
    // Phase F runs sequentially after phase E and is a single rayon parallel
    // pass (~5s). With the original single-thread writer, streaming its 9.18M
    // lights through the channel added backpressure (workers stalled while the
    // writer drained), bloating phase_f wall to ~17s — so phase F buffered into
    // `light_out_f` and rebuild_graph_native bulk-sent it as one batch.
    //
    // F1.b (W1): the writer is now multi-threaded (dedicated rayon pool) and
    // drains fast enough to keep up, so phase F can stream too — its lights then
    // overlap the writer instead of being written after resolve completes
    // (phase F is ~64% of all records, so this is where the real overlap win
    // lives). Opt in via ZOEK_LIGHT_CHANNEL_PHASE_F=1. phase_f wall is the
    // load-robust signal: if backpressure returns it spikes, so the default
    // keeps the safe buffering path.
    let light_in = std::mem::take(&mut intermediate.light_references);
    let mut light_out_f: Vec<LightRef> = Vec::new();
    let phase_f_sender = if light_sender.is_some()
        && std::env::var("ZOEK_LIGHT_CHANNEL_PHASE_F").is_ok()
    {
        light_sender
    } else {
        None
    };
    let _t_pf = std::time::Instant::now();
    apply_token_shape_likely_count_baseline(
        symbols,
        ref_sites,
        &mut intermediate.counts,
        &intermediate.bare_usage_likely_by_scope_and_name,
        &intermediate.bare_call_likely_by_scope_and_name,
        &intermediate.member_usage_likely_by_scope_and_name,
        &intermediate.member_call_likely_by_scope_and_name,
        &intermediate.bare_likely_sites_by_scope_and_name,
        &intermediate.member_likely_sites_by_scope_and_name,
        &mut intermediate.references,
        &intermediate.light_target_count_by_id_u64,
        &mut light_out_f,
        &mut intermediate.dedup,
        &mut intermediate.reference_partials,
        phase_f_sender,
        prebuilt_site_cols, // B6 stage-5d: site_partial from SiteCols when ref_sites dropped
    );
    if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
        eprintln!(
            "[resolve] phase_f={}ms light_out={} f_partials={}",
            _t_pf.elapsed().as_millis(),
            light_out_f.len(),
            intermediate.reference_partials.len()
        );
    }
    intermediate.light_references = light_in;
    intermediate.light_references.append(&mut light_out_f);
    ResolutionResult {
        references: intermediate.references, // empty in Phase 4-Q
        light_references: intermediate.light_references,
        reference_partials: intermediate.reference_partials,
        counts: intermediate.counts,
    }
}

/// Boundary materialize for legacy callers (tests, incremental update).
/// Walks `light_references` and produces a parallel `Vec<GraphReference>`.
/// Single-threaded — cheap for test-sized workloads (<1k refs) and only
/// runs when the caller actually goes through `resolve_ref_sites`.
fn materialize_resolution_for_legacy_callers(
    mut intermediate: ResolveIntermediate,
    ref_sites: &[RefSite],
) -> ResolutionResult {
    let mut references = std::mem::take(&mut intermediate.references);
    if references.is_empty() && !intermediate.light_references.is_empty() {
        references.reserve(intermediate.light_references.len());
        for light in &intermediate.light_references {
            references.push(materialize_light_ref(light, ref_sites));
        }
    }
    ResolutionResult {
        references,
        light_references: intermediate.light_references,
        reference_partials: intermediate.reference_partials,
        counts: intermediate.counts,
    }
}

/// Option C Stage 1: per-file bucket of phase E site indices. Each bucket
/// groups indices sharing the same `rel_path_hash` so the phase E outer loop
/// processes one file at a time. ref_sites arrives file-grouped per parse
/// chunk (FileGraph ingest is atomic), so the bucket builder is a single
/// linear scan that opens a new bucket whenever the hash changes.
struct PhaseEFileBucket {
    rel_path_hash: u64,
    indices: Vec<u32>,
}

fn build_phase_e_file_buckets(
    // B6 stage-5c: reads only `rel_path_hash` (in `SiteCols`), so it no longer
    // dereferences `RefSite` — one of the two remaining column-path reads to
    // clear before `Vec<RefSite>` can be dropped.
    site_cols: &[SiteCols],
    indices: Option<&[u32]>,
) -> Vec<PhaseEFileBucket> {
    let total = indices.map(|i| i.len()).unwrap_or(site_cols.len());
    if total == 0 {
        return Vec::new();
    }
    // captain2 corpus avg ~120 sites/file → preallocate at total/100 buckets.
    let mut buckets: Vec<PhaseEFileBucket> = Vec::with_capacity(total / 100 + 16);
    let push_index = |buckets: &mut Vec<PhaseEFileBucket>, idx: u32, hash: u64| {
        match buckets.last_mut() {
            Some(b) if b.rel_path_hash == hash => b.indices.push(idx),
            _ => buckets.push(PhaseEFileBucket {
                rel_path_hash: hash,
                indices: {
                    let mut v = Vec::with_capacity(32);
                    v.push(idx);
                    v
                },
            }),
        }
    };
    match indices {
        Some(idxs) => {
            for &idx in idxs {
                let hash = site_cols[idx as usize].rel_path_hash;
                push_index(&mut buckets, idx, hash);
            }
        }
        None => {
            for (i, c) in site_cols.iter().enumerate() {
                push_index(&mut buckets, i as u32, c.rel_path_hash);
            }
        }
    }
    buckets
}

fn resolve_ref_sites_a_to_e<'a>(
    symbols: &'a [GraphSymbol],
    ref_sites: &'a [RefSite],
    phase_e_indices: Option<&'a [u32]>,
    import_facts: &'a [ImportFact],
    type_facts: &'a [TypeFact],
    function_return_facts: &'a [FunctionReturnFact],
    hierarchy_facts: &'a [HierarchyFact],
    // B6 stage-4/5c: when `Some`, the column worker's per-file cache-miss
    // rebuilds `receiver_name` (and, when `recon.file` is `Some`, `rel_path`)
    // from `u32` id columns instead of `RefSite` — the toehold for dropping
    // `Vec<RefSite>` (stage-5d). `None` on incremental/legacy/test paths.
    recon: Option<SiteReconCols<'a>>,
    // B6 stage-5d: when `Some`, `SiteCols` was built before resolve (so
    // `Vec<RefSite>` could be dropped) and is used as-is; `None` builds it from
    // `ref_sites` (incremental/legacy/test/fallback). `force_columns` forces the
    // SoA column paths on (ignoring `ZOEK_SOA_OFF`) so the struct paths — which
    // would index a dropped/empty `ref_sites` — are never taken on the channel
    // rebuild that dropped `ref_sites`.
    prebuilt_site_cols: Option<&'a [SiteCols]>,
    force_columns: bool,
    // F1.b: when `Some`, phase E workers stream LightRef batches into this
    // channel instead of accumulating a per-worker `Vec<LightRef>`. The
    // returned `light_references` is left empty (channel sink drains them).
    light_sender: Option<&'a crossbeam_channel::Sender<Vec<LightRef>>>,
) -> ResolveIntermediate {
    let probe = std::env::var("ZOEK_RESOLVE_PROBE").is_ok();
    // Phase 1.4: GraphSymbol.kind_flags carries the cached classification
    // flags. Phase A reads them directly off the struct (no parallel side
    // vector needed). Hot resolve paths elsewhere also use the field.

    let t_a = std::time::Instant::now();
    // B5: phase C only ever asked `symbols_by_name.contains_key(name)` ("does any
    // symbol carry this name?"). A `name_hash` set answers that with an integer
    // probe and lets phase C avoid reading the site `&str` — same proven-safe
    // rekey as W9b. (This was the lone reader of the old `&str`-keyed map.)
    let mut symbol_name_hashes: AHashSet<u64> = AHashSet::default();
    // W9b: bare_symbols_by_name keyed by name_hash (u64) instead of &str.
    // Phase E hot loop and prefilter probe this per bare site; the u64
    // lookup is ~5x cheaper than the prior string hash + memcmp.
    let mut bare_symbols_by_name: AHashMap<u64, Vec<&GraphSymbol>> = AHashMap::default();
    // W18 / Option B step B3a: keyed by (language_id, name_hash) — the u64
    // name hash precomputed on each symbol/site — so the phase-E pre-filter and
    // worker probe these with an integer key (no `&str` read from the 292B
    // RefSite). Same proven-safe pattern as `bare_symbols_by_name` (W9b).
    let mut bare_symbols_by_language_and_name: AHashMap<(u16, u64), Vec<&GraphSymbol>> =
        AHashMap::default();
    let mut member_symbols_by_language_and_name: AHashMap<(u16, u64), Vec<&GraphSymbol>> =
        AHashMap::default();
    let mut symbols_by_id: AHashMap<&str, &GraphSymbol> = AHashMap::default();
    let mut types_by_name: AHashMap<&str, Vec<&GraphSymbol>> = AHashMap::default();
    let mut members_by_container_and_name: AHashMap<(&str, &str), Vec<&GraphSymbol>> =
        AHashMap::default();
    let mut symbols_by_file_and_name: AHashMap<(&str, &str), Vec<&GraphSymbol>> = AHashMap::default();
    // W18 / Option B step B4: hash-keyed twins of the two member-resolution maps
    // the phase-E worker probes per site. Keyed by precomputed `stable_hash`es
    // (`(container_hash, name_hash)` and `(rel_path_hash, name_hash)`) so the
    // column-only worker can expand receivers without reading the site `&str`s.
    // Same proven-safe rekey pattern as `bare_symbols_by_name` (W9b) / B3a; the
    // invariant gate validates collision-freedom on the corpus. Built alongside
    // the string maps (compute_receiver_resolution's cold path still uses those).
    let mut members_by_container_and_name_h: AHashMap<(u64, u64), Vec<&GraphSymbol>> =
        AHashMap::default();
    let mut symbols_by_file_and_name_h: AHashMap<(u64, u64), Vec<&GraphSymbol>> =
        AHashMap::default();
    // W5: count bare-fallback definitions per (name_hash, rel_path_hash). The
    // phase E hot loop uses this O(1) lookup instead of scanning the per-name
    // candidate Vec with a rel_path filter (was 208K closure samples).
    let mut same_file_bare_count: AHashMap<(u64, u64), u32> = AHashMap::with_capacity(1 << 20);
    for symbol in symbols {
        let flags = symbol.kind_flags;
        symbols_by_id.insert(&symbol.id, symbol);
        symbol_name_hashes.insert(symbol.name_hash);
        if flags & KF_TYPE != 0 {
            types_by_name.entry(&symbol.name).or_default().push(symbol);
        }
        if let Some(container_name) = symbol.container_name.as_deref() {
            members_by_container_and_name
                .entry((container_name, symbol.name.as_str()))
                .or_default()
                .push(symbol);
            members_by_container_and_name_h
                .entry((stable_hash(container_name), symbol.name_hash))
                .or_default()
                .push(symbol);
        }
        if flags & KF_BARE_FB != 0 {
            bare_symbols_by_name
                .entry(symbol.name_hash)
                .or_default()
                .push(symbol);
            bare_symbols_by_language_and_name
                .entry((symbol.language_id, symbol.name_hash))
                .or_default()
                .push(symbol);
            *same_file_bare_count
                .entry((symbol.name_hash, symbol.rel_path_hash))
                .or_default() += 1;
        }
        if flags & KF_MEMBER_FB != 0 {
            member_symbols_by_language_and_name
                .entry((symbol.language_id, symbol.name_hash))
                .or_default()
                .push(symbol);
        }
        symbols_by_file_and_name
            .entry((&symbol.rel_path, &symbol.name))
            .or_default()
            .push(symbol);
        symbols_by_file_and_name_h
            .entry((symbol.rel_path_hash, symbol.name_hash))
            .or_default()
            .push(symbol);
    }
    if probe { eprintln!("[resolve] phase_a={}ms same_file_bare_count_entries={}", t_a.elapsed().as_millis(), same_file_bare_count.len()); }
    // W17 / Option B step B1: de-risk the SoA build cost behind a flag before
    // wiring any consumer. The prior failed SoA attempt paid ~5.2s building
    // per-site columns AFTER parse; the open question is whether interning +
    // a single 38M-site `u32` column can be built in <1s. This block is
    // gated by `ZOEK_SOA_B1` so normal runs, tests, and the invariant gate
    // are untouched (nothing consumes the interner yet). It measures: (a)
    // interner build over all symbol names, (b) the par_iter populate of a
    // `site_name_id` column over every ref_site, (c) hit rate + rough memory.
    if std::env::var("ZOEK_SOA_B1").is_ok() {
        use rayon::prelude::*;
        // Build the string interner (id -> name + hash; for cold-path &str
        // resolution) AND a `name_hash -> id` side map. Dedup is by the
        // precomputed `name_hash` (the W9b-proven key), so the 38M-site
        // `site_name_id` column populate below is a pure u64 probe with zero
        // string hashing — the key finding the prior failed SoA attempt
        // (separate per-site string re-hash) missed.
        let t_int = std::time::Instant::now();
        let mut interner = NameInterner::with_capacity(symbols.len());
        let mut hash_to_id: AHashMap<u64, u32> = AHashMap::with_capacity(symbols.len());
        for symbol in symbols {
            let id = interner.intern(&symbol.name, symbol.name_hash);
            hash_to_id.entry(symbol.name_hash).or_insert(id);
        }
        let build_ms = t_int.elapsed().as_millis();
        let unique = interner.len();
        // Populate via precomputed site.name_hash (no string hashing).
        let t_pop = std::time::Instant::now();
        let site_name_ids: Vec<u32> = ref_sites
            .par_iter()
            .map(|s| hash_to_id.get(&s.name_hash).copied().unwrap_or(NameInterner::MISS))
            .collect();
        let pop_ms = t_pop.elapsed().as_millis();
        // Cross-check: a string-keyed populate (what B0/prior attempt did) to
        // quantify the string-hash overhead we avoid.
        let t_pop_str = std::time::Instant::now();
        let str_hits = ref_sites
            .par_iter()
            .filter(|s| interner.get(&s.name) != NameInterner::MISS)
            .count();
        let pop_str_ms = t_pop_str.elapsed().as_millis();
        let hits = site_name_ids
            .par_iter()
            .filter(|&&id| id != NameInterner::MISS)
            .count();
        let mem_mb = (interner.ids.capacity()
            * (std::mem::size_of::<Box<str>>() + std::mem::size_of::<u32>())
            + interner.hashes.capacity() * std::mem::size_of::<u64>()
            + hash_to_id.capacity() * (std::mem::size_of::<u64>() + std::mem::size_of::<u32>())
            + site_name_ids.capacity() * std::mem::size_of::<u32>())
            / (1024 * 1024);
        eprintln!(
            "[soa-b1] interner_build={build_ms}ms unique_names={unique} \
             populate_by_hash={pop_ms}ms populate_by_str={pop_str_ms}ms \
             sites={} interned_hit={hits} ({:.1}%) approx_mem={mem_mb}MB \
             (str_hits={str_hits})",
            site_name_ids.len(),
            100.0 * hits as f64 / site_name_ids.len().max(1) as f64,
        );
        std::hint::black_box(&site_name_ids);
    }
    let t_b = std::time::Instant::now();
    let import_targets = resolve_import_targets(import_facts, &symbols_by_file_and_name);
    let import_facts_by_file_local = import_facts_by_file_local(import_facts);
    let star_import_facts_by_file = star_import_facts_by_file(import_facts);
    // B4: rel_path_hash -> flattened module_candidate hashes for star imports,
    // so the column-only worker's bare path resolves star candidates without
    // reading `site.rel_path` / `site.name`. Probe pairs `(module_hash,
    // name_hash)` against `symbols_by_file_and_name_h`. Mirrors
    // `star_import_candidates_into` exactly (output dedups by symbol identity).
    let star_module_hashes_by_rel: AHashMap<u64, Vec<u64>> = {
        let mut m: AHashMap<u64, Vec<u64>> = AHashMap::default();
        for (rel, facts) in &star_import_facts_by_file {
            let rel_hash = stable_hash(rel);
            let entry = m.entry(rel_hash).or_default();
            for fact in facts {
                for module_path in &fact.module_candidates {
                    entry.push(stable_hash(module_path));
                }
            }
        }
        m
    };
    let type_facts_by_file_local = type_facts_by_file_local(type_facts);
    let function_return_facts_by_file_name =
        function_return_facts_by_file_name(function_return_facts);
    // W12-Stage 3: 2-level views of (rel_path, name)-keyed maps. Phase E
    // bucket loop / prefilter per-worker file cache look the outer key up
    // once per file, then probe small inner maps by name only — eliminates
    // the tuple hash per site (14-31M probes).
    // W16: inner key is the precomputed FNV-1a name hash (u64) rather than the
    // `&str` name. The hot per-site probes (prefilter 31M, worker 16M) look the
    // inner map up by `site.name_hash` / `site.receiver_name_hash` (already
    // precomputed on RefSite) so each probe is a u64 hash instead of a string
    // hash. Same proven pattern as `bare_symbols_by_name` (W9b). The build pays
    // one `stable_hash(name)` per (rel_path, name) entry (~few M, phase_b only).
    // W18 / Option B step B3a: the OUTER key is now the precomputed
    // `rel_path_hash` (u64) rather than the `&str` rel_path, so the pre-filter
    // and worker look these up by `site.rel_path_hash` (already on RefSite /
    // SiteCols) without reading the path string. Inner key remains the W16
    // name hash. `stable_hash(rp)` here matches `site.rel_path_hash` because
    // both hash the same path string with the same FNV-1a (extract_ref_sites).
    let import_targets_by_rel: AHashMap<u64, AHashMap<u64, &[&GraphSymbol]>> = {
        let mut by_rel: AHashMap<u64, AHashMap<u64, &[&GraphSymbol]>> = AHashMap::default();
        for ((rp, nm), targets) in &import_targets {
            by_rel
                .entry(stable_hash(rp))
                .or_default()
                .insert(stable_hash(nm), targets.as_slice());
        }
        by_rel
    };
    let import_facts_by_rel: AHashMap<u64, AHashSet<u64>> = {
        let mut by_rel: AHashMap<u64, AHashSet<u64>> = AHashMap::default();
        for ((rp, nm), _) in &import_facts_by_file_local {
            by_rel.entry(stable_hash(rp)).or_default().insert(stable_hash(nm));
        }
        by_rel
    };
    let type_facts_by_rel: AHashMap<u64, AHashSet<u64>> = {
        let mut by_rel: AHashMap<u64, AHashSet<u64>> = AHashMap::default();
        for ((rp, nm), _) in &type_facts_by_file_local {
            by_rel.entry(stable_hash(rp)).or_default().insert(stable_hash(nm));
        }
        by_rel
    };
    if probe { eprintln!("[resolve] phase_b={}ms", t_b.elapsed().as_millis()); }
    // Phase 1.5A pre-cache: build site language_id once (parallel) so the
    // pre-filter and phase E workers can do O(1) array lookups instead of
    // repeatedly running compute_language_id (a ~15-arm string match).
    //
    // W18 / Option B step B2: build the dense `SiteCols` column instead of the
    // old `site_language_ids: Vec<u16>`. This widens an existing full-ref_sites
    // par_iter (which already paid the AoS traversal for `s.language`) to also
    // copy the precomputed hash/enum fields the hot passes read — so the column
    // build adds only the extra column writes, not a fresh 38M-struct scan.
    //
    // B5: moved ahead of phase C (was between phase D and the pre-filter) so the
    // phase-C scan can read `SiteCols` too. The build depends only on `ref_sites`
    // (all fields precomputed at parse), so the move is order-safe; the total
    // work is unchanged, only its position.
    let t_slang = std::time::Instant::now();
    // B6 stage-5d: use the pre-built `SiteCols` when the caller built it before
    // resolve (channel rebuild that dropped `ref_sites`); otherwise build it
    // here from `ref_sites` (behaviour-identical to the prior inline build).
    let site_cols_owned: Vec<SiteCols>;
    let site_cols: &[SiteCols] = match prebuilt_site_cols {
        Some(c) => c,
        None => {
            site_cols_owned = build_site_cols(ref_sites);
            &site_cols_owned
        }
    };
    if probe { eprintln!("[resolve] site_cols_build={}ms n={}", t_slang.elapsed().as_millis(), site_cols.len()); }
    let t_c = std::time::Instant::now();
    // B6 stage-5d: site count from `site_cols` (full length) — `ref_sites` may be
    // dropped/empty on the channel rebuild.
    let phase_c_total = site_cols.len();
    let phase_c_workers = graph_worker_count(phase_c_total.max(1));
    // B5: column-only phase C reads `SiteCols`. Promoted to the default after
    // the invariant held (14,372,638) and phase_c measured −32% (2408→1636ms,
    // paired). `ZOEK_SOA_OFF` reverts to the struct read for A/B / debugging.
    // Both paths probe the name-hash set and key the "may"/"likely" maps
    // identically, so only the per-site field read differs (48B vs 292B).
    let soa_b5 = force_columns || std::env::var("ZOEK_SOA_OFF").is_err();
    let symbol_name_hashes_ref = &symbol_name_hashes;
    let site_cols_ref = site_cols;
    let phase_c_outputs = if phase_c_total == 0 || phase_c_workers <= 1 {
        vec![phase_c_process_chunk(
            ref_sites,
            site_cols_ref,
            0,
            phase_c_total,
            symbol_name_hashes_ref,
            soa_b5,
            recon.and_then(|r| r.file),
        )]
    } else {
        use rayon::prelude::*;
        let chunks_per_worker = 8usize;
        let target_chunks = phase_c_workers.saturating_mul(chunks_per_worker).max(phase_c_workers);
        let chunk_size = phase_c_total.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize)> = (0..)
            .map(|i| (i * chunk_size, ((i + 1) * chunk_size).min(phase_c_total)))
            .take_while(|(s, _)| *s < phase_c_total)
            .collect();
        ranges
            .into_par_iter()
            .map(|(start, end)| {
                phase_c_process_chunk(
                    ref_sites,
                    site_cols_ref,
                    start,
                    end,
                    symbol_name_hashes_ref,
                    soa_b5,
                    recon.and_then(|r| r.file),
                )
            })
            .collect()
    };
    // B5: "may" maps keyed by name_hash (u64), consumed in phase D via
    // `symbol.name_hash`. Was `&str` keyed by the site name.
    let mut bare_usage_may_by_name: HashMap<u64, usize> = HashMap::new();
    let mut bare_call_may_by_name: HashMap<u64, usize> = HashMap::new();
    let mut member_usage_may_by_name: HashMap<u64, usize> = HashMap::new();
    let mut member_call_may_by_name: HashMap<u64, usize> = HashMap::new();
    let mut bare_usage_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize> =
        HashMap::new();
    let mut bare_call_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize> = HashMap::new();
    let mut member_usage_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize> =
        HashMap::new();
    let mut member_call_likely_by_scope_and_name: HashMap<(u64, u64, u64), usize> =
        HashMap::new();
    let mut bare_likely_sites_by_scope_and_name: HashMap<(u64, u64, u64), Vec<u32>> =
        HashMap::new();
    let mut member_likely_sites_by_scope_and_name: HashMap<(u64, u64, u64), Vec<u32>> =
        HashMap::new();
    for (
        w_bare_usage_may,
        w_bare_call_may,
        w_member_usage_may,
        w_member_call_may,
        w_bare_usage_likely,
        w_bare_call_likely,
        w_member_usage_likely,
        w_member_call_likely,
        w_bare_likely_sites,
        w_member_likely_sites,
    ) in phase_c_outputs
    {
        for (k, v) in w_bare_usage_may {
            *bare_usage_may_by_name.entry(k).or_default() += v;
        }
        for (k, v) in w_bare_call_may {
            *bare_call_may_by_name.entry(k).or_default() += v;
        }
        for (k, v) in w_member_usage_may {
            *member_usage_may_by_name.entry(k).or_default() += v;
        }
        for (k, v) in w_member_call_may {
            *member_call_may_by_name.entry(k).or_default() += v;
        }
        for (k, v) in w_bare_usage_likely {
            *bare_usage_likely_by_scope_and_name.entry(k).or_default() += v;
        }
        for (k, v) in w_bare_call_likely {
            *bare_call_likely_by_scope_and_name.entry(k).or_default() += v;
        }
        for (k, v) in w_member_usage_likely {
            *member_usage_likely_by_scope_and_name.entry(k).or_default() += v;
        }
        for (k, v) in w_member_call_likely {
            *member_call_likely_by_scope_and_name.entry(k).or_default() += v;
        }
        for (k, sites) in w_bare_likely_sites {
            bare_likely_sites_by_scope_and_name
                .entry(k)
                .or_default()
                .extend(sites);
        }
        for (k, sites) in w_member_likely_sites {
            member_likely_sites_by_scope_and_name
                .entry(k)
                .or_default()
                .extend(sites);
        }
    }

    if probe { eprintln!("[resolve] phase_c={}ms", t_c.elapsed().as_millis()); }
    let t_d = std::time::Instant::now();
    // Pre-size to symbol count; phase D inserts one entry per symbol, and
    // phase E reads (and may add ~4M target entries) on top. Avoids the
    // ~20 incremental rehashes during phase D's 4M+ inserts.
    let mut counts: HashMap<String, GraphCount> = HashMap::with_capacity(symbols.len());
    for symbol in symbols {
        let count = counts.entry(symbol.id.clone()).or_default();
        // B5: the "may" maps are now keyed by name_hash; look up by the
        // symbol's precomputed name_hash (was `symbol.name.as_str()`).
        count.usage_may += bare_usage_may_by_name
            .get(&symbol.name_hash)
            .copied()
            .unwrap_or(0);
        count.calls_in_may += bare_call_may_by_name
            .get(&symbol.name_hash)
            .copied()
            .unwrap_or(0);
        count.usage_may += member_usage_may_by_name
            .get(&symbol.name_hash)
            .copied()
            .unwrap_or(0);
        count.calls_in_may += member_call_may_by_name
            .get(&symbol.name_hash)
            .copied()
            .unwrap_or(0);
    }
    if probe { eprintln!("[resolve] phase_d={}ms", t_d.elapsed().as_millis()); }
    // Phase E pre-filter v2: drop sites that cannot emit a ref. Matches
    // ALL the worker's productive paths including unique_member /
    // unique_bare candidate via the *_by_language_and_name maps. References
    // count is unchanged after pre-filter (validated by test suite).
    let t_pf = std::time::Instant::now();
    let owned_filtered_indices: Vec<u32>;
    let phase_e_indices_effective: Option<&[u32]> = match phase_e_indices {
        Some(existing) => Some(existing),
        None => {
            use rayon::prelude::*;
            let chunks_per_worker = 8usize;
            let total = site_cols.len(); // B6 stage-5d: ref_sites may be dropped
            let workers = graph_resolve_e_worker_count(total.max(1));
            let target_chunks = workers.saturating_mul(chunks_per_worker).max(workers);
            let chunk_size = total.div_ceil(target_chunks).max(1);
            let ranges: Vec<(usize, usize)> = (0..)
                .map(|i| (i * chunk_size, ((i + 1) * chunk_size).min(total)))
                .take_while(|(s, _)| *s < total)
                .collect();
            let types_by_name_pf = &types_by_name;
            // W12-Stage 3: 2-level views for per-worker file-local lookups.
            // Prefilter ranges hit sites in parse-chunk order which is mostly
            // file-grouped → cache hit rate ~99%. Inner contains_key on a
            // single string replaces (rel_path, name) tuple probe.
            let import_targets_by_rel_pf = &import_targets_by_rel;
            let import_facts_by_rel_pf = &import_facts_by_rel;
            let type_facts_by_rel_pf = &type_facts_by_rel;
            let bare_symbols_pf = &bare_symbols_by_name;
            let bare_lang_pf = &bare_symbols_by_language_and_name;
            let member_lang_pf = &member_symbols_by_language_and_name;
            let star_imports_pf = &star_import_facts_by_file;
            // W18 / Option B step B3b: the pre-filter inner loop reads ONLY
            // `site_cols[i]` (48B dense) and never touches the ~292B `RefSite`
            // struct — the whole point of the SoA migration. Promoted to the
            // default (W18 measured −83%, 5.8x). `ZOEK_SOA_OFF` reverts to the
            // W16 struct-reading path for paired ON/OFF measurement.
            let soa_b3 = force_columns || std::env::var("ZOEK_SOA_OFF").is_err();
            let mut chunk_outputs: Vec<Vec<u32>> = if soa_b3 {
                let site_cols_pf = site_cols;
                // Side sets so the column path needs no `&str`: self/cls and the
                // type-name / star-import-file probes the default path does as
                // string lookups become precomputed-hash probes. Productivity
                // is a superset of the default path (a hash collision can only
                // *add* a candidate, never drop a real one), so the reference
                // count is unchanged — validated by the invariant gate.
                let self_hash = stable_hash("self");
                let cls_hash = stable_hash("cls");
                let type_recv_hashes: AHashSet<u64> =
                    types_by_name_pf.keys().map(|&k| stable_hash(k)).collect();
                let star_rel_hashes: AHashSet<u64> =
                    star_imports_pf.keys().map(|&k| stable_hash(k)).collect();
                ranges
                    .into_par_iter()
                    .map(|(start, end)| {
                        let mut buf: Vec<u32> = Vec::with_capacity((end - start) / 4);
                        let mut cached_rel_hash: u64 = u64::MAX;
                        let mut cached_imports: Option<&AHashMap<u64, &[&GraphSymbol]>> = None;
                        let mut cached_import_facts: Option<&AHashSet<u64>> = None;
                        let mut cached_type_facts: Option<&AHashSet<u64>> = None;
                        let mut cached_has_star = false;
                        for i in start..end {
                            // The only per-site memory read: a 32B SiteCols copy.
                            let c = site_cols_pf[i];
                            if c.flags & SITE_FLAG_IS_DEFINITION != 0 {
                                continue;
                            }
                            let access_id = c.access_kind_id;
                            let language_id = c.language_id;
                            if c.rel_path_hash != cached_rel_hash {
                                cached_rel_hash = c.rel_path_hash;
                                cached_imports = import_targets_by_rel_pf.get(&cached_rel_hash);
                                cached_import_facts = import_facts_by_rel_pf.get(&cached_rel_hash);
                                cached_type_facts = type_facts_by_rel_pf.get(&cached_rel_hash);
                                cached_has_star = star_rel_hashes.contains(&cached_rel_hash);
                            }
                            let productive = if access_id == ACCESS_KIND_MEMBER {
                                if c.flags & SITE_FLAG_HAS_RECEIVER != 0 {
                                    let rhash = c.receiver_name_hash;
                                    let has_receiver_match = rhash == self_hash
                                        || rhash == cls_hash
                                        || type_recv_hashes.contains(&rhash)
                                        || cached_imports.is_some_and(|m| m.contains_key(&rhash))
                                        || cached_import_facts.is_some_and(|s| s.contains(&rhash))
                                        || cached_type_facts.is_some_and(|s| s.contains(&rhash));
                                    has_receiver_match
                                        || member_lang_pf.contains_key(&(language_id, c.name_hash))
                                } else {
                                    false
                                }
                            } else if access_id == ACCESS_KIND_BARE {
                                bare_symbols_pf.contains_key(&c.name_hash)
                                    || cached_imports.is_some_and(|m| m.contains_key(&c.name_hash))
                                    || cached_has_star
                                    || bare_lang_pf.contains_key(&(language_id, c.name_hash))
                            } else {
                                false
                            };
                            if productive {
                                buf.push(i as u32);
                            }
                        }
                        buf
                    })
                    .collect()
            } else {
                ranges
                    .into_par_iter()
                    .map(|(start, end)| {
                        let mut buf: Vec<u32> = Vec::with_capacity((end - start) / 4);
                        // W12-Stage 3: per-worker file-local 3-map cache.
                        // ref_sites are parse-chunk grouped (atomic FileGraph
                        // ingest) so adjacent indices share rel_path with ~99%
                        // probability inside a worker range.
                        let mut cached_rel_hash: u64 = u64::MAX;
                        let mut cached_imports: Option<&AHashMap<u64, &[&GraphSymbol]>> = None;
                        let mut cached_import_facts: Option<&AHashSet<u64>> = None;
                        let mut cached_type_facts: Option<&AHashSet<u64>> = None;
                        for i in start..end {
                            let site = &ref_sites[i];
                            if site.is_definition {
                                continue;
                            }
                            // W12: precomputed `access_kind_id` saves 2 memcmps
                            // per site (member/bare checks) × 31M sites.
                            let access_id = site.access_kind_id;
                            let language_id = site_cols[i].language_id;
                            if site.rel_path_hash != cached_rel_hash {
                                cached_rel_hash = site.rel_path_hash;
                                cached_imports = import_targets_by_rel_pf.get(&cached_rel_hash);
                                cached_import_facts = import_facts_by_rel_pf.get(&cached_rel_hash);
                                cached_type_facts = type_facts_by_rel_pf.get(&cached_rel_hash);
                            }
                            let productive = if access_id == ACCESS_KIND_MEMBER {
                                if let Some(receiver) = site.receiver_name.as_deref() {
                                    // W16: file-local probes keyed by precomputed
                                    // receiver_name_hash (u64) instead of `receiver`.
                                    let rhash = site.receiver_name_hash;
                                    let has_receiver_match = matches!(receiver, "self" | "cls")
                                        || types_by_name_pf.contains_key(receiver)
                                        || cached_imports
                                            .is_some_and(|m| m.contains_key(&rhash))
                                        || cached_import_facts
                                            .is_some_and(|s| s.contains(&rhash))
                                        || cached_type_facts.is_some_and(|s| s.contains(&rhash));
                                    has_receiver_match
                                        || member_lang_pf.contains_key(&(language_id, site.name_hash))
                                } else {
                                    false
                                }
                            } else if access_id == ACCESS_KIND_BARE {
                                bare_symbols_pf.contains_key(&site.name_hash)
                                    || cached_imports.is_some_and(|m| m.contains_key(&site.name_hash))
                                    || star_imports_pf.contains_key(site.rel_path.as_str())
                                    || bare_lang_pf.contains_key(&(language_id, site.name_hash))
                            } else {
                                false
                            };
                            if productive {
                                buf.push(i as u32);
                            }
                        }
                        buf
                    })
                    .collect()
            };
            let total_filtered: usize = chunk_outputs.iter().map(|c| c.len()).sum();
            let mut indices: Vec<u32> = Vec::with_capacity(total_filtered);
            for c in &mut chunk_outputs {
                indices.append(c);
            }
            owned_filtered_indices = indices;
            Some(owned_filtered_indices.as_slice())
        }
    };
    if std::env::var("ZOEK_RESOLVE_PROBE").is_ok() {
        let total_pre = site_cols.len(); // B6 stage-5d: ref_sites may be dropped
        let total_post = phase_e_indices_effective.map(|i| i.len()).unwrap_or(total_pre);
        eprintln!(
            "[resolve] phase_e_prefilter={}ms before={total_pre} after={total_post}",
            t_pf.elapsed().as_millis()
        );
    }
    let t_e = std::time::Instant::now();

    let total_refs = phase_e_indices_effective.map(|i| i.len()).unwrap_or(site_cols.len());
    // Option C Stage 1: bucket phase E site indices by file (rel_path_hash).
    // Rayon dispatch now chunks buckets keeping each file's sites together —
    // foundation for stages 2-4 (per-file receiver cache, per-file local
    // sub-maps, per-file mini-context). On its own this is a pure refactor.
    let phase_e_buckets = build_phase_e_file_buckets(site_cols, phase_e_indices_effective);
    if probe {
        let avg = if phase_e_buckets.is_empty() {
            0
        } else {
            total_refs / phase_e_buckets.len()
        };
        eprintln!(
            "[resolve] phase_e_buckets={} avg_sites/bucket={avg}",
            phase_e_buckets.len()
        );
    }
    let worker_count = graph_resolve_e_worker_count(total_refs.max(1));
    let spill_threshold = std::env::var("ZOEK_RESOLVE_SPILL_REFS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1_000_000);
    let spill_dir = std::env::var("ZOEK_RESOLVE_SPILL_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("zoek-rs-resolve-spill"));
    let _ = fs::create_dir_all(&spill_dir);
    let spill_dir_ref = &spill_dir;
    // W18 / Option B step B4: the phase-E worker inner loop reads ONLY
    // `site_cols[idx]` (48B) per site and never the ~292B `RefSite` (the SoA
    // goal validated 5.8x on the pre-filter in B3). The struct is touched only
    // on the rare receiver cache-miss (to run the validated string-keyed
    // `compute_receiver_resolution` once per distinct receiver). Promoted to
    // the default (W19 measured phase_e −16%, paired). `ZOEK_SOA_OFF` reverts
    // to the W16 struct path for paired ON/OFF measurement.
    let soa_b4 = force_columns || std::env::var("ZOEK_SOA_OFF").is_err();
    // B4 column pre-screen side-set: receiver-name hashes that match a type
    // name. Mirrors the struct path's `types_by_name.contains_key(receiver)`
    // without a `&str` read. A hash collision can only *admit* a receiver to
    // the (rare) compute path, which then re-validates by string — so the
    // reference count is unchanged (invariant gate).
    let type_recv_hashes: AHashSet<u64> = if soa_b4 {
        types_by_name.keys().map(|&k| stable_hash(k)).collect()
    } else {
        AHashSet::default()
    };
    let type_recv_hashes_ref = &type_recv_hashes;
    let self_hash = stable_hash("self");
    let cls_hash = stable_hash("cls");
    let process_chunk = |buckets_slice: &[PhaseEFileBucket], worker_id: usize| -> io::Result<(
        HashMap<String, GraphCount>,
        AHashSet<u64>,
        AHashSet<u64>,
        Vec<GraphReference>,
        AHashSet<u64>,
        Vec<PathBuf>,
        Vec<LightRef>,
        AHashMap<u64, usize>,
    )> {
        // hashbrown::HashMap exposes `entry_ref` (probe by &str without
        // pre-allocating a String key). std::HashMap does not.
        // Pre-size: empirically ~36% of sites in a chunk push a reference here.
        // Cap at spill_threshold to avoid wasted reservation when chunk is huge.
        let chunk_site_count: usize = buckets_slice.iter().map(|b| b.indices.len()).sum();
        let chunk_estimate = (chunk_site_count / 3).min(spill_threshold).max(64);
        // Phase 3 aggressive: per-worker counts keyed by u64 (GraphSymbol.id_u64)
        // instead of String. Eliminates per-call string hash + alloc. Merge
        // step at end converts back to "sym:HEX16" strings via id_to_string.
        let mut counts: hashbrown::HashMap<u64, GraphCount> = hashbrown::HashMap::new();
        // Track u64 → String for end-of-chunk conversion to global counts.
        // Each unique target contributes one entry; ~5M total across all
        // workers vs 14M (site,target) pairs without the cache.
        let mut id_to_string: AHashMap<u64, String> = AHashMap::default();
        // Phase 3 (sizing): pre-allocate the three edge-key dedup sets to a
        // multiple of expected unique edges per chunk. Avoids ~20 growths each
        // (each growth rehashes everything). 2x chunk_estimate covers typical
        // candidate fan-out per site.
        let dedup_cap = chunk_estimate.saturating_mul(2).max(64);
        let mut counted_likely: AHashSet<u64> = AHashSet::with_capacity(dedup_cap);
        let mut counted_exact: AHashSet<u64> = AHashSet::with_capacity(dedup_cap);
        // LightRef is the in-flight representation during the resolve loop:
        // ~24 bytes per record vs ~200 for GraphReference (8 String fields
        // collapse to a single u32 site_idx and small enums). At the end of
        // the worker we materialize once into Vec<GraphReference> so the
        // existing downstream path (phase F, write, spill) is unchanged.
        let mut light_refs: Vec<LightRef> = Vec::with_capacity(chunk_estimate);
        let mut dedup: AHashSet<u64> = AHashSet::with_capacity(dedup_cap);
        // F1.a: slim per-target tally built incrementally as lights are pushed.
        // Replaces the previous rescan of all 14M LightRefs at phase F entry.
        let mut local_target_tally: AHashMap<u64, usize> = AHashMap::default();
        let mut spill_paths: Vec<PathBuf> = Vec::new();
        // Reused per-site candidate buffers; capacity is retained across iterations.
        let mut fallback_buf: Vec<&GraphSymbol> = Vec::new();
        let mut exact_buf: Vec<MemberExactCandidate<'_>> = Vec::new();
        let mut star_imported_buf: Vec<&GraphSymbol> = Vec::new();
        // Phase 3 (Receiver Memoization): cache receiver-side resolution per
        // (receiver, enclosing_id). W9a moved the key to a u64 triple
        // (rel_path, receiver, enclosing). W12-Stage 2 narrows it to a u64
        // pair: the bucket loop resets the cache when rel_path changes, so
        // rel_path is constant within one file's run — dropping it from the
        // key shrinks the cache (per-file working set ~50-200 entries vs
        // chunk-wide ~10K+) and tightens probe hash work.
        let mut receiver_cache: AHashMap<(u64, u64), ReceiverResolution<'_>> =
            AHashMap::default();
        // B4: the all-hash receiver cache used by the column-only path. Only
        // one of the two caches is populated per run (gated by `soa_b4`).
        let mut receiver_cache_cols: AHashMap<(u64, u64), ReceiverResolutionCols> =
            AHashMap::default();
        let mut current_file_hash: u64 = u64::MAX;
        // W12-Stage 3: file-local views updated on bucket (file) transition.
        // `None` if the current file has no entries in the corresponding map.
        let mut current_file_imports: Option<&AHashMap<u64, &[&GraphSymbol]>> = None;
        let mut current_file_import_facts: Option<&AHashSet<u64>> = None;
        let mut current_file_type_facts: Option<&AHashSet<u64>> = None;
        let mut maybe_spill = |refs: &mut Vec<GraphReference>, paths: &mut Vec<PathBuf>| -> io::Result<()> {
            if refs.len() < spill_threshold {
                return Ok(());
            }
            let path = spill_dir_ref.join(format!(
                "phase_e_w{}_p{}.bin",
                worker_id,
                paths.len()
            ));
            let f = fs::File::create(&path)?;
            let mut w = std::io::BufWriter::with_capacity(1024 * 1024, f);
            bincode::serialize_into(&mut w, refs as &Vec<GraphReference>).map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("refs spill: {e}"))
            })?;
            w.flush()?;
            refs.clear();
            paths.push(path);
            Ok(())
        };
        // Option C Stage 1: outer iteration is now bucket-by-bucket (one file
        // at a time) via flat_map. Indices are pre-resolved at bucket-build
        // time so the per-site `match phase_e_indices_effective { ... }`
        // dispatch is gone. Stages 2+ will add per-bucket prelude work
        // (per-file receiver cache, per-file local sub-maps).
        for site_idx in buckets_slice
            .iter()
            .flat_map(|b| b.indices.iter().copied())
        {
            // B4: the 48B column is the only guaranteed per-site read. The
            // 292B `RefSite` is fetched only inside the `soa_b4` cache-miss
            // closure below (rare) or, with `soa_b4` off, once per site.
            let c = site_cols[site_idx as usize];
            // W12-Stage 2/3: per-file receiver cache scope + file-local views,
            // refreshed on file (rel_path_hash) change.
            if c.rel_path_hash != current_file_hash {
                receiver_cache.clear();
                receiver_cache_cols.clear();
                current_file_hash = c.rel_path_hash;
                // W18 / B3a: import_*_by_rel outer key is now rel_path_hash.
                current_file_imports = import_targets_by_rel.get(&current_file_hash);
                current_file_import_facts = import_facts_by_rel.get(&current_file_hash);
                current_file_type_facts = type_facts_by_rel.get(&current_file_hash);
            }
            if c.flags & SITE_FLAG_IS_DEFINITION != 0 {
                continue;
            }
            // W12: precomputed access_kind_id replaces 2 memcmps per site.
            let is_member = c.access_kind_id == ACCESS_KIND_MEMBER;
            let is_bare = c.access_kind_id == ACCESS_KIND_BARE;
            fallback_buf.clear();
            exact_buf.clear();
            // ===== HEAD (gated): fill fallback_buf / exact_buf / star_imported_buf =====
            if soa_b4 {
                // Column-only candidate gathering: SiteCols + hash-keyed maps.
                if is_member {
                    if c.flags & SITE_FLAG_HAS_RECEIVER != 0 {
                        let key = (c.receiver_name_hash, c.enclosing_id);
                        let res = receiver_cache_cols.entry(key).or_insert_with(|| {
                            // Pre-screen entirely on hashes (no RefSite read):
                            // mirrors compute_receiver_resolution's has_any guard.
                            // Only a real candidate reaches the struct load.
                            let rhash = c.receiver_name_hash;
                            let is_self = rhash == self_hash || rhash == cls_hash;
                            if !is_self
                                && !type_recv_hashes_ref.contains(&rhash)
                                && !current_file_imports
                                    .is_some_and(|m| m.contains_key(&rhash))
                                && !current_file_import_facts
                                    .is_some_and(|s| s.contains(&rhash))
                                && !current_file_type_facts
                                    .is_some_and(|s| s.contains(&rhash))
                            {
                                return ReceiverResolutionCols {
                                    has_any: false,
                                    self_container_hash: None,
                                    self_type: None,
                                    type_targets: Vec::new(),
                                    import_modules: Vec::new(),
                                };
                            }
                            // B6 stage-4/5c: rebuild `receiver` + `rel_path` from
                            // the per-site id columns when present (toward
                            // dropping Vec<RefSite>). String-keyed intern + the
                            // file_id round-trip are byte-identical to the
                            // RefSite reads. When `recon`/`recon.file` is None
                            // (incremental/legacy/fallback) the site is read.
                            let (receiver, rel_path): (&str, &str) = match recon {
                                Some(r) => {
                                    let receiver = r
                                        .interner
                                        .name(r.receiver_name_ids[site_idx as usize])
                                        .unwrap_or("");
                                    match r.file {
                                        Some((ft, file_ids)) => (
                                            receiver,
                                            ft.get_path(file_ids[site_idx as usize]).unwrap_or(""),
                                        ),
                                        None => {
                                            let site = &ref_sites[site_idx as usize];
                                            (receiver, site.rel_path.as_str())
                                        }
                                    }
                                }
                                None => {
                                    let site = &ref_sites[site_idx as usize];
                                    (
                                        site.receiver_name.as_deref().unwrap_or(""),
                                        site.rel_path.as_str(),
                                    )
                                }
                            };
                            // B6 stage-3: rebuild the enclosing id string (cold,
                            // once per file cache-miss) from the column u64.
                            let enclosing_str = enclosing_id_to_string(c.enclosing_id);
                            let res = compute_receiver_resolution(
                                rel_path,
                                receiver,
                                enclosing_str.as_deref(),
                                &symbols_by_id,
                                &types_by_name,
                                &import_targets,
                                &import_facts_by_file_local,
                                &type_facts_by_file_local,
                                &symbols_by_file_and_name,
                                &function_return_facts_by_file_name,
                                hierarchy_facts,
                            );
                            receiver_resolution_to_cols(&res)
                        });
                        expand_receiver_for_name_cols(
                            res,
                            c.name_hash,
                            &members_by_container_and_name_h,
                            &symbols_by_file_and_name_h,
                            &mut fallback_buf,
                            &mut exact_buf,
                        );
                    }
                } else if let Some(bare) = bare_symbols_by_name.get(&c.name_hash) {
                    fallback_buf.extend(bare.iter().copied());
                }
                if is_bare {
                    star_import_candidates_into_cols(
                        c.rel_path_hash,
                        c.name_hash,
                        &star_module_hashes_by_rel,
                        &symbols_by_file_and_name_h,
                        &mut star_imported_buf,
                    );
                } else {
                    star_imported_buf.clear();
                }
            } else {
                // Struct path (default): read RefSite fields + string-keyed maps.
                let site = &ref_sites[site_idx as usize];
                if is_member {
                    if let Some(receiver) = site.receiver_name.as_deref() {
                        let key = (site.receiver_name_hash, site.enclosing_id);
                        let res = receiver_cache.entry(key).or_insert_with(|| {
                            let is_self = matches!(receiver, "self" | "cls");
                            if !is_self {
                                let rhash = site.receiver_name_hash;
                                let could_resolve = types_by_name.contains_key(receiver)
                                    || current_file_imports
                                        .is_some_and(|m| m.contains_key(&rhash))
                                    || current_file_import_facts
                                        .is_some_and(|s| s.contains(&rhash))
                                    || current_file_type_facts
                                        .is_some_and(|s| s.contains(&rhash));
                                if !could_resolve {
                                    return ReceiverResolution {
                                        has_any: false,
                                        self_container: None,
                                        self_type_symbol: None,
                                        type_targets: Vec::new(),
                                        import_facts: Vec::new(),
                                    };
                                }
                            }
                            // B6 stage-3: rebuild the enclosing id string (cold,
                            // once per file cache-miss) from the stored u64.
                            let enclosing_str = enclosing_id_to_string(site.enclosing_id);
                            compute_receiver_resolution(
                                site.rel_path.as_str(),
                                receiver,
                                enclosing_str.as_deref(),
                                &symbols_by_id,
                                &types_by_name,
                                &import_targets,
                                &import_facts_by_file_local,
                                &type_facts_by_file_local,
                                &symbols_by_file_and_name,
                                &function_return_facts_by_file_name,
                                hierarchy_facts,
                            )
                        });
                        expand_receiver_for_name(
                            res,
                            site.name.as_str(),
                            &members_by_container_and_name,
                            &symbols_by_file_and_name,
                            &mut fallback_buf,
                            &mut exact_buf,
                        );
                    }
                } else if let Some(bare) = bare_symbols_by_name.get(&site.name_hash) {
                    fallback_buf.extend(bare.iter().copied());
                }
                if is_bare {
                    star_import_candidates_into(
                        site,
                        &star_import_facts_by_file,
                        &symbols_by_file_and_name,
                        &mut star_imported_buf,
                    );
                } else {
                    star_imported_buf.clear();
                }
            }
            // ===== TAIL (shared): reads only the 48B column `c`. =====
            let fallback_candidates: &[&GraphSymbol] = &fallback_buf;
            // W12-Stage 3: file-local probe keyed by name_hash (B3a outer key).
            let imported_candidates: &[&GraphSymbol] = if is_bare {
                current_file_imports
                    .and_then(|m| m.get(&c.name_hash).copied())
                    .unwrap_or(&[])
            } else {
                &[]
            };
            let star_imported_candidates: &[&GraphSymbol] =
                if is_bare { star_imported_buf.as_slice() } else { &[] };
            let unique_member_candidate = if is_member
                && c.flags & SITE_FLAG_IS_IMPORT_CONTEXT == 0
                && c.flags & SITE_FLAG_HAS_RECEIVER != 0
                && fallback_candidates.is_empty()
            {
                unique_symbol_by_language_and_name(
                    &member_symbols_by_language_and_name,
                    c.language_id,
                    c.name_hash,
                )
            } else {
                None
            };
            if fallback_candidates.is_empty()
                && imported_candidates.is_empty()
                && star_imported_candidates.is_empty()
                && unique_member_candidate.is_none()
            {
                continue;
            }
            // B4: site-invariant partial hash precomputed into the column
            // (byte-identical to the old per-site `site_partial_hash`).
            let site_partial = c.site_partial;
            if is_member {
                for target in fallback_candidates.iter() {
                    let edge_key = edge_key_from_partial_u64(site_partial, target.id_u64);
                    add_resolution_count(
                        &mut counts,
                        &mut id_to_string,
                        &mut counted_likely,
                        &mut counted_exact,
                        c.edge_kind_id,
                        target,
                        BOUND_MAY,
                        true,
                        true,
                        edge_key,
                    );
                }
                for candidate in exact_buf.drain(..) {
                    let edge_key = edge_key_from_partial_u64(site_partial, candidate.target.id_u64);
                    add_resolution_count(
                        &mut counts,
                        &mut id_to_string,
                        &mut counted_likely,
                        &mut counted_exact,
                        c.edge_kind_id,
                        candidate.target,
                        BOUND_MAY | BOUND_MUST,
                        true,
                        true,
                        edge_key,
                    );
                    let _ = push_light_resolved_reference(
                        &mut light_refs,
                        &mut dedup,
                        Some(&mut local_target_tally),
                        light_sender,
                        site_idx,
                        candidate.target,
                        BOUND_MAY | BOUND_MUST,
                        LightConfidence::Exact,
                        provenance_from_str(candidate.provenance),
                        edge_key,
                    );
                }
                if let Some(target) = unique_member_candidate {
                    let edge_key = edge_key_from_partial_u64(site_partial, target.id_u64);
                    add_resolution_count(
                        &mut counts,
                        &mut id_to_string,
                        &mut counted_likely,
                        &mut counted_exact,
                        c.edge_kind_id,
                        target,
                        BOUND_MAY,
                        true,
                        true,
                        edge_key,
                    );
                    let _ = push_light_resolved_reference(
                        &mut light_refs,
                        &mut dedup,
                        Some(&mut local_target_tally),
                        light_sender,
                        site_idx,
                        target,
                        BOUND_MAY,
                        LightConfidence::Possible,
                        LightProvenance::UniqueName,
                        edge_key,
                    );
                }
                continue;
            }
            // W2/W5: file-locality count via precomputed (name_hash, rel_path_hash)
            // table. Replaces the prior per-site filter over fallback_candidates
            // (208K closure samples). For bare sites, fallback_candidates is
            // `bare_symbols_by_name[name]`, so counting bare-fb symbols with
            // matching name + file is equivalent. Member sites already
            // `continue` above, so this branch only runs for bare.
            let site_rel_path_hash = c.rel_path_hash;
            let same_file_count = same_file_bare_count
                .get(&(c.name_hash, site_rel_path_hash))
                .copied()
                .unwrap_or(0) as usize;
            let unique_bare_candidate = if is_bare
                && c.flags & SITE_FLAG_IS_IMPORT_CONTEXT == 0
                && same_file_count == 0
                && imported_candidates.is_empty()
                && star_imported_candidates.is_empty()
            {
                unique_symbol_by_language_and_name(
                    &bare_symbols_by_language_and_name,
                    c.language_id,
                    c.name_hash,
                )
            } else {
                None
            };
            let import_is_exact = !imported_candidates.is_empty()
                && imported_candidates.len() == 1
                && same_file_count == 0;
            for target in imported_candidates.iter() {
                let bound_mask = if import_is_exact {
                    BOUND_MAY | BOUND_MUST
                } else {
                    BOUND_MAY
                };
                let fallback_already_counts_may =
                    is_bare && target.name_hash == c.name_hash;
                let edge_key = edge_key_from_partial_u64(site_partial, target.id_u64);
                add_resolution_count(
                    &mut counts,
                    &mut id_to_string,
                    &mut counted_likely,
                    &mut counted_exact,
                    c.edge_kind_id,
                    target,
                    bound_mask,
                    fallback_already_counts_may,
                    true,
                    edge_key,
                );
                if import_is_exact {
                    let _ = push_light_resolved_reference(
                        &mut light_refs,
                        &mut dedup,
                        Some(&mut local_target_tally),
                        light_sender,
                        site_idx,
                        target,
                        bound_mask,
                        LightConfidence::Exact,
                        LightProvenance::Import,
                        edge_key,
                    );
                }
            }
            for target in star_imported_candidates.iter() {
                let edge_key = edge_key_from_partial_u64(site_partial, target.id_u64);
                add_resolution_count(
                    &mut counts,
                    &mut id_to_string,
                    &mut counted_likely,
                    &mut counted_exact,
                    c.edge_kind_id,
                    target,
                    BOUND_MAY,
                    true,
                    true,
                    edge_key,
                );
                let _ = push_light_resolved_reference(
                    &mut light_refs,
                    &mut dedup,
                    Some(&mut local_target_tally),
                    light_sender,
                    site_idx,
                    target,
                    BOUND_MAY,
                    LightConfidence::Possible,
                    LightProvenance::ImportStar,
                    edge_key,
                );
            }
            for target in fallback_candidates.iter() {
                let is_same_file_unique = is_bare
                    && same_file_count == 1
                    && target.rel_path_hash == site_rel_path_hash;
                let is_workspace_unique = is_bare
                    && unique_bare_candidate.is_some_and(|unique| unique.id == target.id);
                let bound_mask = if is_same_file_unique {
                    BOUND_MAY | BOUND_MUST
                } else {
                    BOUND_MAY
                };
                if is_same_file_unique || is_workspace_unique {
                    let edge_key = edge_key_from_partial_u64(site_partial, target.id_u64);
                    add_resolution_count(
                        &mut counts,
                        &mut id_to_string,
                        &mut counted_likely,
                        &mut counted_exact,
                        c.edge_kind_id,
                        target,
                        bound_mask,
                        true,
                        true,
                        edge_key,
                    );
                    let confidence = if bound_mask & BOUND_MUST != 0 {
                        "exact"
                    } else {
                        "possible"
                    };
                    let provenance = if is_same_file_unique {
                        "lexical"
                    } else {
                        "unique-name"
                    };
                    let _ = push_light_resolved_reference(
                        &mut light_refs,
                        &mut dedup,
                        Some(&mut local_target_tally),
                        light_sender,
                        site_idx,
                        target,
                        bound_mask,
                        confidence_from_str(confidence),
                        provenance_from_str(provenance),
                        edge_key,
                    );
                }
            }
        }
        // Phase 4-Q: skip worker GraphReference materialization. The data
        // lives in `light_refs`; downstream code uses light_references for
        // the count tally and stream_lights for the write. `resolve_ref_sites`
        // materializes at its boundary for test/legacy callers (small wall
        // cost for test-sized workloads; bypassed by rebuild_graph_native).
        // Saves ~14.4M × 200B ≈ 2.9GB peak memory.
        //
        // W1: the prior materialize-into-references loop was dead code — the
        // Vec it built was immediately shadowed by `let mut references = Vec::new()`
        // below, then dropped. Sampling showed ~6% of phase E CPU spent here.
        let mut references: Vec<GraphReference> = Vec::new();
        maybe_spill(&mut references, &mut spill_paths)?;
        // F1.b: send the worker's residual light batch into the channel-driven
        // writer (Phase 5-A). The worker output tuple still carries a light_refs
        // Vec, but when streaming it is left empty here so the main-thread
        // merge becomes a no-op append.
        if let Some(s) = light_sender {
            if !light_refs.is_empty() {
                let batch = std::mem::take(&mut light_refs);
                let _ = s.send(batch);
            }
        }
        // Convert hashbrown → std HashMap at the worker boundary so the
        // existing downstream merge (which expects std::HashMap) is
        // unchanged. The conversion is a parallel per-worker pass (~325K
        // moves per worker) and small compared to the inner-loop probe
        // savings we get from `entry_ref`.
        // Phase 3 aggressive: convert u64-keyed counts back to String keys
        // for the downstream merge. id_to_string holds the original sym:HEX16
        // for each id_u64; fallback synthesizes via the standard format.
        let std_counts: HashMap<String, GraphCount> = counts
            .into_iter()
            .map(|(k, v)| {
                let s = id_to_string
                    .remove(&k)
                    .unwrap_or_else(|| format!("sym:{:016x}", k));
                (s, v)
            })
            .collect();
        Ok((std_counts, counted_likely, counted_exact, references, dedup, spill_paths, light_refs, local_target_tally))
    };

    let worker_outputs: io::Result<Vec<(
        HashMap<String, GraphCount>,
        AHashSet<u64>,
        AHashSet<u64>,
        Vec<GraphReference>,
        AHashSet<u64>,
        Vec<PathBuf>,
        Vec<LightRef>,
        AHashMap<u64, usize>,
    )>> = if total_refs == 0 || worker_count <= 1 {
        process_chunk(&phase_e_buckets, 0).map(|t| vec![t])
    } else {
        // Rayon work-stealing: split into more chunks than threads so faster
        // cores can grab additional work as slower ones finish. Helps when
        // some chunks contain mostly member sites (heavier resolution) and
        // others bare-only.
        //
        // W6: bumped from 8 → 32. After W5 the per-site cost dropped 60%,
        // exposing load imbalance (cvwait dominated leaf samples at 362K).
        // Finer chunks let work-stealing recover tail latency from
        // member-heavy chunks. Override with ZOEK_PHASE_E_CHUNKS_PER_WORKER.
        //
        // Option C Stage 1: chunks are now bucket-ranges. Buckets are kept
        // intact (each chunk holds a contiguous run of files) so per-file
        // state added in stages 2+ stays inside one rayon work unit.
        use rayon::prelude::*;
        let chunks_per_worker = std::env::var("ZOEK_PHASE_E_CHUNKS_PER_WORKER")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(32);
        let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
        let chunk_target_sites = total_refs.div_ceil(target_chunks).max(1);
        let mut bucket_ranges: Vec<(usize, usize)> = Vec::with_capacity(target_chunks + 1);
        let mut bs = 0usize;
        let mut accumulated = 0usize;
        for (i, b) in phase_e_buckets.iter().enumerate() {
            accumulated += b.indices.len();
            if accumulated >= chunk_target_sites {
                bucket_ranges.push((bs, i + 1));
                bs = i + 1;
                accumulated = 0;
            }
        }
        if bs < phase_e_buckets.len() {
            bucket_ranges.push((bs, phase_e_buckets.len()));
        }
        let pc = &process_chunk;
        let buckets_ref = &phase_e_buckets;
        let collected: Result<Vec<_>, _> = bucket_ranges
            .into_par_iter()
            .enumerate()
            .map(|(idx, (bs, be))| pc(&buckets_ref[bs..be], idx))
            .collect();
        collected
    };
    let worker_outputs = worker_outputs.expect("phase E spill failed");

    // Pre-size to the sum of worker outputs; phase F appends ~2x more after this,
    // so reserve generous headroom to avoid in-flight reallocs.
    let total_phase_e_refs: usize = worker_outputs.iter().map(|t| t.3.len()).sum();
    let mut references: Vec<GraphReference> = Vec::with_capacity(total_phase_e_refs.saturating_mul(3));
    let mut light_references: Vec<LightRef> = Vec::with_capacity(total_phase_e_refs);
    let mut dedup: AHashSet<u64> = AHashSet::default();
    let mut reference_partials: Vec<PathBuf> = Vec::new();
    // F1.a: merge per-worker tallies (sized by union of unique target ids).
    let total_tally_entries: usize = worker_outputs.iter().map(|t| t.7.len()).sum();
    let mut light_target_count_by_id_u64: AHashMap<u64, usize> =
        AHashMap::with_capacity(total_tally_entries);
    for (w_counts, _w_likely, _w_exact, mut w_refs, w_dedup, mut w_spill_paths, mut w_light_refs, w_tally) in worker_outputs {
        // Hand spill paths up to the caller; the streaming sidecar writer
        // will consume them once. The in-memory tail (w_refs) stays for
        // phase F to process and ultimately also be streamed.
        reference_partials.append(&mut w_spill_paths);
        for (k, v) in w_counts {
            let entry = counts.entry(k).or_default();
            entry.usage_likely += v.usage_likely;
            entry.usage_must += v.usage_must;
            entry.usage_may += v.usage_may;
            entry.calls_in_likely += v.calls_in_likely;
            entry.calls_in_must += v.calls_in_must;
            entry.calls_in_may += v.calls_in_may;
            entry.calls_out_must += v.calls_out_must;
            entry.calls_out_may += v.calls_out_may;
            entry.impl_must += v.impl_must;
            entry.impl_may += v.impl_may;
        }
        // counted_likely/counted_exact were per-worker dedup sets — only
        // used inside add_resolution_count. The merged set is discarded
        // below; drop the worker copies without extending into a shared
        // set (the extend was a ~14M-entry waste of time).
        references.append(&mut w_refs);
        light_references.append(&mut w_light_refs);
        dedup.extend(w_dedup);
        for (k, v) in w_tally {
            *light_target_count_by_id_u64.entry(k).or_default() += v;
        }
    }
    // Phase 4-Q: phase E workers skip materialization. References stays
    // empty; LightRef holds the data. resolve_ref_sites materializes for
    // legacy/test callers at its boundary.
    debug_assert!(
        references.is_empty(),
        "phase E should no longer materialize GraphReferences in workers"
    );
    if probe {
        eprintln!(
            "[resolve] phase_e={}ms refs={} light_refs={} spilled_partials={}",
            t_e.elapsed().as_millis(),
            references.len(),
            light_references.len(),
            reference_partials.len()
        );
    }
    ResolveIntermediate {
        references,
        light_references,
        reference_partials,
        counts,
        dedup,
        bare_usage_likely_by_scope_and_name,
        bare_call_likely_by_scope_and_name,
        member_usage_likely_by_scope_and_name,
        member_call_likely_by_scope_and_name,
        bare_likely_sites_by_scope_and_name,
        member_likely_sites_by_scope_and_name,
        light_target_count_by_id_u64,
    }
}

fn import_facts_by_file_local<'a>(
    import_facts: &'a [ImportFact],
) -> HashMap<(&'a str, &'a str), Vec<&'a ImportFact>> {
    let mut out: HashMap<(&str, &str), Vec<&ImportFact>> = HashMap::new();
    for fact in import_facts {
        out.entry((fact.rel_path.as_str(), fact.local_name.as_str()))
            .or_default()
            .push(fact);
    }
    out
}

fn star_import_facts_by_file<'a>(
    import_facts: &'a [ImportFact],
) -> HashMap<&'a str, Vec<&'a ImportFact>> {
    let mut out: HashMap<&str, Vec<&ImportFact>> = HashMap::new();
    for fact in import_facts {
        if fact.local_name == "*" && fact.imported_name == "*" {
            out.entry(fact.rel_path.as_str()).or_default().push(fact);
        }
    }
    out
}

/// Phase 3: caller-provided buffer variant. Used in the phase E worker loop
/// where this is called per bare ref site (~16M times). Avoids a fresh Vec
/// allocation per call.
fn star_import_candidates_into<'a>(
    site: &RefSite,
    star_import_facts_by_file: &HashMap<&'a str, Vec<&'a ImportFact>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    out: &mut Vec<&'a GraphSymbol>,
) {
    out.clear();
    let Some(facts) = star_import_facts_by_file.get(site.rel_path.as_str()) else {
        return;
    };
    for fact in facts {
        for module_path in &fact.module_candidates {
            if let Some(symbols) =
                symbols_by_file_and_name.get(&(module_path.as_str(), site.name.as_str()))
            {
                out.extend(symbols.iter().copied());
            }
        }
    }
    if out.len() > 1 {
        out.sort_unstable_by_key(sym_ptr);
        out.dedup_by_key(|s| sym_ptr(s));
    }
}

#[allow(dead_code)]
fn star_import_candidates<'a>(
    site: &RefSite,
    star_import_facts_by_file: &HashMap<&'a str, Vec<&'a ImportFact>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
) -> Vec<&'a GraphSymbol> {
    let mut out = Vec::new();
    star_import_candidates_into(site, star_import_facts_by_file, symbols_by_file_and_name, &mut out);
    out
}

fn type_facts_by_file_local<'a>(
    type_facts: &'a [TypeFact],
) -> HashMap<(&'a str, &'a str), Vec<&'a TypeFact>> {
    let mut out: HashMap<(&str, &str), Vec<&TypeFact>> = HashMap::new();
    for fact in type_facts {
        out.entry((fact.rel_path.as_str(), fact.local_name.as_str()))
            .or_default()
            .push(fact);
    }
    out
}

fn function_return_facts_by_file_name<'a>(
    function_return_facts: &'a [FunctionReturnFact],
) -> HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>> {
    let mut out: HashMap<(&str, &str), Vec<&FunctionReturnFact>> = HashMap::new();
    for fact in function_return_facts {
        out.entry((fact.rel_path.as_str(), fact.function_name.as_str()))
            .or_default()
            .push(fact);
    }
    out
}

/// Compute both fallback and exact member candidates in a single pass.
/// Writes into caller-provided buffers (cleared first) so capacity is reused
/// across `RefSite`s. Avoids duplicate hashmap lookups and duplicate
/// `resolve_type_fact_targets` calls when the same `RefSite` needs both
/// candidate sets.
/// Wrapper that pulls the four pieces of `site` we actually need and
/// delegates to `combined_member_candidates_by_key`. Kept for any
/// remaining caller that still passes a full `&RefSite`.
fn combined_member_candidates<'a>(
    site: &'a RefSite,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a ImportFact>>,
    type_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a TypeFact>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
) {
    let Some(receiver) = site.receiver_name.as_deref() else {
        fallback.clear();
        exact.clear();
        return;
    };
    // B6 stage-3: rebuild the enclosing id string from the stored u64 (cold).
    let enclosing_str = enclosing_id_to_string(site.enclosing_id);
    combined_member_candidates_by_key(
        site.rel_path.as_str(),
        receiver,
        site.name.as_str(),
        enclosing_str.as_deref(),
        symbols_by_id,
        types_by_name,
        members_by_container_and_name,
        symbols_by_file_and_name,
        import_targets,
        import_facts_by_file_local,
        type_facts_by_file_local,
        function_return_facts_by_file_name,
        hierarchy_facts,
        fallback,
        exact,
    );
}

/// Same logic as `combined_member_candidates` but parameterized by the
/// individual fields of the source site (rel_path, receiver, name,
/// enclosing_symbol_id). Lets the pre-resolve build step compute results
/// keyed on those four fields without constructing a synthetic `RefSite`.
fn combined_member_candidates_by_key<'a>(
    rel_path: &'a str,
    receiver: &'a str,
    name: &'a str,
    site_enclosing_id: Option<&str>,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a ImportFact>>,
    type_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a TypeFact>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
) {
    fallback.clear();
    exact.clear();

    if !matches!(receiver, "self" | "cls") {
        let has_any = types_by_name.contains_key(receiver)
            || import_targets.contains_key(&(rel_path, receiver))
            || import_facts_by_file_local.contains_key(&(rel_path, receiver))
            || type_facts_by_file_local.contains_key(&(rel_path, receiver));
        if !has_any {
            return;
        }
    }

    if matches!(receiver, "self" | "cls") {
        if let Some(source) = site_enclosing_id.and_then(|id| symbols_by_id.get(id)) {
            if let Some(container_name) = source.container_name.as_deref() {
                extend_members_for_container(
                    fallback,
                    members_by_container_and_name,
                    container_name,
                    name,
                );
                collect_exact_members_for_container(
                    exact,
                    members_by_container_and_name,
                    container_name,
                    name,
                    "receiver-self",
                );
            } else if is_type_kind_sym(source) {
                extend_members_for_type(
                    fallback,
                    members_by_container_and_name,
                    source,
                    name,
                );
            }
        }
    }

    if let Some(types) = types_by_name.get(receiver) {
        for symbol in types {
            extend_members_for_type(
                fallback,
                members_by_container_and_name,
                symbol,
                name,
            );
            collect_exact_members_for_type(
                exact,
                members_by_container_and_name,
                symbol,
                name,
                "receiver-type",
            );
        }
    }

    if let Some(targets) = import_targets.get(&(rel_path, receiver)) {
        for target in targets {
            if is_type_kind_sym(target) {
                extend_members_for_type(
                    fallback,
                    members_by_container_and_name,
                    target,
                    name,
                );
                collect_exact_members_for_type(
                    exact,
                    members_by_container_and_name,
                    target,
                    name,
                    "imported-type",
                );
            }
        }
    }

    if let Some(facts) = import_facts_by_file_local.get(&(rel_path, receiver)) {
        for fact in facts {
            let is_star = fact.imported_name == "*";
            for module_path in &fact.module_candidates {
                if let Some(symbols) =
                    symbols_by_file_and_name.get(&(module_path.as_str(), name))
                {
                    fallback.extend(symbols.iter().copied());
                    if is_star {
                        for symbol in symbols {
                            exact.push(MemberExactCandidate {
                                target: *symbol,
                                provenance: "import-namespace",
                            });
                        }
                    }
                }
            }
        }
    }

    if let Some(facts) = type_facts_by_file_local.get(&(rel_path, receiver)) {
        for fact in facts {
            if !type_fact_applies_by_enclosing(fact, site_enclosing_id) {
                continue;
            }
            let targets = resolve_type_fact_targets_by_key(
                fact,
                rel_path,
                site_enclosing_id,
                symbols_by_id,
                types_by_name,
                symbols_by_file_and_name,
                import_targets,
                function_return_facts_by_file_name,
                hierarchy_facts,
            );
            for target_type in targets {
                extend_members_for_type(
                    fallback,
                    members_by_container_and_name,
                    target_type,
                    name,
                );
                collect_exact_members_for_type(
                    exact,
                    members_by_container_and_name,
                    target_type,
                    name,
                    "type-fact",
                );
            }
        }
    }

    if fallback.len() > 1 {
        fallback.sort_unstable_by_key(sym_ptr);
        fallback.dedup_by_key(|s| sym_ptr(s));
    }
    sort_dedup_member_exact_candidates(exact);
    if exact.len() != 1 {
        exact.clear();
    }
}

/// Phase 3 (Receiver Memoization): the receiver-side resolution that
/// `combined_member_candidates_by_key` does is independent of the ref site's
/// `name`. Within a chunk many sites share the same (rel_path, receiver,
/// enclosing_id) triplet, so we precompute the receiver-side info once and
/// reuse it across all sites with the same key.
#[derive(Clone, Copy)]
struct TypeTarget<'a> {
    sym: &'a GraphSymbol,
    provenance: &'static str,
}

struct ReceiverResolution<'a> {
    has_any: bool,
    /// For receiver="self"|"cls" where source has container_name
    self_container: Option<&'a str>,
    /// For receiver="self"|"cls" where source itself is a type kind
    self_type_symbol: Option<&'a GraphSymbol>,
    /// Type symbols whose members we expand by name
    type_targets: Vec<TypeTarget<'a>>,
    /// Raw import facts (need name to expand module_candidates)
    import_facts: Vec<&'a ImportFact>,
}

/// W18 / Option B step B4: the all-hash twin of `TypeTarget`. The container
/// strings of the type symbol (qualified_name / name) are hashed once when the
/// `ReceiverResolution` is converted (cache-miss, rare) so the per-site
/// `expand` probe of `members_by_container_and_name_h` is pure integer keys.
struct TypeTargetCols {
    qual_hash: u64,
    name_hash: u64,
    /// `qualified_name == name` — skip the redundant second member probe.
    qual_eq_name: bool,
    provenance: &'static str,
}

/// B4: the all-hash twin of `ReceiverResolution`. Holds NO borrows (every
/// string collapsed to a `u64` hash), so it carries no lifetime and the
/// per-file `receiver_cache_cols` is cheap to clear. Built once per distinct
/// `(receiver, enclosing)` via `receiver_resolution_to_cols`; the hot
/// `expand_receiver_for_name_cols` reads only these hashes + `site_cols`.
struct ReceiverResolutionCols {
    has_any: bool,
    /// receiver=self|cls with container_name → `stable_hash(container)`.
    self_container_hash: Option<u64>,
    /// receiver=self|cls where source is itself a type kind →
    /// `(qualified_name hash, name hash, qualified_name == name)`.
    self_type: Option<(u64, u64, bool)>,
    type_targets: Vec<TypeTargetCols>,
    /// `(module_candidate hash, is_star)` pairs flattened from the import facts.
    import_modules: Vec<(u64, bool)>,
}

/// B4: convert the validated string-keyed `ReceiverResolution` (built by the
/// existing `compute_receiver_resolution` on the rare cache-miss path) into the
/// all-hash `ReceiverResolutionCols` the column-only worker caches and expands.
/// Hashing happens once per distinct receiver, not per site.
fn receiver_resolution_to_cols(res: &ReceiverResolution) -> ReceiverResolutionCols {
    ReceiverResolutionCols {
        has_any: res.has_any,
        self_container_hash: res.self_container.map(stable_hash),
        self_type: res.self_type_symbol.map(|s| {
            (
                stable_hash(&s.qualified_name),
                s.name_hash,
                s.qualified_name == s.name,
            )
        }),
        type_targets: res
            .type_targets
            .iter()
            .map(|tt| TypeTargetCols {
                qual_hash: stable_hash(&tt.sym.qualified_name),
                name_hash: tt.sym.name_hash,
                qual_eq_name: tt.sym.qualified_name == tt.sym.name,
                provenance: tt.provenance,
            })
            .collect(),
        import_modules: res
            .import_facts
            .iter()
            .flat_map(|f| {
                let is_star = f.imported_name == "*";
                f.module_candidates
                    .iter()
                    .map(move |m| (stable_hash(m), is_star))
            })
            .collect(),
    }
}

#[allow(clippy::too_many_arguments)]
/// B4: all-hash twin of `expand_receiver_for_name`. Probes the hash-keyed
/// `members_by_container_and_name_h` / `symbols_by_file_and_name_h` with
/// `(container_hash, name_hash)` so the hot member path reads no `RefSite`
/// `&str`. Operation order + provenance strings mirror the string version
/// exactly, so the dedup'd output is identical (modulo hash collisions, which
/// the invariant gate rules out).
fn expand_receiver_for_name_cols<'a>(
    res: &ReceiverResolutionCols,
    name_hash: u64,
    members_by_container_and_name_h: &HashMap<(u64, u64), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name_h: &HashMap<(u64, u64), Vec<&'a GraphSymbol>>,
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
) {
    fallback.clear();
    exact.clear();
    if !res.has_any {
        return;
    }
    if let Some(ch) = res.self_container_hash {
        // extend_and_collect_members_for_container (receiver-self): both buffers.
        if let Some(symbols) = members_by_container_and_name_h.get(&(ch, name_hash)) {
            for sym in symbols {
                fallback.push(*sym);
                exact.push(MemberExactCandidate { target: *sym, provenance: "receiver-self" });
            }
        }
    } else if let Some((qual_hash, name_h, qual_eq_name)) = res.self_type {
        // extend_members_for_type (self type): fallback only.
        if let Some(symbols) = members_by_container_and_name_h.get(&(qual_hash, name_hash)) {
            fallback.extend(symbols.iter().copied());
        }
        if !qual_eq_name {
            if let Some(symbols) = members_by_container_and_name_h.get(&(name_h, name_hash)) {
                fallback.extend(symbols.iter().copied());
            }
        }
    }
    for tt in &res.type_targets {
        // extend_and_collect_members_for_type: both buffers, qual then (name if !=).
        if let Some(symbols) = members_by_container_and_name_h.get(&(tt.qual_hash, name_hash)) {
            for sym in symbols {
                fallback.push(*sym);
                exact.push(MemberExactCandidate { target: *sym, provenance: tt.provenance });
            }
        }
        if !tt.qual_eq_name {
            if let Some(symbols) = members_by_container_and_name_h.get(&(tt.name_hash, name_hash)) {
                for sym in symbols {
                    fallback.push(*sym);
                    exact.push(MemberExactCandidate { target: *sym, provenance: tt.provenance });
                }
            }
        }
    }
    for (module_hash, is_star) in &res.import_modules {
        if let Some(symbols) = symbols_by_file_and_name_h.get(&(*module_hash, name_hash)) {
            fallback.extend(symbols.iter().copied());
            if *is_star {
                for symbol in symbols {
                    exact.push(MemberExactCandidate { target: *symbol, provenance: "import-namespace" });
                }
            }
        }
    }
    if fallback.len() > 1 {
        fallback.sort_unstable_by_key(sym_ptr);
        fallback.dedup_by_key(|s| sym_ptr(s));
    }
    sort_dedup_member_exact_candidates(exact);
    if exact.len() != 1 {
        exact.clear();
    }
}

/// B4: all-hash twin of `star_import_candidates_into`. Uses the prebuilt
/// `star_module_hashes_by_rel` (rel_path_hash → module hashes) + the hash-keyed
/// `symbols_by_file_and_name_h` so the bare path reads no `RefSite` `&str`.
fn star_import_candidates_into_cols<'a>(
    rel_path_hash: u64,
    name_hash: u64,
    star_module_hashes_by_rel: &HashMap<u64, Vec<u64>>,
    symbols_by_file_and_name_h: &HashMap<(u64, u64), Vec<&'a GraphSymbol>>,
    out: &mut Vec<&'a GraphSymbol>,
) {
    out.clear();
    let Some(module_hashes) = star_module_hashes_by_rel.get(&rel_path_hash) else {
        return;
    };
    for &module_hash in module_hashes {
        if let Some(symbols) = symbols_by_file_and_name_h.get(&(module_hash, name_hash)) {
            out.extend(symbols.iter().copied());
        }
    }
    if out.len() > 1 {
        out.sort_unstable_by_key(sym_ptr);
        out.dedup_by_key(|s| sym_ptr(s));
    }
}

fn compute_receiver_resolution<'a>(
    rel_path: &'a str,
    receiver: &'a str,
    site_enclosing_id: Option<&str>,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a ImportFact>>,
    type_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a TypeFact>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
) -> ReceiverResolution<'a> {
    let mut type_targets: Vec<TypeTarget<'a>> = Vec::new();
    let mut import_facts_out: Vec<&'a ImportFact> = Vec::new();
    let mut self_container: Option<&'a str> = None;
    let mut self_type_symbol: Option<&'a GraphSymbol> = None;

    let is_self_kind = matches!(receiver, "self" | "cls");
    let has_any = is_self_kind
        || types_by_name.contains_key(receiver)
        || import_targets.contains_key(&(rel_path, receiver))
        || import_facts_by_file_local.contains_key(&(rel_path, receiver))
        || type_facts_by_file_local.contains_key(&(rel_path, receiver));
    if !has_any {
        return ReceiverResolution {
            has_any: false,
            self_container,
            self_type_symbol,
            type_targets,
            import_facts: import_facts_out,
        };
    }

    if is_self_kind {
        if let Some(source) = site_enclosing_id.and_then(|id| symbols_by_id.get(id)) {
            if let Some(c) = source.container_name.as_deref() {
                self_container = Some(c);
            } else if is_type_kind_sym(source) {
                self_type_symbol = Some(source);
            }
        }
    }

    if let Some(types) = types_by_name.get(receiver) {
        for t in types {
            type_targets.push(TypeTarget { sym: *t, provenance: "receiver-type" });
        }
    }

    if let Some(targets) = import_targets.get(&(rel_path, receiver)) {
        for t in targets {
            if is_type_kind_sym(t) {
                type_targets.push(TypeTarget { sym: *t, provenance: "imported-type" });
            }
        }
    }

    if let Some(facts) = import_facts_by_file_local.get(&(rel_path, receiver)) {
        import_facts_out.extend(facts.iter().copied());
    }

    if let Some(facts) = type_facts_by_file_local.get(&(rel_path, receiver)) {
        for fact in facts {
            if !type_fact_applies_by_enclosing(fact, site_enclosing_id) {
                continue;
            }
            let targets = resolve_type_fact_targets_by_key(
                fact,
                rel_path,
                site_enclosing_id,
                symbols_by_id,
                types_by_name,
                symbols_by_file_and_name,
                import_targets,
                function_return_facts_by_file_name,
                hierarchy_facts,
            );
            for t in targets {
                type_targets.push(TypeTarget { sym: t, provenance: "type-fact" });
            }
        }
    }

    // Phase 3 aggressive: dedup type_targets by symbol identity. Same symbol
    // can be reached via types_by_name + import_targets + type_facts in the
    // same receiver — without dedup we do the same members lookup multiple
    // times per ref site. For a cache entry with avg ~30% redundancy this
    // saves ~10% of phase E hot-loop HashMap probes.
    if type_targets.len() > 1 {
        type_targets.sort_unstable_by_key(|t| t.sym as *const GraphSymbol as usize);
        type_targets.dedup_by_key(|t| t.sym as *const GraphSymbol as usize);
    }
    ReceiverResolution {
        has_any: true,
        self_container,
        self_type_symbol,
        type_targets,
        import_facts: import_facts_out,
    }
}

/// Per-name expansion of a cached `ReceiverResolution`. Splits the
/// name-dependent work out of `combined_member_candidates_by_key` so we can
/// reuse receiver-side state across sites that share (rel_path, receiver,
/// enclosing_id).
fn expand_receiver_for_name<'a>(
    res: &ReceiverResolution<'a>,
    name: &'a str,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
) {
    fallback.clear();
    exact.clear();
    if !res.has_any {
        return;
    }
    if let Some(c) = res.self_container {
        extend_and_collect_members_for_container(
            fallback,
            exact,
            members_by_container_and_name,
            c,
            name,
            "receiver-self",
        );
    } else if let Some(sym) = res.self_type_symbol {
        extend_members_for_type(fallback, members_by_container_and_name, sym, name);
    }
    for tt in &res.type_targets {
        extend_and_collect_members_for_type(
            fallback,
            exact,
            members_by_container_and_name,
            tt.sym,
            name,
            tt.provenance,
        );
    }
    for fact in &res.import_facts {
        let is_star = fact.imported_name == "*";
        for module_path in &fact.module_candidates {
            if let Some(symbols) =
                symbols_by_file_and_name.get(&(module_path.as_str(), name))
            {
                fallback.extend(symbols.iter().copied());
                if is_star {
                    for symbol in symbols {
                        exact.push(MemberExactCandidate {
                            target: *symbol,
                            provenance: "import-namespace",
                        });
                    }
                }
            }
        }
    }
    if fallback.len() > 1 {
        fallback.sort_unstable_by_key(sym_ptr);
        fallback.dedup_by_key(|s| sym_ptr(s));
    }
    sort_dedup_member_exact_candidates(exact);
    if exact.len() != 1 {
        exact.clear();
    }
}

/// `type_fact_applies_to_site` parameterized by enclosing only.
fn type_fact_applies_by_enclosing(fact: &TypeFact, site_enclosing_id: Option<&str>) -> bool {
    match (fact.enclosing_symbol_id.as_deref(), site_enclosing_id) {
        (Some(fact_scope), Some(site_scope)) => fact_scope == site_scope,
        (None, _) => true,
        _ => false,
    }
}

/// `resolve_type_fact_targets` parameterized by rel_path/enclosing only.
fn resolve_type_fact_targets_by_key<'a>(
    fact: &TypeFact,
    site_rel_path: &'a str,
    site_enclosing_id: Option<&str>,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
) -> Vec<&'a GraphSymbol> {
    if let Some(model_name) = fact
        .type_name
        .strip_prefix(DJANGO_MODEL_MANAGER_FACT_PREFIX)
    {
        let mut out: Vec<_> = resolve_type_name_targets_by_key(
            model_name,
            site_rel_path,
            site_enclosing_id,
            symbols_by_id,
            types_by_name,
            symbols_by_file_and_name,
            import_targets,
        )
        .into_iter()
        .filter(|symbol| is_django_model_type(symbol, hierarchy_facts))
        .collect();
        sort_dedup_symbols(&mut out);
        return out;
    }
    if let Some(callee) = fact.type_name.strip_prefix(RETURN_TYPE_FACT_PREFIX) {
        let mut out = Vec::new();
        if let Some(facts) = function_return_facts_by_file_name.get(&(site_rel_path, callee)) {
            for return_fact in facts {
                out.extend(resolve_type_name_targets_by_key(
                    &return_fact.type_name,
                    return_fact.rel_path.as_str(),
                    site_enclosing_id,
                    symbols_by_id,
                    types_by_name,
                    symbols_by_file_and_name,
                    import_targets,
                ));
            }
        }
        if let Some(targets) = import_targets.get(&(site_rel_path, callee)) {
            for target in targets {
                if !matches!(target.kind.as_str(), "function" | "method") {
                    continue;
                }
                if let Some(facts) = function_return_facts_by_file_name
                    .get(&(target.rel_path.as_str(), target.name.as_str()))
                {
                    for return_fact in facts {
                        out.extend(resolve_type_name_targets_by_key(
                            &return_fact.type_name,
                            return_fact.rel_path.as_str(),
                            site_enclosing_id,
                            symbols_by_id,
                            types_by_name,
                            symbols_by_file_and_name,
                            import_targets,
                        ));
                    }
                }
            }
        }
        sort_dedup_symbols(&mut out);
        return out;
    }
    resolve_type_name_targets_by_key(
        &fact.type_name,
        site_rel_path,
        site_enclosing_id,
        symbols_by_id,
        types_by_name,
        symbols_by_file_and_name,
        import_targets,
    )
}

fn resolve_type_name_targets_by_key<'a>(
    type_expr: &str,
    context_rel_path: &'a str,
    site_enclosing_id: Option<&str>,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
) -> Vec<&'a GraphSymbol> {
    let type_name = type_tail(type_expr);
    if type_name == "Self" {
        if let Some(container_name) = site_enclosing_id
            .and_then(|id| symbols_by_id.get(id))
            .and_then(|symbol| symbol.container_name.as_deref())
        {
            return types_by_name
                .get(container_name)
                .cloned()
                .unwrap_or_default();
        }
        return Vec::new();
    }
    if let Some(targets) = symbols_by_file_and_name.get(&(context_rel_path, type_name)) {
        let same_file_types: Vec<_> = targets
            .iter()
            .copied()
            .filter(|symbol| is_type_kind_sym(symbol))
            .collect();
        if !same_file_types.is_empty() {
            return same_file_types;
        }
    }
    if let Some(targets) = import_targets.get(&(context_rel_path, type_name)) {
        let imported_types: Vec<_> = targets
            .iter()
            .copied()
            .filter(|symbol| is_type_kind_sym(symbol))
            .collect();
        if !imported_types.is_empty() {
            return imported_types;
        }
    }
    types_by_name
        .get(type_name)
        .cloned()
        .unwrap_or_default()
}

fn type_fact_applies_to_site(fact: &TypeFact, site: &RefSite) -> bool {
    // B6 stage-3: enclosing is stored as a u64; rebuild the string (cold) and
    // reuse the by-key comparison.
    type_fact_applies_by_enclosing(fact, enclosing_id_to_string(site.enclosing_id).as_deref())
}

fn resolve_type_fact_targets<'a>(
    fact: &TypeFact,
    site: &RefSite,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
) -> Vec<&'a GraphSymbol> {
    if let Some(model_name) = fact
        .type_name
        .strip_prefix(DJANGO_MODEL_MANAGER_FACT_PREFIX)
    {
        let mut out: Vec<_> = resolve_type_name_targets(
            model_name,
            site.rel_path.as_str(),
            site,
            symbols_by_id,
            types_by_name,
            symbols_by_file_and_name,
            import_targets,
        )
        .into_iter()
        .filter(|symbol| is_django_model_type(symbol, hierarchy_facts))
        .collect();
        sort_dedup_symbols(&mut out);
        return out;
    }
    if let Some(callee) = fact.type_name.strip_prefix(RETURN_TYPE_FACT_PREFIX) {
        let mut out = Vec::new();
        if let Some(facts) =
            function_return_facts_by_file_name.get(&(site.rel_path.as_str(), callee))
        {
            for return_fact in facts {
                out.extend(resolve_type_name_targets(
                    &return_fact.type_name,
                    return_fact.rel_path.as_str(),
                    site,
                    symbols_by_id,
                    types_by_name,
                    symbols_by_file_and_name,
                    import_targets,
                ));
            }
        }
        if let Some(targets) = import_targets.get(&(site.rel_path.as_str(), callee)) {
            for target in targets {
                if !matches!(target.kind.as_str(), "function" | "method") {
                    continue;
                }
                if let Some(facts) = function_return_facts_by_file_name
                    .get(&(target.rel_path.as_str(), target.name.as_str()))
                {
                    for return_fact in facts {
                        out.extend(resolve_type_name_targets(
                            &return_fact.type_name,
                            return_fact.rel_path.as_str(),
                            site,
                            symbols_by_id,
                            types_by_name,
                            symbols_by_file_and_name,
                            import_targets,
                        ));
                    }
                }
            }
        }
        sort_dedup_symbols(&mut out);
        return out;
    }
    resolve_type_name_targets(
        &fact.type_name,
        site.rel_path.as_str(),
        site,
        symbols_by_id,
        types_by_name,
        symbols_by_file_and_name,
        import_targets,
    )
}

fn resolve_type_name_targets<'a>(
    type_expr: &str,
    context_rel_path: &str,
    site: &RefSite,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
) -> Vec<&'a GraphSymbol> {
    let type_name = type_tail(type_expr);
    if type_name == "Self" {
        // B6 stage-3: rebuild the enclosing id string from the stored u64 (cold).
        let site_enclosing = enclosing_id_to_string(site.enclosing_id);
        if let Some(container_name) = site_enclosing
            .as_deref()
            .and_then(|id| symbols_by_id.get(id))
            .and_then(|symbol| symbol.container_name.as_deref())
        {
            return types_by_name
                .get(container_name)
                .cloned()
                .unwrap_or_default();
        }
        return Vec::new();
    }
    if let Some(targets) = symbols_by_file_and_name.get(&(context_rel_path, type_name)) {
        let same_file_types: Vec<_> = targets
            .iter()
            .copied()
            .filter(|symbol| is_type_kind_sym(symbol))
            .collect();
        if !same_file_types.is_empty() {
            return same_file_types;
        }
    }
    if let Some(targets) = import_targets.get(&(context_rel_path, type_name)) {
        let imported_types: Vec<_> = targets
            .iter()
            .copied()
            .filter(|symbol| is_type_kind_sym(symbol))
            .collect();
        if !imported_types.is_empty() {
            return imported_types;
        }
    }
    types_by_name.get(type_name).cloned().unwrap_or_default()
}

fn is_django_model_type(symbol: &GraphSymbol, hierarchy_facts: &[HierarchyFact]) -> bool {
    if symbol
        .extends_names
        .iter()
        .any(|name| is_django_model_parent_name(name))
    {
        return true;
    }
    let mut ancestors: HashSet<String> = [symbol.qualified_name.clone(), symbol.name.clone()]
        .into_iter()
        .collect();
    let mut changed = true;
    while changed {
        changed = false;
        for fact in hierarchy_facts {
            if fact.relation != "extends" {
                continue;
            }
            if !(ancestors.contains(&fact.child_qualified_name)
                || ancestors.contains(type_tail(&fact.child_qualified_name)))
            {
                continue;
            }
            if is_django_model_parent_name(&fact.parent_name) {
                return true;
            }
            if ancestors.insert(fact.parent_name.clone()) {
                changed = true;
            }
            if ancestors.insert(type_tail(&fact.parent_name).to_string()) {
                changed = true;
            }
        }
    }
    false
}

fn is_django_model_parent_name(name: &str) -> bool {
    name == "django.db.models.Model" || name == "models.Model" || name == "Model"
}

fn extend_members_for_type<'a>(
    out: &mut Vec<&'a GraphSymbol>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    type_symbol: &'a GraphSymbol,
    member_name: &str,
) {
    let qual = type_symbol.qualified_name.as_str();
    let name = type_symbol.name.as_str();
    extend_members_for_container(out, members_by_container_and_name, qual, member_name);
    if qual != name {
        extend_members_for_container(out, members_by_container_and_name, name, member_name);
    }
}

fn collect_exact_members_for_type<'a>(
    out: &mut Vec<MemberExactCandidate<'a>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    type_symbol: &'a GraphSymbol,
    member_name: &str,
    provenance: &'static str,
) {
    collect_exact_members_for_container(
        out,
        members_by_container_and_name,
        type_symbol.qualified_name.as_str(),
        member_name,
        provenance,
    );
    collect_exact_members_for_container(
        out,
        members_by_container_and_name,
        type_symbol.name.as_str(),
        member_name,
        provenance,
    );
}

fn extend_members_for_container<'a>(
    out: &mut Vec<&'a GraphSymbol>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    container_name: &str,
    member_name: &str,
) {
    if let Some(symbols) = members_by_container_and_name.get(&(container_name, member_name)) {
        out.extend(symbols.iter().copied());
    }
}

fn collect_exact_members_for_container<'a>(
    out: &mut Vec<MemberExactCandidate<'a>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    container_name: &str,
    member_name: &str,
    provenance: &'static str,
) {
    if let Some(symbols) = members_by_container_and_name.get(&(container_name, member_name)) {
        out.extend(symbols.iter().map(|target| MemberExactCandidate {
            target: *target,
            provenance,
        }));
    }
}

/// Phase 3 optimization: combined extend + collect that does ONE HashMap
/// lookup instead of two. Used by `expand_receiver_for_name` where each
/// type target needs both fallback and exact members for the same
/// (container, name) keys.
fn extend_and_collect_members_for_container<'a>(
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    container_name: &str,
    member_name: &str,
    provenance: &'static str,
) {
    if let Some(symbols) = members_by_container_and_name.get(&(container_name, member_name)) {
        for sym in symbols {
            fallback.push(*sym);
            exact.push(MemberExactCandidate { target: *sym, provenance });
        }
    }
}

fn extend_and_collect_members_for_type<'a>(
    fallback: &mut Vec<&'a GraphSymbol>,
    exact: &mut Vec<MemberExactCandidate<'a>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    type_symbol: &'a GraphSymbol,
    member_name: &str,
    provenance: &'static str,
) {
    let qual = type_symbol.qualified_name.as_str();
    let name = type_symbol.name.as_str();
    extend_and_collect_members_for_container(
        fallback,
        exact,
        members_by_container_and_name,
        qual,
        member_name,
        provenance,
    );
    // Phase 3 optimization: top-level symbols have qualified_name == name;
    // the second lookup would return the same Vec. Skip when equal.
    if qual != name {
        extend_and_collect_members_for_container(
            fallback,
            exact,
            members_by_container_and_name,
            name,
            member_name,
            provenance,
        );
    }
}

// Phase 3 optimization: dedup `&GraphSymbol` by pointer instead of by id
// string. Within resolve, every `&GraphSymbol` points into the single owning
// `symbols` slice, so pointer equality is symbol identity. Pointer compares
// are integer ops (~1ns) vs String ord/eq on id (10-50ns), and we hit this
// per member ref site.
#[inline]
fn sym_ptr(s: &&GraphSymbol) -> usize {
    *s as *const GraphSymbol as usize
}

fn sort_dedup_symbols(symbols: &mut Vec<&GraphSymbol>) {
    if symbols.len() <= 1 {
        return;
    }
    symbols.sort_unstable_by_key(sym_ptr);
    symbols.dedup_by_key(|s| sym_ptr(s));
}

fn sort_dedup_member_exact_candidates(candidates: &mut Vec<MemberExactCandidate<'_>>) {
    if candidates.len() <= 1 {
        return;
    }
    candidates.sort_unstable_by_key(|c| c.target as *const GraphSymbol as usize);
    candidates.dedup_by_key(|c| c.target as *const GraphSymbol as usize);
}

// B5: the four "may" maps are keyed by `name_hash` (u64) instead of the site
// `&str` name — same proven-safe rekey as W9b/B3a, so phase C reads no string
// off the 292B `RefSite`. The two site maps store global `ref_sites` indices
// (u32) instead of `&RefSite`. No field borrows `ref_sites` any more, so the
// accumulator tuple no longer needs a lifetime.
type PhaseCAccums = (
    AHashMap<u64, usize>,
    AHashMap<u64, usize>,
    AHashMap<u64, usize>,
    AHashMap<u64, usize>,
    AHashMap<(u64, u64, u64), usize>,
    AHashMap<(u64, u64, u64), usize>,
    AHashMap<(u64, u64, u64), usize>,
    AHashMap<(u64, u64, u64), usize>,
    AHashMap<(u64, u64, u64), Vec<u32>>,
    AHashMap<(u64, u64, u64), Vec<u32>>,
);

// B5 (Option B / SoA, phase C → columns): the 38M-site phase-C scan is a full
// sequential pass over `ref_sites` — the same shape as the phase-E pre-filter
// that the SoA conversion sped up ~5.8x by reading the 48B `SiteCols` instead
// of the 292B `RefSite`. This makes phase C read `SiteCols[i]` for every hot
// per-site field (name_hash / edge_kind_id / access_kind_id / is_definition /
// rel_path_hash), touching `RefSite` only at file boundaries to hash the scope
// (first path component) and language strings. `soa_b5` gates the per-site read
// source for paired A/B measurement; both paths build identical maps.
fn phase_c_process_chunk(
    ref_sites: &[RefSite],
    site_cols: &[SiteCols],
    start: usize,
    end: usize,
    symbol_name_hashes: &AHashSet<u64>,
    soa_b5: bool,
    // B6 stage-5d: when `Some`, the per-file boundary rebuilds `rel_path`
    // (`FileTable::get_path(file_id)`) + `language` (`language_str_from_id`)
    // from columns instead of `ref_sites[i]` (dropped on the channel rebuild).
    // `None` reads the site. Reconstruction is byte-exact: file_id round-trips
    // the path and site languages are canonical (probe: 0 unknown languages).
    file_recon: Option<(&FileTable, &[u32])>,
) -> PhaseCAccums {
    let mut bare_usage_may: AHashMap<u64, usize> = AHashMap::default();
    let mut bare_call_may: AHashMap<u64, usize> = AHashMap::default();
    let mut member_usage_may: AHashMap<u64, usize> = AHashMap::default();
    let mut member_call_may: AHashMap<u64, usize> = AHashMap::default();
    let mut bare_usage_likely: AHashMap<(u64, u64, u64), usize> = AHashMap::default();
    let mut bare_call_likely: AHashMap<(u64, u64, u64), usize> = AHashMap::default();
    let mut member_usage_likely: AHashMap<(u64, u64, u64), usize> = AHashMap::default();
    let mut member_call_likely: AHashMap<(u64, u64, u64), usize> = AHashMap::default();
    let mut bare_likely_sites: AHashMap<(u64, u64, u64), Vec<u32>> = AHashMap::default();
    let mut member_likely_sites: AHashMap<(u64, u64, u64), Vec<u32>> = AHashMap::default();
    // W10 micro-cache, B5: boundary detection is now a `rel_path_hash` (u64)
    // compare from the dense column rather than a per-site string compare. A
    // file's `language` is constant (one language per file), so the scope and
    // language hashes are refreshed together on the rel_path boundary — reading
    // both strings from `ref_sites[i]` only there (file-grouped ⇒ ~once per
    // file). Keeping the language tied to the rel_path boundary (vs a separate
    // `language_id` compare) avoids a correctness hazard: distinct unknown
    // languages share `language_id` 0 but must keep distinct `lang_hash`es to
    // match the symbol side, and distinct strings here always re-hash.
    let mut have_file = false;
    let mut cached_rel_path_hash: u64 = 0;
    let mut cached_scope_hash: u64 = 0;
    let mut cached_lang_hash: u64 = 0;
    for i in start..end {
        // Gated dense read. With `soa_b5` the per-site fields come from the 48B
        // `SiteCols`; otherwise from the 292B `RefSite`. The values are
        // identical (SiteCols is a field-for-field copy), so the maps below are
        // built the same either way — only the cache traffic differs.
        let (name_hash, edge_kind_id, access_kind_id, is_definition, rel_path_hash) = if soa_b5 {
            let c = site_cols[i];
            (
                c.name_hash,
                c.edge_kind_id,
                c.access_kind_id,
                c.flags & SITE_FLAG_IS_DEFINITION != 0,
                c.rel_path_hash,
            )
        } else {
            let s = &ref_sites[i];
            (
                s.name_hash,
                s.edge_kind_id,
                s.access_kind_id,
                s.is_definition,
                s.rel_path_hash,
            )
        };
        // W12: precomputed access_kind_id / edge_kind_id replace memcmps.
        let is_call_or_construct =
            edge_kind_id == EDGE_KIND_CALL || edge_kind_id == EDGE_KIND_CONSTRUCT;
        let in_symbols = symbol_name_hashes.contains(&name_hash);
        if access_kind_id == ACCESS_KIND_BARE && in_symbols {
            *bare_usage_may.entry(name_hash).or_default() += 1;
            if is_call_or_construct {
                *bare_call_may.entry(name_hash).or_default() += 1;
            }
        } else if access_kind_id == ACCESS_KIND_MEMBER && in_symbols {
            *member_usage_may.entry(name_hash).or_default() += 1;
            if is_call_or_construct {
                *member_call_may.entry(name_hash).or_default() += 1;
            }
        }
        if is_definition {
            continue;
        }
        if !have_file || rel_path_hash != cached_rel_path_hash {
            have_file = true;
            cached_rel_path_hash = rel_path_hash;
            match file_recon {
                Some((ft, file_ids)) => {
                    let rel_path = ft.get_path(file_ids[i]).unwrap_or("");
                    cached_scope_hash = stable_hash(source_scope_key(rel_path));
                    let lang = language_str_from_id(site_cols[i].language_id).unwrap_or("");
                    cached_lang_hash = stable_hash(lang);
                }
                None => {
                    let s = &ref_sites[i];
                    cached_scope_hash = stable_hash(source_scope_key(s.rel_path.as_str()));
                    cached_lang_hash = stable_hash(s.language.as_str());
                }
            }
        }
        let scope_name = (cached_lang_hash, cached_scope_hash, name_hash);
        if access_kind_id == ACCESS_KIND_BARE {
            *bare_usage_likely.entry(scope_name).or_default() += 1;
            bare_likely_sites.entry(scope_name).or_default().push(i as u32);
            if is_call_or_construct {
                *bare_call_likely.entry(scope_name).or_default() += 1;
            }
        } else if access_kind_id == ACCESS_KIND_MEMBER {
            *member_usage_likely.entry(scope_name).or_default() += 1;
            member_likely_sites
                .entry(scope_name)
                .or_default()
                .push(i as u32);
            if is_call_or_construct {
                *member_call_likely.entry(scope_name).or_default() += 1;
            }
        }
    }
    (
        bare_usage_may,
        bare_call_may,
        member_usage_may,
        member_call_may,
        bare_usage_likely,
        bare_call_likely,
        member_usage_likely,
        member_call_likely,
        bare_likely_sites,
        member_likely_sites,
    )
}

fn add_resolution_count(
    counts: &mut hashbrown::HashMap<u64, GraphCount>,
    id_to_string: &mut AHashMap<u64, String>,
    counted_likely: &mut AHashSet<u64>,
    counted_exact: &mut AHashSet<u64>,
    // B4: was `site: &RefSite` (read only for `edge_kind`). Taking the
    // precomputed enum id lets the column-only worker call this without
    // touching the 292B struct; `EDGE_KIND_{CALL,CONSTRUCT}` ⟺ the old
    // `edge_kind == "call" | "construct"` match.
    edge_kind_id: u8,
    target: &GraphSymbol,
    bound_mask: u8,
    may_already_counted: bool,
    likely: bool,
    edge_key: u64,
) {
    let is_callish = edge_kind_id == EDGE_KIND_CALL || edge_kind_id == EDGE_KIND_CONSTRUCT;
    // Phase 3 aggressive: u64 key (target.id_u64) vs the prior String. Skips
    // a per-call string hash + clone on insert. id_to_string maps the u64
    // back to its "sym:HEX16" string for the global merge.
    let key = target.id_u64;
    if !id_to_string.contains_key(&key) {
        id_to_string.insert(key, target.id.clone());
    }
    let count = counts.entry(key).or_default();
    if likely && counted_likely.insert(edge_key) {
        count.usage_likely += 1;
        if is_callish {
            count.calls_in_likely += 1;
        }
    }
    if !may_already_counted && bound_mask & BOUND_MAY != 0 {
        count.usage_may += 1;
        if is_callish {
            count.calls_in_may += 1;
        }
    }
    if bound_mask & BOUND_MUST != 0 && counted_exact.insert(edge_key) {
        count.usage_must += 1;
        if is_callish {
            count.calls_in_must += 1;
        }
    }
}

fn apply_token_shape_likely_count_baseline(
    symbols: &[GraphSymbol],
    ref_sites: &[RefSite],
    counts: &mut HashMap<String, GraphCount>,
    bare_usage_by_scope_and_name: &HashMap<(u64, u64, u64), usize>,
    bare_call_by_scope_and_name: &HashMap<(u64, u64, u64), usize>,
    member_usage_by_scope_and_name: &HashMap<(u64, u64, u64), usize>,
    member_call_by_scope_and_name: &HashMap<(u64, u64, u64), usize>,
    // B5: phase C now stores global ref_sites indices (u32) rather than
    // `&RefSite` pointers. Phase F reads `ref_sites[idx]` for the rare push.
    bare_sites_by_scope_and_name: &HashMap<(u64, u64, u64), Vec<u32>>,
    member_sites_by_scope_and_name: &HashMap<(u64, u64, u64), Vec<u32>>,
    references: &mut Vec<GraphReference>,
    // F1.a: per-target tally built by phase E workers as lights are pushed.
    // Replaces the previous rescan over `light_in` (14M entries → ~3M unique
    // targets, single-thread loop). Keyed by GraphSymbol.id_u64.
    light_target_count_by_id_u64: &AHashMap<u64, usize>,
    light_out: &mut Vec<LightRef>,
    dedup: &mut AHashSet<u64>,
    reference_partials_out: &mut Vec<PathBuf>,
    // F1.b: when `Some`, phase F also streams LightRef batches into the
    // channel-driven writer. `light_out` is left empty as drained by the
    // batch flush inside `push_light_resolved_reference`.
    light_sender: Option<&crossbeam_channel::Sender<Vec<LightRef>>>,
    // B6 stage-5d: when `Some`, the rare token-shape push reads the precomputed
    // `site_partial` from `SiteCols` instead of `ref_sites[idx]` (which is
    // dropped on the channel rebuild). `None` recomputes it from `ref_sites`.
    prebuilt_site_cols: Option<&[SiteCols]>,
) {
    let mut bare_symbol_count_by_scope_and_name: AHashMap<(u64, u64, u64), usize> =
        AHashMap::default();
    let mut member_symbol_count_by_scope_and_name: AHashMap<(u64, u64, u64), usize> =
        AHashMap::default();
    // W10: same micro-cache as phase_c_process_chunk. Symbols arrive grouped by
    // file so the (rel_path, language) pair runs for consecutive symbols.
    let mut cached_rel_path: &str = "";
    let mut cached_scope_hash: u64 = 0;
    let mut cached_language: &str = "";
    let mut cached_lang_hash: u64 = 0;
    for symbol in symbols {
        let path = symbol.rel_path.as_str();
        if path != cached_rel_path {
            cached_rel_path = path;
            cached_scope_hash = stable_hash(source_scope_key(path));
        }
        let lang = symbol.language.as_str();
        if lang != cached_language {
            cached_language = lang;
            cached_lang_hash = stable_hash(lang);
        }
        let key = (cached_lang_hash, cached_scope_hash, symbol.name_hash);
        if uses_member_token_shape_for_likely_count(symbol) {
            *member_symbol_count_by_scope_and_name
                .entry(key)
                .or_default() += 1;
        } else {
            *bare_symbol_count_by_scope_and_name.entry(key).or_default() += 1;
        }
    }
    let symbols_total = symbols.len();
    let worker_count = graph_worker_count(symbols_total.max(1));
    let bare_symbol_count_ref = &bare_symbol_count_by_scope_and_name;
    let member_symbol_count_ref = &member_symbol_count_by_scope_and_name;
    let reference_counts_ref = light_target_count_by_id_u64;
    let counts_snapshot = &*counts;
    let spill_threshold = std::env::var("ZOEK_RESOLVE_SPILL_REFS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1_000_000);
    let spill_dir = std::env::var("ZOEK_RESOLVE_SPILL_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("zoek-rs-resolve-spill"));
    let _ = fs::create_dir_all(&spill_dir);
    let spill_dir_ref = &spill_dir;
    let process_chunk = |symbol_slice: &[GraphSymbol], worker_id: usize| -> io::Result<(
        Vec<(String, GraphCount)>,
        Vec<GraphReference>,
        AHashSet<u64>,
        Vec<PathBuf>,
        Vec<LightRef>,
    )> {
        let mut local_counts: Vec<(String, GraphCount)> = Vec::with_capacity(symbol_slice.len());
        // LightRef internal accumulator — 24 bytes/record vs 200 for
        // GraphReference. Materialized into `local_refs` at the worker
        // boundary so downstream (main thread) still receives the existing
        // `Vec<GraphReference>` shape.
        let mut local_light_refs: Vec<LightRef> = Vec::new();
        let mut local_dedup: AHashSet<u64> = AHashSet::default();
        let mut spill_paths: Vec<PathBuf> = Vec::new();
        // Spill helper: materializes a light batch to GraphReference before
        // writing the existing bincode spill format (keeps downstream spill
        // load unchanged).
        let mut maybe_spill = |lights: &mut Vec<LightRef>, paths: &mut Vec<PathBuf>| -> io::Result<()> {
            if lights.len() < spill_threshold {
                return Ok(());
            }
            let materialized: Vec<GraphReference> = lights
                .drain(..)
                .map(|l| materialize_light_ref(&l, ref_sites))
                .collect();
            let path = spill_dir_ref.join(format!(
                "phase_f_w{}_p{}.bin",
                worker_id,
                paths.len()
            ));
            let f = fs::File::create(&path)?;
            let mut w = std::io::BufWriter::with_capacity(1024 * 1024, f);
            bincode::serialize_into(&mut w, &materialized).map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("phase_f spill: {e}"))
            })?;
            w.flush()?;
            paths.push(path);
            Ok(())
        };
        // W10: micro-cache for (rel_path → scope_hash) and (language →
        // lang_hash). Matches the build-side cache so the lookup keys are
        // computed once per file/language group.
        let mut cached_rel_path: &str = "";
        let mut cached_scope_hash: u64 = 0;
        let mut cached_language: &str = "";
        let mut cached_lang_hash: u64 = 0;
        for symbol in symbol_slice {
            let path = symbol.rel_path.as_str();
            if path != cached_rel_path {
                cached_rel_path = path;
                cached_scope_hash = stable_hash(source_scope_key(path));
            }
            let lang = symbol.language.as_str();
            if lang != cached_language {
                cached_language = lang;
                cached_lang_hash = stable_hash(lang);
            }
            let key = (cached_lang_hash, cached_scope_hash, symbol.name_hash);
            let (usage_baseline, call_baseline, baseline_sites, symbol_count_for_key) =
                if uses_member_token_shape_for_likely_count(symbol) {
                    (
                        member_usage_by_scope_and_name
                            .get(&key)
                            .copied()
                            .unwrap_or(0),
                        member_call_by_scope_and_name
                            .get(&key)
                            .copied()
                            .unwrap_or(0),
                        member_sites_by_scope_and_name.get(&key),
                        member_symbol_count_ref.get(&key).copied().unwrap_or(0),
                    )
                } else {
                    (
                        bare_usage_by_scope_and_name.get(&key).copied().unwrap_or(0),
                        bare_call_by_scope_and_name.get(&key).copied().unwrap_or(0),
                        bare_sites_by_scope_and_name.get(&key),
                        bare_symbol_count_ref.get(&key).copied().unwrap_or(0),
                    )
                };
            let mut count = counts_snapshot
                .get(&symbol.id)
                .copied()
                .unwrap_or_default();
            count.usage_likely = count.usage_must.max(usage_baseline);
            count.calls_in_likely = count.calls_in_must.max(call_baseline);
            let mut reference_count = reference_counts_ref
                .get(&symbol.id_u64)
                .copied()
                .unwrap_or(0);
            if reference_count < count.usage_likely {
                if let Some(sites) = baseline_sites {
                    let fanout = sites.len().saturating_mul(symbol_count_for_key);
                    if fanout <= MAX_TOKEN_SHAPE_REFERENCE_FANOUT_PER_KEY {
                        for &site_idx in sites {
                            if reference_count >= count.usage_likely {
                                break;
                            }
                            // B5: phase C stored the global ref_sites index.
                            // B6 stage-5d: the `site_partial` is precomputed in
                            // `SiteCols`; read it from the column when present
                            // (channel rebuild dropped `ref_sites`), else
                            // recompute from `ref_sites[idx]` (same bijective
                            // u64-keyed value as site_cols/phase_e).
                            let site_partial = match prebuilt_site_cols {
                                Some(sc) => sc[site_idx as usize].site_partial,
                                None => {
                                    let site = &ref_sites[site_idx as usize];
                                    site_partial_hash_u64(site.source_ref_id, &site.edge_kind)
                                }
                            };
                            let edge_key = edge_key_from_partial(site_partial, &symbol.id);
                            if push_light_resolved_reference(
                                &mut local_light_refs,
                                &mut local_dedup,
                                None,
                                light_sender,
                                site_idx,
                                symbol,
                                BOUND_MAY,
                                LightConfidence::Possible,
                                LightProvenance::TokenShape,
                                edge_key,
                            ) {
                                reference_count += 1;
                            }
                        }
                    }
                }
            }
            // Downstream consumers `counts.get(id).unwrap_or_default()`, so skip
            // emitting default entries — saves String clone per zero-usage symbol.
            if count != GraphCount::default() {
                local_counts.push((symbol.id.clone(), count));
            }
            maybe_spill(&mut local_light_refs, &mut spill_paths)?;
        }
        maybe_spill(&mut local_light_refs, &mut spill_paths)?;
        // F1.b: drain the F worker's residual light batch into the channel-driven
        // writer when streaming. local_light_refs is left empty so the
        // main-thread `light_out.append(local_light_refs)` becomes a no-op.
        if let Some(s) = light_sender {
            if !local_light_refs.is_empty() {
                let batch = std::mem::take(&mut local_light_refs);
                let _ = s.send(batch);
            }
        }
        // Phase 4-Q: skip worker materialization (same reasoning as phase E
        // worker above). `local_light_refs` carries the data; `local_refs`
        // is empty.
        let local_refs: Vec<GraphReference> = Vec::new();
        Ok((local_counts, local_refs, local_dedup, spill_paths, local_light_refs))
    };
    let worker_outputs: io::Result<Vec<(
        Vec<(String, GraphCount)>,
        Vec<GraphReference>,
        AHashSet<u64>,
        Vec<PathBuf>,
        Vec<LightRef>,
    )>> = if symbols_total == 0 || worker_count <= 1 {
        process_chunk(symbols, 0).map(|t| vec![t])
    } else {
        // Rayon work-stealing: split into more chunks than threads so faster
        // workers can grab additional work (same pattern as phase E).
        use rayon::prelude::*;
        let chunks_per_worker = 8usize;
        let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
        let chunk_size = symbols_total.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize, usize)> = (0..)
            .map(|i| {
                let start = i * chunk_size;
                let end = (start + chunk_size).min(symbols_total);
                (i, start, end)
            })
            .take_while(|(_, start, _)| *start < symbols_total)
            .collect();
        let pc = &process_chunk;
        ranges
            .into_par_iter()
            .map(|(idx, start, end)| pc(&symbols[start..end], idx))
            .collect()
    };
    let worker_outputs = worker_outputs.expect("phase F spill failed");
    for (local_counts, mut local_refs, local_dedup, mut spill_paths, mut local_light_refs) in worker_outputs {
        for (id, c) in local_counts {
            counts.insert(id, c);
        }
        // Hand spilled batches up to the streaming sidecar writer (consumed once).
        reference_partials_out.append(&mut spill_paths);
        references.append(&mut local_refs);
        light_out.append(&mut local_light_refs);
        dedup.extend(local_dedup);
    }
}

fn uses_member_token_shape_for_likely_count(symbol: &GraphSymbol) -> bool {
    matches!(symbol.kind.as_str(), "method" | "field" | "property")
}

fn source_scope_key(rel_path: &str) -> &str {
    rel_path.split('/').next().unwrap_or(rel_path)
}

fn resolve_import_targets<'a>(
    import_facts: &'a [ImportFact],
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
) -> HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>> {
    let mut out: HashMap<(&str, &str), Vec<&GraphSymbol>> = HashMap::new();
    for fact in import_facts {
        let _ = &fact.file_id;
        let mut targets = Vec::new();
        for module_path in &fact.module_candidates {
            if let Some(symbols) =
                symbols_by_file_and_name.get(&(module_path.as_str(), fact.imported_name.as_str()))
            {
                targets.extend(symbols.iter().copied());
            }
        }
        targets.sort_by(|left, right| left.id.cmp(&right.id));
        targets.dedup_by(|left, right| left.id == right.id);
        if !targets.is_empty() {
            out.entry((fact.rel_path.as_str(), fact.local_name.as_str()))
                .or_default()
                .extend(targets);
        }
    }
    for targets in out.values_mut() {
        targets.sort_by(|left, right| left.id.cmp(&right.id));
        targets.dedup_by(|left, right| left.id == right.id);
    }
    out
}

// B6 stage-2: `edge_key_hash` and the string-keyed `site_partial_hash` were
// retired — source_ref_id is now a u64, so the only callers use the u64-keyed
// `site_partial_hash_u64` + `edge_key_from_partial` instead.

/// B6 stage-2: the underlying u64 of `stable_ref_id` (= `stable_hash(key)`),
/// without ever building the `"ref:HEX16"` string. `RefSite.source_ref_id` is
/// stored as this u64 (saving ~24B inline + ~24B heap per site, and a 38M
/// per-site string allocation at parse). `parse_stable_ref_id_to_u64` of the
/// old string equals this value, so the on-disk encoding is byte-identical.
#[inline]
fn stable_ref_id_u64(rel_path: &str, line: u32, column: u32, name: &str) -> u64 {
    stable_hash(&format!("{rel_path}\0{line}\0{column}\0{name}"))
}

/// B6 stage-2: `site_partial_hash` over the u64 source-ref-id. The value differs
/// from the string-keyed `site_partial_hash` (it mixes the u64, not the
/// "ref:HEX16" bytes), but source_ref_id ↔ u64 is a bijection so the per-site
/// `site_partial` stays unique — the dedup behaviour (and thus the reference
/// invariant) is unchanged; only the key values are relabeled.
#[inline]
fn site_partial_hash_u64(source_ref_id: u64, edge_kind: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = ahash::AHasher::default();
    h.write_u64(source_ref_id);
    edge_kind.hash(&mut h);
    h.finish()
}

#[inline]
fn edge_key_from_partial(site_partial: u64, target_id: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = ahash::AHasher::default();
    h.write_u64(site_partial);
    target_id.hash(&mut h);
    h.finish()
}

/// Phase 3 aggressive: u64 variant of `edge_key_from_partial`. Saves a string
/// hash (~80ns) per (site, target) call when caller has the symbol's cached
/// `id_u64`. ~14M calls in phase E → ~1.1s CPU per worker.
#[inline]
fn edge_key_from_partial_u64(site_partial: u64, target_id_u64: u64) -> u64 {
    use std::hash::Hasher;
    let mut h = ahash::AHasher::default();
    h.write_u64(site_partial);
    h.write_u64(target_id_u64);
    h.finish()
}

/// Push a `LightRef` into the in-flight buffer, returning whether the record
/// survived `dedup`. Mirrors `push_resolved_reference` but uses the compact
/// representation. Phase E / F integration uses this once the parallel
/// LightRef Vec is wired alongside the existing `Vec<GraphReference>`.
///
/// F1.b: when `flush_sender` is `Some`, the `refs` buffer is treated as a
/// rolling batch — once it reaches `LIGHT_BATCH_FLUSH_SIZE` records the buffer
/// is moved into the channel and replaced with a freshly allocated one. This
/// lets phase E worker threads stream LightRefs into the channel-driven
/// writer (Phase 5-A) instead of accumulating a multi-GB Vec per worker.
#[allow(dead_code)] // Wired in stages with the LightRef refactor.
fn push_light_resolved_reference(
    refs: &mut Vec<LightRef>,
    dedup: &mut AHashSet<u64>,
    target_tally: Option<&mut AHashMap<u64, usize>>,
    flush_sender: Option<&crossbeam_channel::Sender<Vec<LightRef>>>,
    site_idx: u32,
    target: &GraphSymbol,
    bound_mask: u8,
    confidence: LightConfidence,
    provenance: LightProvenance,
    edge_key: u64,
) -> bool {
    if !dedup.insert(edge_key) {
        return false;
    }
    refs.push(LightRef {
        site_idx,
        target_symbol_id: Some(target.id.as_str().into()),
        bound_mask,
        confidence,
        provenance,
    });
    if let Some(tally) = target_tally {
        *tally.entry(target.id_u64).or_default() += 1;
    }
    if let Some(s) = flush_sender {
        if refs.len() >= LIGHT_BATCH_FLUSH_SIZE {
            let batch = std::mem::replace(refs, Vec::with_capacity(LIGHT_BATCH_FLUSH_SIZE));
            let _ = s.send(batch);
        }
    }
    true
}

/// F1.b: number of `LightRef` records a phase E/F worker accumulates before
/// flushing the batch to the channel-driven writer. ~4K × 24B = ~96KB per
/// batch — small enough to keep the channel queue (bounded 64 batches) well
/// under 10MB total, large enough to keep send/recv overhead negligible
/// (3.5K send calls instead of 14M per-record sends).
const LIGHT_BATCH_FLUSH_SIZE: usize = 4096;

/// Convert a confidence string literal to `LightConfidence`. Used at the
/// push call sites while the legacy `&str` API coexists with `LightRef`.
#[allow(dead_code)]
fn confidence_from_str(s: &str) -> LightConfidence {
    match s {
        "exact" => LightConfidence::Exact,
        "possible" => LightConfidence::Possible,
        other => unreachable!("unknown confidence: {other}"),
    }
}

/// Convert a provenance string literal to `LightProvenance`. The match is
/// exhaustive over the closed set of provenance values emitted by phase E
/// (call sites in `push_resolved_reference`) and phase F (token-shape).
#[allow(dead_code)]
fn provenance_from_str(s: &str) -> LightProvenance {
    match s {
        "import" => LightProvenance::Import,
        "import-star" => LightProvenance::ImportStar,
        "import-namespace" => LightProvenance::ImportNamespace,
        "imported-type" => LightProvenance::ImportedType,
        "receiver-self" => LightProvenance::ReceiverSelf,
        "receiver-type" => LightProvenance::ReceiverType,
        "type-fact" => LightProvenance::TypeFact,
        "lexical" => LightProvenance::Lexical,
        "unique-name" => LightProvenance::UniqueName,
        "token-shape" => LightProvenance::TokenShape,
        "external-tsv" => LightProvenance::ExternalTsv,
        other => unreachable!("unknown provenance: {other}"),
    }
}

/// Push a `LightRef` without checking dedup. Caller has already validated
/// against dedup (e.g. via `push_resolved_reference` returning true) and
/// wants the light record in addition to the full one — the dedup
/// invariant carries over because the same edge_key already gated the
/// `push_resolved_reference` insert.
#[allow(dead_code)]
fn push_light_no_dedup(
    refs: &mut Vec<LightRef>,
    site_idx: u32,
    target: &GraphSymbol,
    bound_mask: u8,
    confidence: LightConfidence,
    provenance: LightProvenance,
) {
    refs.push(LightRef {
        site_idx,
        target_symbol_id: Some(target.id.as_str().into()),
        bound_mask,
        confidence,
        provenance,
    });
}

/// Spill a `Vec<LightRef>` to disk via bincode (mirrors the existing
/// `Vec<GraphReference>` spill helper used inside phase E / F workers).
#[allow(dead_code)]
fn spill_light_refs_to_file(refs: &Vec<LightRef>, path: &Path) -> io::Result<()> {
    let f = fs::File::create(path)?;
    let mut w = std::io::BufWriter::with_capacity(1024 * 1024, f);
    bincode::serialize_into(&mut w, refs)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("light refs spill: {e}")))?;
    w.flush()?;
    Ok(())
}

/// Load a previously spilled `Vec<LightRef>` from disk and delete the
/// backing file. Returns an empty vec if the file is missing.
#[allow(dead_code)]
fn load_light_refs_from_file(path: &Path) -> io::Result<Vec<LightRef>> {
    let bytes = fs::read(path)?;
    let _ = fs::remove_file(path);
    let refs: Vec<LightRef> = bincode::deserialize(&bytes).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("light refs load: {e}"))
    })?;
    Ok(refs)
}

/// Materialize a `LightRef` into a full `GraphReference` using the owning
/// `ref_sites` slice. This bridges the compact in-flight form to the
/// existing write/serialize paths until those are also migrated.
#[allow(dead_code)] // Wired in stages with the LightRef refactor.
fn materialize_light_ref(light: &LightRef, ref_sites: &[RefSite]) -> GraphReference {
    let site = &ref_sites[light.site_idx as usize];
    GraphReference {
        source_ref_id: format!("ref:{:016x}", site.source_ref_id).into(), // B6 stage-2: u64→string (cold)
        target_symbol_id: light.target_symbol_id.clone(),
        edge_kind: (&*site.edge_kind).into(),
        name: site.name.as_str().into(),
        raw_text: site.name.as_str().into(), // B6: raw_text == name (field dropped)
        // P1: RefSite no longer carries `uri` (dead). GraphReference.uri is
        // lazily filled from rel_path at write time (see file_uri fixup), so an
        // empty value here is the existing contract.
        uri: Box::from(""),
        rel_path: (&*site.rel_path).into(),
        start_line: site.start_line,
        start_column: site.start_column,
        end_line: site.end_line,
        end_column: site.end_column,
        enclosing_symbol_id: enclosing_id_to_string(site.enclosing_id).map(|s| s.into()), // B6 stage-3: u64→string (cold)
        bound_mask: light.bound_mask,
        confidence: light.confidence.as_str().into(),
        provenance: light.provenance.as_str().into(),
    }
}

fn push_resolved_reference(
    references: &mut Vec<GraphReference>,
    dedup: &mut AHashSet<u64>,
    site: &RefSite,
    target: &GraphSymbol,
    bound_mask: u8,
    confidence: &str,
    provenance: &str,
    edge_key: u64,
) -> bool {
    if !dedup.insert(edge_key) {
        return false;
    }
    references.push(GraphReference {
        source_ref_id: format!("ref:{:016x}", site.source_ref_id).into(), // B6 stage-2: u64→string (cold)
        target_symbol_id: Some(target.id.as_str().into()),
        edge_kind: (&*site.edge_kind).into(),
        name: site.name.as_str().into(),
        raw_text: site.name.as_str().into(), // B6: raw_text == name (field dropped)
        uri: Box::from(""),
        rel_path: (&*site.rel_path).into(),
        start_line: site.start_line,
        start_column: site.start_column,
        end_line: site.end_line,
        end_column: site.end_column,
        enclosing_symbol_id: enclosing_id_to_string(site.enclosing_id).map(|s| s.into()), // B6 stage-3: u64→string (cold)
        bound_mask,
        confidence: confidence.into(),
        provenance: provenance.into(),
    });
    true
}

fn compute_counts(
    symbols: &[GraphSymbol],
    references: &[GraphReference],
    hierarchy_facts: &[HierarchyFact],
) -> HashMap<String, GraphCount> {
    let mut counts: HashMap<String, GraphCount> = HashMap::new();
    for symbol in symbols {
        counts.entry(symbol.id.clone()).or_default();
    }
    for reference in references {
        if let Some(target) = &reference.target_symbol_id {
            let count = counts.entry(target.to_string()).or_default();
            if reference.bound_mask & BOUND_MUST != 0 {
                count.usage_must += 1;
            }
            if reference.bound_mask & BOUND_MAY != 0 {
                count.usage_may += 1;
                count.usage_likely += 1;
            }
            if matches!(reference.edge_kind.as_ref(), "call" | "construct") {
                if reference.bound_mask & BOUND_MUST != 0 {
                    count.calls_in_must += 1;
                }
                if reference.bound_mask & BOUND_MAY != 0 {
                    count.calls_in_may += 1;
                    count.calls_in_likely += 1;
                }
            }
        }
        if let Some(source) = &reference.enclosing_symbol_id {
            let count = counts.entry(source.to_string()).or_default();
            if matches!(reference.edge_kind.as_ref(), "call" | "construct") {
                if reference.bound_mask & BOUND_MUST != 0 {
                    count.calls_out_must += 1;
                }
                if reference.bound_mask & BOUND_MAY != 0 {
                    count.calls_out_may += 1;
                }
            }
        }
    }

    if symbols.len() <= MAX_EAGER_IMPLEMENTATION_SYMBOLS {
        apply_implementation_counts(symbols, hierarchy_facts, &mut counts);
    }
    counts
}

fn compute_native_counts(
    symbols: &[GraphSymbol],
    counts: &mut HashMap<String, GraphCount>,
    hierarchy_facts: &[HierarchyFact],
) {
    // Phase 3 aggressive: previously we inserted a default zero count for
    // every symbol so reads would return zero instead of "not found". But
    // write_count_id_shards drops all-zero entries anyway, so this whole
    // pass is now a no-op for symbols without any incoming references. Skip
    // it entirely — readers already treat a missing key as zero counts.
    if symbols.len() <= MAX_EAGER_IMPLEMENTATION_SYMBOLS {
        apply_implementation_counts(symbols, hierarchy_facts, counts);
    }
}

fn apply_implementation_counts(
    symbols: &[GraphSymbol],
    hierarchy_facts: &[HierarchyFact],
    counts: &mut HashMap<String, GraphCount>,
) {
    for symbol in symbols {
        if !is_type_kind_sym(symbol) && symbol.kind != "method" {
            continue;
        }
        let descendants = descendant_type_names(symbol, symbols, hierarchy_facts);
        let implementations = if is_type_kind_sym(symbol) {
            symbols
                .iter()
                .filter(|candidate| {
                    candidate.id != symbol.id
                        && is_type_kind_sym(candidate)
                        && descendants.contains(&candidate.qualified_name)
                })
                .count()
        } else {
            symbols
                .iter()
                .filter(|candidate| {
                    candidate.id != symbol.id
                        && candidate.kind == "method"
                        && candidate.name == symbol.name
                        && candidate
                            .container_name
                            .as_ref()
                            .is_some_and(|name| descendants.contains(name))
                })
                .count()
        };
        let count = counts.entry(symbol.id.clone()).or_default();
        count.impl_may = implementations;
        count.impl_must = implementations;
    }
}

#[allow(clippy::too_many_arguments)]
fn write_store(
    workspace_root: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    file_count: usize,
    symbols: &[GraphSymbol],
    references: &[GraphReference],
    ref_sites: &[RefSite],
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    counts: &HashMap<String, GraphCount>,
    incremental: Option<&HashSet<String>>,
    references_streamed: bool,
    reference_count_override: Option<usize>,
    // Phase 3 aggressive: when Some, the caller has already (a) built the
    // file_table including all rel_paths, (b) persisted it to disk, and
    // (c) cleared the layout's prior shard families. write_store will skip
    // those steps to enable parallel execution with stream_*_to_sidecars.
    precomputed_file_table: Option<&FileTable>,
    // W23: ref_site shards already written (overlapped with resolve). Forwarded
    // to write_graph_shards to skip the 38M-record ref_site write here.
    skip_ref_sites: bool,
) -> io::Result<GraphIndexSummary> {
    let layout_root = config.index_root(workspace_root);
    fs::create_dir_all(&layout_root)?;
    let file_table_path = graph_file_table_path(workspace_root, config);
    let (built_table, file_table_bytes) = if precomputed_file_table.is_some() {
        (None, file_len(&file_table_path).unwrap_or(0))
    } else {
        let mut t = if incremental.is_some() && file_table_path.exists() {
            read_file_table_binary(&file_table_path).unwrap_or_default()
        } else {
            FileTable::default()
        };
        for site in ref_sites {
            t.intern(&site.rel_path);
        }
        for r in references {
            t.intern(&r.rel_path);
        }
        for sym in symbols {
            t.intern(&sym.rel_path);
        }
        for fact in import_facts {
            t.intern(&fact.rel_path);
        }
        for fact in type_facts {
            t.intern(&fact.rel_path);
        }
        for fact in function_return_facts {
            t.intern(&fact.rel_path);
        }
        let bytes = write_file_table_binary(&file_table_path, &t)?;
        (Some(t), bytes)
    };
    let file_table: &FileTable = precomputed_file_table.unwrap_or_else(|| {
        built_table.as_ref().expect("file_table built when no precomputed")
    });
    if precomputed_file_table.is_none() && incremental.is_none() {
        clear_graph_shard_families(&layout_root)?;
    }
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    let relation_path = graph_index_path(workspace_root, config);
    let count_path = graph_count_index_path(workspace_root, config);
    for legacy_path in [&symbol_path, &relation_path, &count_path] {
        if legacy_path.exists() {
            let _ = fs::remove_file(legacy_path);
        }
    }
    let shard_bytes = write_graph_shards(
        workspace_root,
        config,
        symbols,
        references,
        ref_sites,
        import_facts,
        type_facts,
        function_return_facts,
        counts,
        &file_table,
        incremental,
        references_streamed,
        skip_ref_sites,
    )?;

    let indexed_at_unix_secs = unix_secs_now();
    let bytes = shard_bytes + file_table_bytes;
    let reference_count_emitted = reference_count_override.unwrap_or(references.len());
    let manifest = format!(
        "{{\"engine\":\"zoek-rs\",\"type\":\"semantic-serving-graph\",\"version\":{},\"workspaceRoot\":{},\"indexedAtUnixSecs\":{},\"builtAtUnixMs\":{},\"fileCount\":{},\"symbolCount\":{},\"referenceCount\":{},\"bytes\":{}}}",
        GRAPH_VERSION,
        crate::protocol::json_string(&workspace_root.to_string_lossy()),
        indexed_at_unix_secs,
        built_at_unix_ms,
        file_count,
        symbols.len(),
        reference_count_emitted,
        bytes
    );
    write_atomically(
        &graph_manifest_path(workspace_root, config),
        manifest.as_bytes(),
    )?;
    Ok(GraphIndexSummary {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_path: relation_path.to_string_lossy().into_owned(),
        indexed_at_unix_secs,
        built_at_unix_ms,
        file_count,
        symbol_count: symbols.len(),
        reference_count: reference_count_emitted,
        bytes,
    })
}

fn read_symbol_store(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<Option<GraphStore>> {
    if !graph_index_available(workspace_root, config) {
        return Ok(None);
    }
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let symbols = if symbol_path.exists() {
        read_symbols(&symbol_path, &file_table)?
    } else {
        read_all_symbols_from_id_shards(workspace_root, config, &file_table)?
    };
    let hierarchy_facts = hierarchy_facts_from_symbols(&symbols);
    let count_path = graph_count_index_path(workspace_root, config);
    let counts = if count_path.exists() {
        read_counts(&count_path)?
    } else if graph_shard_family_available(workspace_root, config, GRAPH_COUNT_ID_SHARD_PREFIX) {
        read_all_counts_from_id_shards(workspace_root, config)?
    } else {
        HashMap::new()
    };
    Ok(Some(GraphStore {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        symbols,
        hierarchy_facts,
        counts,
    }))
}

fn clear_graph_shard_families(layout_root: &Path) -> io::Result<()> {
    if !layout_root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(layout_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_graph_shard_file_name(name) {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn is_graph_shard_file_name(name: &str) -> bool {
    let shard_suffix = name.ends_with(".tsv") || name.ends_with(".tsv.tmp");
    shard_suffix
        && [
            GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
            GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
            GRAPH_SYMBOL_ID_SHARD_PREFIX,
            GRAPH_SYMBOL_URI_SHARD_PREFIX,
            GRAPH_COUNT_ID_SHARD_PREFIX,
            GRAPH_HIERARCHY_PARENT_SHARD_PREFIX,
            GRAPH_METHOD_CONTAINER_SHARD_PREFIX,
            GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX,
            GRAPH_FACTS_BY_FILE_SHARD_PREFIX,
        ]
        .iter()
        .any(|prefix| name.starts_with(*prefix))
}

struct GraphShardWriter {
    final_path: PathBuf,
    temp_path: PathBuf,
    writer: BufWriter<fs::File>,
}

fn open_graph_shard_writers(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
) -> io::Result<Vec<GraphShardWriter>> {
    let mut writers = Vec::with_capacity(GRAPH_SHARD_COUNT);
    for shard in 0..GRAPH_SHARD_COUNT {
        let final_path = graph_shard_path(workspace_root, config, prefix, shard);
        let temp_path = final_path.with_file_name(format!("{prefix}-{shard:03}.tsv.tmp"));
        let writer = BufWriter::with_capacity(1024 * 1024, fs::File::create(&temp_path)?);
        writers.push(GraphShardWriter {
            final_path,
            temp_path,
            writer,
        });
    }
    Ok(writers)
}

/// Streaming append helpers for the rebuild_graph_native fast path.
/// Each takes already-open shard writers so callers can append batches from
/// a sequence of partials without rebuilding the full data set in memory.
fn append_symbols_to_id_shards(
    symbols: &[GraphSymbol],
    shards: &mut [GraphShardWriter],
    file_table: &FileTable,
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(300);
    for symbol in symbols {
        scratch.clear();
        let id = file_table.get_id(&symbol.rel_path).unwrap_or(u32::MAX);
        serialize_symbol_binary(symbol, id, &mut scratch);
        let shard = shard_index_for_key(&symbol.id);
        shards[shard].writer.write_all(&scratch)?;
    }
    Ok(())
}

fn append_symbols_to_uri_shards(
    symbols: &[GraphSymbol],
    shards: &mut [GraphShardWriter],
    file_table: &FileTable,
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(300);
    for symbol in symbols {
        scratch.clear();
        let id = file_table.get_id(&symbol.rel_path).unwrap_or(u32::MAX);
        serialize_symbol_binary(symbol, id, &mut scratch);
        let shard = shard_index_for_key(&symbol.uri);
        shards[shard].writer.write_all(&scratch)?;
    }
    Ok(())
}

fn append_ref_sites_to_file_shards(
    ref_sites: &[RefSite],
    shards: &mut [GraphShardWriter],
    file_table: &FileTable,
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(200);
    for site in ref_sites {
        scratch.clear();
        let id = file_table.get_id(&site.rel_path).unwrap_or(u32::MAX);
        serialize_ref_site_binary(site, id, &mut scratch);
        let shard = shard_index_for_key(&site.rel_path);
        shards[shard].writer.write_all(&scratch)?;
    }
    Ok(())
}

fn append_facts_to_file_shards(
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    shards: &mut [GraphShardWriter],
    file_table: &FileTable,
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(160);
    for fact in import_facts {
        let shard = shard_index_for_key(&fact.rel_path);
        let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
        scratch.clear();
        scratch.push(b'I');
        serialize_import_fact_binary(fact, id, &mut scratch);
        shards[shard].writer.write_all(&scratch)?;
    }
    for fact in type_facts {
        let shard = shard_index_for_key(&fact.rel_path);
        let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
        scratch.clear();
        scratch.push(b'T');
        serialize_type_fact_binary(fact, id, &mut scratch);
        shards[shard].writer.write_all(&scratch)?;
    }
    for fact in function_return_facts {
        let shard = shard_index_for_key(&fact.rel_path);
        let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
        scratch.clear();
        scratch.push(b'F');
        serialize_function_return_fact_binary(fact, id, &mut scratch);
        shards[shard].writer.write_all(&scratch)?;
    }
    Ok(())
}

fn append_hierarchy_to_parent_shards(
    symbols: &[GraphSymbol],
    shards: &mut [GraphShardWriter],
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(120);
    for symbol in symbols {
        if !is_type_kind_sym(symbol) {
            continue;
        }
        for parent_name in symbol.extends_names.iter().chain(&symbol.implements_names) {
            for lookup_key in graph_name_lookup_keys(parent_name) {
                scratch.clear();
                write_u16_str(&mut scratch, &lookup_key);
                write_u16_str(&mut scratch, parent_name);
                write_u16_str(&mut scratch, &symbol.id);
                write_u16_str(&mut scratch, &symbol.qualified_name);
                let shard = shard_index_for_key(&lookup_key);
                shards[shard].writer.write_all(&scratch)?;
            }
        }
    }
    Ok(())
}

/// Parallel shard writer: two threads, one per sidecar (target + enclosing).
/// Each thread serializes independently into its own scratch buffer and writes
/// to a disjoint writer slice, so there is no contention. Doubles serialize
/// CPU but overlaps that with the other side's serialize + IO syscalls.
///
/// Each thread also caches `(rel_path → file_id)` from the previous reference
/// to skip the FileTable HashMap lookup when consecutive refs share a path
/// (common because phase E/F emit refs grouped by file).
fn append_references_to_both_shards(
    references: &[GraphReference],
    target_shards: &mut [GraphShardWriter],
    enclosing_shards: &mut [GraphShardWriter],
    file_table: &FileTable,
) -> io::Result<()> {
    std::thread::scope(|s| -> io::Result<()> {
        let target_handle = s.spawn(move || -> io::Result<()> {
            let mut scratch: Vec<u8> = Vec::with_capacity(200);
            let mut cached_path: &str = "";
            let mut cached_id: u32 = u32::MAX;
            for r in references {
                let Some(target_id) = r.target_symbol_id.as_deref() else {
                    continue;
                };
                scratch.clear();
                let path = &*r.rel_path;
                let id = if path == cached_path {
                    cached_id
                } else {
                    let new_id = file_table.get_id(path).unwrap_or(u32::MAX);
                    cached_path = path;
                    cached_id = new_id;
                    new_id
                };
                serialize_reference_binary(r, id, &mut scratch);
                let shard = shard_index_for_key(target_id);
                target_shards[shard].writer.write_all(&scratch)?;
            }
            Ok(())
        });
        let enclosing_handle = s.spawn(move || -> io::Result<()> {
            let mut scratch: Vec<u8> = Vec::with_capacity(200);
            let mut cached_path: &str = "";
            let mut cached_id: u32 = u32::MAX;
            for r in references {
                if !matches!(&*r.edge_kind, "call" | "construct") {
                    continue;
                }
                let Some(enc) = r.enclosing_symbol_id.as_deref() else {
                    continue;
                };
                scratch.clear();
                let path = &*r.rel_path;
                let id = if path == cached_path {
                    cached_id
                } else {
                    let new_id = file_table.get_id(path).unwrap_or(u32::MAX);
                    cached_path = path;
                    cached_id = new_id;
                    new_id
                };
                serialize_reference_binary(r, id, &mut scratch);
                let shard = shard_index_for_key(enc);
                enclosing_shards[shard].writer.write_all(&scratch)?;
            }
            Ok(())
        });
        target_handle.join().expect("target shard writer panicked")?;
        enclosing_handle.join().expect("enclosing shard writer panicked")?;
        Ok(())
    })
}

/// B6 stage-5a: build the per-site `RefWriteCol` column the reference write
/// path reads, so it dereferences no `RefSite`. `name_id` comes from the
/// stage-4 column (interner-backed); `file_id` is resolved once here (was a
/// per-record `FileTable` probe in `append_lights_to_both_shards`). Pure
/// `par_iter` copy of precomputed fields — no extra scan beyond this one.
fn build_ref_write_cols(
    ref_sites: &[RefSite],
    // B6 stage-5c: the file_id column (built once from the file_table), shared
    // with the resolve worker's rel_path reconstruction so file_id is resolved
    // exactly once per site.
    site_file_ids: &[u32],
    site_name_ids: &[u32],
) -> Vec<RefWriteCol> {
    use rayon::prelude::*;
    ref_sites
        .par_iter()
        .zip(site_file_ids.par_iter())
        .zip(site_name_ids.par_iter())
        .map(|((s, &file_id), &name_id)| {
            let mut flags = 0u8;
            if s.is_definition {
                flags |= SITE_FLAG_IS_DEFINITION;
            }
            if s.receiver_name.is_some() {
                flags |= SITE_FLAG_HAS_RECEIVER;
            }
            if s.is_import_context {
                flags |= SITE_FLAG_IS_IMPORT_CONTEXT;
            }
            RefWriteCol {
                source_ref_id: s.source_ref_id,
                enclosing_id: s.enclosing_id,
                name_id,
                file_id,
                start_line: s.start_line,
                start_column: s.start_column,
                end_line: s.end_line,
                end_column: s.end_column,
                edge_kind_id: s.edge_kind_id,
                language_id: compute_language_id(&s.language),
                access_kind_id: s.access_kind_id,
                flags,
            }
        })
        .collect()
}

/// B6 stage-5c: the per-site `file_id` column (`stream_file_table.get_id`),
/// feeding both `build_ref_write_cols` and the resolve worker's `rel_path`
/// reconstruction (`FileTable::get_path`). Built once per rebuild path.
fn build_site_file_ids(ref_sites: &[RefSite], file_table: &FileTable) -> Vec<u32> {
    use rayon::prelude::*;
    ref_sites
        .par_iter()
        .map(|s| file_table.get_id(&s.rel_path).unwrap_or(u32::MAX))
        .collect()
}

/// B6 stage-5d: the dense `SiteCols` column the hot resolve path reads. Was
/// built inside `resolve_ref_sites_a_to_e`; extracted so the channel rebuild
/// can build it BEFORE resolve and pass it in, letting `Vec<RefSite>` be
/// dropped before the resolve phases (the column is all that resolve then
/// needs). Behaviour-identical to the prior inline build.
fn build_site_cols(ref_sites: &[RefSite]) -> Vec<SiteCols> {
    use rayon::prelude::*;
    ref_sites
        .par_iter()
        .map(|s| {
            let mut flags = 0u8;
            if s.is_definition {
                flags |= SITE_FLAG_IS_DEFINITION;
            }
            if s.receiver_name.is_some() {
                flags |= SITE_FLAG_HAS_RECEIVER;
            }
            if s.is_import_context {
                flags |= SITE_FLAG_IS_IMPORT_CONTEXT;
            }
            SiteCols {
                name_hash: s.name_hash,
                rel_path_hash: s.rel_path_hash,
                receiver_name_hash: s.receiver_name_hash,
                enclosing_id: s.enclosing_id,
                site_partial: site_partial_hash_u64(s.source_ref_id, &s.edge_kind),
                language_id: compute_language_id(s.language.as_str()),
                access_kind_id: s.access_kind_id,
                edge_kind_id: s.edge_kind_id,
                flags,
            }
        })
        .collect()
}

/// `LightRef`-aware variant of `append_references_to_both_shards`. Each
/// record's site-derived fields come from the `RefWriteCol` column (stage-5a)
/// via `light.site_idx`, and bytes are serialized via
/// `serialize_reference_binary_from_light` without materializing a
/// `GraphReference`. Same 2-thread split (target + enclosing).
#[allow(dead_code)] // Wired in by Phase 4-L stream_lights_to_sidecars.
fn append_lights_to_both_shards(
    lights: &[LightRef],
    // B6 stage-5a: per-site write columns (was `ref_sites` + `site_name_ids` +
    // `file_table`). `name` comes from the interner via `col.name_id`; the
    // `file_id` is precomputed (no per-record `FileTable` probe).
    write_cols: &[RefWriteCol],
    name_interner: &NameInterner,
    target_shards: &mut [GraphShardWriter],
    enclosing_shards: &mut [GraphShardWriter],
) -> io::Result<usize> {
    use rayon::prelude::*;
    let n_target = target_shards.len();
    let n_encl = enclosing_shards.len();
    if lights.is_empty() {
        return Ok(0);
    }
    // Stage 1 — parallel per-chunk serialize into per-shard byte buffers.
    // Each chunk worker emits two Vec<Vec<u8>> (one per side, length =
    // shard count). Single serialize per ref; bytes dispatched to whichever
    // sides apply. With 32 chunks × 128 shards × ~10KB per shard slot the
    // intermediate buffers stay well under 100MB total.
    // Chunk count tracks the *current* rayon pool (global ≈ 128, or the
    // dedicated writer pool when called from write_lights_from_channel) so a
    // small writer pool does not balloon per_chunk into thousands of empty
    // per-shard Vecs.
    let worker_count = rayon::current_num_threads().max(1);
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = lights.len().div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(lights.len());
            (start, end)
        })
        .take_while(|(start, _)| *start < lights.len())
        .collect();
    let per_chunk: Vec<(usize, Vec<Vec<u8>>, Vec<Vec<u8>>)> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut tgt_bufs: Vec<Vec<u8>> = (0..n_target).map(|_| Vec::new()).collect();
            let mut enc_bufs: Vec<Vec<u8>> = (0..n_encl).map(|_| Vec::new()).collect();
            let mut scratch: Vec<u8> = Vec::with_capacity(200);
            let mut emitted: usize = 0;
            for light in &lights[start..end] {
                let col = &write_cols[light.site_idx as usize];
                let target_id = light.target_symbol_id.as_deref();
                // B6 stage-3: enclosing is stored as a u64; the enclosing shard
                // is keyed by the id *string* (shard_index_for_key, read-side
                // compatible), so rebuild it (cold) only for call/construct edges
                // that actually carry an enclosing scope.
                let enclosing_str = if col.edge_kind_id == EDGE_KIND_CALL
                    || col.edge_kind_id == EDGE_KIND_CONSTRUCT
                {
                    enclosing_id_to_string(col.enclosing_id)
                } else {
                    None
                };
                if target_id.is_none() && enclosing_str.is_none() {
                    continue;
                }
                // B6 stage-4: rebuild `name` from the per-site id column instead
                // of `site.name`. No fallback here — if any emitted reference's
                // name failed to intern (MISS) the empty string diverges the
                // shard bytes, so the `bytes` gate proves the "emitted name is
                // always a symbol name" invariant. stage-5a: `file_id` is now a
                // precomputed column (no per-record `FileTable` probe).
                let name = name_interner.name(col.name_id).unwrap_or("");
                scratch.clear();
                serialize_reference_binary_from_light(light, col, name, &mut scratch);
                if let Some(t) = target_id {
                    let s = shard_index_for_key(t);
                    tgt_bufs[s].extend_from_slice(&scratch);
                }
                if let Some(e) = enclosing_str.as_deref() {
                    let s = shard_index_for_key(e);
                    enc_bufs[s].extend_from_slice(&scratch);
                }
                emitted += 1;
            }
            (emitted, tgt_bufs, enc_bufs)
        })
        .collect();
    // Stage 2 — per-shard parallel merge into the actual writer slices.
    // rayon par_iter_mut hands each thread an exclusive `&mut
    // GraphShardWriter`, so writes have no synchronization cost.
    let per_chunk_ref = &per_chunk;
    target_shards
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard, w)| -> io::Result<()> {
            for c in per_chunk_ref {
                if !c.1[shard].is_empty() {
                    w.writer.write_all(&c.1[shard])?;
                }
            }
            Ok(())
        })?;
    enclosing_shards
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard, w)| -> io::Result<()> {
            for c in per_chunk_ref {
                if !c.2[shard].is_empty() {
                    w.writer.write_all(&c.2[shard])?;
                }
            }
            Ok(())
        })?;
    let emitted: usize = per_chunk_ref.iter().map(|c| c.0).sum();
    Ok(emitted)
}

/// Foundation for the channel-driven write pipeline (Option 1 / Phase 5-A).
/// Consumes `LightRef` records from a `crossbeam_channel::Receiver` and
/// writes them to the target + enclosing shards as they arrive — letting
/// phase E / F worker threads overlap with the write phase instead of
/// waiting until both produce phases finish.
///
/// Borrows the shard writer slices mutably (caller owns them in its scope).
/// Returns total records emitted on each side; both halves of the channel
/// must be drained before `finish_graph_shard_writers` runs on the writers.
fn write_lights_from_channel(
    rx: crossbeam_channel::Receiver<Vec<LightRef>>,
    // B6 stage-5a: per-site write columns (was `ref_sites` + `site_name_ids` +
    // `file_table`). The reference write path reads no `RefSite` and does no
    // per-record `FileTable` probe — the toehold for dropping `Vec<RefSite>`.
    write_cols: &[RefWriteCol],
    name_interner: &NameInterner,
    target_shards: &mut [GraphShardWriter],
    enclosing_shards: &mut [GraphShardWriter],
) -> io::Result<usize> {
    // F1.b (W1+W2) — decoupled recv/flush writer.
    //
    // History: the single-thread per-record writer was deadlock-immune but
    // capped at ~750K rec/s, too slow to overlap resolve. W1 flushed via a
    // dedicated rayon pool (par_iter on threads independent of the saturated,
    // partly-blocked global pool, so no nested-spawn starvation) — but recv and
    // flush ran on the *same* thread: while a flush ran, recv stopped, the
    // channel filled, and phase F workers (~1.5M rec/s) stalled on `send`,
    // ballooning phase_f wall 6s -> 14s.
    //
    // W2 splits the roles. This thread only drains the channel into a buffer
    // and hands full buffers to a flush thread over a small bounded queue. The
    // flush thread owns the shard writers + the dedicated rayon pool and runs
    // append_lights_to_both_shards. recv never blocks on a flush, so the
    // channel stays drained and phase E *and* phase F can stream without
    // backpressure while the flush thread writes in parallel.
    let writer_threads = std::env::var("ZOEK_LIGHT_WRITER_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(8)
                .clamp(2, 8)
        });
    let flush_threshold: usize = std::env::var("ZOEK_LIGHT_WRITER_FLUSH")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(512 * 1024);
    // Small queue: a couple of full buffers in flight is enough to keep the
    // flush thread busy without letting unbounded buffers pile up in memory.
    let (flush_tx, flush_rx) = crossbeam_channel::bounded::<Vec<LightRef>>(3);
    std::thread::scope(|s| -> io::Result<usize> {
        let flush_handle = s.spawn(move || -> io::Result<usize> {
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(writer_threads)
                .thread_name(|i| format!("light-writer-{i}"))
                .build()
                .map_err(|e| {
                    io::Error::new(io::ErrorKind::Other, format!("writer pool: {e}"))
                })?;
            let mut total: usize = 0;
            while let Ok(buf) = flush_rx.recv() {
                let buf: Vec<LightRef> = buf;
                total += pool.install(|| {
                    append_lights_to_both_shards(
                        &buf,
                        write_cols,
                        name_interner,
                        target_shards,
                        enclosing_shards,
                    )
                })?;
            }
            Ok(total)
        });
        // recv loop: only drain the channel, never block on a flush.
        let mut buffer: Vec<LightRef> =
            Vec::with_capacity(flush_threshold + LIGHT_BATCH_FLUSH_SIZE);
        while let Ok(batch) = rx.recv() {
            buffer.extend(batch);
            if buffer.len() >= flush_threshold {
                let full = std::mem::replace(
                    &mut buffer,
                    Vec::with_capacity(flush_threshold + LIGHT_BATCH_FLUSH_SIZE),
                );
                if flush_tx.send(full).is_err() {
                    break;
                }
            }
        }
        if !buffer.is_empty() {
            let _ = flush_tx.send(buffer);
        }
        drop(flush_tx);
        flush_handle.join().expect("F1.b flush thread panicked")
    })
}

/// `LightRef`-aware streaming sidecar writer. Reads spilled partials (each
/// `Vec<LightRef>` bincode), then any in-memory tail, writes both to target
/// and enclosing shards without materializing `GraphReference`. Used by
/// the full-rebuild path once the in-flight references are kept as
/// `Vec<LightRef>` end-to-end.
#[allow(dead_code)] // Wired in by Phase 4-L.
fn stream_lights_to_sidecars(
    workspace_root: &Path,
    config: &EngineConfig,
    partials: &[PathBuf],
    tail: &[LightRef],
    // B6 stage-5a: per-site write columns (was `ref_sites` + `site_name_ids` +
    // `file_table`); `name` rebuilt from the interner via `col.name_id`.
    write_cols: &[RefWriteCol],
    name_interner: &NameInterner,
) -> io::Result<(u64, usize)> {
    let mut target_w = open_graph_shard_writers(
        workspace_root,
        config,
        GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
    )?;
    let mut enclosing_w = open_graph_shard_writers(
        workspace_root,
        config,
        GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
    )?;
    let mut total_records: usize = 0;
    for path in partials {
        let bytes = fs::read(path)?;
        let _ = fs::remove_file(path);
        let batch: Vec<LightRef> = bincode::deserialize(&bytes).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("light refs deserialize: {e}"))
        })?;
        drop(bytes);
        total_records += batch.len();
        append_lights_to_both_shards(
            &batch,
            write_cols,
            name_interner,
            &mut target_w,
            &mut enclosing_w,
        )?;
    }
    if !tail.is_empty() {
        total_records += tail.len();
        append_lights_to_both_shards(
            tail,
            write_cols,
            name_interner,
            &mut target_w,
            &mut enclosing_w,
        )?;
    }
    let target_bytes = finish_graph_shard_writers(target_w)?;
    let enclosing_bytes = finish_graph_shard_writers(enclosing_w)?;
    Ok((target_bytes + enclosing_bytes, total_records))
}

/// Open both reference sidecars (target + enclosing), stream each spilled
/// partial through them in turn, then any final in-memory tail, then close.
/// Peak memory while writing references stays at the largest partial size.
/// Returns (bytes_written, total_reference_records_emitted).
fn stream_references_to_sidecars(
    workspace_root: &Path,
    config: &EngineConfig,
    partials: &[PathBuf],
    tail: &[GraphReference],
    file_table: &FileTable,
) -> io::Result<(u64, usize)> {
    let mut target_w = open_graph_shard_writers(
        workspace_root,
        config,
        GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
    )?;
    let mut enclosing_w = open_graph_shard_writers(
        workspace_root,
        config,
        GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
    )?;
    let mut total_records: usize = 0;
    for path in partials {
        let bytes = fs::read(path)?;
        let _ = fs::remove_file(path);
        let batch: Vec<GraphReference> = bincode::deserialize(&bytes).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("refs deserialize: {e}"))
        })?;
        drop(bytes);
        total_records += batch.len();
        append_references_to_both_shards(&batch, &mut target_w, &mut enclosing_w, file_table)?;
    }
    if !tail.is_empty() {
        total_records += tail.len();
        append_references_to_both_shards(tail, &mut target_w, &mut enclosing_w, file_table)?;
    }
    let target_bytes = finish_graph_shard_writers(target_w)?;
    let enclosing_bytes = finish_graph_shard_writers(enclosing_w)?;
    Ok((target_bytes + enclosing_bytes, total_records))
}

fn append_methods_to_container_shards(
    symbols: &[GraphSymbol],
    shards: &mut [GraphShardWriter],
) -> io::Result<()> {
    let mut scratch: Vec<u8> = Vec::with_capacity(60);
    for symbol in symbols {
        if symbol.kind != "method" {
            continue;
        }
        let Some(container_name) = symbol.container_name.as_deref() else {
            continue;
        };
        for lookup_key in graph_name_lookup_keys(container_name) {
            scratch.clear();
            write_u16_str(&mut scratch, &lookup_key);
            write_u16_str(&mut scratch, &symbol.id);
            let shard = shard_index_for_key(&lookup_key);
            shards[shard].writer.write_all(&scratch)?;
        }
    }
    Ok(())
}

fn finish_graph_shard_writers(writers: Vec<GraphShardWriter>) -> io::Result<u64> {
    let mut bytes = 0;
    for mut shard in writers {
        shard.writer.flush()?;
        drop(shard.writer);
        fs::rename(&shard.temp_path, &shard.final_path)?;
        bytes += file_len(&shard.final_path)?;
    }
    Ok(bytes)
}

fn write_graph_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &[GraphSymbol],
    references: &[GraphReference],
    ref_sites: &[RefSite],
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    counts: &HashMap<String, GraphCount>,
    file_table: &FileTable,
    incremental: Option<&HashSet<String>>,
    references_streamed: bool,
    // W23: when true, the ref_site shards were already written (overlapped with
    // resolve on a dedicated pool — default; opt out via `ZOEK_OVERLAP_STATIC_OFF`), so skip
    // re-writing them here. The 38M-record ref_site write is the dominant index
    // cost; overlapping it hides it behind the resolve phase.
    skip_ref_sites: bool,
) -> io::Result<u64> {
    let probe = std::env::var("ZOEK_WRITE_PROBE").is_ok();
    let t0 = std::time::Instant::now();
    std::thread::scope(|s| -> io::Result<u64> {
        let symbol_id_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r = write_symbol_id_shards(workspace_root, config, symbols, file_table);
            (t.elapsed(), r)
        });
        // Phase 3 aggressive: sym_uri shards are now derived on demand from
        // sym_id shards. Saves ~820MB disk write per index build. The skip
        // env var lets users re-enable for backwards-compat dev tooling.
        let write_uri = std::env::var("ZOEK_WRITE_SYM_URI").is_ok();
        let symbol_uri_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r: io::Result<u64> = if write_uri {
                write_symbol_uri_shards(workspace_root, config, symbols, file_table)
            } else {
                Ok(0)
            };
            (t.elapsed(), r)
        });
        let ref_target_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r: io::Result<u64> = if references_streamed {
                Ok(0)
            } else {
                write_reference_target_shards(workspace_root, config, references, file_table, incremental)
            };
            (t.elapsed(), r)
        });
        let ref_enclosing_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r: io::Result<u64> = if references_streamed {
                Ok(0)
            } else {
                write_reference_enclosing_shards(workspace_root, config, references, file_table)
            };
            (t.elapsed(), r)
        });
        let ref_sites_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r: io::Result<u64> = if skip_ref_sites {
                Ok(0)
            } else {
                write_ref_sites_by_file_shards(workspace_root, config, ref_sites, file_table, incremental)
            };
            (t.elapsed(), r)
        });
        let facts_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r = write_facts_by_file_shards(
                workspace_root,
                config,
                import_facts,
                type_facts,
                function_return_facts,
                file_table,
                incremental,
            );
            (t.elapsed(), r)
        });
        let count_id_h = s.spawn(|| {
            let t = std::time::Instant::now();
            let r = write_count_id_shards(workspace_root, config, counts);
            (t.elapsed(), r)
        });
        let hierarchy_h = s.spawn(|| {
            let t = std::time::Instant::now();
            let r = write_hierarchy_parent_shards(workspace_root, config, symbols);
            (t.elapsed(), r)
        });
        let method_h = s.spawn(move || {
            let t = std::time::Instant::now();
            let r = write_method_container_shards(workspace_root, config, symbols, file_table);
            (t.elapsed(), r)
        });
        let mut bytes = 0;
        let (t1, r) = symbol_id_h.join().expect("symbol-id shard writer panicked"); bytes += r?;
        let (t2, r) = symbol_uri_h.join().expect("symbol-uri shard writer panicked"); bytes += r?;
        let (t3, r) = ref_target_h.join().expect("reference-target shard writer panicked"); bytes += r?;
        let (t4, r) = ref_enclosing_h.join().expect("reference-enclosing shard writer panicked"); bytes += r?;
        let (t5, r) = ref_sites_h.join().expect("ref-sites shard writer panicked"); bytes += r?;
        let (t6, r) = facts_h.join().expect("facts shard writer panicked"); bytes += r?;
        let (t7, r) = count_id_h.join().expect("count-id shard writer panicked"); bytes += r?;
        let (t8, r) = hierarchy_h.join().expect("hierarchy-parent shard writer panicked"); bytes += r?;
        let (t9, r) = method_h.join().expect("method-container shard writer panicked"); bytes += r?;
        if probe {
            eprintln!("[write-probe] wall={}ms sym_id={}ms sym_uri={}ms ref_target={}ms ref_enclosing={}ms ref_sites={}ms facts={}ms counts={}ms hierarchy={}ms methods={}ms",
                t0.elapsed().as_millis(), t1.as_millis(), t2.as_millis(), t3.as_millis(), t4.as_millis(), t5.as_millis(), t6.as_millis(), t7.as_millis(), t8.as_millis(), t9.as_millis());
        }
        Ok(bytes)
    })
}

fn write_symbol_id_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &[GraphSymbol],
    file_table: &FileTable,
) -> io::Result<u64> {
    parallel_sharded_write_serialize(
        workspace_root,
        config,
        GRAPH_SYMBOL_ID_SHARD_PREFIX,
        symbols,
        |symbol, buf| {
            let id = file_table.get_id(&symbol.rel_path).unwrap_or(u32::MAX);
            serialize_symbol_binary(symbol, id, buf);
            Some(shard_index_for_key(&symbol.id))
        },
    )
}

fn write_symbol_uri_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &[GraphSymbol],
    file_table: &FileTable,
) -> io::Result<u64> {
    parallel_sharded_write_serialize(
        workspace_root,
        config,
        GRAPH_SYMBOL_URI_SHARD_PREFIX,
        symbols,
        |symbol, buf| {
            let id = file_table.get_id(&symbol.rel_path).unwrap_or(u32::MAX);
            serialize_symbol_binary(symbol, id, buf);
            Some(shard_index_for_key(&symbol.uri))
        },
    )
}

fn write_reference_target_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    references: &[GraphReference],
    file_table: &FileTable,
    _incremental: Option<&HashSet<String>>,
) -> io::Result<u64> {
    parallel_sharded_write_serialize(
        workspace_root,
        config,
        GRAPH_REFERENCE_TARGET_SHARD_PREFIX,
        references,
        |reference, buf| {
            let target = reference.target_symbol_id.as_deref()?;
            let id = file_table.get_id(&reference.rel_path).unwrap_or(u32::MAX);
            serialize_reference_binary(reference, id, buf);
            Some(shard_index_for_key(target))
        },
    )
}

/// Phase 3 (write opt): variant of `parallel_sharded_write` that lets the
/// caller fill a reusable byte buffer instead of allocating a fresh `Vec` per
/// item. For symbol shards alone this avoids ~8M `Vec::with_capacity(300)`
/// alloc/free pairs per index build.
fn parallel_sharded_write_serialize<T, F>(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
    items: &[T],
    serialize_into: F,
) -> io::Result<u64>
where
    T: Sync,
    F: Fn(&T, &mut Vec<u8>) -> Option<usize> + Sync,
{
    let total = items.len();
    let worker_count = graph_worker_count(total.max(1));
    if total == 0 || worker_count <= 1 {
        let mut shards = open_graph_shard_writers(workspace_root, config, prefix)?;
        let mut buf: Vec<u8> = Vec::with_capacity(512);
        for item in items {
            buf.clear();
            if let Some(shard) = serialize_into(item, &mut buf) {
                shards[shard].writer.write_all(&buf)?;
            }
        }
        return finish_graph_shard_writers(shards);
    }
    use rayon::prelude::*;
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = total.div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(total);
            (start, end)
        })
        .take_while(|(start, _)| *start < total)
        .collect();
    let serialize_into_ref = &serialize_into;
    let worker_buffers: Vec<Vec<Vec<u8>>> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut bufs: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            let mut scratch: Vec<u8> = Vec::with_capacity(512);
            for item in &items[start..end] {
                scratch.clear();
                if let Some(shard) = serialize_into_ref(item, &mut scratch) {
                    bufs[shard].extend_from_slice(&scratch);
                }
            }
            bufs
        })
        .collect();
    let mut writers = open_graph_shard_writers(workspace_root, config, prefix)?;
    let worker_buffers_ref = &worker_buffers;
    writers
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for w_bufs in worker_buffers_ref {
                w.writer.write_all(&w_bufs[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(writers)
}

fn parallel_sharded_write<T, F, B>(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
    items: &[T],
    shard_for_item: F,
) -> io::Result<u64>
where
    T: Sync,
    F: Fn(&T) -> Option<(usize, B)> + Sync,
    B: AsRef<[u8]>,
{
    let total = items.len();
    let worker_count = graph_worker_count(total.max(1));
    if total == 0 || worker_count <= 1 {
        let mut shards = open_graph_shard_writers(workspace_root, config, prefix)?;
        for item in items {
            if let Some((shard, row)) = shard_for_item(item) {
                shards[shard].writer.write_all(row.as_ref())?;
            }
        }
        return finish_graph_shard_writers(shards);
    }
    // Rayon: work-stealing chunks + per-shard parallel merge. Replaces the
    // previous std::thread::scope fixed-chunk pattern. More chunks than
    // workers lets faster cores steal slow chunks; merge phase runs one
    // task per shard so no writer is shared between threads.
    use rayon::prelude::*;
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = total.div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(total);
            (start, end)
        })
        .take_while(|(start, _)| *start < total)
        .collect();
    let shard_for_item_ref = &shard_for_item;
    let worker_buffers: Vec<Vec<Vec<u8>>> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut bufs: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            for item in &items[start..end] {
                if let Some((shard, row)) = shard_for_item_ref(item) {
                    bufs[shard].extend_from_slice(row.as_ref());
                }
            }
            bufs
        })
        .collect();
    let mut writers = open_graph_shard_writers(workspace_root, config, prefix)?;
    let worker_buffers_ref = &worker_buffers;
    writers
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for w_bufs in worker_buffers_ref {
                w.writer.write_all(&w_bufs[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(writers)
}

fn parallel_write_shard_entries(
    workspace_root: &Path,
    config: &EngineConfig,
    prefix: &str,
    entries: &[(usize, Vec<u8>)],
) -> io::Result<u64> {
    let total = entries.len();
    let worker_count = graph_worker_count(total.max(1));
    if total == 0 || worker_count <= 1 {
        let mut shards = open_graph_shard_writers(workspace_root, config, prefix)?;
        for (shard, row) in entries {
            shards[*shard].writer.write_all(row)?;
        }
        return finish_graph_shard_writers(shards);
    }
    use rayon::prelude::*;
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = total.div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(total);
            (start, end)
        })
        .take_while(|(start, _)| *start < total)
        .collect();
    let worker_buffers: Vec<Vec<Vec<u8>>> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut bufs: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            for (shard, row) in &entries[start..end] {
                bufs[*shard].extend_from_slice(row);
            }
            bufs
        })
        .collect();
    let mut writers = open_graph_shard_writers(workspace_root, config, prefix)?;
    let worker_buffers_ref = &worker_buffers;
    writers
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for w_bufs in worker_buffers_ref {
                w.writer.write_all(&w_bufs[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(writers)
}

fn write_reference_enclosing_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    references: &[GraphReference],
    file_table: &FileTable,
) -> io::Result<u64> {
    parallel_sharded_write_serialize(
        workspace_root,
        config,
        GRAPH_REFERENCE_ENCLOSING_SHARD_PREFIX,
        references,
        |reference, buf| {
            if !matches!(reference.edge_kind.as_ref(), "call" | "construct") {
                return None;
            }
            let enclosing = reference.enclosing_symbol_id.as_deref()?;
            let id = file_table.get_id(&reference.rel_path).unwrap_or(u32::MAX);
            serialize_reference_binary(reference, id, buf);
            Some(shard_index_for_key(enclosing))
        },
    )
}

fn write_count_id_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    counts: &HashMap<String, GraphCount>,
) -> io::Result<u64> {
    // Phase 3 aggressive: drop all-zero counts. For 4.1M-symbol corpora most
    // symbols have no incoming references and yield default-zero counts; we
    // were writing those just to make readers return zero on hit, but readers
    // already treat missing keys as zero. Skip writing them at all.
    let default_count = GraphCount::default();
    let rows: Vec<(&String, &GraphCount)> = counts
        .iter()
        .filter(|(_, c)| **c != default_count)
        .collect();
    parallel_sharded_write_serialize(
        workspace_root,
        config,
        GRAPH_COUNT_ID_SHARD_PREFIX,
        &rows,
        |(symbol_id, count), buf| {
            serialize_count_binary(symbol_id, count, buf);
            Some(shard_index_for_key(symbol_id))
        },
    )
}

fn write_hierarchy_parent_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &[GraphSymbol],
) -> io::Result<u64> {
    let mut entries: Vec<(usize, Vec<u8>)> = Vec::new();
    for symbol in symbols {
        if !is_type_kind_sym(symbol) {
            continue;
        }
        for parent_name in symbol.extends_names.iter().chain(&symbol.implements_names) {
            for lookup_key in graph_name_lookup_keys(parent_name) {
                let mut buf: Vec<u8> = Vec::with_capacity(120);
                write_u16_str(&mut buf, &lookup_key);
                write_u16_str(&mut buf, parent_name);
                write_u16_str(&mut buf, &symbol.id);
                write_u16_str(&mut buf, &symbol.qualified_name);
                let shard = shard_index_for_key(&lookup_key);
                entries.push((shard, buf));
            }
        }
    }
    parallel_write_shard_entries(
        workspace_root,
        config,
        GRAPH_HIERARCHY_PARENT_SHARD_PREFIX,
        &entries,
    )
}

fn write_ref_sites_by_file_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    ref_sites: &[RefSite],
    file_table: &FileTable,
    incremental: Option<&HashSet<String>>,
) -> io::Result<u64> {
    if let Some(changed_paths) = incremental {
        let mut affected_shards: HashSet<usize> = HashSet::default();
        for path in changed_paths {
            affected_shards.insert(shard_index_for_key(path));
        }
        let worker_count = graph_worker_count(ref_sites.len().max(1));
        let chunk_size = ref_sites.len().div_ceil(worker_count.max(1));
        let worker_outputs: Vec<HashMap<usize, Vec<u8>>> = std::thread::scope(|s| {
            let mut handles = Vec::with_capacity(worker_count);
            for w in 0..worker_count {
                let start = w * chunk_size;
                let end = ((w + 1) * chunk_size).min(ref_sites.len());
                if start >= end {
                    continue;
                }
                let affected_ref = &affected_shards;
                handles.push(s.spawn(move || {
                    let mut local: HashMap<usize, Vec<u8>> = HashMap::default();
                    for shard_idx in affected_ref {
                        local.insert(*shard_idx, Vec::new());
                    }
                    for site in &ref_sites[start..end] {
                        let shard = shard_index_for_key(&site.rel_path);
                        if let Some(buffer) = local.get_mut(&shard) {
                            let id = file_table.get_id(&site.rel_path).unwrap_or(u32::MAX);
                            serialize_ref_site_binary(site, id, buffer);
                        }
                    }
                    local
                }));
            }
            handles
                .into_iter()
                .map(|h| h.join().expect("ref_sites worker panicked"))
                .collect()
        });
        let mut shard_buffers: HashMap<usize, Vec<u8>> = HashMap::default();
        for shard_idx in &affected_shards {
            shard_buffers.insert(*shard_idx, Vec::new());
        }
        for local in worker_outputs {
            for (shard, mut bytes) in local {
                if let Some(merged) = shard_buffers.get_mut(&shard) {
                    merged.append(&mut bytes);
                }
            }
        }
        let mut total_bytes = 0;
        for (shard_idx, buffer) in shard_buffers {
            let path = graph_shard_path(
                workspace_root,
                config,
                GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX,
                shard_idx,
            );
            write_atomically(&path, &buffer)?;
            total_bytes += buffer.len() as u64;
        }
        return Ok(total_bytes);
    }
    let total = ref_sites.len();
    let worker_count = graph_worker_count(total.max(1));
    if total == 0 || worker_count <= 1 {
        let mut shards = open_graph_shard_writers(workspace_root, config, GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX)?;
        let mut scratch: Vec<u8> = Vec::with_capacity(200);
        for site in ref_sites {
            scratch.clear();
            let id = file_table.get_id(&site.rel_path).unwrap_or(u32::MAX);
            serialize_ref_site_binary(site, id, &mut scratch);
            let shard = shard_index_for_key(&site.rel_path);
            shards[shard].writer.write_all(&scratch)?;
        }
        return finish_graph_shard_writers(shards);
    }
    use rayon::prelude::*;
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = total.div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(total);
            (start, end)
        })
        .take_while(|(start, _)| *start < total)
        .collect();
    let worker_buffers: Vec<Vec<Vec<u8>>> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut bufs: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            for site in &ref_sites[start..end] {
                let id = file_table.get_id(&site.rel_path).unwrap_or(u32::MAX);
                let shard = shard_index_for_key(&site.rel_path);
                serialize_ref_site_binary(site, id, &mut bufs[shard]);
            }
            bufs
        })
        .collect();
    let mut writers = open_graph_shard_writers(workspace_root, config, GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX)?;
    let worker_buffers_ref = &worker_buffers;
    writers
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for w_bufs in worker_buffers_ref {
                w.writer.write_all(&w_bufs[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(writers)
}

/// B6 stage-5b: column twin of `write_ref_sites_by_file_shards`' full-rebuild
/// parallel path. Serializes the 38M-site disk shard from `RefWriteCol` +
/// receiver `name_id` column + interner instead of `&[RefSite]`, so the OV1
/// overlapped writer reads no `RefSite` — the last reader to clear before
/// `Vec<RefSite>` can be dropped before resolve (stage-5d). Sharding is by the
/// `rel_path` rebuilt from `file_id` (`FileTable::get_path`), matching the
/// `shard_index_for_key(&site.rel_path)` of the AoS path; same chunk order, so
/// the per-shard bytes are identical.
fn write_ref_sites_by_file_shards_cols(
    workspace_root: &Path,
    config: &EngineConfig,
    write_cols: &[RefWriteCol],
    site_receiver_name_ids: &[u32],
    interner: &NameInterner,
    file_table: &FileTable,
) -> io::Result<u64> {
    use rayon::prelude::*;
    let total = write_cols.len();
    let worker_count = graph_worker_count(total.max(1));
    if total == 0 {
        let shards =
            open_graph_shard_writers(workspace_root, config, GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX)?;
        return finish_graph_shard_writers(shards);
    }
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);
    let chunk_size = total.div_ceil(target_chunks).max(1);
    let ranges: Vec<(usize, usize)> = (0..)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(total);
            (start, end)
        })
        .take_while(|(start, _)| *start < total)
        .collect();
    let worker_buffers: Vec<Vec<Vec<u8>>> = ranges
        .into_par_iter()
        .map(|(start, end)| {
            let mut bufs: Vec<Vec<u8>> = (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
            for i in start..end {
                let col = &write_cols[i];
                // Shard by the rel_path (rebuilt from file_id), matching the AoS
                // path's `shard_index_for_key(&site.rel_path)`. Every ref_site's
                // path is interned, so get_path is always Some.
                let shard = match file_table.get_path(col.file_id) {
                    Some(p) => shard_index_for_key(p),
                    None => shard_index_for_key(""),
                };
                serialize_ref_site_binary_from_cols(
                    col,
                    site_receiver_name_ids[i],
                    interner,
                    &mut bufs[shard],
                );
            }
            bufs
        })
        .collect();
    let mut writers =
        open_graph_shard_writers(workspace_root, config, GRAPH_REF_SITES_BY_FILE_SHARD_PREFIX)?;
    let worker_buffers_ref = &worker_buffers;
    writers
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for w_bufs in worker_buffers_ref {
                w.writer.write_all(&w_bufs[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(writers)
}

fn write_facts_by_file_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    import_facts: &[ImportFact],
    type_facts: &[TypeFact],
    function_return_facts: &[FunctionReturnFact],
    file_table: &FileTable,
    incremental: Option<&HashSet<String>>,
) -> io::Result<u64> {
    if let Some(changed_paths) = incremental {
        let mut affected_shards: HashSet<usize> = HashSet::default();
        for path in changed_paths {
            affected_shards.insert(shard_index_for_key(path));
        }
        let mut shard_buffers: HashMap<usize, Vec<u8>> = HashMap::default();
        for shard_idx in &affected_shards {
            shard_buffers.insert(*shard_idx, Vec::new());
        }
        for fact in import_facts {
            let shard = shard_index_for_key(&fact.rel_path);
            if let Some(buffer) = shard_buffers.get_mut(&shard) {
                let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                buffer.push(b'I');
                serialize_import_fact_binary(fact, id, buffer);
            }
        }
        for fact in type_facts {
            let shard = shard_index_for_key(&fact.rel_path);
            if let Some(buffer) = shard_buffers.get_mut(&shard) {
                let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                buffer.push(b'T');
                serialize_type_fact_binary(fact, id, buffer);
            }
        }
        for fact in function_return_facts {
            let shard = shard_index_for_key(&fact.rel_path);
            if let Some(buffer) = shard_buffers.get_mut(&shard) {
                let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                buffer.push(b'F');
                serialize_function_return_fact_binary(fact, id, buffer);
            }
        }
        let mut total_bytes = 0;
        for (shard_idx, buffer) in shard_buffers {
            let path = graph_shard_path(
                workspace_root,
                config,
                GRAPH_FACTS_BY_FILE_SHARD_PREFIX,
                shard_idx,
            );
            write_atomically(&path, &buffer)?;
            total_bytes += buffer.len() as u64;
        }
        return Ok(total_bytes);
    }
    // Rayon: serialize each fact category into per-shard byte buffers in
    // parallel chunks, then merge per-shard into the writer slice.
    use rayon::prelude::*;
    let worker_count = graph_worker_count(
        (import_facts.len() + type_facts.len() + function_return_facts.len()).max(1),
    )
    .max(1);
    let chunks_per_worker = 8usize;
    let target_chunks = worker_count.saturating_mul(chunks_per_worker).max(worker_count);

    let import_buffers: Vec<Vec<Vec<u8>>> = if import_facts.is_empty() {
        Vec::new()
    } else {
        let total = import_facts.len();
        let chunk_size = total.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize)> = (0..)
            .map(|i| {
                let start = i * chunk_size;
                let end = (start + chunk_size).min(total);
                (start, end)
            })
            .take_while(|(start, _)| *start < total)
            .collect();
        ranges
            .into_par_iter()
            .map(|(start, end)| {
                let mut bufs: Vec<Vec<u8>> =
                    (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
                let mut scratch: Vec<u8> = Vec::with_capacity(150);
                for fact in &import_facts[start..end] {
                    let shard = shard_index_for_key(&fact.rel_path);
                    let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                    scratch.clear();
                    serialize_import_fact_binary(fact, id, &mut scratch);
                    bufs[shard].push(b'I');
                    bufs[shard].extend_from_slice(&scratch);
                }
                bufs
            })
            .collect()
    };
    let type_buffers: Vec<Vec<Vec<u8>>> = if type_facts.is_empty() {
        Vec::new()
    } else {
        let total = type_facts.len();
        let chunk_size = total.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize)> = (0..)
            .map(|i| {
                let start = i * chunk_size;
                let end = (start + chunk_size).min(total);
                (start, end)
            })
            .take_while(|(start, _)| *start < total)
            .collect();
        ranges
            .into_par_iter()
            .map(|(start, end)| {
                let mut bufs: Vec<Vec<u8>> =
                    (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
                let mut scratch: Vec<u8> = Vec::with_capacity(80);
                for fact in &type_facts[start..end] {
                    let shard = shard_index_for_key(&fact.rel_path);
                    let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                    scratch.clear();
                    serialize_type_fact_binary(fact, id, &mut scratch);
                    bufs[shard].push(b'T');
                    bufs[shard].extend_from_slice(&scratch);
                }
                bufs
            })
            .collect()
    };
    let return_buffers: Vec<Vec<Vec<u8>>> = if function_return_facts.is_empty() {
        Vec::new()
    } else {
        let total = function_return_facts.len();
        let chunk_size = total.div_ceil(target_chunks).max(1);
        let ranges: Vec<(usize, usize)> = (0..)
            .map(|i| {
                let start = i * chunk_size;
                let end = (start + chunk_size).min(total);
                (start, end)
            })
            .take_while(|(start, _)| *start < total)
            .collect();
        ranges
            .into_par_iter()
            .map(|(start, end)| {
                let mut bufs: Vec<Vec<u8>> =
                    (0..GRAPH_SHARD_COUNT).map(|_| Vec::new()).collect();
                let mut scratch: Vec<u8> = Vec::with_capacity(60);
                for fact in &function_return_facts[start..end] {
                    let shard = shard_index_for_key(&fact.rel_path);
                    let id = file_table.get_id(&fact.rel_path).unwrap_or(u32::MAX);
                    scratch.clear();
                    serialize_function_return_fact_binary(fact, id, &mut scratch);
                    bufs[shard].push(b'F');
                    bufs[shard].extend_from_slice(&scratch);
                }
                bufs
            })
            .collect()
    };
    let mut shards =
        open_graph_shard_writers(workspace_root, config, GRAPH_FACTS_BY_FILE_SHARD_PREFIX)?;
    let import_ref = &import_buffers;
    let type_ref = &type_buffers;
    let return_ref = &return_buffers;
    shards
        .par_iter_mut()
        .enumerate()
        .try_for_each(|(shard_idx, w)| -> io::Result<()> {
            for b in import_ref {
                w.writer.write_all(&b[shard_idx])?;
            }
            for b in type_ref {
                w.writer.write_all(&b[shard_idx])?;
            }
            for b in return_ref {
                w.writer.write_all(&b[shard_idx])?;
            }
            w.writer.flush()?;
            Ok(())
        })?;
    finish_graph_shard_writers(shards)
}

fn write_method_container_shards(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &[GraphSymbol],
    _file_table: &FileTable,
) -> io::Result<u64> {
    let mut entries: Vec<(usize, Vec<u8>)> = Vec::new();
    for symbol in symbols {
        if symbol.kind != "method" {
            continue;
        }
        let Some(container_name) = symbol.container_name.as_deref() else {
            continue;
        };
        for lookup_key in graph_name_lookup_keys(container_name) {
            let mut buf: Vec<u8> = Vec::with_capacity(60);
            write_u16_str(&mut buf, &lookup_key);
            write_u16_str(&mut buf, &symbol.id);
            let shard = shard_index_for_key(&lookup_key);
            entries.push((shard, buf));
        }
    }
    parallel_write_shard_entries(
        workspace_root,
        config,
        GRAPH_METHOD_CONTAINER_SHARD_PREFIX,
        &entries,
    )
}

fn serialize_symbol_row(symbol: &GraphSymbol) -> String {
    let mut row = [
        "S".to_string(),
        encode_field(&symbol.id),
        encode_field(&symbol.name),
        encode_field(&symbol.qualified_name),
        encode_field(&symbol.kind),
        encode_field(&symbol.language),
        encode_field(&symbol.uri),
        encode_field(&symbol.rel_path),
        symbol.start_line.to_string(),
        symbol.start_column.to_string(),
        symbol.end_line.to_string(),
        symbol.end_column.to_string(),
        symbol.body_start_line.to_string(),
        symbol.body_start_column.to_string(),
        symbol.body_end_line.to_string(),
        symbol.body_end_column.to_string(),
        encode_field(symbol.container_id.as_deref().unwrap_or("")),
        encode_field(symbol.container_name.as_deref().unwrap_or("")),
        encode_field(symbol.package_name.as_deref().unwrap_or("")),
        encode_list(&symbol.extends_names),
        encode_list(&symbol.implements_names),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn parse_import_fact_fields(fields: &[&str]) -> io::Result<ImportFact> {
    if fields.len() != 6 || fields[0] != "I" {
        return Err(invalid_data(format!(
            "invalid import-fact row with {} fields",
            fields.len()
        )));
    }
    Ok(ImportFact {
        rel_path: decode_field(fields[1])?,
        file_id: decode_field(fields[2])?,
        local_name: decode_field(fields[3])?,
        imported_name: decode_field(fields[4])?,
        module_candidates: decode_list(fields[5])?,
    })
}

fn parse_type_fact_fields(fields: &[&str]) -> io::Result<TypeFact> {
    if fields.len() != 5 || fields[0] != "T" {
        return Err(invalid_data(format!(
            "invalid type-fact row with {} fields",
            fields.len()
        )));
    }
    Ok(TypeFact {
        rel_path: decode_field(fields[1])?,
        local_name: decode_field(fields[2])?,
        type_name: decode_field(fields[3])?,
        enclosing_symbol_id: empty_string_to_none(decode_field(fields[4])?),
    })
}

fn parse_function_return_fact_fields(fields: &[&str]) -> io::Result<FunctionReturnFact> {
    if fields.len() != 4 || fields[0] != "F" {
        return Err(invalid_data(format!(
            "invalid function-return-fact row with {} fields",
            fields.len()
        )));
    }
    Ok(FunctionReturnFact {
        rel_path: decode_field(fields[1])?,
        function_name: decode_field(fields[2])?,
        type_name: decode_field(fields[3])?,
    })
}

fn serialize_import_fact_row(fact: &ImportFact) -> String {
    let mut row = [
        "I",
        &encode_field(&fact.rel_path),
        &encode_field(&fact.file_id),
        &encode_field(&fact.local_name),
        &encode_field(&fact.imported_name),
        &encode_list(&fact.module_candidates),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn serialize_type_fact_row(fact: &TypeFact) -> String {
    let mut row = [
        "T",
        &encode_field(&fact.rel_path),
        &encode_field(&fact.local_name),
        &encode_field(&fact.type_name),
        &encode_field(fact.enclosing_symbol_id.as_deref().unwrap_or("")),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn serialize_function_return_fact_row(fact: &FunctionReturnFact) -> String {
    let mut row = [
        "F",
        &encode_field(&fact.rel_path),
        &encode_field(&fact.function_name),
        &encode_field(&fact.type_name),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn serialize_reference_binary(reference: &GraphReference, file_id: u32, out: &mut Vec<u8>) {
    // B6 stage-2: parse the string id once (GraphReference keeps it as a string);
    // non-standard ids fall back to the u64::MAX sentinel + inline string.
    let (sru, sri) = match parse_stable_ref_id_to_u64(&reference.source_ref_id) {
        Some(u) => (u, None),
        None => (u64::MAX, Some(reference.source_ref_id.as_ref())),
    };
    // B6 stage-3: parse the enclosing id once too (0 = none; a non-standard id
    // falls back to an inline string, which fresh data never produces).
    let (eu, ei) = match reference.enclosing_symbol_id.as_deref() {
        None => (0u64, None),
        Some(e) => match parse_stable_symbol_id_to_u64(e) {
            Some(u) => (u, None),
            None => (0u64, Some(e)),
        },
    };
    serialize_reference_record(
        sru,
        sri,
        reference.target_symbol_id.as_deref(),
        &reference.edge_kind,
        &reference.name,
        &reference.raw_text,
        file_id,
        reference.start_line,
        reference.start_column,
        reference.end_line,
        reference.end_column,
        eu,
        ei,
        reference.bound_mask,
        &reference.confidence,
        &reference.provenance,
        out,
    );
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn serialize_reference_record(
    // B6 stage-2: caller passes the pre-parsed u64 (RefSite/LightRef already
    // store it; the GraphReference path parses once). `source_ref_id_inline` is
    // Some only for the legacy non-standard case (u64::MAX sentinel) — avoids
    // reconstructing the "ref:HEX16" string per record on the 14M-record path.
    source_ref_id_u64: u64,
    source_ref_id_inline: Option<&str>,
    target_symbol_id: Option<&str>,
    edge_kind: &str,
    name: &str,
    raw_text: &str,
    file_id: u32,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    // B6 stage-3: pre-parsed enclosing id (0 = none); `enclosing_inline` is Some
    // only for the legacy non-standard case (avoids reconstructing "sym:HEX16"
    // per record on the 14M-record write path) — mirrors the source_ref_id args.
    enclosing_id_u64: u64,
    enclosing_inline: Option<&str>,
    bound_mask: u8,
    confidence: &str,
    provenance: &str,
    out: &mut Vec<u8>,
) {
    // source_ref_id: u64 if standard; u64::MAX sentinel = inline str follows.
    out.extend_from_slice(&source_ref_id_u64.to_le_bytes());
    if source_ref_id_u64 == u64::MAX {
        write_u16_str(out, source_ref_id_inline.unwrap_or(""));
    }
    // target_symbol_id: 0=none, 1=u64 follows, 2=inline str follows.
    match target_symbol_id {
        None => out.push(0),
        Some(t) => {
            if let Some(u) = parse_stable_symbol_id_to_u64(t) {
                out.push(1);
                out.extend_from_slice(&u.to_le_bytes());
            } else {
                out.push(2);
                write_u16_str(out, t);
            }
        }
    }
    // edge_kind: u8 enum id; 255=inline str follows.
    let edge_id = compute_edge_kind_id(edge_kind);
    out.push(edge_id);
    if edge_id == EDGE_KIND_OTHER {
        write_u16_str(out, edge_kind);
    }
    write_u16_str(out, name);
    // raw_text: most refs have raw_text == name; marker byte avoids a
    // duplicate string for the common case.
    if raw_text == name {
        out.push(0);
    } else {
        out.push(1);
        write_u16_str(out, raw_text);
    }
    out.extend_from_slice(&file_id.to_le_bytes());
    out.extend_from_slice(&start_line.to_le_bytes());
    out.extend_from_slice(&start_column.to_le_bytes());
    out.extend_from_slice(&end_line.to_le_bytes());
    out.extend_from_slice(&end_column.to_le_bytes());
    // enclosing_symbol_id: 0=none, 1=u64 follows, 2=inline str follows. B6
    // stage-3: pre-parsed by the caller (inline only for legacy non-standard
    // ids, which fresh writes never emit — so this stays byte-identical).
    match enclosing_inline {
        Some(e) => {
            out.push(2);
            write_u16_str(out, e);
        }
        None => {
            if enclosing_id_u64 == 0 {
                out.push(0);
            } else {
                out.push(1);
                out.extend_from_slice(&enclosing_id_u64.to_le_bytes());
            }
        }
    }
    out.push(bound_mask);
    let conf_id = compute_confidence_id(confidence);
    out.push(conf_id);
    if conf_id == CONFIDENCE_OTHER {
        write_u16_str(out, confidence);
    }
    let prov_id = compute_provenance_id(provenance);
    out.push(prov_id);
    if prov_id == PROVENANCE_OTHER {
        write_u16_str(out, provenance);
    }
}

/// Direct-from-LightRef binary serialization. Writes site-derived fields
/// (rel_path implied by `file_id`, plus name/raw_text/uri/edge_kind/etc.)
/// straight into `out` without first materializing a `GraphReference`. The
/// per-record string fields are still copied as bytes into `out`, but no
/// `Box<str>`/`String` allocation happens — saves ~9 heap allocations per
/// emitted reference (≈ 130M allocs across all 14.4M refs in captain2).
#[allow(dead_code)] // Used once the write pipeline migrates to LightRef.
fn serialize_reference_binary_from_light(
    light: &LightRef,
    // B6 stage-5a: the per-site write columns (was `&RefSite`). `name` is the
    // caller's interner reconstruction (stage-4); everything else reads the
    // column. `edge_kind` is rebuilt from `edge_kind_id` (always standard for
    // references — `extract_ref_sites` emits only `call`/`usage`); the
    // `serialize_reference_record` re-derives the same id, so byte-identical.
    col: &RefWriteCol,
    name: &str,
    out: &mut Vec<u8>,
) {
    let edge_kind = edge_kind_str_from_id(col.edge_kind_id).unwrap_or("usage");
    serialize_reference_record(
        col.source_ref_id, // B6 stage-2: already a u64; always standard at parse
        None,
        light.target_symbol_id.as_deref(),
        edge_kind,
        name,
        name, // B6: raw_text == name (field dropped)
        col.file_id,
        col.start_line,
        col.start_column,
        col.end_line,
        col.end_column,
        col.enclosing_id, // B6 stage-3: already a u64 (always standard at parse)
        None,
        light.bound_mask,
        light.confidence.as_str(),
        light.provenance.as_str(),
        out,
    );
}

fn write_u16_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u16).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn read_u16_str(bytes: &[u8], cursor: &mut usize) -> io::Result<String> {
    if *cursor + 2 > bytes.len() {
        return Err(invalid_data("binary record truncated (length)"));
    }
    let len = u16::from_le_bytes([bytes[*cursor], bytes[*cursor + 1]]) as usize;
    *cursor += 2;
    if *cursor + len > bytes.len() {
        return Err(invalid_data("binary record truncated (data)"));
    }
    let s = std::str::from_utf8(&bytes[*cursor..*cursor + len])
        .map_err(|e| invalid_data(format!("binary utf-8: {e}")))?;
    *cursor += len;
    Ok(s.to_string())
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize) -> io::Result<u32> {
    if *cursor + 4 > bytes.len() {
        return Err(invalid_data("binary record truncated (u32)"));
    }
    let v = u32::from_le_bytes([
        bytes[*cursor],
        bytes[*cursor + 1],
        bytes[*cursor + 2],
        bytes[*cursor + 3],
    ]);
    *cursor += 4;
    Ok(v)
}

fn write_opt_str(out: &mut Vec<u8>, value: Option<&str>) {
    if let Some(v) = value {
        out.push(1);
        write_u16_str(out, v);
    } else {
        out.push(0);
    }
}

fn read_opt_str(bytes: &[u8], cursor: &mut usize) -> io::Result<Option<String>> {
    if *cursor >= bytes.len() {
        return Err(invalid_data("opt_str truncated"));
    }
    let marker = bytes[*cursor];
    *cursor += 1;
    if marker == 1 {
        Ok(Some(read_u16_str(bytes, cursor)?))
    } else {
        Ok(None)
    }
}

fn write_str_list(out: &mut Vec<u8>, values: &[String]) {
    out.extend_from_slice(&(values.len() as u16).to_le_bytes());
    for v in values {
        write_u16_str(out, v);
    }
}

fn read_str_list(bytes: &[u8], cursor: &mut usize) -> io::Result<Vec<String>> {
    if *cursor + 2 > bytes.len() {
        return Err(invalid_data("str_list truncated"));
    }
    let len = u16::from_le_bytes([bytes[*cursor], bytes[*cursor + 1]]) as usize;
    *cursor += 2;
    let mut out = Vec::with_capacity(len);
    for _ in 0..len {
        out.push(read_u16_str(bytes, cursor)?);
    }
    Ok(out)
}

fn write_opt_u64(out: &mut Vec<u8>, value: Option<usize>) {
    if let Some(v) = value {
        out.push(1);
        out.extend_from_slice(&(v as u64).to_le_bytes());
    } else {
        out.push(0);
    }
}

fn read_opt_u64(bytes: &[u8], cursor: &mut usize) -> io::Result<Option<usize>> {
    if *cursor >= bytes.len() {
        return Err(invalid_data("opt_u64 truncated"));
    }
    let marker = bytes[*cursor];
    *cursor += 1;
    if marker == 1 {
        if *cursor + 8 > bytes.len() {
            return Err(invalid_data("opt_u64 value truncated"));
        }
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes[*cursor..*cursor + 8]);
        *cursor += 8;
        Ok(Some(u64::from_le_bytes(buf) as usize))
    } else {
        Ok(None)
    }
}

#[derive(Default, Clone)]
struct FileTable {
    paths: Vec<String>,
    map: HashMap<String, u32>,
}

impl FileTable {
    fn intern(&mut self, rel_path: &str) -> u32 {
        if let Some(id) = self.map.get(rel_path) {
            return *id;
        }
        let id = self.paths.len() as u32;
        self.paths.push(rel_path.to_string());
        self.map.insert(rel_path.to_string(), id);
        id
    }

    fn get_id(&self, rel_path: &str) -> Option<u32> {
        self.map.get(rel_path).copied()
    }

    fn get_path(&self, file_id: u32) -> Option<&str> {
        self.paths.get(file_id as usize).map(|s| s.as_str())
    }

    fn count(&self) -> usize {
        self.paths.len()
    }
}

fn graph_file_table_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_FILE_TABLE_NAME)
}

fn write_file_table_binary(path: &Path, table: &FileTable) -> io::Result<u64> {
    let mut buf: Vec<u8> = Vec::with_capacity(8 + table.count() * 40);
    buf.extend_from_slice(&(table.paths.len() as u32).to_le_bytes());
    for p in &table.paths {
        write_u16_str(&mut buf, p);
    }
    write_atomically(path, &buf)?;
    Ok(buf.len() as u64)
}

fn read_file_table_binary(path: &Path) -> io::Result<FileTable> {
    let bytes = fs::read(path)?;
    if bytes.len() < 4 {
        return Err(invalid_data("file_table truncated"));
    }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let mut cursor = 4;
    let mut paths = Vec::with_capacity(count);
    for _ in 0..count {
        paths.push(read_u16_str(&bytes, &mut cursor)?);
    }
    let mut map: HashMap<String, u32> = HashMap::default();
    map.reserve(paths.len());
    for (i, p) in paths.iter().enumerate() {
        map.insert(p.clone(), i as u32);
    }
    Ok(FileTable { paths, map })
}

fn serialize_count_binary(symbol_id: &str, count: &GraphCount, out: &mut Vec<u8>) {
    write_u16_str(out, symbol_id);
    out.extend_from_slice(&(count.usage_likely as u32).to_le_bytes());
    out.extend_from_slice(&(count.usage_must as u32).to_le_bytes());
    out.extend_from_slice(&(count.usage_may as u32).to_le_bytes());
    out.extend_from_slice(&(count.calls_in_likely as u32).to_le_bytes());
    out.extend_from_slice(&(count.calls_in_must as u32).to_le_bytes());
    out.extend_from_slice(&(count.calls_in_may as u32).to_le_bytes());
    out.extend_from_slice(&(count.calls_out_must as u32).to_le_bytes());
    out.extend_from_slice(&(count.calls_out_may as u32).to_le_bytes());
    out.extend_from_slice(&(count.impl_must as u32).to_le_bytes());
    out.extend_from_slice(&(count.impl_may as u32).to_le_bytes());
}

fn parse_count_binary(bytes: &[u8], cursor: &mut usize) -> io::Result<(String, GraphCount)> {
    let symbol_id = read_u16_str(bytes, cursor)?;
    let usage_likely = read_u32_le(bytes, cursor)? as usize;
    let usage_must = read_u32_le(bytes, cursor)? as usize;
    let usage_may = read_u32_le(bytes, cursor)? as usize;
    let calls_in_likely = read_u32_le(bytes, cursor)? as usize;
    let calls_in_must = read_u32_le(bytes, cursor)? as usize;
    let calls_in_may = read_u32_le(bytes, cursor)? as usize;
    let calls_out_must = read_u32_le(bytes, cursor)? as usize;
    let calls_out_may = read_u32_le(bytes, cursor)? as usize;
    let impl_must = read_u32_le(bytes, cursor)? as usize;
    let impl_may = read_u32_le(bytes, cursor)? as usize;
    Ok((
        symbol_id,
        GraphCount {
            usage_likely,
            usage_must,
            usage_may,
            calls_in_likely,
            calls_in_must,
            calls_in_may,
            calls_out_must,
            calls_out_may,
            impl_must,
            impl_may,
        },
    ))
}

fn serialize_import_fact_binary(fact: &ImportFact, file_id: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&file_id.to_le_bytes());
    write_u16_str(out, &fact.file_id);
    write_u16_str(out, &fact.local_name);
    write_u16_str(out, &fact.imported_name);
    write_str_list(out, &fact.module_candidates);
}

fn parse_import_fact_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<ImportFact> {
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown import_fact file_id {file_id}")))?
        .to_string();
    let file_id_str = read_u16_str(bytes, cursor)?;
    let local_name = read_u16_str(bytes, cursor)?;
    let imported_name = read_u16_str(bytes, cursor)?;
    let module_candidates = read_str_list(bytes, cursor)?;
    Ok(ImportFact {
        rel_path,
        file_id: file_id_str,
        local_name,
        imported_name,
        module_candidates,
    })
}

fn serialize_type_fact_binary(fact: &TypeFact, file_id: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&file_id.to_le_bytes());
    write_u16_str(out, &fact.local_name);
    write_u16_str(out, &fact.type_name);
    write_opt_str(out, fact.enclosing_symbol_id.as_deref());
}

fn parse_type_fact_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<TypeFact> {
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown type_fact file_id {file_id}")))?
        .to_string();
    let local_name = read_u16_str(bytes, cursor)?;
    let type_name = read_u16_str(bytes, cursor)?;
    let enclosing_symbol_id = read_opt_str(bytes, cursor)?;
    Ok(TypeFact {
        rel_path,
        local_name,
        type_name,
        enclosing_symbol_id,
    })
}

fn serialize_function_return_fact_binary(
    fact: &FunctionReturnFact,
    file_id: u32,
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(&file_id.to_le_bytes());
    write_u16_str(out, &fact.function_name);
    write_u16_str(out, &fact.type_name);
}

fn parse_function_return_fact_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<FunctionReturnFact> {
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown return_fact file_id {file_id}")))?
        .to_string();
    let function_name = read_u16_str(bytes, cursor)?;
    let type_name = read_u16_str(bytes, cursor)?;
    Ok(FunctionReturnFact {
        rel_path,
        function_name,
        type_name,
    })
}

fn serialize_symbol_binary(symbol: &GraphSymbol, file_id: u32, out: &mut Vec<u8>) {
    // Phase 3 aggressive: symbol.id is "sym:HEX16" — encode as u64 (8B) vs
    // 22B string. Sentinel u64::MAX falls back to inline string.
    if let Some(u) = parse_stable_symbol_id_to_u64(&symbol.id) {
        out.extend_from_slice(&u.to_le_bytes());
    } else {
        out.extend_from_slice(&u64::MAX.to_le_bytes());
        write_u16_str(out, &symbol.id);
    }
    write_u16_str(out, &symbol.name);
    write_u16_str(out, &symbol.qualified_name);
    // kind: u8 id (KIND_OTHER = inline string fallback).
    let kind_id = compute_kind_id(&symbol.kind);
    out.push(kind_id);
    if kind_id == KIND_OTHER {
        write_u16_str(out, &symbol.kind);
    }
    // language: u8 id (255 sentinel = inline string fallback).
    let lang_id = compute_language_id(&symbol.language);
    let lang_byte = if lang_id <= u8::MAX as u16 { lang_id as u8 } else { 255 };
    out.push(lang_byte);
    if lang_byte == 255 || language_str_from_id(lang_id).is_none() {
        write_u16_str(out, &symbol.language);
    }
    write_u16_str(out, &symbol.uri);
    out.extend_from_slice(&file_id.to_le_bytes());
    out.extend_from_slice(&symbol.start_line.to_le_bytes());
    out.extend_from_slice(&symbol.start_column.to_le_bytes());
    out.extend_from_slice(&symbol.end_line.to_le_bytes());
    out.extend_from_slice(&symbol.end_column.to_le_bytes());
    out.extend_from_slice(&symbol.body_start_line.to_le_bytes());
    out.extend_from_slice(&symbol.body_start_column.to_le_bytes());
    out.extend_from_slice(&symbol.body_end_line.to_le_bytes());
    out.extend_from_slice(&symbol.body_end_column.to_le_bytes());
    write_opt_str(out, symbol.container_id.as_deref());
    write_opt_str(out, symbol.container_name.as_deref());
    write_opt_str(out, symbol.package_name.as_deref());
    write_str_list(out, &symbol.extends_names);
    write_str_list(out, &symbol.implements_names);
    write_opt_u64(out, symbol.usage_count);
    write_opt_u64(out, symbol.usage_must_count);
    write_opt_u64(out, symbol.usage_may_count);
    write_opt_u64(out, symbol.implementation_count);
    write_opt_u64(out, symbol.implementation_must_count);
    write_opt_u64(out, symbol.implementation_may_count);
}

fn parse_symbol_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<GraphSymbol> {
    if *cursor + 8 > bytes.len() {
        return Err(invalid_data("symbol truncated (id u64)"));
    }
    let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    let id = if u == u64::MAX {
        read_u16_str(bytes, cursor)?
    } else {
        format!("sym:{:016x}", u)
    };
    let name = read_u16_str(bytes, cursor)?;
    let qualified_name = read_u16_str(bytes, cursor)?;
    if *cursor >= bytes.len() {
        return Err(invalid_data("symbol truncated (kind id)"));
    }
    let kind_id = bytes[*cursor];
    *cursor += 1;
    let kind = match kind_str_from_id(kind_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    if *cursor >= bytes.len() {
        return Err(invalid_data("symbol truncated (language id)"));
    }
    let lang_byte = bytes[*cursor];
    *cursor += 1;
    let language = match language_str_from_id(lang_byte as u16) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    let uri = read_u16_str(bytes, cursor)?;
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown symbol file_id {file_id}")))?
        .to_string();
    let start_line = read_u32_le(bytes, cursor)?;
    let start_column = read_u32_le(bytes, cursor)?;
    let end_line = read_u32_le(bytes, cursor)?;
    let end_column = read_u32_le(bytes, cursor)?;
    let body_start_line = read_u32_le(bytes, cursor)?;
    let body_start_column = read_u32_le(bytes, cursor)?;
    let body_end_line = read_u32_le(bytes, cursor)?;
    let body_end_column = read_u32_le(bytes, cursor)?;
    let container_id = read_opt_str(bytes, cursor)?;
    let container_name = read_opt_str(bytes, cursor)?;
    let package_name = read_opt_str(bytes, cursor)?;
    let extends_names = read_str_list(bytes, cursor)?;
    let implements_names = read_str_list(bytes, cursor)?;
    let usage_count = read_opt_u64(bytes, cursor)?;
    let usage_must_count = read_opt_u64(bytes, cursor)?;
    let usage_may_count = read_opt_u64(bytes, cursor)?;
    let implementation_count = read_opt_u64(bytes, cursor)?;
    let implementation_must_count = read_opt_u64(bytes, cursor)?;
    let implementation_may_count = read_opt_u64(bytes, cursor)?;
    let kind_flags = compute_kind_flags(&kind);
    let language_id = compute_language_id(&language);
    let id_u64 = parse_stable_symbol_id_to_u64(&id).unwrap_or(0);
    let rel_path_hash = stable_hash(&rel_path);
    let name_hash = stable_hash(&name);
    Ok(GraphSymbol {
        id,
        name,
        qualified_name,
        kind,
        language,
        uri,
        rel_path,
        start_line,
        start_column,
        end_line,
        end_column,
        body_start_line,
        body_start_column,
        body_end_line,
        body_end_column,
        container_id,
        container_name,
        package_name,
        extends_names,
        implements_names,
        usage_count,
        usage_must_count,
        usage_may_count,
        implementation_count,
        implementation_must_count,
        implementation_may_count,
        kind_flags,
        language_id,
        id_u64,
        rel_path_hash,
        name_hash,
    })
}


fn serialize_ref_site_binary(site: &RefSite, file_id: u32, out: &mut Vec<u8>) {
    // Phase 3 aggressive: source_ref_id is always "ref:HEX16" produced by
    // stable_ref_id. Encode as raw u64 (8B) instead of 22B string. Use
    // 0xFFFFFFFFFFFFFFFF as sentinel for non-standard ids (legacy input).
    // B6 stage-2: source_ref_id is already the u64 (always standard at parse).
    // Byte-identical to the prior parse_stable_ref_id_to_u64 path.
    out.extend_from_slice(&site.source_ref_id.to_le_bytes());
    write_u16_str(out, &site.name);
    // B6: raw_text is always == name (the field was dropped), so always emit the
    // marker-0 "copy name" case. Byte-identical to the prior output; the reader
    // (parse_ref_site_binary) still accepts a marker-1 legacy string.
    out.push(0);
    out.extend_from_slice(&file_id.to_le_bytes());
    // Phase 3 aggressive (RefSite slim): language/edge_kind/access_kind go
    // through small enum tables. Most refs hit a known value (~99.99% in
    // captain2/captain) so the 1-byte id replaces a u16-prefixed string
    // (typically 8-12 bytes).
    let lang_id = compute_language_id(&site.language);
    let lang_byte = if lang_id <= u8::MAX as u16 { lang_id as u8 } else { 255 };
    out.push(lang_byte);
    if lang_byte == 255 || language_str_from_id(lang_id).is_none() {
        // Fallback: id 255 marker followed by full string. Reader must
        // re-read string when it sees the sentinel.
        write_u16_str(out, &site.language);
    }
    out.extend_from_slice(&site.start_line.to_le_bytes());
    out.extend_from_slice(&site.start_column.to_le_bytes());
    out.extend_from_slice(&site.end_line.to_le_bytes());
    out.extend_from_slice(&site.end_column.to_le_bytes());
    // W12: precomputed edge_kind_id / access_kind_id on RefSite — write side
    // skips the string match on every record.
    let edge_id = site.edge_kind_id;
    out.push(edge_id);
    if edge_id == EDGE_KIND_OTHER {
        write_u16_str(out, &site.edge_kind);
    }
    let access_id = site.access_kind_id;
    out.push(access_id);
    if access_id == ACCESS_KIND_OTHER {
        write_u16_str(out, &site.access_kind);
    }
    out.push(if site.is_definition { 1 } else { 0 });
    out.push(if site.is_import_context { 1 } else { 0 });
    if let Some(r) = site.receiver_name.as_deref() {
        out.push(1);
        write_u16_str(out, r);
    } else {
        out.push(0);
    }
    // Phase 3 aggressive: enclosing_symbol_id is also "sym:HEX16" format when
    // present (built from stable_symbol_id). Encode as u64 + 1B present marker:
    // 0 = absent, 1 = u64 follows, 2 = inline string. B6 stage-3: the field is
    // already the u64 (0 = absent), so emit marker 1 + u64 directly — the inline
    // marker-2 was never reached for real "sym:HEX16" ids, so this stays
    // byte-identical to the prior parse_stable_symbol_id_to_u64 path.
    if site.enclosing_id != 0 {
        out.push(1);
        out.extend_from_slice(&site.enclosing_id.to_le_bytes());
    } else {
        out.push(0);
    }
}

/// B6 stage-5b: column twin of `serialize_ref_site_binary` — produces the
/// byte-identical 38M-site disk record from `RefWriteCol` + the receiver
/// `name_id` + the interner, so the OV1 disk writer reads no `RefSite` (toward
/// dropping `Vec<RefSite>` before resolve). `name`/`receiver_name` come from
/// the interner (every site name is interned in stage-5b), `file_id` and the
/// positions/source_ref_id/enclosing_id come straight from the column, and
/// `language`/`edge_kind`/`access_kind` are written as their enum-id bytes.
/// The inline-string fallbacks (unknown language, OTHER edge/access) are
/// unreachable for fresh ref_sites — the stage-5b probe confirmed 0
/// unknown-language sites, and `extract_ref_sites` only emits call/usage +
/// member/bare — so they are intentionally not reconstructed; a future
/// violation would diverge the `bytes` gate rather than corrupt silently.
fn serialize_ref_site_binary_from_cols(
    col: &RefWriteCol,
    receiver_name_id: u32,
    interner: &NameInterner,
    out: &mut Vec<u8>,
) {
    out.extend_from_slice(&col.source_ref_id.to_le_bytes());
    write_u16_str(out, interner.name(col.name_id).unwrap_or(""));
    out.push(0); // raw_text == name marker (B6: field dropped)
    out.extend_from_slice(&col.file_id.to_le_bytes());
    let lang_byte = if col.language_id <= u8::MAX as u16 {
        col.language_id as u8
    } else {
        255
    };
    out.push(lang_byte);
    if lang_byte == 255 || language_str_from_id(col.language_id).is_none() {
        // Unreachable for this corpus (probe: 0 unknown-language sites); emit an
        // empty string to keep the record well-formed. A real unknown language
        // would diverge `bytes` and trip the gate (it cannot be reconstructed
        // from the id alone).
        write_u16_str(out, "");
    }
    out.extend_from_slice(&col.start_line.to_le_bytes());
    out.extend_from_slice(&col.start_column.to_le_bytes());
    out.extend_from_slice(&col.end_line.to_le_bytes());
    out.extend_from_slice(&col.end_column.to_le_bytes());
    out.push(col.edge_kind_id); // standard (call/usage) for fresh ref_sites
    out.push(col.access_kind_id); // standard (member/bare) for fresh ref_sites
    out.push(if col.flags & SITE_FLAG_IS_DEFINITION != 0 { 1 } else { 0 });
    out.push(if col.flags & SITE_FLAG_IS_IMPORT_CONTEXT != 0 { 1 } else { 0 });
    if col.flags & SITE_FLAG_HAS_RECEIVER != 0 {
        out.push(1);
        write_u16_str(out, interner.name(receiver_name_id).unwrap_or(""));
    } else {
        out.push(0);
    }
    if col.enclosing_id != 0 {
        out.push(1);
        out.extend_from_slice(&col.enclosing_id.to_le_bytes());
    } else {
        out.push(0);
    }
}

fn parse_ref_site_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<RefSite> {
    if *cursor + 8 > bytes.len() {
        return Err(invalid_data("ref_site truncated (source_ref_id u64)"));
    }
    let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    // B6 stage-2: RefSite.source_ref_id is a u64. Common path = the u64 read
    // above. The legacy sentinel (u64::MAX + inline string) is parsed back to a
    // u64 (or kept as MAX); fresh writes never emit it.
    let source_ref_id: u64 = if u == u64::MAX {
        let s = read_u16_str(bytes, cursor)?;
        parse_stable_ref_id_to_u64(&s).unwrap_or(u64::MAX)
    } else {
        u
    };
    let name = read_u16_str(bytes, cursor)?;
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (raw_text marker)"));
    }
    let raw_text_marker = bytes[*cursor];
    *cursor += 1;
    // B6: raw_text dropped (== name). Still advance the cursor past a legacy
    // marker-1 inline string if one is present (fresh writes only emit 0).
    if raw_text_marker != 0 {
        let _ = read_u16_str(bytes, cursor)?;
    }
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown ref-site file_id {file_id}")))?
        .to_string();
    // Phase 3 aggressive (RefSite slim): language is a u8 id; 255 = inline
    // string follows. Same for edge_kind / access_kind below.
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (language id)"));
    }
    let lang_byte = bytes[*cursor];
    *cursor += 1;
    let language = match language_str_from_id(lang_byte as u16) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    let start_line = read_u32_le(bytes, cursor)?;
    let start_column = read_u32_le(bytes, cursor)?;
    let end_line = read_u32_le(bytes, cursor)?;
    let end_column = read_u32_le(bytes, cursor)?;
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (edge_kind id)"));
    }
    let edge_id = bytes[*cursor];
    *cursor += 1;
    let edge_kind = match edge_kind_str_from_id(edge_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (access_kind id)"));
    }
    let access_id = bytes[*cursor];
    *cursor += 1;
    let access_kind = match access_kind_str_from_id(access_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    if *cursor + 2 > bytes.len() {
        return Err(invalid_data("ref_site truncated (flags)"));
    }
    let is_definition = bytes[*cursor] == 1;
    let is_import_context = bytes[*cursor + 1] == 1;
    *cursor += 2;
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (receiver marker)"));
    }
    let receiver_marker = bytes[*cursor];
    *cursor += 1;
    let receiver_name = if receiver_marker == 1 {
        Some(read_u16_str(bytes, cursor)?)
    } else {
        None
    };
    if *cursor >= bytes.len() {
        return Err(invalid_data("ref_site truncated (enclosing marker)"));
    }
    let enclosing_marker = bytes[*cursor];
    *cursor += 1;
    // B6 stage-3: decode straight to the u64 (0 = absent); no "sym:HEX16"
    // string is rebuilt on the read path (the hot loop keys on the u64).
    let enclosing_id: u64 = match enclosing_marker {
        0 => 0,
        1 => {
            if *cursor + 8 > bytes.len() {
                return Err(invalid_data("ref_site truncated (enclosing u64)"));
            }
            let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
            *cursor += 8;
            u
        }
        2 => {
            // Legacy non-standard id (fresh writes never emit marker 2); parse
            // back to the u64, defaulting to 0 (= none) when unparseable.
            let s = read_u16_str(bytes, cursor)?;
            parse_stable_symbol_id_to_u64(&s).unwrap_or(0)
        }
        _ => return Err(invalid_data("ref_site invalid enclosing marker")),
    };
    let rel_path_hash = stable_hash(&rel_path);
    let name_hash = stable_hash(&name);
    let receiver_name_hash = receiver_name.as_deref().map(stable_hash).unwrap_or(0);
    let access_kind_id = compute_access_kind_id(&access_kind);
    let edge_kind_id = compute_edge_kind_id(&edge_kind);
    Ok(RefSite {
        source_ref_id,
        name,
        // P1: struct fields are now `Arc<str>` (From<String> allocates once here,
        // on the cold read path — fine; the hot parse path shares per-file Arcs).
        rel_path: rel_path.into(),
        language: language.into(),
        start_line,
        start_column,
        end_line,
        end_column,
        edge_kind: edge_kind.into(),
        access_kind: access_kind.into(),
        is_definition,
        is_import_context,
        receiver_name,
        enclosing_id,
        rel_path_hash,
        name_hash,
        receiver_name_hash,
        access_kind_id,
        edge_kind_id,
    })
}

fn parse_reference_binary(
    bytes: &[u8],
    cursor: &mut usize,
    file_table: &FileTable,
) -> io::Result<GraphReference> {
    // source_ref_id: u64 (u64::MAX sentinel = inline str follows).
    if *cursor + 8 > bytes.len() {
        return Err(invalid_data("reference truncated (source_ref_id u64)"));
    }
    let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
    *cursor += 8;
    let source_ref_id = if u == u64::MAX {
        read_u16_str(bytes, cursor)?
    } else {
        format!("ref:{:016x}", u)
    };
    // target_symbol_id: 0=none, 1=u64, 2=inline.
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (target marker)"));
    }
    let target_kind = bytes[*cursor];
    *cursor += 1;
    let target_symbol_id = match target_kind {
        0 => None,
        1 => {
            if *cursor + 8 > bytes.len() {
                return Err(invalid_data("reference truncated (target u64)"));
            }
            let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
            *cursor += 8;
            Some(format!("sym:{:016x}", u))
        }
        2 => Some(read_u16_str(bytes, cursor)?),
        other => {
            return Err(invalid_data(format!(
                "reference invalid target_kind {other}"
            )))
        }
    };
    // edge_kind: u8 id (255=inline).
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (edge_id)"));
    }
    let edge_id = bytes[*cursor];
    *cursor += 1;
    let edge_kind = match edge_kind_str_from_id(edge_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    let name = read_u16_str(bytes, cursor)?;
    // raw_text marker: 0=same as name, 1=inline.
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (raw_text marker)"));
    }
    let raw_text_marker = bytes[*cursor];
    *cursor += 1;
    let raw_text = if raw_text_marker == 0 {
        name.clone()
    } else {
        read_u16_str(bytes, cursor)?
    };
    let file_id = read_u32_le(bytes, cursor)?;
    let rel_path = file_table
        .get_path(file_id)
        .ok_or_else(|| invalid_data(format!("unknown reference file_id {file_id}")))?
        .to_string();
    let start_line = read_u32_le(bytes, cursor)?;
    let start_column = read_u32_le(bytes, cursor)?;
    let end_line = read_u32_le(bytes, cursor)?;
    let end_column = read_u32_le(bytes, cursor)?;
    // enclosing_symbol_id: 0=none, 1=u64, 2=inline.
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (enclosing marker)"));
    }
    let enclosing_kind = bytes[*cursor];
    *cursor += 1;
    let enclosing_symbol_id = match enclosing_kind {
        0 => None,
        1 => {
            if *cursor + 8 > bytes.len() {
                return Err(invalid_data("reference truncated (enclosing u64)"));
            }
            let u = u64::from_le_bytes(bytes[*cursor..*cursor + 8].try_into().unwrap());
            *cursor += 8;
            Some(format!("sym:{:016x}", u))
        }
        2 => Some(read_u16_str(bytes, cursor)?),
        other => {
            return Err(invalid_data(format!(
                "reference invalid enclosing_kind {other}"
            )))
        }
    };
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (bound_mask)"));
    }
    let bound_mask = bytes[*cursor];
    *cursor += 1;
    // confidence: u8 id (255=inline).
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (confidence_id)"));
    }
    let conf_id = bytes[*cursor];
    *cursor += 1;
    let confidence = match confidence_str_from_id(conf_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    // provenance: u8 id (255=inline).
    if *cursor >= bytes.len() {
        return Err(invalid_data("reference truncated (provenance_id)"));
    }
    let prov_id = bytes[*cursor];
    *cursor += 1;
    let provenance = match provenance_str_from_id(prov_id) {
        Some(s) => s.to_string(),
        None => read_u16_str(bytes, cursor)?,
    };
    Ok(GraphReference {
        source_ref_id: source_ref_id.into(),
        target_symbol_id: target_symbol_id.map(Into::into),
        edge_kind: edge_kind.into(),
        name: name.into(),
        raw_text: raw_text.into(),
        uri: Box::<str>::default(),
        rel_path: rel_path.into(),
        start_line,
        start_column,
        end_line,
        end_column,
        enclosing_symbol_id: enclosing_symbol_id.map(Into::into),
        bound_mask,
        confidence: confidence.into(),
        provenance: provenance.into(),
    })
}

fn read_binary_references_matching<F>(
    path: &Path,
    file_table: &FileTable,
    mut matches: F,
) -> io::Result<Vec<GraphReference>>
where
    F: FnMut(&GraphReference) -> bool,
{
    let bytes = fs::read(path)?;
    let mut references = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let r = parse_reference_binary(&bytes, &mut cursor, file_table)?;
        if matches(&r) {
            references.push(r);
        }
    }
    Ok(references)
}

fn serialize_count_row(symbol_id: &str, count: &GraphCount) -> String {
    let mut row = [
        "C".to_string(),
        encode_field(symbol_id),
        count.usage_likely.to_string(),
        count.usage_must.to_string(),
        count.usage_may.to_string(),
        count.calls_in_likely.to_string(),
        count.calls_in_must.to_string(),
        count.calls_in_may.to_string(),
        count.calls_out_must.to_string(),
        count.calls_out_may.to_string(),
        count.impl_must.to_string(),
        count.impl_may.to_string(),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn serialize_hierarchy_child_row(
    lookup_key: &str,
    parent_name: &str,
    child_symbol_id: &str,
    child_qualified_name: &str,
) -> String {
    let mut row = [
        "H".to_string(),
        encode_field(lookup_key),
        encode_field(parent_name),
        encode_field(child_symbol_id),
        encode_field(child_qualified_name),
    ]
    .join("\t");
    row.push('\n');
    row
}

fn read_symbols(path: &Path, file_table: &FileTable) -> io::Result<Vec<GraphSymbol>> {
    let bytes = fs::read(path)?;
    let mut symbols = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        symbols.push(parse_symbol_binary(&bytes, &mut cursor, file_table)?);
    }
    Ok(symbols)
}

fn read_symbols_matching<F>(
    path: &Path,
    file_table: &FileTable,
    mut matches: F,
) -> io::Result<Vec<GraphSymbol>>
where
    F: FnMut(&GraphSymbol) -> bool,
{
    let bytes = fs::read(path)?;
    let mut symbols = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let s = parse_symbol_binary(&bytes, &mut cursor, file_table)?;
        if matches(&s) {
            symbols.push(s);
        }
    }
    Ok(symbols)
}

fn read_symbols_for_symbol_ids_indexed(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_ids: &HashSet<String>,
) -> io::Result<Vec<GraphSymbol>> {
    if symbol_ids.is_empty() {
        return Ok(Vec::new());
    }
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    if !graph_shard_family_available(workspace_root, config, GRAPH_SYMBOL_ID_SHARD_PREFIX) {
        let symbol_path = graph_symbol_index_path(workspace_root, config);
        if !symbol_path.exists() {
            return Ok(Vec::new());
        }
        return read_symbols_matching(&symbol_path, &file_table, |s| {
            symbol_ids.contains(&s.id)
        });
    }

    let mut by_shard: BTreeMap<usize, HashSet<String>> = BTreeMap::new();
    for symbol_id in symbol_ids {
        let shard_key = symbol_id.to_ascii_lowercase();
        by_shard
            .entry(shard_index_for_key(&shard_key))
            .or_default()
            .insert(symbol_id.clone());
    }

    let mut symbols = Vec::new();
    for (_, shard_symbol_ids) in by_shard {
        let Some(first_symbol_id) = shard_symbol_ids.iter().next() else {
            continue;
        };
        let shard_path = graph_symbol_id_shard_path(workspace_root, config, first_symbol_id);
        if !shard_path.exists() {
            let symbol_path = graph_symbol_index_path(workspace_root, config);
            if !symbol_path.exists() {
                continue;
            }
            return read_symbols_matching(
                &symbol_path,
                &file_table,
                |s| symbol_ids.contains(&s.id),
            );
        }
        symbols.extend(read_symbols_matching(&shard_path, &file_table, |s| {
            shard_symbol_ids.contains(&s.id)
        })?);
    }
    Ok(symbols)
}

fn read_methods_for_container_names_indexed(
    workspace_root: &Path,
    config: &EngineConfig,
    container_names: &HashSet<String>,
    method_name: &str,
) -> io::Result<Vec<GraphSymbol>> {
    if container_names.is_empty() {
        return Ok(Vec::new());
    }
    let file_table_path = graph_file_table_path(workspace_root, config);
    let file_table = if file_table_path.exists() {
        read_file_table_binary(&file_table_path).unwrap_or_default()
    } else {
        FileTable::default()
    };
    let mut by_shard: BTreeMap<usize, HashSet<String>> = BTreeMap::new();
    for container_name in container_names {
        for lookup_key in graph_name_lookup_keys(container_name) {
            by_shard
                .entry(shard_index_for_key(&lookup_key))
                .or_default()
                .insert(lookup_key);
        }
    }

    let mut candidate_ids: HashSet<String> = HashSet::default();
    for (_, shard_keys) in by_shard {
        let Some(first_key) = shard_keys.iter().next() else {
            continue;
        };
        let shard_path = graph_method_container_shard_path(workspace_root, config, first_key);
        if !shard_path.exists() {
            continue;
        }
        let bytes = fs::read(&shard_path)?;
        let mut cursor = 0;
        while cursor < bytes.len() {
            let lookup_key = read_u16_str(&bytes, &mut cursor)?;
            let symbol_id = read_u16_str(&bytes, &mut cursor)?;
            if shard_keys.contains(&lookup_key) {
                candidate_ids.insert(symbol_id);
            }
        }
    }
    drop(file_table);
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    let all = read_symbols_for_symbol_ids_indexed(workspace_root, config, &candidate_ids)?;
    Ok(all
        .into_iter()
        .filter(|s| {
            if s.name != method_name || s.kind != "method" {
                return false;
            }
            match s.container_name.as_deref() {
                Some(cn) => container_names.contains(cn) || container_names.contains(type_tail(cn)),
                None => false,
            }
        })
        .collect())
}

fn read_hierarchy_children_for_parent_keys_indexed(
    workspace_root: &Path,
    config: &EngineConfig,
    parent_keys: &HashSet<String>,
) -> io::Result<Vec<(String, String)>> {
    if parent_keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut by_shard: BTreeMap<usize, HashSet<String>> = BTreeMap::new();
    for parent_key in parent_keys {
        by_shard
            .entry(shard_index_for_key(parent_key))
            .or_default()
            .insert(parent_key.clone());
    }

    let mut children = Vec::new();
    for (_, shard_keys) in by_shard {
        let Some(first_key) = shard_keys.iter().next() else {
            continue;
        };
        let shard_path = graph_hierarchy_parent_shard_path(workspace_root, config, first_key);
        if !shard_path.exists() {
            continue;
        }
        let bytes = fs::read(&shard_path)?;
        let mut cursor = 0;
        while cursor < bytes.len() {
            let lookup_key = read_u16_str(&bytes, &mut cursor)?;
            let _parent_name = read_u16_str(&bytes, &mut cursor)?;
            let child_symbol_id = read_u16_str(&bytes, &mut cursor)?;
            let child_qualified_name = read_u16_str(&bytes, &mut cursor)?;
            if !shard_keys.contains(&lookup_key) {
                continue;
            }
            children.push((child_symbol_id, child_qualified_name));
        }
    }
    Ok(children)
}

fn validate_symbol_fields(fields: &[&str]) -> io::Result<()> {
    if fields.len() != 21 || fields[0] != "S" {
        return Err(invalid_data(format!(
            "invalid graph symbol row with {} fields",
            fields.len()
        )));
    }
    Ok(())
}

fn parse_symbol_fields(fields: &[&str]) -> io::Result<GraphSymbol> {
    validate_symbol_fields(fields)?;
    let kind = decode_field(fields[4])?;
    let kind_flags = compute_kind_flags(&kind);
    let language = decode_field(fields[5])?;
    let language_id = compute_language_id(&language);
    let id_field: String = decode_field(fields[1])?;
    let id_u64 = parse_stable_symbol_id_to_u64(&id_field).unwrap_or(0);
    let rel_path: String = decode_field(fields[7])?;
    let rel_path_hash = stable_hash(&rel_path);
    let name: String = decode_field(fields[2])?;
    let name_hash = stable_hash(&name);
    Ok(GraphSymbol {
        id: id_field,
        name,
        qualified_name: decode_field(fields[3])?,
        kind,
        language,
        uri: decode_field(fields[6])?,
        rel_path,
        start_line: parse_u32(fields[8], "startLine")?,
        start_column: parse_u32(fields[9], "startColumn")?,
        end_line: parse_u32(fields[10], "endLine")?,
        end_column: parse_u32(fields[11], "endColumn")?,
        body_start_line: parse_u32(fields[12], "bodyStartLine")?,
        body_start_column: parse_u32(fields[13], "bodyStartColumn")?,
        body_end_line: parse_u32(fields[14], "bodyEndLine")?,
        body_end_column: parse_u32(fields[15], "bodyEndColumn")?,
        container_id: empty_string_to_none(decode_field(fields[16])?),
        container_name: empty_string_to_none(decode_field(fields[17])?),
        package_name: empty_string_to_none(decode_field(fields[18])?),
        extends_names: decode_list(fields[19])?,
        implements_names: decode_list(fields[20])?,
        usage_count: None,
        usage_must_count: None,
        usage_may_count: None,
        implementation_count: None,
        implementation_must_count: None,
        implementation_may_count: None,
        kind_flags,
        language_id,
        id_u64,
        rel_path_hash,
        name_hash,
    })
}

fn read_references_matching<F>(path: &Path, mut matches: F) -> io::Result<Vec<GraphReference>>
where
    F: FnMut(&[&str], usize) -> io::Result<bool>,
{
    let mut references = Vec::new();
    let bytes = fs::read(path)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let offset = validate_reference_fields(&fields)?;
        if matches(&fields, offset)? {
            references.push(parse_reference_fields(&fields, offset)?);
        }
    }
    Ok(references)
}

fn validate_reference_fields(fields: &[&str]) -> io::Result<usize> {
    if !(fields.len() == 15 || fields.len() == 16) || fields[0] != "E" {
        return Err(invalid_data(format!(
            "invalid graph edge row with {} fields",
            fields.len()
        )));
    }
    Ok(if fields.len() == 16 { 1 } else { 0 })
}

fn parse_reference_fields(fields: &[&str], offset: usize) -> io::Result<GraphReference> {
    let name = decode_field(fields[3 + offset])?;
    let rel_path = decode_field(fields[6 + offset])?;
    let start_line = parse_u32(fields[7 + offset], "startLine")?;
    let start_column = parse_u32(fields[8 + offset], "startColumn")?;
    let source_ref_id = if offset == 1 {
        decode_field(fields[1])?
    } else {
        stable_ref_id(&rel_path, start_line, start_column, &name)
    };
    Ok(GraphReference {
        source_ref_id: source_ref_id.into(),
        target_symbol_id: empty_string_to_none(decode_field(fields[1 + offset])?).map(Into::into),
        edge_kind: decode_field(fields[2 + offset])?.into(),
        name: name.into(),
        raw_text: decode_field(fields[4 + offset])?.into(),
        uri: decode_field(fields[5 + offset])?.into(),
        rel_path: rel_path.into(),
        start_line,
        start_column,
        end_line: parse_u32(fields[9 + offset], "endLine")?,
        end_column: parse_u32(fields[10 + offset], "endColumn")?,
        enclosing_symbol_id: empty_string_to_none(decode_field(fields[11 + offset])?).map(Into::into),
        bound_mask: fields[12 + offset]
            .parse::<u8>()
            .map_err(|_| invalid_data("invalid bound mask"))?,
        confidence: decode_field(fields[13 + offset])?.into(),
        provenance: decode_field(fields[14 + offset])?.into(),
    })
}

fn read_counts(path: &Path) -> io::Result<HashMap<String, GraphCount>> {
    let bytes = fs::read(path)?;
    let mut counts: HashMap<String, GraphCount> = HashMap::default();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let (symbol_id, count) = parse_count_binary(&bytes, &mut cursor)?;
        counts.insert(symbol_id, count);
    }
    Ok(counts)
}

fn read_counts_for_symbol_ids(
    path: &Path,
    symbol_ids: &HashSet<String>,
) -> io::Result<HashMap<String, GraphCount>> {
    let mut counts: HashMap<String, GraphCount> = HashMap::default();
    if symbol_ids.is_empty() {
        return Ok(counts);
    }
    let bytes = fs::read(path)?;
    let mut cursor = 0;
    while cursor < bytes.len() {
        let (symbol_id, count) = parse_count_binary(&bytes, &mut cursor)?;
        if symbol_ids.contains(&symbol_id) {
            counts.insert(symbol_id, count);
            if counts.len() >= symbol_ids.len() {
                break;
            }
        }
    }
    Ok(counts)
}

fn read_counts_for_symbol_ids_indexed(
    workspace_root: &Path,
    config: &EngineConfig,
    symbol_ids: &HashSet<String>,
) -> io::Result<HashMap<String, GraphCount>> {
    if symbol_ids.is_empty() {
        return Ok(HashMap::new());
    }
    if !graph_shard_family_available(workspace_root, config, GRAPH_COUNT_ID_SHARD_PREFIX) {
        let count_path = graph_count_index_path(workspace_root, config);
        if !count_path.exists() {
            return Ok(HashMap::new());
        }
        return read_counts_for_symbol_ids(&count_path, symbol_ids);
    }

    let mut by_shard: BTreeMap<usize, HashSet<String>> = BTreeMap::new();
    for symbol_id in symbol_ids {
        let shard_key = symbol_id.to_ascii_lowercase();
        by_shard
            .entry(shard_index_for_key(&shard_key))
            .or_default()
            .insert(symbol_id.clone());
    }

    let mut counts = HashMap::new();
    for (shard, shard_symbol_ids) in by_shard {
        let Some(first_symbol_id) = shard_symbol_ids.iter().next() else {
            continue;
        };
        let shard_path = graph_count_id_shard_path(workspace_root, config, first_symbol_id);
        debug_assert_eq!(
            shard,
            shard_index_for_key(&first_symbol_id.to_ascii_lowercase())
        );
        if !shard_path.exists() {
            let count_path = graph_count_index_path(workspace_root, config);
            if !count_path.exists() {
                continue;
            }
            return read_counts_for_symbol_ids(&count_path, symbol_ids);
        }
        counts.extend(read_counts_for_symbol_ids(&shard_path, &shard_symbol_ids)?);
    }
    Ok(counts)
}

fn validate_count_fields(fields: &[&str]) -> io::Result<()> {
    if !(fields.len() == 10 || fields.len() == 12) || fields[0] != "C" {
        return Err(invalid_data(format!(
            "invalid graph count row with {} fields",
            fields.len()
        )));
    }
    Ok(())
}

fn parse_count_fields(fields: &[&str]) -> io::Result<(String, GraphCount)> {
    validate_count_fields(fields)?;
    let has_likely = fields.len() == 12;
    let usage_likely = if has_likely {
        parse_usize(fields[2], "usageLikely")?
    } else {
        parse_usize(fields[3], "usageMay")?
    };
    let usage_must_idx = if has_likely { 3 } else { 2 };
    let usage_may_idx = if has_likely { 4 } else { 3 };
    let calls_in_likely = if has_likely {
        parse_usize(fields[5], "callsInLikely")?
    } else {
        parse_usize(fields[5], "callsInMay")?
    };
    let calls_in_must_idx = if has_likely { 6 } else { 4 };
    let calls_in_may_idx = if has_likely { 7 } else { 5 };
    let calls_out_must_idx = if has_likely { 8 } else { 6 };
    let calls_out_may_idx = if has_likely { 9 } else { 7 };
    let impl_must_idx = if has_likely { 10 } else { 8 };
    let impl_may_idx = if has_likely { 11 } else { 9 };
    Ok((
        decode_field(fields[1])?,
        GraphCount {
            usage_likely,
            usage_must: parse_usize(fields[usage_must_idx], "usageMust")?,
            usage_may: parse_usize(fields[usage_may_idx], "usageMay")?,
            calls_in_likely,
            calls_in_must: parse_usize(fields[calls_in_must_idx], "callsInMust")?,
            calls_in_may: parse_usize(fields[calls_in_may_idx], "callsInMay")?,
            calls_out_must: parse_usize(fields[calls_out_must_idx], "callsOutMust")?,
            calls_out_may: parse_usize(fields[calls_out_may_idx], "callsOutMay")?,
            impl_must: parse_usize(fields[impl_must_idx], "implMust")?,
            impl_may: parse_usize(fields[impl_may_idx], "implMay")?,
        },
    ))
}

fn apply_count_options_for_symbols(
    workspace_root: &Path,
    config: &EngineConfig,
    symbols: &mut [GraphSymbol],
    options: GraphSymbolQueryOptions,
) -> io::Result<()> {
    if !options.include_usage_counts && !options.include_implementation_counts {
        return Ok(());
    }
    let count_path = graph_count_index_path(workspace_root, config);
    if !count_path.exists()
        && !graph_shard_family_available(workspace_root, config, GRAPH_COUNT_ID_SHARD_PREFIX)
    {
        return Ok(());
    }
    let symbol_ids: HashSet<String> = symbols.iter().map(|symbol| symbol.id.clone()).collect();
    let counts = read_counts_for_symbol_ids_indexed(workspace_root, config, &symbol_ids)?;
    for symbol in symbols {
        apply_count_options(symbol, &counts, options);
    }
    Ok(())
}

fn apply_count_options(
    symbol: &mut GraphSymbol,
    counts: &HashMap<String, GraphCount>,
    options: GraphSymbolQueryOptions,
) {
    let count = counts.get(&symbol.id).copied().unwrap_or_default();
    symbol.usage_count = options.include_usage_counts.then_some(count.usage_likely);
    symbol.usage_must_count = options.include_usage_counts.then_some(count.usage_must);
    symbol.usage_may_count = options.include_usage_counts.then_some(count.usage_may);
    symbol.implementation_count = options
        .include_implementation_counts
        .then_some(count.impl_may);
    symbol.implementation_must_count = options
        .include_implementation_counts
        .then_some(count.impl_must);
    symbol.implementation_may_count = options
        .include_implementation_counts
        .then_some(count.impl_may);
}

fn descendant_type_names(
    target: &GraphSymbol,
    symbols: &[GraphSymbol],
    hierarchy_facts: &[HierarchyFact],
) -> HashSet<String> {
    let type_names: HashSet<&str> = symbols
        .iter()
        .filter(|symbol| is_type_kind_sym(symbol))
        .flat_map(|symbol| [symbol.qualified_name.as_str(), symbol.name.as_str()])
        .collect();
    let mut descendants = HashSet::new();
    let mut changed = true;
    while changed {
        changed = false;
        for fact in hierarchy_facts {
            if !matches!(fact.relation.as_str(), "extends" | "implements") {
                continue;
            }
            let direct = fact_parent_matches_symbol(fact, target);
            let indirect = descendants.contains(&fact.parent_name)
                || descendants.contains(type_tail(&fact.parent_name));
            if !(direct || indirect) {
                continue;
            }
            if fact.child_qualified_name == target.qualified_name {
                continue;
            }
            if descendants.insert(fact.child_qualified_name.clone()) {
                let tail = type_tail(&fact.child_qualified_name).to_string();
                if type_names.contains(tail.as_str()) {
                    descendants.insert(tail);
                }
                changed = true;
            }
        }
    }
    descendants
}

fn descendant_type_ids_and_names_indexed(
    workspace_root: &Path,
    config: &EngineConfig,
    target: &GraphSymbol,
) -> io::Result<(HashSet<String>, HashSet<String>)> {
    let mut descendant_ids = HashSet::new();
    let mut descendant_names = HashSet::new();
    let mut visited_keys = HashSet::new();
    let mut frontier: Vec<String> = graph_name_lookup_keys(&target.qualified_name)
        .into_iter()
        .chain(graph_name_lookup_keys(&target.name))
        .collect();

    while !frontier.is_empty() {
        let mut keys = HashSet::new();
        while let Some(key) = frontier.pop() {
            if visited_keys.insert(key.clone()) {
                keys.insert(key);
            }
        }
        if keys.is_empty() {
            continue;
        }
        for (child_id, child_qualified_name) in
            read_hierarchy_children_for_parent_keys_indexed(workspace_root, config, &keys)?
        {
            if child_qualified_name == target.qualified_name {
                continue;
            }
            if descendant_ids.insert(child_id) {
                for lookup_key in graph_name_lookup_keys(&child_qualified_name) {
                    if !visited_keys.contains(&lookup_key) {
                        frontier.push(lookup_key);
                    }
                }
                descendant_names.insert(child_qualified_name.clone());
                descendant_names.insert(type_tail(&child_qualified_name).to_string());
            }
        }
    }
    Ok((descendant_ids, descendant_names))
}

fn graph_name_lookup_keys(name: &str) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    if !name.is_empty() {
        keys.insert(name.to_string());
        keys.insert(type_tail(name).to_string());
    }
    keys
}

fn fact_parent_matches_symbol(fact: &HierarchyFact, target: &GraphSymbol) -> bool {
    fact.parent_name == target.name
        || fact.parent_name == target.qualified_name
        || type_tail(&fact.parent_name) == target.name
        || type_tail(&fact.parent_name) == target.qualified_name
}

fn score_symbol_match(symbol: &GraphSymbol, query: &str) -> i32 {
    if query.is_empty() {
        return 0;
    }
    if symbol.id == query {
        110
    } else if symbol.id.eq_ignore_ascii_case(query) {
        105
    } else if symbol.qualified_name == query {
        100
    } else if symbol.name == query {
        90
    } else if symbol.qualified_name.eq_ignore_ascii_case(query) {
        80
    } else if symbol.name.eq_ignore_ascii_case(query) {
        70
    } else if symbol.qualified_name.contains(query) {
        40
    } else if symbol.name.contains(query) {
        30
    } else {
        0
    }
}

/// Sweep over lexical-scope symbols sorted by start_line to compute the
/// enclosing scope for every line in [0, line_count). Used by parsers whose
/// per-line cost was previously O(symbols.len()).
fn precompute_enclosing_per_line(
    symbols: &[GraphSymbol],
    line_count: u32,
) -> Vec<Option<String>> {
    let mut scope_symbols: Vec<&GraphSymbol> = symbols
        .iter()
        .filter(|s| is_lexical_scope_symbol(&s.kind))
        .collect();
    scope_symbols.sort_by_key(|s| (s.start_line, s.start_column));
    let mut out: Vec<Option<String>> = vec![None; line_count as usize];
    let mut active: Vec<&GraphSymbol> = Vec::new();
    let mut next_idx = 0usize;
    for line in 0..line_count {
        while next_idx < scope_symbols.len() && scope_symbols[next_idx].start_line <= line {
            active.push(scope_symbols[next_idx]);
            next_idx += 1;
        }
        active.retain(|s| s.body_end_line >= line);
        out[line as usize] = active
            .iter()
            .max_by(|a, b| {
                a.start_line
                    .cmp(&b.start_line)
                    .then_with(|| a.start_column.cmp(&b.start_column))
            })
            .map(|s| s.id.clone());
    }
    out
}

fn enclosing_type_fact_scope_for_line(symbols: &[GraphSymbol], line: u32) -> Option<String> {
    symbols
        .iter()
        .filter(|symbol| symbol.start_line <= line && line <= symbol.body_end_line)
        .filter(|symbol| is_lexical_scope_symbol(&symbol.kind))
        .max_by(|left, right| {
            left.start_line
                .cmp(&right.start_line)
                .then_with(|| left.start_column.cmp(&right.start_column))
        })
        .map(|symbol| symbol.id.clone())
}

fn python_class_from_line(trimmed: &str) -> Option<(String, Vec<String>)> {
    let rest = strip_keyword(trimmed, "class")?;
    let name = leading_identifier(rest)?;
    let extends = rest
        .find('(')
        .and_then(|start| {
            rest[start + 1..]
                .find(')')
                .map(|end| &rest[start + 1..start + 1 + end])
        })
        .map(split_type_list)
        .unwrap_or_default();
    Some((name, extends))
}

fn python_function_from_line(trimmed: &str) -> Option<String> {
    let rest = strip_keyword(trimmed, "def").or_else(|| strip_keyword(trimmed, "async def"))?;
    leading_identifier(rest)
}

fn simple_assignment_name(trimmed: &str) -> Option<String> {
    if trimmed.starts_with("self.") || trimmed.starts_with("return ") {
        return None;
    }
    let name = leading_identifier(trimmed)?;
    let rest = &trimmed[name.len()..];
    if rest.trim_start().starts_with('=') || rest.trim_start().starts_with(':') {
        Some(name)
    } else {
        None
    }
}

fn brace_type_from_line(trimmed: &str) -> Option<(String, String, Vec<String>, Vec<String>)> {
    for keyword in ["class", "interface", "enum", "struct", "type"] {
        let Some(rest) = find_keyword_tail(trimmed, keyword) else {
            continue;
        };
        let Some(name) = leading_identifier(rest) else {
            continue;
        };
        let kind = match keyword {
            "interface" => "interface",
            "enum" => "enum",
            "struct" => "struct",
            "type" => "type",
            _ => "class",
        }
        .to_string();
        let tail = &rest[name.len()..];
        let extends = names_after_marker(tail, "extends");
        let implements = names_after_marker(tail, "implements");
        return Some((kind, name, extends, implements));
    }
    None
}

fn brace_function_from_line(trimmed: &str) -> Option<String> {
    if let Some(rest) = find_keyword_tail(trimmed, "function") {
        return leading_identifier(rest);
    }
    let open = trimmed.find('(')?;
    let before = trimmed[..open].trim_end();
    let before_start = before.trim_start();
    if before.is_empty()
        || before.contains('=')
        || before.contains('.')
        || before_start.starts_with("return ")
        || before_start.starts_with("throw ")
        || before.ends_with("if")
        || before.ends_with("for")
        || before.ends_with("while")
        || before.ends_with("switch")
        || before.ends_with("catch")
    {
        return None;
    }
    let name = trailing_identifier(before)?;
    if is_keyword(&name, "typescript") {
        None
    } else {
        Some(name)
    }
}

fn brace_assignment_name(trimmed: &str) -> Option<String> {
    for keyword in ["const", "let", "var", "final", "static"] {
        if let Some(rest) = find_keyword_tail(trimmed, keyword) {
            return leading_identifier(rest);
        }
    }
    None
}

fn package_from_line(trimmed: &str, language: &str) -> Option<String> {
    if matches!(language, "java" | "kotlin") {
        strip_keyword(trimmed, "package").map(|rest| rest.trim_end_matches(';').trim().to_string())
    } else {
        None
    }
}

fn python_module_candidates(rel_path: &str, module_name: &str) -> Vec<String> {
    let dot_count = module_name.chars().take_while(|ch| *ch == '.').count();
    let tail = module_name.trim_start_matches('.');
    let mut parts: Vec<String> = if dot_count > 0 {
        let mut base: Vec<String> = rel_path.split('/').map(ToString::to_string).collect();
        base.pop();
        for _ in 1..dot_count {
            base.pop();
        }
        base
    } else {
        Vec::new()
    };
    if !tail.is_empty() {
        parts.extend(
            tail.split('.')
                .filter(|part| !part.is_empty())
                .map(ToString::to_string),
        );
    } else if dot_count == 0 {
        return Vec::new();
    }
    let module_path = parts.join("/");
    python_module_path_candidates(&module_path)
}

fn python_module_path_candidates(module_path: &str) -> Vec<String> {
    if module_path.is_empty() {
        return Vec::new();
    }
    vec![
        format!("{module_path}.py"),
        format!("{module_path}.pyi"),
        format!("{module_path}/__init__.py"),
        format!("{module_path}/__init__.pyi"),
    ]
}

fn ts_module_candidates(rel_path: &str, module_specifier: &str) -> Vec<String> {
    if !module_specifier.starts_with('.') {
        return Vec::new();
    }
    let mut base: Vec<String> = rel_path.split('/').map(ToString::to_string).collect();
    base.pop();
    for part in module_specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                base.pop();
            }
            value => base.push(value.to_string()),
        }
    }
    let module_path = base.join("/");
    let mut out = Vec::new();
    for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
        out.push(format!("{module_path}.{ext}"));
        out.push(format!("{module_path}/index.{ext}"));
    }
    out
}

fn strip_grouping_parens(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.starts_with('(') && trimmed.ends_with(')') {
        trimmed[1..trimmed.len().saturating_sub(1)].trim()
    } else {
        trimmed
    }
}

fn split_top_level_commas(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (idx, ch) in value.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                let item = value[start..idx].trim();
                if !item.is_empty() {
                    out.push(item.to_string());
                }
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }
    let item = value[start..].trim().trim_end_matches(';').trim();
    if !item.is_empty() {
        out.push(item.to_string());
    }
    out
}

fn import_alias_pair(item: &str) -> (String, String) {
    let item = item
        .trim()
        .trim_start_matches("type ")
        .trim_end_matches(';')
        .trim();
    if let Some((left, right)) = item.split_once(" as ") {
        return (clean_import_name(left), clean_import_name(right));
    }
    let name = clean_import_name(item);
    (name.clone(), name)
}

fn destructuring_alias_pair(item: &str) -> (String, String) {
    let item = item.trim().trim_end_matches(';').trim();
    if let Some((left, right)) = item.split_once(':') {
        return (clean_import_name(left), clean_import_name(right));
    }
    import_alias_pair(item)
}

fn clean_import_name(value: &str) -> String {
    value
        .trim()
        .trim_matches('{')
        .trim_matches('}')
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn ts_namespace_import_name(value: &str) -> Option<String> {
    let import_tail = value
        .strip_prefix("import")?
        .trim_start()
        .trim_start_matches("type ")
        .trim_start();
    let namespace_tail = import_tail.strip_prefix("*")?.trim_start();
    let alias_tail = namespace_tail.strip_prefix("as")?.trim_start();
    leading_identifier(alias_tail)
}

fn quoted_module_specifier(value: &str) -> Option<String> {
    let mut out = None;
    let mut chars = value.char_indices();
    while let Some((start, ch)) = chars.next() {
        if ch != '"' && ch != '\'' {
            continue;
        }
        let quote = ch;
        let content_start = start + ch.len_utf8();
        for (end, inner) in chars.by_ref() {
            if inner == quote {
                out = Some(value[content_start..end].to_string());
                break;
            }
        }
    }
    out
}

fn brace_range(value: &str) -> Option<(usize, usize)> {
    let start = value.find('{')?;
    let mut depth = 0i32;
    for (idx, ch) in value[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((start, start + idx));
                }
            }
            _ => {}
        }
    }
    None
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(is_ident_start) && chars.all(is_ident_continue)
}

fn python_package_name(rel_path: &str) -> Option<String> {
    let path = rel_path.trim_end_matches(".py").trim_end_matches(".pyi");
    let mut parts: Vec<&str> = path.split('/').collect();
    if parts.last().is_some_and(|last| *last == "__init__") {
        parts.pop();
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("."))
    }
}

fn strip_keyword<'a>(value: &'a str, keyword: &str) -> Option<&'a str> {
    value
        .strip_prefix(keyword)
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map(str::trim_start)
}

fn find_keyword_tail<'a>(value: &'a str, keyword: &str) -> Option<&'a str> {
    let idx = value.find(keyword)?;
    let before = &value[..idx];
    if before.chars().last().is_some_and(is_ident_continue) {
        return None;
    }
    let after = &value[idx + keyword.len()..];
    if !after.starts_with(char::is_whitespace) {
        return None;
    }
    Some(after.trim_start())
}

fn leading_identifier(value: &str) -> Option<String> {
    let mut chars = value.char_indices();
    let (_, first) = chars.next()?;
    if !is_ident_start(first) {
        return None;
    }
    let mut end = first.len_utf8();
    for (idx, ch) in chars {
        if is_ident_continue(ch) {
            end = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    Some(value[..end].to_string())
}

fn trailing_identifier(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut end = bytes.len();
    while end > 0 && !is_ident_continue(bytes[end - 1] as char) {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && is_ident_continue(bytes[start - 1] as char) {
        start -= 1;
    }
    if start == end {
        return None;
    }
    let name = &value[start..end];
    name.chars().next().filter(|ch| is_ident_start(*ch))?;
    Some(name.to_string())
}

fn names_after_marker(value: &str, marker: &str) -> Vec<String> {
    let Some(idx) = value.find(marker) else {
        return Vec::new();
    };
    let tail = &value[idx + marker.len()..];
    let end = tail
        .find(|ch: char| matches!(ch, '{' | '=' | ';'))
        .unwrap_or(tail.len());
    split_type_list(&tail[..end])
}

fn split_type_list(value: &str) -> Vec<String> {
    value
        .split(|ch: char| matches!(ch, ',' | '&' | '|'))
        .filter_map(|part| {
            let name = part
                .trim()
                .trim_start_matches("public ")
                .trim_start_matches("private ")
                .trim_start_matches("protected ")
                .trim();
            let name = leading_qualified_identifier(name)?;
            Some(name)
        })
        .collect()
}

fn leading_qualified_identifier(value: &str) -> Option<String> {
    let mut out = String::new();
    for ch in value.chars() {
        if is_ident_continue(ch) || ch == '.' {
            out.push(ch);
        } else {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn sanitize_code_line<'a>(line: &'a str, language: &str) -> Cow<'a, str> {
    // P2 (parse alloc reduction): the sanitizer rebuilds the line char-by-char
    // only to blank out string/comment spans. A line with no quote/comment
    // trigger sanitizes to itself, so borrow it instead of allocating a copy —
    // the common case in code (`def f(x):`, `import os`, `a = b + c`). This is
    // the #2 parse leaf (`sanitize_code_line`, called per line by type_facts &
    // the non-python ref-site path). Output is byte-identical to the owned path.
    let is_python = language == "python";
    // Triggers must be a SUPERSET of what the owned scan below acts on, or the
    // borrow path would diverge. The owned scan blanks quote spans (`"` `'` `` ` ``),
    // breaks on a python `#` comment, AND breaks on `//` for ANY language (the
    // `//` check is not language-gated). So `/` is a trigger for every language
    // — missing that made python `a // b` borrow the whole line while the owned
    // path truncated at `//` (caught by a 119KB index-size diff at equal counts).
    let needs_work = line.as_bytes().iter().any(|&b| {
        b == b'"' || b == b'\'' || b == b'`' || b == b'/' || (is_python && b == b'#')
    });
    if !needs_work {
        return Cow::Borrowed(line);
    }
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if let Some(active) = quote {
            if ch == '\\' {
                out.push(' ');
                if chars.next().is_some() {
                    out.push(' ');
                }
                continue;
            }
            if ch == active {
                quote = None;
            }
            out.push(' ');
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            quote = Some(ch);
            out.push(' ');
            continue;
        }
        if language == "python" && ch == '#' {
            break;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            break;
        }
        out.push(ch);
    }
    Cow::Owned(out)
}

fn sanitize_ref_site_code_line<'a>(
    line: &'a str,
    language: &str,
    python_multiline_string_quote: &mut Option<char>,
) -> Cow<'a, str> {
    if language == "python" {
        sanitize_python_ref_site_code_line(line, python_multiline_string_quote)
    } else {
        sanitize_code_line(line, language)
    }
}

fn sanitize_python_ref_site_code_line<'a>(
    line: &'a str,
    multiline_string_quote: &mut Option<char>,
) -> Cow<'a, str> {
    // P2: when not inside a triple-quoted string and the line has no quote or
    // `#`, no literal can start and no comment can begin → it sanitizes to
    // itself; borrow it (state stays None). Otherwise build the owned copy.
    if multiline_string_quote.is_none()
        && !line
            .as_bytes()
            .iter()
            .any(|&b| b == b'"' || b == b'\'' || b == b'#')
    {
        return Cow::Borrowed(line);
    }
    let mut out = String::with_capacity(line.len());
    let mut idx = 0usize;
    while idx < line.len() {
        if let Some(quote) = *multiline_string_quote {
            let delimiter = python_triple_quote_delimiter(quote);
            if line[idx..].starts_with(delimiter) {
                push_ascii_spaces(&mut out, delimiter.len());
                idx += delimiter.len();
                *multiline_string_quote = None;
            } else {
                let ch = line[idx..].chars().next().unwrap_or(' ');
                out.push(' ');
                idx += ch.len_utf8();
            }
            continue;
        }

        let rest = &line[idx..];
        if rest.starts_with('#') {
            break;
        }
        if let Some(start) = python_string_literal_start(rest) {
            push_ascii_spaces(&mut out, start.prefix_len + start.quote_len);
            idx += start.prefix_len + start.quote_len;
            if start.quote_len == 3 {
                let delimiter = python_triple_quote_delimiter(start.quote);
                if let Some(end) = line[idx..].find(delimiter) {
                    push_spaces_for_slice(&mut out, &line[idx..idx + end + delimiter.len()]);
                    idx += end + delimiter.len();
                } else {
                    push_spaces_for_slice(&mut out, &line[idx..]);
                    *multiline_string_quote = Some(start.quote);
                    break;
                }
            } else {
                idx = sanitize_python_single_line_string_tail(line, idx, start.quote, &mut out);
            }
            continue;
        }

        let ch = rest.chars().next().unwrap_or(' ');
        out.push(ch);
        idx += ch.len_utf8();
    }
    Cow::Owned(out)
}

#[derive(Clone, Copy, Debug)]
struct PythonStringLiteralStart {
    prefix_len: usize,
    quote: char,
    quote_len: usize,
}

fn python_string_literal_start(rest: &str) -> Option<PythonStringLiteralStart> {
    for prefix in ["fr", "rf", "br", "rb", "ur", "ru", "f", "r", "b", "u", ""] {
        if !rest
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
        {
            continue;
        }
        let tail = &rest[prefix.len()..];
        let quote = if tail.starts_with("'''") {
            Some('\'')
        } else if tail.starts_with("\"\"\"") {
            Some('"')
        } else if tail.starts_with('\'') {
            Some('\'')
        } else if tail.starts_with('"') {
            Some('"')
        } else {
            None
        }?;
        let quote_len = if tail.starts_with(python_triple_quote_delimiter(quote)) {
            3
        } else {
            1
        };
        return Some(PythonStringLiteralStart {
            prefix_len: prefix.len(),
            quote,
            quote_len,
        });
    }
    None
}

fn python_triple_quote_delimiter(quote: char) -> &'static str {
    if quote == '\'' {
        "'''"
    } else {
        "\"\"\""
    }
}

fn sanitize_python_single_line_string_tail(
    line: &str,
    mut idx: usize,
    quote: char,
    out: &mut String,
) -> usize {
    while idx < line.len() {
        let ch = line[idx..].chars().next().unwrap_or(' ');
        out.push(' ');
        idx += ch.len_utf8();
        if ch == '\\' {
            if idx < line.len() {
                let escaped = line[idx..].chars().next().unwrap_or(' ');
                out.push(' ');
                idx += escaped.len_utf8();
            }
            continue;
        }
        if ch == quote {
            break;
        }
    }
    idx
}

fn push_ascii_spaces(out: &mut String, count: usize) {
    for _ in 0..count {
        out.push(' ');
    }
}

fn push_spaces_for_slice(out: &mut String, value: &str) {
    for _ in value.chars() {
        out.push(' ');
    }
}

fn sanitize_import_line(line: &str, language: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if let Some(active) = quote {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
                continue;
            }
            if ch == active {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' || ch == '`' {
            quote = Some(ch);
            out.push(ch);
            continue;
        }
        if language == "python" && ch == '#' {
            break;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            break;
        }
        out.push(ch);
    }
    out
}

fn is_import_context_line(trimmed: &str, language: &str) -> bool {
    match language {
        "python" => trimmed.starts_with("import ") || trimmed.starts_with("from "),
        "javascript" | "typescript" => {
            trimmed.starts_with("import ")
                || trimmed.starts_with("export ")
                || trimmed.starts_with("const ")
                    && (trimmed.contains("require(") || trimmed.contains("require ("))
                || trimmed.starts_with("let ")
                    && (trimmed.contains("require(") || trimmed.contains("require ("))
                || trimmed.starts_with("var ")
                    && (trimmed.contains("require(") || trimmed.contains("require ("))
        }
        _ => false,
    }
}

fn identifier_tokens(line: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (idx, ch) in line.char_indices() {
        if start.is_none() && is_ident_start(ch) {
            start = Some(idx);
            continue;
        }
        if let Some(token_start) = start {
            if !is_ident_continue(ch) {
                out.push((line[token_start..idx].to_string(), token_start, idx));
                start = None;
            }
        }
    }
    if let Some(token_start) = start {
        out.push((line[token_start..].to_string(), token_start, line.len()));
    }
    out
}

fn is_keyword(name: &str, language: &str) -> bool {
    const COMMON: &[&str] = &[
        "abstract",
        "as",
        "async",
        "await",
        "break",
        "case",
        "catch",
        "class",
        "const",
        "continue",
        "def",
        "default",
        "delete",
        "do",
        "else",
        "enum",
        "export",
        "extends",
        "false",
        "finally",
        "for",
        "from",
        "function",
        "if",
        "implements",
        "import",
        "in",
        "interface",
        "let",
        "new",
        "null",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "self",
        "static",
        "struct",
        "super",
        "switch",
        "this",
        "throw",
        "true",
        "try",
        "type",
        "undefined",
        "var",
        "void",
        "while",
        "with",
        "yield",
    ];
    if COMMON.contains(&name) {
        return true;
    }
    language == "python"
        && matches!(
            name,
            "None" | "True" | "False" | "elif" | "except" | "lambda" | "pass"
        )
}

fn next_nonspace_char(line: &str, idx: usize) -> Option<char> {
    line[idx..].chars().find(|ch| !ch.is_whitespace())
}

fn member_receiver_name(line: &str, member_start: usize) -> Option<String> {
    let bytes = line.as_bytes();
    let mut dot = member_start;
    while dot > 0 && bytes[dot - 1].is_ascii_whitespace() {
        dot -= 1;
    }
    if dot == 0 || bytes[dot - 1] != b'.' {
        return None;
    }
    let mut end = dot - 1;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 {
        let ch = bytes[start - 1] as char;
        if !is_ident_continue(ch) {
            break;
        }
        start -= 1;
    }
    if start == end {
        return None;
    }
    let receiver = &line[start..end];
    is_identifier(receiver).then(|| receiver.to_string())
}

fn has_member_access_dot(line: &str, member_start: usize) -> bool {
    let bytes = line.as_bytes();
    let mut dot = member_start;
    while dot > 0 && bytes[dot - 1].is_ascii_whitespace() {
        dot -= 1;
    }
    if dot == 0 || bytes[dot - 1] != b'.' {
        return false;
    }
    dot < 3 || bytes[dot - 2] != b'.' || bytes[dot - 3] != b'.'
}

fn brace_delta(line: &str) -> i32 {
    line.chars().fold(0, |acc, ch| match ch {
        '{' => acc + 1,
        '}' => acc - 1,
        _ => acc,
    })
}

fn paren_delta(line: &str) -> i32 {
    line.chars().fold(0, |acc, ch| match ch {
        '(' => acc + 1,
        ')' => acc - 1,
        _ => acc,
    })
}

fn qualify_symbol_name(container_name: Option<&String>, name: &str) -> String {
    container_name
        .map(|container| format!("{container}.{name}"))
        .unwrap_or_else(|| name.to_string())
}

fn stable_symbol_id(
    language: &str,
    rel_path: &str,
    kind: &str,
    qualified_name: &str,
    line: u32,
    column: u32,
) -> String {
    let key = format!("{language}\0{rel_path}\0{kind}\0{qualified_name}\0{line}\0{column}");
    format!("sym:{:016x}", stable_hash(&key))
}

fn stable_ref_id(rel_path: &str, line: u32, column: u32, name: &str) -> String {
    let key = format!("{rel_path}\0{line}\0{column}\0{name}");
    format!("ref:{:016x}", stable_hash(&key))
}

/// Parse a "ref:HEX16" id back to its underlying u64 hash. Returns None for
/// any other string (legacy formats, externally-provided ids, etc.) so the
/// serializer can fall back to inline string encoding.
fn parse_stable_ref_id_to_u64(s: &str) -> Option<u64> {
    s.strip_prefix("ref:")
        .filter(|hex| hex.len() == 16)
        .and_then(|hex| u64::from_str_radix(hex, 16).ok())
}

/// Same encoding as `parse_stable_ref_id_to_u64` but for `sym:HEX16`.
fn parse_stable_symbol_id_to_u64(s: &str) -> Option<u64> {
    s.strip_prefix("sym:")
        .filter(|hex| hex.len() == 16)
        .and_then(|hex| u64::from_str_radix(hex, 16).ok())
}

/// B6 stage-3: reconstruct the `"sym:HEX16"` enclosing-scope id string from the
/// stored `u64` (0 = no enclosing scope). Byte-identical to the original
/// `GraphSymbol.id` because symbol ids are always `format!("sym:{:016x}", …)`
/// (see `stable_symbol_id`), so `parse_stable_symbol_id_to_u64` is its exact
/// inverse. Cold path only — the hot resolve loop keys on the `u64` directly;
/// this rebuilds the string for the few string-keyed lookups on a per-file
/// receiver-cache miss and for the materialize / shard-serialize cold paths.
fn enclosing_id_to_string(enclosing_id: u64) -> Option<String> {
    (enclosing_id != 0).then(|| format!("sym:{enclosing_id:016x}"))
}

// Phase 3 aggressive: encode common GraphSymbol.kind values as u8 ids.
// Mirrors kind_flags but provides reversible (string ↔ u8) mapping for the
// shard codec. 255 = inline string follows for unknown kinds.
const KIND_OTHER: u8 = 255;

#[inline]
fn compute_kind_id(s: &str) -> u8 {
    match s {
        "class" => 0,
        "interface" => 1,
        "enum" => 2,
        "type" => 3,
        "struct" => 4,
        "method" => 5,
        "function" => 6,
        "field" => 7,
        "property" => 8,
        "variable" => 9,
        "module" => 10,
        "constant" => 11,
        "trait" => 12,
        _ => KIND_OTHER,
    }
}

#[inline]
fn kind_str_from_id(id: u8) -> Option<&'static str> {
    Some(match id {
        0 => "class",
        1 => "interface",
        2 => "enum",
        3 => "type",
        4 => "struct",
        5 => "method",
        6 => "function",
        7 => "field",
        8 => "property",
        9 => "variable",
        10 => "module",
        11 => "constant",
        12 => "trait",
        _ => return None,
    })
}

fn stable_file_id(rel_path: &str) -> String {
    format!("file:{:016x}", stable_hash(rel_path))
}

fn stable_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn shard_index_for_key(value: &str) -> usize {
    (stable_hash(value) as usize) % GRAPH_SHARD_COUNT
}

fn normalize_graph_rel_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/")
}

fn is_graph_source_path(rel_path: &str) -> bool {
    matches!(
        Path::new(rel_path)
            .extension()
            .and_then(|value| value.to_str()),
        Some(
            "py" | "pyi"
                | "js"
                | "jsx"
                | "ts"
                | "tsx"
                | "mjs"
                | "cjs"
                | "java"
                | "kt"
                | "kts"
                | "go"
                | "rs"
                | "c"
                | "cc"
                | "cpp"
                | "cxx"
                | "h"
                | "hpp"
                | "cs"
                | "php"
                | "rb"
                | "scala"
                | "swift"
                | "graphql"
                | "gql"
        )
    )
}

fn language_for_path(rel_path: &str) -> String {
    match Path::new(rel_path)
        .extension()
        .and_then(|value| value.to_str())
    {
        Some("py" | "pyi") => "python",
        Some("js" | "jsx" | "mjs" | "cjs") => "javascript",
        Some("ts" | "tsx") => "typescript",
        Some("java") => "java",
        Some("kt" | "kts") => "kotlin",
        Some("graphql" | "gql") => "graphql",
        Some("rs") => "rust",
        Some("go") => "go",
        Some("cs") => "csharp",
        Some("rb") => "ruby",
        Some("php") => "php",
        Some("swift") => "swift",
        Some("scala") => "scala",
        Some("c" | "cc" | "cpp" | "cxx" | "h" | "hpp") => "cpp",
        _ => "text",
    }
    .to_string()
}

fn is_type_kind(kind: &str) -> bool {
    matches!(kind, "class" | "interface" | "enum" | "type" | "struct")
}

fn is_bare_identifier_fallback_symbol(kind: &str) -> bool {
    !matches!(kind, "method" | "field" | "property")
}

fn is_member_identifier_fallback_symbol(kind: &str) -> bool {
    matches!(kind, "method" | "field" | "property")
}

#[inline(always)]
pub(crate) fn is_type_kind_sym(s: &GraphSymbol) -> bool {
    s.kind_flags & KF_TYPE != 0
}

#[inline(always)]
pub(crate) fn is_bare_fallback_sym(s: &GraphSymbol) -> bool {
    s.kind_flags & KF_BARE_FB != 0
}

#[inline(always)]
pub(crate) fn is_member_fallback_sym(s: &GraphSymbol) -> bool {
    s.kind_flags & KF_MEMBER_FB != 0
}

fn unique_symbol_by_language_and_name<'a>(
    symbols_by_name: &HashMap<(u16, u64), Vec<&'a GraphSymbol>>,
    language_id: u16,
    name_hash: u64,
) -> Option<&'a GraphSymbol> {
    let symbols = symbols_by_name.get(&(language_id, name_hash))?;
    if symbols.len() == 1 {
        symbols.first().copied()
    } else {
        None
    }
}

fn type_tail(value: &str) -> &str {
    value.rsplit('.').next().unwrap_or(value)
}

fn line_indent(line: &str) -> usize {
    line.chars()
        .take_while(|ch| ch.is_whitespace())
        .map(|ch| if ch == '\t' { 4 } else { 1 })
        .sum()
}

fn find_column(line: &str, name: &str) -> u32 {
    line.find(name).unwrap_or(0) as u32
}

fn is_ident_start(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphabetic()
}

fn is_ident_continue(ch: char) -> bool {
    ch == '_' || ch.is_ascii_alphanumeric()
}

fn file_uri(path: &Path) -> String {
    format!("file://{}", percent_encode_path(&path.to_string_lossy()))
}

fn rebuild_reference_uris(workspace_root: &Path, references: &mut [GraphReference]) {
    for reference in references {
        if reference.uri.is_empty() && !reference.rel_path.is_empty() {
            let mut abs_path = workspace_root.to_path_buf();
            abs_path.push(&*reference.rel_path);
            reference.uri = file_uri(&abs_path).into();
        }
    }
}

fn percent_encode_path(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '/' | '-' | '_' | '.' | '~' | ':') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::TextEncoding;

    fn test_entry(rel_path: &str, text: &str) -> CorpusEntry {
        CorpusEntry {
            rel_path: rel_path.to_string(),
            abs_path: PathBuf::from(rel_path),
            text: text.to_string(),
            size_bytes: text.len() as u64,
            modified_unix_secs: 0,
            encoding: TextEncoding::Utf8,
        }
    }

    fn resolve_test_entries(entries: &[CorpusEntry]) -> (Vec<GraphSymbol>, ResolutionResult) {
        let mut symbols = Vec::new();
        let mut refs = Vec::new();
        let mut imports = Vec::new();
        let mut types = Vec::new();
        let mut returns = Vec::new();
        let mut hierarchy = Vec::new();
        for entry in entries {
            let graph = build_file_graph(entry);
            symbols.extend(graph.symbols);
            refs.extend(graph.ref_sites);
            imports.extend(graph.import_facts);
            types.extend(graph.type_facts);
            returns.extend(graph.function_return_facts);
            hierarchy.extend(graph.hierarchy_facts);
        }
        let result = resolve_ref_sites(&symbols, &refs, &imports, &types, &returns, &hierarchy);
        (symbols, result)
    }

    fn symbol_id<'a>(symbols: &'a [GraphSymbol], qualified_name: &str) -> &'a str {
        symbols
            .iter()
            .find(|symbol| symbol.qualified_name == qualified_name)
            .map(|symbol| symbol.id.as_str())
            .unwrap_or_else(|| panic!("missing symbol {qualified_name}"))
    }

    #[test]
    fn workspace_unique_names_are_likely_but_not_exact() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
def unique_helper():
    return 1

class Worker:
    def unique_run(self):
        return 2

class First:
    def shared(self):
        return 3

class Second:
    def shared(self):
        return 4
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
from pkg.unique_run import sentinel

def use(client):
    unique_helper()
    client.unique_run()
    client.shared()
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let helper_id = symbol_id(&symbols, "unique_helper");
        let unique_run_id = symbol_id(&symbols, "Worker.unique_run");
        let first_shared_id = symbol_id(&symbols, "First.shared");
        let second_shared_id = symbol_id(&symbols, "Second.shared");

        assert_eq!(
            result
                .counts
                .get(helper_id)
                .map(|count| (count.usage_likely, count.usage_must))
                .unwrap_or((0, 0)),
            (1, 0),
            "workspace-unique bare names should be likely without becoming MUST"
        );
        assert_eq!(
            result
                .counts
                .get(unique_run_id)
                .map(|count| (count.usage_likely, count.usage_must))
                .unwrap_or((0, 0)),
            (2, 0),
            "workspace-unique member names should count same-scope import tokens without becoming MUST"
        );
        assert_eq!(
            result
                .counts
                .get(first_shared_id)
                .map(|count| count.usage_likely)
                .unwrap_or(0),
            1,
            "ambiguous member names still receive the token-shape likely baseline"
        );
        assert_eq!(
            result
                .counts
                .get(second_shared_id)
                .map(|count| count.usage_likely)
                .unwrap_or(0),
            1,
            "ambiguous member names still receive the token-shape likely baseline"
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && &*reference.confidence == "possible"
                    && &*reference.provenance == "unique-name"
            }),
            "workspace-unique bare fallback should keep a queryable possible reference"
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(unique_run_id)
                    && &*reference.confidence == "possible"
                    && &*reference.provenance == "unique-name"
            }),
            "workspace-unique member fallback should keep a queryable possible reference"
        );
        assert!(
            !result.references.iter().any(|reference| {
                (reference.target_symbol_id.as_deref() == Some(first_shared_id)
                    || reference.target_symbol_id.as_deref() == Some(second_shared_id))
                    && &*reference.provenance == "unique-name"
            }),
            "ambiguous member names should not be promoted to queryable unique-name references"
        );
    }

    #[test]
    fn token_shape_likely_baseline_is_scoped_to_source_root() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class Worker:
    def run(self):
        return 1
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
def use(client):
    client.run()
"#,
        );
        let unrelated = test_entry(
            "tools/script.py",
            r#"
def use(client):
    client.run()
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer, unrelated]);
        let run_id = symbol_id(&symbols, "Worker.run");
        let count = result.counts.get(run_id).copied().unwrap_or_default();

        assert_eq!(
            count.usage_likely, 1,
            "same-named tokens in another top-level source root should not inflate likely counts"
        );
        assert!(
            count.usage_may >= 2,
            "cross-root tokens stay in the conservative MAY envelope"
        );
    }

    #[test]
    fn token_shape_likely_baseline_materializes_bounded_possible_references() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class FirstProvider:
    def collect_items(self):
        return []

class SecondProvider:
    def collect_items(self):
        return []
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
def use_collection(first, second):
    first.collect_items()
    second.collect_items()
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let first_id = symbol_id(&symbols, "FirstProvider.collect_items");
        let count = result.counts.get(first_id).copied().unwrap_or_default();
        assert_eq!(count.usage_likely, 2);
        assert_eq!(count.usage_must, 0);
        let refs: Vec<_> = result
            .references
            .iter()
            .filter(|reference| reference.target_symbol_id.as_deref() == Some(first_id))
            .collect();
        assert_eq!(
            refs.len(),
            2,
            "bounded token-shape fallback counts should have detail references for UI panels"
        );
        assert!(refs
            .iter()
            .all(|reference| &*reference.confidence == "possible"));
        assert!(refs
            .iter()
            .all(|reference| &*reference.provenance == "token-shape"));
    }

    #[test]
    fn ref_sites_ignore_python_multiline_string_tokens() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class Worker:
    def run(self):
        return 1
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
TEXT = """
client.run()
"""

def use(client):
    client.run()
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let run_id = symbol_id(&symbols, "Worker.run");
        let count = result.counts.get(run_id).copied().unwrap_or_default();

        assert_eq!(
            count.usage_likely, 1,
            "tokens inside Python multiline strings should not inflate likely counts"
        );
    }

    #[test]
    fn python_relative_import_ellipsis_is_not_member_access() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class Record:
    company = None
"#,
        );
        let consumer = test_entry(
            "pkg/sub/consumer.py",
            r#"
from ...company.model import Company

def use(client):
    return client.company
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let company_id = symbol_id(&symbols, "Record.company");
        let count = result.counts.get(company_id).copied().unwrap_or_default();

        assert_eq!(
            count.usage_likely, 1,
            "leading ellipsis in Python relative imports is not member access"
        );
    }

    #[test]
    fn ts_js_import_namespace_destructuring_and_typed_receivers_are_exact() {
        let provider = test_entry(
            "pkg/provider.ts",
            r#"
export class Service {
  run() {
    return 1;
  }
}

export function helper() {
  return 2;
}
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.ts",
            r#"
import * as api from "./provider";
import { Service } from "./provider";
const { helper: localHelper } = require("./provider");

function typed(worker: Service) {
  return worker.run();
}

function namespaceCall() {
  return api.helper();
}

function destructuredCall() {
  return localHelper();
}

function dynamicCall(client: unknown) {
  return client.run();
}
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let run_id = symbol_id(&symbols, "Service.run");
        let helper_id = symbol_id(&symbols, "helper");

        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.ts"
                    && &*reference.raw_text == "run"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "typed receiver member calls should be exact: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && &*reference.rel_path == "pkg/consumer.ts"
                    && &*reference.raw_text == "helper"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "import-namespace"
            }),
            "namespace imports should resolve member usage exactly: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && &*reference.rel_path == "pkg/consumer.ts"
                    && &*reference.raw_text == "localHelper"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "import"
            }),
            "CommonJS destructuring should resolve through import facts: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.ts"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamicCall")
                    })
                    && &*reference.confidence == "exact"
            }),
            "unknown/dynamic receivers must not be promoted to exact"
        );

        let js_provider = test_entry(
            "pkg/provider.js",
            r#"
class Widget {
  run() {
    return 1;
  }
}

function helper() {
  return 2;
}

exports.Widget = Widget;
exports.helper = helper;
"#,
        );
        let js_consumer = test_entry(
            "pkg/consumer.js",
            r#"
const api = require("./provider");
const { helper: localHelper } = require("./provider");

function constructed() {
  const widget = new api.Widget();
  return widget.run();
}

function namespaceCall() {
  return api.helper();
}

function destructuredCall() {
  return localHelper();
}

function dynamicCall(client) {
  return client.run();
}
"#,
        );
        let (js_symbols, js_result) = resolve_test_entries(&[js_provider, js_consumer]);
        let widget_run_id = symbol_id(&js_symbols, "Widget.run");
        let js_helper_id = symbol_id(&js_symbols, "helper");

        assert!(
            js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(widget_run_id)
                    && &*reference.rel_path == "pkg/consumer.js"
                    && &*reference.raw_text == "run"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "JavaScript constructor receiver member calls should be exact: {:?}",
            js_result.references
        );
        assert!(
            js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(js_helper_id)
                    && &*reference.rel_path == "pkg/consumer.js"
                    && &*reference.raw_text == "helper"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "import-namespace"
            }),
            "CommonJS namespace requires should resolve member usage exactly: {:?}",
            js_result.references
        );
        assert!(
            js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(js_helper_id)
                    && &*reference.rel_path == "pkg/consumer.js"
                    && &*reference.raw_text == "localHelper"
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "import"
            }),
            "CommonJS destructuring in JavaScript should resolve through import facts: {:?}",
            js_result.references
        );
        assert!(
            !js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(widget_run_id)
                    && &*reference.rel_path == "pkg/consumer.js"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        js_symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamicCall")
                    })
                    && &*reference.confidence == "exact"
            }),
            "JavaScript dynamic receivers must not be promoted to exact"
        );
    }

    #[test]
    fn python_star_import_and_typed_receivers_are_exact_without_dynamic_promotion() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class Model:
    pass

class Service(Model):
    def run(self):
        return 1

class RemoteService(Model):
    def ping(self):
        return 3

class PlainService:
    def run(self):
        return 4

def helper():
    return 2

def make_remote() -> RemoteService:
    return RemoteService()
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
from .provider import *
from .provider import Service
from .provider import make_remote as build_remote
from typing import cast

def build_service() -> Service:
    return Service()

def typed(worker: Service):
    return worker.run()

def typed_alias(worker: Service):
    alias = worker
    return alias.run()

def typed_return_factory():
    worker = build_service()
    return worker.run()

def typed_imported_return_factory():
    remote = build_remote()
    return remote.ping()

def typed_collection_loop(workers: list[Service]):
    for worker in workers:
        return worker.run()

def typed_collection_index(workers: Sequence[Service]):
    worker = workers[0]
    return worker.run()

def typed_cast(client):
    worker = cast(Service, client)
    return worker.run()

def typed_cast_collection(clients):
    workers = cast(list[Service], clients)
    worker = workers[0]
    return worker.run()

def typed_queryset_chain(workers: QuerySet[Service]):
    filtered = workers.filter(active=True)
    worker = filtered.first()
    return worker.run()

def typed_model_manager_get():
    worker = Service.objects.get(active=True)
    return worker.run()

def typed_model_manager_filter():
    workers = Service.objects.filter(active=True)
    worker = workers.first()
    return worker.run()

def plain_manager_shape_is_not_django_model():
    worker = PlainService.objects.get(active=True)
    return worker.run()

def starred():
    return helper()

def dynamic(client):
    return client.run()
"#,
        );
        let (symbols, result) = resolve_test_entries(&[provider, consumer]);
        let run_id = symbol_id(&symbols, "Service.run");
        let ping_id = symbol_id(&symbols, "RemoteService.ping");
        let plain_run_id = symbol_id(&symbols, "PlainService.run");
        let helper_id = symbol_id(&symbols, "helper");

        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python annotation receiver member calls should be exact: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_alias")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python alias assignments from typed locals should preserve receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_return_factory")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python annotated callable returns should provide receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(ping_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "ping"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_imported_return_factory"
                        })
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python imported annotated callable returns should provide receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_collection_loop")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python iterable annotations should type for-loop elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_collection_index"
                        })
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python iterable annotations should type indexed elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_cast")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python typing.cast assignments should type local receivers: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_cast_collection")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Python typing.cast collection assignments should type indexed elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_queryset_chain")
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Django QuerySet-preserving calls should retain element receiver types: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_model_manager_get"
                        })
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Django Model.objects.get should type the returned model receiver: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_model_manager_filter"
                        })
                    })
                    && &*reference.confidence == "exact"
                    && &*reference.provenance == "type-fact"
            }),
            "Django Model.objects.filter should retain model element types: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(plain_run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id
                                && symbol.name == "plain_manager_shape_is_not_django_model"
                        })
                    })
                    && &*reference.confidence == "exact"
            }),
            "Django manager-shaped calls must not type arbitrary non-model classes: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "helper"
                    && &*reference.confidence == "possible"
                    && &*reference.provenance == "import-star"
            }),
            "Python star imports should preserve import candidates: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && &*reference.rel_path == "pkg/consumer.py"
                    && &*reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamic")
                    })
                    && &*reference.confidence == "exact"
            }),
            "Python dynamic receivers must remain MAY-only"
        );
    }
}

fn encode_field(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'%' => out.push_str("%25"),
            b'\t' => out.push_str("%09"),
            b'\n' => out.push_str("%0A"),
            b'\r' => out.push_str("%0D"),
            byte => out.push(byte as char),
        }
    }
    out
}

fn decode_field(value: &str) -> io::Result<String> {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            let hi = bytes
                .get(idx + 1)
                .copied()
                .ok_or_else(|| invalid_data("truncated percent escape"))?;
            let lo = bytes
                .get(idx + 2)
                .copied()
                .ok_or_else(|| invalid_data("truncated percent escape"))?;
            out.push((hex_value(hi)? << 4) | hex_value(lo)?);
            idx += 3;
        } else {
            out.push(bytes[idx]);
            idx += 1;
        }
    }
    String::from_utf8(out).map_err(|err| invalid_data(format!("invalid utf-8 field: {err}")))
}

fn encode_list(values: &[String]) -> String {
    encode_field(&values.join("\u{1f}"))
}

fn decode_list(value: &str) -> io::Result<Vec<String>> {
    let decoded = decode_field(value)?;
    if decoded.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(decoded.split('\u{1f}').map(ToString::to_string).collect())
    }
}

fn hex_value(value: u8) -> io::Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(invalid_data("invalid percent escape")),
    }
}

fn parse_u32(value: &str, label: &str) -> io::Result<u32> {
    value
        .parse::<u32>()
        .map_err(|_| invalid_data(format!("invalid {label}: {value}")))
}

fn parse_usize(value: &str, label: &str) -> io::Result<usize> {
    value
        .parse::<usize>()
        .map_err(|_| invalid_data(format!("invalid {label}: {value}")))
}

fn optional_decoded_field(value: &str) -> io::Result<Option<String>> {
    decode_field(value).map(empty_string_to_none)
}

fn empty_string_to_none(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn read_built_at_unix_ms(path: &Path) -> io::Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let text = fs::read_to_string(path)?;
    Ok(json_u64_field(&text, "builtAtUnixMs").unwrap_or(0))
}

fn json_u64_field(text: &str, field: &str) -> Option<u64> {
    let pattern = format!("\"{field}\":");
    let start = text.find(&pattern)? + pattern.len();
    let rest = &text[start..];
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn file_len(path: &Path) -> io::Result<u64> {
    Ok(fs::metadata(path)?.len())
}

fn unix_secs_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
// trigger 1779725020
