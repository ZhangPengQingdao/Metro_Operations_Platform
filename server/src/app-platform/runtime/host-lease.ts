import { createHash } from 'node:crypto';
import type { QueryableClient } from '../../core/database/index.js';

/** Fresh, already connected PostgreSQL session; never a pool or a shared/recycled client. */
export interface AppRuntimeLeaseClient extends QueryableClient {
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: () => void): unknown;
}
export interface AppRuntimeLease {
  readonly signal: AbortSignal;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}
export class AppRuntimeLeaseError extends Error {
  constructor(readonly code: 'INVALID_INSTALLATION_ID' | 'RUNTIME_LEASE_BUSY' | 'RUNTIME_LEASE_LOST' | 'RUNTIME_LEASE_CONNECTION_REUSED' | 'RUNTIME_LEASE_RELEASE_FAILED') {
    super(code);
    this.name = 'AppRuntimeLeaseError';
  }
}
const usedConnections = new WeakSet<object>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session ownership lasts until explicit teardown or connection loss, with no expiry.
 * Abort closes ingress; it does NOT prove containers or actual work have drained.
 * The controller must retain durable uncertainty and reconcile before replacement.
 */
export async function acquireAppRuntimeLease(options: {
  installationId: string;
  connect(): Promise<AppRuntimeLeaseClient>;
}): Promise<AppRuntimeLease> {
  if (typeof options.installationId !== 'string' || !uuid.test(options.installationId)) {
    throw new AppRuntimeLeaseError('INVALID_INSTALLATION_ID');
  }
  const key = createHash('sha256').update(`app-runtime:${options.installationId.toLowerCase()}`).digest().readBigInt64BE().toString();
  let connection: AppRuntimeLeaseClient;
  try { connection = await options.connect(); }
  catch { throw new AppRuntimeLeaseError('RUNTIME_LEASE_LOST'); }
  // PostgreSQL advisory locks are reentrant. Do not acquire twice on one session,
  // or close a borrowed session when rejecting an invalid provider.
  if (usedConnections.has(connection)) throw new AppRuntimeLeaseError('RUNTIME_LEASE_CONNECTION_REUSED');
  usedConnections.add(connection);
  const controller = new AbortController();
  const lose = () => controller.abort(new AppRuntimeLeaseError('RUNTIME_LEASE_LOST'));
  connection.on('error', lose);
  connection.on('end', lose);
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    lose();
    if (released) return Promise.resolve();
    if (releasing) return releasing;
    releasing = (async () => {
      try { await connection.end(); released = true; }
      catch { throw new AppRuntimeLeaseError('RUNTIME_LEASE_RELEASE_FAILED'); }
    })().finally(() => { releasing = undefined; });
    return releasing;
  };
  const assertHeld = async (): Promise<void> => {
    if (controller.signal.aborted) throw new AppRuntimeLeaseError('RUNTIME_LEASE_LOST');
    try {
      // Inspect ownership without pg_try_advisory_lock: checking must never
      // increment a reentrant acquisition count or silently reacquire a lost lock.
      const result = await connection.query(`SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory'
          AND pid = pg_catalog.pg_backend_pid() AND granted AND mode = 'ExclusiveLock'
          AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
          AND classid::bigint = (($1::bigint >> 32) & 4294967295::bigint)
          AND objid::bigint = ($1::bigint & 4294967295::bigint) AND objsubid = 1
      ) AS held`, [key]) as { rows?: { held?: unknown }[] };
      if (controller.signal.aborted || result.rows?.[0]?.held !== true) throw new Error();
    } catch {
      lose();
      throw new AppRuntimeLeaseError('RUNTIME_LEASE_LOST');
    }
  };
  try {
    const result = await connection.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]) as { rows?: { locked?: unknown }[] };
    if (controller.signal.aborted) throw new AppRuntimeLeaseError('RUNTIME_LEASE_LOST');
    if (result.rows?.[0]?.locked !== true) throw new AppRuntimeLeaseError('RUNTIME_LEASE_BUSY');
    await assertHeld();
    return Object.freeze({ signal: controller.signal, assertHeld, release });
  } catch (error) {
    await release();
    if (error instanceof AppRuntimeLeaseError) throw error;
    throw new AppRuntimeLeaseError('RUNTIME_LEASE_LOST');
  }
}
