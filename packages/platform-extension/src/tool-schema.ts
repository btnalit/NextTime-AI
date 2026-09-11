import type { TSchema } from 'typebox';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * tool-schema: converts a shared-registry capability's Zod `paramsSchema` into a pi tool
 * parameter schema (S1.6). Split out of `modes/entry.ts` (S2.9) so `modes/worker.ts` can reuse it
 * for its own Zod-schema-backed tool (`report_result`) without duplicating the conversion — gate
 * tools (`<gate>.<op>`) do **not** use this: an Operation's `params_schema` (`@nexttime/shared`'s
 * `OperationSchema`) is already a JSON Schema object (imported at runtime from OpenAPI/MCP/hand-
 * written YAML — design doc §5.1.4/§7.5), so it is passed straight through as `TSchema` with no
 * conversion step.
 *
 * pi's `ToolDefinition.parameters` type (`TSchema`, from typebox) is used purely as a
 * JSON-Schema-shaped object at runtime (see the S1.6 PR body "假设" — pi never re-validates against
 * typebox's `Kind` symbols; it structurally clones/reads `.type`/`.properties`/`.required` when
 * building the provider's tool payload), so a plain `zod-to-json-schema` object cast to `TSchema`
 * is sufficient and avoids hand-duplicating the registry's Zod schemas as typebox schemas.
 */
export function toToolParameters(paramsSchema: ZodTypeAny): TSchema {
  const jsonSchema = zodToJsonSchema(paramsSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  jsonSchema.$schema = undefined;
  return jsonSchema as unknown as TSchema;
}

/**
 * W7 (found by the first real-model run of scripts/accept_s2.sh --real): a Gatekeeper Operation's
 * `params_schema` is whatever the manifest import produced — an OpenAPI GET with no parameters
 * yields `null`/`{}`, which the three gate-tool builders (entry/worker/interactive modes) used to
 * pass straight through as the pi tool's `parameters`. OpenAI-compatible providers reject the
 * *entire* request when any function's schema is not `type: "object"` ("Invalid schema for
 * function '<tool>': schema must be a JSON Schema of 'type: "object"', got 'type: null'"), so one
 * parameterless gate tool silently took every turn of the entry agent down with a 400 — the fake
 * provider never validates schemas, which is why S2 passed for weeks. This normalizes every gate
 * schema to an object schema: a missing/non-object schema becomes an empty object schema, an
 * object schema without an explicit `type` gets one; anything already well-formed is returned as
 * is.
 */
export function gateToolParameters(paramsSchema: unknown): TSchema {
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  if (paramsSchema === null || typeof paramsSchema !== 'object' || Array.isArray(paramsSchema)) {
    return empty as unknown as TSchema;
  }
  const schema = paramsSchema as Record<string, unknown>;
  if (schema.type === 'object') {
    return (schema.properties === undefined
      ? { ...schema, properties: {} }
      : schema) as unknown as TSchema;
  }
  if (
    schema.type === undefined &&
    (schema.properties !== undefined || Object.keys(schema).length === 0)
  ) {
    return { ...schema, type: 'object', properties: schema.properties ?? {} } as unknown as TSchema;
  }
  // A non-object top-level schema (e.g. `type: "string"`) cannot be a function's parameters — wrap
  // it as a single `value` property so the model can still supply it.
  return {
    type: 'object',
    properties: { value: schema },
    required: ['value'],
  } as unknown as TSchema;
}
