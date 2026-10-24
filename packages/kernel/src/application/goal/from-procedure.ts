import {
  type GoalFromProcedure,
  type OutputSchema,
  PROCEDURE_PARAMS_SOURCE,
  type ProcedureBinding,
  type ProcedureStep,
  type StepBinding,
  validateOutput,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  RedactedTextSubmittedError,
  TextCarriesCredentialsError,
  redactedPathsIn,
} from '../../governance/redaction/index.js';
import {
  bindingPathProblems,
  bindingSchemaProblems,
  selectPath,
} from '../../substrate/epistemic/index.js';
import { getPublishedProcedure } from '../worker/index.js';
import { placeAt } from './bindings.js';
import {
  GoalPlanValidationError,
  MAX_REFUSAL_PATHS,
  bindingTargetsOverlap,
  paramsAsRead,
  parsePlan,
  planShape,
  refusalPlace,
  refusePlanCredentials,
  writtenValueAt,
} from './plan.js';

/**
 * application/goal/from-procedure (S11 GO5d-2; plan §4.3 "Procedure 成为计划模板"): a goal's plan
 * made from a published Procedure (`propose_goal`'s `fromProcedure`) instead of written out. The
 * plan it makes is revision 1's and goes through everything a written plan does — the credential
 * and `[redacted]` refusal, the plan's checks, confirmation by the requester — so coming from a
 * Procedure skips nothing; the revision records which version it came from (goal/0009).
 *
 * What a Procedure makes, step by step (`@nexttime/shared` `procedure.ts`):
 *   - a `worker` step is a plan step: its `key` (else `step-<n>`, n its 1-based place among the
 *     Procedure's steps), its Worker, `input`, `outputSchema`, `maxAttempts`, and `dependsOn` —
 *     else the `worker` step before it, so a Procedure without template fields runs its steps one
 *     after another. A binding from another step stays a binding of the plan step; one from
 *     {@link PROCEDURE_PARAMS_SOURCE} is filled in now: its `path` selects a value of the
 *     parameters the goal is proposed with, which is put in the step's input at `to`, so the plan
 *     stored is concrete;
 *   - a `verify` step is an acceptance check of the goal: its `check`, which the platform makes, or
 *     — without one — what the requester confirms. A plan has at most one check the requester
 *     confirms, so every such step goes into one (key `verify`), its descriptions numbered;
 *   - an `operation` or `approval` step is not a goal step (W1: a goal's steps run Workers), so a
 *     Procedure with one makes no plan.
 *
 * The parameters are checked against the Procedure's `parameters` schema with the rules a step's
 * output is (`validateOutput`, places under `fromProcedure.parameters`). Publishing a Procedure
 * that says anything of the plan it makes checks that plan without parameters
 * ({@link procedureTemplateProblems}: the `$params` bindings against the schema instead), so a
 * Procedure that could never make a plan is refused when it is published, not when it is used.
 */

/** What a plan is made from: a Procedure version's content. */
export interface ProcedureTemplate {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly steps: readonly ProcedureStep[];
  readonly parameters: OutputSchema | null;
}

/** The key of the one acceptance check the requester confirms for a Procedure's `verify` steps
 *  without a check of their own. */
export const PROCEDURE_CONFIRM_KEY = 'verify';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type Parameters =
  | { readonly kind: 'values'; readonly values: Record<string, unknown> }
  /** Publishing: no values — the `$params` bindings are checked against the schema only. */
  | { readonly kind: 'lint' };

interface Built {
  readonly plan: { readonly steps: unknown[]; readonly acceptance?: unknown[] };
  readonly problems: readonly string[];
  /** By plan step key: the Procedure's position of each binding the plan step keeps (those from
   *  other steps), so a plan problem about `bindings[i]` names the binding as the Procedure has it. */
  readonly bindingPositions: ReadonlyMap<string, readonly number[]>;
}

