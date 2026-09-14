import test from 'node:test';
import assert from 'node:assert/strict';
import {AppExtensionRegistry,attachAppEventSubscriptions,createAppJobDefinitions,listAppNavigation,createAppMcpToolRegistrations,createAppEventPublication,type AppExtensionMapping} from '../src/app-platform/extensions/index.ts';
import {createCoreEventBus,createCoreEvent} from '../src/core/events/index.ts';
import {createCoreJobRuntime} from '../src/core/jobs/index.ts';
import {createCoreMcpHandler,MCP_PROTOCOL_VERSION} from '../src/core/integrations/mcp/index.ts';
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
test('exact mappings, immutable navigation and atomic replacement validation',async()=>{
 const f=fixture();assert.equal((await f.handle.list(f.actor)).length,5);assert.ok(Object.isFrozen(f.handle.descriptors));
 assert.equal((await listAppNavigation(f.handle,f.actor))[0].path,'/platform/apps/demo');
 assert.equal((await listAppNavigation(f.handle,f.actor))[0].id,'demo:home');
 for(const mappings of [f.mappings.slice(1),[...f.mappings,f.mappings[0]],f.mappings.map(m=>({...m,permissionCode:'platform.admin'}))])assert.throws(()=>f.registry.activate(f.installation,mappings));
 await f.handle.invoke(f.actor,'tool','read',{});assert.equal(f.calls,1);
 f.setAllowed(false);assert.equal((await listAppNavigation(f.handle,f.actor)).length,0);await assert.rejects(f.handle.invoke(f.actor,'tool','read',{}),/ACCESS_DENIED/);
});
test('disabled, revised, replaced and wrong-app identities cannot invoke stale callbacks',async()=>{
 for(const change of ['disabled','revision','version','identity']){
  const f=fixture();f.setInstallation({...f.installation,...(change==='disabled'?{enabled:false}:change==='revision'?{revision:2}:change==='version'?{manifest:{...f.installation.manifest,version:'2.0.0'}}:{serviceIdentityId:'new'})});
  await assert.rejects(f.handle.invoke(f.actor,'tool','read',{}),/STALE_EXTENSION|ACCESS_DENIED/);assert.equal(f.calls,0);
 }
 const f=fixture();const next=f.registry.activate(f.installation,f.mappings);await assert.rejects(f.handle.list(f.actor),/STALE_EXTENSION/);await next.list(f.actor);
 await assert.rejects(next.invoke({...f.actor,execution:{type:'service',appId:'other',serviceIdentityId:'service'}},'tool','read',{}),/ACCESS_DENIED/);
});
test('revoke during execute suppresses results and duplicate/uncertain delivery never executes twice',async()=>{
 const f=fixture();f.setExecute(async()=>{f.setAllowed(false);return {};});await assert.rejects(f.handle.invoke(f.actor,'job','sync',{}),/ACCESS_DENIED/);
 f.setAllowed(true);f.setExecute(async()=>{throw new Error('secret');});await assert.rejects(f.handle.invoke(f.actor,'event-subscribe','platform.assets.changed.v1',{},undefined,'event-1'),/EXTENSION_FAILED/);
 await assert.rejects(f.handle.invoke(f.actor,'event-subscribe','platform.assets.changed.v1',{},undefined,'event-1'),/DUPLICATE_DELIVERY/);assert.equal(f.calls,2);
});
test('timeout and deactivation abort pending work while retaining concurrency',async()=>{
 const f=fixture({timeoutMs:10,concurrency:1});let settle!:(v:unknown)=>void;let aborted=false;
 f.setExecute(async(_op,_p,signal)=>new Promise(resolve=>{settle=resolve;signal.addEventListener('abort',()=>aborted=true);}));
 await assert.rejects(f.handle.invoke(f.actor,'job','sync',{}),/TIMEOUT/);assert.ok(aborted);await assert.rejects(f.handle.list(f.actor),/BUSY/);
 settle({});await new Promise(resolve=>setImmediate(resolve));await f.handle.list(f.actor);
 const pending=f.handle.invoke(f.actor,'job','sync',{});await new Promise(resolve=>setImmediate(resolve));f.handle.deactivate();await assert.rejects(pending,/STALE_EXTENSION/);settle({});
});
test('payload snapshot and dedupe capacity remain bounded',async()=>{
 const f=fixture({dedupeEntries:1});let captured:unknown;f.setExecute(async(_op,payload)=>{captured=payload;return {};});const input={value:1};const pending=f.handle.invoke(f.actor,'job','sync',input,undefined,'one');input.value=2;await pending;assert.equal((captured as {value:number}).value,1);
 await assert.rejects(f.handle.invoke(f.actor,'job','sync',{},undefined,'two'),/DEDUPE_FULL/);
 await assert.rejects(f.handle.invoke(f.actor,'tool','read',{x:'x'.repeat(65536)}));
});
test('actual EventBus subscriptions stop, dedupe and reject stale handles',async()=>{
 const f=fixture(),bus=createCoreEventBus();const attached=attachAppEventSubscriptions(f.handle,bus,async()=>f.actor);
 const event=createCoreEvent({type:'platform.assets.changed.v1',source:'platform.assets',payload:{id:'sample'}});
 await bus.publish(event);assert.equal(f.calls,1);await assert.rejects(bus.publish(event),/DUPLICATE_DELIVERY/);
 attached.stop();await bus.publish(event);assert.equal(f.calls,1);
 const second=attachAppEventSubscriptions(f.handle,bus,async()=>f.actor);f.handle.deactivate();await assert.rejects(bus.publish(event),/STALE_EXTENSION/);second.stop();
});
test('actual Core Jobs invokes once and old definition rejects after deactivate',async()=>{
 const f=fixture(),runtime=createCoreJobRuntime();const definitions=createAppJobDefinitions(f.handle,async()=>f.actor);runtime.register(...definitions);const key=definitions[0].id;
 assert.equal((await runtime.run(key)).status,'succeeded');assert.equal(f.calls,1);f.handle.deactivate();assert.notEqual((await runtime.run(key)).status,'succeeded');assert.equal(f.calls,1);await runtime.stop();
});
test('event publication derives envelope source from bound application',async()=>{
 const f=fixture(),bus=createCoreEventBus();let source='';bus.subscribe('app.demo.changed.v1',event=>{source=event.source;});
 const op=createAppEventPublication({appId:'demo',eventType:'app.demo.changed.v1',operation:'events.publish',permissionCode:permission,bus,validatePayload:()=>true,resolveResources:async()=>[{}]});
 await op.execute(f.actor,{source:'forged'},new AbortController().signal);assert.equal(source,'app.demo');
 await assert.rejects(op.execute({...f.actor,execution:{type:'service',appId:'other',serviceIdentityId:'service'}},{},new AbortController().signal));
});
test('modern MCP host invokes registered tool and old host callback fails after revocation',async()=>{
 const f=fixture();const tools=createAppMcpToolRegistrations(f.handle,new Map([['read',{name:'app_demo__read',inputSchema:{type:'object',properties:{},additionalProperties:false}}]]),async()=>f.actor);
 const host=createCoreMcpHandler({serverInfo:{name:'extensions',version:'1.0.0'},tools,allowedHosts:['mcp.test'],allowedOrigins:['mcp.test'],authenticate:async()=>({token:'fixture',clientId:'fixture',scopes:[]})});
 const request=()=>new Request('https://mcp.test/mcp',{method:'POST',headers:{host:'mcp.test','content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':'app_demo__read'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'app_demo__read',arguments:{},_meta:{'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
 try{const res=await host.fetch(request());const value=await res.json();assert.equal(value.result.content[0].text,'ok');assert.equal(f.calls,1);f.handle.deactivate();const stale=await (await host.fetch(request())).json();assert.ok(stale.error||stale.result?.isError);assert.equal(f.calls,1);}finally{await host.close();}
});

test('reentrant abort cannot resurrect an overwritten generation',async()=>{
 const f=fixture();let newest:ReturnType<typeof f.registry.activate>|undefined;
 f.setExecute(async(_op,_payload,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>{
  newest=f.registry.activate(f.installation,f.mappings);resolve({});
 },{once:true})));
 const pending=f.handle.invoke(f.actor,'job','sync',{});await new Promise(resolve=>setImmediate(resolve));
 assert.throws(()=>f.registry.activate(f.installation,f.mappings),/STALE_EXTENSION/);
 await assert.rejects(pending,/STALE_EXTENSION/);assert.ok(newest);await newest.list(f.actor);
});

test('application namespaces coexist and registry capacity fails before replacement',async()=>{
 const f=fixture({installations:2});
 const other={...f.installation,id:'42000000-0000-4000-8000-000000000002',appId:'other',manifest:{...f.installation.manifest,id:'other',events:{...f.installation.manifest.events,publish:['app.other.changed.v1']}}};
 const mappings=f.mappings.map(m=>m.kind==='event-publish'?{...m,id:'app.other.changed.v1'}:m);
 const handle=f.registry.activate(other,mappings);
 assert.equal(new Set([...f.handle.descriptors,...handle.descriptors].map(d=>d.key)).size,10);
 assert.notEqual(createAppJobDefinitions(f.handle,async()=>f.actor)[0].id,createAppJobDefinitions(handle,async()=>f.actor)[0].id);
 const third={...other,id:'third',appId:'third',manifest:{...other.manifest,id:'third',events:{...other.manifest.events,publish:['app.third.changed.v1']}}};
 assert.throws(()=>f.registry.activate(third,mappings.map(m=>m.kind==='event-publish'?{...m,id:'app.third.changed.v1'}:m)),/REGISTRY_FULL/);
 await f.handle.list(f.actor);
});

test('long manifest interval is rejected before Node can clamp it to 1ms',()=>{
 const f=fixture();const installation={...f.installation,manifest:{...f.installation.manifest,jobs:[{id:'sync',handler:'sync',intervalSeconds:31_536_000}]}};
 const handle=f.registry.activate(installation,f.mappings);
 assert.throws(()=>createAppJobDefinitions(handle,async()=>f.actor),/EXTENSION_ADAPTER_INVALID/);
});
