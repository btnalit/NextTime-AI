import { CONFLICT_TRANSITIONS, DECISION_TRANSITIONS, transition } from '@nexttime/shared';
import type { ConflictStatus } from '@nexttime/shared';
import {
  type ConflictRow,
  type DecisionRow,
  causalChain,
  decisionImpact,
  endActivity,
  findPrecedents,
  getConflictForUpdate,
  hasEvidence,
  listConflicts,
  markConflictResolved,
  queryDecisions,
  startActivity,
} from '../../substrate/epistemic/index.js';
import { SqlGraphStore } from '../../substrate/graph/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';
import { toWireFact } from './resource-wire.js';

/**
 * application/gateway/epistemic-handlers: the seven S3.2 `epistemic`-group capability handlers
 * (docs/development-tasks.md S3.2, "S3 实施波次" row W2-A) — `list_conflicts`, `resolve_conflict`,
 * `verify_fact`, `query_decisions`, `causal_chain`, `decision_impact`, `find_precedents`. Thin
 * wire projections over `substrate/epistemic/{conflicts,decisions,evidence}.ts`'s actual logic,
 * the same shape every other `*-handlers.ts` file in this directory already follows
 * (`ontology-handlers.ts`'s own module doc comment) — with two exceptions
 * (`resolveConflictHandler`, `verifyFactHandler`) that genuinely coordinate `substrate/graph` and
 * `substrate/epistemic` together, which is exactly what the *application* layer is for
 * (`application/task/result.ts`'s `postWorkerResult` is the established precedent: cross-
 * substrate-module coordination belongs here, never one substrate module reaching into another's
 * tables — see `substrate/epistemic/conflicts.ts`'s own module doc comment for the one narrow,
 * documented exception to that rule this task's write path needed).
 *
 * `ctx?.principalId ?? (await currentPrincipalId(client))` mirrors `ontology-handlers.ts`'s /
 * `skill-procedure-handlers.ts`'s identical fallback.
 */

const graphStore = new SqlGraphStore();

function toWireConflict(row: ConflictRow) {
  return {
    id: row.id,
    conflictType: row.conflictType,
    status: row.status,
    factAId: row.factAId,
    factBId: row.factBId,
    description: row.description,
    activityId: row.activityId,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy,
    resolution: row.resolution,
  };
}

function toWireDecision(row: DecisionRow) {
  return {
    id: row.id,
    status: row.status,
    activityId: row.activityId,
    sourceId: row.sourceId,
    summary: row.summary,
    rationale: row.rationale,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

// -------------------------------------------------------------------------------------------
// list_conflicts
// -------------------------------------------------------------------------------------------

export const listConflictsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { status, limit, cursor } = params as {
    status?: ConflictStatus;
    limit?: number;
    cursor?: string;
  };
  const page = await listConflicts(client, workspaceId, { status, limit, cursor });
  return {
    result:
      page.nextCursor === undefined
        ? { items: page.items.map(toWireConflict) }
        : { items: page.items.map(toWireConflict), nextCursor: page.nextCursor },
  };
};

// -------------------------------------------------------------------------------------------
// resolve_conflict
// -------------------------------------------------------------------------------------------

/**
 * `keep_a`/`keep_b` invalidate the losing side; `invalidate_both` invalidates both (module doc
 * comment: no new Fact content is being asserted by a resolution, so `GraphStore.invalidateFact`
 * — never `supersedeFact` — is the correct I4 operation for every one of the three choices).
 * `CONFLICT_TRANSITIONS`' single `resolve` event covers all three (`open -> resolved`) — which
 * specific choice was made is recorded in `resolution` (the `conflicts` row) and in the Decision's
 * own `rationale`, not as three different target statuses (`accepted_both`/`dismissed` mean
 * something else entirely — "both sides accepted as still valid" / "not a real conflict" — neither
 * matches any of `keep_a`/`keep_b`/`invalidate_both`, see PR body "假设").
 */
export const resolveConflictHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { conflictId, resolution, reason } = params as {
    conflictId: string;
    resolution: 'keep_a' | 'keep_b' | 'invalidate_both';
    reason: string;
  };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const conflict = await getConflictForUpdate(client, workspaceId, conflictId);
  // Throws IllegalTransition (409) if `conflict.status` is not `open` — before any write, same
  // "check the transition table before touching anything" convention every other governed
  // transition in this codebase follows (e.g. `governance/approval/decide.ts`).
  const nextStatus = transition(CONFLICT_TRANSITIONS, conflict.status, 'resolve');

  const loserFactIds =
    resolution === 'keep_a'
      ? [conflict.factBId]
      : resolution === 'keep_b'
        ? [conflict.factAId]
        : [conflict.factAId, conflict.factBId];

  const activity = await startActivity(client, workspaceId, {
    kind: 'epistemic.conflict_resolution',
    principalId,
    metadata: { conflictId, resolution },
  });

  try {
    for (const factId of loserFactIds) {
      await graphStore.invalidateFact(
        client,
        workspaceId,
        { id: principalId },
        { factId, reason: `resolve_conflict ${conflictId}: ${resolution} (${reason})` },
      );
    }
    await endActivity(client, workspaceId, activity.id, 'completed');
  } catch (err) {
    await endActivity(client, workspaceId, activity.id, 'failed').catch(() => {
      // Best-effort — see `application/task/result.ts`'s `postWorkerResult` for the same
      // convention: a failed endActivity here must never mask the real error.
    });
    throw err;
  }

  const updated = await markConflictResolved(client, workspaceId, {
    conflictId,
    status: nextStatus,
    resolvedBy: principalId,
    resolution: { choice: resolution, reason },
  });

  // Records the resolution as a Decision (design doc §5.2 "Turn --generated--> Decision" is the
  // entry-agent path `record_decision` already covers, handlers.ts; this is the governed-action
  // counterpart, same shape `governance/approval/decide.ts`'s `writeApprovalDecision` uses:
  // inserted directly at an already-resolved status, not `proposed` first, because the human
  // action that produced this row *is* the decision, not a proposal awaiting one).
  const decisionStatus = transition(DECISION_TRANSITIONS, 'proposed', 'approve');
  await client.query(
    `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by, decided_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())`,
    [
      workspaceId,
      decisionStatus,
      activity.id,
      `resolve_conflict ${conflictId}: ${resolution}`,
      JSON.stringify({
        conflictId,
        resolution,
        reason,
        factAId: conflict.factAId,
        factBId: conflict.factBId,
      }),
      principalId,
    ],
  );

  return { result: toWireConflict(updated), resourceType: 'conflict', resourceId: conflictId };
};

