//! LSM-style delta overlay for the incremental call graph.
//!
//! The canonical call-graph index (the `callgraph-*` shard families) is treated
//! as an **immutable base**. A single-file edit no longer rewrites that base
//! (which costs O(total index size) — ~54s on the captain corpus); instead it
//! writes a small **delta overlay** describing only the changed + affected
//! files (O(edit size), <1s). Queries merge base + overlay; a background
//! `graph-compact` folds the overlay back into the base occasionally.
//!
//! This mirrors the text-search overlay (`overlay.rs`: base shards +
//! `hot-overlay.json` + journal + compaction). The call-graph overlay is
//! deliberately simpler than the text-search one for v1:
//!
//! * **Single file, rewritten atomically each edit.** The overlay is kept small
//!   by compaction, so rewriting the whole thing per edit is cheap and avoids
//!   the append-journal/replay machinery. A corrupt or missing overlay is
//!   treated as empty — the base is still correct, just un-compacted, so the
//!   worst case is stale results until the next compaction (self-healing).
//! * **Exact refs + symbols only.** Token-shape ("possible") references stay in
//!   the base and are refreshed at compaction. The overlay carries the exact
//!   resolved graph for edited/affected files, which is the correctness-critical
//!   part; token-shape padding converges at compaction. This matches the
//!   existing byte-identical gate, which already treats token-shape as the sole
//!   tolerated divergence.
//!
//! ## Merge semantics (replacement-by-file)
//!
//! Every overlay entry **supersedes** a source file's base contribution rather
//! than adding on top of it. At query time:
//!   * a base reference is dropped if its source `rel_path` is superseded by the
//!     overlay (see [`GraphOverlay::ref_superseded`]), then the overlay's own
//!     refs for those files are added;
//!   * a base symbol is dropped if its file is superseded for symbols
//!     ([`GraphOverlay::symbol_superseded`]), then overlay symbols are added.
//!
//! Replacement (not addition) is what makes compaction crash-safe: if we crash
//! after the base already folded an edit in but before the overlay was cleared,
//! the base has the edit and the overlay re-supersedes the same file — the merge
//! yields the edit once, never twice.

use crate::config::EngineConfig;
use crate::graph::{GraphReference, GraphSymbol};
use crate::mmap_store::write_atomically;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

/// On-disk name of the call-graph overlay, alongside the base shards in
/// `.zoek-rs/`. Distinct from the text-search overlay (`hot-overlay.json`).
pub const GRAPH_OVERLAY_FILE: &str = "callgraph-overlay.bin";

/// How an entry supersedes its source file's base contribution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GraphOverlayEntryKind {
    /// File was created/modified: supersede the file's base refs AND symbols;
    /// the overlay supplies fresh refs + symbols.
    Changed,
    /// File imports a changed symbol and was re-resolved: supersede its base
    /// refs only (its symbols are unchanged and stay in the base); the overlay
    /// supplies fresh refs.
    AffectedRefs,
    /// File was deleted: supersede its base refs AND symbols; the overlay
    /// supplies neither.
    Deleted,
}

/// One source file's superseding contribution.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GraphOverlayEntry {
    pub kind: GraphOverlayEntryKind,
    /// Exact (non-token-shape) references *originating from this file*
    /// (`r.rel_path == <key>`). Empty for `Deleted`.
    pub refs: Vec<GraphReference>,
    /// Symbols *defined in this file*. Populated for `Changed` only.
    pub symbols: Vec<GraphSymbol>,
    /// This file's non-token-shape contribution to each target's count, computed
    /// at edit time: [scoped usages, scoped calls, MUST usages, MUST calls].
    /// MUST counts include cross-root references and exclude possible edges.
    /// Mirrors the base `callgraph-outgoing-tally-by-file-v2` rows to recompute
    /// per-target count deltas (current contribution − base contribution) across
    /// chained edits without re-deriving target scopes. Empty for `Deleted`.
    #[serde(default)]
    pub contrib: BTreeMap<u64, [u32; 4]>,
    /// Signed change to the number of eligible bare/member declarations for
    /// each `(language, source-root, name)` token-shape key. Queries apply the
    /// aggregate to the immutable base sidecar so lazy ambiguous candidates do
    /// not become stale between an edit and the next compaction.
    #[serde(default)]
    pub token_shape_target_deltas: BTreeMap<(u64, u64, u64), (i32, i32)>,
}

