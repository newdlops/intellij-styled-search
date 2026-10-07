//! Python lexical bindings, including local assignments and expression scopes.
//! Header expressions remain in the enclosing scope; indexed locals retain
//! their own usages instead of leaking into same-named module symbols.
use super::{
    identifier_tokens, leading_identifier, matching_close_paren, starts_python_function_signature,
    strip_keyword, trailing_identifier, GraphSymbol,
};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct LexicalBindings {
    declarations: HashSet<(usize, usize)>,
    scopes: Vec<Scope>,
    active: Vec<usize>,
    next: usize,
    expressions: Vec<ExpressionScope>,
    offsets: Vec<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Binding {
    Unbound,
    Excluded,
    Indexed(u64),
}

struct Scope {
    header_line: usize,
    indent: usize,
    body_start: (usize, usize),
    end_line: usize,
    is_class: bool,
    parameters: HashSet<String>,
    globals: HashSet<String>,
    locals: HashMap<String, Binding>,
    nonlocals: HashSet<String>,
}

struct ExpressionScope {
    start: usize,
    end: usize,
    outer_iter: Option<(usize, usize)>,
    names: HashSet<String>,
    is_lambda: bool,
}

impl LexicalBindings {
    pub(super) fn new(lines: &[Cow<'_, str>], symbols: &[GraphSymbol]) -> Self {
        let mut result = Self::default();
        let mut code = String::new();
        let mut offsets = Vec::with_capacity(lines.len());
        for line in lines {
            offsets.push(code.len());
            code.push_str(line);
            code.push('\n');
        }
        let position = |offset: usize| {
            let line = offsets
                .partition_point(|start| *start <= offset)
                .saturating_sub(1);
            (line, offset - offsets[line])
        };
        let mut definitions: HashMap<usize, Vec<&GraphSymbol>> = HashMap::new();
        for symbol in symbols {
            definitions
                .entry(symbol.start_line as usize)
                .or_default()
                .push(symbol);
        }
        let mut stack: Vec<usize> = Vec::new();
        let mut depth = 0i32;
        let mut continued = false;
        for (line_idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim_start();
            if !trimmed.is_empty() && depth == 0 && !continued {
                let indent = python_indent(line);
                while stack
                    .last()
                    .is_some_and(|idx| indent <= result.scopes[*idx].indent)
                {
                    result.scopes[stack.pop().unwrap()].end_line = line_idx;
                }
                let is_function = starts_python_function_signature(trimmed);
                let is_class = strip_keyword(trimmed, "class").is_some();
                if is_function || is_class {
                    let header_start = offsets[line_idx] + line.len() - trimmed.len();
                    let mut parameters = HashSet::new();
                    let search_start = if is_function {
                        trimmed.find('(').and_then(|open| {
                            let open = header_start + open;
                            let close = matching_close_paren(&code, open)?;
                            for (start, end) in parameter_spans(&code, open + 1, close) {
                                let part = &code[start..end];
                                let name_part =
                                    part.trim_start().trim_start_matches('*').trim_start();
                                if let Some(name) = leading_identifier(name_part) {
                                    let offset = start + part.len() - name_part.len();
                                    result.declarations.insert(position(offset));
                                    parameters.insert(name);
                                }
                            }
                            Some(close + 1)
                        })
                    } else {
                        Some(header_start)
                    };
                    if let Some(colon) = search_start.and_then(|start| suite_colon(&code, start)) {
                        let idx = result.scopes.len();
                        result.scopes.push(Scope {
                            header_line: line_idx,
                            indent,
                            body_start: position(colon + 1),
                            end_line: lines.len(),
                            is_class,
                            parameters,
                            globals: HashSet::new(),
                            locals: HashMap::new(),
                            nonlocals: HashSet::new(),
                        });
                        stack.push(idx);
                    }
                }
            }
            // Scan simple-suite global statements too. Declarations in a
            // child block do not alter its enclosing function's binding.
            for (start, statement) in statement_spans(line) {
                if let Some(names) = strip_keyword(statement.trim_start(), "global") {
                    let pos = (line_idx, start);
                    if let Some(idx) = stack
                        .iter()
                        .rev()
                        .find(|idx| result.scopes[**idx].body_start <= pos)
                    {
                        result.scopes[*idx].globals.extend(
                            names
                                .split(',')
                                .filter_map(|name| leading_identifier(name.trim())),
                        );
                    }
                }
            }
            // An indexed local redefinition needs the resolver's existing
            // candidate handling. Do not suppress its legitimate usages.
            if let Some(definitions) = definitions.get(&line_idx) {
                for symbol in definitions {
                    let byte_column = line
                        .char_indices()
                        .scan(0u32, |column, (idx, ch)| {
                            let before = *column;
                            *column += ch.len_utf16() as u32;
                            Some((idx, before))
                        })
                        .find(|(_, column)| *column == symbol.start_column)
                        .map(|(idx, _)| idx)
                        .unwrap_or(line.len());
                    let pos = (line_idx, byte_column);
                    if let Some(idx) = stack
                        .iter()
                        .rev()
                        .find(|idx| result.scopes[**idx].body_start <= pos)
                    {
                        result.scopes[*idx]
                            .locals
                            .entry(symbol.name.clone())
                            .or_insert(Binding::Indexed(symbol.id_u64));
                    }
                }
            }
            for ch in line.chars() {
                match ch {
                    '(' | '[' | '{' => depth += 1,
                    ')' | ']' | '}' => depth -= 1,
                    _ => {}
                }
            }
            continued = line.trim_end().ends_with('\\');
        }
        for (start, end) in logical_statements(&code) {
            for (start, end) in simple_statements(&code, start, end) {
                let statement = &code[start..end];
                let names = strip_keyword(statement, "global")
                    .map(|names| (true, names))
                    .or_else(|| strip_keyword(statement, "nonlocal").map(|names| (false, names)));
                if let Some((global, names)) = names {
                    if let Some(idx) = result.scope_at(position(start)) {
                        for (name, begin, _) in identifier_tokens(names) {
                            let offset = start + statement.len() - names.len() + begin;
                            result.declarations.insert(position(offset));
                            if global {
                                result.scopes[idx].globals.insert(name);
                            } else {
                                result.scopes[idx].nonlocals.insert(name);
                            }
                        }
                    }
                    continue;
                }
                for (name, offset) in statement_bindings(&code, start, end) {
                    if let Some(idx) = result.scope_at(position(offset)) {
                        result.scopes[idx]
                            .locals
                            .entry(name)
                            .or_insert(Binding::Excluded);
                        result.declarations.insert(position(offset));
                    }
                }
            }
        }
        result.expressions = expression_scopes(&code, &mut result.declarations, &position);
        // Named expressions bind the containing function, including when
        // written in a comprehension. A nested lambda owns its own bindings.
        for (colon, _) in code.match_indices(":=") {
            let prefix = code[..colon].trim_end();
            let Some(name) = trailing_identifier(prefix) else {
                continue;
            };
            let offset = prefix.len() - name.len();
            result.declarations.insert(position(offset));
            if let Some(scope) = result
                .expressions
                .iter_mut()
                .find(|scope| scope.is_lambda && scope.start <= offset && offset < scope.end)
            {
                scope.names.insert(name);
            } else if let Some(idx) = result.scope_at(position(offset)) {
                result.scopes[idx]
                    .locals
                    .entry(name)
                    .or_insert(Binding::Excluded);
            }
        }
        result.offsets = offsets;
        result
    }

    fn scope_at(&self, pos: (usize, usize)) -> Option<usize> {
        self.scopes
            .iter()
            .enumerate()
            .rev()
            .find(|(_, scope)| scope.body_start <= pos && pos.0 < scope.end_line)
            .map(|(idx, _)| idx)
    }

    pub(super) fn mark_local_symbols(&self, lines: &[Cow<'_, str>], symbols: &mut [GraphSymbol]) {
        for symbol in symbols {
            let Some(line) = lines.get(symbol.start_line as usize) else {
                continue;
            };
            let mut column = 0;
            let byte = line
                .char_indices()
                .find_map(|(idx, ch)| {
                    let at = column;
                    column += ch.len_utf16() as u32;
                    (at == symbol.start_column).then_some(idx)
                })
                .unwrap_or(line.len());
            symbol.is_local_binding = self
                .scope_at((symbol.start_line as usize, byte))
                .is_some_and(|idx| !self.scopes[idx].is_class);
            super::restore_graph_symbol_metadata(symbol);
        }
    }

    pub(super) fn advance_line(&mut self, line: usize) {
        while self.next < self.scopes.len() && self.scopes[self.next].header_line <= line {
            self.active.push(self.next);
            self.next += 1;
        }
        self.active.retain(|idx| self.scopes[*idx].end_line > line);
    }

    #[cfg(test)]
    pub(super) fn excludes(&self, line: usize, column: usize, name: &str) -> bool {
        self.binding(line, column, name) == Binding::Excluded
    }

    pub(super) fn binding(&self, line: usize, column: usize, name: &str) -> Binding {
        if self.declarations.contains(&(line, column)) {
            return Binding::Excluded;
        }
        let offset = self.offsets.get(line).copied().unwrap_or(0) + column;
        let mut innermost = true;
        for scope in &self.expressions {
            if scope.start <= offset
                && offset < scope.end
                && !scope
                    .outer_iter
                    .is_some_and(|(start, end)| start <= offset && offset < end)
            {
                if scope.names.contains(name) {
                    return Binding::Excluded;
                }
                innermost = false;
            }
        }
        for idx in self.active.iter().rev() {
            let scope = &self.scopes[*idx];
            if (line, column) < scope.body_start {
                continue;
            }
            // Class namespace bindings do not enter method closures.
            if !scope.is_class || innermost {
                if scope.globals.contains(name) {
                    return Binding::Unbound;
                }
                if scope.nonlocals.contains(name) {
                    continue;
                }
                if let Some(binding) = scope.locals.get(name) {
                    return *binding;
                }
                if scope.parameters.contains(name) {
                    return Binding::Excluded;
                }
            }
            innermost = false;
        }
        Binding::Unbound
    }
}

pub(super) fn python_indent(line: &str) -> usize {
    let mut column = 0;
    for ch in line.chars() {
        match ch {
            ' ' => column += 1,
            '\t' => column = (column / 8 + 1) * 8,
            '\u{c}' => column = 0,
            _ => break,
        }
    }
    column
}

fn parameter_spans(code: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut part_start = start;
    let mut depth = 0i32;
    for (idx, ch) in code[start..end].char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                spans.push((part_start, start + idx));
                part_start = start + idx + 1;
            }
            _ => {}
        }
    }
    spans.push((part_start, end));
    spans
}

