import { randomUUID } from 'node:crypto';
import type { QueryableClient } from '../database/index.js';
import type { CoreEventEnvelope, CoreEventPayload } from '../events/index.js';
import type { CoreJobRunRecord } from '../jobs/index.js';
import type { MigrationDefinition } from '../migrations/index.js';

export type CoreObservationKind =
  | 'request'
  | 'job'
  | 'event'
  | 'app'
  | 'tool'
  | 'external'
  | 'migration'
  | 'runtime';
export type CoreObservationLevel = 'debug' | 'info' | 'warn' | 'error';
export type CoreObservationOutcome = 'started' | 'succeeded' | 'failed' | 'skipped';
export type CoreMetricKind = 'counter' | 'duration';
export type CoreHealthStatus = 'up' | 'degraded' | 'down';

export interface CoreTraceContext {
  traceId: string;
  requestId?: string;
  correlationId?: string;
  causationId?: string;
  sessionId?: string;
  actorId?: string;
  jobId?: string;
  jobRunId?: string;
  eventId?: string;
  eventType?: string;
  appId?: string;
  appVersion?: string;
  toolName?: string;
  externalSystem?: string;
  operation?: string;
  dataScopeDecisionId?: string;
}

export interface CreateCoreTraceContextInput extends Partial<CoreTraceContext> {
  parent?: CoreTraceContext;
}

