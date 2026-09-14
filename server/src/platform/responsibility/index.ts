import { randomUUID } from 'node:crypto';
import { ResponsibilityError, type CreateResponsibilityAssignmentInput, type CreateResponsibilityScopeInput, type LegacyResponsibilityReconciliation, type LegacyResponsibilitySnapshot, type ResponsibilityAssignment, type ResponsibilityResolution, type ResponsibilityScope, type ResponsibilityTarget } from './model.js';
import type { ResponsibilityRepository } from './repository.js';
export * from './model.js'; export * from './migration.js'; export * from './repository.js';

export interface ResponsibilityServiceOptions {
  clock?:()=>Date; createId?:()=>string;
  findOrganizationUnit:(id:string)=>Promise<{status:string}|null>;
  findPerson:(id:string)=>Promise<{organizationUnitId:string;employmentStatus:string}|null>;
  findLocation:(id:string)=>Promise<{id:string;parentId:string|null;status:string}|null>;
  findAssetType:(id:string)=>Promise<{status:string}|null>;
  findAsset:(id:string)=>Promise<{lifecycleState:string}|null>;
}

export class ResponsibilityService {
  private clock; private createId;
  constructor(private repository:ResponsibilityRepository,private options:ResponsibilityServiceOptions){this.clock=options.clock??(()=>new Date());this.createId=options.createId??randomUUID;}

  async createScope(input:CreateResponsibilityScopeInput):Promise<ResponsibilityScope>{
    const organizationUnitId=uuid(input.organizationUnitId,'organization unit id');
    const organization=await this.options.findOrganizationUnit(organizationUnitId);
    if(!organization)throw new ResponsibilityError('ORGANIZATION_NOT_FOUND','责任组织不存在');
    if(organization.status!=='active')throw new ResponsibilityError('ORGANIZATION_INACTIVE','责任组织未启用');
    const target=await this.validateTarget(input.target);
    const draft={organizationUnitId,...target};
    if(await this.repository.findScopeByTarget(draft))throw new ResponsibilityError('DUPLICATE_RESPONSIBILITY_SCOPE','组织责任范围已存在');
    const now=this.clock().toISOString();
    return this.repository.createScope({id:uuid(input.id??this.createId(),'scope id'),...draft,status:input.status??'active',createdAt:now,updatedAt:now});
  }

  async assignPerson(input:CreateResponsibilityAssignmentInput):Promise<ResponsibilityAssignment>{
    const scopeId=uuid(input.scopeId,'scope id'); const personId=uuid(input.personId,'person id');
    const [scope,person]=await Promise.all([this.repository.findScopeById(scopeId),this.options.findPerson(personId)]);
    if(!scope)throw new ResponsibilityError('SCOPE_NOT_FOUND','责任范围不存在');
    if(scope.status!=='active')throw new ResponsibilityError('SCOPE_INACTIVE','责任范围未启用');
    if(!person)throw new ResponsibilityError('PERSON_NOT_FOUND','责任人员不存在');
    if(person.employmentStatus!=='active')throw new ResponsibilityError('PERSON_NOT_ACTIVE','责任人员不在岗');
    if(person.organizationUnitId!==scope.organizationUnitId)throw new ResponsibilityError('PERSON_ORGANIZATION_MISMATCH','责任人员不属于责任组织');
    const from=(input.effectiveFrom??this.clock()).toISOString(); const to=input.effectiveTo?.toISOString()??null;
    if(to&&to<=from)throw new ResponsibilityError('INVALID_EFFECTIVE_PERIOD','失效时间必须晚于生效时间');
    if(input.assignmentRole==='temporary_agent'&&!to)throw new ResponsibilityError('TEMPORARY_END_REQUIRED','临时代理必须设置失效时间');
    const existing=await this.repository.listAssignmentsByScope(scopeId);
    const conflicts=existing.filter(x=>x.status==='active'&&periodsOverlap(from,to,x.effectiveFrom,x.effectiveTo));
    if(input.assignmentRole==='primary_owner'&&conflicts.some(x=>x.assignmentRole==='primary_owner'))throw new ResponsibilityError('PRIMARY_OWNER_OVERLAP','主负责人有效期重叠');
    if(input.assignmentRole==='temporary_agent'&&conflicts.some(x=>x.assignmentRole==='temporary_agent'))throw new ResponsibilityError('TEMPORARY_AGENT_OVERLAP','临时代理有效期重叠');
    if(input.assignmentRole==='backup_owner'&&conflicts.some(x=>x.assignmentRole==='backup_owner'&&x.personId===personId))throw new ResponsibilityError('BACKUP_OWNER_OVERLAP','同一备岗有效期重叠');
    const now=this.clock().toISOString();
    return this.repository.createAssignment({id:uuid(input.id??this.createId(),'assignment id'),scopeId,personId,assignmentRole:input.assignmentRole,effectiveFrom:from,effectiveTo:to,status:input.status??'active',createdAt:now,updatedAt:now});
  }

