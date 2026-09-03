import {
  ACTION_REQUEST_TRANSITIONS,
  type ActionRequestStatus,
  DECISION_TRANSITIONS,
  type Role,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { approverHasScope, getActionRequestOrThrow } from './reads.js';
import { recordTransition } from './transition-log.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  ActionRequestNotFoundError,
  type ActionRequestRow,
  ApprovalScopeError,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/decide: `approve` / `reject` (design doc §5.4 I14, §5.5, §8.5; docs/
 * development-tasks.md S2.3). Both are an I14 precheck, then a governed transition on the shared
 * table (I6), writing the Approval Decision (`decisions`) in the same transaction as the status
 * change (I7 amendment, PR #33 — `action_requests`' own CHECK requires `approval_decision_id` the
 * instant a row reaches `approved`/`rejected`, not only once execution is attempted).
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

async function updateStatusAndApprovalDecision(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  next: { readonly status: ActionRequestStatus; readonly approvalDecisionId: string },
): Promise<ActionRequestRow> {
  const result = await client.query<ActionRequestDbRow>(
    `update action_requests set status = $3, approval_decision_id = $4
     where workspace_id = $1 and id = $2
     returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, actionRequestId, next.status, next.approvalDecisionId],
  );
  const row = result.rows[0];
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return mapActionRequestRow(row);
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
 *  `ActionRequestNotFoundError` (404) if the id does not resolve, or `IllegalTransition` (409) if
 *  the row is not currently `pending_approval`. */
export async function approveActionRequest(
  client: PoolClient,
  workspaceId: string,
  input: DecideActionRequestInput,
): Promise<ActionRequestRow> {
  const existing = await getActionRequestOrThrow(client, workspaceId, input.actionRequestId);
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
  const updated = await updateStatusAndApprovalDecision(client, workspaceId, existing.id, {
    status: nextStatus,
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
  const existing = await getActionRequestOrThrow(client, workspaceId, input.actionRequestId);
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
  const updated = await updateStatusAndApprovalDecision(client, workspaceId, existing.id, {
    status: nextStatus,
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
