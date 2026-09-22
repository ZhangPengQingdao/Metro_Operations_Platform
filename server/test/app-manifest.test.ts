import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateAppManifest, parseAppManifestJson, checkAppManifestCompatibility, MAX_APP_MANIFEST_BYTES } from '../src/app-platform/manifest/index.ts';
import type { AppManifest, AppManifestHost } from '../../packages/platform-sdk/src/app-manifest.ts';

function fixture(): AppManifest {
  return {
    manifestVersion: '1.0', id: 'tool-lending', version: '1.0.0', name: '工器具借还', description: '独立应用安装声明测试', publisherId: 'example-developer',
    compatibility: { platform: { minInclusive: '0.0.1-alpha.34', maxExclusive: '2.0.0' }, capabilities: [{ id: 'platform-mcp', contractVersion: '2.0' }], applications: [] },
    permissions: { requested: ['platform.work_items.create'], defined: [{ code: 'app.tool-lending.borrow', description: '借用工器具' }] },
    ui: { mode: 'sandbox', entryArtifactId: 'ui' },
    backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'server', limits: { memoryMiB: 256, cpuMillis: 1000, timeoutSeconds: 30 } },
    storage: { mode: 'managed', migrations: [{ id: 'initial', artifactId: 'migration' }] },
    routes: [{ id: 'home', path: '/', permission: 'app.tool-lending.borrow' }],
    api: [{ id: 'borrow', method: 'POST', path: '/borrow', handler: 'borrow', permission: 'app.tool-lending.borrow' }],
    navigation: [{ id: 'main', routeId: 'home', label: '工器具借还', order: 100 }],
    events: { publish: ['app.tool-lending.borrowed.v1'], subscribe: [{ event: 'platform.assets.changed.v1', handler: 'asset-changed' }] },
    tools: [{ name: 'borrow', contributionArtifactId: 'tools', uiResourceId: 'card' }],
    jobs: [{ id: 'overdue', handler: 'check-overdue', intervalSeconds: 3600 }],
    network: { frontendOrigins: [], backendOrigins: ['https://api.example.com'] },
    health: { path: '/health', timeoutSeconds: 5 }, resources: [{ id: 'card', artifactId: 'card-html', kind: 'mcp-ui' }],
    artifacts: [
      { id: 'ui', kind: 'frontend', path: 'web/index.html', sha256: 'a'.repeat(64), bytes: 100 },
      { id: 'server', kind: 'backend', path: 'server/index.js', sha256: 'b'.repeat(64), bytes: 100 },
      { id: 'migration', kind: 'migration', path: 'migrations/001.json', sha256: 'c'.repeat(64), bytes: 100 },
      { id: 'tools', kind: 'mcp-contribution', path: 'mcp/tools.json', sha256: 'd'.repeat(64), bytes: 100 },
      { id: 'card-html', kind: 'resource', path: 'mcp/card.html', sha256: 'e'.repeat(64), bytes: 100 }
    ]
  };
}
function headless(): AppManifest {
  const m = fixture();
  m.ui = { mode: 'none' }; m.backend = { mode: 'none' }; m.storage = { mode: 'none' };
  m.routes = []; m.api = []; m.navigation = []; m.events = { publish: [], subscribe: [] }; m.jobs = []; m.tools = []; m.resources = []; m.artifacts = [];
  m.network = { frontendOrigins: [], backendOrigins: [] }; delete m.health;
  return m;
}
const host: AppManifestHost = { platformVersion: '0.0.1-alpha.34', capabilities: [{ id: 'platform-mcp', contractVersion: '2.0' }], applications: [] };
function rejects(mutate: (m: AppManifest) => void) { const m = fixture(); mutate(m); assert.equal(validateAppManifest(m).ok, false); }

test('versioned manifest validates detached declarations without installing or granting trust', () => {
  const m = fixture(); const result = validateAppManifest(m);
  assert.equal(result.ok, true);
  if (result.ok) { assert.deepEqual(result.manifest, m); assert.notEqual(result.manifest, m); }
  assert.equal(parseAppManifestJson(JSON.stringify(m)).ok, true);
  assert.equal(validateAppManifest(headless()).ok, true);
  const trusted = fixture(); trusted.ui.mode = 'trusted'; trusted.backend = { ...trusted.backend, mode: 'trusted', runtime: 'node', entryArtifactId: 'server', limits: { memoryMiB: 128, cpuMillis: 1000, timeoutSeconds: 10 } };
  assert.equal(validateAppManifest(trusted).ok, true);
  const external = headless(); external.backend = { mode: 'external', origin: 'https://api.example.com' }; external.storage = { mode: 'external', configurationRef: 'application-database' };
  assert.equal(validateAppManifest(external).ok, true);
});

