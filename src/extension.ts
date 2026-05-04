import * as vscode from 'vscode';
import { OverlayPanel } from './overlayPanel';
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
  const callGraphLog = vscode.window.createOutputChannel('IntelliJ Styled Search: Call Graph');
  const callGraph = new CallGraphService(context, callGraphLog);
  const mcpServer = new CallGraphMcpServer(callGraph, callGraphLog);
  context.subscriptions.push(callGraphLog, callGraph, mcpServer);
  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(CALL_GRAPH_DOCUMENT_SELECTOR, new CallGraphInlayHintsProvider(callGraph)),
    vscode.languages.registerImplementationProvider(CALL_GRAPH_DOCUMENT_SELECTOR, new CallGraphImplementationProvider(callGraph)),
  );
  overlay.logActivation();
  // Warm only the search backend. Renderer/CDP patching is intentionally
  // lazy because opening CDP at activation can make the whole workbench feel
  // sluggish.
  void overlay.prewarm();

  context.subscriptions.push(
    vscode.commands.registerCommand('intellijStyledSearch.searchInProject', () => {
      overlay.logCommand('searchInProject');
      void overlay.show('');
    }),
    vscode.commands.registerCommand('intellijStyledSearch.searchSelection', () => {
      overlay.logCommand('searchSelection');
      void overlay.show(getQueryFromActiveEditor(), { forceLiteral: true });
    }),
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
      overlay.logCommand('rebuildIndex');
      try {
        await overlay.rebuildIndex();
        vscode.window.showInformationMessage('IntelliJ Styled Search: index rebuilt.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Index rebuild failed: ${msg}`);
      }
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
    vscode.commands.registerCommand('intellijStyledSearch.rebuildCallGraph', async () => {
      overlay.logCommand('rebuildCallGraph');
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      status.text = '$(sync~spin) Call graph: starting';
      status.show();
      callGraphLog.show(true);
      callGraphLog.appendLine('call graph rebuild requested');
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'IntelliJ Styled Search: rebuilding call graph',
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
            try {
              const snapshot = await callGraph.rebuild((progress) => {
                const percent = progress.total > 0
                  ? Math.min(100, Math.round((progress.current / progress.total) * 100))
                  : 0;
                const message = formatCallGraphProgressMessage(progress);
                latestMessage = message;
                latestPercent = percent;
                const increment = Math.max(0, percent - lastPercent);
                lastPercent = Math.max(lastPercent, percent);
                ui.report({ message, increment });
                status.text = `$(sync~spin) Call graph ${percent}% ${progress.current}/${progress.total}`;
                const now = Date.now();
                if (progress.stage !== lastStage || now - lastLogAt >= 1_000 || progress.stage === 'done') {
                  callGraphLog.appendLine(
                    `call graph progress: stage=${progress.stage} current=${progress.current}/${progress.total} ` +
                    `parsed=${progress.parsedFiles} skipped=${progress.skippedFiles} warnings=${progress.warningCount} ` +
                    `workers=${progress.concurrency} elapsed=${progress.elapsedMs}ms`,
                  );
                  lastLogAt = now;
                  lastStage = progress.stage;
                }
              }, token);
              ui.report({ increment: Math.max(0, 100 - lastPercent), message: 'done; writing summary' });
              callGraphLog.appendLine(callGraph.formatInfoReport(snapshot));
            } finally {
              clearInterval(heartbeat);
            }
          },
        );
        status.text = '$(check) Call graph rebuilt';
        vscode.window.showInformationMessage('IntelliJ Styled Search: call graph rebuilt.');
      } catch (err) {
        if (err instanceof CallGraphRebuildCancelledError) {
          status.text = '$(circle-slash) Call graph rebuild cancelled';
          callGraphLog.appendLine('call graph rebuild cancelled');
          vscode.window.showWarningMessage('IntelliJ Styled Search: call graph rebuild cancelled.');
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        status.text = '$(error) Call graph rebuild failed';
        vscode.window.showErrorMessage(`Call graph rebuild failed: ${msg}`);
      } finally {
        setTimeout(() => status.dispose(), 4_000);
      }
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showCallGraphInfo', async () => {
      overlay.logCommand('showCallGraphInfo');
      try {
        const snapshot = await callGraph.ensureBuilt();
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
    vscode.commands.registerCommand('intellijStyledSearch.showCallersForSymbol', async (symbolId: string) => {
      await runDedupedCallGraphSymbolCommand('showCallersForSymbol', symbolId, () =>
        showCallGraphUsageResult(overlay, callGraph, callGraphLog, symbolId));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showCalleesForSymbol', async (symbolId: string) => {
      await runDedupedCallGraphSymbolCommand('showCalleesForSymbol', symbolId, () =>
        showCallGraphQueryResult(overlay, callGraph, callGraphLog, 'callees', symbolId));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showImplementationsForSymbol', async (symbolId: string) => {
      await runDedupedCallGraphSymbolCommand('showImplementationsForSymbol', symbolId, () =>
        showCallGraphImplementationResult(overlay, callGraph, symbolId));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.showUsagesForSymbol', async (symbolId: string) => {
      await runDedupedCallGraphSymbolCommand('showUsagesForSymbol', symbolId, () =>
        showCallGraphUsageResult(overlay, callGraph, callGraphLog, symbolId));
    }),
    vscode.commands.registerCommand('intellijStyledSearch.activateCallGraphInlayAtPosition', async (
      kind: string,
      uriString: string,
      line: number,
      column?: number,
    ) => {
      await activateCallGraphInlayAtPosition(overlay, callGraph, callGraphLog, kind, uriString, line, column);
    }),
    vscode.commands.registerCommand('intellijStyledSearch.startMcpServer', async () => {
      overlay.logCommand('startMcpServer');
      try {
        const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
        const port = cfg.get<number>('mcpPort', 8765);
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
  kind: string,
  uriString: string,
  line: number,
  column?: number,
): Promise<void> {
  const normalizedKind = kind === 'impl' || kind === 'implementations'
    ? 'impl'
    : kind === 'callees'
      ? 'callees'
      : 'usages';
  const uri = vscode.Uri.parse(uriString);
  const safeLine = Math.max(0, Math.floor(Number.isFinite(line) ? line : 0));
  const safeColumn = Math.max(0, Math.floor(Number.isFinite(column) ? column ?? 0 : 0));
  const symbol = resolveInlaySymbolAtLine(callGraph, uri, safeLine, safeColumn);
  if (!symbol) {
    callGraphLog.appendLine(`call graph inlay click ignored: no symbol at ${uriString}:${safeLine + 1}`);
    return;
  }
  const command = `activateCallGraphInlayAtPosition:${normalizedKind}`;
  await runDedupedCallGraphSymbolCommand(command, symbol.id, async () => {
    if (normalizedKind === 'impl') {
      await showCallGraphImplementationResult(overlay, callGraph, symbol.id);
      return;
    }
    if (normalizedKind === 'callees') {
      await showCallGraphQueryResult(overlay, callGraph, callGraphLog, 'callees', symbol.id);
      return;
    }
    await showCallGraphUsageResult(overlay, callGraph, callGraphLog, symbol.id);
  });
}

function resolveInlaySymbolAtLine(
  callGraph: CallGraphService,
  uri: vscode.Uri,
  line: number,
  column: number,
): CallGraphSymbol | undefined {
  const range = new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line + 1, 0));
  const summaries = callGraph.getSnapshot()
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
    // Pass the full multi-line selection through. Leading/trailing
    // whitespace and blank lines get trimmed — they're almost always
    // accidental when copy/selecting code, and rg's literal matcher
    // wouldn't match them against the file anyway.
    const text = document.getText(selection).replace(/^[\s\n]+|[\s\n]+$/g, '');
    if (text) { return text; }
  }
  const wordRange = document.getWordRangeAtPosition(selection.active);
  if (wordRange) { return document.getText(wordRange); }
  return '';
}

async function showCallGraphQueryResult(
  overlay: OverlayPanel,
  callGraph: CallGraphService,
  log: vscode.OutputChannel,
  direction: 'callers' | 'callees',
  explicitQuery?: string,
): Promise<void> {
  try {
    const title = direction === 'callers' ? 'Find Callers' : 'Find Callees';
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Preparing call graph',
        cancellable: false,
      },
      async () => {
        await callGraph.ensureBuilt();
      },
    );
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
    await showCallGraphResultsPanel(overlay, results, direction, title);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Call graph query failed: ${msg}`);
  }
}

async function getCallGraphQuery(callGraph: CallGraphService, title: string): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
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
): Promise<void> {
  try {
    const title = 'Find Implementations';
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Preparing call graph',
        cancellable: false,
      },
      async () => {
        await callGraph.ensureBuilt();
      },
    );
    const query = explicitQuery ?? await getCallGraphQuery(callGraph, title);
    if (!query) { return; }
    const implementations = callGraph.findImplementations(query);
    if (implementations.length === 0) {
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
): Promise<void> {
  try {
    const title = 'Find Usages';
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'Preparing call graph',
        cancellable: false,
      },
      async () => {
        await callGraph.ensureBuilt();
      },
    );
    const query = explicitQuery ?? await getCallGraphQuery(callGraph, title);
    if (!query) { return; }
    const targetSymbol = callGraph.resolveSymbols(query, 1)[0];
    const usages = callGraph.findUsages(query);
    let sourceLabel = 'call graph cache';
    let matches = await buildCallGraphUsageFileMatches(usages);
    const graphMatchCount = countFileMatchMatches(matches);
    callGraphLog.appendLine(`find usages source: callgraph-cache query=${JSON.stringify(targetSymbol?.qualifiedName ?? query)} matches=${graphMatchCount}`);
    if (targetSymbol && shouldSearchUsageTextFallback(targetSymbol, graphMatchCount)) {
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
      vscode.window.showInformationMessage('No usages found for the selected call graph symbol.');
      return;
    }
    const targetLabel = targetSymbol?.qualifiedName ?? 'selected symbol';
    await overlay.showStaticResults(`${title} [${sourceLabel}]: ${targetLabel}`, matches);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Call graph usages failed: ${msg}`);
  }
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
  return [
    progress.message,
    progress.total > 0 ? `${progress.current}/${progress.total}` : '',
    `parsed=${progress.parsedFiles}`,
    `skipped=${progress.skippedFiles}`,
    `workers=${progress.concurrency}`,
    `${progress.elapsedMs}ms`,
  ].filter(Boolean).join(' ');
}

