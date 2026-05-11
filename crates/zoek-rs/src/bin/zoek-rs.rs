use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use zoek_rs::config::EngineConfig;
use zoek_rs::graph::{
    index_graph_from_tsv, query_graph, query_graph_callees,
    query_graph_document_symbols_with_options, query_graph_implementations,
    query_graph_symbols_with_options, rebuild_graph_native, update_graph_native, GraphSymbol,
    GraphSymbolQueryOptions,
};
use zoek_rs::indexer::index_directory_with_progress;
use zoek_rs::mmap_store::StoreLayout;
use zoek_rs::ops::{benchmark_workspaces, collect_info, diagnose_query};
use zoek_rs::overlay::{apply_change_batch, load_overlay_with_recovery};
use zoek_rs::protocol::{
    BenchmarkResponse, DiagnoseResponse, EngineInfo, EngineResponse, ErrorResponse,
    GraphIndexResponse, GraphQueryReference, GraphQueryResponse, GraphSymbolQueryResponse,
    GraphSymbolResponse, IndexRequest, IndexResponse, IndexStats, InfoResponse,
    OverlayUpdateResponse, SearchRequest,
};
use zoek_rs::searcher::{search_workspace, search_workspace_streaming};
use zoek_rs::shard::ShardReader;
use zoek_rs::watcher::{build_change_batch, ChangeBatch, FileChange, FileChangeKind};

const SEARCH_STREAM_PREFIX: &str = "__ZOEK_SEARCH__";

fn main() {
    let response = match run(env::args().skip(1).collect()) {
        Ok(response) => response,
        Err(message) => EngineResponse::Error(ErrorResponse {
            ok: false,
            engine: EngineInfo::current(),
            message,
        }),
    };
    println!("{}", response.to_json());
}

fn run(args: Vec<String>) -> Result<EngineResponse, String> {
    let Some(command) = args.first() else {
        return Err(usage());
    };
    match command.as_str() {
        "index" => run_index(&args[1..]),
        "compact" => run_compact(&args[1..]),
        "update" => run_update(&args[1..]),
        "search" => run_search(&args[1..]),
        "info" => run_info(&args[1..]),
        "diagnose" => run_diagnose(&args[1..]),
        "benchmark" => run_benchmark(&args[1..]),
        "graph-rebuild" => run_graph_rebuild(&args[1..]),
        "graph-index" => run_graph_index(&args[1..]),
        "graph-update" => run_graph_update(&args[1..]),
        "graph-query" => run_graph_query(&args[1..]),
        "graph-callees" => run_graph_callees(&args[1..]),
        "graph-symbol-query" => run_graph_symbol_query(&args[1..]),
        "graph-implementations" => run_graph_implementations(&args[1..]),
        _ => Err(usage()),
    }
}

fn run_index(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut config = EngineConfig::default();
    let mut request = IndexRequest {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_dir: None,
        force: false,
    };

    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--out" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--out requires a path".to_string())?;
                request.index_dir = Some(value.clone());
                config.index_dir_name = value.clone();
                idx += 2;
            }
            "--force" => {
                request.force = true;
                idx += 1;
            }
            other => return Err(format!("unknown index flag: {other}")),
        }
    }

    let artifacts = index_directory_with_progress(&workspace_root, &config, &mut |progress| {
        eprintln!("{}", progress.to_stderr_line());
    })
    .map_err(|err| err.to_string())?;
    Ok(EngineResponse::Index(IndexResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: request.workspace_root,
        index_dir: artifacts.layout.root.to_string_lossy().into_owned(),
        indexed_at_unix_secs: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        stats: IndexStats {
            total_files: artifacts.summary.total_files,
            indexed_files: artifacts.summary.indexed_files,
            skipped_binary: artifacts.summary.skipped_binary,
            skipped_too_large: artifacts.summary.skipped_too_large,
            shard_count: artifacts.summary.shard_count,
            overlay_entries: artifacts.summary.overlay_entries,
            total_grams: artifacts.summary.total_grams,
        },
        warnings: Vec::new(),
    }))
}

