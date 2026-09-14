import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import {
  AttachmentError,
  type Attachment,
  type AttachmentListInput,
  type AttachmentOperationHistory
} from './model.js';

export interface AttachmentRepository {
  createAttachment(record: Attachment, operation: AttachmentOperationHistory): Promise<Attachment>;
  updateAttachment(record: Attachment, operation: AttachmentOperationHistory): Promise<Attachment>;
  findAttachmentById(id: string): Promise<Attachment | null>;
  findAttachmentByKey(sourceAppId: string, attachmentKey: string): Promise<Attachment | null>;
  findAttachmentByIdempotencyKey(sourceAppId: string, idempotencyKey: string): Promise<Attachment | null>;
  findAttachmentByStorage(kind: string, fileName: string): Promise<Attachment | null>;
  listAttachments(input?: AttachmentListInput): Promise<Attachment[]>;
  listOperationHistory(attachmentId: string): Promise<AttachmentOperationHistory[]>;
}

export interface MemoryAttachmentRepository extends AttachmentRepository {
  records(): { attachments: Attachment[]; operationHistory: AttachmentOperationHistory[] };
}

export function createMemoryAttachmentRepository(seed: {
  attachments?: readonly Attachment[];
  operationHistory?: readonly AttachmentOperationHistory[];
} = {}): MemoryAttachmentRepository {
  const attachments = toMap(seed.attachments);
  const operationHistory = toMap(seed.operationHistory);

  return {
    async createAttachment(record, operation) {
      assertUniqueId(attachments, record.id, 'ATTACHMENT_ID_CONFLICT');
      assertUniqueAttachment(attachments, record);
      assertValidOperation(operationHistory, operation, record.id);
      attachments.set(record.id, clone(record));
      operationHistory.set(operation.id, clone(operation));
      return clone(record);
    },
    async updateAttachment(record, operation) {
      const current = attachments.get(record.id);
      if (!current) throw new AttachmentError('ATTACHMENT_NOT_FOUND', '附件不存在');
      assertImmutableIdentity(current, record);
      assertCurrentState(current, operation);
      assertValidOperation(operationHistory, operation, record.id);
      attachments.set(record.id, clone(record));
      operationHistory.set(operation.id, clone(operation));
      return clone(record);
    },
    async findAttachmentById(id) {
      return cloneOrNull(attachments.get(id));
    },
    async findAttachmentByKey(sourceAppId, attachmentKey) {
      return cloneOrNull([...attachments.values()].find((record) => record.sourceAppId === sourceAppId && record.attachmentKey === attachmentKey));
    },
    async findAttachmentByIdempotencyKey(sourceAppId, idempotencyKey) {
      return cloneOrNull([...attachments.values()].find((record) => record.sourceAppId === sourceAppId && record.idempotencyKey === idempotencyKey));
    },
    async findAttachmentByStorage(kind, fileName) {
      return cloneOrNull([...attachments.values()].find((record) => record.storageKind === kind && record.storageFileName === fileName));
    },
    async listAttachments(input = {}) {
      return [...attachments.values()]
        .filter((record) => matchesList(record, input))
        .map(clone)
        .sort(compareUpdated)
        .slice(0, normalizedLimit(input.limit));
    },
    async listOperationHistory(attachmentId) {
      return [...operationHistory.values()]
        .filter((record) => record.attachmentId === attachmentId)
        .map(clone)
        .sort(compareOperations);
    },
    records() {
      return {
        attachments: [...attachments.values()].map(clone),
        operationHistory: [...operationHistory.values()].map(clone)
      };
    }
  };
}

