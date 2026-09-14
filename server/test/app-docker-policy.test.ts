import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { compileAppDockerPolicy, type AppDockerPolicyInput } from '../src/app-platform/runtime/docker-policy.ts';

function fixture(): AppDockerPolicyInput {
  return {
    operationId: '43000000-0000-4000-8000-000000000002',
    runtimeImage: `registry.example.com/afc/node@sha256:${'a'.repeat(64)}`,
    verifiedBundlePath: '/var/lib/afc/bundles/verified-123', network: 'none',
    installation: {
      id: '43000000-0000-4000-8000-000000000001', appId: 'demo', revision: 1,
      enabled: false, serviceIdentityId: null, grants: [], createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
      manifest: {
        manifestVersion: '1.0', id: 'demo', version: '1.0.0', name: 'Demo', description: 'Demo backend', publisherId: 'example',
        compatibility: { platform: { minInclusive: '0.0.1-alpha.49', maxExclusive: '2.0.0' }, capabilities: [], applications: [] },
        permissions: { requested: [], defined: [] }, ui: { mode: 'none' },
        backend: { mode: 'isolated', runtime: 'node', entryArtifactId: 'main', limits: { memoryMiB: 128, cpuMillis: 500, timeoutSeconds: 30 } },
        storage: { mode: 'none' }, routes: [], api: [], navigation: [], events: { publish: [], subscribe: [] }, tools: [], jobs: [],
        network: { frontendOrigins: [], backendOrigins: [] }, resources: [],
        artifacts: [{ id: 'main', kind: 'backend', path: 'dist/main.js', sha256: 'b'.repeat(64), bytes: 123 }],
      },
    },
  };
}

test('Docker compiler fixes isolation, resource and identity policy for hosted Node', () => {
  const input = fixture();
  const policy = compileAppDockerPolicy(input), body = policy.body, host = body.HostConfig;
  assert.equal(policy.name, `afc-app-${input.installation.id}-${input.operationId}`);
  assert.deepEqual(body.Labels, { 'afc.app.id': 'demo', 'afc.app.installation': input.installation.id, 'afc.app.version': '1.0.0', 'afc.app.operation': input.operationId });
  assert.deepEqual(body.Entrypoint, ['node']); assert.deepEqual(body.Cmd, ['/app/dist/main.js']);
  assert.equal(body.User, '1000:1000'); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ['ALL']); assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(host.NetworkMode, 'none'); assert.equal(body.NetworkDisabled, true);
  assert.equal(host.Memory, 128 * 1024 * 1024); assert.equal(host.MemorySwap, host.Memory);
  assert.equal(host.NanoCpus, 500_000_000); assert.equal(host.PidsLimit, 64);
  assert.equal(host.Mounts.length, 1); assert.equal(host.Mounts[0].ReadOnly, true);
  assert.equal(host.Mounts[0].BindOptions.ReadOnlyForceRecursive, true);
  assert.equal(host.RestartPolicy.Name, 'no'); assert.equal(host.AutoRemove, false);
  assert.deepEqual(body.Healthcheck.Test, ['NONE']);
  assert.equal(JSON.stringify(policy).includes('docker.sock'), false);
});

test('policy is deeply frozen, snapshots inputs and does not accept application overrides', () => {
  const input = fixture();
  Object.assign(input, { HostConfig: { Privileged: true }, Cmd: ['sh'], Env: ['NODE_OPTIONS=--require=evil'] });
  const policy = compileAppDockerPolicy(input);
  input.installation.manifest.version = '2.0.0'; input.verifiedBundlePath = '/etc';
  assert.equal(policy.body.Labels['afc.app.version'], '1.0.0');
  assert.equal(policy.body.HostConfig.Mounts[0].Source, '/var/lib/afc/bundles/verified-123');
  assert.equal(policy.body.HostConfig.Privileged, false);
  assert.throws(() => Object.assign(policy.body.HostConfig, { Privileged: true }), TypeError);
  assert.equal(Object.isFrozen(policy.body.Cmd), true);
  assert.deepEqual(policy.body.Env, ['NODE_ENV=production', 'HOME=/tmp', 'PORT=8080']);
});

test('invalid installation, manifest and resource ceilings fail closed', () => {
  const mutations: ((input: AppDockerPolicyInput) => void)[] = [
    x => { x.installation.id = 'invalid'; }, x => { x.operationId = 'invalid'; },
    x => { x.installation.revision = 0; }, x => { x.installation.appId = 'other'; },
    x => { x.installation.manifest.artifacts[0].path = '../main.js'; },
    x => { Object.assign(x.installation.manifest.backend, { limits: { memoryMiB: 1025, cpuMillis: 100, timeoutSeconds: 30 } }); },
    x => { Object.assign(x.installation.manifest.backend, { limits: { memoryMiB: 128, cpuMillis: 2001, timeoutSeconds: 30 } }); },
    x => { Object.assign(x.installation.manifest.backend, { runtime: 'shell' }); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => compileAppDockerPolicy(input)); }
});

test('unpinned images, unsafe mounts and alternate network modes rejected', () => {
  for (const runtimeImage of ['node:22', 'node@sha256:123', `node:latest@sha256:${'a'.repeat(64)}`, `node@sha256:${'A'.repeat(64)}`, '-evil']) {
    assert.throws(() => compileAppDockerPolicy({ ...fixture(), runtimeImage }), /PINNED_IMAGE_REQUIRED/);
  }
  for (const verifiedBundlePath of ['/', 'relative', '/a/../b', '/a//b', '/a/', '/a,b', '/a\n', '/a\\b']) {
    assert.throws(() => compileAppDockerPolicy({ ...fixture(), verifiedBundlePath }), /INVALID_BUNDLE_PATH/);
  }
  const input = fixture(); Object.assign(input, { network: 'host' });
  assert.throws(() => compileAppDockerPolicy(input), /NETWORK_UNAVAILABLE/);
});

