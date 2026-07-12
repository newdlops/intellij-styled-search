use crate::config::EngineConfig;
use std::fs;
use std::fs::File;
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug)]
pub struct StoreLayout {
    pub workspace_root: PathBuf,
    pub root: PathBuf,
    pub manifest_path: PathBuf,
    pub overlay_path: PathBuf,
    pub overlay_journal_path: PathBuf,
}

impl StoreLayout {
    pub fn for_workspace(workspace_root: &Path, config: &EngineConfig) -> Self {
        let root = config.index_root(workspace_root);
        Self {
            workspace_root: workspace_root.to_path_buf(),
            manifest_path: root.join("manifest.json"),
            overlay_path: root.join("hot-overlay.json"),
            overlay_journal_path: root.join("overlay-journal.jsonl"),
            root,
        }
    }

    pub fn ensure_dirs(&self) -> io::Result<()> {
        fs::create_dir_all(&self.root)
    }

    pub fn write_lock_path(&self) -> PathBuf {
        self.root.join("search-index.lock")
    }

    pub fn workspace_relative_root(&self, workspace_root: &Path) -> Option<String> {
        let Ok(workspace_root) = fs::canonicalize(workspace_root) else {
            return None;
        };
        let Ok(index_root) = fs::canonicalize(&self.root) else {
            return None;
        };
        let Ok(relative_root) = index_root.strip_prefix(&workspace_root) else {
            return None;
        };
        Some(normalize_relative_path(
            relative_root.to_string_lossy().as_ref(),
        ))
    }

    pub fn relative_path_is_within_root(relative_root: Option<&str>, rel_path: &str) -> bool {
        let Some(prefix) = relative_root else {
            return false;
        };
        let candidate = normalize_relative_path(rel_path);
        if prefix.is_empty() {
            return true;
        }
        candidate == prefix
            || candidate
                .strip_prefix(&prefix)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    pub fn shard_file_name(&self, shard_id: u32) -> String {
        format!("base-shard-{shard_id:04}.zrs")
    }

    pub fn shard_path(&self, shard_id: u32) -> PathBuf {
        self.root.join(self.shard_file_name(shard_id))
    }

    pub fn clear_stale_base_shards(&self) -> io::Result<()> {
        if !self.root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("base-shard-") && name.ends_with(".zrs") {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub fn clear_base_shards_from(&self, first_stale_id: usize) -> io::Result<()> {
        if !self.root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(shard_id) = parse_base_shard_id(&name) else {
                continue;
            };
            if shard_id >= first_stale_id {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub fn list_shard_paths(&self) -> io::Result<Vec<PathBuf>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut paths = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("base-shard-") && name.ends_with(".zrs") {
                paths.push(path);
            }
        }
        paths.sort();
        Ok(paths)
    }

    pub fn cleanup_stale_temp_files(&self, max_age_secs: u64) -> io::Result<Vec<String>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let now = SystemTime::now();
        let mut removed = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy().into_owned();
            if !name.ends_with(".tmp") {
                continue;
            }
            if max_age_secs > 0 {
                let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let age_secs = now
                    .duration_since(modified)
                    .map(|value| value.as_secs())
                    .unwrap_or(0);
                if age_secs < max_age_secs {
                    continue;
                }
            }
            fs::remove_file(&path)?;
            removed.push(name);
        }
        removed.sort();
        Ok(removed)
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

/// Serialize base rebuilds and overlay mutations for one search index.
///
/// The file itself is intentionally persistent; the operating system releases
/// the lock when the owning process exits, including forced exits.
/// Keeping the file avoids stale sentinel recovery and lets a rebuild wait for
/// an update process that has received a termination signal but has not exited
/// yet.
pub struct IndexWriteGuard {
    _file: File,
}

pub struct IndexReadGuard {
    _file: File,
}

impl Drop for IndexWriteGuard {
    fn drop(&mut self) {
        let _ = File::unlock(&self._file);
    }
}

impl Drop for IndexReadGuard {
    fn drop(&mut self) {
        let _ = File::unlock(&self._file);
    }
}

pub fn acquire_index_write_lock(layout: &StoreLayout) -> io::Result<IndexWriteGuard> {
    layout.ensure_dirs()?;
    let lock_path = layout.write_lock_path();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    file.lock()?;
    Ok(IndexWriteGuard { _file: file })
}

pub fn acquire_index_read_lock(layout: &StoreLayout) -> io::Result<Option<IndexReadGuard>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .open(layout.write_lock_path())
    {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound && !layout.manifest_path.exists() => {
            return Ok(None)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "search index lock is missing; rebuild the index before reading it",
            ))
        }
        Err(err) => return Err(err),
    };
    match file.try_lock_shared() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "search index is being updated at {}; retry or use the fallback search",
                    layout.write_lock_path().display()
                ),
            ))
        }
        Err(fs::TryLockError::Error(err)) => return Err(err),
    }
    Ok(Some(IndexReadGuard { _file: file }))
}

