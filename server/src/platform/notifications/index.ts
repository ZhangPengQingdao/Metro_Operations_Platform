import { createHash, randomUUID } from 'node:crypto';
import { runAtomicOperation } from '../../core/database/index.js';
import { enqueueCoreEvent, type CoreOutboxRepository } from '../../core/events/index.js';
import type { AuthorizationResource, DataScopeTarget } from '../authorization/index.js';
import { applicationGrantAllows, type PlatformActorContext } from '../context/index.js';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_PERMISSION_CODES,
  NOTIFICATION_READ_BEHAVIORS,
  NOTIFICATION_RECIPIENT_TYPES,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_STATUSES,
  NotificationError,
  type CancelNotificationInput,
  type CreateNotificationInput,
  type LegacyNotificationReconciliation,
  type LegacyNotificationSnapshot,
  type MarkNotificationReadInput,
  type Notification,
  type NotificationChannel,
  type NotificationChannelIntent,
  type NotificationDeliveryAttempt,
  type NotificationDetail,
  type NotificationDisplaySnapshot,
  type NotificationListInput,
  type NotificationNavigationReference,
  type NotificationOperation,
  type NotificationPreference,
  type NotificationRead,
  type NotificationRecipient,
  type NotificationRecipientInput,
  type NotificationSourceReference,
  type NotificationTemplateSnapshot,
  type SetNotificationPreferenceInput,
  type UpdateNotificationDeliveryInput
} from './model.js';
import type { NotificationRepository } from './repository.js';

export * from './migration.js';
export * from './model.js';
export * from './repository.js';

export interface NotificationDirectoryPerson {
  organizationUnitId: string;
  organizationUnitName?: string | null;
  employmentStatus: string;
  name?: string | null;
}

export interface NotificationDirectoryOrganizationUnit {
  status: string;
  name?: string | null;
}

export interface NotificationServiceOptions {
  clock?: () => Date;
  createId?: () => string;
  createEventId?: () => string;
  outbox?: CoreOutboxRepository;
  findPerson(id: string): Promise<NotificationDirectoryPerson | null>;
  findOrganizationUnit(id: string): Promise<NotificationDirectoryOrganizationUnit | null>;
  listActiveOrganizationMembers(organizationUnitId: string): Promise<Array<{
    id: string;
    organizationUnitId: string;
    organizationUnitName?: string | null;
    employmentStatus: string;
    name?: string | null;
  }>>;
}

export class NotificationService {
  private readonly createId: () => string;
  private readonly createEventId: () => string;
  private readonly clock: () => Date;

  constructor(private readonly repository: NotificationRepository, private readonly options: NotificationServiceOptions) {
    this.createId = options.createId ?? randomUUID;
    this.createEventId = options.createEventId ?? this.createId;
    this.clock = options.clock ?? (() => new Date());
  }

