import { z } from 'zod';
import { OperationSchema } from '../action-description.js';
import {
  ConnectionRequestStatusSchema,
  OperationModeSchema,
  PublishableStatusSchema,
} from '../enums.js';
import { BlastRadiusSchema, PrincipalKindSchema } from '../enums.js';

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

export const OperationSummaryWireSchema = z
  .object({
    gatekeeperId: z.string(),
    name: z.string(),
    mode: OperationModeSchema,
    blastRadius: BlastRadiusSchema,
    autoApprovable: z.boolean(),
    version: z.number().int().positive(),
    status: PublishableStatusSchema,
  })
  .strict();
export type OperationSummaryWire = z.infer<typeof OperationSummaryWireSchema>;

/** `get_gatekeeper`'s result: the summary plus its Operations and a live health probe. */
export const GatekeeperDetailWireSchema = GatekeeperSummaryWireSchema.extend({
  operations: z.array(OperationSummaryWireSchema),
  health: z.enum(['ok', 'unreachable', 'unauthorized']),
});

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

/** `publish_manifest`'s result. */
export const PublishManifestResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    publishedOperationNames: z.array(z.string()),
    skippedDraftOperationNames: z.array(z.string()),
  })
  .strict();

/** `create_connection`'s result (connection-handlers.ts's `createConnectionHandler`). */
export const CreateConnectionResultWireSchema = z
  .object({
    gatekeeperId: z.string(),
    importedOperationNames: z.array(z.string()),
    skippedOperationNames: z.array(z.string()),
    connectionRequestId: z.string().nullable(),
  })
  .strict();
