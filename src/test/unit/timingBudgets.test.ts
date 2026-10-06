import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { assertTimingBudget } from '../util/timingBudgets';

test('local timing checks enforce budgets when no mode is configured', () => {
  const prior = process.env.IJSS_E2E_TIMING_MODE;
  delete process.env.IJSS_E2E_TIMING_MODE;
  try { assert.throws(() => assertTimingBudget('default policy', [12], 10)); }
  finally {
    if (prior === undefined) { delete process.env.IJSS_E2E_TIMING_MODE; }
    else { process.env.IJSS_E2E_TIMING_MODE = prior; }
  }
});

test('strict budgets reject overruns and preserve their recorded measurements', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-timings-'));
  try {
    const reportFile = path.join(directory, 'results.json');
    assert.throws(() => assertTimingBudget('operation', [2, 12, 3], 10,
      { mode: 'strict', reportFile }), /observed=12ms/);
    const [record] = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.deepEqual(record.samples, [2, 12, 3]);
    assert.equal(record.budgetMs, 10);
    assert.equal(record.exceeded, true);
    assert.equal(record.mode, 'strict');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('report mode records overruns without relaxing completion checks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-timings-'));
  try {
    const reportFile = path.join(directory, 'results.json');
    assertTimingBudget('operation', [2, 12, 3], 10, { mode: 'report', reportFile });
    const [record] = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(record.observedMs, 12);
    assert.equal(record.exceeded, true);
    for (const samples of [[], [Infinity], [NaN], [-1]]) {
      assert.throws(() => assertTimingBudget('incomplete operation', samples, 10, { mode: 'report' }));
    }
    assert.throws(() => assertTimingBudget('operation', [1], 10, { mode: 'typo' }), /unknown timing mode/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('median and exclusive budgets keep the original boundary semantics', () => {
  assertTimingBudget('median', [2, 3, 100], 3, { mode: 'strict', statistic: 'median' });
  assert.throws(() => assertTimingBudget('median', [2, 4, 100], 3,
    { mode: 'strict', statistic: 'median' }));
  assertTimingBudget('inclusive', [10], 10, { mode: 'strict' });
  assert.throws(() => assertTimingBudget('exclusive', [10], 10,
    { mode: 'strict', comparison: '<' }));
});
