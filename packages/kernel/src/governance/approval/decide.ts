import {
  ACTION_REQUEST_TRANSITIONS,
  DECISION_TRANSITIONS,
  type Role,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { approverHasScope, getActionRequestForUpdateOrThrow } from './reads.js';
import { updateActionRequestStatusConditional } from './status-transition.js';
import { recordTransition } from './transition-log.js';
import { type ActionRequestRow, ApprovalScopeError } from './types.js';

/**
 * governance/approval/decide: `approve` / `reject` (design doc §5.4 I6/I11/I14, §5.5, §8.5; docs/
 * development-tasks.md S2.3). Both are: lock the row -> I14 precheck -> governed transition on the
 * shared table (I6) -> write the Approval Decision -> conditional UPDATE (I6/I11 concurrency
 * hardening) -> `recordTransition` (I11 audit + outbox). That exact order matters:
 *
 *   1. `getActionRequestForUpdateOrThrow` (`SELECT ... FOR UPDATE`) — locks the row for the rest
 *      of this transaction. A second concurrent `approve`/`reject` on the same row blocks here
 *      until this transaction commits or rolls back, then re-reads the *already-updated* status.
 *   2. I14 precheck (`assertApproverScope`) and the `transition()` table lookup — the common case
 *      where a second concurrent caller loses the race fails *here*, with a plain
 *      `IllegalTransition` (its locked read already saw the new status), before ever writing a
 *      Decision row.
 *   3. `writeApprovalDecision` — only after both of the above have passed, so a request that was
 *      always going to fail (wrong scope, wrong starting status) never produces an orphaned
 *      Decision row.
 *   4. `updateActionRequestStatusConditional` (`status-transition.ts`) — the actual UPDATE, gated
 *      on `status = <the status this call's lock read saw>`. This is the correctness guarantee
 *      even if step 1's lock were somehow skipped by a future refactor (defense in depth, not the
 *      primary mechanism — see that module's own doc comment).
 *   5. `recordTransition` — I11 audit + outbox, only once the row has actually moved.
 */

export interface DecideActionRequestInput {
  readonly actionRequestId: string;
  readonly approverPrincipalId: string;
  readonly approverRole: Role;
  readonly reason?: string;
}

/**
 * Writes the Approval Decision this row's CHECK requires. `decisions.activity_id` is `NOT NULL`
 * (core/0002_substrate.sql) and no Activity already exists for a bare `request_action` call at
 * S2.3 (no Turn/Task linkage yet — S2.7/S2.11 wire that) — a minimal Activity is started and ended
 * here to carry it (`kind: 'governance.approval_decision'`).
 */
async function writeApprovalDecision(
  client: PoolClient,
  workspaceId: string,
  params: {
    readonly actionRequest: ActionRequestRow;
    readonly decidedBy: string;
    readonly event: 'approve' | 'reject';
    readonly reason?: string;
  },
): Promise<string> {
  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.approval_decision',
    principalId: params.decidedBy,
    metadata: {
      actionRequestId: params.actionRequest.id,
      actionKind: params.actionRequest.actionKind,
      event: params.event,
    },
  });
  await endActivity(client, workspaceId, activity.id, 'completed');

  const decisionStatus = transition(DECISION_TRANSITIONS, 'proposed', params.event);

  const result = await client.query<{ id: string }>(
    `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by, decided_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())
     returning id`,
    [
      workspaceId,
      decisionStatus,
      activity.id,
      `${params.event} action_request ${params.actionRequest.id}`,
      JSON.stringify({
        actionRequestId: params.actionRequest.id,
        actionKind: params.actionRequest.actionKind,
        resourceScope: params.actionRequest.resourceScope,
        reason: params.reason ?? null,
      }),
      params.decidedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('writeApprovalDecision: INSERT ... RETURNING produced no row');
  return row.id;
}

async function assertApproverScope(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
  existing: ActionRequestRow,
): Promise<void> {
  const allowed = await approverHasScope(client, workspaceId, approver, {
    actionKind: existing.actionKind,
    resourceScope: existing.resourceScope,
  });
  if (!allowed) {
    const resourceScopeSuffix = existing.resourceScope
      ? ` × resource_scope "${existing.resourceScope}"`
      : '';
    throw new ApprovalScopeError(
      `principal ${approver.principalId} does not hold action_kind "${existing.actionKind}"${resourceScopeSuffix} (I14)`,
    );
  }
}

/** Throws `ApprovalScopeError` (403) if the approver does not hold the required scope,
 *  `ActionRequestNotFoundError` (404) if the id does not resolve, or `IllegalTransition` (409,
 *  including its `ActionRequestConcurrentTransitionError` subclass) if the row is not currently
 *  `pending_approval`. */
export async function approveActionRequest(
  client: PoolClient,
  workspaceId: string,
  input: DecideActionRequestInput,
): Promise<ActionRequestRow> {
  const existing = await getActionRequestForUpdateOrThrow(
    client,
    workspaceId,
    input.actionRequestId,
  );
  await assertApproverScope(
    client,
    workspaceId,
    { principalId: input.approverPrincipalId, role: input.approverRole },
    existing,
  );

  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'approve');
  const approvalDecisionId = await writeApprovalDecision(client, workspaceId, {
    actionRequest: existing,
    decidedBy: input.approverPrincipalId,
    event: 'approve',
  });
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
    approvalDecisionId,
  });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: input.approverPrincipalId,
    action: 'action_request.approve',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
  });

  return updated;
}

/** Mirrors `approveActionRequest` for the `pending_approval -> rejected` transition. */
export async function rejectActionRequest(
  client: PoolClient,
  workspaceId: string,
  input: DecideActionRequestInput,
): Promise<ActionRequestRow> {
  const existing = await getActionRequestForUpdateOrThrow(
    client,
    workspaceId,
    input.actionRequestId,
  );
  await assertApproverScope(
    client,
    workspaceId,
    { principalId: input.approverPrincipalId, role: input.approverRole },
    existing,
  );

  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'reject');
  const approvalDecisionId = await writeApprovalDecision(client, workspaceId, {
    actionRequest: existing,
    decidedBy: input.approverPrincipalId,
    event: 'reject',
    reason: input.reason,
  });
  const updated = await updateActionRequestStatusConditional(client, workspaceId, existing.id, {
    status: nextStatus,
    expectedStatus: existing.status,
    approvalDecisionId,
  });

  await recordTransition(client, workspaceId, {
    actorPrincipalId: input.approverPrincipalId,
    action: 'action_request.reject',
    actionRequestId: existing.id,
    resultingStatus: nextStatus,
    extraAuditPayload: input.reason ? { reason: input.reason } : undefined,
  });

  return updated;
}