  async resolve(scopeId:string,at=this.clock()):Promise<ResponsibilityResolution>{
    const scope=await this.repository.findScopeById(uuid(scopeId,'scope id'));if(!scope)throw new ResponsibilityError('SCOPE_NOT_FOUND','责任范围不存在');
    const instant=at.toISOString();const active=(await this.repository.listAssignmentsByScope(scope.id)).filter(x=>isEffective(x,instant));
    const primary=active.find(x=>x.assignmentRole==='primary_owner')??null;
    const temporary=active.find(x=>x.assignmentRole==='temporary_agent')??null;
    return{scope,primaryOwner:primary,temporaryAgent:temporary,effectiveHandler:temporary??primary,backupOwners:active.filter(x=>x.assignmentRole==='backup_owner'),resolvedAt:instant};
  }

  async scopeCoversLocation(scopeId:string,locationId:string){
    const scope=await this.repository.findScopeById(uuid(scopeId,'scope id'));if(!scope)throw new ResponsibilityError('SCOPE_NOT_FOUND','责任范围不存在');
    const target=uuid(locationId,'location id');if(!scope.locationId)return false;if(scope.locationId===target)return true;if(!scope.includeDescendants)return false;
    const visited=new Set<string>();let current=await this.options.findLocation(target);
    while(current?.parentId){if(visited.has(current.id))throw new ResponsibilityError('CYCLIC_LOCATION','位置层级存在循环');visited.add(current.id);if(current.parentId===scope.locationId)return true;current=await this.options.findLocation(current.parentId);}
    return false;
  }

  listAreas(){return this.repository.listAreas();} listScopesByOrganization(id:string){return this.repository.listScopesByOrganization(uuid(id,'organization id'));} listAssignmentsByPerson(id:string){return this.repository.listAssignmentsByPerson(uuid(id,'person id'));}

  private async validateTarget(target:ResponsibilityTarget){
    const id=uuid(target.id,'target id');
    if(target.type==='responsibility_area'){const area=await this.repository.findAreaById(id);if(!area)throw new ResponsibilityError('AREA_NOT_FOUND','责任事项不存在');if(area.status!=='active')throw new ResponsibilityError('AREA_INACTIVE','责任事项未启用');return{responsibilityAreaId:id,locationId:null,assetTypeId:null,assetId:null,includeDescendants:false};}
    if(target.type==='location'){const location=await this.options.findLocation(id);if(!location)throw new ResponsibilityError('LOCATION_NOT_FOUND','责任位置不存在');if(location.status!=='active')throw new ResponsibilityError('LOCATION_INACTIVE','责任位置未启用');return{responsibilityAreaId:null,locationId:id,assetTypeId:null,assetId:null,includeDescendants:target.includeDescendants??false};}
    if(target.type==='asset_type'){const type=await this.options.findAssetType(id);if(!type)throw new ResponsibilityError('ASSET_TYPE_NOT_FOUND','责任资产类型不存在');if(type.status!=='active')throw new ResponsibilityError('ASSET_TYPE_INACTIVE','责任资产类型未启用');return{responsibilityAreaId:null,locationId:null,assetTypeId:id,assetId:null,includeDescendants:false};}
    const asset=await this.options.findAsset(id);if(!asset)throw new ResponsibilityError('ASSET_NOT_FOUND','责任资产不存在');if(asset.lifecycleState==='retired')throw new ResponsibilityError('ASSET_RETIRED','退役资产不能新建责任范围');return{responsibilityAreaId:null,locationId:null,assetTypeId:null,assetId:id,includeDescendants:false};
  }
}

export function createResponsibilityService(repository:ResponsibilityRepository,options:ResponsibilityServiceOptions){return new ResponsibilityService(repository,options);}
export function periodsOverlap(aFrom:string,aTo:string|null,bFrom:string,bTo:string|null){return(!aTo||bFrom<aTo)&&(!bTo||aFrom<bTo);}
export function isEffective(a:ResponsibilityAssignment,instant:string){return a.status==='active'&&a.effectiveFrom<=instant&&(!a.effectiveTo||instant<a.effectiveTo);}

export function reconcileLegacyResponsibilities(snapshot:LegacyResponsibilitySnapshot):LegacyResponsibilityReconciliation{
  const orgs=new Set(snapshot.organizationUnitIds),locations=new Set(snapshot.locationIds),people=new Map(snapshot.people.map(x=>[x.id,x])),keys=new Set<string>(),issues=[] as LegacyResponsibilityReconciliation['issues'];
  for(const row of snapshot.rows){if(!orgs.has(row.organizationUnitId))issues.push({code:'MISSING_ORGANIZATION',sourceId:row.id});if(!locations.has(row.locationId))issues.push({code:'MISSING_LOCATION',sourceId:row.id});const person=people.get(row.personId);if(!person)issues.push({code:'MISSING_PERSON',sourceId:row.id});else{if(person.organizationUnitId!==row.organizationUnitId)issues.push({code:'PERSON_ORGANIZATION_MISMATCH',sourceId:row.id});if(person.employmentStatus!=='active')issues.push({code:'PERSON_NOT_ACTIVE',sourceId:row.id});}const key=`${row.organizationUnitId}::${row.locationId}`;if(keys.has(key))issues.push({code:'DUPLICATE_ORGANIZATION_LOCATION',sourceId:row.id});keys.add(key);}
  return{sourceCount:snapshot.rows.length,scopeCount:keys.size,assignmentCount:snapshot.rows.length,preservedAssignmentIds:snapshot.rows.map(x=>x.id),issues};
}
function uuid(value:string,label:string){const v=value.trim().toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v))throw new ResponsibilityError('INVALID_ID',`${label} 必须是 UUID`);return v;}
