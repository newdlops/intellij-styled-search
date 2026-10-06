// Run after builds/tests finish. Alternate binaries to reduce host-load/order bias.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const binaries = process.argv.slice(2).map((file) => path.resolve(file));
if (binaries.length !== 2) throw new Error('Supply BEFORE and AFTER binaries.');
const roots = binaries.map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-usage-paired-')));
const count = 10000, perSymbol = 12;
const invoke = (side, ...args) => JSON.parse(execFileSync(binaries[side], args.map(String), {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, windowsHide: true,
}));
const median = (samples) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.5) - 1];
try {
  for (let side = 0; side < 2; side++) {
    for (let start = 0; start < count; start += 500) {
      const names = Array.from({length: 500}, (_, index) => `symbol_${String(start + index).padStart(6, '0')}`);
      fs.writeFileSync(path.join(roots[side], `source_${start / 500}.py`),
        names.map((name) => `def ${name}():\n    return 1\n`).join('\n') + '\n' +
        names.map((name) => `${name}()\n`.repeat(perSymbol)).join(''));
    }
    invoke(side, 'graph-rebuild', roots[side], '--workers', 1);
  }
  const measurements = {};
  for (const [label, query, limit] of [['single', 'symbol_000000', 1], ['page', 'symbol_', 40], ['batch', 'symbol_', count]]) {
    const timings = [[], []];
    for (let iteration = 0; iteration < 21; iteration++) {
      for (const side of iteration % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        const result = invoke(side, 'graph-symbol-query', roots[side], '--query', query, '--limit', limit);
        const elapsed = performance.now() - start;
        if (result.totalSymbols !== (limit === 1 ? 1 : count) || result.symbols.length !== limit ||
            result.symbols.some((symbol) => symbol.usageCount !== perSymbol)) {
          throw new Error('Independent symbol/count expectations failed.');
        }
        if (iteration) timings[side].push(elapsed);
      }
    }
    const before = median(timings[0]), after = median(timings[1]);
    measurements[label] = {beforeP50Ms: before, afterP50Ms: after,
      reductionPercent: 100 * (1 - after / before), samplesMs: {before: timings[0], after: timings[1]}};
  }
  const report = {platform: process.platform, arch: process.arch, symbols: count, references: count * perSymbol,
    binaries: binaries.map((binary) => ({path: binary, sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')})),
    measurement: 'Alternating warmed CLI queries; 20 samples per binary/workload, including process startup, lookup and JSON serialization.',
    measurements};
  const outputDirectory = path.resolve(__dirname, '..', 'artifacts', 'benchmarks');
  fs.mkdirSync(outputDirectory, {recursive: true});
  fs.writeFileSync(path.join(outputDirectory, 'usage-query-paired-comparison.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(measurements).map(([key, value]) =>
    [key, {beforeP50Ms: +value.beforeP50Ms.toFixed(2), afterP50Ms: +value.afterP50Ms.toFixed(2), reductionPercent: +value.reductionPercent.toFixed(1)}])), null, 2));
} finally { for (const root of roots) fs.rmSync(root, {recursive: true, force: true}); }
