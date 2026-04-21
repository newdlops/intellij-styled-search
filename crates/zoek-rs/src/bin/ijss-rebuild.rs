use std::env;
use std::path::PathBuf;

use zoek_rs::config::EngineConfig;
use zoek_rs::indexer::index_directory_with_progress;
use zoek_rs::protocol::{EngineInfo, EngineResponse, ErrorResponse, IndexRequest, IndexResponse, IndexStats};

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
                let value = args.get(idx + 1).ok_or_else(|| "--out requires a path".to_string())?;
                request.index_dir = Some(value.clone());
                config.index_dir_name = value.clone();
                idx += 2;
            }
            "--force" => {
                request.force = true;
                idx += 1;
            }
            other => return Err(format!("unknown rebuild flag: {other}")),
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

fn usage() -> String {
    "usage: ijss-rebuild <workspace> [--out <path>] [--force]".to_string()
}
