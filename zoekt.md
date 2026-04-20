# zoek-rs Design Spec

`zoek-rs` is a proposed Rust search engine for IntelliJ Styled Search. The goal is to keep the current codesearch-style query planner available while adding a Zoekt-inspired local engine optimized for large desktop workspaces, fast freshness, and deterministic offline operation.

The design borrows Zoekt's shard and mmap operational model, but replaces fixed trigrams with a sparse, dynamic n-gram strategy. The index is used only to narrow candidate documents. Exact matches, match ranges, and final scoring are produced by reading the current file contents and verifying the query against them.

## Goals

- Run entirely on a local desktop machine with no network dependency.
- Handle codebases around 100,000 files.
- Support substring search, regex search, file-name search, and path filters.
- Target full indexing in roughly 10 seconds on a well-filtered text corpus.
- Reflect changed files within 1 second.
- Use an n-gram inverted index only for candidate pruning.
- Verify all final matches by scanning actual file contents.
- Preserve the existing codesearch algorithm as a selectable fallback engine.

## Non-Goals

- This is not a distributed search service.
- This is not a semantic/vector search engine.
- The index does not need to store authoritative match ranges.
- The index should not try to answer every regex precisely; difficult regexes can degrade to broader candidate sets and rely on final verification.

## High-Level Architecture

```text
VS Code extension
  |
  | query + options
  v
zoek-rs service / binary
  |
  | parse query, path filters, case mode
  v
query planner
  |
  | candidate grams
  v
base snapshot shards (mmap, immutable)
  +
hot overlay index (mutable, recent changes)
  |
  | candidate doc ids
  v
file verifier
  |
  | read current file bytes, run literal/regex matcher
  v
ranked FileMatch results with ranges
```

The base snapshot is optimized for read throughput and sharing via mmap. The hot overlay is optimized for frequent small updates. Search merges candidates from both layers, with overlay tombstones and newer file generations taking precedence over base-shard entries.

## Storage Model

### Base Snapshot

The base snapshot is a set of immutable shards. Each shard owns a subset of documents and can be memory-mapped independently.

Suggested shard sizing:

- Target 8-64 MB per shard after compression.
- Keep document count per shard bounded, for example 2,000-10,000 files.
- Split by stable path hash or path prefix, not by modification time.
- Store shard metadata separately so the engine can skip shards by path filter before touching postings.

Shard contents:

- Header: magic, schema version, feature flags, byte order, checksum.
- Workspace fingerprint: root path, index config hash, ignore config hash.
- Document table: doc id, relative path, size, mtime, content hash, language hint, deletion marker.
- Path index: path grams or a compact path suffix/prefix structure.
- Gram dictionary: dynamic n-gram key to postings offset.
- Posting lists: doc ids and optional lightweight per-doc stats.
- Optional bloom filters per shard for fast negative tests.

Postings should be encoded for mmap-friendly reads:

- Sorted doc ids.
- Delta or varint encoding.
- Skip blocks for long posting lists.
- Optional Roaring bitmaps for very frequent grams if profiling supports it.

### Hot Overlay

The hot overlay stores updates after the base snapshot was built.

Overlay responsibilities:

- Add or replace recently changed files.
- Store tombstones for deleted files.
- Shadow stale base entries by path or stable file id.
- Flush into a new base snapshot asynchronously.

Overlay data structures can stay in memory and optionally be journaled:

- Path to generation map.
- Generation to file metadata.
- Dynamic gram postings for changed files.
- Tombstone set.
- Small write-ahead journal for crash recovery.

Freshness target:

- File watcher event reaches overlay within 1 second.
- Search sees overlay updates immediately after overlay commit.
- Base compaction can lag behind without affecting correctness.

## Incremental Indexing

`zoek-rs` must support incremental indexing as a first-class operation. A file change should not require rebuilding the base snapshot. Instead, the engine reindexes only the changed path and commits the result into the hot overlay.

Incremental update flow:

1. File watcher receives create, modify, rename, or delete event.
2. Events are debounced and collapsed by normalized path.
3. The engine stats the path and checks the current index rules.
4. Deleted files become overlay tombstones.
5. Binary, oversized, or newly excluded files also become tombstones.
6. Valid text files are decoded, tokenized, and gram-extracted.
7. The previous overlay generation for that path is superseded.
8. The new generation is committed to overlay postings and metadata.
9. Searches immediately merge the new overlay generation with mmap base shards.

