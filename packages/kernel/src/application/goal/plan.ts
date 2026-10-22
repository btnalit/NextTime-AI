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
  type StepReconcile,
  StepReconcileSchema,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { getGatekeeper, getPublishedOperation } from '../../governance/gatekeepers/index.js';
import { findSuspectedSecrets, reviewObserveParams } from '../../governance/redaction/index.js';
import {
  PREDICATE_LINT_PLAN_WORK,
  type PredicateLintBudget,
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
 *   - `input` — passed to the Worker as the Task's input, as is (bindings from upstream outputs
 *     come with step outputs, GO5);
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
 *     entry, so a revision that does redefines the step (I-G2), like any other change to it.
 * Unknown fields are refused rather than ignored: a field this version does not act on (an output
 * schema) must not look like it is in force.
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
 *     check the platform makes passed. At most one.
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

/** Parses `plan` and checks its shape and graph — no database. Throws
 *  {@link GoalPlanValidationError} naming every problem found. */
export function parsePlan(plan: unknown): GoalPlan {
  const parsed = GoalPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new GoalPlanValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'plan'}: ${issue.message}`),
    );
  }
  const problems: string[] = [];
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > MAX_PLAN_BYTES) {
    problems.push(`the plan is larger than ${MAX_PLAN_BYTES} bytes`);
  }
  const keys = new Set<string>();
  for (const step of parsed.data.steps) {
    if (keys.has(step.key)) problems.push(`step key "${step.key}" appears more than once`);
    keys.add(step.key);
  }
  for (const step of parsed.data.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.key) problems.push(`step "${step.key}" depends on itself`);
      else if (!keys.has(dependency)) {
        problems.push(`step "${step.key}" depends on "${dependency}", which is not in the plan`);
      }
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(parsed.data.steps);
    if (cycle) problems.push(`the dependencies form a cycle: ${cycle.join(' -> ')}`);
  }
  const lintBudget: PredicateLintBudget = { remaining: PREDICATE_LINT_PLAN_WORK };
  for (const step of parsed.data.steps) {
    problems.push(...reconcileShapeProblems(step, lintBudget));
    problems.push(
      ...acceptanceShapeProblems(step.acceptance ?? [], lintBudget, `step "${step.key}": `),
    );
  }
  problems.push(...acceptanceShapeProblems(parsed.data.acceptance ?? [], lintBudget, ''));
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  return parsed.data;
}

/** The acceptance checks of the plan, or of one step (`prefix` names it): keys unique, at most one
 *  `requester_confirm`, every predicate — an observation's, a fact check's — accepted by the lint
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
