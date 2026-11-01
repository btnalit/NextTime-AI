import { canonicalJson } from '@nexttime/gatekeeper-base';
import type {
  GoalPlan,
  PlanStep,
  PlannerRevisionClass,
  PlannerRevisionClassReasonWire,
  PlannerRevisionMajorReason,
  StepRunStatus,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { listStepActionOutcomes } from '../../governance/approval/index.js';
import { isExecuteClassCapability } from '../../governance/capability/index.js';
import { listGoalRunLiveTaskSteps, resolveStepAuthority } from '../task/index.js';
import { stepActionEffect } from './disposition.js';
import { planAuthorityHints } from './precheck.js';
import { listStepRuns } from './reads.js';
import type { GoalRunRow } from './types.js';

/**
 * application/goal/revision-class (S11 GO9b; plan §4.3, I-P3): how much of the requester's
 * judgement a revision the goal planner proposed needs. The platform's own rule over the plan in
 * force and the one proposed — never what the planner says about it. Only a `minor` revision of an
 * `autonomous` round (the run kept running under the requester's `apply_minor` leave) is accepted
 * by the platform for them (`planner.ts`); a `major` one pauses the run for them to decide, and a
 * round under a pause only proposes whatever its class.
 *
 * `major` when any of these holds, one reason each (`@nexttime/shared`
 * `PlannerRevisionMajorReason`):
 *   - `goal_acceptance_changed`: the plan's `acceptance` is not exactly what it was — what "done"
 *     means is the requester's (even a check added there is theirs to agree to);
 *   - `step_acceptance_changed`: a step of the plan in force that has not ended is changed or
 *     removed, and one of its acceptance checks is no longer declared, unchanged, by any step of the
 *     proposed plan that will still run. A check moved to a new step, or a new check added, needs
 *     nobody: what had to hold still has to;
 *   - `execution_step`: a step the revision adds or changes can act — it declares `nested`
 *     (Workers of its own), `reconcile` checks (it raises actions), or its Worker would hold an
 *     execute-class capability with the requester's authority (`resolveStepAuthority`,
 *     `isExecuteClassCapability`: `request_action`, a gate's execute Operations);
 *   - `admission_blocked`: a step it adds or changes would not start without a person
 *     (`planAuthorityHints`: a gate or capability the requester lacks, an excluded or unavailable
 *     Worker, a draft or deprecated Skill, a model not allowed), or the requester cannot start
 *     Workers at all;
 *   - `stops_live_work`: a step it changes or removes still has a Task running or an action in
 *     flight — adopting it would stop that work;
 *   - `unresolvable`: what a step it adds or changes would be able to do could not be worked out.
 * Otherwise `minor`: a different Worker, input, order or retry limit for work that only reads,
 * thinks and reports, on checks that still hold. The budget never changes with a planner's
 * revision (its output has none).
 *
 * {@link classifyPlannerRevision} is the rule, pure; {@link plannerRevisionFacts} reads what it
 * needs about the run and the proposed steps.
 */

/** What a step the revision adds or changes would be able to do. */
export type StepAbility =
  | {
      readonly kind: 'resolved';
      /** Its Worker would hold an execute-class capability. */
      readonly executes: boolean;
      /** It would not start without a person. */
      readonly blocked: boolean;
    }
  | { readonly kind: 'unresolved' };

/** A step of the plan in force, as its live StepRun stands. */
export interface RunningStepFacts {
  readonly ended: boolean;
  /** A Task of it still runs, or an action of it is in flight or awaits a reconcile. */
  readonly liveWork: boolean;
}

export interface ClassifyPlannerRevisionInput {
  readonly base: GoalPlan;
  readonly candidate: GoalPlan;
  /** By key, the steps of the plan in force (a key with no entry: not started, not ended). */
  readonly running: ReadonlyMap<string, RunningStepFacts>;
  /** By key, every step the revision adds or changes (a key with no entry: unresolvable). */
  readonly abilities: ReadonlyMap<string, StepAbility>;
  /** The requester cannot start Workers at all now. */
  readonly requesterBlocked?: boolean;
}

export interface PlannerRevisionClassification {
  readonly revisionClass: PlannerRevisionClass;
  readonly reasons: readonly PlannerRevisionClassReasonWire[];
}

/** The keys of `candidate`'s steps that `base` does not hold exactly so: added or changed. */
export function changedStepKeys(base: GoalPlan, candidate: GoalPlan): readonly string[] {
  const before = new Map(base.steps.map((step) => [step.key, canonicalJson(step)]));
  return candidate.steps
    .filter((step) => before.get(step.key) !== canonicalJson(step))
    .map((step) => step.key);
}

function checkBody(check: { readonly key: string }): string {
  const { key: _key, ...body } = check;
  return canonicalJson(body);
}

/** The rule — see the module comment. */
export function classifyPlannerRevision(
  input: ClassifyPlannerRevisionInput,
): PlannerRevisionClassification {
  const { base, candidate, running, abilities } = input;
  const reasons: PlannerRevisionClassReasonWire[] = [];
  const seen = new Set<string>();
  const add = (code: PlannerRevisionMajorReason, stepKey: string | null) => {
    const id = `${code}\u0000${stepKey ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    reasons.push({ code, stepKey });
  };

  if (canonicalJson(base.acceptance ?? null) !== canonicalJson(candidate.acceptance ?? null)) {
    add('goal_acceptance_changed', null);
  }

  const proposedByKey = new Map(candidate.steps.map((step) => [step.key, step]));
  const changed = new Set(changedStepKeys(base, candidate));
  const ended = (key: string) => running.get(key)?.ended === true;

  // The acceptance checks that will still be made: those of every proposed step that has yet to
  // run or finish — not a kept step that already ended (it never runs again).
  const stillChecked = new Set<string>();
  for (const step of candidate.steps) {
    if (!changed.has(step.key) && ended(step.key)) continue;
    for (const check of step.acceptance ?? []) stillChecked.add(checkBody(check));
  }

  for (const step of base.steps) {
    const proposed = proposedByKey.get(step.key);
    const touched = proposed === undefined || changed.has(step.key);
    if (!touched) continue;
    if (running.get(step.key)?.liveWork === true) add('stops_live_work', step.key);
    if (ended(step.key)) continue;
    if ((step.acceptance ?? []).some((check) => !stillChecked.has(checkBody(check)))) {
      add('step_acceptance_changed', step.key);
    }
  }

  for (const step of candidate.steps) {
    if (!changed.has(step.key)) continue;
    if (step.nested === true || (step.reconcile ?? []).length > 0) add('execution_step', step.key);
    const ability = abilities.get(step.key);
    if (!ability || ability.kind === 'unresolved') {
      add('unresolvable', step.key);
      continue;
    }
    if (ability.executes) add('execution_step', step.key);
    if (ability.blocked) add('admission_blocked', step.key);
  }
  if (input.requesterBlocked === true && changed.size > 0) add('admission_blocked', null);

  return { revisionClass: reasons.length > 0 ? 'major' : 'minor', reasons };
}

const ENDED: ReadonlySet<StepRunStatus> = new Set(['succeeded', 'skipped', 'cancelled']);

/**
 * What {@link classifyPlannerRevision} needs about `goal` (as read under its lock) and the plan
 * the planner proposed, read now: the live StepRuns of the plan in force — ended, and whether work
 * of each still runs — and, for every step the revision adds or changes, what its Worker could do
 * with the requester's authority and whether it would start without a person. Reads only.
 */
export async function plannerRevisionFacts(
  client: PoolClient,
  workspaceId: string,
  goal: GoalRunRow,
  base: GoalPlan,
  candidate: GoalPlan,
): Promise<Omit<ClassifyPlannerRevisionInput, 'base' | 'candidate'>> {
  const steps = (await listStepRuns(client, workspaceId, goal.id)).filter(
    (step) => step.status !== 'superseded',
  );
  const liveTasks = await listGoalRunLiveTaskSteps(client, workspaceId, goal.id);
  const running = new Map<string, RunningStepFacts>();
  for (const step of steps) {
    const tasks = liveTasks.some((task) => task.stepRunId === step.id);
    const effect = tasks
      ? null
      : stepActionEffect(await listStepActionOutcomes(client, workspaceId, step.id));
    running.set(step.stepKey, {
      ended: ENDED.has(step.status),
      liveWork: tasks || effect?.kind === 'wait',
    });
  }

  const changed = new Set(changedStepKeys(base, candidate));
  const touched: PlanStep[] = candidate.steps.filter((step) => changed.has(step.key));
  const abilities = new Map<string, StepAbility>();
  if (touched.length === 0) return { running, abilities };
  const hints = await planAuthorityHints(client, workspaceId, goal.onBehalfOf, {
    ...candidate,
    steps: touched,
  });
  const requesterBlocked = hints.some((hint) => hint.code === 'requester_cannot_start_workers');
  for (const step of touched) {
    const blocked = hints.some((hint) => hint.stepKey === step.key);
    const authority = await resolveStepAuthority(
      client,
      workspaceId,
      goal.onBehalfOf,
      step.worker,
      step.nested === true,
      step.spec ?? null,
    );
    if (authority.kind === 'refused') {
      // It would not start as it stands: a person's to decide. Whether it would act is not known.
      abilities.set(step.key, { kind: 'resolved', executes: false, blocked: true });
      continue;
    }
    abilities.set(step.key, {
      kind: 'resolved',
      executes: authority.childScope.capabilities.some(isExecuteClassCapability),
      blocked,
    });
  }
  return { running, abilities, requesterBlocked };
}
