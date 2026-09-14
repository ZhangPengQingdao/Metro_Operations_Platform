import type { StorageObjectReference } from '../../core/storage/index.js';

export const SIGNATURE_REQUEST_STATUSES = ['draft', 'dispatched', 'completed', 'cancelled'] as const;
export const SIGNATURE_SESSION_STATUSES = ['draft', 'dispatched', 'completed', 'cancelled'] as const;
export const SIGNATURE_SIGNER_STATUSES = ['pending', 'signed', 'revoked'] as const;

export const SIGNATURE_PERMISSION_CODES = {
  create: 'platform.signatures.create',
  read: 'platform.signatures.read',
  sign: 'platform.signatures.sign',
  manage: 'platform.signatures.manage',
  signOnBehalf: 'platform.signatures.sign_on_behalf',
  finalize: 'platform.signatures.finalize'
} as const;

export const SIGNATURE_PERMISSION_SEEDS = [
  { id: '4a000000-0000-4000-8000-000000000011', code: SIGNATURE_PERMISSION_CODES.create, name: '创建平台签字请求' },
  { id: '4a000000-0000-4000-8000-000000000012', code: SIGNATURE_PERMISSION_CODES.read, name: '查看平台签字请求' },
  { id: '4a000000-0000-4000-8000-000000000013', code: SIGNATURE_PERMISSION_CODES.manage, name: '管理平台签字请求' },
  { id: '4a000000-0000-4000-8000-000000000014', code: SIGNATURE_PERMISSION_CODES.signOnBehalf, name: '代他人提交平台签字' },
  { id: '4a000000-0000-4000-8000-000000000015', code: SIGNATURE_PERMISSION_CODES.finalize, name: '完成平台签字请求' },
  { id: '4a000000-0000-4000-8000-000000000016', code: SIGNATURE_PERMISSION_CODES.sign, name: '通过应用提交本人签字' }
] as const;

export const SIGNATURE_EVENT_TYPES = {
  requestCreated: 'platform.signatures.request-created.v1',
  signerSigned: 'platform.signatures.signer-signed.v1',
  statusChanged: 'platform.signatures.status-changed.v1',
  requestCompleted: 'platform.signatures.request-completed.v1'
} as const;

export type SignatureRequestStatus = typeof SIGNATURE_REQUEST_STATUSES[number];
export type SignatureSessionStatus = typeof SIGNATURE_SESSION_STATUSES[number];
export type SignatureSignerStatus = typeof SIGNATURE_SIGNER_STATUSES[number];
export type SignaturePermissionCode = typeof SIGNATURE_PERMISSION_CODES[keyof typeof SIGNATURE_PERMISSION_CODES];
export type SignatureEventType = typeof SIGNATURE_EVENT_TYPES[keyof typeof SIGNATURE_EVENT_TYPES];
export type SignatureExecutionType = 'platform' | 'application' | 'service';
export type SignatureActorType = 'person' | 'service';
export type SignatureOperation = 'created' | 'signed' | 'signer_revoked' | 'status_changed' | 'completed' | 'cancelled';

export interface SignatureSourceReference {
  appId: string;
  entityType: string;
  entityId: string;
}

export interface SignatureFileReference extends StorageObjectReference {
  contentType?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
}

export interface SignatureDocumentSnapshot {
  title: string;
  description: string | null;
  originalFileName: string | null;
  originalExtension: string | null;
  sourceFile: SignatureFileReference | null;
}

