import { defineConfig } from '@vscode/test-cli';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const textMateBridgeFixture = path.join(repoRoot, 'tests', 'fixtures', 'extensions', 'textmate-bridge');

const workspaceFolder = process.env.IJSS_E2E_WORKSPACE || './tests/fixtures/workspace';
const normalizedWorkspaceFolder = workspaceFolder.replace(/\\/g, '/').replace(/\/+$/, '');
const captainWorkspace = normalizedWorkspaceFolder.endsWith('/captain2/captain');
const testFiles = process.env.IJSS_E2E_FILES ||
  (captainWorkspace ? 'out/test/suite/captainIndexGate.test.js' : 'out/test/suite/**/*.test.js');

// E2E test config. @vscode/test-cli spawns a clean VSCode instance with our
// extension installed, opens the fixture workspace, and runs every compiled
// *.test.js under out/test/. Mocha is driven implicitly.
//
// The fixture workspace (tests/fixtures/workspace) holds a handful of files
// with known content that test cases assert against — see alpha.py etc. Set
// IJSS_E2E_WORKSPACE to /Users/lky/project/captain2/captain to run the
// captain-sized index build gate before the rest of that harness is rewritten.

// Isolated user-data + extensions directory per test run. Without this, the
// test VS Code shares state with the developer's own VS Code (including
// MRU lists, telemetry, and — critically for us — main-process PID
// matching when findMainPid walks the process tree). Routing the test
// instance into a dedicated tmpdir keeps the dev workbench untouched.
const isolatedRoot = path.join(os.tmpdir(), 'ijss-e2e', `${process.pid}-${Date.now()}`);
const isolatedUserData = path.join(isolatedRoot, 'user-data');
const isolatedExtensions = path.join(isolatedRoot, 'extensions');

// @vscode/test-electron currently resolves the macOS app executable as
// Contents/MacOS/Electron. Newer stable archives name the same executable
// Contents/MacOS/Code instead. Resolve the downloaded installation up front so
// a clean test checkout works with either archive layout without mutating the
// shared .vscode-test cache.
const requestedCodeVersion = process.env.IJSS_E2E_VSCODE_VERSION || 'stable';
const downloadedExecutable = await downloadAndUnzipVSCode(requestedCodeVersion);
const vscodeExecutable = existsSync(downloadedExecutable)
  ? downloadedExecutable
  : process.platform === 'darwin'
    ? path.join(path.dirname(downloadedExecutable), 'Code')
    : downloadedExecutable;

if (!existsSync(vscodeExecutable)) {
  throw new Error(
    `VS Code test executable was not found at ${downloadedExecutable} or ${vscodeExecutable}`,
  );
}

export default defineConfig({
  label: 'e2e',
  files: testFiles,
  extensionDevelopmentPath: [repoRoot, textMateBridgeFixture],
  // VSCODE_TEST=1 flips overlayPanel.shouldAutoCloseCdpForTests() so the
  // 250ms show-shell-idle CDP close path stays disabled. Without this the
  // background CDP idle timer races with awaited Runtime.evaluate calls and
  // surfaces "CDP connection closed (show-shell-idle)" mid-test.
  env: {
    VSCODE_TEST: '1',
  },
  useInstallation: {
    fromPath: vscodeExecutable,
  },
  // Keep the Electron main-process inspector for the test VS Code away from
  // a developer's already-running VS Code, which usually owns port 9229.
  // The --user-data-dir + --extensions-dir flags ensure this test VS Code
  // does not share preferences/workspace state with the dev instance.
  launchArgs: [
    '--inspect=9239',
    `--user-data-dir=${isolatedUserData}`,
    `--extensions-dir=${isolatedExtensions}`,
    '--disable-gpu-sandbox',
    '--no-cached-data',
  ],
  workspaceFolder,
  mocha: {
    ui: 'tdd',
    timeout: captainWorkspace ? 600_000 : 30_000,
    bail: captainWorkspace,
    // Tests build the trigram index from scratch (rebuild() walks the
    // fixture workspace). Slow operations live behind an explicit opt-in.
  },
});
