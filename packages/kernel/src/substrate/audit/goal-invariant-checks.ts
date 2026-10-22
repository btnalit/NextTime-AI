import type { PoolClient } from 'pg';

/**
 * substrate/audit/goal-invariant-checks (S11 GO1; docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §3.3): the scheduled checks for the goal-execution invariants I-G1, I-G2, I-G5,
 * I-G6 and I-G9, run by `invariant-checks.ts`'s `runInvariantChecks` with the rest and exported as
 * the same `nexttime_invariant_violations{invariant="I-G…"}` gauges. Same posture as that module
 * (read its doc comment): read-only, cross-workspace, plain SQL against the tables that hold the
 * facts (`goal_runs`, `plan_revisions`, `step_runs`, `goal_acceptance_checks` — application/goal;
 * `tasks`, `worker_runs` — application/task; `action_requests` — governance/approval;
 * `observations`, `decisions` — core), never an import of those modules — a monitor that trusted
 * the write path would miss exactly what it is here to catch.
 *
 * Each invariant is one gauge made of a few row-level conditions; a sampled row names the
 * condition it broke. Where the database already makes a breach unrepresentable (I-G1's unique
 * index, the goal tables' guard triggers for I-G2 and I-G5, I-G9's `withdrawn` guard) the check also
 * watches that the mechanism is still in place, as I4 / I12 do — a trigger counts only while it
 * fires in an ordinary session (`tgenabled` `'O'` or `'A'`; `'R'` fires only under
 * `session_replication_role = replica`).
 *
 * | # | Conditions counted |
 * |---|---|
 * | I-G1 one Task per attempt | `tasks_step_attempt_uidx` missing or not a valid unique index; a StepRun whose attempt Tasks do not number exactly 1..`attempt_count`; a StepRun with more than one unfinished attempt Task at once (attempts are sequential, one layer of retry); an attempt Task with more than one WorkerRun (S11 GO2: the advancer's Tasks have no Task-internal retry, so a second run means a retry layer under the StepRun's) |
 * | I-G2 only current-plan steps advance | a guard trigger of `goal_runs` / `plan_revisions` / `step_runs` (goal/0001) or `tasks_goal_step_immutable` (task/0007) missing or not enabled; an unfinished StepRun (`pending` … `failed`, not superseded) whose definition is not in its GoalRun's current plan unchanged — dropped or redefined without being superseded; a finished one whose key the current plan redefines; a key of the current plan with no live StepRun while the GoalRun runs; an attempt Task started under a revision outside its StepRun's live window or under a revision never accepted; an accepted revision off the chain that `based_on_revision` walks back from the current one (newer than it, or skipped by it — I-G3); a revision on that chain that is not accepted |
 * | I-G5 an outcome rests on verification or the requester's word — the goal's, and a step's success on its own checks (GO4b) | `goal_runs_status_guard` (goal/0005), `goal_acceptance_checks_guard`, `step_runs_acceptance_guard` or `step_acceptance_checks_guard` (goal/0006) missing or not enabled; a GoalRun completed by check (`verified_by_check`) other than `achieved` (a CHECK keeps a person's Decision off it), or whose latest acceptance round has a check not `passed`, a check on a plan other than the current one, no check the platform made (an observation, or a Fact of the graph — GO4c) — or no round at all; a GoalRun completed on the requester's word whose outcome Decision is not the requester's own, approved, naming the run and that outcome; a `passed` acceptance check with no evidence — an observation without an Observation of that check that satisfied its predicate, a fact check whose Fact is not the Link it names (GO4c), a confirmation without the requester's own Decision for that check; a succeeded StepRun whose plan entry declares acceptance checks with no round of them, or whose latest round has a check not `passed` for its current attempt or lacks one it declares; a `passed` step acceptance check without its evidence, as for the goal's |
 * | I-G6 budget | a `running` GoalRun past its wall-clock budget by more than the grace period; or over its token, step or revision budget with no Task of it still running and nothing finished for the grace period — the advancer checks budgets between steps, so a Task that overshoots mid-run is not counted until it ends |
 * | I-G9 only live steps act | `action_requests_status_guard` (governance/0021, the `withdrawn` guard) or `action_requests_step_run_immutable` (governance/0022) missing or not enabled; a request of a cancelled StepRun, or of a cancelling / cancelled GoalRun, or of a superseded StepRun that the superseding revision did not release (`plan_revisions.removals`, goal/0004), still awaiting a decision or approved and queued (it is withdrawn in the transaction that cancels or revises); a request of a cancelled StepRun, or of a superseded one not released, that started executing after the step ended; a request created after its StepRun was superseded or cancelled; a request whose StepRun is not the one its Worker's Task runs for, or that records a StepRun with no Worker's Task behind it |
 *
 * A request a person released when a revision let its step finish ("让它跑完", §4.8) is listed on
 * that revision (`removals -> <stepKey> -> release`): it legitimately stays pending and may run
 * after its step was superseded (S11 GO3b), so I-G9 counts the superseded step's other requests
 * only.
 */

