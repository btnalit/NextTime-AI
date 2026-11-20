import {
  TOOL_CALL_MESSAGE_KIND,
  type ToolCallMessageContent,
  type ToolCallOutcome,
  type ToolCallPayloadPreview,
  sliceKeepingPairs,
  toolCallSecretKeyRule,
} from '@nexttime/shared';
import {
  REDACTED,
  type RedactedValue,
  STORED_REWRITE_SECRET_PATTERNS,
  type Scrubbed,
  redactSecretFieldsInJsonText,
  redactSecrets,
  safeStringify,
  scrubOutsideSpans,
  scrubSecretLiterals,
  scrubSecretValues,
  scrubbedCut,
  secretFieldLiterals,
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
 * (`namesASecretField`), or a param the capability itself declares secret (`redactedParamKeys` —
 * the same list `dispatch.ts` keeps out of the audit log), has every string and number under it
 * replaced, whatever it looks like. A value hidden in the arguments stays hidden in the result,
 * however the result repeats it (legacy 185 — #526's "hidden == counted == masked"): the same key
 * rule runs over a result's text when that text is JSON (`redactSecretFieldsInJsonText` — a
 * capability tool's text is its result as JSON, and an ActionRequest's echoes its `params`; its
 * strings that hold an escape are scrubbed decoded too, legacy 916 — a line of output follows a
 * `\n` there), and the arguments' hidden values are hidden as literals wherever else they appear
 * (`secretFieldLiterals` — a URL or command a gate rendered from them, an error quoting one).
 *
 * Size, and time: a runtime frame may be up to 100 MiB, and redaction runs on the kernel's event
 * loop. So nothing past what is shown is read at all: a payload is read up to its preview length
 * plus `SECRET_MARGIN_CHARS`, scrubbed, then cut to the preview length — the margin keeps the
 * preview full however many secrets before the cut were replaced by shorter text. The live stream
 * shows the same bounded, scrubbed copy. A stored reply is scrubbed whole up to
 * `MESSAGE_TEXT_MAX_CHARS`, past which it is cut. Wherever reading stops inside a string, the copy
 * never ends in the start of a secret (legacy 819, `scrubbedCut`): a secret the stop crosses is read
 * whole and replaced, and one that reading stopped in is left out.
 */

/** Characters of a call's arguments kept in its record. */
export const TOOL_CALL_ARGS_PREVIEW_CHARS = 4_000;
/** Characters of a call's result kept in its record. */
export const TOOL_CALL_RESULT_PREVIEW_CHARS = 16_000;
/** Read past a preview's length before cutting it — longer than any secret replaced whole (a PEM
 *  RSA-4096 private key is ~3.3k characters, a Handle well under 2k), so replacements before the
 *  cut rarely leave the preview short. */
export const SECRET_MARGIN_CHARS = 4_096;
/** A stored reply's text fields are kept up to this length (256 Ki characters — far above what a
 *  model writes in one answer); past it the rest is cut, so scrubbing it stays bounded. */
export const MESSAGE_TEXT_MAX_CHARS = 262_144;

const ARGS_READ_CHARS = TOOL_CALL_ARGS_PREVIEW_CHARS + SECRET_MARGIN_CHARS;
const RESULT_READ_CHARS = TOOL_CALL_RESULT_PREVIEW_CHARS + SECRET_MARGIN_CHARS;

/** The key rule for one tool's payloads: a key the capability declares secret, or one whose name
 *  names a secret (`@nexttime/shared`'s `toolCallSecretKeyRule` — worker mode applies the same
 *  rule to a call before it sends it, legacy 155). */
function secretKeyRule(toolName: string | null | undefined): (key: string) => boolean {
  return toolCallSecretKeyRule(toolName);
}

function redactPayload(value: unknown, toolName: string | null | undefined, maxChars: number) {
  return redactSecrets(value, { isSecretKey: secretKeyRule(toolName), maxChars });
}

/** How one call's result is scrubbed: the key rule, and the values its arguments hid. */
interface ResultRule {
  readonly isSecretKey: (key: string) => boolean;
  readonly literals: readonly string[];
}

function resultRule(toolName: string | null | undefined, args: unknown): ResultRule {
  const isSecretKey = secretKeyRule(toolName);
  return {
    isSecretKey,
    literals: args === undefined ? [] : secretFieldLiterals(args, isSecretKey),
  };
}

/** The arguments' hidden values as literals, then every secret-looking value. */
function scrubWithResultRule(text: string, rule: ResultRule): Scrubbed<string> {
  const literals = scrubSecretLiterals(text, rule.literals);
  const values = scrubSecretValues(literals.value);
  return {
    value: values.value,
    redactedValues: literals.redactedValues + values.redactedValues,
  };
}

/** One of a result's text parts — read only up to its bound. When it is JSON: the key rule, and
 *  its strings that hold an escape scrubbed decoded (legacy 916 — `redactSecretFieldsInJsonText`'s
 *  `scrubValue`); then the rest of the text as it is, with the same scrub (`scrubWithResultRule`),
 *  so a value counts the same wherever it is found. */
function scrubResultText(text: string, rule: ResultRule): Scrubbed<string> {
  const fields = redactSecretFieldsInJsonText(text, rule.isSecretKey, (value) =>
    scrubWithResultRule(value, rule),
  );
  const rest = scrubOutsideSpans(fields.value, fields.decodedSpans, (part) =>
    scrubWithResultRule(part, rule),
  );
  return { value: rest.value, redactedValues: fields.redactedValues + rest.redactedValues };
}

/** A tool call's arguments with secret-looking keys and values replaced, read only as far as their
 *  record shows — the shape is kept, so the live console renders it as before, except that past
 *  the read bound the rest of an object or array is one `[…]` entry or item (`redactSecrets`'s
 *  `maxChars`). */
export function redactToolArgs(value: unknown, toolName?: string | null): RedactedValue {
  return redactPayload(value, toolName, ARGS_READ_CHARS);
}

/** A tool call's result, likewise — a string that is JSON (pi's text parts) with the same key
 *  rule, and every value `args` (the call's arguments, when known) hid hidden wherever the result
 *  repeats it. One walk does all of it, so the key rule reads what the walk reads: before legacy
 *  819 the text parts were masked up to the bound first and the rest of each appended as it was,
 *  and a walk that then read past the masked part (masking shortens) showed it unmasked. */
export function redactToolResult(
  value: unknown,
  toolName?: string | null,
  args?: unknown,
): RedactedValue {
  const rule = resultRule(toolName, args);
  return redactSecrets(value, {
    isSecretKey: rule.isSecretKey,
    jsonTextFields: true,
    literals: rule.literals,
    maxChars: RESULT_READ_CHARS,
  });
}

/** `[redacted]"…\"`: a quoted value the value patterns split when they read JSON text as it is
 *  written (before legacy 916) — `API_TOKEN=\"…\"` became `API_TOKEN=[redacted]"…\"`, the `\`
 *  taken for the value and the value itself kept. Between `[redacted]"` and the next `\"` there
 *  is no quote that is not escaped: in JSON that is valid, a string's closing quote is followed,
 *  before any `\"`, by the opening quote of the next string, or by nothing. */
const SPLIT_QUOTED_MASK = new RegExp(
  String.raw`${REDACTED.replace(/[[\]]/g, '\\$&')}"(?:[^"\\]|\\[^"])*\\"`,
  'g',
);

/** A stored result's text with each `SPLIT_QUOTED_MASK` written as the value patterns write that
 *  value now — `\"[redacted]\"` — counted (legacy 916; one-way, like the rest of the rewrite). */
function repairSplitQuotedMasks(text: string): Scrubbed<string> {
  let redactedValues = 0;
  const value = text.replace(SPLIT_QUOTED_MASK, () => {
    redactedValues += 1;
    return `\\"${REDACTED}\\"`;
  });
  return { value, redactedValues };
}

/**
 * A tool-call record stored before legacy 185 (`chat_messages.content`, kind `tool_call`) with its
 * result preview scrubbed the way `buildToolCallRecord` scrubs one now: the key rule over JSON text
 * (its tool's declared keys, or a secret-naming key), with its escaped strings decoded (legacy
 * 916), then every secret-looking value but a platform API key standing alone
 * (`STORED_REWRITE_SECRET_PATTERNS`: the rewrite is one-way and that shape is any 32 bytes in
 * base64url, so `cli/scrub-raw-secrets.ts` counts it instead — legacy 168 review). First, a quoted
 * value the text pass split before legacy 916 is written as it is written now
 * (`repairSplitQuotedMasks`).
 * What the record cannot give back is the values its arguments hid (its `args` copy is masked), so a
 * result that quoted one in prose keeps it. `redactedValues` is added to the record's own count.
 * `cli/scrub-raw-secrets.ts` rewrites stored records with it.
 */
export function rescrubStoredToolCallResult(
  content: Record<string, unknown>,
): Scrubbed<Record<string, unknown>> {
  const result = content.result as { text?: unknown } | null | undefined;
  if (content.kind !== TOOL_CALL_MESSAGE_KIND || typeof result?.text !== 'string') {
    return { value: content, redactedValues: 0 };
  }
  const name = typeof content.name === 'string' ? content.name : null;
  const stored = (text: string) =>
    scrubSecretValues(text, { patterns: STORED_REWRITE_SECRET_PATTERNS });
  const repaired = repairSplitQuotedMasks(result.text);
  const fields = redactSecretFieldsInJsonText(repaired.value, secretKeyRule(name), stored);
  const values = scrubOutsideSpans(fields.value, fields.decodedSpans, stored);
  const redactedValues = repaired.redactedValues + fields.redactedValues + values.redactedValues;
  if (values.value === result.text) return { value: content, redactedValues: 0 };
  const previous = typeof content.redactedValues === 'number' ? content.redactedValues : 0;
  return {
    value: {
      ...content,
      result: { ...result, text: values.value },
      redactedValues: previous + redactedValues,
    },
    redactedValues,
  };
}

/** A runtime `message`'s content with secrets scrubbed from its string fields (only the values;
 *  a reply has no secret-named keys to replace) — each past `MESSAGE_TEXT_MAX_CHARS` cut there
 *  (`scrubbedCut`: it reads `CUT_LOOKAHEAD_CHARS` further, so the cut never leaves the start of a
 *  secret). The agent can be talked into repeating its own Handle in its answer as easily as into
 *  running `env`. `cut` says whether any field was cut. */
export function redactMessageContent(
  content: Record<string, unknown>,
): Scrubbed<Record<string, unknown>> & { readonly cut: boolean } {
  let redactedValues = 0;
  let cut = false;
  const out: Record<string, unknown> = {};
  const scrub = (text: string): string => {
    const scrubbed = scrubSecretValues(text);
    redactedValues += scrubbed.redactedValues;
    return scrubbed.value;
  };
  for (const [key, value] of Object.entries(content)) {
    if (typeof value !== 'string') out[key] = value;
    else if (value.length <= MESSAGE_TEXT_MAX_CHARS) out[key] = scrub(value);
    else {
      cut = true;
      out[key] = `${scrubbedCut(value, MESSAGE_TEXT_MAX_CHARS, scrub)}…`;
    }
  }
  return { value: out, redactedValues, cut };
}

/** `text` (already scrubbed) cut to `limit`, never through a surrogate pair (legacy 834).
 *  `totalChars` is how long the payload was before anything was cut — at least that long when
 *  part of it was never read (`unread`). */
function preview(
  text: string,
  limit: number,
  totalChars: number,
  unread: boolean,
): ToolCallPayloadPreview {
  return {
    text: text.length <= limit ? text : sliceKeepingPairs(text, limit),
    totalChars,
    truncated: unread || text.length > limit,
  };
}

/** pi's tool result is `{content: [{type:'text', text}, …], details}`: the model saw the text
 *  parts, so the record shows those (a non-text part as `[image]` etc.), each read up to what is
 *  left of `readChars` and scrubbed (`scrubResultText` — a part that is JSON gets the key rule
 *  too; the part reading stops in is cut by `scrubbedCut`). `undefined` when the result has no
 *  such parts. */
function resultContentText(
  result: unknown,
  readChars: number,
  rule: ResultRule,
):
  | {
      readonly text: string;
      readonly totalChars: number;
      readonly readAll: boolean;
      readonly redactedValues: number;
    }
  | undefined {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  let text = '';
  let read = 0;
  let totalChars = 0;
  let parts = 0;
  let redactedValues = 0;
  for (const part of content) {
    const record = part as { type?: unknown; text?: unknown } | null;
    let partText: string;
    if (record?.type === 'text' && typeof record.text === 'string') partText = record.text;
    else if (typeof record?.type === 'string') partText = `[${record.type}]`;
    else continue;
    const separator = parts > 0 ? '\n' : '';
    parts += 1;
    totalChars += separator.length + partText.length;
    if (read >= readChars) continue;
    const room = Math.max(0, readChars - read - separator.length);
    read += separator.length + Math.min(partText.length, room);
    const scrub = (part: string): string => {
      const scrubbed = scrubResultText(part, rule);
      redactedValues += scrubbed.redactedValues;
      return scrubbed.value;
    };
    // Reading stops inside this part: never in the start of a secret (legacy 819).
    if (partText.length <= room) text += separator + scrub(partText);
    else text += separator + (room > 0 ? scrubbedCut(partText, room, scrub) : '');
  }
  return parts > 0 ? { text, totalChars, readAll: read >= totalChars, redactedValues } : undefined;
}

/** A result as redacted text: its content text scrubbed, or — with no content text — the result
 *  itself redacted key by key and serialized. */
function redactedResultPreview(
  result: unknown,
  toolName: string | null,
  args: unknown,
): Scrubbed<ToolCallPayloadPreview> {
  const contentText = resultContentText(result, RESULT_READ_CHARS, resultRule(toolName, args));
  if (contentText !== undefined) {
    return {
      value: preview(
        contentText.text,
        TOOL_CALL_RESULT_PREVIEW_CHARS,
        contentText.totalChars,
        !contentText.readAll,
      ),
      redactedValues: contentText.redactedValues,
    };
  }
  const redacted = redactToolResult(result, toolName, args);
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
    const redacted = redactedResultPreview(
      input.result,
      input.name,
      input.hasArgs ? input.args : undefined,
    );
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
