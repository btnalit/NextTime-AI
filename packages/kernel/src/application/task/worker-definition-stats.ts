import {
  type ObjectiveOutcome,
  type PublishableStatus,
  REVIEW_STREAK,
  type TaskRefusal,
  type TaskStatus,
  type WorkerDefinitionCombinationWire,
  type WorkerDefinitionFailureGroupWire,
  type WorkerDefinitionSegmentWire,
  type WorkerDefinitionStatsWire,
  type WorkerDefinitionUsageWire,
  type WorkerDefinitionVersionStatsWire,
  type WorkerSpecField,
  WorkerSpecSchema,
  outcomeBasisTier,
  suggestsReview,
  taskFailureCategory,
  workerSpecFieldsOf,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type SubjectOutcome,
  outcomeTallyWire,
  readRefusals,
  readSubjectOutcomes,
  subjectsOf,
} from './stats-read.js';
import { workerSpecDigest } from './step-attempt.js';

/**
 * application/task/worker-definition-stats (S11 GO16a, legacy 569; plan §4.4, W4 GO16):
 * `get_worker_definition_stats` — how each version of a WorkerDefinition family has done, read when
 * asked. No table of its own: every number is counted from the records the work already left,
 * under the rules `packages/shared` `wire/worker-definition-stats.ts` states (a Task under the
 * version it was created with, each outcome subject once, segments by run environment,
 * combinations by WorkerSpec digest, 「建议复核」 per segment and per combination), with the
 * outcome and refusal reads `get_skill_stats` uses (`stats-read.ts`).
 *
 * The records, and what each one is:
 *   - `worker_definitions` (worker/0001): the family's versions; only published and deprecated
 *     ones are counted — a draft never runs, and its proposer alone sees it.
 *   - `tasks` (task/0001, 0006, 0007, 0008, 0011, 0012): the version (`worker_definition_version`,
 *     pinned when the Task was created), status, failure reason, the output contract's refusal,
 *     the delegating agent's reported outcome, the generating Turn, the goal step, and the attempt's
 *     run configuration (`run_config_snapshot`, whose `spec.digest` is the WorkerSpec the attempt
 *     was admitted with — written by the kernel, never changed).
 *   - `worker_runs` (task/0001, task/0009): the Task's runs, when each started and its environment
 *     fingerprint (`environment_digest`, `null` when unknown).
 *   - `plan_revisions` (goal/0001): the plan entry a WorkerSpec came from — read only for the names
 *     of the fields it sets, and only when it still digests to the snapshot's.
 *   - outcomes and `action_requests`: as `get_skill_stats` (`readSubjectOutcomes`, `readRefusals`).
 *
 * A read-only projection across modules (worker, goal, approval tables beside this module's own):
 * it writes nothing, so it moves no state those modules own. Every table read here is
 * workspace-isolated only (no per-principal RLS), so the counts cover the whole workspace: the
 * capability is the builders' (builder floor, human channel) and answers numbers, labels and field
 * names only — no Turn, Task, goal or ActionRequest id and no free text leaves this module. A
 * WorkerSpec's digest leaves it only for a caller who can read a goal the WorkerSpec ran in
 * (`canReadGoal`, the goal reads' own rule, passed in by the gateway — this module never decides
 * goal visibility): the digest is an unsalted hash, and beside the field names it would confirm a
 * guess at a low-entropy setting of a goal the caller cannot read (review #493 on #1064). Anyone
 * else is given a label that tells the combinations apart and is derived from nothing
 * ({@link labelSpecs}).
 */

/** Whether the caller may read a goal — `goalVisibleTo` with the caller's goal viewer, from the
 *  gateway. */
export type CanReadGoal = (goal: { readonly onBehalfOf: string }) => boolean;

