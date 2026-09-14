import { createHash, randomUUID } from 'node:crypto';
import {
  isSafeStorageFileName,
  isSafeStorageNamespace,
  parsePublicStorageReference,
  type StorageObjectMetadata
} from '../../core/storage/index.js';
import type { AuthorizationResource } from '../authorization/index.js';
import { applicationGrantAllows, type PlatformActorContext } from '../context/index.js';
import {
  ATTACHMENT_LIFECYCLES,
  ATTACHMENT_PERMISSION_CODES,
  ATTACHMENT_VISIBILITIES,
  AttachmentError,
  type Attachment,
  type AttachmentDetail,
  type AttachmentListInput,
  type AttachmentOperation,
  type AttachmentOperationHistory,
  type AttachmentSourceReference,
  type AttachmentVisibility,
  type ChangeAttachmentRetentionInput,
  type ChangeAttachmentVisibilityInput,
  type LegacyAttachmentReconciliation,
  type LegacyAttachmentSnapshot,
  type RegisterAttachmentInput,
  type RemoveAttachmentInput
} from './model.js';
import type { AttachmentRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface AttachmentDirectoryPerson {
  organizationUnitId: string;
  employmentStatus: string;
  name: string;
}

export interface AttachmentDirectoryOrganizationUnit {
  status: string;
  name?: string | null;
}

export interface AttachmentServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  findStorageMetadata(kind: string, fileName: string): Promise<StorageObjectMetadata | null>;
  findPerson(id: string): Promise<AttachmentDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<AttachmentDirectoryOrganizationUnit | null>;
}

export class AttachmentService {
  private readonly clock: () => Date;
  private readonly createId: () => string;