export function createPostgresAttachmentRepository(client: QueryableClient): AttachmentRepository {
  return {
    async createAttachment(record, operation) {
      if (operation.attachmentId !== record.id) throw new AttachmentError('ATTACHMENT_OPERATION_MISMATCH', '附件操作历史与附件不匹配');
      return runDatabaseTransaction(client, async (transaction) => {
        const saved = await insertAttachment(transaction, record);
        await insertOperation(transaction, operation);
        return saved;
      });
    },
    async updateAttachment(record, operation) {
      if (operation.attachmentId !== record.id) throw new AttachmentError('ATTACHMENT_OPERATION_MISMATCH', '附件操作历史与附件不匹配');
      return runDatabaseTransaction(client, async (transaction) => {
        const current = optional(
          await transaction.query('SELECT * FROM platform_attachments WHERE id=$1 FOR UPDATE', [record.id]),
          mapAttachment
        );
        if (!current) throw new AttachmentError('ATTACHMENT_NOT_FOUND', '附件不存在');
        assertImmutableIdentity(current, record);
        assertCurrentState(current, operation);
        const saved = mapAttachment(requireRow(await transaction.query(
          `UPDATE platform_attachments
           SET visibility=$2,lifecycle=$3,retain_until=$4,legal_hold=$5,updated_at=$6,removed_at=$7
           WHERE id=$1 RETURNING *`,
          [record.id, record.visibility, record.lifecycle, record.retainUntil, record.legalHold, record.updatedAt, record.removedAt]
        )));
        await insertOperation(transaction, operation);
        return saved;
      });
    },
    async findAttachmentById(id) {
      return optional(await client.query('SELECT * FROM platform_attachments WHERE id=$1', [id]), mapAttachment);
    },
    async findAttachmentByKey(sourceAppId, attachmentKey) {
      return optional(await client.query('SELECT * FROM platform_attachments WHERE source_app_id=$1 AND attachment_key=$2', [sourceAppId, attachmentKey]), mapAttachment);
    },
    async findAttachmentByIdempotencyKey(sourceAppId, idempotencyKey) {
      return optional(await client.query('SELECT * FROM platform_attachments WHERE source_app_id=$1 AND idempotency_key=$2', [sourceAppId, idempotencyKey]), mapAttachment);
    },
    async findAttachmentByStorage(kind, fileName) {
      return optional(await client.query('SELECT * FROM platform_attachments WHERE storage_kind=$1 AND storage_file_name=$2', [kind, fileName]), mapAttachment);
    },
    async listAttachments(input = {}) {
      const { where, values, limit } = buildListWhere(input);
      return rows(await client.query(`SELECT * FROM platform_attachments ${where} ORDER BY updated_at DESC,id LIMIT ${limit}`, values)).map(mapAttachment);
    },
    async listOperationHistory(attachmentId) {
      return rows(await client.query('SELECT * FROM platform_attachment_operation_history WHERE attachment_id=$1 ORDER BY occurred_at,id', [attachmentId])).map(mapOperation);
    }
  };
}

async function insertAttachment(client: QueryableClient, record: Attachment) {
  return mapAttachment(requireRow(await client.query(
    `INSERT INTO platform_attachments
     (id,source_app_id,source_entity_type,source_entity_id,attachment_key,idempotency_key,idempotency_payload_hash,purpose,
      storage_kind,storage_file_name,original_file_name,content_type,size_bytes,sha256,uploader_person_id,uploader_snapshot,
      owner_organization_unit_id,owner_organization_snapshot,visibility,lifecycle,retain_until,legal_hold,created_by_actor_type,
      created_at,updated_at,removed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [
      record.id,
      record.sourceAppId,
      record.sourceEntityType,
      record.sourceEntityId,
      record.attachmentKey,
      record.idempotencyKey,
      record.idempotencyPayloadHash,
      record.purpose,
      record.storageKind,
      record.storageFileName,
      record.originalFileName,
      record.contentType,
      record.sizeBytes,
      record.sha256,
      record.uploaderPersonId,
      jsonOrNull(record.uploaderSnapshot),
      record.ownerOrganizationUnitId,
      jsonOrNull(record.ownerOrganizationSnapshot),
      record.visibility,
      record.lifecycle,
      record.retainUntil,
      record.legalHold,
      record.createdByActorType,
      record.createdAt,
      record.updatedAt,
      record.removedAt
    ]
  )));
}

async function insertOperation(client: QueryableClient, record: AttachmentOperationHistory) {
  await client.query(
    `INSERT INTO platform_attachment_operation_history
     (id,attachment_id,operation,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,note,before_payload,after_payload,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
    [record.id, record.attachmentId, record.operation, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, jsonOrNull(record.before), jsonOrNull(record.after), record.occurredAt]
  );
}

function buildListWhere(input: AttachmentListInput) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };
  if (input.sourceAppId) add('source_app_id=?', input.sourceAppId);
  if (input.sourceEntityType) add('source_entity_type=?', input.sourceEntityType);
  if (input.sourceEntityId) add('source_entity_id=?', input.sourceEntityId);
  if (input.uploaderPersonId) add('uploader_person_id=?', input.uploaderPersonId);
  if (input.ownerOrganizationUnitId) add('owner_organization_unit_id=?', input.ownerOrganizationUnitId);
  addArrayClause(clauses, values, 'visibility', input.visibility);
  addArrayClause(clauses, values, 'lifecycle', input.lifecycle);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values, limit: normalizedLimit(input.limit) };
}

