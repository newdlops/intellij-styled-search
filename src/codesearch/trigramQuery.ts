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

/** Posting list type — sorted ascending list of fileIds. Uint32Array is
 *  the canonical form (on-disk + in-memory), but Set is accepted for
 *  build-time maps that haven't been compacted yet. */
export type Posting = Uint32Array | ReadonlySet<number>;

export interface PostingSource {
  /** Posting list of fileIds containing the trigram, or null if the
   *  trigram was never indexed (treat as "any file could contain it"). */
  get(tri: string): Posting | null;
  /** All fileIds known to the index — used when a subtree is `any`. */
  allFiles(): ReadonlySet<number>;
}

function toSortedArray(p: Posting): Uint32Array {
  if (p instanceof Uint32Array) { return p; }
  const out = new Uint32Array(p.size);
  let i = 0;
  for (const id of p) { out[i++] = id; }
  out.sort();
  return out;
}

/** Sorted-merge intersection. Both inputs must be ascending. */
function intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(Math.min(a.length, b.length));
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x === y) { out[k++] = x; i++; j++; }
    else if (x < y) { i++; }
    else { j++; }
  }
  return out.subarray(0, k);
}

/** Sorted-merge union. Both inputs must be ascending. */
function unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
  const out = new Uint32Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x === y) { out[k++] = x; i++; j++; }
    else if (x < y) { out[k++] = x; i++; }
    else { out[k++] = y; j++; }
  }
  while (i < a.length) { out[k++] = a[i++]; }
  while (j < b.length) { out[k++] = b[j++]; }
  return out.subarray(0, k);
}

/** Evaluate query against the index. Returns the candidate fileId array
 *  (sorted ascending). `null` means "index can't constrain" (every file is
 *  a candidate — caller should fall back to full scan). Empty array means
 *  the query provably matches zero files. */
export function evalQuery(q: TrigramQuery, src: PostingSource): Uint32Array | null {
  switch (q.kind) {
    case 'any':
      return null;
    case 'all':
      return new Uint32Array(0);
    case 'tri': {
      const s = src.get(q.value);
      return s ? toSortedArray(s) : null;
    }
    case 'and': {
      // Evaluate all children, sort by cardinality (smallest first) so the
      // working set shrinks fast and short-circuits to empty early.
      const evaluated: Array<{ size: number; value: Uint32Array | null }> = [];
      for (const c of q.children) {
        const r = evalQuery(c, src);
        if (r && r.length === 0) { return new Uint32Array(0); }
        evaluated.push({ size: r ? r.length : Number.MAX_SAFE_INTEGER, value: r });
      }
      evaluated.sort((a, b) => a.size - b.size);
      let acc: Uint32Array | null = null;
      for (const e of evaluated) {
        if (e.value === null) { continue; }
        if (acc === null) { acc = e.value; continue; }
        acc = intersectSorted(acc, e.value);
        if (acc.length === 0) { return acc; }
      }
      return acc;
    }
    case 'or': {
      let anyUnconstrained = false;
      let acc: Uint32Array = new Uint32Array(0);
      for (const c of q.children) {
        const r = evalQuery(c, src);
        if (r === null) { anyUnconstrained = true; break; }
        acc = unionSorted(acc, r);
      }
      if (anyUnconstrained) { return null; }
      return acc;
    }
  }
}
