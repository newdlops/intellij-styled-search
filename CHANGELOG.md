# Changelog

## Unreleased

- Resolved JavaScript/TypeScript imports with explicit source extensions, default export aliases and cyclic re-export chains.
- Indexed assigned function expressions under their outer binding, and kept parameters, closures, block bindings and method-local variables in their lexical scopes.
- Retained conservative candidates for script globals, explicit global-object assignments and callable inputs to export wrappers; these candidates are not promoted to exact references.
- Persisted import/export and type evidence in pending overlays, refreshed dependent consumers when bindings change, and preserved edited symbols during later consumer refreshes.
- Added an independent TypeScript compiler reference gate to the semantic fixture checks on macOS and Windows.
- Removed a second full reference array during occurrence deduplication, reducing peak memory in the measured platform workload.
- Native graph/cache versions are now 15/23 on POSIX and 16/24 on Windows and require one reindex.

## 0.1.7154 - 2026-10-07

- Indexed executable f-string expressions, nested fields and dynamic format specifications while preserving UTF-16 reference positions and excluding literal text.
- Resolved parenthesized and continued Python imports, and excluded docstring examples and keyword argument labels from declarations and usages.
- Kept Python local assignments, named expressions, closures, lambda parameters and comprehension bindings in their lexical scopes; indexed local usages no longer become candidates for unrelated module symbols.
- Persisted lexical binding metadata across rebuilds, edits and compaction. Native graph/cache versions are now 14/22 on POSIX and 15/23 on Windows and require one reindex.
- Added an independent semantic audit gate and opt-in cold-inlay CPU profiling to desktop CI.

- Fixed UTF-8 boundary panics in Unicode trailing identifiers and member receivers, including JSX text, and counted UTF-16 positions with one forward cursor per line.
- Reused bounded inheritance-family lookups across usage count shards while preserving count records, and reported rebuild completion only after required counts finish.
- Added isolated real-project usage resource and independent Python/TypeScript semantic audits, plus an opt-in real-workspace panel delivery test.
- Added repeatable preview-click timing probes without changing existing budgets.
- Updated development test tooling to remove all audited dependency vulnerabilities; Node 22.12+ is required for development tests. The default/release branch is now main2, with main retained as historical reference.

## 0.1.7153 - 2026-10-07

- Made usage hints count the distinct references returned by Find Usages, including conservative candidates, across rebuilds, edits, deletions and compaction. Materialized count shards avoid repeated reference scans.
- Displayed indexed usages before source/provider refinement, and bounded refinement reuse by source and graph versions.
- Added usage paging through scrolling and an accessible More button, preserving selection, focus, preview and panel ownership. Stale continuation pages refresh from the current index generation.
- Excluded Python parameter declarations and captured parameter uses from unrelated same-name usages while preserving header defaults, annotations, explicit globals and member references.
- Used Unicode identifier boundaries and UTF-16 reference columns, including after Unicode strings. Filtered binary symbol names before decoding metadata and read counts only for returned symbols.
- Added independent semantic reference expectations and live count/list parity checks to macOS/Windows CI. Graph cache v20 / native v12 on POSIX and cache v21 / native v13 on Windows require one reindex.

## 0.1.7152 - 2026-10-06

- Shared the search stylesheet across panel instances and removed exact legacy duplicates so repeated panel opens do not accumulate CSS rules.
- Reused the preview editor's current layout when its viewport dimensions have not changed.
- Reused clean isolated native-preview models for the same source and language, avoiding model replacement on repeated result selection while keeping workbench models and edited models outside that path.
- Kept full renderer functional checks required on shared CI runners while preserving hardware timing measurements and budget overruns in job summaries and artifacts. Local tests and opt-in strict workflow runs enforce the unchanged timing budgets.
- Routed asynchronous usage results to the panel created by their own click and discarded results after that panel closed, preserving sibling panels and focus.
- Removed the extra passive capture dwell when a preview has an explicitly enabled transient-editor fallback.
- Prepared durable inlay commands from available graph metadata before notifying the workbench, keeping large first-time hint requests out of the command-registration backlog.
- Ignored late events from replaced CDP sockets so they cannot close a newer connection or cancel its requests.
- Kept main-process event forwarding independent of inspector-session native bindings during reconnects.
- Created and displayed spawned result panels in one renderer call to remove an extra round trip from inlay clicks.
- Kept each renderer click's source window and preview intent through asynchronous command dispatch, and allowed an immediately repeated completed inlay action to run again.
- Used current rendered inlay metadata before requesting providers again; retained label-based recovery for recycled view lines.
- Removed repeated full theme-token copies from preview switching and separated computed-style reads from writes while preserving theme-change observers.
- Preserved the executable identity expected by Node launcher shims when starting the JavaScript graph worker.
- Added Windows 11 x64 UserSetup acceptance under a standard account on the Windows ARM64 runner, with x64 application emulation recorded explicitly.
- Made the complete renderer suite required after the macOS and both Windows desktop configurations passed the existing timing budgets.
- Measured required interactive timing budgets with foreground scheduling in the isolated CI workbench and recorded the window policy separately from optional CPU profiling.

