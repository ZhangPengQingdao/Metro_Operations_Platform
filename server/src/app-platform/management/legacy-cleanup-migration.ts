import type {MigrationDefinition} from '../../core/migrations/index.js';

/** Bookkeeping tables of the removed signed-package runtime (Docker, sandbox, storage leases, approvals). */
const LEGACY_TABLES=['platform_app_runtime_write_reconciliations','platform_app_runtime_write_receipts','platform_app_runtime_storage_writes','platform_app_runtime_storage_leases',
 'platform_app_storage_migration_adoptions','platform_app_storage_restores','platform_app_storage_versions','platform_app_migration_reconciliations','platform_app_migration_receipts',
 'platform_app_migration_attempts','platform_app_storage_leases','platform_app_docker_dispatches','platform_app_runtime_work','platform_app_versions','platform_app_install_requests',
 'platform_app_approval_history','platform_app_capability_publications'];
/** Rows keyed by installation, deleted for installations that are not `.mopkg` installs; order follows the foreign keys. */
const INSTALLATION_TABLES=['platform_app_delegated_members','platform_app_role_delegations','platform_app_member_roles','platform_app_business_members','platform_app_authorization',
 'platform_app_business_roles','platform_employee_app_access','platform_app_v2_requests','platform_app_v2_migrations'];

/**
 * 1.0.0 removes the signed-package (v1) application runtime. Applications installed that way cannot run any more and are
 * removed with their authorization rows; their former schemas (`app_<id>`) are left in place for a database administrator.
 * The app data permissions, previously seeded by a removed migration, are kept for `.mopkg` applications.
 */
export const appLegacyCleanupMigration:MigrationDefinition={id:'app-legacy-runtime-cleanup',title:'Remove the signed-package application runtime',ownerTaskId:'PLATFORM-APPV2-003',phase:'switch',layer:'L4',dataRows:[],migrationRows:['MIG-APP-V1-CLEANUP'],
 sourceTables:LEGACY_TABLES,targetTables:['platform_permissions','platform_app_installations'],dependsOn:['app-registry-expand','platform-authorization-expand','platform-app-v2-expand','app-business-authorization-expand','app-employee-access-expand'],
 removalGate:'Signed-package application runtime removed from the platform in 1.0.0',
 recoveryNotes:'Destructive for signed-package installations only; the platform has no production deployment of them. Take a database backup before upgrading a test server whose data must be kept.',
 async run({client}){
  await client.query(`INSERT INTO platform_permissions(id,code,name,status,created_at,updated_at) VALUES
   ('49000000-0000-4000-8000-000000000003','platform.app_data.read','读取应用自身数据','active',now(),now()),
   ('49000000-0000-4000-8000-000000000004','platform.app_data.write','写入应用自身数据','active',now(),now()) ON CONFLICT(code) DO NOTHING`);
  for(const table of LEGACY_TABLES)await client.query(`DROP TABLE IF EXISTS public.${table} CASCADE`);
  const legacy="SELECT id FROM platform_app_installations WHERE record->'runtime'->>'model' IS DISTINCT FROM 'v2'";
  for(const table of INSTALLATION_TABLES)await client.query(`DELETE FROM public.${table} WHERE installation_id IN (${legacy})`);
  await client.query(`DELETE FROM platform_app_installation_history WHERE installation_id IN (${legacy})`);
  await client.query(`DELETE FROM platform_app_installations WHERE id IN (${legacy})`);
 }};
