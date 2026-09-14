import type { QueryableClient } from '../../core/database/index.js';
import { ResponsibilityError, type ResponsibilityArea, type ResponsibilityAssignment, type ResponsibilityScope } from './model.js';

export interface ResponsibilityRepository {
  findAreaById(id: string): Promise<ResponsibilityArea | null>;
  findAreaByCode(code: string): Promise<ResponsibilityArea | null>;
  listAreas(): Promise<ResponsibilityArea[]>;
  createScope(record: ResponsibilityScope): Promise<ResponsibilityScope>;
  findScopeById(id: string): Promise<ResponsibilityScope | null>;
  findScopeByTarget(record: Omit<ResponsibilityScope, 'id'|'status'|'createdAt'|'updatedAt'>): Promise<ResponsibilityScope | null>;
  listScopesByOrganization(organizationUnitId: string): Promise<ResponsibilityScope[]>;
  listScopesByTarget(target: { responsibilityAreaId?: string; locationId?: string; assetTypeId?: string; assetId?: string }): Promise<ResponsibilityScope[]>;
  createAssignment(record: ResponsibilityAssignment): Promise<ResponsibilityAssignment>;
  listAssignmentsByScope(scopeId: string): Promise<ResponsibilityAssignment[]>;
  listAssignmentsByPerson(personId: string): Promise<ResponsibilityAssignment[]>;
}

export interface MemoryResponsibilityRepository extends ResponsibilityRepository {
  records(): { areas: ResponsibilityArea[]; scopes: ResponsibilityScope[]; assignments: ResponsibilityAssignment[] };
}

export function createMemoryResponsibilityRepository(seed: { areas?: readonly ResponsibilityArea[]; scopes?: readonly ResponsibilityScope[]; assignments?: readonly ResponsibilityAssignment[] } = {}): MemoryResponsibilityRepository {
  const areas = toMap(seed.areas); const scopes = toMap(seed.scopes); const assignments = toMap(seed.assignments);
  return {
    async findAreaById(id) { return cloneOrNull(areas.get(id)); },
    async findAreaByCode(code) { return cloneOrNull([...areas.values()].find((x) => x.code === code)); },
    async listAreas() { return [...areas.values()].map(clone).sort((a,b) => a.name.localeCompare(b.name,'zh-CN')); },
    async createScope(record) {
      if (scopes.has(record.id)) throw new ResponsibilityError('DUPLICATE_SCOPE_ID','责任范围 ID 已存在');
      const duplicate = [...scopes.values()].find((x) => sameTarget(x, record) && x.organizationUnitId === record.organizationUnitId);
      if (duplicate) throw new ResponsibilityError('DUPLICATE_RESPONSIBILITY_SCOPE','组织责任范围已存在');
      scopes.set(record.id, clone(record)); return clone(record);
    },
    async findScopeById(id) { return cloneOrNull(scopes.get(id)); },
    async findScopeByTarget(record) { return cloneOrNull([...scopes.values()].find((x) => x.organizationUnitId === record.organizationUnitId && sameTarget(x, record))); },
    async listScopesByOrganization(id) { return [...scopes.values()].filter((x) => x.organizationUnitId === id).map(clone); },
    async listScopesByTarget(target) { return [...scopes.values()].filter((x) => targetMatches(x,target)).map(clone); },
    async createAssignment(record) { if (assignments.has(record.id)) throw new ResponsibilityError('DUPLICATE_ASSIGNMENT_ID','责任分配 ID 已存在'); assignments.set(record.id,clone(record)); return clone(record); },
    async listAssignmentsByScope(id) { return [...assignments.values()].filter((x) => x.scopeId === id).map(clone).sort(compareAssignments); },
    async listAssignmentsByPerson(id) { return [...assignments.values()].filter((x) => x.personId === id).map(clone).sort(compareAssignments); },
    records() { return { areas:[...areas.values()].map(clone), scopes:[...scopes.values()].map(clone), assignments:[...assignments.values()].map(clone) }; }
  };
}

