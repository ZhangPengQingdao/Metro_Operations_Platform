import { randomUUID } from 'node:crypto';
import { jsonSnapshot, type GatewayJson } from '../gateway/model.js';

export const APP_STDIO_API_PREFIX = 'AFC_API_V1 ';
export class AppStdioApiError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'not_started' | 'unknown' = 'not_started') {
    super(code); this.name = 'AppStdioApiError';
  }
}
export interface AppStdioApiRequest { handler: string; method: string; path: string; payload: GatewayJson }
/** Trusted-host transport; authorization belongs to HostedAppApi. No automatic replay. */
export function createAppStdioApiTransport(write: (value: unknown) => Promise<void>, close: () => void, timeoutMs = 10_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new AppStdioApiError('INVALID_OPTIONS');
  let active = true;
  const pending = new Map<string, { finish(value: GatewayJson): void; fail(): void; actual: Promise<void>; settled(): void }>();
  const disconnect = (): void => { active = false; for (const entry of pending.values()) entry.fail(); };
  return {
    async invoke(request: AppStdioApiRequest, signal?: AbortSignal): Promise<GatewayJson> {
      if (!active || signal?.aborted) throw new AppStdioApiError('CLOSED');
      if (pending.size >= 16) throw new AppStdioApiError('BUSY');
      const snapshot = jsonSnapshot(request, 60 * 1024);
      const id = randomUUID();
      let resolve!: (value: GatewayJson) => void, reject!: (error: Error) => void, settled!: () => void;
      const response = new Promise<GatewayJson>((yes, no) => { resolve = yes; reject = no; });
      const actual = new Promise<void>(yes => { settled = yes; });
      const abort = () => reject(new AppStdioApiError('ABORTED', 'unknown'));
      const timer = setTimeout(() => reject(new AppStdioApiError('TIMEOUT', 'unknown')), timeoutMs);
      pending.set(id, { finish: resolve, fail: () => reject(new AppStdioApiError('CLOSED', 'unknown')), actual, settled });
      signal?.addEventListener('abort', abort, { once: true });
      // Write failure may follow delivery. Keep the actual-work slot until a reply or verified stop.
      void write({ id, request: snapshot }).catch(() => { disconnect(); close(); });
      try { return await response; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    accept(value: unknown): void {
      try {
        const frame = jsonSnapshot(value, 256 * 1024) as Record<string, GatewayJson>;
        if (!frame || Array.isArray(frame) || Object.keys(frame).sort().join(',') !== 'id,result' || typeof frame.id !== 'string') throw Error();
        const entry = pending.get(frame.id);
        if (!entry) throw Error();
        pending.delete(frame.id); entry.settled(); entry.finish(frame.result);
      } catch { disconnect(); close(); }
    },
    close: disconnect,
    /** Only trusted executor confirmation of this exact container's stop permits this. */
    confirmContainerStopped(): void {
      disconnect();
      for (const entry of pending.values()) entry.settled();
      pending.clear();
    },
    async drain(): Promise<void> { await Promise.all([...pending.values()].map(entry => entry.actual)); },
  };
}
export type AppStdioApiTransport = ReturnType<typeof createAppStdioApiTransport>;
