import {createHash} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type QueryableClient} from '../../core/database/index.js';
import {appendAdminAudit,AdminIdentityError} from '../../core/admin-identity/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import {createAuthorizationService,createPostgresAuthorizationRepository} from '../../platform/authorization/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {PostgresAppRegistryRepository} from '../registry/index.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function authorize(context:PlatformAdministratorContext){if(!(await context.authorize('platform.authorization.manage',{})).allowed)throw new AdminIdentityError(403,'ADMIN_AUTH_REQUIRED');}
export function createEmployeeRoleManagement(db:QueryableClient){
 const repository=createPostgresAuthorizationRepository(db),people=createPostgresPeopleDirectoryRepository(db);
 const service=createAuthorizationService(repository,{findPerson:id=>people.findPersonById(id)});
 async function snapshot(appId:string){
  const app=await new PostgresAppRegistryRepository(db).findByAppId(appId);if(!app)throw new AdminIdentityError(404,'APP_NOT_FOUND');
  const permissions=app.manifest.permissions.defined;
  const catalog=await repository.listPermissions(),roles=[];
  for(const role of await repository.listRoles()){
   const grants=(await repository.listRolePermissions(role.id)).filter(g=>permissions.some(p=>catalog.find(c=>c.id===g.grant.permissionId)?.code===p.code));
   roles.push({id:role.id,name:role.name,status:role.status,grants:grants.map(g=>({code:catalog.find(c=>c.id===g.grant.permissionId)!.code,scope:g.scope}))});
  }
  const state={permissions,roles,installationRevision:app.revision};return {...state,revision:digest(state)};
 }
 return {
  async list(context:PlatformAdministratorContext,appId:string){await authorize(context);const result=await snapshot(appId);await authorize(context);return result;},
  async set(context:PlatformAdministratorContext,appId:string,input:unknown){
   await authorize(context);const p=z.object({revision:z.string().length(64),roleId:z.string().uuid(),permissionCode:z.string(),enabled:z.boolean()}).strict().parse(input);
   return runDatabaseTransaction(db,async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-employee-roles',0))");
    const current=await snapshot(appId);if(current.revision!==p.revision)throw new AdminIdentityError(409,'STALE_REVISION');
    const defined=current.permissions.find(permission=>permission.code===p.permissionCode);
    if(!defined||!p.permissionCode.startsWith(`app.${appId}.`))throw new AdminIdentityError(400,'UNDECLARED_PERMISSION');
    const role=await repository.findRoleById(p.roleId);if(role?.status!=='active')throw new AdminIdentityError(400,'ROLE_INACTIVE');
    let permission=await repository.findPermissionByCode(p.permissionCode);
    if(!permission)permission=await service.registerPermission({code:p.permissionCode,name:defined.description.slice(0,150),description:defined.description});
    if(p.enabled)await service.grantRolePermission({roleId:p.roleId,permissionId:permission.id,scope:{kind:'all',targets:[]}});
    else await service.revokeRolePermission(p.roleId,permission.id);
    await authorize(context);await appendAdminAudit(db,{actorId:context.administrator.id,action:p.enabled?'employee.role_permission.grant':'employee.role_permission.revoke',targetId:`${p.roleId}:${p.permissionCode}`});
    return snapshot(appId);
   });
  },
  async assignment(context:PlatformAdministratorContext,personId:string){await authorize(context);z.string().uuid().parse(personId);const assignment=await repository.findCurrentPersonRole(personId);await authorize(context);return {assignment};},
  async assign(context:PlatformAdministratorContext,input:unknown){
   await authorize(context);const p=z.object({personId:z.string().uuid(),roleId:z.string().uuid(),revision:z.string().uuid().nullable()}).strict().parse(input);
   return runDatabaseTransaction(db,async()=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-employee-roles',0))");
    const old=await repository.findCurrentPersonRole(p.personId);if((old?.id??null)!==p.revision)throw new AdminIdentityError(409,'STALE_REVISION');
    const assignment=await service.changeRole({personId:p.personId,roleId:p.roleId,reason:'管理员网页调整员工角色',assignedByPersonId:null});
    await authorize(context);await appendAdminAudit(db,{actorId:context.administrator.id,action:'employee.role.assign',targetId:`${p.personId}:${p.roleId}`});return {assignment};
   });
  },
 };
}
