use crate::gram::{grams_for_query_literal, selective_grams_for_query_literal};
use crate::protocol::SearchRequest;
use crate::regex_plan::extract_mandatory_literals;

const MAX_QUERY_TOKENS: usize = 4;
const MAX_QUERY_GRAMS: usize = 12;
const MAX_MULTILINE_QUERY_TOKENS: usize = 8;
const MAX_MULTILINE_QUERY_GRAMS: usize = 24;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueryMode {
    Literal,
    Regex,
}

#[derive(Clone, Debug)]
pub struct QueryPlan {
    pub mode: QueryMode,
    pub effective_query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: Vec<String>,
    pub required_literals: Vec<String>,
    pub required_grams: Vec<String>,
}

pub fn build_query_plan(request: &SearchRequest) -> QueryPlan {
    let effective_query = effective_query_pattern(request);
    let mode = if request.use_regex {
        QueryMode::Regex
    } else {
        QueryMode::Literal
    };

    let mut required_literals = if request.use_regex {
        extract_mandatory_literals(&effective_query).mandatory_literals
    } else if request.query.is_empty() {
        Vec::new()
    } else {
        vec![normalize_literal(&request.query, request.case_sensitive)]
    };
    if request.use_regex && !request.case_sensitive {
        required_literals = required_literals
            .into_iter()
            .map(|literal| normalize_literal(&literal, false))
            .collect();
    }

    let mut required_grams = Vec::new();
    if !request.use_regex {
        if let Some(literal) = required_literals.first() {
            let (max_tokens, max_grams) = if literal.contains('\n') {
                (MAX_MULTILINE_QUERY_TOKENS, MAX_MULTILINE_QUERY_GRAMS)
            } else {
                (MAX_QUERY_TOKENS, MAX_QUERY_GRAMS)
            };
            // Multiline pasted code snippets were previously forced through a
            // full verifier scan because `required_grams` stayed empty. That
            // is correct but catastrophic on large workspaces. Now that the
            // index marks gram-truncated files as incomplete (and search keeps
            // those files in the candidate set unconditionally), we can safely
            // use a bounded selective gram set for multiline literals too.
            required_grams.extend(selective_grams_for_query_literal(
                literal,
                max_tokens,
                max_grams,
            ));
        }
    } else {
        for literal in &required_literals {
            required_grams.extend(grams_for_query_literal(literal));
        }
    }
    required_grams.sort();
    required_grams.dedup();

    QueryPlan {
        mode,
        effective_query,
        case_sensitive: request.case_sensitive,
        whole_word: request.whole_word,
        include: request.include.clone(),
        required_literals,
        required_grams,
    }
}

pub fn effective_query_pattern(request: &SearchRequest) -> String {
    if request.use_regex {
        if request.whole_word {
            format!(r"\b(?:{})\b", request.query)
        } else {
            request.query.clone()
        }
    } else {
        request.query.clone()
    }
}

fn normalize_literal(value: &str, case_sensitive: bool) -> String {
    if case_sensitive {
        value.to_string()
    } else {
        value.chars().flat_map(char::to_lowercase).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::build_query_plan;
    use crate::protocol::SearchRequest;

    #[test]
    fn multiline_literals_still_produce_required_grams() {
        let plan = build_query_plan(&SearchRequest {
            workspace_root: "/tmp/workspace".to_string(),
            query: "export const RightToConsentOrConsultInvestorsSelectTable = ({\n  name,\n  investorCandidates,\n  isShowInvestors,\n  onCheck,\n});".to_string(),
            case_sensitive: true,
            whole_word: false,
            use_regex: false,
            regex_multiline: true,
            include: vec![],
            limit: 10,
            offset: 0,
        });
        assert!(!plan.required_grams.is_empty());
        assert!(plan.required_grams.iter().any(|gram| gram == "righ" || gram == "inve"));
    }
}
