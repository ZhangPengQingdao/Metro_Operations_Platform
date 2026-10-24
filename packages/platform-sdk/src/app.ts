/** Application model v2 front end. Apps export `defineApp(...)`; the platform shell renders its pages in place, same origin. */
import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react';
import type { AppGatewayJson } from './app-gateway.js';
import type { createPlatformDirectoryClient } from './app-directory.js';
import { isAppPagePath } from './manifest.js';

export interface AppPageProps { params: Readonly<Record<string, string>> }
export interface AppDefinition {
  readonly kind: 'mop-app';
  readonly version: 1;
  /** Keys are page paths from app.json `pages`, e.g. `/` or `/records/:id`. */
  readonly pages: Readonly<Record<string, ComponentType<AppPageProps>>>;
  /** Optional employee-dashboard card. */
  readonly dashboard?: ComponentType;
}

export interface AppUser {
  readonly personId: string;
  readonly name: string;
  readonly organizationUnitId: string;
  /** Short permission codes from app.json granted to this employee, e.g. `read`. */
  readonly permissions: readonly string[];
  has(permission: string): boolean;
}

export interface AppAttachment { attachmentId: string; fileName: string; contentType: string; sizeBytes: number; createdAt?: string }
/**
 * Original files attached to a business record (`entityType` + `entityId`). The app must provide an
 * `authorize-attachment` API that returns `{organizationId}` for the record, and request
 * `attachments.create` / `attachments.read` in app.json. Files up to 50MB: Word, Excel, PDF, ZIP and images.
 */
export interface AppFiles {
  upload(file: Blob, target: { entityType: string; entityId: string; fileName?: string; intentId?: string }, options?: { signal?: AbortSignal }): Promise<AppAttachment>;
  list(target: { entityType: string; entityId: string; afterId?: string }, options?: { signal?: AbortSignal }): Promise<{ attachments: AppAttachment[]; nextCursor: string | null }>;
  download(attachmentId: string, options?: { signal?: AbortSignal }): Promise<{ blob: Blob; fileName: string }>;
  /** Downloads and hands the file to the browser's save dialog. */
  save(attachmentId: string): Promise<void>;
}

/** Supplied by the platform shell. Server-side authorization still applies to every call. */
export interface AppRuntime {
  readonly appId: string;
  readonly user: AppUser;
  readonly route: { readonly path: string; readonly params: Readonly<Record<string, string>> };
  readonly api: { call<T = AppGatewayJson>(apiId: string, input?: AppGatewayJson, options?: { signal?: AbortSignal }): Promise<T> };
  /** Read-only platform directory calls from the page (people, organizations, lines and stations, assets), using the app's grants. */
  readonly platform: { invoke(operation: string, params?: AppGatewayJson, signal?: AbortSignal): Promise<AppGatewayJson> };
  /** Typed helpers over `platform`, e.g. `directory.members({organizationUnitId})`, `directory.responsibleStations(...)`. */
  readonly directory: ReturnType<typeof createPlatformDirectoryClient>;
  readonly files: AppFiles;
  navigate(path: string): void;
  toast(message: string, tone?: 'success' | 'error' | 'info'): void;
  confirm(options: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
}

export { saveAs } from './save-file.js';

const AppRuntimeContext = createContext<AppRuntime | null>(null);

export function defineApp(definition: { pages: Record<string, ComponentType<AppPageProps>>; dashboard?: ComponentType }): AppDefinition {
  const pages = definition?.pages;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages) || !Object.keys(pages).length) throw new TypeError('defineApp: pages 至少需要一个页面');
  for (const [path, component] of Object.entries(pages)) {
    if (!isAppPagePath(path)) throw new TypeError(`defineApp: 页面路径无效 ${path}`);
    if (typeof component !== 'function' && (typeof component !== 'object' || component === null)) throw new TypeError(`defineApp: 页面 ${path} 不是 React 组件`);
  }
  if (definition.dashboard !== undefined && typeof definition.dashboard !== 'function' && typeof definition.dashboard !== 'object') throw new TypeError('defineApp: dashboard 不是 React 组件');
  return Object.freeze({ kind: 'mop-app', version: 1, pages: Object.freeze({ ...pages }), ...(definition.dashboard ? { dashboard: definition.dashboard } : {}) });
}

export function isAppDefinition(value: unknown): value is AppDefinition {
  return !!value && typeof value === 'object' && (value as AppDefinition).kind === 'mop-app' && (value as AppDefinition).version === 1;
}

/** Used by the platform shell and by app tests to provide the runtime. */
export function AppRuntimeProvider({ runtime, children }: { runtime: AppRuntime; children?: ReactNode }) {
  return createElement(AppRuntimeContext.Provider, { value: runtime }, children);
}

export function useApp(): AppRuntime {
  const runtime = useContext(AppRuntimeContext);
  if (!runtime) throw new Error('useApp 只能在平台渲染的应用页面中使用');
  return runtime;
}
