import { namesASecretField, visibleLines } from '@nexttime/shared';
import { redactSecrets, scrubSecretValues } from './secret-values.js';

/**
 * substrate/redaction/shown-text (legacy 420): free text the kernel keeps as it was written and
 * reads back — a person's approve / reject reason, the reasons and notes a Decision's rationale
 * holds, a conflict resolution's reason, a Fact's invalidation reason, a human attestation's note
 * and link, a self-connection's suspension reason, an Operation's description, the text inside an
 * audit record's payload — as every read shows it:
 *
 *   1. every secret-looking value replaced by `[redacted]` (`scrubSecretValues`: the value rule an
 *      audited reason is shown with, governance/approval's `shownAuditReason`, and a Task's input);
 *   2. every character a reader cannot see (a bidi override, a zero-width or control character)
 *      shown as `\u{XXXX}`, line breaks and tabs kept (`visibleLines`) — after redacting, so the
 *      patterns read the text as it is.
 *
 * Unlike an audited reason, this text is not clipped: a person or an agent wrote it through a
 * capability that bounds it, and a clip would hide part of what they wrote, not an upstream body.
 *
 * Derived on read only: the stored row stays the record (I11). Text written before a field was
 * checked at write — and text that is never checked there, such as a reject reason (refusing it
 * would stand in the way of stopping a dangerous action) — reads masked on every surface without
 * any row being rewritten. The console says what `[redacted]` means wherever it shows one.
 */

/** Free text as every read shows it — the module comment's two steps. */
export function shownFreeText(text: string): string;
export function shownFreeText(text: string | null): string | null;
export function shownFreeText(text: string | null): string | null {
  if (text === null) return null;
  return visibleLines(scrubSecretValues(text).value);
}

export interface ShownFreeTextInOptions {
  /** Also replace every value under a field whose name names a secret, whatever it looks like —
   *  for a copy of call arguments, which fill fields (`namesASecretField`, the rule the audit copy
   *  of a call's params is written with). Leave off for a record the kernel shaped itself: its own
   *  field names (`suspectedSecretValues`, `credentialReview`) name secrets and hold counts. */
  readonly secretFields?: boolean;
}

/** A stored JSON value (a Decision's rationale, a conflict's resolution, an audit payload) with
 *  every string in it shown as {@link shownFreeText} shows text; its shape and every non-string
 *  value kept. The redaction is the document rule `findSuspectedSecrets` applies by default (value
 *  patterns plus the literals a schema declares for a secret-named property), and with
 *  `secretFields` the call-argument rule. */
export function shownFreeTextIn(value: unknown, options: ShownFreeTextInOptions = {}): unknown {
  const redacted = redactSecrets(value, {
    ...(options.secretFields === true ? { isSecretKey: namesASecretField } : {}),
    schemaLiterals: true,
    // A stored value already bounded by the capability that wrote it, kept whole.
    maxNodes: Number.POSITIVE_INFINITY,
  }).value;
  return visibleStrings(redacted);
}

function visibleStrings(value: unknown): unknown {
  if (typeof value === 'string') return visibleLines(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(visibleStrings);
  // `fromEntries` defines own properties, so a `"__proto__"` key stays a field.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      visibleStrings(inner),
    ]),
  );
}

/**
 * An audit record's payload as every audit read shows it: its `params` — the copy of a call's
 * arguments `application/gateway/dispatch.ts` writes (`auditParams`) — under the call-argument
 * rule, everything else under the document rule ({@link shownFreeTextIn}). The writers already
 * redact both (`auditParams`, `redactedForAudit`); this covers a row written before they did and
 * text a handler put in its own payload as given (an Operation description's before / after).
 */
export function shownAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([key, inner]) => [
      key,
      shownFreeTextIn(inner, { secretFields: key === 'params' }),
    ]),
  );
}
