import type {MigrationDefinition} from '../../migrations/index.js';

export const MODEL_CONFIGURATION_REQUESTS_SQL = `
CREATE TABLE IF NOT EXISTS model_configuration_requests (
 request_id uuid PRIMARY KEY,
 salt text NOT NULL,
 digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);`;

export const modelConfigurationMigration:MigrationDefinition={
 id:'platform-model-configuration-expand',title:'Model configuration request idempotency',
 ownerTaskId:'PLATFORM-MODEL-001',phase:'expand',layer:'L1',dataRows:[],
 migrationRows:['MIG-MODEL-CONFIG'],sourceTables:[],targetTables:['model_configuration_requests'],
 dependsOn:['platform-settings-expand'],recoveryNotes:'Additive request records only; existing model configurations are unchanged.',
 async run({client}){await client.query(MODEL_CONFIGURATION_REQUESTS_SQL);},
};
