import type { DraftOrigin, PrincipalKind, Role } from '@nexttime/shared';
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
 * S11 AA3a (legacy 293): who a draft proposed through this call is written by — `human` when a
 * person calls over the human channel; `agent` otherwise: through a Handle (an entry agent, a
 * Worker, an admin agent), or a service Principal's API key over the human channel (an
 * automation credential is not a person, as `ChangeApplierNotAPersonError` and
 * `publish_operation`'s reviewed-absent rule hold). From the channel and the Principal dispatch.ts
 * authenticated, never from the params; no `ctx` (a test driving the handler directly) counts as
 * a Handle, as `propose_operation`'s proposer kind does.
 */
export function draftOriginOf(ctx: CapabilityHandlerContext | undefined): DraftOrigin {
  return callerKindOf(ctx) === 'human' ? 'human' : 'agent';
}

/**
 * Legacy 616: what kind of caller made this call, for a write that records one beside the
 * Principal it is for (`propose_operation`'s `proposedBy.kind`, `request_connection`'s
 * `requestedBy.kind`). Over the human channel, the Principal dispatch.ts authenticated, by its own
 * kind: a person `human`, a service Principal's API key `service`. Through a Handle, or with no
 * resolved Principal (a test driving the handler directly), `agent`, as `draftOriginOf` counts
 * it. Never the channel alone: a service's API key is the human channel too. A draft's origin is
 * `human` exactly when this is `human` (`draftOriginOf` is defined from it), so the two cannot
 * disagree.
 */
export function callerKindOf(ctx: CapabilityHandlerContext | undefined): PrincipalKind {
  return ctx?.channel === 'human' && ctx.principal ? ctx.principal.kind : 'agent';
}

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
 * every request's Decisions, anyone else's agent those `get_action`'s visibility predicate admits
 * for its `obo`, but only its own principal's goal runs' (`get_goal`'s rule, goal-handlers.ts
 * `goalViewer`). A request's Decisions follow `get_action`'s visibility predicate, not its channel
 * and role floor (human channel, `operator`): `find_precedents` exists to show an agent approval
 * precedents, and a member reads the approval of a request they made themselves. No `ctx`: the RLS
 * session principal, as an owner on no channel — every request, its own goal runs only.
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
