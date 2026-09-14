import type { MigrationDefinition } from '../../core/migrations/index.js';
import { RESPONSIBILITY_AREA_SEEDS } from './model.js';

const areaValues = RESPONSIBILITY_AREA_SEEDS
  .map((area) => `('${area.id}', '${area.code}', '${area.name}', NULL, 'active', NOW(), NOW())`)
  .join(',\n  ');

export const PLATFORM_RESPONSIBILITY_SQL = `
CREATE TABLE IF NOT EXISTS platform_responsibility_areas (
  id uuid PRIMARY KEY, code varchar(100) NOT NULL UNIQUE, name varchar(150) NOT NULL,
  description text, status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);

INSERT INTO platform_responsibility_areas (id, code, name, description, status, created_at, updated_at)
VALUES
  ${areaValues}
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_responsibility_scopes (
  id uuid PRIMARY KEY,
  organization_unit_id uuid NOT NULL REFERENCES platform_organization_units(id) ON DELETE RESTRICT,
  responsibility_area_id uuid REFERENCES platform_responsibility_areas(id) ON DELETE RESTRICT,
  location_id uuid REFERENCES platform_locations(id) ON DELETE RESTRICT,
  asset_type_id uuid REFERENCES platform_asset_types(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES platform_assets(id) ON DELETE RESTRICT,
  include_descendants boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK (((responsibility_area_id IS NOT NULL)::integer + (location_id IS NOT NULL)::integer +
          (asset_type_id IS NOT NULL)::integer + (asset_id IS NOT NULL)::integer) = 1),
  CHECK (NOT include_descendants OR location_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_resp_scope_area_idx ON platform_responsibility_scopes(organization_unit_id, responsibility_area_id) WHERE responsibility_area_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_resp_scope_location_idx ON platform_responsibility_scopes(organization_unit_id, location_id, include_descendants) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_resp_scope_asset_type_idx ON platform_responsibility_scopes(organization_unit_id, asset_type_id) WHERE asset_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_resp_scope_asset_idx ON platform_responsibility_scopes(organization_unit_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_responsibility_assignments (
  id uuid PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES platform_responsibility_scopes(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  assignment_role varchar(30) NOT NULL CHECK (assignment_role IN ('primary_owner','backup_owner','temporary_agent')),
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  status varchar(20) NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (assignment_role <> 'temporary_agent' OR effective_to IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_resp_assignment_scope_idx ON platform_responsibility_assignments(scope_id, assignment_role, status, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS platform_resp_assignment_person_idx ON platform_responsibility_assignments(person_id, status, effective_from, effective_to);
`.trim();

export const PLATFORM_RESPONSIBILITY_MIGRATIONS: readonly MigrationDefinition[] = [{
  id: 'platform-responsibility-expand', title: 'Create Platform responsibility scopes and assignments',
  ownerTaskId: 'PLATFORM-L3-004', phase: 'expand', layer: 'L3', dataRows: ['DATA-004'], migrationRows: ['MIG-018'],
  sourceTables: ['workgroup_station_responsibilities'],
  targetTables: ['platform_responsibility_areas','platform_responsibility_scopes','platform_responsibility_assignments'],
  dependsOn: ['platform-people-directory-expand','platform-location-directory-expand','platform-asset-directory-expand'],
  recoveryNotes: 'The migration is additive and idempotent. Current responsibility rows and todo resolution remain authoritative.',
  async run(context) { await context.client.query(PLATFORM_RESPONSIBILITY_SQL); return { applied: true, notes: ['Responsibility tables and four area seeds ensured'] }; }
}];
