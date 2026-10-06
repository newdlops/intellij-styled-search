/** Short-lived, bounded results; invalidation prevents stale flights publishing. */
export class UsageRefinementCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number; expires: number }>();
  private readonly flights = new Map<string, Promise<T>>();
  private epoch = 0;
  private weight = 0;

  constructor(
    private readonly clone: (value: T) => T,
    private readonly weigh: (value: T) => number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 16,
    private readonly maxWeight = 4_000,
    private readonly ttlMs = 5_000,
  ) {}

  clear(): void {
    this.epoch++;
    this.entries.clear();
    this.flights.clear();
    this.weight = 0;
  }

  async get(key: string, compute: () => Promise<T>, cacheable: (value: T) => boolean): Promise<T> {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      if (entry.expires > this.now()) {
        this.entries.set(key, entry);
        return this.clone(entry.value);
      }
      this.weight -= entry.weight;
    }
    const existing = this.flights.get(key);
    if (existing) { return this.clone(await existing); }
    const epoch = this.epoch;
    const flight = compute();
    // Do not retain an unbounded number of overlapping queries.
    if (this.flights.size < this.maxEntries) { this.flights.set(key, flight); }
    try {
      const value = await flight;
      const weight = this.weigh(value);
      if (epoch === this.epoch && weight <= this.maxWeight && cacheable(value)) {
        const previous = this.entries.get(key);
        if (previous) { this.weight -= previous.weight; this.entries.delete(key); }
        this.entries.set(key, { value: this.clone(value), weight, expires: this.now() + this.ttlMs });
        this.weight += weight;
        while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
          const oldest = this.entries.entries().next().value!;
          this.entries.delete(oldest[0]);
          this.weight -= oldest[1].weight;
        }
      }
      return this.clone(value);
    } finally {
      if (this.flights.get(key) === flight) { this.flights.delete(key); }
    }
  }
}
