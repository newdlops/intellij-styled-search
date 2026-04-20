import * as vscode from 'vscode';
import { compileIncludeMatcher } from './pathScope';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  includePatterns?: string[];
  resultOffset?: number;
  resultLimit?: number;
}

export interface MatchRange {
  start: number;
  end: number;
  /** Absolute file line (0-based) where the match ENDS, when it spans
   *  multiple lines. When omitted, the match is single-line and `end` is
   *  the column on the match's starting line. */
  endLine?: number;
  /** Column on `endLine` where the match ends. Only meaningful when
   *  `endLine` is set (multi-line matches). */
  endCol?: number;
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

export interface SearchForTestsResult {
  matches: FileMatch[];
  requestedEngine: SearchEngine;
  effectiveEngine: SearchEngine;
  fallbackReason?: string;
}

export interface SearchProgress {
  onFile(match: FileMatch): void;
  onDone(summary: { totalFiles: number; totalMatches: number; truncated: boolean }): void;
  onError(err: Error): void;
}

export type SearchEngine = 'zoekt' | 'codesearch';

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
  const flags = 'g' + (opts.caseSensitive ? '' : 'i') + (opts.useRegex ? 'ms' : '');
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
export const DEFAULT_MAX_RESULTS = 2000;
export const HARD_MAX_RESULTS = 10000;
export const FILE_MATCH_CHUNK_MATCH_LIMIT = 200;
export const FILE_MATCH_CHUNK_CHAR_LIMIT = 64 * 1024;

export function getConfiguredResultLimit(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): number {
  const raw = cfg.get<number>('maxResults', DEFAULT_MAX_RESULTS);
  if (!Number.isFinite(raw)) { return DEFAULT_MAX_RESULTS; }
  if (raw <= 0) { return DEFAULT_MAX_RESULTS; }
  return Math.max(1, Math.min(Math.floor(raw), HARD_MAX_RESULTS));
}

export function getRequestedResultOffset(opts: SearchOptions): number {
  const raw = opts.resultOffset;
  if (!Number.isFinite(raw)) { return 0; }
  return Math.max(0, Math.floor(raw!));
}

export function getRequestedResultLimit(
  opts: SearchOptions,
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): number {
  const raw = opts.resultLimit;
  if (!Number.isFinite(raw) || raw === undefined) { return getConfiguredResultLimit(cfg); }
  if (raw <= 0) { return getConfiguredResultLimit(cfg); }
  return Math.max(1, Math.min(Math.floor(raw), HARD_MAX_RESULTS));
}

export function getConfiguredSearchEngine(
  cfg = vscode.workspace.getConfiguration('intellijStyledSearch'),
): SearchEngine {
  const raw = cfg.get<string>('engine', 'zoekt');
  return raw === 'codesearch' ? 'codesearch' : 'zoekt';
}

function estimateMatchPayloadSize(match: FileMatch['matches'][number]): number {
  return (match.preview?.length ?? 0) + (match.ranges?.length ?? 0) * 48 + 64;
}

export function splitFileMatchChunks(
  fileMatch: FileMatch,
  matchLimit = FILE_MATCH_CHUNK_MATCH_LIMIT,
  charLimit = FILE_MATCH_CHUNK_CHAR_LIMIT,
): FileMatch[] {
  if (fileMatch.matches.length === 0) { return []; }
  const chunks: FileMatch[] = [];
  let current: FileMatch['matches'] = [];
  let currentChars = 0;

  const pushChunk = () => {
    if (current.length === 0) { return; }
    chunks.push({
      uri: fileMatch.uri,
      relPath: fileMatch.relPath,
      matches: current,
    });
    current = [];
    currentChars = 0;
  };

  for (const match of fileMatch.matches) {
    const weight = estimateMatchPayloadSize(match);
    if (current.length > 0 && (current.length >= matchLimit || currentChars + weight > charLimit)) {
      pushChunk();
    }
    current.push(match);
    currentChars += weight;
    if (current.length >= matchLimit || currentChars >= charLimit) {
      pushChunk();
    }
  }
  pushChunk();
  return chunks;
}

export function mergeFileMatches(matches: FileMatch[]): FileMatch[] {
  const merged = new Map<string, FileMatch>();
  const ordered: FileMatch[] = [];
  for (const match of matches) {
    const existing = merged.get(match.uri);
    if (existing) {
      existing.matches.push(...match.matches);
      continue;
    }
    const copy: FileMatch = {
      uri: match.uri,
      relPath: match.relPath,
      matches: [...match.matches],
    };
    merged.set(copy.uri, copy);
    ordered.push(copy);
  }
  return ordered;
}

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
  const resultLimit = getRequestedResultLimit(opts, cfg);
  const resultOffset = getRequestedResultOffset(opts);
  const includeMatcher = compileIncludeMatcher(opts.includePatterns);

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
    // null (not undefined) so findFiles bypasses VSCode's default
    // search.exclude. Empty excludeGlobs means "search everything".
    const excludePattern = excludeGlobs.length > 0 ? `{${excludeGlobs.join(',')}}` : null;
    try {
      files = await vscode.workspace.findFiles('**/*', excludePattern, 100_000, token);
    } catch (err) {
      progress.onError(err as Error);
      return;
    }
  }

  if (includeMatcher) {
    files = files.filter((uri) => includeMatcher(vscode.workspace.asRelativePath(uri, false)));
    if (files.length === 0) {
      progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
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
  const concurrency = (opts.resultLimit !== undefined || resultOffset > 0) ? 1 : 24;
  let idx = 0;
  let skippedMatches = 0;

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

        const remainingLimit = resultLimit > 0 ? Math.max(0, resultLimit - totalMatches) : 0;
        if (resultLimit > 0 && remainingLimit === 0) {
          truncated = true;
          return;
        }

        const fileMatch = scanText(text, regex, uri, opts.useRegex || opts.query.includes('\n'));
        if (fileMatch.matches.length === 0) { continue; }

        let sliceStart = 0;
        if (resultOffset > skippedMatches) {
          sliceStart = Math.min(fileMatch.matches.length, resultOffset - skippedMatches);
          skippedMatches += sliceStart;
        }
        if (sliceStart >= fileMatch.matches.length) { continue; }

        const slicedMatches = resultLimit > 0
          ? fileMatch.matches.slice(sliceStart, sliceStart + remainingLimit)
          : fileMatch.matches.slice(sliceStart);
        if (slicedMatches.length === 0) { continue; }

        totalMatches += slicedMatches.length;
        filesWithMatches++;
        const slicedFileMatch: FileMatch = {
          uri: fileMatch.uri,
          relPath: fileMatch.relPath,
          matches: slicedMatches,
        };
        for (const chunk of splitFileMatchChunks(slicedFileMatch)) {
          progress.onFile(chunk);
        }

        if (resultLimit > 0 && sliceStart + slicedMatches.length < fileMatch.matches.length) {
          truncated = true;
          return;
        }
        if (resultLimit > 0 && totalMatches >= resultLimit) {
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

function scanText(
  text: string,
  regex: RegExp,
  uri: vscode.Uri,
  allowMultiline = false,
  maxMatchLines = 0,
): FileMatch {
  const rel = vscode.workspace.asRelativePath(uri, false);
  const result: FileMatch = { uri: uri.toString(), relPath: rel, matches: [] };
  if (allowMultiline) {
    return scanTextMultiline(text, regex, result, maxMatchLines);
  }

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
          if (maxMatchLines > 0 && result.matches.length >= maxMatchLines) {
            return result;
          }
        }
      }
      lineStart = i + 1;
      lineNo++;
    }
  }
  return result;
}

