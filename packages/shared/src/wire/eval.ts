import { z } from 'zod';
import {
  OperationModeSchema,
  PrincipalKindSchema,
  PublishableStatusSchema,
  TASK_FAILURE_REASON_VALUES,
} from '../enums.js';
import {
  EVAL_CALL_ANSWER_VALUES,
  EvalAssertionSchema,
  EvalCaseOriginSchema,
  EvalCasePartitionSchema,
  EvalCaseSplitSchema,
  EvalFixtureRuleSchema,
} from '../eval-case.js';
import { RunEnvironmentWireSchema } from './task.js';

/**
 * wire/eval (S10 E3-1a; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalSuite, §3.3 I-E4, §5.5,
 * §5.6 用例集详情): an evaluation suite as the console shows it — `list_eval_suites`,
 * `get_eval_suite` and the result of every change to one. Human channel only: a person sees all
 * of it (the canary included), an agent none of it (I-E4).
 *
 *   - `version`: 1 when created, one more for every change since. An evaluation run (E3-2)
 *     records the version it used; `history` lists the change that made each version.
 *   - `workerDefinition`: the published worker-kind WorkerDefinition version evaluated runs start
 *     from, with its status now — `deprecated` means it was deprecated after the suite pinned it
 *     (the console flags it; a repin is a new suite version).
 *   - `fixtureGates`: the suite's stand-ins of real gates, each frozen when added (the gate's name
 *     and its published Operations as an agent's tool list shows them). `liveState` compares the
 *     frozen definition with the gate's published Operations now: `same`; `changed` (sync takes
 *     the new one, a new suite version); `unavailable` — the gate is gone or publishes nothing
 *     now, so there is nothing to sync to.
 *   - `cases` (S10 E3-1b): the cases the suite holds at its current version, each in brief —
 *     `get_eval_case` reads one whole (`@nexttime/shared` eval-case.ts says what a case is). A
 *     case's `fixtureProblems` are the rules a fixture gate sync or removal left without a match:
 *     a gate the suite no longer has, an Operation the gate no longer publishes, a "not there"
 *     answer the Operation no longer declares. Such a rule never answers; an edit fixes it.
 */

/** One frozen Operation of a fixture gate: what an evaluated Worker's tool shows. */
export const EvalFixtureOperationWireSchema = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    mode: OperationModeSchema,
    /** As every read shows an Operation's description (suspected credentials masked). */
    description: z.string().nullable(),
    paramsSchema: z.record(z.string(), z.unknown()),
    /** Whether the Operation declares answers that mean "not there" (an observe-class Operation's
     *  `absent_statuses` / `absent_exit_codes`) — only then may a case's fixture answer its calls
     *  with `absent` (S10 E3-1b). */
    answersAbsent: z.boolean(),
  })
  .strict();
export type EvalFixtureOperationWire = z.infer<typeof EvalFixtureOperationWireSchema>;

export const EVAL_FIXTURE_GATE_LIVE_STATE_VALUES = ['same', 'changed', 'unavailable'] as const;
export const EvalFixtureGateLiveStateSchema = z.enum(EVAL_FIXTURE_GATE_LIVE_STATE_VALUES);
export type EvalFixtureGateLiveState = z.infer<typeof EvalFixtureGateLiveStateSchema>;

export const EvalFixtureGateWireSchema = z
  .object({
    gatekeeperId: z.string(),
    /** The gate's name when frozen — the prefix of the tool names an evaluated Worker sees. */
    gateName: z.string(),
    operations: z.array(EvalFixtureOperationWireSchema),
    snapshotDigest: z.string(),
    addedInVersion: z.number().int().positive(),
    addedBy: z.string(),
    addedAt: z.string(),
    liveState: EvalFixtureGateLiveStateSchema,
  })
  .strict();
export type EvalFixtureGateWire = z.infer<typeof EvalFixtureGateWireSchema>;

const EvalPinWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    /** The pinned version's status now (`published` or, since, `deprecated`). */
    status: PublishableStatusSchema,
  })
  .strict();

export const EvalSuiteSummaryWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    workerDefinition: EvalPinWireSchema,
    version: z.number().int().positive(),
    fixtureGateCount: z.number().int().nonnegative(),
    /** How many of its fixture gates are not `same` now (the list's attention mark). */
    fixtureGatesNeedingAttention: z.number().int().nonnegative(),
    /** How many cases it holds at its current version, and how many of those have a fixture
     *  problem (the list's other attention mark). */
    caseCount: z.number().int().nonnegative(),
    casesNeedingAttention: z.number().int().nonnegative(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type EvalSuiteSummaryWire = z.infer<typeof EvalSuiteSummaryWireSchema>;

export const EVAL_SUITE_CHANGE_KIND_VALUES = [
  'created',
  'repinned',
  'fixture_gate_added',
  'fixture_gate_synced',
  'fixture_gate_removed',
  'case_added',
  'case_edited',
  'case_retired',
] as const;
export const EvalSuiteChangeKindSchema = z.enum(EVAL_SUITE_CHANGE_KIND_VALUES);
export type EvalSuiteChangeKind = z.infer<typeof EvalSuiteChangeKindSchema>;

const changeBase = {
  version: z.number().int().positive(),
  actorId: z.string(),
  /** As every read shows free text (suspected credentials masked). */
  reason: z.string().nullable(),
  createdAt: z.string(),
};
const gateChange = {
  gatekeeperId: z.string(),
  gateName: z.string(),
};
const caseChange = {
  caseId: z.string(),
  /** The case's title then, as every read shows free text. */
  title: z.string(),
  partition: EvalCasePartitionSchema,
  split: EvalCaseSplitSchema,
};

/** The change that made one suite version — what, by whom, when and why. */
export const EvalSuiteChangeWireSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...changeBase,
      kind: z.literal('created'),
      workerDefinitionVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...changeBase,
      kind: z.literal('repinned'),
      fromVersion: z.number().int().positive(),
      toVersion: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...changeBase, ...gateChange, kind: z.literal('fixture_gate_added') }).strict(),
  z
    .object({
      ...changeBase,
      ...gateChange,
      kind: z.literal('fixture_gate_synced'),
      /** Operation names the new definition has and the old did not, the other way round, and
       *  those both have with another definition. */
      addedOperations: z.array(z.string()),
      removedOperations: z.array(z.string()),
      changedOperations: z.array(z.string()),
    })
    .strict(),
  z.object({ ...changeBase, ...gateChange, kind: z.literal('fixture_gate_removed') }).strict(),
  z.object({ ...changeBase, ...caseChange, kind: z.literal('case_added') }).strict(),
  z
    .object({
      ...changeBase,
      ...caseChange,
      kind: z.literal('case_edited'),
      /** The case row the edit retired; `caseId` is the row it added. */
      supersedes: z.string(),
    })
    .strict(),
  z.object({ ...changeBase, ...caseChange, kind: z.literal('case_retired') }).strict(),
]);
export type EvalSuiteChangeWire = z.infer<typeof EvalSuiteChangeWireSchema>;

