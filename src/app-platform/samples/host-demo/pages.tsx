import React, { useState } from 'react';
import { Button, Surface, Badge } from '../../../components/ui/index.js';
import { usePlatformActor } from '../../../platform/index.js';
import type { EmbeddedAppModule, EmbeddedAppPageProps } from '../../host/embedded/index.js';

function Home({ context }: EmbeddedAppPageProps) {
  const { actor } = usePlatformActor();
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  return <Surface>
    <Badge variant="info">无业务数据示例</Badge>
    <h2>可信应用 · 首页</h2>
    <p>共享的 L3 身份显示：{actor?.person?.name ?? '未登录'}。</p>
    <p>此组件使用 L2 组件库，不包含平台布局或登录页。</p>
    <Button onClick={() => setCount(n => n + 1)}>本页计数：{count}</Button>
    <Button variant="secondary" onClick={() => { void context.navigate('details').catch(() => setFailed(true)); }}>进入说明页</Button>
    {failed && <p role="alert">页面已失效，请从宿主重新打开。</p>}
  </Surface>;
}
function Details() {
  return <Surface>
    <h2>可信应用 · 说明</h2>
    <p>两页均由同一宿主管理。停用、撤销批准或退出演示身份后，宿主立即卸载页面。</p>
    <p>不调用真实业务 API，不获取 Cookie、Token 或数据库连接。</p>
  </Surface>;
}
export const demoModule: EmbeddedAppModule = { pages: { home: Home, details: Details } };
