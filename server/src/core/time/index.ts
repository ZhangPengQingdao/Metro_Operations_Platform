export const PLATFORM_TIME_ZONE = 'Asia/Shanghai' as const;

export interface PlatformClock {
  now(): Date;
}

export interface PlatformLocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface PlatformLocalDateTimeInput {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export class PlatformTimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformTimeError';
    this.code = code;
  }
}

export class SystemClock implements PlatformClock {
  now() {
    return new Date();
  }
}

export class FixedClock implements PlatformClock {
  private epochMilliseconds: number;

  constructor(initial: Date) {
    this.epochMilliseconds = validInstant(initial, 'fixed clock initial time').getTime();
  }

  now() {
    return new Date(this.epochMilliseconds);
  }

  set(instant: Date) {
    this.epochMilliseconds = validInstant(instant, 'fixed clock time').getTime();
    return this.now();
  }

  advanceBy(milliseconds: number) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new PlatformTimeError('INVALID_DURATION', '推进时长必须是非负安全整数毫秒');
    }
    const nextEpochMilliseconds = this.epochMilliseconds + milliseconds;
    if (!Number.isSafeInteger(nextEpochMilliseconds)) {
      throw new PlatformTimeError('INVALID_INSTANT', '推进后的时间超出安全范围');
    }
    this.epochMilliseconds = validInstant(new Date(nextEpochMilliseconds), 'advanced fixed clock time').getTime();
    return this.now();
  }
}

export const systemClock: PlatformClock = new SystemClock();

const platformFormatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601', {
  timeZone: PLATFORM_TIME_ZONE,
  calendar: 'iso8601',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function getPlatformDateTime(instant: Date): PlatformLocalDateTime {
  const value = validInstant(instant, 'instant');
  const parts = Object.fromEntries(
    platformFormatter.formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  ) as Record<string, number>;
  const year = requiredPart(parts, 'year');
  const month = requiredPart(parts, 'month');
  const day = requiredPart(parts, 'day');
  return {
    year,
    month,
    day,
    hour: requiredPart(parts, 'hour'),
    minute: requiredPart(parts, 'minute'),
    second: requiredPart(parts, 'second'),
    millisecond: value.getUTCMilliseconds(),
    isoWeekday: isoWeekday(year, month, day)
  };
}

export function getPlatformDateKey(instant: Date) {
  const value = getPlatformDateTime(instant);
  return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}`;
}

export function getPlatformMinuteOfDay(instant: Date) {
  const value = getPlatformDateTime(instant);
  return value.hour * 60 + value.minute;
}

export function getPlatformNow(clock: PlatformClock = systemClock) {
  const instant = validInstant(clock.now(), 'clock time');
  return {
    instant,
    localDateTime: getPlatformDateTime(instant),
    dateKey: getPlatformDateKey(instant),
    minuteOfDay: getPlatformMinuteOfDay(instant)
  };
}

export function toPlatformInstant(input: PlatformLocalDateTimeInput): Date {
  const local = normalizeLocalDateTime(input);
  const intendedEpoch = utcEpoch(local);
  let candidateEpoch = intendedEpoch - offsetAt(new Date(intendedEpoch));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const corrected = intendedEpoch - offsetAt(new Date(candidateEpoch));
    if (corrected === candidateEpoch) break;
    candidateEpoch = corrected;
  }

  const candidate = validInstant(new Date(candidateEpoch), 'platform instant');
  const actual = getPlatformDateTime(candidate);
  if (!sameLocalDateTime(local, actual)) {
    throw new PlatformTimeError('INVALID_LOCAL_DATE_TIME', '平台本地日期时间无法转换为有效时间点');
  }
  return candidate;
}

function normalizeLocalDateTime(input: PlatformLocalDateTimeInput) {
  const normalized = {
    year: integerInRange(input.year, 1, 9999, 'year'),
    month: integerInRange(input.month, 1, 12, 'month'),
    day: integerInRange(input.day, 1, 31, 'day'),
    hour: integerInRange(input.hour ?? 0, 0, 23, 'hour'),
    minute: integerInRange(input.minute ?? 0, 0, 59, 'minute'),
    second: integerInRange(input.second ?? 0, 0, 59, 'second'),
    millisecond: integerInRange(input.millisecond ?? 0, 0, 999, 'millisecond')
  };
  if (normalized.day > daysInMonth(normalized.year, normalized.month)) {
    throw new PlatformTimeError('INVALID_LOCAL_DATE_TIME', '平台本地日期不存在');
  }
  return normalized;
}

function validInstant(value: Date, label: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PlatformTimeError('INVALID_INSTANT', `${label} 必须是有效 Date`);
  }
  return new Date(value.getTime());
}

function offsetAt(instant: Date) {
  const local = getPlatformDateTime(instant);
  return utcEpoch(local) - instant.getTime();
}

function utcEpoch(input: Omit<PlatformLocalDateTime, 'isoWeekday'> | PlatformLocalDateTimeInput) {
  const value = new Date(0);
  value.setUTCFullYear(input.year, input.month - 1, input.day);
  value.setUTCHours(input.hour ?? 0, input.minute ?? 0, input.second ?? 0, input.millisecond ?? 0);
  return value.getTime();
}

function daysInMonth(year: number, month: number) {
  const value = new Date(0);
  value.setUTCFullYear(year, month, 0);
  value.setUTCHours(0, 0, 0, 0);
  return value.getUTCDate();
}

function isoWeekday(year: number, month: number, day: number): PlatformLocalDateTime['isoWeekday'] {
  const weekday = new Date(utcEpoch({ year, month, day })).getUTCDay();
  return (weekday === 0 ? 7 : weekday) as PlatformLocalDateTime['isoWeekday'];
}

function sameLocalDateTime(
  expected: ReturnType<typeof normalizeLocalDateTime>,
  actual: PlatformLocalDateTime
) {
  return expected.year === actual.year
    && expected.month === actual.month
    && expected.day === actual.day
    && expected.hour === actual.hour
    && expected.minute === actual.minute
    && expected.second === actual.second
    && expected.millisecond === actual.millisecond;
}

function integerInRange(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PlatformTimeError('INVALID_LOCAL_DATE_TIME', `${label} 必须是 ${minimum} 到 ${maximum} 的整数`);
  }
  return value;
}

function requiredPart(parts: Record<string, number>, key: string) {
  const value = parts[key];
  if (!Number.isSafeInteger(value)) {
    throw new PlatformTimeError('TIME_ZONE_UNAVAILABLE', `Intl 未返回 ${PLATFORM_TIME_ZONE} 的 ${key}`);
  }
  return value;
}

function pad(value: number, length = 2) {
  return String(value).padStart(length, '0');
}
