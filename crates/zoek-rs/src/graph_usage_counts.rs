//! Materialized counts of the same deduplicated union returned by Find Usages.
//! Reference decoding and candidate inference belong to builds/updates. A
//! count lookup reads fixed-width, sorted records and the small edit overlay.
use super::*;
use crate::graph_overlay::{GraphOverlay, OverlayTokenShapeCandidate};

pub(super) const SHARD_PREFIX: &str = "callgraph-usage-counts-by-id-v1";
const MAGIC: &[u8; 8] = b"IJSSUC01";
type CandidateMap = BTreeMap<(u64, u64, u64), Vec<OverlayTokenShapeCandidate>>;

// Compaction preserves builtAt for the extension's cache guard. Serving
// generations additionally identify the immutable base so an old cursor
// cannot become valid again when the overlay revision resets.
pub(super) fn base_generation(
    workspace: &Path,
    config: &EngineConfig,
    built_at: u64,
) -> io::Result<u64> {
    let manifest = fs::read_to_string(graph_manifest_path(workspace, config))?;
    Ok(json_u64_field(&manifest, "queryGeneration").unwrap_or(built_at))
}

pub(super) fn overlay_candidates(sites: &[RefSite]) -> HashMap<String, CandidateMap> {
    let mut out: HashMap<String, CandidateMap> = HashMap::new();
    for site in sites {
        let access = compute_access_kind_id(&site.access_kind);
        if !matches!(access, ACCESS_KIND_BARE | ACCESS_KIND_MEMBER) {
            continue;
        }
        let key = (
            stable_hash(&site.language),
            stable_hash(source_scope_key(&site.rel_path)),
            site.name_hash,
        );
        out.entry(site.rel_path.to_string())
            .or_default()
            .entry(key)
            .or_default()
            .push(OverlayTokenShapeCandidate {
                access_kind_id: access,
                is_definition: site.is_definition,
                reference: GraphReference {
                    source_ref_id: format!("ref:{:016x}", site.source_ref_id).into(),
                    target_symbol_id: None,
                    edge_kind: site.edge_kind.as_ref().into(),
                    name: site.name.as_str().into(),
                    raw_text: site.name.as_str().into(),
                    uri: "".into(),
                    rel_path: site.rel_path.as_ref().into(),
                    start_line: site.start_line,
                    start_column: site.start_column,
                    end_line: site.end_line,
                    end_column: site.end_column,
                    enclosing_symbol_id: enclosing_id_to_string(site.enclosing_id).map(Into::into),
                    bound_mask: BOUND_MAY,
                    confidence: "possible".into(),
                    provenance: "token-shape".into(),
                },
            });
    }
    out
}

/// Bound peak memory by processing one target shard at a time. This uses the
/// reference implementation of the query union, rather than a second set of
/// candidate/deduplication rules that can diverge from the panel.
pub(super) fn build(workspace: &Path, config: &EngineConfig) -> io::Result<()> {
    let built_at = read_built_at_unix_ms(&graph_manifest_path(workspace, config))?;
    let generation = base_generation(workspace, config, built_at)?;
    let files = read_file_table_binary(&graph_file_table_path(workspace, config))?;
    let empty_overlay = GraphOverlay::new(built_at);
    for shard in 0..GRAPH_SHARD_COUNT {
        let symbol_path = graph_shard_path(workspace, config, GRAPH_SYMBOL_ID_SHARD_PREFIX, shard);
        let symbols = if symbol_path.exists() {
            read_symbols(&symbol_path, &files)?
        } else {
            Vec::new()
        };
        let ids: HashSet<String> = symbols.iter().map(|symbol| symbol.id.clone()).collect();
        let counts =
            deduped_reference_counts_from_index(workspace, config, &ids, &symbols, &empty_overlay)?;
        let mut rows: Vec<(u64, u64)> = symbols
            .iter()
            .filter_map(|symbol| {
                parse_stable_symbol_id_to_u64(&symbol.id).map(|id| {
                    (
                        id,
                        counts
                            .get(&symbol.id.to_ascii_lowercase())
                            .copied()
                            .unwrap_or(0) as u64,
                    )
                })
            })
            .collect();
        rows.sort_unstable_by_key(|row| row.0);
        let mut bytes = Vec::with_capacity(16 + rows.len() * 16);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&generation.to_le_bytes());
        for (id, count) in rows {
            bytes.extend_from_slice(&id.to_le_bytes());
            bytes.extend_from_slice(&count.to_le_bytes());
        }
        write_atomically(
            &graph_shard_path(workspace, config, SHARD_PREFIX, shard),
            &bytes,
        )?;
    }
    Ok(())
}

