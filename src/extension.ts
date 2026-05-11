import * as vscode from 'vscode';
import { OverlayPanel, type PreviewCallGraphInlay } from './overlayPanel';
import type { FileMatch, MatchRange, SearchEngine, SearchForTestsResult } from './search';
import {
  CallGraphService,
  CallGraphRebuildCancelledError,
  formatQueryResults,
  type CallGraphEdge,
  type CallGraphQueryResult,
  type CallGraphRange,
  type CallGraphReference,
  type CallGraphRebuildProgress,
  type CallGraphSymbol,
  type CallGraphSymbolRelationSummary,
} from './callGraph';
import { CallGraphMcpServer } from './mcpServer';

const CALL_GRAPH_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'python' },
  { scheme: 'file', language: 'java' },
  { scheme: 'file', language: 'kotlin' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
];

const CALL_GRAPH_USAGE_SEARCH_INCLUDE_PATTERNS = [
  '**/*.py',
  '**/*.java',
  '**/*.kt',
  '**/*.kts',
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
];

let activeOverlay: OverlayPanel | undefined;

type CallGraphInlayKind = 'usages' | 'callees' | 'impl';

type CallGraphInlayRegistryEntry = {
  readonly line: number;
  readonly kind: CallGraphInlayKind;
  readonly symbolId: string;
  readonly label: string;
  readonly hintColumn: number;
};

class CallGraphInlayRegistry {
  private readonly entriesByUri = new Map<string, Map<number, CallGraphInlayRegistryEntry[]>>();
  private readonly invalidatedUris = new Set<string>();

  clearAll(): void {
    this.entriesByUri.clear();
    this.invalidatedUris.clear();
  }

  clearDocument(uri: vscode.Uri): void {
    const uriKey = uri.toString();
    this.entriesByUri.delete(uriKey);
    this.invalidatedUris.delete(uriKey);
  }

  invalidateDocument(uri: vscode.Uri): void {
    const uriKey = uri.toString();
    this.entriesByUri.delete(uriKey);
    this.invalidatedUris.add(uriKey);
  }

  isInvalidated(uri: vscode.Uri): boolean {
    return this.invalidatedUris.has(uri.toString());
  }

  replaceRange(uri: vscode.Uri, range: vscode.Range, entries: CallGraphInlayRegistryEntry[]): void {
    const uriKey = uri.toString();
    const byLine = this.entriesByUri.get(uriKey) ?? new Map<number, CallGraphInlayRegistryEntry[]>();
    const startLine = Math.max(0, range.start.line);
    const endLine = Math.max(startLine, range.end.line);
    for (const line of byLine.keys()) {
      if (line >= startLine && line <= endLine) {
        byLine.delete(line);
      }
    }
    for (const entry of entries) {
      if (!Number.isFinite(entry.line) || entry.line < 0) { continue; }
      const line = Math.floor(entry.line);
      const current = byLine.get(line) ?? [];
      current.push({ ...entry, line });
      byLine.set(line, current);
    }
    if (byLine.size === 0) {
      this.entriesByUri.delete(uriKey);
      return;
    }
    this.entriesByUri.set(uriKey, byLine);
  }

  resolve(uri: vscode.Uri, line: number, kind: string, column?: number): CallGraphInlayRegistryEntry | undefined {
    if (!Number.isFinite(line) || line < 0) { return undefined; }
    const normalizedKind = normalizeCallGraphInlayKind(kind);
    const matches = this.entriesByUri
      .get(uri.toString())
      ?.get(Math.floor(line))
      ?.filter((entry) => entry.kind === normalizedKind) ?? [];
    if (matches.length === 0) { return undefined; }
    if (!Number.isFinite(column)) { return matches[0]; }
    const safeColumn = Math.max(0, Math.floor(column ?? 0));
    return [...matches].sort((a, b) => {
      const aDistance = Math.abs(a.hintColumn - safeColumn);
      const bDistance = Math.abs(b.hintColumn - safeColumn);
      return aDistance - bDistance || a.symbolId.localeCompare(b.symbolId);
    })[0];
  }

  resolveNear(uri: vscode.Uri, line: number, kind: string, column?: number, radius = 6): CallGraphInlayRegistryEntry | undefined {
    if (!Number.isFinite(line) || line < 0) { return undefined; }
    const normalizedKind = normalizeCallGraphInlayKind(kind);
    const byLine = this.entriesByUri.get(uri.toString());
    if (!byLine) { return undefined; }
    const safeLine = Math.max(0, Math.floor(line));
    const safeColumn = Math.max(0, Math.floor(Number.isFinite(column) ? column ?? 0 : 0));
    const maxDistance = Math.max(0, Math.floor(radius));
    const candidates: CallGraphInlayRegistryEntry[] = [];
    for (const [entryLine, entries] of byLine) {
      if (Math.abs(entryLine - safeLine) > maxDistance) { continue; }
      candidates.push(...entries.filter((entry) => entry.kind === normalizedKind));
    }
    return candidates.sort((a, b) => {
      const aLineDistance = Math.abs(a.line - safeLine);
      const bLineDistance = Math.abs(b.line - safeLine);
      const aColumnDistance = Math.abs(a.hintColumn - safeColumn);
      const bColumnDistance = Math.abs(b.hintColumn - safeColumn);
      return aLineDistance - bLineDistance ||
        aColumnDistance - bColumnDistance ||
        a.symbolId.localeCompare(b.symbolId);
    })[0];
  }
}

function normalizeCallGraphInlayKind(kind: string): CallGraphInlayKind {
  if (kind === 'impl' || kind === 'implementations') { return 'impl'; }
  if (kind === 'callees') { return 'callees'; }
  return 'usages';
}

/** Shape exposed via `ext.exports` for integration / E2E tests. Plain
 *  production consumers don't need to touch this. */
export interface ExtensionTestApi {
  overlay: OverlayPanel;
  callGraph: CallGraphService;
  mcpServer: CallGraphMcpServer;
}

