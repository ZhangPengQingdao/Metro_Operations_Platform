import {randomUUID} from 'node:crypto';
import { z } from 'zod';
import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import { createPeopleDirectoryService, createPostgresPeopleDirectoryRepository, ORGANIZATION_UNIT_TYPES, PeopleDirectoryError } from '../../platform/people/index.js';
import { createLocationDirectoryService, createPostgresLocationDirectoryRepository, LOCATION_TYPES } from '../../platform/locations/index.js';
import { createAssetDirectoryService, createPostgresAssetDirectoryRepository, ASSET_LIFECYCLE_STATES, ASSET_DATA_QUALITY_STATUSES } from '../../platform/assets/index.js';
import { createPostgresDataAlignmentRepository } from '../../platform/data-alignment/index.js';

export interface AdminDataActor { id: string; username: string; displayName: string }
export interface AdminDataField { key: string; label: string; type: 'text' | 'number' | 'select' | 'reference'; required: boolean; options?: string[]; resource?: string }
export interface AdminDataResource { key: string; label: string; fields: AdminDataField[]; columns: string[]; updateFields: string[]; writable: boolean; reason?: string }
export class AdminDataError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}
const text = z.string().trim().min(1).max(200);
const optional = z.string().trim().max(1000).nullable().optional();
const uuid = z.string().uuid();
const state = z.enum(['active', 'inactive']).optional();
const classification = { code: text, name: text, description: optional, status: state };
const schemas = {
  organizations: z.object({ code: text, name: text, shortName: optional, unitType: z.enum(ORGANIZATION_UNIT_TYPES), parentId: uuid.nullable().optional(), status: state }).strict(),
  positions: z.object(classification).strict(),
  people: z.object({ employeeNo: text, name: text, organizationUnitId: uuid, positionId: uuid }).strict(),
  lines: z.object({ code: text, name: text, shortName: optional, status: state }).strict(),
  locations: z.object({ code: text, name: text, shortName: optional, parentId: uuid.nullable().optional(), organizationUnitId: uuid.nullable().optional(), locationType: z.enum(LOCATION_TYPES), status: state }).strict(),
  'asset-systems': z.object(classification).strict(),
  'asset-categories': z.object({ ...classification, systemId: uuid }).strict(),
  'asset-types': z.object({ ...classification, systemId: uuid, categoryId: uuid.nullable().optional() }).strict(),
  assets: z.object({ systemId: uuid, categoryId: uuid.nullable().optional(), typeId: uuid, locationId: uuid, displayName: text, assetCode: optional, lifecycleState: z.enum(ASSET_LIFECYCLE_STATES).optional(), dataQualityStatus: z.enum(ASSET_DATA_QUALITY_STATUSES).optional(), remark: optional }).strict(),
};
const detail = z.object({ name: text.optional(), description: optional, status: state }).strict();
const named = z.object({ name: text.optional(), shortName: optional, status: state }).strict();
const updates = { organizations: named, positions: detail, people: z.object({ organizationUnitId: uuid.optional(), positionId: uuid.optional() }).strict(), lines: named, locations: named, 'asset-systems': detail, 'asset-categories': detail, 'asset-types': detail, assets: z.object({ locationId: uuid.optional(), lifecycleState: z.enum(ASSET_LIFECYCLE_STATES).optional(), dataQualityStatus: z.enum(ASSET_DATA_QUALITY_STATUSES).optional() }).strict() };
type WritableResource = keyof typeof schemas;
const codePrefixes:Partial<Record<WritableResource,string>>={organizations:'org',positions:'pos',lines:'line',locations:'loc','asset-systems':'sys','asset-categories':'cat','asset-types':'type',assets:'asset'};
const generatedField=(key:string)=>key==='assets'?'assetCode':'code';
const labels: Record<string,string> = { organizations:'组织与工班', positions:'岗位', people:'人员', lines:'线路', locations:'车站与位置', 'asset-systems':'设备系统', 'asset-categories':'设备分类', 'asset-types':'设备类型', assets:'设备', dictionaries:'公共字典', code:'编码', name:'名称', shortName:'简称', description:'说明', unitType:'组织类型', parentId:'上级', status:'状态', employeeNo:'工号', phone:'电话', organizationUnitId:'所属组织', positionId:'岗位', employmentStatus:'任职状态', locationType:'位置类型', systemId:'设备系统', categoryId:'设备分类', typeId:'设备类型', locationId:'所在位置', displayName:'设备名称', assetCode:'资产编码', lifecycleState:'生命周期', dataQualityStatus:'数据质量', remark:'备注' };
const references: Record<string,string> = { organizationUnitId:'organizations', positionId:'positions', systemId:'asset-systems', categoryId:'asset-categories', typeId:'asset-types', locationId:'locations' };
export function adminDataResources(): AdminDataResource[] {
  const descriptors = Object.entries(schemas).map(([key,schema]) => ({
    key, label: labels[key], writable: true, updateFields: Object.keys(updates[key as WritableResource].shape),
    columns: key === 'people' ? ['name','organizationUnitId','positionId'] : key === 'positions' ? ['name','description','status'] : Object.keys(schema.shape).filter(field => !['code','assetCode'].includes(field)),
    fields: Object.entries(schema.shape).filter(([field])=>!codePrefixes[key as WritableResource]||field!==generatedField(key)).map(([field, validator]): AdminDataField => {
      let inner: z.ZodTypeAny = validator;
      while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap();
      const resource = field === 'parentId' ? key : references[field];
      return { key: field, label: key==='people'&&field==='name'?'姓名':labels[field] ?? field, type: resource ? 'reference' : inner instanceof z.ZodEnum ? 'select' : 'text', required: !validator.isOptional(), ...(resource ? {resource} : {}), ...(inner instanceof z.ZodEnum ? {options: inner.options as string[]} : {}) };
    })
  }));
  return [...descriptors, { key:'dictionaries', label:'公共字典', writable:false, fields:[], updateFields:[], columns:['name','version','status'], reason:'公共字典的发布记录仍使用员工身份；独立管理员写入契约尚未接入。' }];
}

