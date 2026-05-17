use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, BuildHasherDefault, Hasher};

pub type GramHashMap<V> = HashMap<u64, V, BuildHasherDefault<U64IdentityHasher>>;
type GramHashSet = HashSet<u64, BuildHasherDefault<U64IdentityHasher>>;

#[derive(Default)]
pub struct U64IdentityHasher {
    hash: u64,
}

impl Hasher for U64IdentityHasher {
    fn finish(&self) -> u64 {
        self.hash
    }

    fn write(&mut self, bytes: &[u8]) {
        self.hash = hash_bytes(bytes);
    }

    fn write_u64(&mut self, value: u64) {
        self.hash = value;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum GramKind {
    Short,
    Medium,
    Long,
    Path,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct DynamicGram {
    pub kind: GramKind,
    pub value: String,
}

/// Extract grams for indexing, up to `max_grams`. The returned flag is true
/// when the budget was reached before all path/text tokens were visited —
/// meaning the shard's posting set for this document is known-incomplete.
/// Searchers must NOT exclude such docs at the AND-intersection step,
/// otherwise files with many unique tokens become unreachable for long
/// queries even though rg would find them.
pub fn extract_dynamic_grams_with_overflow(
    rel_path: &str,
    text: &str,
    max_grams: usize,
) -> (Vec<DynamicGram>, bool) {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut overflow = false;

    macro_rules! push_gram {
        ($gram:expr) => {{
            if seen.insert(($gram.kind, $gram.value.clone())) {
                if out.len() >= max_grams {
                    overflow = true;
                } else {
                    out.push($gram);
                }
            }
        }};
    }

    let _ = rel_path;
    for token in tokenize(text) {
        let normalized = normalize_token(token);
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            push_gram!(gram);
        }
    }
    for value in hex_pair_sequence_grams(text, max_grams) {
        let gram = DynamicGram {
            kind: GramKind::Short,
            value,
        };
        push_gram!(gram.clone());
    }
    for value in url_literal_grams(text, max_grams) {
        let gram = DynamicGram {
            kind: GramKind::Long,
            value,
        };
        push_gram!(gram.clone());
    }

    (out, overflow)
}

pub fn extract_dynamic_gram_values_with_overflow(
    rel_path: &str,
    text: &str,
    max_grams: usize,
) -> (Vec<String>, bool) {
    let capacity = max_grams.saturating_mul(2).clamp(16, 16_384);
    let mut seen = HashSet::with_capacity(capacity);
    let mut out = Vec::with_capacity(max_grams.min(8192));

    let _ = rel_path;
    for token in tokenize(text) {
        let normalized = normalize_token(token);
        if append_gram_values_for_token(&normalized, &mut seen, &mut out, max_grams) {
            return (out, true);
        }
    }
    for value in hex_pair_sequence_grams(text, max_grams) {
        if push_gram_value(value, &mut seen, &mut out, max_grams) {
            return (out, true);
        }
    }
    for value in url_literal_grams(text, max_grams) {
        if push_gram_value(value, &mut seen, &mut out, max_grams) {
            return (out, true);
        }
    }

    (out, false)
}

pub fn extract_dynamic_gram_hashes_with_overflow(
    rel_path: &str,
    text: &str,
    max_grams: usize,
) -> (Vec<u64>, bool) {
    let capacity = max_grams.saturating_mul(2).clamp(16, 16_384);
    let mut seen = GramHashSet::with_capacity_and_hasher(capacity, BuildHasherDefault::default());
    let mut out = Vec::with_capacity(max_grams.min(8192));

    let _ = rel_path;
    for token in tokenize(text) {
        if append_gram_hashes_for_token(token, &mut seen, &mut out, max_grams) {
            return (out, true);
        }
    }
    if append_hex_pair_sequence_hashes(text, &mut seen, &mut out, max_grams, max_grams) {
        return (out, true);
    }
    if append_url_literal_hashes(text, &mut seen, &mut out, max_grams, max_grams) {
        return (out, true);
    }

    (out, false)
}

pub fn hash_gram_value(value: &str) -> u64 {
    hash_bytes(value.as_bytes())
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    if hash == 0 {
        1
    } else {
        hash
    }
}

pub fn extract_dynamic_grams(rel_path: &str, text: &str, max_grams: usize) -> Vec<DynamicGram> {
    extract_dynamic_grams_with_overflow(rel_path, text, max_grams).0
}

pub fn grams_for_query_literal(literal: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for token in tokenize(literal.trim()) {
        let normalized = normalize_token(token);
        if normalized.is_empty() {
            continue;
        }
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            if seen.insert(gram.value.clone()) {
                out.push(gram.value);
            }
        }
    }

    out
}

/// Extract a bounded, selective set of grams from a literal query.
///
/// Long pasted-literal searches tokenize into many terms, producing dozens of
/// grams — more than any single file stores under `max_grams_per_file`, so the
/// AND-intersection in the shard planner drops every candidate even when the
/// file clearly contains the text. The verifier re-checks each candidate
/// against actual source, so over-selecting grams costs correctness with no
/// win. Bias toward longer tokens (heuristic: wider alphabet → rarer posting)
/// and cap the gram count.
pub fn selective_grams_for_query_literal(
    literal: &str,
    max_tokens: usize,
    max_grams: usize,
) -> Vec<String> {
    if max_tokens == 0 || max_grams == 0 {
        return Vec::new();
    }

    let sequence_grams = hex_pair_sequence_grams(literal, max_grams.min(2));
    if !sequence_grams.is_empty() {
        return sequence_grams;
    }
    let url_grams = url_literal_grams(literal, max_grams.min(2));
    let has_url_grams = !url_grams.is_empty();

    let mut seen_tokens = HashSet::new();
    let mut long_tokens: Vec<String> = Vec::new();
    let mut safe_short_tokens: Vec<String> = Vec::new();
    for token in tokenize_with_spans(literal.trim()) {
        let normalized = normalize_token(token.text);
        if normalized.is_empty() {
            continue;
        }
        let char_len = normalized.chars().count();
        if char_len >= 4 {
            if has_url_grams && matches!(normalized.as_str(), "http" | "https") {
                continue;
            }
            if seen_tokens.insert(normalized.clone()) {
                long_tokens.push(normalized);
            }
        } else if char_len >= 2
            && token.left_bounded
            && token.right_bounded
            && seen_tokens.insert(normalized.clone())
        {
            // A 2/3-char token is only safe as an index requirement when the
            // literal itself proves token boundaries on both sides. If a user
            // searches a substring like "tch = fp", the "tch" can occur inside
            // a longer token; long tokens only store 4-grams, so requiring the
            // standalone 3-gram would drop the real file and force a slow full
            // scan fallback.
            safe_short_tokens.push(normalized);
        }
    }
    long_tokens.sort_by(|left, right| right.chars().count().cmp(&left.chars().count()));
    long_tokens.truncate(max_tokens);

    // With sliding-window indexing, a single long token alone can produce
    // dozens of grams; taking them greedily starves later tokens and
    // reduces selectivity to "files containing token 0" instead of "files
    // containing all N tokens". Distribute the budget round-robin across
    // tokens so every chosen token is represented in the AND-intersection.
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for gram in url_grams {
        if out.len() >= max_grams {
            return out;
        }
        if seen.insert(gram.clone()) {
            out.push(gram);
        }
    }
    let short_budget = if has_url_grams {
        0
    } else if long_tokens.is_empty() {
        max_grams.min(1)
    } else {
        0
    };
    for normalized in safe_short_tokens.into_iter().take(short_budget) {
        if out.len() >= max_grams {
            return out;
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }

    let remaining = max_grams.saturating_sub(out.len());
    if remaining == 0 || long_tokens.is_empty() {
        return out;
    }
    let per_token = remaining.div_ceil(long_tokens.len().max(1));
    for normalized in long_tokens {
        let mut emitted = 0usize;
        for value in selective_gram_values_for_token(&normalized, per_token) {
            if out.len() >= max_grams {
                return out;
            }
            if emitted >= per_token {
                break;
            }
            if seen.insert(value.clone()) {
                out.push(value);
                emitted += 1;
            }
        }
    }
    out
}

pub(crate) fn append_hex_pair_sequence_hashes<S: BuildHasher>(
    text: &str,
    seen: &mut HashSet<u64, S>,
    out: &mut Vec<u64>,
    max_new_grams: usize,
    max_total_grams: usize,
) -> bool {
    let mut emitted = 0usize;
    for value in hex_pair_sequence_grams(text, max_new_grams) {
        let hash = hash_gram_value(&value);
        if !seen.insert(hash) {
            continue;
        }
        if out.len() >= max_total_grams {
            return true;
        }
        out.push(hash);
        emitted += 1;
        if emitted >= max_new_grams {
            break;
        }
    }
    false
}

pub(crate) fn append_url_literal_hashes<S: BuildHasher>(
    text: &str,
    seen: &mut HashSet<u64, S>,
    out: &mut Vec<u64>,
    max_new_grams: usize,
    max_total_grams: usize,
) -> bool {
    let mut emitted = 0usize;
    for value in url_literal_grams(text, max_new_grams) {
        let hash = hash_gram_value(&value);
        if !seen.insert(hash) {
            continue;
        }
        if out.len() >= max_total_grams {
            return true;
        }
        out.push(hash);
        emitted += 1;
        if emitted >= max_new_grams {
            break;
        }
    }
    false
}

pub(crate) fn append_selective_token_hashes<S: BuildHasher>(
    text: &str,
    prioritize_non_ascii: bool,
    seen: &mut HashSet<u64, S>,
    out: &mut Vec<u64>,
    max_new_grams: usize,
    max_total_grams: usize,
) -> bool {
    let mut emitted = 0usize;
    if prioritize_non_ascii {
        // Preserve short localized literals in token-heavy generated files
        // before ASCII identifiers consume the per-segment overflow budget.
        for token in tokenize(text) {
            if token.is_ascii() || token.chars().count() < 2 {
                continue;
            }
            for hash in selective_hashes_for_token(token, 3) {
                if !seen.insert(hash) {
                    continue;
                }
                if out.len() >= max_total_grams {
                    return true;
                }
                out.push(hash);
                emitted += 1;
                if emitted >= max_new_grams {
                    return false;
                }
            }
        }
    }
    for token in tokenize(text) {
        if prioritize_non_ascii && !token.is_ascii() && token.chars().count() >= 2 {
            continue;
        }
        if !is_selective_overflow_token(token) {
            continue;
        }
        for hash in selective_hashes_for_token(token, 3) {
            if !seen.insert(hash) {
                continue;
            }
            if out.len() >= max_total_grams {
                return true;
            }
            out.push(hash);
            emitted += 1;
            if emitted >= max_new_grams {
                return false;
            }
        }
    }
    false
}

fn is_selective_overflow_token(token: &str) -> bool {
    let char_len = token.chars().count();
    // Short CJK/Korean terms are often meaningful whole search literals.
    // Keep them eligible in overflow files; the per-segment cap bounds cost.
    (!token.is_ascii() && char_len >= 2)
        || char_len >= 8
        || (char_len >= 5
            && token
                .bytes()
                .any(|byte| byte.is_ascii_digit() || byte == b'_'))
}

fn hex_pair_sequence_grams(text: &str, max_grams: usize) -> Vec<String> {
    const PAIRS_PER_GRAM: usize = 4;
    if max_grams == 0 {
        return Vec::new();
    }

    let bytes = text.as_bytes();
    if !bytes.contains(&b':') {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut idx = 0usize;
    while idx < bytes.len() {
        let Some(relative_colon) = bytes[idx..].iter().position(|byte| *byte == b':') else {
            break;
        };
        let colon = idx + relative_colon;
        if colon < 2 || colon + 3 > bytes.len() {
            idx = colon.saturating_add(1);
            continue;
        }
        if !is_hex_pair_at(bytes, colon - 2) || !is_hex_pair_at(bytes, colon + 1) {
            idx = colon + 1;
            continue;
        }

        let mut run_start = colon - 2;
        while run_start >= 3 && bytes[run_start - 1] == b':' && is_hex_pair_at(bytes, run_start - 3)
        {
            run_start -= 3;
        }

        let mut pair_starts = Vec::new();
        let mut cursor = run_start;
        pair_starts.push(cursor);
        cursor += 2;
        while cursor + 3 <= bytes.len()
            && bytes[cursor] == b':'
            && is_hex_pair_at(bytes, cursor + 1)
        {
            cursor += 1;
            pair_starts.push(cursor);
            cursor += 2;
        }

        if pair_starts.len() >= PAIRS_PER_GRAM {
            for window in pair_starts.windows(PAIRS_PER_GRAM) {
                let start = window[0];
                let end = window[PAIRS_PER_GRAM - 1] + 2;
                let value = text[start..end].to_ascii_lowercase();
                if seen.insert(value.clone()) {
                    out.push(value);
                    if out.len() >= max_grams {
                        return out;
                    }
                }
            }
        }
        idx = cursor;
    }
    out
}

fn is_hex_pair_at(bytes: &[u8], idx: usize) -> bool {
    idx + 1 < bytes.len() && bytes[idx].is_ascii_hexdigit() && bytes[idx + 1].is_ascii_hexdigit()
}

fn url_literal_grams(text: &str, max_grams: usize) -> Vec<String> {
    const URL_GRAM_BYTES: usize = 48;
    const URL_PREFIX_GRAM_BYTES: usize = 24;
    const MIN_URL_GRAM_BYTES: usize = 16;
    if max_grams == 0 || !text.contains("http") {
        return Vec::new();
    }

    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut idx = 0usize;
    while idx + MIN_URL_GRAM_BYTES <= bytes.len() {
        let Some(relative_h) = bytes[idx..]
            .iter()
            .position(|byte| *byte == b'h' || *byte == b'H')
        else {
            break;
        };
        let start = idx + relative_h;
        if !starts_with_url_scheme_ascii(bytes, start) {
            idx = start + 1;
            continue;
        }
        let mut end = start;
        while end < bytes.len() && is_url_literal_byte(bytes[end]) {
            end += 1;
        }
        let url_len = end - start;
        let min_prefix_end = start + MIN_URL_GRAM_BYTES.min(url_len);
        if min_prefix_end - start >= MIN_URL_GRAM_BYTES {
            let value = text[start..min_prefix_end].to_ascii_lowercase();
            if seen.insert(value.clone()) {
                out.push(value);
                if out.len() >= max_grams {
                    return out;
                }
            }
        }
        let prefix_end = start + URL_PREFIX_GRAM_BYTES.min(url_len);
        if prefix_end - start >= URL_PREFIX_GRAM_BYTES {
            let value = text[start..prefix_end].to_ascii_lowercase();
            if seen.insert(value.clone()) {
                out.push(value);
                if out.len() >= max_grams {
                    return out;
                }
            }
        }
        let gram_end = start + URL_GRAM_BYTES.min(url_len);
        if url_len >= URL_GRAM_BYTES && gram_end > prefix_end {
            let value = text[start..gram_end].to_ascii_lowercase();
            if seen.insert(value.clone()) {
                out.push(value);
                if out.len() >= max_grams {
                    return out;
                }
            }
        }
        idx = end.max(start + 1);
    }
    out
}

fn starts_with_url_scheme_ascii(bytes: &[u8], idx: usize) -> bool {
    let lower = |byte: u8| byte.to_ascii_lowercase();
    (idx + 7 <= bytes.len()
        && lower(bytes[idx]) == b'h'
        && lower(bytes[idx + 1]) == b't'
        && lower(bytes[idx + 2]) == b't'
        && lower(bytes[idx + 3]) == b'p'
        && bytes[idx + 4] == b':'
        && bytes[idx + 5] == b'/'
        && bytes[idx + 6] == b'/')
        || (idx + 8 <= bytes.len()
            && lower(bytes[idx]) == b'h'
            && lower(bytes[idx + 1]) == b't'
            && lower(bytes[idx + 2]) == b't'
            && lower(bytes[idx + 3]) == b'p'
            && lower(bytes[idx + 4]) == b's'
            && bytes[idx + 5] == b':'
            && bytes[idx + 6] == b'/'
            && bytes[idx + 7] == b'/')
}

fn is_url_literal_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'['
                | b']'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b'%'
        )
}

struct TokenSpan<'a> {
    text: &'a str,
    left_bounded: bool,
    right_bounded: bool,
}

