use crate::config::EngineConfig;
use crate::corpus::{decode_bytes, looks_binary_bytes};
use crate::mmap_store::write_atomically;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

const GRAPH_MAGIC: &[u8; 8] = b"IJSSGRF1";
const GRAPH_VERSION: u32 = 1;
const GRAPH_HEADER_SIZE: usize = 40;
const GRAPH_INDEX_ENTRY_SIZE: usize = 28;
const GRAPH_FILE_NAME: &str = "callgraph-relations.ijg";
const GRAPH_RELATION_SHARD_PREFIX: &str = "callgraph-relations-";
const GRAPH_RELATION_SHARD_SUFFIX: &str = ".ijg";
const GRAPH_RELATION_STALE_TTL_SECS: u64 = 15 * 60;
const GRAPH_SYMBOL_MAGIC: &[u8; 8] = b"IJSSSYM1";
const GRAPH_SYMBOL_FILE_NAME: &str = "callgraph-symbols.ijgs";
const GRAPH_SYMBOL_HEADER_SIZE: usize = 40;
const GRAPH_SYMBOL_INDEX_ENTRY_SIZE: usize = 12;
const GRAPH_MANIFEST_NAME: &str = "callgraph-manifest.json";
const MODULE_IMPORT_TARGET: &str = "__ijss_module__";
const FRAMEWORK_IMPL_PREFIX: &str = "__ijss_framework_impl__:";

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
    pub name: String,
    pub raw_text: String,
    pub uri: String,
    pub rel_path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub enclosing_symbol_id: Option<String>,
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
    pub implementation_count: Option<usize>,
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

#[derive(Clone, Debug)]
struct IndexEntry {
    symbol_offset: u64,
    symbol_len: u32,
    refs_offset: u64,
    refs_len: u32,
    ref_count: u32,
}

#[derive(Clone, Debug)]
struct SymbolEntry {
    record_offset: u64,
    record_len: u32,
}

#[derive(Clone, Debug)]
struct GraphRelationManifest {
    built_at_unix_ms: u64,
    generation: u64,
    shard_count: usize,
}

#[derive(Clone, Debug)]
struct GraphRelationShardSummary {
    shard_id: usize,
    file_name: String,
    symbol_count: usize,
    reference_count: usize,
    bytes: u64,
}

struct PendingGraphRelationGeneration {
    summary: GraphIndexSummary,
    manifest_path: PathBuf,
    manifest: String,
    generation: u64,
}

pub fn graph_index_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_FILE_NAME)
}

pub fn graph_symbol_index_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config
        .index_root(workspace_root)
        .join(GRAPH_SYMBOL_FILE_NAME)
}

fn graph_relation_manifest_path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
    config.index_root(workspace_root).join(GRAPH_MANIFEST_NAME)
}

fn graph_relation_shard_file_name(generation: u64, shard_id: usize) -> String {
    format!("{GRAPH_RELATION_SHARD_PREFIX}{generation}-{shard_id:04}{GRAPH_RELATION_SHARD_SUFFIX}")
}

fn graph_relation_shard_path(layout_root: &Path, generation: u64, shard_id: usize) -> PathBuf {
    layout_root.join(graph_relation_shard_file_name(generation, shard_id))
}

pub fn index_graph_from_tsv(
    workspace_root: &Path,
    input_path: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
) -> io::Result<GraphIndexSummary> {
    let layout_root = config.index_root(workspace_root);
    fs::create_dir_all(&layout_root)?;

    let input = fs::File::open(input_path)?;
    let reader = BufReader::new(input);
    let mut entries: Vec<IndexEntry> = Vec::new();
    let mut data: Vec<u8> = Vec::new();
    let mut current_symbol: Option<String> = None;
    let mut current_refs: Vec<GraphReference> = Vec::new();
    let mut reference_count = 0usize;

    for line in reader.lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 11 || fields[0] != "U" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid graph TSV row with {} fields", fields.len()),
            ));
        }
        let symbol_id = decode_field(fields[1])?;
        if current_symbol.as_deref() != Some(symbol_id.as_str()) {
            flush_record(
                &mut entries,
                &mut data,
                current_symbol.take(),
                &mut current_refs,
            )?;
            current_symbol = Some(symbol_id.clone());
        }
        current_refs.push(GraphReference {
            name: decode_field(fields[2])?,
            raw_text: decode_field(fields[3])?,
            uri: decode_field(fields[4])?,
            rel_path: decode_field(fields[5])?,
            start_line: parse_u32(fields[6], "startLine")?,
            start_column: parse_u32(fields[7], "startColumn")?,
            end_line: parse_u32(fields[8], "endLine")?,
            end_column: parse_u32(fields[9], "endColumn")?,
            enclosing_symbol_id: optional_decoded_field(fields[10])?,
        });
        reference_count += 1;
    }
    flush_record(
        &mut entries,
        &mut data,
        current_symbol.take(),
        &mut current_refs,
    )?;

    entries.sort_by(|a, b| {
        symbol_bytes(&data, a)
            .unwrap_or_default()
            .cmp(symbol_bytes(&data, b).unwrap_or_default())
    });

    let index_offset = GRAPH_HEADER_SIZE as u64;
    let data_offset = GRAPH_HEADER_SIZE as u64 + (entries.len() * GRAPH_INDEX_ENTRY_SIZE) as u64;
    let mut bytes = Vec::with_capacity(data_offset as usize + data.len());
    bytes.extend_from_slice(GRAPH_MAGIC);
    put_u32(&mut bytes, GRAPH_VERSION);
    put_u32(&mut bytes, entries.len() as u32);
    put_u64(&mut bytes, built_at_unix_ms);
    put_u64(&mut bytes, index_offset);
    put_u64(&mut bytes, data_offset);
    for entry in &entries {
        put_u64(&mut bytes, entry.symbol_offset);
        put_u32(&mut bytes, entry.symbol_len);
        put_u64(&mut bytes, entry.refs_offset);
        put_u32(&mut bytes, entry.refs_len);
        put_u32(&mut bytes, entry.ref_count);
    }
    bytes.extend_from_slice(&data);

    let index_path = layout_root.join(GRAPH_FILE_NAME);
    write_atomically(&index_path, &bytes)?;
    let indexed_at_unix_secs = unix_secs_now();
    let manifest = format!(
        "{{\"engine\":\"zoek-rs\",\"type\":\"callgraph\",\"version\":{},\"workspaceRoot\":{},\"indexPath\":{},\"indexedAtUnixSecs\":{},\"builtAtUnixMs\":{},\"symbolCount\":{},\"referenceCount\":{},\"bytes\":{}}}",
        GRAPH_VERSION,
        crate::protocol::json_string(&workspace_root.to_string_lossy()),
        crate::protocol::json_string(&index_path.to_string_lossy()),
        indexed_at_unix_secs,
        built_at_unix_ms,
        entries.len(),
        reference_count,
        bytes.len()
    );
    write_atomically(&layout_root.join(GRAPH_MANIFEST_NAME), manifest.as_bytes())?;

    Ok(GraphIndexSummary {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_path: index_path.to_string_lossy().into_owned(),
        indexed_at_unix_secs,
        built_at_unix_ms,
        file_count: 0,
        symbol_count: entries.len(),
        reference_count,
        bytes: bytes.len() as u64,
    })
}

pub fn rebuild_graph_native<F>(
    workspace_root: &Path,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    worker_count: usize,
    progress: &mut F,
) -> io::Result<GraphIndexSummary>
where
    F: FnMut(GraphRebuildProgress),
{
    progress(GraphRebuildProgress {
        stage: "discovering",
        current: 0,
        total: 0,
        message: "rust graph discovering source files".to_string(),
    });
    let mut files = Vec::new();
    let mut discovered_entries = 0usize;
    discover_graph_source_files(
        workspace_root,
        workspace_root,
        config,
        &mut files,
        &mut discovered_entries,
        progress,
    )?;
    files.sort();
    progress(GraphRebuildProgress {
        stage: "parsing",
        current: 0,
        total: files.len(),
        message: format!("rust graph parsing {} source files", files.len()),
    });

    let workers = effective_graph_worker_count(worker_count, files.len());
    let parsed_files =
        parse_graph_source_files_parallel(workspace_root, config, files, workers, progress)?;
    let parsed_file_count = parsed_files.len();
    let symbols: Vec<NativeGraphSymbol> = parsed_files
        .iter()
        .flat_map(|file| file.symbols.iter().cloned())
        .collect();

    progress(GraphRebuildProgress {
        stage: "indexing",
        current: 0,
        total: symbols.len(),
        message: format!(
            "rust graph resolving references for {} symbols",
            symbols.len()
        ),
    });
    let references = resolve_native_graph_references(parsed_files, &symbols, workers, progress);
    progress(GraphRebuildProgress {
        stage: "indexing",
        current: references.len(),
        total: references.len(),
        message: format!("rust graph writing {} references", references.len()),
    });
    let pending = prepare_graph_relation_generation(
        workspace_root,
        references,
        built_at_unix_ms,
        config,
        worker_count,
    )?;
    write_symbol_index(workspace_root, &symbols, built_at_unix_ms, config)?;
    let mut summary = commit_graph_relation_generation(pending)?;
    summary.file_count = parsed_file_count;
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
    let Some((current_built_at_unix_ms, existing_symbols)) =
        read_symbol_index(workspace_root, config)?
    else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "graph symbol index is not built",
        ));
    };
    let target_built_at_unix_ms = if built_at_unix_ms == 0 {
        current_built_at_unix_ms
    } else {
        built_at_unix_ms
    };
    if target_built_at_unix_ms != current_built_at_unix_ms {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "graph update builtAt mismatch: requested {target_built_at_unix_ms}, index has {current_built_at_unix_ms}"
            ),
        ));
    }
    let existing_references = read_all_graph_references(workspace_root, config)?
        .unwrap_or((target_built_at_unix_ms, Vec::new()));
    if existing_references.0 != target_built_at_unix_ms {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "graph relation index builtAt mismatch: relations have {}, symbols have {}",
                existing_references.0, target_built_at_unix_ms
            ),
        ));
    }

    let mut changed_uris = HashSet::new();
    let mut changed_rel_paths = HashSet::new();
    let mut parsed_files = Vec::new();
    for path in changed_paths {
        let path = graph_update_path(workspace_root, path);
        changed_uris.insert(file_uri(&path));
        changed_rel_paths.insert(normalize_rel_path(
            path.strip_prefix(workspace_root).unwrap_or(&path),
        ));
        if path.exists() && path.is_file() && is_graph_source_path(&path) {
            if let Some(file) = parse_graph_source_file(workspace_root, &path, config)? {
                changed_uris.insert(file.uri.clone());
                changed_rel_paths.insert(file.rel_path.clone());
                parsed_files.push(file);
            }
        }
    }
    for path in deleted_paths {
        let path = graph_update_path(workspace_root, path);
        changed_uris.insert(file_uri(&path));
        changed_rel_paths.insert(normalize_rel_path(
            path.strip_prefix(workspace_root).unwrap_or(&path),
        ));
    }

    if changed_uris.is_empty() && changed_rel_paths.is_empty() {
        return index_graph_from_references_with_workers(
            workspace_root,
            existing_references.1,
            target_built_at_unix_ms,
            config,
            worker_count,
        );
    }

    let old_symbol_ids =
        stable_symbol_ids_for_changed_files(&existing_symbols, &changed_uris, &changed_rel_paths);
    restore_stable_symbol_ids(&mut parsed_files, &old_symbol_ids);

    let mut symbols: Vec<NativeGraphSymbol> = existing_symbols
        .into_iter()
        .filter(|symbol| {
            !changed_uris.contains(&symbol.uri) && !changed_rel_paths.contains(&symbol.rel_path)
        })
        .map(graph_symbol_to_native_symbol)
        .collect();
    symbols.extend(
        parsed_files
            .iter()
            .flat_map(|file| file.symbols.iter().cloned()),
    );
    let valid_symbol_ids: HashSet<String> =
        symbols.iter().map(|symbol| symbol.id.clone()).collect();
    let workers = effective_graph_worker_count(worker_count, parsed_files.len().max(1));
    let mut progress = |_progress: GraphRebuildProgress| {};
    let mut references: Vec<(String, GraphReference)> = existing_references
        .1
        .into_iter()
        .filter(|(symbol_id, reference)| {
            valid_symbol_ids.contains(symbol_id)
                && !changed_uris.contains(&reference.uri)
                && !changed_rel_paths.contains(&reference.rel_path)
                && reference
                    .enclosing_symbol_id
                    .as_ref()
                    .map(|id| valid_symbol_ids.contains(id))
                    .unwrap_or(true)
        })
        .collect();
    references.extend(resolve_native_graph_references(
        parsed_files,
        &symbols,
        workers,
        &mut progress,
    ));

    let writer_workers = effective_graph_worker_count(worker_count, references.len().max(1));
    let pending = prepare_graph_relation_generation(
        workspace_root,
        references,
        target_built_at_unix_ms,
        config,
        writer_workers,
    )?;
    let symbol_bytes =
        write_symbol_index(workspace_root, &symbols, target_built_at_unix_ms, config)?;
    let mut summary = commit_graph_relation_generation(pending)?;
    summary.file_count = symbols
        .iter()
        .map(|symbol| symbol.rel_path.as_str())
        .collect::<HashSet<_>>()
        .len();
    summary.symbol_count = symbols.len();
    summary.bytes = summary.bytes.saturating_add(symbol_bytes);
    Ok(summary)
}

fn stable_symbol_ids_for_changed_files(
    symbols: &[GraphSymbol],
    changed_uris: &HashSet<String>,
    changed_rel_paths: &HashSet<String>,
) -> HashMap<String, String> {
    let mut ids = HashMap::new();
    let mut duplicate_keys = HashSet::new();
    for symbol in symbols {
        if !changed_uris.contains(&symbol.uri) && !changed_rel_paths.contains(&symbol.rel_path) {
            continue;
        }
        let key = stable_symbol_key(&symbol.rel_path, &symbol.qualified_name, &symbol.kind);
        if ids.insert(key.clone(), symbol.id.clone()).is_some() {
            duplicate_keys.insert(key);
        }
    }
    for key in duplicate_keys {
        ids.remove(&key);
    }
    ids
}

fn restore_stable_symbol_ids(
    files: &mut [NativeGraphFile],
    old_symbol_ids: &HashMap<String, String>,
) {
    if old_symbol_ids.is_empty() {
        return;
    }
    let mut used_keys = HashSet::new();
    for file in files {
        for symbol in &mut file.symbols {
            let key = stable_symbol_key(&symbol.rel_path, &symbol.qualified_name, &symbol.kind);
            if !used_keys.insert(key.clone()) {
                continue;
            }
            if let Some(old_id) = old_symbol_ids.get(&key) {
                symbol.id = old_id.clone();
            }
        }
    }
}

fn stable_symbol_key(rel_path: &str, qualified_name: &str, kind: &str) -> String {
    format!("{rel_path}\u{0}{qualified_name}\u{0}{kind}")
}

#[derive(Debug)]
struct SerializedGraphRecord {
    symbol_len: u32,
    refs_len: u32,
    ref_count: u32,
    bytes: Vec<u8>,
}

fn serialize_graph_records_parallel(
    groups: Vec<(String, Vec<GraphReference>)>,
    worker_count: usize,
) -> io::Result<Vec<SerializedGraphRecord>> {
    let total = groups.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let workers = effective_graph_worker_count(worker_count, total);
    if workers <= 1 || total <= 1 {
        return groups
            .into_iter()
            .map(|(symbol_id, refs)| serialize_graph_record(symbol_id, refs))
            .collect();
    }
    let chunk_size = total.div_ceil(workers);
    let mut handles = Vec::new();
    let mut iter = groups.into_iter().enumerate();
    loop {
        let chunk: Vec<(usize, (String, Vec<GraphReference>))> =
            iter.by_ref().take(chunk_size).collect();
        if chunk.is_empty() {
            break;
        }
        handles.push(thread::spawn(
            move || -> io::Result<Vec<(usize, SerializedGraphRecord)>> {
                let mut out = Vec::with_capacity(chunk.len());
                for (idx, (symbol_id, refs)) in chunk {
                    out.push((idx, serialize_graph_record(symbol_id, refs)?));
                }
                Ok(out)
            },
        ));
    }
    let mut ordered: Vec<Option<SerializedGraphRecord>> =
        std::iter::repeat_with(|| None).take(total).collect();
    for handle in handles {
        let records = handle
            .join()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "graph writer worker panicked"))??;
        for (idx, record) in records {
            ordered[idx] = Some(record);
        }
    }
    ordered
        .into_iter()
        .map(|record| {
            record.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Other,
                    "graph writer worker did not return every record",
                )
            })
        })
        .collect()
}

fn serialize_graph_record(
    symbol_id: String,
    mut refs: Vec<GraphReference>,
) -> io::Result<SerializedGraphRecord> {
    refs.sort_by(|a, b| {
        a.rel_path
            .cmp(&b.rel_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_column.cmp(&b.start_column))
            .then(a.name.cmp(&b.name))
    });
    refs.dedup_by(|a, b| {
        a.uri == b.uri && a.start_line == b.start_line && a.start_column == b.start_column
    });
    let ref_count = checked_u32(refs.len(), "reference count")?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(symbol_id.as_bytes());
    let symbol_len = checked_u32(symbol_id.len(), "symbol length")?;
    let refs_offset = bytes.len();
    put_u32(&mut bytes, ref_count);
    for reference in refs {
        put_string(&mut bytes, &reference.name)?;
        put_string(&mut bytes, &reference.raw_text)?;
        put_string(&mut bytes, &reference.uri)?;
        put_string(&mut bytes, &reference.rel_path)?;
        put_u32(&mut bytes, reference.start_line);
        put_u32(&mut bytes, reference.start_column);
        put_u32(&mut bytes, reference.end_line);
        put_u32(&mut bytes, reference.end_column);
        put_string(
            &mut bytes,
            reference.enclosing_symbol_id.as_deref().unwrap_or(""),
        )?;
    }
    let refs_len = checked_u32(bytes.len() - refs_offset, "reference payload length")?;
    Ok(SerializedGraphRecord {
        symbol_len,
        refs_len,
        ref_count,
        bytes,
    })
}

pub fn index_graph_from_references(
    workspace_root: &Path,
    references: Vec<(String, GraphReference)>,
    built_at_unix_ms: u64,
    config: &EngineConfig,
) -> io::Result<GraphIndexSummary> {
    let workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    index_graph_from_references_with_workers(
        workspace_root,
        references,
        built_at_unix_ms,
        config,
        workers,
    )
}

fn index_graph_from_references_with_workers(
    workspace_root: &Path,
    references: Vec<(String, GraphReference)>,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    worker_count: usize,
) -> io::Result<GraphIndexSummary> {
    let pending = prepare_graph_relation_generation(
        workspace_root,
        references,
        built_at_unix_ms,
        config,
        worker_count,
    )?;
    commit_graph_relation_generation(pending)
}

fn prepare_graph_relation_generation(
    workspace_root: &Path,
    references: Vec<(String, GraphReference)>,
    built_at_unix_ms: u64,
    config: &EngineConfig,
    worker_count: usize,
) -> io::Result<PendingGraphRelationGeneration> {
    let layout_root = config.index_root(workspace_root);
    fs::create_dir_all(&layout_root)?;
    let mut grouped: BTreeMap<String, Vec<GraphReference>> = BTreeMap::new();
    let mut rel_paths = BTreeSet::new();
    for (symbol_id, reference) in references {
        rel_paths.insert(reference.rel_path.clone());
        grouped.entry(symbol_id).or_default().push(reference);
    }
    let symbol_count = grouped.len();
    let shard_count = graph_relation_shard_count(worker_count, symbol_count);
    let generation = next_graph_relation_generation(&layout_root, config, workspace_root);
    let shard_summaries = write_graph_relation_shards_parallel(
        &layout_root,
        grouped,
        built_at_unix_ms,
        generation,
        shard_count,
        worker_count,
    )?;
    let indexed_at_unix_secs = unix_secs_now();
    let reference_count: usize = shard_summaries
        .iter()
        .map(|summary| summary.reference_count)
        .sum();
    let byte_count: u64 = shard_summaries.iter().map(|summary| summary.bytes).sum();
    let manifest_path = layout_root.join(GRAPH_MANIFEST_NAME);
    let manifest = graph_relation_manifest_json(
        workspace_root,
        &manifest_path,
        indexed_at_unix_secs,
        built_at_unix_ms,
        generation,
        rel_paths.len(),
        symbol_count,
        reference_count,
        byte_count,
        &shard_summaries,
    )?;
    let summary = GraphIndexSummary {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_path: manifest_path.to_string_lossy().into_owned(),
        indexed_at_unix_secs,
        built_at_unix_ms,
        file_count: rel_paths.len(),
        symbol_count,
        reference_count,
        bytes: byte_count,
    };
    Ok(PendingGraphRelationGeneration {
        summary,
        manifest_path,
        manifest,
        generation,
    })
}

fn commit_graph_relation_generation(
    pending: PendingGraphRelationGeneration,
) -> io::Result<GraphIndexSummary> {
    write_atomically(&pending.manifest_path, pending.manifest.as_bytes())?;
    if let Some(layout_root) = pending.manifest_path.parent() {
        let _ = cleanup_stale_graph_relation_files(
            layout_root,
            pending.generation,
            GRAPH_RELATION_STALE_TTL_SECS,
        );
    }
    Ok(pending.summary)
}

fn graph_relation_manifest_json(
    workspace_root: &Path,
    manifest_path: &Path,
    indexed_at_unix_secs: u64,
    built_at_unix_ms: u64,
    generation: u64,
    file_count: usize,
    symbol_count: usize,
    reference_count: usize,
    byte_count: u64,
    shard_summaries: &[GraphRelationShardSummary],
) -> io::Result<String> {
    let mut shards_json = String::new();
    for (idx, shard) in shard_summaries.iter().enumerate() {
        if idx > 0 {
            shards_json.push(',');
        }
        shards_json.push_str(&format!(
            "{{\"id\":{},\"path\":{},\"symbolCount\":{},\"referenceCount\":{},\"bytes\":{}}}",
            shard.shard_id,
            crate::protocol::json_string(&shard.file_name),
            shard.symbol_count,
            shard.reference_count,
            shard.bytes
        ));
    }
    Ok(format!(
        concat!(
            "{{\"engine\":\"zoek-rs\",\"type\":\"callgraph\",\"version\":{},",
            "\"workspaceRoot\":{},\"indexPath\":{},\"indexedAtUnixSecs\":{},",
            "\"builtAtUnixMs\":{},\"generation\":{},\"shardCount\":{},",
            "\"fileCount\":{},\"symbolCount\":{},\"referenceCount\":{},",
            "\"bytes\":{},\"builder\":\"rust-native\",\"relationShards\":[{}]}}"
        ),
        GRAPH_VERSION,
        crate::protocol::json_string(&workspace_root.to_string_lossy()),
        crate::protocol::json_string(&manifest_path.to_string_lossy()),
        indexed_at_unix_secs,
        built_at_unix_ms,
        generation,
        shard_summaries.len(),
        file_count,
        symbol_count,
        reference_count,
        byte_count,
        shards_json
    ))
}

fn graph_relation_shard_count(worker_count: usize, symbol_count: usize) -> usize {
    effective_graph_worker_count(worker_count, symbol_count.max(1))
}

fn graph_relation_shard_for_symbol(symbol_id: &str, shard_count: usize) -> usize {
    if shard_count <= 1 {
        0
    } else {
        (stable_graph_hash(symbol_id) as usize) % shard_count
    }
}

fn next_graph_relation_generation(
    layout_root: &Path,
    config: &EngineConfig,
    workspace_root: &Path,
) -> u64 {
    let now = unix_millis_now();
    match read_graph_relation_manifest(workspace_root, config) {
        Ok(Some(manifest)) => now.max(manifest.generation.saturating_add(1)),
        _ => {
            let mut generation = now;
            while graph_relation_shard_path(layout_root, generation, 0).exists() {
                generation = generation.saturating_add(1);
            }
            generation
        }
    }
}

fn write_graph_relation_shards_parallel(
    layout_root: &Path,
    grouped: BTreeMap<String, Vec<GraphReference>>,
    built_at_unix_ms: u64,
    generation: u64,
    shard_count: usize,
    worker_count: usize,
) -> io::Result<Vec<GraphRelationShardSummary>> {
    let shard_count = shard_count.max(1);
    let mut shard_groups: Vec<Vec<(String, Vec<GraphReference>)>> =
        (0..shard_count).map(|_| Vec::new()).collect();
    for (symbol_id, refs) in grouped {
        let shard_id = graph_relation_shard_for_symbol(&symbol_id, shard_count);
        shard_groups[shard_id].push((symbol_id, refs));
    }
    let workers = effective_graph_worker_count(worker_count, shard_count);
    if workers <= 1 || shard_count <= 1 {
        return shard_groups
            .into_iter()
            .enumerate()
            .map(|(shard_id, groups)| {
                write_graph_relation_shard(
                    layout_root,
                    generation,
                    shard_id,
                    groups,
                    built_at_unix_ms,
                )
            })
            .collect();
    }

    let chunk_size = shard_count.div_ceil(workers);
    let mut handles = Vec::new();
    let mut iter = shard_groups.into_iter().enumerate();
    loop {
        let chunk: Vec<(usize, Vec<(String, Vec<GraphReference>)>)> =
            iter.by_ref().take(chunk_size).collect();
        if chunk.is_empty() {
            break;
        }
        let layout_root = layout_root.to_path_buf();
        handles.push(thread::spawn(
            move || -> io::Result<Vec<(usize, GraphRelationShardSummary)>> {
                let mut out = Vec::with_capacity(chunk.len());
                for (shard_id, groups) in chunk {
                    let summary = write_graph_relation_shard(
                        &layout_root,
                        generation,
                        shard_id,
                        groups,
                        built_at_unix_ms,
                    )?;
                    out.push((shard_id, summary));
                }
                Ok(out)
            },
        ));
    }

    let mut ordered: Vec<Option<GraphRelationShardSummary>> =
        std::iter::repeat_with(|| None).take(shard_count).collect();
    for handle in handles {
        let summaries = handle
            .join()
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "graph shard writer panicked"))??;
        for (shard_id, summary) in summaries {
            ordered[shard_id] = Some(summary);
        }
    }
    ordered
        .into_iter()
        .map(|summary| {
            summary.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Other,
                    "graph shard writer did not return every shard",
                )
            })
        })
        .collect()
}

