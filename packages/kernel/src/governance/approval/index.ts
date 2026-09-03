/**
 * governance/approval: ActionRequest state machine; drain (per-Gatekeeper single-flight,
 * ascending, stop on pending); approve writes the Approval Decision in the same transaction
 * (design doc §5.1.4, §5.4 I6/I7/I11/I13/I14, §5.5, §8.1/§8.2/§8.5; docs/development-tasks.md
 * S2.3).
 *
 * This module owns its own table/migration (migrations/governance/0003_action_requests.sql) and
 * exposes only this service interface — it must not be reached into from another module's
 * internal files, and other modules must not query its table directly; cross-module coordination
 * happens through domain events (see packages/shared — `ActionRequestPending`/
 * `ActionRequestUpdated`).
 *
 * Contract: application/chat and application/host-bridge must never import this module directly
 * — they consume ActionRequestPending / ActionRequestUpdated events instead. Enforced by
 * .dependency-cruiser.cjs.
 */
export * from './service.js';
export * from './drainer.js';
export * from './routing.js';
