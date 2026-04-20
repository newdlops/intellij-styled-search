use crate::config::EngineConfig;
use std::fs;
use std::fs::File;
use std::io;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Debug)]
pub struct StoreLayout {
    pub root: PathBuf,
    pub manifest_path: PathBuf,
    pub overlay_path: PathBuf,
    pub overlay_journal_path: PathBuf,
}

impl StoreLayout {
    pub fn for_workspace(workspace_root: &Path, config: &EngineConfig) -> Self {
        let root = config.index_root(workspace_root);
        Self {
            manifest_path: root.join("manifest.json"),
            overlay_path: root.join("hot-overlay.json"),
            overlay_journal_path: root.join("overlay-journal.jsonl"),
            root,
        }
    }

    pub fn ensure_dirs(&self) -> io::Result<()> {
        fs::create_dir_all(&self.root)
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
        let len = file.metadata()?.len() as usize;
        if len == 0 {
            return Ok(Self {
                inner: MappedFileInner::Buffer(Vec::new()),
            });
        }

        #[cfg(unix)]
        {
            return Ok(Self {
                inner: MappedFileInner::Unix(UnixMappedFile::open(file, len)?),
            });
        }

        #[cfg(not(unix))]
        {
            return Ok(Self {
                inner: MappedFileInner::Buffer(fs::read(path)?),
            });
        }
    }
}

impl Deref for MappedFile {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        match &self.inner {
            MappedFileInner::Buffer(bytes) => bytes.as_slice(),
            #[cfg(unix)]
            MappedFileInner::Unix(mapped) => mapped.as_slice(),
        }
    }
}

enum MappedFileInner {
    Buffer(Vec<u8>),
    #[cfg(unix)]
    Unix(UnixMappedFile),
}

#[cfg(unix)]
struct UnixMappedFile {
    ptr: *mut u8,
    len: usize,
}

#[cfg(unix)]
impl UnixMappedFile {
    fn open(file: File, len: usize) -> io::Result<Self> {
        use std::ffi::c_void;
        use std::os::fd::AsRawFd;
        use std::os::raw::c_int;

        unsafe extern "C" {
            fn mmap(
                addr: *mut c_void,
                len: usize,
                prot: c_int,
                flags: c_int,
                fd: c_int,
                offset: i64,
            ) -> *mut c_void;
        }

        const PROT_READ: c_int = 0x1;
        const MAP_PRIVATE: c_int = 0x0002;
        let ptr = unsafe { mmap(std::ptr::null_mut(), len, PROT_READ, MAP_PRIVATE, file.as_raw_fd(), 0) };
        if ptr as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            ptr: ptr.cast::<u8>(),
            len,
        })
    }

    fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr.cast_const(), self.len) }
    }
}

#[cfg(unix)]
impl Drop for UnixMappedFile {
    fn drop(&mut self) {
        use std::ffi::c_void;
        use std::os::raw::c_int;

        unsafe extern "C" {
            fn munmap(addr: *mut c_void, len: usize) -> c_int;
        }

        unsafe {
            let _ = munmap(self.ptr.cast::<c_void>(), self.len);
        }
    }
}
