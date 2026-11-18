import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';
import {
  type GateOperationSummaryWire,
  OPERATION_BINDING_KEYS,
  type Operation,
  type OperationAbsentAnswersWire,
  type PendingGateManifestChangeWire,
  operationAbsentAnswers,
} from '@nexttime/shared';
import {
  OPERATION_GOVERNANCE_KEYS,
  gateOwnedParamsOfDefinition,
  operationGovernanceChange,
} from '../../governance/gatekeepers/index.js';

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

/** The answers `operation` declares mean "does not exist", as the wire carries them; `null` when
 *  it declares none (an execute-class Operation cannot declare any). */
function absentAnswersOf(operation: Operation): OperationAbsentAnswersWire | null {
  const answers = operationAbsentAnswers(operation);
  if (answers === undefined) return null;
  return 'statuses' in answers
    ? { statuses: [...answers.statuses] }
    : { exitCodes: [...answers.exitCodes] };
}

/** The keys of the binding that differ between `before` and `after`, sorted — names from the
 *  binding schema only (a key one kind has and the other lacks counts as changed). */
function bindingChangedFields(before: Operation, after: Operation): string[] {
  const previous: Record<string, unknown> = before.binding;
  const next: Record<string, unknown> = after.binding;
  return OPERATION_BINDING_KEYS.filter(
    (key) => canonicalJson(previous[key]) !== canonicalJson(next[key]),
  ).sort();
}

/** One Operation as `GateInstanceWire.operations` lists it. `gateOwnedParams` (console G4) is the
 *  same judgment `publish_operation` refuses by — an entry carrying it is never published. Legacy
 *  477: `absentAnswers` when it declares some, as the enable preview shows them. */
export function toWireGateOperation(operation: Operation): GateOperationSummaryWire {
  const gateOwnedParams = gateOwnedParamsOfDefinition(operation);
  const absentAnswers = absentAnswersOf(operation);
  return {
    name: operation.name,
    mode: operation.mode,
    blastRadius: operation.blast_radius,
    autoApprovable: operation.auto_approvable,
    readOnlyHint: operation.read_only_hint ?? null,
    destructiveHint: operation.destructive_hint ?? null,
    idempotentHint: operation.idempotent_hint ?? null,
    ...(gateOwnedParams.length > 0
      ? {
          gateOwnedParams: gateOwnedParams.map(({ param, location }) => ({ param, location })),
        }
      : {}),
    ...(absentAnswers !== null ? { absentAnswers } : {}),
  };
}

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
    const gateOwnedParams = gateOwnedParamsOfDefinition(operation);
    // Legacy 477: what an Operation reads as absent is part of its binding; `binding` in
    // `otherChangedFields` names only the field, so the keys of it that changed are named and the
    // declaration before and after is shown.
    const bindingChanged = bindingChangedFields(previous, operation);
    const absentBefore = absentAnswersOf(previous);
    const absentAfter = absentAnswersOf(operation);
    changed.push({
      name,
      ...operationGovernanceChange(previous, operation),
      // Every governance field is in `before` / `after` (STATUS leftover 344); the rest is listed.
      otherChangedFields: differing.filter((key) => !OPERATION_GOVERNANCE_KEYS.has(key)).sort(),
      ...(bindingChanged.length > 0 ? { bindingChangedFields: bindingChanged } : {}),
      ...(gateOwnedParams.length > 0
        ? {
            gateOwnedParams: gateOwnedParams.map(({ param, location }) => ({ param, location })),
          }
        : {}),
      ...(canonicalJson(absentBefore) !== canonicalJson(absentAfter)
        ? { absentAnswers: { before: absentBefore, after: absentAfter } }
        : {}),
    });
  }
  for (const [name, operation] of before) {
    if (!after.has(name)) removed.push(toWireGateOperation(operation));
  }
  return { added, removed, changed };
}
