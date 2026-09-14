import { request } from 'node:http';
import { posix } from 'node:path';
import type { AppDockerPolicy } from './docker-policy.js';

export class AppDockerTransportError extends Error {
  constructor(readonly code: string, readonly uncertain: boolean, readonly status?: number) {
    super(code); this.name = 'AppDockerTransportError';
  }
}
export interface AppDockerTransportOptions {
  /** Trusted host configuration only; never inherited from DOCKER_HOST or application input. */
  socketPath: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
type JsonObject = Record<string, unknown>;
export interface AppDockerContainerInspection extends JsonObject {
  Id: string;
  Name: string;
  Image: string;
  Config: JsonObject;
  HostConfig: JsonObject;
  State: JsonObject & { Running: boolean; Status: string };
}
export interface AppDockerImageInspection extends JsonObject {
  Id: string;
  RepoDigests: string[];
  Config: JsonObject;
}
const missing = Symbol('missing');
const idPattern = /^[0-9a-f]{64}$/;
const namePattern = /^afc-app-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const imagePattern = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(): never { throw new AppDockerTransportError('INVALID_INPUT', false); }
function container(value: string): string {
  if (typeof value !== 'string' || (!idPattern.test(value) && !namePattern.test(value))) invalid();
  return encodeURIComponent(value);
}

/** Fixed Engine v1.54 Unix transport. No retries. Mutation errors require observation/reconciliation.
 * Successful HTTP responses are not runtime health or isolation attestations; inspect and compare policy.
 */
export class AppDockerTransport {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private pending = 0;
  constructor(options: AppDockerTransportOptions) {
    if (typeof options.socketPath !== 'string' || !posix.isAbsolute(options.socketPath)
      || posix.normalize(options.socketPath) !== options.socketPath || options.socketPath === '/'
      || options.socketPath.length > 4096 || /[\x00-\x1f\x7f]/.test(options.socketPath)) invalid();
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000
      || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 4 * 1024 * 1024) invalid();
  }
  async createContainer(policy: AppDockerPolicy): Promise<{ Id: string }> {
    if (!policy || typeof policy.name !== 'string' || !namePattern.test(policy.name) || !object(policy.body)) invalid();
    const result = await this.call('POST', `/containers/create?name=${encodeURIComponent(policy.name)}`, [201], policy.body);
    if (!object(result) || typeof result.Id !== 'string' || !idPattern.test(result.Id)) throw new AppDockerTransportError('INVALID_RESPONSE', true);
    return { Id: result.Id };
  }
  async inspectContainer(identity: string): Promise<AppDockerContainerInspection | null> {
    const result = await this.call('GET', `/containers/${container(identity)}/json`, [200, 404]);
    if (result === missing) return null;
    if (!object(result) || typeof result.Id !== 'string' || !idPattern.test(result.Id)
      || typeof result.Name !== 'string' || !result.Name.startsWith('/')
      || typeof result.Image !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(result.Image)
      || !object(result.Config) || !object(result.HostConfig) || !object(result.State)
      || typeof result.State.Running !== 'boolean' || typeof result.State.Status !== 'string') {
      throw new AppDockerTransportError('INVALID_RESPONSE', false);
    }
    return result as AppDockerContainerInspection;
  }
  async inspectImage(reference: string): Promise<AppDockerImageInspection | null> {
    if (typeof reference !== 'string' || reference.length > 256 || !imagePattern.test(reference)) invalid();
    const result = await this.call('GET', `/images/${encodeURIComponent(reference)}/json`, [200, 404]);
    if (result === missing) return null;
    if (!object(result) || typeof result.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(result.Id)
      || !Array.isArray(result.RepoDigests) || !result.RepoDigests.every(x => typeof x === 'string') || !object(result.Config)) {
      throw new AppDockerTransportError('INVALID_RESPONSE', false);
    }
    return result as AppDockerImageInspection;
  }
  async startContainer(identity: string): Promise<void> {
    await this.call('POST', `/containers/${container(identity)}/start`, [204, 304]);
  }
  async stopContainer(identity: string, timeoutSeconds = 5): Promise<void> {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 20) invalid();
    await this.call('POST', `/containers/${container(identity)}/stop?t=${timeoutSeconds}`, [204, 304]);
  }
  /** Never force removal or delete volumes. Caller must establish stopped, owned container first. */
  async removeContainer(identity: string): Promise<void> {
    await this.call('DELETE', `/containers/${container(identity)}?force=false&v=false`, [204]);
  }
  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, statuses: number[], body?: JsonObject): Promise<unknown> {
    let payload: string | undefined;
    try { payload = body === undefined ? undefined : JSON.stringify(body); } catch { invalid(); }
    if (payload !== undefined && Buffer.byteLength(payload) > 64 * 1024) invalid();
    if (this.pending >= 16) throw new AppDockerTransportError('TRANSPORT_BUSY', false);
    this.pending++;
    const mutation = method !== 'GET';
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const req = request({ socketPath: this.socketPath, method, path: `/v1.54${path}`, agent: false,
          maxHeaderSize: 16 * 1024, headers: { Accept: 'application/json', ...(payload === undefined ? {} : {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
          }) } });
        const finish = (error?: AppDockerTransportError, value?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (error) { req.destroy(); reject(error); } else resolve(value);
        };
        const timer = setTimeout(() => finish(new AppDockerTransportError('TIMEOUT', mutation)), this.timeoutMs);
        req.on('error', () => finish(new AppDockerTransportError('CONNECTION_FAILED', mutation)));
        req.on('response', response => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('error', () => finish(new AppDockerTransportError('CONNECTION_FAILED', mutation)));
          response.on('aborted', () => finish(new AppDockerTransportError('CONNECTION_FAILED', mutation)));
          const status = response.statusCode ?? 0;
          // Only a complete create/400 response is a definitive invalid-request rejection.
          const rejectedCreate = method === 'POST' && path.startsWith('/containers/create?') && status === 400;
          if (!statuses.includes(status) && !rejectedCreate) { finish(new AppDockerTransportError('DAEMON_REJECTED', mutation, status)); return; }
          const length = response.headers['content-length'];
          if (length !== undefined && Number(length) > this.maxResponseBytes) {
            finish(new AppDockerTransportError('RESPONSE_TOO_LARGE', mutation)); return;
          }
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > this.maxResponseBytes) { finish(new AppDockerTransportError('RESPONSE_TOO_LARGE', mutation)); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            if (rejectedCreate) { finish(new AppDockerTransportError('CREATE_REQUEST_REJECTED', false, 400)); return; }
            if (status === 404) { finish(undefined, missing); return; }
            if (status === 204 || status === 304) { finish(undefined); return; }
            try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { finish(new AppDockerTransportError('INVALID_RESPONSE', mutation)); }
          });
        });
        req.end(payload);
      });
    } catch (error) {
      if (error instanceof AppDockerTransportError) throw error;
      throw new AppDockerTransportError('CONNECTION_FAILED', mutation);
    } finally { this.pending--; }
  }
}
