use crate::config::{EngineConfig, ENGINE_NAME, SCHEMA_VERSION};
use crate::corpus::{
    decode_bytes_owned, read_file_bytes_if_not_binary, CorpusStats, ReadTextBytesOutcome,
    TextEncoding,
};
use crate::mmap_store::{write_atomically, StoreLayout};
use crate::overlay::OverlayManifest;
use crate::protocol::json_string;
use crate::shard::{build_shard_bytes, IndexedDocument, ShardReader};
use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::io;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct IndexSummary {
    pub total_files: usize,
    pub indexed_files: usize,
    pub skipped_binary: usize,
    pub skipped_too_large: usize,
    pub shard_count: usize,
    pub overlay_entries: usize,
    pub total_grams: usize,
    pub total_source_bytes: u64,
    pub total_shard_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct ShardArtifact {
    pub shard_id: u32,
    pub file_name: String,
    pub path: PathBuf,
    pub doc_count: usize,
    pub gram_count: usize,
    pub file_bytes: u64,
    pub source_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct IndexArtifacts {
    pub layout: StoreLayout,
    pub summary: IndexSummary,
    pub shards: Vec<ShardArtifact>,
    pub fingerprint: u64,
}

#[derive(Clone, Debug)]
pub struct IndexProgress {
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
    pub percent: usize,
    pub detail: String,
}

impl IndexProgress {
    pub fn to_stderr_line(&self) -> String {
        format!(
            "__ZOEK_PROGRESS__{{\"phase\":{},\"current\":{},\"total\":{},\"percent\":{},\"detail\":{}}}",
            json_string(self.phase),
            self.current,
            self.total,
            self.percent,
            json_string(&self.detail),
        )
    }
}

#[derive(Clone, Debug)]
struct IndexFileRecord {
    rel_path: String,
    abs_path: PathBuf,
    size_bytes: u64,
    modified_unix_secs: u64,
    metadata_known: bool,
}

enum IndexedRecordOutcome {
    Indexed {
        document: IndexedDocument,
        encoding: TextEncoding,
    },
    SkippedBinary,
    SkippedTooLarge,
    SkippedMissing,
}

const SAMPLED_INDEX_THRESHOLD_BYTES: u64 = 16 * 1024;
const SAMPLED_INDEX_PREFIX_BYTES: usize = 16 * 1024;
const SAMPLED_INDEX_CHUNK_BYTES: usize = 4 * 1024;

pub fn index_directory(workspace_root: &Path, config: &EngineConfig) -> io::Result<IndexArtifacts> {
    let mut noop = |_progress: IndexProgress| {};
    index_directory_with_progress(workspace_root, config, &mut noop)
}

pub fn index_directory_with_progress<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    progress: &mut F,
) -> io::Result<IndexArtifacts>
where
    F: FnMut(IndexProgress),
{
    let layout = StoreLayout::for_workspace(workspace_root, config);
    layout.ensure_dirs()?;
    let _ = layout.cleanup_stale_temp_files(30);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);

    if let Some(artifacts) =
        try_reuse_clean_existing_index(workspace_root, config, &layout, now, progress)?
    {
        return Ok(artifacts);
    }

    let (shard_artifacts, corpus_stats, fingerprint) =
        write_base_shards_from_workspace(workspace_root, config, &layout, now, progress)?;
    let total_grams = shard_artifacts
        .iter()
        .map(|artifact| artifact.gram_count)
        .sum();
    let total_source_bytes = shard_artifacts
        .iter()
        .map(|artifact| artifact.source_bytes)
        .sum();
    let total_shard_bytes = shard_artifacts
        .iter()
        .map(|artifact| artifact.file_bytes)
        .sum();

    let overlay = OverlayManifest::empty();
    write_atomically(&layout.overlay_path, overlay.to_json().as_bytes())?;
    let _ = fs::remove_file(&layout.overlay_journal_path);
    write_atomically(
        &layout.manifest_path,
        build_manifest_json(
            workspace_root,
            &layout.root,
            now,
            fingerprint,
            &layout.overlay_journal_path,
            &corpus_stats,
            &shard_artifacts,
            total_grams,
            total_source_bytes,
            total_shard_bytes,
        )
        .as_bytes(),
    )?;
    layout.clear_base_shards_from(shard_artifacts.len())?;

    progress(IndexProgress {
        phase: "done",
        current: 1,
        total: 1,
        percent: 100,
        detail: "index ready".to_string(),
    });

    Ok(IndexArtifacts {
        layout,
        summary: IndexSummary {
            total_files: corpus_stats.visited_files,
            indexed_files: corpus_stats.indexed_files,
            skipped_binary: corpus_stats.skipped_binary + corpus_stats.skipped_binary_extension,
            skipped_too_large: corpus_stats.skipped_too_large,
            shard_count: shard_artifacts.len(),
            overlay_entries: overlay.entries.len(),
            total_grams,
            total_source_bytes,
            total_shard_bytes,
        },
        shards: shard_artifacts,
        fingerprint,
    })
}

#[derive(Clone, Copy, Debug)]
struct ExistingIndexSummary {
    created_unix_secs: u64,
    fingerprint: u64,
    total_files: usize,
    indexed_files: usize,
    skipped_binary: usize,
    skipped_binary_extension: usize,
    skipped_too_large: usize,
    shard_count: usize,
    total_grams: usize,
    total_source_bytes: u64,
    total_shard_bytes: u64,
}

