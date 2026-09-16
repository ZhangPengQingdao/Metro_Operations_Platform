import {randomUUID} from 'node:crypto';
import {runDatabaseTransaction,type QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {managementActorId,type PlatformManagementContext} from '../../platform/context/index.js';
import {AppStorageError,manage,type ManagedAppStorage} from './binding.js';
const rows=async<T>(client:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await client.query(sql,args)) as {rows:T[]}).rows;
export const runtimeWriteEvidenceMigration:MigrationDefinition={id:'app-runtime-write-evidence-expand',title:'Runtime write original transaction evidence',ownerTaskId:'PLATFORM-L4-016',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-060'],sourceTables:[],targetTables:['platform_app_runtime_write_receipts','platform_app_runtime_write_reconciliations'],dependsOn:['app-runtime-storage-expand'],recoveryNotes:'Existing unknown writes without receipts remain blocked. Never infer rollback from absent receipts, elapsed time or current application rows.',async run({client}){await client.query(`
 CREATE TABLE IF NOT EXISTS platform_app_runtime_write_receipts(
 installation_id uuid NOT NULL,request_id uuid NOT NULL,transaction_id text NOT NULL CHECK(transaction_id ~ '^[0-9]{1,20}$'),
 system_identifier text NOT NULL,database_oid text NOT NULL,database_name text NOT NULL,manifest_digest text NOT NULL,request_digest text NOT NULL,
 PRIMARY KEY(installation_id,request_id),FOREIGN KEY(installation_id,request_id) REFERENCES platform_app_runtime_storage_writes(installation_id,request_id));
 CREATE TABLE IF NOT EXISTS platform_app_runtime_write_reconciliations(
 id uuid PRIMARY KEY,installation_id uuid NOT NULL,request_id uuid NOT NULL,transaction_id text NOT NULL,
 previous_status text NOT NULL CHECK(previous_status='dispatched'),new_status text NOT NULL CHECK(new_status IN ('completed','rolled_back')),
 evidence text NOT NULL CHECK(evidence IN ('committed','aborted')),actor_id text NOT NULL,reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(installation_id,request_id) REFERENCES platform_app_runtime_storage_writes(installation_id,request_id));
`);}};
/** Called after BEGIN and before DML. An acknowledged receipt is required to dispatch a write. */
export async function recordRuntimeTransaction(admin:QueryableClient,runtime:QueryableClient,installationId:string,requestId:string){
 const [origin]=await rows<{system:string;oid:string;database:string}>(admin,"SELECT system_identifier::text AS system,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_database() AS database FROM pg_control_system()");
 const [transaction]=await rows<{xid:string;oid:string;database:string}>(runtime,"SELECT pg_current_xact_id()::text AS xid,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_database() AS database");
 if(!origin||!transaction||origin.oid!==transaction.oid||origin.database!==transaction.database||!/^\d{1,20}$/.test(transaction.xid))throw new AppStorageError('STORAGE_RECEIPT_CONFLICT');
 const inserted=await rows(admin,`INSERT INTO public.platform_app_runtime_write_receipts(installation_id,request_id,transaction_id,system_identifier,database_oid,database_name,manifest_digest,request_digest)
 SELECT installation_id,request_id,$3,$4,$5,$6,manifest_digest,request_digest FROM public.platform_app_runtime_storage_writes
 WHERE installation_id=$1 AND request_id=$2 AND status='dispatched' RETURNING request_id`,[installationId,requestId,transaction.xid,origin.system,origin.oid,origin.database]);
 if(inserted.length!==1)throw new AppStorageError('STORAGE_RECEIPT_CONFLICT');
}
/** Caller holds the installation storage lock and has disabled the application and cleaned its leases. */
export async function reconcileRuntimeWrite(client:QueryableClient,context:PlatformManagementContext,plan:ManagedAppStorage,requestId:string){
 await manage(context);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw new AppStorageError('INVALID_REQUEST_ID');
 return runDatabaseTransaction(client,async()=>{
  const [write]=await rows<{status:string;manifest_digest:string;request_digest:string}>(client,'SELECT status,manifest_digest,request_digest FROM public.platform_app_runtime_storage_writes WHERE installation_id=$1 AND request_id=$2 FOR UPDATE',[plan.installationId,requestId]);
  if(!write)throw new AppStorageError('STORAGE_WRITE_NOT_FOUND');
  if(write.status!=='dispatched')return {requestId,status:write.status};
  const [quiet]=await rows<{quiet:boolean}>(client,`SELECT
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1 AND NOT rolcanlogin)
   AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1)
   AND NOT EXISTS(SELECT 1 FROM public.platform_app_runtime_storage_leases WHERE installation_id=$2 AND status='active') AS quiet`,[plan.runtimeRole,plan.installationId]);
  if(!quiet?.quiet)throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');
  const [receipt]=await rows<{transaction_id:string;system_identifier:string;database_oid:string;database_name:string;manifest_digest:string;request_digest:string}>(client,'SELECT * FROM public.platform_app_runtime_write_receipts WHERE installation_id=$1 AND request_id=$2',[plan.installationId,requestId]);
  if(!receipt)throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');
  const [origin]=await rows<{system:string;oid:string;database:string}>(client,"SELECT system_identifier::text AS system,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_database() AS database FROM pg_control_system()");
  if(!origin||receipt.system_identifier!==origin.system||receipt.database_oid!==origin.oid||receipt.database_name!==origin.database||receipt.manifest_digest!==write.manifest_digest||receipt.request_digest!==write.request_digest)throw new AppStorageError('STORAGE_RECEIPT_CONFLICT');
  let evidence:string|null;
  try{evidence=(await rows<{status:string|null}>(client,'SELECT pg_xact_status($1::xid8) AS status',[receipt.transaction_id]))[0]?.status??null;}catch{throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');}
  if(evidence!=='committed'&&evidence!=='aborted')throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');
  await manage(context);
  const status=evidence==='committed'?'completed':'rolled_back';
  await client.query(`INSERT INTO public.platform_app_runtime_write_reconciliations(id,installation_id,request_id,transaction_id,previous_status,new_status,evidence,actor_id) VALUES($1,$2,$3,$4,'dispatched',$5,$6,$7)`,[randomUUID(),plan.installationId,requestId,receipt.transaction_id,status,evidence,managementActorId(context)]);
  await client.query("UPDATE public.platform_app_runtime_storage_writes SET status=$3,completed_at=clock_timestamp() WHERE installation_id=$1 AND request_id=$2 AND status='dispatched'",[plan.installationId,requestId,status]);
  return {requestId,status};
 });
}
