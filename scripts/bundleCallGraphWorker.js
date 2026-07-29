const path = require('path');
const esbuild = require('esbuild');
const cache = require('./buildCache');

const root = path.resolve(__dirname, '..');
const shim = path.join(root, 'src', 'nodeVscodeShim.ts');
const outFile = path.join(root, 'out', 'callGraphWorkerProcess.js');
const cacheOptions = {
  stage: 'call-graph-worker',
  config: { platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, plugin: 'vscode-shim-v1' },
  tools: { node: process.version, esbuild: esbuild.version },
  outputs: [outFile, `${outFile}.map`],
};

const vscodeShimPlugin = {
  name: 'vscode-shim',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: shim }));
  },
};

if (cache.valid(cacheOptions)) {
  console.log('[bundleCallGraphWorker] cache hit out/callGraphWorkerProcess.js');
} else {
esbuild.build({
  entryPoints: [path.join(root, 'src', 'callGraphWorkerProcess.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  metafile: true,
  plugins: [vscodeShimPlugin],
}).then((result) => {
  cache.write({
    ...cacheOptions,
    inputs: [...Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file)), __filename, shim, path.join(root, 'package-lock.json')],
  });
  console.log('[bundleCallGraphWorker] wrote out/callGraphWorkerProcess.js');
}, (err) => {
  console.error(err);
  process.exit(1);
});
}
