use std::collections::HashSet;

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

    for component in rel_path.split('/') {
        for gram in grams_for_token(&normalize_token(component), GramKind::Path) {
            push_gram!(gram);
        }
    }

    for token in tokenize(text) {
        let normalized = normalize_token(token);
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            push_gram!(gram);
        }
    }

    (out, overflow)
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

    let mut seen_tokens = HashSet::new();
    let mut tokens: Vec<String> = Vec::new();
    for token in tokenize(literal.trim()) {
        let normalized = normalize_token(token);
        if normalized.is_empty() {
            continue;
        }
        if seen_tokens.insert(normalized.clone()) {
            tokens.push(normalized);
        }
    }
    tokens.sort_by(|left, right| right.chars().count().cmp(&left.chars().count()));
    tokens.truncate(max_tokens);

    // With sliding-window indexing, a single long token alone can produce
    // dozens of grams; taking them greedily starves later tokens and
    // reduces selectivity to "files containing token 0" instead of "files
    // containing all N tokens". Distribute the budget round-robin across
    // tokens so every chosen token is represented in the AND-intersection.
    let per_token = max_grams.div_ceil(tokens.len().max(1));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for normalized in tokens {
        let mut emitted = 0usize;
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            if out.len() >= max_grams {
                return out;
            }
            if emitted >= per_token {
                break;
            }
            if seen.insert(gram.value.clone()) {
                out.push(gram.value);
                emitted += 1;
            }
        }
    }
    out
}

fn tokenize(text: &str) -> impl Iterator<Item = &str> {
    text.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .filter(|token| !token.is_empty())
}

fn classify_token_kind(token: &str) -> GramKind {
    match token.len() {
        0..=4 => GramKind::Short,
        5..=8 => GramKind::Medium,
        _ => GramKind::Long,
    }
}

fn normalize_token(token: &str) -> String {
    token.chars().flat_map(char::to_lowercase).collect()
}

fn grams_for_token(token: &str, kind: GramKind) -> Vec<DynamicGram> {
    let len = token.chars().count();
    if len < 2 {
        return Vec::new();
    }

    let width = match kind {
        GramKind::Short => 2,
        GramKind::Medium | GramKind::Path => 3,
        GramKind::Long => 4,
    }
    .min(len);

    // Full sliding-window coverage: every contiguous `width`-char substring.
    // Required so the planner (which may pick a subset of grams) always
    // intersects with grams the indexer actually stored for the same token.
    // The prior 3-window (prefix/middle/suffix) scheme made query-side gram
    // selection brittle — picking a middle offset that didn't coincide with
    // the indexer's prefix/middle/suffix would silently exclude real
    // matches. Combined with a raised per-file cap and a `gram_incomplete`
    // flag for overflow files, sliding window no longer sacrifices recall.
    let chars: Vec<char> = token.chars().collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for start in 0..=(len - width) {
        let value: String = chars[start..start + width].iter().collect();
        if seen.insert(value.clone()) {
            out.push(DynamicGram { kind, value });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{extract_dynamic_grams, grams_for_query_literal, selective_grams_for_query_literal, GramKind};

    #[test]
    fn extracts_path_and_text_grams() {
        let grams = extract_dynamic_grams("src/demo/file.rs", "AlphaService handles users", 32);
        assert!(grams.iter().any(|gram| gram.kind == GramKind::Path && gram.value == "src"));
        assert!(grams.iter().any(|gram| gram.value.contains("Alph") || gram.value.contains("vice")));
    }

    #[test]
    fn query_grams_are_not_empty_for_literal() {
        let grams = grams_for_query_literal("AlphaService");
        assert!(!grams.is_empty());
    }

    #[test]
    fn query_grams_ignore_literal_spacing_and_punctuation() {
        let grams = grams_for_query_literal("class AlphaService:");
        assert!(grams.iter().any(|gram| gram == "cla"));
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
        assert!(grams.iter().any(|gram| gram.contains("_upd") || gram.contains("dire")));
    }

    #[test]
    fn selective_grams_prefer_longer_tokens() {
        // "a" (1 char) → no grams. "ab" (2) → 1 gram. "AlphaService" (12) → width-4 grams.
        // With max_tokens=1, only the longest token's grams should appear.
        let grams = selective_grams_for_query_literal("a ab AlphaService", 1, 12);
        assert!(grams.iter().any(|gram| gram == "alph"));
        assert!(!grams.iter().any(|gram| gram == "ab"));
    }
}
