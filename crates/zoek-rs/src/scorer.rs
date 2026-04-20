use crate::protocol::SearchMatch;

pub fn score_file(rel_path: &str, matches: &[SearchMatch]) -> i64 {
    let depth_penalty = rel_path.matches('/').count() as i64 * 3;
    (matches.len() as i64 * 100) - depth_penalty - rel_path.len() as i64
}
