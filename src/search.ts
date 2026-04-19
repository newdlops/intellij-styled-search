import * as vscode from 'vscode';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface FileMatch {
  uri: string;
  relPath: string;
  matches: Array<{
    line: number;
    preview: string;
    ranges: MatchRange[];
  }>;
}

export interface SearchProgress {
  onFile(match: FileMatch): void;
  onDone(summary: { totalFiles: number; totalMatches: number; truncated: boolean }): void;
  onError(err: Error): void;
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.o', '.a',
  '.wasm', '.node',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(opts: SearchOptions): RegExp | null {
  if (!opts.query) { return null; }
  let src = opts.useRegex ? opts.query : escapeRegex(opts.query);
  if (opts.wholeWord) { src = `\\b${src}\\b`; }
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

function getExt(fsPath: string): string {
  const i = fsPath.lastIndexOf('.');
  return i >= 0 ? fsPath.slice(i).toLowerCase() : '';
}

const MAX_LINE_PREVIEW = 400;

function clipLine(line: string, range: MatchRange): { preview: string; ranges: MatchRange[] } {
  if (line.length <= MAX_LINE_PREVIEW) {
    return { preview: line, ranges: [range] };
  }
  const matchLen = range.end - range.start;
  const before = Math.max(0, Math.floor((MAX_LINE_PREVIEW - matchLen) / 2));
  const start = Math.max(0, range.start - before);
  const end = Math.min(line.length, start + MAX_LINE_PREVIEW);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  const preview = prefix + line.slice(start, end) + suffix;
  const newStart = range.start - start + prefix.length;
  return {
    preview,
    ranges: [{ start: newStart, end: newStart + matchLen }],
  };
}

export async function runSearch(
  opts: SearchOptions,
  token: vscode.CancellationToken,
  progress: SearchProgress,
  candidateUris?: Set<string> | null,
): Promise<void> {
  const regex = buildRegex(opts);
  if (!regex) {
    progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
    return;
  }

  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  const excludeGlobs = cfg.get<string[]>('excludeGlobs', []);
  const maxFileSize = cfg.get<number>('maxFileSize', 1_048_576);
  const maxResults = cfg.get<number>('maxResults', 2000);

  let files: vscode.Uri[];
  // Fast path: trigram index already told us exactly which files could
  // contain the query. Skip the full findFiles('**/*', 100K) sweep and
  // just materialize the candidate set. This is the single biggest search
  // latency win for warm workspaces — findFiles on a 100K-file workspace
  // is multi-hundred-ms on its own.
  if (candidateUris) {
    if (candidateUris.size === 0) {
      progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
      return;
    }
    files = new Array(candidateUris.size);
    let ci = 0;
    for (const u of candidateUris) { files[ci++] = vscode.Uri.parse(u); }
  } else {
    const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;
    try {
      files = await vscode.workspace.findFiles('**/*', excludePattern, 100_000, token);
    } catch (err) {
      progress.onError(err as Error);
      return;
    }
  }

  if (token.isCancellationRequested) { return; }

  // Reorder so results stream back in relevance order:
  //   1. files the user has open in tabs right now
  //   2. other user source files, shallower paths first (project root prioritized)
  //   3. library-looking paths (node_modules, vendor, venv, …) scanned last
  files = prioritizeFiles(files);

  let totalMatches = 0;
  let filesWithMatches = 0;
  let truncated = false;

  // Raised from 8 → 24. Candidate sets from the trigram index are usually
  // a few thousand files; FS latency dominates and macOS / Linux handle
  // this concurrency level without thrashing.
  const concurrency = 24;
  let idx = 0;

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (true) {
        if (token.isCancellationRequested) { return; }
        if (truncated) { return; }
        const i = idx++;
        if (i >= files.length) { return; }
        const uri = files[i];
        if (BINARY_EXT.has(getExt(uri.fsPath))) { continue; }

        let bytes: Uint8Array;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > maxFileSize) { continue; }
          if (stat.type === vscode.FileType.Directory) { continue; }
          bytes = await vscode.workspace.fs.readFile(uri);
        } catch {
          continue;
        }

        if (looksBinary(bytes)) { continue; }

        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch {
          continue;
        }

        const fileMatch = scanText(text, regex, uri);
        if (fileMatch.matches.length === 0) { continue; }

        totalMatches += fileMatch.matches.length;
        filesWithMatches++;
        progress.onFile(fileMatch);

        if (totalMatches >= maxResults) {
          truncated = true;
          return;
        }
      }
    })());
  }

  await Promise.all(workers);
  progress.onDone({ totalFiles: filesWithMatches, totalMatches, truncated });
}

function looksBinary(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) { return true; }
  }
  return false;
}

