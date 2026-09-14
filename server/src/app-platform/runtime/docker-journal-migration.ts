import type { MigrationDefinition } from '../../core/migrations/index.js';

export const APP_DOCKER_JOURNAL_SQL = `
CREATE TABLE IF NOT EXISTS platform_app_docker_dispatches (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES platform_app_installations(id) ON DELETE RESTRICT,
 sequence integer NOT NULL CHECK(sequence>0),
 operation_id uuid NOT NULL,
 registered_revision integer NOT NULL CHECK(registered_revision>0),
 app_id varchar(64) NOT NULL CHECK(app_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
 manifest_digest varchar(64) NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
 action varchar(8) NOT NULL CHECK(action IN ('create','start','stop','remove')),
 container_id varchar(64) CHECK(container_id ~ '^[0-9a-f]{64}$'),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=131072),
 approval jsonb NOT NULL CHECK(jsonb_typeof(approval)='object' AND octet_length(approval::text)<=131072),
 status varchar(16) NOT NULL CHECK(status IN ('dispatched','uncertain','confirmed')),
 observation jsonb,
 started_at timestamptz NOT NULL CHECK(isfinite(started_at)),
 updated_at timestamptz NOT NULL CHECK(isfinite(updated_at) AND updated_at>=started_at),
 UNIQUE(installation_id,sequence),
 CHECK((action='create' AND container_id IS NULL) OR (action<>'create' AND container_id IS NOT NULL)),
 CHECK((policy->'body'->'Labels'->>'afc.app.installation'=installation_id::text
   AND policy->'body'->'Labels'->>'afc.app.id'=app_id) IS TRUE),
 CHECK((status<>'confirmed' AND observation IS NULL) OR
   (status='confirmed' AND jsonb_typeof(observation)='object'
    AND observation->>'containerId' ~ '^[0-9a-f]{64}$'
    AND (container_id IS NULL OR observation->>'containerId'=container_id)
    AND observation->>'state'=CASE action WHEN 'create' THEN 'created' WHEN 'start' THEN 'running'
      WHEN 'stop' THEN 'stopped' WHEN 'remove' THEN 'absent' END) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_app_docker_one_blocker
 ON platform_app_docker_dispatches(installation_id) WHERE status IN ('dispatched','uncertain');
`;
export const APP_DOCKER_JOURNAL_MIGRATIONS: readonly MigrationDefinition[] = [{
 id: 'app-docker-journal-expand', title: 'Record durable application Docker dispatch intent and trusted observations',
 ownerTaskId: 'PLATFORM-L4-008', phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-048'],
 sourceTables: [], targetTables: ['platform_app_docker_dispatches'], dependsOn: ['app-registry-expand'],
 recoveryNotes: 'Preserve dispatch records; pending or uncertain work never expires or permits replay. Observations are trusted host attestations, not independent Docker proof.',
 async run(context) { await context.client.query(APP_DOCKER_JOURNAL_SQL); return { applied: true }; },
}];

/** Additive runtime contract; preserve every existing uncertain record. */
export const APP_DOCKER_REJECTION_SQL = `
ALTER TABLE platform_app_docker_dispatches DROP CONSTRAINT IF EXISTS platform_app_docker_dispatches_status_check;
ALTER TABLE platform_app_docker_dispatches ADD CONSTRAINT platform_app_docker_dispatches_status_check
 CHECK(status IN ('dispatched','uncertain','confirmed','rejected'));
ALTER TABLE platform_app_docker_dispatches DROP CONSTRAINT IF EXISTS platform_app_docker_rejected_create_check;
ALTER TABLE platform_app_docker_dispatches ADD CONSTRAINT platform_app_docker_rejected_create_check
 CHECK(status<>'rejected' OR (action='create' AND observation IS NULL));
`;
export const APP_DOCKER_REJECTION_MIGRATIONS: readonly MigrationDefinition[] = [{
 id: 'app-docker-rejection-expand', title: 'Retain definitive Docker create rejection outcomes',
 ownerTaskId: 'PLATFORM-L4-008', phase: 'expand', layer: 'L4', dataRows: [], migrationRows: ['MIG-054'],
 sourceTables: ['platform_app_docker_dispatches'], targetTables: ['platform_app_docker_dispatches'],
 dependsOn: ['app-docker-journal-expand'],
 recoveryNotes: 'No reinterpretation of historical uncertain dispatches. Rejection requires completed create/400 and verified absence during the original dispatch.',
 async run(context) { await context.client.query(APP_DOCKER_REJECTION_SQL); return { applied: true }; },
}];
