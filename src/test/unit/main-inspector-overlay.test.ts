/** Execute the production lifecycle methods with inert Electron/HTTP adapters, preserving peers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as ts from 'typescript';

const source=fs.readFileSync(path.resolve(__dirname,'../../../src/overlayPanel.ts'),'utf8');
const tree=ts.createSourceFile('overlay.ts',source,ts.ScriptTarget.Latest,true);
const names=['releaseRendererBridge','closeCdpAndInspectorSoon','closeCdpWebSocket','ensureLocalBridgeServer','inject'];
const methods:string[]=[];
function visit(node:ts.Node):void{
  if(ts.isMethodDeclaration(node)&&names.includes(node.name.getText(tree))){methods.push(node.getText(tree));}
  ts.forEachChild(node,visit);
}
visit(tree);assert.equal(methods.length,names.length);
const script=ts.transpileModule('globalThis.Probe=class Probe{'+methods.join('\n')+'}',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
function probe(extra:Record<string,unknown>={}):any{
  const context:any=vm.createContext({WebSocket:{OPEN:1},URL,...extra});
  vm.runInContext(script,context,{timeout:1000});
  const instance=new context.Probe();instance.log={appendLine(){}};instance.pending=new Map();
  return instance;
}
function peers(otherIr:boolean):any{
  const stats={detached:[] as number[],removed:[] as number[],inspectorCloses:0,legacyCloses:0};
  const windows=[7,8].map(id=>({id,webContents:{removeListener(){stats.removed.push(id);},debugger:{
    isAttached:()=>true,listenerCount:()=>0,removeListener(){stats.removed.push(id);},detach(){stats.detached.push(id);},
  }}}));
  const globals:any={
    __ijFindConsoleBridgeTargets:new Map([[7,{host:'127.42.7.9',port:43111,token:'owner'}],[8,{host:'127.42.7.9',port:43112,token:'peer'}]]),
    __ijFindConsoleBridgeListeners:new Map([[7,()=>{}],[8,()=>{}]]),
    __ijFindBridgeListeners:new Map([[7,()=>{}],[8,()=>{}]]),
    __ijFindReloadPatchListeners:new Map([[7,()=>{}],[8,()=>{}]]),__ijFindAttachedWindows:new Set([7,8]),
    __irGoToTypeBridgeListeners:new Map(otherIr?[[7,()=>{}]]:[]),
    __ijFindMainHttpBridge:{server:{close(){stats.legacyCloses++;}}},
    require(name:string){
      if(name==='electron')return{BrowserWindow:{getAllWindows:()=>windows}};
      if(name==='inspector')return{close(){stats.inspectorCloses++;}};
      throw Error('Unexpected module '+name);
    },
  };
  const context=vm.createContext(globals);vm.runInContext('globalThis.global=globalThis;',context);
  return{stats,globals,evaluate:(expression:string)=>vm.runInContext(expression,context,{timeout:1000})};
}
for(const reason of ['force reinject','overlay disposed','renderer UI recovery','panel hidden']){
  test('cleanup preserves other hosts and the shared inspector: '+reason,async()=>{
    const peer=peers(true),instance=probe();let socketCloses=0;
    Object.assign(instance,{ws:{readyState:1,close(){socketCloses++;}},localBridgePort:43111,localBridgeToken:'owner',
      shouldEnableRendererInlayClickHook:()=>true,
      send:async(method:string,params:any)=>{assert.equal(method,'Runtime.evaluate');return{result:{value:peer.evaluate(params.expression)}};}});
    const report=await instance.releaseRendererBridge(reason);
    assert.match(report,/inspector=kept/);assert.equal(socketCloses,1);
    assert.equal(peer.stats.inspectorCloses,0);assert.equal(peer.stats.legacyCloses,0);
    assert.deepEqual(peer.stats.detached,[]);assert(peer.stats.removed.every((id:number)=>id===7));
    assert(peer.globals.__ijFindConsoleBridgeTargets.has(8));assert(peer.globals.__ijFindBridgeListeners.has(8));
    assert(peer.globals.__ijFindReloadPatchListeners.has(8));assert(peer.globals.__ijFindAttachedWindows.has(8));
    assert.equal(peer.globals.__ijFindConsoleBridgeTargets.has(7),reason==='panel hidden');
  });
}
test('cleanup can detach its own unused renderer channel without affecting peer windows',async()=>{
  const peer=peers(false),instance=probe();
  Object.assign(instance,{ws:{readyState:1,close(){}},localBridgePort:43111,localBridgeToken:'owner',shouldEnableRendererInlayClickHook:()=>true,
    send:async(_method:string,params:any)=>({result:{value:peer.evaluate(params.expression)}})});
  await instance.releaseRendererBridge('overlay disposed');
  assert.deepEqual(peer.stats.detached,[7]);assert.equal(peer.stats.inspectorCloses,0);
});
test('idle close releases only this client and settles its pending callbacks',async()=>{
  const instance=probe();let closes=0,rejected=0;
  instance.ws={readyState:1,close(){closes++;}};instance.pending.set(1,(response:any)=>{assert(response.error);rejected++;});
  await instance.closeCdpAndInspectorSoon('panel hidden');
  assert.equal(closes,1);assert.equal(rejected,1);assert.equal(instance.pending.size,0);
});
test('local event bridge uses the verified dedicated loopback and reuses its listener',async()=>{
  const binds:{port:number;host:string}[]=[];
  class Server extends EventEmitter{
    listen(port:number,host:string,ready:()=>void){binds.push({port,host});ready();}
    address(){return{port:43123,address:'127.42.7.9'};}close(){}
  }
  const instance=probe({http:{createServer:()=>new Server()}});
  instance.mainInspectorHost='127.42.7.9';instance.localBridgeToken='owner';
  const first=await instance.ensureLocalBridgeServer(),second=await instance.ensureLocalBridgeServer();
  assert.deepEqual(binds,[{port:0,host:'127.42.7.9'}]);assert.deepEqual(first,second);
  assert.equal(first.host,'127.42.7.9');assert.equal(first.port,43123);
});
test('an unverified bridge address cannot start any listener',async()=>{
  const instance=probe({http:{createServer:()=>assert.fail('unverified bind')}});
  await assert.rejects(instance.ensureLocalBridgeServer(),/before verifying/);
});
test('warm main reconnect probes its verified endpoint without an OS process scan or activation',async()=>{
  class Socket{static OPEN=1;constructor(){throw Error('stop before connection');}}
  let probes=0;
  const instance=probe({WebSocket:Socket,acquireMainInspector:async(_pid:number,options:any)=>options.discover()});
  Object.assign(instance,{mainInspectorTarget:{pid:4242,url:'ws://127.42.7.9:43123/id'},findMainPid:async()=>4242,
    probeInspectorInfo:async()=>{probes++;return{pid:4242};},findInspectorWebSocketForPid:()=>assert.fail('OS listener rescan')});
  await assert.rejects(instance.inject(),/stop before connection/);
  assert.equal(probes,1);assert.equal(instance.mainInspectorHost,'127.42.7.9');
});
