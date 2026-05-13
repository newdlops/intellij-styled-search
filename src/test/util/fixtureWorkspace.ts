import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Files our tests assert against by relative path. The fixture workspace
// (tests/fixtures/workspace) is the source of truth; when tests run against
// a different workspace (e.g. /project/captain2/captain) we seed copies of
// these files into the workspace root at suite setup so assertions like
// `relPaths(matches) === ['alpha.py']` still hold.
const SEEDED_RELATIVE_PATHS = [
  'alpha.py',
  'beta.js',
  'callgraph_external_api.js',
  'callgraph_external_api.js.map',
  'callgraph_external_consumer.js',
  'callgraph_external_consumer.js.map',
  'docs.md',
  'nested/delta.js',
  'nested/delta.js.map',
];

/**
 * Returns true if the workspace already hosts its own `.git` (file or
 * directory). Tests that hard-code fixture relPaths (`alpha.py`, etc.) or
 * exercise full-rebuild paths can't reliably pass against such workspaces
 * — call `this.skip()` and bail.
 */
export async function workspaceHasOwnGit(): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return false; }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.git'));
    return true;
  } catch {
    return false;
  }
}

export interface FixtureSeed {
  /** Absolute path of the workspace root the seed targets. */
  readonly workspaceRoot: string;
  /** Files we created during seeding (we own cleanup for these only). */
  readonly seededAbsolutePaths: string[];
  /** Files that already existed in the workspace and were left untouched. */
  readonly preExistingAbsolutePaths: string[];
  /** Remove every file we seeded. Safe to call repeatedly. */
  cleanup(): Promise<void>;
}

function resolveFixtureSourceRoot(): string {
  // Compiled at out/test/util/fixtureWorkspace.js — repo root is three levels
  // up. The fixtures directory exists in the source tree regardless of where
  // the test workspace is.
  return path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'workspace');
}

function isInsideWorkspace(target: string, root: string): boolean {
  const normalizedRoot = path.resolve(root) + path.sep;
  const normalizedTarget = path.resolve(target);
  return normalizedTarget.startsWith(normalizedRoot);
}

/**
 * Copy fixture files into the running workspace if they aren't already there.
 *
 * Tests that assert by `relPath` (e.g. `'alpha.py'`) need the file to live at
 * `<workspaceRoot>/alpha.py`. On the dedicated fixture workspace these files
 * are already on disk; on /project/captain2/captain (or any other workspace)
 * we copy them in for the duration of the suite and remove them in cleanup.
 */
export async function seedFixtureFiles(): Promise<FixtureSeed> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { throw new Error('seedFixtureFiles: no workspace folder'); }
  const workspaceRoot = folder.uri.fsPath;
  const fixtureRoot = resolveFixtureSourceRoot();

  const seeded: string[] = [];
  const preExisting: string[] = [];
  for (const rel of SEEDED_RELATIVE_PATHS) {
    const target = path.join(workspaceRoot, rel);
    if (!isInsideWorkspace(target, workspaceRoot)) { continue; }
    if (fs.existsSync(target)) { preExisting.push(target); continue; }
    const source = path.join(fixtureRoot, rel);
    if (!fs.existsSync(source)) { continue; }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      seeded.push(target);
    } catch (err) {
      // Best-effort: a single file failing to copy shouldn't crash setup.
      // Tests that need it will fail with a clearer message than we'd throw
      // here.
    }
  }

  return {
    workspaceRoot,
    seededAbsolutePaths: seeded.slice(),
    preExistingAbsolutePaths: preExisting.slice(),
    async cleanup() {
      for (const file of seeded) {
        try { fs.unlinkSync(file); } catch {}
      }
      // Attempt to drop the `nested/` directory if we created it and it's
      // now empty. rmdirSync throws if it has contents — that's the signal
      // the workspace had its own files there, so we leave it alone.
      const nestedDir = path.join(workspaceRoot, 'nested');
      try {
        const entries = fs.readdirSync(nestedDir);
        if (entries.length === 0) { fs.rmdirSync(nestedDir); }
      } catch {}
    },
  };
}