export interface SignatureRequest {
  id: string;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  signatureKey: string;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  status: SignatureRequestStatus;
  document: SignatureDocumentSnapshot;
  createdByPersonId: string | null;
  createdByActorType: SignatureActorType;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface SignatureSession {
  id: string;
  signatureRequestId: string;
  publicTokenHash: string;
  publicTokenPreview: string;
  status: SignatureSessionStatus;
  expiresAt: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignatureSigner {
  id: string;
  signatureRequestId: string;
  sessionId: string;
  personId: string | null;
  signerKey: string;
  displayName: string;
  expectedOrganizationUnitId: string | null;
  status: SignatureSignerStatus;
  signatureEvidenceId: string | null;
  signedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SignaturePosition {
  id: string;
  signatureRequestId: string;
  signerId: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strategy: string;
  label: string | null;
  required: boolean;
  createdAt: string;
}

export interface SignatureEvidence {
  id: string;
  signatureRequestId: string;
  signerId: string;
  submittedByPersonId: string | null;
  storageRef: SignatureFileReference | null;
  signatureUrl: string | null;
  contentType: string;
  sha256: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  clientMetadata: Record<string, string | number | boolean | null>;
  signedAt: string;
  createdAt: string;
}

export interface SignatureOperationHistory {
  id: string;
  signatureRequestId: string | null;
  operation: SignatureOperation;
  actorType: SignatureActorType;
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: SignatureExecutionType;
  sourceAppId: string | null;
  requestId: string | null;
  traceId: string | null;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface SignatureDetail {
  request: SignatureRequest;
  session: SignatureSession;
  signers: SignatureSigner[];
  positions: SignaturePosition[];
  evidence: SignatureEvidence[];
  operationHistory: SignatureOperationHistory[];
}

export interface SignaturePositionInput {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strategy?: string;
  label?: string | null;
  required?: boolean;
}

export interface SignatureSignerInput {
  personId?: string | null;
  name?: string | null;
  expectedOrganizationUnitId?: string | null;
  positions: readonly SignaturePositionInput[];
}

export interface CreateSignatureRequestInput {
  id?: string;
  sessionId?: string;
  source: SignatureSourceReference;
  signatureKey: string;
  idempotencyKey?: string | null;
  document: SignatureDocumentSnapshot;
  signers: readonly SignatureSignerInput[];
  expiresAt?: Date | null;
}

export interface SignatureRequestCreation {
  request: SignatureRequest;
  session: SignatureSession;
  publicToken: string | null;
}

export interface SignatureListInput {
  sourceAppId?: string;
  status?: SignatureRequestStatus | readonly SignatureRequestStatus[];
  signerPersonId?: string;
  limit?: number;
}

export interface SignatureEvidenceInput {
  storageRef?: SignatureFileReference | null;
  signatureUrl?: string | null;
  contentType?: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  clientMetadata?: Record<string, string | number | boolean | null>;
}

export interface SubmitSignatureInput {
  signerId: string;
  publicToken?: string;
  sessionId?: string;
  evidence: SignatureEvidenceInput;
  note?: string | null;
}

export interface RevokeSignatureSignerInput {
  signerId: string;
  note?: string | null;
}

export interface FinalizeSignatureRequestInput {
  signatureRequestId: string;
  note?: string | null;
}

export interface CancelSignatureRequestInput {
  signatureRequestId: string;
  note?: string | null;
}

export interface LegacySignatureSessionReference {
  id: string;
  publicToken?: string | null;
  status: string;
}

export interface LegacySignatureSignerReference {
  id: string;
  sessionId: string;
  userId?: string | null;
  name: string;
  status: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strategy?: string | null;
  signatureUrl?: string | null;
}

export interface LegacySignatureFormReference {
  kind: string;
  id: string;
  sessionId: string;
}

export interface LegacySignatureSnapshot {
  templates?: readonly { id: string }[];
  sessions?: readonly LegacySignatureSessionReference[];
  signers?: readonly LegacySignatureSignerReference[];
  forms?: readonly LegacySignatureFormReference[];
}

export type LegacySignatureIssueCode =
  | 'SESSION_MISSING_TOKEN'
  | 'INVALID_SESSION_STATUS'
  | 'SIGNER_WITHOUT_SESSION'
  | 'SIGNER_MISSING_POSITION'
  | 'INVALID_SIGNER_STATUS'
  | 'SIGNED_WITHOUT_EVIDENCE'
  | 'COMPLETED_WITH_UNSIGNED_SIGNER'
  | 'FORM_WITHOUT_SESSION';

export interface LegacySignatureIssue {
  code: LegacySignatureIssueCode;
  sourceId: string;
}

export interface LegacySignatureReconciliation {
  templateCount: number;
  sessionCount: number;
  signerCount: number;
  formCount: number;
  sessionStatusCounts: Record<string, number>;
  signerStatusCounts: Record<string, number>;
  personSignerCount: number;
  nameOnlySignerCount: number;
  positionedSignerCount: number;
  evidenceReferenceCount: number;
  issues: LegacySignatureIssue[];
}

export class SignatureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SignatureError';
    this.code = code;
  }
}
