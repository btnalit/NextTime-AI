import { type Operation, operationTargetProblems } from '@nexttime/shared';
import {
  ANY_CHANGE,
  type FieldRule,
  listRule,
  rankOf,
  sameValue,
  strictness,
} from '../field-rules/index.js';

/**
 * governance/gatekeepers/governance-fields: what an Operation's governance is, and which way a
 * change to it moves — the one judgment every surface that shows or applies such a change uses
 * (R-19, decision D-17): aligning to a platform gate's announcement and re-reading a self-connected
 * gate's description (`application/gateway/announced-operations.ts`, `manifest.ts`'s
 * `refreshOperationGovernance`), a catalog publish of a revision, and a gate's held manifest on
 * the integrations page (`application/gates/manifest-review.ts`).
 *
 * The direction of each field comes from `OPERATION_FIELD_RULES`, the table the change-plan
 * classifier (`application/change-plan/classify.ts`) applies to an `operation_version` item: a
 * changed field the rule proves cannot widen authority is `tightened`, any other change is
 * `loosened` (a `changed` from a rule with no proven direction included — read-only hint). So a
 * console confirm and a change plan never rank the same change differently.
 *
 * STATUS leftover 344: the set was `mode` / `blast_radius` / `auto_approvable` until now, so an
 * announced change to `await_decision`, `reads` / `writes` or an MCP hint was neither shown nor
 * applied by an align — and a revision carrying one was published as "no governance change".
 */

/**
 * An Operation version (`@nexttime/shared` action-description.ts `OperationSchema`): how a gate's
 * action is called and how a call of it is governed. Every field is compared — the plan's §5.4
 * list names the ones a person must confirm, and none of the governance fields below being
 * unchanged proves anything about the rest: an `auto_approvable`, low-impact Operation whose
 * command alone changed would run the new command with nobody reviewing it. Typed over the
 * schema's own keys, so a new Operation field does not compile without a rule.
 *
 * A field with an order of strictness passes only when it moves the strict way (or stays):
 * `execute` is reviewed where `observe` is not; a higher blast radius is reviewed more; a call
 * that is not auto-approvable waits for a person; one that awaits the decision blocks its caller
 * until the decision. The MCP hints read as `governance/gatekeepers/trust.ts` reads them — an
 * execute-class MCP call auto-approves only on `destructive_hint: false` and `idempotent_hint:
 * true`, and a hint left out counts as not declared, as strict as the stricter value.
 */
export const OPERATION_FIELD_RULES: Readonly<Record<keyof Operation, FieldRule>> = {
  // The approval card names the action by it; another name is another action to the approver.
  name: ANY_CHANGE,
  // Injected into every agent's tool list (`list_allowed_operations`, STATUS leftover 123): prompt
  // text, as a Skill's description is.
  description: ANY_CHANGE,
  // Where the call goes and what it sends: no direction of change is proven harmless.
  binding: ANY_CHANGE,
  // What the gate validates and where each param is sent (`x-in`) — gate-owned params included.
  params_schema: ANY_CHANGE,
  mode: strictness(rankOf(['observe', 'execute'])),
  blast_radius: strictness(rankOf(['low', 'medium', 'high'])),
  reversibility: ANY_CHANGE,
  auto_approvable: strictness(rankOf([true, false])),
  // Dropped (`true` → `false`), the caller goes on before anyone has decided.
  await_decision: strictness(rankOf([false, true])),
  // The object types a call reads and writes: more of either reaches further.
  reads: listRule('grows', true),
  writes: listRule('grows', true),
  // Which observed Facts a call writes into the graph.
  result_mapping: ANY_CHANGE,
  // No decision reads it today; not proven harmless either.
  read_only_hint: ANY_CHANGE,
  destructive_hint: strictness((value) =>
    value === false ? 0 : value === true || value === undefined ? 1 : undefined,
  ),
  idempotent_hint: strictness((value) =>
    value === true ? 0 : value === false || value === undefined ? 1 : undefined,
  ),
  // S11 GO12: the instance a call is queued against. Declared, a call no longer waits for the
  // gate's calls on other instances — less ordering, reviewed; changed, it is ordered against
  // other calls than before, not proven either way; dropped, it waits for every call of its gate
  // again, as strict as the queue gets.
  target: (before, after) => {
    if (sameValue(before, after) || after === undefined) return null;
    return before === undefined ? 'loosened' : 'changed';
  },
};

