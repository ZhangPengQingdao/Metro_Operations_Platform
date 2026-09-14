export const AUTHORIZATION_ROLE_SEEDS = [
  { id: '40000000-0000-4000-8000-000000000001', code: 'administrator', name: '管理员' },
  { id: '40000000-0000-4000-8000-000000000002', code: 'team_leader', name: '工班长' },
  { id: '40000000-0000-4000-8000-000000000003', code: 'maintainer', name: '检修工' }
] as const;

export const AUTHORIZATION_PERMISSION_SEEDS = [
  { id: '40000000-0000-4000-8000-000000000011', code: 'platform.authorization.read', name: '查看角色与权限' },
  { id: '40000000-0000-4000-8000-000000000012', code: 'platform.authorization.manage', name: '管理角色与权限' }
] as const;

export type AuthorizationStatus = 'active' | 'inactive';
export type DataScopeKind = 'self' | 'organization' | 'organization_tree' | 'responsibility' | 'explicit' | 'all';
export type DataScopeTargetType = 'organization' | 'location' | 'asset_type' | 'asset' | 'responsibility_scope';
export type AppGrantMode = 'delegated_user' | 'service';

export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: AuthorizationStatus;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Permission {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: AuthorizationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DataScopeTarget {
  type: DataScopeTargetType;
  id: string;
}

export interface DataScope {
  kind: DataScopeKind;
  targets: DataScopeTarget[];
}

export interface RolePermission {
  roleId: string;
  permissionId: string;
  scopeKind: DataScopeKind;
  createdAt: string;
  updatedAt: string;
}

export interface RolePermissionTarget extends DataScopeTarget {
  roleId: string;
  permissionId: string;
}

export interface PersonRoleAssignment {
  id: string;
  personId: string;
  roleId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  assignedByPersonId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  status?: AuthorizationStatus;
}

export interface UpdateRoleInput {
  roleId: string;
  name?: string;
  description?: string | null;
  status?: AuthorizationStatus;
}

export interface RegisterPermissionInput {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  status?: AuthorizationStatus;
}

export interface GrantRolePermissionInput {
  roleId: string;
  permissionId: string;
  scope: DataScope;
}

export interface AssignPersonRoleInput {
  id?: string;
  personId: string;
  roleId: string;
  assignedByPersonId?: string | null;
  reason?: string | null;
}

export interface AppPermissionGrant {
  grantId: string;
  appId: string;
  mode: AppGrantMode;
  permissionCode: string;
  scope: DataScope;
  status: AuthorizationStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export type AuthorizationSubject =
  | { type: 'person'; personId: string }
  | { type: 'service'; appId: string; serviceIdentityId: string };

export type AuthorizationExecution =
  | { type: 'platform' }
  | { type: 'application'; appId: string; grant?: AppPermissionGrant | null }
  | { type: 'service'; grant?: AppPermissionGrant | null };

export interface AuthorizationResource {
  ownerPersonId?: string | null;
  organizationUnitId?: string | null;
  targets?: readonly DataScopeTarget[];
}

export interface AuthorizationRequest {
  subject: AuthorizationSubject;
  execution: AuthorizationExecution;
  permissionCode: string;
  resource?: AuthorizationResource;
  at?: Date;
}

export interface EffectiveDataScopeClause {
  source: 'role' | 'app';
  scope: DataScope;
}

export type AuthorizationReasonCode =
  | 'allowed'
  | 'person_not_found'
  | 'person_inactive'
  | 'role_not_assigned'
  | 'role_inactive'
  | 'permission_not_found'
  | 'permission_inactive'
  | 'permission_not_granted'
  | 'app_grant_required'
  | 'app_grant_invalid'
  | 'app_grant_inactive'
  | 'app_grant_expired'
  | 'data_scope_mismatch';

export interface AuthorizationDecision {
  id: string;
  allowed: boolean;
  reasonCode: AuthorizationReasonCode;
  permissionCode: string;
  subjectType: AuthorizationSubject['type'];
  effectiveScopes: EffectiveDataScopeClause[];
  decidedAt: string;
}

export interface DataScopeResolvers {
  isOrganizationDescendant?(organizationUnitId: string, ancestorOrganizationUnitId: string): Promise<boolean>;
  hasResponsibility?(personId: string, target: DataScopeTarget): Promise<boolean>;
}

export interface LegacyRoleReference {
  sourceId: string;
  personId: string;
  roleName: string;
}

export interface LegacyRoleSnapshot {
  peopleIds: readonly string[];
  rows: readonly LegacyRoleReference[];
}

export type LegacyRoleIssueCode = 'MISSING_PERSON' | 'UNKNOWN_ROLE' | 'DUPLICATE_PERSON_ROLE';
export interface LegacyRoleIssue { code: LegacyRoleIssueCode; sourceId: string; }
export interface LegacyRoleReconciliation {
  sourceCount: number;
  assignmentCount: number;
  mappedRoleCodes: Record<string, string>;
  issues: LegacyRoleIssue[];
}

export class AuthorizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}
