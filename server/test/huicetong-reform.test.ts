import {KNOWLEDGE_SQL,KNOWLEDGE_VECTOR_SQL} from '../src/platform/knowledge/migration.ts';
import {KnowledgeService} from '../src/platform/knowledge/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {createReformService} from '../../applications/huicetong/src/reform-service.mjs';
import {APP_REGISTRY_SQL,type AppInstallation} from '../src/app-platform/registry/index.ts';
import {APP_V2_SQL,applyAppMigrationsV2} from '../src/app-platform/v2/migration.ts';
import {AppDataServiceV2} from '../src/app-platform/v2/data.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import {createAttachmentListOperation} from '../src/app-platform/gateway/attachments.ts';
import {createLocalStorageAdapter} from '../src/core/storage/index.ts';
import {createAppAttachmentTransfer,inspectAppAttachment,APP_ATTACHMENT_MAX_BYTES} from '../src/app-platform/employee/attachment-service.ts';
import {createMemoryAttachmentRepository} from '../src/platform/attachments/index.ts';
import {zipStream,zipSize} from '../src/app-platform/employee/zip-stream.ts';
import {createWorkgroupDirectoryOperation} from '../src/app-platform/gateway/people-directory.ts';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';

const signal=new AbortController().signal;
const collect=async(stream:Readable)=>{const chunks=[];for await(const bytes of stream)chunks.push(Buffer.from(bytes));return Buffer.concat(chunks);};
const org=randomUUID(),team=randomUUID(),person=randomUUID(),entity=randomUUID();
function actor(){return {actorType:'person',trustedIdentity:{source:'session',userId:person},person:{id:person,name:'员工',organization:{id:team}},execution:{type:'application',appId:'huicetong'},request:{requestId:randomUUID(),traceId:randomUUID()},authorize:async()=>({allowed:true}),authorizeApplication:async()=>({allowed:true})} as any;}
function transferFixture(storage:any){const repository=createMemoryAttachmentRepository(),transfer=createAppAttachmentTransfer({storage,repository,directory:{findPerson:async()=>({organizationUnitId:team,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'部门'})},authorize:async()=>({organizationId:org})});return {repository,transfer};}

