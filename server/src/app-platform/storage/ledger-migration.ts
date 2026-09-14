import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_MIGRATION_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_migration_attempts (
  sequence integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  registered_revision integer NOT NULL CHECK(registered_revision > 0),
  manifest_digest varchar(64) NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
  ordinal integer NOT NULL CHECK(ordinal >= 0 AND ordinal < 128),
  migration_id varchar(64) NOT NULL CHECK(migration_id ~ '^[a-z][a-z0-9-]*$'),
  artifact_id varchar(64) NOT NULL CHECK(artifact_id ~ '^[a-z][a-z0-9-]*$'),
  artifact_path varchar(256) NOT NULL CHECK(length(artifact_path) > 0),
  artifact_sha256 varchar(64) NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes integer NOT NULL CHECK(artifact_bytes > 0 AND artifact_bytes <= 1048576),
  status varchar(16) NOT NULL CHECK(status IN ('running','applied','rolled_back','uncertain')),
  started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
  started_by varchar(128) NOT NULL CHECK(length(btrim(started_by)) > 0),
  finished_at timestamptz CHECK(isfinite(finished_at)),
  finished_by varchar(128) CHECK(length(btrim(finished_by)) > 0),
  CHECK((status='running' AND finished_at IS NULL AND finished_by IS NULL)
    OR (status<>'running' AND finished_at IS NOT NULL AND finished_by IS NOT NULL AND finished_at >= started_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_migration_one_blocker
  ON platform_app_migration_attempts(installation_id) WHERE status IN ('running','uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_migration_applied_ordinal
  ON platform_app_migration_attempts(installation_id,ordinal) WHERE status='applied';
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_migration_applied_id
  ON platform_app_migration_attempts(installation_id,migration_id) WHERE status='applied';
CREATE INDEX IF NOT EXISTS platform_app_migration_history
  ON platform_app_migration_attempts(installation_id,sequence);
`;

export const APP_MIGRATION_LEDGER_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'app-migration-ledger-expand', title: 'Create platform-owned application migration attempt ledger',
  ownerTaskId: 'PLATFORM-L4-003', phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-045'],
  sourceTables: [], targetTables: ['platform_app_migration_attempts'], dependsOn: ['app-registry-expand'],
  recoveryNotes: 'Additive only. Preserve attempt history; never automatically drop or take over running/uncertain attempts. Does not execute application SQL.',
  async run(context) { await context.client.query(APP_MIGRATION_LEDGER_SQL); return { applied: true }; },
}];
