import * as assert from 'assert';
import {
  CAPTURE_BUFFER_PEEK_EXPR,
  CLEAR_CAPTURE_BUFFER_EXPR,
  DOM_CAPTURE_EXPR,
  MONACO_GLOBALS_PEEK_EXPR,
  STOP_CAPTURE_EXPR,
  TEST_WIDGET_CREATE_EXPR,
} from '../../preview/monacoCapture/expressions';
import { runMonacoCaptureDiagnostic } from '../../preview/monacoCapture';
import type { MonacoCaptureRuntime } from '../../preview/monacoCapture';

type FakeCaptureState = {
  buffer: string;
  ready: boolean;
  domScans: number;
  refreshes: number;
  stops: number;
  widgetTests: number;
  clears: number;
  logs: string[];
};

function makeRuntime(
  state: FakeCaptureState,
  onRefresh?: () => void,
  onDomScan?: () => void,
): MonacoCaptureRuntime {
  return {
    async resolveTargetWorkbenchWindowId() { return 17; },
    async evalInWindow(_winId, expression) {
      if (expression === MONACO_GLOBALS_PEEK_EXPR) {
        return state.ready ? 'status=ready' : 'status=not-ready:none';
      }
      if (expression === CAPTURE_BUFFER_PEEK_EXPR) { return state.buffer; }
      if (expression === TEST_WIDGET_CREATE_EXPR) {
        state.widgetTests++;
        state.ready = true;
        return 'promoted';
      }
      if (expression === DOM_CAPTURE_EXPR) {
        state.domScans++;
        onDomScan?.();
        return state.buffer;
      }
      if (expression === STOP_CAPTURE_EXPR) {
        state.stops++;
        return 'stopped';
      }
      if (expression === CLEAR_CAPTURE_BUFFER_EXPR) {
        state.clears++;
        state.buffer = 'widgets=0 services=0 ctors=0 installed=true';
        return 'cleared';
      }
      if (expression.includes('__ijFindRefreshCapture')) {
        state.refreshes++;
        onRefresh?.();
        return 'capture-started';
      }
      throw new Error(`unexpected diagnostic expression: ${expression.slice(0, 80)}`);
    },
    async isMonacoReadyInWindow() { return state.ready; },
    log(message) { state.logs.push(message); },
    setLastCaptureDiagnosticOpenUri() {},
    holdPreviewCaptureTabs() {},
  };
}

function emptyState(buffer = 'widgets=0 services=0 ctors=0 installed=true'): FakeCaptureState {
  return {
    buffer,
    ready: false,
    domScans: 0,
    refreshes: 0,
    stops: 0,
    widgetTests: 0,
    clears: 0,
    logs: [],
  };
}

suite('Monaco passive capture diagnostic', () => {
  test('restores armed hooks when a prior capture already made Monaco ready', async () => {
    const state = emptyState();
    state.ready = true;

    await runMonacoCaptureDiagnostic(makeRuntime(state), 17, {
      allowForceOpen: false,
      reason: 'already-ready-test',
    });

    assert.strictEqual(state.refreshes, 0, 'an already-ready renderer should not refresh its capture buffer');
    assert.strictEqual(state.stops, 1, 'an early ready return must still restore prototype hooks');
  });

  test('tests widget-only and constructor-only capture buffers without requiring services first', async () => {
    for (const buffer of [
      'widgets=1 services=0 ctors=1 installed=true',
      'widgets=0 services=0 ctors=1 installed=true',
    ]) {
      const state = emptyState(buffer);
      await runMonacoCaptureDiagnostic(makeRuntime(state), 17, {
        allowForceOpen: false,
        reason: 'candidate-shape-test',
      });

      assert.strictEqual(state.widgetTests, 1, `capture evidence should reach the promotion probe: ${buffer}`);
      assert.strictEqual(state.refreshes, 0, `successful existing evidence should not be cleared: ${buffer}`);
      assert.strictEqual(state.stops, 1, `capture hooks should be restored after promotion: ${buffer}`);
    }
  });

  test('keeps passive hooks armed long enough to capture a delayed editor mount and rescans DOM', async () => {
    const state = emptyState();
    let delayedCapture: NodeJS.Timeout | undefined;
    const runtime = makeRuntime(state, () => {
      delayedCapture = setTimeout(() => {
        state.buffer = 'widgets=1 services=1 ctors=1 installed=true';
      }, 80);
    });

    try {
      await runMonacoCaptureDiagnostic(runtime, 17, {
        allowForceOpen: false,
        reason: 'delayed-passive-mount-test',
      });
    } finally {
      if (delayedCapture) { clearTimeout(delayedCapture); }
    }

    assert.strictEqual(state.domScans, 2, 'diagnostic should rescan once after the passive dwell');
    assert.strictEqual(state.widgetTests, 1, 'delayed capture evidence should reach the promotion probe');
    assert.strictEqual(state.ready, true, 'the delayed passive capture should be promoted');
    assert.strictEqual(state.clears, 0, 'passive recovery must not enter the force-open path');
    assert.strictEqual(state.stops, 1, 'capture hooks should be restored after promotion');
  });

  test('cancels the passive dwell promptly without rescanning or entering force-open', async () => {
    const state = emptyState();
    let keepGoing = true;
    let cancelTimer: NodeJS.Timeout | undefined;
    const runtime = makeRuntime(state, () => {
      cancelTimer = setTimeout(() => { keepGoing = false; }, 80);
    });

    try {
      await runMonacoCaptureDiagnostic(runtime, 17, {
        allowForceOpen: false,
        reason: 'cancelled-passive-dwell-test',
        shouldContinue: () => keepGoing,
      });
    } finally {
      if (cancelTimer) { clearTimeout(cancelTimer); }
    }

    assert.strictEqual(state.domScans, 1, 'a stale request must not run the post-dwell DOM scan');
    assert.strictEqual(state.widgetTests, 0, 'a stale request must not run the promotion probe');
    assert.strictEqual(state.clears, 0, 'a stale request must not enter the force-open path');
    assert.strictEqual(state.stops, 1, 'cancellation should still restore capture hooks');
  });
});
