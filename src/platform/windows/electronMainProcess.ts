import { execFile } from 'child_process';
import * as path from 'path';
import { validateInspectorPid, type ElectronExtensionHostContext, type ElectronMainProcessPlatform, type ElectronProcess } from '../electronProcessTypes';

// Only fixed script text is sent to PowerShell. Paths and product names are
// compared in TypeScript, so spaces, quotes and Unicode cannot become code.
const PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress',
].join('; ');

export function parseWindowsProcessSnapshot(output: string): ElectronProcess[] {
  const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') { return []; }
    const { ProcessId: pid, ParentProcessId: ppid, CommandLine: cmd, ExecutablePath: execPath } = row as Record<string, unknown>;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 ||
        typeof ppid !== 'number' || !Number.isSafeInteger(ppid) || ppid < 0) { return []; }
    return [{ pid, ppid, cmd: typeof cmd === 'string' ? cmd : '',
      execPath: typeof execPath === 'string' ? execPath : undefined }];
  });
}

export function isWindowsMainProcess(proc: ElectronProcess, context: ElectronExtensionHostContext): boolean {
  if (!proc.cmd) { return false; }
  // CIM's ExecutablePath can be absent without debug privileges even when
  // CommandLine is readable. Its first argument supplies the same structural
  // installation check; ownership is still proved by the ancestor traversal.
  const firstArgument = proc.cmd.match(/^\s*"([^"]+)"|^\s*(\S+)/);
  const executable = proc.execPath || firstArgument?.[1] || firstArgument?.[2];
  if (!executable || !path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) { return false; }
  const normalize = (value: string) => path.win32.normalize(value).toLowerCase();
  // Desktop resources may sit beside the executable or in one versioned
  // child directory used by an update launcher. Use that bundle structure,
  // without depending on the product name or the version directory's name.
  const appRoot = path.win32.normalize(context.appRoot);
  if (path.win32.basename(appRoot).toLowerCase() !== 'app' ||
      path.win32.basename(path.win32.dirname(appRoot)).toLowerCase() !== 'resources') { return false; }
  const bundleDirectory = path.win32.resolve(appRoot, '..', '..');
  const executableDirectory = normalize(path.win32.dirname(executable));
  if (executableDirectory !== normalize(bundleDirectory) &&
      executableDirectory !== normalize(path.win32.dirname(bundleDirectory))) { return false; }
  return !/(?:^|\s|["'])--(?:type(?:=|\s|["']|$)|ms-enable-electron-run-as-node\b)/i.test(proc.cmd);
}

type DebugProcessHost = { _debugProcess?: (pid: number) => void };

export function requestWindowsInspector(pid: number, host: DebugProcessHost = process as DebugProcessHost): void {
  validateInspectorPid(pid);
  if (typeof host._debugProcess !== 'function') {
    throw new Error('Windows inspector activation is unavailable. Start VS Code with --inspect=9229 and retry.');
  }
  // Node's Windows implementation starts the target's registered debug
  // handler with CreateRemoteThread. SIGUSR1 is not a Windows signal.
  // https://github.com/nodejs/node/blob/v22.18.0/src/node_process_methods.cc
  host._debugProcess.call(host, pid);
}

export const windowsElectronMainProcess: ElectronMainProcessPlatform = {
  inferParentPid: () => null,
  // Never signal another installation/window when ancestry cannot be proved.
  allowGlobalFallback: false,
  isMainProcess: isWindowsMainProcess,
  requestInspector: requestWindowsInspector,
  readProcessSnapshot() {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) { reject(error); return; }
        try { resolve(parseWindowsProcessSnapshot(stdout)); } catch (err) { reject(err); }
      });
    });
  },
};
