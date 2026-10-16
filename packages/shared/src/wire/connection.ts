import { z } from 'zod';
import { OperationSchema } from '../action-description.js';
import {
  ConnectionRequestStatusSchema,
  OperationModeSchema,
  PublishableStatusSchema,
} from '../enums.js';
import { BlastRadiusSchema, PrincipalKindSchema } from '../enums.js';
import {
  GateOwnedParamDraftWireSchema,
  GateOwnedParamWireSchema,
  OperationGovernanceChangeWireSchema,
} from './platform.js';

/**
 * wire/connection: Gatekeeper / ConnectionRequest / Operation wire shapes
 * (docs/wire-contract-conventions.md §5, S3.7). `GatekeeperSummaryWireSchema`/
 * `OperationSummaryWireSchema`/`OperationStatsWireSchema` mirror
 * `application/gateway/gatekeeper-read-handlers.ts`'s own `toWireGatekeeperSummary`/
 * `toWireOperationSummary`/`toWireOperationStats` (already ISO-string clean, no wire fix needed
 * there); `ConnectionRequestWireSchema` is new (S3.7 wire fix — `list_connection_requests`
 * previously leaked `ConnectionRequestRow`'s raw `Date` fields, see PR body).
 */

const ConnectionKindSchema = z.enum(['http', 'mcp', 'cli', 'ssh']);

export const ConnectionRequestWireSchema = z
  .object({
    id: z.string(),
    status: ConnectionRequestStatusSchema,
    kind: ConnectionKindSchema,
    target: z.string(),
    requestedBy: z.string(),
    gatekeeperId: z.string().nullable(),
    completedBy: z.string().nullable(),
    requestedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type ConnectionRequestWire = z.infer<typeof ConnectionRequestWireSchema>;

/** `request_connection`'s own result shape (connection-handlers.ts's `requestConnectionHandler` —
 *  already hand-projects a subset of `ConnectionRequestWireSchema`'s own fields, no `gatekeeperId`/
 *  `completedBy`/`completedAt` yet since the request has not been resolved). */
export const ConnectionRequestCreatedWireSchema = ConnectionRequestWireSchema.pick({
  id: true,
  status: true,
  kind: true,
  target: true,
  requestedBy: true,
  requestedAt: true,
});

export const GatekeeperSummaryWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
    status: z.literal('active'),
    operationCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();
export type GatekeeperSummaryWire = z.infer<typeof GatekeeperSummaryWireSchema>;

/** Legacy K (UX acceptance of #538): one param of an Operation's `params_schema` — where the gate
 *  sends it (`x-in`, lower-cased; absent = the request body) and whether it is required. */
export const OperationParamSummaryWireSchema = z
  .object({ name: z.string(), in: z.string().optional(), required: z.boolean() })
  .strict();
export type OperationParamSummaryWire = z.infer<typeof OperationParamSummaryWireSchema>;

/** Legacy K: what publishing a revision draft changes in the definition the gate runs —
 *  `changedFields` names the differing definition fields (`binding`, `params_schema`,
 *  `result_mapping`, `mode`, `reversibility`, `blast_radius` for an ssh binding); the params lists
 *  say which params were added, removed or changed (the draft's side). Governance fields are
 *  `governanceChange`'s. */
export const OperationDefinitionChangeWireSchema = z
  .object({
    changedFields: z.array(z.string()),
    paramsAdded: z.array(OperationParamSummaryWireSchema),
    paramsRemoved: z.array(OperationParamSummaryWireSchema),
    paramsChanged: z.array(OperationParamSummaryWireSchema),
  })
  .strict();
export type OperationDefinitionChangeWire = z.infer<typeof OperationDefinitionChangeWireSchema>;

export const OperationSummaryWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    mode: OperationModeSchema,
    blastRadius: BlastRadiusSchema,
    autoApprovable: z.boolean(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    /** S8 W3-K1 (leftover 81): absent (never an empty string) for an Operation with no description
     *  — mirrors `OperationSchema.description`'s own optionality (action-description.ts). */
    description: z.string().optional(),
    /** STATUS leftover 123: the principal that proposed this row (a gate's imported manifest: the
     *  owner who imported it) — whose it is under D-24, so the console offers "edit description"
     *  only where the caller may edit. Absent on a legacy row with no recorded proposer. */
    proposedBy: z.string().optional(),
    /** R-19 (D-17): present only on a `draft` whose identity has a `published` version — what
     *  publishing this draft would change on the version in effect (`before` = that version,
     *  `after` = this draft), with the kernel's direction. The catalog confirms a non-`neutral`
     *  change before it publishes. */
    governanceChange: OperationGovernanceChangeWireSchema.optional(),
    /** Legacy K (UX acceptance of #538): on the same drafts as `governanceChange` — what
     *  publishing it changes in the definition the gate runs, so the catalog can show what a
     *  revision is before it is published. Absent when either version's definition does not parse. */
    definitionChange: OperationDefinitionChangeWireSchema.optional(),
    /** Legacy J (console G4, legacy 219): the params this version's definition declares that only
     *  the gate sets — the same judgment `publish_operation` refuses with 400 `gate_owned_params`.
     *  Absent when there are none. On a draft it says why the draft cannot be published; on a
     *  published row (published before the check existed) the gate refuses every call that passes
     *  one of them. */
    gateOwnedParams: z.array(GateOwnedParamWireSchema).optional(),
    /** UX acceptance of #573 P3-1: who wrote this version — `import` for the gate's own manifest,
     *  `agent` / `human` for a proposal. Absent on a legacy row with none recorded. A held draft
     *  the gate never wrote is told apart from one the gate stopped announcing by this. */
    origin: z.enum(['import', 'agent', 'human']).optional(),
    /** Review #493 on #583 (P2): on a `draft` only — the digest of everything this draft says (its
     *  whole definition, governance fields and description included, and who wrote it). A draft is
     *  revised in place at the same version (its proposer re-proposing, a gate re-import), so the
     *  version alone does not name what the reader looked at: `discard_operation_draft` and
     *  `publish_operation` (legacy 300) require this back, and either refuses 409 `draft_changed`
     *  when the draft is no longer the one shown. Opaque to the console. */
    draftDigest: z.string().optional(),
  })
  .strict();
export type OperationSummaryWire = z.infer<typeof OperationSummaryWireSchema>;

/** `get_gatekeeper`'s result: the summary plus its Operations and a live health probe. */
export const GatekeeperDetailWireSchema = GatekeeperSummaryWireSchema.extend({
  operations: z.array(OperationSummaryWireSchema),
  health: z.enum(['ok', 'unreachable', 'unauthorized']),
});
export type GatekeeperDetailWire = z.infer<typeof GatekeeperDetailWireSchema>;

export const OperationStatsWireSchema = z
  .object({
    gatekeeperId: z.string(),
    operationName: z.string().min(1),
    calls: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    autoApproved: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastCalledAt: z.string(),
  })
  .strict();

/** `propose_operation`'s result (operation-manifest-handlers.ts). */
export const OperationProposeResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    draftOf: z.string().nullable(),
    /** R-19 (D-17): what publishing this draft would change on the identity's `published` version
     *  (`null` when there is none). The onboarding wizard confirms a non-`neutral` change before
     *  its `publish_operation` step. */
    governanceChange: OperationGovernanceChangeWireSchema.nullable(),
    /** Review #493 on #583: the draft just written, as `OperationSummaryWire.draftDigest` names it
     *  — the wizard hands it to its `publish_operation` step, so a draft replaced in between (a
     *  gate re-import writes over any pending draft) is refused rather than published unseen. */
    draftDigest: z.string(),
  })
  .strict();