/** One Procedure `worker` step as the plan step it makes — see the module comment. */
function workerStep(
  template: ProcedureTemplate,
  step: Extract<ProcedureStep, { kind: 'worker' }>,
  key: string,
  previous: string | null,
  parameters: Parameters,
  problems: string[],
  bindingPositions: Map<string, readonly number[]>,
): Record<string, unknown> {
  let input = step.input;
  const fromSteps: StepBinding[] = [];
  const fromParameters: [number, ProcedureBinding][] = [];
  const kept: number[] = [];
  for (const [index, binding] of (step.bindings ?? []).entries()) {
    if (binding.from === PROCEDURE_PARAMS_SOURCE) fromParameters.push([index, binding]);
    else {
      fromSteps.push(binding as StepBinding);
      kept.push(index);
    }
  }
  bindingPositions.set(key, kept);
  if (fromParameters.length > 0 && input !== undefined && !isRecord(input)) {
    problems.push(
      `step "${key}": the input must be an object when the step has bindings — a binding fills a field of it`,
    );
  }
  const written = isRecord(input) ? input : null;
  for (const [position, [index, binding]] of fromParameters.entries()) {
    const where = `step "${key}": bindings[${index}]`;
    const before = problems.length;
    if (!template.parameters) {
      problems.push(
        `${where}: takes from ${PROCEDURE_PARAMS_SOURCE}, but the Procedure declares no parameters`,
      );
    }
    const pathProblems = bindingPathProblems(binding.path);
    for (const problem of pathProblems) problems.push(`${where}: ${problem}`);
    if (pathProblems.length === 0 && template.parameters) {
      for (const problem of bindingSchemaProblems(
        binding.path,
        template.parameters,
        'parameters',
      )) {
        problems.push(`${where}: ${problem}`);
      }
    }
    const earlier = fromParameters
      .slice(0, position)
      .find(([, other]) => bindingTargetsOverlap(other, binding));
    if (earlier) {
      problems.push(
        `${where}: puts its value at "${binding.to}", where bindings[${earlier[0]}] puts its own at "${earlier[1].to}"`,
      );
    }
    const stepBinding = fromSteps.find((other) => bindingTargetsOverlap(other, binding));
    if (stepBinding) {
      problems.push(
        `${where}: puts its value at "${binding.to}", where the binding from step "${stepBinding.from}" puts its own at "${stepBinding.to}"`,
      );
    }
    const at = written ? writtenValueAt(written, binding.to) : null;
    if (at !== null) {
      problems.push(
        `${where}: the input already has a value at "${at}" — take it out of the input, or bind another field`,
      );
    }
    if (parameters.kind === 'lint' || problems.length > before) continue;
    const selected = selectPath(parameters.values, binding.path);
    if (!selected.found) {
      problems.push(
        `${where}: selects nothing of fromProcedure.parameters (${binding.path})${selected.error ? ` — ${selected.error}` : ''}`,
      );
      continue;
    }
    input = placeAt(isRecord(input) ? input : {}, binding.to.split('.'), selected.value);
  }
  const dependsOn = step.dependsOn ?? (previous !== null ? [previous] : undefined);
  return {
    key,
    worker: { definitionId: step.definitionId, version: step.version },
    ...(input !== undefined ? { input } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
    ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
    ...(fromSteps.length > 0 ? { bindings: fromSteps } : {}),
  };
}

function buildPlan(template: ProcedureTemplate, parameters: Parameters): Built {
  const problems: string[] = [];
  const bindingPositions = new Map<string, readonly number[]>();
  const steps: unknown[] = [];
  const acceptance: unknown[] = [];
  const confirms: string[] = [];
  let previous: string | null = null;
  for (const [index, step] of template.steps.entries()) {
    const n = index + 1;
    if (step.kind === 'operation' || step.kind === 'approval') {
      // Publishing keeps such a Procedure: it is still followed by hand (record_procedure_followed).
      if (parameters.kind === 'values') {
        problems.push(
          `Procedure step ${n} is an ${step.kind} step — a goal's plan runs Workers and checks their work, so a Procedure with an ${step.kind} step makes no plan`,
        );
      }
      continue;
    }
    if (step.kind === 'verify') {
      if (step.check) acceptance.push(step.check);
      else confirms.push(step.description);
      continue;
    }
    const key = step.key ?? `step-${n}`;
    steps.push(workerStep(template, step, key, previous, parameters, problems, bindingPositions));
    previous = key;
  }
  if (steps.length === 0) {
    problems.push("the Procedure has no worker step — a goal's plan runs at least one Worker");
  }
  if (confirms.length > 0) {
    acceptance.push({
      kind: 'requester_confirm',
      key: PROCEDURE_CONFIRM_KEY,
      prompt:
        confirms.length === 1
          ? confirms[0]
          : confirms.map((description, i) => `${i + 1}. ${description}`).join('\n'),
    });
  }
  return {
    plan: { steps, ...(acceptance.length > 0 ? { acceptance } : {}) },
    problems,
    bindingPositions,
  };
}

/**
 * The plan `template` makes with `parameters` (absent: none given) — see the module comment.
 * Throws {@link GoalPlanValidationError} with every problem of the parameters and of the making;
 * the plan it returns is not checked yet (the caller holds it to everything a written plan is).
 */
export function expandProcedure(
  template: ProcedureTemplate,
  parameters: Record<string, unknown> | undefined,
): unknown {
  const problems: string[] = [];
  if (template.parameters) {
    const checked = validateOutput(
      template.parameters,
      parameters ?? {},
      'fromProcedure.parameters',
    );
    for (const problem of checked.problems) problems.push(`${problem.path}: ${problem.message}`);
    if (checked.problemCount > checked.problems.length) {
      problems.push(
        `fromProcedure.parameters: and ${checked.problemCount - checked.problems.length} more`,
      );
    }
  } else if (parameters !== undefined && Object.keys(parameters).length > 0) {
    problems.push(
      `fromProcedure.parameters: Procedure ${template.id} version ${template.version} takes no parameters`,
    );
  }
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  const built = buildPlan(template, { kind: 'values', values: parameters ?? {} });
  if (built.problems.length > 0) throw new GoalPlanValidationError(built.problems);
  return built.plan;
}

/**
 * What publishing `template` is refused for, as a template: the plan it makes, with its `$params`
 * bindings checked against its `parameters` schema instead of filled in, must pass the plan's
 * checks (`parsePlan`) and carry no suspected credential or `[redacted]` mark — a plan never does,
 * so a template that does could never make one. Every problem at once: the making's and, when it
 * made steps at all, the plan's — those prefixed, since their places are of the plan (`step
 * "step-2": …`, the key the plan step has), a binding named by its position in the Procedure step
 * all the same. Empty: nothing stops it.
 */
export function procedureTemplateProblems(template: ProcedureTemplate): readonly string[] {
  const built = buildPlan(template, { kind: 'lint' });
  if (built.plan.steps.length === 0) return built.problems;
  const prefix = 'the plan it makes: ';
  const planProblems: string[] = [];
  try {
    refusePlanCredentials(planShape(built.plan));
  } catch (err) {
    if (
      !(err instanceof TextCarriesCredentialsError || err instanceof RedactedTextSubmittedError)
    ) {
      throw err;
    }
    planProblems.push(err.message);
  }
  try {
    parsePlan(built.plan);
  } catch (err) {
    if (!(err instanceof GoalPlanValidationError)) throw err;
    planProblems.push(...err.problems.map((problem) => asProcedureBinding(problem, built)));
  }
  // The making already said it (the input of a step with bindings that is not an object).
  const said = new Set(built.problems);
  return [
    ...built.problems,
    ...planProblems.filter((problem) => !said.has(problem)).map((problem) => `${prefix}${problem}`),
  ];
}

/** A plan problem about a step's `bindings[i]` (and the `bindings[j]` it clashes with) with each
 *  index the binding's position in the Procedure step — the plan step keeps only the bindings from
 *  other steps. */
function asProcedureBinding(problem: string, built: Built): string {
  const key = /^step "([^"]+)": bindings\[\d+\]/.exec(problem)?.[1];
  const positions = key === undefined ? undefined : built.bindingPositions.get(key);
  if (!positions) return problem;
  const at = (whole: string, head: string, index: string) => {
    const position = positions[Number(index)];
    return position === undefined ? whole : `${head}${position}]`;
  };
  return problem
    .replace(/^(step "[^"]+": bindings\[)(\d+)\]/, at)
    .replace(/(, where bindings\[)(\d+)\]/, at);
}

