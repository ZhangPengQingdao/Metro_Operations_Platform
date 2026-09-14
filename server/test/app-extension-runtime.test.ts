import test from 'node:test';
import {startAppExtensionRuntime,AppExtensionRuntimeStartError} from '../src/app-platform/extensions/runtime.ts';
import {CoreJobRuntime} from '../src/core/jobs/index.ts';
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
function deferred<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
const event=()=>createCoreEvent({type:'platform.assets.changed.v1',source:'platform.assets',payload:{id:'sample'}});
const request=()=>new Request('https://mcp.test/mcp',{method:'POST',headers:{host:'mcp.test','content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':'app_demo__read'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'app_demo__read',arguments:{},_meta:{'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
test('owned actual Core events, Jobs and modern MCP stop together and cannot overlap',async()=>{
 const f=fixture(),bus=createCoreEventBus();let jobs!:CoreJobRuntime;
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,createJobs:()=>jobs=createCoreJobRuntime(),createMcpHost:handle=>createCoreMcpHandler({serverInfo:{name:'runtime',version:'1'},tools:createAppMcpToolRegistrations(handle,new Map([['read',{name:'app_demo__read',inputSchema:{type:'object',properties:{},additionalProperties:false}}]]),async()=>f.actor),allowedHosts:['mcp.test'],allowedOrigins:['mcp.test'],authenticate:async()=>({token:'fixture',clientId:'fixture',scopes:[]})})});
 try {
  assert.equal(f.calls,0);await bus.publish(event());assert.equal(f.calls,1);
  assert.equal((await jobs.run(jobs.list()[0].id)).status,'succeeded');assert.equal(f.calls,2);
  assert.equal((await (await session.fetch(request())).json()).result.content[0].text,'ok');assert.equal(f.calls,3);
  const next=f.registry.activate(f.installation,f.mappings);
  await assert.rejects(startAppExtensionRuntime({drainGateway:async()=>{},handle:next,bus,resolveActor:async()=>f.actor}),/BUSY/);
 } finally {await session.stop();}
 await bus.publish(event());assert.equal(f.calls,3);assert.equal((await jobs.run(jobs.list()[0].id)).skipReason,'runtime-stopped');assert.equal((await session.fetch(request())).status,503);
 await session.stop();const next=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.registry.activate(f.installation,f.mappings),bus,resolveActor:async()=>f.actor});await next.stop();
});
test('failed cleanup attempts every resource, retries only failures and retains ownership',async()=>{
 const f=fixture(),bus=createCoreEventBus();let closes=0,stops=0;
 class Jobs extends CoreJobRuntime {override async stop(){stops++;return super.stop();}}
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,createJobs:()=>new Jobs(),createMcpHost:()=>({fetch:async()=>new Response(),close:async()=>{if(++closes===1)throw new Error('private');}})});
 await assert.rejects(session.stop(),/STOP_FAILED/);assert.equal(stops,1);await bus.publish(event());assert.equal(f.calls,0);
 await assert.rejects(startAppExtensionRuntime({drainGateway:async()=>{},handle:f.registry.activate(f.installation,f.mappings),bus,resolveActor:async()=>f.actor}),/BUSY/);
 await session.stop();assert.equal(stops,1);assert.equal(closes,2);
});
test('stuck close promise is retained across timeout and retry, never started twice',async()=>{
 const f=fixture(),bus=createCoreEventBus(),close=deferred();let closes=0;
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,shutdownTimeoutMs:10,createMcpHost:()=>({fetch:async()=>new Response(),close:()=>{closes++;return close.promise;}})});
 const first=session.stop();assert.equal(first,session.stop());await assert.rejects(first,/TIMEOUT/);await assert.rejects(session.stop(),/TIMEOUT/);assert.equal(closes,1);
 close.resolve();await session.stop();assert.equal(closes,1);
});
test('actual ignored-abort extension work prevents confirmed stop after caller rejection',async()=>{
 const f=fixture(),bus=createCoreEventBus(),work=deferred<unknown>(),started=deferred();f.setExecute(async()=>{started.resolve();return work.promise;});
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,shutdownTimeoutMs:10});
 const publish=bus.publish(event());const observed=assert.rejects(publish,/STALE_EXTENSION/);await started.promise;
 await assert.rejects(session.stop(),/TIMEOUT/);await observed;work.resolve({});await session.stop();
});
test('partial subscription setup failure closes earlier subscriptions, jobs and host',async()=>{
 const f=fixture(),realBus=createCoreEventBus();let subscriptions=0,unsubscribed=0,closed=0;
 const extra={kind:'event-subscribe' as const,id:'platform.second.changed.v1',key:'demo:event-subscribe:platform.second.changed.v1',permissionCode:permission,operation:'events.consume'};
 const handle={...f.handle,descriptors:[...f.handle.descriptors,extra]};
 await assert.rejects(startAppExtensionRuntime({drainGateway:async()=>{},handle,bus:{subscribe(type,handler){if(++subscriptions===2)throw new Error('private');const s=realBus.subscribe(type,handler);return {unsubscribe(){unsubscribed++;s.unsubscribe();}};}},resolveActor:async()=>f.actor,createMcpHost:()=>({fetch:async()=>new Response(),close:async()=>{closed++;}})}),AppExtensionRuntimeStartError);
 assert.equal(unsubscribed,1);assert.equal(closed,1);await realBus.publish(event());assert.equal(f.calls,0);
 const next=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.registry.activate(f.installation,f.mappings),bus:realBus,resolveActor:async()=>f.actor});await next.stop();
});
test('failed partial startup exposes recoverable session without private errors',async()=>{
 const f=fixture(),bus=createCoreEventBus();let rejectClose=true;
 class Jobs extends CoreJobRuntime {override startInterval():never{throw new Error('private interval');}}
 let retained!:AppExtensionRuntimeStartError;
 await assert.rejects(startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,createJobs:()=>new Jobs(),createMcpHost:()=>({fetch:async()=>new Response(),close:async()=>{if(rejectClose)throw new Error('private close');}})}),error=>{assert.ok(error instanceof AppExtensionRuntimeStartError);retained=error;assert.equal(error.cause,undefined);return true;});
 assert.equal((await retained.session.fetch(request())).status,503);rejectClose=false;await retained.session.stop();
});
test('startup actor timeout retains pending work and recovery handle',async()=>{
 const f=fixture(),bus=createCoreEventBus(),actor=deferred<PlatformActorContext>();let retained!:AppExtensionRuntimeStartError;
 await assert.rejects(startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:()=>actor.promise,shutdownTimeoutMs:10}),error=>{assert.ok(error instanceof AppExtensionRuntimeStartError);retained=error;return true;});
 await assert.rejects(retained.session.stop(),/TIMEOUT/);actor.resolve(f.actor);await retained.session.stop();
});
test('stop handles synchronous reentry and Core Jobs undrained receipt requires retry',async()=>{
 const f=fixture(),bus=createCoreEventBus();let session!:Awaited<ReturnType<typeof startAppExtensionRuntime>>,reentry:Promise<void>|undefined,stops=0;
 class Jobs extends CoreJobRuntime {override async stop(){const result=await super.stop();return ++stops===1?{drained:false,remaining:1}:result;}}
 const handle={...f.handle,deactivate(){reentry=session.stop();f.handle.deactivate();}};
 session=await startAppExtensionRuntime({drainGateway:async()=>{},handle,bus,resolveActor:async()=>f.actor,createJobs:()=>new Jobs()});
 const stopping=session.stop();assert.equal(reentry,stopping);await assert.rejects(stopping,/STOP_FAILED/);await session.stop();assert.equal(stops,2);
});
test('stale installation cannot access static MCP discovery',async()=>{
 const f=fixture(),bus=createCoreEventBus();let fetches=0;
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>f.actor,createMcpHost:()=>({fetch:async()=>{fetches++;return new Response();},close:async()=>{}})});
 f.setInstallation({...f.installation,enabled:false});await assert.rejects(session.fetch(request()),/STALE_EXTENSION/);assert.equal(fetches,0);await session.stop();
});
test('pending job actor resolution stays owned through shutdown',async()=>{
 const f=fixture(),bus=createCoreEventBus(),actor=deferred<PlatformActorContext>(),started=deferred();let pending=false,jobs!:CoreJobRuntime;
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>{if(pending){started.resolve();return actor.promise;}return f.actor;},shutdownTimeoutMs:10,createJobs:()=>jobs=createCoreJobRuntime({shutdownTimeoutMs:5})});
 pending=true;const run=jobs.run(jobs.list()[0].id);await started.promise;await assert.rejects(session.stop(),/TIMEOUT/);actor.resolve(f.actor);await run;await session.stop();assert.equal(f.calls,0);
});
test('hung ingress actor resolution has bounded capacity retained until actual settlement',async()=>{
 const f=fixture(),bus=createCoreEventBus(),actor=deferred<PlatformActorContext>();let blocked=false,resolving=0;
 const session=await startAppExtensionRuntime({drainGateway:async()=>{},handle:f.handle,bus,resolveActor:async()=>{if(blocked){resolving++;return actor.promise;}return f.actor;},shutdownTimeoutMs:10,createMcpHost:()=>({fetch:async()=>new Response(),close:async()=>{}})});
 blocked=true;const outcomes:Promise<string>[]=[];
 for(let i=0;i<150;i++){outcomes.push(session.fetch(request()).then(()=> 'response',error=>error.message));await new Promise(resolve=>setImmediate(resolve));}
 assert.ok(resolving>0&&resolving<=128);await assert.rejects(session.stop(),/TIMEOUT/);actor.resolve(f.actor);const results=await Promise.all(outcomes);assert.ok(results.includes('EXTENSION_RUNTIME_BUSY'));await session.stop();
});

