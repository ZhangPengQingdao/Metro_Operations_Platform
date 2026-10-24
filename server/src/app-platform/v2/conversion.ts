import { createHash } from 'node:crypto';
import type { AppManifestIssueV2 } from '@metro/platform-sdk/manifest';
import type { QueryableClient } from '../../core/database/index.js';
import { appSchemaName } from './migration.js';

export class AppConversionError extends Error {
  constructor(readonly code: string, readonly issues: AppManifestIssueV2[] = []) { super(code); this.name = 'AppConversionError'; }
}
const rows = async <T>(client: QueryableClient, sql: string, values?: readonly unknown[]) => ((await client.query(sql, values)) as { rows: T[] }).rows;
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * Converts the storage of a stopped v1 installation (run inside the installer's transaction):
 * 1. v1 bookkeeping must be settled (no running/uncertain migration, no dispatched write);
 * 2. each applied v1 migration must equal, byte for byte, the package migration at the same position;
 * 3. the API role takes ownership of the schema and its tables so v2 can read, write and migrate;
 * 4. the applied migrations are recorded in `platform_app_v2_migrations`, so only newer ones run.
 * Returns how many package migrations were adopted from v1.
 */
export async function adoptV1Storage(client: QueryableClient, installationId: string, migrations: readonly { id: string; file: string; text: string }[]): Promise<number> {
  const [unsettled] = await rows<{ count: string }>(client, "SELECT count(*)::text AS count FROM platform_app_migration_attempts WHERE installation_id=$1 AND status IN ('running','uncertain')", [installationId]);
  if (Number(unsettled?.count) > 0) throw new AppConversionError('V1_MIGRATION_UNSETTLED', [{ path: 'migrations', message: '旧版存储有未完成或结果未知的迁移，请先在应用状态中核对处理' }]);
  const [writes] = await rows<{ count: string | null }>(client, "SELECT CASE WHEN to_regclass('platform_app_runtime_storage_writes') IS NULL THEN '0' ELSE (SELECT count(*)::text FROM platform_app_runtime_storage_writes WHERE installation_id=$1 AND status='dispatched') END AS count", [installationId]);
  if (Number(writes?.count) > 0) throw new AppConversionError('V1_WRITES_UNSETTLED', [{ path: 'data', message: '旧版存储有结果未确认的写入，请先在应用状态中核对处理' }]);

  const applied = await rows<{ ordinal: number; migration_id: string; artifact_sha256: string }>(client,
    "SELECT ordinal,migration_id,artifact_sha256 FROM platform_app_migration_attempts WHERE installation_id=$1 AND status='applied' ORDER BY ordinal", [installationId]);
  const issues: AppManifestIssueV2[] = [];
  applied.forEach((row, index) => {
    const declared = migrations[index];
    const digest = declared ? createHash('sha256').update(declared.text).digest('hex') : null;
    if (row.ordinal !== index) issues.push({ path: 'migrations', message: `旧版迁移记录不连续（第 ${index + 1} 项）` });
    else if (!declared) issues.push({ path: 'migrations', message: `旧版已执行迁移 ${row.migration_id}，安装包缺少对应的第 ${index + 1} 个迁移文件` });
    else if (digest !== row.artifact_sha256) issues.push({ path: declared.file, message: `与旧版已执行的迁移 ${row.migration_id} 内容不一致，请原样复制旧迁移文件` });
  });
  if (issues.length) throw new AppConversionError('MIGRATION_HISTORY_CHANGED', issues);

  const schema = appSchemaName(installationId);
  const [present] = await rows<{ owner: string; me: string } | undefined>(client, 'SELECT n.nspowner::regrole::text AS owner,current_user AS me FROM pg_catalog.pg_namespace n WHERE n.nspname=$1', [schema]);
  if (!present) {
    if (applied.length) throw new AppConversionError('V1_SCHEMA_MISSING', [{ path: schema, message: '旧版记录显示已执行迁移，但数据库中没有应用 schema' }]);
    return 0;
  }
  const tables = await rows<{ name: string; owner: string }>(client, "SELECT c.relname AS name,c.relowner::regrole::text AS owner FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','S')", [schema]);
  const owners = new Set([present.owner, ...tables.map(table => table.owner)].filter(owner => owner !== present.me));
  if (owners.size) {
    // Taking ownership needs membership in the old owner role (or superuser); a DBA can do it once with REASSIGN OWNED.
    await client.query('SAVEPOINT mop_adopt_schema');
    try {
      if (present.owner !== present.me) await client.query(`ALTER SCHEMA ${ident(schema)} OWNER TO CURRENT_USER`);
      for (const table of tables) if (table.owner !== present.me) await client.query(`ALTER TABLE ${ident(schema)}.${ident(table.name)} OWNER TO CURRENT_USER`);
      await client.query('RELEASE SAVEPOINT mop_adopt_schema');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT mop_adopt_schema');
      throw new AppConversionError('SCHEMA_ADOPTION_REQUIRED', [...owners].map(owner => ({ path: schema, message: `请数据库管理员执行：REASSIGN OWNED BY ${ident(owner)} TO ${ident(present.me)};` })));
    }
  }
  for (const [index] of applied.entries()) {
    const migration = migrations[index]!;
    await client.query('INSERT INTO platform_app_v2_migrations(installation_id,migration_id,sha256) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [installationId, migration.id, createHash('sha256').update(migration.text).digest('hex')]);
  }
  return applied.length;
}
