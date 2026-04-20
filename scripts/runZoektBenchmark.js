const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const cargoArgs = [];
  let outDir = path.join(repoRoot, 'artifacts', 'benchmarks', 'zoekt');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--out-dir requires a value');
      }
      outDir = path.resolve(repoRoot, value);
      i += 1;
      continue;
    }
    cargoArgs.push(arg);
  }

  return { cargoArgs, outDir };
}

function safeExec(file, args) {
  try {
    return execFileSync(file, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function saveArtifact(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:]/g, '-');
  const artifactPath = path.join(outDir, `${stamp}.json`);
  const latestPath = path.join(outDir, 'latest.json');
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(artifactPath, encoded, 'utf8');
  fs.writeFileSync(latestPath, encoded, 'utf8');
  return { artifactPath, latestPath };
}

function formatCaseSummary(item) {
  return [
    `${item.label}:`,
    `files=${item.fileCount}`,
    `index=${item.indexMs}ms`,
    `update p50/p95=${item.updateP50Ms.toFixed(2)}/${item.updateP95Ms.toFixed(2)}ms`,
    `query p50/p95=${item.queryP50Ms.toFixed(2)}/${item.queryP95Ms.toFixed(2)}ms`,
  ].join(' ');
}

function main() {
  const { cargoArgs, outDir } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const command = ['run', '-q', '-p', 'zoek-rs', '--', 'benchmark', ...cargoArgs];
  const wallStart = process.hrtime.bigint();
  const run = spawnSync('cargo', command, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1_000_000;

  if (run.status !== 0) {
    const stderr = run.stderr ? `\n${run.stderr.trim()}` : '';
    const stdout = run.stdout ? `\n${run.stdout.trim()}` : '';
    throw new Error(`zoek-rs benchmark failed with exit code ${run.status}.${stderr}${stdout}`);
  }

  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(
      `failed to parse zoek-rs benchmark output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const report = {
    startedAt,
    wallMs,
    command: ['cargo', ...command],
    gitCommit: safeExec('git', ['rev-parse', 'HEAD']),
    gitBranch: safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    cargoVersion: safeExec('cargo', ['--version']),
    rustcVersion: safeExec('rustc', ['--version']),
    nodeVersion: process.version,
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      hostname: os.hostname(),
    },
    response,
  };

  const { artifactPath, latestPath } = saveArtifact(outDir, report);
  console.log(`[bench:zoekt] artifact ${path.relative(repoRoot, artifactPath)}`);
  console.log(`[bench:zoekt] latest   ${path.relative(repoRoot, latestPath)}`);
  for (const item of response.cases ?? []) {
    console.log(`[bench:zoekt] ${formatCaseSummary(item)}`);
  }
  if (Array.isArray(response.warnings) && response.warnings.length > 0) {
    for (const warning of response.warnings) {
      console.log(`[bench:zoekt] warning: ${warning}`);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`[bench:zoekt] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
