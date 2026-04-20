#[derive(Clone, Debug, Default)]
pub struct RegexPlan {
    pub mandatory_literals: Vec<String>,
}

pub fn extract_mandatory_literals(pattern: &str) -> RegexPlan {
    if has_top_level_alternation(pattern) {
        return RegexPlan::default();
    }

    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut idx = 0usize;

    while idx < chars.len() {
        match chars[idx] {
            '\\' => {
                let (literal, next_idx, is_literal) = parse_escape(&chars, idx);
                if is_literal {
                    if is_atom_mandatory(&chars, next_idx) {
                        current.push_str(&literal);
                    } else {
                        flush_literal(&mut current, &mut tokens);
                    }
                } else {
                    flush_literal(&mut current, &mut tokens);
                }
                idx = next_idx;
            }
            '[' => {
                flush_literal(&mut current, &mut tokens);
                idx = skip_class(&chars, idx + 1);
                idx = skip_quantifier(&chars, idx);
            }
            '(' => {
                flush_literal(&mut current, &mut tokens);
                idx = skip_group(&chars, idx + 1);
                idx = skip_quantifier(&chars, idx);
            }
            '.' | '^' | '$' => {
                flush_literal(&mut current, &mut tokens);
                idx += 1;
                idx = skip_quantifier(&chars, idx);
            }
            '*' | '+' | '?' => {
                flush_literal(&mut current, &mut tokens);
                idx += 1;
            }
            '{' => {
                flush_literal(&mut current, &mut tokens);
                idx = skip_quantifier(&chars, idx);
            }
            ch => {
                if is_atom_mandatory(&chars, idx + 1) {
                    current.extend(ch.to_lowercase());
                } else {
                    flush_literal(&mut current, &mut tokens);
                }
                idx = skip_quantifier(&chars, idx + 1);
            }
        }
    }

    flush_literal(&mut current, &mut tokens);
    tokens.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    tokens.dedup();
    if tokens.len() > 8 {
        tokens.truncate(8);
    }
    RegexPlan {
        mandatory_literals: tokens,
    }
}

fn has_top_level_alternation(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut idx = 0usize;
    let mut depth = 0usize;
    while idx < chars.len() {
        match chars[idx] {
            '\\' => idx += 2,
            '[' => idx = skip_class(&chars, idx + 1),
            '(' => {
                depth += 1;
                idx += 1;
            }
            ')' => {
                depth = depth.saturating_sub(1);
                idx += 1;
            }
            '|' if depth == 0 => return true,
            _ => idx += 1,
        }
    }
    false
}

fn parse_escape(chars: &[char], idx: usize) -> (String, usize, bool) {
    if idx + 1 >= chars.len() {
        return (String::new(), chars.len(), false);
    }
    let escaped = chars[idx + 1];
    match escaped {
        'n' => ("\n".to_string(), idx + 2, true),
        'r' => ("\r".to_string(), idx + 2, true),
        't' => ("\t".to_string(), idx + 2, true),
        'v' => ("\u{000b}".to_string(), idx + 2, true),
        'f' => ("\u{000c}".to_string(), idx + 2, true),
        'x' => {
            if idx + 3 < chars.len() {
                let text = chars[idx + 2..idx + 4].iter().collect::<String>();
                if let Ok(value) = u8::from_str_radix(&text, 16) {
                    return ((value as char).to_lowercase().collect(), idx + 4, true);
                }
            }
            ("x".to_string(), idx + 2, true)
        }
        'u' => {
            if idx + 5 < chars.len() {
                let text = chars[idx + 2..idx + 6].iter().collect::<String>();
                if let Ok(value) = u32::from_str_radix(&text, 16) {
                    if let Some(ch) = char::from_u32(value) {
                        return (ch.to_lowercase().collect(), idx + 6, true);
                    }
                }
            }
            ("u".to_string(), idx + 2, true)
        }
        'b' | 'B' | 'A' | 'z' | 'Z' | 'd' | 'D' | 's' | 'S' | 'w' | 'W' => {
            (String::new(), idx + 2, false)
        }
        '0'..='9' => (String::new(), idx + 2, false),
        other => (other.to_lowercase().collect(), idx + 2, true),
    }
}

fn skip_class(chars: &[char], mut idx: usize) -> usize {
    while idx < chars.len() {
        match chars[idx] {
            '\\' => idx += 2,
            ']' => return idx + 1,
            _ => idx += 1,
        }
    }
    chars.len()
}

fn skip_group(chars: &[char], mut idx: usize) -> usize {
    let mut depth = 1usize;
    while idx < chars.len() {
        match chars[idx] {
            '\\' => idx += 2,
            '[' => idx = skip_class(chars, idx + 1),
            '(' => {
                depth += 1;
                idx += 1;
            }
            ')' => {
                depth -= 1;
                idx += 1;
                if depth == 0 {
                    return idx;
                }
            }
            _ => idx += 1,
        }
    }
    chars.len()
}

fn skip_quantifier(chars: &[char], idx: usize) -> usize {
    if idx >= chars.len() {
        return idx;
    }
    match chars[idx] {
        '*' | '+' | '?' => {
            if idx + 1 < chars.len() && chars[idx + 1] == '?' {
                idx + 2
            } else {
                idx + 1
            }
        }
        '{' => {
            let mut pos = idx + 1;
            while pos < chars.len() && chars[pos] != '}' {
                pos += 1;
            }
            if pos < chars.len() {
                pos += 1;
                if pos < chars.len() && chars[pos] == '?' {
                    pos += 1;
                }
                pos
            } else {
                idx
            }
        }
        _ => idx,
    }
}

fn is_atom_mandatory(chars: &[char], idx: usize) -> bool {
    if idx >= chars.len() {
        return true;
    }
    match chars[idx] {
        '*' | '?' => false,
        '{' => quantifier_min(chars, idx).unwrap_or(1) > 0,
        _ => true,
    }
}

fn quantifier_min(chars: &[char], idx: usize) -> Option<usize> {
    if idx >= chars.len() || chars[idx] != '{' {
        return None;
    }
    let mut pos = idx + 1;
    let start = pos;
    while pos < chars.len() && chars[pos].is_ascii_digit() {
        pos += 1;
    }
    if pos == start {
        return None;
    }
    chars[start..pos]
        .iter()
        .collect::<String>()
        .parse::<usize>()
        .ok()
}

fn flush_literal(current: &mut String, tokens: &mut Vec<String>) {
    if current.len() >= 2 {
        tokens.push(std::mem::take(current));
    } else {
        current.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::extract_mandatory_literals;

    #[test]
    fn keeps_required_literals_in_concatenation() {
        let plan = extract_mandatory_literals("foo.*bar(baz)?qux");
        assert!(plan.mandatory_literals.iter().any(|value| value == "foo"));
        assert!(plan.mandatory_literals.iter().any(|value| value == "bar"));
        assert!(plan.mandatory_literals.iter().any(|value| value == "qux"));
    }

    #[test]
    fn avoids_unsound_literals_for_top_level_alternation() {
        let plan = extract_mandatory_literals("foo|bar");
        assert!(plan.mandatory_literals.is_empty());
    }

    #[test]
    fn trims_optional_suffix_chars() {
        let plan = extract_mandatory_literals("colou?r");
        assert!(plan.mandatory_literals.iter().any(|value| value == "colo"));
    }
}
