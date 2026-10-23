import type { OutputSchemaType } from '@nexttime/shared';
import type { Translate } from './i18n.js';

/**
 * lib/schema-fields (legacy 453): a step's output contract or a Procedure's parameters
 * (`@nexttime/shared` `output-schema.ts`, an object schema) as the Procedure editor edits it — a
 * list of fields (name, kind, required, description) when the schema is one the list can say
 * exactly, else the schema as JSON. The list is what nearly every contract is: an object of named
 * fields, each of one kind. A schema that says more (a nested field's own fields, bounds, `enum`)
 * stays JSON, so nothing the list cannot show is dropped by editing it.
 *
 * Round trip: a schema read into the list and not touched comes back with the same meaning —
 * `required` in field order, a `description` or `additionalProperties` of the root kept as it came.
 */

/** A field's kind as the list offers it; `''`: any JSON value (no `type`). */
export type SchemaFieldKind = OutputSchemaType | '';

export const SCHEMA_FIELD_KINDS: readonly SchemaFieldKind[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
  '',
];

const KIND_LABEL: Readonly<Record<SchemaFieldKind, readonly [string, string]>> = {
  string: ['文本', 'Text'],
  number: ['数字', 'Number'],
  integer: ['整数', 'Integer'],
  boolean: ['是 / 否', 'Yes / no'],
  object: ['对象', 'Object'],
  array: ['列表', 'List'],
  null: ['空值', 'Null'],
  '': ['任意', 'Any'],
};

export function schemaFieldKindLabel(kind: SchemaFieldKind, t: Translate): string {
  const [zh, en] = KIND_LABEL[kind];
  return t(zh, en);
}

export interface SchemaFieldRow {
  /** React key; never sent. */
  readonly uid: string;
  readonly name: string;
  readonly kind: SchemaFieldKind;
  readonly required: boolean;
  readonly description: string;
}

export type SchemaDraft =
  | {
      readonly mode: 'fields';
      readonly rows: readonly SchemaFieldRow[];
      /** The root's `additionalProperties` as it came (`false`: only the listed fields). */
      readonly additionalProperties?: boolean;
      /** The root's `description`, kept as it came (the list does not edit it). */
      readonly description?: string;
      /** Whether the schema came with `properties` / `required` — kept even when empty. */
      readonly hadProperties: boolean;
      readonly hadRequired: boolean;
    }
  | { readonly mode: 'json'; readonly text: string };

let rowCounter = 0;
export function newSchemaRow(): SchemaFieldRow {
  rowCounter += 1;
  return { uid: `field-${rowCounter}`, name: '', kind: 'string', required: false, description: '' };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ROOT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
]);
const FIELD_KEYS: ReadonlySet<string> = new Set(['type', 'description']);

/** Why the field list cannot say a schema — the first place it stops at (UX P3-4 on #738). */
export type SchemaListBlocker =
  | { readonly kind: 'not_json' }
  | { readonly kind: 'root_not_object' }
  | { readonly kind: 'root_keys'; readonly keys: readonly string[] }
  | { readonly kind: 'required'; readonly name: string }
  | { readonly kind: 'field_keys'; readonly field: string; readonly keys: readonly string[] }
  | { readonly kind: 'field_type'; readonly field: string };

/** The list for `schema`, or where the list cannot say it exactly. */
function rowsOf(schema: unknown): SchemaDraft | SchemaListBlocker {
  if (!isRecord(schema) || schema.type !== 'object') return { kind: 'root_not_object' };
  const extra = Object.keys(schema).filter((key) => !ROOT_KEYS.has(key));
  const { properties, required, additionalProperties, description } = schema;
  if (properties !== undefined && !isRecord(properties)) extra.push('properties');
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') {
    extra.push('additionalProperties');
  }
  if (description !== undefined && typeof description !== 'string') extra.push('description');
  if (required !== undefined && !Array.isArray(required)) extra.push('required');
  if (extra.length > 0) return { kind: 'root_keys', keys: extra };
  const declared = (properties ?? {}) as Record<string, unknown>;
  const requiredList = (required ?? []) as unknown[];
  for (const [index, name] of requiredList.entries()) {
    if (
      typeof name !== 'string' ||
      !Object.hasOwn(declared, name) ||
      requiredList.indexOf(name) !== index
    ) {
      return { kind: 'required', name: String(name) };
    }
  }
  const requiredNames = new Set(requiredList as string[]);
  const rows: SchemaFieldRow[] = [];
  for (const [name, node] of Object.entries(declared)) {
    if (!isRecord(node)) return { kind: 'field_type', field: name };
    const keys = Object.keys(node).filter((key) => !FIELD_KEYS.has(key));
    if (node.description !== undefined && typeof node.description !== 'string') {
      keys.push('description');
    }
    if (keys.length > 0) return { kind: 'field_keys', field: name, keys };
    const kind = node.type === undefined ? '' : node.type;
    if (typeof kind !== 'string' || !SCHEMA_FIELD_KINDS.includes(kind as SchemaFieldKind)) {
      return { kind: 'field_type', field: name };
    }
    rows.push({
      ...newSchemaRow(),
      name,
      kind: kind as SchemaFieldKind,
      required: requiredNames.has(name),
      description: (node.description as string | undefined) ?? '',
    });
  }
  return {
    mode: 'fields',
    rows,
    ...(typeof additionalProperties === 'boolean' ? { additionalProperties } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    hadProperties: properties !== undefined,
    hadRequired: required !== undefined,
  };
}

const isDraft = (value: SchemaDraft | SchemaListBlocker): value is SchemaDraft => 'mode' in value;

