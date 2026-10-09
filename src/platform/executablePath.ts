import * as path from 'path';

/** Preserve Windows extended-length paths through executable resolution. */
export function executablePath(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && path.win32.isAbsolute(file)
    ? path.win32.toNamespacedPath(file)
    : file;
}
