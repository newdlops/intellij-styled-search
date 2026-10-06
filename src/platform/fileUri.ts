import { pathToFileURL } from 'url';
import { windowsFileUri } from './windows/fileUri';

export function filePathToUriString(value: string): string {
  return process.platform === 'win32' ? windowsFileUri(value) : pathToFileURL(value).toString();
}
