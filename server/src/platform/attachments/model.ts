import type { StorageObjectMetadata, StorageObjectReference } from '../../core/storage/index.js';

export const ATTACHMENT_VISIBILITIES = ['private', 'organization', 'application', 'public_link'] as const;
export const ATTACHMENT_LIFECYCLES = ['active', 'removed'] as const;

export const ATTACHMENT_PERMISSION_CODES = {
  create: 'platform.attachments.create',
  read: 'platform.attachments.read',
  manage: 'platform.attachments.manage',
  retentionManage: 'platform.attachments.retention.manage',
  remove: 'platform.attachments.remove'
} as const;

export const ATTACHMENT_PERMISSION_SEEDS = [
  { id: '4c000000-0000-4000-8000-000000000011', code: ATTACHMENT_PERMISSION_CODES.create, name: '创建平台附件' },
  { id: '4c000000-0000-4000-8000-000000000012', code: ATTACHMENT_PERMISSION_CODES.read, name: '查看平台附件' },
  { id: '4c000000-0000-4000-8000-000000000013', code: ATTACHMENT_PERMISSION_CODES.manage, name: '管理平台附件可见性' },
  { id: '4c000000-0000-4000-8000-000000000014', code: ATTACHMENT_PERMISSION_CODES.retentionManage, name: '管理平台附件保留与法律保全' },
  { id: '4c000000-0000-4000-8000-000000000015', code: ATTACHMENT_PERMISSION_CODES.remove, name: '逻辑移除平台附件' }
] as const;

export type AttachmentVisibility = typeof ATTACHMENT_VISIBILITIES[number];
export type AttachmentLifecycle = typeof ATTACHMENT_LIFECYCLES[number];
export type AttachmentPermissionCode = typeof ATTACHMENT_PERMISSION_CODES[keyof typeof ATTACHMENT_PERMISSION_CODES];
export type AttachmentActorType = 'person' | 'service';
export type AttachmentExecutionType = 'platform' | 'application' | 'service';
export type AttachmentOperation = 'registered' | 'visibility_changed' | 'retention_changed' | 'removed';

export interface AttachmentSourceReference {
  appId: string;
  entityType: string;
  entityId: string;
}

export interface AttachmentUploaderSnapshot {
  personId: string;
  name: string;
  organizationUnitId: string;
}

export interface AttachmentOwnerOrganizationSnapshot {
  organizationUnitId: string;
  name: string | null;
}

export interface Attachment {
  id: string;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  attachmentKey: string;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  purpose: string;
  storageKind: string;
  storageFileName: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploaderPersonId: string | null;
  uploaderSnapshot: AttachmentUploaderSnapshot | null;
  ownerOrganizationUnitId: string | null;
  ownerOrganizationSnapshot: AttachmentOwnerOrganizationSnapshot | null;
  visibility: AttachmentVisibility;
  lifecycle: AttachmentLifecycle;
  retainUntil: string | null;
  legalHold: boolean;
  createdByActorType: AttachmentActorType;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
}

export interface AttachmentOperationHistory {
  id: string;
  attachmentId: string | null;
  operation: AttachmentOperation;
  actorType: AttachmentActorType;
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: AttachmentExecutionType;
  sourceAppId: string | null;
  requestId: string | null;
  traceId: string | null;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AttachmentDetail {
  attachment: Attachment;
  operationHistory: AttachmentOperationHistory[];
}

export interface RegisterAttachmentInput {
  id?: string;
  source: AttachmentSourceReference;
  attachmentKey: string;
  idempotencyKey?: string | null;
  purpose: string;
  storage: StorageObjectReference;
  originalFileName: string;
  uploaderPersonId?: string | null;
  ownerOrganizationUnitId?: string | null;
  visibility?: AttachmentVisibility;
  retainUntil?: Date | null;
  legalHold?: boolean;
}

export interface AttachmentListInput {
  sourceAppId?: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  uploaderPersonId?: string;
  ownerOrganizationUnitId?: string;
  visibility?: AttachmentVisibility | readonly AttachmentVisibility[];
  lifecycle?: AttachmentLifecycle | readonly AttachmentLifecycle[];
  limit?: number;
}

export interface ChangeAttachmentVisibilityInput {
  attachmentId: string;
  visibility: AttachmentVisibility;
  note?: string | null;
}

export interface ChangeAttachmentRetentionInput {
  attachmentId: string;
  retainUntil?: Date | null;
  legalHold?: boolean;
  note?: string | null;
}

export interface RemoveAttachmentInput {
  attachmentId: string;
  note?: string | null;
}

export interface LegacyFileAssetReference {
  id?: string;
  kind: string;
  fileName: string;
  uploaderId?: string | null;
  workgroupId?: string | null;
  purpose?: string | null;
  entityKey?: string | null;
}

export interface LegacyPublicAttachmentReference {
  id: string;
  value: string;
}

export interface LegacyAttachmentSnapshot {
  fileAssets?: readonly LegacyFileAssetReference[];
  storageObjects?: readonly StorageObjectMetadata[];
  publicReferences?: readonly LegacyPublicAttachmentReference[];
}

export type LegacyAttachmentIssueCode =
  | 'UNSAFE_STORAGE_REFERENCE'
  | 'DUPLICATE_STORAGE_REFERENCE'
  | 'MISSING_OWNERSHIP'
  | 'MISSING_BUSINESS_ASSOCIATION'
  | 'METADATA_WITHOUT_OBJECT'
  | 'OBJECT_WITHOUT_METADATA'
  | 'INVALID_STORAGE_METADATA'
  | 'UNSAFE_PUBLIC_REFERENCE'
  | 'PUBLIC_REFERENCE_WITHOUT_OBJECT';

export interface LegacyAttachmentIssue {
  code: LegacyAttachmentIssueCode;
  sourceId: string;
}

export interface LegacyAttachmentReconciliation {
  metadataCount: number;
  storageObjectCount: number;
  publicReferenceCount: number;
  kindCounts: Record<string, number>;
  purposeCounts: Record<string, number>;
  uploaderCoverageCount: number;
  ownerOrganizationCoverageCount: number;
  businessAssociationCoverageCount: number;
  publicReferenceObjectCoverageCount: number;
  issues: LegacyAttachmentIssue[];
}

export class AttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentError';
    this.code = code;
  }
}
