import type { MigrationDefinition } from '../../core/migrations/index.js';
import { SIGNATURE_PERMISSION_CODES, SIGNATURE_PERMISSION_SEEDS } from './model.js';

// Keep the original migration stable; self-sign application grants are an additive migration.
const initialPermissionCodes = new Set<string>([
  SIGNATURE_PERMISSION_CODES.create,
  SIGNATURE_PERMISSION_CODES.read,
  SIGNATURE_PERMISSION_CODES.manage,
  SIGNATURE_PERMISSION_CODES.signOnBehalf,
  SIGNATURE_PERMISSION_CODES.finalize
]);
const initialPermissionSeeds = SIGNATURE_PERMISSION_SEEDS.filter((permission) => initialPermissionCodes.has(permission.code));
const permissionValues = initialPermissionSeeds
  .map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_SIGNATURE_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${initialPermissionSeeds.map((permission) => `'${permission.code}'`).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_signature_requests (
  id uuid PRIMARY KEY,
  source_app_id varchar(100) NOT NULL,
  source_entity_type varchar(100) NOT NULL,
  source_entity_id varchar(200) NOT NULL,
  signature_key varchar(260) NOT NULL,
  idempotency_key varchar(200),
  idempotency_payload_hash varchar(128),
  status varchar(20) NOT NULL CHECK (status IN ('draft','dispatched','completed','cancelled')),
  document_snapshot jsonb NOT NULL,
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_by_actor_type varchar(20) NOT NULL CHECK (created_by_actor_type IN ('person','service')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (source_app_id, signature_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_signature_requests_idempotency_idx
  ON platform_signature_requests(source_app_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_signature_requests_source_idx
  ON platform_signature_requests(source_app_id, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS platform_signature_requests_status_idx
  ON platform_signature_requests(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_signature_sessions (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL UNIQUE REFERENCES platform_signature_requests(id) ON DELETE CASCADE,
  public_token_hash varchar(128) NOT NULL UNIQUE,
  public_token_preview varchar(16) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('draft','dispatched','completed','cancelled')),
  expires_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (id, signature_request_id)
);

CREATE INDEX IF NOT EXISTS platform_signature_sessions_status_idx
  ON platform_signature_sessions(status, expires_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS platform_signature_signers (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL REFERENCES platform_signature_requests(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES platform_signature_sessions(id) ON DELETE CASCADE,
  person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  signer_key varchar(260) NOT NULL,
  display_name varchar(120) NOT NULL,
  expected_organization_unit_id uuid REFERENCES platform_organization_units(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL CHECK (status IN ('pending','signed','revoked')),
  signature_evidence_id uuid,
  signed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (signature_request_id, signer_key),
  UNIQUE (id, signature_request_id),
  FOREIGN KEY (session_id, signature_request_id)
    REFERENCES platform_signature_sessions(id, signature_request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS platform_signature_signers_person_idx
  ON platform_signature_signers(person_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS platform_signature_signers_session_idx
  ON platform_signature_signers(session_id, status);

CREATE TABLE IF NOT EXISTS platform_signature_positions (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL REFERENCES platform_signature_requests(id) ON DELETE CASCADE,
  signer_id uuid NOT NULL REFERENCES platform_signature_signers(id) ON DELETE CASCADE,
  page integer NOT NULL CHECK (page >= 0),
  x0 double precision NOT NULL,
  y0 double precision NOT NULL,
  x1 double precision NOT NULL,
  y1 double precision NOT NULL,
  strategy varchar(30) NOT NULL,
  label varchar(120),
  required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  CHECK (x1 > x0 AND y1 > y0),
  FOREIGN KEY (signer_id, signature_request_id)
    REFERENCES platform_signature_signers(id, signature_request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS platform_signature_positions_signer_idx
  ON platform_signature_positions(signer_id, page, id);

CREATE TABLE IF NOT EXISTS platform_signature_evidence (
  id uuid PRIMARY KEY,
  signature_request_id uuid NOT NULL REFERENCES platform_signature_requests(id) ON DELETE CASCADE,
  signer_id uuid NOT NULL REFERENCES platform_signature_signers(id) ON DELETE CASCADE,
  submitted_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  storage_ref jsonb,
  signature_url text,
  content_type varchar(120) NOT NULL,
  sha256 varchar(128),
  size_bytes bigint,
  width integer,
  height integer,
  client_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (signer_id),
  CHECK (storage_ref IS NOT NULL OR signature_url IS NOT NULL),
  CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CHECK (width IS NULL OR width > 0),
  CHECK (height IS NULL OR height > 0),
  FOREIGN KEY (signer_id, signature_request_id)
    REFERENCES platform_signature_signers(id, signature_request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS platform_signature_evidence_signer_idx
  ON platform_signature_evidence(signer_id, signed_at DESC);

CREATE TABLE IF NOT EXISTS platform_signature_operation_history (
  id uuid PRIMARY KEY,
  signature_request_id uuid REFERENCES platform_signature_requests(id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS platform_signature_operation_history_request_idx
  ON platform_signature_operation_history(signature_request_id, occurred_at, id);
`.trim();

export const PLATFORM_SIGNATURE_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-signatures-expand',
  title: 'Create Platform Signature requests, sessions, signers, positions, evidence, and history tables',
  ownerTaskId: 'PLATFORM-L3-010',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-006'],
  migrationRows: ['MIG-024'],
  sourceTables: [
    'digital_signature_templates',
    'digital_signature_sessions',
    'digital_signature_signers',
    'digital_signature_training_forms',
    'digital_signature_competition_forms',
    'digital_signature_safety_meeting_forms',
    'digital_signature_shift_adjustment_forms'
  ],
  targetTables: [
    'platform_signature_requests',
    'platform_signature_sessions',
    'platform_signature_signers',
    'platform_signature_positions',
    'platform_signature_evidence',
    'platform_signature_operation_history'
  ],
  dependsOn: [
    'core-events-outbox-expand',
    'platform-people-directory-expand',
    'platform-authorization-expand'
  ],
  recoveryNotes: 'The migration is additive and idempotent. Current digital_signature_* tables, public links, document workers, application forms, files, and routes remain authoritative until later application migration gates.',
  async run(context) {
    await context.client.query(PLATFORM_SIGNATURE_SQL);
    return {
      applied: true,
      notes: ['Signature permission seeds, requests, token hashes, signers, positions, evidence references, and operation history ensured'],
      reconciliation: { sourceTables: 7, targetTables: 6 }
    };
  }
}, {
  id: 'platform-signatures-self-sign-grant-expand',
  title: 'Separate application self-sign authorization from read access',
  ownerTaskId: 'PLATFORM-L3-018',
  phase: 'expand',
  layer: 'L3',
  dataRows: [],
  migrationRows: ['MIG-043'],
  sourceTables: [],
  targetTables: ['platform_permissions'],
  dependsOn: ['platform-signatures-expand'],
  recoveryNotes: 'Additive permission only; no application grant is created and intrinsic platform person signing remains unchanged.',
  async run(context) {
    await context.client.query(`INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
      VALUES ('4a000000-0000-4000-8000-000000000016','platform.signatures.sign','通过应用提交本人签字',NULL,'active',NOW(),NOW())
      ON CONFLICT (code) DO NOTHING`);
    return { applied: true, notes: ['Self-sign application permission ensured; grants remain explicit'] };
  }
}];
