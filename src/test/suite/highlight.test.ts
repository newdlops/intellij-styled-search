import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const EXTENSION_ID = 'newdlops.intellij-styled-search';

// Multi-line fixture query (see tests/fixtures/workspace/docs.md). Three
// consecutive quoted lines — renderer should highlight every line of this
// block when the match lands in the preview.
const MULTI_LINE_QUERY = [
  '> Line one of the pull quote.',
  '> Line two continues here.',
  '> Line three wraps up.',
].join('\n');

const SINGLE_LINE_QUERY_1 = 'class AlphaService:';
const SINGLE_LINE_QUERY_2 = 'class BetaWidget';

async function getApi(): Promise<ExtensionTestApi> {
  const ext = vscode.extensions.getExtension<ExtensionTestApi>(EXTENSION_ID);
  assert.ok(ext);
  return ext.activate();
}

interface PreviewDecoration {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  inlineClassName: string;
}
interface PreviewDecorationsProbe {
  editor: string | null;
  decorations?: PreviewDecoration[];
  lineCount?: number;
  err?: string;
}
interface SearchStateProbe {
  searching: boolean;
  filesCount: number;
  flatCount: number;
  activeIndex: number;
  previewMode: string | null;
  previewUri: string | null;
  lastPreviewKey: string | null;
  inputValue: string | null;
  err?: string;
}

async function probeDecos(api: ExtensionTestApi): Promise<PreviewDecorationsProbe> {
  const raw = await api.overlay.evalInActiveWindowForTests(
    `(function(){try{return JSON.stringify(window.__ijFindGetPreviewDecorations())}catch(e){return JSON.stringify({err:String(e&&e.message)})}})()`,
  );
  return JSON.parse(raw);
}

async function probeState(api: ExtensionTestApi): Promise<SearchStateProbe> {
  const raw = await api.overlay.evalInActiveWindowForTests(
    `(function(){try{return JSON.stringify(window.__ijFindGetSearchState())}catch(e){return JSON.stringify({err:String(e&&e.message)})}})()`,
  );
  return JSON.parse(raw);
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (ok(last)) { return last; }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`pollUntil timed out (${timeoutMs}ms): ${label}; last=${JSON.stringify(last)}`);
}

let cdpAvailable = false;
let monacoReady = false;

suite('Preview highlight — decoration regression', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const api = await getApi();
    try {
      await api.overlay.awaitInjection();
      cdpAvailable = true;
    } catch {
      cdpAvailable = false;
    }
    if (!cdpAvailable) { return; }
    // Clear any scope left over from a prior suite (e.g. filter tests set
    // scope=nested/ and we'd run every show() scoped to a dir that doesn't
    // contain docs.md or alpha.py).
    await api.overlay.evalInActiveWindowForTests(
      `(function(){
        var scope = document.querySelector('.ij-find-scope');
        if (!scope) { return 'no-scope'; }
        scope.value = '';
        scope.dispatchEvent(new Event('input', { bubbles: true }));
        return 'cleared';
      })()`,
    );
    await api.overlay.rebuildIndex();
    await api.overlay.waitForIndexReady(30_000);
    // Force a Monaco editor to exist in the workbench so the capture
    // diagnostic has a real widget to sniff — otherwise test VSCode
    // starts with no open editor and __ijFindMonaco stays empty.
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const fixture = vscode.Uri.joinPath(folder.uri, 'alpha.py');
      await vscode.window.showTextDocument(fixture, { preview: false });
      await new Promise((r) => setTimeout(r, 500));
    }
    // Run a show() so the panel mounts, then synchronously run the capture
    // diagnostic so monaco globals are populated before any assertions.
    await api.overlay.show('class AlphaService:');
    const captureResult = await api.overlay.forceCaptureForTests();
    monacoReady = /^ready/.test(captureResult);
    if (!monacoReady) {
      // eslint-disable-next-line no-console
      console.warn(`[highlight suite] monaco not ready after forceCapture: ${captureResult}`);
    }
  });

  test('multi-line match: preview carries at least one decoration whose range spans multiple lines', async function () {
    if (!cdpAvailable || !monacoReady) { this.skip(); return; }
    this.timeout(20_000);
    const api = await getApi();

    await api.overlay.show(MULTI_LINE_QUERY);

    // Wait for rg to finish and preview to mount as monaco.
    await pollUntil(
      () => probeState(api),
      (s) => !s.searching && s.previewMode === 'monaco' && s.filesCount > 0,
      10_000,
      'multi-line search to finish and preview to render in monaco',
    );
    // Give the decoration application + reveal a frame to settle.
    await new Promise((r) => setTimeout(r, 100));

    const probe = await probeDecos(api);
    assert.ok(probe.decorations, `no decorations array: ${JSON.stringify(probe)}`);
    assert.ok(
      probe.decorations!.length > 0,
      `expected at least one findMatch decoration, got ${JSON.stringify(probe)}`,
    );
    // applyPreviewMatchDecorations splits a multi-line match into one
    // single-line decoration per file line the match covers. For our
    // 3-line fixture blockquote we expect at least 3 decorations, each
    // carrying the findMatch class. If only the first line is highlighted
    // we'd see exactly 1 — that's the regression.
    const findMatchCount = probe.decorations!.filter((d) => /findMatch/.test(d.inlineClassName)).length;
    assert.ok(
      findMatchCount >= 3,
      `expected ≥3 per-line findMatch decorations for a 3-line match, got ${findMatchCount}. ` +
      `Raw: ${JSON.stringify(probe.decorations)}`,
    );
    // Verify the decorations actually span distinct consecutive lines —
    // rules out duplicates that all point at the start line.
    const lines = new Set(probe.decorations!
      .filter((d) => /findMatch/.test(d.inlineClassName))
      .map((d) => d.startLineNumber));
    assert.ok(
      lines.size >= 3,
      `decorations should cover ≥3 distinct lines, got ${lines.size} (lines=${Array.from(lines).join(',')})`,
    );
  });

  test('re-running search replaces preview decorations (regression: highlight disappears on refresh)', async function () {
    if (!cdpAvailable || !monacoReady) { this.skip(); return; }
    this.timeout(30_000);
    const api = await getApi();

    // First search — pick up at least one decoration.
    await api.overlay.show(SINGLE_LINE_QUERY_1);
    await pollUntil(
      () => probeState(api),
      (s) => !s.searching && s.previewMode === 'monaco' && s.filesCount > 0,
      10_000,
      'first search to settle',
    );
    await new Promise((r) => setTimeout(r, 100));
    const firstProbe = await probeDecos(api);
    assert.ok(
      firstProbe.decorations && firstProbe.decorations.length > 0,
      'first search must produce at least one findMatch decoration',
    );

    // Second search — a different single-line query. Preview should
    // render either a new file or the same editor reused, but in BOTH
    // cases decorations for the new match must be present.
    await api.overlay.show(SINGLE_LINE_QUERY_2);
    await pollUntil(
      () => probeState(api),
      (s) => !s.searching && s.previewMode === 'monaco' && s.filesCount > 0 && s.inputValue === SINGLE_LINE_QUERY_2,
      10_000,
      'second search to settle with new input value',
    );
    await new Promise((r) => setTimeout(r, 100));
    const secondProbe = await probeDecos(api);
    assert.ok(
      secondProbe.decorations && secondProbe.decorations.length > 0,
      'second search must leave at least one findMatch decoration in preview. ' +
      'Got: ' + JSON.stringify(secondProbe),
    );
  });
});
