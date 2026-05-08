import { defineConfig } from '@vscode/test-cli';

const workspaceFolder = process.env.IJSS_E2E_WORKSPACE || './tests/fixtures/workspace';

// E2E test config. @vscode/test-cli spawns a clean VSCode instance with our
// extension installed, opens the fixture workspace, and runs every compiled
// *.test.js under out/test/. Mocha is driven implicitly.
//
// The fixture workspace (tests/fixtures/workspace) holds a handful of files
// with known content that test cases assert against — see alpha.py etc. Set
// IJSS_E2E_WORKSPACE to point the same harness at a real project.
export default defineConfig({
  label: 'e2e',
  files: 'out/test/suite/**/*.test.js',
  // Keep the Electron main-process inspector for the test VS Code away from
  // a developer's already-running VS Code, which usually owns port 9229.
  launchArgs: ['--inspect=9239'],
  workspaceFolder,
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    // Tests build the trigram index from scratch (rebuild() walks the
    // fixture workspace). Slow operations live behind an explicit opt-in.
  },
});