fn write_graph_relation_shard(
    layout_root: &Path,
    generation: u64,
    shard_id: usize,
    groups: Vec<(String, Vec<GraphReference>)>,
    built_at_unix_ms: u64,
) -> io::Result<GraphRelationShardSummary> {
    let file_name = graph_relation_shard_file_name(generation, shard_id);
    let path = layout_root.join(&file_name);
    let (bytes, symbol_count, reference_count) =
        build_graph_relation_index_bytes(groups, built_at_unix_ms)?;
    write_atomically(&path, &bytes)?;
    Ok(GraphRelationShardSummary {
        shard_id,
        file_name,
        symbol_count,
        reference_count,
        bytes: bytes.len() as u64,
    })
}

fn cleanup_stale_graph_relation_files(
    layout_root: &Path,
    current_generation: u64,
    ttl_secs: u64,
) -> io::Result<Vec<PathBuf>> {
    if !layout_root.exists() {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for entry in fs::read_dir(layout_root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_legacy_relation = name.as_ref() == GRAPH_FILE_NAME;
        let shard_generation = parse_graph_relation_shard_generation(&name);
        if !is_legacy_relation && shard_generation.is_none() {
            continue;
        }
        let is_tmp = name.ends_with(".tmp");
        if shard_generation == Some(current_generation) && !is_tmp {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !metadata_is_older_than_ttl(&metadata, ttl_secs) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    removed.sort();
    Ok(removed)
}

fn parse_graph_relation_shard_generation(name: &str) -> Option<u64> {
    let rest = name.strip_prefix(GRAPH_RELATION_SHARD_PREFIX)?;
    let rest = rest
        .strip_suffix(GRAPH_RELATION_SHARD_SUFFIX)
        .or_else(|| rest.strip_suffix(&format!("{GRAPH_RELATION_SHARD_SUFFIX}.tmp")))?;
    let (generation, shard_id) = rest.rsplit_once('-')?;
    if shard_id.is_empty() || !shard_id.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    generation.parse().ok()
}

fn metadata_is_older_than_ttl(metadata: &fs::Metadata, ttl_secs: u64) -> bool {
    match metadata.modified().and_then(|modified| {
        modified
            .elapsed()
            .map_err(|err| io::Error::new(io::ErrorKind::Other, err))
    }) {
        Ok(age) => age.as_secs() >= ttl_secs,
        Err(_) => false,
    }
}

fn build_graph_relation_index_bytes(
    groups: Vec<(String, Vec<GraphReference>)>,
    built_at_unix_ms: u64,
) -> io::Result<(Vec<u8>, usize, usize)> {
    let records = serialize_graph_records_parallel(groups, 1)?;
    let mut entries: Vec<IndexEntry> = Vec::with_capacity(records.len());
    let mut reference_count = 0usize;
    let mut record_data_len = 0usize;
    let mut data_offset_cursor = 0u64;
    for record in &records {
        entries.push(IndexEntry {
            symbol_offset: data_offset_cursor,
            symbol_len: record.symbol_len,
            refs_offset: data_offset_cursor + record.symbol_len as u64,
            refs_len: record.refs_len,
            ref_count: record.ref_count,
        });
        reference_count += record.ref_count as usize;
        record_data_len += record.bytes.len();
        data_offset_cursor += record.bytes.len() as u64;
    }

    let index_offset = GRAPH_HEADER_SIZE as u64;
    let data_offset = GRAPH_HEADER_SIZE as u64 + (entries.len() * GRAPH_INDEX_ENTRY_SIZE) as u64;
    let mut bytes = Vec::with_capacity(data_offset as usize + record_data_len);
    bytes.extend_from_slice(GRAPH_MAGIC);
    put_u32(&mut bytes, GRAPH_VERSION);
    put_u32(
        &mut bytes,
        checked_u32(entries.len(), "graph index entry count")?,
    );
    put_u64(&mut bytes, built_at_unix_ms);
    put_u64(&mut bytes, index_offset);
    put_u64(&mut bytes, data_offset);
    for entry in &entries {
        put_u64(&mut bytes, entry.symbol_offset);
        put_u32(&mut bytes, entry.symbol_len);
        put_u64(&mut bytes, entry.refs_offset);
        put_u32(&mut bytes, entry.refs_len);
        put_u32(&mut bytes, entry.ref_count);
    }
    for record in records {
        bytes.extend_from_slice(&record.bytes);
    }
    Ok((bytes, entries.len(), reference_count))
}

fn write_symbol_index(
    workspace_root: &Path,
    symbols: &[NativeGraphSymbol],
    built_at_unix_ms: u64,
    config: &EngineConfig,
) -> io::Result<u64> {
    let layout_root = config.index_root(workspace_root);
    fs::create_dir_all(&layout_root)?;
    let mut entries: Vec<SymbolEntry> = Vec::with_capacity(symbols.len());
    let mut data: Vec<u8> = Vec::new();
    let mut sorted: Vec<&NativeGraphSymbol> = symbols.iter().collect();
    sorted.sort_by(|a, b| {
        a.rel_path
            .cmp(&b.rel_path)
            .then(a.start_line.cmp(&b.start_line))
            .then(a.start_column.cmp(&b.start_column))
            .then(a.id.cmp(&b.id))
    });
    for symbol in sorted {
        let graph_symbol = native_symbol_to_graph_symbol(symbol, None);
        let record_offset = data.len() as u64;
        write_graph_symbol_record(&mut data, &graph_symbol)?;
        let record_len = checked_u32(data.len() - record_offset as usize, "symbol record length")?;
        entries.push(SymbolEntry {
            record_offset,
            record_len,
        });
    }

    let index_offset = GRAPH_SYMBOL_HEADER_SIZE as u64;
    let data_offset =
        GRAPH_SYMBOL_HEADER_SIZE as u64 + (entries.len() * GRAPH_SYMBOL_INDEX_ENTRY_SIZE) as u64;
    let mut bytes = Vec::with_capacity(data_offset as usize + data.len());
    bytes.extend_from_slice(GRAPH_SYMBOL_MAGIC);
    put_u32(&mut bytes, GRAPH_VERSION);
    put_u32(
        &mut bytes,
        checked_u32(entries.len(), "symbol index entry count")?,
    );
    put_u64(&mut bytes, built_at_unix_ms);
    put_u64(&mut bytes, index_offset);
    put_u64(&mut bytes, data_offset);
    for entry in &entries {
        put_u64(&mut bytes, entry.record_offset);
        put_u32(&mut bytes, entry.record_len);
    }
    bytes.extend_from_slice(&data);
    let byte_len = bytes.len() as u64;
    write_atomically(&layout_root.join(GRAPH_SYMBOL_FILE_NAME), &bytes)?;
    Ok(byte_len)
}

pub fn query_graph_symbols(
    workspace_root: &Path,
    query: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphSymbolQueryResult>> {
    let Some((built_at_unix_ms, symbols)) = read_symbol_index(workspace_root, config)? else {
        return Ok(None);
    };
    let normalized = query.trim();
    let lower = normalized.to_ascii_lowercase();
    let mut scored: Vec<(GraphSymbol, i32)> = symbols
        .into_iter()
        .filter_map(|symbol| {
            let score = if normalized.is_empty() {
                1
            } else {
                score_graph_symbol_match(&symbol, normalized, &lower)
            };
            if score > 0 {
                Some((symbol, score))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by(|(a, a_score), (b, b_score)| {
        b_score
            .cmp(a_score)
            .then(a.qualified_name.cmp(&b.qualified_name))
            .then(a.rel_path.cmp(&b.rel_path))
            .then(a.start_line.cmp(&b.start_line))
    });
    let total_symbols = scored.len();
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        total_symbols,
        symbols: scored
            .into_iter()
            .take(limit)
            .map(|(symbol, _)| symbol)
            .collect(),
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
    let Some((built_at_unix_ms, symbols)) = read_symbol_index(workspace_root, config)? else {
        return Ok(None);
    };
    let mut implementation_index = GraphImplementationIndex::new(&symbols);
    let mut relation_reader = GraphRelationReader::open(workspace_root, config)?;
    let mut matched = Vec::new();
    for (idx, symbol) in symbols
        .iter()
        .enumerate()
        .filter(|(_, symbol)| symbol.uri == uri)
    {
        if let Some(start) = start_line {
            if symbol.start_line < start {
                continue;
            }
        }
        if let Some(end) = end_line {
            if symbol.start_line >= end {
                continue;
            }
        }
        let mut symbol = symbol.clone();
        symbol.usage_count = Some(if let Some(reader) = relation_reader.as_mut() {
            reader.reference_count(&symbol.id)?
        } else {
            0
        });
        symbol.implementation_count =
            Some(implementation_index.implementation_count_for_symbol_idx(idx));
        matched.push(symbol);
    }
    matched.sort_by(|a, b| {
        a.start_line
            .cmp(&b.start_line)
            .then(a.start_column.cmp(&b.start_column))
            .then(a.qualified_name.cmp(&b.qualified_name))
    });
    let total_symbols = matched.len();
    Ok(Some(GraphSymbolQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        built_at_unix_ms,
        total_symbols,
        symbols: matched.into_iter().take(limit).collect(),
    }))
}

pub fn query_graph(
    workspace_root: &Path,
    symbol_id: &str,
    limit: usize,
    config: &EngineConfig,
) -> io::Result<Option<GraphQueryResult>> {
    if let Some(manifest) = read_graph_relation_manifest(workspace_root, config)? {
        let layout_root = config.index_root(workspace_root);
        let shard_id = graph_relation_shard_for_symbol(symbol_id, manifest.shard_count);
        let shard_path = graph_relation_shard_path(&layout_root, manifest.generation, shard_id);
        let bytes = fs::read(&shard_path)?;
        let header = read_header(&bytes)?;
        let Some(entry) = find_entry(&bytes, &header, symbol_id)? else {
            return Ok(Some(GraphQueryResult {
                workspace_root: workspace_root.to_string_lossy().into_owned(),
                symbol_id: symbol_id.to_string(),
                built_at_unix_ms: header.built_at_unix_ms,
                total_references: 0,
                references: Vec::new(),
            }));
        };
        let references = read_references(&bytes, &header, &entry, limit)?;
        return Ok(Some(GraphQueryResult {
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            symbol_id: symbol_id.to_string(),
            built_at_unix_ms: header.built_at_unix_ms,
            total_references: entry.ref_count as usize,
            references,
        }));
    }
    let index_path = graph_index_path(workspace_root, config);
    if !index_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&index_path)?;
    let header = read_header(&bytes)?;
    let Some(entry) = find_entry(&bytes, &header, symbol_id)? else {
        return Ok(Some(GraphQueryResult {
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            symbol_id: symbol_id.to_string(),
            built_at_unix_ms: header.built_at_unix_ms,
            total_references: 0,
            references: Vec::new(),
        }));
    };
    let references = read_references(&bytes, &header, &entry, limit)?;
    Ok(Some(GraphQueryResult {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        symbol_id: symbol_id.to_string(),
        built_at_unix_ms: header.built_at_unix_ms,
        total_references: entry.ref_count as usize,
        references,
    }))
}

struct GraphRelationReader {
    layout_root: PathBuf,
    kind: GraphRelationReaderKind,
}

enum GraphRelationReaderKind {
    Single {
        bytes: Vec<u8>,
        header: Header,
    },
    Sharded {
        manifest: GraphRelationManifest,
        cache: HashMap<usize, (Vec<u8>, Header)>,
    },
}

impl GraphRelationReader {
    fn open(workspace_root: &Path, config: &EngineConfig) -> io::Result<Option<Self>> {
        let layout_root = config.index_root(workspace_root);
        if let Some(manifest) = read_graph_relation_manifest(workspace_root, config)? {
            return Ok(Some(Self {
                layout_root,
                kind: GraphRelationReaderKind::Sharded {
                    manifest,
                    cache: HashMap::new(),
                },
            }));
        }
        let index_path = graph_index_path(workspace_root, config);
        if !index_path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(index_path)?;
        let header = read_header(&bytes)?;
        Ok(Some(Self {
            layout_root,
            kind: GraphRelationReaderKind::Single { bytes, header },
        }))
    }

    fn reference_count(&mut self, symbol_id: &str) -> io::Result<usize> {
        match &mut self.kind {
            GraphRelationReaderKind::Single { bytes, header } => {
                Ok(find_entry(bytes, header, symbol_id)?
                    .map(|entry| entry.ref_count as usize)
                    .unwrap_or(0))
            }
            GraphRelationReaderKind::Sharded { manifest, cache } => {
                let shard_id = graph_relation_shard_for_symbol(symbol_id, manifest.shard_count);
                if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry(shard_id) {
                    let path =
                        graph_relation_shard_path(&self.layout_root, manifest.generation, shard_id);
                    let bytes = fs::read(path)?;
                    let header = read_header(&bytes)?;
                    entry.insert((bytes, header));
                }
                let (bytes, header) = cache.get(&shard_id).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::Other, "graph relation shard cache missing")
                })?;
                Ok(find_entry(bytes, header, symbol_id)?
                    .map(|entry| entry.ref_count as usize)
                    .unwrap_or(0))
            }
        }
    }
}

struct GraphImplementationIndex<'a> {
    symbols: &'a [GraphSymbol],
    type_by_name: HashMap<String, Vec<usize>>,
    members_by_container_name: HashMap<String, Vec<usize>>,
    children_by_parent: HashMap<String, Vec<usize>>,
    descendants_by_type_idx: HashMap<usize, Vec<usize>>,
}

impl<'a> GraphImplementationIndex<'a> {
    fn new(symbols: &'a [GraphSymbol]) -> Self {
        let mut type_by_name: HashMap<String, Vec<usize>> = HashMap::new();
        let mut members_by_container_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (idx, symbol) in symbols.iter().enumerate() {
            if is_type_reference_symbol_kind(&symbol.kind) {
                type_by_name
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(idx);
                type_by_name
                    .entry(symbol.qualified_name.clone())
                    .or_default()
                    .push(idx);
            }
            if let Some(container_name) = symbol.container_name.as_ref() {
                members_by_container_name
                    .entry(member_lookup_key(container_name, &symbol.name))
                    .or_default()
                    .push(idx);
            }
        }
        let mut children_by_parent: HashMap<String, Vec<usize>> = HashMap::new();
        for (child_idx, symbol) in symbols.iter().enumerate() {
            if !is_type_reference_symbol_kind(&symbol.kind) {
                continue;
            }
            for parent_name in symbol
                .extends_names
                .iter()
                .chain(symbol.implements_names.iter())
            {
                if let Some(parent_idx) =
                    choose_graph_type_symbol_index_by_name(parent_name, &type_by_name, symbols)
                {
                    children_by_parent
                        .entry(symbols[parent_idx].id.clone())
                        .or_default()
                        .push(child_idx);
                }
            }
        }
        Self {
            symbols,
            type_by_name,
            members_by_container_name,
            children_by_parent,
            descendants_by_type_idx: HashMap::new(),
        }
    }

    fn implementation_count_for_symbol_idx(&mut self, idx: usize) -> usize {
        let symbol_kind = self.symbols[idx].kind.as_str();
        let framework_count = framework_impl_marker_count(&self.symbols[idx]);
        if is_type_reference_symbol_kind(symbol_kind) {
            return self
                .descendant_type_indices_cached(idx)
                .len()
                .saturating_add(framework_count);
        }
        if !matches!(symbol_kind, "function" | "method" | "constructor") {
            return framework_count;
        }
        let mut count = framework_count;
        let symbol_id = self.symbols[idx].id.clone();
        let symbol_name = self.symbols[idx].name.clone();
        let Some(container_name) = self.symbols[idx].container_name.clone() else {
            return count;
        };
        let Some(container_idx) = choose_graph_type_symbol_index_by_name(
            &container_name,
            &self.type_by_name,
            self.symbols,
        ) else {
            return count;
        };
        let mut impl_ids = HashSet::new();
        for child_idx in self.descendant_type_indices_cached(container_idx) {
            if let Some(methods) = self.members_by_container_name.get(&member_lookup_key(
                &self.symbols[child_idx].qualified_name,
                &symbol_name,
            )) {
                for method_idx in methods {
                    if self.symbols[*method_idx].id != symbol_id
                        && matches!(
                            self.symbols[*method_idx].kind.as_str(),
                            "method" | "constructor"
                        )
                    {
                        impl_ids.insert(self.symbols[*method_idx].id.clone());
                    }
                }
            }
        }
        count = count.saturating_add(impl_ids.len());
        count
    }

    fn descendant_type_indices_cached(&mut self, type_idx: usize) -> Vec<usize> {
        if let Some(cached) = self.descendants_by_type_idx.get(&type_idx) {
            return cached.clone();
        }
        let descendants = descendant_type_indices(type_idx, &self.children_by_parent, self.symbols);
        self.descendants_by_type_idx
            .insert(type_idx, descendants.clone());
        descendants
    }
}

fn framework_impl_marker_count(symbol: &GraphSymbol) -> usize {
    symbol
        .implements_names
        .iter()
        .filter(|name| name.starts_with(FRAMEWORK_IMPL_PREFIX))
        .count()
}

fn descendant_type_indices(
    type_idx: usize,
    children_by_parent: &HashMap<String, Vec<usize>>,
    symbols: &[GraphSymbol],
) -> Vec<usize> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue: VecDeque<usize> = children_by_parent
        .get(&symbols[type_idx].id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    while let Some(child_idx) = queue.pop_front() {
        if !seen.insert(symbols[child_idx].id.clone()) {
            continue;
        }
        out.push(child_idx);
        if let Some(grandchildren) = children_by_parent.get(&symbols[child_idx].id) {
            queue.extend(grandchildren.iter().copied());
        }
    }
    out
}

fn choose_graph_type_symbol_index_by_name(
    name: &str,
    type_by_name: &HashMap<String, Vec<usize>>,
    symbols: &[GraphSymbol],
) -> Option<usize> {
    let mut candidates = Vec::new();
    for key in [name, last_qualified_part(name)] {
        if let Some(found) = type_by_name.get(key) {
            candidates.extend(found.iter().copied());
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates
        .iter()
        .copied()
        .find(|idx| symbols[*idx].qualified_name == name)
        .or_else(|| {
            let simple = last_qualified_part(name);
            let simple_matches: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|idx| symbols[*idx].name == simple)
                .collect();
            if simple_matches.len() == 1 {
                Some(simple_matches[0])
            } else {
                candidates.first().copied()
            }
        })
}

#[derive(Clone, Copy, Debug)]
struct Header {
    record_count: usize,
    built_at_unix_ms: u64,
    index_offset: usize,
    data_offset: usize,
}

#[derive(Clone, Copy, Debug)]
struct SymbolHeader {
    record_count: usize,
    built_at_unix_ms: u64,
    index_offset: usize,
    data_offset: usize,
}

fn flush_record(
    entries: &mut Vec<IndexEntry>,
    data: &mut Vec<u8>,
    symbol_id: Option<String>,
    refs: &mut Vec<GraphReference>,
) -> io::Result<()> {
    let Some(symbol_id) = symbol_id else {
        return Ok(());
    };
    if refs.is_empty() {
        return Ok(());
    }
    let ref_count = checked_u32(refs.len(), "reference count")?;
    let symbol_offset = data.len() as u64;
    data.extend_from_slice(symbol_id.as_bytes());
    let symbol_len = checked_u32(symbol_id.len(), "symbol length")?;
    let refs_offset = data.len() as u64;
    put_u32(data, ref_count);
    for reference in refs.drain(..) {
        put_string(data, &reference.name)?;
        put_string(data, &reference.raw_text)?;
        put_string(data, &reference.uri)?;
        put_string(data, &reference.rel_path)?;
        put_u32(data, reference.start_line);
        put_u32(data, reference.start_column);
        put_u32(data, reference.end_line);
        put_u32(data, reference.end_column);
        put_string(data, reference.enclosing_symbol_id.as_deref().unwrap_or(""))?;
    }
    let refs_len = checked_u32(
        data.len() - refs_offset as usize,
        "reference payload length",
    )?;
    entries.push(IndexEntry {
        symbol_offset,
        symbol_len,
        refs_offset,
        refs_len,
        ref_count,
    });
    Ok(())
}

#[derive(Clone, Debug)]
struct NativeGraphSymbol {
    id: String,
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
    body_start_line: u32,
    body_start_column: u32,
    body_end_line: u32,
    body_end_column: u32,
    declaration_end_line: u32,
    declaration_end_column: u32,
    container_id: Option<String>,
    container_name: Option<String>,
    package_name: Option<String>,
    extends_names: Vec<String>,
    implements_names: Vec<String>,
}

#[derive(Clone, Debug)]
struct NativeGraphFile {
    rel_path: String,
    uri: String,
    text: String,
    symbols: Vec<NativeGraphSymbol>,
    imports: HashMap<String, Vec<ImportTarget>>,
}

#[derive(Clone, Copy, Debug)]
struct DeclarationRange {
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Clone, Debug, Default)]
struct GraphResolutionMaps {
    by_name: HashMap<String, Vec<usize>>,
    by_file_name: HashMap<String, Vec<usize>>,
    type_by_name: HashMap<String, Vec<usize>>,
    members_by_container_name: HashMap<String, Vec<usize>>,
    declaration_ranges_by_file: HashMap<String, Vec<DeclarationRange>>,
}

#[derive(Clone, Debug)]
struct ImportTarget {
    imported_name: String,
    target_rel_path: String,
}

#[derive(Clone, Copy, Debug, Default)]
struct IdentifierLexState {
    in_block_comment: bool,
    triple_quote: Option<char>,
    quote: Option<char>,
    template_expr_depth: usize,
    escaped: bool,
}

fn discover_graph_source_files<F>(
    workspace_root: &Path,
    dir: &Path,
    config: &EngineConfig,
    out: &mut Vec<PathBuf>,
    visited_entries: &mut usize,
    progress: &mut F,
) -> io::Result<()>
where
    F: FnMut(GraphRebuildProgress),
{
    for item in fs::read_dir(dir)? {
        let item = item?;
        *visited_entries += 1;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let name = item.file_name();
            let name = name.to_string_lossy();
            if config.is_excluded_dir_name(&name) || path == config.index_root(workspace_root) {
                continue;
            }
            if *visited_entries == 1 || *visited_entries % 4096 == 0 {
                progress(GraphRebuildProgress {
                    stage: "discovering",
                    current: *visited_entries,
                    total: 0,
                    message: format!(
                        "rust graph scanned {} filesystem entries; found {} source files",
                        *visited_entries,
                        out.len()
                    ),
                });
            }
            discover_graph_source_files(
                workspace_root,
                &path,
                config,
                out,
                visited_entries,
                progress,
            )?;
            continue;
        }
        if metadata.is_file() && is_graph_source_path(&path) {
            out.push(path);
        }
        if *visited_entries == 1 || *visited_entries % 4096 == 0 {
            progress(GraphRebuildProgress {
                stage: "discovering",
                current: *visited_entries,
                total: 0,
                message: format!(
                    "rust graph scanned {} filesystem entries; found {} source files",
                    *visited_entries,
                    out.len()
                ),
            });
        }
    }
    Ok(())
}

fn is_graph_source_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if name.ends_with(".d.ts") {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some(
            "py" | "java"
                | "kt"
                | "kts"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "graphql"
                | "gql",
        )
    )
}

fn parse_graph_source_file(
    workspace_root: &Path,
    path: &Path,
    config: &EngineConfig,
) -> io::Result<Option<NativeGraphFile>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > config.max_file_size_bytes || config.is_binary_extension(path) {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    if looks_binary_bytes(&bytes) {
        return Ok(None);
    }
    let (text, _) = decode_bytes(&bytes);
    let rel_path = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(path));
    let uri = file_uri(path);
    let language = language_for_path(path);
    let symbols = parse_native_graph_symbols(&text, &language, &uri, &rel_path);
    let imports = if is_ts_like_language(&language) {
        parse_ts_imports(&text, &rel_path)
    } else if language == "python" {
        parse_python_imports(&text, &rel_path)
    } else {
        HashMap::new()
    };
    Ok(Some(NativeGraphFile {
        rel_path,
        uri,
        text,
        symbols,
        imports,
    }))
}

fn parse_graph_source_files_parallel<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    files: Vec<PathBuf>,
    worker_count: usize,
    progress: &mut F,
) -> io::Result<Vec<NativeGraphFile>>
where
    F: FnMut(GraphRebuildProgress),
{
    let total = files.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let queue: VecDeque<(usize, PathBuf)> = files.into_iter().enumerate().collect();
    let queue = Arc::new(Mutex::new(queue));
    let workspace_root = Arc::new(workspace_root.to_path_buf());
    let config = Arc::new(config.clone());
    let (tx, rx) = mpsc::channel();
    let mut handles = Vec::new();
    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let workspace_root = Arc::clone(&workspace_root);
        let config = Arc::clone(&config);
        let tx = tx.clone();
        handles.push(thread::spawn(move || loop {
            let Some((idx, path)) = queue.lock().ok().and_then(|mut queue| queue.pop_front())
            else {
                break;
            };
            let parsed = parse_graph_source_file(workspace_root.as_path(), &path, config.as_ref());
            if tx.send((idx, parsed)).is_err() {
                break;
            }
        }));
    }
    drop(tx);

    let mut parsed_by_index: Vec<Option<NativeGraphFile>> = (0..total).map(|_| None).collect();
    let mut processed = 0usize;
    let mut first_error: Option<io::Error> = None;
    for (idx, parsed) in rx {
        processed += 1;
        match parsed {
            Ok(Some(file)) => parsed_by_index[idx] = Some(file),
            Ok(None) => {}
            Err(err) => {
                if first_error.is_none() {
                    first_error = Some(err);
                }
            }
        }
        if processed == 1 || processed % 256 == 0 || processed == total {
            progress(GraphRebuildProgress {
                stage: "parsing",
                current: processed,
                total,
                message: format!(
                    "rust graph parsed {processed}/{total} with {worker_count} workers"
                ),
            });
        }
    }
    for handle in handles {
        if handle.join().is_err() && first_error.is_none() {
            first_error = Some(io::Error::new(
                io::ErrorKind::Other,
                "rust graph parse worker panicked",
            ));
        }
    }
    if let Some(err) = first_error {
        return Err(err);
    }
    Ok(parsed_by_index.into_iter().flatten().collect())
}

