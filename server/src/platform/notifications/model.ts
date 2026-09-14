export const NOTIFICATION_STATUSES = ['active', 'cancelled', 'archived'] as const;
export const NOTIFICATION_SEVERITIES = ['normal', 'warning', 'urgent'] as const;
export const NOTIFICATION_READ_BEHAVIORS = ['mark_read', 'state_bound'] as const;
export const NOTIFICATION_RECIPIENT_TYPES = ['person', 'organization_unit'] as const;
export const NOTIFICATION_CHANNELS = ['in_app', 'wecom', 'email', 'sms', 'webhook'] as const;
export const NOTIFICATION_CHANNEL_TARGET_KINDS = ['person', 'organization_unit', 'wecom_user', 'wecom_group', 'email', 'phone', 'url', 'app'] as const;
export const NOTIFICATION_DELIVERY_STATUSES = ['pending', 'queued', 'sent', 'failed', 'skipped', 'cancelled'] as const;

export const NOTIFICATION_PERMISSION_CODES = {
  create: 'platform.notifications.create',
  read: 'platform.notifications.read',
  manage: 'platform.notifications.manage',
  deliveryManage: 'platform.notifications.delivery.manage',
  preferencesManage: 'platform.notifications.preferences.manage'
} as const;

export const NOTIFICATION_PERMISSION_SEEDS = [
  { id: '48000000-0000-4000-8000-000000000011', code: NOTIFICATION_PERMISSION_CODES.create, name: '创建平台通知' },
  { id: '48000000-0000-4000-8000-000000000012', code: NOTIFICATION_PERMISSION_CODES.read, name: '查看平台通知' },
  { id: '48000000-0000-4000-8000-000000000013', code: NOTIFICATION_PERMISSION_CODES.manage, name: '管理平台通知' },
  { id: '48000000-0000-4000-8000-000000000014', code: NOTIFICATION_PERMISSION_CODES.deliveryManage, name: '管理平台通知投递状态' },
  { id: '48000000-0000-4000-8000-000000000015', code: NOTIFICATION_PERMISSION_CODES.preferencesManage, name: '管理平台通知偏好' }
] as const;

export const NOTIFICATION_EVENT_TYPES = {
  created: 'platform.notifications.created.v1',
  read: 'platform.notifications.read.v1',
  deliveryUpdated: 'platform.notifications.delivery-updated.v1',
  preferenceUpdated: 'platform.notifications.preference-updated.v1',
  cancelled: 'platform.notifications.cancelled.v1'
} as const;

export type NotificationStatus = typeof NOTIFICATION_STATUSES[number];
export type NotificationSeverity = typeof NOTIFICATION_SEVERITIES[number];
export type NotificationReadBehavior = typeof NOTIFICATION_READ_BEHAVIORS[number];
export type NotificationRecipientType = typeof NOTIFICATION_RECIPIENT_TYPES[number];
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type NotificationChannelTargetKind = typeof NOTIFICATION_CHANNEL_TARGET_KINDS[number];
export type NotificationDeliveryStatus = typeof NOTIFICATION_DELIVERY_STATUSES[number];
export type NotificationPermissionCode = typeof NOTIFICATION_PERMISSION_CODES[keyof typeof NOTIFICATION_PERMISSION_CODES];
export type NotificationEventType = typeof NOTIFICATION_EVENT_TYPES[keyof typeof NOTIFICATION_EVENT_TYPES];
export type NotificationExecutionType = 'platform' | 'application' | 'service';
export type NotificationActorType = 'person' | 'service';
export type NotificationOperation =
  | 'created'
  | 'read'
  | 'delivery_updated'
  | 'preference_updated'
  | 'cancelled';

export interface NotificationSourceReference {
  appId: string;
  entityType: string;
  entityId: string;
}

export interface NotificationDisplaySnapshot {
  title: string;
  body: string;
  severity: NotificationSeverity;
  sourceLabel: string | null;
}

export interface NotificationNavigationReference {
  href: string | null;
  routeName: string | null;
  params: Record<string, string>;
}

export interface NotificationTemplateSnapshot {
  templateKey: string;
  templateVersion: string;
  locale: string | null;
  variables: Record<string, string | number | boolean | null>;
}

export interface NotificationRecipientInput {
  recipientType: NotificationRecipientType;
  recipientId: string;
}

export interface NotificationRecipient {
  id: string;
  notificationId: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
  personId: string;
  recipientSnapshot: {
    name: string | null;
    organizationUnitId: string | null;
    organizationUnitName: string | null;
  };
  createdAt: string;
}

