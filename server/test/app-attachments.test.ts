import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createLocalStorageAdapter} from '../src/core/storage/index.ts';
import {createMemoryAttachmentRepository} from '../src/platform/attachments/index.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import {createAppAttachmentTransfer,bindEmployeeAttachmentActor,inspectAppAttachment,APP_ATTACHMENT_MAX_BYTES,AppAttachmentError} from '../src/app-platform/employee/attachment-service.ts';
import {createAppAttachmentAuthorizationHandler} from '../../packages/platform-sdk/src/app-files-backend.ts';
import {createSandboxAttachmentClient,APP_ATTACHMENT_MAX_BYTES as SDK_ATTACHMENT_MAX_BYTES} from '../../packages/platform-sdk/src/app-files.ts';
import {createAppSandboxClient,type AppSandboxPort} from '../../packages/platform-sdk/src/app-sandbox.ts';
import {SandboxBridgeBroker} from '../../src/app-platform/host/sandbox/bridge.ts';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';
import type {AppManagement} from '../src/app-platform/management/service.ts';
import type {EmployeeIdentityService} from '../src/platform/employee-identity/index.ts';
import type {QueryableClient} from '../src/core/database/index.ts';

const org='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222',entity='33333333-3333-4333-8333-333333333333';
function context(appId='sample',granted=true):PlatformActorContext {
 const decision=(permissionCode:string)=>({id:randomUUID(),allowed:granted,reasonCode:granted?'allowed':'denied',permissionCode,subjectType:'person' as const,effectiveScopes:[],decidedAt:new Date().toISOString()});
 return {actorType:'person',trustedIdentity:{source:'session',userId:person},person:{id:person,employeeNo:'1',name:'员工',avatarUrl:null,organization:{id:org,code:'team',name:'工班',unitType:'workgroup'},position:{id:randomUUID(),code:'member',name:'成员'}},
  execution:{type:'application',appId},request:{requestId:randomUUID(),traceId:randomUUID(),startedAt:new Date().toISOString()},authorize:async code=>decision(code),authorizeApplication:async code=>decision(code)} as PlatformActorContext;
}
const selected=(name:string,bytes:Uint8Array)=>Object.assign(new Blob([bytes]),{name});

test('50 MiB file contract accepts Word, Excel, PDF and ZIP signatures and rejects spoofing',()=>{
 assert.equal(SDK_ATTACHMENT_MAX_BYTES,APP_ATTACHMENT_MAX_BYTES);
 const entries:[string,number[],string?][]=[['a.doc',[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]],['a.xls',[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]],
  ['a.docx',[0x50,0x4b,0x03,0x04],'word/document.xml'],['a.xlsx',[0x50,0x4b,0x03,0x04],'xl/workbook.xml'],['a.pdf',[0x25,0x50,0x44,0x46,0x2d]],['a.zip',[0x50,0x4b,0x03,0x04]]];
 for(const [name,signature,entry] of entries)assert.ok(inspectAppAttachment(name,Buffer.concat([Buffer.from(signature),Buffer.from(entry??'body')])).contentType);
 assert.throws(()=>inspectAppAttachment('../bad.pdf',Buffer.from('%PDF-test')),(e:unknown)=>e instanceof AppAttachmentError&&e.code==='INVALID_FILE');
 assert.throws(()=>inspectAppAttachment('bad.exe',Buffer.from('%PDF-test')),(e:unknown)=>e instanceof AppAttachmentError&&e.code==='UNSUPPORTED_FILE');
 assert.throws(()=>inspectAppAttachment('bad.pdf',Buffer.from('PK\x03\x04test')),(e:unknown)=>e instanceof AppAttachmentError&&e.code==='INVALID_FILE');
 const bytes=Buffer.alloc(APP_ATTACHMENT_MAX_BYTES+1);bytes.write('%PDF-');
 assert.equal(inspectAppAttachment('max.pdf',bytes.subarray(0,APP_ATTACHMENT_MAX_BYTES)).sizeBytes,APP_ATTACHMENT_MAX_BYTES);
 assert.throws(()=>inspectAppAttachment('over.pdf',bytes),(e:unknown)=>e instanceof AppAttachmentError&&e.code==='FILE_TOO_LARGE');
});

