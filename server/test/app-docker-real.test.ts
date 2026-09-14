import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AppDockerJournal } from '../src/app-platform/runtime/docker-journal.ts';
import { APP_DOCKER_JOURNAL_SQL } from '../src/app-platform/runtime/docker-journal-migration.ts';
import { AppDockerReadiness, AppDockerReadinessError } from '../src/app-platform/runtime/docker-readiness.ts';
import { setTimeout as pause } from 'node:timers/promises';
import { AppDockerSupervisor } from '../src/app-platform/runtime/docker-supervisor.ts';
import { APP_REGISTRY_SQL } from '../src/app-platform/registry/migration.ts';
import type { QueryableClient } from '../src/core/database/index.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { stageAppArtifacts } from '../src/app-platform/runtime/artifacts.ts';
import { compileAppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';
import { AppDockerTransport } from '../src/app-platform/runtime/docker-transport.ts';
import { AppDockerExecutor } from '../src/app-platform/runtime/docker-executor.ts';
import type { AppInstallation } from '../src/app-platform/registry/model.ts';

const socketPath = process.env.AFC_DOCKER_TEST_SOCKET;
const runtimeImage = process.env.AFC_DOCKER_TEST_IMAGE;
const artifactRoot = process.env.AFC_DOCKER_TEST_ROOT;
function waitForIsolation(socket: string, identity: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--host', `unix://${socket}`, 'logs', '--follow', identity]);
    let output = '', done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(deadline); child.kill();
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => finish(new Error('Isolation probe timed out')), 10_000);
    child.on('error', error => finish(error));
    child.on('close', () => finish(new Error(`Probe exited before readiness: ${output}`)));
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 65536) finish(new Error('Probe output limit exceeded'));
      else if (output.includes('AFC_ISOLATION_OK')) finish();
    });
    child.stderr.resume();
  });
}

