import * as path from 'path';

export interface ElectronExtensionHostContext {
  platform: NodeJS.Platform;
  appRoot: string;
  execPath: string;
  ppid: number;
}

/**
 * Infer the Electron browser-process PID without spawning `ps` when the
 * extension host is the packaged macOS Helper (Plugin) process. Electron
 * launches that helper directly from the browser process, so its PPID is the
 * main process we need for CDP.
 *
 * The check intentionally uses bundle structure instead of product names so
 * renamed builds and VS Code-compatible distributions follow the same rule.
 */
export function inferBundledElectronMainPid(context: ElectronExtensionHostContext): number | null {
  if (context.platform !== 'darwin') { return null; }
  if (!Number.isSafeInteger(context.ppid) || context.ppid <= 1) { return null; }

  const appRoot = path.resolve(context.appRoot);
  const contentsRoot = path.resolve(appRoot, '..', '..');
  if (path.basename(contentsRoot).toLowerCase() !== 'contents') { return null; }
  if (path.basename(path.dirname(appRoot)).toLowerCase() !== 'resources') { return null; }

  const frameworksRoot = path.join(contentsRoot, 'Frameworks');
  const relativeExecPath = path.relative(frameworksRoot, path.resolve(context.execPath));
  if (!relativeExecPath || path.isAbsolute(relativeExecPath)) { return null; }
  const parts = relativeExecPath.split(path.sep);
  if (parts.some((part) => part === '..')) { return null; }
  if (
    parts.length !== 4 ||
    !parts[0].toLowerCase().endsWith('.app') ||
    parts[1].toLowerCase() !== 'contents' ||
    parts[2].toLowerCase() !== 'macos'
  ) {
    return null;
  }

  const helperBundleName = parts[0].slice(0, -4);
  const executableName = parts[3];
  if (!/\bHelper\s*\(Plugin\)$/i.test(helperBundleName)) { return null; }
  if (executableName !== helperBundleName) { return null; }
  return context.ppid;
}
