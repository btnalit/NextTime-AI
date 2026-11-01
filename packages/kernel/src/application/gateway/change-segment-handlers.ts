import type {
  ChangeItemWire,
  ChangePrincipalRefWire,
  ChangeProvenanceWire,
  ChangeRollbackItemWire,
  ChangeRollbackPreviewWire,
  ChangeSegmentDetailWire,
  ChangeSegmentWire,
  ChangeVerificationResultWire,
  ChangeVerificationWire,
  OperationFieldValueWire,
  OperationItemField,
} from '@nexttime/shared';
import { shownFreeText } from '../../governance/redaction/index.js';
import {
  type ChangeGateRef,
  type ChangePrincipalRef,
  type ChangeProvenance,
  type ChangeSegmentRecord,
  type ChangeVerification,
  type InspectedChangeItem,
  type PlannedItemRollback,
  inspectChangeSegment,
  listChangeSegments,
  loadChangeVerification,
  parseStoredFamilyItem,
  parseStoredOntologyItem,
  parseStoredOperationItem,
  previewSegmentRollback,
  rollBackWorkspaceSegment,
  skillTargetOf,
  verifyChangeSegment,
  workerDefinitionTargetOf,
} from '../change-plan/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { sourceRequirementsChecker } from './change-verification.js';

/**
 * application/gateway/change-segment-handlers: the thin `CapabilityHandler` layer over
 * `application/change-plan`'s segment reads and rollback (S11 P1-B) — `list_change_segments`,
 * `get_change_segment`, `preview_roll_back_change_segment`, `roll_back_change_segment`
 * (`scope:'workspace'`, the 能力目录 安装历史 tab) — and `verify_change_segment` (P1-E). Each parses
 * params, calls the domain module and projects its records to `@nexttime/shared`'s
 * `wire/change-plan.ts`; nothing here queries.
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

/** A family's `provenance`: `list_workspace_modules`' / `install_module`'s
 *  (`platform-modules-handlers.ts`) and a pack component's (`pack-handlers.ts`). */
export function toChangeProvenanceWire(provenance: ChangeProvenance): ChangeProvenanceWire {
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

/** A segment's latest verification: `get_change_segment`'s, `verify_change_segment`'s and the
 *  run `install_pack` makes after installing (`pack-handlers.ts`). */
export function toChangeVerificationWire(verification: ChangeVerification): ChangeVerificationWire {
  return {
    trigger: verification.trigger,
    verifiedBy: toPrincipalRefWire(verification.verifiedBy),
    verifiedAt: verification.verifiedAt.toISOString(),
    passed: verification.passed,
    sourceFound: verification.sourceFound,
    items: verification.items.map((item) => ({ ...item })),
    requirements: verification.requirements.map((requirement) => ({
      connector: requirement.connector,
      state: requirement.state,
      gates: requirement.gates.map((gate) => ({ ...gate })),
      met: requirement.met,
    })),
    dependencies: verification.dependencies.map((dependency) => ({ ...dependency })),
  };
}

/** One field of an `operation_version` item as the wire carries it. The six fields' values are
 *  strings, booleans and string arrays (`Operation`); the description reads as every read of an
 *  Operation shows it (legacy 420, `shownFreeText`) — a version published before credentials were
 *  refused may still carry one. The other five are an enum, booleans and type names. */
function shownOperationFieldValue(
  field: OperationItemField,
  value: unknown,
): OperationFieldValueWire {
  return (
    field === 'description' && typeof value === 'string' ? shownFreeText(value) : value
  ) as OperationFieldValueWire;
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
    case 'skill_version': {
      const stored = parseStoredFamilyItem(kind, record);
      return {
        ...common,
        kind,
        target: skillTargetOf(stored.target),
        before: stored.before ? { ...stored.before } : null,
        after: { ...stored.after },
      };
    }
    case 'worker_definition_version': {
      const stored = parseStoredFamilyItem(kind, record);
      const gateRefs = (side: readonly ChangeGateRef[] | null | undefined) =>
        side ? side.map((gate) => ({ id: gate.id, name: gate.name })) : null;
      return {
        ...common,
        kind,
        target: workerDefinitionTargetOf(stored.target),
        before: stored.before ? { ...stored.before } : null,
        after: { ...stored.after },
        // P1-E2 (UX acceptance of #705): what the Worker could act on before and after.
        gates: {
          before: gateRefs(item.workerGates?.before),
          after: gateRefs(item.workerGates?.after),
        },
      };
    }
    case 'operation_version': {
      const stored = parseStoredOperationItem(record);
      return {
        ...common,
        kind,
        target: { ...stored.target },
        before: { ...stored.before },
        after: { ...stored.after },
        fields: item.operationFields.map((change) => ({
          field: change.field,
          before: shownOperationFieldValue(change.field, change.before),
          after: shownOperationFieldValue(change.field, change.after),
        })),
      };
    }
    default:
      throw new Error(
        `change-plan: unknown change item kind ${JSON.stringify(kind satisfies never)}`,
      );
  }
}

