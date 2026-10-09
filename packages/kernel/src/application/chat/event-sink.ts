import type { PoolLike } from '../../adapters/db/pool.js';
import { withWorkspace } from '../../adapters/db/pool.js';
import {
  type SecretStreamScrubber,
  createSecretStreamScrubber,
} from '../../governance/redaction/index.js';
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from '../host-bridge/index.js';
import { publishChatPushEvent } from './push.js';
import {
  type ChatMessageRow,
  chatMessageKind,
  chatMessageText,
  insertChatMessage,
  insertToolCallMessage,
} from './service.js';
import {
  buildToolCallRecord,
  redactMessageContent,
  redactToolArgs,
  redactToolResult,
} from './tool-call-record.js';
import {
  type EndedTurn,
  type MessagePersistFailure,
  endTurn,
  publishTurnEnded,
  recordMessagePersistFailure,
} from './turn-recovery.js';

/**
 * application/chat/event-sink: `createChatEventSink` implements `application/host-bridge`'s
 * `AgentRuntimeEventSink` (design doc §7.2 "chat 只消费平台事件"; docs/development-tasks.md S1.4
 * deliverable 2 "Turn completion path: consumes the runtime's platform events ... to persist
 * assistant/tool messages ... push chat.stream deltas ... then endActivity(status) + TurnEnded").
 *
 * This is the *only* place `application/chat` and `application/host-bridge` meet, and even here
 * neither module imports the other's internals — `application/chat` implements a port
 * `application/host-bridge` declares (`AgentRuntimeEventSink`), and `packages/kernel/src/index.ts`
 * (the composition root) is the one place that constructs this sink and hands it to
 * `FakeAgentRuntime`'s constructor. See host-bridge/index.ts's own doc comment for the full
 * wiring picture.
 *
 * Runs outside any HTTP/WS request's transaction: an `AgentRuntime` emits these events on its own
 * schedule (a timer, in `FakeAgentRuntime`'s case; a real event stream from agent-host once S1.5
 * lands), not inside a request handler — so, unlike every `CAPABILITY_HANDLERS` entry in
 * gateway/handlers.ts, this sink opens its own `withWorkspace()` transaction per persisted write
 * rather than receiving an already-open `client`.
 *
 * A `message` it cannot store (legacy 128): the runtime acknowledged the frame on arrival, so
 * agent-host will not send it again, and a later `completed` for the Turn would claim an answer the
 * history does not have. The sink records the loss on the Turn (`recordMessagePersistFailure`, its
 * own transaction — the insert's rolled back) so `endTurn` ends it `failed`, logs it, and does not
 * throw: the Turn stays running until the runtime reports its end, and later messages are still
 * stored. When the record cannot be written either (the database is unreachable), the loss is kept
 * here and written in the transaction that ends the Turn, ahead of `endTurn`.
 *
 * Nothing the agent produced reaches a person unscrubbed (governance/redaction — the agent can
 * repeat its own Handle anywhere): a runtime `message` is stored with secret-looking values
 * replaced (tool-call-record.ts's `redactMessageContent`), and the live `textDelta`s go through a
 * per-Turn stream scrubber, which holds back the end of the text while it could still be part of
 * a secret split across deltas. What it holds is emitted, scrubbed, before the Turn's next event
 * of any other kind (a tool call, the stored message, the Turn's end), so the stream stays in
 * order; it is dropped when the Turn ends.
 *
 * Tool calls: `toolCallStarted`/`toolCallEnded` still go out only as `chat.stream` deltas — with
 * their arguments and result redacted first (tool-call-record.ts: an agent's `bash` can print its
 * own Handle) — and, when a call ends, one `role='tool'` record of it is stored and pushed as a
 * `chat.message`, so the Turn's tool calls survive a reload. A call still open when its Turn ends
 * is recorded `not_finished` before the Turn's end is written. A record that cannot be stored is
 * logged and skipped: it is evidence about the Turn, not its answer, so — unlike a lost `message`
 * — it does not fail the Turn. What the sink holds per Turn for this is bounded
 * (`MAX_TOOL_CALL_RECORDS_PER_TURN`) and dropped when the Turn ends.
 */

/** Tool-call records stored per Turn; calls past it go out live but are not stored (one log line).
 *  A runtime is not trusted to stop on its own — a looping agent, or a container writing forged
 *  events — and every record is a row in the Chat's history. */
export const MAX_TOOL_CALL_RECORDS_PER_TURN = 200;
/** Turns with live-text or tool-call state held at once — only reached if Turns stop ending (each
 *  `turnEnded` drops its own); past it the Turn idle longest is forgotten (`turnEntry`). */
const MAX_TRACKED_TURNS = 1_000;

interface OpenToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly hasArgs: boolean;
  readonly startedAt: Date;
}

