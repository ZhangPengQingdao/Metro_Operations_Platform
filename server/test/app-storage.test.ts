import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AppStorageService, type ManagedAppStorage } from '../src/app-platform/storage/index.ts';
import { AppRegistryService, MemoryAppRegistryRepository } from '../src/app-platform/registry/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
import type { PlatformPersonActorContext } from '../src/platform/context/index.ts';
import type { QueryableClient } from '../src/core/database/index.ts';

const now='2026-09-09T00:00:00.000Z';
const admin: PlatformPersonActorContext = {
  actorType:'person',trustedIdentity:{source:'session',userId:'admin'},execution:{type:'platform'},request:{requestId:'r',traceId:'t',startedAt:now},
  person:{id:'admin',employeeNo:'1',name:'Admin',avatarUrl:null,organization:{id:'org',code:'org',name:'Org',unitType:'company'},position:{id:'p',code:'p',name:'P'}},
  authorize:async(permissionCode)=>({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'person',effectiveScopes:[],decidedAt:now})
};
function manifest(id='tool-lending', storage: AppManifest['storage']={mode:'managed',migrations:[]}): AppManifest {
  return {manifestVersion:'1.0',id,version:'1.0.0',name:id,description:'test',publisherId:'example',compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},ui:{mode:'none'},backend:{mode:'none'},storage,routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],artifacts:[],network:{frontendOrigins:[],backendOrigins:[]}};
}
async function setup() {
  const db=new PGlite();
  const client: QueryableClient={query:async(sql,values)=>values ? db.query(sql,[...values]) : db.exec(sql)};
  const registry=new AppRegistryService(new MemoryAppRegistryRepository(),{authorization:{listPermissions:async()=>[]},host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]})});
  const storage=new AppStorageService(registry,client);
  // Explicitly establish isolated fixture prerequisites, never mutate a real database.
  const result=await db.query<{name:string}>('SELECT current_database() AS name');
  await db.exec(`REVOKE CREATE, TEMPORARY ON DATABASE "${result.rows[0].name}" FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await registry.register(admin,{...manifest(),backend:{mode:'external',origin:'https://example.com'}});
  return {db,client,registry,storage};
}
async function managed(service: AppStorageService, id='tool-lending') {
  const plan=await service.describe(admin,id);assert.equal(plan.mode,'managed');return plan as ManagedAppStorage;
}
// SET ROLE is solely a PostgreSQL ACL test harness; production app sessions must authenticate separately.
async function asRole(db:PGlite,role:string,sql:string) {
  await db.exec(`SET ROLE "${role}"`);
  try { return await db.exec(sql); } finally { await db.exec('RESET ROLE'); }
}
test('managed storage: installation names, repeat provisioning, real role DML and cross-app/platform isolation',async()=>{
  const f=await setup();try {
    const p=await managed(f.storage);
    assert.match(p.schema,/^app_[0-9a-f]{32}$/);assert.ok(!p.schema.includes('tool-lending'));
    assert.deepEqual(await f.storage.provision(admin,'tool-lending'),p);
    assert.deepEqual(await f.storage.provision(admin,'tool-lending'),p);
    await f.registry.register(admin,{...manifest('other-app'),backend:{mode:'external',origin:'https://example.com'}});
    const other=await f.storage.provision(admin,'other-app') as ManagedAppStorage;
    await asRole(f.db,p.ownerRole,`CREATE TABLE "${p.schema}".records(id serial PRIMARY KEY, value text)`);
    await asRole(f.db,other.ownerRole,`CREATE TABLE "${other.schema}".records(id int)`);
    await f.db.exec('CREATE TABLE public.platform_secret(id int); INSERT INTO public.platform_secret VALUES(1)');
    await asRole(f.db,p.runtimeRole,`INSERT INTO "${p.schema}".records(value) VALUES('a'); UPDATE "${p.schema}".records SET value='b'; SELECT * FROM "${p.schema}".records; DELETE FROM "${p.schema}".records`);
    for(const sql of [`CREATE TABLE "${p.schema}".bad(id int)`,`SELECT * FROM "${other.schema}".records`,'SELECT * FROM public.platform_secret','CREATE ROLE evil']) await assert.rejects(asRole(f.db,p.runtimeRole,sql),sql);
    assert.deepEqual(await f.storage.provision(admin,'tool-lending'),p);
  } finally {await f.db.close();}
});
test('preserve is repeat-safe, retains data and revokes current plus future runtime access',async()=>{
  const f=await setup();try {
    const p=await f.storage.provision(admin,'tool-lending') as ManagedAppStorage;
    await asRole(f.db,p.ownerRole,`CREATE TABLE "${p.schema}".records(id int); INSERT INTO "${p.schema}".records VALUES(1)`);
    await f.storage.preserve(admin,'tool-lending');await f.storage.preserve(admin,'tool-lending');
    await assert.rejects(f.storage.provision(admin,'tool-lending'),/STORAGE_RETAINED/);
    assert.equal((await f.db.query(`SELECT * FROM "${p.schema}".records`)).rows.length,1);
    await asRole(f.db,p.ownerRole,`CREATE TABLE "${p.schema}".future(id int)`);
    for(const table of ['records','future']) await assert.rejects(asRole(f.db,p.runtimeRole,`SELECT * FROM "${p.schema}".${table}`));
    const result=await f.db.query<{allowed:boolean}>('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[p.runtimeRole,`${p.schema}.future`]);assert.equal(result.rows[0].allowed,false);
  }finally{await f.db.close();}
});
test('native management only, none/external metadata modes and no arbitrary schema input',async()=>{
  const f=await setup();try {
    await assert.rejects(f.storage.provision({...admin,execution:{type:'application',appId:'tool-lending'}},'tool-lending'),/STORAGE_ACCESS_DENIED/);
    await assert.rejects(f.storage.provision({...admin,authorize:async(code)=>({...await admin.authorize(code),allowed:false})},'tool-lending'),/STORAGE_ACCESS_DENIED/);
    for(const storage of [{mode:'none' as const},{mode:'external' as const,configurationRef:'external-db'}]) {
      const id=`mode-${storage.mode}`;await f.registry.register(admin,{...manifest(id,storage),backend:{mode:'external',origin:'https://example.com'}});
      assert.equal((await f.storage.provision(admin,id)).mode,storage.mode);
      assert.equal((await f.storage.preserve(admin,id)).mode,storage.mode);
    }
    await assert.rejects(f.storage.provision(admin,'x"; DROP SCHEMA public;--'));
    assert.equal((await f.db.query("SELECT * FROM pg_roles WHERE rolname LIKE 'app_%'")).rows.length,0);
  }finally{await f.db.close();}
});
test('unowned existing roles and schema marker/ACL escalation fail closed',async()=>{
  const f=await setup();try {
    const p=await managed(f.storage);
    await f.db.exec(`CREATE ROLE "${p.runtimeRole}" SUPERUSER`);
    await assert.rejects(f.storage.provision(admin,'tool-lending'),/STORAGE_OBJECT_CONFLICT/);
    assert.equal((await f.db.query('SELECT * FROM pg_namespace WHERE nspname=$1',[p.schema])).rows.length,0);
  }finally{await f.db.close();}
  const f2=await setup();try {
    const p=await f2.storage.provision(admin,'tool-lending') as ManagedAppStorage;
    await f2.db.exec(`ALTER ROLE "${p.runtimeRole}" CREATEROLE`);
    await assert.rejects(f2.storage.provision(admin,'tool-lending'),/STORAGE_ACL_DRIFT/);
    await f2.db.exec(`ALTER ROLE "${p.runtimeRole}" NOCREATEROLE; COMMENT ON SCHEMA "${p.schema}" IS 'fake'`);
    await assert.rejects(f2.storage.provision(admin,'tool-lending'),/STORAGE_BINDING_CONFLICT/);
  }finally{await f2.db.close();}
});
test('unsafe PUBLIC prerequisites reject without globally rewriting ACLs',async()=>{
  const f=await setup();try {
    await f.db.exec('CREATE TABLE public.exposed(id int); GRANT SELECT ON public.exposed TO PUBLIC');
    await assert.rejects(f.storage.provision(admin,'tool-lending'),/UNSAFE_PUBLIC_OBJECT_PRIVILEGES/);
    assert.equal((await f.db.query("SELECT * FROM pg_roles WHERE rolname LIKE 'app_%'")).rows.length,0);
    await f.db.exec('REVOKE SELECT ON public.exposed FROM PUBLIC; CREATE FUNCTION public.exposed_fn() RETURNS int LANGUAGE sql AS \'SELECT 1\'');
    await assert.rejects(f.storage.provision(admin,'tool-lending'),/UNSAFE_PUBLIC_FUNCTION_PRIVILEGES/);
  }finally{await f.db.close();}
});
test('failure after generated DDL rolls back roles/schema, retry succeeds',async()=>{
  const f=await setup();try {
    let fail=true;
    const client:QueryableClient={query:async(sql,values)=>{if(fail && sql.startsWith('COMMENT ON SCHEMA')) throw new Error('injected marker failure');return f.client.query(sql,values);}};
    const storage=new AppStorageService(f.registry,client),p=await managed(storage);
    await assert.rejects(storage.provision(admin,'tool-lending'),/injected marker failure/);
    assert.equal((await f.db.query('SELECT * FROM pg_namespace WHERE nspname=$1',[p.schema])).rows.length,0);
    assert.equal((await f.db.query('SELECT * FROM pg_roles WHERE rolname=$1',[p.ownerRole])).rows.length,0);
    fail=false;await storage.provision(admin,'tool-lending');
    fail=true;await assert.rejects(storage.preserve(admin,'tool-lending'),/injected marker failure/);
    fail=false;assert.deepEqual(await storage.provision(admin,'tool-lending'),p);
  }finally{await f.db.close();}
});
test('catalog drift checks cover database, foreign schema/function and missing defaults',async()=>{
  const f=await setup();try {
    const p=await f.storage.provision(admin,'tool-lending') as ManagedAppStorage;
    const dbname=(await f.db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
    const cases=[
      [`GRANT TEMPORARY ON DATABASE "${dbname}" TO "${p.runtimeRole}"`,`REVOKE TEMPORARY ON DATABASE "${dbname}" FROM "${p.runtimeRole}"`],
      [`GRANT CREATE ON SCHEMA public TO "${p.ownerRole}"`,`REVOKE CREATE ON SCHEMA public FROM "${p.ownerRole}"`],
      [`CREATE FUNCTION public.priv_fn() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; REVOKE EXECUTE ON FUNCTION public.priv_fn() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.priv_fn() TO "${p.runtimeRole}"`,`REVOKE EXECUTE ON FUNCTION public.priv_fn() FROM "${p.runtimeRole}"`],
      [`ALTER DEFAULT PRIVILEGES FOR ROLE "${p.ownerRole}" IN SCHEMA "${p.schema}" REVOKE INSERT ON TABLES FROM "${p.runtimeRole}"`,`ALTER DEFAULT PRIVILEGES FOR ROLE "${p.ownerRole}" IN SCHEMA "${p.schema}" GRANT INSERT ON TABLES TO "${p.runtimeRole}"`],
    ];
    for(const [corrupt,restore] of cases) {
      await f.db.exec(corrupt);await assert.rejects(f.storage.provision(admin,'tool-lending'),/STORAGE_ACL_DRIFT/);
      await f.db.exec(restore);await f.storage.provision(admin,'tool-lending');
    }
    await f.db.exec('CREATE SCHEMA pgx; CREATE TABLE pgx.leak(id int); GRANT SELECT ON pgx.leak TO PUBLIC');
    await assert.rejects(f.storage.provision(admin,'tool-lending'),/UNSAFE_PUBLIC_OBJECT_PRIVILEGES/);
    await assert.rejects(f.storage.preserve(admin,'tool-lending'),/UNSAFE_PUBLIC_OBJECT_PRIVILEGES/);
  }finally{await f.db.close();}
});
test('column and large-object grants cannot bypass schema/table isolation',async()=>{
  const f=await setup();try {
    const p=await f.storage.provision(admin,'tool-lending') as ManagedAppStorage;
    await f.db.exec(`CREATE TABLE public.column_secret(secret text); INSERT INTO public.column_secret VALUES('secret');
      SELECT lo_from_bytea(12345,convert_to('secret','UTF8'))`);
    const cases=[
      ['GRANT SELECT(secret) ON public.column_secret TO PUBLIC','REVOKE SELECT(secret) ON public.column_secret FROM PUBLIC',/UNSAFE_PUBLIC_COLUMN_PRIVILEGES/],
      [`GRANT SELECT(secret) ON public.column_secret TO "${p.runtimeRole}"`,`REVOKE SELECT(secret) ON public.column_secret FROM "${p.runtimeRole}"`,/STORAGE_ACL_DRIFT/],
      ['GRANT SELECT ON LARGE OBJECT 12345 TO PUBLIC','REVOKE SELECT ON LARGE OBJECT 12345 FROM PUBLIC',/UNSAFE_PUBLIC_LARGE_OBJECT_PRIVILEGES/],
      [`GRANT SELECT ON LARGE OBJECT 12345 TO "${p.runtimeRole}"`,`REVOKE SELECT ON LARGE OBJECT 12345 FROM "${p.runtimeRole}"`,/STORAGE_ACL_DRIFT/],
      [`ALTER LARGE OBJECT 12345 OWNER TO "${p.ownerRole}"`,'ALTER LARGE OBJECT 12345 OWNER TO CURRENT_USER',/STORAGE_ACL_DRIFT/],
    ] as const;
    for(const [corrupt,restore,error] of cases) {
      await f.db.exec(corrupt);
      await assert.rejects(f.storage.provision(admin,'tool-lending'),error);
      await assert.rejects(f.storage.preserve(admin,'tool-lending'),error);
      await f.db.exec(restore);await f.storage.provision(admin,'tool-lending');
    }
    await assert.rejects(asRole(f.db,p.runtimeRole,'SELECT secret FROM public.column_secret'));
    await assert.rejects(asRole(f.db,p.runtimeRole,'SELECT lo_get(12345)'));
  }finally{await f.db.close();}
});
test('binding digest is independent of manifest object key ordering',async()=>{
  const f=await setup();try {
    const original=await f.storage.provision(admin,'tool-lending');
    const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value && typeof value==='object'
      ?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
    const registry={get:async(context:Parameters<AppRegistryService['get']>[0],id:string)=>{
      const record=await f.registry.get(context,id);return {...record,manifest:reorder(record.manifest) as AppManifest};
    }};
    assert.deepEqual(await new AppStorageService(registry,f.client).provision(admin,'tool-lending'),original);
  }finally{await f.db.close();}
});
