import { z } from 'zod';
import { EpistemicStatusSchema } from '../enums.js';

/**
 * wire/graph: Object / Fact / AuditRecord / Explain wire shapes (docs/wire-contract-conventions.md
 * §2/§5, S3.7) — the graph substrate's own row types (`substrate/graph/store.ts`'s `GraphObject`/
 * `Fact`, `substrate/audit/writer.ts`'s `AuditRecordRow`) carry real `Date` fields internally;
 * these schemas describe the ISO-string wire projection every one of `get_object`/`search`/
 * `state_at`/`get_entry_context`/`find_operations`/`audit_query`/`reconstruct`'s handlers now
 * produces (application/gateway/handlers.ts's `resource-wire.ts` — S3.7 wire fix, see PR body).
 */

export const ObjectWireSchema = z
  .object({
    id: z.string(),
    objectType: z.string(),
    identityKey: z.record(z.string(), z.unknown()).nullable(),
    properties: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ObjectWire = z.infer<typeof ObjectWireSchema>;

export const FactWireSchema = z
  .object({
    id: z.string(),
    linkType: z.string(),
    sourceObjectId: z.string(),
    targetObjectId: z.string(),
    properties: z.record(z.string(), z.unknown()),
    validFrom: z.string(),
    validUntil: z.string().nullable(),
    recordedAt: z.string(),
    supersededAt: z.string().nullable(),
    invalidatedAt: z.string().nullable(),
    invalidationReason: z.string().nullable(),
    supersedesId: z.string().nullable(),
    epistemicStatus: EpistemicStatusSchema,
    confidence: z.number().nullable(),
    activityId: z.string(),
    assertedBy: z.string(),
    verifiedBy: z.string().nullable(),
  })
  .strict();
export type FactWire = z.infer<typeof FactWireSchema>;

export const AuditRecordWireSchema = z
  .object({
    id: z.string(),
    actorPrincipalId: z.string(),
    action: z.string(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
export type AuditRecordWire = z.infer<typeof AuditRecordWireSchema>;

/** `state_at` / `reconstruct`'s shared `{object, facts}` shape (`StateAtResult`/
 *  `ReconstructResult`, substrate/graph/store.ts, substrate/audit/reconstruct.ts). */
export const ObjectFactsWireSchema = z
  .object({
    object: ObjectWireSchema.nullable(),
    facts: z.array(FactWireSchema),
  })
  .strict();

const ExplainPrincipalRefSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    role: z.string().nullable(),
    displayName: z.string().nullable(),
  })
  .strict()
  .nullable();

const ExplainSourceRefSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    uri: z.string().nullable(),
    visibility: z.string(),
    ownerPrincipal: ExplainPrincipalRefSchema,
  })
  .strict()
  .nullable();

const ExplainObservationRefSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    source: ExplainSourceRefSchema,
  })
  .strict();

const ExplainActivityRefSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
    startedByPrincipal: ExplainPrincipalRefSchema,
    observations: z.array(ExplainObservationRefSchema),
    metadata: z.record(z.string(), z.unknown()),
    onBehalfOfPrincipal: ExplainPrincipalRefSchema,
  })
  .strict()
  .nullable();

const ExplainFactRefSchema = z
  .object({
    id: z.string(),
    linkType: z.string(),
    epistemicStatus: z.string(),
    assertedByPrincipal: ExplainPrincipalRefSchema,
    verifiedByPrincipal: ExplainPrincipalRefSchema,
  })
  .strict();

const ExplainDecisionRefSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    summary: z.string().nullable(),
    decidedByPrincipal: ExplainPrincipalRefSchema,
    source: ExplainSourceRefSchema,
  })
  .strict();

/** `explain` (substrate/epistemic/explain.ts's `ExplainResult`) — already ISO-projected by that
 *  module itself, no wire fix needed. */
export const ExplainResultWireSchema = z
  .object({
    nodeType: z.enum(['fact', 'activity', 'decision']),
    fact: ExplainFactRefSchema.optional(),
    decision: ExplainDecisionRefSchema.optional(),
    activity: ExplainActivityRefSchema,
  })
  .strict();
export type ExplainResultWire = z.infer<typeof ExplainResultWireSchema>;