pub(super) fn read(
    workspace: &Path,
    config: &EngineConfig,
    ids: &HashSet<String>,
) -> io::Result<Option<HashMap<String, usize>>> {
    let built_at = read_built_at_unix_ms(&graph_manifest_path(workspace, config))?;
    let generation = base_generation(workspace, config, built_at)?;
    let overlay = GraphOverlay::load_valid(workspace, config, built_at);
    let mut out = HashMap::new();
    let mut by_shard: BTreeMap<usize, Vec<(String, u64)>> = BTreeMap::new();
    for id in ids {
        let Some(value) = parse_stable_symbol_id_to_u64(id) else {
            return Ok(None);
        };
        let normalized = id.to_ascii_lowercase();
        if let Some(&count) = overlay.usage_counts.get(&value) {
            out.insert(normalized, count);
        } else {
            by_shard
                .entry(shard_index_for_key(&normalized))
                .or_default()
                .push((normalized, value));
        }
    }
    for (shard, targets) in by_shard {
        let bytes = match fs::read(graph_shard_path(workspace, config, SHARD_PREFIX, shard)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if bytes.len() < 16
            || &bytes[..8] != MAGIC
            || u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != generation
            || (bytes.len() - 16) % 16 != 0
        {
            return Ok(None);
        }
        let records = &bytes[16..];
        for (name, id) in targets {
            let mut lo = 0;
            let mut hi = records.len() / 16;
            while lo < hi {
                let mid = lo + (hi - lo) / 2;
                let key = u64::from_le_bytes(records[mid * 16..mid * 16 + 8].try_into().unwrap());
                if key < id {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            if lo >= records.len() / 16
                || u64::from_le_bytes(records[lo * 16..lo * 16 + 8].try_into().unwrap()) != id
            {
                return Ok(None);
            }
            let count = u64::from_le_bytes(records[lo * 16 + 8..lo * 16 + 16].try_into().unwrap());
            out.insert(
                name,
                usize::try_from(count).map_err(|_| invalid_data("usage count overflow"))?,
            );
        }
    }
    Ok(Some(out))
}

pub(super) fn update_overlay(
    workspace: &Path,
    config: &EngineConfig,
    compact: &[CompactSym],
    overlay: &mut GraphOverlay,
) -> io::Result<()> {
    let mut ids: HashSet<String> = overlay
        .usage_counts
        .keys()
        .map(|id| format!("sym:{id:016x}"))
        .collect();
    ids.extend(
        overlay
            .count_deltas
            .keys()
            .map(|id| format!("sym:{id:016x}")),
    );
    let mut keys: HashSet<(u64, u64, u64)> = overlay
        .total_token_shape_target_deltas()
        .keys()
        .copied()
        .collect();
    for entry in overlay.entries.values() {
        keys.extend(entry.token_shape_candidates.keys().copied());
        ids.extend(
            entry
                .refs
                .iter()
                .filter_map(|reference| reference.target_symbol_id.as_deref().map(str::to_string)),
        );
    }
    // Include removed candidates too: a file may now have no refs at all, or
    // formerly used a key whose eager fanout was too large to emit any rows.
    let files: HashSet<String> = overlay.entries.keys().cloned().collect();
    let shards: HashSet<usize> = files.iter().map(|file| shard_index_for_key(file)).collect();
    let table = read_file_table_binary(&graph_file_table_path(workspace, config))?;
    let old_sites =
        read_ref_sites_excluding_paths(workspace, config, &HashSet::new(), &table, Some(&shards))?;
    for site in old_sites
        .iter()
        .filter(|site| files.contains(&*site.rel_path))
    {
        keys.insert((
            stable_hash(&site.language),
            stable_hash(source_scope_key(&site.rel_path)),
            site.name_hash,
        ));
    }
    for symbol in compact {
        if keys.contains(&(
            symbol.lang_hash,
            stable_hash(source_scope_key(&symbol.rel_path)),
            symbol.name_hash,
        )) {
            ids.insert(format!("sym:{:016x}", symbol.id_u64));
        }
    }
    let mut symbols = read_symbols_for_symbol_ids_indexed(workspace, config, &ids)?;
    let superseded = overlay.symbol_superseded();
    // The compact slice contains only edited files. A declaration addition can
    // invalidate the former unique target in another file with this key.
    let name_hashes: AHashSet<u64> = keys.iter().map(|key| key.2).collect();
    for symbol in load_resolve_candidates(workspace, config, &table, &name_hashes)? {
        let key = (
            stable_hash(&symbol.language),
            stable_hash(source_scope_key(&symbol.rel_path)),
            symbol.name_hash,
        );
        if keys.contains(&key) {
            ids.insert(symbol.id.clone());
            symbols.push(symbol);
        }
    }
    symbols.retain(|symbol| !superseded.contains(&symbol.rel_path));
    for symbol in overlay.live_symbols() {
        let key = (
            stable_hash(&symbol.language),
            stable_hash(source_scope_key(&symbol.rel_path)),
            symbol.name_hash,
        );
        if ids.contains(&symbol.id) || keys.contains(&key) {
            ids.insert(symbol.id.clone());
            symbols.push(symbol.clone());
        }
    }
    let mut seen = HashSet::new();
    symbols.retain(|symbol| seen.insert(symbol.id.clone()));
    let counts = deduped_reference_counts_from_index(workspace, config, &ids, &symbols, overlay)?;
    overlay.usage_counts = ids
        .into_iter()
        .filter_map(|id| {
            parse_stable_symbol_id_to_u64(&id).map(|value| {
                (
                    value,
                    counts.get(&id.to_ascii_lowercase()).copied().unwrap_or(0),
                )
            })
        })
        .collect();
    Ok(())
}

pub(super) fn audit(
    workspace: &Path,
    config: &EngineConfig,
    top_n: usize,
    dump: Option<&Path>,
) -> io::Result<String> {
    let built_at = read_built_at_unix_ms(&graph_manifest_path(workspace, config))?;
    let overlay = GraphOverlay::load_valid(workspace, config, built_at);
    let table = read_file_table_binary(&graph_file_table_path(workspace, config))?;
    let superseded = overlay.symbol_superseded();
    let mut checked = 0usize;
    let mut equal = 0usize;
    let mut under: Vec<serde_json::Value> = Vec::new();
    let mut over: Vec<serde_json::Value> = Vec::new();
    let mut total_refs = 0usize;
    let mut under_total = 0usize;
    let mut over_total = 0usize;
    let mut dump_text =
        String::from("relPath\tname\tkind\tusageCount\tusageMust\tusageMay\tqueryable\n");
    for shard in 0..GRAPH_SHARD_COUNT {
        let path = graph_shard_path(workspace, config, GRAPH_SYMBOL_ID_SHARD_PREFIX, shard);
        let mut symbols = if path.exists() {
            read_symbols(&path, &table)?
        } else {
            Vec::new()
        };
        symbols.retain(|symbol| !superseded.contains(&symbol.rel_path));
        symbols.extend(
            overlay
                .live_symbols()
                .filter(|symbol| shard_index_for_key(&symbol.id) == shard)
                .cloned(),
        );
        let ids: HashSet<String> = symbols.iter().map(|symbol| symbol.id.clone()).collect();
        let actual =
            deduped_reference_counts_from_index(workspace, config, &ids, &symbols, &overlay)?;
        let mut displayed = symbols.clone();
        apply_count_options_for_symbols(
            workspace,
            config,
            &mut displayed,
            GraphSymbolQueryOptions::default(),
        )?;
        for symbol in displayed {
            let count = symbol.usage_count.unwrap_or(0);
            let queryable = actual
                .get(&symbol.id.to_ascii_lowercase())
                .copied()
                .unwrap_or(0);
            checked += 1;
            total_refs += queryable;
            if count == queryable {
                equal += 1;
            } else {
                let delta = count.abs_diff(queryable);
                let offender = serde_json::json!({
                    "symbolId": symbol.id, "name": symbol.name, "relPath": symbol.rel_path,
                    "kind": symbol.kind, "usageCount": count, "queryable": queryable, "delta": delta,
                });
                if count < queryable {
                    under_total += delta;
                    under.push(offender);
                } else {
                    over_total += delta;
                    over.push(offender);
                }
            }
            if dump.is_some()
                && !symbol
                    .rel_path
                    .split('/')
                    .any(|part| matches!(part, ".venv" | "node_modules" | "site-packages"))
            {
                use std::fmt::Write;
                writeln!(
                    &mut dump_text,
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    symbol.rel_path,
                    symbol.name,
                    symbol.kind,
                    count,
                    symbol.usage_must_count.unwrap_or(0),
                    symbol.usage_may_count.unwrap_or(0),
                    queryable
                )
                .unwrap();
            }
        }
    }
    let under_symbols = under.len();
    let over_symbols = over.len();
    for offenders in [&mut under, &mut over] {
        offenders.sort_by_key(|entry| std::cmp::Reverse(entry["delta"].as_u64().unwrap_or(0)));
        offenders.truncate(top_n);
    }
    if let Some(path) = dump {
        write_atomically(path, dump_text.as_bytes())?;
    }
    Ok(serde_json::json!({
        "type": "graph-audit-counts", "workspaceRoot": workspace, "builtAtUnixMs": built_at,
        "semantics": "live deduplicated query union, including lazy candidates and edited files",
        "overlayFiles": overlay.entry_count(), "symbolsChecked": checked, "exact": equal,
        "totalQueryableRefs": total_refs,
        "undercount": {"symbols": under_symbols, "totalDeficit": under_total, "topOffenders": under},
        "overcount": {"symbols": over_symbols, "totalExcess": over_total, "topOffenders": over},
    }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            static NEXT_WORKSPACE: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(0);
            let sequence = NEXT_WORKSPACE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "ijss-live-usage-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("pkg")).unwrap();
            fs::write(
                root.join("pkg/provider.py"),
                "class Worker:\n    def run(self):\n        pass\n",
            )
            .unwrap();
            Self(root)
        }
        fn consumer(&self, calls: usize) -> PathBuf {
            let path = self.0.join("pkg/consumer.py");
            fs::write(
                &path,
                format!(
                    "def consume(client):\n{}",
                    if calls == 0 {
                        "    pass\n".to_string()
                    } else {
                        "    client.run()\n".repeat(calls)
                    }
                ),
            )
            .unwrap();
            path
        }
        fn target(&self, config: &EngineConfig) -> GraphSymbol {
            query_graph_symbols(&self.0, "Worker.run", 10, config)
                .unwrap()
                .unwrap()
                .symbols
                .remove(0)
        }
        fn assert_usages(&self, expected: usize, config: &EngineConfig) -> GraphSymbol {
            let target = self.target(config);
            let result = query_graph(&self.0, &target.id, usize::MAX, config)
                .unwrap()
                .unwrap();
            assert_eq!(target.usage_count, Some(expected));
            assert_eq!(result.total_references, expected);
            assert_eq!(result.references.len(), expected);
            assert!(result
                .references
                .iter()
                .all(|reference| reference.rel_path.as_ref() == "pkg/consumer.py"));
            target
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn live_usage_counts_replace_removed_lazy_candidates_before_compaction() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        ws.consumer(600); // Exceeds eager fanout; query must include lazy candidates.
        rebuild_graph_native(&ws.0, 100, &config, 1, &mut |_| {}).unwrap();
        ws.assert_usages(600, &config);
        for calls in [2, 0, 4, 1] {
            let path = ws.consumer(calls);
            overlay_update_graph_native(&ws.0, &[path], &[], 100, &config, 1).unwrap();
            ws.assert_usages(calls, &config);
            let report: serde_json::Value =
                serde_json::from_str(&audit(&ws.0, &config, 10, None).unwrap()).unwrap();
            assert_eq!(report["undercount"]["symbols"], 0);
            assert_eq!(report["overcount"]["symbols"], 0);
        }
        compact_graph_overlay(&ws.0, 101, &config, 1).unwrap();
        ws.assert_usages(1, &config);
        let deleted = ws.0.join("pkg/consumer.py");
        fs::remove_file(&deleted).unwrap();
        overlay_update_graph_native(&ws.0, &[], &[deleted], 101, &config, 1).unwrap();
        ws.assert_usages(0, &config);
        rebuild_graph_native(&ws.0, 102, &config, 1, &mut |_| {}).unwrap();
        ws.assert_usages(0, &config);
    }

    #[test]
    fn materialized_usage_lookup_does_not_decode_reference_shards_and_old_indexes_fall_back() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        ws.consumer(20);
        rebuild_graph_native(&ws.0, 200, &config, 1, &mut |_| {}).unwrap();
        let target = ws.assert_usages(20, &config);
        let reference_path = graph_reference_target_shard_path(&ws.0, &config, &target.id);
        let saved = fs::read(&reference_path).unwrap();
        fs::write(&reference_path, b"invalid reference record").unwrap();
        assert_eq!(
            ws.target(&config).usage_count,
            Some(20),
            "count queries must use the materialized count"
        );
        fs::write(reference_path, saved).unwrap();
        let count_path = graph_shard_path(
            &ws.0,
            &config,
            SHARD_PREFIX,
            shard_index_for_key(&target.id),
        );
        fs::remove_file(count_path).unwrap();
        ws.assert_usages(20, &config);
    }

    #[test]
    fn usage_pages_cover_every_occurrence_once_and_reject_mixed_edit_generations() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        ws.consumer(23);
        rebuild_graph_native(&ws.0, 300, &config, 1, &mut |_| {}).unwrap();
        let target = ws.target(&config);
        let first = query_graph_page(&ws.0, &target.id, 7, 0, None, &config)
            .unwrap()
            .unwrap();
        assert_eq!(first.total_references, 23);
        assert_eq!(first.next_offset, Some(7));
        let mut collected = first.references;
        let mut offset = first.next_offset;
        while let Some(next) = offset {
            let page =
                query_graph_page(&ws.0, &target.id, 7, next, Some(&first.generation), &config)
                    .unwrap()
                    .unwrap();
            assert_eq!(page.total_references, 23);
            assert_eq!(page.offset, next);
            offset = page.next_offset;
            collected.extend(page.references);
        }
        assert_eq!(collected.len(), 23);
        assert_eq!(
            collected
                .iter()
                .map(|reference| reference.source_ref_id.as_ref())
                .collect::<HashSet<_>>()
                .len(),
            23
        );
        let changed = ws.consumer(24);
        overlay_update_graph_native(&ws.0, &[changed], &[], 300, &config, 1).unwrap();
        assert_eq!(
            query_graph_page(&ws.0, &target.id, 7, 7, Some(&first.generation), &config)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        // The base cookie remains 300 across compaction. A pre-edit cursor
        // must still be rejected after the overlay revision resets.
        compact_graph_overlay(&ws.0, 300, &config, 1).unwrap();
        assert_eq!(
            query_graph_page(&ws.0, &target.id, 7, 7, Some(&first.generation), &config)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn parameter_shadowing_excludes_possible_usages_across_live_updates() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let source = ws.0.join("pkg/scopes.py");
        let before = "def calculate():\n    pass\ndef outer(calculate: calculate = calculate):\n    def nested():\n        return calculate()\n    return calculate()\ndef explicit(calculate):\n    def nested_global():\n        global calculate\n        return calculate()\n    return calculate()\ncalculate()\n";
        let assert_locations = |expected: &[(u32, u32)]| {
            let target = query_graph_symbols(&ws.0, "calculate", 10, &config).unwrap().unwrap()
                .symbols.into_iter().find(|s| s.rel_path == "pkg/scopes.py" && s.kind == "function").unwrap();
            let result = query_graph(&ws.0, &target.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(target.usage_count, Some(result.total_references));
            let locations: Vec<_> = result.references.iter().filter(|r| r.edge_kind.as_ref() == "call")
                .map(|r| (r.start_line, r.start_column)).collect();
            assert_eq!(locations, expected);
            assert!(result.references.iter().all(|r| !matches!(r.start_line, 4 | 5 | 10)));
            for column in [21, 33] {
                assert!(result.references.iter().any(|r| (r.start_line, r.start_column) == (2, column)),
                    "annotation/default references must remain queryable");
            }
            assert!(!result.references.iter().any(|r| (r.start_line, r.start_column) == (2, 10)));
        };
        fs::write(&source, before).unwrap();
        rebuild_graph_native(&ws.0, 500, &config, 1, &mut |_| {}).unwrap();
        assert_locations(&[(9, 15), (11, 0)]);
        let after = before.replace("return calculate()", "return 1");
        fs::write(&source, after).unwrap();
        overlay_update_graph_native(&ws.0, &[source.clone()], &[], 500, &config, 1).unwrap();
        assert_locations(&[(11, 0)]);
        compact_graph_overlay(&ws.0, 501, &config, 1).unwrap();
        assert_locations(&[(11, 0)]);
        fs::write(&source, before).unwrap();
        update_graph_native(&ws.0, &[source], &[], 502, &config, 1).unwrap();
        assert_locations(&[(9, 15), (11, 0)]);
    }

    #[test]
    fn name_queries_read_counts_only_for_returned_symbols_and_can_skip_counts() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        ws.consumer(20);
        rebuild_graph_native(&ws.0, 550, &config, 1, &mut |_| {}).unwrap();
        let target = ws.target(&config);
        let selected = shard_index_for_key(&target.id);
        let other = (selected + 1) % GRAPH_SHARD_COUNT;
        let other_path = graph_shard_path(&ws.0, &config, GRAPH_COUNT_ID_SHARD_PREFIX, other);
        fs::write(other_path, b"invalid count record").unwrap();
        assert_eq!(ws.target(&config).usage_count, Some(20));
        // Now even the selected count is unreadable. Metadata-only lookups
        // must still return the same ranked declaration without count I/O.
        fs::write(graph_shard_path(&ws.0, &config, GRAPH_COUNT_ID_SHARD_PREFIX, selected), b"invalid").unwrap();
        let result = query_graph_symbols_with_options(&ws.0, "Worker.run", 1, &config,
            GraphSymbolQueryOptions { include_usage_counts: false, include_implementation_counts: false })
            .unwrap().unwrap();
        assert_eq!(result.symbols.len(), 1);
        assert_eq!(result.symbols[0].id, target.id);
        assert_eq!(result.symbols[0].usage_count, None);
        assert_eq!(result.symbols[0].implementation_count, None);
    }

    #[test]
    fn unicode_identifier_usages_keep_utf16_ranges_after_masked_literals() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let path = ws.0.join("pkg/unicode.py");
        fs::write(&path, "def 계산(value):\n    return value\n\ndef invoke():\n    표시 = \"😀\"; return 계산(1)\n").unwrap();
        rebuild_graph_native(&ws.0, 400, &config, 1, &mut |_| {}).unwrap();
        let target = query_graph_symbols(&ws.0, "계산", 10, &config)
            .unwrap()
            .unwrap()
            .symbols
            .remove(0);
        assert_eq!(target.end_column - target.start_column, 2);
        assert_eq!(target.usage_count, Some(1));
        let result = query_graph(&ws.0, &target.id, 10, &config)
            .unwrap()
            .unwrap();
        assert_eq!(result.references.len(), 1);
        let reference = &result.references[0];
        assert_eq!(
            (
                reference.start_line,
                reference.start_column,
                reference.end_column
            ),
            (4, 22, 24)
        );
        assert_eq!(reference.confidence.as_ref(), "exact");
    }
}