## 0.1.7151 - 2026-10-06

- Added an isolated Windows desktop adapter for Electron process discovery and on-demand inspector activation; preserved the macOS bundle fast path.
- Bounded ripgrep candidate arguments by the Windows command-line limit and corrected drive/UNC file URI identity in native and JavaScript graph indexes.
- Made literal snippets match LF and CRLF files consistently while retaining indentation, punctuation, candidate narrowing, and multiline highlight ranges.
- Normalized ripgrep file-list paths before removing current-directory prefixes so Windows index identities and exclusions agree.
- Preserved newer client-side query narrowing when a base search start notification arrives late.
- Serialized concurrent graph writers with OS locks on Windows as well as POSIX systems.
- Read Windows file IDs and independent change timestamps for safe unchanged-index reuse and incremental sync, including edits that restore modification times.
- Invalidated old Windows graph URI caches while retaining existing macOS caches, and packaged Windows runtimes with a static C runtime.
- Added macOS/Windows desktop CI with native runtime builds, required renderer checks, and workbench screenshots.

## 0.1.7150 - 2026-10-01

- Sped up full call graph rebuilds by about a quarter on a 27K-file workspace: Django model ancestry is computed once per resolve, source discovery makes fewer file-system calls on a small walker pool, and the outgoing usage tally is built in parallel. Index contents are unchanged, so no reindex is needed.
- Made per-file symbol summaries for inline usage hints decode only the requested file's records and load each class's implementation family once per query. Typical files answer in under 0.2s with about a quarter of the memory, and large library modules that hit the 3s query timeout now complete.
- Paced call graph overlay compaction by its measured cost (about 1/20 of wall time, with at most 10 minutes of idle wait), while still compacting 12s after edits once the overlay reaches 64 files or 16 MiB.
- Removed retired call graph files and superseded edit overlays during full rebuilds, and rejected stale overlays without reading them.
- Skipped common binary image, media, model-weight, compiled-module, archive and database formats by extension in the search index. The next index run rebuilds once to apply this.

## 0.1.7149 - 2026-09-07

- Resolved member usages by declaring class ID so unrelated classes with the same name no longer lose exact references or share inferred member targets.
- Followed import aliases and module-qualified receiver types in Python and TypeScript, including nested classes and Python `Self` annotations.
- Updated exact usage counts after edits without promoting possible references, and refreshed the base contribution tally after incremental updates and compaction.
- Added regression coverage for ambiguous declarations, unresolved namespaces, count/reference consistency, and successive index updates. Graph cache v17 / native graph v9 requires one reindex to replace older inferred links and count tallies.

## 0.1.7148 - 2026-09-07

- Bounded the codesearch disk-posting read cache to 16 MiB and 4,096 entries while preserving search results after eviction.
- Used posting-size metadata to evaluate selective search terms first and avoid unnecessary disk reads after an empty intersection.
- Kept unchanged trigram postings compact during file updates and removed the file-sized temporary array from trigram extraction.
- Added regression coverage for Unicode compatibility, cache eviction, incremental updates, persistence, and query semantics, plus an isolated resource benchmark.

## 0.1.7147 - 2026-09-02

- Added host-memory pressure gates and cancellation for codesearch and zoek-rs indexing work.
- Bounded generated global storage, retained active and rollback runtimes/indexes, and coordinated cleanup safely across VS Code windows.
- Removed obsolete Cargo targets, abandoned runtime stages, and inactive trigram caches through strict generated-artifact allowlists and age gates.
- Updated the shipped WebSocket runtime and build tooling to remove known runtime and bundler advisories.

- Restored VS Code hover, completions, signature help, navigation, symbols, folding, diagnostics, and semantic tokens in the tab-free bundled Monaco preview.
- Bound bundled preview models to their real file URIs and kept lexical syntax tokenization without loading Monaco's duplicate language workers.
- Added a lazy TextMate/Oniguruma bridge for installed VS Code extension grammars, including multiline state, external includes, injection grammars, opaque asset IDs, payload chunking, and Monarch fallback.
- Made bundled hover stream immediate TextMate lexical scopes, cached VS Code semantic-token classification, and range-safe language-provider documentation without duplicate same-word LSP requests.
- Added clean, viewport-preserving bundled-to-native preview recovery without requiring another preview event, while retaining bundled Monaco across failed native mounts and unsaved edits.
- Retried tab-free passive native capture after cold misses and rejected retained renderer bridges that point at a stale extension host.
- Synchronized the preview language-feature flag across retained renderer patches so bundled hover and completions cannot remain disabled after a settings or extension-host transition.

## 0.0.1 - 2026-04-19

Initial public release.

- Added an IntelliJ-style project search overlay for VS Code.
- Added selected-text project search and editor context-menu integration.
- Added streamed ripgrep search with trigram-index candidate narrowing.
- Added editable Monaco preview support with hover and IntelliSense behavior when renderer capture is available.
- Added fallback preview and JavaScript search paths for recovery cases.
- Added first-activation ripgrep setup in extension global storage.
- Added recovery and diagnostics commands for renderer patching and index inspection.
