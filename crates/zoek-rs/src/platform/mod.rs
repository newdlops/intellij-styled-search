#[cfg(not(windows))]
mod posix;
#[cfg(any(windows, test))]
mod windows;

#[cfg(not(windows))]
pub(crate) use posix::file_uri;
#[cfg(windows)]
pub(crate) use windows::file_uri;

fn percent_encode_path(value: &str, allow_colon: bool) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '/' | '-' | '_' | '.' | '~')
            || (allow_colon && ch == ':')
        {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
