import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { compileAppMigration, APP_MIGRATION_FILE_MAX_BYTES } from '../src/app-platform/storage/index.ts';
import type { AppDeclarativeMigration, AppMigrationOperation } from '@metro/platform-sdk/app-manifest';

const schema = 'app_' + 'a'.repeat(32);
const create: AppMigrationOperation = { kind: 'createTable', table: 'records', columns: [
  { name: 'id', type: 'uuid', nullable: false },
  { name: 'title', type: 'text', nullable: false },
], primaryKey: ['id'] };
const document = (operations: AppMigrationOperation[]): AppDeclarativeMigration => ({ migrationVersion: '1.0', operations });
const compile = (operations: AppMigrationOperation[]) => compileAppMigration(JSON.stringify(document(operations)), schema);

test('declarative compiler emits frozen deterministic qualified SQL for all supported operations', () => {
  const statements = compile([create,
    { kind: 'addColumn', table: 'records', column: { name: 'note', type: 'text', nullable: true } },
    { kind: 'createIndex', table: 'records', name: 'records_title_idx', columns: ['title'], unique: true },
  ]);
  assert.deepEqual(statements, [
    `CREATE TABLE "${schema}"."records" ("id" pg_catalog.uuid NOT NULL, "title" pg_catalog.text NOT NULL, PRIMARY KEY ("id"));`,
    `ALTER TABLE "${schema}"."records" ADD COLUMN "note" pg_catalog.text;`,
    `CREATE UNIQUE INDEX "records_title_idx" ON "${schema}"."records" ("title");`,
  ]);
  assert.ok(Object.isFrozen(statements));
  assert.throws(() => (statements as string[]).push('SELECT 1'), TypeError);
});

