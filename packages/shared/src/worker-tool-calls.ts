import { z } from 'zod';
import { TOOL_CALL_OUTCOME_VALUES } from './chat-message-content.js';
import {
  SECRET_FIELD_NAME_JUDGED_CHARS,
  SECRET_LITERAL_WALK_NODES,
  type SecretLiteralSites,
  secretFieldLiteralSites,
} from './secret-field-name.js';
import { sliceKeepingPairs } from './storable-text.js';

/**
 * worker-tool-calls (legacy 155): the tool calls a Worker makes in its run, as its runtime reports
 * them. A chat Turn's tool calls reach the kernel through agent-host's event stream and are kept as
 * `role: 'tool'` chat messages (#520); a Worker runs alone in its container, so worker mode
 * (packages/platform-extension modes/worker.ts) reports each finished call itself through
 * `report_tool_calls`, on its own Handle. The kernel stores what it is told the way it stores a
 * Turn's — redacted and cut to a preview (`ToolCallMessageContent`) — and `get_task_tool_calls`
 * reads it back for the people who may read the Task.
 *
 * A record is the Worker runtime's account of its run, as trustworthy as the answer it gives —
 * never more: the model's own shell holds the Handle the report is made with. What the run did at a
 * gate is in the audit trail (`observe_operation` / `request_action` rows) and stays authoritative.
 */

/** Calls in one `report_tool_calls`. */
export const REPORT_TOOL_CALLS_MAX_CALLS = 50;
/** Records kept for one WorkerRun; later calls are counted (`overLimit`), not stored. The same
 *  bound a chat Turn has (#520). */
export const MAX_WORKER_RUN_TOOL_CALL_RECORDS = 200;
/** A call's id (pi's, the model provider's) and its tool's name, at most. */
export const WORKER_TOOL_CALL_ID_MAX_CHARS = 256;
export const WORKER_TOOL_CALL_NAME_MAX_CHARS = 256;
/**
 * How much of each payload (a call's arguments, its result) worker mode sends, in characters.
 *
 * - **Any one string, at most this.** The kernel reads a payload only up to its preview length
 *   plus a margin, and the string it stops in a little further (so a cut never leaves the start of
 *   a secret): at most 24 192 characters of any one string. A string worker mode cuts is cut past
 *   that, so the kernel never reaches the cut — wherever its own reading stops, the record shows
 *   nothing worker mode cut (no half secret can come from it). The kernel's tests hold the number
 *   to that (application/task/tool-calls).
 * - **About this much in all.** Past it the rest of each object or array is left out, item by
 *   item, as one `[…]` entry; an item already begun is sent whole (up to the string bound), never
 *   cut for the total. Counted as the kernel's bounded reading counts (string content, object
 *   keys, the characters of a number, a boolean or null) plus one per object or array, so the
 *   kernel normally stops reading well before it and the record is the one the whole payload
 *   gives. It can read further only past long values under secret-named keys (it charges each the
 *   `[redacted]` it writes): it then shows `[…]` where it would have shown more — less, never a cut
 *   string.
 * - **Except the arguments' secret values.** The kernel hides, wherever a call's result repeats
 *   it, every value the call's arguments hold under a secret key (`secretFieldLiterals` — read
 *   from the whole arguments, not only what their record shows). Those it collects are sent even
 *   where the rest was left out (`boundToolCallArgs`), each where it was, so the kernel collects
 *   from what it is sent exactly what it would from the whole arguments, and the result's record
 *   is the one the whole call gives (legacy 155, #501 F1). At most 64 values of at most 4 096
 *   characters, with their keys on the way (cut at the 256 characters a key is judged on).
 * - A pi tool result's text parts are counted exactly as the kernel reads them (the part text, a
 *   separator between parts), and cut where this bound falls.
 */
export const WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS = 32_768;
/** What worker mode keeps one `report_tool_calls` body under (UTF-8 bytes of its JSON) — half the
 *  1 MiB the kernel's `/api/cap/*` takes. One call's bounded payloads fit on their own; with the
 *  arguments' kept secret values one might not, and is then sent without its result (worker mode,
 *  modes/worker-tool-calls.ts). */
export const REPORT_TOOL_CALLS_MAX_BODY_BYTES = 512 * 1024;

/** What stands for the rest of an object or array that was not sent. */
export const TOOL_CALL_PAYLOAD_LEFT_OUT = '[…]';
const MAX_DEPTH = 32;

interface Budget {
  chars: number;
  /** Where the arguments' secret values are (`secretFieldLiteralSites`), when they are kept. */
  readonly sites: SecretLiteralSites | undefined;
  /** Anything was left out. */
  leftOut: boolean;
}

/** A string or key as sent: whole, or cut at the string bound (never through a surrogate pair). */
function sentText(text: string): string {
  return text.length <= WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS
    ? text
    : sliceKeepingPairs(text, WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS);
}

