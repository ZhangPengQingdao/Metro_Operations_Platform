import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORE_EVENTS_MIGRATIONS,
  CORE_OUTBOX_EVENTS_TABLE_SQL,
  createCoreEvent,
  createCoreEventBus,
  createMemoryCoreOutboxRepository,
  createPostgresCoreOutboxRepository,
  dispatchCoreOutboxBatch,
  enqueueCoreEvent
} from '../src/core/events/index.ts';
import { createMigrationRegistry } from '../src/core/migrations/index.ts';

class FakeClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  constructor(private readonly row: Record<string, unknown> | null = null) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rows: this.row ? [this.row] : [] };
  }
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 3, 0, tick++));
}

function createEventIdFactory() {
  let next = 0;
  return () => `11111111-1111-4111-8111-${String(++next).padStart(12, '0')}`;
}

test('Core Events validates envelopes and publishes to typed and wildcard handlers in order', async () => {
  const bus = createCoreEventBus();
  const received: string[] = [];
  const event = createCoreEvent({
    id: 'event-1',
    type: 'work-item.created.v1',
    source: 'server/test',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: { workItemId: 'todo-1' }
  });

  bus.subscribe('work-item.created.v1', async (envelope) => {
    received.push(`typed:${envelope.payload.workItemId}`);
  });
  const wildcard = bus.subscribe('*', (envelope) => {
    received.push(`wildcard:${envelope.type}`);
  });

  await bus.publish(event);
  wildcard.unsubscribe();
  await bus.publish(event);

  assert.deepEqual(received, [
    'typed:todo-1',
    'wildcard:work-item.created.v1',
    'typed:todo-1'
  ]);
  assert.throws(
    () => createCoreEvent({ type: 'Bad Event', source: 'test', payload: {} }),
    /事件类型必须稳定且可版本化/
  );
});

test('Core Outbox enqueues events atomically through the selected repository and deduplicates idempotency keys', async () => {
  const repository = createMemoryCoreOutboxRepository();
  const clock = fixedClock();
  const createEventId = createEventIdFactory();
  const first = await enqueueCoreEvent(repository, {
    type: 'notification.requested.v1',
    source: 'platform/notifications',
    payload: { notificationKey: 'todo:1' },
    idempotencyKey: 'notification:todo:1'
  }, { clock, createEventId });
  const duplicate = await enqueueCoreEvent(repository, {
    type: 'notification.requested.v1',
    source: 'platform/notifications',
    payload: { notificationKey: 'todo:1' },
    idempotencyKey: 'notification:todo:1'
  }, { clock, createEventId });

  assert.equal(first.event.id, duplicate.event.id);
  assert.equal(repository.records().length, 1);
  assert.equal(repository.records()[0].status, 'pending');
  assert.equal(repository.records()[0].nextAttemptAt, '2026-08-30T03:00:00.000Z');
});

test('Core Outbox claimBatch claims only due events and keeps future events pending', async () => {
  const repository = createMemoryCoreOutboxRepository();
  const due = createCoreEvent({
    id: 'due-event',
    type: 'app.changed.v1',
    source: 'apps/test',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: {}
  });
  const future = createCoreEvent({
    id: 'future-event',
    type: 'app.changed.v1',
    source: 'apps/test',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: {}
  });
  await repository.enqueue({ event: future, nextAttemptAt: new Date('2026-08-30T03:10:00.000Z') });
  await repository.enqueue({ event: due, nextAttemptAt: new Date('2026-08-30T03:00:00.000Z') });

  const claimed = await repository.claimBatch({
    now: new Date('2026-08-30T03:01:00.000Z'),
    limit: 10
  });

  assert.deepEqual(claimed.map((record) => [record.event.id, record.status]), [
    ['due-event', 'processing']
  ]);
  assert.equal((await repository.find('future-event'))?.status, 'pending');
});

