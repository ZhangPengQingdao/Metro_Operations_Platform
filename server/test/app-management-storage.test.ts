import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createManagedStorageComposition,createStorageArtifactReader,parseStorageDatabaseUrl} from '../src/app-platform/management/storage.ts';
import {isAppRuntimeSupported,loadAppManagementConfig,type AppManagementConfig} from '../src/app-platform/management/config.ts';
import {binding} from '../src/app-platform/storage/binding.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';

const apiUrl='postgresql://api:secret@127.0.0.1:5432/isolated';
const adminUrl='postgresql://storage:other-secret@127.0.0.1:5432/isolated';
const config:AppManagementConfig={version:1,artifactRoot:'/packages',runtimeRoot:'/runtime',uploadRoot:'/uploads',publisherPolicyFile:'/publishers.json',approvedManifestDigests:[]};
const manifest:AppManifest={manifestVersion:'1.0',id:'storage-test',version:'1.0.0',name:'Storage',description:'test',publisherId:'test',
 compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},
 ui:{mode:'none'},backend:{mode:'isolated',runtime:'node',entryArtifactId:'backend',limits:{memoryMiB:64,cpuMillis:1000,timeoutSeconds:30}},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'migration'}]},
 routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],
 artifacts:[{id:'migration',path:'initial.json',kind:'migration',sha256:'a'.repeat(64),bytes:4}],network:{frontendOrigins:[],backendOrigins:[]}};

