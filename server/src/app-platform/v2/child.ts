/**
 * Application model v2 child process entry: `node child.js <server.js> <appId>`.
 * Serves calls from the platform over the IPC channel. Two bundle styles are supported:
 * - `export default defineServer({...})`;
 * - a script that calls `createAppBackend({handlers})` with a handler map (registered through the hosted-runtime hook).
 * The child holds no credentials; every platform capability is executed by the parent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AppBackendHandler, AppHostedRuntimeHook } from '@metro/platform-sdk/app-backend';
import { createAppDataClient, type AppGatewayJson } from '@metro/platform-sdk/app-gateway';
import { AppServerError, createAppServerContext, isAppServerDefinition, type AppServerBaseContext, type AppServerDefinition } from '@metro/platform-sdk/server';
import type { ChildMessage, ParentMessage } from './protocol.js';

const [serverPath, appId] = process.argv.slice(2);
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const send = (message: ChildMessage) => { process.send?.(message); };
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const calls = new Map<string, AbortController>();
/** The employee call a platform request belongs to (absent in start() hooks and timers). */
const currentCall = new AsyncLocalStorage<string>();
const lifetime = new AbortController();
let sequence = 0;

function platform(operation: string, params: unknown, callId = currentCall.getStore()): Promise<AppGatewayJson> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: value => resolve(value as AppGatewayJson), reject });
    send({ t: 'platform', id, ...(callId ? { callId } : {}), operation, params: params ?? null });
  });
}
const gateway = { invoke: (operation: string, params: unknown) => platform(operation, params) } as Parameters<typeof createAppServerContext>[0]['gateway'];
const log = (message: string) => { console.log(message); };
function errorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && CODE.test(code)) return code;
  if (error instanceof Error && CODE.test(error.message)) return error.message;
  return 'APP_HANDLER_FAILED';
}

if (!serverPath || !appId || !process.send) { console.error('child: missing server path, app id or IPC channel'); process.exit(2); }

let mappedHandlers: ReadonlyMap<string, AppBackendHandler> | null = null;
const hook: AppHostedRuntimeHook = {
  register(handlers) { if (mappedHandlers) throw new Error('BACKEND_ALREADY_REGISTERED'); mappedHandlers = handlers; },
  platform: (operation, params) => platform(operation, params),
  signal: lifetime.signal,
};
(globalThis as { __MOP_V2_CHILD__?: AppHostedRuntimeHook }).__MOP_V2_CHILD__ = hook;

const loaded: unknown = (await import(pathToFileURL(serverPath).href)).default;
const definition: AppServerDefinition | null = isAppServerDefinition(loaded) ? loaded : null;
if (!definition && !mappedHandlers) { send({ t: 'fatal', code: 'INVALID_SERVER_EXPORT' }); process.exit(1); }
const handlerNames = definition ? Object.keys(definition.handlers) : [...mappedHandlers!.keys()];

async function dispatch(message: Extract<ParentMessage, { t: 'call' }>, signal: AbortSignal): Promise<unknown> {
  if (definition) {
    const handler = definition.handlers[message.api];
    if (!handler) throw new AppServerError('UNKNOWN_API');
    const context = createAppServerContext({ appId, gateway, employee: message.employee, signal, log });
    return handler(message.input as Parameters<typeof handler>[0], context);
  }
  const handler = mappedHandlers!.get(message.api);
  if (!handler) throw new AppServerError('UNKNOWN_API');
  return handler.execute(message.input as AppGatewayJson, signal, message.employee);
}

process.on('message', (message: ParentMessage) => {
  if (message.t === 'platform-result') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(Object.assign(new AppServerError(message.code), { writeOutcome: message.writeOutcome }));
  } else if (message.t === 'call') {
    const controller = new AbortController();
    calls.set(message.id, controller);
    void currentCall.run(message.id, async () => {
      try {
        const result = await dispatch(message, controller.signal);
        send({ t: 'result', id: message.id, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        if (errorCode(error) === 'APP_HANDLER_FAILED') console.error(`handler ${message.api} failed:`, error);
        send({ t: 'result', id: message.id, ok: false, code: errorCode(error) });
      } finally { calls.delete(message.id); }
    });
  } else if (message.t === 'abort') calls.get(message.id)?.abort();
  else if (message.t === 'stop') {
    lifetime.abort();
    void Promise.resolve(definition?.hooks.stop?.()).catch(error => console.error('stop hook failed:', error)).finally(() => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));

// Ready first: start() typically schedules timers that call the platform, which only serves running apps.
send({ t: 'ready', handlers: handlerNames });
if (definition?.hooks.start) {
  const base: AppServerBaseContext = { appId, data: createAppDataClient(gateway), platform: gateway, signal: lifetime.signal, log, uuid: () => randomUUID() };
  try { await definition.hooks.start(base); } catch (error) { console.error('start hook failed:', error); }
}
