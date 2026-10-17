import {
  type ActionRequestReconciliation,
  DECISION_TRANSITIONS,
  type PrincipalKind,
  type Role,
  transition,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { redactedForAudit } from '../redaction/index.js';
import { getActionRequestForUpdateOrThrow } from './reads.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  ActionReconciliationForbiddenError,
  ActionReconciliationStateError,
  type ActionRequestDbRow,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/reconcile (S11 GO3c, plan §3.3 I-G4, §4.7 "结果未知"): a person records what
 * they found about a `failed` + `outcome_unknown` ActionRequest, and the requester may then decide
 * to run the same request again. Both are Decisions (`decisions`, insert-only for the application
 * role since core/0035), and the request points at them (migrations/governance/0023):
 *
 *   - a **finding** (`reconciliation`): `effect_seen` — its effect is there, the request counts as
 *     executed; `effect_absent` — no effect was found, the step needs a person. The requester's or
 *     a workspace owner's, as a person (`principals.kind = 'human'`, not disabled). Allowed whatever
 *     became of the goal: a request whose outcome is unknown under a cancelled goal is still
 *     checked and recorded.
 *   - a **re-execute** decision (`reexecute_decision_id`): the requester's alone, as a person, and
 *     only after (or together with) an `effect_absent` finding. It changes nothing about the
 *     request itself: the step's next request with the same identity becomes a new ActionRequest
 *     (`request-action.ts`), evaluated by the policy and approved like any other — a person's
 *     decision never stands in for the approval.
 *
 * Each is recorded once. A repeat of what is already recorded changes nothing (`changed: false`);
 * a different finding is refused (409): a finding that turns out wrong is answered by a later
 * decision about the step — re-execute after `effect_absent`, a retry, or a revision of the plan —
 * never by rewriting the row (the guard trigger refuses that too).
 *
 * Who decides is read here from `principals`, never taken from the caller, and the database guard
 * checks it again from the Decision row. The order: lock the request (`for update`), check its
 * state, check the decider, write the Decision(s), update the row, audit (`action_request.reconcile`
 * / `action_request.reexecute`) and publish `ActionRequestUpdated` — whose consumer sets the
 * request's goal run due (the goal service, `application/goal/reconcile.ts`, also does in the same
 * transaction).
 */

export interface ReconcileActionRequestInput {
  readonly actionRequestId: string;
  readonly deciderPrincipalId: string;
  /** What was found. Omitted when only a re-execute is recorded on an `effect_absent` finding. */
  readonly verdict?: ActionRequestReconciliation;
  /** Run the same request again (the requester's alone; needs `effect_absent`, given now or
   *  already recorded). */
  readonly reexecute?: boolean;
  /** What the person checked, kept in the Decision's rationale and (redacted) in the audit record.
   *  Trimmed; a blank one counts as absent. */
  readonly note?: string;
  /** Ids the caller adds to the Decision's rationale and the audit record (the goal service: the
   *  request's GoalRun), so its timeline finds them. Never free text. */
  readonly context?: { readonly goalRunId?: string };
}

export interface ReconcileActionRequestResult {
  readonly actionRequest: ActionRequestRow;
  /** `false` when everything asked for was already recorded. */
  readonly changed: boolean;
}

/** The longest note kept, in code points — the same bound as a goal revision's reason. */
export const RECONCILIATION_NOTE_MAX = 2000;

interface Decider {
  readonly kind: PrincipalKind;
  readonly role: Role;
  readonly enabled: boolean;
}

