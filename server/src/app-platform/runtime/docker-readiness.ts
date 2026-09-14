import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import type { AppDockerJournal } from './docker-journal.js';
import type { AppDockerExecutor } from './docker-executor.js';
import { compileAppDockerPolicy } from './docker-policy.js';

export class AppDockerReadinessError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppDockerReadinessError'; }
}
function fail(code: string): never { throw new AppDockerReadinessError(code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function instant(value: unknown): number {
  if (typeof value !== 'string') fail('HEALTH_EVIDENCE_INVALID');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail('HEALTH_EVIDENCE_INVALID');
  return result;
}

/** Fresh, read-only runtime evidence. This is not a reusable authorization token and never enables
 * an installation: storage, gateway, extension readiness and atomic lifecycle settlement remain separate.
 * Requires trusted Engine time synchronized with host time and the verified platform-generated probe.
 */
export class AppDockerReadiness {
  constructor(private readonly registry: Pick<AppRegistryService, 'get'>,
    private readonly journal: Pick<AppDockerJournal, 'latest'>,
    private readonly executor: Pick<AppDockerExecutor, 'observe'>,
    private readonly clock: () => Date = () => new Date()) {}

  async check(context: PlatformManagementContext, appId: string, revision: number, operationId: string) {
    if (!isNativeManagementActor(context)
      || !(await context.authorize('platform.authorization.manage', {})).allowed) fail('RUNTIME_ACCESS_DENIED');
    const installation = await this.registry.get(context, appId);
    if (installation.enabled || installation.revision !== revision || installation.lifecycle?.operationId !== operationId
      || installation.lifecycle.status !== 'running' || !['install', 'enable'].includes(installation.lifecycle.action)) fail('READINESS_LIFECYCLE_MISMATCH');
    if (!installation.manifest.health) fail('HEALTH_DECLARATION_REQUIRED');
    const attempt = await this.journal.latest(installation.id);
    if (!attempt || attempt.status !== 'confirmed' || attempt.action !== 'start' || attempt.operationId !== operationId
      || attempt.registeredRevision !== revision || attempt.appId !== appId || attempt.installationId !== installation.id
      || attempt.observation?.state !== 'running' || attempt.containerId !== attempt.observation.containerId
      || attempt.manifestDigest !== createHash('sha256').update(JSON.stringify(installation.manifest)).digest('hex')) fail('READINESS_RUNTIME_MISMATCH');
    const policy = compileAppDockerPolicy({ installation, operationId: attempt.policy.body.Labels['afc.app.operation'],
      runtimeImage: attempt.policy.body.Image, verifiedBundlePath: attempt.policy.body.HostConfig.Mounts[0].Source, network: 'none', gateway: attempt.policy.body.OpenStdin ? 'stdio' : 'none' });
    if (!isDeepStrictEqual(policy, attempt.policy)) fail('READINESS_POLICY_MISMATCH');
    const found = await this.executor.observe(policy, attempt.approval, attempt.containerId!);
    if (!found || !found.State.Running || found.State.Status !== 'running') fail('RUNTIME_NOT_RUNNING');
    const health = found.State.Health;
    if (!record(health) || health.Status !== 'healthy' || health.FailingStreak !== 0
      || !Array.isArray(health.Log) || health.Log.length === 0 || health.Log.length > 5) fail('RUNTIME_NOT_HEALTHY');
    const last: unknown = health.Log.at(-1);
    if (!record(last) || last.ExitCode !== 0) fail('HEALTH_EVIDENCE_INVALID');
    const started = instant(found.State.StartedAt), probeStarted = instant(last.Start), ended = instant(last.End);
    const now = this.clock().getTime();
    // One probe interval + its timeout + small scheduling allowance, no indefinite cached health.
    const maxAgeMs = installation.manifest.health.timeoutSeconds * 1000 + 10_000;
    if (!Number.isFinite(now) || probeStarted < started || ended < probeStarted || ended > now
      || now - ended > maxAgeMs) fail('HEALTH_EVIDENCE_STALE');
    // Revalidate after IO; concurrent disable/revoke or dispatch invalidates this observation.
    const current = await this.registry.get(context, appId);
    const latest = await this.journal.latest(installation.id);
    if (current.revision !== revision || current.enabled || current.lifecycle?.operationId !== operationId
      || current.lifecycle.status !== 'running' || !isDeepStrictEqual(current.manifest, installation.manifest)
      || !latest || !isDeepStrictEqual(latest, attempt)) fail('READINESS_CHANGED');
    const completedAt = this.clock().getTime();
    if (!Number.isFinite(completedAt) || completedAt < now || completedAt - ended > maxAgeMs) fail('HEALTH_EVIDENCE_STALE');
    return Object.freeze({ installationId: installation.id, revision, operationId, containerId: found.Id,
      dispatchId: attempt.id, probeEndedAt: new Date(ended).toISOString(), observedAt: new Date(completedAt).toISOString() });
  }
}