fn tokenize_with_spans(text: &str) -> Vec<TokenSpan<'_>> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut current_left_bounded = false;
    let mut previous: Option<(usize, char)> = None;
    for (idx, ch) in text.char_indices() {
        if is_token_char(ch) {
            if start.is_none() {
                start = Some(idx);
                current_left_bounded = previous
                    .map(|(_, previous_ch)| !is_token_char(previous_ch))
                    .unwrap_or(false);
            }
        } else if let Some(token_start) = start.take() {
            out.push(TokenSpan {
                text: &text[token_start..idx],
                left_bounded: current_left_bounded,
                right_bounded: true,
            });
        }
        previous = Some((idx, ch));
    }
    if let Some(token_start) = start {
        out.push(TokenSpan {
            text: &text[token_start..],
            left_bounded: current_left_bounded,
            right_bounded: false,
        });
    }
    out
}

fn tokenize(text: &str) -> impl Iterator<Item = &str> {
    text.split(|ch: char| !is_token_char(ch))
        .filter(|token| !token.is_empty())
}

fn classify_token_kind(token: &str) -> GramKind {
    match token.chars().count() {
        0..=4 => GramKind::Short,
        5..=8 => GramKind::Medium,
        _ => GramKind::Long,
    }
}

fn normalize_token(token: &str) -> String {
    if token.is_ascii() {
        return token.to_ascii_lowercase();
    }
    token.chars().flat_map(char::to_lowercase).collect()
}

