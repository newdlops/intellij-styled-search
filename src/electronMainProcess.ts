import type { ElectronMainProcessPlatform, ElectronProcess } from './platform/electronProcessTypes';
import { posixElectronMainProcess } from './platform/posix/electronMainProcess';
import { windowsElectronMainProcess } from './platform/windows/electronMainProcess';

export { inferBundledElectronMainPid } from './platform/darwin/electronMainProcess';
export type { ElectronExtensionHostContext, ElectronProcess } from './platform/electronProcessTypes';

export function getElectronMainProcessPlatform(platform: NodeJS.Platform = process.platform): ElectronMainProcessPlatform {
  return platform === 'win32' ? windowsElectronMainProcess : posixElectronMainProcess;
}

/** Only ancestors may establish ownership of a main process. */
export function findAncestorElectronMainProcess(
  snapshot: readonly ElectronProcess[],
  pid: number,
  ppid: number,
  isMain: (proc: ElectronProcess) => boolean,
): ElectronProcess | undefined {
  const processes = new Map(snapshot.map((proc) => [proc.pid, proc]));
  const visited = new Set<number>();
  let cursor = processes.get(pid)?.ppid ?? ppid;
  while (cursor > 0 && !visited.has(cursor)) {
    visited.add(cursor);
    const proc = processes.get(cursor);
    if (!proc) { break; }
    if (isMain(proc)) { return proc; }
    cursor = proc.ppid;
  }
  const parent = processes.get(ppid);
  return parent && isMain(parent) ? parent : undefined;
}