test('Huicetong actual v2 schema and public data gateway execute the new plan and approval workflow',async()=>{
 const db=new PGlite();try{
  await db.exec(APP_REGISTRY_SQL);await db.exec(APP_V2_SQL);await db.exec(KNOWLEDGE_SQL+KNOWLEDGE_VECTOR_SQL);const installation={id:randomUUID(),appId:'huicetong',revision:1,enabled:true,credentialDigest:null,manifest:{},grants:[],serviceIdentityId:randomUUID(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),runtime:{model:'v2',sha256:'a'.repeat(64),manifest:{}}} as unknown as AppInstallation;
  await db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[installation.id,installation.appId,JSON.stringify(installation)]);
  const client={query:(sql:string,args?:readonly unknown[])=>db.query(sql,args?[...args]:undefined),release(){}};
  const migrations=await Promise.all((await readdir(new URL('../../applications/huicetong/migrations/',import.meta.url))).filter(name=>name.endsWith('.json')).sort().map(async name=>({id:name.slice(0,-5),text:await readFile(new URL('../../applications/huicetong/migrations/'+name,import.meta.url),'utf8')})));
  await applyAppMigrationsV2(client as any,installation.id,migrations.slice(0,1));
  // Upgrade an installed 2.0 schema without changing or dropping its original migration.
  await applyAppMigrationsV2(client as any,installation.id,migrations);
  const context={actorType:'service',execution:{type:'service',appId:'huicetong',serviceIdentityId:installation.serviceIdentityId},authorize:async()=>({allowed:true})} as unknown as PlatformActorContext;
  const data=new AppDataServiceV2({pool:{connect:async()=>client} as any,findInstallation:async()=>installation});
  const knowledge=new KnowledgeService({...client,connect:async()=>client}),knowledgeScope={installationId:installation.id,personId:person,retrieval:'exact' as const};
  const gateway={async invoke(operation:string,input:any){
   if(operation==='platform.knowledge.write')return knowledge.write(knowledgeScope,input,signal);
   if(operation==='platform.knowledge.list')return knowledge.list(knowledgeScope,input);
   if(operation.startsWith('platform.app_data.'))return data.execute(context,installation,operation.slice('platform.app_data.'.length) as any,input,signal);
   if(operation==='platform.people.organization_context')return {organizations:[{id:team,unitType:'workgroup'},{id:org,unitType:'department'}]};
   if(operation==='platform.people.members')return {rows:[{id:person,name:'张三',organizationUnitId:team}]};
   if(operation==='platform.attachments.list')return {attachments:[{attachmentId:randomUUID()}]};throw Error(operation);
  }};
  const employee={personId:person,organizationUnitId:team,businessAuthorization:{revision:randomUUID(),organizations:[{id:team,name:'一班'}],grants:['read','fill','review','complete','corpus','settings'].map(code=>({permission:`app.huicetong.${code}`,all:false,self:false,organizationIds:[org,team]}))}};
  const service=createReformService(gateway).service,id=randomUUID();
  await service['record-save']({id,requestId:randomUUID(),organizationId:org,kind:'monthly',submit:true,draft:{content:'检查'.repeat(250),qualityStandard:'验收'.repeat(250),startDate:'2026-10-01',endDate:'2026-10-31',month:'2026-10',responsible:{personId:person,organizationUnitId:team},originalText:'原话'.repeat(750)}},employee);
  await service['record-review']({id,requestId:randomUUID(),expectedVersion:1,action:'approve'},employee);
  await service['record-progress']({id,requestId:randomUUID(),expectedVersion:2,summary:'完成',complete:true},employee);
  const page=await service['record-list']({organizationId:org,kind:'monthly',month:'2026-10'},employee);assert.equal(page.rows[0].status,'completed');assert.equal(page.rows[0].number,'月001');
  const term=await service['corpus-save']({id:randomUUID(),requestId:randomUUID(),organizationId:org,kind:'term',term:'AFC',explanation:'自动售检票系统'},employee);
  assert.equal((await service['corpus-list']({organizationId:org},employee)).terms.find((row:any)=>row.id===term.id).explanation,'自动售检票系统');
  assert.ok(!('original_text' in page.rows[0]));assert.equal((await service['record-get']({id},employee)).events.rows.length,3);
 }finally{await db.close();}
});

test('200 MiB ingestion is streamed without truncating originals and cleans up oversized staging',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hct-stream-'));try{
  const storage=createLocalStorageAdapter({rootDir:root}),{transfer,repository}=transferFixture(storage);
  // 51 MiB exceeds the previous API limit; no full-size source Buffer is allocated.
  const block=Buffer.alloc(1024*1024,7),size=51*1024*1024;
  const stream=Readable.from((async function*(){yield Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(1024*1024-12,7)]);for(let i=1;i<51;i++)yield block;})());
  const file=await transfer.upload(actor(),{appId:'huicetong',entityType:'work_record',entityId:entity,intentId:randomUUID(),fileName:'核验视频.mp4',stream});assert.equal(file.sizeBytes,size);
  const saved=await repository.findAttachmentById(file.attachmentId);assert.ok(saved);let downloaded=0;for await(const bytes of (await transfer.read(actor(),'huicetong',file.attachmentId)).stream)downloaded+=bytes.length;assert.equal(downloaded,size);
  await assert.rejects(storage.writeObjectStream!('app-attachments','oversized',Readable.from([Buffer.alloc(9)]),{maxBytes:8}),/FILE_TOO_LARGE/);assert.equal(await storage.exists('app-attachments','oversized'),false);
  assert.equal(APP_ATTACHMENT_MAX_BYTES,200*1024*1024);assert.equal(inspectAppAttachment('照片.png',Buffer.from([137,80,78,71,13,10,26,10])).contentType,'image/png');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('stream staging never removes a pre-existing storage object on an exclusive collision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hct-exclusive-'));try{const storage=createLocalStorageAdapter({rootDir:root});await storage.writeObject('app-attachments','existing',Buffer.from('keep'));await assert.rejects(storage.writeObjectStream!('app-attachments','existing',Readable.from([Buffer.from('other')]),{maxBytes:100}));assert.equal((await collect(storage.createObjectReadStream('app-attachments','existing') as Readable)).toString(),'keep');}finally{await rm(root,{recursive:true,force:true});}
});

