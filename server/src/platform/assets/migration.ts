import type { MigrationDefinition } from '../../core/migrations/index.js';

export const PLATFORM_ASSET_DIRECTORY_SQL = `
CREATE TABLE IF NOT EXISTS platform_asset_systems (
  id uuid PRIMARY KEY,
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_asset_systems_order_idx
  ON platform_asset_systems(status, sort_order, name);

CREATE TABLE IF NOT EXISTS platform_asset_categories (
  id uuid PRIMARY KEY,
  system_id uuid NOT NULL REFERENCES platform_asset_systems(id) ON DELETE RESTRICT,
  code varchar(100) NOT NULL,
  name varchar(150) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (system_id, code),
  UNIQUE (id, system_id)
);

CREATE INDEX IF NOT EXISTS platform_asset_categories_system_idx
  ON platform_asset_categories(system_id, status, sort_order, name);

CREATE TABLE IF NOT EXISTS platform_asset_types (
  id uuid PRIMARY KEY,
  system_id uuid NOT NULL REFERENCES platform_asset_systems(id) ON DELETE RESTRICT,
  category_id uuid REFERENCES platform_asset_categories(id) ON DELETE RESTRICT,
  code varchar(100) NOT NULL,
  name varchar(150) NOT NULL,
  description text,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (system_id, code),
  UNIQUE (id, system_id),
  UNIQUE (id, system_id, category_id),
  FOREIGN KEY (category_id, system_id)
    REFERENCES platform_asset_categories(id, system_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS platform_asset_types_system_idx
  ON platform_asset_types(system_id, category_id, status, sort_order, name);

CREATE TABLE IF NOT EXISTS platform_assets (
  id uuid PRIMARY KEY,
  system_id uuid NOT NULL REFERENCES platform_asset_systems(id) ON DELETE RESTRICT,
  category_id uuid REFERENCES platform_asset_categories(id) ON DELETE RESTRICT,
  type_id uuid NOT NULL REFERENCES platform_asset_types(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES platform_locations(id) ON DELETE RESTRICT,
  display_name varchar(150) NOT NULL,
  asset_code varchar(100),
  lifecycle_state varchar(20) NOT NULL CHECK (lifecycle_state IN ('planned', 'active', 'suspended', 'retired')),
  data_quality_status varchar(20) NOT NULL CHECK (data_quality_status IN ('unverified', 'verified', 'needs_review')),
  remark text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (type_id, system_id)
    REFERENCES platform_asset_types(id, system_id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, system_id)
    REFERENCES platform_asset_categories(id, system_id) ON DELETE RESTRICT,
  FOREIGN KEY (type_id, system_id, category_id)
    REFERENCES platform_asset_types(id, system_id, category_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_assets_location_type_name_idx
  ON platform_assets(location_id, type_id, lower(display_name));

CREATE UNIQUE INDEX IF NOT EXISTS platform_assets_code_idx
  ON platform_assets(lower(asset_code))
  WHERE asset_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS platform_assets_classification_idx
  ON platform_assets(system_id, category_id, type_id, lifecycle_state);

CREATE INDEX IF NOT EXISTS platform_assets_location_idx
  ON platform_assets(location_id, lifecycle_state, display_name);

CREATE TABLE IF NOT EXISTS platform_asset_aliases (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES platform_assets(id) ON DELETE CASCADE,
  alias varchar(200) NOT NULL,
  alias_type varchar(30) NOT NULL CHECK (alias_type IN ('display', 'historical', 'external')),
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_asset_aliases_value_idx
  ON platform_asset_aliases(asset_id, lower(alias));

CREATE TABLE IF NOT EXISTS platform_external_asset_references (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES platform_assets(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  tenant_key varchar(100) NOT NULL,
  external_asset_id varchar(255) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('active', 'inactive')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, tenant_key, external_asset_id),
  UNIQUE (asset_id, provider, tenant_key)
);

CREATE INDEX IF NOT EXISTS platform_external_asset_refs_asset_idx
  ON platform_external_asset_references(asset_id, status);
`.trim();

export const PLATFORM_ASSET_DIRECTORY_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: 'platform-asset-directory-expand',
    title: 'Create Platform cross-professional asset directory tables',
    ownerTaskId: 'PLATFORM-L3-003',
    phase: 'expand',
    layer: 'L3',
    dataRows: ['DATA-003'],
    migrationRows: ['MIG-017'],
    sourceTables: ['devices', 'device_types', 'fault_record_devices', 'device_resolution_audits'],
    targetTables: [
      'platform_asset_systems',
      'platform_asset_categories',
      'platform_asset_types',
      'platform_assets',
      'platform_asset_aliases',
      'platform_external_asset_references'
    ],
    dependsOn: ['platform-location-directory-expand'],
    recoveryNotes: 'The migration is additive and idempotent. Fix isolated-database DDL or permissions and rerun; current devices, device_types, and application consumers remain authoritative.',
    async run(context) {
      await context.client.query(PLATFORM_ASSET_DIRECTORY_SQL);
      return {
        applied: true,
        notes: ['Platform asset systems, categories, types, assets, aliases, and external-reference tables ensured'],
        reconciliation: {
          sourceTables: 4,
          targetTables: 6
        }
      };
    }
  }
];
