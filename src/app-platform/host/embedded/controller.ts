import type { AppManifest } from '@metro/platform-sdk/app-manifest';
import type { PlatformActorSnapshot } from '../../../platform/index.js';

export interface EmbeddedInstallation { id: string; revision: number; enabled: boolean; manifest: AppManifest }
export interface EmbeddedSession { key: string; actor: PlatformActorSnapshot }
export interface EmbeddedAppContext {
  actor: PlatformActorSnapshot;
  signal: AbortSignal;
  navigate(routeId: string): Promise<void>;
}
export interface EmbeddedNavigation { id: string; label: string; routeId: string; path: string; order: number }
export type EmbeddedHostState<Module> =
  | { status: 'idle' | 'loading' | 'unavailable' | 'denied' }
  | { status: 'error'; message: string }
  | { status: 'ready'; module: Module; route: { id: string; path: string }; installation: EmbeddedInstallation;
    session: EmbeddedSession; navigation: readonly EmbeddedNavigation[]; context: EmbeddedAppContext };

/** Platform-owned adapters only. Neither a manifest nor ui.mode grants trust. */
export interface EmbeddedHostOptions<Module> {
  loadInstallation(appId: string, signal: AbortSignal): Promise<EmbeddedInstallation | null>;
  resolveSession(signal: AbortSignal): Promise<EmbeddedSession | null>;
  approve(installation: EmbeddedInstallation, signal: AbortSignal): Promise<boolean>;
  authorize(installation: EmbeddedInstallation, session: EmbeddedSession, permission: string, signal: AbortSignal): Promise<boolean>;
  /** Must resolve an explicitly approved installed artifact, never an app-supplied URL. */
  load(installation: EmbeddedInstallation, signal: AbortSignal): Promise<Module>;
  navigate(path: string): void;
}

const identifier = (s: string) => typeof s === 'string' && s.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(s);
const routePath = (s: string) => typeof s === 'string' && s.length <= 256 && (s === '/' || /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(s));
const permissionCode = (s: string) => typeof s === 'string' && s.length <= 192 && /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(s);
const bounded = (values: unknown): values is unknown[] => Array.isArray(values) && values.length <= 128;
const namespaced = (appId: string, path: string) => `/platform/apps/${appId}${path === '/' ? '' : path}`;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function detached<T>(value: T): T { return freeze(structuredClone(value)); }

/** Host projection guard; full manifest/provenance validation belongs to installation ingress. */
function validInstallation(value: EmbeddedInstallation, appId: string): boolean {
  const m = value.manifest;
  if (typeof value.id !== 'string' || !value.id.length || value.id.length > 128 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.enabled !== 'boolean' || !m || m.manifestVersion !== '1.0' || m.id !== appId || m.ui?.mode !== 'trusted'
    || typeof m.version !== 'string' || m.version.length > 96 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(m.version)
    || !bounded(m.routes) || !bounded(m.navigation) || !bounded(m.artifacts)
    || !bounded(m.permissions?.requested) || !bounded(m.permissions?.defined)) return false;
  const permissions = [...m.permissions.requested, ...m.permissions.defined.map((x) => x.code)];
  if (!permissions.every(permissionCode)) return false;
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const route of m.routes) {
    if (!identifier(route.id) || !routePath(route.path) || ids.has(route.id) || paths.has(route.path)
      || (route.permission !== undefined && (!permissionCode(route.permission) || !permissions.includes(route.permission)))) return false;
    ids.add(route.id); paths.add(route.path);
  }
  const navigationIds = new Set<string>();
  for (const item of m.navigation) {
    if (!identifier(item.id) || navigationIds.has(item.id) || !ids.has(item.routeId) || typeof item.label !== 'string'
      || !item.label.length || item.label.length > 128 || item.label.trim() !== item.label || /[\x00-\x1f\x7f]/.test(item.label)
      || !Number.isInteger(item.order) || item.order < 0 || item.order > 10000) return false;
    navigationIds.add(item.id);
  }
  const entryArtifactId = m.ui.entryArtifactId;
  const artifacts = m.artifacts.filter((artifact) => artifact.id === entryArtifactId);
  const artifact = artifacts[0];
  return artifacts.length === 1 && artifact.kind === 'frontend' && identifier(artifact.id)
    && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
    && typeof artifact.path === 'string' && artifact.path.length <= 256
    && /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)*$/.test(artifact.path);
}

class AdmissionFailure extends Error {
  constructor(readonly status: 'unavailable' | 'denied') { super(status); }
}

/** Trusted same-origin UI lifecycle, NOT a sandbox or an API authorization boundary. */
export class TrustedEmbeddedHost<Module> {
  private state: EmbeddedHostState<Module> = Object.freeze({ status: 'idle' });
  private readonly listeners = new Set<() => void>();
  private active?: AbortController;
  private generation = 0;
  private target?: { appId: string; path: string };
  constructor(private readonly options: EmbeddedHostOptions<Module>) {}

