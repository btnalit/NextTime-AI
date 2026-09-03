import { OperationSchema } from '@nexttime/shared';
import { z } from 'zod';

/**
 * The Gatekeeper wire protocol (design doc §5.1.4, §7.5): `describe_operations` / `observe` /
 * `simulate` / `apply` / `revert` / `health`, exposed by `server.ts` under `POST /gate/<op>` (a
 * GET for `describe_operations`/`health`, which carry no body). Every request/response shape here
 * is a Zod schema — the kernel's `adapters/gatekeeper-client` validates against the same shapes
 * (imported from this package) so the two sides can never silently drift.
 *
 * `params`/`data` are `unknown` at this layer: a request's `params` is validated against the
 * *invoked Operation's own* `params_schema` (JSON Schema, not Zod — see `params-validation.ts`)
 * inside `GatekeeperBase`, not here.
 */

export const ObservedFactCandidateSchema = z.object({
  objectType: z.string(),
  identity: z.record(z.string(), z.unknown()),
  properties: z.record(z.string(), z.unknown()).optional(),
});
export type ObservedFactCandidate = z.infer<typeof ObservedFactCandidateSchema>;

export const OnBehalfOfSchema = z.string().min(1).optional();

// -------------------------------------------------------------------------------------------
// describe_operations
// -------------------------------------------------------------------------------------------

export const DescribeOperationsRequestSchema = z.object({}).strict();
export type DescribeOperationsRequest = z.infer<typeof DescribeOperationsRequestSchema>;

export const DescribeOperationsResponseSchema = z.object({
  operations: z.array(OperationSchema),
});
export type DescribeOperationsResponse = z.infer<typeof DescribeOperationsResponseSchema>;

// -------------------------------------------------------------------------------------------
// observe
// -------------------------------------------------------------------------------------------

export const ObserveRequestSchema = z.object({
  operation: z.string().min(1),
  params: z.unknown().optional(),
  onBehalfOf: OnBehalfOfSchema,
});
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;

export const ObserveResponseSchema = z.object({
  data: z.unknown(),
  observedFacts: z.array(ObservedFactCandidateSchema).optional(),
});
export type ObserveResponse = z.infer<typeof ObserveResponseSchema>;

// -------------------------------------------------------------------------------------------
// simulate — a transport-specific dry-run description when available, else the would-be
// command/request without executing (design doc §7.5, S2.4 deliverable A).
// -------------------------------------------------------------------------------------------

export const SimulateRequestSchema = z.object({
  operation: z.string().min(1),
  params: z.unknown().optional(),
  onBehalfOf: OnBehalfOfSchema,
});
export type SimulateRequest = z.infer<typeof SimulateRequestSchema>;

export const SimulateResponseSchema = z.object({
  /** Human-readable description of what `apply` would do — always present. */
  description: z.string(),
  /** Transport-specific structured detail (e.g. the resolved HTTP method+URL, the rendered
   *  command argv, the classified ssh command) when the transport can produce one. */
  detail: z.unknown().optional(),
});
export type SimulateResponse = z.infer<typeof SimulateResponseSchema>;

// -------------------------------------------------------------------------------------------
// apply — idempotent by `idempotencyKey` (design doc §5.1.4 Gatekeeper protocol "apply 幂等").
// -------------------------------------------------------------------------------------------

export const ApplyRequestSchema = z.object({
  operation: z.string().min(1),
  params: z.unknown().optional(),
  onBehalfOf: OnBehalfOfSchema,
  idempotencyKey: z.string().min(1),
});
export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

export const ApplyResponseSchema = z.object({
  data: z.unknown(),
  observedFacts: z.array(ObservedFactCandidateSchema).optional(),
  /** `true` when this response was served from the idempotency store rather than freshly
   *  executed (a repeat `apply` for the same `idempotencyKey`). */
  replayed: z.boolean(),
});
export type ApplyResponse = z.infer<typeof ApplyResponseSchema>;

// -------------------------------------------------------------------------------------------
// revert
// -------------------------------------------------------------------------------------------

export const RevertRequestSchema = z.object({
  operation: z.string().min(1),
  params: z.unknown().optional(),
  onBehalfOf: OnBehalfOfSchema,
  /** The `idempotencyKey` of the `apply` call being reverted, when known. */
  idempotencyKey: z.string().min(1).optional(),
});
export type RevertRequest = z.infer<typeof RevertRequestSchema>;

export const RevertResponseSchema = z.object({
  data: z.unknown(),
});
export type RevertResponse = z.infer<typeof RevertResponseSchema>;

// -------------------------------------------------------------------------------------------
// health
// -------------------------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  detail: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// -------------------------------------------------------------------------------------------
// connected-accounts (S2.13, design doc §5.1.4 ConnectedAccount, §11 "凭证只在门"): a write-only
// store keyed by `onBehalfOf` — no `GET`/read endpoint exists or ever should (server.ts's own doc
// comment). The kernel's `create_connection`/`connect_gatekeeper` capability handlers
// (application/gateway/connection-handlers.ts) are the only intended caller.
// -------------------------------------------------------------------------------------------

export const StoreConnectedAccountRequestSchema = z.object({
  onBehalfOf: z.string().min(1),
  credential: z.record(z.string(), z.unknown()),
});
export type StoreConnectedAccountRequest = z.infer<typeof StoreConnectedAccountRequestSchema>;

export const StoreConnectedAccountResponseSchema = z.object({ stored: z.literal(true) });
export type StoreConnectedAccountResponse = z.infer<typeof StoreConnectedAccountResponseSchema>;

export const DeleteConnectedAccountRequestSchema = z.object({
  onBehalfOf: z.string().min(1),
});
export type DeleteConnectedAccountRequest = z.infer<typeof DeleteConnectedAccountRequestSchema>;

export const DeleteConnectedAccountResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteConnectedAccountResponse = z.infer<typeof DeleteConnectedAccountResponseSchema>;
