# HANDOVER — A2 v3 memory floor (incremental graph-update symbol re-architecture)

**Worktree:** `/Users/lky/project/ist-v3floors` · **branch:** `v3-ref-shard-scoping`
**S1–S6 DONE + gated** (`9b4d33b` S1, `6b571be` S2–S4, `e5ee7bf` S5, `53c1752` S6, atop `8ba0108`).
Isolated from the main repo's auto-commit watcher — commit freely here.

## STATUS (2026-06-02): full-symbol carry DROPPED — byte-identical, ~3GB RSS saved
The incremental update no longer materializes the ~5M-symbol (~5GB) table. The
`read_symbols` 5GB phase is gone; a ~1.4GB compact-sidecar load replaces it.
a2 refs extra=0/missing=0; s4_s5 record-set parity across all six write families.

**Measured (standalone S6 binary, captain2 = 135,662 files / 4.97M symbols /
16.3M ref_sites / 18.9M refs):**

| run | wall | peak RSS |
|---|---|---|
| full rebuild (`graph-rebuild`) | 67.0s | **14.0 GiB** (15,059,156,992 B) |
| incremental (`graph-update`, 1 file) | 27.1s | **15.25 GiB** (16,376,545,280 B) |
| incremental, S1-era binary (same corpus, pre-carry-drop) | ~25s | **18.1 GiB** |

So S6 cut the incremental peak **18.1 → 15.25 GiB** (the carry). **BUT the headline
finding stands out: the incremental peak (15.25 GiB) is still slightly ABOVE the
FULL rebuild (14.0 GiB)** — editing one file costs as much memory as rebuilding all
135K. **The stampede risk is NOT resolved by S4–S6** — per-edit RSS is still ~flat,
not ∝ edit size. As the S3 checkpoint predicted, S4–S6 only remove the symbols
floor; the remaining ~15GB is dominated by floors this work did NOT touch:
`ref_sites` (~4.7GB, 16.3M-site Vec — the deferred streaming step), the 1.2M-symbol
resolve-candidate set + its in-RAM resolve indices, and the resident compact
(~1.4GB, mostly duplicated `rel_path` strings). Why incremental > full: the full
rebuild STREAMS refs (never all-resident) while the incremental holds the affected
shards' `ref_sites` (4.7GB) + candidates + compact AND streams the prior-ref set.
Next wins (separate, larger, the real fix for the stampede): **(a) ref_sites
columnar/streaming into resolve** (the single biggest remaining floor — and what
makes per-edit ∝ edit size), **(b) compact `rel_path` interning** (file-id index,
~halves the 1.4GB), **(c)** shrink the resolve candidate set.

## Problem (why this work exists)
Incremental graph-update (`update_graph_native`) on the captain corpus (137K files, 5.2M symbols,
~20M refs, 7GB store) costs ~14GB peak RSS + ~26–37s **per edit, regardless of edit size** →
sequential edits stampede and ~crash the machine. Measured root cause (per-phase `getrusage`,
`ZOEK_FLOW_PROBE=1`): **the full `Vec<GraphSymbol>` (5.2M, ~5GB, resident the whole call) + the
resolve index built over it (~3GB)** — NOT references, NOT the allocator (mimalloc worse; jemalloc
−15% RSS but +40s sys CPU → reverted). Fix = stop loading all symbols; resolve from a persisted
name-index, loading only candidate symbols.