  async createNotification(context: PlatformActorContext, input: CreateNotificationInput): Promise<Notification> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.createNotificationCommand(context, input));
  }

  private async createNotificationCommand(context: PlatformActorContext, input: CreateNotificationInput): Promise<Notification> {
    const draft = await this.prepareNotificationDraft(context, input);
    const hash = payloadHash(draft.idempotencyPayload);
    for (const recipient of draft.recipients) {
      await this.requireAuthorized(context, NOTIFICATION_PERMISSION_CODES.create, this.resourceForRecipients([recipient]));
    }
    const existingByKey = await this.repository.findNotificationByKey(draft.record.sourceAppId, draft.record.notificationKey);
    if (existingByKey) return this.returnIdempotent(existingByKey, hash, 'NOTIFICATION_KEY_CONFLICT');
    if (draft.record.idempotencyKey) {
      const existing = await this.repository.findNotificationByIdempotencyKey(draft.record.sourceAppId, draft.record.idempotencyKey);
      if (existing) return this.returnIdempotent(existing, hash, 'IDEMPOTENCY_CONFLICT');
    }
    const saved = await this.repository.createNotification({ ...draft.record, idempotencyPayloadHash: hash }, draft.recipients, draft.channelIntents);
    await this.recordOperation(context, saved.id, 'created', null, saved, null);
    await this.emit(context, saved, NOTIFICATION_EVENT_TYPES.created, 'created', ['status', 'recipients', 'channelIntents']);
    return saved;
  }

  async getNotification(context: PlatformActorContext, notificationId: string): Promise<NotificationDetail> {
    return runAtomicOperation([this.repository], () => this.getNotificationQuery(context, notificationId));
  }

  private async getNotificationQuery(context: PlatformActorContext, notificationId: string): Promise<NotificationDetail> {
    const notification = await this.requireReadableNotification(context, uuid(notificationId, 'notification id'), 'share');
    return this.detail(notification);
  }

  async listNotifications(context: PlatformActorContext, input: NotificationListInput = {}): Promise<Notification[]> {
    return runAtomicOperation([this.repository], () => this.listNotificationsQuery(context, input));
  }

  private async listNotificationsQuery(context: PlatformActorContext, input: NotificationListInput = {}): Promise<Notification[]> {
    const normalized = normalizeListInput(input);
    const canReadAll = (await context.authorize(NOTIFICATION_PERMISSION_CODES.read, {})).allowed;
    const scoped = !canReadAll && context.actorType === 'person' && !normalized.recipientPersonId
      ? { ...normalized, recipientPersonId: context.person.id }
      : normalized;
    const notifications = await this.repository.listNotifications(scoped);
    const readable: Notification[] = [];
    for (const notification of notifications) {
      if (await this.canRead(context, notification)) readable.push(notification);
    }
    return readable;
  }

  async markRead(context: PlatformActorContext, input: MarkNotificationReadInput): Promise<NotificationRead> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.markReadCommand(context, input));
  }

  private async markReadCommand(context: PlatformActorContext, input: MarkNotificationReadInput): Promise<NotificationRead> {
    if (context.actorType !== 'person') throw new NotificationError('PERSON_ACTOR_REQUIRED', '标记通知已读需要人员上下文');
    // Parent row is the only command lock. Children are always read/written after it.
    const notification = await this.requireReadableNotification(context, uuid(input.notificationId, 'notification id'), 'update');
    const recipient = await this.repository.findRecipient(notification.id, context.person.id);
    if (!recipient) throw new NotificationError('NOTIFICATION_ACCESS_DENIED', '只有有效收件人可以标记通知已读');
    const existingRead = await this.repository.findRead(notification.id, context.person.id);
    if (existingRead) return existingRead;
    const now = this.nowIso();
    const read: NotificationRead = {
      id: uuid(this.createId(), 'notification read id'),
      notificationId: notification.id,
      personId: context.person.id,
      readAt: now,
      createdAt: now
    };
    const saved = await this.repository.upsertRead(read);
    await this.recordOperation(context, notification.id, 'read', null, saved, input.note);
    await this.emit(context, notification, NOTIFICATION_EVENT_TYPES.read, 'read', ['readAt']);
    return saved;
  }

  async updateDelivery(context: PlatformActorContext, input: UpdateNotificationDeliveryInput): Promise<NotificationChannelIntent> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.updateDeliveryCommand(context, input));
  }

  private async updateDeliveryCommand(context: PlatformActorContext, input: UpdateNotificationDeliveryInput): Promise<NotificationChannelIntent> {
    const locatedIntent = await this.repository.findChannelIntentById(uuid(input.channelIntentId, 'channel intent id'));
    if (!locatedIntent) throw new NotificationError('CHANNEL_INTENT_NOT_FOUND', '通知渠道意图不存在');
    // Intent lookup locates the parent but acquires no lock; parent is locked before re-reading intent.
    const notification = await this.requireExistingNotification(locatedIntent.notificationId, 'update');
    const intent = await this.repository.findChannelIntentById(locatedIntent.id);
    if (!intent) throw new NotificationError('CHANNEL_INTENT_NOT_FOUND', '通知渠道意图不存在');
    await this.requireAuthorized(context, NOTIFICATION_PERMISSION_CODES.deliveryManage, await this.resourceForNotification(notification));
    if (notification.status === 'cancelled' || intent.status === 'cancelled' || intent.status === 'sent') {
      throw new NotificationError('DELIVERY_ALREADY_TERMINAL', '已取消或已送达的通知不能更新投递状态');
    }
    const before = structuredClone(intent);
    const attemptedAt = input.attemptedAt ?? this.clock();
    const status = deliveryStatus(input.status);
    const next: NotificationChannelIntent = {
      ...intent,
      status,
      providerMessageId: input.providerMessageId === undefined ? intent.providerMessageId : normalizeOptionalText(input.providerMessageId, 260),
      attempts: intent.attempts + 1,
      lastError: status === 'failed' ? normalizeOptionalText(input.errorMessage ?? null, 2000) : null,
      deliveredAt: status === 'sent' ? attemptedAt.toISOString() : intent.deliveredAt,
      updatedAt: attemptedAt.toISOString()
    };
    const saved = await this.repository.updateChannelIntent(next);
    const attempt: NotificationDeliveryAttempt = {
      id: uuid(this.createId(), 'delivery attempt id'),
      channelIntentId: saved.id,
      status: saved.status,
      providerMessageId: saved.providerMessageId,
      errorMessage: saved.lastError,
      attemptedAt: attemptedAt.toISOString()
    };
    await this.repository.addDeliveryAttempt(attempt);
    await this.recordOperation(context, notification.id, 'delivery_updated', before, saved, input.note);
    await this.emit(context, notification, NOTIFICATION_EVENT_TYPES.deliveryUpdated, 'delivery_updated', ['channel', 'status', 'attempts']);
    return saved;
  }

  async setPreference(context: PlatformActorContext, input: SetNotificationPreferenceInput): Promise<NotificationPreference> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.setPreferenceCommand(context, input));
  }

  private async setPreferenceCommand(context: PlatformActorContext, input: SetNotificationPreferenceInput): Promise<NotificationPreference> {
    const personId = await this.validatePerson(input.personId ?? (context.actorType === 'person' ? context.person.id : null));
    if (!await applicationGrantAllows(context, NOTIFICATION_PERMISSION_CODES.preferencesManage, { ownerPersonId: personId, organizationUnitId: (await this.requireActivePerson(personId)).organizationUnitId })) {
      throw new NotificationError('NOTIFICATION_PERMISSION_DENIED', '应用未获授权管理该人员通知偏好');
    }
    if (context.actorType !== 'person' || context.person.id !== personId) {
      await this.requireAuthorized(context, NOTIFICATION_PERMISSION_CODES.preferencesManage, { ownerPersonId: personId });
    }
    const now = this.nowIso();
    const channel = input.channel === undefined ? null : notificationChannelOrNull(input.channel);
    const preference: NotificationPreference = {
      id: uuid(this.createId(), 'notification preference id'),
      preferenceKey: preferenceKey(personId, input.sourceAppId ?? null, input.category ?? null, channel),
      personId,
      sourceAppId: normalizeOptionalText(input.sourceAppId ?? null, 100),
      category: normalizeOptionalText(input.category ?? null, 100),
      channel,
      muted: Boolean(input.muted),
      quietWindow: normalizeQuietWindow(input.quietWindow),
      updatedByPersonId: context.actorType === 'person' ? context.person.id : null,
      createdAt: now,
      updatedAt: now
    };
    const existing = await this.repository.findPreferenceByKey(preference.preferenceKey);
    const saved = await this.repository.upsertPreference(preference);
    await this.recordOperation(context, null, 'preference_updated', existing, saved, input.note);
    await this.emitPreference(context, saved);
    return saved;
  }

  async cancelNotification(context: PlatformActorContext, input: CancelNotificationInput): Promise<Notification> {
    return runAtomicOperation([this.repository, ...(this.options.outbox ? [this.options.outbox] : [])], () => this.cancelNotificationCommand(context, input));
  }

  private async cancelNotificationCommand(context: PlatformActorContext, input: CancelNotificationInput): Promise<Notification> {
    const notification = await this.requireExistingNotification(input.notificationId, 'update');
    await this.requireAuthorized(context, NOTIFICATION_PERMISSION_CODES.manage, await this.resourceForNotification(notification));
    if (notification.status === 'cancelled') return notification;
    const before = structuredClone(notification);
    const now = this.nowIso();
    const intents = await this.repository.listChannelIntents(notification.id);
    const saved = await this.repository.updateNotification({
      ...notification,
      status: 'cancelled',
      updatedAt: now,
      cancelledAt: now
    });
    for (const intent of intents) {
      if (intent.status === 'pending' || intent.status === 'queued') {
        await this.repository.updateChannelIntent({ ...intent, status: 'cancelled', updatedAt: now });
      }
    }
    await this.recordOperation(context, saved.id, 'cancelled', before, saved, input.note);
    await this.emit(context, saved, NOTIFICATION_EVENT_TYPES.cancelled, 'cancelled', ['status', 'channelIntents']);
    return saved;
  }

  async deleteNotification(): Promise<never> {
    throw new NotificationError('HARD_DELETE_NOT_SUPPORTED', '平台通知不提供业务硬删除接口，请取消或归档通知');
  }

  private async prepareNotificationDraft(context: PlatformActorContext, input: CreateNotificationInput) {
    const source = normalizeSource(input.source);
    assertExecutionSource(context, source.appId);
    const now = this.nowIso();
    const notificationId = uuid(input.id ?? this.createId(), 'notification id');
    const record: Notification = {
      id: notificationId,
      sourceAppId: source.appId,
      sourceEntityType: source.entityType,
      sourceEntityId: source.entityId,
      notificationKey: boundedText(input.notificationKey, 260, 'notification key'),
      idempotencyKey: normalizeOptionalText(input.idempotencyKey, 200),
      idempotencyPayloadHash: null,
      status: 'active',
      category: normalizeOptionalText(input.category ?? null, 100),
      readBehavior: readBehavior(input.readBehavior ?? 'mark_read'),
      display: normalizeDisplay(input.display),
      template: normalizeTemplate(input.template ?? null),
      navigation: normalizeNavigation(input.navigation ?? null),
      createdByPersonId: context.actorType === 'person' ? context.person.id : null,
      createdByActorType: context.actorType,
      createdAt: now,
      updatedAt: now,
      cancelledAt: null
    };
    const recipients = await this.resolveRecipients(notificationId, input.recipients, now);
    const channels = normalizeChannels(input.channels);
    const scheduledAt = input.scheduledAt?.toISOString() ?? null;
    const channelIntents = recipients.flatMap((recipient) => channels.map((channel) => this.createChannelIntent(record.id, recipient, channel, scheduledAt, now)));
    return {
      record,
      recipients,
      channelIntents,
      idempotencyPayload: normalizePayload({
        source,
        notificationKey: record.notificationKey,
        category: record.category,
        readBehavior: record.readBehavior,
        display: record.display,
        template: record.template,
        navigation: record.navigation,
        recipients: recipients.map((recipient) => ({
          recipientType: recipient.recipientType,
          recipientId: recipient.recipientId,
          personId: recipient.personId
        })),
        channels,
        scheduledAt
      })
    };
  }

  private async resolveRecipients(notificationId: string, input: readonly NotificationRecipientInput[], createdAt: string) {
    if (input.length === 0) throw new NotificationError('RECIPIENT_REQUIRED', '通知至少需要一个收件人');
    const recipients: NotificationRecipient[] = [];
    const seenPersons = new Set<string>();
    for (const recipient of input) {
      if (!NOTIFICATION_RECIPIENT_TYPES.includes(recipient.recipientType)) throw new NotificationError('INVALID_RECIPIENT_TYPE', '通知收件人类型无效');
      const recipientId = uuid(recipient.recipientId, 'recipient id');
      if (recipient.recipientType === 'person') {
        const person = await this.requireActivePerson(recipientId);
        this.addResolvedRecipient(recipients, seenPersons, {
          notificationId,
          recipientType: 'person',
          recipientId,
          personId: recipientId,
          person,
          createdAt
        });
      } else {
        const organization = await this.requireActiveOrganization(recipientId);
        const members = await this.options.listActiveOrganizationMembers(recipientId);
        for (const member of members) {
          if (member.organizationUnitId !== recipientId || member.employmentStatus !== 'active') continue;
          this.addResolvedRecipient(recipients, seenPersons, {
            notificationId,
            recipientType: 'organization_unit',
            recipientId,
            personId: uuid(member.id, 'organization member id'),
            person: {
              organizationUnitId: member.organizationUnitId,
              organizationUnitName: member.organizationUnitName ?? organization.name ?? null,
              employmentStatus: member.employmentStatus,
              name: member.name ?? null
            },
            createdAt
          });
        }
      }
    }
    if (recipients.length === 0) throw new NotificationError('NO_EFFECTIVE_RECIPIENTS', '通知没有可解析的有效收件人');
    return recipients;
  }

  private addResolvedRecipient(
    recipients: NotificationRecipient[],
    seenPersons: Set<string>,
    input: {
      notificationId: string;
      recipientType: NotificationRecipient['recipientType'];
      recipientId: string;
      personId: string;
      person: NotificationDirectoryPerson;
      createdAt: string;
    }
  ) {
    if (seenPersons.has(input.personId)) return;
    seenPersons.add(input.personId);
    recipients.push({
      id: uuid(this.createId(), 'notification recipient id'),
      notificationId: input.notificationId,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      personId: input.personId,
      recipientSnapshot: {
        name: normalizeOptionalText(input.person.name ?? null, 120),
        organizationUnitId: input.person.organizationUnitId,
        organizationUnitName: normalizeOptionalText(input.person.organizationUnitName ?? null, 150)
      },
      createdAt: input.createdAt
    });
  }

  private createChannelIntent(
    notificationId: string,
    recipient: NotificationRecipient,
    channel: NotificationChannel,
    scheduledAt: string | null,
    now: string
  ): NotificationChannelIntent {
    return {
      id: uuid(this.createId(), 'notification channel intent id'),
      notificationId,
      recipientId: recipient.id,
      channel,
      targetKind: channel === 'webhook' ? 'app' : 'person',
      targetId: channel === 'webhook' ? notificationId : recipient.personId,
      status: 'pending',
      providerMessageId: null,
      attempts: 0,
      lastError: null,
      scheduledAt,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private async requireExistingNotification(id: string, lock?: 'share' | 'update') {
    const notification = await this.repository.findNotificationById(uuid(id, 'notification id'), lock);
    if (!notification) throw new NotificationError('NOTIFICATION_NOT_FOUND', '通知不存在');
    return notification;
  }

  private async requireReadableNotification(context: PlatformActorContext, id: string, lock?: 'share' | 'update') {
    const notification = await this.requireExistingNotification(id, lock);
    if (!await this.canRead(context, notification)) throw new NotificationError('NOTIFICATION_ACCESS_DENIED', '无权查看通知');
    return notification;
  }

  private async canRead(context: PlatformActorContext, notification: Notification) {
    const recipient = context.actorType === 'person' ? await this.repository.findRecipient(notification.id, context.person.id) : null;
    const resource = recipient ? this.resourceForRecipients([recipient]) : await this.resourceForNotification(notification);
    if (!await applicationGrantAllows(context, NOTIFICATION_PERMISSION_CODES.read, resource)) return false;
    if (ownSourceExecution(context, notification.sourceAppId)) return true;
    if (recipient) return true;
    return (await context.authorize(NOTIFICATION_PERMISSION_CODES.read, resource)).allowed;
  }

  private async requireAuthorized(context: PlatformActorContext, permissionCode: string, resource: AuthorizationResource) {
    if (!await applicationGrantAllows(context, permissionCode, resource)) throw new NotificationError('NOTIFICATION_PERMISSION_DENIED', `应用缺少权限: ${permissionCode}`);
    const decision = await context.authorize(permissionCode, resource);
    if (!decision.allowed) throw new NotificationError('NOTIFICATION_PERMISSION_DENIED', `缺少权限: ${permissionCode}`);
  }

  private async resourceForNotification(notification: Notification): Promise<AuthorizationResource> {
    return this.resourceForRecipients(await this.repository.listRecipients(notification.id), notification.createdByPersonId);
  }

  private resourceForRecipients(recipients: readonly NotificationRecipient[], fallbackOwnerPersonId?: string | null): AuthorizationResource {
    const targets: DataScopeTarget[] = [];
    const firstPerson = recipients[0]?.personId ?? fallbackOwnerPersonId ?? null;
    const firstOrg = recipients[0]?.recipientSnapshot.organizationUnitId ?? null;
    for (const recipient of recipients) {
      if (recipient.recipientType === 'organization_unit') targets.push({ type: 'organization', id: recipient.recipientId });
    }
    return { ownerPersonId: firstPerson, organizationUnitId: firstOrg, targets };
  }

  private async detail(notification: Notification): Promise<NotificationDetail> {
    const channelIntents = await this.repository.listChannelIntents(notification.id);
    const deliveryAttempts = (await Promise.all(channelIntents.map((intent) => this.repository.listDeliveryAttempts(intent.id)))).flat();
    return {
      notification,
      recipients: await this.repository.listRecipients(notification.id),
      channelIntents,
      deliveryAttempts,
      reads: await this.repository.listReads(notification.id),
      operationHistory: await this.repository.listOperationHistory(notification.id)
    };
  }

  private returnIdempotent(existing: Notification, hash: string, conflictCode: 'IDEMPOTENCY_CONFLICT' | 'NOTIFICATION_KEY_CONFLICT') {
    if (existing.idempotencyPayloadHash !== hash) throw new NotificationError(conflictCode, '相同通知键或幂等键的请求内容不同');
    return existing;
  }

  private async requireActivePerson(personId: string) {
    const person = await this.options.findPerson(personId);
    if (!person) throw new NotificationError('PERSON_NOT_FOUND', '人员不存在');
    if (person.employmentStatus !== 'active') throw new NotificationError('PERSON_INACTIVE', '人员不在岗');
    return person;
  }

  private async validatePerson(personId: string | null | undefined) {
    if (!personId) throw new NotificationError('PERSON_REQUIRED', '通知偏好需要人员');
    const id = uuid(personId, 'person id');
    await this.requireActivePerson(id);
    return id;
  }

  private async requireActiveOrganization(organizationUnitId: string) {
    const organization = await this.options.findOrganizationUnit(organizationUnitId);
    if (!organization) throw new NotificationError('ORGANIZATION_NOT_FOUND', '组织不存在');
    if (organization.status !== 'active') throw new NotificationError('ORGANIZATION_INACTIVE', '组织未启用');
    return organization;
  }

  private async recordOperation(
    context: PlatformActorContext,
    notificationId: string | null,
    operation: NotificationOperation,
    before: unknown,
    after: unknown,
    note: string | null | undefined
  ) {
    await this.repository.addOperationHistory({
      id: uuid(this.createId(), 'notification operation id'),
      notificationId,
      operation,
      actorType: context.actorType,
      actorPersonId: context.actorType === 'person' ? context.person.id : null,
      serviceIdentityId: context.actorType === 'service' ? context.execution.serviceIdentityId : null,
      executionType: context.execution.type,
      sourceAppId: context.execution.type === 'platform' ? null : context.execution.appId,
      requestId: context.request.requestId,
      traceId: context.request.traceId,
      note: normalizeOptionalText(note, 2000),
      before: operationPayload(before),
      after: operationPayload(after),
      occurredAt: this.nowIso()
    });
  }

  private async emit(context: PlatformActorContext, notification: Notification, type: string, operation: string, changedFieldsValue: readonly string[]) {
    if (!this.options.outbox) return;
    await enqueueCoreEvent(this.options.outbox, {
      type,
      source: 'platform/notifications',
      payload: {
        notificationId: notification.id,
        notificationKey: notification.notificationKey,
        sourceAppId: notification.sourceAppId,
        operation,
        status: notification.status,
        actorType: context.actorType,
        actorPersonId: context.actorType === 'person' ? context.person.id : null,
        changedFields: [...changedFieldsValue]
      },
      actorId: context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId,
      correlationId: context.request.traceId,
      causationId: context.request.requestId
    }, { clock: this.clock, createEventId: this.createEventId });
  }

  private async emitPreference(context: PlatformActorContext, preference: NotificationPreference) {
    if (!this.options.outbox) return;
    await enqueueCoreEvent(this.options.outbox, {
      type: NOTIFICATION_EVENT_TYPES.preferenceUpdated,
      source: 'platform/notifications',
      payload: {
        preferenceId: preference.id,
        personId: preference.personId,
        sourceAppId: preference.sourceAppId,
        category: preference.category,
        channel: preference.channel,
        muted: preference.muted,
        actorType: context.actorType,
        actorPersonId: context.actorType === 'person' ? context.person.id : null
      },
      actorId: context.actorType === 'person' ? context.person.id : context.execution.serviceIdentityId,
      correlationId: context.request.traceId,
      causationId: context.request.requestId
    }, { clock: this.clock, createEventId: this.createEventId });
  }

  private nowIso() {
    return this.clock().toISOString();
  }
}

export function createNotificationService(repository: NotificationRepository, options: NotificationServiceOptions) {
  return new NotificationService(repository, options);
}

export function reconcileLegacyNotifications(snapshot: LegacyNotificationSnapshot): LegacyNotificationReconciliation {
  const issues: LegacyNotificationReconciliation['issues'] = [];
  const readKeys = new Set<string>();
  for (const read of snapshot.reads ?? []) {
    const key = read.notificationKey?.trim();
    if (!key) {
      issues.push({ code: 'MISSING_KEY', sourceId: read.userId });
      continue;
    }
    const dedupeKey = `${read.userId}:${key}`;
    if (readKeys.has(dedupeKey)) issues.push({ code: 'DUPLICATE_READ', sourceId: dedupeKey });
    readKeys.add(dedupeKey);
  }
  let markReadCount = 0;
  let stateBoundCount = 0;
  for (const notification of snapshot.generated ?? []) {
    if (!notification.key?.trim()) issues.push({ code: 'MISSING_KEY', sourceId: notification.sourceId });
    if (!notification.actionUrl?.trim()) issues.push({ code: 'MISSING_ACTION_URL', sourceId: notification.key || notification.sourceId });
    if (!NOTIFICATION_READ_BEHAVIORS.includes(notification.readBehavior)) issues.push({ code: 'INVALID_READ_BEHAVIOR', sourceId: notification.key || notification.sourceId });
    else if (notification.readBehavior === 'mark_read') markReadCount += 1;
    else stateBoundCount += 1;
  }
  return {
    readCount: snapshot.reads?.length ?? 0,
    generatedCount: snapshot.generated?.length ?? 0,
    uniqueReadKeys: readKeys.size,
    markReadCount,
    stateBoundCount,
    issues
  };
}

function normalizeSource(source: NotificationSourceReference) {
  return {
    appId: appId(source.appId),
    entityType: boundedText(source.entityType, 100, 'source entity type'),
    entityId: boundedText(source.entityId, 200, 'source entity id')
  };
}

function normalizeDisplay(display: NotificationDisplaySnapshot): NotificationDisplaySnapshot {
  return {
    title: boundedText(display.title, 160, 'notification title'),
    body: boundedText(display.body, 4000, 'notification body'),
    severity: severity(display.severity),
    sourceLabel: normalizeOptionalText(display.sourceLabel, 120)
  };
}

function normalizeNavigation(navigation: NotificationNavigationReference | null): NotificationNavigationReference | null {
  if (!navigation) return null;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(navigation.params ?? {})) {
    params[boundedText(key, 80, 'navigation param key')] = boundedText(value, 500, 'navigation param value');
  }
  return {
    href: normalizeOptionalText(navigation.href, 1000),
    routeName: normalizeOptionalText(navigation.routeName, 120),
    params
  };
}

