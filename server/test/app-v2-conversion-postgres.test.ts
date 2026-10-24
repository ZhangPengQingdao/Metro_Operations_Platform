import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, Pool } from 'pg';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createManagedStorageComposition, createStorageArtifactReader } from '../src/app-platform/management/storage.ts';
import { AppRegistryService, PostgresAppRegistryRepository } from '../src/app-platform/registry/index.ts';
import { PostgresInstallJournal } from '../src/app-platform/install/journal.ts';
import { AppInstaller } from '../src/app-platform/install/service.ts';
import { PostgresAppVersionJournal, createVersionedArtifactReader } from '../src/app-platform/install/version-service.ts';
import { createAppRuntimeComposition } from '../src/app-platform/runtime/composition.ts';
import { signAppDirectory } from '../src/app-platform/developer/signature.ts';
import { initializePlatformDatabase } from '../src/setup/schema.ts';
import { binding } from '../src/app-platform/storage/binding.ts';
import { AppDataServiceV2 } from '../src/app-platform/v2/data.ts';
import { AppHostV2 } from '../src/app-platform/v2/host.ts';
import { AppInstallerV2 } from '../src/app-platform/v2/installer.ts';
import { AppPackageStoreV2 } from '../src/app-platform/v2/store.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
import type { AppGateway } from '../src/app-platform/gateway/gateway.ts';
import type { PlatformActorContext, PlatformAdministratorContext } from '../src/platform/context/index.ts';

const MATERIALS = fileURLToPath(new URL('../../applications/materials/', import.meta.url));
const CLI = fileURLToPath(new URL('../../packages/platform-cli/dist/cli.mjs', import.meta.url));

