import * as assert from 'assert';
import * as fs from 'fs';
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

  test('e2e launch config isolates the test VS Code main inspector', () => {
    const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not registered`);
    const configPath = path.join(ext.extensionPath, '.vscode-test.mjs');
    const configText = fs.readFileSync(configPath, 'utf8');
    assert.match(
      configText,
      /launchArgs:\s*\[[^\]]*['"]--inspect=9239['"]/,
      'e2e must launch the test VS Code main process on an inspector port separate from the developer VS Code default 9229',
    );
    assert.doesNotMatch(
      configText,
      /launchArgs:\s*\[[^\]]*['"]--inspect=9229['"]/,
      'e2e must not reuse the default Node inspector port',
    );
  });

  test('commands are registered', async () => {
    const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
    await getApi();
    const expected = [
      'intellijStyledSearch.searchInProject',
      'intellijStyledSearch.searchSelection',
      'intellijStyledSearch.reinject',
      'intellijStyledSearch.installZoektBinary',
      'intellijStyledSearch.rebuildIndex',
      'intellijStyledSearch.switchEngine',
      'intellijStyledSearch.showZoektInfo',
      'intellijStyledSearch.explainZoektQuery',
      'intellijStyledSearch.diagnoseFileInIndex',
      'intellijStyledSearch.rebuildCallGraph',
      'intellijStyledSearch.forceRebuildCallGraph',
      'intellijStyledSearch.showCallGraphInfo',
      'intellijStyledSearch.findCallers',
      'intellijStyledSearch.findCallees',
      'intellijStyledSearch.findImplementations',
      'intellijStyledSearch.findUsages',
      'intellijStyledSearch.startMcpServer',
      'intellijStyledSearch.stopMcpServer',
    ];
    const all = await vscode.commands.getCommands(true);
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `command ${cmd} not registered`);
    }
    const contributes = ext?.packageJSON?.contributes;
    const submenu = contributes?.submenus?.find((item: { id?: string }) => item.id === 'intellijStyledSearch.editorContext');
    assert.ok(submenu, 'IntelliJ Search editor context submenu not contributed');
    const submenuCommands = (contributes?.menus?.['intellijStyledSearch.editorContext'] ?? [])
      .map((item: { command?: string }) => item.command)
      .filter(Boolean);
    const expectedInSubmenu = expected.filter((cmd) => cmd !== 'intellijStyledSearch.findCallers');
    for (const cmd of expectedInSubmenu) {
      assert.ok(
        submenuCommands.includes(cmd),
        `command ${cmd} not present in IntelliJ Search editor context submenu`,
      );
    }
    assert.ok(
      !submenuCommands.includes('intellijStyledSearch.findCallers'),
      'findCallers should be hidden from the context submenu because callers are folded into usages',
    );
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

  test('call graph pause cancels in-flight zoekt indexing', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const original = runtime.cancelRunningProcesses.bind(runtime);
    const calls: Array<{ reason: string; kinds?: string[] }> = [];
    runtime.cancelRunningProcesses = (reason: string, options?: { kinds?: string[] }) => {
      calls.push({ reason, kinds: options?.kinds });
    };
    try {
      const pause = runtime.pauseFileUpdates('call graph rebuild', { cancelIndexing: true });
      pause.dispose();
      assert.deepStrictEqual(calls, [{
        reason: 'paused file updates: call graph rebuild',
        kinds: ['update', 'index', 'rebuild'],
      }]);
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

  test('external zoekt process sweep is scoped to the exact workspace root', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const projectRoot = path.resolve(workspaceRoot, '..', '..', '..');
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update ${workspaceRoot} docs.md`, workspaceRoot),
      true,
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update "${workspaceRoot}" docs.md`, workspaceRoot),
      true,
      'quoted workspace root should still count as the exact target argument',
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update '${workspaceRoot}' docs.md`, workspaceRoot),
      true,
      'single-quoted workspace root should still count as the exact target argument',
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update ${projectRoot} out/extension.js`, workspaceRoot),
      false,
      'e2e fixture sweep must not kill the developer VS Code workspace indexer',
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update --workspace=${workspaceRoot} docs.md`, workspaceRoot),
      false,
      'workspace root must be a full command argument, not part of a flag value',
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update ${workspaceRoot}-copy docs.md`, workspaceRoot),
      false,
      'workspace root must match as a full command argument',
    );
    assert.strictEqual(
      runtime.commandTargetsWorkspaceRoot(`zoek-rs-update update ${path.join(workspaceRoot, 'nested')} docs.md`, workspaceRoot),
      false,
      'workspace root prefix is not enough; nested workspaces are separate targets',
    );
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

  test('installBinary builds both zoekt runtime binaries when missing', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const calls: Array<{ allowBuild: boolean; target: string }> = [];
    const progress: string[] = [];

    runtime.resolveBinary = async (allowBuild: boolean, target: string = 'engine') => {
      calls.push({ allowBuild, target });
      if (!allowBuild) { return null; }
      return target === 'rebuild' ? '/tmp/ijss-rebuild' : '/tmp/zoek-rs';
    };

    try {
      const result = await runtime.installBinary((message: string) => progress.push(message));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.alreadyInstalled, false);
      assert.strictEqual(result.engineBinary, '/tmp/zoek-rs');
      assert.strictEqual(result.rebuildBinary, '/tmp/ijss-rebuild');
      assert.deepStrictEqual(calls, [
        { allowBuild: false, target: 'engine' },
        { allowBuild: false, target: 'rebuild' },
        { allowBuild: true, target: 'engine' },
        { allowBuild: true, target: 'rebuild' },
      ]);
      assert.ok(progress.includes('building zoek-rs binaries with Cargo'));
      assert.ok(progress.includes('zoek-rs binaries ready'));
    } finally {
      runtime.resolveBinary = originalResolveBinary;
    }
  });

  test('installBinary reports missing Rust/Cargo toolchain clearly', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const originalInvokeText = runtime.invokeText.bind(runtime);
    const originalGetBinaryCandidates = runtime.getBinaryCandidates.bind(runtime);
    const originalGetBinaryCandidatesFor = runtime.getBinaryCandidatesFor.bind(runtime);
    const originalBinaryPath = runtime.binaryPath;
    const originalRebuildBinaryPath = runtime.rebuildBinaryPath;
    const originalBuildPromise = runtime.buildPromise;

    runtime.binaryPath = undefined;
    runtime.rebuildBinaryPath = undefined;
    runtime.buildPromise = undefined;
    runtime.binaryCompatibility?.clear?.();
    runtime.getBinaryCandidates = () => ['/definitely/missing/zoek-rs'];
    runtime.getBinaryCandidatesFor = (target: string) => [
      target === 'rebuild' ? '/definitely/missing/ijss-rebuild' : '/definitely/missing/zoek-rs',
    ];
    runtime.invokeText = async () => {
      const err = new Error('spawn cargo ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };

    try {
      const result = await runtime.installBinary();
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.requiresCargoToolchain, true);
      assert.match(result.message ?? '', /Rust\/Cargo toolchain is not installed or not on PATH/);
      assert.match(result.message ?? '', /https:\/\/rustup\.rs\//);
    } finally {
      runtime.invokeText = originalInvokeText;
      runtime.getBinaryCandidates = originalGetBinaryCandidates;
      runtime.getBinaryCandidatesFor = originalGetBinaryCandidatesFor;
      runtime.binaryPath = originalBinaryPath;
      runtime.rebuildBinaryPath = originalRebuildBinaryPath;
      runtime.buildPromise = originalBuildPromise;
      runtime.binaryCompatibility?.clear?.();
    }
  });

  test('resolveBinary skips stale zoek-rs binaries that do not support required capabilities', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');
    const staleBinary = path.join(workspaceRoot, '.tmp-stale-zoek-rs');
    const oldBinary = path.join(workspaceRoot, '.tmp-old-zoek-rs');
    const freshBinary = path.join(workspaceRoot, '.tmp-fresh-zoek-rs');
    const originalInvokeText = runtime.invokeText.bind(runtime);
    const originalCandidates = runtime.getBinaryCandidates.bind(runtime);
    const originalBinaryPath = runtime.binaryPath;
    const originalBuildPromise = runtime.buildPromise;

    fs.writeFileSync(staleBinary, '');
    fs.writeFileSync(oldBinary, '');
    fs.writeFileSync(freshBinary, '');
    runtime.binaryPath = undefined;
    runtime.buildPromise = undefined;
    runtime.binaryCompatibility?.clear?.();
    runtime.getBinaryCandidates = () => [staleBinary, oldBinary, freshBinary];
    runtime.invokeText = async (args: string[]) => {
      if (args[0] === staleBinary) {
        return {
          stdout: '{"type":"error","ok":false,"message":"unknown diagnose flag: --exclude"}',
          stderr: '',
          code: 0,
          signal: null,
          cancelled: false,
        };
      }
      if (args[0] === oldBinary && args[1] === 'capabilities') {
        return {
          stdout: '{"type":"error","ok":false,"message":"unknown command"}',
          stderr: '',
          code: 0,
          signal: null,
          cancelled: false,
        };
      }
      if (args[1] === 'capabilities') {
        return {
          stdout: '{"type":"capabilities","ok":true,"engine":{"name":"zoek-rs","protocolVersion":2,"schemaVersion":3},"optimizedCandidateLoading":true,"virtualIndexBenchmark":true,"incompleteDocSentinel":true,"maxFilesPerShard":50000}',
          stderr: '',
          code: 0,
          signal: null,
          cancelled: false,
        };
      }
      return {
        stdout: '{"type":"diagnose","ok":true}',
        stderr: '',
        code: 0,
        signal: null,
        cancelled: false,
      };
    };

    try {
      const binary = await runtime.resolveBinary(false);
      assert.strictEqual(binary, freshBinary);
    } finally {
      runtime.invokeText = originalInvokeText;
      runtime.getBinaryCandidates = originalCandidates;
      runtime.binaryPath = originalBinaryPath;
      runtime.buildPromise = originalBuildPromise;
      runtime.binaryCompatibility?.clear?.();
      try { fs.unlinkSync(staleBinary); } catch {}
      try { fs.unlinkSync(oldBinary); } catch {}
      try { fs.unlinkSync(freshBinary); } catch {}
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
      assert.deepStrictEqual(invokedArgs, ['/tmp/ijss-rebuild', workspaceRoot, '--force']);
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

  test('call graph rust queries use tracked process metadata and timeouts', async () => {
    const { callGraph } = await getApi();
    const service = callGraph as any;
    assert.strictEqual(service.classifyRustGraphProcess(['build', '-q', '-p', 'zoek-rs']), 'build');
    assert.strictEqual(
      service.argv0ForRustGraphProcess('build'),
      undefined,
      'cargo/rustup proxy must keep argv0 as cargo; rustup rejects custom proxy names',
    );
    assert.strictEqual(service.classifyRustGraphProcess(['graph-symbol-query']), 'graph-symbol-query');
    assert.strictEqual(service.argv0ForRustGraphProcess('graph-symbol-query'), 'ijss-rust-graph-symbol-query');
    assert.strictEqual(service.defaultRustGraphTimeoutMs('graph-symbol-query'), 30_000);
    assert.strictEqual(service.defaultRustGraphTimeoutMs('graph-rebuild'), 0);
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

  test('getRelativePath ignores zoekt internals but keeps git target and node_modules', async () => {
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
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, '.git', 'HEAD'))),
      '.git/HEAD',
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, 'target', 'debug', 'build.log'))),
      'target/debug/build.log',
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, 'node_modules', 'pkg', 'index.js'))),
      'node_modules/pkg/index.js',
    );
    assert.strictEqual(
      runtime.getRelativePath(vscode.Uri.file(path.join(workspaceRoot, 'nested', '.zoek-rs', 'hot-overlay.json'))),
      null,
    );
  });

  test('pending zoekt updates wait for an in-flight base refresh', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalHasReadyIndex = runtime.hasReadyIndex.bind(runtime);
    const originalScheduleFlush = runtime.scheduleFlush.bind(runtime);
    const pending = new Promise<boolean>(() => {});
    let retryDelay: number | undefined;

    runtime.pendingChanged.add('docs.md');
    runtime.indexPromises.set(workspaceRoot, pending);
    runtime.resolveBinary = async () => '/tmp/zoek-rs';
    runtime.hasReadyIndex = async () => true;
    runtime.scheduleFlush = (delay?: number) => {
      retryDelay = delay;
    };

    try {
      await runtime.flushPendingUpdates();
      assert.strictEqual(runtime.pendingChanged.has('docs.md'), true);
      assert.strictEqual(retryDelay, 1000);
    } finally {
      runtime.pendingChanged.clear();
      runtime.indexPromises.delete(workspaceRoot);
      runtime.resolveBinary = originalResolveBinary;
      runtime.hasReadyIndex = originalHasReadyIndex;
      runtime.scheduleFlush = originalScheduleFlush;
    }
  });

  test('rename crossing ignored zoekt dirs queues only the indexed side', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalScheduleFlush = runtime.scheduleFlush.bind(runtime);
    let flushes = 0;
    runtime.scheduleFlush = () => { flushes++; };

    try {
      runtime.queueRename(
        vscode.Uri.file(path.join(workspaceRoot, 'alpha.py')),
        vscode.Uri.file(path.join(workspaceRoot, '.zoek-rs', 'alpha.py')),
      );
      assert.strictEqual(runtime.pendingDeleted.has('alpha.py'), true);
      assert.strictEqual(runtime.pendingChanged.size, 0);

      runtime.pendingDeleted.clear();
      runtime.queueRename(
        vscode.Uri.file(path.join(workspaceRoot, '.zoek-rs', 'docs.md')),
        vscode.Uri.file(path.join(workspaceRoot, 'docs.md')),
      );
      assert.strictEqual(runtime.pendingChanged.has('docs.md'), true);
      assert.strictEqual(runtime.pendingDeleted.size, 0);
      assert.strictEqual(flushes, 2);
    } finally {
      runtime.pendingChanged.clear();
      runtime.pendingDeleted.clear();
      runtime.scheduleFlush = originalScheduleFlush;
    }
  });

  test('large overlay update starts a background base refresh', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalHasReadyIndex = runtime.hasReadyIndex.bind(runtime);
    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    const invoked: string[][] = [];

    runtime.pendingChanged.add('docs.md');
    runtime.lastAutoBaseRefreshAt.delete(workspaceRoot);
    runtime.resolveBinary = async () => '/tmp/zoek-rs';
    runtime.hasReadyIndex = async () => true;
    runtime.invokeJson = async (args: string[]) => {
      invoked.push(args);
      if (args[1] === 'update') {
        return {
          type: 'update',
          ok: true,
          generation: 8,
          entriesWritten: 600,
          liveEntries: 590,
          tombstones: 10,
          overlayTotalEntries: 600,
          latestVisibleEntries: 600,
          journalBytes: 1024,
          compactionSuggested: true,
          warnings: [],
        };
      }
      if (args[1] === 'compact') {
        return {
          type: 'index',
          ok: true,
          stats: { indexedFiles: 10, shardCount: 1, totalGrams: 20 },
          warnings: [],
        };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };

    try {
      await runtime.flushPendingUpdates();
      assert.deepStrictEqual(invoked[0], ['/tmp/zoek-rs', 'update', workspaceRoot, 'docs.md']);
      assert.deepStrictEqual(invoked[1], ['/tmp/zoek-rs', 'compact', workspaceRoot]);
      const refresh = runtime.indexPromises.get(workspaceRoot);
      if (refresh) {
        await refresh;
      }
    } finally {
      runtime.pendingChanged.clear();
      runtime.indexPromises.delete(workspaceRoot);
      runtime.lastAutoBaseRefreshAt.delete(workspaceRoot);
      runtime.resolveBinary = originalResolveBinary;
      runtime.hasReadyIndex = originalHasReadyIndex;
      runtime.invokeJson = originalInvokeJson;
    }
  });

  test('workspace sync invokes zoekt update --sync when git state is dirty', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    const invoked: string[][] = [];

    runtime.workspaceSyncNeeded = true;
    runtime.lastWorkspaceSyncAt.delete(workspaceRoot);
    runtime.invokeJson = async (args: string[]) => {
      invoked.push(args);
      return {
        type: 'update',
        ok: true,
        generation: 9,
        entriesWritten: 2,
        liveEntries: 1,
        tombstones: 1,
        overlayTotalEntries: 2,
        latestVisibleEntries: 2,
        journalBytes: 128,
        compactionSuggested: false,
        warnings: [],
      };
    };

    try {
      await runtime.syncWorkspaceIndexIfNeeded(workspaceRoot, '/tmp/zoek-rs', 'test');
      assert.deepStrictEqual(invoked, [['/tmp/zoek-rs', 'update', workspaceRoot, '--sync']]);
      assert.strictEqual(runtime.workspaceSyncNeeded, false);
      const syncedAt = runtime.lastWorkspaceSyncAt.get(workspaceRoot);
      assert.ok(typeof syncedAt === 'number' && syncedAt > 0);
    } finally {
      runtime.workspaceSyncNeeded = false;
      runtime.lastWorkspaceSyncAt.delete(workspaceRoot);
      runtime.invokeJson = originalInvokeJson;
    }
  });

  test('workspace sync reruns immediately when git branch state changes', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    const originalReadGitState = runtime.readGitState.bind(runtime);
    const invoked: string[][] = [];
    let gitState = 'HEAD ref: refs/heads/main\nREF aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    runtime.workspaceSyncNeeded = false;
    runtime.lastGitState.delete(workspaceRoot);
    runtime.lastWorkspaceSyncAt.delete(workspaceRoot);
    runtime.readGitState = async () => gitState;
    runtime.invokeJson = async (args: string[]) => {
      invoked.push(args);
      return {
        type: 'update',
        ok: true,
        generation: invoked.length,
        entriesWritten: 1,
        liveEntries: 1,
        tombstones: 0,
        overlayTotalEntries: invoked.length,
        latestVisibleEntries: invoked.length,
        journalBytes: 128,
        compactionSuggested: false,
        warnings: [],
      };
    };

    try {
      await runtime.syncWorkspaceIndexIfNeeded(workspaceRoot, '/tmp/zoek-rs', 'initial-search');
      await runtime.syncWorkspaceIndexIfNeeded(workspaceRoot, '/tmp/zoek-rs', 'same-branch');
      gitState = 'HEAD ref: refs/heads/feature\nREF bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await runtime.syncWorkspaceIndexIfNeeded(workspaceRoot, '/tmp/zoek-rs', 'branch-change');

      assert.deepStrictEqual(invoked, [
        ['/tmp/zoek-rs', 'update', workspaceRoot, '--sync'],
        ['/tmp/zoek-rs', 'update', workspaceRoot, '--sync'],
      ]);
      assert.strictEqual(runtime.workspaceSyncNeeded, false);
      assert.strictEqual(runtime.lastGitState.get(workspaceRoot), gitState);
    } finally {
      runtime.workspaceSyncNeeded = false;
      runtime.lastGitState.delete(workspaceRoot);
      runtime.lastWorkspaceSyncAt.delete(workspaceRoot);
      runtime.invokeJson = originalInvokeJson;
      runtime.readGitState = originalReadGitState;
    }
  });

  test('zoekt search starts within budget when workspace sync is slow', async () => {
    const { overlay } = await getApi();
    const runtime = (overlay as any).zoektRuntime as any;
    const workspaceRoot = runtime.getWorkspaceRootPath();
    assert.ok(workspaceRoot, 'expected fixture workspace folder');

    const originalGetSearchReadiness = runtime.getSearchReadiness.bind(runtime);
    const originalResolveBinary = runtime.resolveBinary.bind(runtime);
    const originalHasPendingUpdates = runtime.hasPendingUpdates.bind(runtime);
    const originalSyncWorkspaceIndexIfNeeded = runtime.syncWorkspaceIndexIfNeeded.bind(runtime);
    const originalInvokeJson = runtime.invokeJson.bind(runtime);
    let resolveSync!: () => void;
    const slowSync = new Promise<void>((resolve) => { resolveSync = resolve; });
    let searchInvokedAt = 0;

    runtime.getSearchReadiness = async () => ({ ready: true });
    runtime.resolveBinary = async () => '/tmp/zoek-rs';
    runtime.hasPendingUpdates = () => false;
    runtime.syncWorkspaceIndexIfNeeded = async () => slowSync;
    runtime.invokeJson = async () => {
      searchInvokedAt = Date.now();
      return {
        type: 'search',
        ok: true,
        engine: { name: 'zoek-rs', protocolVersion: 2, schemaVersion: 3 },
        queryMode: 'literal',
        totalFilesScanned: 0,
        totalFilesMatched: 0,
        totalMatches: 0,
        truncated: false,
        warnings: [],
        files: [],
      };
    };

    try {
      const startedAt = Date.now();
      const cts = new vscode.CancellationTokenSource();
      const result = await runtime.runSearch({
        query: 'SlowSyncNeedle',
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      }, cts.token, {
        onFile: () => {},
        onDone: () => {},
        onError: (err: Error) => { throw err; },
      });
      assert.strictEqual(result.ready, true);
      assert.ok(searchInvokedAt > 0, 'expected search engine invocation');
      assert.ok(
        searchInvokedAt - startedAt < 2_000,
        `search should not wait for the full workspace sync; waited ${searchInvokedAt - startedAt}ms`,
      );
    } finally {
      resolveSync();
      await slowSync;
      runtime.getSearchReadiness = originalGetSearchReadiness;
      runtime.resolveBinary = originalResolveBinary;
      runtime.hasPendingUpdates = originalHasPendingUpdates;
      runtime.syncWorkspaceIndexIfNeeded = originalSyncWorkspaceIndexIfNeeded;
      runtime.invokeJson = originalInvokeJson;
    }
  });

  test('preview requests use a 20ms Monaco warmup budget and refresh when ready', async () => {
    const { overlay } = await getApi();
    const anyOverlay = overlay as any;
    const originalActiveWindowId = anyOverlay.activeWindowId;
    const originalIsMonacoCaptureEnabled = anyOverlay.isMonacoCaptureEnabled.bind(anyOverlay);
    const originalEnsureMonacoCapture = anyOverlay.ensureMonacoCapture.bind(anyOverlay);
    const originalIsMonacoReadyInWindow = anyOverlay.isMonacoReadyInWindow.bind(anyOverlay);
    const originalSendPreview = anyOverlay.sendPreview.bind(anyOverlay);
    const originalReleasePreviewCaptureTabsSoon = anyOverlay.releasePreviewCaptureTabsSoon.bind(anyOverlay);
    const originalScheduleCdpSearchIdleClose = anyOverlay.scheduleCdpSearchIdleClose.bind(anyOverlay);
    const originalCancelCdpSearchIdleClose = anyOverlay.cancelCdpSearchIdleClose.bind(anyOverlay);
    const originalLspPressure = anyOverlay.lspPressure;
    const previewUri = 'file:///preview-warmup-budget.py';
    const previewSeq = 42;
    let resolveWarmup: (() => void) | undefined;
    const warmupPromise = new Promise<void>((resolve) => { resolveWarmup = resolve; });
    const sends: Array<{ at: number; args: unknown[] }> = [];
    const captureCalls: unknown[][] = [];

    anyOverlay.activeWindowId = 7;
    anyOverlay.isMonacoCaptureEnabled = () => true;
    anyOverlay.lspPressure = {
      snapshot: () => ({ active: false, until: 0, delayMs: 0, reason: '', tokens: 1, diagnosticsBurstCount: 0 }),
    };
    anyOverlay.ensureMonacoCapture = async (...args: unknown[]) => {
      captureCalls.push(args);
      return warmupPromise;
    };
    anyOverlay.isMonacoReadyInWindow = async () => true;
    anyOverlay.sendPreview = async (...args: unknown[]) => {
      sends.push({ at: Date.now(), args });
    };
    anyOverlay.releasePreviewCaptureTabsSoon = () => {};
    anyOverlay.scheduleCdpSearchIdleClose = () => {};
    anyOverlay.cancelCdpSearchIdleClose = () => {};

    try {
      const started = Date.now();
      await anyOverlay.handlePreviewRequest({
        type: 'requestPreview',
        uri: previewUri,
        line: 3,
        ranges: [{ start: 0, end: 5 }],
        contextLines: 0,
        previewSeq,
      });
      const targetSends = () => sends.filter((send) => send.args[0] === previewUri && send.args[4] === previewSeq);
      assert.strictEqual(targetSends().length, 1, 'preview should render once when Monaco warmup exceeds the budget');
      assert.strictEqual(captureCalls.length, 1, 'preview should attempt Monaco warmup once');
      assert.strictEqual(captureCalls[0]?.[1], undefined, 'preview warmup should not pass a force-open URI');
      assert.strictEqual(
        (captureCalls[0]?.[2] as { allowForceOpen?: boolean } | undefined)?.allowForceOpen,
        false,
        'preview warmup must not force-open an editor tab or column',
      );
      assert.ok(
        targetSends()[0]!.at - started < 80,
        `preview should not wait for full Monaco warmup; waited ${targetSends()[0]!.at - started}ms`,
      );
      resolveWarmup?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(targetSends().length, 2, 'preview should refresh after late Monaco warmup becomes ready');
      assert.deepStrictEqual(targetSends().map((send) => send.args[4]), [previewSeq, previewSeq]);
    } finally {
      anyOverlay.activeWindowId = originalActiveWindowId;
      anyOverlay.isMonacoCaptureEnabled = originalIsMonacoCaptureEnabled;
      anyOverlay.ensureMonacoCapture = originalEnsureMonacoCapture;
      anyOverlay.isMonacoReadyInWindow = originalIsMonacoReadyInWindow;
      anyOverlay.sendPreview = originalSendPreview;
      anyOverlay.releasePreviewCaptureTabsSoon = originalReleasePreviewCaptureTabsSoon;
      anyOverlay.scheduleCdpSearchIdleClose = originalScheduleCdpSearchIdleClose;
      anyOverlay.cancelCdpSearchIdleClose = originalCancelCdpSearchIdleClose;
      anyOverlay.lspPressure = originalLspPressure;
    }
  });

  test('rapid preview requests are coalesced before fetching preview content', async () => {
    const { overlay } = await getApi();
    const anyOverlay = overlay as any;
    const originalSendPreview = anyOverlay.sendPreview.bind(anyOverlay);
    const originalIsMonacoCaptureEnabled = anyOverlay.isMonacoCaptureEnabled.bind(anyOverlay);
    const calls: unknown[][] = [];
    const src = `activation-preview-coalesce-${Date.now()}`;

    anyOverlay.isMonacoCaptureEnabled = () => false;
    anyOverlay.sendPreview = async (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      for (let i = 0; i < 24; i++) {
        overlay.injectRendererEventForTests(JSON.stringify({
          type: 'requestPreview',
          uri: `file:///tmp/ijss-preview-coalesce-${i % 3}.ts`,
          line: i,
          contextLines: 0,
          previewSeq: i,
          __src: src,
          __seq: i + 1,
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.strictEqual(calls.length, 1, `rapid preview requests should fetch only the latest preview; calls=${JSON.stringify(calls)}`);
      assert.strictEqual(calls[0]?.[0], 'file:///tmp/ijss-preview-coalesce-2.ts');
      assert.strictEqual(calls[0]?.[1], 23);
      assert.strictEqual(calls[0]?.[4], 23);
    } finally {
      anyOverlay.sendPreview = originalSendPreview;
      anyOverlay.isMonacoCaptureEnabled = originalIsMonacoCaptureEnabled;
    }
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

