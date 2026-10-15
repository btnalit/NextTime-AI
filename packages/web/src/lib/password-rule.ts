import type { Translate } from './i18n.js';

/** The kernel's own bounds (`application/identity/password.ts` `MIN_PASSWORD_LENGTH` /
 *  `MAX_PASSWORD_LENGTH`). The platform setting `passwordMinLength` can only raise the minimum
 *  (validated >= 8), and the kernel still enforces and explains a higher one; 8 is the floor every
 *  form can check before a round trip (console audit P1-2). */
export const PASSWORD_MIN_FLOOR = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** Why a typed new password cannot be used, or `null` when its length is fine (or nothing is typed
 *  yet — an empty field is "still needed", not an error). */
export function passwordLengthProblem(password: string, t: Translate): string | null {
  if (password.length === 0) return null;
  if (password.length < PASSWORD_MIN_FLOOR) {
    return t(
      `密码太短：当前 ${password.length} 位，至少需要 ${PASSWORD_MIN_FLOOR} 位。`,
      `Password too short: ${password.length} characters, at least ${PASSWORD_MIN_FLOOR} are needed.`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return t(
      `密码太长：当前 ${password.length} 位，最多 ${PASSWORD_MAX_LENGTH} 位。`,
      `Password too long: ${password.length} characters, at most ${PASSWORD_MAX_LENGTH}.`,
    );
  }
  return null;
}

/** The new-password field's hint, the same on every form that sets one. */
export function passwordLengthHint(t: Translate): string {
  return t(
    `至少 ${PASSWORD_MIN_FLOOR} 位（平台要求更长时以平台为准）`,
    `At least ${PASSWORD_MIN_FLOOR} characters (a longer platform minimum applies if set)`,
  );
}

/** A 还差 line item for a password whose length is wrong (pair with `passwordLengthProblem`). */
export function passwordLengthNeed(password: string, t: Translate): string {
  return password.length > PASSWORD_MAX_LENGTH
    ? t(
        `密码最多 ${PASSWORD_MAX_LENGTH} 位`,
        `keep the password to ${PASSWORD_MAX_LENGTH} characters`,
      )
    : t(
        `密码至少 ${PASSWORD_MIN_FLOOR} 位`,
        `make the password at least ${PASSWORD_MIN_FLOOR} characters`,
      );
}