/** A fixture rule that no longer finds what it answers (see the module comment): its place in the
 *  case's `fixtures` and why. */
export const EVAL_FIXTURE_PROBLEM_VALUES = [
  'gate_not_in_suite',
  'operation_not_on_gate',
  'absent_not_declared',
] as const;
export const EvalFixtureProblemKindSchema = z.enum(EVAL_FIXTURE_PROBLEM_VALUES);
export type EvalFixtureProblemKind = z.infer<typeof EvalFixtureProblemKindSchema>;

export const EvalFixtureProblemWireSchema = z
  .object({ index: z.number().int().nonnegative(), problem: EvalFixtureProblemKindSchema })
  .strict();
export type EvalFixtureProblemWire = z.infer<typeof EvalFixtureProblemWireSchema>;

/** One case in brief: what it is, where it sits, and whether a fixture rule needs attention. */
export const EvalCaseSummaryWireSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    partition: EvalCasePartitionSchema,
    split: EvalCaseSplitSchema,
    mechanism: z.string().nullable(),
    origin: EvalCaseOriginSchema,
    addedInVersion: z.number().int().positive(),
    addedBy: z.string(),
    addedAt: z.string(),
    /** The case row this one replaced in an edit. */
    supersedes: z.string().nullable(),
    fixtureRuleCount: z.number().int().nonnegative(),
    assertionCount: z.number().int().positive(),
    /** The distinct fixture gate and operation pairs its rules answer, in rule order — which
     *  cases a gate's removal or a sync touches. */
    fixtureOperations: z.array(
      z.object({ gatekeeperId: z.string(), operation: z.string() }).strict(),
    ),
    fixtureProblems: z.array(EvalFixtureProblemWireSchema),
  })
  .strict();
export type EvalCaseSummaryWire = z.infer<typeof EvalCaseSummaryWireSchema>;

/** One case row whole — a live one, or one an edit or a retirement took out (`retiredInVersion`,
 *  with the reason; `supersededBy` when an edit replaced it). Free text in it reads as every read
 *  shows free text. */
export const EvalCaseWireSchema = EvalCaseSummaryWireSchema.extend({
  suiteId: z.string(),
  input: z.unknown().optional(),
  fixtures: z.array(EvalFixtureRuleSchema),
  assertions: z.array(EvalAssertionSchema),
  /** `sha256:` over the case's content and fixed fields — the same in every read of the row. */
  contentDigest: z.string(),
  retiredInVersion: z.number().int().positive().nullable(),
  retireReason: z.string().nullable(),
  supersededBy: z.string().nullable(),
}).strict();
export type EvalCaseWire = z.infer<typeof EvalCaseWireSchema>;

export const EvalSuiteWireSchema = EvalSuiteSummaryWireSchema.extend({
  /** Shown to people only; E3-2/3 treat it appearing in a draft or a transcript as contamination. */
  canary: z.string(),
  fixtureGates: z.array(EvalFixtureGateWireSchema),
  /** The cases it holds at its current version, oldest first. */
  cases: z.array(EvalCaseSummaryWireSchema),
  /** Every version's change, newest first. */
  history: z.array(EvalSuiteChangeWireSchema),
}).strict();
export type EvalSuiteWire = z.infer<typeof EvalSuiteWireSchema>;

/** The stages of a draft evaluation, in the order they run (S10 E3-2b; §5.5 四级漏斗, levels 1–3 —
 *  level 0 is the check before it starts): `regression` (回归棘轮), `mechanism` (机制筛), `confirm`
 *  (确认). */
export const DRAFT_EVALUATION_STAGE_VALUES = ['regression', 'mechanism', 'confirm'] as const;
export const DraftEvaluationStageNameSchema = z.enum(DRAFT_EVALUATION_STAGE_VALUES);
export type DraftEvaluationStageName = z.infer<typeof DraftEvaluationStageNameSchema>;

// ----- evaluation runs (S10 E3-2a) -------------------------------------------------------------