fn run_compact(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let config = EngineConfig::default();
    let artifacts = index_directory_with_progress(&workspace_root, &config, &mut |progress| {
        eprintln!("{}", progress.to_stderr_line());
    })
    .map_err(|err| err.to_string())?;
    Ok(EngineResponse::Index(IndexResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_dir: artifacts.layout.root.to_string_lossy().into_owned(),
        indexed_at_unix_secs: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        stats: IndexStats {
            total_files: artifacts.summary.total_files,
            indexed_files: artifacts.summary.indexed_files,
            skipped_binary: artifacts.summary.skipped_binary,
            skipped_too_large: artifacts.summary.skipped_too_large,
            shard_count: artifacts.summary.shard_count,
            overlay_entries: artifacts.summary.overlay_entries,
            total_grams: artifacts.summary.total_grams,
        },
        warnings: vec!["overlay state compacted into a fresh base snapshot".to_string()],
    }))
}

fn run_update(args: &[String]) -> Result<EngineResponse, String> {
    let started = Instant::now();
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let config = EngineConfig::default();
    let layout = StoreLayout::for_workspace(&workspace_root, &config);
    let current_generation = load_overlay_with_recovery(&layout)
        .map(|result| result.manifest.generation)
        .unwrap_or(0);

    let mut changed_paths = Vec::new();
    let mut deleted_paths = Vec::new();
    let mut renamed_paths = Vec::new();
    let mut sync_workspace = false;
    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--sync" => {
                sync_workspace = true;
                idx += 1;
            }
            "--delete" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--delete requires a path".to_string())?;
                deleted_paths.push(value.clone());
                idx += 2;
            }
            "--rename" => {
                let old_path = args
                    .get(idx + 1)
                    .ok_or_else(|| "--rename requires old and new paths".to_string())?;
                let new_path = args
                    .get(idx + 2)
                    .ok_or_else(|| "--rename requires old and new paths".to_string())?;
                renamed_paths.push((old_path.clone(), new_path.clone()));
                idx += 3;
            }
            other => {
                changed_paths.push(other.to_string());
                idx += 1;
            }
        }
    }

    let batch = if sync_workspace {
        build_workspace_sync_batch(&workspace_root, &layout, &config, current_generation)
            .map_err(|err| err.to_string())?
    } else {
        build_change_batch(
            current_generation,
            &changed_paths,
            &deleted_paths,
            &renamed_paths,
        )
    };
    let summary = apply_change_batch(&workspace_root, &layout, &config, &batch)
        .map_err(|err| err.to_string())?;
    let mut warnings = Vec::new();
    if let Some(reason) = summary.compaction_trigger_reason.clone() {
        if summary.compaction_performed {
            warnings.push(format!("overlay compacted: {reason}"));
        }
    }
    if let Some(reason) = summary.compaction_reason.clone() {
        warnings.push(format!("compaction suggested: {reason}"));
    }

    Ok(EngineResponse::Update(OverlayUpdateResponse {
        ok: true,
        engine: EngineInfo::current(),
        generation: summary.generation,
        entries_written: summary.entries_written,
        live_entries: summary.live_entries,
        tombstones: summary.tombstones,
        overlay_total_entries: summary.overlay_total_entries,
        latest_visible_entries: summary.latest_visible_entries,
        journal_bytes: summary.journal_bytes,
        compaction_suggested: summary.compaction_suggested,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        warnings,
    }))
}

