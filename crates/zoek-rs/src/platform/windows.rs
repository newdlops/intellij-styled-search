#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
pub(crate) const GRAPH_STORAGE_VERSION: u32 = 13;

/// NTFS/ReFS change time and file ID provide the independent identity that
/// std::fs::Metadata lacks on Windows. Failure keeps content verification on.
#[cfg(windows)]
pub(crate) fn metadata_change_identity(
    path: &Path,
    _metadata: &std::fs::Metadata,
) -> Option<[u64; 4]> {
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Default)]
    struct FileBasicInfo {
        creation_time: i64,
        last_access_time: i64,
        last_write_time: i64,
        change_time: i64,
        file_attributes: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct FileIdInfo {
        volume_serial_number: u64,
        file_id: [u8; 16],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }

    // FILE_READ_ATTRIBUTES avoids requiring data-read access just to inspect
    // metadata. The standard OpenOptions sharing flags allow concurrent I/O.
    let file = std::fs::OpenOptions::new()
        .access_mode(0x80)
        .open(path)
        .ok()?;
    let mut basic = FileBasicInfo::default();
    let mut identity = FileIdInfo::default();
    // SAFETY: file owns a live handle; buffers have the documented C layouts
    // and their exact sizes. FileBasicInfo=0 and FileIdInfo=18 are Win32 enums.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            0,
            (&mut basic as *mut FileBasicInfo).cast(),
            std::mem::size_of::<FileBasicInfo>() as u32,
        ) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                18,
                (&mut identity as *mut FileIdInfo).cast(),
                std::mem::size_of::<FileIdInfo>() as u32,
            ) != 0
    };
    if !ok || basic.change_time <= 0 || identity.file_id == [0; 16] {
        return None;
    }
    Some([
        identity.volume_serial_number,
        u64::from_le_bytes(identity.file_id[..8].try_into().ok()?),
        u64::from_le_bytes(identity.file_id[8..].try_into().ok()?),
        basic.change_time as u64,
    ])
}

#[cfg(windows)]
pub(crate) fn file_uri(path: &Path) -> String {
    file_uri_from_path(&path.to_string_lossy())
}

/// Match vscode.Uri.file(path).toString(), including drive and UNC casing.
/// Strip canonicalize's extended-length prefix before serializing a URI.
fn file_uri_from_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let normalized = if let Some(rest) = normalized.strip_prefix("//?/") {
        if rest
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC/"))
        {
            format!("//{}", &rest[4..])
        } else {
            rest.to_string()
        }
    } else {
        normalized
    };
    if let Some(unc) = normalized.strip_prefix("//") {
        let (server, path) = unc.split_once('/').unwrap_or((unc, ""));
        return format!(
            "file://{}/{}",
            super::percent_encode_path(&server.to_lowercase(), false),
            super::percent_encode_path(path, false)
        );
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        return format!(
            "file:///{}%3A{}",
            (bytes[0] as char).to_ascii_lowercase(),
            super::percent_encode_path(&normalized[2..], false)
        );
    }
    format!(
        "file:///{}",
        super::percent_encode_path(normalized.trim_start_matches('/'), false)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn file_change_identity_detects_same_size_edits_with_restored_mtime() -> std::io::Result<()> {
        let root = std::env::temp_dir().join(format!(
            "zoek-windows-metadata-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root)?;
        let path = root.join("source file.txt");
        std::fs::write(&path, "before")?;
        let metadata = std::fs::metadata(&path)?;
        let original_modified = metadata.modified()?;
        let before = metadata_change_identity(&path, &metadata)
            .expect("NTFS exposes change time and file ID");
        assert_eq!(metadata_change_identity(&path, &metadata), Some(before));
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&path, "after!")?;
        let file = std::fs::OpenOptions::new().write(true).open(&path)?;
        file.set_times(std::fs::FileTimes::new().set_modified(original_modified))?;
        drop(file);
        let changed = std::fs::metadata(&path)?;
        assert_eq!(changed.modified()?, original_modified);
        assert_eq!(changed.len(), metadata.len());
        let after = metadata_change_identity(&path, &changed)
            .expect("the changed file retains a usable identity");
        assert_ne!(
            after, before,
            "restoring mtime must not restore the independent change identity"
        );
        assert_eq!(
            metadata_change_identity(&root.join("missing"), &changed),
            None
        );
        std::fs::remove_dir_all(root)
    }

    #[test]
    fn serializes_drive_paths_like_vscode() {
        assert_eq!(
            file_uri_from_path(r"C:\Work Space\한글\source#.ts"),
            "file:///c%3A/Work%20Space/%ED%95%9C%EA%B8%80/source%23.ts"
        );
        assert_eq!(
            file_uri_from_path(r"\\?\D:\src\a%20b.ts"),
            "file:///d%3A/src/a%2520b.ts"
        );
        assert_eq!(file_uri_from_path("E:/src/a.ts"), "file:///e%3A/src/a.ts");
    }

    #[test]
    fn serializes_unc_and_extended_unc_paths_like_vscode() {
        let expected = "file://server/Share/a%20b.ts";
        assert_eq!(file_uri_from_path(r"\\SERVER\Share\a b.ts"), expected);
        assert_eq!(file_uri_from_path(r"\\?\UNC\SERVER\Share\a b.ts"), expected);
    }
}
