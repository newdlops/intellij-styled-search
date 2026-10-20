use crate::config::EngineConfig;
use crate::corpus::{decode_bytes, looks_binary_bytes};
use crate::protocol::{SearchFileResult, SearchMatch};
use regex::{Regex, RegexBuilder};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
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
    PreparedVerifier::literal(query, case_sensitive, whole_word).verify(text, limit)
}

pub fn verify_regex(
    text: &str,
    pattern: &str,
    case_sensitive: bool,
    regex_multiline: bool,
    limit: usize,
) -> Result<Vec<SearchMatch>, regex::Error> {
    Ok(PreparedVerifier::regex(pattern, case_sensitive, regex_multiline)?.verify(text, limit))
}

/// Query-scoped compiled state. Clone once per worker so each worker can reuse
/// its regex search cache without competing for another worker's cache.
#[derive(Clone, Debug)]
pub(crate) struct PreparedVerifier {
    regex: Option<Regex>,
    whole_word: bool,
    line_by_line: bool,
}

impl PreparedVerifier {
    pub(crate) fn literal(query: &str, case_sensitive: bool, whole_word: bool) -> Self {
        // Editor selections use logical line breaks; accept LF and CRLF files.
        let regex = if query.is_empty() {
            None
        } else {
            let pattern = if query.contains('\n') {
                query
                    .replace("\r\n", "\n")
                    .split('\n')
                    .map(regex::escape)
                    .collect::<Vec<_>>()
                    .join(r"\r?\n")
            } else {
                regex::escape(query)
            };
            // Keep the existing literal API's behavior on regex size limits.
            RegexBuilder::new(&pattern)
                .case_insensitive(!case_sensitive)
                .multi_line(true)
                .build()
                .ok()
        };
        Self {
            regex,
            whole_word,
            line_by_line: false,
        }
    }

    pub(crate) fn regex(
        pattern: &str,
        case_sensitive: bool,
        regex_multiline: bool,
    ) -> Result<Self, regex::Error> {
        let regex = if pattern.is_empty() {
            None
        } else {
            Some(
                RegexBuilder::new(pattern)
                    .case_insensitive(!case_sensitive)
                    .multi_line(regex_multiline)
                    .dot_matches_new_line(regex_multiline)
                    .build()?,
            )
        };
        Ok(Self {
            regex,
            whole_word: false,
            line_by_line: !regex_multiline,
        })
    }

    pub(crate) fn verify(&self, text: &str, limit: usize) -> Vec<SearchMatch> {
        let Some(regex) = &self.regex else {
            return Vec::new();
        };
        let mut matches = Vec::new();
        let mut builder = MatchBuilder::new(text);
        if !self.line_by_line {
            for found in regex.find_iter(text) {
                if !self.whole_word || is_word_boundary(text, found.start(), found.end()) {
                    matches.push(builder.build(found.start(), found.end()));
                    if matches.len() >= limit {
                        break;
                    }
                }
            }
            return matches;
        }
        let mut line_start = 0usize;
        // split preserves empty and trailing lines and borrows each slice. Keep
        // the raw length for byte offsets while removing one CR for matching.
        for raw_line in text.split('\n') {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            for found in regex.find_iter(line) {
                matches.push(builder.build(line_start + found.start(), line_start + found.end()));
                if matches.len() >= limit {
                    return matches;
                }
            }
            line_start += raw_line.len() + 1;
        }
        matches
    }
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
    include
        .iter()
        .any(|pattern| wildcard_match(pattern, rel_path))
}

pub fn matches_exclude_filters(rel_path: &str, exclude: &[String]) -> bool {
    !exclude
        .iter()
        .any(|pattern| wildcard_match(pattern, rel_path))
}

pub fn matches_path_filters(rel_path: &str, include: &[String], exclude: &[String]) -> bool {
    matches_include_filters(rel_path, include) && matches_exclude_filters(rel_path, exclude)
}

/// Request-local glob matchers. Preserve pattern order and short-circuiting,
/// initializing only the patterns reached by a candidate path. Each matcher
/// reuses its regex search cache instead of cloning one for every file.
pub(crate) struct PreparedPathFilters<'a> {
    include: Vec<PreparedGlob<'a>>,
    exclude: Vec<PreparedGlob<'a>>,
}

