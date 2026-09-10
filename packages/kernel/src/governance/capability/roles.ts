import type { Role } from '@nexttime/shared';

/**
 * Whether a human Principal's `role` satisfies a capability's `minRole`. Moved here from
 * `application/gateway/authorize.ts` (W5.5, STATUS leftover 18) so the governance layer can apply
 * the same rule when *issuing* an entry Handle (`entryScope({ role })`, handles.ts) — the six-layer
 * dependency rule forbids governance importing application, and this rule is pure data logic.
 *
 * Role hierarchy (unchanged from authorize.ts's own doc comment): `owner` satisfies everything;
 * `minRole: 'member'` is the floor every human role clears; any other `minRole` requires that exact
 * role — `builder` / `operator` / `auditor` are peers, not a ladder.
 */
export function roleSatisfiesMinRole(role: Role, minRole: Role | undefined): boolean {
  if (minRole === undefined) return true;
  if (role === 'owner') return true;
  if (minRole === 'member') return true;
  return role === minRole;
}
