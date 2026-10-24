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

/**
 * S11 「门确认不存在」 (gate-confirmed absence, part A): the target's own answers an observe-class
 * Operation declares mean "the thing this call names does not exist" — `absent_statuses` on an
 * http binding, `absent_exit_codes` on a cli or ssh one (an mcp tool has no such answer). A gate
 * that gets one of them back from the target answers the observe call as absent
 * (`{ absent: { status } }` / `{ absent: { exitCode } }` on the protocol envelope, never inside
 * `data`), instead of as a failed call; nothing else it gets back — an empty result, a refusal, a
 * failure of the gate or of the transport — ever reads as absent.
 *
 * The declaration is part of the binding, so it is part of the definition the Operation's digest
 * covers (`@nexttime/gatekeeper-base`'s `operation-digest.ts`): it is reviewed when the Operation
 * is published, and a gate running a definition that says otherwise is refused. An Operation
 * without one keeps its digest and behaves as before. Only an observe-class Operation's
 * declaration counts ({@link operationAbsentAnswers}); an execute-class call that gets one of
 * these answers back failed, as always.
 *
 * Which answers may be declared:
 *   - http: 404 and 410 only. Any other status says something else (a refusal, a bad request, a
 *     server that failed), not that the named thing is not there.
 *   - cli / ssh: exit statuses 1–125. 0 is success; 126 and 127 are a shell that could not run the
 *     command, above 128 a command killed by a signal, and ssh's own 255 is a connection that may
 *     have failed after the command started — none of them is the command's answer.
 */
export const ABSENT_HTTP_STATUSES = [404, 410] as const;
export const ABSENT_EXIT_CODE_MIN = 1;
export const ABSENT_EXIT_CODE_MAX = 125;

function distinct(values: readonly number[]): boolean {
  return new Set(values).size === values.length;
}

const AbsentStatusesSchema = z
  .array(z.union([z.literal(ABSENT_HTTP_STATUSES[0]), z.literal(ABSENT_HTTP_STATUSES[1])]))
  .min(1)
  .refine(distinct, { message: 'absent_statuses must not repeat a status' });

const AbsentExitCodesSchema = z
  .array(z.number().int().min(ABSENT_EXIT_CODE_MIN).max(ABSENT_EXIT_CODE_MAX))
  .min(1)
  .max(8)
  .refine(distinct, { message: 'absent_exit_codes must not repeat a status' });

const HttpBindingSchema = z.object({
  kind: z.literal('http'),
  method: z.string(),
  path: z.string(),
  absent_statuses: AbsentStatusesSchema.optional(),
});

const McpBindingSchema = z.object({
  kind: z.literal('mcp'),
  tool_name: z.string(),
});

