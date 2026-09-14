import { validateAppManifest } from '../manifest/index.js';
import type { AppInstallation } from '../registry/model.js';
import type { PlatformActorContext, PlatformActorContextResolver } from '../../platform/context/index.js';
import { jsonSnapshot, type GatewayJson } from '../gateway/model.js';
import { AppStdioApiError, type AppStdioApiTransport } from './stdio-api.js';

export interface HostedAppApiOptions {
  installation: AppInstallation;
  timeoutMs?: number;
  getInstallation(appId: string): Promise<AppInstallation | null>;
  contextResolver: Pick<PlatformActorContextResolver, 'resolve'>;
  /** Trusted adapter must authorize all resource scopes implied by this payload. */
  authorize(context: PlatformActorContext, permission: string, payload: GatewayJson): Promise<boolean>;
  transport: Pick<AppStdioApiTransport, 'invoke' | 'drain'>;
}
/** Process-local API generation. Only trusted authenticated person contexts enter this boundary. */
export function createHostedAppApi(options: HostedAppApiOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new AppStdioApiError('INVALID_OPTIONS');
  const parsed = validateAppManifest(options.installation.manifest);
  if (!parsed.ok || !options.installation.enabled || parsed.manifest.id !== options.installation.appId ||
      !['trusted', 'isolated'].includes(parsed.manifest.backend.mode)) throw new AppStdioApiError('INVALID_INSTALLATION');
  const { id, appId, revision } = options.installation;
  const manifest = parsed.manifest;
  const manifestDigest = JSON.stringify(manifest);
  if (manifest.api.some(api => !api.permission)) throw new AppStdioApiError('PERMISSION_REQUIRED');
  const { getInstallation, contextResolver, authorize, transport } = options;
  let active = true;
  const pending = new Set<Promise<GatewayJson>>();
  async function current(): Promise<void> {
    const fresh = await getInstallation(appId);
    if (!active || !fresh?.enabled || fresh.id !== id || fresh.appId !== appId || fresh.revision !== revision ||
        JSON.stringify(fresh.manifest) !== manifestDigest) throw new AppStdioApiError('STALE_API');
  }
  return {
    invoke(context: PlatformActorContext, request: { apiId: string; method: string; path: string; payload: unknown }, signal?: AbortSignal): Promise<GatewayJson> {
      if (!active || signal?.aborted) return Promise.reject(new AppStdioApiError('CLOSED'));
      if (pending.size >= 16) return Promise.reject(new AppStdioApiError('BUSY'));
      if (context.actorType !== 'person') return Promise.reject(new AppStdioApiError('ACCESS_DENIED'));
      // The authenticated actor's identity is pinned before awaiting. Never serialize it to the app.
      const identity = { ...context.trustedIdentity };
      const metadata = { ...context.request };
      let payload: GatewayJson;
      try { payload = jsonSnapshot(request.payload, 60 * 1024); }
      catch { return Promise.reject(new AppStdioApiError('INVALID_PAYLOAD')); }
      const api = manifest.api.find(api => api.id === request.apiId && api.method === request.method && api.path === request.path);
      if (!api) return Promise.reject(new AppStdioApiError('API_DENIED'));
      let dispatched = false;
      const controller = new AbortController();
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = (code: string) => { controller.abort(); rejectAbort(new AppStdioApiError(code, dispatched ? 'unknown' : 'not_started')); };
      const onAbort = () => abort('ABORTED');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
      const work = Promise.resolve().then(async () => {
        async function check(): Promise<void> {
          await current();
          const actor = await contextResolver.resolve({ actorType: 'person', trustedIdentity: identity,
            execution: { type: 'application', appId }, requestId: metadata.requestId, traceId: metadata.traceId });
          if (actor.actorType !== 'person' || actor.execution.type !== 'application' || actor.execution.appId !== appId ||
              !await authorize(actor, api!.permission!, payload)) throw new AppStdioApiError('ACCESS_DENIED');
          await current();
          if (controller.signal.aborted) throw new AppStdioApiError('ABORTED');
        }
        await check();
        dispatched = true;
        const result = await transport.invoke({ handler: api.handler, method: api.method, path: api.path, payload }, controller.signal);
        await check();
        return jsonSnapshot(result, 256 * 1024);
      }).catch(error => {
        if (error instanceof AppStdioApiError) throw new AppStdioApiError(error.code, dispatched ? 'unknown' : error.writeOutcome);
        throw new AppStdioApiError('API_FAILED', dispatched ? 'unknown' : 'not_started');
      }).finally(() => { pending.delete(work); });
      pending.add(work);
      return Promise.race([work, aborted]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
    },
    close(): void { active = false; },
    async drain(): Promise<void> {
      if (active) throw new AppStdioApiError('DRAIN_REQUIRES_CLOSE');
      await Promise.allSettled([...pending]);
      await transport.drain();
    },
  };
}
