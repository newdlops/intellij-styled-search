use crate::config::EngineConfig;
use crate::corpus::discover_text_files;
use crate::mmap_store::StoreLayout;
use crate::overlay::load_overlay_with_recovery;
use crate::planner::{build_query_plan, QueryMode, QueryTermPlan};
use crate::protocol::{SearchFileResult, SearchMatch, SearchRequest, SearchResponse};
use crate::scorer::score_file;
use crate::shard::{ShardDocument, ShardReader};
use crate::verifier::{
    build_file_result, load_current_text, matches_path_filters, verify_literal, verify_regex,
};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

#[derive(Clone, Debug)]
struct CandidateDocument {
    rel_path: String,
    absolute_path: PathBuf,
    rank: u16,
    order: usize,
}

const COMPLETE_CANDIDATE_RANK_BONUS: u16 = 1_000;
const INCOMPLETE_GRAM_BACKFILL_LIMIT: usize = 1;
const INCOMPLETE_GRAM_BACKFILL_DOC_LIMIT: usize = 128;
const LONG_LITERAL_INCOMPLETE_BACKFILL_CHARS: usize = 512;
const PARALLEL_VERIFY_THRESHOLD: usize = 128;

pub fn search_workspace(
    request: &SearchRequest,
    config: &EngineConfig,
) -> Result<SearchResponse, String> {
    search_workspace_inner(request, config, false, |_| Ok(()))
}

pub fn search_workspace_streaming<F>(
    request: &SearchRequest,
    config: &EngineConfig,
    on_file: F,
) -> Result<SearchResponse, String>
where
    F: FnMut(&SearchFileResult) -> Result<(), String>,
{
    search_workspace_inner(request, config, true, on_file)
}

