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
    pub terms: Vec<QueryTermPlan>,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub path_regex: Option<String>,
    pub required_literals: Vec<String>,
    pub required_grams: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct QueryTermPlan {
    pub query: String,
    pub effective_query: String,
    pub required_literals: Vec<String>,
    pub required_grams: Vec<String>,
}

pub fn build_query_plan(request: &SearchRequest) -> QueryPlan {
    let mode = if request.use_regex {
        QueryMode::Regex
    } else {
        QueryMode::Literal
    };
    let terms = request
        .all_query_terms()
        .into_iter()
        .map(|query| build_query_term_plan(request, query))
        .collect::<Vec<_>>();
    let effective_query = terms
        .iter()
        .map(|term| term.effective_query.clone())
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut required_literals = terms
        .iter()
        .flat_map(|term| term.required_literals.iter().cloned())
        .collect::<Vec<_>>();
    required_literals.sort();
    required_literals.dedup();
    let mut required_grams = terms
        .iter()
        .flat_map(|term| term.required_grams.iter().cloned())
        .collect::<Vec<_>>();
    required_grams.sort();
    required_grams.dedup();

    QueryPlan {
        mode,
        effective_query,
        terms,
        case_sensitive: request.case_sensitive,
        whole_word: request.whole_word,
        include: request.include.clone(),
        exclude: request.exclude.clone(),
        path_regex: request.path_regex.clone(),
        required_literals,
        required_grams,
    }
}

fn build_query_term_plan(request: &SearchRequest, query: String) -> QueryTermPlan {
    let effective_query = effective_query_pattern(request, &query);
    let mut required_literals = if request.use_regex {
        extract_mandatory_literals(&effective_query).mandatory_literals
    } else if query.is_empty() {
        Vec::new()
    } else {
        vec![normalize_literal(&query, request.case_sensitive)]
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
                literal, max_tokens, max_grams,
            ));
        }
    } else {
        for literal in &required_literals {
            required_grams.extend(grams_for_query_literal(literal));
        }
    }
    required_grams.sort();
    required_grams.dedup();

    QueryTermPlan {
        query,
        effective_query,
        required_literals,
        required_grams,
    }
}

pub fn effective_query_pattern(request: &SearchRequest, query: &str) -> String {
    if request.use_regex {
        if request.whole_word {
            format!(r"\b(?:{})\b", query)
        } else {
            query.to_string()
        }
    } else {
        query.to_string()
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
            query_terms: Vec::new(),
            case_sensitive: true,
            whole_word: false,
            use_regex: false,
            regex_multiline: true,
            include: vec![],
            exclude: vec![],
            path_regex: None,
            limit: 10,
            offset: 0,
        });
        assert!(!plan.required_grams.is_empty());
        assert!(plan
            .required_grams
            .iter()
            .any(|gram| gram == "righ" || gram == "inve"));
    }

    #[test]
    fn literal_or_terms_keep_separate_required_gram_sets() {
        let plan = build_query_plan(&SearchRequest {
            workspace_root: "/tmp/workspace".to_string(),
            query: "AlphaService".to_string(),
            query_terms: vec!["BetaService".to_string()],
            case_sensitive: true,
            whole_word: false,
            use_regex: false,
            regex_multiline: true,
            include: vec![],
            exclude: vec![],
            path_regex: None,
            limit: 10,
            offset: 0,
        });
        assert_eq!(plan.terms.len(), 2);
        assert!(plan.terms[0]
            .required_grams
            .iter()
            .any(|gram| gram.to_lowercase().contains("alph")));
        assert!(plan.terms[1]
            .required_grams
            .iter()
            .any(|gram| gram.to_lowercase().contains("beta")));
    }
}
