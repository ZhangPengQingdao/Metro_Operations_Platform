import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedAppOperations, type ManagedAppAdminClient, type ManagedAppLockedScope } from '../src/app-platform/storage/managed-operations.ts';
import { binding, AppStorageError } from '../src/app-platform/storage/binding.ts';
import type { AppInstallation } from '../src/app-platform/registry/index.ts';
import type { PlatformPersonActorContext } from '../src/platform/context/index.ts';

const now = '2026-09-11T00:00:00.000Z';
const admin: PlatformPersonActorContext = {
 actorType:'person', trustedIdentity:{source:'session',userId:'admin'}, execution:{type:'platform'},
 request:{requestId:'r',traceId:'t',startedAt:now},
 person:{id:'admin',employeeNo:'1',name:'Admin',avatarUrl:null,organization:{id:'org',code:'org',name:'Org',unitType:'company'},position:{id:'p',code:'p',name:'P'}},
 authorize:async permissionCode => ({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'person',effectiveScopes:[],decidedAt:now}),
};

// Transport fakes test lease ordering/failures; real PostgreSQL integration tests own SQL evidence.
function fixture() {
 const record: AppInstallation = {
  id:'00000000-0000-4000-8000-000000000001', appId:'tools', revision:1, enabled:false,
  grants:[], serviceIdentityId:null, createdAt:now, updatedAt:now,
  manifest:{manifestVersion:'1.0',id:'tools',version:'1.0.0',name:'Tools',description:'fixture',publisherId:'example',
   compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},
   ui:{mode:'none'},backend:{mode:'external',origin:'https://example.com'},storage:{mode:'managed',migrations:[]},
   routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],artifacts:[],network:{frontendOrigins:[],backendOrigins:[]}},
 };
 const candidate = binding(record); if (candidate.mode !== 'managed') throw new Error('fixture');
 const plan = candidate;
 const queries: {sql:string; values?:readonly unknown[]}[] = [];
 const state = { connects:0, ends:0, login:false, secret:null as string|null, active:false, leaseId:'prior',
  owner:plan.ownerRole, sessions:0, stop:true, database:'isolated', failLogin:false, failRelease:false, failEnd:false };
 const client: ManagedAppAdminClient = {
  async query(sql,values) {
   queries.push({sql,values});
   if (sql === 'SELECT current_database() AS database') return {rows:[{database:state.database}]};
   if (sql.startsWith('SELECT id,owner_role')) return {rows:state.active ? [{id:state.leaseId,owner_role:state.owner}] : []};
   if (sql.startsWith('INSERT INTO public.platform_app_storage_leases')) {state.active=true;state.leaseId=String(values?.[0]);return {rows:[]};}
   if (sql.startsWith('SELECT to_char')) return {rows:[{expiry:'2026-09-11 00:05:00.000000+00'}]};
   if (sql.includes(' LOGIN PASSWORD')) {state.login=true;state.secret='verifier';if(state.failLogin)throw new Error('private password');}
   if (sql.includes(' NOLOGIN PASSWORD NULL')) {state.login=false;state.secret=null;}
   if (sql.startsWith('SELECT pg_catalog.pg_terminate_backend')) {const count=state.sessions;if(state.stop)state.sessions=0;return {rows:Array.from({length:count},()=>({stopped:state.stop}))};}
   if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_stat_activity')) return {rows:Array.from({length:state.sessions},()=>({exists:1}))};
   if (sql.startsWith('SELECT rolcanlogin')) return {rows:[{rolcanlogin:state.login,rolpassword:state.secret}]};
   if (sql.startsWith('UPDATE public.platform_app_storage_leases')) {if(state.failRelease)throw new Error('private SQL');state.active=false;}
   return {rows:[]};
  },
  async end(){state.ends++;if(state.failEnd)throw new Error('private socket');},
 };
 const options = {connectAdmin:async()=>{state.connects++;return client;},registry:()=>({get:async()=>structuredClone(record)}),
  endpoint:{host:'127.0.0.1',port:5432,database:'isolated',ssl:false as const}};
 const operations = new ManagedAppOperations(options);
 function ready(scope:ManagedAppLockedScope) {
  scope.storage.assertReady = async()=>plan;
  scope.storage.assertExportReady = async()=>plan;
 }
 return {record,plan,state,queries,options,operations,ready};
}

