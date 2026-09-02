import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const DEFAULT_SUSTAINED_PRESSURE_SAMPLES = 2;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_SAMPLE_CACHE_MS = 200;

export type SystemMemorySnapshot = {
  totalBytes: number;
  availableBytes: number;
  source: 'os-freemem' | 'darwin-memory-pressure' | 'darwin-vm-stat' |
    'linux-memavailable' | 'cgroup-v1' | 'cgroup-v2';
};

export type IndexingMemoryAssessment = SystemMemorySnapshot & {
  availableRatio: number;
  pressureThresholdBytes: number;
  criticalThresholdBytes: number;
  level: 'healthy' | 'pressured' | 'critical';
};

export type IndexingMemoryMonitor = {
  dispose(): void;
};

type IndexingMemoryProtectionOptions = {
  sample?: () => SystemMemorySnapshot;
  sampleIntervalMs?: number;
  sustainedPressureSamples?: number;
};

/**
 * Full index builds have bursty, workspace-dependent memory use. Keep a
 * reserve that scales on ordinary machines without reserving an unbounded
 * fraction of very large hosts. Small containers use at most 25% of their
 * limit as the start threshold so the protection does not make indexing
 * impossible solely because the host is small.
 */
export function assessIndexingMemory(snapshot: SystemMemorySnapshot): IndexingMemoryAssessment {
  const totalBytes = Math.max(1, Math.floor(snapshot.totalBytes));
  const availableBytes = Math.max(0, Math.min(totalBytes, Math.floor(snapshot.availableBytes)));
  const pressureThresholdBytes = Math.min(
    Math.max(2 * GIB, Math.min(4 * GIB, Math.floor(totalBytes * 0.10))),
    Math.floor(totalBytes * 0.25),
  );
  const criticalThresholdBytes = Math.min(
    Math.max(256 * MIB, Math.min(1 * GIB, Math.floor(totalBytes * 0.05))),
    Math.floor(totalBytes * 0.15),
  );
  const level = availableBytes <= criticalThresholdBytes
    ? 'critical'
    : availableBytes <= pressureThresholdBytes
      ? 'pressured'
      : 'healthy';
  return {
    ...snapshot,
    totalBytes,
    availableBytes,
    availableRatio: availableBytes / totalBytes,
    pressureThresholdBytes,
    criticalThresholdBytes,
    level,
  };
}

export class IndexingMemoryPressureError extends Error {
  readonly code = 'INDEXING_MEMORY_PRESSURE';

  constructor(
    readonly operation: string,
    readonly phase: 'start' | 'running',
    readonly assessment: IndexingMemoryAssessment,
  ) {
    const verb = phase === 'start' ? 'not started' : 'stopped';
    super(
      `${operation} ${verb} to protect the host from OOM: ` +
      `${formatMib(assessment.availableBytes)}MB of ${formatMib(assessment.totalBytes)}MB system memory available ` +
      `(${Math.round(assessment.availableRatio * 100)}%); ` +
      `at least ${formatMib(assessment.pressureThresholdBytes)}MB is required`,
    );
    this.name = 'IndexingMemoryPressureError';
  }
}

export function isIndexingMemoryPressureError(error: unknown): error is IndexingMemoryPressureError {
  return error instanceof IndexingMemoryPressureError ||
    (!!error && typeof error === 'object' && (error as { code?: unknown }).code === 'INDEXING_MEMORY_PRESSURE');
}

export class IndexingMemoryProtection {
  private readonly sample: () => SystemMemorySnapshot;
  private readonly sampleIntervalMs: number;
  private readonly sustainedPressureSamples: number;
  private readonly sampleCacheMs: number;
  private cachedAssessment: { sampledAt: number; assessment: IndexingMemoryAssessment } | undefined;

  constructor(options: IndexingMemoryProtectionOptions = {}) {
    this.sample = options.sample ?? readSystemMemorySnapshot;
    this.sampleCacheMs = options.sample ? 0 : DEFAULT_SAMPLE_CACHE_MS;
    this.sampleIntervalMs = Math.max(10, Math.floor(options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS));
    this.sustainedPressureSamples = Math.max(
      1,
      Math.floor(options.sustainedPressureSamples ?? DEFAULT_SUSTAINED_PRESSURE_SAMPLES),
    );
  }

  assess(): IndexingMemoryAssessment {
    const now = Date.now();
    if (this.cachedAssessment && now - this.cachedAssessment.sampledAt < this.sampleCacheMs) {
      return this.cachedAssessment.assessment;
    }
    const assessment = assessIndexingMemory(this.sample());
    this.cachedAssessment = { sampledAt: now, assessment };
    return assessment;
  }

  assertCanStart(operation: string): IndexingMemoryAssessment {
    const assessment = this.assess();
    if (assessment.level !== 'healthy') {
      throw new IndexingMemoryPressureError(operation, 'start', assessment);
    }
    return assessment;
  }

  monitor(operation: string, onPressure: (error: IndexingMemoryPressureError) => void): IndexingMemoryMonitor {
    let disposed = false;
    let consecutivePressureSamples = 0;
    const check = () => {
      if (disposed) { return; }
      const assessment = this.assess();
      if (assessment.level === 'healthy') {
        consecutivePressureSamples = 0;
        return;
      }
      consecutivePressureSamples += 1;
      if (
        assessment.level !== 'critical' &&
        consecutivePressureSamples < this.sustainedPressureSamples
      ) {
        return;
      }
      disposed = true;
      clearInterval(timer);
      onPressure(new IndexingMemoryPressureError(operation, 'running', assessment));
    };
    const timer = setInterval(check, this.sampleIntervalMs);
    timer.unref?.();
    return {
      dispose: () => {
        if (disposed) { return; }
        disposed = true;
        clearInterval(timer);
      },
    };
  }
}

