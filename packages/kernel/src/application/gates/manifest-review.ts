import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import type {
  GateOperationSummaryWire,
  Operation,
  PendingGateManifestChangeWire,
} from '@nexttime/shared';
import { operationGovernanceChange } from '../../governance/gatekeepers/index.js';

/**
 * application/gates/manifest-review: the R-18 review rules for a gate's announced manifest
 * (decision D-18, together with D-02). The announce credential proves *who* announced; this module
 * decides whether *what* they announced needs an administrator's look before it takes effect, and
 * names the exact version that look covered.
 *
 *   - `isReviewedManifestChange`: does the announcement change the Operation set or any reviewed
 *     field of an Operation? Every field counts except `description` (documentation, editable in
 *     the catalog anyway), so a gate restart that re-announces the same manifest — the normal
 *     case — is never a change, whatever the order of its Operations or keys.
 *   - `manifestDigest`: a stable digest of a stored manifest (`gate_instances.operations` or
 *     `pending_operations`), the version token a confirm carries back. Computed over the stored
 *     JSON with object keys sorted, so the same stored value always digests the same.
 *   - `diffAnnouncedManifest`: what the administrator is shown — added, removed and changed
 *     Operations, each change with the kernel's governance direction.
 */

/** JSON with every object's keys sorted, arrays kept in order (`undefined` members dropped, as
 *  `JSON.stringify` does) — the one implementation the gate's Operation digest also uses (legacy
 *  K, `@nexttime/gatekeeper-base` `operation-digest.ts`). */
export { canonicalJson };

export function manifestDigest(storedManifest: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(storedManifest ?? []))
    .digest('hex');
}

/** An Operation minus the fields a change to which needs no review. */
function reviewedFields(operation: Operation): Record<string, unknown> {
  const { description: _description, ...reviewed } = operation;
  return reviewed;
}

function reviewedKey(operations: readonly Operation[]): string {
  return operations
    .map((operation) => canonicalJson(reviewedFields(operation)))
    .sort()
    .join('\n');
}

export function isReviewedManifestChange(
  inEffect: readonly Operation[],
  announced: readonly Operation[],
): boolean {
  return reviewedKey(inEffect) !== reviewedKey(announced);
}

/** One Operation as `GateInstanceWire.operations` lists it. */
export function toWireGateOperation(operation: Operation): GateOperationSummaryWire {
  return {
    name: operation.name,
    mode: operation.mode,
    blastRadius: operation.blast_radius,
    autoApprovable: operation.auto_approvable,
    readOnlyHint: operation.read_only_hint ?? null,
    destructiveHint: operation.destructive_hint ?? null,
    idempotentHint: operation.idempotent_hint ?? null,
  };
}

const GOVERNANCE_KEYS: ReadonlySet<string> = new Set(['mode', 'blast_radius', 'auto_approvable']);

export interface AnnouncedManifestDiff {
  readonly added: GateOperationSummaryWire[];
  readonly removed: GateOperationSummaryWire[];
  readonly changed: PendingGateManifestChangeWire[];
}

export function diffAnnouncedManifest(
  inEffect: readonly Operation[],
  announced: readonly Operation[],
): AnnouncedManifestDiff {
  const before = new Map(inEffect.map((operation) => [operation.name, operation]));
  const after = new Map(announced.map((operation) => [operation.name, operation]));
  const added: GateOperationSummaryWire[] = [];
  const removed: GateOperationSummaryWire[] = [];
  const changed: PendingGateManifestChangeWire[] = [];
  for (const [name, operation] of after) {
    const previous = before.get(name);
    if (!previous) {
      added.push(toWireGateOperation(operation));
      continue;
    }
    const previousReviewed = reviewedFields(previous);
    const nextReviewed = reviewedFields(operation);
    const keys = [...new Set([...Object.keys(previousReviewed), ...Object.keys(nextReviewed)])];
    const differing = keys.filter(
      (key) => canonicalJson(previousReviewed[key]) !== canonicalJson(nextReviewed[key]),
    );
    if (differing.length === 0) continue;
    changed.push({
      name,
      ...operationGovernanceChange(previous, operation),
      otherChangedFields: differing.filter((key) => !GOVERNANCE_KEYS.has(key)).sort(),
    });
  }
  for (const [name, operation] of before) {
    if (!after.has(name)) removed.push(toWireGateOperation(operation));
  }
  return { added, removed, changed };
}