export interface NotificationChannelIntent {
  id: string;
  notificationId: string;
  recipientId: string;
  channel: NotificationChannel;
  targetKind: NotificationChannelTargetKind;
  targetId: string;
  status: NotificationDeliveryStatus;
  providerMessageId: string | null;
  attempts: number;
  lastError: string | null;
  scheduledAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  sourceAppId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  notificationKey: string;
  idempotencyKey: string | null;
  idempotencyPayloadHash: string | null;
  status: NotificationStatus;
  category: string | null;
  readBehavior: NotificationReadBehavior;
  display: NotificationDisplaySnapshot;
  template: NotificationTemplateSnapshot | null;
  navigation: NotificationNavigationReference | null;
  createdByPersonId: string | null;
  createdByActorType: NotificationActorType;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface NotificationRead {
  id: string;
  notificationId: string;
  personId: string;
  readAt: string;
  createdAt: string;
}

export interface NotificationDeliveryAttempt {
  id: string;
  channelIntentId: string;
  status: NotificationDeliveryStatus;
  providerMessageId: string | null;
  errorMessage: string | null;
  attemptedAt: string;
}

export interface NotificationPreference {
  id: string;
  preferenceKey: string;
  personId: string;
  sourceAppId: string | null;
  category: string | null;
  channel: NotificationChannel | null;
  muted: boolean;
  quietWindow: { startMinuteOfDay: number; endMinuteOfDay: number; timezone: string } | null;
  updatedByPersonId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationOperationHistory {
  id: string;
  notificationId: string | null;
  operation: NotificationOperation;
  actorType: NotificationActorType;
  actorPersonId: string | null;
  serviceIdentityId: string | null;
  executionType: NotificationExecutionType;
  sourceAppId: string | null;
  requestId: string | null;
  traceId: string | null;
  note: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface NotificationDetail {
  notification: Notification;
  recipients: NotificationRecipient[];
  channelIntents: NotificationChannelIntent[];
  deliveryAttempts: NotificationDeliveryAttempt[];
  reads: NotificationRead[];
  operationHistory: NotificationOperationHistory[];
}

export interface CreateNotificationInput {
  id?: string;
  source: NotificationSourceReference;
  notificationKey: string;
  idempotencyKey?: string | null;
  category?: string | null;
  readBehavior?: NotificationReadBehavior;
  display: NotificationDisplaySnapshot;
  template?: NotificationTemplateSnapshot | null;
  navigation?: NotificationNavigationReference | null;
  recipients: readonly NotificationRecipientInput[];
  channels?: readonly NotificationChannel[];
  scheduledAt?: Date | null;
}

export interface NotificationListInput {
  sourceAppId?: string;
  status?: NotificationStatus | readonly NotificationStatus[];
  category?: string;
  recipientPersonId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface MarkNotificationReadInput {
  notificationId: string;
  note?: string | null;
}

export interface UpdateNotificationDeliveryInput {
  channelIntentId: string;
  status: NotificationDeliveryStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  note?: string | null;
  attemptedAt?: Date | null;
}

export interface SetNotificationPreferenceInput {
  personId?: string;
  sourceAppId?: string | null;
  category?: string | null;
  channel?: NotificationChannel | null;
  muted: boolean;
  quietWindow?: NotificationPreference['quietWindow'];
  note?: string | null;
}

export interface CancelNotificationInput {
  notificationId: string;
  note?: string | null;
}

export interface LegacyNotificationReadReference {
  userId: string;
  notificationKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  readAt?: string | Date | null;
}

export interface LegacyGeneratedNotificationReference {
  key: string;
  sourceType: string;
  sourceId: string;
  readBehavior: NotificationReadBehavior;
  actionUrl: string;
}

export interface LegacyNotificationSnapshot {
  reads?: readonly LegacyNotificationReadReference[];
  generated?: readonly LegacyGeneratedNotificationReference[];
}

export type LegacyNotificationIssueCode =
  | 'MISSING_KEY'
  | 'DUPLICATE_READ'
  | 'MISSING_ACTION_URL'
  | 'INVALID_READ_BEHAVIOR';

export interface LegacyNotificationIssue {
  code: LegacyNotificationIssueCode;
  sourceId: string;
}

export interface LegacyNotificationReconciliation {
  readCount: number;
  generatedCount: number;
  uniqueReadKeys: number;
  markReadCount: number;
  stateBoundCount: number;
  issues: LegacyNotificationIssue[];
}

export class NotificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}