function addArrayClause(
  clauses: string[],
  values: unknown[],
  column: string,
  value: string | readonly string[] | undefined
) {
  if (value === undefined) return;
  values.push(Array.isArray(value) ? [...value] : [value]);
  clauses.push(`${column} = ANY($${values.length}::text[])`);
}

function matchesList(record: Attachment, input: AttachmentListInput) {
  if (input.sourceAppId && record.sourceAppId !== input.sourceAppId) return false;
  if (input.sourceEntityType && record.sourceEntityType !== input.sourceEntityType) return false;
  if (input.sourceEntityId && record.sourceEntityId !== input.sourceEntityId) return false;
  if (input.uploaderPersonId && record.uploaderPersonId !== input.uploaderPersonId) return false;
  if (input.ownerOrganizationUnitId && record.ownerOrganizationUnitId !== input.ownerOrganizationUnitId) return false;
  if (!matchesValue(record.visibility, input.visibility)) return false;
  return matchesValue(record.lifecycle, input.lifecycle);
}

function matchesValue(value: string, filter: string | readonly string[] | undefined) {
  if (filter === undefined) return true;
  return (Array.isArray(filter) ? filter : [filter]).includes(value);
}

function assertUniqueAttachment(records: Map<string, Attachment>, record: Attachment) {
  if ([...records.values()].some((entry) => entry.sourceAppId === record.sourceAppId && entry.attachmentKey === record.attachmentKey)) {
    throw new AttachmentError('ATTACHMENT_KEY_CONFLICT', '附件业务键已存在');
  }
  if (record.idempotencyKey && [...records.values()].some((entry) => entry.sourceAppId === record.sourceAppId && entry.idempotencyKey === record.idempotencyKey)) {
    throw new AttachmentError('IDEMPOTENCY_CONFLICT', '附件幂等键已存在');
  }
  if ([...records.values()].some((entry) => entry.storageKind === record.storageKind && entry.storageFileName === record.storageFileName)) {
    throw new AttachmentError('STORAGE_REFERENCE_CONFLICT', '存储对象已关联其他附件');
  }
}

function assertCurrentState(current: Attachment, operation: AttachmentOperationHistory) {
  // Compare mutable state as well as time: two commands can share a millisecond or fixed test clock.
  const before = operation.before;
  if (!before || ['visibility', 'lifecycle', 'retainUntil', 'legalHold', 'updatedAt', 'removedAt']
    .some((key) => before[key] !== current[key as keyof Attachment])) {
    throw new AttachmentError('ATTACHMENT_STATE_CONFLICT', '附件状态已变化，请重新读取后重试');
  }
}

function assertImmutableIdentity(current: Attachment, next: Attachment) {
  const unchanged = current.sourceAppId === next.sourceAppId
    && current.sourceEntityType === next.sourceEntityType
    && current.sourceEntityId === next.sourceEntityId
    && current.attachmentKey === next.attachmentKey
    && current.idempotencyKey === next.idempotencyKey
    && current.idempotencyPayloadHash === next.idempotencyPayloadHash
    && current.purpose === next.purpose
    && current.storageKind === next.storageKind
    && current.storageFileName === next.storageFileName
    && current.originalFileName === next.originalFileName
    && current.contentType === next.contentType
    && current.sha256 === next.sha256
    && current.sizeBytes === next.sizeBytes
    && current.uploaderPersonId === next.uploaderPersonId
    && JSON.stringify(current.uploaderSnapshot) === JSON.stringify(next.uploaderSnapshot)
    && current.ownerOrganizationUnitId === next.ownerOrganizationUnitId
    && JSON.stringify(current.ownerOrganizationSnapshot) === JSON.stringify(next.ownerOrganizationSnapshot)
    && current.createdByActorType === next.createdByActorType
    && current.createdAt === next.createdAt;
  if (!unchanged) throw new AttachmentError('IMMUTABLE_ATTACHMENT_IDENTITY', '附件业务与存储身份不可变更');
}

