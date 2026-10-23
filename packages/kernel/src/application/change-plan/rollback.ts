import type { ChangeItemClassification } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { writeAudit } from '../../substrate/audit/index.js';
import type { GraphTypeUsage } from '../../substrate/graph/index.js';
import { type WideningReason, classificationOf } from './classify.js';
import {
  ChangeConfirmationRequiredError,
  type ChangeRollbackConflict,
  ChangeRollbackConflictError,
  ChangeSegmentRolledBackError,
} from './errors.js';
import {
  type PlannedFamilyRollback,
  applyFamilyRollback,
  lockFamilyRollback,
  parseStoredFamilyItem,
  planFamilyRollback,
} from './family-item.js';
import { inLockOrder } from './lock-order.js';
import {
  type PlannedOntologyRollback,
  applyOntologyRollback,
  lockOntologyRollback,
  parseStoredOntologyItem,
  planOntologyRollback,
} from './ontology-item.js';
import {
  type PlannedOperationRollback,
  applyOperationRollback,
  lockOperationItem,
  parseStoredOperationItem,
  planOperationRollback,
} from './operation-item.js';
import {
  findOntologyVersionSegment,
  findOperationVersionSegment,
  findVersionSegment,
} from './provenance.js';
import {
  type ChangeItemRecord,
  ChangeSegmentNotFoundError,
  type ChangeSegmentRecord,
  loadChangeItems,
  loadChangeSegment,
} from './segments.js';
import { countRemovedTypeUsage } from './usage.js';

/**
 * application/change-plan/rollback: rolling an applied workspace segment back (S11 P1-B; plan §3.4
 * "回滚按反向依赖", "逆操作遇到中间被别人改过的版本时停下不覆盖"; I-A4, I-A7).
 *
 *   preview (`previewSegmentRollback`) — the dry run: per item, last first, compare what is there
 *         now with what the item left (`after`) and plan its inverse; classify the rollback by the
 *         same whitelist as applying (a rollback is a change too: taking out an ActionType is
 *         `removed`, widening); count the graph rows using a type it takes out. Writes nothing,
 *         locks nothing.
 *   roll back (`rollBackWorkspaceSegment`) — in the caller's one transaction: lock the segment row
 *         (two rollbacks of one segment run one after the other), lock each item's target, plan
 *         again, refuse when any item is blocked (409 `change_rollback_conflict`, the blocking
 *         items in `details`) or a widening item is not confirmed (400 `change_confirmation_
 *         required`), then apply each item's inverse, mark the segment `rolled_back` and write one
 *         `change_item.roll_back` audit row per item — or, on any failure, nothing.
 *
 * Order between segments needs no graph of its own: an item is blocked as `replaced` while a later
 * change of its target is in effect, and the error names that later segment — roll it back first.
 * The rollback's status change and the inverse are one transaction, so a rolled back segment never
 * leaves its version in place (`provenance.ts`).
 */

/** One item's planned inverse, by kind: `target` / `from` / `to` are the kind's shape. */
export type ItemRollbackDetail =
  | { readonly kind: 'ontology_version'; readonly planned: PlannedOntologyRollback }
  | {
      readonly kind: 'skill_version' | 'worker_definition_version';
      readonly planned: PlannedFamilyRollback;
    }
  | { readonly kind: 'operation_version'; readonly planned: PlannedOperationRollback };

/** One item of a rollback plan. */
export interface PlannedItemRollback {
  readonly record: ChangeItemRecord;
  readonly detail: ItemRollbackDetail;
  readonly classification: ChangeItemClassification;
  readonly widening: readonly WideningReason[];
  readonly conflict: ChangeRollbackConflict | null;
  /** Runs the inverse (an unblocked plan, under its lock) as `rolledBackBy`; returns the family's
   *  head version after (`null`: none published). */
  readonly apply: (rolledBackBy: string) => Promise<number | null>;
}

export interface SegmentRollbackPlan {
  readonly segment: ChangeSegmentRecord;
  /** Last item first — the order the inverses run in. */
  readonly items: readonly PlannedItemRollback[];
  /** Not rolled back yet, and no item is blocked. */
  readonly possible: boolean;
}

/** Locks what rolling `record` back changes (its kind's rollback lock). */
async function lockItemRollback(
  client: PoolClient,
  workspaceId: string,
  record: ChangeItemRecord,
): Promise<void> {
  const kind = record.kind;
  switch (kind) {
    case 'ontology_version':
      return lockOntologyRollback(client, workspaceId, parseStoredOntologyItem(record));
    case 'skill_version':
    case 'worker_definition_version':
      return lockFamilyRollback(client, workspaceId);
    case 'operation_version':
      return lockOperationItem(client, workspaceId);
    default:
      throw new Error(
        `change-plan: unknown change item kind ${JSON.stringify(kind satisfies never)}`,
      );
  }
}