fn search_workspace_inner<F>(
    request: &SearchRequest,
    config: &EngineConfig,
    stream_files: bool,
    mut on_file: F,
) -> Result<SearchResponse, String>
where
    F: FnMut(&SearchFileResult) -> Result<(), String>,
{
    let plan = build_query_plan(request);
    let path_regex = plan
        .path_regex
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(|err| format!("invalid path regex: {err}"))?;
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

    let candidates =
        match collect_index_candidates(workspace_root, &layout, &plan, config, &mut warnings) {
            Ok(Some(candidates)) => candidates,
            Ok(None) => fallback_candidates(workspace_root, request, &mut warnings)
                .map_err(|err| err.to_string())?,
            Err(err) => {
                warnings.push(format!("index query fallback: {err}"));
                fallback_candidates(workspace_root, request, &mut warnings)
                    .map_err(|fallback| fallback.to_string())?
            }
        };

    let mut verified_files = Vec::new();
    let mut total_files_scanned = 0usize;
    let mut total_matches = 0usize;
    let mut matched_terms = vec![false; plan.terms.len()];
    let target_matches = request
        .offset
        .saturating_add(request.limit.max(1))
        .saturating_add(1);
    let mut stopped_early = false;

    let mut ordered_candidates = candidates.values().collect::<Vec<_>>();
    ordered_candidates.sort_by(|left, right| {
        right
            .rank
            .cmp(&left.rank)
            .then_with(|| left.order.cmp(&right.order))
            .then_with(|| left.rel_path.cmp(&right.rel_path))
    });

    if !stream_files && ordered_candidates.len() >= PARALLEL_VERIFY_THRESHOLD {
        let (files, scanned, matches, term_coverage) = verify_candidates_parallel(
            &ordered_candidates,
            &plan,
            request,
            config,
            path_regex.clone(),
            target_matches,
        )?;
        total_files_scanned += scanned;
        total_matches += matches;
        merge_term_coverage(&mut matched_terms, &term_coverage);
        verified_files.extend(files);
    } else {
        for candidate in ordered_candidates {
            if let Some(regex) = &path_regex {
                if !regex.is_match(&candidate.rel_path) {
                    continue;
                }
            }
            if total_matches >= target_matches {
                stopped_early = true;
                break;
            }
            total_files_scanned += 1;
            let Some(current) = load_current_text(&candidate.absolute_path, config)
                .map_err(|err| err.to_string())?
            else {
                continue;
            };
            let remaining_match_budget = target_matches.saturating_sub(total_matches).max(1);
            let (matches, term_coverage) = verify_plan_terms_with_coverage(
                &current.text,
                &plan,
                request,
                remaining_match_budget,
            )
            .map_err(|err| err.to_string())?;
            if matches.is_empty() {
                continue;
            }
            merge_term_coverage(&mut matched_terms, &term_coverage);
            let file_match_start = total_matches;
            total_matches += matches.len();
            let score = score_file(&candidate.rel_path, &matches);
            let file_result = build_file_result(
                candidate.rel_path.clone(),
                current.byte_len,
                current.modified_unix_secs,
                score,
                matches,
            );
            if stream_files {
                if let Some(paged_file) = page_file_by_global_match_offset(
                    &file_result,
                    file_match_start,
                    request.offset,
                    request.limit,
                ) {
                    on_file(&paged_file)?;
                }
            }
            verified_files.push(file_result);
        }
    }

    if !candidates.is_empty() && matched_terms.iter().any(|matched| *matched) {
        if let Some(fallback_request) =
            literal_fallback_request_for_missing_terms(request, &plan, &matched_terms)
        {
            let latest_overlay = load_overlay_with_recovery(&layout)
                .map(|result| result.manifest.latest_entries())
                .unwrap_or_default();
            let fallback = fallback_candidates(workspace_root, &fallback_request, &mut warnings)
                .map_err(|err| err.to_string())?;
            for (rel_path, candidate) in fallback {
                if candidates.contains_key(&rel_path) {
                    continue;
                }
                if latest_overlay
                    .get(&rel_path)
                    .map(|entry| entry.tombstone)
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Some(regex) = &path_regex {
                    if !regex.is_match(&candidate.rel_path) {
                        continue;
                    }
                }
                if total_matches >= target_matches {
                    stopped_early = true;
                    break;
                }
                total_files_scanned += 1;
                let Some(current) = load_current_text(&candidate.absolute_path, config)
                    .map_err(|err| err.to_string())?
                else {
                    continue;
                };
                let remaining_match_budget = target_matches.saturating_sub(total_matches).max(1);
                let (matches, term_coverage) = verify_plan_terms_with_coverage(
                    &current.text,
                    &plan,
                    request,
                    remaining_match_budget,
                )
                .map_err(|err| err.to_string())?;
                if matches.is_empty() {
                    continue;
                }
                merge_term_coverage(&mut matched_terms, &term_coverage);
                let file_match_start = total_matches;
                total_matches += matches.len();
                let score = score_file(&candidate.rel_path, &matches);
                let file_result = build_file_result(
                    candidate.rel_path.clone(),
                    current.byte_len,
                    current.modified_unix_secs,
                    score,
                    matches,
                );
                if stream_files {
                    if let Some(paged_file) = page_file_by_global_match_offset(
                        &file_result,
                        file_match_start,
                        request.offset,
                        request.limit,
                    ) {
                        on_file(&paged_file)?;
                    }
                }
                verified_files.push(file_result);
            }
        }
    }

    let total_files_matched = verified_files.len();
    let files = page_files_by_match_offset(&verified_files, request.offset, request.limit);
    let paged_matches = files.iter().map(|file| file.matches.len()).sum::<usize>();
    let truncated = stopped_early || request.offset.saturating_add(paged_matches) < total_matches;

    Ok(SearchResponse {
        ok: true,
        engine: crate::protocol::EngineInfo::current(),
        query_mode: if request.use_regex {
            "regex".to_string()
        } else {
            "literal".to_string()
        },
        total_files_scanned,
        total_files_matched,
        total_matches,
        truncated,
        warnings,
        files,
    })
}

fn page_file_by_global_match_offset(
    file: &SearchFileResult,
    file_match_start: usize,
    offset: usize,
    limit: usize,
) -> Option<SearchFileResult> {
    if limit == 0 || file.matches.is_empty() {
        return None;
    }
    let file_match_end = file_match_start.saturating_add(file.matches.len());
    let page_start = offset;
    let page_end = offset.saturating_add(limit);
    if file_match_end <= page_start || file_match_start >= page_end {
        return None;
    }
    let start = page_start.saturating_sub(file_match_start);
    let end = file
        .matches
        .len()
        .min(page_end.saturating_sub(file_match_start));
    if start >= end {
        return None;
    }
    Some(SearchFileResult {
        rel_path: file.rel_path.clone(),
        byte_len: file.byte_len,
        modified_unix_secs: file.modified_unix_secs,
        score: file.score,
        matches: file.matches[start..end].to_vec(),
    })
}

