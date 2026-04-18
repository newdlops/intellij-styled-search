// ──────────────────────────────────────────────────────────────────────────
// TrigramQuery: boolean expression over required trigrams.
//
//   any    — no constraint (matches every file)
//   all    — impossible (matches no file); used when regex can never match
//   tri    — file must contain this trigram
//   and    — every child must hold
//   or     — at least one child must hold
//
// Constructors auto-simplify: an `and` with no children → any; an `or` with
// no children → all; singleton and/or → the single child. This keeps the
// tree small as the analyzer composes it.
// ──────────────────────────────────────────────────────────────────────────

export type TrigramQuery =
  | { kind: 'any' }
  | { kind: 'all' }
  | { kind: 'tri'; value: string }
  | { kind: 'and'; children: TrigramQuery[] }
  | { kind: 'or'; children: TrigramQuery[] };

const ANY: TrigramQuery = { kind: 'any' };
const ALL: TrigramQuery = { kind: 'all' };

export function qAny(): TrigramQuery { return ANY; }
export function qAll(): TrigramQuery { return ALL; }

export function qTri(value: string): TrigramQuery {
  return { kind: 'tri', value };
}

export function qAnd(children: TrigramQuery[]): TrigramQuery {
  const flat: TrigramQuery[] = [];
  const triSeen = new Set<string>();
  for (const c of children) {
    if (c.kind === 'any') { continue; }
    if (c.kind === 'all') { return ALL; }
    if (c.kind === 'and') {
      for (const g of c.children) {
        if (g.kind === 'tri') {
          if (triSeen.has(g.value)) { continue; }
          triSeen.add(g.value);
        }
        flat.push(g);
      }
    } else {
      if (c.kind === 'tri') {
        if (triSeen.has(c.value)) { continue; }
        triSeen.add(c.value);
      }
      flat.push(c);
    }
  }
  if (flat.length === 0) { return ANY; }
  if (flat.length === 1) { return flat[0]; }
  return { kind: 'and', children: flat };
}

export function qOr(children: TrigramQuery[]): TrigramQuery {
  const flat: TrigramQuery[] = [];
  const triSeen = new Set<string>();
  for (const c of children) {
    if (c.kind === 'all') { continue; }
    if (c.kind === 'any') { return ANY; }
    if (c.kind === 'or') {
      for (const g of c.children) {
        if (g.kind === 'tri') {
          if (triSeen.has(g.value)) { continue; }
          triSeen.add(g.value);
        }
        flat.push(g);
      }
    } else {
      if (c.kind === 'tri') {
        if (triSeen.has(c.value)) { continue; }
        triSeen.add(c.value);
      }
      flat.push(c);
    }
  }
  if (flat.length === 0) { return ALL; }
  if (flat.length === 1) { return flat[0]; }
  return { kind: 'or', children: flat };
}

// ─── evaluation ───────────────────────────────────────────────────────────

export interface PostingSource {
  /** Set of fileIds containing the trigram, or null if the trigram was
   *  pruned / never indexed (treat as "any file could contain it"). */
  get(tri: string): ReadonlySet<number> | null;
  /** All fileIds known to the index — used when a subtree is `any`. */
  allFiles(): ReadonlySet<number>;
}

/** Evaluate query against the index. Returns the candidate fileId set.
 *  `null` means "index can't constrain" (i.e., every file is a candidate —
 *  caller should fall back to full scan). */
export function evalQuery(q: TrigramQuery, src: PostingSource): Set<number> | null {
  switch (q.kind) {
    case 'any':
      return null;
    case 'all':
      return new Set();
    case 'tri': {
      const s = src.get(q.value);
      return s ? new Set(s) : null;
    }
    case 'and': {
      // Pre-sort by known cardinality: smallest posting lists first so we
      // short-circuit as soon as the working set is empty.
      const evaluated: Array<{ size: number; value: Set<number> | null }> = [];
      for (const c of q.children) {
        const r = evalQuery(c, src);
        if (r && r.size === 0) { return new Set(); }
        evaluated.push({ size: r ? r.size : Number.MAX_SAFE_INTEGER, value: r });
      }
      evaluated.sort((a, b) => a.size - b.size);
      let acc: Set<number> | null = null;
      for (const e of evaluated) {
        if (e.value === null) { continue; }          // no constraint
        if (acc === null) { acc = new Set(e.value); continue; }
        const next = new Set<number>();
        const [small, big] = acc.size <= e.value.size ? [acc, e.value] : [e.value, acc];
        for (const id of small) { if (big.has(id)) { next.add(id); } }
        acc = next;
        if (acc.size === 0) { return acc; }
      }
      return acc;
    }
    case 'or': {
      let anyUnconstrained = false;
      const acc = new Set<number>();
      for (const c of q.children) {
        const r = evalQuery(c, src);
        if (r === null) { anyUnconstrained = true; break; }
        for (const id of r) { acc.add(id); }
      }
      if (anyUnconstrained) { return null; }
      return acc;
    }
  }
}
