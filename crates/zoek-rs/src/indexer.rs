use crate::config::{
    ripgrep_executable, EngineConfig, ENGINE_NAME, SCHEMA_VERSION, WORKSPACE_METADATA_HASH_VERSION,
};
use crate::corpus::{decode_bytes_owned, CorpusStats, ReadTextBytesOutcome, TextEncoding};
use crate::mmap_store::{acquire_index_write_lock, write_atomically, StoreLayout};
use crate::overlay::OverlayManifest;
use crate::path_scope::append_file_listing_args;
use crate::protocol::json_string;
use crate::shard::{
    build_shard_bytes, read_base_index_manifest, read_shard_header, IndexedDocument,
};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
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

#[derive(Clone, Copy, Debug, Default)]
pub struct IndexBuildOptions {
    /// Rebuild base shards even when the existing index passes the clean
    /// workspace validation. The old CLI parsed --force but never carried it
    /// into the indexer, so a supposed cold benchmark could silently measure
    /// the clean-reuse path instead.
    pub force: bool,
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
    modified_subsec_nanos: u32,
    change_token: u64,
    metadata_reuse_safe: bool,
}

#[derive(Clone, Copy, Debug)]
struct MetadataFingerprintParts {
    modified_unix_secs: u64,
    modified_subsec_nanos: u32,
    change_token: u64,
    reuse_safe: bool,
}

enum IndexedRecordOutcome {
    Indexed {
        document: IndexedDocument,
        encoding: TextEncoding,
    },
    SkippedBinary,
    SkippedTooLarge,
}

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
    index_directory_with_options(
        workspace_root,
        config,
        IndexBuildOptions::default(),
        progress,
    )
}

pub fn index_directory_with_options<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    options: IndexBuildOptions,
    progress: &mut F,
) -> io::Result<IndexArtifacts>
where
    F: FnMut(IndexProgress),
{
    let layout = StoreLayout::for_workspace(workspace_root, config);
    layout.ensure_dirs()?;
    let _write_lock = acquire_index_write_lock(&layout)?;
    let _ = layout.cleanup_stale_temp_files(30);

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);

    if options.force {
        progress(IndexProgress {
            phase: "scan",
            current: 0,
            total: 1,
            percent: 0,
            detail: "force rebuild bypassing clean index reuse".to_string(),
        });
    }

    // The same metadata scan serves both clean-reuse validation and a
    // fallback rebuild, so a changed workspace is never enumerated twice.
    let (mut records, mut corpus_stats) =
        collect_index_file_records(workspace_root, config, progress)?;
    let mut workspace_metadata_fingerprint =
        fingerprint_workspace_metadata(&records, &corpus_stats);
    let config_fingerprint = fingerprint_base_config(config);
    let workspace_metadata_reuse_safe = records.iter().all(|record| record.metadata_reuse_safe);
    if !options.force && workspace_metadata_reuse_safe {
        if let Some((artifacts, created_unix_secs)) = try_reuse_clean_existing_index(
            &layout,
            workspace_metadata_fingerprint,
            config_fingerprint,
        )? {
            progress(IndexProgress {
                phase: "scan",
                current: corpus_stats.visited_files,
                total: corpus_stats.visited_files.max(1),
                percent: 10,
                detail: "validating the unchanged workspace snapshot".to_string(),
            });
            drop(records);
            let mut silent_progress = |_progress: IndexProgress| {};
            let (validated_records, validated_stats) =
                collect_index_file_records(workspace_root, config, &mut silent_progress)?;
            let validated_fingerprint =
                fingerprint_workspace_metadata(&validated_records, &validated_stats);
            if validated_fingerprint == workspace_metadata_fingerprint {
                drop(_write_lock);
                progress(IndexProgress {
                    phase: "done",
                    current: 1,
                    total: 1,
                    percent: 100,
                    detail: format!("reused clean index from {created_unix_secs}"),
                });
                return Ok(artifacts);
            }
            records = validated_records;
            corpus_stats = validated_stats;
            workspace_metadata_fingerprint = validated_fingerprint;
        }
    }

    let record_shards = partition_records(&records, config);
    let build_id = next_index_build_id(&layout)?;
    let (mut shard_artifacts, build_stats, fingerprint, content_snapshots) =
        write_base_shards_from_records_parallel(
            &layout,
            &record_shards,
            config,
            now,
            build_id,
            progress,
        )?;
    let mut staged_shard_cleanup = StagedShardCleanup::new(&shard_artifacts);
    drop(record_shards);
    drop(records);
    progress(IndexProgress {
        phase: "write",
        current: shard_artifacts.len(),
        total: shard_artifacts.len().max(1),
        percent: 100,
        detail: "validating the completed workspace snapshot".to_string(),
    });
    let mut silent_progress = |_progress: IndexProgress| {};
    let (validated_records, validated_stats) =
        collect_index_file_records(workspace_root, config, &mut silent_progress)?;
    let validated_fingerprint =
        fingerprint_workspace_metadata(&validated_records, &validated_stats);
    if validated_fingerprint != workspace_metadata_fingerprint {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "workspace changed while building the search index; retrying is required",
        ));
    }
    validate_content_snapshots(&validated_records, &content_snapshots)?;
    drop(validated_records);
    merge_corpus_stats(&mut corpus_stats, build_stats);
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
    let manifest_workspace_root = fs::canonicalize(workspace_root)?;
    let manifest_index_root = fs::canonicalize(&layout.root)?;

    // The current overlay is a complete recovery source for the current base,
    // so removing an obsolete journal before shard publication is safe. More
    // importantly, a failure here leaves both the old manifest and old shards
    // untouched.
    match fs::remove_file(&layout.overlay_journal_path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    publish_staged_base_shards(&layout, &mut shard_artifacts)?;
    staged_shard_cleanup.disarm();
    layout.clear_base_shards_from(shard_artifacts.len())?;
    let (shard_metadata_fingerprint, _) = fingerprint_shard_metadata(&shard_artifacts)?;

    let overlay = OverlayManifest::empty();
    write_atomically(&layout.overlay_path, overlay.to_json().as_bytes())?;
    write_atomically(
        &layout.manifest_path,
        build_manifest_json(
            &manifest_workspace_root,
            &manifest_index_root,
            now,
            build_id,
            fingerprint,
            workspace_metadata_fingerprint,
            config_fingerprint,
            shard_metadata_fingerprint,
            config.persistent_index_scope(),
            &layout.overlay_journal_path,
            &corpus_stats,
            &shard_artifacts,
            total_grams,
            total_source_bytes,
            total_shard_bytes,
        )
        .as_bytes(),
    )?;
    drop(_write_lock);

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

#[derive(Clone, Debug)]
struct ExistingIndexSummary {
    created_unix_secs: u64,
    build_id: u64,
    fingerprint: u64,
    workspace_metadata_fingerprint: u64,
    config_fingerprint: u64,
    shard_metadata_fingerprint: u64,
    total_files: usize,
    indexed_files: usize,
    skipped_binary: usize,
    skipped_binary_extension: usize,
    skipped_too_large: usize,
    shard_count: usize,
    total_grams: usize,
    total_source_bytes: u64,
    total_shard_bytes: u64,
    shards: Vec<ExistingShardSummary>,
}

#[derive(Clone, Debug)]
struct ExistingShardSummary {
    doc_count: usize,
    gram_count: usize,
    file_bytes: u64,
}

fn try_reuse_clean_existing_index(
    layout: &StoreLayout,
    workspace_metadata_fingerprint: u64,
    config_fingerprint: u64,
) -> io::Result<Option<(IndexArtifacts, u64)>> {
    let Some(summary) = read_existing_index_summary(layout)? else {
        return Ok(None);
    };
    if summary.config_fingerprint != config_fingerprint
        || summary.workspace_metadata_fingerprint != workspace_metadata_fingerprint
    {
        return Ok(None);
    }
    if !overlay_is_empty(layout)? {
        return Ok(None);
    }

    let shard_paths = layout.list_shard_paths()?;
    if shard_paths.len() != summary.shard_count {
        return Ok(None);
    }
    if shard_paths.iter().enumerate().any(|(shard_id, path)| {
        path.file_name().and_then(|name| name.to_str())
            != Some(layout.shard_file_name(shard_id as u32).as_str())
    }) {
        return Ok(None);
    }
    let metadata_artifacts = shard_paths
        .iter()
        .enumerate()
        .map(|(shard_id, path)| ShardArtifact {
            shard_id: shard_id as u32,
            file_name: layout.shard_file_name(shard_id as u32),
            path: path.clone(),
            doc_count: 0,
            gram_count: 0,
            file_bytes: 0,
            source_bytes: 0,
        })
        .collect::<Vec<_>>();
    let (shard_metadata_fingerprint, shard_metadata_reuse_safe) =
        fingerprint_shard_metadata(&metadata_artifacts)?;
    if !shard_metadata_reuse_safe
        || shard_metadata_fingerprint != summary.shard_metadata_fingerprint
    {
        return Ok(None);
    }
    let mut shards = Vec::with_capacity(shard_paths.len());
    let mut total_docs = 0usize;
    let mut total_grams = 0usize;
    let mut total_shard_bytes = 0u64;
    for (idx, path) in shard_paths.into_iter().enumerate() {
        let header = match read_shard_header(&path) {
            Ok(header) => header,
            Err(_) => return Ok(None),
        };
        if header.shard_id as usize != idx
            || header.created_unix_secs != summary.created_unix_secs
            || header.build_id != summary.build_id
            || header.doc_count != summary.shards[idx].doc_count
            || header.gram_count != summary.shards[idx].gram_count
            || header.file_len != summary.shards[idx].file_bytes
        {
            return Ok(None);
        }
        total_docs = total_docs.saturating_add(header.doc_count);
        total_grams = total_grams.saturating_add(header.gram_count);
        total_shard_bytes = total_shard_bytes.saturating_add(header.file_len);
        shards.push(ShardArtifact {
            shard_id: header.shard_id,
            file_name: layout.shard_file_name(header.shard_id),
            path,
            doc_count: header.doc_count,
            gram_count: header.gram_count,
            file_bytes: header.file_len,
            source_bytes: 0,
        });
    }
    if total_docs != summary.indexed_files
        || total_grams != summary.total_grams
        || total_shard_bytes != summary.total_shard_bytes
    {
        return Ok(None);
    }

    Ok(Some((
        IndexArtifacts {
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
        },
        summary.created_unix_secs,
    )))
}

fn read_existing_index_summary(layout: &StoreLayout) -> io::Result<Option<ExistingIndexSummary>> {
    let manifest = match read_base_index_manifest(layout) {
        Ok(manifest) => manifest,
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::InvalidData
            ) =>
        {
            return Ok(None)
        }
        Err(err) => return Err(err),
    };
    let build_id = manifest.build_id.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "search index manifest has an invalid build identity",
        )
    })?;
    let stats = manifest.stats;
    let shards = manifest
        .base_shards
        .into_iter()
        .map(|shard| ExistingShardSummary {
            doc_count: shard.doc_count,
            gram_count: shard.gram_count,
            file_bytes: shard.file_bytes,
        })
        .collect();
    Ok(Some(ExistingIndexSummary {
        created_unix_secs: manifest.created_unix_secs,
        build_id,
        fingerprint: manifest.fingerprint,
        workspace_metadata_fingerprint: manifest.workspace_metadata_fingerprint,
        config_fingerprint: manifest.config_fingerprint,
        shard_metadata_fingerprint: manifest.shard_metadata_fingerprint,
        total_files: stats.visited_files,
        indexed_files: stats.indexed_files,
        skipped_binary: stats.skipped_binary,
        skipped_binary_extension: stats.skipped_binary_extension,
        skipped_too_large: stats.skipped_too_large,
        shard_count: stats.shard_count,
        total_grams: stats.total_grams,
        total_source_bytes: stats.total_source_bytes,
        total_shard_bytes: stats.total_shard_bytes,
        shards,
    }))
}

