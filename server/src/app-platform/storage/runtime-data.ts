import {recordRuntimeTransaction} from './runtime-reconciliation.js';
import {runtimeListInput,runtimeListQuery} from './runtime-list.js';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Client} from 'pg';
import {z} from 'zod';
import type {PlatformActorContext} from '../../platform/context/index.js';
import type {QueryableClient} from '../../core/database/index.js';
import type {AppInstallation} from '../registry/index.js';
import {AppStorageService} from './index.js';
import {AppStorageError,binding,type ManagedAppStorage} from './binding.js';
import {scram,type ManagedAppAdminClient} from './managed-operations.js';
import type {AppMigrationCredentials} from './postgres-migration-driver.js';
import {assertStorageMigrationsReady} from './lifecycle-evidence.js';
import {assertRuntimeWritesSettled,recoverRuntimeStorageLease} from './runtime-evidence.js';
import {GatewayError,jsonSnapshot,type AppGatewayOperation,type GatewayJson} from '../gateway/model.js';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).refine(v=>!v.startsWith('pg_')&&!v.startsWith('platform_'));
const base={table:identifier,id:z.string().uuid()};
const readInput=z.object(base).strict();
const writeInput=z.object({...base,requestId:z.string().uuid(),action:z.enum(['insert','update','delete']),values:z.record(identifier,z.unknown()).optional()}).strict().refine(v=>v.action==='delete'?v.values===undefined:!!v.values&&Object.keys(v.values).length>0&&Object.keys(v.values).length<=63&&!('id'in v.values));
const transactionItem=z.object({...base,action:z.enum(['insert','update','delete']),values:z.record(identifier,z.unknown()).optional(),expected:z.record(identifier,z.unknown()).optional()}).strict().refine(v=>
 (v.action==='delete'?v.values===undefined:!!v.values&&Object.keys(v.values).length>0&&Object.keys(v.values).length<=63&&!('id' in v.values))&&
 (v.action==='insert'?v.expected===undefined:!!v.expected&&Object.keys(v.expected).length>0&&Object.keys(v.expected).length<=63&&!('id' in v.expected)));
