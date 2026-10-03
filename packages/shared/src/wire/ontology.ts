import { z } from 'zod';
import {
  BlastRadiusSchema,
  OperationModeSchema,
  PrincipalKindSchema,
  PublishableStatusSchema,
} from '../enums.js';
import { OntologyDefinitionSchema } from '../ontology-definition.js';

/**
 * wire/ontology: OntologyVersion resource shape, plus the type-lookup projections `get_type` /
 * `list_types` / `validate` return (docs/wire-contract-conventions.md §5, S3.1). `definition` here
 * stays a loose `z.record` (not `OntologyDefinitionSchema` from `../ontology-definition.js`) — this
 * is the *stored/returned* shape (`ontology_versions.definition`, already validated on the way in
 * by that schema at propose/publish time), not a second input-validation gate; wire schemas
 * elsewhere in this directory make the same choice for other already-validated jsonb columns
 * (`WorkerDefinitionWireSchema.definition`, `wire/worker.ts`).
 *
 * `OntologyVersionWireSchema` mirrors `wire/worker.ts`'s `WorkerDefinitionWireSchema` field-for-
 * field (`id`/`version`/`status`/`definition`/`proposedBy`/`publishedBy`/`createdAt`/
 * `publishedAt`) — same lifecycle (`PublishableStatusSchema`, I12), same "one resource, one wire
 * shape reused via `.pick()` for each capability's own narrower result" convention.
 */

export const OntologyVersionWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    definition: z.record(z.string(), z.unknown()),
    proposedBy: z.string(),
    publishedBy: z.string().nullable(),
    createdAt: z.string(),
    publishedAt: z.string().nullable(),
  })
  .strict();
export type OntologyVersionWire = z.infer<typeof OntologyVersionWireSchema>;

/** `propose_ontology_change`'s result. */
export const OntologyProposeResultWireSchema = OntologyVersionWireSchema.pick({
  id: true,
  version: true,
  status: true,
  proposedBy: true,
  createdAt: true,
});

/** `publish_ontology_version`'s result. */
export const OntologyPublishResultWireSchema = OntologyVersionWireSchema.pick({
  id: true,
  version: true,
  status: true,
  publishedBy: true,
  publishedAt: true,
});

/**
 * `list_ontology_versions`'s item shape (coverage gap G1 part 2, closing wave C5b): unlike
 * `OntologyVersionWireSchema` above (whose `proposedBy`/`publishedBy` stay bare principal ids, the
 * same shape `wire/worker.ts`'s `WorkerDefinitionWireSchema` uses for its own siblings
 * `list_worker_definitions`/`list_skills`), this capability's own `proposedBy` is a resolved
 * `{id, kind, displayName}` — the console's proposal-review list shows who proposed each draft
 * without a second `resolve_refs` round trip for what is meant to be a small review queue.
 * `definition` reuses `OntologyDefinitionSchema` (not the loose `z.record` the sibling
 * `OntologyVersionWireSchema.definition` uses) so the console can diff a draft's own declared
 * object/link/action types structurally, not just render an opaque blob.
 *
 * R-61: `base` is, for a draft, the published version of the draft's own family it was proposed
 * against (R-60), with that version's definition — the console diffs the draft against it, never
 * against the merged type namespace (which already contains the proposer's own draft and every
 * other family). Null for a draft of a new family, or of one with nothing published when it was
 * proposed (everything in it is new), and always null for a published row.
 */
export const OntologyVersionListItemWireSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    proposedBy: z
      .object({
        id: z.string(),
        kind: PrincipalKindSchema,
        displayName: z.string().nullable(),
      })
      .strict(),
    createdAt: z.string(),
    definition: OntologyDefinitionSchema,
    base: z
      .object({
        version: z.number().int().positive(),
        definition: OntologyDefinitionSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type OntologyVersionListItemWire = z.infer<typeof OntologyVersionListItemWireSchema>;

// -------------------------------------------------------------------------------------------
// get_type / list_types — one item shape per `kind` (ObjectType / LinkType / ActionType),
// discriminated on `kind` (docs/wire-contract-conventions.md §1 "kind 只用于类型判别字段").
// -------------------------------------------------------------------------------------------

export const OntologyObjectTypeWireSchema = z
  .object({
    kind: z.literal('object'),
    name: z.string(),
    description: z.string(),
    identityKey: z.array(z.string()).optional(),
  })
  .strict();
export type OntologyObjectTypeWire = z.infer<typeof OntologyObjectTypeWireSchema>;

/** One `domain`/`range` pair a LinkType name is valid for — see `ontology-definition.ts`'s own
 *  doc comment on why a name may carry more than one signature. */
const OntologyLinkTypeSignatureWireSchema = z
  .object({
    domain: z.string(),
    range: z.string(),
    description: z.string(),
  })
  .strict();

export const OntologyLinkTypeWireSchema = z
  .object({
    kind: z.literal('link'),
    name: z.string(),
    signatures: z.array(OntologyLinkTypeSignatureWireSchema).min(1),
  })
  .strict();
export type OntologyLinkTypeWire = z.infer<typeof OntologyLinkTypeWireSchema>;

export const OntologyActionTypeWireSchema = z
  .object({
    kind: z.literal('action'),
    name: z.string(),
    description: z.string(),
    mode: OperationModeSchema,
    blastRadius: BlastRadiusSchema,
    reversibility: z.boolean().optional(),
    autoApprovable: z.boolean().optional(),
    awaitDecision: z.boolean().optional(),
    requesterCanApprove: z.boolean().optional(),
  })
  .strict();
export type OntologyActionTypeWire = z.infer<typeof OntologyActionTypeWireSchema>;

export const OntologyTypeWireSchema = z.discriminatedUnion('kind', [
  OntologyObjectTypeWireSchema,
  OntologyLinkTypeWireSchema,
  OntologyActionTypeWireSchema,
]);
export type OntologyTypeWire = z.infer<typeof OntologyTypeWireSchema>;

/** `validate`'s result — a link's `{linkType, sourceType, targetType}` checked against every
 *  visible LinkType signature sharing its name (I2). */
export const OntologyValidateLinkResultWireSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string()).optional(),
  })
  .strict();
export type OntologyValidateLinkResult = z.infer<typeof OntologyValidateLinkResultWireSchema>;
