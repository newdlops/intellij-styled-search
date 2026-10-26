/** Validates explicit local listener addresses without DNS, wildcard binds or external redirects. */
import { isIP } from 'node:net';

export function normalizeLoopbackHost(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, '');
  if (host === 'localhost') { return '127.0.0.1'; }
  if (host === '::1') { return host; }
  if (isIP(host) === 4 && host.split('.')[0] === '127') { return host; }
  throw new Error('MCP host must be an explicit loopback address (127.x.x.x or ::1)');
}

export function loopbackHttpOrigin(host: string, port: number): string {
  const normalized = normalizeLoopbackHost(host);
  return `http://${normalized.includes(':') ? `[${normalized}]` : normalized}:${port}`;
}

/** A custom loopback does not broaden browser-origin access to every local application. */
export function isMatchingLoopbackOrigin(origin: string, host: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && normalizeLoopbackHost(url.hostname) === normalizeLoopbackHost(host);
  } catch { return false; }
}
