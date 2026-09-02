import * as fs from 'fs';
import * as path from 'path';

const LEGACY_CARGO_TARGET_NAMES = [
  'zoek-rs-target',
  'zoek-rs-target-v2',
  'zoek-rs-target-v3',
] as const;
const RUST_SOURCE_FINGERPRINT_RE = /^[a-f0-9]{24}$/;
const LEGACY_TRIGRAM_INDEX_RE = /^trigram-[a-f0-9]{12}\.json\.gz$/;
const CURRENT_TRIGRAM_INDEX_RE = /^trigram-[a-f0-9]{12}\.v2\.bin$/;
const RUNTIME_STAGE_RE = /^\.tmp-/;
const DAY_MS = 24 * 60 * 60 * 1_000;
const LEGACY_CACHE_MIN_AGE_MS = 7 * DAY_MS;
const ABANDONED_STAGE_MIN_AGE_MS = DAY_MS;
const MAINTENANCE_LOCK_BUCKET_MS = 60 * 60 * 1_000;
const ROLLBACK_RUNTIME_GENERATIONS = 1;
const ROLLBACK_TRIGRAM_INDEXES = 1;
const ROLLBACK_TRIGRAM_BYTES = 640 * 1024 * 1024;

export interface GlobalStorageMaintenanceOptions {
  globalStoragePath: string;
  platformKey: string;
  currentRustSourceFingerprint: string;
  protectedTrigramFileNames?: readonly string[];
  nowMs?: number;
}

export interface GlobalStorageMaintenanceReport {
  removed: string[];
  errors: string[];
  skippedBecauseLocked: boolean;
}

type DirectoryCandidate = {
  path: string;
  minimumAgeMs: number;
};