function toRollbackItemWire(item: PlannedItemRollback): ChangeRollbackItemWire {
  const { detail, conflict } = item;
  const common = {
    ordinal: item.record.ordinal,
    classification: item.classification,
    widening: item.widening.map((w) => ({ path: w.path, reason: w.reason })),
    blocker: conflict?.blocker ?? null,
    blockedBy: conflict?.blockedBy ? { segmentId: conflict.blockedBy.segmentId } : null,
  };
  switch (detail.kind) {
    case 'ontology_version': {
      const ontology = detail.planned;
      return {
        ...common,
        kind: detail.kind,
        target: { ...ontology.target },
        from: { ...ontology.from },
        to: ontology.to ? { ...ontology.to } : null,
        removes: {
          objectTypes: [...ontology.removes.objectTypes],
          linkTypes: [...ontology.removes.linkTypes],
          actionTypes: [...ontology.removes.actionTypes],
        },
        conflicts: conflict ? conflict.conflicts.map((c) => ({ kind: c.kind, name: c.name })) : [],
      };
    }
    case 'skill_version': {
      const family = detail.planned;
      return {
        ...common,
        kind: detail.kind,
        target: skillTargetOf(family.target),
        from: { ...family.from },
        to: family.to ? { ...family.to } : null,
      };
    }
    case 'worker_definition_version': {
      const family = detail.planned;
      return {
        ...common,
        kind: detail.kind,
        target: workerDefinitionTargetOf(family.target),
        from: { ...family.from },
        to: family.to ? { ...family.to } : null,
      };
    }
    case 'operation_version': {
      const operation = detail.planned;
      return {
        ...common,
        kind: detail.kind,
        target: { ...operation.target },
        from: { ...operation.from },
        to: { ...operation.to },
      };
    }
  }
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
  const verification = await loadChangeVerification(client, workspaceId, segmentId);
  const result: ChangeSegmentDetailWire = {
    segment: toChangeSegmentWire(inspected.segment),
    items: inspected.items.map(toChangeItemWire),
    verification: verification ? toChangeVerificationWire(verification) : null,
  };
  return { result };
};

export const verifyChangeSegmentHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  context,
) => {
  const { segmentId } = params as { segmentId: string };
  if (!context?.principalId) {
    throw new Error('verify_change_segment: no calling principal in context');
  }
  const verified = await verifyChangeSegment(client, workspaceId, {
    segmentId,
    verifiedBy: context.principalId,
    trigger: 'manual',
    checkRequirements: sourceRequirementsChecker(client, workspaceId),
  });
  const result: ChangeVerificationResultWire = {
    segment: toChangeSegmentWire(verified.segment),
    verification: toChangeVerificationWire(verified.verification),
  };
  return { result, resourceType: 'change_segment', resourceId: verified.segment.id };
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
  // a service is not a person. Since S11 AA1 (legacy 407) the capability is `actsForPerson`, so
  // dispatch refuses such a caller before this runs, and `rollBackWorkspaceSegment` checks the
  // Principal again; this stays as the handler's own statement.
  const confirmedOrdinals = input.confirmedOrdinals ?? [];
  if (confirmedOrdinals.length > 0 && context.principal?.kind !== 'human') {
    throw new ForbiddenError(
      'roll_back_change_segment: only a person (a human Principal on the human channel) can confirm an authority-widening change',
    );
  }
  const segment = await rollBackWorkspaceSegment(client, workspaceId, {
    segmentId: input.segmentId,
    rolledBackBy: context.principalId,
    channel: 'human',
    confirmedOrdinals,
  });
  return {
    result: toChangeSegmentWire(segment),
    resourceType: 'change_segment',
    resourceId: segment.id,
  };
};
