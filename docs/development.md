# Runtime and development guide

## Runtime Notes

On first activation, the extension attempts to install a platform-specific ripgrep binary into VS Code's extension global storage. If that install fails or the platform is unsupported, it falls back to VS Code's bundled ripgrep when available, and finally to the JavaScript search path.

Zoekt indexes are kept fresh with incremental updates for VS Code create/save/delete/rename operations plus external filesystem create/change/delete events. A search drains queued updates before querying the index; unsaved editor buffers are reported as dirty overlay state because they are not yet durable index input. Symbol search also filters deleted/missing-file results before returning them and queues a semantic incremental update when stale symbols are observed.

Full Zoekt builds share a bounded worker pool for file reads, gram extraction and shard writes, including workspaces that fit in one shard. Saved-file updates share one flush and drain edits that arrive during an update before searching. Failed batches and temporary runtime/index preparation failures retain the affected paths for retry; if known changes cannot be drained, search verifies results with the live codesearch backend. Call graph full builds and compaction reuse the immutable file table and reference-shard metadata across count shards. Call graph edit bursts prepare summaries for changed open documents and load closed-file summaries only when requested, while invalidating cross-file usage counts after every successful update.

Usage-count construction also retains at most 32 MiB and 256 entries of immutable token-shape sidecar bytes for that build; evicted and oversized shards are read again. The cache ends with the build and is not shared across serving generations. External saved-file changes refresh usages even when the document is open. VS Code folder operations queue one graph refresh and one search-index sync; search sync reuses unchanged files. Explicit graph refreshes also drain changes retained by a background update after the window loses focus.

Search and call graph indexing check host-wide available memory before starting. While an isolated index process runs, sustained memory pressure is sampled and the process is stopped before it can exhaust the machine. Background full builds are deferred to a later trigger, while pending compactions and incremental batches retain their work and retry after pressure subsides; manual rebuilds report the available/required memory totals.

The codesearch trigram engine retains at most 16 MiB or 4,096 entries of clean disk-backed posting data. Evicted postings are read again when needed. Queries use posting sizes from the index metadata to intersect selective terms first and stop reading after the candidate set becomes empty. Reindexing keeps unchanged postings compact, and trigram extraction uses a three-character window. The read-cache limit does not cap mutable build data, query results, or the temporary full index image used during persistence.

Rust text search compiles each query term once and reuses it for indexed candidates, fallback candidates and streamed results. Parallel workers clone the compiled verifier once per worker to keep regex search caches independent. Match positions advance through each file using constant-sized state. Preview truncation examines at most 241 characters, preserves the existing 240-character output limit, and allocates the exact output byte length. These changes preserve Unicode columns, LF/CRLF matching, whole-word behavior, OR deduplication and pagination without retaining a global query cache.

Candidate selection keeps delta-decoded posting IDs as sorted arrays, removes duplicate IDs and intersects in place. It visits query grams in their original order so early termination, incomplete-index backfill and ranking stay unchanged. Selected documents are iterated directly from the rank map without allocating another document list.

Search requests share lazy path-glob matchers across base shards, overlays and fallback paths; query diagnostics use the same matcher preparation. A pattern is initialized only when reached by the existing include/exclude short-circuit order, and its regex search cache is reused for subsequent paths. Invalid patterns remain non-matching and are remembered only for that request. The bounded compiled-glob cache and the existing glob syntax are unchanged.

The tab-free bundled preview is the guaranteed path. It uses real file URIs, lazily reads the installed extensions' `contributes.languages`/`contributes.grammars` assets without activating those extensions, and relays VS Code language providers without opening an editor tab. TextMate grammar failures or safety-budget overruns fall back to Monaco's bundled tokenizer. When passive renderer capture is available, the preview may upgrade to VS Code's native editor services. Workspace language requests use the saved VS Code document snapshot, so a bundled preview pauses them while it has unsaved edits and resumes them after a successful save instead of showing stale ranges. If the overlay or preview fails after a VS Code update, reload the VS Code window and reopen `IntelliJ Search: Search`.

## Development

```bash
npm install
npm run compile
npm test
npm run bench:zoekt -- --files 10000,50000,100000
npm run bench:indexing -- --files 4000 --runs 3
npm run bench:trigram
npm run bench:verification -- --before /path/to/before/zoek-rs --after /path/to/after/zoek-rs --runs 5
```

`npm run bench:zoekt` saves a timestamped artifact plus `latest.json` under `artifacts/benchmarks/zoekt/`. The artifact includes the raw benchmark response, wall-clock runtime, git commit, Rust toolchain versions, and host metadata so repeated runs stay comparable.

`npm run bench:indexing` measures full builds, clean reuse, single-file and burst updates, duplicate events, renames, deletes, recreation and compaction in an isolated temporary workspace. It verifies text results and cross-file usage counts after each operation. Use `-- --binary /path/to/zoek-rs --output /tmp/indexing.json` to measure an earlier binary with the same workload; reports include binary hashes and individual timing samples. Fixture generation and correctness queries are excluded from timings; CLI startup is included.

