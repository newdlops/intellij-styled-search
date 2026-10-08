export const FILES_SCOPE_STORAGE_KEY = 'intellijStyledSearch.filesScope';

interface ScopeStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: string): PromiseLike<void>;
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
