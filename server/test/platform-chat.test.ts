import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {AppToolService} from '../src/app-platform/tools/index.ts';
import {AppProcessV2} from '../src/app-platform/v2/process.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {ChatService,type ChatCapability,type ChatDependencies,chatMessageInput} from '../src/platform/chat/index.ts';
import {CHAT_SQL} from '../src/platform/chat/migration.ts';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import {readAppAgentInput} from '@metro/platform-sdk/app-agent';
import {validateAppManifestV2} from '@metro/platform-sdk/manifest';

const a:ChatCapability={id:'plan',key:'installation-a:plan',accessKey:'scope-a',appId:'a',appName:'计划',revision:1,name:'整理计划',description:'整理月度计划草稿',examples:['整理下月计划'],apiId:'agent-plan',permission:'fill',page:'/'};
const b:ChatCapability={...a,key:'installation-b:todos',appId:'b',appName:'待办',name:'查看待办',page:'/tasks'};
async function fixture(overrides:Partial<ChatDependencies>={}){
 const pg=new PGlite();
 await pg.exec('CREATE TABLE platform_people(id uuid PRIMARY KEY);'+CHAT_SQL);
 const owner=randomUUID(),other=randomUUID();await pg.query('INSERT INTO platform_people VALUES($1),($2)',[owner,other]);
 const db={query:async(sql:string,params?:readonly unknown[])=>params?pg.query(sql,[...params]):(await pg.exec(sql)).at(-1)!,release(){}};
 const service=new ChatService({pool:{...db,connect:async()=>db},capabilities:async()=>[a,b],route:async()=>({target:a.key,message:''}),invoke:async()=>({kind:'reply',text:'结果'}),report:()=>{},...overrides});
 await service.initialize();
 const input=(message='整理计划',sessionId=randomUUID())=>({message,sessionId,requestId:randomUUID()});
 async function finish(sessionId:string){for(let i=0;i<200;i++){const result=await service.read(owner,sessionId);if(!result.turns.some(turn=>turn.status==='running'))return result;await delay(5);}throw Error('test run did not finish');}
 return {pg,service,owner,other,input,finish,async close(){await service.close();await pg.close();}};
}

test('agent manifests bind API permissions and static pages; input rejects extra context',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../applications/huicetong/app.json',import.meta.url),'utf8'));
 const valid=validateAppManifestV2(manifest);assert.ok(valid.ok);assert.equal(valid.manifest.agents?.[0].apiId,'agent-plan');
 for(const fields of [{apiId:'missing'},{permission:'read'},{page:'/missing'},{examples:[]},{admin:true}])assert.equal(validateAppManifestV2({...manifest,agents:[{...manifest.agents[0],...fields}]}).ok,false);
 assert.throws(()=>readAppAgentInput({message:'hello',history:[],today:'2026-10-27',personId:randomUUID()}),/INVALID_INPUT/);
 assert.throws(()=>chatMessageInput.parse({sessionId:randomUUID(),requestId:randomUUID(),message:'x',target:'a'}));
});

test('conversation ownership and idempotency prevent duplicate execution or request reuse',async()=>{
 let calls=0;const f=await fixture({invoke:async()=>{calls++;return {kind:'draft',text:'草稿'};}});
 try{const request=f.input();await f.service.send(f.owner,request);const result=await f.finish(request.sessionId);
  assert.equal(result.turns[0].reply?.href,'/employee/app/a');assert.equal(result.turns[0].status,'completed');
  await f.service.send(f.owner,request);assert.equal(calls,1);
  await assert.rejects(f.service.send(f.owner,{...request,message:'different'}),/REQUEST_ID_REUSED/);
  await assert.rejects(f.service.read(f.other,request.sessionId),/CHAT_NOT_FOUND/);
  await assert.rejects(f.service.send(f.other,{...request,requestId:randomUUID()}),/CHAT_NOT_FOUND/);
  await assert.rejects(f.service.cancel(f.other,request.sessionId,request.requestId),/CHAT_NOT_FOUND/);
  assert.deepEqual(await f.service.list(f.other),[]);
 }finally{await f.close();}
});

