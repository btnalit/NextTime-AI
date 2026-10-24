import { isDeepStrictEqual } from 'node:util';
import {
  type AcceptanceCheck,
  AcceptanceCheckSchema,
  DEFAULT_MAX_ATTEMPTS,
  type FactCheck,
  type FactObjectRef,
  type GoalAcceptanceCheckKind,
  type GoalPlan,
  GoalPlanSchema,
  MAX_ACCEPTANCE_PROMPT_CHARS,
  MAX_PLAN_ACCEPTANCE_CHECKS,
  MAX_PLAN_BYTES,
  MAX_PLAN_STEPS,
  MAX_STEP_ACCEPTANCE_CHECKS,
  MAX_STEP_ATTEMPTS,
  MAX_STEP_RECONCILE_DECLARATIONS,
  type ObservationCheck,
  type PlanHint,
  type PlanStep,
  PlanStepSchema,
  type Predicate,
  STEP_KEY_PATTERN,
  type StepAcceptanceCheck,
  StepAcceptanceCheckSchema,
  type StepBinding,
  type StepReconcile,
  StepReconcileSchema,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getGatekeeper, getPublishedOperation } from '../../governance/gatekeepers/index.js';
import {
  RedactedTextSubmittedError,
  type SuspectedSecrets,
  TextCarriesCredentialsError,
  findSuspectedSecrets,
  redactSuspectedSecrets,
  redactedPathsIn,
  reviewObserveParams,
  shownFreeTextIn,
} from '../../governance/redaction/index.js';
import {
  PREDICATE_LINT_PLAN_WORK,
  type PredicateLintBudget,
  bindingPathProblems,
  bindingSchemaProblems,
  lintPredicate,
  predicateLiterals,
} from '../../substrate/epistemic/index.js';
import {
  NO_OBSERVE_EXCLUSIONS,
  observeRefusal,
  readGatekeeperPlatformPolicy,
} from '../gates/index.js';
import { getWorkerDefinition } from '../worker/index.js';

/**
 * application/goal/plan (S11 GO2; plan §4.3, I-G3): what a step of a plan is, and the checks a plan
 * passes before a revision holding it may be created. The database relies only on "an object with
 * a `steps` array whose elements carry a unique `key`" (goal/0001); everything else about a step is
 * this module's.
 *
 * A step (W1):
 *   - `key` — the step's name in the plan, unique; a StepRun carries it (`step_runs.step_key`);
 *   - `worker` — a published `kind='worker'` WorkerDefinition version, pinned (the attempt's
 *     configuration snapshot records what that version resolved to, §4.4);
 *   - `input` — passed to the Worker as the Task's input, as is, with the values its `bindings` take
 *     put in;
 *   - `dependsOn` — keys of steps that must have succeeded first; the graph is acyclic;
 *   - `nested` — the step may start Workers of its own (`invoke_worker` / `find_workers` in its
 *     Handle). Off by default: teams are the advancer's, so budgets and dependencies have one
 *     manager (§4.4);
 *   - `maxAttempts` — attempts before a transient failure needs a person (default
 *     {@link DEFAULT_MAX_ATTEMPTS});
 *   - `reconcile` (S11 GO3d, plan §4.7) — for an action the step may raise, how the platform checks
 *     whether it took effect when its outcome is unknown: `action` names the action by its business
 *     identity (I-G4: Gatekeeper, Operation, params — the step's request matches only when all
 *     three are the same, `request-action.ts`'s `stepIdempotencyKey`), `check` an observe-class
 *     Operation, its params and a predicate over its result (`@nexttime/shared`
 *     `ObservationCheck`). A satisfied check records `effect_seen` for the action and the step goes
 *     on; anything else leaves the finding to a person (`reconcile-check.ts`). One declaration per
 *     action identity;
 *   - `acceptance` (S11 GO4b, plan §4.5, §4.6) — what has to hold once the step's work is done
 *     before the step succeeds and the steps after it may start: `observe_predicate` and
 *     `fact_predicate` checks (the goal's kinds, below; a step's acceptance never waits on a
 *     person), keys unique within the step. The platform makes them after each attempt whose work
 *     is done (`advance.ts` phase A, `acceptance-check.ts`). Changing them changes the step's
 *     entry, so a revision that does redefines the step (I-G2), like any other change to it;
 *   - `outputSchema` (S11 GO5d-1, plan §4.5) — what the step's Worker reports as its structured
 *     `output` (`@nexttime/shared` `output-schema.ts`, a bounded JSON Schema subset whose root is an
 *     object). `report_task_result` refuses a result that does not meet it, naming each place, and
 *     an attempt that never reports one that does ends without a result — reworked once, then a
 *     person (`advance.ts`);
 *   - `bindings` (S11 GO5d-1, plan §4.5) — fields of the input taken from earlier steps' outputs:
 *     `to` the field (dots for depth), `from` a step this one depends on that declares an
 *     `outputSchema`, `path` a JMESPath expression over that step's output ({@link
 *     bindingProblems}). The advancer puts the values in when an attempt starts
 *     (`bindings.ts`): a value that is not there, or that the credential review counts, pauses the
 *     run for a person rather than start the Worker without it.
 * Unknown fields are refused rather than ignored: a field this version does not act on must not
 * look like it is in force.
 *
 * The plan's `acceptance` (S11 GO4a, plan §4.6, I-G5) — what has to hold before the goal is
 * achieved, checked once every step is done (`advance.ts` phase V, `acceptance-check.ts`); each
 * check has a `key`, unique among them:
 *   - `observe_predicate` — `check` is an observe-class Operation, its params and a predicate over
 *     its result (`ObservationCheck`, the same shape and the same lint and credential review as a
 *     reconcile check's), observed by the platform for the requester;
 *   - `fact_predicate` (S11 GO4c) — `fact` is a Fact of the graph, the Link of a type from one
 *     Object to another (each by id, or by ObjectType and identity), and optionally a predicate
 *     over its own properties (`FactCheck`; the same lint and credential review, and no identity
 *     value that looks like a credential). No gate is called: the platform reads the graph as the
 *     requester and takes as evidence only a Fact observed since the round opened and not by the
 *     goal's own doing (`fact-check.ts`, goal/0007). A gate's observed Facts carry no properties,
 *     so on those only the Fact being there can be checked;
 *   - `requester_confirm` — `prompt` is what the requester is asked to confirm; asked once every
 *     check the platform makes passed. At most one, and no prompt that looks like it carries a
 *     credential.
 * A plan without any is allowed: its goal is achieved only on the requester's word (an implicit
 * `requester_confirm` whose prompt is the goal statement) — {@link planHints} says so, for the
 * confirmation card to show.
 *
 * `validatePlan` checks what a plan refers to as of now — keys unique, dependencies known and
 * acyclic, every worker a published worker-kind version; every reconcile declaration's action a
 * published execute-class Operation and its check a published observe-class one the platform does
 * not cut off, with params that carry no credential and a predicate the lint accepts
 * (`substrate/epistemic`'s `lintPredicate`: one that would pass without the observation showing the
 * target is refused here, before any person is asked to confirm it) and whose literals carry no
 * suspected credential ({@link predicateCredentialProblems}); the last two are `parsePlan`'s. Every
 * acceptance observation — the goal's and the steps' — is held to what a reconcile check is; a fact
 * check's predicate to the same lint and review, and an Object it names by id must exist. A
 * version deprecated later is caught when an attempt would start (the advancer's snapshot check),
 * not here; an observation the requester can no longer make is caught when it runs.
 */

