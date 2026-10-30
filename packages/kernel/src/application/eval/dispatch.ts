import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  type PreparedStepAttempt,
  QuotaExceededError,
  type ResolvedRunSkills,
  createEvaluationTask,
  getConfiguredTaskRuntime,
  startStepAttemptTask,
} from '../task/index.js';
import { readSkillVersions, renderSkillMarkdownFile } from '../worker/index.js';
import { EVALUATION_PRINCIPAL_DISPLAY_NAME } from './principal.js';

/**
 * application/eval/dispatch: starts a draft evaluation's queued trials (S10 E3-2b). A stage's run
 * is written whole when the stage starts — every trial `queued` (worker/0010) — and its trials'
 * Tasks are started here, as many as the evaluation Principal's concurrency quota lets run at once
 * (I18: `createEvaluationTask` refuses `QuotaExceededError` at the limit, and the rest wait for a
 * later tick). Run by the trial tick (`runner.ts`) after it scores what ended, and right after a
 * start commits, for that workspace.
 *
 * Order: oldest run first, then try by try, case by case in the run's order, the two arms of a case
 * one after the other — so a stage cut short (cancelled) has tried its cases evenly in both arms.
 *
 * One transaction per trial, acting as the evaluation Principal: the trial is held (`for update
 * skip locked`, so two kernels start it once), its Task created (`createEvaluationTask` with the
 * arm's Skills: the evaluation's pinned other Skills, with the baseline version or with the draft
 * as the evaluation kept it) and the trial marked `running` with it; the Task is started after
 * that commits (`startStepAttemptTask`: spawn, then `running`; a failed start fails the Task and
 * the tick records the trial `errored`).
 */

/** How many trials one tick starts in a workspace at most. */
const DEFAULT_DISPATCH_BATCH = 20;

export interface DispatchOptions {
  /** Only this workspace (after a start). */
  readonly workspaceId?: string;
  readonly limit?: number;
  readonly onError?: (error: unknown, workspaceId: string) => void;
}

/** Workspaces with a queued trial of a running evaluation, and their evaluation Principal — not
 *  one whose evaluation Principal the evaluation seal has paused (S10 E3-2c): its trials wait,
 *  queued, until the workspace owner releases the pause. */
async function listQueuedWorkspaces(
  pool: PoolLike,
  workspaceId: string | undefined,
): Promise<ReadonlyArray<{ readonly workspaceId: string; readonly principalId: string }>> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ workspace_id: string; principal_id: string | null }>(
      `select w.workspace_id, w.principal_id
         from (select q.workspace_id,
                      (select p.id from principals p
                        where p.workspace_id = q.workspace_id and p.kind = 'service'
                          and p.display_name = $2
                        order by p.created_at limit 1) as principal_id
                 from (select distinct tr.workspace_id
                         from eval_trials tr
                        where tr.status = 'queued'
                          and ($1::uuid is null or tr.workspace_id = $1)) q) w
        where not exists (
          select 1 from eval_seal_holds h
           where h.workspace_id = w.workspace_id and h.principal_id = w.principal_id
             and h.status = 'active')`,
      [workspaceId ?? null, EVALUATION_PRINCIPAL_DISPLAY_NAME],
    );
    return result.rows
      .filter((row) => row.principal_id !== null)
      .map((row) => ({ workspaceId: row.workspace_id, principalId: row.principal_id as string }));
  } finally {
    client.release();
  }
}

/** Starts queued trials. Returns how many it started. */
export async function dispatchEvalTrials(
  pool: PoolLike,
  options: DispatchOptions = {},
): Promise<number> {
  const workspaces = await listQueuedWorkspaces(pool, options.workspaceId);
  let started = 0;
  for (const { workspaceId, principalId } of workspaces) {
    const limit = options.limit ?? DEFAULT_DISPATCH_BATCH;
    for (let i = 0; i < limit; i += 1) {
      let prepared: PreparedStepAttempt | null;
      try {
        prepared = await withWorkspace(pool, { workspaceId, principalId }, (client) =>
          startQueuedTrial(client, workspaceId, principalId),
        );
      } catch (err) {
        // At the evaluation Principal's limit (or the workspace's daily cost budget): the rest
        // wait for a later tick.
        if (!(err instanceof QuotaExceededError)) options.onError?.(err, workspaceId);
        break;
      }
      if (prepared === null) break;
      started += 1;
      try {
        await startStepAttemptTask(getConfiguredTaskRuntime(), workspaceId, prepared);
      } catch (err) {
        options.onError?.(err, workspaceId);
      }
    }
  }
  return started;
}

