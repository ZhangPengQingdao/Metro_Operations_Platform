import { AppGateway } from '../src/app-platform/gateway/index.ts';
import { attachAppDocker } from '../src/app-platform/runtime/docker-attach.ts';
import { startAppStdioGateway, type AppStdioGatewaySession } from '../src/app-platform/runtime/stdio-gateway.ts';
import type { PlatformActorContextResolver } from '../src/platform/context/index.ts';
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
import { stageAppArtifacts } from '../src/app-platform/runtime/artifacts.ts';
import { compileAppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';
import { AppDockerTransport } from '../src/app-platform/runtime/docker-transport.ts';
import { AppDockerExecutor } from '../src/app-platform/runtime/docker-executor.ts';
import type { AppInstallation } from '../src/app-platform/registry/model.ts';

const socketPath = process.env.AFC_DOCKER_TEST_SOCKET;
const runtimeImage = process.env.AFC_DOCKER_TEST_IMAGE;
const artifactRoot = process.env.AFC_DOCKER_TEST_ROOT;
// Explicit opt-in: root must be writable and shared with the selected local Engine.
// Only this test's unique container and artifact directory are cleaned up; never prune.
const healthMode = 'healthy' as string;
test('real networkless Docker stdio uses Gateway credentials and permissions', {
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
let gatewayReady=false;
const expected = new Map([['45000000-0000-4000-8000-000000000001','ok'],['45000000-0000-4000-8000-000000000003','OPERATION_DENIED'],['45000000-0000-4000-8000-000000000004','ACCESS_DENIED']]);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(line.startsWith('AFC_API_V1 ')){
  const frame=JSON.parse(line.slice('AFC_API_V1 '.length));
  if(frame.request.handler==='hang')return;
  if(frame.request.handler!=='echo'||frame.request.method!=='POST'||frame.request.path!=='/echo')throw Error('bad API request');
  console.log('AFC_API_V1 '+JSON.stringify({id:frame.id,result:frame.request.payload}));return;
 }
 const frame=JSON.parse(line.slice('AFC_GATEWAY_V1 '.length));
 const target=expected.get(frame.id);
 if(!target)throw Error('unexpected reply');
 if(target==='ok'){if(frame.response?.result?.pong!==true)throw Error('bad result');}
 else if(frame.error?.code!==target)throw Error('authorization did not reject');
 expected.delete(frame.id);gatewayReady=expected.size===0;
});
for(const [index,id] of [...expected.keys()].entries()){
 const frame={id,request:{version:'1.0',operation:index===1?'undeclared.operation':index===2?'probe.forbidden':'probe.read',params:{}}};
 console.log('AFC_GATEWAY_V1 '+JSON.stringify(frame));
}

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
  if (!gatewayReady) { res.writeHead(503);res.end();return; }
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
  let bridge: AppStdioGatewaySession | undefined;
  let executed=0;
  const gateway = new AppGateway({
    registry:{authenticateServiceCredential:async(appId,credential)=>{
      assert.equal(appId,installation.appId);
      if(credential!=='test-service-credential')throw Error('invalid credential');
      return {actorType:'service',trustedIdentity:{source:'service',serviceId:'fixture'},execution:{type:'application',appId,serviceIdentityId:'fixture'}} as never;
    }},
    contextResolver:{resolve:async()=>({actorType:'service',execution:{type:'application',appId:installation.appId,serviceIdentityId:'fixture'},authorize:async(permission:string)=>({allowed:permission!=='probe.forbidden'})})} as unknown as Pick<PlatformActorContextResolver,'resolve'>,
    operations:[{name:'probe.forbidden',permissionCode:'probe.forbidden',mode:'read',validateParams:()=>true,resolveResources:async()=>[{}],execute:async()=>{throw Error('forbidden must not execute');},validateResult:()=>true},{name:'probe.read',permissionCode:'probe.read',mode:'read',validateParams:()=>true,resolveResources:async()=>[{}],execute:async()=>{executed++;return {pong:true};},validateResult:()=>true}],
  });
  try {
    const bundle = await stageAppArtifacts({ root, manifest: installation.manifest, read: async () => source });
    const policy = compileAppDockerPolicy({ installation, operationId, runtimeImage: runtimeImage!, verifiedBundlePath: bundle.path, network: 'none', gateway: 'stdio' });
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
    const attachment=await attachAppDocker({socketPath:socketPath!,executor,policy,approval,containerId:identity});
    bridge=startAppStdioGateway({apiTimeoutMs:100,shutdownTimeoutMs:25,appId:installation.appId,serviceCredential:'test-service-credential',gateway,stdout:attachment.stdout,stdin:attachment.stdin});
    assert.equal(before.HostConfig.LogConfig && (before.HostConfig.LogConfig as {Type:string}).Type,'none');
    receipt = await supervisor().dispatch(admin, { ...request, action: 'start', containerId: identity, expectedSequence: receipt.sequence });

    assert.equal((await transport.inspectContainer(identity))?.State.Running, true);
    const readiness = new AppDockerReadiness({ get: async () => structuredClone(installation) }, new AppDockerJournal(client), executor);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const observed = await transport.inspectContainer(identity);
      const state = observed?.State.Health as { Status?: string; Log?: { End: string }[] } | undefined;
      if (state?.Status === (healthMode === 'healthy' ? 'healthy' : 'unhealthy') && Date.parse(state.Log?.at(-1)?.End ?? '') <= Date.now()) break;
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
    assert.equal(executed,1);
    assert.equal((await bridge.api.invoke({handler:'echo',method:'POST',path:'/echo',payload:{echo:'accepted'}}) as {echo:string}).echo,'accepted');
    await assert.rejects(bridge.api.invoke({handler:'hang',method:'POST',path:'/hang',payload:null}),/TIMEOUT/);
    await assert.rejects(bridge.stop(),/DRAIN_TIMEOUT/);
    receipt = await supervisor().dispatch(admin, { ...request, action: 'stop', containerId: identity, expectedSequence: receipt.sequence });
    const stopped = await transport.inspectContainer(identity);
    assert.equal(stopped?.State.Running, false);
    assert.equal(stopped?.State.ExitCode, 0);
    bridge.api.confirmContainerStopped();
    await bridge.stop();
    receipt = await supervisor().dispatch(admin, { ...request, action: 'remove', containerId: identity, expectedSequence: receipt.sequence });
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.observation?.state, 'absent');
    assert.equal(await transport.inspectContainer(identity), null);
    removed = true;
  } finally {
    bridge?.api.close();
    let cleanupConfirmed = true;
    if (identity && !removed) {
      const current = await transport.inspectContainer(identity);
      if (current) {
        await transport.stopContainer(current.Id, 3);
        const stopped = await transport.inspectContainer(current.Id);
        assert.equal(stopped?.State.Running, false);
        bridge?.api.confirmContainerStopped();
        await transport.removeContainer(current.Id);
      } else if (!/^[0-9a-f]{64}$/.test(identity)) {
        // A timed-out create may still materialize after this 404. Retain its inputs.
        cleanupConfirmed = false;
        console.error(`Uncertain test create; reconcile ${identity}; retained artifacts ${root}`);
      }
    }
    if (removed) bridge?.api.confirmContainerStopped();
    if (bridge) await bridge.stop();
    await db.close();
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
  }
});
