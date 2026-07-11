#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) { return undefined; }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hostPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function rustSourceFingerprint() {
  const inputs = [];
  const addFile = (filePath) => {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      inputs.push(filePath);
    }
  };
  const walk = (dirPath) => {
    if (!fs.existsSync(dirPath)) { return; }
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) { walk(entryPath); }
      else if (entry.isFile() && (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml')) {
        addFile(entryPath);
      }
    }
  };
  addFile(path.join(root, 'Cargo.lock'));
  addFile(path.join(root, 'Cargo.toml'));
  walk(path.join(root, 'crates', 'zoek-rs'));
  const hash = crypto.createHash('sha256');
  for (const input of inputs.sort()) {
    hash.update(path.relative(root, input).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(input));
    hash.update('\0');
  }
  if (inputs.length === 0) {
    throw new Error('cannot package zoek-rs without Rust source inputs');
  }
  return hash.digest('hex').slice(0, 24);
}

function binaryPairArtifactId(files) {
  const hash = crypto.createHash('sha256');
  for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
    hash.update(baseName);
    hash.update('\0');
    hash.update(files[baseName] || '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function cargoBinaryArtifacts(stdout) {
  const artifacts = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) { continue; }
    try {
      const message = JSON.parse(line);
      const name = message?.target?.name;
      if (message?.reason === 'compiler-artifact' &&
          typeof message.executable === 'string' &&
          Array.isArray(message?.target?.kind) &&
          message.target.kind.includes('bin') &&
          (name === 'zoek-rs' || name === 'ijss-rebuild')) {
        artifacts[name] = message.executable;
      }
    } catch {}
  }
  return artifacts;
}

const rustTargetsByPlatform = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-armhf': 'armv7-unknown-linux-gnueabihf',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'alpine-arm64': 'aarch64-unknown-linux-musl',
  'alpine-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-ia32': 'i686-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const platformKey = option('--platform-key') || hostPlatformKey();
const rustTarget = option('--rust-target');
if (!Object.prototype.hasOwnProperty.call(rustTargetsByPlatform, platformKey)) {
  throw new Error(`unsupported or unsafe --platform-key: ${platformKey}`);
}
if (rustTarget && !args.includes('--platform-key')) {
  throw new Error('--rust-target requires an explicit --platform-key');
}
if (!rustTarget && platformKey !== hostPlatformKey()) {
  throw new Error('a non-host --platform-key requires --rust-target');
}
if (rustTarget && rustTargetsByPlatform[platformKey] !== rustTarget) {
  throw new Error(
    `--rust-target ${rustTarget} does not match ${platformKey} (${rustTargetsByPlatform[platformKey]})`,
  );
}

const cargoArgs = [
  'build',
  '--quiet',
  '--release',
  '-p',
  'zoek-rs',
  '--bins',
  '--message-format=json-render-diagnostics',
];
if (rustTarget) {
  cargoArgs.push('--target', rustTarget);
}
const sourceFingerprint = rustSourceFingerprint();
const build = spawnSync('cargo', cargoArgs, {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
});
if (build.error) { throw build.error; }
if (build.status !== 0) {
  throw new Error(`cargo ${cargoArgs.join(' ')} failed with code ${build.status}`);
}
if (rustSourceFingerprint() !== sourceFingerprint) {
  throw new Error('Rust sources changed while building; rerun build:zoek-runtime');
}

const targetRoot = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, 'target');
const releaseDir = rustTarget
  ? path.join(targetRoot, rustTarget, 'release')
  : path.join(targetRoot, 'release');
const destinationDir = path.join(root, 'resources', 'bin', platformKey);
const exeSuffix = platformKey.startsWith('win32-') ? '.exe' : '';
fs.mkdirSync(destinationDir, { recursive: true });

const files = {};
const artifacts = cargoBinaryArtifacts(build.stdout);
for (const baseName of ['zoek-rs', 'ijss-rebuild']) {
  const source = artifacts[baseName] || path.join(releaseDir, `${baseName}${exeSuffix}`);
  if (!fs.existsSync(source)) {
    throw new Error(`missing Cargo output: ${source}`);
  }
  const destination = path.join(destinationDir, `${baseName}${exeSuffix}`);
  fs.copyFileSync(source, destination);
  if (process.platform !== 'win32') {
    fs.chmodSync(destination, 0o755);
  }
  files[baseName] = sha256(destination);
}

const manifest = {
  formatVersion: 2,
  platformKey,
  rustTarget: rustTarget || null,
  protocolVersion: 1,
  schemaVersion: 20,
  sourceFingerprint,
  artifactId: binaryPairArtifactId(files),
  files,
};
fs.writeFileSync(
  path.join(destinationDir, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

process.stdout.write(`zoek-rs runtime packaged at ${destinationDir}\n`);
