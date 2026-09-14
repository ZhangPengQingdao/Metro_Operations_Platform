import type { MigrationDefinition } from '../../core/migrations/index.js';
import { BUSINESS_AUDIT_PERMISSION_SEEDS } from './model.js';

const permissionValues = BUSINESS_AUDIT_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_BUSINESS_AUDIT_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${BUSINESS_AUDIT_PERMISSION_SEEDS.map((permission) => `'${permission.code}'`).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_business_audit_records (
  id uuid PRIMARY KEY,
  audit_key varchar(200),
  idempotency_payload_hash varchar(64),
  operation_code varchar(150) NOT NULL,
  outcome varchar(20) NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
  actor_type varchar(20) NOT NULL CHECK (actor_type IN ('person','service')),
  actor_person_id uuid,
  service_identity_id varchar(120),
  actor_snapshot jsonb,
  trusted_identity_source varchar(30) NOT NULL CHECK (trusted_identity_source IN ('session','wecom','name','service','mcp_actor_token')),
  execution_type varchar(20) NOT NULL CHECK (execution_type IN ('platform','application','service')),
  execution_app_id varchar(100),
  business_app_id varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id varchar(200) NOT NULL,
  entity_display_label varchar(300),
  owner_person_id uuid,
  owner_organization_unit_id uuid,
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  before_summary jsonb,
  after_summary jsonb,
  result_summary jsonb,
  reason_code varchar(100),
  reason_text varchar(2000),
  error_code varchar(150),
  request_id varchar(200) NOT NULL,
  trace_id varchar(200) NOT NULL,
  occurred_at timestamptz NOT NULL,
  CHECK (
    (actor_type = 'person' AND actor_person_id IS NOT NULL AND service_identity_id IS NULL AND actor_snapshot IS NOT NULL)
    OR (actor_type = 'service' AND actor_person_id IS NULL AND service_identity_id IS NOT NULL AND actor_snapshot IS NULL)
  ),
  CHECK (
    (actor_type = 'service' AND trusted_identity_source = 'service')
    OR (actor_type = 'person' AND trusted_identity_source <> 'service')
  ),
  CHECK (actor_snapshot IS NULL OR jsonb_typeof(actor_snapshot) = 'object'),
  CHECK (
    (audit_key IS NULL AND idempotency_payload_hash IS NULL)
    OR (audit_key IS NOT NULL AND idempotency_payload_hash IS NOT NULL)
  ),
  CHECK (jsonb_typeof(changed_fields) = 'array'),
  CHECK (before_summary IS NULL OR jsonb_typeof(before_summary) = 'object'),
  CHECK (after_summary IS NULL OR jsonb_typeof(after_summary) = 'object'),
  CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
  CHECK (
    (execution_type = 'platform' AND execution_app_id IS NULL)
    OR (execution_type IN ('application','service') AND execution_app_id IS NOT NULL)
  ),
  CHECK (
    (outcome = 'succeeded' AND error_code IS NULL)
    OR (outcome = 'denied' AND error_code IS NOT NULL AND changed_fields = '[]'::jsonb AND before_summary IS NULL AND after_summary IS NULL AND result_summary IS NULL)
    OR (outcome = 'failed' AND error_code IS NOT NULL AND changed_fields = '[]'::jsonb AND before_summary IS NULL AND after_summary IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_business_audit_idempotency_idx
  ON platform_business_audit_records(business_app_id, audit_key)
  WHERE audit_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_business_audit_entity_idx
  ON platform_business_audit_records(business_app_id, entity_type, entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_actor_idx
  ON platform_business_audit_records(actor_person_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_source_idx
  ON platform_business_audit_records(execution_app_id, operation_code, outcome, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_owner_person_idx
  ON platform_business_audit_records(owner_person_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_owner_organization_idx
  ON platform_business_audit_records(owner_organization_unit_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_request_idx
  ON platform_business_audit_records(request_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_trace_idx
  ON platform_business_audit_records(trace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_business_audit_occurred_idx
  ON platform_business_audit_records(occurred_at DESC, id);
`.trim();

export const PLATFORM_BUSINESS_AUDIT_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-business-audit-expand',
  title: 'Create append-only Platform Business Audit records',
  ownerTaskId: 'PLATFORM-L3-012',
  phase: 'expand',
  layer: 'L3',
  dataRows: [],
  migrationRows: ['MIG-039'],
  sourceTables: [
    'platform_work_item_operation_history',
    'platform_notification_operation_history',
    'platform_signature_operation_history',
    'platform_attachment_operation_history',
    'device_resolution_audits'
  ],
  targetTables: ['platform_business_audit_records'],
  dependsOn: ['core-observability-audit-expand', 'platform-people-directory-expand', 'platform-authorization-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Technical audit, entity-local histories, device resolution audits, current business writes, production database, and deployment remain authoritative and unchanged.',
  async run(context) {
    await context.client.query(PLATFORM_BUSINESS_AUDIT_SQL);
    return {
      applied: true,
      notes: ['Business Audit permission seeds, immutable record table, idempotency key, consistency checks, and query indexes ensured'],
      reconciliation: { sourceTables: 5, targetTables: 1 }
    };
  }
}];
