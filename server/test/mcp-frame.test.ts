import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMcpView} from '../../src/app-platform/host/mcp-apps/frame.ts';

function fixture() {
 const host=Object.assign(new EventTarget(),{location:{origin:'https://platform.example'}});
 const attrs:Record<string,string>={};let removed=false;let appended=false;
 const frame=Object.assign(new EventTarget(),{contentWindow:{postMessage(){}},
  setAttribute:(key:string,value:string)=>{attrs[key]=value;},remove:()=>{removed=true;}});
 const container={ownerDocument:{defaultView:host,createElement:()=>frame},append:()=>{appended=true;}} as unknown as HTMLElement;
 const controller=new AbortController();
 const options={proxyUrl:'https://isolated.example/mcp-proxy',html:'<!doctype html><html></html>',arguments:{},result:{content:[]},signal:controller.signal};
 return {container,frame,attrs,controller,options,get removed(){return removed;},get appended(){return appended;}};
}
test('mount uses a separate proxy frame and abort removes it before pending initialization',async()=>{
 const f=fixture();const view=mountMcpView(f.container,f.options);
 assert.equal(f.appended,true);assert.equal(f.attrs.sandbox,'allow-scripts allow-same-origin');
 f.controller.abort();assert.equal(f.removed,true);assert.equal(await view.ready,'text');await view.close();
});
test('a second proxy load revokes its session',async()=>{
 const f=fixture();const view=mountMcpView(f.container,f.options);
 f.frame.dispatchEvent(new Event('load'));assert.equal(f.removed,false);
 f.frame.dispatchEvent(new Event('load'));assert.equal(f.removed,true);assert.equal(await view.ready,'text');
});
test('invalid deployments and revoked mounts fail before adding a frame',()=>{
 for(const proxyUrl of ['https://platform.example/proxy','http://isolated.example/proxy','https://isolated.example/proxy?secret=x']){
  const f=fixture();assert.throws(()=>mountMcpView(f.container,{...f.options,proxyUrl}));assert.equal(f.appended,false);
 }
 const f=fixture();f.controller.abort();assert.throws(()=>mountMcpView(f.container,f.options));assert.equal(f.appended,false);
});
