import { Node } from './regexAst';
import { TrigramQuery, qAll, qAny, qAnd, qOr, qTri } from './trigramQuery';

// ──────────────────────────────────────────────────────────────────────────
// Russ Cox's RegexInfo analysis (cindex/regexp.go in the Go implementation).
//
// For each regex AST node we compute:
//   emptyable — can match empty string?
//   exact     — finite set of exact strings it could match (or null when
//               infinite / too many)
//   prefix    — set of non-empty prefixes that any match must START with
//   suffix    — set of non-empty suffixes that any match must END with
//   match     — TrigramQuery that any match's text must satisfy
//
// `concat`, `alternate`, `repeat` combine two RegexInfos. The query we
// ultimately hand to the index is `info.match` simplified and anded with
// the cross-boundary trigrams derived from prefix/suffix during concat.
//
// We cap exact/prefix/suffix cardinality and total string length — overlong
// alternations like `(foo|bar|baz|… thousands …)` collapse to "no info"
// rather than exploding memory.
// ──────────────────────────────────────────────────────────────────────────

export interface RegexInfo {
  emptyable: boolean;
  exact: Set<string> | null;
  prefix: Set<string>;
  suffix: Set<string>;
  match: TrigramQuery;
}

const MAX_EXACT = 64;
const MAX_FIX = 64;
const MAX_STR_LEN = 128;

export function analyze(node: Node): RegexInfo {
  switch (node.kind) {
    case 'empty':
      return infoEmpty();
    case 'literal':
      return infoLiteral(node.chars);
    case 'any':
      return infoAny(node.dotAll);
    case 'class':
      return infoClass(node);
    case 'concat':
      return node.parts.reduce((acc, p) => concat(acc, analyze(p)), infoEmpty());
    case 'alt':
      return node.parts.map(analyze).reduce((acc, p) => alternate(acc, p), infoNever());
    case 'repeat':
      return repeat(analyze(node.child), node.min, node.max);
    case 'group':
      return analyze(node.child);
    case 'assertion':
      // Anchors don't consume characters — treat as empty-matching with no
      // trigram constraint. (Lookaheads could be intersected, but keeping
      // simple correctness is more important than squeezing filtering.)
      return infoEmpty();
    case 'unsupported':
      return infoAnyString();
  }
}

// ─── leaf constructors ────────────────────────────────────────────────────

function infoEmpty(): RegexInfo {
  return {
    emptyable: true,
    exact: new Set(['']),
    prefix: new Set(['']),
    suffix: new Set(['']),
    match: qAny(),
  };
}

function infoNever(): RegexInfo {
  return {
    emptyable: false,
    exact: new Set(),
    prefix: new Set(),
    suffix: new Set(),
    match: qAll(),    // impossible — matches nothing
  };
}

function infoAnyString(): RegexInfo {
  // Matches any string (including empty). No trigram info.
  return {
    emptyable: true,
    exact: null,
    prefix: new Set(['']),
    suffix: new Set(['']),
    match: qAny(),
  };
}

function infoLiteral(s: string): RegexInfo {
  if (s.length === 0) { return infoEmpty(); }
  return {
    emptyable: false,
    exact: new Set([s]),
    prefix: new Set([s]),
    suffix: new Set([s]),
    match: qAny(),
  };
}

function infoAny(dotAll: boolean): RegexInfo {
  // `.` matches any single char (excluding \n unless dotAll).
  // No trigram constraint in either direction; just "some char".
  void dotAll;
  return {
    emptyable: false,
    exact: null,
    prefix: new Set(['']),
    suffix: new Set(['']),
    match: qAny(),
  };
}

function infoClass(n: Node & { kind: 'class' }): RegexInfo {
  // Enumerate chars if the class is small enough to meaningfully narrow
  // trigram queries; otherwise treat as "any single char".
  if (n.negate) { return infoAny(true); }
  let total = 0;
  for (const [lo, hi] of n.ranges) { total += hi - lo + 1; }
  if (total === 0) { return infoNever(); }
  if (total > 32) { return infoAny(true); }
  const exact = new Set<string>();
  for (const [lo, hi] of n.ranges) {
    for (let c = lo; c <= hi; c++) {
      exact.add(String.fromCodePoint(c));
    }
  }
  return {
    emptyable: false,
    exact,
    prefix: new Set(exact),
    suffix: new Set(exact),
    match: qAny(),
  };
}

