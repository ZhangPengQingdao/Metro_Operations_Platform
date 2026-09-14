import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AppDockerJournal, type AppDockerDispatchInput } from '../src/app-platform/runtime/docker-journal.ts';
import { APP_DOCKER_JOURNAL_MIGRATIONS } from '../src/app-platform/runtime/docker-journal-migration.ts';
import { APP_REGISTRY_SQL } from '../src/app-platform/registry/migration.ts';
import { compileAppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';
import type { AppInstallation } from '../src/app-platform/registry/model.ts';
import { runDatabaseTransaction, type QueryableClient } from '../src/core/database/index.ts';

const id = 'a'.repeat(64);
async function fixture() {
 const db = new PGlite();
 const client: QueryableClient = { query: (sql, values) => values ? db.query(sql, [...values]) : db.exec(sql) };
 await db.exec(APP_REGISTRY_SQL);
 await APP_DOCKER_JOURNAL_MIGRATIONS[0].run({ client });
 await APP_DOCKER_JOURNAL_MIGRATIONS[0].run({ client });
 const operationId = randomUUID(), installationId = randomUUID(), now = '2026-09-13T01:00:00.000Z';
 const installation: AppInstallation = {
  id: installationId, appId: 'demo', revision: 1, enabled: false, serviceIdentityId: null, grants: [], createdAt: now, updatedAt: now,
  manifest: {
   manifestVersion: '1.0', id: 'demo', version: '1.0.0', name: 'Demo', description: 'Test backend', publisherId: 'example',
   compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
   permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
   backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
   storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
   network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
   artifacts: [{ id: 'main', kind: 'backend', path: 'main.js', sha256: 'b'.repeat(64), bytes: 1 }],
  },
 };
 const record = { ...installation, credentialDigest: null, lifecycle: { operationId, status: 'running' } };
 await db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)', [installationId, 'demo', JSON.stringify(record)]);
 const imageId = `sha256:${'c'.repeat(64)}`;
 const input: AppDockerDispatchInput = {
  installationId, operationId, registeredRevision: 1, appId: 'demo', manifestDigest: 'd'.repeat(64), action: 'create', containerId: null, expectedSequence: 0,
  policy: compileAppDockerPolicy({ installation, operationId, runtimeImage: `node@${imageId}`, verifiedBundlePath: '/var/lib/afc/bundle', network: 'none' }),
  approval: { imageId, config: { Env: ['PATH=/usr/bin'] } },
 };
 let time = now;
 const journal = new AppDockerJournal(client, () => new Date(time));
 return { db, client, input, journal, record, setTime(value: string) { time = value; } };
}
const confirmed = (state: 'created' | 'running' | 'stopped' | 'absent') => ({ status: 'confirmed' as const, observation: { containerId: id, state } });

test('fresh journal instance sees pending dispatch, time never permits replay, uncertain blocks until explicit confirmation', async () => {
 const f = await fixture();
 try {
  const attempt = await f.journal.reserve(f.input);
  assert.equal(attempt.sequence, 1); assert.equal(attempt.status, 'dispatched');
  const restarted = new AppDockerJournal(f.client);
  assert.deepEqual(await restarted.latest(f.input.installationId), attempt);
  f.setTime('2036-09-13T01:00:00.000Z');
  await assert.rejects(f.journal.reserve({ ...f.input, expectedSequence: 1 }), /DISPATCH_BLOCKED/);
  const uncertain = await f.journal.finish(f.input.installationId, attempt.id, 1, { status: 'uncertain' });
  assert.equal(uncertain.status, 'uncertain');
  await assert.rejects(restarted.reserve({ ...f.input, expectedSequence: 1 }), /DISPATCH_BLOCKED/);
  const done = await f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created'));
  assert.equal(done.status, 'confirmed');
  assert.deepEqual(await f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created')), done);
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 1, { status: 'uncertain' }), /TERMINAL_CONFLICT/);
  const second = await f.journal.reserve({ ...f.input, expectedSequence: 1, action: 'start', containerId: id });
  assert.equal(second.sequence, 2);
  const history = await f.db.query<{status:string}>('SELECT status FROM platform_app_docker_dispatches ORDER BY sequence');
  assert.deepEqual(history.rows.map(x => x.status), ['confirmed', 'dispatched']);
 } finally { await f.db.close(); }
});