test('strict migration shape rejects SQL knobs, prototypes, wrong versions and malformed JSON without echoing content', () => {
  const value = document([create]);
  for (const invalid of [
    'COMMIT; DROP SCHEMA public CASCADE; password=secret', '{broken-secret',
    JSON.stringify({ ...value, migrationVersion: '2.0' }), JSON.stringify({ ...value, schema: 'public' }),
    JSON.stringify({ ...value, operations: [] }),
    JSON.stringify(value).replace(/}$/, ',"__proto__":{"polluted":true}}'),
    JSON.stringify({ ...value, operations: [{ ...create, sql: 'secret' }] }),
    JSON.stringify({ ...value, operations: [{ ...create, constructor: 'secret' }] }),
    JSON.stringify({ ...value, operations: [{ ...create, columns: [{ name: 'a', type: 'text', nullable: true, default: 'secret' }] }] }),
    JSON.stringify({ ...value, operations: [{ ...create, columns: [{ name: 'a', type: 'toString', nullable: true }] }] }),
    JSON.stringify({ ...value, operations: [{ kind: 'addColumn', table: 'records', column: { name: 'a', type: 'text', nullable: false } }] }),
    JSON.stringify({ ...value, operations: [{ kind: 'createIndex', table: 'records', name: 'idx', columns: ['title'], where: 'true' }] }),
    JSON.stringify({ ...value, operations: [{ kind: 'dropTable', table: 'records' }] }),
  ]) assert.throws(() => compileAppMigration(invalid, schema), /^AppStorageError: MIGRATION_INVALID_DECLARATION$/);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('identifiers, cross-schema targets, operation limits and duplicate declarations fail closed', () => {
  for (const name of ['public.records', 'a";COMMIT;--', 'pg_table', 'platform_secret', 'Uppercase', '中文', 'a'.repeat(64), '', '__proto__']) {
    assert.throws(() => compile([{ ...create, table: name }]), /MIGRATION_INVALID_DECLARATION/);
    assert.throws(() => compile([{ kind: 'createIndex', table: 'records', name, columns: ['id'] }]), /MIGRATION_INVALID_DECLARATION/);
    assert.throws(() => compile([{ kind: 'addColumn', table: 'records', column: { name, type: 'text', nullable: true } }]), /MIGRATION_INVALID_DECLARATION/);
  }
  for (const target of ['public', schema + '_owner', 'app_' + 'a'.repeat(31), 'app_' + 'A'.repeat(32), schema + ';']) {
    assert.throws(() => compileAppMigration(JSON.stringify(document([create])), target), /MIGRATION_INVALID_SCHEMA/);
  }
  const duplicateColumn = { name: 'id', type: 'uuid' as const, nullable: false };
  for (const operations of [
    [create, create],
    [{ ...create, columns: [duplicateColumn, duplicateColumn] }],
    [{ ...create, primaryKey: ['id', 'id'] }], [{ ...create, primaryKey: ['missing'] }],
    [{ ...create, columns: [{ ...duplicateColumn, nullable: true }] }],
    [{ ...create, columns: Array.from({ length: 65 }, (_, i) => ({ ...duplicateColumn, name: 'c' + i })) }],
    [create, { kind: 'addColumn' as const, table: 'records', column: { ...duplicateColumn, nullable: true as const } }],
    [{ kind: 'createIndex' as const, name: 'idx', table: 'records', columns: ['id', 'id'] }],
    [create, { kind: 'createIndex' as const, name: 'records', table: 'records', columns: ['id'] }],
    Array.from({ length: 65 }, (_, i) => ({ ...create, table: 't' + i })),
  ]) assert.throws(() => compile(operations), /MIGRATION_INVALID_DECLARATION/);
});

test('byte budget applies before parsing; exact limit and maximum allowed arrays compile', () => {
  const text = JSON.stringify(document([create]));
  assert.equal(compileAppMigration(text.padEnd(APP_MIGRATION_FILE_MAX_BYTES, ' '), schema).length, 1);
  assert.throws(() => compileAppMigration(text.padEnd(APP_MIGRATION_FILE_MAX_BYTES + 1, ' '), schema), /MIGRATION_SIZE_LIMIT/);
  assert.throws(() => compileAppMigration('中'.repeat(APP_MIGRATION_FILE_MAX_BYTES / 2), schema), /MIGRATION_SIZE_LIMIT/);
  assert.equal(compile(Array.from({ length: 64 }, (_, i) => ({ ...create, table: 't' + i }))).length, 64);
  assert.equal(compile([{ kind: 'createTable', table: 'wide', columns: Array.from({ length: 64 }, (_, i) => ({ name: 'c' + i, type: 'text', nullable: true })) }]).length, 1);
});

test('generated DDL executes under isolated owner role with all built-in types and rolls back conflicting batch', async () => {
  const db = new PGlite();
  try {
    await db.exec(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; CREATE ROLE migration_owner NOLOGIN;
      CREATE SCHEMA "${schema}" AUTHORIZATION migration_owner;
      CREATE SCHEMA other_app; CREATE TABLE other_app.secret(id int);`);
    const types = ['text', 'boolean', 'integer', 'bigint', 'uuid', 'date', 'timestamptz', 'jsonb'] as const;
    const statements = compile([
      { kind: 'createTable', table: 'typed', columns: types.map(type => ({ name: 'col_' + type, type, nullable: true })) },
      create,
      { kind: 'addColumn', table: 'records', column: { name: 'note', type: 'text', nullable: true } },
      { kind: 'createIndex', table: 'records', name: 'records_title_idx', columns: ['title'], unique: true },
    ]);
    // SET ROLE is a test fixture only, never a production execution strategy.
    await db.exec('BEGIN; SET LOCAL ROLE migration_owner; SET LOCAL search_path = pg_catalog;');
    for (const sql of statements) await db.exec(sql);
    await db.exec('COMMIT;');
    const rows = await db.query<{ table_schema: string; table_name: string }>("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
    assert.deepEqual(rows.rows.map(r => r.table_name), ['records', 'typed']);
    assert.equal((await db.query('SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2', [schema, 'records_title_idx'])).rows.length, 1);
    for (const forbidden of ['SELECT * FROM other_app.secret', 'CREATE TABLE public.escape(id int)']) {
      await db.exec('BEGIN; SET LOCAL ROLE migration_owner;');
      await assert.rejects(db.exec(forbidden), /permission denied/); await db.exec('ROLLBACK;');
    }
    await db.exec('BEGIN; SET LOCAL ROLE migration_owner;');
    const conflict = compile([{ ...create, table: 'temporary_result' }, create]);
    await db.exec(conflict[0]); await assert.rejects(db.exec(conflict[1]), /already exists/); await db.exec('ROLLBACK;');
    assert.equal((await db.query('SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=$2', [schema, 'temporary_result'])).rows.length, 0);
  } finally { await db.close(); }
});
