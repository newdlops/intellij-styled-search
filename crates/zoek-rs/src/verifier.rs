use crate::config::EngineConfig;
use crate::corpus::{decode_bytes, looks_binary_bytes};
use crate::protocol::{SearchFileResult, SearchMatch};
use regex::{Regex, RegexBuilder};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const MAX_PREVIEW_CHARS: usize = 240;

#[derive(Clone, Debug)]
pub struct LoadedTextFile {
    pub text: String,
    pub byte_len: u64,
    pub modified_unix_secs: u64,
}

pub fn verify_literal(
    text: &str,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    limit: usize,
) -> Vec<SearchMatch> {
    if query.is_empty() {
        return Vec::new();
    }

    let pattern = regex::escape(query);
    let regex = match RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .build()
    {
        Ok(regex) => regex,
        Err(_) => return Vec::new(),
    };

    let mut matches = Vec::new();
    for found in regex.find_iter(text) {
        let start = found.start();
        let end = found.end();
        if !whole_word || is_word_boundary(text, start, end) {
            matches.push(build_match(text, start, end));
            if matches.len() >= limit {
                break;
            }
        }
    }

    matches
}

pub fn verify_regex(
    text: &str,
    pattern: &str,
    case_sensitive: bool,
    regex_multiline: bool,
    limit: usize,
) -> Result<Vec<SearchMatch>, regex::Error> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(regex_multiline)
        .dot_matches_new_line(regex_multiline)
        .build()?;
    let mut matches = Vec::new();
    if regex_multiline {
        for found in regex.find_iter(text) {
            matches.push(build_match(text, found.start(), found.end()));
            if matches.len() >= limit {
                break;
            }
        }
        return Ok(matches);
    }
    let bytes = text.as_bytes();
    let mut line_start = 0usize;
    while line_start <= text.len() {
        let line_end_raw = text[line_start..]
            .find('\n')
            .map(|offset| line_start + offset)
            .unwrap_or(text.len());
        let mut line_end = line_end_raw;
        if line_end > line_start && bytes.get(line_end - 1) == Some(&b'\r') {
            line_end -= 1;
        }
        let line = &text[line_start..line_end];
        for found in regex.find_iter(line) {
            matches.push(build_match(
                text,
                line_start + found.start(),
                line_start + found.end(),
            ));
            if matches.len() >= limit {
                return Ok(matches);
            }
        }
        if line_end_raw >= text.len() {
            break;
        }
        line_start = line_end_raw + 1;
    }
    Ok(matches)
}

pub fn load_current_text(path: &Path, config: &EngineConfig) -> io::Result<Option<LoadedTextFile>> {
    if config.is_binary_extension(path) || !path.exists() {
        return Ok(None);
    }
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if !metadata.is_file() || metadata.len() > config.max_file_size_bytes {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    if looks_binary_bytes(&bytes) {
        return Ok(None);
    }
    let (text, _) = decode_bytes(&bytes);
    let modified_unix_secs = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs())
        .unwrap_or(0);
    Ok(Some(LoadedTextFile {
        text,
        byte_len: metadata.len(),
        modified_unix_secs,
    }))
}

pub fn build_file_result(
    rel_path: String,
    byte_len: u64,
    modified_unix_secs: u64,
    score: i64,
    matches: Vec<SearchMatch>,
) -> SearchFileResult {
    SearchFileResult {
        rel_path,
        byte_len,
        modified_unix_secs,
        score,
        matches,
    }
}

pub fn matches_include_filters(rel_path: &str, include: &[String]) -> bool {
    if include.is_empty() {
        return true;
    }
    include.iter().any(|pattern| wildcard_match(pattern, rel_path))
}

fn build_match(text: &str, start: usize, end: usize) -> SearchMatch {
    let (line, start_column) = line_and_column(text, start);
    let (end_line_value, end_column) = line_and_column(text, end);
    let end_line = if end_line_value == line {
        None
    } else {
        Some(end_line_value)
    };
    SearchMatch {
        line,
        start_column,
        end_line,
        end_column,
        preview: build_preview(text, start, end),
    }
}

