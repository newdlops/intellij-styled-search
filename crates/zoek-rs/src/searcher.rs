use crate::config::EngineConfig;
use crate::corpus::discover_text_files;
use crate::mmap_store::StoreLayout;
use crate::overlay::load_overlay_with_recovery;
use crate::planner::{build_query_plan, QueryMode};
use crate::protocol::{SearchRequest, SearchResponse};
use crate::scorer::score_file;
use crate::shard::{ShardDocument, ShardReader};
use crate::verifier::{
    build_file_result, load_current_text, matches_include_filters, verify_literal, verify_regex,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
struct CandidateDocument {
    rel_path: String,
    absolute_path: PathBuf,
}

pub fn search_workspace(
    request: &SearchRequest,
    config: &EngineConfig,
) -> Result<SearchResponse, String> {
    let plan = build_query_plan(request);
    let workspace_root = Path::new(&request.workspace_root);
    let layout = StoreLayout::for_workspace(workspace_root, config);
    let mut warnings = Vec::new();
    match layout.cleanup_stale_temp_files(30) {
        Ok(removed) if !removed.is_empty() => {
            warnings.push(format!(
                "removed stale temp index files: {}",
                removed.join(", ")
            ));
        }
        Ok(_) => {}
        Err(err) => warnings.push(format!("temp-file cleanup failed: {err}")),
    }

    let candidates = match collect_index_candidates(workspace_root, &layout, &plan, config, &mut warnings) {
        Ok(Some(candidates)) => candidates,
        Ok(None) => fallback_candidates(workspace_root, request, &mut warnings).map_err(|err| err.to_string())?,
        Err(err) => {
            warnings.push(format!("index query fallback: {err}"));
            fallback_candidates(workspace_root, request, &mut warnings).map_err(|fallback| fallback.to_string())?
        }
    };

    let mut verified_files = Vec::new();
    let mut total_files_scanned = 0usize;
    let mut total_matches = 0usize;
    let target_matches = request
        .offset
        .saturating_add(request.limit.max(1))
        .saturating_add(1);
    let mut stopped_early = false;

    for candidate in candidates.values() {
        if total_matches >= target_matches {
            stopped_early = true;
            break;
        }
        total_files_scanned += 1;
        let Some(current) = load_current_text(&candidate.absolute_path, config).map_err(|err| err.to_string())? else {
            continue;
        };
        let remaining_match_budget = target_matches.saturating_sub(total_matches).max(1);
        let matches = match plan.mode {
            QueryMode::Literal => verify_literal(
                &current.text,
                &request.query,
                request.case_sensitive,
                request.whole_word,
                remaining_match_budget,
            ),
            QueryMode::Regex => verify_regex(
                &current.text,
                &plan.effective_query,
                request.case_sensitive,
                remaining_match_budget,
            )
            .map_err(|err| err.to_string())?,
        };
        if matches.is_empty() {
            continue;
        }
        total_matches += matches.len();
        let score = score_file(&candidate.rel_path, &matches);
        verified_files.push(build_file_result(
            candidate.rel_path.clone(),
            current.byte_len,
            current.modified_unix_secs,
            score,
            matches,
        ));
    }

    verified_files.sort_by(|left, right| right.score.cmp(&left.score).then_with(|| left.rel_path.cmp(&right.rel_path)));
    let total_files_matched = verified_files.len();
    let files = page_files_by_match_offset(&verified_files, request.offset, request.limit);
    let paged_matches = files.iter().map(|file| file.matches.len()).sum::<usize>();
    let truncated = stopped_early || request.offset.saturating_add(paged_matches) < total_matches;

    Ok(SearchResponse {
        ok: true,
        engine: crate::protocol::EngineInfo::current(),
        query_mode: if request.use_regex { "regex".to_string() } else { "literal".to_string() },
        total_files_scanned,
        total_files_matched,
        total_matches,
        truncated,
        warnings,
        files,
    })
}

fn page_files_by_match_offset(
    files: &[crate::protocol::SearchFileResult],
    offset: usize,
    limit: usize,
) -> Vec<crate::protocol::SearchFileResult> {
    if limit == 0 {
        return Vec::new();
    }

    let mut remaining_offset = offset;
    let mut remaining_limit = limit;
    let mut paged = Vec::new();

    for file in files {
        if remaining_limit == 0 {
            break;
        }
        if remaining_offset >= file.matches.len() {
            remaining_offset -= file.matches.len();
            continue;
        }

        let start = remaining_offset;
        let take = (file.matches.len() - start).min(remaining_limit);
        paged.push(crate::protocol::SearchFileResult {
            rel_path: file.rel_path.clone(),
            byte_len: file.byte_len,
            modified_unix_secs: file.modified_unix_secs,
            score: file.score,
            matches: file.matches[start..start + take].to_vec(),
        });
        remaining_limit -= take;
        remaining_offset = 0;
    }

    paged
}

fn collect_index_candidates(
    workspace_root: &Path,
    layout: &StoreLayout,
    plan: &crate::planner::QueryPlan,
    config: &EngineConfig,
    warnings: &mut Vec<String>,
) -> Result<Option<BTreeMap<String, CandidateDocument>>, String> {
    let shard_paths = layout.list_shard_paths().map_err(|err| err.to_string())?;
    if shard_paths.is_empty() {
        warnings.push("no base shards found; falling back to full scan".to_string());
        return Ok(None);
    }

    let overlay = match load_overlay_with_recovery(layout) {
        Ok(result) => {
            warnings.extend(result.warnings);
            result.manifest
        }
        Err(err) => {
            warnings.push(format!("overlay load failed: {err}"));
            crate::overlay::OverlayManifest::empty()
        }
    };
    let latest_overlay = overlay.latest_entries();

    let mut candidates = BTreeMap::new();
    for shard_path in shard_paths {
        let reader = ShardReader::open(&shard_path).map_err(|err| err.to_string())?;
        let docs = reader.documents().map_err(|err| err.to_string())?;
        let selected_ids = candidate_doc_ids(&reader, plan).map_err(|err| err.to_string())?;
        for doc in docs_for_ids(&docs, &selected_ids) {
            if latest_overlay.contains_key(&doc.rel_path) {
                continue;
            }
            if !matches_include_filters(&doc.rel_path, &plan.include) {
                continue;
            }
            candidates.insert(
                doc.rel_path.clone(),
                CandidateDocument {
                    rel_path: doc.rel_path.clone(),
                    absolute_path: workspace_root.join(&doc.rel_path),
                },
            );
        }
    }

    for overlay_entry in latest_overlay.values() {
        candidates.remove(&overlay_entry.rel_path);
        if overlay_entry.tombstone {
            continue;
        }
        if !matches_include_filters(&overlay_entry.rel_path, &plan.include) {
            continue;
        }
        if !overlay_matches_plan(overlay_entry, plan, config) {
            continue;
        }
        candidates.insert(
            overlay_entry.rel_path.clone(),
            CandidateDocument {
                rel_path: overlay_entry.rel_path.clone(),
                absolute_path: workspace_root.join(&overlay_entry.rel_path),
            },
        );
    }

    Ok(Some(candidates))
}

fn candidate_doc_ids(
    reader: &ShardReader,
    plan: &crate::planner::QueryPlan,
) -> Result<BTreeSet<u32>, std::io::Error> {
    let docs = reader.documents()?;
    if plan.required_grams.is_empty() {
        return Ok(docs.into_iter().map(|doc| doc.doc_id).collect::<BTreeSet<_>>());
    }

    // Any doc whose posting set was truncated at index time (indexer's
    // max_grams_per_file cap) must be included unconditionally — the
    // gram AND-intersection below would otherwise drop real-match files
    // whose dropped gram happened to coincide with one of the required
    // grams. The verifier re-scans content so including more candidates
    // costs I/O but never correctness.
    let incomplete_ids: BTreeSet<u32> = docs
        .iter()
        .filter(|doc| doc.gram_incomplete)
        .map(|doc| doc.doc_id)
        .collect();

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
    let mut acc = acc.unwrap_or_default();
    acc.extend(incomplete_ids);
    Ok(acc)
}

fn docs_for_ids<'a>(docs: &'a [ShardDocument], ids: &BTreeSet<u32>) -> Vec<&'a ShardDocument> {
    if ids.is_empty() {
        return Vec::new();
    }
    ids.iter()
        .filter_map(|doc_id| docs.get(*doc_id as usize))
        .collect()
}

