import {
  DRAFT_EVALUATION_STAGE_VALUES,
  type DraftEvaluationArmTallyWire,
  type DraftEvaluationEnvironmentWire,
  type DraftEvaluationReason,
  type DraftEvaluationSkip,
  type DraftEvaluationStageName,
  type DraftEvaluationStageWire,
  type DraftEvaluationSummaryWire,
  type DraftEvaluationVerdict,
  type DraftEvaluationWire,
  type EvalArm,
  type EvalCaseSplit,
  type Role,
  draftEvaluationStageK,
  draftEvaluationStageTrials,
  trialVoided,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type PoolLike, withWorkspace } from '../../adapters/db/pool.js';
import {
  ReviewedDraftChangedError,
  ReviewedVersionChangedError,
  seesEveryDraft,
} from '../../governance/capability/index.js';
import { shownFreeText } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { normalizeSealText } from '../eval-seal/index.js';
import {
  type RunEnvironment,
  getConfiguredTaskRuntime,
  readDefinitionContent,
  readRunEnvironment,
  terminateTask,
} from '../task/index.js';
import {
  DraftEvaluatingError,
  SkillNotFoundError,
  getWorkerDefinition,
  readSkillVersions,
  resolvePublishedSkills,
  skillDraftDigest,
} from '../worker/index.js';
import { type EvalBudget, readEvalBudget } from './budget.js';
import { dispatchEvalTrials } from './dispatch.js';
import { checkSkillDraft } from './draft-check.js';
import {
  DraftCheckFailedError,
  DraftEvaluationEndedError,
  DraftEvaluationNotFoundError,
  EvalSkillNotADraftError,
  EvalSuiteNotFoundError,
  EvalSuiteStateError,
  EvaluationBudgetExhaustedError,
  EvaluationBudgetInsufficientError,
} from './errors.js';
import { getOrCreateEvaluationPrincipal } from './principal.js';
import { type VerdictTrial, measureStage, stageOutcome } from './verdict.js';

/**
 * application/eval/draft-evaluations: a Skill draft evaluated against what it would replace (S10
 * E3-2b; docs/s10-evolution-plan-2026-10-04.md §3.2, §3.4 草稿的评测子状态, §5.5 四级漏斗, §5.6 —
 * `@nexttime/shared` wire/eval.ts `DraftEvaluationWire` says what one is, draft-evaluation.ts holds
 * its rules). Table `eval_draft_evaluations` (migrations/worker/0010, whose guards hold what
 * changes and when); each stage is a `draft` EvalRun of both arms whose trials are queued when the
 * stage starts and started by `dispatch.ts`.
 *
 *   - Starting (`startDraftEvaluation`, the caller's one transaction): the suite (held `for share`)
 *     at the version the person looked at, the draft (held `for share`, so no discard or expiry
 *     passes it) as they read it (`draftDigest`), the check it passes first (`draft-check.ts`),
 *     what it is compared to — the family's published version, and the other Skills the
 *     WorkerDefinition loads, pinned now — and the case rows each stage runs, fixed now. The first
 *     stage with cases starts if the month's evaluation budget covers its estimate; otherwise
 *     nothing is written.
 *   - Settling (`settleDraftStage`, the trial tick's transaction that finished a stage's run):
 *     `verdict.ts` reads the stage; an outcome ends the evaluation, a pass starts the next stage
 *     with cases — or ends it `inconclusive` when the budget cannot cover that stage. Never part
 *     way through a stage.
 *   - Cancelling (`cancelDraftEvaluation`): its queued trials end `cancelled`, it ends `cancelled`;
 *     the caller terminates the running trials' Tasks after the commit.
 *
 * Who sees one: whoever may see its draft (the proposer; the owner and builders see every draft,
 * D-26) — or anyone, once that draft was published as it was evaluated. A draft run's trials are
 * read the same way (`runs.ts`).
 */

const STAGES = DRAFT_EVALUATION_STAGE_VALUES;

/** Who reads or changes an evaluation: a person (the registry makes these capabilities theirs). */
export interface DraftEvaluationActor {
  readonly principalId: string;
  readonly role: Role;
}

export interface DraftEvaluationTarget {
  readonly skillId: string;
  readonly version: number;
  readonly draftDigest: string;
  readonly suiteId: string;
  readonly suiteVersion: number;
  readonly mechanism?: string;
}

interface StageNote {
  readonly skip: DraftEvaluationSkip | null;
  readonly estimateUsd: number | null;
}

type StageNotes = Partial<Record<DraftEvaluationStageName, StageNote>>;

interface EvaluationRow {
  readonly id: string;
  readonly suite_id: string;
  readonly suite_version: number;
  readonly suite_name: string;
  readonly canary: string;
  readonly worker_definition_id: string;
  readonly worker_definition_version: number;
  readonly skill_id: string;
  readonly skill_version: number;
  readonly draft_digest: string;
  readonly candidate_proposed_by: string;
  readonly candidate_name: string;
  readonly candidate_description: string;
  readonly candidate_markdown: string;
  readonly baseline_version: number | null;
  readonly baseline_name: string | null;
  readonly other_skills: Array<{ skillId: string; version: number }>;
  readonly mechanism: string | null;
  readonly regression_case_ids: string[];
  readonly mechanism_case_ids: string[];
  readonly confirm_case_ids: string[];
  readonly status: 'running' | 'finished' | 'cancelled';
  readonly stage: DraftEvaluationStageName | null;
  readonly verdict: DraftEvaluationVerdict | null;
  readonly reason: DraftEvaluationReason | null;
  readonly decided_by: DraftEvaluationStageName | null;
  readonly stage_notes: StageNotes;
  readonly created_by: string;
  readonly created_at: Date;
  readonly finished_at: Date | null;
  readonly cancelled_by: string | null;
}

