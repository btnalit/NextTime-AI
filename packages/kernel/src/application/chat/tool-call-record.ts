import {
  TOOL_CALL_MESSAGE_KIND,
  type ToolCallMessageContent,
  type ToolCallOutcome,
  type ToolCallPayloadPreview,
  getCapability,
} from '@nexttime/shared';

/**
 * application/chat/tool-call-record: what the chat event sink stores for one of a Turn's tool
 * calls (`role='tool'`, `kind: 'tool_call'` — `@nexttime/shared`'s `ToolCallMessageContent`), and
 * the redaction the same sink applies to the live `chat.stream` tool deltas.
 *
 * **Why redaction runs here.** A tool's arguments and result come from the agent container, which
 * runs pi's built-in `bash`/`read` next to its own Handle (`CAPABILITY_HANDLE` in its environment).
 * One `env` — a prompt-injected one included — puts that Handle into a tool result. Without this,
 * the result went out on `chat.stream` to every subscriber of the Chat (every member, for a
 * workspace-visible Chat), and a stored record would keep it for anyone who can read the history.
 * The kernel is the trust boundary, so the kernel scrubs; the console's own `redactSensitive` is
 * display-only and matches keys, not values. The agent's stored reply gets the same value scrub
 * (`redactMessageContent`). Live `textDelta`s do not: a token arrives split across deltas, so a
 * per-delta scrub would miss it — the stored reply replaces the streamed text when the Turn ends.
 *
 * What is replaced:
 *   - an object key that names a secret (`SENSITIVE_KEY`), or a param the capability itself
 *     declares secret (`redactedParamKeys` — the same list `dispatch.ts` keeps out of the audit
 *     log), whatever its value;
 *   - inside any string: a compact JWT (a Handle is one), an `Authorization`-style `Bearer`/`Basic`
 *     value, a PEM private key, a vendor key with a well-known prefix, a `NAME=value` assignment
 *     whose name names a secret (an `env` dump, a config line, a query string), the password in
 *     a `scheme://user:password@host` URL, and a quoted `"…token…": "…"` pair inside text that is
 *     itself JSON.
 * Over-redaction is the accepted failure mode: a value that only looks like a secret is hidden.
 *
 * Size: each preview is cut at a fixed length after redaction, so one call's record stays a few
 * kilobytes whatever the tool returned. The walk over a structured value is bounded too
 * (`MAX_WALK_NODES`); past the bound the rest is serialized and scrubbed as text.
 */

/** Characters of a call's arguments kept in its record. */
export const TOOL_CALL_ARGS_PREVIEW_CHARS = 4_000;
/** Characters of a call's result kept in its record. */
export const TOOL_CALL_RESULT_PREVIEW_CHARS = 16_000;
/** Nodes of a structured value visited key by key before the rest is scrubbed as text. */
const MAX_WALK_NODES = 5_000;

export const REDACTED = '[redacted]';

/** Same family as the console's `SENSITIVE_KEY` (packages/web/src/lib/format.ts), plus `handle`
 *  — a field named after a Handle carries one. */
const SENSITIVE_KEY =
  /credential|secret|token|password|passwd|api[_-]?key|authorization|private[_-]?key|^handle$|capability[_-]?handle/i;

interface ValuePattern {
  readonly pattern: RegExp;
  readonly replace: string;
}

/** Applied in order to every string. Each pattern is global; `replace` may use `$1`. */
const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: REDACTED,
  },
  // A compact JWS/JWT: three base64url segments, the first a JSON header (`{"` → `eyJ`).
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, replace: REDACTED },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1 ${REDACTED}` },
  {
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,})/g,
    replace: REDACTED,
  },
  // `PGPASSWORD=…`, `CAPABILITY_HANDLE=…`, `export API_TOKEN=…` — an `env` / `.env` line. Upper
  // case only, the env-var convention: `max_tokens=1024` in ordinary text stays.
  {
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIALS?|HANDLE)[A-Z0-9_]*)=(?!\[redacted\])[^\s'"]+/g,
    replace: `$1=${REDACTED}`,
  },
  // `password=…` / `api_key=…` as a whole word, any case — a config line or a query string.
  {
    pattern:
      /\b(password|passwd|secret|token|api_?key|access_?token|client_?secret)=(?!\[redacted\])[^\s&'"]+/gi,
    replace: `$1=${REDACTED}`,
  },
  // `scheme://user:password@host` — keeps the user, drops the password.
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, replace: `$1:${REDACTED}@` },
  // `"api_key": "…"` inside a string that is itself JSON text (a capability tool's result text).
  {
    pattern:
      /("[^"\\]*(?:credential|secret|token|password|passwd|api[_-]?key|authorization|private[_-]?key)[^"\\]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    replace: `$1"${REDACTED}"`,
  },
];