// ─── combinators ──────────────────────────────────────────────────────────

function concat(l: RegexInfo, r: RegexInfo): RegexInfo {
  const out: RegexInfo = {
    emptyable: l.emptyable && r.emptyable,
    exact: null,
    prefix: new Set(),
    suffix: new Set(),
    match: qAnd([l.match, r.match]),
  };

  // Cross-boundary trigrams: every suffix of l concatenated with every prefix
  // of r must appear. Add those as trigram query nodes.
  if (l.suffix.size > 0 && r.prefix.size > 0) {
    const cross: TrigramQuery[] = [];
    for (const ls of l.suffix) {
      for (const rp of r.prefix) {
        const joined = ls + rp;
        const tris = trigramsOf(joined);
        if (tris.length > 0) {
          cross.push(qAnd(tris.map(qTri)));
        }
      }
    }
    if (cross.length > 0) {
      out.match = qAnd([out.match, qOr(cross)]);
    }
  }

  // Combine exact if both sides are finite and product is bounded.
  if (l.exact && r.exact) {
    const combined = new Set<string>();
    outer: for (const a of l.exact) {
      for (const b of r.exact) {
        if (combined.size >= MAX_EXACT) { break outer; }
        if (a.length + b.length > MAX_STR_LEN) { continue; }
        combined.add(a + b);
      }
    }
    if (combined.size >= MAX_EXACT) {
      out.exact = null;
    } else {
      out.exact = combined;
    }
  }

  // prefix = l.prefix ++ (if l.emptyable then r.prefix)
  out.prefix = new Set();
  if (out.exact) {
    for (const s of out.exact) { out.prefix.add(s); }
  } else {
    if (l.exact) {
      for (const a of l.exact) {
        for (const p of r.prefix) {
          if (out.prefix.size >= MAX_FIX) { break; }
          if (a.length + p.length > MAX_STR_LEN) { continue; }
          out.prefix.add(a + p);
        }
      }
    } else {
      for (const p of l.prefix) {
        if (out.prefix.size >= MAX_FIX) { break; }
        out.prefix.add(p);
      }
      if (l.emptyable) {
        for (const p of r.prefix) {
          if (out.prefix.size >= MAX_FIX) { break; }
          out.prefix.add(p);
        }
      }
    }
  }

  // suffix = (if r.emptyable then l.suffix) ++ r.suffix
  out.suffix = new Set();
  if (out.exact) {
    for (const s of out.exact) { out.suffix.add(s); }
  } else {
    if (r.exact) {
      for (const b of r.exact) {
        for (const s of l.suffix) {
          if (out.suffix.size >= MAX_FIX) { break; }
          if (s.length + b.length > MAX_STR_LEN) { continue; }
          out.suffix.add(s + b);
        }
      }
    } else {
      for (const s of r.suffix) {
        if (out.suffix.size >= MAX_FIX) { break; }
        out.suffix.add(s);
      }
      if (r.emptyable) {
        for (const s of l.suffix) {
          if (out.suffix.size >= MAX_FIX) { break; }
          out.suffix.add(s);
        }
      }
    }
  }

  return simplify(out);
}

function alternate(l: RegexInfo, r: RegexInfo): RegexInfo {
  if (l === r) { return l; }
  if (setIsEmpty(l.exact) && l.match === qAll()) { return r; }  // l never matches
  if (setIsEmpty(r.exact) && r.match === qAll()) { return l; }
  const out: RegexInfo = {
    emptyable: l.emptyable || r.emptyable,
    exact: null,
    prefix: unionCap(l.prefix, r.prefix, MAX_FIX),
    suffix: unionCap(l.suffix, r.suffix, MAX_FIX),
    match: qOr([l.match, r.match]),
  };
  if (l.exact && r.exact) {
    const combined = new Set<string>();
    let overflow = false;
    for (const s of l.exact) {
      if (combined.size >= MAX_EXACT) { overflow = true; break; }
      combined.add(s);
    }
    if (!overflow) {
      for (const s of r.exact) {
        if (combined.size >= MAX_EXACT) { overflow = true; break; }
        combined.add(s);
      }
    }
    out.exact = overflow ? null : combined;
  }
  return simplify(out);
}

