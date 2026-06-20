#!/usr/bin/env node
import * as crypto from 'crypto';
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

type EndpointHealth = {
  ok: boolean;
  workspaceId?: string;
  mismatch?: boolean;
  message?: string;
};

type SetupFileStatus = {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'skipped' | 'error';
  error?: string;
};

type AutoSetupStatus = {
  attempted: boolean;
  workspace_root: string;
  codeidx_dir: SetupFileStatus;
  stdio_launcher: SetupFileStatus;
  mcp_json: SetupFileStatus;
  codex_config: SetupFileStatus;
  global_config_policy: 'project_local_only';
  global_codex_config: SetupFileStatus;
  ready_for_next_client: boolean;
  requires_vscode_extension: boolean;
  next_steps: string[];
};

type OfflineMcpState = {
  reason: string;
  message: string;
  workspace: string;
  workspaceId: string;
  discoveryPath: string;
  discovery: Record<string, unknown>;
  controlPath: string;
  control: Record<string, unknown>;
  autoSetup: AutoSetupStatus;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const STDIO_INITIAL_DISCOVERY_TIMEOUT_MS = 1_500;
const STDIO_REDISCOVERY_TIMEOUT_MS = 250;
const SCHEMA_VERSION = 'codeidx.mcp/0.1';
const MCP_CONTROL_FILE = 'mcp-control.json';
const TARGET_MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  TARGET_MCP_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
]);
const OFFLINE_HEALTH_TOOL = {
  name: 'mcp_health',
  title: 'MCP Health',
  description: 'Report whether the workspace Codeidx MCP endpoint is running and whether local MCP setup is present.',
  inputSchema: {
    type: 'object',
    properties: {
      include_tools: { type: 'boolean', default: false },
      include_discovery: { type: 'boolean', default: true },
      include_agent_policy: { type: 'boolean', default: true },
      max_chars: { type: 'integer', minimum: 1000, maximum: 200000, default: 100000 },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
const OFFLINE_START_TOOL = {
  name: 'mcp_start',
  title: 'Start MCP Endpoint',
  description: 'Ask the VS Code extension control API to start this workspace Codeidx MCP endpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 5000 },
      max_chars: { type: 'integer', minimum: 1000, maximum: 200000, default: 100000 },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};
const OFFLINE_TOOLS = [OFFLINE_HEALTH_TOOL, OFFLINE_START_TOOL];

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
  const initialTimeoutMs = options.command === 'stdio'
    ? Math.min(options.timeoutMs, STDIO_INITIAL_DISCOVERY_TIMEOUT_MS)
    : options.timeoutMs;
  const endpoint = await tryResolveEndpoint({ ...options, timeoutMs: initialTimeoutMs });
  if (options.command === 'health') {
    if (endpoint) {
      const health = await getHealth(endpoint, options.timeoutMs);
      process.stdout.write(health + '\n');
      return;
    }
    const offline = buildOfflineMcpState(options, 'endpoint_not_discovered');
    process.stdout.write(JSON.stringify(offlineHealthEnvelope(offline, {}, false)) + '\n');
    return;
  }
  await runStdioProxy(endpoint, options, endpoint ? undefined : buildOfflineMcpState(options, 'endpoint_not_discovered'));
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
        options.port = parsePort(value, key);
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

async function resolveEndpoint(options: CliOptions): Promise<URL> {
  const discoveryPath = options.discoveryFile ?? path.join(options.workspace, '.codeidx', 'mcp-server.json');
  const expectedWorkspaceId = workspaceIdFor(options.workspace);
  if (options.url) {
    const endpoint = normalizeMcpUrl(options.url);
    if (options.command === 'proxy') { return endpoint; }
    const health = await checkEndpointHealth(endpoint, Math.min(1_000, options.timeoutMs), expectedWorkspaceId);
    if (health.ok) { return endpoint; }
    if (health.mismatch) {
      throw new Error(
        `explicit MCP endpoint ${endpoint.toString()} is for ${health.workspaceId ?? 'unknown workspace'}, ` +
        `not workspace ${options.workspace}`,
      );
    }
    throw new Error(
      `explicit MCP endpoint ${endpoint.toString()} failed workspace health validation: ` +
      `${health.message ?? 'unknown error'}`,
    );
  }

  const envEndpoint = normalizeOptionalUrl(process.env.CODEIDX_MCP_URL, 'CODEIDX_MCP_URL');
  if (envEndpoint) {
    const health = await checkEndpointHealth(envEndpoint, Math.min(1_000, options.timeoutMs), expectedWorkspaceId);
    if (health.ok) { return envEndpoint; }
    if (health.mismatch) {
      log(
        `ignoring CODEIDX_MCP_URL ${envEndpoint.toString()} for workspace ${options.workspace}; ` +
        `endpoint reports ${health.workspaceId ?? 'unknown workspace'}`,
      );
    }
  }

  const initialDiscovery = readDiscoveryFile(discoveryPath, expectedWorkspaceId);
  if (initialDiscovery?.url) {
    const endpoint = normalizeMcpUrl(initialDiscovery.url);
    const health = await checkEndpointHealth(endpoint, Math.min(1_000, options.timeoutMs), expectedWorkspaceId);
    if (health.ok) {
      return endpoint;
    }
  }

  if (options.port !== undefined) {
    return normalizeMcpUrl(`http://127.0.0.1:${options.port}/mcp`);
  }

  const deadline = Date.now() + options.timeoutMs;
  do {
    const discovery = readDiscoveryFile(discoveryPath, expectedWorkspaceId);
    if (discovery?.url) {
      const endpoint = normalizeMcpUrl(discovery.url);
      const health = await checkEndpointHealth(endpoint, Math.min(1_000, Math.max(100, deadline - Date.now())), expectedWorkspaceId);
      if (health.ok) {
        return endpoint;
      }
    }
    if (Date.now() >= deadline) { break; }
    await delay(200);
  } while (true);

  throw new Error(
    `codeidx MCP endpoint was not discovered for workspace ${options.workspace}. ` +
    `Start the VS Code Codeidx MCP server for this workspace, or pass --url/--port explicitly.`,
  );
}

async function tryResolveEndpoint(options: CliOptions): Promise<URL | undefined> {
  try {
    return await resolveEndpoint(options);
  } catch {
    return undefined;
  }
}

async function checkEndpointHealth(endpoint: URL, timeoutMs: number, expectedWorkspaceId?: string): Promise<EndpointHealth> {
  try {
    const raw = await getHealth(endpoint, timeoutMs);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, message: 'health response was not an object' };
    }
    if (parsed.ok !== true && parsed.running !== true) {
      return { ok: false, message: 'endpoint health did not report ok' };
    }
    const workspaceId = extractWorkspaceId(parsed);
    if (expectedWorkspaceId) {
      if (!workspaceId) {
        return { ok: false, message: 'endpoint health did not report workspace_id' };
      }
      if (workspaceId !== expectedWorkspaceId) {
        return { ok: false, workspaceId, mismatch: true };
      }
    }
    return { ok: true, workspaceId };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function readDiscoveryFile(filePath: string, expectedWorkspaceId: string): { url?: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      url?: unknown;
      transport?: unknown;
      workspace_id?: unknown;
    };
    if (typeof parsed.url === 'string' && (!parsed.transport || parsed.transport === 'http')) {
      if (typeof parsed.workspace_id === 'string' && parsed.workspace_id !== expectedWorkspaceId) {
        return undefined;
      }
      return { url: parsed.url };
    }
  } catch {}
  return undefined;
}

function readDiscoveryStatus(filePath: string, expectedWorkspaceId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const url = typeof parsed.url === 'string' ? parsed.url : null;
    const workspaceId = typeof parsed.workspace_id === 'string' ? parsed.workspace_id : null;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
    const pidAlive = pid !== null ? isProcessAlive(pid) : null;
    return {
      exists: true,
      path: filePath,
      url,
      workspace_id: workspaceId,
      expected_workspace_id: expectedWorkspaceId,
      workspace_id_matches: workspaceId === expectedWorkspaceId,
      pid,
      pid_alive: pidAlive,
      stale: workspaceId !== expectedWorkspaceId || pidAlive === false,
      status_reason: workspaceId !== expectedWorkspaceId
        ? 'workspace_mismatch'
        : pidAlive === false
          ? 'dead_process'
          : 'endpoint_unverified',
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : null,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
      lease_expires_at: typeof parsed.lease_expires_at === 'string' ? parsed.lease_expires_at : null,
    };
  } catch (err) {
    return {
      exists: false,
      path: filePath,
      expected_workspace_id: expectedWorkspaceId,
      stale: true,
      status_reason: 'missing_or_unreadable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readControlStatus(filePath: string, expectedWorkspaceId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const url = typeof parsed.url === 'string' ? parsed.url : null;
    const workspaceId = typeof parsed.workspace_id === 'string' ? parsed.workspace_id : null;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
    const pidAlive = pid !== null ? isProcessAlive(pid) : null;
    const tokenPresent = typeof parsed.token === 'string' && parsed.token.length > 0;
    const workspaceMatches = workspaceId === expectedWorkspaceId;
    const available = typeof url === 'string' && tokenPresent && workspaceMatches && pidAlive !== false;
    return {
      exists: true,
      path: filePath,
      url,
      health_url: typeof parsed.health_url === 'string' ? parsed.health_url : null,
      workspace_id: workspaceId,
      expected_workspace_id: expectedWorkspaceId,
      workspace_id_matches: workspaceMatches,
      pid,
      pid_alive: pidAlive,
      token_present: tokenPresent,
      available,
      stale: !available,
      status_reason: workspaceMatches
        ? pidAlive === false
          ? 'dead_process'
          : tokenPresent && typeof url === 'string'
            ? 'control_available'
            : 'missing_control_url_or_token'
        : 'workspace_mismatch',
      mcp_endpoint: typeof parsed.mcp_endpoint === 'string' ? parsed.mcp_endpoint : null,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
      lease_expires_at: typeof parsed.lease_expires_at === 'string' ? parsed.lease_expires_at : null,
    };
  } catch (err) {
    return {
      exists: false,
      path: filePath,
      expected_workspace_id: expectedWorkspaceId,
      available: false,
      stale: true,
      status_reason: 'missing_or_unreadable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type ControlFileRead =
  | { ok: true; url: string; token: string }
  | { ok: false; code: string; message: string };

function readControlFile(filePath: string, expectedWorkspaceId: string): ControlFileRead {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      code: 'mcp_control_unavailable',
      message: `Workspace MCP control file is not available at ${filePath}: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  const workspaceId = typeof parsed.workspace_id === 'string' ? parsed.workspace_id : undefined;
  if (workspaceId !== expectedWorkspaceId) {
    return {
      ok: false,
      code: 'mcp_control_workspace_mismatch',
      message: `Workspace MCP control file belongs to ${workspaceId ?? 'unknown workspace'}, not ${expectedWorkspaceId}.`,
    };
  }
  const url = typeof parsed.url === 'string' ? parsed.url : undefined;
  const token = typeof parsed.token === 'string' ? parsed.token : undefined;
  if (!url || !token) {
    return {
      ok: false,
      code: 'mcp_control_unavailable',
      message: 'Workspace MCP control file is missing the control URL or token.',
    };
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
  if (pid !== undefined && !isProcessAlive(pid)) {
    return {
      ok: false,
      code: 'mcp_control_stale',
      message: `Workspace MCP control owner process ${pid} is not running.`,
    };
  }
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${endpoint.protocol}`);
    }
  } catch (err) {
    return {
      ok: false,
      code: 'mcp_control_invalid_url',
      message: `Workspace MCP control URL is invalid: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
  return { ok: true, url, token };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

function normalizeOptionalUrl(value: string | undefined, label: string): URL | undefined {
  if (!value) { return undefined; }
  try {
    return normalizeMcpUrl(value);
  } catch (err) {
    log(`ignoring invalid ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function workspaceIdFor(workspace: string): string {
  return `ws_${stableHash(path.resolve(workspace)).slice(0, 12)}`;
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractWorkspaceId(value: unknown): string | undefined {
  if (!isRecord(value)) { return undefined; }
  if (typeof value.workspace_id === 'string') { return value.workspace_id; }
  const snapshot = value.snapshot;
  if (isRecord(snapshot) && typeof snapshot.workspace_id === 'string') {
    return snapshot.workspace_id;
  }
  const health = value.health;
  if (isRecord(health) && typeof health.workspace_id === 'string') {
    return health.workspace_id;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runStdioProxy(initialEndpoint: URL | undefined, options: CliOptions, offlineState?: OfflineMcpState): Promise<void> {
  let endpoint = initialEndpoint;
  if (endpoint) {
    log(`stdio proxy forwarding to ${endpoint.toString()}`);
  } else {
    log(`stdio proxy running in offline health mode for workspace ${options.workspace}`);
  }
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
      .then(async () => {
        if (!endpoint) {
          endpoint = await tryResolveEndpoint({ ...options, timeoutMs: STDIO_REDISCOVERY_TIMEOUT_MS });
          if (endpoint) {
            log(`stdio proxy discovered endpoint ${endpoint.toString()}`);
          }
        }
        if (endpoint) {
          try {
            await forwardLine(endpoint, trimmed, options.timeoutMs);
            return;
          } catch (err) {
            log(`stdio proxy lost endpoint ${endpoint.toString()}: ${err instanceof Error ? err.message : String(err)}`);
            endpoint = await tryResolveEndpoint({ ...options, timeoutMs: STDIO_REDISCOVERY_TIMEOUT_MS });
            if (endpoint) {
              log(`stdio proxy rediscovered endpoint ${endpoint.toString()}`);
              try {
                await forwardLine(endpoint, trimmed, options.timeoutMs);
                return;
              } catch (retryErr) {
                log(`stdio proxy rediscovered endpoint failed ${endpoint.toString()}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
                endpoint = undefined;
              }
            }
          }
        }
        await handleOfflineLine(options, offlineState ?? buildOfflineMcpState(options, 'endpoint_not_discovered'), trimmed);
      })
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

async function handleOfflineLine(options: CliOptions, state: OfflineMcpState, line: string): Promise<void> {
  let message: JsonRpcMessage | JsonRpcMessage[];
  try {
    message = JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
  } catch (err) {
    writeStdoutJson(jsonRpcError(null, -32700, err instanceof Error ? err.message : String(err)));
    return;
  }

  if (Array.isArray(message)) {
    const responses = await Promise.all(
      message.map((item) => offlineResponseForMessage(options, state, item)),
    );
    const filtered = responses
      .filter((item): item is Record<string, unknown> => !!item);
    if (filtered.length === 0) { return; }
    writeStdoutJson(filtered);
    return;
  }
  const response = await offlineResponseForMessage(options, state, message);
  if (!response) { return; }
  writeStdoutJson(response);
}

async function offlineResponseForMessage(options: CliOptions, state: OfflineMcpState, message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }
  const id = message.id ?? null;
  switch (message.method) {
    case 'initialize':
      return jsonRpcResult(id, offlineInitializeResult(message.params));
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, { tools: OFFLINE_TOOLS });
    case 'tools/call': {
      const params = isRecord(message.params) ? message.params : {};
      const name = typeof params.name === 'string' ? params.name : undefined;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === 'mcp_health') {
        const latest = buildOfflineMcpState(options, state.reason, state.message);
        return jsonRpcResult(id, toolResult(offlineHealthEnvelope(latest, args, true)));
      }
      if (name === 'mcp_start') {
        return jsonRpcResult(id, await startWorkspaceMcpEndpoint(options, state, args));
      }
      return jsonRpcResult(id, toolErrorResult(
        'mcp_stopped',
        `Codeidx MCP endpoint is not running for workspace ${options.workspace}. Call mcp_start if mcp_health reports control.available == true.`,
      ));
    }
    case 'resources/list':
      return jsonRpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return jsonRpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: [] });
    default:
      return jsonRpcError(id, -32601, `Method not found while workspace MCP is stopped: ${message.method}`);
  }
}

function offlineInitializeResult(params: unknown): Record<string, unknown> {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string'
    ? params.protocolVersion
    : undefined;
  const protocolVersion = requested && SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : TARGET_MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      logging: {},
    },
    serverInfo: {
      name: 'codeidx-mcp',
      title: 'Codebase Index MCP',
      version: 'offline-stdio',
      description: 'Workspace Codeidx MCP endpoint is stopped; mcp_health and mcp_start are available until the VS Code extension starts the endpoint.',
    },
    instructions: [
      'The workspace Codeidx MCP endpoint is not running.',
      'Call mcp_health to inspect stopped state, control API status, and local auto-setup status.',
      'If mcp_health reports health.mcp_connection == stopped and control.available == true, call mcp_start once, then call mcp_health again before using codeidx tools.',
      'If control.available is false, open this workspace in VS Code with IntelliJ Styled Search enabled.',
    ].join('\n'),
  };
}

function buildOfflineMcpState(options: CliOptions, reason: string, message?: string): OfflineMcpState {
  const codeidxDir = path.join(options.workspace, '.codeidx');
  const discoveryPath = options.discoveryFile ?? path.join(codeidxDir, 'mcp-server.json');
  const controlPath = path.join(codeidxDir, MCP_CONTROL_FILE);
  const workspaceId = workspaceIdFor(options.workspace);
  const discovery = readDiscoveryStatus(discoveryPath, workspaceId);
  const control = readControlStatus(controlPath, workspaceId);
  const autoSetup = ensureWorkspaceMcpSetup(options.workspace);
  return {
    reason,
    message: message ?? `Codeidx MCP endpoint is not running for workspace ${options.workspace}.`,
    workspace: options.workspace,
    workspaceId,
    discoveryPath,
    discovery,
    controlPath,
    control,
    autoSetup,
  };
}

function offlineHealthEnvelope(state: OfflineMcpState, args: Record<string, unknown>, fromToolCall: boolean): Record<string, unknown> {
  const includeTools = readBoolArg(args, 'include_tools', false);
  const includeDiscovery = readBoolArg(args, 'include_discovery', true);
  const includeAgentPolicy = readBoolArg(args, 'include_agent_policy', true);
  const payload: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    ok: true,
    summary: 'Codeidx MCP endpoint is stopped for this workspace; local MCP client setup was checked.',
    confidence: {
      symbol_index: 'unavailable',
      reference_index: 'unavailable',
      call_graph: 'unavailable',
      implementation_index: 'unavailable',
      runtime_edges: 'unavailable',
    },
    snapshot: {
      workspace_id: state.workspaceId,
      index_revision: null,
      zoekt_revision: null,
      dirty_overlay_revision: null,
      git_head: null,
      branch: null,
      freshness: 'unavailable',
      indexed_at: null,
    },
    results: [],
    resource_links: [],
    next_cursor: null,
    truncated: false,
    warnings: offlineStoppedWarnings(state),
    health: {
      mcp_connection: 'stopped',
      running: false,
      endpoint: null,
      discovery_endpoint_matches: false,
      transport: fromToolCall ? 'stdio-offline-fallback' : 'cli-health',
      stdio_proxy: 'offline_health_available',
      workspace_root: state.workspace,
      workspace_id: state.workspaceId,
      server_pid: null,
      server_info: {
        name: 'codeidx-mcp',
        version: 'offline-stdio',
        protocol_versions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
      },
      capabilities: {
        tools: true,
        resources: false,
        prompts: false,
        logging: true,
      },
      index: {
        snapshot_loaded: false,
        freshness: 'unavailable',
        indexed_at: null,
        symbols: 0,
        edges: 0,
        references: 0,
        search_engine: null,
        search_index_ready: false,
        last_engine_error: 'mcp_endpoint_stopped',
        native_graph_available: false,
        native_graph_compatible: false,
        native_graph_reason: 'mcp_endpoint_stopped',
        native_graph_version: null,
        native_graph_expected_version: null,
      },
    },
    control: state.control,
    auto_setup: state.autoSetup,
    tool_count: OFFLINE_TOOLS.length,
  };
  if (includeDiscovery) {
    payload.discovery = state.discovery;
  }
  if (includeAgentPolicy) {
    payload.agent_policy = offlineAgentPolicy();
  }
  if (includeTools) {
    payload.tools = OFFLINE_TOOLS.map((tool) => tool.name);
  }
  return payload;
}

function offlineStoppedWarnings(state: OfflineMcpState): string[] {
  const canStart = state.control.available === true;
  return [
    'Only mcp_health and mcp_start are available while the workspace HTTP endpoint is stopped.',
    canStart
      ? 'Call mcp_start once to ask the VS Code extension to start this workspace MCP endpoint, then call mcp_health again.'
      : 'Open this workspace in VS Code with IntelliJ Styled Search enabled so the extension can publish the workspace control API.',
  ];
}

async function startWorkspaceMcpEndpoint(
  options: CliOptions,
  state: OfflineMcpState,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const latest = buildOfflineMcpState(options, state.reason, state.message);
  const timeoutMs = readIntArg(args, 'timeout_ms', Math.min(options.timeoutMs, 5_000), 100, 120_000);
  const control = readControlFile(latest.controlPath, latest.workspaceId);
  if (!control.ok) {
    return toolErrorResult(
      control.code,
      `${control.message} Call mcp_health(include_agent_policy=true, include_discovery=true) for current setup details.`,
    );
  }
  let parsed: unknown;
  try {
    const raw = await postJson(
      new URL(control.url),
      JSON.stringify({ workspace_id: latest.workspaceId, token: control.token }),
      timeoutMs,
    );
    parsed = raw.trim() ? JSON.parse(raw) as unknown : {};
  } catch (err) {
    return toolErrorResult(
      'mcp_control_request_failed',
      `Failed to request MCP start for workspace ${options.workspace}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    const message = isRecord(parsed) && typeof parsed.error === 'string'
      ? parsed.error
      : 'control API did not report ok';
    return toolErrorResult('mcp_control_start_failed', message);
  }
  const endpoint = await tryResolveEndpoint({ ...options, timeoutMs: Math.min(timeoutMs, 3_000) });
  const refreshed = buildOfflineMcpState(options, state.reason, state.message);
  const envelope = {
    schema_version: SCHEMA_VERSION,
    ok: true,
    summary: 'Requested the VS Code extension to start this workspace Codeidx MCP endpoint.',
    status: typeof parsed.status === 'string' ? parsed.status : 'started',
    health: {
      mcp_connection: endpoint ? 'ok' : 'starting',
      endpoint: endpoint?.toString() ?? (typeof parsed.mcp_endpoint === 'string' ? parsed.mcp_endpoint : null),
      transport: 'stdio-offline-control',
      workspace_root: options.workspace,
      workspace_id: latest.workspaceId,
      server_pid: null,
    },
    control: refreshed.control,
    discovery: refreshed.discovery,
    results: [],
    resource_links: [],
    next_cursor: null,
    truncated: false,
    warnings: endpoint
      ? []
      : ['Start request succeeded, but endpoint rediscovery has not confirmed health yet. Call mcp_health again.'],
    next_steps: [
      'Call mcp_health(include_agent_policy=true, include_discovery=true) again.',
      'Retry the original codeidx tool only after health.mcp_connection == ok.',
    ],
  };
  return toolResult(envelope);
}

function offlineAgentPolicy(): Record<string, unknown> {
  return {
    version: 'codeidx-agent-policy-offline-2026-06-20',
    role: 'offline_workspace_mcp_control',
    default_behavior: {
      auto_use_mcp: true,
      applies_when: 'The workspace Codeidx MCP HTTP endpoint is not running, but the stdio fallback is available.',
    },
    startup_sequence: [
      {
        step: 'health_gate',
        tool: 'mcp_health',
        arguments: { include_agent_policy: true, include_discovery: true },
        require: ['inspect health.mcp_connection and control.available before using search, symbol, reference, or graph tools'],
      },
      {
        step: 'start_workspace_endpoint',
        tool: 'mcp_start',
        applies_when: 'health.mcp_connection == stopped and control.available == true',
        require: [
          'call mcp_start once for the same workspace',
          'rediscover the MCP endpoint after mcp_start returns',
          'call mcp_health(include_agent_policy=true, include_discovery=true) again',
        ],
      },
      {
        step: 'manual_extension_activation',
        applies_when: 'control.available != true',
        purpose: 'Open the target workspace in VS Code with IntelliJ Styled Search enabled so the extension can publish the workspace control API.',
      },
    ],
    fallback_rules: [
      'Do not use search/symbol/reference/graph tools from this offline stdio fallback.',
      'After mcp_start, use codeidx tools only when a follow-up mcp_health reports health.mcp_connection == ok.',
      'Use rg or local filesystem tools when control.available is false, mcp_start fails, or rediscovery still cannot confirm the workspace endpoint.',
    ],
  };
}

function ensureWorkspaceMcpSetup(workspace: string): AutoSetupStatus {
  const codeidxDir = path.join(workspace, '.codeidx');
  const launcherPath = path.join(codeidxDir, 'codeidx-mcp-stdio.js');
  const mcpJsonPath = path.join(workspace, '.mcp.json');
  const codexConfigPath = path.join(workspace, '.codex', 'config.toml');
  const codeidxStatus = ensureDirectory(codeidxDir);
  const launcherStatus = ensureTextFile(launcherPath, stdioLauncherContent(__filename), 0o755, true);
  const mcpJsonStatus = ensureMcpJson(mcpJsonPath);
  const codexConfigStatus = ensureCodexConfig(codexConfigPath);
  const globalCodexStatus = inspectGlobalCodexConfig(workspace);
  const statuses = [codeidxStatus, launcherStatus, mcpJsonStatus, codexConfigStatus];
  const nextSteps = [
    'Open this workspace in VS Code with IntelliJ Styled Search enabled.',
    'If mcp_health reports control.available == true, call mcp_start from this MCP client to start the workspace endpoint.',
    'If control.available is false but the extension is active, run IntelliJ Search: Start Codeidx MCP Server or Restart Codeidx MCP Server.',
    'Reconnect the MCP client after mcp_health reports health.mcp_connection == ok.',
  ];
  if (globalCodexStatus.error) {
    nextSteps.push(globalCodexStatus.error);
  }
  return {
    attempted: true,
    workspace_root: workspace,
    codeidx_dir: codeidxStatus,
    stdio_launcher: launcherStatus,
    mcp_json: mcpJsonStatus,
    codex_config: codexConfigStatus,
    global_config_policy: 'project_local_only',
    global_codex_config: globalCodexStatus,
    ready_for_next_client: statuses.every((status) => status.status !== 'error'),
    requires_vscode_extension: true,
    next_steps: nextSteps,
  };
}

function ensureDirectory(dirPath: string): SetupFileStatus {
  try {
    const existed = fs.existsSync(dirPath);
    fs.mkdirSync(dirPath, { recursive: true });
    return { path: dirPath, status: existed ? 'unchanged' : 'created' };
  } catch (err) {
    return { path: dirPath, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function ensureTextFile(filePath: string, content: string, mode: number | undefined, createParent: boolean): SetupFileStatus {
  try {
    if (createParent) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
    if (existing === content) {
      if (mode !== undefined) {
        try { fs.chmodSync(filePath, mode); } catch {}
      }
      return { path: filePath, status: 'unchanged' };
    }
    fs.writeFileSync(filePath, content, 'utf8');
    if (mode !== undefined) {
      fs.chmodSync(filePath, mode);
    }
    return { path: filePath, status: existing === undefined ? 'created' : 'updated' };
  } catch (err) {
    return { path: filePath, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function ensureMcpJson(filePath: string): SetupFileStatus {
  const codeidxServer = {
    type: 'stdio',
    command: 'node',
    args: ['.codeidx/codeidx-mcp-stdio.js', 'stdio', '--workspace', '.'],
  };
  try {
    if (!fs.existsSync(filePath)) {
      return ensureTextFile(filePath, JSON.stringify({ mcpServers: { codeidx: codeidxServer } }, null, 2) + '\n', undefined, false);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { path: filePath, status: 'skipped', error: 'existing .mcp.json is not a JSON object' };
    }
    const mcpServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    if (isRecord(mcpServers.codeidx)) {
      return { path: filePath, status: 'unchanged' };
    }
    const next = {
      ...parsed,
      mcpServers: {
        ...mcpServers,
        codeidx: codeidxServer,
      },
    };
    return ensureTextFile(filePath, JSON.stringify(next, null, 2) + '\n', undefined, false);
  } catch (err) {
    return { path: filePath, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function ensureCodexConfig(filePath: string): SetupFileStatus {
  const block = [
    '[mcp_servers.codeidx]',
    'command = "node"',
    'args = [".codeidx/codeidx-mcp-stdio.js", "stdio", "--workspace", "."]',
    'cwd = "."',
    'startup_timeout_sec = 10',
    'tool_timeout_sec = 60',
    'enabled = true',
    'required = false',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      return ensureTextFile(filePath, block, undefined, false);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (/^\s*\[mcp_servers\.codeidx\]\s*$/m.test(raw)) {
      return { path: filePath, status: 'unchanged' };
    }
    const next = raw.replace(/\s*$/u, '\n\n') + block;
    return ensureTextFile(filePath, next, undefined, false);
  } catch (err) {
    return { path: filePath, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function inspectGlobalCodexConfig(workspace: string): SetupFileStatus {
  const home = process.env.HOME || process.env.USERPROFILE;
  const filePath = home ? path.join(home, '.codex', 'config.toml') : path.join('~', '.codex', 'config.toml');
  if (!home) {
    return { path: filePath, status: 'skipped', error: 'global Codex config was not inspected because HOME is not set' };
  }
  if (!fs.existsSync(filePath)) {
    return { path: filePath, status: 'skipped' };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const block = extractTomlTable(raw, 'mcp_servers.codeidx');
    if (!block) {
      return { path: filePath, status: 'unchanged' };
    }
    const pinnedWorkspace = readWorkspaceArgFromTomlArrayBlock(block);
    const projectLauncher = readProjectLauncherFromTomlArrayBlock(block);
    const issues: string[] = [];
    if (pinnedWorkspace && pinnedWorkspace !== '.' && path.isAbsolute(pinnedWorkspace)) {
      issues.push(`--workspace is pinned to ${pinnedWorkspace}`);
    }
    if (projectLauncher) {
      issues.push(`launcher is pinned to ${projectLauncher}`);
    }
    if (issues.length === 0) {
      return { path: filePath, status: 'unchanged' };
    }
    return {
      path: filePath,
      status: 'skipped',
      error: `Global Codex codeidx config is workspace-specific (${issues.join(', ')}). This extension only writes project-local ${path.join(workspace, '.codex', 'config.toml')}; remove or replace the global entry with a cwd-based command.`,
    };
  } catch (err) {
    return { path: filePath, status: 'skipped', error: err instanceof Error ? err.message : String(err) };
  }
}

function extractTomlTable(raw: string, tableName: string): string | undefined {
  const table = `[${tableName}]`;
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === table);
  if (start < 0) { return undefined; }
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\[[^\]]+\]$/u.test(trimmed)) { break; }
    block.push(lines[i]);
  }
  return block.join('\n');
}

function readWorkspaceArgFromTomlArrayBlock(block: string): string | undefined {
  const values = readTomlArgsArray(block);
  const index = values.findIndex((value) => value === '--workspace' || value === '-w');
  return index >= 0 ? values[index + 1] : undefined;
}

function readProjectLauncherFromTomlArrayBlock(block: string): string | undefined {
  const values = readTomlArgsArray(block);
  return values.find((value) =>
    path.isAbsolute(value) &&
    value.replace(/\\/g, '/').endsWith('/.codeidx/codeidx-mcp-stdio.js'));
}

function readTomlArgsArray(block: string): string[] {
  const match = block.match(/^\s*args\s*=\s*\[([\s\S]*?)\]\s*$/mu);
  if (!match) { return []; }
  const values: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/gu;
  let item: RegExpExecArray | null;
  while ((item = re.exec(match[1])) !== null) {
    values.push(item[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return values;
}

function stdioLauncherContent(cliPath: string): string {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    `const cli = ${JSON.stringify(cliPath)};`,
    "const workspaceRoot = path.resolve(__dirname, '..');",
    'function argIndex(names) {',
    '  return process.argv.findIndex((arg, index) => index >= 2 && names.some((name) => arg === name || arg.startsWith(name + "=")));',
    '}',
    'function inlineValue(arg) {',
    '  const index = arg.indexOf("=");',
    '  return index === -1 ? undefined : arg.slice(index + 1);',
    '}',
    'function dotWorkspaceArg() {',
    '  const cwd = path.resolve(process.cwd());',
    '  if (cwd !== workspaceRoot) {',
    '    return cwd;',
    '  }',
    '  return workspaceRoot;',
    '}',
    'function normalizeWorkspaceArg(value) {',
    '  if (value === ".") {',
    '    return dotWorkspaceArg();',
    '  }',
    '  try {',
    '    if (path.resolve(value) === workspaceRoot && path.resolve(process.cwd()) !== workspaceRoot) {',
    '      return path.resolve(process.cwd());',
    '    }',
    '  } catch (_) {}',
    '  return value;',
    '}',
    'const workspaceIndex = argIndex(["--workspace", "-w"]);',
    'if (workspaceIndex >= 0) {',
    '  const arg = process.argv[workspaceIndex];',
    '  const value = inlineValue(arg);',
    '  if (value !== undefined) {',
    '    process.argv[workspaceIndex] = arg.slice(0, arg.indexOf("=") + 1) + normalizeWorkspaceArg(value);',
    '  } else if (process.argv[workspaceIndex + 1]) {',
    '    process.argv[workspaceIndex + 1] = normalizeWorkspaceArg(process.argv[workspaceIndex + 1]);',
    '  }',
    '} else if (argIndex(["--url", "--port", "--discovery-file"]) < 0) {',
    '  process.argv.push("--workspace", dotWorkspaceArg());',
    '}',
    'try {',
    '  require(cli);',
    '} catch (err) {',
    "  const message = err && err.stack ? err.stack : String(err);",
    "  process.stderr.write(`[codeidx-mcp] failed to load CLI ${cli}: ${message}\\n`);",
    '  process.exitCode = 1;',
    '}',
    '',
  ].join('\n');
}

async function forwardLine(endpoint: URL, line: string, timeoutMs: number): Promise<void> {
  try {
    JSON.parse(line) as JsonRpcMessage | JsonRpcMessage[];
  } catch (err) {
    writeStdoutJson(jsonRpcError(null, -32700, err instanceof Error ? err.message : String(err)));
    return;
  }

  const responseText = await postJson(endpoint, line, timeoutMs);
  if (responseText.trim().length === 0) { return; }
  process.stdout.write(responseText.replace(/\n+$/g, '') + '\n');
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

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(envelope: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: envelope.ok === false,
  };
}

function toolErrorResult(code: string, message: string): Record<string, unknown> {
  return toolResult({
    schema_version: SCHEMA_VERSION,
    ok: false,
    summary: message,
    error: { code, message, retryable: false },
    results: [],
    resource_links: [],
    next_cursor: null,
    truncated: false,
    warnings: [],
  });
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

function parsePort(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }
  return Math.floor(parsed);
}

function readBoolArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readIntArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
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
    '  codeidx-mcp stdio [--workspace <path>] [--url <http://127.0.0.1:<port>/mcp>] [--port <port>]',
    '  codeidx-mcp proxy --url <http://127.0.0.1:<port>/mcp>',
    '  codeidx-mcp health [--workspace <path>] [--url <http://127.0.0.1:<port>/mcp>]',
    '',
    'The stdio command forwards newline-delimited MCP JSON-RPC messages to the VSCode extension HTTP endpoint.',
    'If --url is omitted, CODEIDX_MCP_URL and <workspace>/.codeidx/mcp-server.json are tried.',
    'The discovery file is waited for until --connect-timeout-ms elapses.',
    '--port is only a manual fallback; automatic multi-window use should rely on workspace discovery.',
    '',
  ].join('\n'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
