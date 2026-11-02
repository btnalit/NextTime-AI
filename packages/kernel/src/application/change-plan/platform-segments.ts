import {
  ADMIN_PROPOSAL_LIST_LIMIT,
  type AdminProposalPlatformItemBlocker,
  type AdminProposalPlatformItemIntentWire,
  type AdminProposalSegmentStatus,
  type AdminProposalSegmentWire,
  type AdminProposalWire,
  type ChangeItemClassification,
  type GateHostedDefinitionWire,
  type GateInstanceDriftField,
  type GateInstanceNextStep,
  type ListEnvelope,
  PLATFORM_CHANGE_ENABLED_IN_LIMIT,
  type PlatformChangeEnabledWorkspaceWire,
  type PlatformChangeItemWire,
  type PlatformChangeRollbackItemWire,
  type PlatformChangeRollbackPreviewWire,
  type PlatformChangeRollbackResultWire,
  type PlatformChangeSegmentStatus,
  type PlatformChangeSegmentWire,
  type PlatformSegmentApplyResultWire,
  type PlatformSegmentDependentWire,
  type PlatformSegmentItemBlockerWire,
  type PlatformSegmentPreviewItemWire,
  type PlatformSegmentPreviewWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { assertConnectionParamsCarryNoCredentials } from '../../governance/connections/index.js';
import {
  type SuspectedSecrets,
  assertCredentialsReviewed,
  findSuspectedSecrets,
} from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import {
  type ConnectorPreset,
  type GateTransportKind,
  createHostedGateInstance,
  loadConnectorPresets,
  planHostedGateInstance,
  resolveHostedDefinition,
} from '../gates/index.js';
import { AdminProposalSegmentNotOpenError } from './admin-proposal-segments.js';
import { getAdminProposal } from './admin-proposals.js';
import { type WideningReason, classificationOf } from './classify.js';
import { contentDigest } from './digest.js';
import {
  ChangeConfirmationRequiredError,
  ChangePlanChangedError,
  type UnconfirmedChangeItem,
} from './errors.js';
import {
  appliedDependents,
  gateInstanceDrift,
  lockProposalDependency,
} from './proposal-dependency.js';

/**
 * application/change-plan/platform-segments: an admin proposal's platform segment on the platform
 * plane (S11 AA3c-1; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.3, §5.4,
 * I-A4 / I-A7 / I-A8; the AA3 default plan F6 / F8 / F12 and the AA3c plan F-c1–F-c8). The proposal
 * itself is `admin-proposals.ts`'; migrations/governance/0034 has the model and the guards.
 *
 * A platform segment holds `gate_instance` items only — new gate-host instances, each exactly what
 * `create_gate_instance` takes. Every function here runs in a platform transaction
 * (`withPlatform`: `app.platform = on`, `app.user_id` the acting administrator), as that
 * administrator — the platform capabilities `preview_platform_segment`, `apply_platform_segment`,
 * `reject_platform_segment`, `list_platform_change_segments`, `get_platform_change_segment`,
 * `preview_roll_back_platform_change_segment` and `roll_back_platform_change_segment` (human
 * channel, a console session; no Handle reaches them).
 *
 * **Dry run.** Each item resolves its definition as `create_gate_instance` does
 * (`resolveHostedDefinition`) and is checked against the platform now without writing
 * (`planHostedGateInstance`): its gate id free, its connector of its kind, not a packaged gate's,
 * and — for a proposal only — in the catalog (`platform_preset`) when it exists, so a workspace can
 * enable what applying creates. An item that would not be created is a blocker; while there is
 * one nothing is planned. Every item is `authority_widening` (a new outside address, which the
 * credential an administrator enters for it is sent to), so each is confirmed one by one (I-A4).
 * The digest covers what each item would do — its definition, its connector and whether applying
 * creates that — so anything that moves between the preview and the apply refuses the apply (409
 * `change_plan_changed`, I-A8).
 *
 * **Applying.** One transaction: the segment's row lock, the dry run again (blocked 409, digest
 * 409, confirmation 400, suspected credentials 400), the address rule once more, then the record
 * (`platform_change_segments`), each instance created as `create_gate_instance` creates it
 * (`createHostedGateInstance`: `discovered`, no Operations until the gate host announces it), the
 * record's items, and the segment's `applied` edge. Platform AuditRecords: `gate_instance.created`
 * per instance and `connector.created` per connector it created.
 *
 * **Rejecting, rolling back, and the workspace segments.** Every workspace segment of the proposal
 * depends on its platform segment (`admin-proposal-segments.ts` refuses to apply one before it is
 * applied). Rejecting the platform segment, or rolling back its record, withdraws each of them
 * still proposed in the same transaction (`withdrawn_origin = 'platform_segment'`); a rollback is
 * refused while one of them is applied (roll that back in its workspace first) — read from what
 * their applies recorded in each workspace (`appliedDependents`), which outlives a purged trial
 * workspace. A rollback takes the proposal's dependency lock exclusive before any row lock, and
 * applying a workspace segment takes it shared first (`proposal-dependency.ts`, AA3c-2), so the two
 * never interleave: whichever comes second sees what the first left. Rejecting takes the workspace
 * segments' row locks, which applying one takes too. governance 0035 holds both edges again.
 *
 * **Rolling back (F-c3).** Compare, then write: each instance is read under its row lock and
 * compared with what the item created (its connector and its definition); a changed one refuses
 * the whole rollback (409 `platform_change_drifted`, the fields in `details`). An unchanged one is
 * disabled — never deleted, so its gate id keeps its history; a `lost` one keeps `lost` and
 * returns `disabled`; one already disabled or gone is left. The connectors it created stay.
 * Platform AuditRecords: `gate_instance.disabled` per instance it disables.
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** No platform segment by that id (a workspace segment's id answers the same). Mapped to 404
 *  `admin_proposal_segment_not_found`. */
export class PlatformSegmentNotFoundError extends Error {
  readonly code = 'admin_proposal_segment_not_found' as const;
  constructor(segmentId: string) {
    super(`platform segment ${segmentId} not found`);
    this.name = 'PlatformSegmentNotFoundError';
  }
}

/** An item of the platform segment would not be created now. Mapped to 409
 *  `admin_proposal_segment_blocked` with `details.blockers`; nothing was written. */
export class PlatformSegmentBlockedError extends Error {
  readonly code = 'admin_proposal_segment_blocked' as const;
  readonly details: { readonly blockers: readonly PlatformSegmentItemBlockerWire[] };
  constructor(segmentId: string, blockers: readonly PlatformSegmentItemBlockerWire[]) {
    super(
      `platform segment ${segmentId} cannot be applied now: ${blockers.map((b) => `item ${b.ordinal} (${b.kind}) ${b.reason}`).join('; ')}. Nothing was applied — reject it, or apply it once the platform allows it.`,
    );
    this.name = 'PlatformSegmentBlockedError';
    this.details = { blockers };
  }
}

/** No platform change segment by that id. Mapped to 404 `platform_change_segment_not_found`. */
export class PlatformChangeSegmentNotFoundError extends Error {
  readonly code = 'platform_change_segment_not_found' as const;
  constructor(changeSegmentId: string) {
    super(`platform change segment ${changeSegmentId} not found`);
    this.name = 'PlatformChangeSegmentNotFoundError';
  }
}

/** Already rolled back. Mapped to 409 `platform_change_segment_rolled_back`; nothing was written. */
export class PlatformChangeSegmentRolledBackError extends Error {
  readonly code = 'platform_change_segment_rolled_back' as const;
  constructor(changeSegmentId: string) {
    super(
      `platform change segment ${changeSegmentId} is already rolled back — nothing was written`,
    );
    this.name = 'PlatformChangeSegmentRolledBackError';
  }
}

/** One instance changed since its item created it. */
export interface PlatformChangeDrift {
  readonly ordinal: number;
  readonly gateId: string;
  readonly drift: readonly GateInstanceDriftField[];
}

/** F-c3: an instance the segment created changed since (its connector or its definition) — the
 *  rollback would disable something it did not leave there. Mapped to 409
 *  `platform_change_drifted` with `details.items`; nothing was written. */
export class PlatformChangeDriftedError extends Error {
  readonly code = 'platform_change_drifted' as const;
  readonly details: { readonly items: readonly PlatformChangeDrift[] };
  constructor(changeSegmentId: string, items: readonly PlatformChangeDrift[]) {
    super(
      `platform change segment ${changeSegmentId} cannot be rolled back: ${items.map((item) => `${item.gateId} changed (${item.drift.join(', ')})`).join('; ')} since it was created — nothing was written. Disable it yourself if it should go.`,
    );
    this.name = 'PlatformChangeDriftedError';
    this.details = { items };
  }
}

/** A workspace segment of the proposal is applied: it depends on what the rollback would disable.
 *  Mapped to 409 `dependent_segments_applied` with `details.segments`; nothing was written. */
export class DependentSegmentsAppliedError extends Error {
  readonly code = 'dependent_segments_applied' as const;
  readonly details: { readonly segments: readonly PlatformSegmentDependentWire[] };
  constructor(changeSegmentId: string, segments: readonly PlatformSegmentDependentWire[]) {
    super(
      `platform change segment ${changeSegmentId} cannot be rolled back while ${segments.length} workspace segment(s) of its proposal are applied (${segments.map((s) => s.segmentId).join(', ')}) — roll each back in its workspace first; nothing was written`,
    );
    this.name = 'DependentSegmentsAppliedError';
    this.details = { segments };
  }
}

// -------------------------------------------------------------------------------------------
// The platform segment
// -------------------------------------------------------------------------------------------

interface PlatformSegmentRow {
  id: string;
  proposal_id: string;
  items: AdminProposalPlatformItemIntentWire[];
  content_digest: string;
  status: AdminProposalSegmentStatus;
  source_name: string;
  proposed_by_user: string;
  proposer_display_name: string;
}

/** The platform segment `segmentId`, or {@link PlatformSegmentNotFoundError}. `forUpdate`: its row
 *  stays locked until the transaction ends — applying and rejecting take it first, so two
 *  decisions of it (or a decision and a withdrawal) run one after the other. */
async function loadPlatformSegment(
  client: PoolClient,
  segmentId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PlatformSegmentRow> {
  if (options.forUpdate) {
    await client.query(
      `select 1 from admin_proposal_segments where id = $1 and authority = 'platform' for update`,
      [segmentId],
    );
  }
  const result = await client.query<PlatformSegmentRow>(
    `select s.id, s.proposal_id, s.items, s.content_digest, s.status,
            p.source_name, p.proposed_by_user, p.proposer_display_name
       from admin_proposal_segments s
       join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
      where s.id = $1 and s.authority = 'platform'`,
    [segmentId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new PlatformSegmentNotFoundError(segmentId);
  return row;
}

function assertOpen(row: PlatformSegmentRow): void {
  if (row.status !== 'proposed') throw new AdminProposalSegmentNotOpenError(row.id, row.status);
}

/** The proposal's workspace segments, each depending on its platform segment. `forUpdate`: their
 *  rows stay locked until the transaction ends (see the module comment). */
async function dependentsOf(
  client: PoolClient,
  proposalId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PlatformSegmentDependentWire[]> {
  const result = await client.query<{
    id: string;
    target_workspace_id: string;
    status: AdminProposalSegmentStatus;
  }>(
    `select id, target_workspace_id, status from admin_proposal_segments
      where proposal_id = $1 and authority = 'workspace'
      order by ordinal${options.forUpdate ? ' for update' : ''}`,
    [proposalId],
  );
  return result.rows.map((row) => ({
    segmentId: row.id,
    targetWorkspaceId: row.target_workspace_id,
    status: row.status,
  }));
}

/** Withdraws each workspace segment of `proposalId` still proposed, as `userId`, because its
 *  platform segment was rejected or rolled back (the guard checks it is). Returns how many. */
async function withdrawDependents(
  client: PoolClient,
  proposalId: string,
  userId: string,
): Promise<number> {
  const result = await client.query(
    `update admin_proposal_segments
        set status = 'withdrawn', withdrawn_by_user = $2, withdrawn_origin = 'platform_segment'
      where proposal_id = $1 and authority = 'workspace' and status = 'proposed'`,
    [proposalId, userId],
  );
  return result.rowCount ?? 0;
}

/** The platform segment as `get_admin_proposal` reads it, with its proposal. */
async function proposalAndSegment(
  client: PoolClient,
  row: PlatformSegmentRow,
): Promise<{ readonly proposal: AdminProposalWire; readonly segment: AdminProposalSegmentWire }> {
  const proposal = await getAdminProposal(client, row.proposal_id, { reader: 'platform' });
  const segment = proposal.segments.find((candidate) => candidate.id === row.id);
  if (segment === undefined) {
    throw new Error(`platform segment ${row.id} is not among its proposal's segments`);
  }
  return { proposal, segment };
}

// -------------------------------------------------------------------------------------------
// The dry run
// -------------------------------------------------------------------------------------------

/** One instance applying the segment would create. */
interface PlannedGateInstance {
  readonly ordinal: number;
  readonly gateId: string;
  readonly displayName: string;
  readonly connector: string;
  readonly connectorCreated: boolean;
  readonly definition: GateHostedDefinitionWire;
  readonly widening: readonly WideningReason[];
  readonly classification: ChangeItemClassification;
  readonly nextSteps: readonly GateInstanceNextStep[];
}

interface PlatformSegmentPlan {
  readonly blockers: readonly PlatformSegmentItemBlockerWire[];
  readonly items: readonly PlannedGateInstance[];
  /** `null` while there is a blocker. */
  readonly digest: string | null;
}

/** I-A4: a new instance is a new outside address — what a credential entered for it is sent to. */
const GATE_INSTANCE_WIDENING: readonly WideningReason[] = [{ path: 'target', reason: 'added' }];

/** What the administrator does once the instance exists, in order (`GateInstanceNextStepSchema`). */
function nextStepsOf(definition: GateHostedDefinitionWire): GateInstanceNextStep[] {
  return [
    ...(definition.credentialMode === 'shared' ? (['enter_shared_credential'] as const) : []),
    'await_announce',
    'review_and_enable',
  ];
}

async function planPlatformSegment(
  client: PoolClient,
  row: PlatformSegmentRow,
): Promise<PlatformSegmentPlan> {
  const presets: readonly ConnectorPreset[] = row.items.some((item) => item.preset !== undefined)
    ? await loadConnectorPresets()
    : [];
  const blockers: PlatformSegmentItemBlockerWire[] = [];
  const items: PlannedGateInstance[] = [];
  // Connectors an earlier item of this segment creates: a later one joins it (it is not created
  // twice), and only with the same transport kind — as `createHostedGateInstance` would decide
  // once the earlier one is written.
  const createdHere = new Map<string, GateTransportKind>();
  for (const [index, item] of row.items.entries()) {
    const ordinal = index + 1;
    const block = (reason: AdminProposalPlatformItemBlocker) =>
      blockers.push({ ordinal, kind: item.kind, reason });
    const resolved = resolveHostedDefinition(item, presets);
    if (resolved.refused !== null) {
      block(resolved.refused);
      continue;
    }
    const kind = resolved.definition.transportKind;
    const plan = await planHostedGateInstance(client, {
      gateId: item.gateId,
      connector: resolved.connector,
      kind,
    });
    if (plan.refused !== null) {
      block(plan.refused);
      continue;
    }
    let connectorCreated = plan.connectorCreated;
    const earlier = createdHere.get(resolved.connector);
    if (connectorCreated && earlier !== undefined) {
      if (earlier !== kind) {
        block('connector_kind_mismatch');
        continue;
      }
      connectorCreated = false;
    } else if (connectorCreated) {
      createdHere.set(resolved.connector, kind);
    }
    items.push({
      ordinal,
      gateId: item.gateId,
      displayName: item.displayName ?? item.gateId,
      connector: resolved.connector,
      connectorCreated,
      definition: resolved.definition,
      widening: GATE_INSTANCE_WIDENING,
      classification: classificationOf(GATE_INSTANCE_WIDENING),
      nextSteps: nextStepsOf(resolved.definition),
    });
  }
  if (blockers.length > 0) return { blockers, items: [], digest: null };
  return {
    blockers,
    items,
    digest: contentDigest({
      source: { proposalId: row.proposal_id, segmentId: row.id, digest: row.content_digest },
      items: items.map((item) => ({
        ordinal: item.ordinal,
        kind: 'gate_instance',
        gateId: item.gateId,
        displayName: item.displayName,
        connector: { name: item.connector, created: item.connectorCreated },
        definition: item.definition,
        classification: item.classification,
        widening: item.widening,
      })),
    }),
  };
}

/** F9: the values in what the segment writes that look like credentials — over the items as
 *  proposed (`items[0].target`, …). */
function suspectedSecretsOf(row: PlatformSegmentRow): SuspectedSecrets {
  return findSuspectedSecrets({ items: row.items });
}

function previewItemOf(item: PlannedGateInstance): PlatformSegmentPreviewItemWire {
  return {
    ordinal: item.ordinal,
    kind: 'gate_instance',
    classification: item.classification,
    widening: item.widening.map((reason) => ({ ...reason })),
    gateId: item.gateId,
    displayName: item.displayName,
    connector: { name: item.connector, created: item.connectorCreated },
    definition: item.definition,
    nextSteps: [...item.nextSteps],
  };
}

/** `preview_platform_segment`: what applying the platform segment would create, writing nothing. */
export async function previewPlatformSegment(
  client: PoolClient,
  segmentId: string,
): Promise<PlatformSegmentPreviewWire> {
  const row = await loadPlatformSegment(client, segmentId);
  assertOpen(row);
  const { proposal, segment } = await proposalAndSegment(client, row);
  const plan = await planPlatformSegment(client, row);
  const suspected = suspectedSecretsOf(row);
  return {
    proposal: {
      id: proposal.id,
      title: proposal.title,
      description: proposal.description,
      sourceName: proposal.sourceName,
      origin: proposal.origin,
      proposedBy: proposal.proposedBy,
      proposedAt: proposal.proposedAt,
    },
    segment,
    blockers: [...plan.blockers],
    digest: plan.digest,
    items: plan.items.map(previewItemOf),
    dependents: await dependentsOf(client, row.proposal_id),
    suspectedSecretValues: suspected.count,
    suspectedSecretPaths: [...suspected.paths],
  };
}

// -------------------------------------------------------------------------------------------
// Apply and reject
// -------------------------------------------------------------------------------------------

export interface ApplyPlatformSegmentInput {
  readonly segmentId: string;
  /** The preview's `digest` (I-A8). */
  readonly reviewedDigest: string;
  /** The ordinals of the authority-widening items — every item — the administrator confirmed one
   *  by one (I-A4). */
  readonly confirmedOrdinals: readonly number[];
  /** Required when the segment carries suspected credentials (F9). */
  readonly credentialsReviewed?: boolean;
}

export interface AppliedPlatformSegment {
  readonly result: PlatformSegmentApplyResultWire;
  /** What the administrator confirmed (F9), for the call's audit row (`credentialReviewAudit`). */
  readonly suspectedSecretValues: number;
}

/**
 * `apply_platform_segment`, in the caller's one platform transaction, as `userId` — the acting
 * administrator, the applier and the confirmer of every item. In order: the segment's row lock and
 * status, the dry run (blocked 409), the digest (409), the confirmations (400), the credential
 * review (400) and the address rule, then the record, each instance, the items and the segment's
 * `applied` edge. Any refusal leaves everything as it was.
 */
export async function applyPlatformSegment(
  client: PoolClient,
  userId: string,
  input: ApplyPlatformSegmentInput,
): Promise<AppliedPlatformSegment> {
  const row = await loadPlatformSegment(client, input.segmentId, { forUpdate: true });
  assertOpen(row);
  const plan = await planPlatformSegment(client, row);
  if (plan.digest === null) throw new PlatformSegmentBlockedError(row.id, plan.blockers);
  if (plan.digest !== input.reviewedDigest) {
    throw new ChangePlanChangedError(input.reviewedDigest, plan.digest);
  }
  const confirmed = new Set(input.confirmedOrdinals);
  const unconfirmed: UnconfirmedChangeItem[] = plan.items
    .filter((item) => item.classification === 'authority_widening' && !confirmed.has(item.ordinal))
    .map((item) => ({
      ordinal: item.ordinal,
      kind: 'gate_instance',
      target: { gateId: item.gateId },
      widening: item.widening,
    }));
  if (unconfirmed.length > 0) {
    throw new ChangeConfirmationRequiredError(unconfirmed, `platform segment ${row.id}`);
  }
  const suspected = suspectedSecretsOf(row);
  assertCredentialsReviewed('platform_segment', row.id, suspected, input.credentialsReviewed);
  // The proposal was held to this rule when it was made; it is the instance's own rule, so it is
  // applied again where the instance is written (as `create_gate_instance` applies it).
  for (const item of plan.items) {
    assertConnectionParamsCarryNoCredentials('apply_platform_segment', {
      target: item.definition.target,
      manifestSource: item.definition.manifestSource,
    });
  }

  const record = await client.query<{ id: string }>(
    `insert into platform_change_segments
       (admin_proposal_id, admin_proposal_segment_id, source_name, source_digest,
        proposed_by_user, proposer_display_name, reviewed_digest, applied_by_user)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      row.proposal_id,
      row.id,
      row.source_name,
      row.content_digest,
      row.proposed_by_user,
      row.proposer_display_name,
      plan.digest,
      userId,
    ],
  );
  const changeSegmentId = record.rows[0]?.id;
  if (changeSegmentId === undefined) {
    throw new Error('applyPlatformSegment: the record insert returned no row');
  }
  for (const item of plan.items) {
    const outcome = await createHostedGateInstance(client, {
      gateId: item.gateId,
      displayName: item.displayName,
      connector: item.connector,
      definition: item.definition,
    });
    if (outcome.refused !== null) {
      // Unreachable while the dry run above holds (same transaction): a concurrent writer took
      // the gate id or the connector in between. Nothing of this transaction stays.
      throw new PlatformSegmentBlockedError(row.id, [
        { ordinal: item.ordinal, kind: 'gate_instance', reason: outcome.refused },
      ]);
    }
    if (outcome.connectorCreated) {
      await writeAudit(client, {
        workspaceId: null,
        actorPrincipalId: null,
        actorUserId: userId,
        action: 'connector.created',
        resourceType: 'connector',
        payload: {
          resourceRef: item.connector,
          kind: item.definition.transportKind,
          mode: 'platform_preset',
          gateId: item.gateId,
          ...(item.definition.preset !== undefined ? { preset: item.definition.preset } : {}),
          platformChangeSegmentId: changeSegmentId,
        },
      });
    }
    await client.query(
      `insert into platform_change_items
         (change_segment_id, ordinal, kind, classification, widening, confirmed_by_user, gate_id,
          display_name, connector, connector_created, definition)
       values ($1, $2, 'gate_instance', $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        changeSegmentId,
        item.ordinal,
        item.classification,
        JSON.stringify(item.widening),
        item.classification === 'authority_widening' ? userId : null,
        item.gateId,
        item.displayName,
        item.connector,
        outcome.connectorCreated,
        JSON.stringify(item.definition),
      ],
    );
    await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: userId,
      action: 'gate_instance.created',
      resourceType: 'gate_instance',
      // `audit_records.resource_id` is a uuid; a gate instance is keyed by its `GATE_ID`
      // (`gate_instance.manifest_confirmed`'s convention).
      payload: {
        resourceRef: item.gateId,
        connector: item.connector,
        transportKind: item.definition.transportKind,
        credentialMode: item.definition.credentialMode,
        ...(item.definition.preset !== undefined ? { preset: item.definition.preset } : {}),
        platformChangeSegmentId: changeSegmentId,
        adminProposalId: row.proposal_id,
        ordinal: item.ordinal,
      },
    });
  }
  const updated = await client.query(
    `update admin_proposal_segments
        set status = 'applied', decided_by_user = $2, applied_platform_segment_id = $3
      where id = $1 and authority = 'platform' and status = 'proposed'`,
    [row.id, userId, changeSegmentId],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`applyPlatformSegment: segment ${row.id} did not move to applied`);
  }
  const { segment } = await proposalAndSegment(client, row);
  return {
    result: {
      segment,
      changeSegment: await getPlatformChangeSegment(client, changeSegmentId),
      nextSteps: plan.items.map((item) => ({ gateId: item.gateId, steps: [...item.nextSteps] })),
    },
    suspectedSecretValues: suspected.count,
  };
}

/** What rejecting a platform segment did, for the call's result and its audit row. */
export interface RejectedPlatformSegment {
  readonly proposal: AdminProposalWire;
  readonly withdrawnSegments: number;
}

/** `reject_platform_segment`, as `userId` (the acting administrator), with `reason` (already
 *  trimmed and bounded by the capability's params): the segment becomes `rejected`, and each
 *  workspace segment of the proposal still proposed is withdrawn with it. */
export async function rejectPlatformSegment(
  client: PoolClient,
  userId: string,
  segmentId: string,
  reason: string,
): Promise<RejectedPlatformSegment> {
  const row = await loadPlatformSegment(client, segmentId, { forUpdate: true });
  assertOpen(row);
  await dependentsOf(client, row.proposal_id, { forUpdate: true });
  const updated = await client.query(
    `update admin_proposal_segments
        set status = 'rejected', decided_by_user = $2, reason = $3
      where id = $1 and authority = 'platform' and status = 'proposed'`,
    [row.id, userId, reason],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`rejectPlatformSegment: segment ${row.id} did not move to rejected`);
  }
  const withdrawnSegments = await withdrawDependents(client, row.proposal_id, userId);
  return {
    proposal: await getAdminProposal(client, row.proposal_id, { reader: 'platform' }),
    withdrawnSegments,
  };
}

