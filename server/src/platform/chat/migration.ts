import type {MigrationDefinition} from '../../core/migrations/index.js';
export const CHAT_SQL=`
CREATE TABLE platform_chat_sessions (
 id uuid PRIMARY KEY, person_id uuid NOT NULL REFERENCES platform_people(id),
 title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_chat_sessions_owner ON platform_chat_sessions(person_id,updated_at DESC);
CREATE TABLE platform_chat_turns (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES platform_chat_sessions(id),
 message text NOT NULL, status text NOT NULL CHECK(status IN ('running','completed','failed','cancelled','interrupted')),
 stage text NOT NULL, target text, access_key text, reply jsonb, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_chat_turns_session ON platform_chat_turns(session_id,created_at,id);
CREATE UNIQUE INDEX platform_chat_one_running ON platform_chat_turns(session_id) WHERE status='running';`;
export const chatMigration:MigrationDefinition={id:'platform-chat-expand',title:'Unified employee conversations',ownerTaskId:'PLATFORM-CHAT-001',phase:'expand',layer:'L3',dataRows:[],migrationRows:['MIG-CHAT'],sourceTables:[],targetTables:['platform_chat_sessions','platform_chat_turns'],dependsOn:['platform-people-directory-expand'],recoveryNotes:'Additive conversation storage; no business writes.',async run({client}){await client.query(CHAT_SQL);}};
