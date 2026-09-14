import { z } from 'zod';
import { AppStorageError, type ManagedAppStorage } from './binding.js';
import { compileAppMigration } from './declarative-migration.js';

/** This connection must already be independently authenticated as the installation owner. */
export interface AppPortableClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; command?: string }>;
}
export interface AppPortableHooks { beforeCommit?: () => Promise<void>; onRollbackConfirmed?: () => Promise<void> }
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROW_BYTES = 1024 * 1024;
const MAX_ROWS = 10_000;
const name = z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/)
  .refine(v => !v.startsWith('pg_') && !v.startsWith('platform_'));
const names = z.array(name).min(1).max(64).refine(v => new Set(v).size === v.length);
const types = z.enum(['text', 'boolean', 'integer', 'bigint', 'uuid', 'date', 'timestamptz', 'jsonb']);
const tableShape = z.object({ name, columns: z.array(z.object({ name, type: types, nullable: z.boolean() }).strict()).min(1).max(64),
  primaryKey: names.optional(), indexes: z.array(z.object({ name, columns: names, unique: z.boolean() }).strict()).max(64),
  rows: z.array(z.array(z.string().refine(v => !v.includes('\0')).nullable()).max(64)).max(MAX_ROWS),
}).strict();
const shape = z.object({ formatVersion: z.literal('1.0'), appId: z.string().min(1).max(128),
  manifestDigest: z.string().regex(/^[0-9a-f]{64}$/), tables: z.array(tableShape).max(64) }).strict();
type Portable = z.infer<typeof shape>;
type Table = Portable['tables'][number];
const quote = (v: string) => `"${v}"`;
const sqlTypes = { text: 'text', boolean: 'bool', integer: 'int4', bigint: 'int8', uuid: 'uuid', date: 'date', timestamptz: 'timestamptz', jsonb: 'jsonb' };
function fail(code = 'PORTABLE_UNSUPPORTED_STRUCTURE'): never { throw new AppStorageError(code); }

