import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { maintainGlobalStorage } from '../../internal/globalStorageMaintenance';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = Date.UTC(2026, 8, 2, 12);
const PLATFORM_KEY = 'fixture-arm64';
const CURRENT_FINGERPRINT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const LOCK_BUCKET_MS = 60 * 60 * 1_000;

function maintenanceLockName(nowMs: number): string {
  return `.storage-maintenance-v2-${Math.floor(nowMs / LOCK_BUCKET_MS)}.lock`;
}

async function makeDirectory(rootPath: string, relativePath: string, ageMs: number): Promise<string> {
  const directoryPath = path.join(rootPath, relativePath);
  await fs.promises.mkdir(directoryPath, { recursive: true });
  await fs.promises.writeFile(path.join(directoryPath, 'generated.bin'), 'cache');
  const modifiedAt = new Date(NOW_MS - ageMs);
  await fs.promises.utimes(directoryPath, modifiedAt, modifiedAt);
  return directoryPath;
}

async function makeFile(rootPath: string, relativePath: string, ageMs: number): Promise<string> {
  const filePath = path.join(rootPath, relativePath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, 'cache');
  const modifiedAt = new Date(NOW_MS - ageMs);
  await fs.promises.utimes(filePath, modifiedAt, modifiedAt);
  return filePath;
}

async function withStorage(
  run: (rootPath: string) => Promise<void>,
): Promise<void> {
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ijss-global-storage-'));
  try {
    await run(rootPath);
  } finally {
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  }
}

test('removes only obsolete generated storage and keeps active or rollback caches', async () => {
  await withStorage(async (rootPath) => {
    const legacyTarget = await makeDirectory(rootPath, 'zoek-rs-target', 30 * DAY_MS);
    const recentLegacyTarget = await makeDirectory(rootPath, 'zoek-rs-target-v2', 2 * DAY_MS);
    const legacyTargetV3 = await makeDirectory(rootPath, 'zoek-rs-target-v3', 30 * DAY_MS);
    const cargoPlatformRoot = path.join(rootPath, 'zoek-rs', 'cargo-target', PLATFORM_KEY);
    const legacyCargo = await makeDirectory(
      cargoPlatformRoot,
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      30 * DAY_MS,
    );
    const activeCargo = await makeDirectory(cargoPlatformRoot, 'release', 30 * DAY_MS);
    const similarlyNamedCargo = await makeDirectory(
      cargoPlatformRoot,
      'bbbbbbbbbbbbbbbbbbbbbbb-user',
      30 * DAY_MS,
    );

    const runtimePlatformRoot = path.join(rootPath, 'zoek-rs', 'runtime', PLATFORM_KEY);
    const currentRuntime = await makeDirectory(runtimePlatformRoot, CURRENT_FINGERPRINT, 40 * DAY_MS);
    const rollbackRuntime = await makeDirectory(
      runtimePlatformRoot,
      'cccccccccccccccccccccccc',
      20 * DAY_MS,
    );
    const obsoleteRuntime = await makeDirectory(
      runtimePlatformRoot,
      'dddddddddddddddddddddddd',
      30 * DAY_MS,
    );
    const oldStage = await makeDirectory(currentRuntime, '.tmp-abandoned', 2 * DAY_MS);
    const recentStage = await makeDirectory(currentRuntime, '.tmp-active', 2 * 60 * 60 * 1_000);
    const legacyTrigram = await makeFile(rootPath, 'trigram-123456789abc.json.gz', 30 * DAY_MS);
    const protectedTrigram = await makeFile(rootPath, 'trigram-aaaaaaaaaaaa.v2.bin', 30 * DAY_MS);
    const rollbackTrigram = await makeFile(rootPath, 'trigram-bbbbbbbbbbbb.v2.bin', 20 * DAY_MS);
    const obsoleteTrigram = await makeFile(rootPath, 'trigram-cccccccccccc.v2.bin', 30 * DAY_MS);
    const oversizedTrigram = await makeFile(rootPath, 'trigram-dddddddddddd.v2.bin', 10 * DAY_MS);
    await fs.promises.truncate(oversizedTrigram, 641 * 1024 * 1024);
    const oversizedModifiedAt = new Date(NOW_MS - 10 * DAY_MS);
    await fs.promises.utimes(oversizedTrigram, oversizedModifiedAt, oversizedModifiedAt);
    const similarlyNamedFile = await makeFile(rootPath, 'trigram-user-data.json.gz', 30 * DAY_MS);

    const report = await maintainGlobalStorage({
      globalStoragePath: rootPath,
      platformKey: PLATFORM_KEY,
      currentRustSourceFingerprint: CURRENT_FINGERPRINT,
      protectedTrigramFileNames: [path.basename(protectedTrigram)],
      nowMs: NOW_MS,
    });

    assert.equal(report.skippedBecauseLocked, false);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(new Set(report.removed), new Set([
      legacyTarget,
      legacyTargetV3,
      legacyCargo,
      obsoleteRuntime,
      oldStage,
      legacyTrigram,
      obsoleteTrigram,
      oversizedTrigram,
    ]));
    for (const removedPath of report.removed) {
      assert.equal(fs.existsSync(removedPath), false, `${removedPath} should be removed`);
    }
    for (const retainedPath of [
      recentLegacyTarget,
      activeCargo,
      similarlyNamedCargo,
      currentRuntime,
      rollbackRuntime,
      recentStage,
      protectedTrigram,
      rollbackTrigram,
      similarlyNamedFile,
    ]) {
      assert.equal(fs.existsSync(retainedPath), true, `${retainedPath} should be retained`);
    }
    assert.equal(fs.existsSync(path.join(rootPath, maintenanceLockName(NOW_MS))), false);
  });
});

test('an active maintenance lock prevents duplicate cleanup work', async () => {
  await withStorage(async (rootPath) => {
    const legacyTarget = await makeDirectory(rootPath, 'zoek-rs-target', 30 * DAY_MS);
    await fs.promises.mkdir(path.join(rootPath, maintenanceLockName(NOW_MS)));

    const report = await maintainGlobalStorage({
      globalStoragePath: rootPath,
      platformKey: PLATFORM_KEY,
      currentRustSourceFingerprint: CURRENT_FINGERPRINT,
      nowMs: NOW_MS,
    });

    assert.equal(report.skippedBecauseLocked, true);
    assert.deepEqual(report.removed, []);
    assert.equal(fs.existsSync(legacyTarget), true);
  });
});

test('an interrupted prior lock bucket cannot replace or remove the current owner lock', async () => {
  await withStorage(async (rootPath) => {
    const legacyTarget = await makeDirectory(rootPath, 'zoek-rs-target', 30 * DAY_MS);
    const priorLockPath = await makeDirectory(
      rootPath,
      maintenanceLockName(NOW_MS - 2 * LOCK_BUCKET_MS),
      2 * LOCK_BUCKET_MS,
    );

    const report = await maintainGlobalStorage({
      globalStoragePath: rootPath,
      platformKey: PLATFORM_KEY,
      currentRustSourceFingerprint: CURRENT_FINGERPRINT,
      nowMs: NOW_MS,
    });

    assert.equal(report.skippedBecauseLocked, false);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.removed, [legacyTarget]);
    assert.equal(fs.existsSync(priorLockPath), true);
    assert.equal(fs.existsSync(path.join(rootPath, maintenanceLockName(NOW_MS))), false);
  });
});