export const indexingMemoryProtection = new IndexingMemoryProtection();

export function readSystemMemorySnapshot(): SystemMemorySnapshot {
  let totalBytes = positiveFiniteOr(os.totalmem(), 1);
  let availableBytes = clampAvailable(os.freemem(), totalBytes);
  let source: SystemMemorySnapshot['source'] = 'os-freemem';

  if (process.platform === 'darwin') {
    const pressureAvailableBytes = readDarwinMemoryPressureAvailableBytes(totalBytes);
    if (pressureAvailableBytes !== undefined) {
      availableBytes = clampAvailable(pressureAvailableBytes, totalBytes);
      source = 'darwin-memory-pressure';
    } else {
      const vmStatAvailableBytes = readDarwinVmStatAvailableBytes();
      if (vmStatAvailableBytes !== undefined) {
        availableBytes = clampAvailable(vmStatAvailableBytes, totalBytes);
        source = 'darwin-vm-stat';
      }
    }
  } else if (process.platform === 'linux') {
    const memInfo = readTextFile('/proc/meminfo');
    const memAvailableBytes = parseLinuxMemAvailableBytes(memInfo);
    if (memAvailableBytes !== undefined) {
      availableBytes = clampAvailable(memAvailableBytes, totalBytes);
      source = 'linux-memavailable';
    }

    const cgroupV2 = readCgroupV2Memory();
    const cgroupV1 = cgroupV2 ?? readCgroupV1Memory();
    if (cgroupV1 && cgroupV1.limitBytes <= totalBytes) {
      totalBytes = cgroupV1.limitBytes;
      availableBytes = Math.min(availableBytes, Math.max(0, cgroupV1.limitBytes - cgroupV1.usedBytes));
      source = cgroupV2 ? 'cgroup-v2' : 'cgroup-v1';
    }
  }

  return { totalBytes, availableBytes, source };
}

export function parseLinuxMemAvailableBytes(contents: string | undefined): number | undefined {
  if (!contents) { return undefined; }
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(contents);
  if (!match) { return undefined; }
  const kib = Number(match[1]);
  return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : undefined;
}

export function parseDarwinMemoryPressureAvailableBytes(
  contents: string | undefined,
  totalBytes: number,
): number | undefined {
  if (!contents || !Number.isFinite(totalBytes) || totalBytes <= 0) { return undefined; }
  const match = /System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(contents);
  if (!match) { return undefined; }
  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) { return undefined; }
  return Math.floor(totalBytes * (percent / 100));
}

export function parseDarwinVmStatAvailableBytes(contents: string | undefined): number | undefined {
  if (!contents) { return undefined; }
  const pageSizeMatch = /page size of\s+(\d+)\s+bytes/i.exec(contents);
  if (!pageSizeMatch) { return undefined; }
  const pageSize = Number(pageSizeMatch[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) { return undefined; }
  let availablePages = 0;
  let matchedPageClass = false;
  for (const label of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.\\s*$`, 'm').exec(contents);
    if (!match) { continue; }
    matchedPageClass = true;
    availablePages += Number(match[1]);
  }
  return matchedPageClass && Number.isSafeInteger(availablePages) && availablePages >= 0
    ? availablePages * pageSize
    : undefined;
}

function readDarwinMemoryPressureAvailableBytes(totalBytes: number): number | undefined {
  try {
    const stdout = execFileSync('/usr/bin/memory_pressure', ['-Q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    });
    return parseDarwinMemoryPressureAvailableBytes(stdout, totalBytes);
  } catch {
    return undefined;
  }
}

function readDarwinVmStatAvailableBytes(): number | undefined {
  try {
    const stdout = execFileSync('/usr/bin/vm_stat', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    });
    return parseDarwinVmStatAvailableBytes(stdout);
  } catch {
    return undefined;
  }
}

function readCgroupV2Memory(): { limitBytes: number; usedBytes: number } | undefined {
  return parseCgroupMemoryValues(
    readTextFile('/sys/fs/cgroup/memory.max'),
    readTextFile('/sys/fs/cgroup/memory.current'),
  );
}

function readCgroupV1Memory(): { limitBytes: number; usedBytes: number } | undefined {
  return parseCgroupMemoryValues(
    readTextFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    readTextFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
  );
}

function parseCgroupMemoryValues(
  rawLimit: string | undefined,
  rawUsed: string | undefined,
): { limitBytes: number; usedBytes: number } | undefined {
  if (!rawLimit || !rawUsed || rawLimit.trim() === 'max') { return undefined; }
  const limitBytes = Number(rawLimit.trim());
  const usedBytes = Number(rawUsed.trim());
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 ||
      !Number.isSafeInteger(usedBytes) || usedBytes < 0) {
    return undefined;
  }
  return { limitBytes, usedBytes };
}

function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function positiveFiniteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampAvailable(value: number, totalBytes: number): number {
  if (!Number.isFinite(value) || value < 0) { return 0; }
  return Math.min(totalBytes, Math.floor(value));
}

function formatMib(bytes: number): number {
  return Math.max(0, Math.round(bytes / MIB));
}