/** `publish_operation`'s result — the published draft's own full definition (operation-manifest-
 *  handlers.ts's own doc comment: "the owner ... must be able to see exactly what was just
 *  published"). `operation` reuses the pre-existing `OperationSchema` (action-description.ts) —
 *  that schema's own snake_case fields (`params_schema`, `blast_radius`, ...) are the Gatekeeper
 *  manifest wire format (§7.4/§7.5), a separate, already-established contract, not a DB-row leak;
 *  left as-is, out of this task's vocabulary-normalization scope. */
export const OperationPublishResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
    origin: z.enum(['import', 'agent', 'human']).nullable(),
    proposedBy: z.object({ id: z.string(), kind: PrincipalKindSchema }).strict().nullable(),
    operation: OperationSchema,
    supersedes: z.string().nullable(),
  })
  .strict();

export const OperationDeprecateResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    status: PublishableStatusSchema,
  })
  .strict();

/** `discard_operation_draft`'s result (legacy 278): the exact draft version that was marked
 *  `discarded` (`OperationStatus`) — kept as a row, left out of every directory read. */
export const OperationDiscardResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
    status: z.literal('discarded'),
  })
  .strict();
export type OperationDiscardResultWire = z.infer<typeof OperationDiscardResultWireSchema>;

/** `update_operation_description`'s result (S8 W3-K1, leftover 81) — the Operation's new
 *  description, so the catalog row can refresh without a full reload. */
export const UpdateOperationDescriptionResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    description: z.string(),
  })
  .strict();

/** `publish_manifest`'s result. */
export const PublishManifestResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    publishedOperationNames: z.array(z.string()),
    skippedDraftOperationNames: z.array(z.string()),
    /** Legacy J: the gate's own drafts left unpublished because they declare a gate-owned param. */
    gateOwnedParamDrafts: z.array(GateOwnedParamDraftWireSchema),
  })
  .strict();
export type PublishManifestResultWire = z.infer<typeof PublishManifestResultWireSchema>;

/** `mint_connection_secret`'s result (R-01) — shown once, never audited. */
export const MintConnectionSecretResultWireSchema = z
  .object({ connectionSecret: z.string() })
  .strict();
export type MintConnectionSecretResultWire = z.infer<typeof MintConnectionSecretResultWireSchema>;

/** `rotate_connection_secret`'s result (R-01) — shown once, never audited. */
export const RotateConnectionSecretResultWireSchema = z
  .object({ gatekeeperId: z.string(), connectionSecret: z.string() })
  .strict();
export type RotateConnectionSecretResultWire = z.infer<
  typeof RotateConnectionSecretResultWireSchema
>;

/** `create_connection`'s result (connection-handlers.ts's `createConnectionHandler`). */
export const CreateConnectionResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    importedOperationNames: z.array(z.string()),
    skippedOperationNames: z.array(z.string()),
    connectionRequestId: z.string().nullable(),
  })
  .strict();