fn build_workspace_sync_batch(
    workspace_root: &Path,
    layout: &StoreLayout,
    config: &EngineConfig,
    current_generation: u64,
) -> io::Result<ChangeBatch> {
    let base_docs = collect_base_doc_hashes(layout)?;
    let overlay_latest = load_overlay_with_recovery(layout)
        .map(|result| result.manifest.latest_entries())
        .unwrap_or_default();
    let current_files = collect_current_index_candidates(workspace_root, config)?;
    let mut changed = Vec::new();
    let mut deleted = Vec::new();
    let mut seen = BTreeSet::new();

    for (rel_path, current_hash) in current_files {
        seen.insert(rel_path.clone());
        if config.is_overlay_update_excluded_relative_path(&rel_path) {
            continue;
        }
        match overlay_latest.get(&rel_path) {
            Some(entry) if !entry.tombstone => {
                changed.push(rel_path);
                continue;
            }
            Some(_) => {
                changed.push(rel_path);
                continue;
            }
            None => {}
        }
        if base_docs.get(&rel_path).copied() != Some(current_hash) {
            changed.push(rel_path);
        }
    }

    for rel_path in base_docs.keys() {
        if !seen.contains(rel_path) {
            deleted.push(rel_path.clone());
        }
    }
    for (rel_path, entry) in overlay_latest {
        if !entry.tombstone && !seen.contains(&rel_path) {
            deleted.push(rel_path);
        }
    }
    changed.sort();
    changed.dedup();
    deleted.sort();
    deleted.dedup();

    Ok(ChangeBatch {
        generation: current_generation.saturating_add(1),
        committed_unix_secs: 0,
        changes: changed
            .into_iter()
            .map(|rel_path| FileChange {
                kind: FileChangeKind::Modify,
                rel_path,
                new_rel_path: None,
            })
            .chain(deleted.into_iter().map(|rel_path| FileChange {
                kind: FileChangeKind::Delete,
                rel_path,
                new_rel_path: None,
            }))
            .collect(),
    })
}

fn collect_base_doc_hashes(layout: &StoreLayout) -> io::Result<BTreeMap<String, u64>> {
    let mut out = BTreeMap::new();
    for shard_path in layout.list_shard_paths()? {
        let reader = ShardReader::open(&shard_path)?;
        for doc in reader.documents()? {
            out.insert(doc.rel_path, doc.content_hash);
        }
    }
    Ok(out)
}

