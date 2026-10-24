import type { AppManifest } from '@metro/platform-sdk/app-manifest';

/** Registry-format manifest, shaped like the projection of a `.mopkg` app (page bundle, no back end). */
export const demoManifest: AppManifest = {
  manifestVersion: '1.0', id: 'host-demo', version: '1.0.0', name: '示例应用', description: '无后端的示例', publisherId: 'local',
  compatibility: { platform: { minInclusive: '0.0.1', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
  permissions: { requested: [], defined: [{ code: 'app.host-demo.details', description: '查看示例说明' }] },
  ui: { mode: 'sandbox', entryArtifactId: 'frontend', clientRouting: true }, backend: { mode: 'none' }, storage: { mode: 'none' },
  routes: [{ id: 'home', path: '/' }, { id: 'details', path: '/details', permission: 'app.host-demo.details' }],
  navigation: [{ id: 'home', label: '示例首页', routeId: 'home', order: 0 }, { id: 'details', label: '说明页', routeId: 'details', order: 1 }],
  artifacts: [{ id: 'frontend', kind: 'frontend', path: 'ui.js', bytes: 1, sha256: '0'.repeat(64) }],
  api: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [], resources: [], network: { frontendOrigins: [], backendOrigins: [] },
};
