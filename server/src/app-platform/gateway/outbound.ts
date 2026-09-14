import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { assertSafeExternalHttpEndpoint } from '../../core/security/index.js';
import type { PlatformActorContext } from '../../platform/context/index.js';

export class AppOutboundError extends Error {
  constructor(readonly code: 'OUTBOUND_DENIED' | 'OUTBOUND_INVALID' | 'OUTBOUND_LIMIT' | 'OUTBOUND_FAILED' | 'OUTBOUND_ABORTED') {
    super(code); this.name = 'AppOutboundError';
  }
}
export interface AppOutboundPolicy {
  /** Both lists are resolved from current trusted installation/admin state, never request data. */
  declaredOrigins: readonly string[];
  approvedOrigins: readonly string[];
}
export interface AppOutboundInput { url: string; method: 'GET' | 'POST'; body?: string }
export interface AppOutboundResult { status: number; body: string }
export interface AppOutboundOptions {
  policy(context: PlatformActorContext): Promise<AppOutboundPolicy | null>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  /** Trusted infrastructure seams; never populated from application requests. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request?: typeof httpsRequest;
}

/** Named gateway handlers may compose this; it is not an unrestricted public fetch operation. */
export class AppOutboundClient {
  private active = 0;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxConcurrent: number;
  private readonly options: AppOutboundOptions;
  constructor(options: AppOutboundOptions) {
    this.options = { ...options };
    this.timeoutMs = bounded(options.timeoutMs ?? 10_000, 1, 30_000);
    this.maxResponseBytes = bounded(options.maxResponseBytes ?? 262_144, 1, 1_048_576);
    this.maxConcurrent = bounded(options.maxConcurrent ?? 8, 1, 64);
  }
  async execute(context: PlatformActorContext, input: AppOutboundInput, signal: AbortSignal): Promise<AppOutboundResult> {
    if (context.execution.type === 'platform') throw new AppOutboundError('OUTBOUND_DENIED');
    // Snapshot all caller-controlled strings before the first asynchronous boundary.
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['url','method','body'].includes(key))
      || typeof input.url !== 'string' || input.url.length > 2048 || !['GET','POST'].includes(input.method)
      || (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 65_536))
      || (input.method === 'GET' && input.body !== undefined)) throw new AppOutboundError('OUTBOUND_INVALID');
    const body = input.body;
    const method = input.method;
    let url: URL;
    try { url = new URL(input.url); } catch { throw new AppOutboundError('OUTBOUND_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.href !== input.url) throw new AppOutboundError('OUTBOUND_DENIED');
    if (signal.aborted) throw new AppOutboundError('OUTBOUND_ABORTED');
    if (this.active >= this.maxConcurrent) throw new AppOutboundError('OUTBOUND_LIMIT');
    this.active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const work = (async () => {
        const authorize = async () => {
          const policy = await this.options.policy(context);
          if (controller.signal.aborted) throw new AppOutboundError('OUTBOUND_ABORTED');
          if (!policy || !policy.declaredOrigins.includes(url.origin) || !policy.approvedOrigins.includes(url.origin)) throw new AppOutboundError('OUTBOUND_DENIED');
        };
        await authorize();
        // Initial transport supports IPv4 only; reject IPv6 instead of relying on incomplete transition-address policy.
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family }] : await (this.options.lookup ?? (host => lookup(host, { all: true, verbatim: true, family: 4 })))(hostname);
        if (controller.signal.aborted) throw new AppOutboundError('OUTBOUND_ABORTED');
        if (!addresses.length || addresses.length > 32 || addresses.some(a => a.family !== 4 || isIP(a.address) !== 4)) throw new AppOutboundError('OUTBOUND_DENIED');
        // Freeze the DNS answer snapshot. Core checks every answer; no Fake-IP/DoH fallback for app traffic.
        const pinned = addresses.map(a => ({ ...a }));
        try {
          await assertSafeExternalHttpEndpoint(url.href, { lookupAddresses: async () => pinned, lookupPublicAddresses: async () => [] });
        } catch { throw new AppOutboundError('OUTBOUND_DENIED'); }
        await authorize();
        const result = await this.send(url, method, body, pinned[0]!, controller.signal);
        await authorize();
        return result;
      })().finally(() => { this.active--; });
      return await abortable(controller.signal, () => work);
    } catch (error) {
      if (error instanceof AppOutboundError) throw error;
      throw new AppOutboundError(controller.signal.aborted ? 'OUTBOUND_ABORTED' : 'OUTBOUND_FAILED');
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort();
    }
  }
  private send(url: URL, method: string, body: string | undefined, address: { address: string; family: number }, signal: AbortSignal): Promise<AppOutboundResult> {
    return new Promise((resolve, reject) => {
      const request = (this.options.request ?? httpsRequest)(url, {
        method, agent: false, signal, maxHeaderSize: 8192,
        // Preserve hostname for SNI/certificate/Host validation; only DNS resolution is pinned.
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: { accept: 'application/json', 'accept-encoding': 'identity', ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
      }, response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy(); reject(new AppOutboundError('OUTBOUND_FAILED')); return;
        }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) { response.destroy(); request.destroy(); reject(new AppOutboundError('OUTBOUND_LIMIT')); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          try { resolve({ status, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }); }
          catch { reject(new AppOutboundError('OUTBOUND_FAILED')); }
        });
        response.on('error', () => reject(new AppOutboundError('OUTBOUND_FAILED')));
        response.on('aborted', () => reject(new AppOutboundError('OUTBOUND_FAILED')));
      });
      request.on('error', () => reject(new AppOutboundError(signal.aborted ? 'OUTBOUND_ABORTED' : 'OUTBOUND_FAILED')));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new AppOutboundError('OUTBOUND_INVALID');
  return value;
}
function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AppOutboundError('OUTBOUND_ABORTED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