  constructor(private readonly repository: AttachmentRepository, private readonly options: AttachmentServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async registerAttachment(context: PlatformActorContext, input: RegisterAttachmentInput): Promise<AttachmentDetail> {
    const draft = await this.prepareDraft(context, input);
    const resource = resourceForAttachment(draft.record);
    await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.create, resource);
    if (draft.record.visibility !== 'private') {
      await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.manage, resource);
    }
    if (draft.record.retainUntil !== null || draft.record.legalHold) {
      await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.retentionManage, resource);
    }

    const existingByKey = await this.repository.findAttachmentByKey(draft.record.sourceAppId, draft.record.attachmentKey);
    if (existingByKey) return this.returnIdempotent(existingByKey, draft.payloadHash, 'ATTACHMENT_KEY_CONFLICT');
    if (draft.record.idempotencyKey) {
      const existing = await this.repository.findAttachmentByIdempotencyKey(draft.record.sourceAppId, draft.record.idempotencyKey);
      if (existing) return this.returnIdempotent(existing, draft.payloadHash, 'IDEMPOTENCY_CONFLICT');
    }
    if (await this.repository.findAttachmentByStorage(draft.record.storageKind, draft.record.storageFileName)) {
      throw new AttachmentError('STORAGE_REFERENCE_CONFLICT', '存储对象已关联其他附件');
    }

    const operation = this.operation(context, draft.record.id, 'registered', null, draft.record, null, draft.record.createdAt);
    const saved = await this.repository.createAttachment(draft.record, operation);
    return this.detail(saved);
  }

  async getAttachment(context: PlatformActorContext, attachmentId: string): Promise<AttachmentDetail> {
    const attachment = await this.requireReadable(context, uuid(attachmentId, 'attachment id'));
    return this.detail(attachment);
  }

  async listAttachments(context: PlatformActorContext, input: AttachmentListInput = {}): Promise<Attachment[]> {
    const normalized = normalizeListInput(input);
    const candidates = await this.repository.listAttachments(normalized);
    const readable: Attachment[] = [];
    for (const attachment of candidates) {
      if (await this.canRead(context, attachment)) readable.push(attachment);
    }
    return readable;
  }

  async changeVisibility(context: PlatformActorContext, input: ChangeAttachmentVisibilityInput): Promise<AttachmentDetail> {
    const current = await this.requireAttachment(uuid(input.attachmentId, 'attachment id'));
    await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.manage, resourceForAttachment(current));
    this.requireActive(current);
    const visibility = normalizeVisibility(input.visibility);
    if (visibility === current.visibility) return this.detail(current);
    const now = this.nowIso();
    const next = { ...current, visibility, updatedAt: now };
    const saved = await this.repository.updateAttachment(
      next,
      this.operation(context, current.id, 'visibility_changed', current, next, input.note, now)
    );
    return this.detail(saved);
  }

  async changeRetention(context: PlatformActorContext, input: ChangeAttachmentRetentionInput): Promise<AttachmentDetail> {
    const current = await this.requireAttachment(uuid(input.attachmentId, 'attachment id'));
    await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.retentionManage, resourceForAttachment(current));
    this.requireActive(current);
    if (input.retainUntil === undefined && input.legalHold === undefined) {
      throw new AttachmentError('RETENTION_CHANGE_REQUIRED', '必须提供保留期限或法律保全状态');
    }
    if (input.legalHold !== undefined && typeof input.legalHold !== 'boolean') {
      throw new AttachmentError('INVALID_LEGAL_HOLD', '法律保全状态无效');
    }
    const retainUntil = input.retainUntil === undefined
      ? current.retainUntil
      : normalizeFutureDate(input.retainUntil, this.clock(), 'retain until');
    const legalHold = input.legalHold ?? current.legalHold;
    if (retainUntil === current.retainUntil && legalHold === current.legalHold) return this.detail(current);
    const now = this.nowIso();
    const next = { ...current, retainUntil, legalHold, updatedAt: now };
    const saved = await this.repository.updateAttachment(
      next,
      this.operation(context, current.id, 'retention_changed', current, next, input.note, now)
    );
    return this.detail(saved);
  }

  async removeAttachment(context: PlatformActorContext, input: RemoveAttachmentInput): Promise<AttachmentDetail> {
    const current = await this.requireAttachment(uuid(input.attachmentId, 'attachment id'));
    await this.requireAuthorized(context, ATTACHMENT_PERMISSION_CODES.remove, resourceForAttachment(current));
    if (current.lifecycle === 'removed') return this.detail(current);
    if (current.legalHold) throw new AttachmentError('ATTACHMENT_LEGAL_HOLD', '附件处于法律保全状态，不允许移除');
    if (current.retainUntil === null) throw new AttachmentError('ATTACHMENT_RETAINED_INDEFINITELY', '附件默认无限期保留，不允许移除');
    const now = this.nowIso();
    if (current.retainUntil > now) throw new AttachmentError('ATTACHMENT_RETENTION_ACTIVE', '附件仍在保留期内，不允许移除');
    const next = { ...current, lifecycle: 'removed' as const, updatedAt: now, removedAt: now };
    const saved = await this.repository.updateAttachment(
      next,
      this.operation(context, current.id, 'removed', current, next, input.note, now)
    );
    return this.detail(saved);
  }

  private async prepareDraft(context: PlatformActorContext, input: RegisterAttachmentInput) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AttachmentError('INVALID_ATTACHMENT_INPUT', '附件登记输入无效');
    const source = normalizeSource(input.source);
    assertExecutionSource(context, source.appId);
    const storage = normalizeStorageReference(input.storage);
    const metadata = await this.requireStorageMetadata(storage.kind, storage.fileName);
    const uploader = await this.resolveUploader(context, input.uploaderPersonId);
    const ownerOrganizationUnitId = input.ownerOrganizationUnitId === undefined || input.ownerOrganizationUnitId === null
      ? uploader?.organizationUnitId ?? null
      : uuid(input.ownerOrganizationUnitId, 'owner organization unit id');
    const owner = ownerOrganizationUnitId ? await this.requireActiveOrganization(ownerOrganizationUnitId) : null;
    const now = this.nowIso();
    const retainUntil = normalizeFutureDate(input.retainUntil ?? null, this.clock(), 'retain until');
    if (input.legalHold !== undefined && typeof input.legalHold !== 'boolean') throw new AttachmentError('INVALID_LEGAL_HOLD', '法律保全状态无效');
    const identity = {
      source,
      attachmentKey: boundedText(input.attachmentKey, 260, 'attachment key'),
      idempotencyKey: normalizeOptionalText(input.idempotencyKey, 200),
      purpose: boundedText(input.purpose, 100, 'attachment purpose'),
      storage,
      originalFileName: boundedText(input.originalFileName, 500, 'original file name'),
      metadata,
      uploaderPersonId: uploader?.id ?? null,
      uploaderSnapshot: uploader ? { personId: uploader.id, name: uploader.name, organizationUnitId: uploader.organizationUnitId } : null,
      ownerOrganizationUnitId,
      ownerOrganizationSnapshot: owner ? { organizationUnitId: ownerOrganizationUnitId!, name: owner.name ?? null } : null,
      visibility: normalizeVisibility(input.visibility ?? 'private'),
      retainUntil,
      legalHold: input.legalHold ?? false
    };
    const payloadHashValue = payloadHash(identity);
    const record: Attachment = {
      id: uuid(input.id ?? this.createId(), 'attachment id'),
      sourceAppId: source.appId,
      sourceEntityType: source.entityType,
      sourceEntityId: source.entityId,
      attachmentKey: identity.attachmentKey,
      idempotencyKey: identity.idempotencyKey,
      idempotencyPayloadHash: payloadHashValue,
      purpose: identity.purpose,
      storageKind: storage.kind,
      storageFileName: storage.fileName,
      originalFileName: identity.originalFileName,
      contentType: metadata.contentType,
      sizeBytes: metadata.sizeBytes,
      sha256: metadata.sha256,
      uploaderPersonId: identity.uploaderPersonId,
      uploaderSnapshot: identity.uploaderSnapshot,
      ownerOrganizationUnitId,
      ownerOrganizationSnapshot: identity.ownerOrganizationSnapshot,
      visibility: identity.visibility,
      lifecycle: 'active',
      retainUntil,
      legalHold: identity.legalHold,
      createdByActorType: context.actorType,
      createdAt: now,
      updatedAt: now,
      removedAt: null
    };
    return { record, payloadHash: payloadHashValue };
  }

  private async resolveUploader(context: PlatformActorContext, value: string | null | undefined) {
    const requestedId = value ? uuid(value, 'uploader person id') : null;
    if (context.actorType === 'person') {
      if (requestedId && requestedId !== context.person.id) {
        throw new AttachmentError('UPLOADER_MISMATCH', '人员执行上下文不能伪造附件上传人');
      }
      return { id: context.person.id, ...await this.requireActivePerson(context.person.id) };
    }
    return requestedId ? { id: requestedId, ...await this.requireActivePerson(requestedId) } : null;
  }

  private async requireStorageMetadata(kind: string, fileName: string) {
    const metadata = await this.options.findStorageMetadata(kind, fileName);
    if (!metadata) throw new AttachmentError('STORAGE_OBJECT_NOT_FOUND', '存储对象不存在');
    if (metadata.kind !== kind || metadata.fileName !== fileName) throw new AttachmentError('STORAGE_METADATA_MISMATCH', '存储元数据与对象引用不匹配');
    const sizeBytes = nonNegativeInteger(metadata.sizeBytes, 'storage size');
    const sha256 = normalizeSha256(metadata.sha256);
    const contentType = boundedText(metadata.contentType, 200, 'storage content type');
    if (Number.isNaN(new Date(metadata.createdAt).getTime())) throw new AttachmentError('INVALID_STORAGE_METADATA', '存储对象创建时间无效');
    return { ...metadata, sizeBytes, sha256, contentType };
  }

  private async requireActivePerson(personId: string) {
    const person = await this.options.findPerson(personId);
    if (!person) throw new AttachmentError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new AttachmentError('PERSON_INACTIVE', '人员不在岗');
    const organizationUnitId = uuid(person.organizationUnitId, 'person organization unit id');
    return { ...person, organizationUnitId, name: boundedText(person.name, 120, 'person name') };
  }

  private async requireActiveOrganization(organizationUnitId: string) {
    const organization = await this.options.findOrganizationUnit(organizationUnitId);
    if (!organization) throw new AttachmentError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (organization.status !== 'active') throw new AttachmentError('ORGANIZATION_INACTIVE', '组织未启用');
    return { ...organization, name: normalizeOptionalText(organization.name, 200) };
  }

  private async requireAttachment(id: string) {
    const attachment = await this.repository.findAttachmentById(id);
    if (!attachment) throw new AttachmentError('ATTACHMENT_NOT_FOUND', '附件不存在');
    return attachment;
  }

  private async requireReadable(context: PlatformActorContext, id: string) {
    const attachment = await this.requireAttachment(id);
    if (!await this.canRead(context, attachment)) throw new AttachmentError('ATTACHMENT_ACCESS_DENIED', '无权查看附件元数据');
    return attachment;
  }

  private async canRead(context: PlatformActorContext, attachment: Attachment) {
    if (!await applicationGrantAllows(context, ATTACHMENT_PERMISSION_CODES.read, resourceForAttachment(attachment))) return false;
    if (attachment.visibility === 'application' && ownSourceExecution(context, attachment.sourceAppId)) return true;
    if (context.actorType === 'person') {
      if (attachment.uploaderPersonId === context.person.id) return true;
      if (attachment.visibility === 'organization' && attachment.ownerOrganizationUnitId === context.person.organization.id) return true;
    }
    return (await context.authorize(ATTACHMENT_PERMISSION_CODES.read, resourceForAttachment(attachment))).allowed;
  }

  private requireActive(attachment: Attachment) {
    if (attachment.lifecycle === 'removed') throw new AttachmentError('ATTACHMENT_REMOVED', '附件已逻辑移除');
  }

  private async requireAuthorized(context: PlatformActorContext, permissionCode: string, resource: AuthorizationResource) {
    if (!(await context.authorize(permissionCode, resource)).allowed) {
      throw new AttachmentError('ATTACHMENT_PERMISSION_DENIED', `缺少权限: ${permissionCode}`);
    }
  }

  private async returnIdempotent(attachment: Attachment, hash: string, conflictCode: 'IDEMPOTENCY_CONFLICT' | 'ATTACHMENT_KEY_CONFLICT') {
    if (attachment.idempotencyPayloadHash !== hash) throw new AttachmentError(conflictCode, '相同附件键或幂等键的请求内容不同');
    return this.detail(attachment);
  }

  private operation(
    context: PlatformActorContext,
    attachmentId: string,
    operation: AttachmentOperation,
    before: unknown,
    after: unknown,
    note: string | null | undefined,
    occurredAt = this.nowIso()
  ): AttachmentOperationHistory {
    return {
      id: uuid(this.createId(), 'attachment operation id'),
      attachmentId,
      operation,
      actorType: context.actorType,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      serviceIdentityId: context.actorType === 'service' ? context.execution.serviceIdentityId : null,
      executionType: context.execution.type,
      sourceAppId: context.execution.type === 'platform' ? null : context.execution.appId,
      requestId: normalizeOptionalText(context.request.requestId, 120),
      traceId: normalizeOptionalText(context.request.traceId, 120),
      note: normalizeOptionalText(note, 2000),
      before: operationPayload(before),
      after: operationPayload(after),
      occurredAt
    };
  }

  private async detail(attachment: Attachment): Promise<AttachmentDetail> {
    return { attachment, operationHistory: await this.repository.listOperationHistory(attachment.id) };
  }

  private nowIso() {
    return this.clock().toISOString();
  }
}

