#!/usr/bin/env node
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as readline from 'readline';

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type CliOptions = {
  command: 'stdio' | 'proxy' | 'health' | 'help';
  workspace: string;
  url?: string;
  port?: number;
  discoveryFile?: string;
  timeoutMs: number;
};

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 30_000;

void main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printUsage();
    return;
  }
  const endpoint = resolveEndpoint(options);
  if (options.command === 'health') {
    const health = await getHealth(endpoint, options.timeoutMs);
    process.stdout.write(health + '\n');
    return;
  }
  await runStdioProxy(endpoint, options.timeoutMs);
}

function parseArgs(argv: string[]): CliOptions {
  const command = readCommand(argv[0]);
  const options: CliOptions = {
    command,
    workspace: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  let i = command === 'help' && argv[0]?.startsWith('-') ? 0 : 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      i++;
      continue;
    }
    const [key, inlineValue] = splitArg(arg);
    const value = inlineValue ?? argv[i + 1];
    const consumedValue = inlineValue === undefined;
    switch (key) {
      case '--workspace':
      case '-w':
        requireValue(key, value);
        options.workspace = path.resolve(value);
        i += consumedValue ? 2 : 1;
        break;
      case '--url':
        requireValue(key, value);
        options.url = value;
        i += consumedValue ? 2 : 1;
        break;
      case '--port':
        requireValue(key, value);
        options.port = parsePositiveInt(value, key);
        i += consumedValue ? 2 : 1;
        break;
      case '--discovery-file':
        requireValue(key, value);
        options.discoveryFile = path.resolve(value);
        i += consumedValue ? 2 : 1;
        break;
      case '--connect-timeout-ms':
      case '--timeout-ms':
        requireValue(key, value);
        options.timeoutMs = parsePositiveInt(value, key);
        i += consumedValue ? 2 : 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readCommand(raw: string | undefined): CliOptions['command'] {
  if (!raw || raw === 'stdio') { return 'stdio'; }
  if (raw === 'proxy' || raw === 'http-proxy') { return 'proxy'; }
  if (raw === 'health') { return 'health'; }
  if (raw === '--help' || raw === '-h' || raw === 'help') { return 'help'; }
  throw new Error(`unknown command: ${raw}`);
}

function resolveEndpoint(options: CliOptions): URL {
  const explicit = options.url ?? process.env.CODEIDX_MCP_URL;
  if (explicit) { return normalizeMcpUrl(explicit); }

  const discovery = readDiscoveryFile(options.discoveryFile ?? path.join(options.workspace, '.codeidx', 'mcp-server.json'));
  if (discovery?.url) { return normalizeMcpUrl(discovery.url); }

  return normalizeMcpUrl(`http://127.0.0.1:${options.port ?? DEFAULT_PORT}/mcp`);
}

function readDiscoveryFile(filePath: string): { url?: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { url?: unknown; transport?: unknown };
    if (typeof parsed.url === 'string' && (!parsed.transport || parsed.transport === 'http')) {
      return { url: parsed.url };
    }
  } catch {}
  return undefined;
}

function normalizeMcpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported MCP proxy URL protocol: ${url.protocol}`);
  }
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/mcp';
  }
  return url;
}

async function runStdioProxy(endpoint: URL, timeoutMs: number): Promise<void> {
  log(`stdio proxy forwarding to ${endpoint.toString()}`);
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { return; }
    chain = chain
      .then(() => forwardLine(endpoint, trimmed, timeoutMs))
      .catch((err) => {
        log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      void chain.finally(resolve);
    });
  });
}

async function forwardLine(endpoint: URL, line: string, timeoutMs: number): Promise<void> {
  let message: JsonRpcMessage | JsonRpcMessage[];
  try {
    message = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
  } catch (err) {
    writeStdoutJson(jsonRpcError(null, -32700, err instanceof Error ? err.message : String(err)));
    return;
  }

  try {
    const responseText = await postJson(endpoint, line, timeoutMs);
    if (responseText.trim().length === 0) { return; }
    process.stdout.write(responseText.replace(/\n+$/g, '') + '\n');
  } catch (err) {
    const response = errorResponseForMessage(message, err instanceof Error ? err.message : String(err));
    if (response) {
      writeStdoutJson(response);
    }
  }
}

function errorResponseForMessage(message: JsonRpcMessage | JsonRpcMessage[], messageText: string): Record<string, unknown> | Record<string, unknown>[] | null {
  if (Array.isArray(message)) {
    const responses = message
      .filter((item) => Object.prototype.hasOwnProperty.call(item, 'id'))
      .map((item) => jsonRpcError(item.id ?? null, -32000, `codeidx HTTP MCP endpoint unavailable: ${messageText}`));
    return responses.length > 0 ? responses : null;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) { return null; }
  return jsonRpcError(message.id ?? null, -32000, `codeidx HTTP MCP endpoint unavailable: ${messageText}`);
}

function postJson(endpoint: URL, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const transport = endpoint.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400 && !looksJson(text)) {
          reject(new Error(`HTTP ${res.statusCode ?? 0}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getHealth(endpoint: URL, timeoutMs: number): Promise<string> {
  const health = new URL(endpoint.toString());
  health.pathname = '/health';
  health.search = '';
  return new Promise((resolve, reject) => {
    const transport = health.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: health.hostname,
      port: health.port,
      path: health.pathname,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function writeStdoutJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function splitArg(arg: string): [string, string | undefined] {
  const idx = arg.indexOf('=');
  return idx === -1 ? [arg, undefined] : [arg.slice(0, idx), arg.slice(idx + 1)];
}

function requireValue(key: string, value: string | undefined): asserts value is string {
  if (!value) { throw new Error(`${key} requires a value`); }
}

function parsePositiveInt(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return Math.floor(parsed);
}

function looksJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function log(message: string): void {
  process.stderr.write(`[codeidx-mcp] ${message}\n`);
}

function printUsage(): void {
  process.stderr.write([
    'Usage:',
    '  codeidx-mcp stdio [--workspace <path>] [--url <http://127.0.0.1:8765/mcp>] [--port <port>]',
    '  codeidx-mcp proxy --url <http://127.0.0.1:8765/mcp>',
    '  codeidx-mcp health [--workspace <path>] [--url <http://127.0.0.1:8765/mcp>]',
    '',
    'The stdio command forwards newline-delimited MCP JSON-RPC messages to the VSCode extension HTTP endpoint.',
    'If --url is omitted, CODEIDX_MCP_URL, <workspace>/.codeidx/mcp-server.json, then port 8765 are tried.',
    '',
  ].join('\n'));
}
