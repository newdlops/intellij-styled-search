# HANDOVER — A2 v3 memory floor (incremental graph-update symbol re-architecture)

**Worktree:** `/Users/lky/project/ist-v3floors` · **branch:** `v3-ref-shard-scoping` (atop `8ba0108`)
Isolated from the main repo's auto-commit watcher — commit freely here.

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

## NEXT: S4 → S5 — the actual memory win (S3 done, each a2-gated)
**⚠️ S3 alone did NOT lower peak RSS (confirmed).** The full `symbols` Vec stays resident for hierarchy/
emit/counts/likely/symbol-write. RSS only drops once S4/S5 move ALL of those off the full table AND the
`read_symbols_excluding_paths_with_changed_keys` carry is dropped. Don't measure success until S5, and
measure with the STANDALONE binary (the a2 test's RSS is contaminated by its same-process full rebuild).

### S3 — DONE (`45fde00`). Lessons for S4/S5:
- Resolve does NOT read `extends_names`/`implements_names` (only `hierarchy_facts_from_symbols` does);
  in resolve, `hierarchy_facts` is used ONLY by `is_django_model_type`. So hierarchy structure is fully
  carried by the precomputed `hierarchy_facts` Vec regardless of which symbols resolve sees.
- `compute_native_counts` is a **no-op at captain scale** (`symbols.len() > MAX_EAGER_IMPLEMENTATION_SYMBOLS`
  → `apply_implementation_counts` skipped). So S4 need not re-home it for memory; it's free.
- `intermediate.counts` only needs to be right for emit (`counts[id].usage_must`, set by phase E on exact
  targets ⊆ candidates) — `usage_likely` is overwritten at the tail from the full reference set (line ~4080),
  and write_count drops all-zero entries. So shrinking resolve's symbol input is count-safe.

### S4/S5 — remove the remaining full-symbol scans (each a2-gated)
- Hierarchy: load from `callgraph-hierarchy-by-parent` sidecar instead of `hierarchy_facts_from_symbols`.
- emit_token_shape + scoped-likely: drive from queried/affected symbols (emit pass-1 builds recompute_set
  by scanning all symbols' (lang,scope,name_hash,id) — replace with a compact persisted (id,key,scope)
  pass or query). scoped-likely needs id→scope per ref target (query symbol-id shards or a compact map).
- `write_symbol_id_shards` + `write_resolve_index_shards`: make them streaming per-shard rewrites
  (read shard, drop changed-file symbols, add new, write) like the ref write — bounded memory.
- Finally DROP `read_symbols_excluding_paths_with_changed_keys` (the full carry). Now the 5GB Vec is gone.

## Verify / measure
```
cd /Users/lky/project/ist-v3floors
cargo build --release -p zoek-rs
cargo test -p zoek-rs --lib graph::tests                                    # unit (incl. S2 test)
cargo test -p zoek-rs --lib graph::tests::a2_stage_b_token_shape_matches_full_rebuild -- --ignored --nocapture
#   ^ ~6min, needs /Users/lky/project/captain2/captain; expect "extra=0 (non-ts 0), missing=0 (non-ts 0)"
# RSS + per-phase on the real corpus (captain):
BIN=/Users/lky/project/ist-v3floors/target/release/zoek-rs; WS=/Users/lky/project/captain
BUILT_AT=$(grep -oE '"builtAtUnixMs":[0-9]+' "$WS/.zoek-rs/callgraph-manifest.json" | grep -oE '[0-9]+')
ZOEK_FLOW_PROBE=1 /usr/bin/time -l "$BIN" graph-update "$WS" --built-at "$BUILT_AT" \
  --max-file-size 0 --workers 8 --exclude '**/.zoek-rs/**' --exclude '**/.codeidx/**' \
  --exclude '**/.vscode/**' --exclude '**/.lh/**' "$WS/zuzu/__init__.py" 2>&1 \
  | grep -E "rss_after_|maximum resident|real"
```
Baseline to beat: read_symbols 5.2GB, resolve +3.1GB, peak ~14GB. **Target after S5: peak ∝ affected files, not 5.2M symbols.**

## Gotchas
- captain `.zoek-rs` now has `callgraph-resolve-by-name-*` shards (additive, valid, built_at unchanged
  via `--built-at`); the running extension (old 0.1.707 binary) ignores them. No cleanup needed.
- a2 test reads `/tmp/a2_changed_file.txt` (a changed .py path) or falls back to first .py under captain2.
- Don't re-try allocators (mimalloc worse, jemalloc net-negative — both measured).
- Auto-commit watcher only touches the MAIN repo, never this worktree.
- Memory note: `project_v3_ref_shard_scoping` (loaded each session) has the condensed version.
```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
