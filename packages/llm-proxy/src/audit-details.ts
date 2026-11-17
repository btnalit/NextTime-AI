/**
 * Keeping an llm-proxy platform audit row inside the kernel's limit (legacy 151).
 *
 * The kernel refuses a row whose `JSON.stringify(details).length` is over
 * `LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS` (`POST /internal/llm-admin-audit`), and a refused row is
 * lost: only this proxy's own `level: 'audit'` log line keeps the action. So every row is sized
 * before it is sent:
 *
 * - `auditedModelIds` bounds the one list a row can carry at full size — a new provider's model
 *   ids (up to 200 of up to 200 characters, ten times the limit; a relay with a few hundred
 *   ordinary ids is already over it). The row names as many as fit and counts the rest.
 * - `fitAuditDetails` is the last check before sending. A row over the limit even so (a base URL
 *   saved before the write-time cap, or one whose characters JSON escapes) keeps its small fields
 *   and names the ones it dropped. The proxy's own log line still has every field.
 */
import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';

/** How much of a row the model id list may take, as JSON. With the row's other fields — a base URL
 *  of at most `LLM_PROVIDER_UPSTREAM_BASE_URL_MAX_CHARS`, an env-var name, a short error — this
 *  keeps a new provider's row inside the limit. */
export const AUDIT_MODEL_IDS_MAX_CHARS = 2048;

/** The longest field, as JSON, that `fitAuditDetails` keeps in a row that was over the limit. */
export const AUDIT_FIELD_MAX_CHARS = 256;

/** The model ids an audit row names: in order, as many as fit `AUDIT_MODEL_IDS_MAX_CHARS` as JSON,
 *  and how many were left out. */
export function auditedModelIds(ids: readonly string[]): {
  readonly ids: string[];
  readonly omitted: number;
} {
  const kept: string[] = [];
  let chars = 2; // the brackets
  for (const id of ids) {
    chars += JSON.stringify(id).length + (kept.length > 0 ? 1 : 0);
    if (chars > AUDIT_MODEL_IDS_MAX_CHARS) break;
    kept.push(id);
  }
  return { ids: kept, omitted: ids.length - kept.length };
}

/** `details` as sent to the kernel: unchanged when it fits; otherwise only the fields of at most
 *  `AUDIT_FIELD_MAX_CHARS` as JSON, with `detailsOmitted` naming the rest. */
export function fitAuditDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (jsonLength(details) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) return details;
  const kept: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (jsonLength(value) <= AUDIT_FIELD_MAX_CHARS) kept[key] = value;
    else omitted.push(key);
  }
  const fitted = { ...kept, detailsOmitted: omitted };
  // Only a row with a dozen or more fields could still be over; none of this proxy's rows has one.
  return jsonLength(fitted) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS
    ? fitted
    : { detailsOmitted: Object.keys(details) };
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}
