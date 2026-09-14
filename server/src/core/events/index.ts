import { randomUUID } from 'node:crypto';
import { runAtomicOperation, type AtomicParticipant, type QueryableClient } from '../database/index.js';
import type { MigrationDefinition } from '../migrations/index.js';

export type CoreEventPayload = Record<string, unknown>;
export type CoreEventStatus = 'pending' | 'processing' | 'delivered' | 'failed' | 'dead_letter';

export interface CoreEventEnvelope<TPayload extends CoreEventPayload = CoreEventPayload> {
  id: string;
  type: string;
  source: string;
  occurredAt: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  idempotencyKey?: string;
}

export interface CreateCoreEventInput<TPayload extends CoreEventPayload = CoreEventPayload> {
  type: string;
  source: string;
  payload: TPayload;
  id?: string;
  occurredAt?: Date;
  correlationId?: string;
  causationId?: string;
  actorId?: string;
  idempotencyKey?: string;
}

export type CoreEventHandler<TPayload extends CoreEventPayload = CoreEventPayload> = (
  event: CoreEventEnvelope<TPayload>
) => Promise<void> | void;

export interface CoreEventSubscription {
  unsubscribe(): void;
}

export interface CoreOutboxRecord<TPayload extends CoreEventPayload = CoreEventPayload> {
  event: CoreEventEnvelope<TPayload>;
  status: CoreEventStatus;
  attempts: number;
  nextAttemptAt: string;
  lockedAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface EnqueueCoreOutboxEventInput<TPayload extends CoreEventPayload = CoreEventPayload> {
  event: CoreEventEnvelope<TPayload>;
  nextAttemptAt?: Date;
}

export interface ClaimCoreOutboxBatchOptions {
  now?: Date;
  limit?: number;
  processingLeaseMs?: number;
}

export interface MarkCoreOutboxFailedOptions {
  eventId: string;
  error: unknown;
  now?: Date;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface CoreOutboxRepository extends AtomicParticipant {
  enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>): Promise<CoreOutboxRecord<TPayload>>;
  claimBatch(options?: ClaimCoreOutboxBatchOptions): Promise<CoreOutboxRecord[]>;
  markDelivered(eventId: string, now?: Date): Promise<void>;
  markFailed(options: MarkCoreOutboxFailedOptions): Promise<void>;
  find(eventId: string): Promise<CoreOutboxRecord | null>;
}

export interface CoreOutboxDispatcherOptions {
  repository: CoreOutboxRepository;
  eventBus: CoreEventBus;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  processingLeaseMs?: number;
  clock?: () => Date;
}

export interface CoreOutboxDispatchSummary {
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export const CORE_OUTBOX_PROCESSING_LEASE_MS = 5 * 60_000;

export const CORE_OUTBOX_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS core_outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  source text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id text,
  causation_id text,
  actor_id text,
  idempotency_key text,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS core_outbox_events_idempotency_key_idx
  ON core_outbox_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS core_outbox_events_pending_idx
  ON core_outbox_events(status, next_attempt_at, occurred_at);
`.trim();

export const CORE_OUTBOX_LEASE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS core_outbox_events_claim_idx
  ON core_outbox_events(status, next_attempt_at, locked_at, occurred_at);
`.trim();

export const CORE_EVENTS_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: 'core-events-outbox-expand',
    title: 'Create Core Outbox events table',
    ownerTaskId: 'PLATFORM-L1-009',
    phase: 'expand',
    layer: 'L1',
    dataRows: [],
    migrationRows: ['MIG-011'],
    sourceTables: [],
    targetTables: ['core_outbox_events'],
    recoveryNotes: 'The expand migration is idempotent. If it fails, restore the isolated rehearsal database or rerun after fixing DDL permissions.',
    async run(context) {
      await context.client.query(CORE_OUTBOX_EVENTS_TABLE_SQL);
      return {
        applied: true,
        notes: ['core_outbox_events table and indexes ensured']
      };
    }
  },
  {
    id: 'core-events-outbox-lease-index-expand',
    title: 'Index Core Outbox processing leases',
    ownerTaskId: 'PLATFORM-L1-014',
    phase: 'expand',
    layer: 'L1',
    dataRows: [],
    migrationRows: ['MIG-011'],
    sourceTables: ['core_outbox_events'],
    targetTables: ['core_outbox_events'],
    dependsOn: ['core-events-outbox-expand'],
    recoveryNotes: 'The lease index is additive and idempotent; rerun after correcting DDL permissions.',
    async run(context) {
      await context.client.query(CORE_OUTBOX_LEASE_INDEX_SQL);
      return {
        applied: true,
        notes: ['core_outbox_events processing lease index ensured']
      };
    }
  }
];

