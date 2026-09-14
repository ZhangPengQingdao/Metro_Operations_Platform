import { runDatabaseTransaction, type AtomicParticipant, type QueryableClient } from '../../core/database/index.js';
import {
  NotificationError,
  type Notification,
  type NotificationChannelIntent,
  type NotificationDeliveryAttempt,
  type NotificationListInput,
  type NotificationOperationHistory,
  type NotificationPreference,
  type NotificationRead,
  type NotificationRecipient
} from './model.js';

export interface NotificationRepository extends AtomicParticipant {
  createNotification(
    record: Notification,
    recipients: readonly NotificationRecipient[],
    channelIntents: readonly NotificationChannelIntent[]
  ): Promise<Notification>;
  updateNotification(record: Notification): Promise<Notification>;
  findNotificationById(id: string, lock?: 'share' | 'update'): Promise<Notification | null>;
  findNotificationByKey(sourceAppId: string, notificationKey: string): Promise<Notification | null>;
  findNotificationByIdempotencyKey(sourceAppId: string, idempotencyKey: string): Promise<Notification | null>;
  listNotifications(input?: NotificationListInput): Promise<Notification[]>;

  listRecipients(notificationId: string): Promise<NotificationRecipient[]>;
  findRecipient(notificationId: string, personId: string): Promise<NotificationRecipient | null>;

  listChannelIntents(notificationId: string): Promise<NotificationChannelIntent[]>;
  findChannelIntentById(id: string): Promise<NotificationChannelIntent | null>;
  updateChannelIntent(record: NotificationChannelIntent): Promise<NotificationChannelIntent>;

  upsertRead(record: NotificationRead): Promise<NotificationRead>;
  findRead(notificationId: string, personId: string): Promise<NotificationRead | null>;
  listReads(notificationId: string): Promise<NotificationRead[]>;

  addDeliveryAttempt(record: NotificationDeliveryAttempt): Promise<NotificationDeliveryAttempt>;
  listDeliveryAttempts(channelIntentId: string): Promise<NotificationDeliveryAttempt[]>;

  upsertPreference(record: NotificationPreference): Promise<NotificationPreference>;
  findPreferenceByKey(preferenceKey: string): Promise<NotificationPreference | null>;
  listPreferences(personId: string): Promise<NotificationPreference[]>;

  addOperationHistory(record: NotificationOperationHistory): Promise<NotificationOperationHistory>;
  listOperationHistory(notificationId: string): Promise<NotificationOperationHistory[]>;
}

export interface MemoryNotificationRepository extends NotificationRepository {
  records(): {
    notifications: Notification[];
    recipients: NotificationRecipient[];
    channelIntents: NotificationChannelIntent[];
    reads: NotificationRead[];
    deliveryAttempts: NotificationDeliveryAttempt[];
    preferences: NotificationPreference[];
    operationHistory: NotificationOperationHistory[];
  };
}

