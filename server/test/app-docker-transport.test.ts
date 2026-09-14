import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDockerTransport, AppDockerTransportError } from '../src/app-platform/runtime/docker-transport.ts';
import type { AppDockerPolicy } from '../src/app-platform/runtime/docker-policy.ts';

const id = 'a'.repeat(64), digest = `sha256:${'b'.repeat(64)}`, image = `node@${digest}`;
const name = 'afc-app-43000000-0000-4000-8000-000000000001-43000000-0000-4000-8000-000000000002';
// Transport accepts trusted compiled policy; policy safety has separate compiler tests.
const policy = { name, body: { Image: image } } as AppDockerPolicy;
const inspection = { Id: id, Name: `/${name}`, Image: digest, Config: {}, HostConfig: {}, State: { Running: true, Status: 'running' } };
async function server(handler: RequestListener, work: (socketPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'afc-docker-'));
  const socketPath = join(dir, 'd.sock');
  const host = createServer(handler);
  await new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(socketPath, resolve); });
  try { await work(socketPath); }
  finally { host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}
function error(code: string, uncertain: boolean, status?: number) {
  return (value: unknown) => {
    assert.ok(value instanceof AppDockerTransportError);
    assert.equal(value.code, code); assert.equal(value.uncertain, uncertain); assert.equal(value.status, status);
    assert.equal(JSON.stringify(value).includes('daemon-secret'), false);
    assert.equal(value.message.includes('daemon-secret'), false);
    return true;
  };
}

test('fixed v1.54 Unix request paths and lifecycle methods; no force or volumes deletion', async () => {
  const calls: { method?: string; url?: string; body: string }[] = [];
  await server((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      if (req.url?.includes('/create?')) { res.writeHead(201); res.end(JSON.stringify({ Id: id, Warnings: [] })); }
      else if (req.url?.startsWith('/v1.54/images/')) res.end(JSON.stringify({ Id: digest, RepoDigests: [image], Config: {} }));
      else if (req.url?.endsWith('/json')) res.end(JSON.stringify(inspection));
      else { res.writeHead(204); res.end(); }
    });
  }, async socketPath => {
    const client = new AppDockerTransport({ socketPath });
    assert.deepEqual(await client.createContainer(policy), { Id: id });
    assert.deepEqual(await client.inspectContainer(name), inspection);
    assert.equal((await client.inspectImage(image))?.Id, digest);
    await client.startContainer(id); await client.stopContainer(id, 3); await client.removeContainer(id);
  });
  assert.deepEqual(calls.map(x => [x.method, x.url]), [
    ['POST', `/v1.54/containers/create?name=${name}`], ['GET', `/v1.54/containers/${name}/json`],
    ['GET', `/v1.54/images/${encodeURIComponent(image)}/json`], ['POST', `/v1.54/containers/${id}/start`],
    ['POST', `/v1.54/containers/${id}/stop?t=3`], ['DELETE', `/v1.54/containers/${id}?force=false&v=false`],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), policy.body);
});

test('only explicit 404 reads mean absent; 304 start/stop means acknowledged', async () => {
  await server((req, res) => { res.writeHead(req.method === 'GET' ? 404 : 304); res.end(); }, async socketPath => {
    const client = new AppDockerTransport({ socketPath });
    assert.equal(await client.inspectContainer(id), null); assert.equal(await client.inspectImage(image), null);
    await client.startContainer(id); await client.stopContainer(id);
    await assert.rejects(client.removeContainer(id), error('DAEMON_REJECTED', true, 304));
  });
});

test('daemon status errors never disclose response body; mutation failures uncertain without retry', async () => {
  let calls = 0;
  await server((_req, res) => { calls++; res.writeHead(500); res.end('daemon-secret'); }, async socketPath => {
    const client = new AppDockerTransport({ socketPath });
    await assert.rejects(client.inspectContainer(id), error('DAEMON_REJECTED', false, 500));
    await assert.rejects(client.createContainer(policy), error('DAEMON_REJECTED', true, 500));
    await assert.rejects(client.startContainer(id), error('DAEMON_REJECTED', true, 500));
  });
  assert.equal(calls, 3);
});

test('absolute deadlines bound no-response and trickling bodies; mutations remain uncertain', async () => {
  let calls = 0;
  await server((req, res) => {
    calls++;
    if (req.method === 'GET') { res.write('{'); const interval = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(interval)); }
  }, async socketPath => {
    const client = new AppDockerTransport({ socketPath, timeoutMs: 35 });
    await assert.rejects(client.createContainer(policy), error('TIMEOUT', true));
    await assert.rejects(client.inspectContainer(id), error('TIMEOUT', false));
  });
  assert.equal(calls, 2);
});

