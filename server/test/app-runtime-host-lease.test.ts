import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { acquireAppRuntimeLease } from '../src/app-platform/runtime/host-lease.ts';

class Session extends EventEmitter {
  locked = true;
  held = true;
  ends = 0;
  queries: string[] = [];
  failQuery = false;
  failEnd = false;
  async query(sql: string) {
    this.queries.push(sql);
    if (this.failQuery) throw new Error('secret database password');
    return { rows: [sql.includes('pg_try') ? { locked: this.locked } : { held: this.held }] };
  }
  async end() {
    this.ends++;
    if (this.failEnd) throw new Error('secret database password');
    this.emit('end');
  }
}
function acquire(session: Session, installationId = randomUUID()) {
  return acquireAppRuntimeLease({ installationId, connect: async () => session });
}

test('runtime ownership validates UUID before connecting and sanitizes connection errors', async () => {
  let connected = false;
  await assert.rejects(acquireAppRuntimeLease({ installationId: 'invalid', connect: async () => { connected = true; return new Session(); } }), /INVALID_INSTALLATION_ID/);
  assert.equal(connected, false);
  await assert.rejects(acquireAppRuntimeLease({ installationId: randomUUID(), connect: async () => { throw new Error('secret'); } }), { message: 'RUNTIME_LEASE_LOST' });
});

test('ownership verifies actual session lock without reacquisition and closes exactly once', async () => {
  const session = new Session();
  const lease = await acquire(session);
  await lease.assertHeld();
  assert.equal(session.queries.filter(sql => sql.includes('pg_try')).length, 1);
  assert.equal(lease.signal.aborted, false);
  await Promise.all([lease.release(), lease.release()]);
  await lease.release();
  assert.equal(session.ends, 1);
  assert.equal(lease.signal.aborted, true);
  await assert.rejects(lease.assertHeld(), /RUNTIME_LEASE_LOST/);
});

test('contention closes contender; reused session cannot reacquire or close existing owner', async () => {
  const owner = new Session();
  const lease = await acquire(owner);
  await assert.rejects(acquire(owner), /RUNTIME_LEASE_CONNECTION_REUSED/);
  assert.equal(owner.ends, 0);
  assert.equal(lease.signal.aborted, false);
  const contender = new Session(); contender.locked = false;
  await assert.rejects(acquire(contender), /RUNTIME_LEASE_BUSY/);
  assert.equal(contender.ends, 1);
  await lease.release();
});

for (const event of ['error', 'end'] as const) test(`session ${event} synchronously aborts ingress`, async () => {
  const session = new Session();
  const lease = await acquire(session);
  let closedIngress = false;
  lease.signal.addEventListener('abort', () => { closedIngress = true; });
  session.emit(event, new Error('sensitive details'));
  assert.equal(closedIngress, true);
  assert.equal((lease.signal.reason as Error).message, 'RUNTIME_LEASE_LOST');
  await assert.rejects(lease.assertHeld(), /RUNTIME_LEASE_LOST/);
  await lease.release();
});

test('lost lock and query failure abort instead of reacquiring', async () => {
  for (const failure of ['lock', 'query']) {
    const session = new Session(); const lease = await acquire(session);
    if (failure === 'lock') session.held = false; else session.failQuery = true;
    await assert.rejects(lease.assertHeld(), { message: 'RUNTIME_LEASE_LOST' });
    assert.equal(lease.signal.aborted, true);
    assert.equal(session.queries.filter(sql => sql.includes('pg_try')).length, 1);
    await lease.release();
  }
});

test('failed close is not a release receipt; explicit cleanup retry remains possible', async () => {
  const session = new Session(); const lease = await acquire(session);
  session.failEnd = true;
  await assert.rejects(lease.release(), { message: 'RUNTIME_LEASE_RELEASE_FAILED' });
  assert.equal(lease.signal.aborted, true);
  session.failEnd = false;
  await lease.release();
  assert.equal(session.ends, 2);
});

test('acquire verifies lock and session health before returning ownership', async () => {
  const session = new Session(); session.held = false;
  await assert.rejects(acquire(session), /RUNTIME_LEASE_LOST/);
  assert.equal(session.ends, 1);
});
