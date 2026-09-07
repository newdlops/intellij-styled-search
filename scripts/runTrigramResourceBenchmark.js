'use strict';

// Isolated synthetic workloads: never open or rebuild the user's workspace index.
// --module accepts an earlier bundle for before/after comparisons on the same host.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { createHash } = require('crypto');

const root = path.resolve(__dirname, '..');
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const workload = option('workload');

if (!workload) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-trigram-bench-'));
  try {
    const modulePath = option('module') || path.join(temporary, 'trigram.cjs');
    if (!option('module')) {
      require('esbuild').buildSync({
        entryPoints: [path.join(root, 'src', 'trigramIndex.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        alias: { vscode: path.join(root, 'src', 'nodeVscodeShim.ts') },
        outfile: modulePath,
      });
    }
    const results = {};
    for (const name of ['extract', 'selective-query', 'query-cache', 'unchanged-update']) {
      const child = spawnSync(process.execPath, [
        '--expose-gc', __filename, `--module=${modulePath}`, `--workload=${name}`,
      ], { encoding: 'utf8' });
      if (child.status !== 0) { throw new Error(child.stderr || child.stdout); }
      results[name] = JSON.parse(child.stdout);
    }
    const report = { node: process.version, platform: process.platform, arch: process.arch, results };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (option('output')) { fs.writeFileSync(option('output'), json); }
    process.stdout.write(json);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else {
  const { TrigramIndex, extractTrigramsLower } = require(option('module'));
  const digest = (items) => createHash('sha256').update(JSON.stringify([...items].sort())).digest('hex');
  if (workload === 'extract') {
    const line = 'export function computeValue(input: string) { return input + "한글 İ Σ 😀"; }\n';
    const source = line.repeat(Math.ceil(1024 * 1024 / line.length)).slice(0, 1024 * 1024);
    for (let i = 0; i < 3; i++) { extractTrigramsLower(source); }
    global.gc();
    const start = performance.now();
    let result;
    for (let i = 0; i < 24; i++) { result = extractTrigramsLower(source); }
    process.stdout.write(JSON.stringify({
      sourceCodeUnits: source.length, iterations: 24,
      elapsedMs: performance.now() - start, maxRssKiB: process.resourceUsage().maxRSS,
      trigramCount: result.size, resultHash: digest(result),
    }));
  } else {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-postings-bench-'));
    let index;
    try {
      const fileCount = 16_384;
      const postingCount = 1024;
      const query = Array.from({ length: postingCount + 2 }, (_, i) => String.fromCharCode(0x3400 + i)).join('');
      const trigrams = [...extractTrigramsLower(query)];
      const common = Uint32Array.from({ length: fileCount }, (_, i) => i + 1);
      const data = Buffer.from(common.buffer);
      const file = path.join(directory, 'postings.bin');
      const fd = fs.openSync(file, 'w');
      try {
        for (let i = 0; i < postingCount; i++) { fs.writeSync(fd, data); }
        fs.writeSync(fd, Buffer.from(Uint32Array.of(1, 2).buffer));
      } finally { fs.closeSync(fd); }
      // Set up the same on-disk posting references produced by a v3 load.
      index = new TrigramIndex({}, { appendLine() {} });
      index.fd = fs.openSync(file, 'r');
      index.ready = true;
      for (let id = 1; id <= fileCount; id++) {
        index.fileMeta.set(id, { uri: `file:///fixture/${id}.txt`, mtime: 1, size: 1 });
      }
      trigrams.forEach((tri, i) => index.tris.set(tri, {
        kind: 'lazy', offset: i * data.length, length: fileCount,
      }));
      if (workload === 'selective-query') {
        index.tris.set(trigrams[postingCount - 2], { kind: 'lazy', offset: postingCount * data.length, length: 1 });
        index.tris.set(trigrams[postingCount - 1], { kind: 'lazy', offset: postingCount * data.length + 4, length: 1 });
      }
      global.gc();
      const before = process.memoryUsage();
      const readSync = fs.readSync;
      let diskReads = 0;
      let resultCount = 0;
      fs.readSync = function (...args) { diskReads++; return readSync.apply(this, args); };
      const start = performance.now();
      try {
        if (workload === 'selective-query') {
          resultCount = index.candidatesFor(query, { useRegex: false }).uris.size;
        } else if (workload === 'query-cache') {
          for (const tri of trigrams) {
            resultCount += index.candidatesFor(tri, { useRegex: false }).uris.size;
          }
        } else if (workload === 'unchanged-update') {
          // Re-adding an existing file ID models an unchanged trigram on save.
          for (const tri of trigrams) {
            if (index.addToPosting) { index.addToPosting(tri, 1); }
            else { index.mutablePosting(tri).add(1); }
          }
          resultCount = index.candidatesFor(query, { useRegex: false }).uris.size;
        } else { throw new Error(`Unknown workload: ${workload}`); }
      } finally { fs.readSync = readSync; }
      const elapsedMs = performance.now() - start;
      global.gc();
      const after = process.memoryUsage();
      process.stdout.write(JSON.stringify({
        fileCount, postingCount, resultCount, diskReads, elapsedMs,
        retainedHeapBytes: after.heapUsed - before.heapUsed,
        retainedArrayBufferBytes: after.arrayBuffers - before.arrayBuffers,
        maxRssKiB: process.resourceUsage().maxRSS,
      }));
    } finally {
      index?.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