// -------------------------------------------------------------------------------------------
// Platform change segments (the record)
// -------------------------------------------------------------------------------------------

interface ChangeSegmentRow {
  id: string;
  admin_proposal_id: string;
  admin_proposal_segment_id: string;
  source_name: string;
  source_digest: string;
  proposed_by_user: string;
  proposer_display_name: string;
  reviewed_digest: string;
  status: PlatformChangeSegmentStatus;
  applied_by_user: string;
  applied_name: string | null;
  applied_at: Date;
  rolled_back_by_user: string | null;
  rolled_back_name: string | null;
  rolled_back_at: Date | null;
}

interface ChangeItemRow {
  change_segment_id: string;
  ordinal: number;
  classification: ChangeItemClassification;
  confirmed_by_user: string | null;
  confirmed_name: string | null;
  gate_id: string;
  display_name: string;
  connector: string;
  connector_created: boolean;
  definition: GateHostedDefinitionWire;
}

const CHANGE_SEGMENT_SELECT = `
  select c.id, c.admin_proposal_id, c.admin_proposal_segment_id, c.source_name, c.source_digest,
         c.proposed_by_user, c.proposer_display_name, c.reviewed_digest, c.status,
         c.applied_by_user, ua.display_name as applied_name, c.applied_at,
         c.rolled_back_by_user, ur.display_name as rolled_back_name, c.rolled_back_at
    from platform_change_segments c
    left join users ua on ua.id = c.applied_by_user
    left join users ur on ur.id = c.rolled_back_by_user`;

