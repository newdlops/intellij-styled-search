//! Mask Python literal text while retaining executable f-string fields.
//! Every mask preserves UTF-8 byte offsets; reference columns use the source.
use std::borrow::Cow;

#[derive(Default)]
pub(super) struct Sanitizer {
    frames: Vec<Frame>,
}

enum Frame {
    Literal {
        quote: u8,
        width: usize,
        formatted: bool,
        raw: bool,
    },
    Field {
        delimiters: Vec<u8>,
        phase: Phase,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Expression,
    Conversion,
    Format,
}

impl Sanitizer {
    pub(super) fn line<'a>(&mut self, line: &'a str) -> Cow<'a, str> {
        if self.frames.is_empty() && !line.bytes().any(|b| matches!(b, b'\'' | b'"' | b'#')) {
            return Cow::Borrowed(line);
        }
        let bytes = line.as_bytes();
        let mut out = bytes.to_vec();
        let mut idx = 0;
        let mut escaped_newline = false;
        while idx < bytes.len() {
            let ch = bytes[idx];
            match self.frames.last_mut() {
                Some(Frame::Literal {
                    quote,
                    width,
                    formatted,
                    raw,
                }) => {
                    let (quote, width, formatted, raw) = (*quote, *width, *formatted, *raw);
                    if ch == quote && bytes[idx..].starts_with(&[quote; 3][..width]) {
                        out[idx..idx + width].fill(b' ');
                        idx += width;
                        self.frames.pop();
                    } else if ch == b'\\' {
                        out[idx] = b' ';
                        idx += 1;
                        if idx == bytes.len() {
                            escaped_newline = true;
                        } else if !raw && bytes[idx..].starts_with(b"N{") {
                            let end = bytes[idx..]
                                .iter()
                                .position(|b| *b == b'}')
                                .map(|end| idx + end + 1)
                                .unwrap_or(bytes.len());
                            out[idx..end].fill(b' ');
                            idx = end;
                        } else if !formatted || !matches!(bytes[idx], b'{' | b'}') {
                            let len = line[idx..].chars().next().unwrap().len_utf8();
                            out[idx..idx + len].fill(b' ');
                            idx += len;
                        }
                    } else if formatted && ch == b'{' && bytes.get(idx + 1) != Some(&b'{') {
                        self.frames.push(Frame::Field {
                            delimiters: Vec::new(),
                            phase: Phase::Expression,
                        });
                        idx += 1;
                    } else {
                        let len = if formatted
                            && matches!(ch, b'{' | b'}')
                            && bytes.get(idx + 1) == Some(&ch)
                        {
                            2
                        } else {
                            line[idx..].chars().next().unwrap().len_utf8()
                        };
                        out[idx..idx + len].fill(b' ');
                        idx += len;
                    }
                }
                Some(Frame::Field {
                    phase: Phase::Conversion | Phase::Format,
                    ..
                }) => {
                    if ch == b'}' {
                        self.frames.pop();
                        idx += 1;
                    } else if ch == b'{' {
                        self.frames.push(Frame::Field {
                            delimiters: Vec::new(),
                            phase: Phase::Expression,
                        });
                        idx += 1;
                    } else {
                        if ch == b':' {
                            if let Some(Frame::Field { phase, .. }) = self.frames.last_mut() {
                                *phase = Phase::Format;
                            }
                        }
                        let len = line[idx..].chars().next().unwrap().len_utf8();
                        out[idx..idx + len].fill(b' ');
                        idx += len;
                    }
                }
                _ => {
                    if ch == b'#' {
                        out[idx..].fill(b' ');
                        break;
                    }
                    if let Some((prefix, quote, width, formatted, raw)) = literal_start(line, idx) {
                        let end = idx + prefix + width;
                        out[idx..end].fill(b' ');
                        idx = end;
                        self.frames.push(Frame::Literal {
                            quote,
                            width,
                            formatted,
                            raw,
                        });
                        continue;
                    }
                    if let Some(Frame::Field { delimiters, phase }) = self.frames.last_mut() {
                        match ch {
                            b'(' | b'[' | b'{' => delimiters.push(ch),
                            b')' | b']' | b'}' if !delimiters.is_empty() => {
                                delimiters.pop();
                            }
                            b'}' => {
                                self.frames.pop();
                            }
                            b':' if delimiters.is_empty() => {
                                *phase = Phase::Format;
                                out[idx] = b' ';
                            }
                            b'!' if delimiters.is_empty() && bytes.get(idx + 1) != Some(&b'=') => {
                                *phase = Phase::Conversion;
                                out[idx] = b' ';
                            }
                            _ => {}
                        }
                    }
                    idx += line[idx..].chars().next().unwrap().len_utf8();
                }
            }
        }
        // An incomplete ordinary quote must not hide the following statement.
        // Triple strings and open f-string expressions legitimately span lines.
        if !escaped_newline && matches!(self.frames.last(), Some(Frame::Literal { width: 1, .. })) {
            self.frames.pop();
        }
        Cow::Owned(String::from_utf8(out).expect("mask preserves character boundaries"))
    }
}