This gives the engine two freshness modes:

- **Incremental freshness:** changed files are visible through the overlay within the 1-second target.
- **Snapshot freshness:** background compaction eventually folds overlay generations and tombstones into new immutable shards.

Correctness does not depend on compaction. If a base shard still contains an old version of a file, the overlay generation shadows it. If a file was deleted, the overlay tombstone removes the base document before verification. If the overlay is temporarily behind a filesystem event, final verification against current file bytes still rejects stale candidates.

Incremental indexing should expose operational counters:

- pending watcher events,
- overlay file count,
- overlay tombstone count,
- last incremental commit latency,
- failed incremental reads,
- compaction-needed reason.

## Dynamic N-Gram Strategy

The current codebase uses fixed trigram-style candidate pruning. `zoek-rs` should use dynamic grams to improve selectivity and reduce index size for code search workloads.

### Gram Types

Use a sparse set of grams per file rather than every possible n-gram:

- Short grams: 3-4 bytes for short literals and fallback coverage.
- Medium grams: 5-8 bytes for identifiers, path fragments, and common code tokens.
- Long grams: 9-16 bytes for highly selective literals, sampled from stable token boundaries.
- Path grams: separate grams over normalized relative paths.

Recommended extraction sources:

- Identifier tokens: `UserProfile`, `user_profile`, `getUserProfile`.
- String-like tokens from source text.
- Punctuation-aware code fragments such as `def `, `class `, `from `, `import `, `=>`, `::`, `->`.
- Boundary-aware substrings from long literals.
- Normalized lowercase variants when case-insensitive search is enabled or when indexing ASCII identifiers.

### Gram Selection

The index should avoid storing every possible n-gram. For each document:

1. Tokenize text into code-like tokens and separators.
2. Generate candidate grams from token interiors and token boundaries.
3. Score grams by estimated selectivity and stability.
4. Keep a bounded number of grams per file or per byte of text.
5. Always preserve enough short grams for substring fallback.

Candidate gram scoring inputs:

- Global document frequency from the previous snapshot.
- Token length.
- Character entropy.
- Whether the gram crosses a useful boundary.
- Whether the gram is too common in code, such as whitespace-heavy fragments.

For a new workspace with no prior frequency table, start with heuristics and refine after the first full index.

### Query Planning

For literal substring queries:

- Extract dynamic grams from the query using the same normalizer.
- Choose the most selective available grams.
- Intersect postings for mandatory grams.
- If no reliable gram can be extracted, scan the scoped file set directly.

For regex queries:

- Keep the current codesearch-style regex analysis.
- Extract mandatory literals or required substrings from the regex AST.
- Convert those literals into dynamic grams.
- For unsupported or broad regexes, return a wide candidate set and rely on verification.

For multiline regex:

- Treat `.` as dot-all when the UI regex multiline mode is enabled.
- Index should not need to model newline ranges exactly.
- Candidate pruning can use literals around the multiline operators.
- Verification computes exact multiline match ranges from file content.

## Search Pipeline

1. Normalize query options: regex, case sensitivity, whole word, multiline, include patterns.
2. Plan candidate grams from query.
3. Apply path filters to skip shards and overlay entries.
4. Read candidate postings from base shards through mmap.
5. Merge base candidates with overlay candidates.
6. Remove tombstoned or shadowed base docs.
7. Prioritize candidates:
   - open editor files,
   - shallow user source paths,
   - non-library paths,
   - library/cache paths last.
8. Verify candidates by reading current file contents.
9. Compute exact match ranges, snippets, and line numbers.
10. Stream results back to the extension in batches.

The verifier is the source of truth. If the index says a file is a candidate but the file no longer matches, it is ignored. If a file changed after indexing, the overlay generation should either cover it or the verifier reads the latest bytes and rejects stale candidates.

## File Watching And Freshness

The watcher layer should:

- Debounce bursts per path.
- Read changed file metadata and content hash.
- Skip binary or oversized files using the same rules as full indexing.
- Add changed files to overlay.
- Add tombstones for deleted files.
- Queue background base snapshot rebuild when overlay size crosses a threshold.

Suggested thresholds:

- Overlay file count over 1-5% of base docs.
- Overlay byte size over 64-256 MB.
- Tombstone count over 1% of base docs.
- Idle-time compaction after several minutes.

