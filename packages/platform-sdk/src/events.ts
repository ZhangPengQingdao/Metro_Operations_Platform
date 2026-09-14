export type PlatformEventAvailability = 'emitted' | 'declared';
export type PlatformEventPayload = Record<string, unknown>;

export interface PlatformEventEnvelope<TPayload extends PlatformEventPayload = PlatformEventPayload> {
  id: string;
  type: PlatformEventType;
  source: string;
  occurredAt: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  idempotencyKey?: string;
}

export interface WorkItemEventPayload extends PlatformEventPayload { workItemId: string; batchId?: string | null; sourceAppId: string; operation: string; status: string; actorType: 'person' | 'service'; actorPersonId: string | null; changedFields: string[]; }
export interface WorkItemRecurrenceEventPayload extends PlatformEventPayload { recurrenceRuleId: string; sourceAppId: string; skippedOccurrences: number; actorType: 'person' | 'service'; actorPersonId: string | null; }
export interface NotificationEventPayload extends PlatformEventPayload { notificationId: string; notificationKey: string; sourceAppId: string; operation: string; status: string; actorType: 'person' | 'service'; actorPersonId: string | null; changedFields: string[]; }
export interface NotificationPreferenceEventPayload extends PlatformEventPayload { preferenceId: string; personId: string; sourceAppId: string | null; category: string | null; channel: string | null; muted: boolean; actorType: 'person' | 'service'; actorPersonId: string | null; }
export interface SignatureEventPayload extends PlatformEventPayload { signatureRequestId: string; signatureKey: string; sourceAppId: string; operation: string; status: string; actorType: 'person' | 'service'; actorPersonId: string | null; changedFields: string[]; }
export interface PersonOrganizationChangedPayload extends PlatformEventPayload { personId: string; organizationUnitId: string; changedFields: string[]; }
export interface ResponsibilityChangedPayload extends PlatformEventPayload { responsibilityScopeId: string; operation: string; changedFields: string[]; }
export interface PermissionChangedPayload extends PlatformEventPayload { subjectType: 'person' | 'service' | 'application'; subjectId: string; permissionCode: string; operation: string; }
export interface AttachmentAddedPayload extends PlatformEventPayload { attachmentId: string; sourceAppId: string; sourceEntityType: string; sourceEntityId: string; }
export interface AssetChangedPayload extends PlatformEventPayload { assetId: string; operation: string; changedFields: string[]; }

export interface PlatformEventDescriptor<TType extends string = string, TAvailability extends PlatformEventAvailability = PlatformEventAvailability> {
  type: TType;
  semanticName: string;
  ownerCapabilityId: string;
  source: string;
  version: 1;
  availability: TAvailability;
  requiredPayloadKeys: readonly string[];
  description: string;
}

const workItemKeys = ['workItemId', 'sourceAppId', 'operation', 'status', 'actorType', 'actorPersonId', 'changedFields'] as const;
const recurrenceKeys = ['recurrenceRuleId', 'sourceAppId', 'skippedOccurrences', 'actorType', 'actorPersonId'] as const;
const notificationKeys = ['notificationId', 'notificationKey', 'sourceAppId', 'operation', 'status', 'actorType', 'actorPersonId', 'changedFields'] as const;
const preferenceKeys = ['preferenceId', 'personId', 'sourceAppId', 'category', 'channel', 'muted', 'actorType', 'actorPersonId'] as const;
const signatureKeys = ['signatureRequestId', 'signatureKey', 'sourceAppId', 'operation', 'status', 'actorType', 'actorPersonId', 'changedFields'] as const;