export async function maintainGlobalStorage(
  options: GlobalStorageMaintenanceOptions,
): Promise<GlobalStorageMaintenanceReport> {
  const report: GlobalStorageMaintenanceReport = {
    removed: [],
    errors: [],
    skippedBecauseLocked: false,
  };
  const nowMs = options.nowMs ?? Date.now();
  const lockPath = path.join(
    options.globalStoragePath,
    `.storage-maintenance-v2-${Math.floor(nowMs / MAINTENANCE_LOCK_BUCKET_MS)}.lock`,
  );
  await fs.promises.mkdir(options.globalStoragePath, { recursive: true });
  if (!(await acquireMaintenanceLock(lockPath))) {
    report.skippedBecauseLocked = true;
    return report;
  }

  try {
    const candidates: DirectoryCandidate[] = LEGACY_CARGO_TARGET_NAMES.map((name) => ({
      path: path.join(options.globalStoragePath, name),
      minimumAgeMs: LEGACY_CACHE_MIN_AGE_MS,
    }));
    candidates.push(...await legacyFingerprintCargoTargets(options));
    candidates.push(...await obsoleteRuntimeGenerations(options));
    candidates.push(...await abandonedRuntimeStages(options));

    for (const candidate of candidates) {
      await removeOldGeneratedDirectory(candidate, nowMs, report);
    }
    await maintainTrigramIndexes(options, nowMs, report);
  } finally {
    await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
  return report;
}

async function acquireMaintenanceLock(lockPath: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function legacyFingerprintCargoTargets(
  options: GlobalStorageMaintenanceOptions,
): Promise<DirectoryCandidate[]> {
  const platformRoot = path.join(
    options.globalStoragePath,
    'zoek-rs',
    'cargo-target',
    options.platformKey,
  );
  return matchingDirectories(platformRoot, RUST_SOURCE_FINGERPRINT_RE, LEGACY_CACHE_MIN_AGE_MS);
}

async function obsoleteRuntimeGenerations(
  options: GlobalStorageMaintenanceOptions,
): Promise<DirectoryCandidate[]> {
  const platformRoot = path.join(
    options.globalStoragePath,
    'zoek-rs',
    'runtime',
    options.platformKey,
  );
  const generations = await directoryStats(platformRoot, RUST_SOURCE_FINGERPRINT_RE);
  const obsolete = generations
    .filter((entry) => entry.name !== options.currentRustSourceFingerprint)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(ROLLBACK_RUNTIME_GENERATIONS);
  return obsolete.map((entry) => ({
    path: path.join(platformRoot, entry.name),
    minimumAgeMs: LEGACY_CACHE_MIN_AGE_MS,
  }));
}

async function abandonedRuntimeStages(
  options: GlobalStorageMaintenanceOptions,
): Promise<DirectoryCandidate[]> {
  const platformRoot = path.join(
    options.globalStoragePath,
    'zoek-rs',
    'runtime',
    options.platformKey,
  );
  const generations = await directoryStats(platformRoot, RUST_SOURCE_FINGERPRINT_RE);
  const candidates: DirectoryCandidate[] = [];
  for (const generation of generations) {
    candidates.push(...await matchingDirectories(
      path.join(platformRoot, generation.name),
      RUNTIME_STAGE_RE,
      ABANDONED_STAGE_MIN_AGE_MS,
    ));
  }
  return candidates;
}

async function matchingDirectories(
  rootPath: string,
  namePattern: RegExp,
  minimumAgeMs: number,
): Promise<DirectoryCandidate[]> {
  const entries = await safeReadDirectory(rootPath);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && namePattern.test(entry.name))
    .map((entry) => ({ path: path.join(rootPath, entry.name), minimumAgeMs }));
}

async function directoryStats(
  rootPath: string,
  namePattern: RegExp,
): Promise<Array<{ name: string; mtimeMs: number }>> {
  const entries = await safeReadDirectory(rootPath);
  const stats = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && namePattern.test(entry.name))
    .map(async (entry) => {
      try {
        const stat = await fs.promises.lstat(path.join(rootPath, entry.name));
        if (!stat.isDirectory() || stat.isSymbolicLink()) { return undefined; }
        return { name: entry.name, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
    }));
  return stats.filter((entry): entry is { name: string; mtimeMs: number } => entry !== undefined);
}

async function safeReadDirectory(rootPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function removeOldGeneratedDirectory(
  candidate: DirectoryCandidate,
  nowMs: number,
  report: GlobalStorageMaintenanceReport,
): Promise<void> {
  try {
    const stat = await fs.promises.lstat(candidate.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || nowMs - stat.mtimeMs < candidate.minimumAgeMs) {
      return;
    }
    await fs.promises.rm(candidate.path, { recursive: true, force: true });
    report.removed.push(candidate.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      report.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function maintainTrigramIndexes(
  options: GlobalStorageMaintenanceOptions,
  nowMs: number,
  report: GlobalStorageMaintenanceReport,
): Promise<void> {
  const protectedNames = new Set(
    (options.protectedTrigramFileNames ?? []).filter((name) => CURRENT_TRIGRAM_INDEX_RE.test(name)),
  );
  const entries = await safeReadDirectory(options.globalStoragePath);
  const inactiveCurrentIndexes: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) { continue; }
    const legacy = LEGACY_TRIGRAM_INDEX_RE.test(entry.name);
    const current = CURRENT_TRIGRAM_INDEX_RE.test(entry.name);
    if (!legacy && !current) { continue; }
    const filePath = path.join(options.globalStoragePath, entry.name);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || nowMs - stat.mtimeMs < LEGACY_CACHE_MIN_AGE_MS) {
        continue;
      }
      if (legacy) {
        await fs.promises.rm(filePath, { force: true });
        report.removed.push(filePath);
      } else if (!protectedNames.has(entry.name)) {
        inactiveCurrentIndexes.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  inactiveCurrentIndexes.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let retainedCount = 0;
  let retainedBytes = 0;
  for (const index of inactiveCurrentIndexes) {
    if (
      retainedCount < ROLLBACK_TRIGRAM_INDEXES &&
      retainedBytes + index.size <= ROLLBACK_TRIGRAM_BYTES
    ) {
      retainedCount += 1;
      retainedBytes += index.size;
      continue;
    }
    try {
      await fs.promises.rm(index.path, { force: true });
      report.removed.push(index.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        report.errors.push(`${index.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
