import {
  type ObjectiveOutcome,
  type OutcomeBasis,
  type PublishableStatus,
  REVIEW_STREAK,
  type SkillFailureGroupWire,
  type SkillStatsSegmentWire,
  type SkillStatsWire,
  type SkillUsageWire,
  type SkillVersionStatsWire,
  type TaskRefusal,
  type TaskStatus,
  outcomeBasisTier,
  suggestsReview,
  taskFailureCategory,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type SubjectOutcome, outcomeTallyWire, readSubjectOutcomes } from './stats-read.js';

/**
 * application/task/skill-stats (S11 W1a E2-1; S10 §5.4, docs/global-roadmap-2026-10-16.md W1a E2):
 * `get_skill_stats` — how each version of a Skill family has done, read when asked. No table of its
 * own: every number is counted from the records the work already left, under the rules
 * `packages/shared` `wire/skill-stats.ts` states (usage per run, a Task under the version its last
 * run loaded, each outcome subject once, segments by run environment, 「建议复核」 per segment).
 *
 * The records, and what each one is:
 *   - `worker_run_skills` (worker/0004): a WorkerRun loaded this Skill version — written by the
 *     kernel as it created the run, so authoritative.
 *   - `worker_runs` (task/0001, task/0009): when the run started and its environment fingerprint
 *     (`environment_digest`, `null` when unknown).
 *   - `tasks` (task/0001, 0006, 0007, 0008): status, failure reason, the output contract's refusal,
 *     the entry agent's reported outcome, the generating Turn, the goal step.
 *   - outcomes: a Turn's (`turn_outcomes`, the requester's), a Task's (`tasks.objective_outcome`,
 *     the delegating agent's report), a goal step's acceptance (its checks, `step_runs` and
 *     goal/0006 — only when the step declares some) and a GoalRun's (`goal_runs.outcome` with its
 *     `outcome_basis`).
 *   - `action_requests` (governance/0003, 0021): what refused a failed Task's work.
 *
 * A read-only projection across modules (worker, goal, approval tables beside this module's own),
 * as `attribution.ts` reads Turn outcomes: it writes nothing, so it moves no state those modules own.
 *
 * Every table read here is workspace-isolated only (no per-principal RLS), so the counts cover the
 * whole workspace: the capability is the builders' (builder floor, human channel) and answers
 * numbers only — no Turn, Task, goal or ActionRequest id and no free text leaves this module.
 */

interface UsageRow {
  readonly version: number;
  readonly environment_digest: string | null;
  readonly runs: number;
  readonly last_used_at: Date | null;
}

interface TaskRow {
  readonly id: string;
  readonly version: number;
  readonly environment_digest: string | null;
  readonly status: TaskStatus;
  readonly failure_reason: string | null;
  readonly failed_at: Date | null;
  readonly output_rejected: boolean;
  readonly worker_definition_id: string;
  readonly worker_definition_version: number;
  readonly created_by_activity_id: string | null;
  readonly goal_run_id: string | null;
  readonly step_run_id: string | null;
  readonly objective_outcome: ObjectiveOutcome | null;
  readonly outcome_given_at: Date | null;
}

