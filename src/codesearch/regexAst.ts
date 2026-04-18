// ──────────────────────────────────────────────────────────────────────────
// Minimal JS-regex AST + parser for Russ Cox's trigram query planner.
//
// We only need enough regex parsing to walk a user-supplied pattern and ask
// "what substrings must appear in any matching text?". Unsupported features
// (lookbehind, backreferences, named groups) degrade to NodeAny — the
// planner then emits `none` and we skip filtering for that branch. Never
// exclude candidates on parse failure.
// ──────────────────────────────────────────────────────────────────────────

export type Node =
  | { kind: 'empty' }
  | { kind: 'literal'; chars: string }
  | { kind: 'any'; dotAll: boolean }                          // . (dotAll→ includes newline)
  | { kind: 'class'; negate: boolean; ranges: Array<[number, number]> }
  | { kind: 'concat'; parts: Node[] }
  | { kind: 'alt'; parts: Node[] }
  | { kind: 'repeat'; child: Node; min: number; max: number | null }
  | { kind: 'group'; child: Node }
  | { kind: 'assertion'; type: 'bol' | 'eol' | 'wb' | 'nwb' | 'lookahead' | 'neglookahead'; child?: Node }
  | { kind: 'unsupported' };                                  // falls through as "no info"

export interface ParseOptions {
  caseInsensitive: boolean;
  dotAll: boolean;        // . matches \n
  multiline: boolean;     // ^ and $ match line boundaries
}

export function parseRegex(src: string, opts: ParseOptions): Node {
  const p = new Parser(src, opts);
  const node = p.parseAlt();
  if (p.pos < src.length) {
    // Extra chars (e.g., unmatched `)`). Accept rest as literal to avoid
    // throwing — returning `unsupported` is safer than crashing user search.
    return { kind: 'unsupported' };
  }
  return node;
}

class Parser {
  pos = 0;
  constructor(private readonly src: string, private readonly opts: ParseOptions) {}

  parseAlt(): Node {
    const parts: Node[] = [this.parseConcat()];
    while (this.peek() === '|') {
      this.pos++;
      parts.push(this.parseConcat());
    }
    return parts.length === 1 ? parts[0] : { kind: 'alt', parts };
  }

