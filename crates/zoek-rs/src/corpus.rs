use crate::config::EngineConfig;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    LossyUtf8,
}

#[derive(Clone, Debug)]
pub struct CorpusEntry {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub text: String,
    pub size_bytes: u64,
    pub modified_unix_secs: u64,
    pub encoding: TextEncoding,
}

#[derive(Clone, Debug, Default)]
pub struct CorpusStats {
    pub visited_files: usize,
    pub indexed_files: usize,
    pub skipped_binary: usize,
    pub skipped_binary_extension: usize,
    pub skipped_too_large: usize,
    pub skipped_dirs: usize,
    pub decoded_utf16_files: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct CorpusProgress {
    pub visited_files: usize,
    pub total_candidate_files: usize,
}

pub fn discover_text_files(
    workspace_root: &Path,
    config: &EngineConfig,
) -> io::Result<(Vec<CorpusEntry>, CorpusStats)> {
    let mut entries = Vec::new();
    let mut stats = CorpusStats::default();
    let mut noop = |_progress: CorpusProgress| {};
    walk_dir(
        workspace_root,
        workspace_root,
        config,
        0,
        &mut entries,
        &mut stats,
        &mut noop,
    )?;
    entries.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok((entries, stats))
}

pub fn count_candidate_files(workspace_root: &Path, config: &EngineConfig) -> io::Result<usize> {
    count_files_dir(workspace_root, workspace_root, config)
}

pub fn discover_text_files_with_progress<F>(
    workspace_root: &Path,
    config: &EngineConfig,
    total_candidate_files: usize,
    progress: &mut F,
) -> io::Result<(Vec<CorpusEntry>, CorpusStats)>
where
    F: FnMut(CorpusProgress),
{
    let mut entries = Vec::new();
    let mut stats = CorpusStats::default();
    walk_dir(
        workspace_root,
        workspace_root,
        config,
        total_candidate_files,
        &mut entries,
        &mut stats,
        progress,
    )?;
    entries.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok((entries, stats))
}

fn walk_dir(
    dir: &Path,
    workspace_root: &Path,
    config: &EngineConfig,
    total_candidate_files: usize,
    entries: &mut Vec<CorpusEntry>,
    stats: &mut CorpusStats,
    progress: &mut impl FnMut(CorpusProgress),
) -> io::Result<()> {
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if config.is_excluded_dir_name(&name) || path == config.index_root(workspace_root) {
                stats.skipped_dirs += 1;
                continue;
            }
            walk_dir(
                &path,
                workspace_root,
                config,
                total_candidate_files,
                entries,
                stats,
                progress,
            )?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

        stats.visited_files += 1;
        if total_candidate_files > 0
            && (stats.visited_files == 1
                || stats.visited_files % 128 == 0
                || stats.visited_files == total_candidate_files)
        {
            progress(CorpusProgress {
                visited_files: stats.visited_files,
                total_candidate_files,
            });
        }
        if metadata.len() > config.max_file_size_bytes {
            stats.skipped_too_large += 1;
            continue;
        }
        if config.is_binary_extension(&path) {
            stats.skipped_binary_extension += 1;
            continue;
        }

        let bytes = fs::read(&path)?;
        if looks_binary_bytes(&bytes) {
            stats.skipped_binary += 1;
            continue;
        }

        let (text, encoding) = decode_bytes(&bytes);
        if matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16Be) {
            stats.decoded_utf16_files += 1;
        }

        let rel_path = normalize_rel_path(path.strip_prefix(workspace_root).unwrap_or(&path));
        let modified_unix_secs = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs())
            .unwrap_or(0);
        entries.push(CorpusEntry {
            rel_path,
            abs_path: path,
            text,
            size_bytes: metadata.len(),
            modified_unix_secs,
            encoding,
        });
        stats.indexed_files += 1;
    }
    Ok(())
}

fn count_files_dir(dir: &Path, workspace_root: &Path, config: &EngineConfig) -> io::Result<usize> {
    let mut total = 0usize;
    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        let metadata = item.metadata()?;
        if metadata.is_dir() {
            let file_name = item.file_name();
            let name = file_name.to_string_lossy();
            if config.is_excluded_dir_name(&name) || path == config.index_root(workspace_root) {
                continue;
            }
            total += count_files_dir(&path, workspace_root, config)?;
            continue;
        }
        if metadata.is_file() {
            total += 1;
        }
    }
    Ok(total)
}

fn normalize_rel_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("/")
}

pub fn looks_binary_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    if has_utf16_bom(bytes) {
        return false;
    }
    let sample_len = bytes.len().min(4096);
    bytes[..sample_len].iter().any(|byte| *byte == 0)
}

fn has_utf16_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff])
}

pub fn decode_bytes(bytes: &[u8]) -> (String, TextEncoding) {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            TextEncoding::Utf8Bom,
        );
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return (decode_utf16_units(&bytes[2..], true), TextEncoding::Utf16Le);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return (
            decode_utf16_units(&bytes[2..], false),
            TextEncoding::Utf16Be,
        );
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => (text, TextEncoding::Utf8),
        Err(err) => (
            String::from_utf8_lossy(&err.into_bytes()).into_owned(),
            TextEncoding::LossyUtf8,
        ),
    }
}

fn decode_utf16_units(bytes: &[u8], little_endian: bool) -> String {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    let mut idx = 0;
    while idx + 1 < bytes.len() {
        let pair = [bytes[idx], bytes[idx + 1]];
        let unit = if little_endian {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        };
        units.push(unit);
        idx += 2;
    }
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::{discover_text_files, TextEncoding};
    use crate::config::EngineConfig;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn decodes_utf16_and_skips_known_binary_extensions() -> io::Result<()> {
        let root = temp_dir("corpus");
        fs::create_dir_all(&root)?;
        fs::write(root.join("plain.rs"), "struct AlphaService;\n")?;
        fs::write(root.join("image.png"), [0x89, b'P', b'N', b'G'])?;
        fs::write(
            root.join("utf16.txt"),
            vec![0xff, 0xfe, b'h', 0x00, b'i', 0x00, b'!', 0x00],
        )?;

        let (entries, stats) = discover_text_files(&root, &EngineConfig::default())?;
        assert_eq!(entries.len(), 2);
        assert_eq!(stats.skipped_binary_extension, 1);
        assert_eq!(stats.decoded_utf16_files, 1);
        assert!(entries
            .iter()
            .any(|entry| entry.encoding == TextEncoding::Utf16Le && entry.text == "hi!"));

        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn skips_internal_index_dirs_by_default() -> io::Result<()> {
        let root = temp_dir("corpus-internal-index-dirs");
        fs::create_dir_all(root.join(".zoek-rs"))?;
        fs::create_dir_all(root.join(".zoekt-rs"))?;
        fs::write(root.join("plain.rs"), "struct AlphaService;\n")?;
        fs::write(
            root.join(".zoek-rs/overlay-journal.jsonl"),
            "{\"generation\":1}\n",
        )?;
        fs::write(
            root.join(".zoekt-rs/stale-overlay.txt"),
            "stale index data\n",
        )?;

        let (entries, stats) = discover_text_files(&root, &EngineConfig::default())?;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "plain.rs");
        assert!(stats.skipped_dirs >= 2);

        fs::remove_dir_all(root)?;
        Ok(())
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("zoek-rs-{label}-{}-{nonce}", std::process::id()))
    }
}
