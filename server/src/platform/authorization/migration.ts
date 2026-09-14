import type { MigrationDefinition } from '../../core/migrations/index.js';
import { AUTHORIZATION_PERMISSION_SEEDS, AUTHORIZATION_ROLE_SEEDS } from './model.js';

const roleValues = AUTHORIZATION_ROLE_SEEDS.map((role) => `('${role.id}','${role.code}','${role.name}',NULL,'active',true,NOW(),NOW())`).join(',\n  ');
const permissionValues = AUTHORIZATION_PERMISSION_SEEDS.map((permission) => `('${permission.id}','${permission.code}','${permission.name}',NULL,'active',NOW(),NOW())`).join(',\n  ');

export const PLATFORM_AUTHORIZATION_SQL = `
CREATE TABLE IF NOT EXISTS platform_roles (
  id uuid PRIMARY KEY,
  code varchar(150) NOT NULL UNIQUE,
  name varchar(150) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  built_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO platform_roles (id,code,name,description,status,built_in,created_at,updated_at)
VALUES
  ${roleValues}
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_permissions (
  id uuid PRIMARY KEY,
  code varchar(150) NOT NULL UNIQUE,
  name varchar(150) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO platform_permissions (id,code,name,description,status,created_at,updated_at)
VALUES
  ${permissionValues}
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_role_permissions (
  role_id uuid NOT NULL REFERENCES platform_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES platform_permissions(id) ON DELETE CASCADE,
  scope_kind varchar(30) NOT NULL CHECK (scope_kind IN ('self','organization','organization_tree','responsibility','explicit','all')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (role_id,permission_id)
);

INSERT INTO platform_role_permissions (role_id,permission_id,scope_kind,created_at,updated_at)
SELECT role.id,permission.id,'all',NOW(),NOW()
FROM platform_roles role CROSS JOIN platform_permissions permission
WHERE role.code='administrator' AND permission.code IN ('platform.authorization.read','platform.authorization.manage')
ON CONFLICT (role_id,permission_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_role_permission_targets (
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  target_type varchar(30) NOT NULL CHECK (target_type IN ('organization','location','asset_type','asset','responsibility_scope')),
  target_id uuid NOT NULL,
  PRIMARY KEY (role_id,permission_id,target_type,target_id),
  FOREIGN KEY (role_id,permission_id) REFERENCES platform_role_permissions(role_id,permission_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_person_role_assignments (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES platform_roles(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  assigned_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  reason varchar(500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_person_current_role_idx ON platform_person_role_assignments(person_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS platform_person_role_history_idx ON platform_person_role_assignments(person_id,effective_from,effective_to);
`.trim();

export const PLATFORM_AUTHORIZATION_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-authorization-expand',
  title: 'Create Platform roles, permissions, data scopes, and person role assignments',
  ownerTaskId: 'PLATFORM-L3-005',
  phase: 'expand',
  layer: 'L3',
  dataRows: ['DATA-001'],
  migrationRows: ['MIG-019'],
  sourceTables: ['users'],
  targetTables: ['platform_roles','platform_permissions','platform_role_permissions','platform_role_permission_targets','platform_person_role_assignments'],
  dependsOn: ['platform-people-directory-expand','platform-responsibility-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Current users.role and authorization helpers remain authoritative until a later verified switch.',
  async run(context) {
    await context.client.query(PLATFORM_AUTHORIZATION_SQL);
    return { applied: true, notes: ['Authorization catalogs, grants, scopes, and single-current-role constraint ensured'] };
  }
}];
