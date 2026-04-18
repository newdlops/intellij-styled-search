import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

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

// Index-sizing knobs. Files with absurd unique-trigram counts are almost
// always minified / generated / data, and popular trigrams that appear in a
// large fraction of the workspace are useless as filters — both are dropped
// to keep the index small and fast.
const MAX_UNIQUE_TRIGRAMS_PER_FILE = 30_000;
const FREQUENT_TRIGRAM_FILE_RATIO = 0.30;  // drop trigrams in >30% of files
const FREQUENT_TRIGRAM_MIN_ABSOLUTE = 10_000;  // or >10k files, whichever is lower

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.o', '.a',
  '.wasm', '.node',
]);

interface FileMeta { uri: string; mtime: number; size: number }
interface Serialized {
  version: number;
  nextId: number;
  fileMeta: Array<[number, FileMeta]>;
  trigrams: Array<[string, number[]]>;
}

export class TrigramIndex {
  private tris = new Map<string, Set<number>>();
  private fileMeta = new Map<number, FileMeta>();
  private uriToId = new Map<string, number>();
  private nextId = 1;
  private dirty = false;
  private ready = false;
  private initPromise: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly storageDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {}

  get isReady(): boolean { return this.ready; }
  get size(): number { return this.fileMeta.size; }

  async init(): Promise<void> {
    if (!this.initPromise) { this.initPromise = this.doInit(); }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(this.storageDir); } catch {}
    await this.load();
    await this.reconcileWorkspace();
    this.startWatcher();
    this.ready = true;
    if (this.dirty) { void this.save(); }
    this.log.appendLine(`TrigramIndex ready: ${this.fileMeta.size} files, ${this.tris.size} trigrams`);
  }

  private indexFileName(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    const seed = folders.map((f) => f.uri.toString()).sort().join('|');
    const h = crypto.createHash('sha1').update(seed || 'empty').digest('hex').slice(0, 12);
    return `trigram-${h}.json.gz`;
  }

  private async load(): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const json = zlib.gunzipSync(Buffer.from(bytes)).toString('utf-8');
      const data = JSON.parse(json) as Serialized;
      if (!data || data.version !== 1) { return; }
      this.nextId = data.nextId || 1;
      this.fileMeta = new Map(data.fileMeta);
      this.uriToId = new Map();
      for (const [id, meta] of this.fileMeta) { this.uriToId.set(meta.uri, id); }
      this.tris = new Map();
      for (const [tri, ids] of data.trigrams) {
        this.tris.set(tri, new Set(ids));
      }
      this.log.appendLine(`TrigramIndex loaded: ${this.fileMeta.size} files, ${this.tris.size} trigrams`);
    } catch {
      // Fresh start
    }
  }

  private async save(): Promise<void> {
    const fileUri = vscode.Uri.joinPath(this.storageDir, this.indexFileName());
    this.pruneFrequentTrigrams();
    const trigramPairs: Array<[string, number[]]> = new Array(this.tris.size);
    let i = 0;
    for (const [tri, ids] of this.tris) {
      const arr = new Array<number>(ids.size);
      let k = 0;
      for (const id of ids) { arr[k++] = id; }
      arr.sort((a, b) => a - b);
      trigramPairs[i++] = [tri, arr];
    }
    const data: Serialized = {
      version: 1,
      nextId: this.nextId,
      fileMeta: Array.from(this.fileMeta),
      trigrams: trigramPairs,
    };
    try {
      const json = JSON.stringify(data);
      const compressed = zlib.gzipSync(Buffer.from(json), { level: 6 });
      await vscode.workspace.fs.writeFile(fileUri, compressed);
      this.dirty = false;
      this.log.appendLine(
        `TrigramIndex saved: ${Math.round(compressed.length / 1024)} KB ` +
        `(json ${Math.round(json.length / 1024)} KB, trigrams ${this.tris.size}, files ${this.fileMeta.size})`,
      );
    } catch (err) {
      this.log.appendLine(`TrigramIndex save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private pruneFrequentTrigrams(): void {
    const fileCount = this.fileMeta.size;
    if (fileCount === 0) { return; }
    const threshold = Math.min(
      Math.ceil(fileCount * FREQUENT_TRIGRAM_FILE_RATIO),
      FREQUENT_TRIGRAM_MIN_ABSOLUTE,
    );
    let dropped = 0;
    for (const [tri, ids] of Array.from(this.tris)) {
      if (ids.size > threshold) {
        this.tris.delete(tri);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.log.appendLine(
        `TrigramIndex pruned ${dropped} frequent trigrams (posting > ${threshold} files)`,
      );
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

  private getExcludePattern(): string | undefined {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const globs = cfg.get<string[]>('excludeGlobs', []);
    return globs.length > 0 ? `{${globs.join(',')}}` : undefined;
  }

  private async reconcileWorkspace(): Promise<void> {
    const excludePattern = this.getExcludePattern();
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 100_000);
    const currentUris = new Set(files.map((u) => u.toString()));
    // Drop entries for files no longer present.
    let removed = 0;
    for (const [id, meta] of Array.from(this.fileMeta)) {
      if (!currentUris.has(meta.uri)) {
        this.removeFileId(id);
        removed++;
      }
    }
    // Determine files to (re)index by mtime.
    const toIndex: vscode.Uri[] = [];
    const statLimit = 32;
    let statIdx = 0;
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
            if (id === undefined) { toIndex.push(uri); continue; }
            const meta = this.fileMeta.get(id);
            if (!meta || meta.mtime !== stat.mtime) { toIndex.push(uri); }
          } catch {}
        }
      })());
    }
    await Promise.all(statWorkers);
    this.log.appendLine(`TrigramIndex reconcile: total=${files.length} reindex=${toIndex.length} removed=${removed}`);
    // Index with limited concurrency so we don't thrash the FS.
    const indexLimit = 8;
    let indexIdx = 0;
    const indexWorkers: Promise<void>[] = [];
    for (let w = 0; w < indexLimit; w++) {
      indexWorkers.push((async () => {
        while (true) {
          const i = indexIdx++;
          if (i >= toIndex.length) { return; }
          try { await this.indexFile(toIndex[i]); } catch {}
        }
      })());
    }
    await Promise.all(indexWorkers);
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

  private removeFileId(id: number): void {
    const meta = this.fileMeta.get(id);
    if (!meta) { return; }
    this.fileMeta.delete(id);
    this.uriToId.delete(meta.uri);
    // Remove fileId from any trigram set that contains it. This walks every
    // trigram — acceptable for rare deletions, can be optimised by tracking
    // each file's trigrams separately if it becomes a hot path.
    for (const [tri, ids] of this.tris) {
      if (ids.delete(id) && ids.size === 0) { this.tris.delete(tri); }
    }
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    const uriStr = uri.toString();
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
      for (const [tri, ids] of this.tris) {
        if (ids.delete(id) && ids.size === 0) { this.tris.delete(tri); }
      }
    }
    const uniq = extractTrigramsLower(text);
    if (uniq.size > MAX_UNIQUE_TRIGRAMS_PER_FILE) {
      // Skip minified / generated / data files; they balloon the index
      // without helping searches that users actually run.
      this.removeByUri(uriStr);
      return;
    }
    this.fileMeta.set(id, { uri: uriStr, mtime: stat.mtime, size: stat.size });
    for (const tri of uniq) {
      let set = this.tris.get(tri);
      if (!set) { set = new Set(); this.tris.set(tri, set); }
      set.add(id);
    }
  }

  // Public: get candidate URIs for a query. Returns null when the index
  // cannot help (short query / not ready / regex) and the caller should
  // fall back to a full scan.
  candidatesFor(query: string, opts: { useRegex: boolean }): Set<string> | null {
    if (!this.ready) { return null; }
    if (opts.useRegex) { return null; }
    if (query.length < 3) { return null; }
    const qtris = extractTrigramsLower(query);
    if (qtris.size === 0) { return null; }
    let pool: Set<number> | null = null;
    for (const t of qtris) {
      const ids = this.tris.get(t);
      if (!ids || ids.size === 0) { return new Set<string>(); }
      if (pool === null) {
        pool = new Set(ids);
      } else {
        const smaller = ids.size < pool.size ? ids : pool;
        const bigger = ids.size < pool.size ? pool : ids;
        const next = new Set<number>();
        for (const id of smaller) { if (bigger.has(id)) { next.add(id); } }
        pool = next;
      }
      if (pool.size === 0) { return new Set<string>(); }
    }
    const out = new Set<string>();
    if (pool) {
      for (const id of pool) {
        const meta = this.fileMeta.get(id);
        if (meta) { out.add(meta.uri); }
      }
    }
    return out;
  }
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

function extractTrigramsLower(text: string): Set<string> {
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
