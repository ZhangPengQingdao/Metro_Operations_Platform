import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AppMigrationPlanner, AppStorageService, compileAppMigration, APP_MIGRATION_FILE_MAX_BYTES, type AppMigrationArtifactRequest } from '../src/app-platform/storage/index.ts';
import { AppRegistryService, MemoryAppRegistryRepository, type AppInstallation } from '../src/app-platform/registry/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
import type { PlatformPersonActorContext } from '../src/platform/context/index.ts';

const now = '2026-09-09T00:00:00.000Z';
const admin: PlatformPersonActorContext = {
  actorType: 'person', trustedIdentity: { source: 'session', userId: 'admin' }, execution: { type: 'platform' },
  request: { requestId: 'r', traceId: 't', startedAt: now },
  person: { id: 'admin', employeeNo: '1', name: 'Admin', avatarUrl: null, organization: { id: 'org', code: 'org', name: 'Org', unitType: 'company' }, position: { id: 'p', code: 'p', name: 'P' } },
  authorize: async permissionCode => ({ id: 'decision', allowed: true, reasonCode: 'allowed', permissionCode, subjectType: 'person', effectiveScopes: [], decidedAt: now }),
};
const migration = (table: string) => JSON.stringify({ migrationVersion: '1.0', operations: [{ kind: 'createTable', table, columns: [{ name: 'id', type: 'integer', nullable: false }] }] });
function fixture(values: Uint8Array[] = [Buffer.from(migration('first')), Buffer.from(migration('second') + '\r\n')]) {
  const artifacts = values.map((bytes, i) => ({ id: `sql-${i}`, kind: 'migration' as const, path: `migrations/${i}.json`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }));
  const manifest: AppManifest = {
    manifestVersion: '1.0', id: 'tool-lending', version: '1.0.0', name: 'Tools', description: 'fixture', publisherId: 'example',
    compatibility: { platform: { minInclusive: '0.0.1', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
    permissions: { requested: [], defined: [] }, ui: { mode: 'none' }, backend: { mode: 'external', origin: 'https://example.com' },
    storage: { mode: 'managed', migrations: artifacts.map(a => ({ id: a.id, artifactId: a.id })) },
    routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [], resources: [], artifacts,
    network: { frontendOrigins: [], backendOrigins: [] },
  };
  const record: AppInstallation = { id: '00000000-0000-4000-8000-000000000001', appId: manifest.id, manifest, revision: 1, enabled: false, grants: [], serviceIdentityId: null, createdAt: now, updatedAt: now };
  const requests: AppMigrationArtifactRequest[] = [];
  const registry = { get: async () => record };
  const reader = { read: async (request: AppMigrationArtifactRequest) => { requests.push(request); return values[Number(request.artifactId.slice(4))]; } };
  return { record, requests, registry, reader, values, planner: new AppMigrationPlanner(registry, reader) };
}

test('preflight uses trusted registration, exact JSON bytes, generated SQL, manifest order and same storage binding', async () => {
  const f = fixture();
  const registry = new AppRegistryService(new MemoryAppRegistryRepository(), { authorization: { listPermissions: async () => [] }, host: () => ({ platformVersion: '0.0.1', capabilities: [], applications: [] }) });
  const m = f.record.manifest;
  if (m.storage.mode === 'managed') m.storage.migrations.reverse();
  await registry.register(admin, m);
  const plan = await new AppMigrationPlanner(registry, f.reader).prepare(admin, m.id);
  assert.deepEqual(plan.steps.map(s => s.id), ['sql-1', 'sql-0']);
  assert.equal(plan.steps[0].sql, compileAppMigration(f.values[1].toString(), plan.binding.schema).join('\n'));
  assert.equal(plan.steps[0].declarationJson, f.values[1].toString());
  const service = new AppStorageService(registry, { query: async () => { throw new Error('No DB access during preflight'); } });
  assert.deepEqual(plan.binding, await service.describe(admin, m.id));
  assert.equal(plan.revision, 1);
  assert.equal(plan.totalBytes, f.values.reduce((sum, b) => sum + b.length, 0));
  assert.equal(f.requests[0].installationId, plan.binding.installationId);
  assert.equal(f.requests[0].maxBytes, f.values[1].length);
  assert.ok(Object.isFrozen(f.requests[0]));
  // A correctly hashed SQL script still cannot bypass the declarative-only contract.
  const dangerous = fixture([Buffer.from('RESET ROLE; DROP SCHEMA public CASCADE;')]);
  await assert.rejects(dangerous.planner.prepare(admin, m.id), /MIGRATION_INVALID_DECLARATION/);
});

test('native management authorization precedes registry and reader; nonmanaged modes never read', async () => {
  let gets = 0; const f = fixture();
  const planner = new AppMigrationPlanner({ get: async () => { gets++; return f.record; } }, f.reader);
  for (const context of [
    { ...admin, execution: { type: 'application' as const, appId: f.record.appId } },
    { ...admin, authorize: async (code: string) => ({ ...await admin.authorize(code), allowed: false }) },
  ]) await assert.rejects(planner.prepare(context, f.record.appId), /STORAGE_ACCESS_DENIED/);
  assert.equal(gets, 0); assert.equal(f.requests.length, 0);
  for (const storage of [{ mode: 'none' as const }, { mode: 'external' as const, configurationRef: 'external-db' }]) {
    const no = fixture([]); no.record.manifest.storage = storage;
    await assert.rejects(no.planner.prepare(admin, no.record.appId), /MIGRATION_STORAGE_NOT_MANAGED/);
    assert.equal(no.requests.length, 0);
  }
});

test('invalid manifest, identity or revision rejected without artifact access', async () => {
  for (const mutate of [
    (r: AppInstallation) => { r.manifest.artifacts[0].path = '../escape.sql'; },
    (r: AppInstallation) => { r.id = 'arbitrary-schema'; },
    (r: AppInstallation) => { r.revision = 0; },
    (r: AppInstallation) => { r.appId = 'another-app'; },
  ]) {
    const f = fixture(); mutate(f.record);
    await assert.rejects(f.planner.prepare(admin, 'tool-lending'), /INVALID_MANIFEST|INVALID_INSTALLATION/);
    assert.equal(f.requests.length, 0);
  }
});

test('declared file and total budgets fail before any reads, exact file budget accepted', async () => {
  for (const count of [1, 9]) {
    const f = fixture(Array.from({ length: count }, () => Buffer.from('x')));
    for (const a of f.record.manifest.artifacts) a.bytes = APP_MIGRATION_FILE_MAX_BYTES + (count === 1 ? 1 : 0);
    await assert.rejects(f.planner.prepare(admin, f.record.appId), /MIGRATION_SIZE_LIMIT/);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture([Buffer.from(migration('records').padEnd(APP_MIGRATION_FILE_MAX_BYTES, ' '))]);
  assert.equal((await f.planner.prepare(admin, f.record.appId)).totalBytes, APP_MIGRATION_FILE_MAX_BYTES);
});

test('actual bytes, digest, missing and provider errors fail all-or-nothing without leaking errors', async () => {
  for (const [read, code] of [
    [async () => Buffer.from('x'), 'MIGRATION_BYTE_LENGTH_MISMATCH'],
    [async (r: AppMigrationArtifactRequest) => Buffer.alloc(r.bytes, 120), 'MIGRATION_HASH_MISMATCH'],
    [async () => undefined, 'MIGRATION_INVALID_ARTIFACT'],
    [async () => { throw new Error('private bucket secret'); }, 'MIGRATION_ARTIFACT_UNAVAILABLE'],
  ] as const) {
    const f = fixture(); let calls = 0;
    const planner = new AppMigrationPlanner(f.registry, { read: async r => {
      calls++; if (calls === 1) return f.values[0];
      return await read(r) as Uint8Array;
    } });
    await assert.rejects(planner.prepare(admin, f.record.appId), error => error instanceof Error && error.message === code);
    assert.equal(calls, 2);
  }
});

test('strict UTF-8 rejects malformed bytes, BOM, NUL and blank text after integrity validation', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xe2, 0x82]), Buffer.from('\ufeffSELECT 1'), Buffer.from('SELECT\0 1'), Buffer.from(' \t\r\n')]) {
    const f = fixture([bytes]);
    await assert.rejects(f.planner.prepare(admin, f.record.appId), /MIGRATION_INVALID_ENCODING|MIGRATION_INVALID_SQL_TEXT/);
  }
});

