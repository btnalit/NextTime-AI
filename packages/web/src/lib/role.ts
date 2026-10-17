import type { Role } from '@nexttime/shared';
import { getCapability } from '@nexttime/shared';
import type { Permissions } from '../hooks/usePermissions.js';
import type { Translate } from './i18n.js';

/**
 * lib/role: a best-effort label for the signed-in principal's own role, for the Sidebar's role
 * badge (S3.14 deliverable 2 — "workspace name + role badge from get_workspace/self").
 *
 * **Superseded as the primary source (S3.11 coordination addendum, 2026-09-08)**: `get_workspace`
 * now echoes the resolved caller back (`caller: {id, role, displayName, kind}` —
 * `lib/governance.ts`'s `WorkspaceCaller`), so `hooks/useWorkspaceIdentity.ts` prefers that
 * authoritative role whenever the call has succeeded at least once. Everything below remains as
 * the *fallback* for the two cases that field cannot cover: a kernel that predates it (404
 * `not_found` — the same "not deployed yet" gap every other S3.11 read degrades to) and the
 * window before the first `get_workspace` call resolves. It derives a label from the same 403/200
 * evidence `hooks/usePermissions.tsx` already accumulates from ordinary use, rather than inventing
 * a second `whoami` capability.
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

const ROLE_BADGE_LABEL: Readonly<
  Record<InferredRole, { readonly zh: string; readonly en: string }>
> = {
  owner: { zh: '所有者', en: 'Owner' },
  'operator+': { zh: '操作员及以上', en: 'Operator+' },
  member: { zh: '成员', en: 'Member' },
  unknown: { zh: '—', en: '—' },
};

/** The badge an inferred role bucket shows (legacy 354: in the viewer's language, like the known
 *  role's chip). The buckets are ranges, not `Role` values, so they keep their own words. */
export function inferredRoleLabel(role: InferredRole, t: Translate): string {
  const label = ROLE_BADGE_LABEL[role];
  return t(label.zh, label.en);
}

/**
 * `hooks/useWorkspaceIdentity.ts`'s resolved shape: `'known'` once `get_workspace` has returned
 * its `caller.role` (the real `Role` enum value — `owner`/`builder`/`operator`/`member`/
 * `auditor`, not a bucket), `'inferred'` while that read is unavailable (loading, a 404 from a
 * kernel predating the field, or any other error) — `inferRole`'s existing best-effort bucket.
 * Every consumer (`Sidebar`'s badge/nav guard, and anywhere else "is this caller a member" is
 * asked) switches on `kind` explicitly rather than collapsing both branches into one type, so a
 * known `'builder'`/`'auditor'` is never silently mis-rendered as the closest inferred bucket.
 */
export type WorkspaceRole =
  | { readonly kind: 'known'; readonly role: Role }
  | { readonly kind: 'inferred'; readonly role: InferredRole };

/** Whether `role` is *proven* member — the only condition the Sidebar hides 治理 Governance for
 *  (see `docs/runbooks/web-console.md` "角色与可见性": every other state, including "not yet
 *  known", shows the nav group and lets each page's own 403 render inline). A known role is
 *  authoritative (no closure needed); an inferred role only ever reaches `'member'` from the same
 *  strongest-negative-evidence rule `inferRole` documents above. */
export function isProvenMember(role: WorkspaceRole): boolean {
  return role.role === 'member';
}
