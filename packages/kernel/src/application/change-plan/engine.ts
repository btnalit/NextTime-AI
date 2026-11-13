import { randomUUID } from 'node:crypto';
import type { ChangeItemClassification, ChangeItemKind, ChangeSourceKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import type { PendingOntologyHead } from '../../substrate/ontology/index.js';
import { assertChangeApplierIsPerson } from './applier.js';
import { type WideningReason, classificationOf } from './classify.js';
import { contentDigest } from './digest.js';
import { ChangeConfirmationRequiredError, ChangePlanChangedError } from './errors.js';
import {
  type ChangeItemOrigin,
  type FamilyVersionIntent,
  type SkillItemContent,
  applyFamilyItem,
  familyItemTargetKey,
  lockFamilyItem,
  planFamilyItem,
} from './family-item.js';
import { inLockOrder } from './lock-order.js';
import {
  type OntologyTypeChanges,
  type OntologyVersionIntent,
  applyOntologyItem,
  lockOntologyItem,
  ontologyItemTargetKey,
  planOntologyItem,
} from './ontology-item.js';
import {
  type OperationFieldChange,
  type OperationVersionIntent,
  applyOperationItem,
  lockOperationItem,
  operationItemTargetKey,
  planOperationItem,
} from './operation-item.js';

/**
 * application/change-plan/engine: the ChangePlan core's workspace segment (S11 plan §3.1–§3.4,
 * §5.4; migrations/governance/0025_change_segments.sql, 0033). One core for every source of change
 * — a pack (a module is a pack with one ontology component), and a segment of an admin proposal a
 * platform administrator's admin agent made (S11 AA3b-2, `admin-proposal-segments.ts`). Item
 * kinds: a version of an ontology family (`ontology-item.ts`), of a
 * Skill or of a `worker` WorkerDefinition (`family-item.ts`), and a revision of a published
 * Operation's governance (`operation-item.ts`).
 *
 *   plan  (`planWorkspaceSegment`)  — the dry run: lock what the items change, read its current
 *         state, classify each item (whitelist, I-A4), and digest the result. Writes nothing; the
 *         plan is not stored. The digest is what the person applying reviews.
 *   apply (`applyWorkspaceSegment`) — in the caller's one transaction: plan again under the same
 *         locks, refuse when the digest is not the reviewed one (I-A8, 409 `change_plan_changed`)
 *         or a widening item is not confirmed (400 `change_confirmation_required`), then apply
 *         every item that changes something through the existing publish function, and record
 *         the segment, its items and one audit row per item (I-A7). Any failure rolls the whole
 *         segment back with the transaction.
 *
 * Who may apply is the caller's capability's authorization (the workspace owner — §5.4 "授权仍按
 * 那个人的角色判"); this module adds no path around it. The applier is a person: `channel` is
 * `human` (a capability call) or `platform` (workspace creation's default modules), never a
 * Handle (I-A1) — checked at run time too, with the applier's Principal a `human` one
 * (`applier.ts`, legacy 407).
 */

export type ChangeItemIntent = OntologyVersionIntent | FamilyVersionIntent | OperationVersionIntent;

/** How a segment was applied (see `ApplyWorkspaceSegmentInput.channel`). */
export type ChangeChannel = 'human' | 'platform';

/** Where the intent came from (§5.4 "一个核心，两种来源"): `pack` — `name` the pack, `version` its
 *  version; `admin_proposal` (S11 AA3b-2) — `name` the proposal's source name, `version` the
 *  proposal's id. */
export interface ChangeSource {
  readonly kind: ChangeSourceKind;
  readonly name: string;
  readonly version: string;
  /** `sha256:` digest of the source content the items were built from (a pack version's; an admin
   *  proposal segment's `content_digest`). */
  readonly digest: string;
}

/** S11 AA3b-2: an `admin_proposal` segment's origin, recorded on it (governance 0033) so it says
 *  who proposed it after the proposal's trial workspace is purged. */
export interface AdminProposalOrigin {
  readonly proposalId: string;
  readonly proposalSegmentId: string;
  /** The platform user whose admin agent proposed it, and the name they had then. */
  readonly proposedByUser: string;
  readonly proposerDisplayName: string;
}

export interface WorkspaceSegmentInput {
  readonly source: ChangeSource;
  /** In order: item `n` is ordinal `n + 1`. */
  readonly items: readonly ChangeItemIntent[];
  /** S11 AA3c-2 (F8): what else the plan stands on that the person applying reviews — for an admin
   *  proposal's segment, the proposal's applied platform segment and the record its apply wrote.
   *  Folded into the digest when given, so applying refuses (409 `change_plan_changed`) once it
   *  differs from what was previewed; not recorded. A pack's segment has none, and its digests are
   *  what they were. */
  readonly binding?: Readonly<Record<string, unknown>>;
}

/** What a planned item would change, by kind, for the person reviewing it (not recorded, not in
 *  the digest). `ontology_version`: the family's type names added, removed and changed.
 *  `skill_version` / `worker_definition_version`: the content it would publish and the fields that
 *  differ from the head. `operation_version`: the governance fields it changes, before and after. */
export type ChangeItemDetail =
  | { readonly kind: 'ontology_version'; readonly types: OntologyTypeChanges }
  | {
      readonly kind: 'skill_version';
      readonly content: SkillItemContent;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'worker_definition_version';
      readonly definition: Readonly<Record<string, unknown>>;
      readonly changedFields: readonly string[];
    }
  | { readonly kind: 'operation_version'; readonly fields: readonly OperationFieldChange[] };

export interface PlannedChangeItem {
  readonly ordinal: number;
  readonly kind: ChangeItemKind;
  readonly target: Readonly<Record<string, unknown>>;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>>;
  readonly classification: ChangeItemClassification;
  readonly widening: readonly WideningReason[];
  /** Applying it changes nothing; it is not applied or recorded. */
  readonly unchanged: boolean;
  readonly detail: ChangeItemDetail;
}

export interface WorkspaceSegmentPlan {
  readonly source: ChangeSource;
  readonly items: readonly PlannedChangeItem[];
  /** I-A8: what the applier reviews and passes back as `reviewedDigest`. Covers the source, and
   *  each item's target, before, after and classification. */
  readonly digest: string;
  /** No item changes anything: applying records nothing. */
  readonly unchanged: boolean;
}

interface KindPlan {
  readonly planned: PlannedChangeItem;
  /** Writes the item through its kind's publish function; returns its `after`. */
  readonly apply: (
    appliedBy: string,
    origin: ChangeItemOrigin,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

async function lockItem(
  client: PoolClient,
  workspaceId: string,
  intent: ChangeItemIntent,
): Promise<void> {
  const kind = intent.kind;
  switch (kind) {
    case 'ontology_version':
      return lockOntologyItem(client, workspaceId, intent);
    case 'skill_version':
    case 'worker_definition_version':
      return lockFamilyItem(client, workspaceId);
    case 'operation_version':
      return lockOperationItem(client, workspaceId);
    default:
      throw unknownKind(kind);
  }
}

/** Fail closed on an item kind this core does not implement — an intent built outside the type
 *  system (parsed input, a later caller) is refused, never skipped or applied some other way. */
function unknownKind(kind: never): Error {
  return new Error(`change-plan: unknown change item kind ${JSON.stringify(kind)}`);
}

function targetKeyOf(intent: ChangeItemIntent): string {
  const kind = intent.kind;
  switch (kind) {
    case 'ontology_version':
      return ontologyItemTargetKey(intent);
    case 'skill_version':
    case 'worker_definition_version':
      return familyItemTargetKey(intent);
    case 'operation_version':
      return operationItemTargetKey(intent);
    default:
      throw unknownKind(kind);
  }
}

/** One segment changes each target once: a second item on the same target would record a `before`
 *  that is not the state it changed from (the first item's write is not a head yet at plan time)
 *  and could never be rolled back. Refused before any lock or read — a caller bug (a pack lists one
 *  part twice), never something to apply. */
function assertDistinctTargets(intents: readonly ChangeItemIntent[]): void {
  const seen = new Map<string, number>();
  for (const [index, intent] of intents.entries()) {
    const key = targetKeyOf(intent);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `change-plan: items ${first} and ${index + 1} change the same target (${key}); a segment changes each target once`,
      );
    }
    seen.set(key, index + 1);
  }
}

async function planItem(
  client: PoolClient,
  workspaceId: string,
  intent: ChangeItemIntent,
  ordinal: number,
  pendingOntology: PendingOntologyHead[],
): Promise<KindPlan> {
  const kind = intent.kind;
  switch (kind) {
    case 'ontology_version': {
      const ontology = await planOntologyItem(client, workspaceId, intent, pendingOntology);
      // Legacy 303: applied in this order, so the next items' LinkType ends see this one published.
      if (!ontology.unchanged) {
        pendingOntology.push({ id: ontology.target.ontologyId, definition: ontology.definition });
      }
      return {
        planned: {
          ordinal,
          kind,
          target: ontology.target,
          before: ontology.before,
          after: ontology.after,
          classification: classificationOf(ontology.widening),
          widening: ontology.widening,
          unchanged: ontology.unchanged,
          detail: { kind, types: ontology.types },
        },
        apply: (appliedBy, origin) =>
          applyOntologyItem(client, workspaceId, ontology, appliedBy, origin),
      };
    }
    case 'skill_version':
    case 'worker_definition_version': {
      const family = await planFamilyItem(client, workspaceId, intent);
      const detail: ChangeItemDetail =
        family.kind === 'skill_version'
          ? { kind: family.kind, content: family.content, changedFields: family.changedFields }
          : { kind: family.kind, definition: family.content, changedFields: family.changedFields };
      return {
        planned: {
          ordinal,
          kind,
          target: family.target,
          before: family.before,
          after: family.after,
          classification: classificationOf(family.widening),
          widening: family.widening,
          unchanged: family.unchanged,
          detail,
        },
        apply: (appliedBy, origin) =>
          applyFamilyItem(client, workspaceId, family, appliedBy, origin),
      };
    }
    case 'operation_version': {
      const operation = await planOperationItem(client, workspaceId, intent);
      return {
        planned: {
          ordinal,
          kind,
          target: operation.target,
          before: operation.before,
          after: operation.after,
          classification: classificationOf(operation.widening),
          widening: operation.widening,
          unchanged: operation.unchanged,
          detail: { kind, fields: operation.fields },
        },
        // An Operation revision has no `origin` of its own: the record's source says it.
        apply: (appliedBy) => applyOperationItem(client, workspaceId, operation, appliedBy),
      };
    }
    default:
      throw unknownKind(kind);
  }
}

/** The existing capability whose intent an item kind carries (the audit row's `capability`). */
const ITEM_KIND_CAPABILITY: Readonly<Record<ChangeItemKind, string>> = {
  ontology_version: 'publish_ontology_version',
  skill_version: 'publish_skill',
  worker_definition_version: 'publish_worker_definition',
  operation_version: 'publish_operation',
};

function segmentDigest(
  source: ChangeSource,
  items: readonly PlannedChangeItem[],
  binding: Readonly<Record<string, unknown>> | undefined,
): string {
  return contentDigest({
    source,
    ...(binding !== undefined ? { binding } : {}),
    items: items.map((item) => ({
      ordinal: item.ordinal,
      kind: item.kind,
      target: item.target,
      before: item.before,
      after: item.after,
      classification: item.classification,
      widening: item.widening,
    })),
  });
}

async function planWithKinds(
  client: PoolClient,
  workspaceId: string,
  input: WorkspaceSegmentInput,
): Promise<{ readonly plan: WorkspaceSegmentPlan; readonly kinds: readonly KindPlan[] }> {
  if (input.items.length === 0) throw new Error('change-plan: a segment has at least one item');
  assertDistinctTargets(input.items);
  for (const intent of inLockOrder(input.items)) await lockItem(client, workspaceId, intent);
  const kinds: KindPlan[] = [];
  const pendingOntology: PendingOntologyHead[] = [];
  for (const [index, intent] of input.items.entries()) {
    kinds.push(await planItem(client, workspaceId, intent, index + 1, pendingOntology));
  }
  const items = kinds.map((kind) => kind.planned);
  return {
    plan: {
      source: input.source,
      items,
      digest: segmentDigest(input.source, items, input.binding),
      unchanged: items.every((item) => item.unchanged),
    },
    kinds,
  };
}

/** The segment's dry run (see this module's comment). Holds the items' locks until the caller's
 *  transaction ends. */
export async function planWorkspaceSegment(
  client: PoolClient,
  workspaceId: string,
  input: WorkspaceSegmentInput,
): Promise<WorkspaceSegmentPlan> {
  return (await planWithKinds(client, workspaceId, input)).plan;
}

/** I-A4: refuses (400 `change_confirmation_required`) unless every authority-widening item that
 *  would change something is among `confirmedOrdinals`. `context` prefixes the message. */
export function assertWideningConfirmed(
  plan: WorkspaceSegmentPlan,
  confirmedOrdinals: readonly number[],
  context?: string,
): void {
  const confirmed = new Set(confirmedOrdinals);
  const unconfirmed = plan.items
    .filter(
      (item) =>
        !item.unchanged &&
        item.classification === 'authority_widening' &&
        !confirmed.has(item.ordinal),
    )
    .map((item) => ({
      ordinal: item.ordinal,
      kind: item.kind,
      target: item.target,
      widening: item.widening,
    }));
  if (unconfirmed.length > 0) throw new ChangeConfirmationRequiredError(unconfirmed, context);
}

interface ApplyWorkspaceSegmentCommon extends WorkspaceSegmentInput {
  /** The plan digest the applier reviewed (I-A8). */
  readonly reviewedDigest: string;
  /** The person applying, in this workspace; also the confirmer of every widening item. */
  readonly appliedBy: string;
  /** Recorded on the segment (`change_segments.channel`): `human` — the applier's own capability
   *  call; `platform` — the platform applying on the workspace's behalf (workspace creation's
   *  default modules), when `proposedBy` / `appliedBy` name the workspace's first owner, who did
   *  nothing themselves. */
  readonly channel: ChangeChannel;
  /** The ordinals of the authority-widening items the applier confirmed, one by one (I-A4). */
  readonly confirmedOrdinals: readonly number[];
}

/** Who proposed what a segment applies: a pack's install names a Principal of this workspace
 *  (`proposedBy`, the person installing — or the first owner, `channel: platform`); an admin
 *  proposal's segment names nobody here (`proposedBy: null`) and says where it came from instead
 *  (`adminProposal`, S11 AA3b-2). Which one goes with the source's kind, checked at run time and by
 *  `change_segments_proposer` (governance 0033). S11 AA5g-2 (governance 0040): a pack's install
 *  may also name the admin proposal segment that asked for it (`adminProposal` beside
 *  `proposedBy`) — why it was installed; its content is still the pack's, drafted by nobody here
 *  but reviewed by the person installing (`itemOriginOf`: `human`). */
export type ApplyWorkspaceSegmentInput = ApplyWorkspaceSegmentCommon &
  (
    | { readonly proposedBy: string; readonly adminProposal?: AdminProposalOrigin }
    | { readonly proposedBy: null; readonly adminProposal: AdminProposalOrigin }
  );

/** Who drafted what a segment of `source` publishes (I-A7): an admin agent wrote an admin
 *  proposal's content; a pack's the person applying reviewed (`ChangeItemOrigin`). */
function itemOriginOf(source: ChangeSource): ChangeItemOrigin {
  return source.kind === 'admin_proposal' ? 'agent' : 'human';
}

/** A segment's proposer agrees with its source (see `ApplyWorkspaceSegmentInput`): refused before
 *  anything is planned — a caller bug, never something to apply. */
function assertProposerMatchesSource(input: ApplyWorkspaceSegmentInput): void {
  const origin = input.adminProposal;
  if (input.source.kind === 'admin_proposal') {
    if (!origin || input.proposedBy !== null || input.source.version !== origin.proposalId) {
      throw new Error(
        'change-plan: an admin_proposal segment names its proposal (version = proposal id) and no proposer of this workspace',
      );
    }
  } else if (input.proposedBy === null) {
    throw new Error(
      `change-plan: a ${input.source.kind} segment names its proposer in this workspace`,
    );
  } else if (origin !== undefined && input.source.kind !== 'pack') {
    throw new Error(
      `change-plan: only a pack's install names an admin proposal beside its proposer, not a ${input.source.kind} segment`,
    );
  }
}

export interface AppliedChangeItem {
  readonly id: string;
  readonly ordinal: number;
  readonly after: Readonly<Record<string, unknown>>;
}

export interface AppliedWorkspaceSegment {
  readonly plan: WorkspaceSegmentPlan;
  /** `null` when the plan changed nothing (nothing recorded). */
  readonly segmentId: string | null;
  readonly items: readonly AppliedChangeItem[];
}

/** Applies one workspace segment in the caller's transaction (see this module's comment). */
export async function applyWorkspaceSegment(
  client: PoolClient,
  workspaceId: string,
  input: ApplyWorkspaceSegmentInput,
): Promise<AppliedWorkspaceSegment> {
  assertProposerMatchesSource(input);
  await assertChangeApplierIsPerson(client, workspaceId, input.channel, input.appliedBy, 'apply');
  const { plan, kinds } = await planWithKinds(client, workspaceId, input);
  if (plan.digest !== input.reviewedDigest) {
    throw new ChangePlanChangedError(input.reviewedDigest, plan.digest);
  }
  assertWideningConfirmed(plan, input.confirmedOrdinals);
  if (plan.unchanged) return { plan, segmentId: null, items: [] };

  const planId = randomUUID();
  const origin = input.adminProposal ?? null;
  const segment = await client.query<{ id: string }>(
    `insert into change_segments
       (workspace_id, plan_id, channel, source_kind, source_name, source_version, source_digest,
        reviewed_digest, proposed_by, applied_by, admin_proposal_id, admin_proposal_segment_id,
        proposed_by_user, proposer_display_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning id`,
    [
      workspaceId,
      planId,
      input.channel,
      plan.source.kind,
      plan.source.name,
      plan.source.version,
      plan.source.digest,
      plan.digest,
      input.proposedBy,
      input.appliedBy,
      origin?.proposalId ?? null,
      origin?.proposalSegmentId ?? null,
      origin?.proposedByUser ?? null,
      origin?.proposerDisplayName ?? null,
    ],
  );
  const segmentId = segment.rows[0]?.id;
  if (!segmentId) throw new Error('change-plan: INSERT ... RETURNING produced no segment');

  const itemOrigin = itemOriginOf(plan.source);
  const applied: AppliedChangeItem[] = [];
  for (const { planned, apply } of kinds) {
    if (planned.unchanged) continue;
    const after = await apply(input.appliedBy, itemOrigin);
    const confirmedBy = planned.classification === 'authority_widening' ? input.appliedBy : null;
    const item = await client.query<{ id: string }>(
      `insert into change_items
         (workspace_id, segment_id, ordinal, kind, target, before, after, classification,
          widening, confirmed_by)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10)
       returning id`,
      [
        workspaceId,
        segmentId,
        planned.ordinal,
        planned.kind,
        JSON.stringify(planned.target),
        planned.before === null ? null : JSON.stringify(planned.before),
        JSON.stringify(after),
        planned.classification,
        JSON.stringify(planned.widening),
        confirmedBy,
      ],
    );
    const itemId = item.rows[0]?.id;
    if (!itemId) throw new Error('change-plan: INSERT ... RETURNING produced no item');
    // I-A7: one row per item — who proposed, who applied, who confirmed a widening item.
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.appliedBy,
      action: 'change_item.apply',
      resourceType: 'change_item',
      resourceId: itemId,
      payload: {
        channel: input.channel,
        capability: ITEM_KIND_CAPABILITY[planned.kind],
        planId,
        segmentId,
        ordinal: planned.ordinal,
        kind: planned.kind,
        source: plan.source,
        target: planned.target,
        before: planned.before,
        after,
        classification: planned.classification,
        widening: planned.widening,
        proposedBy: input.proposedBy,
        // S11 AA3b-2: where an admin proposal's item came from, and that an agent drafted it. S11
        // AA5g-2: for a pack's install, the proposal that asked for it (`origin: human`).
        ...(origin ? { adminProposal: { ...origin }, origin: itemOrigin } : {}),
        confirmedBy,
      },
    });
    applied.push({ id: itemId, ordinal: planned.ordinal, after });
  }
  return { plan, segmentId, items: applied };
}
