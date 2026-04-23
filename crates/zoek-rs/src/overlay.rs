use crate::config::EngineConfig;
use crate::corpus::{decode_bytes, looks_binary_bytes};
use crate::mmap_store::{write_atomically, StoreLayout};
use crate::protocol::json_string;
use crate::watcher::{ChangeBatch, FileChange, FileChangeKind};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct OverlayEntry {
    pub rel_path: String,
    pub generation: u64,
    pub tombstone: bool,
    pub modified_unix_secs: u64,
    pub content_hash: u64,
    pub grams: Vec<String>,
    /// See `IndexedDocument::gram_incomplete`. Files written into the
    /// overlay when the indexer exhausted `max_grams_per_file` must still
    /// be searchable; set this so the searcher skips AND-intersection for
    /// them.
    pub gram_incomplete: bool,
}

#[derive(Clone, Debug)]
pub struct OverlayManifest {
    pub generation: u64,
    pub updated_unix_secs: u64,
    pub entries: Vec<OverlayEntry>,
}

#[derive(Clone, Debug, Default)]
pub struct OverlayStats {
    pub live_entries: usize,
    pub tombstones: usize,
}

#[derive(Clone, Debug)]
pub struct OverlayUpdateSummary {
    pub generation: u64,
    pub entries_written: usize,
    pub live_entries: usize,
    pub tombstones: usize,
    pub overlay_total_entries: usize,
    pub latest_visible_entries: usize,
    pub journal_bytes: u64,
    pub compaction_suggested: bool,
    pub compaction_reason: Option<String>,
    pub compaction_performed: bool,
    pub compaction_trigger_reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OverlayLoadResult {
    pub manifest: OverlayManifest,
    pub warnings: Vec<String>,
    pub recovered: bool,
}

impl OverlayManifest {
    pub fn empty() -> Self {
        Self {
            generation: 0,
            updated_unix_secs: 0,
            entries: Vec::new(),
        }
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        if !path.exists() {
            return Ok(Self::empty());
        }
        let text = fs::read_to_string(path)?;
        parse_overlay_manifest(&text)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_atomically(path, self.to_json().as_bytes())
    }

    pub fn stats(&self) -> OverlayStats {
        let mut stats = OverlayStats::default();
        for entry in &self.entries {
            if entry.tombstone {
                stats.tombstones += 1;
            } else {
                stats.live_entries += 1;
            }
        }
        stats
    }

    pub fn latest_entries(&self) -> BTreeMap<String, OverlayEntry> {
        let mut latest: BTreeMap<String, OverlayEntry> = BTreeMap::new();
        for entry in &self.entries {
            match latest.get(&entry.rel_path) {
                Some(existing) if existing.generation > entry.generation => {}
                _ => {
                    latest.insert(entry.rel_path.clone(), entry.clone());
                }
            }
        }
        latest
    }

    pub fn latest_stats(&self) -> OverlayStats {
        let mut stats = OverlayStats::default();
        for entry in self.latest_entries().values() {
            if entry.tombstone {
                stats.tombstones += 1;
            } else {
                stats.live_entries += 1;
            }
        }
        stats
    }