test('managed lease persists before LOGIN, never logs plaintext, and revokes before unlocking',async()=>{
 const f=fixture();let secret='';
 assert.equal(await f.operations.withLock(admin,'tools',1,async scope=>{
  f.ready(scope);
  return scope.withOwner(async(credentials,b)=>{secret=credentials.password;assert.equal(credentials.user,b.ownerRole);assert.equal(f.state.active,true);assert.equal(f.state.login,true);f.state.sessions=1;return 'ok';});
 }),'ok');
 assert.equal(f.queries[0].sql,'SET search_path = pg_catalog, public');
 const insert=f.queries.findIndex(q=>q.sql.startsWith('INSERT'));const login=f.queries.findIndex(q=>q.sql.includes(' LOGIN PASSWORD'));
 assert.ok(insert>=0&&login>insert);assert.match(f.queries[login].sql,/SCRAM-SHA-256/);
 assert.ok(secret.length>=40);assert.ok(!JSON.stringify(f.queries).includes(secret));
 assert.equal(f.state.login,false);assert.equal(f.state.secret,null);assert.equal(f.state.sessions,0);assert.equal(f.state.active,false);assert.equal(f.state.ends,1);
});

test('callback failure and ambiguous LOGIN acknowledgement still revoke; errors are sanitized',async()=>{
 for(const loginFailure of [false,true]){
  const f=fixture();f.state.failLogin=loginFailure;
  await assert.rejects(f.operations.withLock(admin,'tools',1,async scope=>{f.ready(scope);return scope.withOwner(async()=>{throw new Error('private password');});}),{message:'STORAGE_OPERATION_FAILED'});
  assert.equal(f.state.active,false);assert.equal(f.state.login,false);assert.equal(f.state.ends,1);
 }
});

test('recovery holds installation lock and quiesces recorded owner independent of expiry',async()=>{
 const f=fixture();Object.assign(f.state,{active:true,login:true,secret:'old',sessions:2});
 assert.deepEqual(await f.operations.recover(admin,'tools',1),{recovered:true});
 assert.equal(f.state.active,false);assert.equal(f.state.sessions,0);
 const lock=f.queries.findIndex(q=>q.sql.includes('pg_advisory_lock'));
 assert.ok(lock<f.queries.findIndex(q=>q.sql.includes(' NOLOGIN PASSWORD NULL')));
 assert.ok(f.queries.filter(q=>q.sql.includes('pg_stat_activity')).every(q=>q.values?.[0]===f.plan.ownerRole));
 assert.ok(!f.queries.some(q=>q.sql.includes('expires_at')));
});

test('failed termination or release retains durable active lease and blocks callback',async()=>{
 for(const fault of ['stop','release'] as const){
  const f=fixture();Object.assign(f.state,{active:true,login:true,sessions:1});
  if(fault==='stop')f.state.stop=false;else f.state.failRelease=true;
  let calls=0;
  await assert.rejects(f.operations.withLock(admin,'tools',1,async()=>{calls++;}),{code:'STORAGE_LEASE_CLEANUP_REQUIRED'});
  assert.equal(calls,0);assert.equal(f.state.active,true);assert.equal(f.state.ends,1);
 }
 const conflict=fixture();conflict.state.active=true;conflict.state.owner='postgres';
 await assert.rejects(conflict.operations.recover(admin,'tools',1),{code:'STORAGE_LEASE_BINDING_CONFLICT'});
 assert.ok(!conflict.queries.some(q=>q.sql.startsWith('ALTER ROLE')));
});

