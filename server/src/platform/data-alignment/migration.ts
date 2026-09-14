import type { MigrationDefinition } from '../../core/migrations/index.js';
import { DATA_ALIGNMENT_PERMISSION_SEEDS } from './model.js';

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const permissionValues = DATA_ALIGNMENT_PERMISSION_SEEDS
  .map((permission) => `('${permission.id}',${sqlText(permission.code)},${sqlText(permission.name)},NULL,'active',NOW(),NOW())`)
  .join(',\n  ');

export const PLATFORM_DATA_ALIGNMENT_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id, permission.id, 'all', NOW(), NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code = 'administrator'
  AND permission.code IN (${DATA_ALIGNMENT_PERMISSION_SEEDS.map((permission) => sqlText(permission.code)).join(',')})
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_dictionary_versions (
  id uuid PRIMARY KEY,
  dictionary_key varchar(100) NOT NULL CHECK (dictionary_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  version integer NOT NULL CHECK (version > 0),
  name varchar(200) NOT NULL,
  description varchar(1000),
  status varchar(20) NOT NULL CHECK (status IN ('draft','published','retired')),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  published_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  retired_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE (dictionary_key,version),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_dictionary_versions_published_idx
  ON platform_dictionary_versions(dictionary_key) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS platform_dictionary_items (
  id uuid PRIMARY KEY,
  dictionary_version_id uuid NOT NULL REFERENCES platform_dictionary_versions(id) ON DELETE CASCADE,
  code varchar(100) NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  label varchar(200) NOT NULL,
  description varchar(1000),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (dictionary_version_id,code)
);

CREATE INDEX IF NOT EXISTS platform_dictionary_items_order_idx
  ON platform_dictionary_items(dictionary_version_id,sort_order,code);

CREATE TABLE IF NOT EXISTS platform_external_systems (
  id uuid PRIMARY KEY,
  code varchar(100) NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  name varchar(200) NOT NULL,
  description varchar(1000),
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_source_of_truth_rules (
  id uuid PRIMARY KEY,
  external_system_id uuid NOT NULL REFERENCES platform_external_systems(id) ON DELETE RESTRICT,
  platform_entity_type varchar(100) NOT NULL CHECK (platform_entity_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  authority_scope_key varchar(100) NOT NULL CHECK (authority_scope_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  authority varchar(30) NOT NULL CHECK (authority IN ('platform','external','manual_resolution')),
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (external_system_id,platform_entity_type,authority_scope_key,effective_from),
  UNIQUE (id,external_system_id,platform_entity_type),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS platform_source_of_truth_rules_effective_idx
  ON platform_source_of_truth_rules(external_system_id,platform_entity_type,authority_scope_key,status,effective_from,effective_to);

CREATE TABLE IF NOT EXISTS platform_mapping_profiles (
  id uuid PRIMARY KEY,
  profile_key varchar(100) NOT NULL CHECK (profile_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  version integer NOT NULL CHECK (version > 0),
  name varchar(200) NOT NULL,
  description varchar(1000),
  owner_type varchar(20) NOT NULL CHECK (owner_type IN ('platform','application')),
  owner_app_id varchar(100),
  external_system_id uuid NOT NULL REFERENCES platform_external_systems(id) ON DELETE RESTRICT,
  source_of_truth_rule_id uuid NOT NULL,
  platform_entity_type varchar(100) NOT NULL CHECK (platform_entity_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  direction varchar(20) NOT NULL CHECK (direction IN ('inbound','outbound','bidirectional')),
  status varchar(20) NOT NULL CHECK (status IN ('draft','published','retired')),
  created_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  published_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  retired_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE (profile_key,version),
  UNIQUE (id,external_system_id,platform_entity_type),
  FOREIGN KEY (source_of_truth_rule_id,external_system_id,platform_entity_type)
    REFERENCES platform_source_of_truth_rules(id,external_system_id,platform_entity_type) ON DELETE RESTRICT,
  CHECK ((owner_type = 'platform' AND owner_app_id IS NULL) OR (owner_type = 'application' AND owner_app_id IS NOT NULL)),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_mapping_profiles_published_idx
  ON platform_mapping_profiles(profile_key) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS platform_sync_runs (
  id uuid PRIMARY KEY,
  mapping_profile_id uuid NOT NULL REFERENCES platform_mapping_profiles(id) ON DELETE RESTRICT,
  request_key varchar(200) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  version integer NOT NULL CHECK (version > 0),
  requested_count integer NOT NULL CHECK (requested_count BETWEEN 0 AND 1000000),
  processed_count integer NOT NULL CHECK (processed_count BETWEEN 0 AND 1000000),
  created_count integer NOT NULL CHECK (created_count BETWEEN 0 AND 1000000),
  updated_count integer NOT NULL CHECK (updated_count BETWEEN 0 AND 1000000),
  succeeded_count integer NOT NULL CHECK (succeeded_count BETWEEN 0 AND 1000000),
  unchanged_count integer NOT NULL CHECK (unchanged_count BETWEEN 0 AND 1000000),
  skipped_count integer NOT NULL CHECK (skipped_count BETWEEN 0 AND 1000000),
  conflict_count integer NOT NULL CHECK (conflict_count BETWEEN 0 AND 1000000),
  failed_count integer NOT NULL CHECK (failed_count BETWEEN 0 AND 1000000),
  failure_code varchar(100),
  summary varchar(2000),
  actor_type varchar(20) NOT NULL CHECK (actor_type IN ('person','service')),
  actor_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  service_identity_id varchar(120),
  execution_type varchar(20) NOT NULL CHECK (execution_type IN ('platform','application','service')),
  source_app_id varchar(100),
  request_id varchar(120) NOT NULL,
  trace_id varchar(120) NOT NULL,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (mapping_profile_id,request_key),
  UNIQUE (id,mapping_profile_id),
  CHECK (succeeded_count = created_count + updated_count),
  CHECK (processed_count = created_count + updated_count + unchanged_count + skipped_count + conflict_count + failed_count),
  CHECK (processed_count <= requested_count),
  CHECK ((actor_type = 'person' AND actor_person_id IS NOT NULL AND service_identity_id IS NULL) OR (actor_type = 'service' AND actor_person_id IS NULL AND service_identity_id IS NOT NULL)),
  CHECK ((execution_type = 'platform' AND source_app_id IS NULL) OR (execution_type IN ('application','service') AND source_app_id IS NOT NULL)),
  CHECK (
    (status = 'queued' AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('succeeded','partial','failed') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_sync_runs_profile_status_idx
  ON platform_sync_runs(mapping_profile_id,status,queued_at DESC,id);

CREATE TABLE IF NOT EXISTS platform_sync_record_results (
  id uuid PRIMARY KEY,
  sync_run_id uuid NOT NULL REFERENCES platform_sync_runs(id) ON DELETE CASCADE,
  source_record_key varchar(300) NOT NULL,
  external_entity_id varchar(300),
  platform_entity_type varchar(100) CHECK (platform_entity_type IS NULL OR platform_entity_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  platform_entity_id uuid,
  source_attachment_id uuid REFERENCES platform_attachments(id) ON DELETE RESTRICT,
  source_row integer CHECK (source_row IS NULL OR source_row > 0),
  source_sha256 varchar(64) CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  target_sha256 varchar(64) CHECK (target_sha256 IS NULL OR target_sha256 ~ '^[0-9a-f]{64}$'),
  outcome varchar(20) NOT NULL CHECK (outcome IN ('created','updated','unchanged','skipped','conflict','failed')),
  error_code varchar(100),
  error_summary varchar(2000),
  conflict_state varchar(20) CHECK (conflict_state IN ('open','resolved')),
  conflict_resolution varchar(30) CHECK (conflict_resolution IN ('keep_platform','accept_external','custom')),
  resolution_note varchar(2000),
  resolved_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  resolved_by_service_identity_id varchar(120),
  resolved_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sync_run_id,source_record_key),
  CHECK ((platform_entity_type IS NULL AND platform_entity_id IS NULL) OR (platform_entity_type IS NOT NULL AND platform_entity_id IS NOT NULL)),
  CHECK (
    (outcome <> 'conflict' AND conflict_state IS NULL AND conflict_resolution IS NULL AND resolution_note IS NULL AND resolved_by_person_id IS NULL AND resolved_by_service_identity_id IS NULL AND resolved_at IS NULL)
    OR (outcome = 'conflict' AND source_sha256 IS NOT NULL AND target_sha256 IS NOT NULL AND conflict_state = 'open' AND conflict_resolution IS NULL AND resolved_by_person_id IS NULL AND resolved_by_service_identity_id IS NULL AND resolved_at IS NULL)
    OR (outcome = 'conflict' AND conflict_state = 'resolved' AND conflict_resolution IS NOT NULL AND resolved_at IS NOT NULL AND ((resolved_by_person_id IS NOT NULL AND resolved_by_service_identity_id IS NULL) OR (resolved_by_person_id IS NULL AND resolved_by_service_identity_id IS NOT NULL)))
  )
);

CREATE INDEX IF NOT EXISTS platform_sync_record_results_outcome_idx
  ON platform_sync_record_results(sync_run_id,outcome,source_record_key);

CREATE INDEX IF NOT EXISTS platform_sync_record_results_conflict_idx
  ON platform_sync_record_results(conflict_state,updated_at,id) WHERE outcome = 'conflict';

CREATE TABLE IF NOT EXISTS platform_sync_checkpoints (
  id uuid PRIMARY KEY,
  mapping_profile_id uuid NOT NULL REFERENCES platform_mapping_profiles(id) ON DELETE RESTRICT,
  partition_key varchar(200) NOT NULL,
  cursor varchar(2000) NOT NULL,
  source_watermark_at timestamptz,
  last_successful_run_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (mapping_profile_id,partition_key),
  FOREIGN KEY (last_successful_run_id,mapping_profile_id)
    REFERENCES platform_sync_runs(id,mapping_profile_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS platform_data_alignment_operation_history (
  id uuid PRIMARY KEY,
  operation varchar(60) NOT NULL,
  entity_type varchar(40) NOT NULL CHECK (entity_type IN ('dictionary_version','dictionary_item','external_system','source_of_truth_rule','mapping_profile','sync_run','sync_record_result','sync_checkpoint')),
  entity_id varchar(100) NOT NULL,
  actor_type varchar(20) NOT NULL CHECK (actor_type IN ('person','service')),
  actor_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  service_identity_id varchar(120),
  execution_type varchar(20) NOT NULL CHECK (execution_type IN ('platform','application','service')),
  source_app_id varchar(100),
  request_id varchar(120) NOT NULL,
  trace_id varchar(120) NOT NULL,
  note varchar(2000),
  before_summary jsonb,
  after_summary jsonb,
  occurred_at timestamptz NOT NULL,
  CHECK ((actor_type = 'person' AND actor_person_id IS NOT NULL AND service_identity_id IS NULL) OR (actor_type = 'service' AND actor_person_id IS NULL AND service_identity_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS platform_data_alignment_operation_history_entity_idx
  ON platform_data_alignment_operation_history(entity_type,entity_id,occurred_at,id);
`.trim();

export const PLATFORM_DATA_ALIGNMENT_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-data-alignment-expand',
  title: 'Create Platform shared dictionaries and external alignment evidence tables',
  ownerTaskId: 'PLATFORM-L3-014',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-008'],
  migrationRows: ['MIG-041'],
  sourceTables: ['platform_external_identities', 'platform_external_location_references', 'platform_external_asset_references', 'devices', 'cloud_document_syncs'],
  targetTables: [
    'platform_dictionary_versions',
    'platform_dictionary_items',
    'platform_external_systems',
    'platform_source_of_truth_rules',
    'platform_mapping_profiles',
    'platform_sync_runs',
    'platform_sync_record_results',
    'platform_sync_checkpoints',
    'platform_data_alignment_operation_history'
  ],
  dependsOn: ['platform-people-directory-expand', 'platform-location-directory-expand', 'platform-asset-directory-expand', 'platform-authorization-expand', 'platform-attachments-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Current directory references, device provenance, cloud-document workers, business records, routes, production data, and deployment remain authoritative and unchanged.',
  async run(context) {
    await context.client.query(PLATFORM_DATA_ALIGNMENT_SQL);
    return {
      applied: true,
      notes: ['Data Alignment permissions and nine additive reference-data/alignment evidence tables ensured'],
      reconciliation: { sourceTables: 5, targetTables: 9 }
    };
  }
}];
