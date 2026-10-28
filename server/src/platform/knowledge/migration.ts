import type { MigrationDefinition } from '../../core/migrations/index.js';

export const KNOWLEDGE_SQL = `
CREATE TABLE IF NOT EXISTS platform_knowledge_entries (
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  library_id text NOT NULL,
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  deleted boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id,library_id,organization_id,id)
);
CREATE TABLE IF NOT EXISTS platform_knowledge_requests (
  installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  request jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id,request_id)
);`;

export const knowledgeMigration: MigrationDefinition = {
  id: 'platform-knowledge-expand', title: 'Application knowledge libraries', ownerTaskId: 'PLATFORM-KNOWLEDGE-001',
  phase: 'expand', layer: 'L3', dataRows: [], migrationRows: ['MIG-KNOWLEDGE'], sourceTables: [],
  targetTables: ['platform_knowledge_entries','platform_knowledge_requests'], dependsOn: ['app-registry-expand','platform-authorization-expand'],
  recoveryNotes: 'Additive tables only; application corpus tables remain unchanged.',
  async run({client}) {
    await client.query(KNOWLEDGE_SQL);
    for (const [id,code,name] of [
      ['49000000-0000-4000-8000-000000000007','platform.knowledge.read','检索应用知识库'],
      ['49000000-0000-4000-8000-000000000008','platform.knowledge.write','维护应用知识库'],
    ]) await client.query(`INSERT INTO platform_permissions(id,code,name,description,status,created_at,updated_at)
      VALUES($1,$2,$3::text,$3::text,'active',now(),now()) ON CONFLICT(code) DO NOTHING`,[id,code,name]);
  },
};

export const KNOWLEDGE_VECTOR_SQL = `
ALTER TABLE platform_knowledge_entries ADD COLUMN embedding double precision[];
ALTER TABLE platform_knowledge_entries ADD COLUMN embedding_key text;
ALTER TABLE platform_knowledge_entries ADD COLUMN index_status text NOT NULL DEFAULT 'pending' CHECK(index_status IN ('pending','processing','ready','failed'));
ALTER TABLE platform_knowledge_entries ADD COLUMN index_version integer;
ALTER TABLE platform_knowledge_entries ADD COLUMN index_error text;
ALTER TABLE platform_knowledge_entries ADD COLUMN index_token uuid;
ALTER TABLE platform_knowledge_entries ADD COLUMN index_started_at timestamptz;
`;
export const knowledgeVectorMigration:MigrationDefinition={
  id:'platform-knowledge-vectors-expand',title:'Knowledge entry embeddings',ownerTaskId:'PLATFORM-KNOWLEDGE-003',
  phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-KNOWLEDGE-VECTORS'],sourceTables:[],
  targetTables:['platform_knowledge_entries'],dependsOn:['platform-knowledge-expand','platform-settings-expand'],
  recoveryNotes:'Additive columns; text retrieval remains available without an embedding model.',
  async run({client}){await client.query(KNOWLEDGE_VECTOR_SQL);},
};
