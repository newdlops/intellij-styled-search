import * as vscode from 'vscode';
import {
  CAPTURE_BUFFER_PEEK_EXPR,
  CLEAR_CAPTURE_BUFFER_EXPR,
  DOM_CAPTURE_EXPR,
  MONACO_GLOBALS_PEEK_EXPR,
  STOP_CAPTURE_EXPR,
  TEST_WIDGET_CREATE_EXPR,
} from './expressions';
import { forceOpenEditorForCapture, pickBestWindowAfterForceOpen } from './forceOpen';
import type { CaptureDiagnosticOptions, MonacoCaptureRuntime } from './types';

type CapturedWindowSummary = {
  id: number;
  widgets: number;
  services: number;
  ctors: number;
};

// A refreshed capture buffer starts empty, while the workbench editor whose
// constructor/services we want may still be completing an asynchronous mount.
// Keep the hooks alive for a small, fixed window instead of treating the first
// synchronous DOM scan as the final answer. The guard polling keeps a stale
// preview request from holding renderer-wide prototype hooks for the full
// dwell.
const PASSIVE_CAPTURE_DWELL_MS = 450;
const PASSIVE_CAPTURE_GUARD_POLL_MS = 50;

export async function runMonacoCaptureDiagnostic(
  runtime: MonacoCaptureRuntime,
  preferredWindowId?: number,
  options?: CaptureDiagnosticOptions,
): Promise<void> {
  // Opening an editor is a visible workspace mutation. Require an explicit
  // opt-in so a missing option can never create a tab by accident.
  const allowForceOpen = options?.allowForceOpen === true;
  const forceOpenUri = options?.forceOpenUri;
  const holdForceOpenedTab = options?.holdForceOpenedTab === true;
  const reason = options?.reason || 'foreground';
  const shouldContinue = options?.shouldContinue ?? (() => true);
  let continueGuardFailureLogged = false;
  const canContinue = (): boolean => {
    try {
      return shouldContinue();
    } catch (err) {
      if (!continueGuardFailureLogged) {
        continueGuardFailureLogged = true;
        runtime.log(`Capture diagnostic continuation guard failed: ${err instanceof Error ? err.message : err}`);
      }
      return false;
    }
  };
  runtime.log(
    `Capture diagnostic: starting (reason=${reason}, forceOpen=${allowForceOpen ? 'yes' : 'no'}` +
    (forceOpenUri ? `, forceOpenUri=${forceOpenUri.toString()}` : '') + ')...',
  );
  if (!canContinue()) { return; }
  let targetWindowId: number | undefined;
  try {
    targetWindowId = await runtime.resolveTargetWorkbenchWindowId(preferredWindowId);
  } catch (err) {
    runtime.log(`Capture diagnostic target resolution failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const windowIds = targetWindowId === undefined ? [] : [targetWindowId];
  runtime.log(
    `Target workbench windows: [${windowIds.join(', ')}]` +
    (preferredWindowId !== undefined ? ` preferred=${preferredWindowId}` : ''),
  );
  if (windowIds.length === 0) { return; }

  const stopCaptureAll = async (): Promise<void> => {
    await Promise.all(windowIds.map(async (id) => {
      try {
        const result = await runtime.evalInWindow(id, STOP_CAPTURE_EXPR);
        runtime.log(`Capture stop win=${id}: ${result}`);
      } catch {}
    }));
  };

  if (!canContinue()) {
    await stopCaptureAll();
    return;
  }

  const monacoVals = new Map<number, string>();
  await Promise.all(windowIds.map(async (id) => {
    try { monacoVals.set(id, await runtime.evalInWindow(id, MONACO_GLOBALS_PEEK_EXPR)); }
    catch {}
  }));
  let alreadyReadyWin: number | null = null;
  for (const [id, value] of monacoVals) {
    runtime.log(`Monaco globals win=${id}: ${value}`);
    if (alreadyReadyWin === null &&
        (preferredWindowId === undefined || id === preferredWindowId) &&
        /status=ready\b/.test(value)) {
      alreadyReadyWin = id;
    }
  }
  if (alreadyReadyWin !== null) {
    runtime.log(`Monaco globals already present in win=${alreadyReadyWin} - skipping capture diagnostic.`);
    await stopCaptureAll();
    return;
  }

  const peekAll = async (stage: string, silent = false): Promise<Map<number, string>> => {
    const results = new Map<number, string>();
    await Promise.all(windowIds.map(async (id) => {
      try { results.set(id, await runtime.evalInWindow(id, CAPTURE_BUFFER_PEEK_EXPR)); }
      catch (err) { results.set(id, 'err:' + (err instanceof Error ? err.message : err)); }
    }));
    if (!silent) {
      runtime.log(`${stage}: ${[...results.entries()].map(([id, value]) => `win=${id} ${value}`).join(' | ')}`);
    }
    return results;
  };

  const refreshCaptureAll = async (): Promise<void> => {
    const captureReason = JSON.stringify(`diagnostic:${reason}`);
    const refreshExpr = `(function(){
      try {
        if (window.__ijFindRefreshCapture) { return window.__ijFindRefreshCapture(${captureReason}); }
        if (window.__ijFindStartCapture) { return window.__ijFindStartCapture(${captureReason}); }
        return 'no-capture-fn';
      } catch(e){ return 'refresh-err:' + (e && e.message); }
    })()`;
    const summaries: string[] = [];
    await Promise.all(windowIds.map(async (id) => {
      try {
        const result = await runtime.evalInWindow(id, refreshExpr);
        summaries.push(`win=${id} ${result}`);
      } catch (err) {
        summaries.push(`win=${id} err:${err instanceof Error ? err.message : err}`);
      }
    }));
    runtime.log(`Capture refresh: ${summaries.join(' | ')}`);
  };

  const runWidgetCreateTest = async (winId: number, label: string): Promise<boolean> => {
    if (!canContinue()) { return false; }
    try {
      const testResult = await runtime.evalInWindow(winId, TEST_WIDGET_CREATE_EXPR);
      runtime.log(`TEST widget create (win=${winId}, ${label}): ${String(testResult).slice(0, 2000)}`);
    } catch (err) {
      runtime.log(`TEST widget eval failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!canContinue()) { return false; }
    try {
      return await runtime.isMonacoReadyInWindow(winId);
    } catch (err) {
      runtime.log(`TEST widget readiness check failed (win=${winId}, ${label}): ${err instanceof Error ? err.message : err}`);
      return false;
    }
  };

  const findBestCapturedWindow = (peeked: Map<number, string>): CapturedWindowSummary | null => {
    let best: CapturedWindowSummary | null = null;
    for (const [id, value] of peeked) {
      const widgetsMatch = /widgets=(\d+)/.exec(value);
      const servicesMatch = /services=(\d+)/.exec(value);
      const ctorsMatch = /ctors=(\d+)/.exec(value);
      const widgets = widgetsMatch ? parseInt(widgetsMatch[1], 10) : 0;
      const services = servicesMatch ? parseInt(servicesMatch[1], 10) : 0;
      const ctors = ctorsMatch ? parseInt(ctorsMatch[1], 10) : 0;
      // A live widget or its constructor is actionable evidence too. During a
      // cold mount, the widget/constructor commonly lands in the buffer one
      // turn before its DI services. Preserve that structural evidence so the
      // promotion probe can inspect the selected renderer instead of treating
      // the capture as empty solely because of arrival order.
      if (widgets + services + ctors <= 0) { continue; }
      if (preferredWindowId !== undefined && id === preferredWindowId) {
        return { id, widgets, services, ctors };
      }
      if (preferredWindowId !== undefined) { continue; }
      if (!best || widgets + services + ctors > best.widgets + best.services + best.ctors) {
        best = { id, widgets, services, ctors };
      }
    }
    return best;
  };

  const scanDomAll = async (stage: string): Promise<void> => {
    const domCaptureSummaries: string[] = [];
    await Promise.all(windowIds.map(async (id) => {
      if (!canContinue()) { return; }
      try {
        const result = await runtime.evalInWindow(id, DOM_CAPTURE_EXPR);
        domCaptureSummaries.push(`win=${id} ${result}`);
      } catch (err) {
        domCaptureSummaries.push(`win=${id} err:${err instanceof Error ? err.message : err}`);
      }
    }));
    runtime.log(`${stage}: ${domCaptureSummaries.join(' | ')}`);
  };

  const waitForPassiveCaptureDwell = async (): Promise<boolean> => {
    // An opted-in force-open diagnostic is itself the reliable fallback. It
    // already tested existing evidence and performed an immediate DOM scan
    // above, so do not add a 450ms idle dwell before creating the capture
    // editor.
    if (allowForceOpen) { return canContinue(); }
    const deadline = Date.now() + PASSIVE_CAPTURE_DWELL_MS;
    while (canContinue()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { return true; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(PASSIVE_CAPTURE_GUARD_POLL_MS, remaining)));
    }
    return false;
  };

  try {
    const initialPeek = await peekAll('Capture peek initial');
    const existingCapture = findBestCapturedWindow(initialPeek);
    if (existingCapture) {
      runtime.log(
        `Existing captures in win=${existingCapture.id} ` +
        `(widgets=${existingCapture.widgets} services=${existingCapture.services} ctors=${existingCapture.ctors}) - testing before refresh.`,
      );
      const promoted = await runWidgetCreateTest(existingCapture.id, 'existing-capture');
      if (promoted) {
        await stopCaptureAll();
        return;
      }
      runtime.log('Existing captures did not promote to Monaco - refreshing capture buffer.');
    }

    if (!canContinue()) {
      await stopCaptureAll();
      return;
    }
    await refreshCaptureAll();
    if (!canContinue()) {
      await stopCaptureAll();
      return;
    }
    await scanDomAll('Capture via DOM scan');
    if (!canContinue()) {
      await stopCaptureAll();
      return;
    }

    const afterDomPeek = await peekAll('Capture peek after DOM scan', true);
    const domCapture = findBestCapturedWindow(afterDomPeek);
    if (domCapture) {
      runtime.log(
        `DOM/captured evidence in win=${domCapture.id} ` +
        `(widgets=${domCapture.widgets} services=${domCapture.services} ctors=${domCapture.ctors}) - testing before force-open.`,
      );
      const promoted = await runWidgetCreateTest(domCapture.id, 'DOM/capture path');
      if (promoted) {
        await stopCaptureAll();
        return;
      }
      runtime.log('DOM/captured evidence did not promote to Monaco yet.');
    }

    // The prototype hooks need a bounded opportunity to observe editor work
    // scheduled just after the refresh. Rescan once at the end so an editor
    // which became DOM-visible without flowing through a hooked collection is
    // also considered. This remains passive: no editor or tab is opened here.
    if (!(await waitForPassiveCaptureDwell())) {
      await stopCaptureAll();
      return;
    }
    await scanDomAll('Capture via DOM rescan after passive dwell');
    if (!canContinue()) {
      await stopCaptureAll();
      return;
    }
    const afterDwellPeek = await peekAll('Capture peek after passive dwell', true);
    const dwellCapture = findBestCapturedWindow(afterDwellPeek);
    if (dwellCapture) {
      runtime.log(
        `Passive dwell captures in win=${dwellCapture.id} ` +
        `(widgets=${dwellCapture.widgets} services=${dwellCapture.services} ctors=${dwellCapture.ctors}) - testing before force-open.`,
      );
      const promoted = await runWidgetCreateTest(dwellCapture.id, 'passive-dwell');
      if (promoted) {
        await stopCaptureAll();
        return;
      }
      runtime.log('Passive dwell captures did not promote to Monaco.');
    }

    if (!allowForceOpen || !canContinue()) {
      runtime.log(
        'Capture warmup: DOM scan did not yield a ready Monaco; skipping force-open and restoring capture hooks.',
      );
      await stopCaptureAll();
      return;
    }

    await Promise.all(windowIds.map(async (id) => {
      try { await runtime.evalInWindow(id, CLEAR_CAPTURE_BUFFER_EXPR); } catch {}
    }));
    runtime.log('Captures cleared - no DOM-visible widgets, forcing real editor creation via file open/close...');

    const phase = await forceOpenEditorForCapture(runtime, forceOpenUri, peekAll, canContinue);
    if (!canContinue()) {
      if (phase.forceOpenedCloseTargets.length > 0) {
        try { await vscode.window.tabGroups.close(phase.forceOpenedCloseTargets, true); }
        catch (errClose) { runtime.log(`Capture close cancelled tab failed: ${errClose instanceof Error ? errClose.message : errClose}`); }
      }
      await stopCaptureAll();
      return;
    }
    const peeked = await peekAll('Capture peek after clear+force');
    const bestWin = pickBestWindowAfterForceOpen(peeked, preferredWindowId);
    if (bestWin.id !== null && bestWin.score > 0) {
      runtime.log(`Running TEST widget create in win=${bestWin.id} (score=${bestWin.score})...`);
      await runWidgetCreateTest(bestWin.id, 'force-open');
    } else {
      runtime.log('No window has captures - skipping widget creation test.');
    }

    if (phase.forceOpenedCloseTargets.length > 0) {
      const tClose0 = Date.now();
      if (holdForceOpenedTab && canContinue()) {
        runtime.holdPreviewCaptureTabs(phase.forceOpenedCloseTargets);
        runtime.log(
          `Capture diagnostic: holding ${phase.forceOpenedCloseTargets.length} introduced tab(s) until preview render completes.`,
        );
      } else {
        try { await vscode.window.tabGroups.close(phase.forceOpenedCloseTargets, true); }
        catch (errClose) { runtime.log(`Capture close tab failed: ${errClose instanceof Error ? errClose.message : errClose}`); }
      }
      phase.closeMs += Date.now() - tClose0;
    }

    runtime.log(
      `Capture force-open phase: ${Date.now() - phase.startedAt}ms ` +
      `(findFiles=${phase.findFilesMs}ms showTextDocument=${phase.showTextDocumentMs}ms ` +
      `poll=${phase.pollMs}ms iters=${phase.pollIters} peekMax=${phase.pollPeekMaxMs}ms ` +
      `closeEditors=${phase.closeMs}ms)`,
    );

    await stopCaptureAll();
  } catch (err) {
    runtime.log(`Capture diagnostic failed: ${err instanceof Error ? err.message : err}`);
    try { await stopCaptureAll(); } catch {}
  }
}
