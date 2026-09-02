import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IndexingMemoryPressureError,
  IndexingMemoryProtection,
  assessIndexingMemory,
  parseDarwinMemoryPressureAvailableBytes,
  parseDarwinVmStatAvailableBytes,
  parseLinuxMemAvailableBytes,
  type SystemMemorySnapshot,
} from '../../internal/indexingMemoryProtection';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function snapshot(totalBytes: number, availableBytes: number): SystemMemorySnapshot {
  return { totalBytes, availableBytes, source: 'os-freemem' };
}

test('classifies scalable host reserves without making small hosts unusable', () => {
  const ordinary = assessIndexingMemory(snapshot(16 * GIB, 3 * GIB));
  assert.equal(ordinary.pressureThresholdBytes, 2 * GIB);
  assert.equal(ordinary.level, 'healthy');
  assert.equal(assessIndexingMemory(snapshot(16 * GIB, 2 * GIB)).level, 'pressured');
  assert.equal(assessIndexingMemory(snapshot(16 * GIB, 800 * MIB)).level, 'critical');

  const large = assessIndexingMemory(snapshot(128 * GIB, 5 * GIB));
  assert.equal(large.pressureThresholdBytes, 4 * GIB, 'large hosts should use the bounded reserve');
  assert.equal(large.level, 'healthy');

  const small = assessIndexingMemory(snapshot(1 * GIB, 300 * MIB));
  assert.equal(small.pressureThresholdBytes, 256 * MIB);
  assert.equal(small.level, 'healthy');
});

test('uses Linux MemAvailable rather than raw free pages when present', () => {
  assert.equal(
    parseLinuxMemAvailableBytes([
      'MemTotal:       16384000 kB',
      'MemFree:          120000 kB',
      'MemAvailable:    3145728 kB',
      '',
    ].join('\n')),
    3 * GIB,
  );
  assert.equal(parseLinuxMemAvailableBytes('MemFree: 123 kB\n'), undefined);
});

test('converts the macOS memory pressure percentage into reclaimable bytes', () => {
  assert.equal(
    parseDarwinMemoryPressureAvailableBytes(
      'System-wide memory free percentage: 55%\n',
      16 * GIB,
    ),
    Math.floor(16 * GIB * 0.55),
  );
  assert.equal(
    parseDarwinMemoryPressureAvailableBytes('System-wide memory free percentage: 101%\n', 16 * GIB),
    undefined,
  );
});

test('falls back to reclaimable macOS VM page classes when pressure output is unavailable', () => {
  assert.equal(
    parseDarwinVmStatAvailableBytes([
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               100.',
      'Pages active:                             999.',
      'Pages inactive:                           200.',
      'Pages speculative:                         30.',
      'Pages purgeable:                           20.',
      '',
    ].join('\n')),
    350 * 16_384,
  );
});

test('blocks a new index before work starts and reports actionable memory totals', () => {
  const protection = new IndexingMemoryProtection({
    sample: () => snapshot(16 * GIB, 1_500 * MIB),
  });
  assert.throws(
    () => protection.assertCanStart('fixture index rebuild'),
    (error: unknown) => {
      assert.ok(error instanceof IndexingMemoryPressureError);
      assert.equal(error.phase, 'start');
      assert.match(error.message, /fixture index rebuild not started to protect the host from OOM/);
      assert.match(error.message, /1500MB of 16384MB system memory available/);
      return true;
    },
  );
});

test('stops sustained pressure while tolerating a single transient sample', async () => {
  const healthy = snapshot(16 * GIB, 4 * GIB);
  const pressured = snapshot(16 * GIB, 1_500 * MIB);
  const samples = [pressured, healthy, pressured, pressured];
  let latest = healthy;
  const errors: IndexingMemoryPressureError[] = [];
  const protection = new IndexingMemoryProtection({
    sample: () => {
      latest = samples.shift() ?? latest;
      return latest;
    },
    sampleIntervalMs: 10,
    sustainedPressureSamples: 2,
  });
  const monitor = protection.monitor('fixture running index', (error) => errors.push(error));
  await new Promise<void>((resolve) => setTimeout(resolve, 70));
  monitor.dispose();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'running');
  assert.match(errors[0].message, /fixture running index stopped/);
});

test('stops critical pressure on the first sample', async () => {
  const errors: IndexingMemoryPressureError[] = [];
  const protection = new IndexingMemoryProtection({
    sample: () => snapshot(16 * GIB, 256 * MIB),
    sampleIntervalMs: 10,
    sustainedPressureSamples: 5,
  });
  const monitor = protection.monitor('fixture critical index', (error) => errors.push(error));
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  monitor.dispose();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].assessment.level, 'critical');
});