fn suite_colon(code: &str, start: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in code[start..].char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ':' if depth == 0 => return Some(start + idx),
            '\n' if depth == 0 => return None,
            _ => {}
        }
    }
    None
}

fn statement_spans(line: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    for (idx, ch) in line.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ';' | ':' if depth == 0 => {
                spans.push((start, &line[start..idx]));
                start = idx + 1;
            }
            _ => {}
        }
    }
    spans.push((start, &line[start..]));
    spans
}

pub(super) fn logical_statements(code: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    let mut depth = 0i32;
    for (idx, ch) in code.char_indices() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            '\n' | ';' if depth == 0 && !code[start..idx].trim_end().ends_with('\\') => {
                spans.push((start, idx));
                start = idx + 1;
            }
            _ => {}
        }
    }
    spans.push((start, code.len()));
    spans
}

fn simple_statements(code: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
    let statement = &code[start..end];
    let trimmed = statement.trim();
    let start = start + statement.len() - statement.trim_start().len();
    let end = start + trimmed.len();
    let compound = [
        "def",
        "async def",
        "class",
        "for",
        "async for",
        "with",
        "async with",
        "except",
        "if",
        "elif",
        "else",
        "while",
        "try",
        "finally",
        "match",
        "case",
    ]
    .iter()
    .any(|keyword| strip_keyword(trimmed, keyword).is_some());
    if compound {
        if let Some((colon, _)) = top_level_items(trimmed)
            .into_iter()
            .find(|(idx, word)| *word == ":" && trimmed.as_bytes().get(idx + 1) != Some(&b'='))
        {
            let split = start + colon;
            let mut spans = vec![(start, split)];
            spans.extend(simple_statements(code, split + 1, end));
            return spans;
        }
    }
    if start < end {
        vec![(start, end)]
    } else {
        Vec::new()
    }
}