/** S11 GO12: `Operation.target` as a governance field reads it (camelCase, as on the wire). */
export interface OperationGovernanceTarget {
  readonly objectType: string;
  readonly params: string[];
}

/**
 * An Operation's governance: everything about how a call of it is reviewed (`@nexttime/shared`
 * `OperationGovernanceFieldsWire` is this shape on the wire). `reads` / `writes` compare as sets;
 * a hint the Operation does not declare is `null`, and so is a `target` it does not declare.
 */
export interface OperationGovernanceFields {
  readonly mode: Operation['mode'];
  readonly blastRadius: Operation['blast_radius'];
  readonly autoApprovable: boolean;
  readonly awaitDecision: boolean;
  readonly reads: string[];
  readonly writes: string[];
  readonly readOnlyHint: boolean | null;
  readonly destructiveHint: boolean | null;
  readonly idempotentHint: boolean | null;
  readonly target: OperationGovernanceTarget | null;
}

export type OperationGovernanceFieldName = keyof OperationGovernanceFields;

/** Each governance field's Operation key, in the order every diff lists them. */
const GOVERNANCE_FIELD_KEYS = {
  mode: 'mode',
  blastRadius: 'blast_radius',
  autoApprovable: 'auto_approvable',
  awaitDecision: 'await_decision',
  reads: 'reads',
  writes: 'writes',
  readOnlyHint: 'read_only_hint',
  destructiveHint: 'destructive_hint',
  idempotentHint: 'idempotent_hint',
  target: 'target',
} as const satisfies Record<OperationGovernanceFieldName, keyof Operation>;

const GOVERNANCE_FIELD_NAMES = Object.keys(GOVERNANCE_FIELD_KEYS) as OperationGovernanceFieldName[];

/** The Operation keys of the governance fields (`application/gates/manifest-review.ts` reports
 *  every other changed key separately). */
export const OPERATION_GOVERNANCE_KEYS: ReadonlySet<string> = new Set(
  Object.values(GOVERNANCE_FIELD_KEYS),
);

export function operationGovernanceFieldsOf(operation: Operation): OperationGovernanceFields {
  return {
    mode: operation.mode,
    blastRadius: operation.blast_radius,
    autoApprovable: operation.auto_approvable,
    awaitDecision: operation.await_decision,
    reads: [...operation.reads],
    writes: [...operation.writes],
    readOnlyHint: operation.read_only_hint ?? null,
    destructiveHint: operation.destructive_hint ?? null,
    idempotentHint: operation.idempotent_hint ?? null,
    target: operation.target
      ? { objectType: operation.target.object_type, params: [...operation.target.params] }
      : null,
  };
}

/** `fields` as the Operation properties they are stored as — a hint (or `target`) that is `null`
 *  is left out (`removed`), as an Operation that declares none has no key for it. */
export function operationGovernanceProperties(fields: OperationGovernanceFields): {
  readonly set: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
} {
  const set: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const field of GOVERNANCE_FIELD_NAMES) {
    const value = fields[field];
    if (value === null) removed.push(GOVERNANCE_FIELD_KEYS[field]);
    else set[GOVERNANCE_FIELD_KEYS[field]] = value;
  }
  if (fields.target !== null) {
    set.target = { object_type: fields.target.objectType, params: [...fields.target.params] };
  }
  return { set, removed };
}

/** `operation` with `fields` in place of its own governance. */
export function withOperationGovernance(
  operation: Operation,
  fields: OperationGovernanceFields,
): Operation {
  const { set, removed } = operationGovernanceProperties(fields);
  const next: Record<string, unknown> = { ...operation, ...set };
  for (const key of removed) delete next[key];
  return next as Operation;
}

/** S11 GO12: whether `fields` written in place onto `operation` leave a valid Operation — a
 *  `target` names params of `operation`'s own `params_schema` (I-Q4), which an in-place write
 *  does not change. Announced governance is valid with its own definition; one whose `target`
 *  names a param only that definition has is carried by a revision instead, with the definition
 *  it fits (`refreshOperationGovernance`, and the align preview that says so beforehand). */