async function identity(client: AppPortableClient, b: Readonly<ManagedAppStorage>) {
  const suffix = b.installationId.replaceAll('-', '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.installationId)
    || b.mode !== 'managed' || b.schema !== `app_${suffix}` || b.ownerRole !== `${b.schema}_owner`
    || b.runtimeRole !== `${b.schema}_runtime` || !/^[0-9a-f]{64}$/.test(b.manifestDigest)) fail('PORTABLE_INVALID_BINDING');
  const { rows } = await client.query(`SELECT current_user AS current_user, session_user AS session_user,
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname=$1 AND n.nspowner=r.oid) AS owns_schema
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`, [b.schema]);
  const r = rows[0];
  if (rows.length !== 1 || !r || r.current_user !== b.ownerRole || r.session_user !== b.ownerRole || r.owns_schema !== true
    || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls', 'memberships'].some(k => r[k] !== false)) fail('PORTABLE_INVALID_SESSION');
}
function validate(value: unknown, b: Readonly<ManagedAppStorage>): Portable {
  const result = shape.safeParse(value);
  if (!result.success) fail('PORTABLE_INVALID_ARTIFACT');
  const data = result.data;
  if (data.appId !== b.appId || data.manifestDigest !== b.manifestDigest) fail('PORTABLE_BINDING_MISMATCH');
  const relations = new Set<string>(); let count = 0;
  for (const t of data.tables) {
    if (relations.has(t.name)) fail('PORTABLE_INVALID_ARTIFACT');
    relations.add(t.name);
    const cols = new Set(t.columns.map(c => c.name));
    if (cols.size !== t.columns.length || t.primaryKey?.some(n => !t.columns.some(c => c.name === n && !c.nullable))) fail('PORTABLE_INVALID_ARTIFACT');
    for (const idx of t.indexes) {
      if (relations.has(idx.name) || idx.columns.some(n => !cols.has(n))) fail('PORTABLE_INVALID_ARTIFACT');
      relations.add(idx.name);
    }
    for (const row of t.rows) {
      if (++count > MAX_ROWS || Buffer.byteLength(JSON.stringify(row)) > MAX_ROW_BYTES) fail('PORTABLE_SIZE_LIMIT');
      if (row.length !== t.columns.length || row.some((v, i) => v === null && !t.columns[i].nullable)) fail('PORTABLE_INVALID_ARTIFACT');
    }
    statements(t, b.schema); // Reuse the maintained declaration compiler, not another SQL grammar.
  }
  return data;
}
function statements(t: Table, schema: string) {
  const result = [...compileAppMigration(JSON.stringify({ migrationVersion: '1.0', operations: [{
    kind: 'createTable', table: t.name, columns: t.columns, ...(t.primaryKey ? { primaryKey: t.primaryKey } : {}),
  }] }), schema)];
  for (const idx of t.indexes) result.push(...compileAppMigration(JSON.stringify({ migrationVersion: '1.0',
    operations: [{ kind: 'createIndex', table: t.name, ...idx }] }), schema));
  return result;
}
async function begin(client: AppPortableClient, readOnly: boolean) {
  const result = await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
  if (result.command !== 'BEGIN') fail('PORTABLE_TRANSACTION_FAILED');
  await client.query('SET LOCAL search_path = pg_catalog');
  await client.query("SET LOCAL TimeZone = 'UTC'");
  await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
  await client.query('SET LOCAL statement_timeout = 30000');
  await client.query('SET LOCAL lock_timeout = 5000');
}
async function rollback(client: AppPortableClient) { try { await client.query('ROLLBACK'); } catch { /* Owner lifecycle closes and revokes this connection. */ } }

/** Consistent bounded snapshot. Unsupported objects fail closed rather than disappear from a backup. */
export async function exportAppData(client: AppPortableClient, input: Readonly<ManagedAppStorage>, hooks: AppPortableHooks = {}): Promise<string> {
  const b = Object.freeze({ ...input }); let began = false;
  try {
    await identity(client, b);
    began = true; await begin(client, true);
    const bad = await client.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND (c.relkind NOT IN ('r','i') OR c.relpersistence<>'p' OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity OR c.reloptions IS NOT NULL OR c.relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=$1 AND NOT (t.typtype='c' AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind='r'))
        AND NOT (t.typelem<>0 AND EXISTS(SELECT 1 FROM pg_catalog.pg_type e JOIN pg_catalog.pg_class c ON c.oid=e.typrelid WHERE e.oid=t.typelem AND c.relkind='r')))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid OR c.oid=i.inhparent JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)`, [b.schema]);
    if (bad.rows.length) fail();
    const tables = await client.query(`SELECT c.oid::text AS oid,c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname LIMIT 65`, [b.schema]);
    if (tables.rows.length > 64) fail('PORTABLE_SIZE_LIMIT');
    const data: Portable = { formatVersion: '1.0', appId: b.appId, manifestDigest: b.manifestDigest, tables: [] };
    let rowCount = 0; let estimatedBytes = Buffer.byteLength(JSON.stringify(data));
    for (const rel of tables.rows) {
      const oid = rel.oid; const tableName = String(rel.name);
      if (!name.safeParse(tableName).success) fail();
      const unsupported = await client.query(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=$1::oid AND (contype NOT IN ('p','n') OR condeferrable OR condeferred OR NOT convalidated))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=$1::oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=$1::oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
          WHERE a.attrelid=$1::oid AND a.attnum>0 AND (a.attisdropped OR a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atttypmod<>-1 OR a.attcollation<>t.typcollation))`, [oid]);
      if (unsupported.rows.length) fail();
      const cols = await client.query(`SELECT a.attname AS name, t.typname AS type, n.nspname AS namespace, NOT a.attnotnull AS nullable
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        WHERE a.attrelid=$1::oid AND a.attnum>0 ORDER BY a.attnum LIMIT 65`, [oid]);
      if (!cols.rows.length || cols.rows.length > 64) fail();
      const t: Table = { name: tableName, columns: cols.rows.map(c => {
        const type = Object.entries(sqlTypes).find(([, native]) => native === c.type)?.[0];
        if (c.namespace !== 'pg_catalog' || !type || !name.safeParse(c.name).success) fail();
        return { name: String(c.name), type: types.parse(type), nullable: c.nullable === true };
      }), indexes: [], rows: [] };
      const indexes = await client.query(`SELECT ci.relname AS name, i.indisprimary AS primary, i.indisunique AS unique,
        i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct
          AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts AND am.amname='btree'
          AND ci.reloptions IS NULL AND NOT EXISTS(SELECT 1 FROM unnest(i.indoption) x WHERE x<>0)
          AND NOT EXISTS(SELECT 1 FROM unnest(i.indclass) x JOIN pg_catalog.pg_opclass op ON op.oid=x JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace WHERE NOT op.opcdefault OR ns.nspname<>'pg_catalog')
          AND NOT EXISTS(SELECT 1 FROM unnest(i.indkey::int2[], i.indcollation::oid[]) k(attnum,coll) JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.coll<>a.attcollation) AS supported,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position) JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.position) AS columns
        FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ci.relam WHERE i.indrelid=$1::oid ORDER BY ci.relname LIMIT 66`, [oid]);
      if (indexes.rows.length > 65) fail('PORTABLE_SIZE_LIMIT');
      for (const idx of indexes.rows) {
        if (idx.supported !== true || !names.safeParse(idx.columns).success) fail();
        if (idx.primary === true) { if (t.primaryKey) fail(); t.primaryKey = idx.columns as string[]; }
        else { if (!name.safeParse(idx.name).success) fail(); t.indexes.push({ name: String(idx.name), columns: idx.columns as string[], unique: idx.unique === true }); }
      }
      estimatedBytes += Buffer.byteLength(JSON.stringify(t));
      // One row per fetch bounds transport allocation; the database checks row size before transferring it.
      const values = t.columns.map(c => `${quote(c.name)}::pg_catalog.text`).join(',');
      await client.query(`DECLARE portable_rows NO SCROLL CURSOR FOR SELECT CASE WHEN pg_catalog.octet_length(pg_catalog.to_json(ARRAY[${values}])::pg_catalog.text)<=${MAX_ROW_BYTES} THEN pg_catalog.to_json(ARRAY[${values}])::pg_catalog.text ELSE NULL END AS payload FROM ${quote(b.schema)}.${quote(t.name)}`);
      for (;;) {
        const batch = await client.query('FETCH FORWARD 1 FROM portable_rows');
        if (!batch.rows.length) break;
        const payload = batch.rows[0].payload;
        if (typeof payload !== 'string' || ++rowCount > MAX_ROWS) fail('PORTABLE_SIZE_LIMIT');
        estimatedBytes += Buffer.byteLength(payload) + 1;
        if (estimatedBytes > MAX_BYTES) fail('PORTABLE_SIZE_LIMIT');
        t.rows.push(JSON.parse(payload) as (string | null)[]);
      }
      await client.query('CLOSE portable_rows'); data.tables.push(t);
    }
    validate(data, b);
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_BYTES) fail('PORTABLE_SIZE_LIMIT');
    await hooks.beforeCommit?.();
    if ((await client.query('COMMIT')).command !== 'COMMIT') fail('PORTABLE_TRANSACTION_FAILED');
    return text;
  } catch (e) { if (began) await rollback(client); throw e instanceof AppStorageError ? e : new AppStorageError('PORTABLE_EXPORT_FAILED'); }
}

