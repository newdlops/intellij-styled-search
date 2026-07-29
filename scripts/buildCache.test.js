const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const cache = require('./buildCache');

test('content-addressed manifests hit only when every input and output is intact', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.build-cache-test-'));
  const stage = `test-${process.pid}-${Date.now()}`;
  const input = path.join(directory, 'input');
  const auxiliary = path.join(directory, 'notice');
  const output = path.join(directory, 'output');
  const options = { stage, config: { setting: 'one' }, tools: { node: 'test' }, outputs: [output] };
  try {
    fs.writeFileSync(input, 'same-size');
    fs.writeFileSync(auxiliary, 'notice');
    fs.writeFileSync(output, 'artifact');
    cache.write({ ...options, inputs: [input, auxiliary] });
    assert.equal(cache.valid(options), true);
    fs.writeFileSync(input, 'different!');
    assert.equal(cache.valid(options), false);
    fs.writeFileSync(input, 'same-size');
    fs.unlinkSync(output);
    assert.equal(cache.valid(options), false);
    fs.writeFileSync(output, 'artifact');
    assert.equal(cache.valid({ ...options, config: { setting: 'two' } }), false);
    assert.equal(cache.valid({ ...options, tools: { node: 'other' } }), false);
    fs.writeFileSync(path.join(cache.cacheDirectory, `${stage}.json`), '{malformed');
    assert.equal(cache.valid(options), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(path.join(cache.cacheDirectory, `${stage}.json`), { force: true });
  }
});

test('only verified registry dependencies receive integrity identities', () => {
  const registryFile = require.resolve('monaco-editor/package.json');
  const registry = cache.registryIdentity(registryFile, null);
  assert.equal(registry, null, 'missing lock context fails closed');
  const snapshot = cache.snapshot([registryFile, __filename]);
  assert.equal(snapshot.dependencies.length, 1);
  assert.equal(snapshot.dependencies[0].identity.name, 'monaco-editor');
  assert.equal(snapshot.inputs.some((entry) => entry.path === 'scripts/buildCache.test.js'), true);
  assert.equal(cache.registryIdentity(__filename, null), null, 'workspace files never use registry identities');
});

test('registry identity validation rejects lock and package metadata disagreement', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.build-cache-registry-'));
  const stage = `registry-${process.pid}-${Date.now()}`;
  const output = path.join(directory, 'output');
  const options = { stage, config: { setting: 'registry' }, tools: { node: 'test' }, outputs: [output] };
  const manifestFile = path.join(cache.cacheDirectory, `${stage}.json`);
  try {
    fs.writeFileSync(output, 'artifact');
    cache.write({ ...options, inputs: [require.resolve('monaco-editor/package.json')] });
    assert.equal(cache.valid(options), true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.dependencies[0].identity.rootLockHash = 'changed';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(cache.valid(options), false);
    manifest.dependencies[0].identity.rootLockHash = cache.snapshot([require.resolve('monaco-editor/package.json')]).dependencies[0].identity.rootLockHash;
    manifest.dependencies[0].identity.metadataHash = 'changed';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(cache.valid(options), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(manifestFile, { force: true });
  }
});
