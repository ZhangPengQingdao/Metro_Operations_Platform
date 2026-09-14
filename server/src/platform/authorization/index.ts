import { randomUUID } from 'node:crypto';
import {
  AUTHORIZATION_PERMISSION_SEEDS,
  AUTHORIZATION_ROLE_SEEDS,
  AuthorizationError,
  type AppPermissionGrant,
  type AssignPersonRoleInput,
  type AuthorizationDecision,
  type AuthorizationReasonCode,
  type AuthorizationRequest,
  type AuthorizationResource,
  type AuthorizationSubject,
  type CreateRoleInput,
  type DataScope,
  type DataScopeResolvers,
  type DataScopeTarget,
  type EffectiveDataScopeClause,
  type GrantRolePermissionInput,
  type LegacyRoleReconciliation,
  type LegacyRoleSnapshot,
  type Permission,
  type PersonRoleAssignment,
  type RegisterPermissionInput,
  type Role,
  type RolePermission,
  type UpdateRoleInput
} from './model.js';
import type { AuthorizationRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface AuthorizationServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  findPerson(id: string): Promise<{ organizationUnitId: string; employmentStatus: string } | null>;
  scopeResolvers?: DataScopeResolvers;
}

export class AuthorizationService {
  private readonly clock: () => Date;
  private readonly createId: () => string;
  private readonly scopeResolvers: DataScopeResolvers;

  constructor(private readonly repository: AuthorizationRepository, private readonly options: AuthorizationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.scopeResolvers = options.scopeResolvers ?? {};
  }

  async createRole(input: CreateRoleInput): Promise<Role> {
    const code = catalogCode(input.code, 'role code');
    const name = requiredText(input.name, '角色名称', 150);
    if (await this.repository.findRoleByCode(code)) throw new AuthorizationError('DUPLICATE_ROLE', '角色编码已存在');
    const now = this.clock().toISOString();
    return this.repository.createRole({
      id: uuid(input.id ?? this.createId(), 'role id'),
      code,
      name,
      description: optionalText(input.description, 1000),
      status: authorizationStatus(input.status ?? 'active'),
      builtIn: false,
      createdAt: now,
      updatedAt: now
    });
  }

  async updateRole(input: UpdateRoleInput): Promise<Role> {
    const role = await this.requireRole(input.roleId);
    const updated: Role = {
      ...role,
      name: input.name === undefined ? role.name : requiredText(input.name, '角色名称', 150),
      description: input.description === undefined ? role.description : optionalText(input.description, 1000),
      status: input.status === undefined ? role.status : authorizationStatus(input.status),
      updatedAt: this.clock().toISOString()
    };
    return this.repository.updateRole(updated);
  }

  async registerPermission(input: RegisterPermissionInput): Promise<Permission> {
    const code = catalogCode(input.code, 'permission code');
    const name = requiredText(input.name, '权限名称', 150);
    if (await this.repository.findPermissionByCode(code)) throw new AuthorizationError('DUPLICATE_PERMISSION', '权限编码已存在');
    const now = this.clock().toISOString();
    return this.repository.createPermission({
      id: uuid(input.id ?? this.createId(), 'permission id'),
      code,
      name,
      description: optionalText(input.description, 1000),
      status: authorizationStatus(input.status ?? 'active'),
      createdAt: now,
      updatedAt: now
    });
  }

  async grantRolePermission(input: GrantRolePermissionInput): Promise<RolePermission> {
    const role = await this.requireRole(input.roleId);
    const permission = await this.requirePermission(input.permissionId);
    if (role.status !== 'active') throw new AuthorizationError('ROLE_INACTIVE', '角色未启用');
    if (permission.status !== 'active') throw new AuthorizationError('PERMISSION_INACTIVE', '权限未启用');
    const scope = validateScope(input.scope);
    const existing = await this.repository.findRolePermission(role.id, permission.id);
    const now = this.clock().toISOString();
    const record: RolePermission = {
      roleId: role.id,
      permissionId: permission.id,
      scopeKind: scope.kind,
      createdAt: existing?.grant.createdAt ?? now,
      updatedAt: now
    };
    return this.repository.saveRolePermission(record, scope.targets.map((target) => ({ ...target, roleId: role.id, permissionId: permission.id })));
  }