test('bounded response rejects declared and chunked oversized bodies', async () => {
  for (const declared of [true, false]) {
    await server((_req, res) => {
      if (declared) res.setHeader('Content-Length', '1000');
      res.writeHead(201); res.end('x'.repeat(1000));
    }, async socketPath => {
      const client = new AppDockerTransport({ socketPath, maxResponseBytes: 32 });
      await assert.rejects(client.createContainer(policy), error('RESPONSE_TOO_LARGE', true));
    });
  }
});

test('malformed JSON and incomplete success shapes fail closed including JSON null', async () => {
  for (const response of ['daemon-secret', '{}', 'null', '[]', '{"Id":"short"}']) {
    await server((req, res) => { res.writeHead(req.method === 'POST' ? 201 : 200); res.end(response); }, async socketPath => {
      const client = new AppDockerTransport({ socketPath });
      await assert.rejects(client.createContainer(policy), error('INVALID_RESPONSE', true));
      await assert.rejects(client.inspectContainer(id), error('INVALID_RESPONSE', false));
      await assert.rejects(client.inspectImage(image), error('INVALID_RESPONSE', false));
    });
  }
});

test('disconnected response and unavailable socket are sanitized and never retried', async () => {
  await server((req, res) => { res.writeHead(201); res.write('{'); req.socket.destroy(); }, async socketPath => {
    const client = new AppDockerTransport({ socketPath });
    await assert.rejects(client.createContainer(policy), error('CONNECTION_FAILED', true));
    await assert.rejects(new AppDockerTransport({ socketPath: `${socketPath}-missing` }).startContainer(id), error('CONNECTION_FAILED', true));
  });
});

test('inputs reject path injection, ambient endpoints, unpinned images and excessive budgets before dispatch', async () => {
  for (const socketPath of ['relative', 'tcp://host:2375', '/', '/tmp/../x', '/tmp/x\n']) {
    assert.throws(() => new AppDockerTransport({ socketPath }), error('INVALID_INPUT', false));
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 5 * 1024 * 1024 }]) {
    assert.throws(() => new AppDockerTransport({ socketPath: '/tmp/d.sock', ...options }), error('INVALID_INPUT', false));
  }
  const client = new AppDockerTransport({ socketPath: '/tmp/nonexistent-afc-d.sock' });
  for (const value of ['../other', 'id?force=true', 'short', 'other-app']) await assert.rejects(client.startContainer(value), error('INVALID_INPUT', false));
  await assert.rejects(client.inspectImage('node:latest'), error('INVALID_INPUT', false));
  await assert.rejects(client.stopContainer(id, -1), error('INVALID_INPUT', false));
  await assert.rejects(client.createContainer({ ...policy, body: { Image: 'x'.repeat(65536) } } as AppDockerPolicy), error('INVALID_INPUT', false));
});

test('pending request admission is bounded and timeout releases transport capacity', async () => {
  let calls = 0;
  await server((_req, res) => { calls++; if (calls > 16) { res.writeHead(204); res.end(); } }, async socketPath => {
    const client = new AppDockerTransport({ socketPath, timeoutMs: 100 });
    const pending = Array.from({ length: 16 }, () => assert.rejects(client.startContainer(id), error('TIMEOUT', true)));
    await assert.rejects(client.startContainer(id), error('TRANSPORT_BUSY', false));
    await Promise.all(pending);
    await client.startContainer(id);
  });
  assert.equal(calls, 17);
});


test('only completed create/400 is a definitive rejection; truncated or oversized responses remain uncertain',async()=>{
 await server((req,res)=>{req.resume();res.writeHead(400);res.end('daemon-secret');},async socketPath=>{
  const client=new AppDockerTransport({socketPath});
  await assert.rejects(client.createContainer(policy),error('CREATE_REQUEST_REJECTED',false,400));
  await assert.rejects(client.startContainer(id),error('DAEMON_REJECTED',true,400));
 });
 await server((req,res)=>{req.resume();res.writeHead(400,{'Content-Length':'1000'});res.write('partial');},async socketPath=>{
  await assert.rejects(new AppDockerTransport({socketPath,timeoutMs:35}).createContainer(policy),error('TIMEOUT',true));
 });
 await server((req,res)=>{req.resume();res.writeHead(400,{'Content-Length':'1000'});res.end('partial');},async socketPath=>{
  await assert.rejects(new AppDockerTransport({socketPath,maxResponseBytes:10}).createContainer(policy),error('RESPONSE_TOO_LARGE',true));
 });
});
