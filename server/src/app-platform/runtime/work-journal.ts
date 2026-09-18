import { randomUUID } from 'node:crypto';
import type { QueryableClient } from '../../core/database/index.js';
import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_RUNTIME_WORK_SQL = `CREATE TABLE IF NOT EXISTS public.platform_app_runtime_work (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES public.platform_app_installations(id),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz, context jsonb
);
CREATE INDEX IF NOT EXISTS platform_app_runtime_work_pending ON public.platform_app_runtime_work(installation_id) WHERE settled_at IS NULL;`;
export const APP_RUNTIME_WORK_CONTEXT_SQL = 'ALTER TABLE public.platform_app_runtime_work ADD COLUMN IF NOT EXISTS context jsonb';
export interface RuntimeWorkContext { kind:'api'|'gateway'|'extension'; requestId?:string; apiId?:string }
export const APP_RUNTIME_WORK_MIGRATIONS:readonly MigrationDefinition[]=[{
 id:'app-runtime-work-expand',title:'Retain actual Gateway work across host ownership loss',ownerTaskId:'PLATFORM-L4-008',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-050'],sourceTables:[],targetTables:['platform_app_runtime_work'],dependsOn:['app-registry-expand'],
 recoveryNotes:'Unsettled work never expires. Only original actual work and terminal audit completion settle its exact record; no bulk clear or replay.',
 async run({client}){await client.query(APP_RUNTIME_WORK_SQL);return {applied:true};},
},{
 id:'app-runtime-work-context-expand',title:'Correlate runtime work without recording payloads',ownerTaskId:'PLATFORM-L4-008',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-071'],sourceTables:[],targetTables:['platform_app_runtime_work'],dependsOn:['app-runtime-work-expand'],
 recoveryNotes:'Legacy work stays unresolved. Context never proves completion.',
 async run({client}){await client.query(APP_RUNTIME_WORK_CONTEXT_SQL);return {applied:true};},
}];
export class AppRuntimeWorkError extends Error {
 constructor(readonly code:'RUNTIME_WORK_PENDING'|'RUNTIME_WORK_UNCERTAIN'|'INVALID_INSTALLATION'){super(code);this.name='AppRuntimeWorkError';}
}
/** Platform-only dedicated short sessions; never use a connection currently inside a transaction.
 * No params, results or credentials are stored. A lost insert acknowledgement forbids execution.
 * A lost settle acknowledgement leaves recovery blocked; there is no timeout-based clearing API. */
export class AppRuntimeWorkJournal {
 constructor(private readonly connect:()=>Promise<QueryableClient & {end():Promise<void>}>) {}
 private async query(sql:string,values:readonly unknown[]) {
  let client:Awaited<ReturnType<AppRuntimeWorkJournal['connect']>>|undefined;
  try{client=await this.connect();return await client.query(sql,values) as {rows:unknown[]};}
  catch{throw new AppRuntimeWorkError('RUNTIME_WORK_UNCERTAIN');}
  finally{if(client)try{await client.end();}catch{throw new AppRuntimeWorkError('RUNTIME_WORK_UNCERTAIN');}}
 }
 private validate(id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new AppRuntimeWorkError('INVALID_INSTALLATION');}
 async pending(installationId:string){
  this.validate(installationId);
  const result=await this.query('SELECT id,started_at AS "startedAt",context FROM public.platform_app_runtime_work WHERE installation_id=$1 AND settled_at IS NULL ORDER BY started_at,id LIMIT 101',[installationId]);
  return {records:result.rows.slice(0,100),hasMore:result.rows.length>100};
 }
 async assertDrained(installationId:string){
  this.validate(installationId);
  const result=await this.query('SELECT id FROM public.platform_app_runtime_work WHERE installation_id=$1 AND settled_at IS NULL LIMIT 1',[installationId]);
  if(result.rows.length)throw new AppRuntimeWorkError('RUNTIME_WORK_PENDING');
 }
 async track<T>(installationId:string,assertOwner:()=>Promise<void>,invoke:()=>Promise<T>,drain:()=>Promise<void>,context?:RuntimeWorkContext):Promise<T>{
  this.validate(installationId);const id=randomUUID();
  const safeContext=context?{kind:context.kind,...(context.requestId?{requestId:context.requestId.slice(0,256)}:{}),...(context.apiId?{apiId:context.apiId.slice(0,100)}:{})}:null;
  await this.query('INSERT INTO public.platform_app_runtime_work(id,installation_id,context) VALUES($1,$2,$3)',[id,installationId,safeContext]);
  // Recheck AFTER durable admission. A successor either sees this blocker or no old work can start.
  try{await assertOwner();return await invoke();}
  finally{
   await drain();
   await this.query('UPDATE public.platform_app_runtime_work SET settled_at=clock_timestamp() WHERE id=$1 AND installation_id=$2 AND settled_at IS NULL',[id,installationId]);
  }
 }
}
