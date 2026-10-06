#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
pub(crate) fn file_uri(path: &Path) -> String {
    file_uri_from_path(&path.to_string_lossy())
}

/// Match vscode.Uri.file(path).toString(), including drive and UNC casing.
/// Strip canonicalize's extended-length prefix before serializing a URI.
fn file_uri_from_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let normalized = if let Some(rest) = normalized.strip_prefix("//?/") {
        if rest.get(..4).is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC/")) {
            format!("//{}", &rest[4..])
        } else {
            rest.to_string()
        }
    } else {
        normalized
    };
    if let Some(unc) = normalized.strip_prefix("//") {
        let (server, path) = unc.split_once('/').unwrap_or((unc, ""));
        return format!("file://{}/{}",
            super::percent_encode_path(&server.to_lowercase(), false),
            super::percent_encode_path(path, false));
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        return format!("file:///{}%3A{}", (bytes[0] as char).to_ascii_lowercase(),
            super::percent_encode_path(&normalized[2..], false));
    }
    format!("file:///{}", super::percent_encode_path(normalized.trim_start_matches('/'), false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_drive_paths_like_vscode() {
        assert_eq!(file_uri_from_path(r"C:\Work Space\한글\source#.ts"),
            "file:///c%3A/Work%20Space/%ED%95%9C%EA%B8%80/source%23.ts");
        assert_eq!(file_uri_from_path(r"\\?\D:\src\a%20b.ts"), "file:///d%3A/src/a%2520b.ts");
        assert_eq!(file_uri_from_path("E:/src/a.ts"), "file:///e%3A/src/a.ts");
    }

    #[test]
    fn serializes_unc_and_extended_unc_paths_like_vscode() {
        let expected = "file://server/Share/a%20b.ts";
        assert_eq!(file_uri_from_path(r"\\SERVER\Share\a b.ts"), expected);
        assert_eq!(file_uri_from_path(r"\\?\UNC\SERVER\Share\a b.ts"), expected);
    }
}