// -------------------------------------------------------------------------------------------
// verify_fact
// -------------------------------------------------------------------------------------------

/** I3.6's "harder half" (design doc §5.3 item 6, migrations/core/0002_substrate.sql's own comment)
 *  — the DB CHECK alone only enforces `verified ⇒ verified_by not null`; this is the "⇒ Evidence"
 *  half. Not mapped in interfaces/ws/rpc.ts or interfaces/http/capability-route.ts, matching this
 *  same handler group's sibling `NoActiveTurnError`/`TurnNotFoundError` (handlers.ts) — falls
 *  through to a generic 500/INTERNAL_ERROR. */
export class FactHasNoEvidenceError extends Error {
  constructor(factId: string) {
    super(`verify_fact: Fact ${factId} has no Evidence on file (I3.6)`);
    this.name = 'FactHasNoEvidenceError';
  }
}

export const verifyFactHandler: CapabilityHandler = async (client, workspaceId, params, ctx) => {
  const { factId } = params as { factId: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const evidenced = await hasEvidence(client, workspaceId, factId);
  if (!evidenced) throw new FactHasNoEvidenceError(factId);

  const fact = await graphStore.verifyFact(client, workspaceId, { id: principalId }, { factId });
  return { result: toWireFact(fact), resourceType: 'fact', resourceId: factId };
};

// -------------------------------------------------------------------------------------------
// query_decisions / find_precedents / causal_chain / decision_impact
// -------------------------------------------------------------------------------------------

export const queryDecisionsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId, since, limit, cursor } = params as {
    objectId?: string;
    since?: string;
    limit?: number;
    cursor?: string;
  };
  const page = await queryDecisions(client, workspaceId, { objectId, since, limit, cursor });
  return {
    result:
      page.nextCursor === undefined
        ? { items: page.items.map(toWireDecision) }
        : { items: page.items.map(toWireDecision), nextCursor: page.nextCursor },
  };
};

export const findPrecedentsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { objectId, actionKindTag, limit } = params as {
    objectId?: string;
    actionKindTag?: string;
    limit?: number;
  };
  const page = await findPrecedents(client, workspaceId, { objectId, actionKindTag, limit });
  return { result: { items: page.items.map(toWireDecision) } };
};

export const causalChainHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { factId, decisionId, depth } = params as {
    factId?: string;
    decisionId?: string;
    depth?: number;
  };
  const result = await causalChain(client, workspaceId, { factId, decisionId, depth });
  return { result, resourceType: result.rootType, resourceId: result.rootId };
};

export const decisionImpactHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { decisionId } = params as { decisionId: string };
  const result = await decisionImpact(client, workspaceId, { decisionId });
  return {
    result: {
      decisionId: result.decisionId,
      facts: result.facts.map(toWireFact),
      actionRequests: result.actionRequests,
      taskIds: result.taskIds,
    },
    resourceType: 'decision',
    resourceId: decisionId,
  };
};
