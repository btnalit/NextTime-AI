/**
 * application/chat: Chat/Turn persistence; WS RPC (§9.4); turns hosted-agent stream events into
 * per-user pushes; renders pending approvals and task status as cards.
 *
 * Placeholder for the R1 repo skeleton (design doc §7.1, §7.10). This module owns its own
 * tables/migrations and exposes only a service interface here — it must not be reached into
 * from another module's internal files, and other modules must not query its tables directly;
 * cross-module coordination happens through domain events (see packages/shared).
 *
 * Contract: this module consumes events and read-only views only. It must never import
 * governance/approval or application/task — enforced by .dependency-cruiser.cjs. Approval
 * routing is governance/approval publishing events; chat subscribes and writes each holder's
 * system message.
 */
export {};
