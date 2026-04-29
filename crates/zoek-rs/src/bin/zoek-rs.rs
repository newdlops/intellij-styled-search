use std::env;
use std::path::PathBuf;

use zoek_rs::config::EngineConfig;
use zoek_rs::indexer::index_directory_with_progress;
use zoek_rs::mmap_store::StoreLayout;
use zoek_rs::ops::{benchmark_workspaces, collect_info, diagnose_query};
use zoek_rs::overlay::{apply_change_batch, load_overlay_with_recovery};
use zoek_rs::protocol::{
    BenchmarkResponse, DiagnoseResponse, EngineInfo, EngineResponse, ErrorResponse, IndexRequest,
    IndexResponse, IndexStats, InfoResponse, OverlayUpdateResponse, SearchRequest,
};
use zoek_rs::searcher::search_workspace;
use zoek_rs::watcher::build_change_batch;

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
        warnings: if request.force {
            vec!["force flag accepted but phase5 still rebuilds from scratch".to_string()]
        } else {
            Vec::new()
        },
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
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let config = EngineConfig::default();
    let layout = StoreLayout::for_workspace(&workspace_root, &config);
    let current_generation = load_overlay_with_recovery(&layout)
        .map(|result| result.manifest.generation)
        .unwrap_or(0);

    let mut changed_paths = Vec::new();
    let mut deleted_paths = Vec::new();
    let mut renamed_paths = Vec::new();
    let mut idx = 1;
    while idx < args.len() {
        match args[idx].as_str() {
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

    let batch = build_change_batch(
        current_generation,
        &changed_paths,
        &deleted_paths,
        &renamed_paths,
    );
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
        warnings,
    }))
}

fn run_search(args: &[String]) -> Result<EngineResponse, String> {
    let workspace_root = PathBuf::from(args.first().cloned().ok_or_else(usage)?);
    let query = args.get(1).cloned().ok_or_else(usage)?;
    let mut request = SearchRequest {
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        query,
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        regex_multiline: true,
        include: Vec::new(),
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

    let response = search_workspace(&request, &EngineConfig::default())?;
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
        case_sensitive: false,
        whole_word: false,
        use_regex: false,
        regex_multiline: true,
        include: Vec::new(),
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

fn usage() -> String {
    "usage: zoek-rs <index|compact|update|search|info|diagnose|benchmark> ...".to_string()
}