fn overlay_is_empty(layout: &StoreLayout) -> io::Result<bool> {
    let metadata = match fs::metadata(&layout.overlay_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    if !metadata.is_file() {
        return Ok(false);
    }
    let overlay = match OverlayManifest::load(&layout.overlay_path) {
        Ok(overlay) => overlay,
        Err(err) if err.kind() == io::ErrorKind::InvalidData => return Ok(false),
        Err(err) => return Err(err),
    };
    if overlay.generation != 0 || overlay.updated_unix_secs != 0 || !overlay.entries.is_empty() {
        return Ok(false);
    }
    match fs::metadata(&layout.overlay_journal_path) {
        Ok(metadata) => Ok(metadata.len() == 0),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(err) => Err(err),
    }
}

fn extract_json_string(text: &str, key: &str) -> Option<String> {
    let start = text.find(key)? + key.len();
    let rest = text[start..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn extract_json_string_u64(text: &str, key: &str) -> Option<u64> {
    extract_json_string(text, key)?.parse().ok()
}

fn next_index_build_id(layout: &StoreLayout) -> io::Result<u64> {
    let manifest_build_id = match fs::read_to_string(&layout.manifest_path) {
        Ok(text) => extract_json_string_u64(&text, "\"buildId\":").unwrap_or(0),
        Err(err) if err.kind() == io::ErrorKind::NotFound => 0,
        Err(err) => return Err(err),
    };
    let mut occupied = HashSet::new();
    if manifest_build_id > 0 {
        occupied.insert(manifest_build_id);
    }
    for shard_path in layout.list_shard_paths()? {
        if let Ok(header) = read_shard_header(&shard_path) {
            if header.build_id > 0 {
                occupied.insert(header.build_id);
            }
        }
    }
    let clock = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
        .unwrap_or(0);
    let mut candidate = occupied
        .iter()
        .copied()
        .max()
        .and_then(|previous| previous.checked_add(1))
        .map(|next| next.max(clock))
        .unwrap_or(clock)
        .max(1);
    for _ in 0..=occupied.len() {
        if !occupied.contains(&candidate) {
            return Ok(candidate);
        }
        candidate = candidate.checked_add(1).unwrap_or(1);
    }
    Err(io::Error::other(
        "failed to allocate a distinct search index build identity",
    ))
}

fn write_base_shards_from_records_parallel<F>(
    layout: &StoreLayout,
    shards: &[&[IndexFileRecord]],
    config: &EngineConfig,
    now: u64,
    build_id: u64,
    progress: &mut F,
) -> io::Result<(Vec<ShardArtifact>, CorpusStats, u64, Vec<ContentSnapshot>)>
where
    F: FnMut(IndexProgress),
{
    let total_shards = shards.len();
    if total_shards == 0 {
        return Ok((Vec::new(), CorpusStats::default(), 0, Vec::new()));
    }

    let worker_count = shard_build_worker_count(total_shards);
    let mut artifacts = vec![None; total_shards];
    let mut content_snapshots = vec![None; total_shards];
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
                    build_id,
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
                    content_snapshots[shard_id] = Some(output.content_snapshots);
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
    let content_snapshots = content_snapshots
        .into_iter()
        .map(|snapshots| {
            snapshots.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::Other,
                    "base shard writer did not return every content snapshot set",
                )
            })
        })
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    Ok((artifacts, stats, fingerprint, content_snapshots))
}

struct BaseShardBuildOutput {
    artifact: ShardArtifact,
    stats: CorpusStats,
    fingerprint: u64,
    content_snapshots: Vec<ContentSnapshot>,
}

#[derive(Clone, Debug)]
struct ContentSnapshot {
    rel_path: String,
    hash: u64,
}

struct StagedShardCleanup {
    paths: Vec<PathBuf>,
    armed: bool,
}

