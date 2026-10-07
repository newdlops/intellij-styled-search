import { WINDOWS_GRAPH_STORAGE_VERSIONS } from './windows/graphStorage';

export function graphStorageVersions(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? WINDOWS_GRAPH_STORAGE_VERSIONS : { cache: 24, native: 16 };
}
