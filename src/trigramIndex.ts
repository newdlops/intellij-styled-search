import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { parseRegex } from './codesearch/regexAst';
import { analyze } from './codesearch/regexInfo';
import { PostingSource, TrigramQuery, evalQuery, qAnd, qTri } from './codesearch/trigramQuery';
import { serializeV3 } from './codesearch/binaryIndex';

// A posting list entry that hasn't been materialized into memory yet.
// `offset` is the byte offset within the on-disk postings section; `length`
// is the number of u32 entries. Resolved to a Uint32Array on first access
// via `resolvePosting()`.
interface LazyPosting {
  kind: 'lazy';
  offset: number;
  length: number;
}
type Posting = LazyPosting | Uint32Array | Set<number>;

interface WorkerLoadResult {
  kind: 'v2' | 'v3';
  readMs: number;
  parseMs: number;
  nextId: number;
  fileMeta: Array<[number, string, number, number]>;
  triArr: Array<[string, number, number]>;
  // v2-only: full buffer was transferred
  buffer?: ArrayBuffer;
  byteOffsetBase?: number;
  byteLength?: number;
  // v3-only: absolute file offset where postings section begins
  postingsStart?: number;
  totalBytes?: number;
}

/** Spawn the parse worker, hand it the on-disk index path, and wait for
 *  the zero-copy transfer. Returns null for ENOENT / invalid formats — the
 *  caller treats those as a fresh (empty) index. */