export function createAttachmentService(repository: AttachmentRepository, options: AttachmentServiceOptions) {
  return new AttachmentService(repository, options);
}

export function reconcileLegacyAttachments(snapshot: LegacyAttachmentSnapshot): LegacyAttachmentReconciliation {
  const fileAssets = snapshot.fileAssets ?? [];
  const storageObjects = snapshot.storageObjects ?? [];
  const publicReferences = snapshot.publicReferences ?? [];
  const issues: LegacyAttachmentReconciliation['issues'] = [];
  const kindCounts: Record<string, number> = {};
  const purposeCounts: Record<string, number> = {};
  const metadataKeys = new Set<string>();
  const storageKeys = new Set<string>();
  let uploaderCoverageCount = 0;
  let ownerOrganizationCoverageCount = 0;
  let businessAssociationCoverageCount = 0;
  let publicReferenceObjectCoverageCount = 0;

  for (const object of storageObjects) {
    const sourceId = `${object.kind}/${object.fileName}`;
    if (!safeStorageReference(object.kind, object.fileName)) {
      issues.push({ code: 'UNSAFE_STORAGE_REFERENCE', sourceId });
      continue;
    }
    const key = storageKey(object.kind, object.fileName);
    storageKeys.add(key);
    if (!Number.isSafeInteger(object.sizeBytes)
      || object.sizeBytes < 0
      || !/^[0-9a-f]{64}$/i.test(object.sha256)
      || Number.isNaN(new Date(object.createdAt).getTime())
      || !validContentType(object.contentType)) {
      issues.push({ code: 'INVALID_STORAGE_METADATA', sourceId });
    }
  }

  for (const asset of fileAssets) {
    const sourceId = asset.id?.trim() || `${asset.kind}/${asset.fileName}`;
    kindCounts[asset.kind] = (kindCounts[asset.kind] ?? 0) + 1;
    const purpose = asset.purpose?.trim() || '(missing)';
    purposeCounts[purpose] = (purposeCounts[purpose] ?? 0) + 1;
    if (asset.uploaderId?.trim()) uploaderCoverageCount += 1;
    if (asset.workgroupId?.trim()) ownerOrganizationCoverageCount += 1;
    if (asset.entityKey?.trim()) businessAssociationCoverageCount += 1;
    else issues.push({ code: 'MISSING_BUSINESS_ASSOCIATION', sourceId });
    if (!asset.uploaderId?.trim() && !asset.workgroupId?.trim()) issues.push({ code: 'MISSING_OWNERSHIP', sourceId });
    if (!safeStorageReference(asset.kind, asset.fileName)) {
      issues.push({ code: 'UNSAFE_STORAGE_REFERENCE', sourceId });
      continue;
    }
    const key = storageKey(asset.kind, asset.fileName);
    if (metadataKeys.has(key)) issues.push({ code: 'DUPLICATE_STORAGE_REFERENCE', sourceId });
    metadataKeys.add(key);
    if (!storageKeys.has(key)) issues.push({ code: 'METADATA_WITHOUT_OBJECT', sourceId });
  }

  for (const object of storageObjects) {
    if (!safeStorageReference(object.kind, object.fileName)) continue;
    if (!metadataKeys.has(storageKey(object.kind, object.fileName))) {
      issues.push({ code: 'OBJECT_WITHOUT_METADATA', sourceId: `${object.kind}/${object.fileName}` });
    }
  }

  for (const reference of publicReferences) {
    const parsed = parsePublicStorageReference(reference.value);
    if (!parsed) {
      issues.push({ code: 'UNSAFE_PUBLIC_REFERENCE', sourceId: reference.id });
      continue;
    }
    if (storageKeys.has(storageKey(parsed.kind, parsed.fileName))) publicReferenceObjectCoverageCount += 1;
    else issues.push({ code: 'PUBLIC_REFERENCE_WITHOUT_OBJECT', sourceId: reference.id });
  }

  return {
    metadataCount: fileAssets.length,
    storageObjectCount: storageObjects.length,
    publicReferenceCount: publicReferences.length,
    kindCounts,
    purposeCounts,
    uploaderCoverageCount,
    ownerOrganizationCoverageCount,
    businessAssociationCoverageCount,
    publicReferenceObjectCoverageCount,
    issues
  };
}

