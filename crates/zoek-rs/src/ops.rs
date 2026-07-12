use crate::config::EngineConfig;
use crate::indexer::{index_directory, index_directory_with_progress};
use crate::mmap_store::{acquire_index_read_lock, StoreLayout};
use crate::overlay::{apply_change_batch, compaction_reason, load_overlay_with_recovery};
use crate::planner::{build_query_plan, QueryPlan};
use crate::protocol::{
    BenchmarkCase, BenchmarkResponse, DiagnoseResponse, EngineInfo, GramDiagnostic, InfoResponse,
    RuntimeStats, SearchRequest, ShardDiagnostic,
};
use crate::searcher::search_workspace;
use crate::shard::{open_validated_base_shard, read_base_shard_set, ShardDocument, ShardReader};
use crate::verifier::matches_path_filters;
use crate::watcher::build_change_batch;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub fn collect_info(workspace_root: &Path, config: &EngineConfig) -> io::Result<InfoResponse> {
    let layout = StoreLayout::for_workspace(workspace_root, config);
    let _read_lock = acquire_index_read_lock(&layout)?;
    let cleaned_temp_files = Vec::new();
    let manifest_present = layout.manifest_path.exists();

    let overlay = match load_overlay_with_recovery(&layout) {
        Ok(result) => result,
        Err(err) if err.kind() == io::ErrorKind::NotFound => crate::overlay::OverlayLoadResult {
            manifest: crate::overlay::OverlayManifest::empty(),
            warnings: vec![],
            recovered: false,
        },
        Err(err) => {
            return Err(err);
        }
    };
    let latest_overlay = overlay.manifest.latest_stats();
    let journal_bytes = fs::metadata(&layout.overlay_journal_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    let mut shards = Vec::new();
    let mut warnings = overlay.warnings;
    let mut total_document_count = 0usize;
    let mut total_gram_count = 0usize;
    let mut total_shard_bytes = 0u64;
    match read_base_shard_set(&layout) {
        Ok(base_shards) => {
            let mut validated = true;
            let mut document_count = 0usize;
            let mut gram_count = 0usize;
            let mut shard_bytes = 0u64;
            for (shard_id, shard_path) in base_shards.paths.iter().enumerate() {
                let file_name = shard_file_name(&shard_path);
                let file_bytes = fs::metadata(&shard_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let reader =
                    match open_validated_base_shard(base_shards.identity, shard_id, shard_path) {
                        Ok(reader) => reader,
                        Err(err) => {
                            validated = false;
                            warnings.push(format!("base index validation failed: {err}"));
                            shards.push(invalid_shard_diagnostic(shard_path));
                            continue;
                        }
                    };
                let docs = reader.documents()?;
                let header = reader.header();
                let source_bytes = docs.iter().map(|doc| doc.byte_len).sum::<u64>();
                document_count += docs.len();
                gram_count += header.gram_count;
                shard_bytes += file_bytes;
                shards.push(ShardDiagnostic {
                    file_name,
                    shard_id: header.shard_id,
                    doc_count: docs.len(),
                    gram_count: header.gram_count,
                    source_bytes,
                    file_bytes,
                    created_unix_secs: header.created_unix_secs,
                    valid: true,
                });
            }
            if validated {
                total_document_count = document_count;
                total_gram_count = gram_count;
                total_shard_bytes = shard_bytes;
            } else {
                for shard in &mut shards {
                    shard.valid = false;
                }
            }
        }
        Err(err) => {
            warnings.push(format!("base index validation failed: {err}"));
            for shard_path in layout.list_shard_paths()? {
                shards.push(invalid_shard_diagnostic(&shard_path));
            }
        }
    }

    Ok(InfoResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: workspace_root.to_string_lossy().into_owned(),
        index_dir: layout.root.to_string_lossy().into_owned(),
        manifest_present,
        recovered_overlay: overlay.recovered,
        total_document_count,
        total_gram_count,
        total_shard_bytes,
        overlay_generation: overlay.manifest.generation,
        overlay_entries: overlay.manifest.entries.len(),
        overlay_live_entries: latest_overlay.live_entries,
        overlay_tombstones: latest_overlay.tombstones,
        journal_bytes,
        compaction_suggested: compaction_reason(&overlay.manifest, journal_bytes, config).is_some(),
        cleaned_temp_files,
        warnings,
        process: current_runtime_stats(),
        shards,
    })
}

fn shard_file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn invalid_shard_diagnostic(path: &Path) -> ShardDiagnostic {
    let file_name = shard_file_name(path);
    let file_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if let Ok(reader) = ShardReader::open(path) {
        let header = reader.header();
        let documents = reader.documents().unwrap_or_default();
        return ShardDiagnostic {
            file_name,
            shard_id: header.shard_id,
            doc_count: documents.len(),
            gram_count: header.gram_count,
            source_bytes: documents.iter().map(|doc| doc.byte_len).sum(),
            file_bytes,
            created_unix_secs: header.created_unix_secs,
            valid: false,
        };
    }
    ShardDiagnostic {
        file_name,
        shard_id: 0,
        doc_count: 0,
        gram_count: 0,
        source_bytes: 0,
        file_bytes,
        created_unix_secs: 0,
        valid: false,
    }
}

pub fn diagnose_query(
    request: &SearchRequest,
    config: &EngineConfig,
) -> Result<DiagnoseResponse, String> {
    let workspace_root = Path::new(&request.workspace_root);
    let layout = StoreLayout::for_workspace(workspace_root, config);
    let _read_lock = acquire_index_read_lock(&layout).map_err(|err| err.to_string())?;
    let plan = build_query_plan(request);

    let overlay = load_overlay_with_recovery(&layout).map_err(|err| err.to_string())?;
    let latest_overlay = overlay.manifest.latest_entries();
    let overlay_live_entries = latest_overlay
        .values()
        .filter(|entry| !entry.tombstone)
        .count();
    let warnings = overlay.warnings;

    let mut grams = plan
        .required_grams
        .iter()
        .map(|gram| GramDiagnostic {
            gram: gram.clone(),
            doc_freq: 0,
        })
        .collect::<Vec<_>>();
    let mut final_candidates = BTreeSet::new();
    let mut base_document_count = 0usize;
    let mut base_candidate_count = 0usize;
    let mut overlay_candidate_count = 0usize;
    let mut fallback_reason = None;

    match read_base_shard_set(&layout) {
        Ok(base_shards) => {
            let mut base_valid = true;
            for (shard_id, shard_path) in base_shards.paths.iter().enumerate() {
                let reader =
                    match open_validated_base_shard(base_shards.identity, shard_id, shard_path) {
                        Ok(reader) => reader,
                        Err(err) => {
                            fallback_reason = Some(format!(
                            "base index validation failed; a full scan would be required: {err}"
                        ));
                            base_valid = false;
                            break;
                        }
                    };
                let docs = reader.documents().map_err(|err| err.to_string())?;
                base_document_count += docs.len();
                for gram in &mut grams {
                    gram.doc_freq += reader
                        .find_posting(&gram.gram)
                        .map_err(|err| err.to_string())?
                        .map(|posting| posting.doc_ids.len())
                        .unwrap_or(0);
                }
                let selected_ids =
                    candidate_doc_ids(&reader, &plan).map_err(|err| err.to_string())?;
                let selected_docs = docs_for_ids(&docs, &selected_ids);
                base_candidate_count += selected_docs.len();
                for doc in selected_docs {
                    if latest_overlay.contains_key(&doc.rel_path) {
                        continue;
                    }
                    if !matches_path_filters(&doc.rel_path, &plan.include, &plan.exclude) {
                        continue;
                    }
                    final_candidates.insert(doc.rel_path.clone());
                }
            }
            if !base_valid {
                for gram in &mut grams {
                    gram.doc_freq = 0;
                }
                base_document_count = 0;
                base_candidate_count = 0;
                final_candidates.clear();
            }
        }
        Err(err) => {
            fallback_reason = Some(format!(
                "base index validation failed; a full scan would be required: {err}"
            ));
        }
    }

    for overlay_entry in latest_overlay.values() {
        if overlay_entry.tombstone {
            final_candidates.remove(&overlay_entry.rel_path);
            continue;
        }
        if !matches_path_filters(&overlay_entry.rel_path, &plan.include, &plan.exclude) {
            continue;
        }
        if !overlay_matches_plan(overlay_entry, &plan) {
            continue;
        }
        overlay_candidate_count += 1;
        final_candidates.insert(overlay_entry.rel_path.clone());
    }

    Ok(DiagnoseResponse {
        ok: true,
        engine: EngineInfo::current(),
        workspace_root: request.workspace_root.clone(),
        query: request.query.clone(),
        effective_query: plan.effective_query.clone(),
        query_mode: if request.use_regex {
            "regex".to_string()
        } else {
            "literal".to_string()
        },
        include: request.include.clone(),
        required_literals: plan.required_literals,
        required_grams: plan.required_grams,
        grams,
        base_document_count,
        base_candidate_count,
        overlay_live_entries,
        overlay_candidate_count,
        final_candidate_count: final_candidates.len(),
        candidate_sample: final_candidates.into_iter().take(20).collect(),
        fallback_reason,
        warnings,
        process: current_runtime_stats(),
    })
}

pub fn benchmark_workspaces(
    file_counts: &[usize],
    config: &EngineConfig,
) -> Result<BenchmarkResponse, String> {
    let mut warnings = Vec::new();
    if file_counts.len() > 1 {
        warnings.push(
            "peakRssBytes is a process-lifetime high-water mark; later benchmark cases include peaks from earlier cases. Run one file count per process for isolated memory measurements."
                .to_string(),
        );
    }
    let mut cases = Vec::new();
    for &file_count in file_counts {
        let root = benchmark_temp_dir(file_count);
        if root.exists() {
            let _ = fs::remove_dir_all(&root);
        }
        create_benchmark_workspace(&root, file_count).map_err(|err| err.to_string())?;

        let before = current_runtime_stats();
        let index_start = Instant::now();
        index_directory(&root, config).map_err(|err| err.to_string())?;
        let index_ms = elapsed_ms(index_start.elapsed());

        let mut reused_clean_index = false;
        let reuse_start = Instant::now();
        index_directory_with_progress(&root, config, &mut |progress| {
            reused_clean_index |= progress.detail.starts_with("reused clean index from ");
        })
        .map_err(|err| err.to_string())?;
        let reuse_ms = elapsed_ms(reuse_start.elapsed());
        if !reused_clean_index {
            return Err(format!(
                "synthetic benchmark did not reuse the unchanged {file_count}-file index"
            ));
        }

        let layout = StoreLayout::for_workspace(&root, config);
        let mut update_samples = Vec::new();
        for rel_path in benchmark_update_paths(file_count) {
            let abs_path = root.join(&rel_path);
            let content = fs::read_to_string(&abs_path).map_err(|err| err.to_string())?;
            fs::write(
                &abs_path,
                format!(
                    "{content}\nUPDATED_MARKER = \"{}\"\n",
                    rel_path.replace('/', "_")
                ),
            )
            .map_err(|err| err.to_string())?;
            let current_generation = load_overlay_with_recovery(&layout)
                .map_err(|err| err.to_string())?
                .manifest
                .generation;
            let batch = build_change_batch(current_generation, &[rel_path.clone()], &[], &[]);
            let start = Instant::now();
            apply_change_batch(&root, &layout, config, &batch).map_err(|err| err.to_string())?;
            update_samples.push(elapsed_ms(start.elapsed()));
        }

        let mut query_samples = Vec::new();
        for query in benchmark_query_samples(file_count) {
            let start = Instant::now();
            let _ = search_workspace(
                &SearchRequest {
                    workspace_root: root.to_string_lossy().into_owned(),
                    query,
                    query_terms: Vec::new(),
                    case_sensitive: true,
                    whole_word: false,
                    use_regex: false,
                    regex_multiline: true,
                    include: vec![],
                    exclude: vec![],
                    path_regex: None,
                    limit: 32,
                    offset: 0,
                },
                config,
            )?;
            query_samples.push(elapsed_ms(start.elapsed()));
        }

        let after = current_runtime_stats();
        cases.push(BenchmarkCase {
            label: format!("synthetic-{}k", file_count / 1_000),
            file_count,
            index_ms,
            reuse_ms,
            update_p50_ms: percentile_ms(&update_samples, 50.0),
            update_p95_ms: percentile_ms(&update_samples, 95.0),
            query_p50_ms: percentile_ms(&query_samples, 50.0),
            query_p95_ms: percentile_ms(&query_samples, 95.0),
            process: process_delta(&before, &after),
        });

        if let Err(err) = fs::remove_dir_all(&root) {
            warnings.push(format!(
                "failed to remove benchmark workspace {}: {}",
                root.to_string_lossy(),
                err
            ));
        }
    }

    Ok(BenchmarkResponse {
        ok: true,
        engine: EngineInfo::current(),
        warnings,
        cases,
    })
}

fn candidate_doc_ids(reader: &ShardReader, plan: &QueryPlan) -> io::Result<BTreeSet<u32>> {
    let docs = reader.documents()?;
    if plan.terms.is_empty() || plan.terms.iter().any(|term| term.required_grams.is_empty()) {
        return Ok(docs
            .into_iter()
            .map(|doc| doc.doc_id)
            .collect::<BTreeSet<_>>());
    }

    let incomplete_ids: BTreeSet<u32> = docs
        .iter()
        .filter(|doc| doc.gram_incomplete)
        .map(|doc| doc.doc_id)
        .collect();
    let mut selected_ids = BTreeSet::new();
    for term in &plan.terms {
        let mut term_ids: Option<BTreeSet<u32>> = None;
        for gram in &term.required_grams {
            let posting = reader.find_posting(gram)?;
            let ids = posting
                .map(|posting| posting.doc_ids.into_iter().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            term_ids = Some(match term_ids {
                Some(existing) => existing.intersection(&ids).copied().collect(),
                None => ids,
            });
            if term_ids.as_ref().is_some_and(BTreeSet::is_empty) {
                break;
            }
        }
        selected_ids.extend(term_ids.unwrap_or_default());
    }
    selected_ids.extend(incomplete_ids);
    Ok(selected_ids)
}

fn docs_for_ids<'a>(docs: &'a [ShardDocument], ids: &BTreeSet<u32>) -> Vec<&'a ShardDocument> {
    if ids.is_empty() {
        return Vec::new();
    }
    ids.iter()
        .filter_map(|doc_id| docs.get(*doc_id as usize))
        .collect()
}