const CliBindingSchema = z.object({
  kind: z.literal('cli'),
  command_template: z.string(),
  absent_exit_codes: AbsentExitCodesSchema.optional(),
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
  absent_exit_codes: AbsentExitCodesSchema.optional(),
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

/**
 * Legacy 232 (review #493): the rule a *new* Operation name must meet — an Operation's name is
 * the action kind an approver reads on the approval card, and `propose_operation` lets an agent
 * choose it. At most `OPERATION_NAME_MAX` characters, and none that is invisible or reorders
 * what is shown: control characters (`\p{Cc}`), format characters (`\p{Cf}` — bidi overrides
 * such as U+202E, zero-width characters), lone surrogates (`\p{Cs}`), line / paragraph
 * separators (`\p{Zl}`, `\p{Zp}`). Enforced where a new identity is written (`proposeOperation`,
 * `importManifest` in the kernel), not by `OperationSchema` itself: stored and announced
 * definitions are parsed with that schema, and a name already on file keeps working (it is
 * escaped where shown).
 */
export const OPERATION_NAME_MAX = 128;

const DISALLOWED_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export type OperationNameProblem = 'empty' | 'too_long' | 'invisible_or_control_characters';

/** Why `name` may not name a new Operation, or `undefined` when it may. */
export function operationNameProblem(name: string): OperationNameProblem | undefined {
  if (name.trim().length === 0) return 'empty';
  if ([...name].length > OPERATION_NAME_MAX) return 'too_long';
  if (DISALLOWED_NAME_CHARACTER.test(name)) return 'invisible_or_control_characters';
  return undefined;
}

/** The fields of an Operation, as an object schema — for picking fields
 *  (`@nexttime/gatekeeper-base`'s digest) and listing them. Parse an Operation with
 *  {@link OperationSchema}, which adds the rules between fields. */
export const OperationFieldsSchema = z.object({
  name: z.string(),
  /** S8 W2-K1 (leftover 71/72, audit B3/CO1): human-readable, markdown-free description of what
   *  this Operation does — used by `find_operations`'s own keyword ranking
   *  (`substrate/graph/find-means.ts`) and shown wherever an Operation is listed for a human to
   *  pick. Optional at this schema's own level — a manifest sourced from a live gate's
   *  `describe_operations` (accept-s2 fixtures, a third-party MCP/OpenAPI system) may not have
   *  one yet, and this package does no business-logic validation (R4 scope: "no IO / no business
   *  logic here"). Nor does an import require one: refusing a real system over a missing
   *  description would block connecting it (STATUS leftover 372); a person adds or edits one in
   *  the catalog (`update_operation_description`). */
  description: z.string().optional(),
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
  /** P-B1 (design §6.3 "MCP 信任分级", cloudflare-os `classifyTool`): the MCP tool annotations an
   *  imported Operation came with, kept verbatim so the approval decision can apply the rule
   *  "auto-approve only when the gate instance is `vetted` ∧ `!destructive_hint` ∧
   *  `idempotent_hint`" at decision time. Absent for Operations that did not come from `tools/list`. */
  read_only_hint: z.boolean().optional(),
  destructive_hint: z.boolean().optional(),
  idempotent_hint: z.boolean().optional(),
});

/**
 * An Operation. S11 「门确认不存在」 (review #501 on #753): only an observe-class Operation may
 * declare which answers mean "does not exist" — on an execute-class one the declaration would be
 * covered by the digest yet never act ({@link operationAbsentAnswers} reads observe only) nor be
 * shown to whoever reviews the publish, a state that means nothing. Refused where a definition is
 * parsed: a gate's manifest, an import, a proposal.
 */
export const OperationSchema = OperationFieldsSchema.superRefine((operation, ctx) => {
  if (operation.mode === 'observe') return;
  const binding = operation.binding;
  const field =
    binding.kind === 'http' && binding.absent_statuses !== undefined
      ? 'absent_statuses'
      : (binding.kind === 'cli' || binding.kind === 'ssh') &&
          binding.absent_exit_codes !== undefined
        ? 'absent_exit_codes'
        : undefined;
  if (field === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['binding', field],
    message: `${field} is declared on an observe-class Operation only: a ${operation.mode}-class call that gets such an answer failed`,
  });
});
export type Operation = z.infer<typeof OperationSchema>;

/** S11 「门确认不存在」: the target's answer a gate reports an observe call absent by — the http
 *  status, or the exit status of the command — on the protocol envelope's `absent`. Only ever one
 *  that the Operation declares ({@link isDeclaredAbsence}). */
export const GateAbsenceSchema = z.union([
  z.object({ status: z.number().int() }).strict(),
  z.object({ exitCode: z.number().int() }).strict(),
]);
export type GateAbsence = z.infer<typeof GateAbsenceSchema>;

/** The answers that mean absent for `operation`: its binding's declaration when it is an
 *  observe-class Operation that has one, else `undefined` — the one reading of the declaration the
 *  gate, the kernel and the console share. */
export function operationAbsentAnswers(
  operation: Pick<Operation, 'mode' | 'binding'>,
):
  | { readonly statuses: readonly number[] }
  | { readonly exitCodes: readonly number[] }
  | undefined {
  if (operation.mode !== 'observe') return undefined;
  const binding = operation.binding;
  if (binding.kind === 'http' && binding.absent_statuses) {
    return { statuses: binding.absent_statuses };
  }
  if ((binding.kind === 'cli' || binding.kind === 'ssh') && binding.absent_exit_codes) {
    return { exitCodes: binding.absent_exit_codes };
  }
  return undefined;
}

/** Whether `answer` is one `operation` declares means absent ({@link operationAbsentAnswers}). */
export function isDeclaredAbsence(
  operation: Pick<Operation, 'mode' | 'binding'>,
  answer: GateAbsence,
): boolean {
  const declared = operationAbsentAnswers(operation);
  if (!declared) return false;
  if ('statuses' in declared)
    return 'status' in answer && declared.statuses.includes(answer.status);
  return 'exitCode' in answer && declared.exitCodes.includes(answer.exitCode);
}