interface TurnToolCalls {
  readonly open: Map<string, OpenToolCall>;
  /** Records written or attempted for the Turn, against `MAX_TOOL_CALL_RECORDS_PER_TURN`. */
  records: number;
  overLimitLogged: boolean;
}

export interface ChatEventSinkDeps {
  readonly pool: PoolLike;
  /** Structured log lines (JSON) — defaults to `console.error`, like `AgentHostRuntime`'s. */
  readonly log?: (line: string) => void;
}

/** A pg error's SQLSTATE, or `null` for an error without one. */
function sqlStateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** `toolName` names the capability whose declared secret params are redacted too — the call's
 *  start names it; an end carries it only from a newer runtime. */
function toChatStreamPayload(
  event: Extract<AgentRuntimeEvent, { type: 'toolCallStarted' | 'toolCallEnded' }>,
  toolName?: string,
) {
  switch (event.type) {
    case 'toolCallStarted':
      return {
        streamKind: 'toolCallStarted' as const,
        toolCallId: event.toolCallId,
        name: event.name,
        ...('args' in event ? { args: redactToolArgs(event.args, event.name).value } : {}),
      };
    case 'toolCallEnded':
      return {
        streamKind: 'toolCallEnded' as const,
        toolCallId: event.toolCallId,
        ...('result' in event ? { result: redactToolResult(event.result, toolName).value } : {}),
        ...(event.isError !== undefined ? { isError: event.isError } : {}),
      };
  }
}

/** Pushes a stored `chat_messages` row (a runtime `message` or a tool-call record) as
 *  `chat.message` — only once its transaction has committed. */
function publishStoredMessage(chatId: string, message: ChatMessageRow): void {
  publishChatPushEvent({
    type: 'chat.message',
    chatId,
    message: {
      id: message.id,
      // `message.role` is 'assistant' | 'tool' here (a runtime `message` allows only those two; a
      // tool-call record is 'tool') — a strict subset of both chat_messages.role's and the wire
      // ChatMessageEvent's four-way role enum, so this assigns without narrowing.
      role: message.role,
      text: chatMessageText(message.content),
      createdAt: message.createdAt.toISOString(),
      sequence: message.sequence,
      // Review fix (code-review finding "chat.message payload drift"): previously omitted for
      // this producer — only application/linkage's system-message push call sites set
      // `kind`/`content`, so a client checking `message.kind` worked for a system card but not
      // for an assistant/tool message, even though both are the same wire shape
      // (packages/shared/src/events.ts's `ChatMessageEvent`). `chatMessageKind` derives `kind`
      // the same way those call sites do — `undefined` for an assistant reply, `tool_call` for a
      // tool-call record.
      kind: chatMessageKind(message.content),
      content: message.content,
      // S10 E1: the reply's Turn, so the console can hang the outcome control under it.
      turnId: message.turnId,
    },
  });
}

