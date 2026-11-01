import { z } from 'zod';
import { BlastRadiusSchema, OperationModeSchema, isMetaOntologyObjectType } from './enums.js';

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
 *
 * Review #493 F1: `object_type` never names a platform meta-ontology type (`Operation`,
 * `Gatekeeper`, …) — a gate's answer must not become a published definition. The kernel skips such
 * an observed candidate whatever sends it; refusing the mapping tells the manifest's author early.
 */
export const ResultMappingSchema = z.object({
  jmes_path: z.string(),
  object_type: z.string().refine((objectType) => !isMetaOntologyObjectType(objectType), {
    message:
      'result_mapping.object_type must not name a platform meta-ontology type (WorkerDefinition, Gatekeeper, Operation, Capability, Skill, Procedure) — a gate observes the connected system, never the platform',
  }),
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

/**
 * S11 GO12 (docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md §4.10): which instance an
 * execute-class call acts on, so a gate's queue orders it only against the calls it can conflict
 * with. `object_type` is the one ObjectType the call reads and writes; `params`, in order, name the
 * call's params whose values are that instance's identity. Every call of the same gate that names
 * an instance of `object_type` gives its identity in the same order.
 *
 * An Operation that declares none is ordered against every call of its gate, as before GO12. One
 * whose effect reaches more than one instance (a compose project's containers, a bulk change) does
 * not declare one. A governance field like `reads` / `writes`: the gate does not act on it, so it
 * is not part of the definition's digest; declaring one loosens the order, which is reviewed
 * (`OPERATION_FIELD_RULES`).
 */
export const OperationTargetSchema = z
  .object({
    object_type: z.string().min(1),
    params: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict();
export type OperationTarget = z.infer<typeof OperationTargetSchema>;

/** Why a `target` declaration is refused where an Operation is parsed — each the first word of the
 *  issue's message and its `params.reason`:
 *   - `target_not_execute`: only an execute-class call is queued;
 *   - `target_type_not_sole_written`: the call writes `object_type` and reads or writes nothing
 *     else (a call touching another type could conflict with calls on it, which no target says);
 *   - `target_params_duplicate`: a param named twice;
 *   - `target_param_not_required_scalar`: a param the call need not carry, or one whose schema type
 *     is not `string` or `integer` (an array or object names more than one instance, or none);
 *   - `target_arity_inconsistent` (a whole manifest, {@link manifestTargetProblems}): two
 *     Operations of one gate name instances of the same type by different numbers of params. */
export const OPERATION_TARGET_REFUSAL_VALUES = [
  'target_not_execute',
  'target_type_not_sole_written',
  'target_params_duplicate',
  'target_param_not_required_scalar',
  'target_arity_inconsistent',
] as const;
export type OperationTargetRefusal = (typeof OPERATION_TARGET_REFUSAL_VALUES)[number];

/** One refused `target` declaration: the reason, the path under the Operation, a message. */
export interface OperationTargetProblem {
  readonly reason: OperationTargetRefusal;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The JSON Schema `type` of `params_schema`'s param `name`, when it is a single string. */
function paramSchemaType(paramsSchema: Record<string, unknown>, name: string): string | undefined {
  const properties = paramsSchema.properties;
  if (properties === null || typeof properties !== 'object') return undefined;
  const property = (properties as Record<string, unknown>)[name];
  if (property === null || typeof property !== 'object') return undefined;
  const type = (property as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

function requiredParams(paramsSchema: Record<string, unknown>): readonly string[] {
  const required = paramsSchema.required;
  return Array.isArray(required) ? required.filter((v): v is string => typeof v === 'string') : [];
}

/** What is wrong with `operation`'s own `target` declaration (see
 *  {@link OPERATION_TARGET_REFUSAL_VALUES}); empty when it declares none or a valid one. */
export function operationTargetProblems(operation: {
  readonly mode: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly params_schema: Record<string, unknown>;
  readonly target?: OperationTarget | undefined;
}): OperationTargetProblem[] {
  const target = operation.target;
  if (target === undefined) return [];
  const problems: OperationTargetProblem[] = [];
  if (operation.mode !== 'execute') {
    problems.push({
      reason: 'target_not_execute',
      path: ['target'],
      message: `only an execute-class call is queued (this one is ${operation.mode})`,
    });
  }
  const touched = new Set([...operation.reads, ...operation.writes]);
  if (
    !operation.writes.includes(target.object_type) ||
    touched.size !== 1 ||
    !touched.has(target.object_type)
  ) {
    problems.push({
      reason: 'target_type_not_sole_written',
      path: ['target', 'object_type'],
      message: `the call must write ${target.object_type} and read or write no other type (reads: ${JSON.stringify(operation.reads)}, writes: ${JSON.stringify(operation.writes)})`,
    });
  }
  const seen = new Set<string>();
  const required = requiredParams(operation.params_schema);
  target.params.forEach((name, index) => {
    if (seen.has(name)) {
      problems.push({
        reason: 'target_params_duplicate',
        path: ['target', 'params', index],
        message: `param ${JSON.stringify(name)} is named twice`,
      });
    }
    seen.add(name);
    const type = paramSchemaType(operation.params_schema, name);
    if (!required.includes(name) || (type !== 'string' && type !== 'integer')) {
      problems.push({
        reason: 'target_param_not_required_scalar',
        path: ['target', 'params', index],
        message: `param ${JSON.stringify(name)} must be required and of type string or integer (type: ${type ?? 'none'}, required: ${required.includes(name)})`,
      });
    }
  });
  return problems;
}

/** S11 GO12: across the Operations of one gate (a whole manifest), every `target` naming the same
 *  `object_type` names the same number of params — an identity given with two arities never
 *  matches, so calls on one instance would not be ordered. Refused as `target_arity_inconsistent`,
 *  pointing at each Operation whose arity differs from the first one declared for the type. */
export function manifestTargetProblems(
  operations: readonly { readonly name: string; readonly target?: OperationTarget | undefined }[],
): (OperationTargetProblem & { readonly operation: string })[] {
  const first = new Map<string, { readonly name: string; readonly arity: number }>();
  const problems: (OperationTargetProblem & { readonly operation: string })[] = [];
  for (const operation of operations) {
    const target = operation.target;
    if (target === undefined) continue;
    const seen = first.get(target.object_type);
    if (seen === undefined) {
      first.set(target.object_type, { name: operation.name, arity: target.params.length });
    } else if (seen.arity !== target.params.length) {
      problems.push({
        operation: operation.name,
        reason: 'target_arity_inconsistent',
        path: ['target', 'params'],
        message: `${operation.name} names ${target.object_type} by ${target.params.length} params, ${seen.name} by ${seen.arity}`,
      });
    }
  }
  return problems;
}

function isOperationTargetRefusal(value: unknown): value is OperationTargetRefusal {
  return (OPERATION_TARGET_REFUSAL_VALUES as readonly unknown[]).includes(value);
}

/** S11 GO12 (I-Q4): the first `target` refusal among the issues of parsing with
 *  {@link OperationSchema} (alone, or inside a larger shape), so every boundary that parses an
 *  Operation refuses it with the same reason. `at` is where the Operation sits in what was parsed
 *  (the path before `target`: `[]` for one Operation, `['operations', 3]` inside an announcement);
 *  `path` is under the Operation, as {@link operationTargetProblems} gives it. */
export function operationTargetRefusalOf(
  issues: readonly {
    readonly code: string;
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly params?: unknown;
  }[],
): (OperationTargetProblem & { readonly at: readonly PropertyKey[] }) | undefined {
  for (const issue of issues) {
    if (issue.code !== 'custom') continue;
    const reason = (issue.params as { readonly reason?: unknown } | undefined)?.reason;
    if (!isOperationTargetRefusal(reason)) continue;
    const index = issue.path.lastIndexOf('target');
    if (index < 0) continue;
    const prefix = `${reason}: `;
    return {
      reason,
      at: issue.path.slice(0, index),
      path: issue.path
        .slice(index)
        .filter((key): key is string | number => typeof key !== 'symbol'),
      message: issue.message.startsWith(prefix)
        ? issue.message.slice(prefix.length)
        : issue.message,
    };
  }
  return undefined;
}

/** S11 GO12: the instance one call acts on, as its request records it — `type` and `identity` decide
 *  what it conflicts with; `params` say where `identity` came from. */
export interface ActionTarget {
  readonly type: string;
  readonly params: readonly string[];
  readonly identity: readonly (string | number)[];
}

/** S11 GO12: the instance a call of `operation` with `params` acts on, or `null` — ordered against
 *  every call of its gate — when the Operation declares none, or a declared param is missing or
 *  not of its schema's type (`"5"` for an `integer` param, say): a value the gate might read as
 *  another one never narrows the order. */
export function actionTargetOf(
  operation: {
    readonly params_schema: Record<string, unknown>;
    readonly target?: OperationTarget | undefined;
  },
  params: Readonly<Record<string, unknown>>,
): ActionTarget | null {
  const target = operation.target;
  if (target === undefined) return null;
  const identity: (string | number)[] = [];
  for (const name of target.params) {
    const value = params[name];
    const type = paramSchemaType(operation.params_schema, name);
    if (type === 'string' && typeof value === 'string') identity.push(value);
    else if (type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) {
      identity.push(value);
    } else return null;
  }
  return { type: target.object_type, params: [...target.params], identity };
}

/** S11 GO12 (I-Q1): whether two calls of the same gate are ordered against each other — always when
 *  either acts on the whole gate (`null`), never when they act on instances of two types (each
 *  call reads and writes its type alone, I-Q4), and for one type unless both name the instance by
 *  the same params and their values differ: an instance named by other params (`id` against
 *  `name`, or a different number of them) may be the same one, and is not told apart (I-Q3).
 *  Erring this way only orders calls that need not be. */
export function actionTargetsConflict(
  a: Pick<ActionTarget, 'type' | 'params' | 'identity'> | null,
  b: Pick<ActionTarget, 'type' | 'params' | 'identity'> | null,
): boolean {
  if (a === null || b === null) return true;
  if (a.type !== b.type) return false;
  const sameParams =
    a.params.length === b.params.length &&
    a.params.every((name, index) => name === b.params[index]);
  if (!sameParams || a.identity.length !== b.identity.length) return true;
  // `5` and `"5"` (two Operations typing one param differently) may be the same instance to the
  // gate: compared as text, so they are ordered against each other.
  return a.identity.every((value, index) => String(value) === String(b.identity[index]));
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
  /** S11 GO12: the one instance an execute-class call acts on ({@link OperationTargetSchema}). */
  target: OperationTargetSchema.optional(),
});

/**
 * An Operation. S11 「门确认不存在」 (review #501 on #753): only an observe-class Operation may
 * declare which answers mean "does not exist" — on an execute-class one the declaration would be
 * covered by the digest yet never act ({@link operationAbsentAnswers} reads observe only) nor be
 * shown to whoever reviews the publish, a state that means nothing. Refused where a definition is
 * parsed: a gate's manifest, an import, a proposal.
 */
export const OperationSchema = OperationFieldsSchema.superRefine((operation, ctx) => {
  // S11 GO12: a `target` the rules refuse, each with its reason (OPERATION_TARGET_REFUSAL_VALUES).
  for (const problem of operationTargetProblems(operation)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...problem.path],
      message: `${problem.reason}: ${problem.message}`,
      params: { reason: problem.reason },
    });
  }
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
