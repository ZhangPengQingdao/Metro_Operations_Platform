import { randomUUID } from 'node:crypto';
import type { QueryableClient } from '../database/index.js';
import type { PlatformClock } from '../time/index.js';

export type CoreJobRunStatus = 'running' | 'succeeded' | 'failed' | 'timeout' | 'dead_letter' | 'skipped' | 'cancelled';
export type CoreJobSkipReason = 'duplicate-instance' | 'advisory-lock-unavailable' | 'runtime-stopped' | 'unknown-job';

export interface CoreJobLogger {
  info?(metadata: Record<string, unknown>, message: string): void;
  warn?(metadata: Record<string, unknown>, message: string): void;
  error?(metadata: Record<string, unknown>, message: string): void;
}

export interface CoreJobExecutionContext {
  jobId: string;
  attempt: number;
  signal: AbortSignal;
  logger?: CoreJobLogger;
}

export interface CoreJobDefinition {
  id: string;
  title: string;
  run(context: CoreJobExecutionContext): Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  advisoryLockKey?: number;
  idempotencyKey?: string;
}

export interface CoreJobRunRecord {
  runId: string;
  jobId: string;
  attempt: number;
  status: CoreJobRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  idempotencyKey?: string;
  skipReason?: CoreJobSkipReason;
  errorMessage?: string;
}

export interface StartCoreJobRunInput {
  runId: string;
  jobId: string;
  attempt: number;
  startedAt: Date;
  idempotencyKey?: string;
}

export interface FinishCoreJobRunInput {
  runId: string;
  status: Exclude<CoreJobRunStatus, 'running'>;
  finishedAt: Date;
  durationMs: number;
  skipReason?: CoreJobSkipReason;
  errorMessage?: string;
}

export interface CoreJobRunRepository {
  startRun(input: StartCoreJobRunInput): Promise<void>;
  finishRun(input: FinishCoreJobRunInput): Promise<void>;
}

export interface CoreJobLock {
  release(): Promise<void>;
}

export interface CoreJobLockProvider {
  acquire(job: CoreJobDefinition): Promise<CoreJobLock | null>;
}

export interface CoreJobRuntimeOptions {
  runRepository?: CoreJobRunRepository;
  lockProvider?: CoreJobLockProvider;
  logger?: CoreJobLogger;
  clock?: PlatformClock | (() => Date);
  wait?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  createRunId?: () => string;
  shutdownTimeoutMs?: number;
}

export interface CoreJobRunOutcome {
  jobId: string;
  status: Exclude<CoreJobRunStatus, 'running'>;
  attempts: number;
  runIds: string[];
  skipReason?: CoreJobSkipReason;
  errorMessage?: string;
}

export interface CoreJobIntervalHandle {
  readonly jobId: string;
  stop(): void;
}

export interface CoreJobShutdownResult {
  drained: boolean;
  remaining: number;
}

