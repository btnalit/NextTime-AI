import type { ActionRequestRow } from '../../governance/approval/index.js';

/**
 * application/gateway/action-request-wire: the one wire-projection function for ActionRequest
 * (docs/wire-contract-conventions.md §2, 2026-09-08 decision — "投影函数在 application 层，一处定义"),
 * shared by every handler that returns an ActionRequest resource (`approve`/`reject`/`get_action`
 * in handlers.ts, `request_action`'s own phase-1/phase-2 results in request-action-handler.ts) so
 * they never drift on shape. `governance/approval`'s own `ActionRequestRow` stays exactly as it
 * is — it is the internal DB-row-shaped type every governance/approval module reads and writes —
 * this function is purely the boundary projection:
 *
 *   - primary key stays `id` (never duplicated as a top-level `actionRequestId` alongside it —
 *     §2 "不再在顶层重复 actionRequestId").
 *   - `actionKind` (the bare tag string) becomes `actionKindTag` (§1 vocabulary table — the name
 *     `actionKind` is reserved for ActionDescription's own `{tag,label}` display object).
 *   - every `*At` field is an ISO string (already true for a `Date` via `JSON.stringify`, made
 *     explicit here to match `toWireTask`/`toWireWorkerDefinition`'s own convention).
 *   - `workspaceId`/`idempotencyKey` are dropped — internal-only, never part of what a client reads
 *     back about an ActionRequest.
 */
export function toWireActionRequest(row: ActionRequestRow) {
  return {
    id: row.id,
    status: row.status,
    gatekeeperId: row.gatekeeperId,
    actionKindTag: row.actionKind,
    resourceScope: row.resourceScope,
    blastRadius: row.blastRadius,
    policyDecision: row.policyDecision,
    approvalDecisionId: row.approvalDecisionId,
    awaitDecision: row.awaitDecision,
    onBehalfOf: row.onBehalfOf,
    parentWorkerRunId: row.parentWorkerRunId,
    actorRuntime: row.actorRuntime,
    params: row.params,
    requestedAt: row.requestedAt.toISOString(),
    executingAt: row.executingAt ? row.executingAt.toISOString() : null,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    requesterCanApprove: row.requesterCanApprove,
  };
}

export type WireActionRequest = ReturnType<typeof toWireActionRequest>;