async function planItemRollback(
  client: PoolClient,
  workspaceId: string,
  record: ChangeItemRecord,
): Promise<PlannedItemRollback> {
  const kind = record.kind;
  switch (kind) {
    case 'ontology_version': {
      const item = parseStoredOntologyItem(record);
      const ontology = await planOntologyRollback(client, workspaceId, item);
      const blocker = ontology.blocker;
      let conflict: ChangeRollbackConflict | null = null;
      if (blocker) {
        const segmentId =
          blocker.reason === 'replaced'
            ? await findOntologyVersionSegment(
                client,
                workspaceId,
                item.target.ontologyId,
                blocker.headVersion,
              )
            : null;
        conflict = {
          ordinal: record.ordinal,
          kind,
          target: item.target,
          blocker: blocker.reason,
          blockedBy: segmentId ? { segmentId } : null,
          conflicts:
            blocker.reason === 'namespace_conflict'
              ? blocker.conflicts.map((c) => ({ kind: c.kind, name: c.name }))
              : [],
        };
      }
      return {
        record,
        detail: { kind, planned: ontology },
        classification: classificationOf(ontology.widening),
        widening: ontology.widening,
        conflict,
        apply: () => applyOntologyRollback(client, workspaceId, ontology),
      };
    }
    case 'skill_version':
    case 'worker_definition_version': {
      const item = parseStoredFamilyItem(kind, record);
      const family = await planFamilyRollback(client, workspaceId, item);
      const blocker = family.blocker;
      let conflict: ChangeRollbackConflict | null = null;
      if (blocker) {
        const segmentId =
          blocker.reason === 'replaced'
            ? await findVersionSegment(
                client,
                workspaceId,
                kind,
                item.familyId,
                blocker.headVersion,
              )
            : null;
        conflict = {
          ordinal: record.ordinal,
          kind,
          target: item.target,
          blocker: blocker.reason,
          blockedBy: segmentId ? { segmentId } : null,
          conflicts: [],
        };
      }
      return {
        record,
        detail: { kind, planned: family },
        classification: classificationOf(family.widening),
        widening: family.widening,
        conflict,
        apply: () => applyFamilyRollback(client, workspaceId, family),
      };
    }
    case 'operation_version': {
      const item = parseStoredOperationItem(record);
      const operation = await planOperationRollback(client, workspaceId, item);
      const blocker = operation.blocker;
      let conflict: ChangeRollbackConflict | null = null;
      if (blocker) {
        const segmentId =
          blocker.reason === 'replaced'
            ? await findOperationVersionSegment(
                client,
                workspaceId,
                item.target,
                blocker.headVersion,
              )
            : null;
        conflict = {
          ordinal: record.ordinal,
          kind,
          target: item.target,
          blocker: blocker.reason,
          blockedBy: segmentId ? { segmentId } : null,
          conflicts: [],
        };
      }
      return {
        record,
        detail: { kind, planned: operation },
        classification: classificationOf(operation.widening),
        widening: operation.widening,
        conflict,
        apply: (rolledBackBy) =>
          applyOperationRollback(client, workspaceId, operation, rolledBackBy),
      };
    }
    default:
      throw new Error(
        `change-plan: unknown change item kind ${JSON.stringify(kind satisfies never)}`,
      );
  }
}

async function planRollback(
  client: PoolClient,
  workspaceId: string,
  segment: ChangeSegmentRecord,
  lock: boolean,
): Promise<SegmentRollbackPlan> {
  const records = await loadChangeItems(client, workspaceId, segment.id);
  // Every item's lock before any item is planned, in the order applying takes them: planned last
  // first, the items would otherwise lock the Skill / Worker registry before the ontology.
  if (lock) {
    for (const record of inLockOrder(records)) await lockItemRollback(client, workspaceId, record);
  }
  const items: PlannedItemRollback[] = [];
  for (const record of [...records].reverse()) {
    items.push(await planItemRollback(client, workspaceId, record));
  }
  return {
    segment,
    items,
    possible: segment.status !== 'rolled_back' && items.every((item) => item.conflict === null),
  };
}

export interface SegmentRollbackPreview extends SegmentRollbackPlan {
  /** Graph rows using a type the rollback takes out (counts stop at `CHANGE_ROLLBACK_IN_USE_CAP`). */
  readonly inUse: GraphTypeUsage;
}