    pub fn to_json(&self) -> String {
        let entries = self
            .entries
            .iter()
            .map(|entry| {
                format!(
                    "{{\"relPath\":{},\"generation\":{},\"tombstone\":{},\"modifiedUnixSecs\":{},\"contentHash\":{},\"gramIncomplete\":{},\"grams\":[{}]}}",
                    json_string(&entry.rel_path),
                    entry.generation,
                    entry.tombstone,
                    entry.modified_unix_secs,
                    entry.content_hash,
                    entry.gram_incomplete,
                    entry.grams.iter().map(|gram| json_string(gram)).collect::<Vec<_>>().join(",")
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"generation\":{},\"updatedUnixSecs\":{},\"entries\":[{}]}}",
            self.generation, self.updated_unix_secs, entries
        )
    }
}

#[derive(Clone, Debug)]
struct JournalReplayEntry {
    entry: OverlayEntry,
    committed_unix_secs: u64,
}

pub fn load_overlay_with_recovery(layout: &StoreLayout) -> io::Result<OverlayLoadResult> {
    layout.ensure_dirs()?;
    let manifest_result = OverlayManifest::load(&layout.overlay_path);
    let journal = load_journal_entries(&layout.overlay_journal_path)?;

    match manifest_result {
        Ok(mut manifest) => {
            let mut warnings = journal.warnings;
            let replay_entries = journal
                .entries
                .into_iter()
                .filter(|entry| entry.entry.generation > manifest.generation)
                .collect::<Vec<_>>();
            if replay_entries.is_empty() {
                return Ok(OverlayLoadResult {
                    manifest,
                    warnings,
                    recovered: false,
                });
            }
            for replay in replay_entries {
                manifest.generation = manifest.generation.max(replay.entry.generation);
                manifest.updated_unix_secs = manifest.updated_unix_secs.max(replay.committed_unix_secs);
                manifest.entries.push(replay.entry);
            }
            manifest.save(&layout.overlay_path)?;
            warnings.push("overlay manifest was behind the journal; replayed newer journal entries".to_string());
            Ok(OverlayLoadResult {
                manifest,
                warnings,
                recovered: true,
            })
        }
        Err(err) => {
            if journal.entries.is_empty() {
                return Err(err);
            }
            let mut manifest = OverlayManifest::empty();
            let mut warnings = journal.warnings;
            for replay in journal.entries {
                manifest.generation = manifest.generation.max(replay.entry.generation);
                manifest.updated_unix_secs = manifest.updated_unix_secs.max(replay.committed_unix_secs);
                manifest.entries.push(replay.entry);
            }
            manifest.save(&layout.overlay_path)?;
            warnings.push(format!(
                "overlay manifest was unreadable ({}); rebuilt it from overlay journal",
                err
            ));
            Ok(OverlayLoadResult {
                manifest,
                warnings,
                recovered: true,
            })
        }
    }
}

pub fn apply_change_batch(
    workspace_root: &Path,
    layout: &StoreLayout,
    config: &EngineConfig,
    batch: &ChangeBatch,
) -> io::Result<OverlayUpdateSummary> {
    layout.ensure_dirs()?;
    let mut manifest = load_overlay_with_recovery(layout)?.manifest;
    if batch.is_empty() {
        let journal_bytes = journal_size(&layout.overlay_journal_path)?;
        let latest_stats = manifest.latest_stats();
        let compaction_reason = compaction_reason(&manifest, journal_bytes, config);
        return Ok(OverlayUpdateSummary {
            generation: manifest.generation,
            entries_written: 0,
            live_entries: 0,
            tombstones: 0,
            overlay_total_entries: manifest.entries.len(),
            latest_visible_entries: latest_stats.live_entries + latest_stats.tombstones,
            journal_bytes,
            compaction_suggested: compaction_reason.is_some(),
            compaction_reason,
            compaction_performed: false,
            compaction_trigger_reason: None,
        });
    }

    let committed_unix_secs = if batch.committed_unix_secs == 0 {
        now_unix_secs()
    } else {
        batch.committed_unix_secs
    };
    let generation = manifest.generation.max(batch.generation.saturating_sub(1)) + 1;
    let mut entries = Vec::new();

    for change in &batch.changes {
        match change.kind {
            FileChangeKind::Create | FileChangeKind::Modify => {
                entries.push(build_entry_for_path(
                    workspace_root,
                    &change.rel_path,
                    generation,
                    committed_unix_secs,
                    config,
                )?);
            }
            FileChangeKind::Delete => {
                entries.push(build_tombstone_entry(
                    &change.rel_path,
                    generation,
                    committed_unix_secs,
                ));
            }
            FileChangeKind::Rename => {
                entries.push(build_tombstone_entry(
                    &change.rel_path,
                    generation,
                    committed_unix_secs,
                ));
                if let Some(new_rel_path) = &change.new_rel_path {
                    entries.push(build_entry_for_path(
                        workspace_root,
                        new_rel_path,
                        generation,
                        committed_unix_secs,
                        config,
                    )?);
                }
            }
        }
    }

    append_journal(&layout.overlay_journal_path, committed_unix_secs, &batch.changes, &entries)?;
    manifest.generation = generation;
    manifest.updated_unix_secs = committed_unix_secs;
    manifest.entries.extend(entries.iter().cloned());
    manifest.save(&layout.overlay_path)?;

    let live_entries = entries.iter().filter(|entry| !entry.tombstone).count();
    let tombstones = entries.len() - live_entries;
    let compaction_trigger_reason = compaction_reason(
        &manifest,
        journal_size(&layout.overlay_journal_path)?,
        config,
    );
    let compaction_performed = if compaction_trigger_reason.is_some() {
        compact_overlay_manifest(layout, &mut manifest)?;
        true
    } else {
        false
    };
    let journal_bytes = journal_size(&layout.overlay_journal_path)?;
    let latest_stats = manifest.latest_stats();
    let compaction_reason = compaction_reason(&manifest, journal_bytes, config);

    Ok(OverlayUpdateSummary {
        generation,
        entries_written: entries.len(),
        live_entries,
        tombstones,
        overlay_total_entries: manifest.entries.len(),
        latest_visible_entries: latest_stats.live_entries + latest_stats.tombstones,
        journal_bytes,
        compaction_suggested: compaction_reason.is_some(),
        compaction_reason,
        compaction_performed,
        compaction_trigger_reason,
    })
}

fn compact_overlay_manifest(layout: &StoreLayout, manifest: &mut OverlayManifest) -> io::Result<()> {
    let latest = manifest.latest_entries();
    manifest.entries = latest.into_iter().map(|(_, entry)| entry).collect();
    manifest.save(&layout.overlay_path)?;
    match fs::remove_file(&layout.overlay_journal_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn build_entry_for_path(
    workspace_root: &Path,
    rel_path: &str,
    generation: u64,
    committed_unix_secs: u64,
    config: &EngineConfig,
) -> io::Result<OverlayEntry> {
    let abs_path = workspace_root.join(rel_path);
    let metadata = match fs::metadata(&abs_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(build_tombstone_entry(rel_path, generation, committed_unix_secs));
        }
        Err(err) => return Err(err),
    };
    if !metadata.is_file()
        || metadata.len() > config.max_file_size_bytes
        || config.is_binary_extension(&abs_path)
    {
        return Ok(build_tombstone_entry(rel_path, generation, committed_unix_secs));
    }

    let bytes = fs::read(&abs_path)?;
    if looks_binary_bytes(&bytes) {
        return Ok(build_tombstone_entry(rel_path, generation, committed_unix_secs));
    }
    let (text, _) = decode_bytes(&bytes);
    let modified_unix_secs = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(committed_unix_secs);

    let (grams, overflow) = crate::gram::extract_dynamic_grams_with_overflow(
        rel_path,
        &text,
        config.max_grams_per_file,
    );
    Ok(OverlayEntry {
        rel_path: rel_path.to_string(),
        generation,
        tombstone: false,
        modified_unix_secs,
        content_hash: stable_hash(&text),
        grams: grams.into_iter().map(|gram| gram.value).collect(),
        gram_incomplete: overflow,
    })
}

fn build_tombstone_entry(rel_path: &str, generation: u64, committed_unix_secs: u64) -> OverlayEntry {
    OverlayEntry {
        rel_path: rel_path.to_string(),
        generation,
        tombstone: true,
        modified_unix_secs: committed_unix_secs,
        content_hash: 0,
        grams: Vec::new(),
        gram_incomplete: false,
    }
}

fn append_journal(
    path: &Path,
    committed_unix_secs: u64,
    changes: &[FileChange],
    entries: &[OverlayEntry],
) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    for change in changes {
        match change.kind {
            FileChangeKind::Rename => {
                write_journal_record(
                    &mut file,
                    committed_unix_secs,
                    "rename",
                    &change.rel_path,
                    entries.iter().find(|entry| entry.rel_path == change.rel_path),
                )?;
                if let Some(new_rel_path) = &change.new_rel_path {
                    write_journal_record(
                        &mut file,
                        committed_unix_secs,
                        "rename",
                        new_rel_path,
                        entries.iter().rev().find(|entry| entry.rel_path == *new_rel_path),
                    )?;
                }
            }
            FileChangeKind::Create => write_journal_record(
                &mut file,
                committed_unix_secs,
                "create",
                &change.rel_path,
                entries.iter().find(|entry| entry.rel_path == change.rel_path),
            )?,
            FileChangeKind::Modify => write_journal_record(
                &mut file,
                committed_unix_secs,
                "modify",
                &change.rel_path,
                entries.iter().find(|entry| entry.rel_path == change.rel_path),
            )?,
            FileChangeKind::Delete => write_journal_record(
                &mut file,
                committed_unix_secs,
                "delete",
                &change.rel_path,
                entries.iter().find(|entry| entry.rel_path == change.rel_path),
            )?,
        }
    }
    Ok(())
}

fn write_journal_record(
    file: &mut fs::File,
    committed_unix_secs: u64,
    cause: &str,
    rel_path: &str,
    entry: Option<&OverlayEntry>,
) -> io::Result<()> {
    let Some(entry) = entry else {
        return Ok(());
    };
    writeln!(
        file,
        "{{\"generation\":{},\"committedUnixSecs\":{},\"cause\":{},\"relPath\":{},\"tombstone\":{},\"modifiedUnixSecs\":{},\"contentHash\":{},\"gramIncomplete\":{},\"grams\":[{}]}}",
        entry.generation,
        committed_unix_secs,
        json_string(cause),
        json_string(rel_path),
        entry.tombstone,
        entry.modified_unix_secs,
        entry.content_hash,
        entry.gram_incomplete,
        entry.grams.iter().map(|gram| json_string(gram)).collect::<Vec<_>>().join(",")
    )
}

#[derive(Default)]
struct JournalReplayResult {
    entries: Vec<JournalReplayEntry>,
    warnings: Vec<String>,
}

fn load_journal_entries(path: &Path) -> io::Result<JournalReplayResult> {
    if !path.exists() {
        return Ok(JournalReplayResult::default());
    }
    let text = fs::read_to_string(path)?;
    let mut result = JournalReplayResult::default();
    for (line_no, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match parse_journal_line(trimmed) {
            Ok(Some(entry)) => result.entries.push(entry),
            Ok(None) => {}
            Err(err) => {
                result.warnings.push(format!(
                    "ignored malformed overlay journal line {}: {}",
                    line_no + 1,
                    err
                ));
            }
        }
    }
    Ok(result)
}

fn parse_journal_line(text: &str) -> io::Result<Option<JournalReplayEntry>> {
    let rel_path = match parse_string_field(text, "relPath") {
        Some(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    let generation = parse_u64_field(text, "generation").ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "missing journal generation")
    })?;
    let committed_unix_secs = parse_u64_field(text, "committedUnixSecs").unwrap_or(0);
    let modified_unix_secs = parse_u64_field(text, "modifiedUnixSecs").unwrap_or(committed_unix_secs);
    let content_hash = parse_u64_field(text, "contentHash").unwrap_or(0);
    let tombstone = parse_bool_field(text, "tombstone").unwrap_or(false);
    let grams = parse_string_array_field(text, "grams").unwrap_or_default();
    let gram_incomplete = parse_bool_field(text, "gramIncomplete").unwrap_or(false);
    Ok(Some(JournalReplayEntry {
        entry: OverlayEntry {
            rel_path,
            generation,
            tombstone,
            modified_unix_secs,
            content_hash,
            grams,
            gram_incomplete,
        },
        committed_unix_secs,
    }))
}

fn journal_size(path: &Path) -> io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(err) => Err(err),
    }
}