function normalizeTemplate(template: NotificationTemplateSnapshot | null): NotificationTemplateSnapshot | null {
  if (!template) return null;
  const variables: NotificationTemplateSnapshot['variables'] = {};
  for (const [key, value] of Object.entries(template.variables ?? {})) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new NotificationError('INVALID_TEMPLATE_VARIABLE', '通知模板变量只支持字符串、数字、布尔值或 null');
    }
    variables[boundedText(key, 80, 'template variable key')] = value;
  }
  return {
    templateKey: boundedText(template.templateKey, 120, 'template key'),
    templateVersion: boundedText(template.templateVersion, 40, 'template version'),
    locale: normalizeOptionalText(template.locale, 20),
    variables
  };
}

function normalizeChannels(channels: readonly NotificationChannel[] | undefined) {
  const values = channels?.length ? channels : ['in_app' as const];
  const result: NotificationChannel[] = [];
  for (const channel of values) {
    const normalized = notificationChannel(channel);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeListInput(input: NotificationListInput): NotificationListInput {
  return {
    sourceAppId: input.sourceAppId ? appId(input.sourceAppId) : undefined,
    status: normalizeStatusFilter(input.status),
    category: normalizeOptionalText(input.category ?? null, 100) ?? undefined,
    recipientPersonId: input.recipientPersonId ? uuid(input.recipientPersonId, 'recipient person id') : undefined,
    unreadOnly: input.unreadOnly ?? false,
    limit: input.limit
  };
}

function normalizeStatusFilter(value: NotificationListInput['status']) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => notificationStatus(entry));
  return notificationStatus(value as string);
}