/** A platform user by their name now (a user is never purged while a record names them: the
 *  foreign key keeps the row, `findUserReferences`). */
function userRef(
  userId: string,
  displayName: string | null,
): { userId: string; displayName: string } {
  return { userId, displayName: displayName ?? userId };
}

function changeItemOf(row: ChangeItemRow): PlatformChangeItemWire {
  return {
    ordinal: row.ordinal,
    kind: 'gate_instance',
    classification: row.classification,
    gateId: row.gate_id,
    displayName: row.display_name,
    connector: { name: row.connector, created: row.connector_created },
    definition: row.definition,
    // The check constraint keeps it set: every item is authority_widening (I-A4).
    confirmedBy: userRef(row.confirmed_by_user ?? '', row.confirmed_name),
  };
}

function changeSegmentOf(
  row: ChangeSegmentRow,
  items: readonly ChangeItemRow[],
): PlatformChangeSegmentWire {
  return {
    id: row.id,
    source: {
      kind: 'admin_proposal',
      name: row.source_name,
      proposalId: row.admin_proposal_id,
      proposalSegmentId: row.admin_proposal_segment_id,
      digest: row.source_digest,
    },
    proposedBy: { userId: row.proposed_by_user, displayName: row.proposer_display_name },
    reviewedDigest: row.reviewed_digest,
    status: row.status,
    appliedBy: userRef(row.applied_by_user, row.applied_name),
    appliedAt: row.applied_at.toISOString(),
    rolledBackBy:
      row.rolled_back_by_user === null
        ? null
        : userRef(row.rolled_back_by_user, row.rolled_back_name),
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
    items: items.map(changeItemOf),
  };
}