pub fn compaction_reason(
    manifest: &OverlayManifest,
    journal_bytes: u64,
    config: &EngineConfig,
) -> Option<String> {
    if manifest.entries.len() >= config.overlay_compaction_entry_threshold {
        return Some(format!(
            "overlay-entry-threshold({}>={})",
            manifest.entries.len(),
            config.overlay_compaction_entry_threshold
        ));
    }
    if journal_bytes >= config.overlay_compaction_journal_bytes_threshold {
        return Some(format!(
            "overlay-journal-threshold({}>={})",
            journal_bytes,
            config.overlay_compaction_journal_bytes_threshold
        ));
    }
    None
}

fn stable_hash(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn parse_overlay_manifest(text: &str) -> io::Result<OverlayManifest> {
    let generation = parse_u64_field(text, "generation").unwrap_or(0);
    let updated_unix_secs = parse_u64_field(text, "updatedUnixSecs").unwrap_or(0);
    let entries_body = extract_array_body(text, "entries").unwrap_or_default();
    let mut entries = Vec::new();
    for raw_entry in split_top_level_objects(&entries_body) {
        entries.push(OverlayEntry {
            rel_path: parse_string_field(raw_entry, "relPath").unwrap_or_default(),
            generation: parse_u64_field(raw_entry, "generation").unwrap_or(0),
            tombstone: parse_bool_field(raw_entry, "tombstone").unwrap_or(false),
            modified_unix_secs: parse_u64_field(raw_entry, "modifiedUnixSecs").unwrap_or(0),
            content_hash: parse_u64_field(raw_entry, "contentHash").unwrap_or(0),
            grams: parse_string_array_field(raw_entry, "grams").unwrap_or_default(),
            gram_incomplete: parse_bool_field(raw_entry, "gramIncomplete").unwrap_or(false),
        });
    }
    Ok(OverlayManifest {
        generation,
        updated_unix_secs,
        entries,
    })
}

fn extract_array_body(text: &str, key: &str) -> Option<String> {
    let start = find_key(text, key)?;
    let mut idx = text[start..].find('[')? + start + 1;
    let mut depth = 1usize;
    let mut in_string = false;
    let mut escaped = false;
    while idx < text.len() {
        let ch = text.as_bytes()[idx] as char;
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            idx += 1;
            continue;
        }
        match ch {
            '"' => in_string = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start + text[start..].find('[')? + 1..idx].to_string());
                }
            }
            _ => {}
        }
        idx += 1;
    }
    None
}

