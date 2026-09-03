import type { JsonSchemaObject } from '@nexttime/shared';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { ParamsValidationError } from './errors.js';

/**
 * Validates an Operation's `params` against its own `params_schema` (a JSON Schema object,
 * imported from OpenAPI/MCP `tools/list`/hand-written YAML — design doc §5.1.4/§7.5). One shared
 * `Ajv` instance, one compiled validator per distinct schema (cached by object identity — manifest
 * Operations are loaded once at gate startup and not mutated, so identity caching is sound and
 * avoids recompiling the same schema on every call).
 */

const ajv = new Ajv({ allErrors: true, strict: false });

const compiledCache = new WeakMap<object, ValidateFunction>();

function compile(schema: JsonSchemaObject): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
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
  const validate = compile(schema);
  const valid = validate(params ?? {});
  if (!valid) {
    throw new ParamsValidationError(operationName, validate.errors);
  }
}