fn build_preview(text: &str, start: usize, end: usize) -> String {
    let line_start = text[..start].rfind('\n').map(|idx| idx + 1).unwrap_or(0);
    let line_end = text[end..]
        .find('\n')
        .map(|idx| end + idx)
        .unwrap_or(text.len());
    let excerpt = &text[line_start..line_end];
    if excerpt.chars().count() <= MAX_PREVIEW_CHARS {
        excerpt.to_string()
    } else {
        excerpt.chars().take(MAX_PREVIEW_CHARS).collect()
    }
}

fn line_and_column(text: &str, offset: usize) -> (usize, usize) {
    let bounded = offset.min(text.len());
    let line = text[..bounded].bytes().filter(|byte| *byte == b'\n').count();
    let line_start = text[..bounded].rfind('\n').map(|idx| idx + 1).unwrap_or(0);
    let column = text[line_start..bounded].chars().count();
    (line, column)
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let left = if start == 0 { None } else { text[..start].chars().next_back() };
    let right = text[end..].chars().next();
    !left.map(is_word_char).unwrap_or(false) && !right.map(is_word_char).unwrap_or(false)
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

// Ant-style glob semantics:
//   `**`       — matches any number of path segments (including `/`).
//   `**/X`     — any prefix path, then X in some segment.
//   `*`        — matches within a single segment (does NOT cross `/`).
//   `?`        — single char within a segment (not `/`).
//   `[abc]`    — character class, `[!abc]` negation.
// Implemented by translating to a rooted regex and caching compiled globs.
// The previous loose matcher treated `*` as `.*` (matched `/`) so patterns
// like `src/*.rs` incorrectly accepted `src/deep/file.rs`; it also made `**`
// equivalent to `*`, breaking selective "only direct child" expectations.
fn wildcard_match(pattern: &str, value: &str) -> bool {
    let re = match get_or_compile_glob(pattern) {
        Some(re) => re,
        None => return false,
    };
    re.is_match(value)
}

fn get_or_compile_glob(pattern: &str) -> Option<Regex> {
    static CACHE: Mutex<Option<GlobCache>> = Mutex::new(None);
    let mut guard = CACHE.lock().ok()?;
    let cache = guard.get_or_insert_with(GlobCache::default);
    if let Some(re) = cache.get(pattern) {
        return Some(re);
    }
    let regex_src = glob_to_regex_source(pattern);
    let compiled = Regex::new(&regex_src).ok()?;
    cache.insert(pattern.to_string(), compiled.clone());
    Some(compiled)
}

#[derive(Default)]
struct GlobCache {
    entries: Vec<(String, Regex)>,
}

impl GlobCache {
    fn get(&self, pattern: &str) -> Option<Regex> {
        self.entries
            .iter()
            .find(|(key, _)| key == pattern)
            .map(|(_, re)| re.clone())
    }
    fn insert(&mut self, pattern: String, re: Regex) {
        // Cap retained entries so long-running processes don't grow the
        // cache unboundedly from per-search scope variations.
        if self.entries.len() > 256 {
            self.entries.drain(..128);
        }
        self.entries.push((pattern, re));
    }
}

fn glob_to_regex_source(pattern: &str) -> String {
    let bytes = pattern.as_bytes();
    let mut out = String::from("^");
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        match ch {
            b'*' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    // `**`: dir-spanning if isolated as its own segment.
                    let at_segment_start = i == 0 || bytes[i - 1] == b'/';
                    let at_segment_end = i + 2 == bytes.len() || bytes[i + 2] == b'/';
                    if at_segment_start && at_segment_end {
                        if i + 2 < bytes.len() && bytes[i + 2] == b'/' {
                            // `**/` — zero or more full path segments.
                            out.push_str("(?:[^/]+/)*");
                            i += 3;
                        } else {
                            // trailing `**` — rest of the path (may include /).
                            out.push_str(".*");
                            i += 2;
                        }
                        continue;
                    }
                    // `**` glued into another segment → treat as `*`.
                    out.push_str("[^/]*");
                    i += 2;
                    continue;
                }
                // single `*` — within one segment.
                out.push_str("[^/]*");
                i += 1;
            }
            b'?' => {
                out.push_str("[^/]");
                i += 1;
            }
            b'[' => {
                // Character class. Scan until `]`.
                let mut j = i + 1;
                if j < bytes.len() && bytes[j] == b'!' {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b']' {
                    j += 1;
                }
                while j < bytes.len() && bytes[j] != b']' {
                    j += 1;
                }
                if j >= bytes.len() {
                    // Unterminated class — treat `[` as literal.
                    out.push_str("\\[");
                    i += 1;
                    continue;
                }
                out.push('[');
                let mut k = i + 1;
                if k < j && bytes[k] == b'!' {
                    out.push('^');
                    k += 1;
                }
                while k < j {
                    match bytes[k] {
                        b'\\' => {
                            out.push_str("\\\\");
                        }
                        b']' => {
                            out.push_str("\\]");
                        }
                        other => out.push(other as char),
                    }
                    k += 1;
                }
                out.push(']');
                i = j + 1;
            }
            b'.' | b'+' | b'(' | b')' | b'|' | b'^' | b'$' | b'\\' | b'{' | b'}' => {
                out.push('\\');
                out.push(ch as char);
                i += 1;
            }
            other => {
                out.push(other as char);
                i += 1;
            }
        }
    }
    out.push('$');
    out
}

