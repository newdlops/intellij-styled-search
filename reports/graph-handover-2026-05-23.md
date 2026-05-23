# Graph Work Handover - 2026-05-23

## Operating Rules

- Use codeidx MCP actively, but rediscover the MCP endpoint after every reconnect or transport recovery. MCP ports are ephemeral; do not reuse a cached port.
- Current observed MCP endpoint during this handover: `http://127.0.0.1:55637/mcp`. Treat this as informational only.
- Do not solve graph/index inference, reference resolution, pruning, usage counts, or tests with project-specific or corpus-specific overfitting.
- Validation projects such as `captain` are corpora only. Do not hardcode their package, file, class, method, field, or business-domain names into production code or tests.
- For accuracy validation, do not trust the graph to verify itself. Use `rg` or an external source of truth for audits.
- User priority for accuracy remains: `missing == 0`, `undercount == 0`; reduce overcount only through general rules.

## Current Goal

The recent work focused on graph UI visibility and graph query latency. The UI was not receiving useful native graph results, and graph query commands were slow because hot paths scanned large TSV files such as `callgraph-relations.tsv` and `callgraph-symbols.tsv`.

## Modified Files

Primary task files:

- `crates/zoek-rs/src/graph.rs`
- `src/callGraph.ts`
- `src/extension.ts`

Dirty files that appear unrelated or pre-existing:

- `.lh/.vscodeignore.json`
- `.lh/package.json.json`
- `.vscode/.auto-import-cache/index.bin`
- `.vscodeignore`

Do not revert unrelated dirty files unless explicitly asked.

## UI Result Fix

`src/callGraph.ts` now has rust-native reference edge conversion for callers/callees. It maps native graph references to UI `CallGraphEdge` values instead of relying only on legacy or provider edges.

`src/extension.ts` was adjusted so:

- graph implementation display uses resolved/native implementation results;
- `sym:<hash>` IDs are accepted as graph symbol IDs.

This was validated through the VS Code call graph E2E suite.

## Graph Storage Speedup

`crates/zoek-rs/src/graph.rs` graph storage version was bumped to `5`.

The old complete TSV files are still written and still work as fallback:

- `callgraph-symbols.tsv`
- `callgraph-relations.tsv`
- `callgraph-counts.tsv`

New sidecar shard families are written on rebuild:

- `callgraph-reference-targets-*.tsv`
- `callgraph-reference-enclosing-*.tsv`
- `callgraph-symbols-by-id-*.tsv`
- `callgraph-symbols-by-uri-*.tsv`
- `callgraph-counts-by-id-*.tsv`
- `callgraph-hierarchy-by-parent-*.tsv`
- `callgraph-methods-by-container-*.tsv`

Important behavior:

- Rebuild clears only known graph shard family files before writing new shards.
- Query commands prefer shard fast paths.
- If a shard family is unavailable, queries fall back to the legacy complete TSV path.
- This changes serving layout and query IO, not the semantic inference model.

## Fast Paths Added

Implemented or changed fast paths:

- `graph-query --symbol-id`: reads `callgraph-reference-targets-*` shard instead of scanning all relations.
- `graph-callees --symbol-id`: reads `callgraph-reference-enclosing-*` shard.
- `graph-symbol-query --query sym:<id>`: reads `callgraph-symbols-by-id-*` shard.
- `graph-symbol-query --uri <uri>`: reads `callgraph-symbols-by-uri-*` shard and count shards.
- `graph-implementations`: reads symbol-id, hierarchy-parent, and method-container shards before falling back to full symbol store.

Implementation lookup now avoids loading the full symbol store for the hot cases.

## Token-Shape Detail References

The token-shape likely baseline previously raised counts without always materializing matching detail references for UI panels. A bounded materialization path was added so likely fallback references can appear in detail panels.

Bound:

- `MAX_TOKEN_SHAPE_REFERENCE_FANOUT_PER_KEY = 512`

The fixture was kept generic. No captain domain terms should remain in the graph tests.

## Captain Validation Measurements

Validation command:

```sh
target/release/zoek-rs graph-rebuild /Users/lky/project/captain
```

Latest rebuild result:

- `fileCount`: `23897`
- `symbolCount`: `421286`
- `referenceCount`: `1334795`
- index bytes with sidecars: about `1.43GB`

Measured hot paths after rebuild:

- `graph-query` for `sym:098322d527940a0e`: about `0.01s`, `totalReferences=7`
- `graph-symbol-query --uri file:///Users/lky/project/captain/zuzu/db/models/company/payroll/wht/wht_certificate.py --limit 1`: about `0.03s`, `totalSymbols=52`
- `graph-implementations --symbol-id sym:a873c68ff9a50fe9`: about `0.01s`

Earlier measurements before the sidecar layout were roughly:

- `graph-query`: about `0.93s`
- document symbol query: about `0.85s`
- implementation query: about `0.92s`

## Verification Commands

Passed:

```sh
cargo build -p zoek-rs --release
cargo test -p zoek-rs graph::tests
env IJSS_E2E_FILES=out/test/suite/callGraph.test.js npm test
git diff --check
```

The VS Code call graph E2E result was `8 passing`. TypeScript server printed `No Project` warnings during the test run, but the test process exited with code `0`.

Known failing command:

```sh
cargo test -p zoek-rs
```

Failure:

- `searcher::tests::search_order_is_not_overridden_by_file_match_count_score`
- Location: `crates/zoek-rs/src/searcher.rs:1696`
- Failure message: `file match count score must not reorder broad search results ahead of rg-like candidate order`

This same search ordering failure existed before the graph shard work and appears unrelated to graph changes.

## Current Dirty Status

At handover time:

```text
 M .lh/.vscodeignore.json
 M .lh/package.json.json
 M .vscode/.auto-import-cache/index.bin
 M .vscodeignore
 M crates/zoek-rs/src/graph.rs
 M src/callGraph.ts
 M src/extension.ts
```

## Suggested Next Steps

1. Decide whether to fix the unrelated full-suite search ordering failure now or keep it as a separate task.
2. If continuing graph speed work, measure shard write cost and index size overhead on another mixed TS/JS/Python corpus.
3. If resuming accuracy work, run an `rg`-based census rather than graph-self-validation.
4. Keep `missing == 0` and `undercount == 0` as hard gates while improving exact rate.
5. Continue removing overcount only with general language/framework/type/import evidence, not project-name filters or corpus-derived keyword lists.