/** A request `ar` of a superseded step `s` is one the superseding revision released (goal/0004). */
const RELEASED_BY_REVISION = `exists (
                   select 1 from plan_revisions pr
                    where pr.workspace_id = s.workspace_id and pr.goal_run_id = s.goal_run_id
                      and pr.revision = s.superseded_in_revision
                      and coalesce(pr.removals -> s.step_key -> 'release', '[]'::jsonb) ? ar.id::text)`;

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

/** Each listed trigger that is missing or does not fire in an ordinary session: `tgenabled` must
 *  be `'O'` (origin) or `'A'` (always) — `'D'` is disabled, and `'R'` fires only under
 *  `session_replication_role = replica`, so `ENABLE REPLICA TRIGGER` switches a guard off too. */
function triggersEnabled(
  label: string,
  triggers: readonly (readonly [table: string, trigger: string])[],
): Condition {
  return {
    label,
    sql: `select e.tbl as workspace_id, e.trg as id, 'missing or not enabled' as detail
            from unnest($1::text[], $2::text[]) as e (tbl, trg)
           where not exists (
             select 1 from pg_trigger t
              where t.tgrelid = to_regclass(e.tbl) and t.tgname = e.trg
                and not t.tgisinternal and t.tgenabled in ('O', 'A')
           )
           order by e.tbl, e.trg`,
    params: [triggers.map(([table]) => table), triggers.map(([, trigger]) => trigger)],
  };
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
      {
        label: 'runs',
        sql: `select t.workspace_id, t.id,
                     count(wr.id) || ' worker runs for attempt ' || t.step_attempt as detail
                from tasks t
                join worker_runs wr on wr.workspace_id = t.workspace_id and wr.task_id = t.id
               where t.step_attempt is not null
               group by t.workspace_id, t.id, t.step_attempt
              having count(wr.id) > 1
               order by t.workspace_id, t.id`,
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

/** The revisions in force, walked back from each GoalRun's current revision along
 *  `based_on_revision` (which is always smaller — a CHECK — so the walk ends). Every accepted
 *  revision is on it, and everything on it is accepted (I-G3: the accepted revisions are one chain). */
const REVISION_CHAIN = `
  with recursive chain as (
    select g.workspace_id, g.id as goal_run_id, g.current_revision as revision
      from goal_runs g
     where g.current_revision is not null
    union all
    select pr.workspace_id, pr.goal_run_id, pr.based_on_revision
      from chain c
      join plan_revisions pr
        on pr.workspace_id = c.workspace_id and pr.goal_run_id = c.goal_run_id
       and pr.revision = c.revision
     where pr.based_on_revision is not null
  )`;

export async function checkIG2(
  client: PoolClient,
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  return runConditions(
    client,
    'I-G2',
    [
      triggersEnabled('guards', [
        ['goal_runs', 'goal_runs_status_guard'],
        ['plan_revisions', 'plan_revisions_guard'],
        ['plan_revisions', 'plan_revisions_adopted'],
        ['step_runs', 'step_runs_status_guard'],
        ['tasks', 'tasks_goal_step_immutable'],
      ]),
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
        label: 'accepted-off-chain',
        sql: `${REVISION_CHAIN}
              select pr.workspace_id, pr.id,
                     'revision ' || pr.revision || ' accepted on '
                       || coalesce(pr.based_on_revision::text, 'none') || ', current is '
                       || coalesce(g.current_revision::text, 'none') || ', not on its chain' as detail
                from plan_revisions pr
                join goal_runs g on g.workspace_id = pr.workspace_id and g.id = pr.goal_run_id
               where pr.status = 'accepted'
                 and not exists (
                   select 1 from chain c
                    where c.workspace_id = pr.workspace_id and c.goal_run_id = pr.goal_run_id
                      and c.revision = pr.revision
                 )
               order by pr.decided_at desc, pr.id desc`,
      },
      {
        label: 'chain-not-accepted',
        sql: `${REVISION_CHAIN}
              select c.workspace_id, c.goal_run_id as id,
                     'revision ' || c.revision || ' is on the chain but '
                       || coalesce(pr.status, 'missing') as detail
                from chain c
                left join plan_revisions pr
                  on pr.workspace_id = c.workspace_id and pr.goal_run_id = c.goal_run_id
                 and pr.revision = c.revision
               where pr.status is distinct from 'accepted'
               order by c.workspace_id, c.goal_run_id, c.revision desc`,
      },
    ],
    sampleLimit,
  );
}

/** Whether the Fact a fact check (row `c`, goal/0007) rests on is the Link it names — its type and
 *  its two ends, each by id or by ObjectType and identity — as `goal_fact_is` decides it, in plain
 *  SQL. Only this part of a Fact's admissibility stays true after the check passed: a later
 *  confirmation, a supersession or an invalidation of the Fact may change the rest. */
function factIsNamed(c: string): string {
  const endpoint = (object: string, ref: string) => `(case
      when jsonb_typeof(${ref} -> 'objectId') = 'string'
        then ${object}.id::text = lower(${ref} ->> 'objectId')
      when jsonb_typeof(${ref} -> 'objectType') = 'string'
           and jsonb_typeof(${ref} -> 'identity') = 'object'
        then ${object}.object_type = ${ref} ->> 'objectType'
             and ${object}.identity_key = ${ref} -> 'identity'
      else false
    end)`;
  return `exists (
    select 1 from links l
      join objects src on src.workspace_id = l.workspace_id and src.id = l.source_object_id
      join objects tgt on tgt.workspace_id = l.workspace_id and tgt.id = l.target_object_id
     where l.workspace_id = ${c}.workspace_id and l.id = ${c}.fact_id
       and l.link_type = ${c}.fact_check ->> 'linkType'
       and ${endpoint('src', `${c}.fact_check -> 'source'`)}
       and ${endpoint('tgt', `${c}.fact_check -> 'target'`)})`;
}

// -------------------------------------------------------------------------------------------
// I-G5 — a GoalRun's objective outcome rests on its verification or on its requester's word; a
// step with acceptance checks succeeds only on them (GO4b).
// -------------------------------------------------------------------------------------------

export async function checkIG5(
  client: PoolClient,
  sampleLimit: number,
): Promise<GoalInvariantCheckResult> {
  return runConditions(
    client,
    'I-G5',
    [
      triggersEnabled('guards', [
        ['goal_runs', 'goal_runs_status_guard'],
        ['goal_acceptance_checks', 'goal_acceptance_checks_guard'],
        ['step_runs', 'step_runs_acceptance_guard'],
        ['step_acceptance_checks', 'step_acceptance_checks_guard'],
      ]),
      {
        label: 'achieved-by-check',
        sql: `with by_check as (
                select g.workspace_id, g.id, g.outcome, g.current_revision, g.ended_at,
                       (select max(c.round) from goal_acceptance_checks c
                         where c.workspace_id = g.workspace_id and c.goal_run_id = g.id) as round
                  from goal_runs g
                 where g.status = 'completed' and g.outcome_basis = 'verified_by_check'
              ),
              latest as (
                select b.workspace_id, b.id, b.outcome, b.round, b.ended_at,
                       count(c.check_key) filter (where c.status <> 'passed') as not_passed,
                       count(c.check_key)
                         filter (where c.plan_revision is distinct from b.current_revision) as off_plan,
                       count(c.check_key)
                         filter (where c.kind in ('observe_predicate', 'fact_predicate')) as made
                  from by_check b
                  left join goal_acceptance_checks c
                    on c.workspace_id = b.workspace_id and c.goal_run_id = b.id and c.round = b.round
                 group by b.workspace_id, b.id, b.outcome, b.round, b.ended_at
              )
              select workspace_id, id,
                     concat_ws(', ',
                       case when outcome is distinct from 'achieved' then 'outcome ' || outcome end,
                       case when round is null then 'no acceptance round'
                            else 'round ' || round || ': ' || not_passed || ' not passed, '
                              || off_plan || ' off the current plan, ' || made
                              || ' made by the platform' end) as detail
                from latest
               where outcome is distinct from 'achieved'
                  or round is null or not_passed > 0 or off_plan > 0 or made = 0
               order by ended_at desc, id desc`,
      },
      {
        label: 'requester-basis',
        sql: `select g.workspace_id, g.id,
                     g.outcome || ' on the requester''s word, decision '
                       || coalesce(g.outcome_decision_id::text, 'none') || ' is not theirs saying so' as detail
                from goal_runs g
               where g.status = 'completed' and g.outcome_basis = 'requester'
                 and not exists (
                   select 1 from decisions d
                    where d.workspace_id = g.workspace_id and d.id = g.outcome_decision_id
                      and d.decided_by = g.on_behalf_of and d.status = 'approved'
                      and d.rationale ->> 'decision' = 'goal_outcome'
                      and d.rationale ->> 'goalRunId' = g.id::text
                      and d.rationale ->> 'outcome' = g.outcome
                 )
               order by g.ended_at desc, g.id desc`,
      },
      {
        label: 'passed-without-evidence',
        sql: `select c.workspace_id, c.goal_run_id as id,
                     'round ' || c.round || ' check ' || c.check_key || ' (' || c.kind
                       || ') passed without its evidence' as detail
                from goal_acceptance_checks c
                join goal_runs g on g.workspace_id = c.workspace_id and g.id = c.goal_run_id
               where c.status = 'passed'
                 and case c.kind
                       when 'observe_predicate' then not exists (
                         select 1 from observations o
                          where o.workspace_id = c.workspace_id and o.id = c.observation_id
                            and o.content ->> 'purpose' = 'acceptance_check'
                            and o.content ->> 'goalRunId' = c.goal_run_id::text
                            and o.content ->> 'round' = c.round::text
                            and o.content ->> 'checkKey' = c.check_key
                            and o.content ->> 'outcome' = 'satisfied')
                       when 'requester_confirm' then not exists (
                         select 1 from decisions d
                          where d.workspace_id = c.workspace_id and d.id = c.decision_id
                            and d.decided_by = g.on_behalf_of and d.status = 'approved'
                            and d.rationale ->> 'decision' = 'goal_outcome'
                            and d.rationale ->> 'outcome' = 'achieved'
                            and d.rationale ->> 'goalRunId' = c.goal_run_id::text
                            and d.rationale ->> 'round' = c.round::text
                            and d.rationale ->> 'checkKey' = c.check_key)
                       when 'fact_predicate' then not ${factIsNamed('c')}
                       -- A kind this check does not know how to vouch for counts until it does.
                       else true
                     end
               order by c.settled_at desc, c.workspace_id, c.goal_run_id, c.round, c.check_key`,
      },
      // S11 GO4b: a step whose plan entry (in the revision that introduced it) declares acceptance
      // checks succeeds only on them — never on its Worker's word.
      {
        label: 'step-succeeded-unverified',
        sql: `with declared as (
                select s.workspace_id, s.id, s.step_key, s.attempt_count, s.updated_at,
                       e -> 'acceptance' as acceptance,
                       (select max(c.round) from step_acceptance_checks c
                         where c.workspace_id = s.workspace_id and c.step_run_id = s.id) as round
                  from step_runs s
                  join plan_revisions intro
                    on intro.workspace_id = s.workspace_id and intro.goal_run_id = s.goal_run_id
                   and intro.revision = s.introduced_in_revision
                 cross join lateral jsonb_array_elements(intro.plan -> 'steps') e
                 where s.status = 'succeeded' and e ->> 'key' = s.step_key
                   and jsonb_typeof(e -> 'acceptance') = 'array'
                   and jsonb_array_length(e -> 'acceptance') > 0
              ),
              latest as (
                select d.workspace_id, d.id, d.step_key, d.attempt_count, d.updated_at, d.round,
                       (select count(*) from step_acceptance_checks c
                         where c.workspace_id = d.workspace_id and c.step_run_id = d.id
                           and c.round = d.round
                           and (c.status <> 'passed' or c.step_attempt <> d.attempt_count))
                         as not_passed,
                       (select count(*) from jsonb_array_elements(d.acceptance) a
                         where not exists (
                           select 1 from step_acceptance_checks c
                            where c.workspace_id = d.workspace_id and c.step_run_id = d.id
                              and c.round = d.round and c.check_key = a ->> 'key')) as missing
                  from declared d
              )
              select workspace_id, id,
                     'step ' || step_key || ' succeeded at attempt ' || attempt_count || ': '
                       || case when round is null then 'no acceptance round'
                               else 'round ' || round || ': ' || not_passed
                                 || ' not passed for that attempt, ' || missing
                                 || ' declared checks missing' end as detail
                from latest
               where round is null or not_passed > 0 or missing > 0
               order by updated_at desc, id desc`,
      },
      {
        label: 'step-passed-without-evidence',
        sql: `select c.workspace_id, c.step_run_id as id,
                     'round ' || c.round || ' check ' || c.check_key || ' (' || c.kind
                       || ') passed without its evidence' as detail
                from step_acceptance_checks c
               where c.status = 'passed'
                 and case c.kind
                       when 'observe_predicate' then not exists (
                         select 1 from observations o
                          where o.workspace_id = c.workspace_id and o.id = c.observation_id
                            and o.content ->> 'purpose' = 'step_acceptance_check'
                            and o.content ->> 'goalRunId' = c.goal_run_id::text
                            and o.content ->> 'stepRunId' = c.step_run_id::text
                            and o.content ->> 'round' = c.round::text
                            and o.content ->> 'checkKey' = c.check_key
                            and o.content ->> 'outcome' = 'satisfied')
                       when 'fact_predicate' then not ${factIsNamed('c')}
                       -- A kind this check does not know how to vouch for counts until it does.
                       else true
                     end
               order by c.settled_at desc, c.workspace_id, c.step_run_id, c.round, c.check_key`,
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
      triggersEnabled('guard', [
        ['action_requests', 'action_requests_status_guard'],
        ['action_requests', 'action_requests_step_run_immutable'],
      ]),
      {
        label: 'not-withdrawn',
        sql: `select ar.workspace_id, ar.id,
                     ar.status || ' while step ' || s.status || ', goal ' || g.status as detail
                from action_requests ar
                join step_runs s on s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
                join goal_runs g on g.workspace_id = s.workspace_id and g.id = s.goal_run_id
               where ar.status in ('pending_approval', 'approved', 'auto_approved')
                 and (s.status = 'cancelled' or g.status in ('cancelling', 'cancelled')
                      or (s.status = 'superseded' and not ${RELEASED_BY_REVISION}))
               order by ar.requested_at desc, ar.id desc`,
      },
      {
        label: 'ran-after-cancel',
        sql: `select ar.workspace_id, ar.id,
                     'executing at ' || ar.executing_at || ', step ' || s.status || ' at ' || s.ended_at as detail
                from action_requests ar
                join step_runs s on s.workspace_id = ar.workspace_id and s.id = ar.step_run_id
               where (s.status = 'cancelled'
                      or (s.status = 'superseded' and not ${RELEASED_BY_REVISION}))
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
      // One condition, two queries, so neither joins the three tables whole: a request that
      // records a step its Worker's Task does not run for (from `action_requests_step_run_idx`),
      // and a request that records none although its Worker's Task runs for a step (from
      // `tasks_goal_run_idx` through `worker_runs_task_idx` and
      // `action_requests_parent_worker_run_idx`).
      {
        label: 'step-mismatch',
        sql: `select ar.workspace_id, ar.id,
                     'request step ' || ar.step_run_id
                       || ', task step ' || coalesce(t.step_run_id::text, 'none') as detail
                from action_requests ar
                left join worker_runs wr
                  on wr.workspace_id = ar.workspace_id and wr.id = ar.parent_worker_run_id
                left join tasks t on t.workspace_id = wr.workspace_id and t.id = wr.task_id
               where ar.step_run_id is not null
                 and t.step_run_id is distinct from ar.step_run_id
               order by ar.requested_at desc, ar.id desc`,
      },
      {
        label: 'step-mismatch',
        sql: `select ar.workspace_id, ar.id,
                     'request step none, task step ' || t.step_run_id as detail
                from tasks t
                join worker_runs wr on wr.workspace_id = t.workspace_id and wr.task_id = t.id
                join action_requests ar
                  on ar.workspace_id = wr.workspace_id and ar.parent_worker_run_id = wr.id
               where t.goal_run_id is not null
                 and ar.step_run_id is null
               order by ar.requested_at desc, ar.id desc`,
      },
    ],
    sampleLimit,
  );
}
