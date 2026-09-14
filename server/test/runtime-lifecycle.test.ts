import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeLifecycle } from '../src/core/runtime/index.ts';

test('Core runtime starts once, reports dependency health, and shuts down in order', async () => {
  const calls: string[] = [];
  const runtime = createRuntimeLifecycle({
    name: 'test-runtime',
    version: 'test-version',
    createApp: async () => {
      calls.push('create');
      return { close: async () => calls.push('close') };
    },
    startApp: async () => {
      calls.push('start');
    },
    stopApp: async (app, reason) => {
      calls.push(`stop:${reason}`);
      await app.close();
    },
    dependencies: [
      {
        name: 'database',
        check: async () => 'up'
      }
    ]
  });

  const app = await runtime.start();
  assert.equal(await runtime.start(), app);
  assert.equal(runtime.getState(), 'ready');

  const health = await runtime.ready();
  assert.equal(health.name, 'test-runtime');
  assert.equal(health.version, 'test-version');
  assert.equal(health.state, 'ready');
  assert.equal(health.dependencies[0].name, 'database');
  assert.equal(health.dependencies[0].state, 'up');
  assert.equal(health.dependencies[0].required, true);

  await runtime.shutdown('unit-test');
  assert.equal(runtime.getState(), 'stopped');
  assert.deepEqual(calls, ['create', 'start', 'stop:unit-test', 'close']);
});

test('Core runtime marks required dependency failure as degraded', async () => {
  const runtime = createRuntimeLifecycle({
    name: 'test-runtime',
    version: 'test-version',
    createApp: async () => ({}),
    startApp: async () => {},
    dependencies: [
      {
        name: 'database',
        check: async () => ({ state: 'down', message: 'not reachable' })
      }
    ]
  });

  await runtime.start();
  const health = await runtime.ready();

  assert.equal(runtime.getState(), 'degraded');
  assert.equal(health.state, 'degraded');
  assert.equal(health.dependencies[0].message, 'not reachable');
});

test('Core runtime keeps optional dependency failure from blocking readiness', async () => {
  const runtime = createRuntimeLifecycle({
    name: 'test-runtime',
    version: 'test-version',
    createApp: async () => ({}),
    startApp: async () => {},
    dependencies: [
      {
        name: 'database',
        required: false,
        check: async () => {
          throw new Error('not configured');
        }
      }
    ]
  });

  await runtime.start();
  const health = await runtime.ready();

  assert.equal(health.state, 'ready');
  assert.equal(health.dependencies[0].state, 'down');
  assert.equal(health.dependencies[0].required, false);
  assert.equal(health.dependencies[0].message, 'not configured');
});

test('Core runtime surfaces startup failure and keeps the failed state', async () => {
  const runtime = createRuntimeLifecycle({
    name: 'test-runtime',
    version: 'test-version',
    createApp: async () => ({}),
    startApp: async () => {
      throw new Error('port in use');
    }
  });

  await assert.rejects(runtime.start(), /port in use/);
  assert.equal(runtime.getState(), 'failed');
});
