import type { Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { DraftViewer } from '../../application/worker/index.js';
import { seesEveryDraft } from '../../governance/capability/index.js';
import type { DecisionViewer } from '../../substrate/epistemic/index.js';
import type { GraphReadViewer } from '../../substrate/graph/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandlerContext } from './capability-handler.js';

/**
 * application/gateway/draft-viewer: who a draft-narrowed read is for (review 2026-10-02 D-26).
 * Moved here from skill-procedure-handlers.ts (#462) when the generic graph reads started using it
 * too (STATUS leftover 123).
 */

/**
 * Who a draft-narrowed read (Skill / Procedure registries, the generic graph reads) is narrowed
 * for. Human channel: the Principal dispatch.ts resolved. Those reads are `channel: 'handle'` too,
 * and there the viewer is the Handle's `obo` (I13, `ctx.principalId`) with that principal's own
 * workspace role — an agent sees exactly the drafts its human may see, never more. No `ctx` (a
 * test driving the handler directly): the RLS session principal, the same fallback
 * `currentPrincipalId` gives every other handler.
 */
export async function draftViewerOf(
  client: PoolClient,
  workspaceId: string,
  ctx: CapabilityHandlerContext | undefined,
): Promise<DraftViewer> {
  if (ctx?.principal) return { principalId: ctx.principal.id, role: ctx.principal.role };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  return { principalId, role: await principalRole(client, workspaceId, principalId) };
}

async function principalRole(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<Role> {
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, principalId],
  );
  const role = result.rows[0]?.role;
  if (!role) {
    throw new Error(
      `draftViewerOf: principal ${principalId} not found in workspace ${workspaceId}`,
    );
  }
  return role;
}

/**
 * STATUS leftover 123: the same viewer in the graph layer's terms (substrate/graph/
 * operation-draft-visibility.ts) — `seesEveryDraft` is governance's reviewer rule for that role,
 * so `get_object` / `search` / `traverse` / `state_at` / `explain` hide exactly the Operation
 * drafts `list_operations` hides from this caller.
 */
export async function graphReadViewerOf(
  client: PoolClient,
  workspaceId: string,
  ctx: CapabilityHandlerContext | undefined,
): Promise<GraphReadViewer> {
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  return { principalId: viewer.principalId, seesEveryDraft: seesEveryDraft(viewer.role) };
}

/**
 * Legacy 421: the caller as a reader of Decisions (substrate/epistemic/decision-visibility.ts).
 * Human channel: the resolved Principal — the owner reads every goal run's and every request's
 * Decisions. Handle channel: the Handle's `obo` with that principal's role — an owner's agent reads
 * every request's Decisions (`get_action` reads the role the same way) but only its own principal's
 * goal runs' (`get_goal`'s rule, goal-handlers.ts `goalViewer`). No `ctx`: the RLS session
 * principal, as an owner on no channel — every request, its own goal runs only.
 */
export async function decisionViewerOf(
  client: PoolClient,
  workspaceId: string,
  ctx: CapabilityHandlerContext | undefined,
): Promise<DecisionViewer> {
  const viewer = await draftViewerOf(client, workspaceId, ctx);
  const owner = viewer.role === 'owner';
  return {
    principalId: viewer.principalId,
    seesEveryGoalRun: owner && ctx?.principal !== undefined,
    seesEveryActionRequest: owner,
  };
}

/**
 * The Explorer's caller (a human-channel API key, explorer-read-service.ts, which has no handler
 * context): the viewers a human caller of `explain` / `query_decisions` gets — Operation drafts
 * narrowed by its role, Decisions by its role on the human channel (legacy 421).
 */
export async function humanReadViewersOf(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<{ readonly decisions: DecisionViewer; readonly drafts: GraphReadViewer }> {
  const role = await principalRole(client, workspaceId, principalId);
  return {
    decisions: {
      principalId,
      seesEveryGoalRun: role === 'owner',
      seesEveryActionRequest: role === 'owner',
    },
    drafts: { principalId, seesEveryDraft: seesEveryDraft(role) },
  };
}
