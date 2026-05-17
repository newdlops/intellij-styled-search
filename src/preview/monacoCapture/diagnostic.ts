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

export async function runMonacoCaptureDiagnostic(
  runtime: MonacoCaptureRuntime,
  preferredWindowId?: number,
  options?: CaptureDiagnosticOptions,
): Promise<void> {
  const allowForceOpen = options?.allowForceOpen !== false;
  const forceOpenUri = options?.forceOpenUri;
  const holdForceOpenedTab = options?.holdForceOpenedTab === true;
  const reason = options?.reason || 'foreground';
  runtime.log(
    `Capture diagnostic: starting (reason=${reason}, forceOpen=${allowForceOpen ? 'yes' : 'no'}` +
    (forceOpenUri ? `, forceOpenUri=${forceOpenUri.toString()}` : '') + ')...',
  );
  const targetWindowId = await runtime.resolveTargetWorkbenchWindowId(preferredWindowId);
  const windowIds = targetWindowId === undefined ? [] : [targetWindowId];
  runtime.log(
    `Target workbench windows: [${windowIds.join(', ')}]` +
    (preferredWindowId !== undefined ? ` preferred=${preferredWindowId}` : ''),
  );
  if (windowIds.length === 0) { return; }

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

  const stopCaptureAll = async (): Promise<void> => {
    await Promise.all(windowIds.map(async (id) => {
      try {
        const result = await runtime.evalInWindow(id, STOP_CAPTURE_EXPR);
        runtime.log(`Capture stop win=${id}: ${result}`);
      } catch {}
    }));
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
    try {
      const testResult = await runtime.evalInWindow(winId, TEST_WIDGET_CREATE_EXPR);
      runtime.log(`TEST widget create (win=${winId}, ${label}): ${String(testResult).slice(0, 2000)}`);
    } catch (err) {
      runtime.log(`TEST widget eval failed: ${err instanceof Error ? err.message : err}`);
    }
    return runtime.isMonacoReadyInWindow(winId);
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
      if (services <= 0) { continue; }
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

    await refreshCaptureAll();
    const domCaptureSummaries: string[] = [];
    await Promise.all(windowIds.map(async (id) => {
      try {
        const result = await runtime.evalInWindow(id, DOM_CAPTURE_EXPR);
        domCaptureSummaries.push(`win=${id} ${result}`);
      } catch (err) {
        domCaptureSummaries.push(`win=${id} err:${err instanceof Error ? err.message : err}`);
      }
    }));
    runtime.log(`Capture via DOM scan: ${domCaptureSummaries.join(' | ')}`);

    const afterDomPeek = await peekAll('Capture peek after DOM scan', true);
    const domCapture = findBestCapturedWindow(afterDomPeek);
    if (domCapture) {
      runtime.log(
        `DOM/captured services in win=${domCapture.id} ` +
        `(widgets=${domCapture.widgets} services=${domCapture.services} ctors=${domCapture.ctors}) - testing before force-open.`,
      );
      const promoted = await runWidgetCreateTest(domCapture.id, 'DOM/service path');
      if (promoted) {
        await stopCaptureAll();
        return;
      }
      runtime.log('DOM/service captures did not promote to Monaco.');
    }

    if (!allowForceOpen) {
      runtime.log(
        'Capture warmup: DOM scan did not yield a ready Monaco; skipping force-open and leaving capture hooks armed for the history capture path.',
      );
      return;
    }

    await Promise.all(windowIds.map(async (id) => {
      try { await runtime.evalInWindow(id, CLEAR_CAPTURE_BUFFER_EXPR); } catch {}
    }));
    runtime.log('Captures cleared - no DOM-visible widgets, forcing real editor creation via file open/close...');

    const phase = await forceOpenEditorForCapture(runtime, forceOpenUri, peekAll);
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
      if (holdForceOpenedTab) {
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
