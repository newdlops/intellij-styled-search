use crate::config::EngineConfig;
use crate::corpus::discover_text_files;
use crate::mmap_store::{acquire_index_read_lock, StoreLayout};
use crate::overlay::load_overlay_with_recovery;
use crate::planner::{build_query_plan, QueryMode, QueryTermPlan};
use crate::protocol::{SearchFileResult, SearchMatch, SearchRequest, SearchResponse};
use crate::scorer::score_file;
use crate::shard::{open_validated_base_shard, read_base_shard_set, ShardDocument, ShardReader};
use crate::verifier::{
    build_file_result, load_current_text, PreparedPathFilters, PreparedVerifier,
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
    // Compile once per query, preserving up-front regex errors even when the
    // index selects no candidates. All verification paths reuse this state.
    let verifiers = plan
        .terms
        .iter()
        .map(|term| match plan.mode {
            QueryMode::Literal => Ok(PreparedVerifier::literal(
                &term.query,
                request.case_sensitive,
                request.whole_word,
            )),
            QueryMode::Regex => PreparedVerifier::regex(
                &term.effective_query,
                request.case_sensitive,
                request.regex_multiline,
            ),
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let workspace_root = Path::new(&request.workspace_root);
    let layout = StoreLayout::for_workspace(workspace_root, config);
    let mut warnings = Vec::new();
    let path_filters = PreparedPathFilters::new(&plan.include, &plan.exclude);

    let indexed_candidates = {
        let _read_lock = acquire_index_read_lock(&layout).map_err(|err| err.to_string())?;
        collect_index_candidates(
            workspace_root,
            &layout,
            &plan,
            config,
            &path_filters,
            &mut warnings,
        )
    };
    let candidates = match indexed_candidates {
        Ok(Some(candidates)) => candidates,
        Ok(None) => fallback_candidates(workspace_root, request, &path_filters, &mut warnings)
            .map_err(|err| err.to_string())?,
        Err(err) => {
            warnings.push(format!("index query fallback: {err}"));
            fallback_candidates(workspace_root, request, &path_filters, &mut warnings)
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
            &verifiers,
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
            let (matches, term_coverage) =
                verify_plan_terms_with_coverage(&current.text, &verifiers, remaining_match_budget);
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
            let fallback = fallback_candidates(
                workspace_root,
                &fallback_request,
                &path_filters,
                &mut warnings,
            )
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
                    &verifiers,
                    remaining_match_budget,
                );
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
    path_filters: &PreparedPathFilters<'_>,
    warnings: &mut Vec<String>,
) -> Result<Option<BTreeMap<String, CandidateDocument>>, String> {
    let base_shards = match read_base_shard_set(layout) {
        Ok(shards) => shards,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            warnings.push("no complete base index found; falling back to full scan".to_string());
            return Ok(None);
        }
        Err(err) => return Err(format!("base index validation failed: {err}")),
    };
    if base_shards.index_scope != config.persistent_index_scope() {
        warnings.push(format!(
            "base index scope is {}, but current scope is {}; falling back to full scan",
            base_shards.index_scope,
            config.persistent_index_scope()
        ));
        return Ok(None);
    }

    if !layout.overlay_path.is_file() {
        return Err("overlay validation failed: hot overlay is missing".to_string());
    }
    let overlay = load_overlay_with_recovery(layout)
        .map_err(|err| format!("overlay validation failed: {err}"))?;
    warnings.extend(overlay.warnings);
    let overlay = overlay.manifest;
    let latest_overlay = overlay.latest_entries();
    let path_regex = plan
        .path_regex
        .as_deref()
        .map(Regex::new)
        .transpose()
        .map_err(|err| err.to_string())?;

    let mut candidates = BTreeMap::new();
    let mut shard_order_base = 0usize;
    for (shard_id, shard_path) in base_shards.paths.into_iter().enumerate() {
        let reader = open_validated_base_shard(base_shards.identity, shard_id, &shard_path)
            .map_err(|err| format!("base index validation failed: {err}"))?;
        let docs = reader.documents().map_err(|err| err.to_string())?;
        let selected_ids =
            candidate_doc_ranks(&reader, &docs, plan).map_err(|err| err.to_string())?;
        for (doc, rank) in docs_for_ranked_ids(&docs, &selected_ids) {
            if latest_overlay.contains_key(&doc.rel_path) {
                continue;
            }
            if !path_filters.is_match(&doc.rel_path) {
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
        if !path_filters.is_match(&overlay_entry.rel_path) {
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
        let mut term_ids: Option<Vec<u32>> = None;
        let mut incomplete_sets = Vec::new();
        let mut incomplete_hit_counts = BTreeMap::<u32, u16>::new();
        let has_literal_special_gram = term
            .required_grams
            .iter()
            .any(|gram| gram.contains("://") || gram.contains(':'));
        for gram in &term.required_grams {
            let posting = reader.find_posting(gram)?;
            // Delta-decoded shard postings are already nondecreasing. Keep
            // them compact, but preserve the previous set semantics when a
            // gram occurs more than once in a document's posting list.
            let mut ids = posting.map(|posting| posting.doc_ids).unwrap_or_default();
            ids.dedup();
            let allow_incomplete_backfill =
                !has_literal_special_gram || gram.contains("://") || gram.contains(':');
            if allow_incomplete_backfill
                && !incomplete_ids.is_empty()
                && ids.len() <= INCOMPLETE_GRAM_BACKFILL_DOC_LIMIT
            {
                let incomplete_docs = ids
                    .iter()
                    .filter(|doc_id| incomplete_ids.contains(doc_id))
                    .copied()
                    .collect::<Vec<_>>();
                if !incomplete_docs.is_empty() {
                    for doc_id in &incomplete_docs {
                        *incomplete_hit_counts.entry(*doc_id).or_default() += 1;
                    }
                    incomplete_sets.push(incomplete_docs);
                }
            }
            match &mut term_ids {
                Some(existing) => intersect_sorted_doc_ids(existing, &ids),
                None => term_ids = Some(ids),
            }
            if term_ids.as_ref().is_some_and(Vec::is_empty) {
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
            incomplete_sets.sort_by_key(Vec::len);
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

/// Both inputs are sorted and unique. Retain the intersection in the existing
/// allocation instead of building a tree and another intersection per gram.
fn intersect_sorted_doc_ids(existing: &mut Vec<u32>, ids: &[u32]) {
    if ids.is_empty() {
        existing.clear();
        return;
    }
    let mut right = 0;
    existing.retain(|id| {
        while right < ids.len() && ids[right] < *id {
            right += 1;
        }
        ids.get(right) == Some(id)
    });
}

fn should_verify_all_incomplete_docs(mode: QueryMode, term: &QueryTermPlan) -> bool {
    mode == QueryMode::Literal
        && (term.query.contains('\n') || term.query.len() >= LONG_LITERAL_INCOMPLETE_BACKFILL_CHARS)
}

fn docs_for_ranked_ids<'a>(
    docs: &'a [ShardDocument],
    ids: &'a BTreeMap<u32, u16>,
) -> impl Iterator<Item = (&'a ShardDocument, u16)> + 'a {
    ids.iter()
        .filter_map(move |(doc_id, rank)| docs.get(*doc_id as usize).map(|doc| (doc, *rank)))
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
    verifiers: &[PreparedVerifier],
    limit: usize,
) -> (Vec<SearchMatch>, Vec<bool>) {
    let mut matches = Vec::new();
    let mut matched_terms = vec![false; verifiers.len()];
    for (term_idx, verifier) in verifiers.iter().enumerate() {
        let term_matches = verifier.verify(text, limit);
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
    (matches, matched_terms)
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
    verifiers: &[PreparedVerifier],
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
        let verifiers = verifiers.to_vec();
        let config = config.clone();
        let path_regex = path_regex.clone();
        handles.push(thread::spawn(
            move || -> Result<(Vec<SearchFileResult>, usize, usize, Vec<bool>), String> {
                let mut files = Vec::new();
                let mut scanned = 0usize;
                let mut total_matches = 0usize;
                let mut matched_terms = vec![false; verifiers.len()];
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
                    let (matches, term_coverage) =
                        verify_plan_terms_with_coverage(&current.text, &verifiers, per_file_limit);
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
    let mut matched_terms = vec![false; verifiers.len()];
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
    path_filters: &PreparedPathFilters<'_>,
    warnings: &mut Vec<String>,
) -> std::io::Result<BTreeMap<String, CandidateDocument>> {
    if let Some(rel_path) = request
        .path_regex
        .as_deref()
        .and_then(exact_path_from_regex)
    {
        if !path_filters.is_match(&rel_path) {
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
    if let Some(candidates) =
        rg_literal_fallback_candidates(workspace_root, request, path_filters, warnings)?
    {
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
        .filter(|entry| path_filters.is_match(&entry.rel_path))
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
    path_filters: &PreparedPathFilters<'_>,
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
        if rel_path.is_empty() || !path_filters.is_match(&rel_path) {
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
    use super::{
        candidate_doc_ranks, exact_path_from_regex, intersect_sorted_doc_ids, search_workspace,
        search_workspace_streaming,
    };
    use crate::config::{ripgrep_executable, EngineConfig};
    use crate::indexer::index_directory;
    use crate::mmap_store::StoreLayout;
    use crate::overlay::{apply_change_batch, OverlayEntry, OverlayManifest};
    use crate::protocol::{json_string, SearchRequest};
    use crate::shard::{build_shard_bytes, IndexedDocument, ShardReader};
    use crate::watcher::build_change_batch;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn prepared_scopes_keep_base_overlay_and_fallback_results_in_sync() -> io::Result<()> {
        use crate::verifier::matches_path_filters;
        use std::collections::BTreeSet;

        let root = temp_dir("prepared-path-scopes");
        let indexed = root.join("indexed");
        let fallback = root.join("fallback");
        let paths = [
            "src/direct.rs",
            "src/nested/unit.rs",
            "src/generated/unit.rs",
            "src/unit.test.rs",
            "tests/a1.rs",
            "tests/a2.rs",
            "notes.txt",
            "한글/😀.rs",
        ];
        for workspace in [&indexed, &fallback] {
            for rel_path in paths {
                let path = workspace.join(rel_path);
                fs::create_dir_all(path.parent().unwrap())?;
                fs::write(path, "shared_marker\n")?;
            }
        }
        let config = EngineConfig::default();
        index_directory(&indexed, &config)?;
        for workspace in [&indexed, &fallback] {
            fs::remove_file(workspace.join("src/nested/unit.rs"))?;
            for rel_path in ["src/direct.rs", "src/new.rs", "src/generated/new.rs"] {
                fs::write(workspace.join(rel_path), "shared_marker updated\n")?;
            }
        }
        let layout = StoreLayout::for_workspace(&indexed, &config);
        apply_change_batch(
            &indexed,
            &layout,
            &config,
            &build_change_batch(
                0,
                &[
                    "src/direct.rs".into(),
                    "src/new.rs".into(),
                    "src/generated/new.rs".into(),
                ],
                &["src/nested/unit.rs".into()],
                &[],
            ),
        )?;
        let mut current_paths = paths
            .into_iter()
            .filter(|path| *path != "src/nested/unit.rs")
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        current_paths.extend(["src/new.rs".to_string(), "src/generated/new.rs".to_string()]);
        let scopes: &[(&[&str], &[&str])] = &[
            (&[], &["**/generated/**", "**/*.test.rs"]),
            (&["src/*.rs"], &[]),
            (&["tests/a[!2].rs"], &[]),
            (&["[z-a]"], &[]),
            (&["src/**", "**/*.txt"], &["**/*.test.rs", "[z-a]"]),
            (&[], &["**"]),
        ];
        for workspace in [&indexed, &fallback] {
            for &(include, exclude) in scopes {
                // No base index exercises both rg literal fallback and full
                // corpus regex fallback; exact scopes use the targeted path.
                for (use_regex, exact) in [(false, false), (true, false), (false, true)] {
                    let request = SearchRequest {
                        workspace_root: workspace.to_string_lossy().into_owned(),
                        query: "shared_marker".to_string(),
                        query_terms: vec![],
                        case_sensitive: true,
                        whole_word: false,
                        use_regex,
                        regex_multiline: false,
                        include: include.iter().map(|value| value.to_string()).collect(),
                        exclude: exclude.iter().map(|value| value.to_string()).collect(),
                        path_regex: exact.then(|| r"^src/direct\.rs$".to_string()),
                        limit: 100,
                        offset: 0,
                    };
                    let expected = current_paths
                        .iter()
                        .filter(|path| {
                            matches_path_filters(path, &request.include, &request.exclude)
                                && (!exact || path.as_str() == "src/direct.rs")
                        })
                        .cloned()
                        .collect::<BTreeSet<_>>();
                    let response = search_workspace(&request, &config).map_err(io::Error::other)?;
                    assert_eq!(
                        response
                            .files
                            .iter()
                            .map(|file| file.rel_path.clone())
                            .collect::<BTreeSet<_>>(),
                        expected
                    );
                    assert_eq!(response.total_matches, expected.len());
                    if workspace == &indexed && !exact {
                        let diagnostic = crate::ops::diagnose_query(&request, &config)
                            .map_err(io::Error::other)?;
                        assert_eq!(diagnostic.final_candidate_count, expected.len());
                        assert_eq!(
                            diagnostic
                                .candidate_sample
                                .into_iter()
                                .collect::<BTreeSet<_>>(),
                            expected
                        );
                    }
                }
            }
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn sorted_posting_intersections_match_set_membership_for_sparse_and_boundary_ids() {
        let universe = [0, 1, 3, 9, 255, 65535, u32::MAX - 1, u32::MAX];
        let subset = |mask: usize| {
            universe
                .iter()
                .enumerate()
                .filter_map(|(idx, id)| ((mask & (1 << idx)) != 0).then_some(*id))
                .collect::<Vec<_>>()
        };
        for left in 0..256 {
            for right in 0..256 {
                let mut actual = subset(left);
                let ids = subset(right);
                let expected = actual
                    .iter()
                    .copied()
                    .filter(|id| ids.contains(id))
                    .collect::<Vec<_>>();
                intersect_sorted_doc_ids(&mut actual, &ids);
                assert_eq!(actual, expected, "left={left}, right={right}");
            }
        }
    }

    #[test]
    fn compact_postings_preserve_or_ranks_and_incomplete_backfill_rules() -> io::Result<()> {
        use crate::gram::hash_gram_value;
        use crate::planner::{QueryMode, QueryPlan, QueryTermPlan};
        use std::collections::BTreeMap;

        let root = temp_dir("compact-posting-ranks");
        fs::create_dir_all(&root)?;
        let input: &[(&[&str], bool)] = &[
            (&["a", "a", "b", "c"], false),
            (&["a", "a", "b"], true),
            (&["a"], true),
            (&["b", "c"], false),
            (&["c"], true),
            (&["x:y"], true),
            (&[], false),
        ];
        let documents = input
            .iter()
            .enumerate()
            .map(|(idx, (grams, incomplete))| IndexedDocument {
                rel_path: format!("unit-{idx}.txt"),
                byte_len: 0,
                modified_unix_secs: 1,
                content_hash: 1,
                grams: grams.iter().map(|gram| hash_gram_value(gram)).collect(),
                gram_incomplete: *incomplete,
            })
            .collect::<Vec<_>>();
        let shard_path = root.join("shard.zrs");
        fs::write(&shard_path, build_shard_bytes(0, 1, 1, &documents)?.bytes)?;
        let reader = ShardReader::open(&shard_path)?;
        let docs = reader.documents()?;
        let term = |query: &str, grams: &[&str]| QueryTermPlan {
            query: query.to_string(),
            effective_query: query.to_string(),
            required_literals: vec![],
            required_grams: grams.iter().map(|gram| gram.to_string()).collect(),
        };
        let ranks = |terms| {
            candidate_doc_ranks(
                &reader,
                &docs,
                &QueryPlan {
                    mode: QueryMode::Literal,
                    effective_query: String::new(),
                    terms,
                    case_sensitive: true,
                    whole_word: false,
                    include: vec![],
                    exclude: vec![],
                    path_regex: None,
                    required_literals: vec![],
                    required_grams: vec![],
                },
            )
        };

        // OR keeps the strongest rank and de-duplicates repeated posting IDs.
        assert_eq!(
            ranks(vec![term("ab", &["a", "b"]), term("c", &["c"])])?,
            BTreeMap::from([(0, 1002), (1, 1002), (3, 1001), (4, 1001)])
        );
        // Stop at the same empty intersection; later grams must not alter the
        // incomplete hit counts or the stable choice between equal-sized sets.
        assert_eq!(
            ranks(vec![term("missing", &["a", "missing", "b"])])?,
            BTreeMap::from([(1, 1), (2, 1)])
        );
        assert_eq!(
            ranks(vec![term("bc", &["b", "c"])])?,
            BTreeMap::from([(0, 1002), (1, 1), (3, 1002)])
        );
        // A specialized literal gram restricts which incomplete postings can
        // supply backfill; missing specialized grams cannot borrow other hits.
        assert_eq!(
            ranks(vec![term("a x:y", &["a", "x:y"])])?,
            BTreeMap::from([(5, 1)])
        );
        assert!(ranks(vec![term("a z:w", &["a", "z:w"])])?.is_empty());
        for query in ["a\nmissing".to_string(), "a".repeat(512)] {
            assert_eq!(
                ranks(vec![term(&query, &["a", "missing"])])?,
                BTreeMap::from([(1, 0), (2, 0), (4, 0), (5, 0)])
            );
        }
        let all_docs = (0..7).map(|id| (id, 0)).collect::<BTreeMap<_, _>>();
        assert_eq!(
            ranks(vec![term("a", &["a"]), term("short", &[])])?,
            all_docs
        );
        assert_eq!(ranks(vec![])?, all_docs);
        drop(reader);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn reused_verifiers_preserve_or_results_pagination_and_streamed_ranges() -> io::Result<()> {
        let root = temp_dir("prepared-query");
        for (directory, count) in [("serial", 3), ("parallel", 160)] {
            fs::create_dir_all(root.join(directory))?;
            for idx in 0..count {
                fs::write(
                    root.join(directory).join(format!("unit-{idx}.txt")),
                    "pré😀 item\r\nITEM other\r\n",
                )?;
            }
        }
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        for (directory, count) in [("serial", 3), ("parallel", 160)] {
            for (use_regex, regex_multiline) in [(false, false), (true, false), (true, true)] {
                let mut request = SearchRequest {
                    workspace_root: root.to_string_lossy().into_owned(),
                    query: "item".to_string(),
                    query_terms: vec![if use_regex { "item|other" } else { "other" }.to_string()],
                    case_sensitive: false,
                    whole_word: true,
                    use_regex,
                    regex_multiline,
                    include: vec![format!("{directory}/**")],
                    exclude: vec![],
                    path_regex: None,
                    limit: 1000,
                    offset: 0,
                };
                let response = search_workspace(&request, &config).map_err(io::Error::other)?;
                assert_eq!(response.total_matches, count * 3);
                assert_eq!(response.files.len(), count);
                assert!(response.warnings.is_empty());
                for file in &response.files {
                    assert_eq!(
                        file.matches
                            .iter()
                            .map(|found| (found.line, found.start_column, found.end_column))
                            .collect::<Vec<_>>(),
                        vec![(0, 5, 9), (1, 0, 4), (1, 5, 10)]
                    );
                    assert_eq!(file.matches[0].preview, "pré😀 item\r");
                    assert!(file.matches.iter().all(|found| found.end_line.is_none()));
                }
                let mut events = Vec::new();
                let streamed = search_workspace_streaming(&request, &config, |file| {
                    events.push(file.to_json());
                    Ok(())
                })
                .map_err(io::Error::other)?;
                assert_eq!(streamed.to_json(), response.to_json());
                assert_eq!(
                    events,
                    response
                        .files
                        .iter()
                        .map(|file| file.to_json())
                        .collect::<Vec<_>>()
                );

                request.offset = 2;
                request.limit = 4;
                let page = search_workspace(&request, &config).map_err(io::Error::other)?;
                events.clear();
                let streamed_page = search_workspace_streaming(&request, &config, |file| {
                    events.push(file.to_json());
                    Ok(())
                })
                .map_err(io::Error::other)?;
                assert_eq!(
                    page.files
                        .iter()
                        .map(|file| file.matches.len())
                        .sum::<usize>(),
                    4
                );
                assert!(page.truncated);
                assert_eq!(
                    streamed_page
                        .files
                        .iter()
                        .map(|file| file.to_json())
                        .collect::<Vec<_>>(),
                    page.files
                        .iter()
                        .map(|file| file.to_json())
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    events,
                    page.files
                        .iter()
                        .map(|file| file.to_json())
                        .collect::<Vec<_>>()
                );
            }
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn invalid_regex_still_errors_when_no_file_can_match() -> io::Result<()> {
        let root = temp_dir("prepared-query-invalid");
        fs::create_dir_all(&root)?;
        fs::write(root.join("unit.txt"), "unrelated text\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        let mut request = SearchRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            query: String::new(),
            query_terms: vec![],
            case_sensitive: true,
            whole_word: false,
            use_regex: true,
            regex_multiline: false,
            include: vec!["missing/**".to_string()],
            exclude: vec![],
            path_regex: None,
            limit: 10,
            offset: 0,
        };
        for pattern in ["[", r"(a)\1", "(?=x)"] {
            request.query = pattern.to_string();
            assert!(search_workspace(&request, &config).is_err());
            assert!(search_workspace_streaming(&request, &config, |_| Ok(())).is_err());
        }
        fs::remove_dir_all(root)?;
        Ok(())
    }

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
    fn changed_index_scope_falls_back_before_ignored_files_can_be_missed() -> io::Result<()> {
        let root = temp_dir("scope-mismatch-fallback");
        fs::create_dir_all(root.join("source"))?;
        fs::create_dir_all(root.join("artifacts"))?;
        fs::write(root.join(".ignore"), "artifacts/\n")?;
        fs::write(root.join("source/unit.rs"), "pub fn active() {}\n")?;
        fs::write(
            root.join("artifacts/unit.rs"),
            "pub const CACHED_MARKER: &str = \"scope_fallback_marker\";\n",
        )?;
        if !Command::new(ripgrep_executable())
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success())
        {
            fs::remove_dir_all(root)?;
            return Ok(());
        }

        index_directory(&root, &EngineConfig::default())?;
        let mut all_files_config = EngineConfig::default();
        all_files_config.include_ignored_files = true;
        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "scope_fallback_marker".to_string(),
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
            &all_files_config,
        )
        .map_err(io::Error::other)?;
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "artifacts/unit.rs");
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("base index scope is workspace")));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn mixed_base_build_identities_fall_back_to_current_workspace_text() -> io::Result<()> {
        let root = temp_dir("mixed-base-build");
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

        let response = search_workspace(
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
        assert_eq!(response.total_files_matched, 1);
        assert_eq!(response.files[0].rel_path, "src/a.rs");
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("base index validation failed")));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn missing_overlay_state_falls_back_before_new_files_can_be_missed() -> io::Result<()> {
        let root = temp_dir("missing-overlay-fallback");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/base.rs"), "struct BaseRecord {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        fs::remove_file(root.join(".zoek-rs/hot-overlay.json"))?;
        fs::write(root.join("src/new.rs"), "struct NewlyAddedMarker {}\n")?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "NewlyAddedMarker".to_string(),
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
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("overlay validation failed")));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn malformed_overlay_state_falls_back_before_new_files_can_be_missed() -> io::Result<()> {
        let root = temp_dir("malformed-overlay-fallback");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/base.rs"), "struct BaseRecord {}\n")?;
        let config = EngineConfig::default();
        index_directory(&root, &config)?;
        fs::write(root.join(".zoek-rs/hot-overlay.json"), "{}")?;
        fs::write(root.join("src/new.rs"), "struct NewlyAddedMarker {}\n")?;

        let response = search_workspace(
            &SearchRequest {
                workspace_root: root.to_string_lossy().into_owned(),
                query: "NewlyAddedMarker".to_string(),
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
        assert!(response
            .warnings
            .iter()
            .any(|warning| warning.contains("overlay validation failed")));

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
        let low_content = "needle\n";
        let high_content = "needle\nneedle\nneedle\nneedle\nneedle\n";
        fs::write(root.join("src/low.rs"), low_content)?;
        fs::write(root.join("src/high.rs"), high_content)?;
        let documents = [("src/low.rs", low_content), ("src/high.rs", high_content)]
            .into_iter()
            .map(|(rel_path, content)| {
                let (grams, overflow) = crate::gram::extract_dynamic_gram_hashes_with_overflow(
                    rel_path,
                    content,
                    EngineConfig::default().max_grams_per_file,
                );
                IndexedDocument {
                    rel_path: rel_path.to_string(),
                    byte_len: content.len() as u64,
                    modified_unix_secs: 0,
                    content_hash: 0,
                    grams,
                    gram_incomplete: overflow,
                }
            })
            .collect::<Vec<_>>();
        let layout = StoreLayout::for_workspace(&root, &EngineConfig::default());
        layout.ensure_dirs()?;
        let shard = build_shard_bytes(0, 1, 2, &documents)?;
        fs::write(layout.shard_path(0), &shard.bytes)?;
        fs::write(layout.write_lock_path(), "")?;
        fs::write(
            &layout.manifest_path,
            format!(
                "{{\"engine\":\"zoek-rs\",\"schemaVersion\":22,\"workspaceMetadataHashVersion\":3,\"indexScope\":\"workspace\",\"workspaceRoot\":{},\"indexRoot\":{},\"createdUnixSecs\":1,\"buildId\":\"2\",\"fingerprint\":1,\"workspaceMetadataFingerprint\":1,\"configFingerprint\":1,\"shardMetadataFingerprint\":1,\"stats\":{{\"visitedFiles\":2,\"indexedFiles\":2,\"skippedBinary\":0,\"skippedBinaryExtension\":0,\"skippedTooLarge\":0,\"decodedUtf16Files\":0,\"shardCount\":1,\"totalGrams\":{},\"totalSourceBytes\":{},\"totalShardBytes\":{}}},\"baseShards\":[{{\"shardId\":0,\"fileName\":\"base-shard-0000.zrs\",\"docCount\":2,\"gramCount\":{},\"sourceBytes\":{},\"fileBytes\":{}}}]}}",
                json_string(&root.to_string_lossy()),
                json_string(&layout.root.to_string_lossy()),
                shard.header.gram_count,
                shard.source_bytes,
                shard.bytes.len(),
                shard.header.gram_count,
                shard.source_bytes,
                shard.bytes.len(),
            ),
        )?;
        OverlayManifest::empty().save(&layout.overlay_path)?;

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
            Some("src/low.rs"),
            "file match count score must not reorder a lower document id",
        );
        assert!(response.files[1].score > response.files[0].score);

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