test('clarification continues the same task; switching applications isolates prior replies',async()=>{
 const received:any[]=[];
 const f=await fixture({route:async message=>({target:message==='查看待办'?b.key:a.key,message:''}),invoke:async(_person,cap,input)=>{received.push({cap,input});return {kind:'clarify',text:cap.key===a.key?'计划安排在哪个月？':'待办结果'};}});
 try{const first=f.input();await f.service.send(f.owner,first);await f.finish(first.sessionId);
  await f.service.send(f.owner,f.input('下个月',first.sessionId));await f.finish(first.sessionId);
  assert.deepEqual(received[1].input.history,[{role:'user',content:'整理计划'},{role:'assistant',content:'计划安排在哪个月？'}]);
  await f.service.send(f.owner,f.input('查看待办',first.sessionId));await f.finish(first.sessionId);
  assert.deepEqual(received[2].input.history,[]);
  assert.match(received[2].input.today,/^\d{4}-\d{2}-\d{2}$/);
 }finally{await f.close();}
});

test('revoked or changed scopes hide saved app replies and remove them from subsequent history',async()=>{
 let catalog=[a],previous:any,history:any;
 const f=await fixture({capabilities:async()=>catalog,route:async(_message,prior)=>{previous=prior;return {target:a.key,message:''};},invoke:async(_person,_cap,input)=>{history=input.history;return {kind:'clarify',text:'部门内部内容'};}});
 try{const first=f.input();await f.service.send(f.owner,first);await f.finish(first.sessionId);
  catalog=[{...a,accessKey:'narrower-self-only'}];
  assert.doesNotMatch(JSON.stringify(await f.service.read(f.owner,first.sessionId)),/部门内部内容/);
  await f.service.send(f.owner,f.input('继续',first.sessionId));await f.finish(first.sessionId);
  assert.equal(previous[0].question,null);assert.deepEqual(history,[]);
  catalog=[];assert.doesNotMatch(JSON.stringify(await f.service.read(f.owner,first.sessionId)),/部门内部内容/);
 }finally{await f.close();}
});

test('out of catalog routes and malformed app responses fail without dispatching unauthorized targets',async()=>{
 let calls=0;const f=await fixture({route:async()=>({target:'forged',message:''}),invoke:async()=>{calls++;return null;}});
 try{const request=f.input();await f.service.send(f.owner,request);const result=await f.finish(request.sessionId);
  assert.equal(calls,0);assert.equal(result.turns[0].error,'CHAT_INVALID_ROUTE');
 }finally{await f.close();}
 const g=await fixture({invoke:async()=>({kind:'reply',text:'answer',href:'https://untrusted.invalid'})});
 try{const request=g.input();await g.service.send(g.owner,request);assert.equal((await g.finish(request.sessionId)).turns[0].error,'CHAT_EXECUTION_FAILED');}finally{await g.close();}
});

test('permissions changed during routing prevent forwarding earlier context to an application',async()=>{
 let catalog=[a],invoked=false;
 const f=await fixture({capabilities:async()=>catalog,route:async()=>{catalog=[{...a,accessKey:'changed'}];return {target:a.key,message:''};},invoke:async()=>{invoked=true;return {kind:'reply',text:'unexpected'};}});
 try{const request=f.input();await f.service.send(f.owner,request);assert.equal((await f.finish(request.sessionId)).turns[0].error,'CHAT_ACCESS_CHANGED');assert.equal(invoked,false);}finally{await f.close();}
});

test('ambiguous intent and unavailable catalogs finish without calling applications',async()=>{
 let calls=0;const f=await fixture({route:async()=>({target:null,message:'请先选择计划或待办。'}),invoke:async()=>{calls++;throw Error('unexpected');}});
 try{const request=f.input();await f.service.send(f.owner,request);assert.equal((await f.finish(request.sessionId)).turns[0].reply?.kind,'clarify');assert.equal(calls,0);}finally{await f.close();}
 const g=await fixture({capabilities:async()=>[],route:async()=>{throw Error('must not route');}});
 try{const request=g.input();await g.service.send(g.owner,request);assert.match((await g.finish(request.sessionId)).turns[0].reply!.text,/没有可用/);}finally{await g.close();}
});

