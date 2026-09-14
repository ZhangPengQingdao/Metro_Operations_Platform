import type { AppInstallation } from '../registry/model.js';
import type { GatewayJson } from '../gateway/model.js';
import type { PlatformActorContext } from '../../platform/context/index.js';

export type AppExtensionKind = 'event-publish' | 'event-subscribe' | 'job' | 'route' | 'tool';
/** Platform-owned catalog mapping. No executable app code is accepted here. */
export interface AppExtensionMapping {
  kind: AppExtensionKind;
  id: string;
  permissionCode: string;
  operation?: string;
}
export interface AppExtensionDescriptor extends AppExtensionMapping {
  key: string;
  path?: string;
  intervalSeconds?: number;
  navigation?: readonly { id: string; label: string; order: number }[];
}
export interface AppExtensionLimits {
  installations: number;
  contributions: number;
  concurrency: number;
  timeoutMs: number;
  dedupeEntries: number;
  dedupeTtlMs: number;
}
export interface AppExtensionRegistryOptions {
  getInstallation(appId: string): Promise<AppInstallation | null>;
  /** Fresh L3 user/app intersection, including the resource scope of this descriptor. */
  authorize(context: PlatformActorContext, permissionCode: string): Promise<boolean>;
  /** Trusted host must re-resolve identity and invoke L4-006, never call app handlers. */
  executeGateway(context: PlatformActorContext, operation: string, payload: GatewayJson, signal: AbortSignal): Promise<unknown>;
  limits?: Partial<AppExtensionLimits>;
}
export interface AppExtensionHandle {
  /** Process-local revocation of this generation, never serialized to applications. */
  readonly signal?: AbortSignal;
  readonly appId: string;
  readonly installationId: string;
  readonly version: string;
  readonly revision: number;
  readonly generation: number;
  /** Platform composition only; use list(context) for actor-visible discovery. */
  readonly descriptors: readonly AppExtensionDescriptor[];
  list(context: PlatformActorContext): Promise<readonly AppExtensionDescriptor[]>;
  invoke(context: PlatformActorContext, kind: AppExtensionKind, id: string, payload: unknown, signal?: AbortSignal, deliveryKey?: string): Promise<GatewayJson>;
  deactivate(): void;
  /** Trusted teardown only: deactivate first, then wait for actual work settlement. */
  drain(): Promise<void>;
}
export class AppExtensionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppExtensionError'; }
}
