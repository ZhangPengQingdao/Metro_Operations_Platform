import { drizzle } from 'drizzle-orm/node-postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient } from 'pg';
import { getCoreConfig } from '../config/index.js';

export type DatabaseStatus = 'unconfigured' | 'up' | 'down';
export type Database = ReturnType<typeof drizzle>;

export interface QueryableClient {
  query(queryText: string, values?: readonly unknown[]): Promise<unknown>;
}

export interface AtomicParticipant {
  readonly atomic?: { readonly client: QueryableClient } | { snapshot(): () => void };
}

const transactionContext = new AsyncLocalStorage<Map<QueryableClient, { failed: boolean; active: boolean }>>();
const atomicContext = new AsyncLocalStorage<{ boundaries: ReadonlySet<object>; failed: boolean; active: boolean }>();
const locks = new WeakMap<object, Promise<void>>();
const lockIds = new WeakMap<object, number>();
let nextLockId = 0;

async function exclusive<T>(key: object, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  locks.set(key, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

/** True only in this async call chain; useful when work requires an actual commit before external effects. */
export function hasActiveDatabaseTransaction(client: QueryableClient): boolean {
  return transactionContext.getStore()?.get(client)?.active === true;
}

/** One command, one dedicated database connection, or rollback-capable memory participants. */
export async function runAtomicOperation<T>(participants: readonly AtomicParticipant[], operation: () => Promise<T>): Promise<T> {
  const boundaries = [...new Set(participants.map((participant) => {
    if (!participant.atomic) throw new Error('ATOMIC_PARTICIPANT_REQUIRED');
    return participant.atomic;
  }))];
  if (!boundaries.length) throw new Error('ATOMIC_PARTICIPANT_REQUIRED');
  const databases = boundaries.filter((boundary) => 'client' in boundary);
  if (databases.length) {
    if (databases.length !== boundaries.length || databases.some((boundary) => boundary.client !== databases[0].client)) {
      throw new Error('ATOMIC_CONNECTION_MISMATCH');
    }
    return runDatabaseTransaction(databases[0].client, operation);
  }
  const ambient = atomicContext.getStore();
  if (transactionContext.getStore()?.size) throw new Error('ATOMIC_CONNECTION_MISMATCH');
  if (ambient) {
    if (!ambient.active) throw new Error('ATOMIC_CONTEXT_CLOSED');
    if (boundaries.some((boundary) => !ambient.boundaries.has(boundary))) throw new Error('ATOMIC_PARTICIPANT_MISMATCH');
    try { return await operation(); }
    catch (error) { ambient.failed = true; throw error; }
  }
  for (const boundary of boundaries) if (!lockIds.has(boundary)) lockIds.set(boundary, nextLockId++);
  boundaries.sort((left, right) => lockIds.get(left)! - lockIds.get(right)!);
  const execute = async (index: number): Promise<T> => {
    if (index < boundaries.length) return exclusive(boundaries[index], () => execute(index + 1));
    const rollback = boundaries.map((boundary) => {
      if ('client' in boundary) throw new Error('ATOMIC_CONNECTION_MISMATCH');
      return boundary.snapshot();
    });
    const state = { boundaries: new Set(boundaries), failed: false, active: true };
    return atomicContext.run(state, async () => {
      try {
        const result = await operation();
        if (state.failed) throw new Error('TRANSACTION_ABORTED');
        return result;
      }
      catch (error) { for (const restore of rollback.reverse()) restore(); throw error; }
      finally { state.active = false; }
    });
  };
  return execute(0);
}

export interface ReleasableClient extends QueryableClient {
  release(): void;
}

export interface ConnectablePool {
  connect(): Promise<ReleasableClient>;
}

export class DatabaseUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'DATABASE_UNAVAILABLE';

  constructor(message = '数据库未配置或不可用') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export class DatabaseQueryTimeoutError extends Error {
  readonly statusCode = 504;
  readonly code = 'DATABASE_QUERY_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`数据库操作超过 ${timeoutMs}ms`);
    this.name = 'DatabaseQueryTimeoutError';
  }
}

let pool: Pool | null = null;
let database: Database | null = null;

export function getDatabasePool(): Pool | null {
  const connectionString = getCoreConfig().database.url.reveal();

  if (!connectionString) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString
    });
  }

  return pool;
}

export function getDatabase(): Database | null {
  const currentPool = getDatabasePool();

  if (!currentPool) {
    return null;
  }

  if (!database) {
    database = drizzle(currentPool);
  }

  return database;
}

export async function checkDatabaseStatus(currentPool: ConnectablePool | null): Promise<DatabaseStatus> {
  if (!currentPool) {
    return 'unconfigured';
  }

  try {
    const client = await currentPool.connect();
    client.release();
    return 'up';
  } catch {
    return 'down';
  }
}

export async function getDatabaseStatus(): Promise<DatabaseStatus> {
  return checkDatabaseStatus(getDatabasePool());
}

export async function runWithDatabaseQueryTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Database query timeout must be a positive integer.');
  }

  const controller = new AbortController();
  const timeoutError = new DatabaseQueryTimeoutError(timeoutMs);
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runDatabaseTransaction<T>(
  client: QueryableClient,
  callback: (client: QueryableClient) => Promise<T>
): Promise<T> {
  if ('connect' in client && !('release' in client)) throw new Error('DEDICATED_TRANSACTION_CLIENT_REQUIRED');
  const ambient = transactionContext.getStore();
  const joined = ambient?.get(client);
  if (joined) {
    if (!joined.active) throw new Error('ATOMIC_CONTEXT_CLOSED');
    try { return await callback(client); }
    catch (error) { joined.failed = true; throw error; }
  }
  if (ambient?.size || atomicContext.getStore()) throw new Error('ATOMIC_CONNECTION_MISMATCH');
  return exclusive(client, async () => {
    await client.query('BEGIN');
    const state = { failed: false, active: true };
    try {
      const result = await transactionContext.run(new Map([[client, state]]), () => callback(client));
      state.active = false;
      if (state.failed) throw new Error('TRANSACTION_ABORTED');
      await client.query('COMMIT');
      return result;
    } catch (error) { state.active = false; await client.query('ROLLBACK'); throw error; }
  });
}

export async function withDatabaseTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const currentPool = getDatabasePool();

  if (!currentPool) {
    throw new DatabaseUnavailableError();
  }

  const client = await currentPool.connect();

  try {
    return await runDatabaseTransaction(client, callback as (client: QueryableClient) => Promise<T>);
  } finally {
    client.release();
  }
}

export async function runDatabaseAdvisoryLock<T>(
  client: QueryableClient,
  lockKey: number,
  callback: (client: QueryableClient) => Promise<T>
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
  return callback(client);
}

export async function withDatabaseAdvisoryLock<T>(
  lockKey: number,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withDatabaseTransaction(async (client) => {
    return runDatabaseAdvisoryLock(client, lockKey, callback as (client: QueryableClient) => Promise<T>);
  });
}
