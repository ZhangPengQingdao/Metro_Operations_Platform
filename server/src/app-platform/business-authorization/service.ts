import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type QueryableClient,type ConnectablePool} from '../../core/database/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import type {AppManifest} from '../manifest/index.js';

export const scopeKinds=['self','workgroup','department','organizations','all'] as const;
export const businessRule=z.object({permission:z.string().min(1).max(192),scope:z.enum(scopeKinds),organizationIds:z.array(z.string().uuid()).max(100).default([])}).strict().refine(v=>v.scope==='organizations'?v.organizationIds.length>0:v.organizationIds.length===0);
export const appAudience=z.object({all:z.boolean(),personIds:z.array(z.string().uuid()).max(1000),organizationIds:z.array(z.string().uuid()).max(100),departmentIds:z.array(z.string().uuid()).max(100)}).strict();
type Audience=z.infer<typeof appAudience>;
export type BusinessRule=z.infer<typeof businessRule>;
export interface ResolvedBusinessGrant{permission:string;all:boolean;self:boolean;organizationIds:string[]}
const appIdSchema=z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
const query=async<T>(db:QueryableClient,sql:string,args:readonly unknown[]=[])=>((await db.query(sql,args)) as {rows:T[]}).rows;
const fail=(code:string,status=403):never=>{throw new EmployeeIdentityError(status,code);};
export class AppBusinessAuthorization{
 constructor(private readonly pool:ConnectablePool){}
 private async read<T>(work:(db:QueryableClient)=>Promise<T>){const db=await this.pool.connect();try{return await work(db);}finally{db.release();}}
 private async installation(db:QueryableClient,appId:string){appIdSchema.parse(appId);const [row]=await query<{id:string;record:{manifest:AppManifest;enabled:boolean}}>(db,'SELECT id,record FROM platform_app_installations WHERE app_id=$1',[appId]);if(!row)fail('APP_NOT_FOUND',404);return row;}
 private async person(db:QueryableClient,id:string){const [p]=await query<{id:string;organization_unit_id:string}>(db,`SELECT p.id,p.organization_unit_id FROM platform_people p JOIN platform_organization_units o ON o.id=p.organization_unit_id JOIN platform_positions pos ON pos.id=p.position_id WHERE p.id=$1 AND p.employment_status='active' AND o.status='active' AND pos.status='active'`,[id]);if(!p)fail('EMPLOYEE_PERSON_INACTIVE');return p;}
 private async owner(db:QueryableClient,installationId:string,personId:string){await this.person(db,personId);const [row]=await query(db,'SELECT installation_id FROM platform_app_authorization WHERE installation_id=$1 AND owner_person_id=$2',[installationId,personId]);if(!row)fail('APP_OWNER_REQUIRED');}
 private async admin(context:PlatformAdministratorContext){if(context.actorType!=='administrator'||context.execution.type!=='platform'||!(await context.authorize('platform.authorization.manage',{})).allowed)fail('EMPLOYEE_MANAGEMENT_DENIED');}
 private async state(db:QueryableClient,id:string){const [state]=await query<{owner_person_id:string|null;mode:'legacy'|'application';revision:string;audience:Audience|null}>(db,'SELECT * FROM platform_app_authorization WHERE installation_id=$1',[id]);return state;}
 async administratorState(context:PlatformAdministratorContext,appId:string){await this.admin(context);return this.read(async db=>{const app=await this.installation(db,appId),s=await this.state(db,app.id);const [owner]=s?.owner_person_id?await query(db,'SELECT id,name,employee_no AS "employeeNo" FROM platform_people WHERE id=$1',[s.owner_person_id]):[];await this.admin(context);return {owner:owner??null,revision:s?.revision??null,mode:s?.mode??'legacy'};});}
 async setOwner(context:PlatformAdministratorContext,appId:string,input:unknown){await this.admin(context);const v=z.object({personId:z.string().uuid().nullable(),revision:z.string().uuid().nullable()}).strict().parse(input);await this.read(db=>runDatabaseTransaction(db,async()=>{await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-business-authorization',0))");await this.admin(context);const app=await this.installation(db,appId),old=await this.state(db,app.id);if((old?.revision??null)!==v.revision)fail('STALE_REVISION',409);if(v.personId)await this.person(db,v.personId);await db.query(`INSERT INTO platform_app_authorization(installation_id,owner_person_id,revision) VALUES($1,$2,$3) ON CONFLICT(installation_id) DO UPDATE SET owner_person_id=$2,revision=$3,updated_at=now()`,[app.id,v.personId,randomUUID()]);await appendAdminAudit(db,{actorId:context.administrator.id,action:'app.owner.set',targetId:`${app.id}:${v.personId??'none'}`});}));return this.administratorState(context,appId);}
 async ownedApps(personId:string){return this.read(async db=>{await this.person(db,personId);return query<{appId:string;name:string}>(db,`SELECT i.app_id AS "appId",i.record->'manifest'->>'name' AS name FROM platform_app_authorization a JOIN platform_app_installations i ON i.id=a.installation_id WHERE a.owner_person_id=$1 ORDER BY i.app_id`,[personId]);});}
 async snapshot(appId:string,personId:string){return this.read(async db=>{const app=await this.installation(db,appId);await this.owner(db,app.id,personId);const state=await this.state(db,app.id);const roles=await query(db,'SELECT id,name,status,rules FROM platform_app_business_roles WHERE installation_id=$1 ORDER BY name,id',[app.id]);const members=await query(db,`SELECT m.role_id AS "roleId",m.person_id AS "personId",p.name,p.employee_no AS "employeeNo" FROM platform_app_business_members m JOIN platform_people p ON p.id=m.person_id WHERE m.installation_id=$1 ORDER BY p.employee_no,m.role_id`,[app.id]);await this.owner(db,app.id,personId);return {revision:state!.revision,mode:state!.mode,audience:state!.audience,permissions:app.record.manifest.permissions.defined.filter(p=>!app.record.manifest.permissions.defined.some(d=>d.scopeKinds)||p.scopeKinds),roles,members};});}
 async directory(appId:string,personId:string,input:unknown){const v=z.object({search:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().parse(input);return this.read(async db=>{const app=await this.installation(db,appId);await this.owner(db,app.id,personId);const people=await query(db,`SELECT p.id,p.name,p.employee_no AS "employeeNo" FROM platform_people p WHERE p.employment_status='active' AND ($1='' OR strpos(lower(p.name||' '||p.employee_no),lower($1))>0) ORDER BY p.employee_no,p.id LIMIT 51 OFFSET $2`,[v.search,(v.page-1)*50]);const organizations=await query(db,"SELECT id,name,parent_id AS \"parentId\",unit_type AS type FROM platform_organization_units WHERE status='active' ORDER BY name,id LIMIT 2001");if(organizations.length>2000)fail('DIRECTORY_LIMIT',422);await this.owner(db,app.id,personId);return {people:people.slice(0,50),hasMore:people.length>50,organizations};});}
 async change(appId:string,personId:string,input:unknown){
  const v=z.discriminatedUnion('action',[
   z.object({action:z.literal('role'),revision:z.string().uuid(),id:z.string().uuid().optional(),name:z.string().trim().min(1).max(100),status:z.enum(['active','inactive']),rules:z.array(businessRule).max(128)}).strict(),
   z.object({action:z.literal('member'),revision:z.string().uuid(),roleId:z.string().uuid(),personId:z.string().uuid(),enabled:z.boolean()}).strict(),
   z.object({action:z.literal('delegation'),revision:z.string().uuid(),roleId:z.string().uuid(),permission:z.string().max(192),enabled:z.boolean()}).strict(),
   z.object({action:z.literal('audience'),revision:z.string().uuid(),audience:appAudience}).strict(),
   z.object({action:z.literal('activate'),revision:z.string().uuid(),confirm:z.literal(true)}).strict()
  ]).parse(input);
  await this.read(db=>runDatabaseTransaction(db,async()=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-business-authorization',0))");const app=await this.installation(db,appId);await this.owner(db,app.id,personId);const state=await this.state(db,app.id);if(state?.revision!==v.revision)fail('STALE_REVISION',409);
   if(v.action==='role'){
    for(const rule of v.rules){const declared=app.record.manifest.permissions.defined.find(p=>p.code===rule.permission);if(!declared||app.record.manifest.permissions.defined.some(d=>d.scopeKinds)&&!declared.scopeKinds||!(declared.scopeKinds??['all']).includes(rule.scope))fail('APP_SCOPE_UNSUPPORTED',400);for(const id of rule.organizationIds){if(!(await query(db,"SELECT id FROM platform_organization_units WHERE id=$1 AND status='active'",[id])).length)fail('INVALID_ORGANIZATION',400);}}
    const id=v.id??randomUUID();if(v.id&&!(await query(db,'SELECT id FROM platform_app_business_roles WHERE installation_id=$1 AND id=$2',[app.id,id])).length)fail('APP_ROLE_NOT_FOUND',404);
    await db.query(`INSERT INTO platform_app_business_roles(id,installation_id,name,status,rules) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=$3,status=$4,rules=$5`,[id,app.id,v.name,v.status,JSON.stringify(v.rules)]);
   }else if(v.action==='member'){
    if(!(await query(db,'SELECT id FROM platform_app_business_roles WHERE installation_id=$1 AND id=$2',[app.id,v.roleId])).length)fail('APP_ROLE_NOT_FOUND',404);
    if(v.enabled){await this.person(db,v.personId);await db.query('INSERT INTO platform_app_business_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[app.id,v.roleId,v.personId]);}
    else await db.query('DELETE FROM platform_app_business_members WHERE installation_id=$1 AND role_id=$2 AND person_id=$3',[app.id,v.roleId,v.personId]);
   }else if(v.action==='delegation'){
    const [role]=await query<{rules:BusinessRule[]}>(db,'SELECT rules FROM platform_app_business_roles WHERE installation_id=$1 AND id=$2',[app.id,v.roleId]);
    if(!role)fail('APP_ROLE_NOT_FOUND',404);
    if(v.enabled){
     const permission=app.record.manifest.permissions.defined.find(p=>p.code===v.permission);
     if(!permission?.scopeKinds?.includes('workgroup')||!role.rules.length||role.rules.some(r=>r.scope!=='workgroup'||r.permission===v.permission))fail('APP_DELEGATION_UNSAFE',400);
     await db.query('INSERT INTO platform_app_role_delegations VALUES($1,$2,$3) ON CONFLICT(installation_id,role_id) DO UPDATE SET permission=$3',[app.id,v.roleId,v.permission]);
    }else await db.query('DELETE FROM platform_app_role_delegations WHERE installation_id=$1 AND role_id=$2',[app.id,v.roleId]);
   }else if(v.action==='audience'){
    for(const id of v.audience.personIds)await this.person(db,id);
    for(const id of [...v.audience.organizationIds,...v.audience.departmentIds]){const [org]=await query<{unit_type:string}>(db,"SELECT unit_type FROM platform_organization_units WHERE id=$1 AND status='active'",[id]);if(!org||v.audience.departmentIds.includes(id)&&org.unit_type!=='department')fail('INVALID_ORGANIZATION',400);}
    await db.query('UPDATE platform_app_authorization SET audience=$2 WHERE installation_id=$1',[app.id,JSON.stringify(v.audience)]);
   }else{await db.query("UPDATE platform_app_authorization SET mode='application' WHERE installation_id=$1",[app.id]);}
   await db.query('UPDATE platform_app_authorization SET revision=$2,updated_at=now() WHERE installation_id=$1',[app.id,randomUUID()]);
   await appendAdminAudit(db,{actorId:personId,action:`app.business.${v.action}`,targetId:`${app.id}:${JSON.stringify(v)}`});
  }));return this.snapshot(appId,personId);
 }
 async delegate(appId:string,personId:string,input:unknown){
  const v=z.object({revision:z.string().uuid(),roleId:z.string().uuid(),personId:z.string().uuid(),organizationId:z.string().uuid(),enabled:z.boolean()}).strict().parse(input);
  return this.read(db=>runDatabaseTransaction(db,async()=>{
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('app-business-authorization',0))");
   const app=await this.installation(db,appId),resolved=await this.resolveWith(db,appId,personId);
   if(!resolved)return fail('APP_DELEGATION_SCOPE_DENIED');
   if(resolved.revision!==v.revision)fail('STALE_REVISION',409);
   const [policy]=await query<{permission:string;rules:BusinessRule[]}>(db,`SELECT d.permission,r.rules FROM platform_app_role_delegations d JOIN platform_app_business_roles r ON r.installation_id=d.installation_id AND r.id=d.role_id WHERE d.installation_id=$1 AND d.role_id=$2 AND r.status='active'`,[app.id,v.roleId]);
   if(!policy||!policy.rules.length||policy.rules.some(r=>r.scope!=='workgroup'||r.permission===policy.permission))fail('APP_DELEGATION_UNSAFE');
   const actor=await this.person(db,personId),target=await this.person(db,v.personId);
   const [org]=await query<{unit_type:string}>(db,"SELECT unit_type FROM platform_organization_units WHERE id=$1 AND status='active'",[v.organizationId]);
   if(org?.unit_type!=='workgroup'||actor.organization_unit_id!==v.organizationId||target.organization_unit_id!==v.organizationId||!resolved.grants.some(g=>g.permission===policy.permission&&(g.all||g.organizationIds.includes(v.organizationId))))fail('APP_DELEGATION_SCOPE_DENIED');
   if(v.enabled)await db.query('INSERT INTO platform_app_delegated_members(installation_id,role_id,person_id,organization_id,assigned_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[app.id,v.roleId,v.personId,v.organizationId,personId]);
   else await db.query('DELETE FROM platform_app_delegated_members WHERE installation_id=$1 AND role_id=$2 AND person_id=$3 AND organization_id=$4',[app.id,v.roleId,v.personId,v.organizationId]);
   const revision=randomUUID();await db.query('UPDATE platform_app_authorization SET revision=$2,updated_at=now() WHERE installation_id=$1',[app.id,revision]);
   await appendAdminAudit(db,{actorId:personId,action:v.enabled?'app.business.delegate':'app.business.undelegate',targetId:`${app.id}:${JSON.stringify(v)}`});
   return {revision};
  }));
 }
 async resolve(appId:string,personId:string){return this.read(db=>this.resolveWith(db,appId,personId));}
 private async resolveWith(db:QueryableClient,appId:string,personId:string){
  const app=await this.installation(db,appId),state=await this.state(db,app.id);if(state?.mode!=='application')return null;
  const p=await this.person(db,personId);if(!app.record.enabled)fail('APP_DISABLED');
  const roles=await query<{rules:BusinessRule[]}>(db,`SELECT r.rules FROM platform_app_business_roles r JOIN platform_app_business_members m ON m.role_id=r.id AND m.installation_id=r.installation_id WHERE r.installation_id=$1 AND m.person_id=$2 AND r.status='active' ORDER BY r.id`,[app.id,personId]);
  const orgs=await query<{id:string;parent_id:string|null;unit_type:string;status:string;name:string}>(db,'SELECT id,parent_id,unit_type,status,name FROM platform_organization_units');
  const byId=new Map(orgs.map(o=>[o.id,o]));
  const ancestor=(id:string,type:string)=>{const seen=new Set<string>();let o=byId.get(id);while(o&&!seen.has(o.id)&&o.status==='active'){seen.add(o.id);if(o.unit_type===type)return o.id;o=o.parent_id?byId.get(o.parent_id):undefined;}return undefined;};
  const delegated=await query<{rules:BusinessRule[];organization_id:string;permission:string}>(db,`SELECT r.rules,m.organization_id,d.permission FROM platform_app_delegated_members m JOIN platform_app_role_delegations d USING(installation_id,role_id) JOIN platform_app_business_roles r ON r.id=m.role_id AND r.installation_id=m.installation_id WHERE m.installation_id=$1 AND m.person_id=$2 AND r.status='active'`,[app.id,personId]);
  for(const d of delegated){
   if(ancestor(p.organization_unit_id,'workgroup')!==d.organization_id||!d.rules.length||d.rules.some(r=>r.scope!=='workgroup'||r.permission===d.permission))continue;
   roles.push({rules:d.rules});
  }
  const audience=state.audience;
  if(audience&&!audience.all&&!audience.personIds.includes(personId)&&!audience.organizationIds.includes(p.organization_unit_id)){
   const seen=new Set<string>();let org=byId.get(p.organization_unit_id);let admitted=false;
   while(org&&org.status==='active'&&!seen.has(org.id)){seen.add(org.id);if(audience.departmentIds.includes(org.id)){admitted=true;break;}org=org.parent_id?byId.get(org.parent_id):undefined;}
   if(!admitted)return {revision:state.revision,grants:[],organizations:[]};
  }
  const grants:ResolvedBusinessGrant[]=[];
  for(const permission of app.record.manifest.permissions.defined){const rules=roles.flatMap(r=>r.rules).filter(r=>r.permission===permission.code&&(permission.scopeKinds??['all']).includes(r.scope));if(!rules.length)continue;
   const ids=new Set<string>();let all=false,self=false;
   for(const r of rules){if(r.scope==='all')all=true;else if(r.scope==='self')self=true;else if(r.scope==='workgroup'){const id=ancestor(p.organization_unit_id,'workgroup');if(id)ids.add(id);}else if(r.scope==='department'){const root=ancestor(p.organization_unit_id,'department');if(root)for(const o of orgs)if(ancestor(o.id,'department')===root)ids.add(o.id);}else for(const id of r.organizationIds)if(byId.get(id)?.status==='active')ids.add(id);}
   if(all||self||ids.size)grants.push({permission:permission.code,all,self,organizationIds:[...ids].sort()});
  }
  const organizations=orgs.filter(o=>o.status==='active'&&o.unit_type==='workgroup'&&grants.some(g=>g.all||g.organizationIds.includes(o.id)||g.self&&o.id===p.organization_unit_id)).map(o=>({id:o.id,name:o.name})).sort((a,b)=>a.id.localeCompare(b.id));
  if(organizations.length>128||grants.some(g=>g.organizationIds.length>127))fail('APP_SCOPE_LIMIT',422);
  return {revision:state.revision,grants,organizations};
 }
}
