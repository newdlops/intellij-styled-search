const fs = require('node:fs');
const path = require('node:path');

const outcome = process.env.IJSS_RENDERER_DIAGNOSTICS_OUTCOME || 'skipped';
const mode = process.env.IJSS_E2E_TIMING_MODE || 'strict';
const filename = path.join(__dirname, '..', 'artifacts', 'desktop-compatibility', 'renderer-timings.json');
const timings = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
const exceeded = timings.filter((item) => item.exceeded);
let summary = `### Renderer acceptance\n\nSuite result: **${outcome}**. Hardware timing mode: **${mode}**.\n\n`;
summary += mode === 'report'
  ? 'All functional assertions and completion checks are required. Shared-runner timing budget overruns are reported below and preserved in the desktop artifact; they do not fail this job.\n\n'
  : 'All functional assertions and the original hardware timing budgets are required. Any failure fails this job.\n\n';
summary += `Measured budgets: **${timings.length}**. Budgets exceeded: **${exceeded.length}**.\n\n`;
if (timings.length) {
  summary += '| Measurement | Statistic | Observed | Original budget | Result |\n| --- | --- | --- | --- | --- |\n';
  for (const item of timings) {
    summary += `| ${item.label} | ${item.statistic} | ${item.observedMs} ms | ${item.comparison} ${item.budgetMs} ms | ${item.exceeded ? '**Exceeded**' : 'Within budget'} |\n`;
  }
} else {
  summary += 'No timing samples were collected. Check the suite result and desktop logs.\n';
}
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(`Renderer summary: outcome=${outcome} mode=${mode} measurements=${timings.length} exceeded=${exceeded.length}`);