test('authorization, revision and database gates precede privileged lease writes',async()=>{
 const denied=fixture();
 const context={...admin,authorize:async()=>{throw new Error('private token');}};
 await assert.rejects(denied.operations.recover(context,'tools',1),{message:'STORAGE_OPERATION_FAILED'});assert.equal(denied.state.connects,0);
 const stale=fixture();stale.record.revision=2;
 await assert.rejects(stale.operations.recover(admin,'tools',1),{code:'STALE_REVISION'});assert.ok(!stale.queries.some(q=>q.sql.startsWith('ALTER')));
 const db=fixture();db.state.database='other';
 await assert.rejects(db.operations.recover(admin,'tools',1),{code:'STORAGE_DATABASE_MISMATCH'});assert.equal(db.state.ends,1);
});

test('owner readiness failures never issue credentials and retained export uses separate admission',async()=>{
 const f=fixture();let exports=0;
 await f.operations.withLock(admin,'tools',1,async scope=>{
  scope.storage.assertReady=async()=>{throw new AppStorageError('STORAGE_RETAINED');};
  scope.storage.assertExportReady=async()=>{exports++;return f.plan;};
  return scope.withOwner(async()=>undefined,{allowRetained:true});
 });assert.equal(exports,1);
 const denied=fixture();
 await assert.rejects(denied.operations.withLock(admin,'tools',1,async scope=>{
  scope.storage.assertReady=async()=>{throw new AppStorageError('STORAGE_ACL_DRIFT');};
  return scope.withOwner(async()=>undefined);
 }),{code:'STORAGE_ACL_DRIFT'});
 assert.ok(!denied.queries.some(q=>q.sql.startsWith('INSERT')));
});

test('scope cannot escape its lock and concurrent owner use fails closed',async()=>{
 const f=fixture();let escaped:ManagedAppLockedScope|undefined;
 await f.operations.withLock(admin,'tools',1,async scope=>{
  escaped=scope;f.ready(scope);
  await scope.withOwner(async()=>{await assert.rejects(scope.withOwner(async()=>undefined),{code:'STORAGE_OWNER_BUSY'});});
 });
 assert.ok(escaped);
 await assert.rejects(escaped.withOwner(async()=>undefined),{code:'STORAGE_OWNER_BUSY'});
 await assert.rejects(escaped.revalidate(),{code:'STORAGE_SCOPE_CLOSED'});
});

test('forgotten owner promise is settled and cleaned before platform session closes',async()=>{
 const f=fixture();let finish!:()=>void;let started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});const waiting=new Promise<void>(resolve=>{finish=resolve;});
 const operation=f.operations.withLock(admin,'tools',1,async scope=>{f.ready(scope);void scope.withOwner(async()=>{started();await waiting;});await began;return 'done';});
 await began;assert.equal(f.state.ends,0);finish();assert.equal(await operation,'done');assert.equal(f.state.ends,1);assert.equal(f.state.active,false);
});

test('endpoint and lease bounds reject unsafe configuration and close failures cannot report success',async()=>{
 const f=fixture();
 for(const leaseSeconds of [0,4,901,1.5])assert.throws(()=>new ManagedAppOperations({...f.options,leaseSeconds}),{code:'INVALID_LEASE_DURATION'});
 for(const endpoint of [{...f.options.endpoint,host:'db.example.com'},{...f.options.endpoint,port:0},{...f.options.endpoint,database:''}])assert.throws(()=>new ManagedAppOperations({...f.options,endpoint}),{code:'INVALID_STORAGE_ENDPOINT'});
 f.state.failEnd=true;await assert.rejects(f.operations.recover(admin,'tools',1),{code:'STORAGE_SESSION_CLOSE_FAILED'});
});

test('successful owner work is not reported successful when its final cleanup fails',async()=>{
 const f=fixture();
 await assert.rejects(f.operations.withLock(admin,'tools',1,async scope=>{
  f.ready(scope);
  return scope.withOwner(async()=>{f.state.failRelease=true;return 'committed';});
 }),{code:'STORAGE_LEASE_CLEANUP_REQUIRED'});
 assert.equal(f.state.active,true);assert.equal(f.state.login,false);assert.equal(f.state.ends,1);
});
