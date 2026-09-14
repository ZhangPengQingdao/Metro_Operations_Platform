import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_MIGRATION_RECEIPT_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_migration_receipts (
 attempt_id uuid PRIMARY KEY REFERENCES platform_app_migration_attempts(id) ON DELETE RESTRICT,
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
 manifest_digest varchar(64) NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 artifact_sha256 varchar(64) NOT NULL CHECK(artifact_sha256 ~ '^[0-9a-f]{64}$'),
 dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 transaction_id varchar(20) CHECK(transaction_id ~ '^[0-9]{1,20}$'),
 database_name varchar(63),
 CHECK((transaction_id IS NULL AND database_name IS NULL) OR
       (transaction_id IS NOT NULL AND database_name IS NOT NULL AND length(database_name)>0))
);
CREATE TABLE IF NOT EXISTS platform_app_migration_reconciliations (
 id uuid PRIMARY KEY,
 attempt_id uuid NOT NULL REFERENCES platform_app_migration_attempts(id) ON DELETE RESTRICT,
 previous_status varchar(16) NOT NULL CHECK(previous_status IN ('running','uncertain')),
 new_status varchar(16) NOT NULL CHECK(new_status IN ('applied','rolled_back')),
 evidence varchar(32) NOT NULL CHECK(evidence IN ('committed','aborted','not_started_quiescent')),
 transaction_id varchar(20),
 actor_id varchar(128) NOT NULL CHECK(length(btrim(actor_id))>0),
 reconciled_at timestamptz NOT NULL CHECK(isfinite(reconciled_at))
);
`;
export const APP_MIGRATION_RECEIPT_MIGRATIONS: readonly MigrationDefinition[] = [{
 id:'app-migration-receipt-expand', title:'Create durable application migration dispatch and reconciliation evidence',
 ownerTaskId:'PLATFORM-L4-003', phase:'expand', layer:'L4', dataRows:[], migrationRows:['MIG-047'],
 sourceTables:[], targetTables:['platform_app_migration_receipts','platform_app_migration_reconciliations'],
 dependsOn:['app-migration-ledger-expand','app-storage-lease-expand'],
 recoveryNotes:'Preserve evidence. Transaction status is meaningful only on the pinned original database cluster; unknown status never permits replay.',
 async run(context) { await context.client.query(APP_MIGRATION_RECEIPT_SQL); return {applied:true}; },
}];
