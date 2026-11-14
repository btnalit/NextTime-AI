import { z } from 'zod';

/**
 * Legacy 701: moving a gate a workspace connected itself to a new address — a proposal its owner
 * makes and a platform administrator decides (`gate_address_changes`, kernel core 0057).
 *
 * Addresses: the workspace's own views show them with any user info, query and fragment cut out
 * (the kernel's `redactConnectionAddress`); the platform's show only scheme, host and port
 * (`gateAddressOrigin`), as `list_self_connections` does.
 */

export const GATE_ADDRESS_CHANGE_STATUS_VALUES = [
  'proposed',
  'applied',
  'rejected',
  'withdrawn',
  'expired',
] as const;
export const GateAddressChangeStatusWireSchema = z.enum(GATE_ADDRESS_CHANGE_STATUS_VALUES);
export type GateAddressChangeStatusWire = z.infer<typeof GateAddressChangeStatusWireSchema>;

/** What follows the gate to its new address, as its owner previewed it and as the proposal keeps
 *  it for the administrator: every reference is by Gatekeeper id, so each of these applies at the
 *  new host from the moment the change is applied. */
export const GateAddressChangeImpactWireSchema = z
  .object({
    /** Published Operations of this gate; the new host must describe each exactly as published. */
    publishedOperationCount: z.number().int().nonnegative(),
    /** Members (or agents) this gate is granted to (`connect_gatekeeper`), active Grants. */
    grantCount: z.number().int().nonnegative(),
    /** Operations of this gate the workspace approves automatically
     *  (`set_auto_approved_action_kind`). */
    autoApprovedOperations: z.array(z.string()),
    /** Published WorkerDefinitions whose gates include this one. */
    workerDefinitionCount: z.number().int().nonnegative(),
    /** Requests of this gate not finished yet. Each runs only at the address it was made for
     *  (I-A3): once the change is applied, one that has not run is refused there
     *  (`gate_address_changed`) and has to be made again. */
    inFlightActionRequestCount: z.number().int().nonnegative(),
  })
  .strict();
export type GateAddressChangeImpactWire = z.infer<typeof GateAddressChangeImpactWireSchema>;

/** The new host's description of this gate's Operations against what the workspace published. */
export const GateAddressManifestComparisonWireSchema = z
  .object({
    /** True when the new host describes every published Operation exactly as published and
     *  nothing else is to import — the only case a proposal is accepted. */
    matches: z.boolean(),
    manifestDigest: z.string(),
    /** Names the new host describes differently from what is published, or that this workspace
     *  never had. */
    differing: z.array(z.string()),
    /** Published names the new host does not describe. */
    notDescribed: z.array(z.string()),
  })
  .strict();
export type GateAddressManifestComparisonWire = z.infer<
  typeof GateAddressManifestComparisonWireSchema
>;

/** `preview_gate_address_change`'s result. Writes nothing. */
export const GateAddressChangePreviewWireSchema = z
  .object({
    gatekeeperId: z.string(),
    fromEndpoint: z.string(),
    toEndpoint: z.string(),
    manifest: GateAddressManifestComparisonWireSchema,
    impact: GateAddressChangeImpactWireSchema,
    /** Pass to `propose_gate_address_change`: it binds the proposal to this preview (the addresses,
     *  the new secret and the new host's manifest). */
    previewDigest: z.string(),
  })
  .strict();
export type GateAddressChangePreviewWire = z.infer<typeof GateAddressChangePreviewWireSchema>;

/** A proposal, as the workspace sees it (`propose_` / `withdraw_gate_address_change`,
 *  `get_gatekeeper`'s `pendingAddressChange`). */
export const GateAddressChangeWireSchema = z
  .object({
    id: z.string(),
    gatekeeperId: z.string(),
    fromEndpoint: z.string(),
    toEndpoint: z.string(),
    status: GateAddressChangeStatusWireSchema,
    impact: GateAddressChangeImpactWireSchema,
    previewDigest: z.string(),
    proposedBy: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    decidedAt: z.string().nullable(),
    rejectionReason: z.string().nullable(),
  })
  .strict();
export type GateAddressChangeWire = z.infer<typeof GateAddressChangeWireSchema>;

/** Legacy 715: how the gate's latest proposal that is no longer open ended, as its owner reads it
 *  (`get_gatekeeper`'s `lastAddressChangeOutcome`). Proposals of one gate follow one another (one
 *  open at a time, I-A2), so the latest created is the latest ended. */
export const GateAddressChangeOutcomeWireSchema = z
  .object({
    id: z.string(),
    gatekeeperId: z.string(),
    /** As the workspace's own views show addresses. */
    fromEndpoint: z.string(),
    toEndpoint: z.string(),
    /** `expired` also for a proposal past its expiry that nothing has recorded so yet. */
    status: z.enum(['applied', 'rejected', 'withdrawn', 'expired']),
    createdAt: z.string(),
    /** When it ended: decided by a platform administrator (`applied` / `rejected`), withdrawn by an
     *  owner, or — `expired` — its expiry, whenever that was recorded. */
    endedAt: z.string(),
    /** `rejected` only: the reason the platform administrator gave, as written (credential-shaped
     *  text masked as all free text is); `null` when none was given, and for every other status.
     *  Who decided stays on the platform side. */
    rejectionReason: z.string().nullable(),
    /** `applied` only: no account credential moves with a gate, so any connected at the old
     *  address (`fromEndpoint`) were left there when the change was applied, for the owner to
     *  clear — the term the applied change's audit row uses. A fact of that moment: the kernel
     *  does not know whether they were cleared since. */
    accountCredentialsLeftOnOldHost: z.boolean(),
  })
  .strict();
export type GateAddressChangeOutcomeWire = z.infer<typeof GateAddressChangeOutcomeWireSchema>;

/** A proposal, as the platform sees it (`list_`, `approve_`, `reject_gate_address_change`). */
export const PlatformGateAddressChangeWireSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    gatekeeperId: z.string(),
    /** The generic connector of the gate's transport kind (`http` / `mcp` / `cli` / `ssh`). */
    connector: z.string(),
    /** Scheme, host and port only. */
    target: z.string(),
    fromEndpoint: z.string(),
    toEndpoint: z.string(),
    status: GateAddressChangeStatusWireSchema,
    impact: GateAddressChangeImpactWireSchema,
    manifestDigest: z.string(),
    /** Pass to `approve_gate_address_change`: the approval is of this proposal as read. */
    previewDigest: z.string(),
    proposedByName: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
    decidedAt: z.string().nullable(),
    decidedByLogin: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    /** Set while the platform suspends this self connection; a proposal may still be decided. */
    suspended: z.boolean(),
  })
  .strict();
export type PlatformGateAddressChangeWire = z.infer<typeof PlatformGateAddressChangeWireSchema>;