test('attachment authorization handler delegates every record decision and bounds its input',async()=>{
 const employee={personId:person} as Parameters<ReturnType<typeof createAppAttachmentAuthorizationHandler>>[1];
 const seen:string[]=[];
 const handler=createAppAttachmentAuthorizationHandler({authorizeUpload:async(_employee,source)=>{seen.push(`upload:${source.entityId}`);return {organizationId:org};},authorizeRead:async(_employee,source)=>{seen.push(`read:${source.entityId}`);return {organizationId:org};}});
 assert.deepEqual(await handler({action:'upload',entityType:'plan_item',entityId:entity,requestId:randomUUID()},employee),{organizationId:org});
 assert.deepEqual(await handler({action:'read',entityType:'plan_item',entityId:entity,requestId:randomUUID(),attachmentId:randomUUID()},employee),{organizationId:org});
 assert.deepEqual(seen,[`upload:${entity}`,`read:${entity}`]);
 await assert.rejects(handler({action:'upload',entityType:'plan_item',entityId:entity,requestId:randomUUID(),attachmentId:randomUUID()},employee),/INVALID_INPUT/);
});

test('stored originals are associated with the source record and recheck business and app grants on read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-'));
 try{
  let allowed=true;
  const repository=createMemoryAttachmentRepository(),storage=createLocalStorageAdapter({rootDir:root});
  const transfer=createAppAttachmentTransfer({repository,storage,directory:{findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})},
   authorize:async()=>{if(!allowed)throw new AppAttachmentError('ACCESS_DENIED');return {organizationId:org};}});
  const bytes=Buffer.from('%PDF-test'),intentId=randomUUID();
  await assert.rejects(transfer.upload(context('sample',false),{appId:'sample',entityType:'plan_item',entityId:entity,intentId:randomUUID(),fileName:'拒绝.pdf',bytes}),/ACCESS_DENIED/);
  const uploaded=await transfer.upload(context(),{appId:'sample',entityType:'plan_item',entityId:entity,intentId,fileName:'计划.pdf',bytes});
  assert.equal(uploaded.fileName,'计划.pdf');assert.equal(uploaded.sizeBytes,bytes.length);
  const listed=await transfer.list(context(),'sample','plan_item',entity);
  assert.equal(listed.attachments[0]?.intentId,intentId);
  const file=await transfer.read(context(),'sample',uploaded.attachmentId),chunks:Buffer[]=[];
  for await(const chunk of file.stream)chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks),bytes);
  await assert.rejects(transfer.read(context('other'), 'sample',uploaded.attachmentId),/ACCESS_DENIED/);
  await assert.rejects(transfer.read(context('sample',false),'sample',uploaded.attachmentId));
  allowed=false;
  await assert.rejects(transfer.read(context(),'sample',uploaded.attachmentId),/ACCESS_DENIED/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('employee attachment actor uses approved app service grants without requiring employee platform role',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-grant-'));
 try{
  const personActor=context() as Extract<PlatformActorContext,{actorType:'person'}>;
  personActor.authorize=async()=>({allowed:false} as Awaited<ReturnType<typeof personActor.authorize>>);
  personActor.authorizeApplication=personActor.authorize;
  let granted=true;
  const serviceActor={actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId:'sample',serviceIdentityId:'service'},request:personActor.request,
   authorize:async()=>({allowed:granted} as Awaited<ReturnType<typeof personActor.authorize>>),
   authorizeApplication:async()=>({allowed:granted} as Awaited<ReturnType<typeof personActor.authorize>>)} as Extract<PlatformActorContext,{actorType:'service'}>;
  assert.throws(()=>bindEmployeeAttachmentActor(personActor,{...serviceActor,execution:{...serviceActor.execution,appId:'other'}}),/ACCESS_DENIED/);
  const actor=bindEmployeeAttachmentActor(personActor,serviceActor),repository=createMemoryAttachmentRepository();
  const transfer=createAppAttachmentTransfer({repository,storage:createLocalStorageAdapter({rootDir:root}),
   directory:{findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})},
   authorize:async()=>({organizationId:org})});
  const uploaded=await transfer.upload(actor,{appId:'sample',entityType:'plan_item',entityId:entity,intentId:randomUUID(),fileName:'计划.pdf',bytes:Buffer.from('%PDF-test')});
  assert.equal((await repository.findAttachmentById(uploaded.attachmentId))?.uploaderPersonId,person);
  granted=false;
  await assert.rejects(transfer.read(actor,'sample',uploaded.attachmentId));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('business revocation during storage prevents attachment registration and removes the staged object',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-revoke-'));
 try{
  let allowed=true;
  const base=createLocalStorageAdapter({rootDir:root}),repository=createMemoryAttachmentRepository();
  const storage={...base,writeObject:async(...args:Parameters<typeof base.writeObject>)=>{const result=await base.writeObject(...args);allowed=false;return result;}};
  const transfer=createAppAttachmentTransfer({repository,storage,
   directory:{findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})},
   authorize:async()=>{if(!allowed)throw new AppAttachmentError('ACCESS_DENIED');return {organizationId:org};}});
  await assert.rejects(transfer.upload(context(),{appId:'sample',entityType:'plan_item',entityId:entity,intentId:randomUUID(),fileName:'计划.pdf',bytes:Buffer.from('%PDF-test')}),/ACCESS_DENIED/);
  assert.equal((await repository.listAttachments({sourceAppId:'sample',sourceEntityType:'plan_item',sourceEntityId:entity})).length,0);
  const names=await (await import('node:fs/promises')).readdir(base.folderPath('app-attachments'));
  assert.deepEqual(names,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('platform grant revocation before registration removes the staged object',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-grant-revoke-'));
 try{
  let granted=true;
  const base=createLocalStorageAdapter({rootDir:root}),repository=createMemoryAttachmentRepository();
  const storage={...base,writeObject:async(...args:Parameters<typeof base.writeObject>)=>{const result=await base.writeObject(...args);granted=false;return result;}};
  const actor=context() as Extract<PlatformActorContext,{actorType:'person'}>;
  actor.authorize=async()=>({allowed:granted} as Awaited<ReturnType<typeof actor.authorize>>);
  actor.authorizeApplication=actor.authorize;
  const transfer=createAppAttachmentTransfer({repository,storage,
   directory:{findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})},
   authorize:async()=>({organizationId:org})});
  await assert.rejects(transfer.upload(actor,{appId:'sample',entityType:'plan_item',entityId:entity,intentId:randomUUID(),fileName:'计划.pdf',bytes:Buffer.from('%PDF-test')}));
  assert.equal((await repository.listAttachments({sourceAppId:'sample',sourceEntityType:'plan_item',sourceEntityId:entity})).length,0);
  assert.deepEqual(await (await import('node:fs/promises')).readdir(base.folderPath('app-attachments')),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unknown registration outcome retains bytes for a possibly committed attachment',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-unknown-'));
 try{
  const base=createMemoryAttachmentRepository(),storage=createLocalStorageAdapter({rootDir:root});
  const repository={...base,createAttachment:async(...args:Parameters<typeof base.createAttachment>)=>{await base.createAttachment(...args);throw Error('ACK_LOST');}};
  const transfer=createAppAttachmentTransfer({repository,storage,
   directory:{findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})},
   authorize:async()=>({organizationId:org})});
  await assert.rejects(transfer.upload(context(),{appId:'sample',entityType:'plan_item',entityId:entity,intentId:randomUUID(),fileName:'计划.pdf',bytes:Buffer.from('%PDF-test')}),/ACK_LOST/);
  const [record]=await base.listAttachments({sourceAppId:'sample',sourceEntityType:'plan_item',sourceEntityId:entity});
  assert.ok(record);
  assert.equal(await storage.exists(record.storageKind,record.storageFileName),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('sandbox file client sends Blob outside JSON Bridge and keeps intent ID for reconciliation',async()=>{
 const parent={},child={},session='a'.repeat(32),origin='https://platform.example';let listener:Parameters<AppSandboxPort['listen']>[0]=()=>{};
 const bytes=Uint8Array.from([0x25,0x50,0x44,0x46,0x2d,0x78]);const intentId=randomUUID(),attachmentId=randomUUID();
 let uploads=0;
 const broker=new SandboxBridgeBroker({appId:'sample',session,source:child,operations:new Map(),files:{
  upload:async(params,blob)=>{uploads++;assert.equal(blob.size,bytes.length);assert.equal((params as {intentId:string}).intentId,intentId);return {attachmentId,fileName:'plan.pdf',sizeBytes:blob.size,contentType:'application/pdf'};},
  read:async()=>({blob:new Blob([bytes],{type:'application/pdf'}),fileName:'plan.pdf'}),
  list:async()=>({attachments:[{attachmentId,intentId,fileName:'plan.pdf',contentType:'application/pdf',sizeBytes:bytes.length,createdAt:new Date().toISOString()}],nextCursor:null})
 },send:data=>listener({source:parent,origin,data})});
 const sandbox=createAppSandboxClient({appId:'sample',platformOrigin:origin,port:{parent,listen:fn=>{listener=fn;return()=>{};},send:data=>{void broker.receive({source:child,origin:'null',data});}}});
 listener({source:parent,origin,data:{version:'1.0',type:'init',appId:'sample',session}});
 const files=createSandboxAttachmentClient(sandbox),file=selected('plan.pdf',bytes);
 await broker.receive({source:{},origin:'null',data:{version:'1.0',type:'file-request',appId:'sample',session,id:99,method:'upload',params:{},blob:file}});
 assert.equal(uploads,0);
 assert.equal((await files.upload(file,{entityType:'plan_item',entityId:entity,intentId})).attachmentId,attachmentId);
 assert.equal(uploads,1);
 assert.equal((await files.list({entityType:'plan_item',entityId:entity})).attachments[0]?.intentId,intentId);
 assert.deepEqual(new Uint8Array(await (await files.read(attachmentId)).blob.arrayBuffer()),bytes);
 sandbox.close();broker.close();
});

test('employee binary route enforces origin, business authorization and attachment binding',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mop-attachment-route-'));
 const app=Fastify(),repository=createMemoryAttachmentRepository(),storage=createLocalStorageAdapter({rootDir:root});
 const origin='http://127.0.0.1:3102';let allowed=true,authorizations=0;
 const management={authorizeEmployeeAttachment:async(appId:string,_identity:unknown,binding:string,request:{action:string})=>{
  authorizations++;
  if(!allowed||appId!=='sample'||binding!=='bound')throw new GatewayError('ACCESS_DENIED',403);
  assert.ok(['upload','read'].includes(request.action));
  return {context:context(),organizationId:org};
 }} as unknown as AppManagement;
 const identity={authenticate:async()=>({personId:person,passwordChangeRequired:false}),resolveIdentity:async()=>({source:'session',userId:person})} as unknown as EmployeeIdentityService;
 const database={connect:async()=>({query:async()=>{throw Error('UNUSED');},release(){}} as unknown as QueryableClient&{release():void}),repository:()=>repository,
  directory:()=>({findPerson:async()=>({organizationUnitId:org,employmentStatus:'active',name:'员工'}),findOrganizationUnit:async()=>({status:'active',name:'工班'})}),storage};
 try{
  await app.register(cookie);
  registerEmployeeRoutes(app,{origin,service:identity,resolveAdmin:async()=>{throw Error('ADMIN_DENIED');},management,attachmentBackend:database});
  await app.ready();
  const headers={origin,'x-mop-employee-admission':'bound','content-type':'application/octet-stream'};
  const payload=Buffer.from('%PDF-route'),intentId=randomUUID();
  const url=`/api/employee/apps/sample/attachments?${new URLSearchParams({entityType:'plan_item',entityId:entity,intentId,fileName:'报告.pdf'})}`;
  const denied=await app.inject({method:'POST',url,headers:{...headers,origin:'https://evil.example'},payload});
  assert.equal(denied.statusCode,403);assert.equal(authorizations,0);
  const tooLarge=await app.inject({method:'POST',url,headers,payload:Buffer.alloc(APP_ATTACHMENT_MAX_BYTES+1)});
  assert.equal(tooLarge.statusCode,413,tooLarge.body);assert.equal(authorizations,0);
  const saved=await app.inject({method:'POST',url,headers,payload});
  assert.equal(saved.statusCode,200,saved.body);
  const attachmentId=saved.json().attachmentId as string;
  const list=await app.inject({method:'GET',url:`/api/employee/apps/sample/attachments?entityType=plan_item&entityId=${entity}`,headers:{'x-mop-employee-admission':'bound'}});
  assert.equal(list.statusCode,200,list.body);assert.equal(list.json().attachments[0].attachmentId,attachmentId);
  const read=await app.inject({method:'GET',url:`/api/employee/apps/sample/attachments/${attachmentId}`,headers:{'x-mop-employee-admission':'bound'}});
  assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.rawPayload,payload);
  assert.match(String(read.headers['content-disposition']),/attachment/);
  allowed=false;
  const revoked=await app.inject({method:'GET',url:`/api/employee/apps/sample/attachments/${attachmentId}`,headers:{'x-mop-employee-admission':'bound'}});
  assert.equal(revoked.statusCode,403);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
