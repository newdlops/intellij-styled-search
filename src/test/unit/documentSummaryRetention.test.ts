import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentSummaryRetentionStore } from '../../internal/documentSummaryRetention';

type Record = { symbols: Array<{ id: string }>; ordered: string[] };

test('retains exact records by owner and releases their symbol weight', () => {
  const store = new DocumentSummaryRetentionStore<Record>((record) => record.symbols.length);
  const first = { symbols: [{ id: 'a' }, { id: 'b' }], ordered: ['first', 'second'] };
  const second = { symbols: [{ id: 'c' }], ordered: ['only'] };

  store.put('file:///one', first);
  store.put('file:///two', second);
  assert.deepEqual(store.stats(), { entryCount: 2, retainedSymbolWeight: 3, inFlightLoads: 0 });
  assert.strictEqual(store.get('file:///one'), first);
  assert.deepEqual(store.get('file:///one'), first);

  store.release('file:///one');
  assert.deepEqual(store.stats(), { entryCount: 1, retainedSymbolWeight: 1, inFlightLoads: 0 });
  assert.strictEqual(store.get('file:///two'), second);
});

test('rejects a close-time completion and accepts a reopened document ticket', () => {
  const store = new DocumentSummaryRetentionStore<Record>((record) => record.symbols.length);
  const stale = store.beginLoad('file:///document');
  assert.deepEqual(store.stats(), { entryCount: 0, retainedSymbolWeight: 0, inFlightLoads: 1 });
  store.release('file:///document');
  assert.equal(store.commit(stale, { symbols: [{ id: 'stale' }], ordered: ['stale'] }), false);

  const reopened = store.beginLoad('file:///document');
  const record = { symbols: [{ id: 'new' }, { id: 'newer' }], ordered: ['new', 'newer'] };
  assert.equal(store.commit(reopened, record), true);
  assert.deepEqual(store.stats(), { entryCount: 1, retainedSymbolWeight: 2, inFlightLoads: 0 });
  assert.strictEqual(store.get('file:///document'), record);
  assert.deepEqual(store.get('file:///document'), record);
});