// The plan's shape lives in `@nexttime/shared` (`goal-plan.ts`, S11 GO5a) — the wire and the
// console type plans with it; this module adds the checks beyond the shape. Re-exported so the
// kernel keeps one import path.
export {
  AcceptanceCheckSchema,
  DEFAULT_MAX_ATTEMPTS,
  GoalPlanSchema,
  MAX_ACCEPTANCE_PROMPT_CHARS,
  MAX_PLAN_ACCEPTANCE_CHECKS,
  MAX_PLAN_BYTES,
  MAX_PLAN_STEPS,
  MAX_STEP_ACCEPTANCE_CHECKS,
  MAX_STEP_ATTEMPTS,
  MAX_STEP_RECONCILE_DECLARATIONS,
  PlanStepSchema,
  STEP_KEY_PATTERN,
  StepAcceptanceCheckSchema,
  StepReconcileSchema,
};
export type { AcceptanceCheck, GoalPlan, PlanHint, PlanStep, StepAcceptanceCheck, StepReconcile };

export class GoalPlanValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`goal plan: ${problems.join('; ')}`);
    this.name = 'GoalPlanValidationError';
    this.problems = problems;
  }
}

/**
 * The plan's shape alone (`GoalPlanSchema`) — no other check, no database; the plan a check that
 * must come before the plan's other problems reads ({@link refusePlanCredentials}). Throws
 * {@link GoalPlanValidationError} naming each schema issue at its path in the plan
 * (`steps.0.key: …`).
 *
 * Every problem a plan is refused with names where it is, so an editor can put it next to the
 * part it is about (S11 GO5c, agreed with the console's plan editor): a schema issue by its path
 * (`steps.<i>.…`), a step's problem with `step "<key>": `, the plan's own acceptance checks with
 * `acceptance[<i>] "<key>": `; only the plan's size is about no part of it.
 */
export function planShape(plan: unknown): GoalPlan {
  const parsed = GoalPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new GoalPlanValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** {@link planShape}, then the plan's size, step graph and declarations — no database. Throws
 *  {@link GoalPlanValidationError} naming every problem found, each where it is. */
export function parsePlan(plan: unknown): GoalPlan {
  const shaped = planShape(plan);
  const problems: string[] = [];
  if (Buffer.byteLength(JSON.stringify(shaped), 'utf8') > MAX_PLAN_BYTES) {
    problems.push(`the plan is larger than ${MAX_PLAN_BYTES} bytes`);
  }
  const keys = new Set<string>();
  for (const step of shaped.steps) {
    if (keys.has(step.key)) problems.push(`step "${step.key}": the key appears more than once`);
    keys.add(step.key);
  }
  for (const step of shaped.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.key) problems.push(`step "${step.key}": depends on itself`);
      else if (!keys.has(dependency)) {
        problems.push(`step "${step.key}": depends on "${dependency}", which is not in the plan`);
      }
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(shaped.steps);
    if (cycle) {
      problems.push(`step "${cycle[0]}": the dependencies form a cycle: ${cycle.join(' -> ')}`);
    }
  }
  const lintBudget: PredicateLintBudget = { remaining: PREDICATE_LINT_PLAN_WORK };
  const byStepKey = new Map(shaped.steps.map((step) => [step.key, step]));
  for (const step of shaped.steps) {
    problems.push(...bindingProblems(step, byStepKey));
    problems.push(...reconcileShapeProblems(step, lintBudget));
    problems.push(
      ...acceptanceShapeProblems(step.acceptance ?? [], lintBudget, `step "${step.key}": `),
    );
  }
  problems.push(...acceptanceShapeProblems(shaped.acceptance ?? [], lintBudget, ''));
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  return shaped;
}

