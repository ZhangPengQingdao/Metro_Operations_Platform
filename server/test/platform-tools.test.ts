import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport,ProtocolError,ProtocolErrorCode} from '@modelcontextprotocol/server';
import {AppToolService,createAppToolMcpServer,type ToolBinding} from '../src/app-platform/tools/index.ts';
import {createToolOperations} from '../src/app-platform/gateway/tools.ts';
import {AppHostV2} from '../src/app-platform/v2/host.ts';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';
import {validateAppManifestV2} from '@metro/platform-sdk/manifest';
import {createAppToolClient,isAppToolInputSchema,matchesAppToolInput} from '@metro/platform-sdk/app-tools';

const schema={type:'object' as const,properties:{status:{type:'string' as const,enum:['active','completed'],maxLength:9}},required:['status'],additionalProperties:false as const};
const base:ToolBinding={id:'query',apiId:'query',name:'查询待办',description:'查询当前员工待办',permission:'read',mode:'read',inputSchema:schema,installationId:randomUUID(),revision:1};
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'mop-tools-')),person=randomUUID(),other=randomUUID(),org=randomUUID();
 const declarations=[base,{...base,id:'bad-write',apiId:'bad-write'},{...base,id:'slow',apiId:'slow'},{...base,id:'business-failure',apiId:'business-failure'}].map(tool=>structuredClone(tool));
 let allowed=true,enabled=true,platformAllowed=true,writes=0,readAborted=false;
 let started!:()=>void;const readStarted=new Promise<void>(resolve=>{started=resolve;});
 const audit:any[]=[],reads:any[]=[];
 const record:any={id:base.installationId,appId:'demo',revision:1,enabled:true,serviceIdentityId:randomUUID(),manifest:{backend:{mode:'isolated'},permissions:{defined:[{code:'app.demo.read'}]},api:[...declarations.map(tool=>({id:tool.apiId,handler:tool.apiId,method:'POST',path:`/${tool.apiId}`,permission:'app.demo.read',businessPermission:'app.demo.read'})),{id:'agent',handler:'agent',method:'POST',path:'/agent',permission:'app.demo.read',businessPermission:'app.demo.read'}]},runtime:{model:'v2',sha256:'fixture',manifest:{tools:declarations,limits:{timeoutSeconds:5}}}};
 await writeFile(join(directory,'server.js'),`export default {kind:'mop-server',version:1,hooks:{},handlers:{
  async query(input,ctx){return {ok:true,result:await ctx.platform.invoke('fixture.read',{status:input.status})};},
  async 'bad-write'(input,ctx){return {ok:true,result:await ctx.platform.invoke('fixture.write',{})};},
  async slow(input,ctx){return {ok:true,result:await ctx.platform.invoke('fixture.slow',{})};},
  async 'business-failure'(){return {ok:false,error:{code:'READ_FAILED',writeOutcome:'not_started'}};},
  async agent(input,ctx){return ctx.platform.invoke('platform.tools.call',{transport:input.transport,toolId:'query',arguments:{status:'active'}});}
 }};`);
 const actor=(id:string)=>({actorType:'person',person:{id,name:'员工',organization:{id:org}},execution:{type:'application',appId:'demo'},request:{requestId:randomUUID(),traceId:randomUUID()},authorize:async()=>({allowed})});
 const tools=new AppToolService({catalog:async scope=>{if(!enabled||scope.appId!=='demo'||scope.personId!==person)throw new GatewayError('ACCESS_DENIED',403);return allowed?declarations:[];},invoke:(scope,tool,args,signal)=>host.invokeEmployeeApi(async()=>({source:'session',userId:scope.personId}),{apiId:tool.apiId,method:'POST',path:`/${tool.apiId}`,payload:args},signal)});
 const gateway=new AppGateway({registry:{} as any,contextResolver:{resolve:async(input:any)=>({actorType:'service',execution:input.execution,request:{requestId:input.requestId,traceId:input.traceId},authorize:async()=>({allowed:platformAllowed})})} as any,
  operations:[...createToolOperations(tools),...(['read','write','slow'] as const).map(mode=>({name:`fixture.${mode}`,permissionCode:'platform.tools.read',mode:mode==='write'?'write' as const:'read' as const,validateParams:()=>true,resolveResources:async()=>[{}],validateResult:()=>true,async execute(ctx:any,params:any,signal:AbortSignal){
   if(mode==='write'){writes++;return {};}
   if(mode==='slow')return new Promise((_,reject)=>{started();signal.addEventListener('abort',()=>{readAborted=true;reject(new GatewayError('ABORTED',499));},{once:true});});
   reads.push({personId:ctx.employeeActor.person.id,status:params.status});return {personId:ctx.employeeActor.person.id,status:params.status,rows:['本人待办']};
  }}))],limits:{timeoutMs:3000,appRequests:500,globalRequests:1000},auditRepository:{append:async row=>{audit.push(row);}} as any});
 const host=new AppHostV2({appId:'demo',registry:{runtimeSnapshot:async()=>({...record,enabled}),get:async()=>record} as any,store:{directory:()=>directory} as any,gateway,api:{contextResolver:{resolve:async(input:any)=>actor(input.trustedIdentity.userId)} as any,authorize:async()=>allowed,businessAuthorization:async()=>({revision:randomUUID(),organizations:[{id:org,name:'工班'}],grants:allowed?[{permission:'app.demo.read',all:false,self:true,organizationIds:[]}]:[]})},log:()=>{}});
 await host.serve(record);
 const scope={appId:'demo',personId:person};
 const invoke=(operation:string,params:any,signal?:AbortSignal,bound=true)=>gateway.invokeHosted('demo',async()=>record.serviceIdentityId,{version:'1.0',operation,params},signal,bound?async()=>actor(person) as any:undefined).then(response=>response.result as any);
 return {tools,host,scope,person,other,audit,reads,invoke,readStarted,writeCount:()=>writes,wasAborted:()=>readAborted,setAllowed:(v:boolean)=>{allowed=v;},setEnabled:(v:boolean)=>{enabled=v;},setPlatformAllowed:(v:boolean)=>{platformAllowed=v;},async close(){await host.close();await rm(directory,{recursive:true,force:true});}};
}

