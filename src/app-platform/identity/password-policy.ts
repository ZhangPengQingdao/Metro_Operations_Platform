export const PASSWORD_POLICY_MESSAGE = '密码至少 8 位，须包含大写字母、小写字母、数字、特殊符号中的至少三类，且不超过 72 字节。';

const CATEGORIES = [
 { id: 'upper', label: '大写字母', pattern: /[A-Z]/ },
 { id: 'lower', label: '小写字母', pattern: /[a-z]/ },
 { id: 'digit', label: '数字', pattern: /[0-9]/ },
 { id: 'symbol', label: '特殊符号', pattern: /[\p{P}\p{S}]/u },
] as const;

export interface PasswordCheck { length: boolean; bytes: boolean; categories: { id: string; label: string; ok: boolean }[]; categoryCount: number; categoriesOk: boolean }

/** Each policy rule evaluated separately, for live feedback while typing. */
export function passwordChecks(value: string): PasswordCheck {
 const categories = CATEGORIES.map(({ id, label, pattern }) => ({ id, label, ok: pattern.test(value) }));
 const categoryCount = categories.filter(item => item.ok).length;
 return { length: Array.from(value).length >= 8, bytes: new TextEncoder().encode(value).length <= 72, categories, categoryCount, categoriesOk: categoryCount >= 3 };
}

export function isPasswordCompliant(value: string): boolean {
 const check = passwordChecks(value);
 return check.length && check.bytes && check.categoriesOk;
}
