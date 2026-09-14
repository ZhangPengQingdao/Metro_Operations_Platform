import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  CORE_JOB_RUNS_TABLE_SQL,
  CoreJobRegistryError,
  CoreJobTimeoutError,
  createCoreJobRuntime,
  createMemoryCoreJobRunRepository,
  createPostgresAdvisoryJobLockProvider
} from '../src/core/jobs/index.ts';

class FakeClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  constructor(private readonly locked: boolean) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });

    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: this.locked }] };
    }

    return { rows: [] };
  }
}

function fixedClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 30, 2, 0, tick++));
}

function runIdFactory() {
  let next = 0;
  return () => `run-${++next}`;
}

test('Core Jobs validates job IDs and rejects duplicate registrations', () => {
  const runtime = createCoreJobRuntime();
  runtime.register({
    id: 'good-job',
    title: 'Good job',
    run: async () => {}
  });

  assert.throws(
    () => runtime.register({ id: 'good-job', title: 'Duplicate job', run: async () => {} }),
    /重复的 Job ID/
  );

  assert.throws(
    () => createCoreJobRuntime().register({ id: 'bad_job', title: 'Bad job', run: async () => {} }),
    /稳定 kebab-case/
  );

  assert.throws(
    () => createCoreJobRuntime().register({ id: 'bad-timeout', title: 'Bad timeout', timeoutMs: 0, run: async () => {} }),
    CoreJobRegistryError
  );
});

test('Core Jobs records successful runs with stable idempotency metadata', async () => {
  const repository = createMemoryCoreJobRunRepository();
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    clock: fixedClock(),
    createRunId: runIdFactory()
  }).register({
    id: 'daily-sweep',
    title: 'Daily sweep',
    idempotencyKey: 'daily-sweep:2026-08-30',
    run: async () => {}
  });

  const outcome = await runtime.run('daily-sweep');
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(outcome.runIds, ['run-1']);
  assert.deepEqual(repository.records(), [
    {
      runId: 'run-1',
      jobId: 'daily-sweep',
      attempt: 1,
      status: 'succeeded',
      startedAt: '2026-08-30T02:00:00.000Z',
      idempotencyKey: 'daily-sweep:2026-08-30',
      finishedAt: '2026-08-30T02:00:01.000Z',
      durationMs: 1000,
      skipReason: undefined,
      errorMessage: undefined
    }
  ]);
});

test('Core Jobs skips duplicate in-process runs instead of overlapping a scheduler tick', async () => {
  const repository = createMemoryCoreJobRunRepository();
  let releaseJob!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    releaseJob = resolve;
  });
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    createRunId: runIdFactory()
  }).register({
    id: 'singleton-sweep',
    title: 'Singleton sweep',
    run: async () => firstRun
  });

  const running = runtime.run('singleton-sweep');
  const duplicate = await runtime.run('singleton-sweep');
  releaseJob();
  const completed = await running;

  assert.equal(duplicate.status, 'skipped');
  assert.equal(duplicate.skipReason, 'duplicate-instance');
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(repository.records().map((record) => [record.jobId, record.attempt, record.status, record.skipReason]), [
    ['singleton-sweep', 1, 'succeeded', undefined],
    ['singleton-sweep', 0, 'skipped', 'duplicate-instance']
  ]);
});

test('Core Jobs retries failed work and dead-letters the final failed attempt', async () => {
  const repository = createMemoryCoreJobRunRepository();
  let attempts = 0;
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    wait: async () => {},
    createRunId: runIdFactory()
  }).register({
    id: 'retrying-job',
    title: 'Retrying job',
    maxAttempts: 3,
    retryDelayMs: 10,
    async run() {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`fail-${attempts}`);
      }
    }
  });

  const outcome = await runtime.run('retrying-job');

  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(repository.records().map((record) => [record.attempt, record.status, record.errorMessage]), [
    [1, 'failed', 'fail-1'],
    [2, 'failed', 'fail-2'],
    [3, 'succeeded', undefined]
  ]);
});

test('Core Jobs records timeout failures as dead-letter when retries are exhausted', async () => {
  const repository = createMemoryCoreJobRunRepository();
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    createRunId: runIdFactory()
  }).register({
    id: 'timeout-job',
    title: 'Timeout job',
    timeoutMs: 1,
    run: async () => new Promise((resolve) => setTimeout(resolve, 30))
  });

  const outcome = await runtime.run('timeout-job');

  assert.equal(outcome.status, 'dead_letter');
  assert.match(outcome.errorMessage ?? '', /exceeded 1ms/);
  assert.equal(repository.records()[0].status, 'dead_letter');
  assert.match(repository.records()[0].errorMessage ?? '', /exceeded 1ms/);
  assert.equal(new CoreJobTimeoutError('timeout-job', 1).code, 'CORE_JOB_TIMEOUT');
});

