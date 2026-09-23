import {Client,Pool} from 'pg';
import {AppRuntimeDataService} from '../storage/runtime-data.js';
import {PostgresAppRegistryRepository} from '../registry/index.js';
import type {QueryableClient} from '../../core/database/index.js';
import type {AppInstallation,AppRegistryService} from '../registry/index.js';
import type {AppManifest} from '../manifest/index.js';
import {AppStorageService} from '../storage/index.js';
import {AppStorageError,binding} from '../storage/binding.js';
import {ManagedAppOperations,type ManagedAppAdminClient} from '../storage/managed-operations.js';
import {ManagedAppStorageService} from '../storage/managed-storage.js';
import type {AppMigrationArtifactReader} from '../storage/migration-plan.js';
import type {AppMigrationCredentials} from '../storage/postgres-migration-driver.js';

/** Deliberately small URL contract: no ambient PG options, socket paths or TLS downgrade. */
export function parseStorageDatabaseUrl(value:string|undefined):AppMigrationCredentials {
 try {
  if(!value||value.length>8192)throw Error();
  const url=new URL(value);
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const user=decodeURIComponent(url.username),password=decodeURIComponent(url.password),database=decodeURIComponent(url.pathname.slice(1));
  const port=Number(url.port||5432);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash
   ||[...url.searchParams.keys()].some(key=>key!=='sslmode')||url.searchParams.getAll('sslmode').length>1
   ||![host,user,password,database].every(s=>s.length>0&&!/[\x00-\x1f\x7f]/.test(s))
   ||host.includes('/')||database.includes('/')||!Number.isInteger(port)||port<1||port>65535)throw Error();
  const mode=url.searchParams.get('sslmode');
  const loopback=['127.0.0.1','::1'].includes(host);
  if(mode!=='verify-full'&&!(loopback&&(mode===null||mode==='disable')))throw Error();
  return {host,port,database,user,password,ssl:mode==='verify-full'?{rejectUnauthorized:true}:false};
 }catch{throw new AppStorageError('STORAGE_DATABASE_CONFIG_INVALID');}
}

export function createStorageArtifactReader(options:{
 getInstallation(appId:string):Promise<AppInstallation|null>;
 readArtifact(manifest:AppManifest,artifactId:string,maxBytes:number):Promise<Uint8Array>;
}):AppMigrationArtifactReader {
 return {async read(request){
  const record=await options.getInstallation(request.appId);
  if(!record||record.id!==request.installationId||record.revision!==request.revision)throw new AppStorageError('STORAGE_ARTIFACT_BINDING_MISMATCH');
  const plan=binding(record),artifact=record.manifest.artifacts.find(item=>item.id===request.artifactId);
  if(plan.mode!=='managed'||plan.manifestDigest!==request.manifestDigest||!artifact||artifact.kind!=='migration'
   ||artifact.path!==request.path||artifact.sha256!==request.sha256||artifact.bytes!==request.bytes||request.maxBytes!==artifact.bytes)
   throw new AppStorageError('STORAGE_ARTIFACT_BINDING_MISMATCH');
  return options.readArtifact(record.manifest,artifact.id,request.maxBytes);
 }};
}

const tables=['platform_app_runtime_write_receipts','platform_app_runtime_write_reconciliations','platform_app_migration_attempts','platform_app_storage_leases','platform_app_migration_receipts',
 'platform_app_runtime_storage_leases','platform_app_runtime_storage_writes','platform_app_migration_reconciliations','platform_app_storage_restores','platform_app_storage_versions','platform_app_storage_migration_adoptions'];

/** Pinned, distinct management identity. Storage executor requires either superuser role administration
 * or a dedicated least-privilege DDL administrator role (CREATEROLE + database CREATE, rolsuper=false).
 * It is explicitly opt-in and never changes the ordinary API role or database ACLs. */
