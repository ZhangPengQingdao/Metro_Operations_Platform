import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { PGlite } from '@electric-sql/pglite';
import { satisfiesPlatformRange, validateAppManifestV2, validateAppMigration } from '@metro/platform-sdk/manifest';
import { createMopkg, inspectMopkg, readMopkg } from '@metro/platform-sdk/mopkg';
import { createAppServerContext, defineServer } from '@metro/platform-sdk/server';
import { previewAppPackageV2, summarizeV1Installation } from '../src/app-platform/install/package-v2.ts';
import { ADMIN_PASSWORD_SESSION_SQL } from '../src/setup/password-policy-migration.ts';
import { ADMIN_IDENTITY_MIGRATION, AdminIdentityService, registerAdminIdentityRoutes } from '../src/core/admin-identity/index.ts';
import { registerAdminConsoleRoutes } from '../src/app-platform/admin/routes.ts';
import { APP_REGISTRY_SQL, AppRegistryService, PostgresAppRegistryRepository } from '../src/app-platform/registry/index.ts';
import type { PlatformAdministratorContext } from '../src/platform/context/index.ts';
import { demoManifest } from '../../src/app-platform/samples/host-demo/manifest.ts';

const encoder = new TextEncoder();
const manifest = (overrides: Record<string, unknown> = {}) => ({
  id: 'fire-check', name: '灭火器巡检', version: '1.0.0', description: '按车站巡检灭火器', color: '#e5484d', platform: '>=0.26.0',
  permissions: [{ code: 'read', name: '查看', scopes: ['self', 'all'] }, { code: 'app.fire-check.inspect', name: '巡检' }],
  platformAccess: ['locations.read'],
  pages: [{ path: '/', title: '任务', permission: 'read', nav: true }, { path: '/records/:id', title: '详情', permission: 'read' }],
  api: [{ id: 'list', permission: 'read' }, { id: 'summary', permission: 'read', dashboard: true }],
  ...overrides,
});
const migration = JSON.stringify({ migrationVersion: '1.0', operations: [
  { kind: 'createTable', table: 'records', columns: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'note', type: 'text', nullable: true }], primaryKey: ['id'] },
] });
const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
function entries(overrides: Record<string, string | null> = {}) {
  const files: Record<string, string | null> = {
    'app.json': JSON.stringify(manifest()), 'icon.svg': icon, 'ui.js': 'export default {};', 'server.js': 'export default {};',
    'migrations/001-initial.json': migration, 'README.md': '# 灭火器巡检', ...overrides,
  };
  return Object.entries(files).filter(([, value]) => value !== null).map(([path, value]) => ({ path, data: encoder.encode(value!) }));
}
/** Rewrites an entry name in place (same length) in both the local and central headers. */
function rename(zip: Buffer, from: string, to: string) {
  assert.equal(from.length, to.length);
  const copy = Buffer.from(zip), source = Buffer.from(from), target = Buffer.from(to);
  for (let index = copy.indexOf(source); index >= 0; index = copy.indexOf(source, index + 1)) target.copy(copy, index);
  return copy;
}

test('manifest v2 normalizes codes, fills defaults and rejects unsafe declarations', () => {
  const result = validateAppManifestV2(manifest());
  assert.ok(result.ok);
  assert.deepEqual(result.manifest.permissions.map(p => p.code), ['read', 'inspect']);
  assert.equal(result.manifest.color, '#E5484D');
  const minimal = validateAppManifestV2({ id: 'tiny', name: '小应用', version: '0.1.0', description: '说明', platform: '>=0.26.0' });
  assert.ok(minimal.ok);
  assert.deepEqual([minimal.manifest.pages, minimal.manifest.api, minimal.manifest.permissions, minimal.manifest.platformAccess], [[], [], [], []]);
  const cases: [Record<string, unknown>, string][] = [
    [{ publisherId: 'x' }, 'publisherId'],
    [{ id: 'Fire_Check' }, 'id'],
    [{ platform: '^0.26.0' }, 'platform'],
    [{ platformAccess: ['people.write'] }, 'platformAccess'],
    [{ pages: [{ path: '/', title: '任务', permission: 'manage' }] }, 'pages[0].permission'],
    [{ pages: [{ path: '/x/:id', title: '详情', nav: true }] }, 'pages[0].nav'],
    [{ pages: [{ path: '/Upper', title: '页' }] }, 'pages[0].path'],
    [{ api: [{ id: 'list' }, { id: 'list' }] }, 'api[1].id'],
    [{ api: [{ id: 'summary', dashboard: true }] }, 'api[0].permission'],
    [{ limits: { memoryMiB: 8 } }, 'limits.memoryMiB'],
  ];
  for (const [override, path] of cases) {
    const invalid = validateAppManifestV2(manifest(override));
    assert.ok(!invalid.ok, path);
    assert.ok(invalid.issues.some(issue => issue.path === path), `${path}: ${JSON.stringify(invalid.issues)}`);
  }
});