class CallGraphInlayHintsProvider implements vscode.InlayHintsProvider {
  readonly onDidChangeInlayHints: vscode.Event<void>;

  constructor(private readonly callGraph: CallGraphService) {
    this.onDidChangeInlayHints = callGraph.onDidChangeSnapshot;
  }

  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlayHint[]> {
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    if (!cfg.get<boolean>('callGraphInlayHints', true) || token.isCancellationRequested) { return []; }
    const hasSnapshot = !!this.callGraph.getSnapshot();
    if (!hasSnapshot) {
      const restored = await this.callGraph.ensureDocumentSummariesRestored(document.uri);
      if (token.isCancellationRequested) { return []; }
      if (!restored) { return []; }
    }
    const showCalleeInlayHints = cfg.get<boolean>('callGraphShowCalleeInlayHints', false);
    const summaries = this.callGraph.getSnapshot()
      ? this.callGraph.getSymbolRelationSummariesForDocument(document.uri, range)
      : this.callGraph.getCachedSymbolRelationSummariesForDocument(document.uri, range);
    return summaries
      .filter((summary) => summary.symbol.range.startLine >= 0 && summary.symbol.range.startLine < document.lineCount)
      .filter((summary) => isCallGraphInlayDefinitionLine(document, summary.symbol))
      .map((summary) => buildCallGraphInlayHint(
        summary,
        showCalleeInlayHints,
        document.lineAt(summary.symbol.range.startLine).range.end.character,
      ))
      .filter((hint): hint is vscode.InlayHint => !!hint);
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
    ));
  }
  if (summary.implementationCount > 0) {
    appendInlaySeparator(parts);
    parts.push(makeInlayCommandPart(
      `impl ${summary.implementationCount}`,
      `Show ${summary.implementationCount} implementation${summary.implementationCount === 1 ? '' : 's'}`,
      'intellijStyledSearch.showImplementationsForSymbol',
      summary.symbol.id,
    ));
  }
  if (summary.usageCount > 0) {
    appendInlaySeparator(parts);
    parts.push(makeInlayCommandPart(
      `usages ${summary.usageCount}`,
      `Show ${summary.usageCount} usage${summary.usageCount === 1 ? '' : 's'}`,
      'intellijStyledSearch.showUsagesForSymbol',
      summary.symbol.id,
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

function makeInlayCommandPart(
  label: string,
  title: string,
  command: string,
  symbolId: string,
): vscode.InlayHintLabelPart {
  const part = new vscode.InlayHintLabelPart(label);
  part.command = {
    title,
    command,
    arguments: [symbolId],
  };
  return part;
}

function appendInlaySeparator(parts: vscode.InlayHintLabelPart[]): void {
  if (parts.length === 0) { return; }
  parts.push(new vscode.InlayHintLabelPart(' | '));
}
