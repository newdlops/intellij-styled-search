import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'child_process';
import { findAncestorElectronMainProcess, getElectronMainProcessPlatform, inferBundledElectronMainPid, type ElectronProcess } from '../../electronMainProcess';
import { isWindowsMainProcess, parseWindowsProcessSnapshot, requestWindowsInspector, windowsElectronMainProcess } from '../../platform/windows/electronMainProcess';
import { canPassSearchCandidates } from '../../platform/commandLine';
import { windowsCommandLineLength, fitsWindowsCommandLine, WINDOWS_COMMAND_LINE_LIMIT } from '../../platform/windows/commandLine';
import { windowsFileUri } from '../../platform/windows/fileUri';
import { graphStorageVersions } from '../../platform/graphStorage';

const host = {
  platform: 'win32' as const,
  execPath: "C:\\Portable Tools\\사용자's Workbench\\Workbench.exe",
  appRoot: "C:\\Portable Tools\\사용자's Workbench\\resources\\app",
  ppid: 220,
};

function proc(pid: number, ppid: number, args = '', execPath = host.execPath): ElectronProcess {
  return { pid, ppid, execPath, cmd: `"${execPath}" ${args}`.trim() };
}

test('discovers the owning Windows main through typed Electron ancestors among multiple installations', () => {
  const snapshot = [
    proc(99, 1),
    proc(201, 1, '', 'C:\\Other Workbench\\Workbench.exe'),
    proc(120, 1),
    proc(220, 120, '--type=utility --utility-sub-type=node.mojom.NodeService'),
    proc(330, 220, '--type=renderer'),
  ];
  assert.equal(findAncestorElectronMainProcess(snapshot, 330, 220, (p) => isWindowsMainProcess(p, host))?.pid, 120);
  assert.equal(isWindowsMainProcess(proc(120, 1, '', host.execPath.toUpperCase()), host), true);
  assert.equal(isWindowsMainProcess(proc(220, 120, '"--type=utility"'), host), false);
  assert.equal(isWindowsMainProcess(proc(220, 120, '--ms-enable-electron-run-as-node'), host), false);
  assert.equal(windowsElectronMainProcess.allowGlobalFallback, false);
});

test('does not attach a Windows remote host or broken ancestry to an unrelated desktop process', () => {
  const unrelated = proc(99, 1);
  assert.equal(isWindowsMainProcess(unrelated, { ...host, appRoot: 'C:\\server\\out' }), false);
  assert.equal(findAncestorElectronMainProcess([unrelated, proc(220, 330, '--type=utility'),
    proc(330, 220, '--type=renderer')], 330, 220, (p) => isWindowsMainProcess(p, host)), undefined);
  assert.equal(findAncestorElectronMainProcess([unrelated], 330, 220, (p) => isWindowsMainProcess(p, host)), undefined);
  assert.equal(isWindowsMainProcess({ ...unrelated, execPath: undefined }, host), true);
  assert.equal(isWindowsMainProcess({ ...unrelated, execPath: undefined, cmd: '' }, host), false);
  assert.equal(isWindowsMainProcess(unrelated, { ...host,
    execPath: "C:\\Portable Tools\\사용자's Workbench\\resources\\app\\node_modules\\runtime\\node.exe" }), true);
});

test('Windows update launchers can own resources in a versioned child directory', () => {
  const versionedHost = { ...host, appRoot: pathForVersionedResources() };
  const snapshot = [proc(120, 1), proc(220, 120, '--type=utility'), proc(330, 220, '--type=renderer')];
  assert.equal(findAncestorElectronMainProcess(snapshot, 330, 220,
    (p) => isWindowsMainProcess(p, versionedHost))?.pid, 120);
  assert.equal(isWindowsMainProcess({ ...proc(120, 1), execPath: undefined }, versionedHost), true);
  assert.equal(isWindowsMainProcess(proc(220, 120, '--type=utility'), versionedHost), false);
  assert.equal(isWindowsMainProcess(proc(220, 120, '--ms-enable-electron-run-as-node'), versionedHost), false);
  assert.equal(isWindowsMainProcess(proc(120, 1, '', 'C:\\Portable Tools\\Launcher.exe'), versionedHost), false);
  assert.equal(isWindowsMainProcess(proc(120, 1, '', 'C:\\Other Workbench\\Workbench.exe'), versionedHost), false);
});

function pathForVersionedResources(): string {
  return "C:\\Portable Tools\\사용자's Workbench\\version 2\\resources\\app";
}

test('parses CIM JSON arrays, single rows, BOM, unavailable command lines and Unicode', () => {
  const row = { ProcessId: 120, ParentProcessId: 1, ExecutablePath: host.execPath, CommandLine: `"${host.execPath}"` };
  assert.deepEqual(parseWindowsProcessSnapshot('\uFEFF' + JSON.stringify(row)), [proc(120, 1)]);
  const snapshot = parseWindowsProcessSnapshot(JSON.stringify([row, { ProcessId: 220, ParentProcessId: 120,
    ExecutablePath: null, CommandLine: null }, { ProcessId: -1, ParentProcessId: 0 }]));
  assert.equal(snapshot.length, 2);
  assert.equal(isWindowsMainProcess(snapshot[1], host), false);
  assert.deepEqual(parseWindowsProcessSnapshot('[]'), []);
  assert.throws(() => parseWindowsProcessSnapshot('invalid json'));
});

