import {
  ADMIN_PROPOSAL_LIST_LIMIT,
  type AdminProposalGateAvailability,
  type AdminProposalItemBlocker,
  type AdminProposalItemBlockerWire,
  type AdminProposalItemIntentWire,
  type AdminProposalPlatformInstanceChangeWire,
  type AdminProposalPlatformItemIntentWire,
  type AdminProposalPreviewItemWire,
  type AdminProposalSegmentPreviewWire,
  type AdminProposalSegmentStatus,
  type AdminProposalWorkerGateBindingWire,
  type AdminProposalWorkerGateSource,
  type ChangeItemKind,
  type ListEnvelope,
  type OperationFieldChangeWire,
  type PrincipalKind,
  type ReceivedAdminProposalCountsWire,
  type ReceivedAdminProposalSegmentWire,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  GATEKEEPER_GRANT_CAPABILITY,
  listActiveGrantResourceScopes,
} from '../../governance/capability/index.js';
import { gatekeeperNamesShown, getPublishedOperation } from '../../governance/gatekeepers/index.js';
import {
  type SuspectedSecrets,
  assertCredentialsReviewed,
  findSuspectedSecrets,
  shownFreeText,
} from '../../governance/redaction/index.js';
import { listAvailableGateInstances, readConnectorStandings } from '../gates/index.js';
import {
  loadPublishedWorkerDefinitionHead,
  unresolvedWorkerDefinitionReferences,
} from '../worker/index.js';
import { platformItemConnector } from './admin-proposals.js';
import { derivePackComponentId } from './component-id.js';
import {
  type AdminProposalOrigin,
  type ChangeItemIntent,
  type ChangeSource,
  type PlannedChangeItem,
  type WorkspaceSegmentPlan,
  applyWorkspaceSegment,
  planWorkspaceSegment,
} from './engine.js';
import { lockFamilyItem } from './family-item.js';
import { inLockOrder } from './lock-order.js';
import { lockOntologyItem } from './ontology-item.js';
import { lockOperationItem, operationRevisionProblem } from './operation-item.js';
import { lockProposalDependency, readProposalPlatformChange } from './proposal-dependency.js';

/**
 * application/change-plan/admin-proposal-segments: an admin proposal's segment in the workspace it
 * is addressed to (S11 AA3b-2; docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §3.1–§3.3,
 * §5.4, I-A4 / I-A7 / I-A8; the AA3 default plan F5 / F7 / F9) — the second source of the ChangePlan
 * core (§5.4 "一个核心，两种来源"). The proposal itself, and its making, reading and withdrawing,
 * are `admin-proposals.ts`'; migrations/governance/0032 has the model, 0033 the record a segment
 * leaves here when it is applied.
 *
 * Every function here runs in the target workspace's own transaction, as its owner (the
 * `modules` group's `*_admin_proposal_segment(s)` capabilities: human channel, owner, a person —
 * no Handle carries them). RLS lets that transaction read the one segment addressed to it and its
 * proposal's head, and move that segment along the edges its target decides (0032's guard).
 *
 * **Resolving (F5).** A segment's intents are workspace-agnostic; each resolves to this workspace's
 * own object, under the locks the core plans it under (taken first, in `lock-order.ts`'s order, so
 * what the resolution read is what the plan and the apply see):
 *   - a Skill by the name of the family that has it published (Skill names are unique among
 *     published families); with none, a new family under `derivePackComponentId(sourceName,
 *     'skill', name)` — the id the proposal exported as a pack would give it;
 *   - a `worker` WorkerDefinition by the name its family's head goes by; with none, a new family
 *     the same way. It keeps this workspace's `gates` and `model` from the head where the head has
 *     them. Where it has no gates yet and the intent names its systems (`systems`, S11 AA5f), the
 *     apply binds it to this workspace's connected gates of those systems (`readConnectorStandings`,
 *     the rule a pack's Worker is bound by): every one, unless the owner kept only some
 *     (`AdminProposalWorkerGateChoice`); keeping none publishes `gates: []`, kept like any other
 *     choice — the console says that binding it later publishes its next version, which leaves
 *     this segment's item `replaced`. Blocked when the name is the entry agent's (`name_taken`),
 *     when two `worker` families go by it (`name_ambiguous`), when the Worker names a Skill with
 *     no published version and no earlier intent of the segment to publish it, or a capability no
 *     Worker can hold (`unresolved_references` — what publishing it would refuse at apply), or
 *     (AA5f) when a system it would be bound to has no connected gate here
 *     (`worker_system_not_connected`, one per system, with whether the owner can enable one now:
 *     binding it after the apply would leave the item `replaced`, so the segment waits for it);
 *   - an ontology family by its name (`deriveOntologyPackId(family)`, as a pack's);
 *   - an Operation through the gate instance this workspace enabled (`workspace_gate_links`):
 *     blocked when it has not (`gate_not_enabled`), when the gate has no published Operation by
 *     that name (`operation_not_found`), or when what the intent sets is not a valid revision of
 *     that Operation (`operation_revision_invalid`).
 * A `gate_not_enabled` or `worker_system_not_connected` blocker says whether the gate (by id) or the
 * system (by connector) is one this proposal's platform segment creates (`fromPlatformSegment`,
 * the rule `propose` accepts a Worker's systems by): only then is "wait for the platform part" the
 * owner's answer — another system the platform does not offer is never coming with it (UX
 * acceptance of #968, M-1).
 * A blocker stays here: nothing of the dry run is written to the proposal's tables, so the agent
 * and the platform read the segment's status only (coordinator 2026-11-02).
 *
 * **Applying.** One transaction: the segment's row lock, then resolution and the core's apply
 * (`applyWorkspaceSegment`) with the source `{ kind: 'admin_proposal', name: sourceName, version:
 * proposal id, digest: the segment's content digest }` — so a resolution that moved since the
 * preview changes the digest and is refused (409 `change_plan_changed`, I-A8) — no proposer of
 * this workspace and the proposal's origin instead (0033 checks both against the proposal), and
 * every version it publishes `origin = 'agent'` (I-A7). Suspected credentials in what the segment
 * writes need the owner's confirmation (#526, `admin_proposal_segment`). The segment then moves to
 * `applied`, naming the owner and the change segment that recorded it. Rolling that change segment
 * back moves it to `rolled_back` in the same transaction (`rollback.ts`).
 *
 * **The platform segment (S11 AA3c).** A proposal may also hold a platform segment — new gate
 * instances a platform administrator applies on the platform plane (`platform-segments.ts`) — and
 * every workspace segment of it depends on that one. This workspace reads it with its own segment
 * (`platformSegment`, through governance 0034's definer function); while it is not applied, the
 * preview still shows what applying would do but gives no digest, and applying is refused (409
 * `platform_segment_not_applied`). Rejecting or rolling it back withdraws this segment while it is
 * still proposed (`withdrawnOrigin: 'platform_segment'`).
 *
 * Once it is applied (AA3c-2, F-c4 / F8), this workspace also reads what its apply recorded
 * (governance 0035's `admin_proposal_platform_change`) and compares each instance it created with
 * the instance now (`proposal-dependency.ts`, the comparison its rollback makes): while one is gone
 * or changed, the preview lists it (`platformChanges`) and gives no digest, and applying is refused
 * (409 `platform_segment_changed`). The digest covers the platform segment and that record, so the
 * owner's review stands on the platform change they saw. Applying takes the proposal's dependency
 * lock shared before its row lock; rolling that record back takes it exclusive (`platform-
 * segments.ts`), so the two never interleave — and 0035's triggers refuse the same edges to a write
 * that does not come through here. An Operation intent whose gate is not enabled here says whether
 * the owner can enable it now (`gateAvailability`, F-c1: `enable_gate_instance`, then preview again).
 */