test('platform ranges and migrations follow the platform rules', () => {
  assert.ok(satisfiesPlatformRange('>=0.26.0', '0.26.0'));
  assert.ok(satisfiesPlatformRange('>=0.26.0 <1.0.0', '0.30.1'));
  assert.ok(!satisfiesPlatformRange('>=0.26.0 <1.0.0', '1.0.0'));
  assert.ok(!satisfiesPlatformRange('>=0.27.0', '0.27.0-beta.1'));
  assert.deepEqual(validateAppMigration(JSON.parse(migration)), []);
  assert.ok(validateAppMigration({ migrationVersion: '1.0', operations: [{ kind: 'addColumn', table: 't', column: { name: 'c', type: 'text', nullable: false } }] }).length);
  assert.ok(validateAppMigration({ migrationVersion: '1.0', operations: [{ kind: 'dropTable', table: 't' }] }).length);
  assert.ok(validateAppMigration({ migrationVersion: '1.0', operations: [{ kind: 'createTable', table: 'pg_x', columns: [{ name: 'id', type: 'uuid', nullable: false }] }] }).length);
});

test('mopkg round-trips deterministically and the reader rejects unsafe archives', () => {
  const zip = createMopkg(entries());
  assert.deepEqual(createMopkg([...entries()].reverse()), zip);
  const files = readMopkg(zip);
  assert.equal(files.get('README.md')!.toString('utf8'), '# 灭火器巡检');
  assert.deepEqual(inspectMopkg(zip).issues, []);

  assert.throws(() => readMopkg(rename(createMopkg(entries({ 'aa/b.md': 'x' })), 'aa/b.md', '../b.md')), { code: 'MOPKG_INVALID_PATH' });
  assert.throws(() => readMopkg(rename(createMopkg(entries({ 'readme.mx': 'x' })), 'readme.mx', 'readme.md')), { code: 'MOPKG_DUPLICATE_PATH' });
  assert.throws(() => createMopkg([{ path: '/abs', data: encoder.encode('x') }]), { code: 'MOPKG_INVALID_PATH' });

  const link = Buffer.from(createMopkg([{ path: 'app.json', data: encoder.encode('{}') }]));
  const central = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.throws(() => readMopkg(link), { code: 'MOPKG_UNSUPPORTED_FILE_TYPE' });

  const stored = Buffer.from(createMopkg([{ path: 'app.json', data: encoder.encode('{}') }]));
  stored[30 + 'app.json'.length] = 0x5b; // corrupt content, CRC no longer matches
  assert.throws(() => readMopkg(stored), { code: 'MOPKG_INVALID' });

  const bomb = Buffer.from(createMopkg([{ path: 'ui.js', data: new Uint8Array(100_000) }]));
  const directory = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(10, directory + 24); bomb.writeUInt32LE(10, 22); // declare 10 bytes uncompressed
  assert.throws(() => readMopkg(bomb), { code: 'MOPKG_INVALID' });
  assert.throws(() => readMopkg(encoder.encode('not a zip at all, definitely not')), { code: 'MOPKG_INVALID' });
});

test('mopkg layout issues are reported, not thrown', () => {
  const paths = (zip: Buffer) => inspectMopkg(zip).issues.map(issue => issue.path);
  assert.deepEqual(paths(createMopkg(entries({ 'icon.svg': null }))), ['icon']);
  assert.ok(paths(createMopkg(entries({ 'secret.env': 'x' }))).includes('secret.env'));
  assert.ok(paths(createMopkg(entries({ 'ui.js': null }))).includes('ui.js'));
  assert.ok(paths(createMopkg(entries({ 'server.js': null }))).includes('server.js'));
  assert.ok(paths(createMopkg(entries({ 'migrations/003-later.json': migration }))).includes('migrations/003-later.json'));
  assert.ok(paths(createMopkg(entries({ 'icon.svg': '<svg onload="alert(1)"></svg>' }))).includes('icon.svg'));
  assert.ok(paths(createMopkg(entries({ 'app.json': '{"id":' }))).includes('app.json'));
  assert.ok(paths(createMopkg(entries({ 'migrations/001-initial.json': '{"migrationVersion":"1.0","operations":[]}' }))).includes('migrations/001-initial.json'));
});

