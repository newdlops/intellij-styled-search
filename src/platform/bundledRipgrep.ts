import * as path from 'path';

export function bundledRipgrepCandidates(appRoot: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'rg.exe' : 'rg';
  return ['node_modules.asar.unpacked', 'node_modules'].flatMap(directory => [
    paths.join(appRoot, directory, '@vscode', 'ripgrep-universal', 'bin', `${platform}-${arch}`, executable),
    paths.join(appRoot, directory, '@vscode', 'ripgrep', 'bin', executable),
  ]);
}