test('snapshots survive source/provider mutation and every returned object is frozen', async () => {
  const f = fixture(); const original = structuredClone(f.record);
  const originalJson = f.values.map(b => Buffer.from(b).toString());
  const expected = f.values.map(b => compileAppMigration(Buffer.from(b).toString(), 'app_' + original.id.replaceAll('-', '')).join('\n'));
  const planner = new AppMigrationPlanner(f.registry, { read: async request => {
    f.record.id = 'changed'; f.record.revision = 99; f.record.manifest.artifacts[1].path = 'changed.sql';
    if (f.record.manifest.storage.mode === 'managed') f.record.manifest.storage.migrations.reverse();
    assert.throws(() => { (request as { bytes: number }).bytes = 0; }, TypeError);
    return f.values[Number(request.artifactId.slice(4))];
  } });
  const plan = await planner.prepare(admin, original.appId);
  f.values.forEach(bytes => bytes.fill(120));
  assert.equal(plan.binding.installationId, original.id); assert.equal(plan.revision, original.revision);
  assert.deepEqual(plan.steps.map(s => s.sql), expected);
  assert.deepEqual(plan.steps.map(s => s.declarationJson), originalJson);
  assert.equal(plan.steps[1].path, 'migrations/1.json');
  for (const object of [plan, plan.binding, plan.steps, ...plan.steps]) assert.ok(Object.isFrozen(object));
  assert.throws(() => { (plan.steps[0] as { sql: string }).sql = 'changed'; }, TypeError);
  assert.throws(() => { (plan.binding as { schema: string }).schema = 'public'; }, TypeError);
  const empty = fixture([]); assert.deepEqual((await empty.planner.prepare(admin, empty.record.appId)).steps, []);
});
