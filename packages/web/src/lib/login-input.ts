import type { Translate } from './i18n.js';
import { LOGIN_PATTERN } from './platform-errors.js';

/** The kernel's `normalizeLogin` (identity/users.ts) trims and lower-cases before it checks the
 *  pattern; the client does the same so "Alice " is accepted as "alice" instead of refused. */
export function normalizeLoginInput(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The login rule in one sentence — shown as the field hint and repeated in every error. */
export function loginRuleText(t: Translate): string {
  return t(
    '3–64 位，由小写字母、数字、. _ - 组成，且以字母或数字开头（大写会自动转成小写）。',
    '3–64 characters: lowercase letters, digits, . _ -, starting with a letter or digit (uppercase is lowercased for you).',
  );
}

/** `null` when the (already normalized) login is valid or still empty; otherwise a message that
 *  names what is wrong and the allowed values (the rule itself stays visible as the field hint). */
export function loginError(normalized: string, t: Translate): string | null {
  if (normalized.length === 0 || LOGIN_PATTERN.test(normalized)) return null;
  if (normalized.length < 3) {
    return t(
      `登录名格式不合法：当前只有 ${normalized.length} 位，至少需要 3 位（3–64 位）。`,
      `Invalid login: only ${normalized.length} character(s); at least 3 are needed (3–64).`,
    );
  }
  if (normalized.length > 64) {
    return t(
      `登录名格式不合法：当前 ${normalized.length} 位，最多 64 位（3–64 位）。`,
      `Invalid login: ${normalized.length} characters; at most 64 are allowed (3–64).`,
    );
  }
  const bad = [...new Set(normalized.match(/[^a-z0-9._-]/g) ?? [])];
  if (bad.length > 0) {
    return t(
      `登录名格式不合法：不能包含「${bad.join('')}」，只允许小写字母、数字、. _ -。`,
      `Invalid login: "${bad.join('')}" is not allowed; use only lowercase letters, digits, . _ -.`,
    );
  }
  return t(
    '登录名格式不合法：必须以字母或数字开头，不能以 . _ - 开头。',
    'Invalid login: it must start with a letter or digit, not . _ -.',
  );
}

/** "将保存为 alice" feedback — only when normalization actually changed what was typed. */
export function loginNormalizedNote(raw: string, t: Translate): string | null {
  const normalized = normalizeLoginInput(raw);
  if (normalized.length === 0 || normalized === raw || loginError(normalized, t) !== null) {
    return null;
  }
  return t(`将保存为 ${normalized}`, `Will be saved as ${normalized}`);
}
