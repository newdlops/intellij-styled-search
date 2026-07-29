import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableCommandOwnershipRegistry } from '../../internal/callGraphInlayCommandOwnership';

test('durable command ownership retains shared registrations until every document closes', () => {
  const ownership = new DurableCommandOwnershipRegistry();
  const disposed: string[] = [];
  const calls: unknown[][] = [];
  const registrations = new Map<string, { invoke(): void }>();
  const register = (commandId: string, args: unknown[]) => () => {
    const registration = {
      dispose: () => disposed.push(commandId),
      invoke: () => calls.push(args),
    };
    registrations.set(commandId, registration);
    return registration;
  };
  const exclusive = register('command:exclusive', ['symbol-a', 'Label A']);
  const shared = register('command:shared', ['symbol-b', 'Label B', 3]);

  ownership.retain('file:///one', 'command:exclusive', exclusive);
  ownership.retain('file:///one', 'command:exclusive', () => {
    throw new Error('duplicate retention must not register again');
  });
  ownership.retain('file:///one', 'command:shared', shared);
  ownership.retain('file:///two', 'command:shared', () => {
    throw new Error('shared retention must not register again');
  });

  assert.equal(ownership.retainedCommandCount, 2);
  assert.equal(ownership.retainedOwnerCount, 2);
  registrations.get('command:exclusive')?.invoke();
  registrations.get('command:shared')?.invoke();
  assert.deepEqual(calls, [['symbol-a', 'Label A'], ['symbol-b', 'Label B', 3]]);

  ownership.releaseOwner('file:///one');
  assert.deepEqual(disposed, ['command:exclusive']);
  assert.equal(ownership.retainedCommandCount, 1);
  assert.equal(ownership.retainedOwnerCount, 1);

  ownership.releaseOwner('file:///two');
  assert.deepEqual(disposed, ['command:exclusive', 'command:shared']);
  assert.equal(ownership.retainedCommandCount, 0);
  assert.equal(ownership.retainedOwnerCount, 0);

  ownership.retain('file:///three', 'command:remaining', register('command:remaining', ['symbol-c']));
  ownership.dispose();
  assert.deepEqual(disposed, ['command:exclusive', 'command:shared', 'command:remaining']);
  assert.equal(ownership.retainedCommandCount, 0);
  assert.equal(ownership.retainedOwnerCount, 0);
});
