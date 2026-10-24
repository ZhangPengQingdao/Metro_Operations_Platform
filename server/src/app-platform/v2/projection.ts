import { appPermissionCode, type AppManifestV2 } from '@metro/platform-sdk/manifest';
import type { MopkgInspection } from '@metro/platform-sdk/mopkg';
import { validateAppManifest, type AppManifest } from '../manifest/index.js';

export class AppProjectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AppProjectionError'; }
}

/** Stable v1 route id for a v2 page path: `/` → `home`, `/devices/list` → `devices-list`. */
export function pageRouteId(path: string): string {
  if (path === '/') return 'home';
  return path.slice(1).replace(/[/_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
/** Platform permission behind an app.json `platformAccess` entry (the webhook operation is governed by notifications.create). */
export const platformPermission = (access: string) => access === 'webhook.send' ? 'platform.notifications.create' : `platform.${access}`;
export const migrationArtifactId = (migrationId: string) => `migration-${migrationId.slice(0, 3)}`;

/**
 * Projects an app.json (v2) onto the registry's v1 manifest shape so shared services keep working:
 * employee access, owners and roles, business authorization, navigation and the dashboard.
 * Pages with parameters stay v2-only; the shell resolves them from the stored v2 manifest.
 */
export function projectV2Manifest(manifest: AppManifestV2, inspection: { files: MopkgInspection['files']; migrations: Pick<MopkgInspection['migrations'][number], 'id' | 'file' | 'sha256' | 'bytes'>[] }, sha256: (path: string) => string,
  /** Installed manifest being upgraded: its publisher and recorded migration declarations are kept, so the registry's append-only rule holds. */
  inherit?: AppManifest): AppManifest {
  const full = (code: string) => appPermissionCode(manifest.id, code);
  const bytes = (path: string) => inspection.files.find(file => file.path === path)?.bytes;
  const hasUi = bytes('ui.js') !== undefined, hasServer = bytes('server.js') !== undefined;
  const range = rangeBounds(manifest.platform);
  const routes = manifest.pages.filter(page => !page.path.includes(':')).map(page => ({ id: pageRouteId(page.path), path: page.path, ...(page.permission ? { permission: full(page.permission) } : {}) }));
  if (new Set(routes.map(route => route.id)).size !== routes.length) throw new AppProjectionError('PAGE_ROUTE_ID_CONFLICT');
  const fallbackPermission = manifest.permissions[0] ? full(manifest.permissions[0].code) : undefined;
  const dashboardApi = manifest.api.find(api => api.dashboard);
  const dashboardRoute = routes.find(route => manifest.pages.some(page => page.nav && page.path === route.path)) ?? routes[0];
  // Migrations already recorded for this installation keep their declaration (the installer verified the bytes match).
  const inherited = inherit?.storage.mode === 'managed' ? inherit.storage.migrations.slice(0, inspection.migrations.length) : [];
  const migrationDeclarations = inspection.migrations.map((m, index) => inherited[index] ?? { id: `m${m.id}`, artifactId: migrationArtifactId(m.id) });
  const migrationArtifacts = inspection.migrations.map((m, index) => {
    const previous = inherited[index] && inherit!.artifacts.find(artifact => artifact.id === inherited[index]!.artifactId);
    return previous && previous.sha256 === m.sha256 ? previous : { id: migrationDeclarations[index]!.artifactId, kind: 'migration', path: m.file, sha256: m.sha256, bytes: m.bytes };
  });
  const projected = {
    manifestVersion: '1.0', id: manifest.id, version: manifest.version, name: manifest.name, description: manifest.description, publisherId: inherit?.publisherId ?? 'local',
    compatibility: { platform: range, capabilities: [], applications: [] },
    permissions: {
      requested: [...new Set([...manifest.platformAccess.map(platformPermission), ...(inspection.migrations.length ? ['platform.app_data.read', 'platform.app_data.write'] : [])])],
      defined: manifest.permissions.map(permission => ({ code: full(permission.code), description: permission.name, ...(permission.scopes ? { scopeKinds: [...permission.scopes] } : {}) })),
    },
    ui: hasUi ? { mode: 'sandbox', entryArtifactId: 'frontend', clientRouting: true } : { mode: 'none' },
    backend: hasServer ? { mode: 'isolated', runtime: 'node', entryArtifactId: 'backend', limits: { memoryMiB: manifest.limits?.memoryMiB ?? 256, cpuMillis: 1000, timeoutSeconds: manifest.limits?.timeoutSeconds ?? 30 } } : { mode: 'none' },
    storage: inspection.migrations.length ? { mode: 'managed', migrations: migrationDeclarations } : { mode: 'none' },
    routes,
    navigation: manifest.pages.filter(page => page.nav).map((page, order) => ({ id: pageRouteId(page.path), label: page.title, routeId: pageRouteId(page.path), order })),
    api: manifest.api.map(api => api.permission
      ? { id: api.id, method: 'POST', path: `/${api.id}`, handler: api.id, permission: full(api.permission), businessPermission: full(api.permission),
          ...(api.dashboard ? { expose: { contractVersion: '1.0', mode: 'read', title: '工作台摘要' } } : {}) }
      // No explicit permission: any role in this app may call it.
      : { id: api.id, method: 'POST', path: `/${api.id}`, handler: api.id, permission: fallbackPermission, businessEntry: true }),
    ...(dashboardApi && dashboardRoute ? { dashboard: { apiId: dashboardApi.id, routeId: dashboardRoute.id } } : {}),
    events: { publish: [], subscribe: [] }, tools: [], jobs: [], resources: [],
    network: { frontendOrigins: [], backendOrigins: [] },
    artifacts: [
      ...(hasUi ? [{ id: 'frontend', kind: 'frontend', path: 'ui.js', sha256: sha256('ui.js'), bytes: bytes('ui.js')! }] : []),
      ...(hasServer ? [{ id: 'backend', kind: 'backend', path: 'server.js', sha256: sha256('server.js'), bytes: bytes('server.js')! }] : []),
      ...migrationArtifacts,
    ],
  };
  const result = validateAppManifest(projected);
  if (!result.ok) throw new AppProjectionError(`PROJECTION_INVALID:${result.issues.map(issue => issue.path).join(',')}`);
  return result.manifest;
}

/** `>=a <b` → {minInclusive:a,maxExclusive:b}; open upper bounds stop at the next major version 2.0.0. */
function rangeBounds(range: string) {
  let min = '0.0.0', max = '2.0.0';
  for (const part of range.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(part)!;
    const op = match[1] ?? '=', version = match[2]!.split('-')[0]!;
    if (op === '>=' || op === '=') min = version;
    if (op === '>') min = bump(version);
    if (op === '<') max = version;
    if (op === '<=' || op === '=') max = bump(version);
  }
  return { minInclusive: min, maxExclusive: max };
}
const bump = (version: string) => { const [a, b, c] = version.split('.').map(Number); return `${a}.${b}.${c! + 1}`; };