test('managed storage is opt-in and does not admit other uncomposed declarations',async()=>{
 assert.equal(isAppRuntimeSupported(manifest,config),false);
 const enabled={...config,managedStorage:true,docker:{socketPath:'/docker.sock',runtimeImage:'node@sha256:'+'a'.repeat(64),approval:{imageId:'sha256:'+'a'.repeat(64),config:{}}}};
 assert.equal(isAppRuntimeSupported(manifest,enabled),true);
 for(const change of [{storage:{mode:'external',configurationRef:'db'}},{api:[{}]},{tools:[{}]},{jobs:[{}]},
  {events:{publish:['app.test.changed.v1'],subscribe:[]}},{network:{frontendOrigins:['https://example.com'],backendOrigins:[]}},
  {ui:{mode:'trusted'}},{backend:{mode:'external'}}])assert.equal(isAppRuntimeSupported({...manifest,...change} as AppManifest,enabled),false);
 assert.equal(isAppRuntimeSupported(manifest,{...config,managedStorage:true}),false);
 const root=await mkdtemp(join(tmpdir(),'mop-storage-config-'));
 try{
  const file=join(root,'config.json');await writeFile(file,JSON.stringify(enabled));
  assert.equal((await loadAppManagementConfig(file)).managedStorage,true);
  await writeFile(file,JSON.stringify({...config,managedStorage:'true'}));await assert.rejects(loadAppManagementConfig(file));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('storage URL contract pins endpoint and TLS without ambient connection parameters',()=>{
 assert.deepEqual(parseStorageDatabaseUrl(apiUrl),{host:'127.0.0.1',port:5432,database:'isolated',user:'api',password:'secret',ssl:false});
 assert.deepEqual(parseStorageDatabaseUrl('postgresql://api:p%40ss@db.example.com/isolated?sslmode=verify-full').ssl,{rejectUnauthorized:true});
 assert.equal(parseStorageDatabaseUrl('postgresql://api:secret@[::1]/isolated').host,'::1');
 for(const value of [undefined,'','not a URL',apiUrl+'?options=-c%20role%3Dpostgres',apiUrl+'?sslmode=no-verify',apiUrl+'?sslmode=disable&sslmode=verify-full',
  apiUrl+'#secret',apiUrl.replace('127.0.0.1','db.example.com'),apiUrl.replace(':secret',''),apiUrl.replace('/isolated','/a%2Fb'),apiUrl.replace('api:','a%00:')])
  assert.throws(()=>parseStorageDatabaseUrl(value),{message:'STORAGE_DATABASE_CONFIG_INVALID'});
});

function preflight(){
 const state={ends:0,connections:0,admin:true,apiSuper:false,apiCreate:false,membership:false,missing:false,unsafe:false,connectFail:false,closeFail:false};
 const queries:string[]=[];
 const client={connect:async()=>{state.connections++;if(state.connectFail)throw Error('private connection secret');},end:async()=>{state.ends++;if(state.closeFail)throw Error('private close secret');},on:()=>{},
  query:async(sql:string)=>{queries.push(sql);
   if(sql.includes('r.rolsuper'))return {rows:[{session_user:'storage',current_user:'storage',database:'isolated',rolsuper:state.admin}]};
   if(sql.includes('unnest'))return {rows:state.missing?[{name:'missing'}]:[]};
   if(sql.includes('pg_database'))return {rows:state.unsafe?[{}]:[]};
   return {rows:[]};
  }};
 const options={apiDatabaseUrl:apiUrl,adminDatabaseUrl:adminUrl,
  apiClient:{query:async()=>({rows:[{session_user:'api',current_user:'api',database:'isolated',rolsuper:state.apiSuper,rolcreaterole:state.apiCreate,admin_member:state.membership}]})},
  registry:()=>({get:async()=>{throw Error('no installation read in startup');}}),reader:{read:async()=>new Uint8Array()}};
 return {state,queries,options,create:()=>client,run:()=>createManagedStorageComposition(options,()=>client)};
}

test('storage preflight is read-only and closes its distinct management session',async()=>{
 const f=preflight();assert.ok(await f.run());assert.equal(f.state.ends,1);
 assert.ok(f.queries.length>5);assert.ok(f.queries.every(sql=>sql.startsWith('SELECT')));
});

test('storage preflight fails closed on identity, migrations and ACL prerequisites',async()=>{
 for(const [key,code] of [['admin','STORAGE_ADMIN_IDENTITY_REQUIRED'],['apiSuper','STORAGE_SEPARATE_IDENTITY_REQUIRED'],
  ['apiCreate','STORAGE_SEPARATE_IDENTITY_REQUIRED'],['membership','STORAGE_SEPARATE_IDENTITY_REQUIRED'],
  ['missing','STORAGE_MIGRATIONS_REQUIRED'],['unsafe','UNSAFE_PUBLIC_DATABASE_PRIVILEGES'],['connectFail','STORAGE_ADMIN_CONNECTION_FAILED'],
  ['closeFail','STORAGE_SESSION_CLOSE_FAILED']] as const){
  const f=preflight();f.state[key]=key==='admin'?false:true;
  await assert.rejects(f.run(),{message:code});assert.equal(f.state.ends,1);
  assert.ok(f.queries.every(sql=>sql.startsWith('SELECT')));
 }
 for(const adminDatabaseUrl of [apiUrl,adminUrl.replace('isolated','another'),adminUrl.replace('5432','5433')]){
  const f=preflight();await assert.rejects(createManagedStorageComposition({...f.options,adminDatabaseUrl},f.create));assert.equal(f.state.connections,0);
 }
});

test('migration reader binds installation, revision, manifest and exact signed artifact before reading',async()=>{
 const record={id:'44000000-0000-4000-8000-000000000001',appId:manifest.id,revision:2,manifest} as AppInstallation;
 const plan=binding(record);assert.equal(plan.mode,'managed');if(plan.mode!=='managed')return;
 const request={installationId:record.id,appId:record.appId,revision:2,manifestDigest:plan.manifestDigest,artifactId:'migration',path:'initial.json',sha256:'a'.repeat(64),bytes:4,maxBytes:4};
 let reads=0;
 const reader=createStorageArtifactReader({getInstallation:async()=>record,readArtifact:async(m,id,max)=>{reads++;assert.equal(m.id,manifest.id);assert.equal(id,'migration');assert.equal(max,4);return Uint8Array.of(1,2,3,4);}});
 for(const patch of [{installationId:'other'},{revision:3},{manifestDigest:'b'.repeat(64)},{artifactId:'other'},{path:'../escape'},{sha256:'b'.repeat(64)},{bytes:5},{maxBytes:5}])
  await assert.rejects(reader.read({...request,...patch}),{code:'STORAGE_ARTIFACT_BINDING_MISMATCH'});
 assert.equal(reads,0);assert.deepEqual(await reader.read(request),Uint8Array.of(1,2,3,4));assert.equal(reads,1);
});
