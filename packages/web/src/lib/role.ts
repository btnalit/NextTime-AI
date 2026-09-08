import { getCapability } from '@nexttime/shared';
import type { Permissions } from '../hooks/usePermissions.js';

/**
 * lib/role: a best-effort label for the signed-in principal's own role, for the Sidebar's role
 * badge (S3.14 deliverable 2 — "workspace name + role badge from get_workspace/self"). No
 * capability echoes the caller's role back (see the S3.11 contract note this PR codes against:
 * "if it lacks the role, use list_principals to find self by matching the API key's principal —
 * if even that is impossible..." — and it *is* impossible: `list_principals` never re-returns a
 * raw API key to match against, only `hasApiKey: boolean`). So this derives a label from the same
 * 403/200 evidence `hooks/usePermissions.tsx` already accumulates from ordinary use, rather than
 * inventing a `whoami` capability that does not exist in the fixed contract.
 *
 * The evidence is asymmetric: a 403 on a `minRole: 'operator'` capability *proves* "not operator,
 * not owner" (owner satisfies every role — `roleSatisfiesMinRole`). A 200 on one only proves "at
 * least operator" — it is equally consistent with the caller being an owner who has simply never
 * had an owner-only call fail. So `'owner'` is only ever claimed from a *successful* owner-minRole
 * call (the strongest possible positive evidence), `'member'` only from a *denied* operator-minRole
 * call (the strongest possible negative evidence), and everything in between — evidence of "at
 * least operator" with no owner-only call tried either way — is honestly labeled `'operator+'`
 * rather than guessed. `'unknown'` is the default until the session has made any governance call
 * at all (a brand-new "Forget key" session, or a member who never opens `/govern/*`).
 */
export type InferredRole = 'owner' | 'operator+' | 'member' | 'unknown';

function minRoleOf(capabilityName: string): 'owner' | 'operator' | undefined {
  const minRole = getCapability(capabilityName)?.minRole;
  return minRole === 'owner' || minRole === 'operator' ? minRole : undefined;
}

export function inferRole(permissions: Pick<Permissions, 'allowed' | 'denied'>): InferredRole {
  for (const name of permissions.denied) {
    if (minRoleOf(name) === 'operator') return 'member';
  }
  for (const name of permissions.allowed) {
    if (minRoleOf(name) === 'owner') return 'owner';
  }
  for (const name of permissions.allowed) {
    if (minRoleOf(name) === 'operator') return 'operator+';
  }
  return 'unknown';
}

export const ROLE_BADGE_LABEL: Readonly<Record<InferredRole, string>> = {
  owner: 'Owner',
  'operator+': 'Operator+',
  member: 'Member',
  unknown: '—',
};