#[cfg(test)]
mod tests {
    use super::{matches_include_filters, verify_literal, verify_regex};

    #[test]
    fn verifies_case_insensitive_whole_word_matches() {
        let matches = verify_literal("alpha Alpha alphaBeta", "alpha", false, true, 10);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 0);
    }

    #[test]
    fn verifies_unicode_literals_without_panicking() {
        let matches = verify_literal("가치\n다치\n한국어 지원", "치", false, false, 10);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 0);
        assert_eq!(matches[1].line, 1);
    }

    #[test]
    fn verifies_unicode_whole_word_boundaries() {
        let matches = verify_literal("한국어 한국어지원 한국어", "한국어", true, true, 10);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].start_column, 0);
        assert_eq!(matches[1].start_column, 10);
    }

    #[test]
    fn regex_reports_multiline_end_line() {
        let matches = verify_regex("foo\nbar\nbaz", "foo.*baz", true, true, 10).expect("regex must compile");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 0);
        assert_eq!(matches[0].end_line, Some(2));
    }

    #[test]
    fn regex_singleline_does_not_cross_line_boundaries() {
        let matches = verify_regex("foo\nbar\nbaz", "foo.*baz", true, false, 10).expect("regex must compile");
        assert!(matches.is_empty());
    }

    #[test]
    fn supports_simple_glob_filters() {
        assert!(matches_include_filters("src/demo/file.rs", &[String::from("src/*/*.rs")]));
        assert!(!matches_include_filters("tests/demo/file.py", &[String::from("src/*/*.rs")]));
    }

    #[test]
    fn star_does_not_cross_path_segments() {
        // Loose `*=.*` matching used to let `src/*.rs` accept nested paths.
        assert!(matches_include_filters("src/file.rs", &[String::from("src/*.rs")]));
        assert!(!matches_include_filters("src/deep/file.rs", &[String::from("src/*.rs")]));
    }

    #[test]
    fn double_star_spans_segments() {
        assert!(matches_include_filters("a/b/c/file.py", &[String::from("**/*.py")]));
        assert!(matches_include_filters("file.py", &[String::from("**/*.py")]));
        assert!(matches_include_filters("src/legal/test/foo.rs", &[String::from("**/test/**")]));
        assert!(!matches_include_filters("src/legal/other/foo.rs", &[String::from("**/test/**")]));
    }

    #[test]
    fn question_mark_is_single_segment_char() {
        assert!(matches_include_filters("a1.rs", &[String::from("a?.rs")]));
        assert!(!matches_include_filters("ab/c.rs", &[String::from("a?.rs")]));
    }
}
