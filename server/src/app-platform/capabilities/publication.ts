import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import type {AppInstallation} from '../registry/model.js';
import {manifestApprovalDigest} from '../management/config.js';

export const appCapabilityPublicationMigration:MigrationDefinition={
 id:'app-capability-publication-expand',title:'Application owner capability publication',ownerTaskId:'PLATFORM-L4-023',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-077'],
 sourceTables:['platform_app_installations','platform_app_authorization'],targetTables:['platform_app_capability_publications'],dependsOn:['app-business-authorization-expand'],
 recoveryNotes:'Candidates are closed by default. A manifest change invalidates every prior publication until the owner reviews it.',
 async run({client}){await client.query(`CREATE TABLE platform_app_capability_publications(
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id),api_id varchar(64) NOT NULL,
  owner_person_id uuid NOT NULL REFERENCES platform_people(id),
  manifest_digest char(64) NOT NULL,enabled boolean NOT NULL,revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(installation_id,api_id));`);}
};

const appId=z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
const apiId=z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
const input=z.object({apiId,enabled:z.boolean(),revision:z.string().uuid().nullable()}).strict();
type Row={id:string;appId:string;record:{manifest:AppInstallation['manifest'];enabled:boolean};ownerPersonId:string|null};
type Publication={apiId:string;ownerPersonId:string;manifestDigest:string;enabled:boolean;revision:string};
const rows=async<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>(await db.query(sql,args) as {rows:T[]}).rows;
const denied=(code:string,status=403):never=>{throw new EmployeeIdentityError(status,code);};

export class AppCapabilityPublication{
 constructor(private readonly pool:ConnectablePool){}
 private async use<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 private async owned(db:QueryableClient,id:string,personId:string){
  const [installation]=await rows<Row>(db,`SELECT i.id,i.app_id AS "appId",i.record,a.owner_person_id AS "ownerPersonId"
    FROM platform_app_installations i JOIN platform_app_authorization a ON a.installation_id=i.id
    JOIN platform_people p ON p.id=a.owner_person_id JOIN platform_organization_units o ON o.id=p.organization_unit_id
    JOIN platform_positions pos ON pos.id=p.position_id
    WHERE i.app_id=$1 AND a.owner_person_id=$2 AND p.employment_status='active' AND o.status='active' AND pos.status='active'`,[id,personId]);
  if(!installation)denied('APP_OWNER_REQUIRED');return installation;
 }
 async state(id:string,personId:string){appId.parse(id);z.string().uuid().parse(personId);return this.use(async db=>{
  const installation=await this.owned(db,id,personId),digest=manifestApprovalDigest(installation.record.manifest);
  const published=await rows<Publication>(db,'SELECT api_id AS "apiId",owner_person_id AS "ownerPersonId",manifest_digest AS "manifestDigest",enabled,revision FROM platform_app_capability_publications WHERE installation_id=$1',[installation.id]);
  return {appId:id,version:installation.record.manifest.version,capabilities:installation.record.manifest.api.filter(api=>api.expose).map(api=>{
   const current=published.find(row=>row.apiId===api.id&&row.ownerPersonId===personId&&row.manifestDigest===digest);
   return {apiId:api.id,description:installation.record.manifest.permissions.defined.find(permission=>permission.code===api.businessPermission)?.description??api.id,
    mode:api.expose!.mode,enabled:current?.enabled??false,revision:current?.revision??null};
  })};
 });}
 async set(id:string,personId:string,value:unknown){appId.parse(id);z.string().uuid().parse(personId);const change=input.parse(value);
  await this.use(db=>runDatabaseTransaction(db,async()=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-capability-publication',0))");
   const installation=await this.owned(db,id,personId),manifest=installation.record.manifest,digest=manifestApprovalDigest(manifest);
   if(!manifest.api.some(api=>api.id===change.apiId&&api.expose))denied('APP_CAPABILITY_NOT_DECLARED',400);
   const [old]=await rows<Publication>(db,'SELECT api_id AS "apiId",owner_person_id AS "ownerPersonId",manifest_digest AS "manifestDigest",enabled,revision FROM platform_app_capability_publications WHERE installation_id=$1 AND api_id=$2',[installation.id,change.apiId]);
   if((old?.ownerPersonId===personId&&old.manifestDigest===digest?old.revision:null)!==change.revision)denied('STALE_REVISION',409);
   const revision=randomUUID();
   await db.query(`INSERT INTO platform_app_capability_publications(installation_id,api_id,owner_person_id,manifest_digest,enabled,revision) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(installation_id,api_id) DO UPDATE SET owner_person_id=$3,manifest_digest=$4,enabled=$5,revision=$6,updated_at=now()`,[installation.id,change.apiId,personId,digest,change.enabled,revision]);
   await appendAdminAudit(db,{actorId:personId,action:change.enabled?'app.capability.publish':'app.capability.withdraw',targetId:`${installation.id}:${change.apiId}:${digest}`});
  }));
  return this.state(id,personId);
 }
 async isPublished(installation:AppInstallation,id:string){
  if(!installation.enabled||!installation.manifest.api.some(api=>api.id===id&&api.expose))return false;
  return this.use(async db=>{
   const [row]=await rows<{enabled:boolean}>(db,`SELECT p.enabled FROM platform_app_capability_publications p
     JOIN platform_app_authorization a ON a.installation_id=p.installation_id AND a.owner_person_id=p.owner_person_id
     JOIN platform_people person ON person.id=a.owner_person_id AND person.employment_status='active'
     JOIN platform_organization_units org ON org.id=person.organization_unit_id AND org.status='active'
     JOIN platform_positions pos ON pos.id=person.position_id AND pos.status='active'
     WHERE p.installation_id=$1 AND p.api_id=$2 AND p.manifest_digest=$3`,[installation.id,id,manifestApprovalDigest(installation.manifest)]);
   return row?.enabled===true;
  });
 }
 async catalog(){return this.use(async db=>{
  const found=await rows<{appId:string;record:{manifest:AppInstallation['manifest'];enabled:boolean};apiId:string;manifestDigest:string}>(db,`SELECT i.app_id AS "appId",i.record,p.api_id AS "apiId",p.manifest_digest AS "manifestDigest"
    FROM platform_app_capability_publications p JOIN platform_app_installations i ON i.id=p.installation_id
    JOIN platform_app_authorization a ON a.installation_id=p.installation_id AND a.owner_person_id=p.owner_person_id
    JOIN platform_people person ON person.id=a.owner_person_id AND person.employment_status='active'
    JOIN platform_organization_units org ON org.id=person.organization_unit_id AND org.status='active'
    JOIN platform_positions pos ON pos.id=person.position_id AND pos.status='active'
    WHERE p.enabled=true`);
  return {publications:found.filter(row=>row.record.enabled&&row.record.manifest.api.some(api=>api.id===row.apiId&&api.expose)&&row.manifestDigest===manifestApprovalDigest(row.record.manifest)).map(row=>({appId:row.appId,apiId:row.apiId}))};
 });}
}