// -------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------

/** No segment by that id is addressed to this workspace (RLS shows it no other). Mapped to 404
 *  `admin_proposal_segment_not_found`. */
export class AdminProposalSegmentNotFoundError extends Error {
  readonly code = 'admin_proposal_segment_not_found' as const;
  constructor(segmentId: string) {
    super(`admin proposal segment ${segmentId} not found in this workspace`);
    this.name = 'AdminProposalSegmentNotFoundError';
  }
}

/** The segment is no longer `proposed`: applied, rejected or withdrawn already (or rolled back).
 *  Mapped to 409 `admin_proposal_segment_not_open` with `details.status`; nothing was written. */
export class AdminProposalSegmentNotOpenError extends Error {
  readonly code = 'admin_proposal_segment_not_open' as const;
  readonly details: { readonly status: AdminProposalSegmentStatus };
  constructor(segmentId: string, status: AdminProposalSegmentStatus) {
    super(
      `admin proposal segment ${segmentId} is ${status}, not proposed — only a proposed segment is previewed, applied or rejected; nothing was changed`,
    );
    this.name = 'AdminProposalSegmentNotOpenError';
    this.details = { status };
  }
}

/** An intent of the segment does not resolve here. Mapped to 409 `admin_proposal_segment_blocked`
 *  with `details.blockers`; nothing was written. */
export class AdminProposalSegmentBlockedError extends Error {
  readonly code = 'admin_proposal_segment_blocked' as const;
  readonly details: { readonly blockers: readonly AdminProposalItemBlockerWire[] };
  constructor(segmentId: string, blockers: readonly AdminProposalItemBlockerWire[]) {
    super(
      `admin proposal segment ${segmentId} cannot be applied here: ${blockers.map((b) => `item ${b.ordinal} (${b.kind}) ${b.reason}`).join('; ')}. Nothing was applied — reject it, or apply it once what it needs is here.`,
    );
    this.name = 'AdminProposalSegmentBlockedError';
    this.details = { blockers };
  }
}

/** Every intent of the segment is already as proposed here: applying would record nothing. Mapped
 *  to 409 `admin_proposal_segment_unchanged`; nothing was written (reject it instead). */
export class AdminProposalSegmentUnchangedError extends Error {
  readonly code = 'admin_proposal_segment_unchanged' as const;
  constructor(segmentId: string) {
    super(
      `admin proposal segment ${segmentId} changes nothing here — everything it proposes is already so. Nothing was applied; reject it to close it.`,
    );
    this.name = 'AdminProposalSegmentUnchangedError';
  }
}

/** S11 AA5f: `workerGates` names a Worker this segment has none of, or for a Worker this apply
 *  binds a gate that is not one of its candidates (`gateBinding.candidates`). Mapped to 400
 *  `invalid_params`; nothing was written. Never sent by the console. */
export class AdminProposalWorkerGatesError extends Error {
  constructor(reason: string) {
    super(`workerGates: ${reason}`);
    this.name = 'AdminProposalWorkerGatesError';
  }
}

/** S11 AA5f: the gates the owner applying a segment kept for each proposed Worker the apply binds,
 *  by the Worker's name (`workerGates`, as `install_pack`'s). A Worker not named is bound to every
 *  candidate. */
export type AdminProposalWorkerGateChoice = ReadonlyMap<string, readonly string[]>;

/** S11 AA3c: the proposal's platform segment — the gate instances this segment's items need, which
 *  a platform administrator applies — is not applied (still proposed, or rejected, withdrawn or
 *  rolled back). Mapped to 409 `platform_segment_not_applied` with `details.platformSegmentStatus`;
 *  nothing was applied. */
export class PlatformSegmentNotAppliedError extends Error {
  readonly code = 'platform_segment_not_applied' as const;
  readonly details: { readonly platformSegmentStatus: AdminProposalSegmentStatus };
  constructor(segmentId: string, platformStatus: AdminProposalSegmentStatus) {
    super(
      `admin proposal segment ${segmentId} depends on its proposal's platform segment, which is ${platformStatus} — it is applied here only once a platform administrator has applied that one. Nothing was applied.`,
    );
    this.name = 'PlatformSegmentNotAppliedError';
    this.details = { platformSegmentStatus: platformStatus };
  }
}

/** S11 AA3c-2 (F-c4): a gate instance the proposal's applied platform segment created is gone or
 *  changed since (`AdminProposalPlatformInstanceChangeWire`) — what the owner would review the
 *  proposal against is not what the platform segment created. Mapped to 409
 *  `platform_segment_changed` with `details.items`; nothing was applied. */