/** The acceptance checks of the plan, or of one step (`prefix` names it): keys unique, at most one
 *  `requester_confirm`, whose prompt carries nothing the credential review counts (people read it
 *  on the goal and in every revision after it, and it is asked as written — review #493 on #680),
 *  every predicate — an observation's, a fact check's — accepted by the lint
 *  (spending from the plan's `lintBudget`, which the reconcile declarations share) and free of
 *  suspected credentials — the rules a reconcile check's predicate is under, for the same reasons —
 *  and no identity a fact check names an Object by carrying one ({@link factSelectorProblems}). */
function acceptanceShapeProblems(
  acceptance: readonly (AcceptanceCheck | StepAcceptanceCheck)[],
  lintBudget: PredicateLintBudget,
  prefix: string,
): readonly string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  let confirmations = 0;
  acceptance.forEach((check, index) => {
    const where = `${prefix}acceptance[${index}] "${check.key}"`;
    if (keys.has(check.key)) problems.push(`${where}: the key appears more than once`);
    keys.add(check.key);
    if (check.kind === 'requester_confirm') {
      confirmations += 1;
      if (confirmations === 2) {
        problems.push(`${where}: a plan asks the requester to confirm at most once`);
      }
      const found = findSuspectedSecrets(check.prompt);
      if (found.count > 0) {
        problems.push(
          `${where}: the prompt looks like it carries a credential (${found.count} suspected) — a plan does not carry credentials`,
        );
      }
      return;
    }
    if (check.kind === 'fact_predicate') {
      for (const problem of factSelectorProblems(check.fact)) problems.push(`${where}: ${problem}`);
    }
    const expect = check.kind === 'fact_predicate' ? check.fact.expect : check.check.expect;
    if (!expect) return;
    for (const problem of lintPredicate(expect, lintBudget)) {
      problems.push(`${where}: ${problem}`);
    }
    for (const problem of predicateCredentialProblems(expect)) {
      problems.push(`${where}: ${problem}`);
    }
  });
  return problems;
}

/** The credential review of the Objects a fact check names (S11 GO4c): no identity value may carry
 *  what the credential review counts — the plan is read by people and kept in every revision after
 *  it, and an identity is matched as written, so a credential there would also have to sit in the
 *  graph. Run with the plan and again before every check (`fact-check.ts`). */
export function factSelectorProblems(fact: FactCheck): readonly string[] {
  const problems: string[] = [];
  for (const [end, ref] of [
    ['source', fact.source],
    ['target', fact.target],
  ] as const) {
    if (!('identity' in ref)) continue;
    const found = findSuspectedSecrets(ref.identity, { secretFields: true });
    if (found.count > 0) {
      problems.push(
        `the ${end}'s identity looks like it carries a credential (${found.count} suspected) — a plan does not carry credentials`,
      );
    }
  }
  return problems;
}

/** The hints a valid plan carries — for the confirmation card (GO6), recorded with the revision's
 *  validation (`PlanHint`, `@nexttime/shared`). */
export function planHints(plan: GoalPlan): readonly PlanHint[] {
  const acceptance = plan.acceptance ?? [];
  if (acceptance.some((check) => isPlatformAcceptanceCheck(check.kind))) return [];
  return [
    {
      code: 'requester_confirm_only',
      message:
        'the plan has no check the platform makes: the goal is achieved only when the requester confirms it',
    },
  ];
}

/** Whether an acceptance check of `kind` is one the platform makes — an observation or a Fact it
 *  judges — rather than a person's word (I-G5: a goal achieved by check rests on at least one;
 *  goal/0007's `goal_runs_status_guard` counts the same kinds). */
export function isPlatformAcceptanceCheck(kind: GoalAcceptanceCheckKind): boolean {
  return kind === 'observe_predicate' || kind === 'fact_predicate';
}

/** The key and prompt of the implicit `requester_confirm` of a plan without acceptance checks. */
export const IMPLICIT_CONFIRM_KEY = 'requester_confirm';

/** The acceptance checks a verification round of `plan` (a stored `plan_revisions.plan`) is made
 *  of: its `acceptance`, or — without any — one `requester_confirm` asking about `statement`.
 *  `null` when the stored plan is not a valid plan. */
export function roundAcceptance(
  plan: unknown,
  statement: string,
): readonly AcceptanceCheck[] | null {
  const parsed = GoalPlanSchema.safeParse(plan);
  if (!parsed.success) return null;
  const acceptance = parsed.data.acceptance ?? [];
  if (acceptance.length > 0) return acceptance;
  return [{ kind: 'requester_confirm', key: IMPLICIT_CONFIRM_KEY, prompt: statement }];
}

/**
 * S11 GO5d-1 (plan §4.5): a step's input bindings. Each takes from another step of the plan
 * (checked first, legacy 455), one it depends on (so that step has succeeded when an attempt
 * starts) and that declares an `outputSchema` (a binding takes
 * only from what a Worker is held to report); its `path` compiles and reads something
 * (`bindingPathProblems`), and selects nothing the upstream schema rules out
 * (`bindingSchemaProblems`: a field it closes off, a field of what is not an object, a position in
 * what is not a list). Where they put values: the input is an object, no two bindings put theirs at
 * the same field or one inside the other, and none where the written input already has a value —
 * one of them would silently win.
 */
