import { defineConfig } from '@vscode/test-cli';

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
export default defineConfig({
  label: 'e2e',
  files: testFiles,
  // Keep the Electron main-process inspector for the test VS Code away from
  // a developer's already-running VS Code, which usually owns port 9229.
  launchArgs: ['--inspect=9239'],
  workspaceFolder,
  mocha: {
    ui: 'tdd',
    timeout: captainWorkspace ? 600_000 : 30_000,
    bail: captainWorkspace,
    // Tests build the trigram index from scratch (rebuild() walks the
    // fixture workspace). Slow operations live behind an explicit opt-in.
  },
});