fn overlay_matches_plan(
    entry: &crate::overlay::OverlayEntry,
    plan: &crate::planner::QueryPlan,
    config: &EngineConfig,
) -> bool {
    if plan.required_grams.is_empty() {
        return true;
    }
    // Mirror the shard-side incomplete handling: if the indexer truncated
    // this overlay entry's grams, force it into the candidate set.
    if entry.gram_incomplete {
        return true;
    }
    let grams = entry
        .grams
        .iter()
        .map(|value| value.chars().flat_map(char::to_lowercase).collect::<String>())
        .collect::<BTreeSet<_>>();
    let _ = config;
    plan.required_grams.iter().all(|gram| grams.contains(gram))
}

fn fallback_candidates(
    workspace_root: &Path,
    request: &SearchRequest,
    warnings: &mut Vec<String>,
) -> std::io::Result<BTreeMap<String, CandidateDocument>> {
    let (entries, _) = discover_text_files(workspace_root, &EngineConfig::default())?;
    warnings.push("search fallback scanned the current text corpus".to_string());
    Ok(entries
        .into_iter()
        .filter(|entry| matches_include_filters(&entry.rel_path, &request.include))
        .map(|entry| {
            (
                entry.rel_path.clone(),
                CandidateDocument {
                    rel_path: entry.rel_path,
                    absolute_path: entry.abs_path,
                },
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::search_workspace;
    use crate::config::EngineConfig;
    use crate::indexer::index_directory;
    use crate::mmap_store::StoreLayout;
    use crate::overlay::{apply_change_batch, OverlayEntry, OverlayManifest};
    use crate::protocol::SearchRequest;
    use crate::watcher::build_change_batch;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn search_workspace_uses_shards_for_literal_queries() -> io::Result<()> {
        let root = temp_dir("searcher");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        fs::write(root.join("src/b.rs"), "struct BetaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec!["src/*".to_string()],
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/a.rs");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn search_workspace_uses_shards_for_multiline_literal_queries() -> io::Result<()> {
        let root = temp_dir("multiline-searcher");
        fs::create_dir_all(root.join("src"))?;
        fs::write(
            root.join("src/a.tsx"),
            "export const RightToConsentOrConsultInvestorsSelectTable = ({\n  name,\n  investorCandidates,\n  isShowInvestors,\n  onCheck,\n});\n",
        )?;
        fs::write(
            root.join("src/b.tsx"),
            "export const AnotherTable = ({\n  name,\n  candidates,\n});\n",
        )?;
        for idx in 0..32 {
            fs::write(
                root.join("src").join(format!("noise-{idx}.ts")),
                format!("export const Noise{idx} = {{ name: 'value' }};\n"),
            )?;
        }
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "export const RightToConsentOrConsultInvestorsSelectTable = ({\n  name,\n  investorCandidates,\n  isShowInvestors,\n  onCheck".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec!["src/*".to_string()],
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/a.tsx");
        assert!(
            response.total_files_scanned < 10,
            "expected multiline literal planning to avoid scanning the whole workspace; scanned {} files",
            response.total_files_scanned,
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn overlay_tombstone_shadows_base_document() -> io::Result<()> {
        let root = temp_dir("overlay-shadow");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;
        let overlay = OverlayManifest {
            generation: 2,
            updated_unix_secs: 2,
            entries: vec![OverlayEntry {
                rel_path: "src/a.rs".to_string(),
                generation: 2,
                tombstone: true,
                modified_unix_secs: 2,
                content_hash: 0,
                grams: vec![],
                gram_incomplete: false,
            }],
        };
        fs::write(root.join(".zoek-rs/hot-overlay.json"), overlay.to_json())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec![],
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 0);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn regex_search_verifies_current_file_content() -> io::Result<()> {
        let root = temp_dir("regex");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "foo\nbar\nbaz\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "foo.*baz".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: true,
                include: vec![],
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].matches[0].end_line, Some(2));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn modify_update_shadows_base_snapshot_immediately() -> io::Result<()> {
        let root = temp_dir("modify-shadow");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;

        fs::write(root.join("src/a.rs"), "struct BetaService {}\n")?;
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/a.rs")], &[], &[]);
        apply_change_batch(&root, &layout, &config, &batch)?;

        let alpha = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec![],
                limit: 10,
                offset: 0,
            },
            &config,
        )
        .map_err(io::Error::other)?;
        let beta = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "BetaService".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec![],
                limit: 10,
                offset: 0,
            },
            &config,
        )
        .map_err(io::Error::other)?;
        assert_eq!(alpha.total_files_matched, 0);
        assert_eq!(beta.total_files_matched, 1);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn create_update_makes_new_file_searchable_without_rebuild() -> io::Result<()> {
        let root = temp_dir("create-update");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;

        fs::write(root.join("src/new.rs"), "struct GammaService {}\n")?;
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/new.rs")], &[], &[]);
        apply_change_batch(&root, &layout, &config, &batch)?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "GammaService".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec![],
                limit: 10,
                offset: 0,
            },
            &config,
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/new.rs");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn paginates_match_lines_across_files() -> io::Result<()> {
        let root = temp_dir("match-pagination");
        fs::create_dir_all(root.join("src"))?;
        fs::write(
            root.join("src/a.rs"),
            "needle\nneedle\nneedle\nneedle\nneedle\n",
        )?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "needle".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec![],
                limit: 2,
                offset: 2,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;

        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.total_matches, 5);
        assert!(response.truncated);
        assert_eq!(response.files.len(), 1);
        assert_eq!(response.files[0].matches.len(), 2);
        assert_eq!(response.files[0].matches[0].line, 2);
        assert_eq!(response.files[0].matches[1].line, 3);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn broad_literal_queries_stop_after_filling_the_requested_page() -> io::Result<()> {
        let root = temp_dir("broad-literal");
        fs::create_dir_all(root.join("src"))?;
        for idx in 0..64 {
            fs::write(
                root.join("src").join(format!("f{idx:02}.ts")),
                "class Alpha {}\nclass Beta {}\nclass Gamma {}\nclass Delta {}\n",
            )?;
        }
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "class".to_string(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                include: vec!["src/*".to_string()],
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;

        assert!(response.truncated);
        assert_eq!(response.files.len(), 3);
        assert_eq!(response.total_matches, 11);
        assert!(
            response.total_files_scanned < 10,
            "expected broad literal query to stop early; scanned {} files",
            response.total_files_scanned,
        );

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
