import type { AppBackendEmployeeContext } from '@metro/platform-sdk/app-backend';

/** IPC messages between the platform (parent) and an application model v2 process (child). */
export type ParentMessage =
  | { t: 'call'; id: string; api: string; input: unknown; employee: AppBackendEmployeeContext }
  | { t: 'abort'; id: string }
  | { t: 'platform-result'; id: number; ok: true; result: unknown }
  | { t: 'platform-result'; id: number; ok: false; code: string; writeOutcome: 'not_started' | 'unknown' }
  | { t: 'stop' };
export type ChildMessage =
  | { t: 'ready'; handlers: string[] }
  | { t: 'fatal'; code: string }
  | { t: 'result'; id: string; ok: true; result: unknown }
  | { t: 'result'; id: string; ok: false; code: string }
  /** `callId` binds a platform call to the employee request it runs in; absent for start() hooks. */
  | { t: 'platform'; id: number; callId?: string; operation: string; params: unknown };
