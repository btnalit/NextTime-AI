import type {
  ToolCallMessageContent,
  ToolCallOutcome,
  ToolCallPayloadPreview,
} from '@nexttime/shared';
import type { ChatMessage } from './ws-client.js';

/**
 * lib/tool-call-record: the persisted tool-call rows a Turn leaves in its chat history
 * (`role: 'tool'`, `content.kind: 'tool_call'`, `ToolCallMessageContentSchema` in
 * `@nexttime/shared`) — narrowed here by hand rather than with the Zod schema, following this
 * package's "no shared Zod at runtime" convention (`lib/ws-client.ts`'s `ChatMessage` doc).
 *
 * A record is the agent runtime's own report of one tool call, redacted and cut to a preview by
 * the kernel. It is not the authoritative record of a capability call — that is the audit trail —
 * so the page labels the group as reported by the agent.
 */

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly name: string | null;
  readonly outcome: ToolCallOutcome;
  readonly args?: ToolCallPayloadPreview;
  readonly result?: ToolCallPayloadPreview;
  readonly redactedValues: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

const OUTCOMES: ReadonlySet<string> = new Set<ToolCallOutcome>(['done', 'failed', 'not_finished']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preview(value: unknown): ToolCallPayloadPreview | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { text, totalChars, truncated } = value;
  if (typeof text !== 'string' || typeof totalChars !== 'number' || typeof truncated !== 'boolean')
    return null;
  return { text, totalChars, truncated };
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** The record a `role: 'tool'` message carries, or `null` when it is not a well-formed one — the
 *  caller then renders the message as an ordinary row. */
export function toolCallRecordFromMessage(message: ChatMessage): ToolCallRecord | null {
  if (message.role !== 'tool') return null;
  const content: unknown = message.content;
  if (!isRecord(content) || content.kind !== ('tool_call' satisfies ToolCallMessageContent['kind']))
    return null;
  const { toolCallId, name, outcome, redactedValues } = content;
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null;
  if (name !== null && typeof name !== 'string') return null;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null;
  if (typeof redactedValues !== 'number' || redactedValues < 0) return null;
  const args = preview(content.args);
  const result = preview(content.result);
  const startedAt = nullableString(content.startedAt);
  const endedAt = nullableString(content.endedAt);
  if (args === null || result === null || startedAt === undefined || endedAt === undefined)
    return null;
  return {
    toolCallId,
    name,
    outcome: outcome as ToolCallOutcome,
    ...(args ? { args } : {}),
    ...(result ? { result } : {}),
    redactedValues,
    startedAt,
    endedAt,
  };
}

export type ThreadItem =
  | { readonly kind: 'message'; readonly message: ChatMessage }
  | {
      readonly kind: 'tools';
      /** The first record's sequence — stable while more records of the same Turn arrive. */
      readonly key: number;
      readonly turnId: string | null;
      readonly records: readonly ToolCallRecord[];
    };

/** Folds each run of consecutive tool-call records of one Turn into a single group, in thread
 *  order; every other message stays its own item. The kernel writes a Turn's records as each call
 *  ends, so they precede that Turn's reply. */
export function threadItems(messages: readonly ChatMessage[]): readonly ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const message of messages) {
    const record = toolCallRecordFromMessage(message);
    if (!record) {
      items.push({ kind: 'message', message });
      continue;
    }
    const turnId = message.turnId ?? null;
    const last = items.at(-1);
    if (last?.kind === 'tools' && last.turnId === turnId) {
      items[items.length - 1] = { ...last, records: [...last.records, record] };
    } else {
      items.push({ kind: 'tools', key: message.sequence, turnId, records: [record] });
    }
  }
  return items;
}

/** The tool calls already persisted — the running Turn's live rows for these are hidden, so one
 *  call is never shown twice. */
export function persistedToolCallIds(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const record = toolCallRecordFromMessage(message);
    if (record) ids.add(record.toolCallId);
  }
  return ids;
}

/** A preview's text, indented when it is JSON (a capability tool's result is), as-is otherwise.
 *  A cut preview is not valid JSON and stays as it came. */
export function previewDisplayText(value: ToolCallPayloadPreview): string {
  if (value.truncated) return value.text;
  const trimmed = value.text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value.text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value.text;
  }
}