const EVALUATION_COLUMNS = `e.id, e.suite_id, e.suite_version, s.name as suite_name, s.canary,
  e.worker_definition_id, e.worker_definition_version, e.skill_id, e.skill_version, e.draft_digest,
  e.candidate_proposed_by, e.candidate_name, e.candidate_description, e.candidate_markdown,
  e.baseline_version, b.name as baseline_name, e.other_skills, e.mechanism, e.regression_case_ids,
  e.mechanism_case_ids, e.confirm_case_ids, e.status, e.stage, e.verdict, e.reason, e.decided_by,
  e.stage_notes, e.created_by, e.created_at, e.finished_at, e.cancelled_by`;

const EVALUATION_FROM = `eval_draft_evaluations e
  join eval_suites s on s.workspace_id = e.workspace_id and s.id = e.suite_id
  left join skills b on b.workspace_id = e.workspace_id and b.id = e.skill_id
    and b.version = e.baseline_version`;

/** Whether `$viewer` (with `$seesAll` = may see every draft) may see the evaluation `e`: they see
 *  every draft, proposed this one, or this draft was since published — the published row says what
 *  the evaluation kept, since a discarded draft's version is taken again by the family's next
 *  proposal, and the version alone would show a draft nobody published. */
const VISIBLE_TO = (seesAll: string, viewer: string) => `(${seesAll}::boolean
  or e.candidate_proposed_by = ${viewer}::uuid
  or exists (select 1 from skills v
              where v.workspace_id = e.workspace_id and v.id = e.skill_id
                and v.version = e.skill_version and v.status in ('published', 'deprecated')
                and v.proposed_by = e.candidate_proposed_by and v.name = e.candidate_name
                and v.description = e.candidate_description
                and v.markdown = e.candidate_markdown))`;

function stageCaseIds(row: EvaluationRow, stage: DraftEvaluationStageName): readonly string[] {
  if (stage === 'regression') return row.regression_case_ids;
  if (stage === 'mechanism') return row.mechanism_case_ids;
  return row.confirm_case_ids;
}

async function readEvaluationRow(
  client: PoolClient,
  workspaceId: string,
  evaluationId: string,
  lock: boolean,
): Promise<EvaluationRow | null> {
  const result = await client.query<EvaluationRow>(
    `select ${EVALUATION_COLUMNS} from ${EVALUATION_FROM}
      where e.workspace_id = $1 and e.id = $2${lock ? ' for update of e' : ''}`,
    [workspaceId, evaluationId],
  );
  return result.rows[0] ?? null;
}

/** Whether `viewer` may see the evaluation `row` ({@link VISIBLE_TO}). */
async function visibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  row: EvaluationRow,
): Promise<boolean> {
  if (seesEveryDraft(viewer.role) || row.candidate_proposed_by === viewer.principalId) return true;
  const visible = await client.query(
    `select 1 from eval_draft_evaluations e
      where e.workspace_id = $1 and e.id = $2 and ${VISIBLE_TO('false', '$3')}`,
    [workspaceId, row.id, viewer.principalId],
  );
  return (visible.rowCount ?? 0) > 0;
}

/** Whether `viewer` may see draft evaluation `evaluationId` (a draft run's trials, `runs.ts`). */
export async function draftEvaluationVisibleTo(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  evaluationId: string,
): Promise<boolean> {
  const row = await readEvaluationRow(client, workspaceId, evaluationId, false);
  return row !== null && (await visibleTo(client, workspaceId, viewer, row));
}

// ----- the stage plan --------------------------------------------------------------------------

type StagePlan =
  | {
      readonly kind: 'run';
      readonly stage: DraftEvaluationStageName;
      readonly caseIds: readonly string[];
      readonly k: number;
      readonly estimateUsd: number | null;
      readonly notes: StageNotes;
    }
  | {
      readonly kind: 'end';
      readonly reason: 'budget' | 'no_confirm_cases';
      readonly decidedBy: DraftEvaluationStageName;
      readonly estimateUsd: number | null;
      readonly notes: StageNotes;
    };

/** What a stage's trials would cost: its trials × the recent cost of a trial; `null` while no
 *  trial's cost is known. */
function estimateStage(
  stage: DraftEvaluationStageName,
  caseCount: number,
  budget: EvalBudget,
): number | null {
  return budget.trialCostUsd === null
    ? null
    : draftEvaluationStageTrials(stage, caseCount) * budget.trialCostUsd;
}

/** Whether the month's evaluation budget covers `estimateUsd` now, after what is spent and what
 *  the trials not ended yet — this and every other evaluation's — are expected to cost (#833
 *  review: two evaluations started one after the other must not both count on the same money). An
 *  unknown estimate is let through while anything is left: a trial's cost is learned from the
 *  first priced ones. */
function budgetCovers(budget: EvalBudget, estimateUsd: number | null): boolean {
  if (budget.spentUsd >= budget.monthlyBudgetUsd) return false;
  return (
    estimateUsd === null ||
    budget.spentUsd + budget.committedUsd + estimateUsd <= budget.monthlyBudgetUsd + 1e-9
  );
}

/**
 * The stage to run from `fromIndex` on: stages without cases (or, the mechanism stage, without a
 * mechanism) are skipped; the first with cases runs when the budget covers it, and ends the
 * evaluation (`budget`) when it does not. Past the last stage with none run — confirm skipped —
 * the evaluation ends `no_confirm_cases`.
 */
