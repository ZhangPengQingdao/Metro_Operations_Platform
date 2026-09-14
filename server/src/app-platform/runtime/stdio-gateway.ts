import { APP_STDIO_API_PREFIX, createAppStdioApiTransport, type AppStdioApiTransport } from './stdio-api.js';
import type { Readable, Writable } from 'node:stream';
import type { AppGateway } from '../gateway/gateway.js';
import { GatewayError, jsonSnapshot } from '../gateway/model.js';

export const APP_STDIO_GATEWAY_PREFIX = 'AFC_GATEWAY_V1 ';
const FRAME_BYTES = 64 * 1024;
const RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING = 16;
const owners = new WeakMap<object, Set<string>>();
export class AppStdioGatewayError extends Error {
  constructor(readonly code: 'INVALID_OPTIONS' | 'ALREADY_OWNED' | 'DRAIN_TIMEOUT' | 'DRAIN_FAILED') {
    super(code); this.name = 'AppStdioGatewayError';
  }
}
export interface AppStdioGatewayOptions {
  /** Trusted composition pins the installation's app; frames cannot override it. */
  appId: string;
  /** Host-only credential snapshot. Never sent to the container. */
  serviceCredential: string;
  gateway: Pick<AppGateway, 'invokeService' | 'drain'>;
  stdout: Readable;
  stdin: Writable;
  shutdownTimeoutMs?: number;
  writeTimeoutMs?: number;
  apiTimeoutMs?: number;
}
export interface AppStdioGatewaySession {
  /** Ingress closed only; this is NOT a drained receipt. Call stop to confirm. */
  closed: Promise<void>;
  api: AppStdioApiTransport;
  stop(): Promise<void>;
}
/**
 * Exclusive process-local owner of a verified container's stdio pair. NDJSON frames:
 * AFC_GATEWAY_V1 {id:UUID,request:GatewayRequest}\n
 * Replies carry {id,response} or {id,error:{code,writeOutcome}} with the same prefix.
 * Ordinary log lines are discarded. Every line, including logs, is bounded to 64KiB.
 * Malformed frames, duplicate in-flight IDs and over-capacity ingress close the pair.
 * No replay cache, reconnect, write retry, credential persistence or log forwarding.
 * Caller must disable registry ingress before stop; this proves no other replica's drain.
 */
