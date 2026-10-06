use std::path::Path;

pub(crate) const GRAPH_STORAGE_VERSION: u32 = 12;

pub(crate) fn metadata_change_identity(
    _path: &Path,
    metadata: &std::fs::Metadata,
) -> Option<[u64; 4]> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some([
            metadata.dev(),
            metadata.ino(),
            metadata.ctime() as u64,
            metadata.ctime_nsec() as u64,
        ])
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

pub(crate) fn file_uri(path: &Path) -> String {
    format!(
        "file://{}",
        super::percent_encode_path(&path.to_string_lossy(), true)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_posix_paths_and_literal_backslashes() {
        assert_eq!(
            file_uri(Path::new("/workspace/a b#c.py")),
            "file:///workspace/a%20b%23c.py"
        );
        assert_eq!(
            file_uri(Path::new(r"/workspace/a\b.py")),
            "file:///workspace/a%5Cb.py"
        );
    }
}
