# Real project usage audit — 2026-10-07

Two real source trees were copied into isolated temporary workspaces. Existing
project files and indexes were not modified. Raw paths, symbol names, source
hashes and measurements stay in the ignored `artifacts/benchmarks/real-usage/`
directory; this report contains aggregate results.
The initial measurements below describe 0.1.7153. The 0.1.7154 follow-up uses
the same frozen source hashes and declarations and is recorded at the end.

## Dataset and count/list parity

| Source tree | Indexed files | Symbols | Stored references | Count/list mismatches |
| --- | ---: | ---: | ---: | ---: |
| Django / React / TypeScript monorepo | 23,097 | 355,831 | 754,809 | 0 |
| Django platform with JavaScript | 5,638 | 207,684 | 328,207 | 0 |

The audit checks every indexed symbol against the live deduplicated query union,
including conservative candidates. It does not establish semantic accuracy.
Source selection follows `rg --files --hidden` and excludes dependency, build,
cache and index directories. Seven redundant Python stubs were dropped in the
first tree. These are first-party source workloads, not dependency-inclusive
measurements of every file present on the original machines.

## Fixes found through the real workload

- Unicode text before parentheses and Unicode member receivers caused UTF-8
  boundary panics. Both reverse scans now use character boundaries. Regression
  cases cover JSX text, mixed identifiers, combining characters, non-identifier
  characters and the resulting indexed call.
- Computing UTF-16 positions rescanned a line prefix for each identifier.
  Ordered byte offsets now advance one UTF-16 cursor per line. Existing Unicode
  range and masked-literal tests verify the coordinates.
- Count materialization repeatedly loaded the same inheritance families across
  target shards. Builds and audits reuse those families within a locked graph
  generation. Retention is cleared at shard boundaries above 50,000 methods or
  65,536 containers; ordinary queries retain their own short-lived cache.
- Rebuild progress reported `done` before count materialization completed.
  Required counts now finish before the final progress event, and their elapsed
  time is included in the reported total.

| Source tree | Build before family reuse | Build after | Peak RSS before | Peak RSS after |
| --- | ---: | ---: | ---: | ---: |
| Monorepo | 101.34 s | 56.28 s | 2,304 MiB | 2,287 MiB |
| Django platform | 34.00 s | 31.65 s | 1,420 MiB | 1,382 MiB |

These are individual before/after runs with eight workers on macOS ARM64, not
statistical confidence intervals. All 128 monorepo count shards retain identical
record bytes; only their serving-generation headers differ after a rebuild.

Twenty first-page CLI probes per tree (40-reference limit, alphabetically
selected declarations) had p95 delivery times of 139.7 ms and 61.7 ms. Peak query
RSS was 34.8 MiB and 17.7 MiB. These figures include process startup and JSON
delivery after the build and audit. OS caches were not flushed, and these samples
do not represent every high-fanout declaration or UI paint latency.

The actual VS Code panel was also exercised in the 5,638-file snapshot with a
1,154-reference declaration. The first 40 rows became visible in 447 ms,
including 150 ms of CDP/workbench preparation (command-to-rendered-row delivery
was 297 ms). Three subsequent deliveries measured 860, 195 and 111 ms. A trusted
mouse click on More delivered 80 rows while preserving the 1,154 total. The
1440 × 900 rendered panel and preview were inspected separately from the tests.
The isolated workbench used explicit foreground scheduling; background/occluded
rendering delayed rows in an earlier harness run despite the data already being
delivered. These four deliveries are observations, not a UI latency percentile.

## Independent semantic samples and remaining inference gaps