suite('Search performance budgets', () => {
  test('1000k zoekt simple word and 10k literal searches stay within budget', async function () {
    this.timeout(240_000);
    const { overlay } = await getApi();
    const response = await overlay.runZoektBenchmarkForTests([1_000_000], {
      profile: 'synthetic',
      searchOnly: true,
      virtualIndex: true,
    });
    assert.ok(response, 'expected zoek-rs benchmark response');
    const item = response.cases.find((candidate) => candidate.fileCount === 1_000_000);
    assert.ok(item, `expected 1000k benchmark case; got ${JSON.stringify(response.cases)}`);
    const simpleP95 = item.queryP95Ms;
    const longP95 = item.longQueryP95Ms ?? Number.POSITIVE_INFINITY;
    const longBytes = item.longQueryBytes ?? 0;
    console.log(
      `[zoek-e2e-perf] files=${item.fileCount} ` +
      `simpleP95=${simpleP95}ms longBytes=${longBytes} longP95=${longP95}ms`,
    );
    assert.ok(
      simpleP95 <= 100,
      `1000k simple word query p95 exceeded 100ms budget: ${simpleP95}ms`,
    );
    assert.ok(
      longBytes >= 10_000,
      `10k literal benchmark query should be at least 10000 bytes; got ${longBytes}`,
    );
    assert.ok(
      longP95 <= 20_000,
      `1000k 10k-literal query p95 exceeded 20s budget: ${longP95}ms`,
    );
  });
});
