/**
 * governance/capability: Grant; Handle issuance/verification/revocation/decay; on_behalf_of
 * (design doc §5.1.4, §5.4 I13/I14; docs/development-tasks.md S1.9, S2.3).
 *
 * This module owns its own tables/migrations (migrations/governance/0001_capability_handles.sql,
 * migrations/governance/0002_policy.sql's `capability_grants`) and exposes only this service
 * interface — it must not be reached into from another module's internal files, and other modules
 * must not query its tables directly; cross-module coordination happens through domain events (see
 * packages/shared).
 *
 * CapabilityGrant (grants.ts, S2.3): CRUD plus the I14 "does this Principal hold this
 * action_kind × resource_scope" lookup that `governance/approval`'s `approve`/`reject` precheck and
 * `routing.ts`'s holder computation both call through this module's public interface.
 */
export * from './keys.js';
export * from './handles.js';
export * from './grants.js';
