import type {MigrationDefinition} from '../../core/migrations/index.js';

export const STATION_NUMBER_SQL=`
ALTER TABLE platform_line_stations ADD COLUMN IF NOT EXISTS station_number varchar(50);
CREATE UNIQUE INDEX IF NOT EXISTS platform_line_station_number_unique ON platform_line_stations(line_id,lower(station_number)) WHERE station_number IS NOT NULL;
ALTER TABLE platform_line_stations ADD CONSTRAINT platform_line_station_number_valid CHECK (
 station_number IS NULL OR (station_number ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')
);
CREATE TABLE IF NOT EXISTS admin_station_requests (
 request_id uuid PRIMARY KEY, request_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);`;

export const stationNumberMigration:MigrationDefinition={
 id:'platform-station-number-expand',title:'Administrator maintained station numbers',ownerTaskId:'PLATFORM-L3-002',
 phase:'expand',layer:'L3',dataRows:['DATA-002'],migrationRows:['MIG-STATION-NUMBER'],
 sourceTables:[],targetTables:['platform_line_stations','admin_station_requests'],dependsOn:['platform-location-directory-expand'],
 recoveryNotes:'Additive nullable station number; existing station IDs, internal codes and line order remain unchanged.',
 async run({client}){await client.query(STATION_NUMBER_SQL);},
};