function bindingProblems(step: PlanStep, steps: ReadonlyMap<string, PlanStep>): readonly string[] {
  const bindings = step.bindings ?? [];
  if (bindings.length === 0) return [];
  const problems: string[] = [];
  const input = step.input;
  if (input !== undefined && !isRecord(input)) {
    problems.push(
      `step "${step.key}": the input must be an object when the step has bindings — a binding fills a field of it`,
    );
  }
  const dependsOn = new Set(step.dependsOn ?? []);
  bindings.forEach((binding, index) => {
    const where = `step "${step.key}": bindings[${index}]`;
    const upstream = steps.get(binding.from);
    // Whether the step it names exists comes first (legacy 455): "add it to dependsOn" cannot fix a
    // binding from a step the plan does not have, or from the step itself.
    if (binding.from === step.key) {
      problems.push(
        `${where}: takes from this step itself — a binding takes from a step this one depends on`,
      );
    } else if (!upstream) {
      problems.push(`${where}: takes from step "${binding.from}", which is not in the plan`);
    } else if (!dependsOn.has(binding.from)) {
      problems.push(
        `${where}: takes from step "${binding.from}", which this step does not depend on — add it to dependsOn`,
      );
    } else if (!upstream.outputSchema) {
      problems.push(
        `${where}: step "${binding.from}" declares no outputSchema — a binding takes only from a declared output`,
      );
    }
    const pathProblems = bindingPathProblems(binding.path);
    for (const problem of pathProblems) problems.push(`${where}: ${problem}`);
    if (pathProblems.length === 0 && upstream?.outputSchema) {
      for (const problem of bindingSchemaProblems(binding.path, upstream.outputSchema)) {
        problems.push(`${where}: ${problem} of step "${binding.from}"`);
      }
    }
    const earlier = bindings.findIndex(
      (other, j) => j < index && bindingTargetsOverlap(other, binding),
    );
    if (earlier !== -1) {
      problems.push(
        `${where}: puts its value at "${binding.to}", where bindings[${earlier}] puts its own at "${bindings[earlier]?.to}"`,
      );
    }
    const written = isRecord(input) ? writtenValueAt(input, binding.to) : null;
    if (written !== null) {
      problems.push(
        `${where}: the input already has a value at "${written}" — take it out of the input, or bind another field`,
      );
    }
  });
  return problems;
}

/** Whether two bindings put their values at the same field, or one inside the other's. */
export function bindingTargetsOverlap(
  a: Pick<StepBinding, 'to'>,
  b: Pick<StepBinding, 'to'>,
): boolean {
  return a.to === b.to || a.to.startsWith(`${b.to}.`) || b.to.startsWith(`${a.to}.`);
}

/** Where the written `input` already has a value that a binding to `to` would replace — `to`
 *  itself, or a field on the way to it that is not an object — or `null`. */
export function writtenValueAt(input: Record<string, unknown>, to: string): string | null {
  const fields = to.split('.');
  let at: Record<string, unknown> = input;
  for (const [i, field] of fields.entries()) {
    if (!Object.hasOwn(at, field)) return null;
    const value = at[field];
    if (i === fields.length - 1 || !isRecord(value)) return fields.slice(0, i + 1).join('.');
    at = value;
  }
  return null;
}

/** A step's reconcile declarations: one per action identity, each predicate accepted by the lint
 *  (spending from the plan's `lintBudget`). */
function reconcileShapeProblems(
  step: PlanStep,
  lintBudget: PredicateLintBudget,
): readonly string[] {
  const problems: string[] = [];
  const declarations = step.reconcile ?? [];
  declarations.forEach((declaration, index) => {
    const where = `step "${step.key}": reconcile[${index}]`;
    const same = declarations.findIndex(
      (other) =>
        other.action.gatekeeperId === declaration.action.gatekeeperId &&
        other.action.operation === declaration.action.operation &&
        isDeepStrictEqual(other.action.params ?? {}, declaration.action.params ?? {}),
    );
    if (same !== index) problems.push(`${where}: declares the same action as reconcile[${same}]`);
    for (const problem of lintPredicate(declaration.check.expect, lintBudget)) {
      problems.push(`${where}: ${problem}`);
    }
    for (const problem of predicateCredentialProblems(declaration.check.expect)) {
      problems.push(`${where}: ${problem}`);
    }
  });
  return problems;
}

/**
 * The credential review of a reconcile check's predicate (review #493 on #649): no literal it
 * compares with — a comparison's `value` or a literal in its path — may carry a value the
 * credential review counts (`governance/redaction`'s `findSuspectedSecrets`, call-argument rule:
 * what an approval asks a person to confirm and every audit copy redacts). Refused outright, not
 * confirmed with 「已核对凭据」 as an approval is: the check judges the result with exactly those
 * values redacted (`reconcile-check.ts`, `redactSuspectedSecrets`, the same rule), so such a
 * literal could never be matched — `eq` would never hold, `ne` always would — and it would sit
 * in the plan a person confirms and in every revision after it; there is nothing for a tick to
 * make work. Run with the plan and again before every check (`reconcile-check.ts`), so a value
 * the review learns to suspect later stops the check rather than quietly failing to match.
 */
