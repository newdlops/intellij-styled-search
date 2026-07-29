export interface DurableCommandDisposable {
  dispose(): void;
}

/**
 * Owns durable command registrations independently of the editor API. A
 * command may be rendered for more than one open document, but its
 * registration stays alive until every owning document has closed.
 */
export class DurableCommandOwnershipRegistry {
  private readonly registrationsByCommand = new Map<string, DurableCommandDisposable>();
  private readonly commandIdsByOwner = new Map<string, Set<string>>();
  private readonly ownerIdsByCommand = new Map<string, Set<string>>();

  get retainedCommandCount(): number {
    return this.registrationsByCommand.size;
  }

  get retainedOwnerCount(): number {
    return this.commandIdsByOwner.size;
  }

  retain(ownerId: string, commandId: string, register: () => DurableCommandDisposable): void {
    const owners = this.ownerIdsByCommand.get(commandId);
    if (owners?.has(ownerId)) { return; }

    if (!owners) {
      const registration = register();
      this.registrationsByCommand.set(commandId, registration);
      this.ownerIdsByCommand.set(commandId, new Set([ownerId]));
    } else {
      owners.add(ownerId);
    }

    const commands = this.commandIdsByOwner.get(ownerId) ?? new Set<string>();
    commands.add(commandId);
    this.commandIdsByOwner.set(ownerId, commands);
  }

  releaseOwner(ownerId: string): void {
    const commandIds = this.commandIdsByOwner.get(ownerId);
    if (!commandIds) { return; }
    this.commandIdsByOwner.delete(ownerId);
    for (const commandId of commandIds) {
      const owners = this.ownerIdsByCommand.get(commandId);
      if (!owners) { continue; }
      owners.delete(ownerId);
      if (owners.size > 0) { continue; }
      this.ownerIdsByCommand.delete(commandId);
      const registration = this.registrationsByCommand.get(commandId);
      this.registrationsByCommand.delete(commandId);
      registration?.dispose();
    }
  }

  dispose(): void {
    const registrations = [...this.registrationsByCommand.values()];
    this.registrationsByCommand.clear();
    this.commandIdsByOwner.clear();
    this.ownerIdsByCommand.clear();
    for (const registration of registrations) {
      registration.dispose();
    }
  }
}
