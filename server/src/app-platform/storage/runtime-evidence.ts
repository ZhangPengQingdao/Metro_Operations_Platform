import type {QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {AppStorageError,type ManagedAppStorage} from './binding.js';
export const APP_STORAGE_RUNTIME_SQL=`
CREATE TABLE IF NOT EXISTS platform_app_runtime_storage_leases (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES platform_app_installations(id),
 runtime_role text NOT NULL, status text NOT NULL CHECK(status IN ('active','released')),
 expires_at timestamptz NOT NULL, released_at timestamptz,
 CHECK(runtime_role='app_'||replace(installation_id::text,'-','')||'_runtime'),
 CHECK((status='active' AND released_at IS NULL) OR (status='released' AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_runtime_storage_one_lease ON platform_app_runtime_storage_leases(installation_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS platform_app_runtime_storage_writes (
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id), request_id uuid NOT NULL,
 manifest_digest text NOT NULL, request_digest text NOT NULL,
 status text NOT NULL CHECK(status IN ('dispatched','completed','rolled_back')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 PRIMARY KEY(installation_id,request_id),
 CHECK((status='dispatched' AND completed_at IS NULL) OR (status<>'dispatched' AND completed_at IS NOT NULL))
);
INSERT INTO platform_permissions(id,code,name,status,created_at,updated_at) VALUES
 ('49000000-0000-4000-8000-000000000003','platform.app_data.read','读取应用自身数据','active',now(),now()),
 ('49000000-0000-4000-8000-000000000004','platform.app_data.write','写入应用自身数据','active',now(),now()) ON CONFLICT(code) DO NOTHING;`;
export const appRuntimeStorageMigration:MigrationDefinition={id:'app-runtime-storage-expand',title:'Application runtime storage leases and write evidence',ownerTaskId:'PLATFORM-L4-015',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-058'],sourceTables:[],targetTables:['platform_app_runtime_storage_leases','platform_app_runtime_storage_writes'],dependsOn:['app-registry-expand','platform-authorization-expand'],recoveryNotes:'Unconfirmed writes block further use; never clear or replay them based on lease expiry. Lease cleanup is not write outcome evidence.',async run({client}){await client.query(APP_STORAGE_RUNTIME_SQL);}};
export async function assertRuntimeWritesSettled(client:QueryableClient,id:string){
 const result=await client.query("SELECT request_id FROM public.platform_app_runtime_storage_writes WHERE installation_id=$1 AND status='dispatched' LIMIT 1",[id]) as {rows:unknown[]};
 if(result.rows.length)throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');
}
/** Caller must hold the same installation session lock as migration/lifecycle operations. */
export async function recoverRuntimeStorageLease(client:QueryableClient,plan:Readonly<ManagedAppStorage>){
 const result=await client.query("SELECT id,runtime_role FROM public.platform_app_runtime_storage_leases WHERE installation_id=$1 AND status='active'",[plan.installationId]) as {rows:{id:string;runtime_role:string}[]};
 if(!result.rows.length)return;
 if(result.rows.length!==1||result.rows[0].runtime_role!==plan.runtimeRole)throw new AppStorageError('STORAGE_LEASE_BINDING_CONFLICT');
 try{
  await client.query(`ALTER ROLE "${plan.runtimeRole}" NOLOGIN PASSWORD NULL`);
  const stopped=await client.query('SELECT pg_catalog.pg_terminate_backend(pid,5000) AS stopped FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND pid<>pg_catalog.pg_backend_pid()',[plan.runtimeRole]) as {rows:{stopped:boolean}[]};
  if(stopped.rows.some(r=>!r.stopped))throw Error();
  const remaining=await client.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1',[plan.runtimeRole]) as {rows:unknown[]};
  const role=await client.query('SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE rolname=$1',[plan.runtimeRole]) as {rows:{rolcanlogin:boolean;rolpassword:string|null}[]};
  if(remaining.rows.length||role.rows.length!==1||role.rows[0].rolcanlogin||role.rows[0].rolpassword!==null)throw Error();
  await client.query("UPDATE public.platform_app_runtime_storage_leases SET status='released',released_at=clock_timestamp() WHERE id=$1 AND status='active'",[result.rows[0].id]);
 }catch{throw new AppStorageError('STORAGE_LEASE_CLEANUP_REQUIRED');}
}