## Commits so far (all verified)
- `02d5c49` ref-write streaming: incremental no longer materializes the ~20M-ref Vec; streams like
  the full rebuild. **byte-identical** (`a2_stage_b_token_shape_matches_full_rebuild` extra=0/missing=0,
  14.3M refs), 37→26s. Added `partition_prior_references_streaming`, `accumulate_scoped_likely`,
  per-phase RSS probes (ZOEK_FLOW_PROBE-gated). (Did NOT lower RSS — refs weren't the constraint.)
- `3aab862` **S1**: `callgraph-resolve-by-name` shard family. Same record as by-id shards
  (`serialize_symbol_binary`) but sharded by `shard_index_for_key(symbol.name)`. Written in
  `write_graph_shards` (full + incremental, parallel, no added wall). 128 shards verified on captain.
- `c05ee3f` **S2**: `load_resolve_candidates(name_hashes)` — reads only the name-shards the requested
  hashes map to (`shard = name_hash % 128`), one at a time → transient ~1 shard, resident = candidates.
  Unit test `s2_load_resolve_candidates_matches_full_name_filter` green.
- `45fde00` **S3** (lazy resolve, **byte-identical**): `build_resolve_candidate_symbols` builds the slim
  subset resolve runs over (affected files' OWN symbols from the still-resident full Vec — covers
  `symbols_by_id` self/cls + same-file resolution — ∪ cross-file targets via `load_resolve_candidates`,
  minus stale changed-file copies). Seed = each affected site's `name_hash` + `receiver_name_hash`
  (the sketch omitted the receiver — it feeds `types_by_name[receiver]`/import/type-fact lookups) + the
  affected files' import/type/return-fact names. **No parent-type BFS**: resolve never reads
  `extends_names`/`implements_names` off a symbol (only `hierarchy_facts_from_symbols` does, over the full
  table); `hierarchy_facts` is used in resolve ONLY for Django filtering; inherited members resolve via
  the by-(lang,name) fallback keyed on the already-seeded site name. Gate extra=0 missing=0 (14,372,638
  refs, converter.py edit). candidate n=1.1M vs 4.1M full carried. Opt-out `ZOEK_V3_LAZY_RESOLVE_OFF`;
  falls back to full symbols if resolve-index shards absent. **Peak RSS unchanged** (as predicted).

## Key locations (current lines; grep to refresh after edits)
- `update_graph_native` 3447 — incremental driver. Full symbols loaded via
  `read_symbols_excluding_paths_with_changed_keys` (2046). Resolve called inside (~3500).
- `resolve_ref_sites_a_to_e` 6961 — **THE blocker**: builds 9 in-RAM indices over ALL symbols
  (bare/by-name, by-(lang,name), members-by-(container,name), by-(file,name), by-id, types-by-name,
  same_file_bare_count) unconditionally — `affected_indices` only scopes which SITES resolve, not the
  index build. Fields read: id, name(_hash), language(_id), rel_path(_hash), container_name, kind(_flags),
  qualified_name, extends_names, implements_names.
- `load_resolve_candidates` 13352 (S2 reader) · `write_resolve_index_shards` 11388 (S1 writer).
- Other full-symbol consumers (must be handled in S4/S5): `hierarchy_facts_from_symbols` 5141,
  `emit_token_shape_refs_from_tally` 1154, `compute_native_counts` 10346 (NO-OP >25K symbols, so
  not a concern at scale), scoped-likely (inline in update_graph_native tail via `accumulate_scoped_likely`
  9938), `write_symbol_id_shards` 11364. Hierarchy sidecar already exists:
  `GRAPH_HIERARCHY_PARENT_SHARD_PREFIX` 224 (`callgraph-hierarchy-by-parent`) — written by full rebuild,
  recomputed (not loaded) incrementally.

## DONE: S1–S6 (each a2-gated; the carry is gone)
Two new file-sharded sidecars + an incremental rewrite for every symbol-keyed
write family replaced the full-table carry. Key code (all in `graph.rs`):
- **S1 `callgraph-symbols-compact-by-file`** — `CompactSym` {rel_path,file_id,id,
  id_u64,name,name_hash,lang_hash,kind_id}; `write_symbol_compact_shards` +
  `load_symbol_compact`; generic `write_file_sharded_symbols`.
- **S2 `callgraph-hierarchy-facts-by-file`** — faithful {file_id,relation,child_qn,
  parent} (keeps the relation the lossy `…-by-parent` query sidecar drops);
  `write_hierarchy_facts_shards` + `load_hierarchy_facts_from_sidecar`.
- **S3** — `update_graph_native` reconstructs `Vec<HierarchyFact>` for resolve from
  the S2 sidecar (prior − changed + fresh) — no full scan.
- **S4** — `emit_token_shape_refs_from_tally` takes `&[CompactSym]`;
  `accumulate_scoped_likely`/`scope_by_target`/usage/calls re-keyed to id_u64;
  usage_likely application extracted to `apply_scoped_likely_to_counts` (no scan).
  Gated by unit test `s4_scoped_likely_matches_reference_impl` (counts are NOT
  full↔incr identical — incremental skips global usage_may by design).
- **S5** — `rewrite_shards_incremental` (read-shard-drop-add) + incremental
  variants for symbol-id/resolve-index (DROP by file via `rel_path∈exclude`) and
  hierarchy-by-parent/methods-by-container (DROP by `symbol.id∈prior_ids`). Plumbed
  via `IncrementalSymbolWrite {changed_symbols, exclude_paths, prior_ids}`.
- **S6** — `read_symbols_excluding_paths_with_changed_keys` DELETED. The compact
  load supplies prior changed-keys + prior_ids; `changed_full_symbols` is the ADD
  set; resolve candidates = fresh changed + per-file importer read
  (`read_symbols_for_paths`); compact + hierarchy-facts writes also go incremental;
  `write_store` gained `symbol_count_override`; `sidecars_ready` now requires the
  two new families (older index → full rebuild writes them). `lazy_resolve_enabled`
  + the full-symbol resolve fallback removed (lazy resolve is the only path).

Lessons retained: resolve reads `hierarchy_facts` only via `is_django_model_type`
(order-independent closure). `compute_native_counts` is a no-op at captain scale
(passed `&[]` at S6). `usage_likely` is overwritten at the tail; counts are
incremental-approximate (only refs are the byte-identity gate).

## Verify / measure
```
cd /Users/lky/project/ist-v3floors
cargo build --release -p zoek-rs       # MUST rebuild the BIN before any RSS run — the
                                        # a2/s4_s5 gates use a separate `cargo test` binary,
                                        # so target/release/zoek-rs can be stale (this bit me:
                                        # a stale-binary RSS run showed the OLD carry path).
cargo test -p zoek-rs --lib graph::tests            # unit (s1/s2/s4 round-trip + equivalence)
cargo test -p zoek-rs --lib graph::tests::a2_stage_b_token_shape_matches_full_rebuild -- --ignored --nocapture
#   ^ ~70s, needs /Users/lky/project/captain2/captain; expect "extra=0 (non-ts 0), missing=0 (non-ts 0)"
cargo test -p zoek-rs --lib graph::tests::s4_s5_sidecars_match_full_rebuild -- --ignored --nocapture
#   ^ asserts record-set parity full↔incr across ALL SIX symbol-keyed write families.
# RSS + per-phase, STANDALONE binary on captain2 (rebuild first so the new sidecars exist):
BIN=/Users/lky/project/ist-v3floors/target/release/zoek-rs; WS=/Users/lky/project/captain2/captain
"$BIN" graph-rebuild "$WS" --max-file-size 0 --workers 8 --exclude '**/.zoek-rs/**' --exclude '**/.codeidx/**' --exclude '**/.vscode/**' --exclude '**/.lh/**' >/dev/null 2>&1
BUILT_AT=$(grep -oE '"builtAtUnixMs":[0-9]+' "$WS/.zoek-rs/callgraph-manifest.json" | grep -oE '[0-9]+')
ZOEK_FLOW_PROBE=1 /usr/bin/time -l "$BIN" graph-update "$WS" --built-at "$BUILT_AT" \
  --max-file-size 0 --workers 8 --exclude '**/.zoek-rs/**' --exclude '**/.codeidx/**' \
  --exclude '**/.vscode/**' --exclude '**/.lh/**' "$WS/services/document_converter/v2/converter.py" 2>&1 \
  | grep -E "rss_after_|maximum resident|real|load_compact|resolve_candidates"
```
**Measured S6 (captain2, 4.97M symbols, 16.3M ref_sites):** full rebuild 67.0s /
**14.0 GiB**; incremental (1 file) 27.1s / **15.25 GiB** (no `read_symbols` phase;
`load_compact`=1.4GB; `rss_after_resolve_candidates`=11.6GB; `stream_write`=13.55GB).
Incremental peak is STILL slightly above the full rebuild — per-edit RSS is not yet
∝ edit size (see STATUS). Carry (`read_symbols` 5GB) gone; S1-era was 18.1 GiB.

**⚠️ Remaining floor — `ref_sites` ~4.7GB (the deferred step).** The slim ref-site read
still materializes a `Vec<RefSite>` of every site in the affected SHARDS (converter.py
hit 47/128 ⇒ **n=16,309,778 sites** ≈ 4.7GB). S4–S6 only removed the symbols floor; the
"∝ affected files" target needs a SEPARATE ref_sites columnar/streaming step (resolve
consuming sites streamed). Also resident at peak: 1.2M-symbol resolve candidates + their
in-RAM indices, and compact ~1.4GB (mostly duplicated `rel_path` — intern to ~halve).

## Gotchas
- **Rebuild the BIN (`cargo build --release`) before RSS runs** — gates use a separate test binary.
- captain2 `.zoek-rs` now also has `callgraph-symbols-compact-by-file-*` + `callgraph-hierarchy-facts-by-file-*`
  (additive). The running extension (old binary) ignores them. `sidecars_ready` now REQUIRES them, so an
  index built by an old binary triggers a full rebuild (which writes them) on the next graph-update.
- a2 test reads `/tmp/a2_changed_file.txt` (a changed .py path) or falls back to first .py under captain2.
- Don't re-try allocators (mimalloc worse, jemalloc net-negative — both measured).
- Auto-commit watcher only touches the MAIN repo, never this worktree.
- Perf note: S6 trades IO/CPU for RAM — symbol-id/resolve-index incremental writes re-read all 128 shards
  (drop-add); compact is read for emit AND re-read during its write. Optimize later if the probe shows it hot.
- Memory note: `project_v3_ref_shard_scoping` (loaded each session) has the condensed version.
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