test('Core Jobs uses advisory lock provider to skip another active process', async () => {
  const lockedClient = new FakeClient(true);
  const skippedClient = new FakeClient(false);

  const lockedRuntime = createCoreJobRuntime({
    lockProvider: createPostgresAdvisoryJobLockProvider(lockedClient),
    createRunId: runIdFactory()
  }).register({
    id: 'locked-job',
    title: 'Locked job',
    advisoryLockKey: 123,
    run: async () => {}
  });
  const skippedRuntime = createCoreJobRuntime({
    lockProvider: createPostgresAdvisoryJobLockProvider(skippedClient),
    createRunId: runIdFactory()
  }).register({
    id: 'locked-job',
    title: 'Locked job',
    advisoryLockKey: 123,
    run: async () => {}
  });

  assert.equal((await lockedRuntime.run('locked-job')).status, 'succeeded');
  assert.equal((await skippedRuntime.run('locked-job')).skipReason, 'advisory-lock-unavailable');
  assert.deepEqual(lockedClient.queries.map((query) => query.text.trim()), [
    'SELECT pg_try_advisory_lock($1) AS locked',
    'SELECT pg_advisory_unlock($1)'
  ]);
});

test('Core Jobs gracefully stops intervals, aborts running work, and waits for cleanup', async () => {
  const repository = createMemoryCoreJobRunRepository();
  let started!: () => void;
  let releaseLock!: () => void;
  let lockReleaseStarted!: () => void;
  const runningStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const lockReleaseGate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lockReleaseStartedPromise = new Promise<void>((resolve) => {
    lockReleaseStarted = resolve;
  });
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    createRunId: runIdFactory(),
    lockProvider: {
      acquire: async () => ({
        release: async () => {
          lockReleaseStarted();
          await lockReleaseGate;
        }
      })
    }
  }).register({
    id: 'stoppable-job',
    title: 'Stoppable job',
    intervalMs: 60_000,
    advisoryLockKey: 99,
    run: async ({ signal }) => {
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  });

  const handle = runtime.startInterval('stoppable-job', { runImmediately: false });
  handle.stop();
  const running = runtime.run('stoppable-job');
  await runningStarted;
  const shutdownPromise = runtime.stop();
  await lockReleaseStartedPromise;
  let shutdownSettled = false;
  void shutdownPromise.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  assert.equal(shutdownSettled, false);
  releaseLock();
  const shutdown = await shutdownPromise;
  const cancelled = await running;

  assert.deepEqual(shutdown, { drained: true, remaining: 0 });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(repository.records()[0].status, 'cancelled');
  const outcome = await runtime.run('stoppable-job');
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.skipReason, 'runtime-stopped');
});

test('Core Jobs bounds shutdown when work ignores cancellation', async () => {
  let started!: () => void;
  const runningStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = createCoreJobRuntime({ shutdownTimeoutMs: 1 }).register({
    id: 'uncooperative-job',
    title: 'Uncooperative job',
    run: async () => {
      started();
      await new Promise<void>(() => {});
    }
  });

  void runtime.run('uncooperative-job');
  await runningStarted;

  assert.deepEqual(await runtime.stop(), { drained: false, remaining: 1 });
});

test('Core Jobs cancels a pending retry during shutdown without starting another attempt', async () => {
  const repository = createMemoryCoreJobRunRepository();
  let retryStarted!: () => void;
  const waitingToRetry = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  let attempts = 0;
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    createRunId: runIdFactory(),
    wait: async (_durationMs, signal) => {
      retryStarted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  }).register({
    id: 'retry-cancel-job',
    title: 'Retry cancellation job',
    maxAttempts: 2,
    retryDelayMs: 60_000,
    run: async () => {
      attempts += 1;
      throw new Error('retry later');
    }
  });

  const running = runtime.run('retry-cancel-job');
  await waitingToRetry;
  const shutdown = await runtime.stop();
  const outcome = await running;

  assert.deepEqual(shutdown, { drained: true, remaining: 0 });
  assert.equal(outcome.status, 'cancelled');
  assert.equal(attempts, 1);
  assert.equal(repository.records()[0].status, 'cancelled');
});

test('Core Jobs publishes the PostgreSQL run-record schema contract', () => {
  assert.match(CORE_JOB_RUNS_TABLE_SQL, /CREATE TABLE IF NOT EXISTS core_job_runs/);
  assert.match(CORE_JOB_RUNS_TABLE_SQL, /job_id text NOT NULL/);
  assert.match(CORE_JOB_RUNS_TABLE_SQL, /core_job_runs_idempotency_key_idx/);
});
