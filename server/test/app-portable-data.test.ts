import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { exportAppData, restoreAppData, type AppPortableClient } from '../src/app-platform/storage/portable-data.ts';
import { compileAppMigration } from '../src/app-platform/storage/declarative-migration.ts';
import type { ManagedAppStorage } from '../src/app-platform/storage/binding.ts';

const binding = (letter: string): ManagedAppStorage => {
  const schema = `app_${letter.repeat(32)}`;
  return { mode: 'managed', installationId: `${letter.repeat(8)}-${letter.repeat(4)}-${letter.repeat(4)}-${letter.repeat(4)}-${letter.repeat(12)}`,
    schema, ownerRole: `${schema}_owner`, runtimeRole: `${schema}_runtime`, appId: 'portable-demo', manifestDigest: 'a'.repeat(64) };
};
async function fixture(letter = 'a') {
  const db = new PGlite(); const b = binding(letter);
  await db.exec(`CREATE ROLE "${b.ownerRole}" NOLOGIN NOINHERIT; CREATE SCHEMA "${b.schema}" AUTHORIZATION "${b.ownerRole}"; SET SESSION AUTHORIZATION "${b.ownerRole}";`);
  // PGlite cannot authenticate TCP. SET SESSION AUTHORIZATION is fixture-only, production must independently connect.
  const client: AppPortableClient = { async query(text, values) {
    const r = await db.query<Record<string, unknown>>(text, values ? [...values] : undefined);
    return { rows: r.rows, command: text.split(' ')[0] };
  } };
  return { db, b, client };
}
const declaration = { migrationVersion: '1.0', operations: [
  { kind: 'createTable', table: 'records', columns: [
    { name: 'id', type: 'uuid', nullable: false },
    ...(['text', 'boolean', 'integer', 'bigint', 'date', 'timestamptz', 'jsonb'] as const).map(type => ({ name: `value_${type}`, type, nullable: true })),
  ], primaryKey: ['id'] },
  { kind: 'createIndex', table: 'records', name: 'records_integer_idx', columns: ['value_integer'], unique: true },
] };
async function create(client: AppPortableClient, b: ManagedAppStorage) {
  for (const sql of compileAppMigration(JSON.stringify(declaration), b.schema)) await client.query(sql);
}