  async revokeRolePermission(roleId: string, permissionId: string): Promise<void> {
    await this.repository.removeRolePermission(uuid(roleId, 'role id'), uuid(permissionId, 'permission id'));
  }

  async assignRole(input: AssignPersonRoleInput): Promise<PersonRoleAssignment> {
    const draft = await this.prepareAssignment(input);
    if (await this.repository.findCurrentPersonRole(draft.personId)) {
      throw new AuthorizationError('PERSON_ROLE_ALREADY_ASSIGNED', '人员已有生效角色，请使用角色变更');
    }
    return this.repository.createPersonRoleAssignment(draft);
  }

  async changeRole(input: AssignPersonRoleInput): Promise<PersonRoleAssignment> {
    const draft = await this.prepareAssignment(input);
    return this.repository.replaceCurrentPersonRole(draft);
  }

  listRoles() { return this.repository.listRoles(); }
  listPermissions() { return this.repository.listPermissions(); }
  listRolePermissions(roleId: string) { return this.repository.listRolePermissions(uuid(roleId, 'role id')); }
  listPersonRoleAssignments(personId: string) { return this.repository.listPersonRoleAssignments(uuid(personId, 'person id')); }

  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const at = request.at ?? this.clock();
    const decidedAt = at.toISOString();
    const permissionCode = catalogCode(request.permissionCode, 'permission code');
    if (!['platform','application','service'].includes(request.execution.type)) return this.denied(request.subject, permissionCode, 'app_grant_invalid', decidedAt);
    const permission = await this.repository.findPermissionByCode(permissionCode);
    if (!permission) return this.denied(request.subject, permissionCode, 'permission_not_found', decidedAt);
    if (permission.status !== 'active') return this.denied(request.subject, permissionCode, 'permission_inactive', decidedAt);

    if (request.subject.type === 'service') {
      return this.decideService(request, permission, at);
    }
    if (request.execution.type === 'service') return this.denied(request.subject, permissionCode, 'app_grant_invalid', decidedAt);

    const personId = uuid(request.subject.personId, 'person id');
    const person = await this.options.findPerson(personId);
    if (!person) return this.denied(request.subject, permissionCode, 'person_not_found', decidedAt);
    if (person.employmentStatus !== 'active') return this.denied(request.subject, permissionCode, 'person_inactive', decidedAt);
    const assignment = await this.repository.findCurrentPersonRole(personId);
    if (!assignment || assignment.effectiveFrom > decidedAt) return this.denied(request.subject, permissionCode, 'role_not_assigned', decidedAt);
    const role = await this.repository.findRoleById(assignment.roleId);
    if (!role || role.status !== 'active') return this.denied(request.subject, permissionCode, 'role_inactive', decidedAt);
    const roleGrant = await this.repository.findRolePermission(role.id, permission.id);
    if (!roleGrant) return this.denied(request.subject, permissionCode, 'permission_not_granted', decidedAt);