fn try_reuse_clean_existing_index<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    layout: &StoreLayout,
    now: u64,
    progress: &mut F,
) -> io::Result<Option<IndexArtifacts>>
where
    F: FnMut(IndexProgress),
{
    let Some(summary) = read_existing_index_summary(layout)? else {
        return Ok(None);
    };
    if !overlay_is_empty(layout)? {
        return Ok(None);
    }
    if !current_workspace_matches_existing_index(workspace_root, config, summary, progress)? {
        return Ok(None);
    }

    let shard_paths = layout.list_shard_paths()?;
    if shard_paths.len() != summary.shard_count {
        return Ok(None);
    }
    let mut shards = Vec::with_capacity(shard_paths.len());
    for (idx, path) in shard_paths.into_iter().enumerate() {
        let reader = ShardReader::open(&path)?;
        let header = reader.header().clone();
        shards.push(ShardArtifact {
            shard_id: header.shard_id,
            file_name: layout.shard_file_name(header.shard_id),
            path,
            doc_count: header.doc_count,
            gram_count: header.gram_count,
            file_bytes: header.file_len,
            source_bytes: 0,
        });
        if header.shard_id as usize != idx {
            return Ok(None);
        }
    }

    let overlay = OverlayManifest::empty();
    write_atomically(&layout.overlay_path, overlay.to_json().as_bytes())?;
    let _ = fs::remove_file(&layout.overlay_journal_path);

    progress(IndexProgress {
        phase: "done",
        current: 1,
        total: 1,
        percent: 100,
        detail: format!("reused clean index from {}", summary.created_unix_secs),
    });

    let _ = now;
    Ok(Some(IndexArtifacts {
        layout: layout.clone(),
        summary: IndexSummary {
            total_files: summary.total_files,
            indexed_files: summary.indexed_files,
            skipped_binary: summary.skipped_binary + summary.skipped_binary_extension,
            skipped_too_large: summary.skipped_too_large,
            shard_count: summary.shard_count,
            overlay_entries: 0,
            total_grams: summary.total_grams,
            total_source_bytes: summary.total_source_bytes,
            total_shard_bytes: summary.total_shard_bytes,
        },
        shards,
        fingerprint: summary.fingerprint,
    }))
}

fn read_existing_index_summary(layout: &StoreLayout) -> io::Result<Option<ExistingIndexSummary>> {
    let text = match fs::read_to_string(&layout.manifest_path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if extract_json_string(&text, "\"engine\":").as_deref() != Some(ENGINE_NAME) {
        return Ok(None);
    }
    if extract_json_u64(&text, "\"schemaVersion\":") != Some(SCHEMA_VERSION as u64) {
        return Ok(None);
    }
    let Some(created_unix_secs) = extract_json_u64(&text, "\"createdUnixSecs\":") else {
        return Ok(None);
    };
    let Some(fingerprint) = extract_json_u64(&text, "\"fingerprint\":") else {
        return Ok(None);
    };
    Ok(Some(ExistingIndexSummary {
        created_unix_secs,
        fingerprint,
        total_files: extract_json_u64(&text, "\"visitedFiles\":").unwrap_or(0) as usize,
        indexed_files: extract_json_u64(&text, "\"indexedFiles\":").unwrap_or(0) as usize,
        skipped_binary: extract_json_u64(&text, "\"skippedBinary\":").unwrap_or(0) as usize,
        skipped_binary_extension: extract_json_u64(&text, "\"skippedBinaryExtension\":")
            .unwrap_or(0) as usize,
        skipped_too_large: extract_json_u64(&text, "\"skippedTooLarge\":").unwrap_or(0) as usize,
        shard_count: extract_json_u64(&text, "\"shardCount\":").unwrap_or(0) as usize,
        total_grams: extract_json_u64(&text, "\"totalGrams\":").unwrap_or(0) as usize,
        total_source_bytes: extract_json_u64(&text, "\"totalSourceBytes\":").unwrap_or(0),
        total_shard_bytes: extract_json_u64(&text, "\"totalShardBytes\":").unwrap_or(0),
    }))
}

fn overlay_is_empty(layout: &StoreLayout) -> io::Result<bool> {
    let overlay = match fs::read_to_string(&layout.overlay_path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    if !overlay.contains("\"entries\":[]") {
        return Ok(false);
    }
    match fs::metadata(&layout.overlay_journal_path) {
        Ok(metadata) => Ok(metadata.len() == 0),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(err) => Err(err),
    }
}

fn current_workspace_matches_existing_index<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    summary: ExistingIndexSummary,
    progress: &mut F,
) -> io::Result<bool>
where
    F: FnMut(IndexProgress),
{
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
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Ok(false),
    };
    if !output.status.success() {
        return Ok(false);
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };

    let mut visited_files = 0usize;
    let mut skipped_binary_extension = 0usize;
    for line in stdout.lines() {
        let rel_path = line
            .trim()
            .strip_prefix("./")
            .unwrap_or_else(|| line.trim())
            .replace('\\', "/");
        if rel_path.is_empty() {
            continue;
        }
        visited_files += 1;
        if visited_files == 1 || visited_files % 65_536 == 0 {
            progress(IndexProgress {
                phase: "scan",
                current: visited_files,
                total: visited_files.max(1),
                percent: 0,
                detail: format!("validating clean index {visited_files} files"),
            });
        }
        let path = Path::new(&rel_path);
        if config.is_binary_extension(&path) {
            skipped_binary_extension += 1;
        }
    }
    progress(IndexProgress {
        phase: "scan",
        current: visited_files,
        total: visited_files.max(1),
        percent: 10,
        detail: format!("validated clean index {visited_files} files"),
    });
    Ok(visited_files == summary.total_files
        && skipped_binary_extension == summary.skipped_binary_extension
        && summary.skipped_too_large <= summary.total_files)
}

