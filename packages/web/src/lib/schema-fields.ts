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

/** The list for `schema`, or `null` when the list cannot say it exactly. */
function rowsOf(schema: unknown): SchemaDraft | null {
  if (!isRecord(schema) || schema.type !== 'object') return null;
  if (Object.keys(schema).some((key) => !ROOT_KEYS.has(key))) return null;
  const { properties, required, additionalProperties, description } = schema;
  if (properties !== undefined && !isRecord(properties)) return null;
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') return null;
  if (description !== undefined && typeof description !== 'string') return null;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      required.some((name) => typeof name !== 'string' || !Object.hasOwn(properties ?? {}, name)) ||
      new Set(required).size !== required.length)
  ) {
    return null;
  }
  const requiredNames = new Set((required as string[] | undefined) ?? []);
  const rows: SchemaFieldRow[] = [];
  for (const [name, node] of Object.entries(properties ?? {})) {
    if (!isRecord(node) || Object.keys(node).some((key) => !FIELD_KEYS.has(key))) return null;
    const kind = node.type === undefined ? '' : node.type;
    if (typeof kind !== 'string' || !SCHEMA_FIELD_KINDS.includes(kind as SchemaFieldKind)) {
      return null;
    }
    if (node.description !== undefined && typeof node.description !== 'string') return null;
    rows.push({
      ...newSchemaRow(),
      name,
      kind: kind as SchemaFieldKind,
      required: requiredNames.has(name),
      description: node.description ?? '',
    });
  }
  return {
    mode: 'fields',
    rows,
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    ...(description !== undefined ? { description } : {}),
    hadProperties: properties !== undefined,
    hadRequired: required !== undefined,
  };
}

/** The draft for a schema as it came: its list, or its JSON when the list cannot say it. */
export function schemaDraftFrom(schema: unknown): SchemaDraft {
  return rowsOf(schema) ?? { mode: 'json', text: JSON.stringify(schema, null, 2) };
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
  return schema.ok ? rowsOf(schema.value) : null;
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