function planFrom(
  subject: {
    readonly mechanism: string | null;
    readonly caseIds: (stage: DraftEvaluationStageName) => readonly string[];
  },
  fromIndex: number,
  budget: EvalBudget,
): StagePlan {
  const notes: Record<string, StageNote> = {};
  for (let index = fromIndex; index < STAGES.length; index += 1) {
    const stage = STAGES[index] as DraftEvaluationStageName;
    const caseIds = subject.caseIds(stage);
    if (stage === 'mechanism' && subject.mechanism === null) {
      notes[stage] = { skip: 'no_mechanism', estimateUsd: null };
      continue;
    }
    if (caseIds.length === 0) {
      notes[stage] = { skip: 'no_cases', estimateUsd: null };
      continue;
    }
    const estimateUsd = estimateStage(stage, caseIds.length, budget);
    if (!budgetCovers(budget, estimateUsd)) {
      notes[stage] = { skip: 'budget', estimateUsd };
      return { kind: 'end', reason: 'budget', decidedBy: stage, estimateUsd, notes };
    }
    notes[stage] = { skip: null, estimateUsd };
    return {
      kind: 'run',
      stage,
      caseIds,
      k: draftEvaluationStageK(stage, caseIds.length),
      estimateUsd,
      notes,
    };
  }
  return {
    kind: 'end',
    reason: 'no_confirm_cases',
    decidedBy: 'confirm',
    estimateUsd: null,
    notes,
  };
}

/** Writes a stage's run and its trials, all `queued`. */
async function startStageRun(
  client: PoolClient,
  workspaceId: string,
  evaluation: {
    readonly id: string;
    readonly suiteId: string;
    readonly suiteVersion: number;
    readonly workerDefinitionId: string;
    readonly workerDefinitionVersion: number;
    readonly createdBy: string;
  },
  plan: Extract<StagePlan, { kind: 'run' }>,
): Promise<string> {
  const runs = await client.query<{ id: string }>(
    `insert into eval_runs (
       workspace_id, suite_id, suite_version, kind, worker_definition_id,
       worker_definition_version, arms, case_ids, k, created_by, draft_evaluation_id, stage
     ) values ($1, $2, $3, 'draft', $4, $5, array['baseline', 'candidate'], $6::uuid[], $7, $8, $9, $10)
     returning id`,
    [
      workspaceId,
      evaluation.suiteId,
      evaluation.suiteVersion,
      evaluation.workerDefinitionId,
      evaluation.workerDefinitionVersion,
      plan.caseIds,
      plan.k,
      evaluation.createdBy,
      evaluation.id,
      plan.stage,
    ],
  );
  const runId = runs.rows[0]?.id;
  if (!runId) throw new Error('startStageRun: eval_runs INSERT ... RETURNING produced no row');
  await client.query(
    `insert into eval_trials (workspace_id, run_id, arm, case_id, rep, status, started_at)
     select $1, $2, arm, case_id, rep, 'queued', null
       from unnest($3::uuid[]) as c(case_id)
       cross join generate_series(1, $4::int) as rep
       cross join unnest(array['baseline', 'candidate']) as arm`,
    [workspaceId, runId, plan.caseIds, plan.k],
  );
  return runId;
}

// ----- start -----------------------------------------------------------------------------------

/** The audit payload of a start: what was compared and what the first stage holds — the check's
 *  outcome is the refusal's own. */
export interface StartedDraftEvaluation {
  readonly evaluation: DraftEvaluationWire;
  readonly audit: Record<string, unknown>;
}

/**
 * Starts a draft evaluation (see the module comment). Refused, with nothing written: the suite or
 * the draft not there, or a draft the actor may not see (404); the suite at another version (409
 * version_changed); a published or deprecated version (409 not_a_draft); a draft changed since it
 * was read (409 draft_changed); one already being evaluated (409 draft_evaluating); the pinned
 * WorkerDefinition version no longer published, a mechanism no live case names, no stage with a
 * case, or a draft named like another Skill the arms load (409 conflict); the check failed (400
 * draft_check_failed); the budget spent (429 evaluation_budget_exhausted) or short of the first
 * stage's estimate (429 evaluation_budget_insufficient).
 */
