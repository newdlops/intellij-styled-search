//! Syntactic JavaScript lexical bindings. `var` belongs to its function,
//! lexical declarations to their block, and parameters to the function body.
//! Global script declarations are possible cross-file bindings, never proof
//! that a particular script is loaded at runtime.
use super::python_bindings::Binding;
use super::{is_ident_continue, is_ident_start, GraphSymbol, ImportFact, KF_BARE_FB, KF_MEMBER_FB};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

struct Token {
    start: usize,
    end: usize,
}
struct Scope {
    start: usize,
    end: usize,
    parent: usize,
    function: bool,
    names: HashMap<String, Binding>,
}

// Only binding positions introduce names. Object keys, computed keys and
// default-value expressions keep their ordinary reference semantics.
fn binding_pattern(
    tokens: &[Token], code: &str, pairs: &[Option<usize>], start: usize,
    names: &mut Vec<usize>,
) -> usize {
    let text = |index: usize| tokens.get(index)
        .map(|token| &code[token.start..token.end]).unwrap_or("");
    let mut start = start;
    while text(start) == "." { start += 1; }
    if super::is_identifier(text(start)) {
        names.push(start);
        return start + 1;
    }
    if !matches!(text(start), "{" | "[") { return start + 1; }
    let Some(end) = pairs.get(start).copied().flatten() else { return start + 1; };
    let object = text(start) == "{";
    let mut part = start + 1;
    while part < end {
        if text(part) == "," { part += 1; continue; }
        let mut value = part;
        if object && text(part) != "." {
            let key_end = pairs[part].filter(|close| *close > part).map_or(part + 1, |close| close + 1);
            if text(key_end) == ":" { value = key_end + 1; }
            // A quoted key is blanked by the sanitizer, leaving just ':'.
            else if text(part) == ":" { value = part + 1; }
        }
        let mut cursor = binding_pattern(tokens, code, pairs, value, names);
        while cursor < end && text(cursor) != "," {
            if let Some(close) = pairs[cursor].filter(|close| *close > cursor) { cursor = close; }
            cursor += 1;
        }
        part = cursor + 1;
    }
    end + 1
}

#[derive(Default)]
pub(super) struct LexicalBindings {
    offsets: Vec<usize>,
    scopes: Vec<Scope>,
    scope_order: Vec<usize>,
    declarations: HashSet<usize>,
    local_ids: HashSet<u64>,
    pub(super) globals: Vec<(String, String)>,
}

