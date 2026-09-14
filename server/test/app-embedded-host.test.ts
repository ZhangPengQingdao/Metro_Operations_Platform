import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedEmbeddedHost, type EmbeddedInstallation, type EmbeddedSession, type EmbeddedHostOptions } from '../../src/app-platform/host/embedded/controller.ts';

function installation(): EmbeddedInstallation {
  return { id: 'installation-one', revision: 1, enabled: true, manifest: {
    manifestVersion: '1.0', id: 'sample-app', version: '1.0.0', name: 'Sample', description: 'Sample', publisherId: 'sample',
    compatibility: { platform: { minInclusive: '0.0.1', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
    permissions: { requested: ['platform.directory.read'], defined: [] }, ui: { mode: 'trusted', entryArtifactId: 'ui' },
    backend: { mode: 'none' }, storage: { mode: 'none' },
    routes: [{ id: 'home', path: '/' }, { id: 'detail', path: '/details', permission: 'platform.directory.read' }],
    navigation: [{ id: 'home', label: 'Home', routeId: 'home', order: 2 }, { id: 'detail', label: 'Details', routeId: 'detail', order: 1 }],
    api: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [], network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
    artifacts: [{ id: 'ui', kind: 'frontend', path: 'ui/index.js', sha256: 'a'.repeat(64), bytes: 123 }],
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides: Partial<EmbeddedHostOptions<string>> = {}) {
  const installed = installation();
  const session: EmbeddedSession = { key: 'session-one', actor: { actorType: 'person', source: 'session', execution: { type: 'platform' }, capabilities: [] } };
  const paths: string[] = []; let loads = 0;
  const host = new TrustedEmbeddedHost<string>({ loadInstallation: async () => installed, resolveSession: async () => session,
    approve: async () => true, authorize: async () => true, load: async () => { loads++; return 'module'; }, navigate: (path) => { paths.push(path); }, ...overrides });
  return { host, installed, session, paths, loads: () => loads };
}

test('embedded host resolves exact namespaced routes, shared context, and ordered navigation', async () => {
  const f = fixture(); let notifications = 0; const off = f.host.subscribe(() => { notifications++; });
  assert.equal(f.host.getSnapshot().status, 'idle'); await f.host.open('sample-app', '/');
  const state = f.host.getSnapshot(); assert.equal(state.status, 'ready'); if (state.status !== 'ready') return;
  assert.equal(state.route.path, '/platform/apps/sample-app'); assert.deepEqual(state.navigation.map((x) => x.routeId), ['detail', 'home']);
  assert.equal(state.context.actor.source, 'session'); assert.equal(f.host.getSnapshot(), state);
  await state.context.navigate('detail'); assert.deepEqual(f.paths, ['/platform/apps/sample-app/details']);
  assert.equal(state.context.signal.aborted, true); await assert.rejects(state.context.navigate('home'));
  off(); assert.ok(notifications >= 4);
});

test('embedded admission denies unapproved, disabled, absent, wrong binding or unauthenticated apps before loading', async () => {
  for (const overrides of [
    { approve: async () => false }, { loadInstallation: async () => null }, { resolveSession: async () => null },
    { loadInstallation: async () => ({ ...installation(), enabled: false }) },
    { loadInstallation: async () => { const i = installation(); i.manifest.id = 'other-app'; return i; } },
    { loadInstallation: async () => { const i = installation(); i.manifest.ui = { mode: 'sandbox', entryArtifactId: 'ui' }; return i; } },
  ]) { const f = fixture(overrides); await f.host.open('sample-app', '/'); assert.notEqual(f.host.getSnapshot().status, 'ready'); assert.equal(f.loads(), 0); }
});

test('embedded permissions hide menu entries and deny direct routes; authentication alone permits no-permission routes', async () => {
  const f = fixture({ authorize: async () => false }); await f.host.open('sample-app', '/');
  const state = f.host.getSnapshot(); assert.equal(state.status, 'ready'); if (state.status !== 'ready') return;
  assert.deepEqual(state.navigation.map((x) => x.routeId), ['home']); await state.context.navigate('detail');
  assert.equal(f.host.getSnapshot().status, 'denied'); assert.deepEqual(f.paths, []); assert.equal(f.loads(), 1);
});

test('embedded host rejects noncanonical routes and malformed host projections before loading', async () => {
  for (const path of ['https://bad.example', '//bad.example', '/../details', '/%2e%2e', '/details?x=1', '/details#x', '/details/', '/missing', '/platform/apps/other-app']) {
    const f = fixture(); await f.host.open('sample-app', path); assert.notEqual(f.host.getSnapshot().status, 'ready'); assert.equal(f.loads(), 0);
  }
  for (const mutate of [
    (i: EmbeddedInstallation) => { i.manifest.routes[1].path = '/../bad'; },
    (i: EmbeddedInstallation) => { i.manifest.routes[1].id = 'home'; },
    (i: EmbeddedInstallation) => { i.manifest.navigation[0].routeId = 'unknown'; },
    (i: EmbeddedInstallation) => { i.manifest.routes[1].permission = 'undeclared'; },
    (i: EmbeddedInstallation) => { i.manifest.artifacts[0].sha256 = 'wrong'; },
    (i: EmbeddedInstallation) => { i.revision = 0; },
  ]) { const i = installation(); mutate(i); const f = fixture({ loadInstallation: async () => i }); await f.host.open('sample-app', '/'); assert.notEqual(f.host.getSnapshot().status, 'ready'); assert.equal(f.loads(), 0); }
});

test('embedded loading rechecks revision, artifact, session, trust and permissions before mounting', async () => {
  for (const change of ['revision', 'artifact', 'session', 'enabled', 'trust', 'permission']) {
    const gate = deferred<string>(); const started = deferred<void>(); let allowed = true;
    const f = fixture({ load: async () => { started.resolve(); return gate.promise; }, approve: async () => allowed, authorize: async () => allowed });
    const opened = f.host.open('sample-app', '/details'); await started.promise;
    if (change === 'revision') f.installed.revision++;
    if (change === 'artifact') f.installed.manifest.artifacts[0].sha256 = 'b'.repeat(64);
    if (change === 'session') f.session.key = 'other-session';
    if (change === 'enabled') f.installed.enabled = false;
    if (change === 'trust' || change === 'permission') allowed = false;
    gate.resolve('module'); await opened; assert.notEqual(f.host.getSnapshot().status, 'ready', change);
  }
});

test('refresh/close revoke immediately and late old loads cannot replace the current page', async () => {
  const gate = deferred<string>(); const started = deferred<void>(); let calls = 0;
  const f = fixture({ load: async () => { calls++; if (calls === 1) { started.resolve(); return gate.promise; } return 'new'; } });
  const old = f.host.open('sample-app', '/'); await started.promise; await f.host.open('sample-app', '/details');
  gate.resolve('old'); await old; let state = f.host.getSnapshot(); assert.equal(state.status, 'ready'); if (state.status !== 'ready') return;
  assert.equal(state.module, 'new'); const oldContext = state.context; const refresh = f.host.refresh(); assert.equal(oldContext.signal.aborted, true); assert.equal(f.host.getSnapshot().status, 'loading');
  await refresh; state = f.host.getSnapshot(); assert.equal(state.status, 'ready'); if (state.status !== 'ready') return;
  f.host.close(); assert.equal(state.context.signal.aborted, true); assert.equal(f.host.getSnapshot().status, 'idle'); await assert.rejects(state.context.navigate('home'));
});

test('snapshots detach and freeze authorization data and sanitize adapter failures', async () => {
  const f = fixture(); await f.host.open('sample-app', '/'); const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
  assert.notEqual(state.installation, f.installed); assert.notEqual(state.session, f.session);
  assert.throws(() => { state.installation.manifest.routes[0].path = '/changed'; });
  assert.throws(() => { state.context.actor.capabilities.push('admin'); });
  const failed = fixture({ load: async () => { throw new Error('secret credential'); } }); await failed.host.open('sample-app', '/');
  assert.deepEqual(failed.host.getSnapshot(), { status: 'error', message: 'Application could not be opened.' });
});

test('close while loading and concurrent navigation cannot commit stale results or browser paths', async () => {
  const gate = deferred<string>(); const started = deferred<void>(); let delayed = false;
  const f = fixture({ load: async () => { if (delayed) { started.resolve(); return gate.promise; } return 'module'; } });
  await f.host.open('sample-app', '/'); const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
  delayed = true; const navigation = state.context.navigate('detail'); await started.promise;
  f.host.close(); gate.resolve('old'); await navigation;
  assert.equal(f.host.getSnapshot().status, 'idle'); assert.deepEqual(f.paths, []);
});

test('new route opened from a synchronous invalidation observer wins over previous navigation', async () => {
  const f = fixture(); await f.host.open('sample-app', '/'); const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
  let redirected: Promise<void> | undefined;
  const off = f.host.subscribe(() => {
    if (f.host.getSnapshot().status === 'loading') { off(); redirected = f.host.open('sample-app', '/'); }
  });
  await state.context.navigate('detail'); await redirected;
  assert.equal(f.host.getSnapshot().status, 'ready'); assert.deepEqual(f.paths, []);
});

test('synchronous abort listeners cannot be overwritten by an older open or close', async () => {
  for (const operation of ['open', 'close'] as const) {
    const f = fixture(); await f.host.open('sample-app', '/');
    const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
    let redirected: Promise<void> | undefined;
    state.context.signal.addEventListener('abort', () => { redirected = f.host.open('sample-app', '/details'); });
    if (operation === 'open') await f.host.open('sample-app', '/'); else f.host.close();
    await redirected;
    const latest = f.host.getSnapshot(); if (latest.status !== 'ready') assert.fail('ready');
    assert.equal(latest.route.id, 'detail'); assert.equal(latest.context.signal.aborted, false);
  }
});

test('close from a synchronous abort listener prevents the interrupted open from loading', async () => {
  const f = fixture(); await f.host.open('sample-app', '/');
  const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
  state.context.signal.addEventListener('abort', () => { f.host.close(); });
  await f.host.open('sample-app', '/details');
  assert.equal(f.host.getSnapshot().status, 'idle'); assert.equal(f.loads(), 1);
});

test('error cleanup cannot overwrite a new target opened by a synchronous abort listener', async () => {
  let first = true; let redirected: Promise<void> | undefined;
  const f = fixture({ load: async (_installation, signal) => {
    if (first) {
      first = false;
      signal.addEventListener('abort', () => { redirected = f.host.open('sample-app', '/details'); });
      throw new Error('load failed');
    }
    return 'new';
  } });
  const statuses: string[] = [];
  f.host.subscribe(() => { statuses.push(f.host.getSnapshot().status); });
  await f.host.open('sample-app', '/'); await redirected;
  assert.deepEqual(statuses, ['loading', 'loading', 'ready']);
  const state = f.host.getSnapshot(); if (state.status !== 'ready') assert.fail('ready');
  assert.equal(state.route.id, 'detail'); assert.equal(state.context.signal.aborted, false);
});