export class CoreEventError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreEventError';
    this.code = code;
  }
}

export class CoreEventBus {
  private readonly handlers = new Map<string, Set<CoreEventHandler>>();

  subscribe<TPayload extends CoreEventPayload>(
    eventType: string,
    handler: CoreEventHandler<TPayload>
  ): CoreEventSubscription {
    validateEventType(eventType);
    const handlers = this.handlers.get(eventType) ?? new Set<CoreEventHandler>();
    handlers.add(handler as CoreEventHandler);
    this.handlers.set(eventType, handlers);

    return {
      unsubscribe: () => handlers.delete(handler as CoreEventHandler)
    };
  }

  async publish<TPayload extends CoreEventPayload>(event: CoreEventEnvelope<TPayload>) {
    validateEventEnvelope(event);
    const handlers = [
      ...this.handlers.get(event.type) ?? [],
      ...this.handlers.get('*') ?? []
    ];

    for (const handler of handlers) {
      await handler(event);
    }
  }
}

export function createCoreEventBus() {
  return new CoreEventBus();
}

export function createCoreEvent<TPayload extends CoreEventPayload>(
  input: CreateCoreEventInput<TPayload>,
  options: { clock?: () => Date; createEventId?: () => string } = {}
): CoreEventEnvelope<TPayload> {
  const event = removeUndefinedValues({
    id: input.id ?? options.createEventId?.() ?? randomUUID(),
    type: input.type,
    source: input.source,
    occurredAt: (input.occurredAt ?? options.clock?.() ?? new Date()).toISOString(),
    payload: input.payload,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey
  });

  validateEventEnvelope(event);
  return event;
}