fn split_top_level_objects(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (idx, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => {
                if depth == 0 {
                    start = Some(idx);
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some(begin) = start.take() {
                        out.push(&text[begin..=idx]);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_string_field(text: &str, key: &str) -> Option<String> {
    let start = find_key(text, key)?;
    let quote = text[start..].find('"')? + start + 1;
    let end = find_string_end(text, quote)?;
    decode_json_string(&text[quote..end]).ok()
}

fn parse_string_array_field(text: &str, key: &str) -> Option<Vec<String>> {
    let body = extract_array_body(text, key)?;
    let mut values = Vec::new();
    let mut idx = 0usize;
    while idx < body.len() {
        let ch = body.as_bytes()[idx] as char;
        if ch == '"' {
            let end = find_string_end(&body, idx + 1)?;
            values.push(decode_json_string(&body[idx + 1..end]).ok()?);
            idx = end + 1;
        } else {
            idx += 1;
        }
    }
    Some(values)
}

fn parse_u64_field(text: &str, key: &str) -> Option<u64> {
    let start = find_key(text, key)?;
    let end = text[start..]
        .find(|ch: char| !ch.is_ascii_digit())
        .map(|offset| start + offset)
        .unwrap_or(text.len());
    text[start..end].trim().parse::<u64>().ok()
}

fn parse_bool_field(text: &str, key: &str) -> Option<bool> {
    let start = find_key(text, key)?;
    if text[start..].starts_with("true") {
        Some(true)
    } else if text[start..].starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn find_key(text: &str, key: &str) -> Option<usize> {
    let needle = format!("\"{key}\":");
    text.find(&needle).map(|idx| idx + needle.len())
}

fn find_string_end(text: &str, mut idx: usize) -> Option<usize> {
    let mut escaped = false;
    while idx < text.len() {
        let ch = text.as_bytes()[idx] as char;
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn decode_json_string(text: &str) -> Result<String, ()> {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next().ok_or(())? {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let code = chars.by_ref().take(4).collect::<String>();
                let value = u32::from_str_radix(&code, 16).map_err(|_| ())?;
                let decoded = char::from_u32(value).ok_or(())?;
                out.push(decoded);
            }
            other => out.push(other),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{apply_change_batch, load_overlay_with_recovery, OverlayEntry, OverlayManifest};
    use crate::config::EngineConfig;
    use crate::mmap_store::StoreLayout;
    use crate::watcher::build_change_batch;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn round_trips_overlay_and_resolves_latest_generation() {
        let manifest = OverlayManifest {
            generation: 3,
            updated_unix_secs: 10,
            entries: vec![
                OverlayEntry {
                    rel_path: "src/a.rs".to_string(),
                    generation: 1,
                    tombstone: false,
                    modified_unix_secs: 1,
                    content_hash: 10,
                    grams: vec!["alph".to_string()],
                    gram_incomplete: false,
                },
                OverlayEntry {
                    rel_path: "src/a.rs".to_string(),
                    generation: 2,
                    tombstone: true,
                    modified_unix_secs: 2,
                    content_hash: 11,
                    grams: vec![],
                    gram_incomplete: false,
                },
            ],
        };
        let parsed = OverlayManifest::load_json_for_test(&manifest.to_json()).expect("overlay must parse");
        let latest = parsed.latest_entries();
        assert_eq!(latest["src/a.rs"].generation, 2);
        assert!(latest["src/a.rs"].tombstone);
    }

    #[test]
    fn apply_change_batch_writes_journal_and_live_entry() -> io::Result<()> {
        let root = temp_dir("overlay-live");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let config = EngineConfig::default();
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/a.rs")], &[], &[]);
        let summary = apply_change_batch(&root, &layout, &config, &batch)?;
        assert_eq!(summary.entries_written, 1);
        assert_eq!(summary.live_entries, 1);
        assert!(summary.journal_bytes > 0);
        let overlay = OverlayManifest::load(&layout.overlay_path)?;
        assert_eq!(overlay.latest_entries()["src/a.rs"].tombstone, false);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn rename_writes_old_tombstone_and_new_live_entry() -> io::Result<()> {
        let root = temp_dir("overlay-rename");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/new.rs"), "struct BetaService {}\n")?;
        let config = EngineConfig::default();
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(
            1,
            &[],
            &[],
            &[(String::from("src/old.rs"), String::from("src/new.rs"))],
        );
        let summary = apply_change_batch(&root, &layout, &config, &batch)?;
        assert_eq!(summary.entries_written, 2);
        let overlay = OverlayManifest::load(&layout.overlay_path)?;
        let latest = overlay.latest_entries();
        assert!(latest["src/old.rs"].tombstone);
        assert!(!latest["src/new.rs"].tombstone);
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn compaction_is_suggested_when_threshold_is_exceeded() -> io::Result<()> {
        let root = temp_dir("overlay-compact");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let mut config = EngineConfig::default();
        config.overlay_compaction_entry_threshold = 1;
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/a.rs")], &[], &[]);
        let summary = apply_change_batch(&root, &layout, &config, &batch)?;
        assert!(summary.compaction_suggested);
        assert!(summary.compaction_reason.is_some());
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn compaction_keeps_only_latest_entry_per_path() -> io::Result<()> {
        let root = temp_dir("overlay-latest-compact");
        fs::create_dir_all(root.join("src"))?;
        let mut config = EngineConfig::default();
        config.overlay_compaction_entry_threshold = 3;
        let layout = StoreLayout::for_workspace(&root, &config);
        let mut generation = 0;
        let mut last_summary = None;

        for idx in 0..3 {
            fs::write(
                root.join("src/a.rs"),
                format!("struct AlphaService{} {{}}\n", idx),
            )?;
            let batch = build_change_batch(generation, &[String::from("src/a.rs")], &[], &[]);
            let summary = apply_change_batch(&root, &layout, &config, &batch)?;
            generation = summary.generation;
            last_summary = Some(summary);
        }

        let summary = last_summary.expect("summary");
        assert!(summary.compaction_performed);
        assert!(!summary.compaction_suggested);
        assert_eq!(summary.overlay_total_entries, 1);
        assert_eq!(summary.latest_visible_entries, 1);
        assert_eq!(summary.journal_bytes, 0);

        let overlay = OverlayManifest::load(&layout.overlay_path)?;
        assert_eq!(overlay.entries.len(), 1);
        assert_eq!(overlay.entries[0].generation, generation);
        assert!(!layout.overlay_journal_path.exists());

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn replays_overlay_journal_when_manifest_is_missing() -> io::Result<()> {
        let root = temp_dir("overlay-replay");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let config = EngineConfig::default();
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/a.rs")], &[], &[]);
        let summary = apply_change_batch(&root, &layout, &config, &batch)?;
        assert_eq!(summary.entries_written, 1);
        fs::remove_file(&layout.overlay_path)?;

        let recovered = load_overlay_with_recovery(&layout)?;
        assert!(recovered.recovered);
        assert_eq!(recovered.manifest.latest_entries()["src/a.rs"].tombstone, false);
        assert!(layout.overlay_path.exists());

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn ignores_partial_journal_tail_during_recovery() -> io::Result<()> {
        let root = temp_dir("overlay-partial-journal");
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "struct AlphaService {}\n")?;
        let config = EngineConfig::default();
        let layout = StoreLayout::for_workspace(&root, &config);
        let batch = build_change_batch(0, &[String::from("src/a.rs")], &[], &[]);
        apply_change_batch(&root, &layout, &config, &batch)?;
        let journal = fs::read_to_string(&layout.overlay_journal_path)?;
        fs::write(&layout.overlay_journal_path, format!("{journal}{{\"generation\":2"))?;
        fs::remove_file(&layout.overlay_path)?;

        let recovered = load_overlay_with_recovery(&layout)?;
        assert!(recovered.recovered);
        assert!(!recovered.warnings.is_empty());
        assert_eq!(recovered.manifest.latest_entries()["src/a.rs"].generation, 1);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    impl OverlayManifest {
        fn load_json_for_test(text: &str) -> std::io::Result<Self> {
            super::parse_overlay_manifest(text)
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
