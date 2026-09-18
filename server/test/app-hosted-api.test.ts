import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startAppStdioGateway } from '../src/app-platform/runtime/stdio-gateway.ts';
import { createAppStdioApiTransport, APP_STDIO_API_PREFIX } from '../src/app-platform/runtime/stdio-api.ts';
import { createHostedAppApi } from '../src/app-platform/runtime/hosted-api.ts';
import type { AppInstallation } from '../src/app-platform/registry/model.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('duplex API and gateway coexist without credentials or identity on wire', async () => {
 const stdout = new PassThrough(), stdin = new PassThrough(); const lines: string[] = [];
 stdin.on('data', chunk => lines.push(chunk.toString()));
 const session = startAppStdioGateway({appId:'demo',serviceCredential:'host-secret',stdout,stdin,
  gateway:{invokeService:async()=>({version:'1.0',requestId:'r',traceId:'t',result:true}),drain:async()=>{}}});
 const call = session.api.invoke({handler:'read',method:'GET',path:'/read',payload:{x:1}});
 await tick(); const frame=JSON.parse(lines[0].slice(APP_STDIO_API_PREFIX.length));
 assert.deepEqual(Object.keys(frame).sort(),['id','request']); assert.ok(!lines[0].includes('host-secret'));
 stdout.write(APP_STDIO_API_PREFIX+JSON.stringify({id:frame.id,result:{ok:true}})+'\n');
 assert.equal((await call as {ok:boolean}).ok,true);
 stdout.write('AFC_GATEWAY_V1 '+JSON.stringify({id:'45000000-0000-4000-8000-000000000001',request:{}})+'\n');
 await tick();assert.ok(lines[1].startsWith('AFC_GATEWAY_V1 '));await session.stop();
});
test('timeout and closed streams retain actual-work drain until trusted container stop',async()=>{
 const transport=createAppStdioApiTransport(async()=>{},()=>{},5);
 const call=transport.invoke({handler:'write',method:'POST',path:'/write',payload:null});
 await assert.rejects(call,error => (error as {writeOutcome:string}).writeOutcome==='unknown');
 transport.close();let drained=false;const drain=transport.drain().then(()=>{drained=true;});await tick();assert.equal(drained,false);
 transport.confirmContainerStopped();await drain;assert.equal(drained,true);
});
test('late replies release timed out work; unknown replies close without pretending pending work settled',async()=>{
 let frame:{id:string}|undefined;let closed=false;
 const transport=createAppStdioApiTransport(async value=>{frame=value as {id:string};},()=>{closed=true;},5);
 await assert.rejects(transport.invoke({handler:'read',method:'GET',path:'/',payload:null}),/TIMEOUT/);
 transport.accept({id:frame!.id,result:true});await transport.drain();
 transport.accept({id:frame!.id,result:true});assert.equal(closed,true);
 await assert.rejects(transport.invoke({handler:'read',method:'GET',path:'/',payload:null}),/CLOSED/);
});
function fixture(withManagement=false,withBusiness=false) {
 const now=new Date().toISOString();let allowed=true, management=true, calls=0, resolves=0;
 let installation:AppInstallation={id:'42000000-0000-4000-8000-000000000001',appId:'demo',enabled:true,revision:1,grants:[],serviceIdentityId:null,createdAt:now,updatedAt:now,manifest:{
 manifestVersion:'1.0',id:'demo',version:'1.0.0',name:'Demo',description:'Test app',publisherId:'example',compatibility:{platform:{minInclusive:'0.0.1-alpha.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:['app.demo.use'],defined:withManagement?[{code:'app.demo.manage',description:'Management'}]:[]},ui:{mode:'none'},backend:{mode:'isolated',runtime:'node',entryArtifactId:'back',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:10}},storage:{mode:'none'},routes:[],api:[{id:'read',method:'GET',path:'/read',handler:'read',permission:'app.demo.use'}],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],network:{frontendOrigins:[],backendOrigins:[]},resources:[],artifacts:[{id:'back',kind:'backend',path:'back.js',sha256:'a'.repeat(64),bytes:1}]}};
 const actor={actorType:'person',person:{id:'42000000-0000-4000-8000-000000000002',organization:{id:'42000000-0000-4000-8000-000000000003'}},trustedIdentity:{source:'wecom',externalUserId:'user'},execution:{type:'platform'},request:{requestId:'r',traceId:'t',startedAt:now},authorize:async()=>({allowed})} as unknown as PlatformActorContext;
 let businessRevision='42000000-0000-4000-8000-000000000099';
 let sent:unknown;
 let execute=async()=>({ok:true});
 const api=createHostedAppApi({installation,...(withBusiness?{businessAuthorization:async()=>({revision:businessRevision,grants:[{permission:'app.demo.manage',all:false,self:true,organizationIds:[]}],organizations:[]})}:{}),getInstallation:async()=>installation,contextResolver:{resolve:async()=>{resolves++;return {...actor,execution:{type:'application',appId:'demo'}} as PlatformActorContext;}},authorize:async(_actor,permission)=>allowed&&(permission!=='app.demo.manage'||management),
 transport:{invoke:async request=>{sent=request;calls++;return execute();},drain:async()=>{}}});
 return {api,actor,revokeScope:()=>{businessRevision='42000000-0000-4000-8000-000000000098';},request:{apiId:'read',method:'GET',path:'/read',payload:{}},reorderManifest:()=>{installation={...installation,manifest:Object.fromEntries(Object.entries(installation.manifest).reverse()) as any};},revokeManagement:()=>{management=false;},get sent(){return sent;},get calls(){return calls;},get resolves(){return resolves;},disable:()=>{installation={...installation,enabled:false};},deny:()=>{allowed=false;},execute:(fn:typeof execute)=>{execute=fn;}};
}
test('API requires exact declared route and method and fresh delegated authorization',async()=>{
 const f=fixture();await assert.rejects(f.api.invoke(f.actor,{...f.request,method:'POST'}),/API_DENIED/);
 await assert.rejects(f.api.invoke(f.actor,{...f.request,path:'/read?all=1'}),/API_DENIED/);assert.equal(f.calls,0);
 assert.equal((await f.api.invoke(f.actor,f.request) as {ok:boolean}).ok,true);assert.equal(f.resolves,2);
 f.deny();await assert.rejects(f.api.invoke(f.actor,f.request),/ACCESS_DENIED/);assert.equal(f.calls,1);
 f.api.close();await f.api.drain();
});
test('revocation during app execution suppresses results and reports unknown outcome',async()=>{
 for(const revoke of ['disable','deny'] as const){const f=fixture();f.execute(async()=>{f[revoke]();return {ok:true};});
 await assert.rejects(f.api.invoke(f.actor,f.request),error=>(error as {writeOutcome:string}).writeOutcome==='unknown');
 f.api.close();await f.api.drain();}
});

test('host derives employee context separately from untrusted payload and never forwards login identity',async()=>{
 const f=fixture();
 await f.api.invoke(f.actor,{...f.request,payload:{employee:{personId:'forged'},trustedIdentity:{userId:'forged'}}});
 const sent=f.sent as {employee:unknown};
 assert.deepEqual(sent.employee,{version:'1.0',personId:'42000000-0000-4000-8000-000000000002',organizationUnitId:'42000000-0000-4000-8000-000000000003',requestId:'r',traceId:'t',permissions:[]});
 assert.equal(JSON.stringify(sent.employee).includes('externalUserId'),false);
 f.api.close();await f.api.drain();
});
test('employee or organization replacement during execution suppresses the result',async()=>{
 for(const field of ['person','organization']){
  const f=fixture();f.execute(async()=>{
   if(f.actor.actorType==='person'){
    if(field==='person')f.actor.person.id='42000000-0000-4000-8000-000000000004';
    else f.actor.person.organization.id='42000000-0000-4000-8000-000000000004';
   }
   return {ok:true};
  });
  await assert.rejects(f.api.invoke(f.actor,f.request),error=>(error as {code:string;writeOutcome:string}).code==='ACCESS_DENIED'&&(error as {writeOutcome:string}).writeOutcome==='unknown');
  f.api.close();await f.api.drain();
 }
});

test('revoking an additional host permission during a read-authorized call invalidates the privileged snapshot',async()=>{
 const f=fixture(true);f.execute(async()=>{assert.deepEqual((f.sent as any).employee.permissions,['app.demo.manage']);f.revokeManagement();return {ok:true};});
 await assert.rejects(f.api.invoke(f.actor,f.request),error=>(error as any).code==='ACCESS_DENIED'&&(error as any).writeOutcome==='unknown');
 f.api.close();await f.api.drain();
});

test('database JSON key ordering does not invalidate an unchanged API manifest',async()=>{const f=fixture();f.reorderManifest();assert.equal((await f.api.invoke(f.actor,f.request) as {ok:boolean}).ok,true);f.api.close();await f.api.drain();});

test('business scope revision change invalidates an in-flight call even when permission names remain unchanged',async()=>{
 const f=fixture(true,true);f.execute(async()=>{f.revokeScope();return {ok:true};});
 await assert.rejects(f.api.invoke(f.actor,f.request),error=>(error as any).code==='ACCESS_DENIED'&&(error as any).writeOutcome==='unknown');
 f.api.close();await f.api.drain();
});
