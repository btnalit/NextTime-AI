import type { Translate } from './i18n.js';

/**
 * Legacy 351: an approve / reject `reason` is typed by a person and shown back verbatim (pre-wrap)
 * on every approval surface, with no limit on the wire. The console caps what it lets a person
 * type here — the same 1000 characters a failure reason is cut to — so one reason cannot turn an
 * approval page into a wall of text; displays pass it through `visibleLines`, so a control
 * character shows as its escape rather than disappearing.
 */
export const DECISION_REASON_MAX_LENGTH = 1000;

/** How near the cap the count starts showing (#661 UX acceptance P3: a pasted reason was cut at
 *  the cap with nothing said). */
const DECISION_REASON_COUNT_FROM = 900;

/** The line under a reason box once it nears the cap — what is left, or that the cap was reached
 *  (a paste past it is cut by `maxLength`). `null` while the reason is short. */
export function decisionReasonCountText(length: number, t: Translate): string | null {
  if (length < DECISION_REASON_COUNT_FROM) return null;
  if (length >= DECISION_REASON_MAX_LENGTH) {
    return t(
      `已达 ${DECISION_REASON_MAX_LENGTH} 字上限，超出的部分没有填进来。`,
      `Reached the ${DECISION_REASON_MAX_LENGTH}-character limit; anything past it was not entered.`,
    );
  }
  const left = DECISION_REASON_MAX_LENGTH - length;
  return t(
    `还能输入 ${left} 字（上限 ${DECISION_REASON_MAX_LENGTH}）。`,
    `${left} characters left (limit ${DECISION_REASON_MAX_LENGTH}).`,
  );
}