export async function createManagedStorageComposition(options:{
 apiDatabaseUrl:string;
 adminDatabaseUrl:string|undefined;
 apiClient:QueryableClient;
 registry(client:QueryableClient):Pick<AppRegistryService,'get'>;
 reader:AppMigrationArtifactReader;
},createClient:(config:AppMigrationCredentials)=>ManagedAppAdminClient&{connect():Promise<unknown>}=
 credentials=>new Client({...credentials,connectionTimeoutMillis:5000,statement_timeout:30_000,lock_timeout:5000,
  idle_in_transaction_session_timeout:30_000,options:'-c search_path=pg_catalog,public',application_name:'mop-storage-management',
  client_encoding:'UTF8',...{replication:'false'}})) {
 const api=parseStorageDatabaseUrl(options.apiDatabaseUrl),admin=parseStorageDatabaseUrl(options.adminDatabaseUrl);
 if(api.user===admin.user)throw new AppStorageError('STORAGE_SEPARATE_IDENTITY_REQUIRED');
 if(api.host!==admin.host||api.port!==admin.port||api.database!==admin.database||JSON.stringify(api.ssl)!==JSON.stringify(admin.ssl))
  throw new AppStorageError('STORAGE_DATABASE_MISMATCH');
 const assertAdminIdentity=async(client:QueryableClient)=>{
  const identity=await client.query(`SELECT session_user AS session_user,current_user AS current_user,current_database() AS database,
    r.rolsuper,r.rolcreaterole,has_database_privilege(current_user,current_database(),'CREATE') AS has_database_create
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`) as {rows:Record<string,unknown>[]};
  const row=identity.rows[0];
  const isSuper=row?.rolsuper===true;
  const isLeastPrivilegeAdmin=row?.rolsuper===false&&row?.rolcreaterole===true&&row?.has_database_create===true;
  if(identity.rows.length!==1||row?.session_user!==admin.user||row?.current_user!==admin.user||row?.database!==admin.database||(!isSuper&&!isLeastPrivilegeAdmin))
   throw new AppStorageError('STORAGE_ADMIN_IDENTITY_REQUIRED');
 };
 const connectAdmin=async()=>{
  const client=createClient(admin);
  client.on?.('error',()=>undefined);
  try{
   await client.connect();
   // Recheck identity on every fresh session, including recovery after configuration/role changes.
   await assertAdminIdentity(client);
   return client;
  }catch(error){
   try{await client.end();}catch{throw new AppStorageError('STORAGE_SESSION_CLOSE_FAILED');}
   throw error instanceof AppStorageError?error:new AppStorageError('STORAGE_ADMIN_CONNECTION_FAILED');
  }
 };
 let client:ManagedAppAdminClient|undefined;
 try{
  client=await connectAdmin();
  const apiIdentity=await options.apiClient.query(`SELECT session_user AS session_user,current_user AS current_user,current_database() AS database,
   r.rolsuper,r.rolcreaterole,pg_catalog.pg_has_role(current_user,$1,'MEMBER') AS admin_member
   FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,[admin.user]) as {rows:Record<string,unknown>[]};
  const row=apiIdentity.rows[0];
  if(apiIdentity.rows.length!==1||row.session_user!==api.user||row.current_user!==api.user||row.database!==api.database
   ||row.rolsuper!==false||row.rolcreaterole!==false||row.admin_member!==false)throw new AppStorageError('STORAGE_SEPARATE_IDENTITY_REQUIRED');
  const required=await client.query('SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(\'public.\'||name) IS NULL',[tables]) as {rows:unknown[]};
  if(required.rows.length)throw new AppStorageError('STORAGE_MIGRATIONS_REQUIRED');
  await new AppStorageService(options.registry(client),client).assertEnvironmentReady();
 }catch(error){throw error instanceof AppStorageError?error:new AppStorageError('STORAGE_PREFLIGHT_FAILED');}
 finally{if(client)try{await client.end();}catch{throw new AppStorageError('STORAGE_SESSION_CLOSE_FAILED');}}
 const {host,port,database,ssl}=admin;
 const endpoint={host,port,database,ssl};
 const runtimeAdminPool=new Pool({...admin,max:8,idleTimeoutMillis:15_000,connectionTimeoutMillis:5000,statement_timeout:30_000,lock_timeout:5000,
  idle_in_transaction_session_timeout:30_000,options:'-c search_path=pg_catalog,public',application_name:'mop-storage-runtime-admin',...{replication:'false'}});
 runtimeAdminPool.on('error',()=>undefined);
 const connectRuntimeAdmin=async():Promise<ManagedAppAdminClient>=>{
  const client=await runtimeAdminPool.connect();let released=false,failed=false;
  const onError=()=>{failed=true;};client.on('error',onError);
  try{
   await assertAdminIdentity(client);
   return {
    query:(sql,args)=>client.query(sql,args?[...args]:undefined),
    end:async()=>{
     if(released)return;
     released=true;
     try{
      if(failed)throw new AppStorageError('STORAGE_ADMIN_CONNECTION_FAILED');
      await client.query('SELECT pg_advisory_unlock_all()');
      client.removeListener('error',onError);client.release();
     }catch(error){client.removeListener('error',onError);client.release(error as Error);throw error;}
    },
   };
  }catch(error){client.removeListener('error',onError);client.release(error as Error);throw error;}
 };
 return Object.assign(new ManagedAppStorageService(new ManagedAppOperations({connectAdmin,registry:options.registry,endpoint}),options.reader),{closeRuntimeConnections:()=>runtimeAdminPool.end(),runtimeData:new AppRuntimeDataService({connectAdmin:connectRuntimeAdmin,endpoint,findInstallation:(client,appId)=>new PostgresAppRegistryRepository(client).findByAppId(appId),
  ...(process.env.MOP_APP_STORAGE_TIMING==='1'?{observeTiming:(timing:{appId:string;mode:string;totalMs:number;adminConnectMs:number;runtimeConnectMs:number;sqlCount:number;sqlMs:number})=>{
   console.info(JSON.stringify({event:'app_storage_timing',...timing}));
  }}:{})})});
}
