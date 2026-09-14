import type { MigrationDefinition } from '../../core/migrations/index.js';

export const PLATFORM_LOCATION_DIRECTORY_SQL = `
CREATE TABLE IF NOT EXISTS platform_locations (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES platform_locations(id) ON DELETE RESTRICT,
  organization_unit_id uuid REFERENCES platform_organization_units(id) ON DELETE RESTRICT,
  code varchar(100) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  short_name varchar(100),
  location_type varchar(40) NOT NULL CHECK (location_type IN (
    'station', 'depot', 'workshop', 'equipment_room', 'operational_area'
  )),
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (organization_unit_id IS NULL OR location_type = 'station')
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_locations_organization_unit_idx
  ON platform_locations(organization_unit_id)
  WHERE organization_unit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_locations_parent_idx
  ON platform_locations(parent_id, sort_order, name);

CREATE INDEX IF NOT EXISTS platform_locations_type_idx
  ON platform_locations(location_type, status, name);

CREATE TABLE IF NOT EXISTS platform_lines (
  id uuid PRIMARY KEY,
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  short_name varchar(100),
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_lines_order_idx
  ON platform_lines(status, sort_order, name);

CREATE TABLE IF NOT EXISTS platform_line_stations (
  id uuid PRIMARY KEY,
  line_id uuid NOT NULL REFERENCES platform_lines(id) ON DELETE RESTRICT,
  station_id uuid NOT NULL REFERENCES platform_locations(id) ON DELETE RESTRICT,
  station_code varchar(50) NOT NULL,
  sort_order integer NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (line_id, station_id),
  UNIQUE (line_id, station_code),
  UNIQUE (line_id, sort_order)
);

CREATE INDEX IF NOT EXISTS platform_line_stations_station_idx
  ON platform_line_stations(station_id, status);

CREATE TABLE IF NOT EXISTS platform_location_aliases (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES platform_locations(id) ON DELETE CASCADE,
  alias varchar(200) NOT NULL,
  alias_type varchar(30) NOT NULL CHECK (alias_type IN ('common', 'short_name', 'historical')),
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_location_aliases_value_idx
  ON platform_location_aliases(location_id, lower(alias));

CREATE INDEX IF NOT EXISTS platform_location_aliases_search_idx
  ON platform_location_aliases(lower(alias), status);

CREATE TABLE IF NOT EXISTS platform_external_location_references (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES platform_locations(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  tenant_key varchar(100) NOT NULL,
  external_location_id varchar(255) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, tenant_key, external_location_id),
  UNIQUE (location_id, provider, tenant_key)
);

CREATE INDEX IF NOT EXISTS platform_external_location_refs_location_idx
  ON platform_external_location_references(location_id, status);
`.trim();

export const PLATFORM_LOCATION_DIRECTORY_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: 'platform-location-directory-expand',
    title: 'Create Platform physical location and line directory tables',
    ownerTaskId: 'PLATFORM-L3-002',
    phase: 'expand',
    layer: 'L3',
    dataRows: ['DATA-002'],
    migrationRows: ['MIG-016'],
    sourceTables: ['stations'],
    targetTables: [
      'platform_locations',
      'platform_lines',
      'platform_line_stations',
      'platform_location_aliases',
      'platform_external_location_references'
    ],
    dependsOn: ['platform-people-directory-expand'],
    recoveryNotes: 'The migration is additive and idempotent. Fix isolated-database DDL or permissions and rerun; current stations and all existing consumers remain authoritative.',
    async run(context) {
      await context.client.query(PLATFORM_LOCATION_DIRECTORY_SQL);
      return {
        applied: true,
        notes: ['Platform location, line, line-station, alias, and external-reference tables ensured'],
        reconciliation: {
          sourceTables: 1,
          targetTables: 5
        }
      };
    }
  }
];