export const CORE_JOB_RUNS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS core_job_runs (
  id uuid PRIMARY KEY,
  job_id text NOT NULL,
  attempt integer NOT NULL,
  idempotency_key text,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms integer,
  skip_reason text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS core_job_runs_job_started_idx
  ON core_job_runs(job_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS core_job_runs_idempotency_key_idx
  ON core_job_runs(job_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`.trim();

export class CoreJobRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreJobRegistryError';
    this.code = code;
  }
}

export class CoreJobRuntime {
  private readonly registry = new Map<string, CoreJobDefinition>();
  private readonly running = new Map<string, {
    controller: AbortController;
    completion: Promise<CoreJobRunOutcome>;
  }>();
  private readonly intervals = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly options: CoreJobRuntimeOptions = {}) {}

  register(...jobs: readonly CoreJobDefinition[]) {
    for (const job of jobs) {
      validateCoreJobDefinition(job);

      if (this.registry.has(job.id)) {
        throw new CoreJobRegistryError('DUPLICATE_JOB_ID', `重复的 Job ID: ${job.id}`);
      }

      this.registry.set(job.id, job);
    }

    return this;
  }

  get(jobId: string) {
    return this.registry.get(jobId) ?? null;
  }

  list() {
    return [...this.registry.values()];
  }

  async run(jobId: string): Promise<CoreJobRunOutcome> {
    const job = this.get(jobId);

    if (!job) {
      return this.recordSkipped(jobId, 'unknown-job');
    }

    if (this.stopped) {
      return this.recordSkipped(job.id, 'runtime-stopped');
    }

    if (this.running.has(job.id)) {
      return this.recordSkipped(job.id, 'duplicate-instance');
    }

    let lock: CoreJobLock | null = null;

    if (job.advisoryLockKey !== undefined && this.options.lockProvider) {
      lock = await this.options.lockProvider.acquire(job);

      if (!lock) {
        return this.recordSkipped(job.id, 'advisory-lock-unavailable');
      }
    }

    const controller = new AbortController();
    const completion = (async () => {
      try {
        return await this.runAttempts(job, controller.signal);
      } finally {
        await lock?.release();
      }
    })();
    this.running.set(job.id, { controller, completion });

    try {
      return await completion;
    } finally {
      this.running.delete(job.id);
    }
  }

  startInterval(jobId: string, options: { runImmediately?: boolean } = {}): CoreJobIntervalHandle {
    const job = this.get(jobId);

    if (!job) {
      throw new CoreJobRegistryError('UNKNOWN_JOB_ID', `Job 未注册: ${jobId}`);
    }

    if (!job.intervalMs || job.intervalMs <= 0) {
      throw new CoreJobRegistryError('MISSING_INTERVAL', `Job 缺少有效 intervalMs: ${jobId}`);
    }

    if (this.intervals.has(jobId)) {
      return {
        jobId,
        stop: () => this.stopInterval(jobId)
      };
    }

    if (options.runImmediately ?? true) {
      void this.run(jobId);
    }

    const timer = setInterval(() => {
      void this.run(jobId);
    }, job.intervalMs);
    this.intervals.set(jobId, timer);

    return {
      jobId,
      stop: () => this.stopInterval(jobId)
    };
  }

  stopInterval(jobId: string) {
    const timer = this.intervals.get(jobId);

    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.intervals.delete(jobId);
  }

  async stop(): Promise<CoreJobShutdownResult> {
    this.stopped = true;

    for (const jobId of this.intervals.keys()) {
      this.stopInterval(jobId);
    }

    const active = [...this.running.values()];
    for (const { controller } of active) {
      controller.abort();
    }

    if (active.length === 0) {
      return { drained: true, remaining: 0 };
    }

    const shutdownTimeoutMs = normalizeShutdownTimeoutMs(this.options.shutdownTimeoutMs);
    let shutdownTimer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active.map(({ completion }) => completion)).then(() => true),
      new Promise<false>((resolve) => {
        shutdownTimer = setTimeout(() => resolve(false), shutdownTimeoutMs);
      })
    ]);

    if (shutdownTimer) clearTimeout(shutdownTimer);
    return { drained, remaining: drained ? 0 : this.running.size };
  }

  private async runAttempts(job: CoreJobDefinition, runtimeSignal: AbortSignal): Promise<CoreJobRunOutcome> {
    const maxAttempts = Math.max(1, job.maxAttempts ?? 1);
    const runIds: string[] = [];
    let lastError: unknown = null;
    let lastStatus: 'failed' | 'timeout' = 'failed';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const runId = this.createRunId();
      const startedAt = this.now();
      runIds.push(runId);
      await this.repository().startRun({
        runId,
        jobId: job.id,
        attempt,
        startedAt,
        idempotencyKey: job.idempotencyKey
      });

      try {
        await this.runSingleAttempt(job, attempt, runtimeSignal);
        await this.finishRun(runId, 'succeeded', startedAt);
        return {
          jobId: job.id,
          status: 'succeeded',
          attempts: attempt,
          runIds
        };
      } catch (error) {
        if (runtimeSignal.aborted) {
          await this.finishRun(runId, 'cancelled', startedAt, undefined, 'Job cancelled during shutdown');
          return {
            jobId: job.id,
            status: 'cancelled',
            attempts: attempt,
            runIds,
            errorMessage: 'Job cancelled during shutdown'
          };
        }

        lastError = error;
        lastStatus = error instanceof CoreJobTimeoutError ? 'timeout' : 'failed';
        const finalAttempt = attempt === maxAttempts;
        const status = finalAttempt ? 'dead_letter' : lastStatus;
        await this.finishRun(runId, status, startedAt, undefined, errorMessage(error));

        if (finalAttempt) {
          break;
        }

        const retryDelayMs = job.retryDelayMs ?? 0;

        if (retryDelayMs > 0) {
          try {
            await this.wait(retryDelayMs, runtimeSignal);
          } catch (waitError) {
            if (!runtimeSignal.aborted) throw waitError;
            await this.finishRun(runId, 'cancelled', startedAt, undefined, 'Job cancelled during shutdown');
            return {
              jobId: job.id,
              status: 'cancelled',
              attempts: attempt,
              runIds,
              errorMessage: 'Job cancelled during shutdown'
            };
          }
        }
      }
    }

    return {
      jobId: job.id,
      status: 'dead_letter',
      attempts: maxAttempts,
      runIds,
      errorMessage: errorMessage(lastError)
    };
  }

  private async runSingleAttempt(job: CoreJobDefinition, attempt: number, runtimeSignal: AbortSignal) {
    if (!job.timeoutMs) {
      runtimeSignal.throwIfAborted();
      await job.run({
        jobId: job.id,
        attempt,
        signal: runtimeSignal,
        logger: this.options.logger
      });
      runtimeSignal.throwIfAborted();
      return;
    }

    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    runtimeSignal.addEventListener('abort', abortAttempt, { once: true });
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        job.run({
          jobId: job.id,
          attempt,
          signal: attemptController.signal,
          logger: this.options.logger
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            attemptController.abort();
            reject(new CoreJobTimeoutError(job.id, job.timeoutMs ?? 0));
          }, job.timeoutMs);
        })
      ]);
      attemptController.signal.throwIfAborted();
    } finally {
      runtimeSignal.removeEventListener('abort', abortAttempt);

      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async recordSkipped(jobId: string, skipReason: CoreJobSkipReason): Promise<CoreJobRunOutcome> {
    const runId = this.createRunId();
    const startedAt = this.now();
    await this.repository().startRun({
      runId,
      jobId,
      attempt: 0,
      startedAt
    });
    await this.finishRun(runId, 'skipped', startedAt, skipReason);

    return {
      jobId,
      status: 'skipped',
      attempts: 0,
      runIds: [runId],
      skipReason
    };
  }

  private async finishRun(
    runId: string,
    status: Exclude<CoreJobRunStatus, 'running'>,
    startedAt: Date,
    skipReason?: CoreJobSkipReason,
    errorMessageValue?: string
  ) {
    const finishedAt = this.now();
    await this.repository().finishRun({
      runId,
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      skipReason,
      errorMessage: errorMessageValue
    });
  }

  private repository() {
    return this.options.runRepository ?? noopCoreJobRunRepository;
  }

  private now() {
    const clock = this.options.clock;
    return clock ? (typeof clock === 'function' ? clock() : clock.now()) : new Date();
  }

  private wait(durationMs: number, signal?: AbortSignal) {
    return (this.options.wait ?? wait)(durationMs, signal);
  }

  private createRunId() {
    return this.options.createRunId?.() ?? randomUUID();
  }
}

export class CoreJobTimeoutError extends Error {
  readonly code = 'CORE_JOB_TIMEOUT';

  constructor(jobId: string, timeoutMs: number) {
    super(`Job ${jobId} exceeded ${timeoutMs}ms`);
    this.name = 'CoreJobTimeoutError';
  }
}

export function createCoreJobRuntime(options: CoreJobRuntimeOptions = {}) {
  return new CoreJobRuntime(options);
}

export function validateCoreJobDefinition(job: CoreJobDefinition) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(job.id)) {
    throw new CoreJobRegistryError('INVALID_JOB_ID', `Job ID 必须是稳定 kebab-case: ${job.id}`);
  }

  if (!job.title.trim()) {
    throw new CoreJobRegistryError('MISSING_JOB_TITLE', `Job 缺少标题: ${job.id}`);
  }

  if (job.maxAttempts !== undefined && (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 1)) {
    throw new CoreJobRegistryError('INVALID_MAX_ATTEMPTS', `Job maxAttempts 必须大于 0: ${job.id}`);
  }

  if (job.timeoutMs !== undefined && (!Number.isInteger(job.timeoutMs) || job.timeoutMs < 1)) {
    throw new CoreJobRegistryError('INVALID_TIMEOUT', `Job timeoutMs 必须大于 0: ${job.id}`);
  }

  if (job.retryDelayMs !== undefined && (!Number.isInteger(job.retryDelayMs) || job.retryDelayMs < 0)) {
    throw new CoreJobRegistryError('INVALID_RETRY_DELAY', `Job retryDelayMs 不能小于 0: ${job.id}`);
  }
}

export function createMemoryCoreJobRunRepository(seed: readonly CoreJobRunRecord[] = []) {
  const records = new Map<string, CoreJobRunRecord>();

  for (const record of seed) {
    records.set(record.runId, record);
  }

  const repository: CoreJobRunRepository & { records(): CoreJobRunRecord[] } = {
    async startRun(input) {
      records.set(input.runId, {
        runId: input.runId,
        jobId: input.jobId,
        attempt: input.attempt,
        status: 'running',
        startedAt: input.startedAt.toISOString(),
        idempotencyKey: input.idempotencyKey
      });
    },
    async finishRun(input) {
      const record = records.get(input.runId);

      if (!record) {
        throw new CoreJobRegistryError('UNKNOWN_RUN_ID', `Job run 不存在: ${input.runId}`);
      }

      records.set(input.runId, {
        ...record,
        status: input.status,
        finishedAt: input.finishedAt.toISOString(),
        durationMs: input.durationMs,
        skipReason: input.skipReason,
        errorMessage: input.errorMessage
      });
    },
    records() {
      return [...records.values()];
    }
  };

  return repository;
}

export function createPostgresCoreJobRunRepository(client: QueryableClient): CoreJobRunRepository {
  return {
    async startRun(input) {
      await client.query(
        `
          INSERT INTO core_job_runs (id, job_id, attempt, idempotency_key, status, started_at)
          VALUES ($1, $2, $3, $4, 'running', $5)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          input.runId,
          input.jobId,
          input.attempt,
          input.idempotencyKey ?? null,
          input.startedAt.toISOString()
        ]
      );
    },
    async finishRun(input) {
      await client.query(
        `
          UPDATE core_job_runs
          SET status = $2,
              finished_at = $3,
              duration_ms = $4,
              skip_reason = $5,
              error_message = $6,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          input.runId,
          input.status,
          input.finishedAt.toISOString(),
          input.durationMs,
          input.skipReason ?? null,
          input.errorMessage ?? null
        ]
      );
    }
  };
}

export function createPostgresAdvisoryJobLockProvider(client: QueryableClient): CoreJobLockProvider {
  return {
    async acquire(job) {
      if (job.advisoryLockKey === undefined) {
        return {
          release: async () => {}
        };
      }

      const result = await client.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [job.advisoryLockKey]
      ) as { rows?: Array<{ locked?: boolean }> };
      const locked = Boolean(result.rows?.[0]?.locked);

      if (!locked) {
        return null;
      }

      return {
        release: async () => {
          await client.query('SELECT pg_advisory_unlock($1)', [job.advisoryLockKey]);
        }
      };
    }
  };
}

const noopCoreJobRunRepository: CoreJobRunRepository = {
  async startRun() {},
  async finishRun() {}
};

function wait(durationMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new Error('CORE_JOB_ABORTED'));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, durationMs);

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeShutdownTimeoutMs(value: number | undefined) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 30_000;
}
