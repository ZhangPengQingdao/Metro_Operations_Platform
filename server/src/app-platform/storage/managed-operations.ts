import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { QueryableClient } from '../../core/database/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import {recoverRuntimeStorageLease} from './runtime-evidence.js';
import { AppStorageService } from './index.js';
import { AppStorageError, binding, manage, type ManagedAppStorage } from './binding.js';
import type { AppMigrationCredentials } from './postgres-migration-driver.js';

/** Already-connected fresh platform session. Never reuse concurrently or return it to a pool. */
export interface ManagedAppAdminClient extends QueryableClient {
 end(): Promise<void>;
 on?(event: 'error', listener: (error: Error) => void): unknown;
}
export interface ManagedAppOperationsOptions {
 connectAdmin(): Promise<ManagedAppAdminClient>;
 registry(client: QueryableClient): Pick<AppRegistryService, 'get'>;
 endpoint: Omit<AppMigrationCredentials, 'user' | 'password'>;
 leaseSeconds?: number;
}
export interface ManagedAppLockedScope {
 readonly client: QueryableClient;
 readonly registry: Pick<AppRegistryService, 'get'>;
 readonly storage: AppStorageService;
 readonly binding: Readonly<ManagedAppStorage>;
 revalidate(): Promise<void>;
 /** Trusted internal callback only. Do not return credentials or allow arbitrary application callbacks. */
 withOwner<T>(callback: (credentials: AppMigrationCredentials, binding: Readonly<ManagedAppStorage>) => Promise<T>, options?: { allowRetained?: boolean }): Promise<T>;
}

/** Session lock spans owner LOGIN, restricted work and confirmed cleanup; no app SQL runs here. */
export class ManagedAppOperations {
 private readonly seconds: number;
 private readonly endpoint: ManagedAppOperationsOptions['endpoint'];
 constructor(private readonly options: ManagedAppOperationsOptions) {
  this.seconds = options.leaseSeconds ?? 300;
  this.endpoint = structuredClone(options.endpoint);
  if (!Number.isInteger(this.seconds) || this.seconds < 5 || this.seconds > 900) throw new AppStorageError('INVALID_LEASE_DURATION');
  const e = this.endpoint;
  if (![e.host,e.database].every(x => typeof x === 'string' && x.trim() && !x.includes('\0'))
   || e.host.startsWith('/') || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535
   || (e.ssl === false ? !['127.0.0.1','::1'].includes(e.host) : !e.ssl || e.ssl.rejectUnauthorized !== true)) throw new AppStorageError('INVALID_STORAGE_ENDPOINT');
 }

