import type { PoolClient } from 'pg';

/**
 * substrate/audit/goal-invariant-checks (S11 GO1; docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §3.3): the scheduled checks for the goal-execution invariants I-G1, I-G2, I-G6 and
 * I-G9, run by `invariant-checks.ts`'s `runInvariantChecks` with the rest and exported as the same
 * `nexttime_invariant_violations{invariant="I-G…"}` gauges. Same posture as that module (read its
 * doc comment): read-only, cross-workspace, plain SQL against the tables that hold the facts
 * (`goal_runs`, `plan_revisions`, `step_runs` — application/goal; `tasks`, `worker_runs` —
 * application/task; `action_requests` — governance/approval), never an import of those modules —
 * a monitor that trusted the write path would miss exactly what it is here to catch.
 *
 * Each invariant is one gauge made of a few row-level conditions; a sampled row names the
 * condition it broke. Where the database already makes a breach unrepresentable (I-G1's unique
 * index, I-G9's `withdrawn` guard) the check watches that the mechanism is still in place, as I4 /
 * I12 do.
 *
 * | # | Conditions counted |
 * |---|---|
 * | I-G1 one Task per attempt | `tasks_step_attempt_uidx` missing or not a valid unique index; a StepRun whose attempt Tasks do not number exactly 1..`attempt_count`; a StepRun with more than one unfinished attempt Task at once (attempts are sequential, one layer of retry) |
 * | I-G2 only current-plan steps advance | an unfinished StepRun (`pending` … `failed`, not superseded) whose definition is not in its GoalRun's current plan unchanged — dropped or redefined without being superseded; a finished one whose key the current plan redefines; a key of the current plan with no live StepRun while the GoalRun runs; an attempt Task started under a revision outside its StepRun's live window or under a revision never accepted; an accepted revision newer than the current one |
 * | I-G6 budget | a `running` GoalRun past its wall-clock budget by more than the grace period; or over its token, step or revision budget with no Task of it still running and nothing finished for the grace period — the advancer checks budgets between steps, so a Task that overshoots mid-run is not counted until it ends |
 * | I-G9 only live steps act | `action_requests_status_guard` (governance/0021, the `withdrawn` guard) missing or disabled; a request of a cancelled StepRun, or of a cancelling / cancelled GoalRun, still awaiting a decision or approved and queued (it is withdrawn in the transaction that cancels); a request of a cancelled StepRun that started executing after the step ended; a request created after its StepRun was superseded or cancelled; a request whose StepRun is not the one its Worker's Task runs for |
 *
 * Not covered yet, on purpose: I-G9 for requests of a *superseded* step that are still pending or
 * started after supersession — "让它跑完" lets a person release some of them one by one (§4.8), and
 * that release (GO3) is what tells a legitimate one from a breach; the check grows with it.
 */

interface ConditionRow {
  workspace_id: string;
  id: string;
  detail: string;
}

/** A row-level condition: its label (prefixed to each sampled row) and the query returning the
 *  rows that break it, newest or most relevant first. */
