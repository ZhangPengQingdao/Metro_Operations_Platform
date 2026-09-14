import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { binding, manage, AppStorageError, type AppStorageBinding, type ManagedAppStorage } from './binding.js';
export { AppStorageError, type AppStorageBinding, type ManagedAppStorage } from './binding.js';
export * from './migration-plan.js';
export { compileAppMigration } from './declarative-migration.js';
export * from './migration-ledger.js';
export * from './ledger-migration.js';
export * from './migration-executor.js';
export * from './postgres-migration-driver.js';
export * from './managed-operations.js';
export * from './lease-migration.js';
export * from './migration-receipts.js';
export * from './receipt-migration.js';
export * from './portable-data.js';
export * from './managed-storage.js';
export * from './lifecycle-evidence.js';

/** Trusted platform management only. Never expose this connection to application SQL. */
export class AppStorageService {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>, private readonly client: QueryableClient) {}

  async describe(context: PlatformManagementContext, appId: string): Promise<AppStorageBinding> {
    return binding(await this.registry.get(context, appId));
  }

  /** Read-only admission snapshot, not a lock spanning application execution. */
  async assertReady(context: PlatformManagementContext, appId: string): Promise<ManagedAppStorage> {
    await manage(context);
    const plan = await this.describe(context, appId);
    if (plan.mode !== 'managed') throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');
    return runDatabaseTransaction(this.client, async () => {
      await this.lock(plan);
      if (!await this.existing(plan)) throw new AppStorageError('STORAGE_NOT_PROVISIONED');
      await this.prerequisites();
      await this.inspect(plan, 'active');
      return Object.freeze(plan);
    });
  }

  /** Read-only export admission; retained data does not regain runtime privileges. */
  async assertExportReady(context: PlatformManagementContext, appId: string): Promise<ManagedAppStorage> {
    await manage(context);
    const plan = await this.describe(context, appId);
    if (plan.mode !== 'managed') throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');
    return runDatabaseTransaction(this.client, async () => {
      await this.lock(plan);
      if (!await this.existing(plan)) throw new AppStorageError('STORAGE_NOT_PROVISIONED');
      await this.prerequisites();
      await this.inspect(plan, await this.state(plan));
      return Object.freeze(plan);
    });
  }

  async provision(context: PlatformManagementContext, appId: string): Promise<AppStorageBinding> {
    await manage(context);
    const plan = await this.describe(context, appId);
    if (plan.mode !== 'managed') return plan;
    return runDatabaseTransaction(this.client, async () => {
      await this.lock(plan);
      await this.prerequisites();
      const existing = await this.existing(plan);
      if (existing) {
        await this.inspect(plan, 'active');
        return plan;
      }
      for (const role of [plan.ownerRole, plan.runtimeRole]) {
        await this.client.query(`CREATE ROLE ${q(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      }
      await this.client.query(`CREATE SCHEMA ${q(plan.schema)} AUTHORIZATION ${q(plan.ownerRole)}`);
      await this.client.query(`REVOKE ALL ON SCHEMA ${q(plan.schema)} FROM PUBLIC`);
      await this.client.query(`GRANT USAGE ON SCHEMA ${q(plan.schema)} TO ${q(plan.runtimeRole)}`);
      await this.defaults(plan, false);
      await this.mark(plan, 'active');
      await this.inspect(plan, 'active');
      return plan;
    });
  }

  /** Retain schema/data. Terminal for this slice: reactivation needs an explicit later lifecycle policy. */
  async preserve(context: PlatformManagementContext, appId: string): Promise<AppStorageBinding> {
    await manage(context);
    const plan = await this.describe(context, appId);
    if (plan.mode !== 'managed') return plan;
    return runDatabaseTransaction(this.client, async () => {
      await this.lock(plan);
      if (!await this.existing(plan)) throw new AppStorageError('STORAGE_NOT_PROVISIONED');
      await this.prerequisites();
      const state = await this.state(plan);
      await this.inspect(plan, state);
      if (state === 'retained') return plan;
      await this.client.query(`REVOKE ALL ON SCHEMA ${q(plan.schema)} FROM ${q(plan.runtimeRole)}`);
      await this.client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${q(plan.schema)} FROM ${q(plan.runtimeRole)}`);
      await this.client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q(plan.schema)} FROM ${q(plan.runtimeRole)}`);
      await this.defaults(plan, true);
      await this.mark(plan, 'retained');
      await this.inspect(plan, 'retained');
      return plan;
    });
  }

  /** Trusted locked lifecycle composition only; never adopts an unrelated schema. */
  async transitionBinding(context: PlatformManagementContext, appId: string, previous: Readonly<ManagedAppStorage>) {
    await manage(context);
    const next = await this.describe(context, appId);
    if (next.mode !== 'managed' || next.installationId !== previous.installationId
      || next.appId !== previous.appId || next.schema !== previous.schema || next.ownerRole !== previous.ownerRole
      || next.runtimeRole !== previous.runtimeRole) throw new AppStorageError('STORAGE_BINDING_CONFLICT');
    return runDatabaseTransaction(this.client, async () => {
      await this.lock(next);
      await this.prerequisites();
      await this.inspect(previous, 'active');
      await this.mark(next, 'active');
      await this.inspect(next, 'active');
      return next;
    });
  }

  private async lock(plan: ManagedAppStorage) {
    await this.client.query('SET LOCAL search_path = pg_catalog');
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`app-storage:${plan.installationId}`]);
  }
  private async existing(plan: ManagedAppStorage) {
    const [row] = await rows<{ schemas: number; roles: number }>(this.client,
      'SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname=$1) AS schemas, (SELECT count(*)::int FROM pg_roles WHERE rolname IN ($2,$3)) AS roles',
      [plan.schema, plan.ownerRole, plan.runtimeRole]);
    if (row.schemas === 0 && row.roles === 0) return false;
    if (row.schemas !== 1 || row.roles !== 2) throw new AppStorageError('STORAGE_OBJECT_CONFLICT');
    return true;
  }
  private async defaults(plan: ManagedAppStorage, revoke: boolean) {
    const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(plan.ownerRole)} IN SCHEMA ${q(plan.schema)}`;
    // Functions are executable by PUBLIC by default; schema-local REVOKE cannot override global defaults.
    await this.client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(plan.ownerRole)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    await this.client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${q(plan.ownerRole)} REVOKE USAGE ON TYPES FROM PUBLIC`);
    await this.client.query(`${prefix} ${revoke ? 'REVOKE ALL' : 'GRANT SELECT, INSERT, UPDATE, DELETE'} ON TABLES ${revoke ? 'FROM' : 'TO'} ${q(plan.runtimeRole)}`);
    await this.client.query(`${prefix} ${revoke ? 'REVOKE ALL' : 'GRANT USAGE, SELECT'} ON SEQUENCES ${revoke ? 'FROM' : 'TO'} ${q(plan.runtimeRole)}`);
  }
  private async mark(plan: ManagedAppStorage, state: 'active' | 'retained') {
    // All interpolated identifiers/marker fields derive from validated platform records, never app SQL.
    await this.client.query(`COMMENT ON SCHEMA ${q(plan.schema)} IS '${marker(plan, state)}'`);
  }
  private async state(plan: ManagedAppStorage): Promise<'active' | 'retained'> {
    const [row] = await rows<{ comment: string | null }>(this.client, 'SELECT obj_description(oid, \'pg_namespace\') AS comment FROM pg_namespace WHERE nspname=$1', [plan.schema]);
    if (row?.comment === marker(plan, 'active')) return 'active';
    if (row?.comment === marker(plan, 'retained')) return 'retained';
    throw new AppStorageError('STORAGE_BINDING_CONFLICT');
  }
  private async prerequisites() {
    // Do not "repair" unrelated ACLs. Database administration must establish these prerequisites.
    await rejectIf(this.client, `SELECT 1 FROM pg_largeobject_metadata l,
      LATERAL aclexplode(coalesce(l.lomacl,acldefault('L',l.lomowner))) a
      WHERE a.grantee=0`, [], 'UNSAFE_PUBLIC_LARGE_OBJECT_PRIVILEGES');
    await rejectIf(this.client, `SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(col.attacl) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND a.grantee=0`, [], 'UNSAFE_PUBLIC_COLUMN_PRIVILEGES');
    await rejectIf(this.client, `SELECT 1 FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type IN ('CREATE','TEMPORARY')`, [], 'UNSAFE_PUBLIC_DATABASE_PRIVILEGES');
    await rejectIf(this.client, `SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname <> 'information_schema' AND a.grantee=0 AND a.privilege_type='CREATE'`, [], 'UNSAFE_PUBLIC_SCHEMA_PRIVILEGES');
    await rejectIf(this.client, `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND a.grantee=0`, [], 'UNSAFE_PUBLIC_OBJECT_PRIVILEGES');
    await rejectIf(this.client, `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND a.grantee=0`, [], 'UNSAFE_PUBLIC_FUNCTION_PRIVILEGES');
  }
  private async inspect(plan: ManagedAppStorage, expected: 'active' | 'retained') {
    if (await this.state(plan) !== expected) throw new AppStorageError('STORAGE_RETAINED');
    // Large objects have no schema binding; this slice grants no access or ownership to them.
    await rejectIf(this.client, `SELECT 1 FROM pg_largeobject_metadata l WHERE
      l.lomowner IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2)) OR EXISTS
      (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2)))`, [plan.ownerRole,plan.runtimeRole]);
    // Column ACLs are independent of relacl. No extra column grants are part of the binding contract.
    await rejectIf(this.client, `SELECT 1 FROM pg_attribute col JOIN pg_class c ON c.oid=col.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(col.attacl) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND
      ((n.nspname=$1 AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2)) OR
      (n.nspname<>$1 AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3))))`, [plan.schema,plan.ownerRole,plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_roles WHERE rolname IN ($1,$2) AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)`, [plan.ownerRole, plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2))
      OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ($1,$2))`, [plan.ownerRole, plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_roles r WHERE r.rolname IN ($1,$2) AND
      (has_database_privilege(r.oid,current_database(),'CREATE') OR has_database_privilege(r.oid,current_database(),'TEMPORARY'))`, [plan.ownerRole, plan.runtimeRole]);
    // This slice exposes no callable app functions. Explicit function grants cannot evade the table checks.
    await rejectIf(this.client, `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND
      ((n.nspname=$1 AND (p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR a.grantee<>p.proowner))
      OR (n.nspname<>$1 AND (a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3))
      OR p.proowner IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3)))))`, [plan.schema,plan.ownerRole,plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_namespace WHERE nspname=$1 AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=$2)`, [plan.schema, plan.ownerRole]);
    const [usage] = await rows<{ usage: boolean; create: boolean }>(this.client,
      "SELECT has_schema_privilege($1,$2,'USAGE') AS usage,has_schema_privilege($1,$2,'CREATE') AS create", [plan.runtimeRole, plan.schema]);
    if (usage.usage !== (expected === 'active') || usage.create) throw new AppStorageError('STORAGE_ACL_DRIFT');
    await rejectIf(this.client, `SELECT 1 FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname=$1 AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2)
      AND NOT (a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$3) AND a.privilege_type='USAGE' AND NOT a.is_grantable)`, [plan.schema, plan.ownerRole, plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
      AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=$2)`, [plan.schema, plan.ownerRole]);
    if (expected==='active') await rejectIf(this.client, `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
      AND ((c.relkind IN ('r','p','v','m','f') AND NOT (has_table_privilege($2,c.oid,'SELECT') AND has_table_privilege($2,c.oid,'INSERT')
      AND has_table_privilege($2,c.oid,'UPDATE') AND has_table_privilege($2,c.oid,'DELETE')))
      OR (c.relkind='S' AND NOT (has_sequence_privilege($2,c.oid,'USAGE') AND has_sequence_privilege($2,c.oid,'SELECT'))))`, [plan.schema,plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE n.nspname=$1 AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) AND NOT
      (a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$3) AND NOT a.is_grantable AND
      (($4='active' AND c.relkind='S' AND a.privilege_type IN ('USAGE','SELECT')) OR
      ($4='active' AND c.relkind<>'S' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))))`, [plan.schema, plan.ownerRole, plan.runtimeRole, expected]);
    // Membership-free roles must also lack explicitly granted privileges outside their binding.
    await rejectIf(this.client, `SELECT 1 FROM pg_namespace n WHERE n.nspname<>$1 AND left(n.nspname,3)<>'pg_'
      AND n.nspname<>'information_schema' AND (n.nspowner IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3))
      OR has_schema_privilege($3,n.oid,'CREATE') OR has_schema_privilege($2,n.oid,'CREATE'))`, [plan.schema, plan.ownerRole, plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE n.nspname<>$1 AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
      AND (a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3)) OR c.relowner IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3)))`, [plan.schema, plan.ownerRole, plan.runtimeRole]);
    await rejectIf(this.client, `SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole IN (SELECT oid FROM pg_roles WHERE rolname IN ($2,$3))
      AND a.grantee<>d.defaclrole AND NOT (d.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)
      AND d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$2) AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$3)
      AND NOT a.is_grantable AND $4='active' AND ((d.defaclobjtype='r' AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
      OR (d.defaclobjtype='S' AND a.privilege_type IN ('USAGE','SELECT'))))`, [plan.schema, plan.ownerRole, plan.runtimeRole, expected]);
    const [defaults] = await rows<{ count: number; globals: number }>(this.client, `SELECT
      (SELECT count(*)::int FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
       WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$2) AND d.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)
       AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$3)) AS count,
      (SELECT count(*)::int FROM pg_default_acl d WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$2)
       AND d.defaclnamespace=0 AND d.defaclobjtype IN ('f','T')) AS globals`, [plan.schema,plan.ownerRole,plan.runtimeRole]);
    if (defaults.count !== (expected==='active' ? 6 : 0) || defaults.globals !== 2) throw new AppStorageError('STORAGE_ACL_DRIFT');
  }
}

function q(identifier: string) { return `"${identifier}"`; }
function marker(plan: ManagedAppStorage, state: string) { return `app-storage:1:${plan.installationId}:${plan.appId}:${plan.manifestDigest}:${state}`; }
async function rows<T>(client: QueryableClient, sql: string, values: readonly unknown[]): Promise<T[]> {
  const result = await client.query(sql, values) as { rows: T[] };
  return result.rows;
}
async function rejectIf(client: QueryableClient, sql: string, values: readonly unknown[], code = 'STORAGE_ACL_DRIFT') {
  if ((await rows(client, sql, values)).length) throw new AppStorageError(code);
}
