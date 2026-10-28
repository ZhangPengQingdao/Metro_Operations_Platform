import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {createKnowledgeOperations} from '../src/app-platform/gateway/knowledge.ts';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import {validateAppManifestV2,appPermissionCode} from '@metro/platform-sdk/manifest';
import {createPlatformKnowledgeClient} from '@metro/platform-sdk/app-knowledge';
import {createReformService} from '../../applications/huicetong/src/reform-service.mjs';

const manifest=JSON.parse(await readFile(new URL('../../applications/huicetong/app.json',import.meta.url),'utf8'));
async function fixture() {
  const pg=new PGlite();
  const db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}};
  const pool={...db,connect:async()=>db};
  await initializePlatformDatabase(db);
  const department=randomUUID(),team=randomUUID(),foreign=randomUUID(),position=randomUUID(),editor=randomUUID(),reader=randomUUID();
  for(const [id,type,parent] of [[department,'department',null],[team,'workgroup',department],[foreign,'department',null]])
    await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,parent_id,status,created_at,updated_at) VALUES($1::uuid,$1::text,$1::text,$2,$3,'active',now(),now())",[id,type,parent]);
  await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'position','岗位','active',now(),now())",[position]);
  for(const id of [editor,reader])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,$1::text,$2,$3,'active',now(),now())",[id,team,position]);
  const installation={id:randomUUID(),appId:manifest.id,revision:1,enabled:true,grants:[],credentialDigest:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),serviceIdentityId:randomUUID(),
    manifest:{permissions:{defined:manifest.permissions.map((p:any)=>({code:appPermissionCode(manifest.id,p.code),scopeKinds:p.scopes}))}},
    runtime:{model:'v2',manifest}};
  await pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[installation.id,installation.appId,JSON.stringify(installation)]);
  await pg.query("INSERT INTO platform_app_authorization(installation_id,mode,revision) VALUES($1,'application',$2)",[installation.id,randomUUID()]);
  const readerRole=randomUUID();
  for(const [id,role,rules] of [[editor,randomUUID(),[{permission:'app.huicetong.corpus',scope:'organizations',organizationIds:[department]}]],
    [reader,readerRole,[{permission:'app.huicetong.fill',scope:'self',organizationIds:[]}]]] as const) {
    await pg.query("INSERT INTO platform_app_business_roles(id,installation_id,name,status,rules) VALUES($1,$2,$3,'active',$4)",[role,installation.id,id,JSON.stringify(rules)]);
    await pg.query('INSERT INTO platform_app_business_members VALUES($1,$2,$3)',[installation.id,role,id]);
  }
  const operations=createKnowledgeOperations(pool);
  let platformAllowed=true;
  const gateway=new AppGateway({registry:{} as any,contextResolver:{resolve:async(input:any)=>({
    actorType:'service',execution:input.execution,request:{requestId:input.requestId,traceId:input.traceId},
    authorize:async()=>({allowed:platformAllowed}),
  })} as any,operations,limits:{appRequests:1000,globalRequests:2000}});
  const invoke=async(personId:string,operation:string,input:any,signal?:AbortSignal,appId=manifest.id,bound=true)=>{
    const response=await gateway.invokeHosted(appId,async()=>installation.serviceIdentityId,{version:'1.0',operation,params:input},signal,bound?async()=>({
      actorType:'person',person:{id:personId,organization:{id:team}},execution:{type:'application',appId},
    }) as any:undefined);
    return response.result as any;
  };
  const client=(personId:string)=>createPlatformKnowledgeClient({invoke:(operation,input,signal)=>invoke(personId,operation,input,signal)});
  return {pg,installation,department,team,foreign,editor,reader,readerRole,operations,invoke,client,setPlatformAllowed:(value:boolean)=>{platformAllowed=value;}};
}