interface Condition {
  readonly label: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface GoalInvariantCheckResult {
  readonly invariant: string;
  readonly violations: number;
  readonly sample: readonly string[];
}

async function runConditions(
  client: PoolClient,
  invariant: string,
  conditions: readonly Condition[],
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  let violations = 0;
  const sample: string[] = [];
  for (const condition of conditions) {
    const result = await client.query<ConditionRow>(condition.sql, [...(condition.params ?? [])]);
    violations += result.rows.length;
    for (const row of result.rows) {
      if (sample.length >= sampleLimit) break;
      sample.push(`${condition.label} ${row.workspace_id}:${row.id} (${row.detail})`);
    }
  }
  return { invariant, violations, sample };
}

// -------------------------------------------------------------------------------------------
// I-G1 — each attempt of a StepRun is at most one Task.
// -------------------------------------------------------------------------------------------

export async function checkIG1(
  client: PoolClient,
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  return runConditions(
    client,
    'I-G1',
    [
      {
        label: 'index',
        sql: `select 'tasks' as workspace_id, 'tasks_step_attempt_uidx' as id,
                     'missing or not a valid unique index' as detail
              where not exists (
                select 1 from pg_index i
                  join pg_class c on c.oid = i.indexrelid
                 where c.relname = 'tasks_step_attempt_uidx'
                   and i.indisunique and i.indisvalid
              )`,
      },
      {
        label: 'attempts',
        sql: `select s.workspace_id, s.id,
                     'attempt_count ' || s.attempt_count || ', attempt tasks ' || count(t.id)
                       || ', highest ' || coalesce(max(t.step_attempt)::text, 'none') as detail
                from step_runs s
                left join tasks t
                  on t.workspace_id = s.workspace_id and t.step_run_id = s.id
                 and t.step_attempt is not null
               group by s.workspace_id, s.id, s.attempt_count, s.updated_at
              having count(t.id) <> s.attempt_count
                  or coalesce(max(t.step_attempt), 0) <> s.attempt_count
               order by s.updated_at desc, s.id desc`,
      },
      {
        label: 'concurrent',
        sql: `select t.workspace_id, t.step_run_id as id,
                     count(*) || ' unfinished attempt tasks' as detail
                from tasks t
               where t.step_attempt is not null
                 and t.status in ('created', 'queued', 'running', 'waiting_approval')
               group by t.workspace_id, t.step_run_id
              having count(*) > 1
               order by t.workspace_id, t.step_run_id`,
      },
    ],
    sampleLimit,
  );
}

// -------------------------------------------------------------------------------------------
// I-G2 — only steps of the current plan revision are advanced.
// -------------------------------------------------------------------------------------------

/** The plan entry of each StepRun in the revision that introduced it, and the GoalRun's current
 *  plan — the two the I-G2 conditions compare. "Unchanged" is jsonb equality of the whole entry,
 *  not containment: `@>` is partial for objects, so an entry redefined by adding a field would
 *  still contain the old one. */
const STEP_PLAN_ENTRIES = `
  with entries as (
    select s.workspace_id, s.id, s.goal_run_id, s.step_key, s.status, s.updated_at,
           g.status as goal_status, g.current_revision,
           (select e from jsonb_array_elements(intro.plan -> 'steps') e
             where e ->> 'key' = s.step_key limit 1) as intro_entry,
           cur.plan -> 'steps' as current_steps
      from step_runs s
      join goal_runs g on g.workspace_id = s.workspace_id and g.id = s.goal_run_id
      join plan_revisions intro
        on intro.workspace_id = s.workspace_id and intro.goal_run_id = s.goal_run_id
       and intro.revision = s.introduced_in_revision
      join plan_revisions cur
        on cur.workspace_id = g.workspace_id and cur.goal_run_id = g.id
       and cur.revision = g.current_revision
     where s.status <> 'superseded'
  )`;

export async function checkIG2(
  client: PoolClient,
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  return runConditions(
    client,
    'I-G2',
    [
      {
        label: 'unfinished-not-in-plan',
        sql: `${STEP_PLAN_ENTRIES}
              select workspace_id, id,
                     'step ' || step_key || ' is ' || status
                       || ' but revision ' || current_revision || ' does not hold it unchanged' as detail
                from entries
               where status in ('pending', 'ready', 'running', 'waiting', 'failed')
                 and not exists (select 1 from jsonb_array_elements(current_steps) e
                                  where e = intro_entry)
               order by updated_at desc, id desc`,
      },
      {
        label: 'finished-redefined',
        sql: `${STEP_PLAN_ENTRIES}
              select workspace_id, id,
                     'step ' || step_key || ' is ' || status
                       || ' but revision ' || current_revision || ' redefines its key' as detail
                from entries
               where status in ('succeeded', 'cancelled', 'skipped')
                 and exists (select 1 from jsonb_array_elements(current_steps) e
                              where e ->> 'key' = step_key)
                 and not exists (select 1 from jsonb_array_elements(current_steps) e
                                  where e = intro_entry)
               order by updated_at desc, id desc`,
      },
      {
        label: 'planned-without-step',
        sql: `select g.workspace_id, g.id,
                     'revision ' || g.current_revision || ' plans step ' || (e ->> 'key')
                       || ' with no live step run' as detail
                from goal_runs g
                join plan_revisions cur
                  on cur.workspace_id = g.workspace_id and cur.goal_run_id = g.id
                 and cur.revision = g.current_revision
                cross join lateral jsonb_array_elements(cur.plan -> 'steps') e
               where g.status in ('running', 'paused', 'verifying')
                 and not exists (
                   select 1 from step_runs s
                    where s.workspace_id = g.workspace_id and s.goal_run_id = g.id
                      and s.step_key = e ->> 'key' and s.status <> 'superseded'
                 )
               order by g.updated_at desc, g.id desc`,
      },
      {
        label: 'task-outside-window',
        sql: `select t.workspace_id, t.id,
                     'attempt ' || t.step_attempt || ' started under revision ' || t.plan_revision
                       || ', step live from ' || s.introduced_in_revision
                       || coalesce(' until ' || s.superseded_in_revision, '')
                       || ', revision ' || pr.status as detail
                from tasks t
                join step_runs s on s.workspace_id = t.workspace_id and s.id = t.step_run_id
                join plan_revisions pr
                  on pr.workspace_id = t.workspace_id and pr.goal_run_id = t.goal_run_id
                 and pr.revision = t.plan_revision
               where t.step_attempt is not null
                 and (pr.status <> 'accepted'
                      or t.plan_revision < s.introduced_in_revision
                      or (s.superseded_in_revision is not null
                          and t.plan_revision >= s.superseded_in_revision))
               order by t.created_at desc, t.id desc`,
      },
      {
        label: 'accepted-not-current',
        sql: `select pr.workspace_id, pr.id,
                     'revision ' || pr.revision || ' accepted, current is '
                       || coalesce(g.current_revision::text, 'none') as detail
                from plan_revisions pr
                join goal_runs g on g.workspace_id = pr.workspace_id and g.id = pr.goal_run_id
               where pr.status = 'accepted'
                 and (g.current_revision is null or pr.revision > g.current_revision)
               order by pr.decided_at desc, pr.id desc`,
      },
    ],
    sampleLimit,
  );
}

// -------------------------------------------------------------------------------------------
// I-G6 — a GoalRun stays within its budget; past it, it pauses.
// -------------------------------------------------------------------------------------------

export const DEFAULT_GOAL_BUDGET_GRACE_MS = 10 * 60 * 1000;

export async function checkIG6(
  client: PoolClient,
  sampleLimit: number,
  graceMs: number,
): Promise<GoalInvariantCheckResult> {
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  return runConditions(
    client,
    'I-G6',
    [
      {
        label: 'wall-clock',
        sql: `select g.workspace_id, g.id,
                     'running since ' || g.confirmed_at || ', budget '
                       || g.budget_max_wall_clock_seconds || ' s' as detail
                from goal_runs g
               where g.status = 'running'
                 and g.confirmed_at + make_interval(secs => g.budget_max_wall_clock_seconds)
                     < $1::timestamptz
               order by g.confirmed_at, g.id`,
        params: [cutoff],
      },
      {
        label: 'usage',
        sql: `with usage as (
                select g.workspace_id, g.id, g.updated_at, g.budget_max_tokens,
                       g.budget_max_steps, g.budget_max_revisions,
                       coalesce(sum(t.tokens_used), 0) as tokens,
                       count(t.id) filter (where t.step_attempt is not null) as steps,
                       count(t.id) filter (
                         where t.status in ('created', 'queued', 'running', 'waiting_approval')
                       ) as unfinished,
                       max(coalesce(t.completed_at, t.failed_at, t.cancelled_at)) as last_task_end,
                       (select count(*) - 1 from plan_revisions pr
                         where pr.workspace_id = g.workspace_id and pr.goal_run_id = g.id
                           and pr.status = 'accepted') as revisions
                  from goal_runs g
                  left join tasks t on t.workspace_id = g.workspace_id and t.goal_run_id = g.id
                 where g.status = 'running'
                 group by g.workspace_id, g.id
              )
              select workspace_id, id,
                     'tokens ' || tokens || '/' || budget_max_tokens
                       || ', steps ' || steps || '/' || budget_max_steps
                       || ', revisions ' || revisions || '/' || budget_max_revisions as detail
                from usage
               where (tokens > budget_max_tokens
                      or steps > budget_max_steps
                      or revisions > budget_max_revisions)
                 and unfinished = 0
                 and greatest(updated_at, coalesce(last_task_end, updated_at)) < $1::timestamptz
               order by updated_at, id`,
        params: [cutoff],
      },
    ],
    sampleLimit,
  );
}

// -------------------------------------------------------------------------------------------
// I-G9 — only a live step of a live GoalRun raises actions, and only those run.
// -------------------------------------------------------------------------------------------

export async function checkIG9(
  client: PoolClient,
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  return runConditions(
    client,
    'I-G9',
    [
      {
        label: 'guard',
        sql: `select 'action_requests' as workspace_id, 'action_requests_status_guard' as id,
                     'missing or disabled' as detail
              where not exists (
                select 1 from pg_trigger
                 where tgrelid = 'action_requests'::regclass
                   and tgname = 'action_requests_status_guard'
                   and not tgisinternal and tgenabled <> 'D'
              )`,
      },
      {
        label: 'not-withdrawn',
        sql: `select ar.workspace_id, ar.id,
                     ar.status || ' while step ' || s.status || ', goal ' || g.status as detail
                from action_requests ar
                join step_runs s on s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
                join goal_runs g on g.workspace_id = s.workspace_id and g.id = s.goal_run_id
               where ar.status in ('pending_approval', 'approved', 'auto_approved')
                 and (s.status = 'cancelled' or g.status in ('cancelling', 'cancelled'))
               order by ar.requested_at desc, ar.id desc`,
      },
      {
        label: 'ran-after-cancel',
        sql: `select ar.workspace_id, ar.id,
                     'executing at ' || ar.executing_at || ', step cancelled at ' || s.ended_at as detail
                from action_requests ar
                join step_runs s on s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
               where s.status = 'cancelled'
                 and ar.executing_at > s.ended_at
               order by ar.executing_at desc, ar.id desc`,
      },
      {
        label: 'raised-after-end',
        sql: `select ar.workspace_id, ar.id,
                     'requested at ' || ar.requested_at || ', step ' || s.status
                       || ' at ' || s.ended_at as detail
                from action_requests ar
                join step_runs s on s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
               where s.status in ('superseded', 'cancelled')
                 and ar.requested_at > s.ended_at
               order by ar.requested_at desc, ar.id desc`,
      },
      {
        label: 'step-mismatch',
        sql: `select ar.workspace_id, ar.id,
                     'request step ' || coalesce(ar.step_run_id::text, 'none')
                       || ', task step ' || coalesce(t.step_run_id::text, 'none') as detail
                from action_requests ar
                join worker_runs wr
                  on wr.workspace_id = ar.workspace_id and wr.id = ar.parent_worker_run_id
                join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
               where ar.step_run_id is distinct from t.step_run_id
               order by ar.requested_at desc, ar.id desc`,
      },
    ],
    sampleLimit,
  );
}
