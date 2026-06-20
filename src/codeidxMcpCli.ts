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
  autoSetup: AutoSetupStatus;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const STDIO_INITIAL_DISCOVERY_TIMEOUT_MS = 1_500;
const STDIO_REDISCOVERY_TIMEOUT_MS = 250;
const SCHEMA_VERSION = 'codeidx.mcp/0.1';
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
          await forwardLine(endpoint, trimmed, options.timeoutMs);
          return;
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

  const response = Array.isArray(message)
    ? message
      .map((item) => offlineResponseForMessage(options, state, item))
      .filter((item): item is Record<string, unknown> => !!item)
    : offlineResponseForMessage(options, state, message);
  if (Array.isArray(response) && response.length === 0) { return; }
  if (!response) { return; }
  writeStdoutJson(response);
}

function offlineResponseForMessage(options: CliOptions, state: OfflineMcpState, message: JsonRpcMessage): Record<string, unknown> | null {
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
      return jsonRpcResult(id, { tools: [OFFLINE_HEALTH_TOOL] });
    case 'tools/call': {
      const params = isRecord(message.params) ? message.params : {};
      const name = typeof params.name === 'string' ? params.name : undefined;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === 'mcp_health') {
        const latest = buildOfflineMcpState(options, state.reason, state.message);
        return jsonRpcResult(id, toolResult(offlineHealthEnvelope(latest, args, true)));
      }
      return jsonRpcResult(id, toolErrorResult(
        'mcp_stopped',
        `Codeidx MCP endpoint is not running for workspace ${options.workspace}. Call mcp_health for setup status.`,
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
      description: 'Workspace Codeidx MCP endpoint is stopped; only mcp_health is available until the VS Code extension starts the endpoint.',
    },
    instructions: [
      'The workspace Codeidx MCP endpoint is not running.',
      'Call mcp_health to inspect stopped state and local auto-setup status.',
      'Open this workspace in VS Code with IntelliJ Styled Search enabled, or run the Start Codeidx MCP Server command there.',
    ].join('\n'),
  };
}

function buildOfflineMcpState(options: CliOptions, reason: string, message?: string): OfflineMcpState {
  const discoveryPath = options.discoveryFile ?? path.join(options.workspace, '.codeidx', 'mcp-server.json');
  const workspaceId = workspaceIdFor(options.workspace);
  const discovery = readDiscoveryStatus(discoveryPath, workspaceId);
  const autoSetup = ensureWorkspaceMcpSetup(options.workspace);
  return {
    reason,
    message: message ?? `Codeidx MCP endpoint is not running for workspace ${options.workspace}.`,
    workspace: options.workspace,
    workspaceId,
    discoveryPath,
    discovery,
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
    warnings: [
      'Only mcp_health is available while the workspace HTTP endpoint is stopped.',
      'Open this workspace in VS Code with IntelliJ Styled Search enabled, or run Start Codeidx MCP Server in that window.',
    ],
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
    auto_setup: state.autoSetup,
    tool_count: 1,
  };
  if (includeDiscovery) {
    payload.discovery = state.discovery;
  }
  if (includeAgentPolicy) {
    payload.agent_policy = offlineAgentPolicy();
  }
  if (includeTools) {
    payload.tools = [OFFLINE_HEALTH_TOOL.name];
  }
  return payload;
}

function offlineAgentPolicy(): Record<string, unknown> {
  return {
    version: 'codeidx-agent-policy-offline-2026-06-20',
    role: 'offline_health_only',
    default_behavior: {
      auto_use_mcp: false,
      applies_when: 'The workspace Codeidx MCP HTTP endpoint is not running.',
    },
    startup_sequence: [
      {
        step: 'health_gate',
        tool: 'mcp_health',
        require: ['health.mcp_connection == ok before using search, symbol, reference, or graph tools'],
      },
      {
        step: 'start_workspace_endpoint',
        purpose: 'Open the target workspace in VS Code with IntelliJ Styled Search enabled, or run Start Codeidx MCP Server in that window.',
      },
    ],
    fallback_rules: [
      'Do not use search/symbol/reference tools from this offline stdio fallback.',
      'Use rg or local filesystem tools until the workspace MCP endpoint reports health.mcp_connection == ok.',
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
  const statuses = [codeidxStatus, launcherStatus, mcpJsonStatus, codexConfigStatus];
  return {
    attempted: true,
    workspace_root: workspace,
    codeidx_dir: codeidxStatus,
    stdio_launcher: launcherStatus,
    mcp_json: mcpJsonStatus,
    codex_config: codexConfigStatus,
    ready_for_next_client: statuses.every((status) => status.status !== 'error'),
    requires_vscode_extension: true,
    next_steps: [
      'Open this workspace in VS Code with IntelliJ Styled Search enabled.',
      'If the extension is already active, run IntelliJ Search: Start Codeidx MCP Server or Restart Codeidx MCP Server.',
      'Reconnect the MCP client after mcp_health reports health.mcp_connection == ok.',
    ],
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
    'function hasWorkspaceDiscovery(dir) {',
    '  try {',
    '    const raw = fs.readFileSync(path.join(dir, ".codeidx", "mcp-server.json"), "utf8");',
    '    const parsed = JSON.parse(raw);',
    '    return parsed && typeof parsed.url === "string";',
    '  } catch (_) {',
    '    return false;',
    '  }',
    '}',
    'function dotWorkspaceArg() {',
    '  const cwd = path.resolve(process.cwd());',
    '  if (cwd !== workspaceRoot && hasWorkspaceDiscovery(cwd)) {',
    '    return cwd;',
    '  }',
    '  return workspaceRoot;',
    '}',
    'const workspaceIndex = argIndex(["--workspace", "-w"]);',
    'if (workspaceIndex >= 0) {',
    '  const arg = process.argv[workspaceIndex];',
    '  const value = inlineValue(arg);',
    '  if (value === ".") {',
    '    process.argv[workspaceIndex] = arg.slice(0, arg.indexOf("=") + 1) + dotWorkspaceArg();',
    '  } else if (value === undefined && process.argv[workspaceIndex + 1] === ".") {',
    '    process.argv[workspaceIndex + 1] = dotWorkspaceArg();',
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
