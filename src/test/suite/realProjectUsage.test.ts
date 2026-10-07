import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

suite('Real project usage delivery', () => {
  test('delivers and pages real indexed references in a large isolated workspace', async function () {
    const contextFile = process.env.IJSS_E2E_REAL_USAGE_CONTEXT;
    if (!contextFile) { this.skip(); return; }
    this.timeout(600_000);
    const context = JSON.parse(await fs.readFile(contextFile, 'utf8'));
    const api = await vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search')!.activate();
    assert.strictEqual(vscode.workspace.workspaceFolders![0].uri.fsPath, context.workspace);
    const config = vscode.workspace.getConfiguration('intellijStyledSearch');
    const settings: Record<string, any> = {};
    for (const name of ['callGraphBackend', 'callGraphConcurrency', 'callGraphMaxUsageResults', 'callGraphIncludeLowConfidenceUsages']) {
      settings[name] = config.inspect(name)?.workspaceValue;
    }
    let src = '';
    const main = async (expression: string) => {
      const result = await (api.overlay as any).send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true,
      });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    let windowId: number | undefined;
    let ownedDebugger = false;
    let priorThrottling: boolean | undefined;
    const debug = (method: string, params: object) => main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)})`);
    const state = async () => JSON.parse(await api.overlay.evalInActiveWindowForTests(`(function(){
      var p=Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function(p){return p.querySelector('.ij-find-query').value.includes('Real project usage audit');});
      if(!p)return JSON.stringify({flatCount:0});
      var src=p.getAttribute('data-ij-find-src'),s=window.__ijFindGetSearchState(src);
      var rows=Array.from(p.querySelectorAll('.ij-find-row[data-flat]')).map(function(row){var r=row.getBoundingClientRect();return {index:row.getAttribute('data-flat'),width:r.width,height:r.height};});
      var r=p.getBoundingClientRect(),list=p.querySelector('.ij-find-results').getBoundingClientRect();
      return JSON.stringify({src:src,flatCount:s.flatCount,rendered:rows.some(function(r){return r.width>0&&r.height>0;}),rows:rows,root:{width:r.width,height:r.height},list:{width:list.width,height:list.height},status:p.querySelector('.ij-find-status').textContent});
    })()`));
    const waitRows = async (count: number) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const result = await state();
        if (result.flatCount >= count && result.rendered) { src = result.src; return result; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      windowId = api.overlay.getConnectionStateForTests().activeWindowId!;
      ownedDebugger = await main(`(function(){var d=require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger;var owned=!d.isAttached();if(owned)d.attach('1.3');return owned;})()`);
      const captured = await debug('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await fs.mkdir(context.output, { recursive: true });
      await fs.writeFile(path.join(context.output, 'usage-failure.png'), Buffer.from(captured.data, 'base64'));
      assert.fail(`Expected ${count} real usage rows: ${JSON.stringify(await state())}`);
    };
    try {
      api.callGraph.setWindowFocusedForTests(false);
      await config.update('callGraphBackend', 'rust-native', vscode.ConfigurationTarget.Workspace);
      await config.update('callGraphConcurrency', 8, vscode.ConfigurationTarget.Workspace);
      await config.update('callGraphMaxUsageResults', 40, vscode.ConfigurationTarget.Workspace);
      await config.update('callGraphIncludeLowConfidenceUsages', true, vscode.ConfigurationTarget.Workspace);
      const rebuildStart = Date.now();
      const snapshot = await api.callGraph.rebuild(undefined, undefined, { force: true });
      const rebuildMs = Date.now() - rebuildStart;
      assert.ok(snapshot.stats.fileCount >= 2_000, 'requires a real large source snapshot');
      const target = (await api.callGraph.resolveSymbolsResolved(context.target.name, 10_000))
        .find(symbol => symbol.id === context.target.symbolId);
      assert.ok(target, 'the independently audited declaration must exist');
      assert.strictEqual(target.usageCount, context.target.totalReferences);
      assert.ok(target.usageCount! > 40, 'requires a real multi-page declaration');
      const preparationStart = Date.now();
      await api.overlay.awaitInjection();
      windowId = await (api.overlay as any).resolveTargetWorkbenchWindowId((api.overlay as any).activeWindowId);
      assert.ok(Number.isFinite(windowId), 'requires the isolated workbench window');
      const policy = await main(`(function(){var w=require('electron').BrowserWindow.fromId(${windowId});var d=w.webContents.debugger;var owned=!d.isAttached();if(owned)d.attach('1.3');var prior=w.webContents.getBackgroundThrottling();w.webContents.setBackgroundThrottling(false);w.show();w.focus();return {owned:owned,prior:prior};})()`);
      ownedDebugger = policy.owned;
      priorThrottling = policy.prior;
      const preparationMs = Date.now() - preparationStart;
      const timings: number[] = [];
      let firstState: any;
      for (let iteration = 0; iteration < 4; iteration++) {
        if (src) await api.overlay.evalInActiveWindowForTests(`window.__ijFindHide(${JSON.stringify(src)})`);
        const started = Date.now();
        await vscode.commands.executeCommand('intellijStyledSearch.showUsagesForSymbol', target.id, 'Real project usage audit', target.usageCount);
        firstState = await waitRows(40);
        timings.push(Date.now() - started);
        assert.strictEqual(firstState.flatCount, 40, 'first delivery stays within the configured page allocation');
      }
      const point = JSON.parse(await api.overlay.evalInActiveWindowForTests(`(function(){var r=window.__ijFindInstances[${JSON.stringify(src)}].panel.querySelector('.ij-find-more-usages').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`));
      assert.ok(point.x > 0 && point.y > 0);
      await debug('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await debug('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      const second = await waitRows(Math.min(80, target.usageCount!));
      assert.strictEqual(second.flatCount, Math.min(80, target.usageCount!));
      await debug('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, screenWidth: 1440, screenHeight: 900, deviceScaleFactor: 1, mobile: false });
      await api.overlay.evalInActiveWindowForTests('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve("painted"))))');
      const captured = await debug('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const output = path.resolve(context.output);
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, 'usage-panel.png'), Buffer.from(captured.data, 'base64'));
      const report = { sourceSha256: context.sourceSha256, files: snapshot.stats.fileCount,
        symbols: snapshot.stats.symbolCount, rebuildMs, preparationMs, firstCommandVisibleMs: timings[0], firstVisibleMs: preparationMs + timings[0],
        repeatedVisibleMs: timings.slice(1), firstPage: firstState.flatCount, secondPage: second.flatCount,
        totalReferences: target.usageCount, viewport: [1440, 900],
        measurement: 'Real public command through native service and actual rendered panel; first call includes CDP injection; 40-reference pages; current-source refinement remains asynchronous.' };
      await fs.writeFile(path.join(output, 'ui-delivery.json'), JSON.stringify(report, null, 2) + '\n');
      console.info('[real usage delivery]', JSON.stringify(report));
    } finally {
      if (src) await api.overlay.evalInActiveWindowForTests(`window.__ijFindHide(${JSON.stringify(src)})`);
      if (windowId) {
        await debug('Emulation.clearDeviceMetricsOverride', {});
        if (priorThrottling !== undefined) await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.setBackgroundThrottling(${priorThrottling})`);
        if (ownedDebugger) await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.detach()`);
      }
      api.callGraph.setWindowFocusedForTests(undefined);
      for (const [name, value] of Object.entries(settings)) await config.update(name, value, vscode.ConfigurationTarget.Workspace);
    }
  });
});
