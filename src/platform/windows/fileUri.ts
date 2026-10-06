/** Serialize Windows paths with the same identity as vscode.Uri.file. */
export function windowsFileUri(value: string): string {
  let normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('//?/')) {
    const rest = normalized.slice(4);
    normalized = /^UNC\//i.test(rest) ? '//' + rest.slice(4) : rest;
  }
  const encode = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  const encodePath = (part: string) => part.split('/').map(encode).join('/');
  if (normalized.startsWith('//')) {
    const slash = normalized.indexOf('/', 2);
    const server = slash < 0 ? normalized.slice(2) : normalized.slice(2, slash);
    const uriPath = slash < 0 ? '/' : normalized.slice(slash);
    return 'file://' + encode(server.toLowerCase()) + encodePath(uriPath);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return 'file:///' + encodePath(normalized.replace(/^\/+/, ''));
}