const transactionInput=z.object({requestId:z.string().uuid(),operations:z.array(transactionItem).min(1).max(16)}).strict();
const rows=async<T>(db:QueryableClient,sql:string,args?:readonly unknown[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
const q=(v:string)=>`"${v}"`; // Only validated binding and identifier values.
export interface RuntimeStorageOptions{
 connectAdmin():Promise<ManagedAppAdminClient>;
 endpoint:Omit<AppMigrationCredentials,'user'|'password'>;
 findInstallation(client:QueryableClient,appId:string):Promise<AppInstallation|null>;
 connectRuntime?(credentials:AppMigrationCredentials):Promise<ManagedAppAdminClient>;
}
/** Service-only, bounded row operations. No SQL, role, schema or employee identity supplied by applications. */
export class AppRuntimeDataService{
 constructor(private readonly options:RuntimeStorageOptions){}
 operations():AppGatewayOperation[]{return [false,true].map<AppGatewayOperation>(write=>({
  name:write?'platform.app_data.write':'platform.app_data.get',permissionCode:write?'platform.app_data.write':'platform.app_data.read',mode:write?'write':'read',
  validateParams:v=>(write?writeInput:readInput).safeParse(v).success&&Buffer.byteLength(JSON.stringify(v))<=16384,
  resolveResources:async c=>{this.requireService(c);return [{}];},
  execute:(c,v,signal)=>this.execute(c,v,write,signal),validateResult:()=>true,
 })).concat([{
  name:'platform.app_data.list',permissionCode:'platform.app_data.read',mode:'read' as const,
  validateParams:v=>runtimeListInput.safeParse(v).success&&Buffer.byteLength(JSON.stringify(v))<=16384,
  resolveResources:async c=>{this.requireService(c);return [{}];},
  execute:(c,v,signal)=>this.execute(c,v,'list',signal),validateResult:()=>true,
 },{
  name:'platform.app_data.transaction',permissionCode:'platform.app_data.write',mode:'write',
  validateParams:v=>transactionInput.safeParse(v).success&&Buffer.byteLength(JSON.stringify(v))<=16384,
  resolveResources:async c=>{this.requireService(c);return [{}];},
  execute:(c,v,signal)=>this.execute(c,v,'transaction',signal),validateResult:()=>true,
 }]);}
 private requireService(context:PlatformActorContext):asserts context is Extract<PlatformActorContext,{actorType:'service'}>{
  if(context.actorType!=='service'||context.execution.type!=='service')throw new GatewayError('ACCESS_DENIED',403);
 }
 async execute(context:PlatformActorContext,input:unknown,mode:boolean|'list'|'transaction',signal:AbortSignal):Promise<GatewayJson>{
  this.requireService(context);
  const write=mode===true||mode==='transaction',batch=mode==='transaction'?transactionInput.parse(input):undefined,listing=mode==='list'?runtimeListInput.parse(input):undefined;
  const mutation=mode===true?writeInput.parse(input):undefined;
  const parsed=batch??mutation??listing??readInput.parse(input);
  if(Buffer.byteLength(JSON.stringify(parsed))>16384)throw new GatewayError('INVALID_PARAMS');
  const permission=write?'platform.app_data.write':'platform.app_data.read';
  const appId=context.execution.appId!;
  let admin:ManagedAppAdminClient|undefined,runtime:ManagedAppAdminClient|undefined,plan:ManagedAppStorage|undefined;
  let transaction=false,commitSent=false,intent=false,lease=false;
  const requestId=batch?.requestId??mutation?.requestId;
  const check=()=>{if(signal.aborted)throw new GatewayError('ABORTED',499);};
  const authorize=async()=>{check();if(!(await context.authorize(permission,{})).allowed)throw new GatewayError('ACCESS_DENIED',403);check();};
  try{
   await authorize();admin=await this.options.connectAdmin();admin.on?.('error',()=>undefined);
   await admin.query('SET search_path=pg_catalog,public');
   const initial=await this.options.findInstallation(admin,appId);if(!initial||!initial.enabled)throw new GatewayError('ACCESS_DENIED',403);
   const b=binding(initial);if(b.mode!=='managed')throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');plan=b;
   const held=await rows<{locked:boolean}>(admin,'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[`app-storage:${plan.installationId}`]);
   if(held[0]?.locked!==true)throw new AppStorageError('STORAGE_BUSY');
   const revalidate=async()=>{await authorize();const current=await this.options.findInstallation(admin!,appId);
    if(!current||!current.enabled||current.revision!==initial.revision||!isDeepStrictEqual(binding(current),plan))throw new GatewayError('ACCESS_DENIED',403);};
   await revalidate();
   await recoverRuntimeStorageLease(admin,plan);
   const inspector=new AppStorageService({get:async()=>{throw Error('NO_MANAGEMENT_CONTEXT');}},{query:(sql,args)=>admin!.query(sql,args)});
   await assertRuntimeWritesSettled(admin,plan.installationId);
   await inspector.assertBoundRuntimeReady(plan);
   await assertStorageMigrationsReady(admin,initial,plan.manifestDigest);
   // Fail closed on abandoned migration owners, rather than borrow or repair their credentials.
   if((await rows(admin,"SELECT id FROM public.platform_app_storage_leases WHERE installation_id=$1 AND status='active'",[plan.installationId])).length)throw new AppStorageError('STORAGE_LEASE_CLEANUP_REQUIRED');
   const tables=batch?batch.operations.map(item=>item.table):[(parsed as {table:string}).table];
   const columnSets=new Map<string,Map<string,string>>();
   for(const table of new Set(tables))columnSets.set(table,await this.columns(admin,plan,table));
   const columns=columnSets.get(tables[0])!;
   const listQuery=listing?runtimeListQuery(listing,columns):undefined;
   for(const item of batch?.operations??(mutation?[mutation]:[])){
    for(const [name,value]of [...Object.entries(item.values??{}),...Object.entries('expected' in item?item.expected??{}:{})]){
     const type=columnSets.get(item.table)!.get(name);if(!type||name==='id'||!validValue(type,value))throw new GatewayError('INVALID_PARAMS');
    }
   }
   if(requestId){
    if((await rows(admin,'SELECT request_id FROM public.platform_app_runtime_storage_writes WHERE installation_id=$1 AND request_id=$2',[plan.installationId,requestId])).length)throw new AppStorageError('STORAGE_REQUEST_ALREADY_RECORDED');
    await admin.query("INSERT INTO public.platform_app_runtime_storage_writes(installation_id,request_id,manifest_digest,request_digest,status) VALUES($1,$2,$3,$4,'dispatched')",[plan.installationId,requestId,plan.manifestDigest,createHash('sha256').update(JSON.stringify(parsed)).digest('hex')]);intent=true;
   }
   const leaseId=randomUUID(),password=randomBytes(32).toString('base64url');
   // Set before dispatch: ambiguous acknowledgement still requires cleanup, never permits execution.
   lease=true;
   await admin.query("INSERT INTO public.platform_app_runtime_storage_leases(id,installation_id,runtime_role,status,expires_at) VALUES($1,$2,$3,'active',clock_timestamp()+interval '30 seconds')",[leaseId,plan.installationId,plan.runtimeRole]);
   const [{expiry}]=await rows<{expiry:string}>(admin,"SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00' AS expiry FROM public.platform_app_runtime_storage_leases WHERE id=$1",[leaseId]);
   if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/.test(expiry))throw new AppStorageError('INVALID_LEASE_EXPIRY');
   await admin.query(`ALTER ROLE ${q(plan.runtimeRole)} LOGIN PASSWORD '${scram(password)}' VALID UNTIL '${expiry}'`);
   await revalidate();
   const credentials={...this.options.endpoint,user:plan.runtimeRole,password};
   runtime=await (this.options.connectRuntime??connectRuntime)(credentials);runtime.on?.('error',()=>undefined);
   const identity=await rows<{session_user:string;current_user:string;database:string;rolsuper:boolean}>(runtime,'SELECT session_user,current_user,current_database() AS database,rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user');
   if(identity.length!==1||identity[0].session_user!==plan.runtimeRole||identity[0].current_user!==plan.runtimeRole||identity[0].database!==this.options.endpoint.database||identity[0].rolsuper)throw new AppStorageError('STORAGE_IDENTITY_MISMATCH');
   await runtime.query(write?'BEGIN':'BEGIN READ ONLY');transaction=true;
   if(requestId)await recordRuntimeTransaction(admin,runtime,plan.installationId,requestId);
   check();
   let resultBytes=0;
   const statement=async(item:z.infer<typeof transactionItem>|z.infer<typeof readInput>,isMutation:boolean,requireRow:boolean)=>{
    check();const table=`${q(plan!.schema)}.${q(item.table)}`,itemColumns=columnSets.get(item.table)!;
    let sql=`SELECT t.* FROM ${table} t WHERE id=$1`,values:unknown[]=[item.id];
    if(listQuery){sql=`SELECT t.* FROM ${table} t${listQuery.suffix}`;values=listQuery.values;}
    if(isMutation&&'action' in item){
     const entries=Object.entries(item.values??{}),names=entries.map(([key])=>key);
     const encode=(key:string,value:unknown)=>itemColumns.get(key)==='jsonb'&&value!==null?JSON.stringify(value):value;
     values=[item.id,...entries.map(([key,value])=>encode(key,value))];
     let where='id=$1';
     for(const [key,value]of Object.entries('expected' in item?item.expected??{}:{})){
      values.push(encode(key,value));where+=` AND ${q(key)} IS NOT DISTINCT FROM $${values.length}::${itemColumns.get(key)}`;
     }
     if(item.action==='insert')sql=`INSERT INTO ${table} (${['id',...names].map(q).join(',')}) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`;
     if(item.action==='update')sql=`UPDATE ${table} SET ${names.map((name,i)=>`${q(name)}=$${i+2}`).join(',')} WHERE ${where} RETURNING *`;
     if(item.action==='delete')sql=`DELETE FROM ${table} WHERE ${where} RETURNING *`;
    }
    // Bounds apply to the whole response, including transaction operations and list lookahead.
    const result=await rows<{text:string;bytes:number}>(runtime!,`WITH r AS (${sql}) SELECT left(row_to_json(r)::text,32769) AS text,octet_length(row_to_json(r)::text) AS bytes FROM r`,values);
    resultBytes+=result.reduce((sum,r)=>sum+r.bytes,0);
    if(result.length>(listing?listing.pageSize+1:1)||result.some(r=>r.bytes>32768)||resultBytes>60000)throw new AppStorageError('STORAGE_RESULT_LIMIT');
    if(requireRow&&result.length!==1)throw new GatewayError('STORAGE_CONFLICT',409);
    return result.map(r=>JSON.parse(r.text));
   };
   let output:GatewayJson;
   if(batch){
    const results=[];
    for(const item of batch.operations){await revalidate();results.push({row:(await statement(item,true,true))[0]});}
    output=jsonSnapshot({results},65536);
   }else{
    const result=await statement(parsed as z.infer<typeof readInput>,!!mutation,false);
    const page=listing?result.slice(0,listing.pageSize):undefined;
    output=jsonSnapshot(listing?{rows:page,nextCursor:result.length>listing.pageSize?(listing.order?{id:page![page!.length-1].id,value:String(page![page!.length-1][listing.order.column])}:page![page!.length-1].id):null}:{row:result[0]??null},65536);
   }
   await revalidate();check();commitSent=true;await runtime.query('COMMIT');transaction=false;
   if(intent)await admin.query("UPDATE public.platform_app_runtime_storage_writes SET status='completed',completed_at=clock_timestamp() WHERE installation_id=$1 AND request_id=$2 AND status='dispatched'",[plan.installationId,requestId]);
   return output;
  }catch(error){
   if(transaction&&!commitSent&&runtime){
    try{await runtime.query('ROLLBACK');transaction=false;
     if(intent&&admin&&plan)await admin.query("UPDATE public.platform_app_runtime_storage_writes SET status='rolled_back',completed_at=clock_timestamp() WHERE installation_id=$1 AND request_id=$2 AND status='dispatched'",[plan.installationId,requestId]);
    }catch{throw new GatewayError('STORAGE_WRITE_UNCERTAIN',503,'unknown');}
   }
   if(error instanceof GatewayError)throw error;
   throw new GatewayError(error instanceof AppStorageError?error.code:'STORAGE_OPERATION_FAILED',503,write&&intent?'unknown':'not_started');
  }finally{
   try{
    try{if(runtime)await runtime.end();}
    finally{try{if(admin&&plan&&lease)await recoverRuntimeStorageLease(admin,plan);}finally{if(admin)await admin.end();}}
   }catch{throw new GatewayError('STORAGE_CLEANUP_REQUIRED',503,write&&intent?'unknown':'not_started');}
  }
 }
 private async columns(client:QueryableClient,plan:ManagedAppStorage,table:string){
  const found=await rows<{name:string;type:string;builtin:boolean;generated:string;identity:string}>(client,`SELECT a.attname AS name,t.typname AS type,t.typnamespace='pg_catalog'::regnamespace AS builtin,a.attgenerated AS generated,a.attidentity AS identity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
   WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$3)
   AND NOT c.relrowsecurity AND NOT c.relhasrules AND NOT c.relhastriggers AND NOT c.relhassubclass
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhrelid=c.oid)
   AND a.attnum>0 AND NOT a.attisdropped
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_attribute pk ON pk.attrelid=c.oid AND pk.attname='id' WHERE i.indrelid=c.oid AND i.indisprimary AND i.indnkeyatts=1 AND i.indkey[0]=pk.attnum AND pk.atttypid='pg_catalog.uuid'::regtype)`,[plan.schema,table,plan.ownerRole]);
  if(!found.length||found.length>64||found.some(c=>!c.builtin||c.generated!==''||c.identity!==''||!identifier.safeParse(c.name).success||!['uuid','text','bool','int4','jsonb','timestamptz'].includes(c.type)))throw new AppStorageError('STORAGE_TABLE_UNSUPPORTED');
  return new Map(found.map(c=>[c.name,c.type]));
 }
}
function validValue(type:string,value:unknown){if(value===null)return true;if(type==='jsonb')return value!==undefined;
 if(type==='timestamptz')return typeof value==='string'&&z.string().datetime({offset:true}).safeParse(value).success;
 if(type==='text')return typeof value==='string';if(type==='uuid')return z.string().uuid().safeParse(value).success;
 if(type==='bool')return typeof value==='boolean';return typeof value==='number'&&Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
}
async function connectRuntime(credentials:AppMigrationCredentials){
 const client=new Client({...credentials,connectionTimeoutMillis:3000,statement_timeout:3000,lock_timeout:1000,idle_in_transaction_session_timeout:5000,options:'-c search_path=pg_catalog',application_name:'mop-app-data',...{replication:'false'}});
 client.on('error',()=>undefined);try{await client.connect();return client;}catch{await client.end();throw new AppStorageError('STORAGE_RUNTIME_CONNECTION_FAILED');}
}
