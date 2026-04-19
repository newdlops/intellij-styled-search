import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import {
  SearchOptions,
  SearchProgress,
  FileMatch,
  MatchRange,
  getRequestedResultLimit,
  getRequestedResultOffset,
  FILE_MATCH_CHUNK_MATCH_LIMIT,
  FILE_MATCH_CHUNK_CHAR_LIMIT,
} from './search';
import { compileIncludeMatcher, toRipgrepGlobs } from './pathScope';

// ──────────────────────────────────────────────────────────────────────────
// Ripgrep-backed search engine.
//
// Prefer a ripgrep binary installed into this extension's globalStorage on
// first activation. Fall back to VSCode's own @vscode/ripgrep while that
// install is unavailable, unsupported, or still in progress.
//
// We invoke rg with --json so results stream as one-object-per-line. Each
// file's matches are buffered until we see its "end" message, then emitted
// as a FileMatch. The process can be cancelled by killing the child.
// ──────────────────────────────────────────────────────────────────────────

const RIPGREP_VERSION = 'v15.0.1';
const RIPGREP_PREBUILT_REPO = 'microsoft/ripgrep-prebuilt';

type RipgrepArchiveExt = 'tar.gz' | 'zip';
type RipgrepTarget = {
  key: string;
  triple: string;
  archiveExt: RipgrepArchiveExt;
  exe: 'rg' | 'rg.exe';
};

let cachedRgPath: string | null | undefined;
let rgInstallRoot: string | undefined;
let installPromise: Promise<string | null> | undefined;
let installAttempted = false;

export function configureRipgrepInstall(context: vscode.ExtensionContext): void {
  rgInstallRoot = path.join(context.globalStorageUri.fsPath, 'ripgrep', RIPGREP_VERSION);
  cachedRgPath = undefined;
}

function getRipgrepTarget(): RipgrepTarget | null {
  switch (process.platform) {
    case 'darwin':
      if (process.arch === 'x64') {
        return { key: 'darwin-x64', triple: 'x86_64-apple-darwin', archiveExt: 'tar.gz', exe: 'rg' };
      }
      if (process.arch === 'arm64') {
        return { key: 'darwin-arm64', triple: 'aarch64-apple-darwin', archiveExt: 'tar.gz', exe: 'rg' };
      }
      return null;
    case 'win32':
      if (process.arch === 'x64') {
        return { key: 'win32-x64', triple: 'x86_64-pc-windows-msvc', archiveExt: 'zip', exe: 'rg.exe' };
      }
      if (process.arch === 'arm64') {
        return { key: 'win32-arm64', triple: 'aarch64-pc-windows-msvc', archiveExt: 'zip', exe: 'rg.exe' };
      }
      if (process.arch === 'ia32') {
        return { key: 'win32-ia32', triple: 'i686-pc-windows-msvc', archiveExt: 'zip', exe: 'rg.exe' };
      }
      return null;
    case 'linux':
      if (process.arch === 'x64') {
        return { key: 'linux-x64', triple: 'x86_64-unknown-linux-musl', archiveExt: 'tar.gz', exe: 'rg' };
      }
      if (process.arch === 'arm64') {
        return { key: 'linux-arm64', triple: 'aarch64-unknown-linux-musl', archiveExt: 'tar.gz', exe: 'rg' };
      }
      return null;
    default:
      return null;
  }
}

function ripgrepReleaseUrl(target: RipgrepTarget): string {
  const asset = `ripgrep-${RIPGREP_VERSION}-${target.triple}.${target.archiveExt}`;
  return `https://github.com/${RIPGREP_PREBUILT_REPO}/releases/download/${RIPGREP_VERSION}/${asset}`;
}

function findInstalledRipgrepPath(): string | null {
  if (!rgInstallRoot) { return null; }
  const target = getRipgrepTarget();
  if (!target) { return null; }
  const candidate = path.join(rgInstallRoot, target.key, target.exe);
  try {
    if (fs.existsSync(candidate)) { return candidate; }
  } catch {}
  return null;
}

