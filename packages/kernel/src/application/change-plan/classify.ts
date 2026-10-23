import {
  CHANGE_WIDENING_REASON_VALUES,
  type ChangeItemClassification,
  type ChangeWideningReasonCode,
  type ProposeSkillContent,
  type WorkerWorkerDefinitionContent,
} from '@nexttime/shared';
import type {
  ActionTypeDefinition,
  LinkTypeDefinition,
  ObjectTypeDefinition,
  OntologyDefinition,
} from '../../substrate/ontology/index.js';

/**
 * application/change-plan/classify: the authority-widening classifier (S11 plan §5.4, I-A4) — for
 * ontology definitions (P1-A), Skills and `worker` WorkerDefinitions (P1-D). A
 * **whitelist**: every field of an item is compared, before against after, and a change passes as
 * `not_widening` only where a rule below proves it cannot widen authority — let an action run with
 * less review, send a credential somewhere new, or put new text into a model's prompt (a tool
 * result an agent asked for, such as `get_type`, is not that). Anything else is
 * `authority_widening`, including a field no rule knows (`unrecognized`), so a field added to a
 * schema later is widening until someone writes its rule. Nothing here trusts how a proposer
 * labelled its own change.
 *
 * Each widening change is reported with where it is and why (`WideningReason`); an item is
 * `authority_widening` exactly when it has at least one. The person applying the segment confirms
 * those items one by one (`ChangeConfirmationRequiredError`), and the reasons are what they read.
 */

/** The reason codes (`@nexttime/shared` `CHANGE_WIDENING_REASON_VALUES`, where each is described:
 *  they reach the console on the wire). */
export const WIDENING_REASON_VALUES = CHANGE_WIDENING_REASON_VALUES;
export type WideningReasonCode = ChangeWideningReasonCode;

export interface WideningReason {
  /** Where in the item, e.g. `actionTypes[restart].mode`. */
  readonly path: string;
  readonly reason: WideningReasonCode;
}

export function classificationOf(widening: readonly WideningReason[]): ChangeItemClassification {
  return widening.length === 0 ? 'not_widening' : 'authority_widening';
}

// -------------------------------------------------------------------------------------------
// Field rules
// -------------------------------------------------------------------------------------------

/** One field's rule: the reason a before → after change of it widens authority, or `null` when it
 *  is proven not to. Called only for fields present on at least one side. */
type FieldRule = (before: unknown, after: unknown) => WideningReasonCode | null;