impl LexicalBindings {
    pub(super) fn new(lines: &[Cow<'_, str>], original: &str, symbols: &[GraphSymbol], imports: &[ImportFact]) -> Self {
        let mut result = Self::default();
        let mut code = String::new();
        for line in lines {
            result.offsets.push(code.len());
            code.push_str(line);
            code.push('\n');
        }
        let mut tokens = Vec::new();
        let mut chars = code.char_indices().peekable();
        while let Some((start, ch)) = chars.next() {
            if ch.is_whitespace() {
                continue;
            }
            let mut end = start + ch.len_utf8();
            if is_ident_start(ch) {
                while chars.peek().is_some_and(|(_, ch)| is_ident_continue(*ch)) {
                    let (offset, ch) = chars.next().unwrap();
                    end = offset + ch.len_utf8();
                }
            } else if ch == '=' && chars.peek().is_some_and(|(_, ch)| *ch == '>') {
                let (offset, ch) = chars.next().unwrap();
                end = offset + ch.len_utf8();
            }
            tokens.push(Token { start, end });
        }
        let text = |index: usize| -> &str {
            tokens
                .get(index)
                .map(|token| &code[token.start..token.end])
                .unwrap_or("")
        };
        let mut pairs = vec![None; tokens.len()];
        let mut stack: Vec<usize> = Vec::new();
        for i in 0..tokens.len() {
            match text(i) {
                "(" | "[" | "{" => stack.push(i),
                ")" | "]" | "}" => {
                    if let Some(open) = stack.pop() {
                        if matches!((text(open), text(i)), ("(", ")") | ("[", "]") | ("{", "}")) {
                            pairs[open] = Some(i);
                            pairs[i] = Some(open);
                        }
                    }
                }
                _ => {}
            }
        }
        result.scopes.push(Scope {
            start: 0,
            end: code.len(),
            parent: 0,
            function: true,
            names: HashMap::new(),
        });
        let mut scope_stack = vec![0];
        let mut brace_scopes = HashMap::new();
        let mut scope_at = vec![0; tokens.len()];
        for i in 0..tokens.len() {
            scope_at[i] = *scope_stack.last().unwrap();
            if text(i) == "{" {
                let scope = result.scopes.len();
                result.scopes.push(Scope {
                    start: tokens[i].end,
                    end: pairs[i].map(|end| tokens[end].start).unwrap_or(code.len()),
                    parent: scope_at[i],
                    function: false,
                    names: HashMap::new(),
                });
                brace_scopes.insert(i, scope);
                scope_stack.push(scope);
            } else if text(i) == "}" && scope_stack.len() > 1 {
                scope_stack.pop();
            }
        }
        let mut definitions = HashMap::new();
        let original_lines: Vec<_> = original.lines().collect();
        for symbol in symbols {
            if let Some(line) = original_lines.get(symbol.start_line as usize) {
                let mut column = 0;
                let byte = line
                    .char_indices()
                    .find_map(|(byte, ch)| {
                        let found = column == symbol.start_column;
                        column += ch.len_utf16() as u32;
                        found.then_some(byte)
                    })
                    .unwrap_or(line.len());
                definitions.insert(
                    result.offsets[symbol.start_line as usize] + byte,
                    symbol.id_u64,
                );
            }
        }
        // Discover all function bodies before assigning var declarations.
        let mut functions = Vec::new();
        for i in 0..tokens.len() {
            let (params, body, internal_name) = if text(i) == "function" {
                let mut open = i + 1;
                if text(open) == "*" {
                    open += 1;
                }
                let name = (text(open) != "(").then_some(open);
                if name.is_some() {
                    open += 1;
                }
                let Some(close) = pairs.get(open).copied().flatten() else {
                    continue;
                };
                (Some((open + 1, close)), close + 1, name)
            } else if text(i) == "=>" {
                let params = if i > 0 && text(i - 1) == ")" {
                    pairs[i - 1].map(|open| (open + 1, i - 1))
                } else {
                    i.checked_sub(1).map(|name| (name, i))
                };
                (params, i + 1, None)
            } else if text(i) == "(" && i > 0 && super::is_identifier(text(i - 1)) {
                let Some(close) = pairs[i] else {
                    continue;
                };
                if text(close + 1) != "{" || super::is_keyword(text(i - 1), "javascript") {
                    continue;
                }
                // Object/class method shorthand, not an expression call.
                if i > 1
                    && !matches!(
                        text(i - 2),
                        "{" | "}" | "," | ";" | "async" | "static" | "get" | "set"
                    )
                {
                    continue;
                }
                (Some((i + 1, close)), close + 1, None)
            } else {
                continue;
            };
            let scope = if let Some(&scope) = brace_scopes.get(&body) {
                scope
            } else if text(i) == "=>" {
                // Expression arrows end at a delimiter in their enclosing list.
                let mut end = body;
                while end < tokens.len() && !matches!(text(end), "," | ";" | ")" | "]" | "}") {
                    if let Some(close) = pairs[end].filter(|close| *close > end) {
                        end = close;
                    }
                    end += 1;
                }
                let scope = result.scopes.len();
                result.scopes.push(Scope {
                    start: tokens
                        .get(body)
                        .map(|token| token.start)
                        .unwrap_or(code.len()),
                    end: tokens
                        .get(end)
                        .map(|token| token.start)
                        .unwrap_or(code.len()),
                    parent: scope_at[i],
                    function: true,
                    names: HashMap::new(),
                });
                scope
            } else {
                continue;
            };
            result.scopes[scope].function = true;
            functions.push((i, scope, params, internal_name));
        }
        for (keyword, scope, params, internal_name) in functions {
            if let Some((start, end)) = params {
                let mut part = start;
                while part < end {
                    let mut parameter = part;
                    while text(parameter) == "." {
                        parameter += 1;
                    }
                    let mut names = Vec::new();
                    let after_pattern = binding_pattern(&tokens, &code, &pairs, parameter, &mut names);
                    for parameter in names {
                        result.declarations.insert(tokens[parameter].start);
                        result.scopes[scope]
                            .names
                            .insert(text(parameter).to_string(), Binding::Excluded);
                    }
                    let mut cursor = after_pattern;
                    while cursor < end && text(cursor) != "," {
                        if let Some(close) = pairs[cursor].filter(|close| *close > cursor) {
                            cursor = close;
                        }
                        cursor += 1;
                    }
                    part = cursor + 1;
                }
            }
            if let Some(name) = internal_name {
                let before = if keyword > 0 && text(keyword - 1) == "async" {
                    keyword - 1
                } else {
                    keyword
                };
                let declaration = before == 0
                    || matches!(text(before - 1), ";" | "{" | "}" | "export" | "default");
                let owner = if declaration {
                    scope_at[keyword]
                } else {
                    scope
                };
                let binding = definitions
                    .get(&tokens[name].start)
                    .copied()
                    .map(Binding::Indexed)
                    .unwrap_or(Binding::Excluded);
                result.scopes[owner]
                    .names
                    .insert(text(name).to_string(), binding);
                result.declarations.insert(tokens[name].start);
                if owner != 0 {
                    if let Binding::Indexed(id) = binding {
                        result.local_ids.insert(id);
                    }
                }
            }
        }
        result.scope_order = (0..result.scopes.len()).collect();
        result.scope_order.sort_by_key(|index| {
            (
                result.scopes[*index].start,
                std::cmp::Reverse(result.scopes[*index].end),
            )
        });
        // Expression arrows have no brace scope. Reparent contained scopes
        // after discovering every function, so curried arrows retain outer
        // parameters in their closures.
        let mut parents = vec![0];
        for &scope in &result.scope_order {
            if scope == 0 { continue; }
            while parents.len() > 1 {
                let parent = *parents.last().unwrap();
                if result.scopes[scope].start < result.scopes[parent].end
                    && result.scopes[scope].end <= result.scopes[parent].end { break; }
                parents.pop();
            }
            result.scopes[scope].parent = *parents.last().unwrap();
            parents.push(scope);
        }
        let script = !tokens.iter().enumerate().any(|(i, _)| {
            scope_at[i] == 0
                && (i == 0 || text(i - 1) != ".")
                && (text(i) == "export" || text(i) == "import" && !matches!(text(i + 1), "(" | "."))
        });
        for i in 0..tokens.len() {
            if !matches!(text(i), "var" | "let" | "const") {
                continue;
            }
            let mut scope = result.scope(tokens[i].start);
            if text(i) == "var" {
                while !result.scopes[scope].function {
                    scope = result.scopes[scope].parent;
                }
            }
            let mut name = i + 1;
            loop {
                if !super::is_identifier(text(name)) && !matches!(text(name), "{" | "[") { break; }
                let mut names = Vec::new();
                let after_pattern = binding_pattern(&tokens, &code, &pairs, name, &mut names);
                for name in names {
                    let binding = definitions.get(&tokens[name].start).copied()
                        .map(Binding::Indexed).unwrap_or_else(|| {
                            // CommonJS destructuring can introduce an import
                            // alias without a separate indexed value symbol.
                            if scope == 0 && imports.iter().any(|fact| fact.local_name == text(name)) {
                                Binding::Unbound
                            } else { Binding::Excluded }
                        });
                    result.scopes[scope].names.insert(text(name).to_string(), binding);
                    result.declarations.insert(tokens[name].start);
                    if scope != 0 {
                        if let Binding::Indexed(id) = binding { result.local_ids.insert(id); }
                    }
                    if script && scope == 0 && text(i) == "var" {
                        result.globals.push((text(name).to_string(), text(name).to_string()));
                    }
                }
                let mut cursor = after_pattern;
                while cursor < tokens.len()
                    && !matches!(text(cursor), "," | ";" | ")" | "in" | "of")
                {
                    if let Some(close) = pairs[cursor].filter(|close| *close > cursor) {
                        cursor = close;
                    }
                    cursor += 1;
                    // Automatic semicolon insertion: do not absorb another declaration.
                    if matches!(
                        text(cursor),
                        "var" | "let" | "const" | "function" | "export" | "import"
                    ) {
                        break;
                    }
                }
                if text(cursor) != "," {
                    break;
                }
                name = cursor + 1;
            }
        }
        if script {
            for (name, binding) in &result.scopes[0].names {
                if let Binding::Indexed(id) = binding {
                    if symbols
                        .iter()
                        .any(|symbol| symbol.id_u64 == *id && symbol.kind == "function")
                    {
                        result.globals.push((name.clone(), name.clone()));
                    }
                }
            }
        }
        for i in 0..tokens.len().saturating_sub(4) {
            if matches!(text(i), "window" | "globalThis" | "self")
                && text(i + 1) == "."
                && text(i + 3) == "="
                && super::is_identifier(text(i + 2))
                && super::is_identifier(text(i + 4))
                && !matches!(text(i + 4), "function" | "async")
            {
                result
                    .globals
                    .push((text(i + 2).to_string(), text(i + 4).to_string()));
            }
        }
        result.globals.sort();
        result.globals.dedup();
        result
    }

    fn scope(&self, offset: usize) -> usize {
        let position = self
            .scope_order
            .partition_point(|index| self.scopes[*index].start <= offset);
        let mut scope = position
            .checked_sub(1)
            .map(|position| self.scope_order[position])
            .unwrap_or(0);
        while scope != 0 && offset >= self.scopes[scope].end {
            scope = self.scopes[scope].parent;
        }
        scope
    }

    pub(super) fn mark_local_symbols(&self, symbols: &mut [GraphSymbol]) {
        for symbol in symbols {
            if self.local_ids.contains(&symbol.id_u64) {
                symbol.is_local_binding = true;
                symbol.kind_flags &= !(KF_BARE_FB | KF_MEMBER_FB);
            }
        }
    }

    pub(super) fn binding(&self, line: usize, column: usize, name: &str) -> Binding {
        let Some(offset) = self.offsets.get(line).map(|offset| offset + column) else {
            return Binding::Unbound;
        };
        if self.declarations.contains(&offset) {
            return Binding::Excluded;
        }
        let mut scope = self.scope(offset);
        loop {
            if let Some(binding) = self.scopes[scope].names.get(name) {
                return *binding;
            }
            if scope == 0 {
                return Binding::Unbound;
            }
            scope = self.scopes[scope].parent;
        }
    }
}
