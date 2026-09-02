/**
 * application/host-bridge/agent-runtime: the `AgentRuntime` port (design doc §7.1 host-bridge,
 * §7.10 "运行时适配层"; docs/development-tasks.md S1.4 deliverable 5) and the platform event
 * vocabulary it feeds to a sink — the whole point of this file is that `application/chat` (and
 * every consumer above it) only ever sees these types, never pi's own RPC event names or agent-
 * host's wire format. `fake-runtime.ts` is the only implementation S1.4 ships; S1.5 adds the real
 * one (agent-host over HTTP/WS, per the design doc's own module table: "pi 是唯一计划的实现").
 *
 * host-bridge does not call chat directly, and chat does not call host-bridge directly — see
 * `index.ts`'s module doc for how the two are wired together (through this file's types alone,
 * plus the outbox for the *inbound* half) without either module importing the other.
 */

export interface StartTurnInput {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly turnId: string;
  /** I13: the Handle's `on_behalf_of` this Turn is running as — carried on every emitted event too
   *  (see `AgentRuntimeEvent` below), so a sink never has to look it up mid-stream. */
  readonly principalId: string;
  /** Already carries the `<!--nexttime:turn_id=...-->` marker (§7.2) — see index.ts's
   *  `registerTurnStartedConsumer`, which is the one place that prefixes it. */
  readonly prompt: string;
}

/** `status` values a Turn can end in — same three design doc §5.5 uses for Activity/Turn
 *  (`TurnCompleted`, packages/shared/src/events.ts). */
export type TurnEndStatus = 'completed' | 'interrupted' | 'failed';

interface AgentRuntimeEventBase {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly turnId: string;
  readonly principalId: string;
}

/**
 * The variant-specific part of one `AgentRuntimeEvent` — everything except the four correlation
 * fields every variant shares (`AgentRuntimeEventBase`). Split out as its own discriminated union
 * (rather than only existing implicitly inside `AgentRuntimeEvent`'s definition below) so a
 * runtime implementation can build "just the event-specific fields" as a normal, non-generic
 * union value — `fake-runtime.ts`'s `emit()` helper is the reason this split exists: TypeScript's
 * `keyof` of a union type collapses to the *common* keys across every member, so a generic
 * `Omit<AgentRuntimeEvent, 'workspaceId' | ...>` parameter cannot see `delta`/`role`/`status`/etc
 * at all (they are not common keys) — giving this union its own name sidesteps that entirely.
 */
export type AgentRuntimeEventFields =
  | { readonly type: 'textDelta'; readonly delta: string }
  | {
      readonly type: 'toolCallStarted';
      readonly toolCallId: string;
      readonly name: string;
      readonly args?: unknown;
    }
  | {
      readonly type: 'toolCallEnded';
      readonly toolCallId: string;
      readonly result?: unknown;
    }
  | {
      readonly type: 'message';
      readonly role: 'assistant' | 'tool';
      /** S1 minimal content model: `{text: string}` for a plain-text message, or an arbitrary
       *  record for anything richer — see `application/chat`'s event-sink for how this is
       *  projected to `chat_messages.content` (stored as-is) and to the WS `chat.message.text`
       *  wire field (projected defensively). Real content modeling is S1.5+ scope. */
      readonly content: Record<string, unknown>;
    }
  | { readonly type: 'turnEnded'; readonly status: TurnEndStatus };

/**
 * The platform event vocabulary (design doc §7.4 "接口注入的机制" event names, §9.4 chat.stream sub-
 * kinds): what an `AgentRuntime` implementation feeds to its `AgentRuntimeEventSink`. `textDelta`/
 * `toolCallStarted`/`toolCallEnded` are ephemeral (never persisted — §9.4 "chat.stream 永不持久
 * 化"); `message` is a persisted chat_message (role `assistant` or `tool`); `turnEnded` is exactly
 * one per Turn, however it ends (natural completion, `stopTurn`, or a runtime failure).
 */
export type AgentRuntimeEvent = AgentRuntimeEventBase & AgentRuntimeEventFields;

/** Fed one `AgentRuntimeEvent` at a time, in emission order, for the lifetime of a Turn. */
export interface AgentRuntimeEventSink {
  handle(event: AgentRuntimeEvent): Promise<void> | void;
}

/**
 * `start / prompt / stop` per the design doc's own naming (§7.10) — `startTurn` folds "start" and
 * "prompt" into one call (S1.4 has no notion of a long-lived runtime session separate from a
 * Turn; the S1.5 real implementation may still keep its own persistent connection to the entry
 * container underneath, that is an implementation detail this port does not need to expose).
 */
export interface AgentRuntime {
  /** Begins a Turn. Resolves once the runtime has *accepted* the Turn (e.g. the request reached
   *  agent-host) — the Turn's actual execution is asynchronous and reported entirely through the
   *  sink this runtime was constructed with. Never throws for a normal "the agent is thinking"
   *  delay; a runtime-level failure to even start is reported as a `turnEnded` event with
   *  `status: 'failed'`, not a rejected promise, so callers have exactly one path to observe a
   *  Turn's outcome. */
  startTurn(input: StartTurnInput): Promise<void>;
  /** Requests that a running Turn stop. Idempotent — stopping an already-ended or unknown
   *  `turnId` is a no-op. Like `startTurn`, the actual stop is confirmed asynchronously via a
   *  `turnEnded` event (`status: 'interrupted'`), not this call's resolution. */
  stopTurn(turnId: string): Promise<void>;
}