fn append_gram_values_for_token(
    token: &str,
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
    max_grams: usize,
) -> bool {
    if token.is_ascii() {
        append_ascii_gram_values_for_token(token, seen, out, max_grams)
    } else {
        append_unicode_gram_values_for_token(token, seen, out, max_grams)
    }
}

fn append_ascii_gram_values_for_token(
    token: &str,
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
    max_grams: usize,
) -> bool {
    let bytes = token.as_bytes();
    let len = bytes.len();
    if len < 2 {
        return false;
    }
    for width in gram_widths(len).rev() {
        for start in 0..=(len - width) {
            // SAFETY: this path only receives ASCII tokens, so every byte window is valid UTF-8.
            let value =
                unsafe { String::from_utf8_unchecked(bytes[start..start + width].to_vec()) };
            if push_gram_value(value, seen, out, max_grams) {
                return true;
            }
        }
    }
    false
}

fn append_gram_hashes_for_token(
    token: &str,
    seen: &mut GramHashSet,
    out: &mut Vec<u64>,
    max_grams: usize,
) -> bool {
    if token.is_ascii() {
        append_ascii_gram_hashes_for_token(token, seen, out, max_grams)
    } else {
        append_unicode_gram_hashes_for_token(token, seen, out, max_grams)
    }
}