export async function startDraftEvaluation(
  client: PoolClient,
  workspaceId: string,
  actor: DraftEvaluationActor,
  target: DraftEvaluationTarget,
): Promise<StartedDraftEvaluation> {
  getConfiguredTaskRuntime();
  const action = 'start_draft_evaluation';
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
      action,
      `evaluation suite "${shownFreeText(suite.name)}"`,
      target.suiteVersion,
      suite.version,
    );
  }

  // The draft, held so no discard, rejection or expiry passes it before the evaluation is written.
  await client.query(
    'select 1 from skills where workspace_id = $1 and id = $2 and version = $3 for share',
    [workspaceId, target.skillId, target.version],
  );
  const [draft] = await readSkillVersions(client, workspaceId, [
    { skillId: target.skillId, version: target.version },
  ]);
  if (
    !draft ||
    (draft.status === 'draft' &&
      !seesEveryDraft(actor.role) &&
      draft.proposedBy !== actor.principalId)
  ) {
    throw new SkillNotFoundError(workspaceId, target.skillId);
  }
  if (draft.status !== 'draft') {
    throw new EvalSkillNotADraftError(target.skillId, target.version, draft.status);
  }
  const subject = `Skill ${target.skillId}@${target.version}`;
  if (skillDraftDigest(draft) !== target.draftDigest) {
    throw new ReviewedDraftChangedError(action, subject);
  }
  const evaluating = await client.query(
    `select 1 from eval_draft_evaluations
      where workspace_id = $1 and skill_id = $2 and skill_version = $3 and status = 'running'`,
    [workspaceId, target.skillId, target.version],
  );
  if ((evaluating.rowCount ?? 0) > 0)
    throw new DraftEvaluatingError(target.skillId, target.version);

  const definition = await getWorkerDefinition(client, workspaceId, {
    definitionId: suite.worker_definition_id,
    version: suite.worker_definition_version,
  });
  if (!definition || definition.status !== 'published' || definition.kind !== 'worker') {
    throw new EvalSuiteStateError(
      `the suite's WorkerDefinition version ${suite.worker_definition_version} is no longer published — pin a published version first; nothing was started`,
    );
  }

  // What it is compared to: the family's published version, and the other Skills the
  // WorkerDefinition loads now (pinned: both arms load these versions until it ends).
  const baselines = await client.query<{ version: number }>(
    `select version from skills where workspace_id = $1 and id = $2 and status = 'published'
      order by version desc limit 1`,
    [workspaceId, target.skillId],
  );
  const baselineVersion = baselines.rows[0]?.version ?? null;
  const [baseline] =
    baselineVersion === null
      ? [undefined]
      : await readSkillVersions(client, workspaceId, [
          { skillId: target.skillId, version: baselineVersion },
        ]);
  const others = (
    await resolvePublishedSkills(
      client,
      workspaceId,
      readDefinitionContent(definition.definition).skills ?? [],
    )
  ).filter((skill) => skill.id !== target.skillId);
  if (others.some((skill) => skill.name === draft.name)) {
    throw new EvalSuiteStateError(
      `another Skill the suite's WorkerDefinition loads is named "${shownFreeText(draft.name)}" — a Worker mounts Skills by name; rename the draft first; nothing was started`,
    );
  }

  // The case rows each stage runs, fixed now.
  const mechanism = target.mechanism?.trim() || null;
  const cases = await client.query<{
    id: string;
    partition: 'regression' | 'mechanism' | 'full';
    mechanism: string | null;
  }>(
    `select id, partition, mechanism from eval_cases
      where workspace_id = $1 and suite_id = $2 and retired_in_version is null
      order by created_at, id`,
    [workspaceId, target.suiteId],
  );
  const caseIds = {
    regression: cases.rows.filter((c) => c.partition === 'regression').map((c) => c.id),
    mechanism:
      mechanism === null
        ? []
        : cases.rows
            .filter((c) => c.partition === 'mechanism' && c.mechanism?.trim() === mechanism)
            .map((c) => c.id),
    confirm: cases.rows.filter((c) => c.partition === 'full').map((c) => c.id),
  };
  if (mechanism !== null && caseIds.mechanism.length === 0) {
    throw new EvalSuiteStateError(
      `no case of the suite is aimed at the mechanism "${shownFreeText(mechanism)}" — choose one its mechanism cases name, or none; nothing was started`,
    );
  }

  const draftText = { name: draft.name, description: draft.description, markdown: draft.markdown };
  const problems = await checkSkillDraft(
    client,
    workspaceId,
    draftText,
    baseline
      ? { name: baseline.name, description: baseline.description, markdown: baseline.markdown }
      : null,
  );
  if (problems.length > 0) throw new DraftCheckFailedError(problems);

  const budget = await readEvalBudget(client, workspaceId);
  if (budget.spentUsd >= budget.monthlyBudgetUsd) {
    throw new EvaluationBudgetExhaustedError(budget.monthlyBudgetUsd, budget.spentUsd);
  }
  const plan = planFrom({ mechanism, caseIds: (stage) => caseIds[stage] }, 0, budget);
  if (plan.kind === 'end') {
    if (plan.reason === 'budget' && plan.estimateUsd !== null) {
      throw new EvaluationBudgetInsufficientError(
        budget.monthlyBudgetUsd,
        budget.spentUsd,
        budget.committedUsd,
        plan.estimateUsd,
      );
    }
    // No stage has a case to run.
    throw new EvalSuiteStateError(
      cases.rows.some((c) => c.partition === 'mechanism') && mechanism === null
        ? 'with no mechanism named, the suite holds no case to run (its cases are all aimed at a mechanism) — name a mechanism; nothing was started'
        : 'the suite holds no case these stages run (regression, mechanism, full) — add one first; nothing was started',
    );
  }

  await getOrCreateEvaluationPrincipal(client, workspaceId);
  let evaluationId: string;
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into eval_draft_evaluations (
         workspace_id, suite_id, suite_version, worker_definition_id, worker_definition_version,
         skill_id, skill_version, draft_digest, candidate_proposed_by, candidate_name,
         candidate_description, candidate_markdown, baseline_version, other_skills, mechanism,
         regression_case_ids, mechanism_case_ids, confirm_case_ids, stage, stage_notes, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15,
                 $16::uuid[], $17::uuid[], $18::uuid[], $19, $20::jsonb, $21)
       returning id`,
      [
        workspaceId,
        target.suiteId,
        suite.version,
        suite.worker_definition_id,
        suite.worker_definition_version,
        target.skillId,
        target.version,
        target.draftDigest,
        draft.proposedBy,
        draft.name,
        draft.description,
        draft.markdown,
        baselineVersion,
        JSON.stringify(others.map((skill) => ({ skillId: skill.id, version: skill.version }))),
        mechanism,
        caseIds.regression,
        caseIds.mechanism,
        caseIds.confirm,
        plan.stage,
        JSON.stringify(plan.notes),
        actor.principalId,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('startDraftEvaluation: INSERT ... RETURNING produced no row');
    evaluationId = id;
  } catch (err) {
    // Another start of the same draft committed first (eval_draft_evaluations_one_running).
    if ((err as { code?: unknown }).code === '23505') {
      throw new DraftEvaluatingError(target.skillId, target.version);
    }
    throw err;
  }
  const runId = await startStageRun(
    client,
    workspaceId,
    {
      id: evaluationId,
      suiteId: target.suiteId,
      suiteVersion: suite.version,
      workerDefinitionId: suite.worker_definition_id,
      workerDefinitionVersion: suite.worker_definition_version,
      createdBy: actor.principalId,
    },
    plan,
  );
  return {
    evaluation: await getDraftEvaluation(client, workspaceId, actor, evaluationId),
    audit: {
      skillId: target.skillId,
      version: target.version,
      draftDigest: target.draftDigest,
      baselineVersion,
      suiteId: target.suiteId,
      suiteVersion: suite.version,
      otherSkillCount: others.length,
      stage: plan.stage,
      runId,
      estimateUsd: plan.estimateUsd,
      caseCounts: {
        regression: caseIds.regression.length,
        mechanism: caseIds.mechanism.length,
        confirm: caseIds.confirm.length,
      },
    },
  };
}

// ----- settle (the trial tick) -----------------------------------------------------------------

/** The audit action of a stage started or skipped, and of a verdict. */
export const DRAFT_EVALUATION_STAGE_ACTION = 'evaluation.draft_stage';
export const DRAFT_EVALUATION_VERDICT_ACTION = 'evaluation.draft_verdict';

interface TrialRow {
  readonly run_id: string;
  readonly stage: DraftEvaluationStageName;
  readonly arm: EvalArm;
  readonly case_id: string;
  readonly split: EvalCaseSplit;
  readonly status: VerdictTrial['status'];
  readonly verdict: 'passed' | 'failed' | null;
  readonly error: string | null;
  readonly task_id: string | null;
  readonly cost_usd: number | null;
  readonly tokens: string;
  readonly environment_digest: string | null;
  readonly result?: unknown;
}

async function readTrials(
  client: PoolClient,
  workspaceId: string,
  evaluationId: string,
  withResults: boolean,
): Promise<readonly TrialRow[]> {
  const result = await client.query<TrialRow>(
    `select tr.run_id, r.stage, tr.arm, tr.case_id, c.split, tr.status, tr.verdict, tr.error,
            tr.task_id, tr.cost_usd::float8 as cost_usd, tr.tokens,
            (select w.environment_digest from worker_runs w
              where w.workspace_id = tr.workspace_id and w.task_id = tr.task_id
              order by w.started_at desc limit 1) as environment_digest
            ${withResults ? ', tr.result' : ''}
       from eval_trials tr
       join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
       join eval_cases c on c.workspace_id = tr.workspace_id and c.id = tr.case_id
      where tr.workspace_id = $1 and r.draft_evaluation_id = $2`,
    [workspaceId, evaluationId],
  );
  return result.rows;
}

function verdictTrial(row: TrialRow, canary: string | null): VerdictTrial {
  const reported =
    canary !== null && row.result !== undefined && row.result !== null
      ? normalizeSealText(JSON.stringify(row.result)).includes(canary)
      : false;
  return {
    arm: row.arm,
    caseId: row.case_id,
    split: row.split,
    status: row.status,
    passed: row.status === 'scored' && row.verdict === 'passed',
    error: row.error,
    reportedCanary: reported,
    environmentDigest: row.environment_digest,
  };
}

const ENDED = new Set(['scored', 'errored']);

/**
 * After the trial tick finished draft run `runId` (same transaction): reads its stage and ends the
 * evaluation, or starts its next stage. Does nothing when the evaluation is no longer running
 * (cancelled) or is at another stage.
 */
export async function settleDraftStage(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  actorPrincipalId: string,
): Promise<void> {
  const runs = await client.query<{
    draft_evaluation_id: string | null;
    stage: DraftEvaluationStageName | null;
  }>('select draft_evaluation_id, stage from eval_runs where workspace_id = $1 and id = $2', [
    workspaceId,
    runId,
  ]);
  const run = runs.rows[0];
  if (!run?.draft_evaluation_id || !run.stage) return;
  const row = await readEvaluationRow(client, workspaceId, run.draft_evaluation_id, true);
  if (!row || row.status !== 'running' || row.stage !== run.stage) return;

  const canary = normalizeSealText(row.canary);
  const trials = (await readTrials(client, workspaceId, row.id, true)).filter((t) =>
    ENDED.has(t.status),
  );
  const stageTrials = trials.filter((t) => t.run_id === runId).map((t) => verdictTrial(t, canary));
  const outcome = stageOutcome(
    run.stage,
    stageTrials,
    trials.map((t) => verdictTrial(t, canary)),
  );
  if (outcome.kind === 'decided') {
    await finishEvaluation(client, workspaceId, row, actorPrincipalId, {
      verdict: outcome.verdict,
      reason: outcome.reason,
      decidedBy: run.stage,
      notes: {},
    });
    return;
  }
  const budget = await readEvalBudget(client, workspaceId);
  const plan = planFrom(
    { mechanism: row.mechanism, caseIds: (stage) => stageCaseIds(row, stage) },
    STAGES.indexOf(run.stage) + 1,
    budget,
  );
  for (const [stage, note] of Object.entries(plan.notes)) {
    if (!note || note.skip === null) continue;
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId,
      action: DRAFT_EVALUATION_STAGE_ACTION,
      resourceType: 'draft_evaluation',
      resourceId: row.id,
      payload: { stage, skip: note.skip, estimateUsd: note.estimateUsd },
    });
  }
  if (plan.kind === 'end') {
    await finishEvaluation(client, workspaceId, row, actorPrincipalId, {
      verdict: 'inconclusive',
      reason: plan.reason,
      decidedBy: plan.decidedBy,
      notes: plan.notes,
    });
    return;
  }
  const nextRunId = await startStageRun(
    client,
    workspaceId,
    {
      id: row.id,
      suiteId: row.suite_id,
      suiteVersion: row.suite_version,
      workerDefinitionId: row.worker_definition_id,
      workerDefinitionVersion: row.worker_definition_version,
      createdBy: row.created_by,
    },
    plan,
  );
  await client.query(
    `update eval_draft_evaluations set stage = $3, stage_notes = stage_notes || $4::jsonb
      where workspace_id = $1 and id = $2`,
    [workspaceId, row.id, plan.stage, JSON.stringify(plan.notes)],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId,
    action: DRAFT_EVALUATION_STAGE_ACTION,
    resourceType: 'draft_evaluation',
    resourceId: row.id,
    payload: { stage: plan.stage, runId: nextRunId, estimateUsd: plan.estimateUsd },
  });
}

async function finishEvaluation(
  client: PoolClient,
  workspaceId: string,
  row: EvaluationRow,
  actorPrincipalId: string,
  end: {
    readonly verdict: DraftEvaluationVerdict;
    readonly reason: DraftEvaluationReason;
    readonly decidedBy: DraftEvaluationStageName;
    readonly notes: StageNotes;
  },
): Promise<void> {
  await client.query(
    `update eval_draft_evaluations
        set status = 'finished', stage = null, verdict = $3, reason = $4, decided_by = $5,
            stage_notes = stage_notes || $6::jsonb, finished_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, row.id, end.verdict, end.reason, end.decidedBy, JSON.stringify(end.notes)],
  );
  await writeAudit(client, {
    workspaceId,
    actorPrincipalId,
    action: DRAFT_EVALUATION_VERDICT_ACTION,
    resourceType: 'draft_evaluation',
    resourceId: row.id,
    payload: {
      skillId: row.skill_id,
      version: row.skill_version,
      suiteId: row.suite_id,
      verdict: end.verdict,
      reason: end.reason,
      decidedBy: end.decidedBy,
    },
  });
}

