import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';
import type { CallGraphReference, CallGraphSymbol } from '../../callGraph';
import type { FileMatch } from '../../search';

async function getApi(): Promise<ExtensionTestApi> {
  return vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search')!.activate();
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(label);
}

async function rendererState(overlay: ExtensionTestApi['overlay'], src: string): Promise<any> {
  return JSON.parse(await overlay.evalInActiveWindowForTests(`(function(){
    var inst=window.__ijFindInstances[${JSON.stringify(src)}],root=inst.panel;
    var state=window.__ijFindGetSearchState(${JSON.stringify(src)});
    return JSON.stringify(Object.assign({},state,{visible:root.classList.contains('visible'),
      status:root.querySelector('.ij-find-status').textContent,
      moreVisible:!root.querySelector('.ij-find-more-usages').hidden,
      candidatePressed:root.querySelector('.ij-find-opt-est').getAttribute('aria-pressed'),
      moreFocused:document.activeElement===root.querySelector('.ij-find-more-usages'),
      documentFocused:document.hasFocus(),
      activeElement:document.activeElement&&document.activeElement.outerHTML.slice(0,200),
      focused:document.activeElement===root.querySelector('.ij-find-results')}));
  })()`));
}

async function debuggerHarness(overlay: ExtensionTestApi['overlay']) {
  const windowId = overlay.getConnectionStateForTests().activeWindowId!;
  const main = async (expression: string): Promise<any> => {
    const response = await (overlay as any).send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
    assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  };
  const attached = await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});
    var prior=win.webContents.getBackgroundThrottling();win.webContents.setBackgroundThrottling(false);
    var owned=!win.webContents.debugger.isAttached();if(owned)win.webContents.debugger.attach('1.3');return {owned:owned,throttling:prior};})()`);
  const command = (method: string, params: object) => main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)})`);
  return {
    command,
    click: async (src: string, selector: string) => {
      let point: { x: number; y: number } | undefined;
      let diagnostic = '';
      await waitFor(async () => {
        diagnostic = await overlay.evalInActiveWindowForTests(`(function(){
          var inst=window.__ijFindInstances[${JSON.stringify(src)}],panel=inst&&inst.panel;
          var node=panel&&panel.querySelector(${JSON.stringify(selector)});
          if(!node)return JSON.stringify({ready:false,rows:panel?Array.from(panel.querySelectorAll('[data-flat]')).map(function(row){return row.getAttribute('data-flat');}):[]});
          var r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
          return JSON.stringify({ready:r.width>0&&r.height>0&&x>=0&&y>=0&&x<innerWidth&&y<innerHeight,point:{x:x,y:y}});
        })()`);
        assert.ok(!diagnostic.startsWith('err:'), diagnostic);
        const state = JSON.parse(diagnostic);
        point = state.point;
        return state.ready;
      }, `expected a rendered clickable control: ${selector}`);
      assert.ok(point, diagnostic);
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    },
    dispose: async () => {
      await command('Emulation.clearDeviceMetricsOverride', {});
      await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});
        win.webContents.setBackgroundThrottling(${attached.throttling});${attached.owned ? 'win.webContents.debugger.detach();' : ''}})()`);
    },
  };
}

suite('Usage result presentation', () => {
  test('the native service preserves totals and continuation metadata across real usage queries', async function () {
    this.timeout(60_000);
    const { callGraph } = await getApi();
    const config = vscode.workspace.getConfiguration('intellijStyledSearch');
    const previous = config.inspect<string>('callGraphBackend')?.workspaceValue;
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'usage_native_pages.py');
    try {
      // The watcher is created on activation, so changing its setting here
      // cannot stop it. Suspend automatic drains while explicitly owning the
      // index updates; generation invalidation is exercised below.
      callGraph.setWindowFocusedForTests(false);
      await config.update('callGraphBackend', 'rust-native', vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(file, Buffer.from('def native_page_target():\n    return 1\n\ndef invoke():\n' + '    native_page_target()\n'.repeat(17)));
      await callGraph.rebuild(undefined, undefined, { force: true });
      const target = (await callGraph.resolveSymbolsResolved('native_page_target', 10)).find((symbol) => symbol.uri === file.toString());
      assert.ok(target);
      assert.strictEqual(target.usageCount, 17);
      const first = await callGraph.findUsagePageForSymbolIdFromCache(target.id, 5);
      assert.ok(first);
      assert.strictEqual(first.totalReferences, 17);
      assert.strictEqual(first.references.length, 5);
      assert.strictEqual(first.nextOffset, 5);
      const second = await callGraph.findUsagePageForSymbolIdFromCache(target.id, 5, first.nextOffset, first.generation);
      assert.ok(second);
      assert.strictEqual(second.offset, 5);
      assert.strictEqual(second.totalReferences, 17);
      assert.strictEqual(second.generation, first.generation);
      assert.strictEqual(new Set([...first.references, ...second.references].map((reference) => reference.sourceRefId)).size, 10);
      await vscode.workspace.fs.writeFile(file, Buffer.from('def native_page_target():\n    return 1\n\ndef invoke():\n' + '    native_page_target()\n'.repeat(18)));
      await callGraph.refreshChangedFilesForTests([file]);
      await assert.rejects(() => callGraph.findUsagePageForSymbolIdFromCache(target.id, 5, first.nextOffset, first.generation),
        /Usage results changed/, 'native JSON errors must reach the pagination refresh path');
      const refreshed = await callGraph.findUsagePageForSymbolIdFromCache(target.id, 5);
      assert.ok(refreshed);
      assert.strictEqual(refreshed.totalReferences, 18);
      assert.notStrictEqual(refreshed.generation, first.generation);
    } finally {
      callGraph.setWindowFocusedForTests(undefined);
      await vscode.workspace.fs.delete(file);
      await config.update('callGraphBackend', previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('shows indexed results before refinement, preserves selection, and pages through ordinary controls', async function () {
    this.timeout(120_000);
    const { overlay, callGraph } = await getApi();
    const folder = vscode.workspace.workspaceFolders![0];
    const file = vscode.Uri.joinPath(folder.uri, 'usage_presentation_fixture.py');
    const lines = ['def compute():', '    return 1', '', ...Array.from({ length: 35 }, () => 'compute()')];
    await vscode.workspace.fs.writeFile(file, Buffer.from(lines.join('\n')));
    const references: CallGraphReference[] = Array.from({ length: 35 }, (_, index) => ({
      symbolId: 'sym:usage_presentation', sourceRefId: `ref:${index}`, name: 'compute', rawText: 'compute',
      edgeKind: 'call', uri: file.toString(), relPath: 'usage_presentation_fixture.py',
      range: { startLine: index + 3, startColumn: 0, endLine: index + 3, endColumn: 7 },
      confidence: 'possible', provenance: 'token-shape',
    }));
    const target: CallGraphSymbol = { id: 'sym:usage_presentation', name: 'compute', qualifiedName: 'compute',
      kind: 'function', language: 'python', uri: file.toString(), relPath: 'usage_presentation_fixture.py',
      range: { startLine: 0, startColumn: 4, endLine: 0, endColumn: 11 }, bodyRange: { startLine: 0, startColumn: 0, endLine: 1, endColumn: 12 }, usageCount: 35 };
    const prior = { resolve: callGraph.resolveSymbolsResolved, page: callGraph.findUsagePageForSymbolIdFromCache,
      refine: callGraph.refineUsageReferencesWithCurrentSources };
    const config = vscode.workspace.getConfiguration('intellijStyledSearch');
    const priorLimit = config.inspect<number>('callGraphMaxUsageResults')?.workspaceValue;
    const priorCandidates = config.inspect<boolean>('callGraphIncludeLowConfidenceUsages')?.workspaceValue;
    let release!: (references: CallGraphReference[]) => void;
    let firstRefinement = true;
    let failNextPage = true;
    let staleNextPage = false;
    let pageGeneration = 'fixture:1';
    let firstPageGeneration = '';
    let src = '';
    let harness: Awaited<ReturnType<typeof debuggerHarness>> | undefined;
    try {
      await config.update('callGraphMaxUsageResults', 10, vscode.ConfigurationTarget.Workspace);
      await config.update('callGraphIncludeLowConfidenceUsages', true, vscode.ConfigurationTarget.Workspace);
      callGraph.resolveSymbolsResolved = async () => [target];
      callGraph.findUsagePageForSymbolIdFromCache = async (_id, limit = 10, offset = 0) => {
        assert.strictEqual(limit, 10, 'the inlay total must not inflate the page allocation');
        if (offset > 0 && failNextPage) { failNextPage = false; throw new Error('temporary page failure'); }
        if (offset > 0 && staleNextPage) {
          staleNextPage = false;
          pageGeneration = 'fixture:2';
          throw new Error('Usage results changed; reload the first page.');
        }
        if (offset === 0) { firstPageGeneration = pageGeneration; }
        const end = Math.min(references.length, offset + limit);
        return { references: references.slice(offset, end), totalReferences: references.length, offset,
          ...(end < references.length ? { nextOffset: end } : {}), generation: pageGeneration };
      };
      callGraph.refineUsageReferencesWithCurrentSources = async (batch) => {
        if (!firstRefinement) { return [...batch]; }
        firstRefinement = false;
        return new Promise((resolve) => { release = resolve; });
      };
      await vscode.commands.executeCommand('intellijStyledSearch.showUsagesForSymbol', target.id, 'Usage presentation fixture', 35);
      assert.ok(release, 'refinement is still blocked when the command has delivered its first results');
      src = await overlay.evalInActiveWindowForTests(`(function(){var root=Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function(node){return node.querySelector('.ij-find-query').value.indexOf('Usage presentation fixture')>=0;});return root.getAttribute('data-ij-find-src');})()`);
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 10, 'first indexed page is visible');
      assert.match((await rendererState(overlay, src)).status, /Loaded 10 of 35 usages.*Checking candidates/);
      harness = await debuggerHarness(overlay);
      await harness.click(src, '.ij-find-row[data-flat="1"]');
      const before = await rendererState(overlay, src);
      assert.strictEqual(before.activeIndex, 1);
      release(references.slice(0, 10).map((reference, index) => index < 2 ? { ...reference, confidence: 'resolved' } : reference));
      await waitFor(async () => !(await rendererState(overlay, src)).status.includes('Checking candidates'), 'refinement completes');
      const after = await rendererState(overlay, src);
      assert.strictEqual(after.activeIndex, before.activeIndex);
      assert.strictEqual(after.activePreviewSeq, before.activePreviewSeq, 'refinement must not select a new preview');
      assert.strictEqual(after.focused, before.focused, 'refinement must preserve focus');
      await harness.click(src, '.ij-find-opt-est');
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 2, 'candidate toggle folds this panel');
      await harness.click(src, '.ij-find-opt-est');
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 10, 'candidate toggle restores this panel');
      await harness.click(src, '.ij-find-more-usages');
      await waitFor(async () => (await rendererState(overlay, src)).status.includes('Could not load more'), 'page failure is visible while preserving results');
      assert.strictEqual((await rendererState(overlay, src)).flatCount, 10);
      await harness.click(src, '.ij-find-more-usages');
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 20, 'retry loads the next page');

      const root = path.resolve(__dirname, '..', '..', '..', 'artifacts', 'desktop-compatibility', 'usage-presentation');
      await fs.promises.mkdir(root, { recursive: true });
      for (const [width, height] of [[1440, 900], [1024, 768], [800, 600]]) {
        await harness.command('Emulation.setDeviceMetricsOverride', { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: false });
        await overlay.evalInActiveWindowForTests('new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(function(){resolve("painted");});});})()');
        const layout = JSON.parse(await overlay.evalInActiveWindowForTests(`(function(){var p=window.__ijFindInstances[${JSON.stringify(src)}].panel,r=p.getBoundingClientRect();var b=p.querySelector('.ij-find-more-usages').getBoundingClientRect();return JSON.stringify({left:r.left,top:r.top,right:r.right,bottom:r.bottom,buttonRight:b.right});})()`));
        assert.ok(layout.left >= -1 && layout.top >= -1 && layout.right <= width + 1 && layout.bottom <= height + 1, JSON.stringify(layout));
        assert.ok(layout.buttonRight <= layout.right, 'More button must stay inside the panel');
        const captured = await harness.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
        await fs.promises.writeFile(path.join(root, `${width}x${height}.png`), Buffer.from(captured.data, 'base64'));
      }
      await harness.command('Emulation.clearDeviceMetricsOverride', {});
      await harness.click(src, '.ij-find-more-usages');
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 30, 'third page loads');
      const keyboardState = await rendererState(overlay, src);
      console.info('[usage keyboard state]', JSON.stringify(keyboardState));
      await harness.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await harness.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 35, 'keyboard activates the last page');
      assert.strictEqual((await rendererState(overlay, src)).moreVisible, false);
      await vscode.commands.executeCommand('intellijStyledSearch.showUsagesForSymbol', target.id, 'Usage scroll fixture', 35);
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 10, 'a fresh query starts at one page');
      const scrollPoint = JSON.parse(await overlay.evalInActiveWindowForTests(`(function(){var r=window.__ijFindInstances[${JSON.stringify(src)}].panel.querySelector('.ij-find-results').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`));
      staleNextPage = true;
      await harness.command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: 400 });
      await waitFor(async () => firstPageGeneration === 'fixture:2' && (await rendererState(overlay, src)).flatCount === 10,
        'a stale continuation refreshes the first page');
      assert.ok(!(await rendererState(overlay, src)).status.includes('Could not load more'));
      await harness.command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...scrollPoint, deltaX: 0, deltaY: 400 });
      await waitFor(async () => (await rendererState(overlay, src)).flatCount === 20, 'ordinary wheel input loads the next usage page');
    } finally {
      release?.([]);
      callGraph.resolveSymbolsResolved = prior.resolve;
      callGraph.findUsagePageForSymbolIdFromCache = prior.page;
      callGraph.refineUsageReferencesWithCurrentSources = prior.refine;
      if (src) await overlay.evalInActiveWindowForTests(`window.__ijFindHide(${JSON.stringify(src)})`);
      await harness?.dispose();
      await config.update('callGraphMaxUsageResults', priorLimit, vscode.ConfigurationTarget.Workspace);
      await config.update('callGraphIncludeLowConfidenceUsages', priorCandidates, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.delete(file);
    }
  });

  test('late static updates preserve sibling panels and cannot reopen a closed panel', async function () {
    this.timeout(30_000);
    const { overlay } = await getApi();
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'beta.js');
    const matches: FileMatch[] = [{ uri: file.toString(), relPath: 'beta.js', matches: [{ line: 0, preview: 'function beta() {}', ranges: [{ start: 0, end: 8 }] }] }];
    await overlay.showAndWaitForTests('Owned results', { forceLiteral: true, suppressSearch: true });
    const presenter = await overlay.presentStaticResults('Owned results', matches, { totalMatches: 1 });
    assert.ok(presenter);
    const src = await overlay.evalInActiveWindowForTests('Array.from(document.querySelectorAll(".ij-find-overlay.visible")).find(function(p){return p.querySelector(".ij-find-query").value==="Owned results";}).getAttribute("data-ij-find-src")');
    await overlay.showAndWaitForTests('Sibling results', { forceLiteral: true, suppressSearch: true, spawn: true });
    await presenter.update('Refined owned results', matches, { totalMatches: 1 });
    assert.strictEqual(await overlay.evalInActiveWindowForTests(`window.__ijFindInstances[${JSON.stringify(src)}].panel.querySelector('.ij-find-query').value`), 'Refined owned results');
    await overlay.evalInActiveWindowForTests(`window.__ijFindHide(${JSON.stringify(src)})`);
    await presenter.update('Must stay closed', matches, { totalMatches: 1 });
    assert.strictEqual((await rendererState(overlay, src)).visible, false);
    assert.strictEqual(await overlay.evalInActiveWindowForTests('Array.from(document.querySelectorAll(".ij-find-overlay.visible")).some(function(p){return p.querySelector(".ij-find-query").value==="Sibling results";})'), 'true');
    await overlay.evalInActiveWindowForTests('Array.from(document.querySelectorAll(".ij-find-overlay.visible")).forEach(function(p){window.__ijFindHide(p.getAttribute("data-ij-find-src"));});"closed"');
  });

  test('empty usage results finish without a spinner or a pagination control', async function () {
    this.timeout(30_000);
    const { overlay } = await getApi();
    await overlay.showAndWaitForTests('Empty usages', { forceLiteral: true, suppressSearch: true });
    await overlay.presentStaticResults('Empty usages', [], { totalMatches: 0, hasMore: false, statusText: '0 usages shown' });
    const result = JSON.parse(await overlay.evalInActiveWindowForTests(`(function(){var p=Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function(node){return node.querySelector('.ij-find-query').value==='Empty usages';});var src=p.getAttribute('data-ij-find-src');return JSON.stringify({src:src,count:window.__ijFindGetSearchState(src).flatCount,spinner:p.querySelector('.ij-find-spinner').classList.contains('hidden'),more:p.querySelector('.ij-find-more-usages').hidden,status:p.querySelector('.ij-find-status').textContent});})()`));
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.spinner, true);
    assert.strictEqual(result.more, true);
    assert.strictEqual(result.status, '0 usages shown');
    await overlay.evalInActiveWindowForTests(`window.__ijFindHide(${JSON.stringify(result.src)})`);
  });
});
