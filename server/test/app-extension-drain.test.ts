import test from 'node:test';
import assert from 'node:assert/strict';
import {AppExtensionRegistry,type AppExtensionMapping} from '../src/app-platform/extensions/index.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
const permission='app.demo.use';
function fixture(limits={}) {
 let allowed=true,calls=0;
 const now=new Date().toISOString();
 let installation:AppInstallation={id:'42000000-0000-4000-8000-000000000001',appId:'demo',enabled:true,revision:1,grants:[],serviceIdentityId:'service',createdAt:now,updatedAt:now,manifest:{
 manifestVersion:'1.0',id:'demo',version:'1.0.0',name:'Demo',description:'Test app',publisherId:'example',compatibility:{platform:{minInclusive:'0.0.1-alpha.1',maxExclusive:'2.0.0'},capabilities:[{id:'platform-mcp',contractVersion:'2.0'}],applications:[]},permissions:{requested:[permission],defined:[]},ui:{mode:'sandbox',entryArtifactId:'front'},backend:{mode:'external',origin:'https://example.com'},storage:{mode:'none'},routes:[{id:'home',path:'/',permission}],api:[],navigation:[{id:'home',label:'Home',routeId:'home',order:1}],events:{publish:['app.demo.changed.v1'],subscribe:[{event:'platform.assets.changed.v1',handler:'changed'}]},tools:[{name:'read',contributionArtifactId:'tools'}],jobs:[{id:'sync',handler:'sync',intervalSeconds:60}],network:{frontendOrigins:[],backendOrigins:[]},resources:[],artifacts:[{id:'front',kind:'frontend',path:'front.js',sha256:'a'.repeat(64),bytes:1},{id:'tools',kind:'mcp-contribution',path:'tools.json',sha256:'b'.repeat(64),bytes:1}]}};
 const actor:PlatformActorContext={actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId:'demo',serviceIdentityId:'service'},request:{requestId:'r',traceId:'t',startedAt:now},authorize:async()=>({allowed} as Awaited<ReturnType<PlatformActorContext['authorize']>>)};
 const mappings:AppExtensionMapping[]=[{kind:'event-publish',id:'app.demo.changed.v1',operation:'events.publish',permissionCode:permission},{kind:'event-subscribe',id:'platform.assets.changed.v1',operation:'events.consume',permissionCode:permission},{kind:'job',id:'sync',operation:'jobs.sync',permissionCode:permission},{kind:'route',id:'home',permissionCode:permission},{kind:'tool',id:'read',operation:'tools.read',permissionCode:permission}];
 let execute:(_operation:string,_payload:unknown,_signal:AbortSignal)=>Promise<unknown>=async()=>({content:[{type:'text',text:'ok'}]});
 const registry=new AppExtensionRegistry({getInstallation:async()=>installation,authorize:async()=>allowed,executeGateway:async(_ctx,operation,payload,signal)=>{calls++;return execute(operation,payload,signal);},limits});
 const handle=registry.activate(installation,mappings);
 return {registry,handle,actor,mappings,get installation(){return installation;},setInstallation:(i:AppInstallation)=>installation=i,setAllowed:(v:boolean)=>allowed=v,setExecute:(fn:typeof execute)=>execute=fn,get calls(){return calls;}};
}

test('drain requires deactivation and waits past caller timeout for actual work',async()=>{
 const f=fixture({timeoutMs:10});let settle!:(v:unknown)=>void;
 f.setExecute(async()=>new Promise(resolve=>{settle=resolve;}));
 await assert.rejects(f.handle.drain(),/DRAIN_REQUIRES_DEACTIVATION/);
 await assert.rejects(f.handle.invoke(f.actor,'job','sync',{}),/TIMEOUT/);
 f.handle.deactivate();let drained=false;
 const drain=f.handle.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 settle({});await drain;assert.equal(drained,true);
 await assert.rejects(f.handle.invoke(f.actor,'job','sync',{}),/STALE_EXTENSION/);
});
test('drain is generation-local and includes pending authorization work',async()=>{
 const f=fixture();let settle!:(v:unknown)=>void;
 f.setExecute(async()=>new Promise(resolve=>{settle=resolve;}));
 const old=f.handle.invoke(f.actor,'job','sync',{});const rejected=assert.rejects(old,/STALE_EXTENSION/);
 await new Promise(resolve=>setImmediate(resolve));
 const next=f.registry.activate(f.installation,f.mappings);await rejected;
 next.deactivate();await next.drain();
 let drained=false;const waiting=f.handle.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);settle({});await waiting;
 let release!:()=>void;
 const registry=new AppExtensionRegistry({getInstallation:async()=>{await new Promise<void>(resolve=>{release=resolve;});return f.installation;},authorize:async()=>true,executeGateway:async()=>({})});
 const handle=registry.activate(f.installation,f.mappings);
 const listing=handle.list(f.actor);const caught=assert.rejects(listing,/STALE_EXTENSION/);
 await new Promise(resolve=>setImmediate(resolve));handle.deactivate();await caught;
 drained=false;const pending=handle.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);release();await pending;
});
