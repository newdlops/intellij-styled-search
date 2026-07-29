const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');
const cacheDirectory = path.join(nodeModules, '.cache', 'intellij-styled-search');
const schema = 2;

function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
function absolute(file) { return path.resolve(root, file); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function inside(file, directory) { return file === directory || file.startsWith(`${directory}${path.sep}`); }

function context() {
  const rootLock = path.join(root, 'package-lock.json');
  const installedLock = path.join(nodeModules, '.package-lock.json');
  try {
    return {
      rootLockHash: hash(rootLock), installedLockHash: hash(installedLock),
      rootPackages: JSON.parse(fs.readFileSync(rootLock, 'utf8')).packages,
      installedPackages: JSON.parse(fs.readFileSync(installedLock, 'utf8')).packages,
      identities: new Map(),
    };
  } catch { return null; }
}

function packageRoot(file) {
  const normalized = path.resolve(file);
  if (!inside(normalized, nodeModules)) return null;
  let current = path.dirname(normalized);
  while (inside(current, nodeModules)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (current === nodeModules) break;
    current = path.dirname(current);
  }
  return null;
}

function hasSymlink(start, end) {
  let current = start;
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) return true;
    if (current === end) return false;
    current = path.dirname(current);
  }
}

function registryIdentity(file, state) {
  if (!state) return null;
  try {
    if (!inside(fs.realpathSync(file), fs.realpathSync(nodeModules))) return null;
    const directory = packageRoot(file);
    if (!directory || hasSymlink(directory, nodeModules)) return null;
    const key = relative(directory);
    if (state.identities.has(key)) return state.identities.get(key);
    const rootEntry = state.rootPackages[key];
    const installedEntry = state.installedPackages[key];
    const metadataFile = path.join(directory, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (!rootEntry || !installedEntry || !rootEntry.integrity || !rootEntry.version ||
        rootEntry.link || installedEntry.link || rootEntry.version !== installedEntry.version ||
        rootEntry.integrity !== installedEntry.integrity || metadata.version !== rootEntry.version || !metadata.name) return null;
    const identity = {
      packageRoot: key, name: metadata.name, version: rootEntry.version, integrity: rootEntry.integrity,
      metadataHash: hash(metadataFile), rootLockHash: state.rootLockHash, installedLockHash: state.installedLockHash,
    };
    state.identities.set(key, identity);
    return identity;
  } catch { return null; }
}

function snapshot(files) {
  const state = context();
  const inputs = [];
  const dependencies = [];
  for (const file of [...new Set(files.map(absolute))].sort()) {
    const identity = registryIdentity(file, state);
    if (identity) dependencies.push({ path: relative(file), identity });
    else inputs.push({ path: relative(file), hash: hash(file) });
  }
  return { inputs, dependencies };
}

function cacheFile(stage) { return path.join(cacheDirectory, `${stage}.json`); }

function validStoredManifest(stage) {
  try {
    const manifest = JSON.parse(fs.readFileSync(cacheFile(stage), 'utf8'));
    if (manifest.schema !== schema || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.dependencies) || !Array.isArray(manifest.outputs)) return false;
    if (![...manifest.inputs, ...manifest.outputs].every((entry) => hash(absolute(entry.path)) === entry.hash)) return false;
    return stable(snapshot(manifest.dependencies.map((entry) => entry.path)).dependencies) === stable(manifest.dependencies);
  } catch { return false; }
}

function valid({ stage, config, tools, outputs }) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(cacheFile(stage), 'utf8')); } catch { return false; }
  if (!manifest || manifest.schema !== schema || manifest.stage !== stage || stable(manifest.config) !== stable(config) ||
      stable(manifest.tools) !== stable(tools) || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.dependencies) || !Array.isArray(manifest.outputs)) return false;
  const expectedOutputs = outputs.map(absolute).sort().map(relative);
  if (stable(manifest.outputs.map((entry) => entry.path).sort()) !== stable(expectedOutputs)) return false;
  try {
    if (![...manifest.inputs, ...manifest.outputs].every((entry) => entry && typeof entry.path === 'string' && typeof entry.hash === 'string' && hash(absolute(entry.path)) === entry.hash)) return false;
    const currentDependencies = snapshot(manifest.dependencies.map((entry) => entry.path)).dependencies;
    return stable(currentDependencies) === stable(manifest.dependencies);
  } catch { return false; }
}

function write({ stage, config, tools, inputs, outputs }) {
  const inputSnapshot = snapshot(inputs);
  const manifest = { schema, stage, config, tools, ...inputSnapshot, outputs: snapshot(outputs).inputs };
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const target = cacheFile(stage);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

module.exports = { absolute, cacheDirectory, hash, registryIdentity, schema, snapshot, stable, valid, validStoredManifest, write };