test('preview compiles migrations, checks platform version and compares with the v1 installation', async () => {
  const none = async () => null;
  const fresh = await previewAppPackageV2(createMopkg(entries()), { platformVersion: '0.26.0', findInstalled: none });
  assert.deepEqual(fresh.issues, []);
  assert.equal(fresh.change?.kind, 'install');
  assert.equal(fresh.migrations[0]!.statements, 1);
  assert.match(fresh.icon!.dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(fresh.installable, false);

  const old = await previewAppPackageV2(createMopkg(entries()), { platformVersion: '0.25.0', findInstalled: none });
  assert.equal(old.platform.compatible, false);
  assert.ok(old.issues.some(issue => issue.path === 'app.json#platform'));

  const installed = { version: '1.2.0', model: 'v1' as const, permissions: ['app.fire-check.read', 'app.fire-check.manage'], platformAccess: [] };
  const downgrade = await previewAppPackageV2(createMopkg(entries()), { platformVersion: '0.26.0', findInstalled: async () => installed });
  assert.equal(downgrade.change?.kind, 'downgrade');
  assert.deepEqual(downgrade.change?.addedPermissions, ['app.fire-check.inspect']);
  assert.deepEqual(downgrade.change?.removedPermissions, ['app.fire-check.manage']);
  assert.deepEqual(downgrade.change?.addedPlatformAccess, ['locations.read']);
  assert.ok(downgrade.issues.some(issue => issue.path === 'app.json#version'));

  const summary = summarizeV1Installation(demoManifest);
  assert.equal(summary.version, demoManifest.version);
  assert.ok(summary.platformAccess.every(code => !code.startsWith('platform.') && !code.startsWith('app_data.')));
});

test('defineServer context enforces business scope with short permission codes', async () => {
  const org = '11111111-1111-4111-8111-111111111111';
  const employee = { version: '1.0' as const, personId: '22222222-2222-4222-8222-222222222222', organizationUnitId: org, requestId: 'r', traceId: 't',
    businessAuthorization: { revision: '33333333-3333-4333-8333-333333333333', organizations: [], grants: [{ permission: 'app.fire-check.inspect', all: false, self: false, organizationIds: [org] }] } };
  const ctx = createAppServerContext({ appId: 'fire-check', employee, signal: new AbortController().signal, gateway: { invoke: async () => null } });
  assert.ok(ctx.can('inspect', { organizationUnitId: org }));
  assert.ok(!ctx.can('inspect', { organizationUnitId: '44444444-4444-4444-8444-444444444444' }));
  assert.throws(() => ctx.require('read'), { code: 'ACCESS_DENIED' });
  assert.throws(() => defineServer({ 'Bad Name': async () => null }), TypeError);
});

test('admin preview route returns a read-only preview for administrators only', async () => {
  const db = new PGlite();
  await db.exec(ADMIN_IDENTITY_MIGRATION); await db.exec(ADMIN_PASSWORD_SESSION_SQL); await db.exec(APP_REGISTRY_SQL);
  const client = { query: (sql: string, values?: readonly unknown[]) => sql.includes('pg_advisory_xact_lock') ? Promise.resolve({ rows: [] }) : db.query(sql, [...(values ?? [])]), release() {} };
  const pool = { connect: async () => client };
  const identity = new AdminIdentityService(pool);
  const account = await identity.bootstrap({ username: 'package.admin', displayName: 'Admin', password: 'Administrator-test-123' });
  const app = Fastify(); await app.register(cookie);
  registerAdminIdentityRoutes(app, { origin: 'https://platform.example', service: identity });
  await registerAdminConsoleRoutes(app, { origin: 'https://platform.example', identity, pool });
  try {
    const context = { actorType: 'administrator', administrator: account, execution: { type: 'platform' }, request: { requestId: 't', traceId: 't', startedAt: new Date().toISOString() },
      authorize: async (permissionCode: string) => ({ id: 'd', allowed: true, reasonCode: 'allowed', permissionCode, subjectType: 'administrator', effectiveScopes: [], decidedAt: new Date().toISOString() }) } as unknown as PlatformAdministratorContext;
    await new AppRegistryService(new PostgresAppRegistryRepository(client), { host: () => ({ platformVersion: '0.26.0', capabilities: [], applications: [] }), authorization: { listPermissions: async () => [] } }).register(context, demoManifest);
    const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', headers: { origin: 'https://platform.example' }, payload: { username: 'package.admin', password: 'Administrator-test-123' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'https://platform.example' };
    const url = '/api/admin/app-packages/preview';
    const upgrade = createMopkg(entries({ 'app.json': JSON.stringify(manifest({ id: demoManifest.id, version: '9.0.0', platform: '>=0.0.1', permissions: [{ code: 'read', name: '查看' }] })) }));
    assert.equal((await app.inject({ method: 'POST', url, headers: { origin: 'https://platform.example' }, payload: { package: upgrade.toString('base64') } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.example' }, payload: { package: upgrade.toString('base64') } })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url, headers, payload: { package: upgrade.toString('base64') } });
    assert.equal(response.statusCode, 200, response.body);
    const preview = response.json();
    assert.equal(preview.installed.version, demoManifest.version);
    assert.equal(preview.change.kind, 'upgrade');
    assert.equal(preview.installable, false);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { package: 'not base64!' } })).json().error, 'MOPKG_INVALID');
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { package: Buffer.from('plain text file').toString('base64') } })).json().error, 'MOPKG_INVALID');
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { package: 'AAAA', extra: true } })).statusCode, 400);
  } finally { await app.close(); await db.close(); }
});