fn page_files_by_match_offset(
    files: &[SearchFileResult],
    offset: usize,
    limit: usize,
) -> Vec<SearchFileResult> {
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
        paged.push(SearchFileResult {
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
    let path_regex = plan
        .path_regex
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(|err| err.to_string())?;

    let mut candidates = BTreeMap::new();
    let mut shard_order_base = 0usize;
    for shard_path in shard_paths {
        let reader = ShardReader::open(&shard_path).map_err(|err| err.to_string())?;
        let docs = reader.documents().map_err(|err| err.to_string())?;
        let selected_ids =
            candidate_doc_ranks(&reader, &docs, plan).map_err(|err| err.to_string())?;
        for (doc, rank) in docs_for_ranked_ids(&docs, &selected_ids) {
            if latest_overlay.contains_key(&doc.rel_path) {
                continue;
            }
            if !matches_path_filters(&doc.rel_path, &plan.include, &plan.exclude) {
                continue;
            }
            if let Some(regex) = &path_regex {
                if !regex.is_match(&doc.rel_path) {
                    continue;
                }
            }
            candidates.insert(
                doc.rel_path.clone(),
                CandidateDocument {
                    rel_path: doc.rel_path.clone(),
                    absolute_path: workspace_root.join(&doc.rel_path),
                    rank,
                    order: shard_order_base.saturating_add(doc.doc_id as usize),
                },
            );
        }
        shard_order_base = shard_order_base.saturating_add(docs.len());
    }

    for overlay_entry in latest_overlay.values() {
        candidates.remove(&overlay_entry.rel_path);
        if overlay_entry.tombstone {
            continue;
        }
        if !matches_path_filters(&overlay_entry.rel_path, &plan.include, &plan.exclude) {
            continue;
        }
        if let Some(regex) = &path_regex {
            if !regex.is_match(&overlay_entry.rel_path) {
                continue;
            }
        }
        if !overlay_matches_plan(overlay_entry, plan, config) {
            continue;
        }
        candidates.insert(
            overlay_entry.rel_path.clone(),
            CandidateDocument {
                rel_path: overlay_entry.rel_path.clone(),
                absolute_path: workspace_root.join(&overlay_entry.rel_path),
                rank: u16::MAX,
                order: 0,
            },
        );
    }

    Ok(Some(candidates))
}

fn candidate_doc_ranks(
    reader: &ShardReader,
    docs: &[ShardDocument],
    plan: &crate::planner::QueryPlan,
) -> Result<BTreeMap<u32, u16>, std::io::Error> {
    if plan.terms.is_empty() || plan.terms.iter().any(|term| term.required_grams.is_empty()) {
        return Ok(docs
            .iter()
            .map(|doc| (doc.doc_id, 0))
            .collect::<BTreeMap<_, _>>());
    }

    let incomplete_ids: BTreeSet<u32> = docs
        .iter()
        .filter(|doc| doc.gram_incomplete)
        .map(|doc| doc.doc_id)
        .collect();

    let mut selected_ids = BTreeMap::<u32, u16>::new();
    for term in &plan.terms {
        let mut term_ids: Option<BTreeSet<u32>> = None;
        let mut incomplete_sets = Vec::new();
        let mut incomplete_hit_counts = BTreeMap::<u32, u16>::new();
        let has_literal_special_gram = term
            .required_grams
            .iter()
            .any(|gram| gram.contains("://") || gram.contains(':'));
        for gram in &term.required_grams {
            let posting = reader.find_posting(gram)?;
            let ids = posting
                .map(|posting| posting.doc_ids.into_iter().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            let allow_incomplete_backfill =
                !has_literal_special_gram || gram.contains("://") || gram.contains(':');
            if allow_incomplete_backfill
                && !incomplete_ids.is_empty()
                && ids.len() <= INCOMPLETE_GRAM_BACKFILL_DOC_LIMIT
            {
                let incomplete_docs = ids
                    .intersection(&incomplete_ids)
                    .copied()
                    .collect::<BTreeSet<_>>();
                if !incomplete_docs.is_empty() {
                    for doc_id in &incomplete_docs {
                        *incomplete_hit_counts.entry(*doc_id).or_default() += 1;
                    }
                    incomplete_sets.push(incomplete_docs);
                }
            }
            term_ids = Some(match term_ids {
                Some(existing) => existing.intersection(&ids).copied().collect(),
                None => ids,
            });
            if term_ids.as_ref().is_some_and(BTreeSet::is_empty) {
                break;
            }
        }
        let complete_rank =
            COMPLETE_CANDIDATE_RANK_BONUS.saturating_add(term.required_grams.len() as u16);
        for doc_id in term_ids.unwrap_or_default() {
            selected_ids
                .entry(doc_id)
                .and_modify(|rank| *rank = (*rank).max(complete_rank))
                .or_insert(complete_rank);
        }
        if should_verify_all_incomplete_docs(plan.mode, term) {
            for doc_id in &incomplete_ids {
                selected_ids.entry(*doc_id).or_insert(0);
            }
            continue;
        }
        if !incomplete_sets.is_empty() {
            incomplete_sets.sort_by_key(BTreeSet::len);
            for docs in incomplete_sets
                .into_iter()
                .take(INCOMPLETE_GRAM_BACKFILL_LIMIT)
            {
                for doc_id in docs {
                    let rank = incomplete_hit_counts.get(&doc_id).copied().unwrap_or(1);
                    selected_ids
                        .entry(doc_id)
                        .and_modify(|existing| *existing = (*existing).max(rank))
                        .or_insert(rank);
                }
            }
        }
    }
    Ok(selected_ids)
}

fn should_verify_all_incomplete_docs(mode: QueryMode, term: &QueryTermPlan) -> bool {
    mode == QueryMode::Literal
        && (term.query.contains('\n') || term.query.len() >= LONG_LITERAL_INCOMPLETE_BACKFILL_CHARS)
}

fn docs_for_ranked_ids<'a>(
    docs: &'a [ShardDocument],
    ids: &BTreeMap<u32, u16>,
) -> Vec<(&'a ShardDocument, u16)> {
    if ids.is_empty() {
        return Vec::new();
    }
    ids.iter()
        .filter_map(|(doc_id, rank)| docs.get(*doc_id as usize).map(|doc| (doc, *rank)))
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
        .map(|value| {
            value
                .chars()
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .collect::<BTreeSet<_>>();
    let _ = config;
    plan.terms.iter().any(|term| {
        term.required_grams.is_empty()
            || term.required_grams.iter().all(|gram| grams.contains(gram))
    })
}

fn verify_plan_terms_with_coverage(
    text: &str,
    plan: &crate::planner::QueryPlan,
    request: &SearchRequest,
    limit: usize,
) -> Result<(Vec<SearchMatch>, Vec<bool>), regex::Error> {
    let mut matches = Vec::new();
    let mut matched_terms = vec![false; plan.terms.len()];
    for (term_idx, term) in plan.terms.iter().enumerate() {
        let term_matches = match plan.mode {
            QueryMode::Literal => verify_literal(
                text,
                &term.query,
                request.case_sensitive,
                request.whole_word,
                limit,
            ),
            QueryMode::Regex => verify_regex(
                text,
                &term.effective_query,
                request.case_sensitive,
                request.regex_multiline,
                limit,
            )?,
        };
        if !term_matches.is_empty() {
            matched_terms[term_idx] = true;
            matches.extend(term_matches);
        }
    }
    matches.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| left.start_column.cmp(&right.start_column))
            .then_with(|| left.end_line.cmp(&right.end_line))
            .then_with(|| left.end_column.cmp(&right.end_column))
    });
    matches.dedup_by(|left, right| {
        left.line == right.line
            && left.start_column == right.start_column
            && left.end_line == right.end_line
            && left.end_column == right.end_column
            && left.preview == right.preview
    });
    if matches.len() > limit {
        matches.truncate(limit);
    }
    Ok((matches, matched_terms))
}

fn merge_term_coverage(target: &mut [bool], source: &[bool]) {
    for (idx, value) in source.iter().enumerate() {
        if *value {
            if let Some(target_value) = target.get_mut(idx) {
                *target_value = true;
            }
        }
    }
}

fn literal_fallback_request_for_missing_terms(
    request: &SearchRequest,
    plan: &crate::planner::QueryPlan,
    matched_terms: &[bool],
) -> Option<SearchRequest> {
    if request.use_regex || plan.mode != QueryMode::Literal || plan.terms.is_empty() {
        return None;
    }
    let missing_terms = plan
        .terms
        .iter()
        .enumerate()
        .filter_map(|(idx, term)| {
            if matched_terms.get(idx).copied().unwrap_or(false) {
                None
            } else {
                Some(term.query.clone())
            }
        })
        .collect::<Vec<_>>();
    if missing_terms.is_empty() {
        return None;
    }
    let mut fallback_request = request.clone();
    fallback_request.query = missing_terms[0].clone();
    fallback_request.query_terms = missing_terms[1..].to_vec();
    Some(fallback_request)
}

fn verify_candidates_parallel(
    candidates: &[&CandidateDocument],
    plan: &crate::planner::QueryPlan,
    request: &SearchRequest,
    config: &EngineConfig,
    path_regex: Option<Regex>,
    per_file_limit: usize,
) -> Result<(Vec<SearchFileResult>, usize, usize, Vec<bool>), String> {
    let worker_count = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(2, 8)
        .min(candidates.len().max(1));
    let chunk_size = candidates.len().div_ceil(worker_count).max(1);
    let mut handles = Vec::new();

    for chunk in candidates.chunks(chunk_size) {
        let chunk = chunk
            .iter()
            .map(|candidate| (*candidate).clone())
            .collect::<Vec<_>>();
        let plan = plan.clone();
        let request = request.clone();
        let config = config.clone();
        let path_regex = path_regex.clone();
        handles.push(thread::spawn(
            move || -> Result<(Vec<SearchFileResult>, usize, usize, Vec<bool>), String> {
                let mut files = Vec::new();
                let mut scanned = 0usize;
                let mut total_matches = 0usize;
                let mut matched_terms = vec![false; plan.terms.len()];
                for candidate in chunk {
                    if let Some(regex) = &path_regex {
                        if !regex.is_match(&candidate.rel_path) {
                            continue;
                        }
                    }
                    scanned += 1;
                    let Some(current) = load_current_text(&candidate.absolute_path, &config)
                        .map_err(|err| err.to_string())?
                    else {
                        continue;
                    };
                    let (matches, term_coverage) = verify_plan_terms_with_coverage(
                        &current.text,
                        &plan,
                        &request,
                        per_file_limit,
                    )
                    .map_err(|err| err.to_string())?;
                    if matches.is_empty() {
                        continue;
                    }
                    merge_term_coverage(&mut matched_terms, &term_coverage);
                    total_matches += matches.len();
                    let score = score_file(&candidate.rel_path, &matches);
                    files.push(build_file_result(
                        candidate.rel_path,
                        current.byte_len,
                        current.modified_unix_secs,
                        score,
                        matches,
                    ));
                }
                Ok((files, scanned, total_matches, matched_terms))
            },
        ));
    }

    let mut files = Vec::new();
    let mut scanned = 0usize;
    let mut total_matches = 0usize;
    let mut matched_terms = vec![false; plan.terms.len()];
    for handle in handles {
        let (chunk_files, chunk_scanned, chunk_matches, chunk_term_coverage) = handle
            .join()
            .map_err(|_| "parallel verifier worker panicked".to_string())??;
        files.extend(chunk_files);
        scanned += chunk_scanned;
        total_matches += chunk_matches;
        merge_term_coverage(&mut matched_terms, &chunk_term_coverage);
    }
    Ok((files, scanned, total_matches, matched_terms))
}

fn fallback_candidates(
    workspace_root: &Path,
    request: &SearchRequest,
    warnings: &mut Vec<String>,
) -> std::io::Result<BTreeMap<String, CandidateDocument>> {
    if let Some(rel_path) = request
        .path_regex
        .as_deref()
        .and_then(exact_path_from_regex)
    {
        if !matches_path_filters(&rel_path, &request.include, &request.exclude) {
            return Ok(BTreeMap::new());
        }
        let absolute_path = workspace_root.join(&rel_path);
        if !absolute_path.is_file() {
            return Ok(BTreeMap::new());
        }
        warnings.push("search fallback checked exact path regex only".to_string());
        return Ok(BTreeMap::from([(
            rel_path.clone(),
            CandidateDocument {
                rel_path,
                absolute_path,
                rank: 0,
                order: 0,
            },
        )]));
    }
    if let Some(candidates) = rg_literal_fallback_candidates(workspace_root, request, warnings)? {
        return Ok(candidates);
    }
    let (entries, _) = discover_text_files(workspace_root, &EngineConfig::default())?;
    warnings.push("search fallback scanned the current text corpus".to_string());
    let path_regex = request
        .path_regex
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(std::io::Error::other)?;
    Ok(entries
        .into_iter()
        .filter(|entry| matches_path_filters(&entry.rel_path, &request.include, &request.exclude))
        .filter(|entry| {
            path_regex
                .as_ref()
                .map(|regex| regex.is_match(&entry.rel_path))
                .unwrap_or(true)
        })
        .enumerate()
        .map(|(order, entry)| {
            (
                entry.rel_path.clone(),
                CandidateDocument {
                    rel_path: entry.rel_path,
                    absolute_path: entry.abs_path,
                    rank: 0,
                    order,
                },
            )
        })
        .collect())
}

fn rg_literal_fallback_candidates(
    workspace_root: &Path,
    request: &SearchRequest,
    warnings: &mut Vec<String>,
) -> std::io::Result<Option<BTreeMap<String, CandidateDocument>>> {
    let literal_terms = request.all_query_terms();
    if request.use_regex
        || literal_terms.is_empty()
        || literal_terms.iter().any(|term| term.contains('\n'))
    {
        return Ok(None);
    }
    let mut args = vec![
        "--files-with-matches",
        "--fixed-strings",
        "--hidden",
        "--no-ignore",
        "--no-ignore-parent",
        "--text",
        "--glob",
        "!.zoek-rs/**",
        "--glob",
        "!.zoekt-rs/**",
    ];
    if !request.case_sensitive {
        args.push("--ignore-case");
    }
    if request.whole_word {
        args.push("--word-regexp");
    }
    for term in &literal_terms {
        args.push("-e");
        args.push(term);
    }
    args.push("--");
    args.push(".");
    let output = match Command::new("rg")
        .current_dir(workspace_root)
        .args(args)
        .output()
    {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if !output.status.success() && output.status.code() != Some(1) {
        return Ok(None);
    }
    let stdout = match String::from_utf8(output.stdout) {
        Ok(stdout) => stdout,
        Err(_) => return Ok(None),
    };
    let path_regex = request
        .path_regex
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(std::io::Error::other)?;
    let mut out = BTreeMap::new();
    for (order, line) in stdout.lines().enumerate() {
        let rel_path = line
            .trim()
            .strip_prefix("./")
            .unwrap_or_else(|| line.trim())
            .replace('\\', "/");
        if rel_path.is_empty()
            || !matches_path_filters(&rel_path, &request.include, &request.exclude)
        {
            continue;
        }
        if path_regex
            .as_ref()
            .map(|regex| !regex.is_match(&rel_path))
            .unwrap_or(false)
        {
            continue;
        }
        out.insert(
            rel_path.clone(),
            CandidateDocument {
                absolute_path: workspace_root.join(&rel_path),
                rel_path,
                rank: 0,
                order,
            },
        );
    }
    warnings.push("search fallback used ripgrep literal prefilter".to_string());
    Ok(Some(out))
}

fn exact_path_from_regex(pattern: &str) -> Option<String> {
    let inner = pattern.strip_prefix('^')?.strip_suffix('$')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next()?;
            out.push(escaped);
            continue;
        }
        if matches!(
            ch,
            '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$'
        ) {
            return None;
        }
        out.push(ch);
    }
    if out.is_empty() || out.contains('\0') || out.starts_with('/') || out.contains("..") {
        None
    } else {
        Some(out.replace('\\', "/"))
    }
}

