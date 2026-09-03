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
  readonly executedAt: Date | null;
  readonly failedAt: Date | null;
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
  executed_at: Date | null;
  failed_at: Date | null;
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
    executedAt: row.executed_at,
    failedAt: row.failed_at,
  };
}

export const ACTION_REQUEST_ROW_COLUMNS =
  'workspace_id, id, status, gatekeeper_id, action_kind, resource_scope, blast_radius, ' +
  'policy_decision, approval_decision_id, await_decision, on_behalf_of, parent_worker_run_id, ' +
  'actor_runtime, idempotency_key, requested_at, executed_at, failed_at';

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
