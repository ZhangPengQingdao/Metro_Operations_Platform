export const RESPONSIBILITY_AREA_SEEDS = [
  { id: '30000000-0000-4000-8000-000000000001', code: 'safety_management', name: '安全管理' },
  { id: '30000000-0000-4000-8000-000000000002', code: 'training_management', name: '培训管理' },
  { id: '30000000-0000-4000-8000-000000000003', code: 'production_management', name: '生产管理' },
  { id: '30000000-0000-4000-8000-000000000004', code: 'general_affairs_management', name: '综合事务管理' }
] as const;

export type ResponsibilityStatus = 'active' | 'inactive';
export type ResponsibilityAssignmentRole = 'primary_owner' | 'backup_owner' | 'temporary_agent';
export type ResponsibilityTarget =
  | { type: 'responsibility_area'; id: string }
  | { type: 'location'; id: string; includeDescendants?: boolean }
  | { type: 'asset_type'; id: string }
  | { type: 'asset'; id: string };

export interface ResponsibilityArea {
  id: string; code: string; name: string; description: string | null;
  status: ResponsibilityStatus; createdAt: string; updatedAt: string;
}

export interface ResponsibilityScope {
  id: string; organizationUnitId: string;
  responsibilityAreaId: string | null; locationId: string | null;
  assetTypeId: string | null; assetId: string | null;
  includeDescendants: boolean; status: ResponsibilityStatus;
  createdAt: string; updatedAt: string;
}

export interface ResponsibilityAssignment {
  id: string; scopeId: string; personId: string; assignmentRole: ResponsibilityAssignmentRole;
  effectiveFrom: string; effectiveTo: string | null; status: ResponsibilityStatus;
  createdAt: string; updatedAt: string;
}

export interface ResponsibilityResolution {
  scope: ResponsibilityScope;
  primaryOwner: ResponsibilityAssignment | null;
  temporaryAgent: ResponsibilityAssignment | null;
  effectiveHandler: ResponsibilityAssignment | null;
  backupOwners: ResponsibilityAssignment[];
  resolvedAt: string;
}

export interface CreateResponsibilityScopeInput {
  id?: string; organizationUnitId: string; target: ResponsibilityTarget; status?: ResponsibilityStatus;
}

export interface CreateResponsibilityAssignmentInput {
  id?: string; scopeId: string; personId: string; assignmentRole: ResponsibilityAssignmentRole;
  effectiveFrom?: Date; effectiveTo?: Date | null; status?: ResponsibilityStatus;
}

export interface LegacyStationResponsibilityReference {
  id: string; organizationUnitId: string; locationId: string; personId: string;
}

export interface LegacyResponsibilitySnapshot {
  rows: readonly LegacyStationResponsibilityReference[];
  organizationUnitIds: readonly string[];
  locationIds: readonly string[];
  people: readonly { id: string; organizationUnitId: string; employmentStatus: string }[];
}

export type LegacyResponsibilityIssueCode =
  | 'MISSING_ORGANIZATION' | 'MISSING_LOCATION' | 'MISSING_PERSON'
  | 'PERSON_ORGANIZATION_MISMATCH' | 'PERSON_NOT_ACTIVE' | 'DUPLICATE_ORGANIZATION_LOCATION';
export interface LegacyResponsibilityIssue { code: LegacyResponsibilityIssueCode; sourceId: string; }
export interface LegacyResponsibilityReconciliation {
  sourceCount: number; scopeCount: number; assignmentCount: number;
  preservedAssignmentIds: string[]; issues: LegacyResponsibilityIssue[];
}

export class ResponsibilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ResponsibilityError'; this.code = code; }
}