impl GraphOverlayEntry {
    fn tombstone(kind: GraphOverlayEntryKind) -> Self {
        Self {
            kind,
            refs: Vec::new(),
            symbols: Vec::new(),
            contrib: BTreeMap::new(),
            token_shape_target_deltas: BTreeMap::new(),
        }
    }
}

/// The whole overlay. `entries` holds at most one record per `rel_path`
/// (eagerly de-duplicated on write), so there is no per-generation merge to do
/// at read time.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GraphOverlay {
    /// The base `builtAtUnixMs` this overlay was produced against. If the base
    /// is recompacted (builtAt advances), an overlay with a stale value is
    /// discarded — its deltas are already folded into the new base.
    pub base_built_at_unix_ms: u64,
    pub updated_unix_secs: u64,
    /// Keyed by source `rel_path`.
    pub entries: BTreeMap<String, GraphOverlayEntry>,
    /// Per-target signed count deltas to apply on top of the base `counts-by-id`
    /// at query time, keyed by target `id_u64`: [usage_likely_delta,
    /// calls_in_likely_delta, usage_must_delta, calls_in_must_delta].
    /// Computed at edit time from the non-token-shape
    /// outgoing tally (new re-resolved contribution − superseded files' prior
    /// contribution). Exact for the exact-usage component; the token-shape
    /// padding of `usage_likely` converges at the next compaction. An absent base
    /// tally sends edits through the full update path instead.
    #[serde(default)]
    pub count_deltas: BTreeMap<u64, [i64; 4]>,
}

impl GraphOverlay {
    pub fn new(base_built_at_unix_ms: u64) -> Self {
        Self {
            base_built_at_unix_ms,
            updated_unix_secs: 0,
            entries: BTreeMap::new(),
            count_deltas: BTreeMap::new(),
        }
    }

    /// Path to the overlay file for a workspace.
    pub fn path(workspace_root: &Path, config: &EngineConfig) -> PathBuf {
        config.index_root(workspace_root).join(GRAPH_OVERLAY_FILE)
    }