fn parse_base_shard_id(name: &str) -> Option<usize> {
    let id = name.strip_prefix("base-shard-")?.strip_suffix(".zrs")?;
    id.parse().ok()
}

pub fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut temp_name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "temp".to_string());
    temp_name.push_str(".tmp");
    let temp_path = path.with_file_name(temp_name);
    fs::write(&temp_path, bytes)?;
    fs::rename(temp_path, path)?;
    Ok(())
}

pub struct MappedFile {
    inner: MappedFileInner,
}

impl MappedFile {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        if len == 0 {
            return Ok(Self {
                inner: MappedFileInner::Buffer(Vec::new()),
            });
        }
        let mapped = unsafe { memmap2::Mmap::map(&file)? };
        Ok(Self {
            inner: MappedFileInner::Mapped(mapped),
        })
    }
}

impl Deref for MappedFile {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        match &self.inner {
            MappedFileInner::Buffer(bytes) => bytes.as_slice(),
            MappedFileInner::Mapped(mapped) => mapped.as_ref(),
        }
    }
}

enum MappedFileInner {
    Buffer(Vec<u8>),
    Mapped(memmap2::Mmap),
}

#[cfg(test)]
mod tests {
    use super::{acquire_index_read_lock, acquire_index_write_lock, StoreLayout};
    use crate::config::EngineConfig;
    use std::fs;
    use std::fs::TryLockError;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn index_write_lock_is_exclusive_until_the_guard_drops() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root =
            std::env::temp_dir().join(format!("zoek-rs-write-lock-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).expect("create neutral lock fixture");
        let layout = StoreLayout::for_workspace(&root, &EngineConfig::default());
        let first = acquire_index_write_lock(&layout).expect("acquire first write lock");
        let second = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(layout.write_lock_path())
            .expect("open second lock descriptor");

        assert!(
            matches!(second.try_lock(), Err(TryLockError::WouldBlock)),
            "a second writer must not acquire the lock",
        );
        let read_error = acquire_index_read_lock(&layout)
            .err()
            .expect("a reader must not block behind an active writer");
        assert_eq!(read_error.kind(), std::io::ErrorKind::WouldBlock);
        drop(first);
        second
            .try_lock()
            .expect("dropping the guard must release the lock");

        drop(second);
        let mut permissions = fs::metadata(layout.write_lock_path())
            .expect("stat lock file")
            .permissions();
        permissions.set_readonly(true);
        fs::set_permissions(layout.write_lock_path(), permissions.clone())
            .expect("make lock file read-only");
        let read_guard = acquire_index_read_lock(&layout)
            .expect("read-only lock file must support shared locks")
            .expect("lock file exists");
        drop(read_guard);
        permissions.set_readonly(false);
        fs::set_permissions(layout.write_lock_path(), permissions)
            .expect("restore lock permissions");
        fs::remove_dir_all(root).expect("remove neutral lock fixture");
    }

    #[test]
    fn existing_manifest_without_a_lock_is_not_read_without_serialization() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "zoek-rs-missing-lock-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join(".zoek-rs")).expect("create neutral lock fixture");
        let layout = StoreLayout::for_workspace(&root, &EngineConfig::default());
        fs::write(&layout.manifest_path, "{}").expect("write manifest sentinel");

        let error = acquire_index_read_lock(&layout)
            .err()
            .expect("a manifest without its lock must be rejected");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);

        fs::remove_dir_all(root).expect("remove neutral lock fixture");
    }
}
