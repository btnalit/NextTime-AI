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
 *
 * Before either, `storableDetails` makes the row's text storable at all (legacy 825): Postgres
 * `jsonb` refuses U+0000 and an unpaired surrogate, and the kernel lost such a row with a 500.
 * The write paths refuse both in the names they take (#1409), but text that never passed them
 * still can carry one — an error cut at 200 UTF-16 units through a surrogate pair, a base URL or
 * model id stored before that rule, a model id in an operator's `llm-providers.yaml`.
 */
import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';

/** `details` with every U+0000 and unpaired surrogate in its text, keys included and at any depth,
 *  replaced by U+FFFD, and `detailsReplaced` naming the fields where that happened. The same
 *  object when there is none. */
export function storableDetails(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const replaced = Object.keys(details).filter(
    (key) => storableText(key) !== key || storableValue(details[key]) !== details[key],
  );
  if (replaced.length === 0) return details;
  return {
    ...(storableValue(details) as Record<string, unknown>),
    detailsReplaced: replaced.map(storableText),
  };
}

/** `value` with `storableText` applied to every string in it; the same value when none changed. */
function storableValue(value: unknown): unknown {
  if (typeof value === 'string') return storableText(value);
  if (Array.isArray(value)) {
    const items = value.map(storableValue);
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const stored = entries.map(([key, item]) => [storableText(key), storableValue(item)] as const);
    return stored.some(([key, item], i) => key !== entries[i]?.[0] || item !== entries[i]?.[1])
      ? Object.fromEntries(stored)
      : value;
  }
  return value;
}

/** `text` with U+0000 and every unpaired surrogate replaced by U+FFFD; the same string when it has
 *  none. A char-code loop: biome refuses a control character in a regex. */
function storableText(text: string): string {
  let stored = '';
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        stored += text.slice(i, i + 2);
        i += 1;
        continue;
      }
    } else if (code !== 0 && (code < 0xdc00 || code > 0xdfff)) {
      stored += text[i];
      continue;
    }
    stored += '\ufffd';
    changed = true;
  }
  return changed ? stored : text;
}

/** `details` as sent to the kernel for a row that lists model ids: whole when it fits; otherwise
 *  the first ids that fit beside the rest of the row, and `modelsOmitted` counting the others. */
export function fitModelIds(
  details: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (jsonLength(details) <= LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS) return details;
  if (!Array.isArray(details.models)) return details;
  const ids: readonly unknown[] = details.models;
  // The rest of the row with no ids and the largest count it can carry; what is left is the ids'.
  let chars = jsonLength({ ...details, models: [], modelsOmitted: ids.length });
  const kept: unknown[] = [];
  for (const id of ids) {
    chars += jsonLength(id) + (kept.length > 0 ? 1 : 0);
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
