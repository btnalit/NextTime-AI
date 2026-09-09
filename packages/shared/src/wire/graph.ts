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

/**
 * S3.2 冲突检测 (docs/development-tasks.md S3.2, `substrate/epistemic/conflicts.ts`'s
 * `ConflictRow`) — `link_a_id`/`link_b_id` renamed `factAId`/`factBId` on the wire (the resource
 * these ids reference is projected elsewhere as "Fact", never "Link" — docs/wire-contract-
 * conventions.md §2 "引用另一资源时用 `<resource>Id`"). `resolution` is the free-form jsonb
 * `{choice, reason}` `resolve_conflict` (epistemic-handlers.ts) writes, `null` while `open`.
 */
export const ConflictWireSchema = z
  .object({
    id: z.string(),
    conflictType: z.string(),
    status: z.string(),
    factAId: z.string(),
    factBId: z.string(),
    description: z.string().nullable(),
    activityId: z.string(),
    openedAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(),
    resolution: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type ConflictWire = z.infer<typeof ConflictWireSchema>;

/** `decisions` row (`substrate/epistemic/decisions.ts`'s `DecisionRow`) — `record_decision`'s own
 *  resultSchema stays its narrower `{id, status, turnId}` shape (capabilities.ts); this is the
 *  fuller projection `query_decisions`/`find_precedents` return. */
export const DecisionWireSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    activityId: z.string(),
    sourceId: z.string().nullable(),
    summary: z.string().nullable(),
    rationale: z.record(z.string(), z.unknown()).nullable(),
    decidedBy: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .strict();
export type DecisionWire = z.infer<typeof DecisionWireSchema>;

/** `causal_chain` (§9.3 Semantica `get_causal_chain`) — a bounded (`depth` ≤ 5) walk of
 *  `explain()`-shaped steps; see `substrate/epistemic/decisions.ts`'s `causalChain` for how
 *  `rootType`/`chain`/`truncated` are derived. */
export const CausalChainResultWireSchema = z
  .object({
    rootType: z.enum(['fact', 'decision']),
    rootId: z.string(),
    chain: z.array(ExplainResultWireSchema),
    truncated: z.boolean(),
  })
  .strict();
export type CausalChainResultWire = z.infer<typeof CausalChainResultWireSchema>;

/** `decision_impact` (§9.3 Semantica `analyze_decision_impact`) — see `substrate/epistemic/
 *  decisions.ts`'s `decisionImpact` for why `tasks` is `taskIds` (ids only) rather than full Task
 *  objects. */
export const DecisionImpactResultWireSchema = z
  .object({
    decisionId: z.string(),
    facts: z.array(FactWireSchema),
    actionRequests: z.array(
      z
        .object({
          id: z.string(),
          status: z.string(),
          actionKindTag: z.string(),
          gatekeeperId: z.string(),
        })
        .strict(),
    ),
    taskIds: z.array(z.string()),
  })
  .strict();
export type DecisionImpactResultWire = z.infer<typeof DecisionImpactResultWireSchema>;
