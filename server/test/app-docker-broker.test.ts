import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateDockerBrokerRequest, handleDockerBrokerRequest } from '../src/app-platform/runtime/docker-broker.ts';

const safeImage = `registry.example.com/afc/node@sha256:${'a'.repeat(64)}`;
const validName = 'afc-app-52000000-0000-4000-8000-000000000001-52000000-0000-4000-8000-000000000002';
const validContainerId = 'b'.repeat(64);

const safeCreateBody = {
  Image: safeImage,
  HostConfig: {
    Privileged: false,
    ReadonlyRootfs: true,
    NetworkMode: 'none',
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Mounts: [{ Type: 'bind', Source: '/var/lib/afc/bundles/v1', Target: '/app', ReadOnly: true }],
  },
};

test('validateDockerBrokerRequest enforces image pinning and whitelisted methods', () => {
  assert.equal(validateDockerBrokerRequest('GET', `/v1.54/images/${encodeURIComponent(safeImage)}/json`).allowed, true);
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/images/${encodeURIComponent(safeImage)}/json`).allowed, false);
  assert.equal(validateDockerBrokerRequest('GET', `/v1.54/images/node:latest/json`).allowed, false);
  assert.equal(validateDockerBrokerRequest('DELETE', `/v1.54/images/${encodeURIComponent(safeImage)}/json`).allowed, false);
});

test('validateDockerBrokerRequest blocks unsafe container creation options', () => {
  // Safe container creation
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, safeCreateBody).allowed, true);

  // Invalid container name
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=evil-container`, safeCreateBody).allowed, false);
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create`, safeCreateBody).allowed, false);

  // Privileged forbidden
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: { ...safeCreateBody.HostConfig, Privileged: true },
  }).allowed, false);

  // ReadonlyRootfs required
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: { ...safeCreateBody.HostConfig, ReadonlyRootfs: false },
  }).allowed, false);

  // Network mode must be none
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: { ...safeCreateBody.HostConfig, NetworkMode: 'host' },
  }).allowed, false);

  // Docker socket mount attempt blocked
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: {
      ...safeCreateBody.HostConfig,
      Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/docker.sock' }],
    },
  }).allowed, false);

  // Root mount attempt blocked
  assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: {
      ...safeCreateBody.HostConfig,
      Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }],
    },
  }).allowed, false);
});

test('validateDockerBrokerRequest restricts lifecycle operations to platform containers', () => {
  for (const id of [validName, validContainerId]) {
    assert.equal(validateDockerBrokerRequest('GET', `/v1.54/containers/${id}/json`).allowed, true);
    assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/${id}/start`).allowed, true);
    assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/${id}/stop?t=5`).allowed, true);
    assert.equal(validateDockerBrokerRequest('DELETE', `/v1.54/containers/${id}?force=false&v=false`).allowed, true);
    assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/${id}/attach?stream=1`).allowed, true);
  }

  // Non-platform containers blocked
  for (const invalid of ['my-postgres', 'host-system', 'other-app', 'c'.repeat(32)]) {
    assert.equal(validateDockerBrokerRequest('GET', `/v1.54/containers/${invalid}/json`).allowed, false);
    assert.equal(validateDockerBrokerRequest('POST', `/v1.54/containers/${invalid}/start`).allowed, false);
    assert.equal(validateDockerBrokerRequest('DELETE', `/v1.54/containers/${invalid}`).allowed, false);
  }
});

test('validateDockerBrokerRequest blocks arbitrary Docker APIs', () => {
  const blocked = [
    ['POST', '/v1.54/containers/prune'],
    ['POST', `/v1.54/containers/${validContainerId}/exec`],
    ['POST', '/v1.54/exec/some-id/start'],
    ['GET', '/v1.54/volumes'],
    ['DELETE', '/v1.54/volumes/app-volume'],
    ['GET', '/v1.54/networks'],
    ['POST', '/v1.54/build'],
    ['GET', '/v1.54/info'],
    ['GET', '/v1.54/events'],
    ['GET', '/v1.54/swarm'],
  ] as const;

  for (const [method, path] of blocked) {
    const result = validateDockerBrokerRequest(method, path);
    assert.equal(result.allowed, false, `Expected ${method} ${path} to be blocked`);
    assert.equal(result.reason, 'DOCKER_ENDPOINT_NOT_PERMITTED');
  }
});

function createMockExchange(method: string, url: string, body?: unknown) {
  const req = new Readable({
    read() {
      if (body !== undefined) this.push(JSON.stringify(body));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json' };

  let statusCode = 0;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let finished: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });

  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
    final(callback) {
      callback();
      finished();
    },
  }) as unknown as ServerResponse;

  res.writeHead = ((status: number, hdrs?: Record<string, string>) => {
    statusCode = status;
    if (hdrs) Object.assign(headers, hdrs);
    return res;
  }) as any;

  return {
    req,
    res,
    wait: async () => {
      await done;
      const raw = Buffer.concat(chunks).toString('utf8');
      return {
        statusCode,
        headers,
        body: raw.length > 0 ? JSON.parse(raw) : null,
      };
    },
  };
}

test('handleDockerBrokerRequest filters requests before reaching upstream', async () => {
  const options = { upstreamSocketPath: '/run/nonexistent-docker.sock' };

  // 1. Blocked request: exec endpoint -> returns 403 BROKER_OPERATION_FORBIDDEN
  const execExchange = createMockExchange('POST', `/v1.54/containers/${validContainerId}/exec`, { Cmd: ['sh'] });
  handleDockerBrokerRequest(execExchange.req, execExchange.res, options);
  const execResult = await execExchange.wait();
  assert.equal(execResult.statusCode, 403);
  assert.equal(execResult.body.error, 'BROKER_OPERATION_FORBIDDEN');
  assert.equal(execResult.body.reason, 'DOCKER_ENDPOINT_NOT_PERMITTED');

  // 2. Blocked request: privileged container create -> returns 403 BROKER_OPERATION_FORBIDDEN
  const privExchange = createMockExchange('POST', `/v1.54/containers/create?name=${validName}`, {
    ...safeCreateBody,
    HostConfig: { ...safeCreateBody.HostConfig, Privileged: true },
  });
  handleDockerBrokerRequest(privExchange.req, privExchange.res, options);
  const privResult = await privExchange.wait();
  assert.equal(privResult.statusCode, 403);
  assert.equal(privResult.body.error, 'BROKER_OPERATION_FORBIDDEN');
  assert.equal(privResult.body.reason, 'PRIVILEGED_MODE_FORBIDDEN');

  // 3. Blocked request: foreign container operation -> returns 403
  const foreignExchange = createMockExchange('POST', `/v1.54/containers/foreign-container/start`);
  handleDockerBrokerRequest(foreignExchange.req, foreignExchange.res, options);
  const foreignResult = await foreignExchange.wait();
  assert.equal(foreignResult.statusCode, 403);
  assert.equal(foreignResult.body.error, 'BROKER_OPERATION_FORBIDDEN');
  assert.equal(foreignResult.body.reason, 'UNAUTHORIZED_CONTAINER_TARGET');
});
