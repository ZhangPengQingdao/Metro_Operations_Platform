import { z } from 'zod';
import type { AppDeclarativeMigration, AppMigrationColumn, AppMigrationColumnType } from '@metro/platform-sdk/app-manifest';
import { AppStorageError } from './binding.js';

export const APP_MIGRATION_FILE_MAX_BYTES = 1_048_576;
const identifier = z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/)
  .refine(value => !value.startsWith('pg_') && !value.startsWith('platform_'));
const columnType = z.enum(['text', 'boolean', 'integer', 'bigint', 'uuid', 'date', 'timestamptz', 'jsonb']);
const column = z.object({ name: identifier, type: columnType, nullable: z.boolean() }).strict();
const names = z.array(identifier).min(1).max(64).refine(values => new Set(values).size === values.length);
const declaration = z.object({ migrationVersion: z.literal('1.0'), operations: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('createTable'), table: identifier, columns: z.array(column).min(1).max(64), primaryKey: names.optional() }).strict(),
  z.object({ kind: z.literal('addColumn'), table: identifier, column: column.extend({ nullable: z.literal(true) }) }).strict(),
  z.object({ kind: z.literal('createIndex'), table: identifier, name: identifier, columns: names, unique: z.boolean().optional() }).strict(),
])).min(1).max(64) }).strict();
const types: Record<AppMigrationColumnType, string> = { text: 'text', boolean: 'bool', integer: 'int4', bigint: 'int8', uuid: 'uuid', date: 'date', timestamptz: 'timestamptz', jsonb: 'jsonb' };
const quote = (name: string) => `"${name}"`; // Every input is validated before generation.
const field = (value: AppMigrationColumn) => `${quote(value.name)} pg_catalog.${types[value.type]}${value.nullable ? '' : ' NOT NULL'}`;

/** Pure strict JSON compiler. SQL is generated, never passed through from an application. */
export function compileAppMigration(text: string, schema: string): readonly string[] {
  if (!/^app_[0-9a-f]{32}$/.test(schema)) throw new AppStorageError('MIGRATION_INVALID_SCHEMA');
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > APP_MIGRATION_FILE_MAX_BYTES) throw new AppStorageError('MIGRATION_SIZE_LIMIT');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AppStorageError('MIGRATION_INVALID_DECLARATION'); }
  const result = declaration.safeParse(value);
  if (!result.success) throw new AppStorageError('MIGRATION_INVALID_DECLARATION');
  const parsed = result.data as AppDeclarativeMigration;
  const relations = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const statements: string[] = [];
  const invalid = () => { throw new AppStorageError('MIGRATION_INVALID_DECLARATION'); };
  for (const op of parsed.operations) {
    const table = `${quote(schema)}.${quote(op.table)}`;
    if (op.kind === 'createTable') {
      if (relations.has(op.table) || columns.has(op.table)) invalid();
      relations.add(op.table);
      const seen = new Set(op.columns.map(c => c.name));
      if (seen.size !== op.columns.length || op.primaryKey?.some(name => !op.columns.some(c => c.name === name && !c.nullable))) invalid();
      columns.set(op.table, seen);
      const fields = op.columns.map(field);
      if (op.primaryKey) fields.push(`PRIMARY KEY (${op.primaryKey.map(quote).join(', ')})`);
      statements.push(`CREATE TABLE ${table} (${fields.join(', ')});`);
    } else if (op.kind === 'addColumn') {
      const seen = columns.get(op.table) ?? new Set<string>();
      if (seen.has(op.column.name)) invalid();
      seen.add(op.column.name); columns.set(op.table, seen);
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${field(op.column)};`);
    } else {
      if (relations.has(op.name)) invalid();
      relations.add(op.name);
      // Existing tables/columns from earlier artifacts are checked by PostgreSQL, not guessed here.
      statements.push(`CREATE ${op.unique ? 'UNIQUE ' : ''}INDEX ${quote(op.name)} ON ${table} (${op.columns.map(quote).join(', ')});`);
    }
  }
  return Object.freeze(statements);
}