test('managed migration references require JSON artifacts and reject unreferenced SQL artifacts', () => {
  for (const path of ['migrations/001.sql', 'migrations/001.JSON', 'migrations/001.json.sql']) {
    rejects(m => { m.artifacts.find(a => a.id === 'migration')!.path = path; });
  }
  rejects(m => { m.artifacts.push({ id: 'unused', kind: 'migration', path: 'unused.sql', sha256: 'f'.repeat(64), bytes: 1 }); });
  assert.equal(validateAppManifest(fixture()).ok, true);
});

test('unknown fields, embedded secrets/SQL and invalid versions are rejected without value leakage', () => {
  for (const field of ['secret', 'sql', 'grants', 'actor_token', 'schema']) {
    const m = { ...fixture(), [field]: 'sensitive-test-value' };
    const result = validateAppManifest(m); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('sensitive-test-value'));
  }
  assert.equal(validateAppManifest({ ...fixture(), ui: { ...fixture().ui, token: 'secret' } }).ok, false);
  for (const v of ['^1.0.0', '6.0', '01.0.0', '0.0.1-alpha.01', '1.0.0+build', '', '999999999999.0.0']) rejects((m) => { m.version = v; });
  rejects((m) => { m.compatibility.platform.maxExclusive = m.compatibility.platform.minInclusive; });
  assert.equal(validateAppManifest({ ...fixture(), manifestVersion: '2.0' }).ok, false);
});

test('artifact paths and route paths are canonical, bounded and cannot escape package/host', () => {
  for (const path of ['../secret', '/etc/passwd', 'a/../b', 'a//b', 'a\\b', 'C:/app.js', 'a/%2e%2e/b', 'a?secret=x', 'a#fragment', './a', 'a\0b', 'a/']) rejects((m) => { m.artifacts[0].path = path; });
  for (const path of ['//example.com', '/a/../b', '/a?x=1', '/a/', '/a%2fb']) rejects((m) => { m.routes[0].path = path; });
  rejects((m) => { m.artifacts[0].sha256 = 'not-a-hash'; });
  rejects((m) => { m.artifacts[0].bytes = 0; });
  rejects((m) => { m.artifacts[1].path = m.artifacts[0].path.toUpperCase(); });
});

test('network accepts only explicit canonical HTTPS DNS origins, not credentials or private IP literals', () => {
  for (const origin of ['http://api.example.com', '*', 'https://*.example.com', 'https://api.example.com/', 'https://u:p@example.com', 'https://example.com?token=x', 'https://localhost', 'https://x.localhost', 'https://127.0.0.1', 'https://10.1.1.1', 'https://[::1]', 'https://a..com', 'https://-a.example', 'https://example.com:443']) rejects((m) => { m.network.backendOrigins = [origin]; });
  rejects((m) => { m.network.backendOrigins.push(m.network.backendOrigins[0]); });
  const m = fixture(); m.network.backendOrigins = ['https://api.example.com:8443']; assert.equal(validateAppManifest(m).ok, true);
});

test('cross references, ownership, uniqueness and runtime modes are checked', () => {
  const changes: ((m: AppManifest) => void)[] = [
    (m) => { m.navigation[0].routeId = 'missing'; },
    (m) => { m.routes[0].permission = 'platform.secret.read'; },
    (m) => { m.routes.push({ ...m.routes[0], id: 'other' }); },
    (m) => { m.permissions.defined[0].code = 'app.another.borrow'; },
    (m) => { m.events.publish[0] = 'platform.assets.changed.v1'; },
    (m) => { m.tools[0].uiResourceId = 'missing'; },
    (m) => { m.resources[0].kind = 'asset'; },
    (m) => { m.compatibility.capabilities = []; },
    (m) => { m.artifacts[0].kind = 'backend'; },
    (m) => { m.ui = { mode: 'none' }; },
    (m) => { m.backend = { mode: 'none' }; },
    (m) => { m.storage = { mode: 'none' }; },
    (m) => { m.artifacts.push({ ...m.artifacts[0], id: 'orphan', path: 'orphan.html' }); },
    (m) => { m.jobs.push({ ...m.jobs[0] }); },
    (m) => { m.permissions.requested.push(m.permissions.requested[0]); },
    (m) => { m.compatibility.applications.push({ id: m.id, version: m.compatibility.platform }); },
    (m) => { if (m.storage.mode === 'managed') m.storage.migrations[0].artifactId = 'ui'; }
  ];
  for (const change of changes) rejects(change);
});