  parseConcat(): Node {
    const parts: Node[] = [];
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '|' || c === ')') { break; }
      const n = this.parseRepeat();
      if (n.kind === 'empty') { continue; }
      parts.push(n);
    }
    if (parts.length === 0) { return { kind: 'empty' }; }
    return parts.length === 1 ? parts[0] : { kind: 'concat', parts };
  }

  parseRepeat(): Node {
    const atom = this.parseAtom();
    const c = this.peek();
    let min = 1, max: number | null = 1, quant = false;
    if (c === '*') { min = 0; max = null; quant = true; this.pos++; }
    else if (c === '+') { min = 1; max = null; quant = true; this.pos++; }
    else if (c === '?') { min = 0; max = 1; quant = true; this.pos++; }
    else if (c === '{') {
      const save = this.pos;
      this.pos++;
      const mMin = this.readDigits();
      if (mMin === null) { this.pos = save; }
      else {
        let mMax: number | null = mMin;
        if (this.peek() === ',') {
          this.pos++;
          mMax = this.readDigits();
        }
        if (this.peek() === '}') {
          this.pos++;
          min = mMin; max = mMax; quant = true;
        } else {
          this.pos = save;
        }
      }
    }
    if (quant) {
      // swallow lazy marker
      if (this.peek() === '?') { this.pos++; }
      return { kind: 'repeat', child: atom, min, max };
    }
    return atom;
  }

  parseAtom(): Node {
    const c = this.peek();
    if (c === undefined) { return { kind: 'empty' }; }
    if (c === '(') { return this.parseGroup(); }
    if (c === '[') { return this.parseClass(); }
    if (c === '^') {
      this.pos++;
      return { kind: 'assertion', type: 'bol' };
    }
    if (c === '$') {
      this.pos++;
      return { kind: 'assertion', type: 'eol' };
    }
    if (c === '.') {
      this.pos++;
      return { kind: 'any', dotAll: this.opts.dotAll };
    }
    if (c === '\\') {
      return this.parseEscape();
    }
    // Plain literal char (including greedy extension: gather a run of
    // literals to fold into a single `literal` node — helps trigram
    // extraction of long substrings like "function foo").
    let s = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\' || ch === '(' || ch === ')' || ch === '[' || ch === ']' ||
          ch === '|' || ch === '*' || ch === '+' || ch === '?' || ch === '{' ||
          ch === '.' || ch === '^' || ch === '$') { break; }
      // If next char starts a quantifier, we should leave last char alone.
      if (s.length > 0) {
        const nextCh = this.src[this.pos + 1];
        if (nextCh === '*' || nextCh === '+' || nextCh === '?' || nextCh === '{') { break; }
      }
      s += this.opts.caseInsensitive ? foldCase(ch) : ch;
      this.pos++;
    }
    if (s.length === 0) {
      // peek was something funky (shouldn't happen given checks above).
      this.pos++;
      return { kind: 'empty' };
    }
    if (this.opts.caseInsensitive && hasLetter(s)) {
      return literalCaseInsensitive(s);
    }
    return { kind: 'literal', chars: s };
  }

  parseGroup(): Node {
    this.pos++; // consume (
    let type: 'capture' | 'noncapture' | 'lookahead' | 'neglookahead' | 'lookbehind' | 'neglookbehind' = 'capture';
    if (this.peek() === '?') {
      const save = this.pos;
      this.pos++;
      const p1 = this.peek();
      if (p1 === ':') { this.pos++; type = 'noncapture'; }
      else if (p1 === '=') { this.pos++; type = 'lookahead'; }
      else if (p1 === '!') { this.pos++; type = 'neglookahead'; }
      else if (p1 === '<') {
        // could be lookbehind (?<=..) / (?<!..) or named group (?<name>..)
        const p2 = this.src[this.pos + 1];
        if (p2 === '=') { this.pos += 2; type = 'lookbehind'; }
        else if (p2 === '!') { this.pos += 2; type = 'neglookbehind'; }
        else {
          // named group: skip name
          this.pos++;
          while (this.pos < this.src.length && this.src[this.pos] !== '>') { this.pos++; }
          if (this.peek() === '>') { this.pos++; }
          type = 'capture';
        }
      } else {
        // unrecognized (?...) — rewind and treat as capture to avoid infinite loop
        this.pos = save + 1; // consume '?' but nothing else
        type = 'noncapture';
      }
    }
    const child = this.parseAlt();
    if (this.peek() === ')') { this.pos++; }
    if (type === 'lookahead') { return { kind: 'assertion', type: 'lookahead', child }; }
    if (type === 'neglookahead') { return { kind: 'assertion', type: 'neglookahead', child }; }
    if (type === 'lookbehind' || type === 'neglookbehind') { return { kind: 'unsupported' }; }
    return { kind: 'group', child };
  }

  parseClass(): Node {
    this.pos++; // consume [
    let negate = false;
    if (this.peek() === '^') { negate = true; this.pos++; }
    const ranges: Array<[number, number]> = [];
    while (this.pos < this.src.length && this.peek() !== ']') {
      const startCp = this.readClassChar();
      if (startCp === null) { break; }
      if (this.peek() === '-' && this.src[this.pos + 1] !== ']') {
        this.pos++;
        const endCp = this.readClassChar();
        if (endCp === null) { ranges.push([startCp, startCp]); break; }
        ranges.push([Math.min(startCp, endCp), Math.max(startCp, endCp)]);
      } else {
        ranges.push([startCp, startCp]);
      }
    }
    if (this.peek() === ']') { this.pos++; }
    if (this.opts.caseInsensitive) { foldRangesCase(ranges); }
    return { kind: 'class', negate, ranges };
  }

  parseEscape(): Node {
    this.pos++; // consume \
    const c = this.peek();
    if (c === undefined) { return { kind: 'empty' }; }
    this.pos++;
    switch (c) {
      case 'd': return { kind: 'class', negate: false, ranges: [[0x30, 0x39]] };
      case 'D': return { kind: 'class', negate: true, ranges: [[0x30, 0x39]] };
      case 'w': return { kind: 'class', negate: false, ranges: [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]] };
      case 'W': return { kind: 'class', negate: true, ranges: [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]] };
      case 's': return { kind: 'class', negate: false, ranges: whitespaceRanges() };
      case 'S': return { kind: 'class', negate: true, ranges: whitespaceRanges() };
      case 'b': return { kind: 'assertion', type: 'wb' };
      case 'B': return { kind: 'assertion', type: 'nwb' };
      case 'n': return { kind: 'literal', chars: '\n' };
      case 'r': return { kind: 'literal', chars: '\r' };
      case 't': return { kind: 'literal', chars: '\t' };
      case 'v': return { kind: 'literal', chars: '\v' };
      case 'f': return { kind: 'literal', chars: '\f' };
      case '0': return { kind: 'literal', chars: '\0' };
      case 'x': {
        const hex = this.src.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return { kind: 'literal', chars: String.fromCharCode(parseInt(hex, 16)) };
        }
        return { kind: 'literal', chars: 'x' };
      }
      case 'u': {
        if (this.peek() === '{') {
          const end = this.src.indexOf('}', this.pos);
          if (end > this.pos) {
            const hex = this.src.slice(this.pos + 1, end);
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              this.pos = end + 1;
              return { kind: 'literal', chars: String.fromCodePoint(parseInt(hex, 16)) };
            }
          }
        }
        const hex = this.src.slice(this.pos, this.pos + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.pos += 4;
          return { kind: 'literal', chars: String.fromCharCode(parseInt(hex, 16)) };
        }
        return { kind: 'literal', chars: 'u' };
      }
      default:
        // Backreferences \1, \2, etc. → unsupported (no safe trigram info).
        if (/[1-9]/.test(c)) { return { kind: 'unsupported' }; }
        // Otherwise treat as literal escaped char (e.g., \., \*, \/).
        return {
          kind: 'literal',
          chars: this.opts.caseInsensitive ? foldCase(c) : c,
        };
    }
  }

  readClassChar(): number | null {
    const c = this.peek();
    if (c === undefined) { return null; }
    if (c === '\\') {
      this.pos++;
      const esc = this.peek();
      if (esc === undefined) { return null; }
      this.pos++;
      switch (esc) {
        case 'n': return 0x0a;
        case 'r': return 0x0d;
        case 't': return 0x09;
        case 'v': return 0x0b;
        case 'f': return 0x0c;
        case '0': return 0x00;
        case 'x': {
          const hex = this.src.slice(this.pos, this.pos + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) { this.pos += 2; return parseInt(hex, 16); }
          return esc.charCodeAt(0);
        }
        default: return esc.charCodeAt(0);
      }
    }
    this.pos++;
    return c.charCodeAt(0);
  }

  readDigits(): number | null {
    let n = 0, read = false;
    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos);
      if (code < 0x30 || code > 0x39) { break; }
      n = n * 10 + (code - 0x30);
      this.pos++;
      read = true;
      if (n > 1_000_000) { break; }
    }
    return read ? n : null;
  }

  peek(): string | undefined {
    return this.pos < this.src.length ? this.src[this.pos] : undefined;
  }
}

