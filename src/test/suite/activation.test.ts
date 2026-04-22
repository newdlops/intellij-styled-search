import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not registered`);
  const api = await ext.activate();
  assert.ok(api, 'extension activate() returned no api');
  return api;
}

suite('Activation', () => {
  test('extension is present and activates', async function () {
    this.timeout(15_000);
    const api = await getApi();
    assert.ok(api.overlay, 'overlay was not exposed on ext.exports');
  });

  test('commands are registered', async () => {
    await getApi();
    const expected = [
      'intellijStyledSearch.searchInProject',
      'intellijStyledSearch.searchSelection',
      'intellijStyledSearch.reinject',
      'intellijStyledSearch.rebuildIndex',
      'intellijStyledSearch.switchEngine',
      'intellijStyledSearch.showZoektInfo',
      'intellijStyledSearch.explainZoektQuery',
      'intellijStyledSearch.diagnoseFileInIndex',
    ];
    const all = await vscode.commands.getCommands(true);
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `command ${cmd} not registered`);
    }
  });

  test('trigram index reaches ready state on fixture workspace', async function () {
    // Default engine is zoekt. A rebuild should make the Rust engine ready
    // without falling back to codesearch.
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.rebuildIndex();
    await overlay.waitForIndexReady(30_000);
    const result = await overlay.searchForTestsDetailed({
      query: 'class AlphaService:',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    assert.strictEqual(result.requestedEngine, 'zoekt');
    assert.strictEqual(result.effectiveEngine, 'zoekt');
  });

  test('renderer cancel does not kill background zoekt work', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as {
      cancelRunningProcesses: (reason?: string) => void;
    };
    const original = runtime.cancelRunningProcesses.bind(runtime);
    let cancelled = false;
    runtime.cancelRunningProcesses = () => {
      cancelled = true;
    };
    try {
      overlay.injectRendererEventForTests(JSON.stringify({
        type: 'cancel',
        __src: 'activation-test',
        __seq: 1,
      }));
      assert.strictEqual(cancelled, false, 'cancel should not stop background zoekt indexing');
    } finally {
      runtime.cancelRunningProcesses = original;
    }
  });

  test('search readiness does not start a second index while rebuild is running', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalHasReadyIndex = runtime.hasReadyIndex.bind(runtime);
    const pending = new Promise<boolean>(() => {});

    runtime.foregroundIndexPromises.set(workspaceRoot, pending);
    runtime.resolveBinary = async () => '/tmp/zoek-rs';
    runtime.hasReadyIndex = async () => false;

    try {
      const readiness = await runtime.getSearchReadiness();
      assert.deepStrictEqual(readiness, {
        ready: false,
        reason: 'zoek-rs index build in progress',
      });
    } finally {
      runtime.resolveBinary = originalResolveBinary;
      runtime.hasReadyIndex = originalHasReadyIndex;
      runtime.foregroundIndexPromises.delete(workspaceRoot);
    }
  });

  test('scoped process cancellation only targets the requested kind', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const originalTerminate = runtime.terminateTrackedChild.bind(runtime);
    const originalSweep = runtime.sweepExternalZoektProcesses.bind(runtime);
    const originalChildren = runtime.activeChildren;
    const cancelled: string[] = [];
    let swept: string[] | null = null;

    runtime.activeChildren = new Map([
      [1, { child: { pid: 101 }, id: 1, label: 'zoek-rs search', kind: 'search', cancelled: false, killTimer: undefined }],
      [2, { child: { pid: 102 }, id: 2, label: 'zoek-rs index', kind: 'index', cancelled: false, killTimer: undefined }],
    ]);
    runtime.terminateTrackedChild = (tracked: { label: string }) => {
      cancelled.push(tracked.label);
    };
    runtime.sweepExternalZoektProcesses = async (_reason: string, patterns: string[]) => {
      swept = patterns;
    };

    try {
      runtime.cancelRunningProcesses('test-scope', { kinds: ['search'] });
      assert.deepStrictEqual(cancelled, ['zoek-rs search']);
      assert.deepStrictEqual(swept, ['zoek-rs-search']);
    } finally {
      runtime.activeChildren = originalChildren;
      runtime.terminateTrackedChild = originalTerminate;
      runtime.sweepExternalZoektProcesses = originalSweep;
    }
  });

  test('resolveBinary treats failed cargo build as unavailable runtime', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const originalInvokeText = runtime.invokeText.bind(runtime);
    const originalCandidates = runtime.getBinaryCandidates.bind(runtime);
    const originalBinaryPath = runtime.binaryPath;
    const originalBuildPromise = runtime.buildPromise;

    runtime.binaryPath = undefined;
    runtime.buildPromise = undefined;
    runtime.getBinaryCandidates = () => [
      '/definitely/missing/zoek-rs-a',
      '/definitely/missing/zoek-rs-b',
    ];
    runtime.invokeText = async () => ({
      stdout: '',
      stderr: 'cargo failed',
      code: 1,
      signal: null,
      cancelled: false,
    });

    try {
      const binary = await runtime.resolveBinary(true);
      assert.strictEqual(binary, null);
    } finally {
      runtime.invokeText = originalInvokeText;
      runtime.getBinaryCandidates = originalCandidates;
      runtime.binaryPath = originalBinaryPath;
      runtime.buildPromise = originalBuildPromise;
    }
  });

  test('rebuildIndex starts a dedicated rebuild after cancelling background index', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalCancelRunningProcesses = runtime.cancelRunningProcesses.bind(runtime);
    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    const pending = Promise.resolve(false);
    const cancellations: Array<{ reason: string; kinds?: string[] }> = [];
    let invokedArgs: string[] | undefined;

    runtime.indexPromises.set(workspaceRoot, pending);
    runtime.cancelRunningProcesses = (reason: string, options?: { kinds?: string[] }) => {
      cancellations.push({ reason, kinds: options?.kinds });
    };
    runtime.resolveBinary = async (_allowBuild: boolean, target?: string) => {
      return target === 'rebuild' ? '/tmp/ijss-rebuild' : '/tmp/zoek-rs';
    };
    runtime.invokeJson = async (args: string[]) => {
      invokedArgs = args;
      return {
        type: 'index',
        ok: true,
        stats: { indexedFiles: 1, shardCount: 1, totalGrams: 1 },
        warnings: [],
      };
    };
    try {
      const result = await runtime.rebuildIndex();
      assert.strictEqual(result, true);
      assert.deepStrictEqual(cancellations, [
        { reason: 'explicit rebuild requested', kinds: ['index'] },
      ]);
      assert.deepStrictEqual(invokedArgs, ['/tmp/ijss-rebuild', workspaceRoot]);
    } finally {
      runtime.indexPromises.delete(workspaceRoot);
      runtime.cancelRunningProcesses = originalCancelRunningProcesses;
      runtime.resolveBinary = originalResolveBinary;
      runtime.invokeJson = originalInvokeJson;
    }
  });

  test('background index consumes stderr progress lines', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    let onStderrLine: ((line: string) => boolean | void) | undefined;

    runtime.resolveBinary = async () => '/tmp/zoek-rs';
    runtime.invokeJson = async (_args: string[], _token: unknown, hooks?: { onStderrLine?: (line: string) => boolean | void }) => {
      onStderrLine = hooks?.onStderrLine;
      return {
        type: 'index',
        ok: true,
        stats: { indexedFiles: 1, shardCount: 1, totalGrams: 1 },
        warnings: [],
      };
    };

    try {
      const result = await runtime.ensureIndexed(workspaceRoot, 'activation-test');
      assert.strictEqual(result, true);
      assert.ok(onStderrLine, 'expected background index to pass a stderr progress hook');
      assert.strictEqual(
        onStderrLine?.('__ZOEK_PROGRESS__{"phase":"scan","current":128,"total":1024,"percent":9,"detail":"scanning files 128/1024"}'),
        true,
      );
    } finally {
      runtime.resolveBinary = originalResolveBinary;
      runtime.invokeJson = originalInvokeJson;
      runtime.indexPromises.delete(workspaceRoot);
    }
  });

  test('rebuildIndex uses the dedicated rebuild process kind', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    assert.strictEqual(runtime.classifyChild('/tmp/ijss-rebuild', []), 'rebuild');
    assert.strictEqual(runtime.argv0ForKind('rebuild'), 'ijss-rebuild');
  });

  test('parseIndexProgressLine reads stderr progress events', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const parsed = runtime.parseIndexProgressLine(
      '__ZOEK_PROGRESS__{"phase":"scan","current":128,"total":1024,"percent":9,"detail":"scanning files 128/1024"}',
    );
    assert.deepStrictEqual(parsed, {
      phase: 'scan',
      current: 128,
      total: 1024,
      percent: 9,
      detail: 'scanning files 128/1024',
    });
  });

  test('getRelativePath ignores internal zoekt index directories', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, '.zoek-rs'))),
      null,
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, '.zoek-rs', 'overlay-journal.jsonl'))),
      null,
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, '.zoekt-rs', 'overlay-journal.jsonl'))),
      null,
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, 'nested', '.zoek-rs', 'hot-overlay.json'))),
      null,
    );
  });

  test('zoekt searches skip trigram candidate planning', async () => {
    const { overlay } = await getApi();
    const anyOverlay = overlay as any;
    const originalGetSearchReadiness = anyOverlay.zoektRuntime.getSearchReadiness.bind(anyOverlay.zoektRuntime);
    const originalCandidatesFor = anyOverlay.trigramIndex.candidatesFor.bind(anyOverlay.trigramIndex);
    const originalPostToRenderer = anyOverlay.postToRenderer.bind(anyOverlay);
    const originalRunSearchPage = anyOverlay.runSearchPage.bind(anyOverlay);
    let candidateCalls = 0;
    let effectiveEngine: string | undefined;

    anyOverlay.zoektRuntime.getSearchReadiness = async () => ({ ready: true });
    anyOverlay.trigramIndex.candidatesFor = () => {
      candidateCalls += 1;
      return { uris: null, reason: 'index-not-ready' };
    };
    anyOverlay.postToRenderer = async () => {};
    anyOverlay.runSearchPage = async (session: { effectiveEngine: string }) => {
      effectiveEngine = session.effectiveEngine;
    };

    try {
      await anyOverlay.runSearch({
        query: 'class AlphaService:',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      assert.strictEqual(effectiveEngine, 'zoekt');
      assert.strictEqual(candidateCalls, 0, 'zoekt search should not consult the codesearch trigram planner');
    } finally {
      anyOverlay.zoektRuntime.getSearchReadiness = originalGetSearchReadiness;
      anyOverlay.trigramIndex.candidatesFor = originalCandidatesFor;
      anyOverlay.postToRenderer = originalPostToRenderer;
      anyOverlay.runSearchPage = originalRunSearchPage;
    }
  });
});