fn parse_native_graph_symbols(
    text: &str,
    language: &str,
    uri: &str,
    rel_path: &str,
) -> Vec<NativeGraphSymbol> {
    match language {
        "python" => parse_python_graph_symbols(text, language, uri, rel_path),
        "graphql" => parse_graphql_graph_symbols(text, language, uri, rel_path),
        _ => parse_brace_graph_symbols(text, language, uri, rel_path),
    }
}

fn parse_python_graph_symbols(
    text: &str,
    language: &str,
    uri: &str,
    rel_path: &str,
) -> Vec<NativeGraphSymbol> {
    let mut symbols = Vec::new();
    let mut class_stack: Vec<(usize, String)> = Vec::new();
    let mut function_stack: Vec<usize> = Vec::new();
    let mut pending_decorators: Vec<String> = Vec::new();
    let mut code_state = IdentifierLexState::default();
    for (line_idx, line) in text.lines().enumerate() {
        let code_line = sanitize_code_line(line, &mut code_state);
        let indent = line
            .chars()
            .take_while(|ch| *ch == ' ' || *ch == '\t')
            .count();
        let trimmed = code_line.trim_start();
        while function_stack
            .last()
            .map(|function_indent| indent <= *function_indent && !trimmed.is_empty())
            .unwrap_or(false)
        {
            function_stack.pop();
        }
        while class_stack
            .last()
            .map(|(class_indent, _)| indent <= *class_indent && !trimmed.is_empty())
            .unwrap_or(false)
        {
            class_stack.pop();
        }
        if trimmed.starts_with('@') {
            if let Some(name) = decorator_name_from_line(trimmed) {
                pending_decorators.push(name);
            }
            continue;
        }
        if let Some(name) = identifier_after_keyword(trimmed, "class") {
            let column = find_column(line, &name);
            let qualified = name.clone();
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "class",
                &name,
                &qualified,
                line_idx,
                column,
                None,
                None,
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            );
            symbol.extends_names = python_class_bases_from_line(trimmed);
            symbol
                .implements_names
                .extend(framework_impl_markers_for_python_class(
                    &symbol.extends_names,
                    &pending_decorators,
                ));
            pending_decorators.clear();
            symbols.push(symbol);
            class_stack.push((indent, qualified));
            continue;
        }
        if let Some(name) = python_function_name_from_line(trimmed) {
            let column = find_column(line, &name);
            let qualified = class_stack
                .last()
                .map(|(_, class_name)| format!("{class_name}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = class_stack
                .last()
                .map(|(_, class_name)| class_name.as_str());
            let kind = if container_name.is_some() {
                "method"
            } else {
                "function"
            };
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                None,
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            );
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_decorators,
                    "python",
                    kind,
                ));
            pending_decorators.clear();
            symbols.push(symbol);
            function_stack.push(indent);
            continue;
        }
        if let Some((name, column, is_callable)) = python_assignment_symbol_from_line(
            &code_line,
            indent,
            class_stack
                .last()
                .map(|(class_indent, class_name)| (*class_indent, class_name.clone())),
            function_stack.last().copied(),
        ) {
            let container_name = python_assignment_container(&name, class_stack.last());
            let local_name = name.rsplit('.').next().unwrap_or(&name).to_string();
            let qualified = container_name
                .map(|container| format!("{container}.{local_name}"))
                .unwrap_or_else(|| local_name.clone());
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                if is_callable { "function" } else { "constant" },
                &local_name,
                &qualified,
                line_idx,
                column,
                container_name,
                None,
                line_idx as u32,
                column.saturating_add(local_name.len()) as u32,
            ));
            continue;
        }
        if let Some((name, column)) = uppercase_assignment(&code_line) {
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "constant",
                &name,
                &name,
                line_idx,
                column,
                None,
                None,
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            ));
        }
    }
    symbols
}

fn parse_graphql_graph_symbols(
    text: &str,
    language: &str,
    uri: &str,
    rel_path: &str,
) -> Vec<NativeGraphSymbol> {
    let mut symbols = Vec::new();
    let mut parent_stack: Vec<(i32, String, String)> = Vec::new();
    let mut brace_depth = 0i32;
    for (line_idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        while parent_stack
            .last()
            .map(|(depth, _, _)| brace_depth <= *depth && !trimmed.is_empty())
            .unwrap_or(false)
        {
            parent_stack.pop();
        }
        if let Some((name, kind)) = graphql_type_symbol_from_line(trimmed) {
            let column = find_column(line, &name);
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &name,
                line_idx,
                column,
                None,
                None,
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            );
            symbol.extends_names = graphql_type_relations_from_line(trimmed, &name);
            symbols.push(symbol);
            parent_stack.push((brace_depth, name, kind.to_string()));
        } else if let Some((field_name, column, return_type)) =
            graphql_field_symbol_from_line(trimmed, line)
        {
            if let Some((_, parent_name, parent_kind)) = parent_stack.last() {
                let qualified = format!("{parent_name}.{field_name}");
                let mut symbol = make_native_graph_symbol(
                    language,
                    uri,
                    rel_path,
                    if parent_kind == "enum" {
                        "constant"
                    } else {
                        "method"
                    },
                    &field_name,
                    &qualified,
                    line_idx,
                    column,
                    Some(parent_name),
                    None,
                    line_idx as u32,
                    column.saturating_add(field_name.len()) as u32,
                );
                if let Some(return_type) = return_type {
                    symbol.extends_names.push(return_type);
                }
                symbols.push(symbol);
            }
        } else if let Some((operation_name, column)) =
            graphql_operation_symbol_from_line(trimmed, line)
        {
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "function",
                &operation_name,
                &operation_name,
                line_idx,
                column,
                None,
                None,
                line_idx as u32,
                column.saturating_add(operation_name.len()) as u32,
            );
            symbol
                .implements_names
                .push(format!("{FRAMEWORK_IMPL_PREFIX}GraphQLOperation"));
            symbols.push(symbol);
        } else if let Some((fragment_name, type_name, column)) =
            graphql_fragment_symbol_from_line(trimmed, line)
        {
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "type",
                &fragment_name,
                &fragment_name,
                line_idx,
                column,
                None,
                None,
                line_idx as u32,
                column.saturating_add(fragment_name.len()) as u32,
            );
            symbol.extends_names.push(type_name);
            symbols.push(symbol);
        }
        brace_depth += line.matches('{').count() as i32;
        brace_depth -= line.matches('}').count() as i32;
        if brace_depth < 0 {
            brace_depth = 0;
        }
    }
    symbols
}

fn python_assignment_symbol_from_line(
    line: &str,
    indent: usize,
    class_scope: Option<(usize, String)>,
    function_scope: Option<usize>,
) -> Option<(String, usize, bool)> {
    let assignment = find_assignment_operator(line)?;
    let before = line.get(..assignment)?.trim();
    let after = line.get(assignment + 1..)?.trim_start();
    let is_lambda = after.starts_with("lambda ");
    let is_direct_class_body = class_scope
        .as_ref()
        .map(|(class_indent, _)| indent > *class_indent && function_scope.is_none())
        .unwrap_or(false);
    if before.starts_with("self.") || before.starts_with("cls.") {
        let name = before
            .split(':')
            .next()
            .unwrap_or(before)
            .trim()
            .to_string();
        let local = name
            .strip_prefix("self.")
            .or_else(|| name.strip_prefix("cls."))
            .unwrap_or("");
        if is_identifier(local) {
            let column = find_column(line, local);
            return Some((name, column, false));
        }
    }
    let candidate = before
        .split(':')
        .next()
        .unwrap_or(before)
        .trim()
        .trim_start_matches('*')
        .trim();
    if !is_identifier(candidate) {
        return None;
    }
    let top_level = class_scope.is_none() && function_scope.is_none();
    let annotated = before.contains(':');
    let uppercase_like = candidate.chars().any(|ch| ch.is_ascii_uppercase())
        && candidate
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_');
    if is_lambda || is_direct_class_body || top_level || annotated || uppercase_like {
        return Some((
            candidate.to_string(),
            find_column(line, candidate),
            is_lambda,
        ));
    }
    None
}

fn python_assignment_container<'a>(
    name: &str,
    class_scope: Option<&'a (usize, String)>,
) -> Option<&'a str> {
    if name.starts_with("self.") || name.starts_with("cls.") {
        return class_scope.map(|(_, class_name)| class_name.as_str());
    }
    class_scope.map(|(_, class_name)| class_name.as_str())
}

fn graphql_type_symbol_from_line(line: &str) -> Option<(String, &'static str)> {
    let mut rest = line.trim_start();
    if let Some(next) = strip_leading_word(rest, "extend") {
        rest = next.trim_start();
    }
    if let Some(next) = strip_leading_word(rest, "directive") {
        let next = next.trim_start();
        let next = next.strip_prefix('@').unwrap_or(next);
        let name: String = next
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if !name.is_empty() {
            return Some((name, "function"));
        }
    }
    for (keyword, kind) in [
        ("type", "type"),
        ("interface", "interface"),
        ("input", "type"),
        ("union", "type"),
        ("enum", "enum"),
        ("scalar", "constant"),
    ] {
        if let Some(name) = identifier_after_keyword(rest, keyword) {
            return Some((name.trim_start_matches('@').to_string(), kind));
        }
    }
    None
}

fn graphql_type_relations_from_line(line: &str, name: &str) -> Vec<String> {
    let tail = line
        .find(name)
        .and_then(|idx| line.get(idx + name.len()..))
        .unwrap_or(line);
    let implements = word_tail_until(tail, "implements", &["{", ";"])
        .map(parse_type_reference_list)
        .unwrap_or_default();
    if !implements.is_empty() {
        return implements;
    }
    if let Some((_, rhs)) = tail.split_once('=') {
        return parse_type_reference_list(rhs);
    }
    Vec::new()
}

fn graphql_field_symbol_from_line(
    trimmed: &str,
    original: &str,
) -> Option<(String, usize, Option<String>)> {
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with('}')
        || trimmed.starts_with("...")
        || trimmed.starts_with('@')
    {
        return None;
    }
    let name: String = trimmed
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.is_empty() || is_ignored_reference_identifier(&name) {
        return None;
    }
    let after = trimmed.get(name.len()..)?.trim_start();
    if after.starts_with(':') || after.starts_with('(') {
        let return_type = graphql_field_return_type(after);
        return Some((name.clone(), find_column(original, &name), return_type));
    }
    if after.is_empty() {
        return Some((name.clone(), find_column(original, &name), None));
    }
    None
}

fn graphql_field_return_type(after_field_name: &str) -> Option<String> {
    let after_colon = if after_field_name.starts_with(':') {
        after_field_name.trim_start_matches(':').trim_start()
    } else {
        let close = after_field_name.find(')')?;
        after_field_name
            .get(close + 1..)?
            .trim_start()
            .strip_prefix(':')?
            .trim_start()
    };
    let mut cleaned = after_colon.trim_start_matches('[').trim_start_matches('!');
    let name: String = cleaned
        .chars()
        .skip_while(|ch| *ch == '[' || *ch == '!')
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.is_empty() {
        cleaned = cleaned.trim_start_matches(']');
        let name: String = cleaned
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if name.is_empty() {
            return None;
        }
        return Some(name);
    }
    Some(name)
}

fn graphql_operation_symbol_from_line(trimmed: &str, original: &str) -> Option<(String, usize)> {
    for keyword in ["query", "mutation", "subscription"] {
        if let Some(name) = identifier_after_keyword(trimmed, keyword) {
            return Some((name.clone(), find_column(original, &name)));
        }
    }
    None
}

fn graphql_fragment_symbol_from_line(
    trimmed: &str,
    original: &str,
) -> Option<(String, String, usize)> {
    let rest = strip_leading_word(trimmed, "fragment")?.trim_start();
    let name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.is_empty() {
        return None;
    }
    let after_name = rest.get(name.len()..)?.trim_start();
    let on_tail = strip_leading_word(after_name, "on")?.trim_start();
    let type_name: String = on_tail
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if type_name.is_empty() {
        return None;
    }
    Some((name.clone(), type_name, find_column(original, &name)))
}

fn graphql_operation_root_from_line(trimmed: &str) -> Option<(&'static str, bool)> {
    for (keyword, root) in [
        ("query", "Query"),
        ("mutation", "Mutation"),
        ("subscription", "Subscription"),
    ] {
        if strip_leading_word(trimmed, keyword).is_some() {
            return Some((root, trimmed.contains('{')));
        }
    }
    None
}

fn graphql_directive_usages(line: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while let Some(relative_idx) = line[start..].find('@') {
        let at = start + relative_idx;
        let name_start = at + 1;
        let name: String = line[name_start..]
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if !name.is_empty() {
            out.push((name.clone(), name_start, name_start + name.len()));
            start = name_start + name.len();
        } else {
            start = name_start;
        }
    }
    out
}

fn graphql_fragment_reference_context(line: &str) -> Option<(String, String, usize, usize, bool)> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    let rest = strip_leading_word(trimmed, "fragment")?.trim_start();
    let fragment_name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if fragment_name.is_empty() {
        return None;
    }
    let after_name = rest.get(fragment_name.len()..)?.trim_start();
    let on_tail = strip_leading_word(after_name, "on")?.trim_start();
    let type_name: String = on_tail
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if type_name.is_empty() {
        return None;
    }
    let type_start = line.find(&type_name).unwrap_or(leading);
    Some((
        fragment_name,
        type_name,
        type_start,
        type_start
            + line[type_start..]
                .chars()
                .take_while(|ch| is_ident_continue(*ch))
                .map(char::len_utf8)
                .sum::<usize>(),
        trimmed.contains('{'),
    ))
}

fn graphql_fragment_spread_from_line(line: &str) -> Option<(String, usize, usize)> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    let rest = trimmed.strip_prefix("...")?.trim_start();
    if rest.starts_with("on ") {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.is_empty() {
        return None;
    }
    let start = leading + trimmed.find(&name).unwrap_or(0);
    Some((name.clone(), start, start + name.len()))
}

fn graphql_selection_field_from_line(line: &str) -> Option<(String, usize, usize)> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with('}')
        || trimmed.starts_with("...")
        || trimmed.starts_with('@')
        || graphql_type_symbol_from_line(trimmed).is_some()
    {
        return None;
    }
    let first: String = trimmed
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if first.is_empty() {
        return None;
    }
    let after_first = trimmed.get(first.len()..).unwrap_or("").trim_start();
    let field_start = if after_first.starts_with(':') {
        let alias_colon = trimmed.find(':')?;
        let after_alias = trimmed.get(alias_colon + 1..)?.trim_start();
        let name: String = after_alias
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if name.is_empty() {
            return None;
        }
        let start = leading + alias_colon + 1 + trimmed[alias_colon + 1..].find(&name).unwrap_or(0);
        return Some((name.clone(), start, start + name.len()));
    } else {
        leading
    };
    Some((first.clone(), field_start, field_start + first.len()))
}

fn resolve_declared_graphql_field(
    parent_name: &str,
    field_name: &str,
    maps: &GraphResolutionMaps,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    maps.members_by_container_name
        .get(&member_lookup_key(parent_name, field_name))?
        .iter()
        .copied()
        .find(|idx| matches!(symbols[*idx].kind.as_str(), "method" | "constant"))
}

fn resolve_graphql_schema_type_references(
    file: &NativeGraphFile,
    line: &str,
    line_idx: usize,
    symbols: &[NativeGraphSymbol],
    maps: &GraphResolutionMaps,
    out: &mut Vec<(String, GraphReference)>,
    seen: &mut HashSet<(usize, usize, usize)>,
) {
    let trimmed = line.trim_start();
    let mut names = Vec::new();
    if let Some((type_name, _)) = graphql_type_symbol_from_line(trimmed) {
        for relation in graphql_type_relations_from_line(trimmed, &type_name) {
            names.push(relation);
        }
    } else if let Some((_, _, return_type)) = graphql_field_symbol_from_line(trimmed, line) {
        if let Some(return_type) = return_type {
            names.push(return_type);
        }
    }
    for name in names {
        if let Some(type_idx) = choose_type_symbol_index_by_name(&name, maps, symbols) {
            let start = find_column(line, &name);
            push_reference_to_symbol(
                file,
                type_idx,
                &name,
                line,
                line_idx,
                start,
                start + name.len(),
                symbols,
                out,
                seen,
            );
        }
    }
}

fn parse_brace_graph_symbols(
    text: &str,
    language: &str,
    uri: &str,
    rel_path: &str,
) -> Vec<NativeGraphSymbol> {
    let mut symbols = Vec::new();
    let mut type_stack: Vec<(i32, String)> = Vec::new();
    let mut brace_depth = 0i32;
    let mut package_name = String::new();
    let mut pending_annotations: Vec<String> = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut code_state = IdentifierLexState::default();
    let code_lines: Vec<String> = lines
        .iter()
        .map(|line| sanitize_code_line(line, &mut code_state))
        .collect();
    let code_line_refs: Vec<&str> = code_lines.iter().map(String::as_str).collect();
    for (line_idx, line) in lines.iter().enumerate() {
        let code_line = code_line_refs[line_idx];
        let trimmed = code_line.trim_start();
        while type_stack
            .last()
            .map(|(depth, _)| brace_depth <= *depth && !trimmed.is_empty())
            .unwrap_or(false)
        {
            type_stack.pop();
        }
        let direct_type_body = type_stack
            .last()
            .map(|(depth, _)| brace_depth == *depth + 1)
            .unwrap_or(false);
        if package_name.is_empty() {
            if let Some(pkg) = package_from_line(trimmed) {
                package_name = pkg;
            }
        }
        if is_annotation_line(trimmed) && !trimmed.starts_with("@interface") {
            if let Some(name) = annotation_name_from_line(trimmed) {
                pending_annotations.push(name);
            }
            brace_depth += code_line.matches('{').count() as i32;
            brace_depth -= code_line.matches('}').count() as i32;
            if brace_depth < 0 {
                brace_depth = 0;
            }
            continue;
        }
        if let Some((name, kind)) = type_symbol_from_line(trimmed) {
            let column = find_column(line, &name);
            let qualified = if package_name.is_empty() {
                name.clone()
            } else {
                format!("{package_name}.{name}")
            };
            let type_header = type_declaration_header_from_lines(&code_line_refs, line_idx);
            let (extends_names, implements_names) =
                type_relations_from_header(&type_header, &name, kind, language);
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                None,
                optional_non_empty(&package_name),
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            );
            symbol.extends_names = extends_names;
            symbol.implements_names = implements_names;
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_annotations,
                    language,
                    kind,
                ));
            pending_annotations.clear();
            symbols.push(symbol);
            type_stack.push((brace_depth, qualified));
        } else if let Some(ts_decl) = if brace_depth == 0 {
            ts_variable_function_symbol_from_lines(&code_line_refs, line_idx, language)
        } else {
            None
        } {
            let name = ts_decl.name;
            let column = find_column(line, &name);
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| {
                    if package_name.is_empty() {
                        name.clone()
                    } else {
                        format!("{package_name}.{name}")
                    }
                });
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            let kind = if container_name.is_some() {
                "method"
            } else {
                "function"
            };
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                ts_decl.declaration_end_line,
                ts_decl.declaration_end_column,
            );
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_annotations,
                    language,
                    kind,
                ));
            pending_annotations.clear();
            symbols.push(symbol);
        } else if let Some(ts_decl) = if direct_type_body {
            ts_class_field_function_symbol_from_lines(&code_line_refs, line_idx, language)
        } else {
            None
        } {
            let name = ts_decl.name;
            let column = find_column(line, &name);
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "method",
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                ts_decl.declaration_end_line,
                ts_decl.declaration_end_column,
            );
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_annotations,
                    language,
                    "method",
                ));
            pending_annotations.clear();
            symbols.push(symbol);
        } else if let Some((name, kind, column)) = if direct_type_body {
            ts_class_field_constant_symbol_from_line(code_line, language)
        } else {
            None
        } {
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            ));
        } else if let Some((name, column, declaration_end_line, declaration_end_column)) =
            if direct_type_body {
                constructor_symbol_from_lines(&code_line_refs, line_idx, language)
            } else {
                None
            }
        {
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "constructor",
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                declaration_end_line,
                declaration_end_column,
            );
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_annotations,
                    language,
                    "constructor",
                ));
            pending_annotations.clear();
            symbols.push(symbol);
        } else if let Some(ts_decl) = if direct_type_body {
            ts_method_symbol_from_lines(&code_line_refs, line_idx, language)
        } else {
            None
        } {
            let name = ts_decl.name;
            let column = find_column(line, &name);
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            let mut symbol = make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "method",
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                ts_decl.declaration_end_line,
                ts_decl.declaration_end_column,
            );
            symbol
                .implements_names
                .extend(framework_impl_markers_for_annotations(
                    &pending_annotations,
                    language,
                    "method",
                ));
            pending_annotations.clear();
            symbols.push(symbol);
        } else if let Some((name, kind, column)) = if direct_type_body {
            java_field_symbol_from_line(code_line, language)
        } else {
            None
        } {
            let qualified = type_stack
                .last()
                .map(|(_, owner)| format!("{owner}.{name}"))
                .unwrap_or_else(|| name.clone());
            let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                container_name,
                optional_non_empty(&package_name),
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            ));
        } else if let Some(name) = callable_name_from_line(trimmed, language) {
            if !(is_ts_like_language(language) && type_stack.last().is_some() && !direct_type_body)
            {
                let column = find_column(line, &name);
                let qualified = type_stack
                    .last()
                    .map(|(_, owner)| format!("{owner}.{name}"))
                    .unwrap_or_else(|| {
                        if package_name.is_empty() {
                            name.clone()
                        } else {
                            format!("{package_name}.{name}")
                        }
                    });
                let container_name = type_stack.last().map(|(_, owner)| owner.as_str());
                let kind = if container_name
                    .map(|container| {
                        let container_tail = last_qualified_part(container);
                        name == container_tail || name == "constructor" || name == "init"
                    })
                    .unwrap_or(false)
                {
                    "constructor"
                } else if container_name.is_some() {
                    "method"
                } else {
                    "function"
                };
                let (declaration_end_line, declaration_end_column) =
                    declaration_header_end(&code_line_refs, line_idx, column);
                let mut symbol = make_native_graph_symbol(
                    language,
                    uri,
                    rel_path,
                    kind,
                    &name,
                    &qualified,
                    line_idx,
                    column,
                    container_name,
                    optional_non_empty(&package_name),
                    declaration_end_line,
                    declaration_end_column,
                );
                symbol
                    .implements_names
                    .extend(framework_impl_markers_for_annotations(
                        &pending_annotations,
                        language,
                        kind,
                    ));
                pending_annotations.clear();
                symbols.push(symbol);
            }
        } else if let Some((name, kind, column)) = if brace_depth == 0 {
            ts_variable_symbol_from_line(&code_line, language)
        } else {
            None
        } {
            let qualified = if package_name.is_empty() {
                name.clone()
            } else {
                format!("{package_name}.{name}")
            };
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                kind,
                &name,
                &qualified,
                line_idx,
                column,
                None,
                optional_non_empty(&package_name),
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            ));
        } else if let Some((name, column)) = uppercase_assignment(&code_line) {
            let qualified = if package_name.is_empty() {
                name.clone()
            } else {
                format!("{package_name}.{name}")
            };
            symbols.push(make_native_graph_symbol(
                language,
                uri,
                rel_path,
                "constant",
                &name,
                &qualified,
                line_idx,
                column,
                None,
                optional_non_empty(&package_name),
                line_idx as u32,
                column.saturating_add(name.len()) as u32,
            ));
        }
        brace_depth += code_line.matches('{').count() as i32;
        brace_depth -= code_line.matches('}').count() as i32;
        if brace_depth < 0 {
            brace_depth = 0;
        }
    }
    if is_ts_like_language(language) {
        symbols.extend(parse_embedded_graphql_symbols(text, uri, rel_path));
    }
    symbols
}

fn parse_embedded_graphql_symbols(text: &str, uri: &str, rel_path: &str) -> Vec<NativeGraphSymbol> {
    let mut out = Vec::new();
    for (start_line, segment) in embedded_graphql_segments(text) {
        let mut symbols = parse_graphql_graph_symbols(&segment, "graphql", uri, rel_path);
        for symbol in symbols.iter_mut() {
            symbol.start_line = symbol.start_line.saturating_add(start_line as u32);
            symbol.end_line = symbol.end_line.saturating_add(start_line as u32);
            symbol.body_start_line = symbol.body_start_line.saturating_add(start_line as u32);
            symbol.body_end_line = symbol.body_end_line.saturating_add(start_line as u32);
            symbol.declaration_end_line = symbol
                .declaration_end_line
                .saturating_add(start_line as u32);
            symbol.id = format!(
                "{}:{}:{}:{}",
                symbol.language,
                symbol.rel_path,
                symbol.qualified_name,
                symbol.start_line + 1
            );
        }
        out.extend(symbols);
    }
    out
}

fn embedded_graphql_segments(text: &str) -> Vec<(usize, String)> {
    let mut segments = Vec::new();
    let mut collecting = false;
    let mut start_line = 0usize;
    let mut current = String::new();
    for (line_idx, line) in text.lines().enumerate() {
        if !collecting {
            let Some(tick_idx) = graphql_template_start_tick(line) else {
                continue;
            };
            collecting = true;
            start_line = line_idx;
            current.clear();
            let tail = line.get(tick_idx + 1..).unwrap_or("");
            if let Some(end_idx) = tail.find('`') {
                current.push_str(tail.get(..end_idx).unwrap_or(""));
                segments.push((start_line, current.clone()));
                collecting = false;
                current.clear();
            } else {
                current.push_str(tail);
                current.push('\n');
            }
            continue;
        }
        if let Some(end_idx) = line.find('`') {
            current.push_str(line.get(..end_idx).unwrap_or(""));
            segments.push((start_line, current.clone()));
            collecting = false;
            current.clear();
        } else {
            current.push_str(line);
            current.push('\n');
        }
    }
    segments
}

fn graphql_template_start_tick(line: &str) -> Option<usize> {
    if let Some(idx) = line.find("gql`") {
        return Some(idx + 3);
    }
    if let Some(idx) = line.find("graphql`") {
        return Some(idx + "graphql".len());
    }
    if line.contains("GraphQL") {
        return line.find('`');
    }
    None
}

