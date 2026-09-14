import type { MigrationDefinition } from '../../core/migrations/index.js';
import {
  DUTY_PERMISSION_SEEDS,
  STANDARD_DUTY_STATUS_SEEDS,
  STANDARD_SHIFT_TYPE_SEEDS
} from './model.js';

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlNullableNumber = (value: number | null) => value === null ? 'NULL' : String(value);

const permissionValues = DUTY_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}',${sqlText(permission.code)},${sqlText(permission.name)},NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

const shiftTypeValues = STANDARD_SHIFT_TYPE_SEEDS
  .map((shift) => `('${shift.id}',${sqlText(shift.code)},${sqlText(shift.name)},${shift.startMinute},${shift.endMinute},${shift.crossesMidnight},${sqlNullableNumber(shift.creditedMinutes)},'${shift.dutyClass}','active','1970-01-01',NULL,NOW(),NOW())`)
  .join(',\n  ');

const dutyStatusValues = STANDARD_DUTY_STATUS_SEEDS
  .map((status) => `('${status.id}',${sqlText(status.code)},${sqlText(status.name)},'${status.category}',${sqlNullableNumber(status.creditedMinutes)},${status.countsAsOnDuty},'active','1970-01-01',NULL,NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_DUTY_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${DUTY_PERMISSION_SEEDS.map((permission) => sqlText(permission.code)).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_shift_types (
  id uuid PRIMARY KEY,
  code varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  crosses_midnight boolean NOT NULL,
  credited_minutes integer CHECK (credited_minutes IS NULL OR credited_minutes BETWEEN 0 AND 1440),
  duty_class varchar(20) NOT NULL CHECK (duty_class IN ('day','night','other')),
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (code,effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((crosses_midnight AND end_minute < start_minute) OR (NOT crosses_midnight AND end_minute > start_minute))
);

CREATE INDEX IF NOT EXISTS platform_shift_types_effective_idx
  ON platform_shift_types(code,status,effective_from,effective_to);

INSERT INTO platform_shift_types
  (id,code,name,start_minute,end_minute,crosses_midnight,credited_minutes,duty_class,status,effective_from,effective_to,created_at,updated_at)
VALUES
  ${shiftTypeValues}
ON CONFLICT (code,effective_from) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_duty_statuses (
  id uuid PRIMARY KEY,
  code varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  category varchar(20) NOT NULL CHECK (category IN ('rest','leave','training','absence','other')),
  credited_minutes integer CHECK (credited_minutes IS NULL OR credited_minutes BETWEEN 0 AND 1440),
  counts_as_on_duty boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (code,effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS platform_duty_statuses_effective_idx
  ON platform_duty_statuses(code,status,effective_from,effective_to);

INSERT INTO platform_duty_statuses
  (id,code,name,category,credited_minutes,counts_as_on_duty,status,effective_from,effective_to,created_at,updated_at)
VALUES
  ${dutyStatusValues}
ON CONFLICT (code,effective_from) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_business_calendar_days (
  date_key date PRIMARY KEY,
  kind varchar(30) NOT NULL CHECK (kind IN ('working_day','rest_day','statutory_holiday','adjusted_workday')),
  holiday_code varchar(100),
  holiday_name varchar(200),
  source_app_id varchar(100),
  source_entity_id varchar(200),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  updated_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((kind = 'statutory_holiday') OR (holiday_code IS NULL AND holiday_name IS NULL))
);

CREATE INDEX IF NOT EXISTS platform_business_calendar_days_kind_idx
  ON platform_business_calendar_days(kind,date_key);

CREATE TABLE IF NOT EXISTS platform_duty_periods (
  id uuid PRIMARY KEY,
  organization_unit_id uuid NOT NULL REFERENCES platform_organization_units(id) ON DELETE RESTRICT,
  period_key varchar(100) NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('draft','published','cancelled')),
  source_app_id varchar(100),
  source_entity_id varchar(200),
  import_sha256 varchar(64) CHECK (import_sha256 IS NULL OR import_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  published_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  cancelled_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (organization_unit_id,period_key,version),
  UNIQUE (id,organization_unit_id),
  CHECK (end_date >= start_date),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_duty_periods_effective_idx
  ON platform_duty_periods(organization_unit_id,status,start_date,end_date,version DESC);

CREATE TABLE IF NOT EXISTS platform_duty_assignments (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL,
  organization_unit_id uuid NOT NULL,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  date_key date NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('shift','status')),
  shift_type_id uuid REFERENCES platform_shift_types(id) ON DELETE RESTRICT,
  duty_status_id uuid REFERENCES platform_duty_statuses(id) ON DELETE RESTRICT,
  code_snapshot varchar(50) NOT NULL,
  name_snapshot varchar(100) NOT NULL,
  credited_minutes_snapshot integer CHECK (credited_minutes_snapshot IS NULL OR credited_minutes_snapshot BETWEEN 0 AND 1440),
  origin varchar(20) NOT NULL CHECK (origin IN ('imported','manual')),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (period_id,person_id,date_key),
  UNIQUE (id,organization_unit_id),
  FOREIGN KEY (period_id,organization_unit_id)
    REFERENCES platform_duty_periods(id,organization_unit_id) ON DELETE CASCADE,
  CHECK (
    (kind = 'shift' AND shift_type_id IS NOT NULL AND duty_status_id IS NULL)
    OR (kind = 'status' AND shift_type_id IS NULL AND duty_status_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_duty_assignments_date_idx
  ON platform_duty_assignments(organization_unit_id,date_key,person_id);

CREATE TABLE IF NOT EXISTS platform_temporary_replacements (
  id uuid PRIMARY KEY,
  original_assignment_id uuid NOT NULL,
  return_assignment_id uuid,
  organization_unit_id uuid NOT NULL,
  absent_person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  substitute_person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  replacement_shift_type_id uuid REFERENCES platform_shift_types(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL CHECK (status IN ('proposed','approved','cancelled')),
  reason text,
  source_app_id varchar(100),
  source_entity_id varchar(200),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  approved_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  cancelled_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  approved_at timestamptz,
  cancelled_at timestamptz,
  FOREIGN KEY (original_assignment_id,organization_unit_id)
    REFERENCES platform_duty_assignments(id,organization_unit_id) ON DELETE RESTRICT,
  FOREIGN KEY (return_assignment_id,organization_unit_id)
    REFERENCES platform_duty_assignments(id,organization_unit_id) ON DELETE RESTRICT,
  CHECK (absent_person_id <> substitute_person_id),
  CHECK (return_assignment_id IS NULL OR return_assignment_id <> original_assignment_id),
  CHECK (
    (status = 'proposed' AND approved_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'approved' AND approved_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_temporary_replacements_active_idx
  ON platform_temporary_replacements(original_assignment_id)
  WHERE status IN ('proposed','approved');

CREATE INDEX IF NOT EXISTS platform_temporary_replacements_return_idx
  ON platform_temporary_replacements(return_assignment_id,status);

CREATE UNIQUE INDEX IF NOT EXISTS platform_temporary_replacements_active_return_idx
  ON platform_temporary_replacements(return_assignment_id)
  WHERE return_assignment_id IS NOT NULL AND status IN ('proposed','approved');

CREATE TABLE IF NOT EXISTS platform_duty_operation_history (
  id uuid PRIMARY KEY,
  operation varchar(50) NOT NULL,
  entity_type varchar(30) NOT NULL CHECK (entity_type IN ('shift_type','duty_status','calendar_day','period','assignment','replacement')),
  entity_id varchar(100) NOT NULL,
  organization_unit_id uuid REFERENCES platform_organization_units(id) ON DELETE SET NULL,
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
  occurred_at timestamptz NOT NULL,
  CHECK (
    (actor_type = 'person' AND actor_person_id IS NOT NULL AND service_identity_id IS NULL)
    OR (actor_type = 'service' AND actor_person_id IS NULL AND service_identity_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_duty_operation_history_entity_idx
  ON platform_duty_operation_history(entity_type,entity_id,occurred_at,id);
`.trim();

export const PLATFORM_DUTY_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-duty-calendar-expand',
  title: 'Create Platform duty catalog, calendar, roster, replacement, and history tables',
  ownerTaskId: 'PLATFORM-L3-013',
  phase: 'expand',
  layer: 'L3',
  dataRows: [],
  migrationRows: ['MIG-025'],
  sourceTables: ['shift_records', 'shift_persons', 'digital_signature_shift_adjustment_forms'],
  targetTables: [
    'platform_shift_types',
    'platform_duty_statuses',
    'platform_business_calendar_days',
    'platform_duty_periods',
    'platform_duty_assignments',
    'platform_temporary_replacements',
    'platform_duty_operation_history'
  ],
  dependsOn: ['platform-people-directory-expand', 'platform-authorization-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Current handover records, scheduling workspaces/importers, adjustment forms, routes, production data, and deployment remain authoritative and unchanged.',
  async run(context) {
    await context.client.query(PLATFORM_DUTY_SQL);
    return {
      applied: true,
      notes: ['Duty permission and standard catalog seeds plus seven additive tables ensured'],
      reconciliation: { sourceTables: 3, targetTables: 7 }
    };
  }
}];