`npm run bench:trigram` runs isolated synthetic extraction, selective-query, repeated-query, and unchanged-update workloads without accessing a workspace index. It reports elapsed time, posting reads, and retained heap/array-buffer memory after GC. Use `-- --output=/tmp/trigram.json` to save the report, or `-- --module=/path/to/earlier-bundle.cjs` to compare an earlier build on the same host. These are codesearch measurements, not end-to-end Rust engine timings.

`npm run bench:verification` compares text-search binaries in one isolated temporary workspace. It covers serial, parallel and streamed queries, include/exclude scopes and invalid globs, dense matches, long lines, multiline CRLF literals, late matches and no-match verification. Every run checks the complete response and streamed file events against the first binary, including ranges, previews, order and counts. Build both binaries with the same Cargo profile; paired runs alternate their execution order. Reports include individual wall-time samples and binary hashes. On macOS, `/usr/bin/time` also measures child wall time, CPU time and peak RSS; its times have 10 ms precision, and child wall time excludes starting the measurement wrapper itself. Other platforms report outer wall time only. The default report is `artifacts/benchmarks/search-verification.json`; use `--output /tmp/verification.json` to choose another path. CLI startup, file loading and JSON serialization are included; fixture creation and index construction are excluded. Run without other builds or tests for comparable timings.

## Desktop platform compatibility

The search overlay uses separate desktop adapters. Windows process discovery and inspector activation live in `src/platform/windows/`; macOS bundle discovery lives in `src/platform/darwin/`, with POSIX process operations in `src/platform/posix/`. The overlay only calls their shared interface. Windows discovery follows the local extension host's ancestors and checks the installation path, so portable installations and paths containing spaces or Unicode are supported without selecting another running editor.

Windows opens the Electron main inspector through Node's native debug hook. It does not require a Unix signal or a manually configured startup flag. Search commands account for the Windows command-line limit, and both the Rust graph and JavaScript graph worker serialize drive and UNC file paths with VS Code's URI identity. OS-specific Rust URI code lives under `crates/zoek-rs/src/platform/`.

Run `npm run compile`, `npm run test:unit`, and `cargo test --locked -p zoek-rs` for structural regression checks. After `npm run build:zoek-runtime`, `npm test` runs the actual desktop extension. The [desktop compatibility workflow](../.github/workflows/desktop-compatibility.yml) checks current macOS/Windows builds plus VS Code 1.114.0 on Windows, requires renderer attachment, exercises on-demand inspector activation, and saves rendered workbench screenshots at Chromium viewports of 1440×900, 1024×768, and 800×600 under `artifacts/desktop-compatibility/`.

After compiling, `npm run test:scope` launches and fully exits normal VS Code five times using one generated profile and two temporary workspaces. It verifies configured defaults, the remembered `**/*.vue,**/*.ts` scope, an explicitly cleared scope, project isolation, and actual filtered search results. Reports and rendered screenshots are saved under `artifacts/scope-persistence/`. This harness deliberately omits `--extensionTestsPath`, because VS Code uses in-memory storage in extension-test mode. CI runs it on macOS and both Windows versions, including the Windows standard-account UserSetup installations.

Full renderer functional checks remain required on shared CI runners. Hardware timing measurements, unchanged budgets, and any overruns are shown in the job summary and desktop artifact. Local renderer tests enforce those budgets by default. The workflow's `enforce_timings` input supports strict manual runs once the workflow is registered on the default branch. See [performance verification](../DEPLOY.md#local-verification) for the strict and report modes and current branch prerequisites.

Its Windows 11 job installs x64 UserSetup 1.114.0 and stable as a standard
account and verifies that the extension host actually runs without administrator
privileges. The host is ARM64, so these x64 application checks use Windows
emulation; they do not certify native ARM64 VS Code or native x64 Windows 11
hardware.

CI gates native tests, desktop acceptance, extension functional regressions, and the complete renderer suite, including save/recovery, repeated clicks and the existing hardware timing budgets. Timing samples are recorded in the CI log. Windows graph caches created before the URI correction require one rebuild; macOS graph cache versions are unchanged.

## Deployment

Deployment and release steps now live in [DEPLOY.md](../DEPLOY.md).

Short version:

- `vsce package` includes any staged `resources/bin/<platform-arch>/` tuples in a universal VSIX; a fresh checkout without tuples produces a lightweight package.
- Without a `resources/bin/<platform-arch>/` tuple it relies on the global Cargo cache and a one-time local Rust build per Rust-source revision.
- Run `npm run build:zoek-runtime` before packaging a self-contained host-platform VSIX; use the explicit target options in `DEPLOY.md` for cross-platform artifacts.
- The current universal desktop release bundles Windows x64 and Apple Silicon macOS runtimes in one Marketplace package.

Quick local package:

```bash
vsce package
```
