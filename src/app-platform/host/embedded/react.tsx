import React, { Component, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { PlatformActorProvider } from '../../../platform/index.js';
import { Button, EmptyState } from '../../../components/ui/index.js';
import { TrustedEmbeddedHost, type EmbeddedAppContext, type EmbeddedHostState } from './controller.js';

export interface EmbeddedAppPageProps { context: EmbeddedAppContext }
export interface EmbeddedAppModule { pages: Readonly<Record<string, ComponentType<EmbeddedAppPageProps>>> }
export interface TrustedEmbeddedViewProps { host: TrustedEmbeddedHost<EmbeddedAppModule> }

class AppPageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <EmptyState role="alert" title="应用页面发生错误" description="请重新打开应用。平台其他功能不受此渲染错误影响。" />
      : this.props.children;
  }
}

/** Reusable view, without a router, login form or a second platform layout. */
export function EmbeddedHostView({ state }: { state: EmbeddedHostState<EmbeddedAppModule> }) {
  if (state.status === 'loading') return <div role="status" aria-live="polite">正在加载应用…</div>;
  if (state.status !== 'ready') {
    const descriptions = {
      idle: '请选择应用入口。', denied: '当前身份或应用信任策略不允许打开此页面。',
      unavailable: '应用已停用、未配置或该页面不存在。', error: '应用暂时无法加载，请重新打开。',
    };
    return <EmptyState role={state.status === 'error' ? 'alert' : 'status'} title="应用未打开" description={descriptions[state.status]} />;
  }
  return <AppPageBoundary key={`${state.installation.id}:${state.installation.revision}:${state.session.key}:${state.route.id}`}>
    <PlatformActorProvider actor={state.context.actor}>
      <ReadyPage state={state} />
    </PlatformActorProvider>
  </AppPageBoundary>;
}

function ReadyPage({ state }: { state: Extract<EmbeddedHostState<EmbeddedAppModule>, { status: 'ready' }> }) {
  const pages = state.module?.pages;
  const Page = pages && typeof pages === 'object' && Object.hasOwn(pages, state.route.id) ? pages[state.route.id] : undefined;
  if (!Page || (typeof Page !== 'function' && typeof Page !== 'object')) return <EmptyState role="alert" title="应用入口不完整" description="应用没有提供已声明页面的组件，请联系维护者。" />;
  return <Page context={state.context} />;
}

export function TrustedEmbeddedOutlet({ host }: TrustedEmbeddedViewProps) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  return <EmbeddedHostView state={state} />;
}

/** Shells may consume state.navigation themselves; this minimal menu is optional. */
export function TrustedEmbeddedNavigation({ host }: TrustedEmbeddedViewProps) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [state]);
  if (state.status !== 'ready') return null;
  return <nav aria-label="应用导航">
    {state.navigation.map(item => <Button key={item.id} variant="ghost"
      aria-current={item.routeId === state.route.id ? 'page' : undefined}
      onClick={() => { void state.context.navigate(item.routeId).catch(() => { if (host.getSnapshot() === state) setFailed(true); }); }}>
      {item.label}
    </Button>)}
    {failed && <span role="alert">入口已失效，请重新打开应用。</span>}
  </nav>;
}
