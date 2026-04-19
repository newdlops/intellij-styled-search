import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { parseRegex } from './codesearch/regexAst';
import { analyze } from './codesearch/regexInfo';
import { PostingSource, TrigramQuery, evalQuery, qAnd, qTri } from './codesearch/trigramQuery';
import { deserialize, serialize } from './codesearch/binaryIndex';

function u32ArrayContains(a: Uint32Array, id: number): boolean {
  // Binary search on sorted-ascending Uint32Array.
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = a[mid];
    if (v === id) { return true; }
    if (v < id) { lo = mid + 1; } else { hi = mid; }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────
// Trigram inverted index for workspace-wide text search.
//
// For each file we extract every unique 3-character lowercase trigram and
// maintain  trigram -> Set<fileId>.  A query of length ≥ 3 is decomposed
// into its own trigrams; the intersection of each trigram's fileId set is
// the candidate pool — typically a tiny fraction of the workspace. The
// scanner then only reads those candidates for the actual match, so search
// time is O(hits) instead of O(workspace).
//
// The index is persisted as JSON to globalStorageUri per workspace and
// incrementally refreshed: on activation we compare mtimes, on file change
// the watcher reindexes the single file. Short queries (<3 chars) and
// regex queries fall back to a full scan.
// ──────────────────────────────────────────────────────────────────────────

// NOTE: previously we dropped files with >30K unique trigrams and pruned
// trigrams that appeared in >30% of files. Both caused false negatives — a
// pruned trigram forced the query planner to over-filter ("file doesn't
// have this tri → exclude") even when the trigram was deliberately unindexed.
// Cox's codesearch tolerates fat indexes; we keep everything.

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.o', '.a',
  '.wasm', '.node',
]);

interface FileMeta { uri: string; mtime: number; size: number }

export interface ReconcileProgress {
  /** Called periodically during reconcile with `{indexed, total}` counts so
   *  callers (e.g., the Rebuild Index command) can update a progress UI. */
  report(stage: string, current: number, total: number): void;
}

export class TrigramIndex {
  // Posting lists: Uint32Array (sorted ascending) after load, or Set<number>
  // while we're mutating (indexFile add/remove). save() compacts everything
  // back to Uint32Array before writing.
  private tris = new Map<string, Set<number> | Uint32Array>();
  private fileMeta = new Map<number, FileMeta>();
  private uriToId = new Map<string, number>();
  // File ids whose disk content may disagree with the trigrams we have for
  // them: either reconcile has them queued for reindex (mtime changed), or
  // indexFile is mid-update right now. Searches must UNION this set into the
  // candidate pool so rg can still verify the file against current disk —
  // without it, queries for the new content miss because the index still
  // carries the old trigrams.
  private stale = new Set<number>();
  private nextId = 1;
  private dirty = false;
  private ready = false;
  private initPromise: Promise<void> | undefined;
  private rebuildPromise: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {}

  get isReady(): boolean { return this.ready; }
  get size(): number { return this.fileMeta.size; }

  /** Diagnose whether a specific file is in the index and which of the
   *  provided trigrams are missing from its posting lists. Used by the
   *  "Diagnose File in Index" command to explain why a known-good literal
   *  is missing from candidate results. */
  diagnoseFile(uri: string, probeTrigrams: Iterable<string>): {
    inIndex: boolean;
    fileId?: number;
    missingFromFile: string[];     // trigrams we checked that file was NOT listed in
    presentInFile: number;          // count of trigrams we checked that file WAS listed in
    totalChecked: number;
    mtime?: number;
    size?: number;
  } {
    const id = this.uriToId.get(uri);
    if (id === undefined) {
      return { inIndex: false, missingFromFile: [], presentInFile: 0, totalChecked: 0 };
    }
    const meta = this.fileMeta.get(id);
    let totalChecked = 0;
    let presentInFile = 0;
    const missingFromFile: string[] = [];
    for (const tri of probeTrigrams) {
      totalChecked++;
      const posting = this.tris.get(tri);
      if (!posting) {
        missingFromFile.push(tri);
        continue;
      }
      let has = false;
      if (posting instanceof Uint32Array) {
        has = u32ArrayContains(posting, id);
      } else {
        has = posting.has(id);
      }
      if (has) { presentInFile++; }
      else {
        if (missingFromFile.length < 20) { missingFromFile.push(tri); }
      }
    }
    return {
      inIndex: true,
      fileId: id,
      missingFromFile,
      presentInFile,
      totalChecked,
      mtime: meta?.mtime,
      size: meta?.size,
    };
  }

