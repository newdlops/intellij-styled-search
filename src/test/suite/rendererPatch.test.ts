import * as assert from 'assert';
import * as vm from 'vm';
import { getRendererPatchScript, RENDERER_PATCH_VERSION } from '../../rendererPatch';

suite('Renderer patch source', () => {
  test('emits syntactically valid JavaScript for bundled and captured preview modes', () => {
    const variants = [
      getRendererPatchScript(false, false, true, true, true, false, true),
      getRendererPatchScript(true, true, false, true, false, true, true),
    ];

    for (const script of variants) {
      assert.doesNotThrow(() => new vm.Script(script));
    }
  });

  test('does not auto-request hover or completion providers for preview diagnostics', () => {
    const script = getRendererPatchScript(true, true, true, true, true, true, true);

    assert.ok(
      !script.includes("type: 'requestIntellisenseProbe'"),
      'renderer diagnostics must not duplicate Monaco hover/completion provider requests',
    );
  });

  test('synchronizes the preview language feature flag on a retained same-version patch', () => {
    const context = {
      window: {
        __ijFindPatchVersion: RENDERER_PATCH_VERSION,
        __ijFindPatchedV100: true,
      } as Record<string, unknown>,
    };

    vm.runInNewContext(
      getRendererPatchScript(false, false, true, true, true, false, true),
      context,
    );
    assert.strictEqual(context.window.__ijFindEnablePreviewLanguageFeatures, true);

    vm.runInNewContext(
      getRendererPatchScript(false, false, true, true, true, false, false),
      context,
    );
    assert.strictEqual(context.window.__ijFindEnablePreviewLanguageFeatures, false);

    const enabledScript = getRendererPatchScript(false, false, true, true, true, false, true);
    assert.ok(
      enabledScript.includes('if (window.__ijFindEnablePreviewLanguageFeatures)'),
      'bundled provider registration must read the retained runtime flag',
    );
  });

  test('keeps bundled Monaco mouse hover alive across the Shadow DOM boundary', () => {
    const script = getRendererPatchScript(false, false, true, true, true, true, true);

    assert.ok(
      script.includes("shadowRoot.addEventListener('mousemove', handler, false)") &&
        script.includes('var handler = function (event) { event.stopPropagation(); }'),
      'the shadow boundary should stop Monaco\'s document monitor from misreading an internal move as mouseleave',
    );
    assert.ok(
      script.includes("boundary.root.removeEventListener('mousemove', boundary.handler, false)") &&
        script.includes('disposeStandaloneShadowMouseMoveBoundary();'),
      'the boundary listener should be removed when the bundled editor is disposed or creation fails',
    );
    assert.ok(
      script.includes("listen(editorDom, 'mouseleave', onEditorMouseLeave, true)") &&
        script.includes('guard.controller.shouldKeepOpenOnEditorMouseMoveOrLeave = true') &&
        script.includes('setTimeout(dismissAfterTransit, PREVIEW_HOVER_HIDE_DELAY_MS)'),
      'an editor leave should keep a visible hover alive for the editor-to-widget transit window',
    );
    assert.ok(
      script.includes("listen(overflowRoot, 'mouseover', onHoverMouseOver, true)") &&
        script.includes("listen(overflowRoot, 'mousemove', onDetachedHoverMouseMove, true)") &&
        script.includes("listen(document, 'mousemove', onDocumentMouseMove, true)") &&
        script.includes("listen(shadowRoot, 'mouseover', onHoverMouseOver, true)") &&
        script.includes('widget._onMouseLeave = wrapped') &&
        script.includes('guard.hoverContentsDisposable = hoverContentsEvent(function ()') &&
        script.includes("disposePreviewHoverTransitGuard(editor, 'standalone-dispose')"),
      'native overflow and bundled Shadow DOM hover widgets should cancel transit dismissal and clean up with their editor',
    );
    assert.ok(
      script.includes('var standaloneOverflowHost = getOrCreatePreviewOverflowHost();') &&
        script.includes('overflowWidgetsDomNode: standaloneOverflowHost') &&
        script.includes('var ownsPreviewOverflow = state.previewMonacoEditor === editor || state.monacoEditor === editor;'),
      'bundled Monaco widgets should use the same unclipped body-level overflow host as captured native Monaco',
    );
    assert.ok(
      script.includes("var retained = typeof state !== 'undefined' && state && state.previewOverflowRoot;") &&
        script.includes('state.previewOverflowRoot = root;') &&
        script.includes('document.body.appendChild(previewOverflowRoot);') &&
        script.includes("root.style.setProperty('z-index', String(panelZ + 20), 'important');"),
      'hide/show should reattach the constructor-bound overflow node instead of replacing it on a retained editor',
    );
    assert.ok(
      script.includes("var themeClasses = ['vs', 'vs-dark', 'hc-black', 'hc-light'];") &&
        script.includes('function ensurePreviewOverflowThemeObserver()') &&
        script.includes('syncPreviewOverflowTheme(overflowRoot);') &&
        script.includes("mountedInsideWorkbench = !!(panel.closest && panel.closest('.monaco-workbench'));") &&
        script.includes('if (!mountedInsideWorkbench && searchUiMountRoot === document.body) {') &&
        script.includes('syncPreviewOverflowTheme(panel);') &&
        script.includes("observer.observe(document.head, { childList: true, characterData: true, subtree: true });"),
      'the mounted panel should inherit without a cold style scan while the body fallback retains a theme snapshot',
    );
    assert.ok(
      script.includes('dismissPreviewMonacoHover(state.previewMonacoEditor || state.monacoEditor);') &&
        script.includes("disposePreviewHoverTransitGuard(editor, 'native-heal')") &&
        script.includes('try { editor.dispose(); }') &&
        script.includes('if (nativeDisposeFailed) { abandonPreviewOverflowRoot(); }') &&
        script.includes('if (standaloneDisposeFailed) { abandonPreviewOverflowRoot(); }'),
      'hide/minimize and native self-heal should dismiss stale hover state and release the old editor',
    );
    assert.ok(
      script.includes('schedulePreviewHoverTransitBootstrap(editor)') &&
        script.includes('bootstrap.editorMouseMoveDisposable = editor.onMouseMove(queueAttempt)') &&
        script.includes('bootstrap.editorDisposeDisposable = editor.onDidDispose(function ()'),
      'lazy hover contributions should install on first movement and release their bootstrap on editor disposal',
    );
    assert.ok(
      script.includes("disposePreviewHoverTransitGuard(editor, 'editor-dispose')") &&
        script.includes("disposePreviewHoverTransitGuard(null, 'minimize')") &&
        script.includes('installPreviewHoverTransitGuard(state.previewMonacoEditor || state.monacoEditor)'),
      'editor disposal and panel minimization should release the guard, with restore wiring it again',
    );
  });

  test('keeps bundled-to-native promotion bounded, dirty-safe, and recoverable', () => {
    const script = getRendererPatchScript(true, true, true, true, true, true, true);

    assert.ok(
      script.includes('PREVIEW_STANDALONE_NATIVE_PROMOTION_DELAYS_MS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000]'),
      'passive native promotion should use a finite retry schedule',
    );
    assert.ok(
      script.includes("scheduleStandaloneNativePromotion(state.lastPreviewMsg, 'preview-clean')"),
      'a dirty bundled model should resume promotion only after it becomes clean',
    );
    assert.ok(
      script.includes('restoreStandaloneAfterFailedNativePromotion'),
      'failed native construction should restore bundled Monaco before retrying',
    );
    const cancellationSites = script.match(/cancelStandaloneNativePromotion\(\)/g) ?? [];
    assert.ok(
      cancellationSites.length >= 7,
      `promotion should be cancelled across dirty, clear, hide, dispose, key-change, and native-commit paths; found ${cancellationSites.length}`,
    );
    assert.ok(
      script.includes("type: 'requestPreviewNativeRecovery'") &&
        script.includes('window.__ijFindResumeStandaloneNativePromotion'),
      'a bundled preview should wake host capture and accept a window-global native-ready resume signal',
    );
  });

  test('keeps temporary capture pause distinct from permanent disable and resumes retained previews', () => {
    let stops = 0;
    let refreshes = 0;
    let resumes = 0;
    const factory = { ctor: function NeutralEditorWidget() {} };
    const context = {
      window: {
        __ijFindPatchVersion: RENDERER_PATCH_VERSION,
        __ijFindPatchedV100: true,
        __ijFindDisableMonacoProbes: false,
        __ijFindMonacoCapturePaused: false,
        __ijFindMonacoFactory: factory,
        __ijFindMonaco: factory,
        __ijFindStopCapture: () => { stops++; return 'stopped'; },
        __ijFindRefreshCapture: () => { refreshes++; return 'refreshed'; },
        __ijFindResumeStandaloneNativePromotion: () => { resumes++; return 'resumed'; },
      } as Record<string, unknown>,
    };

    vm.runInNewContext(
      getRendererPatchScript(true, false, true, true, true, false, true, true),
      context,
    );
    assert.strictEqual(context.window.__ijFindDisableMonacoProbes, false);
    assert.strictEqual(context.window.__ijFindMonacoCapturePaused, true);
    assert.strictEqual(context.window.__ijFindMonacoFactory, factory, 'a temporary pause must retain a valid factory');
    assert.strictEqual(stops, 1, 'a temporary pause should disarm active prototype hooks');

    vm.runInNewContext(
      getRendererPatchScript(true, false, true, true, true, false, true, false),
      context,
    );
    assert.strictEqual(context.window.__ijFindMonacoCapturePaused, false);
    assert.strictEqual(refreshes, 1, 'pause expiry should re-arm capture on a retained patch');
    assert.strictEqual(resumes, 1, 'pause expiry should wake the current bundled preview');
  });

  test('cancels active cooperating capture cheaply and restarts only after the final suspend reason clears', () => {
    const script = getRendererPatchScript(true, false, true, true, true, false, true, false);
    const lifecycleStart = script.indexOf('function installIntelliSenseRecursionCaptureGuard()');
    const lifecycleEndMarker =
      'window.__ijFindSetIntelliSenseRecursionCaptureSuspended = setIntelliSenseRecursionCaptureSuspended;';
    const lifecycleEnd = script.indexOf(lifecycleEndMarker, lifecycleStart);
    assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart, 'expected generated capture lifecycle helpers');
    const lifecycleSource = script.slice(lifecycleStart, lifecycleEnd + lifecycleEndMarker.length);

    const cancelBranch = lifecycleSource.indexOf("typeof window.__irCancelCapture === 'function'");
    const stopFallback = lifecycleSource.indexOf("!cancelled && typeof window.__irStopCapture === 'function'");
    assert.ok(
      cancelBranch >= 0 && stopFallback > cancelBranch,
      'suspend should feature-detect cheap cancellation before consulting the legacy stop fallback',
    );
    assert.ok(
      lifecycleSource.includes(
        "var hadCleanupFlag = Object.prototype.hasOwnProperty.call(window, '__irCleanupInProgress')",
      ) &&
        lifecycleSource.includes('var previousCleanupFlag = window.__irCleanupInProgress') &&
        lifecycleSource.includes('window.__irCleanupInProgress = true') &&
        lifecycleSource.includes('if (window.__irCleanupInProgress !== true)') &&
        lifecycleSource.includes('window.__irCleanupInProgress = previousCleanupFlag') &&
        lifecycleSource.includes('delete window.__irCleanupInProgress'),
      'legacy stop should run in cleanup mode and restore both present and absent prior flag states',
    );
    assert.ok(
      lifecycleSource.includes('window.__ijFindIrCaptureNeedsRestart = true') &&
        lifecycleSource.includes('var restart = suspended ? \'\' : scheduleIntelliSenseRecursionCaptureRestart()') &&
        lifecycleSource.includes('if (window.__ijFindIrCaptureSuspended === true)') &&
        lifecycleSource.includes("window.__irStartCapture('ijss:resume-after-suspend')"),
      'only cancelled work should request a restart, and the queued restart must recheck suspension state',
    );

    function installLifecycle(windowState: Record<string, any>) {
      const queued: Array<() => void> = [];
      vm.runInNewContext(lifecycleSource, {
        window: windowState,
        setTimeout(callback: () => void) {
          queued.push(callback);
          return queued.length;
        },
      });
      const setSuspended = windowState.__ijFindSetIntelliSenseRecursionCaptureSuspended as
        (active: boolean, reason: string) => string;
      assert.strictEqual(typeof setSuspended, 'function');
      return { queued, setSuspended };
    }

    const preferredEvents: string[] = [];
    const preferredWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
    };
    preferredWindow.__irStartCapture = (reason: string) => {
      preferredEvents.push(`start:${reason}`);
      preferredWindow.__irCaptureActive = true;
      return 'started';
    };
    preferredWindow.__irCancelCapture = (reason: string) => {
      preferredEvents.push(`cancel:${reason}`);
      preferredWindow.__irCaptureActive = false;
      return 'cancelled';
    };
    preferredWindow.__irStopCapture = (reason: string) => {
      preferredEvents.push(`stop:${reason}`);
      preferredWindow.__irCaptureActive = false;
      return 'stopped';
    };
    const preferred = installLifecycle(preferredWindow);

    preferred.setSuspended(true, 'surface-visible');
    preferred.setSuspended(true, 'resource-transition');
    assert.deepStrictEqual(
      preferredEvents,
      ['cancel:ijss:surface-visible'],
      'an active capture should use the preferred cancel API once; an already-cancelled capture must not stop again',
    );
    assert.strictEqual(preferredWindow.__ijFindIrCaptureNeedsRestart, true);

    preferred.setSuspended(false, 'surface-visible');
    assert.strictEqual(preferred.queued.length, 0, 'one remaining owner must keep restart unscheduled');
    preferred.setSuspended(false, 'resource-transition');
    assert.strictEqual(preferred.queued.length, 1, 'the final release should queue, not synchronously run, restart');
    assert.deepStrictEqual(preferredEvents, ['cancel:ijss:surface-visible']);

    // A new owner can arrive between queueing and the timer turn. The queued
    // callback must preserve restart intent rather than starting while any
    // reason remains active.
    preferred.setSuspended(true, 'late-owner');
    preferred.queued.shift()!();
    assert.deepStrictEqual(preferredEvents, ['cancel:ijss:surface-visible']);
    assert.strictEqual(preferredWindow.__ijFindIrCaptureNeedsRestart, true);
    preferred.setSuspended(false, 'late-owner');
    assert.strictEqual(preferred.queued.length, 1);
    preferred.queued.shift()!();
    assert.deepStrictEqual(
      preferredEvents,
      ['cancel:ijss:surface-visible', 'start:ijss:resume-after-suspend'],
      'restart should occur asynchronously once, after every suspend reason has cleared',
    );

    let cleanupValueDuringStop: unknown;
    const fallbackWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
      __irCleanupInProgress: false,
      __irStartCapture: () => 'started',
    };
    fallbackWindow.__irStopCapture = () => {
      cleanupValueDuringStop = fallbackWindow.__irCleanupInProgress;
      fallbackWindow.__irCaptureActive = false;
      return 'stopped';
    };
    const fallback = installLifecycle(fallbackWindow);
    fallback.setSuspended(true, 'compatibility-owner');
    assert.strictEqual(cleanupValueDuringStop, true, 'legacy stop must observe cleanup mode and skip expensive finalization');
    assert.strictEqual(
      fallbackWindow.__irCleanupInProgress,
      false,
      'legacy stop must restore the exact pre-existing cleanup flag value',
    );

    let partialStops = 0;
    const partialCancelWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
      __irStartCapture: () => 'started',
      __irCancelCapture: () => 'still-active',
      __irStopCapture: () => {
        partialStops++;
        partialCancelWindow.__irCaptureActive = false;
        return 'stopped';
      },
    };
    installLifecycle(partialCancelWindow).setSuspended(true, 'partial-cancel-owner');
    assert.strictEqual(partialStops, 1, 'a cancel shim that leaves capture active must fall back to cleanup-mode stop');

    let unsafeStops = 0;
    const cleanupUnavailableWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
      __irStartCapture: () => 'started',
      __irStopCapture: () => { unsafeStops++; return 'expensive-stop'; },
    };
    Object.defineProperty(cleanupUnavailableWindow, '__irCleanupInProgress', {
      value: false,
      writable: false,
      configurable: true,
    });
    const cleanupUnavailable = installLifecycle(cleanupUnavailableWindow);
    cleanupUnavailable.setSuspended(true, 'read-only-cleanup-owner');
    cleanupUnavailable.setSuspended(false, 'read-only-cleanup-owner');
    assert.strictEqual(unsafeStops, 0, 'legacy stop must not run unless cheap cleanup mode is observably active');
    assert.strictEqual(cleanupUnavailable.queued.length, 0, 'an uncancelled capture must not gain restart intent');

    let cleanupOwnedStarts = 0;
    const cleanupOwnedWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
      __irCleanupInProgress: true,
      __irStartCapture: () => { cleanupOwnedStarts++; return 'started'; },
      __irStopCapture: () => {
        cleanupOwnedWindow.__irCaptureActive = false;
        return 'stopped-cleanup';
      },
    };
    const cleanupOwned = installLifecycle(cleanupOwnedWindow);
    cleanupOwned.setSuspended(true, 'external-cleanup-owner');
    cleanupOwned.setSuspended(false, 'external-cleanup-owner');
    assert.strictEqual(cleanupOwnedStarts, 0, 'capture stopped by an existing cleanup owner must not be restarted');
    assert.strictEqual(cleanupOwned.queued.length, 0);

    let staleStarts = 0;
    const staleSessionWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
      __irCaptureSessionId: 1,
    };
    staleSessionWindow.__irStartCapture = () => { staleStarts++; return 'started'; };
    staleSessionWindow.__irCancelCapture = () => {
      staleSessionWindow.__irCaptureActive = false;
      staleSessionWindow.__irCaptureSessionId = 2;
      return 'cancelled';
    };
    const staleSession = installLifecycle(staleSessionWindow);
    staleSession.setSuspended(true, 'session-owner');
    staleSession.setSuspended(false, 'session-owner');
    assert.strictEqual(staleSession.queued.length, 1);
    staleSessionWindow.__irCaptureSessionId = 3;
    staleSession.queued.shift()!();
    assert.strictEqual(staleStarts, 0, 'a replacement session must invalidate a queued restart');
    assert.strictEqual(staleSessionWindow.__ijFindIrCaptureNeedsRestart, false);

    let throwingStarts = 0;
    const throwingStartWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: true,
    };
    throwingStartWindow.__irStartCapture = () => {
      throwingStarts++;
      throw new Error('transient start failure');
    };
    throwingStartWindow.__irCancelCapture = () => {
      throwingStartWindow.__irCaptureActive = false;
      return 'cancelled';
    };
    const throwingStart = installLifecycle(throwingStartWindow);
    throwingStart.setSuspended(true, 'retry-owner');
    throwingStart.setSuspended(false, 'retry-owner');
    throwingStart.queued.shift()!();
    assert.strictEqual(throwingStart.queued.length, 1, 'a transient start failure should receive one bounded retry');
    throwingStart.queued.shift()!();
    assert.strictEqual(throwingStarts, 2);
    assert.strictEqual(throwingStartWindow.__ijFindIrCaptureNeedsRestart, false, 'retry exhaustion must clear stale intent');

    let inactiveStops = 0;
    const inactiveWindow: Record<string, any> = {
      __ijFindShouldSuspendIntelliSenseRecursionCapture: true,
      __irCaptureActive: false,
      __irStartCapture: () => 'started',
      __irCancelCapture: () => { inactiveStops++; return 'cancelled'; },
      __irStopCapture: () => { inactiveStops++; return 'stopped'; },
    };
    const inactive = installLifecycle(inactiveWindow);
    inactive.setSuspended(true, 'idle-owner');
    inactive.setSuspended(false, 'idle-owner');
    assert.strictEqual(inactiveStops, 0, 'suspending an idle integration must not invent cancelled work');
    assert.notStrictEqual(
      inactiveWindow.__ijFindIrCaptureNeedsRestart,
      true,
      'only a capture that was active and actually cancelled may carry restart intent',
    );
    assert.strictEqual(inactive.queued.length, 0, 'an idle integration must not schedule a restart');
  });

  test('recovers existing native editors through a bounded structural service graph', () => {
    const script = getRendererPatchScript(true, false, true, true, true, false, true, false);
    assert.ok(
      script.includes('PASSIVE_CAPTURE_GRAPH_MAX_DEPTH = 5') &&
        script.includes('PASSIVE_CAPTURE_GRAPH_MAX_NODES = 700') &&
        script.includes('PASSIVE_CAPTURE_GRAPH_MAX_PROPERTIES = 5000') &&
        script.includes('PASSIVE_CAPTURE_GRAPH_MAX_COLLECTION_ENTRIES = 700'),
      'passive graph traversal must have explicit work bounds',
    );
    assert.ok(
      script.includes("Object.getOwnPropertyDescriptor(value, names[pi])") &&
        script.includes("Object.prototype.hasOwnProperty.call(descriptor, 'value')") &&
        script.includes('value instanceof Map') &&
        script.includes('value instanceof Set'),
      'capture recovery should follow own data and built-in collection values without invoking getters',
    );
    assert.ok(
      script.indexOf('expandPassiveCapturedMonacoGraph(caps, report)') <
        script.indexOf('promoteCapturedEditorServiceWidgets(caps, report)'),
      'nested editor/model services must be discovered before code-editor widgets are promoted',
    );
    assert.ok(
      script.includes("getRootNode.call(domNode, { composed: true }) === document") &&
        script.includes("closest.call(domNode, '.ij-find-overlay')"),
      'only connected non-overlay widgets may provide native constructor evidence',
    );
  });

  test('exposes accessible preview engine, recovery, and feature-readiness states', () => {
    const script = getRendererPatchScript(true, true, true, true, true, true, true);

    assert.ok(
      script.includes("className: 'ij-find-preview-engine'"),
      'the preview header should contain a compact engine badge',
    );
    assert.ok(
      script.includes("'aria-live': 'polite'") && script.includes("'aria-atomic': 'true'"),
      'engine transitions should be announced without interrupting the user',
    );
    assert.ok(
      script.includes("'Native · Warming'") &&
        script.includes("'Native · Limited'") &&
        script.includes("feature === 'ready' ? 'Native'") &&
        script.includes("'Bundled · Degraded'") &&
        script.includes("'Bundled · Recovering'") &&
        script.includes("'Bundled · Paused'"),
      'engine recovery and native language-feature readiness should be visibly distinct',
    );
    assert.ok(
      script.includes("panel.setAttribute('data-preview-engine', engine)") &&
        script.includes("panel.setAttribute('data-preview-recovery', recovery)") &&
        script.includes("panel.setAttribute('data-preview-feature-readiness', feature)") &&
        script.includes('previewFeatureReadiness: state.previewFeatureReadiness || null'),
      'engine recovery and feature readiness should be separately machine-readable',
    );
    assert.ok(
      script.includes("updatePreviewEngineIndicator('ready', featureReadiness)") &&
        script.includes("setNativePreviewFeatureReadiness('ready', 'already-bound')") &&
        script.includes("boundToRequestedUri ? 'ready' : 'limited'") &&
        script.includes("setNativePreviewFeatureReadiness('limited', 'parse-uri-failed')"),
      'native commit should warm, successful binding should become ready, and terminal binding failure should become limited',
    );
    assert.ok(
      script.includes("Language features: ready; the model is bound to the requested file.") &&
        script.includes("Language features: limited; the model could not bind to the requested file."),
      'ARIA descriptions should identify language readiness independently of the engine',
    );
  });
});
