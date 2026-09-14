/**
 * Platform - Shared Engineering Validation & Masking Utilities (PLATFORM-L2-004)
 * 纯净校验与脱敏工具，100% 纯计算，无任何业务依赖。
 */

/**
 * 校验中国大陆 11 位手机号格式
 */
export function isPhone(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^1[3-9]\d{9}$/.test(value.trim());
}

/**
 * 校验中国大陆 18 位第二代居民身份证号码格式及校验码
 */
export function isIdCard(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  const id = value.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;

  // 校验权重系数与对应校验码
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(id[i], 10) * weights[i];
  }
  const mod = sum % 11;
  return checkCodes[mod] === id[17];
}

/**
 * 校验电子邮箱地址格式
 */
export function isEmail(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value.trim());
}

/**
 * 校验 HTTP/HTTPS URL 格式
 */
export function isUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 校验非空字符串
 */
export function isNonEmptyString(value: any): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 手机号脱敏掩码（如 138****1234）
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  if (trimmed.length !== 11) return trimmed;
  return trimmed.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

/**
 * 身份证号码脱敏掩码（如 3702**********1234）
 */
export function maskIdCard(idCard: string | null | undefined): string {
  if (!idCard || typeof idCard !== 'string') return '';
  const trimmed = idCard.trim();
  if (trimmed.length !== 18) return trimmed;
  return trimmed.replace(/^(\d{4})\d{10}(\w{4})$/, '$1**********$2');
}

/**
 * 姓名脱敏掩码（如 张* 或 张*鹏）
 */
export function maskName(name: string | null | undefined): string {
  if (!name || typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed;
  if (trimmed.length === 2) return `${trimmed[0]}*`;
  return `${trimmed[0]}${'*'.repeat(trimmed.length - 2)}${trimmed[trimmed.length - 1]}`;
}
