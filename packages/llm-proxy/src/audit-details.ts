/**
 * Keeping an llm-proxy platform audit row inside the kernel's limit (legacy 151).
 *
 * The kernel refuses a row whose `JSON.stringify(details).length` is over
 * `LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS` (`POST /internal/llm-admin-audit`), and a refused row is
 * lost: only this proxy's own `level: 'audit'` log line keeps the action. So every row is sized
 * before it is sent, and nothing is cut from a row that fits:
 *
 * - `fitModelIds` handles the one list a row can carry at full size — a new provider's model ids
 *   (up to 200 of up to 200 characters, ten times the limit; a relay with a few hundred ordinary
 *   ids is already over it). A row that fits is sent whole; otherwise it names as many ids as the
 *   rest of the row leaves room for, in order, and counts the others.
 * - The other lists are small by their write-time caps: `provider_models_probed`'s `results`
 *   names at most `LLM_PROVIDER_PROBE_MAX_MODELS` (6) models of up to 200 characters, about 2.6 KB
 *   with a 1024-character base URL. Raising that cap far means giving that row the same treatment,
 *   or it falls to `fitAuditDetails` and loses the whole list.
 * - `fitAuditDetails` is the last check before sending. A row over the limit even so (a base URL
 *   saved before the write-time cap, an error whose characters JSON escapes) drops its largest
 *   fields first, one at a time, until it fits, and names them in `detailsOmitted`. The proxy's
 *   own log line still has every field.
 */
import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';

/** `details` as sent to the kernel for a row that lists model ids: whole when it fits; otherwise
 *  the first ids that fit beside the rest of the row, and `modelsOmitted` counting the others. */
export function fitModelIds(
  details: Readonly<Record<string, unknown>> & { readonly models: readonly string[] },
): Readonly<Record<string, unknown>> {
  if (jsonLength(details) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) return details;
  const ids = details.models;
  // The rest of the row with no ids and the largest count it can carry; what is left is the ids'.
  let chars = jsonLength({ ...details, models: [], modelsOmitted: ids.length });
  const kept: string[] = [];
  for (const id of ids) {
    chars += JSON.stringify(id).length + (kept.length > 0 ? 1 : 0);
    // A prefix, so the row names "the first n" — not whichever later ids happen to be short.
    if (chars > LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) break;
    kept.push(id);
  }
  return { ...details, models: kept, modelsOmitted: ids.length - kept.length };
}

/** `details` as sent to the kernel: unchanged when it fits; otherwise without its largest fields,
 *  dropped one at a time until the row fits, with `detailsOmitted` naming them. */
export function fitAuditDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (jsonLength(details) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) return details;
  const largestFirst = Object.keys(details).sort(
    (a, b) => jsonLength(details[b]) - jsonLength(details[a]),
  );
  const omitted: string[] = [];
  for (const key of largestFirst) {
    omitted.push(key);
    const fitted = {
      ...Object.fromEntries(Object.entries(details).filter(([name]) => !omitted.includes(name))),
      detailsOmitted: omitted,
    };
    if (jsonLength(fitted) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) return fitted;
  }
  // Only the field names left, and still over: a row with hundreds of fields. This proxy's rows
  // have at most eight.
  return { detailsOmitted: omitted };
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}
