/**
 * governance/capability: Grant; Handle issuance/verification/revocation/decay; on_behalf_of
 * (design doc §5.1.4, §5.4 I13; docs/development-tasks.md S1.9).
 *
 * This module owns its own tables/migrations (migrations/governance/0001_capability_handles.sql)
 * and exposes only this service interface — it must not be reached into from another module's
 * internal files, and other modules must not query its tables directly; cross-module coordination
 * happens through domain events (see packages/shared).
 *
 * CapabilityGrant (the other half of this module's name) is not yet implemented — the design
 * doc's `capability_grants` table (§9.2, listed alongside `capability_handles` in the S2.1
 * governance migration) lands with S2.1/S2.3, not here.
 */
export * from './keys.js';
export * from './handles.js';
