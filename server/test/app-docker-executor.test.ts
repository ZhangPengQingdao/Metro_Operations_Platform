import assert from 'node:assert/strict';
import test from 'node:test';
import { AppDockerExecutor, AppDockerExecutorError } from '../src/app-platform/runtime/docker-executor.ts';
import { AppDockerTransportError, type AppDockerContainerInspection } from '../src/app-platform/runtime/docker-transport.ts';
import { compileAppDockerPolicy, type AppDockerPolicyInput } from '../src/app-platform/runtime/docker-policy.ts';

const id = 'a'.repeat(64), otherId = 'c'.repeat(64), imageId = `sha256:${'b'.repeat(64)}`;
function fixture(health = false) {
  const input: AppDockerPolicyInput = {
    operationId: '43000000-0000-4000-8000-000000000002', runtimeImage: `node@${imageId}`,
    verifiedBundlePath: '/var/lib/afc/bundles/verified', network: 'none',
    installation: {
      id: '43000000-0000-4000-8000-000000000001', appId: 'demo', revision: 1,
      enabled: false, serviceIdentityId: null, grants: [], createdAt: '', updatedAt: '',
      manifest: {
        manifestVersion: '1.0', id: 'demo', version: '1.0.0', name: 'Demo', description: 'Demo', publisherId: 'example',
        compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
        permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
        backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
        storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
        network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
        artifacts: [{ id: 'main', kind: 'backend', path: 'main.js', sha256: 'd'.repeat(64), bytes: 1 }],
      },
    },
  };
  if (health) input.installation.manifest.health = { path: '/ready', timeoutSeconds: 1 };
  const policy = compileAppDockerPolicy(input);
  const approval = { imageId, config: { Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=22'], Entrypoint: ['docker-entrypoint.sh'], Cmd: ['node'] } };
  const { HostConfig, ...config } = structuredClone(policy.body);
  const container: AppDockerContainerInspection = {
    Id: id, Name: `/${policy.name}`, Image: imageId, Path: 'node', Args: [...policy.body.Cmd],
    Config: { ...config, Env: [...policy.body.Env, ...approval.config.Env], Volumes: null, StdinOnce: false },
    HostConfig: { ...HostConfig, Binds: null, CapAdd: null, PortBindings: {}, Runtime: 'runc',
      MaskedPaths: ['/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/latency_stats',
        '/proc/sched_debug', '/proc/scsi', '/proc/timer_list', '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware'],
      ReadonlyPaths: ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
    },
    Mounts: [{ Type: 'bind', Source: input.verifiedBundlePath, Destination: '/app', RW: false, Propagation: 'rprivate', Mode: '' }],
    NetworkSettings: { Ports: {}, Networks: {} },
    State: { Running: false, Status: 'created', Paused: false, Restarting: false, Dead: false },
  };
  let current: AppDockerContainerInspection | null = container;
  const writes: string[] = [], reads: string[] = [];
  const image = { Id: imageId, RepoDigests: [policy.body.Image], Config: structuredClone(approval.config) as Record<string, unknown> };
  const transport = {
    async inspectImage() { return image; },
    async inspectContainer(identity: string) { reads.push(identity); return structuredClone(current); },
    async createContainer() { writes.push('create'); current = structuredClone(container); return { Id: id }; },
    async startContainer(identity: string) { writes.push(`start:${identity}`); current!.State.Status = 'running'; current!.State.Running = true; },
    async stopContainer(identity: string) { writes.push(`stop:${identity}`); current!.State.Status = 'exited'; current!.State.Running = false; },
    async removeContainer(identity: string) { writes.push(`remove:${identity}`); current = null; },
  };
  return { policy, approval, container, transport, image, writes, reads, setCurrent(value: AppDockerContainerInspection | null) { current = value; } };
}
function error(code: string, uncertain = false) {
  return (value: unknown) => { assert.ok(value instanceof AppDockerExecutorError); assert.equal(value.code, code); assert.equal(value.uncertain, uncertain); return true; };
}

test('approved image and exact policy allow single create/start/stop/remove dispatch by immutable ID', async () => {
  const f = fixture(), executor = new AppDockerExecutor(f.transport);
  f.setCurrent(null);
  const created = await executor.create(f.policy, f.approval);
  assert.equal(created.Id, id);
  assert.equal((await executor.start(f.policy, f.approval, id)).State.Running, true);
  assert.equal((await executor.stop(f.policy, f.approval, id)).State.Running, false);
  await executor.remove(f.policy, f.approval, id);
  assert.deepEqual(f.writes, ['create', `start:${id}`, `stop:${id}`, `remove:${id}`]);
  assert.deepEqual(f.reads.slice(0, 2), [f.policy.name, id]);
  assert.ok(f.reads.slice(2).every(value => value === id));
});

test('policy, identity, mounts, environment, resource and namespace mismatches prevent mutation', async () => {
  const mutations: ((c: AppDockerContainerInspection) => void)[] = [
    c => { c.Id = otherId; }, c => { c.Name = '/wrong'; }, c => { c.Image = `sha256:${'f'.repeat(64)}`; },
    c => { c.Config.Labels = {}; }, c => { c.Config.Env = ['NODE_OPTIONS=--require=/evil']; },
    c => { c.HostConfig.Privileged = true; }, c => { c.HostConfig.MemorySwap = -1; },
    c => { c.HostConfig.NetworkMode = 'host'; }, c => { c.HostConfig.PidMode = 'host'; },
    c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; }, c => { c.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    c => { c.HostConfig.MaskedPaths = []; }, c => { c.HostConfig.ReadonlyPaths = []; },
    c => { c.HostConfig.PortBindings = { '80/tcp': [{ HostPort: '8080' }] }; },
    c => { c.HostConfig.UnreviewedSetting = true; }, c => { c.Mounts = []; },
    c => { c.Config.Volumes = { '/secret': {} }; }, c => { c.Args = ['/evil.js']; },
    c => { c.NetworkSettings = { Ports: {}, Networks: { bridge: {} } }; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.container);
    await assert.rejects(new AppDockerExecutor(f.transport).start(f.policy, f.approval, id));
    assert.deepEqual(f.writes, []);
  }
});

test('exact image approval prevents hidden config, mutable identity or unknown digest acceptance', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.image.Id = `sha256:${'f'.repeat(64)}`; },
    (f: ReturnType<typeof fixture>) => { f.image.RepoDigests = []; },
    (f: ReturnType<typeof fixture>) => { f.image.Config.Env = ['PATH=/evil']; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(new AppDockerExecutor(f.transport).start(f.policy, f.approval, id), error('IMAGE_APPROVAL_MISMATCH'));
    assert.deepEqual(f.writes, []);
  }
  for (const extra of [{ Volumes: { '/data': {} } }, { OnBuild: ['RUN bad'] }, { Healthcheck: { Test: ['CMD', 'bad'] } },
    { ExposedPorts: { '80/tcp': {} } }, { Env: ['NODE_OPTIONS=--require=/evil'] }]) {
    const f = fixture(); Object.assign(f.image.Config, extra); Object.assign(f.approval.config, extra);
    await assert.rejects(new AppDockerExecutor(f.transport).start(f.policy, f.approval, id), error('IMAGE_CONFIG_REJECTED'));
    assert.deepEqual(f.writes, []);
  }
});

