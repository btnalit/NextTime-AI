import { z } from 'zod';

/**
 * agent-host-protocol: the wire contract between the kernel and `@nexttime/agent-host` over the
 * kernel's `/internal/agent-host` WebSocket (design doc §7.2 "agent-host 只做事件桥", §7.10 "运行时
 * 适配层"; docs/development-tasks.md S1.5, second half). Shared the same way `handle-token.ts` is
 * shared between the kernel and `llm-proxy` (S1.7 "共享 Handle-token 原语") — one schema, so the
 * kernel's `application/host-bridge/agent-host-runtime.ts` (which validates every inbound frame
 * against it) and `@nexttime/agent-host`'s own `kernel-link.ts` (which constructs every outbound
 * frame against it) can never drift on shape.
 *
 * Trust boundary: this channel carries no bearer credential of its own — it is reachable only on
 * the compose `control` network, which the kernel never exposes past its own network boundary
 * (design doc §11 "内核不发布端口"), the same trust boundary `/internal/llm-usage` and
 * `/internal/handle-revocations` already document. The one secret that *does* cross this channel
 * — a freshly issued entry Capability Handle, carried inside a `startTurn` command — travels only
 * kernel → agent-host → the spawned container's env (`worker-supervisor`'s `/resident/spawn`
 * request body); agent-host must never log it (see agent-host's own kernel-link.ts doc comment).
 *
 * `AgentRuntimeEventWireSchema` mirrors (deliberately does not import — this package cannot depend
 * on `@nexttime/kernel`, and `@nexttime/kernel`'s own `application/host-bridge/agent-runtime.ts`
 * doc comment is explicit that the platform event vocabulary is "designed to be the one place chat
 * ... sees" — this schema is that same vocabulary's *wire* projection, kept shape-compatible by
 * hand, the same way `packages/shared/src/events.ts`'s existing `ChatStreamPayload` schema already
 * mirrors a subset of it) the four event-specific variants plus the four correlation fields every
 * `AgentRuntimeEvent` carries (`workspaceId`/`chatId`/`turnId`/`principalId`). Deliberately does
 * **not** carry a `reason` string on the `turnEnded` variant — see the kernel-side runtime's own
 * doc comment on `agent-host-runtime.ts` for why (keeping this schema exactly shape-compatible
 * with the pre-existing `AgentRuntimeEventFields` type, rather than widening a foundational S1.4
 * type for this task's sake).
 */

const CorrelationFieldsSchema = {
  workspaceId: z.string(),
  chatId: z.string(),
  turnId: z.string(),
  principalId: z.string(),
};

const AgentRuntimeEventTextDeltaSchema = z
  .object({
    type: z.literal('textDelta'),
    delta: z.string(),
    ...CorrelationFieldsSchema,
  })
  .strict();

const AgentRuntimeEventToolCallStartedSchema = z
  .object({
    type: z.literal('toolCallStarted'),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown().optional(),
    ...CorrelationFieldsSchema,
  })
  .strict();

const AgentRuntimeEventToolCallEndedSchema = z
  .object({
    type: z.literal('toolCallEnded'),
    toolCallId: z.string(),
    result: z.unknown().optional(),
    ...CorrelationFieldsSchema,
  })
  .strict();

const AgentRuntimeEventMessageSchema = z
  .object({
    type: z.literal('message'),
    role: z.enum(['assistant', 'tool']),
    content: z.record(z.string(), z.unknown()),
    ...CorrelationFieldsSchema,
  })
  .strict();

const AgentRuntimeEventTurnEndedSchema = z
  .object({
    type: z.literal('turnEnded'),
    status: z.enum(['completed', 'interrupted', 'failed']),
    ...CorrelationFieldsSchema,
  })
  .strict();

/** Wire projection of `@nexttime/kernel`'s `AgentRuntimeEvent` (application/host-bridge/
 *  agent-runtime.ts) — see this module's own doc comment for why it is a hand-kept mirror rather
 *  than an import. */
export const AgentRuntimeEventWireSchema = z.discriminatedUnion('type', [
  AgentRuntimeEventTextDeltaSchema,
  AgentRuntimeEventToolCallStartedSchema,
  AgentRuntimeEventToolCallEndedSchema,
  AgentRuntimeEventMessageSchema,
  AgentRuntimeEventTurnEndedSchema,
]);
export type AgentRuntimeEventWire = z.infer<typeof AgentRuntimeEventWireSchema>;

// ---------------------------------------------------------------------------------------------
// agent-host -> kernel frames
// ---------------------------------------------------------------------------------------------