function sameValue(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** Proven not to widen authority whatever the change (see each use for why). */
const NOT_WIDENING: FieldRule = () => null;

/** Any change needs confirmation: the field governs review, and no direction of change is proven
 *  harmless. */
const ANY_CHANGE: FieldRule = (before, after) => (sameValue(before, after) ? null : 'changed');

/** A field with a strictness order: moving to a stricter (or equally strict) value is proven not
 *  to widen; a looser one is `loosened`; a value outside the order is `changed`. */
function strictness(rank: (value: unknown) => number | undefined): FieldRule {
  return (before, after) => {
    if (sameValue(before, after)) return null;
    const from = rank(before);
    const to = rank(after);
    if (from === undefined || to === undefined) return 'changed';
    return to < from ? 'loosened' : null;
  };
}

function rankOf(order: readonly unknown[]): (value: unknown) => number | undefined {
  return (value) => {
    const index = order.indexOf(value);
    return index === -1 ? undefined : index;
  };
}

/**
 * ActionType (`packages/shared` ontology-definition.ts): the platform's declaration of how a kind of
 * action is governed (§5.4 I8 "自动批准 = ActionType 声明 且 Workspace 规则开启";
 * `requesterCanApprove` is an ActionType field as well as a workspace policy field). Typed as a
 * `Record` over the schema's own keys, so a new ActionType field does not compile without a rule;
 * `classify.test.ts` also compares these keys with the Zod shape.
 */
export const ACTION_TYPE_FIELD_RULES: Readonly<Record<keyof ActionTypeDefinition, FieldRule>> = {
  // The key entries are matched on: a matched pair never differs in it.
  name: NOT_WIDENING,
  // Prose an agent reads through `get_type` / `list_types`; it grants nothing and is not a prompt.
  description: NOT_WIDENING,
  // `execute` needs review that `observe` skips (manifest.ts `MODE_STRICTNESS`).
  mode: strictness(rankOf(['observe', 'execute'])),
  blastRadius: strictness(rankOf(['low', 'medium', 'high'])),
  // Absent means not declared auto-approvable, as strict as `false`.
  autoApprovable: strictness((value) =>
    value === true ? 0 : value === false || value === undefined ? 1 : undefined,
  ),
  // Absent means the default by blast radius, which may let the requester approve: looser than
  // `false`, and not proven stricter than `true`.
  requesterCanApprove: strictness((value) =>
    value === true ? 0 : value === undefined ? 1 : value === false ? 2 : undefined,
  ),
  // Neither has a direction proven harmless (§5.4 lists both among the changes to confirm).
  reversibility: ANY_CHANGE,
  awaitDecision: ANY_CHANGE,
};

/** ObjectType / LinkType constrain the shape of what is written to the graph (I2,
 *  `substrate/graph/ontology-guard.ts`); no authorization, approval or credential route reads them,
 *  so none of their changes — a type added, removed or redescribed, an identity key changed — can
 *  widen authority. */
export const OBJECT_TYPE_FIELD_RULES: Readonly<Record<keyof ObjectTypeDefinition, FieldRule>> = {
  name: NOT_WIDENING,
  description: NOT_WIDENING,
  identityKey: NOT_WIDENING,
};

export const LINK_TYPE_FIELD_RULES: Readonly<Record<keyof LinkTypeDefinition, FieldRule>> = {
  name: NOT_WIDENING,
  domain: NOT_WIDENING,
  range: NOT_WIDENING,
  description: NOT_WIDENING,
};

// -------------------------------------------------------------------------------------------
// Ontology definitions
// -------------------------------------------------------------------------------------------

interface SectionRules<T> {
  readonly name: string;
  /** What identifies an entry across versions; LinkType names repeat with other endpoints. */
  readonly keyOf: (entry: T) => string;
  readonly fields: Readonly<Record<string, FieldRule>>;
  /** The reason a new / dropped entry widens authority, `null` when it cannot. */
  readonly added: WideningReasonCode | null;
  readonly removed: WideningReasonCode | null;
}

const OBJECT_TYPES: SectionRules<ObjectTypeDefinition> = {
  name: 'objectTypes',
  keyOf: (entry) => entry.name,
  fields: OBJECT_TYPE_FIELD_RULES,
  added: null,
  removed: null,
};

const LINK_TYPES: SectionRules<LinkTypeDefinition> = {
  name: 'linkTypes',
  keyOf: (entry) => `${entry.name}:${entry.domain}->${entry.range}`,
  fields: LINK_TYPE_FIELD_RULES,
  added: null,
  removed: null,
};

const ACTION_TYPES: SectionRules<ActionTypeDefinition> = {
  name: 'actionTypes',
  keyOf: (entry) => entry.name,
  fields: ACTION_TYPE_FIELD_RULES,
  // A new ActionType is a new approval boundary in itself (§5.4: a new execute Operation's
  // classification is confirmed for the same reason).
  added: 'added',
  removed: 'removed',
};

/** The sections an `OntologyDefinition` has; any other top-level key is `unrecognized`. */
export const ONTOLOGY_SECTION_NAMES = ['objectTypes', 'linkTypes', 'actionTypes'] as const;

function compareEntry(
  path: string,
  before: object,
  after: object,
  fields: Readonly<Record<string, FieldRule>>,
  out: WideningReason[],
): void {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  for (const key of keys) {
    if (b[key] === undefined && a[key] === undefined) continue;
    const rule = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const reason = rule ? rule(b[key], a[key]) : 'unrecognized';
    if (reason) out.push({ path: `${path}.${key}`, reason });
  }
}

function compareSection<T extends object>(
  section: SectionRules<T>,
  before: readonly T[],
  after: readonly T[],
  out: WideningReason[],
): void {
  const group = (entries: readonly T[]) => {
    const byKey = new Map<string, T[]>();
    for (const entry of entries) {
      const key = section.keyOf(entry);
      byKey.set(key, [...(byKey.get(key) ?? []), entry]);
    }
    return byKey;
  };
  const beforeByKey = group(before);
  const afterByKey = group(after);
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  for (const key of keys) {
    const path = `${section.name}[${key}]`;
    const from = beforeByKey.get(key) ?? [];
    const to = afterByKey.get(key) ?? [];
    // Two entries under one key leave it unclear which one governs: not proven, so widening.
    if (from.length > 1 || to.length > 1) {
      out.push({ path, reason: 'changed' });
      continue;
    }
    const [b] = from;
    const [a] = to;
    if (b === undefined && a !== undefined) {
      if (section.added) out.push({ path, reason: section.added });
      // Its fields are new too: an entry with a field no rule knows is not proven harmless.
      else compareEntry(path, {}, a, section.fields, out);
      continue;
    }
    if (b !== undefined && a === undefined) {
      if (section.removed) out.push({ path, reason: section.removed });
      continue;
    }
    if (b !== undefined && a !== undefined) compareEntry(path, b, a, section.fields, out);
  }
}

/**
 * The widening changes from `before` to `after`, in a stable order (by section, then key, then
 * field); `null` on either side is the family not installed — `before` for a first install,
 * `after` for a rollback that takes the family out (P1-B: every declaration of `before` is then
 * removed). Empty means the change is proven not to widen authority.
 */
export function classifyOntologyDefinitionChange(
  before: OntologyDefinition | null,
  after: OntologyDefinition | null,
): WideningReason[] {
  const out: WideningReason[] = [];
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const known = new Set<string>(ONTOLOGY_SECTION_NAMES);
  const unknownKeys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((key) => !known.has(key) && (b[key] !== undefined || a[key] !== undefined))
    .sort();
  for (const key of unknownKeys) out.push({ path: key, reason: 'unrecognized' });

  compareSection(OBJECT_TYPES, before?.objectTypes ?? [], after?.objectTypes ?? [], out);
  compareSection(LINK_TYPES, before?.linkTypes ?? [], after?.linkTypes ?? [], out);
  compareSection(ACTION_TYPES, before?.actionTypes ?? [], after?.actionTypes ?? [], out);
  return out;
}

// -------------------------------------------------------------------------------------------
// Skills and WorkerDefinitions (S11 P1-D)
// -------------------------------------------------------------------------------------------

/** A list of strings, or `undefined` for anything else; `undefined` itself reads as `absent`. */
function stringList(
  value: unknown,
  absent: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return absent;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

/**
 * A list whose entries each reach further (`widensWhen: 'grows'` — an entry added widens) or hold
 * something back (`'shrinks'` — an entry dropped widens). Order does not count. `absentIsEmpty`:
 * the field left out means no entries; otherwise leaving it out means a default defined elsewhere,
 * and a change between that and a list is `changed` (not proven either way).
 */
function listRule(widensWhen: 'grows' | 'shrinks', absentIsEmpty: boolean): FieldRule {
  return (before, after) => {
    if (sameValue(before, after)) return null;
    if (!absentIsEmpty && (before === undefined) !== (after === undefined)) return 'changed';
    const b = stringList(before, absentIsEmpty ? [] : undefined);
    const a = stringList(after, absentIsEmpty ? [] : undefined);
    if (b === undefined || a === undefined) return 'changed';
    const [wider, narrower] = widensWhen === 'grows' ? [a, b] : [b, a];
    return wider.every((entry) => narrower.includes(entry)) ? null : 'loosened';
  };
}

/**
 * A Skill version (`application/worker/skills.ts`; `@nexttime/shared` skill.ts). What a Worker
 * that mounts it reads is prompt text — pi lists each mounted Skill's name and description and
 * loads its body — so a change to any of the three needs confirmation. Typed over the schema's own
 * keys, so a new Skill field does not compile without a rule.
 */
export const SKILL_FIELD_RULES: Readonly<Record<keyof ProposeSkillContent, FieldRule>> = {
  // Workers mount Skills by name: another name is another Skill to them.
  name: ANY_CHANGE,
  description: ANY_CHANGE,
  markdown: ANY_CHANGE,
  // Metadata `list_skills` / `find_procedures` filter on; mounting never reads it.
  applicable: NOT_WIDENING,
};

/**
 * A `worker` WorkerDefinition version (`@nexttime/shared` worker-definition.ts): what a Worker of
 * it is told (`systemPrompt`, its Skills), which model runs it, and what it may do —
 * `capabilities`, `gates`, and the egress it is denied. Typed over the schema's own keys.
 */
export const WORKER_DEFINITION_FIELD_RULES: Readonly<
  Record<keyof WorkerWorkerDefinitionContent, FieldRule>
> = {
  systemPrompt: ANY_CHANGE,
  // Which model runs it: no direction proven harmless.
  model: ANY_CHANGE,
  // `find_workers` ranking text an agent reads through a tool result; grants nothing.
  name: NOT_WIDENING,
  description: NOT_WIDENING,
  // Each Skill mounted is more text in its prompt.
  skills: listRule('grows', true),
  // Left out means the platform's default (the worker ceiling without execute-class names), which
  // changes with the platform: between that and a list is not proven either way.
  capabilities: listRule('grows', false),
  gates: listRule('grows', true),
  // A host taken off the deny list is egress allowed again.
  egressDeny: listRule('shrinks', true),
};

/** One version's content against another, as `compareEntry` does for a type, under `path`. An item
 *  that did not exist (`before` null) is `added` as a whole — a new prompt, or a new agent anyone
 *  allowed to delegate may invoke; taking one out (`after` null) narrows: no Worker mounts the
 *  Skill, nobody can invoke the WorkerDefinition. */
function classifyVersionedContent(
  path: string,
  fields: Readonly<Record<string, FieldRule>>,
  before: object | null,
  after: object | null,
): WideningReason[] {
  if (after === null) return [];
  if (before === null) return [{ path, reason: 'added' }];
  const out: WideningReason[] = [];
  compareEntry(path, before, after, fields, out);
  return out;
}

/** The widening changes from one Skill version's content to another (`null`: not installed). */
export function classifySkillChange(
  before: ProposeSkillContent | null,
  after: ProposeSkillContent | null,
): WideningReason[] {
  return classifyVersionedContent('skill', SKILL_FIELD_RULES, before, after);
}

/** The widening changes from one `worker` WorkerDefinition version's content to another (`null`:
 *  not installed). */
export function classifyWorkerDefinitionChange(
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): WideningReason[] {
  return classifyVersionedContent('worker', WORKER_DEFINITION_FIELD_RULES, before, after);
}
