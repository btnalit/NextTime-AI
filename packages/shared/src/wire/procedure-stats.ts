import { z } from 'zod';
import {
  ProcedureFailurePlaceSchema,
  PublishableStatusSchema,
  StepRunFailureCategorySchema,
} from '../enums.js';
import { OutcomeTallyWireSchema } from './skill-stats.js';

/**
 * wire/procedure-stats (S11 W1a E2-2; S10 §5.4, docs/global-roadmap-2026-10-16.md W1a E2): how a
 * Procedure family's versions have done — `get_procedure_stats`, and the hint `find_procedures`
 * carries. A projection read when asked (no table of its own), never a new truth: every number
 * traces to `plan_revisions`, `goal_runs`, `step_runs`, `goal_acceptance_checks`, `tasks`,
 * `worker_runs`, `turn_procedure_claims` and `turn_outcomes`.
 *
 * Numbers only, as `get_skill_stats` (coordinator decision 2026-10-29, E2 fork 7 = a): no goal,
 * Turn or Task id and no free text.
 *
 * A Procedure version is used in two ways, kept apart (E2-2 fork 1 = a):
 *   - a goal made from it (`propose_goal`'s `fromProcedure`, plan revision 1's
 *     `source_procedure_*`) — recorded by the platform. Usage counts these goals by their status;
 *     the attainment rate counts their outcomes, each goal once, through `tallyOutcomesByBasis`
 *     (`primary`: `requester`, `verified_by_check`; `proxy`: `reviewer_assessed`).
 *   - a Turn whose entry agent said it followed it (`record_procedure_followed`) — the agent's own
 *     claim, so the requester's outcomes of those Turns are shown beside the rate (`claims`), never
 *     in it, and never suggest a review.
 *
 * Segments: a goal runs many WorkerRuns, so a goal's environment is the set of environment
 * fingerprints its runs ran in (E2-2 fork 2 = a) — the last run of each Task of each step's
 * current attempt, the attempt's nested Tasks included, as E2-1 counts a Task (a replaced attempt
 * or a superseded step did not make the goal's result). Goals whose sets are equal share a segment;
 * a goal with a run whose environment is unknown is in the `null` segment, never merged into
 * another; a goal no Worker has run for yet (still proposed, or ended before its first step ran)
 * is in no segment. 「建议复核」 is a segment's: its latest `reviewStreak` primary outcomes all not
 * achieved.
 */

const count = z.number().int().nonnegative();

/** Goals made from the version, by status (`inProgress`: running, paused, verifying or
 *  cancelling). `lastUsedAt`: the latest such goal's proposal. */
export const ProcedureUsageWireSchema = z
  .object({
    goals: count,
    byStatus: z
      .object({
        proposed: count,
        inProgress: count,
        completed: count,
        cancelled: count,
        failed: count,
      })
      .strict(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type ProcedureUsageWire = z.infer<typeof ProcedureUsageWireSchema>;

/** Turns whose entry agent said it followed the version, and the requester's outcomes of those
 *  that have one. Agent-reported: not in the attainment rate. */
export const ProcedureClaimsWireSchema = z
  .object({
    turns: count,
    achieved: count,
    notAchieved: count,
    lastClaimedAt: z.string().nullable(),
  })
  .strict();
export type ProcedureClaimsWire = z.infer<typeof ProcedureClaimsWireSchema>;

/** One set of run environments of a version's goals. `environmentDigests` sorted; `null`: goals
 *  with a run whose environment is unknown. */
export const ProcedureStatsSegmentWireSchema = z
  .object({
    environmentDigests: z.array(z.string()).nullable(),
    usage: ProcedureUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
  })
  .strict();
export type ProcedureStatsSegmentWire = z.infer<typeof ProcedureStatsSegmentWireSchema>;

/** One version of the family, with its segments (most recently used first). `reviewSuggested`:
 *  some segment suggests it. */
export const ProcedureVersionStatsWireSchema = z
  .object({
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    usage: ProcedureUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    claims: ProcedureClaimsWireSchema,
    reviewSuggested: z.boolean(),
    segments: z.array(ProcedureStatsSegmentWireSchema),
  })
  .strict();
export type ProcedureVersionStatsWire = z.infer<typeof ProcedureVersionStatsWireSchema>;

/** Goals of one version that ended without being achieved, grouped by where they went wrong
 *  (`ProcedureFailurePlace`) × the step × its failure category (S10 §5.4 "确定性失败分组").
 *  `stepKey`: set exactly when `place` is `procedure_step`; `category`: set exactly when `place`
 *  is a step's. */
export const ProcedureFailureGroupWireSchema = z
  .object({
    procedureVersion: z.number().int().positive(),
    place: ProcedureFailurePlaceSchema,
    stepKey: z.string().nullable(),
    category: StepRunFailureCategorySchema.nullable(),
    goals: z.number().int().positive(),
    lastEndedAt: z.string().nullable(),
  })
  .strict();
export type ProcedureFailureGroupWire = z.infer<typeof ProcedureFailureGroupWireSchema>;

export const ProcedureStatsWireSchema = z
  .object({
    procedureId: z.string(),
    /** The family's latest version's name. */
    name: z.string(),
    /** `REVIEW_STREAK`: how many not-achieved primary outcomes in a row suggest a review. */
    reviewStreak: z.number().int().positive(),
    /** Every version of the family, newest first. */
    versions: z.array(ProcedureVersionStatsWireSchema),
    /** Largest groups first. */
    failureGroups: z.array(ProcedureFailureGroupWireSchema),
  })
  .strict();
export type ProcedureStatsWire = z.infer<typeof ProcedureStatsWireSchema>;

/** `find_procedures`' hint for a result (E2-2 fork 4 = a): the primary outcomes of the goals made
 *  from that version — a hint, never what the results are ordered by (S10 §5.4: ordering by it
 *  would keep new Procedures from ever being tried). A small `total` says little. */
export const ProcedureOutcomeHintWireSchema = z.object({ achieved: count, total: count }).strict();
export type ProcedureOutcomeHintWire = z.infer<typeof ProcedureOutcomeHintWireSchema>;