function normalizeQuietWindow(quietWindow: NotificationPreference['quietWindow'] | undefined) {
  if (!quietWindow) return null;
  const start = minuteOfDay(quietWindow.startMinuteOfDay, 'quiet window start');
  const end = minuteOfDay(quietWindow.endMinuteOfDay, 'quiet window end');
  if (start === end) throw new NotificationError('INVALID_QUIET_WINDOW', '通知免打扰开始和结束时间不能相同');
  return {
    startMinuteOfDay: start,
    endMinuteOfDay: end,
    timezone: boundedText(quietWindow.timezone, 80, 'quiet window timezone')
  };
}

function severity(value: string) {
  if (!NOTIFICATION_SEVERITIES.includes(value as NotificationDisplaySnapshot['severity'])) throw new NotificationError('INVALID_SEVERITY', '通知级别无效');
  return value as NotificationDisplaySnapshot['severity'];
}

function readBehavior(value: string) {
  if (!NOTIFICATION_READ_BEHAVIORS.includes(value as NonNullable<CreateNotificationInput['readBehavior']>)) throw new NotificationError('INVALID_READ_BEHAVIOR', '通知已读行为无效');
  return value as NonNullable<CreateNotificationInput['readBehavior']>;
}

function notificationStatus(value: string) {
  if (!NOTIFICATION_STATUSES.includes(value as Notification['status'])) throw new NotificationError('INVALID_NOTIFICATION_STATUS', '通知状态无效');
  return value as Notification['status'];
}