interface QueuedTrialRow {
  readonly id: string;
  readonly arm: 'baseline' | 'candidate';
  readonly case_id: string;
  readonly suite_id: string;
  readonly suite_version: number;
  readonly worker_definition_id: string;
  readonly worker_definition_version: number;
  readonly other_skills: Array<{ skillId: string; version: number }>;
  readonly skill_id: string;
  readonly baseline_version: number | null;
  readonly candidate_name: string;
  readonly candidate_description: string;
  readonly candidate_markdown: string;
}

/** The next queued trial, its Task created and the trial `running` — or `null` when none waits. */
async function startQueuedTrial(
  client: PoolClient,
  workspaceId: string,
  evaluationPrincipalId: string,
): Promise<PreparedStepAttempt | null> {
  const queued = await client.query<QueuedTrialRow>(
    `select tr.id, tr.arm, tr.case_id, r.suite_id, r.suite_version, r.worker_definition_id,
            r.worker_definition_version, e.other_skills, e.skill_id, e.baseline_version,
            e.candidate_name, e.candidate_description, e.candidate_markdown
       from eval_trials tr
       join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
       join eval_draft_evaluations e
         on e.workspace_id = r.workspace_id and e.id = r.draft_evaluation_id
      where tr.workspace_id = $1 and tr.status = 'queued' and e.status = 'running'
      order by r.created_at, r.id, tr.rep, array_position(r.case_ids, tr.case_id), tr.arm
      limit 1
      for update of tr skip locked`,
    [workspaceId],
  );
  const trial = queued.rows[0];
  if (!trial) return null;

  const cases = await client.query<{ input: unknown }>(
    'select input from eval_cases where workspace_id = $1 and id = $2',
    [workspaceId, trial.case_id],
  );
  // The suite's fixture gates as of the version the evaluation runs.
  const gates = await client.query<{ gatekeeper_id: string }>(
    `select gatekeeper_id from eval_fixture_gates
      where workspace_id = $1 and suite_id = $2 and added_in_version <= $3
        and (retired_in_version is null or retired_in_version > $3)`,
    [workspaceId, trial.suite_id, trial.suite_version],
  );
  const created = await createEvaluationTask(client, workspaceId, {
    evaluationPrincipalId,
    definition: { id: trial.worker_definition_id, version: trial.worker_definition_version },
    input: cases.rows[0]?.input,
    fixtureGateIds: gates.rows.map((row) => row.gatekeeper_id),
    skills: await armSkills(client, workspaceId, trial),
    acceptDeprecated: true,
  });
  if (created.kind === 'definition_unavailable') {
    throw new Error(
      `eval dispatch: WorkerDefinition ${trial.worker_definition_id}@${trial.worker_definition_version} of trial ${trial.id} is not there to run`,
    );
  }
  await client.query(
    `update eval_trials set status = 'running', task_id = $3, started_at = now()
      where workspace_id = $1 and id = $2 and status = 'queued'`,
    [workspaceId, trial.id, created.prepared.task.id],
  );
  return created.prepared;
}

/** What an arm mounts: the pinned other Skills, then the baseline version (none for a new Skill)
 *  or the draft as the evaluation kept it. */
async function armSkills(
  client: PoolClient,
  workspaceId: string,
  trial: QueuedTrialRow,
): Promise<ResolvedRunSkills> {
  const refs = [...trial.other_skills];
  if (trial.arm === 'baseline' && trial.baseline_version !== null) {
    refs.push({ skillId: trial.skill_id, version: trial.baseline_version });
  }
  const rows = await readSkillVersions(client, workspaceId, refs);
  const byRef = new Map(rows.map((row) => [`${row.id}@${row.version}`, row] as const));
  const mounted = refs
    .map((ref) => byRef.get(`${ref.skillId}@${ref.version}`))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  const skillsInline = mounted.map((skill) => ({
    name: skill.name,
    files: { 'SKILL.md': renderSkillMarkdownFile(skill) },
  }));
  if (trial.arm === 'candidate') {
    const draft = {
      name: trial.candidate_name,
      description: trial.candidate_description,
      markdown: trial.candidate_markdown,
    };
    skillsInline.push({ name: draft.name, files: { 'SKILL.md': renderSkillMarkdownFile(draft) } });
  }
  return {
    skillsInline,
    // The draft is not a row a run may name (`worker_run_skills` keys published rows).
    loadedSkills: mounted.map((skill) => ({ skillId: skill.id, version: skill.version })),
  };
}
