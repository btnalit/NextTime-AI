import {
  ACTION_REQUEST_TRANSITIONS,
  DECISION_TRANSITIONS,
  type PrincipalKind,
  type Role,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { getPublishedOperation } from '../gatekeepers/index.js';
import {
  assertCredentialsReviewed,
  countSuspectedSecrets,
  credentialReviewAudit,
} from '../redaction/index.js';
import { approverHasScope, getActionRequestForUpdateOrThrow } from './reads.js';
import { updateActionRequestStatusConditional } from './status-transition.js';
import { recordTransition } from './transition-log.js';
import {
  type ActionRequestRow,
  ApprovalReasonRequiredError,
  ApprovalScopeError,
  HumanDecisionRequiredError,
  SelfApprovalNotAllowedError,
} from './types.js';

/**
 * governance/approval/decide: `approve` / `reject` (design doc §5.4 I6/I11/I14, §5.5, §8.5; docs/
 * development-tasks.md S2.3). Both are: lock the row -> I14 precheck -> governed transition on the
 * shared table (I6) -> write the Approval Decision -> conditional UPDATE (I6/I11 concurrency
 * hardening) -> `recordTransition` (I11 audit + outbox). That exact order matters:
 *
 *   1. `getActionRequestForUpdateOrThrow` (`SELECT ... FOR UPDATE`) — locks the row for the rest
 *      of this transaction. A second concurrent `approve`/`reject` on the same row blocks here
 *      until this transaction commits or rolls back, then re-reads the *already-updated* status.
 *   2. I14 precheck (`assertApproverScope`), then the R-17 "a person decides" check
 *      (`assertPersonDecidesWhenRequired`), then — `approve` only — the S6-A C25 high-blast-radius
 *      `reason` requirement (`ApprovalReasonRequiredError`) and the suspected-credential
 *      confirmation (`CredentialReviewRequiredError`), then the `transition()` table lookup
 *      — the common case
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
  /** The human's stated rationale. For `approve` (S6-A C25) it is *required* when the row's
   *  `blastRadius` is `high` (`ApprovalReasonRequiredError` otherwise) and optional below that;
   *  for `reject` always optional. Trimmed before storage; a blank string counts as absent. */
  readonly reason?: string;
  /** `approve` only: the approver confirms the suspected credentials in the row's `params`
   *  (governance/redaction/credential-review.ts). Required when the server counts any
   *  (`CredentialReviewRequiredError` otherwise); ignored when it counts none. */
  readonly credentialsReviewed?: boolean;
}

/** `undefined` for a missing or whitespace-only reason, else the trimmed text — so the stored
 *  rationale / audit payload never carry an empty string and the `high` check cannot be satisfied
 *  with spaces. */
function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : undefined;
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
    /** Suspected credential values the approver confirmed (0: none to confirm). */
    readonly suspectedSecretValues?: number;
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
        ...credentialReviewAudit(params.suspectedSecretValues ?? 0),
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
  // Item 3 fix (review job 652a4abc: "self-approval of high-blast allowed"): checked before the
  // I14 scope lookup below — cheap (no DB round trip) and the more specific rule of the two. Only
  // fires when `requesterCanApprove` was explicitly persisted `false` (never for a historical row
  // with no value on file — see `ActionRequestRow.requesterCanApprove`'s own doc comment); the
  // workspace-owner override I14 grants below does *not* exempt self-approval — I8's
  // `requester_can_approve` and I14's scope check are independent gates, both must pass.
  if (existing.requesterCanApprove === false && approver.principalId === existing.onBehalfOf) {
    throw new SelfApprovalNotAllowedError(existing.id, approver.principalId);
  }

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

