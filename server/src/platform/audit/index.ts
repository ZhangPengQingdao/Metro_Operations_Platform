import { createHash, randomUUID } from 'node:crypto';
import { redactCoreValue } from '../../core/observability/index.js';
import type { AuthorizationResource } from '../authorization/index.js';
import type { PlatformActorContext } from '../context/index.js';
import {
  BUSINESS_AUDIT_OUTCOMES,
  BUSINESS_AUDIT_PERMISSION_CODES,
  BusinessAuditError,
  EXISTING_BUSINESS_AUDIT_SOURCES,
  type BusinessAuditListInput,
  type BusinessAuditRecord,
  type BusinessAuditReconciliation,
  type BusinessAuditReconciliationIssue,
  type ExistingBusinessAuditEvidenceRow,
  type ExistingBusinessAuditEvidenceSnapshot,
  type ExistingBusinessAuditSource,
  type RecordBusinessOperationInput
} from './model.js';
import type { BusinessAuditRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

const AUDIT_SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|cookie|database[_-]?url|connection[_-]?string|private[_-]?key|signing|signed[-_]?url|prompt|body|bytes|buffer|binary|file[-_]?content)/i;
const SIGNED_URL_PATTERN = /(?:\/api\/files\/(?:public|preview)\/|[?&](?:sig|signature|token)=)/i;
const SENSITIVE_TEXT_PATTERN = /(?:bearer\s+\S+|(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|sig|signature)\s*[:=]\s*\S+)/i;
const MAX_SUMMARY_NODES = 250;
const MAX_SUMMARY_ARRAY = 50;
const MAX_SUMMARY_JSON_BYTES = 24_000;

export interface BusinessAuditDirectoryPerson {
  employmentStatus: string;
  organizationUnitId: string;
}

export interface BusinessAuditDirectoryOrganizationUnit {
  status: string;
}

export interface BusinessAuditServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  findPerson(id: string): Promise<BusinessAuditDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<BusinessAuditDirectoryOrganizationUnit | null>;
}

export class BusinessAuditService {
  private readonly clock: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly repository: BusinessAuditRepository,
    private readonly options: BusinessAuditServiceOptions
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async recordBusinessOperation(
    context: PlatformActorContext,
    input: RecordBusinessOperationInput
  ): Promise<BusinessAuditRecord> {
    const draft = await this.prepareRecord(context, input);

    if (draft.auditKey) {
      const existing = await this.repository.findByAuditKey(draft.business.appId, draft.auditKey);
      if (existing) return resolveIdempotentRecord(draft, existing);
    }
    try {
      return await this.repository.append(draft);
    } catch (error) {
      if (!draft.auditKey) throw error;
      let existing: BusinessAuditRecord | null;
      try {
        existing = await this.repository.findByAuditKey(draft.business.appId, draft.auditKey);
      } catch {
        throw error;
      }
      if (!existing) throw error;
      return resolveIdempotentRecord(draft, existing);
    }
  }

  async getBusinessOperation(context: PlatformActorContext, recordId: string) {
    const record = await this.repository.findById(uuid(recordId, 'business audit record id'));
    if (!record) throw new BusinessAuditError('BUSINESS_AUDIT_NOT_FOUND', '业务审计记录不存在');
    await this.requireAuthorized(context, BUSINESS_AUDIT_PERMISSION_CODES.read, resourceFor(record));
    return record;
  }

  async listBusinessOperations(context: PlatformActorContext, input: BusinessAuditListInput = {}) {
    const normalized = normalizeListInput(input);
    const candidates = await this.repository.list(normalized);
    const readable: BusinessAuditRecord[] = [];
    for (const record of candidates) {
      if ((await context.authorize(BUSINESS_AUDIT_PERMISSION_CODES.read, resourceFor(record))).allowed) {
        readable.push(record);
      }
    }
    return readable;
  }