// Explicit opt-in: root must be writable and shared with the selected local Engine.
// Only this test's unique container and artifact directory are cleaned up; never prune.
for (const healthMode of ['healthy', 'redirect', 'oversize', 'hang'] as const) test(`real Engine isolation and health: ${healthMode}`, {
  skip: !socketPath || !runtimeImage || !artifactRoot,
  timeout: 60_000,
}, async () => {
  const transport = new AppDockerTransport({ socketPath: socketPath!, timeoutMs: 15_000 });
  const image = await transport.inspectImage(runtimeImage!);
  assert.ok(image, 'pre-pull a trusted digest-pinned Node image');
  // Test-only acceptance snapshot. Production must load separately reviewed approval records.
  const approval = { imageId: image.Id, config: image.Config };
  const executor = new AppDockerExecutor(transport);
  assert.equal(image.Config.Volumes == null, true, 'test image must not introduce volumes');
  const root = await mkdtemp(join(resolve(artifactRoot!), '.afc-docker-test-'));
  const source = Buffer.from(`
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.getuid(), 1000);
for (const path of ['/app/dist/main.js', '/forbidden']) {
  assert.throws(() => fs.writeFileSync(path, 'invalid'), e => ['EROFS', 'EACCES'].includes(e.code));
}
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
fs.writeFileSync('/tmp/probe', 'ok');
const status = fs.readFileSync('/proc/self/status', 'utf8');
assert.match(status, /NoNewPrivs:\\s+1/);
assert.match(status, /CapEff:\\s+0+\\n/);
assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), '134217728');
assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '64');
assert.equal(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(), '50000 100000');
assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo']);
require('node:http').createServer((req, res) => {
  if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
  const mode = ${JSON.stringify(healthMode)};
  if (mode === 'hang') return;
  if (mode === 'redirect') { res.writeHead(302, { Location: '/elsewhere' }); res.end(); return; }
  res.writeHead(200); res.end(mode === 'oversize' ? 'x'.repeat(65537) : 'ok');
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('AFC_ISOLATION_OK'));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const installation: AppInstallation = {
    id: randomUUID(), appId: 'docker-smoke', revision: 1, enabled: false,
    serviceIdentityId: null, grants: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    manifest: {
      manifestVersion: '1.0', id: 'docker-smoke', version: '1.0.0', name: 'Docker smoke', description: 'Local isolation acceptance', publisherId: 'example',
      compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
      permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
      backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
      health: { path: '/health', timeoutSeconds: 1 }, storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
      network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
      artifacts: [{ id: 'main', kind: 'backend', path: 'dist/main.js', sha256: createHash('sha256').update(source).digest('hex'), bytes: source.length }],
    },
  };
  const operationId = randomUUID();
  installation.lifecycle = { operationId, action: 'install', status: 'running', baseManifest: structuredClone(installation.manifest), targetManifest: null, startedAt: installation.createdAt, settledAt: null };
  const db = new PGlite();
  const client: QueryableClient = { query: async (sql, values) => values ? db.query(sql, [...values]) : db.exec(sql) };
  await db.exec(APP_REGISTRY_SQL); await db.exec(APP_DOCKER_JOURNAL_SQL);
  await db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,$3,$4)', [installation.id, installation.appId, installation.revision, JSON.stringify({ ...installation, credentialDigest: null })]);
  const admin = { actorType: 'person', execution: { type: 'platform' }, authorize: async () => ({ allowed: true }) } as unknown as PlatformActorContext;
  const supervisor = () => new AppDockerSupervisor({ get: async () => structuredClone(installation) }, new AppDockerJournal(client), executor);
  let identity: string | undefined;
  let removed = false;
  try {
    const bundle = await stageAppArtifacts({ root, manifest: installation.manifest, read: async () => source });
    const policy = compileAppDockerPolicy({ installation, operationId, runtimeImage: runtimeImage!, verifiedBundlePath: bundle.path, network: 'none' });
    // Retain the exact name even on an uncertain create response so cleanup can observe it.
    identity = policy.name;
    const request = { appId: installation.appId, revision: installation.revision, operationId, policy, approval };
    let receipt = await supervisor().dispatch(admin, { ...request, action: 'create', containerId: null, expectedSequence: 0 });
    identity = receipt.observation!.containerId;
    const before = await transport.inspectContainer(identity);
    assert.ok(before);
    assert.equal(before.Image, image.Id);
    assert.deepEqual(before.Config.Labels, policy.body.Labels);
    assert.equal(before.HostConfig.ReadonlyRootfs, true);
    assert.equal(before.HostConfig.MemorySwap, policy.body.HostConfig.Memory);
    assert.equal(before.State.Running, false);
    receipt = await supervisor().dispatch(admin, { ...request, action: 'start', containerId: identity, expectedSequence: receipt.sequence });
    await waitForIsolation(socketPath!, identity);
    assert.equal((await transport.inspectContainer(identity))?.State.Running, true);
    const readiness = new AppDockerReadiness({ get: async () => structuredClone(installation) }, new AppDockerJournal(client), executor);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const observed = await transport.inspectContainer(identity);
      const state = observed?.State.Health as { Status?: string } | undefined;
      if (state?.Status === (healthMode === 'healthy' ? 'healthy' : 'unhealthy')
        && (healthMode !== 'healthy' || Date.parse(String((state as {Log?:{End?:string}[]}).Log?.at(-1)?.End)) <= Date.now())) break;
      assert.ok(Date.now() < deadline, 'Docker health transition deadline');
      await pause(100);
    }
    if (healthMode === 'healthy') {
      const result = await readiness.check(admin,installation.appId,1,operationId);
      assert.equal(result.containerId,identity);
    } else {
      await assert.rejects(readiness.check(admin,installation.appId,1,operationId), (error: unknown) => error instanceof AppDockerReadinessError && error.code === 'RUNTIME_NOT_HEALTHY');
    }
    assert.equal(installation.enabled,false);
    receipt = await supervisor().dispatch(admin, { ...request, action: 'stop', containerId: identity, expectedSequence: receipt.sequence });
    const stopped = await transport.inspectContainer(identity);
    assert.equal(stopped?.State.Running, false);
    assert.equal(stopped?.State.ExitCode, 0);
    receipt = await supervisor().dispatch(admin, { ...request, action: 'remove', containerId: identity, expectedSequence: receipt.sequence });
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.observation?.state, 'absent');
    assert.equal(await transport.inspectContainer(identity), null);
    removed = true;
  } finally {
    let cleanupConfirmed = true;
    if (identity && !removed) {
      const current = await transport.inspectContainer(identity);
      if (current) {
        await transport.stopContainer(current.Id, 3);
        await transport.removeContainer(current.Id);
      } else if (!/^[0-9a-f]{64}$/.test(identity)) {
        // A timed-out create may still materialize after this 404. Retain its inputs.
        cleanupConfirmed = false;
        console.error(`Uncertain test create; reconcile ${identity}; retained artifacts ${root}`);
      }
    }
    await db.close();
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
  }
});
