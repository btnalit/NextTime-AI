import type { AgentRuntimeEventWire } from '@nexttime/shared';

/**
 * bridge: pi's own RPC event vocabulary (`docs/rpc.md`, pi 0.84.4 — see below for exactly which
 * source paths this was verified against) translated into the platform's `AgentRuntimeEvent`
 * vocabulary (`@nexttime/shared`'s `AgentRuntimeEventWire`, mirroring
 * `packages/kernel/src/application/host-bridge/agent-runtime.ts`'s `AgentRuntimeEventFields`).
 * This is the **one** place that translation happens (design doc §7.10 "运行时适配层 ... 让 chat 与
 * web 永远看不到 pi 的事件名" — this task's dispatch text repeats the same requirement explicitly)
 * — `host.ts` never inspects a pi event's `type` field itself; it only ever calls
 * `translatePiEvent` and acts on the result.
 *
 * Verified against pi 0.84.4's own source (not guessed from `docs/rpc.md` alone):
 *   - `pi-0.84.4/packages/coding-agent/docs/rpc.md` — the JSONL command/event contract itself
 *     (framing, command/event shapes) this whole module is built against.
 *   - `pi-0.84.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts` — confirms the RPC mode process
 *     writes exactly the event shapes `docs/rpc.md` documents to stdout, one JSON object per line.
 *   - `pi-0.84.4/packages/coding-agent/src/modes/rpc/rpc-types.ts` — the RPC command/event/
 *     extension-UI TypeScript types backing `docs/rpc.md`'s own prose.
 *   - `pi-0.84.4/packages/platform-extension` equivalent, i.e. `packages/platform-extension/src/
 *     modes/entry.ts` (this repo, not pi's) — the *other* consumer of this exact event stream
 *     inside the container itself: its own `extractAssistantText`/`summarizeAgentEndMessages`
 *     helpers and its choice to key one platform Turn off `agent_start`/`agent_settled` (not pi's
 *     own `turn_start`/`turn_end`, which can repeat within one run across a tool-calling loop) are
 *     the precedent this module's `extractAssistantText` and "settle on `agent_settled`" choice
 *     below both follow, for consistency between the two independent consumers of the same stream.
 *
 * Scope decisions (see PR body "假设与偏离"):
 *   - Only `assistantMessageEvent.type === 'text_delta'` from `message_update` becomes a
 *     `textDelta` — every other streaming sub-type (`thinking_*`, `toolcall_*`, `text_start`/
 *     `text_end`) is dropped: tool-call boundaries are already reported precisely by the discrete
 *     `tool_execution_start`/`tool_execution_end` events (which carry the full name/args/result,
 *     unlike the incremental `toolcall_delta` argument fragments), and thinking deltas have no
 *     platform vocabulary slot in S1.
 *   - `message_end` becomes a persisted `message` event only for `role: 'assistant'` content with
 *     non-empty extracted text — an assistant message that is *only* tool calls (no text content)
 *     produces no persisted message (nothing textual to show; the tool activity itself already
 *     went out live via `toolCallStarted`/`toolCallEnded`). `role: 'toolResult'` is deliberately
 *     never translated to the platform's `message {role:'tool'}` variant: `FakeAgentRuntime`
 *     (S1.4) never emits that role either, so this keeps the real and fake runtimes' persisted-
 *     history shape aligned — a future task can revisit this table's own module doc note (right
 *     there in agent-runtime.ts) if a real need for a persisted tool-result transcript emerges.
 *   - One platform Turn = one pi `agent_start`...`agent_settled` run, exactly like
 *     `platform-extension/src/modes/entry.ts`'s own `nexttime_turn` bookkeeping — `agent_settled`
 *     is what ends a Turn, not `agent_end` (which can fire more than once per Turn: auto-retry,
 *     auto-compaction retry, and queued follow-ups each start a new low-level run before the
 *     session actually settles, `docs/rpc.md`'s own `agent_end`/`agent_settled` distinction).
 */

/** `Omit` over each union member individually (plain `Omit<Union, K>` collapses to `keyof Union`'s
 *  *intersection* — only `type` plus the four correlation fields every variant shares — losing
 *  every variant-specific field like `delta`/`toolCallId`/`role`; this distributes first). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** The event-specific fields of one translated `AgentRuntimeEvent` — `host.ts` attaches the four
 *  correlation fields (`workspaceId`/`chatId`/`turnId`/`principalId`) it already tracks for the
 *  turn currently in flight for a given principal. */
export type TranslatedEventFields = DistributiveOmit<
  AgentRuntimeEventWire,
  'workspaceId' | 'chatId' | 'turnId' | 'principalId'
>;

