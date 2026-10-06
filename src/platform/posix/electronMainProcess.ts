import { execFile } from 'child_process';
import * as path from 'path';
import { inferBundledElectronMainPid, isDarwinMainProcessCommand } from '../darwin/electronMainProcess';
import { validateInspectorPid, type ElectronMainProcessPlatform, type ElectronProcess } from '../electronProcessTypes';

export function parsePosixProcessSnapshot(output: string): ElectronProcess[] {
  const processes: ElectronProcess[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) { processes.push({ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] }); }
  }
  return processes;
}

export const posixElectronMainProcess: ElectronMainProcessPlatform = {
  inferParentPid: inferBundledElectronMainPid,
  allowGlobalFallback: true,
  readProcessSnapshot() {
    return new Promise((resolve, reject) => {
      execFile(process.platform === 'darwin' ? '/bin/ps' : 'ps', ['-o', 'pid=,ppid=,command=', '-ax'], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000,
      }, (error, stdout) => error ? reject(error) : resolve(parsePosixProcessSnapshot(stdout)));
    });
  },
  isMainProcess(proc, context) {
    if (context.platform === 'darwin') { return isDarwinMainProcessCommand(proc.cmd); }
    // Linux uses the same executable for the browser and its typed children.
    const executable = path.resolve(context.execPath);
    const firstArgument = proc.cmd.match(/^"([^"]+)"|^(\S+)/);
    const commandExecutable = firstArgument?.[1] ?? firstArgument?.[2];
    return !!commandExecutable && path.resolve(commandExecutable) === executable &&
      !/(?:^|\s)--type(?:=|\s|$)/.test(proc.cmd);
  },
  requestInspector(pid) {
    validateInspectorPid(pid);
    process.kill(pid, 'SIGUSR1');
  },
};