// P3 pilot: a materials installation created by the real v1 pipeline (separate owner/runtime roles, ledger,
// leased runtime writes) is converted in place to v2. Disposable PostgreSQL only, like the v1 storage test.
const input = process.env.MOP_STORAGE_TEST_ADMIN_URL;
test('PostgreSQL: a v1 materials installation converts to v2 keeping its data, history and installation', { skip: !input }, async () => {
  const bootstrap = new URL(input!);
  assert.ok(['127.0.0.1', '[::1]'].includes(bootstrap.hostname));
  const suffix = randomBytes(6).toString('hex'), database = `mop_convert_test_${suffix}`, apiRole = `mop_api_${suffix}`, password = randomBytes(24).toString('hex');
  const root = await mkdtemp(join(tmpdir(), 'mop-convert-pg-'));
  const supervisor = new Client({ connectionString: input }); await supervisor.connect();
  const roleNames: string[] = [];
  let api: Client | undefined, admin: Client | undefined, pool: Pool | undefined, host: AppHostV2 | undefined;
  let runtime: ReturnType<typeof createAppRuntimeComposition> | undefined, storage: Awaited<ReturnType<typeof createManagedStorageComposition>> | undefined;
  try {
    await supervisor.query(`CREATE ROLE "${apiRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE NOCREATEDB`);
    await supervisor.query(`CREATE DATABASE "${database}" OWNER "${apiRole}"`);
    const apiUrl = new URL(input!); apiUrl.pathname = '/' + database; apiUrl.username = apiRole; apiUrl.password = password;
    const adminUrl = new URL(input!); adminUrl.pathname = '/' + database;
    api = new Client({ connectionString: apiUrl.href }); admin = new Client({ connectionString: adminUrl.href }); await api.connect(); await admin.connect();
    const db = { query: (sql: string, args?: readonly unknown[]) => api!.query(sql, args ? [...args] : undefined) };
    await initializePlatformDatabase(db);
    const listPermissions = async () => (await api!.query('SELECT id,code,name,status FROM platform_permissions')).rows.map(p => ({ ...p, description: null, createdAt: '', updatedAt: '' }));
    const registryOptions = { authorization: { listPermissions }, host: () => ({ platformVersion: '0.29.0', capabilities: [], applications: [] }) };
    const repository = new PostgresAppRegistryRepository(db), registry = new AppRegistryService(repository, registryOptions);
    const journal = new PostgresInstallJournal(db), readArtifact = createVersionedArtifactReader(journal, new PostgresAppVersionJournal(db));
    await admin.query(`REVOKE CREATE,TEMPORARY ON DATABASE "${database}" FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    storage = await createManagedStorageComposition({ apiDatabaseUrl: apiUrl.href, adminDatabaseUrl: adminUrl.href, apiClient: db,
      registry: (client: typeof db) => new AppRegistryService(new PostgresAppRegistryRepository(client), registryOptions),
      reader: createStorageArtifactReader({ getInstallation: id => repository.findByAppId(id), readArtifact }) });
    const actor = { actorType: 'administrator', administrator: { id: '44000000-0000-4000-8000-000000000002', username: 'test', displayName: 'Test' }, execution: { type: 'platform' },
      request: { requestId: 'test', traceId: 'test', startedAt: new Date().toISOString() },
      authorize: async (permissionCode: string) => ({ id: 'test', allowed: true, reasonCode: 'allowed', permissionCode, subjectType: 'administrator', effectiveScopes: [], decidedAt: new Date().toISOString() }) } as PlatformAdministratorContext;
    runtime = createAppRuntimeComposition({ registry, gateway: { drain: async () => {} } as unknown as AppGateway, storage, artifactRoot: join(root, 'runtime'), readArtifact,
      connectLease: async () => { const client = new Client({ connectionString: apiUrl.href }); await client.connect(); return client; }, external: { check: async () => {}, stop: async () => {} } });

    // v1 package with the real materials migrations (byte for byte), signed and installed by the v1 installer.
    const migrations = ['001-initial', '002-specification', '003-receiver'];
    const v1Dir = join(root, 'materials-v1'); await mkdir(v1Dir);
    const artifacts = [];
    for (const [index, name] of migrations.entries()) {
      const bytes = await readFile(join(MATERIALS, 'migrations', `${name}.json`));
      await writeFile(join(v1Dir, `migration-00${index + 1}.json`), bytes);
      artifacts.push({ id: ['schema', 'schema-two', 'schema-three'][index]!, kind: 'migration' as const, path: `migration-00${index + 1}.json`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
    const v1: AppManifest = { manifestVersion: '1.0', id: 'materials', version: '0.2.9', name: '物料管理', description: 'v1', publisherId: 'metro-apps',
      compatibility: { platform: { minInclusive: '0.0.1', maxExclusive: '2.0.0' }, capabilities: [], applications: [] }, permissions: { requested: [], defined: [] },
      ui: { mode: 'none' }, backend: { mode: 'external', origin: 'https://example.com' },
      storage: { mode: 'managed', migrations: [{ id: 'initial', artifactId: 'schema' }, { id: 'specification', artifactId: 'schema-two' }, { id: 'receiver', artifactId: 'schema-three' }] },
      routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [], resources: [], network: { frontendOrigins: [], backendOrigins: [] }, artifacts };
    await writeFile(join(v1Dir, 'manifest.json'), JSON.stringify(v1));
    const keys = generateKeyPairSync('ed25519'), privateFile = join(root, 'private.pem');
    await writeFile(privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const signatureFile = join(root, 'v1.signature.json'); await signAppDirectory(v1Dir, 'test-key', privateFile, signatureFile);
    const policy = { policyVersion: '1.0' as const, revision: 1, keys: [{ keyId: 'test-key', publisherId: 'metro-apps', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), revoked: false, appIds: ['materials'], validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }] };
    const v1Installer = new AppInstaller({ registry, journal, artifactRoot: join(root, 'packages'), loadPublisherPolicy: async () => policy, approve: async () => true, getHost: r => runtime!.getHost(r.appId) });
    assert.equal((await v1Installer.install(actor, { directory: v1Dir, signatureFile, requestId: 'materials-install-1' })).state, 'installed');
    let record = await registry.get(actor, 'materials');
    const plan = binding(record); if (plan.mode !== 'managed') throw Error('binding');
    assert.equal((await admin.query("SELECT count(*)::int n FROM platform_app_migration_attempts WHERE installation_id=$1 AND status='applied'", [record.id])).rows[0].n, 3);

    // Business data written through the v1 leased runtime-data path.
    const v1Actor = { actorType: 'service', execution: { type: 'service', appId: 'materials', serviceIdentityId: 'v1' }, authorize: async () => ({ allowed: true }) } as unknown as PlatformActorContext;
    const signal = new AbortController().signal, org = randomUUID(), person = randomUUID(), materialId = randomUUID(), movementId = randomUUID(), now = new Date().toISOString();
    const materialRow = { organization_id: org, name: '灭火器', sku: 'MFZ-4', unit: '具', quantity: 5, version: 0, request_id: randomUUID(), operator_id: person, created_at: now, specification: '4kg' };
    await storage.runtimeData.execute(v1Actor, { requestId: randomUUID(), operations: [{ table: 'materials', id: materialId, action: 'insert', values: materialRow }] }, 'transaction', signal);
    const movement = { organization_id: org, material_id: materialId, delta: -2, kind: 'out', request_id: randomUUID(), operator_id: person, created_at: now, receiver: '张巡检', receiver_id: person, reverses_id: null, remark: '月检领用' };
    await storage.runtimeData.execute(v1Actor, { requestId: randomUUID(), operations: [{ table: 'movements', id: movementId, action: 'insert', values: movement }] }, 'transaction', signal);
    await assert.rejects(api.query(`SELECT * FROM "${plan.schema}".materials`), /permission denied/, 'v1: the API role cannot read app tables');

    // v2 package, built from the converted project by the real CLI.
    const built = spawnSync(process.execPath, [CLI, 'build'], { cwd: MATERIALS, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const mopkg = await readFile(join(MATERIALS, 'dist', 'materials-0.3.0.mopkg'));

    pool = new Pool({ connectionString: apiUrl.href, max: 4 });
    const findInstallation = (appId: string) => new PostgresAppRegistryRepository(pool!).findByAppId(appId);
    const data = new AppDataServiceV2({ pool, findInstallation });
    const store = new AppPackageStoreV2(join(root, 'v2'));
    const v2Actor = (serviceIdentityId: string) => ({ actorType: 'service', execution: { type: 'service', appId: 'materials', serviceIdentityId }, authorize: async () => ({ allowed: true }) } as unknown as PlatformActorContext);
    const gateway = { drain: async () => {}, invokeHosted: async () => { throw Error('not used'); } } as unknown as AppGateway;
    host = new AppHostV2({ appId: 'materials', registry, store, gateway, api: { contextResolver: { resolve: async () => { throw Error('not used'); } }, authorize: async () => false, businessAuthorization: async () => undefined }, log: () => {} });
    const installer = new AppInstallerV2({ registry, findInstallation, pool, store, host: () => host!, platformVersion: () => '0.29.0' });

    await assert.rejects(installer.install(actor, mopkg), { code: 'V1_APP_DISABLE_REQUIRED' }, 'a running v1 app is never converted');
    record = await registry.get(actor, 'materials');
    record = await (await runtime.getHost('materials')).execute(actor, { revision: record.revision, action: 'disable' });

    // Non-superuser API role: ownership cannot be taken silently; the exact DBA statement is reported.
    const blocked = await installer.install(actor, mopkg).catch(error => error);
    assert.equal(blocked.code, 'SCHEMA_ADOPTION_REQUIRED');
    assert.equal((await admin.query('SELECT count(*)::int n FROM platform_app_v2_migrations')).rows[0].n, 0, 'nothing is recorded when adoption fails');
    assert.equal((await registry.get(actor, 'materials')).runtime, undefined, 'the registry is unchanged');
    const statement = /REASSIGN OWNED BY "[^"]+" TO "[^"]+";/.exec(blocked.issues[0].message)?.[0];
    assert.ok(statement, blocked.issues[0].message);
    await admin.query(statement!);

    const result = await installer.install(actor, mopkg);
    assert.deepEqual({ state: result.state, version: result.version, enabled: result.enabled }, { state: 'converted', version: '0.3.0', enabled: true });
    const converted = await registry.get(actor, 'materials');
    assert.equal(converted.id, record.id, 'same installation id, so owner, roles and employee access carry over');
    assert.equal(converted.runtime?.model, 'v2');
    assert.ok(converted.serviceIdentityId);
    assert.deepEqual((await admin.query('SELECT migration_id FROM platform_app_v2_migrations WHERE installation_id=$1 ORDER BY migration_id', [record.id])).rows.map(r => r.migration_id), migrations);
    assert.equal(host.status ? (await host.status(actor)).process?.state : null, 'running');

    // The v1 rows are served by the v2 data service, and new writes work.
    const service = v2Actor(converted.serviceIdentityId!);
    const material = await data.execute(service, converted, 'get', { table: 'materials', id: materialId }, signal) as { row: Record<string, unknown> };
    assert.equal(material.row.name, '灭火器'); assert.equal(material.row.quantity, 5); assert.equal(material.row.specification, '4kg');
    const moves = await data.execute(service, converted, 'list', { table: 'movements', pageSize: 10 }, signal) as { rows: { id: string }[] };
    assert.deepEqual(moves.rows.map(row => row.id), [movementId]);
    await data.execute(service, converted, 'transaction', { requestId: randomUUID(), operations: [{ table: 'materials', id: materialId, action: 'update', values: { quantity: 4, version: 1 }, expected: { version: 0 } }] }, signal);
    assert.equal(((await data.execute(service, converted, 'get', { table: 'materials', id: materialId }, signal)) as { row: { quantity: number } }).row.quantity, 4);
    assert.equal((await api.query(`SELECT count(*)::int n FROM "${plan.schema}".materials`)).rows[0].n, 1, 'the API role now owns the app schema');

    // Converting again is refused; the next upgrade follows the normal v2 path.
    await assert.rejects(installer.install(actor, mopkg), { code: 'VERSION_NOT_NEWER' });
  } finally {
    await host?.close();
    await pool?.end();
    await runtime?.close();
    await storage?.closeRuntimeConnections();
    if (admin) {
      const present = (await admin.query("SELECT to_regclass('public.platform_app_installations') AS table_name")).rows[0];
      if (present.table_name) for (const row of (await admin.query('SELECT id FROM public.platform_app_installations')).rows) { const stem = 'app_' + row.id.replaceAll('-', ''); roleNames.push(stem + '_owner', stem + '_runtime'); }
    }
    await api?.end(); await admin?.end();
    await supervisor.query(`DROP DATABASE IF EXISTS "${database}"`);
    for (const role of roleNames) await supervisor.query(`DROP ROLE IF EXISTS "${role}"`);
    await supervisor.query(`DROP ROLE IF EXISTS "${apiRole}"`); await supervisor.end(); await rm(root, { recursive: true, force: true });
  }
});