test('portable snapshot roundtrips all eight types, indexes, PK, escaping and null without numeric loss', async () => {
  const a = await fixture('a'); const b = await fixture('b');
  try {
    await create(a.client, a.b);
    const input = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', "引号'\\\n;COMMIT; --", 'true', '2147483647', '9223372036854775807', '2026-09-11', '2026-09-11 16:12:23.123456+08', '{"n":9223372036854775807,"s":"中文"}'];
    await a.client.query(`INSERT INTO "${a.b.schema}".records VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, input);
    await a.client.query(`INSERT INTO "${a.b.schema}".records (id) VALUES($1)`, ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']);
    const text = await exportAppData(a.client, a.b);
    assert.ok(text.includes('9223372036854775807'));
    assert.deepEqual(await restoreAppData(b.client, b.b, text), { tables: 1, rows: 2 });
    const normalize = (s: string) => { const v = JSON.parse(s); v.tables[0].rows.sort((x: string[], y: string[]) => x[0].localeCompare(y[0])); return v; };
    assert.deepEqual(normalize(await exportAppData(b.client, b.b)), normalize(text));
    await assert.rejects(restoreAppData(b.client, b.b, text), /PORTABLE_TARGET_NOT_EMPTY/);
  } finally { await a.db.close(); await b.db.close(); }
});

test('restore rejects binding drift, malformed shape, names and budgets before query; never accepts raw SQL', async () => {
  let calls = 0; const client: AppPortableClient = { async query() { calls++; return { rows: [] }; } };
  const artifact = { formatVersion: '1.0', appId: 'portable-demo', manifestDigest: 'a'.repeat(64), tables: [] };
  for (const bad of [
    '{broken', JSON.stringify({ ...artifact, sql: 'COMMIT' }), JSON.stringify({ ...artifact, appId: 'another-app' }),
    JSON.stringify({ ...artifact, manifestDigest: 'b'.repeat(64) }),
    JSON.stringify({ ...artifact, tables: [{ name: 'public.secrets', columns: [{ name: 'id', type: 'text', nullable: true }], indexes: [], rows: [] }] }),
    JSON.stringify({ ...artifact, tables: [{ name: 'records', columns: [{ name: 'id', type: 'text', nullable: true }], indexes: [], rows: [['x'.repeat(1024 * 1024)]] }] }),
    ' '.repeat(16 * 1024 * 1024 + 1),
  ]) await assert.rejects(restoreAppData(client, binding('a'), bad), /PORTABLE_/);
  assert.equal(calls, 0);
});

test('export rejects unsupported structures instead of silently losing their semantics', async () => {
  for (const ddl of [
    'CREATE VIEW extra AS SELECT 1 AS a', 'CREATE TABLE extra(a text DEFAULT \'value\')',
    'CREATE TABLE extra(a int CHECK(a>0))', 'CREATE TABLE extra(a varchar(12))',
    'CREATE TABLE extra(a text); CREATE INDEX extra_idx ON extra(lower(a))',
    'CREATE TABLE extra(a text); CREATE INDEX extra_idx ON extra(a) WHERE a IS NOT NULL',
    'CREATE TABLE extra(a text); ALTER TABLE extra ENABLE ROW LEVEL SECURITY',
    'CREATE TYPE extra AS ENUM (\'x\')', 'CREATE TABLE extra(a text COLLATE "C")',
  ]) {
    const f = await fixture();
    try {
      await f.db.exec(`SET search_path="${f.b.schema}",pg_catalog; ${ddl}`);
      await assert.rejects(exportAppData(f.client, f.b), /PORTABLE_UNSUPPORTED_STRUCTURE/);
    } finally { await f.db.close(); }
  }
});

test('restore failure and final authorization failure roll back all created structures', async () => {
  const f = await fixture();
  const artifact = { formatVersion: '1.0', appId: f.b.appId, manifestDigest: f.b.manifestDigest, tables: [{
    name: 'records', columns: [{ name: 'id', type: 'integer', nullable: false }], primaryKey: ['id'], indexes: [], rows: [['1'], ['1']],
  }] };
  try {
    await assert.rejects(restoreAppData(f.client, f.b, JSON.stringify(artifact)), /PORTABLE_RESTORE_FAILED/);
    artifact.tables[0].rows = [['1']];
    await assert.rejects(restoreAppData(f.client, f.b, JSON.stringify(artifact), { beforeCommit: async () => { throw new Error('secret'); } }), /^AppStorageError: PORTABLE_RESTORE_FAILED$/);
    assert.deepEqual(await restoreAppData(f.client, f.b, JSON.stringify(artifact)), { tables: 1, rows: 1 });
  } finally { await f.db.close(); }
});

test('wrong owner/admin sessions rejected and lost COMMIT is uncertain, not replay-safe', async () => {
  const f = await fixture(); const admin = new PGlite();
  try {
    const adminClient: AppPortableClient = { async query(text, values) {
      return admin.query<Record<string, unknown>>(text, values ? [...values] : undefined);
    } };
    await assert.rejects(exportAppData(adminClient, f.b), /PORTABLE_INVALID_SESSION/);
    const client: AppPortableClient = { async query(text, values) {
      const r = await f.client.query(text, values);
      if (text === 'COMMIT') throw new Error('transport secret');
      return r;
    } };
    await assert.rejects(restoreAppData(client, f.b, JSON.stringify({ formatVersion: '1.0', appId: f.b.appId, manifestDigest: f.b.manifestDigest, tables: [] })), /^AppStorageError: RESTORE_UNCERTAIN$/);
  } finally { await f.db.close(); await admin.close(); }
});

test('export bounds row sizes and total row count without returning partial snapshots', async () => {
  const f = await fixture();
  try {
    await f.client.query(`CREATE TABLE "${f.b.schema}".records(value text)`);
    await f.client.query(`INSERT INTO "${f.b.schema}".records VALUES(repeat('x',1048577))`);
    await assert.rejects(exportAppData(f.client, f.b), /PORTABLE_SIZE_LIMIT/);
    await f.client.query(`TRUNCATE "${f.b.schema}".records`);
    await f.client.query(`INSERT INTO "${f.b.schema}".records SELECT 'x' FROM pg_catalog.generate_series(1,10001)`);
    await assert.rejects(exportAppData(f.client, f.b), /PORTABLE_SIZE_LIMIT/);
  } finally { await f.db.close(); }
});
