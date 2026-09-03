/**
 * governance/policy: data-driven Policy rules; evaluate; dual-signal; requester_can_approve
 * (design doc §5.1.4 Policy, §5.4 I8, §5.8; docs/development-tasks.md S2.2).
 *
 * `engine.ts` is pure (no IO): `evaluate()` decides `allow | require_approval | deny` from
 * explicitly-passed inputs (the workspace's policy row, the invoked Operation's own declared
 * `auto_approvable`/`blast_radius`, and the requester's Handle scope) — see that file's own module
 * doc comment for the exact rules. `policies.ts` is the DB-touching half: reads/writes the
 * `policies` table (migrations/governance/0002_policy.sql) that supplies `evaluate()`'s
 * `workspacePolicy` input and backs the `set_policy`/`set_auto_approved_action_kind` capabilities.
 *
 * This module owns its own table/migration and exposes only this service interface — it must not
 * be reached into from another module's internal files, and other modules must not query its table
 * directly; `governance/approval` (a sibling governance module, S2.3) calls `readWorkspacePolicy`
 * through this published interface, the same way it calls `governance/capability`'s
 * `hasActiveGrant`/`listGrantHolderPrincipalIds` for I14.
 */
export * from './engine.js';
export * from './policies.js';
