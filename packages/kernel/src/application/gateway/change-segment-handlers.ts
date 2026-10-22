import type {
  ChangeItemWire,
  ChangePrincipalRefWire,
  ChangeRollbackItemWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  OntologyProvenanceWire,
} from '@nexttime/shared';
import {
  type ChangePrincipalRef,
  type ChangeSegmentRecord,
  type InspectedChangeItem,
  type OntologyProvenance,
  type PlannedItemRollback,
  inspectChangeSegment,
  listChangeSegments,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
} from '../change-plan/index.js';
import { parseStoredOntologyItem } from '../change-plan/ontology-item.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/change-segment-handlers: the thin `CapabilityHandler` layer over
 * `application/change-plan`'s segment reads and rollback (S11 P1-B) — `list_change_segments`,
 * `get_change_segment`, `preview_roll_back_change_segment`, `roll_back_change_segment`
 * (`scope:'workspace'`, the 能力目录 安装历史 tab). Each parses params, calls the domain module and
 * projects its records to `@nexttime/shared`'s `wire/change-plan.ts`; nothing here queries.
 */

function toPrincipalRefWire(ref: ChangePrincipalRef): ChangePrincipalRefWire {
  return { id: ref.id, kind: ref.kind, displayName: ref.displayName };
}

export function toChangeSegmentWire(segment: ChangeSegmentRecord): ChangeSegmentWire {
  return {
    id: segment.id,
    planId: segment.planId,
    channel: segment.channel,
    source: { ...segment.source },
    status: segment.status,
    proposedBy: toPrincipalRefWire(segment.proposedBy),
    appliedBy: toPrincipalRefWire(segment.appliedBy),
    appliedAt: segment.appliedAt.toISOString(),
    verifiedAt: segment.verifiedAt?.toISOString() ?? null,
    rolledBackBy: segment.rolledBackBy ? toPrincipalRefWire(segment.rolledBackBy) : null,
    rolledBackAt: segment.rolledBackAt?.toISOString() ?? null,
    itemCount: segment.itemCount,
    wideningItemCount: segment.wideningItemCount,
  };
}

/** `list_workspace_modules`' / `install_module`'s `provenance` (`platform-modules-handlers.ts`). */
export function toOntologyProvenanceWire(provenance: OntologyProvenance): OntologyProvenanceWire {
  switch (provenance.status) {
    case 'recorded':
      return {
        status: 'recorded',
        segmentId: provenance.segmentId,
        segmentStatus: provenance.segmentStatus,
        channel: provenance.channel,
        appliedBy: toPrincipalRefWire(provenance.appliedBy),
        appliedAt: provenance.appliedAt.toISOString(),
      };
    case 'provenance_unknown':
      return { status: 'provenance_unknown' };
    case 'not_installed':
      return { status: 'not_installed' };
  }
}

function toChangeItemWire(item: InspectedChangeItem): ChangeItemWire {
  const { record } = item;
  const common = {
    id: record.id,
    ordinal: record.ordinal,
    classification: record.classification,
    widening: record.widening.map((w) => ({ path: w.path, reason: w.reason })),
    confirmedBy: record.confirmedBy ? toPrincipalRefWire(record.confirmedBy) : null,
    state: item.state,
    replacedBy: item.replacedBy ? { segmentId: item.replacedBy.segmentId } : null,
  };
  const kind = record.kind;
  switch (kind) {
    case 'ontology_version': {
      const stored = parseStoredOntologyItem(record);
      return {
        ...common,
        kind,
        target: { ...stored.target },
        before: stored.before ? { ...stored.before } : null,
        after: { ...stored.after },
      };
    }
    default:
      throw new Error(
        `change-plan: unknown change item kind ${JSON.stringify(kind satisfies never)}`,
      );
  }
}

function toRollbackItemWire(item: PlannedItemRollback): ChangeRollbackItemWire {
  const { ontology, conflict } = item;
  return {
    ordinal: item.record.ordinal,
    kind: 'ontology_version',
    target: { ...ontology.target },
    from: { ...ontology.from },
    to: ontology.to ? { ...ontology.to } : null,
    classification: item.classification,
    widening: item.widening.map((w) => ({ path: w.path, reason: w.reason })),
    removes: {
      objectTypes: [...ontology.removes.objectTypes],
      linkTypes: [...ontology.removes.linkTypes],
      actionTypes: [...ontology.removes.actionTypes],
    },
    blocker: conflict?.blocker ?? null,
    blockedBy: conflict?.blockedBy ? { segmentId: conflict.blockedBy.segmentId } : null,
    conflicts: conflict ? conflict.conflicts.map((c) => ({ kind: c.kind, name: c.name })) : [],
  };
}

export const listChangeSegmentsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const input = params as { sourceName?: string; limit?: number; cursor?: string };
  const page = await listChangeSegments(client, workspaceId, input);
  return {
    result: {
      items: page.items.map(toChangeSegmentWire),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    },
  };
};

export const getChangeSegmentHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { segmentId } = params as { segmentId: string };
  const inspected = await inspectChangeSegment(client, workspaceId, segmentId);
  const result: ChangeSegmentDetailWire = {
    segment: toChangeSegmentWire(inspected.segment),
    items: inspected.items.map(toChangeItemWire),
  };
  return { result };
};

export const previewRollBackChangeSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { segmentId } = params as { segmentId: string };
  const preview = await previewSegmentRollback(client, workspaceId, segmentId);
  const result: ChangeRollbackPreviewWire = {
    segment: toChangeSegmentWire(preview.segment),
    possible: preview.possible,
    items: preview.items.map(toRollbackItemWire),
    inUse: { ...preview.inUse },
  };
  return { result };
};

export const rollBackChangeSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  context,
) => {
  const input = params as { segmentId: string; confirmedOrdinals?: number[] };
  if (!context?.principalId) {
    throw new Error('roll_back_change_segment: no calling principal in context');
  }
  // `channel: 'human'`: the person rolling back is the one confirming any widening item (I-A4).
  if (context.channel !== 'human') {
    throw new Error('roll_back_change_segment: invoked outside the human channel');
  }
  // A confirmation of an authority-widening item is a person's (I-A4, the same rule as
  // `attest_fact`): a *service* Principal's API key also authenticates on the human channel, and
  // a service is not a person. Without a confirmation a service owner may still roll back a
  // segment that widens nothing; one that does is then refused 400 change_confirmation_required.
  const confirmedOrdinals = input.confirmedOrdinals ?? [];
  if (confirmedOrdinals.length > 0 && context.principal?.kind !== 'human') {
    throw new ForbiddenError(
      'roll_back_change_segment: only a person (a human Principal on the human channel) can confirm an authority-widening change',
    );
  }
  const segment = await rollBackWorkspaceSegment(client, workspaceId, {
    segmentId: input.segmentId,
    rolledBackBy: context.principalId,
    confirmedOrdinals,
  });
  return {
    result: toChangeSegmentWire(segment),
    resourceType: 'change_segment',
    resourceId: segment.id,
  };
};
