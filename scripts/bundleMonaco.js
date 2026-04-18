#!/usr/bin/env node
// Bundle monaco-editor as a single IIFE that, when eval'd in any context,
// sets globalThis.monaco. We ship this file with the extension and inject it
// into the VSCode renderer via CDP Runtime.evaluate so the preview pane can
// instantiate a real monaco editor.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'monaco-entry.mjs');
const outDir = path.join(root, 'resources');
const outFile = path.join(outDir, 'monaco.bundle.js');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const result = esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  outfile: outFile,
  minify: true,
  target: 'chrome120',
  platform: 'browser',
  legalComments: 'none',
  loader: {
    '.ttf': 'dataurl',
    '.css': 'text',
  },
  // Monaco uses workers, but those need a separate setup. Disable here — we
  // rely on the fallback in-process mode; slightly less responsive but works
  // without worker bootstrapping.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const stat = fs.statSync(outFile);
console.log(`[bundleMonaco] wrote ${outFile} — ${(stat.size / 1024).toFixed(0)} KB`);
if (result.warnings && result.warnings.length) {
  console.warn(`[bundleMonaco] ${result.warnings.length} warnings`);
}
