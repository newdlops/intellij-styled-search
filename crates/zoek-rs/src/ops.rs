use crate::config::EngineConfig;
use crate::indexer::index_directory;
use crate::mmap_store::StoreLayout;
use crate::overlay::{apply_change_batch, compaction_reason, load_overlay_with_recovery};
use crate::planner::{build_query_plan, QueryPlan};
use crate::protocol::{
    BenchmarkCase, BenchmarkResponse, DiagnoseResponse, EngineInfo, GramDiagnostic, InfoResponse, RuntimeStats,
    SearchRequest, ShardDiagnostic,
};
use crate::searcher::search_workspace;
use crate::shard::{ShardDocument, ShardReader};
use crate::verifier::matches_include_filters;
use crate::watcher::build_change_batch;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub fn collect_info(workspace_root: &Path, config: &EngineConfig) -> io::Result<InfoResponse> {
    let layout = StoreLayout::for_workspace(workspace_root, config);
    layout.ensure_dirs()?;
    let cleaned_temp_files = layout.cleanup_stale_temp_files(30)?;
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
    for shard_path in layout.list_shard_paths()? {
        let file_name = shard_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| shard_path.to_string_lossy().into_owned());
        let file_bytes = fs::metadata(&shard_path).map(|metadata| metadata.len()).unwrap_or(0);
        match ShardReader::open(&shard_path) {
            Ok(reader) => {
                let docs = reader.documents()?;
                let header = reader.header();
                let source_bytes = docs.iter().map(|doc| doc.byte_len).sum::<u64>();
                total_document_count += docs.len();
                total_gram_count += header.gram_count;
                total_shard_bytes += file_bytes;
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
            Err(err) => {
                warnings.push(format!("skipped unreadable shard {}: {}", file_name, err));
                shards.push(ShardDiagnostic {
                    file_name,
                    shard_id: 0,
                    doc_count: 0,
                    gram_count: 0,
                    source_bytes: 0,
                    file_bytes,
                    created_unix_secs: 0,
                    valid: false,
                });
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

pub fn diagnose_query(request: &SearchRequest, config: &EngineConfig) -> Result<DiagnoseResponse, String> {
    let workspace_root = Path::new(&request.workspace_root);
    let layout = StoreLayout::for_workspace(workspace_root, config);
    layout.ensure_dirs().map_err(|err| err.to_string())?;
    let plan = build_query_plan(request);
    let cleaned_temp_files = layout
        .cleanup_stale_temp_files(30)
        .map_err(|err| err.to_string())?;

    let overlay = load_overlay_with_recovery(&layout).map_err(|err| err.to_string())?;
    let latest_overlay = overlay.manifest.latest_entries();
    let overlay_live_entries = latest_overlay.values().filter(|entry| !entry.tombstone).count();
    let mut warnings = overlay.warnings;
    if !cleaned_temp_files.is_empty() {
        warnings.push(format!(
            "removed stale temp index files: {}",
            cleaned_temp_files.join(", ")
        ));
    }

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

    let shard_paths = layout.list_shard_paths().map_err(|err| err.to_string())?;
    if shard_paths.is_empty() {
        fallback_reason = Some("no base shards found; a full scan would be required".to_string());
    } else {
        for shard_path in shard_paths {
            let reader = match ShardReader::open(&shard_path) {
                Ok(reader) => reader,
                Err(err) => {
                    warnings.push(format!(
                        "skipped unreadable shard {}: {}",
                        shard_path.to_string_lossy(),
                        err
                    ));
                    continue;
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
            let selected_ids = candidate_doc_ids(&reader, &plan).map_err(|err| err.to_string())?;
            let selected_docs = docs_for_ids(&docs, &selected_ids);
            base_candidate_count += selected_docs.len();
            for doc in selected_docs {
                if latest_overlay.contains_key(&doc.rel_path) {
                    continue;
                }
                if !matches_include_filters(&doc.rel_path, &plan.include) {
                    continue;
                }
                final_candidates.insert(doc.rel_path.clone());
            }
        }
    }

    for overlay_entry in latest_overlay.values() {
        if overlay_entry.tombstone {
            final_candidates.remove(&overlay_entry.rel_path);
            continue;
        }
        if !matches_include_filters(&overlay_entry.rel_path, &plan.include) {
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

pub fn benchmark_workspaces(file_counts: &[usize], config: &EngineConfig) -> Result<BenchmarkResponse, String> {
    let mut warnings = Vec::new();
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

        let layout = StoreLayout::for_workspace(&root, config);
        let mut update_samples = Vec::new();
        for rel_path in benchmark_update_paths(file_count) {
            let abs_path = root.join(&rel_path);
            let content = fs::read_to_string(&abs_path).map_err(|err| err.to_string())?;
            fs::write(&abs_path, format!("{content}\nUPDATED_MARKER = \"{}\"\n", rel_path.replace('/', "_")))
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
                    case_sensitive: true,
                    whole_word: false,
                    use_regex: false,
                    regex_multiline: true,
                    include: vec![],
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
    if plan.required_grams.is_empty() {
        return Ok(reader
            .documents()?
            .into_iter()
            .map(|doc| doc.doc_id)
            .collect::<BTreeSet<_>>());
    }

    let mut acc: Option<BTreeSet<u32>> = None;
    for gram in &plan.required_grams {
        let posting = reader.find_posting(gram)?;
        let ids = posting
            .map(|posting| posting.doc_ids.into_iter().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        acc = Some(match acc {
            Some(existing) => existing.intersection(&ids).copied().collect(),
            None => ids,
        });
        if acc.as_ref().is_some_and(BTreeSet::is_empty) {
            break;
        }
    }
    Ok(acc.unwrap_or_default())
}

fn docs_for_ids<'a>(docs: &'a [ShardDocument], ids: &BTreeSet<u32>) -> Vec<&'a ShardDocument> {
    if ids.is_empty() {
        return Vec::new();
    }
    ids.iter().filter_map(|doc_id| docs.get(*doc_id as usize)).collect()
}

fn overlay_matches_plan(entry: &crate::overlay::OverlayEntry, plan: &QueryPlan) -> bool {
    if plan.required_grams.is_empty() {
        return true;
    }
    let grams = entry
        .grams
        .iter()
        .map(|value| value.chars().flat_map(char::to_lowercase).collect::<String>())
        .collect::<BTreeSet<_>>();
    plan.required_grams.iter().all(|gram| grams.contains(gram))
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
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec![],
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
    fn benchmark_runs_small_synthetic_workspace() -> io::Result<()> {
        let response = benchmark_workspaces(&[20], &EngineConfig::default()).map_err(io::Error::other)?;
        assert!(response.ok);
        assert_eq!(response.cases.len(), 1);
        assert_eq!(response.cases[0].file_count, 20);
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