interface DefinitionTaskRow {
  readonly id: string;
  readonly version: number;
  readonly status: TaskStatus;
  readonly failure_reason: string | null;
  readonly failed_at: Date | null;
  readonly output_rejected: boolean;
  readonly created_by_activity_id: string | null;
  readonly goal_run_id: string | null;
  readonly step_run_id: string | null;
  readonly objective_outcome: ObjectiveOutcome | null;
  readonly outcome_given_at: Date | null;
  /** The WorkerSpec digest the attempt's run configuration keeps; `null`: the definition as it is. */
  readonly spec_digest: string | null;
  /** The requester of the goal the Task is a step of; `null` when it is none's. */
  readonly goal_on_behalf_of: string | null;
  /** The environment of the Task's last run; meaningless when `has_run` is false. */
  readonly last_environment: string | null;
  readonly has_run: boolean;
}

/** A Task's runs in one environment. */
interface RunRow {
  readonly task_id: string;
  readonly environment_digest: string | null;
  readonly runs: number;
  readonly last_started_at: Date;
}

/** WorkerDefinition family `definitionId`'s statistics as `viewer` reads them, or `null` when the
 *  workspace has no such family or none of its versions is published or deprecated. */
export async function readWorkerDefinitionStats(
  client: PoolClient,
  workspaceId: string,
  definitionId: string,
  viewer: { readonly canReadGoal: CanReadGoal },
): Promise<WorkerDefinitionStatsWire | null> {
  const versions = await client.query<{
    version: number;
    status: PublishableStatus;
    name: string | null;
  }>(
    `select version, status, definition ->> 'name' as name from worker_definitions
      where workspace_id = $1 and id = $2 and status in ('published', 'deprecated')
      order by version desc`,
    [workspaceId, definitionId],
  );
  const latest = versions.rows[0];
  if (!latest) return null;

  // The family's Tasks of ordinary work: an evaluation's Task (S10 E3-2a) is judged by its suite,
  // and the goal planner's (`planning`) is planning, not this Worker's work — as `get_skill_stats`.
  const tasks = await client.query<DefinitionTaskRow>(
    `select t.id, t.worker_definition_version as version, t.status, t.failure_reason, t.failed_at,
            (t.rejected_output is not null) as output_rejected, t.created_by_activity_id,
            t.goal_run_id, t.step_run_id, t.objective_outcome, t.outcome_given_at,
            t.run_config_snapshot -> 'spec' ->> 'digest' as spec_digest,
            g.on_behalf_of as goal_on_behalf_of,
            last_run.environment_digest as last_environment,
            (last_run.id is not null) as has_run
       from tasks t
       left join goal_runs g on g.workspace_id = t.workspace_id and g.id = t.goal_run_id
       left join lateral (
         select r.id, r.environment_digest from worker_runs r
          where r.workspace_id = t.workspace_id and r.task_id = t.id
          order by r.started_at desc, r.attempt desc, r.id desc
          limit 1
       ) last_run on true
      where t.workspace_id = $1 and t.worker_definition_id = $2
        and t.worker_definition_version = any($3::int[]) and t.purpose is null`,
    [workspaceId, definitionId, versions.rows.map((row) => row.version)],
  );
  const taskIds = tasks.rows.map((task) => task.id);
  const runs =
    taskIds.length === 0
      ? []
      : (
          await client.query<RunRow>(
            `select r.task_id, r.environment_digest, count(*)::int as runs,
                    max(r.started_at) as last_started_at
               from worker_runs r
              where r.workspace_id = $1 and r.task_id = any($2::uuid[])
              group by r.task_id, r.environment_digest`,
            [workspaceId, taskIds],
          )
        ).rows;

  const subjectsByTask = await readSubjectOutcomes(client, workspaceId, tasks.rows);
  const refusalByTask = await readRefusals(client, workspaceId, tasks.rows);
  const fieldsByDigest = await readSpecFields(client, workspaceId, tasks.rows);

  const versionStats = versions.rows.map((row): WorkerDefinitionVersionStatsWire => {
    const versionTasks = tasks.rows.filter((task) => task.version === row.version);
    const versionTaskIds = new Set(versionTasks.map((task) => task.id));
    const versionRuns = runs.filter((run) => versionTaskIds.has(run.task_id));

    const segments = [...new Set(versionRuns.map((run) => run.environment_digest))]
      .map((environmentDigest): WorkerDefinitionSegmentWire => {
        const segmentTasks = versionTasks.filter(
          (task) => task.has_run && task.last_environment === environmentDigest,
        );
        return {
          environmentDigest,
          usage: usageOf(
            segmentTasks,
            versionRuns.filter((run) => run.environment_digest === environmentDigest),
          ),
          ...judged(segmentTasks, subjectsByTask),
        };
      })
      .sort(byLastUsedDesc);

    const combinations = [...new Set(versionTasks.map((task) => task.spec_digest))]
      .map((specDigest): WorkerDefinitionCombinationWire => {
        const combinationTasks = versionTasks.filter((task) => task.spec_digest === specDigest);
        const combinationTaskIds = new Set(combinationTasks.map((task) => task.id));
        return {
          // Labelled below, once every slice is in its order.
          specRef: null,
          specDigest,
          fields: specDigest === null ? [] : (fieldsByDigest.get(specDigest) ?? null),
          usage: usageOf(
            combinationTasks,
            versionRuns.filter((run) => combinationTaskIds.has(run.task_id)),
          ),
          ...judged(combinationTasks, subjectsByTask),
        };
      })
      .sort(byLastUsedDesc);

    return {
      version: row.version,
      status: row.status,
      usage: usageOf(versionTasks, versionRuns),
      outcomes: outcomeTallyWire(subjectsOf(versionTasks, subjectsByTask).values()),
      reviewSuggested:
        segments.some((segment) => segment.reviewSuggested) ||
        combinations.some((combination) => combination.reviewSuggested),
      segments,
      combinations,
    };
  });

  const label = labelSpecs(readableDigests(tasks.rows, viewer.canReadGoal));
  const labelled = <T extends { readonly specDigest: string | null }>(slice: T): T => ({
    ...slice,
    ...label(slice.specDigest),
  });
  const versionsLabelled = versionStats.map((version) => ({
    ...version,
    combinations: version.combinations.map(labelled),
  }));
  return {
    definitionId,
    name: latest.name,
    reviewStreak: REVIEW_STREAK,
    versions: versionsLabelled,
    failureGroups: failureGroupsOf(tasks.rows, refusalByTask).map(labelled),
  };
}