Python 3.12 AST and symbol-table analysis supplied required locations for module
functions and explicit imports, with lexical shadowing checked independently of
the native resolver. TypeScript's language service supplied a separate sample
for TypeScript/JavaScript module functions.
Comprehension bindings are modelled explicitly so the oracle preserves their
isolation across Python 3.11 and [3.12's inlining](https://peps.python.org/pep-0709/).

| Oracle sample | Declarations | Required locations | Found |
| --- | ---: | ---: | ---: |
| Python monorepo | 20 | 4,141 | 4,024 |
| Python Django platform | 20 | 3,216 | 3,183 |
| TypeScript monorepo | 20 | 51 | 51 |
| JavaScript Django platform | 20 | 36 | 36 |

The Python sample exposes 150 missing required locations. Observed patterns
include expressions inside f-strings and calls assigned to tuple targets. Seven
returned occurrences have evidence for a different lexical binding: four are
currently labelled exact and three possible. Local assignments and generator
comprehension bindings are observed patterns. They were follow-up work at this
baseline; the 0.1.7154 results below verify their resolution independently of
count/list parity.

Thousands of dynamic, attribute and re-export occurrences remain unclassified.
The TypeScript audit does not copy external dependencies or project path aliases,
and excludes alias declaration entries from its required-reference set. This is
a sampled structural audit, not a whole-project precision/recall estimate or
coverage of every supported language and framework.

## macOS preview-click investigation

The existing request/render budgets remain 10 ms / 20 ms. A foreground run of
320 clicks completed every requested preview: request max 1 ms; render max 15 ms,
p95 4 ms. The previous hosted macOS 36 ms sample was not reproduced locally.
That does not prove its cause or guarantee the budget on shared hardware.

`IJSS_E2E_PREVIEW_CLICK_REPEATS=1..20` expands the existing 16-click probe. The
manual desktop workflow exposes the same repeat counts and retains its existing
strict/report modes. Changing repetition never changes the budgets or per-click
completion checks.

## Reproduction

```bash
python3 scripts/auditRealProjectUsage.py \
  --binary resources/bin/darwin-arm64/zoek-rs \
  --output artifacts/benchmarks/real-usage PROJECT_A PROJECT_B

python3.12 scripts/auditPythonUsageSemantics.py SNAPSHOT \
  --binary resources/bin/darwin-arm64/zoek-rs --output python-semantics.json

node scripts/auditTypeScriptUsageSemantics.js SNAPSHOT \
  resources/bin/darwin-arm64/zoek-rs typescript-semantics.json
```

The resource harness uses `/usr/bin/time` on macOS/Linux and keeps each frozen
snapshot for inspection. `--resume` reuses those snapshots. Oracle unit fixtures
are part of `npm run test:usage`.

The optional `realProjectUsage.test.js` extension test accepts
`IJSS_E2E_REAL_USAGE_CONTEXT`: a JSON path containing a frozen `workspace`, its
`sourceSha256`, an independently sampled `target` (`name`, `symbolId`,
`totalReferences`), and an artifact `output` directory. It requires at least
2,000 indexed files and over 40 references, runs the real public command, checks
rendered rows and trusted mouse paging, and captures the actual panel. It skips
in ordinary fixture CI so private project source is not uploaded.

## 0.1.7154 follow-up

The same Python 3.12 oracle and forty declarations now find all 7,357 required
locations (4,141 and 3,216), with zero returned occurrences proven to use a
different binding. All targets are fully enumerated and both trees have zero
parse errors. The initial 150 missing locations and seven other-binding
occurrences are resolved. An intermediate run exposed two additional local
named-expression bindings; those are also removed from unrelated function
usages in the final run.

The fixes retain executable f-string fields and nested format expressions,
assemble parenthesized/continued imports, and distinguish parameters, local
assignments, closures, lambdas, comprehensions and named expressions. Literal
examples and keyword argument labels no longer create declarations or usages.
Indexed local usages bind to their own declaration rather than being discarded.
Lexical evidence persists through the full, overlay and compaction paths.
Native graph/cache versions 14/22 on POSIX and 15/23 on Windows require one
reindex after upgrading.

| Same frozen source tree | Indexed files | Symbols | Stored references | Count/list mismatches |
| --- | ---: | ---: | ---: | ---: |
| Monorepo | 23,097 | 235,043 | 808,543 | 0 |
| Django platform | 5,638 | 163,201 | 408,468 | 0 |

The lower symbol totals reflect removal of declarations inferred from literal
examples and continued keyword arguments. The stored reference sets also
change because local bindings retain their legitimate references.

| Source tree | 0.1.7153 build | 0.1.7154 build | Peak RSS before | Peak RSS after |
| --- | ---: | ---: | ---: | ---: |
| Monorepo | 56.28 s | 36.49 s | 2,287 MiB | 2,208 MiB |
| Django platform | 31.65 s | 14.98 s | 1,382 MiB | 1,602 MiB |

These are individual runs, with no cache flush or statistical confidence claim.
The platform workload uses about 16% more peak memory despite its faster build;
this is a measured tradeoff, not a memory improvement. First-page CLI p95 was
41.0 ms and 40.2 ms under the original twenty-probe selection.

The actual 5,638-file panel was rebuilt and checked again at 1440 × 900.
Its audited declaration returns 1,151 references, including all 872 locations
required by the independent oracle. The first forty rows became visible in
257 ms including 118 ms preparation (139 ms from command to rendered rows);
repeat deliveries were 83, 76 and 178 ms. A trusted More click produced eighty
rows without changing the total. The screenshot was inspected separately:
the existing dense layout, selection and intended horizontal source scrolling
remain usable.

The original TypeScript and JavaScript twenty-declaration samples retain 51/51
and 36/36 required locations, with zero proven other bindings. Thousands of
dynamic, attribute and re-export occurrences still remain unclassified, so
these results do not establish whole-project precision/recall.

An exploratory JavaScript expansion inspected 311 declarations: 740 required
locations, 650 found, 81 enumerated missing usages and five declarations not
uniquely indexed (covering nine more locations). That expansion is separate
from the Python regression scope and needs a language-specific follow-up.
The audit now rejects a non-numeric sample limit instead of silently expanding
its selection.

The independent fixture gate includes f-string fields, explicit multi-line
imports, same-file local shadowing, named expressions and lambda isolation:
nineteen required locations are found, with zero proven other bindings, and all
41 indexed fixture symbols have count/list parity.

## JavaScript follow-up — before final binding cleanup

The expanded compiler audit now finds **740/740 required locations across all
311 declarations**, with zero missing declarations and zero returned locations
proven to bind to another function under the then-current function-definition
filter. Every target is fully enumerated. This
resolves the previously observed 81 missing usages and five declaration indexing
errors, including their nine additional required locations.

The fixes cover explicit import extensions, default/export aliases, cyclic
re-export propagation, assigned function expressions, lexical shadowing and
script-global exposure. Wrapper exports and global candidates retain MAY-only
confidence. The compiler sample's unclassified results increase from 54 to 372;
the broader conservative envelope prevents known misses but does not establish
precision for these additional candidates.

The same Python samples retain 7,357/7,357 required locations, zero proven other
bindings and zero parse errors. Their unclassified totals are 3,676 and 1,974.
The TypeScript sample retains 51/51 required locations and zero proven other
bindings, with three unclassified results. Definition entries are filtered by
the compiler oracle; reported import/export specifier references are included.

| Same frozen source tree | Indexed files | Symbols | Stored references | Count/list mismatches |
| --- | ---: | ---: | ---: | ---: |
| Monorepo | 23,097 | 235,043 | 740,360 | 0 |
| Django platform | 5,638 | 163,201 | 424,869 | 0 |

The macOS ARM64 candidate used for these measurements has SHA-256
`1dfe35d5398aedf9219c8bac72b39af11fce3b98f0fd56d238a9c72be5d52c59`.
One eight-worker run measured 36.22 s / 2,272 MiB and 14.62 s / 1,152 MiB.
The monorepo's single-run peak is slightly higher than its 0.1.7154 observation;
these single samples are not evidence of an improvement in both workloads.
First-page CLI p95 is 40.3 ms / 21.4 ms under the unchanged twenty-probe selection.

Two alternating runs of the exact published 0.1.7154 binary and the updated
release binary on the platform snapshot measured median peak RSS of
**1,471.2 MiB / 1,233.4 MiB**, a 16.2% reduction. Median build time was
17.87 s / 15.72 s. Deduplication compacts its existing reference array instead of
allocating a second full array. This is a paired observation with two samples
per binary, no cache flush and no statistical confidence interval.

New regression fixtures cover import/export specifier positions, default aliases,
cyclic re-exports, wrapper confidence, method-local variables, consumer edits,
export rebinding, pending provider facts and compaction. The independent fixture
gate finds 26/26 JavaScript and 19/19 Python locations, with zero proven other
bindings and count/list parity across all 54 indexed symbols. Native storage/cache
versions 15/23 on POSIX and 16/24 on Windows require one reindex.

Local checks pass 193 native tests (four existing opt-in tests remain ignored),
35 extension unit tests (two Windows-only skips), four build-cache tests and
185 extension functional tests (four pending). An initial combined run also
included renderer tests without the foreground timing policy and hit two hover
failures. That failed log is retained; renderer acceptance is checked separately
with the existing foreground policy and unchanged budgets.
A separate foreground run had one pointer-position failure in the hover probe.
The exact isolated probe then passed, followed by the complete foreground suite:
92 passed and four pending, with every recorded timing budget satisfied. The
first full-file inlay request was 11 ms (200 ms budget), and all five requests
returned the same complete 500-hint set. Both failed logs are retained; these
successful repetitions do not establish the cause of the intermittent hover
failure or the earlier shared-runner inlay delay.

The previously observed macOS shared-runner delay before provider entry remains
unresolved. No timing budget has been changed, and no whole-project semantic
accuracy claim is made.

## 0.1.7155 release validation

The final binding cleanup handles nested object/array patterns, curried arrow
closures, catch parameters and dollar-sign identifiers. A resolved import alias
does not also become a name-based candidate for an unrelated callable. Value
declaration names are checked independently as non-references; named function
expressions retain both their outer and internal compiler identities.

The final compiler sample finds **740/740 JavaScript locations across 311
declarations**, with zero missing declarations, zero proven other function
bindings and zero value declaration names reported as usages. All targets are
fully enumerated. **203 dynamic, parameter, property or unresolved candidates
remain unclassified**, compared with 372 before the final cleanup. This remains
a sampled audit, not a whole-project precision/recall claim.

Python 3.12 AST/symtable checks retain **7,357/7,357** required locations, zero
proven other bindings and zero parse errors across 16,612 files. The TypeScript
sample retains **51/51**, zero proven errors and three unclassified locations.

| Same frozen source tree | Indexed files | Symbols | Stored references | Count/list mismatches |
| --- | ---: | ---: | ---: | ---: |
| Monorepo | 23,097 | 235,071 | 725,933 | 0 |
| Django platform | 5,638 | 163,710 | 427,600 | 0 |

All **398,781** symbols have live count/list parity. The final macOS ARM64
`zoek-rs` SHA-256 is
`d2bf4745bdccc13a3d9e080adb017758f7baab4860009247d8c936315d0174fc`.
Both packaged runtime pairs use Rust-source fingerprint
`9dd6c85c07fc5ef7c37e80b2`. Native graph/cache versions are **16/24 on POSIX and
17/25 on Windows**, requiring one reindex from 0.1.7154.

The independent fixture gate finds 32/32 JavaScript and 19/19 Python locations,
with zero proven errors and count/list parity across 70 symbols. Local native
checks pass 194 tests (four existing opt-in tests ignored). Extension unit and
build-cache checks pass 35 and four tests respectively; two Windows-only unit
checks are skipped locally.

Bundled preview selection and the trusted-pointer hover probe now use immediate
scrolling. The full local foreground renderer suite passes 92 tests with four
existing pending cases, including exact hover position and dismissal. All local
strict timing checks pass; preview request/render maxima are 0/7 ms. A prior
combined build/test run hit repeated CDP timeouts and was stopped; its log is
retained. The successful isolated run does not prove the cause of those timeouts.

[Release implementation CI](https://github.com/newdlops/intellij-styled-search/actions/runs/37639792665)
uses the same required desktop checks and unchanged timing budgets. In its
macOS shared-runner report, preview render p95 is 6 ms but one sample is 29 ms
(20 ms budget); native preview after hide/show is 71 ms (50 ms budget). These
overruns remain visible and are not classified as resolved performance issues.

The initial Windows 11 standard-account UserSetup job failed: the independent
PowerShell account probe exceeded its 30-second limit, and main-process discovery
failed before a later diagnostic CIM snapshot succeeded. Four native/path/search
checks passed in that job. Its failure logs and attachment diagnostics are
retained. The preceding implementation run passed the same account test; a fresh
acceptance result is required before publishing this release.
