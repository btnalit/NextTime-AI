import {
  TOOL_CALL_MESSAGE_KIND,
  type ToolCallMessageContent,
  type ToolCallOutcome,
  type ToolCallPayloadPreview,
  getCapability,
} from '@nexttime/shared';
import {
  type RedactedValue,
  SECRET_FIELD_NAME,
  type Scrubbed,
  redactSecrets,
  safeStringify,
  scrubSecretValues,
} from '../../governance/redaction/index.js';

/**
 * application/chat/tool-call-record: what the chat event sink stores for one of a Turn's tool
 * calls (`role='tool'`, `kind: 'tool_call'` — `@nexttime/shared`'s `ToolCallMessageContent`), and
 * the redaction the same sink applies to the live `chat.stream` tool deltas and the stored reply.
 *
 * A tool's arguments and result come from the agent container, which runs pi's built-in
 * `bash`/`read` next to its own Handle: one `env` — a prompt-injected one included — puts that
 * Handle into a tool result, and it went out on `chat.stream` to every subscriber of the Chat.
 * Values are scrubbed with governance/redaction (what counts as a secret, why the kernel is where
 * it happens, and what it cannot stop); on top of that, an object key that names a secret
 * (`SECRET_FIELD_NAME`), or a param the capability itself declares secret (`redactedParamKeys` —
 * the same list `dispatch.ts` keeps out of the audit log), is replaced whatever its value.
 *
 * Size, and time: a runtime frame may be up to 100 MiB, and redaction runs on the kernel's event
 * loop. So nothing past what is shown is read at all: a payload is read up to its preview length
 * plus `SECRET_MARGIN_CHARS`, scrubbed, then cut to the preview length — the margin is longer than
 * any secret replaced whole, so a secret that starts before the cut ends before the read bound and
 * the cut never leaves half of one behind. The live stream shows the same bounded, scrubbed copy.
 * A stored reply is scrubbed whole up to `MESSAGE_TEXT_MAX_CHARS`, past which it is cut.
 */

/** Characters of a call's arguments kept in its record. */
export const TOOL_CALL_ARGS_PREVIEW_CHARS = 4_000;
/** Characters of a call's result kept in its record. */
export const TOOL_CALL_RESULT_PREVIEW_CHARS = 16_000;
/** Read past a preview's length before cutting it — longer than any secret replaced whole (a PEM
 *  RSA-4096 private key is ~3.3k characters, a Handle well under 2k). */
export const SECRET_MARGIN_CHARS = 4_096;
/** A stored reply's text fields are kept up to this length (256 Ki characters — far above what a
 *  model writes in one answer); past it the rest is cut, so scrubbing it stays bounded. */
export const MESSAGE_TEXT_MAX_CHARS = 262_144;

const ARGS_READ_CHARS = TOOL_CALL_ARGS_PREVIEW_CHARS + SECRET_MARGIN_CHARS;
const RESULT_READ_CHARS = TOOL_CALL_RESULT_PREVIEW_CHARS + SECRET_MARGIN_CHARS;

/** The keys a capability declares secret (`Capability.redactedParamKeys`), when `toolName` is a
 *  capability tool — entry and interactive mode name each capability tool after its capability. */
function capabilitySensitiveKeys(toolName: string | null | undefined): ReadonlySet<string> {
  const keys = toolName ? getCapability(toolName)?.redactedParamKeys : undefined;
  return new Set(keys ?? []);
}

function redactPayload(value: unknown, toolName: string | null | undefined, maxChars: number) {
  const declared = capabilitySensitiveKeys(toolName);
  return redactSecrets(value, {
    isSecretKey: (key) => declared.has(key) || SECRET_FIELD_NAME.test(key),
    maxChars,
  });
}

/** A tool call's arguments with secret-looking keys and values replaced, read only as far as their
 *  record shows — the shape is kept, so the live console renders it as before. */
export function redactToolArgs(value: unknown, toolName?: string | null): RedactedValue {
  return redactPayload(value, toolName, ARGS_READ_CHARS);
}

/** A tool call's result, likewise. */
export function redactToolResult(value: unknown, toolName?: string | null): RedactedValue {
  return redactPayload(value, toolName, RESULT_READ_CHARS);
}

/** A runtime `message`'s content with secrets scrubbed from its string fields (only the values;
 *  a reply has no secret-named keys to replace) — each cut at `MESSAGE_TEXT_MAX_CHARS` first. The
 *  agent can be talked into repeating its own Handle in its answer as easily as into running
 *  `env`. `cut` says whether any field was cut. */
