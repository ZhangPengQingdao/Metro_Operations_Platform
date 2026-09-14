import type { AppManifest } from '@metro/platform-sdk/app-manifest';
import { createAppTestHost } from '@metro/platform-sdk/app-test-kit';
import { TrustedEmbeddedHost, type EmbeddedAppModule } from '../../host/embedded/index.js';

/** Platform-owned local fixture; accepts only the build-pinned module supplied by the preview. */
export function createSdkPreviewSession(manifest: AppManifest, load: (client: ReturnType<typeof createAppTestHost>['client']) => Promise<EmbeddedAppModule>) {
  const approved = JSON.stringify(manifest);
  const harness = createAppTestHost([{ name: 'sample.greeting', execute: async params => {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 1 || !('name' in params) || typeof params.name !== 'string' || params.name.length > 80) throw new Error('INVALID_GREETING');
    return { message: `你好，${params.name}（本地模拟数据）` };
  } }]);
  const host = new TrustedEmbeddedHost<EmbeddedAppModule>({
    loadInstallation: async appId => appId === manifest.id ? { id: 'sdk-preview-installation', revision: 1, enabled: true, manifest: structuredClone(manifest) } : null,
    resolveSession: async () => ({ key: 'sdk-preview-session', actor: {
      actorType: 'person', source: 'session', execution: { type: 'application', appId: manifest.id }, capabilities: [],
      person: { id: 'demo-person', employeeNo: 'DEMO', name: '模拟用户', avatarUrl: null,
        organization: { id: 'demo-org', code: 'demo', name: '模拟组织', unitType: 'workgroup' },
        position: { id: 'demo-position', code: 'demo', name: '模拟岗位' } },
    } }),
    approve: async installation => JSON.stringify(installation.manifest) === approved,
    authorize: async (_installation, _session, permission) => permission === 'sample.greeting.read',
    load: async () => load(harness.client),
    navigate: path => { if (path !== `/platform/apps/${manifest.id}`) throw new Error('UNDECLARED_PREVIEW_ROUTE'); },
  });
  return { host, close() { harness.close(); host.close(); }, drain: harness.drain };
}