// ----- cancel ----------------------------------------------------------------------------------

export interface CancelledDraftEvaluation {
  readonly evaluation: DraftEvaluationWire;
  /** The running trials' Tasks, to terminate once the transaction commits. */
  readonly taskIds: readonly string[];
}

/** Cancels a running evaluation: its queued trials end `cancelled`, a run left with none open
 *  finishes, and the evaluation ends `cancelled` by `actor`. 404 when the actor may not see it,
 *  409 conflict when it has already ended. */
export async function cancelDraftEvaluation(
  client: PoolClient,
  workspaceId: string,
  actor: DraftEvaluationActor,
  evaluationId: string,
): Promise<CancelledDraftEvaluation> {
  const row = await readEvaluationRow(client, workspaceId, evaluationId, true);
  if (!row || !(await visibleTo(client, workspaceId, actor, row))) {
    throw new DraftEvaluationNotFoundError(evaluationId);
  }
  if (row.status !== 'running') throw new DraftEvaluationEndedError(evaluationId, row.status);
  await client.query(
    `update eval_trials tr set status = 'errored', error = 'cancelled', finished_at = now()
      from eval_runs r
     where r.workspace_id = tr.workspace_id and r.id = tr.run_id
       and tr.workspace_id = $1 and r.draft_evaluation_id = $2 and tr.status = 'queued'`,
    [workspaceId, evaluationId],
  );
  await client.query(
    `update eval_runs r set status = 'finished', finished_at = now()
      where r.workspace_id = $1 and r.draft_evaluation_id = $2 and r.status = 'running'
        and not exists (select 1 from eval_trials tr
                         where tr.workspace_id = r.workspace_id and tr.run_id = r.id
                           and tr.status in ('queued', 'running'))`,
    [workspaceId, evaluationId],
  );
  await client.query(
    `update eval_draft_evaluations
        set status = 'cancelled', stage = null, cancelled_by = $3, finished_at = now()
      where workspace_id = $1 and id = $2`,
    [workspaceId, evaluationId, actor.principalId],
  );
  const running = await client.query<{ task_id: string }>(
    `select tr.task_id from eval_trials tr
       join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
      where tr.workspace_id = $1 and r.draft_evaluation_id = $2 and tr.status = 'running'`,
    [workspaceId, evaluationId],
  );
  return {
    evaluation: await getDraftEvaluation(client, workspaceId, actor, evaluationId),
    taskIds: running.rows.map((r) => r.task_id),
  };
}

