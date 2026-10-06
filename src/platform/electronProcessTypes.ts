export interface ElectronExtensionHostContext {
  platform: NodeJS.Platform;
  appRoot: string;
  execPath: string;
  ppid: number;
}

export interface ElectronProcess {
  pid: number;
  ppid: number;
  cmd: string;
  execPath?: string;
}

export interface ElectronMainProcessPlatform {
  inferParentPid(context: ElectronExtensionHostContext): number | null;
  readProcessSnapshot(): Promise<ElectronProcess[]>;
  isMainProcess(proc: ElectronProcess, context: ElectronExtensionHostContext): boolean;
  requestInspector(pid: number): void;
  allowGlobalFallback: boolean;
}

export function validateInspectorPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
    throw new Error(`Invalid Electron main process PID: ${pid}`);
  }
}