export function createChatEventSink(deps: ChatEventSinkDeps): AgentRuntimeEventSink {
  const log = deps.log ?? ((line: string) => console.error(line));
  /** Lost messages not yet recorded on their Turn, by turnId — written when the Turn ends. */
  const unrecordedFailures = new Map<string, MessagePersistFailure>();
  /** Tool-call state per running Turn, by turnId — dropped when the Turn ends. */
  const toolCallsByTurn = new Map<string, TurnToolCalls>();
  /** The live text's scrubber per running Turn, by turnId — dropped when the Turn ends. */
  const textStreamsByTurn = new Map<string, SecretStreamScrubber>();

  /** Publishes scrubbed live text, logging a replacement — the agent printed something that
   *  looks like a secret. */
  function publishText(
    event: AgentRuntimeEvent,
    text: { readonly value: string; readonly redactedValues: number },
  ): void {
    if (text.redactedValues > 0) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'chat event sink: replaced secret-looking values in the live text of a Turn',
          turnId: event.turnId,
          redactedValues: text.redactedValues,
        }),
      );
    }
    if (text.value === '') return;
    publishChatPushEvent({
      type: 'chat.stream',
      chatId: event.chatId,
      turnId: event.turnId,
      payload: { streamKind: 'textDelta', delta: text.value },
    });
  }

  /** Emits the live text a Turn's scrubber still holds — before any other event of the Turn. */
  function flushText(event: AgentRuntimeEvent): void {
    const stream = textStreamsByTurn.get(event.turnId);
    if (stream !== undefined) publishText(event, stream.flush());
  }

  /** The Turn's entry in `byTurn`, made by `create` if it has none. Each use moves the entry to
   *  the back, so past `MAX_TRACKED_TURNS` the Turn forgotten is the one idle longest — a running
   *  Turn's state (its record count among it) is only lost if a thousand other Turns were active
   *  since its last event. That is logged. */
  function turnEntry<T>(byTurn: Map<string, T>, turnId: string, create: () => T): T {
    let entry = byTurn.get(turnId);
    if (entry !== undefined) {
      byTurn.delete(turnId);
    } else {
      entry = create();
      if (byTurn.size >= MAX_TRACKED_TURNS) {
        const idlest = byTurn.keys().next().value;
        if (idlest !== undefined) {
          byTurn.delete(idlest);
          log(
            JSON.stringify({
              level: 'warn',
              msg: 'chat event sink: over its bound of tracked Turns — forgot the one idle longest',
              turnId: idlest,
            }),
          );
        }
      }
    }
    byTurn.set(turnId, entry);
    return entry;
  }

  function textStreamOf(turnId: string): SecretStreamScrubber {
    return turnEntry(textStreamsByTurn, turnId, createSecretStreamScrubber);
  }

  function toolCallsOf(turnId: string): TurnToolCalls {
    return turnEntry(toolCallsByTurn, turnId, () => ({
      open: new Map(),
      records: 0,
      overLimitLogged: false,
    }));
  }

  /** Whether one more record fits the Turn's bound (counting it if so). */
  function admitRecord(turnId: string, calls: TurnToolCalls): boolean {
    if (calls.records < MAX_TOOL_CALL_RECORDS_PER_TURN) {
      calls.records += 1;
      return true;
    }
    if (!calls.overLimitLogged) {
      calls.overLimitLogged = true;
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'chat event sink: tool-call records over the per-Turn bound — later calls go out live but are not stored',
          turnId,
          maxToolCallRecordsPerTurn: MAX_TOOL_CALL_RECORDS_PER_TURN,
        }),
      );
    }
    return false;
  }

  /** Stores `records` (one transaction) and pushes each stored one as a `chat.message`. Never
   *  throws: a record that cannot be stored is logged and skipped (module doc comment). */
  async function storeToolCallRecords(
    event: AgentRuntimeEvent,
    records: readonly ReturnType<typeof buildToolCallRecord>[],
  ): Promise<void> {
    if (records.length === 0) return;
    let stored: ChatMessageRow[];
    try {
      stored = await withWorkspace(
        deps.pool,
        { workspaceId: event.workspaceId, principalId: event.principalId },
        async (client) => {
          const rows: ChatMessageRow[] = [];
          for (const content of records) {
            const row = await insertToolCallMessage(client, event.workspaceId, {
              chatId: event.chatId,
              turnId: event.turnId,
              content,
            });
            if (row !== null) rows.push(row);
          }
          return rows;
        },
      );
    } catch (err) {
      log(
        JSON.stringify({
          level: 'error',
          msg: 'chat event sink: could not store a tool-call record — the Turn goes on without it',
          turnId: event.turnId,
          toolCallIds: records.map((record) => record.toolCallId),
          errorCode: sqlStateOf(err),
          error: String(err),
        }),
      );
      return;
    }
    for (const message of stored) publishStoredMessage(event.chatId, message);
  }

  async function recordLostMessage(
    event: Extract<AgentRuntimeEvent, { type: 'message' }>,
    err: unknown,
  ): Promise<void> {
    const failure: MessagePersistFailure = {
      firstAt: new Date(),
      count: 1,
      errorCode: sqlStateOf(err),
    };
    log(
      JSON.stringify({
        level: 'error',
        msg: 'chat event sink: could not store a runtime message — its Turn will not end completed',
        turnId: event.turnId,
        role: event.role,
        errorCode: failure.errorCode,
        error: String(err),
      }),
    );
    const earlier = unrecordedFailures.get(event.turnId);
    const pending: MessagePersistFailure = earlier
      ? { ...earlier, count: earlier.count + 1 }
      : failure;
    try {
      await withWorkspace(
        deps.pool,
        { workspaceId: event.workspaceId, principalId: event.principalId },
        (client) => recordMessagePersistFailure(client, event.workspaceId, event.turnId, pending),
      );
      unrecordedFailures.delete(event.turnId);
    } catch (recordErr) {
      unrecordedFailures.set(event.turnId, pending);
      log(
        JSON.stringify({
          level: 'error',
          msg: 'chat event sink: could not record the lost message on its Turn — recording it when the Turn ends',
          turnId: event.turnId,
          error: String(recordErr),
        }),
      );
    }
  }

  return {
    async handle(event: AgentRuntimeEvent): Promise<void> {
      if (event.type !== 'textDelta') flushText(event);
      switch (event.type) {
        case 'textDelta':
          // Ephemeral (§9.4 "chat.stream 永不持久化") — no DB write, scrubbed and pushed.
          publishText(event, textStreamOf(event.turnId).push(event.delta));
          return;

        case 'toolCallStarted': {
          publishChatPushEvent({
            type: 'chat.stream',
            chatId: event.chatId,
            turnId: event.turnId,
            payload: toChatStreamPayload(event),
          });
          const calls = toolCallsOf(event.turnId);
          if (calls.open.size < MAX_TOOL_CALL_RECORDS_PER_TURN) {
            calls.open.set(event.toolCallId, {
              name: event.name,
              args: event.args,
              hasArgs: 'args' in event && event.args !== undefined,
              startedAt: new Date(),
            });
          }
          return;
        }

        case 'toolCallEnded': {
          const calls = toolCallsOf(event.turnId);
          const opened = calls.open.get(event.toolCallId);
          calls.open.delete(event.toolCallId);
          const name = opened?.name ?? event.name ?? null;
          publishChatPushEvent({
            type: 'chat.stream',
            chatId: event.chatId,
            turnId: event.turnId,
            payload: toChatStreamPayload(event, name ?? undefined),
          });
          if (!admitRecord(event.turnId, calls)) return;
          await storeToolCallRecords(event, [
            buildToolCallRecord({
              toolCallId: event.toolCallId,
              name,
              outcome: event.isError === true ? 'failed' : 'done',
              args: opened?.args,
              hasArgs: opened?.hasArgs ?? false,
              result: event.result,
              hasResult: 'result' in event && event.result !== undefined,
              startedAt: opened?.startedAt ?? null,
              endedAt: new Date(),
            }),
          ]);
          return;
        }

        case 'message': {
          const scrubbed = redactMessageContent(event.content);
          if (scrubbed.redactedValues > 0 || scrubbed.cut) {
            log(
              JSON.stringify({
                level: 'warn',
                msg: 'chat event sink: replaced secret-looking values in, or cut, a runtime message before storing it',
                turnId: event.turnId,
                redactedValues: scrubbed.redactedValues,
                cut: scrubbed.cut,
              }),
            );
          }
          let message: ChatMessageRow;
          try {
            message = await withWorkspace(
              deps.pool,
              { workspaceId: event.workspaceId, principalId: event.principalId },
              (client) =>
                insertChatMessage(client, event.workspaceId, {
                  chatId: event.chatId,
                  turnId: event.turnId,
                  role: event.role,
                  content: scrubbed.value,
                }),
            );
          } catch (err) {
            // Legacy 128 — module doc comment.
            await recordLostMessage(event, err);
            return;
          }
          publishStoredMessage(event.chatId, message);
          return;
        }

        case 'turnEnded': {
          // R-55: through the one Turn transition (`endTurn`, turn-recovery.ts) — a no-op for a
          // Turn that already ended (a Stop, an accept timeout, the extension's `report_turn`), so
          // a late `completed` never overwrites `interrupted`/`failed`. When it does move the
          // Turn it also enqueues `TurnCompleted` and pushes `chat.metadata` (§13 "未完成 Turn 标
          // interrupted；下一轮注入'上轮中断'" — how a connected client learns the Turn ended),
          // the push only once the transaction has committed, like `chat.message` above: a client
          // told the Turn ended must find it ended, with its messages, when it reads history. A
          // lost message not yet recorded on the Turn is recorded first, so a `completed` here
          // ends it `failed` (legacy 128 — module doc comment).
          // Calls still open are recorded `not_finished` first, so a client told the Turn ended
          // finds every one of its tool calls in the history.
          textStreamsByTurn.delete(event.turnId);
          const calls = toolCallsByTurn.get(event.turnId);
          toolCallsByTurn.delete(event.turnId);
          if (calls !== undefined && calls.open.size > 0) {
            const endedAt = new Date();
            const records = [];
            for (const [toolCallId, opened] of calls.open) {
              if (!admitRecord(event.turnId, calls)) break;
              records.push(
                buildToolCallRecord({
                  toolCallId,
                  name: opened.name,
                  outcome: 'not_finished',
                  args: opened.args,
                  hasArgs: opened.hasArgs,
                  hasResult: false,
                  startedAt: opened.startedAt,
                  endedAt,
                }),
              );
            }
            await storeToolCallRecords(event, records);
          }
          const unrecorded = unrecordedFailures.get(event.turnId);
          let ended: EndedTurn | undefined;
          try {
            ended = await withWorkspace(
              deps.pool,
              { workspaceId: event.workspaceId, principalId: event.principalId },
              async (client) => {
                if (unrecorded) {
                  await recordMessagePersistFailure(
                    client,
                    event.workspaceId,
                    event.turnId,
                    unrecorded,
                  );
                }
                return endTurn(client, event.workspaceId, event.turnId, event.status);
              },
            );
          } finally {
            // One `turnEnded` per Turn: nothing reads the entry after this, written or not.
            unrecordedFailures.delete(event.turnId);
          }
          publishTurnEnded(ended);
          return;
        }
      }
    },
  };
}
