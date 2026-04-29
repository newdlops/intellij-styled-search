use std::path::{Path, PathBuf};

pub const ENGINE_NAME: &str = "zoek-rs";
pub const PROTOCOL_VERSION: u32 = 1;
pub const SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub index_dir_name: String,
    pub max_file_size_bytes: u64,
    pub shard_target_bytes: u64,
    pub max_files_per_shard: usize,
    pub max_grams_per_file: usize,
    pub overlay_compaction_entry_threshold: usize,
    pub overlay_compaction_journal_bytes_threshold: u64,
    pub excluded_dir_names: Vec<String>,
    pub binary_file_extensions: Vec<String>,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            index_dir_name: ".zoek-rs".to_string(),
            max_file_size_bytes: 1_048_576,
            shard_target_bytes: 64 * 1024 * 1024,
            max_files_per_shard: 50_000,
            // 256 was low enough that large source files had many tokens
            // pruned from the index, causing false-negatives in gram AND
            // filtering. 8192 comfortably holds sliding-window grams for
            // typical source files (after dedup). Files that still exceed
            // the cap get their `gram_incomplete` flag set so the searcher
            // skips gram filtering for them — correctness wins without
            // unbounded size growth.
            max_grams_per_file: 8192,
            overlay_compaction_entry_threshold: 512,
            overlay_compaction_journal_bytes_threshold: 2 * 1024 * 1024,
            excluded_dir_names: vec![
                ".zoek-rs".to_string(),
                ".zoekt-rs".to_string(),
                ".git".to_string(),
                ".hg".to_string(),
                ".svn".to_string(),
                "node_modules".to_string(),
                "dist".to_string(),
                "build".to_string(),
                "out".to_string(),
                "coverage".to_string(),
                "target".to_string(),
            ],
            binary_file_extensions: vec![
                ".png".to_string(),
                ".jpg".to_string(),
                ".jpeg".to_string(),
                ".gif".to_string(),
                ".bmp".to_string(),
                ".ico".to_string(),
                ".webp".to_string(),
                ".pdf".to_string(),
                ".zip".to_string(),
                ".gz".to_string(),
                ".tar".to_string(),
                ".7z".to_string(),
                ".rar".to_string(),
                ".mp3".to_string(),
                ".mp4".to_string(),
                ".mov".to_string(),
                ".avi".to_string(),
                ".wav".to_string(),
                ".flac".to_string(),
                ".woff".to_string(),
                ".woff2".to_string(),
                ".ttf".to_string(),
                ".eot".to_string(),
                ".otf".to_string(),
                ".exe".to_string(),
                ".dll".to_string(),
                ".so".to_string(),
                ".dylib".to_string(),
                ".class".to_string(),
                ".o".to_string(),
                ".a".to_string(),
                ".wasm".to_string(),
                ".node".to_string(),
                ".pyc".to_string(),
                ".pyo".to_string(),
                ".rmeta".to_string(),
                ".rlib".to_string(),
            ],
        }
    }
}

impl EngineConfig {
    pub fn index_root(&self, workspace_root: &Path) -> PathBuf {
        workspace_root.join(&self.index_dir_name)
    }

    pub fn is_excluded_dir_name(&self, name: &str) -> bool {
        self.excluded_dir_names.iter().any(|entry| entry == name)
    }

    pub fn is_overlay_update_excluded_relative_path(&self, rel_path: &str) -> bool {
        rel_path
            .replace('\\', "/")
            .split('/')
            .any(|segment| segment == ".zoek-rs" || segment == ".zoekt-rs" || segment == "target")
    }

    pub fn is_binary_extension(&self, path: &Path) -> bool {
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_ascii_lowercase()));
        match ext {
            Some(ext) => self
                .binary_file_extensions
                .iter()
                .any(|entry| entry == &ext),
            None => false,
        }
    }
}