/** Only trusted administrator sessions may be supplied by the HTTP composition layer. */
export function createAdminDataService(client: QueryableClient, options: { audit(event: {actorId:string; action:string; targetId:string}): Promise<void> }) {
  const peopleRepo = createPostgresPeopleDirectoryRepository(client);
  const locationRepo = createPostgresLocationDirectoryRepository(client);
  const people = createPeopleDirectoryService(peopleRepo);
  const locations = createLocationDirectoryService(locationRepo, {findOrganizationUnit: id => peopleRepo.findOrganizationUnitById(id)});
  const assets = createAssetDirectoryService(createPostgresAssetDirectoryRepository(client), {findLocation: id => locationRepo.findLocationById(id)});
  function authorize(actor: AdminDataActor) {
    if (!actor?.id || !actor.username || !actor.displayName) throw new AdminDataError('ADMIN_REQUIRED','需要管理员身份',401);
  }
  function writable(resource: string): WritableResource {
    if (!Object.hasOwn(schemas, resource)) throw new AdminDataError('RESOURCE_NOT_WRITABLE','该目录不支持写入',400);
    return resource as WritableResource;
  }
  async function mutate(actor: AdminDataActor, resource: string, action: string, operation: () => Promise<{id:string}>) {
    authorize(actor);
    return runDatabaseTransaction(client, async () => {
      const result = await operation();
      await options.audit({actorId:actor.id, action:`data.${resource}.${action}`, targetId:result.id});
      return result;
    });
  }
  return {
    resources: adminDataResources,
    async list(actor: AdminDataActor, resource: string, query = '', filter = '') {
      authorize(actor);
      if (query.length > 200) throw new AdminDataError('INVALID_QUERY','搜索词过长');
      const descriptor=adminDataResources().find(item=>item.key===resource);
      const statusField=descriptor?.fields.find(field=>['status','employmentStatus','lifecycleState'].includes(field.key));
      if(filter&&!(resource==='people'?['active','inactive','departed']:statusField?.options??[]).includes(filter))throw new AdminDataError('INVALID_FILTER','筛选条件无效');
      const filtered=<T extends object>(rows:T[])=>rows.filter(row=>{const values=row as Record<string,unknown>;return (!filter||values[statusField!.key]===filter)&&(!query||['name','code','dictionaryKey'].some(key=>String(values[key]??'').toLowerCase().includes(query.toLowerCase())));});
      switch(resource) {
        case 'people': return (await people.searchPeople({query,limit:100,employmentStatus:filter as 'active'|'inactive'|'departed'||undefined})).map(item => ({...item.person, organizationUnitName:item.organizationUnit.name, positionName:item.position.name}));
        case 'locations': return (await locations.searchLocations({query,limit:100,status:filter as 'active'|'inactive'||undefined})).map(item => item.location);
        case 'assets': return (await assets.searchAssets({query,limit:100,lifecycleState:filter as typeof ASSET_LIFECYCLE_STATES[number]||undefined})).map(item => item.asset);
        case 'organizations': return filtered(await peopleRepo.listOrganizationUnits());
        case 'positions': return filtered(await people.listPositions());
        case 'lines': return filtered(await locations.listLines());
        case 'asset-systems': return filtered(await assets.listSystems());
        case 'asset-categories': return filtered(await assets.listCategories());
        case 'asset-types': return filtered(await assets.listTypes());
        case 'dictionaries': return filtered(await createPostgresDataAlignmentRepository(client).listDictionaryVersions(undefined,{limit:100}));
        default: throw new AdminDataError('RESOURCE_NOT_FOUND','目录不存在',404);
      }
    },
    async create(actor: AdminDataActor, resource: string, input: unknown) {
      authorize(actor); const key=writable(resource);
      const field=generatedField(key);
      const prefix=codePrefixes[key];
      if(prefix){
        if(!input||typeof input!=='object'||Array.isArray(input))throw new AdminDataError('INVALID_INPUT','请检查填写内容');
        if(Object.hasOwn(input,field))throw new AdminDataError('CODE_MANAGED_BY_SYSTEM','编码由系统自动生成');
        input={...input,[field]:`${prefix}-${randomUUID().replaceAll('-','')}`};
      }
      return mutate(actor,resource,'create',async () => {
        switch(resource) {
          case 'organizations': { const value=schemas.organizations.parse(input); return people.createOrganizationUnit({...value,code:value.code!,name:value.name!,unitType:value.unitType!}); }
          case 'positions': { const value=schemas.positions.parse(input); return people.createPosition({...value,code:value.code!,name:value.name!}); }
          case 'people': { const value=schemas.people.parse(input); return people.createPerson({...value,employeeNo:value.employeeNo!,name:value.name!,organizationUnitId:value.organizationUnitId!,positionId:value.positionId!}); }
          case 'lines': { const value=schemas.lines.parse(input); return locations.createLine({...value,code:value.code!,name:value.name!}); }
          case 'locations': { const value=schemas.locations.parse(input); return locations.createLocation({...value,code:value.code!,name:value.name!,locationType:value.locationType!}); }
          case 'asset-systems': { const value=schemas['asset-systems'].parse(input); return assets.createSystem({...value,code:value.code!,name:value.name!}); }
          case 'asset-categories': { const value=schemas['asset-categories'].parse(input); return assets.createCategory({...value,code:value.code!,name:value.name!,systemId:value.systemId!}); }
          case 'asset-types': { const value=schemas['asset-types'].parse(input); return assets.createType({...value,code:value.code!,name:value.name!,systemId:value.systemId!}); }
          case 'assets': { const value=schemas.assets.parse(input); return assets.createAsset({...value,systemId:value.systemId!,typeId:value.typeId!,locationId:value.locationId!,displayName:value.displayName!}); }
          default: throw new AdminDataError('RESOURCE_NOT_FOUND','目录不存在',404);
        }
      });
    },
    async update(actor: AdminDataActor, resource: string, id: string, input: unknown) {
      authorize(actor); const key = writable(resource); uuid.parse(id);
      const parsed = updates[key].parse(input);
      if (!Object.keys(parsed).length) throw new AdminDataError('EMPTY_UPDATE','请填写更新字段');
      return mutate(actor,resource,'update',async () => {
        switch(resource) {
          case 'organizations': return people.updateOrganizationUnitDetails(id,updates.organizations.parse(input));
          case 'positions': return people.updatePositionDetails(id,updates.positions.parse(input));
          case 'people': { try { return await people.updatePersonDetails(id,updates.people.parse(input)); } catch(error) { if(error instanceof PeopleDirectoryError) throw new AdminDataError(error.code,error.message); throw error; } }
          case 'lines': return locations.updateLineDetails(id,updates.lines.parse(input));
          case 'locations': return locations.updateLocationDetails(id,updates.locations.parse(input));
          case 'asset-systems': return assets.updateSystemDetails(id,updates['asset-systems'].parse(input));
          case 'asset-categories': return assets.updateCategoryDetails(id,updates['asset-categories'].parse(input));
          case 'asset-types': return assets.updateTypeDetails(id,updates['asset-types'].parse(input));
          case 'assets': {
            const patch = updates.assets.parse(input);
            if(patch.locationId) await assets.relocateAsset(id,patch.locationId);
            if(patch.lifecycleState) await assets.setLifecycleState(id,patch.lifecycleState);
            if(patch.dataQualityStatus) await assets.setDataQualityStatus(id,patch.dataQualityStatus);
            const result = await assets.getAssetProfile(id);
            if (!result) throw new AdminDataError('RECORD_NOT_FOUND','设备不存在',404);
            return result.asset;
          }
          default: throw new AdminDataError('RESOURCE_NOT_FOUND','目录不存在',404);
        }
      });
    }
  };
}
