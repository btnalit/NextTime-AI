import type { ActionRequestStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { computeActionRequestHolders } from './routing.js';

/**
 * governance/approval/transition-log: the shared "record one ActionRequest transition" helper
 * every mutator in this module calls (design doc §5.4 I11, §7.10 domain events; docs/development-
 * tasks.md S2.3 "每次状态转移在同事务写 outbox 发布 ActionRequestPending / ActionRequestUpdated").
 *
 * Audit/outbox discipline (I11): every function that performs a real ActionRequest status
 * transition calls this in the same transaction as the row update — this holds regardless of
 * whether the caller also happens to be `application/gateway/dispatch.ts` (which writes its own,
 * coarser "this capability was called" audit row after the handler returns, for the
 * capability-dispatched methods `request_action`/`approve`/`reject`). The two rows are
 * complementary, not duplicates: dispatch.ts's row documents the API call (channel, on_behalf_of,
 * raw params); this row documents the *domain* transition (which event fired, on which
 * ActionRequest) — and for `expire`/`start_execution`/`mark_executed`/`mark_failed`/`compensate`,
 * which are never reached through `dispatchCapability` at all (S2.4's drain path and this module's
 * own reaper call them directly), this is the *only* audit/outbox write that will ever exist for
 * that transition.
 */

export interface RecordTransitionParams {
  readonly actorPrincipalId: string;
  /** e.g. `action_request.approve` — this module's own `audit_records.action` vocabulary, one
   *  entry per `ActionRequestEvent`. */
  readonly action: string;
  readonly actionRequestId: string;
  readonly resultingStatus: ActionRequestStatus;
  /** Present only when this transition just entered `pending_approval` — carries the I14 holder
   *  list so `chat`/`web` (S2.11/S2.10, out of this task's scope) know whose Chat/queue to push a
   *  system message into. */
  readonly pendingApprovalFanout?: {
    readonly gatekeeperId: string;
    readonly actionKind: string;
    readonly resourceScope: string | null;
  };
  /** Extra fields merged into the AuditRecord's `payload` alongside `resultingStatus` — e.g.
   *  `mark_executed`'s `resultMetadata` or `mark_failed`/`reject`'s `reason` (execution.ts,
   *  decide.ts). Never a credential (same rule `writeAudit`'s own doc comment states). */
  readonly extraAuditPayload?: Record<string, unknown>;
}

export async function recordTransition(
  client: PoolClient,
  workspaceId: string,
  params: RecordTransitionParams,
): Promise<void> {
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: params.actorPrincipalId,
    action: params.action,
    resourceType: 'action_request',
    resourceId: params.actionRequestId,
    payload: { resultingStatus: params.resultingStatus, ...params.extraAuditPayload },
  });

  if (params.resultingStatus === 'pending_approval' && params.pendingApprovalFanout) {
    const holderPrincipalIds = await computeActionRequestHolders(client, workspaceId, {
      actionKind: params.pendingApprovalFanout.actionKind,
      resourceScope: params.pendingApprovalFanout.resourceScope,
    });
    await enqueue(client, {
      type: 'ActionRequestPending',
      workspaceId,
      actionRequestId: params.actionRequestId,
      gatekeeperId: params.pendingApprovalFanout.gatekeeperId,
      actionKind: params.pendingApprovalFanout.actionKind,
      resourceScope: params.pendingApprovalFanout.resourceScope ?? undefined,
      holderPrincipalIds: [...holderPrincipalIds],
    });
    return;
  }

  await enqueue(client, {
    type: 'ActionRequestUpdated',
    workspaceId,
    actionRequestId: params.actionRequestId,
    status: params.resultingStatus,
  });
}