fn resolve_native_graph_references<F>(
    files: Vec<NativeGraphFile>,
    symbols: &[NativeGraphSymbol],
    worker_count: usize,
    progress: &mut F,
) -> Vec<(String, GraphReference)>
where
    F: FnMut(GraphRebuildProgress),
{
    let total = files.len();
    if total == 0 || symbols.is_empty() {
        return Vec::new();
    }
    let mut maps = GraphResolutionMaps::default();
    for (idx, symbol) in symbols.iter().enumerate() {
        maps.by_name
            .entry(symbol.name.clone())
            .or_default()
            .push(idx);
        maps.by_file_name
            .entry(symbol_lookup_key(&symbol.rel_path, &symbol.name))
            .or_default()
            .push(idx);
        if is_type_reference_symbol_kind(&symbol.kind) {
            maps.type_by_name
                .entry(symbol.name.clone())
                .or_default()
                .push(idx);
            maps.type_by_name
                .entry(symbol.qualified_name.clone())
                .or_default()
                .push(idx);
        }
        if let Some(container_name) = symbol.container_name.as_ref() {
            maps.members_by_container_name
                .entry(member_lookup_key(container_name, &symbol.name))
                .or_default()
                .push(idx);
        }
        if symbol.kind == "function" || symbol.kind == "method" {
            maps.declaration_ranges_by_file
                .entry(symbol.rel_path.clone())
                .or_default()
                .push(DeclarationRange {
                    start_line: symbol.start_line,
                    start_column: 0,
                    end_line: symbol.declaration_end_line,
                    end_column: symbol.declaration_end_column,
                });
        }
    }
    let (tx, rx) = mpsc::channel();
    let mut out = Vec::new();
    let mut processed = 0usize;

    let worker_count = worker_count.max(1).min(total.max(1));
    let mut chunks: Vec<Vec<NativeGraphFile>> = std::iter::repeat_with(Vec::new)
        .take(worker_count)
        .collect();
    for (idx, file) in files.into_iter().enumerate() {
        chunks[idx % worker_count].push(file);
    }

    thread::scope(|scope| {
        for chunk in chunks.into_iter().filter(|chunk| !chunk.is_empty()) {
            let tx = tx.clone();
            let symbols_ref = symbols;
            let maps_ref = &maps;
            scope.spawn(move || {
                for file in chunk {
                    let references =
                        resolve_native_graph_references_for_file(file, symbols_ref, maps_ref);
                    if tx.send(references).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);

        for references in rx {
            processed += 1;
            out.extend(references);
            if processed == 1 || processed % 256 == 0 || processed == total {
                progress(GraphRebuildProgress {
                    stage: "resolving",
                    current: processed,
                    total,
                    message: format!(
                        "rust graph resolved references {processed}/{total} with {worker_count} workers"
                    ),
                });
            }
        }
    });
    out
}

fn resolve_native_graph_references_for_file(
    file: NativeGraphFile,
    symbols: &[NativeGraphSymbol],
    maps: &GraphResolutionMaps,
) -> Vec<(String, GraphReference)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if is_graphql_rel_path(&file.rel_path) {
        resolve_graphql_references_for_text(
            &file, &file.text, 0, symbols, maps, &mut out, &mut seen,
        );
        return out;
    }
    let declaration_ranges = maps
        .declaration_ranges_by_file
        .get(&file.rel_path)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let receiver_bindings = infer_receiver_bindings_for_file(&file, symbols, maps);
    let class_by_line = class_scope_by_line(&file);
    let mut lex_state = IdentifierLexState::default();
    for (line_idx, line) in file.text.lines().enumerate() {
        for (name, start, end) in identifier_tokens_with_state(line, &mut lex_state) {
            if should_skip_reference_token_before_symbol(line, &name, start, end, &file.rel_path) {
                continue;
            }
            let member_symbol_idx = member_receiver_before(line, start).and_then(|receiver| {
                choose_member_reference_symbol_index(
                    &file.rel_path,
                    &receiver,
                    &name,
                    line_idx,
                    maps,
                    &file.imports,
                    symbols,
                    &receiver_bindings,
                    &class_by_line,
                )
            });
            let Some(symbol_idx) = member_symbol_idx.or_else(|| {
                choose_reference_symbol_index(
                    &file.rel_path,
                    &name,
                    line_idx as u32,
                    start as u32,
                    &maps.by_file_name,
                    &maps.by_name,
                    &file.imports,
                    symbols,
                )
            }) else {
                continue;
            };
            let symbol = &symbols[symbol_idx];
            let in_declaration_range = declaration_ranges
                .iter()
                .any(|range| declaration_range_contains(*range, line_idx as u32, start as u32));
            if in_declaration_range
                && !is_type_reference_symbol_kind(&symbol.kind)
                && !is_ts_typeof_context(line, start)
            {
                continue;
            }
            if should_skip_reference_for_symbol(line, start, end, &file.rel_path, symbol) {
                continue;
            }
            if !seen.insert((symbol_idx, line_idx, start)) {
                continue;
            }
            out.push((
                symbol.id.clone(),
                make_graph_reference(&file, &name, line, line_idx, start, end),
            ));
        }
        if file.rel_path.ends_with(".py") {
            resolve_python_reflection_references(
                &file,
                line,
                line_idx,
                symbols,
                maps,
                &receiver_bindings,
                &class_by_line,
                &mut out,
                &mut seen,
            );
        }
    }
    if is_ts_like_rel_path(&file.rel_path) {
        for (start_line, segment) in embedded_graphql_segments(&file.text) {
            resolve_graphql_references_for_text(
                &file, &segment, start_line, symbols, maps, &mut out, &mut seen,
            );
        }
    }
    out
}

fn make_graph_reference(
    file: &NativeGraphFile,
    name: &str,
    line: &str,
    line_idx: usize,
    start: usize,
    end: usize,
) -> GraphReference {
    GraphReference {
        name: name.to_string(),
        raw_text: line[start..end].to_string(),
        uri: file.uri.clone(),
        rel_path: file.rel_path.clone(),
        start_line: line_idx as u32,
        start_column: start as u32,
        end_line: line_idx as u32,
        end_column: end as u32,
        enclosing_symbol_id: None,
    }
}

fn push_reference_to_symbol(
    file: &NativeGraphFile,
    symbol_idx: usize,
    name: &str,
    line: &str,
    line_idx: usize,
    start: usize,
    end: usize,
    symbols: &[NativeGraphSymbol],
    out: &mut Vec<(String, GraphReference)>,
    seen: &mut HashSet<(usize, usize, usize)>,
) {
    let symbol = &symbols[symbol_idx];
    if symbol.rel_path == file.rel_path
        && symbol.start_line == line_idx as u32
        && (start as u32) >= symbol.start_column
        && (start as u32) <= symbol.end_column
    {
        return;
    }
    if !seen.insert((symbol_idx, line_idx, start)) {
        return;
    }
    out.push((
        symbol.id.clone(),
        make_graph_reference(file, name, line, line_idx, start, end),
    ));
}

fn resolve_graphql_references_for_text(
    file: &NativeGraphFile,
    text: &str,
    line_offset: usize,
    symbols: &[NativeGraphSymbol],
    maps: &GraphResolutionMaps,
    out: &mut Vec<(String, GraphReference)>,
    seen: &mut HashSet<(usize, usize, usize)>,
) {
    let mut stack: Vec<(i32, String)> = Vec::new();
    let mut brace_depth = 0i32;
    for (local_line_idx, line) in text.lines().enumerate() {
        let line_idx = line_offset + local_line_idx;
        let trimmed = line.trim_start();
        while stack
            .last()
            .map(|(depth, _)| brace_depth <= *depth && !trimmed.is_empty())
            .unwrap_or(false)
        {
            stack.pop();
        }
        for (directive, start, end) in graphql_directive_usages(line) {
            if let Some(symbol_idx) = choose_reference_symbol_index(
                &file.rel_path,
                &directive,
                line_idx as u32,
                start as u32,
                &maps.by_file_name,
                &maps.by_name,
                &file.imports,
                symbols,
            ) {
                push_reference_to_symbol(
                    file, symbol_idx, &directive, line, line_idx, start, end, symbols, out, seen,
                );
            }
        }
        if let Some((operation_kind, has_selection)) = graphql_operation_root_from_line(trimmed) {
            if has_selection {
                stack.push((brace_depth, operation_kind.to_string()));
            }
            brace_depth += line.matches('{').count() as i32;
            brace_depth -= line.matches('}').count() as i32;
            if brace_depth < 0 {
                brace_depth = 0;
            }
            continue;
        }
        if let Some((fragment_name, type_name, type_start, type_end, has_selection)) =
            graphql_fragment_reference_context(line)
        {
            if let Some(type_idx) = choose_type_symbol_index_by_name(&type_name, maps, symbols) {
                push_reference_to_symbol(
                    file, type_idx, &type_name, line, line_idx, type_start, type_end, symbols, out,
                    seen,
                );
            }
            if has_selection {
                stack.push((brace_depth, type_name));
            }
            if let Some(fragment_idx) = choose_reference_symbol_index(
                &file.rel_path,
                &fragment_name,
                line_idx as u32,
                0,
                &maps.by_file_name,
                &maps.by_name,
                &file.imports,
                symbols,
            ) {
                let start = find_column(line, &fragment_name);
                push_reference_to_symbol(
                    file,
                    fragment_idx,
                    &fragment_name,
                    line,
                    line_idx,
                    start,
                    start + fragment_name.len(),
                    symbols,
                    out,
                    seen,
                );
            }
            brace_depth += line.matches('{').count() as i32;
            brace_depth -= line.matches('}').count() as i32;
            if brace_depth < 0 {
                brace_depth = 0;
            }
            continue;
        }
        if let Some((spread_name, start, end)) = graphql_fragment_spread_from_line(line) {
            if let Some(fragment_idx) = choose_reference_symbol_index(
                &file.rel_path,
                &spread_name,
                line_idx as u32,
                start as u32,
                &maps.by_file_name,
                &maps.by_name,
                &file.imports,
                symbols,
            ) {
                push_reference_to_symbol(
                    file,
                    fragment_idx,
                    &spread_name,
                    line,
                    line_idx,
                    start,
                    end,
                    symbols,
                    out,
                    seen,
                );
            }
        } else if let Some(parent_name) = stack.last().map(|(_, parent)| parent.clone()) {
            if let Some((field_name, start, end)) = graphql_selection_field_from_line(line) {
                if let Some(field_idx) =
                    resolve_declared_graphql_field(&parent_name, &field_name, maps, symbols)
                {
                    push_reference_to_symbol(
                        file,
                        field_idx,
                        &field_name,
                        line,
                        line_idx,
                        start,
                        end,
                        symbols,
                        out,
                        seen,
                    );
                    if line.contains('{') {
                        if let Some(return_type) = symbols[field_idx].extends_names.first() {
                            stack.push((brace_depth, return_type.clone()));
                        }
                    }
                }
            }
        } else {
            resolve_graphql_schema_type_references(file, line, line_idx, symbols, maps, out, seen);
        }
        brace_depth += line.matches('{').count() as i32;
        brace_depth -= line.matches('}').count() as i32;
        if brace_depth < 0 {
            brace_depth = 0;
        }
    }
}

fn resolve_python_reflection_references(
    file: &NativeGraphFile,
    line: &str,
    line_idx: usize,
    symbols: &[NativeGraphSymbol],
    maps: &GraphResolutionMaps,
    receiver_bindings: &HashMap<String, usize>,
    class_by_line: &[Option<String>],
    out: &mut Vec<(String, GraphReference)>,
    seen: &mut HashSet<(usize, usize, usize)>,
) {
    for (receiver, member_name, start, end) in python_reflection_member_references(line) {
        if let Some(symbol_idx) = choose_member_reference_symbol_index(
            &file.rel_path,
            &receiver,
            &member_name,
            line_idx,
            maps,
            &file.imports,
            symbols,
            receiver_bindings,
            class_by_line,
        ) {
            push_reference_to_symbol(
                file,
                symbol_idx,
                &member_name,
                line,
                line_idx,
                start,
                end,
                symbols,
                out,
                seen,
            );
        }
    }
    for (name, start, end) in python_globals_locals_references(line) {
        if let Some(symbol_idx) = choose_reference_symbol_index(
            &file.rel_path,
            &name,
            line_idx as u32,
            start as u32,
            &maps.by_file_name,
            &maps.by_name,
            &file.imports,
            symbols,
        ) {
            push_reference_to_symbol(
                file, symbol_idx, &name, line, line_idx, start, end, symbols, out, seen,
            );
        }
    }
}

fn python_reflection_member_references(line: &str) -> Vec<(String, String, usize, usize)> {
    let mut out = Vec::new();
    for function_name in ["getattr", "setattr", "hasattr"] {
        let mut search_start = 0usize;
        let needle = format!("{function_name}(");
        while let Some(relative_idx) = line[search_start..].find(&needle) {
            let call_start = search_start + relative_idx;
            let args_start = call_start + needle.len();
            let Some(args_end) = find_matching_paren_end(line, args_start.saturating_sub(1)) else {
                search_start = args_start;
                continue;
            };
            let args = line.get(args_start..args_end).unwrap_or("");
            let Some((receiver, member, member_offset)) = parse_receiver_and_literal_member(args)
            else {
                search_start = args_end;
                continue;
            };
            let start = args_start + member_offset;
            out.push((receiver, member.clone(), start, start + member.len()));
            search_start = args_end;
        }
    }
    out
}

fn python_globals_locals_references(line: &str) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    for prefix in ["globals()[", "locals()["] {
        let mut search_start = 0usize;
        while let Some(relative_idx) = line[search_start..].find(prefix) {
            let bracket_start = search_start + relative_idx + prefix.len();
            if let Some((name, offset)) = string_literal_at(line.get(bracket_start..).unwrap_or(""))
            {
                let start = bracket_start + offset;
                out.push((name.clone(), start, start + name.len()));
            }
            search_start = bracket_start;
        }
    }
    out
}

fn parse_receiver_and_literal_member(args: &str) -> Option<(String, String, usize)> {
    let first_comma = args.find(',')?;
    let receiver = args.get(..first_comma)?.trim().to_string();
    if receiver.is_empty() {
        return None;
    }
    let after_first = args.get(first_comma + 1..)?;
    let leading = after_first.len() - after_first.trim_start().len();
    let (member, offset) = string_literal_at(after_first.trim_start())?;
    Some((receiver, member, first_comma + 1 + leading + offset))
}

fn string_literal_at(value: &str) -> Option<(String, usize)> {
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = value.get(1..)?;
    let end = rest.find(quote)?;
    Some((rest.get(..end)?.to_string(), 1))
}

fn find_matching_paren_end(line: &str, open_paren_idx: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (idx, ch) in line
        .char_indices()
        .skip_while(|(idx, _)| *idx < open_paren_idx)
    {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(idx);
            }
        }
    }
    None
}

fn declaration_range_contains(range: DeclarationRange, line: u32, column: u32) -> bool {
    if line < range.start_line || line > range.end_line {
        return false;
    }
    if line == range.start_line && column < range.start_column {
        return false;
    }
    if line == range.end_line && column > range.end_column {
        return false;
    }
    true
}

fn choose_reference_symbol_index(
    rel_path: &str,
    name: &str,
    line: u32,
    column: u32,
    by_file_name: &HashMap<String, Vec<usize>>,
    by_name: &HashMap<String, Vec<usize>>,
    imports: &HashMap<String, Vec<ImportTarget>>,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    if let Some(same_file) = by_file_name.get(&symbol_lookup_key(rel_path, name)) {
        return choose_reference_from_candidates(
            same_file.iter().copied(),
            rel_path,
            line,
            column,
            symbols,
        );
    }
    let imported = imported_reference_candidates(name, imports, by_file_name);
    if !imported.is_empty() {
        return choose_reference_from_candidates(
            imported.iter().copied(),
            rel_path,
            line,
            column,
            symbols,
        );
    }
    choose_reference_from_candidates(
        by_name.get(name).into_iter().flatten().copied(),
        rel_path,
        line,
        column,
        symbols,
    )
}

fn choose_reference_from_candidates<I>(
    candidates: I,
    rel_path: &str,
    line: u32,
    column: u32,
    symbols: &[NativeGraphSymbol],
) -> Option<usize>
where
    I: IntoIterator<Item = usize>,
{
    let mut first = None;
    let mut same_file = None;
    let mut count = 0usize;
    for symbol_idx in candidates {
        let symbol = &symbols[symbol_idx];
        if symbol.rel_path == rel_path
            && symbol.start_line == line
            && column >= symbol.start_column
            && column <= symbol.end_column
        {
            continue;
        }
        count += 1;
        first.get_or_insert(symbol_idx);
        if same_file.is_none() && symbol.rel_path == rel_path {
            same_file = Some(symbol_idx);
        }
    }
    if count == 1 {
        first
    } else {
        same_file
    }
}

