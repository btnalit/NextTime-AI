import { z } from 'zod';
import { BlastRadiusSchema, OperationModeSchema } from './enums.js';

/**
 * ActionDescription (design doc §3.2, ported from cloudflare-os) and Operation (§5.1.4, the
 * interface-manifest entry a Gatekeeper publishes). Pure Zod schemas — no IO.
 *
 * ActionDescription field shape is as specified by this task's brief:
 * `title, description(markdown), implementsRevert, awaitDecision?, autoApprovable?,
 * actionKind{tag,label}` — i.e. `actionKind` required, camelCase (this is a straight cloudflare-os
 * TS port). Assumption (see PR body "假设"): docs/reference-projects-and-oss-landscape.md's own
 * decomposition of the same cloudflare-os type marks `actionKind?` optional; this file follows the
 * task brief's literal field list (required) over that reference note, since the brief is this
 * deliverable's operative spec. If a real `actionKind`-less ActionDescription surfaces in
 * practice, loosen this to `.optional()`.
 *
 * Operation field shape is snake_case per the task brief and design doc §5.1.4/§7.5/§S2.4
 * verbatim (`params_schema`, `blast_radius`, `auto_approvable`, `await_decision`,
 * `result_mapping`) — unlike ActionDescription, this is the wire/YAML shape a Gatekeeper's
 * interface manifest (`gatekeepers/<system>/manifest.yaml`) and OpenAPI/MCP import produce, so
 * the binding and result-mapping sub-shapes keep the same convention (`tool_name`,
 * `command_template`, `command_pattern`, `jmes_path`, `object_type`, `identity_keys`).
 */

export const ActionKindSchema = z.object({
  tag: z.string(),
  label: z.string(),
});
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionDescriptionSchema = z.object({
  title: z.string(),
  /** Markdown. */
  description: z.string(),
  implementsRevert: z.boolean(),
  awaitDecision: z.boolean().optional(),
  autoApprovable: z.boolean().optional(),
  actionKind: ActionKindSchema,
});
export type ActionDescription = z.infer<typeof ActionDescriptionSchema>;

/**
 * A JSON Schema object (not a Zod schema): Operation.params_schema is imported at runtime from
 * OpenAPI / MCP `tools/list` / hand-written YAML (§5.1.4, §7.5), so its shape is only known then.
 * Represented here as an arbitrary JSON object — validated as valid JSON Schema by the ontology
 * layer, not by this package (no IO / no business logic here per R4 scope).
 */
export const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaObjectSchema>;

const HttpBindingSchema = z.object({
  kind: z.literal('http'),
  method: z.string(),
  path: z.string(),
});

const McpBindingSchema = z.object({
  kind: z.literal('mcp'),
  tool_name: z.string(),
});

const CliBindingSchema = z.object({
  kind: z.literal('cli'),
  command_template: z.string(),
});

/**
 * ssh binding carries a command template OR a command-pattern policy-table match (§5.1.4:
 * "命令模板或命令模式"); modeled as two optional fields rather than a nested union since the
 * design doc does not specify how a caller distinguishes the two forms up front. The "at least
 * one present" rule is enforced by a `.refine()` on the whole union below (a discriminated
 * union's members must all be plain ZodObjects, so the refinement cannot live on the member
 * itself).
 */
const SshBindingSchema = z.object({
  kind: z.literal('ssh'),
  command_template: z.string().optional(),
  command_pattern: z.string().optional(),
});

const OperationBindingUnion = z.discriminatedUnion('kind', [
  HttpBindingSchema,
  McpBindingSchema,
  CliBindingSchema,
  SshBindingSchema,
]);

export const OperationBindingSchema = OperationBindingUnion.refine(
  (binding) =>
    binding.kind !== 'ssh' ||
    binding.command_template !== undefined ||
    binding.command_pattern !== undefined,
  { message: 'ssh binding requires command_template or command_pattern' },
);
export type OperationBinding = z.infer<typeof OperationBindingSchema>;

/**
 * A JMESPath result mapping (§5.1.4, §7.5): turns a Gatekeeper's raw response into an object
 * identity key and a set of properties, so the kernel can write it as an `observed` Fact.
 */
export const ResultMappingSchema = z.object({
  jmes_path: z.string(),
  object_type: z.string(),
  identity_keys: z.array(z.string()),
  attributes: z.record(z.string(), z.string()).optional(),
});
export type ResultMapping = z.infer<typeof ResultMappingSchema>;

export const OperationSchema = z.object({
  name: z.string(),
  binding: OperationBindingSchema,
  params_schema: JsonSchemaObjectSchema,
  mode: OperationModeSchema,
  blast_radius: BlastRadiusSchema,
  reversibility: z.boolean(),
  auto_approvable: z.boolean(),
  await_decision: z.boolean(),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  result_mapping: ResultMappingSchema.optional(),
});
export type Operation = z.infer<typeof OperationSchema>;
