import { z } from 'zod';
import { COMBINATION_SHORTFALL_VALUES } from '../combination.js';
import { WorkerSpecFieldSchema, WorkerSpecSchema } from '../goal-plan.js';
import { SpecRefSchema } from './worker-definition-stats.js';

/**
 * wire/combination-candidates (S11 GO16b; the rules are `../combination.ts`'s):
 * `get_combination_candidates` — the combinations of a WorkerDefinition family's published
 * versions that qualify to become definitions of their own — and the derivation a family made
 * from one carries (`WorkerDefinitionWire.derivedFrom`, `propose_definition_from_combination`).
 *
 * A candidate is read, never stored, and authorizes nothing: proposing one judges it again. Its
 * numbers and the names of the fields its WorkerSpec sets are the builders'; what the WorkerSpec
 * says (and so the definition it would become) and its digest only for a caller who can read a
 * goal it ran in (`spec`, `definition` and `specDigest` `null` otherwise — GO16 F7 = A, and the
 * digest as `get_worker_definition_stats` gives it, review #493 on #1064).
 */

const count = z.number().int().nonnegative();

/** `CombinationEvidence`, as sent; `windowDays` is `COMBINATION_WINDOW_DAYS`. */
export const CombinationEvidenceWireSchema = z
  .object({
    achieved: count,
    notAchieved: count,
    goals: count,
    rate: z.number().min(0).max(1).nullable(),
    windowDays: z.number().int().positive(),
  })
  .strict();
export type CombinationEvidenceWire = z.infer<typeof CombinationEvidenceWireSchema>;

export const CombinationShortfallSchema = z.enum(COMBINATION_SHORTFALL_VALUES);

export const CombinationCandidateWireSchema = z
  .object({
    definitionId: z.string(),
    version: z.number().int().positive(),
    /** Its label in this response, as `get_worker_definition_stats`'s (`SpecRefSchema`):
     *  the digest's first 12 hex digits with `specDigest`, otherwise `#1`, `#2`, …; never
     *  `null` here. */
    specRef: SpecRefSchema,
    /** The WorkerSpec's digest — what `propose_definition_from_combination` takes — when the
     *  caller can read a goal it ran in; `null` otherwise. */
    specDigest: z.string().nullable(),
    /** The fields the WorkerSpec sets (`WORKER_SPEC_FIELD_VALUES` order). */
    fields: z.array(WorkerSpecFieldSchema),
    evidence: CombinationEvidenceWireSchema,
    /** The WorkerSpec, when the caller can read a goal it ran in; `null` otherwise. */
    spec: WorkerSpecSchema.nullable(),
    /** What proposing it writes, but for its `name` (`mergeCombinationDefinition`); `null` with
     *  `spec`. */
    definition: z.record(z.string(), z.unknown()).nullable(),
    /** Families already derived from it that the caller can see (a published version, or their
     *  own draft), newest first. */
    derivedAs: z.array(z.string()),
  })
  .strict();
export type CombinationCandidateWire = z.infer<typeof CombinationCandidateWireSchema>;

export const CombinationCandidatesWireSchema = z
  .object({
    definitionId: z.string(),
    /** `COMBINATION_MIN_ACHIEVED`, `COMBINATION_MIN_GOALS`, `COMBINATION_MIN_RATE`. */
    thresholds: z
      .object({
        windowDays: z.number().int().positive(),
        minAchieved: z.number().int().positive(),
        minGoals: z.number().int().positive(),
        minRate: z.number().min(0).max(1),
      })
      .strict(),
    /** Most achieved first. */
    candidates: z.array(CombinationCandidateWireSchema),
  })
  .strict();
export type CombinationCandidatesWire = z.infer<typeof CombinationCandidatesWireSchema>;

/** Where a WorkerDefinition family came from, when a person derived it from a combination
 *  (worker/0014): the base version and the evidence when proposed. Written by the kernel once for
 *  the family, never changed. Not the WorkerSpec's digest: every reader of the family sees this,
 *  and the digest covers step-only fields the definition does not carry (an observe scope, a
 *  token budget) — beside the definition it would confirm a guess at them. The table and the
 *  proposal's audit record keep it. */
export const WorkerDefinitionDerivationWireSchema = z
  .object({
    definitionId: z.string(),
    version: z.number().int().positive(),
    evidence: CombinationEvidenceWireSchema,
    derivedAt: z.string(),
  })
  .strict();
export type WorkerDefinitionDerivationWire = z.infer<typeof WorkerDefinitionDerivationWireSchema>;

/** 409 `combination_not_eligible`'s `details`: what keeps it from qualifying now, and its
 *  evidence. */
export const CombinationNotEligibleDetailsSchema = z
  .object({
    shortfalls: z.array(CombinationShortfallSchema).min(1),
    evidence: CombinationEvidenceWireSchema,
  })
  .strict();
export type CombinationNotEligibleDetails = z.infer<typeof CombinationNotEligibleDetailsSchema>;