test('tool package contracts reject writes, unknown handlers, unsafe schemas and identity injection',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../applications/todos/app.json',import.meta.url),'utf8'));
 assert.ok(validateAppManifestV2(manifest).ok);
 for(const change of [{mode:'write'},{apiId:'missing'},{permission:'manage'},{inputSchema:{...schema,additionalProperties:true}},{inputSchema:{...schema,$ref:'https://example.invalid'}}])assert.equal(validateAppManifestV2({...manifest,tools:[{...manifest.tools[0],...change}]}).ok,false);
 assert.equal(validateAppManifestV2({...manifest,tools:[manifest.tools[0],{...manifest.tools[0],id:'alias'}]}).ok,false);
 assert.ok(isAppToolInputSchema(schema));assert.ok(matchesAppToolInput(schema,{status:'active'}));
 for(const input of [{},{status:'pending'},{status:'active',personId:randomUUID()},{status:'active',appId:'other'},{status:['active']}])assert.equal(matchesAppToolInput(schema,input),false);
 for(const property of [{type:'string'},{type:'object'},{type:'string',maxLength:100000},{type:'integer',minimum:2,maximum:1},{type:'string',maxLength:1,enum:['long']},{type:'string',maxLength:5,pattern:'.*'}])assert.equal(isAppToolInputSchema({...schema,properties:{status:property}}),false);
});

test('direct and negotiated MCP list/call use the same host handler and bound employee',async()=>{
 const f=await fixture();try{
  const controller=new AbortController();
  assert.deepEqual(await f.tools.mcp(f.scope,{},controller.signal),await f.tools.list(f.scope));
  const direct=await f.tools.call(f.scope,'query',{status:'active'},controller.signal),mcp=await f.tools.mcp(f.scope,{toolId:'query',arguments:{status:'active'}},controller.signal);
  assert.deepEqual(mcp,direct);assert.deepEqual(JSON.parse(JSON.stringify(direct)),{ok:true,result:{personId:f.person,status:'active',rows:['本人待办']}});
  for(const transport of ['direct','mcp'] as const){
   const sdk=createAppToolClient({invoke:f.invoke} as any,transport);
   assert.equal((await sdk.list()).tools[0].id,'query');
   assert.equal((await sdk.call<any>('query',{status:'completed'})).personId,f.person);
   const nested=await f.host.invokeEmployeeApi(async()=>({source:'session',userId:f.person}),{apiId:'agent',method:'POST',path:'/agent',payload:{transport}});
   assert.equal((nested as any).result.personId,f.person);
  }
  const audited=f.audit.filter(row=>row.action==='platform.tools.call');assert.equal(audited.length,4);
  assert.ok(audited.every(row=>row.metadata.employeeActorId===f.person&&row.metadata.toolId==='query'));
  assert.deepEqual(new Set(audited.map(row=>row.metadata.transport)),new Set(['direct','mcp']));assert.equal(f.writeCount(),0);
 }finally{await f.close();}
});