export function startAppStdioGateway(options: AppStdioGatewayOptions): AppStdioGatewaySession {
  const { appId, gateway, stdout, stdin, serviceCredential } = options;
  const shutdownMs = options.shutdownTimeoutMs ?? 10_000;
  const writeMs = options.writeTimeoutMs ?? 5_000;
  if (typeof serviceCredential !== 'string' || !/^[A-Za-z0-9._~-]{1,200}$/.test(serviceCredential) ||
    appId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId) ||
    ![shutdownMs, writeMs, options.apiTimeoutMs ?? 10_000].every(ms => Number.isInteger(ms) && ms >= 1 && ms <= 30_000) ||
    stdout.destroyed || stdin.destroyed || stdout.readableEnded || stdin.writableEnded) {
    throw new AppStdioGatewayError('INVALID_OPTIONS');
  }
  let owned = owners.get(gateway);
  if (!owned) { owned = new Set(); owners.set(gateway, owned); }
  if (owned.has(appId)) throw new AppStdioGatewayError('ALREADY_OWNED');
  owned.add(appId);
  const api = createAppStdioApiTransport(value => write(value, APP_STDIO_API_PREFIX), () => close(), options.apiTimeoutMs);
  const controller = new AbortController();
  const pending = new Map<string, Promise<void>>();
  const pendingWrites = new Set<(error?: Error | null) => void>();
  let buffer = Buffer.alloc(0);
  let active = true;
  let releaseClosed!: () => void;
  const closed = new Promise<void>(resolve => { releaseClosed = resolve; });
  let cleanup: Promise<void> | undefined;
  let stopped = false;
  function close(): void {
    if (!active) return;
    active = false;
    buffer = Buffer.alloc(0);
    stdout.removeListener('data', onData);
    controller.abort();
    api.close();
    for (const finish of pendingWrites) finish(new Error('CLOSED'));
    stdout.destroy(); stdin.destroy();
    releaseClosed();
  }
  function write(value: unknown, prefix = APP_STDIO_GATEWAY_PREFIX): Promise<void> {
    if (!active) return Promise.resolve();
    const frame = prefix + JSON.stringify(jsonSnapshot(value, RESPONSE_BYTES)) + '\n';
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); pendingWrites.delete(finish);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { finish(new Error('WRITE_TIMEOUT')); close(); }, writeMs);
      pendingWrites.add(finish);
      try { stdin.write(frame, finish); } catch { finish(new Error('WRITE_FAILED')); }
    });
  }
  function accept(line: Buffer): void {
    if (line.subarray(0, APP_STDIO_API_PREFIX.length).equals(Buffer.from(APP_STDIO_API_PREFIX))) {
      try { api.accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(APP_STDIO_API_PREFIX.length)))); }
      catch { close(); }
      return;
    }
    // Decode only protocol lines. Invalid UTF-8 cannot alias a valid protocol frame.
    if (!line.subarray(0, APP_STDIO_GATEWAY_PREFIX.length).equals(Buffer.from(APP_STDIO_GATEWAY_PREFIX))) return;
    let frame: { id: string; request: unknown };
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(APP_STDIO_GATEWAY_PREFIX.length)));
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'id,request') throw Error();
      frame = value as typeof frame;
      if (typeof frame.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame.id) ||
        pending.has(frame.id.toLowerCase()) || pending.size >= MAX_PENDING) throw Error();
    } catch { close(); return; }
    const id = frame.id;
    const key = id.toLowerCase();
    // Promise boundary guarantees map admission happens before trusted invocation.
    const task = Promise.resolve().then(async () => {
      if (!active) return;
      let reply: unknown;
      try {
        const response = await gateway.invokeService(appId, serviceCredential, frame.request, controller.signal);
        reply = { id, response };
      } catch (error) {
        const safe = error instanceof GatewayError ? error : new GatewayError('GATEWAY_FAILED', 500, 'unknown');
        reply = { id, error: { code: safe.code, writeOutcome: safe.writeOutcome } };
      }
      await write(reply);
    }).catch(() => { close(); }).finally(() => { pending.delete(key); });
    pending.set(key, task);
  }
  function onData(chunk: Buffer | string): void {
    if (!active) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (active && start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(start, end);
      if (buffer.length + part.length > RESPONSE_BYTES) { close(); return; }
      buffer = buffer.length ? Buffer.concat([buffer, part]) : Buffer.from(part);
      if (buffer.length > FRAME_BYTES && !buffer.subarray(0, APP_STDIO_API_PREFIX.length).equals(Buffer.from(APP_STDIO_API_PREFIX))) { close(); return; }
      if (newline < 0) return;
      const line = buffer; buffer = Buffer.alloc(0);
      if (line.length > FRAME_BYTES && !line.subarray(0, APP_STDIO_API_PREFIX.length).equals(Buffer.from(APP_STDIO_API_PREFIX))) { close(); return; }
      accept(line); start = newline + 1;
    }
  }
  stdout.on('data', onData);
  stdout.once('end', close); stdout.once('close', close); stdout.on('error', close);
  stdin.once('close', close); stdin.once('finish', close); stdin.on('error', close);
  return {
    closed, api,
    async stop() {
      close();
      if (stopped) return;
      if (!cleanup) {
        cleanup = (async () => {
          await Promise.all([...pending.values()]);
          await gateway.drain(appId);
          await api.drain();
          stopped = true; owned.delete(appId);
        })();
        // Retain pending cleanup across timeouts; retry only after an actual rejection.
        void cleanup.catch(() => { cleanup = undefined; });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([cleanup, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AppStdioGatewayError('DRAIN_TIMEOUT')), shutdownMs);
        })]);
      } catch (error) {
        throw error instanceof AppStdioGatewayError ? error : new AppStdioGatewayError('DRAIN_FAILED');
      } finally { clearTimeout(timer); }
    },
  };
}