fn append_ascii_gram_hashes_for_token(
    token: &str,
    seen: &mut GramHashSet,
    out: &mut Vec<u64>,
    max_grams: usize,
) -> bool {
    let bytes = token.as_bytes();
    let len = bytes.len();
    if len < 2 {
        return false;
    }
    for width in gram_widths(len).rev() {
        for start in 0..=(len - width) {
            if push_gram_hash(
                hash_ascii_lower_bytes(&bytes[start..start + width]),
                seen,
                out,
                max_grams,
            ) {
                return true;
            }
        }
    }
    false
}

fn append_unicode_gram_hashes_for_token(
    token: &str,
    seen: &mut GramHashSet,
    out: &mut Vec<u64>,
    max_grams: usize,
) -> bool {
    let normalized = normalize_token(token);
    let len = normalized.chars().count();
    if len < 2 {
        return false;
    }
    let chars = normalized.chars().collect::<Vec<_>>();
    for width in gram_widths(len).rev() {
        for start in 0..=(len - width) {
            if push_gram_hash(
                hash_chars(&chars[start..start + width]),
                seen,
                out,
                max_grams,
            ) {
                return true;
            }
        }
    }
    false
}

fn selective_hashes_for_token(token: &str, max_grams: usize) -> Vec<u64> {
    if max_grams == 0 {
        return Vec::new();
    }
    let len = token.chars().count();
    let width = *gram_widths(len).start();
    if len < width {
        return Vec::new();
    }
    if token.is_ascii() {
        let bytes = token.as_bytes();
        return selected_window_starts(len - width + 1, max_grams)
            .into_iter()
            .map(|start| hash_ascii_lower_bytes(&bytes[start..start + width]))
            .collect();
    }
    let normalized = normalize_token(token);
    let chars = normalized.chars().collect::<Vec<_>>();
    selected_window_starts(chars.len() - width + 1, max_grams)
        .into_iter()
        .map(|start| hash_chars(&chars[start..start + width]))
        .collect()
}

