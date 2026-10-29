import { z } from 'zod';
import {
  GoalOutcomeBasisSchema,
  PublishableStatusSchema,
  TaskFailureCategorySchema,
  TaskRefusalSchema,
} from '../enums.js';
import { ObjectiveOutcomeBasisSchema } from './attribution.js';

/**
 * wire/skill-stats (S11 W1a E2-1; S10 §5.4, docs/global-roadmap-2026-10-16.md W1a E2): how a Skill
 * family's versions have done — `get_skill_stats`. A projection read when asked (no table of its
 * own), never a new truth: every number traces to `worker_run_skills`, `worker_runs`, `tasks`,
 * the outcome records and `action_requests`.
 *
 * Numbers only (coordinator decision 2026-10-29, fork 7 = a): no Turn, Task or goal ids and no
 * free text — the counts span conversations and goals the reader may not otherwise see.
 *
 *   - Usage: a WorkerRun that loaded the version counts once (a crash retry is a second run).
 *   - Task results: a Task counts under the version its **last** run loaded, and in that run's
 *     environment.
 *   - Outcomes: each outcome subject — a Turn, a Task, a goal step's acceptance, a GoalRun — counts
 *     at most once per version (and once per segment), over the Tasks it covers. A Turn covers
 *     every Task started in it, nested ones too; a goal step's Task uses the step's acceptance
 *     checks when the step declares some, otherwise the goal's outcome — only for the step's
 *     current attempt (and its nested Tasks), never for an attempt it replaced or a superseded
 *     step. Tallied by
 *     `tallyOutcomesByBasis`: `primary` is the attainment rate, `proxy` is shown beside it, never
 *     added. A Turn's or a goal's outcome is joint: "the Turn it ran in was judged achieved", not
 *     "this Skill achieved it".
 *   - Segments: by the run's environment fingerprint (`environmentDigest`); `null` is the segment
 *     of runs whose environment is unknown, never merged into another. 「建议复核」 is a segment's:
 *     its latest `reviewStreak` primary outcomes all not achieved — never compared across segments.
 */

const count = z.number().int().nonnegative();

/** Any outcome basis (`OutcomeBasis`: a Turn's or Task's, or a GoalRun's). */
const OutcomeBasisSchema = z.union([ObjectiveOutcomeBasisSchema, GoalOutcomeBasisSchema]);

/** One basis's count. */
export const OutcomeBasisCountWireSchema = z
  .object({ basis: OutcomeBasisSchema, achieved: count, notAchieved: count })
  .strict();
export type OutcomeBasisCountWire = z.infer<typeof OutcomeBasisCountWireSchema>;

/** One tier of `tallyOutcomesByBasis`: `attainment` is `achieved / total`, `null` with none. */
export const OutcomeTierTallyWireSchema = z
  .object({
    achieved: count,
    notAchieved: count,
    total: count,
    attainment: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type OutcomeTierTallyWire = z.infer<typeof OutcomeTierTallyWireSchema>;

/** `tallyOutcomesByBasis`'s result as sent; `byBasis` has one entry per `OUTCOME_BASIS_VALUES`
 *  value, in that order (an array, so a basis name is a value, never a field name). */
export const OutcomeTallyWireSchema = z
  .object({
    primary: OutcomeTierTallyWireSchema,
    proxy: OutcomeTierTallyWireSchema,
    byBasis: z.array(OutcomeBasisCountWireSchema),
  })
  .strict();
export type OutcomeTallyWire = z.infer<typeof OutcomeTallyWireSchema>;

/** `runs`: WorkerRuns that loaded the version. `tasks`: by the status of the Task whose last run
 *  loaded it (`inProgress`: not finished yet). `lastUsedAt`: the latest such run's start. */
export const SkillUsageWireSchema = z
  .object({
    runs: count,
    tasks: z
      .object({ completed: count, failed: count, cancelled: count, inProgress: count })
      .strict(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type SkillUsageWire = z.infer<typeof SkillUsageWireSchema>;

/** One run environment of a version. `environmentDigest` `null`: runs whose environment is
 *  unknown (before W1a, or the default model with no readable `models.json`). */
export const SkillStatsSegmentWireSchema = z
  .object({
    environmentDigest: z.string().nullable(),
    usage: SkillUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
  })
  .strict();
export type SkillStatsSegmentWire = z.infer<typeof SkillStatsSegmentWireSchema>;

/** One version of the family, with its segments (most recently used first). `reviewSuggested`:
 *  some segment suggests it. */
export const SkillVersionStatsWireSchema = z
  .object({
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    usage: SkillUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
    segments: z.array(SkillStatsSegmentWireSchema),
  })
  .strict();
export type SkillVersionStatsWire = z.infer<typeof SkillVersionStatsWireSchema>;

/** Failed Tasks of one version, grouped by the WorkerDefinition version that ran them × failure
 *  category × what refused them (S10 §5.4 "确定性失败分组"). */
export const SkillFailureGroupWireSchema = z
  .object({
    skillVersion: z.number().int().positive(),
    workerDefinition: z
      .object({
        id: z.string(),
        version: z.number().int().positive(),
        /** The definition's `name`; `null` when it has none. */
        name: z.string().nullable(),
      })
      .strict(),
    category: TaskFailureCategorySchema,
    refusal: TaskRefusalSchema,
    tasks: z.number().int().positive(),
    lastFailedAt: z.string().nullable(),
  })
  .strict();
export type SkillFailureGroupWire = z.infer<typeof SkillFailureGroupWireSchema>;

export const SkillStatsWireSchema = z
  .object({
    skillId: z.string(),
    /** The family's latest version's name. */
    name: z.string(),
    /** `SKILL_REVIEW_STREAK`: how many not-achieved primary outcomes in a row suggest a review. */
    reviewStreak: z.number().int().positive(),
    /** Every version of the family, newest first. */
    versions: z.array(SkillVersionStatsWireSchema),
    /** Largest groups first. */
    failureGroups: z.array(SkillFailureGroupWireSchema),
  })
  .strict();
export type SkillStatsWire = z.infer<typeof SkillStatsWireSchema>;
