import type { ActionRequestStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  ActionRequestConcurrentTransitionError,
  type ActionRequestDbRow,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/status-transition: the one conditional-UPDATE primitive every governed
 * ActionRequest transition uses to actually change `status` (I6/I11 concurrency hardening).
 * Shared by `decide.ts` (`approve`/`reject`, which also pass `approvalDecisionId`) and
 * `execution.ts` (`start_execution`/`mark_executed`/`mark_failed`/`compensate`/`expire`) so there
 * is exactly one place that writes this column.
 *
 * The `and status = $expectedStatus` clause is the actual correctness guarantee, not a
 * belt-and-suspenders extra: an `UPDATE ... WHERE ...` is itself an atomic compare-and-swap at the
 * row level — Postgres takes a row lock the instant it finds a row matching the WHERE clause, and
 * if another transaction already holds a conflicting lock on that row, this UPDATE blocks until
 * that transaction commits or rolls back, then *re-evaluates* its WHERE clause against the now-
 * current row. So even a caller that skipped `reads.ts`'s `getActionRequestForUpdate` (`SELECT
 * ... FOR UPDATE`) earlier in its own transaction cannot double-write: the second of two
 * concurrent callers either blocks-then-fails-the-WHERE-clause here (0 rows returned ->
 * `ActionRequestConcurrentTransitionError`) or, in the common case where it *did* take the lock
 * first, already failed one step earlier at the ordinary `transition()` table lookup (a plain
 * `IllegalTransition`) because its locked read returned the already-updated status. Either way,
 * two concurrent transitions off the same starting status can never both succeed.
 */
export interface UpdateActionRequestStatusInput {
  readonly status: ActionRequestStatus;
  /** The status this row must currently be in for the UPDATE to apply — normally the exact status
   *  the caller's earlier `getActionRequestForUpdate`/`getActionRequestForUpdateOrThrow` read. */
  readonly expectedStatus: ActionRequestStatus;
  /** `decide.ts` only — the Approval Decision written just before this call. */
  readonly approvalDecisionId?: string;
  readonly executedAt?: Date;
  readonly failedAt?: Date;
}

/** Throws {@link ActionRequestConcurrentTransitionError} (a subclass of `@nexttime/shared`'s
 *  `IllegalTransition`) if the conditional UPDATE affects 0 rows. */
export async function updateActionRequestStatusConditional(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
  next: UpdateActionRequestStatusInput,
): Promise<ActionRequestRow> {
  const result = await client.query<ActionRequestDbRow>(
    `update action_requests
     set status = $3,
         approval_decision_id = coalesce($4::uuid, approval_decision_id),
         executed_at = coalesce($5::timestamptz, executed_at),
         failed_at = coalesce($6::timestamptz, failed_at)
     where workspace_id = $1 and id = $2 and status = $7
     returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [
      workspaceId,
      actionRequestId,
      next.status,
      next.approvalDecisionId ?? null,
      next.executedAt ?? null,
      next.failedAt ?? null,
      next.expectedStatus,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ActionRequestConcurrentTransitionError(
      actionRequestId,
      next.expectedStatus,
      next.status,
    );
  }
  return mapActionRequestRow(row);
}
