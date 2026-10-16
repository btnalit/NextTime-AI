import type { Operation, PublishableStatus } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type OperationRecord,
  diffOperationGovernanceFields,
  gateOwnedParamsOfDefinition,
  getOperation,
  importDraftDiffersFromAnnounced,
  operationDefinitionDiffers,
  operationGovernanceChangeDirection,
} from '../../governance/gatekeepers/index.js';

/**
 * application/gateway/announced-operations: how a manifest a gate announces compares with what a
 * workspace Gatekeeper holds — the read both previews show before `refresh_operation_governance`
 * writes: `preview_gate_instance_enable` (a platform gate's manifest in effect) and
 * `preview_gatekeeper_resync` (legacy 214, a self-connected gate's own `describe_operations`).
 * One function, so the two previews never judge "differs", "definition changed" or "rewritable"
 * differently from each other or from the write (`governance/gatekeepers/manifest.ts`'s
 * `refreshOperationGovernance` uses the same judgments).
 *
 * For each announced Operation: no row under `gatekeeperId` (or no Gatekeeper yet), or the row is
 * a `draft` → `operationsToImport` (with `pendingDraft` when a draft exists); `published` /
 * `deprecated` → `operationsAlreadyPresent`. `records` holds the row each entry was compared with,
 * index for index with `operations`, for a caller that judges more (platform adoption).
 */

export interface AnnouncedOperationToImport {
  name: string;
  mode: Operation['mode'];
  blastRadius: Operation['blast_radius'];
  autoApprovable: boolean;
  description?: string;
  gateOwnedParams?: { param: string; location: string }[];
  pendingDraft?: { rewritable: boolean; fromGate: boolean };
}

export interface AnnouncedOperationPresent {
  name: string;
  existing: {
    mode: Operation['mode'];
    blastRadius: Operation['blast_radius'];
    autoApprovable: boolean;
    status: PublishableStatus;
  };
  announced: {
    mode: Operation['mode'];
    blastRadius: Operation['blast_radius'];
    autoApprovable: boolean;
  };
  differs: boolean;
  direction: ReturnType<typeof operationGovernanceChangeDirection>;
  definitionDiffers: boolean;
  gateOwnedParams?: { param: string; location: string }[];
}

export interface AnnouncedOperationsComparison {
  readonly operationsToImport: AnnouncedOperationToImport[];
  readonly operationsAlreadyPresent: AnnouncedOperationPresent[];
  readonly records: readonly (OperationRecord | null)[];
}

function gateOwnedParamsWire(operation: Operation) {
  const params = gateOwnedParamsOfDefinition(operation);
  return params.length > 0
    ? { gateOwnedParams: params.map(({ param, location }) => ({ param, location })) }
    : {};
}

/** `droppedFromGate`: an Operation the gate itself no longer runs (a platform gate's held
 *  announcement, `application/gates`' `droppedUntilAdopted`) — its held draft is never rewritable,
 *  as `refreshOperationGovernance`'s `droppedByGate` never rewrites it. */
export async function compareAnnouncedOperations(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string | undefined,
  operations: readonly Operation[],
  droppedFromGate: (name: string) => boolean,
): Promise<AnnouncedOperationsComparison> {
  const operationsToImport: AnnouncedOperationToImport[] = [];
  const operationsAlreadyPresent: AnnouncedOperationPresent[] = [];
  const records: (OperationRecord | null)[] = [];

  for (const operation of operations) {
    const existingRecord = gatekeeperId
      ? await getOperation(client, workspaceId, gatekeeperId, operation.name)
      : null;
    records.push(existingRecord);
    if (existingRecord === null || existingRecord.status === 'draft') {
      // Legacy J (console G4, legacy 219): the bulk publish holds such an entry back as a draft,
      // and align can rewrite a held draft once the gate's manifest changes — both said up front.
      operationsToImport.push({
        name: operation.name,
        mode: operation.mode,
        blastRadius: operation.blast_radius,
        autoApprovable: operation.auto_approvable,
        ...(operation.description !== undefined ? { description: operation.description } : {}),
        ...gateOwnedParamsWire(operation),
        ...(existingRecord !== null
          ? {
              pendingDraft: {
                // UX acceptance of #583 (P3-2): an Operation the gate no longer runs is never
                // rewritten by the align (`refreshOperationGovernance`'s `droppedByGate`).
                rewritable:
                  !droppedFromGate(operation.name) &&
                  importDraftDiffersFromAnnounced(existingRecord, operation),
                fromGate: existingRecord.origin === 'import',
              },
            }
          : {}),
      });
      continue;
    }
    const announced = {
      mode: operation.mode,
      blastRadius: operation.blast_radius,
      autoApprovable: operation.auto_approvable,
    };
    const existingFields = {
      mode: existingRecord.operation.mode,
      blastRadius: existingRecord.operation.blast_radius,
      autoApprovable: existingRecord.operation.auto_approvable,
      status: existingRecord.status,
    };
    operationsAlreadyPresent.push({
      name: operation.name,
      existing: existingFields,
      announced,
      // S8 W3-K1: the exact comparison `refresh_operation_governance` reuses for its own write
      // decision — one judgment function, never two that could drift.
      differs: diffOperationGovernanceFields(existingFields, announced).differs,
      // R-19 (D-17): the kernel's own classification, so the console's confirm never re-ranks it.
      direction: operationGovernanceChangeDirection(existingFields, announced),
      // Legacy K: the gate refuses calls made under the deployed definition until a revision
      // carrying the announced one is published (`refresh_operation_governance` opens it).
      definitionDiffers: operationDefinitionDiffers(existingRecord, operation),
      // Review #501 on #571 ③: the revision an align opens for this entry is held back when the
      // announced definition declares a gate-owned param — said before the align, not after.
      ...gateOwnedParamsWire(operation),
    });
  }

  return { operationsToImport, operationsAlreadyPresent, records };
}