/** Sent once, immediately after the WebSocket opens. `instanceId` is a fresh `randomUUID()`
 *  generated once per agent-host *process* (not per connection) — it lets the kernel tell a mere
 *  reconnect of the same still-running agent-host process (same `instanceId`, e.g. a network
 *  blip — design doc §13 "agent-host 重启 | 入口容器不受影响...事件桥重连...对话在 Postgres 无损")
 *  apart from a genuine process restart (a new `instanceId` — agent-host's own in-memory turn
 *  bookkeeping and attached container streams did not survive, so nothing will ever report on
 *  whatever Turns the kernel still considers active from before). See agent-host-runtime.ts's
 *  `handleFrame` for exactly how the kernel acts on this distinction. */
export const AgentHostHelloFrameSchema = z
  .object({
    type: z.literal('hello'),
    instanceId: z.string(),
  })
  .strict();

/** Acknowledges a `startTurn` command: agent-host has durably taken ownership of this Turn (the
 *  entry container is spawned/reused and the `prompt` frame has been written to its stdin) — not
 *  that the Turn has *finished*. Resolves the kernel-side `AgentRuntime.startTurn()` promise. */
export const AgentHostTurnAcceptedFrameSchema = z
  .object({
    type: z.literal('turnAccepted'),
    turnId: z.string(),
  })
  .strict();

/** Reports that agent-host could not even start the Turn (e.g. the entry container failed to
 *  spawn). The kernel turns this into a `turnEnded {status:'failed'}` event through the sink —
 *  same as a `turnAccepted` timeout — rather than ever leaving a Turn hanging. */
export const AgentHostTurnRejectedFrameSchema = z
  .object({
    type: z.literal('turnRejected'),
    turnId: z.string(),
    reason: z.string(),
  })
  .strict();

/** One `AgentRuntimeEvent`, translated from pi's own RPC event vocabulary by agent-host's
 *  `bridge.ts` (the one place that translation happens — see that file's own doc comment) and
 *  forwarded verbatim. */
export const AgentHostRuntimeEventFrameSchema = z
  .object({
    type: z.literal('runtimeEvent'),
    event: AgentRuntimeEventWireSchema,
  })
  .strict();

export const AgentHostToKernelFrameSchema = z.discriminatedUnion('type', [
  AgentHostHelloFrameSchema,
  AgentHostTurnAcceptedFrameSchema,
  AgentHostTurnRejectedFrameSchema,
  AgentHostRuntimeEventFrameSchema,
]);
export type AgentHostToKernelFrame = z.infer<typeof AgentHostToKernelFrameSchema>;

// ---------------------------------------------------------------------------------------------
// kernel -> agent-host frames
// ---------------------------------------------------------------------------------------------

/** Begins a Turn. `handle` is a freshly issued (or reissued, once <10% of its ttl remains) entry
 *  Capability Handle (design doc §5.1.4, S1.9 `issueHandle`/`entryScope`) — never logged by
 *  either side; it travels from here straight into the spawned container's env
 *  (`worker-supervisor`'s `/resident/spawn` request body) and nowhere else. `kernelLlmUrl` is
 *  what agent-host passes through as the same request's `llmUrl` (worker-supervisor's own
 *  `/resident/spawn` contract, docs/runbooks/host-worker-runtime.md §9) — the kernel is the one
 *  process that already knows the configured `KERNEL_LLM_URL`; agent-host does not need its own
 *  opinion about it. */
export const KernelStartTurnCommandSchema = z
  .object({
    type: z.literal('startTurn'),
    workspaceId: z.string(),
    chatId: z.string(),
    turnId: z.string(),
    principalId: z.string(),
    prompt: z.string(),
    handle: z.string(),
    kernelLlmUrl: z.string(),
  })
  .strict();

/** Requests that a running Turn stop (§9.4 `stop_agent`). `principalId` is included because
 *  agent-host indexes its attached container streams by principal, not by turn — the kernel
 *  already knows which principal a `turnId` belongs to from its own `startTurn` bookkeeping. */
export const KernelStopTurnCommandSchema = z
  .object({
    type: z.literal('stopTurn'),
    turnId: z.string(),
    principalId: z.string(),
  })
  .strict();

export const KernelToAgentHostFrameSchema = z.discriminatedUnion('type', [
  KernelStartTurnCommandSchema,
  KernelStopTurnCommandSchema,
]);
export type KernelToAgentHostFrame = z.infer<typeof KernelToAgentHostFrameSchema>;