/// Identifier words and operators outside nested target/expression brackets.
fn top_level_items(value: &str) -> Vec<(usize, &str)> {
    let mut items = Vec::new();
    let mut depth = 0i32;
    let mut idx = 0;
    while idx < value.len() {
        let ch = value[idx..].chars().next().unwrap();
        if ch == '_' || unicode_ident::is_xid_start(ch) {
            let start = idx;
            idx += ch.len_utf8();
            while idx < value.len() {
                let next = value[idx..].chars().next().unwrap();
                if next != '_' && !unicode_ident::is_xid_continue(next) {
                    break;
                }
                idx += next.len_utf8();
            }
            if depth == 0 {
                items.push((start, &value[start..idx]));
            }
            continue;
        }
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ if depth == 0 && !ch.is_whitespace() => {
                items.push((idx, &value[idx..idx + ch.len_utf8()]))
            }
            _ => {}
        }
        idx += ch.len_utf8();
    }
    items
}

fn target_names(value: &str, offset: usize) -> Vec<(String, usize)> {
    let trimmed = value.trim();
    let offset = offset + value.len() - value.trim_start().len();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let items = top_level_items(trimmed);
    let commas: Vec<_> = items
        .iter()
        .filter(|(_, item)| *item == ",")
        .map(|(idx, _)| *idx)
        .collect();
    if !commas.is_empty() {
        let mut names = Vec::new();
        let mut start = 0;
        for end in commas.into_iter().chain(std::iter::once(trimmed.len())) {
            names.extend(target_names(&trimmed[start..end], offset + start));
            start = end + 1;
        }
        return names;
    }
    if (trimmed.starts_with('(') && trimmed.ends_with(')'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        return target_names(&trimmed[1..trimmed.len() - 1], offset + 1);
    }
    if let Some(rest) = trimmed.strip_prefix('*') {
        return target_names(rest, offset + 1);
    }
    if let Some(name) = leading_identifier(trimmed) {
        if trimmed[name.len()..].trim().is_empty() {
            return vec![(name, offset)];
        }
    }
    // Attribute and subscript targets load their receiver/index; they do not
    // bind those names in the surrounding lexical scope.
    Vec::new()
}

fn statement_bindings(code: &str, start: usize, end: usize) -> Vec<(String, usize)> {
    let value = &code[start..end];
    let items = top_level_items(value);
    if strip_keyword(value, "for").is_some() || strip_keyword(value, "async for").is_some() {
        let for_end = items
            .iter()
            .find(|(_, word)| *word == "for")
            .map(|(idx, _)| idx + 3)
            .unwrap();
        if let Some((idx, _)) = items.iter().find(|(_, word)| *word == "in") {
            return target_names(&value[for_end..*idx], start + for_end);
        }
    }
    if strip_keyword(value, "with").is_some()
        || strip_keyword(value, "async with").is_some()
        || strip_keyword(value, "except").is_some()
    {
        let body_start = items
            .iter()
            .find(|(_, word)| matches!(*word, "with" | "except"))
            .map(|(idx, word)| idx + word.len())
            .unwrap();
        let body = value[body_start..].trim();
        let body_offset = start + value.len() - value[body_start..].trim_start().len();
        let (body, body_offset) = if body.starts_with('(') && body.ends_with(')') {
            (&body[1..body.len() - 1], body_offset + 1)
        } else {
            (body, body_offset)
        };
        let parts = top_level_items(body);
        let mut names = Vec::new();
        for (idx, word) in &parts {
            if *word == "as" {
                let target_start = idx + 2;
                let target_end = parts
                    .iter()
                    .find(|(next, word)| next > idx && *word == ",")
                    .map(|(idx, _)| *idx)
                    .unwrap_or(body.len());
                names.extend(target_names(
                    &body[target_start..target_end],
                    body_offset + target_start,
                ));
            }
        }
        return names;
    }
    let mut names = Vec::new();
    let mut target_start = 0;
    for (idx, word) in &items {
        if *word != "="
            || value.as_bytes().get(idx + 1) == Some(&b'=')
            || idx
                .checked_sub(1)
                .and_then(|idx| value.as_bytes().get(idx))
                .is_some_and(|ch| matches!(ch, b'=' | b'!' | b'<' | b'>' | b':'))
        {
            continue;
        }
        let target =
            value[target_start..*idx].trim_end_matches(['+', '-', '*', '/', '%', '&', '|', '^']);
        let colon = top_level_items(target)
            .into_iter()
            .find(|(_, item)| *item == ":")
            .map(|(idx, _)| idx)
            .unwrap_or(target.len());
        names.extend(target_names(&target[..colon], start + target_start));
        target_start = idx + 1;
    }
    if names.is_empty() {
        if let Some((colon, _)) = items.iter().find(|(_, word)| *word == ":") {
            names.extend(target_names(&value[..*colon], start));
        }
    }
    names
}

fn expression_scopes(
    code: &str,
    declarations: &mut HashSet<(usize, usize)>,
    position: &impl Fn(usize) -> (usize, usize),
) -> Vec<ExpressionScope> {
    // Each group collects only its own words. Nested groups are processed
    // independently, avoiding repeated scans of deeply nested expressions.
    let mut groups = Vec::new();
    let mut stack = vec![(0usize, Vec::<(usize, &str)>::new())];
    let mut idx = 0;
    while idx < code.len() {
        let ch = code[idx..].chars().next().unwrap();
        if ch == '_' || unicode_ident::is_xid_start(ch) {
            let begin = idx;
            idx += ch.len_utf8();
            while idx < code.len() {
                let next = code[idx..].chars().next().unwrap();
                if next != '_' && !unicode_ident::is_xid_continue(next) {
                    break;
                }
                idx += next.len_utf8();
            }
            stack.last_mut().unwrap().1.push((begin, &code[begin..idx]));
            continue;
        }
        match ch {
            '(' | '[' | '{' => stack.push((idx + 1, Vec::new())),
            ')' | ']' | '}' if stack.len() > 1 => {
                let (begin, words) = stack.pop().unwrap();
                groups.push((begin, idx, words));
            }
            ':' | ',' | '=' => stack.last_mut().unwrap().1.push((idx, &code[idx..idx + 1])),
            _ => {}
        }
        idx += ch.len_utf8();
    }
    let (begin, words) = stack.remove(0);
    groups.push((begin, code.len(), words));
    let mut scopes = Vec::new();
    let statements = logical_statements(code);
    for (start, end, words) in groups {
        let mut names = HashSet::new();
        let mut outer_iter = None;
        let function_parameters = code[..start.saturating_sub(1)]
            .lines()
            .next_back()
            .and_then(|line| {
                strip_keyword(line.trim_start(), "def")
                    .or_else(|| strip_keyword(line.trim_start(), "async def"))
            })
            .and_then(|rest| {
                leading_identifier(rest).map(|name| {
                    let tail = rest[name.len()..].trim();
                    tail.is_empty() || (tail.starts_with('[') && tail.ends_with(']'))
                })
            })
            .unwrap_or(false);
        for (word_idx, (offset, word)) in words.iter().enumerate() {
            // Keyword argument labels and parameter defaults are not Name
            // loads. A debug f-string field is a brace group, so its name
            // before '=' remains an executable reference.
            if *word == "="
                && start != 0
                && !function_parameters
                && code.as_bytes().get(start - 1) == Some(&b'(')
                && code.as_bytes().get(offset + 1) != Some(&b'=')
                && !offset
                    .checked_sub(1)
                    .and_then(|idx| code.as_bytes().get(idx))
                    .is_some_and(|ch| matches!(ch, b'=' | b'!' | b'<' | b'>' | b':'))
            {
                if let Some((begin, name)) = word_idx.checked_sub(1).and_then(|idx| words.get(idx))
                {
                    if leading_identifier(name).as_deref() == Some(*name) {
                        declarations.insert(position(*begin));
                    }
                }
            } else if *word == "for" && start != 0 {
                if let Some((in_idx, (in_offset, _))) = words
                    .iter()
                    .enumerate()
                    .skip(word_idx + 1)
                    .find(|(_, (_, word))| *word == "in")
                {
                    for (name, offset) in target_names(&code[offset + 3..*in_offset], offset + 3) {
                        declarations.insert(position(offset));
                        names.insert(name);
                    }
                    if outer_iter.is_none() {
                        let finish = words
                            .iter()
                            .skip(in_idx + 1)
                            .find(|(_, word)| matches!(*word, "for" | "if"))
                            .map(|(idx, _)| *idx)
                            .unwrap_or(end);
                        outer_iter = Some((in_offset + 2, finish));
                    }
                }
            } else if *word == "lambda" {
                if let Some((colon_idx, (colon, _))) = words
                    .iter()
                    .enumerate()
                    .skip(word_idx + 1)
                    .find(|(_, (_, word))| *word == ":")
                {
                    let mut parameters = HashSet::new();
                    for (begin, finish) in parameter_spans(code, offset + 6, *colon) {
                        let part = &code[begin..finish];
                        let name_part = part.trim_start().trim_start_matches('*').trim_start();
                        if let Some(name) = leading_identifier(name_part) {
                            declarations.insert(position(begin + part.len() - name_part.len()));
                            parameters.insert(name);
                        }
                    }
                    let finish = words
                        .iter()
                        .skip(colon_idx + 1)
                        .find(|(_, word)| matches!(*word, "," | "for"))
                        .map(|(idx, _)| *idx)
                        .unwrap_or(end);
                    let finish = if start == 0 {
                        statements
                            .iter()
                            .find(|(begin, end)| begin <= colon && colon < end)
                            .map(|(_, end)| finish.min(*end))
                            .unwrap_or(finish)
                    } else {
                        finish
                    };
                    scopes.push(ExpressionScope {
                        start: colon + 1,
                        end: finish,
                        outer_iter: None,
                        names: parameters,
                        is_lambda: true,
                    });
                }
            }
        }
        if !names.is_empty() {
            scopes.push(ExpressionScope {
                start,
                end,
                outer_iter,
                names,
                is_lambda: false,
            });
        }
    }
    scopes.sort_by_key(|scope| std::cmp::Reverse(scope.start));
    scopes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::identifier_tokens;

    fn excluded(source: &str, name: &str) -> Vec<(usize, usize)> {
        let lines: Vec<_> = source.lines().map(Cow::Borrowed).collect();
        let mut bindings = LexicalBindings::new(&lines, &[]);
        let mut positions = Vec::new();
        for (line_idx, line) in lines.iter().enumerate() {
            bindings.advance_line(line_idx);
            for (token, start, _) in identifier_tokens(line) {
                if token == name && bindings.excludes(line_idx, start, &token) {
                    positions.push((line_idx, start));
                }
            }
        }
        positions
    }

    #[test]
    fn multiline_parameters_capture_closures_but_not_defaults_annotations_or_globals() {
        let source = "def outer(\n    action: action = action,\n    /,\n    *items,\n    **options,\n):\n    action()\n    def nested():\n        action()\n    def explicit():\n        global action\n        action()\n    action()\naction()\n";
        assert_eq!(
            excluded(source, "action"),
            vec![(1, 4), (6, 4), (8, 8), (10, 15), (12, 4)]
        );
        assert_eq!(excluded(source, "items"), vec![(3, 5)]);
        assert_eq!(excluded(source, "options"), vec![(4, 6)]);
    }

    #[test]
    fn inline_suites_and_dedented_continuations_keep_their_actual_binding() {
        assert_eq!(
            excluded(
                "def one(action=action): return action()\naction()\n",
                "action"
            ),
            vec![(0, 8), (0, 31)]
        );
        assert_eq!(
            excluded(
                "def outer(action):\n    values = [\naction(),\n    ]\n    action()\naction()\n",
                "action"
            ),
            vec![(0, 10), (2, 0), (4, 4)]
        );
    }

    #[test]
    fn class_globals_do_not_enter_method_closures_and_nonlocal_keeps_capture() {
        assert_eq!(excluded("def outer(action):\n    class Local:\n        global action\n        action()\n        def method(self):\n            action()\n    def nested():\n        nonlocal action\n        action()\naction()\n", "action"),
            vec![(0, 10), (2, 15), (5, 12), (7, 17), (8, 8)]);
    }

    #[test]
    fn tabs_expand_to_python_columns_and_unicode_parameters_keep_byte_positions() {
        assert_eq!(python_indent(" \tvalue"), 8);
        assert_eq!(python_indent("\t \tvalue"), 16);
        assert_eq!(
            excluded("def outer(작업=작업):\n\t작업()\n작업()\n", "작업"),
            vec![(0, 10), (1, 1)]
        );
    }

    #[test]
    fn assignment_and_suite_targets_are_local_but_receivers_and_rhs_are_loads() {
        assert_eq!(
            statement_bindings("left, (right, *rest) = factory()", 0, 32)
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            vec!["left", "right", "rest"]
        );
        for source in ["obj.field = factory()", "obj[key] = factory()"] {
            assert!(statement_bindings(source, 0, source.len()).is_empty());
        }
        let source = "def outer():\n    action()\n    with factory() as (action, other):\n        action()\n    def nested():\n        action()\n    def explicit():\n        global action\n        action()\naction()\n";
        let blocked = excluded(source, "action");
        assert!(
            blocked.iter().any(|(line, _)| *line == 1),
            "a later local binding covers the whole function"
        );
        assert!(
            blocked.iter().any(|(line, _)| *line == 5),
            "closures capture local suite bindings"
        );
        assert!(
            !blocked.iter().any(|(line, _)| matches!(*line, 8 | 9)),
            "explicit globals and module loads remain eligible"
        );
    }

    #[test]
    fn comprehensions_keep_the_first_iterable_in_the_enclosing_scope() {
        assert_eq!(
            excluded(
                "[action() for action in action() if action()]\naction()\n",
                "action"
            ),
            vec![(0, 1), (0, 14), (0, 36)]
        );
        let source = "(action for (item, (action, other)) in source())\naction()\n";
        assert_eq!(excluded(source, "action").len(), 2);
        assert_eq!(
            excluded("for action in source():\n    action()\nother()\n", "action"),
            Vec::<(usize, usize)>::new(),
            "module statement loops are not whole-file expression scopes"
        );
    }

    #[test]
    fn lambda_defaults_and_outer_loads_do_not_capture_the_parameter() {
        assert_eq!(
            excluded(
                "value = lambda action=action: action()\naction()\n",
                "action"
            ),
            vec![(0, 15), (0, 30)]
        );
    }

    #[test]
    fn named_expressions_bind_the_function_and_captured_closures() {
        let source = "def consume(values):\n    action()\n    if action := values.get():\n        action()\n    def nested():\n        return action()\naction()\n";
        let blocked = excluded(source, "action");
        assert_eq!(
            blocked.iter().map(|(line, _)| *line).collect::<Vec<_>>(),
            vec![1, 2, 3, 5]
        );
        let source = "def consume(values):\n    result = [(action := item) for item in values]\n    return action()\naction()\n";
        assert_eq!(
            excluded(source, "action")
                .iter()
                .map(|(line, _)| *line)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn multiline_lambda_named_expressions_do_not_leak_into_the_containing_function() {
        let source = "def consume():\n    callback = lambda: (\n        (action := value),\n        action(),\n    )\n    return action()\n";
        assert_eq!(
            excluded(source, "action")
                .iter()
                .map(|(line, _)| *line)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
    }
}
