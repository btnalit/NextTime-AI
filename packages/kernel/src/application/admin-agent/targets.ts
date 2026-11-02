import type {
  AdminAgentRefusalReason,
  AdminAgentSessionWire,
  AdminAgentStatusWire,
  AdminAgentTargetWire,
  AdminAgentTargetsResultWire,
  AdminAgentTrialWorkspaceWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { ADMIN_AGENT_SESSION_KIND } from '../../governance/capability/index.js';
import { ADMIN_TRIAL_WORKSPACE_PURPOSE, adminAgentEnabled, adminAgentRefusal } from './identity.js';

/**
 * application/admin-agent/targets (S11 AA4c: docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §5.9; the AA4 plan's F3–F5, the AA4c plan's D1, D2, D6, D7): what a platform
 * administrator sees and chooses of their own admin agent on the platform plane, and the one read
 * the agent itself has of it. Owns migrations/governance/0036_admin_agent_targets.sql, whose header
 * has the model.
 *
 * The administrator chooses, per trial workspace they are a member of, the workspaces their admin
 * agent there may propose to: one choice for every admin agent Chat of theirs in that trial
 * workspace, since those share one session and one container. Only a person changes it, here, on
 * the platform channel; nothing an admin agent's Handle may call writes it, and the agent reads the
 * ids alone (`agent_list_proposal_targets`). Every change is one call, so one platform audit row.
 *
 * Every function but {@link readChosenTargetIds} runs in a platform transaction (role
 * `nexttime_app`, `app.platform = on`): `admin_agent_targets` is a platform table, and
 * `principals`, `workspaces`, `users` and `sessions` are read through their platform policies.
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** `set_admin_agent_targets` / `stop_admin_agent` naming a trial workspace the caller is not a
 *  person in — unknown, not a trial workspace, or someone else's alike. Mapped to 404
 *  `not_found`. */
export class AdminAgentTrialWorkspaceNotFoundError extends Error {
  readonly code = 'not_found' as const;
  constructor(trialWorkspaceId: string) {
    super(
      `no trial workspace ${trialWorkspaceId} of yours: you choose targets for your own admin agent, in a trial workspace you are a member of`,
    );
    this.name = 'AdminAgentTrialWorkspaceNotFoundError';
  }
}

/** `set_admin_agent_targets` adding a workspace that cannot be a target: unknown, disabled, a trial
 *  workspace, or the trial workspace itself. `details.targetWorkspaceIds` lists them; nothing was
 *  changed. A target chosen before and disabled since may stay. Mapped to 400 `invalid_params`. */
export class AdminAgentTargetsInvalidError extends Error {
  readonly code = 'invalid_params' as const;
  readonly details: { readonly targetWorkspaceIds: readonly string[] };
  constructor(targetWorkspaceIds: readonly string[]) {
    super(
      `targetWorkspaceIds: ${targetWorkspaceIds.join(', ')} cannot be chosen — a target is an active workspace that is not a trial workspace. Nothing was changed.`,
    );
    this.name = 'AdminAgentTargetsInvalidError';
    this.details = { targetWorkspaceIds };
  }
}

/** The administrator's stored platform role is not `admin`, though `NEXTTIME_PLATFORM_ADMINS`
 *  makes them one: governance 0036's guard (like 0032's for a proposal) reads the stored role, the
 *  only one the database sees. Mapped to 409 `admin_role_not_stored`; nothing was changed. */
export class AdminAgentRoleNotStoredError extends Error {
  readonly code = 'admin_role_not_stored' as const;
  constructor() {
    super(
      'your stored platform role is not admin, though NEXTTIME_PLATFORM_ADMINS makes you one: an admin agent goes by the stricter — nothing was changed. Set your stored role to admin on the users page first.',
    );
    this.name = 'AdminAgentRoleNotStoredError';
  }
}

// -------------------------------------------------------------------------------------------
// The agent's read (the trial workspace's transaction)
// -------------------------------------------------------------------------------------------

/** The workspaces the transaction's own Principal lets their admin agent propose to in this trial
 *  workspace — `admin_agent_chosen_targets()` (governance 0036), which answers for that Principal
 *  alone — by id, in id order. */
export async function readChosenTargetIds(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ id: string }>('select admin_agent_chosen_targets() as id');
  return result.rows.map((row) => row.id);
}

// -------------------------------------------------------------------------------------------
// The administrator's (platform transaction)
// -------------------------------------------------------------------------------------------

/** One of the user's memberships in a trial workspace. */
export interface AdminAgentMembership {
  readonly workspaceId: string;
  readonly name: string;
  readonly principalId: string;
}

/** The user's human memberships in trial workspaces, by name — disabled ones too: the refusal says
 *  why the agent may not act there. */
export async function listAdminAgentMemberships(
  client: PoolClient,
  userId: string,
): Promise<AdminAgentMembership[]> {
  const result = await client.query<{ workspace_id: string; name: string; principal_id: string }>(
    `select w.id as workspace_id, w.name, p.id as principal_id
       from principals p
       join workspaces w on w.id = p.workspace_id
      where p.user_id = $1 and p.kind = 'human' and w.purpose = $2
      order by w.name, w.id`,
    [userId, ADMIN_TRIAL_WORKSPACE_PURPOSE],
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    name: row.name,
    principalId: row.principal_id,
  }));
}