  private async prepareRecord(context: PlatformActorContext, input: RecordBusinessOperationInput) {
    if (!isPlainObject(input)) throw new BusinessAuditError('INVALID_AUDIT_INPUT', '业务审计输入无效');
    if (!isPlainObject(input.business)) throw new BusinessAuditError('INVALID_BUSINESS_REFERENCE', '业务引用无效');
    const business = {
      appId: appId(input.business.appId),
      entityType: stableCode(input.business.entityType, 100, 'entity type'),
      entityId: boundedText(input.business.entityId, 200, 'entity id'),
      displayLabel: optionalText(input.business.displayLabel, 300),
      ownerPersonId: input.business.ownerPersonId ? uuid(input.business.ownerPersonId, 'owner person id') : null,
      ownerOrganizationUnitId: input.business.ownerOrganizationUnitId
        ? uuid(input.business.ownerOrganizationUnitId, 'owner organization unit id')
        : null
    };
    assertExecutionSource(context, business.appId);
    await this.requireAuthorized(context, BUSINESS_AUDIT_PERMISSION_CODES.record, resourceFor({ business }));
    if (business.ownerPersonId) await this.requireActivePerson(business.ownerPersonId);
    if (business.ownerOrganizationUnitId) await this.requireActiveOrganization(business.ownerOrganizationUnitId);

    const operation = {
      code: stableCode(input.operationCode, 150, 'operation code'),
      outcome: outcome(input.outcome)
    };
    const changedFields = normalizeChangedFields(input.changedFields ?? []);
    const before = normalizeSummary(input.before, 'before summary');
    const after = normalizeSummary(input.after, 'after summary');
    const resultSummary = normalizeSummary(input.resultSummary, 'result summary');
    const errorCode = optionalStableCode(input.errorCode, 150, 'error code');
    assertOutcomeConsistency(operation.outcome, changedFields, before, after, resultSummary, errorCode);
    const change = changedFields.length || before || after ? { changedFields, before, after } : null;
    const reason = normalizeReason(input.reason);
    const actor = context.actorType === 'person'
      ? {
          type: 'person' as const,
          personId: context.person.id,
          serviceIdentityId: null,
          personSnapshot: {
            personId: context.person.id,
            employeeNo: boundedText(context.person.employeeNo, 100, 'actor employee number'),
            name: boundedText(context.person.name, 120, 'actor name'),
            organizationUnitId: uuid(context.person.organization.id, 'actor organization id'),
            organizationName: boundedText(context.person.organization.name, 200, 'actor organization name'),
            positionId: uuid(context.person.position.id, 'actor position id'),
            positionName: boundedText(context.person.position.name, 200, 'actor position name')
          }
        }
      : {
          type: 'service' as const,
          personId: null,
          serviceIdentityId: boundedText(context.execution.serviceIdentityId, 120, 'service identity id'),
          personSnapshot: null
        };
    const source = {
      identitySource: context.trustedIdentity.source,
      executionType: context.execution.type,
      executionAppId: context.execution.type === 'platform' ? null : appId(context.execution.appId),
      requestId: boundedText(context.request.requestId, 200, 'request id'),
      traceId: boundedText(context.request.traceId, 200, 'trace id')
    };
    const auditKey = optionalText(input.auditKey, 200);
    const semanticPayload = normalizePayload({ operation, actor, business, change, source: {
      identitySource: source.identitySource,
      executionType: source.executionType,
      executionAppId: source.executionAppId
    }, reason, resultSummary, errorCode });
    return {
      id: uuid(input.id ?? this.createId(), 'business audit record id'),
      auditKey,
      idempotencyPayloadHash: auditKey ? sha256(semanticPayload) : null,
      operation,
      actor,
      business,
      change,
      source,
      reason,
      resultSummary,
      errorCode,
      occurredAt: this.clock().toISOString()
    } satisfies BusinessAuditRecord;
  }

  private async requireActivePerson(id: string) {
    const person = await this.options.findPerson(id);
    if (!person) throw new BusinessAuditError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new BusinessAuditError('PERSON_INACTIVE', '人员不在岗');
  }

  private async requireActiveOrganization(id: string) {
    const organization = await this.options.findOrganizationUnit(id);
    if (!organization) throw new BusinessAuditError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (organization.status !== 'active') throw new BusinessAuditError('ORGANIZATION_INACTIVE', '组织未启用');
  }

  private async requireAuthorized(
    context: PlatformActorContext,
    permissionCode: string,
    resource: AuthorizationResource
  ) {
    if (!(await context.authorize(permissionCode, resource)).allowed) {
      throw new BusinessAuditError('BUSINESS_AUDIT_PERMISSION_DENIED', `缺少权限: ${permissionCode}`);
    }
  }
}

