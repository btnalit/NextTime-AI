import { z } from 'zod';

/**
 * output-schema (S11 GO5d-1; plan §4.5): the structured result a goal step's Worker reports
 * (`report_result`'s `output`) and the schema the step's plan entry holds it to (`outputSchema`).
 * A JSON Schema subset with its own validator here, shared by the kernel (which refuses an output
 * that does not match, `report_task_result`), the console and the Worker extension (which show
 * where it failed) — one meaning of "matches", one way of naming the place.
 *
 * **Why a subset and this validator, not a JSON Schema library.** A step's schema is written by an
 * agent (the entry agent proposes plans), and a library like ajv compiles a schema to code and
 * runs `pattern` regexes the author chose (a ReDoS in the kernel's event loop). The subset is what
 * a step needs to hand data to the next one: `type` (one, or several), `properties` / `required` /
 * `additionalProperties` (a boolean), `items`, `enum` / `const`, length, size and range bounds,
 * and `description`. Nothing else is accepted — a keyword the validator does not act on must not
 * look like it is in force (`$ref`, `pattern`, `format`, `oneOf` are refused, not ignored) — and a
 * keyword that acts only on one type (`properties` on objects, `items` on arrays, `minLength` on
 * strings, `minimum` on numbers) needs that type declared on its node.
 *
 * **Bounds.** A schema: {@link OUTPUT_SCHEMA_MAX_DEPTH} levels (measured before its nodes are
 * parsed, so a deeply nested document costs no recursion), {@link OUTPUT_SCHEMA_MAX_NODES} nodes,
 * {@link OUTPUT_SCHEMA_MAX_BYTES} serialized. An output: {@link OUTPUT_MAX_CHARS} characters of JSON
 * (the contract's own bound, `worker-result.ts`); one validation walks it only along its schema, so
 * no deeper than the schema, visits at most {@link OUTPUT_VALIDATION_MAX_NODES} values and reports at
 * most {@link MAX_OUTPUT_PROBLEMS} problems (the count stays exact).
 *
 * **The root is an object.** A step's output is a JSON object and its schema's root is
 * `type: 'object'` — what a binding reads a field of (`goal-plan.ts` `bindings`), and what the
 * console lists field by field.
 *
 * **Problems name places, never values.** A problem is `{path, message}`: `path` from `output`,
 * dot-separated, array items by 0-based index (`output.hosts.0.name`), a key that is not a plain
 * name in brackets (`output["a b"]`); `message` says what the schema asked for and what kind of
 * value was there (`expected string, got number`) — the value itself is never quoted, so a
 * problem can be shown and recorded wherever the output is not. A schema's own literals (`enum`,
 * `const`) are the plan's, which a person confirmed, and may be quoted.
 */

export const OUTPUT_SCHEMA_TYPE_VALUES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const;
export type OutputSchemaType = (typeof OUTPUT_SCHEMA_TYPE_VALUES)[number];

/** Levels of nesting a step's output schema has at most (the root is level 1). */
export const OUTPUT_SCHEMA_MAX_DEPTH = 8;
/** Schema nodes (the root, each property, each `items`) a step's output schema has at most. */
export const OUTPUT_SCHEMA_MAX_NODES = 200;
/** A step's output schema, serialized. */
export const OUTPUT_SCHEMA_MAX_BYTES = 16 * 1024;
/** Properties one object node declares at most. */
export const OUTPUT_SCHEMA_MAX_PROPERTIES = 64;
/** Values one `enum` lists at most. */
export const OUTPUT_SCHEMA_MAX_ENUM = 64;
/** The longest `description` of a schema node. */
export const OUTPUT_SCHEMA_MAX_DESCRIPTION_CHARS = 500;
/** The longest property name. */
export const OUTPUT_SCHEMA_MAX_PROPERTY_NAME_CHARS = 128;
/** An output, as JSON text — the size of one inlined artifact (`ARTIFACT_CONTENT_MAX_CHARS`). */
export const OUTPUT_MAX_CHARS = 32_000;
/** Values one validation visits at most; past it the output is refused as too large to check. */
export const OUTPUT_VALIDATION_MAX_NODES = 10_000;
/** Problems one validation reports at most — `problemCount` stays exact. */
export const MAX_OUTPUT_PROBLEMS = 20;

/** A JSON value as `JSON.parse` yields it. */
export type OutputJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly OutputJsonValue[]
  | { readonly [key: string]: OutputJsonValue };