/**
 * S11 GO5d-2: the parameters a goal is proposed with carry nothing a read would mask — no
 * suspected credential under the call-argument rule a step's input is held to (they go into one),
 * no `[redacted]` mark copied from a read — refused before anything else, places under
 * `fromProcedure.parameters` (`RedactedTextSubmittedError`, `TextCarriesCredentialsError`).
 */
export function refuseProcedureParameters(parameters: Record<string, unknown> | undefined): void {
  if (parameters === undefined) return;
  const place = (path: string) => refusalPlace('fromProcedure.parameters', path);
  const redacted = redactedPathsIn(parameters).map(place);
  if (redacted.length > 0) {
    throw new RedactedTextSubmittedError(
      redacted[0] as string,
      redacted.slice(0, MAX_REFUSAL_PATHS),
    );
  }
  const found = paramsAsRead(parameters);
  if (found.count === 0) return;
  const paths = [...new Set(found.paths.map(place))].slice(0, MAX_REFUSAL_PATHS);
  throw new TextCarriesCredentialsError(paths[0] ?? 'fromProcedure.parameters', found.count, paths);
}

/** The Procedure version a plan is made from, as the revision records it, and the start
 *  parameters it was made with (legacy 454: `null` when none were given). */
export interface PlanSource {
  readonly procedureId: string;
  readonly version: number;
  readonly parameters: Readonly<Record<string, unknown>> | null;
}

