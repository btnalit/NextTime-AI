import type {
  ActionRequestFailureKind,
  ActionRequestReconciliation,
  ActionRequestStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  WITHDRAWABLE_ACTION_REQUEST_STATUSES,
  type WithdrawOptions,
  withdrawActionRequest,
} from './execution.js';

/**
 * governance/approval/step-actions (S11 GO1, plan §4.7 "推进器只按列分流"): what became of the
 * requests a StepRun raised (`action_requests.step_run_id`, migrations/governance/0022), as two
 * columns and nothing else. The goal advancer (`application/goal`) splits a step on these; the
 * reason text stays in the audit payload, for people. S11 GO3a adds the two writes and reads a
 * stopped step needs: withdrawing its requests that have not run, and listing those still
 * executing. S11 GO3b: a revision that removes a step lets a person release some of its requests
 * (`keep`), read first under their row locks ({@link lockWithdrawableStepActions}).
 */

/** One request of a StepRun, as the advancer splits on it: its status and, when it failed, its
 *  `failure_kind` — never the reason text (that stays in the audit payload, for people). S11 GO3c:
 *  and, on one whose outcome was unknown, what was found (`reconciliation`) and whether its
 *  requester decided to run it again (`reexecuted`, governance/0023). */
export interface StepActionOutcome {
  readonly id: string;
  readonly status: ActionRequestStatus;
  readonly failureKind: ActionRequestFailureKind | null;
  readonly reconciliation: ActionRequestReconciliation | null;
  readonly reexecuted: boolean;
}

/** Every request raised in `stepRunId` (`action_requests.step_run_id`, governance/0022), oldest
 *  first — or, with `raisedBy`, only those whose requesting WorkerRun (`parent_worker_run_id`) is
 *  one of those runs: S11 GO2 judges an attempt by the requests its own runs (nested children
 *  included) raised, not by an earlier attempt's. Reads this module's own table by its own
 *  columns; nothing here reads `step_runs` or `worker_runs`.
 *
 *  S11 GO3c: a request its requester decided to run again stands for that new run only until the
 *  run exists — once the step has a newer request of the same identity (`idempotency_key`, I-G4),
 *  the newer one decides and the re-executed one is left out (otherwise its `retry` would fail the
 *  step `transient` beside the new request's own outcome). */
export async function listStepActionOutcomes(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
  options: { readonly raisedBy?: readonly string[] } = {},
): Promise<readonly StepActionOutcome[]> {
  const result = await client.query<{
    id: string;
    status: ActionRequestStatus;
    failure_kind: ActionRequestFailureKind | null;
    reconciliation: ActionRequestReconciliation | null;
    reexecuted: boolean;
  }>(
    `select a.id, a.status, a.failure_kind, a.reconciliation,
            a.reexecute_decision_id is not null as reexecuted
       from action_requests a
     where a.workspace_id = $1 and a.step_run_id = $2
       and ($3::uuid[] is null or a.parent_worker_run_id = any($3::uuid[]))
       and not (
         a.reexecute_decision_id is not null
         and exists (
           select 1 from action_requests n
            where n.workspace_id = a.workspace_id and n.step_run_id = a.step_run_id
              and n.idempotency_key = a.idempotency_key
              and (n.requested_at, n.id) > (a.requested_at, a.id)
         )
       )
     order by a.requested_at, a.id`,
    [workspaceId, stepRunId, options.raisedBy === undefined ? null : [...options.raisedBy]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    failureKind: row.failure_kind,
    reconciliation: row.reconciliation,
    reexecuted: row.reexecuted,
  }));
}

/** S11 GO3c: a request of a step whose outcome is unknown and that still needs a person — a finding
 *  (`reconciliation` is `null`), or, after `effect_absent`, a decision (re-execute, or change the
 *  plan). */
export interface UnresolvedStepAction {
  readonly id: string;
  readonly stepRunId: string;
  readonly gatekeeperId: string;
  readonly actionKindTag: string;
  readonly onBehalfOf: string;
  readonly failedAt: Date | null;
  readonly reconciliation: ActionRequestReconciliation | null;
}

/** S11 GO3c: the requests of `stepRunIds` that are `failed` + `outcome_unknown` and either not
 *  reconciled or found `effect_absent` with no re-execute decision, oldest first. */
