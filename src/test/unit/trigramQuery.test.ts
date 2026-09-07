import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTrigramsLower } from '../../codesearch/trigrams';
import { evalQuery, qAll, qAnd, qAny, qOr, qTri, type PostingSource, type TrigramQuery } from '../../codesearch/trigramQuery';

test('rolling trigrams preserve persisted UTF-16 lowercase semantics', () => {
  const codeUnits = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).join('');
  for (const text of ['', 'A', 'AB', 'ABC', 'AAAA', 'ΟΣA', 'xİyZ', '한글\r\n😀ABC', '\ud800a\udfff', codeUnits]) {
    const expected = new Set<string>();
    for (let i = 0; i + 2 < text.length; i++) {
      expected.add(text[i].toLowerCase() + text[i + 1].toLowerCase() + text[i + 2].toLowerCase());
    }
    assert.deepEqual(extractTrigramsLower(text), expected);
  }
});

test('AND reads selective postings first and skips the rest after an empty intersection', () => {
  const reads: string[] = [];
  const postings = new Map([
    ['common', Uint32Array.from({ length: 1000 }, (_, i) => i)],
    ['left', Uint32Array.of(10)],
    ['right', Uint32Array.of(20)],
  ]);
  const source: PostingSource = {
    get: (tri) => { reads.push(tri); return postings.get(tri) ?? null; },
    size: (tri) => postings.get(tri)?.length,
    allFiles: () => new Set(),
  };
  assert.deepEqual(evalQuery(qAnd(['common', 'left', 'right'].map(qTri)), source), new Uint32Array());
  assert.deepEqual(reads, ['left', 'right']);
  assert.deepEqual(postings.get('left'), Uint32Array.of(10), 'query evaluation must not mutate cached postings');
});

test('metadata ordering preserves unknown, empty, nested AND/OR and unsorted mutable postings', () => {
  const postings = new Map<string, Uint32Array | Set<number>>([
    ['a', Uint32Array.of(1, 2, 5)],
    ['b', new Set([5, 3, 2])],
    ['c', Uint32Array.of(3, 4)],
    ['empty', new Uint32Array()],
  ]);
  const source: PostingSource = {
    get: (tri) => postings.get(tri) ?? null,
    size: (tri) => {
      const posting = postings.get(tri);
      return posting instanceof Set ? posting.size : posting?.length;
    },
    allFiles: () => new Set([1, 2, 3, 4, 5]),
  };
  // Independent set algebra oracle, including null = unconstrained.
  const expected = (query: TrigramQuery): Set<number> | null => {
    if (query.kind === 'any') { return null; }
    if (query.kind === 'all') { return new Set(); }
    if (query.kind === 'tri') {
      const posting = postings.get(query.value);
      return posting ? new Set(posting) : null;
    }
    let result: Set<number> | null = query.kind === 'and' ? null : new Set();
    for (const child of query.children) {
      const value = expected(child);
      if (query.kind === 'or') {
        if (value === null) { return null; }
        for (const id of value) { result!.add(id); }
      } else if (value !== null) {
        result = result === null ? value : new Set([...result].filter((id) => value.has(id)));
      }
    }
    return result;
  };
  const leaves = [qAny(), qAll(), ...['a', 'b', 'c', 'empty', 'missing'].map(qTri)];
  const normalize = (value: Iterable<number> | null) => value === null ? null : [...value].sort((a, b) => a - b);
  for (const a of leaves) {
    for (const b of leaves) {
      for (const c of leaves) {
        for (const query of [qAnd([a, qOr([b, c])]), qOr([a, qAnd([b, c])])]) {
          assert.deepEqual(normalize(evalQuery(query, source)), normalize(expected(query)));
          assert.deepEqual(normalize(evalQuery(query, { ...source, size: undefined })), normalize(expected(query)));
        }
      }
    }
  }
  assert.deepEqual([...postings.get('b')!], [5, 3, 2], 'mutable input order must be preserved');
});
