import type { MigrationDefinition } from '../../core/migrations/index.js';
import { NOTIFICATION_PERMISSION_SEEDS } from './model.js';

const permissionValues = NOTIFICATION_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_NOTIFICATION_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${NOTIFICATION_PERMISSION_SEEDS.map((permission) => `'${permission.code}'`).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_notifications (
  id uuid PRIMARY KEY,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  notification_key varchar(260) NOT NULL,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  status varchar(20) NOT NULL CHECK (status IN ('active','cancelled','archived')),
  category varchar(100),
  read_behavior varchar(20) NOT NULL CHECK (read_behavior IN ('mark_read','state_bound')),
  display_snapshot jsonb NOT NULL,
  template_snapshot jsonb,
  navigation_ref jsonb,
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  UNIQUE (source_app_id, notification_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_notifications_idempotency_idx
  ON platform_notifications(source_app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_notifications_source_idx
  ON platform_notifications(source_app_id, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS platform_notifications_status_idx
  ON platform_notifications(status, category, updated_at);

CREATE TABLE IF NOT EXISTS platform_notification_recipients (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES platform_notifications(id) ON DELETE CASCADE,
  recipient_type varchar(30) NOT NULL CHECK (recipient_type IN ('person','organization_unit')),
  recipient_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE CASCADE,
  recipient_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (notification_id, person_id)
);

CREATE INDEX IF NOT EXISTS platform_notification_recipients_person_idx
  ON platform_notification_recipients(person_id, notification_id);

CREATE INDEX IF NOT EXISTS platform_notification_recipients_target_idx
  ON platform_notification_recipients(recipient_type, recipient_id);

CREATE TABLE IF NOT EXISTS platform_notification_channel_intents (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES platform_notifications(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES platform_notification_recipients(id) ON DELETE CASCADE,
  channel varchar(30) NOT NULL CHECK (channel IN ('in_app','wecom','email','sms','webhook')),
  target_kind varchar(30) NOT NULL CHECK (target_kind IN ('person','organization_unit','wecom_user','wecom_group','email','phone','url','app')),
  target_id varchar(260) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('pending','queued','sent','failed','skipped','cancelled')),
  provider_message_id varchar(260),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  scheduled_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (notification_id, recipient_id, channel, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS platform_notification_channel_intents_status_idx
  ON platform_notification_channel_intents(status, channel, scheduled_at, updated_at);

CREATE TABLE IF NOT EXISTS platform_notification_reads (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES platform_notifications(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (notification_id, person_id)
);

CREATE INDEX IF NOT EXISTS platform_notification_reads_person_idx
  ON platform_notification_reads(person_id, read_at DESC);

CREATE TABLE IF NOT EXISTS platform_notification_delivery_attempts (
  id uuid PRIMARY KEY,
  channel_intent_id uuid NOT NULL REFERENCES platform_notification_channel_intents(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL CHECK (status IN ('pending','queued','sent','failed','skipped','cancelled')),
  provider_message_id varchar(260),
  error_message text,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_notification_delivery_attempts_intent_idx
  ON platform_notification_delivery_attempts(channel_intent_id, attempted_at);

CREATE TABLE IF NOT EXISTS platform_notification_preferences (
  id uuid PRIMARY KEY,
  preference_key varchar(500) NOT NULL UNIQUE,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE CASCADE,
  source_app_id varchar(100),
  category varchar(100),
  channel varchar(30) CHECK (channel IS NULL OR channel IN ('in_app','wecom','email','sms','webhook')),
  muted boolean NOT NULL DEFAULT false,
  quiet_window jsonb,
  updated_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_notification_preferences_person_idx
  ON platform_notification_preferences(person_id, source_app_id, category, channel);

CREATE TABLE IF NOT EXISTS platform_notification_operation_history (
  id uuid PRIMARY KEY,
  notification_id uuid REFERENCES platform_notifications(id) ON DELETE SET NULL,
  operation varchar(50) NOT NULL,
  actor_type varchar(20) NOT NULL CHECK (actor_type IN ('person','service')),
  actor_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  service_identity_id varchar(120),
  execution_type varchar(20) NOT NULL CHECK (execution_type IN ('platform','application','service')),
  source_app_id varchar(100),
  request_id varchar(120),
  trace_id varchar(120),
  note text,
  before_payload jsonb,
  after_payload jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_notification_operation_history_notification_idx
  ON platform_notification_operation_history(notification_id, occurred_at);
`.trim();

export const PLATFORM_NOTIFICATION_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-notifications-expand',
  title: 'Create Platform Notification records, recipients, channel intents, reads, preferences, and history tables',
  ownerTaskId: 'PLATFORM-L3-009',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-005'],
  migrationRows: ['MIG-011', 'MIG-023'],
  sourceTables: ['notification_reads'],
  targetTables: [
    'platform_notifications',
    'platform_notification_recipients',
    'platform_notification_channel_intents',
    'platform_notification_reads',
    'platform_notification_delivery_attempts',
    'platform_notification_preferences',
    'platform_notification_operation_history'
  ],
  dependsOn: [
    'core-events-outbox-expand',
    'platform-people-directory-expand',
    'platform-authorization-expand'
  ],
  recoveryNotes: 'The migration is additive and idempotent. Current notification_reads, /api/notifications, webhook/card delivery, and production data remain authoritative until later L4 switch gates.',
  async run(context) {
    await context.client.query(PLATFORM_NOTIFICATION_SQL);
    return {
      applied: true,
      notes: ['Notification permission seeds, durable records, recipients, channel intents, reads, preferences, and history contracts ensured'],
      reconciliation: { sourceTables: 1, targetTables: 7 }
    };
  }
}];
