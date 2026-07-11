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

  test('keeps bundled-to-native promotion bounded, dirty-safe, and recoverable', () => {
    const script = getRendererPatchScript(true, true, true, true, true, true, true);

    assert.ok(
      script.includes('PREVIEW_STANDALONE_NATIVE_PROMOTION_DELAYS_MS = [100, 250, 500, 1000, 2000, 4000]'),
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
  });
});
