import type { ActionRequestFailureKind, ActionRequestStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * governance/approval/step-actions (S11 GO1, plan §4.7 "推进器只按列分流"): what became of the
 * requests a StepRun raised (`action_requests.step_run_id`, migrations/governance/0022), as two
 * columns and nothing else. The goal advancer (`application/goal`) splits a step on these; the
 * reason text stays in the audit payload, for people.
 */

/** One request of a StepRun, as the advancer splits on it: its status and, when it failed, its
 *  `failure_kind` — never the reason text (that stays in the audit payload, for people). */
export interface StepActionOutcome {
  readonly id: string;
  readonly status: ActionRequestStatus;
  readonly failureKind: ActionRequestFailureKind | null;
}

/** Every request raised in `stepRunId` (`action_requests.step_run_id`, governance/0022), oldest
 *  first — or, with `raisedBy`, only those whose requesting WorkerRun (`parent_worker_run_id`) is
 *  one of those runs: S11 GO2 judges an attempt by the requests its own runs (nested children
 *  included) raised, not by an earlier attempt's. Reads this module's own table by its own
 *  columns; nothing here reads `step_runs` or `worker_runs`. */
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
  }>(
    `select id, status, failure_kind from action_requests
     where workspace_id = $1 and step_run_id = $2
       and ($3::uuid[] is null or parent_worker_run_id = any($3::uuid[]))
     order by requested_at, id`,
    [workspaceId, stepRunId, options.raisedBy === undefined ? null : [...options.raisedBy]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    failureKind: row.failure_kind,
  }));
}
