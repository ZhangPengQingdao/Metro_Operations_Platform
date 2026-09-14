import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORE_OBSERVABILITY_MIGRATIONS,
  CORE_TECHNICAL_AUDIT_TABLE_SQL,
  CoreObservabilityError,
  createAppTraceContext,
  createCoreHealthRegistry,
  createCoreLogger,
  createCoreMetricRecorder,
  createEventTraceContext,
  createExternalTraceContext,
  createJobTraceContext,
  createMemoryCoreLogSink,
  createMemoryCoreMetricSink,
  createMemoryCoreTechnicalAuditRepository,
  createPostgresCoreTechnicalAuditRepository,
  createRequestTraceContext,
  createToolTraceContext,
  observeCoreOperation,
  redactCoreValue
} from '../src/core/observability/index.ts';
import { createCoreEvent } from '../src/core/events/index.ts';
import { createMigrationRegistry } from '../src/core/migrations/index.ts';

class FakeClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  constructor(private readonly rows: readonly Record<string, unknown>[] = []) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    return { rows: this.rows };
  }
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 3, 30, tick++));
}

test('Core Observability creates trace context for request, job, event, app, tool, and external calls', () => {
  const request = createRequestTraceContext({
    traceId: 'trace-root',
    requestId: 'req-1',
    actorId: 'user-1',
    sessionId: 'session-1',
    operation: 'GET:/api/todos',
    dataScopeDecisionId: 'scope-1'
  });
  const job = createJobTraceContext({ runId: 'run-1', jobId: 'cloud-doc-sync' }, request);
  const event = createEventTraceContext(createCoreEvent({
    id: 'event-1',
    type: 'work-item.created.v1',
    source: 'platform/work-items',
    payload: {},
    correlationId: 'trace-root',
    causationId: 'req-1',
    actorId: 'user-1'
  }), job);
  const app = createAppTraceContext({ appId: 'faults', appVersion: '0.0.1-alpha.3', operation: 'fault.create', parent: event });
  const tool = createToolTraceContext({ toolName: 'afc_report_fault', parent: app });
  const external = createExternalTraceContext({ externalSystem: 'wecom', operation: 'send-message', parent: tool });

  assert.deepEqual(external, {
    traceId: 'trace-root',
    requestId: 'req-1',
    correlationId: 'trace-root',
    causationId: 'req-1',
    sessionId: 'session-1',
    actorId: 'user-1',
    jobId: 'cloud-doc-sync',
    jobRunId: 'run-1',
    eventId: 'event-1',
    eventType: 'work-item.created.v1',
    appId: 'faults',
    appVersion: '0.0.1-alpha.3',
    toolName: 'afc_report_fault',
    externalSystem: 'wecom',
    operation: 'send-message',
    dataScopeDecisionId: 'scope-1'
  });
  assert.throws(
    () => createRequestTraceContext({ traceId: 'trace bad', requestId: 'req-1' }),
    CoreObservabilityError
  );
});

test('Core Observability redacts sensitive metadata for logs and audit records', async () => {
  const redacted = redactCoreValue({
    username: 'nick',
    password: 'secret',
    nested: {
      authorization: 'Bearer token',
      safe: 'visible'
    },
    long: 'x'.repeat(13)
  }, { maxStringLength: 10 });

  assert.deepEqual(redacted, {
    username: 'nick',
    password: '[REDACTED]',
    nested: {
      authorization: '[REDACTED]',
      safe: 'visible'
    },
    long: 'xxxxxxxxxx…[truncated:3]'
  });

  const sink = createMemoryCoreLogSink();
  const logger = createCoreLogger(sink, { clock: () => new Date('2026-08-30T03:30:00.000Z') });
  await logger.info({
    kind: 'request',
    operation: 'POST:/api/login',
    context: createRequestTraceContext({ traceId: 'trace-login', requestId: 'req-login' }),
    metadata: { sessionToken: 'do-not-log', username: 'nick' }
  });

  assert.equal(sink.records()[0].observation.metadata?.sessionToken, '[REDACTED]');
  assert.equal(sink.records()[0].observation.metadata?.username, 'nick');
});

