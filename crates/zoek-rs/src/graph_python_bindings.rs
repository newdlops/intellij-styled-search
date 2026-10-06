//! Python parameter bindings that cannot refer to same-named indexed symbols.
//! Keep header expressions in their enclosing scope and follow indentation,
//! including closures, explicit globals and multiline/inline suites.
use super::{
    leading_identifier, matching_close_paren, starts_python_function_signature, strip_keyword,
    GraphSymbol,
};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct ParameterBindings {
    declarations: HashSet<(usize, usize)>,
    scopes: Vec<Scope>,
    active: Vec<usize>,
    next: usize,
}

struct Scope {
    header_line: usize,
    indent: usize,
    body_start: (usize, usize),
    end_line: usize,
    is_class: bool,
    parameters: HashSet<String>,
    globals: HashSet<String>,
    indexed_names: HashSet<String>,
}

impl ParameterBindings {
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
                            indexed_names: HashSet::new(),
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
                            .indexed_names
                            .insert(symbol.name.clone());
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
        result
    }

    pub(super) fn advance_line(&mut self, line: usize) {
        while self.next < self.scopes.len() && self.scopes[self.next].header_line <= line {
            self.active.push(self.next);
            self.next += 1;
        }
        self.active.retain(|idx| self.scopes[*idx].end_line > line);
    }

    pub(super) fn excludes(&self, line: usize, column: usize, name: &str) -> bool {
        if self.declarations.contains(&(line, column)) {
            return true;
        }
        let mut innermost = true;
        for idx in self.active.iter().rev() {
            let scope = &self.scopes[*idx];
            if (line, column) < scope.body_start {
                continue;
            }
            // Class namespace bindings do not enter method closures.
            if !scope.is_class || innermost {
                if scope.globals.contains(name) || scope.indexed_names.contains(name) {
                    return false;
                }
                if scope.parameters.contains(name) {
                    return true;
                }
            }
            innermost = false;
        }
        false
    }
}

fn python_indent(line: &str) -> usize {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::identifier_tokens;

    fn excluded(source: &str, name: &str) -> Vec<(usize, usize)> {
        let lines: Vec<_> = source.lines().map(Cow::Borrowed).collect();
        let mut bindings = ParameterBindings::new(&lines, &[]);
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
            vec![(1, 4), (6, 4), (8, 8), (12, 4)]
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
            vec![(0, 10), (5, 12), (7, 17), (8, 8)]);
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
}