fn extract_json_u64(text: &str, key: &str) -> Option<u64> {
    let start = text.find(key)? + key.len();
    let digits = text[start..]
        .trim_start()
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

fn extract_json_string(text: &str, key: &str) -> Option<String> {
    let start = text.find(key)? + key.len();
    let rest = text[start..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn write_base_shards_from_workspace<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    layout: &StoreLayout,
    now: u64,
    progress: &mut F,
) -> io::Result<(Vec<ShardArtifact>, CorpusStats, u64)>
where
    F: FnMut(IndexProgress),
{
    let (records, mut stats) = collect_index_file_records(workspace_root, config, progress)?;
    let record_shards = partition_records(&records, config);
    let (artifacts, build_stats, fingerprint) =
        write_base_shards_from_records_parallel(layout, &record_shards, config, now, progress)?;
    merge_corpus_stats(&mut stats, build_stats);
    Ok((artifacts, stats, fingerprint))
}

fn write_base_shards_from_records_parallel<F>(
    layout: &StoreLayout,
    shards: &[&[IndexFileRecord]],
    config: &EngineConfig,
    now: u64,
    progress: &mut F,
) -> io::Result<(Vec<ShardArtifact>, CorpusStats, u64)>
where
    F: FnMut(IndexProgress),
{
    let total_shards = shards.len();
    if total_shards == 0 {
        return Ok((Vec::new(), CorpusStats::default(), 0));
    }

    let worker_count = shard_build_worker_count(total_shards);
    let mut artifacts = vec![None; total_shards];
    let mut shard_fingerprints = vec![0u64; total_shards];
    let mut stats = CorpusStats::default();
    let mut completed = 0usize;

    let next_shard = AtomicUsize::new(0);
    let (result_tx, result_rx) = mpsc::channel();
    let mut first_error: Option<io::Error> = None;
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let result_tx = result_tx.clone();
            let next_shard = &next_shard;
            handles.push(scope.spawn(move || loop {
                let shard_id = next_shard.fetch_add(1, AtomicOrdering::Relaxed);
                if shard_id >= total_shards {
                    break;
                }
                let output = build_and_write_base_shard_from_records(
                    layout,
                    shard_id as u32,
                    now,
                    shards[shard_id],
                    config,
                );
                let failed = output.is_err();
                if result_tx.send((shard_id, output)).is_err() || failed {
                    break;
                }
            }));
        }
        drop(result_tx);

        for (shard_id, output) in result_rx {
            match output {
                Ok(output) => {
                    completed += 1;
                    merge_corpus_stats(&mut stats, output.stats);
                    shard_fingerprints[shard_id] = output.fingerprint;
                    artifacts[shard_id] = Some(output.artifact);
                    if completed == 1 || completed == total_shards || completed % 4 == 0 {
                        progress(IndexProgress {
                            phase: "write",
                            current: completed,
                            total: total_shards.max(1),
                            percent: weighted_percent(completed, total_shards, 10, 90),
                            detail: format!(
                                "building and writing shards {}/{}",
                                completed,
                                total_shards.max(1)
                            ),
                        });
                    }
                }
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        for handle in handles {
            if handle.join().is_err() && first_error.is_none() {
                first_error = Some(io::Error::new(
                    io::ErrorKind::Other,
                    "base shard builder panicked",
                ));
            }
        }
    });
    if let Some(err) = first_error {
        return Err(err);
    }

    let artifacts = artifacts
        .into_iter()
        .map(|artifact| {
            artifact.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Other,
                    "base shard writer did not return every shard",
                )
            })
        })
        .collect::<io::Result<Vec<_>>>()?;
    let fingerprint = fingerprint_shards(&shard_fingerprints);
    Ok((artifacts, stats, fingerprint))
}

struct BaseShardBuildOutput {
    artifact: ShardArtifact,
    stats: CorpusStats,
    fingerprint: u64,
}

fn build_and_write_base_shard_from_records(
    layout: &StoreLayout,
    shard_id: u32,
    now: u64,
    records: &[IndexFileRecord],
    config: &EngineConfig,
) -> io::Result<BaseShardBuildOutput> {
    let mut docs = Vec::with_capacity(records.len());
    let mut stats = CorpusStats::default();
    for record in records {
        match build_indexed_document_from_record(record, config)? {
            IndexedRecordOutcome::Indexed { document, encoding } => {
                if matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16Be) {
                    stats.decoded_utf16_files += 1;
                }
                stats.indexed_files += 1;
                docs.push(document);
            }
            IndexedRecordOutcome::SkippedBinary => {
                stats.skipped_binary += 1;
            }
            IndexedRecordOutcome::SkippedTooLarge => {
                stats.skipped_too_large += 1;
            }
            IndexedRecordOutcome::SkippedMissing => {}
        }
    }
    let fingerprint = fingerprint_documents(&docs);
    let artifact = write_base_shard(layout, shard_id, now, &docs)?;
    Ok(BaseShardBuildOutput {
        artifact,
        stats,
        fingerprint,
    })
}

fn shard_build_worker_count(total_shards: usize) -> usize {
    let parallelism = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    parallelism
        .saturating_add(parallelism / 3)
        .min(24)
        .min(total_shards.max(1))
}

fn directory_scan_worker_count() -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(32)
        .max(1)
}

fn write_base_shard(
    layout: &StoreLayout,
    shard_id: u32,
    now: u64,
    docs: &[IndexedDocument],
) -> io::Result<ShardArtifact> {
    let build = build_shard_bytes(shard_id, now, docs)?;
    let header = build.header.clone();
    let file_bytes = build.bytes.len() as u64;
    let path = layout.shard_path(shard_id);
    write_atomically(&path, &build.bytes)?;
    Ok(ShardArtifact {
        shard_id,
        file_name: layout.shard_file_name(shard_id),
        path,
        doc_count: header.doc_count,
        gram_count: header.gram_count,
        file_bytes,
        source_bytes: build.source_bytes,
    })
}

fn collect_index_file_records<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    progress: &mut F,
) -> io::Result<(Vec<IndexFileRecord>, CorpusStats)>
where
    F: FnMut(IndexProgress),
{
    let worker_count = directory_scan_worker_count();
    if let Some(result) =
        collect_index_file_records_with_rg(workspace_root, config, worker_count, progress)?
    {
        return Ok(result);
    }
    if worker_count > 1 {
        return collect_index_file_records_parallel(workspace_root, config, worker_count, progress);
    }
    let mut records = Vec::new();
    let mut stats = CorpusStats::default();
    walk_index_file_records(
        workspace_root,
        workspace_root,
        config,
        &mut records,
        &mut stats,
        progress,
    )?;
    records.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    progress(IndexProgress {
        phase: "scan",
        current: stats.visited_files,
        total: stats.visited_files.max(1),
        percent: 10,
        detail: format!(
            "scanned {} files; {} candidates",
            stats.visited_files,
            records.len()
        ),
    });
    Ok((records, stats))
}

