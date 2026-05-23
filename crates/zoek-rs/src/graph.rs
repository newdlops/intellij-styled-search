use crate::config::EngineConfig;
use crate::corpus::{
    decode_bytes, read_file_bytes_with_limit_if_not_binary, CorpusEntry, ReadTextBytesOutcome,
};
use crate::mmap_store::write_atomically;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const GRAPH_VERSION: u32 = 4;
const GRAPH_FILE_NAME: &str = "callgraph-relations.tsv";
const GRAPH_SYMBOL_FILE_NAME: &str = "callgraph-symbols.tsv";
const GRAPH_COUNT_FILE_NAME: &str = "callgraph-counts.tsv";
const GRAPH_MANIFEST_NAME: &str = "callgraph-manifest.json";

const BOUND_MAY: u8 = 0b0001;
const BOUND_MUST: u8 = 0b0010;
const _BOUND_OBSERVED: u8 = 0b0100;
const MAX_EAGER_IMPLEMENTATION_SYMBOLS: usize = 50_000;
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

#[derive(Clone, Debug)]
pub struct GraphReference {
    pub source_ref_id: String,
    pub target_symbol_id: Option<String>,
    pub edge_kind: String,
    pub name: String,
    pub raw_text: String,
    pub uri: String,
    pub rel_path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub enclosing_symbol_id: Option<String>,
    pub bound_mask: u8,
    pub confidence: String,
    pub provenance: String,
}

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug)]
struct HierarchyFact {
    child_qualified_name: String,
    parent_name: String,
    relation: String,
}

#[derive(Clone, Debug)]
struct ImportFact {
    file_id: String,
    rel_path: String,
    local_name: String,
    imported_name: String,
    module_candidates: Vec<String>,
}

#[derive(Clone, Debug)]
struct TypeFact {
    rel_path: String,
    local_name: String,
    type_name: String,
    enclosing_symbol_id: Option<String>,
}

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug)]
struct RefSite {
    source_ref_id: String,
    name: String,
    raw_text: String,
    uri: String,
    rel_path: String,
    language: String,
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
    edge_kind: String,
    access_kind: String,
    is_definition: bool,
    is_import_context: bool,
    receiver_name: Option<String>,
    enclosing_symbol_id: Option<String>,
}

#[derive(Clone, Debug)]
struct GraphStore {
    workspace_root: String,
    built_at_unix_ms: u64,
    symbols: Vec<GraphSymbol>,
    references: Vec<GraphReference>,
    hierarchy_facts: Vec<HierarchyFact>,
    counts: HashMap<String, GraphCount>,
}

#[derive(Clone, Copy, Debug, Default)]
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
    counts: HashMap<String, GraphCount>,
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

fn graph_manifest_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_MANIFEST_NAME)
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
            source_ref_id: stable_ref_id(&rel_path, start_line, start_column, &name),
            target_symbol_id: Some(symbol_id),
            edge_kind: fields
                .get(11)
                .map(|value| decode_field(value))
                .transpose()?
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "usage".to_string()),
            name,
            raw_text: decode_field(fields[3])?,
            uri: decode_field(fields[4])?,
            rel_path,
            start_line,
            start_column,
            end_line: parse_u32(fields[8], "endLine")?,
            end_column: parse_u32(fields[9], "endColumn")?,
            enclosing_symbol_id: optional_decoded_field(fields[10])?,
            bound_mask: BOUND_MAY,
            confidence: "possible".to_string(),
            provenance: "external-tsv".to_string(),
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
        &counts,
    )
}

fn discover_graph_source_files_with_progress<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    progress: &mut F,
) -> io::Result<Vec<CorpusEntry>>
where
    F: FnMut(GraphRebuildProgress),
{
    let total = count_graph_source_candidates(workspace_root, workspace_root, config).unwrap_or(0);
    let mut entries = Vec::new();
    let mut visited = 0usize;
    walk_graph_source_dir(
        workspace_root,
        workspace_root,
        config,
        total,
        &mut visited,
        &mut entries,
        progress,
    )?;
    entries.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(entries)
}