/**
 * R-17 (maintainer decision D-06, docs/code-review-2026-10-02.md): an ActionRequest no
 * auto-approval rule could ever resolve — `blast_radius = 'high'` (I8 "工作区不能关闭"), or an
 * Operation that is not `auto_approvable` (I8 signal 1; an unpublished Operation counts as not,
 * I17) — must be decided by a person, a `kind = 'human'` Principal. A service Principal's API key
 * also authenticates on the human channel (resolve-caller.ts), so without this an owner could
 * script `approve` and close an agent → bot loop with no person in it. Below that line a service
 * Principal may still decide — the same authority a configured auto-approval rule already has —
 * and the Approval Decision records it as `decided_by`.
 *
 * Both inputs are read here, never trusted from the caller, so every entry point that decides an
 * ActionRequest is covered: the approver's `principals.kind` (the same read
 * `substrate/epistemic`'s `attachHumanAttestation` makes), and `auto_approvable` from the
 * currently published Operation — the lookup `request_action` resolves it with
 * (`application/gateway/request-action-handler.ts`, `getPublishedOperation`), since the row
 * snapshots `blast_radius` but not `auto_approvable`. A human approver returns before the
 * Operation read.
 */
async function assertPersonDecidesWhenRequired(
  client: PoolClient,
  workspaceId: string,
  approverPrincipalId: string,
  existing: ActionRequestRow,
  event: 'approve' | 'reject',
): Promise<void> {
  const principal = await client.query<{ kind: PrincipalKind }>(
    'select kind from principals where workspace_id = $1 and id = $2',
    [workspaceId, approverPrincipalId],
  );
  if (principal.rows[0]?.kind === 'human') return;

  if (existing.blastRadius === 'high') {
    throw new HumanDecisionRequiredError(
      existing.id,
      approverPrincipalId,
      event,
      'has blast_radius "high"',
    );
  }
  const published = await getPublishedOperation(
    client,
    workspaceId,
    existing.gatekeeperId,
    existing.actionKind,
  );
  if (!published) {
    throw new HumanDecisionRequiredError(
      existing.id,
      approverPrincipalId,
      event,
      `targets Operation "${existing.actionKind}", which is not published (unclassified, I17)`,
    );
  }
  if (!published.operation.auto_approvable) {
    throw new HumanDecisionRequiredError(
      existing.id,
      approverPrincipalId,
      event,
      `targets Operation "${existing.actionKind}", which is not auto_approvable`,
    );
  }
}

/** Throws `ApprovalScopeError` (403) if the approver does not hold the required scope (or, as its
 *  `HumanDecisionRequiredError` subclass, is not a person and the row needs one — R-17),
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
  // R-17: before the reason gate, so a service Principal is not told to add a reason it still
  // could not use.
  await assertPersonDecidesWhenRequired(
    client,
    workspaceId,
    input.approverPrincipalId,
    existing,
    'approve',
  );

  // S6-A C25 (docs/console-completion-plan.md §12 item 6): high blast radius needs a stated
  // reason — checked after the scope/self-approval gates (a caller who may not approve at all
  // gets 403, not a hint about what a valid approval would need) and before the transition
  // lookup, so an already-decided row still answers 409 as before when a reason *is* given.
  const reason = normalizeReason(input.reason);
  if (existing.blastRadius === 'high' && reason === undefined) {
    throw new ApprovalReasonRequiredError(existing.id);
  }
  // Decision 2026-10-09 "二次确认": suspected credentials in the params this approval releases
  // need the approver's explicit confirmation — counted here, on the locked row, never taken from
  // the client. Same place in the order as the reason gate, for the same reasons.
  const suspectedSecretValues = countSuspectedSecrets(existing.params, { secretFields: true });
  assertCredentialsReviewed(
    'action_request',
    existing.id,
    suspectedSecretValues,
    input.credentialsReviewed,
  );

  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'approve');
  const approvalDecisionId = await writeApprovalDecision(client, workspaceId, {
    actionRequest: existing,
    decidedBy: input.approverPrincipalId,
    event: 'approve',
    reason,
    suspectedSecretValues,
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
    extraAuditPayload: {
      ...(reason ? { reason } : {}),
      ...credentialReviewAudit(suspectedSecretValues),
    },
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
  await assertPersonDecidesWhenRequired(
    client,
    workspaceId,
    input.approverPrincipalId,
    existing,
    'reject',
  );

  const reason = normalizeReason(input.reason);
  const nextStatus = transition(ACTION_REQUEST_TRANSITIONS, existing.status, 'reject');
  const approvalDecisionId = await writeApprovalDecision(client, workspaceId, {
    actionRequest: existing,
    decidedBy: input.approverPrincipalId,
    event: 'reject',
    reason,
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
    extraAuditPayload: reason ? { reason } : undefined,
  });

  return updated;
}