impl<'a> PreparedPathFilters<'a> {
    pub(crate) fn new(include: &'a [String], exclude: &'a [String]) -> Self {
        let prepare = |patterns: &'a [String]| {
            patterns
                .iter()
                .map(|pattern| PreparedGlob {
                    pattern,
                    regex: OnceLock::new(),
                })
                .collect()
        };
        Self {
            include: prepare(include),
            exclude: prepare(exclude),
        }
    }

    pub(crate) fn is_match(&self, rel_path: &str) -> bool {
        (self.include.is_empty() || self.include.iter().any(|glob| glob.is_match(rel_path)))
            && !self.exclude.iter().any(|glob| glob.is_match(rel_path))
    }
}

struct PreparedGlob<'a> {
    pattern: &'a str,
    regex: OnceLock<Option<Regex>>,
}

impl PreparedGlob<'_> {
    fn is_match(&self, path: &str) -> bool {
        self.regex
            .get_or_init(|| get_or_compile_glob(self.pattern))
            .as_ref()
            .is_some_and(|regex| regex.is_match(path))
    }
}

/// find_iter yields non-overlapping, ordered byte ranges. Advance through the
/// text once instead of rescanning its prefix for every match's two positions.
/// State is constant-sized even for files containing millions of empty lines.
struct MatchBuilder<'a> {
    text: &'a str,
    offset: usize,
    line: usize,
    column: usize,
    line_start: usize,
    preview_line_end: Option<usize>,
}

impl<'a> MatchBuilder<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            offset: 0,
            line: 0,
            column: 0,
            line_start: 0,
            preview_line_end: None,
        }
    }

    fn advance_to(&mut self, offset: usize) {
        debug_assert!(offset >= self.offset);
        let segment = &self.text[self.offset..offset];
        if let Some(newline) = segment.rfind('\n') {
            self.line += segment.bytes().filter(|byte| *byte == b'\n').count();
            self.column = segment[newline + 1..].chars().count();
            self.line_start = self.offset + newline + 1;
        } else {
            self.column += segment.chars().count();
        }
        self.offset = offset;
    }

    fn build(&mut self, start: usize, end: usize) -> SearchMatch {
        self.advance_to(start);
        let line = self.line;
        let start_column = self.column;
        let line_start = self.line_start;
        self.advance_to(end);
        let line_end = match self.preview_line_end {
            Some(cached) if end <= cached => cached,
            _ => {
                let line_end = self.text[end..]
                    .find('\n')
                    .map(|idx| end + idx)
                    .unwrap_or(self.text.len());
                self.preview_line_end = Some(line_end);
                line_end
            }
        };
        // Locate at most 241 characters, then allocate the exact byte length.
        // Short Unicode previews need no intermediate growing String either.
        let excerpt = &self.text[line_start..line_end];
        let preview_end = excerpt
            .char_indices()
            .nth(MAX_PREVIEW_CHARS)
            .map_or(excerpt.len(), |(idx, _)| idx);
        SearchMatch {
            line,
            start_column,
            end_line: (self.line != line).then_some(self.line),
            end_column: self.column,
            preview: excerpt[..preview_end].to_string(),
        }
    }
}

