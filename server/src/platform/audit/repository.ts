import type { QueryableClient } from '../../core/database/index.js';
import {
  BusinessAuditError,
  type BusinessAuditListInput,
  type BusinessAuditRecord
} from './model.js';

export interface BusinessAuditRepository {
  append(record: BusinessAuditRecord): Promise<BusinessAuditRecord>;
  findById(id: string): Promise<BusinessAuditRecord | null>;
  findByAuditKey(businessAppId: string, auditKey: string): Promise<BusinessAuditRecord | null>;
  list(input?: BusinessAuditListInput): Promise<BusinessAuditRecord[]>;
}

export interface MemoryBusinessAuditRepository extends BusinessAuditRepository {
  records(): BusinessAuditRecord[];
}

export function createMemoryBusinessAuditRepository(
  seed: readonly BusinessAuditRecord[] = []
): MemoryBusinessAuditRepository {
  const records = new Map(seed.map((record) => [record.id, clone(record)]));

  return {
    async append(record) {
      if (records.has(record.id)) throw new BusinessAuditError('AUDIT_ID_CONFLICT', '业务审计记录 ID 已存在');
      if (record.auditKey && [...records.values()].some((entry) => (
        entry.business.appId === record.business.appId && entry.auditKey === record.auditKey
      ))) {
        throw new BusinessAuditError('AUDIT_KEY_CONFLICT', '业务审计幂等键已存在');
      }
      records.set(record.id, clone(record));
      return clone(record);
    },
    async findById(id) {
      return cloneOrNull(records.get(id));
    },
    async findByAuditKey(businessAppId, auditKey) {
      return cloneOrNull([...records.values()].find((record) => (
        record.business.appId === businessAppId && record.auditKey === auditKey
      )));
    },
    async list(input = {}) {
      return [...records.values()]
        .filter((record) => matchesList(record, input))
        .sort(compareOccurred)
        .slice(0, normalizedLimit(input.limit))
        .map(clone);
    },
    records() {
      return [...records.values()].sort(compareOccurred).map(clone);
    }
  };
}

export function createPostgresBusinessAuditRepository(client: QueryableClient): BusinessAuditRepository {
  return {
    async append(record) {
      return mapRecord(requireRow(await client.query(
        `INSERT INTO platform_business_audit_records
         (id,audit_key,idempotency_payload_hash,operation_code,outcome,actor_type,actor_person_id,
          service_identity_id,actor_snapshot,trusted_identity_source,execution_type,execution_app_id,
          business_app_id,entity_type,entity_id,entity_display_label,owner_person_id,
          owner_organization_unit_id,changed_fields,before_summary,after_summary,result_summary,
          reason_code,reason_text,error_code,request_id,trace_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26,$27,$28)
         RETURNING *`,
        [
          record.id,
          record.auditKey,
          record.idempotencyPayloadHash,
          record.operation.code,
          record.operation.outcome,
          record.actor.type,
          record.actor.personId,
          record.actor.serviceIdentityId,
          jsonOrNull(record.actor.personSnapshot),
          record.source.identitySource,
          record.source.executionType,
          record.source.executionAppId,
          record.business.appId,
          record.business.entityType,
          record.business.entityId,
          record.business.displayLabel,
          record.business.ownerPersonId,
          record.business.ownerOrganizationUnitId,
          JSON.stringify(record.change?.changedFields ?? []),
          jsonOrNull(record.change?.before ?? null),
          jsonOrNull(record.change?.after ?? null),
          jsonOrNull(record.resultSummary),
          record.reason?.code ?? null,
          record.reason?.text ?? null,
          record.errorCode,
          record.source.requestId,
          record.source.traceId,
          record.occurredAt
        ]
      )));
    },
    async findById(id) {
      return optional(await client.query('SELECT * FROM platform_business_audit_records WHERE id=$1', [id]));
    },
    async findByAuditKey(businessAppId, auditKey) {
      return optional(await client.query(
        'SELECT * FROM platform_business_audit_records WHERE business_app_id=$1 AND audit_key=$2',
        [businessAppId, auditKey]
      ));
    },
    async list(input = {}) {
      const { where, values, limit } = buildListWhere(input);
      return rows(await client.query(
        `SELECT * FROM platform_business_audit_records ${where} ORDER BY occurred_at DESC,id LIMIT ${limit}`,
        values
      )).map(mapRecord);
    }
  };
}

function buildListWhere(input: BusinessAuditListInput) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown, operator = '=') => {
    values.push(value);
    clauses.push(`${column} ${operator} $${values.length}`);
  };
  if (input.operationCode) add('operation_code', input.operationCode);
  if (input.outcome) add('outcome', input.outcome);
  if (input.actorPersonId) add('actor_person_id', input.actorPersonId);
  if (input.sourceApplicationId) add('execution_app_id', input.sourceApplicationId);
  if (input.businessAppId) add('business_app_id', input.businessAppId);
  if (input.entityType) add('entity_type', input.entityType);
  if (input.entityId) add('entity_id', input.entityId);
  if (input.ownerPersonId) add('owner_person_id', input.ownerPersonId);
  if (input.ownerOrganizationUnitId) add('owner_organization_unit_id', input.ownerOrganizationUnitId);
  if (input.requestId) add('request_id', input.requestId);
  if (input.traceId) add('trace_id', input.traceId);
  if (input.occurredFrom) add('occurred_at', toIso(input.occurredFrom), '>=');
  if (input.occurredTo) add('occurred_at', toIso(input.occurredTo), '<=');
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
    limit: normalizedLimit(input.limit)
  };
}

