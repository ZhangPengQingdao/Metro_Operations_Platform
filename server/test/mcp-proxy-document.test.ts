import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createMcpProxyDocument,createMcpProxyHandler} from '../src/app-platform/mcp-apps/proxy-document.ts';

function fixture() {
 const page=createMcpProxyDocument('https://platform.example');
 const script=page.html.match(/<script>([\s\S]*)<\/script>/)![1];
 const hostMessages:unknown[][]=[];const childMessages:unknown[][]=[];
 const parent={postMessage:(...args:unknown[])=>hostMessages.push(args)};
 let listener: ((event:unknown)=>void)|undefined;let load:(()=>void)|undefined;let removed=false;
 const attrs:Record<string,string>={};
 const child={postMessage:(...args:unknown[])=>childMessages.push(args)};
 const frame={contentWindow:child,srcdoc:'',setAttribute:(key:string,value:string)=>{attrs[key]=value;},
  addEventListener:(_key:string,callback:()=>void)=>{load=callback;},remove:()=>{removed=true;}};
 const window={parent,addEventListener:(_key:string,callback:(event:unknown)=>void)=>{listener=callback;},removeEventListener:()=>{listener=undefined;}};
 runInNewContext(script,{window,document:{createElement:(tag:string)=>tag==='meta'?{outerHTML:'<meta data-policy="test">',setAttribute(){}}:frame,body:{append:()=>{}}},TextEncoder});
 const emit=(data:unknown,source:unknown=parent,origin='https://platform.example')=>listener?.({data,source,origin});
 const ready={jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html:'<!doctype html><html></html>',sandbox:'allow-scripts allow-same-origin'}};
 return {page,emit,ready,parent,child,frame,attrs,hostMessages,childMessages,load:()=>load?.(),get removed(){return removed;}};
}

test('proxy emits official readiness and pins opaque inner frame restrictions',()=>{
 const f=fixture();assert.equal((f.hostMessages[0][0] as {method:string}).method,'ui/notifications/sandbox-proxy-ready');
 assert.equal(f.hostMessages[0][1],'https://platform.example');
 f.emit(f.ready,{},'https://platform.example');assert.equal(f.frame.srcdoc,'');
 f.emit(f.ready,f.parent,'https://other.example');assert.equal(f.frame.srcdoc,'');
 f.emit(f.ready);assert.ok(f.frame.srcdoc.endsWith(f.ready.params.html));assert.ok(f.frame.srcdoc.indexOf('<meta')<f.frame.srcdoc.indexOf('<html>'));
 assert.equal(f.attrs.sandbox,'allow-scripts');assert.match(f.attrs.allow,/camera 'none'/);
 const message={jsonrpc:'2.0',id:1,method:'ui/initialize'};
 f.emit(message,f.child,'https://isolated.example');assert.equal(f.hostMessages.length,1);
 f.emit(message,f.child,'null');assert.equal(f.hostMessages.length,2);
 f.emit({jsonrpc:'2.0',id:1,result:{}});assert.equal(f.childMessages[0][1],'*');
});

test('repeated inner navigation and forged proxy readiness revoke the view',()=>{
 const f=fixture();f.emit(f.ready);f.load();assert.equal(f.removed,false);f.load();assert.equal(f.removed,true);
 const g=fixture();g.emit(g.ready);g.emit({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready'},g.child,'null');
 assert.equal(g.removed,true);
 assert.equal((g.hostMessages.at(-1)![0] as {method:string}).method,'ui/notifications/request-teardown');
 const h=fixture();h.emit(h.ready);h.emit(h.ready);assert.equal(h.removed,true);
});

test('proxy response enforces offline CSP, no caching, and denied devices',()=>{
 const {headers}=createMcpProxyDocument('https://platform.example');
 assert.match(headers['content-security-policy'],/connect-src 'none'/);
 assert.match(headers['content-security-policy'],/frame-ancestors https:\/\/platform.example/);
 assert.match(headers['content-security-policy'],/base-uri 'none'; form-action 'none'/);
 assert.equal(headers['cache-control'],'no-store');assert.match(headers['permissions-policy'],/camera=\(\)/);
 for(const origin of ['http://platform.example','https://platform.example/','https://user:pass@platform.example'])assert.throws(()=>createMcpProxyDocument(origin));
});

test('isolated responder emits real security headers only for its fixed route and host',async()=>{
 const handle=createMcpProxyHandler({hostOrigin:'https://platform.example',proxyOrigin:'https://isolated.example'});
 const response=handle(new Request('https://isolated.example/mcp-apps/proxy'));
 assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')!,/connect-src 'none'/);
 assert.match(await response.text(),/sandbox-proxy-ready/);assert.equal(response.headers.get('set-cookie'),null);
 for(const url of ['https://platform.example/mcp-apps/proxy','https://isolated.example/other','https://isolated.example/mcp-apps/proxy?x=1'])assert.equal(handle(new Request(url)).status,404);
 assert.equal(handle(new Request('https://isolated.example/mcp-apps/proxy',{method:'POST'})).status,405);
 assert.equal(await handle(new Request('https://isolated.example/mcp-apps/proxy',{method:'HEAD'})).text(),'');
 assert.throws(()=>createMcpProxyHandler({hostOrigin:'https://platform.example',proxyOrigin:'https://platform.example:444'}));
});