fn collect_index_file_records_with_rg<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    worker_count: usize,
    progress: &mut F,
) -> io::Result<Option<(Vec<IndexFileRecord>, CorpusStats)>>
where
    F: FnMut(IndexProgress),
{
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
    let files = stdout
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.strip_prefix("./").unwrap_or(line).replace('\\', "/"))
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Ok(None);
    }

    let mut records = Vec::with_capacity(files.len());
    let mut stats = CorpusStats::default();
    for rel_path in files {
        stats.visited_files += 1;
        if stats.visited_files == 1 || stats.visited_files % 65_536 == 0 {
            progress(IndexProgress {
                phase: "scan",
                current: stats.visited_files,
                total: stats.visited_files.max(1),
                percent: 0,
                detail: format!(
                    "scanning files {}; {} candidates",
                    stats.visited_files,
                    records.len()
                ),
            });
        }
        let path = workspace_root.join(&rel_path);
        if config.is_binary_extension(&path) {
            stats.skipped_binary_extension += 1;
            continue;
        }
        records.push(IndexFileRecord {
            rel_path,
            abs_path: path,
            size_bytes: 0,
            modified_unix_secs: 0,
            metadata_known: false,
        });
    }
    // Keep rg's file enumeration order in shard document ids. Search uses
    // those ids as its rg-like result order; sorting here would make broad
    // Top-N queries drift away from ripgrep even when counts match.
    progress(IndexProgress {
        phase: "scan",
        current: stats.visited_files,
        total: stats.visited_files.max(1),
        percent: 10,
        detail: format!(
            "scanned {} files; {} candidates",
            stats.visited_files,
            records.len()
        ),
    });
    let _ = worker_count;
    Ok(Some((records, stats)))
}

enum IndexScanMessage {
    Progress { visited: usize, candidates: usize },
    Done(io::Result<(Vec<IndexFileRecord>, CorpusStats)>),
}

fn collect_index_file_records_parallel<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    worker_count: usize,
    progress: &mut F,
) -> io::Result<(Vec<IndexFileRecord>, CorpusStats)>
where
    F: FnMut(IndexProgress),
{
    let dirs = Arc::new(Mutex::new(vec![workspace_root.to_path_buf()]));
    let pending_dirs = Arc::new(AtomicUsize::new(1));
    let stop = Arc::new(AtomicBool::new(false));
    let visited_files = Arc::new(AtomicUsize::new(0));
    let candidate_files = Arc::new(AtomicUsize::new(0));
    let workspace_root = Arc::new(workspace_root.to_path_buf());
    let index_root = Arc::new(config.index_root(&workspace_root));
    let config = Arc::new(config.clone());
    let (tx, rx) = mpsc::channel();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let dirs = Arc::clone(&dirs);
            let pending_dirs = Arc::clone(&pending_dirs);
            let stop = Arc::clone(&stop);
            let visited_files = Arc::clone(&visited_files);
            let candidate_files = Arc::clone(&candidate_files);
            let workspace_root = Arc::clone(&workspace_root);
            let index_root = Arc::clone(&index_root);
            let config = Arc::clone(&config);
            let tx = tx.clone();
            scope.spawn(move || {
                let mut records = Vec::new();
                let mut stats = CorpusStats::default();
                loop {
                    if stop.load(AtomicOrdering::Relaxed) {
                        break;
                    }
                    let dir = {
                        let mut guard = dirs.lock().expect("index directory queue poisoned");
                        guard.pop()
                    };
                    let Some(dir) = dir else {
                        if pending_dirs.load(AtomicOrdering::Acquire) == 0 {
                            break;
                        }
                        thread::yield_now();
                        continue;
                    };
                    let result = scan_index_dir_one_level(
                        &dir,
                        workspace_root.as_path(),
                        index_root.as_path(),
                        config.as_ref(),
                        &dirs,
                        &pending_dirs,
                        &visited_files,
                        &candidate_files,
                        &mut records,
                        &mut stats,
                        &tx,
                    );
                    pending_dirs.fetch_sub(1, AtomicOrdering::AcqRel);
                    if let Err(err) = result {
                        stop.store(true, AtomicOrdering::Relaxed);
                        let _ = tx.send(IndexScanMessage::Done(Err(err)));
                        return;
                    }
                }
                let _ = tx.send(IndexScanMessage::Done(Ok((records, stats))));
            });
        }
        drop(tx);

        let mut records = Vec::new();
        let mut stats = CorpusStats::default();
        let mut first_error: Option<io::Error> = None;
        for message in rx {
            match message {
                IndexScanMessage::Progress {
                    visited,
                    candidates,
                } => progress(IndexProgress {
                    phase: "scan",
                    current: visited,
                    total: visited.max(1),
                    percent: 0,
                    detail: format!("scanning files {visited}; {candidates} candidates"),
                }),
                IndexScanMessage::Done(Ok((mut worker_records, worker_stats))) => {
                    records.append(&mut worker_records);
                    merge_corpus_stats(&mut stats, worker_stats);
                }
                IndexScanMessage::Done(Err(err)) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }
        if let Some(err) = first_error {
            return Err(err);
        }
        records.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
        progress(IndexProgress {
            phase: "scan",
            current: stats.visited_files,
            total: stats.visited_files.max(1),
            percent: 10,
            detail: format!(
                "scanned {} files; {} candidates",
                stats.visited_files,
                records.len()
            ),
        });
        Ok((records, stats))
    })
}

