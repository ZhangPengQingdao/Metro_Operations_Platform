import type {MigrationDefinition} from '../../core/migrations/index.js';
export const dashboardLayoutMigration:MigrationDefinition={
 id:'platform-employee-dashboard-layout-expand',title:'Employee dashboard preferences',ownerTaskId:'PLATFORM-L4-015',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-DASHBOARD-LAYOUT'],sourceTables:[],targetTables:['platform_employee_dashboard_layouts'],dependsOn:['platform-employee-identity-expand'],recoveryNotes:'Additive account preferences only; no application data or permission changes.',
 async run({client}){await client.query(`CREATE TABLE IF NOT EXISTS platform_employee_dashboard_layouts(account_id uuid PRIMARY KEY REFERENCES platform_employee_accounts(id) ON DELETE CASCADE,layout jsonb NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now())`);}
};
