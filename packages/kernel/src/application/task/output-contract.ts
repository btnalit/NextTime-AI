import {
  MAX_OUTPUT_PROBLEMS,
  type OutputProblem,
  type OutputSchema,
  type TaskStatus,
  boundedEcho,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * application/task/output-contract (S11 GO5d-1; plan §4.5, §4.7; STATUS legacy 358): what an
 * attempt Task of a goal step carries about its output contract (migrations/task/0008):
 *
 *   - `output_schema` — the step's `outputSchema`, copied from its plan entry when the attempt is
 *     created (`step-attempt.ts`). `report_task_result` refuses a result whose `output` does not
 *     match it, or that has none (`@nexttime/shared` `outputContractProblems`) — 400, each place
 *     named, so the Worker fixes it in its session (`TaskOutputRejectedError`);
 *   - `rejected_output` — the last such refused report, recorded after the refused call rolled back
 *     (`application/gateway/dispatch.ts`, {@link recordRejectedOutput}), while the Task has not
 *     ended. A Worker that never reports an accepted result leaves its Task `failed / no_result`,
 *     which the advancer judges `contract_violation`;
 *   - `rework_of` — the attempt a new one redoes when that one ended `no_result`: its Task, number
 *     and last refused report, copied when the attempt is created, so the Worker reads what to fix
 *     (`get_task`, the extension's "Previous attempt" section).
 */

/** A report the output contract refused — see the module comment. */
export interface RejectedOutput {
  readonly output: Record<string, unknown> | null;
  readonly problems: readonly OutputProblem[];
  readonly problemCount: number;
  /** ISO 8601, the database's time of the record. */
  readonly at: string;
}

/** The attempt a rework redoes — see the module comment. */
export interface ReworkOf {
  readonly taskId: string;
  readonly attempt: number;
  readonly rejectedOutput: RejectedOutput | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A stored `rejected_output` (or the one inside `rework_of`), or `null` when there is none or it
 *  does not read as one — written only by {@link recordRejectedOutput}, so that is a broken row. */
export function parseRejectedOutput(value: unknown): RejectedOutput | null {
  if (!isRecord(value)) return null;
  const { output, problems, problemCount, at } = value;
  if (!Array.isArray(problems) || typeof problemCount !== 'number' || typeof at !== 'string') {
    return null;
  }
  return {
    output: isRecord(output) ? output : null,
    problems: problems.filter(
      (problem): problem is OutputProblem =>
        isRecord(problem) &&
        typeof problem.path === 'string' &&
        typeof problem.message === 'string',
    ),
    problemCount,
    at,
  };
}

/** A stored `rework_of`, or `null` when there is none or it does not read as one. */
export function parseReworkOf(value: unknown): ReworkOf | null {
  if (!isRecord(value)) return null;
  const { taskId, attempt, rejectedOutput } = value;
  if (typeof taskId !== 'string' || typeof attempt !== 'number') return null;
  return { taskId, attempt, rejectedOutput: parseRejectedOutput(rejectedOutput) };
}

/**
 * Thrown by `report_task_result` when the result's `output` breaks the attempt's output contract
 * (400 `invalid_params`). The message names every place (at most `MAX_OUTPUT_PROBLEMS`) — it is
 * what the Worker's model reads to fix the output — and never a value. `dispatch.ts` records the
 * refusal on the Task after the call's transaction rolled back ({@link recordRejectedOutput}).
 */
export class TaskOutputRejectedError extends Error {
  readonly taskId: string;
  readonly output: Record<string, unknown> | null;
  readonly problems: readonly OutputProblem[];
  readonly problemCount: number;

  constructor(input: {
    readonly taskId: string;
    readonly output: Record<string, unknown> | null;
    readonly problems: readonly OutputProblem[];
    readonly problemCount: number;
  }) {
    const listed = input.problems
      .slice(0, MAX_OUTPUT_PROBLEMS)
      .map((problem) => `${boundedEcho(problem.path, 200)}: ${problem.message}`)
      .join('; ');
    const more =
      input.problemCount > input.problems.length
        ? `; and ${input.problemCount - input.problems.length} more`
        : '';
    super(
      `report_task_result: the output does not meet this step's output contract (${input.problemCount} problem${input.problemCount === 1 ? '' : 's'}) — ${listed}${more}. Fix the output and report the result again.`,
    );
    this.name = 'TaskOutputRejectedError';
    this.taskId = input.taskId;
    this.output = input.output;
    this.problems = input.problems;
    this.problemCount = input.problemCount;
  }
}

/** The status of `taskId` and the output schema it is held to (`null`: none) — read by
 *  `report_task_result` before anything else of the report. The schema was checked when the plan
 *  holding it was accepted, and plan revisions never change, so it is used as stored. */
export async function readTaskOutputContract(
  client: PoolClient,
  workspaceId: string,
  taskId: string,
): Promise<{ readonly status: TaskStatus; readonly outputSchema: OutputSchema | null } | null> {
  const result = await client.query<{ status: TaskStatus; output_schema: unknown }>(
    'select status, output_schema from tasks where workspace_id = $1 and id = $2',
    [workspaceId, taskId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    outputSchema: isRecord(row.output_schema) ? (row.output_schema as OutputSchema) : null,
  };
}

/** Records `refused` as the Task's last refused report, while the Task has not ended (a report
 *  that lost a race with the Task's end records nothing). `false` when nothing was recorded. */
export async function recordRejectedOutput(
  client: PoolClient,
  workspaceId: string,
  refused: TaskOutputRejectedError,
): Promise<boolean> {
  const result = await client.query(
    `update tasks
        set rejected_output = jsonb_build_object(
              'output', $3::jsonb,
              'problems', $4::jsonb,
              'problemCount', $5::int,
              'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      where workspace_id = $1 and id = $2 and output_schema is not null
        and status in ('queued', 'running', 'waiting_approval')`,
    [
      workspaceId,
      refused.taskId,
      JSON.stringify(refused.output),
      JSON.stringify(refused.problems),
      refused.problemCount,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** How many attempts of `stepRunId` ended without an accepted result (`failed / no_result`) — the
 *  advancer reworks a step once, after the first. */
export async function countStepAttemptsWithoutResult(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*) as count from tasks
      where workspace_id = $1 and step_run_id = $2 and step_attempt is not null
        and status = 'failed' and failure_reason = 'no_result'`,
    [workspaceId, stepRunId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** What attempt `attempt` of `stepRunId` reported as `output` with its accepted result: `found`
 *  only when that attempt's Task completed with one. Read as stored — the advancer binds it into
 *  a later step's input (`application/goal/bindings.ts`), which its own credential review covers. */
export async function readStepAttemptOutput(
  client: PoolClient,
  workspaceId: string,
  stepRunId: string,
  attempt: number,
): Promise<{ readonly found: true; readonly output: unknown } | { readonly found: false }> {
  const result = await client.query<{ status: TaskStatus; output: unknown; has_output: boolean }>(
    `select status, result -> 'output' as output, coalesce(result ? 'output', false) as has_output
       from tasks
      where workspace_id = $1 and step_run_id = $2 and step_attempt = $3`,
    [workspaceId, stepRunId, attempt],
  );
  const row = result.rows[0];
  if (!row || row.status !== 'completed' || !row.has_output) return { found: false };
  return { found: true, output: row.output };
}