test('Core Outbox reclaims expired processing leases but leaves live workers alone', async () => {
  const staleEvent = createCoreEvent({
    id: 'stale-event',
    type: 'app.changed.v1',
    source: 'apps/test',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: {}
  });
  const liveEvent = createCoreEvent({
    id: 'live-event',
    type: 'app.changed.v1',
    source: 'apps/test',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: {}
  });
  const repository = createMemoryCoreOutboxRepository([
    {
      event: staleEvent,
      status: 'processing',
      attempts: 0,
      nextAttemptAt: '2026-08-30T03:00:00.000Z',
      lockedAt: '2026-08-30T03:00:00.000Z'
    },
    {
      event: liveEvent,
      status: 'processing',
      attempts: 0,
      nextAttemptAt: '2026-08-30T03:00:00.000Z',
      lockedAt: '2026-08-30T03:01:30.000Z'
    }
  ]);

  const claimed = await repository.claimBatch({
    now: new Date('2026-08-30T03:02:00.000Z'),
    limit: 10,
    processingLeaseMs: 60_000
  });

  assert.deepEqual(claimed.map((record) => record.event.id), ['stale-event']);
  assert.equal((await repository.find('live-event'))?.lockedAt, '2026-08-30T03:01:30.000Z');
});

test('Core Outbox dispatcher delivers claimed events through the EventBus', async () => {
  const repository = createMemoryCoreOutboxRepository();
  const bus = createCoreEventBus();
  const delivered: string[] = [];
  bus.subscribe('work-item.created.v1', (event) => {
    delivered.push(String(event.payload.workItemId));
  });
  const record = await enqueueCoreEvent(repository, {
    id: 'event-delivery',
    type: 'work-item.created.v1',
    source: 'platform/work-items',
    payload: { workItemId: 'todo-2' }
  }, { clock: () => new Date('2026-08-30T03:00:00.000Z') });

  const summary = await dispatchCoreOutboxBatch({
    repository,
    eventBus: bus,
    clock: () => new Date('2026-08-30T03:01:00.000Z')
  });

  assert.deepEqual(delivered, ['todo-2']);
  assert.deepEqual(summary, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
  assert.equal((await repository.find(record.event.id))?.status, 'delivered');
});

test('Core Outbox dispatcher retries failed handlers and dead-letters after max attempts', async () => {
  const repository = createMemoryCoreOutboxRepository();
  const bus = createCoreEventBus();
  const event = createCoreEvent({
    id: 'event-failure',
    type: 'integration.push.v1',
    source: 'core/integrations',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: { target: 'wecom' }
  });
  await repository.enqueue({ event });
  bus.subscribe('integration.push.v1', () => {
    throw new Error('provider down');
  });

  const first = await dispatchCoreOutboxBatch({
    repository,
    eventBus: bus,
    maxAttempts: 2,
    retryDelayMs: 60_000,
    clock: () => new Date('2026-08-30T03:01:00.000Z')
  });
  const failed = await repository.find(event.id);
  const second = await dispatchCoreOutboxBatch({
    repository,
    eventBus: bus,
    maxAttempts: 2,
    retryDelayMs: 60_000,
    clock: () => new Date('2026-08-30T03:02:00.000Z')
  });
  const deadLetter = await repository.find(event.id);

  assert.deepEqual(first, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.nextAttemptAt, '2026-08-30T03:02:00.000Z');
  assert.deepEqual(second, { claimed: 1, delivered: 0, failed: 0, deadLettered: 1 });
  assert.equal(deadLetter?.status, 'dead_letter');
  assert.equal(deadLetter?.attempts, 2);
  assert.match(deadLetter?.lastError ?? '', /provider down/);
});

test('Core Outbox PostgreSQL repository uses row locking, JSON payloads, and idempotency keys', async () => {
  const row = {
    id: '11111111-1111-4111-8111-000000000001',
    event_type: 'work-item.created.v1',
    source: 'platform/work-items',
    payload: { workItemId: 'todo-1' },
    correlation_id: 'corr-1',
    causation_id: null,
    actor_id: 'user-1',
    idempotency_key: 'work-item:todo-1',
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date('2026-08-30T03:00:00.000Z'),
    locked_at: null,
    delivered_at: null,
    last_error: null,
    occurred_at: new Date('2026-08-30T03:00:00.000Z')
  };
  const client = new FakeClient(row);
  const repository = createPostgresCoreOutboxRepository(client);
  const event = createCoreEvent({
    id: '11111111-1111-4111-8111-000000000001',
    type: 'work-item.created.v1',
    source: 'platform/work-items',
    occurredAt: new Date('2026-08-30T03:00:00.000Z'),
    payload: { workItemId: 'todo-1' },
    actorId: 'user-1',
    correlationId: 'corr-1',
    idempotencyKey: 'work-item:todo-1'
  });

  assert.equal((await repository.enqueue({ event })).event.id, event.id);
  await repository.claimBatch({
    now: new Date('2026-08-30T03:01:00.000Z'),
    limit: 5,
    processingLeaseMs: 60_000
  });
  await repository.markDelivered(event.id, new Date('2026-08-30T03:02:00.000Z'));
  await repository.markFailed({
    eventId: event.id,
    error: new Error('retry me'),
    now: new Date('2026-08-30T03:03:00.000Z'),
    maxAttempts: 3,
    retryDelayMs: 1_000
  });

  const queryText = client.queries.map((query) => query.text).join('\n');
  assert.match(queryText, /INSERT INTO core_outbox_events/);
  assert.match(queryText, /ON CONFLICT \(idempotency_key\)/);
  assert.match(queryText, /FOR UPDATE SKIP LOCKED/);
  assert.match(queryText, /status = 'processing'[\s\S]*locked_at <= \$3/);
  assert.match(queryText, /status = 'delivered'/);
  assert.match(queryText, /CASE WHEN attempts \+ 1 >= \$2 THEN 'dead_letter'/);
  assert.equal(client.queries[0].values?.[3], JSON.stringify({ workItemId: 'todo-1' }));
  assert.equal(client.queries[1].values?.[2], '2026-08-30T03:00:00.000Z');
});

test('Core Outbox publishes the PostgreSQL table and index contract', () => {
  assert.match(CORE_OUTBOX_EVENTS_TABLE_SQL, /CREATE TABLE IF NOT EXISTS core_outbox_events/);
  assert.match(CORE_OUTBOX_EVENTS_TABLE_SQL, /payload jsonb NOT NULL/);
  assert.match(CORE_OUTBOX_EVENTS_TABLE_SQL, /core_outbox_events_idempotency_key_idx/);
  assert.match(CORE_OUTBOX_EVENTS_TABLE_SQL, /core_outbox_events_pending_idx/);
});

test('Core Events registers the outbox expand migration with the migration registry shape', async () => {
  const registry = createMigrationRegistry(CORE_EVENTS_MIGRATIONS);
  const migration = CORE_EVENTS_MIGRATIONS[0];
  const client = new FakeClient();

  assert.deepEqual(registry.ordered().map((item) => item.id), [
    'core-events-outbox-expand',
    'core-events-outbox-lease-index-expand'
  ]);

  assert.equal(migration.id, 'core-events-outbox-expand');
  assert.equal(migration.ownerTaskId, 'PLATFORM-L1-009');
  assert.equal(migration.phase, 'expand');
  assert.deepEqual(migration.migrationRows, ['MIG-011']);
  assert.deepEqual(migration.targetTables, ['core_outbox_events']);

  await migration.run({ client });
  assert.match(client.queries[0].text, /CREATE TABLE IF NOT EXISTS core_outbox_events/);

  const leaseMigration = CORE_EVENTS_MIGRATIONS[1];
  assert.equal(leaseMigration.id, 'core-events-outbox-lease-index-expand');
  assert.equal(leaseMigration.ownerTaskId, 'PLATFORM-L1-014');
  await leaseMigration.run({ client });
  assert.match(client.queries[1].text, /core_outbox_events_claim_idx/);
});
