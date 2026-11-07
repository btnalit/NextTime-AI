import { z } from 'zod';
import { PublishableStatusSchema, TaskFailureCategorySchema, TaskRefusalSchema } from '../enums.js';
import { WorkerSpecFieldSchema } from '../goal-plan.js';
import { OutcomeTallyWireSchema } from './skill-stats.js';

/**
 * wire/worker-definition-stats (S11 GO16a, legacy 569; docs/global-roadmap-2026-10-16.md W4 GO16,
 * S10 §5.4): how a WorkerDefinition family's versions have done — `get_worker_definition_stats`.
 * A projection read when asked (no table of its own), never a new truth: every number traces to
 * `tasks`, `worker_runs`, the outcome records, `plan_revisions` and `action_requests`.
 *
 * Numbers only, as `get_skill_stats` (coordinator decision 2026-10-29, E2 fork 7 = a): no Turn,
 * Task, goal or ActionRequest id and no free text — the counts span conversations and goals the
 * reader may not otherwise see. A WorkerSpec is shown by the names of the fields it sets and a
 * label (`specRef`), never by what it says; its digest only to a caller who can read a goal it ran
 * in (the goal's requester; the workspace owner every goal — `get_goal`'s rule). The digest is an
 * unsalted hash of the WorkerSpec: beside the field names, it would let anyone confirm a guess at
 * a low-entropy setting (a model from the catalog, a token budget) of a goal they cannot read.
 *
 *   - Which Tasks: ordinary work only (`purpose` null — an evaluation's or the goal planner's Task
 *     is not use), each under the version it was created with (`tasks.worker_definition_version`,
 *     pinned for the Task's life). Only published and deprecated versions are listed: a draft never
 *     runs, and a WorkerDefinition draft is its proposer's alone.
 *   - Usage: `runs` counts the WorkerRuns of those Tasks (a crash retry is a second run), `tasks`
 *     the Tasks by status, `lastUsedAt` the latest run's start.
 *   - Outcomes: each outcome subject — a Turn, a Task, a goal step's acceptance, a GoalRun — at
 *     most once per version (and once per segment or combination), over the Tasks it covers, by
 *     the rules `get_skill_stats` counts with: `primary` is the attainment rate, `proxy` is shown
 *     beside it, never added. Joint, as there: "the Turn, step or goal the Task ran in was judged
 *     achieved", not "this definition achieved it".
 *   - Environment segments: a run counts in its own environment (`environmentDigest`, `null` when
 *     unknown, never merged into another), a Task in its last run's. A Task no run has started for
 *     yet is in its version's numbers and in no segment.
 *   - Combinations (GO16): what a Task ran as — the definition as it is (`specDigest` `null`: the
 *     Task is no goal step's, or its step sets no WorkerSpec), or the definition with a step's
 *     WorkerSpec, by the digest the attempt's run configuration keeps. The same digest is the same
 *     WorkerSpec, whichever goal it came from. Every run of a Task counts in its combination.
 *     Environment segments and combinations cut the same Tasks two ways: never add one to the
 *     other.
 *   - 「建议复核」: a segment's or a combination's latest `reviewStreak` primary outcomes all not
 *     achieved, judged on its own; a version's when one of its segments or combinations says so.
 */

const count = z.number().int().nonnegative();

/** `runs`: WorkerRuns of the Tasks. `tasks`: by status (`inProgress`: not finished yet).
 *  `lastUsedAt`: the latest such run's start; `null` when none has started. */
export const WorkerDefinitionUsageWireSchema = z
  .object({
    runs: count,
    tasks: z
      .object({ completed: count, failed: count, cancelled: count, inProgress: count })
      .strict(),
    lastUsedAt: z.string().nullable(),
  })
  .strict();
export type WorkerDefinitionUsageWire = z.infer<typeof WorkerDefinitionUsageWireSchema>;

