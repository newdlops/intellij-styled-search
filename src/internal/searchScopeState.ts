export const FILES_SCOPE_STORAGE_KEY = 'intellijStyledSearch.filesScope';
export const FILES_SCOPE_HISTORY_KEY = 'intellijStyledSearch.filesScopeHistory';

interface ScopeStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): PromiseLike<void>;
}

interface HistoryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: string[]): PromiseLike<void>;
}

/** Complete Ant expressions, owned by the workspace where they were used. */
export class SearchScopeHistoryState {
  private entries: string[];
  private writes = Promise.resolve();

  constructor(private readonly storage: HistoryStorage) {
    const raw = storage.get<unknown>(FILES_SCOPE_HISTORY_KEY);
    this.entries = Array.isArray(raw)
      ? [...new Set(raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
      : [];
  }

  read(limit: number): string[] { return this.entries.slice(0, Math.max(0, limit)); }

  record(value: string, limit: number): Promise<void> {
    if (limit <= 0 || !value.trim()) { return Promise.resolve(); }
    return this.persist([value, ...this.entries.filter(entry => entry !== value)].slice(0, limit));
  }

  trim(limit: number): Promise<void> { return this.persist(this.read(limit)); }
  whenSaved(): Promise<void> { return this.writes; }

  private persist(entries: string[]): Promise<void> {
    this.entries = entries;
    this.writes = this.writes.catch(() => undefined)
      .then(() => this.storage.update(FILES_SCOPE_HISTORY_KEY, entries));
    return this.writes;
  }
}

/** Workspace-owned preferences, independent of renderer and search lifetimes. */
export class SearchScopeState {
  private value: unknown;
  private writes = Promise.resolve();

  constructor(private readonly storage: ScopeStorage, private readonly defaultScope: () => unknown) {
    this.value = storage.get<unknown>(FILES_SCOPE_STORAGE_KEY);
  }

  initialValue(): string {
    // An explicitly cleared scope means all files, even with a configured default.
    if (typeof this.value === 'string') { return this.value; }
    const fallback = this.defaultScope();
    return typeof fallback === 'string' ? fallback : '';
  }

  save(value: string): Promise<void> {
    this.value = value;
    // Keep typing order even if the storage provider completes writes out of order.
    // A failed write must not prevent a later edit from being saved.
    this.writes = this.writes.catch(() => undefined)
      .then(() => this.storage.update(FILES_SCOPE_STORAGE_KEY, value));
    return this.writes;
  }

  whenSaved(): Promise<void> { return this.writes; }
}