#[allow(clippy::too_many_arguments)]
fn scan_index_dir_one_level(
    dir: &Path,
    workspace_root: &Path,
    index_root: &Path,
    config: &EngineConfig,
    dirs: &Arc<Mutex<Vec<PathBuf>>>,
    pending_dirs: &AtomicUsize,
    visited_files: &AtomicUsize,
    candidate_files: &AtomicUsize,
    records: &mut Vec<IndexFileRecord>,
    stats: &mut CorpusStats,
    tx: &mpsc::Sender<IndexScanMessage>,
) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => return Ok(()),
        Err(err) => return Err(err),
    };
    for item in entries {
        let item = match item {
            Ok(item) => item,
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => continue,
            Err(err) => return Err(err),
        };
        let path = item.path();
        let file_type = match item.file_type() {
            Ok(file_type) => file_type,
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => continue,
            Err(err) => return Err(err),
        };
        if file_type.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if config.is_internal_index_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || config.is_excluded_normalized_relative_path(&normalize_rel_path(
                    path.strip_prefix(workspace_root).unwrap_or(&path),
                ))
                || path == index_root
            {
                stats.skipped_dirs += 1;
                continue;
            }
            pending_dirs.fetch_add(1, AtomicOrdering::AcqRel);
            dirs.lock()
                .expect("index directory queue poisoned")
                .push(path);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let rel_path = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        if config.is_excluded_normalized_relative_path(&rel_path) {
            continue;
        }
        stats.visited_files += 1;
        let global_visited = visited_files.fetch_add(1, AtomicOrdering::Relaxed) + 1;
        if global_visited == 1 || global_visited % 4096 == 0 {
            let _ = tx.send(IndexScanMessage::Progress {
                visited: global_visited,
                candidates: candidate_files.load(AtomicOrdering::Relaxed),
            });
        }

        if config.is_binary_extension(&path) {
            stats.skipped_binary_extension += 1;
            continue;
        }
        let metadata = match item.metadata() {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => continue,
            Err(err) => return Err(err),
        };
        if metadata.len() > config.max_file_size_bytes {
            stats.skipped_too_large += 1;
            continue;
        }
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        records.push(IndexFileRecord {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs,
            metadata_known: true,
        });
        candidate_files.fetch_add(1, AtomicOrdering::Relaxed);
    }
    Ok(())
}

fn walk_index_file_records<F>(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
    records: &mut Vec<IndexFileRecord>,
    stats: &mut CorpusStats,
    progress: &mut F,
) -> io::Result<()>
where
    F: FnMut(IndexProgress),
{
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let file_type = item.file_type()?;
        if file_type.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if config.is_internal_index_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || config.is_excluded_normalized_relative_path(&normalize_rel_path(
                    path.strip_prefix(workspace_root).unwrap_or(&path),
                ))
                || path == config.index_root(workspace_root)
            {
                stats.skipped_dirs += 1;
                continue;
            }
            walk_index_file_records(&path, workspace_root, config, records, stats, progress)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let rel_path = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        if config.is_excluded_normalized_relative_path(&rel_path) {
            continue;
        }
        stats.visited_files += 1;
        if stats.visited_files == 1 || stats.visited_files % 4096 == 0 {
            progress(IndexProgress {
                phase: "scan",
                current: stats.visited_files,
                total: stats.visited_files.max(1),
                percent: 0,
                detail: format!(
                    "scanning files {}; {} candidates",
                    stats.visited_files,
                    records.len()
                ),
            });
        }

        if config.is_binary_extension(&path) {
            stats.skipped_binary_extension += 1;
            continue;
        }
        let metadata = item.metadata()?;
        if metadata.len() > config.max_file_size_bytes {
            stats.skipped_too_large += 1;
            continue;
        }
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        records.push(IndexFileRecord {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs,
            metadata_known: true,
        });
    }
    Ok(())
}

fn build_indexed_document_from_record(
    record: &IndexFileRecord,
    config: &EngineConfig,
) -> io::Result<IndexedRecordOutcome> {
    let (bytes, size_bytes, modified_unix_secs, sampled) = if record.metadata_known {
        if record.size_bytes > config.max_file_size_bytes {
            return Ok(IndexedRecordOutcome::SkippedTooLarge);
        }
        let (outcome, sampled) =
            match read_index_bytes_if_not_binary(&record.abs_path, record.size_bytes) {
                Ok(outcome) => outcome,
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
                {
                    return Ok(IndexedRecordOutcome::SkippedMissing);
                }
                Err(err) => return Err(err),
            };
        let bytes = match outcome {
            ReadTextBytesOutcome::Text(bytes) => bytes,
            ReadTextBytesOutcome::Binary => return Ok(IndexedRecordOutcome::SkippedBinary),
            ReadTextBytesOutcome::TooLarge => return Ok(IndexedRecordOutcome::SkippedTooLarge),
        };
        (bytes, record.size_bytes, record.modified_unix_secs, sampled)
    } else {
        let mut file = match File::open(&record.abs_path) {
            Ok(file) => file,
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                ) =>
            {
                return Ok(IndexedRecordOutcome::SkippedMissing);
            }
            Err(err) => return Err(err),
        };
        let (outcome, actual_size_bytes, sampled) =
            match read_index_bytes_from_unknown_size_file_if_not_binary(
                &mut file,
                &record.abs_path,
                config.max_file_size_bytes,
            ) {
                Ok(outcome) => outcome,
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
                    ) =>
                {
                    return Ok(IndexedRecordOutcome::SkippedMissing);
                }
                Err(err) => return Err(err),
            };
        let bytes = match outcome {
            ReadTextBytesOutcome::Text(bytes) => bytes,
            ReadTextBytesOutcome::Binary => return Ok(IndexedRecordOutcome::SkippedBinary),
            ReadTextBytesOutcome::TooLarge => return Ok(IndexedRecordOutcome::SkippedTooLarge),
        };
        (bytes, actual_size_bytes, 0, sampled)
    };
    let (text, encoding) = decode_bytes_owned(bytes);
    let gram_limit = max_grams_for_file(config, size_bytes, &record.rel_path);
    let (mut grams, overflow) =
        crate::gram::extract_dynamic_gram_hashes_with_overflow(&record.rel_path, &text, gram_limit);
    if overflow {
        append_overflow_sample_grams(&text, &mut grams);
    }
    Ok(IndexedRecordOutcome::Indexed {
        document: IndexedDocument {
            rel_path: record.rel_path.clone(),
            byte_len: size_bytes,
            modified_unix_secs,
            content_hash: stable_record_hash(&record.rel_path, size_bytes, modified_unix_secs),
            grams,
            gram_incomplete: overflow || sampled,
        },
        encoding,
    })
}