  async init(): Promise<void> {
    if (!this.initPromise) { this.initPromise = this.doInit(); }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(this.storageDir); } catch {}
    await this.load();
    // Mark ready AS SOON AS the disk image is loaded — search can use the
    // ~accurate cached index immediately. Reconcile (mtime-based delta
    // refresh) continues in the background; new/changed files may miss
    // matches for a few seconds until it completes, which is fine.
    if (this.fileMeta.size > 0) {
      this.ready = true;
      this.log.appendLine(`TrigramIndex usable from disk (${this.fileMeta.size} files) — reconcile in bg`);
    }
    this.startWatcher();
    await this.reconcileWorkspace();
    this.ready = true;
    // reconcileWorkspace already called scheduleSave(5_000) if anything
    // changed; letting that run once is enough. Redundant immediate save
    // was doubling 100MB gzip work after every cold start.
    this.log.appendLine(`TrigramIndex fully ready: ${this.fileMeta.size} files, ${this.tris.size} trigrams`);
  }

  private indexFileName(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    const seed = folders.map((f) => f.uri.toString()).sort().join('|');
    const h = crypto.createHash('sha1').update(seed || 'empty').digest('hex').slice(0, 12);
    // v2 = binary layout defined in codesearch/binaryIndex.ts (no gzip, no
    // JSON). v1 was json.gz — left behind on disk; we simply ignore it.
    return `trigram-${h}.v2.bin`;
  }

  private async load(): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
    try {
      const tRead = Date.now();
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const tParse = Date.now();
      const image = deserialize(Buffer.from(bytes));
      const tDone = Date.now();
      if (!image) { return; }
      this.nextId = image.nextId || 1;
      this.fileMeta = image.fileMeta;
      this.uriToId = new Map();
      for (const [id, meta] of this.fileMeta) { this.uriToId.set(meta.uri, id); }
      // Posting lists stay as Uint32Array — no Set construction, no per-
      // trigram heap allocation. evalQuery operates directly on them.
      this.tris = new Map();
      for (const [tri, posting] of image.tris) {
        this.tris.set(tri, posting);
      }
      this.log.appendLine(
        `TrigramIndex loaded: ${this.fileMeta.size} files, ${this.tris.size} trigrams ` +
        `(read=${tParse - tRead}ms parse=${tDone - tParse}ms ` +
        `total=${tDone - tRead}ms, bin=${Math.round(bytes.length / 1024)}KB)`
      );
    } catch {
      // Fresh start
    }
  }

  private async save(): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
    // Compact all posting lists to Uint32Array (sorted) for on-disk form.
    // Sets left over from indexFile updates convert here. We yield every
    // ~15ms so CDP response processing (e.g., the first show() roundtrip
    // after reconcile) isn't held hostage for 300+ ms by this sync work.
    const compactTris = new Map<string, Uint32Array>();
    let checkpoint = Date.now();
    for (const [tri, posting] of this.tris) {
      if (posting instanceof Uint32Array) {
        compactTris.set(tri, posting);
      } else {
        const arr = new Uint32Array(posting.size);
        let k = 0;
        for (const id of posting) { arr[k++] = id; }
        arr.sort();
        compactTris.set(tri, arr);
        this.tris.set(tri, arr);
      }
      if (Date.now() - checkpoint > 15) {
        await new Promise<void>((r) => setImmediate(r));
        checkpoint = Date.now();
      }
    }
    try {
      const tSer = Date.now();
      // Serialize can still be multi-hundred-ms sync work. Do it in a
      // microtask boundary so at least there's one yield point before it.
      await new Promise<void>((r) => setImmediate(r));
      const buf = serialize({
        nextId: this.nextId,
        fileMeta: this.fileMeta,
        tris: compactTris,
      });
      const tWrite = Date.now();
      await vscode.workspace.fs.writeFile(fileUri, buf);
      this.dirty = false;
      this.log.appendLine(
        `TrigramIndex saved: ${Math.round(buf.length / 1024)} KB ` +
        `(trigrams ${compactTris.size}, files ${this.fileMeta.size}, ` +
        `serialize=${tWrite - tSer}ms write=${Date.now() - tWrite}ms)`,
      );
    } catch (err) {
      this.log.appendLine(`TrigramIndex save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private scheduleSave(delayMs = 30_000): void {
    this.dirty = true;
    if (this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, delayMs);
  }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.watcher) { this.watcher.dispose(); this.watcher = undefined; }
    if (this.dirty) { void this.save(); }
  }

  /** Wipe the in-memory index + disk cache and rebuild from scratch.
   *  Coalesces concurrent callers (double-pressed command, etc.) and waits
   *  for any in-flight initial init to settle before starting — otherwise
   *  the two reconcile passes fight for the same files. */
  async rebuild(progress?: ReconcileProgress): Promise<void> {
    if (this.rebuildPromise) { return this.rebuildPromise; }
    this.rebuildPromise = this.doRebuild(progress).finally(() => {
      this.rebuildPromise = undefined;
    });
    return this.rebuildPromise;
  }

  private async doRebuild(progress?: ReconcileProgress): Promise<void> {
    progress?.report('waiting for initial load', 0, 0);
    if (this.initPromise) {
      // Let the initial load finish its reconcile so we don't have two
      // concurrent 100K-file scans hammering the FS.
      try { await this.initPromise; } catch {}
    }
    // Cancel any pending save so it can't clobber the fresh build.
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    // Block reads during rebuild — callers get null candidates and fall
    // back to full rg scans until we're done.
    this.ready = false;
    this.tris.clear();
    this.fileMeta.clear();
    this.uriToId.clear();
    this.stale.clear();
    this.nextId = 1;
    this.dirty = false;
    try {
      const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
      await vscode.workspace.fs.delete(fileUri, { useTrash: false });
      this.log.appendLine(`TrigramIndex: deleted ${fileUri.fsPath}`);
    } catch {
      // ENOENT etc. — next save will write it either way.
    }
    this.log.appendLine('TrigramIndex: rebuilding from scratch...');
    await this.reconcileWorkspace(progress);
    this.ready = true;
    this.log.appendLine(
      `TrigramIndex rebuilt: ${this.fileMeta.size} files, ${this.tris.size} trigrams`,
    );
    progress?.report('saving', this.fileMeta.size, this.fileMeta.size);
    await this.save();
  }

  private getExcludePattern(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const globs = cfg.get<string[]>('excludeGlobs', []);
    return globs.length > 0 ? `{${globs.join(',')}}` : undefined;
  }

  private async reconcileWorkspace(progress?: ReconcileProgress): Promise<void> {
    const excludePattern = this.getExcludePattern();
    progress?.report('discovering files', 0, 0);
    // No maxResults cap: hitting an artificial limit causes boundary churn
    // (VSCode returns a different subset each session, so files near the cap
    // flap in/out of the index and force massive reindex work every run).
    // We rely on excludeGlobs + mtime delta to keep the working set sane.
    const files = await vscode.workspace.findFiles('**/*', excludePattern);
    const currentUris = new Set(files.map((u) => u.toString()));
    let removed = 0;
    for (const [id, meta] of Array.from(this.fileMeta)) {
      if (!currentUris.has(meta.uri)) {
        this.removeFileId(id);
        removed++;
      }
    }
    // Stat phase: pick mtime-changed files. When the index is empty (full
    // rebuild) every file is new, so we skip stat entirely — indexFile
    // does its own size/binary checks.
    const YIELD_EVERY = 500;
    let toIndex: vscode.Uri[];
    if (this.fileMeta.size === 0) {
      toIndex = files.slice();
      progress?.report('indexing', 0, toIndex.length);
    } else {
      toIndex = [];
      const statLimit = 32;
      let statIdx = 0;
      let statsSince = 0;
      progress?.report('stat-ing files', 0, files.length);
      const statWorkers: Promise<void>[] = [];
      for (let w = 0; w < statLimit; w++) {
        statWorkers.push((async () => {
          while (true) {
            const i = statIdx++;
            if (i >= files.length) { return; }
            const uri = files[i];
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.type === vscode.FileType.Directory) { continue; }
              const id = this.uriToId.get(uri.toString());
              if (id === undefined) { toIndex.push(uri); }
              else {
                const meta = this.fileMeta.get(id);
                if (!meta || meta.mtime !== stat.mtime) { toIndex.push(uri); }
              }
            } catch {}
            if (++statsSince >= YIELD_EVERY) {
              statsSince = 0;
              progress?.report('stat-ing files', i, files.length);
              await new Promise<void>((r) => setImmediate(r));
            }
          }
        })());
      }
      await Promise.all(statWorkers);
    }
    // Pre-mark any file whose mtime changed as stale BEFORE the index-phase
    // picks it up. The old posting lists still point at this id from the
    // previous session's content, so queries for the new content would miss
    // until indexFile runs. Stale keeps it in the candidate pool; rg verifies.
    for (const uri of toIndex) {
      const id = this.uriToId.get(uri.toString());
      if (id !== undefined) { this.stale.add(id); }
    }
    this.log.appendLine(
      `TrigramIndex reconcile: total=${files.length} reindex=${toIndex.length} removed=${removed} stale=${this.stale.size}`,
    );
    progress?.report('indexing', 0, toIndex.length);
    // Higher concurrency (16) than before — file I/O dominates, CPU
    // headroom is fine, and workspace-sized batches want the parallelism.
    const indexLimit = 16;
    const INDEX_YIELD_EVERY = 100;
    const PROGRESS_EVERY = 200;
    let indexIdx = 0;
    let indexed = 0;
    let indexedSince = 0;
    const indexWorkers: Promise<void>[] = [];
    for (let w = 0; w < indexLimit; w++) {
      indexWorkers.push((async () => {
        while (true) {
          const i = indexIdx++;
          if (i >= toIndex.length) { return; }
          try { await this.indexFile(toIndex[i]); } catch {}
          indexed++;
          if (++indexedSince >= INDEX_YIELD_EVERY) {
            indexedSince = 0;
            await new Promise<void>((r) => setImmediate(r));
          }
          if (progress && indexed % PROGRESS_EVERY === 0) {
            progress.report('indexing', indexed, toIndex.length);
          }
        }
      })());
    }
    await Promise.all(indexWorkers);
    progress?.report('indexing', toIndex.length, toIndex.length);
    if (toIndex.length > 0 || removed > 0) { this.scheduleSave(5_000); }
  }

  private startWatcher(): void {
    try {
      const w = vscode.workspace.createFileSystemWatcher('**/*');
      w.onDidCreate((uri) => { void this.indexFile(uri).then(() => this.scheduleSave()); });
      w.onDidChange((uri) => { void this.indexFile(uri).then(() => this.scheduleSave()); });
      w.onDidDelete((uri) => { this.removeByUri(uri.toString()); this.scheduleSave(); });
      this.watcher = w;
    } catch (err) {
      this.log.appendLine(`watcher setup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private removeByUri(uriStr: string): void {
    const id = this.uriToId.get(uriStr);
    if (id !== undefined) { this.removeFileId(id); }
  }

  /** Get the posting for `tri` as a mutable Set, converting the Uint32Array
   *  form on first write. Caller can then call .add/.delete directly. */
  private mutablePosting(tri: string): Set<number> {
    const existing = this.tris.get(tri);
    if (existing instanceof Set) { return existing; }
    if (existing instanceof Uint32Array) {
      const s = new Set<number>();
      for (let i = 0; i < existing.length; i++) { s.add(existing[i]); }
      this.tris.set(tri, s);
      return s;
    }
    const fresh = new Set<number>();
    this.tris.set(tri, fresh);
    return fresh;
  }

  private removeFileId(id: number): void {
    const meta = this.fileMeta.get(id);
    if (!meta) { return; }
    this.fileMeta.delete(id);
    this.uriToId.delete(meta.uri);
    this.stale.delete(id);
    // Remove fileId from any trigram set that contains it. Walk every tri;
    // for Uint32Array postings we only pay the Set conversion when the
    // file is actually present.
    for (const [tri, posting] of this.tris) {
      if (posting instanceof Uint32Array) {
        // Binary search — cheap presence check before converting.
        if (!u32ArrayContains(posting, id)) { continue; }
        const s = this.mutablePosting(tri);
        s.delete(id);
        if (s.size === 0) { this.tris.delete(tri); }
      } else {
        if (posting.delete(id) && posting.size === 0) { this.tris.delete(tri); }
      }
    }
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    const uriStr = uri.toString();
    // If the file is already known, ensure it's marked stale for the full
    // duration of this update. It might already be in `stale` from reconcile
    // pre-marking; the finally below clears it once new trigrams are in.
    const preexistingId = this.uriToId.get(uriStr);
    if (preexistingId !== undefined) { this.stale.add(preexistingId); }
    try {
      // Skip obvious non-text by extension / size.
      const ext = getExt(uri.fsPath);
      if (BINARY_EXT.has(ext)) { return; }
      let stat: vscode.FileStat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { return; }
      if (stat.type === vscode.FileType.Directory) { return; }
      const maxFileSize = vscode.workspace.getConfiguration('intellijStyledSearch').get<number>('maxFileSize', 1_048_576);
      if (stat.size > maxFileSize) {
        // Too big; treat as excluded.
        this.removeByUri(uriStr);
        return;
      }
      let bytes: Uint8Array;
      try { bytes = await vscode.workspace.fs.readFile(uri); } catch { return; }
      if (looksBinary(bytes)) { this.removeByUri(uriStr); return; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch { return; }

      // Allocate or reuse a fileId.
      let id = this.uriToId.get(uriStr);
      if (id === undefined) {
        id = this.nextId++;
        this.uriToId.set(uriStr, id);
      } else {
        // Remove the file's old trigrams before we add the new set.
        for (const [tri, posting] of this.tris) {
          if (posting instanceof Uint32Array) {
            if (!u32ArrayContains(posting, id)) { continue; }
            const s = this.mutablePosting(tri);
            s.delete(id);
            if (s.size === 0) { this.tris.delete(tri); }
          } else {
            if (posting.delete(id) && posting.size === 0) { this.tris.delete(tri); }
          }
        }
      }
      const uniq = extractTrigramsLower(text);
      this.fileMeta.set(id, { uri: uriStr, mtime: stat.mtime, size: stat.size });
      for (const tri of uniq) {
        this.mutablePosting(tri).add(id);
      }
    } finally {
      if (preexistingId !== undefined) { this.stale.delete(preexistingId); }
    }
  }

  // Public: get candidate URIs for a query. Returns null when the index
  // cannot usefully constrain (index not ready, planner has no info) — the
  // caller should fall back to a full scan in that case.
  //
  // For regex / multi-line queries we route through Cox's codesearch
  // planner: parse regex → RegexInfo → TrigramQuery → posting intersection.
  // For plain substring queries we take the fast AND-of-all-trigrams path.
  candidatesFor(
    query: string,
    opts: { useRegex: boolean; caseSensitive?: boolean; wholeWord?: boolean },
  ): { uris: Set<string> | null; reason: string } {
    if (!this.ready) {
      return { uris: null, reason: 'index-not-ready' };
    }
    if (query.length === 0) {
      return { uris: null, reason: 'empty-query' };
    }

    // Non-regex, non-whole-word: literal search. Even multi-line literal
    // queries just need "every file must contain every trigram" — Cox's
    // planner is for REGEX analysis. Running the planner on a 174-char
    // multi-line paste costs ~500 ms per keystroke (64×64 suffix×prefix
    // combos feed trigramsOf thousands of times); fast-path is ~5 ms.
    if (!opts.useRegex && !opts.wholeWord) {
      if (query.length < 3) {
        return { uris: null, reason: `query-too-short(${query.length})` };
      }
      const qtris = extractTrigramsLower(query);
      if (qtris.size === 0) {
        return { uris: null, reason: 'no-extractable-trigrams' };
      }
      const out = this.intersectTrigrams(qtris);
      const multi = query.includes('\n') ? ',multi' : '';
      const staleAdded = this.unionStaleInto(out);
      const staleStr = staleAdded > 0 ? `,stale=${staleAdded}` : '';
      // If we filtered everything out, the most likely culprit is a query
      // trigram the index doesn't have — surface up to 5 of them so the
      // user can see which byte sequence is the blocker.
      if (out.size === 0) {
        const missing: string[] = [];
        for (const t of qtris) {
          if (!this.tris.has(t)) {
            missing.push(JSON.stringify(t));
            if (missing.length >= 5) { break; }
          }
        }
        const missingStr = missing.length > 0
          ? `,missing=[${missing.join(',')}]`
          : ',all-trigrams-indexed-but-empty-intersection';
        return { uris: out, reason: `fast-path(trigrams=${qtris.size},indexSize=${this.fileMeta.size}${multi}${staleStr}${missingStr})` };
      }
      return { uris: out, reason: `fast-path(trigrams=${qtris.size},indexSize=${this.fileMeta.size}${multi}${staleStr})` };
    }

    // General path: build a regex-like AST from the query and let Cox's
    // analyzer decide what trigrams are required.
    let patternSrc: string;
    if (opts.useRegex) {
      patternSrc = query;
    } else {
      patternSrc = escapeRegexSource(query);
      if (opts.wholeWord) { patternSrc = '\\b' + patternSrc + '\\b'; }
    }
    const ast = parseRegex(patternSrc, {
      caseInsensitive: !opts.caseSensitive,
      dotAll: false,
      multiline: false,
    });
    const info = analyze(ast);
    const tq: TrigramQuery = info.match;
    const source: PostingSource = {
      get: (tri: string) => this.tris.get(tri) ?? null,
      allFiles: () => {
        const all = new Set<number>();
        for (const id of this.fileMeta.keys()) { all.add(id); }
        return all;
      },
    };
    const ids = evalQuery(tq, source);
    if (ids === null) {
      return { uris: null, reason: `planner-no-info(astKind=${ast.kind})` };
    }
    const out = new Set<string>();
    for (const id of ids) {
      const meta = this.fileMeta.get(id);
      if (meta) { out.add(meta.uri); }
    }
    const staleAdded = this.unionStaleInto(out);
    const staleStr = staleAdded > 0 ? `,stale=${staleAdded}` : '';
    return { uris: out, reason: `planner(astKind=${ast.kind},indexSize=${this.fileMeta.size}${staleStr})` };
  }

  /** Fold stale fileIds into the candidate URI set and return how many URIs
   *  were actually added (files already in `out` don't double-count). Stale
   *  files have an index entry whose posting lists may not reflect current
   *  disk content — always offering them to rg is the only way to guarantee
   *  the query's ground truth reaches the user mid-reconcile. */
  private unionStaleInto(out: Set<string>): number {
    if (this.stale.size === 0) { return 0; }
    let added = 0;
    for (const id of this.stale) {
      const meta = this.fileMeta.get(id);
      if (!meta) { continue; }
      if (!out.has(meta.uri)) {
        out.add(meta.uri);
        added++;
      }
    }
    return added;
  }

  private intersectTrigrams(qtris: Set<string>): Set<string> {
    const qList: TrigramQuery[] = [];
    for (const t of qtris) { qList.push(qTri(t)); }
    const tq = qAnd(qList);
    const source: PostingSource = {
      get: (tri: string) => this.tris.get(tri) ?? null,
      allFiles: () => {
        const all = new Set<number>();
        for (const id of this.fileMeta.keys()) { all.add(id); }
        return all;
      },
    };
    const ids = evalQuery(tq, source);
    if (ids === null) { return new Set(); }
    const out = new Set<string>();
    for (const id of ids) {
      const meta = this.fileMeta.get(id);
      if (meta) { out.add(meta.uri); }
    }
    return out;
  }
}

function escapeRegexSource(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getExt(fsPath: string): string {
  const i = fsPath.lastIndexOf('.');
  return i >= 0 ? fsPath.slice(i).toLowerCase() : '';
}

function looksBinary(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) { return true; }
  }
  return false;
}

export function extractTrigramsLower(text: string): Set<string> {
  // Lowercase in place via charCode for speed; this is an approximation that
  // handles ASCII well and remains serviceable for BMP Unicode.
  const out = new Set<string>();
  const len = text.length;
  if (len < 3) { return out; }
  // Build a rolling lowercase view. For ASCII [A-Z] we shift by 32; for
  // everything else we fall back to String#toLowerCase per character.
  const buf: string[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) {
      buf[i] = String.fromCharCode(c + 32);
    } else if (c < 0x80) {
      buf[i] = text[i];
    } else {
      buf[i] = text[i].toLowerCase();
    }
  }
  for (let i = 0; i <= len - 3; i++) {
    out.add(buf[i] + buf[i + 1] + buf[i + 2]);
  }
  return out;
}
