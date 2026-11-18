import type { Translate } from './i18n.js';

/**
 * lib/name-input (#1476 follow-up, legacy 309): the console side of the caps the kernel now puts
 * on the names a caller gives new things (`packages/shared/src/name-limits.ts`). The kernel counts
 * as Zod's `.max()` does — UTF-16 code units of the string it is sent — and the forms send the
 * trimmed text, so that is what is counted here. A name over the cap is not cut: the field says
 * how far over it is and the form's submit waits, the same as a goal note past its cap.
 */

/** How many characters the trimmed name is past `max`; `0` when it fits. */
export function nameOverflow(name: string, max: number): number {
  return Math.max(0, name.trim().length - max);
}

/** The field error for a name `over` characters past `max`; `null` when it fits. */
export function nameTooLongText(over: number, max: number, t: Translate): string | null {
  if (over <= 0) return null;
  return t(
    `最多 ${max} 个字符，现在多了 ${over} 个。`,
    `At most ${max} characters; this is ${over} over.`,
  );
}