// ----- reads -----------------------------------------------------------------------------------

function emptyTally(): {
  trials: number;
  passed: number;
  failed: number;
  errored: number;
  voided: number;
  open: number;
  costUsd: number | null;
  tokens: number;
  unpriced: number;
} {
  return {
    trials: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    voided: 0,
    open: 0,
    costUsd: 0,
    tokens: 0,
    unpriced: 0,
  };
}

function tally(trials: readonly TrialRow[]): DraftEvaluationArmTallyWire {
  const t = emptyTally();
  for (const trial of trials) {
    t.trials += 1;
    if (trial.status === 'scored' && trial.verdict === 'passed') t.passed += 1;
    else if (trial.status === 'scored') t.failed += 1;
    else if (trialVoided({ status: trial.status, error: trial.error, taskId: trial.task_id })) {
      t.voided += 1;
    } else if (trial.status === 'errored') t.errored += 1;
    else t.open += 1;
    t.tokens += Number(trial.tokens);
    if (ENDED.has(trial.status) && trial.task_id !== null) {
      if (trial.cost_usd === null) t.unpriced += 1;
      else t.costUsd = (t.costUsd ?? 0) + trial.cost_usd;
    }
  }
  return {
    trials: t.trials,
    passed: t.passed,
    failed: t.failed,
    errored: t.errored,
    voided: t.voided,
    open: t.open,
    costUsd: t.unpriced > 0 ? null : t.costUsd,
    tokens: t.tokens,
  };
}

