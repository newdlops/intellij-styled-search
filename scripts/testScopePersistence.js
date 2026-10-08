// Five distinct VS Code launches reuse one isolated profile and two workspaces.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-scope-restart-'));
const output = path.resolve(process.env.IJSS_SCOPE_OUTPUT || path.join(root, 'artifacts', 'scope-persistence'));
fs.mkdirSync(output, { recursive: true });
const profiles = { userData: path.join(fixture, 'user-data'), extensions: path.join(fixture, 'extensions') };
const sources = {
  'src/view.vue': '<template>ScopeRestartProbe</template>\n',
  'src/source.ts': 'export const value = "ScopeRestartProbe";\n',
  'src/types.d.ts': 'declare const ScopeRestartProbe: string;\n',
  'scripts/script.js': 'const value = "ScopeRestartProbe";\n',
  'notes.md': 'ScopeRestartProbe\n',
};
for (const project of ['a', 'b']) {
  const workspace = path.join(fixture, `workspace-${project}`);
  for (const [file, text] of Object.entries(sources)) {
    const destination = path.join(workspace, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  }
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'intellijStyledSearch.defaultFilesScope': project === 'a' ? '**/*.js' : '**/*.md',
    'intellijStyledSearch.engine': 'codesearch',
    'intellijStyledSearch.searchOnOpen': false,
  }));
}
const stages = [
  ['write', 'a'], ['restore', 'a'], ['isolation-clear', 'b'], ['restore-empty', 'b'], ['restore-isolation', 'a'],
];
async function main() {
  try {
    const downloaded = process.env.IJSS_E2E_VSCODE_EXECUTABLE ||
      await downloadAndUnzipVSCode(process.env.IJSS_E2E_VSCODE_VERSION || 'stable');
    const executable = fs.existsSync(downloaded) ? downloaded : process.platform === 'darwin'
      ? path.join(path.dirname(downloaded), 'Code') : downloaded;
    const tester = path.join(root, 'tests/fixtures/extensions/scope-restart');
    for (const [stage, project] of stages) {
      // A launch that fails before activating the fixture cannot reuse an older pass.
      for (const file of [`${stage}-result.json`, `${stage}.json`]) {
        fs.rmSync(path.join(output, file), { force: true });
      }
      console.log(`[scope restart] starting ${stage} in workspace-${project}`);
      const result = spawnSync(executable, [path.join(fixture, `workspace-${project}`),
        `--user-data-dir=${profiles.userData}`, `--extensions-dir=${profiles.extensions}`,
        `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${tester}`,
        ...(process.env.IJSS_E2E_INSPECTOR_ON_DEMAND === '1' ? [] : ['--inspect=9239']),
        '--new-window', '--disable-updates', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--disable-gpu-sandbox', '--no-cached-data',
      ], {
        cwd: root, stdio: 'inherit', timeout: 180000, windowsHide: true,
        env: { ...process.env, VSCODE_TEST: '1',
          IJSS_SCOPE_STAGE: stage, IJSS_SCOPE_ARTIFACTS: output, IJSS_SCOPE_REPO: root,
        },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`VS Code exited with ${result.status}, signal=${result.signal}`);
      const accepted = JSON.parse(fs.readFileSync(path.join(output, `${stage}-result.json`), 'utf8'));
      if (!accepted.passed) {
        fs.cpSync(path.join(profiles.userData, 'logs'), path.join(output, `${stage}-logs`), { recursive: true });
        throw new Error(accepted.error);
      }
      console.log(`[scope restart] completed ${stage}; VS Code exited`);
    }
    const reports = stages.map(([stage]) => JSON.parse(fs.readFileSync(path.join(output, `${stage}.json`), 'utf8')));
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ profile: fixture, reports }, null, 2) + '\n');
    console.log('[scope restart] all five launches passed');
  } finally {
    // Preserve failure logs/screenshots in artifacts, remove only this generated fixture/profile.
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