test('knowledge manifest binds declared permissions and survives normalization',()=>{
  const result=validateAppManifestV2(manifest);assert.ok(result.ok);assert.deepEqual(result.manifest.knowledgeBases,manifest.knowledgeBases);
  for(const change of [
    {knowledgeBases:[{...manifest.knowledgeBases[0],readPermission:'unknown'}]},
    {knowledgeBases:[manifest.knowledgeBases[0],manifest.knowledgeBases[0]]},
    {knowledgeBases:[{...manifest.knowledgeBases[0],retrieval:'execute'}]},
    {platformAccess:manifest.platformAccess.filter((code:string)=>code!=='knowledge.read')},
  ])assert.equal(validateAppManifestV2({...manifest,...change}).ok,false);
});

test('knowledge gateway enforces employee, library, organization, installation and current business grants',async()=>{
  const f=await fixture();try {
    const target={libraryId:'terms',organizationId:f.department},editor=f.client(f.editor),reader=f.client(f.reader);
    const request={...target,id:randomUUID(),requestId:randomUUID(),action:'save' as const,title:'AFC',content:'自动售检票系统',metadata:{}};
    const created=await editor.write(request);
    assert.equal((await reader.search({...target,query:'完成AFC排查'})).entries[0].id,created.id);
    await assert.rejects(reader.list(target),/ACCESS_DENIED/);
    await assert.rejects(reader.write({...request,requestId:randomUUID()}),/ACCESS_DENIED/);
    await assert.rejects(reader.search({...target,organizationId:f.foreign,query:'AFC'}),/ACCESS_DENIED/);
    await assert.rejects(editor.list({...target,organizationId:f.foreign}),/ACCESS_DENIED/);
    await assert.rejects(editor.list({...target,libraryId:'undeclared'}),/ACCESS_DENIED/);
    await assert.rejects(f.invoke(f.editor,'platform.knowledge.list',target,undefined,manifest.id,false),/ACCESS_DENIED/);
    await assert.rejects(f.invoke(f.editor,'platform.knowledge.list',{...target,appId:'other-app'}),/INVALID_PARAMS/);
    f.setPlatformAllowed(false);await assert.rejects(editor.list(target),/ACCESS_DENIED/);f.setPlatformAllowed(true);
    // A different installation can declare the same library and IDs, but sees no entries from this one.
    const other={...f.installation,id:randomUUID(),appId:'other-app',manifest:{permissions:{defined:[{code:'app.other-app.corpus',scopeKinds:['all']}]}},runtime:{model:'v2',manifest:{knowledgeBases:[{...manifest.knowledgeBases[0],readPermission:'corpus',writePermission:'corpus'}]}}};
    await f.pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[other.id,other.appId,JSON.stringify(other)]);
    await f.pg.query("INSERT INTO platform_app_authorization(installation_id,mode,revision) VALUES($1,'application',$2)",[other.id,randomUUID()]);
    const role=randomUUID();await f.pg.query("INSERT INTO platform_app_business_roles(id,installation_id,name,status,rules) VALUES($1,$2,'reader','active',$3)",[role,other.id,JSON.stringify([{permission:'app.other-app.corpus',scope:'all',organizationIds:[]}])]);
    await f.pg.query('INSERT INTO platform_app_business_members VALUES($1,$2,$3)',[other.id,role,f.editor]);
    assert.deepEqual((await f.invoke(f.editor,'platform.knowledge.list',target,undefined,'other-app')).entries,[]);
    await f.pg.query("UPDATE platform_app_business_roles SET status='inactive' WHERE id=$1",[f.readerRole]);
    await assert.rejects(reader.search({...target,query:'AFC'}),/ACCESS_DENIED/);
    await f.pg.query("UPDATE platform_app_installations SET record=jsonb_set(record,'{enabled}','false') WHERE id=$1",[f.installation.id]);
    await assert.rejects(editor.list(target),/ACCESS_DENIED/);
  } finally {await f.pg.close();}
});

