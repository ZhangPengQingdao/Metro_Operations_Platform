import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { TrustedEmbeddedHost, TrustedEmbeddedOutlet, TrustedEmbeddedNavigation, EmbeddedHostView, type EmbeddedAppModule, type EmbeddedAppPageProps } from '../../src/app-platform/host/embedded/index.ts';
import { demoModule } from '../../src/app-platform/samples/host-demo/pages.tsx';
import { demoManifest } from '../../src/app-platform/samples/host-demo/manifest.ts';
import { validateAppManifest } from '../src/app-platform/manifest/index.ts';
import { readFile } from 'node:fs/promises';

function fixture(module: EmbeddedAppModule = demoModule) {
  return new TrustedEmbeddedHost<EmbeddedAppModule>({
    loadInstallation: async () => ({ id: '00000000-0000-4000-8000-000000000004', revision: 1, enabled: true, manifest: structuredClone(demoManifest) }),
    resolveSession: async () => ({ key: 'session-1', actor: { actorType: 'person', source: 'session', execution: { type: 'application', appId: 'host-demo' }, capabilities: ['app.host-demo.details'],
      person: { id: 'demo', employeeNo: '1', name: 'Shared person', avatarUrl: null, organization: { id: 'org', code: 'org', name: 'Org', unitType: 'workgroup' }, position: { id: 'p', code: 'p', name: 'P' } } } }),
    approve: async () => true, authorize: async () => true, load: async () => module, navigate: () => undefined,
  });
}
test('sample manifest validates and two pages render through shared L2/L3 without a nested shell', async () => {
  assert.equal(validateAppManifest(demoManifest).ok,true);
  const host = fixture();
  await host.open('host-demo','/');
  assert.equal(host.getSnapshot().status,'ready');
  const html = renderToString(<><TrustedEmbeddedNavigation host={host} /><TrustedEmbeddedOutlet host={host} /></>);
  assert.match(html,/Shared person/); assert.match(html,/afc-surface/); assert.match(html,/aria-current="page"/);
  assert.doesNotMatch(html,/<(?:main|aside)|登录页<|<form/);
  const state=host.getSnapshot(); assert.equal(state.status,'ready');
  if(state.status!=='ready') throw Error('not ready');
  await state.context.navigate('details');
  assert.match(renderToString(<TrustedEmbeddedOutlet host={host} />),/可信应用 · 说明/);
  host.close(); assert.doesNotMatch(renderToString(<TrustedEmbeddedOutlet host={host} />),/Shared person/);
});
test('loading, denied, unavailable and malformed module have accessible safe states',async()=>{
  for(const status of ['idle','loading','denied','unavailable'] as const) {
    const html=renderToString(<EmbeddedHostView state={{status}} />); assert.match(html,/role="status"/);
  }
  const host=fixture({pages:{}}); await host.open('host-demo','/');
  assert.match(renderToString(<TrustedEmbeddedOutlet host={host} />),/应用入口不完整/); host.close();
});
test('sample consumes only public L2/L3/host entrypoints and never imports the legacy shell or server',async()=>{
  const source=await readFile(new URL('../../src/app-platform/samples/host-demo/pages.tsx',import.meta.url),'utf8');
  assert.match(source,/components\/ui\/index/); assert.match(source,/platform\/index/);
  assert.doesNotMatch(source,/AppLayout|AuthContext|server\/|fetch\(|localStorage|document\.cookie/);
});
test('memo and forwardRef page components render as valid React module entries',async()=>{
  const MemoPage=React.memo(()=> <p>Memo page</p>);
  const ForwardPage=React.forwardRef<HTMLParagraphElement,EmbeddedAppPageProps>((_props,ref)=> <p ref={ref}>Forward page</p>);
  for(const Page of [MemoPage,ForwardPage]) {
    const host=fixture({pages:{home:Page}}); await host.open('host-demo','/');
    assert.match(renderToString(<TrustedEmbeddedOutlet host={host} />),/(Memo|Forward) page/); host.close();
  }
});