export function predicateCredentialProblems(predicate: Predicate): readonly string[] {
  const problems: string[] = [];
  for (const literal of predicateLiterals(predicate)) {
    const found = findSuspectedSecrets(literal.value, { secretFields: true });
    if (found.count > 0) {
      problems.push(
        `a value compared at path "${literal.path}" looks like a credential (${found.count} suspected) — the check judges the result with such values redacted, so it could never match; a plan does not carry credentials`,
      );
    }
  }
  return problems;
}

/** At most this many places go into a refusal's details — the count stays exact. */
export const MAX_REFUSAL_PATHS = 20;

/** Call arguments a plan holds, as every read shows them: each suspected credential replaced by
 *  `[redacted]` (`redactSuspectedSecrets`, the call-argument rule `get_task` applies to a Task's
 *  input, legacy 184), with where (paths within `params`). */
export function paramsAsRead<T>(params: T): SuspectedSecrets & { readonly value: T } {
  const redacted = redactSuspectedSecrets(params, { secretFields: true });
  return { value: redacted.value as T, count: redacted.count, paths: redacted.paths };
}

/** `plan` with each of its call arguments — a step's `input`, a reconcile declaration's action and
 *  check `params`, every acceptance observation's `params` — mapped by `map` (`at`: its path in the
 *  plan); the rest as it is. */
function mapPlanParams(plan: GoalPlan, map: <T>(params: T, at: string) => T): GoalPlan {
  const withParams = <V extends { readonly params?: Record<string, unknown> }>(
    value: V,
    at: string,
  ): V =>
    value.params === undefined ? value : { ...value, params: map(value.params, `${at}.params`) };
  const observation = <C extends AcceptanceCheck | StepAcceptanceCheck>(check: C, at: string): C =>
    check.kind === 'observe_predicate'
      ? { ...check, check: withParams(check.check, `${at}.check`) }
      : check;
  return {
    ...plan,
    steps: plan.steps.map((step, i) => ({
      ...step,
      ...(step.input !== undefined ? { input: map(step.input, `steps[${i}].input`) } : {}),
      ...(step.reconcile !== undefined
        ? {
            reconcile: step.reconcile.map((declaration, j) => ({
              ...declaration,
              action: withParams(declaration.action, `steps[${i}].reconcile[${j}].action`),
              check: withParams(declaration.check, `steps[${i}].reconcile[${j}].check`),
            })),
          }
        : {}),
      ...(step.acceptance !== undefined
        ? {
            acceptance: step.acceptance.map((check, j) =>
              observation(check, `steps[${i}].acceptance[${j}]`),
            ),
          }
        : {}),
    })),
    ...(plan.acceptance !== undefined
      ? { acceptance: plan.acceptance.map((check, j) => observation(check, `acceptance[${j}]`)) }
      : {}),
  };
}

/**
 * The plan as every read shows its call arguments (`views.ts`, the module comment there): a step's
 * `input`, a reconcile declaration's action and check `params`, every acceptance observation's
 * `params` — each under {@link paramsAsRead} — with how many values were replaced and where
 * (paths within the plan). The rest of the plan is read as a stored document ({@link planAsRead}).
 */
export function planParamsAsRead(plan: GoalPlan): {
  readonly plan: GoalPlan;
  readonly found: SuspectedSecrets;
} {
  let count = 0;
  const paths: string[] = [];
  const shown = mapPlanParams(plan, (params, at) => {
    const read = paramsAsRead(params);
    count += read.count;
    for (const path of read.paths) paths.push(path === '' ? at : `${at}.${path}`);
    return read.value;
  });
  return { plan: shown, found: { count, paths: paths.slice(0, MAX_REFUSAL_PATHS) } };
}

/**
 * The plan as every read shows it — its call arguments under {@link planParamsAsRead}, the rest as
 * a stored document (`shownFreeTextIn`: a suspected credential masked, an invisible character
 * spelled out, legacy 420). The one definition: `views.ts` reads a revision with it, and
 * {@link reviewRevisedPlan} compares a revision written from such a read against it.
 */
export function planAsRead(plan: GoalPlan): GoalPlan {
  return shownFreeTextIn(planParamsAsRead(plan).plan) as GoalPlan;
}

/** Legacy 454: a goal's Procedure start parameters as every read shows them — masked the way
 *  {@link planAsRead} masks the step inputs they were merged into. */
export function procedureParametersAsRead(
  parameters: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return shownFreeTextIn(paramsAsRead(parameters).value) as Record<string, unknown>;
}

/** A place in a document a refusal names, from the document's own name: dot-separated, array
 *  items by their 0-based index (`steps[0].input.host` → `plan.steps.0.input.host`) — the form the
 *  console's plan editor finds the field by. */
export function refusalPlace(document: string, path: string): string {
  const dotted = path.replace(/\[(\d+)\]/g, '.$1');
  return dotted === '' ? document : `${document}.${dotted}`;
}

function planPlace(path: string): string {
  return refusalPlace('plan', path);
}

/**
 * S11 GO5c: a plan written by `propose_goal` or `revise_goal` carries nothing a read of it masks —
 * no suspected credential in its call arguments ({@link planParamsAsRead}) or anywhere else in it
 * (`findSuspectedSecrets`, the document rule every read shows the rest with: an acceptance prompt,
 * a predicate's literal), and no `[redacted]` mark copied from a read (`redactedPathsIn`). A gate
 * authenticates with the credentials configured on it; a plan is read by people on the
 * confirmation card and in every revision after it, and is kept as written. So what a plan says
 * reads back as written, and an editor opened on a read of it (GO6) loses nothing. Run on the
 * plan's shape ({@link planShape}) before its other problems, so a credential anywhere is refused
 * the one way. Throws `RedactedTextSubmittedError` or {@link TextCarriesCredentialsError}: `field`
 * the first place, `paths` / `suspectedSecretPaths` every place ({@link planPlace}). A plan stored
 * before this check keeps reading masked.
 */