/** The WorkerSpec digests that ran in a goal the caller can read. */
function readableDigests(
  tasks: readonly DefinitionTaskRow[],
  canReadGoal: CanReadGoal,
): ReadonlySet<string> {
  const readable = new Set<string>();
  for (const task of tasks) {
    if (task.spec_digest === null || task.goal_on_behalf_of === null) continue;
    if (readable.has(task.spec_digest)) continue;
    if (canReadGoal({ onBehalfOf: task.goal_on_behalf_of })) readable.add(task.spec_digest);
  }
  return readable;
}

/**
 * What a slice says of its WorkerSpec (`SpecRefSchema`), called in the order the slices are
 * sent: the definition as it is, no label; a digest the caller may be given, the digest and its
 * first 12 hex digits; any other, no digest and `#n` — numbered in order of first call, the same
 * number for the same digest.
 */
export function labelSpecs(
  readable: ReadonlySet<string>,
): (digest: string | null) => { specRef: string | null; specDigest: string | null } {
  const numbers = new Map<string, string>();
  return (digest) => {
    if (digest === null) return { specRef: null, specDigest: null };
    if (readable.has(digest)) return { specRef: digest.slice(0, 12), specDigest: digest };
    let ref = numbers.get(digest);
    if (ref === undefined) {
      ref = `#${numbers.size + 1}`;
      numbers.set(digest, ref);
    }
    return { specRef: ref, specDigest: null };
  };
}

