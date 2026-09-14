import type { MigrationDefinition } from '../../core/migrations/index.js';

export const PLATFORM_PEOPLE_DIRECTORY_SQL = `
CREATE TABLE IF NOT EXISTS platform_organization_units (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES platform_organization_units(id) ON DELETE RESTRICT,
  code varchar(100) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  short_name varchar(100),
  unit_type varchar(40) NOT NULL CHECK (unit_type IN (
    'company', 'operations_center', 'department', 'station_area', 'workgroup', 'station_organization'
  )),
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS platform_organization_units_parent_idx
  ON platform_organization_units(parent_id, sort_order, name);

CREATE TABLE IF NOT EXISTS platform_positions (
  id uuid PRIMARY KEY,
  code varchar(100) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_positions_name_idx
  ON platform_positions(name);

CREATE TABLE IF NOT EXISTS platform_people (
  id uuid PRIMARY KEY,
  employee_no varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  phone varchar(50),
  organization_unit_id uuid NOT NULL REFERENCES platform_organization_units(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL REFERENCES platform_positions(id) ON DELETE RESTRICT,
  employment_status varchar(20) NOT NULL CHECK (employment_status IN ('active', 'inactive', 'departed')),
  avatar_url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_people_organization_idx
  ON platform_people(organization_unit_id, employment_status, name);

CREATE INDEX IF NOT EXISTS platform_people_position_idx
  ON platform_people(position_id, employment_status, name);

CREATE TABLE IF NOT EXISTS platform_external_identities (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  tenant_key varchar(100) NOT NULL,
  external_user_id varchar(255) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, tenant_key, external_user_id),
  UNIQUE (person_id, provider, tenant_key)
);

CREATE INDEX IF NOT EXISTS platform_external_identities_person_idx
  ON platform_external_identities(person_id, status);
`.trim();

export const PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: 'platform-people-directory-expand',
    title: 'Create Platform people and organization directory tables',
    ownerTaskId: 'PLATFORM-L3-001',
    phase: 'expand',
    layer: 'L3',
    dataRows: ['DATA-001'],
    migrationRows: ['MIG-015'],
    sourceTables: ['users', 'workgroups'],
    targetTables: [
      'platform_organization_units',
      'platform_positions',
      'platform_people',
      'platform_external_identities'
    ],
    recoveryNotes: 'The migration is additive and idempotent. On failure, fix the isolated database permissions or DDL issue and rerun; current users/workgroups remain authoritative.',
    async run(context) {
      await context.client.query(PLATFORM_PEOPLE_DIRECTORY_SQL);
      return {
        applied: true,
        notes: ['Platform people and organization directory tables and indexes ensured'],
        reconciliation: {
          sourceTables: 2,
          targetTables: 4
        }
      };
    }
  }
];
