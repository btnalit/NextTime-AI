import { IllegalTransition } from '@nexttime/shared';
import type { ActionRequestStatus, BlastRadius, PolicyDecision } from '@nexttime/shared';

/**
 * governance/approval/types: the `ActionRequestRow` shape every other file in this module reads
 * and writes (migrations/governance/0003_action_requests.sql), plus the DB-row mapper and the two
 * error classes callers of this module are expected to catch. Split out from `service.ts` per the
 * design doc's own file-size guidance (§7.10 "单文件 ≤ 600 行...超过即拆，不等重构").
 */

export interface ActionRequestRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly status: ActionRequestStatus;
  readonly gatekeeperId: string;
  readonly actionKind: string;
  readonly resourceScope: string | null;
  readonly blastRadius: BlastRadius;
  readonly policyDecision: PolicyDecision | null;
  readonly approvalDecisionId: string | null;
  readonly awaitDecision: boolean;
  readonly onBehalfOf: string;
  readonly parentWorkerRunId: string | null;
  readonly actorRuntime: string;
  readonly idempotencyKey: string | null;
  readonly requestedAt: Date;
  /** Set once, by `execution.ts`'s `startActionRequestExecution` (`auto_approved|approved ->
   *  executing`) — migrations/governance/0006_action_request_executing_at.sql. The staleness
   *  anchor `application/gateway/action-executor.ts`'s `reapStaleExecutingActionRequests` (P1-3
   *  fix) scans on, deliberately distinct from `requestedAt` (see that migration's own doc
   *  comment for why `requestedAt` cannot serve this purpose). */
  readonly executingAt: Date | null;
  readonly executedAt: Date | null;
  readonly failedAt: Date | null;
  /** The Operation call's own arguments (migrations/governance/0004_action_request_params.sql,
   *  S2.4) — `ActionExecutor.execute()` (`application/gateway/action-executor.ts`) needs these
   *  again at `apply` time, which may run in a different transaction than `request_action` (auto-
   *  approval executes inline; a `pending_approval` row is applied later by the drainer). */
  readonly params: Record<string, unknown>;
  /** `governance/policy/engine.ts`'s `evaluate()` own `requesterCanApprove` result, persisted at
   *  request time (authority-tightening fix, review job 652a4abc item 3: "persist
   *  requester_can_approve on ActionRequests and reject self-approval ... for high-blast
   *  requests") — migrations/governance/0007_action_request_requester_can_approve.sql.
   *  `decide.ts`'s `assertApproverScope` reads this back to refuse `approver === on_behalf_of`
   *  when it is `false` (I8 §5.8 "blast_radius=high 默认 requester_can_approve=false，工作区可覆盖").
   *  Nullable: rows written before this migration have no value on file — treated as permissive
   *  (self-approval not blocked) rather than retroactively locking out a historical row this fix
   *  never evaluated; every row `request-action.ts` writes going forward always sets it. */
  readonly requesterCanApprove: boolean | null;
}

export interface ActionRequestDbRow {
  workspace_id: string;
  id: string;
  status: ActionRequestStatus;
  gatekeeper_id: string;
  action_kind: string;
  resource_scope: string | null;
  blast_radius: BlastRadius;
  policy_decision: PolicyDecision | null;
  approval_decision_id: string | null;
  await_decision: boolean;
  on_behalf_of: string;
  parent_worker_run_id: string | null;
  actor_runtime: string;
  idempotency_key: string | null;
  requested_at: Date;
  executing_at: Date | null;
  executed_at: Date | null;
  failed_at: Date | null;
  params: Record<string, unknown>;
  requester_can_approve: boolean | null;
}

export function mapActionRequestRow(row: ActionRequestDbRow): ActionRequestRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    status: row.status,
    gatekeeperId: row.gatekeeper_id,
    actionKind: row.action_kind,
    resourceScope: row.resource_scope,
    blastRadius: row.blast_radius,
    policyDecision: row.policy_decision,
    approvalDecisionId: row.approval_decision_id,
    awaitDecision: row.await_decision,
    onBehalfOf: row.on_behalf_of,
    parentWorkerRunId: row.parent_worker_run_id,
    actorRuntime: row.actor_runtime,
    idempotencyKey: row.idempotency_key,
    requestedAt: row.requested_at,
    executingAt: row.executing_at,
    executedAt: row.executed_at,
    failedAt: row.failed_at,
    params: row.params,
    requesterCanApprove: row.requester_can_approve,
  };
}

