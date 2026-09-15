import {PLATFORM_RESPONSIBILITY_MIGRATIONS} from '../platform/responsibility/migration.js';
import {PLATFORM_SIGNATURE_MIGRATIONS} from '../platform/signatures/migration.js';
import {PLATFORM_DATA_ALIGNMENT_MIGRATIONS} from '../platform/data-alignment/migration.js';
import {PLATFORM_MCP_MIGRATIONS} from '../platform/mcp/migration.js';
import {PLATFORM_BUSINESS_AUDIT_MIGRATIONS} from '../platform/audit/migration.js';
import {PLATFORM_LOCATION_DIRECTORY_MIGRATIONS} from '../platform/locations/migration.js';
import {PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS} from '../platform/people/migration.js';
import {PLATFORM_ATTACHMENT_MIGRATIONS} from '../platform/attachments/migration.js';
import {PLATFORM_AUTHORIZATION_MIGRATIONS} from '../platform/authorization/migration.js';
import {PLATFORM_ASSET_DIRECTORY_MIGRATIONS} from '../platform/assets/migration.js';
import {PLATFORM_DUTY_MIGRATIONS} from '../platform/duty/migration.js';
import {PLATFORM_NOTIFICATION_MIGRATIONS} from '../platform/notifications/migration.js';
import {PLATFORM_WORK_ITEM_MIGRATIONS} from '../platform/work-items/migration.js';
import {APP_VERSION_MIGRATIONS} from '../app-platform/install/version-service.js';
import {APP_INSTALL_MIGRATIONS} from '../app-platform/install/journal.js';
import {APP_RUNTIME_WORK_MIGRATIONS} from '../app-platform/runtime/work-journal.js';
import {APP_DOCKER_JOURNAL_MIGRATIONS} from '../app-platform/runtime/docker-journal-migration.js';
import {APP_DOCKER_REJECTION_MIGRATIONS} from '../app-platform/runtime/docker-journal-migration.js';
import {APP_STORAGE_LEASE_MIGRATIONS} from '../app-platform/storage/lease-migration.js';
import {APP_MIGRATION_LEDGER_MIGRATIONS} from '../app-platform/storage/ledger-migration.js';
import {APP_MIGRATION_RECEIPT_MIGRATIONS} from '../app-platform/storage/receipt-migration.js';
import {APP_STORAGE_LIFECYCLE_MIGRATIONS} from '../app-platform/storage/lifecycle-evidence.js';
import {APP_REGISTRY_MIGRATIONS} from '../app-platform/registry/migration.js';
import {CORE_OBSERVABILITY_MIGRATIONS} from '../core/observability/index.js';
import {CORE_EVENTS_MIGRATIONS} from '../core/events/index.js';
import {adminIdentityMigration} from '../core/admin-identity/index.js';
import {CORE_JOB_RUNS_TABLE_SQL} from '../core/jobs/index.js';
import {createMigrationRegistry,planMigrations,type MigrationDefinition} from '../core/migrations/index.js';
import {runDatabaseTransaction,type QueryableClient} from '../core/database/index.js';
import {employeeIdentityMigration} from '../platform/employee-identity/index.js';
import {appRuntimeStorageMigration} from '../app-platform/storage/runtime-evidence.js';
import {appGatewayPermissionsMigration} from '../app-platform/gateway/migration.js';
const settings:MigrationDefinition={id:'platform-settings-expand',title:'Platform configuration',ownerTaskId:'PLATFORM-L1-001',phase:'expand',layer:'L1',dataRows:[],migrationRows:['MIG-055'],sourceTables:[],targetTables:['system_configs','core_job_runs'],recoveryNotes:'Additive schema only.',async run({client}){
 await client.query(`CREATE TABLE IF NOT EXISTS system_configs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),key text UNIQUE NOT NULL,value jsonb NOT NULL,description text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
 await client.query(CORE_JOB_RUNS_TABLE_SQL);
}};
export const platformMigrations=createMigrationRegistry([...PLATFORM_RESPONSIBILITY_MIGRATIONS,...PLATFORM_SIGNATURE_MIGRATIONS,...PLATFORM_DATA_ALIGNMENT_MIGRATIONS,...PLATFORM_MCP_MIGRATIONS,...PLATFORM_BUSINESS_AUDIT_MIGRATIONS,...PLATFORM_LOCATION_DIRECTORY_MIGRATIONS,...PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,...PLATFORM_ATTACHMENT_MIGRATIONS,...PLATFORM_AUTHORIZATION_MIGRATIONS,...PLATFORM_ASSET_DIRECTORY_MIGRATIONS,...PLATFORM_DUTY_MIGRATIONS,...PLATFORM_NOTIFICATION_MIGRATIONS,...PLATFORM_WORK_ITEM_MIGRATIONS,...APP_VERSION_MIGRATIONS,...APP_INSTALL_MIGRATIONS,...APP_RUNTIME_WORK_MIGRATIONS,...APP_DOCKER_JOURNAL_MIGRATIONS,...APP_DOCKER_REJECTION_MIGRATIONS,...APP_STORAGE_LEASE_MIGRATIONS,...APP_MIGRATION_LEDGER_MIGRATIONS,...APP_MIGRATION_RECEIPT_MIGRATIONS,...APP_STORAGE_LIFECYCLE_MIGRATIONS,...APP_REGISTRY_MIGRATIONS,...CORE_OBSERVABILITY_MIGRATIONS,...CORE_EVENTS_MIGRATIONS,adminIdentityMigration,employeeIdentityMigration,appGatewayPermissionsMigration,appRuntimeStorageMigration,settings]);
export async function initializePlatformDatabase(client:QueryableClient){
 return runDatabaseTransaction(client,async()=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('metro-platform-schema',0))");
  await client.query('CREATE TABLE IF NOT EXISTS platform_schema_migrations(id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const rows=await client.query('SELECT id FROM platform_schema_migrations') as {rows:{id:string}[]};
  const applied=new Set(rows.rows.map(row=>row.id));
  const completed:string[]=[];
  for(const migration of planMigrations(platformMigrations)){
   if(applied.has(migration.id))continue;
   await migration.run({client});
   await client.query('INSERT INTO platform_schema_migrations(id) VALUES($1)',[migration.id]);
   completed.push(migration.id);
  }
  return completed;
 });
}