function notificationChannel(value: string) {
  if (!NOTIFICATION_CHANNELS.includes(value as NotificationChannel)) throw new NotificationError('INVALID_CHANNEL', '通知渠道无效');
  return value as NotificationChannel;
}

function notificationChannelOrNull(value: string | null | undefined) {
  if (!value) return null;
  return notificationChannel(value);
}

function deliveryStatus(value: string) {
  if (!NOTIFICATION_DELIVERY_STATUSES.includes(value as UpdateNotificationDeliveryInput['status'])) throw new NotificationError('INVALID_DELIVERY_STATUS', '通知投递状态无效');
  return value as UpdateNotificationDeliveryInput['status'];
}

function boundedText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string') throw new NotificationError('INVALID_TEXT', `${label} 必须是字符串`);
  const text = value.trim();
  if (!text) throw new NotificationError('REQUIRED_TEXT', `${label} 不能为空`);
  if (text.length > maxLength) throw new NotificationError('TEXT_TOO_LONG', `${label} 超过长度限制`);
  return text;
}

function normalizeOptionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new NotificationError('INVALID_TEXT', '可选文本必须是字符串');
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw new NotificationError('TEXT_TOO_LONG', '可选文本超过长度限制');
  return text;
}

function appId(value: string) {
  if (!/^[a-z][a-z0-9_-]{1,98}[a-z0-9]$/.test(value)) throw new NotificationError('INVALID_APP_ID', '应用 ID 无效');
  return value;
}

function uuid(value: string, label: string) {
  const text = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new NotificationError('INVALID_UUID', `${label} 无效`);
  }
  return text.toLowerCase();
}

function minuteOfDay(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1439) throw new NotificationError('INVALID_MINUTE_OF_DAY', `${label} 无效`);
  return value;
}

function assertExecutionSource(context: PlatformActorContext, sourceAppId: string) {
  if (context.execution.type !== 'platform' && context.execution.appId !== sourceAppId) {
    throw new NotificationError('SOURCE_APP_MISMATCH', '执行上下文与通知来源应用不一致');
  }
}

function ownSourceExecution(context: PlatformActorContext, sourceAppId: string) {
  return context.execution.type !== 'platform' && context.execution.appId === sourceAppId;
}

function preferenceKey(personId: string, sourceAppId: string | null, category: string | null, channel: NotificationChannel | null) {
  return [
    `person:${personId}`,
    `source:${sourceAppId ? appId(sourceAppId) : '*'}`,
    `category:${category ? boundedText(category, 100, 'preference category') : '*'}`,
    `channel:${channel ?? '*'}`
  ].join('|');
}

function payloadHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  if (typeof value !== 'object') return { value };
  return normalizePayload(value) as Record<string, unknown>;
}