test('Windows inspector activation uses the native debug hook and rejects invalid PIDs first', () => {
  const calls: number[] = [];
  const debugHost = { _debugProcess(pid: number) { assert.equal(this, debugHost); calls.push(pid); } };
  requestWindowsInspector(120, debugHost);
  assert.deepEqual(calls, [120]);
  for (const pid of [0, -1, 1, NaN, 1.5, 0x80000000]) {
    assert.throws(() => requestWindowsInspector(pid, debugHost), /Invalid Electron main process PID/);
  }
  assert.deepEqual(calls, [120]);
  assert.throws(() => requestWindowsInspector(120, {}), /--inspect=9229/);
  assert.throws(() => requestWindowsInspector(120, { _debugProcess() { throw new Error('access denied'); } }), /access denied/);
  assert.equal(getElectronMainProcessPlatform('win32'), windowsElectronMainProcess);
  assert.notEqual(getElectronMainProcessPlatform('darwin'), windowsElectronMainProcess);
});

test('macOS bundle inference remains independent of Windows path semantics', () => {
  const root = '/Applications/Renamed Editor.app/Contents';
  assert.equal(inferBundledElectronMainPid({ platform: 'darwin', appRoot: root + '/Resources/app',
    execPath: root + '/Frameworks/Renamed Editor Helper (Plugin).app/Contents/MacOS/Renamed Editor Helper (Plugin)',
    ppid: 120 }), 120);
});

test('Windows search argument budgets count UTF-16, quotes, backslashes and the executable', () => {
  assert.equal(windowsCommandLineLength('rg.exe', []), 7);
  assert.equal(windowsCommandLineLength('rg.exe', ['']), 10);
  assert.equal(windowsCommandLineLength('rg.exe', ['a b\\']), 15);
  assert.equal(windowsCommandLineLength('rg.exe', ['a"b']), 14);
  assert.equal(windowsCommandLineLength('rg.exe', ['😀']), 10);
  assert.equal(fitsWindowsCommandLine('rg.exe', ['a'.repeat(WINDOWS_COMMAND_LINE_LIMIT - 8)]), true);
  assert.equal(fitsWindowsCommandLine('rg.exe', ['a'.repeat(WINDOWS_COMMAND_LINE_LIMIT - 7)]), false);
  const paths = Array.from({ length: 450 }, (_, i) => `C:\\Work Space\\${'subdirectory\\'.repeat(8)}${i}.ts`);
  assert.equal(canPassSearchCandidates('C:\\Tools\\rg.exe', ['-e', 'value'], paths, 'win32'), false);
  assert.equal(canPassSearchCandidates('/usr/bin/rg', ['-e', 'value'], paths, 'darwin'), true);
  assert.equal(canPassSearchCandidates('rg.exe', ['-e', 'value'], paths.slice(0, 5), 'win32'), true);
});

test('Windows file URIs share VS Code drive/UNC identity and encode reserved characters', () => {
  assert.equal(windowsFileUri('C:\\Work Space\\한글\\source#.ts'),
    'file:///c%3A/Work%20Space/%ED%95%9C%EA%B8%80/source%23.ts');
  assert.equal(windowsFileUri('\\\\?\\D:\\src\\a%20b.ts'), 'file:///d%3A/src/a%2520b.ts');
  assert.equal(windowsFileUri('\\\\SERVER\\Share\\a b.ts'), 'file://server/Share/a%20b.ts');
  assert.equal(windowsFileUri('\\\\?\\UNC\\SERVER\\Share\\a b.ts'), 'file://server/Share/a%20b.ts');
});

test('native Windows CIM snapshot includes the running Node host', { skip: process.platform !== 'win32' }, async () => {
  const snapshot = await windowsElectronMainProcess.readProcessSnapshot();
  assert.equal(snapshot.find((p) => p.pid === process.pid)?.ppid, process.ppid);
});

test('usage binding migration invalidates old overlays while retaining platform URI versions', () => {
  assert.deepEqual(graphStorageVersions('win32'), { cache: 24, native: 16 });
  assert.deepEqual(graphStorageVersions('darwin'), { cache: 23, native: 15 });
});

test('native Windows inspector activation starts a running child without SIGUSR1', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, async () => {
  const child = spawn(process.execPath, ['--inspect-port=0', '-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Windows inspector activation timed out')), 10_000);
    });
    const listening = new Promise<string>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        const address = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
        if (address) { resolve(address[0]); }
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`child exited before inspector activation: ${code}`)));
    });
    await Promise.race([deadline, new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
    })]);
    assert.ok(child.pid);
    requestWindowsInspector(child.pid);
    assert.match(await Promise.race([deadline, listening]), /^ws:\/\/127\.0\.0\.1:/);
  } finally {
    if (timeout) { clearTimeout(timeout); }
    child.kill();
  }
});