export function refusePlanCredentials(plan: GoalPlan): void {
  const place = planPlace;
  const redacted = redactedPathsIn(plan).map(place);
  if (redacted.length > 0) throw new RedactedTextSubmittedError(redacted[0] as string, redacted);
  const { found } = planParamsAsRead(plan);
  // The rest of the plan, its call arguments left out: the call-argument rule already counted
  // every value in them the document rule would (review #493 on #704: a schema literal under a
  // secret-named key was counted again as its `[redacted]` copy).
  const rest = findSuspectedSecrets(mapPlanParams(plan, <T>() => ({}) as T));
  const count = found.count + rest.count;
  if (count === 0) return;
  const refused = [...new Set([...found.paths, ...rest.paths].map(place))].slice(
    0,
    MAX_REFUSAL_PATHS,
  );
  throw new TextCarriesCredentialsError(refused[0] ?? 'plan', count, refused);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A part of a revision as sent ({@link reviewRevisedPlan}): what to keep, and what its writer
 *  wrote of it — the part the checks read. */
interface Reviewed<T> {
  readonly value: T;
  readonly written: T;
}

/** What a writer wrote of a call sent exactly as read: nothing the read showed differently from
 *  what is stored (`original`, the same shape) — each such value left out (`null`), the shape
 *  kept for the checks to read the plan by. What the read shows as stored stays: it is the same
 *  value, and the checks find nothing in it but a `[redacted]` mark stored before they ran. */
function writtenOfRead(shown: unknown, original: unknown): unknown {
  if (Array.isArray(shown) && Array.isArray(original)) {
    return shown.map((item, i) => writtenOfRead(item, original[i]));
  }
  if (isRecord(shown) && isRecord(original)) {
    // `fromEntries` defines own properties, so a `"__proto__"` key stays a field.
    return Object.fromEntries(
      Object.entries(shown).map(([key, inner]) => [key, writtenOfRead(inner, original[key])]),
    );
  }
  return isDeepStrictEqual(shown, original) ? shown : null;
}

/** One call of the plan sent against its read (`shown`) and what is stored (`original`) at the
 *  same place: sent exactly as read, it is the stored call; changed anywhere, or new, it is as
 *  sent — every value in it, a `[redacted]` left in it included. */
function reviewCall<T>(sent: T, shown: T | undefined, original: T | undefined): Reviewed<T> {
  if (shown === undefined || original === undefined || !isDeepStrictEqual(sent, shown)) {
    return { value: sent, written: sent };
  }
  return { value: original, written: writtenOfRead(shown, original) as T };
}

type Stored<T> = ReadonlyMap<string, { readonly original: T; readonly shown: T }>;

/** `originals` by key, each with its read (`shown`, in the same order). */
function byKey<T extends { readonly key: string }>(
  originals: readonly T[] | undefined,
  shown: readonly T[] | undefined,
): Stored<T> {
  return new Map(
    (originals ?? []).flatMap((original, i) => {
      const entry = shown?.[i];
      return entry === undefined ? [] : [[original.key, { original, shown: entry }] as const];
    }),
  );
}

/** Acceptance checks sent, each a call matched by key with the stored one. */
function reviewChecks<T extends { readonly key: string }>(
  sent: readonly T[],
  stored: Stored<T>,
): Reviewed<T[]> {
  const reviewed = sent.map((check) => {
    const match = stored.get(check.key);
    return reviewCall(check, match?.shown, match?.original);
  });
  return {
    value: reviewed.map((check) => check.value),
    written: reviewed.map((check) => check.written),
  };
}

/** A step sent against the stored step of its key: each of its calls on its own. */
function reviewStep(
  step: PlanStep,
  match: { readonly original: PlanStep; readonly shown: PlanStep } | undefined,
): Reviewed<PlanStep> {
  if (match === undefined) return { value: step, written: step };
  const { original, shown } = match;
  const value: Record<string, unknown> = { ...step };
  const written: Record<string, unknown> = { ...step };
  // Its Worker with its input: another Worker would get the stored input.
  if (step.input !== undefined && isDeepStrictEqual(step.worker, shown.worker)) {
    const input = reviewCall(step.input, shown.input, original.input);
    value.input = input.value;
    written.input = input.written;
  }
  // Each reconcile action and check by its place — kept only while the list is as long as read,
  // so a declaration taken out or added lines up none after it.
  if (
    step.reconcile !== undefined &&
    step.reconcile.length === shown.reconcile?.length &&
    step.reconcile.length === original.reconcile?.length
  ) {
    const declarations = step.reconcile.map((declaration, j) => {
      const action = reviewCall(
        declaration.action,
        shown.reconcile?.[j]?.action,
        original.reconcile?.[j]?.action,
      );
      const check = reviewCall(
        declaration.check,
        shown.reconcile?.[j]?.check,
        original.reconcile?.[j]?.check,
      );
      return {
        value: { ...declaration, action: action.value, check: check.value },
        written: { ...declaration, action: action.written, check: check.written },
      };
    });
    value.reconcile = declarations.map((declaration) => declaration.value);
    written.reconcile = declarations.map((declaration) => declaration.written);
  }
  // Its acceptance checks by key, as the plan's are.
  if (step.acceptance !== undefined) {
    const checks = reviewChecks(step.acceptance, byKey(original.acceptance, shown.acceptance));
    value.acceptance = checks.value;
    written.acceptance = checks.written;
  }
  // GO5d-1: its output schema and its bindings, each one call — free text a read spells out
  // differently (an invisible character in a property name or a path) stays as stored unless the
  // writer changed it.
  if (step.outputSchema !== undefined) {
    const schema = reviewCall(step.outputSchema, shown.outputSchema, original.outputSchema);
    value.outputSchema = schema.value;
    written.outputSchema = schema.written;
  }
  if (step.bindings !== undefined) {
    const bindings = reviewCall(step.bindings, shown.bindings, original.bindings);
    value.bindings = bindings.value;
    written.bindings = bindings.written;
  }
  return { value: value as PlanStep, written: written as PlanStep };
}

/**
 * S11 GO5c (decisions on #704; review #501 on #702 §2; review #493 on #704): a revision written in
 * an editor opened on a read of the plan holds what it did not touch as the read showed it
 * ({@link planAsRead}, the one definition `get_goal` reads a revision with: a credential masked,
 * an invisible character spelled out) — not what is stored, and not what
 * {@link refusePlanCredentials} passes. What is left as read keeps what is stored, call by call:
 *
 * - a step and one of the plan's own acceptance checks are matched by key with the entry of that
 *   key in `stored` (the revision it is based on);
 * - in it, each call — a step's Worker with its input, one reconcile action or check (by its place,
 *   only while the step's reconcile list is as long as read), one acceptance check (the step's by
 *   key too) — sent exactly as read is the stored call; changed anywhere, every value in it is as
 *   sent. The read shows every masked value as the same `[redacted]`, so a value given back on
 *   its own would follow a row or a declaration deleted or moved, or go to another host, gate or
 *   Worker; a `[redacted]` left in a changed call is refused at its place. A step's `outputSchema`
 *   and its `bindings` are each one call too (GO5d-1).
 *
 * Fields outside the calls (`dependsOn`, `nested`, `maxAttempts`) are as sent and decide nothing
 * here. Then {@link refusePlanCredentials} checks only what this writer wrote, at its place in the
 * submitted plan. Nothing stored is revealed, and nothing moves between keys. Returns the plan to
 * validate, compare with the revisions before it (`samePlanEntry`) and store. Only the requester
 * revises; were revisions written by others (a planner, an admin agent), this rule needs another
 * look — a stored value given back in a new context would carry it there.
 */
export function reviewRevisedPlan(submitted: GoalPlan, stored: GoalPlan): GoalPlan {
  const read = planAsRead(stored);
  const storedSteps = byKey(stored.steps, read.steps);
  const steps = submitted.steps.map((step) => reviewStep(step, storedSteps.get(step.key)));
  const acceptance =
    submitted.acceptance === undefined
      ? undefined
      : reviewChecks(submitted.acceptance, byKey(stored.acceptance, read.acceptance));
  refusePlanCredentials({
    steps: steps.map((step) => step.written),
    ...(acceptance !== undefined ? { acceptance: acceptance.written } : {}),
  });
  return {
    steps: steps.map((step) => step.value),
    ...(acceptance !== undefined ? { acceptance: acceptance.value } : {}),
  };
}

/** A dependency cycle as the keys along it (first key repeated at the end), or null. */
function findCycle(steps: readonly PlanStep[]): readonly string[] | null {
  const dependsOn = new Map(steps.map((step) => [step.key, step.dependsOn ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): readonly string[] | null => {
    const seen = state.get(key);
    if (seen === 'done') return null;
    if (seen === 'visiting') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'visiting');
    path.push(key);
    for (const next of dependsOn.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const step of steps) {
    const cycle = visit(step.key);
    if (cycle) return cycle;
  }
  return null;
}

/** {@link parsePlan}, then every step's worker must be a published `kind='worker'` version in the
 *  workspace — what `invoke_worker` would accept today. */
export async function validatePlan(
  client: PoolClient,
  workspaceId: string,
  plan: unknown,
): Promise<GoalPlan> {
  const parsed = parsePlan(plan);
  const problems: string[] = [];
  for (const step of parsed.steps) {
    const definition = await getWorkerDefinition(client, workspaceId, step.worker);
    const ref = `${step.worker.definitionId}@${step.worker.version}`;
    if (!definition) problems.push(`step "${step.key}": WorkerDefinition ${ref} does not exist`);
    else if (definition.kind !== 'worker') {
      problems.push(`step "${step.key}": WorkerDefinition ${ref} is ${definition.kind}-kind`);
    } else if (definition.status !== 'published') {
      problems.push(`step "${step.key}": WorkerDefinition ${ref} is ${definition.status}`);
    }
    for (const [index, declaration] of (step.reconcile ?? []).entries()) {
      const where = `step "${step.key}": reconcile[${index}]`;
      for (const problem of await reconcileReferenceProblems(client, workspaceId, declaration)) {
        problems.push(`${where}: ${problem}`);
      }
    }
    for (const [index, check] of (step.acceptance ?? []).entries()) {
      const where = `step "${step.key}": acceptance[${index}] "${check.key}"`;
      for (const problem of await acceptanceReferenceProblems(client, workspaceId, check)) {
        problems.push(`${where}: ${problem}`);
      }
    }
  }
  for (const [index, check] of (parsed.acceptance ?? []).entries()) {
    const where = `acceptance[${index}] "${check.key}"`;
    for (const problem of await acceptanceReferenceProblems(client, workspaceId, check)) {
      problems.push(`${where}: ${problem}`);
    }
  }
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  return parsed;
}

/** What an acceptance check refers to, as of now: an observation's what
 *  {@link observationCheckProblems} accepts; a fact check's Objects named by id exist in the
 *  workspace (one named by identity may be created by the goal's own work; a link type is not
 *  checked against the ontology here). */
async function acceptanceReferenceProblems(
  client: PoolClient,
  workspaceId: string,
  check: AcceptanceCheck | StepAcceptanceCheck,
): Promise<readonly string[]> {
  if (check.kind === 'requester_confirm') return [];
  if (check.kind === 'observe_predicate') {
    return (await observationCheckProblems(client, workspaceId, check.check)).map(
      (problem) => `check: ${problem}`,
    );
  }
  const problems: string[] = [];
  for (const [end, ref] of [
    ['source', check.fact.source],
    ['target', check.fact.target],
  ] as const) {
    if (!('objectId' in ref)) continue;
    if (!(await objectExists(client, workspaceId, ref))) {
      problems.push(`fact: the ${end} Object ${ref.objectId} does not exist in this workspace`);
    }
  }
  return problems;
}

async function objectExists(
  client: PoolClient,
  workspaceId: string,
  ref: Extract<FactObjectRef, { objectId: string }>,
): Promise<boolean> {
  const result = await client.query('select 1 from objects where workspace_id = $1 and id = $2', [
    workspaceId,
    ref.objectId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/** What a reconcile declaration refers to, as of now: its action a published execute-class
 *  Operation of a registered Gatekeeper; its check what {@link observationCheckProblems} accepts. */
async function reconcileReferenceProblems(
  client: PoolClient,
  workspaceId: string,
  declaration: StepReconcile,
): Promise<readonly string[]> {
  const problems: string[] = [];
  const { action, check } = declaration;
  const actionGate = await getGatekeeper(client, workspaceId, action.gatekeeperId);
  const actionOperation = actionGate
    ? await getPublishedOperation(client, workspaceId, action.gatekeeperId, action.operation)
    : null;
  if (!actionGate) {
    problems.push(`action: Gatekeeper ${action.gatekeeperId} is not enabled in this workspace`);
  } else if (!actionOperation) {
    problems.push(`action: "${action.operation}" is not a published Operation of its Gatekeeper`);
  } else if (actionOperation.operation.mode !== 'execute') {
    problems.push(`action: "${action.operation}" is ${actionOperation.operation.mode}-class`);
  }

  for (const problem of await observationCheckProblems(client, workspaceId, check)) {
    problems.push(`check: ${problem}`);
  }
  return problems;
}

/** What an observation the platform makes for the requester — a reconcile check, an acceptance
 *  check — refers to, as of now: what `observe_operation` would let anyone in the workspace call
 *  (`observeRefusal` without a member's own exclusions — the requester's are applied when the
 *  observation is made, `platform-observation.ts`), with params the credential review lets
 *  through. */
async function observationCheckProblems(
  client: PoolClient,
  workspaceId: string,
  check: ObservationCheck,
): Promise<readonly string[]> {
  const gatekeeper = await getGatekeeper(client, workspaceId, check.gatekeeperId);
  const published = await getPublishedOperation(
    client,
    workspaceId,
    check.gatekeeperId,
    check.operation,
  );
  const refusal = observeRefusal(NO_OBSERVE_EXCLUSIONS, {
    gatekeeperId: check.gatekeeperId,
    gateEnabled: gatekeeper !== null,
    operationName: check.operation,
    publishedMode: published?.operation.mode,
    platformPolicy: await readGatekeeperPlatformPolicy(client, workspaceId, check.gatekeeperId),
  });
  if (refusal) return [`"${check.operation}" cannot be observed (${refusal.reason})`];
  if (gatekeeper) {
    try {
      reviewObserveParams(gatekeeper.name, check.operation, check.params ?? {});
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
  }
  return [];
}

/** The plan entry with `key`, read from a stored plan (`plan_revisions.plan`) — `null` when the
 *  plan has no such step or the entry is not a valid step. */
export function planStep(plan: unknown, key: string): PlanStep | null {
  const entry = rawPlanEntry(plan, key);
  if (entry === undefined) return null;
  const parsed = PlanStepSchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

function rawPlanEntry(plan: unknown, key: string): unknown {
  if (!plan || typeof plan !== 'object') return undefined;
  const steps = (plan as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return undefined;
  return steps.find(
    (step) => step && typeof step === 'object' && (step as { key?: unknown }).key === key,
  );
}

/** Whether `key`'s entry is the same in both plans — the whole entry, compared as JSON values, as
 *  the I-G2 monitor compares them (`goal-invariant-checks.ts`: equality, not containment). The
 *  advancer re-checks this before it marks a step ready (a StepRun's definition is its entry in the
 *  revision that introduced it; if the current plan dropped or changed it, the step is not part of
 *  the current plan, whatever its row says). */
export function samePlanEntry(introducedIn: unknown, current: unknown, key: string): boolean {
  const before = rawPlanEntry(introducedIn, key);
  const now = rawPlanEntry(current, key);
  return before !== undefined && now !== undefined && isDeepStrictEqual(before, now);
}
