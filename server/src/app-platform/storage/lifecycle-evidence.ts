import type { QueryableClient } from '../../core/database/index.js';
import type { MigrationDefinition } from '../../core/migrations/index.js';
import { AppStorageError } from './binding.js';

export const APP_STORAGE_LIFECYCLE_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_storage_versions (
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL,
 source_digest varchar(64) NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 target_digest varchar(64) NOT NULL CHECK(target_digest ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(installation_id,operation_id)
);
CREATE TABLE IF NOT EXISTS platform_app_storage_migration_adoptions (
 attempt_id uuid NOT NULL REFERENCES platform_app_migration_attempts(id) ON DELETE RESTRICT,
 target_digest varchar(64) NOT NULL CHECK(target_digest ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(attempt_id,target_digest)
);
CREATE TABLE IF NOT EXISTS platform_app_storage_restores (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
 manifest_digest varchar(64) NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 status varchar(16) NOT NULL CHECK(status IN ('dispatched','completed','rolled_back')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 CHECK((status='dispatched' AND completed_at IS NULL) OR (status IN ('completed','rolled_back') AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_storage_one_restore
 ON platform_app_storage_restores(installation_id) WHERE status='dispatched';
`;
export const APP_STORAGE_LIFECYCLE_MIGRATIONS: readonly MigrationDefinition[] = [{
 id:'app-storage-lifecycle-expand',title:'Record managed storage version and restore evidence',
 ownerTaskId:'PLATFORM-L4-008',phase:'expand',layer:'L4',dataRows:[],migrationRows:['MIG-049'],
 sourceTables:[],targetTables:['platform_app_storage_versions','platform_app_storage_migration_adoptions','platform_app_storage_restores'],
 dependsOn:['app-migration-ledger-expand'],
 recoveryNotes:'Preserve original migration attempts. Dispatched restore blocks use after uncertain results; never clear by timeout or replay.',
 async run(context){await context.client.query(APP_STORAGE_LIFECYCLE_SQL);return {applied:true};},
}];
export async function assertNoPendingRestore(client: QueryableClient, installationId: string) {
 const result=await client.query("SELECT id FROM public.platform_app_storage_restores WHERE installation_id=$1 AND status='dispatched' LIMIT 1",[installationId]) as {rows:unknown[]};
 if(result.rows.length)throw new AppStorageError('RESTORE_RECONCILIATION_REQUIRED');
}
export async function acceptsMigrationDigest(client: QueryableClient, attemptId: string, actual: string, expected: string) {
 if(actual===expected)return true;
 const result=await client.query('SELECT attempt_id FROM public.platform_app_storage_migration_adoptions WHERE attempt_id=$1 AND target_digest=$2',[attemptId,expected]) as {rows:unknown[]};
 return result.rows.length===1;
}
