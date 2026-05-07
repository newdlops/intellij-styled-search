import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface GitWorkspaceState {
  repoRoot: string | null;
  gitDir: string | null;
  head: string | null;
  branch: string | null;
  stateKey: string;
}

export interface GitWorkspaceStateComparison {
  matches: boolean;
  reason?: string;
}

export function getWorkspaceGitStateSync(workspaceRoot: string | undefined | null): GitWorkspaceState {
  const normalizedWorkspaceRoot = workspaceRoot ? normalizePath(path.resolve(workspaceRoot)) : null;
  if (!workspaceRoot) {
    return nonGitState(normalizedWorkspaceRoot);
  }
  const repoRootRaw = runGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
  if (!repoRootRaw) {
    return nonGitState(normalizedWorkspaceRoot);
  }
  const repoRoot = normalizePath(path.resolve(repoRootRaw));
  const gitDirRaw = runGit(workspaceRoot, ['rev-parse', '--git-dir']);
  const gitDir = gitDirRaw
    ? normalizePath(path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(repoRoot, gitDirRaw))
    : null;
  const head = runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD']);
  const branchRaw = runGit(workspaceRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
  const stateKey = JSON.stringify({
    repoRoot,
    head: head ?? null,
    branch,
  });
  return {
    repoRoot,
    gitDir,
    head: head ?? null,
    branch,
    stateKey,
  };
}

export function compareGitWorkspaceState(
  indexed: GitWorkspaceState | undefined | null,
  current: GitWorkspaceState,
): GitWorkspaceStateComparison {
  if (!current.repoRoot) {
    return {
      matches: !indexed?.repoRoot,
      reason: indexed?.repoRoot ? 'workspace is no longer inside the indexed Git repository' : undefined,
    };
  }
  if (!indexed?.repoRoot) {
    return { matches: false, reason: 'indexed Git state is missing' };
  }
  if (normalizePath(indexed.repoRoot) !== current.repoRoot) {
    return {
      matches: false,
      reason: `Git repository changed from ${indexed.repoRoot} to ${current.repoRoot}`,
    };
  }
  if ((indexed.head ?? null) !== (current.head ?? null)) {
    return {
      matches: false,
      reason: `Git HEAD changed from ${shortHead(indexed.head)} to ${shortHead(current.head)}`,
    };
  }
  if ((indexed.branch ?? null) !== (current.branch ?? null)) {
    return {
      matches: false,
      reason: `Git branch changed from ${indexed.branch ?? '(detached)'} to ${current.branch ?? '(detached)'}`,
    };
  }
  return { matches: true };
}

export function isGitWorkspaceState(value: unknown): value is GitWorkspaceState {
  if (!value || typeof value !== 'object') { return false; }
  const state = value as Partial<Record<keyof GitWorkspaceState, unknown>>;
  return (
    (typeof state.repoRoot === 'string' || state.repoRoot === null) &&
    (typeof state.gitDir === 'string' || state.gitDir === null) &&
    (typeof state.head === 'string' || state.head === null) &&
    (typeof state.branch === 'string' || state.branch === null) &&
    typeof state.stateKey === 'string'
  );
}

function runGit(workspaceRoot: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', workspaceRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const stdout = (result.stdout || '').trim();
  return stdout.length > 0 ? stdout : null;
}

function nonGitState(workspaceRoot: string | null): GitWorkspaceState {
  return {
    repoRoot: null,
    gitDir: null,
    head: null,
    branch: null,
    stateKey: `nogit:${workspaceRoot ?? ''}`,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function shortHead(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : '(none)';
}