fn push_gram_hash(
    value: u64,
    seen: &mut GramHashSet,
    out: &mut Vec<u64>,
    max_grams: usize,
) -> bool {
    if !seen.insert(value) {
        return false;
    }
    if out.len() >= max_grams {
        return true;
    }
    out.push(value);
    false
}

fn hash_ascii_lower_bytes(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    for byte in bytes {
        hash ^= u64::from(byte.to_ascii_lowercase());
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    if hash == 0 {
        1
    } else {
        hash
    }
}

fn hash_chars(chars: &[char]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut hash = FNV_OFFSET;
    let mut buf = [0u8; 4];
    for ch in chars {
        for byte in ch.encode_utf8(&mut buf).as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    if hash == 0 {
        1
    } else {
        hash
    }
}

fn append_unicode_gram_values_for_token(
    token: &str,
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
    max_grams: usize,
) -> bool {
    let len = token.chars().count();
    if len < 2 {
        return false;
    }
    let chars = token.chars().collect::<Vec<_>>();
    for width in gram_widths(len).rev() {
        for start in 0..=(len - width) {
            let value = chars[start..start + width].iter().collect::<String>();
            if push_gram_value(value, seen, out, max_grams) {
                return true;
            }
        }
    }
    false
}

fn push_gram_value(
    value: String,
    seen: &mut HashSet<String>,
    out: &mut Vec<String>,
    max_grams: usize,
) -> bool {
    if !seen.insert(value.clone()) {
        return false;
    }
    if out.len() >= max_grams {
        return true;
    }
    out.push(value);
    false
}

fn grams_for_token(token: &str, kind: GramKind) -> Vec<DynamicGram> {
    let len = token.chars().count();
    if len < 2 {
        return Vec::new();
    }

    let chars: Vec<char> = token.chars().collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    // Use the widest indexed grams for selectivity. Shorter standalone
    // literals still fall back to exact verification if no indexed candidate
    // can be produced.
    for width in gram_widths(len).rev() {
        // Full sliding-window coverage: every contiguous `width`-char
        // substring. Required so the planner (which may pick a subset of
        // grams) always intersects with grams the indexer actually stored
        // for the same token.
        for start in 0..=(len - width) {
            let value: String = chars[start..start + width].iter().collect();
            if seen.insert(value.clone()) {
                out.push(DynamicGram { kind, value });
            }
        }
    }
    out
}

fn selective_gram_values_for_token(token: &str, max_grams: usize) -> Vec<String> {
    if max_grams == 0 {
        return Vec::new();
    }
    let grams = grams_for_token(token, classify_token_kind(token));
    if grams.len() <= max_grams {
        return grams.into_iter().map(|gram| gram.value).collect();
    }
    selected_window_starts(grams.len(), max_grams)
        .into_iter()
        .filter_map(|idx| grams.get(idx).map(|gram| gram.value.clone()))
        .collect()
}

fn selected_window_starts(window_count: usize, max_grams: usize) -> Vec<usize> {
    if window_count == 0 || max_grams == 0 {
        return Vec::new();
    }
    if window_count <= max_grams {
        return (0..window_count).collect();
    }
    if max_grams == 1 {
        return vec![0];
    }
    let mut out = Vec::with_capacity(max_grams);
    let mut seen = HashSet::new();
    for idx in 0..max_grams {
        let start = (idx * (window_count - 1)) / (max_grams - 1);
        if seen.insert(start) {
            out.push(start);
        }
    }
    out
}

fn is_token_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn gram_widths(len: usize) -> std::ops::RangeInclusive<usize> {
    len.min(4)..=len.min(4)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_dynamic_gram_values_with_overflow, extract_dynamic_grams, grams_for_query_literal,
        selective_grams_for_query_literal,
    };
    use std::collections::HashSet;

    #[test]
    fn extracts_text_grams() {
        let grams = extract_dynamic_grams("src/demo/file.rs", "AlphaService handles users", 32);
        assert!(grams
            .iter()
            .any(|gram| gram.value.contains("alph") || gram.value.contains("vice")));
    }

    #[test]
    fn query_grams_are_not_empty_for_literal() {
        let grams = grams_for_query_literal("AlphaService");
        assert!(!grams.is_empty());
    }

    #[test]
    fn query_grams_ignore_literal_spacing_and_punctuation() {
        let grams = grams_for_query_literal("class AlphaService:");
        assert!(grams.iter().any(|gram| gram == "clas"));
        assert!(grams.iter().any(|gram| gram == "alph"));
        assert!(grams.iter().all(|gram| !gram.contains(' ')));
        assert!(grams.iter().all(|gram| !gram.contains(':')));
    }

    #[test]
    fn selective_grams_cap_long_pasted_literals() {
        let literal = "def _update_directors_meeting_minutes_with_all_approvals(self, \
             directors_meeting, chairperson): DirectorsMeetingMinutesService";
        let grams = selective_grams_for_query_literal(literal, 4, 12);
        assert!(grams.len() <= 12);
        assert!(!grams.is_empty());
        assert!(grams
            .iter()
            .any(|gram| gram.contains("_upd") || gram.contains("dire")));
    }

    #[test]
    fn selective_grams_drop_short_tokens_when_longer_tokens_can_select() {
        let grams = selective_grams_for_query_literal(
            "BaseDocumentsVisitor, DeclarationKind, LoadedFragment, Par",
            4,
            12,
        );
        assert!(!grams.iter().any(|gram| gram == "par"));
        assert!(grams.iter().any(|gram| gram == "base"));
    }

    #[test]
    fn selective_grams_prefer_longer_tokens() {
        // "a" (1 char) → no grams. "ab" (2) is boundary-safe but should not
        // starve the longer token even when max_tokens=1.
        let grams = selective_grams_for_query_literal("a ab AlphaService", 1, 12);
        assert!(grams.iter().any(|gram| gram == "alph"));
    }

    #[test]
    fn selective_grams_skip_unbounded_short_prefixes_but_keep_bounded_short_terms() {
        let grams = selective_grams_for_query_literal(
            "tch = fp == b\"85:25:04:32:58:55:96:9f:57:ee:fb:a8",
            4,
            12,
        );
        assert_eq!(grams[0], "85:25:04:32");
        assert_eq!(grams[1], "25:04:32:58");
        assert!(!grams.iter().any(|gram| gram == "tch"));
        assert!(!grams.iter().any(|gram| gram == "fp"));
        assert!(!grams.iter().any(|gram| gram == "85"));
        assert!(!grams.iter().any(|gram| gram == "25"));
        assert!(!grams.iter().any(|gram| gram == "a8"));
    }

    #[test]
    fn hex_pair_sequences_are_indexed_as_selective_literal_grams() {
        let doc_grams = extract_dynamic_grams(
            "src/demo/file.py",
            "fingerprintMatch = fp == b\"85:25:04:32:58:55:96:9f\"",
            128,
        )
        .into_iter()
        .map(|gram| gram.value)
        .collect::<HashSet<_>>();
        assert!(doc_grams.contains("85:25:04:32"));
        assert!(doc_grams.contains("25:04:32:58"));
    }

    #[test]
    fn url_literals_are_indexed_as_selective_literal_grams() {
        let literal = "ts](https://en.wikipedia.org/wiki/Doubly_linked_list) inst";
        let grams = selective_grams_for_query_literal(literal, 4, 12);
        assert_eq!(grams[0], "https://en.wikip");
        assert_eq!(grams[1], "https://en.wikipedia.org");

        let doc_grams = extract_dynamic_grams(
            "CHANGELOG.md",
            "linked lists](https://en.wikipedia.org/wiki/Doubly_linked_list) instead",
            128,
        )
        .into_iter()
        .map(|gram| gram.value)
        .collect::<HashSet<_>>();
        assert!(doc_grams.contains("https://en.wikip"));
        assert!(doc_grams.contains("https://en.wikipedia.org"));
        assert!(doc_grams.contains("https://en.wikipedia.org/wiki/doubly_linked_list"));
    }

    #[test]
    fn substring_query_grams_match_longer_ascii_tokens() {
        let doc_grams = extract_dynamic_grams("src/demo/file.rs", "AlphaServiceSupport", 128)
            .into_iter()
            .map(|gram| gram.value)
            .collect::<HashSet<_>>();
        let query_grams = grams_for_query_literal("Alpha");
        assert!(!query_grams.is_empty());
        assert!(query_grams.iter().all(|gram| doc_grams.contains(gram)));
    }

    #[test]
    fn substring_query_grams_match_longer_unicode_tokens() {
        let doc_grams = extract_dynamic_grams("src/demo/file.rs", "한글검색지원", 128)
            .into_iter()
            .map(|gram| gram.value)
            .collect::<HashSet<_>>();
        let query_grams = grams_for_query_literal("한글검색");
        assert!(!query_grams.is_empty());
        assert!(query_grams.iter().all(|gram| doc_grams.contains(gram)));
    }

    #[test]
    fn value_extraction_stops_once_overflow_is_known() {
        let (grams, overflow) = extract_dynamic_gram_values_with_overflow(
            "src/demo/file.rs",
            "AlphaService BetaService",
            1,
        );
        assert_eq!(grams.len(), 1);
        assert!(overflow);
    }
}