async function readDecider(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<Decider | null> {
  const result = await client.query<{ kind: PrincipalKind; role: Role; enabled: boolean }>(
    `select kind, role, disabled_at is null as enabled from principals
      where workspace_id = $1 and id = $2`,
    [workspaceId, principalId],
  );
  return result.rows[0] ?? null;
}

async function writeReconcileDecision(
  client: PoolClient,
  workspaceId: string,
  params: {
    readonly actionRequest: ActionRequestRow;
    readonly decidedBy: string;
    readonly rationale: Record<string, unknown>;
    readonly summary: string;
  },
): Promise<string> {
  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.reconcile_decision',
    principalId: params.decidedBy,
    metadata: {
      actionRequestId: params.actionRequest.id,
      decision: params.rationale.decision,
    },
  });
  await endActivity(client, workspaceId, activity.id, 'completed');
  const result = await client.query<{ id: string }>(
    `insert into decisions (workspace_id, status, activity_id, summary, rationale, decided_by, decided_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())
     returning id`,
    [
      workspaceId,
      transition(DECISION_TRANSITIONS, 'proposed', 'approve'),
      activity.id,
      params.summary,
      JSON.stringify(params.rationale),
      params.decidedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('writeReconcileDecision: INSERT ... RETURNING produced no row');
  return row.id;
}

function normalizeNote(note: string | undefined, actionRequestId: string): string | undefined {
  const trimmed = note?.trim();
  if (!trimmed) return undefined;
  if ([...trimmed].length > RECONCILIATION_NOTE_MAX) {
    throw new ActionReconciliationStateError(
      actionRequestId,
      'failed',
      'reconcile',
      `takes a note of at most ${RECONCILIATION_NOTE_MAX} characters`,
    );
  }
  return trimmed;
}

/** Records a finding and/or a re-execute decision on a `failed` + `outcome_unknown` request — see
 *  the module comment. Throws `ActionRequestNotFoundError` (404),
 *  `ActionReconciliationStateError` (409) or `ActionReconciliationForbiddenError` (403). */
export async function reconcileActionRequest(
  client: PoolClient,
  workspaceId: string,
  input: ReconcileActionRequestInput,
): Promise<ReconcileActionRequestResult> {
  const existing = await getActionRequestForUpdateOrThrow(
    client,
    workspaceId,
    input.actionRequestId,
  );
  const id = existing.id;
  const event = input.verdict !== undefined ? 'reconcile' : 'reexecute';
  if (input.verdict === undefined && !input.reexecute) {
    throw new ActionReconciliationStateError(id, existing.status, event, 'names no finding');
  }
  // A compensated row keeps its kind (governance/0021) but is a person's call already
  // (`disposition.ts`): nothing to reconcile.
  if (existing.status !== 'failed' || existing.failureKind !== 'outcome_unknown') {
    throw new ActionReconciliationStateError(
      id,
      existing.status,
      event,
      `is ${existing.status}${existing.failureKind ? ` (${existing.failureKind})` : ''}; only a request whose outcome is unknown is reconciled`,
    );
  }
  const note = normalizeNote(input.note, id);

  const recordFinding = input.verdict !== undefined && existing.reconciliation === null;
  if (
    input.verdict !== undefined &&
    existing.reconciliation !== null &&
    existing.reconciliation !== input.verdict
  ) {
    throw new ActionReconciliationStateError(
      id,
      existing.status,
      'reconcile',
      `was already found ${existing.reconciliation}; a finding is recorded once — answer it with a decision about the step (re-execute, retry or revise the plan)`,
    );
  }
  const finding = input.verdict ?? existing.reconciliation;
  const recordReexecute = input.reexecute === true && existing.reexecuteDecisionId === null;
  if (input.reexecute === true && finding !== 'effect_absent') {
    throw new ActionReconciliationStateError(
      id,
      existing.status,
      'reexecute',
      finding === null
        ? 'has no finding yet; run it again only once no effect was found (effect_absent)'
        : `was found ${finding}; it is run again only when no effect was found (effect_absent)`,
    );
  }
  if (!recordFinding && !recordReexecute) return { actionRequest: existing, changed: false };

  const decider = await readDecider(client, workspaceId, input.deciderPrincipalId);
  const person = decider?.kind === 'human' && decider.enabled;
  const requester = input.deciderPrincipalId === existing.onBehalfOf;
  if (recordFinding && !(person && (requester || decider?.role === 'owner'))) {
    throw new ActionReconciliationForbiddenError(
      id,
      'only the requester or a workspace owner, as a person, records what was found',
    );
  }
  if (recordReexecute && !(person && requester)) {
    throw new ActionReconciliationForbiddenError(
      id,
      'only the requester, as a person, decides to run a request again',
    );
  }

  const audited = note ? redactedForAudit({ note }) : {};
  const context = {
    stepRunId: existing.stepRunId,
    actionKindTag: existing.actionKind,
    ...(input.context?.goalRunId ? { goalRunId: input.context.goalRunId } : {}),
  };
  let findingDecisionId: string | null = existing.reconciliationDecisionId;
  if (recordFinding) {
    findingDecisionId = await writeReconcileDecision(client, workspaceId, {
      actionRequest: existing,
      decidedBy: input.deciderPrincipalId,
      summary: `reconcile action_request ${id}: ${finding}`,
      rationale: {
        actionRequestId: id,
        decision: 'reconcile',
        verdict: finding,
        basis: 'person',
        note: note ?? null,
        ...context,
      },
    });
  }
  let reexecuteDecisionId: string | null = existing.reexecuteDecisionId;
  if (recordReexecute) {
    reexecuteDecisionId = await writeReconcileDecision(client, workspaceId, {
      actionRequest: existing,
      decidedBy: input.deciderPrincipalId,
      summary: `re-execute action_request ${id}`,
      rationale: { actionRequestId: id, decision: 'reexecute', note: note ?? null, ...context },
    });
  }

  const updated = await client.query<ActionRequestDbRow>(
    `update action_requests
        set reconciliation = $3, reconciliation_decision_id = $4, reexecute_decision_id = $5
      where workspace_id = $1 and id = $2
      returning ${ACTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, id, finding, findingDecisionId, reexecuteDecisionId],
  );
  const row = updated.rows[0];
  if (!row) throw new Error('reconcileActionRequest: UPDATE ... RETURNING produced no row');

  if (recordFinding) {
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.deciderPrincipalId,
      action: 'action_request.reconcile',
      resourceType: 'action_request',
      resourceId: id,
      payload: {
        verdict: finding,
        basis: 'person',
        decisionId: findingDecisionId,
        ...context,
        ...audited,
      },
    });
  }
  if (recordReexecute) {
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.deciderPrincipalId,
      action: 'action_request.reexecute',
      resourceType: 'action_request',
      resourceId: id,
      payload: {
        decisionId: reexecuteDecisionId,
        ...context,
        ...(recordFinding ? {} : audited),
      },
    });
  }
  await enqueue(client, {
    type: 'ActionRequestUpdated',
    workspaceId,
    actionRequestId: id,
    status: existing.status,
  });
  return { actionRequest: mapActionRequestRow(row), changed: true };
}