impl StagedShardCleanup {
    fn new(shards: &[ShardArtifact]) -> Self {
        Self {
            paths: shards.iter().map(|shard| shard.path.clone()).collect(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StagedShardCleanup {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        for path in &self.paths {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(_) => {}
            }
        }
    }
}

fn build_and_write_base_shard_from_records(
    layout: &StoreLayout,
    shard_id: u32,
    now: u64,
    build_id: u64,
    records: &[IndexFileRecord],
    config: &EngineConfig,
) -> io::Result<BaseShardBuildOutput> {
    let mut docs = Vec::with_capacity(records.len());
    let mut content_snapshots = Vec::new();
    let mut stats = CorpusStats::default();
    for record in records {
        let (outcome, snapshot_hash) = build_indexed_document_from_record(record, config)?;
        if !record.metadata_reuse_safe {
            content_snapshots.push(ContentSnapshot {
                rel_path: record.rel_path.clone(),
                hash: snapshot_hash,
            });
        }
        match outcome {
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
        }
    }
    let fingerprint = fingerprint_documents(&docs);
    let artifact = write_base_shard(layout, shard_id, now, build_id, &docs)?;
    Ok(BaseShardBuildOutput {
        artifact,
        stats,
        fingerprint,
        content_snapshots,
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
    build_id: u64,
    docs: &[IndexedDocument],
) -> io::Result<ShardArtifact> {
    let build = build_shard_bytes(shard_id, now, build_id, docs)?;
    let header = build.header.clone();
    let file_bytes = build.bytes.len() as u64;
    let path = staged_base_shard_path(layout, shard_id, build_id);
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

fn staged_base_shard_path(layout: &StoreLayout, shard_id: u32, build_id: u64) -> PathBuf {
    layout.root.join(format!(
        ".{}.build-{build_id}.staged.tmp",
        layout.shard_file_name(shard_id)
    ))
}

fn publish_staged_base_shards(
    layout: &StoreLayout,
    shards: &mut [ShardArtifact],
) -> io::Result<()> {
    for shard in shards {
        let final_path = layout.shard_path(shard.shard_id);
        #[cfg(windows)]
        match fs::remove_file(&final_path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        fs::rename(&shard.path, &final_path)?;
        shard.path = final_path;
    }
    Ok(())
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
    let index_relative_prefix = configured_index_relative_prefix(workspace_root, config);
    if let Some(result) = collect_index_file_records_with_rg(
        workspace_root,
        config,
        index_relative_prefix.as_deref(),
        worker_count,
        progress,
    )? {
        return Ok(result);
    }
    if worker_count > 1 {
        return collect_index_file_records_parallel(
            workspace_root,
            config,
            index_relative_prefix.as_deref(),
            worker_count,
            progress,
        );
    }
    let mut records = Vec::new();
    let mut stats = CorpusStats::default();
    walk_index_file_records(
        workspace_root,
        workspace_root,
        config,
        index_relative_prefix.as_deref(),
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
    index_relative_prefix: Option<&str>,
    worker_count: usize,
    progress: &mut F,
) -> io::Result<Option<(Vec<IndexFileRecord>, CorpusStats)>>
where
    F: FnMut(IndexProgress),
{
    let mut command = Command::new(ripgrep_executable());
    command.current_dir(workspace_root);
    append_file_listing_args(&mut command, config);
    command.args(["--glob", "!.zoek-rs/**", "--glob", "!.zoekt-rs/**", "."]);
    let output = match command.output() {
        Ok(output) => output,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return Ok(None);
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let total_enumerated = stdout.lines().filter(|line| !line.is_empty()).count();
    if total_enumerated == 0 {
        progress(IndexProgress {
            phase: "scan",
            current: 0,
            total: 1,
            percent: 10,
            detail: "scanned 0 files; 0 candidates".to_string(),
        });
        return Ok(Some((Vec::new(), CorpusStats::default())));
    }

    progress(IndexProgress {
        phase: "scan",
        current: 0,
        total: total_enumerated,
        percent: 0,
        detail: format!("scanning metadata for {total_enumerated} files"),
    });
    enum RgScanOutcome {
        Candidate(IndexFileRecord),
        BinaryExtension,
        TooLarge,
        Other,
    }
    let stat_pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count.max(1))
        .build()
        .map_err(io::Error::other)?;
    const RG_STAT_CHUNK_FILES: usize = 16 * 1024;
    let mut lines = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.strip_prefix("./").unwrap_or(line).replace('\\', "/"));
    let mut records = Vec::new();
    let mut stats = CorpusStats::default();
    let mut processed_enumerated = 0usize;
    loop {
        let files = lines.by_ref().take(RG_STAT_CHUNK_FILES).collect::<Vec<_>>();
        if files.is_empty() {
            break;
        }
        let chunk_len = files.len();
        let scanned = stat_pool.install(|| {
            files
                .into_par_iter()
                .map(|rel_path| -> io::Result<Option<RgScanOutcome>> {
                    if is_within_relative_prefix(&rel_path, index_relative_prefix)
                        || config.is_overlay_update_excluded_relative_path(&rel_path)
                    {
                        return Ok(None);
                    }
                    let abs_path = workspace_root.join(&rel_path);
                    if config.is_binary_extension(&abs_path) {
                        return Ok(Some(RgScanOutcome::BinaryExtension));
                    }
                    let metadata = match fs::metadata(&abs_path) {
                        Ok(metadata) => metadata,
                        Err(err) if err.kind() == io::ErrorKind::NotFound => {
                            return Ok(Some(RgScanOutcome::Other))
                        }
                        Err(err) => return Err(err),
                    };
                    if !metadata.is_file() {
                        return Ok(Some(RgScanOutcome::Other));
                    }
                    if metadata.len() > config.max_file_size_bytes {
                        return Ok(Some(RgScanOutcome::TooLarge));
                    }
                    let metadata_parts = metadata_fingerprint_parts(&metadata);
                    Ok(Some(RgScanOutcome::Candidate(IndexFileRecord {
                        rel_path,
                        abs_path,
                        size_bytes: metadata.len(),
                        modified_unix_secs: metadata_parts.modified_unix_secs,
                        modified_subsec_nanos: metadata_parts.modified_subsec_nanos,
                        change_token: metadata_parts.change_token,
                        metadata_reuse_safe: metadata_parts.reuse_safe,
                    })))
                })
                .collect::<io::Result<Vec<_>>>()
        })?;
        for outcome in scanned.into_iter().flatten() {
            stats.visited_files += 1;
            match outcome {
                RgScanOutcome::Candidate(record) => records.push(record),
                RgScanOutcome::BinaryExtension => stats.skipped_binary_extension += 1,
                RgScanOutcome::TooLarge => stats.skipped_too_large += 1,
                RgScanOutcome::Other => {}
            }
        }
        processed_enumerated += chunk_len;
        if processed_enumerated == total_enumerated
            || processed_enumerated % (RG_STAT_CHUNK_FILES * 4) < RG_STAT_CHUNK_FILES
        {
            progress(IndexProgress {
                phase: "scan",
                current: processed_enumerated,
                total: total_enumerated,
                percent: weighted_percent(processed_enumerated, total_enumerated, 0, 10),
                detail: format!(
                    "scanned {} files; {} candidates",
                    stats.visited_files,
                    records.len()
                ),
            });
        }
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
    Ok(Some((records, stats)))
}

enum IndexScanMessage {
    Progress { visited: usize, candidates: usize },
    Done(io::Result<(Vec<IndexFileRecord>, CorpusStats)>),
}

fn collect_index_file_records_parallel<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    index_relative_prefix: Option<&str>,
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
                        index_relative_prefix,
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
    index_relative_prefix: Option<&str>,
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
        Err(err) => return Err(err),
    };
    for item in entries {
        let item = item?;
        let path = item.path();
        let file_type = item.file_type()?;
        if file_type.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            let rel_dir = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
            if is_within_relative_prefix(&rel_dir, index_relative_prefix)
                || config.is_extension_state_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || config.is_excluded_normalized_relative_path(&rel_dir)
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
        if is_within_relative_prefix(&rel_path, index_relative_prefix)
            || config.is_overlay_update_excluded_relative_path(&rel_path)
        {
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
        let metadata = item.metadata()?;
        if metadata.len() > config.max_file_size_bytes {
            stats.skipped_too_large += 1;
            continue;
        }
        let metadata_parts = metadata_fingerprint_parts(&metadata);
        records.push(IndexFileRecord {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs: metadata_parts.modified_unix_secs,
            modified_subsec_nanos: metadata_parts.modified_subsec_nanos,
            change_token: metadata_parts.change_token,
            metadata_reuse_safe: metadata_parts.reuse_safe,
        });
        candidate_files.fetch_add(1, AtomicOrdering::Relaxed);
    }
    Ok(())
}

fn walk_index_file_records<F>(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
    index_relative_prefix: Option<&str>,
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
            let rel_dir = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
            if is_within_relative_prefix(&rel_dir, index_relative_prefix)
                || config.is_extension_state_dir_name(&name)
                || config.is_internal_index_dir_name(&name)
                || config.is_excluded_dir_name(&name)
                || config.is_excluded_normalized_relative_path(&rel_dir)
                || path == config.index_root(workspace_root)
            {
                stats.skipped_dirs += 1;
                continue;
            }
            walk_index_file_records(
                &path,
                workspace_root,
                config,
                index_relative_prefix,
                records,
                stats,
                progress,
            )?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        let rel_path = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        if is_within_relative_prefix(&rel_path, index_relative_prefix)
            || config.is_overlay_update_excluded_relative_path(&rel_path)
        {
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
        let metadata_parts = metadata_fingerprint_parts(&metadata);
        records.push(IndexFileRecord {
            rel_path,
            abs_path: path,
            size_bytes: metadata.len(),
            modified_unix_secs: metadata_parts.modified_unix_secs,
            modified_subsec_nanos: metadata_parts.modified_subsec_nanos,
            change_token: metadata_parts.change_token,
            metadata_reuse_safe: metadata_parts.reuse_safe,
        });
    }
    Ok(())
}

fn build_indexed_document_from_record(
    record: &IndexFileRecord,
    config: &EngineConfig,
) -> io::Result<(IndexedRecordOutcome, u64)> {
    if record.size_bytes > config.max_file_size_bytes {
        return Ok((IndexedRecordOutcome::SkippedTooLarge, 0));
    }
    let (outcome, sampled, snapshot_hash) = read_index_bytes_if_not_binary(record)?;
    let bytes = match outcome {
        ReadTextBytesOutcome::Text(bytes) => bytes,
        ReadTextBytesOutcome::Binary => {
            return Ok((IndexedRecordOutcome::SkippedBinary, snapshot_hash))
        }
        ReadTextBytesOutcome::TooLarge => {
            return Ok((IndexedRecordOutcome::SkippedTooLarge, snapshot_hash))
        }
    };
    let size_bytes = record.size_bytes;
    let modified_unix_secs = record.modified_unix_secs;
    let modified_subsec_nanos = record.modified_subsec_nanos;
    let (text, encoding) = decode_bytes_owned(bytes);
    let gram_limit = max_grams_for_file(config, size_bytes, &record.rel_path);
    let (mut grams, overflow) =
        crate::gram::extract_dynamic_gram_hashes_with_overflow(&record.rel_path, &text, gram_limit);
    if overflow {
        append_overflow_sample_grams(&text, &mut grams);
    }
    Ok((
        IndexedRecordOutcome::Indexed {
            document: IndexedDocument {
                rel_path: record.rel_path.clone(),
                byte_len: size_bytes,
                modified_unix_secs,
                content_hash: stable_record_hash(
                    &record.rel_path,
                    size_bytes,
                    modified_unix_secs,
                    modified_subsec_nanos,
                    record.change_token,
                ),
                grams,
                gram_incomplete: overflow || sampled,
            },
            encoding,
        },
        snapshot_hash,
    ))
}

fn read_index_bytes_if_not_binary(
    record: &IndexFileRecord,
) -> io::Result<(ReadTextBytesOutcome, bool, u64)> {
    let mut file = File::open(&record.abs_path)?;
    ensure_record_metadata_unchanged(record, &file.metadata()?)?;
    let outcome = read_index_bytes_from_file_if_not_binary(
        &mut file,
        record.size_bytes,
        !record.metadata_reuse_safe,
    )?;
    ensure_record_metadata_unchanged(record, &file.metadata()?)?;
    ensure_record_metadata_unchanged(record, &fs::metadata(&record.abs_path)?)?;
    Ok(outcome)
}

fn validate_content_snapshots(
    records: &[IndexFileRecord],
    snapshots: &[ContentSnapshot],
) -> io::Result<()> {
    if snapshots.is_empty() {
        return Ok(());
    }
    let records_by_path = records
        .iter()
        .map(|record| (record.rel_path.as_str(), record))
        .collect::<HashMap<_, _>>();
    for snapshot in snapshots {
        let record = records_by_path
            .get(snapshot.rel_path.as_str())
            .copied()
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "workspace changed while validating search index content: {}",
                        snapshot.rel_path
                    ),
                )
            })?;
        let (_, _, current_hash) = read_index_bytes_if_not_binary(record)?;
        if current_hash != snapshot.hash {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "file content changed while building the search index: {}",
                    snapshot.rel_path
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_record_metadata_unchanged(
    record: &IndexFileRecord,
    metadata: &fs::Metadata,
) -> io::Result<()> {
    let parts = metadata_fingerprint_parts(metadata);
    if !metadata.is_file()
        || metadata.len() != record.size_bytes
        || parts.modified_unix_secs != record.modified_unix_secs
        || parts.modified_subsec_nanos != record.modified_subsec_nanos
        || parts.change_token != record.change_token
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "file changed while building the search index: {}",
                record.rel_path
            ),
        ));
    }
    Ok(())
}

fn read_index_bytes_from_file_if_not_binary(
    file: &mut File,
    size_bytes: u64,
    capture_snapshot: bool,
) -> io::Result<(ReadTextBytesOutcome, bool, u64)> {
    if size_bytes <= 512 * 1024 {
        return read_open_file_bytes_if_not_binary(file, size_bytes, capture_snapshot)
            .map(|(outcome, snapshot_hash)| (outcome, false, snapshot_hash));
    }

    let mut bytes =
        Vec::with_capacity(SAMPLED_INDEX_PREFIX_BYTES + (SAMPLED_INDEX_CHUNK_BYTES * 4) + 4);
    {
        let mut prefix_reader = (&mut *file).take(SAMPLED_INDEX_PREFIX_BYTES as u64);
        prefix_reader.read_to_end(&mut bytes)?;
    }
    if crate::corpus::looks_binary_bytes(&bytes) {
        let snapshot_hash = capture_snapshot
            .then(|| fingerprint_index_snapshot_bytes(&bytes))
            .unwrap_or(0);
        return Ok((ReadTextBytesOutcome::Binary, true, snapshot_hash));
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        file.seek(SeekFrom::Start(0))?;
        return read_open_file_bytes_exact(file, size_bytes).map(|bytes| {
            let snapshot_hash = capture_snapshot
                .then(|| fingerprint_index_snapshot_bytes(&bytes))
                .unwrap_or(0);
            (ReadTextBytesOutcome::Text(bytes), false, snapshot_hash)
        });
    }

    append_centered_index_sample_chunk(file, size_bytes / 4, &mut bytes)?;
    append_centered_index_sample_chunk(file, size_bytes / 2, &mut bytes)?;
    append_centered_index_sample_chunk(file, (size_bytes * 3) / 4, &mut bytes)?;
    append_index_sample_chunk(
        file,
        size_bytes.saturating_sub(SAMPLED_INDEX_CHUNK_BYTES as u64),
        &mut bytes,
    )?;
    let snapshot_hash = capture_snapshot
        .then(|| fingerprint_index_snapshot_bytes(&bytes))
        .unwrap_or(0);
    Ok((ReadTextBytesOutcome::Text(bytes), true, snapshot_hash))
}

fn read_open_file_bytes_if_not_binary(
    file: &mut File,
    size_bytes: u64,
    capture_snapshot: bool,
) -> io::Result<(ReadTextBytesOutcome, u64)> {
    let bytes = read_open_file_bytes_exact(file, size_bytes)?;
    let snapshot_hash = capture_snapshot
        .then(|| fingerprint_index_snapshot_bytes(&bytes))
        .unwrap_or(0);
    if crate::corpus::looks_binary_bytes(&bytes) {
        return Ok((ReadTextBytesOutcome::Binary, snapshot_hash));
    }
    Ok((ReadTextBytesOutcome::Text(bytes), snapshot_hash))
}

fn fingerprint_index_snapshot_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = FingerprintHasher::new();
    hasher.write_u64(bytes.len() as u64);
    hasher.write_bytes(bytes);
    hasher.finish()
}

