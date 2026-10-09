//! Materialized counts of the same deduplicated union returned by Find Usages.
//! Reference decoding and candidate inference belong to builds/updates. A
//! count lookup reads fixed-width, sorted records and the small edit overlay.
use super::*;
use crate::graph_overlay::{GraphOverlay, OverlayTokenShapeCandidate};

pub(super) const SHARD_PREFIX: &str = "callgraph-usage-counts-by-id-v1";
const MAGIC: &[u8; 8] = b"IJSSUC01";
type CandidateMap = BTreeMap<(u64, u64, u64), Vec<OverlayTokenShapeCandidate>>;

// A build/audit reads one immutable graph generation. Reuse hierarchy lookups
// across target shards, with a boundary on retained declarations and entries.
fn bound_member_families(families: &mut HashMap<String, Option<MemberImplementationFamily>>) {
    let methods: usize = families.values().filter_map(Option::as_ref)
        .map(|family| family.methods.len()).sum();
    if methods > 50_000 || families.len() > 65_536 {
        families.clear();
    }
}

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

pub(super) fn candidate_mask(
    site_count: usize,
    bare: &HashMap<(u64, u64, u64), Vec<u32>>,
    member: &HashMap<(u64, u64, u64), Vec<u32>>,
) -> Vec<bool> {
    // Use the full resolver's candidate selection, including lexical and
    // resolved-import exclusions. An edited file must not reintroduce proven
    // local bindings as candidates for unrelated same-name declarations.
    let mut eligible = vec![false; site_count];
    for index in bare.values().chain(member.values()).flatten() {
        eligible[*index as usize] = true;
    }
    eligible
}