fn imported_reference_candidates(
    local_name: &str,
    imports: &HashMap<String, Vec<ImportTarget>>,
    by_file_name: &HashMap<String, Vec<usize>>,
) -> Vec<usize> {
    let mut out = Vec::new();
    let Some(targets) = imports.get(local_name) else {
        return out;
    };
    for target in targets {
        if let Some(candidates) = by_file_name.get(&symbol_lookup_key(
            &target.target_rel_path,
            &target.imported_name,
        )) {
            out.extend(candidates.iter().copied());
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn symbol_lookup_key(rel_path: &str, name: &str) -> String {
    format!("{rel_path}\0{name}")
}

fn member_lookup_key(container_name: &str, name: &str) -> String {
    format!("{container_name}\0{name}")
}

fn choose_member_reference_symbol_index(
    rel_path: &str,
    receiver: &str,
    member_name: &str,
    line_idx: usize,
    maps: &GraphResolutionMaps,
    imports: &HashMap<String, Vec<ImportTarget>>,
    symbols: &[NativeGraphSymbol],
    receiver_bindings: &HashMap<String, usize>,
    class_by_line: &[Option<String>],
) -> Option<usize> {
    let receiver = normalize_member_receiver(receiver);
    if receiver.is_empty() {
        return None;
    }
    if matches!(receiver.as_str(), "this" | "self" | "cls") {
        let class_name = class_by_line
            .get(line_idx)
            .and_then(|value| value.as_ref())?;
        let class_idx = choose_type_symbol_index_by_name(class_name, maps, symbols)?;
        return resolve_member_for_type(class_idx, member_name, true, maps, symbols);
    }
    if receiver == "super" || receiver == "super()" {
        let class_name = class_by_line
            .get(line_idx)
            .and_then(|value| value.as_ref())?;
        let class_idx = choose_type_symbol_index_by_name(class_name, maps, symbols)?;
        return resolve_member_for_ancestors(class_idx, member_name, maps, symbols);
    }
    if let Some(type_idx) = receiver_bindings.get(&receiver).copied().or_else(|| {
        receiver_bindings
            .get(last_qualified_part(&receiver))
            .copied()
    }) {
        return resolve_member_for_type(type_idx, member_name, true, maps, symbols);
    }
    if let Some(symbol_idx) =
        imported_module_member_candidate(&receiver, member_name, imports, &maps.by_file_name)
    {
        return Some(symbol_idx);
    }
    let receiver_tail = last_qualified_part(&receiver);
    let type_idx =
        choose_type_reference_symbol_index(rel_path, receiver_tail, maps, imports, symbols)
            .or_else(|| choose_type_symbol_index_by_name(&receiver, maps, symbols))?;
    resolve_member_for_type(type_idx, member_name, true, maps, symbols)
}

fn imported_module_member_candidate(
    receiver: &str,
    member_name: &str,
    imports: &HashMap<String, Vec<ImportTarget>>,
    by_file_name: &HashMap<String, Vec<usize>>,
) -> Option<usize> {
    let receiver_tail = last_qualified_part(receiver);
    let targets = imports
        .get(receiver)
        .or_else(|| imports.get(receiver_tail))?;
    let mut candidates = Vec::new();
    for target in targets {
        if target.imported_name != MODULE_IMPORT_TARGET {
            continue;
        }
        if let Some(found) =
            by_file_name.get(&symbol_lookup_key(&target.target_rel_path, member_name))
        {
            candidates.extend(found.iter().copied());
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.len() == 1 {
        candidates.first().copied()
    } else {
        None
    }
}

fn resolve_member_for_type(
    type_idx: usize,
    member_name: &str,
    include_inherited: bool,
    maps: &GraphResolutionMaps,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    if let Some(member_idx) = resolve_declared_member_for_type(type_idx, member_name, maps, symbols)
    {
        return Some(member_idx);
    }
    if include_inherited {
        return resolve_member_for_ancestors(type_idx, member_name, maps, symbols);
    }
    None
}

fn resolve_member_for_ancestors(
    type_idx: usize,
    member_name: &str,
    maps: &GraphResolutionMaps,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    let mut queue: VecDeque<String> = symbols[type_idx]
        .extends_names
        .iter()
        .chain(symbols[type_idx].implements_names.iter())
        .cloned()
        .collect();
    let mut seen = HashSet::new();
    while let Some(parent_name) = queue.pop_front() {
        let Some(parent_idx) = choose_type_symbol_index_by_name(&parent_name, maps, symbols) else {
            continue;
        };
        if !seen.insert(symbols[parent_idx].id.clone()) {
            continue;
        }
        if let Some(member_idx) =
            resolve_declared_member_for_type(parent_idx, member_name, maps, symbols)
        {
            return Some(member_idx);
        }
        queue.extend(symbols[parent_idx].extends_names.iter().cloned());
        queue.extend(symbols[parent_idx].implements_names.iter().cloned());
    }
    None
}

fn resolve_declared_member_for_type(
    type_idx: usize,
    member_name: &str,
    maps: &GraphResolutionMaps,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    maps.members_by_container_name
        .get(&member_lookup_key(
            &symbols[type_idx].qualified_name,
            member_name,
        ))?
        .iter()
        .copied()
        .find(|idx| {
            matches!(
                symbols[*idx].kind.as_str(),
                "method" | "constructor" | "constant" | "function"
            )
        })
}

fn choose_type_reference_symbol_index(
    rel_path: &str,
    name: &str,
    maps: &GraphResolutionMaps,
    imports: &HashMap<String, Vec<ImportTarget>>,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    if let Some(same_file) = maps.by_file_name.get(&symbol_lookup_key(rel_path, name)) {
        if let Some(idx) = single_type_candidate(same_file.iter().copied(), symbols) {
            return Some(idx);
        }
    }
    let imported = imported_reference_candidates(name, imports, &maps.by_file_name);
    if let Some(idx) = single_type_candidate(imported.iter().copied(), symbols) {
        return Some(idx);
    }
    choose_type_symbol_index_by_name(name, maps, symbols)
}

fn single_type_candidate<I>(candidates: I, symbols: &[NativeGraphSymbol]) -> Option<usize>
where
    I: IntoIterator<Item = usize>,
{
    let mut found = None;
    for idx in candidates {
        if !is_type_reference_symbol_kind(&symbols[idx].kind) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(idx);
    }
    found
}

fn choose_type_symbol_index_by_name(
    name: &str,
    maps: &GraphResolutionMaps,
    symbols: &[NativeGraphSymbol],
) -> Option<usize> {
    let mut candidates = Vec::new();
    for key in [name, last_qualified_part(name)] {
        if let Some(found) = maps.type_by_name.get(key) {
            candidates.extend(found.iter().copied());
        }
    }
    candidates.sort_unstable();
    candidates.dedup();
    if candidates.is_empty() {
        return None;
    }
    candidates
        .iter()
        .copied()
        .find(|idx| symbols[*idx].qualified_name == name)
        .or_else(|| {
            let simple = last_qualified_part(name);
            let simple_matches: Vec<usize> = candidates
                .iter()
                .copied()
                .filter(|idx| symbols[*idx].name == simple)
                .collect();
            if simple_matches.len() == 1 {
                Some(simple_matches[0])
            } else {
                candidates.first().copied()
            }
        })
}

fn member_receiver_before(line: &str, token_start: usize) -> Option<String> {
    let bytes = line.as_bytes();
    let mut idx = token_start;
    while idx > 0
        && bytes
            .get(idx - 1)
            .copied()
            .is_some_and(|ch| ch.is_ascii_whitespace())
    {
        idx -= 1;
    }
    if idx == 0 || bytes.get(idx - 1).copied() != Some(b'.') {
        return None;
    }
    idx -= 1;
    while idx > 0
        && bytes
            .get(idx - 1)
            .copied()
            .is_some_and(|ch| ch.is_ascii_whitespace() || ch == b'?' || ch == b'!')
    {
        idx -= 1;
    }
    while idx > 0
        && bytes
            .get(idx - 1)
            .copied()
            .is_some_and(|ch| ch.is_ascii_whitespace())
    {
        idx -= 1;
    }
    let end = idx;
    while idx > 0
        && bytes.get(idx - 1).copied().is_some_and(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'$' | b'.' | b'(' | b')')
        })
    {
        idx -= 1;
    }
    let receiver = line.get(idx..end)?.trim();
    if receiver.is_empty() {
        None
    } else {
        Some(receiver.to_string())
    }
}

fn normalize_member_receiver(receiver: &str) -> String {
    receiver
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .replace("?.", ".")
        .replace("!!.", ".")
        .trim_end_matches('.')
        .to_string()
}

fn last_qualified_part(value: &str) -> &str {
    value.rsplit('.').next().unwrap_or(value)
}

fn infer_receiver_bindings_for_file(
    file: &NativeGraphFile,
    symbols: &[NativeGraphSymbol],
    maps: &GraphResolutionMaps,
) -> HashMap<String, usize> {
    let mut bindings = HashMap::new();
    let mut state = IdentifierLexState::default();
    for line in file.text.lines() {
        let code_line = sanitize_code_line(line, &mut state);
        for (variable, type_name) in
            receiver_binding_candidates_from_line(&code_line, &file.rel_path)
        {
            if let Some(type_idx) = choose_type_reference_symbol_index(
                &file.rel_path,
                &type_name,
                maps,
                &file.imports,
                symbols,
            ) {
                bindings.insert(normalize_member_receiver(&variable), type_idx);
            }
        }
    }
    bindings
}

fn receiver_binding_candidates_from_line(line: &str, rel_path: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if rel_path.ends_with(".py") {
        if let Some((variable, annotation, constructor)) = python_assignment_binding(line) {
            if let Some(type_name) = constructor.or(annotation) {
                out.push((variable, type_name));
            }
        }
        out.extend(python_parameter_bindings(line));
        return out;
    }
    if is_ts_like_rel_path(rel_path) {
        if let Some((variable, annotation, constructor)) = ts_assignment_binding(line) {
            if let Some(type_name) = constructor.or(annotation) {
                out.push((variable, type_name));
            }
        }
        out.extend(ts_parameter_bindings(line));
    }
    out
}

fn ts_assignment_binding(line: &str) -> Option<(String, Option<String>, Option<String>)> {
    let mut rest = line.trim_start();
    if rest.starts_with("this.") {
        let name: String = rest
            .chars()
            .take_while(|ch| is_ident_continue(*ch) || *ch == '.')
            .collect();
        let after_name = rest.get(name.len()..)?;
        let annotation = type_annotation_name(after_name);
        let constructor = constructor_name_after_assignment(after_name);
        return Some((name, annotation, constructor));
    }
    for keyword in ["const", "let", "var"] {
        if let Some(next) = strip_leading_word(rest, keyword) {
            rest = next.trim_start();
            let name: String = rest
                .chars()
                .take_while(|ch| is_ident_continue(*ch))
                .collect();
            if name.is_empty() {
                return None;
            }
            let after_name = rest.get(name.len()..)?;
            let annotation = type_annotation_name(after_name);
            let constructor = constructor_name_after_assignment(after_name);
            return Some((name, annotation, constructor));
        }
    }
    None
}

fn python_assignment_binding(line: &str) -> Option<(String, Option<String>, Option<String>)> {
    let assignment = find_assignment_operator(line)?;
    let before = line.get(..assignment)?.trim();
    let after = line.get(assignment + 1..)?.trim_start();
    let (variable, annotation) = if let Some((name, annotation)) = before.split_once(':') {
        (
            name.trim().to_string(),
            first_type_name(annotation.trim()).map(ToString::to_string),
        )
    } else {
        (before.to_string(), None)
    };
    if variable.is_empty()
        || !variable
            .chars()
            .all(|ch| is_ident_continue(ch) || ch == '.')
    {
        return None;
    }
    let constructor = first_constructor_name(after).map(ToString::to_string);
    Some((variable, annotation, constructor))
}

fn ts_parameter_bindings(line: &str) -> Vec<(String, String)> {
    typed_parameter_bindings(line, &['(', ','])
}

fn python_parameter_bindings(line: &str) -> Vec<(String, String)> {
    typed_parameter_bindings(line, &['(', ','])
}

fn typed_parameter_bindings(line: &str, starters: &[char]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (idx, ch) in line.char_indices() {
        if !starters.contains(&ch) {
            continue;
        }
        let tail = line.get(idx + ch.len_utf8()..).unwrap_or("").trim_start();
        let variable: String = tail
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if variable.is_empty() {
            continue;
        }
        let after_variable = tail.get(variable.len()..).unwrap_or("").trim_start();
        if !after_variable.starts_with(':') {
            continue;
        }
        if let Some(type_name) =
            first_type_name(after_variable.trim_start_matches(':').trim_start())
        {
            out.push((variable, type_name.to_string()));
        }
    }
    out
}

fn type_annotation_name(value: &str) -> Option<String> {
    let after_colon = value.trim_start().strip_prefix(':')?;
    first_type_name(after_colon.trim_start()).map(ToString::to_string)
}

fn constructor_name_after_assignment(value: &str) -> Option<String> {
    let assignment = find_assignment_operator(value)?;
    first_constructor_name(value.get(assignment + 1..)?.trim_start()).map(ToString::to_string)
}

fn first_constructor_name(value: &str) -> Option<&str> {
    let rest = value.strip_prefix("new ").unwrap_or(value).trim_start();
    let name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name
        .chars()
        .next()
        .map(|ch| ch.is_ascii_uppercase())
        .unwrap_or(false)
        && rest
            .get(name.len()..)
            .unwrap_or("")
            .trim_start()
            .starts_with('(')
    {
        rest.get(..name.len())
    } else {
        None
    }
}

fn first_type_name(value: &str) -> Option<&str> {
    let trimmed = value.trim_start();
    let name: String = trimmed
        .chars()
        .take_while(|ch| is_ident_continue(*ch) || *ch == '.')
        .collect();
    if name
        .chars()
        .next()
        .map(|ch| ch.is_ascii_uppercase())
        .unwrap_or(false)
    {
        trimmed.get(..name.len())
    } else {
        None
    }
}

fn is_ts_like_rel_path(rel_path: &str) -> bool {
    matches!(
        Path::new(rel_path)
            .extension()
            .and_then(|value| value.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
    )
}

fn is_graphql_rel_path(rel_path: &str) -> bool {
    matches!(
        Path::new(rel_path)
            .extension()
            .and_then(|value| value.to_str()),
        Some("graphql" | "gql")
    )
}

fn class_scope_by_line(file: &NativeGraphFile) -> Vec<Option<String>> {
    if file.rel_path.ends_with(".py") {
        return python_class_scope_by_line(&file.text, &file.symbols);
    }
    brace_class_scope_by_line(&file.text, &file.symbols)
}

fn brace_class_scope_by_line(text: &str, symbols: &[NativeGraphSymbol]) -> Vec<Option<String>> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = vec![None; lines.len()];
    let type_symbols: HashMap<(u32, String), String> = symbols
        .iter()
        .filter(|symbol| is_type_reference_symbol_kind(&symbol.kind))
        .map(|symbol| {
            (
                (symbol.start_line, symbol.name.clone()),
                symbol.qualified_name.clone(),
            )
        })
        .collect();
    let mut state = IdentifierLexState::default();
    let code_lines: Vec<String> = lines
        .iter()
        .map(|line| sanitize_code_line(line, &mut state))
        .collect();
    let mut stack: Vec<(i32, String)> = Vec::new();
    let mut brace_depth = 0i32;
    for (line_idx, code_line) in code_lines.iter().enumerate() {
        let trimmed = code_line.trim_start();
        while stack
            .last()
            .map(|(depth, _)| brace_depth <= *depth && !trimmed.is_empty())
            .unwrap_or(false)
        {
            stack.pop();
        }
        out[line_idx] = stack.last().map(|(_, name)| name.clone());
        if let Some((name, _)) = type_symbol_from_line(trimmed) {
            if let Some(qualified) = type_symbols.get(&(line_idx as u32, name.clone())) {
                stack.push((brace_depth, qualified.clone()));
                out[line_idx] = Some(qualified.clone());
            }
        }
        brace_depth += code_line.matches('{').count() as i32;
        brace_depth -= code_line.matches('}').count() as i32;
        if brace_depth < 0 {
            brace_depth = 0;
        }
    }
    out
}

fn python_class_scope_by_line(text: &str, symbols: &[NativeGraphSymbol]) -> Vec<Option<String>> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = vec![None; lines.len()];
    let type_symbols: HashMap<(u32, String), String> = symbols
        .iter()
        .filter(|symbol| symbol.kind == "class")
        .map(|symbol| {
            (
                (symbol.start_line, symbol.name.clone()),
                symbol.qualified_name.clone(),
            )
        })
        .collect();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut state = IdentifierLexState::default();
    for (line_idx, line) in lines.iter().enumerate() {
        let code_line = sanitize_code_line(line, &mut state);
        let trimmed = code_line.trim_start();
        let indent = line
            .chars()
            .take_while(|ch| *ch == ' ' || *ch == '\t')
            .count();
        while stack
            .last()
            .map(|(class_indent, _)| indent <= *class_indent && !trimmed.is_empty())
            .unwrap_or(false)
        {
            stack.pop();
        }
        out[line_idx] = stack.last().map(|(_, name)| name.clone());
        if let Some(name) = identifier_after_keyword(trimmed, "class") {
            if let Some(qualified) = type_symbols.get(&(line_idx as u32, name.clone())) {
                stack.push((indent, qualified.clone()));
                out[line_idx] = Some(qualified.clone());
            }
        }
    }
    out
}

fn effective_graph_worker_count(requested: usize, total: usize) -> usize {
    if total == 0 {
        return 1;
    }
    let fallback = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(64);
    let base = if requested == 0 { fallback } else { requested };
    base.max(1).min(64).min(total.max(1))
}

fn make_native_graph_symbol(
    language: &str,
    uri: &str,
    rel_path: &str,
    kind: &str,
    name: &str,
    qualified_name: &str,
    line_idx: usize,
    column: usize,
    container_name: Option<&str>,
    package_name: Option<&str>,
    declaration_end_line: u32,
    declaration_end_column: u32,
) -> NativeGraphSymbol {
    let end_column = column.saturating_add(name.len()) as u32;
    NativeGraphSymbol {
        id: format!("{language}:{rel_path}:{qualified_name}:{}", line_idx + 1),
        name: name.to_string(),
        qualified_name: qualified_name.to_string(),
        kind: kind.to_string(),
        language: language.to_string(),
        uri: uri.to_string(),
        rel_path: rel_path.to_string(),
        start_line: line_idx as u32,
        start_column: column as u32,
        end_line: line_idx as u32,
        end_column,
        body_start_line: line_idx as u32,
        body_start_column: column as u32,
        body_end_line: line_idx as u32,
        body_end_column: end_column,
        declaration_end_line,
        declaration_end_column,
        container_id: None,
        container_name: container_name.map(ToString::to_string),
        package_name: package_name.map(ToString::to_string),
        extends_names: Vec::new(),
        implements_names: Vec::new(),
    }
}

fn native_symbol_to_graph_symbol(
    symbol: &NativeGraphSymbol,
    usage_count: Option<usize>,
) -> GraphSymbol {
    GraphSymbol {
        id: symbol.id.clone(),
        name: symbol.name.clone(),
        qualified_name: symbol.qualified_name.clone(),
        kind: symbol.kind.clone(),
        language: symbol.language.clone(),
        uri: symbol.uri.clone(),
        rel_path: symbol.rel_path.clone(),
        start_line: symbol.start_line,
        start_column: symbol.start_column,
        end_line: symbol.end_line,
        end_column: symbol.end_column,
        body_start_line: symbol.body_start_line,
        body_start_column: symbol.body_start_column,
        body_end_line: symbol.body_end_line,
        body_end_column: symbol.body_end_column,
        container_id: symbol.container_id.clone(),
        container_name: symbol.container_name.clone(),
        package_name: symbol.package_name.clone(),
        extends_names: symbol.extends_names.clone(),
        implements_names: symbol.implements_names.clone(),
        usage_count,
        implementation_count: None,
    }
}

fn graph_symbol_to_native_symbol(symbol: GraphSymbol) -> NativeGraphSymbol {
    NativeGraphSymbol {
        id: symbol.id,
        name: symbol.name,
        qualified_name: symbol.qualified_name,
        kind: symbol.kind,
        language: symbol.language,
        uri: symbol.uri,
        rel_path: symbol.rel_path,
        start_line: symbol.start_line,
        start_column: symbol.start_column,
        end_line: symbol.end_line,
        end_column: symbol.end_column,
        body_start_line: symbol.body_start_line,
        body_start_column: symbol.body_start_column,
        body_end_line: symbol.body_end_line,
        body_end_column: symbol.body_end_column,
        declaration_end_line: symbol.end_line,
        declaration_end_column: symbol.end_column,
        container_id: symbol.container_id,
        container_name: symbol.container_name,
        package_name: symbol.package_name,
        extends_names: symbol.extends_names,
        implements_names: symbol.implements_names,
    }
}

fn score_graph_symbol_match(symbol: &GraphSymbol, normalized: &str, lower: &str) -> i32 {
    if symbol.id == normalized {
        return 10_000;
    }
    if symbol.qualified_name == normalized {
        return 9_000;
    }
    if symbol.name == normalized {
        return 8_000;
    }
    let qualified_lower = symbol.qualified_name.to_ascii_lowercase();
    if qualified_lower == lower {
        return 7_500;
    }
    let name_lower = symbol.name.to_ascii_lowercase();
    if name_lower == lower {
        return 7_000;
    }
    if qualified_lower.contains(lower) {
        return 5_000 - (qualified_lower.len() as i32).min(1_000);
    }
    if name_lower.contains(lower) {
        return 4_500 - (name_lower.len() as i32).min(1_000);
    }
    if symbol.rel_path.to_ascii_lowercase().contains(lower) {
        return 2_000;
    }
    0
}

fn identifier_after_keyword(line: &str, keyword: &str) -> Option<String> {
    let rest = line.strip_prefix(keyword)?.trim_start();
    if !rest.chars().next().map(is_ident_start).unwrap_or(false) {
        return None;
    }
    Some(
        rest.chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect(),
    )
}

fn python_function_name_from_line(line: &str) -> Option<String> {
    if let Some(name) = identifier_after_keyword(line, "def") {
        return Some(name);
    }
    let rest = strip_leading_word(line.trim_start(), "async")?.trim_start();
    identifier_after_keyword(rest, "def")
}

fn package_from_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("package ")?;
    let name: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '.')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn is_annotation_line(line: &str) -> bool {
    line.trim_start().starts_with('@')
}

fn annotation_name_from_line(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix('@')?;
    let name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch) || *ch == '.')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(last_qualified_part(&name).to_string())
    }
}

fn decorator_name_from_line(line: &str) -> Option<String> {
    annotation_name_from_line(line)
}

fn framework_impl_markers_for_annotations(
    annotations: &[String],
    language: &str,
    symbol_kind: &str,
) -> Vec<String> {
    let mut markers = Vec::new();
    for annotation in annotations {
        let name = annotation.as_str();
        let marker = if language == "python" {
            if matches!(name, "receiver" | "action")
                || name.ends_with("login_required")
                || name.ends_with("permission_required")
                || name.ends_with("csrf_exempt")
                || name.ends_with("cache_page")
            {
                Some("PythonFramework")
            } else {
                None
            }
        } else if matches!(language, "java" | "kotlin") {
            if name.ends_with("Mapping") || matches!(name, "RequestMapping" | "ExceptionHandler") {
                Some("SpringRoute")
            } else if matches!(name, "Bean") {
                Some("SpringBean")
            } else if name.ends_with("Component")
                || matches!(
                    name,
                    "Service"
                        | "Repository"
                        | "Controller"
                        | "RestController"
                        | "Configuration"
                        | "ConfigurationProperties"
                )
            {
                Some("SpringBean")
            } else if name.ends_with("EventListener") || name == "EventListener" {
                Some("SpringEvent")
            } else if name == "Scheduled" {
                Some("SpringScheduled")
            } else if matches!(
                name,
                "Aspect"
                    | "Pointcut"
                    | "Before"
                    | "After"
                    | "Around"
                    | "AfterReturning"
                    | "AfterThrowing"
                    | "Transactional"
                    | "Async"
                    | "Cacheable"
                    | "CacheEvict"
                    | "CachePut"
                    | "PreAuthorize"
                    | "PostAuthorize"
            ) {
                Some("SpringAop")
            } else {
                None
            }
        } else {
            None
        };
        if let Some(marker) = marker {
            markers.push(format!("{FRAMEWORK_IMPL_PREFIX}{marker}"));
        }
    }
    if markers.is_empty() && matches!(language, "java" | "kotlin") && symbol_kind == "constructor" {
        return markers;
    }
    markers.sort();
    markers.dedup();
    markers
}

fn framework_impl_markers_for_python_class(bases: &[String], decorators: &[String]) -> Vec<String> {
    let mut markers = framework_impl_markers_for_annotations(decorators, "python", "class");
    for base in bases {
        let tail = last_qualified_part(base);
        if matches!(
            tail,
            "Model"
                | "DjangoObjectType"
                | "ObjectType"
                | "APIView"
                | "View"
                | "ViewSet"
                | "Serializer"
                | "Form"
                | "Admin"
        ) {
            markers.push(format!("{FRAMEWORK_IMPL_PREFIX}PythonFramework"));
        }
    }
    markers.sort();
    markers.dedup();
    markers
}

fn type_symbol_from_line(line: &str) -> Option<(String, &'static str)> {
    for (keyword, kind) in [
        ("class", "class"),
        ("interface", "interface"),
        ("enum", "enum"),
        ("record", "struct"),
        ("struct", "struct"),
        ("type", "type"),
        ("namespace", "type"),
        ("module", "type"),
    ] {
        if let Some(name) = identifier_after_word(line, keyword) {
            return Some((name, kind));
        }
    }
    None
}

fn type_declaration_header_from_lines(lines: &[&str], line_idx: usize) -> String {
    let mut out = String::new();
    for offset in 0..40 {
        let Some(line) = lines.get(line_idx + offset) else {
            break;
        };
        if offset > 0 {
            out.push(' ');
        }
        out.push_str(line.trim());
        if line.contains('{') || line.contains(';') || line.contains('=') {
            break;
        }
    }
    out
}

fn type_relations_from_header(
    header: &str,
    name: &str,
    kind: &str,
    language: &str,
) -> (Vec<String>, Vec<String>) {
    if language == "kotlin" {
        let heritage = header.split_once(':').map(|(_, tail)| tail).unwrap_or("");
        return (parse_type_reference_list(heritage), Vec::new());
    }
    if is_ts_like_language(language) && kind == "type" {
        let rhs = header.split_once('=').map(|(_, tail)| tail).unwrap_or("");
        return (parse_type_reference_list(rhs), Vec::new());
    }
    let tail = header
        .find(name)
        .and_then(|idx| header.get(idx + name.len()..))
        .unwrap_or(header);
    let extends_names = word_tail_until(tail, "extends", &["implements", "{", ";"])
        .map(parse_type_reference_list)
        .unwrap_or_default();
    let implements_names = word_tail_until(tail, "implements", &["{", ";"])
        .map(parse_type_reference_list)
        .unwrap_or_default();
    (extends_names, implements_names)
}

fn word_tail_until<'a>(value: &'a str, keyword: &str, terminators: &[&str]) -> Option<&'a str> {
    let idx = find_standalone_word(value, keyword)?;
    let mut end = value.len();
    let tail_start = idx + keyword.len();
    let tail = value.get(tail_start..)?;
    for terminator in terminators {
        if *terminator == "{" || *terminator == ";" {
            if let Some(pos) = tail.find(terminator) {
                end = end.min(tail_start + pos);
            }
            continue;
        }
        if let Some(pos) = find_standalone_word(tail, terminator) {
            end = end.min(tail_start + pos);
        }
    }
    value.get(tail_start..end).map(str::trim)
}

fn python_class_bases_from_line(line: &str) -> Vec<String> {
    let Some(open) = line.find('(') else {
        return Vec::new();
    };
    let close = line[open + 1..]
        .find(')')
        .map(|idx| open + 1 + idx)
        .unwrap_or(line.len());
    parse_type_reference_list(line.get(open + 1..close).unwrap_or(""))
}

fn parse_type_reference_list(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw_part in value.split([',', '&', '|']) {
        let without_calls = raw_part
            .split('(')
            .next()
            .unwrap_or("")
            .split('{')
            .next()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("")
            .trim();
        let without_generics = strip_type_generic_suffix(without_calls).trim();
        let name = without_generics
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|ch: char| !(is_ident_continue(ch) || ch == '.'));
        if name.is_empty() || is_ignored_reference_identifier(name) {
            continue;
        }
        if seen.insert(name.to_string()) {
            out.push(name.to_string());
        }
    }
    out
}

fn strip_type_generic_suffix(value: &str) -> &str {
    let mut depth = 0i32;
    for (idx, ch) in value.char_indices() {
        match ch {
            '<' | '[' => {
                if depth == 0 {
                    return value.get(..idx).unwrap_or(value);
                }
                depth += 1;
            }
            _ => {}
        }
    }
    value
}

fn optional_non_empty(value: &str) -> Option<&str> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn is_ts_like_language(language: &str) -> bool {
    language == "typescript" || language == "javascript"
}

#[derive(Clone, Debug)]
struct TsFunctionDeclaration {
    name: String,
    declaration_end_line: u32,
    declaration_end_column: u32,
}

fn ts_variable_function_symbol_from_lines(
    lines: &[&str],
    line_idx: usize,
    language: &str,
) -> Option<TsFunctionDeclaration> {
    if !is_ts_like_language(language) {
        return None;
    }
    let line = lines.get(line_idx)?;
    let (name, _) = ts_variable_declaration_name_from_line(line, language)?;
    let name_column = find_column(line, &name);
    let mut statement = String::new();
    let mut marker: Option<(usize, usize)> = None;
    let mut saw_assignment = false;
    for offset in 0..80 {
        let Some(next_line) = lines.get(line_idx + offset) else {
            break;
        };
        if offset == 0 {
            let start = name_column.saturating_add(name.len());
            statement.push_str(next_line.get(start..).unwrap_or(""));
        } else {
            statement.push('\n');
            statement.push_str(next_line);
        }
        if !saw_assignment {
            saw_assignment = line_has_assignment_operator(&statement);
        }
        if saw_assignment {
            if let Some(col) = next_line.find("=>") {
                marker = Some((line_idx + offset, col + 2));
                break;
            }
            if let Some(col) = find_standalone_word(next_line, "function") {
                marker = Some((line_idx + offset, col + "function".len()));
                break;
            }
            if is_uppercase_identifier(&name)
                && statement_contains_react_component_wrapper(&statement)
            {
                marker = Some((line_idx + offset, next_line.len()));
                break;
            }
        }
        if statement_terminated_before_function_marker(next_line) {
            break;
        }
    }
    let (marker_line, marker_column) = marker?;
    let (end_line, end_column) =
        declaration_header_end_from_marker(lines, marker_line, marker_column);
    Some(TsFunctionDeclaration {
        name,
        declaration_end_line: end_line,
        declaration_end_column: end_column,
    })
}

fn ts_variable_symbol_from_line(
    line: &str,
    language: &str,
) -> Option<(String, &'static str, usize)> {
    let (name, keyword) = ts_variable_declaration_name_from_line(line, language)?;
    let trimmed = line.trim_start();
    let exported = strip_leading_word(trimmed, "export").is_some();
    let uppercase_like = name.chars().any(|ch| ch.is_ascii_uppercase())
        && name
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_');
    if !exported && !uppercase_like {
        return None;
    }
    let column = find_column(line, &name);
    let kind = if keyword == "const" {
        "constant"
    } else {
        "variable"
    };
    Some((name, kind, column))
}

fn ts_variable_declaration_name_from_line(
    line: &str,
    language: &str,
) -> Option<(String, &'static str)> {
    if !is_ts_like_language(language) {
        return None;
    }
    let mut rest = line.trim_start();
    for keyword in ["export", "declare"] {
        if let Some(next) = strip_leading_word(rest, keyword) {
            rest = next.trim_start();
        }
    }
    for keyword in ["const", "let", "var"] {
        let Some(after_keyword) = strip_leading_word(rest, keyword) else {
            continue;
        };
        let after_keyword = after_keyword.trim_start();
        if !after_keyword
            .chars()
            .next()
            .map(is_ident_start)
            .unwrap_or(false)
        {
            return None;
        }
        let name: String = after_keyword
            .chars()
            .take_while(|ch| is_ident_continue(*ch))
            .collect();
        if !name.is_empty() {
            return Some((name, keyword));
        }
    }
    None
}

fn is_uppercase_identifier(value: &str) -> bool {
    value
        .chars()
        .next()
        .map(|ch| ch.is_ascii_uppercase())
        .unwrap_or(false)
}

fn statement_contains_react_component_wrapper(statement: &str) -> bool {
    [
        "memo(",
        "forwardRef(",
        "lazy(",
        "observer(",
        "connect(",
        "styled(",
        "React.memo(",
        "React.forwardRef(",
    ]
    .iter()
    .any(|needle| statement.contains(needle))
}

fn ts_class_field_function_symbol_from_lines(
    lines: &[&str],
    line_idx: usize,
    language: &str,
) -> Option<TsFunctionDeclaration> {
    if !is_ts_like_language(language) {
        return None;
    }
    let line = lines.get(line_idx)?;
    let (name, assignment_column) = ts_class_field_name_and_assignment(line)?;
    let (marker_line, marker_column) =
        ts_initializer_function_marker(lines, line_idx, assignment_column + 1)?;
    let (end_line, end_column) =
        declaration_header_end_from_marker(lines, marker_line, marker_column);
    Some(TsFunctionDeclaration {
        name,
        declaration_end_line: end_line,
        declaration_end_column: end_column,
    })
}

fn ts_class_field_constant_symbol_from_line(
    line: &str,
    language: &str,
) -> Option<(String, &'static str, usize)> {
    if !is_ts_like_language(language) {
        return None;
    }
    let (name, assignment_column) = ts_class_field_name_and_assignment(line)?;
    let _ = assignment_column;
    Some((name.clone(), "constant", find_column(line, &name)))
}

fn constructor_symbol_from_lines(
    lines: &[&str],
    line_idx: usize,
    language: &str,
) -> Option<(String, usize, u32, u32)> {
    let line = lines.get(line_idx)?;
    let trimmed = line.trim_start();
    if is_ts_like_language(language) {
        let mut rest = trimmed;
        for _ in 0..8 {
            let mut stripped = false;
            for keyword in ["public", "private", "protected", "declare"] {
                if let Some(next) = strip_leading_word(rest, keyword) {
                    rest = next.trim_start();
                    stripped = true;
                    break;
                }
            }
            if !stripped {
                break;
            }
        }
        if !rest.starts_with("constructor") {
            return None;
        }
        let column = find_column(line, "constructor");
        let (end_line, end_column) = declaration_header_end(lines, line_idx, column);
        return Some(("constructor".to_string(), column, end_line, end_column));
    }
    if !matches!(language, "java" | "kotlin") {
        return None;
    }
    if !trimmed.contains('(') || trimmed.contains('=') || trimmed.ends_with(';') {
        return None;
    }
    let before = trimmed.split('(').next()?.trim_end();
    let name = before
        .split(|ch: char| !is_ident_continue(ch))
        .filter(|part| !part.is_empty())
        .last()?;
    if is_ignored_reference_identifier(name) {
        return None;
    }
    let column = find_column(line, name);
    let (end_line, end_column) = declaration_header_end(lines, line_idx, column);
    Some((name.to_string(), column, end_line, end_column))
}

fn java_field_symbol_from_line(
    line: &str,
    language: &str,
) -> Option<(String, &'static str, usize)> {
    if !matches!(language, "java" | "kotlin") {
        return None;
    }
    let trimmed = line.trim_start();
    if trimmed.is_empty()
        || trimmed.starts_with('@')
        || trimmed.starts_with("return ")
        || trimmed.starts_with("throw ")
        || trimmed.contains('(')
        || !trimmed.ends_with(';')
    {
        return None;
    }
    let before_value = trimmed
        .split('=')
        .next()
        .unwrap_or(trimmed)
        .trim_end_matches(';')
        .trim_end();
    let name = before_value
        .split(|ch: char| !is_ident_continue(ch))
        .filter(|part| !part.is_empty())
        .last()?;
    if is_ignored_reference_identifier(name) || !is_identifier(name) {
        return None;
    }
    Some((name.to_string(), "constant", find_column(line, name)))
}