export type BridgeResult =
  | { readonly kind: 'event'; readonly fields: TranslatedEventFields }
  /** pi's `agent_settled` — the platform Turn has finished running (from pi's own point of view;
   *  `host.ts` still decides the final `TurnEndStatus` — `interrupted` if a `stopTurn` was
   *  requested for this turn, `completed` otherwise — since that is orchestration state this
   *  stateless translator does not hold). */
  | { readonly kind: 'turnSettled' }
  /** Every other pi event this module has no platform vocabulary slot for
   *  (`agent_start`/`agent_end`/`turn_start`/`turn_end`/`message_start`/other `message_end`
   *  roles/`bash_execution_update`/`queue_update`/`compaction_*`/`auto_retry_*`/
   *  `summarization_retry_*`/`extension_ui_request`/anything unrecognized). */
  | { readonly kind: 'none' };

interface PiTextContentPart {
  readonly type: 'text';
  readonly text: string;
}

function isTextContentPart(value: unknown): value is PiTextContentPart {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string';
}

/** Joins every `text`-type content part of one pi `AgentMessage.content` into a single string —
 *  mirrors `platform-extension/src/modes/entry.ts`'s own `extractAssistantText` (duplicated, not
 *  imported: agent-host and platform-extension are independently deployed processes — see this
 *  module's own doc comment). `content` may also be a bare string (pi's `UserMessage.content`
 *  shape; not expected here since this is only ever called for `role: 'assistant'`, but handled
 *  defensively since this reads untyped stdout JSON). */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextContentPart)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function translateMessageUpdate(event: Record<string, unknown>): BridgeResult {
  const assistantMessageEvent = asRecord(event.assistantMessageEvent);
  if (!assistantMessageEvent || assistantMessageEvent.type !== 'text_delta') {
    return { kind: 'none' };
  }
  const delta = assistantMessageEvent.delta;
  if (typeof delta !== 'string' || delta.length === 0) return { kind: 'none' };
  return { kind: 'event', fields: { type: 'textDelta', delta } };
}

function translateToolExecutionStart(event: Record<string, unknown>): BridgeResult {
  const toolCallId = event.toolCallId;
  const toolName = event.toolName;
  if (typeof toolCallId !== 'string' || typeof toolName !== 'string') return { kind: 'none' };
  return {
    kind: 'event',
    fields: { type: 'toolCallStarted', toolCallId, name: toolName, args: event.args },
  };
}

function translateToolExecutionEnd(event: Record<string, unknown>): BridgeResult {
  const toolCallId = event.toolCallId;
  if (typeof toolCallId !== 'string') return { kind: 'none' };
  return { kind: 'event', fields: { type: 'toolCallEnded', toolCallId, result: event.result } };
}

function translateMessageEnd(event: Record<string, unknown>): BridgeResult {
  const message = asRecord(event.message);
  if (!message || message.role !== 'assistant') return { kind: 'none' };
  const text = extractAssistantText(message.content);
  if (!text) return { kind: 'none' };
  return { kind: 'event', fields: { type: 'message', role: 'assistant', content: { text } } };
}

/** Translates one already-JSON-parsed line of pi's RPC stdout. `raw` is untyped — every field is
 *  read defensively (a malformed/unexpected shape degrades to `{kind:'none'}`, never throws). */
export function translatePiEvent(raw: unknown): BridgeResult {
  const event = asRecord(raw);
  if (!event || typeof event.type !== 'string') return { kind: 'none' };

  switch (event.type) {
    case 'message_update':
      return translateMessageUpdate(event);
    case 'tool_execution_start':
      return translateToolExecutionStart(event);
    case 'tool_execution_end':
      return translateToolExecutionEnd(event);
    case 'message_end':
      return translateMessageEnd(event);
    case 'agent_settled':
      return { kind: 'turnSettled' };
    default:
      return { kind: 'none' };
  }
}

/** The `prompt` RPC command for one Turn's user message (`docs/rpc.md` "prompt"). `id` is set to
 *  the platform `turnId` itself — a convenient, already-unique correlation key `host.ts` uses to
 *  recognize the matching `{"type":"response","command":"prompt","id":...}` acknowledgement (pi's
 *  own "accepted, queued, or handled" signal — `docs/rpc.md`: "Failures after acceptance are
 *  reported through the normal event and message stream, not as a second response for the same
 *  request id") as the real, pi-confirmed `turnAccepted`/`turnRejected` signal, rather than
 *  treating "the bytes were written to the container's stdin" alone as acceptance. `message`
 *  already carries the `<!--nexttime:turn_id=...-->` marker
 *  (`packages/kernel/src/application/host-bridge/turn-started-consumer.ts` prefixes it before
 *  `AgentHostRuntime.startTurn` is ever called — this module receives `input.prompt` already
 *  marked and forwards it verbatim). */
export function buildPromptCommand(turnId: string, message: string): Record<string, unknown> {
  return { type: 'prompt', id: turnId, message };
}

/** The `abort` RPC command (`docs/rpc.md` "abort" — "Abort the current agent operation"). */
export function buildAbortCommand(): Record<string, unknown> {
  return { type: 'abort' };
}
