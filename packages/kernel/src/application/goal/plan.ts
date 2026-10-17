import { isDeepStrictEqual } from 'node:util';
import { ObservationCheckSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getGatekeeper, getPublishedOperation } from '../../governance/gatekeepers/index.js';
import { reviewObserveParams } from '../../governance/redaction/index.js';
import { lintPredicate } from '../../substrate/epistemic/index.js';
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
 *     action identity.
 * Unknown fields are refused rather than ignored: a field this version does not act on (an
 * acceptance check before GO4, an output schema) must not look like it is in force.
 *
 * `validatePlan` checks what a plan refers to as of now — keys unique, dependencies known and
 * acyclic, every worker a published worker-kind version; every reconcile declaration's action a
 * published execute-class Operation and its check a published observe-class one the platform does
 * not cut off, with params that carry no credential and a predicate the lint accepts
 * (`substrate/epistemic`'s `lintPredicate`: one that would pass without the observation showing the
 * target is refused here, before any person is asked to confirm it). A version deprecated later is
 * caught when an attempt would start (the advancer's snapshot check), not here; a reconcile check
 * the requester can no longer make is caught when it runs.
 */

export const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_PLAN_STEPS = 50;
export const MAX_STEP_ATTEMPTS = 5;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** The serialized plan, inputs included — a plan is reviewed by a person on a confirmation card. */
export const MAX_PLAN_BYTES = 256 * 1024;
/** Reconcile declarations one step carries at most. */
export const MAX_STEP_RECONCILE_DECLARATIONS = 8;

const stepKey = z.string().regex(STEP_KEY_PATTERN);

/** S11 GO3d: how the platform reconciles one action of the step — see the module comment. */
export const StepReconcileSchema = z
  .object({
    action: z
      .object({
        gatekeeperId: z.string().uuid(),
        operation: z.string().min(1).max(200),
        params: z.record(z.unknown()).optional(),
      })
      .strict(),
    check: ObservationCheckSchema,
  })
  .strict();

export type StepReconcile = z.infer<typeof StepReconcileSchema>;

export const PlanStepSchema = z
  .object({
    key: stepKey,
    worker: z
      .object({
        definitionId: z.string().uuid(),
        version: z.number().int().positive(),
      })
      .strict(),
    input: z.unknown().optional(),
    dependsOn: z.array(stepKey).max(MAX_PLAN_STEPS).optional(),
    nested: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(MAX_STEP_ATTEMPTS).optional(),
    reconcile: z.array(StepReconcileSchema).min(1).max(MAX_STEP_RECONCILE_DECLARATIONS).optional(),
  })
  .strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const GoalPlanSchema = z
  .object({ steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS) })
  .strict();

export type GoalPlan = z.infer<typeof GoalPlanSchema>;

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
  for (const step of parsed.data.steps) problems.push(...reconcileShapeProblems(step));
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  return parsed.data;
}

/** A step's reconcile declarations: one per action identity, each predicate accepted by the lint. */
function reconcileShapeProblems(step: PlanStep): readonly string[] {
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
    for (const problem of lintPredicate(declaration.check.expect)) {
      problems.push(`${where}: ${problem}`);
    }
  });
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
  }
  if (problems.length > 0) throw new GoalPlanValidationError(problems);
  return parsed;
}

/** What a reconcile declaration refers to, as of now: its action a published execute-class
 *  Operation of a registered Gatekeeper; its check what `observe_operation` would let anyone in the
 *  workspace call (`observeRefusal` without a member's own exclusions — the requester's are applied
 *  when the check runs), with params the credential review lets through. */
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
  if (refusal) {
    problems.push(`check: "${check.operation}" cannot be observed (${refusal.reason})`);
  } else if (gatekeeper) {
    try {
      reviewObserveParams(gatekeeper.name, check.operation, check.params ?? {});
    } catch (err) {
      problems.push(`check: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
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
