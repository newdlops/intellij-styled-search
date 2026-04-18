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

  const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : undefined;

  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles('**/*', excludePattern, 100_000, token);
  } catch (err) {
    progress.onError(err as Error);
    return;
  }

  if (token.isCancellationRequested) { return; }

  let totalMatches = 0;
  let filesWithMatches = 0;
  let truncated = false;

  const concurrency = 8;
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
