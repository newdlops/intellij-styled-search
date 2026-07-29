import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncWeightedLruCache } from '../../internal/asyncWeightedLruCache';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('bounds resident entries and weight while preserving requested values and LRU touch order', async () => {
  const cache = new AsyncWeightedLruCache<string, { ordered: string[]; weight: number }>({
    maxEntries: 2,
    maxWeight: 3,
    weight: (value) => value.weight,
  });
  const first = { ordered: ['first'], weight: 1 };
  const second = { ordered: ['second'], weight: 1 };
  const third = { ordered: ['third'], weight: 2 };
  assert.strictEqual(await cache.getOrLoad('first', async () => first), first);
  assert.strictEqual(await cache.getOrLoad('second', async () => second), second);
  assert.strictEqual(cache.get('first'), first);
  assert.strictEqual(await cache.getOrLoad('third', async () => third), third);
  assert.equal(cache.get('second'), undefined);
  assert.strictEqual(cache.get('first'), first);
  assert.strictEqual(cache.get('third'), third);
  assert.deepEqual(cache.stats(), { entryCount: 2, retainedWeight: 3, inFlightLoads: 0 });

  const entryLimited = new AsyncWeightedLruCache<string, { weight: number }>({
    maxEntries: 2,
    maxWeight: 10,
    weight: (value) => value.weight,
  });
  await entryLimited.getOrLoad('one', async () => ({ weight: 1 }));
  await entryLimited.getOrLoad('two', async () => ({ weight: 1 }));
  await entryLimited.getOrLoad('three', async () => ({ weight: 1 }));
  assert.equal(entryLimited.get('one'), undefined);
  assert.deepEqual(entryLimited.stats(), { entryCount: 2, retainedWeight: 2, inFlightLoads: 0 });
});

test('delivers oversized values without retaining them', async () => {
  const cache = new AsyncWeightedLruCache<string, { ordered: string[] }>({
    maxEntries: 2,
    maxWeight: 2,
    weight: (value) => value.ordered.length,
  });
  const oversized = { ordered: ['first', 'second', 'third'] };
  assert.strictEqual(await cache.getOrLoad('oversized', async () => oversized), oversized);
  assert.deepEqual((await cache.getOrLoad('oversized', async () => oversized)).ordered, ['first', 'second', 'third']);
  assert.equal(cache.get('oversized'), undefined);
  assert.deepEqual(cache.stats(), { entryCount: 0, retainedWeight: 0, inFlightLoads: 0 });
});

test('coalesces loads, removes rejected flights, and invalidates stale completions after clear', async () => {
  const cache = new AsyncWeightedLruCache<string, { value: string; weight: number }>({
    maxEntries: 2,
    maxWeight: 2,
    weight: (value) => value.weight,
  });
  const shared = deferred<{ value: string; weight: number }>();
  let loadCount = 0;
  const load = async () => { loadCount += 1; return shared.promise; };
  const first = cache.getOrLoad('shared', load);
  const second = cache.getOrLoad('shared', load);
  shared.resolve({ value: 'shared', weight: 1 });
  assert.equal((await first).value, 'shared');
  assert.equal((await second).value, 'shared');
  assert.equal(loadCount, 1);

  await assert.rejects(cache.getOrLoad('failure', async () => { throw new Error('expected'); }));
  assert.deepEqual(cache.stats(), { entryCount: 1, retainedWeight: 1, inFlightLoads: 0 });

  const stale = deferred<{ value: string; weight: number }>();
  const staleRequest = cache.getOrLoad('stale', async () => stale.promise);
  cache.clear();
  const current = { value: 'current', weight: 1 };
  assert.strictEqual(await cache.getOrLoad('stale', async () => current), current);
  stale.resolve({ value: 'stale', weight: 1 });
  assert.equal((await staleRequest).value, 'stale');
  assert.strictEqual(cache.get('stale'), current);
  assert.deepEqual(cache.stats(), { entryCount: 1, retainedWeight: 1, inFlightLoads: 0 });
});
