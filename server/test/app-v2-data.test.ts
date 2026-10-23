import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { APP_REGISTRY_SQL, type AppInstallation } from '../src/app-platform/registry/index.ts';
import { APP_V2_SQL, AppMigrationV2Error, appSchemaName, applyAppMigrationsV2 } from '../src/app-platform/v2/migration.ts';
import { AppDataServiceV2 } from '../src/app-platform/v2/data.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';

const initial = JSON.stringify({ migrationVersion: '1.0', operations: [
  { kind: 'createTable', table: 'records', primaryKey: ['id'], columns: [
    { name: 'id', type: 'uuid', nullable: false }, { name: 'title', type: 'text', nullable: false },
    { name: 'organization_id', type: 'uuid', nullable: false }, { name: 'tags', type: 'jsonb', nullable: true },
    { name: 'created_at', type: 'timestamptz', nullable: false }, { name: 'revision', type: 'integer', nullable: false },
  ] },
] });
const addNote = JSON.stringify({ migrationVersion: '1.0', operations: [{ kind: 'addColumn', table: 'records', column: { name: 'note', type: 'text', nullable: true } }] });

async function fixture() {
  const db = new PGlite();
  await db.exec(APP_REGISTRY_SQL); await db.exec(APP_V2_SQL);
  const id = randomUUID();
  const installation = { id, appId: 'fire-check', revision: 1, enabled: true, manifest: {}, grants: [], serviceIdentityId: randomUUID(), credentialDigest: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtime: { model: 'v2', sha256: 'a'.repeat(64), manifest: {} } } as unknown as AppInstallation & { credentialDigest: null };
  await db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)', [id, 'fire-check', JSON.stringify(installation)]);
  const client = { query: (sql: string, values?: readonly unknown[]) => db.query(sql, values ? [...values] : undefined), release() {} };
  let allowed = true;
  const context = { actorType: 'service', execution: { type: 'service', appId: 'fire-check', serviceIdentityId: installation.serviceIdentityId },
    authorize: async () => ({ allowed }) } as unknown as PlatformActorContext;
  const service = new AppDataServiceV2({ pool: { connect: async () => client }, findInstallation: async appId => appId === 'fire-check' ? installation : null });
  return { db, client, installation, context, service, deny: () => { allowed = false; } };
}
const signal = new AbortController().signal;

test('migrations create the app schema, apply in order and refuse changed history', async () => {
  const { db, client, installation } = await fixture();
  assert.deepEqual(await applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }]), ['001-initial']);
  assert.deepEqual(await applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }, { id: '002-note', text: addNote }]), ['002-note']);
  assert.deepEqual(await applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }, { id: '002-note', text: addNote }]), []);
  const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='records' ORDER BY ordinal_position`, [appSchemaName(installation.id)]);
  assert.deepEqual(columns.rows.map((row: any) => row.column_name), ['id', 'title', 'organization_id', 'tags', 'created_at', 'revision', 'note']);
  await assert.rejects(applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: addNote }]), (error: unknown) => error instanceof AppMigrationV2Error && error.code === 'MIGRATION_HISTORY_CHANGED');
  await assert.rejects(applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }]), { code: 'MIGRATION_HISTORY_CHANGED' });
});

test('data service writes atomically, replays requestIds and enforces optimistic checks', async () => {
  const { client, installation, context, service } = await fixture();
  await applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }]);
  const org = randomUUID(), a = randomUUID(), b = randomUUID(), requestId = randomUUID();
  const write = { requestId, operations: [
    { action: 'insert', table: 'records', id: a, values: { title: '一号', organization_id: org, tags: ['x'], created_at: '2026-10-01T08:00:00.000Z', revision: 1 } },
    { action: 'insert', table: 'records', id: b, values: { title: '二号', organization_id: org, tags: null, created_at: '2026-10-02T08:00:00.000Z', revision: 1 } },
  ] };
  const first = await service.execute(context, installation, 'transaction', write, signal) as any;
  assert.equal(first.results.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(await service.execute(context, installation, 'transaction', write, signal))), JSON.parse(JSON.stringify(first)), 'same requestId returns the first result');
  await assert.rejects(service.execute(context, installation, 'transaction', { ...write, operations: write.operations.slice(0, 1) }, signal), { code: 'REQUEST_ID_REUSED' });

  const got = await service.execute(context, installation, 'get', { table: 'records', id: a }, signal) as any;
  assert.deepEqual(got.row.tags, ['x']);
  const page = await service.execute(context, installation, 'list', { table: 'records', order: { column: 'created_at', direction: 'desc' }, pageSize: 1 }, signal) as any;
  assert.equal(page.rows[0].title, '二号'); assert.equal(page.nextCursor.id, b);
  const next = await service.execute(context, installation, 'list', { table: 'records', order: { column: 'created_at', direction: 'desc' }, pageSize: 1, after: page.nextCursor }, signal) as any;
  assert.equal(next.rows[0].title, '一号'); assert.equal(next.nextCursor, null);
  const batch = await service.execute(context, installation, 'read_batch', { operations: [{ kind: 'count', table: 'records', filters: [{ column: 'organization_id', value: org }] }, { table: 'records', ids: [a, b] }] }, signal) as any;
  assert.equal(batch.results[0].count, 2); assert.equal(batch.results[1].rows.length, 2);

  // A stale `expected` value fails the whole transaction; nothing is written.
  await assert.rejects(service.execute(context, installation, 'transaction', { requestId: randomUUID(), operations: [
    { action: 'update', table: 'records', id: a, values: { title: '改', revision: 2 }, expected: { revision: 1 } },
    { action: 'update', table: 'records', id: b, values: { title: '改', revision: 2 }, expected: { revision: 9 } },
  ] }, signal), { code: 'STORAGE_CONFLICT' });
  assert.equal((await service.execute(context, installation, 'get', { table: 'records', id: a }, signal) as any).row.title, '一号');
  await assert.rejects(service.execute(context, installation, 'transaction', { requestId: randomUUID(), operations: [{ action: 'insert', table: 'records', id: a, values: { title: 'dup', organization_id: org, created_at: '2026-10-01T08:00:00.000Z', revision: 1 } }] }, signal), { code: 'STORAGE_CONFLICT' });
});

test('data service rejects unknown columns, wrong types, other apps and missing grants', async () => {
  const { client, installation, context, service, deny } = await fixture();
  await applyAppMigrationsV2(client, installation.id, [{ id: '001-initial', text: initial }]);
  const insert = (values: Record<string, unknown>) => service.execute(context, installation, 'transaction', { requestId: randomUUID(), operations: [{ action: 'insert', table: 'records', id: randomUUID(), values }] }, signal);
  await assert.rejects(insert({ title: 'x', secret: 1 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(insert({ title: 1 }), { code: 'INVALID_PARAMS' });
  await assert.rejects(service.execute(context, installation, 'get', { table: 'missing', id: randomUUID() }, signal), { code: 'STORAGE_TABLE_UNSUPPORTED' });
  const operations = service.operations();
  const other = { ...context, execution: { type: 'service', appId: 'other-app', serviceIdentityId: randomUUID() } } as unknown as PlatformActorContext;
  await assert.rejects(operations.find(op => op.name === 'platform.app_data.get')!.execute(other, { table: 'records', id: randomUUID() }, signal), { code: 'ACCESS_DENIED' });
  deny();
  await assert.rejects(service.execute(context, installation, 'get', { table: 'records', id: randomUUID() }, signal), { code: 'ACCESS_DENIED' });
});
