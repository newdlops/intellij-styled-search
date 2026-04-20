use crate::config::EngineConfig;
use crate::corpus::{decode_bytes, looks_binary_bytes};
use crate::protocol::{SearchFileResult, SearchMatch};
use regex::RegexBuilder;
use std::fs;
use std::io;
use std::path::Path;
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
    limit: usize,
) -> Result<Vec<SearchMatch>, regex::Error> {
    if pattern.is_empty() {
        return Ok(Vec::new());
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .dot_matches_new_line(true)
        .build()?;
    let mut matches = Vec::new();
    for found in regex.find_iter(text) {
        matches.push(build_match(text, found.start(), found.end()));
        if matches.len() >= limit {
            break;
        }
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
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern_bytes = pattern.as_bytes();
    let value_bytes = value.as_bytes();
    let (mut p, mut v) = (0usize, 0usize);
    let mut star = None;
    let mut match_from = 0usize;

    while v < value_bytes.len() {
        if p < pattern_bytes.len() && (pattern_bytes[p] == b'?' || pattern_bytes[p] == value_bytes[v]) {
            p += 1;
            v += 1;
        } else if p < pattern_bytes.len() && pattern_bytes[p] == b'*' {
            star = Some(p);
            match_from = v;
            p += 1;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            match_from += 1;
            v = match_from;
        } else {
            return false;
        }
    }

    while p < pattern_bytes.len() && pattern_bytes[p] == b'*' {
        p += 1;
    }
    p == pattern_bytes.len()
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
    fn regex_reports_multiline_end_line() {
        let matches = verify_regex("foo\nbar\nbaz", "foo.*baz", true, 10).expect("regex must compile");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 0);
        assert_eq!(matches[0].end_line, Some(2));
    }

    #[test]
    fn supports_simple_glob_filters() {
        assert!(matches_include_filters("src/demo/file.rs", &[String::from("src/*/*.rs")]));
        assert!(!matches_include_filters("tests/demo/file.py", &[String::from("src/*/*.rs")]));
    }
}