/** Skill family `skillId`'s statistics, or `null` when the workspace has no such Skill. */
export async function readSkillStats(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<SkillStatsWire | null> {
  const versions = await client.query<{ version: number; status: PublishableStatus; name: string }>(
    `select version, status, name from skills
      where workspace_id = $1 and id = $2
      order by version desc`,
    [workspaceId, skillId],
  );
  const latest = versions.rows[0];
  if (!latest) return null;

  // Usage: every run that loaded a version, by the run's environment. An evaluation Task's run
  // (S10 E3-2a, `tasks.purpose`) is not use: it is judged by its suite (`application/eval`), and
  // its fixture-answered calls are not the workspace's work — so neither here nor below.
  const usage = await client.query<UsageRow>(
    `select w.skill_version as version, r.environment_digest,
            count(*)::int as runs, max(r.started_at) as last_used_at
       from worker_run_skills w
       join worker_runs r on r.workspace_id = w.workspace_id and r.id = w.worker_run_id
       join tasks t on t.workspace_id = r.workspace_id and t.id = r.task_id
      where w.workspace_id = $1 and w.skill_id = $2 and t.purpose is null
      group by w.skill_version, r.environment_digest`,
    [workspaceId, skillId],
  );

  // Task results: a Task whose last run loaded a version of this family counts under that
  // version, in that run's environment. A Task whose last run did not load it (the Skill was
  // deprecated before a requeue) counts under no version.
  const tasks = await client.query<TaskRow>(
    `with candidate as (
       select distinct r.task_id
         from worker_run_skills w
         join worker_runs r on r.workspace_id = w.workspace_id and r.id = w.worker_run_id
         join tasks ct on ct.workspace_id = r.workspace_id and ct.id = r.task_id
        where w.workspace_id = $1 and w.skill_id = $2 and ct.purpose is null
     ), last_run as (
       select distinct on (r.task_id) r.task_id, r.id, r.environment_digest
         from worker_runs r
         join candidate c on c.task_id = r.task_id
        where r.workspace_id = $1
        order by r.task_id, r.started_at desc, r.attempt desc, r.id desc
     )
     select t.id, w.skill_version as version, l.environment_digest, t.status, t.failure_reason,
            t.failed_at, (t.rejected_output is not null) as output_rejected,
            t.worker_definition_id, t.worker_definition_version, t.created_by_activity_id,
            t.goal_run_id, t.step_run_id, t.objective_outcome, t.outcome_given_at
       from last_run l
       join worker_run_skills w
         on w.workspace_id = $1 and w.worker_run_id = l.id and w.skill_id = $2
       join tasks t on t.workspace_id = $1 and t.id = l.task_id`,
    [workspaceId, skillId],
  );

  const subjectsByTask = await readSubjectOutcomes(client, workspaceId, tasks.rows);
  const refusalByTask = await readRefusals(client, workspaceId, tasks.rows);
  const definitionNames = await readDefinitionNames(client, workspaceId, tasks.rows);

  const versionStats: SkillVersionStatsWire[] = versions.rows.map((row) => {
    const runs = usage.rows.filter((u) => u.version === row.version);
    const versionTasks = tasks.rows.filter((task) => task.version === row.version);
    const environments = new Set<string | null>([
      ...runs.map((u) => u.environment_digest),
      ...versionTasks.map((task) => task.environment_digest),
    ]);
    const segments = [...environments]
      .map((environmentDigest): SkillStatsSegmentWire => {
        const segmentTasks = versionTasks.filter(
          (task) => task.environment_digest === environmentDigest,
        );
        const subjects = subjectsOf(segmentTasks, subjectsByTask);
        return {
          environmentDigest,
          usage: usageOf(
            runs.filter((u) => u.environment_digest === environmentDigest),
            segmentTasks,
          ),
          outcomes: outcomeTallyWire(subjects.values()),
          reviewSuggested: suggestsReview(
            [...subjects.values()]
              .filter((subject) => outcomeBasisTier(subject.basis) === 'primary')
              .sort((a, b) => b.at.getTime() - a.at.getTime())
              .map((subject) => subject.outcome),
          ),
        };
      })
      .sort(byLastUsedDesc);
    return {
      version: row.version,
      status: row.status,
      usage: usageOf(runs, versionTasks),
      outcomes: outcomeTallyWire(subjectsOf(versionTasks, subjectsByTask).values()),
      reviewSuggested: segments.some((segment) => segment.reviewSuggested),
      segments,
    };
  });

  return {
    skillId,
    name: latest.name,
    reviewStreak: REVIEW_STREAK,
    versions: versionStats,
    failureGroups: failureGroupsOf(tasks.rows, refusalByTask, definitionNames),
  };
}

function usageOf(runs: readonly UsageRow[], tasks: readonly TaskRow[]): SkillUsageWire {
  let lastUsedAt: Date | null = null;
  for (const run of runs) {
    if (run.last_used_at && (!lastUsedAt || run.last_used_at > lastUsedAt)) {
      lastUsedAt = run.last_used_at;
    }
  }
  const count = (status: TaskStatus) => tasks.filter((task) => task.status === status).length;
  const completed = count('completed');
  const failed = count('failed');
  const cancelled = count('cancelled');
  return {
    runs: runs.reduce((sum, run) => sum + run.runs, 0),
    tasks: {
      completed,
      failed,
      cancelled,
      inProgress: tasks.length - completed - failed - cancelled,
    },
    lastUsedAt: lastUsedAt?.toISOString() ?? null,
  };
}

/** Most recently used first; a segment with no run (cannot happen: a Task's last run is one of its
 *  runs) last. */
function byLastUsedDesc(a: SkillStatsSegmentWire, b: SkillStatsSegmentWire): number {
  const at = (segment: SkillStatsSegmentWire) =>
    segment.usage.lastUsedAt === null ? 0 : Date.parse(segment.usage.lastUsedAt);
  return at(b) - at(a);
}

/** The outcome subjects covering `tasks`, each once — keyed `turn:`, `task:`, `step:`, `goal:`. */
function subjectsOf(
  tasks: readonly TaskRow[],
  subjectsByTask: ReadonlyMap<string, ReadonlyMap<string, SubjectOutcome>>,
): Map<string, SubjectOutcome> {
  const subjects = new Map<string, SubjectOutcome>();
  for (const task of tasks) {
    for (const [key, subject] of subjectsByTask.get(task.id) ?? []) subjects.set(key, subject);
  }
  return subjects;
}

/**
 * What refused each failed Task's work (`TaskRefusal`): its output contract's refusal
 * (`tasks.rejected_output`) first — it ends the Task's run — else the most recently requested
 * ActionRequest its runs (nested children included, as the goal advancer judges an attempt) raised
 * that was rejected, expired, denied, or refused before it ran.
 */
async function readRefusals(
  client: PoolClient,
  workspaceId: string,
  tasks: readonly TaskRow[],
): Promise<Map<string, TaskRefusal>> {
  const refusals = new Map<string, TaskRefusal>();
  const failed = tasks.filter((task) => task.status === 'failed');
  for (const task of failed)
    refusals.set(task.id, task.output_rejected ? 'output_rejected' : 'none');
  const open = failed.filter((task) => !task.output_rejected).map((task) => task.id);
  if (open.length === 0) return refusals;
  const result = await client.query<{ task_id: string; refusal: TaskRefusal }>(
    `with recursive tree as (
       select r.id, r.task_id as root from worker_runs r
        where r.workspace_id = $1 and r.task_id = any($2::uuid[])
       union
       select c.id, tree.root from worker_runs c
         join tree on c.parent_worker_run_id = tree.id
        where c.workspace_id = $1
     )
     select distinct on (tree.root) tree.root as task_id,
            case when a.status = 'failed' then 'refused' else a.status end as refusal
       from tree
       join action_requests a on a.workspace_id = $1 and a.parent_worker_run_id = tree.id
      where a.status in ('rejected', 'expired', 'denied')
         or (a.status = 'failed' and a.failure_kind = 'refused')
      order by tree.root, a.requested_at desc, a.id desc`,
    [workspaceId, open],
  );
  for (const row of result.rows) refusals.set(row.task_id, row.refusal);
  return refusals;
}

async function readDefinitionNames(
  client: PoolClient,
  workspaceId: string,
  tasks: readonly TaskRow[],
): Promise<Map<string, string | null>> {
  const failed = tasks.filter((task) => task.status === 'failed');
  const names = new Map<string, string | null>();
  if (failed.length === 0) return names;
  const result = await client.query<{ id: string; version: number; name: string | null }>(
    `select d.id, d.version, d.definition ->> 'name' as name
       from worker_definitions d
       join unnest($2::uuid[], $3::int[]) as wanted (id, version)
         on wanted.id = d.id and wanted.version = d.version
      where d.workspace_id = $1`,
    [
      workspaceId,
      failed.map((task) => task.worker_definition_id),
      failed.map((task) => task.worker_definition_version),
    ],
  );
  for (const row of result.rows) names.set(`${row.id}@${row.version}`, row.name);
  return names;
}

/** Failed Tasks by Skill version × WorkerDefinition version × failure category × refusal (S10 §5.4
 *  "确定性失败分组"), largest groups first, then the most recent. */
function failureGroupsOf(
  tasks: readonly TaskRow[],
  refusalByTask: ReadonlyMap<string, TaskRefusal>,
  definitionNames: ReadonlyMap<string, string | null>,
): SkillFailureGroupWire[] {
  const groups = new Map<string, SkillFailureGroupWire>();
  for (const task of tasks) {
    if (task.status !== 'failed') continue;
    const category = taskFailureCategory(task.failure_reason);
    const refusal = refusalByTask.get(task.id) ?? 'none';
    const definition = `${task.worker_definition_id}@${task.worker_definition_version}`;
    const key = `${task.version}|${definition}|${category}|${refusal}`;
    const failedAt = task.failed_at?.toISOString() ?? null;
    const group = groups.get(key);
    if (group) {
      groups.set(key, {
        ...group,
        tasks: group.tasks + 1,
        lastFailedAt:
          failedAt !== null && (group.lastFailedAt === null || failedAt > group.lastFailedAt)
            ? failedAt
            : group.lastFailedAt,
      });
    } else {
      groups.set(key, {
        skillVersion: task.version,
        workerDefinition: {
          id: task.worker_definition_id,
          version: task.worker_definition_version,
          name: definitionNames.get(definition) ?? null,
        },
        category,
        refusal,
        tasks: 1,
        lastFailedAt: failedAt,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.tasks - a.tasks ||
      (b.lastFailedAt === null ? 0 : Date.parse(b.lastFailedAt)) -
        (a.lastFailedAt === null ? 0 : Date.parse(a.lastFailedAt)),
  );
}