interface Redaction {
  count: number;
  budget: number;
}

function scrubString(text: string, state: Redaction): string {
  let out = text;
  for (const { pattern, replace } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (...match: unknown[]) => {
      state.count += 1;
      // `$1` is the only group any pattern refers to.
      const group = typeof match[1] === 'string' ? match[1] : '';
      return replace.replace('$1', group);
    });
  }
  return out;
}

function redactValue(
  value: unknown,
  sensitiveKeys: ReadonlySet<string>,
  state: Redaction,
): unknown {
  if (typeof value === 'string') return scrubString(value, state);
  if (value === null || typeof value !== 'object') return value;
  state.budget -= 1;
  if (state.budget < 0) {
    // Past the walk bound: what is left is kept as scrubbed text, never unscrubbed.
    return scrubString(safeStringify(value), state);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, sensitiveKeys, state));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKeys.has(key) || SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
      state.count += 1;
    } else {
      out[key] = redactValue(inner, sensitiveKeys, state);
    }
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The keys a capability declares secret (`Capability.redactedParamKeys`), when `toolName` is a
 *  capability tool — entry and interactive mode name each capability tool after its capability. */
function capabilitySensitiveKeys(toolName: string | null | undefined): ReadonlySet<string> {
  const keys = toolName ? getCapability(toolName)?.redactedParamKeys : undefined;
  return new Set(keys ?? []);
}

export interface RedactedPayload {
  readonly value: unknown;
  readonly redactedValues: number;
}

/** A tool call's arguments or result with secret-looking keys and values replaced — the shape is
 *  kept, so the live console renders it as before. */
export function redactToolPayload(value: unknown, toolName?: string | null): RedactedPayload {
  const state: Redaction = { count: 0, budget: MAX_WALK_NODES };
  const redacted = redactValue(value, capabilitySensitiveKeys(toolName), state);
  return { value: redacted, redactedValues: state.count };
}

/** A runtime `message`'s content with secrets scrubbed from its string fields (only the values;
 *  a reply has no secret-named keys to replace). The agent can be talked into repeating its own
 *  Handle in its answer as easily as into running `env`. */
export function redactMessageContent(content: Record<string, unknown>): {
  readonly content: Record<string, unknown>;
  readonly redactedValues: number;
} {
  const state: Redaction = { count: 0, budget: MAX_WALK_NODES };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    out[key] = typeof value === 'string' ? scrubString(value, state) : value;
  }
  return { content: out, redactedValues: state.count };
}

function preview(text: string, limit: number): ToolCallPayloadPreview {
  if (text.length <= limit) return { text, totalChars: text.length, truncated: false };
  return { text: text.slice(0, limit), totalChars: text.length, truncated: true };
}

/** pi's tool result is `{content: [{type:'text', text}, …], details}`: the model saw the text
 *  parts, so the record shows those (a non-text part as `[image]` etc.). `undefined` when the
 *  result has no such parts. */
function resultContentText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    const record = part as { type?: unknown; text?: unknown } | null;
    if (record?.type === 'text' && typeof record.text === 'string') return [record.text];
    if (typeof record?.type === 'string') return [`[${record.type}]`];
    return [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** A result as redacted text: its content text scrubbed, or — with no content text — the result
 *  itself redacted key by key and serialized. */
function redactedResultText(result: unknown, toolName: string | null): RedactedText {
  const state: Redaction = { count: 0, budget: MAX_WALK_NODES };
  const contentText = resultContentText(result);
  let text: string;
  if (contentText !== undefined) {
    text = scrubString(contentText, state);
  } else {
    const redacted = redactValue(result, capabilitySensitiveKeys(toolName), state);
    text = typeof redacted === 'string' ? redacted : safeStringify(redacted);
  }
  return { text, redactedValues: state.count };
}

interface RedactedText {
  readonly text: string;
  readonly redactedValues: number;
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

/** The persisted record of one tool call: both payloads redacted, then cut to their preview
 *  length (redaction first, so a cut never leaves half a secret behind). */
export function buildToolCallRecord(input: ToolCallRecordInput): ToolCallMessageContent {
  let redactedValues = 0;
  let args: ToolCallPayloadPreview | undefined;
  if (input.hasArgs) {
    const redacted = redactToolPayload(input.args, input.name);
    redactedValues += redacted.redactedValues;
    args = preview(safeStringify(redacted.value), TOOL_CALL_ARGS_PREVIEW_CHARS);
  }
  let result: ToolCallPayloadPreview | undefined;
  if (input.hasResult) {
    const redacted = redactedResultText(input.result, input.name);
    redactedValues += redacted.redactedValues;
    result = preview(redacted.text, TOOL_CALL_RESULT_PREVIEW_CHARS);
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