export const ACTION_REQUEST_ROW_COLUMNS =
  'workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius, ' +
  'policy_decision, approval_decision_id, await_decision, on_behalf_of, parent_worker_run_id, ' +
  'actor_runtime, idempotency_key, requested_at, executing_at, executed_at, failed_at, params, ' +
  'requester_can_approve';

export class ActionRequestNotFoundError extends Error {
  constructor(workspaceId: string, actionRequestId: string) {
    super(`ActionRequest not found: workspace ${workspaceId}, id ${actionRequestId}`);
    this.name = 'ActionRequestNotFoundError';
  }
}

/** I14: the approver holds no active `capability_grants` row (nor the workspace-owner override)
 *  covering an ActionRequest's `action_kind` × `resource_scope`. Declared locally (not reused from
 *  `application/gateway/authorize.ts`'s `ForbiddenError`) because governance may not depend on the
 *  application layer (§7.10) — `interfaces/http/capability-route.ts`'s `mapCapabilityError` maps
 *  this to HTTP 403 alongside `ForbiddenError` (this task's own addition to that file). */
export class ApprovalScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalScopeError';
  }
}

/** I8/§5.8 (authority-tightening fix, review job 652a4abc item 3): the approver is the same
 *  principal the ActionRequest was made `on_behalf_of`, and `requesterCanApprove` is `false` for
 *  this row (defaults `false` for `blast_radius='high'`, workspace-overridable either way —
 *  `governance/policy/engine.ts`'s `resolveRequesterCanApprove`). Extends `ApprovalScopeError`
 *  (not a fresh top-level class) so every existing `instanceof ApprovalScopeError` mapping
 *  (`interfaces/http/capability-route.ts`, `interfaces/ws/rpc.ts` — both 403) already covers it
 *  with no new mapping branch, the same pattern `MetaOntologyWriteForbiddenError extends
 *  ForbiddenError` uses one layer up. */
export class SelfApprovalNotAllowedError extends ApprovalScopeError {
  readonly actionRequestId: string;
  constructor(actionRequestId: string, principalId: string) {
    super(
      `principal ${principalId} may not approve/reject its own ActionRequest ${actionRequestId} ` +
        '(requester_can_approve=false, I8)',
    );
    this.name = 'SelfApprovalNotAllowedError';
    this.actionRequestId = actionRequestId;
  }
}

/**
 * I6/I11 concurrency hardening: thrown by `status-transition.ts`'s
 * `updateActionRequestStatusConditional` when its conditional `UPDATE ... WHERE status =
 * $expectedStatus` affects 0 rows — i.e. the row's status was no longer what the caller last read
 * it as, because another transaction transitioned it first. Extends `IllegalTransition` (same
 * `@nexttime/shared` class every other illegal-transition path already throws) so every existing
 * `instanceof IllegalTransition` check (409 mapping in `interfaces/http/capability-route.ts` /
 * `interfaces/ws/rpc.ts`, this task's own DB-integration tests) keeps working without a new
 * mapping branch — this is a *more specific* instance of "no legal edge from where the row
 * actually is", not a different failure class.
 *
 * In practice this fires only when a caller skipped `reads.ts`'s `getActionRequestForUpdate`
 * (`SELECT ... FOR UPDATE`) before transitioning: with that lock held, a second concurrent caller
 * blocks until the first commits, then re-reads the *already-updated* status and fails earlier —
 * at the ordinary `transition()` table-lookup step, with a plain `IllegalTransition` — before ever
 * reaching this conditional UPDATE. This class exists so that even a future code path that forgets
 * the lock still cannot double-write a row (defense in depth, not the primary mechanism).
 */
export class ActionRequestConcurrentTransitionError extends IllegalTransition {
  readonly actionRequestId: string;

  constructor(actionRequestId: string, expectedStatus: string, attemptedStatus: string) {
    super('ActionRequest', expectedStatus, `transition_to_${attemptedStatus}`);
    this.name = 'ActionRequestConcurrentTransitionError';
    this.actionRequestId = actionRequestId;
    this.message = `ActionRequest ${actionRequestId}: concurrent transition — expected status "${expectedStatus}" but the conditional UPDATE to "${attemptedStatus}" affected 0 rows (another transaction changed it first)`;
  }
}