export class PlatformSegmentChangedError extends Error {
  readonly code = 'platform_segment_changed' as const;
  readonly details: { readonly items: readonly AdminProposalPlatformInstanceChangeWire[] };
  constructor(segmentId: string, items: readonly AdminProposalPlatformInstanceChangeWire[]) {
    super(
      `admin proposal segment ${segmentId} depends on gate instances its proposal's platform segment created, and ${items.map((item) => (item.gone ? `${item.gateId} is gone` : `${item.gateId} changed (${item.drift.join(', ')})`)).join('; ')} since. Nothing was applied — reject it, or ask a platform administrator.`,
    );
    this.name = 'PlatformSegmentChangedError';
    this.details = { items };
  }
}

/** S11 AA4c (F5, the AA4c plan's D2, coordinator 11-02): the administrator who proposed this no
 *  longer has this workspace among the targets of their admin agent (`set_admin_agent_targets`) —
 *  the proposal keeps the target it was made with, but is not applied after its proposer took it
 *  back. Mapped to 409 `admin_proposal_target_no_longer_chosen`; nothing was applied. */
export class AdminProposalTargetNoLongerChosenError extends Error {
  readonly code = 'admin_proposal_target_no_longer_chosen' as const;
  constructor(segmentId: string) {
    super(
      `admin proposal segment ${segmentId}: its administrator no longer lets their admin agent propose to this workspace — nothing was applied. Reject it, or ask them to choose this workspace again and propose it anew.`,
    );
    this.name = 'AdminProposalTargetNoLongerChosenError';
  }
}

/** Whether the proposal's proposer still has this workspace among their admin agent's targets
 *  (`admin_proposal_target_chosen`, governance 0036: it answers for a proposal addressed here). */
async function targetStillChosen(client: PoolClient, proposalId: string): Promise<boolean> {
  const result = await client.query<{ chosen: boolean }>(
    'select admin_proposal_target_chosen($1) as chosen',
    [proposalId],
  );
  return result.rows[0]?.chosen === true;
}

// -------------------------------------------------------------------------------------------
// Reads (the target workspace)
// -------------------------------------------------------------------------------------------

interface ReceivedSegmentRow {
  id: string;
  proposal_id: string;
  ordinal: number;
  items: AdminProposalItemIntentWire[];
  content_digest: string;
  status: AdminProposalSegmentStatus;
  decided_at: Date | null;
  decided_by: string | null;
  decided_kind: PrincipalKind | null;
  decided_name: string | null;
  withdrawn_origin: 'human' | 'agent' | 'platform_segment' | null;
  reason: string | null;
  applied_segment_id: string | null;
  rolled_back_at: Date | null;
  platform_id: string | null;
  platform_status: AdminProposalSegmentStatus | null;
  platform_items: AdminProposalPlatformItemIntentWire[] | null;
  title: string;
  description: string;
  source_name: string;
  origin: 'agent';
  proposed_by_user: string;
  proposer_display_name: string;
  proposed_at: Date;
}

const RECEIVED_SELECT = `
  select s.id, s.proposal_id, s.ordinal, s.items, s.content_digest, s.status, s.decided_at,
         s.decided_by, d.kind as decided_kind, d.display_name as decided_name,
         s.withdrawn_origin, s.reason, s.applied_segment_id, s.rolled_back_at,
         ps.id as platform_id, ps.status as platform_status, ps.items as platform_items,
         p.title, p.description, p.source_name, p.origin, p.proposed_by_user,
         p.proposer_display_name, p.created_at as proposed_at
    from admin_proposal_segments s
    join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
    left join principals d on d.workspace_id = s.target_workspace_id and d.id = s.decided_by
    -- S11 AA3c: the proposal's platform segment, which this workspace reads only through the
    -- definer function (governance 0034: it answers for a proposal addressed to this workspace).
    left join lateral admin_proposal_platform_segment(s.proposal_id) ps on true`;

/** The segment as this workspace reads it. Free text another person wrote — the proposal's title
 *  and description, a reason — reads as every read shows it (`shownFreeText`, legacy 420); the
 *  intents are shown as proposed, for review (their suspected credentials are counted, and
 *  confirmed when applied). */
function receivedSegmentOf(row: ReceivedSegmentRow): ReceivedAdminProposalSegmentWire {
  return {
    id: row.id,
    proposal: {
      id: row.proposal_id,
      title: shownFreeText(row.title),
      description: shownFreeText(row.description),
      sourceName: row.source_name,
      origin: row.origin,
      proposedBy: { userId: row.proposed_by_user, displayName: row.proposer_display_name },
      proposedAt: row.proposed_at.toISOString(),
    },
    ordinal: row.ordinal,
    items: row.items,
    contentDigest: row.content_digest,
    status: row.status,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy:
      row.decided_by === null || row.decided_kind === null
        ? null
        : { id: row.decided_by, kind: row.decided_kind, displayName: row.decided_name },
    withdrawnOrigin: row.withdrawn_origin,
    reason: shownFreeText(row.reason),
    appliedSegmentId: row.applied_segment_id,
    rolledBackAt: row.rolled_back_at?.toISOString() ?? null,
    platformSegment:
      row.platform_id === null || row.platform_status === null
        ? null
        : { id: row.platform_id, status: row.platform_status, items: row.platform_items ?? [] },
  };
}

/** The segments addressed to `workspaceId`, newest first, at most
 *  {@link ADMIN_PROPOSAL_LIST_LIMIT} (`truncated` when there are more), narrowed to `status` when
 *  given. */
