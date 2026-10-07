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