async function itemsOf(
  client: PoolClient,
  changeSegmentIds: readonly string[],
): Promise<Map<string, ChangeItemRow[]>> {
  const result = await client.query<ChangeItemRow>(
    `select i.change_segment_id, i.ordinal, i.classification, i.confirmed_by_user,
            u.display_name as confirmed_name, i.gate_id, i.display_name, i.connector,
            i.connector_created, i.definition
       from platform_change_items i
       left join users u on u.id = i.confirmed_by_user
      where i.change_segment_id = any($1::uuid[])
      order by i.change_segment_id, i.ordinal`,
    [changeSegmentIds],
  );
  const byRecord = new Map<string, ChangeItemRow[]>();
  for (const row of result.rows) {
    const list = byRecord.get(row.change_segment_id) ?? [];
    list.push(row);
    byRecord.set(row.change_segment_id, list);
  }
  return byRecord;
}

/** `list_platform_change_segments`: newest first, at most {@link ADMIN_PROPOSAL_LIST_LIMIT}
 *  (`truncated` when there are more), narrowed to `status` when given. */
export async function listPlatformChangeSegments(
  client: PoolClient,
  status?: PlatformChangeSegmentStatus,
): Promise<ListEnvelope<PlatformChangeSegmentWire>> {
  const values: unknown[] = [];
  let filter = '';
  if (status !== undefined) {
    values.push(status);
    filter = ` where c.status = $${values.length}`;
  }
  values.push(ADMIN_PROPOSAL_LIST_LIMIT + 1);
  const result = await client.query<ChangeSegmentRow>(
    `${CHANGE_SEGMENT_SELECT}${filter}
      order by c.applied_at desc, c.id
      limit $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, ADMIN_PROPOSAL_LIST_LIMIT);
  const items = await itemsOf(
    client,
    rows.map((row) => row.id),
  );
  const list = rows.map((row) => changeSegmentOf(row, items.get(row.id) ?? []));
  return result.rows.length > ADMIN_PROPOSAL_LIST_LIMIT
    ? { items: list, truncated: true }
    : { items: list };
}

async function loadChangeSegment(
  client: PoolClient,
  changeSegmentId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ChangeSegmentRow> {
  if (options.forUpdate) {
    await client.query('select 1 from platform_change_segments where id = $1 for update', [
      changeSegmentId,
    ]);
  }
  const result = await client.query<ChangeSegmentRow>(`${CHANGE_SEGMENT_SELECT} where c.id = $1`, [
    changeSegmentId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new PlatformChangeSegmentNotFoundError(changeSegmentId);
  return row;
}

/** `get_platform_change_segment`, or {@link PlatformChangeSegmentNotFoundError}. */
export async function getPlatformChangeSegment(
  client: PoolClient,
  changeSegmentId: string,
): Promise<PlatformChangeSegmentWire> {
  const row = await loadChangeSegment(client, changeSegmentId);
  const items = await itemsOf(client, [row.id]);
  return changeSegmentOf(row, items.get(row.id) ?? []);
}

// -------------------------------------------------------------------------------------------
// Rolling back (F-c3)
// -------------------------------------------------------------------------------------------

interface GateInstanceNow {
  connector: string;
  definition: GateHostedDefinitionWire | null;
  status: 'discovered' | 'enabled' | 'disabled' | 'lost';
  status_before_lost: 'discovered' | 'enabled' | 'disabled' | 'lost' | null;
  links: number;
}

/** What one item's rollback does, and the instance it does it to (absent when gone). */
interface PlannedItemRollback {
  readonly wire: PlatformChangeRollbackItemWire;
  readonly instance: GateInstanceNow | null;
}

async function planRollback(
  client: PoolClient,
  items: readonly ChangeItemRow[],
  options: { readonly forUpdate: boolean },
): Promise<PlannedItemRollback[]> {
  const planned: PlannedItemRollback[] = [];
  for (const item of items) {
    if (options.forUpdate) {
      await client.query('select 1 from gate_instances where gate_id = $1 for update', [
        item.gate_id,
      ]);
    }
    const result = await client.query<GateInstanceNow>(
      `select g.connector, g.definition, g.status, g.status_before_lost,
              (select count(*)::int from workspace_gate_links l where l.gate_id = g.gate_id) as links
         from gate_instances g
        where g.gate_id = $1`,
      [item.gate_id],
    );
    const now = result.rows[0];
    if (now === undefined) {
      planned.push({
        wire: {
          ordinal: item.ordinal,
          gateId: item.gate_id,
          action: 'gone',
          drift: [],
          linkedWorkspaceCount: 0,
          enabledIn: [],
        },
        instance: null,
      });
      continue;
    }
    const alreadyDisabled =
      now.status === 'disabled' || (now.status === 'lost' && now.status_before_lost === 'disabled');
    planned.push({
      wire: {
        ordinal: item.ordinal,
        gateId: item.gate_id,
        action: alreadyDisabled ? 'already_disabled' : 'disable',
        drift: gateInstanceDrift(item, now),
        linkedWorkspaceCount: now.links,
        enabledIn: now.links === 0 ? [] : await workspacesEnabling(client, item.gate_id),
      },
      instance: now,
    });
  }
  return planned;
}

/** The workspaces that enabled `gateId`, by name, at most {@link PLATFORM_CHANGE_ENABLED_IN_LIMIT}
 *  (S11 AA4-0, the AA4 plan F7): their id, name and purpose — what the platform plane already lists
 *  of every workspace — for the rollback dialog to link each to the gate page where its owner
 *  disables it. */
async function workspacesEnabling(
  client: PoolClient,
  gateId: string,
): Promise<PlatformChangeEnabledWorkspaceWire[]> {
  const result = await client.query<PlatformChangeEnabledWorkspaceWire>(
    `select w.id as "workspaceId", w.name, w.purpose
       from workspace_gate_links l
       join workspaces w on w.id = l.workspace_id
      where l.gate_id = $1
      order by w.name, w.id
      limit $2`,
    [gateId, PLATFORM_CHANGE_ENABLED_IN_LIMIT],
  );
  return result.rows;
}

/** `preview_roll_back_platform_change_segment`: what rolling it back would do, writing nothing. */
export async function previewPlatformChangeRollback(
  client: PoolClient,
  changeSegmentId: string,
): Promise<PlatformChangeRollbackPreviewWire> {
  const changeSegment = await getPlatformChangeSegment(client, changeSegmentId);
  const row = await loadChangeSegment(client, changeSegmentId);
  const items = (await itemsOf(client, [row.id])).get(row.id) ?? [];
  const planned = await planRollback(client, items, { forUpdate: false });
  const dependentsApplied = await appliedDependents(client, row.admin_proposal_id);
  return {
    changeSegment,
    items: planned.map((entry) => entry.wire),
    dependentsApplied,
    canRollBack:
      row.status === 'applied' &&
      dependentsApplied.length === 0 &&
      planned.every((entry) => entry.wire.drift.length === 0),
  };
}

export interface RolledBackPlatformChangeSegment {
  readonly result: PlatformChangeRollbackResultWire;
  readonly proposalId: string;
}

/**
 * `roll_back_platform_change_segment`, in the caller's one platform transaction, as `userId`. In
 * order: the proposal's dependency lock, exclusive (`lockProposalDependency`, AA3c-2: no workspace
 * segment of it applies until this commits), the record's row lock and status (409), the workspace
 * segments' row locks and any applied — by what their applies recorded, so after the trial
 * workspace is purged too (409) — each instance's row lock and its drift (409); then the record's
 * `rolled_back` edge, each instance disabled, the platform segment's `rolled_back` edge (while its
 * trial workspace exists) and the workspace segments still proposed withdrawn. Any refusal leaves
 * everything as it was.
 */
export async function rollBackPlatformChangeSegment(
  client: PoolClient,
  userId: string,
  changeSegmentId: string,
): Promise<RolledBackPlatformChangeSegment> {
  // The proposal id never changes on a record (0034's guard), so it is read before any lock.
  const unlocked = await loadChangeSegment(client, changeSegmentId);
  await lockProposalDependency(client, unlocked.admin_proposal_id, 'exclusive');
  const row = await loadChangeSegment(client, changeSegmentId, { forUpdate: true });
  if (row.status === 'rolled_back') throw new PlatformChangeSegmentRolledBackError(row.id);
  await dependentsOf(client, row.admin_proposal_id, { forUpdate: true });
  const dependentsApplied = await appliedDependents(client, row.admin_proposal_id);
  if (dependentsApplied.length > 0) {
    throw new DependentSegmentsAppliedError(row.id, dependentsApplied);
  }
  const items = (await itemsOf(client, [row.id])).get(row.id) ?? [];
  const planned = await planRollback(client, items, { forUpdate: true });
  const drifted = planned
    .filter((entry) => entry.wire.drift.length > 0)
    .map((entry) => ({
      ordinal: entry.wire.ordinal,
      gateId: entry.wire.gateId,
      drift: entry.wire.drift,
    }));
  if (drifted.length > 0) throw new PlatformChangeDriftedError(row.id, drifted);

  const recorded = await client.query(
    `update platform_change_segments
        set status = 'rolled_back', rolled_back_by_user = $2
      where id = $1 and status = 'applied'`,
    [row.id, userId],
  );
  if (recorded.rowCount !== 1) {
    throw new Error(`rollBackPlatformChangeSegment: record ${row.id} did not move to rolled_back`);
  }
  for (const entry of planned) {
    if (entry.wire.action !== 'disable' || entry.instance === null) continue;
    const wasLost = entry.instance.status === 'lost';
    // A lost instance stays lost — the gate host is not answering — and returns disabled.
    await client.query(
      wasLost
        ? `update gate_instances set status_before_lost = 'disabled', updated_at = now() where gate_id = $1`
        : `update gate_instances set status = 'disabled', updated_at = now() where gate_id = $1`,
      [entry.wire.gateId],
    );
    await writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: userId,
      action: 'gate_instance.disabled',
      resourceType: 'gate_instance',
      payload: {
        resourceRef: entry.wire.gateId,
        statusBefore: entry.instance.status,
        ...(wasLost ? { statusBeforeLost: entry.instance.status_before_lost } : {}),
        linkedWorkspaceCount: entry.wire.linkedWorkspaceCount,
        platformChangeSegmentId: row.id,
        adminProposalId: row.admin_proposal_id,
        ordinal: entry.wire.ordinal,
      },
    });
  }
  // The platform segment, while the proposal's trial workspace keeps it (purging that workspace
  // removes the proposal; the record stays).
  await client.query(
    `update admin_proposal_segments
        set status = 'rolled_back', rolled_back_by_user = $2
      where id = $1 and authority = 'platform' and status = 'applied'`,
    [row.admin_proposal_segment_id, userId],
  );
  const withdrawnSegments = await withdrawDependents(client, row.admin_proposal_id, userId);
  return {
    result: {
      changeSegment: await getPlatformChangeSegment(client, row.id),
      items: planned.map((entry) => entry.wire),
      withdrawnSegments,
    },
    proposalId: row.admin_proposal_id,
  };
}
