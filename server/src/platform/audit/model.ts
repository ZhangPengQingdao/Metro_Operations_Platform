import type { TrustedActorSource } from '../../core/identity/index.js';

export const BUSINESS_AUDIT_OUTCOMES = ['succeeded', 'denied', 'failed'] as const;

export const BUSINESS_AUDIT_PERMISSION_CODES = {
  record: 'platform.audit.record',
  read: 'platform.audit.read'
} as const;

export const BUSINESS_AUDIT_PERMISSION_SEEDS = [
  { id: '4e000000-0000-4000-8000-000000000011', code: BUSINESS_AUDIT_PERMISSION_CODES.record, name: '记录平台业务审计' },
  { id: '4e000000-0000-4000-8000-000000000012', code: BUSINESS_AUDIT_PERMISSION_CODES.read, name: '查看平台业务审计' }
] as const;

export type BusinessAuditOutcome = typeof BUSINESS_AUDIT_OUTCOMES[number];
export type BusinessAuditPermissionCode = typeof BUSINESS_AUDIT_PERMISSION_CODES[keyof typeof BUSINESS_AUDIT_PERMISSION_CODES];
export type BusinessAuditActorType = 'person' | 'service';
export type BusinessAuditExecutionType = 'platform' | 'application' | 'service';

export interface BusinessOperation {
  code: string;
  outcome: BusinessAuditOutcome;
}

export interface PersonActorSnapshot {
  personId: string;
  employeeNo: string;
  name: string;
  organizationUnitId: string;
  organizationName: string;
  positionId: string;
  positionName: string;
}

export interface ActorReference {
  type: BusinessAuditActorType;
  personId: string | null;
  serviceIdentityId: string | null;
  personSnapshot: PersonActorSnapshot | null;
}

export interface BusinessReference {
  appId: string;
  entityType: string;
  entityId: string;
  displayLabel: string | null;
  ownerPersonId: string | null;
  ownerOrganizationUnitId: string | null;
}

export interface ChangeSummary {
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface OperationSource {
  identitySource: TrustedActorSource;
  executionType: BusinessAuditExecutionType;
  executionAppId: string | null;
  requestId: string;
  traceId: string;
}

export interface OperationReason {
  code: string | null;
  text: string | null;
}

export interface BusinessAuditRecord {
  id: string;
  auditKey: string | null;
  idempotencyPayloadHash: string | null;
  operation: BusinessOperation;
  actor: ActorReference;
  business: BusinessReference;
  change: ChangeSummary | null;
  source: OperationSource;
  reason: OperationReason | null;
  resultSummary: Record<string, unknown> | null;
  errorCode: string | null;
  occurredAt: string;
}

export interface RecordBusinessOperationInput {
  id?: string;
  auditKey?: string | null;
  operationCode: string;
  outcome: BusinessAuditOutcome;
  business: {
    appId: string;
    entityType: string;
    entityId: string;
    displayLabel?: string | null;
    ownerPersonId?: string | null;
    ownerOrganizationUnitId?: string | null;
  };
  changedFields?: readonly string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  resultSummary?: Record<string, unknown> | null;
  reason?: {
    code?: string | null;
    text?: string | null;
  } | null;
  errorCode?: string | null;
}

export interface BusinessAuditListInput {
  operationCode?: string;
  outcome?: BusinessAuditOutcome;
  actorPersonId?: string;
  sourceApplicationId?: string;
  businessAppId?: string;
  entityType?: string;
  entityId?: string;
  ownerPersonId?: string;
  ownerOrganizationUnitId?: string;
  requestId?: string;
  traceId?: string;
  occurredFrom?: Date | string;
  occurredTo?: Date | string;
  limit?: number;
}

export const EXISTING_BUSINESS_AUDIT_SOURCES = [
  'work_item_history',
  'notification_history',
  'signature_history',
  'attachment_history',
  'device_resolution_audit'
] as const;

export type ExistingBusinessAuditSource = typeof EXISTING_BUSINESS_AUDIT_SOURCES[number];

export interface ExistingBusinessAuditEvidenceRow {
  sourceId: string;
  operation?: string | null;
  outcome?: string | null;
  actorPersonId?: string | null;
  serviceIdentityId?: string | null;
  sourceAppId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt?: string | null;
}

export interface ExistingBusinessAuditEvidenceSnapshot {
  workItemHistory?: readonly ExistingBusinessAuditEvidenceRow[];
  notificationHistory?: readonly ExistingBusinessAuditEvidenceRow[];
  signatureHistory?: readonly ExistingBusinessAuditEvidenceRow[];
  attachmentHistory?: readonly ExistingBusinessAuditEvidenceRow[];
  deviceResolutionAudits?: readonly ExistingBusinessAuditEvidenceRow[];
}

export type BusinessAuditReconciliationIssueCode =
  | 'MISSING_OPERATION'
  | 'MISSING_OUTCOME'
  | 'INVALID_OUTCOME'
  | 'MISSING_ACTOR'
  | 'MISSING_APPLICATION'
  | 'MISSING_ENTITY_REFERENCE'
  | 'MISSING_REQUEST'
  | 'MISSING_TRACE'
  | 'MISSING_OCCURRED_AT'
  | 'INVALID_OCCURRED_AT'
  | 'UNSAFE_PAYLOAD_KEY';

export interface BusinessAuditReconciliationIssue {
  source: ExistingBusinessAuditSource;
  sourceId: string;
  code: BusinessAuditReconciliationIssueCode;
  key?: string;
}

export interface BusinessAuditReconciliationCoverage {
  actor: number;
  application: number;
  entity: number;
  request: number;
  trace: number;
  change: number;
}

export interface BusinessAuditReconciliation {
  totalCount: number;
  sourceCounts: Record<ExistingBusinessAuditSource, number>;
  outcomeCounts: Record<string, number>;
  coverage: BusinessAuditReconciliationCoverage;
  mappableCount: number;
  issues: BusinessAuditReconciliationIssue[];
}

export class BusinessAuditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BusinessAuditError';
    this.code = code;
  }
}