/** One node of a step's output schema — see the module comment. */
export interface OutputSchema {
  readonly type?: OutputSchemaType | readonly OutputSchemaType[];
  readonly description?: string;
  readonly properties?: { readonly [name: string]: OutputSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: OutputSchema;
  readonly enum?: readonly OutputJsonValue[];
  readonly const?: OutputJsonValue;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** Whether `value` is plain JSON: no `undefined`, functions, non-finite numbers or class
 *  instances. */
export function isOutputJsonValue(value: unknown): value is OutputJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isOutputJsonValue);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(isOutputJsonValue);
  }
  return false;
}

const JsonLiteralSchema = z.custom<OutputJsonValue>(
  (value) => value !== undefined && isOutputJsonValue(value),
  { message: 'must be a JSON value' },
);

const TypeSchema = z.enum(OUTPUT_SCHEMA_TYPE_VALUES);
const BoundSchema = z.number().int().nonnegative();

const OutputSchemaNodeSchema: z.ZodType<OutputSchema> = z.lazy(() =>
  z
    .object({
      type: z.union([TypeSchema, z.array(TypeSchema).min(1).max(OUTPUT_SCHEMA_TYPE_VALUES.length)]),
      description: z.string().max(OUTPUT_SCHEMA_MAX_DESCRIPTION_CHARS),
      properties: z
        .record(
          z.string().min(1).max(OUTPUT_SCHEMA_MAX_PROPERTY_NAME_CHARS),
          OutputSchemaNodeSchema,
        )
        .refine((properties) => Object.keys(properties).length <= OUTPUT_SCHEMA_MAX_PROPERTIES, {
          message: `declares more than ${OUTPUT_SCHEMA_MAX_PROPERTIES} properties`,
        }),
      required: z.array(z.string()).max(OUTPUT_SCHEMA_MAX_PROPERTIES),
      additionalProperties: z.boolean(),
      items: OutputSchemaNodeSchema,
      enum: z.array(JsonLiteralSchema).min(1).max(OUTPUT_SCHEMA_MAX_ENUM),
      const: JsonLiteralSchema,
      minLength: BoundSchema,
      maxLength: BoundSchema,
      minimum: z.number().finite(),
      maximum: z.number().finite(),
      minItems: BoundSchema,
      maxItems: BoundSchema,
    })
    .partial()
    .strict()
    .superRefine((node, ctx) => {
      for (const problem of nodeProblems(node)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message, path: problem.at });
      }
    }),
);

/** The type keywords of `node` — empty when it declares none (any JSON value). */
function typesOf(node: OutputSchema): readonly OutputSchemaType[] {
  if (node.type === undefined) return [];
  return typeof node.type === 'string' ? [node.type] : node.type;
}

/** Keywords that act on values of one kind, and the types that kind is. */
const KEYWORD_TYPES: readonly (readonly [keyof OutputSchema, readonly OutputSchemaType[]])[] = [
  ['properties', ['object']],
  ['required', ['object']],
  ['additionalProperties', ['object']],
  ['items', ['array']],
  ['minItems', ['array']],
  ['maxItems', ['array']],
  ['minLength', ['string']],
  ['maxLength', ['string']],
  ['minimum', ['number', 'integer']],
  ['maximum', ['number', 'integer']],
];

/** A node's own problems beyond its shape — its children are checked as nodes of their own. */
function nodeProblems(
  node: OutputSchema,
): readonly { readonly at: (string | number)[]; readonly message: string }[] {
  const problems: { at: (string | number)[]; message: string }[] = [];
  const types = typesOf(node);
  if (types.length !== new Set(types).size) {
    problems.push({ at: ['type'], message: 'lists a type more than once' });
  }
  for (const [keyword, kinds] of KEYWORD_TYPES) {
    if (node[keyword] === undefined) continue;
    if (!types.some((type) => kinds.includes(type))) {
      problems.push({
        at: [keyword],
        message: `acts only on ${kinds.join(' or ')} values — declare that type on this node`,
      });
    }
  }
  for (const [index, name] of (node.required ?? []).entries()) {
    if (!node.properties || !Object.hasOwn(node.properties, name)) {
      problems.push({
        at: ['required', index],
        message: `names "${name}", which properties does not declare`,
      });
    } else if ((node.required ?? []).indexOf(name) !== index) {
      problems.push({ at: ['required', index], message: `names "${name}" more than once` });
    }
  }
  for (const [low, high] of [
    ['minLength', 'maxLength'],
    ['minimum', 'maximum'],
    ['minItems', 'maxItems'],
  ] as const) {
    const min = node[low];
    const max = node[high];
    if (min !== undefined && max !== undefined && min > max) {
      problems.push({ at: [low], message: `is greater than ${high}` });
    }
  }
  return problems;
}

