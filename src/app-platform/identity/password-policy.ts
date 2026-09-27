export const PASSWORD_POLICY_MESSAGE = '密码至少 8 位，须包含大写字母、小写字母、数字、特殊符号中的至少三类，且不超过 72 字节。';

export function isPasswordCompliant(value: string): boolean {
 const categories = [/[A-Z]/, /[a-z]/, /[0-9]/, /[\p{P}\p{S}]/u];
 return Array.from(value).length >= 8 && new TextEncoder().encode(value).length <= 72
  && categories.filter(pattern => pattern.test(value)).length >= 3;
}
