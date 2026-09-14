import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import {
  AuthorizationError,
  type DataScope,
  type Permission,
  type PersonRoleAssignment,
  type Role,
  type RolePermission,
  type RolePermissionTarget
} from './model.js';

export interface AuthorizationRepository {
  createRole(record: Role): Promise<Role>;
  updateRole(record: Role): Promise<Role>;
  findRoleById(id: string): Promise<Role | null>;
  findRoleByCode(code: string): Promise<Role | null>;
  listRoles(): Promise<Role[]>;
  createPermission(record: Permission): Promise<Permission>;
  findPermissionById(id: string): Promise<Permission | null>;
  findPermissionByCode(code: string): Promise<Permission | null>;
  listPermissions(): Promise<Permission[]>;
  saveRolePermission(record: RolePermission, targets: readonly RolePermissionTarget[]): Promise<RolePermission>;
  removeRolePermission(roleId: string, permissionId: string): Promise<void>;
  findRolePermission(roleId: string, permissionId: string): Promise<{ grant: RolePermission; scope: DataScope } | null>;
  listRolePermissions(roleId: string): Promise<Array<{ grant: RolePermission; scope: DataScope }>>;
  createPersonRoleAssignment(record: PersonRoleAssignment): Promise<PersonRoleAssignment>;
  replaceCurrentPersonRole(record: PersonRoleAssignment): Promise<PersonRoleAssignment>;
  findCurrentPersonRole(personId: string): Promise<PersonRoleAssignment | null>;
  listPersonRoleAssignments(personId: string): Promise<PersonRoleAssignment[]>;
}

export interface MemoryAuthorizationRepository extends AuthorizationRepository {
  records(): {
    roles: Role[];
    permissions: Permission[];
    rolePermissions: RolePermission[];
    rolePermissionTargets: RolePermissionTarget[];
    personRoleAssignments: PersonRoleAssignment[];
  };
}

