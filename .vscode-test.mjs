import { defineConfig } from '@vscode/test-cli';

// E2E test config. @vscode/test-cli spawns a clean VSCode instance with our
// extension installed, opens the fixture workspace, and runs every compiled
// *.test.js under out/test/. Mocha is driven implicitly.
//
// The fixture workspace (tests/fixtures/workspace) holds a handful of files
// with known content that test cases assert against — see alpha.py etc.
export default defineConfig({
  label: 'e2e',
  files: 'out/test/suite/**/*.test.js',
  workspaceFolder: './tests/fixtures/workspace',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
    // Tests build the trigram index from scratch (rebuild() walks the
    // fixture workspace). Slow operations live behind an explicit opt-in.
  },
});