export function redactMessageContent(
  content: Record<string, unknown>,
): Scrubbed<Record<string, unknown>> & { readonly cut: boolean } {
  let redactedValues = 0;
  let cut = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === 'string') {
      const kept =
        value.length > MESSAGE_TEXT_MAX_CHARS ? value.slice(0, MESSAGE_TEXT_MAX_CHARS) : value;
      cut ||= kept !== value;
      const scrubbed = scrubSecretValues(kept);
      redactedValues += scrubbed.redactedValues;
      out[key] = kept === value ? scrubbed.value : `${scrubbed.value}…`;
    } else {
      out[key] = value;
    }
  }
  return { value: out, redactedValues, cut };
}

/** `text` (already scrubbed) cut to `limit`. `totalChars` is how long the payload was before
 *  anything was cut — at least that long when part of it was never read (`unread`). */
function preview(
  text: string,
  limit: number,
  totalChars: number,
  unread: boolean,
): ToolCallPayloadPreview {
  return {
    text: text.length <= limit ? text : text.slice(0, limit),
    totalChars,
    truncated: unread || text.length > limit,
  };
}

/** pi's tool result is `{content: [{type:'text', text}, …], details}`: the model saw the text
 *  parts, so the record shows those (a non-text part as `[image]` etc.), read up to `readChars`.
 *  `undefined` when the result has no such parts. */
function resultContentText(
  result: unknown,
  readChars: number,
): { readonly text: string; readonly totalChars: number } | undefined {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  let totalChars = 0;
  let parts = 0;
  for (const part of content) {
    const record = part as { type?: unknown; text?: unknown } | null;
    let partText: string;
    if (record?.type === 'text' && typeof record.text === 'string') partText = record.text;
    else if (typeof record?.type === 'string') partText = `[${record.type}]`;
    else continue;
    const joined = parts > 0 ? `\n${partText}` : partText;
    parts += 1;
    totalChars += joined.length;
    if (text.length < readChars) text += joined.slice(0, readChars - text.length);
  }
  return parts > 0 ? { text, totalChars } : undefined;
}

/** A result as redacted text: its content text scrubbed, or — with no content text — the result
 *  itself redacted key by key and serialized. */
function redactedResultPreview(
  result: unknown,
  toolName: string | null,
): Scrubbed<ToolCallPayloadPreview> {
  const contentText = resultContentText(result, RESULT_READ_CHARS);
  if (contentText !== undefined) {
    const scrubbed = scrubSecretValues(contentText.text);
    return {
      value: preview(
        scrubbed.value,
        TOOL_CALL_RESULT_PREVIEW_CHARS,
        contentText.totalChars,
        contentText.totalChars > contentText.text.length,
      ),
      redactedValues: scrubbed.redactedValues,
    };
  }
  const redacted = redactToolResult(result, toolName);
  const text = typeof redacted.value === 'string' ? redacted.value : safeStringify(redacted.value);
  return {
    value: preview(text, TOOL_CALL_RESULT_PREVIEW_CHARS, text.length, redacted.omitted),
    redactedValues: redacted.redactedValues,
  };
}

export interface ToolCallRecordInput {
  readonly toolCallId: string;
  readonly name: string | null;
  readonly outcome: ToolCallOutcome;
  /** `undefined` when the call's start was not seen. */
  readonly args?: unknown;
  readonly hasArgs: boolean;
  /** `undefined` for a call that did not finish, or that reported no result. */
  readonly result?: unknown;
  readonly hasResult: boolean;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}

/** The persisted record of one tool call: both payloads read up to their bound, redacted, then
 *  cut to their preview length (redaction first, so a cut never leaves half a secret behind). */
export function buildToolCallRecord(input: ToolCallRecordInput): ToolCallMessageContent {
  let redactedValues = 0;
  let args: ToolCallPayloadPreview | undefined;
  if (input.hasArgs) {
    const redacted = redactToolArgs(input.args, input.name);
    redactedValues += redacted.redactedValues;
    const text = safeStringify(redacted.value);
    args = preview(text, TOOL_CALL_ARGS_PREVIEW_CHARS, text.length, redacted.omitted);
  }
  let result: ToolCallPayloadPreview | undefined;
  if (input.hasResult) {
    const redacted = redactedResultPreview(input.result, input.name);
    redactedValues += redacted.redactedValues;
    result = redacted.value;
  }
  return {
    kind: TOOL_CALL_MESSAGE_KIND,
    text: input.name ?? 'unknown tool',
    toolCallId: input.toolCallId,
    name: input.name,
    outcome: input.outcome,
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
    redactedValues,
    startedAt: input.startedAt?.toISOString() ?? null,
    endedAt: input.endedAt?.toISOString() ?? null,
  };
}