export function createBusinessAuditService(
  repository: BusinessAuditRepository,
  options: BusinessAuditServiceOptions
) {
  return new BusinessAuditService(repository, options);
}

export function reconcileExistingBusinessAuditEvidence(
  snapshot: ExistingBusinessAuditEvidenceSnapshot
): BusinessAuditReconciliation {
  const sourceCounts = Object.fromEntries(
    EXISTING_BUSINESS_AUDIT_SOURCES.map((source) => [source, 0])
  ) as Record<ExistingBusinessAuditSource, number>;
  const outcomeCounts: Record<string, number> = {};
  const coverage = { actor: 0, application: 0, entity: 0, request: 0, trace: 0, change: 0 };
  const issues: BusinessAuditReconciliationIssue[] = [];
  let totalCount = 0;
  let mappableCount = 0;

  const entries: Array<[ExistingBusinessAuditSource, readonly ExistingBusinessAuditEvidenceRow[]]> = [
    ['work_item_history', snapshot.workItemHistory ?? []],
    ['notification_history', snapshot.notificationHistory ?? []],
    ['signature_history', snapshot.signatureHistory ?? []],
    ['attachment_history', snapshot.attachmentHistory ?? []],
    ['device_resolution_audit', snapshot.deviceResolutionAudits ?? []]
  ];
  for (const [source, rows] of entries) {
    for (const row of rows) {
      totalCount += 1;
      sourceCounts[source] += 1;
      const rowIssues: BusinessAuditReconciliationIssue[] = [];
      const add = (code: BusinessAuditReconciliationIssue['code'], key?: string) => {
        rowIssues.push({ source, sourceId: row.sourceId, code, ...(key ? { key } : {}) });
      };
      if (!row.operation?.trim()) add('MISSING_OPERATION');
      const rowOutcome = row.outcome?.trim() ?? '';
      outcomeCounts[rowOutcome || '(missing)'] = (outcomeCounts[rowOutcome || '(missing)'] ?? 0) + 1;
      if (!rowOutcome) add('MISSING_OUTCOME');
      else if (!BUSINESS_AUDIT_OUTCOMES.includes(rowOutcome as BusinessAuditRecord['operation']['outcome'])) add('INVALID_OUTCOME');
      if (row.actorPersonId?.trim() || row.serviceIdentityId?.trim()) coverage.actor += 1;
      else add('MISSING_ACTOR');
      if (row.sourceAppId?.trim()) coverage.application += 1;
      else add('MISSING_APPLICATION');
      if (row.entityType?.trim() && row.entityId?.trim()) coverage.entity += 1;
      else add('MISSING_ENTITY_REFERENCE');
      if (row.requestId?.trim()) coverage.request += 1;
      else add('MISSING_REQUEST');
      if (row.traceId?.trim()) coverage.trace += 1;
      else add('MISSING_TRACE');
      if (row.before || row.after) coverage.change += 1;
      for (const key of unsafeKeys(row.before, row.after)) add('UNSAFE_PAYLOAD_KEY', key);
      if (!row.occurredAt?.trim()) add('MISSING_OCCURRED_AT');
      else if (Number.isNaN(new Date(row.occurredAt).getTime())) add('INVALID_OCCURRED_AT');
      if (rowIssues.length === 0) mappableCount += 1;
      issues.push(...rowIssues);
    }
  }
  return { totalCount, sourceCounts, outcomeCounts, coverage, mappableCount, issues };
}

function normalizeListInput(input: BusinessAuditListInput): BusinessAuditListInput {
  if (!isPlainObject(input as unknown)) throw new BusinessAuditError('INVALID_AUDIT_FILTER', '业务审计查询条件无效');
  const occurredFrom = normalizeInstant(input.occurredFrom, 'occurred from');
  const occurredTo = normalizeInstant(input.occurredTo, 'occurred to');
  if (occurredFrom && occurredTo && occurredFrom > occurredTo) {
    throw new BusinessAuditError('INVALID_TIME_RANGE', '业务审计开始时间不能晚于结束时间');
  }
  return {
    operationCode: input.operationCode ? stableCode(input.operationCode, 150, 'operation code') : undefined,
    outcome: input.outcome ? outcome(input.outcome) : undefined,
    actorPersonId: input.actorPersonId ? uuid(input.actorPersonId, 'actor person id') : undefined,
    sourceApplicationId: input.sourceApplicationId ? appId(input.sourceApplicationId) : undefined,
    businessAppId: input.businessAppId ? appId(input.businessAppId) : undefined,
    entityType: input.entityType ? stableCode(input.entityType, 100, 'entity type') : undefined,
    entityId: input.entityId ? boundedText(input.entityId, 200, 'entity id') : undefined,
    ownerPersonId: input.ownerPersonId ? uuid(input.ownerPersonId, 'owner person id') : undefined,
    ownerOrganizationUnitId: input.ownerOrganizationUnitId
      ? uuid(input.ownerOrganizationUnitId, 'owner organization id')
      : undefined,
    requestId: input.requestId ? boundedText(input.requestId, 200, 'request id') : undefined,
    traceId: input.traceId ? boundedText(input.traceId, 200, 'trace id') : undefined,
    occurredFrom,
    occurredTo,
    limit: normalizeLimit(input.limit)
  };
}

