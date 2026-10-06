# Changelog

## 0.1.7151 - 2026-10-06

- Added an isolated Windows desktop adapter for Electron process discovery and on-demand inspector activation; preserved the macOS bundle fast path.
- Bounded ripgrep candidate arguments by the Windows command-line limit and corrected drive/UNC file URI identity in native and JavaScript graph indexes.
- Made literal snippets match LF and CRLF files consistently while retaining indentation, punctuation, candidate narrowing, and multiline highlight ranges.
- Normalized ripgrep file-list paths before removing current-directory prefixes so Windows index identities and exclusions agree.
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
