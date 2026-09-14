export const ORGANIZATION_UNIT_TYPES = [
  'company',
  'operations_center',
  'department',
  'station_area',
  'workgroup',
  'station_organization'
] as const;

export type OrganizationUnitType = typeof ORGANIZATION_UNIT_TYPES[number];
export type DirectoryRecordStatus = 'active' | 'inactive';
export type EmploymentStatus = 'active' | 'inactive' | 'departed';
export type ExternalIdentityStatus = 'active' | 'inactive';

export interface OrganizationUnit {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  shortName: string | null;
  unitType: OrganizationUnitType;
  status: DirectoryRecordStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Position {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: DirectoryRecordStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Person {
  id: string;
  employeeNo: string;
  name: string;
  phone: string | null;
  organizationUnitId: string;
  positionId: string;
  employmentStatus: EmploymentStatus;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalIdentity {
  id: string;
  personId: string;
  provider: string;
  tenantKey: string;
  externalUserId: string;
  status: ExternalIdentityStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonDirectoryProfile {
  person: Person;
  organizationUnit: OrganizationUnit;
  position: Position;
}

export interface OrganizationTreeNode extends OrganizationUnit {
  children: OrganizationTreeNode[];
}

export interface CreateOrganizationUnitInput {
  id?: string;
  parentId?: string | null;
  code: string;
  name: string;
  shortName?: string | null;
  unitType: OrganizationUnitType;
  status?: DirectoryRecordStatus;
  sortOrder?: number;
}

export interface CreatePositionInput {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  status?: DirectoryRecordStatus;
}

export interface CreatePersonInput {
  id?: string;
  employeeNo: string;
  name: string;
  phone?: string | null;
  organizationUnitId: string;
  positionId: string;
  employmentStatus?: EmploymentStatus;
  avatarUrl?: string | null;
}

export interface LinkExternalIdentityInput {
  id?: string;
  personId: string;
  provider: string;
  tenantKey?: string;
  externalUserId: string;
  status?: ExternalIdentityStatus;
  verifiedAt?: Date | null;
}

export interface SearchPeopleInput {
  query?: string;
  organizationUnitId?: string;
  positionId?: string;
  employmentStatus?: EmploymentStatus;
  limit?: number;
}

export interface LegacyDirectoryUserReference {
  id: string;
  employeeNo: string;
  name: string;
  phone?: string | null;
  wecomUserId?: string | null;
  organizationUnitId?: string | null;
  positionName?: string | null;
}

export interface LegacyDirectoryOrganizationReference {
  id: string;
  name: string;
}

export interface LegacyDirectorySnapshot {
  users: readonly LegacyDirectoryUserReference[];
  organizations: readonly LegacyDirectoryOrganizationReference[];
}

export type LegacyDirectoryIssueCode =
  | 'DUPLICATE_EMPLOYEE_NO'
  | 'DUPLICATE_WECOM_USER_ID'
  | 'MISSING_ORGANIZATION'
  | 'MISSING_POSITION';

export interface LegacyDirectoryIssue {
  code: LegacyDirectoryIssueCode;
  personId: string;
  value?: string;
}

export interface LegacyDirectoryReconciliation {
  personCount: number;
  organizationCount: number;
  wecomBindingCount: number;
  preservedPersonIds: string[];
  preservedOrganizationUnitIds: string[];
  issues: LegacyDirectoryIssue[];
}

export class PeopleDirectoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PeopleDirectoryError';
    this.code = code;
  }
}
