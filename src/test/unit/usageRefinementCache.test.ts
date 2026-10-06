import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageRefinementCache } from '../../internal/usageRefinementCache';

test('refinement reuse is bounded, cloned, expiring, and keyed by source/graph version', async () => {
  let now = 0;
  let calls = 0;
  const cache = new UsageRefinementCache<number[]>((value) => [...value], (value) => value.length, () => now, 2, 3, 5);
  const compute = async () => { calls++; return [calls]; };
  const first = await cache.get('graph1/doc1', compute, () => true);
  first[0] = 999;
  assert.deepEqual(await cache.get('graph1/doc1', compute, () => true), [1]);
  await cache.get('graph1/doc2', compute, () => true);
  await cache.get('graph2/doc2', compute, () => true);
  await cache.get('graph1/doc1', compute, () => true);
  assert.equal(calls, 4, 'oldest entry was evicted');
  now = 6;
  await cache.get('graph1/doc1', compute, () => true);
  assert.equal(calls, 5, 'expired provider evidence is recomputed');
  await cache.get('not-promoted', compute, () => false);
  await cache.get('not-promoted', compute, () => false);
  assert.equal(calls, 7, 'unknown results must allow a warming provider to retry');
});

test('concurrent refinements coalesce and an invalidated flight cannot seed a new generation', async () => {
  const cache = new UsageRefinementCache<number[]>((value) => [...value], (value) => value.length);
  let release!: (value: number[]) => void;
  let calls = 0;
  const compute = () => { calls++; return new Promise<number[]>((resolve) => { release = resolve; }); };
  const first = cache.get('key', compute, () => true);
  const second = cache.get('key', compute, () => true);
  assert.equal(calls, 1);
  const oldRelease = release;
  cache.clear();
  const current = cache.get('key', compute, () => true);
  assert.equal(calls, 2);
  oldRelease([1]);
  release([2]);
  assert.deepEqual(await first, [1]);
  assert.deepEqual(await second, [1]);
  assert.deepEqual(await current, [2]);
  assert.deepEqual(await cache.get('key', compute, () => true), [2]);
});
