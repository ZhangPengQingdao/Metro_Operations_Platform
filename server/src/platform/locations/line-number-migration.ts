import type {MigrationDefinition} from '../../core/migrations/index.js';

export const LINE_NUMBER_SQL=`
ALTER TABLE platform_lines ADD COLUMN IF NOT EXISTS line_number varchar(50);
CREATE UNIQUE INDEX IF NOT EXISTS platform_line_number_unique ON platform_lines(lower(line_number)) WHERE line_number IS NOT NULL;
ALTER TABLE platform_lines ADD CONSTRAINT platform_line_number_valid CHECK (
 line_number IS NULL OR (line_number ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$')
);`;

export const lineNumberMigration:MigrationDefinition={
 id:'platform-line-number-expand',title:'Administrator maintained line numbers',ownerTaskId:'PLATFORM-L3-002',
 phase:'expand',layer:'L3',dataRows:['DATA-002'],migrationRows:['MIG-LINE-NUMBER'],
 sourceTables:[],targetTables:['platform_lines'],dependsOn:['platform-location-directory-expand'],
 recoveryNotes:'Additive nullable line number; existing line IDs, internal codes and station relations remain unchanged.',
 async run({client}){await client.query(LINE_NUMBER_SQL);},
};
