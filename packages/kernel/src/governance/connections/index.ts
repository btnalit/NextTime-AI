/**
 * governance/connections: request_connection card, gatekeeper instance registration, manifest
 * import draft, connect_gatekeeper authorization; writes the platform meta-ontology.
 *
 * Placeholder for the R1 repo skeleton (design doc §7.1, §7.10). This module owns its own
 * tables/migrations and exposes only a service interface here — it must not be reached into
 * from another module's internal files, and other modules must not query its tables directly;
 * cross-module coordination happens through domain events (see packages/shared).
 */
export {};
