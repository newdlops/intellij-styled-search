export interface AsyncWeightedLruCacheOptions<V> {
  maxEntries: number;
  maxWeight: number;
  weight(value: V): number;
}

export interface AsyncWeightedLruCacheStats {
  entryCount: number;
  retainedWeight: number;
  inFlightLoads: number;
}

interface ResidentEntry<V> {
  value: V;
  weight: number;
}

/**
 * A bounded LRU for asynchronously produced values. The promise result is
 * returned directly so a caller can use it even when its value is too large
 * to admit, or is evicted by a later request.
 */
export class AsyncWeightedLruCache<K, V> {
  private readonly entries = new Map<K, ResidentEntry<V>>();
  private readonly flights = new Map<K, Promise<V>>();
  private retainedWeight = 0;
  private generation = 0;

  constructor(private readonly options: AsyncWeightedLruCacheOptions<V>) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) { return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const resident = this.get(key);
    if (resident !== undefined) { return resident; }
    const pending = this.flights.get(key);
    if (pending) { return pending; }

    const generation = this.generation;
    let flight: Promise<V>;
    flight = Promise.resolve()
      .then(load)
      .then((value) => {
        if (this.generation === generation) {
          this.admit(key, value);
        }
        return value;
      })
      .finally(() => {
        if (this.flights.get(key) === flight) {
          this.flights.delete(key);
        }
      });
    this.flights.set(key, flight);
    return flight;
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.flights.clear();
    this.retainedWeight = 0;
  }

  stats(): AsyncWeightedLruCacheStats {
    return {
      entryCount: this.entries.size,
      retainedWeight: this.retainedWeight,
      inFlightLoads: this.flights.size,
    };
  }

  private admit(key: K, value: V): void {
    const weight = normalizedWeight(this.options.weight(value));
    if (this.maxEntries === 0 || weight > this.maxWeight) { return; }
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.retainedWeight -= previous.weight;
    }
    this.entries.set(key, { value, weight });
    this.retainedWeight += weight;
    while (this.entries.size > this.maxEntries || this.retainedWeight > this.maxWeight) {
      const oldest = this.entries.entries().next().value as [K, ResidentEntry<V>] | undefined;
      if (!oldest) { break; }
      this.entries.delete(oldest[0]);
      this.retainedWeight -= oldest[1].weight;
    }
  }

  private get maxEntries(): number {
    return normalizedBudget(this.options.maxEntries);
  }

  private get maxWeight(): number {
    return normalizedBudget(this.options.maxWeight);
  }
}

function normalizedBudget(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizedWeight(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