export async function ensureRipgrepInstalled(logger?: (msg: string) => void): Promise<string | null> {
  const existing = findInstalledRipgrepPath();
  if (existing) { return existing; }
  if (!rgInstallRoot) { return null; }
  const target = getRipgrepTarget();
  if (!target) {
    logger?.(`ripgrep install skipped: unsupported platform ${process.platform}-${process.arch}`);
    return null;
  }
  if (installPromise) { return installPromise; }
  if (installAttempted) { return null; }
  installAttempted = true;
  installPromise = installRipgrep(target, logger).catch((err) => {
    logger?.(`ripgrep install failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  return installPromise;
}

async function installRipgrep(target: RipgrepTarget, logger?: (msg: string) => void): Promise<string> {
  if (!rgInstallRoot) { throw new Error('ripgrep install root is not configured'); }
  const outDir = path.join(rgInstallRoot, target.key);
  const outBin = path.join(outDir, target.exe);
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ij-search-rg-${target.key}-`));
  const archivePath = path.join(tmpRoot, `ripgrep-${RIPGREP_VERSION}-${target.triple}.${target.archiveExt}`);
  const extractDir = path.join(tmpRoot, 'extract');

  try {
    const url = ripgrepReleaseUrl(target);
    logger?.(`ripgrep install: downloading ${url}`);
    await downloadFile(url, archivePath);
    await extractArchive(archivePath, extractDir, target);
    const extracted = await findFileByName(extractDir, target.exe);
    if (!extracted) {
      throw new Error(`downloaded archive did not contain ${target.exe}`);
    }

    await fs.promises.rm(outDir, { recursive: true, force: true });
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.copyFile(extracted, outBin);
    if (target.exe === 'rg') {
      await fs.promises.chmod(outBin, 0o755);
    }
    await fs.promises.writeFile(
      path.join(rgInstallRoot, 'install.json'),
      JSON.stringify({
        tool: 'ripgrep',
        version: RIPGREP_VERSION,
        target: target.key,
        triple: target.triple,
        binary: path.relative(rgInstallRoot, outBin),
        source: `https://github.com/${RIPGREP_PREBUILT_REPO}`,
        installedAt: new Date().toISOString(),
      }, null, 2) + '\n',
    );
    cachedRgPath = outBin;
    logger?.(`ripgrep install: ready at ${outBin}`);
    return outBin;
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

function downloadFile(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 8) {
    return Promise.reject(new Error(`too many redirects for ${url}`));
  }
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'user-agent': 'intellij-styled-search' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        out.close(() => {
          fs.rm(dest, { force: true }, () => {
            const next = new URL(res.headers.location!, url).toString();
            downloadFile(next, dest, redirects + 1).then(resolve, reject);
          });
        });
        return;
      }
      if (status !== 200) {
        res.resume();
        out.close(() => {
          fs.rm(dest, { force: true }, () => reject(new Error(`download failed with HTTP ${status}`)));
        });
        return;
      }
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
    });
    req.on('error', (err) => {
      out.close(() => {
        fs.rm(dest, { force: true }, () => reject(err));
      });
    });
  });
}

async function extractArchive(archivePath: string, destDir: string, target: RipgrepTarget): Promise<void> {
  await fs.promises.rm(destDir, { recursive: true, force: true });
  await fs.promises.mkdir(destDir, { recursive: true });
  try {
    if (target.archiveExt === 'zip') {
      await runProcess('tar', ['-xf', archivePath, '-C', destDir]);
    } else {
      await runProcess('tar', ['-xzf', archivePath, '-C', destDir]);
    }
  } catch (err) {
    if (process.platform !== 'win32' || target.archiveExt !== 'zip') { throw err; }
    const command = `Expand-Archive -LiteralPath ${powerShellQuote(archivePath)} -DestinationPath ${powerShellQuote(destDir)} -Force`;
    await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
  }
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`${command} exited with ${code}`)); }
    });
  });
}

