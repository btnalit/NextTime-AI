/**
 * governance/gatekeepers/system-actor: the fixed, non-dereferenced placeholder principal id every
 * admin-mode (`skipRoleSwitch: true`) background transaction in the Gatekeeper execution path
 * uses — the periodic drain tick, the `ActionRequestUpdated` outbox consumer, and (S2.4 two-phase
 * fix) `request_action`'s own `afterCommit` phase-2 continuation before it has resolved the real
 * Gatekeeper service Principal (`getOrCreateGatekeeperServicePrincipal`).
 *
 * `withWorkspace` requires a non-empty `principalId` to set the `app.principal_id` session
 * variable, but `skipRoleSwitch: true` keeps the connection on its superuser/table-owner role for
 * the whole transaction — Postgres never evaluates RLS (and therefore never reads that session
 * variable) for that role, so this value is never actually checked against `principals`. It only
 * exists to satisfy that non-empty precondition. One shared constant (rather than one ad hoc
 * literal per call site) so every admin-mode transaction in this area is visibly using the same,
 * deliberately-inert placeholder.
 */
export const SYSTEM_ACTOR_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