#[cfg(test)]
mod tests {
    use super::{exact_path_from_regex, search_workspace};
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
        fs::write(root.join("src/generated.rs"), "struct AlphaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec!["src/generated.rs".to_string()],
                path_regex: None,
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
    fn exact_path_regex_is_decoded_for_targeted_fallback() {
        assert_eq!(
            exact_path_from_regex(r"^ijss\-e2e\-incremental\-123\.txt$").as_deref(),
            Some("ijss-e2e-incremental-123.txt")
        );
        assert_eq!(exact_path_from_regex(r"^src/.*\.rs$"), None);
        assert_eq!(exact_path_from_regex(r"^../secret$"), None);
    }

    #[test]
    fn search_workspace_uses_shards_for_literal_or_queries() -> io::Result<()> {
        let root = temp_dir("searcher-or");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        fs::write(root.join("src/b.rs"), "struct BetaService {}\n")?;
        fs::write(root.join("src/c.rs"), "struct GammaService {}\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaService".to_string(),
                query_terms: vec!["BetaService".to_string()],
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        let rel_paths = response
            .files
            .iter()
            .map(|file| file.rel_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(response.total_files_matched, 2);
        assert!(rel_paths.contains(&"src/a.rs"));
        assert!(rel_paths.contains(&"src/b.rs"));
        assert!(
            response.total_files_scanned < 3,
            "OR query should union selective shard candidates instead of scanning every file; scanned {} files",
            response.total_files_scanned,
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn literal_or_fallback_covers_query_terms_missing_from_sampled_index() -> io::Result<()> {
        let root = temp_dir("searcher-or-fallback");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.txt"), "AlphaIndexedTerm\n")?;

        let mut sampled_gap = "x".repeat(30 * 1024);
        sampled_gap.push_str("BetaFallbackTerm\n");
        sampled_gap.push_str(&"y".repeat(70 * 1024));
        fs::write(root.join("src/b.txt"), sampled_gap)?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "AlphaIndexedTerm".to_string(),
                query_terms: vec!["BetaFallbackTerm".to_string()],
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        let rel_paths = response
            .files
            .iter()
            .map(|file| file.rel_path.as_str())
            .collect::<Vec<_>>();
        assert!(rel_paths.contains(&"src/a.txt"));
        assert!(
            rel_paths.contains(&"src/b.txt"),
            "missing query_terms must trigger a literal fallback even when the primary query matched"
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn no_match_literal_with_no_index_candidates_does_not_fallback_scan() -> io::Result<()> {
        let root = temp_dir("searcher-no-match-no-fallback");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/target.txt"), "alpha beta gamma\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "ZZZ_NOPE".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_scanned, 0);
        assert_eq!(response.total_files_matched, 0);
        assert_eq!(response.total_matches, 0);
        assert!(
            !response
                .warnings
                .iter()
                .any(|warning| warning.contains("fallback")),
            "no-candidate no-match should not invoke fallback: {:?}",
            response.warnings
        );

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
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
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
    fn short_prefix_literals_do_not_force_full_scan_when_bounded_terms_select() -> io::Result<()> {
        let root = temp_dir("short-prefix-literal");
        fs::create_dir_all(root.join("src"))?;
        let prefix = (0..120)
            .map(|idx| format!("unique_prefix_token_{idx}_with_suffix_{idx}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            root.join("src/target.py"),
            format!("{prefix}\nfingerprintMatch = fp == b\"85:25:04:32:58:55:96:9f:57:ee:fb:a8:1a:ea:69:da\"\n"),
        )?;
        for idx in 0..40 {
            fs::write(
                root.join("src").join(format!("noise-{idx}.py")),
                format!("fingerprintMatch = other_{idx}\n"),
            )?;
        }
        let mut config = EngineConfig::default();
        config.max_grams_per_file = 16;
        index_directory(&root, &config)?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "tch = fp == b\"85:25:04:32:58:55:96:9f:57:ee:fb:a8".to_string(),
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
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/target.py");
        assert!(
            response.total_files_scanned < 10,
            "short unbounded prefix should not drop the indexed target and trigger full scan; scanned {}",
            response.total_files_scanned,
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn small_overflow_files_keep_late_sampled_grams_searchable() -> io::Result<()> {
        let root = temp_dir("small-overflow-late-sample");
        fs::create_dir_all(root.join("src"))?;
        let prefix = (0..160)
            .map(|idx| format!("unique_prefix_token_{idx}_with_suffix_{idx}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            root.join("src/target.py"),
            format!(
                "{prefix}\nstart_date = datetime.datetime.strptime(_start_date, \"%Y-%m-%d\").date()\n"
            ),
        )?;
        for idx in 0..40 {
            fs::write(
                root.join("src").join(format!("noise-{idx}.py")),
                format!("unique_noise_token_{idx}_with_suffix_{idx}\n"),
            )?;
        }
        let mut config = EngineConfig::default();
        config.max_grams_per_file = 16;
        index_directory(&root, &config)?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "time.datetime.strptime(_start_date, \"%Y-%m-%d\").date(".to_string(),
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
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/target.py");
        assert!(
            response.total_files_scanned < 20,
            "small overflow files should keep late sampled grams and avoid full scan; scanned {}",
            response.total_files_scanned,
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn long_multiline_literal_searches_verify_gram_incomplete_docs() -> io::Result<()> {
        let root = temp_dir("long-multiline-incomplete");
        fs::create_dir_all(root.join("src"))?;
        let target = (0..80)
            .map(|idx| format!("unique_target_token_{idx}_with_long_suffix_{idx}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("src/target.txt"), &target)?;
        for idx in 0..8 {
            fs::write(
                root.join("src").join(format!("noise-{idx}.txt")),
                format!("unique_noise_token_{idx}_with_long_suffix_{idx}\n"),
            )?;
        }
        let mut config = EngineConfig::default();
        config.max_grams_per_file = 4;
        index_directory(&root, &config)?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: target,
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &config,
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/target.txt");

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn overflow_samples_cover_short_unicode_token_before_segment_boundary() -> io::Result<()> {
        let root = temp_dir("overflow-unicode-boundary");
        fs::create_dir_all(root.join("src"))?;
        let target = "전자등기";
        let total_len = (512 * 1024) - 128;
        let target_offset = ((total_len * 4) / 16) - 512;
        let mut large = String::new();
        let mut idx = 0usize;
        while large.len() + 96 < target_offset {
            large.push_str(&format!(
                "unique_prefix_token_{idx}_with_long_suffix_{idx}_and_more_noise_{idx}\n"
            ));
            idx += 1;
        }
        while large.len() < target_offset {
            large.push('x');
        }
        large.push_str(target);
        large.push('\n');
        while large.len() < total_len {
            large.push('y');
        }
        fs::write(root.join("src/large_migration.py"), large)?;
        fs::write(root.join("src/indexed.py"), format!("{target}\n"))?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: target.to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;
        let rel_paths = response
            .files
            .iter()
            .map(|file| file.rel_path.as_str())
            .collect::<Vec<_>>();
        assert!(rel_paths.contains(&"src/indexed.py"));
        assert!(
            rel_paths.contains(&"src/large_migration.py"),
            "short unicode token near an overflow sample boundary must remain searchable without rg fallback"
        );
        assert!(
            response.total_files_scanned <= 4,
            "boundary recall fix must not turn short literals into broad incomplete-doc scans; scanned {}",
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
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: true,
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
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].matches[0].end_line, Some(2));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn regex_singleline_does_not_span_lines() -> io::Result<()> {
        let root = temp_dir("regex-singleline");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "foo\nbar\nbaz\n")?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "foo.*baz".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: true,
                regex_multiline: false,
                include: vec![],
                exclude: vec![],
                path_regex: None,
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
        let beta = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "BetaService".to_string(),
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
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec![],
                exclude: vec![],
                path_regex: None,
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
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
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

    #[test]
    fn search_order_is_not_overridden_by_file_match_count_score() -> io::Result<()> {
        let root = temp_dir("search-order-not-score");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a_first.rs"), "needle\n")?;
        fs::write(
            root.join("src/b_many.rs"),
            "needle\nneedle\nneedle\nneedle\nneedle\n",
        )?;
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "needle".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;

        assert_eq!(response.total_files_matched, 2);
        assert_eq!(
            response.files.first().map(|file| file.rel_path.as_str()),
            Some("src/a_first.rs"),
            "file match count score must not reorder broad search results ahead of rg-like candidate order",
        );

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn substring_literal_queries_narrow_candidates_for_unicode_tokens() -> io::Result<()> {
        let root = temp_dir("unicode-substring");
        fs::create_dir_all(root.join("src"))?;
        fs::write(
            root.join("src/a.rs"),
            "const VALUE: &str = \"한글검색지원\";\n",
        )?;
        for idx in 0..32 {
            fs::write(
                root.join("src").join(format!("noise-{idx}.rs")),
                format!("const VALUE_{idx}: &str = \"alphabet soup\";\n"),
            )?;
        }
        index_directory(&root, &EngineConfig::default())?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "한글검색".to_string(),
                query_terms: Vec::new(),
                case_sensitive: true,
                whole_word: false,
                use_regex: false,
                regex_multiline: true,
                include: vec!["src/*".to_string()],
                exclude: vec![],
                path_regex: None,
                limit: 10,
                offset: 0,
            },
            &EngineConfig::default(),
        )
        .map_err(io::Error::other)?;

        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/a.rs");
        assert!(
            response.total_files_scanned < 10,
            "expected unicode substring query to avoid scanning the whole workspace; scanned {} files",
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
