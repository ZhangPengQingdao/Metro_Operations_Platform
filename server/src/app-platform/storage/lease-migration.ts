import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_STORAGE_LEASE_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_storage_leases (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
 owner_role varchar(63) NOT NULL,
 registered_revision integer NOT NULL CHECK (registered_revision > 0),
 status varchar(16) NOT NULL CHECK (status IN ('active','released')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(started_at)),
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
 released_at timestamptz CHECK (isfinite(released_at)),
 CHECK (expires_at > started_at),
 CHECK (owner_role = 'app_' || replace(installation_id::text,'-','') || '_owner'),
 CHECK ((status='active' AND released_at IS NULL) OR (status='released' AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_storage_one_lease
 ON platform_app_storage_leases(installation_id) WHERE status='active';
`;
export const APP_STORAGE_LEASE_MIGRATIONS: readonly MigrationDefinition[] = [{
 id: 'app-storage-lease-expand', title: 'Create platform-owned application owner credential leases',
 ownerTaskId: 'PLATFORM-L4-003', phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-046'],
 sourceTables: [], targetTables: ['platform_app_storage_leases'], dependsOn: ['app-registry-expand'],
 recoveryNotes: 'Preserve lease records. Recovery must hold the installation lock and revoke only the recorded installation owner. Expiry is not transaction rollback evidence.',
 async run(context) { await context.client.query(APP_STORAGE_LEASE_SQL); return { applied: true }; },
}];
