import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SearchOptions, SearchProgress, FileMatch, MatchRange } from './search';

// ──────────────────────────────────────────────────────────────────────────
// Ripgrep-backed search engine.
//
// VSCode ships its own ripgrep binary under @vscode/ripgrep. We borrow it to
// get ripgrep-grade speed and accuracy — byte-for-byte parity with VSCode's
// built-in "Find in Files" engine, since that uses the same rg.
//
// We invoke rg with --json so results stream as one-object-per-line. Each
// file's matches are buffered until we see its "end" message, then emitted
// as a FileMatch. The process can be cancelled by killing the child.
// ──────────────────────────────────────────────────────────────────────────

let cachedRgPath: string | null | undefined;

/** Locate VSCode's bundled rg. Checks the runtime env first (any extension
 * host implicitly sits inside an install), then common install paths. */
export function findRipgrepPath(): string | null {
  if (cachedRgPath !== undefined) { return cachedRgPath; }
  const candidates: string[] = [];
  // process.execPath points at the Electron binary; rg lives alongside the
  // app's node_modules. Walk up from execPath to find the Resources/app dir.
  const execPath = process.execPath;
  let cur = path.dirname(execPath);
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(cur, 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
    candidates.push(path.join(cur, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
    candidates.push(path.join(cur, 'Resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg'));
    cur = path.dirname(cur);
  }
  // macOS default install
  candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg');
  candidates.push('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg');
  // Linux Snap / deb
  candidates.push('/usr/share/code/resources/app/node_modules/@vscode/ripgrep/bin/rg');
  candidates.push('/usr/share/code-insiders/resources/app/node_modules/@vscode/ripgrep/bin/rg');
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { cachedRgPath = p; return p; }
    } catch {}
  }
  cachedRgPath = null;
  return null;
}

interface RgBegin { type: 'begin'; data: { path: { text: string } } }
interface RgMatch {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
    absolute_offset: number;
    submatches: Array<{ start: number; end: number; match: { text?: string } }>;
  };
}
interface RgEnd { type: 'end'; data: { path: { text: string } } }
type RgEvent = RgBegin | RgMatch | RgEnd | { type: 'summary'; data: unknown } | { type: 'context'; data: unknown };

const MAX_LINE_PREVIEW = 400;

function clipLine(line: string, range: MatchRange): { preview: string; ranges: MatchRange[] } {
  if (line.length <= MAX_LINE_PREVIEW) {
    return { preview: line, ranges: [range] };
  }
  const matchLen = range.end - range.start;
  const before = Math.max(0, Math.floor((MAX_LINE_PREVIEW - matchLen) / 2));
  const start = Math.max(0, range.start - before);
  const end = Math.min(line.length, start + MAX_LINE_PREVIEW);
  const prefix = start > 0 ? '\u2026' : '';
  const suffix = end < line.length ? '\u2026' : '';
  const preview = prefix + line.slice(start, end) + suffix;
  const newStart = range.start - start + prefix.length;
  return {
    preview,
    ranges: [{ start: newStart, end: newStart + matchLen }],
  };
}

