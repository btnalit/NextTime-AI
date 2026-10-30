import { z } from 'zod';
import {
  OperationModeSchema,
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

// ----- evaluation runs (S10 E3-2a) -------------------------------------------------------------

/**
 * An evaluation run (S10 E3-2a; docs/s10-evolution-plan-2026-10-04.md §3.1 EvalRun, §5.5 账本恒等式,
 * §5.6 评测运行详情): one person-started run of a suite's cases against the WorkerDefinition version
 * the suite pinned, at the suite version they looked at. Each case is tried `k` times per arm; each
 * try is a trial — an evaluation Task (`TaskWire.purpose = evaluation`) whose every gate call the
 * kernel answers from the case's fixtures, and whose report and calls the case's assertions judge.
 * Human channel only (I-E4).
 *
 *   - `kind`: `case_trial` — one case, once, as it would run now (E3-2a's 「试跑」). Draft runs
 *     (candidate against baseline, many cases, `k` tries each) are E3-2b.
 *   - `arm`: `baseline` — the suite's pinned WorkerDefinition version with the Skill versions it
 *     loads now. E3-2b adds `candidate`.
 *   - A run is `running` until every trial it holds has ended, then `finished` — and the database
 *     refuses `finished` unless it holds exactly arms × cases × k trials, all ended (§5.5 账本恒等式).
 *   - A trial is `running` while its Task runs, then `scored` (`verdict` passed: every assertion
 *     satisfied; failed otherwise) when its Worker reported a result, or `errored` when it ended
 *     without one (`error` says how: the Task's failure reason, `cancelled`, or `withheld` — what it
 *     would start with carried another case's held-out text or a canary).
 */
export const EVAL_RUN_KIND_VALUES = ['case_trial'] as const;
export const EvalRunKindSchema = z.enum(EVAL_RUN_KIND_VALUES);
export type EvalRunKind = z.infer<typeof EvalRunKindSchema>;

export const EVAL_ARM_VALUES = ['baseline'] as const;
export const EvalArmSchema = z.enum(EVAL_ARM_VALUES);
export type EvalArm = z.infer<typeof EvalArmSchema>;

export const EVAL_RUN_STATUS_VALUES = ['running', 'finished'] as const;
export const EvalRunStatusSchema = z.enum(EVAL_RUN_STATUS_VALUES);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

export const EVAL_TRIAL_STATUS_VALUES = ['running', 'scored', 'errored'] as const;
export const EvalTrialStatusSchema = z.enum(EVAL_TRIAL_STATUS_VALUES);
export type EvalTrialStatus = z.infer<typeof EvalTrialStatusSchema>;

export const EVAL_TRIAL_VERDICT_VALUES = ['passed', 'failed'] as const;
export const EvalTrialVerdictSchema = z.enum(EVAL_TRIAL_VERDICT_VALUES);
export type EvalTrialVerdict = z.infer<typeof EvalTrialVerdictSchema>;

/** How an `errored` trial ended: its Task's failure reason, `cancelled`, or `withheld`. */
export const EVAL_TRIAL_ERROR_VALUES = [
  ...TASK_FAILURE_REASON_VALUES,
  'cancelled',
  'withheld',
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
    /** The evaluation Task the trial ran as. */
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
    startedAt: z.string(),
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
  })
  .strict();
export type EvalBudgetWire = z.infer<typeof EvalBudgetWireSchema>;