fn collect_current_index_candidates(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<BTreeMap<String, u64>> {
    if let Some(files) = list_files_with_rg(workspace_root)? {
        return stat_current_candidates(workspace_root, config, files);
    }
    let mut files = Vec::new();
    collect_files_walk(workspace_root, workspace_root, config, &mut files)?;
    stat_current_candidates(workspace_root, config, files)
}

fn list_files_with_rg(workspace_root: &Path) -> io::Result<Option<Vec<String>>> {
    let output = match Command::new("rg")
        .current_dir(workspace_root)
        .args([
            "--files",
            "--hidden",
            "--no-ignore",
            "--no-ignore-parent",
            "--glob",
            "!.zoek-rs/**",
            "--glob",
            "!.zoekt-rs/**",
            ".",
        ])
        .output()
    {
        Ok(output) => output,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok(Some(
        stdout
            .lines()
            .map(|line| normalize_sync_rel_path(line.trim()))
            .filter(|line| !line.is_empty())
            .collect(),
    ))
}

fn collect_files_walk(
    workspace_root: &Path,
    dir: &Path,
    config: &EngineConfig,
    out: &mut Vec<String>,
) -> io::Result<()> {
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let file_type = item.file_type()?;
        if file_type.is_dir() {
            let name = item.file_name();
            let name = name.to_string_lossy();
            if config.is_internal_index_dir_name(&name) || config.is_excluded_dir_name(&name) {
                continue;
            }
            collect_files_walk(workspace_root, &path, config, out)?;
        } else if file_type.is_file() {
            out.push(normalize_sync_rel_path(
                &path
                    .strip_prefix(workspace_root)
                    .unwrap_or(&path)
                    .to_string_lossy(),
            ));
        }
    }
    Ok(())
}

fn stat_current_candidates(
    workspace_root: &Path,
    config: &EngineConfig,
    files: Vec<String>,
) -> io::Result<BTreeMap<String, u64>> {
    let mut out = BTreeMap::new();
    for rel_path in files {
        if rel_path.is_empty() || config.is_overlay_update_excluded_relative_path(&rel_path) {
            continue;
        }
        let abs_path = workspace_root.join(&rel_path);
        if config.is_binary_extension(&abs_path) {
            continue;
        }
        let metadata = match fs::metadata(&abs_path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        if !metadata.is_file() || metadata.len() > config.max_file_size_bytes {
            continue;
        }
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        out.insert(
            rel_path.clone(),
            zoek_rs::indexer::stable_record_hash(&rel_path, metadata.len(), modified_unix_secs),
        );
    }
    Ok(out)
}

fn normalize_sync_rel_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn run_search(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let query = args.get(1).cloned().ok_or_else(usage)?;
    let mut request = SearchRequest {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        query,
        query_terms: Vec::new(),
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        regex_multiline: true,
        include: Vec::new(),
        exclude: Vec::new(),
        path_regex: None,
        limit: 200,
        offset: 0,
    };
    let mut stream = false;

    let mut idx = 2;
    while idx < args.len() {
        match args[idx].as_str() {
            "--stream" => {
                stream = true;
                idx += 1;
            }
            "--case-sensitive" => {
                request.case_sensitive = true;
                idx += 1;
            }
            "--whole-word" => {
                request.whole_word = true;
                idx += 1;
            }
            "--regex" => {
                request.use_regex = true;
                idx += 1;
            }
            "--regex-singleline" => {
                request.regex_multiline = false;
                idx += 1;
            }
            "--include" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--include requires a value".to_string())?;
                request.include.push(value.clone());
                idx += 2;
            }
            "--exclude" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--exclude requires a value".to_string())?;
                request.exclude.push(value.clone());
                idx += 2;
            }
            "--path-regex" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--path-regex requires a value".to_string())?;
                request.path_regex = Some(value.clone());
                idx += 2;
            }
            "--or-query" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--or-query requires a value".to_string())?;
                request.query_terms.push(value.clone());
                idx += 2;
            }
            "--limit" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--limit requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer".to_string())?;
                request.limit = value.max(1);
                idx += 2;
            }
            "--offset" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--offset requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--offset must be an integer".to_string())?;
                request.offset = value;
                idx += 2;
            }
            other => return Err(format!("unknown search flag: {other}")),
        }
    }

    let response = if stream {
        search_workspace_streaming(&request, &EngineConfig::default(), |file| {
            eprintln!(
                "{}{{\"type\":\"search:file\",\"file\":{}}}",
                SEARCH_STREAM_PREFIX,
                file.to_json()
            );
            Ok(())
        })?
    } else {
        search_workspace(&request, &EngineConfig::default())?
    };
    Ok(EngineResponse::Search(response))
}

fn run_info(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let response: InfoResponse =
        collect_info(&workspace_root, &EngineConfig::default()).map_err(|err| err.to_string())?;
    Ok(EngineResponse::Info(response))
}

fn run_diagnose(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let query = args.get(1).cloned().ok_or_else(usage)?;
    let mut request = SearchRequest {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        query,
        query_terms: Vec::new(),
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        regex_multiline: true,
        include: Vec::new(),
        exclude: Vec::new(),
        path_regex: None,
        limit: 200,
        offset: 0,
    };

    let mut idx = 2;
    while idx < args.len() {
        match args[idx].as_str() {
            "--case-sensitive" => {
                request.case_sensitive = true;
                idx += 1;
            }
            "--whole-word" => {
                request.whole_word = true;
                idx += 1;
            }
            "--regex" => {
                request.use_regex = true;
                idx += 1;
            }
            "--regex-singleline" => {
                request.regex_multiline = false;
                idx += 1;
            }
            "--include" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--include requires a value".to_string())?;
                request.include.push(value.clone());
                idx += 2;
            }
            "--exclude" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--exclude requires a value".to_string())?;
                request.exclude.push(value.clone());
                idx += 2;
            }
            "--path-regex" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--path-regex requires a value".to_string())?;
                request.path_regex = Some(value.clone());
                idx += 2;
            }
            "--or-query" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--or-query requires a value".to_string())?;
                request.query_terms.push(value.clone());
                idx += 2;
            }
            other => return Err(format!("unknown diagnose flag: {other}")),
        }
    }

    let response: DiagnoseResponse = diagnose_query(&request, &EngineConfig::default())?;
    Ok(EngineResponse::Diagnose(response))
}