pub(super) fn overlay_candidates(
    sites: &[RefSite],
    bare: &HashMap<(u64, u64, u64), Vec<u32>>,
    member: &HashMap<(u64, u64, u64), Vec<u32>>,
) -> HashMap<String, CandidateMap> {
    let eligible = candidate_mask(sites.len(), bare, member);
    let mut out: HashMap<String, CandidateMap> = HashMap::new();
    for (index, site) in sites.iter().enumerate() {
        if !eligible[index] { continue; }
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

/// Bound peak memory by processing one target shard per worker. This uses the
/// reference implementation of the query union, rather than a second set of
/// candidate/deduplication rules that can diverge from the panel.
pub(super) fn build(workspace: &Path, config: &EngineConfig) -> io::Result<()> {
    build_with_workers(workspace, config, count_worker_count())
}

fn count_worker_count() -> usize {
    let requested = std::env::var("ZOEK_COUNT_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(4);
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let memory_workers = std::env::var("ZOEK_MEMORY_CAP_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map_or(4, |bytes| (bytes / (256 * 1024 * 1024)).max(1));
    requested
        .min(4)
        .min(cpus)
        .min(memory_workers)
        .min(graph_worker_count(GRAPH_SHARD_COUNT))
}

fn build_with_workers(workspace: &Path, config: &EngineConfig, workers: usize) -> io::Result<()> {
    let built_at = read_built_at_unix_ms(&graph_manifest_path(workspace, config))?;
    let generation = base_generation(workspace, config, built_at)?;
    let files = read_file_table_binary(&graph_file_table_path(workspace, config))?;
    let empty_overlay = GraphOverlay::new(built_at);
    let graph_available = graph_index_available(workspace, config);
    let sharded_references =
        graph_shard_family_available(workspace, config, GRAPH_REFERENCE_TARGET_SHARD_PREFIX);
    let next_shard = std::sync::atomic::AtomicUsize::new(0);
    let stats = std::thread::scope(|scope| -> io::Result<Vec<(usize, usize)>> {
        let mut handles = Vec::new();
        for _ in 0..workers.max(1).min(GRAPH_SHARD_COUNT) {
            let files = &files;
            let empty_overlay = &empty_overlay;
            let next_shard = &next_shard;
            handles.push(scope.spawn(move || -> io::Result<(usize, usize)> {
                let mut member_families = HashMap::default();
                let mut context = ReferenceCountReadContext {
                    file_table: &files,
                    sharded_references,
                    shard_cache: Some(CountShardCache::new(
                        if std::env::var("ZOEK_DISABLE_COUNT_SHARD_CACHE").is_ok() {
                            0
                        } else {
                            32 * 1024 * 1024
                        },
                    )),
                };
                loop {
                    let shard = next_shard.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if shard >= GRAPH_SHARD_COUNT {
                        break;
                    }
                    let symbol_path =
                        graph_shard_path(workspace, config, GRAPH_SYMBOL_ID_SHARD_PREFIX, shard);
                    let symbols = if symbol_path.exists() {
                        read_symbols(&symbol_path, &files)?
                    } else {
                        Vec::new()
                    };
                    let ids: HashSet<String> =
                        symbols.iter().map(|symbol| symbol.id.clone()).collect();
                    let counts = if graph_available {
                        deduped_reference_counts_with_context(
                            workspace,
                            config,
                            &ids,
                            &symbols,
                            empty_overlay,
                            &mut member_families,
                            &mut context,
                        )?
                    } else {
                        HashMap::default()
                    };
                    bound_member_families(&mut member_families);
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
                Ok(context
                    .shard_cache
                    .as_ref()
                    .map_or((0, 0), |cache| (cache.reads, cache.hits)))
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().expect("usage count worker panicked"))
            .collect()
    })?;
    if std::env::var("ZOEK_WRITE_PROBE").is_ok() {
        let (reads, hits) = stats
            .into_iter()
            .fold((0, 0), |(reads, hits), (r, h)| (reads + r, hits + h));
        eprintln!("[counts] workers={workers} token-shape shard reads={reads} cache_hits={hits}");
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
    changed: &HashSet<String>,
    previous: &BTreeMap<String, crate::graph_overlay::GraphOverlayEntry>,
    table: &FileTable,
    contribution_changes: &BTreeMap<u64, [i64; 4]>,
    overlay: &mut GraphOverlay,
) -> io::Result<()> {
    let mut ids: HashSet<String> = contribution_changes
        .keys()
        .map(|id| format!("sym:{id:016x}"))
        .collect();
    type CandidateKey = (u64, u64, u64);
    type Signature = (CountSourceOccurrence, u8, bool, u32, u32);
    let signatures = |candidates: &[OverlayTokenShapeCandidate]| -> HashSet<Signature> {
        candidates
            .iter()
            .map(|candidate| {
                (
                    CountSourceOccurrence::from_reference(&candidate.reference),
                    candidate.access_kind_id,
                    candidate.is_definition,
                    candidate.reference.start_line,
                    candidate.reference.start_column,
                )
            })
            .collect()
    };
    let mut keys = HashSet::new();
    for entry in previous
        .values()
        .chain(changed.iter().filter_map(|path| overlay.entries.get(path)))
    {
        ids.extend(
            entry
                .refs
                .iter()
                .filter_map(|reference| reference.target_symbol_id.as_deref().map(str::to_string)),
        );
        for symbol in &entry.symbols {
            ids.insert(symbol.id.clone());
        }
    }
    // Include removed candidates too: a file may now have no refs at all, or
    // formerly used a key whose eager fanout was too large to emit any rows.
    let files: HashSet<String> = changed
        .iter()
        .filter(|path| !previous.contains_key(*path))
        .cloned()
        .collect();
    let shards: HashSet<usize> = files.iter().map(|file| shard_index_for_key(file)).collect();
    let old_sites =
        read_ref_sites_excluding_paths(workspace, config, &HashSet::new(), table, Some(&shards))?;
    let mut base_keys = HashSet::new();
    for site in old_sites
        .iter()
        .filter(|site| files.contains(&*site.rel_path))
    {
        base_keys.insert((
            stable_hash(&site.language),
            stable_hash(source_scope_key(&site.rel_path)),
            site.name_hash,
        ));
    }
    let (bare, member) = load_token_shape_tally_for_keys(workspace, config, &base_keys, None)?;
    let mut old_candidates: HashMap<String, HashMap<CandidateKey, HashSet<Signature>>> =
        HashMap::new();
    for (key, candidates) in bare.into_iter().chain(member) {
        for candidate in candidates {
            let path = table.get_path(candidate.file_id).unwrap_or("");
            if files.contains(path) {
                old_candidates
                    .entry(path.to_string())
                    .or_default()
                    .entry(key)
                    .or_default()
                    .insert((
                        CountSourceOccurrence::Id(candidate.source_ref_id),
                        candidate.access_kind_id(),
                        candidate.is_definition(),
                        candidate.start_line,
                        candidate.start_column,
                    ));
            }
        }
    }
    for path in changed {
        let prior = previous.get(path);
        let current = overlay.entries.get(path);
        let mut old: HashMap<_, _> = if let Some(prior) = prior {
            prior
                .token_shape_candidates
                .iter()
                .map(|(&key, values)| (key, signatures(values)))
                .collect()
        } else {
            old_candidates.remove(path).unwrap_or_default()
        };
        if let Some(current) = current {
            for (&key, values) in &current.token_shape_candidates {
                if old.remove(&key).unwrap_or_default() != signatures(values) {
                    keys.insert(key);
                }
            }
        }
        keys.extend(
            old.into_iter()
                .filter(|(_, values)| !values.is_empty())
                .map(|(key, _)| key),
        );
        let mut deltas = prior
            .map(|entry| entry.token_shape_target_deltas.clone())
            .unwrap_or_default();
        if let Some(current) = current {
            for (&key, &value) in &current.token_shape_target_deltas {
                if deltas.remove(&key).unwrap_or_default() != value {
                    keys.insert(key);
                }
            }
        }
        keys.extend(
            deltas
                .into_iter()
                .filter(|(_, value)| *value != (0, 0))
                .map(|(key, _)| key),
        );
    }
    for symbol in compact {
        ids.insert(format!("sym:{:016x}", symbol.id_u64));
    }
    let mut symbols = read_symbols_for_symbol_ids_indexed(workspace, config, &ids)?;
    let superseded = overlay.symbol_superseded();
    // The compact slice contains only edited files. A declaration addition can
    // invalidate the former unique target in another file with this key.
    let name_hashes: AHashSet<u64> = keys.iter().map(|key| key.2).collect();
    for symbol in load_resolve_candidates(workspace, config, table, &name_hashes)? {
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
    if std::env::var("ZOEK_FLOW_PROBE").is_ok() {
        eprintln!(
            "[overlay] refresh_usage targets={} keys={} changed_files={} retained_counts={}",
            ids.len(),
            keys.len(),
            changed.len(),
            overlay.usage_counts.len()
        );
    }
    // Preserve absolute overrides from earlier edits. Removed references still
    // refresh their former targets, including a zero-count override.
    overlay
        .usage_counts
        .extend(ids.into_iter().filter_map(|id| {
            parse_stable_symbol_id_to_u64(&id).map(|value| {
                (
                    value,
                    counts.get(&id.to_ascii_lowercase()).copied().unwrap_or(0),
                )
            })
        }));
    Ok(())
}

pub(super) fn audit(
    workspace: &Path,
    config: &EngineConfig,
    top_n: usize,
    dump: Option<&Path>,
) -> io::Result<String> {
    // Keep the base immutable while hierarchy entries are reused across the
    // audit. Writers already hold this lock throughout count materialization.
    let _graph_lock = acquire_graph_lock(workspace)?;
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
    let mut member_families = HashMap::default();
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
            deduped_reference_counts_from_index_with_families(workspace, config, &ids, &symbols, &overlay, &mut member_families)?;
        bound_member_families(&mut member_families);
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
    fn parallel_count_shards_match_serial_query_union() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        ws.consumer(512);
        fs::write(ws.0.join("pkg/types.ts"),
            "interface Task { run(): void; }\nclass Left implements Task { run() {} }\nclass Right implements Task { run() {} }\nfunction invoke(task: Task) { task.run(); }\n").unwrap();
        rebuild_graph_native(&ws.0, 920, &config, 1, &mut |_| {}).unwrap();
        build_with_workers(&ws.0, &config, 1).unwrap();
        let serial: Vec<_> = (0..GRAPH_SHARD_COUNT).map(|shard|
            fs::read(graph_shard_path(&ws.0, &config, SHARD_PREFIX, shard)).unwrap()).collect();
        build_with_workers(&ws.0, &config, 4).unwrap();
        for (shard, bytes) in serial.iter().enumerate() {
            assert_eq!(*bytes, fs::read(graph_shard_path(&ws.0, &config, SHARD_PREFIX, shard)).unwrap());
        }
        for symbol in query_graph_symbols(&ws.0, "", 1000, &config).unwrap().unwrap().symbols {
            assert_eq!(symbol.usage_count, Some(query_graph(&ws.0, &symbol.id, usize::MAX, &config).unwrap().unwrap().total_references));
        }
    }

    #[test]
    fn stale_import_index_falls_back_to_current_base_bindings() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        rebuild_graph_native(&ws.0, 930, &config, 1, &mut |_| {}).unwrap();
        let generation_path = config.index_root(&ws.0).join(edit_facts::GENERATION_FILE);
        let old_generation = fs::read(&generation_path).unwrap();
        let old_shards: Vec<_> = (0..GRAPH_SHARD_COUNT).map(|shard|
            fs::read(graph_shard_path(&ws.0, &config, edit_facts::PREFIX, shard)).unwrap()).collect();
        fs::write(ws.0.join("pkg/consumer.py"), "import pkg.provider as source\nsource.future()\n").unwrap();
        rebuild_graph_native(&ws.0, 931, &config, 1, &mut |_| {}).unwrap();
        // A previous runtime can rebuild the base without knowing this newer
        // additive index. Its old rows must not hide a newly indexed importer.
        fs::write(&generation_path, old_generation).unwrap();
        for (shard, bytes) in old_shards.iter().enumerate() {
            fs::write(graph_shard_path(&ws.0, &config, edit_facts::PREFIX, shard), bytes).unwrap();
        }
        let provider = ws.0.join("pkg/provider.py");
        fs::write(&provider, "def future():\n    return 1\n").unwrap();
        overlay_update_graph_native(&ws.0, &[provider], &[], 931, &config, 1).unwrap();
        let target = query_graph_symbols(&ws.0, "future", 10, &config).unwrap().unwrap().symbols.remove(0);
        assert_eq!(target.usage_count, Some(1));
        assert_eq!(target.usage_must_count, Some(1));
        assert_eq!(query_graph(&ws.0, &target.id, 100, &config).unwrap().unwrap().total_references, 1);
    }

    #[test]
    fn unrelated_declaration_edits_do_not_refresh_named_importers() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let provider = ws.0.join("pkg/provider.py");
        fs::write(&provider, "def kept():\n    return 1\n").unwrap();
        fs::write(ws.0.join("pkg/consumer.py"),
            "from pkg.provider import kept\ndef consume():\n    return kept()\n").unwrap();
        fs::write(ws.0.join("pkg/outer.py"),
            "from pkg.consumer import consume\nconsume()\n").unwrap();
        rebuild_graph_native(&ws.0, 900, &config, 1, &mut |_| {}).unwrap();
        for calls in [1, 2] {
            fs::write(&provider, format!(
                "def kept():\n    return 1\ndef added():\n    return 2\n{}", "added()\n".repeat(calls))).unwrap();
            overlay_update_graph_native(&ws.0, &[provider.clone()], &[], 900, &config, 1).unwrap();
            let overlay = GraphOverlay::load_valid(&ws.0, &config, 900);
            assert_eq!(overlay.entries.keys().map(String::as_str).collect::<Vec<_>>(), ["pkg/provider.py"],
                "an unrelated export cannot change named import bindings");
            let added = query_graph_symbols(&ws.0, "added", 10, &config).unwrap().unwrap().symbols.remove(0);
            assert_eq!(added.usage_count, Some(calls));
            assert_eq!(query_graph(&ws.0, &added.id, 100, &config).unwrap().unwrap().total_references, calls);
        }
        fs::write(&provider, "def kept():\n    return 1\n").unwrap();
        overlay_update_graph_native(&ws.0, &[provider], &[], 900, &config, 1).unwrap();
        assert!(query_graph_symbols(&ws.0, "added", 10, &config).unwrap().unwrap().symbols.is_empty());
        let live = query_graph_symbols(&ws.0, "", 1000, &config).unwrap().unwrap().symbols;
        rebuild_graph_native(&ws.0, 901, &config, 1, &mut |_| {}).unwrap();
        let fresh = query_graph_symbols(&ws.0, "", 1000, &config).unwrap().unwrap().symbols;
        let counts = |symbols: Vec<GraphSymbol>| symbols.into_iter().map(|s| (s.id, s.usage_count)).collect::<BTreeMap<_, _>>();
        assert_eq!(counts(live), counts(fresh));
    }

    #[test]
    fn declaration_addition_refreshes_namespace_wildcard_and_transitive_importers() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let provider = ws.0.join("pkg/provider.py");
        fs::write(&provider, "def kept():\n    return 1\n").unwrap();
        fs::write(ws.0.join("pkg/namespace.py"),
            "import pkg.provider as source\ndef consume():\n    return source.added()\n").unwrap();
        fs::write(ws.0.join("pkg/wildcard.py"),
            "from pkg.provider import *\ndef consume():\n    return added()\n").unwrap();
        fs::write(ws.0.join("pkg/outer.py"),
            "from pkg.namespace import consume\nconsume()\n").unwrap();
        rebuild_graph_native(&ws.0, 910, &config, 1, &mut |_| {}).unwrap();
        fs::write(&provider, "def kept():\n    return 1\ndef added():\n    return 2\n").unwrap();
        overlay_update_graph_native(&ws.0, &[provider], &[], 910, &config, 1).unwrap();
        let overlay = GraphOverlay::load_valid(&ws.0, &config, 910);
        for path in ["pkg/namespace.py", "pkg/wildcard.py", "pkg/outer.py"] {
            assert!(overlay.entries.contains_key(path), "dependent must refresh: {path}");
        }
        let live = query_graph_symbols(&ws.0, "", 1000, &config).unwrap().unwrap().symbols;
        rebuild_graph_native(&ws.0, 911, &config, 1, &mut |_| {}).unwrap();
        let fresh = query_graph_symbols(&ws.0, "", 1000, &config).unwrap().unwrap().symbols;
        let counts = |symbols: Vec<GraphSymbol>| symbols.into_iter().map(|s| (s.id, s.usage_count)).collect::<BTreeMap<_, _>>();
        assert_eq!(counts(live), counts(fresh));
    }

    #[test]
    fn member_declaration_fallback_excludes_same_name_bare_calls() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let provider = ws.0.join("pkg/provider.js");
        let write = |calls: usize| fs::write(&provider,
            format!("export function adapt() {{}}\nexport class Left {{\n  adapt() {{}}\n}}\nexport class Right {{\n  adapt() {{}}\n}}\n{}",
                "adapt();\n".repeat(calls))).unwrap();
        let check = || {
            let symbols = query_graph_symbols(&ws.0, "adapt", 100, &config).unwrap().unwrap().symbols;
            let methods: Vec<_> = symbols.iter().filter(|s| s.kind == "method" && s.rel_path == "pkg/provider.js").collect();
            assert_eq!(methods.len(), 2);
            for target in methods {
                let page = query_graph(&ws.0, &target.id, usize::MAX, &config).unwrap().unwrap();
                assert_eq!(target.usage_count, Some(page.total_references));
                assert_eq!(page.total_references, 0, "unrelated methods cannot receive same-name bare function calls");
            }
        };
        write(512);
        rebuild_graph_native(&ws.0, 800, &config, 1, &mut |_| {}).unwrap();
        check();
        write(1);
        overlay_update_graph_native(&ws.0, &[provider], &[], 800, &config, 1).unwrap();
        check();
        compact_graph_overlay(&ws.0, 801, &config, 1).unwrap();
        check();
    }

    #[test]
    fn live_candidate_union_keeps_multiple_files_through_chained_edits_and_deletion() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let paths: Vec<_> = (0..3).map(|i| ws.0.join(format!("pkg/consumer{i}.py"))).collect();
        let write = |path: &Path, calls: usize| fs::write(path,
            format!("def consume(client):\n{}", "    client.run()\n".repeat(calls))).unwrap();
        for path in &paths { write(path, 2); }
        let check = |expected: &[usize]| {
            let target = ws.target(&config);
            let page = query_graph(&ws.0, &target.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(target.usage_count, Some(expected.iter().sum()));
            assert_eq!(page.total_references, expected.iter().sum::<usize>());
            for (i, count) in expected.iter().enumerate() {
                let path = format!("pkg/consumer{i}.py");
                assert_eq!(page.references.iter().filter(|r| r.rel_path.as_ref() == path).count(), *count);
            }
        };
        rebuild_graph_native(&ws.0, 850, &config, 1, &mut |_| {}).unwrap();
        check(&[2, 2, 2]);
        write(&paths[0], 3);
        write(&paths[1], 4);
        overlay_update_graph_native(&ws.0, &paths[..2], &[], 850, &config, 1).unwrap();
        check(&[3, 4, 2]);
        write(&paths[0], 1);
        fs::remove_file(&paths[2]).unwrap();
        overlay_update_graph_native(&ws.0, &[paths[0].clone()], &[paths[2].clone()], 850, &config, 1).unwrap();
        check(&[1, 4, 0]);
        compact_graph_overlay(&ws.0, 851, &config, 1).unwrap();
        check(&[1, 4, 0]);
        rebuild_graph_native(&ws.0, 852, &config, 1, &mut |_| {}).unwrap();
        check(&[1, 4, 0]);
    }

    #[test]
    fn dependency_refresh_preserves_lexical_bindings_and_imported_return_types() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let seed = ws.0.join("pkg/seed.py");
        fs::write(&seed, "def anchor():\n    pass\n").unwrap();
        fs::write(ws.0.join("pkg/model.py"),
            "class Record:\n    valid: bool\nclass Other:\n    valid: bool\n").unwrap();
        fs::write(ws.0.join("pkg/producer.py"),
            "from pkg.model import Record\ndef produce() -> Record:\n    return Record()\n").unwrap();
        fs::write(ws.0.join("pkg/unrelated.py"), "def payload():\n    pass\n").unwrap();
        fs::write(ws.0.join("pkg/use.py"),
            "from pkg.seed import anchor\nfrom pkg.producer import produce\ndef consume(value):\n    payload = value\n    result = produce()\n    return result.valid, payload\n").unwrap();
        let check = || {
            let field = query_graph_symbols(&ws.0, "Record.valid", 10, &config).unwrap().unwrap()
                .symbols.into_iter().find(|s| s.qualified_name == "Record.valid").unwrap();
            let page = query_graph(&ws.0, &field.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(field.usage_count, Some(1));
            assert_eq!(page.total_references, 1);
            assert_eq!(page.references[0].provenance.as_ref(), "type-fact");
            let unrelated = query_graph_symbols(&ws.0, "payload", 100, &config).unwrap().unwrap()
                .symbols.into_iter().find(|s| s.rel_path == "pkg/unrelated.py").unwrap();
            let page = query_graph(&ws.0, &unrelated.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(unrelated.usage_count, Some(1), "references: {:?}", page.references);
            assert_eq!(page.total_references, 1, "only the conservative declaration candidate remains");
            assert_eq!(page.references[0].start_line, 3, "local reads cannot be bound to an unrelated callable");
        };
        rebuild_graph_native(&ws.0, 860, &config, 1, &mut |_| {}).unwrap();
        check();
        fs::write(&seed, "def added():\n    pass\n").unwrap();
        overlay_update_graph_native(&ws.0, &[seed.clone()], &[], 860, &config, 1).unwrap();
        assert!(GraphOverlay::load_valid(&ws.0, &config, 860).entries.contains_key("pkg/use.py"));
        check();
        compact_graph_overlay(&ws.0, 861, &config, 1).unwrap();
        check();
        fs::remove_file(graph_shard_path(&ws.0, &config, edit_facts::PREFIX, 0)).unwrap();
        fs::write(&seed, "def anchor():\n    pass\ndef added():\n    pass\n").unwrap();
        overlay_update_graph_native(&ws.0, &[seed], &[], 860, &config, 1).unwrap();
        check();
    }

    #[test]
    fn javascript_alias_edits_follow_dependencies_in_overlay_and_compaction() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let provider = ws.0.join("pkg/provider.js");
        let consumer = ws.0.join("pkg/consumer.js");
        let write_provider = |selected: &str| fs::write(&provider, format!(
            "function First() {{ return 1; }}\nfunction Second() {{ return 2; }}\nexport default {selected};\n")).unwrap();
        write_provider("First");
        fs::write(ws.0.join("pkg/bridge.js"), "export { default as Alias } from './provider.js';\n").unwrap();
        fs::write(&consumer, "import { Alias } from './bridge.js';\nAlias();\n").unwrap();
        let lines = |name: &str| {
            let symbols = query_graph_symbols(&ws.0, name, 100, &config).unwrap().unwrap().symbols;
            let target = symbols.iter().find(|symbol| symbol.name == name && symbol.rel_path == "pkg/provider.js").unwrap();
            let page = query_graph(&ws.0, &target.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(target.usage_count, Some(page.total_references));
            let mut lines: Vec<_> = page.references.iter().filter(|reference| &*reference.rel_path == "pkg/consumer.js")
                .map(|reference| reference.start_line).collect();
            lines.sort(); lines.dedup(); lines
        };
        rebuild_graph_native(&ws.0, 700, &config, 1, &mut |_| {}).unwrap();
        assert_eq!(lines("First"), [0, 1]);
        fs::write(&consumer, "import { Alias } from './bridge.js';\nAlias();\nfunction local() {\n  var Alias = 0;\n  return Alias;\n}\n").unwrap();
        overlay_update_graph_native(&ws.0, &[consumer.clone()], &[], 700, &config, 1).unwrap();
        assert_eq!(lines("First"), [0, 1], "editing an importer must retain the transitive export binding");
        write_provider("Second");
        overlay_update_graph_native(&ws.0, &[provider.clone()], &[], 700, &config, 1).unwrap();
        assert!(lines("First").is_empty(), "changing an export must invalidate unchanged consumers");
        assert_eq!(lines("Second"), [0, 1]);
        fs::write(&consumer, "import { Alias } from './bridge.js';\nAlias();\nAlias();\n").unwrap();
        overlay_update_graph_native(&ws.0, &[consumer.clone()], &[], 700, &config, 1).unwrap();
        assert_eq!(lines("Second"), [0, 1, 2], "later edits must use a provider's pending binding facts");
        compact_graph_overlay(&ws.0, 701, &config, 1).unwrap();
        assert_eq!(lines("Second"), [0, 1, 2]);
        write_provider("First");
        update_graph_native(&ws.0, &[provider], &[], 702, &config, 1).unwrap();
        assert_eq!(lines("First"), [0, 1, 2]);
        assert!(lines("Second").is_empty());
        let report: serde_json::Value = serde_json::from_str(&audit(&ws.0, &config, 10, None).unwrap()).unwrap();
        assert_eq!(report["undercount"]["symbols"], 0);
        assert_eq!(report["overcount"]["symbols"], 0);
    }

    #[test]
    fn javascript_global_assignment_edits_refresh_existing_and_pending_consumers() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        let provider = ws.0.join("pkg/global-provider.js");
        let consumer = ws.0.join("pkg/global-consumer.js");
        let write_provider = |selected: &str| fs::write(&provider, format!(
            "function First() {{ return 1; }}\nfunction Second() {{ return 2; }}\nexport {{}};\nwindow.published = {selected};\n")).unwrap();
        write_provider("First");
        fs::write(&consumer, "window.published();\n").unwrap();
        let lines = |name: &str| {
            let symbols = query_graph_symbols(&ws.0, name, 100, &config).unwrap().unwrap().symbols;
            let target = symbols.iter().find(|symbol| symbol.name == name && symbol.rel_path == "pkg/global-provider.js").unwrap();
            let page = query_graph(&ws.0, &target.id, usize::MAX, &config).unwrap().unwrap();
            assert_eq!(target.usage_count, Some(page.total_references));
            let mut lines: Vec<_> = page.references.iter().filter(|reference| &*reference.rel_path == "pkg/global-consumer.js")
                .map(|reference| reference.start_line).collect();
            lines.sort(); lines.dedup(); lines
        };
        rebuild_graph_native(&ws.0, 800, &config, 1, &mut |_| {}).unwrap();
        assert_eq!(lines("First"), [0]);
        fs::write(&consumer, "window.published();\nwindow.published();\n").unwrap();
        overlay_update_graph_native(&ws.0, &[consumer.clone()], &[], 800, &config, 1).unwrap();
        assert_eq!(lines("First"), [0, 1]);
        write_provider("Second");
        overlay_update_graph_native(&ws.0, &[provider], &[], 800, &config, 1).unwrap();
        assert!(lines("First").is_empty());
        assert_eq!(lines("Second"), [0, 1]);
        fs::write(&consumer, "window.published();\nwindow.published();\nwindow.published();\n").unwrap();
        overlay_update_graph_native(&ws.0, &[consumer], &[], 800, &config, 1).unwrap();
        assert_eq!(lines("Second"), [0, 1, 2]);
        compact_graph_overlay(&ws.0, 801, &config, 1).unwrap();
        assert_eq!(lines("Second"), [0, 1, 2]);
        assert!(lines("First").is_empty());
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
    fn jsx_unicode_text_before_parentheses_does_not_abort_usage_indexing() {
        let ws = Workspace::new();
        let config = EngineConfig::default();
        fs::write(ws.0.join("pkg/view.tsx"),
            "export function act() { return 1; }\nexport const View = () => (\n  <section>\n    説明 文字 (optional)\n    你好 🙂 (details)\n    {act()}\n  </section>\n);\nfunction probe(value) { return value.flag名前.test(); }\n").unwrap();
        rebuild_graph_native(&ws.0, 400, &config, 2, &mut |_| {}).unwrap();
        let target = query_graph_symbols(&ws.0, "act", 10, &config)
            .unwrap().unwrap().symbols.into_iter().find(|symbol| symbol.name == "act").unwrap();
        let result = query_graph(&ws.0, &target.id, 10, &config).unwrap().unwrap();
        assert_eq!(target.usage_count, Some(1));
        assert_eq!(result.total_references, 1);
        assert_eq!(result.references[0].start_line, 5);
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
