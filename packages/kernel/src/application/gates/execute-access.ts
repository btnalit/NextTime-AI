import type { CapabilityScope, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type AgentPolicyRow,
  type AgentProfileRow,
  readAgentPolicy,
  readAgentProfile,
  resolveEnabledGatekeepers,
} from '../../governance/agent-profile/index.js';
import {
  GATEKEEPER_GRANT_CAPABILITY,
  listActiveGrantResourceScopes,
} from '../../governance/capability/index.js';

/**
 * application/gates/execute-access: the execute-side counterpart of `observe-access.ts` (review
 * 2026-10-02 R-37 / maintainer decision D-20 — "AgentProfile / AgentPolicy narrowing binds running
 * Workers and MCP Handles, enforced at call time; the read model and enforcement must use one
 * predicate").
 *
 * A Handle's `resources.gatekeeper` is fixed when it is minted: the entry Handle from the member's
 * `effective.enabledGatekeepers`, a Worker's child Handle attenuated from its parent, an
 * `issue_handle` Handle from the same ceiling as the entry Handle. Before R-37 nothing re-checked
 * it, so once a member unticked gate G on My Agent, or the owner capped G out in the AgentPolicy
 * (or the member's Grant was revoked), `execution_readiness` already said "excluded" while a
 * running Worker's `request_action` on G still executed. Now every execute decision for a Handle
 * caller keeps only the gates the `onBehalfOf` principal may act on **now**, resolved by the one
 * rule My Agent's "当前生效" and `execution_readiness` use (`resolveEnabledGatekeepers`,
 * governance/agent-profile/resolve.ts — available gates minus the member's AgentProfile exclusions,
 * capped by the AgentPolicy):
 *
 *   - for a non-owner, the available gates are their current gate Grants, so the result is exactly
 *     their `effective.enabledGatekeepers`;
 *   - for a workspace owner, who holds every scope (§5.8 / I14 — a Worker the owner starts directly
 *     is minted with `unconstrained` parent authority, application/task/handle-mint.ts), the
 *     available gates are the Handle's own: only the AgentPolicy cap and the owner's own
 *     AgentProfile exclusions narrow them.
 *
 * Consumers: `request_action`'s governed path (application/gateway/request-action-handler.ts — a
 * gate dropped since the Handle was minted falls outside the requester scope, so the policy engine
 * records a `deny` ActionRequest and the caller gets 403) and `list_allowed_operations`
 * (application/gateway/worker-result-handler.ts — the same gates drop out of the execute-class tool
 * list). `issue_handle` (application/gateway/issue-handle-handler.ts) mints with
 * `entryGatekeeperIds`, the entry Handle's own gate set. Observation is unaffected: it needs no
 * Grant and keeps its own predicate (`observeRefusal`).
 */

/** Everything the execute rule reads about one principal — read once per call, fresh. */
export interface ExecuteAccess {
  readonly role: Role | undefined;
  readonly profile: AgentProfileRow | undefined;
  readonly policy: AgentPolicyRow;
  readonly grantedGatekeeperIds: readonly string[];
}

export async function readExecuteAccess(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<ExecuteAccess> {
  // One client, one query at a time (pg rejects concurrent queries on a client).
  const roleResult = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const profile = await readAgentProfile(client, workspaceId, principalId);
  const policy = await readAgentPolicy(client, workspaceId);
  const grantedGatekeeperIds = await listActiveGrantResourceScopes(client, workspaceId, {
    principalId,
    resourceType: GATEKEEPER_GRANT_CAPABILITY,
  });
  return { role: roleResult.rows[0]?.role, profile, policy, grantedGatekeeperIds };
}

/** The entry Handle's gate set — `effective.enabledGatekeepers` (Grants minus AgentProfile
 *  exclusions, capped by the AgentPolicy), for every role: what `ensureEntryHandle` mints and
 *  what `issue_handle` mints an MCP Handle with. */
export function entryGatekeeperIds(access: ExecuteAccess): readonly string[] {
  return resolveEnabledGatekeepers(access.profile, access.policy, access.grantedGatekeeperIds);
}

/** Which of `candidates` (a Handle's own `resources.gatekeeper`) the principal may act on now —
 *  see the module doc comment. Never adds an id that is not in `candidates`. */
export function executableGatekeepers(
  access: ExecuteAccess,
  candidates: readonly string[],
): readonly string[] {
  const available = access.role === 'owner' ? candidates : access.grantedGatekeeperIds;
  const enabled = new Set(resolveEnabledGatekeepers(access.profile, access.policy, available));
  return candidates.filter((id) => enabled.has(id));
}

/** `scope` with its `resources.gatekeeper` narrowed by `executableGatekeepers`; every other axis
 *  is unchanged. An empty result drops the key, the same shape a Handle minted with no gate has. */
export function narrowScopeToExecutableGates(
  scope: CapabilityScope,
  access: ExecuteAccess,
): CapabilityScope {
  const current = scope.resources.gatekeeper;
  if (current === undefined) return scope;
  const narrowed = executableGatekeepers(access, current);
  const resources: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(scope.resources)) {
    if (key !== 'gatekeeper') resources[key] = [...ids];
  }
  if (narrowed.length > 0) resources.gatekeeper = [...narrowed];
  return { ...scope, resources };
}
