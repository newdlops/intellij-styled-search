import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TimingBudgetOptions {
  mode?: string;
  statistic?: 'max' | 'median';
  comparison?: '<=' | '<';
  reportFile?: string;
}

export function assertTimingBudget(
  label: string,
  samples: number[],
  budgetMs: number,
  options: TimingBudgetOptions = {},
): void {
  const mode = options.mode ?? process.env.IJSS_E2E_TIMING_MODE ?? 'strict';
  assert.ok(mode === 'strict' || mode === 'report', `unknown timing mode: ${mode}`);
  assert.ok(samples.length > 0, `${label} should record timings`);
  assert.ok(samples.every((value) => Number.isFinite(value) && value >= 0),
    `${label} must complete every measured operation; samples=${samples.join(',')}`);
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, 'expected a positive timing budget');
  const sorted = [...samples].sort((a, b) => a - b);
  const maxMs = sorted[sorted.length - 1]!;
  const medianMs = sorted[Math.floor(sorted.length / 2)]!;
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  const statistic = options.statistic ?? 'max';
  const comparison = options.comparison ?? '<=';
  const observedMs = statistic === 'median' ? medianMs : maxMs;
  const exceeded = comparison === '<' ? observedMs >= budgetMs : observedMs > budgetMs;
  const result = { label, samples, budgetMs, statistic, comparison,
    observedMs, maxMs, medianMs, p95Ms, exceeded, mode };
  const reportFile = options.reportFile ?? process.env.IJSS_E2E_TIMING_JSON;
  if (reportFile) {
    const filename = path.resolve(__dirname, '../../..', reportFile);
    const results = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    assert.ok(Array.isArray(results), 'expected an array of timing measurements');
    results.push(result);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(results, null, 2) + '\n');
  }
  if (process.env.IJSS_E2E_TIMING_REPORT === '1' || mode === 'report') {
    console.info(`[timings] ${label}: samples=${samples.join(',')}ms max=${maxMs}ms p95=${p95Ms}ms ` +
      `observed(${statistic})=${observedMs}ms budget=${comparison}${budgetMs}ms mode=${mode} ` +
      `result=${exceeded ? 'budget-exceeded' : 'within-budget'}`);
  }
  if (mode === 'strict') {
    assert.ok(!exceeded, `${label} ${statistic} should stay ${comparison} ${budgetMs}ms; ` +
      `samples=${samples.join(',')}ms observed=${observedMs}ms`);
  }
}
