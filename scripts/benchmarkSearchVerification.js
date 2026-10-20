'use strict';

// Isolated end-to-end workloads for query compilation, match positions and
// previews. Compare binaries built with the same Cargo profile on the same host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const repo = path.resolve(__dirname, '..');
const options = {
  before: '',
  after: path.join(repo, 'resources', 'bin', `${process.platform}-${process.arch}`,
    `zoek-rs${process.platform === 'win32' ? '.exe' : ''}`),
  runs: 3,
  output: path.join(repo, 'artifacts', 'benchmarks', 'search-verification.json'),
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  assert.ok(Object.hasOwn(options, key) && process.argv[i + 1] !== undefined,
    'Usage: node scripts/benchmarkSearchVerification.js [--before PATH] [--after PATH] [--runs N] [--output PATH]');
  options[key] = key === 'runs' ? Number(process.argv[i + 1]) : path.resolve(process.argv[i + 1]);
}
assert.ok(Number.isInteger(options.runs) && options.runs > 0, '--runs must be a positive integer');

const binaries = Object.entries({ before: options.before, after: options.after }).filter(([, binary]) => binary);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-search-verification-'));
const measurements = {};
const resultHashes = {};
const denseMatches = 8192;
const workloads = [
  { name: 'serial-literal', scope: 'serial/**', query: 'sharedValue', count: 96 },
  { name: 'parallel-literal', scope: 'parallel/**', query: 'SHAREDVALUE', flags: ['--whole-word'], count: 512 },
  { name: 'parallel-regex', scope: 'parallel/**', query: '\\bshared(?:Value|Token)\\b', flags: ['--regex'], count: 512 },
  { name: 'stream-regex', scope: 'parallel/**', query: '\\bshared(?:Value|Token)\\b', flags: ['--regex', '--stream'], count: 512, streamFiles: 512 },
  { name: 'parallel-include-exclude', scope: 'parallel/**', query: '\\bshared(?:Value|Token)\\b',
    flags: ['--regex', '--exclude', 'parallel/unit-[0-9].txt', '--exclude', 'parallel/unit-1??.txt'], count: 402 },
  { name: 'stream-include-exclude', scope: 'parallel/**', query: 'sharedValue',
    flags: ['--stream', '--exclude', 'parallel/unit-[0-9].txt', '--exclude', 'parallel/unit-1??.txt'], count: 402, streamFiles: 402 },
  { name: 'all-paths-excluded', scope: 'parallel/**', query: 'sharedValue', flags: ['--exclude', '**'], count: 0 },
  { name: 'invalid-path-glob', scope: '[z-a]', query: 'sharedValue', count: 0 },
  { name: 'dense-literal', scope: 'dense.txt', query: 'sharedValue', count: denseMatches },
  { name: 'dense-singleline-regex', scope: 'dense.txt', query: '^한글😀 sharedValue$', flags: ['--regex', '--regex-singleline'], count: denseMatches },
  { name: 'dense-multiline-literal', scope: 'dense.txt', query: 'sharedValue\n한글😀', count: denseMatches - 1 },
  { name: 'long-line-literal', scope: 'long-line.txt', query: 'sharedValue', count: denseMatches },
  { name: 'late-literal', scope: 'late.txt', query: 'sharedValue', count: 1 },
  { name: 'no-match-regex', scope: 'late.txt', query: 'z{2,4}', flags: ['--regex'], count: 0 },
];