fn ts_method_symbol_from_lines(
    lines: &[&str],
    line_idx: usize,
    language: &str,
) -> Option<TsFunctionDeclaration> {
    if !is_ts_like_language(language) {
        return None;
    }
    let line = lines.get(line_idx)?;
    let (name, column) = ts_method_name_from_line(line)?;
    if line.trim_end().ends_with(';') {
        return Some(TsFunctionDeclaration {
            name,
            declaration_end_line: line_idx as u32,
            declaration_end_column: line.len() as u32,
        });
    }
    let (declaration_end_line, declaration_end_column) =
        declaration_header_end(lines, line_idx, column);
    if declaration_end_line == line_idx as u32 && declaration_end_column == column as u32 {
        return None;
    }
    Some(TsFunctionDeclaration {
        name,
        declaration_end_line,
        declaration_end_column,
    })
}

fn ts_class_field_name_and_assignment(line: &str) -> Option<(String, usize)> {
    let assignment_column = find_assignment_operator(line)?;
    let before_assignment = line.get(..assignment_column)?.trim_end();
    let mut rest = before_assignment.trim_start();
    for _ in 0..8 {
        let mut stripped = false;
        for keyword in [
            "public",
            "private",
            "protected",
            "static",
            "readonly",
            "abstract",
            "override",
            "accessor",
            "declare",
        ] {
            if let Some(next) = strip_leading_word(rest, keyword) {
                rest = next.trim_start();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    let rest = rest.strip_prefix('#').unwrap_or(rest);
    if !rest.chars().next().map(is_ident_start).unwrap_or(false) {
        return None;
    }
    let name: String = rest
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.is_empty() {
        return None;
    }
    let after_name = rest[name.len()..].trim_start();
    if !after_name.is_empty() && !matches!(after_name.chars().next(), Some('?' | '!' | ':' | '<')) {
        return None;
    }
    Some((name, assignment_column))
}

fn ts_initializer_function_marker(
    lines: &[&str],
    line_idx: usize,
    initializer_column: usize,
) -> Option<(usize, usize)> {
    for offset in 0..80 {
        let line = lines.get(line_idx + offset)?;
        let start = if offset == 0 { initializer_column } else { 0 };
        let tail = line.get(start..).unwrap_or("");
        if let Some(col) = tail.find("=>") {
            return Some((line_idx + offset, start + col + 2));
        }
        if let Some(col) = find_standalone_word(tail, "function") {
            return Some((line_idx + offset, start + col + "function".len()));
        }
        if line.trim_end().ends_with(';') {
            break;
        }
    }
    None
}

fn ts_method_name_from_line(line: &str) -> Option<(String, usize)> {
    let open_paren = line.find('(')?;
    let before_paren = line.get(..open_paren)?.trim_end();
    if before_paren.contains('=') || before_paren.ends_with('.') {
        return None;
    }
    let before_paren = strip_trailing_ts_generic(before_paren).trim_end();
    let name = before_paren
        .split(|ch: char| !is_ident_continue(ch))
        .filter(|part| !part.is_empty())
        .last()?;
    if is_ignored_reference_identifier(name) || matches!(name, "constructor") {
        return None;
    }
    Some((name.to_string(), find_column(line, name)))
}

fn strip_trailing_ts_generic(value: &str) -> &str {
    let trimmed = value.trim_end();
    if !trimmed.ends_with('>') {
        return trimmed;
    }
    let mut depth = 0i32;
    for (idx, ch) in trimmed.char_indices().rev() {
        match ch {
            '>' => depth += 1,
            '<' => {
                depth -= 1;
                if depth == 0 {
                    return trimmed.get(..idx).unwrap_or(trimmed);
                }
            }
            _ => {}
        }
    }
    trimmed
}

fn declaration_header_end(lines: &[&str], line_idx: usize, name_column: usize) -> (u32, u32) {
    for offset in 0..80 {
        let Some(line) = lines.get(line_idx + offset) else {
            break;
        };
        let start = if offset == 0 { name_column } else { 0 };
        if let Some(col) = line
            .get(start..)
            .and_then(|tail| tail.find('{').map(|col| col + start))
        {
            return ((line_idx + offset) as u32, col as u32);
        }
        if line.trim_end().ends_with(';') {
            return ((line_idx + offset) as u32, line.len() as u32);
        }
    }
    (line_idx as u32, name_column as u32)
}

fn declaration_header_end_from_marker(
    lines: &[&str],
    marker_line: usize,
    marker_column: usize,
) -> (u32, u32) {
    for offset in 0..40 {
        let Some(line) = lines.get(marker_line + offset) else {
            break;
        };
        let start = if offset == 0 { marker_column } else { 0 };
        if let Some(col) = line
            .get(start..)
            .and_then(|tail| tail.find('{').map(|col| col + start))
        {
            return ((marker_line + offset) as u32, col as u32);
        }
        if offset == 0 {
            return (marker_line as u32, marker_column as u32);
        }
    }
    (marker_line as u32, marker_column as u32)
}

fn line_has_assignment_operator(value: &str) -> bool {
    find_assignment_operator(value).is_some()
}

fn find_assignment_operator(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'=' {
            let prev = idx.checked_sub(1).and_then(|prev| bytes.get(prev)).copied();
            let next = bytes.get(idx + 1).copied();
            if !matches!(prev, Some(b'=' | b'!' | b'<' | b'>' | b'-'))
                && !matches!(next, Some(b'=' | b'>'))
            {
                return Some(idx);
            }
        }
        idx += 1;
    }
    None
}

fn statement_terminated_before_function_marker(line: &str) -> bool {
    let Some(semi) = line.find(';') else {
        return false;
    };
    let arrow = line.find("=>");
    let function_word = find_standalone_word(line, "function");
    arrow.map(|idx| semi < idx).unwrap_or(true)
        && function_word.map(|idx| semi < idx).unwrap_or(true)
}

fn callable_name_from_line(line: &str, language: &str) -> Option<String> {
    if language == "kotlin" {
        if let Some(name) = identifier_after_word(line, "fun") {
            return Some(name.rsplit('.').next().unwrap_or(&name).to_string());
        }
    }
    if is_ts_like_language(language) {
        if let Some(name) = top_level_function_name_from_line(line) {
            return Some(name);
        }
        if line.trim_end().ends_with(';') {
            return None;
        }
    }
    if !line.contains('(') || !(line.contains('{') || line.ends_with(';')) {
        return None;
    }
    let before = line.split('(').next()?.trim_end();
    let name = before
        .split(|ch: char| !is_ident_continue(ch))
        .filter(|part| !part.is_empty())
        .last()?;
    if matches!(
        name,
        "if" | "for" | "while" | "switch" | "catch" | "return" | "new" | "class"
    ) {
        None
    } else {
        Some(name.to_string())
    }
}

fn top_level_function_name_from_line(line: &str) -> Option<String> {
    let mut rest = line.trim_start();
    for keyword in ["export", "default", "async"] {
        if let Some(next) = strip_leading_word(rest, keyword) {
            rest = next.trim_start();
        }
    }
    identifier_after_keyword(rest, "function")
}

fn strip_leading_word<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(keyword)?;
    if rest.chars().next().map(is_ident_continue).unwrap_or(false) {
        return None;
    }
    Some(rest)
}

fn identifier_after_word(line: &str, keyword: &str) -> Option<String> {
    let idx = find_standalone_word(line, keyword)?;
    let before = line[..idx].chars().last();
    let after_idx = idx + keyword.len();
    let after = line[after_idx..].chars().next();
    if before.map(is_ident_continue).unwrap_or(false)
        || after.map(is_ident_continue).unwrap_or(false)
    {
        return None;
    }
    let rest = line[after_idx..].trim_start();
    if !rest.chars().next().map(is_ident_start).unwrap_or(false) {
        return None;
    }
    Some(
        rest.chars()
            .take_while(|ch| is_ident_continue(*ch) || *ch == '.')
            .collect(),
    )
}

fn find_standalone_word(line: &str, keyword: &str) -> Option<usize> {
    let mut start = 0usize;
    while let Some(relative_idx) = line[start..].find(keyword) {
        let idx = start + relative_idx;
        let before = line[..idx].chars().last();
        let after_idx = idx + keyword.len();
        let after = line[after_idx..].chars().next();
        if !before.map(is_ident_continue).unwrap_or(false)
            && !after.map(is_ident_continue).unwrap_or(false)
        {
            return Some(idx);
        }
        start = after_idx;
    }
    None
}

fn uppercase_assignment(line: &str) -> Option<(String, usize)> {
    let trimmed = line.trim_start();
    let leading = line.len() - trimmed.len();
    let name: String = trimmed
        .chars()
        .take_while(|ch| is_ident_continue(*ch))
        .collect();
    if name.len() < 2 || !name.chars().any(|ch| ch.is_ascii_uppercase()) {
        return None;
    }
    let rest = trimmed[name.len()..].trim_start();
    if rest.starts_with('=') {
        return Some((name, leading));
    }
    if let Some(after_colon) = rest.strip_prefix(':') {
        if line_has_assignment_operator(after_colon) {
            return Some((name, leading));
        }
    }
    None
}

fn should_skip_reference_token_before_symbol(
    line: &str,
    name: &str,
    start: usize,
    end: usize,
    rel_path: &str,
) -> bool {
    if is_ignored_reference_identifier(name) {
        return true;
    }
    if is_probable_jsx_intrinsic_tag(line, name, start, rel_path) {
        return true;
    }
    if matches!(next_nonspace_char(line, end), Some(':')) {
        return true;
    }
    if next_nonspace_char(line, end) == Some('?') && next_nonspace_after(line, end + 1) == Some(':')
    {
        return true;
    }
    if is_probable_jsx_attribute_name(line, name, start, end, rel_path) {
        return true;
    }
    false
}

fn should_skip_reference_for_symbol(
    line: &str,
    start: usize,
    end: usize,
    rel_path: &str,
    symbol: &NativeGraphSymbol,
) -> bool {
    if is_probable_ts_type_context(line, start, end) && !is_type_reference_symbol_kind(&symbol.kind)
    {
        return true;
    }
    if rel_path.ends_with(".py")
        && is_probable_python_type_context(line, start, end)
        && !is_type_reference_symbol_kind(&symbol.kind)
    {
        return true;
    }
    false
}

fn is_type_reference_symbol_kind(kind: &str) -> bool {
    matches!(kind, "class" | "interface" | "enum" | "type" | "struct")
}

fn is_import_declaration(trimmed: &str) -> bool {
    trimmed.starts_with("import ") || trimmed.starts_with("import type ")
}

fn is_reexport_declaration(trimmed: &str) -> bool {
    trimmed.starts_with("export {") || trimmed.starts_with("export *")
}

fn is_probable_jsx_intrinsic_tag(line: &str, name: &str, start: usize, rel_path: &str) -> bool {
    if !(rel_path.ends_with(".tsx") || rel_path.ends_with(".jsx")) {
        return false;
    }
    if !name
        .chars()
        .next()
        .map(|ch| ch.is_ascii_lowercase())
        .unwrap_or(false)
    {
        return false;
    }
    matches!(previous_nonspace_char(line, start), Some('<'))
}

fn is_probable_ts_type_context(line: &str, start: usize, end: usize) -> bool {
    let before = line.get(..start).unwrap_or("").trim_end();
    let after = line.get(end..).unwrap_or("");
    if before.ends_with(" as")
        || before.ends_with(" satisfies")
        || before.ends_with(" implements")
        || before.ends_with(" extends")
        || before.ends_with(" keyof")
    {
        return true;
    }
    if previous_nonspace_char(line, start) == Some(':')
        && (after.contains('=')
            || matches!(
                after.trim_start().chars().next(),
                Some(',' | ')' | ';' | '}')
            ))
    {
        return true;
    }
    false
}

fn is_ts_typeof_context(line: &str, start: usize) -> bool {
    line.get(..start)
        .unwrap_or("")
        .trim_end()
        .ends_with("typeof")
}

fn is_probable_python_type_context(line: &str, start: usize, end: usize) -> bool {
    let before = line.get(..start).unwrap_or("").trim_end();
    let after = line.get(end..).unwrap_or("");
    if previous_nonspace_char(line, start) == Some(':')
        && matches!(
            after.trim_start().chars().next(),
            Some(',' | ')' | '=' | '-' | ';')
        )
    {
        return true;
    }
    if before.ends_with("->") {
        return true;
    }
    false
}

fn is_probable_jsx_attribute_name(
    line: &str,
    name: &str,
    start: usize,
    end: usize,
    rel_path: &str,
) -> bool {
    if !(rel_path.ends_with(".tsx") || rel_path.ends_with(".jsx")) {
        return false;
    }
    if !name
        .chars()
        .next()
        .map(|ch| ch.is_ascii_lowercase())
        .unwrap_or(false)
    {
        return false;
    }
    if next_nonspace_char(line, end) != Some('=') {
        return false;
    }
    let before = line.get(..start).unwrap_or("");
    let last_open = before.rfind('<');
    let last_close = before.rfind('>');
    if !matches!((last_open, last_close), (Some(open), close) if close.map(|value| open > value).unwrap_or(true))
    {
        return false;
    }
    !matches!(previous_nonspace_char(line, start), Some('<' | '/' | '{'))
}

fn previous_nonspace_char(line: &str, start: usize) -> Option<char> {
    line.get(..start)?
        .chars()
        .rev()
        .find(|ch| !ch.is_whitespace())
}

fn next_nonspace_char(line: &str, end: usize) -> Option<char> {
    next_nonspace_after(line, end)
}

fn next_nonspace_after(line: &str, start: usize) -> Option<char> {
    line.get(start..)?.chars().find(|ch| !ch.is_whitespace())
}

fn is_ignored_reference_identifier(name: &str) -> bool {
    matches!(
        name,
        "abstract"
            | "any"
            | "as"
            | "async"
            | "await"
            | "boolean"
            | "break"
            | "case"
            | "catch"
            | "class"
            | "const"
            | "constructor"
            | "continue"
            | "debugger"
            | "declare"
            | "default"
            | "delete"
            | "do"
            | "else"
            | "enum"
            | "export"
            | "extends"
            | "false"
            | "finally"
            | "for"
            | "from"
            | "function"
            | "get"
            | "fragment"
            | "graphql"
            | "if"
            | "implements"
            | "import"
            | "input"
            | "in"
            | "infer"
            | "instanceof"
            | "interface"
            | "keyof"
            | "let"
            | "module"
            | "mutation"
            | "namespace"
            | "never"
            | "new"
            | "null"
            | "number"
            | "object"
            | "of"
            | "on"
            | "override"
            | "private"
            | "protected"
            | "public"
            | "query"
            | "readonly"
            | "return"
            | "set"
            | "schema"
            | "satisfies"
            | "scalar"
            | "static"
            | "string"
            | "subscription"
            | "super"
            | "switch"
            | "symbol"
            | "this"
            | "throw"
            | "true"
            | "try"
            | "type"
            | "typeof"
            | "union"
            | "undefined"
            | "unknown"
            | "var"
            | "void"
            | "while"
            | "with"
            | "yield"
    )
}

fn sanitize_code_line(line: &str, state: &mut IdentifierLexState) -> String {
    let mut out = String::with_capacity(line.len());
    let mut iter = line.char_indices().peekable();
    while let Some((idx, ch)) = iter.next() {
        if let Some(active_quote) = state.triple_quote {
            out.push(' ');
            if line[idx..].starts_with(&format!("{active_quote}{active_quote}{active_quote}")) {
                if iter.next().is_some() {
                    out.push(' ');
                }
                if iter.next().is_some() {
                    out.push(' ');
                }
                state.triple_quote = None;
            }
            continue;
        }
        if state.in_block_comment {
            out.push(' ');
            if ch == '*' && iter.peek().map(|(_, next)| *next == '/').unwrap_or(false) {
                iter.next();
                out.push(' ');
                state.in_block_comment = false;
            }
            continue;
        }
        if let Some(active_quote) = state.quote {
            out.push(' ');
            if state.escaped {
                state.escaped = false;
                continue;
            }
            if ch == '\\' {
                state.escaped = true;
                continue;
            }
            if ch == active_quote {
                state.quote = None;
            }
            continue;
        }
        if (ch == '"' || ch == '\'') && line[idx..].starts_with(&format!("{ch}{ch}{ch}")) {
            out.push(' ');
            if iter.next().is_some() {
                out.push(' ');
            }
            if iter.next().is_some() {
                out.push(' ');
            }
            state.triple_quote = Some(ch);
            continue;
        }
        if ch == '/' && iter.peek().map(|(_, next)| *next == '/').unwrap_or(false) {
            out.push_str(&" ".repeat(line[idx..].chars().count()));
            break;
        }
        if ch == '/' && iter.peek().map(|(_, next)| *next == '*').unwrap_or(false) {
            out.push(' ');
            iter.next();
            out.push(' ');
            state.in_block_comment = true;
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            out.push(' ');
            state.quote = Some(ch);
            state.escaped = false;
            continue;
        }
        out.push(ch);
    }
    out
}

fn identifier_tokens_with_state(
    line: &str,
    state: &mut IdentifierLexState,
) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut iter = line.char_indices().peekable();
    while let Some((idx, ch)) = iter.next() {
        if let Some(active_quote) = state.triple_quote {
            if line[idx..].starts_with(&format!("{active_quote}{active_quote}{active_quote}")) {
                iter.next();
                iter.next();
                state.triple_quote = None;
            }
            continue;
        }
        if state.in_block_comment {
            if ch == '*' && iter.peek().map(|(_, next)| *next == '/').unwrap_or(false) {
                iter.next();
                state.in_block_comment = false;
            }
            continue;
        }
        if let Some(active_quote) = state.quote {
            if active_quote == '`'
                && ch == '$'
                && iter.peek().map(|(_, next)| *next == '{').unwrap_or(false)
            {
                iter.next();
                state.quote = None;
                state.template_expr_depth = 1;
                continue;
            }
            if state.escaped {
                state.escaped = false;
                continue;
            }
            if ch == '\\' {
                state.escaped = true;
                continue;
            }
            if ch == active_quote {
                state.quote = None;
            }
            continue;
        }
        if state.template_expr_depth > 0 {
            if ch == '{' {
                state.template_expr_depth += 1;
            } else if ch == '}' {
                if let Some(s) = start.take() {
                    out.push((line[s..idx].to_string(), s, idx));
                }
                state.template_expr_depth -= 1;
                if state.template_expr_depth == 0 {
                    state.quote = Some('`');
                    continue;
                }
            }
        }
        if (ch == '"' || ch == '\'') && line[idx..].starts_with(&format!("{ch}{ch}{ch}")) {
            if let Some(s) = start.take() {
                out.push((line[s..idx].to_string(), s, idx));
            }
            iter.next();
            iter.next();
            state.triple_quote = Some(ch);
            continue;
        }
        if ch == '/' && iter.peek().map(|(_, next)| *next == '/').unwrap_or(false) {
            if let Some(s) = start.take() {
                out.push((line[s..idx].to_string(), s, idx));
            }
            break;
        }
        if ch == '/' && iter.peek().map(|(_, next)| *next == '*').unwrap_or(false) {
            if let Some(s) = start.take() {
                out.push((line[s..idx].to_string(), s, idx));
            }
            iter.next();
            state.in_block_comment = true;
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            if let Some(s) = start.take() {
                out.push((line[s..idx].to_string(), s, idx));
            }
            state.quote = Some(ch);
            state.escaped = false;
            continue;
        }
        if start.is_none() {
            if is_ident_start(ch) {
                start = Some(idx);
            }
        } else if !is_ident_continue(ch) {
            let s = start.take().unwrap();
            out.push((line[s..idx].to_string(), s, idx));
        }
    }
    if let Some(s) = start {
        out.push((line[s..].to_string(), s, line.len()));
    }
    out
}

fn is_ident_start(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
}

fn is_ident_continue(ch: char) -> bool {
    is_ident_start(ch) || ch.is_ascii_digit()
}

fn find_column(line: &str, name: &str) -> usize {
    line.find(name).unwrap_or(0)
}

fn parse_ts_imports(text: &str, rel_path: &str) -> HashMap<String, Vec<ImportTarget>> {
    let mut imports: HashMap<String, Vec<ImportTarget>> = HashMap::new();
    let mut statement = String::new();
    let mut collecting = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !collecting {
            if (!is_import_declaration(trimmed) && !is_reexport_declaration(trimmed))
                || trimmed.starts_with("import(")
            {
                continue;
            }
            statement.clear();
            collecting = true;
        } else {
            statement.push(' ');
        }
        statement.push_str(trimmed);
        if trimmed.ends_with(';')
            || trimmed.contains(" from ")
            || quoted_side_effect_import(trimmed).is_some()
        {
            parse_ts_import_statement(&statement, rel_path, &mut imports);
            collecting = false;
        }
    }
    if collecting {
        parse_ts_import_statement(&statement, rel_path, &mut imports);
    }
    imports
}

fn parse_python_imports(text: &str, rel_path: &str) -> HashMap<String, Vec<ImportTarget>> {
    let mut imports: HashMap<String, Vec<ImportTarget>> = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("import ") {
            for item in rest
                .split('#')
                .next()
                .unwrap_or("")
                .trim_end_matches(';')
                .split(',')
            {
                let item = item.trim();
                if item.is_empty() {
                    continue;
                }
                let (module, local_name) = if let Some(as_idx) = item.find(" as ") {
                    (item[..as_idx].trim(), item[as_idx + 4..].trim())
                } else {
                    let module = item;
                    (module, module.rsplit('.').next().unwrap_or(module))
                };
                if !is_identifier(local_name) {
                    continue;
                }
                let target_rel_paths = resolve_python_module_candidates(rel_path, module);
                if !target_rel_paths.is_empty() {
                    add_import_targets(
                        &mut imports,
                        local_name,
                        MODULE_IMPORT_TARGET,
                        &target_rel_paths,
                    );
                }
            }
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("from ") else {
            continue;
        };
        let Some(import_idx) = rest.find(" import ") else {
            continue;
        };
        let module = rest[..import_idx].trim();
        let names = rest[import_idx + " import ".len()..]
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_end_matches(';');
        if names.starts_with('(') || names == "*" {
            continue;
        }
        let target_rel_paths = resolve_python_module_candidates(rel_path, module);
        if target_rel_paths.is_empty() {
            continue;
        }
        for item in names.split(',') {
            let item = item.trim();
            if item.is_empty() {
                continue;
            }
            let (imported_name, local_name) = if let Some(as_idx) = item.find(" as ") {
                (item[..as_idx].trim(), item[as_idx + 4..].trim())
            } else {
                (item, item)
            };
            if is_identifier(imported_name) && is_identifier(local_name) {
                let imported_target = if module.trim_start_matches('.').is_empty() {
                    MODULE_IMPORT_TARGET
                } else {
                    imported_name
                };
                let import_paths = if module.trim_start_matches('.').is_empty() {
                    resolve_python_module_candidates(rel_path, &format!("{module}{imported_name}"))
                } else {
                    target_rel_paths.clone()
                };
                if !import_paths.is_empty() {
                    add_import_targets(&mut imports, local_name, imported_target, &import_paths);
                }
            }
        }
    }
    imports
}

fn resolve_python_module_candidates(rel_path: &str, module: &str) -> Vec<String> {
    let leading_dots = module.chars().take_while(|ch| *ch == '.').count();
    let module_tail = module.trim_start_matches('.');
    let mut parts: Vec<&str> = if leading_dots > 0 {
        let mut base: Vec<&str> = rel_path.split('/').collect();
        base.pop();
        for _ in 1..leading_dots {
            base.pop();
        }
        base
    } else {
        Vec::new()
    };
    if !module_tail.is_empty() {
        parts.extend(module_tail.split('.').filter(|part| !part.is_empty()));
    } else if leading_dots == 0 {
        return Vec::new();
    }
    let base = parts.join("/");
    if base.is_empty() {
        return Vec::new();
    }
    vec![format!("{base}.py"), format!("{base}/__init__.py")]
}

fn parse_ts_import_statement(
    statement: &str,
    rel_path: &str,
    imports: &mut HashMap<String, Vec<ImportTarget>>,
) {
    let Some(module_specifier) = module_specifier_from_import(statement) else {
        return;
    };
    let target_rel_paths = resolve_relative_module_candidates(rel_path, module_specifier);
    if target_rel_paths.is_empty() {
        return;
    }
    if let Some((start, end)) = brace_range(statement) {
        for item in statement[start + 1..end].split(',') {
            let mut item = item.trim();
            if let Some(next) = strip_leading_word(item, "type") {
                item = next.trim_start();
            }
            if item.is_empty() {
                continue;
            }
            let (imported_name, local_name) = if let Some(as_idx) = item.find(" as ") {
                (item[..as_idx].trim(), item[as_idx + 4..].trim())
            } else {
                (item, item)
            };
            if is_identifier(imported_name) && is_identifier(local_name) {
                add_import_targets(imports, local_name, imported_name, &target_rel_paths);
            }
        }
    }

    let mut rest = statement.trim_start();
    if let Some(after_export) = strip_leading_word(rest, "export") {
        rest = after_export.trim_start();
        if let Some(next) = strip_leading_word(rest, "type") {
            rest = next.trim_start();
        }
        if rest.starts_with('*') {
            return;
        }
    } else {
        let Some(after_import) = strip_leading_word(rest, "import") else {
            return;
        };
        rest = after_import.trim_start();
        if let Some(next) = strip_leading_word(rest, "type") {
            rest = next.trim_start();
        }
        if let Some(after_star) = rest.strip_prefix('*') {
            let after_star = after_star.trim_start();
            if let Some(after_as) = strip_leading_word(after_star, "as") {
                let local_name: String = after_as
                    .trim_start()
                    .chars()
                    .take_while(|ch| is_ident_continue(*ch))
                    .collect();
                if is_identifier(&local_name) {
                    add_import_targets(
                        imports,
                        &local_name,
                        MODULE_IMPORT_TARGET,
                        &target_rel_paths,
                    );
                }
            }
            return;
        }
        if rest.starts_with('{') || rest.starts_with('"') || rest.starts_with('\'') {
            return;
        }
    }
    let default_part = rest
        .split(" from ")
        .next()
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim();
    if is_identifier(default_part) {
        add_import_targets(imports, default_part, default_part, &target_rel_paths);
    }
}