    const scopes: EffectiveDataScopeClause[] = [{ source: 'role', scope: roleGrant.scope }];
    if (request.execution.type === 'application') {
      const appReason = validateAppGrant(request.execution.appId, request.execution.grant, 'delegated_user', permissionCode, at);
      if (appReason) return this.denied(request.subject, permissionCode, appReason, decidedAt);
      scopes.push({ source: 'app', scope: validateScope(request.execution.grant!.scope) });
    }
    const allowed = request.resource
      ? await scopesAllowResource(scopes, request.subject, person.organizationUnitId, request.resource, this.scopeResolvers)
      : true;
    return this.decision(request.subject, permissionCode, allowed ? 'allowed' : 'data_scope_mismatch', scopes, decidedAt);
  }

  /** Application ceiling only; intrinsic participant rights are checked by the owning service. */
  async decideApplication(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const at = request.at ?? this.clock();
    const decidedAt = at.toISOString();
    const permissionCode = catalogCode(request.permissionCode, 'permission code');
    const permission = await this.repository.findPermissionByCode(permissionCode);
    if (!permission) return this.denied(request.subject, permissionCode, 'permission_not_found', decidedAt);
    if (permission.status !== 'active') return this.denied(request.subject, permissionCode, 'permission_inactive', decidedAt);
    if (request.subject.type === 'service') return this.decideService(request, permission, at);
    if (request.execution.type !== 'application') return this.denied(request.subject, permissionCode, 'app_grant_invalid', decidedAt);
    const person = await this.options.findPerson(uuid(request.subject.personId, 'person id'));
    if (!person) return this.denied(request.subject, permissionCode, 'person_not_found', decidedAt);
    if (person.employmentStatus !== 'active') return this.denied(request.subject, permissionCode, 'person_inactive', decidedAt);
    const reason = validateAppGrant(request.execution.appId, request.execution.grant, 'delegated_user', permissionCode, at);
    if (reason) return this.denied(request.subject, permissionCode, reason, decidedAt);
    const scopes: EffectiveDataScopeClause[] = [{ source: 'app', scope: validateScope(request.execution.grant!.scope) }];
    const allowed = request.resource
      ? await scopesAllowResource(scopes, request.subject, person.organizationUnitId, request.resource, this.scopeResolvers)
      : true;
    return this.decision(request.subject, permissionCode, allowed ? 'allowed' : 'data_scope_mismatch', scopes, decidedAt);
  }

  private async decideService(request: AuthorizationRequest, permission: Permission, at: Date): Promise<AuthorizationDecision> {
    const subject = request.subject;
    if (subject.type !== 'service') throw new AuthorizationError('INVALID_SUBJECT', '服务身份无效');
    const decidedAt = at.toISOString();
    const permissionCode = permission.code;
    let appId: string;
    try { appId = applicationId(subject.appId); } catch { return this.denied(subject, permissionCode, 'app_grant_invalid', decidedAt); }
    if (request.execution.type !== 'service') return this.denied(subject, permissionCode, 'app_grant_invalid', decidedAt);
    if (!subject.serviceIdentityId.trim()) return this.denied(subject, permissionCode, 'app_grant_invalid', decidedAt);
    const reason = validateAppGrant(appId, request.execution.grant, 'service', permissionCode, at);
    if (reason) return this.denied(subject, permissionCode, reason, decidedAt);
    const scope = validateScope(request.execution.grant!.scope);
    if (!['all', 'explicit'].includes(scope.kind)) return this.denied(subject, permissionCode, 'app_grant_invalid', decidedAt);
    const scopes: EffectiveDataScopeClause[] = [{ source: 'app', scope }];
    const allowed = request.resource
      ? await scopesAllowResource(scopes, subject, null, request.resource, this.scopeResolvers)
      : true;
    return this.decision(subject, permissionCode, allowed ? 'allowed' : 'data_scope_mismatch', scopes, decidedAt);
  }

  private async prepareAssignment(input: AssignPersonRoleInput): Promise<PersonRoleAssignment> {
    const personId = uuid(input.personId, 'person id');
    const roleId = uuid(input.roleId, 'role id');
    const [person, role] = await Promise.all([this.options.findPerson(personId), this.repository.findRoleById(roleId)]);
    if (!person) throw new AuthorizationError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new AuthorizationError('PERSON_INACTIVE', '人员不在岗');
    if (!role) throw new AuthorizationError('ROLE_NOT_FOUND', '角色不存在');
    if (role.status !== 'active') throw new AuthorizationError('ROLE_INACTIVE', '角色未启用');
    const assignedByPersonId = input.assignedByPersonId ? uuid(input.assignedByPersonId, 'assigner person id') : null;
    const now = this.clock().toISOString();
    return {
      id: uuid(input.id ?? this.createId(), 'assignment id'),
      personId,
      roleId,
      effectiveFrom: now,
      effectiveTo: null,
      assignedByPersonId,
      reason: optionalText(input.reason, 500),
      createdAt: now,
      updatedAt: now
    };
  }

  private async requireRole(id: string) {
    const role = await this.repository.findRoleById(uuid(id, 'role id'));
    if (!role) throw new AuthorizationError('ROLE_NOT_FOUND', '角色不存在');
    return role;
  }

  private async requirePermission(id: string) {
    const permission = await this.repository.findPermissionById(uuid(id, 'permission id'));
    if (!permission) throw new AuthorizationError('PERMISSION_NOT_FOUND', '权限不存在');
    return permission;
  }

  private denied(subject: AuthorizationSubject, permissionCode: string, reasonCode: AuthorizationReasonCode, decidedAt: string) {
    return this.decision(subject, permissionCode, reasonCode, [], decidedAt);
  }

  private decision(subject: AuthorizationSubject, permissionCode: string, reasonCode: AuthorizationReasonCode, scopes: EffectiveDataScopeClause[], decidedAt: string): AuthorizationDecision {
    return { id: this.createId(), allowed: reasonCode === 'allowed', reasonCode, permissionCode, subjectType: subject.type, effectiveScopes: scopes, decidedAt };
  }
}

