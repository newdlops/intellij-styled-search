const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const shim = path.join(root, 'src', 'nodeVscodeShim.ts');

const vscodeShimPlugin = {
  name: 'vscode-shim',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: shim }));
  },
};

esbuild.build({
  entryPoints: [path.join(root, 'src', 'callGraphWorkerProcess.ts')],
  outfile: path.join(root, 'out', 'callGraphWorkerProcess.js'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  plugins: [vscodeShimPlugin],
}).then(() => {
  console.log('[bundleCallGraphWorker] wrote out/callGraphWorkerProcess.js');
}, (err) => {
  console.error(err);
  process.exit(1);
});
