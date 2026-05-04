export const BINARY_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.class', '.o', '.a',
  '.wasm', '.node', '.pyc', '.pyo', '.rmeta', '.rlib',
]);

export function getFileExtension(fsPath: string): string {
  const i = fsPath.lastIndexOf('.');
  return i >= 0 ? fsPath.slice(i).toLowerCase() : '';
}

export function hasBinaryFileExtension(fsPath: string): boolean {
  return BINARY_FILE_EXTENSIONS.has(getFileExtension(fsPath));
}

export function looksBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || hasUtf16Bom(bytes)) {
    return false;
  }
  const sampleLen = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) { return true; }
  }
  return false;
}

export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), false);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push(littleEndian
      ? bytes[i] | (bytes[i + 1] << 8)
      : (bytes[i] << 8) | bytes[i + 1]);
  }
  let out = '';
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.slice(i, i + 8192));
  }
  return out;
}