fn read_index_bytes_if_not_binary(
    path: &Path,
    size_bytes: u64,
) -> io::Result<(ReadTextBytesOutcome, bool)> {
    let mut file = File::open(path)?;
    read_index_bytes_from_file_if_not_binary(&mut file, path, size_bytes)
}

fn read_index_bytes_from_file_if_not_binary(
    file: &mut File,
    path: &Path,
    size_bytes: u64,
) -> io::Result<(ReadTextBytesOutcome, bool)> {
    if size_bytes <= 512 * 1024 {
        return read_open_file_bytes_if_not_binary(file, size_bytes)
            .map(|outcome| (outcome, false));
    }

    let mut bytes =
        Vec::with_capacity(SAMPLED_INDEX_PREFIX_BYTES + (SAMPLED_INDEX_CHUNK_BYTES * 4) + 4);
    {
        let mut prefix_reader = (&mut *file).take(SAMPLED_INDEX_PREFIX_BYTES as u64);
        prefix_reader.read_to_end(&mut bytes)?;
    }
    if crate::corpus::looks_binary_bytes(&bytes) {
        return Ok((ReadTextBytesOutcome::Binary, true));
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return read_file_bytes_if_not_binary(path, size_bytes).map(|outcome| (outcome, false));
    }

    append_centered_index_sample_chunk(file, size_bytes / 4, &mut bytes)?;
    append_centered_index_sample_chunk(file, size_bytes / 2, &mut bytes)?;
    append_centered_index_sample_chunk(file, (size_bytes * 3) / 4, &mut bytes)?;
    append_index_sample_chunk(
        file,
        size_bytes.saturating_sub(SAMPLED_INDEX_CHUNK_BYTES as u64),
        &mut bytes,
    )?;
    Ok((ReadTextBytesOutcome::Text(bytes), true))
}

fn read_open_file_bytes_if_not_binary(
    file: &mut File,
    size_bytes: u64,
) -> io::Result<ReadTextBytesOutcome> {
    let mut bytes = Vec::with_capacity(size_bytes.min(8 * 1024 * 1024) as usize);
    file.read_to_end(&mut bytes)?;
    if crate::corpus::looks_binary_bytes(&bytes) {
        return Ok(ReadTextBytesOutcome::Binary);
    }
    Ok(ReadTextBytesOutcome::Text(bytes))
}

fn read_index_bytes_from_unknown_size_file_if_not_binary(
    file: &mut File,
    _path: &Path,
    max_size_bytes: u64,
) -> io::Result<(ReadTextBytesOutcome, u64, bool)> {
    let probe_limit = SAMPLED_INDEX_THRESHOLD_BYTES
        .saturating_add(1)
        .min(max_size_bytes.saturating_add(1));
    let mut probe = Vec::with_capacity(probe_limit.min(usize::MAX as u64) as usize);
    {
        let mut reader = (&mut *file).take(probe_limit);
        reader.read_to_end(&mut probe)?;
    }
    if probe.len() as u64 > max_size_bytes {
        return Ok((ReadTextBytesOutcome::TooLarge, probe.len() as u64, false));
    }
    if (probe.len() as u64) <= SAMPLED_INDEX_THRESHOLD_BYTES {
        if crate::corpus::looks_binary_bytes(&probe) {
            return Ok((ReadTextBytesOutcome::Binary, probe.len() as u64, false));
        }
        let size_bytes = probe.len() as u64;
        return Ok((ReadTextBytesOutcome::Text(probe), size_bytes, false));
    }

    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok((ReadTextBytesOutcome::TooLarge, 0, false));
    }
    let size_bytes = metadata.len();
    if size_bytes > max_size_bytes {
        return Ok((ReadTextBytesOutcome::TooLarge, size_bytes, false));
    }
    if size_bytes <= 512 * 1024 {
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::with_capacity(size_bytes.min(8 * 1024 * 1024) as usize);
        file.read_to_end(&mut bytes)?;
        if crate::corpus::looks_binary_bytes(&bytes) {
            return Ok((ReadTextBytesOutcome::Binary, size_bytes, false));
        }
        return Ok((ReadTextBytesOutcome::Text(bytes), size_bytes, false));
    }

    let mut bytes = probe;
    bytes.truncate(SAMPLED_INDEX_PREFIX_BYTES.min(bytes.len()));
    if crate::corpus::looks_binary_bytes(&bytes) {
        return Ok((ReadTextBytesOutcome::Binary, size_bytes, true));
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        file.seek(SeekFrom::Start(0))?;
        let mut full_bytes = Vec::with_capacity(size_bytes.min(8 * 1024 * 1024) as usize);
        file.read_to_end(&mut full_bytes)?;
        return Ok((ReadTextBytesOutcome::Text(full_bytes), size_bytes, false));
    }

    append_centered_index_sample_chunk(file, size_bytes / 4, &mut bytes)?;
    append_centered_index_sample_chunk(file, size_bytes / 2, &mut bytes)?;
    append_centered_index_sample_chunk(file, (size_bytes * 3) / 4, &mut bytes)?;
    append_index_sample_chunk(
        file,
        size_bytes.saturating_sub(SAMPLED_INDEX_CHUNK_BYTES as u64),
        &mut bytes,
    )?;
    Ok((ReadTextBytesOutcome::Text(bytes), size_bytes, true))
}

fn append_index_sample_chunk(file: &mut File, offset: u64, out: &mut Vec<u8>) -> io::Result<()> {
    out.push(b'\n');
    file.seek(SeekFrom::Start(offset))?;
    let mut reader = file.take(SAMPLED_INDEX_CHUNK_BYTES as u64);
    reader.read_to_end(out)?;
    Ok(())
}

fn append_centered_index_sample_chunk(
    file: &mut File,
    center_offset: u64,
    out: &mut Vec<u8>,
) -> io::Result<()> {
    append_index_sample_chunk(
        file,
        center_offset.saturating_sub((SAMPLED_INDEX_CHUNK_BYTES / 2) as u64),
        out,
    )
}