/**
 * The plan `fromProcedure` makes: the Procedure's published version it names (else its latest
 * published one) expanded with its parameters ({@link expandProcedure}), and which version that
 * was. A Procedure that is not published — unknown, a draft, deprecated — is a problem of the
 * call, not found the same way whatever it is.
 */
export async function planFromProcedure(
  client: PoolClient,
  workspaceId: string,
  fromProcedure: GoalFromProcedure,
): Promise<{ readonly plan: unknown; readonly source: PlanSource }> {
  const template = await getPublishedProcedure(client, workspaceId, fromProcedure);
  if (!template) {
    throw new GoalPlanValidationError([
      `fromProcedure: no published Procedure ${fromProcedure.procedureId}${fromProcedure.version !== undefined ? ` version ${fromProcedure.version}` : ''} — find_procedures lists the published ones`,
    ]);
  }
  return {
    plan: expandProcedure(template, fromProcedure.parameters),
    source: {
      procedureId: template.id,
      version: template.version,
      parameters: fromProcedure.parameters ?? null,
    },
  };
}

/**
 * Legacy 454: the acceptance check a Procedure version's `verify` steps without a check of their
 * own make (key {@link PROCEDURE_CONFIRM_KEY}, what the requester confirms), and which of its steps
 * (1-based, as the Procedure page numbers them) — or `null` when every `verify` step carries its
 * own check. A fact of the version: its content never changes, and the plan made from it always has
 * this check (`buildPlan`), so a goal's page names it from here, not from its key.
 */
export function procedureConfirmCheck(
  steps: readonly ProcedureStep[],
): { readonly key: string; readonly procedureSteps: readonly number[] } | null {
  const procedureSteps = steps.flatMap((step, index) =>
    step.kind === 'verify' && !step.check ? [index + 1] : [],
  );
  return procedureSteps.length > 0 ? { key: PROCEDURE_CONFIRM_KEY, procedureSteps } : null;
}