test('Core Observability records metrics, logs, and technical audit for successful operations', async () => {
  const clock = fixedClock();
  const logs = createMemoryCoreLogSink();
  const metrics = createMemoryCoreMetricSink();
  const audit = createMemoryCoreTechnicalAuditRepository();
  const logger = createCoreLogger(logs, { clock: () => new Date('2026-08-30T03:30:00.000Z') });
  const metricRecorder = createCoreMetricRecorder(metrics, { clock: () => new Date('2026-08-30T03:30:00.000Z') });
  const context = createRequestTraceContext({
    traceId: 'trace-success',
    requestId: 'req-success'
  });

  const result = await observeCoreOperation({
    kind: 'request',
    operation: 'GET:/api/health',
    context,
    logger,
    metrics: metricRecorder,
    auditRepository: audit,
    metadata: { databaseUrl: 'postgres://secret', safe: 'ok' },
    clock,
    run: async () => 'ok'
  });

  assert.equal(result, 'ok');
  assert.deepEqual(logs.records().map((record) => [record.level, record.observation.outcome]), [
    ['info', 'started'],
    ['info', 'succeeded']
  ]);
  assert.deepEqual(metrics.records().map((record) => [record.name, record.kind, record.labels?.outcome]), [
    ['core.operation.total', 'counter', 'succeeded'],
    ['core.operation.duration', 'duration', 'succeeded']
  ]);
  assert.equal(metrics.records()[1].value, 1000);
  assert.deepEqual(await audit.findByTraceId('trace-success'), [{
    id: (await audit.findByTraceId('trace-success'))[0].id,
    category: 'request',
    action: 'GET:/api/health',
    outcome: 'succeeded',
    context: {
      traceId: 'trace-success',
      requestId: 'req-success',
      operation: 'GET:/api/health'
    },
    metadata: {
      databaseUrl: '[REDACTED]',
      safe: 'ok'
    },
    errorCode: undefined,
    createdAt: '2026-08-30T03:30:01.000Z'
  }]);
});

test('Core Observability records failure outcome without swallowing the original error', async () => {
  const clock = fixedClock();
  const logs = createMemoryCoreLogSink();
  const metrics = createMemoryCoreMetricSink();
  const audit = createMemoryCoreTechnicalAuditRepository();
  const logger = createCoreLogger(logs, { clock });
  const metricRecorder = createCoreMetricRecorder(metrics, { clock });
  const error = Object.assign(new Error('provider down'), { code: 'WECOM_DOWN' });

  await assert.rejects(
    () => observeCoreOperation({
      kind: 'external',
      operation: 'wecom.send',
      context: createExternalTraceContext({
        externalSystem: 'wecom',
        operation: 'wecom.send',
        parent: createRequestTraceContext({ traceId: 'trace-fail', requestId: 'req-fail' })
      }),
      logger,
      metrics: metricRecorder,
      auditRepository: audit,
      clock,
      run: async () => {
        throw error;
      }
    }),
    /provider down/
  );

  assert.equal(logs.records().at(-1)?.observation.errorCode, 'WECOM_DOWN');
  assert.equal(metrics.records()[0].labels?.outcome, 'failed');
  assert.equal(metrics.records()[0].labels?.error_code, 'WECOM_DOWN');
  assert.equal((await audit.findByTraceId('trace-fail'))[0].outcome, 'failed');
  assert.equal((await audit.findByTraceId('trace-fail'))[0].errorCode, 'WECOM_DOWN');
});