export function createMemoryCoreOutboxRepository(
  seed: readonly CoreOutboxRecord[] = []
): CoreOutboxRepository & { records(): CoreOutboxRecord[] } {
  const records = new Map<string, CoreOutboxRecord>();
  const idempotencyIndex = new Map<string, string>();

  for (const record of seed) {
    records.set(record.event.id, cloneRecord(record));
    if (record.event.idempotencyKey) {
      idempotencyIndex.set(record.event.idempotencyKey, record.event.id);
    }
  }

  const repository: CoreOutboxRepository & { records(): CoreOutboxRecord[] } = {
    atomic: { snapshot() {
      const savedRecords = structuredClone(records);
      const savedIndex = new Map(idempotencyIndex);
      return () => {
        records.clear(); for (const [key, value] of savedRecords) records.set(key, value);
        idempotencyIndex.clear(); for (const [key, value] of savedIndex) idempotencyIndex.set(key, value);
      };
    } },
    async enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>) {
      validateEventEnvelope(input.event);

      if (input.event.idempotencyKey) {
        const existingId = idempotencyIndex.get(input.event.idempotencyKey);
        const existing = existingId ? records.get(existingId) : null;

        if (existing) {
          return cloneRecord(existing) as CoreOutboxRecord<typeof input.event.payload>;
        }
      }

      if (records.has(input.event.id)) {
        throw new CoreEventError('DUPLICATE_EVENT_ID', `重复的事件 ID: ${input.event.id}`);
      }

      const record: CoreOutboxRecord<typeof input.event.payload> = {
        event: input.event,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: (input.nextAttemptAt ?? new Date(input.event.occurredAt)).toISOString()
      };
      records.set(input.event.id, cloneRecord(record));

      if (input.event.idempotencyKey) {
        idempotencyIndex.set(input.event.idempotencyKey, input.event.id);
      }

      return cloneRecord(record) as CoreOutboxRecord<typeof input.event.payload>;
    },
    async claimBatch(options = {}) {
      const now = options.now ?? new Date();
      const limit = options.limit ?? 50;
      const staleBefore = now.getTime() - normalizeProcessingLeaseMs(options.processingLeaseMs);
      const claimed: CoreOutboxRecord[] = [];

      for (const record of [...records.values()].sort(compareOutboxRecords)) {
        if (claimed.length >= limit) break;
        const due = (record.status === 'pending' || record.status === 'failed')
          && new Date(record.nextAttemptAt).getTime() <= now.getTime();
        const expiredLease = record.status === 'processing'
          && (!record.lockedAt || new Date(record.lockedAt).getTime() <= staleBefore);
        if (!due && !expiredLease) continue;

        const nextRecord = cloneRecord({
          ...record,
          status: 'processing',
          lockedAt: now.toISOString()
        });
        records.set(record.event.id, nextRecord);
        claimed.push(cloneRecord(nextRecord));
      }

      return claimed;
    },
    async markDelivered(eventId, now = new Date()) {
      const record = requireRecord(records, eventId);
      records.set(eventId, cloneRecord({
        ...record,
        status: 'delivered',
        deliveredAt: now.toISOString(),
        lockedAt: undefined,
        lastError: undefined
      }));
    },
    async markFailed(options) {
      const record = requireRecord(records, options.eventId);
      const now = options.now ?? new Date();
      const attempts = record.attempts + 1;
      const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
      const deadLetter = attempts >= maxAttempts;

      records.set(options.eventId, cloneRecord({
        ...record,
        status: deadLetter ? 'dead_letter' : 'failed',
        attempts,
        lockedAt: undefined,
        nextAttemptAt: new Date(now.getTime() + (options.retryDelayMs ?? 0)).toISOString(),
        lastError: errorMessage(options.error)
      }));
    },
    async find(eventId) {
      const record = records.get(eventId);
      return record ? cloneRecord(record) : null;
    },
    records() {
      return [...records.values()].map(cloneRecord);
    }
  };
  return {
    ...repository,
    enqueue: (input) => runAtomicOperation([repository], () => repository.enqueue(input)),
    claimBatch: (options) => runAtomicOperation([repository], () => repository.claimBatch(options)),
    markDelivered: (id, now) => runAtomicOperation([repository], () => repository.markDelivered(id, now)),
    markFailed: (options) => runAtomicOperation([repository], () => repository.markFailed(options))
  };
}

