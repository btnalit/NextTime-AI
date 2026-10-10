import { operationDefinitionDigest } from '@nexttime/gatekeeper-base';
import type { Operation } from '@nexttime/shared';

/**
 * governance/gatekeepers/definition (legacy K): which definition of an Operation this workspace
 * approved, as the digest a gate checks on every call (`@nexttime/gatekeeper-base`'s
 * `operation-digest.ts` has the field list and why). The kernel computes it from its own copy, the
 * workspace's Operation Object, never from what a gate says it runs.
 *
 * A record whose stored definition does not parse has no digest. The call is refused here rather
 * than sent without one (`OperationDefinitionUnreadableError`).
 */

/** What this module reads of an `OperationRecord` (`manifest.ts`, which imports this module). */
export interface OperationDefinitionRecord {
  readonly gatekeeperId: string;
  readonly name: string;
  readonly operation: unknown;
}

export class OperationDefinitionUnreadableError extends Error {
  readonly gatekeeperId: string;
  readonly operationName: string;
  constructor(gatekeeperId: string, operationName: string, cause: unknown) {
    super(
      `Operation "${operationName}" on gatekeeper ${gatekeeperId}: its stored definition is not a valid Operation, so there is no approved definition to hold the gate to — refused, nothing was sent. Publish a corrected revision of it.`,
      { cause },
    );
    this.name = 'OperationDefinitionUnreadableError';
    this.gatekeeperId = gatekeeperId;
    this.operationName = operationName;
  }
}

/** The digest of `record`'s definition — what a call made under it tells the gate was approved. */
export function operationRecordDigest(record: OperationDefinitionRecord): string {
  try {
    return operationDefinitionDigest(record.operation);
  } catch (err) {
    throw new OperationDefinitionUnreadableError(record.gatekeeperId, record.name, err);
  }
}

/** Whether `announced` (a gate's manifest entry) defines something other than `record`: `true`
 *  when the gate would refuse calls made under `record`, or when either side does not parse. */
export function operationDefinitionDiffers(
  record: OperationDefinitionRecord,
  announced: Operation,
): boolean {
  try {
    return operationDefinitionDigest(record.operation) !== operationDefinitionDigest(announced);
  } catch {
    return true;
  }
}
