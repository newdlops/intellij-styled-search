# Usage counts and result delivery

The usage hint counts distinct source occurrences for the requested declaration,
including conservative candidates. Confirmed references and candidates must stay
distinguishable. Counts, the audit, and Find Usages use the same occurrence key and
candidate eligibility rules; textual name frequency is only a diagnostic signal.

Implementation and acceptance checks:

1. Materialize deduplicated usage counts during graph builds and updates. Count
   queries read those counts; compatible indexes missing a count sidecar retain
   the reference-based fallback. The storage migration requires one rebuild.
   Verify count/list parity across rebuilds, repeated edits, deletion, compaction,
   name collisions, aliases, shadowing, and Unicode identifiers.
2. Audit the live query result, including overlay and lazy candidates. Keep the
   independent semantic fixture expectations separate from count/list parity.
   Report lexical frequency without calling it precision or recall.
3. Show indexed usage results before source/provider refinement completes. Bound
   and invalidate refinement caches by graph generation, source changes, and
   document versions. Late updates must preserve preview, focus, sibling panels,
   and closed panels.
4. Preserve total count and page metadata. Load subsequent usage pages through
   the existing result-list scrolling interaction and an accessible More button.
   Report partial results and
   loading/error states without silently increasing the configured page size.

The existing panel layout, theme tokens, candidate toggle, keyboard navigation,
and preview are retained. Functional tests and rendered panel checks are separate
requirements. Dense results, narrow desktop windows, empty results, a closed
panel, and out-of-order asynchronous completions are part of UI acceptance.

Run `npm run compile`, `npm run test:unit`, `cargo test --locked -p zoek-rs`,
`npm run build:zoek-runtime`, and `npm run test:usage`. The semantic check runs in
desktop CI on macOS and Windows. The `usagePresentation.test.js` extension suite
checks ordinary mouse/keyboard input, delayed refinement, selection and preview
preservation, page failure/retry, candidate toggling, closed panels, siblings,
and three desktop viewport sizes. `npm run bench:usage --
resources/bin/darwin-arm64/zoek-rs` compares materialized counts with the scan
fallback in an isolated 1,000-symbol workload.

Pages carry a serving generation plus an overlay revision. A rebuild/update or
compaction changes the base generation even when the extension's builtAt cookie
is preserved. A stale continuation refreshes the first page instead of mixing
occurrences from different index states.

Tokenization uses [Unicode XID](https://docs.rs/unicode-ident/latest/unicode_ident/).
Reference ranges use UTF-16 columns, including after masking Unicode literals.
The [Python identifier rules](https://docs.python.org/3/reference/lexical_analysis.html#names-identifiers-and-keywords)
are the language reference for the Unicode fixture.

Python parameter declarations and their lexical value uses are excluded from
unrelated same-name candidates. Header defaults and annotations stay in their
enclosing scope; nested functions capture parameters unless an explicit global
redirects lookup. Member names remain independent. Indexed local redefinitions
retain conservative resolver handling. Lambda/comprehension bindings and complete
local assignment scope resolution remain separate work. This follows the
[Python name binding rules](https://docs.python.org/3/reference/executionmodel.html#resolution-of-names).
The semantic oracle checks forbidden locations across every confidence level and
required locations before applying its confirmed/call filters, so possible
candidates cannot hide false positives or missing default references.

Name lookup scans borrowed binary name fields and decodes matching symbols only.
It preserves substring matches, ranking and total count, then reads count shards
only for the returned symbols. Metadata-only requests skip count I/O. The native
tests corrupt unrelated/disabled count shards to enforce this boundary; binary
reader equivalence checks cover inline IDs, unknown metadata and ASCII casing.
For a larger controlled workload, run `npm run bench:usage -- BINARY 10000`:
sources are split below the engine's file size limit, with single, 40-symbol page,
and full batch queries checked against independent per-symbol count expectations.

Local macOS arm64 validation (2026-10-07): the independent fixture removed all
11 forbidden parameter/closure occurrences found by the previous binary while
retaining the required defaults. All four semantic targets pass; the live audit
has no count/list mismatches across 18 symbols. Full native and extension unit
tests plus targeted binding/binary-reader regressions pass. These local checks
exclude Windows; releases also require the Windows desktop CI checks.

Alternating the previous and packaged binaries for 20 warmed samples each in the
10,000-symbol / 120,000-reference workload produced these CLI p50 results:

| Query | Previous | Updated |
| --- | ---: | ---: |
| Single symbol | 36.52 ms | 20.78 ms |
| 40-symbol page | 47.95 ms | 36.12 ms |
| All 10,000 symbols | 116.99 ms | 115.68 ms |

The full batch is effectively unchanged. These figures measure query delivery,
including process startup and JSON serialization; they do not establish rebuild
throughput or precision/recall on arbitrary projects. Raw samples and binary
hashes are in `artifacts/benchmarks/usage-query-paired-comparison.json`; the local
reproduction script is `node scripts/compareUsageQueries.js BEFORE AFTER`.