test('name swapping after discovery cannot redirect subsequent mutation to another container', async () => {
  const f = fixture(), executor = new AppDockerExecutor(f.transport);
  assert.equal((await executor.observe(f.policy, f.approval))?.Id, id);
  f.transport.inspectContainer = async identity => {
    f.reads.push(identity);
    return structuredClone(identity === f.policy.name ? { ...f.container, Id: otherId } : f.container);
  };
  // start confirmation uses same ID; fake mutation changes f.container via current reference.
  await executor.start(f.policy, f.approval, id);
  assert.deepEqual(f.writes, [`start:${id}`]);
  await assert.rejects(executor.start(f.policy, f.approval, f.policy.name), error('IMMUTABLE_CONTAINER_ID_REQUIRED'));
});

test('uncertain create/start/stop/remove remain uncertain; no automatic retry, cleanup or replacement', async () => {
  for (const action of ['create', 'start', 'stop', 'remove'] as const) {
    const f = fixture();
    if (action === 'create') f.setCurrent(null);
    if (action === 'stop') { f.container.State.Status = 'running'; f.container.State.Running = true; }
    const reject = async () => { f.writes.push(action); throw new AppDockerTransportError('TIMEOUT', true); };
    if (action === 'create') f.transport.createContainer = reject;
    if (action === 'start') f.transport.startContainer = reject;
    if (action === 'stop') f.transport.stopContainer = reject;
    if (action === 'remove') f.transport.removeContainer = reject;
    const executor = new AppDockerExecutor(f.transport);
    await assert.rejects(action === 'create' ? executor.create(f.policy, f.approval) : executor[action](f.policy, f.approval, id), error('TIMEOUT', true));
    await executor.observe(f.policy, f.approval);
    assert.deepEqual(f.writes, [action]);
  }
});

test('post-dispatch mismatch remains uncertain with known ID and never triggers cleanup', async () => {
  const f = fixture();
  f.transport.startContainer = async identity => { f.writes.push(identity); f.container.HostConfig.Privileged = true; };
  await assert.rejects(new AppDockerExecutor(f.transport).start(f.policy, f.approval, id), value => {
    assert.ok(value instanceof AppDockerExecutorError); assert.equal(value.uncertain, true); assert.equal(value.containerId, id); return true;
  });
  assert.deepEqual(f.writes, [id]);
});

