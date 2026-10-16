import { clipCodePoints, visibleText } from '@nexttime/shared';
import { redactSuspectedSecrets } from '../redaction/index.js';

/**
 * governance/approval/shown-reason (legacy 338, review #493 on #609): how a reason the kernel
 * audited for an ActionRequest is shown — the failure reason on the wire (`failureReason`, legacy
 * 329), the in-doubt reason (`outcomeInDoubt.reason`, legacy 287) and the reason `request_action`
 * hands back for a failed row (application/gateway's `readTerminalOutcome`). One rule for all
 * three, so one audit row never reads differently on two surfaces:
 *
 *   1. redacted again with the audit copy's rule — `reasonAuditFields` wrote it, but a row written
 *      before legacy 187 holds the text as given, and audit rows are never rewritten (I11);
 *   2. clipped to {@link SHOWN_REASON_MAX} code points — after redacting, so a secret across the cut
 *      is masked whole instead of leaving a prefix the redaction no longer recognises;
 *   3. every character a reader cannot see (a bidi override, a zero-width or control character)
 *      shown as `\u{XXXX}` — after clipping, so an escape is never cut in half. Line breaks stay (a
 *      CR before one is dropped), so a multi-line reason still reads as lines.
 *
 * Derived on read only: the audit row stays the record (I11).
 */

/** The most code points of a reason the wire carries: enough for a gate's or a target system's
 *  error sentence, never a whole response body. */
export const SHOWN_REASON_MAX = 1000;

/** An audited reason as it is shown, plus whether step 2 cut it (legacy 339: the wire's
 *  `failureReasonTruncated`, so the console can say the rest is in the audit record) — measured on
 *  the same redacted text step 2 clips, so the flag and the shown text never disagree. */
export interface ShownAuditReason {
  readonly text: string;
  readonly truncated: boolean;
}

/** {@link shownAuditReason} with whether it was clipped; `null` when there is no reason. */
export function shownAuditReasonWithTruncation(reason: unknown): ShownAuditReason | null {
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  const redacted = redactSuspectedSecrets(reason, { secretFields: true }).value as string;
  const text = clipCodePoints(redacted, SHOWN_REASON_MAX)
    .split('\n')
    .map((line) => visibleText(line.replace(/\r$/, '')))
    .join('\n');
  return { text, truncated: [...redacted].length > SHOWN_REASON_MAX };
}

/** An audited reason as it is shown; `null` when there is none (not a string, or blank). */
export function shownAuditReason(reason: unknown): string | null {
  return shownAuditReasonWithTruncation(reason)?.text ?? null;
}