export function createPostgresCoreOutboxRepository(client: QueryableClient): CoreOutboxRepository {
  return {
    atomic: { client },
    async enqueue<TPayload extends CoreEventPayload>(input: EnqueueCoreOutboxEventInput<TPayload>) {
      validateEventEnvelope(input.event);
      const nextAttemptAt = input.nextAttemptAt ?? new Date(input.event.occurredAt);
      const result = await client.query(
        `
          INSERT INTO core_outbox_events (
            id, event_type, source, payload, correlation_id, causation_id, actor_id,
            idempotency_key, status, attempts, next_attempt_at, occurred_at
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'pending', 0, $9, $10)
          ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
          SET updated_at = core_outbox_events.updated_at
          RETURNING *
        `,
        [
          input.event.id,
          input.event.type,
          input.event.source,
          JSON.stringify(input.event.payload),
          input.event.correlationId ?? null,
          input.event.causationId ?? null,
          input.event.actorId ?? null,
          input.event.idempotencyKey ?? null,
          nextAttemptAt.toISOString(),
          input.event.occurredAt
        ]
      ) as { rows?: unknown[] };

      const row = result.rows?.[0];
      if (!row) {
        throw new CoreEventError('OUTBOX_INSERT_FAILED', `Outbox 写入失败: ${input.event.id}`);
      }

      return rowToOutboxRecord(row) as CoreOutboxRecord<TPayload>;
    },
    async claimBatch(options = {}) {
      const now = options.now ?? new Date();
      const limit = options.limit ?? 50;
      const staleBefore = new Date(now.getTime() - normalizeProcessingLeaseMs(options.processingLeaseMs));
      const result = await client.query(
        `
          UPDATE core_outbox_events
          SET status = 'processing',
              locked_at = $1,
              updated_at = NOW()
          WHERE id IN (
            SELECT id
            FROM core_outbox_events
            WHERE (status IN ('pending', 'failed') AND next_attempt_at <= $1)
               OR (status = 'processing' AND (locked_at IS NULL OR locked_at <= $3))
            ORDER BY next_attempt_at ASC, occurred_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *
        `,
        [now.toISOString(), limit, staleBefore.toISOString()]
      ) as { rows?: unknown[] };

      return (result.rows ?? []).map(rowToOutboxRecord);
    },
    async markDelivered(eventId, now = new Date()) {
      await client.query(
        `
          UPDATE core_outbox_events
          SET status = 'delivered',
              delivered_at = $2,
              locked_at = NULL,
              last_error = NULL,
              updated_at = NOW()
          WHERE id = $1
        `,
        [eventId, now.toISOString()]
      );
    },
    async markFailed(options) {
      const now = options.now ?? new Date();
      const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
      const nextAttemptAt = new Date(now.getTime() + (options.retryDelayMs ?? 0));
      await client.query(
        `
          UPDATE core_outbox_events
          SET attempts = attempts + 1,
              status = CASE WHEN attempts + 1 >= $2 THEN 'dead_letter' ELSE 'failed' END,
              next_attempt_at = $3,
              locked_at = NULL,
              last_error = $4,
              updated_at = NOW()
          WHERE id = $1
        `,
        [options.eventId, maxAttempts, nextAttemptAt.toISOString(), errorMessage(options.error)]
      );
    },
    async find(eventId) {
      const result = await client.query(
        'SELECT * FROM core_outbox_events WHERE id = $1',
        [eventId]
      ) as { rows?: unknown[] };
      const row = result.rows?.[0];
      return row ? rowToOutboxRecord(row) : null;
    }
  };
}

export async function enqueueCoreEvent<TPayload extends CoreEventPayload>(
  repository: CoreOutboxRepository,
  input: CreateCoreEventInput<TPayload>,
  options: { clock?: () => Date; createEventId?: () => string; nextAttemptAt?: Date } = {}
) {
  const event = createCoreEvent(input, options);
  return repository.enqueue({
    event,
    nextAttemptAt: options.nextAttemptAt
  });
}

export async function dispatchCoreOutboxBatch(options: CoreOutboxDispatcherOptions): Promise<CoreOutboxDispatchSummary> {
  const clock = options.clock ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const records = await options.repository.claimBatch({
    now: clock(),
    limit: options.batchSize ?? 50,
    processingLeaseMs: options.processingLeaseMs
  });
  const summary: CoreOutboxDispatchSummary = {
    claimed: records.length,
    delivered: 0,
    failed: 0,
    deadLettered: 0
  };

  for (const record of records) {
    try {
      await options.eventBus.publish(record.event);
      await options.repository.markDelivered(record.event.id, clock());
      summary.delivered += 1;
    } catch (error) {
      await options.repository.markFailed({
        eventId: record.event.id,
        error,
        now: clock(),
        maxAttempts,
        retryDelayMs
      });
      const updated = await options.repository.find(record.event.id);

      if (updated?.status === 'dead_letter') {
        summary.deadLettered += 1;
      } else {
        summary.failed += 1;
      }
    }
  }

  return summary;
}

