import { createHash } from 'node:crypto';
import { Client, type ClientConfig } from 'pg';
import type { ManagedAppStorage } from './binding.js';
import { compileAppMigration, APP_MIGRATION_FILE_MAX_BYTES } from './declarative-migration.js';
import type { AppMigrationExecutionRequest, AppRestrictedMigrationDriver } from './migration-executor.js';
import type { AppMigrationOutcome } from './migration-ledger.js';
import type { AppMigrationTransactionEvidence } from './migration-receipts.js';

export interface AppMigrationDriverHooks {
  onTransaction(request: AppMigrationExecutionRequest, evidence: AppMigrationTransactionEvidence): Promise<void>;
  beforeCommit?(request: AppMigrationExecutionRequest): Promise<void>;
}

export interface AppMigrationCredentials {
  host: string; port: number; database: string; user: string; password: string;
  ssl: false | { rejectUnauthorized: true; ca?: string };
}
/** Platform-owned credential broker, never an application-provided connection or URL. */
export type AppMigrationCredentialProvider = (binding: Readonly<ManagedAppStorage>) => Promise<AppMigrationCredentials>;
export interface AppMigrationDriverOptions { statementTimeoutMs?: number; lockTimeoutMs?: number }
export interface AppMigrationPgClient {
  connect(): Promise<unknown>;
  query(text: string, values?: string[]): Promise<{ command: string; rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export type AppMigrationClientConfig = ClientConfig & { replication: 'false' };
/** Trusted constructor seam for transport fault tests only. */
export type AppMigrationClientFactory = (config: AppMigrationClientConfig) => AppMigrationPgClient;

const identitySql = `SELECT session_user AS session_user, current_user AS current_user,
  r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
  EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid) AS memberships,
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = $1 AND n.nspowner = r.oid) AS owns_schema
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const timeout = (value: number | undefined, fallback: number, max: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('INVALID_DRIVER_TIMEOUT');
  return result;
};

/** Executes compiler output on one separately authenticated connection. No role leasing or startup wiring. */
export class PostgresAppMigrationDriver implements AppRestrictedMigrationDriver {
  constructor(private readonly credentials: AppMigrationCredentialProvider,
    private readonly options: AppMigrationDriverOptions = {},
    private readonly createClient: AppMigrationClientFactory = config => new Client(config),
    private readonly hooks?: AppMigrationDriverHooks) {}

  async execute(input: AppMigrationExecutionRequest): Promise<AppMigrationOutcome> {
    let client: AppMigrationPgClient | undefined;
    let began = false; let commitSent = false; let transportFailed = false;
    let outcome: AppMigrationOutcome = 'rolled_back';
    try {
      // Snapshot before awaiting any trusted provider; independently regenerate every executable statement.
      const request = { ...input, binding: Object.freeze({ ...input.binding }), step: { ...input.step } };
      const b = request.binding; const s = request.step;
      if (!uuid.test(b.installationId) || !uuid.test(request.attemptId) || b.mode !== 'managed'
        || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(b.appId) || !/^[0-9a-f]{64}$/.test(b.manifestDigest)
        || !Number.isSafeInteger(request.revision) || request.revision < 1
        || !Number.isInteger(request.ordinal) || request.ordinal < 0 || request.ordinal > 127) throw new Error('INVALID_REQUEST');
      const schema = `app_${b.installationId.replaceAll('-', '')}`;
      if (b.schema !== schema || b.ownerRole !== `${schema}_owner` || b.runtimeRole !== `${schema}_runtime`) throw new Error('INVALID_BINDING');
      if (typeof s.declarationJson !== 'string' || !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.bytes > APP_MIGRATION_FILE_MAX_BYTES
        || Buffer.byteLength(s.declarationJson, 'utf8') !== s.bytes
        || s.declarationJson.startsWith('\ufeff') || s.declarationJson.includes('\0')) throw new Error('INVALID_ARTIFACT');
      const bytes = Buffer.from(s.declarationJson, 'utf8');
      if (bytes.length !== s.bytes || bytes.toString('utf8') !== s.declarationJson
        || createHash('sha256').update(bytes).digest('hex') !== s.sha256) throw new Error('INVALID_ARTIFACT');
      const statements = compileAppMigration(s.declarationJson, schema);
      if (statements.join('\n') !== s.sql) throw new Error('INVALID_GENERATED_SQL');
      const statementMs = timeout(this.options.statementTimeoutMs, 30_000, 300_000);
      const lockMs = timeout(this.options.lockTimeoutMs, 5_000, 60_000);
      const c = await this.credentials(b);
      if (![c.host, c.database, c.user, c.password].every(validString) || c.host.startsWith('/')
        || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || c.user !== b.ownerRole) throw new Error('INVALID_CREDENTIALS');
      const loopback = c.host === '127.0.0.1' || c.host === '::1';
      if (c.ssl === false ? !loopback : !c.ssl || c.ssl.rejectUnauthorized !== true
        || (c.ssl.ca !== undefined && !validString(c.ssl.ca))) throw new Error('TLS_REQUIRED');
      const config: AppMigrationClientConfig = {
        host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
        ssl: c.ssl === false ? false : { rejectUnauthorized: true, ...(c.ssl.ca ? { ca: c.ssl.ca } : {}) },
        connectionTimeoutMillis: 5000, application_name: 'app-migration',
        options: '-c search_path=pg_catalog', client_encoding: 'UTF8', replication: 'false',
        statement_timeout: statementMs, lock_timeout: lockMs, idle_in_transaction_session_timeout: statementMs,
        keepAlive: true, keepAliveInitialDelayMillis: 1000,
      };
      client = this.createClient(config);
      client.on('error', () => { transportFailed = true; });
      await client.connect();
      const identity = await client.query(identitySql, [schema]);
      const row = identity.rows[0];
      if (identity.rows.length !== 1 || !row || row.session_user !== b.ownerRole || row.current_user !== b.ownerRole
        || row.owns_schema !== true || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls', 'memberships'].some(key => row[key] !== false)) throw new Error('INVALID_SESSION');
      const begin = await client.query('BEGIN');
      if (begin.command !== 'BEGIN') throw new Error('BEGIN_NOT_CONFIRMED');
      began = true;
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query(`SET LOCAL statement_timeout = ${statementMs}`);
      await client.query(`SET LOCAL lock_timeout = ${lockMs}`);
      if (this.hooks) {
        const evidence = (await client.query('SELECT pg_current_xact_id()::text AS xid, current_database() AS database')).rows[0];
        if (!evidence || typeof evidence.xid !== 'string' || typeof evidence.database !== 'string') throw new Error('INVALID_TRANSACTION_EVIDENCE');
        await this.hooks.onTransaction(request, {xid:evidence.xid,database:evidence.database});
      }
      for (const statement of statements) {
        if (transportFailed) throw new Error('TRANSPORT_FAILED');
        await client.query(statement);
      }
      if (transportFailed) throw new Error('TRANSPORT_FAILED');
      await this.hooks?.beforeCommit?.(request);
      if (transportFailed) throw new Error('TRANSPORT_FAILED');
      commitSent = true;
      const commit = await client.query('COMMIT');
      outcome = commit.command === 'COMMIT' && !transportFailed ? 'applied' : 'uncertain';
    } catch {
      // No source/provider/server error text escapes. COMMIT transport loss can never prove rollback.
      if (commitSent) outcome = 'uncertain';
      else if (began && client) {
        try { outcome = (await client.query('ROLLBACK')).command === 'ROLLBACK' && !transportFailed ? 'rolled_back' : 'uncertain'; }
        catch { outcome = 'uncertain'; }
      }
    } finally {
      if (client) {
        try { await client.end(); } catch { outcome = 'uncertain'; }
        if (transportFailed) outcome = 'uncertain';
      }
    }
    return outcome;
  }
}