fn run_benchmark(args: &[String]) -> Result<EngineResponse, String> {
    let mut file_counts = vec![10_000usize, 50_000usize, 100_000usize];
    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--files" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--files requires a comma-separated list".to_string())?;
                file_counts = value
                    .split(',')
                    .map(|item| {
                        item.trim()
                            .parse::<usize>()
                            .map_err(|_| format!("invalid file count: {item}"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                idx += 2;
            }
            other => return Err(format!("unknown benchmark flag: {other}")),
        }
    }
    let response: BenchmarkResponse = benchmark_workspaces(&file_counts, &EngineConfig::default())?;
    Ok(EngineResponse::Benchmark(response))
}

fn run_graph_index(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut input_path: Option<PathBuf> = None;
    let mut built_at_unix_ms = 0u64;
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--input" => {
                let value = args
                    .get(idx + 1)
                    .ok_or_else(|| "--input requires a path".to_string())?;
                input_path = Some(PathBuf::from(value));
                idx += 2;
            }
            "--built-at" => {
                built_at_unix_ms = args
                    .get(idx + 1)
                    .ok_or_else(|| "--built-at requires a value".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "--built-at must be an integer".to_string())?;
                idx += 2;
            }
            other => return Err(format!("unknown graph-index flag: {other}")),
        }
    }
    let input_path = input_path.ok_or_else(|| "--input requires a path".to_string())?;
    let summary = index_graph_from_tsv(
        &workspace_root,
        &input_path,
        built_at_unix_ms,
        &EngineConfig::default(),
    )
    .map_err(|err| err.to_string())?;
    Ok(EngineResponse::GraphIndex(GraphIndexResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: summary.workspace_root,
        index_path: summary.index_path,
        indexed_at_unix_secs: summary.indexed_at_unix_secs,
        built_at_unix_ms: summary.built_at_unix_ms,
        file_count: summary.file_count,
        symbol_count: summary.symbol_count,
        reference_count: summary.reference_count,
        bytes: summary.bytes,
        warnings: Vec::new(),
    }))
}

fn run_graph_rebuild(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut built_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    let mut config = EngineConfig::default();
    let mut worker_count = 64usize;
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--built-at" => {
                built_at_unix_ms = args
                    .get(idx + 1)
                    .ok_or_else(|| "--built-at requires a value".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "--built-at must be an integer".to_string())?;
                idx += 2;
            }
            "--max-file-size" => {
                config.max_file_size_bytes = args
                    .get(idx + 1)
                    .ok_or_else(|| "--max-file-size requires a value".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "--max-file-size must be an integer".to_string())?;
                if config.max_file_size_bytes == 0 {
                    config.max_file_size_bytes = u64::MAX;
                }
                idx += 2;
            }
            "--workers" => {
                worker_count = args
                    .get(idx + 1)
                    .ok_or_else(|| "--workers requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--workers must be an integer".to_string())?
                    .max(1)
                    .min(64);
                idx += 2;
            }
            other => return Err(format!("unknown graph-rebuild flag: {other}")),
        }
    }
    let summary = rebuild_graph_native(
        &workspace_root,
        built_at_unix_ms,
        &config,
        worker_count,
        &mut |progress| {
            eprintln!(
                "graph-rebuild progress: stage={} current={} total={} message={}",
                progress.stage, progress.current, progress.total, progress.message
            );
        },
    )
    .map_err(|err| err.to_string())?;
    Ok(EngineResponse::GraphIndex(GraphIndexResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: summary.workspace_root,
        index_path: summary.index_path,
        indexed_at_unix_secs: summary.indexed_at_unix_secs,
        built_at_unix_ms: summary.built_at_unix_ms,
        file_count: summary.file_count,
        symbol_count: summary.symbol_count,
        reference_count: summary.reference_count,
        bytes: summary.bytes,
        warnings: vec!["built by rust-native graph-rebuild".to_string()],
    }))
}