fn overlay_matches_plan(entry: &crate::overlay::OverlayEntry, plan: &QueryPlan) -> bool {
    if plan.terms.is_empty() || plan.terms.iter().any(|term| term.required_grams.is_empty()) {
        return true;
    }
    if entry.gram_incomplete {
        return true;
    }
    let grams = entry
        .grams
        .iter()
        .map(|value| {
            value
                .chars()
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .collect::<BTreeSet<_>>();
    plan.terms
        .iter()
        .any(|term| term.required_grams.iter().all(|gram| grams.contains(gram)))
}

fn benchmark_temp_dir(file_count: usize) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "zoek-rs-bench-{}-{}-{}",
        file_count,
        std::process::id(),
        nonce
    ))
}

fn create_benchmark_workspace(root: &Path, file_count: usize) -> io::Result<()> {
    for i in 0..file_count {
        let app_dir = root.join(format!("app{}", i / 250));
        fs::create_dir_all(&app_dir)?;
        let path = app_dir.join(format!("model_{i}.py"));
        fs::write(
            path,
            format!(
                "class BenchModel{i}:\n    marker = \"BenchNeedle_{i:06}\"\n    common = \"CommonBenchToken\"\n    def render(self):\n        return \"Render_{i:06}\"\n"
            ),
        )?;
    }
    Ok(())
}

