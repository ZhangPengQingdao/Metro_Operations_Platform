import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DatabaseQueryTimeoutError,
  checkDatabaseStatus,
  runDatabaseAdvisoryLock,
  runDatabaseTransaction,
  runWithDatabaseQueryTimeout
} from '../src/core/database/index.ts';

class FakeClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  released = false;

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

test('Core Database checks health without leaking client ownership', async () => {
  const client = new FakeClient();
  const status = await checkDatabaseStatus({
    connect: async () => client
  });

  assert.equal(status, 'up');
  assert.equal(client.released, true);
  assert.equal(await checkDatabaseStatus(null), 'unconfigured');
  assert.equal(await checkDatabaseStatus({ connect: async () => { throw new Error('down'); } }), 'down');
});

test('Core Database transaction commits successful callbacks', async () => {
  const client = new FakeClient();
  const result = await runDatabaseTransaction(client, async (transaction) => {
    await transaction.query('SELECT 1');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.deepEqual(client.queries.map((query) => query.text), ['BEGIN', 'SELECT 1', 'COMMIT']);
});

test('Core Database transaction rolls back failed callbacks', async () => {
  const client = new FakeClient();

  await assert.rejects(
    runDatabaseTransaction(client, async (transaction) => {
      await transaction.query('SELECT 1');
      throw new Error('boom');
    }),
    /boom/
  );
  assert.deepEqual(client.queries.map((query) => query.text), ['BEGIN', 'SELECT 1', 'ROLLBACK']);
});

test('Core Database advisory lock runs before the protected operation', async () => {
  const client = new FakeClient();
  const result = await runDatabaseAdvisoryLock(client, 42, async (lockedClient) => {
    await lockedClient.query('SELECT protected');
    return 'locked';
  });

  assert.equal(result, 'locked');
  assert.deepEqual(client.queries, [
    { text: 'SELECT pg_advisory_xact_lock($1)', values: [42] },
    { text: 'SELECT protected', values: undefined }
  ]);
});

test('Core Database query timeout aborts the operation instead of only abandoning its result', async () => {
  let receivedSignal: AbortSignal | null = null;

  await assert.rejects(
    runWithDatabaseQueryTimeout(async (signal) => {
      receivedSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return 'unreachable';
    }, 1),
    DatabaseQueryTimeoutError
  );
  assert.equal(receivedSignal?.aborted, true);

  assert.equal(await runWithDatabaseQueryTimeout(async () => 'fast', 100), 'fast');
});