export function createMemoryNotificationRepository(seed: {
  notifications?: readonly Notification[];
  recipients?: readonly NotificationRecipient[];
  channelIntents?: readonly NotificationChannelIntent[];
  reads?: readonly NotificationRead[];
  deliveryAttempts?: readonly NotificationDeliveryAttempt[];
  preferences?: readonly NotificationPreference[];
  operationHistory?: readonly NotificationOperationHistory[];
} = {}): MemoryNotificationRepository {
  let notifications = toMap(seed.notifications);
  let recipients = (seed.recipients ?? []).map(clone);
  let channelIntents = toMap(seed.channelIntents);
  let reads = toMap(seed.reads);
  let deliveryAttempts = toMap(seed.deliveryAttempts);
  let preferences = toMap(seed.preferences);
  let operationHistory = toMap(seed.operationHistory);

  return {
    atomic: {
      snapshot() {
        const savednotifications = clone(notifications);
        const savedchannelIntents = clone(channelIntents);
        const savedreads = clone(reads);
        const saveddeliveryAttempts = clone(deliveryAttempts);
        const savedpreferences = clone(preferences);
        const savedoperationHistory = clone(operationHistory);
        const savedRecipients = clone(recipients);
        return () => {
          notifications = savednotifications;
          channelIntents = savedchannelIntents;
          reads = savedreads;
          deliveryAttempts = saveddeliveryAttempts;
          preferences = savedpreferences;
          operationHistory = savedoperationHistory;
          recipients = savedRecipients;
        };
      }
    },
    async createNotification(record, notificationRecipients, intents) {
      assertUniqueId(notifications, record.id);
      assertNotificationKey(notifications, record);
      assertNotificationIdempotency(notifications, record);
      notifications.set(record.id, clone(record));
      recipients = recipients.filter((recipient) => recipient.notificationId !== record.id);
      recipients.push(...notificationRecipients.map(clone));
      for (const intent of intents) {
        assertUniqueId(channelIntents, intent.id);
        channelIntents.set(intent.id, clone(intent));
      }
      return clone(record);
    },
    async updateNotification(record) {
      if (!notifications.has(record.id)) throw new NotificationError('NOTIFICATION_NOT_FOUND', '通知不存在');
      notifications.set(record.id, clone(record));
      return clone(record);
    },
    async findNotificationById(id) {
      return cloneOrNull(notifications.get(id));
    },
    async findNotificationByKey(sourceAppId, notificationKey) {
      return cloneOrNull([...notifications.values()].find((item) => item.sourceAppId === sourceAppId && item.notificationKey === notificationKey));
    },
    async findNotificationByIdempotencyKey(sourceAppId, idempotencyKey) {
      return cloneOrNull([...notifications.values()].find((item) => item.sourceAppId === sourceAppId && item.idempotencyKey === idempotencyKey));
    },
    async listNotifications(input = {}) {
      return [...notifications.values()]
        .filter((item) => matchesListFilter(item, recipients, reads, input))
        .map(clone)
        .sort(compareNotifications)
        .slice(0, input.limit ?? 100);
    },
    async listRecipients(notificationId) {
      return recipients.filter((recipient) => recipient.notificationId === notificationId).map(clone).sort(compareRecipients);
    },
    async findRecipient(notificationId, personId) {
      return cloneOrNull(recipients.find((recipient) => recipient.notificationId === notificationId && recipient.personId === personId));
    },
    async listChannelIntents(notificationId) {
      return [...channelIntents.values()].filter((intent) => intent.notificationId === notificationId).map(clone).sort(compareChannelIntents);
    },
    async findChannelIntentById(id) {
      return cloneOrNull(channelIntents.get(id));
    },
    async updateChannelIntent(record) {
      if (!channelIntents.has(record.id)) throw new NotificationError('CHANNEL_INTENT_NOT_FOUND', '通知渠道意图不存在');
      channelIntents.set(record.id, clone(record));
      return clone(record);
    },
    async upsertRead(record) {
      const existing = [...reads.values()].find((item) => item.notificationId === record.notificationId && item.personId === record.personId);
      const saved = existing ? { ...existing, readAt: record.readAt } : record;
      reads.set(saved.id, clone(saved));
      return clone(saved);
    },
    async findRead(notificationId, personId) {
      return cloneOrNull([...reads.values()].find((item) => item.notificationId === notificationId && item.personId === personId));
    },
    async listReads(notificationId) {
      return [...reads.values()].filter((item) => item.notificationId === notificationId).map(clone).sort(compareReads);
    },
    async addDeliveryAttempt(record) {
      assertUniqueId(deliveryAttempts, record.id);
      deliveryAttempts.set(record.id, clone(record));
      return clone(record);
    },
    async listDeliveryAttempts(channelIntentId) {
      return [...deliveryAttempts.values()].filter((item) => item.channelIntentId === channelIntentId).map(clone).sort(compareDeliveryAttempts);
    },
    async upsertPreference(record) {
      const existing = [...preferences.values()].find((item) => item.preferenceKey === record.preferenceKey);
      const saved = existing ? { ...record, id: existing.id, createdAt: existing.createdAt } : record;
      preferences.set(saved.id, clone(saved));
      return clone(saved);
    },
    async findPreferenceByKey(preferenceKey) {
      return cloneOrNull([...preferences.values()].find((item) => item.preferenceKey === preferenceKey));
    },
    async listPreferences(personId) {
      return [...preferences.values()].filter((item) => item.personId === personId).map(clone).sort(comparePreferences);
    },
    async addOperationHistory(record) {
      assertUniqueId(operationHistory, record.id);
      operationHistory.set(record.id, clone(record));
      return clone(record);
    },
    async listOperationHistory(notificationId) {
      return [...operationHistory.values()].filter((item) => item.notificationId === notificationId).map(clone).sort(compareOperationHistory);
    },
    records() {
      return {
        notifications: [...notifications.values()].map(clone),
        recipients: recipients.map(clone),
        channelIntents: [...channelIntents.values()].map(clone),
        reads: [...reads.values()].map(clone),
        deliveryAttempts: [...deliveryAttempts.values()].map(clone),
        preferences: [...preferences.values()].map(clone),
        operationHistory: [...operationHistory.values()].map(clone)
      };
    }
  };
}

