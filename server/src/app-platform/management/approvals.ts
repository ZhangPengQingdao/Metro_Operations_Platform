import {createHash} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import type {PlatformManagementContext} from '../../platform/context/index.js';
import {parsePolicy,type PublisherPolicy} from '../developer/publisher-policy.js';
import {InstallError} from '../install/journal.js';

export const appApprovalMigration:MigrationDefinition={id:'app-management-approval-expand',title:'Administrator publisher trust and exact manifest approvals',ownerTaskId:'PLATFORM-L4-016',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-061'],sourceTables:[],targetTables:['platform_app_approval_history'],dependsOn:['platform-admin-identity-expand'],recoveryNotes:'Append-only policy versions. Configuration is imported only once; never reimport on missing trust or revoked approval.',async run({client}){await client.query(`CREATE TABLE IF NOT EXISTS platform_app_approval_history(
 revision integer PRIMARY KEY CHECK(revision>0),document jsonb NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());`);}};
const digests=z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512).refine(v=>new Set(v).size===v.length);
export interface ApprovalDocument{revision:number;policy:PublisherPolicy;approvedManifestDigests:string[];capabilityApprovalDigests?:string[]}
async function manage(context:PlatformManagementContext){if(context.actorType!=='administrator'||context.execution.type!=='platform'||!(await context.authorize('platform.authorization.manage',{})).allowed)throw new InstallError('INSTALL_ACCESS_DENIED');}
async function read(db:QueryableClient):Promise<ApprovalDocument|null>{
 const result=await db.query('SELECT revision,document FROM platform_app_approval_history ORDER BY revision DESC LIMIT 1') as {rows:{revision:number;document:{policy:unknown;approvedManifestDigests:unknown;capabilityApprovalDigests?:unknown}}[]};
 const row=result.rows[0];if(!row)return null;
 const policy=parsePolicy(row.document.policy);if(policy.revision!==row.revision)throw new InstallError('APPROVAL_STATE_INVALID');
 return {revision:row.revision,policy,approvedManifestDigests:digests.parse(row.document.approvedManifestDigests),capabilityApprovalDigests:digests.parse(row.document.capabilityApprovalDigests??[])};
}
export class AppApprovalStore{
 constructor(private readonly pool:ConnectablePool){}
 private async use<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 async initialize(load:()=>Promise<PublisherPolicy>,approved:string[]){
  return this.use(db=>runDatabaseTransaction(db,async()=>{
   await db.query('SELECT pg_advisory_xact_lock(6013061)');
   if(await read(db))return;
   const policy=parsePolicy(await load());digests.parse(approved);
   await db.query('INSERT INTO platform_app_approval_history(revision,document,actor_id) VALUES(1,$1,$2)',[JSON.stringify({policy:{...policy,revision:1},approvedManifestDigests:approved}),'configuration-import']);
  }));
 }
 async current(){return this.use(async db=>{const value=await read(db);if(!value)throw new InstallError('APPROVAL_STATE_REQUIRED');return value;});}
 async get(context:PlatformManagementContext){await manage(context);const result=await this.current();await manage(context);return result;}
 async save(context:PlatformManagementContext,revision:number,change:{keys?:PublisherPolicy['keys'];approval?:{digest:string;approved:boolean;platformCapabilities?:boolean}}){
  await manage(context);z.number().int().positive().max(2147483646).parse(revision);
  return this.use(db=>runDatabaseTransaction(db,async()=>{
   await db.query('SELECT pg_advisory_xact_lock(6013061)');await manage(context);
   const current=await read(db);if(!current||current.revision!==revision)throw new InstallError('APPROVAL_STALE_REVISION');
   const policy=parsePolicy({...current.policy,revision:revision+1,...(change.keys?{keys:change.keys}:{})});
   for(const old of current.policy.keys){
    const next=policy.keys.find(k=>k.publisherId===old.publisherId&&k.keyId===old.keyId);
    if(!next||next.publicKeyPem!==old.publicKeyPem)throw new InstallError('PUBLISHER_KEY_IMMUTABLE');
   }
   const approved=new Set(current.approvedManifestDigests);
   if(change.approval){z.string().regex(/^[a-f0-9]{64}$/).parse(change.approval.digest);change.approval.approved?approved.add(change.approval.digest):approved.delete(change.approval.digest);}
   const capabilityApprovals=new Set(current.capabilityApprovalDigests??[]);
   if(change.approval){if(!change.approval.approved)capabilityApprovals.delete(change.approval.digest);else if(change.approval.platformCapabilities)capabilityApprovals.add(change.approval.digest);}
   const document={policy,approvedManifestDigests:digests.parse([...approved]),capabilityApprovalDigests:digests.parse([...capabilityApprovals])};
   await manage(context);
   await db.query('INSERT INTO platform_app_approval_history(revision,document,actor_id) VALUES($1,$2,$3)',[revision+1,JSON.stringify(document),context.actorType==='administrator'?context.administrator.id:'']);
   await appendAdminAudit(db,{actorId:context.actorType==='administrator'?context.administrator.id:'',action:change.keys?'app.publisher-policy.update':change.approval?.approved?'app.version.approve':'app.version.revoke',targetId:change.approval?.digest??createHash('sha256').update(JSON.stringify(policy)).digest('hex')});
   return {revision:revision+1,...document};
  }));
 }
}
