import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

const key = 'intellijStyledSearch.searchHistory';
let api: ExtensionTestApi;
let control: any;
let savedHistory: unknown;
let savedLimit: unknown;
let windowId: number;
const longQuery = 'prefix '.repeat(45) + 'historicalMarker\nsecond line <literal>';
const entries = ['Recent unrelated query', longQuery, 'Alpha component query', 'alpha service query',
  ...Array.from({ length: 96 }, (_, i) => `older query ${i}`)];

async function renderer(expression: string): Promise<any> {
  return JSON.parse(await control.evalInWindow(windowId, `(function(){
    var src=window.__ijFindGetSearchState().rendererInstanceId;
    var panel=Array.from(document.querySelectorAll('.ij-find-overlay')).find(function(p){return p.getAttribute('data-ij-find-src')===src;});
    return JSON.stringify((function(){${expression}})());})()`));
}
async function main(expression: string): Promise<any> {
  const response = await control.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true });
  assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
async function seed(values: string[]) {
  await control.context.globalState.update(key, values);
  await control.postSearchHistoryToRenderer();
}
async function queryState(): Promise<any> {
  return renderer(`var input=panel.querySelector('.ij-find-query');return {
    value:input.value,start:input.selectionStart,end:input.selectionEnd,
    focused:document.activeElement===input,state:window.__ijFindGetSearchState()};`);
}
async function setDraft(value: string, start=value.length, end=start) {
  await renderer(`var input=panel.querySelector('.ij-find-query');input.value=${JSON.stringify(value)};
    input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();input.setSelectionRange(${start},${end});return true;`);
}
async function pressQueryKey(keyCode: string) {
  await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});win.focus();var wc=win.webContents;
    wc.focus();wc.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(keyCode)}});
    wc.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(keyCode)}});})()`);
}
async function waitForQuery(predicate: (value: any) => boolean, timeout=2000): Promise<any> {
  const deadline=Date.now()+timeout;
  let value: any;
  do {
    value=await queryState();
    if(predicate(value)) return value;
    await new Promise(resolve=>setTimeout(resolve,20));
  } while(Date.now()<deadline);
  assert.fail(`query input did not reach the expected state: ${JSON.stringify(value)}`);
}

suite('Search history discovery', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search');
    assert.ok(ext);
    api = await ext!.activate();
    control = api.overlay as any;
    savedHistory = control.context.globalState.get(key);
    savedLimit = vscode.workspace.getConfiguration('intellijStyledSearch').inspect('searchHistoryLimit')?.workspaceValue;
    await vscode.workspace.getConfiguration('intellijStyledSearch').update('searchHistoryLimit', 100, vscode.ConfigurationTarget.Workspace);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder!.uri, 'beta.js'));
    assert.equal(await api.overlay.showAndWaitForTests('draft query', { forceLiteral: true, suppressSearch: true }), true);
    windowId = api.overlay.getConnectionStateForTests().activeWindowId!;
    await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});win.show();win.focus();win.webContents.setBackgroundThrottling(false);})()`);
  });
  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('intellijStyledSearch').update('searchHistoryLimit', savedLimit, vscode.ConfigurationTarget.Workspace);
    await control.context.globalState.update(key, savedHistory);
    await control.postSearchHistoryToRenderer();
  });
  setup(async () => {
    await renderer("var menu=panel.querySelector('.ij-find-history-menu');if(menu.classList.contains('open'))panel.querySelector('.ij-find-history').click();return true;");
    await seed(entries);
  });

  test('filters real stored history with trusted input and selects without running a search', async () => {
    const before = await renderer('return window.__ijFindGetSearchState();');
    await renderer("panel.querySelector('.ij-find-history').click();return true;");
    await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.insertText('ALPHA component')`);
    const result = await renderer(`var menu=panel.querySelector('.ij-find-history-menu');return {
      count:menu.querySelectorAll('.ij-find-history-item').length,label:menu.querySelector('.ij-find-history-item').title,
      highlighted:menu.querySelector('mark').textContent,focused:document.activeElement.className,
      counter:menu.querySelector('.ij-find-history-heading').textContent};`);
    assert.equal(result.count, 1);
    assert.equal(result.label, 'Alpha component query');
    assert.match(result.highlighted, /alpha/i);
    assert.equal(result.focused, 'ij-find-history-filter');
    assert.match(result.counter, /1 of 100/);
    await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});win.focus();var wc=win.webContents;wc.focus();wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});})()`);
    let after: any;
    const deadline=Date.now()+2000;
    do {
      after=await renderer("return {state:window.__ijFindGetSearchState(),open:panel.querySelector('.ij-find-history-menu').classList.contains('open'),focused:document.activeElement.className};");
      if(after.state.inputValue==='Alpha component query' && !after.open) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    } while(Date.now()<deadline);
    assert.equal(after.state.inputValue, 'Alpha component query',JSON.stringify(after));
    assert.equal(after.state.searchId, before.searchId, 'selecting a history entry must not execute it');
    assert.equal(after.open, false);
    assert.equal(after.focused, 'ij-find-query');
  });

  test('shows an excerpt around a late match and restores the full multiline query', async () => {
    const value = await renderer(`panel.querySelector('.ij-find-history').click();var input=panel.querySelector('.ij-find-history-filter');
      input.value='historicalMarker';input.dispatchEvent(new Event('input',{bubbles:true}));
      var item=panel.querySelector('.ij-find-history-item');var label=item.textContent;item.click();
      return {label:label,query:panel.querySelector('.ij-find-query').value};`);
    assert.match(value.label, /historicalMarker/);
    assert.equal(value.query, longQuery);
  });

  test('keyboard browsing and Escape keep the search panel open', async () => {
    const result = await renderer(`panel.querySelector('.ij-find-query').focus();
      panel.querySelector('.ij-find-query').dispatchEvent(new KeyboardEvent('keydown',{key:'h',code:'KeyH',altKey:true,bubbles:true,cancelable:true}));
      var input=panel.querySelector('.ij-find-history-filter');
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      var first=document.activeElement.title;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      var second=document.activeElement.title;
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      return {first:first,second:second,visible:panel.classList.contains('visible'),open:panel.querySelector('.ij-find-history-menu').classList.contains('open'),focused:document.activeElement.className};`);
    assert.equal(result.first, entries[0]);
    assert.equal(result.second, entries[1]);
    assert.equal(result.visible, true);
    assert.equal(result.open, false);
    assert.equal(result.focused, 'ij-find-history');
  });

  test('trusted query arrows walk history and restore the draft and selection without searching', async () => {
    const history=['most recent search','previous\nmultiline search','oldest search'];
    await seed(history);
    await setDraft('unfinished draft',3,8);
    const before=await queryState();
    for(const [keyCode,query] of [['Up',history[0]],['Up',history[1]],['Up',history[2]],
      ['Down',history[1]],['Down',history[0]],['Down','unfinished draft']]) {
      await pressQueryKey(keyCode);
      const value=await waitForQuery(value=>value.value===query);
      assert.equal(value.state.searchId,before.state.searchId,'history browsing must not run a search');
      assert.equal(value.state.activeIndex,before.state.activeIndex,'history browsing must not move search results');
      assert.equal(value.state.scopeValue,before.state.scopeValue);
      assert.deepEqual(value.state.options,before.state.options);
      assert.equal(value.focused,true);
    }
    const restored=await queryState();
    assert.equal(restored.start,3);
    assert.equal(restored.end,8);
  });

  test('skips the current query, clamps the oldest entry and adopts edits as the new draft', async () => {
    await seed(['recent search','older search']);
    await setDraft('recent search');
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value==='older search');
    const clamped=await renderer(`var input=panel.querySelector('.ij-find-query');
      var event=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true});input.dispatchEvent(event);
      return {value:input.value,prevented:event.defaultPrevented};`);
    assert.equal(clamped.value,'older search');
    assert.equal(clamped.prevented,true);
    await pressQueryKey('Down');
    await waitForQuery(value=>value.value==='recent search');
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value==='older search');
    await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.insertText(' edited')`);
    await waitForQuery(value=>value.value==='older search edited');
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value==='recent search');
    await pressQueryKey('Down');
    await waitForQuery(value=>value.value==='older search edited');
  });

  test('multiline cursor movement, selections, modifier keys and composition keep their normal behavior', async () => {
    const draft='first\nsecond\nthird';
    await setDraft(draft,10);
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value===draft && value.start<6);
    await setDraft(draft,0);
    await pressQueryKey('Down');
    await waitForQuery(value=>value.value===draft && value.start>=6);
    const ignored=await renderer(`var input=panel.querySelector('.ij-find-query');input.setSelectionRange(3,7);
      return [{key:'ArrowUp'},{key:'ArrowUp',shiftKey:true},{key:'ArrowUp',ctrlKey:true},
        {key:'ArrowUp',metaKey:true},{key:'ArrowUp',isComposing:true},{key:'Enter',isComposing:true}].map(function(options){
        var event=new KeyboardEvent('keydown',Object.assign({bubbles:true,cancelable:true},options));input.dispatchEvent(event);
        return {prevented:event.defaultPrevented,value:input.value,start:input.selectionStart,end:input.selectionEnd};});`);
    for(const value of ignored) {
      assert.equal(value.prevented,false);
      assert.equal(value.value,draft);
      assert.equal(value.start,3);
      assert.equal(value.end,7);
    }
    await setDraft(draft,0);
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value===entries[0]);
    await pressQueryKey('Down');
    const restored=await waitForQuery(value=>value.value===draft);
    assert.equal(restored.start,0);
  });

  test('Enter runs a recalled query and starts a fresh history walk afterward', async () => {
    await seed(['function','return']);
    await setDraft('new draft');
    const before=await queryState();
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value==='function');
    await pressQueryKey('Enter');
    await waitForQuery(value=>value.state.searchId!==before.state.searchId && value.state.rgQuery==='function'
      && !value.state.searching && value.state.flatCount>1,5000);
    const results=await renderer(`var input=panel.querySelector('.ij-find-query');var before=window.__ijFindGetSearchState();
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));
      return {before:before.activeIndex,after:window.__ijFindGetSearchState().activeIndex,value:input.value};`);
    assert.equal(results.after,results.before+1,'Alt+Down must keep result navigation available');
    assert.equal(results.value,'function');
    await pressQueryKey('Up');
    await waitForQuery(value=>value.value==='return');
    await pressQueryKey('Down');
    await waitForQuery(value=>value.value==='function');
  });

  test('empty and no-match states are clear and recover when the filter is cleared', async () => {
    await seed([]);
    await setDraft('draft without history');
    const arrows=await renderer(`var input=panel.querySelector('.ij-find-query');return ['ArrowUp','ArrowDown'].map(function(key){
      var event=new KeyboardEvent('keydown',{key:key,bubbles:true,cancelable:true});input.dispatchEvent(event);
      return {value:input.value,prevented:event.defaultPrevented};});`);
    for(const value of arrows) {
      assert.equal(value.value,'draft without history');
      assert.equal(value.prevented,false);
    }
    const empty = await renderer("panel.querySelector('.ij-find-history').click();return {disabled:panel.querySelector('.ij-find-history').disabled,text:panel.querySelector('.ij-find-history-empty').textContent};");
    assert.equal(empty.disabled, false);
    assert.match(empty.text, /No searches yet/);
    await seed(entries);
    const result = await renderer("var input=panel.querySelector('.ij-find-history-filter');input.value='never-matching-phrase';input.dispatchEvent(new Event('input',{bubbles:true}));var text=panel.querySelector('.ij-find-history-empty').textContent;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return {text:text,count:panel.querySelectorAll('.ij-find-history-item').length};");
    assert.match(result.text, /No matching searches/);
    assert.equal(result.count, 100);
  });

  test('renders dense, filtered and empty history at supported desktop sizes', async function () {
    this.timeout(30_000);
    const output = path.resolve(__dirname, '../../../artifacts/history-ux');
    await fs.promises.mkdir(output, { recursive: true });
    await main(`(function(){var win=require('electron').BrowserWindow.fromId(${windowId});win.show();win.focus();win.webContents.focus();win.webContents.setBackgroundThrottling(false);})()`);
    console.log('[history visual] attach screenshot debugger');
    const owns = await main(`(function(){var api=require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger;if(api.isAttached())return false;api.attach('1.3');return true;})()`);
    try {
      for (const [width,height] of [[1440,900],[1024,768],[800,600]]) {
        console.log(`[history visual] viewport ${width}x${height}`);
        await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:${width},height:${height},screenWidth:${width},screenHeight:${height},deviceScaleFactor:1,mobile:false})`);
        for (const [label,filter] of [['dense',''],['filtered','historicalMarker'],['empty','unknown-never-found']]) {
          console.log(`[history visual] ${label} ${width}x${height}`);
          await renderer(`var button=panel.querySelector('.ij-find-history');if(!panel.querySelector('.ij-find-history-menu').classList.contains('open'))button.click();
            var input=panel.querySelector('.ij-find-history-filter');input.value=${JSON.stringify(filter)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
          await control.evalInWindow(windowId, "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r('ready');});});})");
          const bounds=await renderer("var r=panel.querySelector('.ij-find-history-menu').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};");
          assert.ok(bounds.left>=0 && bounds.top>=0 && bounds.right<=width && bounds.bottom<=height, JSON.stringify(bounds));
          const data=await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:${width},height:${height},scale:1}}).then(function(v){return v.data;})`);
          await fs.promises.writeFile(path.join(output,`${label}-${width}x${height}.png`),Buffer.from(data,'base64'));
        }
        await setDraft('');
        for(const [label,keys,query] of [['query-recalled',['Up','Up'],longQuery],['query-draft',['Down','Down'],'']] as const) {
          console.log(`[history visual] ${label} ${width}x${height}`);
          for(const keyCode of keys) await pressQueryKey(keyCode);
          await waitForQuery(value=>value.value===query);
          await control.evalInWindow(windowId,"new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r('ready');});});})");
          const bounds=await renderer("var input=panel.querySelector('.ij-find-query');var r=input.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,focused:document.activeElement===input};");
          assert.ok(bounds.left>=0 && bounds.top>=0 && bounds.right<=width && bounds.bottom<=height,JSON.stringify(bounds));
          assert.equal(bounds.focused,true);
          const data=await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:${width},height:${height},scale:1}}).then(function(v){return v.data;})`);
          await fs.promises.writeFile(path.join(output,`${label}-${width}x${height}.png`),Buffer.from(data,'base64'));
        }
      }
    } finally {
      await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')`);
      if(owns) await main(`require('electron').BrowserWindow.fromId(${windowId}).webContents.debugger.detach()`);
    }
  });

  test('disabled history explains the setting and cannot open', async () => {
    const cfg=vscode.workspace.getConfiguration('intellijStyledSearch');
    try {
      await cfg.update('searchHistoryLimit',0,vscode.ConfigurationTarget.Workspace);
      await control.postSearchHistoryToRenderer();
      const result=await renderer("var button=panel.querySelector('.ij-find-history');button.click();return {disabled:button.disabled,title:button.title,open:panel.querySelector('.ij-find-history-menu').classList.contains('open')};");
      assert.equal(result.disabled,true);
      assert.match(result.title,/searchHistoryLimit/);
      assert.equal(result.open,false);
      await setDraft('draft with history disabled');
      const arrows=await renderer(`var input=panel.querySelector('.ij-find-query');return ['ArrowUp','ArrowDown'].map(function(key){
        var event=new KeyboardEvent('keydown',{key:key,bubbles:true,cancelable:true});input.dispatchEvent(event);
        return {value:input.value,prevented:event.defaultPrevented};});`);
      for(const value of arrows) {
        assert.equal(value.value,'draft with history disabled');
        assert.equal(value.prevented,false);
      }
    } finally {
      await cfg.update('searchHistoryLimit',100,vscode.ConfigurationTarget.Workspace);
      await control.postSearchHistoryToRenderer();
    }
  });
});