test('host validates tool arguments even through ordinary APIs; both tool transports reject unauthorized access',async()=>{
 const f=await fixture();try{
  const signal=new AbortController().signal;
  await assert.rejects(f.host.invokeEmployeeApi(async()=>({source:'session',userId:f.person}),{apiId:'query',method:'POST',path:'/query',payload:{status:'active',personId:f.other}}),{code:'INVALID_PARAMS',statusCode:400});
  for(const transport of ['direct','mcp']){
   await assert.rejects(f.invoke('platform.tools.call',{transport,toolId:'query',arguments:{status:'active',appId:'other'}}),{code:'INVALID_PARAMS',statusCode:400});
   await assert.rejects(f.invoke('platform.tools.call',{transport,toolId:'agent',arguments:{status:'active'}}),{code:'ACCESS_DENIED'});
   await assert.rejects(f.invoke('platform.tools.list',{transport},undefined,false),{code:'ACCESS_DENIED'});
  }
  assert.equal(f.reads.length,0);
  await assert.rejects(f.tools.call({...f.scope,personId:f.other},'query',{status:'active'},signal),{code:'ACCESS_DENIED'});
  f.setPlatformAllowed(false);await assert.rejects(f.invoke('platform.tools.list',{transport:'mcp'}),{code:'ACCESS_DENIED'});f.setPlatformAllowed(true);
  f.setAllowed(false);assert.deepEqual(await f.tools.list(f.scope),{tools:[]});await assert.rejects(f.tools.mcp(f.scope,{toolId:'query',arguments:{status:'active'}},signal),{code:'ACCESS_DENIED'});
  f.setAllowed(true);f.setEnabled(false);await assert.rejects(f.tools.call(f.scope,'query',{status:'active'},signal),{code:'ACCESS_DENIED'});
  for(const transport of ['direct','mcp'])await assert.rejects(f.invoke('platform.tools.list',{transport}),{code:'ACCESS_DENIED',statusCode:403});
 }finally{await f.close();}
});

test('real MCP client supports initialize, listing, tool errors, unknown methods and live permission changes',async()=>{
 const f=await fixture(),server=createAppToolMcpServer(f.tools,f.scope),client=new Client({name:'acceptance-client',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(b);await client.connect(a);assert.ok(client.getServerCapabilities()?.tools);
  const list=await client.listTools();assert.equal(list.tools[0].annotations?.readOnlyHint,true);
  const failed=await client.callTool({name:'business-failure',arguments:{status:'active'}});assert.equal(failed.isError,true);assert.deepEqual(failed.structuredContent,{ok:false,error:{code:'READ_FAILED'}});
  await assert.rejects(client.callTool({name:'unknown',arguments:{}}),error=>error instanceof ProtocolError&&error.code===ProtocolErrorCode.InvalidParams);
  await assert.rejects(client.request({method:'resources/list'}),error=>error instanceof ProtocolError&&error.code===ProtocolErrorCode.MethodNotFound);
  f.setAllowed(false);await assert.rejects(client.callTool({name:'query',arguments:{status:'active'}}),/ACCESS_DENIED/);
 }finally{await client.close();await server.close();await f.close();}
});

test('read-only declaration blocks platform mutations even when an app has write permission',async()=>{
 const f=await fixture();try{
  for(const transport of ['direct','mcp'])await assert.rejects(f.invoke('platform.tools.call',{transport,toolId:'bad-write',arguments:{status:'active'}}),{code:'OPERATION_DENIED'});
  await assert.rejects(f.host.invokeEmployeeApi(async()=>({source:'session',userId:f.person}),{apiId:'bad-write',method:'POST',path:'/bad-write',payload:{status:'active'}}),{code:'OPERATION_DENIED'});
  assert.equal(f.writeCount(),0);
 }finally{await f.close();}
});

test('cancellation traverses MCP, child IPC and the nested platform read',{timeout:3000},async()=>{
 const f=await fixture();try{
  const controller=new AbortController();
  const pending=f.invoke('platform.tools.call',{transport:'mcp',toolId:'slow',arguments:{status:'active'}},controller.signal);
  await f.readStarted;controller.abort();
  await assert.rejects(pending,{code:'ABORTED'});
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.wasAborted(),true);
 }finally{await f.close();}
});
