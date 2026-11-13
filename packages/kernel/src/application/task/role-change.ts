import type { CapabilityScope } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type ExecuteAccess, readExecuteAccess } from '../gates/execute-access.js';
import { RetryAuthorityLostError, retryScopeNow } from './acting-authority.js';

/**
 * application/task/role-change: what a role change ends (legacy 699). One rule for both planes —
 * the workspace's `set_principal_role` (application/gateway/members-handlers.ts) and the
 * platform's `set_membership_role` (platform-handlers.ts) call {@link applyRoleChange} after
 * their `update principals set role`, in the same transaction.
 *
 *   1. **entry, mcp_session, admin_agent**: their Handles' scope was narrowed by the old role when
 *      issued (`entryScope`, `adminAgentScope`), so the sessions are marked `revoked` and
 *      governance 0042's trigger revokes their Handles. Each is issued again on its next use, under
 *      a new session: the entry agent on its next Turn, the admin agent likewise, an MCP client by
 *      `issue_handle`.
 *   2. **worker_run**: a running Worker keeps going unless the new role no longer covers what it
 *      holds. Its session is revoked when any valid Handle under it is outside what the person may
 *      hold now — the rule a crash retry applies (`retryScopeNow`: the capabilities the role
 *      allows, the gates they may act on; a role that starts no Workers holds none). So a promotion
 *      or a sideways change never kills a running Task (a crash retry happens only once, and that
 *      would spend it); a demotion ends the Workers whose Handles the new role does not cover.
 *      Since the rule also narrows the gates, a Worker whose gates changed by other means since it
 *      started is ended too — the conservative direction. An ended Worker's next kernel call is a
 *      401, llm-proxy refuses it at its next revocation sync, and its Task goes down the crash
 *      path, whose retry is held to the new role.
 *   3. **web** sessions are left alone: they carry no scope, and every request reads the person's
 *      current role (a `/ws` socket too, `session-revocation.ts`). A role change does not sign the
 *      person out.
 *
 * Note what this does not need to do: a child Handle does not depend on its parent staying valid
 * (the kernel's Handle check does not walk the parent chain), so a Worker whose parent entry
 * Handle is revoked here keeps working while the new role covers it.
 */
export async function applyRoleChange(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await client.query(
    `update sessions set status = 'revoked', expires_at = least(expires_at, now())
      where workspace_id = $1 and on_behalf_of = $2
        and kind in ('entry', 'mcp_session', 'admin_agent') and status <> 'revoked'`,
    [workspaceId, principalId],
  );

  const handles = await client.query<{ session_id: string; scope: CapabilityScope }>(
    `select h.session_id, h.scope
       from capability_handles h
       join sessions s on s.workspace_id = h.workspace_id and s.id = h.session_id
      where s.workspace_id = $1 and s.on_behalf_of = $2 and s.kind = 'worker_run'
        and s.status <> 'revoked'
        and h.revoked_at is null and h.expires_at > now()
      order by h.session_id`,
    [workspaceId, principalId],
  );
  if (handles.rows.length === 0) return;

  const access = await readExecuteAccess(client, workspaceId, principalId);
  const outside = new Set<string>();
  for (const row of handles.rows) {
    if (!outside.has(row.session_id) && !heldNow(row.scope, access)) outside.add(row.session_id);
  }
  if (outside.size === 0) return;
  await client.query(
    `update sessions set status = 'revoked', expires_at = least(expires_at, now())
      where workspace_id = $1 and id = any($2::uuid[]) and status <> 'revoked'`,
    [workspaceId, [...outside]],
  );
}

/** Whether the person may still hold all of `scope` (see {@link applyRoleChange} item 2). */
function heldNow(scope: CapabilityScope, access: ExecuteAccess): boolean {
  let now: CapabilityScope;
  try {
    now = retryScopeNow(scope, access);
  } catch (err) {
    if (err instanceof RetryAuthorityLostError) return false;
    throw err;
  }
  return sameScope(scope, now);
}

/** Two scopes name the same capabilities and the same ids on every `resources` axis, as sets: the
 *  order a scope was written in, a repeated name or an empty axis against a missing one never
 *  counts as a difference. */
export function sameScope(a: CapabilityScope, b: CapabilityScope): boolean {
  if (!sameSet(a.capabilities, b.capabilities)) return false;
  const axes = new Set([...Object.keys(a.resources), ...Object.keys(b.resources)]);
  for (const axis of axes) {
    if (!sameSet(a.resources[axis] ?? [], b.resources[axis] ?? [])) return false;
  }
  return true;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}