  getSnapshot = (): EmbeddedHostState<Module> => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  close(): void {
    const generation = ++this.generation; const previous = this.active;
    this.target = undefined; this.active = undefined; previous?.abort();
    if (this.generation === generation) this.publish({ status: 'idle' });
  }

  refresh(): Promise<void> {
    if (this.target) return this.open(this.target.appId, this.target.path);
    this.close(); return Promise.resolve();
  }

  /** Only canonical app-relative static paths are accepted; output paths are namespaced. */
  async open(appId: string, path: string): Promise<void> {
    this.generation++; const previous = this.active; const controller = new AbortController(); this.active = controller;
    this.target = { appId, path }; previous?.abort();
    // Abort listeners run synchronously and may open a newer target or close the host.
    if (this.active !== controller || controller.signal.aborted) return;
    this.publish({ status: 'loading' });
    try {
      if (!identifier(appId) || !routePath(path)) throw new AdmissionFailure('unavailable');
      const before = await this.admit(appId, path, controller);
      this.assertLive(controller);
      const module = await this.options.load(before.installation, controller.signal);
      this.assertLive(controller);
      const after = await this.admit(appId, path, controller);
      if (JSON.stringify(before.installation) !== JSON.stringify(after.installation) || JSON.stringify(before.session) !== JSON.stringify(after.session)) {
        throw new AdmissionFailure('unavailable');
      }
      this.assertLive(controller);
      const context: EmbeddedAppContext = Object.freeze({ actor: after.session.actor, signal: controller.signal,
        navigate: async (routeId: string) => {
          this.assertLive(controller);
          const destination = after.installation.manifest.routes.find((route) => route.id === routeId);
          if (!destination) throw new AdmissionFailure('unavailable');
          // open invalidates this context synchronously; retain the NEW generation for the callback.
          const generation = this.generation + 1;
          const operation = this.open(appId, destination.path); const navigating = this.active;
          await operation;
          if (this.generation === generation && this.active === navigating && this.state.status === 'ready' && !navigating?.signal.aborted) {
            this.options.navigate(namespaced(appId, destination.path));
          }
        },
      });
      this.publish({ status: 'ready', module, installation: after.installation, session: after.session,
        route: Object.freeze({ id: after.route.id, path: namespaced(appId, after.route.path) }), navigation: after.navigation, context });
    } catch (error) {
      if (this.active !== controller || controller.signal.aborted) return;
      controller.abort();
      if (this.active !== controller) return;
      this.publish(error instanceof AdmissionFailure ? { status: error.status } : { status: 'error', message: 'Application could not be opened.' });
    }
  }

  private assertLive(controller: AbortController): void {
    if (this.active !== controller || controller.signal.aborted) throw new Error('Application context is no longer active.');
  }

  private async admit(appId: string, path: string, controller: AbortController) {
    const rawInstallation = await this.options.loadInstallation(appId, controller.signal); this.assertLive(controller);
    if (!rawInstallation || !validInstallation(rawInstallation, appId)) throw new AdmissionFailure('unavailable');
    const installation = detached(rawInstallation);
    if (!installation.enabled) throw new AdmissionFailure('unavailable');
    const rawSession = await this.options.resolveSession(controller.signal); this.assertLive(controller);
    if (!rawSession || typeof rawSession.key !== 'string' || !rawSession.key.length || rawSession.key.length > 512 || !rawSession.actor) throw new AdmissionFailure('denied');
    const session = detached(rawSession);
    if (await this.options.approve(installation, controller.signal) !== true) throw new AdmissionFailure('denied');
    this.assertLive(controller);
    const route = installation.manifest.routes.find((candidate) => candidate.path === path);
    if (!route) throw new AdmissionFailure('unavailable');
    const allowed = async (permission?: string) => {
      const result = permission === undefined || await this.options.authorize(installation, session, permission, controller.signal) === true;
      this.assertLive(controller); return result;
    };
    if (!await allowed(route.permission)) throw new AdmissionFailure('denied');
    const navigation: EmbeddedNavigation[] = [];
    for (const item of installation.manifest.navigation) {
      const destination = installation.manifest.routes.find((candidate) => candidate.id === item.routeId)!;
      if (await allowed(destination.permission)) navigation.push({ ...item, path: namespaced(appId, destination.path) });
    }
    return { installation, session, route, navigation: freeze(navigation.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) };
  }

  private publish(state: EmbeddedHostState<Module>): void {
    // Module is an opaque trusted executable, not authorization data to clone/freeze.
    this.state = Object.freeze(state); for (const listener of this.listeners) listener();
  }
}