async function findFileByName(dir: string, basename: string): Promise<string | null> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === basename) { return full; }
    if (entry.isDirectory()) {
      const nested = await findFileByName(full, basename);
      if (nested) { return nested; }
    }
  }
  return null;
}

function powerShellQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Locate rg. Checks the configured install dir, then VSCode's bundled rg. */
export function findRipgrepPath(): string | null {
  if (cachedRgPath !== undefined) { return cachedRgPath; }
  const envPath = process.env.INTELLIJ_STYLED_SEARCH_RG_PATH;
  if (envPath) {
    try {
      if (fs.existsSync(envPath)) { cachedRgPath = envPath; return envPath; }
    } catch {}
  }
  const installed = findInstalledRipgrepPath();
  if (installed) { cachedRgPath = installed; return installed; }
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

function estimateBufferedMatchSize(match: FileMatch['matches'][number]): number {
  return (match.preview?.length ?? 0) + (match.ranges?.length ?? 0) * 48 + 64;
}

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
  logger?: (msg: string) => void,
): Promise<void> {
  let rgPath = findRipgrepPath();
  if (!rgPath) {
    await ensureRipgrepInstalled(logger);
    rgPath = findRipgrepPath();
  }
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
  const resultLimit = getRequestedResultLimit(opts, cfg);
  const resultOffset = getRequestedResultOffset(opts);
  const includeMatcher = compileIncludeMatcher(opts.includePatterns);
  const includeGlobs = toRipgrepGlobs(opts.includePatterns);

  const isMultiline = opts.query.includes('\n');
  const args: string[] = [
    '--json',
    '--hidden',
    '--no-messages',
    // CAUTION: rg accepts K/M/G suffix only. Passing '1048576B' makes rg
    // bail with "invalid numeric value" and exit silently — which was
    // manifesting as all searches returning 0 matches in ~7ms while
    // claiming success, because --no-messages suppressed the error.
    '--max-filesize', String(maxFileSize),
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
  // macOS/Linux ARG_MAX is typically ~1MB. With ~80 bytes per path and some
  // headroom for other args, 5000 paths is a safe ceiling before `spawn`
  // would start erroring with E2BIG.
  const MAX_POSITIONAL = 5000;
  const narrowedFiles = candidateFiles && includeMatcher
    ? candidateFiles.filter((fsPath) => includeMatcher(vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), false)))
    : candidateFiles;
  if (candidateFiles && narrowedFiles && narrowedFiles.length === 0) {
    progress.onDone({ totalFiles: 0, totalMatches: 0, truncated: false });
    return;
  }
  const useNarrowing = !!(narrowedFiles && narrowedFiles.length > 0 && narrowedFiles.length <= MAX_POSITIONAL);
  // Always disable rg's gitignore handling: our trigram index indexes every
  // non-binary file (including .venv, node_modules, site-packages). If rg
  // were allowed to respect .gitignore, narrowed queries would silently
  // drop those files, and full-scan fallbacks would hide them from users
  // who cleared excludeGlobs specifically to reach them. The user's
  // excludeGlobs setting is the sole source of truth for exclusions.
  args.push('--no-ignore');
  if (!useNarrowing) {
    for (const g of includeGlobs) { args.push('--glob', g); }
    // ripgrep --glob with '!' prefix is exclusion. Convert **/foo/** style
    // globs to ripgrep's format (which is the same glob syntax).
    for (const g of excludeGlobs) { args.push('--glob', '!' + g); }
  }
  args.push('-e', opts.query);
  if (useNarrowing) {
    // Pass files as positional args after `--`. We previously used
    // `--files-from=-` (stdin) and `--files-from <file>` (tmp file), but
    // the bundled @vscode/ripgrep on some installs doesn't recognise
    // `--files-from` at all (rg exits 2: "unrecognized flag"), which was
    // showing up as silent 0-match results for every narrowed query.
    args.push('--');
    for (const p of narrowedFiles!) { args.push(p); }
  } else {
    // Search each workspace folder.
    for (const f of folders) { args.push('--', f.uri.fsPath); }
  }

  let totalMatches = 0;
  let totalFiles = 0;
  let truncated = false;
  let killed = false;
  let skippedMatches = 0;

  if (logger) {
    // Rebuild a shell-quoted command for manual reproduction in a terminal.
    // For narrowed queries the command includes every candidate path, so
    // trim the logged line at ~2KB — enough to see the flags without
    // flooding the output channel with thousands of paths.
    const quoted = args.map((a) => (/[\s"'\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ');
    const shown = quoted.length > 2048 ? quoted.slice(0, 2048) + ` … (${quoted.length} chars total)` : quoted;
    logger(
      `rg exec: cwd=${folders[0].uri.fsPath} narrow=${useNarrowing ? narrowedFiles!.length + 'paths' : 'none'} args: ${shown}`,
    );
  }
  const child: ChildProcess = spawn(rgPath, args, {
    cwd: folders[0].uri.fsPath,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    approxChars: number;
    emitted: boolean;
  } | null = null;

  function flushFile(final = false) {
    if (!pendingFile) { return; }
    if (pendingFile.matches.length > 0) {
      progress.onFile({ uri: pendingFile.uri, relPath: pendingFile.relPath, matches: pendingFile.matches });
      pendingFile.matches = [];
      pendingFile.approxChars = 0;
      if (!pendingFile.emitted) {
        totalFiles++;
        pendingFile.emitted = true;
      }
    }
    if (final) { pendingFile = null; }
  }

  function handleEvent(evt: RgEvent) {
    if (truncated || killed) { return; }
    switch (evt.type) {
      case 'begin': {
        flushFile(true);
        const fsPath = evt.data.path.text;
        const uri = vscode.Uri.file(fsPath);
        pendingFile = {
          uri: uri.toString(),
          relPath: vscode.workspace.asRelativePath(uri, false),
          fsPath,
          matches: [],
          approxChars: 0,
          emitted: false,
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
        const startLine = Math.max(0, m.line_number - 1);
        const isAscii = isAsciiOnly(lineText);
        const isMulti = lineText.indexOf('\n') >= 0;
        // Convert each submatch's byte range to (line, col) endpoints so
        // multi-line literal matches (rg -U --fixed-strings) carry their
        // full span into the preview highlighter, not just the first line.
        const splitLines = isMulti ? lineText.split('\n') : [lineText];
        const ranges: MatchRange[] = [];
        for (const sm of m.submatches) {
          let subStart: number, subEnd: number;
          if (isAscii) { subStart = sm.start; subEnd = sm.end; }
          else {
            const { startChar, endChar } = byteRangeToChar(lineText, sm.start, sm.end);
            subStart = startChar;
            subEnd = endChar;
          }
          if (!isMulti) {
            ranges.push({ start: subStart, end: subEnd });
            continue;
          }
          // Walk split lines to find which one subStart / subEnd fall on.
          let cursor = 0;
          let smStartLine = startLine, smStartCol = 0;
          let smEndLine = startLine, smEndCol = 0;
          for (let li = 0; li < splitLines.length; li++) {
            const lStart = cursor;
            const lEnd = cursor + splitLines[li].length;
            if (subStart >= lStart && subStart <= lEnd) {
              smStartLine = startLine + li;
              smStartCol = subStart - lStart;
            }
            if (subEnd >= lStart && subEnd <= lEnd) {
              smEndLine = startLine + li;
              smEndCol = subEnd - lStart;
              break;
            }
            cursor = lEnd + 1; // +1 for the \n between split lines
          }
          if (smStartLine === smEndLine) {
            ranges.push({ start: smStartCol, end: smEndCol });
          } else {
            // Range spans from (smStartLine, smStartCol) to (smEndLine, smEndCol).
            // `start`/`end` describe the first-line portion (for the result
            // list's inline highlight); endLine/endCol carry the full span
            // so the preview Monaco decoration covers every line.
            const firstLineIdx = smStartLine - startLine;
            const firstLineLen = splitLines[firstLineIdx].length;
            ranges.push({
              start: smStartCol,
              end: firstLineLen,
              endLine: smEndLine,
              endCol: smEndCol,
            });
          }
        }
        // Preview the first line only in the result list; renderer fetches
        // surrounding lines on demand.
        const displayLine = splitLines[0];
        const firstRange = ranges[0];
        if (firstRange) {
          const clipped = clipLine(displayLine, {
            start: Math.min(firstRange.start, displayLine.length),
            end: Math.min(firstRange.end, displayLine.length),
          });
          // Preserve endLine/endCol from the original range so Monaco
          // decoration spans every line of the match. clipLine only
          // reshapes start/end for the clipped preview string.
          const outRanges: MatchRange[] = clipped.ranges.map((r, i) => {
            const src = ranges[i] ?? firstRange;
            if (typeof src.endLine === 'number') {
              return { start: r.start, end: r.end, endLine: src.endLine, endCol: src.endCol };
            }
            return r;
          });
          const outMatch = {
            line: startLine,
            preview: clipped.preview,
            ranges: outRanges,
          };
          if (resultOffset > skippedMatches) {
            skippedMatches++;
            break;
          }
          pendingFile.matches.push(outMatch);
          pendingFile.approxChars += estimateBufferedMatchSize(outMatch);
          totalMatches += 1;
          if (
            pendingFile.matches.length >= FILE_MATCH_CHUNK_MATCH_LIMIT ||
            pendingFile.approxChars >= FILE_MATCH_CHUNK_CHAR_LIMIT
          ) {
            flushFile(false);
          }
          if (resultLimit > 0 && totalMatches >= resultLimit) {
            truncated = true;
            flushFile(false);
            try { child.kill('SIGTERM'); } catch {}
          }
        }
        break;
      }
      case 'end': {
        flushFile(true);
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
  // Capture stderr so we can surface fatal argument errors (e.g., unknown
  // flag, bad --max-filesize) that rg writes before exiting. Without this
  // the parent just sees 0 matches and can't tell scrape-failed from
  // actually-no-matches.
  let stderrBuf = '';
  child.stderr!.setEncoding('utf-8');
  child.stderr!.on('data', (chunk: string) => {
    stderrBuf += chunk;
    if (stderrBuf.length > 4096) { stderrBuf = stderrBuf.slice(-4096); }
  });

  let exitCode: number | null = null;
  await new Promise<void>((resolve) => {
    child.on('close', (code) => { exitCode = code; resolve(); });
    child.on('error', (err) => {
      progress.onError(err);
      resolve();
    });
  });
  cancelHandler.dispose();

  // rg exits 0 on matches, 1 on no-matches-but-success, 2 on fatal error.
  if (logger) {
    const trimmed = stderrBuf.trim();
    logger(
      `rg exit: code=${exitCode}${trimmed ? ` stderr=${JSON.stringify(trimmed.slice(0, 300))}` : ''}`,
    );
  }
  // If we got a fatal exit and stderr has content, surface it so the user
  // knows rg rejected the arguments instead of quietly returning 0 hits.
  if ((exitCode === null || exitCode >= 2) && stderrBuf.trim().length > 0 && !killed) {
    progress.onError(new Error(`ripgrep: ${stderrBuf.trim().slice(0, 300)}`));
  }

  // Final flush (rg sends 'end' per file but last file may not if killed).
  flushFile(true);
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