export function activate(context: vscode.ExtensionContext): ExtensionTestApi {
  const overlay = OverlayPanel.get(context);
  activeOverlay = overlay;
  const callGraphLog = overlay.getLogChannel();
  const callGraph = new CallGraphService(context, callGraphLog);
  const callGraphInlayRegistry = new CallGraphInlayRegistry();
  overlay.setPreviewCallGraphInlayProvider((uri, document, range) =>
    buildPreviewCallGraphInlays(callGraph, callGraphLog, uri, document, range));
  const mcpServer = new CallGraphMcpServer(callGraph, callGraphLog, overlay);
  context.subscriptions.push(
    callGraph,
    mcpServer,
    { dispose: () => overlay.setPreviewCallGraphInlayProvider(undefined) },
  );
  const mcpAutoStart = vscode.workspace.getConfiguration('intellijStyledSearch').get<boolean>('mcpAutoStart', true);
  if (mcpAutoStart && vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) {
    void (async () => {
      try {
        const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
        const port = cfg.get<number>('mcpPort', 0);
        const url = await mcpServer.start(port);
        callGraphLog.appendLine(`codeidx MCP auto-started: ${url}`);
      } catch (err) {
        callGraphLog.appendLine(`codeidx MCP auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  } else if (mcpAutoStart && !vscode.workspace.isTrusted) {
    callGraphLog.appendLine('codeidx MCP auto-start skipped: workspace is not trusted');
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      callGraphInlayRegistry.invalidateDocument(event.document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      callGraphInlayRegistry.invalidateDocument(document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      callGraphInlayRegistry.clearDocument(document.uri);
    }),
    callGraph.onDidChangeSnapshot(() => {
      callGraphInlayRegistry.clearAll();
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      CALL_GRAPH_DOCUMENT_SELECTOR,
      new CallGraphInlayHintsProvider(overlay, callGraph, callGraphInlayRegistry),
    ),
    vscode.languages.registerImplementationProvider(CALL_GRAPH_DOCUMENT_SELECTOR, new CallGraphImplementationProvider(callGraph)),
  );
  overlay.logActivation();
  // Warm only the search backend. Renderer/CDP patching is intentionally
  // lazy because opening CDP at activation can make the whole workbench feel
  // sluggish.
  void overlay.prewarm();

  const runCallGraphRebuild = async (force: boolean): Promise<void> => {
    overlay.logCommand(force ? 'forceRebuildCallGraph' : 'rebuildCallGraph');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.text = force ? '$(sync~spin) Call graph: force rebuild starting' : '$(sync~spin) Call graph: starting';
    status.show();
    callGraphLog.show(true);
    callGraphLog.appendLine(force ? 'call graph force rebuild requested' : 'call graph rebuild requested');
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: force
            ? 'IntelliJ Styled Search: force rebuilding call graph'
            : 'IntelliJ Styled Search: rebuilding call graph',
          cancellable: true,
        },
        async (ui, token) => {
          ui.report({ increment: 0, message: 'starting; opening progress reporter' });
          let lastPercent = 0;
          let lastLogAt = 0;
          let lastStage = '';
          let latestMessage = 'starting; opening progress reporter';
          let latestPercent = 0;
          const heartbeat = setInterval(() => {
            ui.report({ increment: 0, message: latestMessage });
            status.text = `$(sync~spin) Call graph ${latestPercent}%`;
          }, 1_000);
          const zoektPause = overlay.pauseZoektFileUpdates(
            force ? 'call graph force rebuild' : 'call graph rebuild',
            { cancelIndexing: true },
          );
          try {
            const snapshot = await callGraph.rebuild((progress) => {
              const rawPercent = estimateCallGraphOverallProgressPercent(progress);
              const percent = Math.max(lastPercent, rawPercent);
              const message = formatCallGraphProgressMessage(progress);
              latestMessage = message;
              latestPercent = percent;
              const increment = Math.max(0, percent - lastPercent);
              lastPercent = Math.max(lastPercent, percent);
              ui.report({ message, increment });
              const byteInfo = formatCallGraphProgressBytes(progress);
              status.text = `$(sync~spin) Call graph ${percent}% ${progress.stage} ${progress.current}/${progress.total}${byteInfo ? ` ${byteInfo}` : ''}`;
              const now = Date.now();
              if (progress.stage !== lastStage || now - lastLogAt >= 1_000 || progress.stage === 'done') {
                const heapInfo = progress.heapUsedMb !== undefined && progress.heapLimitMb !== undefined && progress.heapUsageRatio !== undefined
                  ? ` heap=${progress.heapUsedMb}/${progress.heapLimitMb}MB(${Math.round(progress.heapUsageRatio * 100)}%) throttles=${progress.workerThrottleCount ?? 0}`
                  : '';
                callGraphLog.appendLine(
                  `call graph progress: stage=${progress.stage} current=${progress.current}/${progress.total} ` +
                  `${byteInfo ? `${byteInfo} ` : ''}` +
                  `parsed=${progress.parsedFiles} skipped=${progress.skippedFiles} warnings=${progress.warningCount} ` +
                  `workers=${progress.concurrency}/${progress.maxConcurrency ?? progress.concurrency}${heapInfo} elapsed=${progress.elapsedMs}ms`,
                );
                lastLogAt = now;
                lastStage = progress.stage;
              }
            }, token, { force });
            ui.report({ increment: Math.max(0, 100 - lastPercent), message: 'done; writing summary' });
            callGraphLog.appendLine(callGraph.formatInfoReport(snapshot));
          } finally {
            zoektPause.dispose();
            clearInterval(heartbeat);
          }
        },
      );
      status.text = force ? '$(check) Call graph force rebuilt' : '$(check) Call graph rebuilt';
      vscode.window.showInformationMessage(force
        ? 'IntelliJ Styled Search: call graph force rebuilt.'
        : 'IntelliJ Styled Search: call graph rebuilt.');
    } catch (err) {
      if (err instanceof CallGraphRebuildCancelledError) {
        status.text = force ? '$(circle-slash) Call graph force rebuild cancelled' : '$(circle-slash) Call graph rebuild cancelled';
        callGraphLog.appendLine(force ? 'call graph force rebuild cancelled' : 'call graph rebuild cancelled');
        vscode.window.showWarningMessage(force
          ? 'IntelliJ Styled Search: call graph force rebuild cancelled.'
          : 'IntelliJ Styled Search: call graph rebuild cancelled.');
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      status.text = force ? '$(error) Call graph force rebuild failed' : '$(error) Call graph rebuild failed';
      callGraphLog.appendLine(force
        ? `call graph force rebuild failed: ${msg}`
        : `call graph rebuild failed: ${msg}`);
      vscode.window.showErrorMessage(force
        ? `Call graph force rebuild failed: ${msg}`
        : `Call graph rebuild failed: ${msg}`);
    } finally {
      setTimeout(() => status.dispose(), 4_000);
    }
  };
  const showSearchCommand = async (commandName: string): Promise<void> => {
    overlay.logCommand(commandName);
    const initialQuery = getQueryFromActiveEditor();
    if (!initialQuery) {
      void overlay.show('');
      return;
    }
    const searchOnOpen = vscode.workspace.getConfiguration('intellijStyledSearch')
      .get<boolean>('searchOnOpen', false);
    const spawnContext = await overlay.getSearchSelectionShowContext();
    void overlay.show(initialQuery, {
      forceLiteral: true,
      suppressSearch: !searchOnOpen,
      preferredWindowId: spawnContext.preferredWindowId,
      spawn: spawnContext.spawn,
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('intellijStyledSearch.searchInProject', () => showSearchCommand('searchInProject')),
    vscode.commands.registerCommand('intellijStyledSearch.searchSelection', () => showSearchCommand('searchSelection')),
    vscode.commands.registerCommand('intellijStyledSearch.reinject', async () => {
      overlay.logCommand('reinject');
      await overlay.forceReinject();
      vscode.window.showInformationMessage('IntelliJ Styled Search: re-injected.');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.stopMonacoCapture', async () => {
      overlay.logCommand('stopMonacoCapture');
      const report = await overlay.stopMonacoCapture('manual command');
      vscode.window.showInformationMessage(`IntelliJ Styled Search: Monaco capture stopped safely (${report}).`);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.recoverRendererUi', async () => {
      overlay.logCommand('recoverRendererUi');
      const report = await overlay.recoverRendererUi('manual command');
      vscode.window.showInformationMessage(`IntelliJ Styled Search: safe UI recovery completed (${report}).`);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.rebuildIndex', async () => {
      overlay.logCommand('forceRebuildIndexes');
      try {
        await overlay.rebuildIndex();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Index rebuild failed: ${msg}`);
        return;
      }
      await runCallGraphRebuild(true);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.switchEngine', async () => {
      overlay.logCommand('switchEngine');
      const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
      const current = cfg.get<SearchEngine>('engine', 'zoekt') === 'codesearch' ? 'codesearch' : 'zoekt';
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: 'zoekt',
            description: current === 'zoekt' ? 'Current' : 'Rust shard/mmap engine',
            target: 'zoekt' as SearchEngine,
          },
          {
            label: 'codesearch',
            description: current === 'codesearch' ? 'Current' : 'TypeScript trigram + ripgrep engine',
            target: 'codesearch' as SearchEngine,
          },
        ],
        {
          title: 'Switch Search Engine',
          placeHolder: `Current engine: ${current}`,
        },
      );
      if (!picked || picked.target === current) { return; }
      const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      try {
        await cfg.update('engine', picked.target, target);
        await overlay.rebuildIndex();
        vscode.window.showInformationMessage(`IntelliJ Styled Search: switched engine to ${picked.target}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Search engine switch failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showZoektInfo', async () => {
      overlay.logCommand('showZoektInfo');
      await overlay.showZoektInfo();
    }),
    vscode.commands.registerCommand('intellijStyledSearch.explainZoektQuery', async () => {
      overlay.logCommand('explainZoektQuery');
      const query = await vscode.window.showInputBox({
        prompt: 'Query to explain with zoek-rs',
        value: getQueryFromActiveEditor(),
        placeHolder: 'e.g. class AlphaService:',
      });
      if (query === undefined) { return; }
      await overlay.explainZoektQuery({
        query,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
    }),
    vscode.commands.registerCommand('intellijStyledSearch.diagnoseFileInIndex', async () => {
      overlay.logCommand('diagnoseFileInIndex');
      const query = await vscode.window.showInputBox({
        prompt: 'Paste the query you expected to find in the active file',
        placeHolder: 'e.g. class EmailTemplateParameter(TypedDict):',
      });
      if (query === undefined) { return; }
      await overlay.diagnoseCurrentFile(query);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.rebuildCallGraph', () => runCallGraphRebuild(false)),
    vscode.commands.registerCommand('intellijStyledSearch.forceRebuildCallGraph', () => runCallGraphRebuild(true)),
    vscode.commands.registerCommand('intellijStyledSearch.showCallGraphInfo', async () => {
      overlay.logCommand('showCallGraphInfo');
      try {
        if (!await ensureCallGraphReadyForUi(callGraph, 'Show Call Graph Info')) { return; }
        const snapshot = callGraph.getSnapshot();
        callGraphLog.show(true);
        callGraphLog.appendLine(callGraph.formatInfoReport(snapshot));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Call graph info failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.findCallers', async () => {
      overlay.logCommand('findCallers');
      await showCallGraphUsageResult(overlay, callGraph, callGraphLog);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.findCallees', async () => {
      overlay.logCommand('findCallees');
      await showCallGraphQueryResult(overlay, callGraph, callGraphLog, 'callees');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.findImplementations', async () => {
      overlay.logCommand('findImplementations');
      await showCallGraphImplementationResult(overlay, callGraph);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.findUsages', async () => {
      overlay.logCommand('findUsages');
      await showCallGraphUsageResult(overlay, callGraph, callGraphLog);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showCallersForSymbol', async (symbolId: string, label?: string) => {
      await runDedupedCallGraphSymbolCommand('showCallersForSymbol', symbolId, () =>
        showCallGraphUsageResult(overlay, callGraph, callGraphLog, symbolId, label));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showCalleesForSymbol', async (symbolId: string, label?: string) => {
      await runDedupedCallGraphSymbolCommand('showCalleesForSymbol', symbolId, () =>
        showCallGraphQueryResult(overlay, callGraph, callGraphLog, 'callees', symbolId, label));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showImplementationsForSymbol', async (symbolId: string, label?: string) => {
      await runDedupedCallGraphSymbolCommand('showImplementationsForSymbol', symbolId, () =>
        showCallGraphImplementationResult(overlay, callGraph, symbolId, label));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showUsagesForSymbol', async (symbolId: string, label?: string) => {
      await runDedupedCallGraphSymbolCommand('showUsagesForSymbol', symbolId, () =>
        showCallGraphUsageResult(overlay, callGraph, callGraphLog, symbolId, label));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.activateCallGraphInlayAtPosition', async (
      kind: string,
      uriString: string,
      line: number,
      column?: number,
    ) => {
      await activateCallGraphInlayAtPosition(
        overlay,
        callGraph,
        callGraphLog,
        callGraphInlayRegistry,
        kind,
        uriString,
        line,
        column,
      );
    }),
    vscode.commands.registerCommand('intellijStyledSearch.activateCallGraphInlayAtVisibleLine', async (
      kind: string,
      lineOrdinal: number,
      column?: number,
    ) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        callGraphLog.appendLine('call graph inlay click ignored: no active editor for visible-line resolution');
        return;
      }
      const line = documentLineFromVisibleLineOrdinal(editor, lineOrdinal);
      if (line === undefined) {
        callGraphLog.appendLine(`call graph inlay click ignored: visible line ${lineOrdinal} is outside active editor ranges`);
        return;
      }
      const registered = callGraphInlayRegistry.resolve(editor.document.uri, line, kind, column);
      if (registered) {
        await activateCallGraphInlayEntry(overlay, callGraph, callGraphLog, registered, 'inlay registry visible-line');
        return;
      }
      await activateCallGraphInlayAtPosition(
        overlay,
        callGraph,
        callGraphLog,
        callGraphInlayRegistry,
        kind,
        editor.document.uri.toString(),
        line,
        column,
        { allowNearby: true },
      );
    }),
    vscode.commands.registerCommand('intellijStyledSearch.startMcpServer', async () => {
      overlay.logCommand('startMcpServer');
      try {
        const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
        const port = cfg.get<number>('mcpPort', 0);
        const url = await mcpServer.start(port);
        vscode.window.showInformationMessage(`IntelliJ Styled Search MCP server: ${url}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`MCP server start failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.stopMcpServer', () => {
      overlay.logCommand('stopMcpServer');
      mcpServer.stop();
      vscode.window.showInformationMessage('IntelliJ Styled Search MCP server stopped.');
    }),
  );

  return { overlay, callGraph, mcpServer };
}

export async function deactivate() {
  await activeOverlay?.dispose();
  activeOverlay = undefined;
}

async function activateCallGraphInlayAtPosition(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  callGraphLog: vscode.OutputChannel,
  registry: CallGraphInlayRegistry,
  kind: string,
  uriString?: string,
  line?: number,
  column?: number,
  options: { allowNearby?: boolean } = {},
): Promise<void> {
  const normalizedKind = normalizeCallGraphInlayKind(kind);
  const activeEditor = vscode.window.activeTextEditor;
  const uri = uriString
    ? vscode.Uri.parse(uriString)
    : activeEditor?.document.uri;
  const rawLine = Number.isFinite(line) && line !== undefined && line >= 0
    ? line
    : activeEditor?.selection.active.line ?? 0;
  const safeLine = Math.max(0, Math.floor(rawLine));
  const safeColumn = Math.max(0, Math.floor(Number.isFinite(column) ? column ?? 0 : 0));
  if (!uri) {
    callGraphLog.appendLine('call graph inlay click ignored: no active editor for fallback resolution');
    return;
  }
  const registered = registry.resolve(uri, safeLine, normalizedKind, safeColumn);
  if (registered) {
    await activateCallGraphInlayEntry(overlay, callGraph, callGraphLog, registered, 'inlay registry position');
    return;
  }
  if (options.allowNearby === true) {
    const nearby = registry.resolveNear(uri, safeLine, normalizedKind, safeColumn, 12);
    if (nearby) {
      await activateCallGraphInlayEntry(overlay, callGraph, callGraphLog, nearby, 'inlay registry nearby');
      return;
    }
  }
  if (registry.isInvalidated(uri)) {
    callGraphLog.appendLine(`call graph inlay click ignored: registry pending refresh for ${uri.toString()}`);
    return;
  }
  const symbol = resolveInlaySymbolAtLine(callGraph, uri, safeLine, safeColumn);
  if (!symbol) {
    callGraphLog.appendLine(`call graph inlay click ignored: no symbol at ${uriString}:${safeLine + 1}`);
    return;
  }
  await activateCallGraphInlayEntry(
    overlay,
    callGraph,
    callGraphLog,
    {
      line: safeLine,
      kind: normalizedKind,
      symbolId: symbol.id,
      label: symbol.qualifiedName,
      hintColumn: symbol.range.endColumn,
    },
    'symbol line fallback',
    symbol,
  );
}

async function activateCallGraphInlayEntry(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  callGraphLog: vscode.OutputChannel,
  entry: CallGraphInlayRegistryEntry,
  source: string,
  symbol?: CallGraphSymbol,
): Promise<void> {
  callGraphLog.appendLine(
    `call graph inlay click source: ${source} kind=${entry.kind} query=${JSON.stringify(entry.label)}`,
  );
  const command = `activateCallGraphInlay:${entry.kind}`;
  await runDedupedCallGraphSymbolCommand(command, entry.symbolId, async () => {
    if (entry.kind === 'impl') {
      await showCallGraphImplementationResult(overlay, callGraph, entry.symbolId, entry.label);
      return;
    }
    if (entry.kind === 'callees') {
      await showCallGraphQueryResult(overlay, callGraph, callGraphLog, 'callees', entry.symbolId, entry.label);
      return;
    }
    await showCallGraphUsageResult(overlay, callGraph, callGraphLog, entry.symbolId, entry.label, symbol);
  });
}

function resolveInlaySymbolAtLine(
  callGraph: CallGraphService,
  uri: vscode.Uri,
  line: number,
  column: number,
): CallGraphSymbol | undefined {
  const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line + 1, 0));
  const summaries = callGraph.getSnapshot() && !callGraph.isRustNativeIndexOnly()
    ? callGraph.getSymbolRelationSummariesForDocument(uri, range)
    : callGraph.getCachedSymbolRelationSummariesForDocument(uri, range);
  if (summaries.length === 0) {
    const targets = callGraph.findTargetsAtPosition(uri, new vscode.Position(line, column));
    return targets[0];
  }
  const sorted = [...summaries].sort((a, b) => {
    const aDistance = Math.abs(a.symbol.range.endColumn - column);
    const bDistance = Math.abs(b.symbol.range.endColumn - column);
    return aDistance - bDistance || a.symbol.range.startColumn - b.symbol.range.startColumn;
  });
  return sorted[0]?.symbol;
}

function documentLineFromVisibleLineOrdinal(
  editor: vscode.TextEditor,
  lineOrdinal: number,
): number | undefined {
  if (!Number.isFinite(lineOrdinal) || lineOrdinal < 0) { return undefined; }
  let remaining = Math.floor(lineOrdinal);
  const ranges = [...editor.visibleRanges].sort((a, b) => a.start.line - b.start.line);
  for (const range of ranges) {
    const start = Math.max(0, range.start.line);
    const end = Math.min(editor.document.lineCount - 1, range.end.line);
    const count = Math.max(0, end - start + 1);
    if (remaining < count) {
      return start + remaining;
    }
    remaining -= count;
  }
  return undefined;
}

const callGraphSymbolCommandDedupe = new Map<string, { startedAt: number; promise: Promise<void> }>();
const CALL_GRAPH_SYMBOL_COMMAND_DEDUPE_MS = 1_000;

async function runDedupedCallGraphSymbolCommand(
  command: string,
  symbolId: string,
  run: () => Promise<void>,
): Promise<void> {
  const key = `${command}\n${symbolId}`;
  const now = Date.now();
  const existing = callGraphSymbolCommandDedupe.get(key);
  if (existing && now - existing.startedAt < CALL_GRAPH_SYMBOL_COMMAND_DEDUPE_MS) {
    return existing.promise;
  }
  const promise = run().finally(() => {
    setTimeout(() => {
      const current = callGraphSymbolCommandDedupe.get(key);
      if (current?.promise === promise) {
        callGraphSymbolCommandDedupe.delete(key);
      }
    }, CALL_GRAPH_SYMBOL_COMMAND_DEDUPE_MS);
  });
  callGraphSymbolCommandDedupe.set(key, { startedAt: now, promise });
  return promise;
}

function getQueryFromActiveEditor(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return ''; }
  const { selection, document } = editor;
  if (!selection.isEmpty) {
    // Keep explicit selections intact, including large multi-line selections.
    // Trimming only removes accidental outer whitespace so literal search can
    // still match a whole-file selection with a final newline.
    const text = document.getText(selection).replace(/^[\s\n]+|[\s\n]+$/g, '');
    if (text) { return text; }
  }
  const wordRange = document.getWordRangeAtPosition(selection.active);
  if (wordRange) { return document.getText(wordRange); }
  return '';
}

async function ensureCallGraphReadyForUi(
  callGraph: CallGraphService,
  title: string,
): Promise<boolean> {
  const snapshot = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: 'Preparing call graph',
      cancellable: false,
    },
    async () => callGraph.ensureRestoredSnapshot(),
  );
  if (snapshot) { return true; }
  const action = 'Rebuild Call Graph';
  const picked = await vscode.window.showWarningMessage(
    `IntelliJ Styled Search: call graph index is not built. ${title} needs a call graph rebuild first.`,
    action,
  );
  if (picked === action) {
    await vscode.commands.executeCommand('intellijStyledSearch.rebuildCallGraph');
  }
  return false;
}

async function showCallGraphQueryResult(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  log: vscode.OutputChannel,
  direction: 'callers' | 'callees',
  explicitQuery?: string,
  explicitLabel?: string,
): Promise<void> {
  try {
    const title = direction === 'callers' ? 'Find Callers' : 'Find Callees';
    if (explicitQuery) {
      await showCallGraphPendingPanel(overlay, title, explicitLabel ?? explicitQuery);
    }
    if (!await ensureCallGraphReadyForUi(callGraph, title)) { return; }
    const query = explicitQuery ?? await getCallGraphQuery(callGraph, title);
    if (!query) { return; }
    const results = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title,
        cancellable: false,
      },
      async () => direction === 'callers'
        ? callGraph.getCallersResolved(query)
        : callGraph.getCalleesResolved(query),
    );
    log.appendLine(formatQueryResults(results, direction));
    if (explicitQuery && results.length === 0) {
      await overlay.showStaticResults(`${title}: ${explicitLabel ?? query}`, []);
      vscode.window.showWarningMessage('No matching call graph symbol found. Rebuild the call graph or refine the query.');
      return;
    }
    await showCallGraphResultsPanel(overlay, results, direction, title);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Call graph query failed: ${msg}`);
  }
}

