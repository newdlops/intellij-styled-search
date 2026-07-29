export interface DocumentSummaryRetentionStats {
  entryCount: number;
  retainedSymbolWeight: number;
  inFlightLoads: number;
}

export interface DocumentSummaryLoadTicket {
  readonly uri: string;
  readonly generation: number;
}

/**
 * Retains document-derived records only while their owning text document is
 * open. Records are stored by reference: callers keep their exact contents
 * and ordering. A released owner invalidates its pending load ticket, so a
 * late completion cannot restore the released record.
 */
export class DocumentSummaryRetentionStore<T> {
  private readonly records = new Map<string, T>();
  private readonly activeTickets = new Map<string, DocumentSummaryLoadTicket>();
  private retainedSymbolWeight = 0;
  private nextGeneration = 1;

  constructor(private readonly symbolWeight: (record: T) => number) {}

  get(uri: string): T | undefined {
    return this.records.get(uri);
  }

  values(): IterableIterator<T> {
    return this.records.values();
  }

  put(uri: string, record: T): void {
    const previous = this.records.get(uri);
    if (previous) { this.retainedSymbolWeight -= this.symbolWeight(previous); }
    this.records.set(uri, record);
    this.retainedSymbolWeight += this.symbolWeight(record);
  }

  beginLoad(uri: string): DocumentSummaryLoadTicket {
    const ticket = { uri, generation: this.nextGeneration++ };
    this.activeTickets.set(uri, ticket);
    return ticket;
  }

  commit(ticket: DocumentSummaryLoadTicket, record: T): boolean {
    if (this.activeTickets.get(ticket.uri) !== ticket) { return false; }
    this.activeTickets.delete(ticket.uri);
    this.put(ticket.uri, record);
    return true;
  }

  discard(ticket: DocumentSummaryLoadTicket): void {
    if (this.activeTickets.get(ticket.uri) === ticket) {
      this.activeTickets.delete(ticket.uri);
    }
  }

  release(uri: string): void {
    this.activeTickets.delete(uri);
    this.delete(uri);
  }

  delete(uri: string): void {
    const previous = this.records.get(uri);
    if (!previous) { return; }
    this.records.delete(uri);
    this.retainedSymbolWeight -= this.symbolWeight(previous);
  }

  clear(): void {
    this.records.clear();
    this.activeTickets.clear();
    this.retainedSymbolWeight = 0;
  }

  stats(): DocumentSummaryRetentionStats {
    return {
      entryCount: this.records.size,
      retainedSymbolWeight: this.retainedSymbolWeight,
      inFlightLoads: this.activeTickets.size,
    };
  }
}
