import { z } from 'zod';
import {
  ActionRequestStatusSchema,
  BlastRadiusSchema,
  GrantStatusSchema,
  PolicyDecisionSchema,
} from '../enums.js';

/**
 * wire/governance: ActionRequest / CapabilityGrant / Policy / Quota wire shapes
 * (docs/wire-contract-conventions.md §5, S3.7). `ActionRequestWireSchema` mirrors
 * `application/gateway/action-request-wire.ts`'s `toWireActionRequest` — the one existing
 * projection function this task's own conventions doc names as the model to follow — field for
 * field; `CapabilityGrantWireSchema`/`PolicyWireSchema`/`QuotaWireSchema` are new (S3.7 wire fix:
 * these three previously leaked their DB row's raw `Date` fields to `dispatchCapability`'s
 * caller — see PR body's wire-changes table).
 */

export const ActionRequestWireSchema = z
  .object({
    id: z.string(),
    status: ActionRequestStatusSchema,
    gatekeeperId: z.string(),
    actionKindTag: z.string(),
    resourceScope: z.string().nullable(),
    blastRadius: BlastRadiusSchema,
    policyDecision: PolicyDecisionSchema.nullable(),
    approvalDecisionId: z.string().nullable(),
    awaitDecision: z.boolean(),
    onBehalfOf: z.string(),
    parentWorkerRunId: z.string().nullable(),
    actorRuntime: z.string(),
    params: z.record(z.string(), z.unknown()),
    requestedAt: z.string(),
    executingAt: z.string().nullable(),
    executedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    requesterCanApprove: z.boolean(),
  })
  .strict();
export type ActionRequestWire = z.infer<typeof ActionRequestWireSchema>;

export const CapabilityGrantWireSchema = z
  .object({
    id: z.string(),
    principalId: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    scope: z.record(z.string(), z.unknown()),
    status: GrantStatusSchema,
    grantedBy: z.string(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  })
  .strict();
export type CapabilityGrantWire = z.infer<typeof CapabilityGrantWireSchema>;

/** `list_policies`/`set_policy`/`set_auto_approved_action_kind` results (S3.7 wire fix, see PR
 *  body): the internal `PolicyRow.actionKind` (mirrors the `policies.action_kind` DB column, used
 *  pervasively that way inside `governance/policy`/`governance/approval`) is renamed to
 *  `actionKindTag` at this wire boundary only — §1's vocabulary table reserves the bare word
 *  `actionKind` for the `{tag,label}` ActionDescription display object; a policy row's action-kind
 *  is the bare tag string, so it gets the tag name (`application/gateway/resource-wire.ts`'s
 *  `toWirePolicy` does the rename; `governance/policy/policies.ts` itself is untouched). */
export const PolicyWireSchema = z
  .object({
    id: z.string(),
    actionKindTag: z.string(),
    blastRadius: BlastRadiusSchema.nullable(),
    autoApprove: z.boolean(),
    requesterCanApprove: z.boolean().nullable(),
    setBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PolicyWire = z.infer<typeof PolicyWireSchema>;

export const QuotaWireSchema = z
  .object({
    key: z.string(),
    value: z.number().nullable(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type QuotaWire = z.infer<typeof QuotaWireSchema>;

/** `list_quotas` (`application/task/quotas.ts`'s `QuotaListEntry` — already wire-clean, distinct
 *  shape from `QuotaWireSchema` above: reports every known key, not only ones with an explicit
 *  override, plus whether the current value is an override or the compiled-in default). */
export const QuotaListEntryWireSchema = z
  .object({
    key: z.string(),
    value: z.number().nullable(),
    isDefault: z.boolean(),
    updatedBy: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type QuotaListEntryWire = z.infer<typeof QuotaListEntryWireSchema>;