function matchesList(record: BusinessAuditRecord, input: BusinessAuditListInput) {
  if (input.operationCode && record.operation.code !== input.operationCode) return false;
  if (input.outcome && record.operation.outcome !== input.outcome) return false;
  if (input.actorPersonId && record.actor.personId !== input.actorPersonId) return false;
  if (input.sourceApplicationId && record.source.executionAppId !== input.sourceApplicationId) return false;
  if (input.businessAppId && record.business.appId !== input.businessAppId) return false;
  if (input.entityType && record.business.entityType !== input.entityType) return false;
  if (input.entityId && record.business.entityId !== input.entityId) return false;
  if (input.ownerPersonId && record.business.ownerPersonId !== input.ownerPersonId) return false;
  if (input.ownerOrganizationUnitId && record.business.ownerOrganizationUnitId !== input.ownerOrganizationUnitId) return false;
  if (input.requestId && record.source.requestId !== input.requestId) return false;
  if (input.traceId && record.source.traceId !== input.traceId) return false;
  if (input.occurredFrom && record.occurredAt < toIso(input.occurredFrom)) return false;
  if (input.occurredTo && record.occurredAt > toIso(input.occurredTo)) return false;
  return true;
}

function mapRecord(row: Record<string, unknown>): BusinessAuditRecord {
  const actorType = text(row, 'actor_type') as BusinessAuditRecord['actor']['type'];
  const changedFields = jsonArray(row, 'changed_fields').map((value) => {
    if (typeof value !== 'string') throw new BusinessAuditError('INVALID_DATABASE_ROW', '业务审计 changed_fields 无效');
    return value;
  });
  const before = nullableJsonObject(row, 'before_summary');
  const after = nullableJsonObject(row, 'after_summary');
  return {
    id: text(row, 'id'),
    auditKey: nullableText(row, 'audit_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    operation: {
      code: text(row, 'operation_code'),
      outcome: text(row, 'outcome') as BusinessAuditRecord['operation']['outcome']
    },
    actor: {
      type: actorType,
      personId: nullableText(row, 'actor_person_id'),
      serviceIdentityId: nullableText(row, 'service_identity_id'),
      personSnapshot: nullableJsonObject(row, 'actor_snapshot') as BusinessAuditRecord['actor']['personSnapshot']
    },
    business: {
      appId: text(row, 'business_app_id'),
      entityType: text(row, 'entity_type'),
      entityId: text(row, 'entity_id'),
      displayLabel: nullableText(row, 'entity_display_label'),
      ownerPersonId: nullableText(row, 'owner_person_id'),
      ownerOrganizationUnitId: nullableText(row, 'owner_organization_unit_id')
    },
    change: changedFields.length || before || after ? { changedFields, before, after } : null,
    source: {
      identitySource: text(row, 'trusted_identity_source') as BusinessAuditRecord['source']['identitySource'],
      executionType: text(row, 'execution_type') as BusinessAuditRecord['source']['executionType'],
      executionAppId: nullableText(row, 'execution_app_id'),
      requestId: text(row, 'request_id'),
      traceId: text(row, 'trace_id')
    },
    reason: nullableReason(row),
    resultSummary: nullableJsonObject(row, 'result_summary'),
    errorCode: nullableText(row, 'error_code'),
    occurredAt: instant(row, 'occurred_at')
  };
}

function nullableReason(row: Record<string, unknown>) {
  const code = nullableText(row, 'reason_code');
  const textValue = nullableText(row, 'reason_text');
  return code || textValue ? { code, text: textValue } : null;
}

function normalizedLimit(value: number | undefined) {
  return Number.isSafeInteger(value) && value && value > 0 ? Math.min(value, 500) : 100;
}

function toIso(value: Date | string) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function compareOccurred(left: BusinessAuditRecord, right: BusinessAuditRecord) {
  return right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id);
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray((result as { rows?: unknown[] })?.rows)
    ? (result as { rows: Record<string, unknown>[] }).rows
    : [];
}

function requireRow(result: unknown) {
  const row = rows(result)[0];
  if (!row) throw new BusinessAuditError('DATABASE_WRITE_FAILED', '业务审计记录写入失败');
  return row;
}

function optional(result: unknown) {
  const row = rows(result)[0];
  return row ? mapRecord(row) : null;
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new BusinessAuditError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string) {
  return row[key] == null ? null : text(row, key);
}

function instant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new BusinessAuditError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function jsonArray(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed;
  }
  if (Array.isArray(value)) return value;
  throw new BusinessAuditError('INVALID_DATABASE_ROW', `字段 ${key} JSON 数组无效`);
}

function nullableJsonObject(row: Record<string, unknown>, key: string): Record<string, unknown> | null {
  if (row[key] == null) return null;
  const value = row[key];
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new BusinessAuditError('INVALID_DATABASE_ROW', `字段 ${key} JSON 对象无效`);
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | null | undefined): T | null {
  return value ? clone(value) : null;
}
