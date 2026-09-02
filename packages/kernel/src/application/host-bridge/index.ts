/**
 * application/host-bridge: the `AgentRuntime` port (`start/prompt/stop` + platform event
 * vocabulary) and the outbox-driven wiring that turns a `TurnStarted` domain event into a
 * `startTurn` call (design doc §7.1 host-bridge, §7.10 "运行时适配层"; docs/development-tasks.md
 * S1.4 deliverable 5). `agent-runtime.ts` is the port every runtime implementation satisfies;
 * `fake-runtime.ts` is S1.4's own implementation; `turn-started-consumer.ts` is the inbound half
 * (outbox → `AgentRuntime.startTurn`). The outbound half — a runtime's emitted events reaching
 * `application/chat`'s persistence/push logic — is wired by `packages/kernel/src/index.ts` (the
 * composition root) via `AgentRuntimeEventSink`, a type this module defines but never implements:
 * neither this module nor `application/chat` imports the other (design doc §7.10 "chat 与 host-
 * bridge ... 永不 import approval/task"; more specifically here, by convention, neither reaches
 * into the other's internals at all) — the composition root builds chat's sink implementation and
 * hands it to `FakeAgentRuntime`'s constructor, and separately calls `registerTurnStartedConsumer`
 * with the same runtime instance. See `packages/kernel/src/index.ts` for the actual wiring.
 *
 * This module owns no tables/migrations of its own (§7.1's module table: host-bridge's "状态归属"
 * is "无") and exposes only this service interface — cross-module coordination happens through
 * domain events (see packages/shared) and the composition root, never direct imports of another
 * module's internals.
 *
 * Contract: this module consumes events and read-only views only. It must never import
 * governance/approval or application/task — enforced by .dependency-cruiser.cjs.
 */
export type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeEventFields,
  AgentRuntimeEventSink,
  StartTurnInput,
  TurnEndStatus,
} from './agent-runtime.js';

export { FakeAgentRuntime } from './fake-runtime.js';
export type { FakeAgentRuntimeOptions } from './fake-runtime.js';

export { registerTurnStartedConsumer } from './turn-started-consumer.js';
export type { TurnStartedSource } from './turn-started-consumer.js';
