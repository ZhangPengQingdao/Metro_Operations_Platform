import {AppBusinessAuthorization} from '../business-authorization/service.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import type {MigrationDefinition} from '../../core/migrations/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';

export const employeeAppAccessMigration:MigrationDefinition={id:'app-employee-access-expand',title:'Explicit employee application access',ownerTaskId:'PLATFORM-L4-016',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-059'],sourceTables:[],targetTables:['platform_employee_app_access'],dependsOn:['app-registry-expand','platform-employee-identity-expand'],recoveryNotes:'No default grants. Preserve grant revisions and administrator audit.',async run({client}){
 await client.query(`CREATE TABLE IF NOT EXISTS platform_employee_app_access(installation_id uuid NOT NULL REFERENCES platform_app_installations(id),person_id uuid NOT NULL REFERENCES platform_people(id),enabled boolean NOT NULL,revision uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(installation_id,person_id));`);
}};
const appIdSchema=z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
async function manage(context:PlatformAdministratorContext){if(context.actorType!=='administrator'||context.execution.type!=='platform'||!(await context.authorize('platform.authorization.manage',{})).allowed)throw new EmployeeIdentityError(403,'EMPLOYEE_MANAGEMENT_DENIED');}
async function rows<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[]){return (await db.query(sql,args) as {rows:T[]}).rows;}
export class EmployeeAppAccess{
 constructor(private readonly pool:ConnectablePool){}
 private async read<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 async list(context:PlatformAdministratorContext,appId:string){await manage(context);appIdSchema.parse(appId);return this.read(async db=>{
  const grants=await rows<{personId:string;name:string;employeeNo:string;enabled:boolean;revision:string}>(db,`SELECT a.person_id AS "personId",p.name,p.employee_no AS "employeeNo",a.enabled,a.revision FROM platform_employee_app_access a JOIN platform_app_installations i ON i.id=a.installation_id JOIN platform_people p ON p.id=a.person_id WHERE i.app_id=$1 ORDER BY p.employee_no,p.id LIMIT 500`,[appId]);await manage(context);return {grants};
 });}
 async set(context:PlatformAdministratorContext,appId:string,input:unknown){await manage(context);appIdSchema.parse(appId);const value=z.object({personId:z.string().uuid(),enabled:z.boolean(),revision:z.string().uuid().nullable()}).strict().parse(input);
  return this.read(db=>runDatabaseTransaction(db,async()=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('employee-app-access',0))");await manage(context);
   const [installation]=await rows<{id:string}>(db,'SELECT id FROM platform_app_installations WHERE app_id=$1',[appId]);if(!installation)throw new EmployeeIdentityError(404,'EMPLOYEE_APP_NOT_FOUND');
   const [person]=await rows<{employment_status:string}>(db,'SELECT employment_status FROM platform_people WHERE id=$1',[value.personId]);if(!person||value.enabled&&person.employment_status!=='active')throw new EmployeeIdentityError(403,'EMPLOYEE_PERSON_INACTIVE');
   const [old]=await rows<{revision:string}>(db,'SELECT revision FROM platform_employee_app_access WHERE installation_id=$1 AND person_id=$2',[installation.id,value.personId]);
   if((old?.revision??null)!==value.revision)throw new EmployeeIdentityError(409,'STALE_REVISION');
   const revision=randomUUID();
   await db.query('INSERT INTO platform_employee_app_access(installation_id,person_id,enabled,revision) VALUES($1,$2,$3,$4) ON CONFLICT(installation_id,person_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,updated_at=now()',[installation.id,value.personId,value.enabled,revision]);
   await manage(context);
   await appendAdminAudit(db,{actorId:context.administrator.id,action:value.enabled?'employee.app_access.grant':'employee.app_access.revoke',targetId:`${installation.id}:${value.personId}`});
   return {personId:value.personId,enabled:value.enabled,revision};
  }));
 }
 async assert(appId:string,personId:string){appIdSchema.parse(appId);z.string().uuid().parse(personId);
 const business=await new AppBusinessAuthorization(this.pool).resolve(appId,personId);
 if(business){if(!business.grants.length)throw new EmployeeIdentityError(403,'EMPLOYEE_APP_ACCESS_DENIED');return this.read(async db=>{const [i]=await rows<{id:string}>(db,'SELECT id FROM platform_app_installations WHERE app_id=$1',[appId]);return {installationId:i.id,revision:business.revision};});}
return this.read(async db=>{
  const [access]=await rows<{installationId:string;revision:string}>(db,`SELECT a.installation_id AS "installationId",a.revision FROM platform_employee_app_access a JOIN platform_app_installations i ON i.id=a.installation_id JOIN platform_people p ON p.id=a.person_id JOIN platform_organization_units o ON o.id=p.organization_unit_id JOIN platform_positions pos ON pos.id=p.position_id WHERE i.app_id=$1 AND a.person_id=$2 AND a.enabled AND i.record->>'enabled'='true' AND p.employment_status='active' AND o.status='active' AND pos.status='active'`,[appId,personId]);
  if(!access)throw new EmployeeIdentityError(403,'EMPLOYEE_APP_ACCESS_DENIED');return access;
 });}
 async candidates(personId:string){z.string().uuid().parse(personId);return this.read(db=>rows<{appId:string}>(db,`SELECT i.app_id AS "appId" FROM platform_employee_app_access a JOIN platform_app_installations i ON i.id=a.installation_id WHERE a.person_id=$1 AND a.enabled AND i.record->>'enabled'='true'
 UNION SELECT i.app_id AS "appId" FROM platform_app_business_members m JOIN platform_app_installations i ON i.id=m.installation_id JOIN platform_app_authorization b ON b.installation_id=i.id WHERE m.person_id=$1 AND b.mode='application' AND i.record->>'enabled'='true' UNION SELECT i.app_id AS "appId" FROM platform_app_delegated_members m JOIN platform_app_installations i ON i.id=m.installation_id JOIN platform_app_authorization b ON b.installation_id=i.id WHERE m.person_id=$1 AND b.mode='application' AND i.record->>'enabled'='true' UNION SELECT i.app_id AS "appId" FROM platform_app_installations i JOIN platform_app_authorization b ON b.installation_id=i.id WHERE b.default_role_id IS NOT NULL AND b.mode='application' AND i.record->>'enabled'='true' ORDER BY "appId" LIMIT 500`,[personId]));}
}