test('trusted backends receive same isolation; static/external apps have no Docker policy', () => {
  const input = fixture(); Object.assign(input.installation.manifest.backend, { mode: 'trusted' });
  assert.equal(compileAppDockerPolicy(input).body.HostConfig.Privileged, false);
  for (const backend of [{ mode: 'none' as const }, { mode: 'external' as const, origin: 'https://example.com' }]) {
    input.installation.manifest.backend = backend;
    input.installation.manifest.artifacts = [];
    assert.throws(() => compileAppDockerPolicy(input), /HOSTED_BACKEND_REQUIRED/);
  }
});

test('deterministic names prevent blind replacement while exact labels distinguish versions', () => {
  const input = fixture(), first = compileAppDockerPolicy(input);
  assert.deepEqual(compileAppDockerPolicy(input), first);
  input.operationId = '43000000-0000-4000-8000-000000000003';
  assert.notEqual(compileAppDockerPolicy(input).name, first.name);
  input.operationId = fixture().operationId;
  input.installation.manifest.version = '1.1.0';
  const changed = compileAppDockerPolicy(input);
  assert.equal(changed.name, first.name);
  assert.notDeepEqual(changed.body.Labels, first.body.Labels);
});


test('declared health compiles fixed loopback CMD probe and bounded Engine schedule', () => {
  for (const timeoutSeconds of [1, 60]) {
    const input = fixture(); input.installation.manifest.health = { path: '/health/ready', timeoutSeconds };
    const health = compileAppDockerPolicy(input).body.Healthcheck;
    assert.deepEqual(health.Test.slice(0, 3), ['CMD', 'node', '-e']);
    assert.equal(health.Interval, 5_000_000_000);
    assert.equal(health.Timeout, (timeoutSeconds + 1) * 1_000_000_000);
    assert.equal(health.Retries, 1); assert.equal(health.StartPeriod, 0);
    assert.equal(health.StartInterval, 5_000_000_000);
    assert.equal(Object.isFrozen(health.Test), true);
  }
});

test('generated probe requires exact 200 and complete bounded body, silently fails all errors', () => {
  function probe() {
    const input = fixture(); input.installation.manifest.health = { path: '/health/ready', timeoutSeconds: 1 };
    const source = compileAppDockerPolicy(input).body.Healthcheck.Test[3];
    const response = Object.assign(new EventEmitter(), { statusCode: 200, complete: true, destroy() {} });
    const request = Object.assign(new EventEmitter(), { destroy() {} });
    let respond!: (value: typeof response) => void;
    let deadline!: () => void;
    let options!: Record<string, unknown>;
    const exitCodes: number[] = [];
    const exited = new Error('probe exited');
    runInNewContext(source, {
      require(name: string) { assert.equal(name, 'node:http'); return { get(value: Record<string, unknown>, callback: typeof respond) { options = value; respond = callback; return request; } }; },
      setTimeout(callback: () => void, delay: number) { assert.equal(delay, 1000); deadline = callback; return 1; },
      clearTimeout(id: number) { assert.equal(id, 1); },
      process: { exit(code: number) { exitCodes.push(code); throw exited; } },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { hostname: '127.0.0.1', port: 8080, path: '/health/ready', method: 'GET', agent: false, maxHeaderSize: 8192 });
    return { response, request, respond: () => respond(response), deadline: () => deadline(),
      exits(work: () => void, code: number) { assert.throws(work, error => error === exited); assert.deepEqual(exitCodes, [code]); } };
  }
  const success = probe(); success.respond(); success.response.emit('data', Buffer.alloc(65536));
  success.exits(() => success.response.emit('end'), 0);
  for (const status of [201, 204, 301, 302, 401, 500]) {
    const p = probe(); p.response.statusCode = status; p.exits(p.respond, 1);
  }
  const oversized = probe(); oversized.respond(); oversized.response.emit('data', Buffer.alloc(65536));
  oversized.exits(() => oversized.response.emit('data', Buffer.alloc(1)), 1);
  const incomplete = probe(); incomplete.respond(); incomplete.response.complete = false;
  incomplete.exits(() => incomplete.response.emit('end'), 1);
  const timedOut = probe(); timedOut.exits(timedOut.deadline, 1);
  const connect = probe(); connect.exits(() => connect.request.emit('error', new Error('secret')), 1);
  for (const event of ['error', 'aborted']) {
    const p = probe(); p.respond(); p.exits(() => p.response.emit(event, new Error('secret')), 1);
  }
});


test('stdio Gateway transport keeps network disabled and never persists stdout credentials',()=>{
  const policy=compileAppDockerPolicy({...fixture(),gateway:'stdio'});
  assert.equal(policy.body.OpenStdin,true);assert.equal(policy.body.AttachStdin,true);assert.equal(policy.body.AttachStdout,true);
  assert.equal(policy.body.Tty,false);assert.equal(policy.body.NetworkDisabled,true);
  assert.equal(policy.body.HostConfig.NetworkMode,'none');assert.deepEqual(policy.body.HostConfig.LogConfig,{Type:'none',Config:{}});
  assert.ok(policy.body.Env.includes('AFC_GATEWAY_TRANSPORT=stdio-v1'));
});
