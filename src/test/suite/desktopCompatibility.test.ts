import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import { windowsFileUri } from '../../platform/windows/fileUri';
import { Uri as WorkerUri } from '../../nodeVscodeShim';
import { runRgSearch } from '../../rgSearch';
import type { FileMatch } from '../../search';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const artifactRoot = path.join(repoRoot, 'artifacts', 'desktop-compatibility', `${process.platform}-${process.arch}`);

async function getApi(): Promise<ExtensionTestApi> {
  const extension = vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search');
  assert.ok(extension);
  return extension.activate();
}

async function invoke(binary: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ZOEK_GRAPH_WORKERS: '2' } }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`${error.message}\n${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (err) { reject(err); }
    });
  });
}

suite('Desktop compatibility', () => {
  test('Windows ripgrep searches a candidate list larger than CreateProcess permits', async function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    this.timeout(30_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const root = await fs.promises.mkdtemp(path.join(folder!.uri.fsPath, 'compat paths '));
    const nested = path.join(root, 'nested directory '.repeat(4).trim());
    const token = new vscode.CancellationTokenSource();
    try {
      await fs.promises.mkdir(nested);
      const candidates = Array.from({ length: 240 }, (_, index) => path.join(nested, `source-${index}.txt`));
      await Promise.all(candidates.map((file) => fs.promises.writeFile(file, 'command_line_budget_probe\n')));
      const matches: FileMatch[] = [];
      await new Promise<void>((resolve, reject) => {
        runRgSearch({ query: 'command_line_budget_probe', useRegex: false, caseSensitive: true,
          wholeWord: false, resultLimit: 1000, includePatterns: [path.basename(root) + '/'] }, token.token, {
          onFile: (match) => matches.push(match), onDone: () => resolve(), onError: reject,
        }, candidates).catch(reject);
      });
      assert.strictEqual(matches.reduce((count, file) => count + file.matches.length, 0), candidates.length);
    } finally {
      token.dispose();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('Windows worker and native path encoders match the actual VS Code URI API', function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    const paths = ['C:\\Work Space\\한글\\source#.ts', 'D:\\src\\a%20b.ts', '\\\\SERVER\\Share\\a b.ts'];
    for (const file of paths) {
      const expected = vscode.Uri.file(file).toString();
      assert.strictEqual(windowsFileUri(file), expected);
      assert.strictEqual(WorkerUri.file(file).toString(), expected);
    }
  });

  test('native graph document queries use the same URI as the editor in a Unicode workspace', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    const binary = await overlay.resolveZoekEngineBinaryForGraph(false);
    assert.ok(binary, 'build the native runtime before running desktop compatibility tests');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ijss desktop 한글's "));
    const source = path.join(root, 'source file#1.ts');
    try {
      await fs.promises.writeFile(source, 'export function measure(value: number) { return value + 1; }\nexport function consume() { return measure(1); }\n');
      const rebuilt = await invoke(binary!, ['graph-rebuild', root, '--workers', '2']);
      assert.strictEqual(rebuilt.ok, true);
      const documentUri = vscode.Uri.file(source).toString();
      const queried = await invoke(binary!, ['graph-symbol-query', root, '--uri', documentUri]);
      assert.strictEqual(queried.ok, true);
      assert.ok(queried.symbols.some((symbol: any) => symbol.name === 'measure'), JSON.stringify(queried));
      assert.ok(queried.symbols.every((symbol: any) => symbol.uri === documentUri));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('opens, searches, previews and reopens the real overlay at desktop viewport sizes', async function () {
    this.timeout(60_000);
    const { overlay } = await getApi();
    await overlay.awaitInjection();
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder!.uri, 'beta.js'));
    await overlay.show('function', { forceLiteral: true, suppressSearch: true });
    await overlay.evalInActiveWindowForTests(`(function () {
      var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
        return node.querySelector('.ij-find-query').value === 'function';
      });
      window.__ijssDesktopTestSrc = root.getAttribute('data-ij-find-src');
      window.__ijFindSetScopeValue('', false, window.__ijssDesktopTestSrc);
      root.querySelector('.ij-find-refresh').click(); return 'clicked';
    })()`);
    let state: any;
    for (let attempt = 0; attempt < 150; attempt++) {
      state = JSON.parse(await overlay.evalInActiveWindowForTests('JSON.stringify(window.__ijFindGetSearchState(window.__ijssDesktopTestSrc))'));
      if (!state.searching && state.flatCount > 0 && state.previewUri) { break; }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(!state.searching && state.flatCount > 0 && state.previewUri,
      `search and preview must complete: ${JSON.stringify(state)}`);

    const control = overlay as any;
    const windowId = overlay.getConnectionStateForTests().activeWindowId;
    assert.ok(windowId !== undefined);
    const evaluateMain = async (expression: string) => {
      const response = await control.send('Runtime.evaluate', {
        expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true,
      });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result?.value;
    };
    const ownsDebugger = await evaluateMain(`(function () {
      var debuggerApi = require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger;
      if (debuggerApi.isAttached()) { return false; }
      debuggerApi.attach('1.3'); return true;
    })()`);
    await fs.promises.mkdir(artifactRoot, { recursive: true });
    const reports: any[] = [];
    try {
      for (const [width, height] of [[1440, 900], [1024, 768], [800, 600]]) {
        // Hosted runners may have a 1024×768 virtual display. Chromium viewport
        // emulation renders all requested sizes independently of that display.
        await evaluateMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(
          'Emulation.setDeviceMetricsOverride', { width: ${width}, height: ${height},
            screenWidth: ${width}, screenHeight: ${height}, deviceScaleFactor: 1, mobile: false })`);
        await overlay.evalInActiveWindowForTests(`new Promise(function (resolve) {
          requestAnimationFrame(function () { requestAnimationFrame(function () { resolve('stable'); }); });
        })()`);
        const layout = JSON.parse(await overlay.evalInActiveWindowForTests(`(function () {
          var root = Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function (node) {
            return node.getAttribute('data-ij-find-src') === window.__ijssDesktopTestSrc;
          });
          var rect = root.getBoundingClientRect();
          return JSON.stringify({ width: innerWidth, height: innerHeight,
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            matches: window.__ijFindGetSearchState(window.__ijssDesktopTestSrc).flatCount });
        })()`));
        reports.push(layout);
        assert.strictEqual(layout.width, width);
        assert.strictEqual(layout.height, height);
        assert.ok(layout.left >= -1 && layout.top >= -1 && layout.right <= layout.width + 1 &&
          layout.bottom <= layout.height + 1, `overlay must remain in the workbench viewport: ${JSON.stringify(layout)}`);
        const captured = await evaluateMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(
          'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(function(image) { return image.data; })`);
        assert.ok(typeof captured === 'string' && captured.length > 0, 'capture actual rendered workbench');
        await fs.promises.writeFile(path.join(artifactRoot, `${width}x${height}.png`), Buffer.from(captured, 'base64'));
      }
      await fs.promises.writeFile(path.join(artifactRoot, 'layout.json'), JSON.stringify(reports, null, 2));
    } finally {
      await evaluateMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')`);
      if (ownsDebugger) {
        await evaluateMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.detach()`);
      }
      await overlay.evalInActiveWindowForTests(`(function () {
        window.__ijFindHide(window.__ijssDesktopTestSrc); return 'closed';
      })()`);
    }
    await overlay.show('Reopen', { forceLiteral: true, suppressSearch: true });
    const reopened = await overlay.evalInActiveWindowForTests(`Array.from(document.querySelectorAll('.ij-find-overlay.visible')).some(function (node) {
      return node.querySelector('.ij-find-query').value === 'Reopen';
    }) ? 'visible' : 'missing'`);
    assert.strictEqual(reopened, 'visible');
    await overlay.evalInActiveWindowForTests(`(function () {
      window.__ijFindHide(window.__ijssDesktopTestSrc); delete window.__ijssDesktopTestSrc; return 'closed';
    })()`);
  });
});
