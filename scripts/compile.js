const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const cache = require('./buildCache');

const root = path.resolve(__dirname, '..');
const manifestFile = path.join(cache.cacheDirectory, 'pipeline-v1.json');
const outputRoots = [path.join(root, 'out'), path.join(root, 'resources', 'monaco.bundle.js'), path.join(root, 'resources', 'monaco.third-party-notices.txt')];
function files(target) {
  if (!fs.existsSync(target)) return [];
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => files(path.join(target, entry.name)));
}
function programState() {
  const configFile = path.join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configFile);
  if (config.errors.length) throw new Error(ts.flattenDiagnosticMessageText(config.errors[0].messageText, '\n'));
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const roots = config.fileNames.map(cache.absolute).sort();
  const sources = program.getSourceFiles().map((source) => source.fileName).filter((file) => fs.existsSync(file)).sort();
  const metadata = [configFile, path.join(root, 'package.json'), path.join(root, 'package-lock.json'), path.join(root, 'node_modules', '.package-lock.json')];
  return { roots: roots.map((file) => path.relative(root, file).split(path.sep).join('/')), sources: sources.map((file) => path.relative(root, file).split(path.sep).join('/')), inputs: [...sources, ...metadata] };
}
function snapshotState() {
  const state = programState();
  return { ...state, inputs: cache.snapshot(state.inputs), outputs: cache.snapshot(outputRoots.flatMap(files)).inputs,
    keys: { node: process.version, typescript: ts.version, platform: process.platform, arch: process.arch } };
}
function validPipeline() {
  try {
    const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const current = snapshotState();
    return saved.schema === 1 && cache.stable(saved) === cache.stable({ schema: 1, ...current, bundles: ['monaco', 'call-graph-worker'] }) &&
      cache.validStoredManifest('monaco') && cache.validStoredManifest('call-graph-worker');
  } catch { return false; }
}
function publish() {
  const value = { schema: 1, ...snapshotState(), bundles: ['monaco', 'call-graph-worker'] };
  fs.mkdirSync(cache.cacheDirectory, { recursive: true });
  const temp = `${manifestFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`); fs.renameSync(temp, manifestFile);
}
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit' }); child.on('error', reject); child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed${signal ? ` (${signal})` : ` (${code})`}`))); }); }
async function main() {
  if (validPipeline()) { console.log('[compile] whole-pipeline cache hit'); return; }
  await run(process.execPath, [path.join(__dirname, 'bundleMonaco.js')]);
  await run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', './']);
  await run(process.execPath, [path.join(__dirname, 'bundleCallGraphWorker.js')]);
  publish();
}
main().catch((error) => { console.error(`[compile] ${error.message}`); process.exitCode = 1; });
