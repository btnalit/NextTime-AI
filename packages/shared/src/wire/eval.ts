import { z } from 'zod';
import { OperationModeSchema, PublishableStatusSchema } from '../enums.js';

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
]);
export type EvalSuiteChangeWire = z.infer<typeof EvalSuiteChangeWireSchema>;

export const EvalSuiteWireSchema = EvalSuiteSummaryWireSchema.extend({
  /** Shown to people only; E3-2/3 treat it appearing in a draft or a transcript as contamination. */
  canary: z.string(),
  fixtureGates: z.array(EvalFixtureGateWireSchema),
  /** Every version's change, newest first. */
  history: z.array(EvalSuiteChangeWireSchema),
}).strict();
export type EvalSuiteWire = z.infer<typeof EvalSuiteWireSchema>;