export interface CoreObservation {
  kind: CoreObservationKind;
  operation: string;
  context: CoreTraceContext;
  outcome?: CoreObservationOutcome;
  errorCode?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface CoreStructuredLogRecord {
  level: CoreObservationLevel;
  message: string;
  timestamp: string;
  observation: CoreObservation;
}

export interface CoreMetricRecord {
  name: string;
  kind: CoreMetricKind;
  value: number;
  timestamp: string;
  unit?: string;
  labels?: Record<string, string>;
  context?: CoreTraceContext;
}

export interface CoreTechnicalAuditInput {
  id?: string;
  category: CoreObservationKind;
  action: string;
  outcome: Exclude<CoreObservationOutcome, 'started'>;
  context: CoreTraceContext;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  createdAt?: Date;
}

export interface CoreTechnicalAuditRecord extends Required<Omit<CoreTechnicalAuditInput, 'id' | 'createdAt' | 'metadata' | 'errorCode'>> {
  id: string;
  metadata: Record<string, unknown>;
  errorCode?: string;
  createdAt: string;
}

export interface CoreLogSink {
  write(record: CoreStructuredLogRecord): Promise<void> | void;
}

export interface CoreMetricSink {
  record(record: CoreMetricRecord): Promise<void> | void;
}

export interface CoreTechnicalAuditRepository {
  append(input: CoreTechnicalAuditInput): Promise<CoreTechnicalAuditRecord>;
  findByTraceId(traceId: string): Promise<CoreTechnicalAuditRecord[]>;
}

export interface CoreLogger {
  debug(observation: CoreObservation, message?: string): Promise<void>;
  info(observation: CoreObservation, message?: string): Promise<void>;
  warn(observation: CoreObservation, message?: string): Promise<void>;
  error(observation: CoreObservation, message?: string): Promise<void>;
}

export interface CoreMetricRecorder {
  incrementCounter(name: string, options?: CoreMetricOptions): Promise<void>;
  recordDuration(name: string, durationMs: number, options?: CoreMetricOptions): Promise<void>;
}

export interface CoreMetricOptions {
  labels?: Record<string, string>;
  context?: CoreTraceContext;
  timestamp?: Date;
}

export interface CoreHealthCheck {
  id: string;
  component: string;
  run(): Promise<CoreHealthCheckResult> | CoreHealthCheckResult;
}

export interface CoreHealthCheckResult {
  status: CoreHealthStatus;
  message?: string;
  details?: Record<string, unknown>;
  checkedAt?: Date;
}

export interface CoreHealthReport {
  status: CoreHealthStatus;
  checkedAt: string;
  checks: Array<Omit<CoreHealthCheckResult, 'checkedAt'> & { id: string; component: string; checkedAt: string }>;
}

export interface ObserveCoreOperationOptions<T> {
  kind: CoreObservationKind;
  operation: string;
  context: CoreTraceContext;
  run(): Promise<T> | T;
  logger?: CoreLogger;
  metrics?: CoreMetricRecorder;
  auditRepository?: CoreTechnicalAuditRepository;
  metadata?: Record<string, unknown>;
  clock?: () => Date;
}

export interface RedactionOptions {
  replacement?: string;
  maxDepth?: number;
  maxStringLength?: number;
  sensitiveKeyPattern?: RegExp;
}

export const CORE_TECHNICAL_AUDIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS core_technical_audit (
  id uuid PRIMARY KEY,
  category text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  trace_id text NOT NULL,
  context jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS core_technical_audit_trace_idx
  ON core_technical_audit(trace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS core_technical_audit_category_created_idx
  ON core_technical_audit(category, created_at DESC);
`.trim();

export const CORE_OBSERVABILITY_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    id: 'core-observability-audit-expand',
    title: 'Create Core technical audit sink table',
    ownerTaskId: 'PLATFORM-L1-012',
    phase: 'expand',
    layer: 'L1',
    dataRows: [],
    migrationRows: ['MIG-039'],
    sourceTables: [],
    targetTables: ['core_technical_audit'],
    recoveryNotes: 'The expand migration is idempotent. If it fails, restore the isolated rehearsal database or rerun after fixing DDL permissions.',
    async run(context) {
      await context.client.query(CORE_TECHNICAL_AUDIT_TABLE_SQL);
      return {
        applied: true,
        notes: ['core_technical_audit table and indexes ensured']
      };
    }
  }
];

export class CoreObservabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreObservabilityError';
    this.code = code;
  }
}

export function createTraceId(prefix = 'trace') {
  return `${prefix}_${randomUUID()}`;
}

export function createCoreTraceContext(input: CreateCoreTraceContextInput = {}): CoreTraceContext {
  const parent = input.parent;
  const context = removeUndefinedValues({
    traceId: input.traceId ?? parent?.traceId ?? createTraceId(),
    requestId: input.requestId ?? parent?.requestId,
    correlationId: input.correlationId ?? parent?.correlationId,
    causationId: input.causationId ?? parent?.causationId,
    sessionId: input.sessionId ?? parent?.sessionId,
    actorId: input.actorId ?? parent?.actorId,
    jobId: input.jobId ?? parent?.jobId,
    jobRunId: input.jobRunId ?? parent?.jobRunId,
    eventId: input.eventId ?? parent?.eventId,
    eventType: input.eventType ?? parent?.eventType,
    appId: input.appId ?? parent?.appId,
    appVersion: input.appVersion ?? parent?.appVersion,
    toolName: input.toolName ?? parent?.toolName,
    externalSystem: input.externalSystem ?? parent?.externalSystem,
    operation: input.operation ?? parent?.operation,
    dataScopeDecisionId: input.dataScopeDecisionId ?? parent?.dataScopeDecisionId
  });

  validateTraceContext(context);
  return context;
}

export function createRequestTraceContext(input: {
  requestId: string;
  traceId?: string;
  actorId?: string;
  sessionId?: string;
  operation?: string;
  dataScopeDecisionId?: string;
}) {
  return createCoreTraceContext({
    traceId: input.traceId,
    requestId: input.requestId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    operation: input.operation,
    dataScopeDecisionId: input.dataScopeDecisionId
  });
}

export function createJobTraceContext(record: Pick<CoreJobRunRecord, 'runId' | 'jobId'>, parent?: CoreTraceContext) {
  return createCoreTraceContext({
    parent,
    jobId: record.jobId,
    jobRunId: record.runId,
    operation: `job:${record.jobId}`
  });
}

export function createEventTraceContext<TPayload extends CoreEventPayload>(
  event: CoreEventEnvelope<TPayload>,
  parent?: CoreTraceContext
) {
  return createCoreTraceContext({
    parent,
    traceId: parent?.traceId ?? event.correlationId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    actorId: event.actorId ?? parent?.actorId,
    eventId: event.id,
    eventType: event.type,
    operation: `event:${event.type}`
  });
}

export function createAppTraceContext(input: {
  appId: string;
  appVersion?: string;
  operation: string;
  parent?: CoreTraceContext;
}) {
  return createCoreTraceContext({
    parent: input.parent,
    appId: input.appId,
    appVersion: input.appVersion,
    operation: input.operation
  });
}

export function createToolTraceContext(input: {
  toolName: string;
  operation?: string;
  parent?: CoreTraceContext;
}) {
  return createCoreTraceContext({
    parent: input.parent,
    toolName: input.toolName,
    operation: input.operation ?? `tool:${input.toolName}`
  });
}

export function createExternalTraceContext(input: {
  externalSystem: string;
  operation: string;
  parent?: CoreTraceContext;
}) {
  return createCoreTraceContext({
    parent: input.parent,
    externalSystem: input.externalSystem,
    operation: input.operation
  });
}

export function redactCoreValue(value: unknown, options: RedactionOptions = {}, depth = 0): unknown {
  const replacement = options.replacement ?? '[REDACTED]';
  const maxDepth = options.maxDepth ?? 8;
  const maxStringLength = options.maxStringLength ?? 2_000;
  const sensitiveKeyPattern = options.sensitiveKeyPattern ?? DEFAULT_SENSITIVE_KEY_PATTERN;

  if (depth > maxDepth) {
    return '[MaxDepth]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactCoreValue(item, options, depth + 1));
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? replacement : redactCoreValue(item, options, depth + 1)
      ])
    );
  }

  if (typeof value === 'string' && value.length > maxStringLength) {
    return `${value.slice(0, maxStringLength)}…[truncated:${value.length - maxStringLength}]`;
  }

  return value;
}

export function createMemoryCoreLogSink(seed: readonly CoreStructuredLogRecord[] = []) {
  const records = seed.map(clone);

  return {
    async write(record: CoreStructuredLogRecord) {
      records.push(clone(record));
    },
    records() {
      return records.map(clone);
    }
  } satisfies CoreLogSink & { records(): CoreStructuredLogRecord[] };
}

export function createCoreLogger(sink: CoreLogSink, options: { clock?: () => Date; redaction?: RedactionOptions } = {}): CoreLogger {
  async function write(level: CoreObservationLevel, observation: CoreObservation, message?: string) {
    validateObservation(observation);
    await sink.write({
      level,
      message: message ?? observation.operation,
      timestamp: (options.clock?.() ?? new Date()).toISOString(),
      observation: redactObservation(observation, options.redaction)
    });
  }

  return {
    debug: (observation, message) => write('debug', observation, message),
    info: (observation, message) => write('info', observation, message),
    warn: (observation, message) => write('warn', observation, message),
    error: (observation, message) => write('error', observation, message)
  };
}

export function createMemoryCoreMetricSink(seed: readonly CoreMetricRecord[] = []) {
  const records = seed.map(clone);

  return {
    async record(record: CoreMetricRecord) {
      validateMetric(record);
      records.push(clone(record));
    },
    records() {
      return records.map(clone);
    }
  } satisfies CoreMetricSink & { records(): CoreMetricRecord[] };
}

export function createCoreMetricRecorder(sink: CoreMetricSink, options: { clock?: () => Date } = {}): CoreMetricRecorder {
  return {
    async incrementCounter(name, metricOptions = {}) {
      await sink.record({
        name,
        kind: 'counter',
        value: 1,
        timestamp: (metricOptions.timestamp ?? options.clock?.() ?? new Date()).toISOString(),
        labels: metricOptions.labels,
        context: metricOptions.context
      });
    },
    async recordDuration(name, durationMs, metricOptions = {}) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new CoreObservabilityError('INVALID_DURATION', `指标耗时不能小于 0: ${name}`);
      }

      await sink.record({
        name,
        kind: 'duration',
        value: durationMs,
        unit: 'ms',
        timestamp: (metricOptions.timestamp ?? options.clock?.() ?? new Date()).toISOString(),
        labels: metricOptions.labels,
        context: metricOptions.context
      });
    }
  };
}

export function createMemoryCoreTechnicalAuditRepository(seed: readonly CoreTechnicalAuditRecord[] = []) {
  const records = seed.map(clone);

  return {
    async append(input: CoreTechnicalAuditInput) {
      validateTraceContext(input.context);
      const record: CoreTechnicalAuditRecord = {
        id: input.id ?? randomUUID(),
        category: input.category,
        action: input.action,
        outcome: input.outcome,
        context: clone(input.context),
        metadata: redactCoreValue(input.metadata ?? {}) as Record<string, unknown>,
        errorCode: input.errorCode,
        createdAt: (input.createdAt ?? new Date()).toISOString()
      };
      records.push(clone(record));
      return clone(record);
    },
    async findByTraceId(traceId: string) {
      return records.filter((record) => record.context.traceId === traceId).map(clone);
    }
  } satisfies CoreTechnicalAuditRepository & { records?: () => CoreTechnicalAuditRecord[] };
}

export function createPostgresCoreTechnicalAuditRepository(client: QueryableClient): CoreTechnicalAuditRepository {
  return {
    async append(input) {
      validateTraceContext(input.context);
      const record: CoreTechnicalAuditRecord = {
        id: input.id ?? randomUUID(),
        category: input.category,
        action: input.action,
        outcome: input.outcome,
        context: clone(input.context),
        metadata: redactCoreValue(input.metadata ?? {}) as Record<string, unknown>,
        errorCode: input.errorCode,
        createdAt: (input.createdAt ?? new Date()).toISOString()
      };
      await client.query(
        `
          INSERT INTO core_technical_audit (
            id, category, action, outcome, trace_id, context, metadata, error_code, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
        `,
        [
          record.id,
          record.category,
          record.action,
          record.outcome,
          record.context.traceId,
          JSON.stringify(record.context),
          JSON.stringify(record.metadata),
          record.errorCode ?? null,
          record.createdAt
        ]
      );
      return record;
    },
    async findByTraceId(traceId) {
      const result = await client.query(
        `
          SELECT *
          FROM core_technical_audit
          WHERE trace_id = $1
          ORDER BY created_at ASC
        `,
        [traceId]
      ) as { rows?: unknown[] };

      return (result.rows ?? []).map(rowToAuditRecord);
    }
  };
}

export class CoreHealthRegistry {
  private readonly checks = new Map<string, CoreHealthCheck>();

  register(...checks: readonly CoreHealthCheck[]) {
    for (const check of checks) {
      validateHealthCheck(check);

      if (this.checks.has(check.id)) {
        throw new CoreObservabilityError('DUPLICATE_HEALTH_CHECK', `重复的健康检查 ID: ${check.id}`);
      }

      this.checks.set(check.id, check);
    }

    return this;
  }

  list() {
    return [...this.checks.values()];
  }

  async checkAll(options: { clock?: () => Date } = {}): Promise<CoreHealthReport> {
    const checkedAt = (options.clock?.() ?? new Date()).toISOString();
    const checks = [];

    for (const check of this.checks.values()) {
      try {
        const result = await check.run();
        checks.push({
          ...redactHealthResult(result),
          id: check.id,
          component: check.component,
          checkedAt: (result.checkedAt ?? new Date(checkedAt)).toISOString()
        });
      } catch (error) {
        checks.push({
          id: check.id,
          component: check.component,
          status: 'down' as const,
          message: errorMessage(error),
          checkedAt
        });
      }
    }

    return {
      status: summarizeHealthStatus(checks.map((check) => check.status)),
      checkedAt,
      checks
    };
  }
}

export function createCoreHealthRegistry() {
  return new CoreHealthRegistry();
}

export async function observeCoreOperation<T>(options: ObserveCoreOperationOptions<T>): Promise<T> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock();
  const baseObservation = {
    kind: options.kind,
    operation: options.operation,
    context: createCoreTraceContext({ parent: options.context, operation: options.operation }),
    metadata: options.metadata
  } satisfies CoreObservation;

  await options.logger?.info({ ...baseObservation, outcome: 'started' }, `${options.operation} started`);

  try {
    const result = await options.run();
    const finishedAt = clock();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const labels = coreLabels(options.kind, options.operation, 'succeeded');

    await options.metrics?.incrementCounter('core.operation.total', {
      labels,
      context: baseObservation.context,
      timestamp: finishedAt
    });
    await options.metrics?.recordDuration('core.operation.duration', durationMs, {
      labels,
      context: baseObservation.context,
      timestamp: finishedAt
    });
    await options.auditRepository?.append({
      category: options.kind,
      action: options.operation,
      outcome: 'succeeded',
      context: baseObservation.context,
      metadata: options.metadata,
      createdAt: finishedAt
    });
    await options.logger?.info({ ...baseObservation, outcome: 'succeeded', durationMs }, `${options.operation} succeeded`);
    return result;
  } catch (error) {
    const finishedAt = clock();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const errorCode = stableErrorCode(error);
    const labels = coreLabels(options.kind, options.operation, 'failed', errorCode);

    await options.metrics?.incrementCounter('core.operation.total', {
      labels,
      context: baseObservation.context,
      timestamp: finishedAt
    });
    await options.metrics?.recordDuration('core.operation.duration', durationMs, {
      labels,
      context: baseObservation.context,
      timestamp: finishedAt
    });
    await options.auditRepository?.append({
      category: options.kind,
      action: options.operation,
      outcome: 'failed',
      context: baseObservation.context,
      metadata: options.metadata,
      errorCode,
      createdAt: finishedAt
    });
    await options.logger?.error({ ...baseObservation, outcome: 'failed', durationMs, errorCode }, `${options.operation} failed`);
    throw error;
  }
}

export function validateTraceContext(context: CoreTraceContext) {
  if (!context.traceId?.trim()) {
    throw new CoreObservabilityError('MISSING_TRACE_ID', '观测上下文缺少 traceId');
  }

  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'string' && /\s/.test(value)) {
      throw new CoreObservabilityError('INVALID_TRACE_FIELD', `观测上下文字段不能包含空白字符: ${key}`);
    }
  }
}

function validateObservation(observation: CoreObservation) {
  if (!observation.operation.trim()) {
    throw new CoreObservabilityError('MISSING_OPERATION', '观测记录缺少 operation');
  }

  validateTraceContext(observation.context);
}

function validateMetric(record: CoreMetricRecord) {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(record.name)) {
    throw new CoreObservabilityError('INVALID_METRIC_NAME', `指标名必须稳定: ${record.name}`);
  }

  if (!Number.isFinite(record.value) || record.value < 0) {
    throw new CoreObservabilityError('INVALID_METRIC_VALUE', `指标值不能小于 0: ${record.name}`);
  }
}

function validateHealthCheck(check: CoreHealthCheck) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(check.id)) {
    throw new CoreObservabilityError('INVALID_HEALTH_CHECK_ID', `健康检查 ID 必须是稳定 kebab-case: ${check.id}`);
  }

  if (!check.component.trim()) {
    throw new CoreObservabilityError('MISSING_HEALTH_COMPONENT', `健康检查缺少 component: ${check.id}`);
  }
}

function redactObservation(observation: CoreObservation, options?: RedactionOptions): CoreObservation {
  return {
    ...observation,
    context: clone(observation.context),
    metadata: redactCoreValue(observation.metadata ?? {}, options) as Record<string, unknown>
  };
}

function redactHealthResult(result: CoreHealthCheckResult): CoreHealthCheckResult {
  return {
    ...result,
    details: redactCoreValue(result.details ?? {}) as Record<string, unknown>
  };
}

function summarizeHealthStatus(statuses: readonly CoreHealthStatus[]): CoreHealthStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'up';
}

function coreLabels(
  kind: CoreObservationKind,
  operation: string,
  outcome: Exclude<CoreObservationOutcome, 'started'>,
  errorCode?: string
): Record<string, string> {
  return removeUndefinedValues({
    kind,
    operation,
    outcome,
    error_code: errorCode
  }) as Record<string, string>;
}

function rowToAuditRecord(row: unknown): CoreTechnicalAuditRecord {
  const value = row as {
    id?: unknown;
    category?: unknown;
    action?: unknown;
    outcome?: unknown;
    context?: unknown;
    metadata?: unknown;
    error_code?: unknown;
    created_at?: unknown;
  };
  const context = parseJsonObject(value.context);
  const metadata = parseJsonObject(value.metadata);
  validateTraceContext(context as unknown as CoreTraceContext);
  const record = {
    id: String(value.id ?? ''),
    category: String(value.category ?? 'runtime') as CoreObservationKind,
    action: String(value.action ?? ''),
    outcome: String(value.outcome ?? 'succeeded') as Exclude<CoreObservationOutcome, 'started'>,
    context: context as unknown as CoreTraceContext,
    metadata,
    errorCode: optionalString(value.error_code),
    createdAt: normalizeDateString(value.created_at)
  };

  return record;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>;
  }

  if (isObject(value)) {
    return value;
  }

  return {};
}

function stableErrorCode(error: unknown) {
  if (isObject(error) && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof Error && error.name && error.name !== 'Error') {
    return error.name;
  }

  return 'UNKNOWN_ERROR';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeDateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date(String(value)).toISOString();
}

function removeUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const DEFAULT_SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|authorization|cookie|database[_-]?url|connection[_-]?string|private[_-]?key|signing)/i;
