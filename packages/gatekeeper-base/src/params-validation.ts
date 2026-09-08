import type { JsonSchemaObject } from '@nexttime/shared';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
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

const compiledCache = new WeakMap<object, ValidateFunction>();

/** Adds `additionalProperties: false` only when the schema declares `properties` and does not
 *  already say one way or the other — an explicit `additionalProperties: true` is left alone. */
function withDefaultAdditionalProperties(schema: JsonSchemaObject): JsonSchemaObject {
  if (schema.properties !== undefined && schema.additionalProperties === undefined) {
    return { ...schema, additionalProperties: false };
  }
  return schema;
}

function compile(operationName: string, schema: JsonSchemaObject): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(withDefaultAdditionalProperties(schema));
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