function normalizeSource(source: AttachmentSourceReference) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new AttachmentError('INVALID_SOURCE', '附件来源无效');
  return {
    appId: appId(source.appId),
    entityType: boundedText(source.entityType, 100, 'source entity type'),
    entityId: boundedText(source.entityId, 200, 'source entity id')
  };
}

function normalizeStorageReference(storage: RegisterAttachmentInput['storage']) {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new AttachmentError('INVALID_STORAGE_REFERENCE', '存储对象引用无效');
  if (!isSafeStorageNamespace(storage.kind)) throw new AttachmentError('INVALID_STORAGE_NAMESPACE', '存储命名空间无效');
  if (!isSafeStorageFileName(storage.fileName)) throw new AttachmentError('INVALID_STORAGE_FILE_NAME', '存储文件名无效');
  if (storage.fileName.length > 500) throw new AttachmentError('STORAGE_FILE_NAME_TOO_LONG', '存储文件名超过长度限制');
  return { kind: storage.kind, fileName: storage.fileName };
}

function normalizeListInput(input: AttachmentListInput): AttachmentListInput {
  return {
    sourceAppId: input.sourceAppId ? appId(input.sourceAppId) : undefined,
    sourceEntityType: input.sourceEntityType ? boundedText(input.sourceEntityType, 100, 'source entity type') : undefined,
    sourceEntityId: input.sourceEntityId ? boundedText(input.sourceEntityId, 200, 'source entity id') : undefined,
    uploaderPersonId: input.uploaderPersonId ? uuid(input.uploaderPersonId, 'uploader person id') : undefined,
    ownerOrganizationUnitId: input.ownerOrganizationUnitId ? uuid(input.ownerOrganizationUnitId, 'owner organization unit id') : undefined,
    visibility: normalizeVisibilityFilter(input.visibility),
    lifecycle: normalizeLifecycleFilter(input.lifecycle),
    limit: input.limit
  };
}

