import type { MigrationDefinition } from '../core/migrations/index.js';

export const ADMIN_PASSWORD_SESSION_SQL = `ALTER TABLE platform_admin_sessions ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;`;
export const EMPLOYEE_PASSWORD_SESSION_SQL = `ALTER TABLE platform_employee_sessions ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;`;

export const passwordPolicyMigration: MigrationDefinition = {
 id: 'platform-password-policy-sessions-expand', title: 'Restrict sessions that require a password change',
 ownerTaskId: 'PLATFORM-L4-014', phase: 'expand', layer: 'L1', dataRows: [], migrationRows: ['MIG-075'], sourceTables: [],
 targetTables: ['platform_admin_sessions', 'platform_employee_sessions'],
 dependsOn: ['platform-admin-identity-expand', 'platform-employee-identity-expand'],
 recoveryNotes: 'Additive session flags only. Existing credentials are checked at the next successful login; no password hashes are rewritten.',
 async run({ client }) {
  await client.query(ADMIN_PASSWORD_SESSION_SQL);
  await client.query(EMPLOYEE_PASSWORD_SESSION_SQL);
 }
};
