import type { MigrationDefinition } from '../../core/migrations/index.js';
import { ATTACHMENT_PERMISSION_SEEDS } from './model.js';

const permissionValues = ATTACHMENT_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_ATTACHMENT_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${ATTACHMENT_PERMISSION_SEEDS.map((permission) => `'${permission.code}'`).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_attachments (
  id uuid PRIMARY KEY,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  attachment_key varchar(260) NOT NULL,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  purpose varchar(100) NOT NULL,
  storage_kind varchar(64) NOT NULL,
  storage_file_name varchar(500) NOT NULL,
  original_file_name varchar(500) NOT NULL,
  content_type varchar(200) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploader_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  uploader_snapshot jsonb,
  owner_organization_unit_id uuid REFERENCES platform_organization_units(id) ON DELETE SET NULL,
  owner_organization_snapshot jsonb,
  visibility varchar(20) NOT NULL CHECK (visibility IN ('private','organization','application','public_link')),
  lifecycle varchar(20) NOT NULL CHECK (lifecycle IN ('active','removed')),
  retain_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  removed_at timestamptz,
  UNIQUE (source_app_id, attachment_key),
  UNIQUE (storage_kind, storage_file_name),
  CHECK (
    (lifecycle = 'active' AND removed_at IS NULL)
    OR (lifecycle = 'removed' AND removed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_attachments_idempotency_idx
  ON platform_attachments(source_app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_attachments_source_idx
  ON platform_attachments(source_app_id, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS platform_attachments_owner_idx
  ON platform_attachments(owner_organization_unit_id, visibility, lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS platform_attachments_uploader_idx
  ON platform_attachments(uploader_person_id, lifecycle, updated_at DESC);

CREATE INDEX IF NOT EXISTS platform_attachments_retention_idx
  ON platform_attachments(lifecycle, legal_hold, retain_until);

CREATE TABLE IF NOT EXISTS platform_attachment_operation_history (
  id uuid PRIMARY KEY,
  attachment_id uuid REFERENCES platform_attachments(id) ON DELETE SET NULL,
  operation varchar(50) NOT NULL CHECK (operation IN ('registered','visibility_changed','retention_changed','removed')),
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

CREATE INDEX IF NOT EXISTS platform_attachment_operation_history_attachment_idx
  ON platform_attachment_operation_history(attachment_id, occurred_at, id);
`.trim();

export const PLATFORM_ATTACHMENT_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-attachments-expand',
  title: 'Create Platform Attachment business policy and operation history tables',
  ownerTaskId: 'PLATFORM-L3-011',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-006'],
  migrationRows: ['MIG-009'],
  sourceTables: ['file_assets'],
  targetTables: ['platform_attachments', 'platform_attachment_operation_history'],
  dependsOn: ['platform-people-directory-expand', 'platform-authorization-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Current file_assets, upload/download routes, signed links, previews, cleanup, files, production database, and deployment remain authoritative.',
  async run(context) {
    await context.client.query(PLATFORM_ATTACHMENT_SQL);
    return {
      applied: true,
      notes: ['Attachment permission seeds, business association, verified storage evidence, visibility, retention, legal hold, lifecycle, and operation history ensured'],
      reconciliation: { sourceTables: 1, targetTables: 2 }
    };
  }
}];
