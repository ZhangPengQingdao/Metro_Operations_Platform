import type { AppManifest } from '@metro/platform-sdk/app-manifest';

/** Demo metadata, not a verified distribution package. Loader is a platform-pinned local import. */
export const demoManifest: AppManifest = {
  manifestVersion: '1.0', id: 'host-demo', version: '1.0.0', name: '可信宿主示例', description: '无后端的宿主演示', publisherId: 'platform-demo',
  compatibility: { platform: { minInclusive: '0.0.1', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
  permissions: { requested: [], defined: [{ code: 'app.host-demo.details', description: '查看示例说明' }] },
  ui: { mode: 'trusted', entryArtifactId: 'main' }, backend: { mode: 'none' }, storage: { mode: 'none' },
  routes: [{ id: 'home', path: '/' }, { id: 'details', path: '/details', permission: 'app.host-demo.details' }],
  navigation: [{ id: 'home', label: '示例首页', routeId: 'home', order: 0 }, { id: 'details', label: '说明页', routeId: 'details', order: 1 }],
  artifacts: [{ id: 'main', kind: 'frontend', path: 'demo.js', bytes: 1, sha256: '0'.repeat(64) }],
  api: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [], resources: [], network: { frontendOrigins: [], backendOrigins: [] },
};
