/**
 * Legacy 725: a person's membership of a workspace is one human Principal at a time
 * (`principals_workspace_user_key`, migration core 0019, unique on `(workspace_id, user_id)`).
 * Removing it (`remove_membership` on the platform, `disable_principal` in the workspace) disables
 * that Principal for good: its sessions, Handles and API key were revoked with it, nothing
 * re-enables a disabled Principal, and the authority rules count on that (governance 0042 / 0043,
 * `merge_user`'s conditional detach, approvals and grants recorded by Principal id). So adding the
 * person back is a new membership, never the old one revived: the removed Principal stops
 * belonging to the user (`user_id` cleared, as `purge_user` and `merge_user` let go of removed
 * memberships; the row and its audit history stay, and what it authored stays in the workspace
 * under its id), and a fresh Principal takes the slot. The person does not get back the drafts
 * and goals of the removed membership.
 *
 * Every path that gives a user a membership (`add_membership`, `create_user`, the workspace's
 * `add_member`, binding an API key) holds the user's authority lock before it calls this, so no
 * other of those, nor `merge_user`, changes the user's memberships meanwhile: what can still
 * happen concurrently is a removal (an active membership becomes removed), which only frees the
 * slot.
 */
import type { PoolClient } from 'pg';
import { lockAuthoritiesForChange } from '../../governance/capability/index.js';

/** The user's membership slot in one workspace, after `freeMembershipSlot`. */
export type MembershipSlot =
  /** No membership there, or a removed one that `released` names: it no longer belongs to the
   *  user. */
  | { readonly state: 'free'; readonly released: ReleasedMembership | null }
  /** An active membership: the user is already a member there. */
  | { readonly state: 'held'; readonly principalId: string };

/** A removed membership let go of the user, as audit rows list it (`detachedPrincipals`). */
export interface ReleasedMembership {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

/**
 * Frees the user's slot in the workspace when a removed membership holds it, under the
 * Principal's authority lock (after the user's, the global order). `exceptPrincipalId`: the
 * Principal the caller is about to move onto the user (binding an API key), never its own clash.
 * The caller must hold the user's authority lock.
 */
export async function freeMembershipSlot(
  client: PoolClient,
  at: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly exceptPrincipalId?: string;
  },
): Promise<MembershipSlot> {
  const found = await client.query<{ id: string }>(
    `select id from principals
      where workspace_id = $1 and user_id = $2 and kind = 'human' and id is distinct from $3::uuid`,
    [at.workspaceId, at.userId, at.exceptPrincipalId ?? null],
  );
  const principalId = found.rows[0]?.id;
  if (principalId === undefined) return { state: 'free', released: null };
  await lockAuthoritiesForChange(client, { principalIds: [principalId] });
  // Under its lock: a removal that was committing has committed, and nothing re-enables it.
  const detached = await client.query(
    `update principals set user_id = null
      where workspace_id = $1 and id = $2 and user_id = $3 and kind = 'human'
        and disabled_at is not null`,
    [at.workspaceId, principalId, at.userId],
  );
  if ((detached.rowCount ?? 0) === 1) {
    return {
      state: 'free',
      released: { workspaceId: at.workspaceId, principalId, userId: at.userId },
    };
  }
  const still = await client.query<{ user_id: string | null }>(
    'select user_id from principals where workspace_id = $1 and id = $2 and disabled_at is null',
    [at.workspaceId, principalId],
  );
  if (still.rows[0]?.user_id !== at.userId) {
    // Under the user's lock nothing else moves the user's memberships (module comment).
    throw new Error(
      `freeMembershipSlot: membership ${principalId} is neither removed nor still the user's`,
    );
  }
  return { state: 'held', principalId };
}
