import * as assert from 'assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  buildCallGraphEdgeFileMatches,
  buildCallGraphImplementationFileMatches,
  buildCallGraphQuickPickItems,
  buildCallGraphUsageFileMatches,
  estimateCallGraphOverallProgressPercent,
  formatCallGraphProgressMessage,
  type ExtensionTestApi,
} from '../../extension';
import { workspaceHasOwnGit } from '../util/fixtureWorkspace';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

function waitForCallGraphSnapshot(callGraph: ExtensionTestApi['callGraph'], timeoutMs = 6_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const disposable = callGraph.onDidChangeSnapshot(() => {
      clearTimeout(timer);
      disposable.dispose();
      resolve();
    });
    timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error('timed out waiting for call graph snapshot update'));
    }, timeoutMs);
  });
}

function usageLocationKey(reference: { uri: string; range: { startLine: number; startColumn: number } }): string {
  return `${reference.uri}:${reference.range.startLine}:${reference.range.startColumn}`;
}

function inlayLabelParts(hints: vscode.InlayHint[] | undefined): Array<{ hint: vscode.InlayHint; part: vscode.InlayHintLabelPart }> {
  return (hints ?? []).flatMap((hint) =>
    Array.isArray(hint.label)
      ? hint.label.map((part) => ({ hint, part: part as vscode.InlayHintLabelPart }))
      : []);
}

function usageInlayPartForSymbol(
  hints: vscode.InlayHint[] | undefined,
  symbolLabel: string,
): { hint: vscode.InlayHint; part: vscode.InlayHintLabelPart } | undefined {
  return inlayLabelParts(hints).find((entry) =>
    entry.part.command?.command === 'intellijStyledSearch.showUsagesForSymbol' &&
    entry.part.command.arguments?.[1] === symbolLabel);
}

function usageInlayCount(entry: { part: vscode.InlayHintLabelPart } | undefined): number {
  return Number((entry?.part.value.match(/\busages\s+(\d+)\b/) ?? [])[1] ?? 0);
}

async function useCallGraphBackend(backend: 'rust-native' | 'javascript'): Promise<() => Promise<void>> {
  const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
  const prior = cfg.inspect<string>('callGraphBackend');
  await cfg.update('callGraphBackend', backend, vscode.ConfigurationTarget.Workspace);
  return async () => {
    await cfg.update('callGraphBackend', prior?.workspaceValue, vscode.ConfigurationTarget.Workspace);
  };
}

