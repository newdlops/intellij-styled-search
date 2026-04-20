use crate::config::{EngineConfig, ENGINE_NAME, SCHEMA_VERSION};
use crate::corpus::discover_text_files;
use crate::gram::extract_dynamic_grams;
use crate::mmap_store::{write_atomically, StoreLayout};
use crate::overlay::OverlayManifest;
use crate::protocol::json_string;
use crate::shard::{build_shard_bytes, IndexedDocument, ShardReader};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::{Path, PathBuf};
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

pub fn index_directory(workspace_root: &Path, config: &EngineConfig) -> io::Result<IndexArtifacts> {
    let (entries, corpus_stats) = discover_text_files(workspace_root, config)?;
    let layout = StoreLayout::for_workspace(workspace_root, config);
    layout.ensure_dirs()?;
    let _ = layout.cleanup_stale_temp_files(30);
    layout.clear_stale_base_shards()?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);

    let indexed_docs = entries
        .iter()
        .map(|entry| IndexedDocument {
            rel_path: entry.rel_path.clone(),
            byte_len: entry.size_bytes,
            modified_unix_secs: entry.modified_unix_secs,
            content_hash: stable_hash(&entry.text),
            grams: extract_dynamic_grams(&entry.rel_path, &entry.text, config.max_grams_per_file)
                .into_iter()
                .map(|gram| gram.value)
                .collect(),
        })
        .collect::<Vec<_>>();

    let fingerprint = fingerprint_documents(&indexed_docs);
    let shards = partition_documents(&indexed_docs, config);
    let mut shard_artifacts = Vec::with_capacity(shards.len());
    let mut total_grams = 0usize;
    let mut total_source_bytes = 0u64;
    let mut total_shard_bytes = 0u64;

    for (shard_id, docs) in shards.iter().enumerate() {
        let shard_id = shard_id as u32;
        let build = build_shard_bytes(shard_id, now, docs)?;
        let path = layout.shard_path(shard_id);
        write_atomically(&path, &build.bytes)?;
        let reader = ShardReader::open(&path)?;
        let header = reader.header().clone();
        total_grams += header.gram_count;
        total_source_bytes += build.source_bytes;
        total_shard_bytes += build.bytes.len() as u64;
        shard_artifacts.push(ShardArtifact {
            shard_id,
            file_name: layout.shard_file_name(shard_id),
            path,
            doc_count: header.doc_count,
            gram_count: header.gram_count,
            file_bytes: build.bytes.len() as u64,
            source_bytes: build.source_bytes,
        });
    }

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

fn partition_documents<'a>(
    docs: &'a [IndexedDocument],
    config: &EngineConfig,
) -> Vec<&'a [IndexedDocument]> {
    if docs.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut current_bytes = 0u64;

    for (idx, doc) in docs.iter().enumerate() {
        let would_overflow_bytes =
            idx > start && current_bytes + doc.byte_len > config.shard_target_bytes;
        let would_overflow_files = idx - start >= config.max_files_per_shard;
        if would_overflow_bytes || would_overflow_files {
            out.push(&docs[start..idx]);
            start = idx;
            current_bytes = 0;
        }
        current_bytes += doc.byte_len;
    }
    out.push(&docs[start..]);
    out
}

fn stable_hash(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn fingerprint_documents(docs: &[IndexedDocument]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for doc in docs {
        doc.rel_path.hash(&mut hasher);
        doc.byte_len.hash(&mut hasher);
        doc.modified_unix_secs.hash(&mut hasher);
        doc.content_hash.hash(&mut hasher);
        for gram in &doc.grams {
            gram.hash(&mut hasher);
        }
    }
    hasher.finish()
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
        &artifacts.shards.first().map(|shard| &shard.path).unwrap_or(&artifacts.layout.manifest_path),
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
        assert!(manifest.contains("\"schemaVersion\":1"));
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