fn is_word_boundary(text: &str, start: usize, end: usize) -> bool {
    let left = if start == 0 {
        None
    } else {
        text[..start].chars().next_back()
    };
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
    use super::{
        matches_include_filters, matches_path_filters, verify_literal, verify_regex, MatchBuilder,
        PreparedPathFilters, PreparedVerifier,
    };
    use crate::protocol::SearchMatch;

    #[test]
    fn prepared_path_filters_preserve_scope_combinations_and_invalid_patterns() {
        let paths = [
            "",
            "unit.rs",
            "unit.ts",
            "src/unit.rs",
            "src/deep/unit.rs",
            "src/한글😀.rs",
            "src/generated/unit.rs",
            "tests/a1.rs",
            "tests/a2.rs",
            ".hidden/a.rs",
            "a+b/file(1).rs",
            "sub/README.md",
            "sub/a\nb.rs",
        ];
        let scopes: &[&[&str]] = &[
            &[],
            &["**/*.rs"],
            &["src/*.rs", "tests/a[12].rs"],
            &["**/*.ts", "src/**"],
            &["**/generated/**"],
            &["a+b/file(1).rs"],
            &["[z-a]"],
            &["[z-a]", "src/**"],
            &["*"],
            &["**"],
            &["src/**/unit.?s"],
            &["tests/a[!2].rs"],
            &["["],
            &[""],
        ];
        let scopes = scopes
            .iter()
            .map(|patterns| {
                patterns
                    .iter()
                    .map(|pattern| pattern.to_string())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        for include in &scopes {
            for exclude in &scopes {
                let prepared = PreparedPathFilters::new(include, exclude);
                for path in paths {
                    assert_eq!(
                        prepared.is_match(path),
                        matches_path_filters(path, include, exclude),
                        "path={path:?}, include={include:?}, exclude={exclude:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn prepared_globs_initialize_only_reached_patterns_and_retain_failed_compilations() {
        let include = vec!["src/**".to_string(), "[z-a]".to_string()];
        let exclude = vec!["**/generated/**".to_string(), "[z-a]".to_string()];
        let prepared = PreparedPathFilters::new(&include, &exclude);
        assert!(prepared
            .include
            .iter()
            .chain(&prepared.exclude)
            .all(|glob| glob.regex.get().is_none()));
        assert!(!prepared.is_match("src/generated/unit.rs"));
        assert!(prepared.include[0].regex.get().is_some());
        assert!(prepared.include[1].regex.get().is_none());
        assert!(prepared.exclude[0].regex.get().is_some());
        assert!(prepared.exclude[1].regex.get().is_none());
        assert!(!prepared.is_match("other/unit.rs"));
        assert!(matches!(prepared.include[1].regex.get(), Some(None)));
        assert!(!prepared.is_match("other/second.rs"));
        assert!(matches!(prepared.include[1].regex.get(), Some(None)));
        assert!(prepared.exclude[1].regex.get().is_none());
        assert!(prepared.is_match("src/unit.rs"));
        assert!(matches!(prepared.exclude[1].regex.get(), Some(None)));
    }

    fn reference_match(text: &str, start: usize, end: usize) -> SearchMatch {
        // Deliberately rescan each prefix as the original verifier did. This
        // oracle does not depend on the optimized cursor or its preview cache.
        let position = |offset| {
            let lines = text[..offset].split('\n').collect::<Vec<_>>();
            (lines.len() - 1, lines.last().unwrap().chars().count())
        };
        let (line, start_column) = position(start);
        let (end_line, end_column) = position(end);
        let line_start = text[..start].rfind('\n').map_or(0, |idx| idx + 1);
        let line_end = text[end..].find('\n').map_or(text.len(), |idx| end + idx);
        SearchMatch {
            line,
            start_column,
            end_line: (end_line != line).then_some(end_line),
            end_column,
            preview: text[line_start..line_end].chars().take(240).collect(),
        }
    }

    #[test]
    fn match_positions_and_previews_preserve_all_unicode_and_line_boundaries() {
        for text in [
            "".to_string(),
            "\r\n\n가😀e\u{301} x\r\ny\nz\n".to_string(),
            format!("{}\r\n{}", "é😀a ".repeat(65), "b한 ".repeat(90)),
        ] {
            let mut boundaries = text
                .char_indices()
                .map(|(offset, _)| offset)
                .collect::<Vec<_>>();
            boundaries.push(text.len());
            // Exhaust short texts; sample the long lines around preview limits.
            if boundaries.len() > 100 {
                boundaries = boundaries.into_iter().step_by(7).collect();
                boundaries.push(text.len());
                boundaries.dedup();
            }
            for (idx, &start) in boundaries.iter().enumerate() {
                for &end in &boundaries[idx..] {
                    let mut builder = MatchBuilder::new(&text);
                    assert_eq!(
                        builder.build(start, end).to_json(),
                        reference_match(&text, start, end).to_json()
                    );
                    // Continue from a previous match, including an empty match
                    // at its end and a match crossing later cached line ends.
                    assert_eq!(
                        builder.build(end, end).to_json(),
                        reference_match(&text, end, end).to_json()
                    );
                    assert_eq!(
                        builder.build(end, text.len()).to_json(),
                        reference_match(&text, end, text.len()).to_json()
                    );
                }
            }
        }
    }

    #[test]
    fn prepared_verifiers_reset_positions_and_limits_for_each_file_and_clone() {
        let verifier = PreparedVerifier::literal("item", false, true);
        for verifier in [&verifier, &verifier.clone()] {
            let text = "가😀 item item\r\n\né item\nITEM itemSuffix";
            let matches = verifier.verify(text, 10);
            assert_eq!(
                matches
                    .iter()
                    .map(|found| (found.line, found.start_column, found.end_column))
                    .collect::<Vec<_>>(),
                vec![(0, 3, 7), (0, 8, 12), (2, 2, 6), (3, 0, 4)]
            );
            assert_eq!(matches[0].preview, "가😀 item item\r");
            assert_eq!(
                verifier
                    .verify(text, 2)
                    .iter()
                    .map(SearchMatch::to_json)
                    .collect::<Vec<_>>(),
                matches[..2]
                    .iter()
                    .map(SearchMatch::to_json)
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                verifier.verify("item", 10)[0].to_json(),
                reference_match("item", 0, 4).to_json()
            );
            assert!(verifier.verify("no matches", 10).is_empty());
        }
    }

    #[test]
    fn singleline_empty_regex_matches_keep_crlf_and_trailing_empty_line_positions() {
        let text = "😀\r\n\n가\n";
        let matches = verify_regex(text, "^|$", true, false, 20).unwrap();
        assert_eq!(
            matches
                .iter()
                .map(|found| (found.line, found.start_column, found.end_column))
                .collect::<Vec<_>>(),
            vec![
                (0, 0, 0),
                (0, 1, 1),
                (1, 0, 0),
                (2, 0, 0),
                (2, 1, 1),
                (3, 0, 0)
            ]
        );
        assert_eq!(
            matches
                .iter()
                .map(|found| found.preview.as_str())
                .collect::<Vec<_>>(),
            vec!["😀\r", "😀\r", "", "가", "가", ""]
        );
    }

    #[test]
    fn consecutive_multiline_matches_keep_unicode_ranges_and_full_line_previews() {
        let matches = verify_literal("한 item\r\n😀 item\n😀", "item\n😀", true, false, 10);
        let expected = vec![
            SearchMatch {
                line: 0,
                start_column: 2,
                end_line: Some(1),
                end_column: 1,
                preview: "한 item\r\n😀 item".to_string(),
            },
            SearchMatch {
                line: 1,
                start_column: 2,
                end_line: Some(2),
                end_column: 1,
                preview: "😀 item\n😀".to_string(),
            },
        ];
        assert_eq!(
            matches.iter().map(SearchMatch::to_json).collect::<Vec<_>>(),
            expected
                .iter()
                .map(SearchMatch::to_json)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn verifies_case_insensitive_whole_word_matches() {
        let matches = verify_literal("alpha Alpha alphaBeta", "alpha", false, true, 10);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 0);
    }

    #[test]
    fn literal_snippets_match_lf_and_crlf_with_exact_indentation_and_ranges() {
        let lines = ["const value = [1, 2];", "  return value;"];
        for query_ending in ["\n", "\r\n"] {
            let query = lines.join(query_ending);
            for file_ending in ["\n", "\r\n"] {
                let text = lines.join(file_ending);
                let matches = verify_literal(&text, &query, true, false, 10);
                assert_eq!(matches.len(), 1);
                assert_eq!(matches[0].line, 0);
                assert_eq!(matches[0].start_column, 0);
                assert_eq!(matches[0].end_line, Some(1));
                assert_eq!(matches[0].end_column, lines[1].len());
                let different = [lines[0], " return value;"].join(file_ending);
                assert!(verify_literal(&different, &query, true, false, 10).is_empty());
            }
        }
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
        let matches =
            verify_regex("foo\nbar\nbaz", "foo.*baz", true, true, 10).expect("regex must compile");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 0);
        assert_eq!(matches[0].end_line, Some(2));
    }

    #[test]
    fn regex_singleline_does_not_cross_line_boundaries() {
        let matches =
            verify_regex("foo\nbar\nbaz", "foo.*baz", true, false, 10).expect("regex must compile");
        assert!(matches.is_empty());
    }

    #[test]
    fn supports_simple_glob_filters() {
        assert!(matches_include_filters(
            "src/demo/file.rs",
            &[String::from("src/*/*.rs")]
        ));
        assert!(!matches_include_filters(
            "tests/demo/file.py",
            &[String::from("src/*/*.rs")]
        ));
    }

    #[test]
    fn star_does_not_cross_path_segments() {
        // Loose `*=.*` matching used to let `src/*.rs` accept nested paths.
        assert!(matches_include_filters(
            "src/file.rs",
            &[String::from("src/*.rs")]
        ));
        assert!(!matches_include_filters(
            "src/deep/file.rs",
            &[String::from("src/*.rs")]
        ));
    }

    #[test]
    fn double_star_spans_segments() {
        assert!(matches_include_filters(
            "a/b/c/file.py",
            &[String::from("**/*.py")]
        ));
        assert!(matches_include_filters(
            "file.py",
            &[String::from("**/*.py")]
        ));
        assert!(matches_include_filters(
            "src/legal/test/foo.rs",
            &[String::from("**/test/**")]
        ));
        assert!(!matches_include_filters(
            "src/legal/other/foo.rs",
            &[String::from("**/test/**")]
        ));
    }

    #[test]
    fn question_mark_is_single_segment_char() {
        assert!(matches_include_filters("a1.rs", &[String::from("a?.rs")]));
        assert!(!matches_include_filters(
            "ab/c.rs",
            &[String::from("a?.rs")]
        ));
    }
}