suite('Call graph', () => {
  suiteSetup(async function () {
    // Tests in this suite write fixture files at workspace root and then
    // walk the entire workspace through the call-graph indexer. On large
    // checkouts that walk fundamentally exceeds the per-test 30s budget,
    // so skip cleanly off the dedicated fixture workspace.
    if (await workspaceHasOwnGit()) { this.skip(); return; }
  });

  test('indexes Python and JavaScript symbols with caller/callee edges', async function () {
    this.timeout(30_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const py = vscode.Uri.joinPath(folder.uri, 'callgraph_fixture.py');
    const savePy = vscode.Uri.joinPath(folder.uri, 'callgraph_save_fixture.py');
    const js = vscode.Uri.joinPath(folder.uri, 'callgraph_fixture.js');
    const binaryJs = vscode.Uri.joinPath(folder.uri, 'callgraph_binary_noise.js');
    const java = vscode.Uri.joinPath(folder.uri, 'CallGraphFixture.java');
    const kt = vscode.Uri.joinPath(folder.uri, 'CallGraphFixture.kt');
    try {
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphIncludeUnresolvedEdges',
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      await vscode.workspace.fs.writeFile(py, Buffer.from([
        'GRAPH_LIMIT = 7',
        '',
        'class GraphPy(GraphPyBase):',
        '    def leaf(self):',
        '        return 1',
        '',
        '    def root(self):',
        '        helper = GraphPy()',
        '        return helper.leaf()',
        '',
        '    def _hidden(self):',
        '        return 2',
        '',
        '    def private_root(self):',
        '        return self._hidden()',
        '',
        '    @property',
        '    def label(self):',
        '        return self.leaf()',
        '',
        '    def __init__(self):',
        '        self.worker = GraphPyBase()',
        '',
        '    def super_root(self):',
        '        return super().base_leaf()',
        '',
        '    def inherited_root(self):',
        '        return self.base_leaf()',
        '',
        '    def field_root(self):',
        '        return self.worker.base_leaf()',
        '',
        '    def param_root(self, helper: GraphPyBase):',
        '        return helper.base_leaf()',
        '',
        '    def multiline_param_root(',
        '        self,',
        '        helper: GraphPyBase,',
        '    ):',
        '        return helper.base_leaf()',
        '',
        '    def variadic_param_root(self, *helpers: GraphPyBase):',
        '        return helpers[0].base_leaf()',
        '',
        '    def variadic_kw_param_root(self, **helpers: GraphPyBase):',
        '        return helpers["default"].base_leaf()',
        '',
        'class GraphPyBase:',
        '    def base_leaf(self):',
        '        return 3',
        '',
        'def graph_py_top():',
        '    return GraphPy()',
        '',
        'def graph_py_property_reader():',
        '    helper = GraphPy()',
        '    return helper.label',
        '',
        'def graph_py_limit_reader():',
        '    return GRAPH_LIMIT',
        '',
        'py_lambda_handler = lambda value: value + GRAPH_LIMIT',
        '',
        'def graph_py_lambda_reader():',
        '    return py_lambda_handler',
        '',
        'def graph_py_external_reader(client):',
        '    return client.external_call()',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(js, Buffer.from([
        'class GraphJs extends GraphJsBase {',
        '  leaf() {',
        '    return 1;',
        '  }',
        '',
        '  root() {',
        '    const helper = new GraphJs();',
        '    return helper.leaf();',
        '  }',
        '',
        '  _hidden() {',
        '    return 2;',
        '  }',
        '',
        '  privateRoot() {',
        '    return this._hidden();',
        '  }',
        '',
        '  constructor() {',
        '    this.worker = new GraphJsBase();',
        '  }',
        '',
        '  superRoot() {',
        '    return super.baseLeaf();',
        '  }',
        '',
        '  inheritedRoot() {',
        '    return this.baseLeaf();',
        '  }',
        '',
        '  fieldRoot() {',
        '    return this.worker?.baseLeaf();',
        '  }',
        '}',
        '',
        'class GraphJsBase {',
        '  baseLeaf() {',
        '    return 3;',
        '  }',
        '}',
        '',
        'function makeGraphJs() {',
        '  return new GraphJs();',
        '}',
        '',
        'function jsOptionalTarget() {',
        '  return 4;',
        '}',
        '',
        'function jsOptionalCaller() {',
        '  return jsOptionalTarget?.();',
        '}',
        '',
        'const jsAssignedHandler = () => {',
        '  return jsOptionalTarget();',
        '};',
        '',
        'function jsAssignedUsageReader() {',
        '  return jsAssignedHandler;',
        '}',
        '',
        'function jsAssignedUsageCaller() {',
        '  return jsAssignedHandler();',
        '}',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(binaryJs, Buffer.from([
        0x63, 0x6c, 0x61, 0x73, 0x73, 0x20, 0x42, 0x69, 0x6e, 0x61, 0x72, 0x79,
        0x4e, 0x6f, 0x69, 0x73, 0x65, 0x20, 0x7b, 0x7d, 0x00, 0x00,
      ]));
      await vscode.workspace.fs.writeFile(java, Buffer.from([
        'class GraphJava extends GraphJavaBase {',
        '  private GraphJavaBase worker;',
        '',
        '  int leaf() {',
        '    return 1;',
        '  }',
        '',
        '  int root() {',
        '    GraphJava helper = new GraphJava();',
        '    return helper.leaf();',
        '  }',
        '',
        '  private int privateLeaf() {',
        '    return 2;',
        '  }',
        '',
        '  int implicitRoot() {',
        '    return privateLeaf();',
        '  }',
        '',
        '  int explicitRoot() {',
        '    return this.privateLeaf();',
        '  }',
        '',
        '  int superRoot() {',
        '    return super.baseLeaf();',
        '  }',
        '',
        '  int inheritedRoot() {',
        '    return this.baseLeaf();',
        '  }',
        '',
        '  int fieldRoot() {',
        '    return worker.baseLeaf() + this.worker.baseLeaf();',
        '  }',
        '',
        '  int paramRoot(GraphJavaBase helper) {',
        '    return helper.baseLeaf();',
        '  }',
        '',
        '  int multilineParamRoot(',
        '    GraphJavaBase helper',
        '  ) {',
        '    return helper.baseLeaf();',
        '  }',
        '',
        '  int varargsRoot(GraphJavaBase... helpers) {',
        '    return helpers[0].baseLeaf();',
        '  }',
        '}',
        '',
        'class GraphJavaBase {',
        '  int baseLeaf() {',
        '    return 3;',
        '  }',
        '}',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(kt, Buffer.from([
        'class GraphKt : GraphKtBase() {',
        '  private val worker: GraphKtBase = GraphKtBase()',
        '',
        '  fun leaf(): Int {',
        '    return 1',
        '  }',
        '',
        '  fun root(): Int {',
        '    val helper = GraphKt()',
        '    return helper.leaf()',
        '  }',
        '',
        '  private fun privateLeaf(): Int {',
        '    return 2',
        '  }',
        '',
        '  fun implicitRoot(): Int {',
        '    return privateLeaf()',
        '  }',
        '',
        '  fun explicitRoot(): Int {',
        '    return this.privateLeaf()',
        '  }',
        '',
        '  fun superRoot(): Int {',
        '    return super.baseLeaf()',
        '  }',
        '',
        '  fun inheritedRoot(): Int {',
        '    return this.baseLeaf()',
        '  }',
        '',
        '  fun fieldRoot(): Int {',
        '    return worker.baseLeaf() + this.worker!!.baseLeaf()',
        '  }',
        '',
        '  fun paramRoot(helper: GraphKtBase): Int {',
        '    return helper.baseLeaf()',
        '  }',
        '',
        '  fun multilineParamRoot(',
        '    helper: GraphKtBase',
        '  ): Int {',
        '    return helper.baseLeaf()',
        '  }',
        '',
        '  fun varargRoot(vararg helpers: GraphKtBase): Int {',
        '    return helpers[0].baseLeaf()',
        '  }',
        '}',
        '',
        'open class GraphKtBase {',
        '  fun baseLeaf(): Int {',
        '    return 3',
        '  }',
        '}',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(savePy, Buffer.from('', 'utf8'));

      const progressEvents: Array<{ stage: string; current: number; total: number; concurrency: number }> = [];
      const snapshot = await api.callGraph.rebuild((progress) => {
        progressEvents.push({
          stage: progress.stage,
          current: progress.current,
          total: progress.total,
          concurrency: progress.concurrency,
        });
      });
      assert.ok(progressEvents.some((event) => event.stage === 'done'), 'expected done progress event');
      assert.ok(progressEvents.some((event) => event.concurrency >= 1), 'expected progress to include worker count');
      assert.ok(snapshot.stats.parseConcurrency >= 1, 'expected snapshot stats to include parse concurrency');
      const forcedStages: string[] = [];
      await api.callGraph.rebuild((progress) => {
        forcedStages.push(progress.stage);
      }, undefined, { force: true });
      assert.ok(
        forcedStages.includes('parsing'),
        `expected forced rebuild to skip cached snapshot reuse and parse files, got ${forcedStages.join(', ')}`,
      );
      const progressMessage = formatCallGraphProgressMessage({
        stage: 'parsing',
        message: 'parsing files',
        current: 3,
        total: 10,
        parsedFiles: 2,
        skippedFiles: 1,
        warningCount: 0,
        elapsedMs: 123,
        concurrency: 8,
        maxConcurrency: 12,
        heapUsedMb: 256,
        heapLimitMb: 1024,
        heapUsageRatio: 0.25,
        workerThrottleCount: 2,
      });
      assert.ok(progressMessage.includes('3/10'), 'expected progress message to include count');
      assert.ok(progressMessage.includes('overall=17%'), 'expected progress message to include weighted overall percent');
      assert.ok(progressMessage.includes('workers=8/12'), 'expected progress message to include worker count');
      assert.ok(progressMessage.includes('heap=256/1024MB(25%)'), 'expected progress message to include heap usage');
      assert.strictEqual(
        estimateCallGraphOverallProgressPercent({
          stage: 'parsing',
          message: 'parsing files',
          current: 10,
          total: 10,
          parsedFiles: 10,
          skippedFiles: 0,
          warningCount: 0,
          elapsedMs: 100,
          concurrency: 8,
        }),
        45,
      );
      assert.strictEqual(
        estimateCallGraphOverallProgressPercent({
          stage: 'resolving',
          message: 'resolving references',
          current: 0,
          total: 10,
          parsedFiles: 10,
          skippedFiles: 0,
          warningCount: 0,
          elapsedMs: 100,
          concurrency: 8,
        }),
        45,
      );
      assert.strictEqual(
        estimateCallGraphOverallProgressPercent({
          stage: 'indexing',
          message: 'writing graph index',
          current: 0,
          total: 10,
          parsedFiles: 10,
          skippedFiles: 0,
          warningCount: 0,
          elapsedMs: 100,
          concurrency: 8,
        }),
        80,
      );
      assert.ok(progressMessage.includes('throttles=2'), 'expected progress message to include throttle count');
      const names = snapshot.symbols.map((symbol) => symbol.qualifiedName);
      assert.ok(names.includes('GraphPy.root'), 'expected Python method symbol');
      assert.ok(!names.includes('BinaryNoise'), 'expected binary-looking source file to be skipped');
      assert.ok(names.includes('GraphPy.leaf'), 'expected Python leaf symbol');
      assert.ok(names.includes('GRAPH_LIMIT'), 'expected Python constant symbol');
      assert.ok(names.includes('GraphJs.root'), 'expected JavaScript method symbol');
      assert.ok(names.includes('GraphJs.leaf'), 'expected JavaScript leaf symbol');
      assert.ok(names.includes('GraphJava.root'), 'expected Java method symbol');
      assert.ok(names.includes('GraphJava.leaf'), 'expected Java leaf symbol');
      assert.ok(names.includes('GraphJava.varargsRoot'), 'expected Java varargs method symbol');
      assert.ok(names.includes('GraphKt.root'), 'expected Kotlin method symbol');
      assert.ok(names.includes('GraphKt.leaf'), 'expected Kotlin leaf symbol');

      const pyCallers = api.callGraph.getCallers('GraphPy.leaf');
      assert.ok(
        pyCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.root') && edge.confidence === 'exact')),
        'expected helper.leaf() to resolve to GraphPy.leaf exactly',
      );
      const pyCallerPanelMatches = await buildCallGraphEdgeFileMatches(pyCallers, 'callers');
      assert.ok(
        pyCallerPanelMatches.some((match) => match.matches.some((item) => item.preview.includes('helper.leaf()') && item.ranges[0]?.start >= 0)),
        'expected caller panel matches to include source preview and highlight range',
      );
      const duplicatedPyCallerPanelMatches = await buildCallGraphEdgeFileMatches([...pyCallers, ...pyCallers], 'callers');
      assert.strictEqual(
        duplicatedPyCallerPanelMatches.reduce((sum, match) => sum + match.matches.length, 0),
        pyCallerPanelMatches.reduce((sum, match) => sum + match.matches.length, 0),
        'expected caller panel matches to dedupe duplicate edge locations',
      );
      const pyPrivateCallers = api.callGraph.getCallers('GraphPy._hidden');
      assert.ok(
        pyPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.private_root') && edge.confidence === 'exact')),
        'expected self._hidden() to resolve to GraphPy._hidden exactly',
      );
      const pyPropertyCallers = api.callGraph.getCallers('GraphPy.label');
      assert.ok(
        pyPropertyCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('graph_py_property_reader') && edge.confidence === 'exact')),
        'expected helper.label property access to resolve to GraphPy.label exactly',
      );
      const pyBaseCallers = api.callGraph.getCallers('GraphPyBase.base_leaf');
      assert.ok(
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.super_root') && edge.confidence === 'exact')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.inherited_root') && edge.confidence !== 'possible')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.field_root') && edge.confidence === 'exact')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.param_root') && edge.confidence === 'exact')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.multiline_param_root') && edge.confidence === 'exact')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.variadic_param_root') && edge.confidence === 'exact')) &&
        pyBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphPy.variadic_kw_param_root') && edge.confidence === 'exact')),
        `expected Python super, inherited, field, typed parameter, multiline parameter, and variadic parameter receivers to resolve to GraphPyBase.base_leaf, got ${pyBaseCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );
      const pyConstantUsages = api.callGraph.findUsages('GRAPH_LIMIT');
      assert.ok(
        pyConstantUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_limit_reader')),
        'expected GRAPH_LIMIT reference to be indexed as a usage',
      );
      const pyUsagePanelMatches = await buildCallGraphUsageFileMatches(pyConstantUsages);
      assert.ok(
        pyUsagePanelMatches.some((match) => match.matches.some((item) => item.preview.includes('GRAPH_LIMIT') && item.ranges[0]?.end > item.ranges[0]?.start)),
        'expected usage panel matches to include source preview and highlight range',
      );
      const pyClassUsages = api.callGraph.findUsages('GraphPy');
      assert.ok(
        pyClassUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_top')) &&
        pyClassUsages.some((reference) => reference.enclosingSymbolId?.includes('GraphPy.root')),
        `expected GraphPy constructor references to be indexed as class usages, got ${pyClassUsages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      assert.strictEqual(
        new Set(pyClassUsages.map(usageLocationKey)).size,
        pyClassUsages.length,
        'expected class usages to dedupe reference and callsite hits at the same source location',
      );
      const pyClassUsagePanelMatches = await buildCallGraphUsageFileMatches([...pyClassUsages, ...pyClassUsages]);
      assert.strictEqual(
        pyClassUsagePanelMatches.reduce((sum, match) => sum + match.matches.length, 0),
        pyClassUsages.length,
        'expected usage panel matches to dedupe duplicate usage locations',
      );
      const pyLambdaUsages = api.callGraph.findUsages('py_lambda_handler');
      assert.ok(
        pyLambdaUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_lambda_reader')),
        `expected Python lambda assignment references to be indexed as usages, got ${pyLambdaUsages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      const pyExternalCallees = api.callGraph.getCallees('graph_py_external_reader');
      assert.ok(
        pyExternalCallees.some((result) => result.edges.some((edge) =>
          edge.calleeName === 'client.external_call' &&
          edge.confidence === 'unresolved' &&
          edge.callKind === 'dynamic')),
        `expected unresolved external receiver calls to stay in the graph, got ${pyExternalCallees.flatMap((result) => result.edges.map((edge) => `${edge.calleeName}:${edge.confidence}/${edge.callKind}`)).join(', ')}`,
      );
      const jsAssignedUsages = api.callGraph.findUsages('jsAssignedHandler');
      assert.ok(
        jsAssignedUsages.some((reference) => reference.enclosingSymbolId?.includes('jsAssignedUsageReader')) &&
        jsAssignedUsages.some((reference) => reference.enclosingSymbolId?.includes('jsAssignedUsageCaller')),
        `expected JavaScript anonymous function assignment references to be indexed as usages, got ${jsAssignedUsages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      const jsAssignedSummary = api.callGraph.getSymbolRelationSummariesForDocument(js)
        .find((summary) => summary.symbol.qualifiedName === 'jsAssignedHandler');
      assert.ok(
        jsAssignedSummary && jsAssignedSummary.usageCount >= 2,
        'expected anonymous function assignment inlay summary to include usages',
      );
      const originalPy = Buffer.from(await vscode.workspace.fs.readFile(py)).toString('utf8');
      await vscode.workspace.fs.writeFile(py, Buffer.from(`${originalPy}\ndef graph_py_top2():\n    return GraphPy()\n`, 'utf8'));
      await api.callGraph.refreshChangedFilesForTests([py]);
      const refreshedClassUsages = api.callGraph.findUsages('GraphPy');
      assert.ok(
        refreshedClassUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_top2')),
        'expected incremental call graph refresh to pick up newly added GraphPy usage',
      );
      const refreshedClassSummary = api.callGraph.getSymbolRelationSummariesForDocument(py)
        .find((summary) => summary.symbol.qualifiedName === 'GraphPy');
      assert.ok(refreshedClassSummary, 'expected refreshed class summary before metadata-only cache reload');
      await api.callGraph.reloadPersistedMetadataForTests();
      assert.strictEqual(api.callGraph.getSnapshot(), undefined, 'expected metadata-only cache load to avoid restoring the full snapshot');
      assert.ok(await api.callGraph.ensureDocumentSummariesRestored(py), 'expected document summary bucket to restore from cache');
      const cachedClassSummary = api.callGraph.getCachedSymbolRelationSummariesForDocument(py)
        .find((summary) => summary.symbol.qualifiedName === 'GraphPy');
      assert.ok(
        cachedClassSummary && cachedClassSummary.usageCount === refreshedClassSummary.usageCount,
        `expected cached document summary to expose usage counts without full snapshot restore; full=${refreshedClassSummary.usageCount} cached=${cachedClassSummary?.usageCount ?? 'missing'}`,
      );
      const cachedClassUsages = await api.callGraph.findUsagesForSymbolIdFromCache(refreshedClassSummary.symbol.id);
      assert.ok(
        cachedClassUsages?.some((reference) => reference.enclosingSymbolId?.includes('graph_py_top2')),
        'expected cached symbol relation index to serve usages without full snapshot restore',
      );
      assert.strictEqual(api.callGraph.getSnapshot(), undefined, 'expected cached usage query to avoid restoring the full snapshot');
      api.callGraph.dropDocumentSummariesForTests();
      assert.strictEqual(
        await api.callGraph.ensureDocumentSummariesRestored(py),
        false,
        'expected missing legacy document summaries to queue a background migration without blocking inlay',
      );
      assert.ok(
        await api.callGraph.waitForDocumentSummaryMigrationForTests(),
        'expected legacy cache document summary migration to complete',
      );
      assert.strictEqual(api.callGraph.getSnapshot(), undefined, 'expected legacy document summary migration to avoid full snapshot activation');
      assert.ok(await api.callGraph.ensureDocumentSummariesRestored(py), 'expected migrated document summary bucket to restore from cache');
      const migratedClassSummary = api.callGraph.getCachedSymbolRelationSummariesForDocument(py)
        .find((summary) => summary.symbol.qualifiedName === 'GraphPy');
      assert.ok(
        migratedClassSummary && migratedClassSummary.usageCount === refreshedClassSummary.usageCount,
        `expected migrated document summary to expose usage counts; full=${refreshedClassSummary.usageCount} migrated=${migratedClassSummary?.usageCount ?? 'missing'}`,
      );
      await api.callGraph.reloadPersistedSnapshotForTests();
      const restoredSnapshot = api.callGraph.getSnapshot();
      assert.ok(restoredSnapshot, 'expected persisted call graph snapshot to restore after clearing memory');
      const restoredClassUsages = api.callGraph.findUsages('GraphPy');
      assert.ok(
        restoredClassUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_top2')),
        'expected restored persisted call graph snapshot to retain incrementally added usage',
      );
      const savedDoc = await vscode.workspace.openTextDocument(savePy);
      const savedUpdate = waitForCallGraphSnapshot(api.callGraph);
      const savedEdit = new vscode.WorkspaceEdit();
      const lastLine = savedDoc.lineAt(savedDoc.lineCount - 1);
      savedEdit.insert(
        savePy,
        new vscode.Position(savedDoc.lineCount - 1, lastLine.range.end.character),
        'def graph_py_top3():\n    return GraphPy()\n',
      );
      assert.ok(await vscode.workspace.applyEdit(savedEdit), 'expected saved document edit to apply');
      assert.ok(await savedDoc.save(), 'expected saved document to persist');
      await savedUpdate;
      const savedClassUsages = api.callGraph.findUsages('GraphPy');
      assert.ok(
        savedClassUsages.some((reference) => reference.enclosingSymbolId?.includes('graph_py_top3')),
        'expected document save to refresh call graph usages',
      );
      const callerItems = buildCallGraphQuickPickItems(pyCallers, 'callers');
      assert.ok(
        callerItems.some((item) => item.label.includes('GraphPy.root') && item.detail?.includes('callgraph_fixture.py:9')),
        'expected caller quick pick item to surface the caller and callsite',
      );

      const jsCallees = api.callGraph.getCallees('makeGraphJs');
      assert.ok(
        jsCallees.some((result) => result.edges.some((edge) => edge.calleeName.includes('GraphJs') && edge.callKind === 'constructor')),
        'expected new GraphJs() constructor edge',
      );
      const calleeItems = buildCallGraphQuickPickItems(jsCallees, 'callees');
      assert.ok(
        calleeItems.some((item) => item.label.includes('GraphJs') && item.detail?.includes('makeGraphJs')),
        'expected callee quick pick item to surface the callee and caller context',
      );

      const jsCallers = api.callGraph.getCallers('GraphJs.leaf');
      assert.ok(
        jsCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJs.root') && edge.confidence === 'exact')),
        'expected const helper = new GraphJs(); helper.leaf() to resolve exactly',
      );
      const jsPrivateCallers = api.callGraph.getCallers('GraphJs._hidden');
      assert.ok(
        jsPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJs.privateRoot') && edge.confidence === 'exact')),
        'expected this._hidden() to resolve exactly',
      );
      const jsOptionalCallers = api.callGraph.getCallers('jsOptionalTarget');
      assert.ok(
        jsOptionalCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('jsOptionalCaller') && edge.confidence === 'exact')),
        'expected optional direct call jsOptionalTarget?.() to resolve exactly',
      );
      const jsBaseCallers = api.callGraph.getCallers('GraphJsBase.baseLeaf');
      assert.ok(
        jsBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJs.superRoot') && edge.confidence === 'exact')) &&
        jsBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJs.inheritedRoot') && edge.confidence !== 'possible')) &&
        jsBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJs.fieldRoot') && edge.confidence === 'exact')),
        `expected JavaScript super, inherited, and this.field receivers to resolve to GraphJsBase.baseLeaf, got ${jsBaseCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );

      const javaCallers = api.callGraph.getCallers('GraphJava.leaf');
      assert.ok(
        javaCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.root') && edge.confidence === 'exact')),
        'expected Java local variable receiver to resolve exactly',
      );
      const javaPrivateCallers = api.callGraph.getCallers('GraphJava.privateLeaf');
      assert.ok(
        javaPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.implicitRoot') && edge.confidence === 'exact')) &&
        javaPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.explicitRoot') && edge.confidence === 'exact')),
        'expected Java implicit and this.privateLeaf() instance calls to resolve exactly',
      );
      const javaBaseCallers = api.callGraph.getCallers('GraphJavaBase.baseLeaf');
      assert.ok(
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.superRoot') && edge.confidence === 'exact')) &&
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.inheritedRoot') && edge.confidence !== 'possible')) &&
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.fieldRoot') && edge.confidence === 'exact')) &&
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.paramRoot') && edge.confidence === 'exact')) &&
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.multilineParamRoot') && edge.confidence === 'exact')) &&
        javaBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphJava.varargsRoot') && edge.confidence === 'exact')),
        `expected Java super, inherited, field, typed parameter, multiline parameter, and varargs receivers to resolve to GraphJavaBase.baseLeaf, got ${javaBaseCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );

      const ktCallers = api.callGraph.getCallers('GraphKt.leaf');
      assert.ok(
        ktCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.root') && edge.confidence === 'exact')),
        'expected Kotlin local variable receiver to resolve exactly',
      );
      const ktPrivateCallers = api.callGraph.getCallers('GraphKt.privateLeaf');
      assert.ok(
        ktPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.implicitRoot') && edge.confidence === 'exact')) &&
        ktPrivateCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.explicitRoot') && edge.confidence === 'exact')),
        'expected Kotlin implicit and this.privateLeaf() instance calls to resolve exactly',
      );
      const ktBaseCallers = api.callGraph.getCallers('GraphKtBase.baseLeaf');
      assert.ok(
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.superRoot') && edge.confidence === 'exact')) &&
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.inheritedRoot') && edge.confidence !== 'possible')) &&
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.fieldRoot') && edge.confidence === 'exact')) &&
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.paramRoot') && edge.confidence === 'exact')) &&
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.multilineParamRoot') && edge.confidence === 'exact')) &&
        ktBaseCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('GraphKt.varargRoot') && edge.confidence === 'exact')),
        `expected Kotlin super, inherited, field, typed parameter, multiline parameter, and vararg receivers to resolve to GraphKtBase.baseLeaf, got ${ktBaseCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );

      const callsiteTargets = api.callGraph.findTargetsAtPosition(py, new vscode.Position(8, 22));
      assert.ok(
        callsiteTargets.some((symbol) => symbol.qualifiedName === 'GraphPy.leaf'),
        `expected cursor on helper.leaf() to target GraphPy.leaf, got ${callsiteTargets.map((symbol) => symbol.qualifiedName).join(', ')}`,
      );

      const pySummaries = api.callGraph.getSymbolRelationSummariesForDocument(py);
      const leafSummary = pySummaries.find((summary) => summary.symbol.qualifiedName === 'GraphPy.leaf');
      assert.ok(leafSummary && leafSummary.usageCount >= 1, 'expected GraphPy.leaf inlay summary to include callsites as usages');
      const pyLeafUsagePanelMatches = await buildCallGraphUsageFileMatches(api.callGraph.findUsages('GraphPy.leaf'));
      assert.strictEqual(
        leafSummary.usageCount,
        pyLeafUsagePanelMatches.reduce((sum, match) => sum + match.matches.length, 0),
        'expected usage inlay count to match the number of usage panel results',
      );
      assert.ok(
        pyLeafUsagePanelMatches.reduce((sum, match) => sum + match.matches.length, 0) >=
          pyCallerPanelMatches.reduce((sum, match) => sum + match.matches.length, 0),
        'expected usage panel results to include caller callsites',
      );
      const rootSummary = pySummaries.find((summary) => summary.symbol.qualifiedName === 'GraphPy.root');
      assert.ok(rootSummary && rootSummary.calleeCount >= 1, 'expected GraphPy.root inlay summary to include callees');
      const multilineSummary = pySummaries.find((summary) => summary.symbol.qualifiedName === 'GraphPy.multiline_param_root');
      assert.ok(multilineSummary && multilineSummary.calleeCount >= 1, 'expected multiline Python method inlay summary to include callees');
      const constantSummary = pySummaries.find((summary) => summary.symbol.qualifiedName === 'GRAPH_LIMIT');
      assert.ok(constantSummary && constantSummary.usageCount >= 1, 'expected GRAPH_LIMIT inlay summary to include usages');
      const classSummary = pySummaries.find((summary) => summary.symbol.qualifiedName === 'GraphPy');
      assert.ok(classSummary && classSummary.usageCount >= 2, 'expected GraphPy inlay summary to include class usages');
      const inlayHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        py,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(80, 0)),
      );
      const commandParts = inlayHints
        .flatMap((hint) => Array.isArray(hint.label)
          ? hint.label.map((part) => ({ hint, part }))
          : [])
        .filter((entry) => entry.part.command?.command?.startsWith('intellijStyledSearch.show'));
      assert.ok(
        !commandParts.some((entry) => entry.part.command?.command === 'intellijStyledSearch.showCallersForSymbol'),
        'expected callers to be folded into usages instead of exposed as a separate inlay part',
      );
      assert.ok(
        !commandParts.some((entry) => entry.part.command?.command === 'intellijStyledSearch.showCalleesForSymbol'),
        'expected callee inlay parts to be hidden by default',
      );
      assert.ok(
        commandParts.some((entry) => entry.part.command?.command === 'intellijStyledSearch.showUsagesForSymbol'),
        'expected usages inlay part to expose a direct command',
      );
      assert.ok(
        commandParts.every((entry) => !/[\u200b\u200c\u2063]/.test(entry.part.value)),
        'expected call graph inlay labels to avoid hidden click marker characters',
      );
      assert.ok(
        commandParts.every((entry) => !entry.part.value.includes('ijcg:')),
        'expected call graph inlay click metadata to stay hidden',
      );
      assert.ok(
        commandParts.every((entry) => !entry.part.tooltip && !entry.hint.tooltip),
        'expected call graph inlay commands to avoid hover-only tooltip actions',
      );
      assert.ok(
        commandParts.every((entry) => entry.part.command?.title === ''),
        'expected call graph inlay hover to keep underline affordance without command-title tooltip text',
      );
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphShowCalleeInlayHints',
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      const calleeInlayHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        py,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(80, 0)),
      );
      const calleeCommandParts = calleeInlayHints
        .flatMap((hint) => Array.isArray(hint.label) ? hint.label.map((part) => ({ hint, part })) : [])
        .filter((entry) => entry.part.command?.command?.startsWith('intellijStyledSearch.show'));
      assert.ok(
        calleeCommandParts.some((entry) => entry.part.command?.command === 'intellijStyledSearch.showCalleesForSymbol'),
        'expected callee inlay parts to be available when explicitly enabled',
      );
      assert.ok(
        multilineSummary &&
          calleeInlayHints.some((hint) =>
            hint.position.line === multilineSummary.symbol.range.startLine &&
            Array.isArray(hint.label) &&
            hint.label.some((part) => part.command?.command === 'intellijStyledSearch.showCalleesForSymbol')),
        'expected multiline Python method declarations to render callee inlay hints on the declaration line',
      );
    } finally {
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphShowCalleeInlayHints',
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphIncludeUnresolvedEdges',
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      try { await vscode.workspace.fs.delete(py); } catch {}
      try { await vscode.workspace.fs.delete(savePy); } catch {}
      try { await vscode.workspace.fs.delete(js); } catch {}
      try { await vscode.workspace.fs.delete(binaryJs); } catch {}
      try { await vscode.workspace.fs.delete(java); } catch {}
      try { await vscode.workspace.fs.delete(kt); } catch {}
      await restoreBackend();
      await api.callGraph.rebuild();
    }
  });

  test('incremental create refreshes usage index and usage inlays', async function () {
    this.timeout(30_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const cfg = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorCallGraphInlayHints = cfg.inspect<boolean>('callGraphInlayHints');
    const suffix = `${process.pid}_${Date.now()}`;
    const targetRel = `callgraph_incremental_new_usage_target_${suffix}.py`;
    const consumerRel = `callgraph_incremental_new_usage_consumer_${suffix}.py`;
    const target = vscode.Uri.joinPath(folder.uri, targetRel);
    const consumer = vscode.Uri.joinPath(folder.uri, consumerRel);
    const moduleName = path.basename(targetRel, '.py');
    const className = `IncrementalNewUsageTarget_${suffix}`;
    const methodName = `target_method_${suffix}`;
    try {
      await cfg.update('callGraphInlayHints', true, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(target, Buffer.from([
        `class ${className}:`,
        `    def ${methodName}(self):`,
        '        return 1',
        '',
      ].join('\n'), 'utf8'));

      await api.callGraph.rebuild(undefined, undefined, { force: true });
      const document = await vscode.workspace.openTextDocument(target);
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(document.lineCount, 0),
      );

      const initialHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        target,
        fullRange,
      );
      const initialUsageCount = usageInlayCount(usageInlayPartForSymbol(initialHints, className));

      await vscode.workspace.fs.writeFile(consumer, Buffer.from([
        `from ${moduleName} import ${className}`,
        '',
        `def incremental_new_usage_site_${suffix}():`,
        `    helper = ${className}()`,
        `    return helper.${methodName}()`,
        '',
      ].join('\n'), 'utf8'));
      await api.callGraph.refreshChangedFilesForTests([consumer]);

      const usages = await api.callGraph.findUsagesResolved(className, 20);
      assert.ok(
        usages.some((reference) => reference.relPath === consumerRel),
        `expected incremental index to include the newly created usage file; got ${usages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );

      const refreshedHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        target,
        fullRange,
      );
      const classUsagePart = usageInlayPartForSymbol(refreshedHints, className);
      assert.ok(
        classUsagePart,
        `expected usage inlay for ${className} after incremental create; hints=${inlayLabelParts(refreshedHints).map((entry) => `${entry.part.value}:${entry.part.command?.arguments?.[1] ?? ''}`).join(', ')}`,
      );
      const usageCount = usageInlayCount(classUsagePart);
      assert.ok(
        usageCount > initialUsageCount,
        `expected usage inlay count to increment after new file create, before=${initialUsageCount} after=${usageCount} label=${classUsagePart!.part.value}`,
      );
    } finally {
      await cfg.update('callGraphInlayHints', priorCallGraphInlayHints?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      try { await vscode.workspace.fs.delete(consumer); } catch {}
      try { await vscode.workspace.fs.delete(target); } catch {}
      try { await api.callGraph.refreshChangedFilesForTests([consumer, target]); } catch {}
      await restoreBackend();
    }
  });

  test('counts exported API and import/export references as usages', async function () {
    this.timeout(10_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const provider = vscode.Uri.joinPath(folder.uri, 'callgraph_external_api.ts');
    const consumer = vscode.Uri.joinPath(folder.uri, 'callgraph_external_consumer.ts');
    try {
      await vscode.workspace.fs.writeFile(provider, Buffer.from([
        'export function exportedLower() {',
        '  return exportedValue;',
        '}',
        '',
        'export class ExportedClass {}',
        'export interface ExportedContract {}',
        'export enum ExportedMode {',
        '  Ready = "ready",',
        '}',
        'export const exportedValue = 3;',
        'export { exportedLower as exportedLowerAgain };',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(consumer, Buffer.from([
        'import { exportedLower, ExportedClass, ExportedContract, ExportedMode, exportedValue } from "./callgraph_external_api";',
        '',
        'type LocalContract = ExportedContract;',
        'const localValue = exportedValue;',
        'export { ExportedClass, ExportedMode, exportedLower };',
        '',
      ].join('\n'), 'utf8'));

      await api.callGraph.rebuild();
      const exportedLowerUsages = api.callGraph.findUsages('exportedLower');
      assert.ok(
        exportedLowerUsages.some((reference) => reference.relPath.endsWith('callgraph_external_api.ts')) &&
          exportedLowerUsages.some((reference) => reference.relPath.endsWith('callgraph_external_consumer.ts')),
        `expected exported lowercase function declaration and import/export references to count as usages, got ${exportedLowerUsages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      const exportedValueUsages = api.callGraph.findUsages('exportedValue');
      assert.ok(
        exportedValueUsages.some((reference) => reference.relPath.endsWith('callgraph_external_api.ts')) &&
          exportedValueUsages.some((reference) => reference.relPath.endsWith('callgraph_external_consumer.ts')),
        `expected exported lowercase const and import references to count as usages, got ${exportedValueUsages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      for (const name of ['ExportedClass', 'ExportedContract', 'ExportedMode']) {
        const usages = api.callGraph.findUsages(name);
        assert.ok(
          usages.some((reference) => reference.relPath.endsWith('callgraph_external_api.ts')) &&
            usages.some((reference) => reference.relPath.endsWith('callgraph_external_consumer.ts')),
          `expected ${name} export and external references to count as usages, got ${usages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
        );
      }
    } finally {
      try { await vscode.workspace.fs.delete(provider); } catch {}
      try { await vscode.workspace.fs.delete(consumer); } catch {}
      await restoreBackend();
      await api.callGraph.rebuild();
    }
  });

  test('resolves Python service method usages through constructed receivers', async function () {
    this.timeout(10_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const service = vscode.Uri.joinPath(folder.uri, 'captain_articles_of_incorporation_service.py');
    const mutation = vscode.Uri.joinPath(folder.uri, 'captain_articles_of_incorporation_mutation.py');
    try {
      await vscode.workspace.fs.writeFile(service, Buffer.from([
        'class ArticlesOfIncorporationService:',
        '    def articles_of_incorporation_edit(  # type: ignore[no-untyped-def]',
        '        self,',
        '        *,',
        '        closing_month=None,',
        '    ):',
        '        return closing_month',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(mutation, Buffer.from([
        'from captain_articles_of_incorporation_service import (',
        '    ArticlesOfIncorporationService,',
        ')',
        '',
        'class ArticlesOfIncorporationEdit:',
        '    @classmethod',
        '    def execute(cls, **data):',
        '        articles_of_incorporation_service = ArticlesOfIncorporationService(',
        '            company=None,',
        '        )',
        '        articles_of_incorporation_service.articles_of_incorporation_edit(',
        '            **data',
        '        )',
        '',
      ].join('\n'), 'utf8'));

      await api.callGraph.rebuild();
      const callers = api.callGraph.getCallers('ArticlesOfIncorporationService.articles_of_incorporation_edit');
      assert.ok(
        callers.some((result) => result.edges.some((edge) =>
          edge.callerId.includes('ArticlesOfIncorporationEdit.execute') &&
          edge.confidence === 'exact')),
        `expected constructed Python service receiver to resolve to ArticlesOfIncorporationService.articles_of_incorporation_edit, got ${callers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}:${edge.calleeName}`)).join(', ')}`,
      );
      const usages = api.callGraph.findUsages('ArticlesOfIncorporationService.articles_of_incorporation_edit');
      assert.ok(
        usages.some((reference) => reference.relPath.endsWith('captain_articles_of_incorporation_mutation.py')),
        `expected service method callsite to appear in usages, got ${usages.map((reference) => `${reference.relPath}:${reference.range.startLine + 1}`).join(', ')}`,
      );
      const summaries = api.callGraph.getSymbolRelationSummariesForDocument(service);
      const summary = summaries.find((item) =>
        item.symbol.qualifiedName === 'ArticlesOfIncorporationService.articles_of_incorporation_edit');
      assert.ok(
        summary && summary.usageCount >= 1,
        `expected service method document summary to include usage count, got ${summaries.map((item) => `${item.symbol.qualifiedName}:${item.usageCount}`).join(', ')}`,
      );
      const inlayHints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
        'vscode.executeInlayHintProvider',
        service,
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(20, 0)),
      );
      assert.ok(
        summary &&
          inlayHints.some((hint) =>
            hint.position.line === summary.symbol.range.startLine &&
            Array.isArray(hint.label) &&
            hint.label.some((part) => part.command?.command === 'intellijStyledSearch.showUsagesForSymbol')),
        'expected multiline Python declarations with inline type-ignore comments to render usage inlay hints on the declaration line',
      );
    } finally {
      try { await vscode.workspace.fs.delete(service); } catch {}
      try { await vscode.workspace.fs.delete(mutation); } catch {}
      await restoreBackend();
      await api.callGraph.rebuild();
    }
  });

  test('links interface and abstract implementations', async function () {
    this.timeout(30_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const ts = vscode.Uri.joinPath(folder.uri, 'callgraph_impl_fixture.ts');
    try {
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphIncludeUnresolvedEdges',
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      await vscode.workspace.fs.writeFile(ts, Buffer.from([
        'interface WorkerContract {',
        '  run(payload: WorkerPayload): WorkerMode;',
        '}',
        '',
        'type WorkerPayload = { id: string };',
        '',
        'enum WorkerMode {',
        '  Fast = "fast",',
        '}',
        '',
        'abstract class BaseWorker {',
        '  abstract tick(): number;',
        '}',
        '',
        'class ConcreteWorker extends BaseWorker implements WorkerContract {',
        '  run(payload: WorkerPayload): WorkerMode {',
        '    return WorkerMode.Fast;',
        '  }',
        '',
        '  tick(): number {',
        '    return 2;',
        '  }',
        '}',
        '',
        'function workerMultilineCaller(',
        '  worker: WorkerContract,',
        '): WorkerMode {',
        '  return worker.run({ id: "2" });',
        '}',
        '',
        'function workerRestCaller(',
        '  ...workers: WorkerContract[]',
        '): WorkerMode {',
        '  return workers[0].run({ id: "3" });',
        '}',
        '',
        'function workerDynamicCaller(client: unknown): unknown {',
        '  return client.run({ id: "4" });',
        '}',
        '',
      ].join('\n'), 'utf8'));

      await api.callGraph.rebuild();
      const typeImplementations = api.callGraph.findImplementations('WorkerContract');
      assert.ok(
        typeImplementations.some((symbol) => symbol.qualifiedName === 'ConcreteWorker'),
        `expected ConcreteWorker implementation, got ${typeImplementations.map((symbol) => symbol.qualifiedName).join(', ')}`,
      );
      const runImplementations = api.callGraph.findImplementations('WorkerContract.run');
      assert.ok(
        runImplementations.some((symbol) => symbol.qualifiedName === 'ConcreteWorker.run'),
        `expected ConcreteWorker.run implementation, got ${runImplementations.map((symbol) => symbol.qualifiedName).join(', ')}`,
      );
      const runImplementationPanelMatches = await buildCallGraphImplementationFileMatches(runImplementations);
      assert.ok(
        runImplementationPanelMatches.some((match) => match.matches.some((item) => item.preview.includes('run(payload: WorkerPayload)'))),
        'expected implementation panel matches to include implementation source preview',
      );
      const runCallers = api.callGraph.getCallers('WorkerContract.run');
      assert.ok(
        runCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('workerMultilineCaller') && edge.confidence === 'exact')),
        `expected multiline TypeScript function body to call WorkerContract.run, got ${runCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );
      assert.ok(
        runCallers.some((result) => result.edges.some((edge) => edge.callerId.includes('workerRestCaller') && edge.confidence === 'exact')),
        `expected TypeScript rest parameter element receiver to call WorkerContract.run, got ${runCallers.flatMap((result) => result.edges.map((edge) => `${edge.callerId}:${edge.confidence}`)).join(', ')}`,
      );
      const dynamicCallees = api.callGraph.getCallees('workerDynamicCaller');
      assert.ok(
        dynamicCallees.some((result) => result.edges.some((edge) =>
          edge.calleeName === 'client.run' &&
          edge.confidence === 'unresolved' &&
          edge.callKind === 'dynamic')),
        `expected TypeScript dynamic receiver calls to stay in the graph, got ${dynamicCallees.flatMap((result) => result.edges.map((edge) => `${edge.calleeName}:${edge.confidence}/${edge.callKind}`)).join(', ')}`,
      );
      const tickImplementations = api.callGraph.findImplementations('BaseWorker.tick');
      assert.ok(
        tickImplementations.some((symbol) => symbol.qualifiedName === 'ConcreteWorker.tick'),
        `expected ConcreteWorker.tick implementation, got ${tickImplementations.map((symbol) => symbol.qualifiedName).join(', ')}`,
      );
      const positionImplementations = api.callGraph.findImplementationsAtPosition(ts, new vscode.Position(1, 3));
      assert.ok(
        positionImplementations.some((symbol) => symbol.qualifiedName === 'ConcreteWorker.run'),
        `expected position lookup to link ConcreteWorker.run, got ${positionImplementations.map((symbol) => symbol.qualifiedName).join(', ')}`,
      );
      const summaries = api.callGraph.getSymbolRelationSummariesForDocument(ts);
      const runSummary = summaries.find((summary) => summary.symbol.qualifiedName === 'WorkerContract.run');
      assert.ok(runSummary && runSummary.implementationCount >= 1, 'expected interface method inlay summary to include implementations');
      const multilineSummary = summaries.find((summary) => summary.symbol.qualifiedName === 'workerMultilineCaller');
      assert.ok(multilineSummary && multilineSummary.calleeCount >= 1, 'expected multiline TypeScript function inlay summary to include callees');
      const typeAliasUsages = api.callGraph.findUsages('WorkerPayload');
      assert.ok(typeAliasUsages.length >= 2, `expected WorkerPayload type alias usages, got ${typeAliasUsages.length}`);
      const enumUsages = api.callGraph.findUsages('WorkerMode');
      assert.ok(enumUsages.length >= 2, `expected WorkerMode enum usages, got ${enumUsages.length}`);
      const typeAliasSummary = summaries.find((summary) => summary.symbol.qualifiedName === 'WorkerPayload');
      assert.ok(typeAliasSummary && typeAliasSummary.usageCount >= 2, 'expected type alias inlay summary to include usages');
      const enumSummary = summaries.find((summary) => summary.symbol.qualifiedName === 'WorkerMode');
      assert.ok(enumSummary && enumSummary.usageCount >= 2, 'expected enum inlay summary to include usages');
    } finally {
      await vscode.workspace.getConfiguration('intellijStyledSearch').update(
        'callGraphIncludeUnresolvedEdges',
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      try { await vscode.workspace.fs.delete(ts); } catch {}
      await restoreBackend();
      await api.callGraph.rebuild();
    }
  });

  test('serves codeidx MCP tools, resources, and prompts over the local JSON-RPC endpoint', async function () {
    this.timeout(30_000);
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const mcpTarget = vscode.Uri.joinPath(folder.uri, 'mcp_graph_target.ts');
    const mcpConsumer = vscode.Uri.joinPath(folder.uri, 'mcp_graph_consumer.ts');
    const mcpLate = vscode.Uri.joinPath(folder.uri, 'mcp_late_symbol.ts');
    const mcpPythonModel = vscode.Uri.joinPath(folder.uri, 'mcp_python_model.py');
    const mcpExcludedDir = vscode.Uri.joinPath(folder.uri, 'out');
    const mcpExcluded = vscode.Uri.joinPath(mcpExcludedDir, 'mcp_excluded_probe.js');
    const mcpGeneratedDir = vscode.Uri.joinPath(folder.uri, 'src', 'client', 'graphql-codegen');
    const mcpGeneratedLarge = vscode.Uri.joinPath(mcpGeneratedDir, 'graphql.ts');
    try {
      await vscode.workspace.fs.writeFile(mcpTarget, Buffer.from([
        'export function mcpGraphTarget() {',
        '  return 1;',
        '}',
        '',
        'export class McpGraphBox {',
        '  mcpGraphBoxReport() {',
        '    return mcpGraphTarget();',
        '  }',
        '}',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(mcpConsumer, Buffer.from([
        'import { mcpGraphTarget } from "./mcp_graph_target";',
        '',
        'export function mcpGraphConsumer(items: Array<{ id: string; kind: string }>) {',
        '  const rendered = `expected ${items.map((edge) => `${edge.id}:${edge.kind}`).join(\', \')}`;',
        '  return mcpGraphTarget();',
        '}',
        ...Array.from({ length: 30 }, (_, index) => `const mcpSearchCapNeedle${index} = "mcpSearchCapNeedle";`),
        'const mcpDuplicateNeedle = "mcpDuplicateNeedle mcpDuplicateNeedle";',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.writeFile(mcpPythonModel, Buffer.from([
        'class TimestampedModel:',
        '    pass',
        '',
        'class RightToConsentOrConsult(',
        '    TimestampedModel,',
        '):',
        '    status = "open"',
        '',
        '    def label(self):',
        '        return self.status',
        '',
      ].join('\n'), 'utf8'));
      await vscode.workspace.fs.createDirectory(mcpExcludedDir);
      await vscode.workspace.fs.writeFile(mcpExcluded, Buffer.from([
        'export const mcpExcludedNeedle = "mcpExcludedNeedle";',
        '',
      ].join('\n'), 'utf8'));
      await api.callGraph.rebuild(undefined, undefined, { force: true });
      const url = await api.mcpServer.start(0);
      await vscode.workspace.fs.createDirectory(mcpGeneratedDir);
      await vscode.workspace.fs.writeFile(mcpGeneratedLarge, Buffer.from([
        'export const generatedNeedleA = "mcpLargeGeneratedNeedle";',
        'export const generatedNeedleB = "mcpLargeGeneratedOtherNeedle";',
        'export const mcpLargeGeneratedPadding = "' + 'x'.repeat(1_100_000) + '";',
        '',
      ].join('\n'), 'utf8'));
      const init = await postJson(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      });
      assert.strictEqual(init.result?.protocolVersion, '2025-11-25');
      assert.strictEqual(init.result?.serverInfo?.name, 'codeidx-mcp');
      assert.ok(init.result?.capabilities?.resources, 'expected resources capability');
      assert.ok(init.result?.capabilities?.prompts, 'expected prompts capability');
      const compatInit = await postJson(url, {
        jsonrpc: '2.0',
        id: 7,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      assert.strictEqual(compatInit.result?.protocolVersion, '2025-06-18');
      await postJsonMaybeEmpty(url, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });
      const response = await postJson(url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 2);
      const tools = response.result?.tools;
      assert.ok(Array.isArray(tools), 'expected tools/list to return a tools array');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_search_code'), 'expected codeidx_search_code tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_count'), 'expected codeidx_count tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_probe'), 'expected codeidx_probe tool');
      for (const name of [
        'codeidx_exists',
        'codeidx_files',
        'codeidx_first',
        'codeidx_top_files',
        'codeidx_file_digest',
        'codeidx_exports',
        'codeidx_imports',
        'codeidx_changed',
        'codeidx_symbol_slice',
        'codeidx_callers_summary',
        'codeidx_errors',
      ]) {
        assert.ok(tools.some((tool: { name?: string }) => tool.name === name), `expected ${name} tool`);
      }
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_search_symbols'), 'expected codeidx_search_symbols tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_outline'), 'expected codeidx_outline tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_signature'), 'expected codeidx_signature tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_find_references'), 'expected codeidx_find_references tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_find_implementations'), 'expected codeidx_find_implementations tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'codeidx_get_context_bundle'), 'expected codeidx_get_context_bundle tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'mcp_health'), 'expected mcp_health tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'mcp_test'), 'expected mcp_test tool');
      const resources = await postJson(url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/templates/list',
        params: {},
      });
      assert.ok(
        resources.result?.resourceTemplates?.some((resource: { uriTemplate?: string }) => resource.uriTemplate === 'codeidx://snippet/{snippet_ref}'),
        'expected snippet resource template',
      );
      const prompts = await postJson(url, {
        jsonrpc: '2.0',
        id: 4,
        method: 'prompts/list',
        params: {},
      });
      assert.ok(
        prompts.result?.prompts?.some((prompt: { name?: string }) => prompt.name === 'codeidx_change_impact'),
        'expected codeidx_change_impact prompt',
      );
      const prompt = await postJson(url, {
        jsonrpc: '2.0',
        id: 8,
        method: 'prompts/get',
        params: {
          name: 'codeidx_change_impact',
          arguments: { target: 'GraphPy.root', change: 'smoke test' },
        },
      });
      assert.ok(
        prompt.result?.messages?.[0]?.content?.text?.includes('codeidx_search_symbols'),
        'expected prompt to guide clients toward codeidx tools',
      );
      const overview = await postJson(url, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'codeidx_workspace_overview',
          arguments: { include_examples: false },
        },
      });
      assert.strictEqual(overview.result?.isError, false);
      assert.strictEqual(overview.result?.structuredContent?.schema_version, 'codeidx.mcp/0.1');
      assert.strictEqual(overview.result?.structuredContent?.ok, true);
      assert.ok(
        typeof overview.result?.content?.[0]?.text === 'string' &&
          overview.result.content[0].text.includes('"schema_version"'),
        'expected MCP text content alongside structuredContent for client compatibility',
      );
      const queryExplain = await postJson(url, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'codeidx_explain_search_query',
          arguments: { query: 'GraphPy', query_kind: 'literal' },
        },
      });
      assert.strictEqual(queryExplain.result?.isError, false);
      assert.strictEqual(queryExplain.result?.structuredContent?.query_diagnostics?.parsed, true);
      const invalidRegexExplain = await postJson(url, {
        jsonrpc: '2.0',
        id: 27,
        method: 'tools/call',
        params: {
          name: 'codeidx_explain_search_query',
          arguments: { query: '[unclosed', query_kind: 'regex' },
        },
      });
      assert.strictEqual(invalidRegexExplain.result?.isError, true);
      assert.strictEqual(invalidRegexExplain.result?.structuredContent?.error?.code, 'invalid_query');
      const autoRegexSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 28,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpSearchCapNeedle\\d+',
            query_kind: 'auto',
            limit: 5,
            max_chars: 20_000,
          },
        },
      });
      assert.strictEqual(autoRegexSearch.result?.isError, false);
      assert.strictEqual(autoRegexSearch.result?.structuredContent?.query_diagnostics?.effective_query_kind, 'regex');
      assert.ok(
        autoRegexSearch.result?.structuredContent?.results?.length > 0,
        `expected query_kind=auto to infer regex syntax, got ${JSON.stringify(autoRegexSearch.result?.structuredContent)}`,
      );
      const contextSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'return 1;',
            query_kind: 'literal',
            include_globs: ['mcp_graph_target.ts'],
            context_lines: 1,
            limit: 1,
            max_chars: 20_000,
          },
        },
      });
      assert.strictEqual(contextSearch.result?.isError, false);
      const contextSnippet = contextSearch.result?.structuredContent?.results?.[0]?.snippet ?? '';
      assert.match(
        contextSnippet,
        /1 \| export function mcpGraphTarget\(\)/,
        `expected search_code context_lines to inline surrounding snippet text, got ${JSON.stringify(contextSnippet)}`,
      );
      assert.match(contextSnippet, /2 \|   return 1;/);
      const countOnly = await postJson(url, {
        jsonrpc: '2.0',
        id: 36,
        method: 'tools/call',
        params: {
          name: 'codeidx_count',
          arguments: {
            query: 'mcpSearchCapNeedle\\d+',
            query_kind: 'auto',
            max_matches: 100,
            max_files: 10,
          },
        },
      });
      assert.strictEqual(countOnly.result?.isError, false);
      assert.strictEqual(countOnly.result?.structuredContent?.count?.total_matches, 30);
      assert.deepStrictEqual(
        countOnly.result?.structuredContent?.count?.by_file,
        [{ path: 'mcp_graph_consumer.ts', count: 30 }],
        `expected codeidx_count to return compact file counts, got ${JSON.stringify(countOnly.result?.structuredContent?.count)}`,
      );
      assert.strictEqual(
        countOnly.result?.structuredContent?.query_diagnostics?.scope?.default_exclude_patterns,
        'default',
        `expected compact scope diagnostics by default, got ${JSON.stringify(countOnly.result?.structuredContent?.query_diagnostics?.scope)}`,
      );
      const omittedCountOnly = await postJson(url, {
        jsonrpc: '2.0',
        id: 57,
        method: 'tools/call',
        params: {
          name: 'codeidx_count',
          arguments: {
            query: 'mcpGraphTarget',
            query_kind: 'literal',
            max_matches: 100,
            max_files: 1,
          },
        },
      });
      assert.strictEqual(omittedCountOnly.result?.isError, false);
      const omittedCount = omittedCountOnly.result?.structuredContent?.count;
      const returnedByFileSum = (omittedCount?.by_file ?? [])
        .reduce((sum: number, item: { count?: number }) => sum + (item.count ?? 0), 0);
      assert.ok(
        omittedCount?.total_matches > returnedByFileSum,
        `expected codeidx_count total_matches to include omitted files, got ${JSON.stringify(omittedCount)}`,
      );
      assert.ok(
        omittedCount?.omitted_files > 0 && omittedCount?.exact === true,
        `expected max_files to omit only by_file details without making count inexact, got ${JSON.stringify(omittedCount)}`,
      );
      const duplicateCountOnly = await postJson(url, {
        jsonrpc: '2.0',
        id: 39,
        method: 'tools/call',
        params: {
          name: 'codeidx_count',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
            max_matches: 10,
            max_files: 10,
          },
        },
      });
      assert.strictEqual(duplicateCountOnly.result?.isError, false);
      assert.strictEqual(
        duplicateCountOnly.result?.structuredContent?.count?.total_matches,
        3,
        `expected codeidx_count to count duplicate occurrences on one line, got ${JSON.stringify(duplicateCountOnly.result?.structuredContent?.count)}`,
      );
      const duplicateProbe = await postJson(url, {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'codeidx_probe',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
            by_file_limit: 1,
          },
        },
      });
      assert.strictEqual(duplicateProbe.result?.isError, false);
      assert.strictEqual(duplicateProbe.result?.structuredContent, undefined);
      assert.match(
        duplicateProbe.result?.content?.[0]?.text ?? '',
        /^3\t1\texact\t(?:zoekt|codesearch)\nmcp_graph_consumer\.ts\t3$/,
        `expected codeidx_probe to return ultra-compact text, got ${JSON.stringify(duplicateProbe.result?.content ?? [])}`,
      );
      const existsProbe = await postJson(url, {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'codeidx_exists',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
          },
        },
      });
      assert.strictEqual(existsProbe.result?.isError, false);
      assert.strictEqual(existsProbe.result?.content?.[0]?.text, '1');
      const filesProbe = await postJson(url, {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'codeidx_files',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
            include_counts: true,
          },
        },
      });
      assert.strictEqual(filesProbe.result?.isError, false);
      assert.match(filesProbe.result?.content?.[0]?.text ?? '', /^1\nmcp_graph_consumer\.ts\t3$/);
      const firstProbe = await postJson(url, {
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: {
          name: 'codeidx_first',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
          },
        },
      });
      assert.strictEqual(firstProbe.result?.isError, false);
      assert.match(firstProbe.result?.content?.[0]?.text ?? '', /^mcp_graph_consumer\.ts:\d+\t/);
      const topFilesProbe = await postJson(url, {
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: 'codeidx_top_files',
          arguments: {
            query: 'mcpDuplicateNeedle',
            query_kind: 'literal',
            limit: 2,
          },
        },
      });
      assert.strictEqual(topFilesProbe.result?.isError, false);
      assert.match(topFilesProbe.result?.content?.[0]?.text ?? '', /^3\nmcp_graph_consumer\.ts\t3$/);
      const fileDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: {
          name: 'codeidx_file_digest',
          arguments: {
            path: 'mcp_graph_consumer.ts',
            max_symbols: 5,
          },
        },
      });
      assert.strictEqual(fileDigest.result?.isError, false);
      assert.match(fileDigest.result?.content?.[0]?.text ?? '', /^mcp_graph_consumer\.ts\ttypescript\t/);
      assert.match(fileDigest.result?.content?.[0]?.text ?? '', /imports=1/);
      const importsDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 47,
        method: 'tools/call',
        params: {
          name: 'codeidx_imports',
          arguments: {
            path: 'mcp_graph_consumer.ts',
          },
        },
      });
      assert.strictEqual(importsDigest.result?.isError, false);
      assert.match(importsDigest.result?.content?.[0]?.text ?? '', /mcp_graph_consumer\.ts\t\.\/mcp_graph_target/);
      const exportsDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 48,
        method: 'tools/call',
        params: {
          name: 'codeidx_exports',
          arguments: {
            path: 'mcp_graph_target.ts',
          },
        },
      });
      assert.strictEqual(exportsDigest.result?.isError, false);
      assert.match(exportsDigest.result?.content?.[0]?.text ?? '', /mcp_graph_target\.ts:1\tfunction\tmcpGraphTarget/);
      const changedDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 49,
        method: 'tools/call',
        params: {
          name: 'codeidx_changed',
          arguments: {
            max_files: 5,
            include_outline: false,
          },
        },
      });
      assert.strictEqual(changedDigest.result?.isError, false);
      assert.strictEqual(typeof changedDigest.result?.content?.[0]?.text, 'string');
      const errorsDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'codeidx_errors',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            max_items: 5,
          },
        },
      });
      assert.strictEqual(errorsDigest.result?.isError, false);
      assert.strictEqual(typeof errorsDigest.result?.content?.[0]?.text, 'string');
      const zoektSubsetSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 29,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'f:mcp_graph_consumer\\.ts$ mcpGraphTarget',
            query_kind: 'zoekt',
            limit: 10,
            max_chars: 20_000,
          },
        },
      });
      assert.strictEqual(zoektSubsetSearch.result?.isError, false);
      assert.ok(
        zoektSubsetSearch.result?.structuredContent?.results?.length > 0 &&
          zoektSubsetSearch.result.structuredContent.results.every((item: { path?: string }) => item.path === 'mcp_graph_consumer.ts'),
        `expected query_kind=zoekt f: path regex subset to restrict results, got ${JSON.stringify(zoektSubsetSearch.result?.structuredContent?.results ?? [])}`,
      );
      const mergedSnippets = await postJson(url, {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'codeidx_read_snippets',
          arguments: {
            snippets: [
              { file: 'mcp_graph_consumer.ts', start_line: 3, end_line: 4, context_lines: 0 },
              { file: 'mcp_graph_consumer.ts', start_line: 4, end_line: 5, context_lines: 0 },
            ],
            merge_overlaps: true,
          },
        },
      });
      assert.strictEqual(mergedSnippets.result?.isError, false);
      assert.strictEqual(
        mergedSnippets.result?.structuredContent?.snippets?.length,
        1,
        `expected read_snippets merge_overlaps=true to merge intersecting ranges, got ${JSON.stringify(mergedSnippets.result?.structuredContent?.snippets ?? [])}`,
      );
      assert.deepStrictEqual(mergedSnippets.result?.structuredContent?.snippets?.[0]?.line_range, { start: 3, end: 5 });
      const outline = await postJson(url, {
        jsonrpc: '2.0',
        id: 37,
        method: 'tools/call',
        params: {
          name: 'codeidx_outline',
          arguments: {
            path: 'mcp_graph_target.ts',
            max_symbols: 20,
          },
        },
      });
      assert.strictEqual(outline.result?.isError, false);
      const outlinedNames = outline.result?.structuredContent?.outline?.files?.[0]?.symbols
        ?.map((item: { name?: string }) => item.name) ?? [];
      assert.ok(
        outlinedNames.includes('mcpGraphTarget') && outlinedNames.includes('McpGraphBox'),
        `expected codeidx_outline to include top-level function and class, got ${JSON.stringify(outline.result?.structuredContent?.outline)}`,
      );
      assert.ok(
        !outlinedNames.includes('mcpGraphBoxReport'),
        `expected codeidx_outline default to omit nested methods, got ${JSON.stringify(outline.result?.structuredContent?.outline)}`,
      );
      const pythonDigest = await postJson(url, {
        jsonrpc: '2.0',
        id: 59,
        method: 'tools/call',
        params: {
          name: 'codeidx_file_digest',
          arguments: {
            path: 'mcp_python_model.py',
            max_symbols: 10,
          },
        },
      });
      assert.strictEqual(pythonDigest.result?.isError, false);
      assert.match(
        pythonDigest.result?.content?.[0]?.text ?? '',
        /class\tRightToConsentOrConsult\t4/,
        `expected Python file_digest to include top-level Django-style class, got ${JSON.stringify(pythonDigest.result?.content ?? [])}`,
      );
      const pythonResolve = await postJson(url, {
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/call',
        params: {
          name: 'codeidx_resolve_at',
          arguments: {
            file: 'mcp_python_model.py',
            line: 4,
            character_utf16: 8,
          },
        },
      });
      assert.strictEqual(pythonResolve.result?.isError, false);
      assert.strictEqual(
        pythonResolve.result?.structuredContent?.target_symbol?.name,
        'RightToConsentOrConsult',
        `expected Python resolve_at to resolve the class definition, got ${JSON.stringify(pythonResolve.result?.structuredContent)}`,
      );
      const cappedSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpSearchCapNeedle',
            query_kind: 'literal',
            limit: 200,
            max_chars: 1000,
          },
        },
      });
      assert.strictEqual(cappedSearch.result?.isError, false);
      assert.strictEqual(
        cappedSearch.result?.structuredContent?.truncated,
        true,
        `expected capped search to truncate, got ${JSON.stringify(cappedSearch.result?.structuredContent)}`,
      );
      assert.ok(
        typeof cappedSearch.result?.structuredContent?.next_cursor === 'string',
        'expected capped search_code results to remain pageable with next_cursor',
      );
      const cappedResults = cappedSearch.result?.structuredContent?.results ?? [];
      const cappedLinks = cappedSearch.result?.structuredContent?.resource_links ?? [];
      assert.ok(
        cappedResults.length > 0,
        `expected capped search_code to keep at least one result, got ${JSON.stringify(cappedSearch.result?.structuredContent)}`,
      );
      assert.strictEqual(
        cappedLinks.length,
        cappedResults.length,
        `expected capped search_code resource_links to match returned result window, got ${JSON.stringify(cappedSearch.result?.structuredContent)}`,
      );
      const excludedDefaultSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpExcludedNeedle',
            query_kind: 'literal',
            include_globs: ['out/**/*.js'],
            limit: 10,
          },
        },
      });
      assert.strictEqual(excludedDefaultSearch.result?.isError, false);
      assert.strictEqual(
        excludedDefaultSearch.result?.structuredContent?.results?.length,
        0,
        `expected default MCP excludes to omit out/, got ${JSON.stringify(excludedDefaultSearch.result?.structuredContent?.results ?? [])}`,
      );
      const excludedOverrideSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpExcludedNeedle',
            query_kind: 'literal',
            include_globs: ['out/**/*.js'],
            exclude_policy: 'custom_only',
            limit: 10,
          },
        },
      });
      assert.strictEqual(excludedOverrideSearch.result?.isError, false);
      assert.strictEqual(
        excludedOverrideSearch.result?.structuredContent?.query_diagnostics?.scope?.exclude_policy,
        'custom_only',
      );
      assert.ok(
        excludedOverrideSearch.result?.structuredContent?.results?.some(
          (item: { path?: string }) => item.path === 'out/mcp_excluded_probe.js',
        ),
        `expected exclude_policy=custom_only to search explicitly included out/ files, got ${JSON.stringify(excludedOverrideSearch.result?.structuredContent?.results ?? [])}`,
      );
      assert.strictEqual(
        excludedOverrideSearch.result?.structuredContent?.query_diagnostics?.scope?.force_full_scan,
        true,
        'expected custom scope for out/ to force full scan because out/ is outside the Zoekt index',
      );
      const generatedDefaultSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 95,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpLargeGeneratedNeedle',
            query_kind: 'literal',
            include_globs: ['src/**/graphql-codegen/**'],
            limit: 10,
          },
        },
      });
      assert.strictEqual(generatedDefaultSearch.result?.isError, false);
      assert.strictEqual(
        generatedDefaultSearch.result?.structuredContent?.results?.length,
        0,
        `expected default MCP generated excludes to omit graphql-codegen, got ${JSON.stringify(generatedDefaultSearch.result?.structuredContent?.results ?? [])}`,
      );
      const generatedIncludedSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 96,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpLargeGeneratedNeedle',
            query_kind: 'literal',
            include_globs: ['src/**/graphql-codegen/**'],
            include_generated: true,
            limit: 10,
          },
        },
      });
      assert.strictEqual(generatedIncludedSearch.result?.isError, false);
      assert.strictEqual(
        generatedIncludedSearch.result?.structuredContent?.query_diagnostics?.scope?.force_full_scan,
        true,
        'expected include_generated=true to force full scan for generated files that may be outside the Zoekt index or file-size cap',
      );
      assert.ok(
        generatedIncludedSearch.result?.structuredContent?.results?.some(
          (item: { path?: string }) => item.path === 'src/client/graphql-codegen/graphql.ts',
        ),
        `expected include_generated=true to search large graphql-codegen files, got ${JSON.stringify(generatedIncludedSearch.result?.structuredContent?.results ?? [])}`,
      );
      const generatedOrCount = await postJson(url, {
        jsonrpc: '2.0',
        id: 97,
        method: 'tools/call',
        params: {
          name: 'codeidx_count',
          arguments: {
            queries: ['mcpLargeGeneratedNeedle', 'mcpLargeGeneratedOtherNeedle'],
            query_kind: 'literal',
            query_operator: 'any',
            include_globs: ['src/**/graphql-codegen/**'],
            include_generated: true,
            max_matches: 10,
          },
        },
      });
      assert.strictEqual(generatedOrCount.result?.isError, false);
      assert.strictEqual(generatedOrCount.result?.structuredContent?.query_diagnostics?.query_operator, 'any');
      assert.strictEqual(
        generatedOrCount.result?.structuredContent?.count?.total_matches,
        2,
        `expected include_generated OR count to include both generated terms, got ${JSON.stringify(generatedOrCount.result?.structuredContent)}`,
      );
      const indexedCustomScopeSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_code',
          arguments: {
            query: 'mcpGraphTarget',
            query_kind: 'literal',
            include_globs: ['mcp_graph_consumer.ts'],
            exclude_policy: 'custom_only',
            limit: 10,
          },
        },
      });
      assert.strictEqual(indexedCustomScopeSearch.result?.isError, false);
      assert.strictEqual(
        indexedCustomScopeSearch.result?.structuredContent?.query_diagnostics?.scope?.force_full_scan,
        false,
        `expected indexed custom scope to keep Zoekt path, got ${JSON.stringify(indexedCustomScopeSearch.result?.structuredContent?.query_diagnostics)}`,
      );
      const health = await postJson(url, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'mcp_health',
          arguments: { include_tools: true },
        },
      });
      assert.strictEqual(health.result?.isError, false);
      assert.strictEqual(health.result?.structuredContent?.health?.mcp_connection, 'ok');
      assert.strictEqual(health.result?.structuredContent?.health?.endpoint, url);
      assert.strictEqual(health.result?.structuredContent?.discovery?.exists, true);
      assert.strictEqual(health.result?.structuredContent?.discovery?.matches_current_endpoint, true);
      assert.strictEqual(health.result?.structuredContent?.discovery?.stdio_launcher?.exists, true);
      assert.strictEqual(health.result?.structuredContent?.discovery?.stdio_launcher?.type, 'stdio');
      assert.strictEqual(health.result?.structuredContent?.discovery?.stdio_launcher?.command, 'node');
      assert.deepStrictEqual(
        health.result?.structuredContent?.discovery?.stdio_launcher?.args,
        ['.codeidx/codeidx-mcp-stdio.js', 'stdio', '--workspace', '.'],
      );
      assert.ok(
        health.result?.structuredContent?.tools?.includes('mcp_test'),
        'expected health check to include mcp_test when include_tools=true',
      );
      const parallelHealth = await Promise.all(Array.from({ length: 12 }, (_, index) => postJson(url, {
        jsonrpc: '2.0',
        id: 70 + index,
        method: 'tools/call',
        params: {
          name: 'mcp_health',
          arguments: {},
        },
      })));
      assert.ok(
        parallelHealth.every((item) => item.result?.structuredContent?.health?.mcp_connection === 'ok'),
        `expected parallel MCP health calls to stay stable, got ${JSON.stringify(parallelHealth.map((item) => item.error ?? item.result?.structuredContent?.health))}`,
      );
      const mcpTest = await postJson(url, {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'mcp_test',
          arguments: {
            query: '한국어 지원',
            query_kind: 'literal',
            limit: 5,
          },
        },
      });
      assert.strictEqual(mcpTest.result?.isError, false);
      assert.strictEqual(mcpTest.result?.structuredContent?.test?.accuracy?.missing_from_mcp?.length, 0);
      assert.ok(
        typeof mcpTest.result?.structuredContent?.test?.efficiency?.estimated_mcp_tokens === 'number',
        'expected mcp_test to report token estimates',
      );
      const parallelMcpTests = await Promise.all(Array.from({ length: 4 }, (_, index) => postJson(url, {
        jsonrpc: '2.0',
        id: 90 + index,
        method: 'tools/call',
        params: {
          name: 'mcp_test',
          arguments: {
            query: index % 2 === 0 ? 'mcpGraphTarget' : 'mcpGraphBox',
            query_kind: 'literal',
            include_globs: ['mcp_graph_*.ts'],
            limit: 10,
            max_chars: 40_000,
          },
        },
      })));
      assert.ok(
        parallelMcpTests.every((item) => item.result?.isError === false),
        `expected parallel mcp_test calls to be queued and complete, got ${JSON.stringify(parallelMcpTests.map((item) => item.error ?? item.result?.structuredContent?.error))}`,
      );
      const postParallelHealth = await postJson(url, {
        jsonrpc: '2.0',
        id: 94,
        method: 'tools/call',
        params: {
          name: 'mcp_health',
          arguments: {},
        },
      });
      assert.strictEqual(postParallelHealth.result?.structuredContent?.health?.mcp_connection, 'ok');
      const mcpBroadRecallTest = await postJson(url, {
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: {
          name: 'mcp_test',
          arguments: {
            query: 'buildCallGraph',
            query_kind: 'literal',
            limit: 100,
            max_chars: 100000,
          },
        },
      });
      assert.strictEqual(mcpBroadRecallTest.result?.isError, false);
      assert.strictEqual(
        mcpBroadRecallTest.result?.structuredContent?.test?.accuracy?.missing_from_mcp?.length,
        0,
        `expected broad mcp_test search to preserve recall, got ${JSON.stringify(mcpBroadRecallTest.result?.structuredContent?.test?.accuracy ?? {})}`,
      );
      const exactSymbolMiss = await postJson(url, {
        jsonrpc: '2.0',
        id: 62,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpGraph',
            match: 'exact',
            limit: 10,
          },
        },
      });
      assert.strictEqual(exactSymbolMiss.result?.isError, false);
      assert.strictEqual(
        exactSymbolMiss.result?.structuredContent?.results?.length,
        0,
        `expected exact symbol search to reject prefix/substring matches, got ${JSON.stringify(exactSymbolMiss.result?.structuredContent?.results ?? [])}`,
      );
      const symbolSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpGraphTarget',
            match: 'exact',
            limit: 10,
          },
        },
      });
      assert.strictEqual(symbolSearch.result?.isError, false);
      assert.ok(
        (symbolSearch.result?.structuredContent?.results ?? []).every((item: { name?: string }) => item.name === 'mcpGraphTarget'),
        `expected exact symbol search to return only exact names, got ${JSON.stringify(symbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      const quickPickSymbol = symbolSearch.result?.structuredContent?.results?.find(
        (item: { definition?: { file?: string }; symbol_id?: string; internal_symbol_id?: string }) =>
          item.definition?.file === 'mcp_graph_target.ts',
      );
      assert.ok(
        quickPickSymbol?.symbol_id,
        `expected MCP symbol search to find mcpGraphTarget in mcp_graph_target.ts, got ${JSON.stringify(symbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      assert.match(
        quickPickSymbol.symbol_id,
        /^esy_/,
        `expected public symbol_id to be stable and line-free, got ${quickPickSymbol.symbol_id}`,
      );
      assert.match(
        quickPickSymbol.internal_symbol_id ?? '',
        /^typescript:mcp_graph_target\.ts:mcpGraphTarget:1$/,
        `expected internal symbol id to remain available for diagnostics, got ${quickPickSymbol.internal_symbol_id}`,
      );
      const signature = await postJson(url, {
        jsonrpc: '2.0',
        id: 38,
        method: 'tools/call',
        params: {
          name: 'codeidx_signature',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
          },
        },
      });
      assert.strictEqual(signature.result?.isError, false);
      assert.ok(
        typeof signature.result?.structuredContent?.signature?.text === 'string' &&
          signature.result.structuredContent.signature.text.includes('mcpGraphTarget'),
        `expected codeidx_signature to return a compact signature line, got ${JSON.stringify(signature.result?.structuredContent?.signature)}`,
      );
      assert.strictEqual(
        signature.result?.structuredContent?.signature?.symbol_id,
        quickPickSymbol.symbol_id,
        `expected codeidx_signature to return the public esy_ symbol id, got ${JSON.stringify(signature.result?.structuredContent?.signature)}`,
      );
      assert.strictEqual(
        signature.result?.structuredContent?.signature?.internal_symbol_id,
        quickPickSymbol.internal_symbol_id,
        `expected codeidx_signature to retain the internal id separately, got ${JSON.stringify(signature.result?.structuredContent?.signature)}`,
      );
      assert.ok(
        !signature.result?.structuredContent?.signature?.text?.includes('return 1;'),
        `expected codeidx_signature to omit function body, got ${JSON.stringify(signature.result?.structuredContent?.signature)}`,
      );
      const symbolDetails = await postJson(url, {
        jsonrpc: '2.0',
        id: 63,
        method: 'tools/call',
        params: {
          name: 'codeidx_symbol_details',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            include_definition_snippet: false,
          },
        },
      });
      assert.strictEqual(symbolDetails.result?.isError, false);
      assert.notStrictEqual(
        symbolDetails.result?.structuredContent?.symbol?.body_range?.end_character_utf16,
        4294967295,
        `expected symbol_details to hide sentinel range characters, got ${JSON.stringify(symbolDetails.result?.structuredContent?.symbol?.body_range)}`,
      );
      assert.strictEqual(
        symbolDetails.result?.structuredContent?.counts,
        undefined,
        `expected symbol_details counts to be opt-in for fast large-repo use, got ${JSON.stringify(symbolDetails.result?.structuredContent?.counts)}`,
      );
      const staleInternalId = String(quickPickSymbol.internal_symbol_id).replace(/:1$/, ':2');
      const revivedSignature = await postJson(url, {
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'codeidx_signature',
          arguments: {
            symbol_id: staleInternalId,
          },
        },
      });
      assert.strictEqual(revivedSignature.result?.isError, false);
      assert.strictEqual(
        revivedSignature.result?.structuredContent?.signature?.name,
        'mcpGraphTarget',
        `expected stale internal symbol id ${staleInternalId} to revive to mcpGraphTarget, got ${JSON.stringify(revivedSignature.result?.structuredContent)}`,
      );
      const seededContextBundle = await postJson(url, {
        jsonrpc: '2.0',
        id: 58,
        method: 'tools/call',
        params: {
          name: 'codeidx_get_context_bundle',
          arguments: {
            task: 'inspect seeded MCP graph target',
            seed_symbols: [quickPickSymbol.symbol_id],
            token_budget: 2_000,
          },
        },
      });
      assert.strictEqual(seededContextBundle.result?.isError, false);
      assert.ok(
        seededContextBundle.result?.structuredContent?.entry_points?.some(
          (entry: { label?: string; reason?: string }) =>
            entry.label === 'mcpGraphTarget' && entry.reason === 'seed symbol',
        ),
        `expected get_context_bundle to resolve external seed symbol ids, got ${JSON.stringify(seededContextBundle.result?.structuredContent?.entry_points ?? [])}`,
      );
      const symbolSlice = await postJson(url, {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'codeidx_symbol_slice',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
          },
        },
      });
      assert.strictEqual(symbolSlice.result?.isError, false);
      assert.match(symbolSlice.result?.content?.[0]?.text ?? '', /^mcp_graph_target\.ts:1-\d+\tfunction\tmcpGraphTarget\t/);
      const symbolSliceFromSignatureTypePosition = await postJson(url, {
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'codeidx_symbol_slice',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 3,
            character_utf16: 43,
          },
        },
      });
      assert.strictEqual(symbolSliceFromSignatureTypePosition.result?.isError, false);
      assert.match(
        symbolSliceFromSignatureTypePosition.result?.content?.[0]?.text ?? '',
        /^mcp_graph_consumer\.ts:3-\d+\tfunction\tmcpGraphConsumer\t/,
        `expected file/line symbol_slice inside a signature type to prefer the enclosing function, got ${JSON.stringify(symbolSliceFromSignatureTypePosition.result?.content ?? [])}`,
      );
      const signatureFromSignatureTypePosition = await postJson(url, {
        jsonrpc: '2.0',
        id: 56,
        method: 'tools/call',
        params: {
          name: 'codeidx_signature',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 3,
            character_utf16: 43,
          },
        },
      });
      assert.strictEqual(signatureFromSignatureTypePosition.result?.isError, false);
      assert.ok(
        signatureFromSignatureTypePosition.result?.structuredContent?.signature?.text?.includes('mcpGraphConsumer'),
        `expected file/line codeidx_signature to resolve the enclosing function, got ${JSON.stringify(signatureFromSignatureTypePosition.result?.structuredContent?.signature)}`,
      );
      assert.ok(
        !signatureFromSignatureTypePosition.result?.structuredContent?.signature?.text?.includes('const rendered'),
        `expected file/line codeidx_signature to omit function body, got ${JSON.stringify(signatureFromSignatureTypePosition.result?.structuredContent?.signature)}`,
      );
      const callersSummary = await postJson(url, {
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'codeidx_callers_summary',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            limit: 20,
          },
        },
      });
      assert.strictEqual(callersSummary.result?.isError, false);
      assert.match(callersSummary.result?.content?.[0]?.text ?? '', /^[1-9]\d*\t/);
      const callersSummaryFromSignatureTypePosition = await postJson(url, {
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'codeidx_callers_summary',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 3,
            character_utf16: 43,
          },
        },
      });
      assert.strictEqual(callersSummaryFromSignatureTypePosition.result?.isError, false);
      assert.match(
        callersSummaryFromSignatureTypePosition.result?.content?.[0]?.text ?? '',
        /\tmcpGraphConsumer(?:\n|$)/,
        `expected file/line callers_summary inside a signature type to summarize the enclosing function, got ${JSON.stringify(callersSummaryFromSignatureTypePosition.result?.content ?? [])}`,
      );
      const containerSymbolSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpGraphBoxReport',
            container: 'McpGraphBox',
            limit: 10,
          },
        },
      });
      assert.strictEqual(containerSymbolSearch.result?.isError, false);
      assert.ok(
        containerSymbolSearch.result?.structuredContent?.results?.some(
          (item: { definition?: { file?: string }; name?: string }) =>
            item.name === 'mcpGraphBoxReport' && item.definition?.file === 'mcp_graph_target.ts',
        ),
        `expected search_symbols container filter to keep McpGraphBox.mcpGraphBoxReport, got ${JSON.stringify(containerSymbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      const missingContainerSymbolSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpGraphBoxReport',
            container: 'DoesNotExist',
            limit: 10,
          },
        },
      });
      assert.strictEqual(missingContainerSymbolSearch.result?.isError, false);
      assert.strictEqual(
        missingContainerSymbolSearch.result?.structuredContent?.results?.length,
        0,
        `expected search_symbols container filter to exclude nonmatching containers, got ${JSON.stringify(missingContainerSymbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      const missingFrameworkSymbolSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpGraphTarget',
            frameworks: ['DoesNotExist'],
            limit: 10,
          },
        },
      });
      assert.strictEqual(missingFrameworkSymbolSearch.result?.isError, false);
      assert.strictEqual(
        missingFrameworkSymbolSearch.result?.structuredContent?.results?.length,
        0,
        `expected search_symbols frameworks filter to exclude nonmatching frameworks, got ${JSON.stringify(missingFrameworkSymbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      const references = await postJson(url, {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/call',
        params: {
          name: 'codeidx_find_references',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            limit: 20,
          },
        },
      });
      assert.strictEqual(references.result?.isError, false);
      const referenceLocations = references.result?.structuredContent?.groups
        ?.flatMap((group: { references?: Array<{ location?: { file?: string; start_line?: number } }> }) => group.references ?? [])
        .map((item: { location?: { file?: string; start_line?: number } }) => `${item.location?.file}:${item.location?.start_line}`) ?? [];
      assert.ok(
        referenceLocations.includes('mcp_graph_consumer.ts:1') &&
          referenceLocations.includes('mcp_graph_consumer.ts:5'),
        `expected MCP references to include imported callback fixture call sites, got ${referenceLocations.join(', ')}`,
      );
      const constructOnlyReferences = await postJson(url, {
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: {
          name: 'codeidx_find_references',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            edge_kinds: ['construct'],
            limit: 20,
          },
        },
      });
      assert.strictEqual(constructOnlyReferences.result?.isError, false);
      assert.strictEqual(
        constructOnlyReferences.result?.structuredContent?.counts?.total,
        0,
        `expected find_references edge_kinds=['construct'] to filter usage/call edges, got ${JSON.stringify(constructOnlyReferences.result?.structuredContent)}`,
      );
      const resolveDefinition = await postJson(url, {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'codeidx_resolve_at',
          arguments: {
            file: 'mcp_graph_target.ts',
            line: 1,
            character_utf16: 20,
          },
        },
      });
      assert.strictEqual(resolveDefinition.result?.isError, false);
      assert.strictEqual(resolveDefinition.result?.structuredContent?.target_symbol?.symbol_id, quickPickSymbol.symbol_id);
      const resolveCall = await postJson(url, {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: 'codeidx_resolve_at',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 5,
            character_utf16: 12,
          },
        },
      });
      assert.strictEqual(resolveCall.result?.isError, false);
      assert.strictEqual(resolveCall.result?.structuredContent?.target_symbol?.symbol_id, quickPickSymbol.symbol_id);
      const resolveLocal = await postJson(url, {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'codeidx_resolve_at',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 4,
            character_utf16: 10,
          },
        },
      });
      assert.strictEqual(resolveLocal.result?.isError, false);
      assert.strictEqual(
        resolveLocal.result?.structuredContent?.target_symbol,
        null,
        `expected local variable resolve_at to avoid global false positives, got ${JSON.stringify(resolveLocal.result?.structuredContent?.target_symbol)}`,
      );
      const resolveKeyword = await postJson(url, {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'codeidx_resolve_at',
          arguments: {
            file: 'mcp_graph_consumer.ts',
            line: 4,
            character_utf16: 3,
          },
        },
      });
      assert.strictEqual(resolveKeyword.result?.isError, false);
      assert.strictEqual(
        resolveKeyword.result?.structuredContent?.target_symbol,
        null,
        `expected keyword resolve_at to avoid global false positives, got ${JSON.stringify(resolveKeyword.result?.structuredContent?.target_symbol)}`,
      );
      const graphNeighbors = await postJson(url, {
        jsonrpc: '2.0',
        id: 19,
        method: 'tools/call',
        params: {
          name: 'codeidx_graph_neighbors',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            directions: ['incoming'],
            max_edges: 20,
          },
        },
      });
      assert.strictEqual(graphNeighbors.result?.isError, false);
      assert.ok(
        graphNeighbors.result?.structuredContent?.edges?.length > 0,
        'expected graph_neighbors to expose at least usage fallback edges for rust-native graph mode',
      );
      const constructOnlyGraphNeighbors = await postJson(url, {
        jsonrpc: '2.0',
        id: 35,
        method: 'tools/call',
        params: {
          name: 'codeidx_graph_neighbors',
          arguments: {
            symbol_id: quickPickSymbol.symbol_id,
            directions: ['incoming'],
            edge_kinds: ['construct'],
            max_edges: 20,
          },
        },
      });
      assert.strictEqual(constructOnlyGraphNeighbors.result?.isError, false);
      assert.strictEqual(
        constructOnlyGraphNeighbors.result?.structuredContent?.edges?.length,
        0,
        `expected graph_neighbors edge_kinds=['construct'] to filter usage fallback edges, got ${JSON.stringify(constructOnlyGraphNeighbors.result?.structuredContent?.edges ?? [])}`,
      );
      await vscode.workspace.fs.writeFile(mcpLate, Buffer.from([
        'export function mcpLateSymbol() {',
        '  return 2;',
        '}',
        '',
      ].join('\n'), 'utf8'));
      const lateSymbolSearch = await postJson(url, {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'codeidx_search_symbols',
          arguments: {
            query: 'mcpLateSymbol',
            limit: 10,
          },
        },
      });
      assert.strictEqual(lateSymbolSearch.result?.isError, false);
      assert.ok(
        lateSymbolSearch.result?.structuredContent?.results?.some(
          (item: { definition?: { file?: string } }) => item.definition?.file === 'mcp_late_symbol.ts',
        ),
        `expected symbol search to opportunistically refresh a newly added file, got ${JSON.stringify(lateSymbolSearch.result?.structuredContent?.results ?? [])}`,
      );
      const listedResources = await postJson(url, {
        jsonrpc: '2.0',
        id: 6,
        method: 'resources/list',
        params: {},
      });
      assert.ok(
        listedResources.result?.resources?.some((resource: { uri?: string }) => resource.uri?.includes('/overview')),
        'expected workspace overview resource',
      );
      const overviewResource = listedResources.result.resources.find((resource: { uri?: string }) => resource.uri?.includes('/overview'));
      const readOverview = await postJson(url, {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/read',
        params: { uri: overviewResource.uri },
      });
      assert.ok(
        readOverview.result?.contents?.[0]?.text?.includes('"schema_version"'),
        'expected resources/read to return JSON text content',
      );
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      assert.ok(workspaceRoot, 'expected test workspace root');
      const cliPath = path.join(workspaceRoot, '.codeidx', 'codeidx-mcp-stdio.js');
      await vscode.workspace.fs.stat(vscode.Uri.file(cliPath));
      const stdioProxy = spawn(process.execPath, [cliPath, 'stdio', '--workspace', '.'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
      let stdioStderr = '';
      stdioProxy.stderr.on('data', (chunk: Buffer) => {
        stdioStderr += chunk.toString('utf8');
      });
      try {
        const stdioInit = await sendStdioJson(stdioProxy, {
          jsonrpc: '2.0',
          id: 11,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25' },
        });
        assert.strictEqual(stdioInit.result?.serverInfo?.name, 'codeidx-mcp');
        const stdioTools = await sendStdioJson(stdioProxy, {
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/list',
          params: {},
        });
        assert.ok(
          stdioTools.result?.tools?.some((tool: { name?: string }) => tool.name === 'codeidx_search_code'),
          `expected stdio proxy to return tools/list; stderr=${stdioStderr}`,
        );
      } finally {
        await stopChild(stdioProxy);
      }
    } finally {
      api.mcpServer.stop();
      try { await vscode.workspace.fs.delete(mcpTarget); } catch {}
      try { await vscode.workspace.fs.delete(mcpConsumer); } catch {}
      try { await vscode.workspace.fs.delete(mcpLate); } catch {}
      try { await vscode.workspace.fs.delete(mcpPythonModel); } catch {}
      try { await vscode.workspace.fs.delete(mcpExcluded); } catch {}
      try { await vscode.workspace.fs.delete(mcpGeneratedDir, { recursive: true, useTrash: false }); } catch {}
    }
  });

  // User-reported regression: when a symbol has more than 500 usages the
  // Find Usages panel only shows 500 rows. Root cause:
  // callGraph.findUsages() / findUsagesForSymbolIdFromCache() both default
  // to limit=500, and the inlay flow calls them without an explicit limit.
  // The fix added `intellijStyledSearch.callGraphMaxUsageResults` config
  // (default 10_000) and threads it through. This test:
  //   1. seeds a Python function with 700 call sites,
  //   2. asserts the cache index returns more than the old 500 cap when
  //      asked for a higher limit,
  //   3. asserts an explicit small cap (e.g. 7) is still honoured.
  test('Find Usages respects the configured cap above the legacy 500 limit', async function () {
    this.timeout(30_000);
    const restoreBackend = await useCallGraphBackend('javascript');
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const target = vscode.Uri.joinPath(folder.uri, 'usage_cap_target.py');
    const consumer = vscode.Uri.joinPath(folder.uri, 'usage_cap_consumer.py');
    const callCount = 700;
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from([
        'def usage_cap_function() -> int:',
        '    return 1',
        '',
      ].join('\n'), 'utf8'));
      const consumerLines = [
        'from usage_cap_target import usage_cap_function',
        '',
        'def consume_many():',
        ...Array.from({ length: callCount }, () => '    usage_cap_function()'),
        '    return 0',
        '',
      ];
      await vscode.workspace.fs.writeFile(consumer, Buffer.from(consumerLines.join('\n'), 'utf8'));
      await api.callGraph.rebuild(undefined, undefined, { force: true });

      const symbols = await api.callGraph.resolveSymbolsResolved('usage_cap_function', 5);
      const fn = symbols.find((s) => s.qualifiedName === 'usage_cap_function');
      assert.ok(fn, `expected usage_cap_function in resolved symbols, got ${symbols.map((s) => s.qualifiedName).join(', ')}`);

      // 1) Asking for 1000 should return more than the legacy 500 cap.
      const wide = await api.callGraph.findUsagesForSymbolIdFromCache(fn!.id, 1000);
      assert.ok(
        wide && wide.length > 500,
        `findUsagesForSymbolIdFromCache(limit=1000) should exceed the legacy 500 cap when the symbol has ${callCount} usages; got ${wide?.length ?? 'undefined'}`,
      );
      assert.ok(
        wide!.length >= callCount,
        `findUsagesForSymbolIdFromCache should return every call site under a sufficient limit; got ${wide!.length} expected >=${callCount}`,
      );

      // 2) An explicit small limit still pins the result count.
      const trimmed = await api.callGraph.findUsagesForSymbolIdFromCache(fn!.id, 7);
      assert.ok(trimmed, 'expected cache lookup to return a non-undefined slice for an explicit small limit');
      assert.ok(
        trimmed!.length <= 7,
        `explicit small limit must clamp the result; got ${trimmed!.length} for limit=7`,
      );

      // 3) The default behaviour of findUsages() also respects an
      // explicitly passed limit higher than the old 500.
      const sync = api.callGraph.findUsages(fn!.qualifiedName, 1000);
      assert.ok(
        sync.length > 500,
        `findUsages(limit=1000) should exceed the legacy 500 cap; got ${sync.length}`,
      );
    } finally {
      try { await vscode.workspace.fs.delete(target); } catch {}
      try { await vscode.workspace.fs.delete(consumer); } catch {}
      await restoreBackend();
    }
  });
});

function postJson(url: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postJsonMaybeEmpty(url: string, payload: unknown): Promise<any | undefined> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendStdioJson(child: ChildProcessWithoutNullStreams, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for stdio MCP response'));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) { return; }
      const line = buffer.slice(0, idx);
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`stdio MCP proxy exited before response: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  });
}
