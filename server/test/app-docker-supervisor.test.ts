import { AppDockerTransport } from '../src/app-platform/runtime/docker-transport.ts';
import { AppDockerExecutor, AppDockerExecutorError } from '../src/app-platform/runtime/docker-executor.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AppDockerSupervisor, type AppDockerDispatchRequest } from '../src/app-platform/runtime/docker-supervisor.ts';
import { AppDockerJournal } from '../src/app-platform/runtime/docker-journal.ts';
import { APP_DOCKER_JOURNAL_SQL, APP_DOCKER_REJECTION_SQL } from '../src/app-platform/runtime/docker-journal-migration.ts';
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
  await db.exec(APP_REGISTRY_SQL); await db.exec(APP_DOCKER_JOURNAL_SQL); await db.exec(APP_DOCKER_REJECTION_SQL);
  const installation: AppInstallation = {
    id, appId: 'supervisor-demo', revision: 1, enabled: false, serviceIdentityId: null, grants: [],
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    manifest: {
      manifestVersion: '1.0', id: 'supervisor-demo', version: '1.0.0', name: 'Demo', description: 'Supervisor demo', publisherId: 'example',
      compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
      permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
      backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
      storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
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

test('supervisor persists before dispatch, then binds every step to one container', async () => {
  const f = await setup(); try {
    const service = f.service();
    let result = await service.dispatch(f.admin, f.request);
    assert.equal(result.status, 'confirmed'); assert.equal(result.observation?.containerId, containerId);
    for (const action of ['start', 'stop', 'remove'] as const) {
      result = await service.dispatch(f.admin, { ...f.request, action, containerId, expectedSequence: result.sequence });
    }
    assert.equal(result.observation?.state, 'absent');
    assert.deepEqual(f.writes, ['create','start','stop','remove']);
    assert.equal(f.installation.enabled, false);
    assert.equal(f.installation.lifecycle?.status, 'running');
  } finally { await f.db.close(); }
});

test('uncertain create survives service reconstruction; absent is not retry permission', async () => {
  const f = await setup(); try {
    f.setUncertain();
    await assert.rejects(f.service().dispatch(f.admin,f.request), /RUNTIME_DISPATCH_UNCERTAIN/);
    const attempt = (await f.journal.latest(id))!;
    assert.equal(attempt.status,'uncertain');
    await assert.rejects(f.service().reconcile(f.admin,f.request.appId,attempt.id), /RUNTIME_OUTCOME_UNCONFIRMED/);
    await assert.rejects(f.service().dispatch(f.admin,{...f.request,expectedSequence:1}), /DISPATCH_BLOCKED/);
    assert.deepEqual(f.writes,['create']);
    f.materialize();
    assert.equal((await f.service().reconcile(f.admin,f.request.appId,attempt.id)).status,'confirmed');
    assert.deepEqual(f.writes,['create'], 'reconcile is read-only on Docker');
  } finally { await f.db.close(); }
});

test('authorization, stale lifecycle and mismatched policy fail before dispatch', async () => {
  const f = await setup(); try {
    const app = { ...f.admin, execution: { type: 'application', appId: f.request.appId } } as PlatformActorContext;
    await assert.rejects(f.service().dispatch(app,f.request), /RUNTIME_ACCESS_DENIED/);
    await assert.rejects(f.service().dispatch(f.admin,{...f.request,revision:2}), /RUNTIME_LIFECYCLE_MISMATCH/);
    const policy = structuredClone(f.request.policy); Object.assign(policy.body.HostConfig,{Privileged:true});
    await assert.rejects(f.service().dispatch(f.admin,{...f.request,policy}), /RUNTIME_POLICY_MISMATCH/);
    f.installation.lifecycle!.action = 'disable'; await f.save();
    await assert.rejects(f.service().dispatch(f.admin,f.request), /RUNTIME_START_FORBIDDEN/);
    assert.equal(await f.journal.latest(id),null); assert.deepEqual(f.writes,[]);
  } finally { await f.db.close(); }
});

test('confirmation failure retains dispatched record and restart reconciles without replay', async () => {
  const f = await setup(); try {
    const broken = { reserve: f.journal.reserve.bind(f.journal), latest: f.journal.latest.bind(f.journal), finish: async (): Promise<never> => { throw new Error('commit unavailable'); } };
    const service = new AppDockerSupervisor(f.registry,broken,f.executor);
    await assert.rejects(service.dispatch(f.admin,f.request), /RUNTIME_JOURNAL_UNCERTAIN/);
    const attempt = (await f.journal.latest(id))!;
    assert.equal(attempt.status,'dispatched');
    assert.equal((await f.service().reconcile(f.admin,f.request.appId,attempt.id)).status,'confirmed');
    assert.deepEqual(f.writes,['create']);
  } finally { await f.db.close(); }
});


test('definitive create rejection survives restart and permits only an explicit new dispatch', async () => {
 const f=await setup(); try {
  f.executor.create=async()=>{f.writes.push('create');throw new AppDockerExecutorError('CREATE_REQUEST_REJECTED',false);};
  await assert.rejects(f.service().dispatch(f.admin,f.request),/RUNTIME_CREATE_REJECTED/);
  const attempt=(await f.journal.latest(id))!;
  assert.equal(attempt.status,'rejected');assert.equal(attempt.observation,null);
  assert.equal((await f.service().reconcile(f.admin,f.request.appId,attempt.id)).status,'rejected');
  assert.deepEqual(f.writes,['create']);
  await assert.rejects(f.journal.finish(id,attempt.id,attempt.sequence,{status:'uncertain'}),/TERMINAL_CONFLICT/);
  await assert.rejects(f.service().dispatch(f.admin,{...f.request,expectedSequence:1}),/RUNTIME_CREATE_REJECTED/);
  assert.equal((await f.journal.latest(id))!.sequence,2);
  assert.deepEqual(f.writes,['create','create']);
 } finally {await f.db.close();}
});

test('unknown create cannot be relabelled rejected; rejection persistence failure stays blocked',async()=>{
 const f=await setup();try{
  f.setUncertain();await assert.rejects(f.service().dispatch(f.admin,f.request),/RUNTIME_DISPATCH_UNCERTAIN/);
  const attempt=(await f.journal.latest(id))!;
  await assert.rejects(f.journal.finish(id,attempt.id,attempt.sequence,{status:'rejected'}),/INVALID_OUTCOME/);
 }finally{await f.db.close();}
 const g=await setup();try{
  g.executor.create=async()=>{throw new AppDockerExecutorError('CREATE_REQUEST_REJECTED',false);};
  const journal={reserve:g.journal.reserve.bind(g.journal),latest:g.journal.latest.bind(g.journal),finish:async():Promise<never>=>{throw new Error('commit unavailable');}};
  await assert.rejects(new AppDockerSupervisor(g.registry,journal,g.executor).dispatch(g.admin,g.request),/RUNTIME_JOURNAL_UNCERTAIN/);
  assert.equal((await g.journal.latest(id))!.status,'dispatched');
  await assert.rejects(g.service().dispatch(g.admin,{...g.request,expectedSequence:1}),/DISPATCH_BLOCKED/);
 }finally{await g.db.close();}
});


test('real Engine invalid bind mount produces a durable rejected create',{
 skip:!process.env.AFC_DOCKER_TEST_SOCKET||!process.env.AFC_DOCKER_TEST_IMAGE,timeout:30000,
},async()=>{
 const f=await setup();try{
  const transport=new AppDockerTransport({socketPath:process.env.AFC_DOCKER_TEST_SOCKET!});
  const image=await transport.inspectImage(process.env.AFC_DOCKER_TEST_IMAGE!);assert.ok(image);
  const policy=compileAppDockerPolicy({installation:f.installation,operationId,runtimeImage:process.env.AFC_DOCKER_TEST_IMAGE!,verifiedBundlePath:`/afc-missing-rejection-test-${crypto.randomUUID()}`,network:'none'});
  const service=new AppDockerSupervisor(f.registry,f.journal,new AppDockerExecutor(transport));
  await assert.rejects(service.dispatch(f.admin,{...f.request,policy,approval:{imageId:image.Id,config:image.Config}}),/RUNTIME_CREATE_REJECTED/);
  const attempt=(await f.journal.latest(id))!;assert.equal(attempt.status,'rejected');
  assert.equal(await transport.inspectContainer(policy.name),null);
  assert.equal((await service.reconcile(f.admin,f.request.appId,attempt.id)).status,'rejected');
 }finally{await f.db.close();}
});
