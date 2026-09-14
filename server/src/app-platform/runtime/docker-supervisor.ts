import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { compileAppDockerPolicy, type AppDockerPolicy } from './docker-policy.js';
import { AppDockerExecutor, AppDockerExecutorError, type AppDockerImageApproval } from './docker-executor.js';

import { AppDockerJournal, type AppDockerDispatchAttempt, type AppDockerDispatchInput, type AppDockerObservation } from './docker-journal.js';
import type { AppDockerContainerInspection } from './docker-transport.js';

export class AppDockerSupervisorError extends Error {
  constructor(readonly code: string, readonly attemptId?: string) {
    super(code); this.name = 'AppDockerSupervisorError';
  }
}
function denied(code: string): never { throw new AppDockerSupervisorError(code); }
async function authorize(context: PlatformManagementContext): Promise<void> {
  if (!isNativeManagementActor(context)
    || !(await context.authorize('platform.authorization.manage', {})).allowed) denied('RUNTIME_ACCESS_DENIED');
}


export interface AppDockerDispatchRequest {
  appId: string;
  revision: number;
  operationId: string;
  expectedSequence: number;
  action: AppDockerDispatchInput['action'];
  containerId: string | null;
  policy: AppDockerPolicy;
  approval: AppDockerImageApproval;
}

/** Trusted native-admin composition. Does not settle installation lifecycle or attest app health.
 * Journal reserve must use a dedicated connection and commit before any Engine operation.
 * Reconciliation never dispatches writes. Unknown outcomes remain blocked without expiry.
 */
export class AppDockerSupervisor {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>,
    private readonly journal: Pick<AppDockerJournal, 'reserve' | 'latest' | 'finish'>,
    private readonly executor: Pick<AppDockerExecutor, 'create' | 'start' | 'stop' | 'remove' | 'observe'>) {}

  async dispatch(context: PlatformManagementContext, request: AppDockerDispatchRequest): Promise<AppDockerDispatchAttempt> {
    // Snapshot before asynchronous authorization, including approval and policy inputs.
    const input = structuredClone(request);
    await authorize(context);
    const installation = await this.registry.get(context, input.appId);
    const lifecycle = installation.lifecycle;
    if (installation.enabled || installation.revision !== input.revision || !lifecycle
      || lifecycle.operationId !== input.operationId || !['running', 'failed'].includes(lifecycle.status)) denied('RUNTIME_LIFECYCLE_MISMATCH');
    if (!['create', 'start', 'stop', 'remove'].includes(input.action)) denied('RUNTIME_ACTION_INVALID');
    if ((input.action === 'create' || input.action === 'start')
      && (!['install', 'enable'].includes(lifecycle.action) || lifecycle.status !== 'running')) denied('RUNTIME_START_FORBIDDEN');
    const creationOperation = input.policy.body.Labels['afc.app.operation'];
    if (input.action === 'create' && creationOperation !== input.operationId) denied('RUNTIME_POLICY_MISMATCH');
    const expectedPolicy = compileAppDockerPolicy({ installation, operationId: creationOperation,
      runtimeImage: input.policy.body.Image, verifiedBundlePath: input.policy.body.HostConfig.Mounts[0].Source, network: 'none', gateway: input.policy.body.OpenStdin ? 'stdio' : 'none' });
    if (!isDeepStrictEqual(expectedPolicy, input.policy)) denied('RUNTIME_POLICY_MISMATCH');
    const attempt = await this.journal.reserve({
      installationId: installation.id, operationId: input.operationId, registeredRevision: input.revision,
      appId: input.appId, manifestDigest: createHash('sha256').update(JSON.stringify(installation.manifest)).digest('hex'),
      expectedSequence: input.expectedSequence, action: input.action, containerId: input.containerId,
      policy: input.policy, approval: input.approval,
    });
    let observed: AppDockerContainerInspection | null;
    try {
      if (attempt.action === 'create') observed = await this.executor.create(attempt.policy, attempt.approval);
      else if (attempt.action === 'start') observed = await this.executor.start(attempt.policy, attempt.approval, attempt.containerId!);
      else if (attempt.action === 'stop') observed = await this.executor.stop(attempt.policy, attempt.approval, attempt.containerId!);
      else { await this.executor.remove(attempt.policy, attempt.approval, attempt.containerId!); observed = null; }
    } catch (error) {
      if (attempt.action === 'create' && error instanceof AppDockerExecutorError
        && error.code === 'CREATE_REQUEST_REJECTED' && !error.uncertain) {
        try { await this.journal.finish(attempt.installationId, attempt.id, attempt.sequence, { status: 'rejected' }); }
        catch { throw new AppDockerSupervisorError('RUNTIME_JOURNAL_UNCERTAIN', attempt.id); }
        throw new AppDockerSupervisorError('RUNTIME_CREATE_REJECTED', attempt.id);
      }
      // If this persistence fails, dispatched remains a blocker. Never hide uncertainty with retry.
      try { await this.journal.finish(attempt.installationId, attempt.id, attempt.sequence, { status: 'uncertain' }); }
      catch { throw new AppDockerSupervisorError('RUNTIME_JOURNAL_UNCERTAIN', attempt.id); }
      throw new AppDockerSupervisorError('RUNTIME_DISPATCH_UNCERTAIN', attempt.id);
    }
    return this.confirm(attempt, observed);
  }

  async reconcile(context: PlatformManagementContext, appId: string, expectedAttemptId: string): Promise<AppDockerDispatchAttempt> {
    await authorize(context);
    const installation = await this.registry.get(context, appId);
    const attempt = await this.journal.latest(installation.id);
    if (!attempt || attempt.id !== expectedAttemptId || attempt.appId !== appId) denied('RUNTIME_ATTEMPT_MISMATCH');
    if (['confirmed', 'rejected'].includes(attempt.status)) return attempt;
    // Persisted operation evidence remains inspectable even if later registry revocation changes revision.
    // This does not start anything, expand privileges, or settle the later lifecycle.
    const observed = await this.executor.observe(attempt.policy, attempt.approval, attempt.containerId ?? undefined);
    return this.confirm(attempt, observed);
  }

  private async confirm(attempt: AppDockerDispatchAttempt, observed: AppDockerContainerInspection | null): Promise<AppDockerDispatchAttempt> {
    let observation: AppDockerObservation;
    if (attempt.action === 'create' && observed?.State.Status === 'created') observation = { containerId: observed.Id, state: 'created' };
    else if (attempt.action === 'start' && observed?.State.Running === true) observation = { containerId: observed.Id, state: 'running' };
    else if (attempt.action === 'stop' && observed && !observed.State.Running) observation = { containerId: observed.Id, state: 'stopped' };
    else if (attempt.action === 'remove' && observed === null && attempt.containerId) observation = { containerId: attempt.containerId, state: 'absent' };
    else throw new AppDockerSupervisorError('RUNTIME_OUTCOME_UNCONFIRMED', attempt.id);
    try { return await this.journal.finish(attempt.installationId, attempt.id, attempt.sequence, { status: 'confirmed', observation }); }
    catch { throw new AppDockerSupervisorError('RUNTIME_JOURNAL_UNCERTAIN', attempt.id); }
  }
}
