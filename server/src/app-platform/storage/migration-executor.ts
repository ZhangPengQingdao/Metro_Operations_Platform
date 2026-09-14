import { isDeepStrictEqual } from 'node:util';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { binding, manage, AppStorageError, type ManagedAppStorage } from './binding.js';
import type { AppStorageService } from './index.js';
import type { AppMigrationPlanner, AppMigrationPlan, AppMigrationStep } from './migration-plan.js';
import type { AppMigrationLedger, AppMigrationAttempt, AppMigrationOutcome } from './migration-ledger.js';

export interface AppMigrationExecutionRequest {
  readonly binding: Readonly<ManagedAppStorage>;
  readonly revision: number;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly step: Readonly<AppMigrationStep>;
}
/** Trusted platform adapter, NOT an application plugin. It must independently authenticate with
 * restricted privileges and establish transaction/outcome evidence. No adapter is wired by default.
 * rolled_back means confirmed no commit; transport errors are never evidence of rollback.
 */
export interface AppRestrictedMigrationDriver {
  execute(request: AppMigrationExecutionRequest): Promise<AppMigrationOutcome>;
}
export type AppMigrationExecutionResult = { status: 'complete' } | { status: AppMigrationOutcome; attemptId: string };
export class AppMigrationExecutionError extends AppStorageError {
  constructor(code: string, readonly attemptId?: string) { super(code); }
}

/** One-step coordinator only. Neither this admission snapshot nor a fake driver proves SQL isolation. */
export class AppMigrationExecutor {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>,
    private readonly planner: Pick<AppMigrationPlanner, 'prepare'>,
    private readonly storage: Pick<AppStorageService, 'assertReady'>,
    private readonly ledger: Pick<AppMigrationLedger, 'beginNext' | 'finish'>,
    private readonly driver?: AppRestrictedMigrationDriver) {}

  async executeNext(context: PlatformManagementContext, appId: string, expectedRevision: number): Promise<AppMigrationExecutionResult> {
    try { await manage(context); } catch (error) { throw safeError(error); }
    if (!this.driver) throw new AppMigrationExecutionError('MIGRATION_DRIVER_REQUIRED');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new AppMigrationExecutionError('STALE_REVISION');
    let plan: AppMigrationPlan;
    let attempt: AppMigrationAttempt | null;
    try {
      plan = await this.planner.prepare(context, appId);
      if (plan.revision !== expectedRevision) throw new AppStorageError('STALE_REVISION');
      await this.admit(context, appId, plan);
      attempt = await this.ledger.beginNext(context, appId, expectedRevision);
    } catch (error) { throw safeError(error); }
    if (!attempt) return { status: 'complete' };
    let request: AppMigrationExecutionRequest;
    try {
      const step = plan.steps[attempt.ordinal];
      if (!step || attempt.status !== 'running' || attempt.installationId !== plan.binding.installationId
        || attempt.registeredRevision !== plan.revision || attempt.manifestDigest !== plan.binding.manifestDigest
        || attempt.migrationId !== step.id || attempt.artifactId !== step.artifactId || attempt.artifactPath !== step.path
        || attempt.artifactSha256 !== step.sha256 || attempt.artifactBytes !== step.bytes)
        throw new AppStorageError('MIGRATION_RESERVATION_MISMATCH');
      request = Object.freeze({ binding: Object.freeze({ ...plan.binding }), revision: plan.revision,
        attemptId: attempt.id, ordinal: attempt.ordinal, step: Object.freeze({ ...step }) });
      await this.admit(context, appId, plan);
    } catch (error) {
      await this.record(context, appId, attempt.id, 'rolled_back');
      throw safeError(error, attempt.id);
    }
    let outcome: AppMigrationOutcome = 'uncertain';
    try {
      const reported = await this.driver.execute(request);
      if (reported === 'applied' || reported === 'rolled_back' || reported === 'uncertain') outcome = reported;
    } catch { /* A driver may have committed before throwing. Preserve uncertainty without raw errors. */ }
    await this.record(context, appId, attempt.id, outcome);
    return { status: outcome, attemptId: attempt.id };
  }

  private async admit(context: PlatformManagementContext, appId: string, plan: AppMigrationPlan) {
    const ready = await this.storage.assertReady(context, appId);
    if (!isDeepStrictEqual(ready, plan.binding)) throw new AppStorageError('MIGRATION_STORAGE_MISMATCH');
    const current = await this.registry.get(context, appId);
    if (current.revision !== plan.revision) throw new AppStorageError('STALE_REVISION');
    if (current.appId !== appId || !isDeepStrictEqual(binding(current), plan.binding)) throw new AppStorageError('MIGRATION_REGISTRY_MISMATCH');
    await manage(context);
  }
  private async record(context: PlatformManagementContext, appId: string, attemptId: string, outcome: AppMigrationOutcome) {
    try { await this.ledger.finish(context, appId, attemptId, outcome); }
    catch { throw new AppMigrationExecutionError('MIGRATION_RECONCILIATION_REQUIRED', attemptId); }
  }
}
function safeError(error: unknown, attemptId?: string): AppMigrationExecutionError {
  return new AppMigrationExecutionError(error instanceof AppStorageError ? error.code : 'MIGRATION_COORDINATION_FAILED', attemptId);
}
