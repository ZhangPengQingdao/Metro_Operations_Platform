import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppTestHost } from '@metro/platform-sdk/app-test-kit';
import { loadGreeting } from './app.mjs';

test('application consumes only the public injected client', async () => {
  const host = createAppTestHost([{
    name: 'sample.greeting',
    execute: async ({ name }) => ({ message: `Hello, ${name}` }),
  }]);
  try {
    assert.equal(await loadGreeting(host.client, 'AFC'), 'Hello, AFC');
    assert.equal(host.requests()[0].operation, 'sample.greeting');
    await assert.rejects(host.client.invoke('platform.undeclared', {}), /OPERATION_DENIED/);
  } finally {
    host.close();
    await host.drain();
  }
});
