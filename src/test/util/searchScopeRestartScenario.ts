import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const remembered = '**/*.vue,**/*.ts';
const typedFiles = ['src/source.ts', 'src/types.d.ts', 'src/view.vue'];
const allFiles = ['notes.md', 'scripts/script.js', ...typedFiles].sort();

export async function runScopeRestartScenario(): Promise<void> {
    const stage = process.env.IJSS_SCOPE_STAGE;
    assert.ok(stage, 'the dedicated restart harness must supply a stage');
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const extension = vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search');
    assert.ok(extension);
    const { overlay } = await extension!.activate();
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, 'src/source.ts'));
    assert.equal(await overlay.showAndWaitForTests('ScopeRestartProbe', { forceLiteral: true, suppressSearch: true }), true);
    const control = overlay as any;
    const windowId = overlay.getConnectionStateForTests().activeWindowId;
    assert.ok(windowId !== undefined);
    const inMain = async (expression: string) => {
      const response = await control.send('Runtime.evaluate', { expression,
        includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result?.value;
    };
    // Observe the window already opened above, without repeating window discovery
    // while VS Code is still finishing its startup status-bar updates.
    const inRenderer = (expression: string): Promise<string> => control.evalInWindow(windowId, expression);
    const activeRoot = `Array.from(document.querySelectorAll('.ij-find-overlay.visible')).find(function(root){
      return root.getAttribute('data-ij-find-src')===window.__ijFindGetSearchState().rendererInstanceId;})`;
    await inMain(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});
      win.show();win.focus();win.webContents.setBackgroundThrottling(false);})()`);
    assert.equal(await inMain("process.argv.some(function(arg){return arg.indexOf('--extensionTestsPath')===0;})"), false,
      'normal VS Code storage must be used; extension-test mode deliberately uses in-memory storage');
    const rendererState = async () => JSON.parse(await inRenderer(`(function(){
      var root=${activeRoot};
      var src=root.getAttribute('data-ij-find-src');
      var state=window.__ijFindGetSearchState(src);
      return JSON.stringify({scope:root.querySelector('.ij-find-scope').value, searching:state.searching, searchState:state,
        focused:document.activeElement&&document.activeElement.className,
        status:root.querySelector('.ij-find-status')&&root.querySelector('.ij-find-status').textContent,
        files:Array.from(root.querySelectorAll('.ij-find-row[data-uri]')).map(function(row){return row.getAttribute('data-uri');}),
        trustedInputs:window.__ijssScopeTrustedInputs||0});
    })()`));
    const initial = stage === 'write' ? '**/*.js' : stage === 'isolation-clear' ? '**/*.md'
      : stage === 'restore-empty' ? '' : remembered;
    assert.equal((await rendererState()).scope, initial, 'scope must be restored before the first search');

    async function editScope(value: string) {
      await inRenderer(`(function(){var input=(${activeRoot}).querySelector('.ij-find-scope');
        window.__ijssScopeTrustedInputs=0;
        input.addEventListener('input',function(event){if(event.isTrusted)window.__ijssScopeTrustedInputs++;});
        input.focus();input.select();return 'focused';})()`);
      if (value) {
        await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.insertText(${JSON.stringify(value)})`);
      } else {
        await inMain(`(function(){var wc=require('electron').BrowserWindow.fromId(${windowId}).webContents;
          wc.sendInputEvent({type:'keyDown',keyCode:'Backspace'});wc.sendInputEvent({type:'keyUp',keyCode:'Backspace'});})()`);
      }
      const deadline = Date.now() + 5000;
      while (control.filesScopeState.initialValue() !== value && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(control.filesScopeState.initialValue(), value, 'trusted input must reach workspace storage');
      await control.filesScopeState.whenSaved();
      assert.ok((await rendererState()).trustedInputs > 0, 'normal Electron input must emit a trusted input event');
    }
    if (stage === 'write') {
      await editScope(remembered);
      assert.equal(await overlay.showAndWaitForTests('ScopeRestartProbe', {
        forceLiteral: true, suppressSearch: true, spawn: true,
      }), true);
      assert.equal(await inRenderer("String(document.querySelectorAll('.ij-find-overlay.visible').length)"), '2');
      assert.equal((await rendererState()).scope, remembered, 'a fresh panel must use the latest workspace scope');
    }
    if (stage === 'isolation-clear') { await editScope(''); }

    const expectedScope = stage === 'isolation-clear' || stage === 'restore-empty' ? '' : remembered;
    const expectedFiles = expectedScope ? typedFiles : allFiles;
    await inRenderer(`(${activeRoot}).querySelector('.ij-find-scope').focus();'focused'`);
    await inMain(`(function(){var wc=require('electron').BrowserWindow.fromId(${windowId}).webContents;
      wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});})()`);
    let actual: string[] = [];
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await rendererState();
      actual = [...new Set<string>(state.files.map((uri: string) =>
        path.relative(folder!.uri.fsPath, vscode.Uri.parse(uri).fsPath).split(path.sep).join('/')))].sort();
      if (!state.searching && JSON.stringify(actual) === JSON.stringify(expectedFiles)) { break; }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (JSON.stringify(actual) !== JSON.stringify(expectedFiles)) {
      const captured = await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.capturePage()
        .then(function(image){return image.toPNG().toString('base64');})`);
      fs.writeFileSync(path.join(process.env.IJSS_SCOPE_ARTIFACTS!, `${stage}-failure.png`), Buffer.from(captured, 'base64'));
    }
    assert.deepEqual(actual, expectedFiles, 'the restored scope must constrain a real search: ' + JSON.stringify(await rendererState()));
    assert.equal((await rendererState()).scope, expectedScope);
    const output = process.env.IJSS_SCOPE_ARTIFACTS!;
    fs.mkdirSync(output, { recursive: true });
    if (stage === 'restore' || stage === 'restore-empty') {
      const ownsDebugger = await inMain(`(function(){var api=require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger;
        if(api.isAttached())return false;api.attach('1.3');return true;})()`);
      try {
        for (const [width, height] of [[1440, 900], [1024, 768], [800, 600]]) {
          await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(
            'Emulation.setDeviceMetricsOverride',{width:${width},height:${height},screenWidth:${width},screenHeight:${height},deviceScaleFactor:1,mobile:false})`);
          await inRenderer(`new Promise(function(resolve){requestAnimationFrame(function(){requestAnimationFrame(function(){resolve('stable');});});})`);
          const layout = JSON.parse(await inRenderer(`(function(){var root=${activeRoot};
            var rect=root.getBoundingClientRect();var scope=root.querySelector('.ij-find-scope');
            return JSON.stringify({width:innerWidth,height:innerHeight,left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,
              scope:scope.value,label:scope.getAttribute('aria-label')});})()`));
          assert.equal(layout.width, width);
          assert.equal(layout.height, height);
          assert.equal(layout.scope, expectedScope);
          assert.equal(layout.label, 'Files scope');
          assert.ok(layout.left >= -1 && layout.top >= -1 && layout.right <= width + 1 && layout.bottom <= height + 1,
            `restored panel must fit the viewport: ${JSON.stringify(layout)}`);
          const captured = await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand(
            'Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:${width},height:${height},scale:1}})
            .then(function(image){return image.data;})`);
          const png = Buffer.from(captured, 'base64');
          assert.equal(png.readUInt32BE(16), width);
          assert.equal(png.readUInt32BE(20), height);
          fs.writeFileSync(path.join(output, `${stage}-${width}x${height}.png`), png);
        }
      } finally {
        await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')`);
        if (ownsDebugger) { await inMain(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.detach()`); }
      }
    }
    fs.writeFileSync(path.join(output, `${stage}.json`), JSON.stringify({stage, pid:process.pid,
      mainPid:await inMain('process.pid'), vscodeVersion:vscode.version, extensionVersion:extension.packageJSON.version,
      workspace:folder!.uri.fsPath, initialScope:initial, finalScope:expectedScope, files:actual}, null, 2));
}