/** A key of `source` on the way to a kept secret value, as `out` gets it: what the key rule judges
 *  of it (its start). A start is no key of `source` and none `out` already has — else a number
 *  after it — so nothing kept is written over, by a key that starts alike or by one that is just
 *  that start. */
function keptKey(out: Record<string, unknown>, source: object, key: string): string {
  if (key.length <= SECRET_FIELD_NAME_JUDGED_CHARS) return key;
  const start = sliceKeepingPairs(key, SECRET_FIELD_NAME_JUDGED_CHARS);
  let kept = start;
  for (let n = 2; Object.hasOwn(out, kept) || Object.hasOwn(source, kept); n += 1) {
    kept = `${start} ${n}`;
  }
  return kept;
}

function emptyLike(value: object): unknown[] | Record<string, unknown> {
  return Array.isArray(value) ? [] : {};
}

/** Of `value` — a kept secret value, or an object or array on the way to some — only what is on
 *  the way to them (`sites`), in the order written. */
function keptSecrets(value: unknown, sites: SecretLiteralSites): unknown {
  if (value === null || typeof value !== 'object') return value;
  const root = emptyLike(value);
  const stack: { readonly source: object; readonly target: unknown[] | Record<string, unknown> }[] =
    [{ source: value, target: root }];
  // The walk that found them visited at most this many; a value that refers to itself stops here.
  let nodes = SECRET_LITERAL_WALK_NODES;
  while (stack.length > 0 && nodes > 0) {
    nodes -= 1;
    const { source, target } = stack.pop() as (typeof stack)[number];
    const keys = sites.get(source);
    if (keys === undefined) continue;
    const keep = (key: string | number, item: unknown, put: (kept: unknown) => void): void => {
      if (!keys.has(key)) return;
      if (item === null || typeof item !== 'object') {
        put(item);
        return;
      }
      const copy = emptyLike(item);
      put(copy);
      stack.push({ source: item, target: copy });
    };
    if (Array.isArray(source)) {
      const out = target as unknown[];
      for (let index = 0; index < source.length; index += 1) {
        keep(index, source[index], (kept) => out.push(kept));
      }
    } else {
      const out = target as Record<string, unknown>;
      for (const [key, item] of Object.entries(source as Record<string, unknown>)) {
        keep(key, item, (kept) => defineEntry(out, keptKey(out, source, key), kept));
      }
    }
  }
  return root;
}

/** What stands where `container`'s `key` (`item`) was left out: what of it is on the way to a kept
 *  secret value, or nothing (`undefined`). */
function keptOf(container: object, key: string | number, item: unknown, budget: Budget): unknown {
  budget.leftOut = true;
  if (budget.sites?.get(container)?.has(key) !== true) return undefined;
  return keptSecrets(item, budget.sites);
}

function boundValue(value: unknown, budget: Budget, depth: number): unknown {
  if (typeof value === 'string') {
    const sent = sentText(value);
    budget.chars -= Math.max(sent.length, 1);
    return sent;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    budget.chars -= String(value).length;
    return value;
  }
  if (value === null) {
    budget.chars -= 4;
    return null;
  }
  if (typeof value === 'bigint') return boundValue(value.toString(), budget, depth);
  if (typeof value !== 'object') return undefined;
  // What JSON.stringify would send for it (a Date's string, a Buffer's bytes).
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const json: unknown = toJSON.call(value);
    if (json !== value) return boundValue(json, budget, depth);
  }
  budget.chars -= 1;
  if (depth >= MAX_DEPTH) {
    budget.leftOut = true;
    return budget.sites?.has(value) === true
      ? keptSecrets(value, budget.sites)
      : TOOL_CALL_PAYLOAD_LEFT_OUT;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (budget.chars <= 0) {
        out.push(TOOL_CALL_PAYLOAD_LEFT_OUT);
        for (let rest = index; rest < value.length; rest += 1) {
          const kept = keptOf(value, rest, value[rest], budget);
          if (kept !== undefined) out.push(kept);
        }
        break;
      }
      const bounded = boundValue(value[index], budget, depth + 1);
      out.push(bounded === undefined ? null : bounded);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, item] = entries[index] as [string, unknown];
    if (budget.chars <= 0) {
      defineEntry(out, TOOL_CALL_PAYLOAD_LEFT_OUT, TOOL_CALL_PAYLOAD_LEFT_OUT);
      for (let rest = index; rest < entries.length; rest += 1) {
        const [restKey, restItem] = entries[rest] as [string, unknown];
        const kept = keptOf(value, restKey, restItem, budget);
        if (kept !== undefined) defineEntry(out, keptKey(out, value, restKey), kept);
      }
      break;
    }
    const shownKey = sentText(key);
    budget.chars -= Math.max(shownKey.length, 1);
    const bounded =
      budget.chars > 0
        ? boundValue(item, budget, depth + 1)
        : (keptOf(value, key, item, budget) ?? TOOL_CALL_PAYLOAD_LEFT_OUT);
    if (bounded !== undefined) defineEntry(out, shownKey, bounded);
  }
  return out;
}