/** `preview_roll_back_change_segment`. `ChangeSegmentNotFoundError` when `workspaceId` has no such
 *  segment. A rolled back segment previews with `possible: false`. */
export async function previewSegmentRollback(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<SegmentRollbackPreview> {
  const segment = await loadChangeSegment(client, workspaceId, segmentId);
  if (!segment) throw new ChangeSegmentNotFoundError(segmentId);
  const plan = await planRollback(client, workspaceId, segment, false);
  if (segment.status === 'rolled_back') {
    return { ...plan, inUse: { objects: 0, links: 0, capped: false } };
  }
  // Only an ontology item takes types out; a Skill or WorkerDefinition item writes no graph types.
  const ontology = plan.items.flatMap((item) =>
    item.detail.kind === 'ontology_version' ? [item.detail.planned] : [],
  );
  const inUse = await countRemovedTypeUsage(
    client,
    workspaceId,
    {
      objectTypes: ontology.flatMap((planned) => planned.removes.objectTypes),
      linkTypes: ontology.flatMap((planned) => planned.removes.linkTypes),
    },
    new Set(ontology.map((planned) => planned.target.ontologyId)),
  );
  return { ...plan, inUse };
}

export interface RollBackWorkspaceSegmentInput {
  readonly segmentId: string;
  /** The person rolling back, in this workspace; also the confirmer of every widening item. */
  readonly rolledBackBy: string;
  /** The ordinals of the authority-widening rollback items the person confirmed (I-A4). */
  readonly confirmedOrdinals: readonly number[];
}

/** `roll_back_change_segment`, in the caller's transaction (see this module's comment). Returns
 *  the segment as it is after. */
export async function rollBackWorkspaceSegment(
  client: PoolClient,
  workspaceId: string,
  input: RollBackWorkspaceSegmentInput,
): Promise<ChangeSegmentRecord> {
  const segment = await loadChangeSegment(client, workspaceId, input.segmentId, {
    forUpdate: true,
  });
  if (!segment) throw new ChangeSegmentNotFoundError(input.segmentId);
  if (segment.status === 'rolled_back') throw new ChangeSegmentRolledBackError(segment.id);

  const plan = await planRollback(client, workspaceId, segment, true);
  const conflicts = plan.items.flatMap((item) => (item.conflict ? [item.conflict] : []));
  if (conflicts.length > 0) throw new ChangeRollbackConflictError(segment.id, conflicts);

  const confirmed = new Set(input.confirmedOrdinals);
  const unconfirmed = plan.items
    .filter(
      (item) => item.classification === 'authority_widening' && !confirmed.has(item.record.ordinal),
    )
    .map((item) => ({
      ordinal: item.record.ordinal,
      kind: item.record.kind,
      target: item.detail.planned.target,
      widening: item.widening,
    }));
  if (unconfirmed.length > 0) {
    throw new ChangeConfirmationRequiredError(
      unconfirmed,
      `rollback of change segment ${segment.id}`,
    );
  }

  const applied: { readonly item: PlannedItemRollback; readonly headVersion: number | null }[] = [];
  for (const item of plan.items) {
    applied.push({ item, headVersion: await item.apply(input.rolledBackBy) });
  }

  await client.query(
    `update change_segments set status = 'rolled_back', rolled_back_by = $3
      where workspace_id = $1 and id = $2`,
    [workspaceId, segment.id, input.rolledBackBy],
  );

  // I-A7: one row per item — what went back, from which version to which, who confirmed a
  // widening item.
  for (const { item, headVersion } of applied) {
    const confirmedBy = item.classification === 'authority_widening' ? input.rolledBackBy : null;
    await writeAudit(client, {
      workspaceId,
      actorPrincipalId: input.rolledBackBy,
      action: 'change_item.roll_back',
      resourceType: 'change_item',
      resourceId: item.record.id,
      payload: {
        channel: 'human',
        planId: segment.planId,
        segmentId: segment.id,
        ordinal: item.record.ordinal,
        kind: item.record.kind,
        source: segment.source,
        target: item.detail.planned.target,
        from: item.detail.planned.from,
        to: item.detail.planned.to,
        headVersion,
        ...(item.detail.kind === 'ontology_version'
          ? { removes: item.detail.planned.removes }
          : {}),
        classification: item.classification,
        widening: item.widening,
        confirmedBy,
      },
    });
  }

  const after = await loadChangeSegment(client, workspaceId, segment.id);
  if (!after) throw new Error('change-plan: the rolled back segment is gone');
  return after;
}