/**
 * An evaluation run (S10 E3-2a; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalRun, §5.5 账本恒等式,
 * §5.6 评测运行详情): one person-started run of a suite's cases against the WorkerDefinition version
 * the suite pinned, at the suite version they looked at. Each case is tried `k` times per arm; each
 * try is a trial — an evaluation Task (`TaskWire.purpose = evaluation`) whose every gate call the
 * kernel answers from the case's fixtures, and whose report and calls the case's assertions judge.
 * Human channel only (I-E4).
 *
 *   - `kind`: `case_trial` — one case, once, as it would run now (E3-2a's 「试跑」); `draft` — one
 *     stage of a draft evaluation (E3-2b, {@link DraftEvaluationWireSchema}): the stage's cases,
 *     `k` tries per arm, both arms.
 *   - `arm`: `baseline` — the suite's pinned WorkerDefinition version with the Skill versions it
 *     loads (a `case_trial`: the latest published, as it would run now; a draft run: those the
 *     evaluation pinned, with the Skill version the draft would replace); `candidate` — the same
 *     with the draft in that Skill's place (draft runs only).
 *   - A run is `running` until every trial it holds has ended, then `finished` — and the database
 *     refuses `finished` unless it holds exactly arms × cases × k trials, all ended (§5.5 账本恒等式).
 *   - A trial is `queued` until the kernel starts its Task (a draft run's trials wait their turn:
 *     the evaluation Principal runs only so many Tasks at once), `running` while its Task runs, then
 *     `scored` (`verdict` passed: every assertion satisfied; failed otherwise) when its Worker
 *     reported a result, or `errored` when it ended without one (`error` says how: the Task's
 *     failure reason, `cancelled` — its Task, or the evaluation before it started — or `withheld`:
 *     what it would start with carried a held-out case's text or a canary).
 */
export const EVAL_RUN_KIND_VALUES = ['case_trial', 'draft'] as const;
export const EvalRunKindSchema = z.enum(EVAL_RUN_KIND_VALUES);
export type EvalRunKind = z.infer<typeof EvalRunKindSchema>;

export const EVAL_ARM_VALUES = ['baseline', 'candidate'] as const;
export const EvalArmSchema = z.enum(EVAL_ARM_VALUES);
export type EvalArm = z.infer<typeof EvalArmSchema>;

export const EVAL_RUN_STATUS_VALUES = ['running', 'finished'] as const;
export const EvalRunStatusSchema = z.enum(EVAL_RUN_STATUS_VALUES);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

export const EVAL_TRIAL_STATUS_VALUES = ['queued', 'running', 'scored', 'errored'] as const;
export const EvalTrialStatusSchema = z.enum(EVAL_TRIAL_STATUS_VALUES);
export type EvalTrialStatus = z.infer<typeof EvalTrialStatusSchema>;

export const EVAL_TRIAL_VERDICT_VALUES = ['passed', 'failed'] as const;
export const EvalTrialVerdictSchema = z.enum(EVAL_TRIAL_VERDICT_VALUES);
export type EvalTrialVerdict = z.infer<typeof EvalTrialVerdictSchema>;

/** How an `errored` trial ended: its Task's failure reason, `cancelled`, `withheld`, or `paused` —
 *  the evaluation seal paused the evaluation's agents while the trial ran (S10 E3-2c), so what it
 *  ended with says nothing about the arm. */
export const EVAL_TRIAL_ERROR_VALUES = [
  ...TASK_FAILURE_REASON_VALUES,
  'cancelled',
  'withheld',
  'paused',
] as const;
export const EvalTrialErrorSchema = z.enum(EVAL_TRIAL_ERROR_VALUES);
export type EvalTrialError = z.infer<typeof EvalTrialErrorSchema>;

/** How one assertion of the case judged the trial. `undetermined`: the path read nothing the
 *  predicate could judge — it does not pass. */
export const EvalAssertionResultWireSchema = z
  .object({
    index: z.number().int().nonnegative(),
    outcome: z.enum(['satisfied', 'unsatisfied', 'undetermined']),
    note: z.string().nullable(),
  })
  .strict();
export type EvalAssertionResultWire = z.infer<typeof EvalAssertionResultWireSchema>;

/** One call the trial's Worker made to a fixture gate, in order, and how it was answered:
 *  `ruleIndex` is the case's fixture rule that answered (`null`: none matched — `unanswered`). */
export const EvalTrialCallWireSchema = z
  .object({
    seq: z.number().int().positive(),
    gatekeeperId: z.string(),
    gate: z.string(),
    operation: z.string(),
    mode: OperationModeSchema,
    params: z.record(z.string(), z.unknown()),
    ruleIndex: z.number().int().nonnegative().nullable(),
    answer: z.enum(EVAL_CALL_ANSWER_VALUES),
    at: z.string(),
  })
  .strict();
export type EvalTrialCallWire = z.infer<typeof EvalTrialCallWireSchema>;