function summaryOf(row: EvaluationRow, costUsd: number | null): DraftEvaluationSummaryWire {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    verdict: row.verdict,
    reason: row.reason,
    decidedBy: row.decided_by,
    costUsd,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    cancelledBy: row.cancelled_by,
    suite: { id: row.suite_id, name: shownFreeText(row.suite_name), version: row.suite_version },
    workerDefinition: { id: row.worker_definition_id, version: row.worker_definition_version },
    candidate: {
      skillId: row.skill_id,
      version: row.skill_version,
      name: shownFreeText(row.candidate_name),
      draftDigest: row.draft_digest,
    },
    baseline:
      row.baseline_version === null
        ? null
        : {
            skillId: row.skill_id,
            version: row.baseline_version,
            name: shownFreeText(row.baseline_name ?? ''),
          },
    mechanism: row.mechanism === null ? null : shownFreeText(row.mechanism),
  };
}

function environmentWire(environment: RunEnvironment) {
  const { spec, runtime } = environment;
  return {
    definition: { id: spec.definition.id, version: spec.definition.version },
    model: spec.model,
    image: spec.image,
    systemPromptDigest: spec.systemPromptDigest,
    kernelVersion: spec.kernelVersion,
    runtime: runtime
      ? {
          imageRef: runtime.imageRef,
          imageId: runtime.imageId,
          piVersion: runtime.piVersion,
          platformExtensionVersion: runtime.platformExtensionVersion,
          builtFrom: runtime.builtFrom,
          modelsConfigDigest: runtime.modelsConfigDigest,
        }
      : null,
    environmentDigest: environment.environmentDigest,
  };
}

/** Every environment the evaluation's trials ran in (each Task's latest run), by digest. */
async function readEnvironments(
  client: PoolClient,
  workspaceId: string,
  evaluationId: string,
): Promise<DraftEvaluationEnvironmentWire[]> {
  const result = await client.query<{
    arm: EvalArm;
    run_spec: unknown;
    runtime_report: unknown;
    environment_digest: string | null;
  }>(
    `select tr.arm, w.run_spec, w.runtime_report, w.environment_digest
       from eval_trials tr
       join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
       join lateral (
         select run_spec, runtime_report, environment_digest from worker_runs w
          where w.workspace_id = tr.workspace_id and w.task_id = tr.task_id
          order by w.started_at desc limit 1
       ) w on true
      where tr.workspace_id = $1 and r.draft_evaluation_id = $2
      order by tr.started_at, tr.id`,
    [workspaceId, evaluationId],
  );
  const byDigest = new Map<string, DraftEvaluationEnvironmentWire>();
  for (const row of result.rows) {
    const environment = readRunEnvironment(row);
    if (environment === null) continue;
    const key = environment.environmentDigest ?? `unknown:${JSON.stringify(row.run_spec)}`;
    const entry = byDigest.get(key) ?? {
      environment: environmentWire(environment),
      baselineTrials: 0,
      candidateTrials: 0,
    };
    byDigest.set(key, {
      ...entry,
      baselineTrials: entry.baselineTrials + (row.arm === 'baseline' ? 1 : 0),
      candidateTrials: entry.candidateTrials + (row.arm === 'candidate' ? 1 : 0),
    });
  }
  return [...byDigest.values()];
}

/** A draft evaluation whole. 404 when there is none, or the viewer may not see it. */
export async function getDraftEvaluation(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  evaluationId: string,
): Promise<DraftEvaluationWire> {
  const row = await readEvaluationRow(client, workspaceId, evaluationId, false);
  if (!row || !(await visibleTo(client, workspaceId, viewer, row))) {
    throw new DraftEvaluationNotFoundError(evaluationId);
  }
  const runs = await client.query<{
    id: string;
    stage: DraftEvaluationStageName;
    status: 'running' | 'finished';
    k: number;
  }>(
    `select id, stage, status, k from eval_runs
      where workspace_id = $1 and draft_evaluation_id = $2 order by created_at`,
    [workspaceId, row.id],
  );
  const trials = await readTrials(client, workspaceId, row.id, false);
  const allCaseIds = [
    ...new Set([...row.regression_case_ids, ...row.mechanism_case_ids, ...row.confirm_case_ids]),
  ];
  const caseRows = await client.query<{ id: string; title: string; split: EvalCaseSplit }>(
    'select id, title, split from eval_cases where workspace_id = $1 and id = any($2::uuid[])',
    [workspaceId, allCaseIds],
  );
  const caseById = new Map(caseRows.rows.map((c) => [c.id, c] as const));
  const trialCostUsd =
    row.status === 'running' ? (await readEvalBudget(client, workspaceId)).trialCostUsd : null;
  const lastRunStage = runs.rows.at(-1)?.stage ?? null;

  const stages = STAGES.map((stage): DraftEvaluationStageWire => {
    const caseIds = stageCaseIds(row, stage);
    const note = row.stage_notes[stage];
    const run = runs.rows.find((r) => r.stage === stage);
    const runTrials = run ? trials.filter((t) => t.run_id === run.id) : [];
    // A stage the running evaluation has not reached, which it will skip whatever happens first:
    // no mechanism named, or no case. (Whether the budget covers it is known only then.)
    const foreseenSkip: DraftEvaluationSkip | null =
      note || run || row.status !== 'running'
        ? null
        : stage === 'mechanism' && row.mechanism === null
          ? 'no_mechanism'
          : caseIds.length === 0
            ? 'no_cases'
            : null;
    const skip = note?.skip ?? foreseenSkip;
    let status: DraftEvaluationStageWire['status'];
    if (skip) status = 'skipped';
    else if (run && row.status === 'cancelled' && stage === lastRunStage) status = 'cancelled';
    else if (run) status = run.status === 'finished' ? 'ended' : 'running';
    else status = row.status === 'running' ? 'waiting' : 'not_run';
    const estimateUsd =
      note?.estimateUsd ??
      (status === 'waiting' && trialCostUsd !== null
        ? draftEvaluationStageTrials(stage, caseIds.length) * trialCostUsd
        : null);
    return {
      stage,
      status,
      skipReason: skip,
      runId: run?.id ?? null,
      caseCount: caseIds.length,
      k: run?.k ?? draftEvaluationStageK(stage, caseIds.length),
      estimateUsd,
      baseline: tally(runTrials.filter((t) => t.arm === 'baseline')),
      candidate: tally(runTrials.filter((t) => t.arm === 'candidate')),
      cases: caseIds.map((caseId) => {
        const info = caseById.get(caseId);
        const ofCase = runTrials.filter((t) => t.case_id === caseId);
        return {
          caseId,
          title: shownFreeText(info?.title ?? ''),
          split: info?.split ?? 'dev',
          baseline: tally(ofCase.filter((t) => t.arm === 'baseline')),
          candidate: tally(ofCase.filter((t) => t.arm === 'candidate')),
        };
      }),
      measure:
        status === 'ended'
          ? measureStage(
              stage,
              runTrials.map((t) => verdictTrial(t, null)),
            )
          : null,
    };
  });

  const otherRows = await readSkillVersions(client, workspaceId, row.other_skills);
  const otherByRef = new Map(otherRows.map((s) => [`${s.id}@${s.version}`, s] as const));
  const [baselineRow] =
    row.baseline_version === null
      ? [undefined]
      : await readSkillVersions(client, workspaceId, [
          { skillId: row.skill_id, version: row.baseline_version },
        ]);
  return {
    ...summaryOf(row, tally(trials).costUsd),
    otherSkills: row.other_skills.map((ref) => ({
      skillId: ref.skillId,
      version: ref.version,
      name: shownFreeText(otherByRef.get(`${ref.skillId}@${ref.version}`)?.name ?? ''),
    })),
    candidateContent: {
      name: shownFreeText(row.candidate_name),
      description: shownFreeText(row.candidate_description),
      markdown: shownFreeText(row.candidate_markdown),
    },
    baselineContent: baselineRow
      ? {
          name: shownFreeText(baselineRow.name),
          description: shownFreeText(baselineRow.description),
          markdown: shownFreeText(baselineRow.markdown),
        }
      : null,
    stages,
    environments: await readEnvironments(client, workspaceId, row.id),
  };
}