fn add_import_targets(
    imports: &mut HashMap<String, Vec<ImportTarget>>,
    local_name: &str,
    imported_name: &str,
    target_rel_paths: &[String],
) {
    let entry = imports.entry(local_name.to_string()).or_default();
    for target_rel_path in target_rel_paths {
        entry.push(ImportTarget {
            imported_name: imported_name.to_string(),
            target_rel_path: target_rel_path.clone(),
        });
    }
}

fn module_specifier_from_import(statement: &str) -> Option<&str> {
    if let Some(from_idx) = statement.rfind(" from ") {
        return quoted_after(statement.get(from_idx + " from ".len()..)?);
    }
    let rest = strip_leading_word(statement.trim_start(), "import")?.trim_start();
    quoted_after(rest)
}

fn quoted_side_effect_import(statement: &str) -> Option<&str> {
    let rest = strip_leading_word(statement.trim_start(), "import")?.trim_start();
    quoted_after(rest)
}

fn quoted_after(value: &str) -> Option<&str> {
    let value = value.trim_start();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = value.get(1..)?;
    let end = rest.find(quote)?;
    rest.get(..end)
}

fn brace_range(value: &str) -> Option<(usize, usize)> {
    let start = value.find('{')?;
    let end = value[start + 1..].find('}')? + start + 1;
    Some((start, end))
}

fn resolve_relative_module_candidates(rel_path: &str, module_specifier: &str) -> Vec<String> {
    if !module_specifier.starts_with('.') {
        return Vec::new();
    }
    let mut parts: Vec<&str> = rel_path.split('/').collect();
    parts.pop();
    for part in module_specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    let base = parts.join("/");
    let has_extension = Path::new(&base).extension().is_some();
    if has_extension {
        return vec![base];
    }
    let mut candidates = Vec::new();
    for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
        candidates.push(format!("{base}.{ext}"));
    }
    for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
        candidates.push(format!("{base}/index.{ext}"));
    }
    candidates
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    if !chars.next().map(is_ident_start).unwrap_or(false) {
        return false;
    }
    chars.all(is_ident_continue)
}

fn language_for_path(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("py") => "python",
        Some("java") => "java",
        Some("kt" | "kts") => "kotlin",
        Some("ts" | "tsx") => "typescript",
        Some("graphql" | "gql") => "graphql",
        _ => "javascript",
    }
    .to_string()
}

fn normalize_rel_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/")
}

fn file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if raw.starts_with('/') {
        format!("file://{}", percent_encode_path(&raw))
    } else {
        format!("file:///{}", percent_encode_path(&raw))
    }
}

fn percent_encode_path(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'-' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn graph_update_path(workspace_root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace_root.join(path)
    }
}

fn read_graph_relation_manifest(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<Option<GraphRelationManifest>> {
    let path = graph_relation_manifest_path(workspace_root, config);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    let Some(shard_count) = json_usize_field(&text, "shardCount") else {
        return Ok(None);
    };
    if shard_count == 0 {
        return Ok(None);
    }
    let Some(generation) = json_u64_field(&text, "generation") else {
        return Ok(None);
    };
    let Some(built_at_unix_ms) = json_u64_field(&text, "builtAtUnixMs") else {
        return Ok(None);
    };
    Ok(Some(GraphRelationManifest {
        built_at_unix_ms,
        generation,
        shard_count,
    }))
}

fn read_symbol_index(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<Option<(u64, Vec<GraphSymbol>)>> {
    let index_path = graph_symbol_index_path(workspace_root, config);
    if !index_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(index_path)?;
    let header = read_symbol_header(&bytes)?;
    let mut symbols = Vec::with_capacity(header.record_count);
    for idx in 0..header.record_count {
        let entry = read_symbol_entry(&bytes, &header, idx)?;
        symbols.push(read_graph_symbol_record(&bytes, &header, &entry)?);
    }
    Ok(Some((header.built_at_unix_ms, symbols)))
}

fn read_all_graph_references(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<Option<(u64, Vec<(String, GraphReference)>)>> {
    if let Some(manifest) = read_graph_relation_manifest(workspace_root, config)? {
        let layout_root = config.index_root(workspace_root);
        let mut references = Vec::new();
        for shard_id in 0..manifest.shard_count {
            let shard_path = graph_relation_shard_path(&layout_root, manifest.generation, shard_id);
            let bytes = fs::read(shard_path)?;
            let header = read_header(&bytes)?;
            if header.built_at_unix_ms != manifest.built_at_unix_ms {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "graph relation shard builtAt mismatch: shard={} manifest={}",
                        header.built_at_unix_ms, manifest.built_at_unix_ms
                    ),
                ));
            }
            append_all_graph_references_from_bytes(&bytes, &header, &mut references)?;
        }
        return Ok(Some((manifest.built_at_unix_ms, references)));
    }
    let index_path = graph_index_path(workspace_root, config);
    if !index_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(index_path)?;
    let header = read_header(&bytes)?;
    let mut references = Vec::new();
    append_all_graph_references_from_bytes(&bytes, &header, &mut references)?;
    Ok(Some((header.built_at_unix_ms, references)))
}

fn append_all_graph_references_from_bytes(
    bytes: &[u8],
    header: &Header,
    references: &mut Vec<(String, GraphReference)>,
) -> io::Result<()> {
    for idx in 0..header.record_count {
        let entry = read_entry(&bytes, &header, idx)?;
        let symbol_id = read_symbol(&bytes, &header, &entry)?;
        for reference in read_references(&bytes, &header, &entry, usize::MAX)? {
            references.push((symbol_id.clone(), reference));
        }
    }
    Ok(())
}

fn read_symbol_header(bytes: &[u8]) -> io::Result<SymbolHeader> {
    if bytes.len() < GRAPH_SYMBOL_HEADER_SIZE || &bytes[0..8] != GRAPH_SYMBOL_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid graph symbol index magic",
        ));
    }
    let version = read_u32_at(bytes, 8)?;
    if version != GRAPH_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported graph symbol index version {version}"),
        ));
    }
    let record_count = read_u32_at(bytes, 12)? as usize;
    let built_at_unix_ms = read_u64_at(bytes, 16)?;
    let index_offset = read_u64_at(bytes, 24)? as usize;
    let data_offset = read_u64_at(bytes, 32)? as usize;
    let index_end = index_offset
        .checked_add(
            record_count
                .checked_mul(GRAPH_SYMBOL_INDEX_ENTRY_SIZE)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "graph symbol index entry count overflow",
                    )
                })?,
        )
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "graph symbol index offset overflow",
            )
        })?;
    if index_offset < GRAPH_SYMBOL_HEADER_SIZE
        || index_end > bytes.len()
        || data_offset > bytes.len()
        || index_end > data_offset
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid graph symbol index offsets",
        ));
    }
    Ok(SymbolHeader {
        record_count,
        built_at_unix_ms,
        index_offset,
        data_offset,
    })
}

fn read_symbol_entry(bytes: &[u8], header: &SymbolHeader, index: usize) -> io::Result<SymbolEntry> {
    let offset = header
        .index_offset
        .checked_add(
            index
                .checked_mul(GRAPH_SYMBOL_INDEX_ENTRY_SIZE)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "graph symbol index entry offset overflow",
                    )
                })?,
        )
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "graph symbol index entry offset overflow",
            )
        })?;
    Ok(SymbolEntry {
        record_offset: read_u64_at(bytes, offset)?,
        record_len: read_u32_at(bytes, offset + 8)?,
    })
}

fn write_graph_symbol_record(out: &mut Vec<u8>, symbol: &GraphSymbol) -> io::Result<()> {
    put_string(out, &symbol.id)?;
    put_string(out, &symbol.name)?;
    put_string(out, &symbol.qualified_name)?;
    put_string(out, &symbol.kind)?;
    put_string(out, &symbol.language)?;
    put_string(out, &symbol.uri)?;
    put_string(out, &symbol.rel_path)?;
    put_u32(out, symbol.start_line);
    put_u32(out, symbol.start_column);
    put_u32(out, symbol.end_line);
    put_u32(out, symbol.end_column);
    put_u32(out, symbol.body_start_line);
    put_u32(out, symbol.body_start_column);
    put_u32(out, symbol.body_end_line);
    put_u32(out, symbol.body_end_column);
    put_string(out, symbol.container_id.as_deref().unwrap_or(""))?;
    put_string(out, symbol.container_name.as_deref().unwrap_or(""))?;
    put_string(out, symbol.package_name.as_deref().unwrap_or(""))?;
    put_string_list(out, &symbol.extends_names)?;
    put_string_list(out, &symbol.implements_names)?;
    Ok(())
}

fn read_graph_symbol_record(
    bytes: &[u8],
    header: &SymbolHeader,
    entry: &SymbolEntry,
) -> io::Result<GraphSymbol> {
    let start = header
        .data_offset
        .checked_add(entry.record_offset as usize)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "graph symbol data offset overflow",
            )
        })?;
    let end = start
        .checked_add(entry.record_len as usize)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "graph symbol payload overflow")
        })?;
    let payload = bytes.get(start..end).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "graph symbol payload outside buffer",
        )
    })?;
    let mut cursor = 0usize;
    let id = read_string(payload, &mut cursor)?;
    let name = read_string(payload, &mut cursor)?;
    let qualified_name = read_string(payload, &mut cursor)?;
    let kind = read_string(payload, &mut cursor)?;
    let language = read_string(payload, &mut cursor)?;
    let uri = read_string(payload, &mut cursor)?;
    let rel_path = read_string(payload, &mut cursor)?;
    let start_line = read_u32(payload, &mut cursor)?;
    let start_column = read_u32(payload, &mut cursor)?;
    let end_line = read_u32(payload, &mut cursor)?;
    let end_column = read_u32(payload, &mut cursor)?;
    let body_start_line = read_u32(payload, &mut cursor)?;
    let body_start_column = read_u32(payload, &mut cursor)?;
    let body_end_line = read_u32(payload, &mut cursor)?;
    let body_end_column = read_u32(payload, &mut cursor)?;
    let container_id = empty_string_to_none(read_string(payload, &mut cursor)?);
    let container_name = empty_string_to_none(read_string(payload, &mut cursor)?);
    let package_name = empty_string_to_none(read_string(payload, &mut cursor)?);
    let extends_names = if cursor < payload.len() {
        read_string_list(payload, &mut cursor)?
    } else {
        Vec::new()
    };
    let implements_names = if cursor < payload.len() {
        read_string_list(payload, &mut cursor)?
    } else {
        Vec::new()
    };
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
        usage_count: None,
        implementation_count: None,
    })
}

fn read_header(bytes: &[u8]) -> io::Result<Header> {
    if bytes.len() < GRAPH_HEADER_SIZE || &bytes[0..8] != GRAPH_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid graph index magic",
        ));
    }
    let version = read_u32_at(bytes, 8)?;
    if version != GRAPH_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported graph index version {version}"),
        ));
    }
    let record_count = read_u32_at(bytes, 12)? as usize;
    let built_at_unix_ms = read_u64_at(bytes, 16)?;
    let index_offset = read_u64_at(bytes, 24)? as usize;
    let data_offset = read_u64_at(bytes, 32)? as usize;
    let index_end = index_offset
        .checked_add(
            record_count
                .checked_mul(GRAPH_INDEX_ENTRY_SIZE)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "graph index entry count overflow",
                    )
                })?,
        )
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "graph index offset overflow"))?;
    if index_offset < GRAPH_HEADER_SIZE
        || index_end > bytes.len()
        || data_offset > bytes.len()
        || index_end > data_offset
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid graph index offsets",
        ));
    }
    Ok(Header {
        record_count,
        built_at_unix_ms,
        index_offset,
        data_offset,
    })
}

fn find_entry(bytes: &[u8], header: &Header, symbol_id: &str) -> io::Result<Option<IndexEntry>> {
    let mut lo = 0usize;
    let mut hi = header.record_count;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let entry = read_entry(bytes, header, mid)?;
        let mid_symbol = read_symbol(bytes, header, &entry)?;
        match mid_symbol.as_str().cmp(symbol_id) {
            Ordering::Less => lo = mid + 1,
            Ordering::Greater => hi = mid,
            Ordering::Equal => return Ok(Some(entry)),
        }
    }
    Ok(None)
}

fn read_references(
    bytes: &[u8],
    header: &Header,
    entry: &IndexEntry,
    limit: usize,
) -> io::Result<Vec<GraphReference>> {
    let start = checked_data_pos(header, entry.refs_offset, 0)?;
    let end = checked_data_pos(header, entry.refs_offset, entry.refs_len as usize)?;
    if end > bytes.len() || start >= end {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid reference payload",
        ));
    }
    let payload = &bytes[start..end];
    let mut cursor = 0usize;
    let count = read_u32(payload, &mut cursor)? as usize;
    let wanted = count.min(limit);
    let mut references = Vec::with_capacity(wanted);
    for idx in 0..count {
        let name = read_string(payload, &mut cursor)?;
        let raw_text = read_string(payload, &mut cursor)?;
        let uri = read_string(payload, &mut cursor)?;
        let rel_path = read_string(payload, &mut cursor)?;
        let start_line = read_u32(payload, &mut cursor)?;
        let start_column = read_u32(payload, &mut cursor)?;
        let end_line = read_u32(payload, &mut cursor)?;
        let end_column = read_u32(payload, &mut cursor)?;
        let enclosing_symbol_id = match read_string(payload, &mut cursor)? {
            value if value.is_empty() => None,
            value => Some(value),
        };
        if idx < wanted {
            references.push(GraphReference {
                name,
                raw_text,
                uri,
                rel_path,
                start_line,
                start_column,
                end_line,
                end_column,
                enclosing_symbol_id,
            });
        }
    }
    Ok(references)
}

fn read_entry(bytes: &[u8], header: &Header, index: usize) -> io::Result<IndexEntry> {
    let offset = header
        .index_offset
        .checked_add(index.checked_mul(GRAPH_INDEX_ENTRY_SIZE).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "graph index entry offset overflow",
            )
        })?)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "graph index entry offset overflow",
            )
        })?;
    Ok(IndexEntry {
        symbol_offset: read_u64_at(bytes, offset)?,
        symbol_len: read_u32_at(bytes, offset + 8)?,
        refs_offset: read_u64_at(bytes, offset + 12)?,
        refs_len: read_u32_at(bytes, offset + 20)?,
        ref_count: read_u32_at(bytes, offset + 24)?,
    })
}

fn read_symbol(bytes: &[u8], header: &Header, entry: &IndexEntry) -> io::Result<String> {
    let start = checked_data_pos(header, entry.symbol_offset, 0)?;
    let end = checked_data_pos(header, entry.symbol_offset, entry.symbol_len as usize)?;
    if end > bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid symbol offset",
        ));
    }
    std::str::from_utf8(&bytes[start..end])
        .map(|value| value.to_string())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn symbol_bytes<'a>(data: &'a [u8], entry: &IndexEntry) -> Option<&'a [u8]> {
    let start = entry.symbol_offset as usize;
    let end = start.checked_add(entry.symbol_len as usize)?;
    data.get(start..end)
}

fn checked_data_pos(header: &Header, relative_offset: u64, extra: usize) -> io::Result<usize> {
    header
        .data_offset
        .checked_add(relative_offset as usize)
        .and_then(|value| value.checked_add(extra))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "graph data offset overflow"))
}

fn put_string(out: &mut Vec<u8>, value: &str) -> io::Result<()> {
    put_u32(out, checked_u32(value.len(), "string length")?);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

fn put_string_list(out: &mut Vec<u8>, values: &[String]) -> io::Result<()> {
    put_u32(out, checked_u32(values.len(), "string list length")?);
    for value in values {
        put_string(out, value)?;
    }
    Ok(())
}

fn read_string(bytes: &[u8], cursor: &mut usize) -> io::Result<String> {
    let len = read_u32(bytes, cursor)? as usize;
    let end = cursor
        .checked_add(len)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "string offset overflow"))?;
    let slice = bytes
        .get(*cursor..end)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "string outside payload"))?;
    *cursor = end;
    std::str::from_utf8(slice)
        .map(|value| value.to_string())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn read_string_list(bytes: &[u8], cursor: &mut usize) -> io::Result<Vec<String>> {
    let len = read_u32(bytes, cursor)? as usize;
    let mut values = Vec::with_capacity(len);
    for _ in 0..len {
        values.push(read_string(bytes, cursor)?);
    }
    Ok(values)
}

fn parse_u32(value: &str, label: &str) -> io::Result<u32> {
    value.parse::<u32>().map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {label} value {value:?}: {err}"),
        )
    })
}

fn optional_decoded_field(value: &str) -> io::Result<Option<String>> {
    if value.is_empty() {
        return Ok(None);
    }
    decode_field(value).map(Some)
}

fn empty_string_to_none(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn decode_field(value: &str) -> io::Result<String> {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut idx = 0usize;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            if idx + 2 >= bytes.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "truncated percent escape",
                ));
            }
            let hi = hex_value(bytes[idx + 1])?;
            let lo = hex_value(bytes[idx + 2])?;
            out.push((hi << 4) | lo);
            idx += 3;
        } else {
            out.push(bytes[idx]);
            idx += 1;
        }
    }
    String::from_utf8(out).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn hex_value(value: u8) -> io::Result<u8> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid percent escape",
        )),
    }
}

fn checked_u32(value: usize, label: &str) -> io::Result<u32> {
    u32::try_from(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} exceeds graph index limit"),
        )
    })
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> io::Result<u32> {
    let value = read_u32_at(bytes, *cursor)?;
    *cursor += 4;
    Ok(value)
}

fn read_u32_at(bytes: &[u8], offset: usize) -> io::Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "u32 outside buffer"))?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_u64_at(bytes: &[u8], offset: usize) -> io::Result<u64> {
    let slice = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "u64 outside buffer"))?;
    Ok(u64::from_le_bytes(slice.try_into().unwrap()))
}

fn unix_secs_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn stable_graph_hash(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn json_usize_field(text: &str, field: &str) -> Option<usize> {
    json_u64_field(text, field).and_then(|value| usize::try_from(value).ok())
}

fn json_u64_field(text: &str, field: &str) -> Option<u64> {
    let needle = format!("\"{field}\"");
    let idx = text.find(&needle)?;
    let after_name = text.get(idx + needle.len()..)?;
    let colon = after_name.find(':')?;
    let mut value = after_name.get(colon + 1..)?.trim_start();
    if let Some(rest) = value.strip_prefix('"') {
        let end = rest.find('"')?;
        value = rest.get(..end)?;
    }
    let digits: String = value.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_queries_graph_index() -> io::Result<()> {
        let root = temp_dir("graph-index");
        fs::create_dir_all(&root)?;
        let input = root.join("graph.tsv");
        fs::write(
            &input,
            "U\tsym%3Aalpha\talpha\talpha()%20call\tfile%3A%2F%2F%2Ftmp%2Fa.ts\tsrc%2Fa.ts\t1\t2\t1\t7\towner\n",
        )?;
        let config = EngineConfig::default();
        let summary = index_graph_from_tsv(&root, &input, 42, &config)?;
        assert_eq!(summary.symbol_count, 1);
        assert_eq!(summary.reference_count, 1);
        let result = query_graph(&root, "sym:alpha", 10, &config)?.expect("query result");
        assert_eq!(result.built_at_unix_ms, 42);
        assert_eq!(result.total_references, 1);
        assert_eq!(result.references[0].raw_text, "alpha() call");
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_writes_symbol_and_relation_indexes() -> io::Result<()> {
        let root = temp_dir("graph-native");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("a.ts"),
            "export function alpha() {\n  beta();\n}\nfunction beta() {\n  return alpha();\n}\nalpha();\n",
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 84, &config, 4, &mut |_| {})?;
        assert_eq!(summary.symbol_count, 2);
        assert_eq!(summary.reference_count, 3);
        let manifest = read_graph_relation_manifest(&root, &config)?.expect("sharded manifest");
        assert_eq!(manifest.built_at_unix_ms, 84);
        assert!(manifest.shard_count > 1);
        let layout_root = config.index_root(&root);
        for shard_id in 0..manifest.shard_count {
            assert!(
                graph_relation_shard_path(&layout_root, manifest.generation, shard_id).exists(),
                "expected relation shard {shard_id} to exist",
            );
        }

        let alpha = query_graph_symbols(&root, "alpha", 10, &config)?
            .expect("symbol query result")
            .symbols;
        assert_eq!(alpha.len(), 1);
        assert_eq!(alpha[0].id, "typescript:src/a.ts:alpha:1");

        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("src/a.ts")),
            None,
            None,
            10,
            &config,
        )?
        .expect("document symbol query result");
        assert_eq!(document.symbols.len(), 2);
        assert_eq!(document.symbols[0].usage_count, Some(2));

        let references = query_graph(&root, "typescript:src/a.ts:alpha:1", 10, &config)?
            .expect("graph query result");
        assert_eq!(references.total_references, 2);
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn cleanup_stale_relation_generations_preserves_current_generation() -> io::Result<()> {
        let root = temp_dir("graph-stale-shards");
        fs::create_dir_all(&root)?;
        let current = graph_relation_shard_path(&root, 20, 0);
        let old = graph_relation_shard_path(&root, 10, 0);
        let failed_tmp = root.join(format!(
            "{}{}-{:04}{}.tmp",
            GRAPH_RELATION_SHARD_PREFIX, 30, 0, GRAPH_RELATION_SHARD_SUFFIX
        ));
        let legacy = root.join(GRAPH_FILE_NAME);
        fs::write(&current, b"current")?;
        fs::write(&old, b"old")?;
        fs::write(&failed_tmp, b"tmp")?;
        fs::write(&legacy, b"legacy")?;

        let removed = cleanup_stale_graph_relation_files(&root, 20, 0)?;
        assert!(
            current.exists(),
            "current generation shard must be preserved"
        );
        assert!(!old.exists(), "old generation shard should be removed");
        assert!(
            !failed_tmp.exists(),
            "stale temporary shard should be removed"
        );
        assert!(
            !legacy.exists(),
            "legacy single relation file should be removed"
        );
        assert_eq!(removed.len(), 3);
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_graph_update_refreshes_changed_file_without_dropping_others() -> io::Result<()> {
        let root = temp_dir("graph-native-update");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        let provider = src.join("a.ts");
        let consumer = src.join("b.ts");
        fs::write(&provider, "export function alpha() {\n  return 1;\n}\n")?;
        fs::write(
            &consumer,
            "export function caller() {\n  return alpha();\n}\n",
        )?;
        let config = EngineConfig::default();
        rebuild_graph_native(&root, 90, &config, 4, &mut |_| {})?;
        let alpha = query_graph_symbols(&root, "alpha", 10, &config)?
            .expect("symbol query result")
            .symbols
            .into_iter()
            .find(|symbol| symbol.qualified_name == "alpha")
            .expect("alpha symbol");
        assert_eq!(
            query_graph(&root, &alpha.id, 10, &config)?
                .expect("alpha refs")
                .total_references,
            1,
        );

        fs::write(
            &consumer,
            "export function caller() {\n  alpha();\n  return alpha();\n}\n",
        )?;
        let no_deleted: Vec<PathBuf> = Vec::new();
        let summary = update_graph_native(&root, &[consumer.clone()], &no_deleted, 90, &config, 4)?;
        assert_eq!(summary.built_at_unix_ms, 90);
        let updated_alpha = query_graph_symbols(&root, "alpha", 10, &config)?
            .expect("updated symbol query result")
            .symbols
            .into_iter()
            .find(|symbol| symbol.id == alpha.id)
            .expect("updated alpha symbol");
        assert_eq!(updated_alpha.rel_path, "src/a.ts");
        let updated_refs = query_graph(&root, &alpha.id, 10, &config)?.expect("updated alpha refs");
        assert_eq!(updated_refs.total_references, 2);
        assert!(updated_refs
            .references
            .iter()
            .all(|reference| reference.rel_path == "src/b.ts"));
        let provider_doc =
            query_graph_document_symbols(&root, &file_uri(&provider), None, None, 10, &config)?
                .expect("provider document symbols");
        let provider_alpha = provider_doc
            .symbols
            .iter()
            .find(|symbol| symbol.id == alpha.id)
            .expect("provider alpha inlay symbol");
        assert_eq!(provider_alpha.usage_count, Some(2));

        fs::write(&provider, "\nexport function alpha() {\n  return 2;\n}\n")?;
        update_graph_native(&root, &[provider.clone()], &no_deleted, 90, &config, 4)?;
        let shifted_refs = query_graph(&root, &alpha.id, 10, &config)?.expect("shifted alpha refs");
        assert_eq!(
            shifted_refs.total_references, 2,
            "line-only declaration shifts should preserve the symbol id and retained references",
        );
        let shifted_provider_doc =
            query_graph_document_symbols(&root, &file_uri(&provider), None, None, 10, &config)?
                .expect("shifted provider document symbols");
        let shifted_alpha = shifted_provider_doc
            .symbols
            .iter()
            .find(|symbol| symbol.id == alpha.id)
            .expect("shifted provider alpha inlay symbol");
        assert_eq!(shifted_alpha.start_line, 1);
        assert_eq!(shifted_alpha.usage_count, Some(2));

        fs::remove_file(&consumer)?;
        let no_changed: Vec<PathBuf> = Vec::new();
        update_graph_native(&root, &no_changed, &[consumer], 90, &config, 4)?;
        let deleted_refs = query_graph(&root, &alpha.id, 10, &config)?.expect("deleted alpha refs");
        assert_eq!(deleted_refs.total_references, 0);
        let provider_doc_after_delete =
            query_graph_document_symbols(&root, &file_uri(&provider), None, None, 10, &config)?
                .expect("provider document symbols after delete");
        assert!(provider_doc_after_delete
            .symbols
            .iter()
            .any(|symbol| symbol.id == alpha.id));
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_multiline_ts_function_assignments() -> io::Result<()> {
        let root = temp_dir("graph-ts-multiline");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("component.tsx"),
            r#"const helper = () => null;

export const OwnerPermissionTable = (
  companyId: string,
  hrmId: string
): JSX.Element => {
  return helper(companyId, hrmId);
};

export const WrappedOwnerPermissionTable =
  memo(
    forwardRef(function InnerOwnerPermissionTable(
      props: Props,
    ) {
      return <OwnerPermissionTable companyId={props.companyId} hrmId={props.hrmId} />;
    })
  );

OwnerPermissionTable("c", "h");
WrappedOwnerPermissionTable.displayName = "WrappedOwnerPermissionTable";
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 126, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);

        let owner_matches = query_graph_symbols(&root, "OwnerPermissionTable", 10, &config)?
            .expect("owner symbol query result")
            .symbols;
        let owner: Vec<GraphSymbol> = owner_matches
            .into_iter()
            .filter(|symbol| symbol.name == "OwnerPermissionTable")
            .collect();
        assert_eq!(owner.len(), 1);
        assert_eq!(
            owner[0].id,
            "typescript:src/component.tsx:OwnerPermissionTable:3"
        );

        let wrapped = query_graph_symbols(&root, "WrappedOwnerPermissionTable", 10, &config)?
            .expect("wrapped symbol query result")
            .symbols;
        assert_eq!(wrapped.len(), 1);
        assert_eq!(
            wrapped[0].id,
            "typescript:src/component.tsx:WrappedOwnerPermissionTable:10"
        );

        let inner = query_graph_symbols(&root, "InnerOwnerPermissionTable", 10, &config)?
            .expect("inner symbol query result")
            .symbols;
        assert!(
            inner.is_empty(),
            "nested function expression should not become the exported symbol"
        );

        let owner_refs = query_graph(&root, &owner[0].id, 20, &config)?
            .expect("owner reference query result")
            .references;
        assert!(
            owner_refs.iter().all(|reference| reference.start_line > 6),
            "parameter/header tokens should not be indexed as owner usages: {owner_refs:?}"
        );
        assert!(
            owner_refs
                .iter()
                .any(|reference| reference.start_line == 14),
            "jsx usage of owner component should be indexed"
        );
        assert!(
            owner_refs
                .iter()
                .any(|reference| reference.start_line == 18),
            "call usage of owner component should be indexed"
        );

        let wrapped_refs = query_graph(&root, &wrapped[0].id, 20, &config)?
            .expect("wrapped reference query result")
            .references;
        assert_eq!(wrapped_refs.len(), 1);
        assert_eq!(wrapped_refs[0].start_line, 19);
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_common_tsx_symbols_and_references() -> io::Result<()> {
        let root = temp_dir("graph-tsx-patterns");
        let components = root.join("src/components");
        fs::create_dir_all(&components)?;
        fs::write(
            components.join("Button.tsx"),
            r#"export type ButtonProps = { label: string; onPress?: () => void };
export interface Pressable {
  press(event: MouseEvent): void;
}
export type ButtonLike = ButtonProps & Pressable;
export enum ButtonSize {
  Small = "small",
}

export const Button = ({ label, onPress }: ButtonProps) => {
  return <button onClick={onPress}>{label}</button>;
};

export function useButton<TValue>(value: TValue) {
  return value;
}

export abstract class BaseController {
  abstract handleClick<TEvent>(event: TEvent): void;
}

export class ButtonController extends BaseController implements Pressable {
  private readonly cache = new Map<string, string>();
  private size: ButtonSize = ButtonSize.Small;
  public handleClick<TEvent>(
    event: TEvent,
  ): void {
    useButton(event);
  }
  public press(event: MouseEvent): void {
    this.handleClick(event);
  }
  onHover = (event: MouseEvent) => {
    this.handleClick(event);
  };
}

export class FancyButtonController extends ButtonController {}
"#,
        )?;
        fs::write(
            root.join("src/Consumer.tsx"),
            r#"import { Button as ImportedButton, useButton, ButtonController } from "./components/Button";
import type { ButtonProps } from "./components/Button";

const label = "Button";
const controller = new ButtonController();

export const Consumer = () => {
  useButton(label);
  return <ImportedButton label={label} onPress={() => controller.handleClick(label)} />;
};
"#,
        )?;
        fs::write(
            root.join("src/Other.tsx"),
            r#"export const Button = () => null;
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 168, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 3);

        let button_uri = file_uri(&root.join("src/components/Button.tsx"));
        let button_doc = query_graph_document_symbols(&root, &button_uri, None, None, 50, &config)?
            .expect("button document symbols");
        let symbol_names: BTreeSet<String> = button_doc
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "ButtonProps",
            "Pressable",
            "ButtonLike",
            "ButtonSize",
            "Button",
            "useButton",
            "BaseController",
            "ButtonController",
            "FancyButtonController",
            "handleClick",
            "press",
            "onHover",
        ] {
            assert!(
                symbol_names.contains(expected),
                "missing TSX symbol {expected}: {symbol_names:?}"
            );
        }
        for unexpected in ["label", "onPress", "event", "TEvent", "MouseEvent"] {
            assert!(
                !symbol_names.contains(unexpected),
                "parameter/type token should not become a symbol: {unexpected}"
            );
        }

        let button = query_graph_symbols(&root, "Button", 20, &config)?
            .expect("button symbol query")
            .symbols
            .into_iter()
            .find(|symbol| {
                symbol.name == "Button" && symbol.rel_path == "src/components/Button.tsx"
            })
            .expect("Button symbol");
        let button_refs = query_graph(&root, &button.id, 20, &config)?
            .expect("button references")
            .references;
        assert_eq!(
            button_refs.len(),
            1,
            "Button should be referenced by JSX usage only, not imports or strings: {button_refs:?}"
        );
        assert_eq!(button_refs[0].rel_path, "src/Consumer.tsx");

        let use_button = query_graph_symbols(&root, "useButton", 20, &config)?
            .expect("useButton symbol query")
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == "useButton")
            .expect("useButton symbol");
        let use_button_refs = query_graph(&root, &use_button.id, 20, &config)?
            .expect("useButton references")
            .references;
        assert_eq!(use_button_refs.len(), 3);
        assert!(use_button_refs
            .iter()
            .any(|reference| reference.rel_path == "src/components/Button.tsx"));
        assert!(use_button_refs
            .iter()
            .any(|reference| reference.rel_path == "src/Consumer.tsx"));

        let handle_click = query_graph_symbols(&root, "handleClick", 20, &config)?
            .expect("handleClick symbol query")
            .symbols
            .into_iter()
            .find(|symbol| {
                symbol.name == "handleClick"
                    && symbol.container_name.as_deref() == Some("ButtonController")
            })
            .expect("handleClick symbol");
        let handle_click_refs = query_graph(&root, &handle_click.id, 20, &config)?
            .expect("handleClick references")
            .references;
        assert_eq!(handle_click_refs.len(), 3);
        assert!(handle_click_refs
            .iter()
            .any(|reference| reference.rel_path == "src/components/Button.tsx"));
        assert!(handle_click_refs
            .iter()
            .any(|reference| reference.rel_path == "src/Consumer.tsx"));

        let consumer_uri = file_uri(&root.join("src/Consumer.tsx"));
        let consumer_doc =
            query_graph_document_symbols(&root, &consumer_uri, None, None, 50, &config)?
                .expect("consumer document symbols");
        let consumer_names: BTreeSet<String> = consumer_doc
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        assert!(
            !consumer_names.contains("label"),
            "ordinary local variables should not become TS symbols: {consumer_names:?}"
        );

        let button_props = button_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "ButtonProps")
            .expect("ButtonProps symbol");
        let button_props_refs = query_graph(&root, &button_props.id, 20, &config)?
            .expect("ButtonProps references")
            .references;
        assert_eq!(
            button_props_refs.len(),
            3,
            "ButtonProps should be referenced from import, component props and type alias: {button_props_refs:?}"
        );

        let pressable = button_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Pressable")
            .expect("Pressable symbol");
        let pressable_refs = query_graph(&root, &pressable.id, 20, &config)?
            .expect("Pressable references")
            .references;
        assert_eq!(
            pressable_refs.len(),
            2,
            "Pressable should be referenced from type alias and implements clause: {pressable_refs:?}"
        );

        let base_controller = button_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "BaseController")
            .expect("BaseController symbol");
        let base_controller_refs = query_graph(&root, &base_controller.id, 20, &config)?
            .expect("BaseController references")
            .references;
        assert_eq!(base_controller_refs.len(), 1);

        let button_size = button_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "ButtonSize")
            .expect("ButtonSize symbol");
        let button_size_refs = query_graph(&root, &button_size.id, 20, &config)?
            .expect("ButtonSize references")
            .references;
        assert_eq!(
            button_size_refs.len(),
            2,
            "enum should be referenced from type annotation and runtime member access: {button_size_refs:?}"
        );

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_comments_anonymous_assignments_and_static_usage() -> io::Result<()> {
        let root = temp_dir("graph-ts-comments-static");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("factory.ts"),
            r#"export interface StaticOptions {
  enabled: boolean;
}