function normalizeInstant(value: Date | string | undefined, label: string) {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new BusinessAuditError('INVALID_DATE', `${label} 无效`);
  return date.toISOString();
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) throw new BusinessAuditError('INVALID_LIMIT', '查询数量无效');
  return Math.min(value, 500);
}

function normalizeChangedFields(values: readonly string[]) {
  if (!Array.isArray(values)) throw new BusinessAuditError('INVALID_CHANGED_FIELDS', '变更字段必须是数组');
  if (values.length > 100) throw new BusinessAuditError('TOO_MANY_CHANGED_FIELDS', '变更字段数量超过限制');
  return [...new Set(values.map((value) => stableCode(value, 100, 'changed field')))].sort();
}

function normalizeSummary(value: Record<string, unknown> | null | undefined, label: string) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new BusinessAuditError('INVALID_AUDIT_SUMMARY', `${label} 必须是普通对象`);
  validateSummaryShape(value);
  const redacted = redactCoreValue(value, {
    sensitiveKeyPattern: AUDIT_SENSITIVE_KEY_PATTERN,
    maxDepth: 6,
    maxStringLength: 1_000
  });
  const withoutSignedUrls = redactSignedUrls(redacted) as Record<string, unknown>;
  const serialized = JSON.stringify(withoutSignedUrls);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SUMMARY_JSON_BYTES) {
    throw new BusinessAuditError('AUDIT_SUMMARY_TOO_LARGE', `${label} 超过大小限制`);
  }
  return withoutSignedUrls;
}

function validateSummaryShape(value: unknown) {
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    nodes += 1;
    if (nodes > MAX_SUMMARY_NODES) throw new BusinessAuditError('AUDIT_SUMMARY_TOO_COMPLEX', '审计摘要节点过多');
    if (depth > 6) return;
    if (Buffer.isBuffer(item) || ArrayBuffer.isView(item)) {
      throw new BusinessAuditError('BINARY_AUDIT_SUMMARY_DENIED', '审计摘要不能包含二进制数据');
    }
    if (Array.isArray(item)) {
      if (item.length > MAX_SUMMARY_ARRAY) throw new BusinessAuditError('AUDIT_SUMMARY_TOO_COMPLEX', '审计摘要数组过长');
      for (const value of item) visit(value, depth + 1);
      return;
    }
    if (item && typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1);
      return;
    }
    if (!['string', 'number', 'boolean', 'undefined'].includes(typeof item) && item !== null) {
      throw new BusinessAuditError('INVALID_AUDIT_SUMMARY_VALUE', '审计摘要包含不支持的数据类型');
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new BusinessAuditError('INVALID_AUDIT_SUMMARY_VALUE', '审计摘要数字无效');
    }
  };
  visit(value, 0);
}

function redactSignedUrls(value: unknown): unknown {
  if (typeof value === 'string') return SIGNED_URL_PATTERN.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map(redactSignedUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactSignedUrls(item)]));
  }
  return value;
}

function normalizeReason(value: RecordBusinessOperationInput['reason']) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new BusinessAuditError('INVALID_OPERATION_REASON', '操作原因无效');
  const code = optionalStableCode(value.code, 100, 'reason code');
  const text = optionalText(value.text, 2_000);
  return code || text ? {
    code,
    text: text && (SIGNED_URL_PATTERN.test(text) || SENSITIVE_TEXT_PATTERN.test(text)) ? '[REDACTED]' : text
  } : null;
}