test('prepared runtime keeps subscriptions and MCP closed until explicit activation',async()=>{
 const f=fixture(),bus=createCoreEventBus();let resolves=0,fetches=0;
 const session=await startAppExtensionRuntime({deferActivation:true,handle:f.handle,bus,resolveActor:async()=>{resolves++;return f.actor;},drainGateway:async()=>{},createMcpHost:()=>({fetch:async()=>{fetches++;return new Response();},close:async()=>{}})});
 try{
  await bus.publish(event());assert.equal(f.calls,0);assert.equal(resolves,0);
  assert.equal((await session.fetch(new Request('http://localhost/mcp'))).status,503);assert.equal(fetches,0);
  await Promise.all([session.activate(),session.activate()]);assert.ok(resolves>0);
  await bus.publish(event());assert.equal(f.calls,1);
 }finally{await session.stop();}
 await assert.rejects(session.activate(),/INVALID/);
});

test('generation execution boundary covers events and retains actual callback after timeout',async()=>{
 const f=fixture(),bus=createCoreEventBus(),gate=deferred<unknown>(),started=deferred();let pending=0;
 f.setExecute(async()=>{started.resolve();return gate.promise;});
 const handle=f.registry.activate(f.installation,f.mappings,async work=>{pending++;try{return await work();}finally{pending--;}});
 const session=await startAppExtensionRuntime({handle,bus,resolveActor:async()=>f.actor,drainGateway:async()=>{},shutdownTimeoutMs:10});
 const publishing=bus.publish(event());const rejected=assert.rejects(publishing,/STALE_EXTENSION/);await started.promise;
 await assert.rejects(session.stop(),/TIMEOUT/);await rejected;assert.equal(pending,1);
 gate.resolve({});await session.stop();assert.equal(pending,0);
});