/** Where a JSON draft keeps the list from saying it — `null` when the list can (or the draft is
 *  a list already). */
export function schemaListBlocker(draft: SchemaDraft): SchemaListBlocker | null {
  if (draft.mode === 'fields') return null;
  const schema = schemaFromDraft(draft);
  if (!schema.ok) return { kind: 'not_json' };
  const read = rowsOf(schema.value);
  return isDraft(read) ? null : read;
}

/** The blocker as a sentence: which field, and what of it the list cannot say. */
export function schemaListBlockerText(blocker: SchemaListBlocker, t: Translate): string {
  const keys = (list: readonly string[]) => list.join(t('、', ', '));
  switch (blocker.kind) {
    case 'not_json':
      return t('还不是合法的 JSON。', 'It is not valid JSON yet.');
    case 'root_not_object':
      return t(
        '它的根不是对象（type 不是 object），字段列表只编辑对象的字段。',
        'Its root is not an object (type is not object); the field list edits an object’s fields.',
      );
    case 'root_keys':
      return t(
        `它的根上写了 ${keys(blocker.keys)}，字段列表说不出。`,
        `Its root says ${keys(blocker.keys)}, which the field list cannot.`,
      );
    case 'required':
      return t(
        `必填里的 ${blocker.name} 没有声明成字段，或者写了两次。`,
        `${blocker.name} is required but not declared as a field, or listed twice.`,
      );
    case 'field_keys':
      return t(
        `字段 ${blocker.field} 写了 ${keys(blocker.keys)}，字段列表说不出。`,
        `Field ${blocker.field} says ${keys(blocker.keys)}, which the field list cannot.`,
      );
    case 'field_type':
      return t(
        `字段 ${blocker.field} 的类型不止一种，或不是字段列表里的类型。`,
        `Field ${blocker.field} has more than one kind, or one the field list does not offer.`,
      );
  }
}

/** The draft for a schema as it came: its list, or its JSON when the list cannot say it. */
export function schemaDraftFrom(schema: unknown): SchemaDraft {
  const read = rowsOf(schema);
  return isDraft(read) ? read : { mode: 'json', text: JSON.stringify(schema, null, 2) };
}

/** A new, empty contract: an object with no fields yet. */
export function emptySchemaDraft(): SchemaDraft {
  return { mode: 'fields', rows: [], hadProperties: false, hadRequired: false };
}

export type SchemaFromDraft =
  | { readonly ok: true; readonly value: unknown }
  /** The JSON does not parse — `text` stands in for it (the JSON view shows it as typed). */
  | { readonly ok: false; readonly text: string };

/** The schema the draft says. */
export function schemaFromDraft(draft: SchemaDraft): SchemaFromDraft {
  if (draft.mode === 'json') {
    try {
      return { ok: true, value: JSON.parse(draft.text) };
    } catch {
      return { ok: false, text: draft.text };
    }
  }
  const properties: Record<string, unknown> = {};
  for (const row of draft.rows) {
    const description = row.description.trim();
    properties[row.name.trim()] = {
      ...(row.kind !== '' ? { type: row.kind } : {}),
      ...(description !== '' ? { description } : {}),
    };
  }
  const required = draft.rows.filter((row) => row.required).map((row) => row.name.trim());
  return {
    ok: true,
    value: {
      type: 'object',
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      ...(draft.rows.length > 0 || draft.hadProperties ? { properties } : {}),
      ...(required.length > 0 || draft.hadRequired ? { required } : {}),
      ...(draft.additionalProperties !== undefined
        ? { additionalProperties: draft.additionalProperties }
        : {}),
    },
  };
}

/** The draft as JSON — what「用 JSON 编辑」starts from. */
export function schemaDraftAsJson(draft: SchemaDraft): SchemaDraft {
  if (draft.mode === 'json') return draft;
  const schema = schemaFromDraft(draft);
  return { mode: 'json', text: JSON.stringify(schema.ok ? schema.value : {}, null, 2) };
}

/** The JSON draft as a list, or `null` when it does not parse or the list cannot say it. */
export function schemaDraftAsFields(draft: SchemaDraft): SchemaDraft | null {
  if (draft.mode === 'fields') return draft;
  const schema = schemaFromDraft(draft);
  if (!schema.ok) return null;
  const read = rowsOf(schema.value);
  return isDraft(read) ? read : null;
}

/** What is wrong with the list's rows, by row index: no name, or a name used twice. */
export function schemaRowProblems(draft: SchemaDraft, t: Translate): ReadonlyMap<number, string> {
  const problems = new Map<number, string>();
  if (draft.mode !== 'fields') return problems;
  const seen = new Set<string>();
  for (const [index, row] of draft.rows.entries()) {
    const name = row.name.trim();
    if (name === '') problems.set(index, t('字段要有名字', 'The field needs a name'));
    else if (seen.has(name)) {
      problems.set(index, t(`字段名 ${name} 重复了`, `The name ${name} is used twice`));
    }
    seen.add(name);
  }
  return problems;
}

/** The top-level field names a draft declares (for a binding's path to choose from). */
export function schemaFieldNames(draft: SchemaDraft | null): readonly string[] {
  if (draft === null) return [];
  if (draft.mode === 'fields') {
    return draft.rows.map((row) => row.name.trim()).filter((name) => name !== '');
  }
  const schema = schemaFromDraft(draft);
  if (!schema.ok || !isRecord(schema.value) || !isRecord(schema.value.properties)) return [];
  return Object.keys(schema.value.properties);
}
