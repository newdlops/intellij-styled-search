import * as path from 'path';
import type { ElectronExtensionHostContext } from '../electronProcessTypes';

/** Electron launches the packaged macOS Helper (Plugin) from its main process. */
export function inferBundledElectronMainPid(context: ElectronExtensionHostContext): number | null {
  if (context.platform !== 'darwin') { return null; }
  if (!Number.isSafeInteger(context.ppid) || context.ppid <= 1) { return null; }

  // Use POSIX paths even when this structural rule is tested on Windows.
  const appRoot = path.posix.resolve(context.appRoot);
  const contentsRoot = path.posix.resolve(appRoot, '..', '..');
  if (path.posix.basename(contentsRoot).toLowerCase() !== 'contents') { return null; }
  if (path.posix.basename(path.posix.dirname(appRoot)).toLowerCase() !== 'resources') { return null; }

  const frameworksRoot = path.posix.join(contentsRoot, 'Frameworks');
  const relativeExecPath = path.posix.relative(frameworksRoot, path.posix.resolve(context.execPath));
  if (!relativeExecPath || path.posix.isAbsolute(relativeExecPath)) { return null; }
  const parts = relativeExecPath.split('/');
  if (parts.some((part) => part === '..')) { return null; }
  if (
    parts.length !== 4 ||
    !parts[0].toLowerCase().endsWith('.app') ||
    parts[1].toLowerCase() !== 'contents' ||
    parts[2].toLowerCase() !== 'macos'
  ) { return null; }

  const helperBundleName = parts[0].slice(0, -4);
  if (!/\bHelper\s*\(Plugin\)$/i.test(helperBundleName)) { return null; }
  return parts[3] === helperBundleName ? context.ppid : null;
}

export function isDarwinMainProcessCommand(cmd: string): boolean {
  if (/Helper(?:\.app|\s|\))/.test(cmd)) { return false; }
  return [
    /\/Visual Studio Code\.app\/Contents\/MacOS\/(?:Electron|Code)(?:\s|$)/,
    /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\/(?:Electron|Code - Insiders)(?:\s|$)/,
    /\/VSCodium\.app\/Contents\/MacOS\/(?:Electron|VSCodium)(?:\s|$)/,
    /\/Code - OSS\.app\/Contents\/MacOS\/(?:Electron|Code - OSS)(?:\s|$)/,
    /\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/,
  ].some((pattern) => pattern.test(cmd));
}