fn run_graph_update(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut config = EngineConfig::default();
    let mut built_at_unix_ms = 0u64;
    let mut max_file_size: Option<u64> = None;
    let mut workers = 0usize;
    let mut changed_paths = Vec::new();
    let mut deleted_paths = Vec::new();
    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
            "--built-at" => {
                built_at_unix_ms = args
                    .get(idx + 1)
                    .ok_or_else(|| "--built-at requires a value".to_string())?
                    .parse::<u64>()
                    .map_err(|err| format!("invalid --built-at: {err}"))?;
                idx += 2;
            }
            "--max-file-size" => {
                max_file_size = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--max-file-size requires a value".to_string())?
                        .parse::<u64>()
                        .map_err(|err| format!("invalid --max-file-size: {err}"))?,
                );
                idx += 2;
            }
            "--workers" => {
                workers = args
                    .get(idx + 1)
                    .ok_or_else(|| "--workers requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|err| format!("invalid --workers: {err}"))?;
                idx += 2;
            }
            "--delete" => {
                deleted_paths.push(PathBuf::from(
                    args.get(idx + 1)
                        .ok_or_else(|| "--delete requires a path".to_string())?,
                ));
                idx += 2;
            }
            other => {
                changed_paths.push(PathBuf::from(other));
                idx += 1;
            }
        }
    }
    if let Some(limit) = max_file_size {
        config.max_file_size_bytes = if limit == 0 { u64::MAX } else { limit };
    }
    let summary = update_graph_native(
        &workspace_root,
        &changed_paths,
        &deleted_paths,
        built_at_unix_ms,
        &config,
        workers,
    )
    .map_err(|err| err.to_string())?;
    Ok(EngineResponse::GraphIndex(GraphIndexResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: summary.workspace_root,
        index_path: summary.index_path,
        indexed_at_unix_secs: summary.indexed_at_unix_secs,
        built_at_unix_ms: summary.built_at_unix_ms,
        file_count: summary.file_count,
        symbol_count: summary.symbol_count,
        reference_count: summary.reference_count,
        bytes: summary.bytes,
        warnings: vec!["updated by rust-native graph-update".to_string()],
    }))
}

fn run_graph_query(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut symbol_id: Option<String> = None;
    let mut limit = 500usize;
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--symbol-id" => {
                symbol_id = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--symbol-id requires a value".to_string())?
                        .clone(),
                );
                idx += 2;
            }
            "--limit" => {
                limit = args
                    .get(idx + 1)
                    .ok_or_else(|| "--limit requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer".to_string())?
                    .max(1);
                idx += 2;
            }
            other => return Err(format!("unknown graph-query flag: {other}")),
        }
    }
    let symbol_id = symbol_id.ok_or_else(|| "--symbol-id requires a value".to_string())?;
    let result = query_graph(&workspace_root, &symbol_id, limit, &EngineConfig::default())
        .map_err(|err| err.to_string())?;
    let Some(result) = result else {
        return Ok(EngineResponse::GraphQuery(GraphQueryResponse {
            ok: true,
            engine: EngineInfo::current(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            symbol_id,
            built_at_unix_ms: 0,
            total_references: 0,
            references: Vec::new(),
            warnings: vec!["call graph binary index missing".to_string()],
        }));
    };
    Ok(EngineResponse::GraphQuery(GraphQueryResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: result.workspace_root,
        symbol_id: result.symbol_id,
        built_at_unix_ms: result.built_at_unix_ms,
        total_references: result.total_references,
        references: result
            .references
            .into_iter()
            .map(|reference| GraphQueryReference {
                target_symbol_id: reference.target_symbol_id,
                edge_kind: reference.edge_kind,
                name: reference.name,
                raw_text: reference.raw_text,
                uri: reference.uri,
                rel_path: reference.rel_path,
                start_line: reference.start_line,
                start_column: reference.start_column,
                end_line: reference.end_line,
                end_column: reference.end_column,
                enclosing_symbol_id: reference.enclosing_symbol_id,
            })
            .collect(),
        warnings: Vec::new(),
    }))
}

