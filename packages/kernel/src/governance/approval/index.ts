/**
 * governance/approval: ActionRequest state machine; drain (per-Gatekeeper single-flight,
 * ascending, stop on pending); approve writes the Approval Decision in the same transaction.
 *
 * Placeholder for the R1 repo skeleton (design doc §7.1, §7.10). This module owns its own
 * tables/migrations and exposes only a service interface here — it must not be reached into
 * from another module's internal files, and other modules must not query its tables directly;
 * cross-module coordination happens through domain events (see packages/shared).
 *
 * Contract: application/chat and application/host-bridge must never import this module directly
 * — they consume ActionRequestPending / ActionRequestUpdated events instead. Enforced by
 * .dependency-cruiser.cjs.
 */
export {};