fn max_grams_for_file(config: &EngineConfig, size_bytes: u64, _rel_path: &str) -> usize {
    if size_bytes <= 64 * 1024 {
        return config.max_grams_per_file.max(2048);
    }
    if size_bytes <= 512 * 1024 {
        return config.max_grams_per_file.max(1024);
    }
    config.max_grams_per_file
}

fn append_overflow_sample_grams(text: &str, grams: &mut Vec<u64>) {
    const SAMPLE_BYTES: usize = 16 * 1024;
    const EXTRA_GRAMS_PER_SAMPLE: usize = 512;
    const EXTRA_GRAMS_PER_PREFIX_TAIL_SAMPLE: usize = 512;
    const EXTRA_GRAMS_PER_SMALL_SAMPLE: usize = 128;
    const EXTRA_HEX_SEQUENCE_GRAMS: usize = 128;
    const EXTRA_URL_GRAMS: usize = 64;
    let mut seen = grams.iter().copied().collect::<HashSet<_>>();
    let _ = crate::gram::append_hex_pair_sequence_hashes(
        text,
        &mut seen,
        grams,
        EXTRA_HEX_SEQUENCE_GRAMS,
        usize::MAX,
    );
    let _ =
        crate::gram::append_url_literal_hashes(text, &mut seen, grams, EXTRA_URL_GRAMS, usize::MAX);
    append_overflow_selective_token_grams(text, &mut seen, grams);
    if text.len() <= SAMPLE_BYTES {
        append_sample_grams(
            text,
            text.len() / 2,
            text.len(),
            EXTRA_GRAMS_PER_SMALL_SAMPLE,
            &mut seen,
            grams,
        );
        append_sample_grams(
            text,
            text.len().saturating_sub(text.len() / 4),
            text.len(),
            EXTRA_GRAMS_PER_SMALL_SAMPLE,
            &mut seen,
            grams,
        );
        append_sample_grams(
            text,
            text.len().saturating_sub(128),
            128,
            EXTRA_GRAMS_PER_SMALL_SAMPLE,
            &mut seen,
            grams,
        );
        return;
    }
    append_sample_grams(
        text,
        SAMPLE_BYTES,
        SAMPLE_BYTES,
        EXTRA_GRAMS_PER_PREFIX_TAIL_SAMPLE,
        &mut seen,
        grams,
    );
    for numerator in 1..16 {
        let center = (text.len() * numerator) / 16;
        append_centered_sample_grams(
            text,
            center,
            SAMPLE_BYTES,
            EXTRA_GRAMS_PER_SAMPLE,
            &mut seen,
            grams,
        );
    }
    append_sample_grams(
        text,
        text.len().saturating_sub(SAMPLE_BYTES),
        SAMPLE_BYTES,
        EXTRA_GRAMS_PER_SAMPLE,
        &mut seen,
        grams,
    );
}

fn append_overflow_selective_token_grams(
    text: &str,
    seen: &mut HashSet<u64>,
    grams: &mut Vec<u64>,
) {
    const SELECTIVE_TOKEN_SEGMENTS: usize = 16;
    const SELECTIVE_TOKEN_GRAMS_PER_SEGMENT: usize = 256;
    if text.is_empty() {
        return;
    }
    let has_non_ascii = !text.is_ascii();
    for segment_idx in 0..SELECTIVE_TOKEN_SEGMENTS {
        let mut start = (text.len() * segment_idx) / SELECTIVE_TOKEN_SEGMENTS;
        let mut end = (text.len() * (segment_idx + 1)) / SELECTIVE_TOKEN_SEGMENTS;
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if start >= end {
            continue;
        }
        let segment = &text[start..end];
        let _ = crate::gram::append_selective_token_hashes(
            segment,
            has_non_ascii && !segment.is_ascii(),
            seen,
            grams,
            SELECTIVE_TOKEN_GRAMS_PER_SEGMENT,
            usize::MAX,
        );
    }
}

fn append_sample_grams(
    text: &str,
    start: usize,
    max_bytes: usize,
    max_grams: usize,
    seen: &mut HashSet<u64>,
    grams: &mut Vec<u64>,
) {
    let mut start = start.min(text.len());
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = start.saturating_add(max_bytes).min(text.len());
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    if start >= end {
        return;
    }
    let (sample_grams, _) =
        crate::gram::extract_dynamic_gram_hashes_with_overflow("", &text[start..end], max_grams);
    for gram in sample_grams {
        if seen.insert(gram) {
            grams.push(gram);
        }
    }
}

fn append_centered_sample_grams(
    text: &str,
    center: usize,
    max_bytes: usize,
    max_grams: usize,
    seen: &mut HashSet<u64>,
    grams: &mut Vec<u64>,
) {
    append_sample_grams(
        text,
        center.saturating_sub(max_bytes / 2),
        max_bytes,
        max_grams,
        seen,
        grams,
    );
}

fn merge_corpus_stats(target: &mut CorpusStats, source: CorpusStats) {
    target.visited_files += source.visited_files;
    target.indexed_files += source.indexed_files;
    target.skipped_binary += source.skipped_binary;
    target.skipped_binary_extension += source.skipped_binary_extension;
    target.skipped_too_large += source.skipped_too_large;
    target.skipped_dirs += source.skipped_dirs;
    target.decoded_utf16_files += source.decoded_utf16_files;
}

fn normalize_rel_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if path.contains('\\') {
        path.replace('\\', "/")
    } else {
        path.into_owned()
    }
}

fn weighted_percent(current: usize, total: usize, base: usize, weight: usize) -> usize {
    if weight == 0 {
        return base.min(100);
    }
    if total == 0 {
        return (base + weight).min(100);
    }
    let pct = ((current.min(total) * weight) + (total / 2)) / total;
    (base + pct).min(100)
}

pub fn stable_record_hash(rel_path: &str, size_bytes: u64, modified_unix_secs: u64) -> u64 {
    let mut hasher = FingerprintHasher::new();
    hasher.write_bytes(rel_path.as_bytes());
    hasher.write_u64(size_bytes);
    hasher.write_u64(modified_unix_secs);
    hasher.finish()
}

