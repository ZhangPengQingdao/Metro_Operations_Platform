import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CoreApiError,
  createCoreApiClient,
  resolveApiBaseUrl
} from '../../src/core/http/index.ts';
import { createBrowserRuntime } from '../../src/core/runtime/index.ts';

test('browser runtime mounts once and reports versioned lifecycle state', () => {
  let mounts = 0;
  let unmounts = 0;
  const runtime = createBrowserRuntime({
    name: 'test-web',
    version: '1.0.0-test',
    mount() {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }
  });

  runtime.start();
  runtime.start();

  assert.equal(mounts, 1);
  assert.deepEqual(
    { name: runtime.ready().name, version: runtime.ready().version, state: runtime.ready().state },
    { name: 'test-web', version: '1.0.0-test', state: 'ready' }
  );

  runtime.shutdown('test');
  runtime.shutdown('test-again');
  assert.equal(unmounts, 1);
  assert.equal(runtime.getState(), 'stopped');
});

test('Core API client preserves headers, credentials, response errors, and local base resolution', async () => {
  let request: RequestInit | undefined;
  const client = createCoreApiClient({
    baseUrl: 'https://platform.example.com/',
    fetch: async (input, init) => {
      assert.equal(input, 'https://platform.example.com/api/test');
      request = init;
      return new Response(JSON.stringify({ error: { code: 'DENIED', message: '拒绝访问' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  await assert.rejects(
    client.request('/api/test', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
      headers: { 'X-Test': 'yes' }
    }),
    (error: unknown) => {
      assert.equal(error instanceof CoreApiError, true);
      assert.equal((error as CoreApiError).statusCode, 403);
      assert.equal((error as CoreApiError).code, 'DENIED');
      assert.equal((error as CoreApiError).message, '拒绝访问');
      return true;
    }
  );

  const headers = new Headers(request?.headers);
  assert.equal(request?.credentials, 'include');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-Test'), 'yes');
  assert.equal(resolveApiBaseUrl({
    development: true,
    location: { protocol: 'http:', hostname: '127.0.0.1' }
  }), 'http://127.0.0.1:3001');
});