function scanTextMultiline(text: string, regex: RegExp, result: FileMatch, maxMatchLines = 0): FileMatch {
  const lineStarts = buildLineStarts(text);
  regex.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const startOffset = m.index;
    const endOffset = startOffset + m[0].length;
    const startLine = lineIndexForOffset(lineStarts, startOffset);
    const endLookupOffset = endOffset > startOffset ? endOffset - 1 : endOffset;
    const endLine = lineIndexForOffset(lineStarts, endLookupOffset);
    const startLineOffset = lineStarts[startLine];
    const endLineOffset = lineStarts[endLine];
    const previewLine = readLineAt(text, startLineOffset);
    const startCol = Math.max(0, startOffset - startLineOffset);
    const endCol = Math.max(0, endOffset - endLineOffset);
    const rawRange: MatchRange = startLine === endLine
      ? { start: startCol, end: endCol }
      : { start: startCol, end: previewLine.length, endLine, endCol };
    const clipped = clipLine(previewLine, {
      start: Math.min(rawRange.start, previewLine.length),
      end: Math.min(rawRange.end, previewLine.length),
    });
    const range = clipped.ranges[0];
    result.matches.push({
      line: startLine,
      preview: clipped.preview,
      ranges: [typeof rawRange.endLine === 'number'
        ? { start: range.start, end: range.end, endLine: rawRange.endLine, endCol: rawRange.endCol }
        : range],
    });
    if (maxMatchLines > 0 && result.matches.length >= maxMatchLines) {
      return result;
    }
    if (m[0].length === 0) { regex.lastIndex++; }
  }

  return result;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { starts.push(i + 1); }
  }
  return starts;
}

function lineIndexForOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = lineStarts[mid];
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (offset < start) { hi = mid - 1; }
    else if (offset >= next) { lo = mid + 1; }
    else { return mid; }
  }
  return Math.max(0, Math.min(lineStarts.length - 1, lo));
}

function readLineAt(text: string, start: number): string {
  let end = text.indexOf('\n', start);
  if (end < 0) { end = text.length; }
  if (end > start && text.charCodeAt(end - 1) === 13) { end--; }
  return text.slice(start, end);
}
