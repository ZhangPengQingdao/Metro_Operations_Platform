import { createHash } from 'node:crypto';
import type { MigrationDefinition } from '../../core/migrations/index.js';
import type { QueryableClient } from '../../core/database/index.js';
import { compileAppMigration } from '../storage/declarative-migration.js';

/** Application model v2 bookkeeping: applied declarative migrations and write idempotency keys. */
export const APP_V2_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_v2_migrations(
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  migration_id text NOT NULL CHECK(migration_id ~ '^[0-9]{3}-[a-z0-9]+(-[a-z0-9]+)*$'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,migration_id)
);
CREATE TABLE IF NOT EXISTS platform_app_v2_requests(
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,request_id)
);
CREATE INDEX IF NOT EXISTS platform_app_v2_requests_created ON platform_app_v2_requests(created_at);`;

export const appV2Migration: MigrationDefinition = {
  id: 'platform-app-v2-expand', title: 'Application model v2 migrations and write idempotency', ownerTaskId: 'PLATFORM-APP-V2-P2',
  phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-APP-V2'], sourceTables: [],
  targetTables: ['platform_app_v2_migrations', 'platform_app_v2_requests'], dependsOn: ['app-registry-expand'],
  recoveryNotes: 'Additive tables only; existing v1 applications and their storage are untouched.',
  async run({ client }) { await client.query(APP_V2_SQL); },
};

export class AppMigrationV2Error extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppMigrationV2Error'; }
}
export const appSchemaName = (installationId: string) => `app_${installationId.replaceAll('-', '')}`;
export interface AppMigrationV2Input { id: string; text: string }

/**
 * Creates the application schema and applies new migrations in order, in the caller's transaction.
 * Already-applied migrations must be an unchanged prefix of the package list (append-only).
 */
export async function applyAppMigrationsV2(client: QueryableClient, installationId: string, migrations: readonly AppMigrationV2Input[]): Promise<string[]> {
  const schema = appSchemaName(installationId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`app-v2-migrations:${installationId}`]);
  const applied = (await client.query('SELECT migration_id,sha256 FROM platform_app_v2_migrations WHERE installation_id=$1 ORDER BY migration_id', [installationId]) as { rows: { migration_id: string; sha256: string }[] }).rows;
  const digests = migrations.map(m => ({ ...m, sha256: createHash('sha256').update(m.text).digest('hex') }));
  applied.forEach((row, index) => {
    const declared = digests[index];
    if (!declared || declared.id !== row.migration_id || declared.sha256 !== row.sha256) throw new AppMigrationV2Error('MIGRATION_HISTORY_CHANGED');
  });
  const pending = digests.slice(applied.length);
  if (pending.length || !applied.length) await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  for (const migration of pending) {
    let statements: readonly string[];
    try { statements = compileAppMigration(migration.text, schema); } catch { throw new AppMigrationV2Error('MIGRATION_INVALID_DECLARATION'); }
    for (const statement of statements) await client.query(statement);
    await client.query('INSERT INTO platform_app_v2_migrations(installation_id,migration_id,sha256) VALUES($1,$2,$3)', [installationId, migration.id, migration.sha256]);
  }
  return pending.map(m => m.id);
}