/** One run environment of a version. `environmentDigest` `null`: runs whose environment is
 *  unknown. */
export const WorkerDefinitionSegmentWireSchema = z
  .object({
    environmentDigest: z.string().nullable(),
    usage: WorkerDefinitionUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
  })
  .strict();
export type WorkerDefinitionSegmentWire = z.infer<typeof WorkerDefinitionSegmentWireSchema>;

/**
 * A combination's label in one response — `null` for the definition as it is. For a WorkerSpec
 * whose digest the caller is given (`specDigest`), the digest's first 12 hex digits, the same
 * wherever it appears; otherwise `#1`, `#2`, … in order of first appearance (versions newest
 * first, then each version's combinations, then the failure groups), the same for the same
 * WorkerSpec across versions and failure groups of the response, and nothing derived from the
 * WorkerSpec. A label tells combinations apart; it identifies nothing outside the response.
 */
export const SpecRefSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{12}|#[1-9][0-9]*)$/)
  .nullable();

/** One combination a version ran as. `specRef` `null`: the definition as it is. `specDigest`:
 *  the WorkerSpec's digest when the caller can read a goal it ran in; `null` otherwise, and for
 *  the definition as it is. `fields`: what the WorkerSpec sets (`WORKER_SPEC_FIELD_VALUES`
 *  order) — `[]` for the definition as it is, `null` when the plan entry the WorkerSpec came from
 *  no longer reads as it (not guessed). */
export const WorkerDefinitionCombinationWireSchema = z
  .object({
    specRef: SpecRefSchema,
    specDigest: z.string().nullable(),
    fields: z.array(WorkerSpecFieldSchema).nullable(),
    usage: WorkerDefinitionUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
  })
  .strict();
export type WorkerDefinitionCombinationWire = z.infer<typeof WorkerDefinitionCombinationWireSchema>;

/** One version of the family. `segments` and `combinations`: most recently used first, those
 *  with no run last. `reviewSuggested`: some segment or combination suggests it. */
export const WorkerDefinitionVersionStatsWireSchema = z
  .object({
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    usage: WorkerDefinitionUsageWireSchema,
    outcomes: OutcomeTallyWireSchema,
    reviewSuggested: z.boolean(),
    segments: z.array(WorkerDefinitionSegmentWireSchema),
    combinations: z.array(WorkerDefinitionCombinationWireSchema),
  })
  .strict();
export type WorkerDefinitionVersionStatsWire = z.infer<
  typeof WorkerDefinitionVersionStatsWireSchema
>;

/** Failed Tasks of one version, grouped by combination × failure category × what refused them
 *  (S10 §5.4 "确定性失败分组"). `specRef` and `specDigest` as on the combination. */
export const WorkerDefinitionFailureGroupWireSchema = z
  .object({
    definitionVersion: z.number().int().positive(),
    specRef: SpecRefSchema,
    specDigest: z.string().nullable(),
    category: TaskFailureCategorySchema,
    refusal: TaskRefusalSchema,
    tasks: z.number().int().positive(),
    lastFailedAt: z.string().nullable(),
  })
  .strict();
export type WorkerDefinitionFailureGroupWire = z.infer<
  typeof WorkerDefinitionFailureGroupWireSchema
>;

export const WorkerDefinitionStatsWireSchema = z
  .object({
    definitionId: z.string(),
    /** The latest listed version's `name`; `null` when it has none. */
    name: z.string().nullable(),
    /** `REVIEW_STREAK`: how many not-achieved primary outcomes in a row suggest a review. */
    reviewStreak: z.number().int().positive(),
    /** The published and deprecated versions, newest first. */
    versions: z.array(WorkerDefinitionVersionStatsWireSchema),
    /** Largest groups first. */
    failureGroups: z.array(WorkerDefinitionFailureGroupWireSchema),
  })
  .strict();
export type WorkerDefinitionStatsWire = z.infer<typeof WorkerDefinitionStatsWireSchema>;
