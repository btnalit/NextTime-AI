import { z } from 'zod';

/** A JSON Schema document as plain JSON-shaped data. */
export type JsonSchemaNode = Record<string, unknown>;

/**
 * The one Zod → JSON Schema conversion every consumer uses: the kernel's MCP tool catalog, the
 * platform extension's pi tool parameters, the wire-contract snapshot (`pnpm contract:check`) and
 * the vocabulary / prompt-contract guards. One definition, so what a model is shown, what the
 * snapshot records and what the guards check never disagree.
 *
 * Shape:
 *  - draft-07, no `$schema` key (pi and MCP clients take the object as is);
 *  - the input side of the schema (`io: 'input'`): what a caller may send — a field with a
 *    `.default()` is optional;
 *  - fully inline: no `$defs` / `$ref`. A schema that contains itself (a predicate's `all` / `any` /
 *    `not`, an output schema's `properties` / `items` — `z.lazy` in this package) is written out
 *    once along each path and becomes `{}` (any value) where it recurs; the caller still checks the
 *    whole value against the Zod schema, so `{}` only loosens the hint, never the check;
 *  - anything with no JSON Schema form (a `z.custom`, a transform's output) is `{}` rather than an
 *    error;
 *  - the same document the zod 3 converter (`zod-to-json-schema`) wrote, so the move to zod 4 does
 *    not change what models are shown: an object that drops unknown keys says
 *    `additionalProperties: false` as a `.strict()` one does, a union is `anyOf`, and the bounds,
 *    patterns and key schemas zod 4 adds on its own (an `.int()`'s safe-integer range, the regex
 *    behind a `format`, a record's `propertyNames`) are left out.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const document = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
    override: ({ zodSchema, jsonSchema }) => {
      const def = (zodSchema as unknown as { _zod: { def: ZodDef } })._zod.def;
      if (def.type === 'object' && def.catchall === undefined) {
        jsonSchema.additionalProperties = false;
      }
      // `a.pipe(b)`: what a caller may send must pass both, so both are shown (zod 3's converter
      // did the same); a `.transform()`'s output has no schema to show.
      if (def.type === 'pipe' && def.out !== undefined && def.out._zod.def.type !== 'transform') {
        const input = { ...jsonSchema };
        for (const key of Object.keys(jsonSchema)) Reflect.deleteProperty(jsonSchema, key);
        jsonSchema.allOf = [input, toJsonSchema(def.out as unknown as z.ZodType)];
      }
    },
  }) as JsonSchemaNode;
  const { $schema: _draft, definitions, $defs, ...root } = document;
  const named = (definitions ?? $defs ?? {}) as Record<string, JsonSchemaNode>;
  return normalize(inlineRefs(root, named, ['#'])) as JsonSchemaNode;
}

interface ZodDef {
  readonly type: string;
  readonly catchall?: unknown;
  readonly out?: { readonly _zod: { readonly def: { readonly type: string } } };
}

/** Writes what zod 4 emits the way the zod 3 converter did (module comment). */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== 'object') return node;
  const source = node as JsonSchemaNode;
  let out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === 'pattern' && typeof source.format === 'string') continue;
    if (key === 'propertyNames' && isObjectNode(value)) {
      const { type, ...keyRules } = value;
      const rules = type === undefined || type === 'string' ? keyRules : { ...keyRules, type };
      if (Object.keys(rules).length > 0) out.propertyNames = normalize(rules);
      continue;
    }
    out[key === 'oneOf' ? 'anyOf' : key] = normalize(value);
  }
  // A reference with a description or another sibling comes out as `allOf: [<it>]`.
  if (Array.isArray(out.allOf) && out.allOf.length === 1 && isObjectNode(out.allOf[0])) {
    const [only] = out.allOf as JsonSchemaNode[];
    const { allOf: _allOf, ...rest } = out;
    if (only !== undefined && Object.keys(only).every((key) => !(key in rest))) {
      out = { ...only, ...rest };
    }
  }
  // A union of literals / enums of one type is one `enum`.
  if (Array.isArray(out.anyOf) && out.anyOf.length > 1) {
    const branches = out.anyOf as unknown[];
    const values: unknown[] = [];
    let type: unknown;
    const flat = branches.every((branch) => {
      if (!isObjectNode(branch)) return false;
      const keys = Object.keys(branch).filter((key) => key !== 'type');
      if (keys.length !== 1 || (keys[0] !== 'enum' && keys[0] !== 'const')) return false;
      if (type !== undefined && branch.type !== type) return false;
      type = branch.type;
      for (const value of keys[0] === 'enum' ? (branch.enum as unknown[]) : [branch.const]) {
        if (!values.includes(value)) values.push(value);
      }
      return true;
    });
    if (flat) {
      const { anyOf: _anyOf, ...rest } = out;
      out = { ...rest, ...(type === undefined ? {} : { type }), enum: values };
    }
  }
  return out;
}

function isObjectNode(value: unknown): value is JsonSchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const LOCAL_REF = /^#(?:\/(?:definitions|\$defs)\/(.+))?$/;

function inlineRefs(
  node: unknown,
  definitions: Record<string, JsonSchemaNode>,
  open: readonly string[],
  root?: JsonSchemaNode,
): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, definitions, open, root));
  if (node === null || typeof node !== 'object') return node;
  const self = node as JsonSchemaNode;
  const top = root ?? self;
  if (typeof self.$ref === 'string') {
    const match = LOCAL_REF.exec(self.$ref);
    if (match) {
      const name = match[1] === undefined ? '#' : decodeURIComponent(match[1]);
      if (open.includes(name)) return {};
      const target = name === '#' ? top : definitions[name];
      if (target === undefined) return {};
      const { $ref: _ref, ...siblings } = self;
      const resolved = inlineRefs(target, definitions, [...open, name], top) as JsonSchemaNode;
      return Object.keys(siblings).length === 0
        ? resolved
        : { ...resolved, ...(inlineRefs(siblings, definitions, open, top) as JsonSchemaNode) };
    }
  }
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(self)) {
    out[key] = inlineRefs(value, definitions, open, top);
  }
  return out;
}