test('Core Observability health registry summarizes degraded and down checks', async () => {
  const registry = createCoreHealthRegistry()
    .register({
      id: 'database',
      component: 'core/database',
      run: () => ({ status: 'up', details: { connectionString: 'hidden' } })
    })
    .register({
      id: 'jobs',
      component: 'core/jobs',
      run: () => ({ status: 'degraded', message: 'one scheduler lagging' })
    });

  assert.throws(
    () => registry.register({ id: 'bad_id', component: 'bad', run: () => ({ status: 'up' }) }),
    /稳定 kebab-case/
  );

  const degraded = await registry.checkAll({ clock: () => new Date('2026-08-30T03:40:00.000Z') });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.checks[0].details?.connectionString, '[REDACTED]');

  registry.register({
    id: 'events',
    component: 'core/events',
    run: () => {
      throw new Error('outbox unavailable');
    }
  });
  const down = await registry.checkAll({ clock: () => new Date('2026-08-30T03:41:00.000Z') });
  assert.equal(down.status, 'down');
  assert.equal(down.checks.at(-1)?.message, 'outbox unavailable');
});

test('Core Observability PostgreSQL audit repository keeps append-only trace evidence', async () => {
  const client = new FakeClient([
    {
      id: 'audit-1',
      category: 'tool',
      action: 'afc_report_fault',
      outcome: 'succeeded',
      context: JSON.stringify({ traceId: 'trace-tool', toolName: 'afc_report_fault' }),
      metadata: JSON.stringify({ faultId: 'fault-1' }),
      error_code: null,
      created_at: new Date('2026-08-30T03:50:00.000Z')
    }
  ]);
  const repository = createPostgresCoreTechnicalAuditRepository(client);

  const appended = await repository.append({
    id: '22222222-2222-4222-8222-222222222222',
    category: 'tool',
    action: 'afc_report_fault',
    outcome: 'succeeded',
    context: createToolTraceContext({
      toolName: 'afc_report_fault',
      parent: createRequestTraceContext({ traceId: 'trace-tool', requestId: 'req-tool' })
    }),
    metadata: { actorToken: 'secret', faultId: 'fault-1' },
    createdAt: new Date('2026-08-30T03:50:00.000Z')
  });
  const found = await repository.findByTraceId('trace-tool');

  assert.equal(appended.metadata.actorToken, '[REDACTED]');
  assert.match(client.queries[0].text, /INSERT INTO core_technical_audit/);
  assert.equal(client.queries[0].values?.[4], 'trace-tool');
  assert.match(String(client.queries[0].values?.[6]), /REDACTED/);
  assert.match(client.queries[1].text, /WHERE trace_id = \$1/);
  assert.deepEqual(found, [{
    id: 'audit-1',
    category: 'tool',
    action: 'afc_report_fault',
    outcome: 'succeeded',
    context: {
      traceId: 'trace-tool',
      toolName: 'afc_report_fault'
    },
    metadata: {
      faultId: 'fault-1'
    },
    errorCode: undefined,
    createdAt: '2026-08-30T03:50:00.000Z'
  }]);
});

test('Core Observability publishes SQL and migration contract for the technical audit sink', async () => {
  assert.match(CORE_TECHNICAL_AUDIT_TABLE_SQL, /CREATE TABLE IF NOT EXISTS core_technical_audit/);
  assert.match(CORE_TECHNICAL_AUDIT_TABLE_SQL, /trace_id text NOT NULL/);
  assert.match(CORE_TECHNICAL_AUDIT_TABLE_SQL, /core_technical_audit_trace_idx/);

  const client = new FakeClient();
  const registry = createMigrationRegistry(CORE_OBSERVABILITY_MIGRATIONS);
  const migration = registry.get('core-observability-audit-expand');

  assert.equal(migration?.ownerTaskId, 'PLATFORM-L1-012');
  assert.deepEqual(migration?.migrationRows, ['MIG-039']);

  const summary = await registry.run({
    context: { client },
    clock: () => new Date('2026-08-30T03:55:00.000Z')
  });

  assert.equal(summary.succeeded, 1);
  assert.match(client.queries[0].text, /core_technical_audit/);
});