/** Restores only into an empty installation schema; never overwrites live data. */
export async function restoreAppData(client: AppPortableClient, input: Readonly<ManagedAppStorage>, text: string, hooks: AppPortableHooks = {}): Promise<{ tables: number; rows: number }> {
  const b = Object.freeze({ ...input }); let began = false; let commitSent = false;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) fail('PORTABLE_SIZE_LIMIT');
    let raw: unknown; try { raw = JSON.parse(text); } catch { fail('PORTABLE_INVALID_ARTIFACT'); }
    const data = validate(raw, b);
    await identity(client, b);
    began = true; await begin(client, false);
    const occupied = await client.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1)`, [b.schema]);
    if (occupied.rows.length) fail('PORTABLE_TARGET_NOT_EMPTY');
    let rows = 0;
    for (const t of data.tables) {
      for (const sql of statements(t, b.schema)) await client.query(sql);
      const parameters = t.columns.map((c, i) => `$${i + 1}::pg_catalog.${sqlTypes[c.type]}`).join(',');
      const insert = `INSERT INTO ${quote(b.schema)}.${quote(t.name)} (${t.columns.map(c => quote(c.name)).join(',')}) VALUES (${parameters})`;
      for (const row of t.rows) { await client.query(insert, row); rows++; }
    }
    await hooks.beforeCommit?.();
    commitSent = true;
    if ((await client.query('COMMIT')).command !== 'COMMIT') fail('RESTORE_UNCERTAIN');
    return { tables: data.tables.length, rows };
  } catch (e) {
    let confirmed = !began;
    if (began) { try { confirmed = (await client.query('ROLLBACK')).command === 'ROLLBACK'; } catch { confirmed = false; } }
    if (!commitSent && confirmed) await hooks.onRollbackConfirmed?.();
    if (commitSent) throw new AppStorageError('RESTORE_UNCERTAIN');
    throw e instanceof AppStorageError ? e : new AppStorageError('PORTABLE_RESTORE_FAILED');
  }
}
