import {
  EVAL_TRIAL_ERROR_VALUES,
  type EvalAssertion,
  type EvalAssertionResultWire,
  type EvalCallRecord,
  type EvalTrialError,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { evaluatePredicate } from '../../substrate/epistemic/index.js';

/**
 * application/eval/runner: scores evaluation trials (S10 E3-2a; docs/s10-evolution-plan-2026-10-04.md
 * §5.5 账本恒等式). A trial's Task ends on its own — its Worker reports (`completed`), or it fails or
 * is cancelled — and this tick, run every few seconds by the kernel (`src/index.ts`), records how
 * the trial came out:
 *
 *   - `completed`: `scored`. Each of the case's assertions is judged on `{result, calls}` — the
 *     report as kept on the Task, and every fixture call the trial's Worker made, in order
 *     (`EvalCallRecord`, shared eval-case.ts); `passed` when every one is satisfied (an
 *     `undetermined` one does not pass). The case row is the one the trial ran: an edit since
 *     made a new row, and this one is kept as it was.
 *   - `failed`: `errored` with the Task's failure reason — or `withheld`, when the Worker was not
 *     started because what it would start with carried evaluation content (the seal's own audit row
 *     on the Task, `evaluation.content_withheld`); a reason outside the known set reads
 *     `worker_failed`.
 *   - `cancelled`: `errored`, `cancelled`.
 *
 * With either, what the trial's model calls cost — the `llm_usage` rows of its Task's runs: `null`
 * when one of them has no price — and their tokens. A call recorded after this (the proxy reports
 * usage as a call ends) is not in the trial's figures; the evaluation budget reads `llm_usage`
 * itself, so it is in the month's. A run is `finished` once its last trial ended (the database
 * holds the count, worker/0009). Each trial end is audited (`evaluation.trial_end`, on the run),
 * without the case's content or the report.
 *
 * Cross-workspace scan, then one transaction per trial in its workspace, acting as the evaluation
 * Principal the Task ran for; the trial row is held (`for update`) and re-read, so two kernels
 * score a trial once.
 */

/** The audit action of a trial's end. */
export const EVALUATION_TRIAL_END_ACTION = 'evaluation.trial_end';

/** How many ended trials one tick scores at most. */
const DEFAULT_TRIAL_BATCH = 50;

interface EndedTrial {
  readonly workspaceId: string;
  readonly trialId: string;
  readonly principalId: string;
}

/** Running trials whose Task has ended, oldest first. */
async function listEndedTrials(pool: PoolLike, limit: number): Promise<readonly EndedTrial[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      workspace_id: string;
      id: string;
      on_behalf_of: string;
    }>(
      `select tr.workspace_id, tr.id, t.on_behalf_of
         from eval_trials tr
         join tasks t on t.workspace_id = tr.workspace_id and t.id = tr.task_id
        where tr.status = 'running' and t.status in ('completed', 'failed', 'cancelled')
        order by tr.started_at, tr.id
        limit $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      workspaceId: row.workspace_id,
      trialId: row.id,
      principalId: row.on_behalf_of,
    }));
  } finally {
    client.release();
  }
}

export interface EvalTrialTickOptions {
  readonly limit?: number;
  /** One trial's failure — the others in the batch are still scored. */
  readonly onError?: (error: unknown, trial: EndedTrial) => void;
}

/** Scores every trial whose Task has ended. Returns how many it looked at. */
export async function runEvalTrialTick(
  pool: PoolLike,
  options: EvalTrialTickOptions = {},
): Promise<number> {
  const ended = await listEndedTrials(pool, options.limit ?? DEFAULT_TRIAL_BATCH);
  for (const trial of ended) {
    try {
      await withWorkspace(
        pool,
        { workspaceId: trial.workspaceId, principalId: trial.principalId },
        (client) => endTrial(client, trial.workspaceId, trial.trialId, trial.principalId),
      );
    } catch (err) {
      options.onError?.(err, trial);
    }
  }
  return ended.length;
}

type TrialEnd =
  | {
      readonly status: 'scored';
      readonly verdict: 'passed' | 'failed';
      readonly assertions: readonly EvalAssertionResultWire[];
    }
  | { readonly status: 'errored'; readonly error: EvalTrialError };

/** Ends one trial, when its Task has ended and nothing ended it meanwhile. */
export async function endTrial(
  client: PoolClient,
  workspaceId: string,
  trialId: string,
  actorPrincipalId: string,
): Promise<'ended' | 'skipped'> {
  const trials = await client.query<{
    run_id: string;
    case_id: string;
    task_id: string;
    status: string;
  }>(
    `select run_id, case_id, task_id, status from eval_trials
      where workspace_id = $1 and id = $2 for update`,
    [workspaceId, trialId],
  );
  const trial = trials.rows[0];
  if (!trial || trial.status !== 'running') return 'skipped';
  const tasks = await client.query<{
    status: string;
    result: unknown;
    failure_reason: string | null;
  }>('select status, result, failure_reason from tasks where workspace_id = $1 and id = $2', [
    workspaceId,
    trial.task_id,
  ]);
  const task = tasks.rows[0];
  if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) return 'skipped';

  let end: TrialEnd;
  if (task.status === 'completed') {
    end = await score(client, workspaceId, trialId, trial.case_id, task.result);
  } else if (task.status === 'cancelled') {
    end = { status: 'errored', error: 'cancelled' };
  } else {
    end = { status: 'errored', error: await failureOf(client, workspaceId, trial.task_id, task) };
  }

  const usage = await client.query<{ cost: number | null; unpriced: string; tokens: string }>(
    `select sum(u.cost_usd)::float8 as cost,
            count(*) filter (where u.cost_usd is null)::bigint as unpriced,
            coalesce(sum(u.input_tokens + u.output_tokens + coalesce(u.cache_read_tokens, 0)
                         + coalesce(u.cache_write_tokens, 0)), 0)::bigint as tokens
       from llm_usage u
       join worker_runs w on w.workspace_id = u.workspace_id and w.session_id = u.session_id
      where w.workspace_id = $1 and w.task_id = $2`,
    [workspaceId, trial.task_id],
  );
  const measured = usage.rows[0];
  const costUsd = measured && Number(measured.unpriced) > 0 ? null : (measured?.cost ?? 0);
  const tokens = Number(measured?.tokens ?? 0);

  await client.query(
    `update eval_trials
        set status = $3, verdict = $4, error = $5, assertion_results = $6::jsonb,
            result = $7::jsonb, cost_usd = $8, tokens = $9, finished_at = now()
      where workspace_id = $1 and id = $2`,
    [
      workspaceId,
      trialId,
      end.status,
      end.status === 'scored' ? end.verdict : null,
      end.status === 'errored' ? end.error : null,
      JSON.stringify(end.status === 'scored' ? end.assertions : []),
      task.result === null || task.result === undefined ? null : JSON.stringify(task.result),
      costUsd,
      tokens,
    ],
  );

  const runs = await client.query<{
    suite_id: string;
    expected: number;
    held: number;
    open: number;
  }>(
    `select r.suite_id,
            (cardinality(r.arms) * cardinality(r.case_ids) * r.k)::int as expected,
            count(tr.id)::int as held,
            count(tr.id) filter (where tr.status = 'running')::int as open
       from eval_runs r
       join eval_trials tr on tr.workspace_id = r.workspace_id and tr.run_id = r.id
      where r.workspace_id = $1 and r.id = $2
      group by r.workspace_id, r.id`,
    [workspaceId, trial.run_id],
  );
  const run = runs.rows[0];
  const runFinished = run !== undefined && run.open === 0 && run.held === run.expected;
  if (runFinished) {
    await client.query(
      `update eval_runs set status = 'finished', finished_at = now()
        where workspace_id = $1 and id = $2 and status = 'running'`,
      [workspaceId, trial.run_id],
    );
  }

  await writeAudit(client, {
    workspaceId,
    actorPrincipalId,
    action: EVALUATION_TRIAL_END_ACTION,
    resourceType: 'eval_run',
    resourceId: trial.run_id,
    payload: {
      suiteId: run?.suite_id ?? null,
      trialId,
      taskId: trial.task_id,
      status: end.status,
      ...(end.status === 'scored' ? { verdict: end.verdict } : { error: end.error }),
      costUsd,
      tokens,
      runFinished,
    },
  });
  return 'ended';
}

/** Judges the case's assertions on what the trial's Worker reported and the calls it made. */
async function score(
  client: PoolClient,
  workspaceId: string,
  trialId: string,
  caseId: string,
  result: unknown,
): Promise<TrialEnd> {
  const cases = await client.query<{ assertions: EvalAssertion[] }>(
    'select assertions from eval_cases where workspace_id = $1 and id = $2',
    [workspaceId, caseId],
  );
  const assertions = cases.rows[0]?.assertions ?? [];
  const calls = await client.query<{
    gatekeeper_id: string;
    gate_name: string;
    operation: string;
    mode: EvalCallRecord['mode'];
    params: Record<string, unknown>;
    answer: EvalCallRecord['answer'];
  }>(
    `select gatekeeper_id, gate_name, operation, mode, params, answer
       from eval_trial_calls where workspace_id = $1 and trial_id = $2 order by seq`,
    [workspaceId, trialId],
  );
  const document = {
    result: result ?? null,
    calls: calls.rows.map(
      (call): EvalCallRecord => ({
        gatekeeperId: call.gatekeeper_id,
        gate: call.gate_name,
        operation: call.operation,
        mode: call.mode,
        params: call.params,
        answer: call.answer,
      }),
    ),
  };
  const outcomes = assertions.map(
    (assertion, index): EvalAssertionResultWire => ({
      index,
      outcome: evaluatePredicate(assertion.expect, document).outcome,
      note: assertion.note ?? null,
    }),
  );
  // A case holds one assertion at least (worker/0008); none read here passes nothing.
  const passed = outcomes.length > 0 && outcomes.every((item) => item.outcome === 'satisfied');
  return { status: 'scored', verdict: passed ? 'passed' : 'failed', assertions: outcomes };
}

const KNOWN_ERRORS: ReadonlySet<string> = new Set(EVAL_TRIAL_ERROR_VALUES);

/** How a failed Task's trial reads: `withheld` when the seal stopped its Worker's start. */
async function failureOf(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
  task: { readonly failure_reason: string | null },
): Promise<EvalTrialError> {
  const withheld = await client.query(
    `select 1 from audit_records
      where workspace_id = $1 and action = 'evaluation.content_withheld'
        and resource_type = 'task' and resource_id = $2
      limit 1`,
    [workspaceId, taskId],
  );
  if ((withheld.rowCount ?? 0) > 0) return 'withheld';
  const reason = task.failure_reason;
  return reason !== null &&
    KNOWN_ERRORS.has(reason) &&
    reason !== 'cancelled' &&
    reason !== 'withheld'
    ? (reason as EvalTrialError)
    : 'worker_failed';
}