export function validateEventEnvelope(event: CoreEventEnvelope) {
  validateEventType(event.type);

  if (!event.id.trim()) {
    throw new CoreEventError('MISSING_EVENT_ID', '事件缺少 ID');
  }

  if (!event.source.trim()) {
    throw new CoreEventError('MISSING_EVENT_SOURCE', `事件 ${event.id} 缺少 source`);
  }

  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new CoreEventError('INVALID_EVENT_PAYLOAD', `事件 ${event.id} payload 必须是对象`);
  }

  if (Number.isNaN(new Date(event.occurredAt).getTime())) {
    throw new CoreEventError('INVALID_OCCURRED_AT', `事件 ${event.id} occurredAt 无效`);
  }
}

function validateEventType(eventType: string) {
  if (eventType !== '*' && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(eventType)) {
    throw new CoreEventError('INVALID_EVENT_TYPE', `事件类型必须稳定且可版本化: ${eventType}`);
  }
}

function rowToOutboxRecord(row: unknown): CoreOutboxRecord {
  const value = row as {
    id?: unknown;
    event_type?: unknown;
    source?: unknown;
    payload?: unknown;
    correlation_id?: unknown;
    causation_id?: unknown;
    actor_id?: unknown;
    idempotency_key?: unknown;
    status?: unknown;
    attempts?: unknown;
    next_attempt_at?: unknown;
    locked_at?: unknown;
    delivered_at?: unknown;
    last_error?: unknown;
    occurred_at?: unknown;
  };
  const payload = typeof value.payload === 'string' ? JSON.parse(value.payload) : value.payload;
  const event = removeUndefinedValues({
    id: String(value.id ?? ''),
    type: String(value.event_type ?? ''),
    source: String(value.source ?? ''),
    occurredAt: normalizeDateString(value.occurred_at),
    payload: payload as CoreEventPayload,
    correlationId: optionalString(value.correlation_id),
    causationId: optionalString(value.causation_id),
    actorId: optionalString(value.actor_id),
    idempotencyKey: optionalString(value.idempotency_key)
  });

  validateEventEnvelope(event);

  return removeUndefinedValues({
    event,
    status: String(value.status ?? 'pending') as CoreEventStatus,
    attempts: Number(value.attempts ?? 0),
    nextAttemptAt: normalizeDateString(value.next_attempt_at),
    lockedAt: optionalDateString(value.locked_at),
    deliveredAt: optionalDateString(value.delivered_at),
    lastError: optionalString(value.last_error)
  });
}

function requireRecord(records: Map<string, CoreOutboxRecord>, eventId: string) {
  const record = records.get(eventId);

  if (!record) {
    throw new CoreEventError('UNKNOWN_OUTBOX_EVENT', `Outbox 事件不存在: ${eventId}`);
  }

  return record;
}

function compareOutboxRecords(left: CoreOutboxRecord, right: CoreOutboxRecord) {
  return new Date(left.nextAttemptAt).getTime() - new Date(right.nextAttemptAt).getTime()
    || new Date(left.event.occurredAt).getTime() - new Date(right.event.occurredAt).getTime();
}

function normalizeProcessingLeaseMs(value: number | undefined) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : CORE_OUTBOX_PROCESSING_LEASE_MS;
}

function cloneRecord<TPayload extends CoreEventPayload>(record: CoreOutboxRecord<TPayload>): CoreOutboxRecord<TPayload> {
  return {
    ...record,
    event: {
      ...record.event,
      payload: structuredClone(record.event.payload)
    }
  };
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeDateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

function optionalDateString(value: unknown) {
  if (!value) return undefined;
  return normalizeDateString(value);
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