export async function listAdminProposalSegments(
  client: PoolClient,
  workspaceId: string,
  status?: AdminProposalSegmentStatus,
): Promise<ListEnvelope<ReceivedAdminProposalSegmentWire>> {
  const values: unknown[] = [workspaceId];
  let filter = '';
  if (status !== undefined) {
    values.push(status);
    filter = ` and s.status = $${values.length}`;
  }
  values.push(ADMIN_PROPOSAL_LIST_LIMIT + 1);
  const result = await client.query<ReceivedSegmentRow>(
    `${RECEIVED_SELECT}
      where s.target_workspace_id = $1${filter}
      order by s.created_at desc, s.id
      limit $${values.length}`,
    values,
  );
  const items = result.rows.slice(0, ADMIN_PROPOSAL_LIST_LIMIT).map(receivedSegmentOf);
  return result.rows.length > ADMIN_PROPOSAL_LIST_LIMIT ? { items, truncated: true } : { items };
}

/** How many segments addressed to `workspaceId` wait for its owner's decision (`proposed`): the
 *  rows {@link listAdminProposalSegments} lists under that status — the same tables, join and
 *  predicate, read under the same workspace's row security — counted, not listed (S11 AA4e: the
 *  console's badge and 待我审批 notice). */
export async function countAdminProposalSegments(
  client: PoolClient,
  workspaceId: string,
): Promise<ReceivedAdminProposalCountsWire> {
  const result = await client.query<{ proposed: number }>(
    `select count(*)::int as proposed
       from admin_proposal_segments s
       join admin_proposals p on p.workspace_id = s.workspace_id and p.id = s.proposal_id
      where s.target_workspace_id = $1 and s.status = 'proposed'`,
    [workspaceId],
  );
  return { proposed: result.rows[0]?.proposed ?? 0 };
}

/** One segment addressed to `workspaceId`, or {@link AdminProposalSegmentNotFoundError}.
 *  `forUpdate`: its row stays locked until the transaction ends — applying and rejecting take it
 *  first, so two decisions of one segment (or a decision and a withdrawal) run one after the
 *  other, and the second sees the status the first left. */
