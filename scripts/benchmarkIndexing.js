// Reproducible full/incremental workload in an isolated temporary workspace.
// Run against each binary with the same --files/--runs; timings include CLI
// startup but exclude fixture creation and correctness queries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const repoRoot = path.resolve(__dirname, '..');
const options = {
  binary: path.join(repoRoot, 'resources', 'bin', `${process.platform}-${process.arch}`,
    `zoek-rs${process.platform === 'win32' ? '.exe' : ''}`),
  files: 4000,
  runs: 3,
  output: path.join(repoRoot, 'artifacts', 'benchmarks', 'indexing.json'),
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!Object.hasOwn(options, key) || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node scripts/benchmarkIndexing.js [--binary PATH] [--files N] [--runs N] [--output PATH]');
  }
  options[key] = typeof options[key] === 'number' ? Number(process.argv[i + 1]) : path.resolve(process.argv[i + 1]);
}
assert.ok(Number.isInteger(options.files) && options.files >= 128 && options.files % 2 === 0, '--files must be an even integer >= 128');
assert.ok(Number.isInteger(options.runs) && options.runs > 0, '--runs must be a positive integer');

const pairs = options.files / 2;
const measurements = {};
const diagnostics = [];
let checks = 0;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

function definition(i) {
  return `def evaluate_${i}():\n    return ${i}\n`;
}
function consumer(i, calls) {
  return `from unit_${i} import evaluate_${i}\n\ndef run_${i}():\n` +
    `    evaluate_${i}()\n`.repeat(calls) + `    return "index_marker_${i}_${calls}"\n`;
}

for (let run = 0; run < options.runs; run++) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-indexing-benchmark-'));
  const invoke = (label, ...args) => {
    const start = performance.now();
    const result = spawnSync(options.binary, args.map(String), {
      encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    const elapsed = performance.now() - start;
    if (result.error) { throw result.error; }
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true, JSON.stringify(response));
    if (label) {
      (measurements[label] ||= []).push(elapsed);
      if (args[0] === 'graph-rebuild') { diagnostics.push({ run, stderr: result.stderr }); }
    }
    return response;
  };
  const verify = (i, calls, relPath = `use_${i}.py`) => {
    const symbols = invoke(null, 'graph-symbol-query', root, '--query', `evaluate_${i}`, '--limit', 100).symbols;
    const target = symbols.find((symbol) => symbol.name === `evaluate_${i}` && symbol.relPath === `unit_${i}.py`);
    assert.ok(target, `missing definition ${i}`);
    // The import binding itself is also a usage of the exported definition.
    assert.equal(target.usageCount, calls ? calls + 1 : 0, `usage count for ${i}`);
    const query = invoke(null, 'search', root, `index_marker_${i}_${calls || 2}`, '--limit', 100);
    assert.deepEqual([...new Set(query.files.map((item) => item.relPath))], calls ? [relPath] : [], `text results for ${i}`);
    checks += 2;
  };
  const update = (label, changed, deleted = []) => {
    const deleteArgs = deleted.flatMap((item) => ['--delete', item]);
    invoke(`${label}.text`, 'update', root, ...changed, ...deleteArgs);
    invoke(`${label}.graph`, 'graph-overlay-update', root, '--workers', 8, ...changed, ...deleteArgs);
  };
  try {
    for (let i = 0; i < pairs; i++) {
      fs.writeFileSync(path.join(root, `unit_${i}.py`), definition(i));
      fs.writeFileSync(path.join(root, `use_${i}.py`), consumer(i, 1));
    }
    invoke('full.text', 'index', root, '--force');
    invoke('reuse.text', 'index', root);
    invoke('full.graph', 'graph-rebuild', root, '--workers', 8);
    verify(0, 1);
    fs.writeFileSync(path.join(root, 'use_0.py'), consumer(0, 2));
    update('single', ['use_0.py']);
    verify(0, 2);
    const changed = Array.from({ length: 63 }, (_, j) => `use_${j + 1}.py`);
    for (let i = 1; i <= 63; i++) { fs.writeFileSync(path.join(root, `use_${i}.py`), consumer(i, 2)); }
    update('burst63', changed);
    verify(1, 2);
    verify(63, 2);
    update('duplicate63', changed);
    verify(63, 2);
    fs.renameSync(path.join(root, 'use_0.py'), path.join(root, 'renamed_0.py'));
    update('rename', ['renamed_0.py'], ['use_0.py']);
    verify(0, 2, 'renamed_0.py');
    fs.unlinkSync(path.join(root, 'renamed_0.py'));
    update('delete', [], ['renamed_0.py']);
    verify(0, 0);
    fs.writeFileSync(path.join(root, 'renamed_0.py'), consumer(0, 2));
    update('recreate', ['renamed_0.py']);
    verify(0, 2, 'renamed_0.py');
    invoke('compact.text', 'compact', root);
    invoke('compact.graph', 'graph-compact', root, '--workers', 8);
    verify(0, 2, 'renamed_0.py');
    verify(63, 2);
    process.stderr.write(`indexing benchmark: run ${run + 1}/${options.runs} passed\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const report = {
  measuredAt: new Date().toISOString(),
  startedWithBinary: options.binary,
  binarySha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(options.binary)).digest('hex'),
  platform: process.platform, arch: process.arch, files: options.files, runs: options.runs,
  host: { cpuModel: os.cpus()[0]?.model, cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
  checks,
  measurement: 'Warm filesystem; CLI startup included, fixture writes and correctness queries excluded. Synthetic Python import/call pairs. No existing workspace is changed.',
  timings: Object.fromEntries(Object.entries(measurements).map(([name, values]) => [name, {
    samplesMs: values, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
  }])),
  diagnostics,
};
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: options.output, checks, timings: report.timings }, null, 2));