function normalizeVisibilityFilter(value: AttachmentListInput['visibility']) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(normalizeVisibility) : normalizeVisibility(value as AttachmentVisibility);
}

function normalizeLifecycleFilter(value: AttachmentListInput['lifecycle']) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (!ATTACHMENT_LIFECYCLES.includes(entry as Attachment['lifecycle'])) throw new AttachmentError('INVALID_ATTACHMENT_LIFECYCLE', '附件生命周期无效');
    return entry as Attachment['lifecycle'];
  });
}

function normalizeVisibility(value: AttachmentVisibility) {
  if (!ATTACHMENT_VISIBILITIES.includes(value)) throw new AttachmentError('INVALID_ATTACHMENT_VISIBILITY', '附件可见性无效');
  return value;
}

function normalizeFutureDate(value: Date | null, now: Date, label: string) {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new AttachmentError('INVALID_DATE', `${label} 无效`);
  if (value.getTime() <= now.getTime()) throw new AttachmentError('RETENTION_DEADLINE_NOT_FUTURE', '保留期限必须是未来时间');
  return value.toISOString();
}

function normalizeSha256(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new AttachmentError('INVALID_STORAGE_SHA256', '存储对象 SHA-256 无效');
  return value.toLowerCase();
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AttachmentError('INVALID_NON_NEGATIVE_INTEGER', `${label} 无效`);
  return value as number;
}