export function createPostgresNotificationRepository(client: QueryableClient): NotificationRepository {
  return {
    atomic: { client },
    async createNotification(record, recipients, channelIntents) {
      return runDatabaseTransaction(client, async (transaction) => {
        const saved = await insertNotification(transaction, record);
        for (const recipient of recipients) await insertRecipient(transaction, recipient);
        for (const intent of channelIntents) await insertChannelIntent(transaction, intent);
        return saved;
      });
    },
    async updateNotification(record) {
      return mapNotification(requireRow(await client.query(
        `UPDATE platform_notifications
         SET status=$2,category=$3,read_behavior=$4,display_snapshot=$5::jsonb,template_snapshot=$6::jsonb,
             navigation_ref=$7::jsonb,updated_at=$8,cancelled_at=$9
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, record.category, record.readBehavior, JSON.stringify(record.display), jsonOrNull(record.template), jsonOrNull(record.navigation), record.updatedAt, record.cancelledAt]
      )));
    },
    async findNotificationById(id, lock) {
      const suffix = lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : '';
      return optional(await client.query(`SELECT * FROM platform_notifications WHERE id=$1${suffix}`, [id]), mapNotification);
    },
    async findNotificationByKey(sourceAppId, notificationKey) {
      return optional(await client.query('SELECT * FROM platform_notifications WHERE source_app_id=$1 AND notification_key=$2', [sourceAppId, notificationKey]), mapNotification);
    },
    async findNotificationByIdempotencyKey(sourceAppId, idempotencyKey) {
      return optional(await client.query('SELECT * FROM platform_notifications WHERE source_app_id=$1 AND idempotency_key=$2', [sourceAppId, idempotencyKey]), mapNotification);
    },
    async listNotifications(input = {}) {
      const { where, values, limit } = buildListWhere(input);
      return rows(await client.query(`SELECT * FROM platform_notifications ${where} ORDER BY updated_at DESC, id LIMIT ${limit}`, values)).map(mapNotification);
    },
    async listRecipients(notificationId) {
      return rows(await client.query('SELECT * FROM platform_notification_recipients WHERE notification_id=$1 ORDER BY person_id,id', [notificationId])).map(mapRecipient);
    },
    async findRecipient(notificationId, personId) {
      return optional(await client.query('SELECT * FROM platform_notification_recipients WHERE notification_id=$1 AND person_id=$2', [notificationId, personId]), mapRecipient);
    },
    async listChannelIntents(notificationId) {
      return rows(await client.query('SELECT * FROM platform_notification_channel_intents WHERE notification_id=$1 ORDER BY recipient_id,channel,id', [notificationId])).map(mapChannelIntent);
    },
    async findChannelIntentById(id) {
      return optional(await client.query('SELECT * FROM platform_notification_channel_intents WHERE id=$1', [id]), mapChannelIntent);
    },
    async updateChannelIntent(record) {
      return mapChannelIntent(requireRow(await client.query(
        `UPDATE platform_notification_channel_intents
         SET status=$2,provider_message_id=$3,attempts=$4,last_error=$5,scheduled_at=$6,delivered_at=$7,updated_at=$8
         WHERE id=$1 RETURNING *`,
        [record.id, record.status, record.providerMessageId, record.attempts, record.lastError, record.scheduledAt, record.deliveredAt, record.updatedAt]
      )));
    },
    async upsertRead(record) {
      return mapRead(requireRow(await client.query(
        `INSERT INTO platform_notification_reads (id,notification_id,person_id,read_at,created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (notification_id,person_id) DO UPDATE SET read_at=EXCLUDED.read_at
         RETURNING *`,
        [record.id, record.notificationId, record.personId, record.readAt, record.createdAt]
      )));
    },
    async findRead(notificationId, personId) {
      return optional(await client.query('SELECT * FROM platform_notification_reads WHERE notification_id=$1 AND person_id=$2', [notificationId, personId]), mapRead);
    },
    async listReads(notificationId) {
      return rows(await client.query('SELECT * FROM platform_notification_reads WHERE notification_id=$1 ORDER BY read_at,id', [notificationId])).map(mapRead);
    },
    async addDeliveryAttempt(record) {
      return mapDeliveryAttempt(requireRow(await client.query(
        `INSERT INTO platform_notification_delivery_attempts
         (id,channel_intent_id,status,provider_message_id,error_message,attempted_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [record.id, record.channelIntentId, record.status, record.providerMessageId, record.errorMessage, record.attemptedAt]
      )));
    },
    async listDeliveryAttempts(channelIntentId) {
      return rows(await client.query('SELECT * FROM platform_notification_delivery_attempts WHERE channel_intent_id=$1 ORDER BY attempted_at,id', [channelIntentId])).map(mapDeliveryAttempt);
    },
    async upsertPreference(record) {
      return mapPreference(requireRow(await client.query(
        `INSERT INTO platform_notification_preferences
         (id,preference_key,person_id,source_app_id,category,channel,muted,quiet_window,updated_by_person_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
         ON CONFLICT (preference_key) DO UPDATE SET
           source_app_id=EXCLUDED.source_app_id,
           category=EXCLUDED.category,
           channel=EXCLUDED.channel,
           muted=EXCLUDED.muted,
           quiet_window=EXCLUDED.quiet_window,
           updated_by_person_id=EXCLUDED.updated_by_person_id,
           updated_at=EXCLUDED.updated_at
         RETURNING *`,
        [record.id, record.preferenceKey, record.personId, record.sourceAppId, record.category, record.channel, record.muted, jsonOrNull(record.quietWindow), record.updatedByPersonId, record.createdAt, record.updatedAt]
      )));
    },
    async findPreferenceByKey(preferenceKey) {
      return optional(await client.query('SELECT * FROM platform_notification_preferences WHERE preference_key=$1', [preferenceKey]), mapPreference);
    },
    async listPreferences(personId) {
      return rows(await client.query('SELECT * FROM platform_notification_preferences WHERE person_id=$1 ORDER BY updated_at DESC,preference_key', [personId])).map(mapPreference);
    },
    async addOperationHistory(record) {
      return mapOperation(requireRow(await client.query(
        `INSERT INTO platform_notification_operation_history
         (id,notification_id,operation,actor_type,actor_person_id,service_identity_id,execution_type,source_app_id,request_id,trace_id,note,before_payload,after_payload,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) RETURNING *`,
        [record.id, record.notificationId, record.operation, record.actorType, record.actorPersonId, record.serviceIdentityId, record.executionType, record.sourceAppId, record.requestId, record.traceId, record.note, jsonOrNull(record.before), jsonOrNull(record.after), record.occurredAt]
      )));
    },
    async listOperationHistory(notificationId) {
      return rows(await client.query('SELECT * FROM platform_notification_operation_history WHERE notification_id=$1 ORDER BY occurred_at,id', [notificationId])).map(mapOperation);
    }
  };
}

async function insertNotification(client: QueryableClient, record: Notification) {
  return mapNotification(requireRow(await client.query(
    `INSERT INTO platform_notifications
     (id,source_app_id,source_entity_type,source_entity_id,notification_key,idempotency_key,idempotency_payload_hash,status,category,read_behavior,display_snapshot,template_snapshot,navigation_ref,created_by_person_id,created_by_actor_type,created_at,updated_at,cancelled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)
     RETURNING *`,
    [record.id, record.sourceAppId, record.sourceEntityType, record.sourceEntityId, record.notificationKey, record.idempotencyKey, record.idempotencyPayloadHash, record.status, record.category, record.readBehavior, JSON.stringify(record.display), jsonOrNull(record.template), jsonOrNull(record.navigation), record.createdByPersonId, record.createdByActorType, record.createdAt, record.updatedAt, record.cancelledAt]
  )));
}

async function insertRecipient(client: QueryableClient, record: NotificationRecipient) {
  await client.query(
    `INSERT INTO platform_notification_recipients
     (id,notification_id,recipient_type,recipient_id,person_id,recipient_snapshot,created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [record.id, record.notificationId, record.recipientType, record.recipientId, record.personId, JSON.stringify(record.recipientSnapshot), record.createdAt]
  );
}

async function insertChannelIntent(client: QueryableClient, record: NotificationChannelIntent) {
  await client.query(
    `INSERT INTO platform_notification_channel_intents
     (id,notification_id,recipient_id,channel,target_kind,target_id,status,provider_message_id,attempts,last_error,scheduled_at,delivered_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [record.id, record.notificationId, record.recipientId, record.channel, record.targetKind, record.targetId, record.status, record.providerMessageId, record.attempts, record.lastError, record.scheduledAt, record.deliveredAt, record.createdAt, record.updatedAt]
  );
}

function buildListWhere(input: NotificationListInput) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('?', `$${values.length}`));
  };
  if (input.sourceAppId) add('source_app_id=?', input.sourceAppId);
  if (input.category) add('category=?', input.category);
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    values.push(statuses);
    clauses.push(`status = ANY($${values.length}::text[])`);
  }
  if (input.recipientPersonId) {
    values.push(input.recipientPersonId);
    clauses.push(`EXISTS (SELECT 1 FROM platform_notification_recipients r WHERE r.notification_id=platform_notifications.id AND r.person_id=$${values.length})`);
    if (input.unreadOnly) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM platform_notification_reads rd WHERE rd.notification_id=platform_notifications.id AND rd.person_id=$${values.length})`);
    }
  }
  const limit = Number.isSafeInteger(input.limit) && input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values, limit };
}

function matchesListFilter(
  item: Notification,
  recipients: readonly NotificationRecipient[],
  reads: Map<string, NotificationRead>,
  input: NotificationListInput
) {
  if (input.sourceAppId && item.sourceAppId !== input.sourceAppId) return false;
  if (input.category && item.category !== input.category) return false;
  if (input.status) {
    const statuses = Array.isArray(input.status) ? input.status : [input.status];
    if (!statuses.includes(item.status)) return false;
  }
  if (input.recipientPersonId) {
    const isRecipient = recipients.some((recipient) => recipient.notificationId === item.id && recipient.personId === input.recipientPersonId);
    if (!isRecipient) return false;
    if (input.unreadOnly && [...reads.values()].some((read) => read.notificationId === item.id && read.personId === input.recipientPersonId)) return false;
  }
  return true;
}

function assertUniqueId<T>(records: Map<string, T>, id: string) {
  if (records.has(id)) throw new NotificationError('DUPLICATE_ID', `通知 ID 已存在: ${id}`);
}

function assertNotificationKey(records: Map<string, Notification>, record: Notification) {
  const existing = [...records.values()].find((item) => item.sourceAppId === record.sourceAppId && item.notificationKey === record.notificationKey);
  if (existing) throw new NotificationError('NOTIFICATION_KEY_CONFLICT', '通知键已存在');
}

function assertNotificationIdempotency(records: Map<string, Notification>, record: Notification) {
  if (!record.idempotencyKey) return;
  const existing = [...records.values()].find((item) => item.sourceAppId === record.sourceAppId && item.idempotencyKey === record.idempotencyKey);
  if (existing) throw new NotificationError('IDEMPOTENCY_CONFLICT', '通知幂等键已存在');
}

function compareNotifications(left: Notification, right: Notification) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function compareRecipients(left: NotificationRecipient, right: NotificationRecipient) {
  return left.personId.localeCompare(right.personId) || left.id.localeCompare(right.id);
}

function compareChannelIntents(left: NotificationChannelIntent, right: NotificationChannelIntent) {
  return left.recipientId.localeCompare(right.recipientId) || left.channel.localeCompare(right.channel) || left.id.localeCompare(right.id);
}

function compareReads(left: NotificationRead, right: NotificationRead) {
  return left.readAt.localeCompare(right.readAt) || left.id.localeCompare(right.id);
}

function compareDeliveryAttempts(left: NotificationDeliveryAttempt, right: NotificationDeliveryAttempt) {
  return left.attemptedAt.localeCompare(right.attemptedAt) || left.id.localeCompare(right.id);
}

function comparePreferences(left: NotificationPreference, right: NotificationPreference) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.preferenceKey.localeCompare(right.preferenceKey);
}

function compareOperationHistory(left: NotificationOperationHistory, right: NotificationOperationHistory) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined | null): T | null {
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
  if (!row) throw new NotificationError('DATABASE_WRITE_FAILED', '通知数据写入失败');
  return row;
}

function optional<T>(result: unknown, mapper: (row: Record<string, unknown>) => T) {
  const row = rows(result)[0];
  return row ? mapper(row) : null;
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value == null ? null : text(row, key);
}

function instant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function nullableInstant(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} 时间无效`);
}

