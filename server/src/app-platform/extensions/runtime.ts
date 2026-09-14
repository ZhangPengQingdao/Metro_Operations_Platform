import type { CoreEventBus, CoreEventPayload, CoreEventHandler } from '../../core/events/index.js';
import { createCoreJobRuntime, type CoreJobRuntime } from '../../core/jobs/index.js';
import type { CoreMcpHandler } from '../../core/integrations/mcp/index.js';
import type { PlatformActorContext } from '../../platform/context/index.js';
import { attachAppEventSubscriptions, createAppJobDefinitions } from './adapters.js';
import type { AppExtensionHandle } from './model.js';

export interface AppExtensionRuntimeSession {
  fetch(request: Request): Promise<Response>;
  /** Open prepared ingress only after the registry generation is committed. */
  activate(): Promise<void>;
  /** Process-local resources and extension work only; never attests database/backend quiescence. */
  stop(): Promise<void>;
}
export interface AppExtensionRuntimeOptions {
  handle: AppExtensionHandle;
  bus: Pick<CoreEventBus, 'subscribe'>;
  resolveActor(): Promise<PlatformActorContext>;
  /** Trusted actual Gateway work + audit drain; caller disables registry ingress first. */
  drainGateway(): Promise<void>;
  /** Trusted factory transfers exclusive ownership of this fresh Host. */
  createMcpHost?(handle: AppExtensionHandle): Pick<CoreMcpHandler, 'fetch' | 'close'>;
  /** Trusted factory transfers exclusive ownership of a fresh, dedicated Core runtime. */
  createJobs?(): CoreJobRuntime;
  shutdownTimeoutMs?: number;
  deferActivation?: boolean;
}
export class AppExtensionRuntimeError extends Error {
  constructor(readonly code: 'EXTENSION_RUNTIME_BUSY' | 'EXTENSION_RUNTIME_STOP_FAILED' | 'EXTENSION_RUNTIME_TIMEOUT' | 'EXTENSION_RUNTIME_INVALID') {
    super(code); this.name = 'AppExtensionRuntimeError';
  }
}
export class AppExtensionRuntimeStartError extends Error {
  constructor(readonly session: AppExtensionRuntimeSession) {
    super('EXTENSION_RUNTIME_START_FAILED'); this.name = 'AppExtensionRuntimeStartError';
  }
}
// Keep the owner until every resource and actual call has settled, including after a timeout.
const owners = new Map<string, AppExtensionRuntimeSession>();
interface Cleanup {
  run(): Promise<void> | void;
  pending?: Promise<void>;
  done: boolean;
}
export async function startAppExtensionRuntime(options: AppExtensionRuntimeOptions): Promise<AppExtensionRuntimeSession> {
  const { handle, bus, resolveActor, drainGateway, createJobs, createMcpHost } = options;
  const timeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_INVALID');
  const key = handle.appId;
  if (owners.has(key) || owners.size >= 128) throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_BUSY');
  let ready = false, stopped = false;
  let host: Pick<CoreMcpHandler, 'fetch' | 'close'> | undefined;
  let stopping: Promise<void> | undefined;
  const calls = new Set<Promise<unknown>>();
  const cleanups: Cleanup[] = [];
  const addCleanup = (run: Cleanup['run']) => cleanups.push({ run, done: false });
  const track = <T>(work: () => Promise<T> | T): Promise<T> => {
    if (calls.size >= 128) return Promise.reject(new AppExtensionRuntimeError('EXTENSION_RUNTIME_BUSY'));
    // Register before executing a callback which may synchronously reenter stop().
    const pending = Promise.resolve().then(work);
    calls.add(pending);
    void pending.then(() => calls.delete(pending), () => calls.delete(pending));
    return pending;
  };
  const cleanup = (entry: Cleanup): Promise<void> => {
    if (entry.done) return Promise.resolve();
    if (entry.pending) return entry.pending;
    let work: Promise<void> | void;
    try { work = entry.run(); } catch (error) { work = Promise.reject(error); }
    entry.pending = Promise.resolve(work).then(() => {
      entry.done = true; entry.pending = undefined;
    }, error => {
      entry.pending = undefined; throw error;
    });
    return entry.pending;
  };
  let activatePrepared: (()=>Promise<void>) | undefined;
  let activating: Promise<void> | undefined;
  const session: AppExtensionRuntimeSession = {
    async activate() {
      if(stopped||!activatePrepared)throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_INVALID');
      if(ready)return;
      if(!activating)activating=activatePrepared().finally(()=>{activating=undefined;});
      await activating;
    },
    async fetch(request) {
      if (!ready || stopped) return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      if (!host) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return track(async () => {
        await checkCurrent();
        if (stopped) return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        return host!.fetch(request);
      });
    },
    stop() {
      if (stopping) return stopping;
      stopped = true; ready = false;
      // Install the shared promise before deactivate/cleanup can synchronously reenter.
      stopping = Promise.resolve().then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const results = await Promise.race([
            Promise.allSettled(cleanups.map(cleanup)),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new AppExtensionRuntimeError('EXTENSION_RUNTIME_TIMEOUT')), timeoutMs);
            }),
          ]);
          if (results.some(result => result.status === 'rejected')) throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_STOP_FAILED');
          if (owners.get(key) === session) owners.delete(key);
        } finally {
          if (timer) clearTimeout(timer);
          stopping = undefined;
        }
      });
      // New entry is closed synchronously; deactivate also aborts current operations now.
      // Keep a thrown trusted-handle cleanup recoverable alongside all other resources.
      void cleanup(deactivation).catch(() => {});
      return stopping;
    },
  };
  const deactivation: Cleanup = { run: () => handle.deactivate(), done: false };
  cleanups.push(deactivation);
  const localDrain: Cleanup = { done: false, run: async () => {
    // Event callbacks include actor resolution; MCP fetch includes protocol/authentication work.
    while (calls.size) await Promise.allSettled([...calls]);
    await handle.drain();
  } };
  cleanups.push(localDrain);
  addCleanup(async () => {
    await drainGateway();
    // An admitted extension callback may still be resolving its Gateway actor.
    await cleanup(localDrain);
    await drainGateway();
  });
  owners.set(key, session);
  const checkCurrent = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        track(async () => { await handle.list(await resolveActor()); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AppExtensionRuntimeError('EXTENSION_RUNTIME_TIMEOUT')), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    const definitions = createAppJobDefinitions(handle, () => {
      if (stopped) return Promise.reject(new AppExtensionRuntimeError('EXTENSION_RUNTIME_STOP_FAILED'));
      return track(resolveActor);
    });
    if(!options.deferActivation)await checkCurrent();
    const jobs = createJobs?.() ?? createCoreJobRuntime({ shutdownTimeoutMs: timeoutMs });
    addCleanup(async () => {
      const result = await jobs.stop();
      if (!result.drained || result.remaining !== 0) throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_STOP_FAILED');
    });
    jobs.register(...definitions);
    if (createMcpHost) {
      host = createMcpHost(handle);
      addCleanup(() => host!.close());
    }
    // One attachment per descriptor retains prior subscriptions if later setup throws.
    const trackedBus: Pick<CoreEventBus, 'subscribe'> = {
      subscribe<TPayload extends CoreEventPayload>(type: string, handler: CoreEventHandler<TPayload>) {
        return bus.subscribe<TPayload>(type, event => {
          if (!ready || stopped) return;
          return track(() => stopped ? undefined : handler(event));
        });
      },
    };
    for (const descriptor of handle.descriptors.filter(value => value.kind === 'event-subscribe')) {
      const subscription = attachAppEventSubscriptions({ ...handle, descriptors: [descriptor] }, trackedBus, resolveActor);
      addCleanup(() => subscription.stop());
    }
    activatePrepared=async()=>{
      await checkCurrent();
      if(stopped)throw new AppExtensionRuntimeError('EXTENSION_RUNTIME_INVALID');
      for (const definition of definitions) jobs.startInterval(definition.id, { runImmediately: false });
      ready=true;
    };
    if(!options.deferActivation)await session.activate();
    return session;
  } catch (error) {
    try { await session.stop(); } catch { /* The retained session owns reconciliation. */ }
    throw new AppExtensionRuntimeStartError(session);
  }
}
