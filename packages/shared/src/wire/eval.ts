import { z } from 'zod';
import { OperationModeSchema, PublishableStatusSchema } from '../enums.js';
import {
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