test('mop-app init, check and build produce one installable-format file', async () => {
  const cli = fileURLToPath(new URL('../../packages/platform-cli/dist/cli.mjs', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'mop-v2-cli-'));
  const run = (args: string[], cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  try {
    const init = run(['init', 'fire-check', '--name', '灭火器"巡检']);
    assert.equal(init.status, 0, init.stderr);
    const project = join(root, 'fire-check');
    assert.equal(JSON.parse(await readFile(join(project, 'app.json'), 'utf8')).name, '灭火器"巡检');
    assert.notEqual(run(['init', 'fire-check']).status, 0);
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(project, 'node_modules'), 'dir');
    const tests = spawnSync(process.execPath, ['--test', 'test/'], { cwd: project, encoding: 'utf8' });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.equal(run(['check'], project).status, 0);
    const built = run(['build'], project);
    assert.equal(built.status, 0, built.stderr);
    const bytes = await readFile(join(project, 'dist/fire-check-0.1.0.mopkg'));
    const inspection = inspectMopkg(bytes);
    assert.deepEqual(inspection.issues, []);
    assert.deepEqual(inspection.files.map(file => file.path), ['README.md', 'app.json', 'icon.svg', 'migrations/001-initial.json', 'server.js', 'ui.css', 'ui.js']);
    const ui = readMopkg(bytes).get('ui.js')!.toString('utf8');
    assert.match(ui, /__MOP_SHARED__(\.react\b|\["react"\])/);
    assert.ok(!/from"react"/.test(ui) && ui.length < 10_000, 'react and the UI kit come from the shell, not bundled or imported');
    assert.match(readMopkg(bytes).get('ui.css')!.toString('utf8'), /^\[data-app=fire-check\] \.records-actions/);

    const appJson = JSON.parse(await readFile(join(project, 'app.json'), 'utf8'));
    appJson.api.push({ id: 'export', permission: 'read' });
    await writeFile(join(project, 'app.json'), JSON.stringify(appJson));
    const mismatch = run(['build'], project);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /缺少接口函数 export/);
    appJson.api.pop(); appJson.pages[0].permission = 'missing';
    await writeFile(join(project, 'app.json'), JSON.stringify(appJson));
    const invalid = run(['check'], project);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /app\.json#pages\[0\]\.permission/);
    appJson.pages[0].permission = 'read';
    await writeFile(join(project, 'app.json'), JSON.stringify(appJson));
    const page = await readFile(join(project, 'src/ui.jsx'), 'utf8');
    await writeFile(join(project, 'src/ui.jsx'), page.replace("import './ui.css';\n", ''));
    const unstyled = run(['build'], project);
    assert.equal(unstyled.status, 1);
    assert.match(unstyled.stderr, /样式文件未被页面引用/);
    await writeFile(join(project, 'src/ui.jsx'), `${page}\nexport const Probe = () => <React.Fragment />;\n`);
    const undeclared = run(['build'], project);
    assert.equal(undeclared.status, 1);
    assert.match(undeclared.stderr, /未导入的 React/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