export function createAuthorizationService(repository: AuthorizationRepository, options: AuthorizationServiceOptions) {
  return new AuthorizationService(repository, options);
}

export function buildAuthorizationSeed(at = new Date().toISOString()) {
  const roles: Role[] = AUTHORIZATION_ROLE_SEEDS.map((seed) => ({ ...seed, description: null, status: 'active', builtIn: true, createdAt: at, updatedAt: at }));
  const permissions: Permission[] = AUTHORIZATION_PERMISSION_SEEDS.map((seed) => ({ ...seed, description: null, status: 'active', createdAt: at, updatedAt: at }));
  const administrator = roles.find((role) => role.code === 'administrator')!;
  const rolePermissions: RolePermission[] = permissions.map((permission) => ({ roleId: administrator.id, permissionId: permission.id, scopeKind: 'all', createdAt: at, updatedAt: at }));
  return { roles, permissions, rolePermissions, rolePermissionTargets: [] };
}

export async function scopesAllowResource(
  clauses: readonly EffectiveDataScopeClause[],
  subject: AuthorizationSubject,
  subjectOrganizationUnitId: string | null,
  resource: AuthorizationResource,
  resolvers: DataScopeResolvers = {}
) {
  for (const clause of clauses) {
    if (!await scopeAllowsResource(clause.scope, subject, subjectOrganizationUnitId, resource, resolvers)) return false;
  }
  return true;
}

export async function scopeAllowsResource(
  scope: DataScope,
  subject: AuthorizationSubject,
  subjectOrganizationUnitId: string | null,
  resource: AuthorizationResource,
  resolvers: DataScopeResolvers = {}
): Promise<boolean> {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'self') {
    if (subject.type !== 'person' || resource.ownerPersonId !== subject.personId) return false;
    return !resource.organizationUnitId || resource.organizationUnitId === subjectOrganizationUnitId;
  }
  if (scope.kind === 'organization') return Boolean(subjectOrganizationUnitId && resource.organizationUnitId === subjectOrganizationUnitId);
  if (scope.kind === 'organization_tree') {
    if (!subjectOrganizationUnitId || !resource.organizationUnitId) return false;
    if (subjectOrganizationUnitId === resource.organizationUnitId) return true;
    return resolvers.isOrganizationDescendant?.(resource.organizationUnitId, subjectOrganizationUnitId) ?? false;
  }
  const resourceTargets = [...(resource.targets ?? [])];
  if (resource.organizationUnitId) resourceTargets.push({ type: 'organization', id: resource.organizationUnitId });
  if (scope.kind === 'explicit') return scope.targets.some((scopeTarget) => resourceTargets.some((resourceTarget) => sameTarget(scopeTarget, resourceTarget)));
  if (subject.type !== 'person' || !resolvers.hasResponsibility) return false;
  for (const target of resourceTargets) if (await resolvers.hasResponsibility(subject.personId, target)) return true;
  return false;
}

export function reconcileLegacyRoles(snapshot: LegacyRoleSnapshot): LegacyRoleReconciliation {
  const people = new Set(snapshot.peopleIds);
  const seen = new Set<string>();
  const mappedRoleCodes: Record<string, string> = {};
  const issues: LegacyRoleReconciliation['issues'] = [];
  const roleMap: Record<string, string> = { 管理员: 'administrator', 工班长: 'team_leader', 检修工: 'maintainer' };
  let assignmentCount = 0;
  for (const row of snapshot.rows) {
    if (!people.has(row.personId)) issues.push({ code: 'MISSING_PERSON', sourceId: row.sourceId });
    const roleCode = roleMap[row.roleName];
    if (!roleCode) issues.push({ code: 'UNKNOWN_ROLE', sourceId: row.sourceId });
    if (seen.has(row.personId)) issues.push({ code: 'DUPLICATE_PERSON_ROLE', sourceId: row.sourceId });
    seen.add(row.personId);
    if (people.has(row.personId) && roleCode && !mappedRoleCodes[row.personId]) {
      mappedRoleCodes[row.personId] = roleCode;
      assignmentCount += 1;
    }
  }
  return { sourceCount: snapshot.rows.length, assignmentCount, mappedRoleCodes, issues };
}

