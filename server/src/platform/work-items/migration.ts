import type { MigrationDefinition } from '../../core/migrations/index.js';
import { WORK_ITEM_PERMISSION_SEEDS } from './model.js';

const permissionValues = WORK_ITEM_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_WORK_ITEM_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${WORK_ITEM_PERMISSION_SEEDS.map((permission) => `'${permission.code}'`).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_work_item_batches (
  id uuid PRIMARY KEY,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  status varchar(20) NOT NULL CHECK (status IN ('open','closed','cancelled')),
  display_snapshot jsonb NOT NULL,
  navigation_ref jsonb,
  default_due_at timestamptz,
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_work_item_batches_idempotency_idx
  ON platform_work_item_batches(source_app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_work_item_batches_source_idx
  ON platform_work_item_batches(source_app_id, source_entity_type, source_entity_id);

CREATE TABLE IF NOT EXISTS platform_work_item_recurrence_rules (
  id uuid PRIMARY KEY,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('active','disabled')),
  schedule jsonb NOT NULL,
  missed_occurrence_policy varchar(20) NOT NULL CHECK (missed_occurrence_policy IN ('skip','latest_only','all')),
  due_after_minutes integer CHECK (due_after_minutes IS NULL OR due_after_minutes >= 0),
  priority varchar(20) NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  display_snapshot jsonb NOT NULL,
  navigation_ref jsonb,
  responsibility_area_id uuid REFERENCES platform_responsibility_areas(id) ON DELETE RESTRICT,
  target_entity_type varchar(30) CHECK (target_entity_type IN ('person','organization','location','asset')),
  target_entity_id uuid,
  target_display_name varchar(200),
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_assignee_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  start_at timestamptz NOT NULL,
  last_generated_scheduled_at timestamptz,
  disabled_at timestamptz,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((target_entity_type IS NULL AND target_entity_id IS NULL) OR (target_entity_type IS NOT NULL AND target_entity_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_work_item_recurrence_rules_idempotency_idx
  ON platform_work_item_recurrence_rules(source_app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_work_item_recurrence_rules_active_idx
  ON platform_work_item_recurrence_rules(status, start_at, last_generated_scheduled_at);

CREATE TABLE IF NOT EXISTS platform_work_items (
  id uuid PRIMARY KEY,
  batch_id uuid REFERENCES platform_work_item_batches(id) ON DELETE SET NULL,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  idempotency_scope varchar(30) NOT NULL DEFAULT 'work_item',
  recurrence_rule_id uuid REFERENCES platform_work_item_recurrence_rules(id) ON DELETE SET NULL,
  recurrence_occurrence_key varchar(260),
  recurrence_scheduled_at timestamptz,
  status varchar(20) NOT NULL CHECK (status IN ('pending','in_progress','completed','cancelled')),
  priority varchar(20) NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
  display_snapshot jsonb NOT NULL,
  navigation_ref jsonb,
  responsibility_area_id uuid REFERENCES platform_responsibility_areas(id) ON DELETE RESTRICT,
  target_entity_type varchar(30) CHECK (target_entity_type IN ('person','organization','location','asset')),
  target_entity_id uuid,
  target_display_name varchar(200),
  current_assignee_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  due_at timestamptz,
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  CHECK ((target_entity_type IS NULL AND target_entity_id IS NULL) OR (target_entity_type IS NOT NULL AND target_entity_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_work_items_idempotency_idx
  ON platform_work_items(source_app_id, idempotency_scope, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS platform_work_items_occurrence_idx
  ON platform_work_items(recurrence_rule_id, recurrence_occurrence_key)
  WHERE recurrence_rule_id IS NOT NULL AND recurrence_occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_work_items_status_due_idx
  ON platform_work_items(status, due_at, priority, updated_at);

CREATE INDEX IF NOT EXISTS platform_work_items_assignee_idx
  ON platform_work_items(current_assignee_person_id, status, due_at);

CREATE INDEX IF NOT EXISTS platform_work_items_source_idx
  ON platform_work_items(source_app_id, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS platform_work_items_target_idx
  ON platform_work_items(target_entity_type, target_entity_id);

CREATE TABLE IF NOT EXISTS platform_work_item_candidates (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES platform_work_items(id) ON DELETE CASCADE,
  candidate_type varchar(30) NOT NULL CHECK (candidate_type IN ('person','organization_unit')),
  candidate_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (work_item_id, candidate_type, candidate_id)
);

CREATE INDEX IF NOT EXISTS platform_work_item_candidates_lookup_idx
  ON platform_work_item_candidates(candidate_type, candidate_id, work_item_id);

CREATE TABLE IF NOT EXISTS platform_work_item_assignment_history (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES platform_work_items(id) ON DELETE CASCADE,
  action varchar(30) NOT NULL CHECK (action IN ('assigned','claimed','transferred','returned','completed_on_behalf')),
  from_assignee_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  to_assignee_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  actor_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  note text,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_work_item_assignment_history_item_idx
  ON platform_work_item_assignment_history(work_item_id, occurred_at);

CREATE TABLE IF NOT EXISTS platform_work_item_progress_history (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES platform_work_items(id) ON DELETE CASCADE,
  progress_percent integer CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
  note text,
  updater_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_work_item_progress_history_item_idx
  ON platform_work_item_progress_history(work_item_id, occurred_at);

CREATE TABLE IF NOT EXISTS platform_work_item_completion_evidence (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL UNIQUE REFERENCES platform_work_items(id) ON DELETE CASCADE,
  assigned_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  actual_completer_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  on_behalf_of_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  on_behalf boolean NOT NULL DEFAULT false,
  note text,
  completed_at timestamptz NOT NULL,
  source_app_id varchar(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_work_item_operation_history (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES platform_work_items(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS platform_work_item_operation_history_item_idx
  ON platform_work_item_operation_history(work_item_id, occurred_at);
`.trim();

export const PLATFORM_WORK_ITEM_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-work-items-expand',
  title: 'Create Platform WorkItem batches, items, recurrence, candidates, and history tables',
  ownerTaskId: 'PLATFORM-L3-008',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-005'],
  migrationRows: ['MIG-022', 'MIG-040'],
  sourceTables: ['recurring_task_templates', 'todo_tasks', 'todo_items'],
  targetTables: [
    'platform_work_item_batches',
    'platform_work_items',
    'platform_work_item_candidates',
    'platform_work_item_assignment_history',
    'platform_work_item_progress_history',
    'platform_work_item_completion_evidence',
    'platform_work_item_operation_history',
    'platform_work_item_recurrence_rules'
  ],
  dependsOn: [
    'core-events-outbox-expand',
    'platform-people-directory-expand',
    'platform-responsibility-expand',
    'platform-authorization-expand'
  ],
  recoveryNotes: 'The migration is additive and idempotent. Current todo routes, schedulers, notification side effects, and production data remain authoritative until later M5/M6 switch gates.',
  async run(context) {
    await context.client.query(PLATFORM_WORK_ITEM_SQL);
    return {
      applied: true,
      notes: ['WorkItem permission seeds, tables, indexes, recurrence, and history contracts ensured'],
      reconciliation: { sourceTables: 3, targetTables: 8 }
    };
  }
}];