async function getCallGraphQuery(callGraph: CallGraphService, title: string): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    if (callGraph.isRustNativeIndexOnly()) {
      await callGraph.ensureDocumentSummariesRestored(editor.document.uri);
    }
    const targets = callGraph.findTargetsAtPosition(editor.document.uri, editor.selection.active);
    if (targets.length === 1) { return targets[0].id; }
    if (targets.length > 1) {
      const picked = await vscode.window.showQuickPick(
        targets.map((symbol) => ({
          label: symbol.qualifiedName,
          description: `${symbol.kind} ${symbol.language}`,
          detail: `${symbol.relPath}:${symbol.range.startLine + 1}`,
          symbol,
        })),
        { title },
      );
      if (picked) { return picked.symbol.id; }
    }
  }
  const value = getQueryFromActiveEditor();
  return vscode.window.showInputBox({
    title,
    prompt: 'Symbol name, qualified name, path fragment, or call graph symbol id',
    value,
  });
}

type CallGraphPickItem = vscode.QuickPickItem & {
  edge: CallGraphEdge;
  targetSymbol?: CallGraphSymbol;
};

async function showCallGraphResultsQuickPick(
  results: CallGraphQueryResult[],
  direction: 'callers' | 'callees',
  title: string,
): Promise<void> {
  const items = buildCallGraphQuickPickItems(results, direction);
  if (results.length === 0) {
    vscode.window.showWarningMessage('No matching call graph symbol found. Rebuild the call graph or refine the query.');
    return;
  }
  const targetLabel = results.map((result) => result.symbol.qualifiedName).join(', ');
  if (items.length === 0) {
    vscode.window.showInformationMessage(`No ${direction} found for ${targetLabel}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: `${items.length} ${direction} for ${targetLabel}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) { return; }
  await openCallGraphPick(picked, direction);
}

async function showCallGraphResultsPanel(
  overlay: OverlayPanel,
  results: CallGraphQueryResult[],
  direction: 'callers' | 'callees',
  title: string,
): Promise<void> {
  if (results.length === 0) {
    vscode.window.showWarningMessage('No matching call graph symbol found. Rebuild the call graph or refine the query.');
    return;
  }
  const targetLabel = results.map((result) => result.symbol.qualifiedName).join(', ');
  const matches = await buildCallGraphEdgeFileMatches(results, direction);
  if (matches.length === 0) {
    vscode.window.showInformationMessage(`No ${direction} found for ${targetLabel}.`);
    return;
  }
  await overlay.showStaticResults(`${title}: ${targetLabel}`, matches);
}

async function showCallGraphImplementationResult(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  explicitQuery?: string,
  explicitLabel?: string,
): Promise<void> {
  try {
    const title = 'Find Implementations';
    if (explicitQuery) {
      await showCallGraphPendingPanel(overlay, title, explicitLabel ?? explicitQuery);
    }
    if (!await ensureCallGraphReadyForUi(callGraph, title)) { return; }
    const query = explicitQuery ?? await getCallGraphQuery(callGraph, title);
    if (!query) { return; }
    const implementations = callGraph.findImplementations(query);
    if (implementations.length === 0) {
      if (explicitQuery) {
        await overlay.showStaticResults(`${title}: ${explicitLabel ?? query}`, []);
      }
      vscode.window.showInformationMessage('No implementations found for the selected call graph symbol.');
      return;
    }
    const targetLabel = callGraph.resolveSymbols(query, 1)[0]?.qualifiedName ?? 'selected symbol';
    const matches = await buildCallGraphImplementationFileMatches(implementations);
    await overlay.showStaticResults(`${title}: ${targetLabel}`, matches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Call graph implementations failed: ${msg}`);
  }
}

async function showCallGraphUsageResult(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  callGraphLog: vscode.OutputChannel,
  explicitQuery?: string,
  explicitLabel?: string,
  explicitSymbol?: CallGraphSymbol,
): Promise<void> {
  try {
    const title = 'Find Usages';
    const showedPendingPanel = !!explicitQuery;
    if (explicitQuery) {
      await showCallGraphPendingPanel(overlay, title, explicitLabel ?? explicitQuery);
    }

    if (explicitQuery) {
      const explicitSymbolId = explicitSymbol?.id ?? explicitQuery;
      if (explicitSymbol || isCallGraphSymbolId(explicitSymbolId)) {
        const cachedUsages = await callGraph.findUsagesForSymbolIdFromCache(explicitSymbolId);
        if (cachedUsages) {
          await showCallGraphUsageMatches(
            overlay,
            callGraphLog,
            title,
            explicitQuery,
            explicitSymbol,
            cachedUsages,
            'call graph cache-index',
            false,
            explicitLabel ?? explicitSymbol?.qualifiedName ?? labelFromCallGraphSymbolId(explicitSymbolId),
            showedPendingPanel,
          );
          return;
        }
      }
    }

    if (!await ensureCallGraphReadyForUi(callGraph, title)) { return; }
    const query = explicitQuery ?? await getCallGraphQuery(callGraph, title);
    if (!query) { return; }
    const targetSymbol = (await callGraph.resolveSymbolsResolved(query, 1))[0];
    const usages = targetSymbol && callGraph.isRustNativeIndexOnly()
      ? await callGraph.findUsagesForSymbolIdFromCache(targetSymbol.id) ?? []
      : callGraph.findUsages(query);
    await showCallGraphUsageMatches(
      overlay,
      callGraphLog,
      title,
      query,
      targetSymbol,
      usages,
      'call graph cache',
      !explicitQuery,
      explicitLabel,
      showedPendingPanel,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Call graph usages failed: ${msg}`);
  }
}

async function showCallGraphUsageMatches(
  overlay: OverlayPanel,
  callGraphLog: vscode.OutputChannel,
  title: string,
  query: string,
  targetSymbol: CallGraphSymbol | undefined,
  usages: CallGraphReference[],
  initialSourceLabel: string,
  allowTextFallback: boolean,
  targetLabelOverride?: string,
  showEmptyPanel = false,
): Promise<void> {
  let sourceLabel = initialSourceLabel;
  let matches = await buildCallGraphUsageFileMatches(usages);
  const graphMatchCount = countFileMatchMatches(matches);
  const targetLabel = targetLabelOverride ?? targetSymbol?.qualifiedName ?? query;
  callGraphLog.appendLine(
    `find usages source: ${initialSourceLabel} query=${JSON.stringify(targetLabel)} ` +
    `matches=${graphMatchCount}`,
  );
  if (allowTextFallback && targetSymbol && shouldSearchUsageTextFallback(targetSymbol, graphMatchCount)) {
    const searched = await searchWorkspaceForUsageText(overlay, targetSymbol);
    const searchMatches = searched.result.matches;
    const total = countFileMatchMatches(searchMatches);
    if (total > 0) {
      const searchLabel = searched.result.requestedEngine === searched.result.effectiveEngine
        ? searched.result.effectiveEngine
        : `${searched.result.requestedEngine}->${searched.result.effectiveEngine}`;
      sourceLabel = graphMatchCount > 0 ? `${sourceLabel}+${searchLabel}` : searchLabel;
      matches = graphMatchCount > 0 ? mergeFileMatches(matches, searchMatches) : searchMatches;
    }
    callGraphLog.appendLine(
      `find usages text fallback: query=${JSON.stringify(targetSymbol.name)} requested=${searched.result.requestedEngine} ` +
      `effective=${searched.result.effectiveEngine} matches=${total}` +
      `${searched.result.fallbackReason ? ` fallbackReason=${searched.result.fallbackReason}` : ''}`,
    );
  }
  if (matches.length === 0) {
    if (showEmptyPanel) {
      await overlay.showStaticResults(`${title} [${sourceLabel}]: ${targetLabel}`, []);
    }
    vscode.window.showInformationMessage('No usages found for the selected call graph symbol.');
    return;
  }
  await overlay.showStaticResults(`${title} [${sourceLabel}]: ${targetLabel}`, matches);
}

function labelFromCallGraphSymbolId(symbolId: string): string {
  const parts = symbolId.split(':');
  return parts.length >= 4 ? parts[parts.length - 2] || symbolId : symbolId;
}

function isCallGraphSymbolId(value: string): boolean {
  const parts = value.split(':');
  return parts.length >= 4 && /^(?:python|java|kotlin|typescript|javascript)$/.test(parts[0] ?? '');
}

async function showCallGraphPendingPanel(
  overlay: OverlayPanel,
  title: string,
  label: string,
): Promise<void> {
  const sourceWindowId = overlay.getRendererCommandWindowIdForShow();
  overlay.markRendererCommandPendingPanel(sourceWindowId);
  await overlay.show(`${title}: ${label}`, {
    forceLiteral: true,
    suppressSearch: true,
    preferredWindowId: sourceWindowId,
    spawn: sourceWindowId !== undefined,
    statusText: 'Loading call graph results...',
    loading: true,
  });
}

function shouldSearchUsageTextFallback(symbol: CallGraphSymbol, graphMatchCount: number): boolean {
  return graphMatchCount === 0 || (symbol.name.length >= 4 && graphMatchCount < 20);
}

async function searchWorkspaceForUsageText(
  overlay: OverlayPanel,
  symbol: CallGraphSymbol,
): Promise<{ result: SearchForTestsResult }> {
  const result = await overlay.searchForTestsDetailed({
    query: symbol.name,
    caseSensitive: true,
    wholeWord: true,
    useRegex: false,
    includePatterns: CALL_GRAPH_USAGE_SEARCH_INCLUDE_PATTERNS,
  });
  return { result };
}

export function buildCallGraphQuickPickItems(
  results: CallGraphQueryResult[],
  direction: 'callers' | 'callees',
): CallGraphPickItem[] {
  const items: CallGraphPickItem[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const related = new Map<string, CallGraphSymbol>();
    related.set(result.symbol.id, result.symbol);
    for (const symbol of result.relatedSymbols) {
      related.set(symbol.id, symbol);
    }
    for (const edge of result.edges) {
      const targetSymbol = direction === 'callers'
        ? related.get(edge.callerId)
        : edge.calleeId ? related.get(edge.calleeId) : undefined;
      const label = targetSymbol
        ? `$(symbol-method) ${targetSymbol.qualifiedName}`
        : `$(question) ${edge.calleeName}`;
      const location = `${edge.callsite.relPath}:${edge.callsite.range.startLine + 1}`;
      const key = `${edge.id}:${targetSymbol?.id ?? edge.calleeName}:${location}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      items.push({
        label,
        description: `${edge.confidence}/${edge.callKind}`,
        detail: direction === 'callers'
          ? `calls ${result.symbol.qualifiedName} at ${location}`
          : `called from ${result.symbol.qualifiedName} at ${location}`,
        edge,
        targetSymbol,
      });
    }
  }
  return items;
}

type ImplementationPickItem = vscode.QuickPickItem & {
  symbol: CallGraphSymbol;
};

type UsagePickItem = vscode.QuickPickItem & {
  reference: CallGraphReference;
};

function countFileMatchMatches(matches: FileMatch[]): number {
  return matches.reduce((sum, match) => sum + match.matches.length, 0);
}

function mergeFileMatches(primary: FileMatch[], secondary: FileMatch[]): FileMatch[] {
  const byUri = new Map<string, FileMatch>();
  const addMatch = (fileMatch: FileMatch) => {
    let existing = byUri.get(fileMatch.uri);
    if (!existing) {
      existing = { uri: fileMatch.uri, relPath: fileMatch.relPath, matches: [] };
      byUri.set(fileMatch.uri, existing);
    }
    for (const match of fileMatch.matches) {
      if (existing.matches.some((item) => fileMatchEntryOverlaps(item, match))) { continue; }
      existing.matches.push(match);
    }
  };
  for (const fileMatch of primary) { addMatch(fileMatch); }
  for (const fileMatch of secondary) { addMatch(fileMatch); }
  return [...byUri.values()]
    .map((fileMatch) => ({
      ...fileMatch,
      matches: fileMatch.matches.sort((a, b) => a.line - b.line || firstRangeStart(a.ranges) - firstRangeStart(b.ranges)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function fileMatchEntryOverlaps(
  left: FileMatch['matches'][number],
  right: FileMatch['matches'][number],
): boolean {
  if (left.line !== right.line) { return false; }
  return left.ranges.some((leftRange) => right.ranges.some((rightRange) => rangesOverlap(leftRange, rightRange)));
}

function rangesOverlap(left: MatchRange, right: MatchRange): boolean {
  const leftEnd = left.endLine === undefined ? left.end : Number.MAX_SAFE_INTEGER;
  const rightEnd = right.endLine === undefined ? right.end : Number.MAX_SAFE_INTEGER;
  return Math.max(left.start, right.start) <= Math.min(leftEnd, rightEnd);
}

function firstRangeStart(ranges: MatchRange[]): number {
  return ranges[0]?.start ?? 0;
}

function buildImplementationQuickPickItems(symbols: CallGraphSymbol[]): ImplementationPickItem[] {
  return symbols.map((symbol) => ({
    label: `$(symbol-class) ${symbol.qualifiedName}`,
    description: `${symbol.kind} ${symbol.language}`,
    detail: `${symbol.relPath}:${symbol.range.startLine + 1}${symbol.signature ? ` | ${symbol.signature}` : ''}`,
    symbol,
  }));
}

function buildUsageQuickPickItems(references: CallGraphReference[]): UsagePickItem[] {
  return references.map((reference) => ({
    label: `$(references) ${reference.name}`,
    description: `${reference.relPath}:${reference.range.startLine + 1}`,
    detail: reference.rawText,
    reference,
  }));
}

export async function buildCallGraphEdgeFileMatches(
  results: CallGraphQueryResult[],
  _direction: 'callers' | 'callees',
): Promise<FileMatch[]> {
  const locations = results.flatMap((result) => result.edges.map((edge) => ({
    uri: edge.callsite.uri,
    relPath: edge.callsite.relPath,
    range: edge.callsite.range,
    fallbackPreview: edge.callsite.rawText,
  })));
  return buildCallGraphLocationFileMatches(locations);
}

export async function buildCallGraphUsageFileMatches(references: CallGraphReference[]): Promise<FileMatch[]> {
  return buildCallGraphLocationFileMatches(references.map((reference) => ({
    uri: reference.uri,
    relPath: reference.relPath,
    range: reference.range,
    fallbackPreview: reference.rawText,
  })));
}

export async function buildCallGraphImplementationFileMatches(symbols: CallGraphSymbol[]): Promise<FileMatch[]> {
  return buildCallGraphLocationFileMatches(symbols.map((symbol) => ({
    uri: symbol.uri,
    relPath: symbol.relPath,
    range: symbol.range,
    fallbackPreview: symbol.signature || symbol.qualifiedName,
  })));
}

async function buildCallGraphLocationFileMatches(locations: Array<{
  uri: string;
  relPath: string;
  range: CallGraphRange;
  fallbackPreview: string;
}>): Promise<FileMatch[]> {
  const seenLocations = new Set<string>();
  const byUri = new Map<string, Array<{
    relPath: string;
    range: CallGraphRange;
    fallbackPreview: string;
  }>>();
  for (const location of locations) {
    const locationKey = [
      location.uri,
      location.range.startLine,
      location.range.startColumn,
    ].join(':');
    if (seenLocations.has(locationKey)) { continue; }
    seenLocations.add(locationKey);
    const existing = byUri.get(location.uri);
    const entry = {
      relPath: location.relPath,
      range: location.range,
      fallbackPreview: location.fallbackPreview,
    };
    if (existing) {
      existing.push(entry);
    } else {
      byUri.set(location.uri, [entry]);
    }
  }
  const out: FileMatch[] = [];
  for (const [uriString, entries] of byUri) {
    let lines: string[] | undefined;
    let relPath = entries[0]?.relPath ?? uriString;
    try {
      const uri = vscode.Uri.parse(uriString);
      const doc = await vscode.workspace.openTextDocument(uri);
      lines = doc.getText().split(/\r?\n/);
      relPath = vscode.workspace.asRelativePath(uri, false);
    } catch {}
    const matches = entries
      .sort((a, b) => a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn)
      .map((entry) => {
        const preview = lines?.[entry.range.startLine] ?? entry.fallbackPreview;
        return {
          line: entry.range.startLine,
          preview,
          ranges: [toMatchRange(entry.range, preview)],
        };
      });
    out.push({ uri: uriString, relPath, matches });
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function toMatchRange(range: CallGraphRange, preview: string): MatchRange {
  const lineLength = preview.length;
  const start = Math.max(0, Math.min(lineLength, range.startColumn));
  const rawEnd = range.endLine > range.startLine ? lineLength : range.endColumn;
  const end = Math.max(start + 1, Math.min(lineLength, rawEnd));
  if (range.endLine > range.startLine) {
    return {
      start,
      end,
      endLine: range.endLine,
      endCol: range.endColumn,
    };
  }
  return { start, end };
}

async function openCallGraphPick(item: CallGraphPickItem, direction: 'callers' | 'callees'): Promise<void> {
  const symbolRange = item.targetSymbol?.range;
  const symbolUri = item.targetSymbol?.uri;
  const openSymbol = direction === 'callees' && symbolRange && symbolUri;
  const uri = vscode.Uri.parse(openSymbol ? symbolUri : item.edge.callsite.uri);
  const range = openSymbol ? symbolRange : item.edge.callsite.range;
  await openCallGraphLocation(uri, range);
}

async function openCallGraphSymbol(symbol: CallGraphSymbol): Promise<void> {
  await openCallGraphLocation(vscode.Uri.parse(symbol.uri), symbol.range);
}

async function openCallGraphReference(reference: CallGraphReference): Promise<void> {
  await openCallGraphLocation(vscode.Uri.parse(reference.uri), reference.range);
}

async function openCallGraphLocation(uri: vscode.Uri, range: CallGraphRange): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    selection: toVsCodeRange(range),
  });
  editor.revealRange(toVsCodeRange(range), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function toVsCodeRange(range: CallGraphRange): vscode.Range {
  return new vscode.Range(
    range.startLine,
    range.startColumn,
    range.endLine,
    Math.max(range.startColumn, range.endColumn),
  );
}

export function formatCallGraphProgressMessage(progress: CallGraphRebuildProgress): string {
  const heapInfo = progress.heapUsedMb !== undefined && progress.heapLimitMb !== undefined && progress.heapUsageRatio !== undefined
    ? `heap=${progress.heapUsedMb}/${progress.heapLimitMb}MB(${Math.round(progress.heapUsageRatio * 100)}%)`
    : '';
  const byteInfo = formatCallGraphProgressBytes(progress);
  const overallPercent = estimateCallGraphOverallProgressPercent(progress);
  return [
    progress.message,
    `overall=${overallPercent}%`,
    progress.total > 0 ? `${progress.current}/${progress.total}` : '',
    byteInfo,
    `parsed=${progress.parsedFiles}`,
    `skipped=${progress.skippedFiles}`,
    `workers=${progress.concurrency}/${progress.maxConcurrency ?? progress.concurrency}`,
    heapInfo,
    progress.workerThrottleCount ? `throttles=${progress.workerThrottleCount}` : '',
    `${progress.elapsedMs}ms`,
  ].filter(Boolean).join(' ');
}

function formatCallGraphProgressBytes(progress: CallGraphRebuildProgress): string {
  return progress.currentBytes !== undefined && progress.totalBytes !== undefined
    ? `bytes=${progress.currentBytes}/${progress.totalBytes}`
    : '';
}

export function estimateCallGraphOverallProgressPercent(progress: CallGraphRebuildProgress): number {
  if (progress.stage === 'done') { return 100; }
  const [start, end] = callGraphStageProgressRange(progress.stage);
  const stageRatio = progress.totalBytes !== undefined && progress.totalBytes > 0 && progress.currentBytes !== undefined
    ? Math.max(0, Math.min(1, progress.currentBytes / progress.totalBytes))
    : progress.total > 0
    ? Math.max(0, Math.min(1, progress.current / progress.total))
    : 0;
  return Math.max(0, Math.min(99, Math.round(start + (end - start) * stageRatio)));
}

function callGraphStageProgressRange(stage: CallGraphRebuildProgress['stage']): [number, number] {
  switch (stage) {
    case 'discovering': return [0, 5];
    case 'parsing': return [5, 45];
    case 'resolving': return [45, 80];
    case 'indexing': return [80, 98];
    case 'deduping': return [98, 99];
    case 'done': return [100, 100];
    default: return [0, 99];
  }
}

async function buildPreviewCallGraphInlays(
  callGraph: CallGraphService,
  log: vscode.OutputChannel,
  uri: vscode.Uri,
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<PreviewCallGraphInlay[]> {
  const startedAt = Date.now();
  const relPath = vscode.workspace.asRelativePath(uri, false);
  const rangeLabel = `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  if (!cfg.get<boolean>('callGraphInlayHints', true)) {
    log.appendLine(`preview inlays provider skipped: disabled uri=${relPath} range=${rangeLabel}`);
    return [];
  }
  const hasSnapshot = !!callGraph.getSnapshot() && !callGraph.isRustNativeIndexOnly();
  let restored = hasSnapshot;
  if (!hasSnapshot) {
    restored = await callGraph.ensureDocumentSummariesRestored(document.uri);
    if (!restored) {
      log.appendLine(`preview inlays provider skipped: no document summaries uri=${relPath} range=${rangeLabel} elapsed=${Date.now() - startedAt}ms`);
      return [];
    }
  }
  const showCalleeInlayHints = cfg.get<boolean>('callGraphShowCalleeInlayHints', false);
  const summaries = hasSnapshot
    ? callGraph.getSymbolRelationSummariesForDocument(document.uri, range)
    : callGraph.getCachedSymbolRelationSummariesForDocument(document.uri, range);
  let inRange = 0;
  let definitionLines = 0;
  const inlays: PreviewCallGraphInlay[] = [];
  for (const summary of summaries) {
    if (summary.symbol.range.startLine < 0 || summary.symbol.range.startLine >= document.lineCount) { continue; }
    inRange++;
    if (!isCallGraphInlayDefinitionLine(document, summary.symbol)) { continue; }
    definitionLines++;
    const lineEndColumn = document.lineAt(summary.symbol.range.startLine).range.end.character;
    inlays.push(...buildPreviewCallGraphInlayEntries(summary, showCalleeInlayHints, lineEndColumn));
  }
  const sample = inlays
    .slice(0, 3)
    .map((inlay) => `${inlay.kind}:${inlay.line + 1}:${inlay.symbolId}`)
    .join(' | ');
  log.appendLine(
    `preview inlays provider: uri=${relPath} range=${rangeLabel} snapshot=${hasSnapshot} restored=${restored} ` +
    `summaries=${summaries.length} inRange=${inRange} definitionLines=${definitionLines} inlays=${inlays.length} ` +
    `calleeHints=${showCalleeInlayHints} elapsed=${Date.now() - startedAt}ms${sample ? ` sample=${sample}` : ''}`,
  );
  return inlays;
}

function buildPreviewCallGraphInlayEntries(
  summary: CallGraphSymbolRelationSummary,
  showCalleeInlayHints: boolean,
  lineEndColumn: number,
): PreviewCallGraphInlay[] {
  const base = {
    line: summary.symbol.range.startLine,
    column: lineEndColumn,
    symbolId: summary.symbol.id,
    label: summary.symbol.qualifiedName,
  };
  const entries: PreviewCallGraphInlay[] = [];
  if (showCalleeInlayHints && summary.calleeCount > 0) {
    entries.push({ ...base, kind: 'callees', text: `callees ${summary.calleeCount}`, count: summary.calleeCount });
  }
  if (summary.implementationCount > 0) {
    entries.push({ ...base, kind: 'impl', text: `impl ${summary.implementationCount}`, count: summary.implementationCount });
  }
  if (summary.usageCount > 0) {
    entries.push({ ...base, kind: 'usages', text: `usages ${summary.usageCount}`, count: summary.usageCount });
  }
  return entries;
}

class CallGraphInlayHintsProvider implements vscode.InlayHintsProvider {
  readonly onDidChangeInlayHints: vscode.Event<void>;

  constructor(
    private readonly overlay: OverlayPanel,
    private readonly callGraph: CallGraphService,
    private readonly registry: CallGraphInlayRegistry,
  ) {
    this.onDidChangeInlayHints = callGraph.onDidChangeSnapshot;
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    if (token.isCancellationRequested) { return []; }
    if (!cfg.get<boolean>('callGraphInlayHints', true)) {
      this.registry.replaceRange(document.uri, range, []);
      return [];
    }
    const hasSnapshot = !!this.callGraph.getSnapshot() && !this.callGraph.isRustNativeIndexOnly();
    if (!hasSnapshot) {
      const restored = await this.callGraph.ensureDocumentSummariesRestored(document.uri);
      if (token.isCancellationRequested) { return []; }
      if (!restored) {
        this.registry.replaceRange(document.uri, range, []);
        return [];
      }
    }
    const showCalleeInlayHints = cfg.get<boolean>('callGraphShowCalleeInlayHints', false);
    const summaries = hasSnapshot
      ? this.callGraph.getSymbolRelationSummariesForDocument(document.uri, range)
      : this.callGraph.getCachedSymbolRelationSummariesForDocument(document.uri, range);
    const hints: vscode.InlayHint[] = [];
    const registryEntries: CallGraphInlayRegistryEntry[] = [];
    for (const summary of summaries
      .filter((summary) => summary.symbol.range.startLine >= 0 && summary.symbol.range.startLine < document.lineCount)
      .filter((summary) => isCallGraphInlayDefinitionLine(document, summary.symbol))) {
      const lineEndColumn = document.lineAt(summary.symbol.range.startLine).range.end.character;
      const hint = buildCallGraphInlayHint(
        summary,
        showCalleeInlayHints,
        lineEndColumn,
      );
      if (!hint) { continue; }
      hints.push(hint);
      registryEntries.push(...buildCallGraphInlayRegistryEntries(summary, showCalleeInlayHints, lineEndColumn));
    }
    this.registry.replaceRange(document.uri, range, registryEntries);
    if (hints.length > 0) {
      this.overlay.scheduleRendererInlayClickHookWarmup('call-graph-inlay-hints');
    }
    return hints;
  }
}

function isCallGraphInlayDefinitionLine(document: vscode.TextDocument, symbol: CallGraphSymbol): boolean {
  if (symbol.range.startLine < 0 || symbol.range.startLine >= document.lineCount) { return false; }
  const line = document.lineAt(symbol.range.startLine).text;
  if (line.slice(symbol.range.startColumn, symbol.range.startColumn + symbol.name.length) !== symbol.name) {
    return false;
  }
  const signatureFirstLine = (symbol.signature ?? '').split(/\r?\n/)[0]?.trim();
  if (!signatureFirstLine) { return true; }
  const normalizedLine = normalizeDeclarationText(stripDeclarationLineComment(line));
  const normalizedSignature = normalizeDeclarationText(stripDeclarationLineComment(signatureFirstLine));
  if (normalizedLine.includes(normalizedSignature) || normalizedSignature.includes(normalizedLine)) {
    return true;
  }
  const declarationLines = [];
  const endLine = Math.min(document.lineCount - 1, symbol.bodyRange.startLine + 40);
  for (let lineNo = symbol.range.startLine; lineNo <= endLine; lineNo++) {
    declarationLines.push(stripDeclarationLineComment(document.lineAt(lineNo).text));
    const normalizedDeclaration = normalizeDeclarationText(declarationLines.join(' '));
    if (normalizedDeclaration.includes(normalizedSignature)) {
      return true;
    }
  }
  return false;
}

function normalizeDeclarationText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function stripDeclarationLineComment(value: string): string {
  return value
    .replace(/\s+#.*$/, '')
    .replace(/\s+\/\/.*$/, '');
}

class CallGraphImplementationProvider implements vscode.ImplementationProvider {
  constructor(private readonly callGraph: CallGraphService) {}

  provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    if (!cfg.get<boolean>('callGraphImplementationProvider', true) || token.isCancellationRequested) { return []; }
    return this.callGraph
      .findImplementationsAtPosition(document.uri, position)
      .map((symbol) => new vscode.Location(vscode.Uri.parse(symbol.uri), toVsCodeRange(symbol.range)));
  }
}

function buildCallGraphInlayHint(
  summary: CallGraphSymbolRelationSummary,
  showCalleeInlayHints = false,
  lineEndColumn = summary.symbol.range.endColumn,
): vscode.InlayHint | undefined {
  const parts: vscode.InlayHintLabelPart[] = [];
  if (showCalleeInlayHints && summary.calleeCount > 0) {
    appendInlaySeparator(parts);
    parts.push(makeInlayCommandPart(
      `callees ${summary.calleeCount}`,
      `Show ${summary.calleeCount} callee${summary.calleeCount === 1 ? '' : 's'}`,
      'intellijStyledSearch.showCalleesForSymbol',
      summary.symbol.id,
      summary.symbol.qualifiedName,
    ));
  }
  if (summary.implementationCount > 0) {
    appendInlaySeparator(parts);
    parts.push(makeInlayCommandPart(
      `impl ${summary.implementationCount}`,
      `Show ${summary.implementationCount} implementation${summary.implementationCount === 1 ? '' : 's'}`,
      'intellijStyledSearch.showImplementationsForSymbol',
      summary.symbol.id,
      summary.symbol.qualifiedName,
    ));
  }
  if (summary.usageCount > 0) {
    appendInlaySeparator(parts);
    parts.push(makeInlayCommandPart(
      `usages ${summary.usageCount}`,
      `Show ${summary.usageCount} usage${summary.usageCount === 1 ? '' : 's'}`,
      'intellijStyledSearch.showUsagesForSymbol',
      summary.symbol.id,
      summary.symbol.qualifiedName,
    ));
  }
  if (parts.length === 0) { return undefined; }
  const hint = new vscode.InlayHint(
    new vscode.Position(summary.symbol.range.startLine, lineEndColumn),
    parts,
  );
  hint.paddingLeft = true;
  return hint;
}

function buildCallGraphInlayRegistryEntries(
  summary: CallGraphSymbolRelationSummary,
  showCalleeInlayHints: boolean,
  lineEndColumn: number,
): CallGraphInlayRegistryEntry[] {
  const base = {
    line: summary.symbol.range.startLine,
    symbolId: summary.symbol.id,
    label: summary.symbol.qualifiedName,
    hintColumn: lineEndColumn,
  };
  const entries: CallGraphInlayRegistryEntry[] = [];
  if (showCalleeInlayHints && summary.calleeCount > 0) {
    entries.push({ ...base, kind: 'callees' });
  }
  if (summary.implementationCount > 0) {
    entries.push({ ...base, kind: 'impl' });
  }
  if (summary.usageCount > 0) {
    entries.push({ ...base, kind: 'usages' });
  }
  return entries;
}

function makeInlayCommandPart(
  label: string,
  title: string,
  command: string,
  symbolId: string,
  symbolLabel: string,
): vscode.InlayHintLabelPart {
  const part = new vscode.InlayHintLabelPart(label);
  part.command = {
    title,
    command,
    arguments: [symbolId, symbolLabel],
  };
  return part;
}

function appendInlaySeparator(parts: vscode.InlayHintLabelPart[]): void {
  if (parts.length === 0) { return; }
  parts.push(new vscode.InlayHintLabelPart(' | '));
}
