import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDatabaseTransaction } from '../../core/database/index.js';
import { Client } from 'pg';
import type { AppManifest } from '../manifest/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import { AppStorageError, binding, type ManagedAppStorage } from './binding.js';
import { ManagedAppOperations, type ManagedAppLockedScope } from './managed-operations.js';
import { AppMigrationPlanner, type AppMigrationArtifactReader } from './migration-plan.js';
import { AppMigrationExecutor } from './migration-executor.js';
import { AppMigrationLedger } from './migration-ledger.js';
import { AppMigrationReceipts } from './migration-receipts.js';
import { PostgresAppMigrationDriver, type AppMigrationCredentials } from './postgres-migration-driver.js';
import { exportAppData, restoreAppData, type AppPortableClient } from './portable-data.js';

import { assertNoPendingRestore, acceptsMigrationDigest } from './lifecycle-evidence.js';

/** Platform composition entrypoint. Never expose dependency constructors or owner callbacks to apps. */
export class ManagedAppStorageService {
  constructor(private readonly operations: ManagedAppOperations, private readonly reader: AppMigrationArtifactReader) {}

  provision(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.provision(context, appId, revision);
  }
  preserve(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.preserve(context, appId, revision);
  }
  recover(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.recover(context, appId, revision);
  }
  /** Current locked observation only; lease recovery may revoke abandoned owners before checking. */
  assertReady(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.withLock(context, appId, revision, async scope => {
      await scope.storage.assertReady(context, appId);
      await this.requireSettled(scope, context, appId);
      await scope.revalidate();
      return Object.freeze({ binding: Object.freeze({ ...scope.binding }), revision });
    });
  }
  /** Trusted host only: retain the storage lock until activation's registry commit settles. */
  withReady<T>(context: PlatformManagementContext, appId: string, revision: number, activate: () => Promise<T>) {
    return this.operations.withLock(context,appId,revision,async scope => {
      await scope.storage.assertReady(context,appId);
      await this.requireSettled(scope,context,appId);
      await scope.revalidate();
      return activate();
    });
  }
  validateVersion(context: PlatformManagementContext, appId: string, revision: number, targetManifest: AppManifest) {
    const target = structuredClone(targetManifest);
    return this.operations.withLock(context,appId,revision,async scope => {
      const current = await scope.registry.get(context,appId);
      if(current.enabled)throw new AppStorageError('STORAGE_REQUIRES_DISABLED');
      this.compatibleVersion(current.manifest,target);
      await scope.storage.assertReady(context,appId);
      await this.requireSettled(scope,context,appId);
      await scope.revalidate();
    });
  }
  executeNext(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.withLock(context, appId, revision, async scope => {
      if ((await scope.registry.get(context,appId)).enabled) throw new AppStorageError('STORAGE_REQUIRES_DISABLED');
      await assertNoPendingRestore(scope.client, scope.binding.installationId);
      const ledger = new AppMigrationLedger(scope.registry, scope.client);
      const receipts = new AppMigrationReceipts(scope.client);
      const planner = new AppMigrationPlanner(scope.registry, this.reader);
      const executor = new AppMigrationExecutor(scope.registry, planner, scope.storage, ledger, {
        execute: async request => {
          await receipts.dispatch(request);
          return scope.withOwner(async credentials => {
            const driver = new PostgresAppMigrationDriver(async () => credentials, {}, undefined, {
              onTransaction: (r, evidence) => receipts.recordTransaction(r, evidence),
              beforeCommit: () => scope.revalidate(),
            });
            return driver.execute(request);
          });
        },
      });
      return executor.executeNext(context, appId, revision);
    });
  }
  reconcile(context: PlatformManagementContext, appId: string, revision: number, attemptId: string) {
    return this.operations.withLock(context, appId, revision, scope =>
      new AppMigrationLedger(scope.registry, scope.client).reconcile(context, appId, attemptId));
  }
  exportData(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.withLock(context, appId, revision, async scope => {
      await this.requireSettled(scope, context, appId);
      return scope.withOwner(credentials => this.withConnection(credentials, scope.binding,
        client => exportAppData(client, scope.binding, { beforeCommit: () => scope.revalidate() })), { allowRetained: true });
    });
  }
  restoreData(context: PlatformManagementContext, appId: string, revision: number, text: string) {
    return this.operations.withLock(context, appId, revision, async scope => {
      if ((await scope.registry.get(context,appId)).enabled) throw new AppStorageError('STORAGE_REQUIRES_DISABLED');
      // Restore is disaster recovery of the installed version, not an alternate migration installer.
      await this.requireSettled(scope, context, appId);
      const id = randomUUID();
      // Commit intent before owner issuance or application writes. Any lost acknowledgement stays blocked.
      await scope.client.query(`INSERT INTO public.platform_app_storage_restores
        (id,installation_id,manifest_digest,status) VALUES($1,$2,$3,'dispatched')`,
        [id,scope.binding.installationId,scope.binding.manifestDigest]);
      const result = await scope.withOwner(credentials => this.withConnection(credentials, scope.binding,
        client => restoreAppData(client, scope.binding, text, { beforeCommit: () => scope.revalidate(),
          onRollbackConfirmed: async () => { await scope.client.query("UPDATE public.platform_app_storage_restores SET status='rolled_back',completed_at=clock_timestamp() WHERE id=$1 AND status='dispatched'",[id]); },
        })));
      await scope.revalidate();
      await scope.client.query("UPDATE public.platform_app_storage_restores SET status='completed',completed_at=clock_timestamp() WHERE id=$1 AND status='dispatched'",[id]);
      return result;
    });
  }
  /** Complete a disabled, successful registry version switch without rewriting migration history. */
  adoptVersion(context: PlatformManagementContext, appId: string, revision: number) {
    return this.operations.withLock(context, appId, revision, async scope => runDatabaseTransaction(scope.client, async () => {
      await assertNoPendingRestore(scope.client, scope.binding.installationId);
      const current = await scope.registry.get(context, appId);
      const lifecycle = current.lifecycle;
      if (current.enabled || !lifecycle || lifecycle.status !== 'completed'
        || !['upgrade','rollback'].includes(lifecycle.action) || !lifecycle.targetManifest
        || !isDeepStrictEqual(current.manifest,lifecycle.targetManifest)) throw new AppStorageError('STORAGE_VERSION_TRANSITION_REQUIRED');
      const previous = binding({...current,manifest:lifecycle.baseManifest});
      if (previous.mode !== 'managed') throw new AppStorageError('STORAGE_VERSION_INCOMPATIBLE');
      this.compatibleVersion(lifecycle.baseManifest,current.manifest);
      const recorded = await scope.client.query('SELECT source_digest,target_digest FROM public.platform_app_storage_versions WHERE installation_id=$1 AND operation_id=$2',
        [current.id,lifecycle.operationId]) as {rows:{source_digest:string;target_digest:string}[]};
      if (recorded.rows.length) {
        if (recorded.rows[0].source_digest!==previous.manifestDigest || recorded.rows[0].target_digest!==scope.binding.manifestDigest)
          throw new AppStorageError('STORAGE_BINDING_CONFLICT');
        await scope.storage.assertReady(context,appId);
        await scope.client.query('SET LOCAL search_path = pg_catalog, public');
        await this.requireSettled(scope,context,appId);
      } else {
        // Original attempts must already be complete for the source version; uncertainty never migrates forward.
        const attempts = await this.requireSettled(scope,context,appId,previous.manifestDigest);
        await scope.storage.transitionBinding(context,appId,previous);
        // Nested storage inspection narrows search_path; restore platform metadata lookup
        // before the registry revision recheck in this enclosing transaction.
        await scope.client.query('SET LOCAL search_path = pg_catalog, public');
        for (const attempt of attempts) await scope.client.query(`INSERT INTO public.platform_app_storage_migration_adoptions
          (attempt_id,target_digest) VALUES($1,$2) ON CONFLICT DO NOTHING`,[attempt.id,scope.binding.manifestDigest]);
        await scope.client.query(`INSERT INTO public.platform_app_storage_versions
          (installation_id,operation_id,source_digest,target_digest) VALUES($1,$2,$3,$4)`,
          [current.id,lifecycle.operationId,previous.manifestDigest,scope.binding.manifestDigest]);
      }
      await scope.revalidate();
      return Object.freeze({...scope.binding});
    }));
  }
  private compatibleVersion(previous: AppManifest, next: AppManifest) {
    if (previous.id !== next.id || previous.publisherId !== next.publisherId || previous.storage.mode !== 'managed'
      || next.storage.mode !== 'managed' || !isDeepStrictEqual(previous.storage,next.storage))
      throw new AppStorageError('STORAGE_VERSION_INCOMPATIBLE');
    for (const declaration of next.storage.migrations) {
      const old = previous.artifacts.find(a=>a.id===declaration.artifactId);
      const target = next.artifacts.find(a=>a.id===declaration.artifactId);
      if (!old || !isDeepStrictEqual(old,target)) throw new AppStorageError('STORAGE_VERSION_INCOMPATIBLE');
    }
  }
  private async requireSettled(scope: ManagedAppLockedScope, context: PlatformManagementContext, appId: string, digest = scope.binding.manifestDigest) {
    await assertNoPendingRestore(scope.client, scope.binding.installationId);
    const result = await scope.client.query(`SELECT id,status,ordinal,manifest_digest,migration_id,artifact_id,artifact_path,artifact_sha256,artifact_bytes FROM public.platform_app_migration_attempts
      WHERE installation_id=$1 AND status IN ('running','uncertain','applied') ORDER BY ordinal LIMIT 129`, [scope.binding.installationId]) as { rows: { id:string; status: string; ordinal: number; manifest_digest: string; migration_id: string; artifact_id: string; artifact_path: string; artifact_sha256: string; artifact_bytes: number }[] };
    const current = await scope.registry.get(context, appId);
    if (result.rows.some(row => row.status !== 'applied')) throw new AppStorageError('MIGRATION_ATTEMPT_BLOCKED');
    if (current.manifest.storage.mode !== 'managed' || result.rows.length !== current.manifest.storage.migrations.length
      || result.rows.some((row, ordinal) => row.ordinal !== ordinal)) throw new AppStorageError('MIGRATIONS_NOT_COMPLETE');
    const declarations = current.manifest.storage.migrations;
    for (const [ordinal,row] of result.rows.entries()) {
      const declaration = declarations[ordinal];
      const artifact = current.manifest.artifacts.find(item => item.id === declaration.artifactId);
      if (!(await acceptsMigrationDigest(scope.client,row.id,row.manifest_digest,digest)) || row.migration_id !== declaration.id
        || !artifact || row.artifact_id !== artifact.id || row.artifact_path !== artifact.path
        || row.artifact_sha256 !== artifact.sha256 || row.artifact_bytes !== artifact.bytes)
        throw new AppStorageError('MIGRATION_LEDGER_CONFLICT');
    }
    return result.rows;
  }
  private async withConnection<T>(credentials: AppMigrationCredentials, binding: Readonly<ManagedAppStorage>, work: (client: AppPortableClient) => Promise<T>) {
    const client = new Client({ ...credentials, connectionTimeoutMillis: 5000,
      application_name: 'app-portable-data', options: '-c search_path=pg_catalog', client_encoding: 'UTF8',
      statement_timeout: 30_000, lock_timeout: 5000, idle_in_transaction_session_timeout: 30_000,
      ...{ replication: 'false' } });
    let failed = false;
    client.on('error', () => { failed = true; });
    try {
      if (credentials.user !== binding.ownerRole) throw new AppStorageError('STORAGE_IDENTITY_MISMATCH');
      await client.connect();
      const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
      if (failed) throw new AppStorageError('STORAGE_RESULT_UNCERTAIN');
      return result;
    } catch (error) { throw error instanceof AppStorageError ? error : new AppStorageError('STORAGE_TRANSFER_FAILED'); }
    finally { try { await client.end(); } catch { throw new AppStorageError('STORAGE_RESULT_UNCERTAIN'); } }
  }
}