test('cancel stops a running turn, prevents parallel turns and never replays after restart',async()=>{
 let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture({invoke:async(_person,_cap,_input,signal)=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 try{const request=f.input();await f.service.send(f.owner,request);await ready;
  await assert.rejects(f.service.send(f.owner,f.input('second',request.sessionId)),/CHAT_BUSY/);
  await f.service.cancel(f.owner,request.sessionId,request.requestId);assert.equal((await f.finish(request.sessionId)).turns[0].status,'cancelled');
  await f.service.close();
  const interrupted=randomUUID();await f.pg.query("INSERT INTO platform_chat_turns(id,session_id,message,status,stage) VALUES($1,$2,'not replayed','running','处理中')",[interrupted,request.sessionId]);
  await f.service.initialize();assert.equal((await f.service.read(f.owner,request.sessionId)).turns.at(-1)?.status,'interrupted');
 }finally{await f.close();}
});

test('simultaneous new conversations reserve employee admission before awaiting the database',async()=>{
 let release!:()=>void,failConnect=false;
 const connected=new Promise<void>(resolve=>{release=resolve;});
 const owner=randomUUID(),other=randomUUID();
 const query=async(sql:string)=>({rows:sql.startsWith('SELECT person_id')?[{person_id:owner}]:[]});
 const service=new ChatService({pool:{query,connect:async()=>{await connected;if(failConnect)throw Error('database unavailable');return {query,release(){}};}},
  capabilities:()=>new Promise(()=>{}),invoke:async()=>null,report:()=>{}});
 const input=()=>({sessionId:randomUUID(),requestId:randomUUID(),message:'查询待办'});
 try{
  const results=Promise.allSettled([service.send(owner,input()),service.send(owner,input())]);release();
  const settled=await results;
  assert.equal(settled.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((settled.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'CHAT_BUSY');
  failConnect=true;await assert.rejects(service.send(other,input()),/database unavailable/);
  // A failed connection must release the admission reservation too.
  await assert.rejects(service.send(other,input()),/database unavailable/);
 }finally{release();await service.close();}
});

test('chat HTTP uses employee authentication, same-origin writes and one boundary parse',async()=>{
 const f=await fixture(),app=Fastify();let checks=0;
 await app.register(cookie);
 registerEmployeeRoutes(app,{origin:'http://localhost',chat:f.service,service:{authenticate:async(token:string)=>{checks++;return token==='valid'?{personId:f.owner}:null;}} as any,resolveAdmin:async()=>{throw Error('not used');}});
 try{
  assert.equal((await app.inject({url:'/api/employee/chat/capabilities'})).statusCode,401);
  const headers={cookie:'mop_employee_session=valid',origin:'http://localhost'};
  // Use the platform cookie name so this remains aligned with the employee entry.
  const {EMPLOYEE_SESSION_COOKIE}=await import('../src/platform/employee-identity/index.ts');headers.cookie=`${EMPLOYEE_SESSION_COOKIE}=valid`;
  const before=checks;assert.equal((await app.inject({url:'/api/employee/chat/capabilities',headers})).statusCode,200);assert.equal(checks,before+1);
  const request=f.input();assert.equal((await app.inject({method:'POST',url:'/api/employee/chats/messages',headers:{cookie:headers.cookie,origin:'https://other.invalid'},payload:request})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/employee/chats/messages',headers,payload:{...request,target:'forged'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/employee/chats/messages',headers,payload:request})).statusCode,202);await f.finish(request.sessionId);
 }finally{await app.close();await f.close();}
});

test('chat dispatches real Huicetong and Todos child handlers with employee-bound platform calls',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mop-chat-apps-')),processes=new Map<string,AppProcessV2>(),calls:{operation:string;callId?:string;transport?:string}[]=[];
 const org=randomUUID(),person=randomUUID(),revision=randomUUID();
 const catalog=[{...a,appId:'huicetong',apiId:'agent-plan'},{...b,appId:'todos',apiId:'agent-todos'}];
 const f=await fixture({capabilities:async()=>catalog,route:async message=>({target:message.includes('待办')?b.key:a.key,message:''}),
  invoke:async(_person,cap,input,signal)=>{
   const employee={version:'1.0' as const,personId:person,organizationUnitId:org,requestId:randomUUID(),traceId:randomUUID(),businessAuthorization:{revision,organizations:[{id:org,name:'工班'}],grants:[{permission:`app.${cap.appId}.${cap.appId==='huicetong'?'fill':'read'}`,all:false,self:true,organizationIds:[]}]}};
   const result=await processes.get(cap.appId)!.call(cap.apiId,input,employee,signal) as any;
   assert.equal(result.ok,true);return result.result;
  }});
 try{
  for(const appId of ['huicetong','todos']){
   const outfile=join(directory,`${appId}.mjs`);
   await build({entryPoints:[fileURLToPath(new URL(`../../applications/${appId}/src/server.js`,import.meta.url))],outfile,bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
   const manifest=JSON.parse(await readFile(new URL(`../../applications/${appId}/app.json`,import.meta.url),'utf8'));
   const toolService=new AppToolService({catalog:async()=>manifest.tools,invoke:async(_scope,tool,args,signal)=>processes.get(appId)!.call(tool.apiId,args,{version:'1.0',personId:person,organizationUnitId:org,requestId:randomUUID(),traceId:randomUUID(),businessAuthorization:{revision,organizations:[{id:org,name:'工班'}],grants:[{permission:`app.${appId}.${appId==='huicetong'?'fill':'read'}`,all:false,self:true,organizationIds:[]}] }},signal)});
   const process=new AppProcessV2({appId,serverPath:outfile,cwd:directory,log:()=>{},onPlatform:async(operation,params:any,callId)=>{
    calls.push({operation,callId,transport:params?.transport});
    if(operation==='platform.tools.call'){
     const scope={appId,personId:person},signal=new AbortController().signal;
     return params.transport==='mcp'?toolService.mcp(scope,{toolId:params.toolId,arguments:params.arguments},signal):toolService.call(scope,params.toolId,params.arguments,signal);
    }
    if(operation==='platform.people.organization_context')return {organizations:[{id:org,name:'维保部',unitType:'department'}]};
    if(operation==='platform.knowledge.search')return {entries:[]};
    if(operation==='platform.ai.complete')return {content:JSON.stringify({content:'完成AFC巡检',qualityStandard:'提交巡检清单',startDate:null,endDate:null,missingInfo:['完成日期']})};
    if(operation==='platform.app_data.list'){
     if(params.table==='tasks'){assert.ok(params.anyOf.some((group:any[])=>group.some(filter=>filter.value===person)));return {rows:[{id:randomUUID(),title:'本人巡检待办',created_by:person,organization_id:org}],nextCursor:null};}
     return {rows:[],nextCursor:null};
    }
    throw Error(`unexpected platform call ${operation}`);
   }});
   processes.set(appId,process);await process.start();
  }
  const first=f.input('帮我整理2026-11的AFC巡检计划');await f.service.send(f.owner,first);
  assert.match((await f.finish(first.sessionId)).turns[0].reply!.text,/完成AFC巡检/);
  await f.service.send(f.owner,f.input('查看待办',first.sessionId));
  assert.match((await f.finish(first.sessionId)).turns.at(-1)!.reply!.text,/本人巡检待办/);
  assert.ok(calls.filter(call=>call.operation.startsWith('platform.knowledge')||call.operation==='platform.ai.complete').every(call=>call.callId));
  assert.deepEqual(calls.filter(call=>call.operation==='platform.tools.call').map(call=>call.transport),['direct','mcp']);
  assert.ok(!calls.some(call=>call.operation.includes('transaction')));
 }finally{await f.close();for(const process of processes.values())await process.stop();await rm(directory,{recursive:true,force:true});}
});