function foldCase(ch: string): string {
  if (ch.length !== 1) { return ch.toLowerCase(); }
  const c = ch.charCodeAt(0);
  if (c >= 0x41 && c <= 0x5a) { return String.fromCharCode(c + 32); }
  return ch;
}

function hasLetter(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) { return true; }
  }
  return false;
}

// Case-insensitive literal: split each letter into a 2-option class.
function literalCaseInsensitive(s: string): Node {
  const parts: Node[] = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) {
      parts.push({ kind: 'class', negate: false, ranges: [[c, c], [c - 32, c - 32]] });
    } else if (c >= 0x41 && c <= 0x5a) {
      parts.push({ kind: 'class', negate: false, ranges: [[c, c], [c + 32, c + 32]] });
    } else {
      parts.push({ kind: 'literal', chars: ch });
    }
  }
  if (parts.length === 1) { return parts[0]; }
  return { kind: 'concat', parts };
}

function whitespaceRanges(): Array<[number, number]> {
  return [
    [0x09, 0x0d],                 // \t \n \v \f \r
    [0x20, 0x20],                 // space
    [0xa0, 0xa0], [0x1680, 0x1680],
    [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f],
    [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
  ];
}

function foldRangesCase(ranges: Array<[number, number]>): void {
  const extra: Array<[number, number]> = [];
  for (const [lo, hi] of ranges) {
    if (lo <= 0x5a && hi >= 0x41) {
      const lo2 = Math.max(lo, 0x41) + 32;
      const hi2 = Math.min(hi, 0x5a) + 32;
      if (lo2 <= hi2) { extra.push([lo2, hi2]); }
    }
    if (lo <= 0x7a && hi >= 0x61) {
      const lo2 = Math.max(lo, 0x61) - 32;
      const hi2 = Math.min(hi, 0x7a) - 32;
      if (lo2 <= hi2) { extra.push([lo2, hi2]); }
    }
  }
  ranges.push(...extra);
}
