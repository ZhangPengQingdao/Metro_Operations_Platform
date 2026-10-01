import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import type {AppInstallation} from '../registry/model.js';
import {manifestApprovalDigest} from '../management/config.js';
import type {AppContractSchema} from '@metro/platform-sdk/app-api-documentation';

export const appCapabilityPublicationMigration:MigrationDefinition={
 id:'app-capability-publication-expand',title:'Application owner capability publication',ownerTaskId:'PLATFORM-L4-023',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-077'],
 sourceTables:['platform_app_installations','platform_app_authorization'],targetTables:['platform_app_capability_publications'],dependsOn:['app-business-authorization-expand'],
 recoveryNotes:'Candidates are closed by default. Legacy publications initially required an exact manifest digest.',
 async run({client}){await client.query(`CREATE TABLE platform_app_capability_publications(
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id),api_id varchar(64) NOT NULL,
  owner_person_id uuid NOT NULL REFERENCES platform_people(id),
  manifest_digest char(64) NOT NULL,enabled boolean NOT NULL,revision uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(installation_id,api_id));`);}
};

// Only schema constraints affect publication; descriptive text remains signed metadata.
function schemaContract(schema:AppContractSchema):unknown{
 return {type:schema.type,
  ...(schema.properties?{properties:Object.fromEntries(Object.keys(schema.properties).sort().map(key=>[key,schemaContract(schema.properties![key])]))}:{}),
  ...(schema.required?{required:[...schema.required].sort()}:{}),
  ...(schema.additionalProperties!==undefined?{additionalProperties:schema.additionalProperties}:{}),
  ...(schema.items?{items:schemaContract(schema.items)}:{}),
  ...(schema.enum?{enum:schema.enum}:{})};
}

function publicationContractDigest(manifest:AppInstallation['manifest'],api:AppInstallation['manifest']['api'][number]){
 const permission=manifest.permissions.defined.find(item=>item.code===api.businessPermission);
 const backendDeclaration=manifest.backend;
 const backend=backendDeclaration.mode==='isolated'||backendDeclaration.mode==='trusted'
  ?manifest.artifacts.find(item=>item.id===backendDeclaration.entryArtifactId)?.sha256:null;
 return createHash('sha256').update(JSON.stringify({appId:manifest.id,apiId:api.id,method:api.method,path:api.path,handler:api.handler,
  permission:api.permission,businessPermission:api.businessPermission,scopeKinds:permission?.scopeKinds??null,
  contractVersion:api.expose?.contractVersion,mode:api.expose?.mode,backend,
  ...(api.expose?.documentation?{schema:{input:schemaContract(api.expose.documentation.input),output:schemaContract(api.expose.documentation.output)}}:{})})).digest('hex');
}

export const appCapabilityPublicationContractMigration:MigrationDefinition={
 id:'app-capability-publication-contract-digest',title:'Preserve published APIs across metadata-only app upgrades',ownerTaskId:'PLATFORM-L4-023',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-078'],
 sourceTables:['platform_app_installations','platform_app_capability_publications'],targetTables:['platform_app_capability_publications'],dependsOn:['app-capability-publication-expand'],
 recoveryNotes:'Convert only publications matching the currently installed signed manifest. Stale publications remain closed.',
 async run({client}){
  const found=await rows<{installationId:string;apiId:string;manifestDigest:string;record:{manifest:AppInstallation['manifest']}}>(client,`SELECT p.installation_id AS "installationId",p.api_id AS "apiId",p.manifest_digest AS "manifestDigest",i.record
   FROM platform_app_capability_publications p JOIN platform_app_installations i ON i.id=p.installation_id FOR UPDATE OF p`);
  for(const row of found){
   const manifest=row.record.manifest,api=manifest.api.find(item=>item.id===row.apiId&&item.expose);
   if(!api||row.manifestDigest!==manifestApprovalDigest(manifest))continue;
   await client.query('UPDATE platform_app_capability_publications SET manifest_digest=$3 WHERE installation_id=$1 AND api_id=$2 AND manifest_digest=$4',
    [row.installationId,row.apiId,publicationContractDigest(manifest,api),row.manifestDigest]);
  }
 }
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
  const installation=await this.owned(db,id,personId),manifest=installation.record.manifest;
  const published=await rows<Publication>(db,'SELECT api_id AS "apiId",owner_person_id AS "ownerPersonId",manifest_digest AS "manifestDigest",enabled,revision FROM platform_app_capability_publications WHERE installation_id=$1',[installation.id]);
  return {appId:id,version:manifest.version,capabilities:manifest.api.filter(api=>api.expose).map(api=>{
   const current=published.find(row=>row.apiId===api.id&&row.ownerPersonId===personId&&row.manifestDigest===publicationContractDigest(manifest,api));
   return {apiId:api.id,title:api.expose!.title??`${api.method} ${api.path}`,
    permissionDescription:installation.record.manifest.permissions.defined.find(permission=>permission.code===api.businessPermission)?.description??api.businessPermission,
    mode:api.expose!.mode,enabled:current?.enabled??false,revision:current?.revision??null};
  })};
 });}
 async set(id:string,personId:string,value:unknown){appId.parse(id);z.string().uuid().parse(personId);const change=input.parse(value);
  await this.use(db=>runDatabaseTransaction(db,async()=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-capability-publication',0))");
   const installation=await this.owned(db,id,personId),manifest=installation.record.manifest;
   const api=manifest.api.find(item=>item.id===change.apiId&&item.expose);
   if(!api)return denied('APP_CAPABILITY_NOT_DECLARED',400);
   const digest=publicationContractDigest(manifest,api);
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
  const api=installation.manifest.api.find(item=>item.id===id&&item.expose);
  if(!installation.enabled||!api)return false;
  return this.use(async db=>{
   const [row]=await rows<{enabled:boolean}>(db,`SELECT p.enabled FROM platform_app_capability_publications p
     JOIN platform_app_authorization a ON a.installation_id=p.installation_id AND a.owner_person_id=p.owner_person_id
     JOIN platform_people person ON person.id=a.owner_person_id AND person.employment_status='active'
     JOIN platform_organization_units org ON org.id=person.organization_unit_id AND org.status='active'
     JOIN platform_positions pos ON pos.id=person.position_id AND pos.status='active'
     WHERE p.installation_id=$1 AND p.api_id=$2 AND p.manifest_digest=$3`,[installation.id,id,publicationContractDigest(installation.manifest,api)]);
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
  return {publications:found.filter(row=>{
   const api=row.record.manifest.api.find(item=>item.id===row.apiId&&item.expose);
   return row.record.enabled&&!!api&&row.manifestDigest===publicationContractDigest(row.record.manifest,api);
  }).map(row=>({appId:row.appId,apiId:row.apiId}))};
 });}
}