function assertValidOperation(
  records: Map<string, AttachmentOperationHistory>,
  operation: AttachmentOperationHistory,
  attachmentId: string
) {
  assertUniqueId(records, operation.id, 'ATTACHMENT_OPERATION_ID_CONFLICT');
  if (operation.attachmentId !== attachmentId) {
    throw new AttachmentError('ATTACHMENT_OPERATION_MISMATCH', '附件操作历史与附件不匹配');
  }
}

function assertUniqueId<T>(records: Map<string, T>, id: string, code: string) {
  if (records.has(id)) throw new AttachmentError(code, `平台附件记录 ID 已存在: ${id}`);
}

function normalizedLimit(value: number | undefined) {
  return Number.isSafeInteger(value) && value && value > 0 ? Math.min(value, 500) : 100;
}

function compareUpdated(left: Attachment, right: Attachment) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compareOperations(left: AttachmentOperationHistory, right: AttachmentOperationHistory) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null | undefined): T | null {
  return value ? clone(value) : null;
}

function toMap<T extends { id: string }>(items: readonly T[] | undefined) {
  return new Map((items ?? []).map((item) => [item.id, clone(item)]));
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray((result as { rows?: unknown[] })?.rows) ? (result as { rows: Record<string, unknown>[] }).rows : [];
}

function requireRow(result: unknown) {
  const row = rows(result)[0];
  if (!row) throw new AttachmentError('DATABASE_WRITE_FAILED', '平台附件数据写入失败');
  return row;
}

function optional<T>(result: unknown, mapper: (row: Record<string, unknown>) => T) {
  const row = rows(result)[0];
  return row ? mapper(row) : null;
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new AttachmentError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : text(row, key);
}

function integer(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' || typeof value === 'string' && /^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  throw new AttachmentError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
}

function bool(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'boolean') throw new AttachmentError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function instant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new AttachmentError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function nullableInstant(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : instant(row, key);
}

function jsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new AttachmentError('INVALID_DATABASE_ROW', `字段 ${key} JSON 无效`);
}

function nullableJsonObject(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : jsonObject(row, key);
}

function mapAttachment(row: Record<string, unknown>): Attachment {
  return {
    id: text(row, 'id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    attachmentKey: text(row, 'attachment_key'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    purpose: text(row, 'purpose'),
    storageKind: text(row, 'storage_kind'),
    storageFileName: text(row, 'storage_file_name'),
    originalFileName: text(row, 'original_file_name'),
    contentType: text(row, 'content_type'),
    sizeBytes: integer(row, 'size_bytes'),
    sha256: text(row, 'sha256'),
    uploaderPersonId: nullableText(row, 'uploader_person_id'),
    uploaderSnapshot: nullableJsonObject(row, 'uploader_snapshot') as Attachment['uploaderSnapshot'],
    ownerOrganizationUnitId: nullableText(row, 'owner_organization_unit_id'),
    ownerOrganizationSnapshot: nullableJsonObject(row, 'owner_organization_snapshot') as Attachment['ownerOrganizationSnapshot'],
    visibility: text(row, 'visibility') as Attachment['visibility'],
    lifecycle: text(row, 'lifecycle') as Attachment['lifecycle'],
    retainUntil: nullableInstant(row, 'retain_until'),
    legalHold: bool(row, 'legal_hold'),
    createdByActorType: text(row, 'created_by_actor_type') as Attachment['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at'),
    removedAt: nullableInstant(row, 'removed_at')
  };
}

function mapOperation(row: Record<string, unknown>): AttachmentOperationHistory {
  return {
    id: text(row, 'id'),
    attachmentId: nullableText(row, 'attachment_id'),
    operation: text(row, 'operation') as AttachmentOperationHistory['operation'],
    actorType: text(row, 'actor_type') as AttachmentOperationHistory['actorType'],
    actorPersonId: nullableText(row, 'actor_person_id'),
    serviceIdentityId: nullableText(row, 'service_identity_id'),
    executionType: text(row, 'execution_type') as AttachmentOperationHistory['executionType'],
    sourceAppId: nullableText(row, 'source_app_id'),
    requestId: nullableText(row, 'request_id'),
    traceId: nullableText(row, 'trace_id'),
    note: nullableText(row, 'note'),
    before: nullableJsonObject(row, 'before_payload'),
    after: nullableJsonObject(row, 'after_payload'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