function bool(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'boolean') throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
  return value;
}

function integer(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} 无效`);
}

function jsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new NotificationError('INVALID_DATABASE_ROW', `字段 ${key} JSON 无效`);
}

function nullableJsonObject(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value == null) return null;
  return jsonObject(row, key);
}

function mapNotification(row: Record<string, unknown>): Notification {
  return {
    id: text(row, 'id'),
    sourceAppId: text(row, 'source_app_id'),
    sourceEntityType: text(row, 'source_entity_type'),
    sourceEntityId: text(row, 'source_entity_id'),
    notificationKey: text(row, 'notification_key'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    idempotencyPayloadHash: nullableText(row, 'idempotency_payload_hash'),
    status: text(row, 'status') as Notification['status'],
    category: nullableText(row, 'category'),
    readBehavior: text(row, 'read_behavior') as Notification['readBehavior'],
    display: jsonObject(row, 'display_snapshot') as unknown as Notification['display'],
    template: nullableJsonObject(row, 'template_snapshot') as Notification['template'],
    navigation: nullableJsonObject(row, 'navigation_ref') as Notification['navigation'],
    createdByPersonId: nullableText(row, 'created_by_person_id'),
    createdByActorType: text(row, 'created_by_actor_type') as Notification['createdByActorType'],
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at'),
    cancelledAt: nullableInstant(row, 'cancelled_at')
  };
}

function mapRecipient(row: Record<string, unknown>): NotificationRecipient {
  return {
    id: text(row, 'id'),
    notificationId: text(row, 'notification_id'),
    recipientType: text(row, 'recipient_type') as NotificationRecipient['recipientType'],
    recipientId: text(row, 'recipient_id'),
    personId: text(row, 'person_id'),
    recipientSnapshot: jsonObject(row, 'recipient_snapshot') as unknown as NotificationRecipient['recipientSnapshot'],
    createdAt: instant(row, 'created_at')
  };
}

function mapChannelIntent(row: Record<string, unknown>): NotificationChannelIntent {
  return {
    id: text(row, 'id'),
    notificationId: text(row, 'notification_id'),
    recipientId: text(row, 'recipient_id'),
    channel: text(row, 'channel') as NotificationChannelIntent['channel'],
    targetKind: text(row, 'target_kind') as NotificationChannelIntent['targetKind'],
    targetId: text(row, 'target_id'),
    status: text(row, 'status') as NotificationChannelIntent['status'],
    providerMessageId: nullableText(row, 'provider_message_id'),
    attempts: integer(row, 'attempts'),
    lastError: nullableText(row, 'last_error'),
    scheduledAt: nullableInstant(row, 'scheduled_at'),
    deliveredAt: nullableInstant(row, 'delivered_at'),
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at')
  };
}

function mapRead(row: Record<string, unknown>): NotificationRead {
  return {
    id: text(row, 'id'),
    notificationId: text(row, 'notification_id'),
    personId: text(row, 'person_id'),
    readAt: instant(row, 'read_at'),
    createdAt: instant(row, 'created_at')
  };
}

function mapDeliveryAttempt(row: Record<string, unknown>): NotificationDeliveryAttempt {
  return {
    id: text(row, 'id'),
    channelIntentId: text(row, 'channel_intent_id'),
    status: text(row, 'status') as NotificationDeliveryAttempt['status'],
    providerMessageId: nullableText(row, 'provider_message_id'),
    errorMessage: nullableText(row, 'error_message'),
    attemptedAt: instant(row, 'attempted_at')
  };
}

function mapPreference(row: Record<string, unknown>): NotificationPreference {
  return {
    id: text(row, 'id'),
    preferenceKey: text(row, 'preference_key'),
    personId: text(row, 'person_id'),
    sourceAppId: nullableText(row, 'source_app_id'),
    category: nullableText(row, 'category'),
    channel: nullableText(row, 'channel') as NotificationPreference['channel'],
    muted: bool(row, 'muted'),
    quietWindow: nullableJsonObject(row, 'quiet_window') as NotificationPreference['quietWindow'],
    updatedByPersonId: nullableText(row, 'updated_by_person_id'),
    createdAt: instant(row, 'created_at'),
    updatedAt: instant(row, 'updated_at')
  };
}

function mapOperation(row: Record<string, unknown>): NotificationOperationHistory {
  return {
    id: text(row, 'id'),
    notificationId: nullableText(row, 'notification_id'),
    operation: text(row, 'operation') as NotificationOperationHistory['operation'],
    actorType: text(row, 'actor_type') as NotificationOperationHistory['actorType'],
    actorPersonId: nullableText(row, 'actor_person_id'),
    serviceIdentityId: nullableText(row, 'service_identity_id'),
    executionType: text(row, 'execution_type') as NotificationOperationHistory['executionType'],
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