fn run_graph_callees(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut symbol_id: Option<String> = None;
    let mut limit = 500usize;
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--symbol-id" => {
                symbol_id = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--symbol-id requires a value".to_string())?
                        .clone(),
                );
                idx += 2;
            }
            "--limit" => {
                limit = args
                    .get(idx + 1)
                    .ok_or_else(|| "--limit requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer".to_string())?
                    .max(1);
                idx += 2;
            }
            other => return Err(format!("unknown graph-callees flag: {other}")),
        }
    }
    let symbol_id = symbol_id.ok_or_else(|| "--symbol-id requires a value".to_string())?;
    let result = query_graph_callees(&workspace_root, &symbol_id, limit, &EngineConfig::default())
        .map_err(|err| err.to_string())?;
    let Some(result) = result else {
        return Ok(EngineResponse::GraphQuery(GraphQueryResponse {
            ok: true,
            engine: EngineInfo::current(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            symbol_id,
            built_at_unix_ms: 0,
            total_references: 0,
            references: Vec::new(),
            warnings: vec!["call graph binary index missing".to_string()],
        }));
    };
    Ok(EngineResponse::GraphQuery(GraphQueryResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: result.workspace_root,
        symbol_id: result.symbol_id,
        built_at_unix_ms: result.built_at_unix_ms,
        total_references: result.total_references,
        references: result
            .references
            .into_iter()
            .map(|reference| GraphQueryReference {
                target_symbol_id: reference.target_symbol_id,
                edge_kind: reference.edge_kind,
                name: reference.name,
                raw_text: reference.raw_text,
                uri: reference.uri,
                rel_path: reference.rel_path,
                start_line: reference.start_line,
                start_column: reference.start_column,
                end_line: reference.end_line,
                end_column: reference.end_column,
                enclosing_symbol_id: reference.enclosing_symbol_id,
            })
            .collect(),
        warnings: Vec::new(),
    }))
}

