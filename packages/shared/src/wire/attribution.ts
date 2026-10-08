import { z } from 'zod';
import { ObjectiveOutcomeSchema, TurnStatusSchema } from '../enums.js';

/**
 * wire/attribution: S10 E1 结果归因 (docs/s10-evolution-plan-2026-10-04.md §3.1 / §5.3) — what a
 * piece of work used and whether it achieved its goal. Shared by the Task read model
 * (`wire/task.ts`) and the per-Turn read of a Chat (`list_chat_turns`, `mark_turn_outcome`).
 *
 * Every field that may be unknown is `null`, never omitted: an old row and a row nobody has marked
 * read the same ("未记录" / "unknown"), and a client never has to guess which.
 */

/** An objective outcome on record — who gave it and when. `revision` 2 means the giver corrected
 *  it once (from `previousOutcome`); there is no third revision. */
export const ObjectiveOutcomeWireSchema = z
  .object({
    outcome: ObjectiveOutcomeSchema,
    givenBy: z.string(),
    givenAt: z.string(),
    revision: z.number().int().min(1).max(2),
    previousOutcome: ObjectiveOutcomeSchema.nullable(),
  })
  .strict();
export type ObjectiveOutcomeWire = z.infer<typeof ObjectiveOutcomeWireSchema>;

/** A Skill version a WorkerRun loaded (`worker_run_skills`, recorded by the kernel when it created
 *  the run — authoritative). `name` is the Skill's own name at that version. */
export const SkillLoadWireSchema = z
  .object({
    skillId: z.string(),
    version: z.number().int().positive(),
    name: z.string(),
  })
  .strict();
export type SkillLoadWire = z.infer<typeof SkillLoadWireSchema>;

/** The Procedure version a Turn's entry agent said it followed (`turn_procedure_claims`).
 *  `basis` is always `claimed`: the agent's own report, not something the kernel observed. */
export const ProcedureClaimWireSchema = z
  .object({
    procedureId: z.string(),
    version: z.number().int().positive(),
    name: z.string(),
    basis: z.literal('claimed'),
    claimedAt: z.string(),
  })
  .strict();
export type ProcedureClaimWire = z.infer<typeof ProcedureClaimWireSchema>;

/** One Turn with its attribution: execution status, the Procedure it claimed to follow, and the
 *  requester's objective outcome. `startedBy` is the requester — the only principal who may give
 *  that outcome (`mark_turn_outcome`). */
export const TurnAttributionWireSchema = z
  .object({
    id: z.string(),
    chatId: z.string().nullable(),
    startedBy: z.string().nullable(),
    status: TurnStatusSchema,
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    procedure: ProcedureClaimWireSchema.nullable(),
    outcome: ObjectiveOutcomeWireSchema.nullable(),
  })
  .strict();
export type TurnAttributionWire = z.infer<typeof TurnAttributionWireSchema>;