    /// Load the overlay if present and valid for `current_base_built_at`.
    ///
    /// Returns an empty overlay (never an error) when the file is missing,
    /// unreadable/corrupt, or was produced against a different base build —
    /// in every such case the base shards alone are authoritative, so treating
    /// the overlay as empty is safe and self-healing.
    pub fn load_valid(
        workspace_root: &Path,
        config: &EngineConfig,
        current_base_built_at: u64,
    ) -> Self {
        let path = Self::path(workspace_root, config);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return Self::new(current_base_built_at),
        };
        match bincode::deserialize::<GraphOverlay>(&bytes) {
            Ok(overlay) if overlay.base_built_at_unix_ms == current_base_built_at => overlay,
            // Corrupt, or built against a different (now-superseded) base.
            _ => Self::new(current_base_built_at),
        }
    }

    /// Load the overlay regardless of base build (for compaction, which folds
    /// whatever the overlay holds). Empty on missing/corrupt.
    pub fn load_any(workspace_root: &Path, config: &EngineConfig) -> Self {
        let path = Self::path(workspace_root, config);
        match std::fs::read(&path) {
            Ok(bytes) => bincode::deserialize::<GraphOverlay>(&bytes).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, workspace_root: &Path, config: &EngineConfig) -> io::Result<()> {
        let path = Self::path(workspace_root, config);
        let bytes = bincode::serialize(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("overlay ser: {e}")))?;
        write_atomically(&path, &bytes)
    }

    /// Remove the overlay file entirely (used by compaction after the base has
    /// folded its deltas in). NotFound is not an error.
    pub fn clear(workspace_root: &Path, config: &EngineConfig) -> io::Result<()> {
        let path = Self::path(workspace_root, config);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    /// Total exact refs carried across all live entries (a compaction-trigger
    /// signal: a large overlay makes every query's merge expensive).
    pub fn ref_count(&self) -> usize {
        self.entries.values().map(|e| e.refs.len()).sum()
    }

    /// Upsert the delta for one edit batch. Each entry **replaces** any prior
    /// entry for the same file (latest-wins), keeping the overlay de-duplicated.
    pub fn upsert(&mut self, rel_path: &str, entry: GraphOverlayEntry) {
        self.entries.insert(rel_path.to_string(), entry);
    }

    pub fn upsert_tombstone(&mut self, rel_path: &str, kind: GraphOverlayEntryKind) {
        self.upsert(rel_path, GraphOverlayEntry::tombstone(kind));
    }

    /// Source files whose base **references** are superseded (every entry —
    /// Changed, AffectedRefs, and Deleted all replace the file's base refs).
    pub fn ref_superseded(&self) -> HashSet<String> {
        self.entries.keys().cloned().collect()
    }

    /// Source files whose base **symbols** are superseded (Changed + Deleted;
    /// AffectedRefs files keep their base symbols).
    pub fn symbol_superseded(&self) -> HashSet<String> {
        self.entries
            .iter()
            .filter(|(_, e)| matches!(e.kind, GraphOverlayEntryKind::Changed | GraphOverlayEntryKind::Deleted))
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Iterate the overlay's exact references (to add on top of the
    /// superseded-filtered base).
    pub fn live_refs(&self) -> impl Iterator<Item = &GraphReference> {
        self.entries.values().flat_map(|e| e.refs.iter())
    }

    /// Iterate the overlay's symbols (to add on top of the superseded-filtered
    /// base).
    pub fn live_symbols(&self) -> impl Iterator<Item = &GraphSymbol> {
        self.entries.values().flat_map(|e| e.symbols.iter())
    }

    /// Sum each entry's contribution. Subtract the base tally for `count_deltas`.
    pub fn total_contrib(&self) -> BTreeMap<u64, [i64; 4]> {
        let mut out: BTreeMap<u64, [i64; 4]> = BTreeMap::new();
        for e in self.entries.values() {
            for (&t, contribution) in &e.contrib {
                let total = out.entry(t).or_default();
                for (value, count) in total.iter_mut().zip(contribution) {
                    *value += *count as i64;
                }
            }
        }
        out
    }

    /// Sum per-file token-shape target-cardinality deltas. Each overlay entry
    /// is already relative to the immutable base contribution of that file, so
    /// summing current entries is correct across chained edits.
    pub fn total_token_shape_target_deltas(
        &self,
    ) -> BTreeMap<(u64, u64, u64), (i64, i64)> {
        let mut out = BTreeMap::new();
        for entry in self.entries.values() {
            for (&key, &(bare, member)) in &entry.token_shape_target_deltas {
                let value = out.entry(key).or_insert((0i64, 0i64));
                value.0 += bare as i64;
                value.1 += member as i64;
            }
        }
        out
    }

    /// The set of (changed) live source files — fed to compaction as its
    /// `changed_paths`.
    pub fn changed_paths(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, e)| !matches!(e.kind, GraphOverlayEntryKind::Deleted))
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// The set of deleted source files — fed to compaction as its
    /// `deleted_paths`.
    pub fn deleted_paths(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, e)| matches!(e.kind, GraphOverlayEntryKind::Deleted))
            .map(|(k, _)| k.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(id: &str, rel: &str) -> GraphSymbol {
        GraphSymbol {
            id: id.to_string(),
            name: id.to_string(),
            qualified_name: id.to_string(),
            kind: "function".to_string(),
            language: "python".to_string(),
            uri: format!("file:///{rel}"),
            rel_path: rel.to_string(),
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 0,
            body_start_line: 1,
            body_start_column: 0,
            body_end_line: 1,
            body_end_column: 0,
            container_id: None,
            container_name: None,
            package_name: None,
            extends_names: Vec::new(),
            implements_names: Vec::new(),
            usage_count: None,
            usage_must_count: None,
            usage_may_count: None,
            implementation_count: None,
            implementation_must_count: None,
            implementation_may_count: None,
            kind_flags: 0,
            language_id: 0,
            id_u64: 0,
            rel_path_hash: 0,
            name_hash: 0,
        }
    }

    fn rref(target: &str, rel: &str, prov: &str) -> GraphReference {
        GraphReference {
            source_ref_id: "ref:0".into(),
            target_symbol_id: Some(target.into()),
            edge_kind: "call".into(),
            name: "f".into(),
            raw_text: "f()".into(),
            uri: format!("file:///{rel}").into(),
            rel_path: rel.into(),
            start_line: 1,
            start_column: 0,
            end_line: 1,
            end_column: 0,
            enclosing_symbol_id: None,
            bound_mask: 0,
            confidence: "exact".into(),
            provenance: "import".into(),
        }
        .with_provenance(prov)
    }

    // Tiny helper so the test fixture reads cleanly.
    trait WithProv {
        fn with_provenance(self, p: &str) -> Self;
    }
    impl WithProv for GraphReference {
        fn with_provenance(mut self, p: &str) -> Self {
            self.provenance = p.into();
            self
        }
    }

    #[test]
    fn round_trips_via_bincode() {
        let mut overlay = GraphOverlay::new(42);
        overlay.upsert(
            "a.py",
            GraphOverlayEntry {
                kind: GraphOverlayEntryKind::Changed,
                refs: vec![rref("sym:1", "a.py", "import")],
                symbols: vec![sym("sym:1", "a.py")],
                contrib: BTreeMap::new(),
                token_shape_target_deltas: BTreeMap::new(),
            },
        );
        overlay.upsert_tombstone("gone.py", GraphOverlayEntryKind::Deleted);
        let bytes = bincode::serialize(&overlay).unwrap();
        let back: GraphOverlay = bincode::deserialize(&bytes).unwrap();
        assert_eq!(back.base_built_at_unix_ms, 42);
        assert_eq!(back.entry_count(), 2);
        assert_eq!(back.ref_count(), 1);
    }

    #[test]
    fn superseded_sets_distinguish_symbols_from_refs() {
        let mut overlay = GraphOverlay::new(1);
        overlay.upsert(
            "changed.py",
            GraphOverlayEntry {
                kind: GraphOverlayEntryKind::Changed,
                refs: vec![rref("sym:t", "changed.py", "import")],
                symbols: vec![sym("sym:c", "changed.py")],
                contrib: BTreeMap::new(),
                token_shape_target_deltas: BTreeMap::new(),
            },
        );
        overlay.upsert(
            "importer.py",
            GraphOverlayEntry {
                kind: GraphOverlayEntryKind::AffectedRefs,
                refs: vec![rref("sym:c", "importer.py", "import")],
                symbols: Vec::new(),
                contrib: BTreeMap::new(),
                token_shape_target_deltas: BTreeMap::new(),
            },
        );
        overlay.upsert_tombstone("deleted.py", GraphOverlayEntryKind::Deleted);

        let ref_sup = overlay.ref_superseded();
        assert!(ref_sup.contains("changed.py"));
        assert!(ref_sup.contains("importer.py")); // re-resolved → base refs dropped
        assert!(ref_sup.contains("deleted.py"));

        let sym_sup = overlay.symbol_superseded();
        assert!(sym_sup.contains("changed.py"));
        assert!(!sym_sup.contains("importer.py")); // importer symbols unchanged → kept
        assert!(sym_sup.contains("deleted.py"));

        assert_eq!(overlay.changed_paths().len(), 2); // changed + importer
        assert_eq!(overlay.deleted_paths(), vec!["deleted.py".to_string()]);
        assert_eq!(overlay.live_symbols().count(), 1); // only changed.py's symbol
        assert_eq!(overlay.live_refs().count(), 2);
    }

    #[test]
    fn upsert_replaces_prior_entry_for_same_file() {
        let mut overlay = GraphOverlay::new(1);
        overlay.upsert(
            "a.py",
            GraphOverlayEntry {
                kind: GraphOverlayEntryKind::Changed,
                refs: vec![rref("sym:old", "a.py", "import")],
                symbols: Vec::new(),
                contrib: BTreeMap::new(),
                token_shape_target_deltas: BTreeMap::new(),
            },
        );
        overlay.upsert(
            "a.py",
            GraphOverlayEntry {
                kind: GraphOverlayEntryKind::Changed,
                refs: vec![
                    rref("sym:new1", "a.py", "import"),
                    rref("sym:new2", "a.py", "import"),
                ],
                symbols: Vec::new(),
                contrib: BTreeMap::new(),
                token_shape_target_deltas: BTreeMap::new(),
            },
        );
        assert_eq!(overlay.entry_count(), 1);
        assert_eq!(overlay.ref_count(), 2); // latest wins, not summed
    }
}