export const PLATFORM_EVENT_CATALOG = [
  event('platform.work-items.created.v1', 'WorkItemCreated', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '平台工作项已创建。'),
  event('platform.work-items.assigned.v1', 'WorkItemAssigned', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '平台工作项已分派。'),
  event('platform.work-items.claimed.v1', 'WorkItemClaimed', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '平台工作项已记录认领。'),
  event('platform.work-items.progress-updated.v1', 'WorkItemProgressUpdated', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '工作项进度已更新。'),
  event('platform.work-items.completed.v1', 'WorkItemCompleted', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '工作项已完成。'),
  event('platform.work-items.cancelled.v1', 'WorkItemCancelled', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '工作项已取消。'),
  event('platform.work-items.reopened.v1', 'WorkItemReopened', 'work-items', 'platform/work-items', 'emitted', workItemKeys, '工作项已重新打开。'),
  event('platform.work-items.recurrence-generated.v1', 'WorkItemRecurrenceGenerated', 'work-items', 'platform/work-items', 'emitted', recurrenceKeys, '周期工作项已生成。'),
  event('platform.work-items.recurrence-generation-skipped.v1', 'WorkItemRecurrenceGenerationSkipped', 'work-items', 'platform/work-items', 'emitted', recurrenceKeys, '周期工作项生成已跳过。'),
  event('platform.notifications.created.v1', 'NotificationRequested', 'notifications', 'platform/notifications', 'emitted', notificationKeys, '平台通知及其渠道意图已创建。'),
  event('platform.notifications.read.v1', 'NotificationRead', 'notifications', 'platform/notifications', 'emitted', notificationKeys, '通知已读状态已更新。'),
  event('platform.notifications.delivery-updated.v1', 'NotificationDeliveryUpdated', 'notifications', 'platform/notifications', 'emitted', notificationKeys, '通知投递证据已更新。'),
  event('platform.notifications.preference-updated.v1', 'NotificationPreferenceUpdated', 'notifications', 'platform/notifications', 'emitted', preferenceKeys, '通知偏好已更新。'),
  event('platform.notifications.cancelled.v1', 'NotificationCancelled', 'notifications', 'platform/notifications', 'emitted', notificationKeys, '平台通知已取消。'),
  event('platform.signatures.request-created.v1', 'SignatureRequested', 'signatures', 'platform/signatures', 'emitted', signatureKeys, '平台签字请求已创建。'),
  event('platform.signatures.signer-signed.v1', 'SignatureSignerSigned', 'signatures', 'platform/signatures', 'emitted', signatureKeys, '签字人已签署。'),
  event('platform.signatures.status-changed.v1', 'SignatureStatusChanged', 'signatures', 'platform/signatures', 'emitted', signatureKeys, '签字请求状态已变更。'),
  event('platform.signatures.request-completed.v1', 'SignatureCompleted', 'signatures', 'platform/signatures', 'emitted', signatureKeys, '平台签字请求已完成。'),
  event('platform.people.organization-changed.v1', 'PersonOrganizationChanged', 'people', 'platform/people', 'declared', ['personId', 'organizationUnitId', 'changedFields'], '人员当前组织已变更；等待所有者原子发件。'),
  event('platform.responsibility.changed.v1', 'ResponsibilityChanged', 'responsibility', 'platform/responsibility', 'declared', ['responsibilityScopeId', 'operation', 'changedFields'], '责任范围或分工已变更；等待所有者原子发件。'),
  event('platform.authorization.permission-changed.v1', 'PermissionChanged', 'authorization', 'platform/authorization', 'declared', ['subjectType', 'subjectId', 'permissionCode', 'operation'], '权限分配已变更；等待所有者原子发件。'),
  event('platform.attachments.added.v1', 'AttachmentAdded', 'attachments', 'platform/attachments', 'declared', ['attachmentId', 'sourceAppId', 'sourceEntityType', 'sourceEntityId'], '业务附件已登记；等待所有者原子发件。'),
  event('platform.assets.changed.v1', 'AssetChanged', 'assets', 'platform/assets', 'declared', ['assetId', 'operation', 'changedFields'], '资产档案已变更；等待所有者原子发件。')
] as const;

export type PlatformEventDescriptorEntry = typeof PLATFORM_EVENT_CATALOG[number];
export type PlatformEventType = PlatformEventDescriptorEntry['type'];
export type EmittedPlatformEventType = Extract<PlatformEventDescriptorEntry, { availability: 'emitted' }>['type'];
export type DeclaredPlatformEventType = Extract<PlatformEventDescriptorEntry, { availability: 'declared' }>['type'];

