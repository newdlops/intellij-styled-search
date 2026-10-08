import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchScopeState, FILES_SCOPE_STORAGE_KEY } from '../../internal/searchScopeState';

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
