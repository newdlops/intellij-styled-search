import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchScopeState, SearchScopeHistoryState, FILES_SCOPE_STORAGE_KEY, FILES_SCOPE_HISTORY_KEY } from '../../internal/searchScopeState';

test('scope writes retain editing order while an earlier save is pending', async () => {
  const writes: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = new SearchScopeState({ get: () => undefined, update: async (key, value) => {
    assert.equal(key, FILES_SCOPE_STORAGE_KEY);
    writes.push(value);
    if (writes.length === 1) { await pending; }
  } }, () => '**/*.js');
  const first = state.save('**/*.ts');
  await new Promise(resolve => setImmediate(resolve));
  const last = state.save('');
  assert.equal(state.initialValue(), '');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['**/*.ts']);
  release();
  await Promise.all([first, last, state.whenSaved()]);
  assert.deepEqual(writes, ['**/*.ts', '']);
});

test('a failed scope save does not discard a subsequent edit', async () => {
  let calls = 0;
  let saved: string | undefined;
  const state = new SearchScopeState({ get: () => undefined, update: async (_key, value) => {
    if (++calls === 1) { throw new Error('storage unavailable'); }
    saved = value;
  } }, () => '');
  await assert.rejects(state.save('**/*.vue'), /storage unavailable/);
  await state.save('**/*.ts');
  assert.equal(saved, '**/*.ts');
});

test('Ant history preserves complete include/exclude expressions across workspace restarts', async () => {
  const values = new Map<string, unknown>([[FILES_SCOPE_HISTORY_KEY, ['**/*.py', '', 42, '**/*.py']]]);
  const storage = { get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: string[]) => { values.set(key, value); } };
  const state = new SearchScopeHistoryState(storage);
  const expression = 'src/**, **/*.{ts,tsx}, !**/*.test.ts';
  await state.record(expression, 3);
  await state.record('**/*.py', 3);
  assert.deepEqual(new SearchScopeHistoryState(storage).read(3), ['**/*.py', expression]);
  const otherWorkspace = new SearchScopeHistoryState({ get: () => undefined, update: async () => {} });
  assert.deepEqual(otherWorkspace.read(100), []);
  await state.trim(0);
  assert.deepEqual(new SearchScopeHistoryState(storage).read(100), []);
});

test('pending Ant history writes retain the newest expression, deduplication and limit', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const writes: string[][] = [];
  const state = new SearchScopeHistoryState({ get: () => undefined, update: async (_key, value) => {
    writes.push(value); if (writes.length === 1) { await pending; }
  } });
  const first = state.record('src/**', 2);
  await new Promise(resolve => setImmediate(resolve));
  const second = state.record('**/*.ts', 2);
  const third = state.record('src/**', 2);
  assert.deepEqual(state.read(2), ['src/**', '**/*.ts']);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(writes, [['src/**'], ['**/*.ts', 'src/**'], ['src/**', '**/*.ts']]);
});

test('disabled and blank Ant scopes do not record; a failed write can recover', async () => {
  let calls = 0;
  let saved: string[] = [];
  const state = new SearchScopeHistoryState({ get: () => undefined, update: async (_key, value) => {
    if (++calls === 1) { throw new Error('storage unavailable'); } saved = value;
  } });
  await state.record('src/**', 0);
  await state.record('  ', 100);
  assert.equal(calls, 0);
  await assert.rejects(state.record('src/**', 100), /storage unavailable/);
  await state.record('**/*.js', 1);
  assert.deepEqual(saved, ['**/*.js']);
});