test('attachment backend query is app/source/organization bound and excludes missing bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hct-query-'));try{const storage=createLocalStorageAdapter({rootDir:root}),{transfer,repository}=transferFixture(storage);const file=await transfer.upload(actor(),{appId:'huicetong',entityType:'work_record',entityId:entity,intentId:randomUUID(),fileName:'报告.pdf',bytes:Buffer.from('%PDF-test')});const operation=createAttachmentListOperation(repository,storage),ctx={actorType:'service',execution:{appId:'huicetong'}} as any,input={entityType:'work_record',entityId:entity,organizationId:org,availableOnly:true};
  const result=await operation.execute(ctx,input,signal) as any;assert.equal(result.attachments[0].attachmentId,file.attachmentId);assert.ok(!JSON.stringify(result).includes('storageFileName'));
  assert.equal((await operation.execute({...ctx,execution:{appId:'other'}},input,signal) as any).attachments.length,0);assert.equal((await operation.execute(ctx,{...input,organizationId:randomUUID()},signal) as any).attachments.length,0);
  const row=await repository.findAttachmentById(file.attachmentId);await storage.deleteObject(row!.storageKind,row!.storageFileName);assert.equal((await operation.execute(ctx,input,signal) as any).attachments.length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('nested ZIP has exact sizes and original content; a short or failed source aborts the archive',async()=>{
 const bytes=Buffer.from('原件字节不改变'),entry={name:'证据.pdf',size:bytes.length,open:async()=>Readable.from([bytes])};const inner=await collect(zipStream([entry]));assert.equal(inner.length,zipSize([entry]));const outerEntry={name:'YD-001+张三.zip',size:inner.length,open:async()=>zipStream([entry])};const outer=await collect(zipStream([outerEntry]));assert.equal(outer.length,zipSize([outerEntry]));assert.ok(outer.includes(bytes));assert.equal(outer.readUInt32LE(outer.length-22),0x06054b50);
 await assert.rejects(collect(zipStream([{...entry,size:bytes.length+1}])) ,/ARCHIVE_SIZE_MISMATCH/);assert.throws(()=>zipSize([{name:'../escape',size:1}]),/INVALID_ARCHIVE_NAME/);
});

test('department workgroup directory excludes unrelated and inactive branches',async()=>{
 const other=randomUUID(),operation=createWorkgroupDirectoryOperation({listOrganizationUnits:async()=>[{id:org,name:'部门',parentId:null,status:'active',unitType:'department'},{id:team,name:'一班',parentId:org,status:'active',unitType:'workgroup'},{id:other,name:'外部工班',parentId:null,status:'active',unitType:'workgroup'}] as any});assert.deepEqual(await operation.execute({} as any,{organizationUnitId:org},signal),{rows:[{id:team,name:'一班'}]});
});

test('archive HTTP route rechecks export permissions and delivers nested ZIP names',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hct-archive-')),app=Fastify();try{
  const storage=createLocalStorageAdapter({rootDir:root}),{transfer,repository}=transferFixture(storage);await transfer.upload(actor(),{appId:'huicetong',entityType:'work_record',entityId:entity,intentId:randomUUID(),fileName:'证据.pdf',bytes:Buffer.from('%PDF-content')});let allowed=true,exports=0;
  await app.register(cookie);registerEmployeeRoutes(app,{origin:'http://127.0.0.1:3102',service:{authenticate:async()=>({personId:person,passwordChangeRequired:false}),resolveIdentity:async()=>({source:'session',userId:person})} as any,resolveAdmin:async()=>{throw Error('unused');},management:{authorizeEmployeeAttachment:async(_app:any,_identity:any,_admission:any,request:any)=>{assert.equal(request.action,'export');exports++;if(!allowed)throw Object.assign(Error('ACCESS_DENIED'),{statusCode:403});return {context:actor(),organizationId:org};}} as any,attachmentBackend:{connect:async()=>({release(){}} as any),repository:()=>repository,directory:()=>({findPerson:async()=>({organizationUnitId:team,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'部门'})}),storage}});
  await app.ready();const input={fileName:'2026-10-26.zip',batch:true,records:[{entityType:'work_record',entityId:entity,fileName:'YD-001+张三.zip'}]},headers={origin:'http://127.0.0.1:3102','x-mop-employee-admission':'bound'};
  const result=await app.inject({method:'POST',url:'/api/employee/apps/huicetong/attachments-archive',headers,payload:input});assert.equal(result.statusCode,200,result.body);assert.ok(result.rawPayload.includes(Buffer.from('YD-001+张三.zip')));assert.ok(result.rawPayload.includes(Buffer.from('%PDF-content')));assert.equal(Number(result.headers['content-length']),result.rawPayload.length);assert.ok(exports>1);
  allowed=false;const denied=await app.inject({method:'POST',url:'/api/employee/apps/huicetong/attachments-archive',headers,payload:input});assert.notEqual(denied.statusCode,200);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('real Huicetong server entry runs its background hook and returns the raw attachment authorization contract',async()=>{
 const {build}=await import('esbuild'),{AppProcessV2}=await import('../src/app-platform/v2/process.ts');const root=await mkdtemp(join(tmpdir(),'hct-child-'));
 try{
  await build({entryPoints:[new URL('../../applications/huicetong/src/server.js',import.meta.url).pathname],outfile:join(root,'server.js'),bundle:true,format:'esm',platform:'node',target:'node22',logLevel:'silent'});
  const calls:{operation:string;callId?:string}[]=[],record={id:entity,organization_id:org,kind:'monthly',responsible_id:person,responsible_organization_id:team,created_by:person,deleted:false,status:'in_progress',version:2};
  const app=new AppProcessV2({appId:'huicetong',serverPath:join(root,'server.js'),cwd:root,log:()=>{},onPlatform:async(operation,input:any,callId)=>{calls.push({operation,callId});if(operation==='platform.people.organization_context')return {organizations:[{id:team,unitType:'workgroup'},{id:org,unitType:'department'}]};if(operation==='platform.app_data.list')return {rows:[],nextCursor:null};if(operation==='platform.app_data.get')return {row:record};if(operation==='platform.attachments.list')return {attachments:[]};throw Error(operation);}});
  try{
   await app.start();const employee={version:'1.0',personId:person,organizationUnitId:team,requestId:randomUUID(),traceId:randomUUID(),businessAuthorization:{revision:randomUUID(),organizations:[{id:team,name:'一班'}],grants:['read','complete'].map(code=>({permission:`app.huicetong.${code}`,all:false,self:true,organizationIds:[]}))}} as any;
   assert.deepEqual(await app.call('authorize-attachment',{action:'read',entityType:'work_record',entityId:entity,requestId:randomUUID()},employee),{organizationId:org});
   const result=await app.call('record-progress',{id:entity,requestId:randomUUID(),expectedVersion:2,summary:'完成',complete:true},employee) as any;assert.equal(result.error.code,'ATTACHMENT_REQUIRED');assert.ok(calls.some(call=>call.operation==='platform.app_data.list'&&!call.callId));assert.ok(calls.some(call=>call.operation==='platform.attachments.list'&&call.callId));
  }finally{await app.stop();}
 }finally{await rm(root,{recursive:true,force:true});}
});
