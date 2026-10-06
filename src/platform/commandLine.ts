import { fitsWindowsCommandLine } from './windows/commandLine';

/** Keep the existing POSIX path-count cap and apply the Windows bytecode-unit limit. */
export function canPassSearchCandidates(
  command: string,
  args: readonly string[],
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (candidates.length === 0 || candidates.length > 5000) { return false; }
  return platform !== 'win32' || fitsWindowsCommandLine(command, [...args, '--', ...candidates]);
}