export const EvalTrialWireSchema = z
  .object({
    id: z.string(),
    arm: EvalArmSchema,
    /** The case row the trial ran (its id when the run started; an edit since makes a new row). */
    caseId: z.string(),
    caseTitle: z.string(),
    rep: z.number().int().positive(),
    status: EvalTrialStatusSchema,
    verdict: EvalTrialVerdictSchema.nullable(),
    error: EvalTrialErrorSchema.nullable(),
    /** The evaluation Task the trial ran as — `null` while it is queued, or when it was cancelled
     *  before it started. */
    taskId: z.string().nullable(),
    /** Each assertion's outcome, in the case's order — once scored. */
    assertions: z.array(EvalAssertionResultWireSchema),
    /** The result the Worker reported (its `summary`, `output`, …), as kept — `null` until it
     *  reports, or when it never did. */
    result: z.unknown().optional(),
    calls: z.array(EvalTrialCallWireSchema),
    /** What its model calls cost, where the model has a price; `null` while none is known. */
    costUsd: z.number().nullable(),
    tokens: z.number().int().nonnegative(),
    /** What its Worker ran in (S11 W1a `environmentDigest`): `null` until its run reports, or when
     *  one of its parts is unknown (`RunEnvironmentWire`). A draft evaluation's trials must share
     *  one (I-E2). */
    environmentDigest: z.string().nullable(),
    /** `null` while it is queued (and for one cancelled before it started). */
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .strict();
export type EvalTrialWire = z.infer<typeof EvalTrialWireSchema>;

const EvalRunBaseWireSchema = z
  .object({
    id: z.string(),
    suiteId: z.string(),
    suiteVersion: z.number().int().positive(),
    kind: EvalRunKindSchema,
    workerDefinition: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
    k: z.number().int().positive(),
    status: EvalRunStatusSchema,
    /** A `draft` run's evaluation and the stage it is (E3-2b); `null` for a `case_trial`. */
    draftEvaluationId: z.string().nullable(),
    stage: DraftEvaluationStageNameSchema.nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .strict();

/** A run whole: every trial, its assertions and calls. */
export const EvalRunWireSchema = EvalRunBaseWireSchema.extend({
  trials: z.array(EvalTrialWireSchema),
}).strict();
export type EvalRunWire = z.infer<typeof EvalRunWireSchema>;

/** A run in brief, for a list: its case rows and how its trials came out. */
export const EvalRunSummaryWireSchema = EvalRunBaseWireSchema.extend({
  caseIds: z.array(z.string()),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
}).strict();
export type EvalRunSummaryWire = z.infer<typeof EvalRunSummaryWireSchema>;

/**
 * The workspace's evaluation budget this UTC month (coordinator 2026-10-30: its own quota, apart
 * from the daily cost budget; $10 unless the owner sets `evaluation.monthly_cost_budget_usd`). A run
 * is not started once `spentUsd` reaches `monthlyBudgetUsd`. `trialCostUsd` is what one trial cost
 * on average over the workspace's last scored trials with a known cost — `null` before there is one; the
 * console multiplies it by the trials a run would hold for its estimate. `unpricedTrials` counts this
 * month's trials whose model has no price, so their cost is not in `spentUsd`.
 */
export const EvalBudgetWireSchema = z
  .object({
    monthlyBudgetUsd: z.number().nonnegative(),
    spentUsd: z.number().nonnegative(),
    periodStart: z.string(),
    periodEnd: z.string(),
    trialCostUsd: z.number().nonnegative().nullable(),
    unpricedTrials: z.number().int().nonnegative(),
    /** What the trials not ended yet (queued or running, of every evaluation) are expected to
     *  cost: their count × `trialCostUsd`, 0 while that is unknown. A draft evaluation's stage
     *  starts only when spent + this + its estimate fits the budget (S10 E3-2b). */
    committedUsd: z.number().nonnegative(),
  })
  .strict();
export type EvalBudgetWire = z.infer<typeof EvalBudgetWireSchema>;

// ----- draft evaluations (S10 E3-2b) -----------------------------------------------------------

/**
 * A draft evaluation (S10 E3-2b; docs/s10-evolution-plan-2026-10-04.md §3.2 EvalRun evaluated /
 * compared_to, §3.4 草稿的评测子状态, §5.5 四级漏斗 / 怎么判, §5.6 评测运行详情): one person-started
 * evaluation of a Skill draft against a suite. Both arms run the suite's pinned WorkerDefinition
 * version with the same other Skills, pinned when it started; the `baseline` arm loads the Skill
 * version the draft would replace (none, for a new Skill: the WorkerDefinition without it), the
 * `candidate` arm the draft as it was when the evaluation started (`candidate.draftDigest`). The
 * stages run in order, each a `draft` EvalRun of both arms (`@nexttime/shared` draft-evaluation.ts
 * holds their k and thresholds):
 *
 *   1. `regression` — the suite's regression cases. The candidate must pass each as many times as
 *      the baseline does, else `regressed`.
 *   2. `mechanism` — the cases aimed at the mechanism the person named (none named, or none such:
 *      skipped). The candidate must pass every try and the baseline at most 40% of them, else
 *      `refuted` — the hypothesis that the draft fixes that mechanism was refuted.
 *   3. `confirm` — the suite's full cases. On `dev`: the candidate's pass rate below the baseline's
 *      by more than δ is `worse`; the difference's one-sided lower bound above 0 is `better`, above
 *      −δ `non_inferior`, else `inconclusive` (too few trials to tell). `better` and
 *      `non_inferior` also need `holdout` to point the same way (holdout difference ≥ 0, ≥ −δ), and
 *      a suite with no holdout case cannot give them.
 *
 * A trial that errored because its Worker ran out of time, ended without reporting or spent its
 * token budget counts as not passed; one that could not start, was lost, terminated or crashed has
 * no outcome (`trialHasOutcome`), and a verdict must hold whichever way such trials would have gone
 * — else `inconclusive` (`errored_trials`); confirm leaves them out of its rates. Any stage ends the
 * evaluation `contaminated` when a trial's Worker was withheld evaluation content or reported a
 * canary, `unmeasured` when its trials did not all run in one environment (I-E2), `inconclusive`
 * when more than a quarter of either arm's trials have no outcome. Before a stage starts its cost
 * is estimated (its trials × the recent cost of a trial); a stage the month's evaluation budget
 * cannot cover — after what is spent and what the trials not ended yet are expected to cost — is
 * not run and the evaluation ends `inconclusive` (`budget`): it never stops part-way through a
 * stage. A stage with no cases is skipped; with all three skipped nothing would run, and the start
 * is refused.
 *
 * `running` while a stage runs; then `finished`, with a verdict, why (`reason`), and the stage that
 * decided it — or `cancelled` by a person (no verdict). While it runs the draft cannot be discarded,
 * rejected or expired; afterwards it can, and this keeps the content it evaluated. Human channel
 * only (I-E4).
 */
export const DRAFT_EVALUATION_STATUS_VALUES = ['running', 'finished', 'cancelled'] as const;
export const DraftEvaluationStatusSchema = z.enum(DRAFT_EVALUATION_STATUS_VALUES);
export type DraftEvaluationStatus = z.infer<typeof DraftEvaluationStatusSchema>;

export const DRAFT_EVALUATION_VERDICT_VALUES = [
  'regressed',
  'refuted',
  'worse',
  'better',
  'non_inferior',
  'inconclusive',
  'unmeasured',
  'contaminated',
] as const;
export const DraftEvaluationVerdictSchema = z.enum(DRAFT_EVALUATION_VERDICT_VALUES);
export type DraftEvaluationVerdict = z.infer<typeof DraftEvaluationVerdictSchema>;

/** Why the verdict, one per rule that gives it:
 *   - `regressed`: `regression_case_lost` (a regression case the candidate passed fewer times);
 *   - `refuted`: `mechanism_not_shown`;
 *   - `worse`: `below_margin`; `better`: `above_baseline`; `non_inferior`: `within_margin`;
 *   - `inconclusive`: `too_few_trials` (the lower bound not above −δ), `holdout_disagrees`,
 *     `no_holdout_cases`, `no_confirm_cases`, `errored_trials` (an arm with over a quarter of its
 *     trials without an outcome, or such trials that could tip the stage's rule), `budget`;
 *   - `unmeasured`: `environment_differs`, `environment_unknown` (a trial's environment is not
 *     known — its run reported nothing);
 *   - `contaminated`: `content_withheld`, `canary_reported`. */
export const DRAFT_EVALUATION_REASON_VALUES = [
  'regression_case_lost',
  'mechanism_not_shown',
  'below_margin',
  'above_baseline',
  'within_margin',
  'too_few_trials',
  'holdout_disagrees',
  'no_holdout_cases',
  'no_confirm_cases',
  'errored_trials',
  'budget',
  'environment_differs',
  'environment_unknown',
  'content_withheld',
  'canary_reported',
] as const;
export const DraftEvaluationReasonSchema = z.enum(DRAFT_EVALUATION_REASON_VALUES);
export type DraftEvaluationReason = z.infer<typeof DraftEvaluationReasonSchema>;

/** A stage's state: `waiting` (a later stage of a running evaluation), `running`, `ended` (it ran
 *  every trial; the evaluation's `decidedBy` says whether it ended the evaluation), `skipped`
 *  (`skipReason` — a later stage reads so already when it will be, for no mechanism or no case;
 *  for the budget only once it is reached), `not_run` (an earlier stage ended the evaluation),
 *  `cancelled`. */
export const DRAFT_EVALUATION_STAGE_STATUS_VALUES = [
  'waiting',
  'running',
  'ended',
  'skipped',
  'not_run',
  'cancelled',
] as const;
export const DraftEvaluationStageStatusSchema = z.enum(DRAFT_EVALUATION_STAGE_STATUS_VALUES);
export type DraftEvaluationStageStatus = z.infer<typeof DraftEvaluationStageStatusSchema>;

/** Why a stage was skipped: it has no case (`no_cases`), no mechanism was named (`no_mechanism`),
 *  or the month's evaluation budget could not cover it (`budget`). */
export const DRAFT_EVALUATION_SKIP_VALUES = ['no_cases', 'no_mechanism', 'budget'] as const;
export const DraftEvaluationSkipSchema = z.enum(DRAFT_EVALUATION_SKIP_VALUES);
export type DraftEvaluationSkip = z.infer<typeof DraftEvaluationSkipSchema>;

/** One arm's trials in a stage. */
export const DraftEvaluationArmTallyWireSchema = z
  .object({
    trials: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Ended without a verdict after it started. */
    errored: z.number().int().nonnegative(),
    /** Never started: the evaluation was cancelled while it was queued (`trialVoided`). */
    voided: z.number().int().nonnegative(),
    /** Queued or running. */
    open: z.number().int().nonnegative(),
    /** `null` while a trial with no price has ended. */
    costUsd: z.number().nullable(),
    tokens: z.number().int().nonnegative(),
  })
  .strict();
export type DraftEvaluationArmTallyWire = z.infer<typeof DraftEvaluationArmTallyWireSchema>;

/** One case of a stage, both arms — a row of the case × arm matrix. */
export const DraftEvaluationCaseRowWireSchema = z
  .object({
    caseId: z.string(),
    title: z.string(),
    split: EvalCaseSplitSchema,
    baseline: DraftEvaluationArmTallyWireSchema,
    candidate: DraftEvaluationArmTallyWireSchema,
  })
  .strict();
export type DraftEvaluationCaseRowWire = z.infer<typeof DraftEvaluationCaseRowWireSchema>;

/** Passes out of tries, per arm, on one split of the confirm stage — and the difference
 *  (candidate − baseline) with its one-sided lower bound; `null` without a try in either arm.
 *  Tries are those with an outcome (`trialHasOutcome`); `…NoOutcome` counts the others, left out
 *  of the rates. */
export const DraftEvaluationSplitMeasureWireSchema = z
  .object({
    candidatePassed: z.number().int().nonnegative(),
    candidateTrials: z.number().int().nonnegative(),
    candidateNoOutcome: z.number().int().nonnegative(),
    baselinePassed: z.number().int().nonnegative(),
    baselineTrials: z.number().int().nonnegative(),
    baselineNoOutcome: z.number().int().nonnegative(),
    difference: z.number().nullable(),
    lowerBound: z.number().nullable(),
  })
  .strict();
export type DraftEvaluationSplitMeasureWire = z.infer<typeof DraftEvaluationSplitMeasureWireSchema>;

/** What a stage measured, as its rule reads it — once it ended. */
export const DraftEvaluationMeasureWireSchema = z.discriminatedUnion('stage', [
  z
    .object({
      stage: z.literal('regression'),
      /** Cases the candidate passed fewer times than the baseline, even had each of its tries
       *  without an outcome passed. */
      lostCaseIds: z.array(z.string()),
      /** Cases neither lost nor held: tries without an outcome (in either arm) could tip them. */
      unsettledCaseIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      stage: z.literal('mechanism'),
      /** Passes out of the arm's tries with an outcome (`trialHasOutcome`); `…NoOutcome` counts
       *  the others — as the confirm stage's splits count them. */
      candidatePassed: z.number().int().nonnegative(),
      candidateTrials: z.number().int().nonnegative(),
      candidateNoOutcome: z.number().int().nonnegative(),
      baselinePassed: z.number().int().nonnegative(),
      baselineTrials: z.number().int().nonnegative(),
      baselineNoOutcome: z.number().int().nonnegative(),
      /** The most the baseline may pass, of every try it ran. */
      baselineMaxPassed: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      stage: z.literal('confirm'),
      delta: z.number(),
      confidence: z.number(),
      dev: DraftEvaluationSplitMeasureWireSchema,
      /** `null`: the stage holds no holdout case. */
      holdout: DraftEvaluationSplitMeasureWireSchema.nullable(),
    })
    .strict(),
]);
export type DraftEvaluationMeasureWire = z.infer<typeof DraftEvaluationMeasureWireSchema>;

export const DraftEvaluationStageWireSchema = z
  .object({
    stage: DraftEvaluationStageNameSchema,
    status: DraftEvaluationStageStatusSchema,
    skipReason: DraftEvaluationSkipSchema.nullable(),
    /** The stage's EvalRun (`get_eval_run` reads its trials) — `null` until it starts. */
    runId: z.string().nullable(),
    caseCount: z.number().int().nonnegative(),
    k: z.number().int().nonnegative(),
    /** Its trials × the cost of a recent trial, when it started (or now, while it waits): `null`
     *  while no trial's cost is known. */
    estimateUsd: z.number().nonnegative().nullable(),
    baseline: DraftEvaluationArmTallyWireSchema,
    candidate: DraftEvaluationArmTallyWireSchema,
    cases: z.array(DraftEvaluationCaseRowWireSchema),
    measure: DraftEvaluationMeasureWireSchema.nullable(),
  })
  .strict();
export type DraftEvaluationStageWire = z.infer<typeof DraftEvaluationStageWireSchema>;

const DraftEvaluationSkillRefWireSchema = z
  .object({ skillId: z.string(), version: z.number().int().positive(), name: z.string() })
  .strict();

/** What the evaluation compares, as it was when it started. */
const DraftEvaluationSubjectFields = {
  suite: z
    .object({ id: z.string(), name: z.string(), version: z.number().int().positive() })
    .strict(),
  workerDefinition: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
  /** The draft: its family, version, name and the digest of its content then. */
  candidate: DraftEvaluationSkillRefWireSchema.extend({ draftDigest: z.string() }).strict(),
  /** The published version of the family it would replace; `null` for a new Skill. */
  baseline: DraftEvaluationSkillRefWireSchema.nullable(),
  /** The mechanism the mechanism stage tries; `null`: none named. */
  mechanism: z.string().nullable(),
};

const DraftEvaluationStateFields = {
  id: z.string(),
  status: DraftEvaluationStatusSchema,
  /** The stage running now; `null` once it ended. */
  stage: DraftEvaluationStageNameSchema.nullable(),
  verdict: DraftEvaluationVerdictSchema.nullable(),
  reason: DraftEvaluationReasonSchema.nullable(),
  /** The stage whose outcome gave the verdict. */
  decidedBy: DraftEvaluationStageNameSchema.nullable(),
  /** What its trials cost so far; `null` while a trial with no price has ended. */
  costUsd: z.number().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
};

/** A draft evaluation in brief, for a list. */
export const DraftEvaluationSummaryWireSchema = z
  .object({ ...DraftEvaluationStateFields, ...DraftEvaluationSubjectFields })
  .strict();
export type DraftEvaluationSummaryWire = z.infer<typeof DraftEvaluationSummaryWireSchema>;

/** One environment the evaluation's trials ran in, and how many of each arm's did. */
export const DraftEvaluationEnvironmentWireSchema = z
  .object({
    environment: RunEnvironmentWireSchema,
    baselineTrials: z.number().int().nonnegative(),
    candidateTrials: z.number().int().nonnegative(),
  })
  .strict();
export type DraftEvaluationEnvironmentWire = z.infer<typeof DraftEvaluationEnvironmentWireSchema>;

/** A Skill's content as an arm loads it. */
export const DraftEvaluationSkillContentWireSchema = z
  .object({ name: z.string(), description: z.string(), markdown: z.string() })
  .strict();

/** A draft evaluation whole. */
export const DraftEvaluationWireSchema = z
  .object({
    ...DraftEvaluationStateFields,
    ...DraftEvaluationSubjectFields,
    /** The other Skills both arms load, pinned when it started. */
    otherSkills: z.array(DraftEvaluationSkillRefWireSchema),
    /** The draft's content as evaluated (kept after the draft is gone), and the baseline's
     *  (`null` for a new Skill). Free text reads as every read shows it. */
    candidateContent: DraftEvaluationSkillContentWireSchema,
    baselineContent: DraftEvaluationSkillContentWireSchema.nullable(),
    /** The three stages, in order. */
    stages: z.array(DraftEvaluationStageWireSchema),
    /** Every environment its trials ran in, one when they agree (I-E2). */
    environments: z.array(DraftEvaluationEnvironmentWireSchema),
  })
  .strict();
export type DraftEvaluationWire = z.infer<typeof DraftEvaluationWireSchema>;

/**
 * The check a Skill draft passes before an evaluation starts (§5.5 审查器, level 0): any one
 * failing refuses the start, nothing run (400 `draft_check_failed`, each failing check in
 * `details.problems`).
 *   - `credential_like`: it carries a value shaped like a credential (the detector every scrub and
 *     the publish confirmation use);
 *   - `internal_id`: it carries an id shaped like this platform's (a UUID) — a Skill names things,
 *     not one workspace's rows;
 *   - `oversized`: its text is longer than `DRAFT_CHECK_LIMITS.maxChars` (draft-evaluation.ts;
 *     §5.5 步骤有界);
 *   - `unchanged`: it says exactly what the version it would replace says;
 *   - `edit_budget`: more lines differ from that version (all of them, for a new Skill) than
 *     `DRAFT_CHECK_LIMITS.maxChangedLines` (§5.5 编辑预算);
 *   - `contaminated`: it carries an evaluation suite's canary or a run of a held-out case's text
 *     (the E3-1c seal) — its Worker would be stopped anyway.
 */
export const DRAFT_CHECK_VALUES = [
  'credential_like',
  'internal_id',
  'oversized',
  'unchanged',
  'edit_budget',
  'contaminated',
] as const;
export type DraftCheck = (typeof DRAFT_CHECK_VALUES)[number];

/** One check of the draft that failed (400 `draft_check_failed`'s `details.problems`): `count`
 *  of what it found, or the size it measured, and the limit, where the check has them. */
export const DraftCheckProblemWireSchema = z
  .object({
    check: z.enum(DRAFT_CHECK_VALUES),
    count: z.number().int().nonnegative().nullable(),
    limit: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DraftCheckProblemWire = z.infer<typeof DraftCheckProblemWireSchema>;

// ----- publish evidence (S10 E3-3) ------------------------------------------------------------

/**
 * The verdicts whose failures whoever publishes the draft acknowledges one by one, each with a
 * reason, kept in the publish's audit record (docs/s10-evolution-plan-2026-10-04.md §5.5 结果去哪,
 * victor 2026-10-23 分叉 2 = b, as 「已核对凭据」): `regressed` — the regression cases it lost;
 * `worse` — the dev cases of the confirmation it passed less often than the baseline. Every other
 * verdict is shown, never confirmed (`inconclusive` says the evidence cannot show it is no worse).
 * Evaluation gives evidence; it never publishes, nor stops anyone publishing.
 */
export const PUBLISH_ACKNOWLEDGED_VERDICTS = [
  'regressed',
  'worse',
] as const satisfies readonly DraftEvaluationVerdict[];

/** Whether whoever publishes acknowledges the failures of an evaluation with `verdict`. */
export function publishAcknowledgesVerdict(verdict: DraftEvaluationVerdict | null): boolean {
  return verdict !== null && (PUBLISH_ACKNOWLEDGED_VERDICTS as readonly string[]).includes(verdict);
}

/** The verdicts a family's history of drafts that did not hold shows (`familyHistory`). */
export const FAMILY_HISTORY_VERDICTS = [
  'refuted',
  'regressed',
  'worse',
] as const satisfies readonly DraftEvaluationVerdict[];

/** A finished evaluation of the draft as its publish review reads it: in brief, with the stage
 *  that decided its verdict (each case's tries, what the stage's rule measured) and both arms'
 *  trials over every stage that ran (their cost and tokens: what the draft costs against the
 *  baseline). */
export const DraftEvaluationEvidenceWireSchema = DraftEvaluationSummaryWireSchema.extend({
  /** `null` only when the evaluation names no deciding stage. */
  decidingStage: DraftEvaluationStageWireSchema.nullable(),
  baselineTotal: DraftEvaluationArmTallyWireSchema,
  candidateTotal: DraftEvaluationArmTallyWireSchema,
}).strict();
export type DraftEvaluationEvidenceWire = z.infer<typeof DraftEvaluationEvidenceWireSchema>;

/** One failure whoever publishes acknowledges (`PUBLISH_ACKNOWLEDGED_VERDICTS`): a case of the
 *  stage that decided `evaluationId`'s verdict, and both arms' tries on it. */
export const PublishAcknowledgementItemWireSchema = z
  .object({
    evaluationId: z.string(),
    caseId: z.string(),
    title: z.string(),
    split: EvalCaseSplitSchema,
    stage: z.enum(['regression', 'confirm']),
    baseline: DraftEvaluationArmTallyWireSchema,
    candidate: DraftEvaluationArmTallyWireSchema,
  })
  .strict();
export type PublishAcknowledgementItemWire = z.infer<typeof PublishAcknowledgementItemWireSchema>;

/** What became of the draft an evaluation evaluated: its version still holds that very content
 *  (`draft`, `published`, `deprecated`), or the draft is gone — `rejected` by a reviewer
 *  (`reject_draft`) or `discarded` by its proposer. */
export const SKILL_PUBLISH_CANDIDATE_STATE_VALUES = [
  'draft',
  'published',
  'deprecated',
  'rejected',
  'discarded',
] as const;
export const SkillPublishCandidateStateSchema = z.enum(SKILL_PUBLISH_CANDIDATE_STATE_VALUES);
export type SkillPublishCandidateState = z.infer<typeof SkillPublishCandidateStateSchema>;

/** An evaluation of another version of the family, in a publish's evidence. */
export const SkillPublishFamilyEntryWireSchema = DraftEvaluationSummaryWireSchema.extend({
  candidateState: SkillPublishCandidateStateSchema,
}).strict();
export type SkillPublishFamilyEntryWire = z.infer<typeof SkillPublishFamilyEntryWireSchema>;

/**
 * What a Skill draft's evaluations say to whoever publishes it (§5.6 发布审阅) — read with
 * `get_skill_publish_evidence` for the draft as reviewed, `(skillId, version, draftDigest)`, so
 * every evaluation here evaluated exactly this content (I-E3). `publish_skill` reads it again when
 * it publishes, and checks what the caller reviewed against it.
 */
export const SkillPublishEvidenceWireSchema = z
  .object({
    /** The draft's finished evaluations, newest first: the last 20, and every older one whose
     *  verdict is in `PUBLISH_ACKNOWLEDGED_VERDICTS` (its failures are still acknowledged). The
     *  first is the evidence, the one `publish_skill`'s `evaluationReview.evaluationId` names. */
    evaluations: z.array(DraftEvaluationEvidenceWireSchema),
    /** One of the draft's evaluations runs now: `publish_skill` refuses (409 draft_evaluating)
     *  until it ends or is cancelled. */
    runningEvaluationId: z.string().nullable(),
    /** Every failure to acknowledge: each case of each evaluation above whose verdict is in
     *  `PUBLISH_ACKNOWLEDGED_VERDICTS` — a later evaluation of the same content does not take an
     *  earlier one's failures away. */
    acknowledge: z.array(PublishAcknowledgementItemWireSchema),
    /** The evaluations that found another version of the family `refuted`, `regressed` or
     *  `worse` (`FAMILY_HISTORY_VERDICTS`), newest first (the last 10), each with what became of
     *  the draft it evaluated — published versions included (#842 UX P2-1). */
    familyHistory: z.array(SkillPublishFamilyEntryWireSchema),
  })
  .strict();
export type SkillPublishEvidenceWire = z.infer<typeof SkillPublishEvidenceWireSchema>;

/** One acknowledged failure in `publish_skill`'s `evaluationReview`: the case, and why the draft
 *  is published anyway — kept in the audit record. */
export const PublishAcknowledgementSchema = z
  .object({
    evaluationId: z.guid(),
    caseId: z.guid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type PublishAcknowledgement = z.infer<typeof PublishAcknowledgementSchema>;

/** `publish_skill`'s `evaluationReview`: the evidence the caller reviewed — the first of
 *  `SkillPublishEvidenceWire.evaluations`, `null` for none — and its failures acknowledged. The
 *  acknowledgements have no count of their own: the evidence decides how many there are, and a cap
 *  here would leave a draft with more failures than it unpublishable (the request's size limit is
 *  the only bound). */
export const PublishEvaluationReviewSchema = z
  .object({
    evaluationId: z.guid().nullable(),
    acknowledgements: z.array(PublishAcknowledgementSchema).optional(),
  })
  .strict();
export type PublishEvaluationReview = z.infer<typeof PublishEvaluationReviewSchema>;

// ----- seal holds (S10 E3-2c) -----------------------------------------------------------------

/**
 * Where the evaluation seal (E3-1c) stopped content an agent could have put there itself — the
 * refusals it counts towards a pause (legacy 514): a capability's result or error on its way to a
 * Handle, and what a Worker would start with (its Task input comes from whoever invoked it). Not a
 * person's chat message or what the entry agent starts a Turn with: people write those, and every
 * person may read the cases anyway.
 */
export const EVAL_SEAL_HIT_PLACE_VALUES = [
  'capability_result',
  'capability_error',
  'worker_start',
] as const;
export type EvalSealHitPlace = (typeof EVAL_SEAL_HIT_PLACE_VALUES)[number];

/** How many of a pause's refusals were at each counted place — the shape a pause keeps, its audit
 *  row says and the wire carries. */
export const EvalSealHoldPlacesSchema = z
  .object({
    capabilityResult: z.number().int().nonnegative(),
    capabilityError: z.number().int().nonnegative(),
    workerStart: z.number().int().nonnegative(),
  })
  .strict();
export type EvalSealHoldPlaces = z.infer<typeof EvalSealHoldPlacesSchema>;

/** Each counted place's key in `EvalSealHoldPlaces`. */
export const EVAL_SEAL_HOLD_PLACE_KEY: Readonly<
  Record<EvalSealHitPlace, keyof EvalSealHoldPlaces>
> = {
  capability_result: 'capabilityResult',
  capability_error: 'capabilityError',
  worker_start: 'workerStart',
};

/** How many counted refusals within `EVAL_SEAL_HOLD_WINDOW_HOURS` (and since the Principal's last
 *  release) open a pause. Fixed, not a setting (coordinator 2026-10-30). */
export const EVAL_SEAL_HOLD_THRESHOLD = 5;
export const EVAL_SEAL_HOLD_WINDOW_HOURS = 24;

export const EVAL_SEAL_HOLD_STATUS_VALUES = ['active', 'released'] as const;
export const EvalSealHoldStatusSchema = z.enum(EVAL_SEAL_HOLD_STATUS_VALUES);
export type EvalSealHoldStatus = z.infer<typeof EvalSealHoldStatusSchema>;

/**
 * A pause of every agent acting for one Principal (S10 E3-2c, legacy 514): the seal refused
 * `EVAL_SEAL_HOLD_THRESHOLD` times within `EVAL_SEAL_HOLD_WINDOW_HOURS` what agents acting for it
 * were about to receive or start with — the pattern of an agent probing which texts are held out.
 * While `active`, every agent call, Worker start and entry Turn for that Principal is refused
 * (403 `evaluation_probe_hold`, the same whatever path) and so is starting an evaluation when it
 * is the evaluation Principal; it stays so until the workspace owner releases it
 * (`release_eval_seal_hold`) — never by itself.
 *
 *   - `principal`: whose agents are paused; `evaluation` marks the workspace's evaluation service
 *     Principal (every evaluation Task acts for it), whose name is internal.
 *   - `hits` / `places`: the refusals that opened it, by where the seal stopped them. People only
 *     (owner and auditor) — what is told to the paused agents never says where.
 */
export const EvalSealHoldWireSchema = z
  .object({
    id: z.string(),
    principal: z
      .object({
        id: z.string(),
        kind: PrincipalKindSchema,
        displayName: z.string().nullable(),
        evaluation: z.boolean(),
      })
      .strict(),
    status: EvalSealHoldStatusSchema,
    hits: z.number().int().positive(),
    places: EvalSealHoldPlacesSchema,
    openedAt: z.string(),
    releasedAt: z.string().nullable(),
    releasedBy: z.string().nullable(),
    releaseReason: z.string().nullable(),
  })
  .strict();
export type EvalSealHoldWire = z.infer<typeof EvalSealHoldWireSchema>;
