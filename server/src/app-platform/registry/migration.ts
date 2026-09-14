import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_REGISTRY_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_installations (
  id uuid PRIMARY KEY,
  app_id varchar(64) NOT NULL UNIQUE,
  revision integer NOT NULL CHECK(revision > 0),
  record jsonb NOT NULL,
  CHECK(jsonb_typeof(record)='object' AND record ?& ARRAY['id','appId','revision','manifest','enabled','grants','serviceIdentityId','credentialDigest','createdAt','updatedAt']),
  CHECK((record->>'id'=id::text AND record->>'appId'=app_id) IS TRUE),
  CHECK(((record->>'revision')::integer=revision) IS TRUE),
  CHECK((jsonb_typeof(record->'manifest')='object') IS TRUE),
  CHECK((jsonb_typeof(record->'enabled')='boolean') IS TRUE),
  CHECK((jsonb_typeof(record->'grants')='array' AND jsonb_array_length(record->'grants')<=256) IS TRUE)
);
CREATE TABLE IF NOT EXISTS platform_app_installation_history (
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision > 0),
  record jsonb NOT NULL,
  PRIMARY KEY(installation_id,revision),
  CHECK((record->>'installationId'=installation_id::text AND (record->>'revision')::integer=revision) IS TRUE)
);`;

export const APP_REGISTRY_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'app-registry-expand', title: 'Create application installation identity and lifecycle history',
  ownerTaskId: 'PLATFORM-L4-002', phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-044'],
  sourceTables: [], targetTables: ['platform_app_installations','platform_app_installation_history'],
  dependsOn: ['platform-authorization-expand'],
  recoveryNotes: 'Additive, repeatable schema only; no legacy import or runtime activation. Preserve installations and history on rollback; no automatic drop.',
  async run(context) { await context.client.query(APP_REGISTRY_SQL); return { applied: true }; }
}];