export async function runRgSearch(
  opts: SearchOptions,
  token: vscode.CancellationToken,
  progress: SearchProgress,
  candidateFiles?: string[] | null,
): Promise<void> {
  const rgPath = findRipgrepPath();
  if (!rgPath) {
    progress.onError(new Error('ripgrep binary not found'));
    return;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
    return;
  }

  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  const excludeGlobs = cfg.get<string[]>('excludeGlobs', []);
  const maxFileSize = cfg.get<number>('maxFileSize', 1_048_576);
  const maxResults = cfg.get<number>('maxResults', 2000);

  const isMultiline = opts.query.includes('\n');
  const args: string[] = [
    '--json',
    '--hidden',
    '--no-messages',
    '--max-filesize', String(maxFileSize) + 'B',
    '--max-columns', '4096',
    '--max-columns-preview',
    '--no-ignore-parent',
  ];
  if (isMultiline) { args.push('-U'); }
  if (opts.useRegex) { /* default: regex mode */ }
  else { args.push('--fixed-strings'); }
  if (opts.caseSensitive) { args.push('--case-sensitive'); }
  else { args.push('--ignore-case'); }
  if (opts.wholeWord) { args.push('--word-regexp'); }
  if (candidateFiles && candidateFiles.length > 0) {
    // Index narrowed the search to a candidate file list. Feed it via
    // stdin with --files-from=- and skip the workspace walk entirely.
    args.push('--files-from=-');
  } else {
    // ripgrep --glob with '!' prefix is exclusion. Convert **/foo/** style
    // globs to ripgrep's format (which is the same glob syntax).
    for (const g of excludeGlobs) { args.push('--glob', '!' + g); }
  }
  args.push('-e', opts.query);
  if (!candidateFiles || candidateFiles.length === 0) {
    // Search each workspace folder.
    for (const f of folders) { args.push('--', f.uri.fsPath); }
  }

  let totalMatches = 0;
  let totalFiles = 0;
  let truncated = false;
  let killed = false;

  const wantStdin = !!(candidateFiles && candidateFiles.length > 0);
  const child: ChildProcess = spawn(rgPath, args, {
    cwd: folders[0].uri.fsPath,
    env: { ...process.env },
    stdio: [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (wantStdin && child.stdin) {
    // Feed candidate paths, one per line. Use fsPaths; rg resolves them
    // relative to cwd or as absolute.
    child.stdin.on('error', () => { /* EPIPE if rg exits early */ });
    for (const p of candidateFiles!) { child.stdin.write(p + '\n'); }
    child.stdin.end();
  }

  const cancelHandler = token.onCancellationRequested(() => {
    killed = true;
    try { child.kill('SIGTERM'); } catch {}
  });

  let stdoutBuf = '';

  let pendingFile: {
    uri: string;
    relPath: string;
    fsPath: string;
    matches: FileMatch['matches'];
  } | null = null;

  function flushFile() {
    if (pendingFile && pendingFile.matches.length > 0) {
      progress.onFile({ uri: pendingFile.uri, relPath: pendingFile.relPath, matches: pendingFile.matches });
      totalFiles++;
    }
    pendingFile = null;
  }

  function handleEvent(evt: RgEvent) {
    if (truncated || killed) { return; }
    switch (evt.type) {
      case 'begin': {
        const fsPath = evt.data.path.text;
        const uri = vscode.Uri.file(fsPath);
        pendingFile = {
          uri: uri.toString(),
          relPath: vscode.workspace.asRelativePath(uri, false),
          fsPath,
          matches: [],
        };
        break;
      }
      case 'match': {
        if (!pendingFile) { break; }
        const m = evt.data;
        const line = m.lines.text ?? decodeBase64(m.lines.bytes);
        if (line === null) { break; }
        // Trim trailing newline(s).
        let lineText = line;
        if (lineText.endsWith('\n')) { lineText = lineText.slice(0, -1); }
        if (lineText.endsWith('\r')) { lineText = lineText.slice(0, -1); }
        // rg submatch offsets are byte offsets into the line. Convert to
        // string char offsets for the renderer. For ASCII lines they match;
        // for multi-byte lines we recompute by walking the buffer.
        const isAscii = isAsciiOnly(lineText);
        const ranges: MatchRange[] = [];
        for (const sm of m.submatches) {
          if (isAscii) {
            ranges.push({ start: sm.start, end: sm.end });
          } else {
            const { startChar, endChar } = byteRangeToChar(lineText, sm.start, sm.end);
            ranges.push({ start: startChar, end: endChar });
          }
        }
        // Multi-line matches produce a single 'match' event with line_number
        // pointing at first match line. Preview the first line only; renderer
        // fetches surrounding lines on demand.
        const firstLineEnd = lineText.indexOf('\n');
        const displayLine = firstLineEnd >= 0 ? lineText.slice(0, firstLineEnd) : lineText;
        const firstRange = ranges[0];
        if (firstRange) {
          const clipped = clipLine(displayLine, {
            start: Math.min(firstRange.start, displayLine.length),
            end: Math.min(firstRange.end, displayLine.length),
          });
          // Clamp additional ranges to the single-line preview window.
          pendingFile.matches.push({
            line: Math.max(0, m.line_number - 1),
            preview: clipped.preview,
            ranges: clipped.ranges,
          });
          totalMatches += 1;
          if (totalMatches >= maxResults) {
            truncated = true;
            try { child.kill('SIGTERM'); } catch {}
          }
        }
        break;
      }
      case 'end': {
        flushFile();
        break;
      }
    }
  }

  child.stdout!.setEncoding('utf-8');
  child.stdout!.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) { continue; }
      try { handleEvent(JSON.parse(line) as RgEvent); } catch {}
    }
  });
  // Silence stderr (rg surfaces IO warnings etc. that aren't useful to us).
  child.stderr!.on('data', () => {});

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', (err) => {
      progress.onError(err);
      resolve();
    });
  });
  cancelHandler.dispose();

  // Final flush (rg sends 'end' per file but last file may not if killed).
  flushFile();
  progress.onDone({ totalFiles, totalMatches, truncated });
}

function isAsciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) { return false; }
  }
  return true;
}

function byteRangeToChar(line: string, byteStart: number, byteEnd: number): { startChar: number; endChar: number } {
  let byteIdx = 0;
  let startChar = 0;
  let endChar = line.length;
  for (let i = 0; i < line.length; i++) {
    if (byteIdx === byteStart) { startChar = i; }
    if (byteIdx === byteEnd) { endChar = i; break; }
    byteIdx += utf8ByteLen(line.charCodeAt(i));
  }
  if (byteIdx === byteEnd) { endChar = line.length; }
  return { startChar, endChar };
}

function utf8ByteLen(code: number): number {
  if (code < 0x80) { return 1; }
  if (code < 0x800) { return 2; }
  if (code >= 0xd800 && code <= 0xdbff) { return 4; }
  return 3;
}

function decodeBase64(b64: string | undefined): string | null {
  if (!b64) { return null; }
  try { return Buffer.from(b64, 'base64').toString('utf-8'); }
  catch { return null; }
}
