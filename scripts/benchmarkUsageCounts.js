// Controlled workload; no existing workspace/index is changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

const binary = path.resolve(process.argv[2] || path.join('resources', 'bin',
  `${process.platform}-${process.arch}`, `zoek-rs${process.platform === 'win32' ? '.exe' : ''}`));
const symbols = Number(process.argv[3] || 1000);
const perSymbol = 12;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-usage-benchmark-'));
const invoke = (...args) => JSON.parse(execFileSync(binary, args.map(String), {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
}));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const samples = (query, limit) => {
  const timings = [];
  for (let i = 0; i < 11; i++) {
    const started = performance.now();
    const result = invoke('graph-symbol-query', root, '--query', query, '--limit', limit);
    if (result.symbols.length !== limit || result.symbols.some((symbol) => symbol.usageCount !== perSymbol)) {
      throw new Error(`Benchmark expected ${limit} symbols with ${perSymbol} usages; got ${result.symbols.length} symbols.`);
    }
    if (i > 0) timings.push(performance.now() - started);
  }
  return { samplesMs: timings, p50Ms: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95) };
};

try {
  const definitions = Array.from({ length: symbols }, (_, i) =>
    'def symbol_' + String(i).padStart(6, '0') + '():\n    return 1\n');
  const calls = Array.from({ length: symbols }, (_, i) =>
    ('symbol_' + String(i).padStart(6, '0') + '()\n').repeat(perSymbol));
  // Keep every source below the engine's per-file size limit, including larger workloads.
  const perFile = 500;
  for (let start = 0; start < symbols; start += perFile) {
    fs.writeFileSync(path.join(root, `source_${start / perFile}.py`),
      definitions.slice(start, start + perFile).join('\n') + '\n' + calls.slice(start, start + perFile).join(''));
  }
  const started = performance.now();
  invoke('graph-rebuild', root, '--workers', 1);
  const buildMs = performance.now() - started;
  const pageSize = Math.min(40, symbols);
  const materialized = { single: samples('symbol_000000', 1), page: samples('symbol_', pageSize), batch: samples('symbol_', symbols) };
  const index = path.join(root, '.zoek-rs');
  const counts = fs.readdirSync(index).filter((name) => name.startsWith('callgraph-usage-counts-by-id-v1-'));
  if (counts.length !== 128) { throw new Error('The benchmark must use a complete materialized count index.'); }
  const countBytes = counts.reduce((total, name) => total + fs.statSync(path.join(index, name)).size, 0);
  for (const name of counts) fs.renameSync(path.join(index, name), path.join(index, name + '.disabled'));
  let referenceScan;
  try { referenceScan = { single: samples('symbol_000000', 1), page: samples('symbol_', pageSize), batch: samples('symbol_', symbols) }; }
  finally {
    for (const name of counts) fs.renameSync(path.join(index, name + '.disabled'), path.join(index, name));
  }
  const report = { platform: process.platform, arch: process.arch, symbols, files: Math.ceil(symbols / perFile), references: symbols * perSymbol,
    buildMs, countBytes, materialized, referenceScan,
    measurement: 'Warmed CLI queries including process startup, symbol lookup and result serialization; no source parsing during queries.' };
  const destination = path.resolve('artifacts/benchmarks/usage-counts.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
