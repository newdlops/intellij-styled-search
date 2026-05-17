use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub const ENGINE_NAME: &str = "zoek-rs";
pub const PROTOCOL_VERSION: u32 = 1;
pub const SCHEMA_VERSION: u32 = 19;

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
    pub exclude_patterns: Vec<String>,
    pub include_generated: bool,
    pub include_migrations: bool,
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
            exclude_patterns: Vec::new(),
            include_generated: true,
            include_migrations: true,
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
    pub fn for_workspace(workspace_root: &Path) -> Self {
        let mut config = Self::default();
        config.apply_project_config(workspace_root);
        config
    }

    fn apply_project_config(&mut self, workspace_root: &Path) {
        let config_path = workspace_root.join(".codeidx").join("config.json");
        let Ok(text) = fs::read_to_string(config_path) else {
            return;
        };
        if let Some(excludes) = parse_json_string_array(&text, "exclude") {
            self.exclude_patterns.extend(excludes);
        }
        if let Some(value) = parse_json_bool(&text, "includeGenerated") {
            self.include_generated = value;
        }
        if let Some(value) = parse_json_bool(&text, "includeMigrations") {
            self.include_migrations = value;
        }
        self.refresh_excluded_dir_names();
    }

    fn refresh_excluded_dir_names(&mut self) {
        let mut names: HashSet<String> = self.excluded_dir_names.iter().cloned().collect();
        if !self.include_generated {
            names.insert("generated".to_string());
        }
        if !self.include_migrations {
            names.insert("migrations".to_string());
        }
        for pattern in &self.exclude_patterns {
            if let Some(name) = excluded_dir_name_from_pattern(pattern) {
                names.insert(name);
            }
        }
        let mut names = names.into_iter().collect::<Vec<_>>();
        names.sort();
        self.excluded_dir_names = names;
    }

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
        let normalized = normalize_relative_path(rel_path);
        normalized
            .split('/')
            .any(|segment| self.is_internal_index_dir_name(segment))
            || self.is_excluded_relative_path(&normalized)
    }

    pub fn is_excluded_relative_path(&self, rel_path: &str) -> bool {
        let normalized = normalize_relative_path(rel_path);
        self.is_excluded_normalized_relative_path(&normalized)
    }

    pub fn is_excluded_normalized_relative_path(&self, normalized: &str) -> bool {
        if self.include_generated && self.include_migrations && self.exclude_patterns.is_empty() {
            return false;
        }
        if normalized.is_empty() {
            return false;
        }
        let segments = normalized.split('/').collect::<Vec<_>>();
        if !self.include_generated
            && segments
                .iter()
                .any(|segment| *segment == "generated" || segment.contains("generated"))
        {
            return true;
        }
        if !self.include_migrations && segments.iter().any(|segment| *segment == "migrations") {
            return true;
        }
        self.exclude_patterns
            .iter()
            .any(|pattern| glob_like_matches(pattern, &normalized))
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

fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

fn parse_json_bool(text: &str, key: &str) -> Option<bool> {
    let key_pos = text.find(&format!("\"{key}\""))?;
    let rest = &text[key_pos + key.len() + 2..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    if value.starts_with("true") {
        Some(true)
    } else if value.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn parse_json_string_array(text: &str, key: &str) -> Option<Vec<String>> {
    let key_pos = text.find(&format!("\"{key}\""))?;
    let rest = &text[key_pos + key.len() + 2..];
    let colon = rest.find(':')?;
    let after_colon = &rest[colon + 1..];
    let open = after_colon.find('[')?;
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for ch in after_colon[open + 1..].chars() {
        if in_string {
            if escaped {
                current.push(match ch {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                if !current.trim().is_empty() {
                    values.push(current.trim().to_string());
                }
                current.clear();
                in_string = false;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
        } else if ch == ']' {
            return Some(values);
        }
    }
    None
}

fn excluded_dir_name_from_pattern(pattern: &str) -> Option<String> {
    let normalized = normalize_relative_path(pattern.trim_matches('!'));
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let parts = trimmed.split('/').collect::<Vec<_>>();
    if parts.len() >= 2 && parts.first() == Some(&"**") && parts.last() == Some(&"**") {
        let candidate = parts[1];
        if is_plain_path_segment(candidate) {
            return Some(candidate.to_string());
        }
    }
    if parts.len() == 1 && is_plain_path_segment(parts[0]) {
        return Some(parts[0].to_string());
    }
    None
}

fn is_plain_path_segment(value: &str) -> bool {
    !value.is_empty() && !value.contains('*') && !value.contains('?') && !value.contains('[')
}

fn glob_like_matches(pattern: &str, rel_path: &str) -> bool {
    let pattern = normalize_relative_path(pattern.trim_matches('!'));
    if pattern.is_empty() {
        return false;
    }
    if let Some(dir) = excluded_dir_name_from_pattern(&pattern) {
        return rel_path.split('/').any(|segment| segment == dir);
    }
    glob_tokens_match(
        &pattern.split('/').collect::<Vec<_>>(),
        &rel_path.split('/').collect::<Vec<_>>(),
    )
}

fn glob_tokens_match(pattern: &[&str], path: &[&str]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern[0] == "**" {
        if glob_tokens_match(&pattern[1..], path) {
            return true;
        }
        return !path.is_empty() && glob_tokens_match(pattern, &path[1..]);
    }
    if path.is_empty() {
        return false;
    }
    segment_glob_match(pattern[0], path[0]) && glob_tokens_match(&pattern[1..], &path[1..])
}

fn segment_glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_text = 0usize;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            star_text = ti;
            pi += 1;
        } else if let Some(star_pos) = star {
            pi = star_pos + 1;
            star_text += 1;
            ti = star_text;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn project_config_excludes_common_generated_scopes() -> io::Result<()> {
        let root = temp_dir("zoek-config-scope");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".codeidx"))?;
        fs::write(
            root.join(".codeidx/config.json"),
            r#"{
              "exclude": ["**/node_modules/**", "**/.vscode/**"],
              "includeGenerated": false,
              "includeMigrations": false
            }"#,
        )?;

        let config = EngineConfig::for_workspace(&root);
        assert!(config.is_excluded_relative_path("zuzu/db/migrations/0001_initial.py"));
        assert!(config.is_excluded_relative_path("zuzu/client/src/generated/api.ts"));
        assert!(config.is_excluded_relative_path(".vscode/django-shell-editor/context.py"));
        assert!(config.is_excluded_relative_path("zuzu/client/node_modules/react/index.js"));
        assert!(!config.is_excluded_relative_path("zuzu/db/models.py"));

        let _ = fs::remove_dir_all(&root);
        Ok(())
    }

    #[test]
    fn default_config_keeps_migrations_and_generated_files_indexable() {
        let config = EngineConfig::default();
        assert!(!config.is_excluded_relative_path("zuzu/db/migrations/0001_initial.py"));
        assert!(!config.is_excluded_relative_path("zuzu/client/src/generated/api.ts"));
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("{prefix}-{unique}-{}", std::process::id()))
    }
}