async function loadReceivedSegment(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ReceivedSegmentRow> {
  if (options.forUpdate) {
    await client.query(
      'select 1 from admin_proposal_segments where id = $1 and target_workspace_id = $2 for update',
      [segmentId, workspaceId],
    );
  }
  const result = await client.query<ReceivedSegmentRow>(
    `${RECEIVED_SELECT} where s.id = $1 and s.target_workspace_id = $2`,
    [segmentId, workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new AdminProposalSegmentNotFoundError(segmentId);
  return row;
}

/** `get` for one segment (the list's shape). */
export async function getAdminProposalSegment(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<ReceivedAdminProposalSegmentWire> {
  return receivedSegmentOf(await loadReceivedSegment(client, workspaceId, segmentId));
}

function assertOpen(row: ReceivedSegmentRow): void {
  if (row.status !== 'proposed') throw new AdminProposalSegmentNotOpenError(row.id, row.status);
}

/** S11 AA3c: where the proposal's platform segment — which every workspace segment of it depends
 *  on — leaves this one. */
interface PlatformStanding {
  /** No platform segment, or it is applied (its record too) and nothing it created changed. */
  readonly ready: boolean;
  /** The platform segment's status as this workspace should be told it: `rolled_back` for one
   *  whose record was rolled back while it still reads applied (the two move in one transaction
   *  on the kernel's path); `null` without one. */
  readonly platformStatus: AdminProposalSegmentStatus | null;
  /** The instances it created that changed since. */
  readonly changes: readonly AdminProposalPlatformInstanceChangeWire[];
  /** What the digest binds (I-A8, F8): the platform segment and the record its apply wrote. */
  readonly binding?: Readonly<Record<string, unknown>>;
}

async function platformStandingOf(
  client: PoolClient,
  row: ReceivedSegmentRow,
): Promise<PlatformStanding> {
  if (row.platform_id === null) return { ready: true, platformStatus: null, changes: [] };
  if (row.platform_status !== 'applied') {
    return { ready: false, platformStatus: row.platform_status, changes: [] };
  }
  const change = await readProposalPlatformChange(client, row.proposal_id);
  if (change === null) return { ready: false, platformStatus: 'rolled_back', changes: [] };
  return {
    ready: change.changes.length === 0,
    platformStatus: 'applied',
    changes: change.changes,
    binding: {
      platformSegment: {
        id: row.platform_id,
        changeSegmentId: change.changeSegmentId,
        reviewedDigest: change.reviewedDigest,
      },
    },
  };
}

/** The proposal a segment addressed here belongs to, read before any lock (it never changes). */
async function proposalIdOf(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<string> {
  const result = await client.query<{ proposal_id: string }>(
    'select proposal_id from admin_proposal_segments where id = $1 and target_workspace_id = $2',
    [segmentId, workspaceId],
  );
  const proposalId = result.rows[0]?.proposal_id;
  if (proposalId === undefined) throw new AdminProposalSegmentNotFoundError(segmentId);
  return proposalId;
}

// -------------------------------------------------------------------------------------------
// Resolving the intents (F5)
// -------------------------------------------------------------------------------------------

/** S11 AA5f: a connected gate of a system a proposed Worker names, which the apply may bind it to. */
interface WorkerGateCandidate {
  readonly id: string;
  readonly name: string;
  readonly connector: string;
}

/** S11 AA5f: how the apply sets a proposed Worker's gates here (`AdminProposalWorkerGateBindingWire`
 *  without who holds what). */
interface WorkerGateBinding {
  readonly systems: readonly string[];
  readonly source: AdminProposalWorkerGateSource;
  /** For `apply`: the connected gates of its systems, in the systems' order. */
  readonly candidates: readonly WorkerGateCandidate[];
}

/** What one intent resolved to here: the core's intent, whether it starts a family, and for a
 *  Worker how its gates are set. */
interface ResolvedIntent {
  readonly intent: ChangeItemIntent;
  readonly newFamily: boolean;
  readonly gateBinding?: WorkerGateBinding;
}

interface Resolution {
  /** By ordinal - 1; complete only when `blockers` is empty. */
  readonly resolved: readonly ResolvedIntent[];
  readonly blockers: readonly AdminProposalItemBlockerWire[];
}

/** The lock an intent's kind is planned under (`engine.ts`' `lockItem`), for an intent as proposed. */
async function lockIntent(
  client: PoolClient,
  workspaceId: string,
  intent: AdminProposalItemIntentWire,
): Promise<void> {
  switch (intent.kind) {
    case 'ontology_version':
      return lockOntologyItem(client, workspaceId, intent);
    case 'skill_version':
    case 'worker_definition_version':
      return lockFamilyItem(client, workspaceId);
    case 'operation_version':
      return lockOperationItem(client, workspaceId);
  }
}

/** The Skill family here with a published version named `name` (at most one: Skill names are
 *  unique among published families), or `null`. */
async function skillFamilyNamed(
  client: PoolClient,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `select distinct id from skills
      where workspace_id = $1 and name = $2 and status = 'published'
      order by id
      limit 1`,
    [workspaceId, name],
  );
  return result.rows[0]?.id ?? null;
}

/** The WorkerDefinition families here whose head (latest published version) goes by `name`. */
async function workerFamiliesNamed(
  client: PoolClient,
  workspaceId: string,
  name: string,
): Promise<readonly { readonly id: string; readonly kind: string }[]> {
  const result = await client.query<{ id: string; kind: string }>(
    `select id, kind from (
       select distinct on (id) id, kind, definition ->> 'name' as name
         from worker_definitions
        where workspace_id = $1 and status = 'published'
        order by id, version desc
     ) heads
     where name = $2
     order by id`,
    [workspaceId, name],
  );
  return result.rows;
}

/** The Gatekeeper this workspace enabled the gate instance `gateId` as, or `null`. */
async function enabledGatekeeper(
  client: PoolClient,
  workspaceId: string,
  gateId: string,
): Promise<string | null> {
  const result = await client.query<{ gatekeeper_object_id: string }>(
    'select gatekeeper_object_id from workspace_gate_links where workspace_id = $1 and gate_id = $2',
    [workspaceId, gateId],
  );
  return result.rows[0]?.gatekeeper_object_id ?? null;
}

/** F-c1: the gate instances this workspace may enable now — what the pack requirements call
 *  `offered` (`readPackRequirements`): `enabled`, on a `platform_preset` connector, not linked here. */
async function offeredGateInstances(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlySet<string>> {
  const available = await listAvailableGateInstances(client, workspaceId);
  return new Set(
    available
      .filter((instance) => instance.status === 'enabled' && instance.gatekeeperId === null)
      .map((instance) => instance.gateId),
  );
}

/** AA5f: a `workerGates` key must be the name of a Worker the segment proposes (whether the apply
 *  binds it is the resolution's: a Worker whose head has gates keeps them, as a pack's). */
function assertWorkerGateChoiceNamesWorkers(
  items: readonly AdminProposalItemIntentWire[],
  choice: AdminProposalWorkerGateChoice,
): void {
  const names = new Set(
    items.flatMap((item) =>
      item.kind === 'worker_definition_version' ? [String(item.definition.name)] : [],
    ),
  );
  for (const name of choice.keys()) {
    if (!names.has(name)) {
      throw new AdminProposalWorkerGatesError(`the segment proposes no Worker "${name}"`);
    }
  }
}

/** AA5f: where a proposed Worker's gates come from here (see this module's comment), and for
 *  `apply` the standing of each system it names, under the registry lock its intent is planned
 *  under (`lockFamilyItem`), so the head read here is the one the plan keeps from. */
async function workerGateBindingOf(
  client: PoolClient,
  workspaceId: string,
  definitionId: string | null,
  systems: readonly string[] | undefined,
): Promise<
  WorkerGateBinding & { readonly standings: Awaited<ReturnType<typeof readConnectorStandings>> }
> {
  const named = [...(systems ?? [])];
  const head =
    definitionId === null
      ? null
      : await loadPublishedWorkerDefinitionHead(client, workspaceId, definitionId);
  if (head !== null && head.definition.gates !== undefined) {
    return { systems: named, source: 'workspace', candidates: [], standings: [] };
  }
  if (named.length === 0) return { systems: named, source: 'none', candidates: [], standings: [] };
  const standings = await readConnectorStandings(client, workspaceId, named);
  return {
    systems: named,
    source: 'apply',
    candidates: standings.flatMap((standing) =>
      standing.gatekeepers.map((gate) => ({
        id: gate.id,
        name: gate.name,
        connector: standing.connector,
      })),
    ),
    standings,
  };
}

/** AA5f: the gates the apply binds a Worker to — the owner's choice, checked against the
 *  candidates, or every candidate. An empty choice binds none (`gates: []`, kept as the choice). */
function chosenWorkerGates(
  name: string,
  candidates: readonly WorkerGateCandidate[],
  chosen: readonly string[] | undefined,
): string[] {
  if (chosen === undefined) return candidates.map((gate) => gate.id);
  const offered = new Set(candidates.map((gate) => gate.id));
  const foreign = chosen.filter((id) => !offered.has(id));
  if (foreign.length > 0) {
    throw new AdminProposalWorkerGatesError(
      `gate(s) ${foreign.join(', ')} are not connected gates of the systems Worker "${name}" names`,
    );
  }
  const kept = new Set(chosen);
  return candidates.filter((gate) => kept.has(gate.id)).map((gate) => gate.id);
}

/**
 * Resolves the segment's intents in `workspaceId` (this module's comment), after taking every lock
 * the core will plan them under, in lock order — so the families, links and Operations read here
 * stay as read until the transaction ends. `platformItems`: the proposal's platform segment's, for
 * which blocker waits on it (`fromPlatformSegment`). `choice`: the gates the owner kept for each
 * Worker the apply binds (AA5f; {@link AdminProposalWorkerGatesError} for one that does not fit).
 */
async function resolveIntents(
  client: PoolClient,
  workspaceId: string,
  sourceName: string,
  items: readonly AdminProposalItemIntentWire[],
  platformItems: readonly AdminProposalPlatformItemIntentWire[],
  choice: AdminProposalWorkerGateChoice = new Map(),
): Promise<Resolution> {
  assertWorkerGateChoiceNamesWorkers(items, choice);
  for (const intent of inLockOrder(items)) await lockIntent(client, workspaceId, intent);
  const resolved: ResolvedIntent[] = [];
  const blockers: AdminProposalItemBlockerWire[] = [];
  // Skills an earlier intent publishes, by name: a Worker after it may mount them.
  const skillsBefore = new Set<string>();
  // The instances the platform offers this workspace (`gateAvailability`), read once when needed.
  let offered: ReadonlySet<string> | undefined;
  const availabilityOf = async (gateId: string): Promise<AdminProposalGateAvailability> => {
    offered ??= await offeredGateInstances(client, workspaceId);
    return offered.has(gateId) ? 'can_enable' : 'needs_platform';
  };
  // What the proposal's platform segment creates: its instances' ids, and their connectors.
  const platformGateIds = new Set(platformItems.map((item) => item.gateId));
  const platformConnectors = new Set(
    platformItems.flatMap((item) => {
      const connector = platformItemConnector(item);
      return connector === null ? [] : [connector];
    }),
  );
  for (const [index, item] of items.entries()) {
    const ordinal = index + 1;
    const block = (kind: ChangeItemKind, reason: AdminProposalItemBlocker) =>
      blockers.push({ ordinal, kind, reason });
    switch (item.kind) {
      case 'ontology_version':
        resolved.push({
          intent: { kind: item.kind, family: item.family, definition: item.definition },
          newFamily: false,
        });
        break;
      case 'skill_version': {
        const existing = await skillFamilyNamed(client, workspaceId, item.skill.name);
        resolved.push({
          intent: {
            kind: item.kind,
            skillId: existing ?? derivePackComponentId(sourceName, 'skill', item.skill.name),
            content: {
              name: item.skill.name,
              description: item.skill.description,
              markdown: item.skill.markdown,
              applicable: item.skill.applicable ?? {},
            },
          },
          newFamily: existing === null,
        });
        skillsBefore.add(item.skill.name);
        break;
      }
      case 'worker_definition_version': {
        // A proposal's Worker is named (`checkAdminProposal`, AA3b-1).
        const name = String(item.definition.name);
        const families = await workerFamiliesNamed(client, workspaceId, name);
        const workers = families.filter((family) => family.kind === 'worker');
        if (workers.length > 1) {
          block(item.kind, 'name_ambiguous');
          break;
        }
        if (workers.length === 0 && families.length > 0) {
          block(item.kind, 'name_taken');
          break;
        }
        const unresolved = await unresolvedWorkerDefinitionReferences(
          client,
          workspaceId,
          'worker',
          item.definition,
        );
        const skills = (unresolved.skills ?? []).filter((ref) => !skillsBefore.has(ref));
        if (skills.length > 0 || (unresolved.capabilities ?? []).length > 0) {
          block(item.kind, 'unresolved_references');
          break;
        }
        const existing = workers[0]?.id ?? null;
        const binding = await workerGateBindingOf(client, workspaceId, existing, item.systems);
        const unconnected = binding.standings.filter((standing) => standing.state !== 'connected');
        if (unconnected.length > 0) {
          for (const standing of unconnected) {
            blockers.push({
              ordinal,
              kind: item.kind,
              reason: 'worker_system_not_connected',
              connector: standing.connector,
              gateAvailability: standing.state === 'can_enable' ? 'can_enable' : 'needs_platform',
              fromPlatformSegment: platformConnectors.has(standing.connector),
              offered: standing.offered.map((offer) => ({
                gateId: offer.gateId,
                displayName: offer.displayName,
              })),
            });
          }
          break;
        }
        // A Worker whose head has gates keeps them whatever `workerGates` says (as a pack's); one
        // that names no system has no candidate, so any gate kept for it is refused.
        const gates =
          binding.source === 'workspace'
            ? undefined
            : chosenWorkerGates(name, binding.candidates, choice.get(name));
        resolved.push({
          intent: {
            kind: item.kind,
            definitionId: existing ?? derivePackComponentId(sourceName, 'worker', name),
            definition:
              binding.source === 'apply' ? { ...item.definition, gates } : item.definition,
            keepFromHead: ['gates', 'model'],
          },
          newFamily: existing === null,
          gateBinding: {
            systems: binding.systems,
            source: binding.source,
            candidates: binding.candidates,
          },
        });
        break;
      }
      case 'operation_version': {
        const gatekeeperId = await enabledGatekeeper(client, workspaceId, item.gateId);
        if (gatekeeperId === null) {
          blockers.push({
            ordinal,
            kind: item.kind,
            reason: 'gate_not_enabled',
            gateAvailability: await availabilityOf(item.gateId),
            fromPlatformSegment: platformGateIds.has(item.gateId),
          });
          break;
        }
        const live = await getPublishedOperation(client, workspaceId, gatekeeperId, item.name);
        if (live === null) {
          block(item.kind, 'operation_not_found');
          break;
        }
        const intent = { kind: item.kind, gatekeeperId, name: item.name, set: item.set };
        if (operationRevisionProblem(intent, live) !== null) {
          block(item.kind, 'operation_revision_invalid');
          break;
        }
        resolved.push({ intent, newFamily: false });
        break;
      }
    }
  }
  return { resolved, blockers };
}

function sourceOf(row: ReceivedSegmentRow): ChangeSource {
  return {
    kind: 'admin_proposal',
    name: row.source_name,
    version: row.proposal_id,
    digest: row.content_digest,
  };
}

/** F9: the values in what the segment writes that look like credentials — the count `publish_*`
 *  makes of a draft (the document rule), over the intents as proposed. */
function suspectedSecretsOf(row: ReceivedSegmentRow): SuspectedSecrets {
  return findSuspectedSecrets({ items: row.items });
}

// -------------------------------------------------------------------------------------------
// Preview
// -------------------------------------------------------------------------------------------

/** AA5f: a Worker's gate binding as the preview shows it — each candidate with whether the person
 *  previewing holds it (`held`: one of their active `connect_gatekeeper` Grants covers it). */
function gateBindingWireOf(
  binding: WorkerGateBinding | undefined,
  held: ReadonlySet<string>,
): AdminProposalWorkerGateBindingWire {
  if (binding === undefined) return { systems: [], source: 'none', candidates: [] };
  return {
    systems: [...binding.systems],
    source: binding.source,
    candidates: binding.candidates.map((gate) => ({
      id: gate.id,
      name: gate.name,
      connector: gate.connector,
      held: held.has(gate.id),
    })),
  };
}

async function previewItemOf(
  client: PoolClient,
  workspaceId: string,
  item: PlannedChangeItem,
  resolved: ResolvedIntent | undefined,
  held: ReadonlySet<string>,
): Promise<AdminProposalPreviewItemWire> {
  const newFamily = resolved?.newFamily ?? false;
  const common = {
    ordinal: item.ordinal,
    unchanged: item.unchanged,
    classification: item.classification,
    widening: item.widening.map((w) => ({ path: w.path, reason: w.reason })),
  };
  const { detail } = item;
  switch (detail.kind) {
    case 'ontology_version': {
      const names = (section: typeof detail.types.added) => ({
        objectTypes: [...section.objectTypes],
        linkTypes: [...section.linkTypes],
        actionTypes: [...section.actionTypes],
      });
      const target = item.target as { family: string; ontologyId: string };
      const before = item.before as { version: number; definitionDigest: string } | null;
      const after = item.after as { definitionDigest: string };
      return {
        ...common,
        kind: detail.kind,
        target: { family: target.family, ontologyId: target.ontologyId },
        before: before
          ? { version: before.version, definitionDigest: before.definitionDigest }
          : null,
        after: { definitionDigest: after.definitionDigest },
        types: {
          added: names(detail.types.added),
          removed: names(detail.types.removed),
          changed: names(detail.types.changed),
        },
      };
    }
    case 'skill_version': {
      const target = item.target as { skillId: string; name: string };
      const before = item.before as { version: number; contentDigest: string } | null;
      const after = item.after as { contentDigest: string };
      return {
        ...common,
        kind: detail.kind,
        target: { skillId: target.skillId, name: target.name },
        newFamily,
        before: before ? { version: before.version, contentDigest: before.contentDigest } : null,
        after: { contentDigest: after.contentDigest },
        skill: {
          name: detail.content.name,
          description: detail.content.description,
          markdown: detail.content.markdown,
          applicable: detail.content.applicable,
        },
        changedFields: [...detail.changedFields],
      };
    }
    case 'worker_definition_version': {
      const target = item.target as { definitionId: string; name: string };
      const before = item.before as { version: number; contentDigest: string } | null;
      const after = item.after as { contentDigest: string };
      const ids = Array.isArray(detail.definition.gates)
        ? detail.definition.gates.filter((id): id is string => typeof id === 'string')
        : [];
      // Named as every read names a gate (`gatekeeperNamesShown`), not through `getGatekeeper`,
      // which has none for a gate-host instance its host has not announced yet (UX #968 P2-1);
      // a candidate's own name (`readConnectorStandings`) next, its id only last.
      const shown = ids.length === 0 ? {} : await gatekeeperNamesShown(client, workspaceId);
      const candidateNames = new Map(
        (resolved?.gateBinding?.candidates ?? []).map((gate) => [gate.id, gate.name] as const),
      );
      const gates = ids.map((id) => ({ id, name: shown[id] ?? candidateNames.get(id) ?? id }));
      return {
        ...common,
        kind: detail.kind,
        target: { definitionId: target.definitionId, name: target.name },
        newFamily,
        before: before ? { version: before.version, contentDigest: before.contentDigest } : null,
        after: { contentDigest: after.contentDigest },
        definition: { ...detail.definition },
        gates,
        gateBinding: gateBindingWireOf(resolved?.gateBinding, held),
        changedFields: [...detail.changedFields],
      };
    }
    case 'operation_version': {
      const target = item.target as { gatekeeperId: string; gatekeeperName: string; name: string };
      const before = item.before as { version: number; contentDigest: string };
      const after = item.after as { contentDigest: string };
      return {
        ...common,
        kind: detail.kind,
        target: {
          gatekeeperId: target.gatekeeperId,
          gatekeeperName: target.gatekeeperName,
          name: target.name,
        },
        before: { version: before.version, contentDigest: before.contentDigest },
        after: { contentDigest: after.contentDigest },
        fields: detail.fields.map(
          (change) =>
            ({
              field: change.field,
              before: change.before,
              after: change.after,
            }) as OperationFieldChangeWire,
        ),
      };
    }
  }
}

/** `preview_admin_proposal_segment`: resolves and dry-runs a proposed segment here, writing nothing
 *  (its locks are held until the transaction ends, as a pack's preview holds them), as
 *  `principalId` — this workspace's owner, whose Grants say which gate candidates they hold (AA5f)
 *  — with the gates they kept for each Worker the apply binds (`choice`). */
export async function previewAdminProposalSegment(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  segmentId: string,
  choice: AdminProposalWorkerGateChoice = new Map(),
): Promise<AdminProposalSegmentPreviewWire> {
  const row = await loadReceivedSegment(client, workspaceId, segmentId);
  assertOpen(row);
  const suspected = suspectedSecretsOf(row);
  const credentials = {
    suspectedSecretValues: suspected.count,
    suspectedSecretPaths: [...suspected.paths],
  };
  const standing = await platformStandingOf(client, row);
  const targetChosen = await targetStillChosen(client, row.proposal_id);
  const { resolved, blockers } = await resolveIntents(
    client,
    workspaceId,
    row.source_name,
    row.items,
    row.platform_items ?? [],
    choice,
  );
  if (blockers.length > 0) {
    return {
      segment: receivedSegmentOf(row),
      blockers: [...blockers],
      platformChanges: [...standing.changes],
      targetChosen,
      digest: null,
      unchanged: false,
      items: [],
      ...credentials,
    };
  }
  const plan = await planWorkspaceSegment(client, workspaceId, {
    source: sourceOf(row),
    items: resolved.map((entry) => entry.intent),
    ...(standing.binding !== undefined ? { binding: standing.binding } : {}),
  });
  const held = new Set(
    await listActiveGrantResourceScopes(client, workspaceId, {
      principalId,
      resourceType: GATEKEEPER_GRANT_CAPABILITY,
    }),
  );
  const items: AdminProposalPreviewItemWire[] = [];
  for (const item of plan.items) {
    items.push(await previewItemOf(client, workspaceId, item, resolved[item.ordinal - 1], held));
  }
  return {
    segment: receivedSegmentOf(row),
    blockers: [],
    platformChanges: [...standing.changes],
    targetChosen,
    // AA3c: the dry run shows what applying would do, but there is nothing to review for applying
    // until the platform segment it depends on is applied, and while what it created has changed;
    // AA4c: nor once its proposer took this workspace off their admin agent's targets.
    digest: standing.ready && targetChosen ? plan.digest : null,
    unchanged: plan.unchanged,
    items,
    ...credentials,
  };
}

// -------------------------------------------------------------------------------------------
// Apply and reject
// -------------------------------------------------------------------------------------------

export interface ApplyAdminProposalSegmentInput {
  readonly segmentId: string;
  /** The preview's `digest` (I-A8). */
  readonly reviewedDigest: string;
  /** The ordinals of the authority-widening items the owner confirmed, one by one (I-A4). */
  readonly confirmedOrdinals: readonly number[];
  /** Required when the segment carries suspected credentials (F9). */
  readonly credentialsReviewed?: boolean;
  /** AA5f: the gates the owner kept for each Worker the apply binds (the preview's). */
  readonly workerGates?: AdminProposalWorkerGateChoice;
}

export interface AppliedAdminProposalSegment {
  readonly segment: ReceivedAdminProposalSegmentWire;
  /** The change segment that recorded it here (安装历史). */
  readonly changeSegmentId: string;
  readonly plan: WorkspaceSegmentPlan;
  /** What the owner confirmed (F9), for the call's audit row (`credentialReviewAudit`). */
  readonly suspectedSecretValues: number;
}

/**
 * `apply_admin_proposal_segment`, in the caller's one transaction, as `principalId` — this
 * workspace's owner, the applier and the confirmer of every widening item. In order: the proposal's
 * dependency lock, shared (AA3c-2: its platform change is not rolled back until this commits), the
 * segment's row lock and status, the platform segment applied (409) and what it created unchanged
 * (409), the target still among the proposer's admin agent targets (AA4c: 409), resolution with the
 * owner's gate choice (a choice that does not fit: 400; blocked: 409), the credential review (400),
 * then the core's apply (digest 409 — the gates a Worker is bound to are in what it publishes, so a
 * candidate connected or cut off since the preview changes it; widening 400; nothing to change:
 * 409 here) and the segment's `applied` edge. Any refusal leaves everything as it was.
 */
export async function applyAdminProposalSegment(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  input: ApplyAdminProposalSegmentInput,
): Promise<AppliedAdminProposalSegment> {
  await lockProposalDependency(
    client,
    await proposalIdOf(client, workspaceId, input.segmentId),
    'shared',
  );
  const row = await loadReceivedSegment(client, workspaceId, input.segmentId, { forUpdate: true });
  assertOpen(row);
  const standing = await platformStandingOf(client, row);
  if (standing.platformStatus !== null && standing.platformStatus !== 'applied') {
    throw new PlatformSegmentNotAppliedError(row.id, standing.platformStatus);
  }
  if (standing.changes.length > 0) throw new PlatformSegmentChangedError(row.id, standing.changes);
  // AA4c: refused while the proposer no longer lets their admin agent propose here (governance
  // 0036's guard refuses the `applied` edge too).
  if (!(await targetStillChosen(client, row.proposal_id))) {
    throw new AdminProposalTargetNoLongerChosenError(row.id);
  }
  const { resolved, blockers } = await resolveIntents(
    client,
    workspaceId,
    row.source_name,
    row.items,
    row.platform_items ?? [],
    input.workerGates,
  );
  if (blockers.length > 0) throw new AdminProposalSegmentBlockedError(row.id, blockers);
  const suspected = suspectedSecretsOf(row);
  assertCredentialsReviewed('admin_proposal_segment', row.id, suspected, input.credentialsReviewed);
  const origin: AdminProposalOrigin = {
    proposalId: row.proposal_id,
    proposalSegmentId: row.id,
    proposedByUser: row.proposed_by_user,
    proposerDisplayName: row.proposer_display_name,
  };
  const applied = await applyWorkspaceSegment(client, workspaceId, {
    source: sourceOf(row),
    items: resolved.map((entry) => entry.intent),
    ...(standing.binding !== undefined ? { binding: standing.binding } : {}),
    reviewedDigest: input.reviewedDigest,
    proposedBy: null,
    adminProposal: origin,
    appliedBy: principalId,
    channel: 'human',
    confirmedOrdinals: input.confirmedOrdinals,
  });
  if (applied.segmentId === null) throw new AdminProposalSegmentUnchangedError(row.id);
  const updated = await client.query(
    `update admin_proposal_segments
        set status = 'applied', decided_by = $3, applied_segment_id = $4
      where id = $1 and target_workspace_id = $2 and status = 'proposed'`,
    [row.id, workspaceId, principalId, applied.segmentId],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`applyAdminProposalSegment: segment ${row.id} did not move to applied`);
  }
  return {
    segment: await getAdminProposalSegment(client, workspaceId, row.id),
    changeSegmentId: applied.segmentId,
    plan: applied.plan,
    suspectedSecretValues: suspected.count,
  };
}

/** `reject_admin_proposal_segment`, as `principalId` (this workspace's owner), with `reason`
 *  (already trimmed and bounded by the capability's params). The guard stamps the time. */
export async function rejectAdminProposalSegment(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  segmentId: string,
  reason: string,
): Promise<ReceivedAdminProposalSegmentWire> {
  const row = await loadReceivedSegment(client, workspaceId, segmentId, { forUpdate: true });
  assertOpen(row);
  const updated = await client.query(
    `update admin_proposal_segments
        set status = 'rejected', decided_by = $3, reason = $4
      where id = $1 and target_workspace_id = $2 and status = 'proposed'`,
    [row.id, workspaceId, principalId, reason],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`rejectAdminProposalSegment: segment ${row.id} did not move to rejected`);
  }
  return getAdminProposalSegment(client, workspaceId, row.id);
}
