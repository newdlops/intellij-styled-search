//! Raw sidecar reads shared only while a builder owns one immutable graph base.
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(super) struct CountShardCache {
    entries: HashMap<PathBuf, Option<Arc<Vec<u8>>>>,
    order: VecDeque<PathBuf>,
    retained_bytes: usize,
    max_bytes: usize,
    pub(super) reads: usize,
    pub(super) hits: usize,
}

impl CountShardCache {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), retained_bytes: 0,
            max_bytes, reads: 0, hits: 0 }
    }

    pub(super) fn read(&mut self, path: &Path) -> io::Result<Option<Arc<Vec<u8>>>> {
        if let Some(bytes) = self.entries.get(path).cloned() {
            self.hits += 1;
            self.order.retain(|entry| entry != path);
            self.order.push_back(path.to_path_buf());
            return Ok(bytes);
        }
        self.reads += 1;
        let bytes = read_optional_shard(path)?;
        let weight = bytes.as_ref().map_or(0, |bytes| bytes.len());
        // Oversized shards remain transient. Missing/empty shards also obey
        // the entry limit, so metadata cannot grow independently of bytes.
        if self.max_bytes > 0 && weight <= self.max_bytes {
            while self.retained_bytes + weight > self.max_bytes || self.entries.len() >= 256 {
                let Some(oldest) = self.order.pop_front() else { break; };
                if let Some(bytes) = self.entries.remove(&oldest) {
                    self.retained_bytes -= bytes.as_ref().map_or(0, |bytes| bytes.len());
                }
            }
            self.retained_bytes += weight;
            self.entries.insert(path.to_path_buf(), bytes.clone());
            self.order.push_back(path.to_path_buf());
        }
        Ok(bytes)
    }
}

pub(super) fn read_optional_shard(path: &Path) -> io::Result<Option<Arc<Vec<u8>>>> {
    match fs::read(path) {
        // Move the Vec allocation into the owner instead of copying its bytes
        // into an Arc slice, especially for transient oversized shards.
        Ok(bytes) => Ok(Some(Arc::new(bytes))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_reads_without_changing_bytes_across_eviction_and_generations() -> io::Result<()> {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("count-shard-cache-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root)?;
        let a = root.join("a");
        let b = root.join("b");
        let large = root.join("large");
        fs::write(&a, b"aaaa")?;
        fs::write(&b, b"bbbb")?;
        fs::write(&large, b"123456789")?;
        let mut cache = CountShardCache::new(4);
        assert_eq!(&*cache.read(&a)?.unwrap(), b"aaaa");
        assert_eq!(&*cache.read(&a)?.unwrap(), b"aaaa");
        assert_eq!((cache.reads, cache.hits), (1, 1));
        assert_eq!(&*cache.read(&b)?.unwrap(), b"bbbb");
        assert_eq!(&*cache.read(&a)?.unwrap(), b"aaaa");
        assert_eq!(cache.reads, 3, "evicted data must be read again");
        for _ in 0..2 { assert_eq!(&*cache.read(&large)?.unwrap(), b"123456789"); }
        assert_eq!(cache.reads, 5, "oversized data cannot displace retained small shards");
        assert!(cache.retained_bytes <= 4);
        assert!(!cache.entries.contains_key(&large));
        fs::write(&a, b"next")?;
        assert_eq!(&*CountShardCache::new(4).read(&a)?.unwrap(), b"next", "a new base must use a new cache");
        for i in 0..300 { assert!(cache.read(&root.join(format!("missing-{i}")))?.is_none()); }
        assert!(cache.entries.len() <= 256);
        assert!(cache.retained_bytes <= 4);
        assert_eq!(&*CountShardCache::new(0).read(&a)?.unwrap(), b"next");
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
