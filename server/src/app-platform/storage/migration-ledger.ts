import { acceptsMigrationDigest } from './lifecycle-evidence.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDatabaseTransaction, type QueryableClient } from '../../core/database/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { validateAppManifest } from '../manifest/index.js';
import { AppStorageError, binding, manage } from './binding.js';
import { APP_MIGRATION_FILE_MAX_BYTES, APP_MIGRATION_TOTAL_MAX_BYTES } from './migration-plan.js';

export type AppMigrationOutcome = 'applied' | 'rolled_back' | 'uncertain';
export interface AppMigrationAttempt {
  sequence: number; id: string; installationId: string; registeredRevision: number; manifestDigest: string;
  ordinal: number; migrationId: string; artifactId: string; artifactPath: string; artifactSha256: string;
  artifactBytes: number; status: 'running' | AppMigrationOutcome;
  startedAt: string; startedBy: string; finishedAt: string | null; finishedBy: string | null;
}
const columns = `sequence, id, installation_id AS "installationId", registered_revision AS "registeredRevision",
  manifest_digest AS "manifestDigest", ordinal, migration_id AS "migrationId", artifact_id AS "artifactId",
  artifact_path AS "artifactPath", artifact_sha256 AS "artifactSha256", artifact_bytes AS "artifactBytes",
  status, started_at AS "startedAt", started_by AS "startedBy", finished_at AS "finishedAt", finished_by AS "finishedBy"`;

/** Platform metadata only. Both dependencies must share a dedicated platform connection.
 * beginNext is a reservation, NOT artifact verification, storage readiness or permission to execute SQL.
 * finish is a future trusted executor's attestation, NOT proof of a separate database commit.
 */
