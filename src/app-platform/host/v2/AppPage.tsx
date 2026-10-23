import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppRuntimeProvider, isAppDefinition, type AppDefinition, type AppFiles, type AppRuntime } from '@metro/platform-sdk/app';
import { createPlatformDirectoryClient } from '@metro/platform-sdk/app-directory';
import type { AppGatewayJson } from '@metro/platform-sdk/app-gateway';
import { Button, ConfirmDialog, useToast } from '../../../components/ui';
import { employeeRequest, EmployeeRequestError } from '../../employee/client';
import { installSharedModules } from './shared';

export interface AppV2Entry { appId: string; name: string; runtimeRevision: number; v2: { sha256: string; color: string | null; pages: { path: string; title: string; permission?: string }[] } }
interface Session {
  appId: string; name: string; admissionKey: string; sha256: string; moduleUrl: string; cssUrl?: string;
  route: { path: string; pattern: string; params: Record<string, string>; title: string };
  user: { personId: string; name: string; organizationUnitId: string | null; permissions: string[] };
}
type Loaded = { session: Session; definition: AppDefinition };

const modules = new Map<string, Promise<AppDefinition>>();
/** Bundles are content-addressed, so each version is loaded once per page lifetime. */
function loadDefinition(url: string) {
  let value = modules.get(url);
  if (!value) {
    installSharedModules();
    value = import(/* @vite-ignore */ url).then((module: { default?: unknown }) => {
      if (!isAppDefinition(module.default)) throw new Error('INVALID_APP_MODULE');
      return module.default;
    });
    value.catch(() => modules.delete(url));
    modules.set(url, value);
  }
  return value;
}
function ensureStylesheet(appId: string, url: string | undefined) {
  for (const link of document.querySelectorAll<HTMLLinkElement>(`link[data-app-css="${appId}"]`)) if (link.getAttribute('href') !== url) link.remove();
  if (!url || document.querySelector(`link[data-app-css="${appId}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = url; link.dataset.appCss = appId;
  document.head.appendChild(link);
}
/** Original-file access for one page session; the server re-authorizes every request through the app. */
function createFiles(appId: string, admissionKey: string): AppFiles {
  const headers = { 'X-Mop-Employee-Admission': admissionKey };
  const fail = async (response: Response) => {
    const body = await response.json().catch(() => null) as { error?: string | { code?: string } } | null;
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code ?? 'FILE_REQUEST_FAILED';
    if (response.status === 401) window.dispatchEvent(new Event('mop-employee-session-expired'));
    throw new EmployeeRequestError(response.status, code);
  };
  const download = async (attachmentId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/employee/apps/${appId}/attachments/${encodeURIComponent(attachmentId)}`, { credentials: 'same-origin', headers, ...(signal ? { signal } : {}) });
    if (!response.ok) await fail(response);
    return { blob: await response.blob(), fileName: decodeURIComponent(response.headers.get('X-Mop-Attachment-Name') ?? 'file') };
  };
  return {
    async upload(file, target, options) {
      const query = new URLSearchParams({ entityType: target.entityType, entityId: target.entityId, intentId: target.intentId ?? crypto.randomUUID(), fileName: target.fileName ?? (file instanceof File ? file.name : 'file') });
      const response = await fetch(`/api/employee/apps/${appId}/attachments?${query}`, { method: 'POST', credentials: 'same-origin', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: file, ...(options?.signal ? { signal: options.signal } : {}) });
      if (!response.ok) await fail(response);
      return response.json();
    },
    async list(target, options) {
      const query = new URLSearchParams({ entityType: target.entityType, entityId: target.entityId, ...(target.afterId ? { afterId: target.afterId } : {}) });
      const response = await fetch(`/api/employee/apps/${appId}/attachments?${query}`, { credentials: 'same-origin', headers, ...(options?.signal ? { signal: options.signal } : {}) });
      if (!response.ok) await fail(response);
      return response.json();
    },
    download: (attachmentId, options) => download(attachmentId, options?.signal),
    async save(attachmentId) {
      const { blob, fileName } = await download(attachmentId);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}

const messageFor = (error: unknown) =>
  error instanceof EmployeeRequestError && error.status === 403 ? '没有访问此页面的权限，或应用授权已变更。'
  : error instanceof Error && error.message === 'INVALID_APP_MODULE' ? '应用页面文件无效，请联系应用开发者重新打包。'
  : '应用页面暂时无法打开。';

class AppErrorBoundary extends React.Component<{ children: React.ReactNode; onRetry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('应用页面出错', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="app-v2-error" role="alert"><p>应用页面出错。</p><Button variant="secondary" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}>重新加载</Button></div>;
  }
}

/** Renders a v2 application page in place, inside the platform shell (same origin, no iframe). */
export function AppPageV2({ app, path, onNavigate }: { app: AppV2Entry; path: string; onNavigate(path: string): void }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [confirmation, setConfirmation] = useState<{ title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve(value: boolean): void } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    employeeRequest<Session>(`/apps/${app.appId}/v2-session?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(async session => { ensureStylesheet(app.appId, session.cssUrl); return { session, definition: await loadDefinition(session.moduleUrl) }; })
      .then(value => { if (!controller.signal.aborted) setLoaded(value); })
      .catch(reason => { if (!controller.signal.aborted) { setLoaded(null); setError(messageFor(reason)); } });
    return () => controller.abort();
  }, [app.appId, app.v2.sha256, app.runtimeRevision, path, attempt]);

  const session = loaded?.session;
  const runtime = useMemo<AppRuntime | null>(() => {
    if (!session) return null;
    const short = (code: string) => code.startsWith(`app.${session.appId}.`) ? code.slice(session.appId.length + 5) : code;
    const platform = {
      async invoke(operation: string, params?: AppGatewayJson, signal?: AbortSignal) {
        const response = await employeeRequest<{ result: AppGatewayJson }>(`/apps/${session.appId}/v2-platform`, { method: 'POST', body: { operation, params: params ?? {} }, admissionKey: session.admissionKey, ...(signal ? { signal } : {}) });
        return response.result;
      },
    };
    return {
      platform, directory: createPlatformDirectoryClient(platform), files: createFiles(session.appId, session.admissionKey),
      appId: session.appId,
      user: { personId: session.user.personId, name: session.user.name, organizationUnitId: session.user.organizationUnitId ?? '', permissions: session.user.permissions, has: code => session.user.permissions.includes(short(code)) },
      route: { path: session.route.path, params: session.route.params },
      api: {
        async call(apiId, input, options) {
          const response = await employeeRequest<{ result: never }>(`/apps/${session.appId}/api`, {
            method: 'POST', body: { apiId, method: 'POST', path: `/${apiId}`, payload: input ?? {} }, admissionKey: session.admissionKey, ...(options?.signal ? { signal: options.signal } : {}),
          });
          return response.result;
        },
      },
      navigate: target => onNavigate(target),
      toast: (message, tone = 'info') => { if (tone === 'success') toast.success(message); else if (tone === 'error') toast.error(message); else toast.info(message); },
      confirm: options => new Promise<boolean>(resolve => setConfirmation({ ...options, resolve })),
    };
  }, [session, onNavigate, toast]);
  const settle = useCallback((value: boolean) => setConfirmation(current => { current?.resolve(value); return null; }), []);

  if (error) return <section className="app-v2" data-app={app.appId}><div className="app-v2-error" role="alert"><p>{error}</p><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>重新加载</Button></div></section>;
  if (!loaded || !runtime) return <section className="app-v2" data-app={app.appId} aria-busy="true"><p className="app-v2-loading" role="status">正在打开{app.name}…</p></section>;
  const Page = loaded.definition.pages[loaded.session.route.pattern];
  return <section className="app-v2" data-app={app.appId}>
    <header className="app-v2-heading"><h1>{loaded.session.route.title}</h1></header>
    {Page
      ? <AppErrorBoundary key={`${loaded.session.sha256}:${path}`} onRetry={() => setAttempt(value => value + 1)}><AppRuntimeProvider runtime={runtime}><Page params={loaded.session.route.params} /></AppRuntimeProvider></AppErrorBoundary>
      : <div className="app-v2-error" role="alert"><p>应用没有提供此页面，请联系应用开发者。</p></div>}
    <ConfirmDialog isOpen={!!confirmation} title={confirmation?.title ?? '操作确认'} message={confirmation?.message ?? ''} confirmText={confirmation?.confirmLabel ?? '确定'}
      variant={confirmation?.danger ? 'danger' : 'primary'} onClose={() => settle(false)} onConfirm={() => settle(true)} />
  </section>;
}
