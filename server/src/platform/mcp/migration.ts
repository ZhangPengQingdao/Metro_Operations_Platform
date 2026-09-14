import type { MigrationDefinition } from '../../core/migrations/index.js';
import { PLATFORM_MCP_PERMISSION_SEEDS } from './model.js';

const permission = PLATFORM_MCP_PERMISSION_SEEDS[0];

export const PLATFORM_MCP_SQL = `
INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES ('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())
ON CONFLICT (code) DO UPDATE
SET name=EXCLUDED.name,status='active',updated_at=NOW();

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id,permission.id,'all',NOW(),NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code IN ('administrator','team_leader','maintainer')
  AND permission.code='${permission.code}'
ON CONFLICT (role_id,permission_id) DO UPDATE
SET scope_kind='all',updated_at=NOW();
`.trim();

export const PLATFORM_MCP_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-mcp-permission-expand',
  title: 'Register the Platform MCP invocation permission for built-in roles',
  ownerTaskId: 'PLATFORM-L3-016',
  phase: 'expand',
  layer: 'L3',
  dataRows: [],
  migrationRows: ['MIG-026'],
  sourceTables: ['platform_roles'],
  targetTables: ['platform_permissions', 'platform_role_permissions'],
  dependsOn: ['platform-authorization-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Withdrawing the contribution disables the new surface without deleting data or changing current MCP routes.',
  async run(context) {
    await context.client.query(PLATFORM_MCP_SQL);
    return {
      applied: true,
      notes: ['Platform MCP invocation permission and three built-in role grants ensured']
    };
  }
}];