fn read_open_file_bytes_exact(file: &mut File, size_bytes: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(size_bytes.min(8 * 1024 * 1024) as usize);
    let mut limited = file.take(size_bytes.saturating_add(1));
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file size changed while building the search index",
        ));
    }
    Ok(bytes)
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

fn configured_index_relative_prefix(
    workspace_root: &Path,
    config: &EngineConfig,
) -> Option<String> {
    // The index directory already exists when scanning begins. Canonicalizing
    // both sides handles nested relative paths, `..`, symlinked workspace
    // roots, and absolute --out paths without turning a repository-specific
    // directory name into an exclusion rule.
    let workspace_root = fs::canonicalize(workspace_root).ok()?;
    let index_root = fs::canonicalize(config.index_root(&workspace_root)).ok()?;
    let relative = index_root.strip_prefix(&workspace_root).ok()?;
    Some(normalize_rel_path(relative).trim_matches('/').to_string())
}

fn is_within_relative_prefix(rel_path: &str, prefix: Option<&str>) -> bool {
    let Some(prefix) = prefix else {
        return false;
    };
    if prefix.is_empty() {
        return true;
    }
    rel_path == prefix
        || rel_path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn metadata_fingerprint_parts(metadata: &fs::Metadata) -> MetadataFingerprintParts {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok());
    let (modified_unix_secs, modified_subsec_nanos) = modified
        .as_ref()
        .map(|value| (value.as_secs(), value.subsec_nanos()))
        .unwrap_or((0, 0));
    MetadataFingerprintParts {
        modified_unix_secs,
        modified_subsec_nanos,
        change_token: metadata_change_token(metadata),
        // Unix ctime + inode/device below provide an independent change
        // identity when tools preserve size and mtime. The portable std
        // metadata API has no equivalent Windows change-time field, so a
        // metadata-only equality is not safe enough there; force a rebuild or
        // sync update instead of risking a stale base snapshot.
        reuse_safe: modified.is_some() && cfg!(unix),
    }
}