test('concurrent reservation on shared dedicated connection permits only one and stale finish cannot touch latest', async () => {
 const f = await fixture();
 try {
  const competing = await Promise.allSettled([f.journal.reserve(f.input), new AppDockerJournal(f.client).reserve(f.input)]);
  assert.equal(competing.filter(x => x.status === 'fulfilled').length, 1);
  const attempt = (await f.journal.latest(f.input.installationId))!;
  await assert.rejects(f.journal.finish(f.input.installationId, randomUUID(), attempt.sequence, confirmed('created')), /STALE_ATTEMPT/);
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 2, confirmed('created')), /STALE_ATTEMPT/);
  await f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created'));
  await assert.rejects(f.journal.reserve({ ...f.input, action: 'start', containerId: id }), /STALE_SEQUENCE/);
  await f.journal.reserve({ ...f.input, expectedSequence: 1, action: 'start', containerId: id });
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created')), /STALE_ATTEMPT/);
 } finally { await f.db.close(); }
});

test('action observations and exact non-create IDs enforced; shutdown operation may differ from original creation', async () => {
 const f = await fixture();
 try {
  let attempt = await f.journal.reserve(f.input);
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('running')), /INVALID_OBSERVATION/);
  await f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created'));
  const shutdown = randomUUID();
  await f.db.query('UPDATE platform_app_installations SET record=jsonb_set(record,\'{lifecycle,operationId}\',$1::jsonb) WHERE id=$2', [JSON.stringify(shutdown), f.input.installationId]);
  attempt = await f.journal.reserve({ ...f.input, operationId: shutdown, action: 'stop', containerId: id, expectedSequence: 1 });
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 2, { status: 'confirmed', observation: { state: 'stopped', containerId: 'f'.repeat(64) } }), /INVALID_OBSERVATION/);
  await f.journal.finish(f.input.installationId, attempt.id, 2, confirmed('stopped'));
  attempt = await f.journal.reserve({ ...f.input, operationId: shutdown, action: 'remove', containerId: id, expectedSequence: 2 });
  await f.journal.finish(f.input.installationId, attempt.id, 3, confirmed('absent'));
 } finally { await f.db.close(); }
});

test('reservation requires disabled current registry revision, app and matching unresolved lifecycle', async () => {
 const f = await fixture();
 try {
  for (const change of [{ registeredRevision: 2 }, { operationId: randomUUID(), action: 'stop' as const, containerId: id }]) {
   await assert.rejects(f.journal.reserve({ ...f.input, ...change }), /REGISTRY_BINDING_MISMATCH/);
  }
  for (const record of [{ ...f.record, enabled: true }, { ...f.record, lifecycle: { ...f.record.lifecycle, status: 'completed' } }, { ...f.record, lifecycle: null }]) {
   await f.db.query('UPDATE platform_app_installations SET record=$1 WHERE id=$2', [JSON.stringify(record), f.input.installationId]);
   await assert.rejects(f.journal.reserve(f.input), /REGISTRY_BINDING_MISMATCH/);
  }
  assert.equal(await f.journal.latest(f.input.installationId), null);
 } finally { await f.db.close(); }
});