fn literal_start(line: &str, idx: usize) -> Option<(usize, u8, usize, bool, bool)> {
    let rest = &line[idx..];
    let boundary = idx == 0
        || !line[..idx]
            .chars()
            .next_back()
            .is_some_and(|ch| ch == '_' || unicode_ident::is_xid_continue(ch));
    for prefix in ["fr", "rf", "br", "rb", "f", "r", "b", "u", ""] {
        if !prefix.is_empty() && !boundary {
            continue;
        }
        if !rest
            .get(..prefix.len())
            .is_some_and(|part| part.eq_ignore_ascii_case(prefix))
        {
            continue;
        }
        let quote = *rest.as_bytes().get(prefix.len())?;
        if !matches!(quote, b'\'' | b'"') {
            continue;
        }
        let width = if rest.as_bytes()[prefix.len()..].starts_with(&[quote; 3]) {
            3
        } else {
            1
        };
        return Some((
            prefix.len(),
            quote,
            width,
            prefix.contains('f'),
            prefix.contains('r'),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::identifier_tokens;

    fn names(source: &str) -> Vec<String> {
        let mut state = Sanitizer::default();
        source
            .lines()
            .flat_map(|line| {
                identifier_tokens(&state.line(line))
                    .into_iter()
                    .map(|(name, _, _)| name)
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn fields_keep_calls_nested_literals_and_dynamic_format_specs_separate() {
        assert_eq!(
            names(
                r#"f"action {{ignored()}} {action('hidden()'):>{width()}.{precision()}f} {other()!r}" "#
            ),
            vec!["action", "width", "precision", "other"]
        );
        assert_eq!(
            names(r#"f"{outer(f'{inner()}') + mapping['hidden()']}" "#),
            vec!["outer", "inner", "mapping"]
        );
        assert_eq!(
            names(r#"f"{ {'hidden': action()} } {left != right}" "#),
            vec!["action", "left", "right"]
        );
    }

    #[test]
    fn raw_escapes_unicode_and_multiline_fields_preserve_offsets() {
        let source = "value = rf\"한글 {{ignored()}} \\{작업()}\"";
        let masked = Sanitizer::default().line(source).into_owned();
        assert_eq!(masked.len(), source.len());
        assert_eq!(masked.find("작업"), source.find("작업"));
        assert_eq!(
            names("f\"\\N{GREEK CAPITAL LETTER DELTA} {action()}\""),
            vec!["action"]
        );
        assert_eq!(names("f\"\"\"text ignored()\n{action(\n    'hidden()', # ignored()\n)} {value:{width()}}\n\"\"\"\nafter()"),
            vec!["action", "value", "width", "after"]);
    }

    #[test]
    fn ordinary_and_escaped_triple_literals_do_not_expose_text() {
        assert_eq!(
            names("r\"hidden()\"\n'''hidden() \\''' still_hidden()\n'''\nafter()"),
            vec!["after"]
        );
        assert_eq!(
            names("broken = 'unterminated\nafter()"),
            vec!["broken", "after"]
        );
    }
}
