import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AppDockerSupervisor, type AppDockerDispatchRequest } from '../src/app-platform/runtime/docker-supervisor.ts';
import { AppDockerJournal } from '../src/app-platform/runtime/docker-journal.ts';
import { APP_DOCKER_JOURNAL_SQL } from '../src/app-platform/runtime/docker-journal-migration.ts';
import { compileAppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';
import { APP_REGISTRY_SQL } from '../src/app-platform/registry/migration.ts';
import type { AppInstallation } from '../src/app-platform/registry/model.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
import type { QueryableClient } from '../src/core/database/index.ts';
import type { AppDockerContainerInspection } from '../src/app-platform/runtime/docker-transport.ts';

const id = '44000000-0000-4000-8000-000000000001', operationId = '44000000-0000-4000-8000-000000000002';
const containerId = 'c'.repeat(64);
async function setup() {
  const db = new PGlite();
  const client: QueryableClient = { query: async (sql, values) => values ? db.query(sql, [...values]) : db.exec(sql) };
  await db.exec(APP_REGISTRY_SQL); await db.exec(APP_DOCKER_JOURNAL_SQL);
  const installation: AppInstallation = {
    id, appId: 'supervisor-demo', revision: 1, enabled: false, serviceIdentityId: null, grants: [],
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    manifest: {
      manifestVersion: '1.0', id: 'supervisor-demo', version: '1.0.0', name: 'Demo', description: 'Supervisor demo', publisherId: 'example',
      compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
      permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
      backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
      health: { path: '/health', timeoutSeconds: 1 }, storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
      network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
      artifacts: [{ id: 'main', kind: 'backend', path: 'main.js', sha256: 'b'.repeat(64), bytes: 1 }],
    },
  };
  installation.lifecycle = { operationId, action: 'install', status: 'running', baseManifest: structuredClone(installation.manifest), targetManifest: null, startedAt: installation.createdAt, settledAt: null };
  const save = () => db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,record=EXCLUDED.record', [id,installation.appId,installation.revision,JSON.stringify({...installation,credentialDigest:null})]);
  await save();
  const policy = compileAppDockerPolicy({ installation, operationId, runtimeImage: `node@sha256:${'a'.repeat(64)}`, verifiedBundlePath: '/var/lib/afc/demo', network: 'none' });
  const request: AppDockerDispatchRequest = { appId: installation.appId, revision: 1, operationId, expectedSequence: 0, action: 'create', containerId: null, policy, approval: { imageId: `sha256:${'d'.repeat(64)}`, config: {} } };
  const admin = { actorType: 'person', execution: { type: 'platform' }, authorize: async () => ({ allowed: true }) } as unknown as PlatformActorContext;
  const registry = { get: async () => structuredClone(installation) };
  const journal = new AppDockerJournal(client);
  let observed: AppDockerContainerInspection | null = null, uncertain = false;
  const writes: string[] = [];
  const view = (status: string): AppDockerContainerInspection => ({ Id: containerId, Name: `/${policy.name}`, Image: request.approval.imageId, Config: {}, HostConfig: {}, State: { Status: status, Running: status === 'running' } });
  const executor = {
    async create() {
      assert.equal((await new AppDockerJournal(client).latest(id))?.status, 'dispatched', 'durable intent precedes Docker');
      writes.push('create'); if (uncertain) throw new Error('secret daemon error'); observed = view('created'); return observed;
    },
    async start() { writes.push('start'); observed = view('running'); return observed; },
    async stop() { writes.push('stop'); observed = view('exited'); return observed; },
    async remove() { writes.push('remove'); observed = null; },
    async observe() { return observed; },
  };
  return { db, client, installation, save, request, admin, registry, journal, executor, writes,
    service: () => new AppDockerSupervisor(registry, new AppDockerJournal(client), executor),
    setUncertain: () => { uncertain = true; }, materialize: () => { observed = view('created'); } };
}


import { AppDockerReadiness } from '../src/app-platform/runtime/docker-readiness.ts';

async function ready() {
  const f = await setup();
  const created = await f.service().dispatch(f.admin, f.request);
  await f.service().dispatch(f.admin, { ...f.request, action: 'start', containerId, expectedSequence: created.sequence });
  const now = new Date('2026-09-13T00:00:10Z');
  const found: AppDockerContainerInspection = { Id: containerId, Name: `/${f.request.policy.name}`, Image: f.request.approval.imageId,
    Config: {}, HostConfig: {}, State: { Status: 'running', Running: true, StartedAt: '2026-09-13T00:00:00Z',
      Health: { Status: 'healthy', FailingStreak: 0, Log: [{ Start: '2026-09-13T00:00:05Z', End: '2026-09-13T00:00:06Z', ExitCode: 0, Output: 'private output never exposed' }] } } };
  const observe = { observe: async () => found };
  const checker = () => new AppDockerReadiness(f.registry,f.journal,observe,() => now);
  const check = () => checker().check(f.admin,f.request.appId,1,operationId);
  return { ...f, now, found, observe, checker, check };
}

test('readiness requires confirmed running dispatch and recent successful probe; never enables', async () => {
  const f = await ready(); try {
    const result = await f.check();
    assert.equal(result.containerId,containerId);
    assert.equal(result.probeEndedAt,'2026-09-13T00:00:06.000Z');
    assert.equal(JSON.stringify(result).includes('private'),false);
    assert.equal(f.installation.enabled,false);
    assert.equal(f.installation.lifecycle?.status,'running');
    assert.deepEqual(f.writes,['create','start']);
  } finally { await f.db.close(); }
});

test('missing, starting, unhealthy, stale, pre-restart and future health fail closed', async () => {
  const f = await ready(); try {
    const state = structuredClone(f.found.State);
    const cases: ((value: Record<string,unknown>) => void)[] = [
      value => { value.Health = undefined; },
      value => { value.Health = { Status:'starting' }; },
      value => { value.Health = { Status:'unhealthy' }; },
      value => { value.Running = false; },
      value => { value.StartedAt = '2026-09-13T00:00:07Z'; },
      value => { value.Health = { Status:'healthy',FailingStreak:0,Log:[{Start:'2026-09-13T00:00:11Z',End:'2026-09-13T00:00:12Z',ExitCode:0}] }; },
      value => { value.Health = { Status:'healthy',FailingStreak:0,Log:[{Start:'2026-09-13T00:00:05Z',End:'2026-09-13T00:00:06Z',ExitCode:1}] }; },
    ];
    for (const mutate of cases) { f.found.State=structuredClone(state); mutate(f.found.State); await assert.rejects(f.check()); }
    f.found.State=structuredClone(state); f.now.setTime(Date.parse('2026-09-13T00:01:00Z'));
    await assert.rejects(f.check(),/HEALTH_EVIDENCE_STALE/);
    assert.deepEqual(f.writes,['create','start']);
  } finally { await f.db.close(); }
});

test('concurrent registry revocation and new dispatch invalidate health observation', async () => {
  const f = await ready(); try {
    f.observe.observe = async () => { f.installation.revision++; return f.found; };
    await assert.rejects(f.check(),/READINESS_CHANGED/);
    f.installation.revision=1;
    f.observe.observe = async () => {
      await f.service().dispatch(f.admin,{...f.request,action:'stop',containerId,expectedSequence:2});
      return f.found;
    };
    await assert.rejects(f.check(),/READINESS_CHANGED/);
  } finally { await f.db.close(); }
});

test('failed lifecycle and applications cannot obtain readiness evidence', async () => {
  const f = await ready(); try {
    const app = {...f.admin,execution:{type:'application',appId:f.request.appId}} as PlatformActorContext;
    await assert.rejects(f.checker().check(app,f.request.appId,1,operationId),/RUNTIME_ACCESS_DENIED/);
    f.installation.lifecycle!.status='failed';
    await assert.rejects(f.check(),/READINESS_LIFECYCLE_MISMATCH/);
  } finally { await f.db.close(); }
});


test('slow final state recheck cannot return an expired health result', async () => {
  const f = await ready(); try {
    let reads = 0;
    const registry = { get: async () => {
      if (++reads === 2) f.now.setTime(Date.parse('2026-09-13T00:01:00Z'));
      return structuredClone(f.installation);
    } };
    const checker = new AppDockerReadiness(registry,f.journal,f.observe,() => f.now);
    await assert.rejects(checker.check(f.admin,f.request.appId,1,operationId),/HEALTH_EVIDENCE_STALE/);
  } finally { await f.db.close(); }
});
