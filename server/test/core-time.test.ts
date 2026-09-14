import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoreJobRuntime, createMemoryCoreJobRunRepository } from '../src/core/jobs/index.ts';
import {
  FixedClock,
  PLATFORM_TIME_ZONE,
  PlatformTimeError,
  SystemClock,
  getPlatformDateKey,
  getPlatformDateTime,
  getPlatformMinuteOfDay,
  getPlatformNow,
  toPlatformInstant
} from '../src/core/time/index.ts';

test('Core Time fixes the platform timezone independently of the host TZ', () => {
  const previous = process.env.TZ;
  try {
    const instant = new Date('2026-08-31T16:30:45.123Z');
    const results = ['UTC', 'America/New_York', 'Europe/London'].map((timeZone) => {
      process.env.TZ = timeZone;
      return getPlatformDateTime(instant);
    });
    assert.equal(PLATFORM_TIME_ZONE, 'Asia/Shanghai');
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.deepEqual(results[0], {
      year: 2026, month: 9, day: 1, hour: 0, minute: 30, second: 45,
      millisecond: 123, isoWeekday: 2
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('Core Time converts platform local date-time to the exact UTC instant', () => {
  const instant = toPlatformInstant({ year: 2026, month: 9, day: 1, hour: 0, minute: 30, second: 45, millisecond: 123 });
  assert.equal(instant.toISOString(), '2026-08-31T16:30:45.123Z');
  assert.equal(getPlatformDateKey(instant), '2026-09-01');
  assert.equal(getPlatformMinuteOfDay(instant), 30);
});

test('Core Time validates month ends, leap years, and invalid inputs', () => {
  assert.equal(toPlatformInstant({ year: 2024, month: 2, day: 29 }).toISOString(), '2024-02-28T16:00:00.000Z');
  assert.equal(toPlatformInstant({ year: 2026, month: 12, day: 31, hour: 23, minute: 59 }).toISOString(), '2026-12-31T15:59:00.000Z');
  for (const input of [
    { year: 2025, month: 2, day: 29 },
    { year: 2026, month: 4, day: 31 },
    { year: 2026, month: 13, day: 1 },
    { year: 2026, month: 1, day: 1, hour: 24 }
  ]) {
    assert.throws(() => toPlatformInstant(input), (error: unknown) => error instanceof PlatformTimeError && error.code === 'INVALID_LOCAL_DATE_TIME');
  }
  assert.throws(() => getPlatformDateTime(new Date('invalid')), (error: unknown) => error instanceof PlatformTimeError && error.code === 'INVALID_INSTANT');
});

test('FixedClock returns immutable snapshots and supports deterministic advancement', () => {
  const clock = new FixedClock(new Date('2026-08-31T16:00:00.000Z'));
  const first = clock.now();
  first.setUTCFullYear(2030);
  assert.equal(clock.now().toISOString(), '2026-08-31T16:00:00.000Z');
  assert.equal(clock.advanceBy(90_000).toISOString(), '2026-08-31T16:01:30.000Z');
  assert.equal(clock.set(new Date('2024-02-29T00:00:00.000Z')).toISOString(), '2024-02-29T00:00:00.000Z');
  assert.throws(() => clock.advanceBy(-1), (error: unknown) => error instanceof PlatformTimeError && error.code === 'INVALID_DURATION');
  assert.throws(() => clock.advanceBy(Number.MAX_SAFE_INTEGER), (error: unknown) => error instanceof PlatformTimeError && error.code === 'INVALID_INSTANT');
});

test('getPlatformNow reads one PlatformClock contract', () => {
  const value = getPlatformNow(new FixedClock(new Date('2026-08-31T16:30:00.000Z')));
  assert.equal(value.instant.toISOString(), '2026-08-31T16:30:00.000Z');
  assert.equal(value.dateKey, '2026-09-01');
  assert.equal(value.minuteOfDay, 30);
});

test('SystemClock returns a fresh valid instant', () => {
  const clock = new SystemClock();
  const before = Date.now();
  const first = clock.now();
  const second = clock.now();
  assert.notEqual(first, second);
  assert.equal(first.getTime() >= before && first.getTime() <= Date.now(), true);
});

test('Core Jobs consumes PlatformClock without breaking function clocks', async () => {
  const repository = createMemoryCoreJobRunRepository();
  const clock = new FixedClock(new Date('2026-09-01T00:00:00.000Z'));
  let runSequence = 0;
  const runtime = createCoreJobRuntime({
    runRepository: repository,
    clock,
    createRunId: () => `run-${++runSequence}`
  }).register({ id: 'time-consumer', title: 'Time consumer', run: async () => { clock.advanceBy(1_000); } });

  assert.equal((await runtime.run('time-consumer')).status, 'succeeded');
  assert.deepEqual(repository.records()[0], {
    runId: 'run-1', jobId: 'time-consumer', attempt: 1, status: 'succeeded',
    startedAt: '2026-09-01T00:00:00.000Z', idempotencyKey: undefined,
    finishedAt: '2026-09-01T00:00:01.000Z', durationMs: 1000,
    skipReason: undefined, errorMessage: undefined
  });
});