function validateAppGrant(appIdInput: string, grant: AppPermissionGrant | null | undefined, mode: AppPermissionGrant['mode'], permissionCode: string, at: Date): AuthorizationReasonCode | null {
  if (!grant) return 'app_grant_required';
  try {
    const appId = applicationId(appIdInput);
    if (applicationId(grant.appId) !== appId || grant.mode !== mode || catalogCode(grant.permissionCode, 'permission code') !== permissionCode || !grant.grantId.trim()) return 'app_grant_invalid';
    validateScope(grant.scope);
  } catch {
    return 'app_grant_invalid';
  }
  if (grant.status !== 'active') return 'app_grant_inactive';
  const instant = at.toISOString();
  if (!isIsoInstant(grant.effectiveFrom) || grant.effectiveTo !== null && !isIsoInstant(grant.effectiveTo)) return 'app_grant_invalid';
  if (grant.effectiveFrom > instant || grant.effectiveTo !== null && instant >= grant.effectiveTo) return 'app_grant_expired';
  return null;
}

export function validateScope(scope: DataScope): DataScope {
  if (!['self','organization','organization_tree','responsibility','explicit','all'].includes(scope.kind)) throw new AuthorizationError('INVALID_DATA_SCOPE', '数据范围类型无效');
  const targets = (scope.targets ?? []).map((target) => ({ type: target.type, id: uuid(target.id, 'scope target id') }));
  if (scope.kind === 'explicit' && targets.length === 0) throw new AuthorizationError('EXPLICIT_SCOPE_TARGET_REQUIRED', '指定范围必须包含目标');
  if (scope.kind !== 'explicit' && targets.length > 0) throw new AuthorizationError('UNEXPECTED_SCOPE_TARGET', '只有指定范围可以携带目标');
  const keys = new Set<string>();
  for (const target of targets) {
    if (!['organization','location','asset_type','asset','responsibility_scope'].includes(target.type)) throw new AuthorizationError('INVALID_SCOPE_TARGET_TYPE', '指定范围目标类型无效');
    const key = `${target.type}:${target.id}`;
    if (keys.has(key)) throw new AuthorizationError('DUPLICATE_SCOPE_TARGET', '指定范围目标重复');
    keys.add(key);
  }
  return { kind: scope.kind, targets };
}

function sameTarget(left: DataScopeTarget, right: DataScopeTarget) { return left.type === right.type && left.id === right.id; }
function authorizationStatus(value: string) { if (value !== 'active' && value !== 'inactive') throw new AuthorizationError('INVALID_STATUS', '授权状态无效'); return value; }
function catalogCode(value: string, label: string) { const code = value.trim().toLowerCase(); if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(code) || code.length > 150) throw new AuthorizationError('INVALID_CODE', `${label} 必须是稳定编码`); return code; }
function applicationId(value: string) { const appId = value.trim().toLowerCase(); if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(appId) || appId.length > 100) throw new AuthorizationError('INVALID_APP_ID', '应用 ID 必须是稳定编码'); return appId; }
function requiredText(value: string, label: string, max: number) { const text = value.trim(); if (!text || text.length > max) throw new AuthorizationError('INVALID_TEXT', `${label} 无效`); return text; }
function optionalText(value: string | null | undefined, max: number) { if (value == null) return null; const text = value.trim(); if (!text) return null; if (text.length > max) throw new AuthorizationError('INVALID_TEXT', '文本过长'); return text; }
function isIsoInstant(value: string) { return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function uuid(value: string, label: string) { const normalized = value.trim().toLowerCase(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) throw new AuthorizationError('INVALID_ID', `${label} 必须是 UUID`); return normalized; }