export type PlatformEventPayloadByType = {
  [TType in PlatformEventType]:
    TType extends `platform.work-items.recurrence-${string}.v1` ? WorkItemRecurrenceEventPayload
      : TType extends `platform.work-items.${string}.v1` ? WorkItemEventPayload
        : TType extends 'platform.notifications.preference-updated.v1' ? NotificationPreferenceEventPayload
          : TType extends `platform.notifications.${string}.v1` ? NotificationEventPayload
            : TType extends `platform.signatures.${string}.v1` ? SignatureEventPayload
              : TType extends 'platform.people.organization-changed.v1' ? PersonOrganizationChangedPayload
                : TType extends 'platform.responsibility.changed.v1' ? ResponsibilityChangedPayload
                  : TType extends 'platform.authorization.permission-changed.v1' ? PermissionChangedPayload
                    : TType extends 'platform.attachments.added.v1' ? AttachmentAddedPayload
                      : TType extends 'platform.assets.changed.v1' ? AssetChangedPayload
                        : PlatformEventPayload;
};

export type TypedPlatformEventEnvelope<TType extends PlatformEventType> = Omit<PlatformEventEnvelope<PlatformEventPayloadByType[TType]>, 'type'> & { type: TType };
export type AnyTypedPlatformEventEnvelope = { [TType in PlatformEventType]: TypedPlatformEventEnvelope<TType> }[PlatformEventType];

const descriptorByType = new Map<string, PlatformEventDescriptorEntry>(PLATFORM_EVENT_CATALOG.map((item) => [item.type, item]));
const sensitiveKey = /(?:actor[_-]?token|actor[_-]?wecom[_-]?userid|actor[_-]?name|trusted[_-]?identity|authorization|cookie|token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|signed[_-]?url|prompt|body|bytes|buffer|binary|file[_-]?content)/i;
const sensitiveText = /(?:bearer\s+\S+|(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|sig|signature)\s*[:=]\s*\S+|(?:\/api\/files\/(?:public|preview)\/|[?&](?:sig|signature|token)=))/i;

export class PlatformEventContractError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PlatformEventContractError'; }
}

export function getPlatformEventDescriptor(type: string) { return descriptorByType.get(type) ?? null; }

export function assertPlatformEventEnvelope(value: unknown): asserts value is PlatformEventEnvelope {
  if (!isPlainObject(value)) fail('INVALID_EVENT_ENVELOPE', '平台事件必须是普通对象');
  for (const key of Object.keys(value)) if (sensitiveKey.test(key)) fail('SENSITIVE_EVENT_ENVELOPE_DENIED', `事件 envelope 包含禁止字段: ${key}`);
  const eventType = requiredText(value.type, 'event type');
  const descriptor = descriptorByType.get(eventType);
  if (!descriptor) fail('UNREGISTERED_EVENT_TYPE', '事件类型未进入平台目录');
  if (eventVersion(eventType) !== descriptor.version) fail('EVENT_VERSION_MISMATCH', '事件版本与目录不一致');
  if (requiredText(value.source, 'event source') !== descriptor.source) fail('EVENT_SOURCE_MISMATCH', '事件来源与目录不一致');
  requiredText(value.id, 'event id');
  const occurredAt = requiredText(value.occurredAt, 'occurred at');
  if (!isIsoInstant(occurredAt)) fail('INVALID_EVENT_INSTANT', '事件时间必须是带时区的 ISO 瞬时');
  for (const key of ['correlationId','causationId','actorId','idempotencyKey'] as const) if (value[key] !== undefined) requiredText(value[key], key);
  if (!isPlainObject(value.payload)) fail('INVALID_EVENT_PAYLOAD', '事件载荷必须是普通对象');
  for (const key of descriptor.requiredPayloadKeys) if (!(key in value.payload) || value.payload[key] === undefined) fail('EVENT_PAYLOAD_KEY_REQUIRED', `事件载荷缺少字段: ${key}`);
  validateKnownPayloadFields(value.payload);
  validateSafeValue(value.payload);
}

