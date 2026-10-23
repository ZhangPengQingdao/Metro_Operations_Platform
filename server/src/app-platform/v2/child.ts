/**
 * Application model v2 child process entry: `node child.js <server.js> <appId>`.
 * Loads the app's defineServer() bundle and serves calls from the platform over the IPC channel.
 * The child holds no credentials; every platform capability is executed by the parent.
 */
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAppDataClient } from '@metro/platform-sdk/app-gateway';
import { AppServerError, createAppServerContext, isAppServerDefinition, type AppServerBaseContext } from '@metro/platform-sdk/server';
import type { ChildMessage, ParentMessage } from './protocol.js';

const [serverPath, appId] = process.argv.slice(2);
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const send = (message: ChildMessage) => { process.send?.(message); };
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const calls = new Map<string, AbortController>();
const lifetime = new AbortController();
let sequence = 0;

function gateway(callId?: string) {
  return {
    invoke(operation: string, params: unknown) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        send({ t: 'platform', id, ...(callId ? { callId } : {}), operation, params: params ?? null });
      });
    },
  } as Parameters<typeof createAppServerContext>[0]['gateway'];
}
const log = (message: string) => { console.log(message); };
function errorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && CODE.test(code)) return code;
  if (error instanceof Error && CODE.test(error.message)) return error.message;
  return 'APP_HANDLER_FAILED';
}

if (!serverPath || !appId || !process.send) { console.error('child: missing server path, app id or IPC channel'); process.exit(2); }
const loaded: unknown = (await import(pathToFileURL(serverPath).href)).default;
if (!isAppServerDefinition(loaded)) { send({ t: 'fatal', code: 'INVALID_SERVER_EXPORT' }); process.exit(1); }
const definition = loaded;

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
    void (async () => {
      try {
        const handler = definition.handlers[message.api];
        if (!handler) throw new AppServerError('UNKNOWN_API');
        const context = createAppServerContext({ appId, gateway: gateway(message.id), employee: message.employee, signal: controller.signal, log });
        const result = await handler(message.input as Parameters<typeof handler>[0], context);
        send({ t: 'result', id: message.id, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        if (errorCode(error) === 'APP_HANDLER_FAILED') console.error(`handler ${message.api} failed:`, error);
        send({ t: 'result', id: message.id, ok: false, code: errorCode(error) });
      } finally { calls.delete(message.id); }
    })();
  } else if (message.t === 'abort') calls.get(message.id)?.abort();
  else if (message.t === 'stop') {
    lifetime.abort();
    void Promise.resolve(definition.hooks.stop?.()).catch(error => console.error('stop hook failed:', error)).finally(() => process.exit(0));
  }
});
process.on('disconnect', () => process.exit(0));

// Ready first: start() typically schedules timers that call the platform, which only serves running apps.
send({ t: 'ready', handlers: Object.keys(definition.handlers) });
const base: AppServerBaseContext = { appId, data: createAppDataClient(gateway()), platform: gateway(), signal: lifetime.signal, log, uuid: () => randomUUID() };
try { await definition.hooks.start?.(base); } catch (error) { console.error('start hook failed:', error); }