function assertOutcomeConsistency(
  value: BusinessAuditRecord['operation']['outcome'],
  changedFields: readonly string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  resultSummary: Record<string, unknown> | null,
  errorCode: string | null
) {
  const hasChange = changedFields.length > 0 || before !== null || after !== null;
  if (value === 'succeeded') {
    if (errorCode) throw new BusinessAuditError('SUCCESS_ERROR_CONFLICT', '成功审计不能包含错误码');
    return;
  }
  if (!errorCode) throw new BusinessAuditError('AUDIT_ERROR_CODE_REQUIRED', '拒绝或失败审计必须包含错误码');
  if (hasChange) throw new BusinessAuditError('NON_SUCCESS_CHANGE_CONFLICT', '拒绝或失败审计不能声明业务变更');
  if (value === 'denied' && resultSummary) {
    throw new BusinessAuditError('DENIED_RESULT_CONFLICT', '拒绝审计不能包含成功结果摘要');
  }
}

function resourceFor(record: Pick<BusinessAuditRecord, 'business'>): AuthorizationResource {
  return {
    ownerPersonId: record.business.ownerPersonId,
    organizationUnitId: record.business.ownerOrganizationUnitId,
    targets: record.business.ownerOrganizationUnitId
      ? [{ type: 'organization', id: record.business.ownerOrganizationUnitId }]
      : []
  };
}

function assertExecutionSource(context: PlatformActorContext, businessAppId: string) {
  if (context.execution.type !== 'platform' && context.execution.appId !== businessAppId) {
    throw new BusinessAuditError('SOURCE_APP_MISMATCH', '执行上下文与业务审计应用不一致');
  }
}

function resolveIdempotentRecord(draft: BusinessAuditRecord, existing: BusinessAuditRecord) {
  if (existing.idempotencyPayloadHash !== draft.idempotencyPayloadHash) {
    throw new BusinessAuditError('AUDIT_KEY_CONFLICT', '相同业务审计键的记录内容不同');
  }
  return existing;
}

function unsafeKeys(...values: Array<Record<string, unknown> | null | undefined>) {
  const keys = new Set<string>();
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (AUDIT_SENSITIVE_KEY_PATTERN.test(key)) keys.add(next);
      if (typeof item === 'string' && SIGNED_URL_PATTERN.test(item)) keys.add(next);
      visit(item, next);
    }
  };
  values.forEach((value) => visit(value, ''));
  return [...keys].sort();
}

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizePayload(item)]));
  }
  return value;
}

function outcome(value: unknown) {
  if (!BUSINESS_AUDIT_OUTCOMES.includes(value as BusinessAuditRecord['operation']['outcome'])) {
    throw new BusinessAuditError('INVALID_AUDIT_OUTCOME', '业务审计结果无效');
  }
  return value as BusinessAuditRecord['operation']['outcome'];
}

function appId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,98}[a-z0-9]$/.test(value)) {
    throw new BusinessAuditError('INVALID_APP_ID', '应用 ID 无效');
  }
  return value;
}

function stableCode(value: unknown, max: number, label: string) {
  const text = boundedText(value, max, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(text)) {
    throw new BusinessAuditError('INVALID_STABLE_CODE', `${label} 格式无效`);
  }
  return text;
}

function optionalStableCode(value: unknown, max: number, label: string) {
  const text = optionalText(value, max);
  return text ? stableCode(text, max, label) : null;
}

function boundedText(value: unknown, max: number, label: string) {
  if (typeof value !== 'string') throw new BusinessAuditError('INVALID_TEXT', `${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new BusinessAuditError('TEXT_REQUIRED', `${label} 不能为空`);
  if (text.length > max) throw new BusinessAuditError('TEXT_TOO_LONG', `${label} 超过长度限制`);
  return text;
}

function optionalText(value: unknown, max: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new BusinessAuditError('INVALID_TEXT', '可选文本必须是字符串');
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new BusinessAuditError('TEXT_TOO_LONG', '可选文本超过长度限制');
  return text;
}

function uuid(value: unknown, label: string) {
  if (typeof value !== 'string') throw new BusinessAuditError('INVALID_UUID', `${label} 无效`);
  const text = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new BusinessAuditError('INVALID_UUID', `${label} 无效`);
  }
  return text.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
