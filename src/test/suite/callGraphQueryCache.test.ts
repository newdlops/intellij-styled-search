import * as assert from 'assert';
import * as vscode from 'vscode';
import { type CallGraphSymbol } from '../../callGraph';
import { type ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';
const RUST_NATIVE_WARNING = 'rust-native graph rebuild stores the primary graph in zoek-rs binary index; JS snapshot arrays are intentionally not materialized';

type TestCallGraph = Pick<ExtensionTestApi['callGraph'], 'resolveSymbolsResolved'> & {
  snapshot: unknown;
  cacheManifest: unknown;
  setRustSymbolQueryForTests(query: ((
    workspaceRoot: string,
    query: string,
    limit: number,
    options: { includeImplementationCounts: boolean; includeUsageCounts: boolean; timeoutMs?: number },
  ) => Promise<CallGraphSymbol[] | undefined>) | undefined): void;
  getRustSymbolQueryCacheStatsForTests(): { entries: number; retainedSymbols: number; generation: number; inFlight: number };
  invalidateRustSymbolQueryCacheForTests(): void;
};

async function getCallGraph(): Promise<TestCallGraph> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(extension, 'expected extension to be available');
  return (await extension.activate()).callGraph as unknown as TestCallGraph;
}

function symbol(id: string, count = 3): CallGraphSymbol {
  return {
    id,
    name: id,
    qualifiedName: `fixture.${id}`,
    kind: 'function',
    language: 'typescript',
    uri: `file:///fixture/${id}.ts`,
    relPath: `${id}.ts`,
    range: { startLine: 1, startColumn: 2, endLine: 3, endColumn: 4 },
    bodyRange: { startLine: 1, startColumn: 2, endLine: 5, endColumn: 6 },
    modifiers: ['abstract'],
    extendsNames: ['Base'],
    implementsNames: ['Contract'],
    usageCount: count,
    usageMustCount: count - 1,
    usageMayCount: 1,
    implementationCount: count + 1,
    implementationMustCount: count,
    implementationMayCount: 1,
  };
}

suite('Call graph Rust symbol query cache', () => {
  let graph: TestCallGraph;
  let priorSnapshot: unknown;
  let priorManifest: unknown;

  suiteSetup(async () => {
    graph = await getCallGraph();
    priorSnapshot = graph.snapshot;
    priorManifest = graph.cacheManifest;
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected fixture workspace folder');
    graph.snapshot = {
      workspaceRoot: folder.uri.fsPath,
      builtAtUnixMs: 101,
      symbols: [], edges: [], references: [], stats: {}, warnings: [RUST_NATIVE_WARNING],
    };
    graph.cacheManifest = { workspaceRoot: folder.uri.fsPath, builtAtUnixMs: 101 };
  });

  suiteTeardown(() => {
    graph.setRustSymbolQueryForTests(undefined);
    graph.snapshot = priorSnapshot;
    graph.cacheManifest = priorManifest;
  });

  test('bounds, clones, coalesces, separates options, and invalidates Rust symbol queries', async () => {
    let invocations = 0;
    let pendingResolve: ((value: CallGraphSymbol[] | undefined) => void) | undefined;
    let rejectNext = false;
    graph.setRustSymbolQueryForTests(async (_workspaceRoot, query, _limit, options) => {
      invocations++;
      if (rejectNext) {
        rejectNext = false;
        throw new Error('synthetic native query failure');
      }
      if (query === 'pending') {
        return new Promise<CallGraphSymbol[] | undefined>((resolve) => { pendingResolve = resolve; });
      }
      return [symbol(`${query}-${options.includeUsageCounts ? 'usage' : 'no-usage'}-${options.includeImplementationCounts ? 'impl' : 'no-impl'}`)];
    });

    const first = await graph.resolveSymbolsResolved('  stable  ', 5);
    const second = await graph.resolveSymbolsResolved('stable', 5);
    assert.deepStrictEqual(second, first, 'cached ordered symbol objects must be identical');
    assert.strictEqual(invocations, 1, 'identical requests should hit the completed cache');
    first[0].range.startLine = 99;
    first[0].modifiers!.push('interface');
    assert.deepStrictEqual(await graph.resolveSymbolsResolved('stable', 5), second, 'callers cannot mutate cached symbols');

    await graph.resolveSymbolsResolved('stable', 5, { includeUsageCounts: false });
    await graph.resolveSymbolsResolved('stable', 5, { includeImplementationCounts: true });
    assert.strictEqual(invocations, 3, 'effective count options must use distinct cache keys');

    for (let i = 0; i < 66; i++) {
      await graph.resolveSymbolsResolved(`capacity-${i}`, 1);
    }
    const bounded = graph.getRustSymbolQueryCacheStatsForTests();
    assert.ok(bounded.entries <= 64 && bounded.retainedSymbols <= 2_000, 'completed cache must remain within both budgets');
    const beforeEvictedLookup = invocations;
    await graph.resolveSymbolsResolved('stable', 5);
    assert.strictEqual(invocations, beforeEvictedLookup + 1, 'least-recently-used entries should recompute after eviction');

    const pendingA = graph.resolveSymbolsResolved('pending', 2);
    const pendingB = graph.resolveSymbolsResolved('pending', 2);
    assert.strictEqual(invocations, beforeEvictedLookup + 2, 'overlapping identical requests should launch one native query');
    assert.ok(pendingResolve, 'expected pending native query');
    pendingResolve!([symbol('pending')]);
    assert.deepStrictEqual(await pendingA, await pendingB, 'coalesced callers should receive complete equal ordered symbols');

    rejectNext = true;
    await assert.rejects(() => graph.resolveSymbolsResolved('fails', 1), /synthetic native query failure/);
    assert.strictEqual(graph.getRustSymbolQueryCacheStatsForTests().inFlight, 0, 'failed flights must be removed');
    await graph.resolveSymbolsResolved('fails', 1);

    const stale = graph.resolveSymbolsResolved('pending', 3);
    assert.ok(pendingResolve, 'expected invalidation-race native query');
    const resolveStale = pendingResolve!;
    graph.invalidateRustSymbolQueryCacheForTests();
    const current = graph.resolveSymbolsResolved('pending', 3);
    const resolveCurrent = pendingResolve!;
    assert.strictEqual(invocations, beforeEvictedLookup + 6, 'post-invalidation request must not join the stale flight');
    resolveStale([symbol('stale')]);
    await stale;
    resolveCurrent([symbol('current')]);
    assert.strictEqual((await current)[0].id, 'current', 'stale completion must not populate the new generation');
  });
});