test('compatibility checks explicit ranges, SemVer prerelease order and exact capability contracts', () => {
  assert.equal(checkAppManifestCompatibility(fixture(), host).ok, true);
  for (const v of ['0.0.1-alpha.33', '2.0.0']) assert.equal(checkAppManifestCompatibility(fixture(), { ...host, platformVersion: v }).ok, false);
  for (const v of ['0.0.1-alpha.100', '1.0.0', '1.99.0']) assert.equal(checkAppManifestCompatibility(fixture(), { ...host, platformVersion: v }).ok, true);
  assert.equal(checkAppManifestCompatibility(fixture(), { ...host, capabilities: [{ id: 'platform-mcp', contractVersion: '1.0' }] }).ok, false);
  assert.equal(checkAppManifestCompatibility(fixture(), { ...host, capabilities: [...host.capabilities, ...host.capabilities] }).ok, false);
  const m = fixture(); m.compatibility.applications = [{ id: 'inventory', version: { minInclusive: '0.0.1', maxExclusive: '2.0.0' } }];
  assert.equal(checkAppManifestCompatibility(m, host).ok, false);
  assert.equal(checkAppManifestCompatibility(m, { ...host, applications: [{ id: 'inventory', version: '1.1.0' }] }).ok, true);
  assert.equal(checkAppManifestCompatibility(m, { ...host, applications: [{ id: 'inventory', version: '2.0.0' }] }).ok, false);
});

test('untrusted objects and JSON are bounded before validation, without evaluating accessors', () => {
  assert.equal(parseAppManifestJson('{').ok, false);
  assert.equal(parseAppManifestJson(' '.repeat(MAX_APP_MANIFEST_BYTES + 1)).ok, false);
  rejects((m) => { m.routes = Array.from({ length: 129 }, () => ({ id: 'x', path: '/' })); });
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'id', { enumerable: true, get() { getterCalls++; throw new Error('must not execute'); } });
  assert.equal(validateAppManifest(getter).ok, false); assert.equal(getterCalls, 0);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.equal(validateAppManifest(cycle).ok, false);
  for (const value of [undefined, null, new Date(), 1n, { value: () => 1 }]) assert.equal(validateAppManifest(value).ok, false);
});

test('API declarations bind method, path, handler and declared permissions without mounting routes', () => {
  rejects((m) => { m.api.push({ ...m.api[0], id: 'duplicate' }); });
  rejects((m) => { m.api[0].permission = 'platform.secret.read'; });
  rejects((m) => { m.api[0].path = '//external.example'; });
  const m = headless(); m.api = fixture().api;
  assert.equal(validateAppManifest(m).ok, false);
  m.backend = { mode: 'external', origin: 'https://api.example.com' };
  assert.equal(validateAppManifest(m).ok, true);
});

test('sparse arrays and hidden accessors are rejected before schema traversal', () => {
  const sparse = fixture(); sparse.routes = new Array(1000000);
  assert.equal(validateAppManifest(sparse).ok, false);
  let calls = 0;
  const value = Object.defineProperty({}, 'id', { get() { calls++; return 'x'; } });
  assert.equal(validateAppManifest(value).ok, false);
  assert.equal(calls, 0);
});

test('SDK manifest entrypoint stays browser-safe and separate from the L3 root', async () => {
  const source = await readFile(new URL('../../packages/platform-sdk/src/app-manifest.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from\s+['"]|require\(|process\.|Buffer\.)/);
  const root = await readFile(new URL('../../packages/platform-sdk/src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(root, /app-manifest/);
  const pkg = JSON.parse(await readFile(new URL('../../packages/platform-sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./app-manifest'].types, './dist/app-manifest.d.ts');
});

test('business API permissions stay application-defined and entry declarations cannot bypass explicit bindings',()=>{
 const m=fixture();m.permissions.defined[0].scopeKinds=['self','workgroup'];m.api[0].businessPermission=m.permissions.defined[0].code;
 assert.equal(validateAppManifest(m).ok,true);
 m.api[0].businessEntry=true;assert.equal(validateAppManifest(m).ok,false);
 delete m.api[0].businessPermission;assert.equal(validateAppManifest(m).ok,true);
 rejects(value=>{value.api[0].businessPermission='platform.authorization.manage';});
 rejects(value=>{value.permissions.defined[0].scopeKinds=[];});
});

test('signed application icons accept bounded SVG paths but no markup or external sources',()=>{
 const manifest=fixture();manifest.icon={paths:['M5 4h14v16H5z','M8 10h8']};
 assert.equal(validateAppManifest(manifest).ok,true);
 for(const icon of [{paths:[]},{paths:['<script>alert(1)</script>']},{paths:['M0 0'],url:'https://example.com/icon.svg'},{paths:['M'.repeat(2049)]}]){
  assert.equal(validateAppManifest({...manifest,icon}).ok,false);
 }
});