export function createMemoryAuthorizationRepository(seed: {
  roles?: readonly Role[];
  permissions?: readonly Permission[];
  rolePermissions?: readonly RolePermission[];
  rolePermissionTargets?: readonly RolePermissionTarget[];
  personRoleAssignments?: readonly PersonRoleAssignment[];
} = {}): MemoryAuthorizationRepository {
  const roles = toMap(seed.roles);
  const permissions = toMap(seed.permissions);
  const rolePermissions = new Map((seed.rolePermissions ?? []).map((record) => [grantKey(record.roleId, record.permissionId), clone(record)]));
  let rolePermissionTargets = (seed.rolePermissionTargets ?? []).map(clone);
  const assignments = toMap(seed.personRoleAssignments);

  return {
    async createRole(record) {
      if (roles.has(record.id) || [...roles.values()].some((role) => role.code === record.code)) {
        throw new AuthorizationError('DUPLICATE_ROLE', '角色 ID 或编码已存在');
      }
      roles.set(record.id, clone(record));
      return clone(record);
    },
    async updateRole(record) {
      if (!roles.has(record.id)) throw new AuthorizationError('ROLE_NOT_FOUND', '角色不存在');
      roles.set(record.id, clone(record));
      return clone(record);
    },
    async findRoleById(id) { return cloneOrNull(roles.get(id)); },
    async findRoleByCode(code) { return cloneOrNull([...roles.values()].find((role) => role.code === code)); },
    async listRoles() { return [...roles.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); },
    async createPermission(record) {
      if (permissions.has(record.id) || [...permissions.values()].some((permission) => permission.code === record.code)) {
        throw new AuthorizationError('DUPLICATE_PERMISSION', '权限 ID 或编码已存在');
      }
      permissions.set(record.id, clone(record));
      return clone(record);
    },
    async findPermissionById(id) { return cloneOrNull(permissions.get(id)); },
    async findPermissionByCode(code) { return cloneOrNull([...permissions.values()].find((permission) => permission.code === code)); },
    async listPermissions() { return [...permissions.values()].map(clone).sort((a, b) => a.code.localeCompare(b.code)); },
    async saveRolePermission(record, targets) {
      rolePermissions.set(grantKey(record.roleId, record.permissionId), clone(record));
      rolePermissionTargets = rolePermissionTargets.filter((target) => target.roleId !== record.roleId || target.permissionId !== record.permissionId);
      rolePermissionTargets.push(...targets.map(clone));
      return clone(record);
    },
    async removeRolePermission(roleId, permissionId) {
      rolePermissions.delete(grantKey(roleId, permissionId));
      rolePermissionTargets = rolePermissionTargets.filter((target) => target.roleId !== roleId || target.permissionId !== permissionId);
    },
    async findRolePermission(roleId, permissionId) {
      const grant = rolePermissions.get(grantKey(roleId, permissionId));
      return grant ? { grant: clone(grant), scope: scopeFor(grant, rolePermissionTargets) } : null;
    },
    async listRolePermissions(roleId) {
      return [...rolePermissions.values()].filter((grant) => grant.roleId === roleId).map((grant) => ({ grant: clone(grant), scope: scopeFor(grant, rolePermissionTargets) }));
    },
    async createPersonRoleAssignment(record) {
      if (assignments.has(record.id)) throw new AuthorizationError('DUPLICATE_ASSIGNMENT_ID', '角色分配 ID 已存在');
      if ([...assignments.values()].some((assignment) => assignment.personId === record.personId && assignment.effectiveTo === null)) {
        throw new AuthorizationError('PERSON_ROLE_ALREADY_ASSIGNED', '人员已有生效角色');
      }
      assignments.set(record.id, clone(record));
      return clone(record);
    },
    async replaceCurrentPersonRole(record) {
      if (assignments.has(record.id)) throw new AuthorizationError('DUPLICATE_ASSIGNMENT_ID', '角色分配 ID 已存在');
      for (const assignment of assignments.values()) {
        if (assignment.personId === record.personId && assignment.effectiveTo === null) {
          assignment.effectiveTo = record.effectiveFrom;
          assignment.updatedAt = record.updatedAt;
        }
      }
      assignments.set(record.id, clone(record));
      return clone(record);
    },
    async findCurrentPersonRole(personId) {
      return cloneOrNull([...assignments.values()].find((assignment) => assignment.personId === personId && assignment.effectiveTo === null));
    },
    async listPersonRoleAssignments(personId) {
      return [...assignments.values()].filter((assignment) => assignment.personId === personId).map(clone).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    },
    records() {
      return {
        roles: [...roles.values()].map(clone),
        permissions: [...permissions.values()].map(clone),
        rolePermissions: [...rolePermissions.values()].map(clone),
        rolePermissionTargets: rolePermissionTargets.map(clone),
        personRoleAssignments: [...assignments.values()].map(clone)
      };
    }
  };
}