fn run_graph_symbol_query(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut query = String::new();
    let mut uri: Option<String> = None;
    let mut start_line: Option<u32> = None;
    let mut end_line: Option<u32> = None;
    let mut limit = 200usize;
    let mut options = GraphSymbolQueryOptions::default();
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--query" => {
                query = args
                    .get(idx + 1)
                    .ok_or_else(|| "--query requires a value".to_string())?
                    .clone();
                idx += 2;
            }
            "--uri" => {
                uri = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--uri requires a value".to_string())?
                        .clone(),
                );
                idx += 2;
            }
            "--start-line" => {
                start_line = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--start-line requires a value".to_string())?
                        .parse::<u32>()
                        .map_err(|_| "--start-line must be an integer".to_string())?,
                );
                idx += 2;
            }
            "--end-line" => {
                end_line = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--end-line requires a value".to_string())?
                        .parse::<u32>()
                        .map_err(|_| "--end-line must be an integer".to_string())?,
                );
                idx += 2;
            }
            "--limit" => {
                limit = args
                    .get(idx + 1)
                    .ok_or_else(|| "--limit requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer".to_string())?
                    .max(1);
                idx += 2;
            }
            "--no-usage-counts" => {
                options.include_usage_counts = false;
                idx += 1;
            }
            "--no-implementation-counts" => {
                options.include_implementation_counts = false;
                idx += 1;
            }
            other => return Err(format!("unknown graph-symbol-query flag: {other}")),
        }
    }
    let result = if let Some(uri) = uri {
        query_graph_document_symbols_with_options(
            &workspace_root,
            &uri,
            start_line,
            end_line,
            limit,
            &EngineConfig::default(),
            options,
        )
    } else {
        query_graph_symbols_with_options(
            &workspace_root,
            &query,
            limit,
            &EngineConfig::default(),
            options,
        )
    }
    .map_err(|err| err.to_string())?;
    let Some(result) = result else {
        return Ok(EngineResponse::GraphSymbolQuery(GraphSymbolQueryResponse {
            ok: true,
            engine: EngineInfo::current(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            built_at_unix_ms: 0,
            total_symbols: 0,
            symbols: Vec::new(),
            warnings: vec!["call graph symbol index missing".to_string()],
        }));
    };
    Ok(EngineResponse::GraphSymbolQuery(GraphSymbolQueryResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: result.workspace_root,
        built_at_unix_ms: result.built_at_unix_ms,
        total_symbols: result.total_symbols,
        symbols: result
            .symbols
            .into_iter()
            .map(graph_symbol_response_from_symbol)
            .collect(),
        warnings: Vec::new(),
    }))
}

fn run_graph_implementations(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let mut symbol_id: Option<String> = None;
    let mut limit = 200usize;
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--symbol-id" => {
                symbol_id = Some(
                    args.get(idx + 1)
                        .ok_or_else(|| "--symbol-id requires a value".to_string())?
                        .clone(),
                );
                idx += 2;
            }
            "--limit" => {
                limit = args
                    .get(idx + 1)
                    .ok_or_else(|| "--limit requires a value".to_string())?
                    .parse::<usize>()
                    .map_err(|_| "--limit must be an integer".to_string())?
                    .max(1);
                idx += 2;
            }
            other => return Err(format!("unknown graph-implementations flag: {other}")),
        }
    }
    let symbol_id = symbol_id.ok_or_else(|| "--symbol-id requires a value".to_string())?;
    let result =
        query_graph_implementations(&workspace_root, &symbol_id, limit, &EngineConfig::default())
            .map_err(|err| err.to_string())?;
    let Some(result) = result else {
        return Ok(EngineResponse::GraphSymbolQuery(GraphSymbolQueryResponse {
            ok: true,
            engine: EngineInfo::current(),
            workspace_root: workspace_root.to_string_lossy().into_owned(),
            built_at_unix_ms: 0,
            total_symbols: 0,
            symbols: Vec::new(),
            warnings: vec!["call graph implementation index missing".to_string()],
        }));
    };
    Ok(EngineResponse::GraphSymbolQuery(GraphSymbolQueryResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: result.workspace_root,
        built_at_unix_ms: result.built_at_unix_ms,
        total_symbols: result.total_symbols,
        symbols: result
            .symbols
            .into_iter()
            .map(graph_symbol_response_from_symbol)
            .collect(),
        warnings: Vec::new(),
    }))
}

fn graph_symbol_response_from_symbol(symbol: GraphSymbol) -> GraphSymbolResponse {
    GraphSymbolResponse {
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
        container_id: symbol.container_id,
        container_name: symbol.container_name,
        package_name: symbol.package_name,
        extends_names: symbol.extends_names,
        implements_names: symbol.implements_names,
        usage_count: symbol.usage_count,
        implementation_count: symbol.implementation_count,
    }
}

fn usage() -> String {
    "usage: zoek-rs <index|compact|update|search|info|diagnose|benchmark|graph-rebuild|graph-index|graph-update|graph-query|graph-callees|graph-symbol-query|graph-implementations> ...".to_string()
}
