import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  compareGitWorkspaceState,
  getWorkspaceGitStateSync,
  type GitWorkspaceState,
} from '../../gitState';

function gitState(overrides: Partial<GitWorkspaceState> = {}): GitWorkspaceState {
  const state: GitWorkspaceState = {
    repoRoot: '/repo',
    gitDir: '/repo/.git',
    head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    branch: 'main',
    stateKey: '',
    ...overrides,
  };
  return {
    ...state,
    stateKey: JSON.stringify({
      repoRoot: state.repoRoot,
      head: state.head,
      branch: state.branch,
    }),
  };
}

suite('Git state', () => {
  test('accepts missing indexed state outside Git workspaces', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ijss-nongit-'));
    try {
      const current = getWorkspaceGitStateSync(tmp);
      assert.strictEqual(current.repoRoot, null);
      assert.strictEqual(compareGitWorkspaceState(undefined, current).matches, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('marks Git index metadata stale when HEAD or branch changes', () => {
    const indexed = gitState();
    assert.strictEqual(compareGitWorkspaceState(indexed, gitState()).matches, true);

    const headChanged = compareGitWorkspaceState(indexed, gitState({
      head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }));
    assert.strictEqual(headChanged.matches, false);
    assert.match(headChanged.reason ?? '', /HEAD changed/);

    const branchChanged = compareGitWorkspaceState(indexed, gitState({ branch: 'feature' }));
    assert.strictEqual(branchChanged.matches, false);
    assert.match(branchChanged.reason ?? '', /branch changed/);
  });

  test('requires Git metadata for Git workspaces', () => {
    const current = gitState();
    const result = compareGitWorkspaceState(undefined, current);
    assert.strictEqual(result.matches, false);
    assert.match(result.reason ?? '', /missing/);
  });
});