## Rust Components

Proposed crate layout:

```text
crates/zoek-rs/
  src/
    lib.rs
    config.rs
    corpus.rs
    gram.rs
    indexer.rs
    shard.rs
    mmap_store.rs
    overlay.rs
    planner.rs
    regex_plan.rs
    verifier.rs
    scorer.rs
    watcher.rs
    protocol.rs
    bin/zoek-rs.rs
```

Core modules:

- `config`: index schema, ignore rules, file size limits, engine settings.
- `corpus`: file discovery, text/binary detection, path normalization.
- `gram`: dynamic n-gram extraction and selectivity model.
- `indexer`: parallel full indexing and shard building.
- `shard`: immutable shard reader/writer.
- `mmap_store`: safe mmap wrappers and checksum validation.
- `overlay`: mutable recent-change layer.
- `planner`: literal/path query planning.
- `regex_plan`: codesearch-compatible regex mandatory-literal extraction.
- `verifier`: exact file scan, regex execution, range calculation.
- `scorer`: result ordering and open-file boosts.
- `watcher`: file-system event ingestion.
- `protocol`: JSON-RPC or line-delimited protocol for the VS Code extension.

## VS Code Integration

Add a selectable engine setting:

```json
{
  "intellijStyledSearch.engine": "zoekt"
}
```

Planned values:

- `zoekt`: use the Rust `zoek-rs` engine.
- `codesearch`: use the current TypeScript codesearch/trigram planner plus ripgrep verifier.

Until `zoek-rs` is implemented, the extension can expose the setting while falling back to the current engine. Once the Rust engine is available, the default path should start the local binary, ensure the workspace index is current, and stream results through the same renderer protocol used today.

## Implementation Plan

### Phase 1: Spec And Settings

- Add this design document.
- Add `intellijStyledSearch.engine` with default `zoekt`.
- Read the selected engine in the extension search path.
- Fall back from `zoekt` to the existing `codesearch` engine until the Rust runtime is available.
- Keep current codesearch engine intact.
- Document `codesearch` as fallback.

### Phase 2: Rust Skeleton

- Add Rust workspace/crate scaffolding.
- Define shard and overlay data model.
- Define extension-to-engine protocol.
- Build a CLI that can index a directory and print simple search results.

### Phase 3: Full Index Builder

- Implement file discovery and filtering.
- Implement text decoding and binary detection.
- Implement dynamic gram extraction.
- Write immutable shard files.
- Add mmap shard reader.
- Add index metadata and schema versioning.

### Phase 4: Query Planner And Verifier

- Implement literal substring query planning.
- Port or reuse codesearch regex mandatory-literal planning.
- Merge base and overlay candidates.
- Verify matches against current file content.
- Return ranges, previews, and file metadata.

### Phase 5: Hot Overlay

- Add watcher-driven overlay updates.
- Add file-level incremental reindexing for create, modify, rename, and delete events.
- Implement tombstones and generation shadowing.
- Add overlay journal.
- Add compaction trigger from overlay to base snapshot.

### Phase 6: VS Code Runtime Integration

- Start and supervise `zoek-rs` from the extension.
- Add engine routing based on `intellijStyledSearch.engine`.
- Reuse existing renderer result protocol.
- Keep `codesearch` fallback when the binary is missing, unhealthy, or indexing is incomplete.

### Phase 7: Performance And Operations

- Benchmark 10k, 50k, and 100k file workspaces.
- Track full-index time, update latency, query p50/p95, memory, mmap page faults.
- Add diagnostic commands for shard stats, overlay stats, and candidate explanation.
- Add crash recovery for partial shard writes and overlay journal replay.

## Correctness Rules

- Never trust index postings for final correctness.
- Always verify against current file bytes.
- Overlay entries override base entries by path/generation.
- Deleted files must be removed by tombstone before verification.
- Index corruption should fail closed: skip shard and fall back to direct scan or current `codesearch` engine.
- Schema changes must invalidate old shards cleanly.

## Open Questions

- Exact sparse gram budget per file.
- Whether postings should use varint lists, Roaring bitmaps, or a hybrid.
- Whether the Rust engine should be a long-running process or spawned per query after mmap warmup.
- How much regex planning should be ported from TypeScript versus reimplemented in Rust.
- Whether path filter evaluation should live entirely in Rust or stay partly in the extension.
