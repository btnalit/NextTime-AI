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
