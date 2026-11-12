import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppRuntimeProvider, isAppDefinition, type AppDefinition, type AppFiles, type AppRuntime } from '@metro/platform-sdk/app';
import { createPlatformDirectoryClient } from '@metro/platform-sdk/app-directory';
import type { AppGatewayJson } from '@metro/platform-sdk/app-gateway';
import { ConfirmDialog, useToast } from '../../../components/ui';
import { employeeRequest, EmployeeRequestError } from '../../employee/client';
import { installSharedModules } from './shared';
import {AppErrorBoundary} from './AppErrorBoundary';
import type {AppV2Entry, Session} from './AppPageEntry';

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
    async transcribe(file,format,options){
      const response=await fetch(`/api/employee/apps/${appId}/transcription?format=${encodeURIComponent(format)}`,{method:'POST',credentials:'same-origin',headers:{...headers,'Content-Type':'application/octet-stream'},body:file,signal:options?.signal});
      if(!response.ok)await fail(response);
      return response.json();
    },
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
    async saveArchive(input,options){
      type PickerWindow=Window&{showSaveFilePicker?:(input:{suggestedName:string})=>Promise<{createWritable():Promise<WritableStream<Uint8Array>>}>};
      const picker=(window as PickerWindow).showSaveFilePicker;
      // Open the picker in the user gesture before waiting on any network calls.
      const handle=picker?await picker.call(window,{suggestedName:input.fileName}):null;
      const response=await fetch(`/api/employee/apps/${appId}/attachments-archive`,{method:'POST',credentials:'same-origin',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(input),signal:options?.signal});
      if(!response.ok)await fail(response);
      if(handle&&response.body){const writable=await handle.createWritable();await response.body.pipeTo(writable,{signal:options?.signal});return;}
      // Browsers without a disk writer have a deliberately bounded Blob fallback.
      if(Number(response.headers.get('Content-Length')??Infinity)>256*1024*1024){await response.body?.cancel();throw Error('当前浏览器无法保存超过 256 MiB 的压缩包，请减少选择或使用支持文件保存的浏览器');}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=input.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },
  };
}

export async function preparePage(appId: string, session: Session): Promise<Loaded> {
  ensureStylesheet(appId, session.cssUrl);
  return {session, definition: await loadDefinition(session.moduleUrl)};
}

export function AppPage({app, loaded, onNavigate, onRetry}: {
  app: AppV2Entry; loaded: Loaded; onNavigate(path: string): void; onRetry(): void
}) {
  const toast = useToast();
  const [confirmation, setConfirmation] = useState<{ title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve(value: boolean): void } | null>(null);
  // Navigating away also cancels a pending confirmation instead of leaving its caller waiting.
  useEffect(() => () => confirmation?.resolve(false), [confirmation]);

  const session = loaded.session;
  const runtime = useMemo<AppRuntime>(() => {
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

  const Page = loaded.definition.pages[loaded.session.route.pattern];
  return <section className="app-v2" data-app={app.appId}>
    <header className="app-v2-heading"><h1>{loaded.session.route.title}</h1></header>
    {Page
      ? <AppErrorBoundary onRetry={onRetry}><AppRuntimeProvider runtime={runtime}><Page params={loaded.session.route.params} /></AppRuntimeProvider></AppErrorBoundary>
      : <div className="app-v2-error" role="alert"><p>应用没有提供此页面，请联系应用开发者。</p></div>}
    <ConfirmDialog isOpen={!!confirmation} title={confirmation?.title ?? '操作确认'} message={confirmation?.message ?? ''} confirmText={confirmation?.confirmLabel ?? '确定'}
      variant={confirmation?.danger ? 'danger' : 'primary'} onClose={() => settle(false)} onConfirm={() => settle(true)} />
  </section>;
}