interface SchemaMeasure {
  readonly depth: number;
  readonly nodes: number;
}

function measureSchema(node: OutputSchema): SchemaMeasure {
  let depth = 1;
  let nodes = 1;
  const children = [...Object.values(node.properties ?? {}), ...(node.items ? [node.items] : [])];
  for (const child of children) {
    const measured = measureSchema(child);
    depth = Math.max(depth, measured.depth + 1);
    nodes += measured.nodes;
  }
  return { depth, nodes };
}

/** How deep `value` nests (a scalar is 1), counted without recursion and given up past `limit`
 *  — so a document nested thousands of levels costs a loop, not the stack. */
function nestingDepth(value: unknown, limit: number): number {
  let deepest = 0;
  const pending: [unknown, number][] = [[value, 1]];
  while (pending.length > 0) {
    const [current, depth] = pending.pop() as [unknown, number];
    deepest = Math.max(deepest, depth);
    if (deepest > limit) return deepest;
    if (current !== null && typeof current === 'object') {
      for (const inner of Object.values(current)) pending.push([inner, depth + 1]);
    }
  }
  return deepest;
}

/** Each schema level is a node object holding `properties` (an object of nodes) or `items` — two
 *  or one JSON levels down to the next node. */
const MAX_SCHEMA_DOCUMENT_DEPTH = OUTPUT_SCHEMA_MAX_DEPTH * 2 + 4;

/** A step's output schema (`PlanStep.outputSchema`): an {@link OutputSchema} whose root is an
 *  object, within the bounds of the module comment. */
export const StepOutputSchemaSchema: z.ZodType<OutputSchema, unknown> = z
  .unknown()
  .superRefine((value, ctx) => {
    if (nestingDepth(value, MAX_SCHEMA_DOCUMENT_DEPTH) > MAX_SCHEMA_DOCUMENT_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `nests more than ${OUTPUT_SCHEMA_MAX_DEPTH} levels deep`,
        fatal: true,
      });
    }
  })
  .pipe(OutputSchemaNodeSchema)
  .superRefine((schema, ctx) => {
    if (schema.type !== 'object') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: "a step's output is an object: the schema's root must be type 'object'",
      });
    }
    const { depth, nodes } = measureSchema(schema);
    if (depth > OUTPUT_SCHEMA_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `nests ${depth} levels deep; at most ${OUTPUT_SCHEMA_MAX_DEPTH}`,
      });
    }
    if (nodes > OUTPUT_SCHEMA_MAX_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `has ${nodes} nodes; at most ${OUTPUT_SCHEMA_MAX_NODES}`,
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
    if (bytes > OUTPUT_SCHEMA_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `is ${bytes} bytes; at most ${OUTPUT_SCHEMA_MAX_BYTES}`,
      });
    }
  });

/** One place where an output does not match its schema. */
export interface OutputProblem {
  readonly path: string;
  readonly message: string;
}

export const OutputProblemSchema = z.object({ path: z.string(), message: z.string() }).strict();

/** What {@link validateOutput} found: at most {@link MAX_OUTPUT_PROBLEMS} problems, and how many
 *  there were in all. */