// Priority groups for streaming order. Lower is searched first.
//   0: currently open tabs (instant feedback on files the user is editing)
//   1: user code (not in library-ish paths); sorted by path depth ascending
//   2: library-ish paths (node_modules, vendor, venv, dist, site-packages, …)
export const LIBRARY_PATH_RE = /(?:^|\/)(?:node_modules|vendor|third_party|deps|bower_components|\.yarn|\.pnp|\.cache|venv|\.venv|env|\.env|site-packages|dist-info|egg-info|Pods|Carthage|target|out|build|dist|coverage|__pycache__|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.gradle|\.idea|\.vs|\.tox|\.nox|\.parcel-cache|\.turbo)(?:\/|$)/i;

// Also treat these specific files (any location) as library-ish: they're
// giant lock / manifest files that rarely contain what a user searches for.
const LIBRARY_FILENAME_RE = /(?:^|\/)(?:yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|Pipfile\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|bun\.lockb)$/i;

export function isLibraryPath(rel: string): boolean {
  return LIBRARY_PATH_RE.test('/' + rel) || LIBRARY_FILENAME_RE.test('/' + rel);
}

export { collectOpenTabUris };

function collectOpenTabUris(): Set<string> {
  const set = new Set<string>();
  try {
    const groups = (vscode.window as any).tabGroups;
    if (groups && Array.isArray(groups.all)) {
      for (const group of groups.all) {
        for (const tab of group.tabs || []) {
          const input = tab.input;
          if (input && typeof input === 'object' && 'uri' in input && input.uri) {
            set.add(input.uri.toString());
          }
        }
      }
    }
  } catch {}
  // Fallback: textDocuments covers everything VSCode has in memory, slightly
  // broader than open tabs but still a strong relevance signal.
  try {
    for (const doc of vscode.workspace.textDocuments) {
      set.add(doc.uri.toString());
    }
  } catch {}
  return set;
}

export function prioritizeFiles(files: vscode.Uri[]): vscode.Uri[] {
  const openUris = collectOpenTabUris();
  const bucketOpen: vscode.Uri[] = [];
  const bucketUser: Array<{ uri: vscode.Uri; depth: number }> = [];
  const bucketLib: vscode.Uri[] = [];
  for (const uri of files) {
    if (openUris.has(uri.toString())) {
      bucketOpen.push(uri);
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (isLibraryPath(rel)) {
      bucketLib.push(uri);
    } else {
      bucketUser.push({ uri, depth: countSlashes(rel) });
    }
  }
  bucketUser.sort((a, b) => a.depth - b.depth);
  const out: vscode.Uri[] = new Array(bucketOpen.length + bucketUser.length + bucketLib.length);
  let i = 0;
  for (const u of bucketOpen) { out[i++] = u; }
  for (const e of bucketUser) { out[i++] = e.uri; }
  for (const u of bucketLib) { out[i++] = u; }
  return out;
}

function countSlashes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 47) { n++; } }
  return n;
}

function scanText(text: string, regex: RegExp, uri: vscode.Uri): FileMatch {
  const rel = vscode.workspace.asRelativePath(uri, false);
  const result: FileMatch = { uri: uri.toString(), relPath: rel, matches: [] };

  let lineStart = 0;
  let lineNo = 0;
  const len = text.length;

  for (let i = 0; i <= len; i++) {
    if (i === len || text.charCodeAt(i) === 10) {
      let lineEnd = i;
      if (lineEnd > 0 && text.charCodeAt(lineEnd - 1) === 13) { lineEnd--; }
      if (lineEnd > lineStart) {
        const line = text.slice(lineStart, lineEnd);
        regex.lastIndex = 0;
        const ranges: MatchRange[] = [];
        let m: RegExpExecArray | null;
        while ((m = regex.exec(line)) !== null) {
          ranges.push({ start: m.index, end: m.index + m[0].length });
          if (m[0].length === 0) { regex.lastIndex++; }
          if (ranges.length > 50) { break; }
        }
        if (ranges.length > 0) {
          if (ranges.length === 1) {
            const clipped = clipLine(line, ranges[0]);
            result.matches.push({ line: lineNo, preview: clipped.preview, ranges: clipped.ranges });
          } else {
            const preview = line.length <= MAX_LINE_PREVIEW ? line : line.slice(0, MAX_LINE_PREVIEW) + '…';
            const clippedRanges = preview === line
              ? ranges
              : ranges.filter(r => r.end <= MAX_LINE_PREVIEW);
            result.matches.push({ line: lineNo, preview, ranges: clippedRanges });
          }
        }
      }
      lineStart = i + 1;
      lineNo++;
    }
  }
  return result;
}