fn benchmark_update_paths(file_count: usize) -> Vec<String> {
    let sample_count = file_count.min(7);
    if sample_count == 0 {
        return Vec::new();
    }
    let stride = (file_count / sample_count.max(1)).max(1);
    (0..sample_count)
        .map(|idx| idx * stride)
        .map(|value| value.min(file_count.saturating_sub(1)))
        .map(|i| format!("app{}/model_{i}.py", i / 250))
        .collect()
}

fn benchmark_query_samples(file_count: usize) -> Vec<String> {
    let sample_count = file_count.min(12);
    if sample_count == 0 {
        return Vec::new();
    }
    let stride = (file_count / sample_count.max(1)).max(1);
    (0..sample_count)
        .map(|idx| idx * stride)
        .map(|value| value.min(file_count.saturating_sub(1)))
        .map(|i| format!("BenchNeedle_{i:06}"))
        .collect()
}

fn percentile_ms(samples: &[u64], percentile: f64) -> u64 {
    if samples.is_empty() {
        return 0;
    }
    let mut values = samples.to_vec();
    values.sort_unstable();
    let rank = ((percentile / 100.0) * (values.len().saturating_sub(1) as f64)).ceil() as usize;
    values[rank.min(values.len() - 1)]
}

fn elapsed_ms(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn process_delta(before: &RuntimeStats, after: &RuntimeStats) -> RuntimeStats {
    RuntimeStats {
        peak_rss_bytes: after.peak_rss_bytes.max(before.peak_rss_bytes),
        minor_page_faults: after
            .minor_page_faults
            .saturating_sub(before.minor_page_faults),
        major_page_faults: after
            .major_page_faults
            .saturating_sub(before.major_page_faults),
    }
}

pub fn current_runtime_stats() -> RuntimeStats {
    #[cfg(unix)]
    {
        use std::mem::MaybeUninit;
        use std::os::raw::{c_int, c_long};

        #[repr(C)]
        struct TimeVal {
            tv_sec: c_long,
            tv_usec: c_long,
        }

        #[repr(C)]
        struct RUsage {
            ru_utime: TimeVal,
            ru_stime: TimeVal,
            ru_maxrss: c_long,
            ru_ixrss: c_long,
            ru_idrss: c_long,
            ru_isrss: c_long,
            ru_minflt: c_long,
            ru_majflt: c_long,
            ru_nswap: c_long,
            ru_inblock: c_long,
            ru_oublock: c_long,
            ru_msgsnd: c_long,
            ru_msgrcv: c_long,
            ru_nsignals: c_long,
            ru_nvcsw: c_long,
            ru_nivcsw: c_long,
        }

        unsafe extern "C" {
            fn getrusage(who: c_int, usage: *mut RUsage) -> c_int;
        }

        const RUSAGE_SELF: c_int = 0;
        let mut usage = MaybeUninit::<RUsage>::uninit();
        let rc = unsafe { getrusage(RUSAGE_SELF, usage.as_mut_ptr()) };
        if rc != 0 {
            return RuntimeStats::default();
        }
        let usage = unsafe { usage.assume_init() };
        let peak_rss_bytes = rss_to_bytes(usage.ru_maxrss);
        return RuntimeStats {
            peak_rss_bytes,
            minor_page_faults: usage.ru_minflt.max(0) as u64,
            major_page_faults: usage.ru_majflt.max(0) as u64,
        };
    }

    #[cfg(not(unix))]
    {
        RuntimeStats::default()
    }
}

#[cfg(unix)]
fn rss_to_bytes(raw: std::os::raw::c_long) -> u64 {
    if raw <= 0 {
        return 0;
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        (raw as u64) * 1024
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        raw as u64
    }
}

#[cfg(test)]
mod tests {
    use super::{benchmark_workspaces, collect_info, current_runtime_stats, diagnose_query};
    use crate::config::EngineConfig;
    use crate::indexer::index_directory;
    use crate::protocol::SearchRequest;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn collect_info_reports_shards_and_overlay() -> io::Result<()> {
        let root = temp_dir("ops-info");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let info = collect_info(&root, &EngineConfig::default())?;
        assert!(info.ok);
        assert!(info.total_document_count >= 1);
        assert!(!info.shards.is_empty());

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn diagnose_query_returns_candidate_sample() -> io::Result<()> {
        let root = temp_dir("ops-diagnose");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = diagnose_query(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec![],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert!(response.final_candidate_count >= 1);
        assert_eq!(response.candidate_sample[0], "src/a.rs");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn info_and_diagnose_reject_a_mixed_base_generation() -> io::Result<()> {
        let root = temp_dir("ops-mixed-generation");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct SharedMarker {}\n")?;
        fs::write(root.join("src/b.rs"), "struct OtherRecord {}\n")?;
        let mut config = EngineConfig::default();
        config.max_files_per_shard = 1;
        let artifacts = index_directory(&root, &config)?;
        assert_eq!(artifacts.shards.len(), 2);

        let mixed_path = &artifacts.shards[1].path;
        let mut bytes = fs::read(mixed_path)?;
        let build_id = u64::from_le_bytes(bytes[80..88].try_into().unwrap());
        bytes[80..88].copy_from_slice(&build_id.saturating_add(1).to_le_bytes());
        fs::write(mixed_path, bytes)?;

        let info = collect_info(&root, &config)?;
        assert_eq!(info.total_document_count, 0);
        assert!(info.shards.iter().all(|shard| !shard.valid));
        assert!(info
            .warnings
            .iter()
            .any(|warning| warning.contains("base index validation failed")));

        let diagnosis = diagnose_query(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "SharedMarker".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec![],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &config,
        )
        .map_err(io::Error::other)?;
        assert_eq!(diagnosis.base_document_count, 0);
        assert!(diagnosis
            .fallback_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("base index validation failed")));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn benchmark_runs_small_synthetic_workspace() -> io::Result<()> {
        let response =
            benchmark_workspaces(&[20], &EngineConfig::default()).map_err(io::Error::other)?;
        assert!(response.ok);
        assert_eq!(response.cases.len(), 1);
        assert_eq!(response.cases[0].file_count, 20);
        assert!(response.to_json().contains("\"reuseMs\":"));
        Ok(())
    }

    #[test]
    fn runtime_stats_sample_is_available() {
        let stats = current_runtime_stats();
        assert!(stats.peak_rss_bytes <= u64::MAX);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
