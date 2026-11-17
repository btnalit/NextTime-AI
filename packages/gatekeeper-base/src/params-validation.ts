import type { JsonSchemaObject } from '@nexttime/shared';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ParamsSchemaInvalidError, ParamsValidationError } from './errors.js';

/**
 * Validates an Operation's `params` against its own `params_schema` (a JSON Schema object,
 * imported from OpenAPI/MCP `tools/list`/hand-written YAML — design doc §5.1.4/§7.5). One shared
 * `Ajv` instance, one compiled validator per distinct schema (cached by object identity — manifest
 * Operations are loaded once at gate startup and not mutated, so identity caching is sound and
 * avoids recompiling the same schema on every call).
 *
 * Two review lane 5, P2-5 fixes:
 *   - `ajv.compile()` throwing (most commonly an unresolved `$ref` — this package does not fetch/
 *     inline external JSON Schema documents at import time) previously propagated as a bare
 *     `Error`, which `server.ts`'s `mapGatekeeperError` has no branch for and so fell through to a
 *     500 `internal_error` — opaque, and indistinguishable from an actual bug in this package.
 *     Wrapped in `ParamsSchemaInvalidError` (400 `invalid_operation_schema`) instead: a clear
 *     signal that the *manifest*, not the caller's params, is broken, naming the Operation.
 *   - A schema with `properties` but no explicit `additionalProperties` now defaults to
 *     `additionalProperties: false` at compile time (not mutating the stored schema) — previously
 *     any unexpected extra key silently passed validation and was then forwarded by the transport
 *     (e.g. into an HTTP query string or JSON body) with no schema coverage at all.
 */

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Legacy 803 (#501 review of #1365): which JSON Schema dialect a `params_schema` is checked in.
 * draft-07 (`ajv`) stays the default. A schema written for 2019-09 / 2020-12 — an OpenAPI 3.1
 * document's, or an MCP tool's (the MCP spec's default dialect is 2020-12) — used to be checked as
 * draft-07 too: its `unevaluated*`, `dependentRequired`, `dependentSchemas`, `minContains` /
 * `maxContains` were ignored (looser than written), `prefixItems` beside `items: false` refused
 * every non-empty array, and a `$schema` naming 2019-09 or 2020-12 failed every call (ajv has no
 * such meta-schema). Now:
 *   - `$schema` naming 2020-12 or 2019-09 → that dialect;
 *   - `$schema` naming anything else → draft-07, as before (an unknown one is still refused);
 *   - no `$schema` → 2020-12 when the schema uses a keyword only 2019-09 / 2020-12 give a meaning
 *     (`DIALECT_2020_KEYWORDS`), draft-07 otherwise. draft-07 never gave those words a meaning, so a
 *     schema that uses them was written for the later dialect; one that does not checks the same
 *     either way, except draft-07's array-form `items`, which 2020-12 refuses — so it stays draft-07.
 */
const ajv2019 = new Ajv2019({ allErrors: true, strict: false });
const ajv2020 = new Ajv2020({ allErrors: true, strict: false });

/** `$schema` URIs of the two later dialects, `http` or `https`, with or without the empty fragment. */
const DIALECT_2020_12 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;
const DIALECT_2019_09 = /^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/;

/** Keywords draft-07 has no meaning for and 2019-09 / 2020-12 do. */
const DIALECT_2020_KEYWORDS = new Set([
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentRequired',
  'dependentSchemas',
  'minContains',
  'maxContains',
  '$dynamicRef',
  '$dynamicAnchor',
]);

/** Keywords whose value maps names to schemas: the names are the schema's data, not keywords (a
 *  property called `prefixItems` says nothing about the dialect). */
const SCHEMA_MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependencies',
]);

/** Keywords whose value is data, never a schema (and every `x-` extension, below). */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'example', 'required']);

/** Whether `schema`, anywhere in it, uses one of `DIALECT_2020_KEYWORDS`. */
function usesLaterDialectKeywords(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(usesLaterDialectKeywords);
  if (schema === null || typeof schema !== 'object') return false;
  for (const [keyword, value] of Object.entries(schema)) {
    if (DIALECT_2020_KEYWORDS.has(keyword)) return true;
    if (DATA_KEYWORDS.has(keyword) || keyword.startsWith('x-')) continue;
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && value !== null && typeof value === 'object') {
      if (Object.values(value).some(usesLaterDialectKeywords)) return true;
      continue;
    }
    if (usesLaterDialectKeywords(value)) return true;
  }
  return false;
}

/** The validator for `schema`'s dialect (legacy 803, above), and the schema it compiles: without a
 *  `$schema` that named 2019-09 or 2020-12 — the validator is that dialect already, and ajv knows
 *  each meta-schema by one spelling only. */
function dialectOf(schema: JsonSchemaObject): {
  readonly validator: Ajv | Ajv2019 | Ajv2020;
  readonly schema: JsonSchemaObject;
} {
  const { $schema: declared, ...rest } = schema;
  if (typeof declared === 'string') {
    if (DIALECT_2020_12.test(declared)) return { validator: ajv2020, schema: rest };
    if (DIALECT_2019_09.test(declared)) return { validator: ajv2019, schema: rest };
    return { validator: ajv, schema };
  }
  return { validator: usesLaterDialectKeywords(schema) ? ajv2020 : ajv, schema };
}

const compiledCache = new WeakMap<object, ValidateFunction>();

/** Adds `additionalProperties: false` only when the schema declares `properties` and does not
 *  already say one way or the other — an explicit `additionalProperties: true` is left alone, and
 *  so is a schema that says it with `unevaluatedProperties` (legacy 803: adding it there would also
 *  refuse the properties an `allOf` beside it declares, which `unevaluatedProperties` lets through). */
function withDefaultAdditionalProperties(schema: JsonSchemaObject): JsonSchemaObject {
  if (
    schema.properties !== undefined &&
    schema.additionalProperties === undefined &&
    schema.unevaluatedProperties === undefined
  ) {
    return { ...schema, additionalProperties: false };
  }
  return schema;
}

function compile(operationName: string, schema: JsonSchemaObject): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  let validate: ValidateFunction;
  try {
    const dialect = dialectOf(schema);
    validate = dialect.validator.compile(withDefaultAdditionalProperties(dialect.schema));
  } catch (err) {
    throw new ParamsSchemaInvalidError(operationName, err);
  }
  compiledCache.set(schema, validate);
  return validate;
}

/** Throws `ParamsValidationError` if `params` does not satisfy `schema`. An empty schema (`{}`,
 *  the common case for a not-yet-refined imported Operation draft) accepts anything. */
export function assertParamsValid(
  operationName: string,
  schema: JsonSchemaObject,
  params: unknown,
): void {
  if (Object.keys(schema).length === 0) return;
  const validate = compile(operationName, schema);
  const valid = validate(params ?? {});
  if (!valid) {
    throw new ParamsValidationError(operationName, validate.errors);
  }
}
