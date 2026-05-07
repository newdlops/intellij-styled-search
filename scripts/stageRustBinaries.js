#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const platformId = `${process.platform}-${process.arch}`;
const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const sourceDir = path.join(root, 'target', 'release');
const outDir = path.join(root, 'resources', 'bin', platformId);
const binaries = ['zoek-rs', 'ijss-rebuild'];

fs.mkdirSync(outDir, { recursive: true });

for (const binary of binaries) {
  const fileName = `${binary}${exeSuffix}`;
  const source = path.join(sourceDir, fileName);
  const target = path.join(outDir, fileName);
  if (!fs.existsSync(source)) {
    throw new Error(
      `missing ${source}; run "cargo build --release -p zoek-rs" before staging Rust binaries`,
    );
  }
  fs.copyFileSync(source, target);
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
  }
  const stat = fs.statSync(target);
  console.log(`[stageRustBinaries] staged ${path.relative(root, target)} (${stat.size} bytes)`);
}
