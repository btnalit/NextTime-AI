import { z } from 'zod';
import { TOOL_CALL_OUTCOME_VALUES } from './chat-message-content.js';
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
 * - A pi tool result's text parts are counted exactly as the kernel reads them (the part text, a
 *   separator between parts), and cut where this bound falls.
 */
export const WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS = 32_768;
/** What worker mode keeps one `report_tool_calls` body under (UTF-8 bytes of its JSON) — half the
 *  1 MiB the kernel's `/api/cap/*` takes. One call's bounded payloads always fit on their own. */
export const REPORT_TOOL_CALLS_MAX_BODY_BYTES = 512 * 1024;

/** What stands for the rest of an object or array that was not sent. */
export const TOOL_CALL_PAYLOAD_LEFT_OUT = '[…]';
const MAX_DEPTH = 32;

interface Budget {
  chars: number;
}

/** A string or key as sent: whole, or cut at the string bound (never through a surrogate pair). */
function sentText(text: string): string {
  return text.length <= WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS
    ? text
    : sliceKeepingPairs(text, WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS);
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
  if (depth >= MAX_DEPTH) return TOOL_CALL_PAYLOAD_LEFT_OUT;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.chars <= 0) {
        out.push(TOOL_CALL_PAYLOAD_LEFT_OUT);
        break;
      }
      const bounded = boundValue(item, budget, depth + 1);
      out.push(bounded === undefined ? null : bounded);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (budget.chars <= 0) {
      defineEntry(out, TOOL_CALL_PAYLOAD_LEFT_OUT, TOOL_CALL_PAYLOAD_LEFT_OUT);
      break;
    }
    const shownKey = sentText(key);
    budget.chars -= Math.max(shownKey.length, 1);
    const bounded =
      budget.chars > 0 ? boundValue(item, budget, depth + 1) : TOOL_CALL_PAYLOAD_LEFT_OUT;
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
 * `value` (a call's arguments or result) as worker mode sends it ({@link
 * WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS}): whole when it is within the bounds; otherwise each string
 * cut at the string bound, and past `maxChars` in all the rest of each object or array left out as
 * one `[…]` entry. A pi tool result sends only the parts its record shows, its text cut where
 * `maxChars` falls. Not redaction: the kernel redacts. `maxChars` is for tests: worker mode sends
 * the default.
 */
export function boundToolCallPayload(
  value: unknown,
  maxChars: number = WORKER_TOOL_CALL_PAYLOAD_SENT_CHARS,
): unknown {
  const content = (value as { content?: unknown } | null)?.content;
  // With no typed part the kernel shows the result itself, as it shows any other value.
  if (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray(content) &&
    content.some((part) => typeof (part as { type?: unknown } | null)?.type === 'string')
  ) {
    return boundContentResult(content, maxChars);
  }
  return boundValue(value, { chars: maxChars }, 0);
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
