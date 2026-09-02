/**
 * substrate/graph: Object/Link/Fact writes and queries; traverse/search/state_at;
 * find_operations/find_workers/find_procedures.
 *
 * Placeholder for the R1 repo skeleton (design doc §7.1, §7.10). This module owns its own
 * tables/migrations and exposes only a service interface here — it must not be reached into
 * from another module's internal files, and other modules must not query its tables directly;
 * cross-module coordination happens through domain events (see packages/shared).
 */
export {};