export function createPostgresAuthorizationRepository(client: QueryableClient): AuthorizationRepository {
  return {
    async createRole(record) {
      return mapRole(requireRow(await client.query(
        `INSERT INTO platform_roles (id,code,name,description,status,built_in,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [record.id,record.code,record.name,record.description,record.status,record.builtIn,record.createdAt,record.updatedAt]
      )));
    },
    async updateRole(record) {
      return mapRole(requireRow(await client.query(
        `UPDATE platform_roles SET name=$2,description=$3,status=$4,updated_at=$5 WHERE id=$1 RETURNING *`,
        [record.id,record.name,record.description,record.status,record.updatedAt]
      )));
    },
    async findRoleById(id) { return optional(await client.query('SELECT * FROM platform_roles WHERE id=$1', [id]), mapRole); },
    async findRoleByCode(code) { return optional(await client.query('SELECT * FROM platform_roles WHERE code=$1', [code]), mapRole); },
    async listRoles() { return rows(await client.query('SELECT * FROM platform_roles ORDER BY name,id')).map(mapRole); },
    async createPermission(record) {
      return mapPermission(requireRow(await client.query(
        `INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [record.id,record.code,record.name,record.description,record.status,record.createdAt,record.updatedAt]
      )));
    },
    async findPermissionById(id) { return optional(await client.query('SELECT * FROM platform_permissions WHERE id=$1', [id]), mapPermission); },
    async findPermissionByCode(code) { return optional(await client.query('SELECT * FROM platform_permissions WHERE code=$1', [code]), mapPermission); },
    async listPermissions() { return rows(await client.query('SELECT * FROM platform_permissions ORDER BY code,id')).map(mapPermission); },
    async saveRolePermission(record, targets) {
      return runDatabaseTransaction(client, async (transaction) => {
        const saved = mapRolePermission(requireRow(await transaction.query(
          `INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (role_id,permission_id) DO UPDATE SET scope_kind=EXCLUDED.scope_kind,updated_at=EXCLUDED.updated_at
           RETURNING *`,
          [record.roleId,record.permissionId,record.scopeKind,record.createdAt,record.updatedAt]
        )));
        await transaction.query('DELETE FROM platform_role_permission_targets WHERE role_id=$1 AND permission_id=$2', [record.roleId,record.permissionId]);
        for (const target of targets) {
          await transaction.query(
            `INSERT INTO platform_role_permission_targets (role_id,permission_id,target_type,target_id)
             VALUES ($1,$2,$3,$4)`,
            [target.roleId,target.permissionId,target.type,target.id]
          );
        }
        return saved;
      });
    },
    async removeRolePermission(roleId, permissionId) {
      await client.query('DELETE FROM platform_role_permissions WHERE role_id=$1 AND permission_id=$2', [roleId,permissionId]);
    },
    async findRolePermission(roleId, permissionId) {
      const grant = optional(await client.query('SELECT * FROM platform_role_permissions WHERE role_id=$1 AND permission_id=$2', [roleId,permissionId]), mapRolePermission);
      if (!grant) return null;
      const targets = rows(await client.query('SELECT * FROM platform_role_permission_targets WHERE role_id=$1 AND permission_id=$2 ORDER BY target_type,target_id', [roleId,permissionId])).map(mapRolePermissionTarget);
      return { grant, scope: { kind: grant.scopeKind, targets: targets.map(({ type, id }) => ({ type, id })) } };
    },
    async listRolePermissions(roleId) {
      const grants = rows(await client.query('SELECT * FROM platform_role_permissions WHERE role_id=$1 ORDER BY permission_id', [roleId])).map(mapRolePermission);
      const result = [];
      for (const grant of grants) {
        const targets = rows(await client.query('SELECT * FROM platform_role_permission_targets WHERE role_id=$1 AND permission_id=$2 ORDER BY target_type,target_id', [roleId,grant.permissionId])).map(mapRolePermissionTarget);
        result.push({ grant, scope: { kind: grant.scopeKind, targets: targets.map(({ type, id }) => ({ type, id })) } as DataScope });
      }
      return result;
    },
    async createPersonRoleAssignment(record) {
      return mapPersonRoleAssignment(requireRow(await client.query(
        `INSERT INTO platform_person_role_assignments
         (id,person_id,role_id,effective_from,effective_to,assigned_by_person_id,reason,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [record.id,record.personId,record.roleId,record.effectiveFrom,record.effectiveTo,record.assignedByPersonId,record.reason,record.createdAt,record.updatedAt]
      )));
    },
    async replaceCurrentPersonRole(record) {
      return runDatabaseTransaction(client, async (transaction) => {
        await transaction.query(
          `UPDATE platform_person_role_assignments SET effective_to=$2,updated_at=$3
           WHERE person_id=$1 AND effective_to IS NULL`,
          [record.personId,record.effectiveFrom,record.updatedAt]
        );
        return mapPersonRoleAssignment(requireRow(await transaction.query(
          `INSERT INTO platform_person_role_assignments
           (id,person_id,role_id,effective_from,effective_to,assigned_by_person_id,reason,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [record.id,record.personId,record.roleId,record.effectiveFrom,record.effectiveTo,record.assignedByPersonId,record.reason,record.createdAt,record.updatedAt]
        )));
      });
    },
    async findCurrentPersonRole(personId) {
      return optional(await client.query('SELECT * FROM platform_person_role_assignments WHERE person_id=$1 AND effective_to IS NULL', [personId]), mapPersonRoleAssignment);
    },
    async listPersonRoleAssignments(personId) {
      return rows(await client.query('SELECT * FROM platform_person_role_assignments WHERE person_id=$1 ORDER BY effective_from,id', [personId])).map(mapPersonRoleAssignment);
    }
  };
}

