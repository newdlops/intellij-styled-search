const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'out', 'test', 'unit');
const tests = fs.readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort()
  .map((name) => path.join(dir, name));
if (tests.length === 0) { throw new Error('No compiled unit tests found; run npm run compile first.'); }
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) { throw result.error; }
process.exitCode = result.status ?? 1;