test('snapshots are taken before waiting on database; input validation and clock regression preserve blocker', async () => {
 const f = await fixture();
 try {
  const work = f.journal.reserve(f.input);
  f.input.approval.config.Env = ['PATH=/changed'];
  const attempt = await work;
  assert.deepEqual(attempt.approval.config.Env, ['PATH=/usr/bin']);
  f.setTime('2020-01-01T00:00:00Z');
  await assert.rejects(f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created')), /CLOCK_REGRESSION/);
  assert.equal((await f.journal.latest(f.input.installationId))?.status, 'dispatched');
  for (const changes of [{ installationId: 'invalid' }, { containerId: id }, { manifestDigest: 'short' }, { expectedSequence: -1 }, { approval: { ...f.input.approval, config: { text: 'x'.repeat(65536) } } }]) {
   await assert.rejects(f.journal.reserve({ ...f.input, ...changes }), /INVALID_INPUT/);
  }
 } finally { await f.db.close(); }
});

test('database constraints reject extra blocker, duplicate sequence, wrong observation and installation deletion', async () => {
 const f = await fixture();
 try {
  const attempt = await f.journal.reserve(f.input);
  await assert.rejects(f.db.query(`INSERT INTO platform_app_docker_dispatches
   SELECT $1,installation_id,sequence+1,operation_id,registered_revision,app_id,manifest_digest,action,container_id,policy,approval,status,observation,started_at,updated_at
   FROM platform_app_docker_dispatches WHERE id=$2`, [randomUUID(), attempt.id]));
  await assert.rejects(f.db.query(`UPDATE platform_app_docker_dispatches SET status='confirmed',observation='{"state":"running","containerId":"${id}"}' WHERE id=$1`, [attempt.id]));
  await assert.rejects(f.db.query("UPDATE platform_app_docker_dispatches SET status='confirmed',observation=NULL WHERE id=$1", [attempt.id]));
  await assert.rejects(f.db.query('DELETE FROM platform_app_installations WHERE id=$1', [f.input.installationId]));
  await f.journal.finish(f.input.installationId, attempt.id, 1, confirmed('created'));
  await assert.rejects(f.db.query(`INSERT INTO platform_app_docker_dispatches
   SELECT $1,installation_id,sequence,operation_id,registered_revision,app_id,manifest_digest,action,container_id,policy,approval,status,observation,started_at,updated_at
   FROM platform_app_docker_dispatches WHERE id=$2`, [randomUUID(), attempt.id]));
 } finally { await f.db.close(); }
});


test('reserve rejects outer transactions so dispatch never precedes durable commit', async () => {
 const f = await fixture();
 try {
  await assert.rejects(runDatabaseTransaction(f.client, () => f.journal.reserve(f.input)), /OUTER_TRANSACTION_FORBIDDEN/);
  assert.equal(await f.journal.latest(f.input.installationId), null);
 } finally { await f.db.close(); }
});

test('confirmed live container cannot be replaced or lose its identity and approved policy chain', async () => {
 const f = await fixture();
 try {
  const created = await f.journal.reserve(f.input);
  await f.journal.finish(f.input.installationId, created.id, 1, confirmed('created'));
  await assert.rejects(f.journal.reserve({ ...f.input, expectedSequence: 1 }), /LIVE_CONTAINER_EXISTS/);
  for (const change of [{ containerId: 'f'.repeat(64) }, { approval: { ...f.input.approval, config: { Env: [] } } }]) {
   await assert.rejects(f.journal.reserve({ ...f.input, expectedSequence: 1, action: 'start', containerId: id, ...change }), /CONTAINER_CHAIN_MISMATCH/);
  }
  const started = await f.journal.reserve({ ...f.input, expectedSequence: 1, action: 'start', containerId: id });
  await f.journal.finish(f.input.installationId, started.id, 2, confirmed('running'));
  for (const action of ['start', 'remove'] as const) {
   await assert.rejects(f.journal.reserve({ ...f.input, expectedSequence: 2, action, containerId: id }), /CONTAINER_CHAIN_MISMATCH/);
  }
  const stopped = await f.journal.reserve({ ...f.input, expectedSequence: 2, action: 'stop', containerId: id });
  await f.journal.finish(f.input.installationId, stopped.id, 3, confirmed('stopped'));
  const removed = await f.journal.reserve({ ...f.input, expectedSequence: 3, action: 'remove', containerId: id });
  await f.journal.finish(f.input.installationId, removed.id, 4, confirmed('absent'));
  await assert.rejects(f.journal.reserve({ ...f.input, expectedSequence: 4, action: 'stop', containerId: id }), /CONTAINER_CHAIN_MISMATCH/);
  assert.equal((await f.journal.reserve({ ...f.input, expectedSequence: 4 })).sequence, 5);
 } finally { await f.db.close(); }
});

test('lost commit acknowledgement preserves durable pending record and failed settlement cannot clear blocker', async () => {
 const f = await fixture();
 try {
  let loseCommit = true;
  const client: QueryableClient = { query: async (sql, values) => {
   const result = await f.client.query(sql, values);
   if (sql === 'COMMIT' && loseCommit) { loseCommit = false; throw new Error('lost commit acknowledgement'); }
   return result;
  } };
  const journal = new AppDockerJournal(client);
  await assert.rejects(journal.reserve(f.input), /lost commit acknowledgement/);
  const pending = (await new AppDockerJournal(f.client).latest(f.input.installationId))!;
  assert.equal(pending.status, 'dispatched');
  await assert.rejects(journal.reserve(f.input), /DISPATCH_BLOCKED/);
  const failing: QueryableClient = { query: async (sql, values) => {
   const result = await f.client.query(sql, values);
   if (sql.startsWith('UPDATE platform_app_docker_dispatches')) throw new Error('settlement interrupted');
   return result;
  } };
  await assert.rejects(new AppDockerJournal(failing).finish(f.input.installationId, pending.id, 1, confirmed('created')), /settlement interrupted/);
  assert.equal((await f.journal.latest(f.input.installationId))?.status, 'dispatched');
 } finally { await f.db.close(); }
});
