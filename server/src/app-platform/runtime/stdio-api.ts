import type { PlatformPersonActorContext } from '../../platform/context/index.js';
import { randomUUID } from 'node:crypto';
import type { AppBackendEmployeeContext } from '@metro/platform-sdk/app-backend';
import { jsonSnapshot, type GatewayJson } from '../gateway/model.js';

export const APP_STDIO_API_PREFIX = 'AFC_API_V1 ';
export class AppStdioApiError extends Error {
  constructor(readonly code: string, readonly writeOutcome: 'not_started' | 'unknown' = 'not_started') {
    super(code); this.name = 'AppStdioApiError';
  }
}
export interface AppStdioApiRequest { handler: string; method: string; path: string; payload: GatewayJson; employee?: AppBackendEmployeeContext }
/** Trusted-host transport; authorization belongs to HostedAppApi. No automatic replay. */
export function createAppStdioApiTransport(write: (value: unknown) => Promise<void>, close: () => void, timeoutMs = 10_000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new AppStdioApiError('INVALID_OPTIONS');
  let active = true;
  const pending = new Map<string, { finish(value: GatewayJson): void; fail(): void; actual: Promise<void>; settled(): void; admitted:boolean; requestId?:string; assertAdmission?:()=>Promise<void>; resolveEmployee?:()=>Promise<PlatformPersonActorContext> }>();
  const disconnect = (): void => { active = false; for (const entry of pending.values()) entry.fail(); };
  return {
    async invoke(request: AppStdioApiRequest, signal?: AbortSignal, assertAdmission?:()=>Promise<void>, resolveEmployee?:()=>Promise<PlatformPersonActorContext>): Promise<GatewayJson> {
      if (!active || signal?.aborted) throw new AppStdioApiError('CLOSED');
      if (pending.size >= 16) throw new AppStdioApiError('BUSY');
      const snapshot = jsonSnapshot(request, 60 * 1024);
      const id = randomUUID();
      let resolve!: (value: GatewayJson) => void, reject!: (error: Error) => void, settled!: () => void;
      const response = new Promise<GatewayJson>((yes, no) => { resolve = yes; reject = no; });
      const actual = new Promise<void>(yes => { settled = yes; });
      const invalidate=()=>{const entry=pending.get(id);if(entry)entry.admitted=false;};
      const abort = () => {invalidate();reject(new AppStdioApiError('ABORTED', 'unknown'));};
      const timer = setTimeout(() => {invalidate();reject(new AppStdioApiError('TIMEOUT', 'unknown'));}, timeoutMs);
      pending.set(id, { finish: resolve, fail: () => reject(new AppStdioApiError('CLOSED', 'unknown')), actual, settled, admitted:true, requestId:request.employee?.requestId, assertAdmission, resolveEmployee });
      signal?.addEventListener('abort', abort, { once: true });
      // Write failure may follow delivery. Keep the actual-work slot until a reply or verified stop.
      void write({ id, request: snapshot }).catch(() => { disconnect(); close(); });
      try { return await response; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    /** Host callback only. An opaque frame ID is useful solely while its original API call is live. */
    admissionGuard(id:string):()=>Promise<void> {
      const entry=pending.get(id);
      return async()=>{
        const check=()=>{if(!active||!entry?.admitted||!entry.assertAdmission||pending.get(id)!==entry)throw new AppStdioApiError('ACCESS_DENIED');};
        check();await entry!.assertAdmission!();check();
      };
    },
    employeeResolver(id:string): (()=>Promise<PlatformPersonActorContext>) | undefined {
      const entry=pending.get(id);
      if(!entry?.resolveEmployee)return undefined;
      const guard=this.admissionGuard(id);
      return async()=>{await guard();const actor=await entry.resolveEmployee!();await guard();return actor;};
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
    /** Wait only for this caller's actual reply; unrelated API calls cannot block delivery. */
    async drainRequest(requestId:string):Promise<void> {
      await Promise.all([...pending.values()].filter(entry=>entry.requestId===requestId).map(entry=>entry.actual));
    },
    async drain(): Promise<void> { await Promise.all([...pending.values()].map(entry => entry.actual)); },
  };
}
export type AppStdioApiTransport = ReturnType<typeof createAppStdioApiTransport>;
