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
