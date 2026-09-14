import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import type { RuntimeHealth } from '../src/core/runtime/index.ts';
import { registerHealthRoutes } from '../src/core/health/index.ts';

function runtimeHealth(overrides: Partial<RuntimeHealth> = {}): RuntimeHealth {
  return {
    name: 'afc-ops-api',
    version: '1.0.0-test',
    state: 'ready',
    dependencies: [
      {
        name: 'database',
        state: 'up',
        required: true,
        checkedAt: '2026-08-30T00:00:00.000Z'
      }
    ],
    checkedAt: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

test('health compatibility routes preserve the current envelope and expose runtime evidence', async () => {
  const app = Fastify({ logger: false });
  await registerHealthRoutes(app, { getRuntimeHealth: async () => runtimeHealth() });

  try {
    for (const path of ['/health', '/api/health']) {
      const response = await app.inject(path);
      const payload = response.json();

      assert.equal(response.statusCode, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.ok, true);
      assert.equal(payload.data.service, 'metro-operations-platform-api');
      assert.equal(payload.data.database, 'up');
      assert.equal(payload.data.runtime.state, 'ready');
      assert.equal(payload.data.runtime.version, '1.0.0-test');
    }
  } finally {
    await app.close();
  }
});

test('readiness fails while liveness stays up for a degraded runtime', async () => {
  const app = Fastify({ logger: false });
  let readinessChecks = 0;
  const degraded = runtimeHealth({
    state: 'degraded',
    dependencies: [
      {
        name: 'database',
        state: 'down',
        required: true,
        message: 'not reachable',
        checkedAt: '2026-08-30T00:00:00.000Z'
      }
    ]
  });
  await registerHealthRoutes(app, {
    getRuntimeHealth: async () => {
      readinessChecks += 1;
      return degraded;
    },
    getRuntimeState: () => 'degraded'
  });

  try {
    const live = await app.inject('/health/live');
    assert.equal(readinessChecks, 0, 'liveness must not probe dependencies');
    const ready = await app.inject('/health/ready');

    assert.equal(live.statusCode, 200);
    assert.equal(live.json().data.ok, true);
    assert.equal(typeof live.json().data.version, 'string');
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().data.ok, false);
    assert.equal(ready.json().data.runtime.state, 'degraded');
    assert.equal(ready.json().data.database, 'down');
    assert.equal(readinessChecks, 1);
  } finally {
    await app.close();
  }
});

test('liveness fails for a failed runtime', async () => {
  const app = Fastify({ logger: false });
  await registerHealthRoutes(app, {
    getRuntimeHealth: async () => runtimeHealth({ state: 'failed' }),
    getRuntimeState: () => 'failed'
  });

  try {
    const response = await app.inject('/api/health/live');

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().data.ok, false);
  } finally {
    await app.close();
  }
});