export const FIXED_LIMIT = 10;

export const makeRunner =
  /* comment with fake function Fake() { return null; } and fake => */
  async (
    options: StaticOptions,
  ) => {
    return WorkerFactory.create(options);
  };

export const makeNamed =
  // comment between assignment and anonymous function
  function (
    options: StaticOptions,
  ) {
    return FIXED_LIMIT;
  };

export class WorkerFactory {
  static readonly KIND = "worker";
  static create(
    options: StaticOptions,
  ) {
    return WorkerFactory.KIND;
  }
  static build =
    /* block comment between static assignment and anonymous function */
    function (
      options: StaticOptions,
    ) {
      return WorkerFactory.create(options);
    };
}

export function /* partial comment */ consume(
  // parameter line comment
  runner: ReturnType<typeof makeRunner>,
): StaticOptions {
  return WorkerFactory.create({ enabled: true });
}
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 294, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);

        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("src/factory.ts")),
            None,
            None,
            100,
            &config,
        )?
        .expect("factory document symbols");
        let names: BTreeSet<String> = document
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "StaticOptions",
            "FIXED_LIMIT",
            "makeRunner",
            "makeNamed",
            "WorkerFactory",
            "KIND",
            "create",
            "build",
            "consume",
        ] {
            assert!(
                names.contains(expected),
                "missing symbol {expected}: {names:?}"
            );
        }
        for unexpected in ["Fake", "options", "runner"] {
            assert!(
                !names.contains(unexpected),
                "comments or parameters should not become symbols: {unexpected}"
            );
        }

        let static_options = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "StaticOptions")
            .expect("StaticOptions symbol");
        let static_options_refs = query_graph(&root, &static_options.id, 20, &config)?
            .expect("StaticOptions references")
            .references;
        assert_eq!(
            static_options_refs.len(),
            5,
            "interface usage should survive multiline signatures and return annotations: {static_options_refs:?}"
        );

        let worker_factory = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "WorkerFactory")
            .expect("WorkerFactory symbol");
        let worker_factory_refs = query_graph(&root, &worker_factory.id, 20, &config)?
            .expect("WorkerFactory references")
            .references;
        assert_eq!(
            worker_factory_refs.len(),
            4,
            "class static usage should be tracked through Class.member expressions: {worker_factory_refs:?}"
        );

        let create = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "create")
            .expect("create symbol");
        let create_refs = query_graph(&root, &create.id, 20, &config)?
            .expect("create references")
            .references;
        assert_eq!(
            create_refs.len(),
            3,
            "static method usage should be tracked: {create_refs:?}"
        );

        let kind = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "KIND")
            .expect("KIND symbol");
        let kind_refs = query_graph(&root, &kind.id, 20, &config)?
            .expect("KIND references")
            .references;
        assert_eq!(kind_refs.len(), 1);

        let fixed_limit = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "FIXED_LIMIT")
            .expect("FIXED_LIMIT symbol");
        let fixed_limit_refs = query_graph(&root, &fixed_limit.id, 20, &config)?
            .expect("FIXED_LIMIT references")
            .references;
        assert_eq!(fixed_limit_refs.len(), 1);

        let make_runner = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "makeRunner")
            .expect("makeRunner symbol");
        let make_runner_refs = query_graph(&root, &make_runner.id, 20, &config)?
            .expect("makeRunner references")
            .references;
        assert_eq!(make_runner_refs.len(), 1);

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_resolves_class_method_receivers_and_implementations() -> io::Result<()> {
        let root = temp_dir("graph-ts-method-receivers");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("workers.ts"),
            r#"export interface Runnable {
  run(): string;
}

export abstract class BaseWorker {
  abstract run(): string;
  shared() {
    return this.run();
  }
}

export class ConcreteWorker extends BaseWorker implements Runnable {
  run() {
    return WorkerFactory.KIND;
  }
}

export class InheritedWorker extends BaseWorker {}

export class WorkerFactory {
  static readonly KIND = "worker";
  static create() {
    return new ConcreteWorker();
  }
}

export function execute(runnable: Runnable) {
  const concrete = new ConcreteWorker();
  const inherited = new InheritedWorker();
  WorkerFactory.create();
  concrete.run();
  inherited.shared();
  inherited.run();
  runnable.run();
  return WorkerFactory.KIND;
}
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 336, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);

        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("src/workers.ts")),
            None,
            None,
            100,
            &config,
        )?
        .expect("worker document symbols");

        let runnable = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Runnable")
            .expect("Runnable symbol");
        assert_eq!(runnable.implementation_count, Some(1));

        let base_worker = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "BaseWorker")
            .expect("BaseWorker symbol");
        assert_eq!(base_worker.implementation_count, Some(2));

        let runnable_run = document
            .symbols
            .iter()
            .find(|symbol| {
                symbol.name == "run" && symbol.container_name.as_deref() == Some("Runnable")
            })
            .expect("Runnable.run symbol");
        assert_eq!(runnable_run.implementation_count, Some(1));
        let runnable_run_refs = query_graph(&root, &runnable_run.id, 20, &config)?
            .expect("Runnable.run references")
            .references;
        assert_eq!(runnable_run_refs.len(), 1);
        assert_eq!(runnable_run_refs[0].start_line, 33);

        let base_run = document
            .symbols
            .iter()
            .find(|symbol| {
                symbol.name == "run" && symbol.container_name.as_deref() == Some("BaseWorker")
            })
            .expect("BaseWorker.run symbol");
        assert_eq!(base_run.implementation_count, Some(1));
        let base_run_refs = query_graph(&root, &base_run.id, 20, &config)?
            .expect("BaseWorker.run references")
            .references;
        assert!(
            base_run_refs
                .iter()
                .any(|reference| reference.start_line == 7),
            "this.run() should resolve to BaseWorker.run: {base_run_refs:?}"
        );
        assert!(
            base_run_refs
                .iter()
                .any(|reference| reference.start_line == 32),
            "InheritedWorker.run() should resolve to inherited BaseWorker.run: {base_run_refs:?}"
        );

        let concrete_run = document
            .symbols
            .iter()
            .find(|symbol| {
                symbol.name == "run" && symbol.container_name.as_deref() == Some("ConcreteWorker")
            })
            .expect("ConcreteWorker.run symbol");
        let concrete_run_refs = query_graph(&root, &concrete_run.id, 20, &config)?
            .expect("ConcreteWorker.run references")
            .references;
        assert_eq!(concrete_run_refs.len(), 1);
        assert_eq!(concrete_run_refs[0].start_line, 30);

        let create = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "create")
            .expect("WorkerFactory.create symbol");
        let create_refs = query_graph(&root, &create.id, 20, &config)?
            .expect("WorkerFactory.create references")
            .references;
        assert_eq!(create_refs.len(), 1);
        assert_eq!(create_refs[0].start_line, 29);

        let kind = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "KIND")
            .expect("WorkerFactory.KIND symbol");
        let kind_refs = query_graph(&root, &kind.id, 20, &config)?
            .expect("WorkerFactory.KIND references")
            .references;
        assert_eq!(kind_refs.len(), 2);

        let shared = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "shared")
            .expect("BaseWorker.shared symbol");
        let shared_refs = query_graph(&root, &shared.id, 20, &config)?
            .expect("BaseWorker.shared references")
            .references;
        assert_eq!(shared_refs.len(), 1);
        assert_eq!(shared_refs[0].start_line, 31);

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_indexes_embedded_graphql_and_keeps_template_interpolation_refs(
    ) -> io::Result<()> {
        let root = temp_dir("graph-ts-graphql");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("queries.ts"),
            r#"import { gql } from "@apollo/client";

export const USER_FRAGMENT = gql`
  fragment UserFields on User {
    id
    name
  }
`;

export const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      ...UserFields
    }
  }
  ${USER_FRAGMENT}
`;

export function useUserQuery() {
  return GET_USER;
}
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 210, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);

        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("src/queries.ts")),
            None,
            None,
            50,
            &config,
        )?
        .expect("graphql document symbols");
        let names: BTreeSet<String> = document
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in ["USER_FRAGMENT", "GET_USER", "useUserQuery"] {
            assert!(names.contains(expected), "missing graph symbol {expected}");
        }
        for expected in ["UserFields", "GetUser"] {
            assert!(
                names.contains(expected),
                "missing embedded GraphQL symbol {expected}"
            );
        }
        for unexpected in ["User", "ID", "user"] {
            assert!(
                !names.contains(unexpected),
                "unresolved embedded GraphQL token should not become TS symbol: {unexpected}"
            );
        }

        let fragment = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "USER_FRAGMENT")
            .expect("USER_FRAGMENT symbol");
        let fragment_refs = query_graph(&root, &fragment.id, 20, &config)?
            .expect("fragment references")
            .references;
        assert_eq!(
            fragment_refs.len(),
            1,
            "only template interpolation should reference USER_FRAGMENT: {fragment_refs:?}"
        );

        let get_user = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "GET_USER")
            .expect("GET_USER symbol");
        let get_user_refs = query_graph(&root, &get_user.id, 20, &config)?
            .expect("GET_USER references")
            .references;
        assert_eq!(get_user_refs.len(), 1);

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_django_graphene_python_patterns() -> io::Result<()> {
        let root = temp_dir("graph-python-django-graphene");
        let src = root.join("app");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("models.py"),
            r#"from django.db import models

class User(models.Model):
    name = models.CharField(max_length=120)

    def display_name(self):
        return self.name
"#,
        )?;
        fs::write(
            src.join("schema.py"),
            r#"import graphene
from graphene_django import DjangoObjectType
from .models import User

SCHEMA_DOC = """
type User {
  id: ID!
  name: String!
}
"""

class UserType(DjangoObjectType):
    class Meta:
        model = User
        fields = ("id", "name")

class Query(graphene.ObjectType):
    user = graphene.Field(UserType, id=graphene.ID(required=True))

    async def resolve_user(self, info, id):
        return User.objects.get(pk=id)

schema = graphene.Schema(query=Query)
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 252, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 2);

        let schema_doc = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("app/schema.py")),
            None,
            None,
            50,
            &config,
        )?
        .expect("schema document symbols");
        let schema_names: BTreeSet<String> = schema_doc
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "SCHEMA_DOC",
            "UserType",
            "Meta",
            "Query",
            "resolve_user",
            "schema",
            "model",
            "fields",
            "user",
        ] {
            assert!(
                schema_names.contains(expected),
                "missing Python framework symbol {expected}: {schema_names:?}"
            );
        }
        for unexpected in ["ID", "String"] {
            assert!(
                !schema_names.contains(unexpected),
                "Graphene/Django field token should not become a symbol: {unexpected}"
            );
        }

        let user_model = query_graph_symbols(&root, "User", 20, &config)?
            .expect("User symbol query")
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == "User" && symbol.rel_path == "app/models.py")
            .expect("User model symbol");
        let user_refs = query_graph(&root, &user_model.id, 20, &config)?
            .expect("User model references")
            .references;
        assert_eq!(
            user_refs.len(),
            3,
            "Graphene import, Meta.model and resolver should reference the imported model: {user_refs:?}"
        );

        let user_type = schema_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "UserType")
            .expect("UserType symbol");
        let user_type_refs = query_graph(&root, &user_type.id, 20, &config)?
            .expect("UserType references")
            .references;
        assert_eq!(user_type_refs.len(), 1);

        let query = schema_doc
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Query")
            .expect("Query symbol");
        let query_refs = query_graph(&root, &query.id, 20, &config)?
            .expect("Query references")
            .references;
        assert_eq!(query_refs.len(), 1);

        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_indexes_standalone_graphql_fields_and_operations() -> io::Result<()> {
        let root = temp_dir("graph-standalone-graphql");
        fs::create_dir_all(&root)?;
        fs::write(
            root.join("schema.graphql"),
            r#"type Query {
  user(id: ID!): User
}

type User {
  id: ID!
  name: String!
}

query GetUser($id: ID!) {
  user(id: $id) {
    id
    name
  }
}

fragment UserFields on User {
  id
  name
}
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 420, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);

        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("schema.graphql")),
            None,
            None,
            100,
            &config,
        )?
        .expect("graphql document symbols");
        let names: BTreeSet<String> = document
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "Query",
            "User",
            "user",
            "id",
            "name",
            "GetUser",
            "UserFields",
        ] {
            assert!(
                names.contains(expected),
                "missing GraphQL symbol {expected}: {names:?}"
            );
        }
        let query_user = document
            .symbols
            .iter()
            .find(|symbol| symbol.qualified_name == "Query.user")
            .expect("Query.user field");
        let query_user_refs = query_graph(&root, &query_user.id, 20, &config)?
            .expect("Query.user refs")
            .references;
        assert_eq!(query_user_refs.len(), 1);

        let user_id = document
            .symbols
            .iter()
            .find(|symbol| symbol.qualified_name == "User.id")
            .expect("User.id field");
        let user_id_refs = query_graph(&root, &user_id.id, 20, &config)?
            .expect("User.id refs")
            .references;
        assert_eq!(user_id_refs.len(), 2);

        let operation = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "GetUser")
            .expect("GetUser operation");
        assert_eq!(operation.implementation_count, Some(1));
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_ts_namespace_reexports_hoc_constructor_and_fields() -> io::Result<()>
    {
        let root = temp_dir("graph-ts-namespace-hoc");
        let src = root.join("src");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("components.tsx"),
            r#"import { memo } from "react";

export const Card = () => null;
export const WrappedCard = memo(Card);

export class Service {
  value = 1;
  constructor() {}
  run() {
    return this.value;
  }
}
"#,
        )?;
        fs::write(
            src.join("barrel.ts"),
            r#"export { Card as ReCard } from "./components";
"#,
        )?;
        fs::write(
            src.join("consumer.tsx"),
            r#"import * as Components from "./components";
import { Service } from "./components";

const service = new Service();
Components.Card();
service.run();
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 462, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 3);
        let document = query_graph_document_symbols(
            &root,
            &file_uri(&root.join("src/components.tsx")),
            None,
            None,
            100,
            &config,
        )?
        .expect("components document symbols");
        let names: BTreeSet<String> = document
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "Card",
            "WrappedCard",
            "Service",
            "value",
            "constructor",
            "run",
        ] {
            assert!(
                names.contains(expected),
                "missing TS symbol {expected}: {names:?}"
            );
        }
        let card = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Card")
            .expect("Card symbol");
        let card_refs = query_graph(&root, &card.id, 20, &config)?
            .expect("Card refs")
            .references;
        assert!(
            card_refs
                .iter()
                .any(|reference| reference.rel_path == "src/barrel.ts"),
            "re-export should reference Card: {card_refs:?}"
        );
        assert!(
            card_refs
                .iter()
                .any(|reference| reference.rel_path == "src/consumer.tsx"),
            "namespace import member should reference Card: {card_refs:?}"
        );
        let value = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "value")
            .expect("value field");
        let value_refs = query_graph(&root, &value.id, 20, &config)?
            .expect("value refs")
            .references;
        assert_eq!(value_refs.len(), 1);
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_python_reflection_and_module_member_imports() -> io::Result<()> {
        let root = temp_dir("graph-python-reflection");
        let app = root.join("app");
        fs::create_dir_all(&app)?;
        fs::write(
            app.join("models.py"),
            r#"class User:
    def display_name(self):
        return "user"
"#,
        )?;
        fs::write(
            app.join("views.py"),
            r#"from .models import User

def user_view():
    user: User = User()
    return getattr(user, "display_name")()
"#,
        )?;
        fs::write(
            app.join("urls.py"),
            r#"from . import views

urlpatterns = [
    views.user_view,
]
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 504, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 3);
        let display_name = query_graph_symbols(&root, "display_name", 20, &config)?
            .expect("display_name query")
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == "display_name")
            .expect("display_name symbol");
        let display_refs = query_graph(&root, &display_name.id, 20, &config)?
            .expect("display_name refs")
            .references;
        assert_eq!(display_refs.len(), 1);

        let user_view = query_graph_symbols(&root, "user_view", 20, &config)?
            .expect("user_view query")
            .symbols
            .into_iter()
            .find(|symbol| symbol.name == "user_view")
            .expect("user_view symbol");
        let view_refs = query_graph(&root, &user_view.id, 20, &config)?
            .expect("user_view refs")
            .references;
        assert_eq!(view_refs.len(), 1);
        assert_eq!(view_refs[0].rel_path, "app/urls.py");
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    #[test]
    fn native_rebuild_handles_java_spring_annotations_records_and_overrides() -> io::Result<()> {
        let root = temp_dir("graph-java-spring");
        let src = root.join("src/main/java/app");
        fs::create_dir_all(&src)?;
        fs::write(
            src.join("Api.java"),
            r#"package app;

interface Handler {
    String getUser();
}

@RestController
class UserController implements Handler {
    public static final String KIND = "controller";

    @GetMapping("/users/{id}")
    public String getUser() {
        return KIND;
    }

    @Scheduled(cron = "* * * * * *")
    public void tick() {}
}

record UserRecord(String id) implements Handler {
    public String getUser() {
        return id;
    }
}
"#,
        )?;
        let config = EngineConfig::default();
        let summary = rebuild_graph_native(&root, 546, &config, 8, &mut |_| {})?;
        assert_eq!(summary.file_count, 1);
        let document = query_graph_document_symbols(
            &root,
            &file_uri(&src.join("Api.java")),
            None,
            None,
            100,
            &config,
        )?
        .expect("java document symbols");
        let names: BTreeSet<String> = document
            .symbols
            .iter()
            .map(|symbol| symbol.name.clone())
            .collect();
        for expected in [
            "Handler",
            "UserController",
            "UserRecord",
            "KIND",
            "getUser",
            "tick",
        ] {
            assert!(
                names.contains(expected),
                "missing Java/Spring symbol {expected}: {names:?}"
            );
        }
        let handler = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "Handler")
            .expect("Handler interface");
        assert_eq!(handler.implementation_count, Some(2));
        let route_method = document
            .symbols
            .iter()
            .find(|symbol| {
                symbol.name == "getUser"
                    && symbol.container_name.as_deref() == Some("app.UserController")
            })
            .expect("controller getUser");
        assert_eq!(route_method.implementation_count, Some(1));
        let tick = document
            .symbols
            .iter()
            .find(|symbol| symbol.name == "tick")
            .expect("scheduled method");
        assert_eq!(tick.implementation_count, Some(1));
        let _ = fs::remove_dir_all(root);
        Ok(())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