function grantKey(roleId: string, permissionId: string) { return `${roleId}:${permissionId}`; }
function scopeFor(grant: RolePermission, targets: readonly RolePermissionTarget[]): DataScope {
  return { kind: grant.scopeKind, targets: targets.filter((target) => target.roleId === grant.roleId && target.permissionId === grant.permissionId).map(({ type, id }) => ({ type, id })) };
}
function toMap<T extends { id: string }>(records: readonly T[] = []) { return new Map(records.map((record) => [record.id, clone(record)])); }
function clone<T>(value: T): T { return structuredClone(value); }
function cloneOrNull<T>(value: T | undefined): T | null { return value ? clone(value) : null; }
function rows(result: unknown): Record<string, unknown>[] { return Array.isArray((result as { rows?: unknown[] })?.rows) ? (result as { rows: Record<string, unknown>[] }).rows : []; }
function requireRow(result: unknown) { const row = rows(result)[0]; if (!row) throw new AuthorizationError('DATABASE_WRITE_FAILED', '授权数据写入失败'); return row; }
function optional<T>(result: unknown, mapper: (row: Record<string, unknown>) => T): T | null { const row = rows(result)[0]; return row ? mapper(row) : null; }
function text(row: Record<string, unknown>, key: string) { const value = row[key]; if (typeof value !== 'string') throw new AuthorizationError('INVALID_DATABASE_ROW', `字段 ${key} 无效`); return value; }
function nullableText(row: Record<string, unknown>, key: string) { const value = row[key]; return value == null ? null : text(row,key); }
function bool(row: Record<string, unknown>, key: string) { const value = row[key]; if (typeof value !== 'boolean') throw new AuthorizationError('INVALID_DATABASE_ROW', `字段 ${key} 无效`); return value; }
function instant(row: Record<string, unknown>, key: string) { const value = row[key]; if (value instanceof Date) return value.toISOString(); return text(row,key); }
function nullableInstant(row: Record<string, unknown>, key: string) { const value = row[key]; if (value == null) return null; return value instanceof Date ? value.toISOString() : text(row,key); }
function mapRole(row: Record<string, unknown>): Role { return { id:text(row,'id'),code:text(row,'code'),name:text(row,'name'),description:nullableText(row,'description'),status:text(row,'status') as Role['status'],builtIn:bool(row,'built_in'),createdAt:instant(row,'created_at'),updatedAt:instant(row,'updated_at') }; }
function mapPermission(row: Record<string, unknown>): Permission { return { id:text(row,'id'),code:text(row,'code'),name:text(row,'name'),description:nullableText(row,'description'),status:text(row,'status') as Permission['status'],createdAt:instant(row,'created_at'),updatedAt:instant(row,'updated_at') }; }
function mapRolePermission(row: Record<string, unknown>): RolePermission { return { roleId:text(row,'role_id'),permissionId:text(row,'permission_id'),scopeKind:text(row,'scope_kind') as RolePermission['scopeKind'],createdAt:instant(row,'created_at'),updatedAt:instant(row,'updated_at') }; }
function mapRolePermissionTarget(row: Record<string, unknown>): RolePermissionTarget { return { roleId:text(row,'role_id'),permissionId:text(row,'permission_id'),type:text(row,'target_type') as RolePermissionTarget['type'],id:text(row,'target_id') }; }
function mapPersonRoleAssignment(row: Record<string, unknown>): PersonRoleAssignment { return { id:text(row,'id'),personId:text(row,'person_id'),roleId:text(row,'role_id'),effectiveFrom:instant(row,'effective_from'),effectiveTo:nullableInstant(row,'effective_to'),assignedByPersonId:nullableText(row,'assigned_by_person_id'),reason:nullableText(row,'reason'),createdAt:instant(row,'created_at'),updatedAt:instant(row,'updated_at') }; }