export async function listUnresolvedStepActions(
  client: PoolClient,
  workspaceId: string,
  stepRunIds: readonly string[],
): Promise<readonly UnresolvedStepAction[]> {
  if (stepRunIds.length === 0) return [];
  const result = await client.query<{
    id: string;
    step_run_id: string;
    gatekeeper_id: string;
    action_kind: string;
    on_behalf_of: string;
    failed_at: Date | null;
    reconciliation: ActionRequestReconciliation | null;
  }>(
    `select id, step_run_id, gatekeeper_id, action_kind, on_behalf_of, failed_at, reconciliation
       from action_requests
      where workspace_id = $1 and step_run_id = any($2::uuid[])
        and status = 'failed' and failure_kind = 'outcome_unknown'
        and (reconciliation is null
             or (reconciliation = 'effect_absent' and reexecute_decision_id is null))
      order by requested_at, id`,
    [workspaceId, [...stepRunIds]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    stepRunId: row.step_run_id,
    gatekeeperId: row.gatekeeper_id,
    actionKindTag: row.action_kind,
    onBehalfOf: row.on_behalf_of,
    failedAt: row.failed_at,
    reconciliation: row.reconciliation,
  }));
}

/** A request of a step that has not started — what closing the step withdraws, or a person
 *  releases (S11 GO3b). */
export interface WithdrawableStepAction {
  readonly id: string;
  readonly stepRunId: string;
  readonly status: ActionRequestStatus;
}

/** The requests of `stepRunIds` that have not started — status in
 *  {@link WITHDRAWABLE_ACTION_REQUEST_STATUSES} — locked `for update` in `requested_at` order (the
 *  drainer's), oldest first. A row the drainer started before the lock is not among them. */
export async function lockWithdrawableStepActions(
  client: PoolClient,
  workspaceId: string,
  stepRunIds: readonly string[],
): Promise<readonly WithdrawableStepAction[]> {
  if (stepRunIds.length === 0) return [];
  const result = await client.query<{
    id: string;
    step_run_id: string;
    status: ActionRequestStatus;
  }>(
    `select id, step_run_id, status from action_requests
     where workspace_id = $1 and step_run_id = any($2::uuid[]) and status = any($3::text[])
     order by requested_at, id
     for update`,
    [workspaceId, [...stepRunIds], [...WITHDRAWABLE_ACTION_REQUEST_STATUSES]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    stepRunId: row.step_run_id,
    status: row.status,
  }));
}

/**
 * S11 GO3a (plan I-G9, §4.8): withdraws every request of `stepRunIds` that has not started — status
 * in {@link WITHDRAWABLE_ACTION_REQUEST_STATUSES} — and returns their ids, oldest first. Called in
 * the transaction that closes the steps (a cancelled GoalRun, S11 GO3b a revision that removes
 * them), so nothing of a closed step runs later: the execution side reads only the row
 * (`startActionRequestExecution` locks it and finds it `withdrawn`). `keep` names requests a person
 * released when a revision let their step finish: they keep their status.
 *
 * The rows are selected `for update` with the status filter — read under their lock first, as
 * `withdrawActionRequest` requires (review of #601) — so a row the drainer started in the meantime
 * is not selected, and is never withdrawn: it ends the R-48 way. Locked in `requested_at` order,
 * the drainer's own order. Each withdrawal writes its audit row and `ActionRequestUpdated`, which
 * re-drains that Gatekeeper at once (`application/gateway`'s drain consumer).
 */
export async function withdrawStepActions(
  client: PoolClient,
  workspaceId: string,
  stepRunIds: readonly string[],
  options: WithdrawOptions & { readonly keep?: readonly string[] } = {},
): Promise<readonly string[]> {
  const { keep = [], ...withdrawOptions } = options;
  const kept = new Set(keep);
  const withdrawn: string[] = [];
  for (const row of await lockWithdrawableStepActions(client, workspaceId, stepRunIds)) {
    if (kept.has(row.id)) continue;
    await withdrawActionRequest(client, workspaceId, row.id, withdrawOptions);
    withdrawn.push(row.id);
  }
  return withdrawn;
}

/** A request of a stopped step that started executing before the stop: it cannot be withdrawn and
 *  ends the R-48 way. What a cancelling GoalRun waits for, and lists if its deadline passes. */
export interface ExecutingStepAction {
  readonly id: string;
  readonly stepRunId: string;
  readonly gatekeeperId: string;
  readonly actionKind: string;
}

/** The requests of `stepRunIds` still `executing`, oldest first. */
export async function listExecutingStepActions(
  client: PoolClient,
  workspaceId: string,
  stepRunIds: readonly string[],
): Promise<readonly ExecutingStepAction[]> {
  if (stepRunIds.length === 0) return [];
  const result = await client.query<{
    id: string;
    step_run_id: string;
    gatekeeper_id: string;
    action_kind: string;
  }>(
    `select id, step_run_id, gatekeeper_id, action_kind from action_requests
     where workspace_id = $1 and step_run_id = any($2::uuid[]) and status = 'executing'
     order by requested_at, id`,
    [workspaceId, [...stepRunIds]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    stepRunId: row.step_run_id,
    gatekeeperId: row.gatekeeper_id,
    actionKind: row.action_kind,
  }));
}