function invoke(binary, args, timed = false) {
  // macOS reports peak RSS in bytes. Keep unsupported platforms explicit instead
  // of substituting the parent Node process's memory usage for the child's.
  const measureResources = timed && process.platform === 'darwin';
  const start = performance.now();
  const child = spawnSync(measureResources ? '/usr/bin/time' : binary,
    measureResources ? ['-l', '-p', binary, ...args] : args,
    { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const elapsedMs = performance.now() - start;
  if (child.error) { throw child.error; }
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const lines = child.stdout.trim().split('\n');
  const response = JSON.parse(lines.pop());
  assert.equal(response.ok, true, JSON.stringify(response));
  const events = [...lines, ...child.stderr.split('\n').filter((line) => line.startsWith('__ZOEK_SEARCH__'))].map((line) => {
    assert.ok(line.startsWith('__ZOEK_SEARCH__'));
    return JSON.parse(line.slice('__ZOEK_SEARCH__'.length));
  });
  const resourceNumber = (regex) => Number(child.stderr.match(regex)?.[1] ?? NaN);
  const userCpuSeconds = measureResources ? resourceNumber(/^user\s+([\d.]+)/m) : null;
  const systemCpuSeconds = measureResources ? resourceNumber(/^sys\s+([\d.]+)/m) : null;
  const peakRssBytes = measureResources ? resourceNumber(/(\d+)\s+maximum resident set size/) : null;
  const commandElapsedMs = measureResources ? resourceNumber(/^real\s+([\d.]+)/m) * 1000 : null;
  if (measureResources) {
    assert.ok([userCpuSeconds, systemCpuSeconds, peakRssBytes, commandElapsedMs].every(Number.isFinite), child.stderr);
  }
  return {
    response, events,
    sample: {
      elapsedMs,
      commandElapsedMs, userCpuSeconds, systemCpuSeconds, peakRssBytes,
    },
  };
}

try {
  for (const [directory, count] of [['serial', 96], ['parallel', 512]]) {
    fs.mkdirSync(path.join(temporary, directory));
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(path.join(temporary, directory, `unit-${i}.txt`), `한글😀 sharedValue ${i}\n`);
    }
  }
  fs.writeFileSync(path.join(temporary, 'dense.txt'), '한글😀 sharedValue\r\n'.repeat(denseMatches));
  fs.writeFileSync(path.join(temporary, 'long-line.txt'), '한글😀 sharedValue '.repeat(denseMatches));
  fs.writeFileSync(path.join(temporary, 'late.txt'), 'padding line\r\n'.repeat(65_536) + '한글😀 sharedValue');
  invoke(binaries[0][1], ['index', temporary, '--force']);

  for (const workload of workloads) {
    const args = ['search', temporary, workload.query, '--include', workload.scope,
      '--limit', String(denseMatches * 2), ...(workload.flags || [])];
    const expected = invoke(binaries[0][1], args);
    assert.equal(expected.response.totalMatches, workload.count, workload.name);
    assert.equal(expected.response.warnings.length, 0, workload.name);
    assert.equal(expected.events.length, workload.streamFiles || 0, workload.name);
    const expectedResult = { response: expected.response, events: expected.events };
    resultHashes[workload.name] = createHash('sha256').update(JSON.stringify(expectedResult)).digest('hex');
    measurements[workload.name] = {};
    for (const [label, binary] of binaries) {
      measurements[workload.name][label] = [];
      const warm = invoke(binary, args);
      assert.deepEqual({ response: warm.response, events: warm.events }, expectedResult, `${workload.name}: ${label} warmup`);
    }
    for (let run = 0; run < options.runs; run++) {
      // Alternate the order to reduce bias from filesystem warming or host drift.
      for (const [label, binary] of run % 2 ? [...binaries].reverse() : binaries) {
        const result = invoke(binary, args, true);
        assert.deepEqual({ response: result.response, events: result.events }, expectedResult, `${workload.name}: ${label} run ${run}`);
        measurements[workload.name][label].push(result.sample);
      }
    }
    process.stderr.write(`search verification benchmark: ${workload.name} passed\n`);
  }

  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(Object.entries(measurements).map(([name, variants]) => [name,
    Object.fromEntries(Object.entries(variants).map(([label, samples]) => [label, {
      medianElapsedMs: median(samples.map((sample) => sample.elapsedMs)),
      medianCommandElapsedMs: process.platform === 'darwin' ? median(samples.map((sample) => sample.commandElapsedMs)) : null,
      medianUserCpuSeconds: process.platform === 'darwin' ? median(samples.map((sample) => sample.userCpuSeconds)) : null,
      medianPeakRssBytes: process.platform === 'darwin' ? median(samples.map((sample) => sample.peakRssBytes)) : null,
    }])),
  ]));
  const report = {
    measuredAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, node: process.version },
    measurement: 'Warm filesystem, isolated synthetic fixtures; CLI startup, file loading, verification and JSON serialization included. Identical full responses and stream events required. elapsedMs includes starting /usr/bin/time on macOS; commandElapsedMs excludes that wrapper startup and has 10 ms precision, as does CPU time. Other platforms report elapsedMs only.',
    binaries: Object.fromEntries(binaries.map(([label, binary]) => [label, {
      path: binary, sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    }])),
    workloads, resultHashes, samples: measurements, summary,
  };
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: options.output, summary }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
