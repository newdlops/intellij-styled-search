use std::path::{Path, PathBuf};

pub const ENGINE_NAME: &str = "zoek-rs";
pub const PROTOCOL_VERSION: u32 = 1;
pub const SCHEMA_VERSION: u32 = 10;

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
            shard_target_bytes: 40 * 1024 * 1024,
            // Keep tiny-file monorepos from producing hundreds of shard files.
            // Byte limits still split normal/larger source files; this cap is
            // mainly for 1M-file repos where process-per-search shard opens
            // dominate latency.
            max_files_per_shard: 50_000,
            // Large generated or minified text files can emit enormous sliding
            // gram sets. Keep a tighter per-file budget and mark overflowed
            // docs `gram_incomplete`; search includes those docs before exact
            // verification, so this trades some candidate expansion for much
            // lower cold indexing cost without false negatives.
            max_grams_per_file: 512,
            overlay_compaction_entry_threshold: 512,
            overlay_compaction_journal_bytes_threshold: 2 * 1024 * 1024,
            excluded_dir_names: Vec::new(),
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
                ".mo".to_string(),
                ".bcmap".to_string(),
                ".mat".to_string(),
                ".sav".to_string(),
                ".npy".to_string(),
                ".pfb".to_string(),
                ".bare".to_string(),
                ".npz".to_string(),
                ".xlsx".to_string(),
                ".dat".to_string(),
                ".pkl".to_string(),
                ".bfbs".to_string(),
                ".docx".to_string(),
                ".cur".to_string(),
                ".bplist".to_string(),
                ".bz2".to_string(),
                ".parquet".to_string(),
                ".gzip".to_string(),
                ".xz".to_string(),
                ".lzma".to_string(),
                ".orc".to_string(),
                ".nc".to_string(),
                ".z".to_string(),
                ".oxt".to_string(),
                ".obj".to_string(),
                ".bin".to_string(),
                ".feather".to_string(),
                ".jar".to_string(),
                ".ani".to_string(),
                ".plist".to_string(),
                ".aep".to_string(),
                ".mod".to_string(),
                ".egg".to_string(),
                ".icc".to_string(),
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

    pub fn is_internal_index_dir_name(&self, name: &str) -> bool {
        name == self.index_dir_name || name == ".zoekt-rs"
    }

    pub fn is_overlay_update_excluded_relative_path(&self, rel_path: &str) -> bool {
        rel_path
            .replace('\\', "/")
            .split('/')
            .any(|segment| self.is_internal_index_dir_name(segment))
    }

    pub fn is_binary_extension(&self, path: &Path) -> bool {
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == ".DS_Store")
        {
            return true;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            return false;
        };
        self.binary_file_extensions.iter().any(|entry| {
            entry
                .strip_prefix('.')
                .is_some_and(|binary_ext| binary_ext.eq_ignore_ascii_case(ext))
        })
    }
}
