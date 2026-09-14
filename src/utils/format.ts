/**
 * Platform - Shared Engineering Formatting Utilities (PLATFORM-L2-004)
 * 纯净格式化与解析工具，100% 纯计算，无任何业务依赖。
 */

/**
 * 格式化相对时间（如“刚刚”、“5分钟前”、“昨天”、“3天前”）
 */
export function formatRelativeTime(
  dateInput: Date | string | number | null | undefined,
  baseDate: Date = new Date()
): string {
  if (!dateInput) return '-';

  const date = typeof dateInput === 'object' ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime())) return '-';

  const diffMs = baseDate.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const isFuture = diffSec < 0;
  const absSec = Math.abs(diffSec);

  if (absSec < 45) {
    return '刚刚';
  }

  const absMin = Math.floor(absSec / 60);
  if (absMin < 60) {
    return isFuture ? `${absMin}分钟后` : `${absMin}分钟前`;
  }

  const absHour = Math.floor(absMin / 60);
  if (absHour < 24) {
    return isFuture ? `${absHour}小时后` : `${absHour}小时前`;
  }

  const absDays = Math.floor(absHour / 24);
  if (absDays === 1) {
    return isFuture ? '明天' : '昨天';
  }
  if (absDays === 2) {
    return isFuture ? '后天' : '前天';
  }
  if (absDays < 30) {
    return isFuture ? `${absDays}天后` : `${absDays}天前`;
  }

  const absMonths = Math.floor(absDays / 30);
  if (absMonths < 12) {
    return isFuture ? `${absMonths}个月后` : `${absMonths}个月前`;
  }

  const absYears = Math.floor(absDays / 365);
  return isFuture ? `${absYears}年后` : `${absYears}年前`;
}

/**
 * 格式化字节大小为人类可读格式（B / KB / MB / GB / TB）
 */
export function formatFileSize(bytes: number, decimals: number = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const safeIndex = Math.min(i, sizes.length - 1);
  const value = parseFloat((bytes / Math.pow(k, safeIndex)).toFixed(dm));

  return `${value} ${sizes[safeIndex]}`;
}

/**
 * 格式化时长（秒数转为 时:分:秒 或 中文格式）
 */
export function formatDuration(
  seconds: number,
  format: 'colon' | 'chinese' = 'colon'
): string {
  if (!Number.isFinite(seconds) || seconds < 0) return format === 'colon' ? '00:00' : '0秒';

  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (format === 'chinese') {
    const parts: string[] = [];
    if (hrs > 0) parts.push(`${hrs}小时`);
    if (mins > 0) parts.push(`${mins}分`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    return parts.join('');
  }

  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

/**
 * 安全解析 JSON 字符串，解析失败时返回默认备选值，绝不抛出运行时异常
 */
export function safeJsonParse<T>(
  jsonStr: string | null | undefined,
  fallback: T
): T {
  if (jsonStr === null || jsonStr === undefined || jsonStr.trim() === '') {
    return fallback;
  }
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    return fallback;
  }
}

/**
 * 安全格式化 JSON 字符串
 */
export function safeJsonStringify(
  value: any,
  fallback: string = '{}',
  space?: number
): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return fallback;
  }
}

/**
 * 将数值约束在指定区间内
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 格式化千分位数字
 */
export function formatNumber(
  value: number | string | null | undefined,
  decimals?: number
): string {
  if (value === null || value === undefined || value === '') return '-';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '-';

  if (decimals !== undefined) {
    return num.toLocaleString('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }
  return num.toLocaleString('zh-CN');
}
