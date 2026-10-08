import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '../../extension';

function request(url: string, payload: unknown): Promise<any> {
  return new Promise((resolve,reject) => {
    const body=JSON.stringify(payload);
    const req=http.request(url,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve(JSON.parse(text));}catch(error){reject(error);}});
    });
    req.on('error',reject);req.end(body);
  });
}

suite('MCP response efficiency', () => {
  test('default responses send one lossless JSON copy and rich mode remains explicit', async function () {
    this.timeout(60_000);
    const ext=vscode.extensions.getExtension<ExtensionTestApi>('newdlops.intellij-styled-search');
    assert.ok(ext);
    const api=await ext!.activate();
    const folder=vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    const file=vscode.Uri.joinPath(folder!.uri,'mcp-output-fixture.ts');
    const content='export function combine(first: number, second: number): number {\n  return first + second;\n}\nexport const total = combine(1, 2);\n';
    await vscode.workspace.fs.writeFile(file,Buffer.from(content));
    try {
      await api.callGraph.rebuild(undefined,undefined,{force:true});
      const url=await api.mcpServer.start(0);
      let id=1;
      const call=(name:string,args:Record<string,unknown>)=>request(url,{jsonrpc:'2.0',id:id++,method:'tools/call',params:{name,arguments:args}});
      const symbols=await call('codeidx_search_symbols',{query:'combine',match:'exact',languages:['typescript']});
      assert.equal(symbols.result.structuredContent,undefined);
      const result=JSON.parse(symbols.result.content[0].text);
      const symbol=result.results.find((item:any)=>item.name==='combine' && JSON.stringify(item).includes('mcp-output-fixture.ts'));
      assert.ok(symbol,JSON.stringify(result));
      const symbolId=symbol.symbol_id;
      assert.ok(typeof symbolId==='string');
      const cases:Array<[string,Record<string,unknown>]>=[
        ['codeidx_workspace_overview',{}],['codeidx_index_status',{}],
        ['codeidx_search_symbols',{query:'combine',match:'exact',languages:['typescript']}],
        ['codeidx_outline',{file:'mcp-output-fixture.ts'}],
        ['codeidx_resolve_at',{file:'mcp-output-fixture.ts',line:1,character_utf16:16}],
        ['codeidx_signature',{symbol_id:symbolId}],['codeidx_symbol_details',{symbol_id:symbolId}],
        ['codeidx_find_references',{symbol_id:symbolId,group_by:'none',limit:1}],
        ['codeidx_find_implementations',{symbol_id:symbolId}],
        ['codeidx_graph_neighbors',{symbol_id:symbolId}],
        ['codeidx_get_context_bundle',{task:'understand combine',seed_symbols:[symbolId],token_budget:1000}],
        ['codeidx_read_snippets',{snippets:[{file:'mcp-output-fixture.ts',start_line:1,end_line:4}]}],
        ['codeidx_explain_search_query',{query:'combine'}],
        ['codeidx_count',{query:'combine',file_globs:['mcp-output-fixture.ts']}],
        ['mcp_health',{include_agent_policy:true}],
      ];
      const metrics:any[]=[];
      for(const [name,args] of cases) {
        const response=await call(name,args);
        const wire=response.result;
        assert.equal(wire.isError,false,JSON.stringify(response));
        assert.equal(wire.structuredContent,undefined,`${name} must avoid default duplication`);
        const envelope=JSON.parse(wire.content[0].text);
        assert.equal(envelope.ok,true,name);
        assert.ok('warnings' in envelope && 'truncated' in envelope && 'next_cursor' in envelope,
          `${name} must preserve warnings and continuation metadata`);
        const rich=await call(name,{...args,structured:true});
        assert.deepEqual(JSON.parse(rich.result.content[0].text),rich.result.structuredContent,
          `${name} rich JSON must remain fully mirrored for structured clients`);
        assert.equal(envelope.summary,rich.result.structuredContent.summary,name);
        // Reconstruct the old default from the exact current envelope, so
        // changing timings/IDs cannot inflate the measured savings.
        const old={...response,result:{...wire,structuredContent:envelope}};
        const before=JSON.stringify(old),after=JSON.stringify(response);
        assert.ok(Buffer.byteLength(after)<Buffer.byteLength(before)*0.65,`${name} must measurably reduce wire size`);
        metrics.push({tool:name,beforeBytes:Buffer.byteLength(before),afterBytes:Buffer.byteLength(after),before,after,
          modelTextBefore:wire.content[0].text+'\n'+JSON.stringify(envelope),modelTextAfter:wire.content[0].text});
        if(name==='codeidx_read_snippets') {
          assert.ok(envelope.snippets[0].text.includes('return first + second;'));
          assert.deepEqual(envelope.snippets.map((s:any)=>s.text),rich.result.structuredContent.snippets.map((s:any)=>s.text));
        }
        if(name==='codeidx_find_references') {
          assert.deepEqual(envelope.groups,rich.result.structuredContent.groups);
          assert.deepEqual(envelope.usage_contract,rich.result.structuredContent.usage_contract);
        }
      }
      const output=path.resolve(__dirname,'../../../artifacts/mcp-efficiency');
      await fs.promises.mkdir(output,{recursive:true});
      await fs.promises.writeFile(path.join(output,'responses.json'),JSON.stringify({metrics},null,2));
      const listing=await request(url,{jsonrpc:'2.0',id:id++,method:'tools/list'});
      for(const [name] of cases) assert.equal(listing.result.tools.find((t:any)=>t.name===name).inputSchema.properties.structured.default,false);
    } finally {
      await vscode.workspace.fs.delete(file);
      await api.callGraph.refreshChangedFiles([file],'mcp-response-fixture-cleanup');
    }
  });
});
