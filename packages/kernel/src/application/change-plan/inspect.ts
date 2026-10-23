import type { ChangeItemState } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type WorkerItemGates,
  parseStoredFamilyItem,
  readFamilyItemState,
  readWorkerItemGates,
} from './family-item.js';
import { parseStoredOntologyItem, readOntologyItemState } from './ontology-item.js';
import {
  type OperationFieldChange,
  parseStoredOperationItem,
  readOperationItemFields,
  readOperationItemState,
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

/**
 * application/change-plan/inspect: one applied segment with its items and what each item's target
 * is now (S11 P1-B, `get_change_segment`). Read-only, no locks: the state is what the call saw.
 */

export interface InspectedChangeItem {
  readonly record: ChangeItemRecord;
  readonly state: ChangeItemState;
  /** For `replaced`: the segment whose item wrote what is there now; `null` when that was written
   *  outside the ChangePlan core, and for every other state. */
  readonly replacedBy: { readonly segmentId: string } | null;
  /** For an `operation_version` item: the governance fields it changed (`readOperationItemFields`);
   *  empty for every other kind. */
  readonly operationFields: readonly OperationFieldChange[];
  /** For a `worker_definition_version` item: its gates on each side (`readWorkerItemGates`);
   *  `null` for every other kind. */
  readonly workerGates: WorkerItemGates | null;
}

export interface InspectedChangeSegment {
  readonly segment: ChangeSegmentRecord;
  readonly items: readonly InspectedChangeItem[];
}

async function inspectItem(
  client: PoolClient,
  workspaceId: string,
  record: ChangeItemRecord,
): Promise<InspectedChangeItem> {
  const kind = record.kind;
  switch (kind) {
    case 'ontology_version': {
      const item = parseStoredOntologyItem(record);
      const now = await readOntologyItemState(client, workspaceId, item);
      if (now.state !== 'replaced') {
        return {
          record,
          state: now.state,
          replacedBy: null,
          operationFields: [],
          workerGates: null,
        };
      }
      const segmentId = await findOntologyVersionSegment(
        client,
        workspaceId,
        item.target.ontologyId,
        now.headVersion,
      );
      return {
        record,
        state: 'replaced',
        replacedBy: segmentId ? { segmentId } : null,
        operationFields: [],
        workerGates: null,
      };
    }
    case 'skill_version':
    case 'worker_definition_version': {
      const item = parseStoredFamilyItem(kind, record);
      const now = await readFamilyItemState(client, workspaceId, item);
      const workerGates =
        kind === 'worker_definition_version'
          ? await readWorkerItemGates(client, workspaceId, item)
          : null;
      if (now.state !== 'replaced') {
        return { record, state: now.state, replacedBy: null, operationFields: [], workerGates };
      }
      const segmentId = await findVersionSegment(
        client,
        workspaceId,
        kind,
        item.familyId,
        now.headVersion,
      );
      return {
        record,
        state: 'replaced',
        replacedBy: segmentId ? { segmentId } : null,
        operationFields: [],
        workerGates,
      };
    }
    case 'operation_version': {
      const item = parseStoredOperationItem(record);
      const now = await readOperationItemState(client, workspaceId, item);
      const operationFields = await readOperationItemFields(client, workspaceId, item);
      if (now.state !== 'replaced') {
        return { record, state: now.state, replacedBy: null, operationFields, workerGates: null };
      }
      // `null`: the item's own version, edited in place — no segment replaced it.
      const segmentId =
        now.headVersion === null
          ? null
          : await findOperationVersionSegment(client, workspaceId, item.target, now.headVersion);
      return {
        record,
        state: 'replaced',
        replacedBy: segmentId ? { segmentId } : null,
        operationFields,
        workerGates: null,
      };
    }
    default:
      throw new Error(
        `change-plan: unknown change item kind ${JSON.stringify(kind satisfies never)}`,
      );
  }
}

/** `ChangeSegmentNotFoundError` when `workspaceId` has no such segment. */
export async function inspectChangeSegment(
  client: PoolClient,
  workspaceId: string,
  segmentId: string,
): Promise<InspectedChangeSegment> {
  const segment = await loadChangeSegment(client, workspaceId, segmentId);
  if (!segment) throw new ChangeSegmentNotFoundError(segmentId);
  const records = await loadChangeItems(client, workspaceId, segmentId);
  const items: InspectedChangeItem[] = [];
  for (const record of records) items.push(await inspectItem(client, workspaceId, record));
  return { segment, items };
}