/** An own property: assigning `out[key]` with a `"__proto__"` key would swap the prototype instead
 *  of keeping a field. */
function defineEntry(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** pi's tool result (`{content: [{type: 'text', text}, …], details}`): the kernel's record shows
 *  the parts the model saw — text, and `[type]` for any other part — so only those are sent (not
 *  `details`, nor an image's data), each part's text counted as the kernel counts it (a separator
 *  between parts). */
function boundContentResult(content: readonly unknown[], maxChars: number): unknown {
  const parts: unknown[] = [];
  let used = 0;
  for (const part of content) {
    const record = part as { type?: unknown; text?: unknown } | null;
    if (typeof record?.type !== 'string') continue;
    if (used >= maxChars) break;
    const separator = parts.length > 0 ? 1 : 0;
    if (record.type === 'text' && typeof record.text === 'string') {
      const room = Math.max(0, maxChars - used - separator);
      const text = record.text.length <= room ? record.text : sliceKeepingPairs(record.text, room);
      parts.push({ type: 'text', text });
      used += separator + text.length;
    } else {
      // The kernel shows it as `[type]`; a type is cut at the string bound, past what it reads.
      const type = sentText(record.type);
      parts.push({ type });
      used += separator + type.length + 2;
    }
  }
  return { content: parts };
}

/**
 * A call's arguments as worker mode sends them ({@link WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS}): whole
 * when they are within the bounds; otherwise each string cut at the string bound, and past
 * `maxChars` in all the rest of each object or array left out as one `[…]` entry — except, given
 * the call's key rule (`isSecretKey`, `toolCallSecretKeyRule`), every value under a secret key the
 * kernel collects from the whole arguments to hide in the result, kept where it was. Without it
 * (a call sent without its result) nothing is kept past the bound. Not redaction: the kernel
 * redacts. `maxChars` is for tests: worker mode sends the default.
 */
export function boundToolCallArgs(
  args: unknown,
  options: {
    readonly isSecretKey?: (key: string) => boolean;
    readonly maxChars?: number;
  } = {},
): unknown {
  const { isSecretKey, maxChars = WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS } = options;
  const budget: Budget = { chars: maxChars, sites: undefined, leftOut: false };
  const bounded = boundValue(args, budget, 0);
  if (!budget.leftOut || isSecretKey === undefined) return bounded;
  const { sites } = secretFieldLiteralSites(args, isSecretKey);
  if (sites.size === 0) return bounded;
  return boundValue(args, { chars: maxChars, sites, leftOut: false }, 0);
}

/**
 * A call's result as worker mode sends it: a pi tool result only the parts its record shows, its
 * text cut where `maxChars` falls; any other value bounded as the arguments are, with nothing kept
 * past the bound (nothing in a result hides anything else). `maxChars` is for tests.
 */
export function boundToolCallResult(
  result: unknown,
  maxChars: number = WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS,
): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  // With no typed part the kernel shows the result itself, as it shows any other value.
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray(content) &&
    content.some((part) => typeof (part as { type?: unknown } | null)?.type === 'string')
  ) {
    return boundContentResult(content, maxChars);
  }
  return boundValue(result, { chars: maxChars, sites: undefined, leftOut: false }, 0);
}

/** One call as worker mode reports it. `args` is absent when the call's start was not seen,
 *  `result` when it did not finish (`not_finished`) or reported none. The times are the Worker's
 *  clock (the container's), ISO 8601. */
export const ReportedToolCallSchema = z
  .object({
    toolCallId: z.string().min(1).max(WORKER_TOOL_CALL_ID_MAX_CHARS),
    name: z.string().min(1).max(WORKER_TOOL_CALL_NAME_MAX_CHARS).nullable(),
    outcome: z.enum(TOOL_CALL_OUTCOME_VALUES),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    endedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ReportedToolCall = z.infer<typeof ReportedToolCallSchema>;

export const ReportToolCallsParamsSchema = z
  .object({
    calls: z.array(ReportedToolCallSchema).min(1).max(REPORT_TOOL_CALLS_MAX_CALLS),
  })
  .strict();
export type ReportToolCallsParams = z.infer<typeof ReportToolCallsParamsSchema>;

/** `get_task_tool_calls`'s page size: the default, and at most. */
export const DEFAULT_TASK_TOOL_CALLS_LIMIT = 100;
export const MAX_TASK_TOOL_CALLS_LIMIT = 200;