fn fingerprint_documents(docs: &[IndexedDocument]) -> u64 {
    let mut hasher = FingerprintHasher::new();
    for doc in docs {
        hasher.write_bytes(doc.rel_path.as_bytes());
        hasher.write_u64(doc.byte_len);
        hasher.write_u64(doc.modified_unix_secs);
        hasher.write_u64(doc.content_hash);
        hasher.write_u64(doc.grams.len() as u64);
        hasher.write_u64(u64::from(doc.gram_incomplete));
    }
    hasher.finish()
}

fn fingerprint_shards(shards: &[u64]) -> u64 {
    let mut hasher = FingerprintHasher::new();
    for (shard_id, fingerprint) in shards.iter().enumerate() {
        hasher.write_u64(shard_id as u64);
        hasher.write_u64(*fingerprint);
    }
    hasher.finish()
}

struct FingerprintHasher {
    value: u64,
}

impl FingerprintHasher {
    fn new() -> Self {
        Self {
            value: 0xcbf29ce484222325,
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        self.write_u64(bytes.len() as u64);
        for byte in bytes {
            self.value ^= u64::from(*byte);
            self.value = self.value.wrapping_mul(0x100000001b3);
        }
    }

    fn write_u64(&mut self, value: u64) {
        for byte in value.to_le_bytes() {
            self.value ^= u64::from(byte);
            self.value = self.value.wrapping_mul(0x100000001b3);
        }
    }

    fn finish(self) -> u64 {
        if self.value == 0 {
            1
        } else {
            self.value
        }
    }
}

fn partition_records<'a>(
    records: &'a [IndexFileRecord],
    config: &EngineConfig,
) -> Vec<&'a [IndexFileRecord]> {
    if records.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut current_bytes = 0u64;

    for (idx, record) in records.iter().enumerate() {
        let estimated_size_bytes = if record.metadata_known {
            record.size_bytes
        } else {
            6 * 1024
        };
        let would_overflow_bytes =
            idx > start && current_bytes + estimated_size_bytes > config.shard_target_bytes;
        let would_overflow_files = idx - start >= config.max_files_per_shard;
        if would_overflow_bytes || would_overflow_files {
            out.push(&records[start..idx]);
            start = idx;
            current_bytes = 0;
        }
        current_bytes += estimated_size_bytes;
    }
    out.push(&records[start..]);
    out
}

#[allow(clippy::too_many_arguments)]
fn build_manifest_json(
    workspace_root: &Path,
    index_root: &Path,
    created_unix_secs: u64,
    fingerprint: u64,
    overlay_journal_path: &Path,
    corpus_stats: &crate::corpus::CorpusStats,
    shards: &[ShardArtifact],
    total_grams: usize,
    total_source_bytes: u64,
    total_shard_bytes: u64,
) -> String {
    let shard_json = shards
        .iter()
        .map(|shard| {
            format!(
                "{{\"shardId\":{},\"fileName\":{},\"docCount\":{},\"gramCount\":{},\"sourceBytes\":{},\"fileBytes\":{}}}",
                shard.shard_id,
                json_string(&shard.file_name),
                shard.doc_count,
                shard.gram_count,
                shard.source_bytes,
                shard.file_bytes
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"engine\":{},\"schemaVersion\":{},\"workspaceRoot\":{},\"indexRoot\":{},\"createdUnixSecs\":{},\"fingerprint\":{},\"stats\":{{\"visitedFiles\":{},\"indexedFiles\":{},\"skippedBinary\":{},\"skippedBinaryExtension\":{},\"skippedTooLarge\":{},\"decodedUtf16Files\":{},\"shardCount\":{},\"totalGrams\":{},\"totalSourceBytes\":{},\"totalShardBytes\":{}}},\"baseShards\":[{}],\"overlay\":{},\"overlayJournal\":{},\"compactionSuggested\":false}}",
        json_string(ENGINE_NAME),
        SCHEMA_VERSION,
        json_string(&workspace_root.to_string_lossy()),
        json_string(&index_root.to_string_lossy()),
        created_unix_secs,
        fingerprint,
        corpus_stats.visited_files,
        corpus_stats.indexed_files,
        corpus_stats.skipped_binary,
        corpus_stats.skipped_binary_extension,
        corpus_stats.skipped_too_large,
        corpus_stats.decoded_utf16_files,
        shards.len(),
        total_grams,
        total_source_bytes,
        total_shard_bytes,
        shard_json,
        json_string("hot-overlay.json"),
        json_string(&overlay_journal_path.file_name().unwrap_or_default().to_string_lossy())
    )
}

#[allow(dead_code)]
fn _artifact_paths(artifacts: &IndexArtifacts) -> (&PathBuf, &PathBuf, &PathBuf) {
    (
        &artifacts.layout.manifest_path,
        &artifacts.layout.overlay_path,
        &artifacts
            .shards
            .first()
            .map(|shard| &shard.path)
            .unwrap_or(&artifacts.layout.manifest_path),
    )
}

#[cfg(test)]
mod tests {
    use super::index_directory;
    use crate::config::EngineConfig;
    use crate::shard::ShardReader;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn index_directory_writes_manifest_and_multiple_shards() -> io::Result<()> {
        let root = temp_dir("indexer");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        fs::write(root.join("src/b.rs"), "struct BetaService {}\n")?;
        fs::write(root.join("src/c.rs"), "struct GammaService {}\n")?;

        let mut config = EngineConfig::default();
        config.max_files_per_shard = 1;
        config.shard_target_bytes = 8;

        let artifacts = index_directory(&root, &config)?;
        assert_eq!(artifacts.summary.shard_count, 3);
        let manifest = fs::read_to_string(root.join(".zoek-rs/manifest.json"))?;
        assert!(manifest.contains("\"schemaVersion\":19"));
        assert!(manifest.contains("base-shard-0000.zrs"));

        let reader = ShardReader::open(&root.join(".zoek-rs/base-shard-0000.zrs"))?;
        assert_eq!(reader.header().doc_count, 1);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
