import type {
  EvalAssertionResultWire,
  EvalRunSummaryWire,
  EvalRunWire,
  EvalTrialCallWire,
  EvalTrialWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import { ReviewedVersionChangedError, seesEveryDraft } from '../../governance/capability/index.js';
import { shownFreeText } from '../../governance/redaction/index.js';
import {
  type PreparedStepAttempt,
  createEvaluationTask,
  getConfiguredTaskRuntime,
  startStepAttemptTask,
} from '../task/index.js';
import { readEvalBudget } from './budget.js';
import {
  DRAFT_EVALUATION_VISIBLE_TO,
  type DraftEvaluationActor,
  draftEvaluationVisibleTo,
} from './draft-evaluations.js';
import {
  EvalCaseNotFoundError,
  EvalRunNotFoundError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
  EvaluationBudgetExhaustedError,
} from './errors.js';
import { getOrCreateEvaluationPrincipal } from './principal.js';
import type { EvalSuiteActor } from './suites.js';

/**
 * application/eval/runs: evaluation runs (S10 E3-2a; docs/s10-evolution-plan-2026-10-04.md §3.1
 * EvalRun, §5.5 账本恒等式) — started here: `case_trial`, one case of a suite tried once, as it
 * would run now, from the case's page; read here: those and a draft evaluation's stages (E3-2b,
 * `draft-evaluations.ts` starts them). Tables: `eval_runs`, `eval_trials`, `eval_trial_calls`
 * (migrations/worker/0009, whose guards hold the ledger: a run finishes with exactly arms × cases
 * × k trials, none still running; a trial ends once; a call is kept as made).
 *
 * Starting one (`startCaseTrial`) writes, in the caller's one transaction, the run, its trial and
 * the evaluation Task the trial runs (`application/task`'s `createEvaluationTask`); the Worker is
 * spawned after that commit (the caller's `afterCommit`). Scoring is the runner's
 * (`runner.ts`), once the Task ends.
 */

/** A `case_trial` run of `suiteId`'s case `caseId`, at the suite version the person looked at. */
export interface CaseTrialTarget {
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly caseId: string;
}

export interface StartedCaseTrial {
  readonly run: EvalRunWire;
  /** The evaluation Task, to start once the transaction commits. */
  readonly task: PreparedStepAttempt;
}

/**
 * Starts a `case_trial` run. Refused, with nothing written: a suite or case that is not there
 * (404); a suite at another version than the person looked at (409 version_changed); a case row
 * the suite does not hold now — retired, or replaced by an edit (409 conflict); a pinned
 * WorkerDefinition version no longer published (409 conflict); this month's evaluation budget
 * spent (429 evaluation_budget_exhausted); the evaluation Principal at its concurrency limit
 * (429, I18). The suite is held (`for share`) until the transaction ends, so no change to it lands
 * between the checks and the writes.
 */
export async function startCaseTrial(
  client: PoolClient,
  workspaceId: string,
  actor: EvalSuiteActor,
  target: CaseTrialTarget,
): Promise<StartedCaseTrial> {
  // 503 before anything is written, as `invoke_worker` does, when this kernel cannot start Tasks.
  getConfiguredTaskRuntime();
  const suites = await client.query<{
    name: string;
    version: number;
    worker_definition_id: string;
    worker_definition_version: number;
  }>(
    `select name, version, worker_definition_id, worker_definition_version
       from eval_suites where workspace_id = $1 and id = $2 for share`,
    [workspaceId, target.suiteId],
  );
  const suite = suites.rows[0];
  if (!suite) throw new EvalSuiteNotFoundError(target.suiteId);
  if (suite.version !== target.suiteVersion) {
    throw new ReviewedVersionChangedError(
      'start_eval_case_trial',
      `evaluation suite "${shownFreeText(suite.name)}"`,
      target.suiteVersion,
      suite.version,
    );
  }
  const cases = await client.query<{ input: unknown; retired_in_version: number | null }>(
    'select input, retired_in_version from eval_cases where workspace_id = $1 and suite_id = $2 and id = $3',
    [workspaceId, target.suiteId, target.caseId],
  );
  const caseRow = cases.rows[0];
  if (!caseRow) throw new EvalCaseNotFoundError(target.caseId);
  if (caseRow.retired_in_version !== null) {
    throw new EvalSuiteStateError(
      `case ${target.caseId} is no longer in the suite (retired, or replaced by an edit) — try the case as the suite holds it now; nothing was started`,
    );
  }

  const budget = await readEvalBudget(client, workspaceId);
  if (budget.spentUsd >= budget.monthlyBudgetUsd) {
    throw new EvaluationBudgetExhaustedError(budget.monthlyBudgetUsd, budget.spentUsd);
  }

  const gates = await client.query<{ gatekeeper_id: string }>(
    `select gatekeeper_id from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and retired_in_version is null`,
    [workspaceId, target.suiteId],
  );
  const evaluationPrincipalId = await getOrCreateEvaluationPrincipal(client, workspaceId);
  const created = await createEvaluationTask(client, workspaceId, {
    evaluationPrincipalId,
    definition: { id: suite.worker_definition_id, version: suite.worker_definition_version },
    input: caseRow.input,
    fixtureGateIds: gates.rows.map((row) => row.gatekeeper_id),
  });
  if (created.kind === 'definition_unavailable') {
    throw new EvalSuiteStateError(
      `the suite's WorkerDefinition version ${suite.worker_definition_version} is no longer published — pin a published version first; nothing was started`,
    );
  }

  const runs = await client.query<{ id: string }>(
    `insert into eval_runs (
       workspace_id, suite_id, suite_version, kind, worker_definition_id,
       worker_definition_version, arms, case_ids, k, created_by
     ) values ($1, $2, $3, 'case_trial', $4, $5, array['baseline'], array[$6::uuid], 1, $7)
     returning id`,
    [
      workspaceId,
      target.suiteId,
      suite.version,
      suite.worker_definition_id,
      suite.worker_definition_version,
      target.caseId,
      actor.principalId,
    ],
  );
  const runId = runs.rows[0]?.id;
  if (!runId) throw new Error('startCaseTrial: eval_runs INSERT ... RETURNING produced no row');
  await client.query(
    `insert into eval_trials (workspace_id, run_id, arm, case_id, rep, task_id)
     values ($1, $2, 'baseline', $3, 1, $4)`,
    [workspaceId, runId, target.caseId, created.prepared.task.id],
  );
  return { run: await getEvalRun(client, workspaceId, runId), task: created.prepared };
}

/**
 * After the transaction that started the run commits: starts its trial's Task — the spawn, then
 * `running`; a start that fails fails the Task `spawn_failed` (or the seal stopped it), and the
 * runner records the trial `errored` — and returns the run as it is then.
 */
export async function startCaseTrialTask(
  pool: PoolLike,
  workspaceId: string,
  actor: EvalSuiteActor,
  started: StartedCaseTrial,
): Promise<EvalRunWire> {
  await startStepAttemptTask(getConfiguredTaskRuntime(), workspaceId, started.task);
  return withWorkspace(pool, { workspaceId, principalId: actor.principalId }, (client) =>
    getEvalRun(client, workspaceId, started.run.id),
  );
}

// ----- reads ---------------------------------------------------------------------------------

interface RunRow {
  id: string;
  suite_id: string;
  suite_version: number;
  kind: EvalRunWire['kind'];
  worker_definition_id: string;
  worker_definition_version: number;
  case_ids: string[];
  k: number;
  status: 'running' | 'finished';
  draft_evaluation_id: string | null;
  stage: EvalRunWire['stage'];
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
}

const RUN_COLUMNS = `id, suite_id, suite_version, kind, worker_definition_id, worker_definition_version,
  case_ids, k, status, draft_evaluation_id, stage, created_by, created_at, finished_at`;

function runBase(row: RunRow) {
  return {
    id: row.id,
    suiteId: row.suite_id,
    suiteVersion: row.suite_version,
    kind: row.kind,
    workerDefinition: { id: row.worker_definition_id, version: row.worker_definition_version },
    k: row.k,
    status: row.status,
    draftEvaluationId: row.draft_evaluation_id,
    stage: row.stage,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

interface TrialRow {
  id: string;
  arm: EvalTrialWire['arm'];
  case_id: string;
  case_title: string;
  rep: number;
  task_id: string | null;
  status: EvalTrialWire['status'];
  verdict: EvalTrialWire['verdict'];
  error: EvalTrialWire['error'];
  assertion_results: EvalAssertionResultWire[];
  result: unknown;
  cost_usd: number | null;
  tokens: string;
  environment_digest: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

interface CallRow {
  trial_id: string;
  seq: number;
  gatekeeper_id: string;
  gate_name: string;
  operation: string;
  mode: EvalTrialCallWire['mode'];
  params: Record<string, unknown>;
  rule_index: number | null;
  answer: EvalTrialCallWire['answer'];
  created_at: Date;
}

/** A run whole — every trial, its assertions and its calls. 404 when there is none — or, for a
 *  draft evaluation's stage, when `viewer` may not see the evaluation (E3-2b). */
export async function getEvalRun(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  viewer?: DraftEvaluationActor,
): Promise<EvalRunWire> {
  const runs = await client.query<RunRow>(
    `select ${RUN_COLUMNS} from eval_runs where workspace_id = $1 and id = $2`,
    [workspaceId, runId],
  );
  const run = runs.rows[0];
  if (!run) throw new EvalRunNotFoundError(runId);
  if (
    viewer !== undefined &&
    run.draft_evaluation_id !== null &&
    !(await draftEvaluationVisibleTo(client, workspaceId, viewer, run.draft_evaluation_id))
  ) {
    throw new EvalRunNotFoundError(runId);
  }
  const trials = await client.query<TrialRow>(
    `select tr.id, tr.arm, tr.case_id, c.title as case_title, tr.rep, tr.task_id, tr.status,
            tr.verdict, tr.error, tr.assertion_results, tr.result, tr.cost_usd::float8 as cost_usd,
            tr.tokens, tr.started_at, tr.finished_at,
            (select w.environment_digest from worker_runs w
              where w.workspace_id = tr.workspace_id and w.task_id = tr.task_id
              order by w.started_at desc limit 1) as environment_digest
       from eval_trials tr
       join eval_cases c on c.workspace_id = tr.workspace_id and c.id = tr.case_id
      where tr.workspace_id = $1 and tr.run_id = $2
      order by array_position($3::uuid[], tr.case_id), tr.rep, tr.arm`,
    [workspaceId, runId, run.case_ids],
  );
  const calls = await client.query<CallRow>(
    `select trial_id, seq, gatekeeper_id, gate_name, operation, mode, params, rule_index, answer,
            created_at
       from eval_trial_calls
      where workspace_id = $1 and trial_id = any($2::uuid[])
      order by trial_id, seq`,
    [workspaceId, trials.rows.map((trial) => trial.id)],
  );
  const callsByTrial = new Map<string, EvalTrialCallWire[]>();
  for (const call of calls.rows) {
    const list = callsByTrial.get(call.trial_id) ?? [];
    list.push({
      seq: call.seq,
      gatekeeperId: call.gatekeeper_id,
      gate: call.gate_name,
      operation: call.operation,
      mode: call.mode,
      params: call.params,
      ruleIndex: call.rule_index,
      answer: call.answer,
      at: call.created_at.toISOString(),
    });
    callsByTrial.set(call.trial_id, list);
  }
  return {
    ...runBase(run),
    trials: trials.rows.map((trial) => ({
      id: trial.id,
      arm: trial.arm,
      caseId: trial.case_id,
      caseTitle: shownFreeText(trial.case_title),
      rep: trial.rep,
      status: trial.status,
      verdict: trial.verdict,
      error: trial.error,
      taskId: trial.task_id,
      assertions: trial.assertion_results,
      result: trial.result ?? null,
      calls: callsByTrial.get(trial.id) ?? [],
      costUsd: trial.cost_usd,
      tokens: Number(trial.tokens),
      environmentDigest: trial.environment_digest,
      startedAt: trial.started_at ? trial.started_at.toISOString() : null,
      finishedAt: trial.finished_at ? trial.finished_at.toISOString() : null,
    })),
  };
}

/** How many runs `listEvalRuns` returns. */
const LIST_EVAL_RUNS_LIMIT = 20;

/** A suite's runs, newest first, in brief; with `caseId`, those that tried that case row; with
 *  `kind`, those of that kind. A draft evaluation's stages only where `viewer` may see the
 *  evaluation (E3-2b). 404 for a suite that is not there. */
export async function listEvalRuns(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  filter: {
    readonly suiteId: string;
    readonly caseId?: string;
    readonly kind?: EvalRunWire['kind'];
  },
): Promise<readonly EvalRunSummaryWire[]> {
  const suite = await client.query(
    'select 1 from eval_suites where workspace_id = $1 and id = $2',
    [workspaceId, filter.suiteId],
  );
  if (suite.rowCount === 0) throw new EvalSuiteNotFoundError(filter.suiteId);
  const runs = await client.query<
    RunRow & {
      passed: string;
      failed: string;
      errored: string;
      running: string;
      queued: string;
      cost_usd: number | null;
      unpriced: string;
    }
  >(
    `select ${RUN_COLUMNS.split(',')
      .map((column) => `r.${column.trim()}`)
      .join(', ')},
            count(tr.id) filter (where tr.verdict = 'passed')::bigint as passed,
            count(tr.id) filter (where tr.verdict = 'failed')::bigint as failed,
            count(tr.id) filter (where tr.status = 'errored')::bigint as errored,
            count(tr.id) filter (where tr.status = 'running')::bigint as running,
            count(tr.id) filter (where tr.status = 'queued')::bigint as queued,
            sum(tr.cost_usd)::float8 as cost_usd,
            count(tr.id) filter (
              where tr.status in ('scored', 'errored') and tr.task_id is not null
                and tr.cost_usd is null
            )::bigint as unpriced
       from eval_runs r
       left join eval_trials tr on tr.workspace_id = r.workspace_id and tr.run_id = r.id
      where r.workspace_id = $1 and r.suite_id = $2
        and ($3::uuid is null or $3::uuid = any(r.case_ids))
        and ($5::text is null or r.kind = $5)
        and (r.draft_evaluation_id is null or exists (
          select 1 from eval_draft_evaluations e
           where e.workspace_id = r.workspace_id and e.id = r.draft_evaluation_id
             and ${DRAFT_EVALUATION_VISIBLE_TO('$6', '$7')}))
      group by r.workspace_id, r.id
      order by r.created_at desc, r.id desc
      limit $4`,
    [
      workspaceId,
      filter.suiteId,
      filter.caseId ?? null,
      LIST_EVAL_RUNS_LIMIT,
      filter.kind ?? null,
      seesEveryDraft(viewer.role),
      viewer.principalId,
    ],
  );
  return runs.rows.map((row) => ({
    ...runBase(row),
    caseIds: row.case_ids,
    passed: Number(row.passed),
    failed: Number(row.failed),
    errored: Number(row.errored),
    running: Number(row.running),
    queued: Number(row.queued),
    // Unknown while a trial with no price has ended; a run with nothing ended yet has none.
    costUsd: Number(row.unpriced) > 0 ? null : row.cost_usd,
  }));
}
