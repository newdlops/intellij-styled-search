const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.argv[2] || path.join(root, 'resources', 'bin',
  `${process.platform}-${process.arch}`, `zoek-rs${process.platform === 'win32' ? '.exe' : ''}`));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-usage-semantics-'));
const invokePython = (...args) => execFileSync(python, args, { cwd: root, stdio: 'inherit', timeout: 120000, windowsHide: true });
try {
  fs.cpSync(path.join(root, 'tests', 'fixtures', 'usage-semantics'), workspace, {
    recursive: true, filter: (source) => !source.split(path.sep).some((part) => part === '.zoek-rs' || part === '__pycache__'),
  });
  invokePython('scripts/verify_usage_accuracy_test.py');
  invokePython('scripts/verify_usage_accuracy.py', workspace, '--expectations', path.join(workspace, 'expected.json'), '--binary', binary, '--rebuild');
  const dump = path.join(workspace, 'live-audit.tsv');
  const audit = JSON.parse(execFileSync(binary, ['graph-audit-counts', workspace, '--dump-first-party', dump], { encoding: 'utf8', timeout: 120000, windowsHide: true }));
  if (audit.undercount.symbols || audit.overcount.symbols) { throw new Error(JSON.stringify(audit)); }
  invokePython('scripts/verify_usage_accuracy.py', workspace, dump);
} finally { fs.rmSync(workspace, { recursive: true, force: true }); }