export function createPostgresResponsibilityRepository(client: QueryableClient): ResponsibilityRepository {
  return {
    async findAreaById(id) { return optional(await client.query('SELECT * FROM platform_responsibility_areas WHERE id=$1',[id]), mapArea); },
    async findAreaByCode(code) { return optional(await client.query('SELECT * FROM platform_responsibility_areas WHERE code=$1',[code]), mapArea); },
    async listAreas() { return rows(await client.query('SELECT * FROM platform_responsibility_areas ORDER BY name,id')).map(mapArea); },
    async createScope(r) {
      return mapScope(requireRow(await client.query(
        `INSERT INTO platform_responsibility_scopes
         (id,organization_unit_id,responsibility_area_id,location_id,asset_type_id,asset_id,include_descendants,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [r.id,r.organizationUnitId,r.responsibilityAreaId,r.locationId,r.assetTypeId,r.assetId,r.includeDescendants,r.status,r.createdAt,r.updatedAt]
      )));
    },
    async findScopeById(id) { return optional(await client.query('SELECT * FROM platform_responsibility_scopes WHERE id=$1',[id]),mapScope); },
    async findScopeByTarget(r) {
      return optional(await client.query(
        `SELECT * FROM platform_responsibility_scopes WHERE organization_unit_id=$1
         AND responsibility_area_id IS NOT DISTINCT FROM $2 AND location_id IS NOT DISTINCT FROM $3
         AND asset_type_id IS NOT DISTINCT FROM $4 AND asset_id IS NOT DISTINCT FROM $5 AND include_descendants=$6`,
        [r.organizationUnitId,r.responsibilityAreaId,r.locationId,r.assetTypeId,r.assetId,r.includeDescendants]
      ),mapScope);
    },
    async listScopesByOrganization(id) { return rows(await client.query('SELECT * FROM platform_responsibility_scopes WHERE organization_unit_id=$1 ORDER BY created_at,id',[id])).map(mapScope); },
    async listScopesByTarget(t) {
      return rows(await client.query(
        `SELECT * FROM platform_responsibility_scopes WHERE
         ($1::uuid IS NOT NULL AND responsibility_area_id=$1) OR ($2::uuid IS NOT NULL AND location_id=$2)
         OR ($3::uuid IS NOT NULL AND asset_type_id=$3) OR ($4::uuid IS NOT NULL AND asset_id=$4)`,
        [t.responsibilityAreaId??null,t.locationId??null,t.assetTypeId??null,t.assetId??null]
      )).map(mapScope);
    },
    async createAssignment(r) {
      return mapAssignment(requireRow(await client.query(
        `INSERT INTO platform_responsibility_assignments
         (id,scope_id,person_id,assignment_role,effective_from,effective_to,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [r.id,r.scopeId,r.personId,r.assignmentRole,r.effectiveFrom,r.effectiveTo,r.status,r.createdAt,r.updatedAt]
      )));
    },
    async listAssignmentsByScope(id) { return rows(await client.query('SELECT * FROM platform_responsibility_assignments WHERE scope_id=$1 ORDER BY effective_from,id',[id])).map(mapAssignment); },
    async listAssignmentsByPerson(id) { return rows(await client.query('SELECT * FROM platform_responsibility_assignments WHERE person_id=$1 ORDER BY effective_from,id',[id])).map(mapAssignment); }
  };
}

function sameTarget(a: Pick<ResponsibilityScope,'responsibilityAreaId'|'locationId'|'assetTypeId'|'assetId'|'includeDescendants'>,b: typeof a) { return a.responsibilityAreaId===b.responsibilityAreaId&&a.locationId===b.locationId&&a.assetTypeId===b.assetTypeId&&a.assetId===b.assetId&&a.includeDescendants===b.includeDescendants; }
function targetMatches(s: ResponsibilityScope,t:{responsibilityAreaId?:string;locationId?:string;assetTypeId?:string;assetId?:string}) { return (!!t.responsibilityAreaId&&s.responsibilityAreaId===t.responsibilityAreaId)||(!!t.locationId&&s.locationId===t.locationId)||(!!t.assetTypeId&&s.assetTypeId===t.assetTypeId)||(!!t.assetId&&s.assetId===t.assetId); }
function compareAssignments(a:ResponsibilityAssignment,b:ResponsibilityAssignment){return a.effectiveFrom.localeCompare(b.effectiveFrom)||a.id.localeCompare(b.id);}
function mapArea(row:unknown):ResponsibilityArea{const v=record(row);return{id:str(v.id),code:str(v.code),name:str(v.name),description:opt(v.description),status:str(v.status)as ResponsibilityArea['status'],createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};}
function mapScope(row:unknown):ResponsibilityScope{const v=record(row);return{id:str(v.id),organizationUnitId:str(v.organization_unit_id),responsibilityAreaId:opt(v.responsibility_area_id),locationId:opt(v.location_id),assetTypeId:opt(v.asset_type_id),assetId:opt(v.asset_id),includeDescendants:Boolean(v.include_descendants),status:str(v.status)as ResponsibilityScope['status'],createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};}
function mapAssignment(row:unknown):ResponsibilityAssignment{const v=record(row);return{id:str(v.id),scopeId:str(v.scope_id),personId:str(v.person_id),assignmentRole:str(v.assignment_role)as ResponsibilityAssignment['assignmentRole'],effectiveFrom:iso(v.effective_from),effectiveTo:v.effective_to==null?null:iso(v.effective_to),status:str(v.status)as ResponsibilityAssignment['status'],createdAt:iso(v.created_at),updatedAt:iso(v.updated_at)};}
function rows(r:unknown):unknown[]{return r&&typeof r==='object'&&'rows'in r&&Array.isArray(r.rows)?r.rows:[];}
function requireRow(r:unknown){const x=rows(r)[0];if(!x)throw new ResponsibilityError('INSERT_FAILED','责任域写入未返回记录');return x;}
function optional<T>(r:unknown,m:(x:unknown)=>T){const x=rows(r)[0];return x?m(x):null;}
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object')throw new ResponsibilityError('INVALID_DATABASE_ROW','责任域数据库返回无效');return v as Record<string,unknown>;}
function str(v:unknown){if(typeof v!=='string'||!v)throw new ResponsibilityError('INVALID_DATABASE_ROW','责任域字段缺失');return v;}
function opt(v:unknown){return typeof v==='string'&&v?v:null;}
function iso(v:unknown){if(v instanceof Date)return v.toISOString();if(typeof v==='string'&&!Number.isNaN(new Date(v).getTime()))return new Date(v).toISOString();throw new ResponsibilityError('INVALID_DATABASE_ROW','责任域时间无效');}
function toMap<T extends{id:string}>(v:readonly T[]|undefined){return new Map((v??[]).map(x=>[x.id,clone(x)]));}
function clone<T>(v:T):T{return structuredClone(v);}
function cloneOrNull<T>(v:T|undefined){return v===undefined?null:clone(v);}