fn metadata_change_token(metadata: &fs::Metadata) -> u64 {
    let mut hasher = FingerprintHasher::new();
    let created = metadata
        .created()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok());
    hasher.write_u64(u64::from(created.is_some()));
    if let Some(created) = created {
        hasher.write_u64(created.as_secs());
        hasher.write_u64(u64::from(created.subsec_nanos()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hasher.write_u64(metadata.dev());
        hasher.write_u64(metadata.ino());
        hasher.write_u64(metadata.ctime() as u64);
        hasher.write_u64(metadata.ctime_nsec() as u64);
    }
    hasher.finish()
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

pub fn stable_record_hash(
    rel_path: &str,
    size_bytes: u64,
    modified_unix_secs: u64,
    modified_subsec_nanos: u32,
    change_token: u64,
) -> u64 {
    let mut hasher = FingerprintHasher::new();
    hasher.write_bytes(rel_path.as_bytes());
    hasher.write_u64(size_bytes);
    hasher.write_u64(modified_unix_secs);
    hasher.write_u64(u64::from(modified_subsec_nanos));
    hasher.write_u64(change_token);
    hasher.finish()
}

/// Return the metadata identity used by base shards and `update --sync`.
/// `None` means the platform could not provide a usable modification time;
/// callers must conservatively treat that file as changed instead of allowing
/// two unknown timestamps to compare equal.
pub fn stable_record_hash_for_metadata(rel_path: &str, metadata: &fs::Metadata) -> Option<u64> {
    let parts = metadata_fingerprint_parts(metadata);
    parts.reuse_safe.then(|| {
        stable_record_hash(
            rel_path,
            metadata.len(),
            parts.modified_unix_secs,
            parts.modified_subsec_nanos,
            parts.change_token,
        )
    })
}

fn fingerprint_workspace_metadata(records: &[IndexFileRecord], stats: &CorpusStats) -> u64 {
    let mut sum_primary = 0u128;
    let mut sum_secondary = 0u128;
    let mut xor_secondary = 0u64;
    for record in records {
        let mut record_hasher = FingerprintHasher::new();
        record_hasher.write_bytes(record.rel_path.as_bytes());
        record_hasher.write_u64(record.size_bytes);
        record_hasher.write_u64(record.modified_unix_secs);
        record_hasher.write_u64(u64::from(record.modified_subsec_nanos));
        record_hasher.write_u64(record.change_token);
        record_hasher.write_u64(u64::from(record.metadata_reuse_safe));
        let primary = mix_fingerprint_word(record_hasher.finish());
        let secondary = mix_fingerprint_word(primary ^ 0x9e37_79b9_7f4a_7c15);
        sum_primary = sum_primary.wrapping_add(u128::from(primary));
        sum_secondary =
            sum_secondary.wrapping_add(u128::from(secondary).wrapping_mul(u128::from(primary | 1)));
        xor_secondary ^= secondary.rotate_left((primary & 63) as u32);
    }

    let mut hasher = FingerprintHasher::new();
    hasher.write_u64(WORKSPACE_METADATA_HASH_VERSION as u64);
    hasher.write_u64(stats.visited_files as u64);
    hasher.write_u64(stats.skipped_binary_extension as u64);
    hasher.write_u64(stats.skipped_too_large as u64);
    hasher.write_u64(records.len() as u64);
    hasher.write_u64(sum_primary as u64);
    hasher.write_u64((sum_primary >> 64) as u64);
    hasher.write_u64(sum_secondary as u64);
    hasher.write_u64((sum_secondary >> 64) as u64);
    hasher.write_u64(xor_secondary);
    hasher.finish()
}

fn mix_fingerprint_word(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn fingerprint_base_config(config: &EngineConfig) -> u64 {
    let mut hasher = FingerprintHasher::new();
    hasher.write_bytes(config.index_dir_name.as_bytes());
    hasher.write_u64(config.max_file_size_bytes);
    hasher.write_u64(config.shard_target_bytes);
    hasher.write_u64(config.max_files_per_shard as u64);
    hasher.write_u64(config.max_grams_per_file as u64);
    hasher.write_u64(u64::from(config.include_ignored_files));
    hasher.write_u64(u64::from(config.include_generated));
    hasher.write_u64(u64::from(config.include_migrations));
    for values in [
        &config.excluded_dir_names,
        &config.exclude_patterns,
        &config.binary_file_extensions,
    ] {
        hasher.write_u64(values.len() as u64);
        for value in values {
            hasher.write_bytes(value.as_bytes());
        }
    }
    hasher.finish()
}

fn fingerprint_shard_metadata(shards: &[ShardArtifact]) -> io::Result<(u64, bool)> {
    let mut hasher = FingerprintHasher::new();
    let mut reuse_safe = true;
    hasher.write_u64(shards.len() as u64);
    for shard in shards {
        let metadata = fs::metadata(&shard.path)?;
        let parts = metadata_fingerprint_parts(&metadata);
        reuse_safe &= parts.reuse_safe;
        hasher.write_u64(u64::from(shard.shard_id));
        hasher.write_bytes(shard.file_name.as_bytes());
        hasher.write_u64(metadata.len());
        hasher.write_u64(parts.modified_unix_secs);
        hasher.write_u64(u64::from(parts.modified_subsec_nanos));
        hasher.write_u64(parts.change_token);
        hasher.write_u64(u64::from(parts.reuse_safe));
    }
    Ok((hasher.finish(), reuse_safe))
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
        // A real empty shard is the durable representation of an empty (or
        // fully excluded) workspace. Without it, readiness can never
        // distinguish a complete empty index from a torn build and every
        // search falls back to a workspace scan.
        return vec![records];
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut current_bytes = 0u64;

    for (idx, record) in records.iter().enumerate() {
        let estimated_size_bytes = record.size_bytes;
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
    build_id: u64,
    fingerprint: u64,
    workspace_metadata_fingerprint: u64,
    config_fingerprint: u64,
    shard_metadata_fingerprint: u64,
    index_scope: &str,
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
        "{{\"engine\":{},\"schemaVersion\":{},\"workspaceMetadataHashVersion\":{},\"indexScope\":{},\"workspaceRoot\":{},\"indexRoot\":{},\"createdUnixSecs\":{},\"buildId\":{},\"fingerprint\":{},\"workspaceMetadataFingerprint\":{},\"configFingerprint\":{},\"shardMetadataFingerprint\":{},\"stats\":{{\"visitedFiles\":{},\"indexedFiles\":{},\"skippedBinary\":{},\"skippedBinaryExtension\":{},\"skippedTooLarge\":{},\"decodedUtf16Files\":{},\"shardCount\":{},\"totalGrams\":{},\"totalSourceBytes\":{},\"totalShardBytes\":{}}},\"baseShards\":[{}],\"overlay\":{},\"overlayJournal\":{},\"compactionSuggested\":false}}",
        json_string(ENGINE_NAME),
        SCHEMA_VERSION,
        WORKSPACE_METADATA_HASH_VERSION,
        json_string(index_scope),
        json_string(&workspace_root.to_string_lossy()),
        json_string(&index_root.to_string_lossy()),
        created_unix_secs,
        json_string(&build_id.to_string()),
        fingerprint,
        workspace_metadata_fingerprint,
        config_fingerprint,
        shard_metadata_fingerprint,
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
    use super::{
        build_indexed_document_from_record, fingerprint_workspace_metadata, index_directory,
        index_directory_with_options, metadata_fingerprint_parts, next_index_build_id,
        validate_content_snapshots, ContentSnapshot, IndexBuildOptions, IndexFileRecord,
    };
    use crate::config::{ripgrep_executable, EngineConfig};
    use crate::mmap_store::{acquire_index_read_lock, StoreLayout};
    use crate::overlay::OverlayManifest;
    use crate::protocol::json_string;
    use crate::shard::{open_validated_base_shard, read_base_shard_set, ShardReader};
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

        let artifacts = index_directory(&root.join("."), &config)?;
        assert_eq!(artifacts.summary.shard_count, 3);
        let manifest = fs::read_to_string(root.join(".zoek-rs/manifest.json"))?;
        assert!(manifest.contains("\"schemaVersion\":22"));
        assert!(manifest.contains("\"indexScope\":\"workspace\""));
        assert!(manifest.contains("\"workspaceMetadataHashVersion\":3"));
        assert!(manifest.contains("\"buildId\":\""));
        assert!(manifest.contains("\"workspaceMetadataFingerprint\":"));
        assert!(manifest.contains("\"configFingerprint\":"));
        assert!(manifest.contains("\"shardMetadataFingerprint\":"));
        assert!(manifest.contains(&format!(
            "\"workspaceRoot\":{}",
            json_string(&fs::canonicalize(&root)?.to_string_lossy())
        )));
        assert!(manifest.contains(&format!(
            "\"indexRoot\":{}",
            json_string(&fs::canonicalize(root.join(".zoek-rs"))?.to_string_lossy())
        )));
        assert!(manifest.contains("base-shard-0000.zrs"));

        let reader = ShardReader::open(&root.join(".zoek-rs/base-shard-0000.zrs"))?;
        assert_eq!(reader.header().doc_count, 1);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn empty_workspace_writes_a_complete_reusable_empty_shard() -> io::Result<()> {
        let root = temp_dir("empty-workspace");
        fs::create_dir_all(&root)?;
        let config = EngineConfig::default();
        let initial = index_directory(&root, &config)?;
        assert_eq!(initial.summary.indexed_files, 0);
        assert_eq!(initial.summary.shard_count, 1);
        assert!(ShardReader::open(&initial.shards[0].path)?
            .documents()?
            .is_empty());

        let mut details = Vec::new();
        let reused = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| details.push(progress.detail),
        )?;
        assert!(reported_clean_reuse(&details));
        assert_eq!(reused.summary.shard_count, 1);

        let manifest_path = root.join(".zoek-rs/manifest.json");
        let missing_zero_stat =
            fs::read_to_string(&manifest_path)?.replace("\"indexedFiles\":0,", "");
        fs::write(&manifest_path, missing_zero_stat)?;
        let mut repair_details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| repair_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&repair_details));
        assert!(fs::read_to_string(&manifest_path)?.contains("\"indexedFiles\":0"));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn workspace_scope_respects_ignore_rules_and_all_scope_is_explicit() -> io::Result<()> {
        let root = temp_dir("workspace-scope");
        fs::create_dir_all(root.join("source"))?;
        fs::create_dir_all(root.join("artifacts"))?;
        fs::create_dir_all(root.join(".git"))?;
        fs::write(root.join(".ignore"), "artifacts/\n")?;
        fs::write(root.join("source/unit.rs"), "pub fn active() {}\n")?;
        fs::write(root.join("artifacts/unit.rs"), "pub fn cached() {}\n")?;
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        if !Command::new(ripgrep_executable())
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            fs::remove_dir_all(root)?;
            return Ok(());
        }

        let workspace_config = EngineConfig::default();
        let workspace_artifacts = index_directory(&root, &workspace_config)?;
        let workspace_paths = document_paths(&workspace_artifacts)?;
        assert!(workspace_paths.contains(&String::from("source/unit.rs")));
        assert!(!workspace_paths.contains(&String::from("artifacts/unit.rs")));
        assert!(!workspace_paths.contains(&String::from(".git/HEAD")));

        let mut all_files_config = EngineConfig::default();
        all_files_config.include_ignored_files = true;
        let all_files_artifacts = index_directory_with_options(
            &root,
            &all_files_config,
            IndexBuildOptions { force: true },
            &mut |_| {},
        )?;
        assert!(document_paths(&all_files_artifacts)?.contains(&String::from("artifacts/unit.rs")));
        assert!(document_paths(&all_files_artifacts)?.contains(&String::from(".git/HEAD")));
        assert!(fs::read_to_string(root.join(".zoek-rs/manifest.json"))?
            .contains("\"indexScope\":\"all\""));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn force_rebuild_bypasses_clean_index_reuse() -> io::Result<()> {
        let root = temp_dir("force-rebuild");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/record.rs"), "pub const VALUE: usize = 1;\n")?;
        let config = EngineConfig::default();

        let initial = index_directory(&root, &config)?;
        let initial_build_id = ShardReader::open(&initial.shards[0].path)?
            .header()
            .build_id;
        let mut reuse_details = Vec::new();
        let reused = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| reuse_details.push(progress.detail),
        )?;
        assert!(
            reuse_details
                .iter()
                .any(|detail| detail.starts_with("reused clean index from ")),
            "a normal rebuild should retain the validated clean-reuse path"
        );
        assert_eq!(
            reused.fingerprint, initial.fingerprint,
            "a clean workspace should reuse the existing base snapshot"
        );

        fs::write(
            root.join("src/record.rs"),
            "pub const REPLACEMENT_VALUE: usize = 10_000;\n",
        )?;
        let mut forced_details = Vec::new();
        let forced = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions { force: true },
            &mut |progress| forced_details.push(progress.detail),
        )?;
        assert!(
            forced_details
                .iter()
                .any(|detail| detail == "force rebuild bypassing clean index reuse"),
            "force must reach the indexer instead of stopping at CLI parsing"
        );
        assert!(
            !forced_details
                .iter()
                .any(|detail| detail.starts_with("reused clean index from ")),
            "force must not report a clean index reuse"
        );
        assert_ne!(
            forced.fingerprint, initial.fingerprint,
            "force should rebuild base shards from the changed workspace"
        );
        let forced_build_id = ShardReader::open(&forced.shards[0].path)?.header().build_id;
        assert!(
            forced_build_id > initial_build_id,
            "every completed rebuild must advance the base snapshot identity"
        );
        let forced_manifest = fs::read_to_string(root.join(".zoek-rs/manifest.json"))?;
        assert!(forced_manifest.contains(&format!("\"buildId\":\"{forced_build_id}\"")));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn done_progress_runs_after_the_index_writer_is_unlocked() -> io::Result<()> {
        let root = temp_dir("done-after-unlock");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/record.rs"), "pub fn value() -> u32 { 7 }\n")?;
        let config = EngineConfig::default();
        let layout = StoreLayout::for_workspace(&root, &config);

        for force in [true, false] {
            let mut done_events = 0usize;
            index_directory_with_options(
                &root,
                &config,
                IndexBuildOptions { force },
                &mut |progress| {
                    if progress.phase != "done" {
                        return;
                    }
                    let read_guard = acquire_index_read_lock(&layout)
                        .expect("done callback must be able to read the completed index");
                    assert!(read_guard.is_some());
                    done_events += 1;
                },
            )?;
            assert_eq!(done_events, 1);
        }

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_rejects_same_size_edits_and_same_count_renames() -> io::Result<()> {
        let root = temp_dir("clean-reuse-metadata");
        fs::create_dir_all(root.join("src"))?;
        let original_path = root.join("src/first.rs");
        fs::write(&original_path, "pub const VALUE: u32 = 1;\n")?;
        let config = EngineConfig::default();
        let initial = index_directory(&root, &config)?;
        let initial_hash = first_document_hash(&initial)?;
        let initial_modified = fs::metadata(&original_path)?.modified()?;

        let mut modified_changed = false;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(2));
            fs::write(&original_path, "pub const VALUE: u32 = 2;\n")?;
            if fs::metadata(&original_path)?.modified()? != initial_modified {
                modified_changed = true;
                break;
            }
        }
        assert!(
            modified_changed,
            "fixture filesystem must expose an mtime change"
        );
        let mut edit_details = Vec::new();
        let edited = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| edit_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&edit_details));
        assert_ne!(first_document_hash(&edited)?, initial_hash);

        let renamed_path = root.join("src/second.rs");
        fs::rename(&original_path, &renamed_path)?;
        let mut rename_details = Vec::new();
        let renamed = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| rename_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&rename_details));
        assert_eq!(document_paths(&renamed)?, vec!["src/second.rs".to_string()]);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_rejects_base_config_changes_and_rg_honors_exclusions() -> io::Result<()> {
        let root = temp_dir("clean-reuse-config");
        fs::create_dir_all(root.join("src/derived"))?;
        fs::write(root.join("src/main.rs"), "pub fn run() {}\n")?;
        fs::write(root.join("src/derived/output.rs"), "pub fn derived() {}\n")?;
        let initial_config = EngineConfig::default();
        let initial = index_directory(&root, &initial_config)?;
        assert_eq!(document_paths(&initial)?.len(), 2);

        let mut changed_config = initial_config.clone();
        changed_config.add_exclude_pattern("src/derived/**".to_string());
        let mut details = Vec::new();
        let rebuilt = index_directory_with_options(
            &root,
            &changed_config,
            IndexBuildOptions::default(),
            &mut |progress| details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&details));
        assert_eq!(document_paths(&rebuilt)?, vec!["src/main.rs".to_string()]);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_detects_files_crossing_the_index_size_boundary() -> io::Result<()> {
        let root = temp_dir("clean-reuse-size-boundary");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/main.rs"), "pub fn run() {}\n")?;
        let boundary_path = root.join("src/record.txt");
        fs::write(&boundary_path, "x".repeat(128))?;
        let mut config = EngineConfig::default();
        config.max_file_size_bytes = 64;
        let initial = index_directory(&root, &config)?;
        assert_eq!(document_paths(&initial)?, vec!["src/main.rs".to_string()]);

        fs::write(&boundary_path, "now indexable\n")?;
        let mut details = Vec::new();
        let rebuilt = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&details));
        assert_eq!(
            document_paths(&rebuilt)?,
            vec!["src/main.rs".to_string(), "src/record.txt".to_string()],
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn workspace_metadata_fingerprint_is_independent_of_enumeration_order() {
        let root = PathBuf::from("/virtual-workspace");
        let record = |rel_path: &str, size_bytes: u64| IndexFileRecord {
            rel_path: rel_path.to_string(),
            abs_path: root.join(rel_path),
            size_bytes,
            modified_unix_secs: 10,
            modified_subsec_nanos: 20,
            change_token: 30,
            metadata_reuse_safe: true,
        };
        let stats = crate::corpus::CorpusStats {
            visited_files: 2,
            ..Default::default()
        };
        let forward = vec![record("src/first.rs", 10), record("src/second.rs", 20)];
        let reverse = vec![record("src/second.rs", 20), record("src/first.rs", 10)];
        assert_eq!(
            fingerprint_workspace_metadata(&forward, &stats),
            fingerprint_workspace_metadata(&reverse, &stats),
        );
    }

    #[test]
    fn content_read_rejects_files_changed_after_metadata_scan() -> io::Result<()> {
        let root = temp_dir("content-read-race");
        fs::create_dir_all(&root)?;
        let path = root.join("record.txt");
        fs::write(&path, "before\n")?;
        let metadata = fs::metadata(&path)?;
        let parts = metadata_fingerprint_parts(&metadata);
        let record = IndexFileRecord {
            rel_path: "record.txt".to_string(),
            abs_path: path.clone(),
            size_bytes: metadata.len(),
            modified_unix_secs: parts.modified_unix_secs,
            modified_subsec_nanos: parts.modified_subsec_nanos,
            change_token: parts.change_token,
            metadata_reuse_safe: parts.reuse_safe,
        };

        fs::write(&path, "after the scan and larger\n")?;
        let changed = build_indexed_document_from_record(&record, &EngineConfig::default())
            .err()
            .expect("a changed file must abort snapshot publication");
        assert_eq!(changed.kind(), io::ErrorKind::InvalidData);

        fs::remove_file(&path)?;
        let missing = build_indexed_document_from_record(&record, &EngineConfig::default())
            .err()
            .expect("a missing file must abort snapshot publication");
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn content_snapshot_detects_edits_when_metadata_identity_is_not_reusable() -> io::Result<()> {
        let root = temp_dir("content-snapshot-validation");
        fs::create_dir_all(&root)?;
        let path = root.join("record.txt");
        fs::write(&path, "before")?;
        let before_metadata = fs::metadata(&path)?;
        let before_parts = metadata_fingerprint_parts(&before_metadata);
        let before_record = IndexFileRecord {
            rel_path: "record.txt".to_string(),
            abs_path: path.clone(),
            size_bytes: before_metadata.len(),
            modified_unix_secs: before_parts.modified_unix_secs,
            modified_subsec_nanos: before_parts.modified_subsec_nanos,
            change_token: before_parts.change_token,
            metadata_reuse_safe: false,
        };
        let (_, before_hash) =
            build_indexed_document_from_record(&before_record, &EngineConfig::default())?;

        fs::write(&path, "after!")?;
        let after_metadata = fs::metadata(&path)?;
        let after_parts = metadata_fingerprint_parts(&after_metadata);
        let after_record = IndexFileRecord {
            rel_path: "record.txt".to_string(),
            abs_path: path,
            size_bytes: after_metadata.len(),
            modified_unix_secs: after_parts.modified_unix_secs,
            modified_subsec_nanos: after_parts.modified_subsec_nanos,
            change_token: after_parts.change_token,
            metadata_reuse_safe: false,
        };
        let err = validate_content_snapshots(
            &[after_record],
            &[ContentSnapshot {
                rel_path: "record.txt".to_string(),
                hash: before_hash,
            }],
        )
        .expect_err("different indexed bytes must invalidate the snapshot");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn missing_or_malformed_overlay_forces_rebuild_instead_of_clean_reuse() -> io::Result<()> {
        let root = temp_dir("overlay-reuse-contract");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/record.rs"), "struct Record {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let layout = StoreLayout::for_workspace(&root, &config);

        for replacement in [None, Some("{}")] {
            if let Some(text) = replacement {
                fs::write(&layout.overlay_path, text)?;
            } else {
                fs::remove_file(&layout.overlay_path)?;
            }
            let before = fs::read_to_string(&layout.manifest_path)?;
            let mut details = Vec::new();
            index_directory_with_options(
                &root,
                &config,
                IndexBuildOptions::default(),
                &mut |progress| details.push(progress.detail),
            )?;
            assert!(!reported_clean_reuse(&details));
            assert_ne!(fs::read_to_string(&layout.manifest_path)?, before);
            let overlay = OverlayManifest::load(&layout.overlay_path)?;
            assert_eq!(overlay.generation, 0);
            assert!(overlay.entries.is_empty());
        }

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn trailing_manifest_data_forces_a_rebuild() -> io::Result<()> {
        let root = temp_dir("strict-manifest-contract");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/record.rs"), "struct Record {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let manifest_path = root.join(".zoek-rs/manifest.json");
        let initial = fs::read_to_string(&manifest_path)?;
        fs::write(&manifest_path, format!("{initial}\ntrailing"))?;

        let mut details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&details));
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&manifest_path)?)
            .expect("the rebuilt manifest must be complete JSON");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_revalidates_the_workspace_snapshot() -> io::Result<()> {
        let root = temp_dir("reuse-linearization");
        fs::create_dir_all(root.join("src"))?;
        let source_path = root.join("src/record.rs");
        fs::write(&source_path, "const MARKER: &str = \"before\";\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let manifest_path = root.join(".zoek-rs/manifest.json");
        let initial_manifest = fs::read_to_string(&manifest_path)?;

        let mut changed = false;
        let mut details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| {
                if !changed && progress.detail == "validating the unchanged workspace snapshot" {
                    fs::write(&source_path, "const MARKER: &str = \"after and larger\";\n")
                        .expect("fixture mutation must succeed");
                    changed = true;
                }
                details.push(progress.detail);
            },
        )?;
        assert!(changed);
        assert!(!reported_clean_reuse(&details));
        assert_ne!(fs::read_to_string(&manifest_path)?, initial_manifest);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn publication_rejects_changes_after_a_shard_was_built() -> io::Result<()> {
        let root = temp_dir("publication-linearization");
        fs::create_dir_all(root.join("src"))?;
        let source_path = root.join("src/record.rs");
        fs::write(&source_path, "const MARKER: &str = \"before\";\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let layout = StoreLayout::for_workspace(&root, &config);
        let initial_manifest = fs::read_to_string(&layout.manifest_path)?;

        let mut changed = false;
        let err = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions { force: true },
            &mut |progress| {
                if !changed
                    && progress.phase == "write"
                    && progress.current == progress.total
                    && progress.detail.starts_with("building and writing shards")
                {
                    fs::write(&source_path, "const MARKER: &str = \"after and larger\";\n")
                        .expect("fixture mutation must succeed");
                    changed = true;
                }
            },
        )
        .expect_err("a changed snapshot must not be published");
        assert!(changed);
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(fs::read_to_string(&layout.manifest_path)?, initial_manifest);
        let stale_base = read_base_shard_set(&layout)?;
        open_validated_base_shard(stale_base.identity, 0, &stale_base.paths[0])?;

        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions { force: true },
            &mut |_progress| {},
        )?;
        assert_ne!(fs::read_to_string(&layout.manifest_path)?, initial_manifest);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn corrupt_maximum_build_id_does_not_block_forced_recovery() -> io::Result<()> {
        let root = temp_dir("build-id-recovery");
        fs::create_dir_all(&root)?;
        let layout = StoreLayout::for_workspace(&root, &EngineConfig::default());
        layout.ensure_dirs()?;
        fs::write(
            &layout.manifest_path,
            format!("{{\"buildId\":\"{}\"}}", u64::MAX),
        )?;

        let recovered = next_index_build_id(&layout)?;
        assert!(recovered > 0);
        assert_ne!(recovered, u64::MAX);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn journal_cleanup_failure_prevents_new_manifest_publication() -> io::Result<()> {
        let root = temp_dir("journal-cleanup-failure");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/record.rs"), "pub fn value() {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let layout = StoreLayout::for_workspace(&root, &config);
        let manifest_before = fs::read(&layout.manifest_path)?;
        fs::create_dir(&layout.overlay_journal_path)?;

        let error = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions { force: true },
            &mut |_| {},
        )
        .err()
        .expect("an undeletable stale journal must abort publication");
        assert_ne!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(fs::read(&layout.manifest_path)?, manifest_before);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_is_read_only_and_corrupt_shards_trigger_rebuild() -> io::Result<()> {
        let root = temp_dir("clean-reuse-read-only");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/main.rs"), "pub fn run() {}\n")?;
        let config = EngineConfig::default();
        let initial = index_directory(&root, &config)?;
        let overlay_path = root.join(".zoek-rs/hot-overlay.json");
        let preserved_overlay =
            "{\"generation\":0,\"updatedUnixSecs\":0,\"entries\":[],\"marker\":\"preserve\"}";
        fs::write(&overlay_path, preserved_overlay)?;
        let mut reuse_details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| reuse_details.push(progress.detail),
        )?;
        assert!(reported_clean_reuse(&reuse_details));
        assert_eq!(fs::read_to_string(&overlay_path)?, preserved_overlay);

        let mut corrupted_bytes = fs::read(&initial.shards[0].path)?;
        let last = corrupted_bytes
            .last_mut()
            .expect("fixture shard must contain a payload");
        *last ^= 0x01;
        fs::write(&initial.shards[0].path, corrupted_bytes)?;
        let mut rebuild_details = Vec::new();
        let rebuilt = index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| rebuild_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&rebuild_details));
        assert_eq!(document_paths(&rebuilt)?, vec!["src/main.rs".to_string()]);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn clean_reuse_rejects_per_shard_stats_that_do_not_match_headers() -> io::Result<()> {
        let root = temp_dir("per-shard-manifest-contract");
        fs::create_dir_all(root.join("src"))?;
        fs::write(
            root.join("src/first.rs"),
            "const FIRST: &str = \"short\";\n",
        )?;
        fs::write(
            root.join("src/second.rs"),
            "const SECOND: &str = \"a substantially longer token sequence\";\n",
        )?;
        let mut config = EngineConfig::default();
        config.max_files_per_shard = 1;
        let artifacts = index_directory(&root, &config)?;
        assert_eq!(artifacts.shards.len(), 2);

        let manifest_path = root.join(".zoek-rs/manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path)?).map_err(io::Error::other)?;
        let shards = manifest["baseShards"]
            .as_array_mut()
            .expect("baseShards must be an array");
        let first_grams = shards[0]["gramCount"]
            .as_u64()
            .expect("gramCount must be numeric");
        let second_grams = shards[1]["gramCount"]
            .as_u64()
            .expect("gramCount must be numeric");
        assert_ne!(first_grams, second_grams);
        shards[0]["gramCount"] = serde_json::Value::from(second_grams);
        shards[1]["gramCount"] = serde_json::Value::from(first_grams);
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).map_err(io::Error::other)?,
        )?;

        let mut details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&details));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn configured_index_roots_are_excluded_for_relative_and_absolute_paths() -> io::Result<()> {
        for absolute in [false, true] {
            let root = temp_dir(if absolute {
                "absolute-index-root"
            } else {
                "relative-index-root"
            });
            fs::create_dir_all(root.join("src"))?;
            fs::write(root.join("src/main.rs"), "pub fn run() {}\n")?;
            let mut config = EngineConfig::default();
            config.index_dir_name = if absolute {
                root.join("state/search-index")
                    .to_string_lossy()
                    .into_owned()
            } else {
                "state/search-index".to_string()
            };

            let initial = index_directory(&root, &config)?;
            assert_eq!(document_paths(&initial)?, vec!["src/main.rs".to_string()]);

            let mut details = Vec::new();
            let reused = index_directory_with_options(
                &root,
                &config,
                IndexBuildOptions::default(),
                &mut |progress| details.push(progress.detail),
            )?;
            assert!(reported_clean_reuse(&details));
            assert_eq!(document_paths(&reused)?, vec!["src/main.rs".to_string()]);

            fs::remove_dir_all(root)?;
        }
        Ok(())
    }

    #[test]
    fn legacy_manifests_and_non_empty_overlays_bypass_clean_reuse() -> io::Result<()> {
        let root = temp_dir("reuse-contract-migration");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/main.rs"), "pub fn run() {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;

        let manifest_path = root.join(".zoek-rs/manifest.json");
        let legacy_manifest = fs::read_to_string(&manifest_path)?
            .replace("\"workspaceMetadataHashVersion\":3,", "")
            .replace(
                "\"workspaceMetadataFingerprint\":",
                "\"legacyFingerprint\":",
            );
        fs::write(&manifest_path, legacy_manifest)?;
        let mut legacy_details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| legacy_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&legacy_details));

        fs::write(
            root.join(".zoek-rs/hot-overlay.json"),
            "{\"generation\":1,\"updatedUnixSecs\":1,\"entries\":[{\"relPath\":\"src/main.rs\",\"generation\":1,\"tombstone\":true,\"modifiedUnixSecs\":1,\"contentHash\":0,\"grams\":[]}]}",
        )?;
        let mut overlay_details = Vec::new();
        index_directory_with_options(
            &root,
            &config,
            IndexBuildOptions::default(),
            &mut |progress| overlay_details.push(progress.detail),
        )?;
        assert!(!reported_clean_reuse(&overlay_details));
        assert!(
            fs::read_to_string(root.join(".zoek-rs/hot-overlay.json"))?.contains("\"entries\":[]")
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn base_document_hash_matches_incremental_sync_metadata_contract() -> io::Result<()> {
        let root = temp_dir("metadata-contract");
        fs::create_dir_all(root.join("src"))?;
        let file_path = root.join("src/record.rs");
        let source = "pub fn compute(value: usize) -> usize { value + 1 }\n";
        fs::write(&file_path, source)?;
        let config = EngineConfig::default();
        let artifacts = index_directory(&root, &config)?;

        let metadata = fs::metadata(&file_path)?;
        let expected = super::stable_record_hash_for_metadata("src/record.rs", &metadata)
            .expect("fixture metadata must expose a modification time");
        let mut actual = None;
        for shard in &artifacts.shards {
            for document in ShardReader::open(&shard.path)?.documents()? {
                if document.rel_path == "src/record.rs" {
                    actual = Some(document.content_hash);
                }
            }
        }
        assert_eq!(actual, Some(expected));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    fn reported_clean_reuse(details: &[String]) -> bool {
        details
            .iter()
            .any(|detail| detail.starts_with("reused clean index from "))
    }

    fn document_paths(artifacts: &super::IndexArtifacts) -> io::Result<Vec<String>> {
        let mut paths = Vec::new();
        for shard in &artifacts.shards {
            paths.extend(
                ShardReader::open(&shard.path)?
                    .documents()?
                    .into_iter()
                    .map(|document| document.rel_path),
            );
        }
        paths.sort();
        Ok(paths)
    }

    fn first_document_hash(artifacts: &super::IndexArtifacts) -> io::Result<u64> {
        for shard in &artifacts.shards {
            if let Some(document) = ShardReader::open(&shard.path)?
                .documents()?
                .into_iter()
                .next()
            {
                return Ok(document.content_hash);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "fixture index did not contain a document",
        ))
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