function repeat(r: RegexInfo, min: number, max: number | null): RegexInfo {
  if (min === 0 && max === 0) { return infoEmpty(); }
  if (min === 0 && max === 1) {
    // r?
    const out: RegexInfo = {
      emptyable: true,
      exact: null,
      prefix: new Set(['']),
      suffix: new Set(['']),
      match: qAny(),    // optional → no required trigrams
    };
    for (const p of r.prefix) { if (out.prefix.size < MAX_FIX) out.prefix.add(p); }
    for (const s of r.suffix) { if (out.suffix.size < MAX_FIX) out.suffix.add(s); }
    return simplify(out);
  }
  if (min === 0) {
    // r* — no required matches, no useful prefix/suffix
    return infoAnyString();
  }
  // min >= 1: at least one r is required. We can keep r's constraints.
  if (min === 1 && max === null) {
    // r+
    return {
      emptyable: false,
      exact: null,
      prefix: new Set(r.prefix),
      suffix: new Set(r.suffix),
      match: r.match,
    };
  }
  // General case: r{min,max}. Concat r with itself min times (cap at 3).
  const reps = Math.min(min, 3);
  let out = r;
  for (let i = 1; i < reps; i++) { out = concat(out, r); }
  if (max === null || max > reps) {
    // Tail of repetitions (r{0, max-reps}) contributes no required info.
    // Just widen match/prefix/suffix to allow longer matches.
    const tail = infoAnyString();
    out = concat(out, tail);
  }
  return out;
}

// ─── simplification ───────────────────────────────────────────────────────

function simplify(info: RegexInfo): RegexInfo {
  // If exact set is small and finite, derive a tight trigram query from it.
  if (info.exact && info.exact.size > 0 && info.exact.size <= MAX_EXACT) {
    const alternatives: TrigramQuery[] = [];
    let tooShort = false;
    for (const s of info.exact) {
      if (s.length < 3) { tooShort = true; break; }
      const tris = trigramsOf(s);
      if (tris.length === 0) { tooShort = true; break; }
      alternatives.push(qAnd(tris.map(qTri)));
    }
    if (!tooShort) {
      info.match = qAnd([info.match, qOr(alternatives)]);
    }
  }
  // If prefix and suffix produce trigrams, add them.
  const requiredFromFix = (fixes: Set<string>): TrigramQuery => {
    const alts: TrigramQuery[] = [];
    let anyShort = false;
    for (const s of fixes) {
      if (s.length < 3) { anyShort = true; break; }
      const tris = trigramsOf(s);
      alts.push(qAnd(tris.map(qTri)));
    }
    if (anyShort || alts.length === 0) { return qAny(); }
    return qOr(alts);
  };
  info.match = qAnd([info.match, requiredFromFix(info.prefix), requiredFromFix(info.suffix)]);
  return info;
}

export function trigramsOf(s: string): string[] {
  if (s.length < 3) { return []; }
  const out: string[] = [];
  // Fold to lowercase for ASCII A–Z to match index's lowercase convention.
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) { buf += String.fromCharCode(c + 32); }
    else { buf += s[i]; }
  }
  for (let i = 0; i <= buf.length - 3; i++) {
    out.push(buf.slice(i, i + 3));
  }
  return out;
}

function setIsEmpty(s: Set<string> | null): boolean {
  return !!(s && s.size === 0);
}

function unionCap(a: Set<string>, b: Set<string>, cap: number): Set<string> {
  const out = new Set<string>();
  for (const s of a) { if (out.size >= cap) { return out; } out.add(s); }
  for (const s of b) { if (out.size >= cap) { return out; } out.add(s); }
  return out;
}