test('knowledge writes are atomic, idempotent, revision checked and deleted content stops retrieval',async()=>{
  const f=await fixture();try {
    const client=f.client(f.editor),target={libraryId:'terms',organizationId:f.department};
    const input={...target,id:randomUUID(),requestId:randomUUID(),action:'save' as const,title:'AFC',content:'自动售检票系统',metadata:{}};
    const [first,repeated]=await Promise.all([client.write(input),client.write(input)]);assert.deepEqual(first,repeated);
    assert.equal((await client.list(target)).entries.length,1);
    await assert.rejects(client.write({...input,content:'复用请求号篡改'}),/REQUEST_ID_REUSED/);
    await assert.rejects(client.write({...input,id:randomUUID(),requestId:randomUUID()}),/KNOWLEDGE_CONFLICT/);
    const revisions=await Promise.allSettled(['解释一','解释二'].map(content=>client.write({...input,id:first.id,requestId:randomUUID(),expectedVersion:1,content})));
    assert.equal(revisions.filter(result=>result.status==='fulfilled').length,1);
    assert.match((revisions.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.message,/KNOWLEDGE_CONFLICT/);
    await assert.rejects(client.write({...input,id:first.id,requestId:randomUUID(),expectedVersion:2,title:'改名'}),/KNOWLEDGE_CONFLICT/);
    const controller=new AbortController();controller.abort();await assert.rejects(client.write({...input,title:'未提交',requestId:randomUUID()},controller.signal),/ABORTED/);
    const removed=await client.write({...target,id:first.id,requestId:randomUUID(),action:'delete',expectedVersion:2});assert.equal(removed.version,3);
    assert.deepEqual((await client.search({...target,query:'AFC'})).entries,[]);
    const restored=await client.write({...input,requestId:randomUUID()});assert.equal(restored.id,first.id);assert.equal(restored.version,4);
    const counts=await f.pg.query('SELECT count(*)::int AS count FROM platform_knowledge_requests');assert.equal(counts.rows[0].count,4);
  } finally {await f.pg.close();}
});

test('knowledge pagination, relevance and Huicetong suggestion use the platform results as data',async()=>{
  const f=await fixture();try {
    const editor=f.client(f.editor),target={organizationId:f.department,libraryId:'examples'};
    for(let i=0;i<23;i++)await editor.write({...target,id:randomUUID(),requestId:randomUUID(),action:'save',title:`示例${i}`,content:i===0?'完成AFC设备排查':'绿化浇水修剪',metadata:{qualityStandard:'提交问题清单'}});
    const first=await editor.list(target);assert.equal(first.entries.length,20);assert.ok(first.nextCursor);
    const second=await editor.list({...target,afterId:first.nextCursor});assert.equal(second.entries.length,3);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.entries,...second.entries].map(row=>row.id)).size,23);
    assert.equal((await editor.search({...target,query:'完成AFC设备检查'})).entries.length,1);
    assert.deepEqual((await editor.search({...target,query:'xyz'})).entries,[]);
    const term=await editor.write({...target,libraryId:'terms',id:randomUUID(),requestId:randomUUID(),action:'save',title:'AFC',content:'自动售检票系统',metadata:{}});
    let prompt:any;
    const service=createReformService({invoke:async(operation:string,input:any)=>{
      if(operation==='platform.people.organization_context')return {organizations:[{id:f.team},{id:f.department}]};
      if(operation==='platform.ai.complete'){prompt=JSON.parse(input.prompt);return {content:JSON.stringify({content:'完成AFC设备检查',qualityStandard:'提交问题清单',startDate:null,endDate:null,missingInfo:[]})};}
      assert.ok(operation.startsWith('platform.knowledge.'));return f.invoke(f.reader,operation,input);
    }}).service;
    const employee={personId:f.reader,organizationUnitId:f.team,businessAuthorization:{grants:[{permission:'app.huicetong.fill',all:false,self:true,organizationIds:[]}]}};
    await service['plan-suggest']({organizationId:f.department,month:'2026-10',rawText:'完成AFC设备检查'},employee);
    assert.deepEqual(prompt.protectedTerms,['AFC']);assert.equal(prompt.termExplanations[0].explanation,'自动售检票系统');assert.equal(prompt.examples.length,1);
    assert.equal((await f.client(f.reader).search({...target,libraryId:'terms',query:'AFC'})).entries[0].id,term.id);
  } finally {await f.pg.close();}
});