export interface OutputValidation {
  readonly problems: readonly OutputProblem[];
  readonly problemCount: number;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** A key longer than this is cut in a path — an output's keys are the Worker's own text. */
const PATH_KEY_MAX_CHARS = 64;

/** `parent` with `key` appended, as {@link OutputProblem.path} names places. */
export function outputPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}.${key}`;
  const shown = key.length > PATH_KEY_MAX_CHARS ? `${key.slice(0, PATH_KEY_MAX_CHARS)}…` : key;
  return PLAIN_KEY.test(shown) ? `${parent}.${shown}` : `${parent}[${JSON.stringify(shown)}]`;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: OutputSchemaType): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(b)) return false;
    const left = Object.keys(a);
    const right = Object.keys(b);
    return (
      left.length === right.length &&
      left.every(
        (key) =>
          Object.hasOwn(b, key) &&
          jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

/** A schema literal quoted in a message, bounded. */
function quoted(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

class TooLargeToCheck extends Error {}

/**
 * Where `output` does not match `schema` — see the module comment. Pure and bounded: it walks
 * `output` along `schema` only and visits at most {@link OUTPUT_VALIDATION_MAX_NODES} values; an
 * output with more along its schema is one problem, at `output`. `root` names the value in the
 * problems' paths (S11 GO5d-2: a goal's Procedure `parameters` are checked by the same rules).
 */
export function validateOutput(
  schema: OutputSchema,
  output: unknown,
  root = 'output',
): OutputValidation {
  const problems: OutputProblem[] = [];
  let problemCount = 0;
  let visited = 0;
  const report = (path: string, message: string): void => {
    problemCount += 1;
    if (problems.length < MAX_OUTPUT_PROBLEMS) problems.push({ path, message });
  };

  const visit = (node: OutputSchema, value: unknown, path: string): void => {
    visited += 1;
    if (visited > OUTPUT_VALIDATION_MAX_NODES) throw new TooLargeToCheck();
    const types = typesOf(node);
    if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
      report(path, `expected ${types.join(' or ')}, got ${jsonTypeOf(value)}`);
      return;
    }
    if (node.const !== undefined && !jsonEqual(value, node.const)) {
      report(path, `must be ${quoted(node.const)}`);
    }
    if (node.enum !== undefined && !node.enum.some((allowed) => jsonEqual(value, allowed))) {
      report(path, `must be one of ${quoted(node.enum)}`);
    }
    if (typeof value === 'string') {
      // Characters as a person counts them: code points, not UTF-16 units.
      const length = [...value].length;
      if (node.minLength !== undefined && length < node.minLength) {
        report(path, `shorter than ${node.minLength} characters`);
      }
      if (node.maxLength !== undefined && length > node.maxLength) {
        report(path, `longer than ${node.maxLength} characters`);
      }
    }
    if (typeof value === 'number') {
      if (node.minimum !== undefined && value < node.minimum) {
        report(path, `less than ${node.minimum}`);
      }
      if (node.maximum !== undefined && value > node.maximum) {
        report(path, `greater than ${node.maximum}`);
      }
    }
    if (Array.isArray(value)) {
      if (node.minItems !== undefined && value.length < node.minItems) {
        report(path, `fewer than ${node.minItems} items`);
      }
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        report(path, `more than ${node.maxItems} items`);
      }
      if (node.items !== undefined) {
        for (const [index, item] of value.entries()) {
          visit(node.items, item, outputPath(path, index));
        }
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const name of node.required ?? []) {
        if (!Object.hasOwn(record, name)) report(outputPath(path, name), 'required, missing');
      }
      const properties = node.properties ?? {};
      for (const [name, inner] of Object.entries(record)) {
        const declared = Object.hasOwn(properties, name) ? properties[name] : undefined;
        if (declared !== undefined) {
          visit(declared, inner, outputPath(path, name));
        } else if (node.additionalProperties === false) {
          report(
            outputPath(path, name),
            'not declared by the schema (additionalProperties is false)',
          );
        }
      }
    }
  };

  try {
    visit(schema, output, root);
  } catch (err) {
    if (!(err instanceof TooLargeToCheck)) throw err;
    return {
      problems: [
        {
          path: root,
          message: `too large to check: more than ${OUTPUT_VALIDATION_MAX_NODES} values`,
        },
      ],
      problemCount: 1,
    };
  }
  return { problems, problemCount };
}

/**
 * Where a reported `output` breaks a step's output contract: `schema` is the step's (`null` when
 * it declares none — then nothing is asked of `output`). A contract with a schema and no `output`
 * is one problem at `output`. The one definition of "the output meets its contract" — the kernel
 * refuses a report by it and the console explains a refusal with its problems.
 */
export function outputContractProblems(
  schema: OutputSchema | null,
  output: unknown,
): OutputValidation {
  if (schema === null) return { problems: [], problemCount: 0 };
  if (output === undefined) {
    return {
      problems: [
        {
          path: 'output',
          message:
            "missing: this step declares an output schema — report the step's structured result in output",
        },
      ],
      problemCount: 1,
    };
  }
  return validateOutput(schema, output);
}
