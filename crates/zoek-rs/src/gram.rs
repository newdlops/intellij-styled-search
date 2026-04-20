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

pub fn extract_dynamic_grams(rel_path: &str, text: &str, max_grams: usize) -> Vec<DynamicGram> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for component in rel_path.split('/') {
        for gram in grams_for_token(&normalize_token(component), GramKind::Path) {
            if seen.insert((gram.kind, gram.value.clone())) {
                out.push(gram);
                if out.len() >= max_grams {
                    return out;
                }
            }
        }
    }

    for token in tokenize(text) {
        let normalized = normalize_token(token);
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            if seen.insert((gram.kind, gram.value.clone())) {
                out.push(gram);
                if out.len() >= max_grams {
                    return out;
                }
            }
        }
    }

    out
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

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for normalized in tokens {
        for gram in grams_for_token(&normalized, classify_token_kind(&normalized)) {
            if seen.insert(gram.value.clone()) {
                out.push(gram.value);
                if out.len() >= max_grams {
                    return out;
                }
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

    let chars: Vec<char> = token.chars().collect();
    let mut windows = Vec::new();
    windows.push(chars[0..width].iter().collect::<String>());
    if len > width {
        let mid_start = (len - width) / 2;
        windows.push(chars[mid_start..mid_start + width].iter().collect::<String>());
        windows.push(chars[len - width..len].iter().collect::<String>());
    }

    let mut seen = HashSet::new();
    windows
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .map(|value| DynamicGram { kind, value })
        .collect()
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