export class AppMigrationLedger {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>, private readonly client: QueryableClient,
    private readonly clock: () => Date = () => new Date()) {}

  async beginNext(context: PlatformManagementContext, appId: string, expectedRevision: number): Promise<AppMigrationAttempt | null> {
    await manage(context);
    const actor = personId(context);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new AppStorageError('STALE_REVISION');
    return runDatabaseTransaction(this.client, async () => {
      const current = await this.current(context, appId);
      if (current.revision !== expectedRevision) throw new AppStorageError('STALE_REVISION');
      const blocked = await this.rows('SELECT id FROM platform_app_migration_attempts WHERE installation_id=$1 AND status IN (\'running\',\'uncertain\') LIMIT 1', [current.storage.installationId]);
      if (blocked.length) throw new AppStorageError('MIGRATION_ATTEMPT_BLOCKED');
      const applied = await this.attempts(`SELECT ${columns} FROM platform_app_migration_attempts WHERE installation_id=$1 AND status='applied' ORDER BY ordinal LIMIT 129`, [current.storage.installationId]);
      for (const [ordinal, attempt] of applied.entries()) {
        const declaration = current.declarations[ordinal];
        if (!declaration || attempt.ordinal !== ordinal || !(await acceptsMigrationDigest(this.client, attempt.id, attempt.manifestDigest, current.storage.manifestDigest))
          || attempt.migrationId !== declaration.id || attempt.artifactId !== declaration.artifact.id
          || attempt.artifactSha256 !== declaration.artifact.sha256 || attempt.artifactPath !== declaration.artifact.path
          || attempt.artifactBytes !== declaration.artifact.bytes) throw new AppStorageError('MIGRATION_LEDGER_CONFLICT');
      }
      const next = current.declarations[applied.length];
      if (!next) return null;
      const result = await this.attempts(`INSERT INTO platform_app_migration_attempts
        (id,installation_id,registered_revision,manifest_digest,ordinal,migration_id,artifact_id,artifact_path,artifact_sha256,artifact_bytes,status,started_at,started_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',$11,$12) RETURNING ${columns}`,
      [randomUUID(), current.storage.installationId, current.revision, current.storage.manifestDigest, applied.length,
        next.id, next.artifact.id, next.artifact.path, next.artifact.sha256, next.artifact.bytes, this.instant(), actor]);
      return result[0];
    });
  }

  async finish(context: PlatformManagementContext, appId: string, attemptId: string, outcome: AppMigrationOutcome): Promise<AppMigrationAttempt> {
    await manage(context);
    const actor = personId(context);
    if (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId)) throw new AppStorageError('INVALID_ATTEMPT_ID');
    if (!['applied','rolled_back','uncertain'].includes(outcome)) throw new AppStorageError('INVALID_MIGRATION_OUTCOME');
    return runDatabaseTransaction(this.client, async () => {
      const current = await this.current(context, appId);
      const attempt = (await this.attempts(`SELECT ${columns} FROM platform_app_migration_attempts WHERE installation_id=$1 AND id=$2 FOR UPDATE`, [current.storage.installationId, attemptId]))[0];
      if (!attempt) throw new AppStorageError('MIGRATION_ATTEMPT_NOT_FOUND');
      const declaration = current.declarations[attempt.ordinal];
      if (!declaration || attempt.manifestDigest !== current.storage.manifestDigest || attempt.migrationId !== declaration.id
        || attempt.artifactId !== declaration.artifact.id || attempt.artifactSha256 !== declaration.artifact.sha256
        || attempt.artifactPath !== declaration.artifact.path || attempt.artifactBytes !== declaration.artifact.bytes) throw new AppStorageError('MIGRATION_LEDGER_CONFLICT');
      if (attempt.status === outcome) return attempt;
      if (attempt.status !== 'running') throw new AppStorageError('MIGRATION_TERMINAL_CONFLICT');
      const finishedAt = this.instant();
      if (Date.parse(finishedAt) < Date.parse(attempt.startedAt)) throw new AppStorageError('MIGRATION_CLOCK_REGRESSION');
      return (await this.attempts(`UPDATE platform_app_migration_attempts SET status=$3,finished_at=$4,finished_by=$5
        WHERE installation_id=$1 AND id=$2 AND status='running' RETURNING ${columns}`, [current.storage.installationId, attemptId, outcome, finishedAt, actor]))[0];
    });
  }

  async listHistory(context: PlatformManagementContext, appId: string, afterSequence = 0, limit = 100): Promise<AppMigrationAttempt[]> {
    if (!isNativeManagementActor(context)
      || !(await context.authorize('platform.authorization.read', {})).allowed) throw new AppStorageError('STORAGE_ACCESS_DENIED');
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > 2147483647
      || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new AppStorageError('INVALID_PAGE');
    return runDatabaseTransaction(this.client, async () => {
      const current = await this.current(context, appId);
      return this.attempts(`SELECT ${columns} FROM platform_app_migration_attempts WHERE installation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, [current.storage.installationId, afterSequence, limit]);
    });
  }

  /** Original-cluster evidence only; no expiry, missing receipt or unknown xid permits replay. */
  async reconcile(context: PlatformManagementContext, appId: string, attemptId: string): Promise<AppMigrationAttempt> {
    await manage(context);
    const actor = personId(context);
    if (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId)) throw new AppStorageError('INVALID_ATTEMPT_ID');
    return runDatabaseTransaction(this.client, async () => {
      // Match managed-operation lock order: installation advisory lock before registry row lock.
      const initial = await this.registry.get(context, appId);
      await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`app-storage:${initial.id}`]);
      const current = await this.current(context, appId);
      if (current.storage.installationId !== initial.id) throw new AppStorageError('MIGRATION_REGISTRY_MISMATCH');
      const attempt = (await this.attempts(`SELECT ${columns} FROM platform_app_migration_attempts WHERE installation_id=$1 AND id=$2 FOR UPDATE`, [initial.id,attemptId]))[0];
      if (!attempt) throw new AppStorageError('MIGRATION_ATTEMPT_NOT_FOUND');
      if (attempt.status === 'applied' || attempt.status === 'rolled_back') return attempt;
      const declaration = current.declarations[attempt.ordinal];
      if (!declaration || attempt.manifestDigest !== current.storage.manifestDigest || attempt.migrationId !== declaration.id
        || attempt.artifactId !== declaration.artifact.id || attempt.artifactSha256 !== declaration.artifact.sha256
        || attempt.artifactPath !== declaration.artifact.path || attempt.artifactBytes !== declaration.artifact.bytes)
        throw new AppStorageError('MIGRATION_LEDGER_CONFLICT');
      const quiet = (await this.rows<{quiet:boolean}>(`SELECT
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1 AND NOT rolcanlogin)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1)
        AND NOT EXISTS(SELECT 1 FROM platform_app_storage_leases WHERE installation_id=$2 AND status='active') AS quiet`,
        [current.storage.ownerRole,initial.id]))[0];
      if (quiet?.quiet !== true) throw new AppStorageError('MIGRATION_RECONCILIATION_NOT_QUIESCENT');
      const receipt = (await this.rows<{xid:string|null;database:string|null;currentDatabase:string;manifestDigest:string;sha256:string}>(
        `SELECT transaction_id AS xid,database_name AS database,current_database() AS "currentDatabase",
        manifest_digest AS "manifestDigest",artifact_sha256 AS sha256 FROM platform_app_migration_receipts
        WHERE attempt_id=$1 AND installation_id=$2`, [attemptId,initial.id]))[0];
      if (!receipt) throw new AppStorageError('MIGRATION_RECONCILIATION_BLOCKED');
      if (receipt.manifestDigest !== attempt.manifestDigest || receipt.sha256 !== attempt.artifactSha256)
        throw new AppStorageError('MIGRATION_RECEIPT_CONFLICT');
      let evidence = 'not_started_quiescent';
      if (receipt.xid !== null) {
        if (receipt.database !== receipt.currentDatabase) throw new AppStorageError('MIGRATION_RECEIPT_CONFLICT');
        try { evidence = (await this.rows<{status:string|null}>('SELECT pg_xact_status($1::xid8) AS status',[receipt.xid]))[0]?.status ?? 'unknown'; }
        catch { throw new AppStorageError('MIGRATION_RECONCILIATION_BLOCKED'); }
        if (evidence !== 'committed' && evidence !== 'aborted') throw new AppStorageError('MIGRATION_RECONCILIATION_BLOCKED');
      }
      const outcome = evidence === 'committed' ? 'applied' : 'rolled_back';
      const at = this.instant();
      if (Date.parse(at)<Date.parse(attempt.startedAt)) throw new AppStorageError('MIGRATION_CLOCK_REGRESSION');
      await this.client.query(`INSERT INTO platform_app_migration_reconciliations
        (id,attempt_id,previous_status,new_status,evidence,transaction_id,actor_id,reconciled_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),attemptId,attempt.status,outcome,evidence,receipt.xid,actor,at]);
      return (await this.attempts(`UPDATE platform_app_migration_attempts SET status=$3,finished_at=$4,finished_by=$5
        WHERE installation_id=$1 AND id=$2 RETURNING ${columns}`,[initial.id,attemptId,outcome,at,actor]))[0];
    });
  }

  private async current(context: PlatformManagementContext, appId: string) {
    if (typeof appId !== 'string' || appId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId)) throw new AppStorageError('INVALID_APP_ID');
    const locked = (await this.rows<{ id: string; revision: number; manifest: unknown }>(
      'SELECT id,revision,record->\'manifest\' AS manifest FROM platform_app_installations WHERE app_id=$1 FOR UPDATE', [appId]))[0];
    if (!locked) throw new AppStorageError('APP_NOT_FOUND');
    // Real registry get joins this transaction; Core rejects a different connection or memory boundary.
    const record = await this.registry.get(context, appId);
    if (record.id !== locked.id || record.revision !== locked.revision || record.appId !== appId
      || !isDeepStrictEqual(record.manifest, locked.manifest)) throw new AppStorageError('MIGRATION_REGISTRY_MISMATCH');
    const parsed = validateAppManifest(record.manifest);
    if (!parsed.ok) throw new AppStorageError('MIGRATION_INVALID_MANIFEST');
    const storage = binding({ id: record.id, appId: record.appId, manifest: parsed.manifest });
    if (storage.mode !== 'managed' || parsed.manifest.storage.mode !== 'managed') throw new AppStorageError('MIGRATION_STORAGE_NOT_MANAGED');
    const artifacts = new Map(parsed.manifest.artifacts.map(item => [item.id, item]));
    const declarations = parsed.manifest.storage.migrations.map(item => ({ id: item.id, artifact: artifacts.get(item.artifactId)! }));
    if (declarations.some(item => item.artifact.bytes > APP_MIGRATION_FILE_MAX_BYTES)
      || declarations.reduce((sum,item) => sum + item.artifact.bytes, 0) > APP_MIGRATION_TOTAL_MAX_BYTES) throw new AppStorageError('MIGRATION_SIZE_LIMIT');
    return { storage, revision: record.revision, declarations };
  }
  private instant() {
    const date = this.clock();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new AppStorageError('INVALID_MIGRATION_CLOCK');
    return date.toISOString();
  }
  private async rows<T = unknown>(sql: string, values: readonly unknown[]): Promise<T[]> {
    return (await this.client.query(sql, values) as { rows: T[] }).rows;
  }
  private async attempts(sql: string, values: readonly unknown[]): Promise<AppMigrationAttempt[]> {
    const rows = await this.rows<Omit<AppMigrationAttempt, 'startedAt' | 'finishedAt'> & { startedAt: string | Date; finishedAt: string | Date | null }>(sql, values);
    return rows.map(row => ({ ...row, startedAt: new Date(row.startedAt).toISOString(), finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString() }));
  }
}
function personId(context: PlatformManagementContext): string {
  if (!isNativeManagementActor(context)) throw new AppStorageError('INVALID_MIGRATION_ACTOR');
  return context.actorType==='administrator'?`administrator:${context.administrator.id}`:managementActorId(context);
}