function resourceForAttachment(attachment: Pick<Attachment, 'uploaderPersonId' | 'ownerOrganizationUnitId'>): AuthorizationResource {
  return {
    ownerPersonId: attachment.uploaderPersonId,
    organizationUnitId: attachment.ownerOrganizationUnitId,
    targets: attachment.ownerOrganizationUnitId ? [{ type: 'organization', id: attachment.ownerOrganizationUnitId }] : []
  };
}

function assertExecutionSource(context: PlatformActorContext, sourceAppId: string) {
  if (context.execution.type !== 'platform' && context.execution.appId !== sourceAppId) {
    throw new AttachmentError('SOURCE_APP_MISMATCH', '执行上下文与附件来源应用不一致');
  }
}

function ownSourceExecution(context: PlatformActorContext, sourceAppId: string) {
  return context.execution.type !== 'platform' && context.execution.appId === sourceAppId;
}

function appId(value: string) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,98}[a-z0-9]$/.test(value)) throw new AttachmentError('INVALID_APP_ID', '应用 ID 无效');
  return value;
}

function uuid(value: string, label: string) {
  if (typeof value !== 'string') throw new AttachmentError('INVALID_UUID', `${label} 无效`);
  const text = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new AttachmentError('INVALID_UUID', `${label} 无效`);
  }
  return text.toLowerCase();
}

function boundedText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') throw new AttachmentError('INVALID_TEXT', `${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new AttachmentError('TEXT_REQUIRED', `${label} 不能为空`);
  if (text.length > maxLength) throw new AttachmentError('TEXT_TOO_LONG', `${label} 超过长度限制`);
  return text;
}

function normalizeOptionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new AttachmentError('INVALID_TEXT', '可选文本必须是字符串');
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw new AttachmentError('TEXT_TOO_LONG', '可选文本超过长度限制');
  return text;
}

function payloadHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(normalizePayload(value))).digest('hex');
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizePayload(entry)]));
  }
  return value;
}

function operationPayload(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const normalized = normalizePayload(value);
  return typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { value: normalized };
}

function safeStorageReference(kind: string, fileName: string) {
  return isSafeStorageNamespace(kind) && isSafeStorageFileName(fileName) && fileName.length <= 500;
}

function storageKey(kind: string, fileName: string) {
  return `${kind}\u0000${fileName}`;
}

function validContentType(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200;
}
