import {useEffect, useState} from 'react';
import {Button} from '../../../components/ui/Button';
import {employeeRequest, EmployeeRequestError} from '../../employee/client';

export interface AppV2Entry { appId: string; name: string; runtimeRevision: number; v2: { sha256: string; color: string | null; pages: { path: string; title: string; permission?: string }[] } }
export interface Session {
  appId: string; name: string; admissionKey: string; sha256: string; moduleUrl: string; cssUrl?: string;
  route: { path: string; pattern: string; params: Record<string, string>; title: string };
  user: { personId: string; name: string; organizationUnitId: string | null; permissions: string[] };
}
const messageFor = (error: unknown) =>
  error instanceof EmployeeRequestError && error.status === 403 ? '没有访问此页面的权限，或应用授权已变更。'
  : error instanceof Error && error.message === 'INVALID_APP_MODULE' ? '应用页面文件无效，请联系应用开发者重新打包。'
  : '应用页面暂时无法打开。';

/** Renders a v2 application page in place, inside the platform shell (same origin, no iframe). */
export function AppPageV2({ app, path, onNavigate }: { app: AppV2Entry; path: string; onNavigate(path: string): void }) {
  const [attempt, setAttempt] = useState(0);
  // A route/version change must never mount the previous page with its old admission.
  const key = JSON.stringify([app.appId, app.v2.sha256, app.runtimeRevision, path, attempt]);
  return <AppPageSession key={key} app={app} path={path} onNavigate={onNavigate} onRetry={() => setAttempt(value => value + 1)} />;
}


type Host = typeof import('./AppPage');
type Prepared = { View: Host['AppPage']; page: Awaited<ReturnType<Host['preparePage']>> };

function AppPageSession({app, path, onNavigate, onRetry}: {
  app: AppV2Entry; path: string; onNavigate(path: string): void; onRetry(): void
}) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function openPage() {
      const [host, session] = await Promise.all([
        import('./AppPage'),
        employeeRequest<Session>(`/apps/${app.appId}/v2-session?path=${encodeURIComponent(path)}`, {signal: controller.signal, timeoutMs: 15000}),
      ]);
      controller.signal.throwIfAborted();
      const page = await host.preparePage(app.appId, session);
      if (!controller.signal.aborted) setPrepared({View: host.AppPage, page});
    }
    void openPage().catch(reason => {
      if (!controller.signal.aborted) setError(messageFor(reason));
    });
    return () => controller.abort();
  }, [app.appId, path]);

  if (error) return <section className="app-v2" data-app={app.appId}><div className="app-v2-error" role="alert"><p>{error}</p><Button variant="secondary" onClick={onRetry}>重新加载</Button></div></section>;
  if (!prepared) return <section className="app-v2" data-app={app.appId} aria-busy="true"><p className="app-v2-loading" role="status">正在打开{app.name}…</p></section>;
  return <prepared.View app={app} loaded={prepared.page} onNavigate={onNavigate} onRetry={onRetry}/>;
}
