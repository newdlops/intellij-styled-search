import * as http from 'http';
import * as vscode from 'vscode';
import {
  CallGraphService,
  formatQueryResults,
  type CallGraphSnapshot,
} from './callGraph';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class CallGraphMcpServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(
    private readonly callGraph: CallGraphService,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose(): void {
    this.stop();
  }

  isRunning(): boolean {
    return !!this.server;
  }

  getAddress(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(port: number): Promise<string> {
    if (this.server) {
      return this.getAddress()!;
    }
    const boundedPort = Number.isFinite(port) && port >= 0 ? Math.floor(port) : 8765;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(boundedPort, '127.0.0.1');
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : boundedPort;
    const url = this.getAddress()!;
    this.log.appendLine(`call graph MCP server started: ${url}`);
    return url;
  }

  stop(): void {
    if (!this.server) { return; }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    server.close((err) => {
      if (err) {
        this.log.appendLine(`call graph MCP server stop failed: ${err.message}`);
      } else {
        this.log.appendLine('call graph MCP server stopped');
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        this.writeJson(res, 200, {
          ok: true,
          running: true,
          snapshot: summarizeSnapshot(this.callGraph.getSnapshot()),
        });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        this.writeJson(res, 404, { error: 'not found' });
        return;
      }
      const body = await readBody(req, 1024 * 1024);
      const request = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
      if (Array.isArray(request)) {
        const responses = [];
        for (const item of request) {
          const response = await this.handleJsonRpc(item);
          if (response) { responses.push(response); }
        }
        this.writeJson(res, 200, responses);
        return;
      }
      const response = await this.handleJsonRpc(request);
      if (!response) {
        res.writeHead(202).end();
        return;
      }
      this.writeJson(res, 200, response);
    } catch (err) {
      this.writeJson(res, 500, jsonRpcError(null, -32603, err instanceof Error ? err.message : String(err)));
    }
  }

  private async handleJsonRpc(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return jsonRpcError(request.id ?? null, -32600, 'Invalid JSON-RPC request.');
    }
    const id = request.id ?? null;
    switch (request.method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'intellij-styled-search-callgraph',
            version: getExtensionVersion(),
          },
          instructions: 'Use call graph tools to resolve symbols, callers, callees, and compact context bundles before reading full files.',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, { tools: toolDefinitions() });
      case 'tools/call':
        return jsonRpcResult(id, await this.callTool(request.params));
      default:
        return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    }
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    if (!isObject(params) || typeof params.name !== 'string') {
      return toolError('tools/call requires a string tool name.');
    }
    const args = isObject(params.arguments) ? params.arguments : {};
    try {
      switch (params.name) {
        case 'rebuild_call_graph': {
          const snapshot = await this.callGraph.rebuild();
          return toolResult(this.callGraph.formatInfoReport(snapshot), summarizeSnapshot(snapshot));
        }
        case 'call_graph_info': {
          await this.callGraph.ensureBuilt();
          const snapshot = this.callGraph.getSnapshot();
          return toolResult(this.callGraph.formatInfoReport(snapshot), summarizeSnapshot(snapshot));
        }
        case 'resolve_symbol': {
          await this.callGraph.ensureBuilt();
          const query = readStringArg(args, 'query');
          const limit = readNumberArg(args, 'limit', 20);
          const symbols = this.callGraph.resolveSymbols(query, limit);
          return toolResult(
            symbols.map((symbol) => `${symbol.id}\n  ${symbol.qualifiedName} ${symbol.relPath}:${symbol.range.startLine + 1}`).join('\n') || 'No matching symbol found.',
            { symbols },
          );
        }
        case 'get_callers': {
          await this.callGraph.ensureBuilt();
          const symbol = readStringArg(args, 'symbol');
          const limit = readNumberArg(args, 'limit', 200);
          const results = await this.callGraph.getCallersResolved(symbol, limit);
          return toolResult(formatQueryResults(results, 'callers'), { results });
        }
        case 'get_callees': {
          await this.callGraph.ensureBuilt();
          const symbol = readStringArg(args, 'symbol');
          const limit = readNumberArg(args, 'limit', 200);
          const results = await this.callGraph.getCalleesResolved(symbol, limit);
          return toolResult(formatQueryResults(results, 'callees'), { results });
        }
        case 'get_implementations': {
          await this.callGraph.ensureBuilt();
          const symbol = readStringArg(args, 'symbol');
          const limit = readNumberArg(args, 'limit', 200);
          const symbols = this.callGraph.findImplementations(symbol, limit);
          return toolResult(
            symbols.map((item) => `${item.id}\n  ${item.qualifiedName} ${item.relPath}:${item.range.startLine + 1}`).join('\n') || 'No implementations found.',
            { symbols },
          );
        }
        case 'get_usages': {
          await this.callGraph.ensureBuilt();
          const symbol = readStringArg(args, 'symbol');
          const limit = readNumberArg(args, 'limit', 500);
          const references = this.callGraph.findUsages(symbol, limit);
          return toolResult(
            references.map((item) => `${item.name} ${item.relPath}:${item.range.startLine + 1}`).join('\n') || 'No usages found.',
            { references },
          );
        }
        case 'get_context_bundle': {
          await this.callGraph.ensureBuilt();
          const symbol = readStringArg(args, 'symbol');
          const budget = readNumberArg(args, 'budget', 12_000);
          const bundle = await this.callGraph.getContextBundleResolved(symbol, budget);
          return toolResult(bundle, { bundle });
        }
        default:
          return toolError(`Unknown tool: ${params.name}`);
      }
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'access-control-allow-origin': 'http://127.0.0.1',
    });
    res.end(payload);
  }
}

function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'rebuild_call_graph',
      title: 'Rebuild Call Graph',
      description: 'Rebuild the multi-language static call graph for the open workspace.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'call_graph_info',
      title: 'Call Graph Info',
      description: 'Return call graph build stats and language coverage for the open workspace.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'resolve_symbol',
      title: 'Resolve Symbol',
      description: 'Resolve a symbol name, qualified name, path fragment, or symbol id to indexed call graph symbols.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_callers',
      title: 'Get Callers',
      description: 'Return callers for a symbol id or query, including edge confidence and callsite locations.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          limit: { type: 'number', default: 200 },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_callees',
      title: 'Get Callees',
      description: 'Return callees for a symbol id or query, including edge confidence and callsite locations.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          limit: { type: 'number', default: 200 },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_implementations',
      title: 'Get Implementations',
      description: 'Return implementation symbols for an interface, abstract class, or abstract/interface method.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          limit: { type: 'number', default: 200 },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_usages',
      title: 'Get Usages',
      description: 'Return indexed usage references for constants and other referenceable symbols.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          limit: { type: 'number', default: 500 },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_context_bundle',
      title: 'Get Context Bundle',
      description: 'Return a compact caller/callee context bundle for an agent before it reads full files.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          budget: { type: 'number', default: 12000 },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
    },
  ];
}

function toolResult(text: string, structuredContent?: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: false,
  };
}

function toolError(text: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function summarizeSnapshot(snapshot: CallGraphSnapshot | undefined): Record<string, unknown> {
  if (!snapshot) {
    return { built: false };
  }
  return {
    built: true,
    builtAtUnixMs: snapshot.builtAtUnixMs,
    workspaceRoot: snapshot.workspaceRoot,
    stats: snapshot.stats,
  };
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function readNumberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) { return fallback; }
  return Math.max(1, Math.floor(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getExtensionVersion(): string {
  const extension = vscode.extensions.getExtension('newdlops.intellij-styled-search');
  return (extension?.packageJSON?.version as string | undefined) ?? 'unknown';
}
