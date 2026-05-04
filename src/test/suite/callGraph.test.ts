import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import {
  buildCallGraphEdgeFileMatches,
  buildCallGraphImplementationFileMatches,
  buildCallGraphQuickPickItems,
  buildCallGraphUsageFileMatches,
  formatCallGraphProgressMessage,
  type ExtensionTestApi,
} from '../../extension';

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

suite('Call graph', () => {
  test('indexes Python and JavaScript symbols with caller/callee edges', async function () {
    this.timeout(30_000);
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const py = vscode.Uri.joinPath(folder.uri, 'callgraph_fixture.py');
    const savePy = vscode.Uri.joinPath(folder.uri, 'callgraph_save_fixture.py');
    const js = vscode.Uri.joinPath(folder.uri, 'callgraph_fixture.js');
    const java = vscode.Uri.joinPath(folder.uri, 'CallGraphFixture.java');
    const kt = vscode.Uri.joinPath(folder.uri, 'CallGraphFixture.kt');
    try {
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
      assert.ok(progressEvents.some((event) => event.stage === 'parsing'), 'expected parsing progress events');
      assert.ok(progressEvents.some((event) => event.stage === 'done'), 'expected done progress event');
      assert.ok(progressEvents.some((event) => event.concurrency >= 1), 'expected progress to include worker count');
      assert.ok(snapshot.stats.parseConcurrency >= 1, 'expected snapshot stats to include parse concurrency');
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
      });
      assert.ok(progressMessage.includes('3/10'), 'expected progress message to include count');
      assert.ok(progressMessage.includes('workers=8'), 'expected progress message to include worker count');
      const names = snapshot.symbols.map((symbol) => symbol.qualifiedName);
      assert.ok(names.includes('GraphPy.root'), 'expected Python method symbol');
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
      try { await vscode.workspace.fs.delete(py); } catch {}
      try { await vscode.workspace.fs.delete(savePy); } catch {}
      try { await vscode.workspace.fs.delete(js); } catch {}
      try { await vscode.workspace.fs.delete(java); } catch {}
      try { await vscode.workspace.fs.delete(kt); } catch {}
      await api.callGraph.rebuild();
    }
  });

  test('counts exported API and import/export references as usages', async function () {
    this.timeout(10_000);
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
      await api.callGraph.rebuild();
    }
  });

  test('resolves Python service method usages through constructed receivers', async function () {
    this.timeout(10_000);
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
      await api.callGraph.rebuild();
    }
  });

  test('links interface and abstract implementations', async function () {
    this.timeout(30_000);
    const api = await getApi();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    const ts = vscode.Uri.joinPath(folder.uri, 'callgraph_impl_fixture.ts');
    try {
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
      try { await vscode.workspace.fs.delete(ts); } catch {}
      await api.callGraph.rebuild();
    }
  });

  test('serves MCP tools/list over the local JSON-RPC endpoint', async function () {
    this.timeout(10_000);
    const api = await getApi();
    try {
      const url = await api.mcpServer.start(0);
      const response = await postJson(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });
      assert.strictEqual(response.jsonrpc, '2.0');
      assert.strictEqual(response.id, 1);
      const tools = response.result?.tools;
      assert.ok(Array.isArray(tools), 'expected tools/list to return a tools array');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'get_callers'), 'expected get_callers tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'get_implementations'), 'expected get_implementations tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'get_usages'), 'expected get_usages tool');
      assert.ok(tools.some((tool: { name?: string }) => tool.name === 'get_context_bundle'), 'expected get_context_bundle tool');
    } finally {
      api.mcpServer.stop();
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
