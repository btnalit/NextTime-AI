import type { EvalFixtureRule } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { EVALUATION_HANDLE_CAPABILITIES } from '../task/index.js';

/**
 * The capabilities an evaluation Task's Worker may call — its own Task, its tool list, its gate
 * calls and its report. Its Handle is minted with exactly these (`application/task`'s
 * `createEvaluationTask`); the gateway refuses every other one again for its session, whatever the
 * Handle says.
 */
export const EVALUATION_SESSION_CAPABILITIES: ReadonlySet<string> = new Set(
  EVALUATION_HANDLE_CAPABILITIES,
);

/** The two that would reach a gate — answered from the case's fixtures instead. */
export const FIXTURE_CALL_CAPABILITIES: ReadonlySet<string> = new Set([
  'observe_operation',
  'request_action',
]);

/**
 * The audit action a fixture call is recorded under — never `observe_operation` /
 * `request_action`, so a gate's call counts (`get_operation_stats`) hold only calls a gate
 * answered, and the audit log shows an evaluation never reached one.
 */
export const FIXTURE_CALL_AUDIT_ACTION = 'evaluation.fixture_call';

/** The evaluation trial a Worker's session runs. */
export interface EvaluationSession {
  readonly taskId: string;
  /** The Task's input — the case's input, which the Worker is given whatever its split. */
  readonly taskInput: unknown;
  readonly workerRunId: string;
  readonly workerRunActivityId: string | null;
  readonly trialId: string;
  readonly runId: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  /** The `eval_cases` row the trial runs. */
  readonly caseId: string;
  /** What that case's fixture rules answer with — each `data` answer and each error's message:
   *  what the Worker is given by its calls, whatever its split. */
  readonly fixtureAnswers: readonly unknown[];
}

/**
 * What the evaluation seal lets through to this session's Worker (`SealOptions.allow`): its case's
 * input and its case's fixture answers — what the Worker is meant to read even when its case is
 * held out (an assertion often quotes what a fixture answers). The rest of that case — its
 * assertions and fixture conditions — every other case's text and every canary are still stopped.
 */
export function evaluationSealAllowance(session: EvaluationSession): unknown {
  return [session.taskInput, ...session.fixtureAnswers];
}

function fixtureAnswersOf(fixtures: readonly EvalFixtureRule[] | null): unknown[] {
  return (fixtures ?? []).flatMap((rule) =>
    rule.answer.kind === 'data'
      ? [rule.answer.data]
      : rule.answer.kind === 'error'
        ? [rule.answer.message]
        : [],
  );
}

interface EvaluationSessionRow {
  task_id: string;
  input: unknown;
  worker_run_id: string;
  activity_id: string | null;
  trial_id: string | null;
  case_id: string | null;
  run_id: string | null;
  suite_id: string | null;
  suite_version: number | null;
  fixtures: readonly EvalFixtureRule[] | null;
}

/**
 * The evaluation trial the Handle session `sessionId` runs, or `null` when the session is not an
 * evaluation Task's Worker. One indexed read per Handle call (`worker_runs_session_id_idx`).
 *
 * Only a WorkerRun session is ever an evaluation one: this reads by the WorkerRun's session, the
 * evaluation service Principal acts in evaluation Tasks only (migrations/task/0011), and an
 * evaluation run starts no other run. The gateway issues no service Handle for an internal
 * Principal (`service-handle-handler.ts`); the host's `bootstrap issue-service-handle`, run with
 * the database owner's rights, is not held to that — a Handle it mints has a service session, not
 * a WorkerRun's, so it reads here as no evaluation session and acts as that Principal does
 * anywhere: a member with no Grant.
 *
 * An evaluation Task with no trial cannot be made (the runner writes both in one transaction); if
 * one is found anyway, this throws, and the call fails rather than reaching anything.
 */
export async function readEvaluationSession(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
): Promise<EvaluationSession | null> {
  const found = await client.query<EvaluationSessionRow>(
    `select t.id as task_id, t.input, w.id as worker_run_id, w.activity_id,
            tr.id as trial_id, tr.case_id, r.id as run_id, r.suite_id, r.suite_version,
            c.fixtures
       from worker_runs w
       join tasks t on t.workspace_id = w.workspace_id and t.id = w.task_id
       left join eval_trials tr on tr.workspace_id = t.workspace_id and tr.task_id = t.id
       left join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
       left join eval_cases c on c.workspace_id = tr.workspace_id and c.id = tr.case_id
      where w.workspace_id = $1 and w.session_id = $2 and t.purpose = 'evaluation'`,
    [workspaceId, sessionId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (
    row.trial_id === null ||
    row.case_id === null ||
    row.run_id === null ||
    row.suite_id === null ||
    row.suite_version === null
  ) {
    throw new Error(
      `evaluation session: Task ${row.task_id} is an evaluation Task with no trial — its Worker is refused every call`,
    );
  }
  return {
    taskId: row.task_id,
    taskInput: row.input,
    workerRunId: row.worker_run_id,
    workerRunActivityId: row.activity_id,
    trialId: row.trial_id,
    runId: row.run_id,
    suiteId: row.suite_id,
    suiteVersion: row.suite_version,
    caseId: row.case_id,
    fixtureAnswers: fixtureAnswersOf(row.fixtures),
  };
}