test('actual Huicetong child calls the knowledge gateway with its employee-bound invocation',async()=>{
  const f=await fixture(),root=await mkdtemp(join(tmpdir(),'mop-knowledge-child-'));
  const {build}=await import('esbuild');
  const {AppProcessV2}=await import('../src/app-platform/v2/process.ts');
  const calls=new Map<string,string>();
  const process=new AppProcessV2({appId:'huicetong',serverPath:join(root,'server.js'),cwd:root,log:()=>{},onPlatform:async(operation,input:any,callId)=>{
    if(operation==='platform.app_data.list'&&!callId)return {rows:[],nextCursor:null};
    assert.ok(callId);assert.ok(calls.has(callId));
    return f.invoke(calls.get(callId)!,operation,input);
  }});
  try {
    await build({entryPoints:[new URL('../../applications/huicetong/src/server.js',import.meta.url).pathname],outfile:join(root,'server.js'),bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
    await process.start();
    const call=async(api:string,input:any,personId=f.editor)=>{
      const id=randomUUID();calls.set(id,personId);
      try {return await process.call(api,input,{version:'1.0',personId,organizationUnitId:f.team,requestId:id,traceId:id} as any,undefined,id) as any;}
      finally {calls.delete(id);}
    };
    const saved=await call('corpus-save',{id:randomUUID(),requestId:randomUUID(),organizationId:f.department,kind:'term',term:'AFC',explanation:'自动售检票系统'});
    assert.equal(saved.ok,true);
    await call('corpus-save',{id:randomUUID(),requestId:randomUUID(),organizationId:f.department,kind:'example',content:'设备检修',qualityStandard:'记录检修结果'});
    const listed=await call('corpus-list',{organizationId:f.department});assert.equal(listed.result.terms[0].id,saved.result.id);assert.equal(listed.result.terms[0].explanation,'自动售检票系统');
    assert.equal(listed.ok,true);assert.equal(listed.result.examples[0].indexStatus,'unconfigured');
    assert.deepEqual(JSON.parse(JSON.stringify(listed)),listed);
    const denied=await call('corpus-list',{organizationId:f.department},f.reader);assert.equal(denied.ok,false);assert.equal(denied.error.code,'ACCESS_DENIED');
    const malformed=await call('corpus-save',{id:randomUUID(),requestId:'not-a-request-id',organizationId:f.department,kind:'term',term:'AFC',explanation:''});
    assert.equal(malformed.error.code,'INVALID_PARAMS');assert.equal(malformed.error.writeOutcome,'not_started');
  } finally {await process.stop();await f.pg.close();await rm(root,{recursive:true,force:true});}
});

test('exact lookup rejects overflow rather than silently dropping protected terms',async()=>{
  const f=await fixture();try {
    const client=f.client(f.editor),target={libraryId:'terms',organizationId:f.department};
    for(let i=0;i<41;i++)await client.write({...target,id:randomUUID(),requestId:randomUUID(),action:'save',title:`词${i}号`,content:'',metadata:{}});
    const query=Array.from({length:41},(_,i)=>`词${i}号`).join(' ');
    await assert.rejects(client.search({...target,query,limit:1}),/KNOWLEDGE_LIMIT/);
    assert.equal((await client.search({...target,query:'词0号',limit:1})).entries.length,1);
    await assert.rejects(client.write({...target,id:randomUUID(),requestId:randomUUID(),action:'save',title:' test ',content:'',metadata:{}}),/INVALID_PARAMS/);
  } finally {await f.pg.close();}
});