fn walk_graph_source_dir<F>(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
    total: usize,
    visited: &mut usize,
    entries: &mut Vec<CorpusEntry>,
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
                || config.is_internal_index_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || is_graph_dependency_or_artifact_dir(&name)
            {
                continue;
            }
            walk_graph_source_dir(
                &path,
                workspace_root,
                config,
                total,
                visited,
                entries,
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
                stage: "discover",
                current: *visited,
                total,
                message: "discovering graph source files".to_string(),
            });
        }

        if metadata.len() > config.max_file_size_bytes || config.is_binary_extension(&path) {
            continue;
        }

        let bytes = match read_file_bytes_with_limit_if_not_binary(
            &path,
            config.max_file_size_bytes,
            Some(metadata.len()),
        )? {
            ReadTextBytesOutcome::Text(bytes) => bytes,
            ReadTextBytesOutcome::Binary | ReadTextBytesOutcome::TooLarge => continue,
        };
        let (text, encoding) = decode_bytes(&bytes);
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        entries.push(CorpusEntry {
            rel_path,
            abs_path: path,
            text,
            size_bytes: metadata.len(),
            modified_unix_secs,
            encoding,
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
                || config.is_internal_index_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || is_graph_dependency_or_artifact_dir(&name)
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
    progress(GraphRebuildProgress {
        stage: "discover",
        current: 0,
        total: 0,
        message: "discovering source files".to_string(),
    });
    let source_entries =
        discover_graph_source_files_with_progress(workspace_root, config, progress)?;

    progress(GraphRebuildProgress {
        stage: "file-graph",
        current: 0,
        total: source_entries.len(),
        message: "extracting file graphs".to_string(),
    });
    let mut file_graphs = Vec::with_capacity(source_entries.len());
    for (idx, entry) in source_entries.iter().enumerate() {
        if idx == 0 || idx + 1 == source_entries.len() || (idx + 1) % 1024 == 0 {
            progress(GraphRebuildProgress {
                stage: "file-graph",
                current: idx + 1,
                total: source_entries.len(),
                message: entry.rel_path.clone(),
            });
        }
        file_graphs.push(build_file_graph(entry));
    }

    progress(GraphRebuildProgress {
        stage: "resolve",
        current: 0,
        total: source_entries.len(),
        message: "materializing serving graph".to_string(),
    });
    let mut symbols = Vec::new();
    let mut ref_sites = Vec::new();
    let mut import_facts = Vec::new();
    let mut type_facts = Vec::new();
    let mut function_return_facts = Vec::new();
    let mut hierarchy_facts = Vec::new();
    let mut fact_generation_hash = 0u64;
    let mut symbol_def_count = 0usize;
    for graph in file_graphs {
        fact_generation_hash ^= graph.content_hash;
        fact_generation_hash ^= stable_hash(&graph.file_id);
        fact_generation_hash ^= stable_hash(&graph.language);
        symbol_def_count += graph.symbol_defs.len();
        symbols.extend(graph.symbols);
        ref_sites.extend(graph.ref_sites);
        import_facts.extend(graph.import_facts);
        type_facts.extend(graph.type_facts);
        function_return_facts.extend(graph.function_return_facts);
        hierarchy_facts.extend(graph.hierarchy_facts);
    }
    let resolution = resolve_ref_sites(
        &symbols,
        &ref_sites,
        &import_facts,
        &type_facts,
        &function_return_facts,
        &hierarchy_facts,
    );

    progress(GraphRebuildProgress {
        stage: "aggregate",
        current: resolution.references.len(),
        total: resolution.references.len(),
        message: format!(
            "building count sidecar symbol_defs={symbol_def_count} fact_generation={fact_generation_hash:016x}"
        ),
    });
    let counts = compute_native_counts(&symbols, &resolution.counts, &hierarchy_facts);
    write_store(
        workspace_root,
        built_at_unix_ms,
        config,
        source_entries.len(),
        &symbols,
        &resolution.references,
        &counts,
    )
}

pub fn update_graph_native(
    workspace_root: &Path,
    _changed_paths: &[PathBuf],
    _deleted_paths: &[PathBuf],
    built_at_unix_ms: u64,
    config: &EngineConfig,
    worker_count: usize,
) -> io::Result<GraphIndexSummary> {
    let built_at = if built_at_unix_ms == 0 {
        unix_millis_now()
    } else {
        built_at_unix_ms
    };
    let mut noop = |_progress: GraphRebuildProgress| {};
    rebuild_graph_native(workspace_root, built_at, config, worker_count, &mut noop)
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
    let Some(store) = read_store(workspace_root, config)? else {
        return Ok(None);
    };
    let query_lower = query.to_ascii_lowercase();
    let mut symbols: Vec<GraphSymbol> = store
        .symbols
        .iter()
        .filter(|symbol| {
            query.is_empty()
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
    let Some(store) = read_store(workspace_root, config)? else {
        return Ok(None);
    };
    let start = start_line.unwrap_or(0);
    let end = end_line.unwrap_or(u32::MAX);
    let mut symbols: Vec<GraphSymbol> = store
        .symbols
        .iter()
        .filter(|symbol| symbol.uri == uri && symbol.start_line <= end && symbol.end_line >= start)
        .cloned()
        .collect();
    for symbol in &mut symbols {
        apply_count_options(symbol, &store.counts, options);
    }
    symbols.sort_by(|left, right| {
        left.start_line
            .cmp(&right.start_line)
            .then_with(|| left.start_column.cmp(&right.start_column))
            .then_with(|| left.qualified_name.cmp(&right.qualified_name))
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

pub fn query_graph_implementations(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    let Some(store) = read_store(workspace_root, config)? else {
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
    if is_type_kind(&target.kind) {
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
    let Some(store) = read_store(workspace_root, config)? else {
        return Ok(None);
    };
    let mut references: Vec<GraphReference> = store
        .references
        .iter()
        .filter(|reference| reference.target_symbol_id.as_deref() == Some(symbol_id))
        .cloned()
        .collect();
    references.sort_by(|left, right| {
        left.rel_path
            .cmp(&right.rel_path)
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.start_column.cmp(&right.start_column))
            .then_with(|| left.target_symbol_id.cmp(&right.target_symbol_id))
    });
    let total_references = references.len();
    references.truncate(limit);
    Ok(Some(GraphQueryResult {
        workspace_root: store.workspace_root,
        symbol_id: symbol_id.to_string(),
        built_at_unix_ms: store.built_at_unix_ms,
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
    let Some(store) = read_store(workspace_root, config)? else {
        return Ok(None);
    };
    let mut references: Vec<GraphReference> = store
        .references
        .iter()
        .filter(|reference| {
            reference.enclosing_symbol_id.as_deref() == Some(symbol_id)
                && matches!(reference.edge_kind.as_str(), "call" | "construct")
        })
        .cloned()
        .collect();
    references.sort_by(|left, right| {
        left.rel_path
            .cmp(&right.rel_path)
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| left.start_column.cmp(&right.start_column))
    });
    let total_references = references.len();
    references.truncate(limit);
    Ok(Some(GraphQueryResult {
        workspace_root: store.workspace_root,
        symbol_id: symbol_id.to_string(),
        built_at_unix_ms: store.built_at_unix_ms,
        total_references,
        references,
    }))
}

fn build_file_graph(entry: &CorpusEntry) -> FileGraph {
    let language = language_for_path(&entry.rel_path);
    let uri = file_uri(&entry.abs_path);
    let line_count = entry.text.lines().count().max(1) as u32;
    let file_id = stable_file_id(&entry.rel_path);
    let symbol_defs = extract_symbol_defs(entry, &language, &uri, line_count);
    let import_facts = extract_import_facts(entry, &language, &file_id);
    let hierarchy_facts = hierarchy_facts_from_symbol_defs(&symbol_defs);
    let mut symbols = materialize_symbols(symbol_defs.clone(), line_count);
    assign_symbol_bodies(&mut symbols, line_count);
    let type_facts = extract_type_facts(entry, &language, &symbols);
    let function_return_facts = extract_function_return_facts(entry, &language);
    let ref_sites = extract_ref_sites(entry, &symbols, &language, &uri);
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
    uri: &str,
) -> Vec<RefSite> {
    let definition_positions: HashSet<(u32, u32, String)> = symbols
        .iter()
        .map(|symbol| (symbol.start_line, symbol.start_column, symbol.name.clone()))
        .collect();
    let mut ref_sites = Vec::new();
    let mut python_multiline_string_quote = None;
    for (line_idx, line) in entry.text.lines().enumerate() {
        let sanitized =
            sanitize_ref_site_code_line(line, language, &mut python_multiline_string_quote);
        let is_import_context = is_import_context_line(sanitized.trim_start(), language);
        for (name, start, end) in identifier_tokens(&sanitized) {
            if is_keyword(&name, language) {
                continue;
            }
            let is_definition =
                definition_positions.contains(&(line_idx as u32, start as u32, name.clone()));
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
            let source_ref_id =
                stable_ref_id(&entry.rel_path, line_idx as u32, start as u32, &name);
            ref_sites.push(RefSite {
                source_ref_id,
                name: name.clone(),
                raw_text: name,
                uri: uri.to_string(),
                rel_path: entry.rel_path.clone(),
                language: language.to_string(),
                start_line: line_idx as u32,
                start_column: start as u32,
                end_line: line_idx as u32,
                end_column: end as u32,
                edge_kind: edge_kind.to_string(),
                access_kind: access_kind.to_string(),
                is_definition,
                is_import_context,
                receiver_name,
                enclosing_symbol_id: enclosing_type_fact_scope_for_line(symbols, line_idx as u32),
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
    let mut symbols_by_name: HashMap<&str, Vec<&GraphSymbol>> = HashMap::new();
    let mut bare_symbols_by_name: HashMap<&str, Vec<&GraphSymbol>> = HashMap::new();
    let mut bare_symbols_by_language_and_name: HashMap<(&str, &str), Vec<&GraphSymbol>> =
        HashMap::new();
    let mut member_symbols_by_language_and_name: HashMap<(&str, &str), Vec<&GraphSymbol>> =
        HashMap::new();
    let mut symbols_by_id: HashMap<&str, &GraphSymbol> = HashMap::new();
    let mut types_by_name: HashMap<&str, Vec<&GraphSymbol>> = HashMap::new();
    let mut members_by_container_and_name: HashMap<(&str, &str), Vec<&GraphSymbol>> =
        HashMap::new();
    let mut symbols_by_file_and_name: HashMap<(&str, &str), Vec<&GraphSymbol>> = HashMap::new();
    for symbol in symbols {
        symbols_by_id.insert(&symbol.id, symbol);
        symbols_by_name
            .entry(&symbol.name)
            .or_default()
            .push(symbol);
        if is_type_kind(&symbol.kind) {
            types_by_name.entry(&symbol.name).or_default().push(symbol);
        }
        if let Some(container_name) = symbol.container_name.as_deref() {
            members_by_container_and_name
                .entry((container_name, symbol.name.as_str()))
                .or_default()
                .push(symbol);
        }
        if is_bare_identifier_fallback_symbol(&symbol.kind) {
            bare_symbols_by_name
                .entry(&symbol.name)
                .or_default()
                .push(symbol);
            bare_symbols_by_language_and_name
                .entry((symbol.language.as_str(), symbol.name.as_str()))
                .or_default()
                .push(symbol);
        }
        if is_member_identifier_fallback_symbol(&symbol.kind) {
            member_symbols_by_language_and_name
                .entry((symbol.language.as_str(), symbol.name.as_str()))
                .or_default()
                .push(symbol);
        }
        symbols_by_file_and_name
            .entry((&symbol.rel_path, &symbol.name))
            .or_default()
            .push(symbol);
    }
    let import_targets = resolve_import_targets(import_facts, &symbols_by_file_and_name);
    let import_facts_by_file_local = import_facts_by_file_local(import_facts);
    let star_import_facts_by_file = star_import_facts_by_file(import_facts);
    let type_facts_by_file_local = type_facts_by_file_local(type_facts);
    let function_return_facts_by_file_name =
        function_return_facts_by_file_name(function_return_facts);
    let mut bare_usage_may_by_name: HashMap<&str, usize> = HashMap::new();
    let mut bare_call_may_by_name: HashMap<&str, usize> = HashMap::new();
    let mut member_usage_may_by_name: HashMap<&str, usize> = HashMap::new();
    let mut member_call_may_by_name: HashMap<&str, usize> = HashMap::new();
    let mut bare_usage_likely_by_scope_and_name: HashMap<(&str, &str, &str), usize> =
        HashMap::new();
    let mut bare_call_likely_by_scope_and_name: HashMap<(&str, &str, &str), usize> = HashMap::new();
    let mut member_usage_likely_by_scope_and_name: HashMap<(&str, &str, &str), usize> =
        HashMap::new();
    let mut member_call_likely_by_scope_and_name: HashMap<(&str, &str, &str), usize> =
        HashMap::new();
    for site in ref_sites {
        if site.access_kind == "bare" && symbols_by_name.contains_key(site.name.as_str()) {
            *bare_usage_may_by_name
                .entry(site.name.as_str())
                .or_default() += 1;
            if matches!(site.edge_kind.as_str(), "call" | "construct") {
                *bare_call_may_by_name.entry(site.name.as_str()).or_default() += 1;
            }
        } else if site.access_kind == "member" && symbols_by_name.contains_key(site.name.as_str()) {
            *member_usage_may_by_name
                .entry(site.name.as_str())
                .or_default() += 1;
            if matches!(site.edge_kind.as_str(), "call" | "construct") {
                *member_call_may_by_name
                    .entry(site.name.as_str())
                    .or_default() += 1;
            }
        }
        if site.is_definition || is_likely_count_derived_context(&site.rel_path) {
            continue;
        }
        let scope_name = (
            site.language.as_str(),
            source_scope_key(&site.rel_path),
            site.name.as_str(),
        );
        if site.access_kind == "bare" {
            *bare_usage_likely_by_scope_and_name
                .entry(scope_name)
                .or_default() += 1;
            if matches!(site.edge_kind.as_str(), "call" | "construct") {
                *bare_call_likely_by_scope_and_name
                    .entry(scope_name)
                    .or_default() += 1;
            }
        } else if site.access_kind == "member" {
            *member_usage_likely_by_scope_and_name
                .entry(scope_name)
                .or_default() += 1;
            if matches!(site.edge_kind.as_str(), "call" | "construct") {
                *member_call_likely_by_scope_and_name
                    .entry(scope_name)
                    .or_default() += 1;
            }
        }
    }

    let mut counts: HashMap<String, GraphCount> = HashMap::new();
    for symbol in symbols {
        let count = counts.entry(symbol.id.clone()).or_default();
        count.usage_may += bare_usage_may_by_name
            .get(symbol.name.as_str())
            .copied()
            .unwrap_or(0);
        count.calls_in_may += bare_call_may_by_name
            .get(symbol.name.as_str())
            .copied()
            .unwrap_or(0);
        count.usage_may += member_usage_may_by_name
            .get(symbol.name.as_str())
            .copied()
            .unwrap_or(0);
        count.calls_in_may += member_call_may_by_name
            .get(symbol.name.as_str())
            .copied()
            .unwrap_or(0);
    }

    let mut dedup = BTreeSet::new();
    let mut references = Vec::new();
    let mut counted_likely = BTreeSet::new();
    let mut counted_exact = BTreeSet::new();
    for site in ref_sites {
        if site.is_definition {
            continue;
        }
        let fallback_candidates = if site.access_kind == "member" {
            member_fallback_candidates(
                site,
                &symbols_by_id,
                &types_by_name,
                &members_by_container_and_name,
                &symbols_by_file_and_name,
                &import_targets,
                &import_facts_by_file_local,
                &type_facts_by_file_local,
                &function_return_facts_by_file_name,
                hierarchy_facts,
            )
        } else {
            bare_symbols_by_name
                .get(site.name.as_str())
                .cloned()
                .unwrap_or_default()
        };
        let (imported_candidates, star_imported_candidates) = if site.access_kind == "bare" {
            let imported = import_targets
                .get(&(site.rel_path.as_str(), site.name.as_str()))
                .cloned()
                .unwrap_or_default();
            let star_imported =
                star_import_candidates(site, &star_import_facts_by_file, &symbols_by_file_and_name);
            (imported, star_imported)
        } else {
            (Vec::new(), Vec::new())
        };
        let unique_member_candidate = if site.access_kind == "member"
            && !site.is_import_context
            && site.receiver_name.is_some()
            && fallback_candidates.is_empty()
        {
            unique_symbol_by_language_and_name(
                &member_symbols_by_language_and_name,
                site.language.as_str(),
                site.name.as_str(),
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
        if site.access_kind == "member" {
            let exact_member_candidates = exact_member_candidates(
                site,
                &symbols_by_id,
                &types_by_name,
                &members_by_container_and_name,
                &symbols_by_file_and_name,
                &import_targets,
                &import_facts_by_file_local,
                &type_facts_by_file_local,
                &function_return_facts_by_file_name,
                hierarchy_facts,
            );
            for target in fallback_candidates.iter() {
                add_resolution_count(
                    &mut counts,
                    &mut counted_likely,
                    &mut counted_exact,
                    site,
                    target,
                    BOUND_MAY,
                    true,
                    true,
                );
            }
            for candidate in exact_member_candidates {
                add_resolution_count(
                    &mut counts,
                    &mut counted_likely,
                    &mut counted_exact,
                    site,
                    candidate.target,
                    BOUND_MAY | BOUND_MUST,
                    true,
                    true,
                );
                push_resolved_reference(
                    &mut references,
                    &mut dedup,
                    site,
                    candidate.target,
                    BOUND_MAY | BOUND_MUST,
                    "exact",
                    candidate.provenance,
                );
            }
            if let Some(target) = unique_member_candidate {
                add_resolution_count(
                    &mut counts,
                    &mut counted_likely,
                    &mut counted_exact,
                    site,
                    target,
                    BOUND_MAY,
                    true,
                    true,
                );
                push_resolved_reference(
                    &mut references,
                    &mut dedup,
                    site,
                    target,
                    BOUND_MAY,
                    "possible",
                    "unique-name",
                );
            }
            continue;
        }
        let same_file_count = fallback_candidates
            .iter()
            .filter(|symbol| symbol.rel_path == site.rel_path)
            .count();
        let unique_bare_candidate = if site.access_kind == "bare"
            && !site.is_import_context
            && same_file_count == 0
            && imported_candidates.is_empty()
            && star_imported_candidates.is_empty()
        {
            unique_symbol_by_language_and_name(
                &bare_symbols_by_language_and_name,
                site.language.as_str(),
                site.name.as_str(),
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
                site.access_kind == "bare" && target.name == site.name;
            add_resolution_count(
                &mut counts,
                &mut counted_likely,
                &mut counted_exact,
                site,
                target,
                bound_mask,
                fallback_already_counts_may,
                true,
            );
            if import_is_exact {
                push_resolved_reference(
                    &mut references,
                    &mut dedup,
                    site,
                    target,
                    bound_mask,
                    if import_is_exact { "exact" } else { "possible" },
                    "import",
                );
            }
        }
        for target in star_imported_candidates.iter() {
            add_resolution_count(
                &mut counts,
                &mut counted_likely,
                &mut counted_exact,
                site,
                target,
                BOUND_MAY,
                true,
                true,
            );
            push_resolved_reference(
                &mut references,
                &mut dedup,
                site,
                target,
                BOUND_MAY,
                "possible",
                "import-star",
            );
        }
        for target in fallback_candidates.iter() {
            let is_same_file_unique = site.access_kind == "bare"
                && same_file_count == 1
                && target.rel_path == site.rel_path;
            let is_workspace_unique = site.access_kind == "bare"
                && unique_bare_candidate.is_some_and(|unique| unique.id == target.id);
            let bound_mask = if is_same_file_unique {
                BOUND_MAY | BOUND_MUST
            } else {
                BOUND_MAY
            };
            if is_same_file_unique || is_workspace_unique {
                add_resolution_count(
                    &mut counts,
                    &mut counted_likely,
                    &mut counted_exact,
                    site,
                    target,
                    bound_mask,
                    true,
                    true,
                );
            }
            if !is_same_file_unique && !is_workspace_unique {
                continue;
            }
            let confidence = if bound_mask & BOUND_MUST != 0 {
                "exact"
            } else {
                "possible"
            };
            let provenance = if is_same_file_unique {
                "lexical"
            } else if is_workspace_unique {
                "unique-name"
            } else {
                "fallback"
            };
            push_resolved_reference(
                &mut references,
                &mut dedup,
                site,
                target,
                bound_mask,
                confidence,
                provenance,
            );
        }
    }
    apply_token_shape_likely_count_baseline(
        symbols,
        &mut counts,
        &bare_usage_likely_by_scope_and_name,
        &bare_call_likely_by_scope_and_name,
        &member_usage_likely_by_scope_and_name,
        &member_call_likely_by_scope_and_name,
    );
    ResolutionResult { references, counts }
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

fn star_import_candidates<'a>(
    site: &RefSite,
    star_import_facts_by_file: &HashMap<&'a str, Vec<&'a ImportFact>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
) -> Vec<&'a GraphSymbol> {
    let Some(facts) = star_import_facts_by_file.get(site.rel_path.as_str()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for fact in facts {
        for module_path in &fact.module_candidates {
            if let Some(symbols) =
                symbols_by_file_and_name.get(&(module_path.as_str(), site.name.as_str()))
            {
                out.extend(symbols.iter().copied());
            }
        }
    }
    sort_dedup_symbols(&mut out);
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

fn exact_member_candidates<'a>(
    site: &RefSite,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a ImportFact>>,
    type_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a TypeFact>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
) -> Vec<MemberExactCandidate<'a>> {
    let Some(receiver) = site.receiver_name.as_deref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if matches!(receiver, "self" | "cls") {
        if let Some(source) = site
            .enclosing_symbol_id
            .as_deref()
            .and_then(|id| symbols_by_id.get(id))
        {
            if let Some(container_name) = source.container_name.as_deref() {
                collect_exact_members_for_container(
                    &mut out,
                    members_by_container_and_name,
                    container_name,
                    &site.name,
                    "receiver-self",
                );
            }
        }
    }

    if let Some(types) = types_by_name.get(receiver) {
        for symbol in types {
            collect_exact_members_for_type(
                &mut out,
                members_by_container_and_name,
                symbol,
                &site.name,
                "receiver-type",
            );
        }
    }

    if let Some(targets) = import_targets.get(&(site.rel_path.as_str(), receiver)) {
        for target in targets {
            if is_type_kind(&target.kind) {
                collect_exact_members_for_type(
                    &mut out,
                    members_by_container_and_name,
                    target,
                    &site.name,
                    "imported-type",
                );
            }
        }
    }

    if let Some(facts) = import_facts_by_file_local.get(&(site.rel_path.as_str(), receiver)) {
        for fact in facts {
            if fact.imported_name != "*" {
                continue;
            }
            for module_path in &fact.module_candidates {
                if let Some(symbols) =
                    symbols_by_file_and_name.get(&(module_path.as_str(), site.name.as_str()))
                {
                    for symbol in symbols {
                        out.push(MemberExactCandidate {
                            target: *symbol,
                            provenance: "import-namespace",
                        });
                    }
                }
            }
        }
    }

    if let Some(facts) = type_facts_by_file_local.get(&(site.rel_path.as_str(), receiver)) {
        for fact in facts {
            if !type_fact_applies_to_site(fact, site) {
                continue;
            }
            for target_type in resolve_type_fact_targets(
                fact,
                site,
                symbols_by_id,
                types_by_name,
                symbols_by_file_and_name,
                import_targets,
                function_return_facts_by_file_name,
                hierarchy_facts,
            ) {
                collect_exact_members_for_type(
                    &mut out,
                    members_by_container_and_name,
                    target_type,
                    &site.name,
                    "type-fact",
                );
            }
        }
    }

    sort_dedup_member_exact_candidates(&mut out);
    if out.len() == 1 {
        out
    } else {
        Vec::new()
    }
}

fn member_fallback_candidates<'a>(
    site: &RefSite,
    symbols_by_id: &HashMap<&'a str, &'a GraphSymbol>,
    types_by_name: &HashMap<&'a str, Vec<&'a GraphSymbol>>,
    members_by_container_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    symbols_by_file_and_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_targets: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    import_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a ImportFact>>,
    type_facts_by_file_local: &HashMap<(&'a str, &'a str), Vec<&'a TypeFact>>,
    function_return_facts_by_file_name: &HashMap<(&'a str, &'a str), Vec<&'a FunctionReturnFact>>,
    hierarchy_facts: &[HierarchyFact],
) -> Vec<&'a GraphSymbol> {
    let Some(receiver) = site.receiver_name.as_deref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if matches!(receiver, "self" | "cls") {
        if let Some(source) = site
            .enclosing_symbol_id
            .as_deref()
            .and_then(|id| symbols_by_id.get(id))
        {
            if let Some(container_name) = source.container_name.as_deref() {
                extend_members_for_container(
                    &mut out,
                    members_by_container_and_name,
                    container_name,
                    &site.name,
                );
            } else if is_type_kind(&source.kind) {
                extend_members_for_type(
                    &mut out,
                    members_by_container_and_name,
                    source,
                    &site.name,
                );
            }
        }
    }

    if let Some(types) = types_by_name.get(receiver) {
        for symbol in types {
            extend_members_for_type(&mut out, members_by_container_and_name, symbol, &site.name);
        }
    }

    if let Some(targets) = import_targets.get(&(site.rel_path.as_str(), receiver)) {
        for target in targets {
            if is_type_kind(&target.kind) {
                extend_members_for_type(
                    &mut out,
                    members_by_container_and_name,
                    target,
                    &site.name,
                );
            }
        }
    }

    if let Some(facts) = import_facts_by_file_local.get(&(site.rel_path.as_str(), receiver)) {
        for fact in facts {
            for module_path in &fact.module_candidates {
                if let Some(symbols) =
                    symbols_by_file_and_name.get(&(module_path.as_str(), site.name.as_str()))
                {
                    out.extend(symbols.iter().copied());
                }
            }
        }
    }

    if let Some(facts) = type_facts_by_file_local.get(&(site.rel_path.as_str(), receiver)) {
        for fact in facts {
            if !type_fact_applies_to_site(fact, site) {
                continue;
            }
            for target_type in resolve_type_fact_targets(
                fact,
                site,
                symbols_by_id,
                types_by_name,
                symbols_by_file_and_name,
                import_targets,
                function_return_facts_by_file_name,
                hierarchy_facts,
            ) {
                extend_members_for_type(
                    &mut out,
                    members_by_container_and_name,
                    target_type,
                    &site.name,
                );
            }
        }
    }

    out.sort_by(|left, right| left.id.cmp(&right.id));
    out.dedup_by(|left, right| left.id == right.id);
    out
}

fn type_fact_applies_to_site(fact: &TypeFact, site: &RefSite) -> bool {
    match (
        fact.enclosing_symbol_id.as_deref(),
        site.enclosing_symbol_id.as_deref(),
    ) {
        (Some(fact_scope), Some(site_scope)) => fact_scope == site_scope,
        (None, _) => true,
        _ => false,
    }
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
        if let Some(container_name) = site
            .enclosing_symbol_id
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
            .filter(|symbol| is_type_kind(&symbol.kind))
            .collect();
        if !same_file_types.is_empty() {
            return same_file_types;
        }
    }
    if let Some(targets) = import_targets.get(&(context_rel_path, type_name)) {
        let imported_types: Vec<_> = targets
            .iter()
            .copied()
            .filter(|symbol| is_type_kind(&symbol.kind))
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
    extend_members_for_container(
        out,
        members_by_container_and_name,
        type_symbol.qualified_name.as_str(),
        member_name,
    );
    extend_members_for_container(
        out,
        members_by_container_and_name,
        type_symbol.name.as_str(),
        member_name,
    );
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

fn sort_dedup_symbols(symbols: &mut Vec<&GraphSymbol>) {
    symbols.sort_by(|left, right| left.id.cmp(&right.id));
    symbols.dedup_by(|left, right| left.id == right.id);
}

fn sort_dedup_member_exact_candidates(candidates: &mut Vec<MemberExactCandidate<'_>>) {
    candidates.sort_by(|left, right| left.target.id.cmp(&right.target.id));
    candidates.dedup_by(|left, right| left.target.id == right.target.id);
}

fn add_resolution_count(
    counts: &mut HashMap<String, GraphCount>,
    counted_likely: &mut BTreeSet<(String, String, String)>,
    counted_exact: &mut BTreeSet<(String, String, String)>,
    site: &RefSite,
    target: &GraphSymbol,
    bound_mask: u8,
    may_already_counted: bool,
    likely: bool,
) {
    let count = counts.entry(target.id.clone()).or_default();
    let edge_key = (
        site.source_ref_id.clone(),
        target.id.clone(),
        site.edge_kind.clone(),
    );
    if likely && counted_likely.insert(edge_key.clone()) {
        count.usage_likely += 1;
        if matches!(site.edge_kind.as_str(), "call" | "construct") {
            count.calls_in_likely += 1;
        }
    }
    if !may_already_counted && bound_mask & BOUND_MAY != 0 {
        count.usage_may += 1;
        if matches!(site.edge_kind.as_str(), "call" | "construct") {
            count.calls_in_may += 1;
        }
    }
    if bound_mask & BOUND_MUST != 0 && counted_exact.insert(edge_key) {
        count.usage_must += 1;
        if matches!(site.edge_kind.as_str(), "call" | "construct") {
            count.calls_in_must += 1;
        }
    }
}

fn apply_token_shape_likely_count_baseline(
    symbols: &[GraphSymbol],
    counts: &mut HashMap<String, GraphCount>,
    bare_usage_by_scope_and_name: &HashMap<(&str, &str, &str), usize>,
    bare_call_by_scope_and_name: &HashMap<(&str, &str, &str), usize>,
    member_usage_by_scope_and_name: &HashMap<(&str, &str, &str), usize>,
    member_call_by_scope_and_name: &HashMap<(&str, &str, &str), usize>,
) {
    for symbol in symbols {
        let key = (
            symbol.language.as_str(),
            source_scope_key(&symbol.rel_path),
            symbol.name.as_str(),
        );
        let (usage_baseline, call_baseline) = if uses_member_token_shape_for_likely_count(symbol) {
            (
                member_usage_by_scope_and_name
                    .get(&key)
                    .copied()
                    .unwrap_or(0),
                member_call_by_scope_and_name
                    .get(&key)
                    .copied()
                    .unwrap_or(0),
            )
        } else {
            (
                bare_usage_by_scope_and_name.get(&key).copied().unwrap_or(0),
                bare_call_by_scope_and_name.get(&key).copied().unwrap_or(0),
            )
        };
        let count = counts.entry(symbol.id.clone()).or_default();
        count.usage_likely = count.usage_must.max(usage_baseline);
        count.calls_in_likely = count.calls_in_must.max(call_baseline);
    }
}

fn uses_member_token_shape_for_likely_count(symbol: &GraphSymbol) -> bool {
    matches!(symbol.kind.as_str(), "method" | "field" | "property")
}

fn source_scope_key(rel_path: &str) -> &str {
    rel_path.split('/').next().unwrap_or(rel_path)
}

fn is_likely_count_derived_context(rel_path: &str) -> bool {
    if rel_path.ends_with(".pyi") {
        return true;
    }
    if rel_path.split('/').any(|segment| {
        is_graph_dependency_or_artifact_dir(segment) || is_generated_context_segment(segment)
    }) {
        return true;
    }
    Path::new(rel_path)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(is_generated_source_file_name)
}

fn is_generated_context_segment(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    matches!(lower.as_str(), "migrations" | "generated" | "__generated__")
        || lower.ends_with("_generated")
        || lower.ends_with("-generated")
}

fn is_generated_source_file_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.contains(".generated.")
        || lower.contains("_generated.")
        || lower.contains(".gen.")
        || lower.contains("_gen.")
        || lower.ends_with("_pb2.py")
        || lower.ends_with("_pb2_grpc.py")
        || lower.ends_with(".pb.go")
        || lower.ends_with(".pb.cc")
        || lower.ends_with(".pb.h")
        || lower.ends_with(".g.dart")
        || lower.ends_with(".designer.cs")
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

fn push_resolved_reference(
    references: &mut Vec<GraphReference>,
    dedup: &mut BTreeSet<(String, String, String)>,
    site: &RefSite,
    target: &GraphSymbol,
    bound_mask: u8,
    confidence: &str,
    provenance: &str,
) {
    let key = (
        site.source_ref_id.clone(),
        target.id.clone(),
        site.edge_kind.clone(),
    );
    if !dedup.insert(key) {
        return;
    }
    references.push(GraphReference {
        source_ref_id: site.source_ref_id.clone(),
        target_symbol_id: Some(target.id.clone()),
        edge_kind: site.edge_kind.clone(),
        name: site.name.clone(),
        raw_text: site.raw_text.clone(),
        uri: site.uri.clone(),
        rel_path: site.rel_path.clone(),
        start_line: site.start_line,
        start_column: site.start_column,
        end_line: site.end_line,
        end_column: site.end_column,
        enclosing_symbol_id: site.enclosing_symbol_id.clone(),
        bound_mask,
        confidence: confidence.to_string(),
        provenance: provenance.to_string(),
    });
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
            let count = counts.entry(target.clone()).or_default();
            if reference.bound_mask & BOUND_MUST != 0 {
                count.usage_must += 1;
            }
            if reference.bound_mask & BOUND_MAY != 0 {
                count.usage_may += 1;
                count.usage_likely += 1;
            }
            if matches!(reference.edge_kind.as_str(), "call" | "construct") {
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
            let count = counts.entry(source.clone()).or_default();
            if matches!(reference.edge_kind.as_str(), "call" | "construct") {
                if reference.bound_mask & BOUND_MUST != 0 {
                    count.calls_out_must += 1;
                }
                if reference.bound_mask & BOUND_MAY != 0 {
                    count.calls_out_may += 1;
                }
            }
        }
    }

    apply_implementation_counts(symbols, hierarchy_facts, &mut counts);
    counts
}

fn compute_native_counts(
    symbols: &[GraphSymbol],
    resolution_counts: &HashMap<String, GraphCount>,
    hierarchy_facts: &[HierarchyFact],
) -> HashMap<String, GraphCount> {
    let mut counts = resolution_counts.clone();
    for symbol in symbols {
        counts.entry(symbol.id.clone()).or_default();
    }
    if symbols.len() <= MAX_EAGER_IMPLEMENTATION_SYMBOLS {
        apply_implementation_counts(symbols, hierarchy_facts, &mut counts);
    }
    counts
}

fn apply_implementation_counts(
    symbols: &[GraphSymbol],
    hierarchy_facts: &[HierarchyFact],
    counts: &mut HashMap<String, GraphCount>,
) {
    for symbol in symbols {
        if !is_type_kind(&symbol.kind) && symbol.kind != "method" {
            continue;
        }
        let descendants = descendant_type_names(symbol, symbols, hierarchy_facts);
        let implementations = if is_type_kind(&symbol.kind) {
            symbols
                .iter()
                .filter(|candidate| {
                    candidate.id != symbol.id
                        && is_type_kind(&candidate.kind)
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

fn write_store(
    workspace_root: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    file_count: usize,
    symbols: &[GraphSymbol],
    references: &[GraphReference],
    counts: &HashMap<String, GraphCount>,
) -> io::Result<GraphIndexSummary> {
    let layout_root = config.index_root(workspace_root);
    fs::create_dir_all(&layout_root)?;
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    let relation_path = graph_index_path(workspace_root, config);
    let count_path = graph_count_index_path(workspace_root, config);
    write_atomically(&symbol_path, serialize_symbols(symbols).as_bytes())?;
    write_atomically(&relation_path, serialize_references(references).as_bytes())?;
    write_atomically(&count_path, serialize_counts(counts).as_bytes())?;

    let indexed_at_unix_secs = unix_secs_now();
    let bytes = file_len(&symbol_path)? + file_len(&relation_path)? + file_len(&count_path)?;
    let manifest = format!(
        "{{\"engine\":\"zoek-rs\",\"type\":\"semantic-serving-graph\",\"version\":{},\"workspaceRoot\":{},\"indexedAtUnixSecs\":{},\"builtAtUnixMs\":{},\"fileCount\":{},\"symbolCount\":{},\"referenceCount\":{},\"bytes\":{}}}",
        GRAPH_VERSION,
        crate::protocol::json_string(&workspace_root.to_string_lossy()),
        indexed_at_unix_secs,
        built_at_unix_ms,
        file_count,
        symbols.len(),
        references.len(),
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
        reference_count: references.len(),
        bytes,
    })
}

fn read_store(workspace_root: &Path, config: &EngineConfig) -> io::Result<Option<GraphStore>> {
    let relation_path = graph_index_path(workspace_root, config);
    let symbol_path = graph_symbol_index_path(workspace_root, config);
    if !relation_path.exists() && !symbol_path.exists() {
        return Ok(None);
    }
    let built_at_unix_ms = read_built_at_unix_ms(&graph_manifest_path(workspace_root, config))?;
    let symbols = if symbol_path.exists() {
        read_symbols(&symbol_path)?
    } else {
        Vec::new()
    };
    let references = if relation_path.exists() {
        read_references(&relation_path)?
    } else {
        Vec::new()
    };
    let hierarchy_facts = hierarchy_facts_from_symbols(&symbols);
    let count_path = graph_count_index_path(workspace_root, config);
    let counts = if count_path.exists() {
        read_counts(&count_path)?
    } else {
        compute_counts(&symbols, &references, &hierarchy_facts)
    };
    Ok(Some(GraphStore {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        symbols,
        references,
        hierarchy_facts,
        counts,
    }))
}

fn serialize_symbols(symbols: &[GraphSymbol]) -> String {
    let mut out = String::new();
    for symbol in symbols {
        out.push_str(
            &[
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
            .join("\t"),
        );
        out.push('\n');
    }
    out
}

fn serialize_references(references: &[GraphReference]) -> String {
    let mut out = String::new();
    for reference in references {
        out.push_str(
            &[
                "E".to_string(),
                encode_field(&reference.source_ref_id),
                encode_field(reference.target_symbol_id.as_deref().unwrap_or("")),
                encode_field(&reference.edge_kind),
                encode_field(&reference.name),
                encode_field(&reference.raw_text),
                encode_field(&reference.uri),
                encode_field(&reference.rel_path),
                reference.start_line.to_string(),
                reference.start_column.to_string(),
                reference.end_line.to_string(),
                reference.end_column.to_string(),
                encode_field(reference.enclosing_symbol_id.as_deref().unwrap_or("")),
                reference.bound_mask.to_string(),
                encode_field(&reference.confidence),
                encode_field(&reference.provenance),
            ]
            .join("\t"),
        );
        out.push('\n');
    }
    out
}

fn serialize_counts(counts: &HashMap<String, GraphCount>) -> String {
    let mut rows: Vec<_> = counts.iter().collect();
    rows.sort_by(|left, right| left.0.cmp(right.0));
    let mut out = String::new();
    for (symbol_id, count) in rows {
        out.push_str(
            &[
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
            .join("\t"),
        );
        out.push('\n');
    }
    out
}

fn read_symbols(path: &Path) -> io::Result<Vec<GraphSymbol>> {
    let mut symbols = Vec::new();
    let input = fs::File::open(path)?;
    for line in BufReader::new(input).lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 21 || fields[0] != "S" {
            return Err(invalid_data(format!(
                "invalid graph symbol row with {} fields",
                fields.len()
            )));
        }
        symbols.push(GraphSymbol {
            id: decode_field(fields[1])?,
            name: decode_field(fields[2])?,
            qualified_name: decode_field(fields[3])?,
            kind: decode_field(fields[4])?,
            language: decode_field(fields[5])?,
            uri: decode_field(fields[6])?,
            rel_path: decode_field(fields[7])?,
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
        });
    }
    Ok(symbols)
}

fn read_references(path: &Path) -> io::Result<Vec<GraphReference>> {
    let mut references = Vec::new();
    let input = fs::File::open(path)?;
    for line in BufReader::new(input).lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if !(fields.len() == 15 || fields.len() == 16) || fields[0] != "E" {
            return Err(invalid_data(format!(
                "invalid graph edge row with {} fields",
                fields.len()
            )));
        }
        let offset = if fields.len() == 16 { 1 } else { 0 };
        let name = decode_field(fields[3 + offset])?;
        let rel_path = decode_field(fields[6 + offset])?;
        let start_line = parse_u32(fields[7 + offset], "startLine")?;
        let start_column = parse_u32(fields[8 + offset], "startColumn")?;
        let source_ref_id = if offset == 1 {
            decode_field(fields[1])?
        } else {
            stable_ref_id(&rel_path, start_line, start_column, &name)
        };
        references.push(GraphReference {
            source_ref_id,
            target_symbol_id: empty_string_to_none(decode_field(fields[1 + offset])?),
            edge_kind: decode_field(fields[2 + offset])?,
            name,
            raw_text: decode_field(fields[4 + offset])?,
            uri: decode_field(fields[5 + offset])?,
            rel_path,
            start_line,
            start_column,
            end_line: parse_u32(fields[9 + offset], "endLine")?,
            end_column: parse_u32(fields[10 + offset], "endColumn")?,
            enclosing_symbol_id: empty_string_to_none(decode_field(fields[11 + offset])?),
            bound_mask: fields[12 + offset]
                .parse::<u8>()
                .map_err(|_| invalid_data("invalid bound mask"))?,
            confidence: decode_field(fields[13 + offset])?,
            provenance: decode_field(fields[14 + offset])?,
        });
    }
    Ok(references)
}

fn read_counts(path: &Path) -> io::Result<HashMap<String, GraphCount>> {
    let mut counts = HashMap::new();
    let input = fs::File::open(path)?;
    for line in BufReader::new(input).lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if !(fields.len() == 10 || fields.len() == 12) || fields[0] != "C" {
            return Err(invalid_data(format!(
                "invalid graph count row with {} fields",
                fields.len()
            )));
        }
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
        counts.insert(
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
        );
    }
    Ok(counts)
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
        .filter(|symbol| is_type_kind(&symbol.kind))
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
    if symbol.qualified_name == query {
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

fn sanitize_code_line(line: &str, language: &str) -> String {
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
    out
}

fn sanitize_ref_site_code_line(
    line: &str,
    language: &str,
    python_multiline_string_quote: &mut Option<char>,
) -> String {
    if language == "python" {
        sanitize_python_ref_site_code_line(line, python_multiline_string_quote)
    } else {
        sanitize_code_line(line, language)
    }
}

fn sanitize_python_ref_site_code_line(
    line: &str,
    multiline_string_quote: &mut Option<char>,
) -> String {
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
    out
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

fn normalize_graph_rel_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/")
}

fn is_graph_dependency_or_artifact_dir(name: &str) -> bool {
    matches!(
        name,
        ".cache"
            | ".dart_tool"
            | ".git"
            | ".gradle"
            | ".hg"
            | ".mypy_cache"
            | ".next"
            | ".nox"
            | ".nuxt"
            | ".parcel-cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".svn"
            | ".tox"
            | ".turbo"
            | ".venv"
            | "__pycache__"
            | "bower_components"
            | "coverage"
            | "DerivedData"
            | "dist"
            | "env"
            | "node_modules"
            | "out"
            | "Pods"
            | "site-packages"
            | "target"
            | "venv"
    )
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

fn unique_symbol_by_language_and_name<'a>(
    symbols_by_name: &HashMap<(&'a str, &'a str), Vec<&'a GraphSymbol>>,
    language: &str,
    name: &str,
) -> Option<&'a GraphSymbol> {
    let symbols = symbols_by_name.get(&(language, name))?;
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
                    && reference.confidence == "possible"
                    && reference.provenance == "unique-name"
            }),
            "workspace-unique bare fallback should keep a queryable possible reference"
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(unique_run_id)
                    && reference.confidence == "possible"
                    && reference.provenance == "unique-name"
            }),
            "workspace-unique member fallback should keep a queryable possible reference"
        );
        assert!(
            !result.references.iter().any(|reference| {
                (reference.target_symbol_id.as_deref() == Some(first_shared_id)
                    || reference.target_symbol_id.as_deref() == Some(second_shared_id))
                    && reference.provenance == "unique-name"
            }),
            "ambiguous member names should not be promoted to queryable unique-name references"
        );
    }

    #[test]
    fn token_shape_likely_baseline_ignores_derived_code_contexts() {
        let provider = test_entry(
            "pkg/provider.py",
            r#"
class Worker:
    def unique_run(self):
        return 1
"#,
        );
        let consumer = test_entry(
            "pkg/consumer.py",
            r#"
def use(client):
    client.unique_run()
"#,
        );
        let migration = test_entry(
            "pkg/migrations/0001_initial.py",
            r#"
def migrate(client):
    client.unique_run()
"#,
        );
        let generated = test_entry(
            "pkg/generated/api_client.py",
            r#"
def replay(client):
    client.unique_run()
"#,
        );
        let stub = test_entry(
            "pkg/types.pyi",
            r#"
def replay(client):
    client.unique_run()
"#,
        );
        let (symbols, result) =
            resolve_test_entries(&[provider, consumer, migration, generated, stub]);
        let unique_run_id = symbol_id(&symbols, "Worker.unique_run");
        let count = result
            .counts
            .get(unique_run_id)
            .copied()
            .unwrap_or_default();

        assert_eq!(
            count.usage_likely, 1,
            "derived source paths should not inflate token-shape likely counts"
        );
        assert!(
            count.usage_may >= 3,
            "derived source paths remain inside the conservative MAY envelope"
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
                    && reference.rel_path == "pkg/consumer.ts"
                    && reference.raw_text == "run"
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "typed receiver member calls should be exact: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && reference.rel_path == "pkg/consumer.ts"
                    && reference.raw_text == "helper"
                    && reference.confidence == "exact"
                    && reference.provenance == "import-namespace"
            }),
            "namespace imports should resolve member usage exactly: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && reference.rel_path == "pkg/consumer.ts"
                    && reference.raw_text == "localHelper"
                    && reference.confidence == "exact"
                    && reference.provenance == "import"
            }),
            "CommonJS destructuring should resolve through import facts: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.ts"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamicCall")
                    })
                    && reference.confidence == "exact"
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
                    && reference.rel_path == "pkg/consumer.js"
                    && reference.raw_text == "run"
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "JavaScript constructor receiver member calls should be exact: {:?}",
            js_result.references
        );
        assert!(
            js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(js_helper_id)
                    && reference.rel_path == "pkg/consumer.js"
                    && reference.raw_text == "helper"
                    && reference.confidence == "exact"
                    && reference.provenance == "import-namespace"
            }),
            "CommonJS namespace requires should resolve member usage exactly: {:?}",
            js_result.references
        );
        assert!(
            js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(js_helper_id)
                    && reference.rel_path == "pkg/consumer.js"
                    && reference.raw_text == "localHelper"
                    && reference.confidence == "exact"
                    && reference.provenance == "import"
            }),
            "CommonJS destructuring in JavaScript should resolve through import facts: {:?}",
            js_result.references
        );
        assert!(
            !js_result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(widget_run_id)
                    && reference.rel_path == "pkg/consumer.js"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        js_symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamicCall")
                    })
                    && reference.confidence == "exact"
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
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python annotation receiver member calls should be exact: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_alias")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python alias assignments from typed locals should preserve receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_return_factory")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python annotated callable returns should provide receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(ping_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "ping"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_imported_return_factory"
                        })
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python imported annotated callable returns should provide receiver exactness: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_collection_loop")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python iterable annotations should type for-loop elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_collection_index"
                        })
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python iterable annotations should type indexed elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_cast")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python typing.cast assignments should type local receivers: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_cast_collection")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Python typing.cast collection assignments should type indexed elements: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "typed_queryset_chain")
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Django QuerySet-preserving calls should retain element receiver types: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_model_manager_get"
                        })
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Django Model.objects.get should type the returned model receiver: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id && symbol.name == "typed_model_manager_filter"
                        })
                    })
                    && reference.confidence == "exact"
                    && reference.provenance == "type-fact"
            }),
            "Django Model.objects.filter should retain model element types: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(plain_run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols.iter().any(|symbol| {
                            symbol.id == id
                                && symbol.name == "plain_manager_shape_is_not_django_model"
                        })
                    })
                    && reference.confidence == "exact"
            }),
            "Django manager-shaped calls must not type arbitrary non-model classes: {:?}",
            result.references
        );
        assert!(
            result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(helper_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "helper"
                    && reference.confidence == "possible"
                    && reference.provenance == "import-star"
            }),
            "Python star imports should preserve import candidates: {:?}",
            result.references
        );
        assert!(
            !result.references.iter().any(|reference| {
                reference.target_symbol_id.as_deref() == Some(run_id)
                    && reference.rel_path == "pkg/consumer.py"
                    && reference.raw_text == "run"
                    && reference.enclosing_symbol_id.as_deref().is_some_and(|id| {
                        symbols
                            .iter()
                            .any(|symbol| symbol.id == id && symbol.name == "dynamic")
                    })
                    && reference.confidence == "exact"
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