/** The user's membership in `trialWorkspaceId`, or {@link AdminAgentTrialWorkspaceNotFoundError}. */
export async function requireAdminAgentMembership(
  client: PoolClient,
  userId: string,
  trialWorkspaceId: string,
): Promise<AdminAgentMembership> {
  const membership = (await listAdminAgentMemberships(client, userId)).find(
    (entry) => entry.workspaceId === trialWorkspaceId,
  );
  if (membership === undefined) throw new AdminAgentTrialWorkspaceNotFoundError(trialWorkspaceId);
  return membership;
}

interface TargetDbRow {
  target_workspace_id: string;
  name: string;
  status: 'active' | 'disabled';
  chosen_at: Date;
}

/** The targets `membership`'s person chose there, by name, as the administrator reads them. */
export async function readAdminAgentTargets(
  client: PoolClient,
  membership: AdminAgentMembership,
): Promise<AdminAgentTargetWire[]> {
  const result = await client.query<TargetDbRow>(
    `select t.target_workspace_id, w.name, w.status, t.chosen_at
       from admin_agent_targets t
       join workspaces w on w.id = t.target_workspace_id
      where t.workspace_id = $1 and t.principal_id = $2
      order by w.name, w.id`,
    [membership.workspaceId, membership.principalId],
  );
  return result.rows.map((row) => ({
    workspaceId: row.target_workspace_id,
    name: row.name,
    status: row.status,
    chosenAt: row.chosen_at.toISOString(),
  }));
}

/** The person's live `admin_agent` session in the trial workspace (the one its Chats share), if
 *  any — the session `openAdminAgentSession` would reuse. */
async function readAdminAgentSession(
  client: PoolClient,
  membership: AdminAgentMembership,
): Promise<AdminAgentSessionWire | null> {
  const result = await client.query<{ id: string; created_at: Date; expires_at: Date | null }>(
    `select id, created_at, expires_at from sessions
      where workspace_id = $1 and principal_id = $2 and on_behalf_of = $2 and kind = $3
        and status <> 'revoked' and (expires_at is null or expires_at > now())
      order by created_at desc, id desc
      limit 1`,
    [membership.workspaceId, membership.principalId, ADMIN_AGENT_SESSION_KIND],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.id,
    startedAt: row.created_at.toISOString(),
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
  };
}

/** `get_admin_agent_status`: the switch, and for each trial workspace the user is a person in —
 *  whether their admin agent may act there now (`refusal`), its targets and its live session. */
export async function readAdminAgentStatus(
  client: PoolClient,
  userId: string,
  enabled: boolean = adminAgentEnabled(),
): Promise<AdminAgentStatusWire> {
  const workspaces: AdminAgentTrialWorkspaceWire[] = [];
  for (const membership of await listAdminAgentMemberships(client, userId)) {
    const refusal: AdminAgentRefusalReason | null = await adminAgentRefusal(
      client,
      membership.workspaceId,
      membership.principalId,
      enabled,
    );
    workspaces.push({
      workspaceId: membership.workspaceId,
      name: membership.name,
      refusal,
      targets: await readAdminAgentTargets(client, membership),
      session: await readAdminAgentSession(client, membership),
    });
  }
  return { enabled, workspaces };
}

/**
 * `set_admin_agent_targets`: replaces the targets of the user's admin agent in `trialWorkspaceId`
 * with `targetWorkspaceIds` (already bounded by the capability's params). A workspace added must be
 * an active standard workspace other than the trial workspace — refused otherwise
 * ({@link AdminAgentTargetsInvalidError}), nothing changed; one kept from before may have been
 * disabled since. Rows are deleted and inserted, never updated (governance 0036). Proposals the
 * agent made before keep their targets; one to a workspace removed here is refused when its owner
 * applies it.
 */
export async function setAdminAgentTargets(
  client: PoolClient,
  userId: string,
  trialWorkspaceId: string,
  targetWorkspaceIds: readonly string[],
): Promise<AdminAgentTargetsResultWire> {
  const membership = await requireAdminAgentMembership(client, userId, trialWorkspaceId);
  const stored = await client.query<{ platform_role: string }>(
    'select platform_role from users where id = $1',
    [userId],
  );
  if (stored.rows[0]?.platform_role !== 'admin') throw new AdminAgentRoleNotStoredError();

  const before = (await readAdminAgentTargets(client, membership)).map(
    (target) => target.workspaceId,
  );
  const wanted = [...new Set(targetWorkspaceIds)];
  const beforeSet = new Set(before);
  const wantedSet = new Set(wanted);
  const added = wanted.filter((id) => !beforeSet.has(id));
  const removed = before.filter((id) => !wantedSet.has(id));

  if (added.length > 0) {
    const acceptable = await client.query<{ id: string }>(
      `select id from workspaces
        where id = any($1::uuid[]) and status = 'active' and purpose = 'standard' and id <> $2`,
      [added, trialWorkspaceId],
    );
    const ok = new Set(acceptable.rows.map((row) => row.id));
    const refused = added.filter((id) => !ok.has(id));
    if (refused.length > 0) throw new AdminAgentTargetsInvalidError(refused);
  }

  if (removed.length > 0) {
    await client.query(
      `delete from admin_agent_targets
        where workspace_id = $1 and principal_id = $2 and target_workspace_id = any($3::uuid[])`,
      [membership.workspaceId, membership.principalId, removed],
    );
  }
  for (const id of added) {
    await client.query(
      `insert into admin_agent_targets
         (workspace_id, principal_id, target_workspace_id, chosen_by_user)
       values ($1, $2, $3, $4)`,
      [membership.workspaceId, membership.principalId, id, userId],
    );
  }
  return {
    trialWorkspaceId,
    targets: await readAdminAgentTargets(client, membership),
    added: [...added].sort(),
    removed: [...removed].sort(),
  };
}
