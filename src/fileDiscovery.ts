import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { compilePathScopeMatcher } from './pathScope';

export interface DirectWorkspaceFileOptions {
  excludeGlobs?: readonly string[];
  extensions?: ReadonlySet<string>;
  maxResults?: number;
  token?: vscode.CancellationToken;
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  onProgress?: (count: number) => void;
}

export async function findWorkspaceFilesDirect(options: DirectWorkspaceFileOptions = {}): Promise<vscode.Uri[]> {
  const folders = options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
  const out: vscode.Uri[] = [];
  const excludeMatcher = compilePathScopeMatcher(undefined, options.excludeGlobs);
  const maxResults = Math.max(0, options.maxResults ?? Number.MAX_SAFE_INTEGER);
  for (const folder of folders) {
    if (options.token?.isCancellationRequested || out.length >= maxResults) { break; }
    await walkDirectory(folder.uri.fsPath, '', out, {
      excludeMatcher,
      extensions: options.extensions,
      maxResults,
      token: options.token,
      onProgress: options.onProgress,
    });
  }
  return out;
}

type WalkState = {
  excludeMatcher: ((relPath: string) => boolean) | null;
  extensions: ReadonlySet<string> | undefined;
  maxResults: number;
  token: vscode.CancellationToken | undefined;
  onProgress: ((count: number) => void) | undefined;
};

async function walkDirectory(root: string, relDir: string, out: vscode.Uri[], state: WalkState): Promise<void> {
  if (state.token?.isCancellationRequested || out.length >= state.maxResults) { return; }
  const absDir = relDir ? path.join(root, relDir) : root;
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(absDir);
  } catch {
    return;
  }
  try {
    for await (const entry of dir) {
      if (state.token?.isCancellationRequested || out.length >= state.maxResults) { break; }
      if (entry.name === '.' || entry.name === '..') { continue; }
      const relPath = toSlashPath(relDir ? path.join(relDir, entry.name) : entry.name);
      if (entry.isDirectory()) {
        if (shouldPruneDirectory(relPath, state.excludeMatcher)) { continue; }
        await walkDirectory(root, relPath, out, state);
        continue;
      }
      if (!entry.isFile()) { continue; }
      if (state.extensions && !state.extensions.has(path.extname(entry.name).toLowerCase())) { continue; }
      if (state.excludeMatcher && !state.excludeMatcher(relPath)) { continue; }
      out.push(vscode.Uri.file(path.join(root, relPath)));
      state.onProgress?.(out.length);
    }
  } finally {
    try { await dir.close(); } catch {}
  }
}

function shouldPruneDirectory(
  relPath: string,
  excludeMatcher: ((relPath: string) => boolean) | null,
): boolean {
  if (!excludeMatcher) { return false; }
  return !excludeMatcher(`${relPath}/__ijss_probe__`);
}

function toSlashPath(value: string): string {
  return value.replace(/\\/g, '/');
}