/** How many evaluations `listDraftEvaluations` returns. */
const LIST_DRAFT_EVALUATIONS_LIMIT = 50;

/** The draft evaluations the viewer may see, newest first, in brief; by Skill family and/or suite. */
export async function listDraftEvaluations(
  client: PoolClient,
  workspaceId: string,
  viewer: DraftEvaluationActor,
  filter: { readonly skillId?: string; readonly suiteId?: string },
): Promise<readonly DraftEvaluationSummaryWire[]> {
  const result = await client.query<EvaluationRow & { cost_usd: number | null; unpriced: string }>(
    `select ${EVALUATION_COLUMNS},
            (select sum(tr.cost_usd)::float8 from eval_trials tr
               join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
              where tr.workspace_id = e.workspace_id and r.draft_evaluation_id = e.id) as cost_usd,
            (select count(*) from eval_trials tr
               join eval_runs r on r.workspace_id = tr.workspace_id and r.id = tr.run_id
              where tr.workspace_id = e.workspace_id and r.draft_evaluation_id = e.id
                and tr.status in ('scored', 'errored') and tr.task_id is not null
                and tr.cost_usd is null)::bigint as unpriced
       from ${EVALUATION_FROM}
      where e.workspace_id = $1
        and ($4::uuid is null or e.skill_id = $4)
        and ($5::uuid is null or e.suite_id = $5)
        and ${VISIBLE_TO('$2', '$3')}
      order by e.created_at desc, e.id desc
      limit $6`,
    [
      workspaceId,
      seesEveryDraft(viewer.role),
      viewer.principalId,
      filter.skillId ?? null,
      filter.suiteId ?? null,
      LIST_DRAFT_EVALUATIONS_LIMIT,
    ],
  );
  return result.rows.map((row) =>
    summaryOf(row, Number(row.unpriced) > 0 ? null : (row.cost_usd ?? 0)),
  );
}

/** The SQL condition `runs.ts` filters a suite's draft runs with (`e` is the evaluation). */
export const DRAFT_EVALUATION_VISIBLE_TO = VISIBLE_TO;

// ----- after the commit ------------------------------------------------------------------------

/** After the transaction that started an evaluation commits: starts what of its first stage the
 *  evaluation Principal may run now (the trial tick starts the rest), and returns the evaluation
 *  as it is then. */
export async function afterDraftEvaluationStart(
  pool: PoolLike,
  workspaceId: string,
  actor: DraftEvaluationActor,
  evaluationId: string,
): Promise<DraftEvaluationWire> {
  await dispatchEvalTrials(pool, { workspaceId });
  return withWorkspace(pool, { workspaceId, principalId: actor.principalId }, (client) =>
    getDraftEvaluation(client, workspaceId, actor, evaluationId),
  );
}

/** After the transaction that cancelled an evaluation commits: terminates its running trials'
 *  Tasks (the trial tick then records them `cancelled`), and returns the evaluation as it is then. */
export async function afterDraftEvaluationCancel(
  pool: PoolLike,
  workspaceId: string,
  actor: DraftEvaluationActor,
  cancelled: CancelledDraftEvaluation,
): Promise<DraftEvaluationWire> {
  for (const taskId of cancelled.taskIds) {
    await terminateTask(workspaceId, actor.principalId, taskId);
  }
  return withWorkspace(pool, { workspaceId, principalId: actor.principalId }, (client) =>
    getDraftEvaluation(client, workspaceId, actor, cancelled.evaluation.id),
  );
}