export function governanceFitsDefinition(
  operation: Operation,
  fields: OperationGovernanceFields,
): boolean {
  return operationTargetProblems(withOperationGovernance(operation, fields)).length === 0;
}

/** The value `OPERATION_FIELD_RULES` reads for `field` (a hint left out is `undefined`). */
function ruleValue(
  fields: OperationGovernanceFields,
  field: OperationGovernanceFieldName,
): unknown {
  const value = fields[field];
  return value === null ? undefined : value;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function fieldDiffers(
  field: OperationGovernanceFieldName,
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
): boolean {
  if (field === 'reads' || field === 'writes') return !sameSet(existing[field], announced[field]);
  if (field === 'target') return !sameValue(existing.target, announced.target);
  return existing[field] !== announced[field];
}

export interface OperationGovernanceDiff {
  readonly differs: boolean;
  readonly changedFields: readonly OperationGovernanceFieldName[];
}

/** Which governance fields differ — the one comparison the previews, the in-place write and every
 *  confirm share, so "which fields count as governance" and "when do they differ" never drift. */
export function diffOperationGovernanceFields(
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
): OperationGovernanceDiff {
  const changedFields = GOVERNANCE_FIELD_NAMES.filter((field) =>
    fieldDiffers(field, existing, announced),
  );
  return { differs: changedFields.length > 0, changedFields };
}

export type OperationGovernanceDirection = 'loosened' | 'tightened' | 'mixed';

/** One changed field's direction, by `OPERATION_FIELD_RULES` (see this module's comment). */
function fieldDirection(
  field: OperationGovernanceFieldName,
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
): 'loosened' | 'tightened' {
  const rule = OPERATION_FIELD_RULES[GOVERNANCE_FIELD_KEYS[field]];
  return rule(ruleValue(existing, field), ruleValue(announced, field)) === null
    ? 'tightened'
    : 'loosened';
}

/** Classifies a non-empty set of changed governance fields (`diffOperationGovernanceFields`'s own
 *  `changedFields`) as `loosened` (every changed field may let a call through with less review),
 *  `tightened` (none may), or `mixed` (some of each). Throws on an empty `changedFields` —
 *  callers only classify a diff that actually differs. */
export function classifyOperationGovernanceChange(
  existing: OperationGovernanceFields,
  announced: OperationGovernanceFields,
  changedFields: readonly OperationGovernanceFieldName[],
): OperationGovernanceDirection {
  if (changedFields.length === 0) {
    throw new Error(
      'classifyOperationGovernanceChange: changedFields is empty — nothing to classify',
    );
  }
  const directions = new Set(
    changedFields.map((field) => fieldDirection(field, existing, announced)),
  );
  return directions.size > 1 ? 'mixed' : ([...directions][0] as OperationGovernanceDirection);
}

/** R-19 (decision D-17): the one direction every console confirm shows for a governance change —
 *  the refresh preview, a catalog publish, the wizard's reclassification and a gate's pending
 *  manifest — so no client keeps a ranking of its own. `classifyOperationGovernanceChange` for a
 *  real change, `neutral` when no governance field differs. */
export type OperationGovernanceChangeDirection = OperationGovernanceDirection | 'neutral';

export function operationGovernanceChangeDirection(
  before: OperationGovernanceFields,
  after: OperationGovernanceFields,
): OperationGovernanceChangeDirection {
  const diff = diffOperationGovernanceFields(before, after);
  return diff.differs
    ? classifyOperationGovernanceChange(before, after, diff.changedFields)
    : 'neutral';
}

export interface OperationGovernanceChange {
  readonly before: OperationGovernanceFields;
  readonly after: OperationGovernanceFields;
  readonly direction: OperationGovernanceChangeDirection;
}

/** `before` → `after` as the wire's `OperationGovernanceChangeWire`. */
export function operationGovernanceChange(
  before: Operation,
  after: Operation,
): OperationGovernanceChange {
  const beforeFields = operationGovernanceFieldsOf(before);
  const afterFields = operationGovernanceFieldsOf(after);
  return {
    before: beforeFields,
    after: afterFields,
    direction: operationGovernanceChangeDirection(beforeFields, afterFields),
  };
}