test('existing or exited containers cannot be silently created/restarted; running cannot be removed', async () => {
  const f = fixture(), executor = new AppDockerExecutor(f.transport);
  await assert.rejects(executor.create(f.policy, f.approval), error('CONTAINER_ALREADY_EXISTS'));
  f.container.State.Status = 'exited';
  await assert.rejects(executor.start(f.policy, f.approval, id), error('CREATED_CONTAINER_REQUIRED'));
  f.container.State.Status = 'running'; f.container.State.Running = true;
  await assert.rejects(executor.remove(f.policy, f.approval, id), error('STOPPED_CONTAINER_REQUIRED'));
  assert.deepEqual(f.writes, []);
});

test('approval and policy snapshot cannot change during asynchronous preflight', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.transport.inspectImage = async () => { await gate; return f.image; };
  const work = new AppDockerExecutor(f.transport).start(f.policy, f.approval, id);
  f.approval.config.Env[0] = 'PATH=/evil'; release();
  await work;
  assert.deepEqual(f.writes, [`start:${id}`]);
});

test('image disappearance cannot block observation, verified shutdown and removal', async () => {
  const f = fixture(), executor = new AppDockerExecutor(f.transport);
  f.container.State.Status = 'running'; f.container.State.Running = true;
  f.transport.inspectImage = async () => { throw new Error('image no longer available'); };
  assert.equal((await executor.observe(f.policy, f.approval, id))?.Id, id);
  await executor.stop(f.policy, f.approval, id);
  await executor.remove(f.policy, f.approval, id);
  assert.deepEqual(f.writes, [`stop:${id}`, `remove:${id}`]);
});

test('Engine start normalization of OomKillDisable null is accepted but true is rejected', async () => {
  const f = fixture(), executor = new AppDockerExecutor(f.transport);
  f.container.HostConfig.OomKillDisable = null;
  await executor.start(f.policy, f.approval, id);
  f.container.HostConfig.OomKillDisable = true;
  await assert.rejects(executor.stop(f.policy, f.approval, id), error('CONTAINER_POLICY_MISMATCH'));
  assert.deepEqual(f.writes, [`start:${id}`]);
});


test('health configuration is verified before Docker start and cannot be replaced with a shell or weaker checks', async () => {
  const valid = fixture(true);
  assert.equal((await new AppDockerExecutor(valid.transport).start(valid.policy, valid.approval, id)).State.Running, true);
  for (const mutation of [
    { Test: ['NONE'] }, { Test: ['CMD-SHELL', 'exit 0'] }, { Timeout: 0 }, { Interval: 60_000_000_000 },
    { Retries: 10 }, { StartPeriod: 60_000_000_000 }, { StartInterval: 60_000_000_000 }, { Unknown: true },
  ]) {
    const f = fixture(true);
    Object.assign(f.container.Config.Healthcheck as Record<string, unknown>, mutation);
    await assert.rejects(new AppDockerExecutor(f.transport).start(f.policy, f.approval, id), error('CONTAINER_POLICY_MISMATCH'));
    assert.deepEqual(f.writes, []);
  }
});


test('Engine omitted zero health startup grace is accepted without defaulting any other field', async () => {
  const f = fixture(true);
  delete (f.container.Config.Healthcheck as Record<string, unknown>).StartPeriod;
  assert.equal((await new AppDockerExecutor(f.transport).start(f.policy, f.approval, id)).State.Running, true);
  for (const key of ['Test', 'Interval', 'Timeout', 'Retries', 'StartInterval']) {
    const invalid = fixture(true);
    delete (invalid.container.Config.Healthcheck as Record<string, unknown>)[key];
    await assert.rejects(new AppDockerExecutor(invalid.transport).start(invalid.policy, invalid.approval, id), error('CONTAINER_POLICY_MISMATCH'));
    assert.deepEqual(invalid.writes, []);
  }
});


test('create rejection requires completed invalid-request response and verified absence',async()=>{
 for(const mode of ['absent','present','inspect-fails','timeout','server-error'] as const){
  const f=fixture();f.setCurrent(null);
  f.transport.createContainer=async()=>{
   f.writes.push('create');
   if(mode==='present')f.setCurrent(f.container);
   if(mode==='inspect-fails')f.transport.inspectContainer=async()=>{throw new Error('unavailable');};
   throw mode==='timeout'?new AppDockerTransportError('TIMEOUT',true):mode==='server-error'?new AppDockerTransportError('DAEMON_REJECTED',true,500):new AppDockerTransportError('CREATE_REQUEST_REJECTED',false,400);
  };
  await assert.rejects(new AppDockerExecutor(f.transport).create(f.policy,f.approval),value=>{
   assert.ok(value instanceof AppDockerExecutorError);assert.equal(value.uncertain,mode!=='absent');return true;
  });
  assert.deepEqual(f.writes,['create']);
 }
});