function loadIndexInWorker(absPath: string): Promise<WorkerLoadResult | null> {
  return new Promise((resolve, reject) => {
    const workerFile = path.join(__dirname, 'indexWorker.js');
    const worker = new Worker(workerFile);
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; fn(); } };
    worker.once('message', (msg: any) => {
      // Detach listeners before terminate to avoid leak warnings.
      worker.removeAllListeners('error');
      worker.terminate();
      if (msg && msg.ok) { finish(() => resolve(msg as WorkerLoadResult)); }
      else { finish(() => resolve(null)); }
    });
    worker.once('error', (err) => {
      worker.removeAllListeners('message');
      worker.terminate();
      finish(() => reject(err));
    });
    worker.postMessage({ path: absPath });
  });
}

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
  // Posting lists live in three states:
  //   LazyPosting   — not yet read from disk; fd + offset+length known
  //   Uint32Array   — materialized, sorted ascending
  //   Set<number>   — being mutated by indexFile; save() compacts back
  private tris = new Map<string, Posting>();
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
  // Running tally of WHY each indexFile call skipped (or didn't). Printed
  // at the end of reconcile so the user can see if the index is dropping
  // files silently — a 95% skip rate on a Python .venv workspace means
  // something is too strict (maxFileSize, binary false-positive, or a
  // pervasive stat/read error on symlinked site-packages).
  private skipCounts = {
    binaryExt: 0, statError: 0, directory: 0, tooBig: 0,
    readError: 0, binaryContent: 0, decodeError: 0, indexed: 0,
  };
  // Open file descriptor for on-disk postings (v3 lazy mode). Queries call
  // fs.readSync to pull individual posting byte ranges. undefined means
  // there's no backing file yet (fresh index, or the index is fully in
  // memory after a legacy v2 load / rebuild).
  private fd: number | undefined;
  private postingsStart = 0;
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
      const posting = this.resolvePosting(tri);
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
    const t0 = Date.now();
    let result: WorkerLoadResult | null;
    try { result = await loadIndexInWorker(fileUri.fsPath); }
    catch (err) {
      this.log.appendLine(`TrigramIndex worker load errored: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!result) {
      // No cached index on disk (ENOENT) or invalid format — fresh start.
      return;
    }
    this.nextId = result.nextId || 1;
    this.fileMeta = new Map();
    this.uriToId = new Map();
    for (const [id, uri, mtime, size] of result.fileMeta) {
      this.fileMeta.set(id, { uri, mtime, size });
      this.uriToId.set(uri, id);
    }
    this.tris = new Map();
    if (result.kind === 'v3') {
      // Lazy mode: keep postings on disk, store only TOC refs. We open our
      // own fd — the worker closes its copy before returning.
      try { this.fd = fs.openSync(fileUri.fsPath, 'r'); }
      catch (err) {
        this.log.appendLine(`TrigramIndex: can't open index fd: ${err instanceof Error ? err.message : err}`);
        return;
      }
      this.postingsStart = result.postingsStart!;
      for (let i = 0; i < result.triArr.length; i++) {
        const [tri, offset, length] = result.triArr[i];
        this.tris.set(tri, { kind: 'lazy', offset, length });
      }
      const tDone = Date.now();
      this.log.appendLine(
        `TrigramIndex loaded (v3 lazy): ${this.fileMeta.size} files, ${this.tris.size} trigrams ` +
        `(worker read=${result.readMs}ms parse=${result.parseMs}ms ` +
        `main=${tDone - t0 - result.readMs - result.parseMs}ms ` +
        `total=${tDone - t0}ms, meta=${Math.round((result.totalBytes || 0) / 1024)}KB)`,
      );
      return;
    }
    // v2 fallback: worker transferred the whole buffer, we make views.
    const buf = result.buffer!;
    const base = result.byteOffsetBase!;
    for (let i = 0; i < result.triArr.length; i++) {
      const [tri, relOff, postLen] = result.triArr[i];
      const abs = base + relOff;
      let posting: Uint32Array;
      if ((abs & 3) === 0) {
        posting = new Uint32Array(buf, abs, postLen);
      } else {
        posting = new Uint32Array(postLen);
        const view = new DataView(buf, abs, postLen * 4);
        for (let j = 0; j < postLen; j++) {
          posting[j] = view.getUint32(j * 4, true);
        }
      }
      this.tris.set(tri, posting);
    }
    // Mark dirty so the next save migrates us to v3 layout.
    this.dirty = true;
    this.scheduleSave(60_000);
    const tDone = Date.now();
    this.log.appendLine(
      `TrigramIndex loaded (v2 → will migrate to v3): ${this.fileMeta.size} files, ${this.tris.size} trigrams ` +
      `(worker read=${result.readMs}ms parse=${result.parseMs}ms ` +
      `rebuild=${tDone - t0 - result.readMs - result.parseMs}ms ` +
      `total=${tDone - t0}ms, bin=${Math.round((result.byteLength || 0) / 1024)}KB)`,
    );
  }

  /** Read a posting from the backing fd into a fresh Uint32Array and cache
   *  it in the tris map (replacing the LazyPosting ref). Returns null if
   *  the fd is closed or the read fails. */
  private materializeLazy(tri: string, ref: LazyPosting): Uint32Array | null {
    if (this.fd === undefined) { return null; }
    const bytes = ref.length * 4;
    const buf = Buffer.alloc(bytes);
    let read = 0;
    while (read < bytes) {
      const n = fs.readSync(this.fd, buf, read, bytes - read, this.postingsStart + ref.offset + read);
      if (n <= 0) { break; }
      read += n;
    }
    if (read < bytes) { return null; }
    const posting = new Uint32Array(buf.buffer, buf.byteOffset, ref.length);
    this.tris.set(tri, posting);
    return posting;
  }

  /** Normalize a posting to its materialized form (Uint32Array | Set). */
  private resolvePosting(tri: string): Uint32Array | Set<number> | null {
    const p = this.tris.get(tri);
    if (!p) { return null; }
    if ((p as LazyPosting).kind === 'lazy') {
      return this.materializeLazy(tri, p as LazyPosting);
    }
    return p as Uint32Array | Set<number>;
  }

  private async save(): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
    // Compact all posting lists to Uint32Array (sorted). Materializes any
    // still-lazy postings by reading them from the backing fd. Yields
    // every ~15ms so CDP response processing isn't held hostage.
    const compactTris = new Map<string, Uint32Array>();
    let checkpoint = Date.now();
    let materialized = 0;
    for (const [tri, posting] of this.tris) {
      if (posting instanceof Uint32Array) {
        compactTris.set(tri, posting);
      } else if ((posting as LazyPosting).kind === 'lazy') {
        const loaded = this.materializeLazy(tri, posting as LazyPosting);
        if (loaded) { compactTris.set(tri, loaded); materialized++; }
      } else {
        const set = posting as Set<number>;
        const arr = new Uint32Array(set.size);
        let k = 0;
        for (const id of set) { arr[k++] = id; }
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
      await new Promise<void>((r) => setImmediate(r));
      const buf = serializeV3({
        nextId: this.nextId,
        fileMeta: this.fileMeta,
        tris: compactTris,
      });
      const tWrite = Date.now();
      // Close the current fd before writing — on Windows the write would
      // fail with EBUSY, and on POSIX we want the new file descriptor to
      // point at the fresh inode afterwards.
      if (this.fd !== undefined) {
        try { fs.closeSync(this.fd); } catch {}
        this.fd = undefined;
      }
      await vscode.workspace.fs.writeFile(fileUri, buf);
      // Re-open fd and flip every loaded posting back to a LazyPosting ref
      // so we return to a small in-memory footprint. Loaded postings get
      // GC'd once the Map entries are replaced.
      try {
        this.fd = fs.openSync(fileUri.fsPath, 'r');
        this.relazyFromImage(compactTris, buf);
      } catch (err) {
        this.log.appendLine(`TrigramIndex: fd re-open after save failed: ${err instanceof Error ? err.message : err}`);
      }
      this.dirty = false;
      this.log.appendLine(
        `TrigramIndex saved (v3): ${Math.round(buf.length / 1024)} KB ` +
        `(trigrams ${compactTris.size}, files ${this.fileMeta.size}, ` +
        `materialized=${materialized}, serialize=${tWrite - tSer}ms write=${Date.now() - tWrite}ms)`,
      );
    } catch (err) {
      this.log.appendLine(`TrigramIndex save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** After writing a fresh v3 file, walk the serialized buffer's header to
   *  find `postingsStart`, then replace every entry in `this.tris` with a
   *  LazyPosting ref pointing into the new file. The previously-loaded
   *  Uint32Arrays get GC'd, giving us back a small heap footprint. */
  private relazyFromImage(compactTris: Map<string, Uint32Array>, buf: Buffer): void {
    // Header layout: [magic 4][version 4][nextId 4][fileCount 4][triCount 4]
    //                [fileMetaEnd 4][tocEnd 4][reserved 4]
    if (buf.length < 32) { return; }
    const tocEnd = buf.readUInt32LE(24);
    this.postingsStart = tocEnd;
    // Walk compactTris in insertion order (same as serialize traverses the
    // map) to reconstruct postOffsets without re-parsing the TOC.
    let off = 0;
    const fresh = new Map<string, Posting>();
    for (const [tri, posting] of compactTris) {
      fresh.set(tri, { kind: 'lazy', offset: off, length: posting.length });
      off += posting.length * 4;
    }
    this.tris = fresh;
  }

  private scheduleSave(delayMs = 30_000): void {
    this.dirty = true;
    if (this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, delayMs);
  }

  /** @internal Force an immediate save, skipping the debounce timer. Used
   *  by E2E tests that need a deterministic flush point before asserting
   *  on-disk layout or reloading into a fresh instance. */
  async flushToDisk(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    await this.save();
  }

  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (this.watcher) { this.watcher.dispose(); this.watcher = undefined; }
    if (this.dirty) { void this.save(); }
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = undefined;
    }
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
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = undefined;
    }
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

  private getExcludePattern(): string | null {
    // null (not undefined) so findFiles bypasses VSCode's default
    // search.exclude + files.exclude (which silently drop node_modules,
    // .venv, site-packages, etc.). Our excludeGlobs setting is the sole
    // source of truth; an empty list means index EVERY non-binary file.
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const globs = cfg.get<string[]>('excludeGlobs', []);
    return globs.length > 0 ? `{${globs.join(',')}}` : null;
  }

  private async reconcileWorkspace(progress?: ReconcileProgress): Promise<void> {
    const excludePattern = this.getExcludePattern();
    // Reset skip-reason tally for this reconcile run so the final log line
    // reflects THIS pass only, not lifetime counts.
    this.skipCounts = {
      binaryExt: 0, statError: 0, directory: 0, tooBig: 0,
      readError: 0, binaryContent: 0, decodeError: 0, indexed: 0,
    };
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
    const s = this.skipCounts;
    this.log.appendLine(
      `TrigramIndex indexFile tally: indexed=${s.indexed} binaryExt=${s.binaryExt} tooBig=${s.tooBig} binaryContent=${s.binaryContent} readError=${s.readError} statError=${s.statError} directory=${s.directory} decodeError=${s.decodeError}`,
    );
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
   *  / LazyPosting form on first write. Caller can then call .add/.delete
   *  directly. Lazy postings get materialized via fd read. */
  private mutablePosting(tri: string): Set<number> {
    const existing = this.tris.get(tri);
    if (existing instanceof Set) { return existing; }
    if (existing instanceof Uint32Array) {
      const s = new Set<number>();
      for (let i = 0; i < existing.length; i++) { s.add(existing[i]); }
      this.tris.set(tri, s);
      return s;
    }
    if (existing && (existing as LazyPosting).kind === 'lazy') {
      const resolved = this.materializeLazy(tri, existing as LazyPosting);
      if (resolved) {
        const s = new Set<number>();
        for (let i = 0; i < resolved.length; i++) { s.add(resolved[i]); }
        this.tris.set(tri, s);
        return s;
      }
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
    // NOTE: we intentionally do NOT walk every trigram to remove this id
    // from its posting. With lazy postings that would force a read of all
    // ~600K postings from disk for a single removed file. Instead we
    // leave the stale fileId in postings — candidatesFor filters them out
    // at query time via the `fileMeta.get(id)` guard, and the next save
    // rewrites every posting cleanly anyway.
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
      if (BINARY_EXT.has(ext)) { this.skipCounts.binaryExt++; return; }
      let stat: vscode.FileStat;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { this.skipCounts.statError++; return; }
      if (stat.type === vscode.FileType.Directory) { this.skipCounts.directory++; return; }
      const maxFileSize = vscode.workspace.getConfiguration('intellijStyledSearch').get<number>('maxFileSize', 1_048_576);
      if (stat.size > maxFileSize) {
        // Too big; treat as excluded.
        this.skipCounts.tooBig++;
        this.removeByUri(uriStr);
        return;
      }
      let bytes: Uint8Array;
      try { bytes = await vscode.workspace.fs.readFile(uri); } catch { this.skipCounts.readError++; return; }
      if (looksBinary(bytes)) { this.skipCounts.binaryContent++; this.removeByUri(uriStr); return; }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch { this.skipCounts.decodeError++; return; }
      this.skipCounts.indexed++;

      // Allocate or reuse a fileId.
      let id = this.uriToId.get(uriStr);
      if (id === undefined) {
        id = this.nextId++;
        this.uriToId.set(uriStr, id);
      }
      // NOTE: previously we walked every trigram posting to scrub the old
      // fileId before adding the new trigrams. That worked when all
      // postings lived in memory, but with the v3 lazy layout it would
      // force a read of all ~600K postings from disk on every reindex.
      // Instead we add the new trigrams and leave stale fileIds in old
      // trigrams' postings. Candidates will include a few false positives
      // (posting claims file X contains trigram T, but the new content
      // doesn't), but rg verifies every candidate on disk, so the final
      // result is still correct. The next save() compacts/rewrites every
      // posting and the stale entries disappear naturally.
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
    // Multi-line is SAFE here because extractTrigramsLower walks the full
    // byte sequence — newline chars are just characters that contribute
    // trigrams like "):\n" and "\n   ". The file-indexing path does the
    // exact same extraction, so a file containing the multi-line literal
    // must contain every trigram we extract from the query.
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
        // Safety net for multi-line literal queries: when EVERY query
        // trigram exists in the index but no file contains them all, the
        // most likely explanation is that the source file wasn't indexed
        // yet (reconcile still running, or .gitignore'd .venv/node_modules
        // files that findFiles can still skip even with exclude=null).
        // Fall back to a full rg scan — empty-narrowing false negatives on
        // a 200+ trigram query almost never mean "truly no match"; they
        // mean the index is incomplete. Single-line queries stay narrowed
        // because a short query hitting 0 files usually IS a real miss and
        // full-scan is not worth the cost.
        if (missing.length === 0 && query.includes('\n')) {
          return { uris: null, reason: `fast-path-fallback(trigrams=${qtris.size},indexSize=${this.fileMeta.size}${multi}${staleStr},empty-intersection→full-scan)` };
        }
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
      get: (tri: string) => this.resolvePosting(tri),
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
      get: (tri: string) => this.resolvePosting(tri),
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
