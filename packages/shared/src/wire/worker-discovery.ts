import { z } from 'zod';
import { StepOutputSchemaSchema } from '../output-schema.js';

/**
 * wire/worker-discovery (S11 GO13; plan §4.12, docs/global-roadmap-2026-10-16.md W2 GO13): what
 * `find_workers` says about each Worker it finds, and why it found none.
 *
 * **Hints, never the order.** `hints` are platform statistics over the version's own Tasks — what
 * a Task of it cost and how its work was judged. Results are not ordered by them, and a planner is
 * told so (S10 §5.4 / C3: ordering by outcome would keep a new version from ever being tried). Both
 * count only the workspace's own ordinary work (`tasks.purpose` null — an evaluation's runs are its
 * suite's, a planning Task is the platform's) that ended within the last
 * {@link WORKER_HINT_WINDOW_DAYS} days, so an old version's long history does not drown what it
 * does now; and each says whether it has at least {@link WORKER_HINT_MIN_SAMPLE} Tasks behind it
 * (`sufficient`) — below that a number says little, and the median is not given.
 *
 * **Gate access** is the caller's: per gate the Worker declares, what a Worker of it delegated by
 * this caller now could do there — `act` (its Handle would carry the gate and an execute-class
 * capability: it can request actions), `observe` (it can read the gate's observe-class
 * Operations), or `none` with the reason, one of the reasons the enforcement points use
 * (`application/gates/observe-access.ts`) plus `no_observable_operation` (nothing published there
 * that the platform lets anyone observe).
 */

/** Tasks ending further back than this many days are not counted in a Worker's hints. */
export const WORKER_HINT_WINDOW_DAYS = 90;
/** Below this many Tasks a hint is marked insufficient (`sufficient: false`). */
export const WORKER_HINT_MIN_SAMPLE = 5;

const count = z.number().int().nonnegative();

export const WorkerHintsWireSchema = z
  .object({
    /** {@link WORKER_HINT_WINDOW_DAYS}: only Tasks that ended within these many days count. */
    windowDays: z.number().int().positive(),
    /** {@link WORKER_HINT_MIN_SAMPLE}: the Task count below which a hint is not sufficient. */
    minSample: z.number().int().positive(),
    /** Tokens a Task of this version used (`tasks.tokens_used`, all its runs), over its Tasks
     *  that completed or failed in the window: the median, `null` when not `sufficient`. */
    cost: z
      .object({
        medianTokens: z.number().nonnegative().nullable(),
        tasks: count,
        sufficient: z.boolean(),
      })
      .strict(),
    /** The primary outcomes (the requester's, or a platform check's — `outcomeBasisTier`) given
     *  on the work of those Tasks, each outcome subject once, as `get_skill_stats` counts them:
     *  how many were achieved of how many given. */
    outcomes: z
      .object({
        achieved: count,
        total: count,
        sufficient: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type WorkerHintsWire = z.infer<typeof WorkerHintsWireSchema>;

export const WORKER_GATE_NO_ACCESS_REASON_VALUES = [
  'gate_not_enabled',
  'excluded_by_policy',
  'excluded_by_profile',
  'no_observable_operation',
] as const;
export type WorkerGateNoAccessReason = (typeof WORKER_GATE_NO_ACCESS_REASON_VALUES)[number];

/** A gate the Worker declares, and what a Worker of it delegated by the caller now could do
 *  there (the module comment). `name` is the gate's, `null` when no gate of that id is here. */
export const WorkerGateAccessWireSchema = z.union([
  z
    .object({
      gatekeeperId: z.string(),
      name: z.string().nullable(),
      access: z.enum(['act', 'observe']),
    })
    .strict(),
  z
    .object({
      gatekeeperId: z.string(),
      name: z.string().nullable(),
      access: z.literal('none'),
      reason: z.enum(WORKER_GATE_NO_ACCESS_REASON_VALUES),
    })
    .strict(),
]);
export type WorkerGateAccessWire = z.infer<typeof WorkerGateAccessWireSchema>;

/** One `find_workers` result: a published `worker` WorkerDefinition version the caller could
 *  delegate to now, its contract, its gates as the caller would reach them, and its hints. */
export const FindWorkerItemWireSchema = z
  .object({
    definitionId: z.string(),
    version: z.number().int().positive(),
    kind: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    inputSchema: StepOutputSchemaSchema.optional(),
    outputSchema: StepOutputSchemaSchema.optional(),
    gates: z.array(WorkerGateAccessWireSchema),
    hints: WorkerHintsWireSchema,
  })
  .strict();
export type FindWorkerItemWire = z.infer<typeof FindWorkerItemWireSchema>;

/**
 * Why `find_workers` found nothing — only on an empty result, when every candidate was read so the
 * counts are exact. `no_match`: no published Worker matches `need` (the goal planner's own family,
 * an entry definition or a version no longer published is not a match). `all_filtered`: some did,
 * and the caller could delegate to none — `notDelegable` declare an execute-class capability the
 * caller does not hold, `excludedByProfile` are left out by the caller's own agent settings. Counts
 * only: the filtered Workers are not named.
 */
export const FindWorkersEmptyReasonWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_match') }).strict(),
  z
    .object({
      kind: z.literal('all_filtered'),
      notDelegable: count,
      excludedByProfile: count,
    })
    .strict(),
]);
export type FindWorkersEmptyReasonWire = z.infer<typeof FindWorkersEmptyReasonWireSchema>;