 async withLock<T>(context: PlatformManagementContext, appId: string, revision: number, callback: (scope: ManagedAppLockedScope) => Promise<T>): Promise<T> {
  let connection: ManagedAppAdminClient | undefined;
  try {
   await manage(context);
   if (!Number.isSafeInteger(revision) || revision < 1) throw new AppStorageError('STALE_REVISION');
   connection = await this.options.connectAdmin();
   // Dedicated pg sessions emit asynchronous transport errors while the owner works.
   // Subsequent admin operations still fail closed; never log the raw transport error.
   connection.on?.('error', () => undefined);
   // Query-only wrapper keeps Core transactions tied to this session, never a pool/connectable object.
   const client: QueryableClient = { query: (sql, values) => connection!.query(sql, values) };
   // Registry and ledger own public tables; app schemas are never on this path.
   await client.query('SET search_path = pg_catalog, public');
   await client.query("SET lock_timeout = '30s'");
   const [{ database }] = await rows<{database: string}>(client, 'SELECT current_database() AS database');
   if (database !== this.endpoint.database) throw new AppStorageError('STORAGE_DATABASE_MISMATCH');
   const registry = this.options.registry(client);
   const record = await registry.get(context, appId);
   const b = binding(record);
   if (b.mode !== 'managed') throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');
   const plan = Object.freeze(b);
   await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`app-storage:${plan.installationId}`]);
   const revalidate = async () => {
    await manage(context);
    const current = await registry.get(context, appId);
    if (current.revision !== revision || !isDeepStrictEqual(binding(current),plan)) throw new AppStorageError('STALE_REVISION');
   };
   await revalidate();
   await this.recoverLocked(client, plan);
   const storage = new AppStorageService(registry,client);
   let ownerActive = false; let scopeActive = true; let pendingOwner: Promise<unknown> | undefined;
   const scope: ManagedAppLockedScope = Object.freeze({ client, registry, storage, binding: plan,
    revalidate: async () => { if (!scopeActive) throw new AppStorageError('STORAGE_SCOPE_CLOSED'); await revalidate(); },
    withOwner: <R>(work: (credentials: AppMigrationCredentials, binding: Readonly<ManagedAppStorage>) => Promise<R>, options?: { allowRetained?: boolean }) => {
     const operation = async () => {
     if (!scopeActive || ownerActive) throw new AppStorageError('STORAGE_OWNER_BUSY');
     ownerActive = true;
     try {
      await revalidate();
      if (options?.allowRetained) await storage.assertExportReady(context,appId);
      else await storage.assertReady(context,appId);
      const leaseId = randomUUID();
      const password = randomBytes(32).toString('base64url');
      const verifier = scram(password);
      // Durable record precedes LOGIN, including its ambiguous-acknowledgement failure window.
      await client.query(`INSERT INTO public.platform_app_storage_leases
       (id,installation_id,owner_role,registered_revision,status,expires_at)
       VALUES ($1,$2,$3,$4,'active',clock_timestamp()+$5::integer*interval '1 second')`,
       [leaseId,plan.installationId,plan.ownerRole,revision,this.seconds]);
      try {
       const [{ expiry }] = await rows<{expiry:string}>(client,
        "SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' AS expiry FROM public.platform_app_storage_leases WHERE id=$1",[leaseId]);
       if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/.test(expiry)) throw new AppStorageError('INVALID_LEASE_EXPIRY');
       // Only generated SCRAM verifier reaches SQL logs; plaintext password stays in local callback memory.
       await client.query(`ALTER ROLE "${plan.ownerRole}" LOGIN PASSWORD '${verifier}' VALID UNTIL '${expiry}'`);
       await revalidate();
       return await work({ ...structuredClone(this.endpoint),user:plan.ownerRole,password }, plan);
      } finally { await this.recoverLocked(client,plan); }
     } finally { ownerActive = false; }
     };
     if (!scopeActive || ownerActive) return Promise.reject(new AppStorageError('STORAGE_OWNER_BUSY'));
     const result = operation();
     pendingOwner = result;
     // Keep a handler attached even if a trusted caller forgets to await its work.
     void result.catch(() => undefined);
     return result;
    },
   });
   try { return await callback(scope); }
   finally { scopeActive = false; await pendingOwner; }
  } catch (error) {
   throw error instanceof AppStorageError ? error : new AppStorageError('STORAGE_OPERATION_FAILED');
  } finally {
   // Closing dedicated session releases advisory lock, even if cleanup failed. Durable lease blocks readiness.
   if (connection) try { await connection.end(); } catch { throw new AppStorageError('STORAGE_SESSION_CLOSE_FAILED'); }
  }
 }

 withOwner<T>(context: PlatformManagementContext, appId: string, revision: number,
  callback: (credentials: AppMigrationCredentials, binding: Readonly<ManagedAppStorage>, client: QueryableClient) => Promise<T>, options?: { allowRetained?: boolean }) {
  return this.withLock(context,appId,revision,scope => scope.withOwner((credentials,b) => callback(credentials,b,scope.client), options));
 }
 provision(context: PlatformManagementContext, appId: string, revision: number) {
  return this.withLock(context,appId,revision,scope => scope.storage.provision(context,appId));
 }
 preserve(context: PlatformManagementContext, appId: string, revision: number) {
  return this.withLock(context,appId,revision,scope => scope.storage.preserve(context,appId));
 }
 recover(context: PlatformManagementContext, appId: string, revision: number) {
  return this.withLock(context,appId,revision,async () => ({ recovered: true as const }));
 }

 private async recoverLocked(client: QueryableClient, plan: Readonly<ManagedAppStorage>) {
  await recoverRuntimeStorageLease(client,plan);
  const leases = await rows<{id:string;owner_role:string}>(client,
   "SELECT id,owner_role FROM public.platform_app_storage_leases WHERE installation_id=$1 AND status='active'",[plan.installationId]);
  if (!leases.length) return;
  if (leases.length !== 1 || leases[0].owner_role !== plan.ownerRole) throw new AppStorageError('STORAGE_LEASE_BINDING_CONFLICT');
  try {
   // Session lock proves previous platform holder is gone. Expiry alone is never used as proof.
   await client.query(`ALTER ROLE "${plan.ownerRole}" NOLOGIN PASSWORD NULL`);
   const terminated = await rows<{stopped:boolean}>(client,
    'SELECT pg_catalog.pg_terminate_backend(pid,5000) AS stopped FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND pid<>pg_catalog.pg_backend_pid()',[plan.ownerRole]);
   if (terminated.some(row => row.stopped !== true)) throw new Error('NOT_STOPPED');
   const remaining = await rows(client,'SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1',[plan.ownerRole]);
   if (remaining.length) throw new Error('SESSIONS_REMAIN');
   const roles = await rows<{rolcanlogin:boolean;rolpassword:string|null}>(client,
    'SELECT rolcanlogin,rolpassword FROM pg_catalog.pg_authid WHERE rolname=$1',[plan.ownerRole]);
   if (roles.length !== 1 || roles[0].rolcanlogin || roles[0].rolpassword !== null) throw new Error('ROLE_NOT_REVOKED');
   await client.query("UPDATE public.platform_app_storage_leases SET status='released',released_at=clock_timestamp() WHERE id=$1 AND status='active'",[leases[0].id]);
  } catch { throw new AppStorageError('STORAGE_LEASE_CLEANUP_REQUIRED'); }
 }
}

export function scram(password: string) {
 const salt = randomBytes(16); const iterations = 4096;
 const salted = pbkdf2Sync(password,salt,iterations,32,'sha256');
 const clientKey = createHmac('sha256',salted).update('Client Key').digest();
 const stored = createHash('sha256').update(clientKey).digest('base64');
 const server = createHmac('sha256',salted).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}
async function rows<T = Record<string,unknown>>(client: QueryableClient,sql: string,values?: readonly unknown[]): Promise<T[]> {
 return (await client.query(sql,values) as {rows:T[]}).rows;
}