export function isPlatformEventEnvelope(value: unknown): value is PlatformEventEnvelope { try { assertPlatformEventEnvelope(value); return true; } catch { return false; } }

function event<TType extends string, TAvailability extends PlatformEventAvailability>(type: TType, semanticName: string, ownerCapabilityId: string, source: string, availability: TAvailability, requiredPayloadKeys: readonly string[], description: string): PlatformEventDescriptor<TType, TAvailability> { return { type, semanticName, ownerCapabilityId, source, version: 1, availability, requiredPayloadKeys, description }; }
function validateKnownPayloadFields(payload: PlatformEventPayload) { for (const [key, value] of Object.entries(payload)) { if (key === 'changedFields') { if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim())) fail('INVALID_EVENT_PAYLOAD_FIELD', 'changedFields 必须是有界非空字符串数组'); continue; } if (key === 'skippedOccurrences') { if (!Number.isSafeInteger(value) || (value as number) < 0) fail('INVALID_EVENT_PAYLOAD_FIELD', 'skippedOccurrences 必须是非负整数'); continue; } if (key === 'muted') { if (typeof value !== 'boolean') fail('INVALID_EVENT_PAYLOAD_FIELD', 'muted 必须是布尔值'); continue; } if (key === 'actorType') { if (!['person','service'].includes(String(value))) fail('INVALID_EVENT_PAYLOAD_FIELD', 'actorType 必须是 person 或 service'); continue; } if (/(?:Id|Key)$/.test(key) || ['operation','status','category','channel','subjectType','permissionCode'].includes(key)) { const nullable = ['actorPersonId','batchId','sourceAppId','category','channel'].includes(key); if (value === null && nullable) continue; if (typeof value !== 'string' || !value.trim()) fail('INVALID_EVENT_PAYLOAD_FIELD', `${key} 必须是非空字符串`); } } }
function validateSafeValue(value: unknown) { let nodes = 0; const visit = (item: unknown, depth: number) => { nodes += 1; if (nodes > 250 || depth > 6) fail('EVENT_PAYLOAD_TOO_COMPLEX', '事件载荷过于复杂'); if (ArrayBuffer.isView(item)) fail('BINARY_EVENT_PAYLOAD_DENIED', '事件载荷不能包含二进制数据'); if (Array.isArray(item)) { if (item.length > 50) fail('EVENT_PAYLOAD_TOO_COMPLEX', '事件载荷数组过长'); item.forEach((child) => visit(child, depth + 1)); return; } if (isPlainObject(item)) { for (const [key, child] of Object.entries(item)) { if (sensitiveKey.test(key)) fail('SENSITIVE_EVENT_PAYLOAD_DENIED', `事件载荷包含禁止字段: ${key}`); visit(child, depth + 1); } return; } if (typeof item === 'string') { if (item.length > 1_000) fail('EVENT_PAYLOAD_TEXT_TOO_LONG', '事件载荷文本过长'); if (sensitiveText.test(item)) fail('SENSITIVE_EVENT_PAYLOAD_DENIED', '事件载荷不能包含凭证或签名链接'); return; } if (typeof item === 'number') { if (!Number.isFinite(item)) fail('INVALID_EVENT_PAYLOAD_VALUE', '事件载荷数值必须有限'); return; } if (typeof item !== 'boolean' && item !== null) fail('INVALID_EVENT_PAYLOAD_VALUE', '事件载荷包含不支持的值'); }; visit(value, 0); }
function eventVersion(type: string) { const match = /\.v(\d+)$/.exec(type); return match ? Number(match[1]) : null; }
function isIsoInstant(value: string) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function requiredText(value: unknown, label: string) { if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('INVALID_EVENT_TEXT', `${label} 无效`); return value; }
function isPlainObject(value: unknown): value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function fail(code: string, message: string): never { throw new PlatformEventContractError(code, message); }
