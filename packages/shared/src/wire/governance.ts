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

/** Legacy 287: an `executing` ActionRequest whose `gate/apply` got no answer — the connection
 *  broke after the request may have been sent, the call timed out, or the answer was not the
 *  gate's protocol. Whether it ran is unknown until the platform asks the gate (the
 *  stale-executing reaper, past its stale timeout); until then the row holds its Gatekeeper's
 *  queue (R-50). `since`: when the first such call was recorded. `reason`: the kernel's reason,
 *  as audited (`action_request.outcome_in_doubt`). */
export const ActionRequestOutcomeInDoubtWireSchema = z
  .object({
    since: z.string(),
    reason: z.string().nullable(),
  })
  .strict();
export type ActionRequestOutcomeInDoubtWire = z.infer<typeof ActionRequestOutcomeInDoubtWireSchema>;

/** Legacy 287: why an `approved` / `auto_approved` ActionRequest has not run — an earlier row on
 *  the same Gatekeeper holds the queue: one awaiting approval (`pending_approval`), or one still
 *  `executing` (R-50), and whether that one's outcome is in doubt. Only its status, never its id
 *  or content: the caller may not be allowed to see that row (I14). */
export const ActionRequestQueuedBehindWireSchema = z
  .object({
    status: z.enum(['pending_approval', 'executing']),
    outcomeInDoubt: z.boolean(),
  })
  .strict();
export type ActionRequestQueuedBehindWire = z.infer<typeof ActionRequestQueuedBehindWireSchema>;

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
    // Nullable: rows written before migrations/governance/0007 have no value on file
    // (governance/approval/types.ts's own `ActionRequestRow.requesterCanApprove` doc comment).
    requesterCanApprove: z.boolean().nullable(),
    // S6-A C25 (docs/console-completion-plan.md §5.8, §6 `approve{reason?}`): the human decision
    // behind `approvalDecisionId`, read from the Approval Decision row (`decisions.rationale.reason`
    // / `decided_by` / `decided_at`) by the handlers that return decided rows (`approve`, `reject`,
    // `get_action`, `list_pending`, `list_action_requests` — application/gateway/handlers.ts's
    // `withApprovalDecision`). `null` = no human decision (pending, auto-approved, denied, expired,
    // or a reason-less decision for `decisionReason`). *Optional* because `request_action`'s own
    // result projections (request-action-handler.ts) are produced at request time, where no
    // decision can exist yet, and are not touched by this change — a consumer treats absence
    // exactly like `null`.
    decisionReason: z.string().nullable().optional(),
    decidedBy: z.string().nullable().optional(),
    decidedAt: z.string().nullable().optional(),
    // Decision 2026-10-09 "二次确认": how many suspected credential values `params` carries —
    // the count `approve` requires `credentialsReviewed: true` for (kernel governance/redaction/
    // credential-review.ts, the same detector that scrubs agent output). Absent when zero.
    suspectedSecretValues: z.number().int().positive().optional(),
    // Where in `params` they are: dot paths (`headers.Authorization`, `[i]` for array items, at
    // most 20) naming fields only, never a fragment of a value. Present exactly when the count is.
    suspectedSecretPaths: z.array(z.string()).max(20).optional(),
    // Legacy 287: why a row that has not finished is still waiting, derived on read by the
    // handlers that return listed / single rows (`withApprovalDecision`, as `decisionReason`).
    // `outcomeInDoubt`: set on an `executing` row whose `apply` got no answer, else `null`.
    // `queuedBehind`: set on an `approved` / `auto_approved` row that an earlier row holds back,
    // else `null`. Optional for the same reason as `decisionReason`.
    outcomeInDoubt: ActionRequestOutcomeInDoubtWireSchema.nullable().optional(),
    queuedBehind: ActionRequestQueuedBehindWireSchema.nullable().optional(),
    // Legacy 218 / UX acceptance of #592 (P2-1): on a `pending_approval` row (the handlers that
    // add the decision fields) — the version of this Operation its gate publishes now, and whether
    // this request was made against that definition. "Always allow" from a request is accepted
    // only when it was (409 `version_changed` otherwise), and covers that version only. Absent on
    // other rows, and when the gate publishes no such Operation.
    publishedDefinition: z
      .object({ version: z.number().int().positive(), requestIsCurrent: z.boolean() })
      .strict()
      .optional(),
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
 *  `toWirePolicy` does the rename; `governance/policy/policies.ts` itself is untouched).
 *  `gatekeeperId` (R-20 / D-15): the gate a gate-scoped rule applies to — "Always allow" writes
 *  only these — or `null` for a workspace-wide rule (every gate; it can only require approval). */
/** Legacy 218: whether a gate-scoped "always allow" still applies — see `PolicyWireSchema`. */
export const AutoApproveConsentSchema = z.enum(['current', 'definition_changed', 'not_recorded']);
export type AutoApproveConsent = z.infer<typeof AutoApproveConsentSchema>;

export const PolicyWireSchema = z
  .object({
    id: z.string(),
    gatekeeperId: z.string().nullable(),
    actionKindTag: z.string(),
    blastRadius: BlastRadiusSchema.nullable(),
    autoApprove: z.boolean(),
    requesterCanApprove: z.boolean().nullable(),
    setBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    // Legacy 218: an "always allow" (gate-scoped `autoApprove: true`) allows one definition of the
    // Operation — `operationVersion` is the published version it was given for (`null` on every
    // other rule, and on one written before the definition was recorded).
    // `publishedOperationVersion` is the version published on the gate now (`null` for a
    // workspace-wide rule or when none is). `autoApproveConsent` says whether the rule applies:
    // `current` (or not an "always allow"), `definition_changed` (another definition was
    // published since, or its blast radius went up — calls go back through approval until a
    // person allows the current one), `not_recorded` (no definition on file — likewise suspended).
    operationVersion: z.number().int().positive().nullable(),
    publishedOperationVersion: z.number().int().positive().nullable(),
    autoApproveConsent: AutoApproveConsentSchema,
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