function usageOf(
  tasks: readonly DefinitionTaskRow[],
  runs: readonly RunRow[],
): WorkerDefinitionUsageWire {
  let lastUsedAt: Date | null = null;
  for (const run of runs) {
    if (!lastUsedAt || run.last_started_at > lastUsedAt) lastUsedAt = run.last_started_at;
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

/** A slice's outcomes, and whether its latest `REVIEW_STREAK` primary outcomes were all missed. */
function judged(
  tasks: readonly DefinitionTaskRow[],
  subjectsByTask: ReadonlyMap<string, ReadonlyMap<string, SubjectOutcome>>,
): Pick<WorkerDefinitionSegmentWire, 'outcomes' | 'reviewSuggested'> {
  const subjects = [...subjectsOf(tasks, subjectsByTask).values()];
  return {
    outcomes: outcomeTallyWire(subjects),
    reviewSuggested: suggestsReview(
      subjects
        .filter((subject) => outcomeBasisTier(subject.basis) === 'primary')
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .map((subject) => subject.outcome),
    ),
  };
}

/** Most recently used first; a slice with no run yet last. */
function byLastUsedDesc(
  a: { readonly usage: WorkerDefinitionUsageWire },
  b: { readonly usage: WorkerDefinitionUsageWire },
): number {
  const at = (slice: { readonly usage: WorkerDefinitionUsageWire }) =>
    slice.usage.lastUsedAt === null ? 0 : Date.parse(slice.usage.lastUsedAt);
  return at(b) - at(a);
}

/**
 * Per WorkerSpec digest, the names of the fields it sets — read from the plan entry the latest
 * attempt with that digest was created from (the step's entry in the Task's plan revision), and
 * kept only when that entry still parses and digests to the snapshot's digest. Otherwise `null`:
 * what the WorkerSpec set is not guessed.
 */
async function readSpecFields(
  client: PoolClient,
  workspaceId: string,
  tasks: readonly DefinitionTaskRow[],
): Promise<Map<string, WorkerSpecField[] | null>> {
  const fields = new Map<string, WorkerSpecField[] | null>();
  const withSpec = tasks.filter((task) => task.spec_digest !== null).map((task) => task.id);
  if (withSpec.length === 0) return fields;
  const result = await client.query<{ digest: string; spec: unknown }>(
    `select distinct on (digest) digest, spec
       from (
         select t.run_config_snapshot -> 'spec' ->> 'digest' as digest, t.created_at, t.id,
                jsonb_path_query_first(p.plan, '$.steps[*] ? (@.key == $key).spec',
                                       jsonb_build_object('key', s.step_key)) as spec
           from tasks t
           join step_runs s on s.workspace_id = t.workspace_id and s.id = t.step_run_id
           join plan_revisions p
             on p.workspace_id = t.workspace_id and p.goal_run_id = t.goal_run_id
            and p.revision = t.plan_revision
          where t.workspace_id = $1 and t.id = any($2::uuid[])
       ) entry
      order by digest, created_at desc, id desc`,
    [workspaceId, withSpec],
  );
  for (const row of result.rows) {
    const parsed = WorkerSpecSchema.safeParse(row.spec);
    fields.set(
      row.digest,
      parsed.success && workerSpecDigest(parsed.data) === row.digest
        ? workerSpecFieldsOf(parsed.data)
        : null,
    );
  }
  return fields;
}

/** Failed Tasks by version × combination × failure category × refusal (S10 §5.4 "确定性失败分组"),
 *  largest groups first, then the most recent. */
function failureGroupsOf(
  tasks: readonly DefinitionTaskRow[],
  refusalByTask: ReadonlyMap<string, TaskRefusal>,
): WorkerDefinitionFailureGroupWire[] {
  const groups = new Map<string, WorkerDefinitionFailureGroupWire>();
  for (const task of tasks) {
    if (task.status !== 'failed') continue;
    const category = taskFailureCategory(task.failure_reason);
    const refusal = refusalByTask.get(task.id) ?? 'none';
    const key = `${task.version}|${task.spec_digest ?? ''}|${category}|${refusal}`;
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
        definitionVersion: task.version,
        // Labelled by the caller, once the groups are in their order.
        specRef: null,
        specDigest: task.spec_digest,
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
