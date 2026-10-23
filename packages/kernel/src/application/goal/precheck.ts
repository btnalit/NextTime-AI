import type { GoalPlan, PlanHint } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { type StepAttemptRefusal, resolveStepAuthority } from '../task/index.js';

/**
 * application/goal/precheck (S11 GO5c; plan §4.3, §4.4, I-G7; input from GO2 and review #493): the
 * confirmation card's check of the requester's authority. A step's attempt starts only with what
 * the requester may do at that moment (`resolveStepAuthority`, the one definition the advancer
 * applies — `application/task/step-attempt.ts`): a step whose Worker declares a gate they cannot
 * act on, an execute-class capability they do not hold, or a Worker their AgentProfile excludes
 * would not start, and the goal would pause for a person (`authority_lost` / `needs_decision`) the
 * moment it reached that step. {@link planAuthorityHints} says so before anyone confirms.
 *
 * Hints, not refusals: authority is a state of the world, not of the plan — an owner can grant the
 * gate before the step is reached, and nothing about the proposal is wrong. So it is worked out
 * whenever it is read (`propose_goal`'s and `revise_goal`'s results, and the proposal of a run still
 * `proposed`, `views.ts`) and never stored with the revision. Confirming does not re-check it: the
 * run pauses at that step instead (the advancer's check, unchanged).
 */

const consequence = 'the step would not start, and the goal would pause there for a person';

function stepHint(key: string, refusal: StepAttemptRefusal): PlanHint | null {
  if (refusal.kind === 'authority_lost') {
    if (refusal.reason === 'gates') {
      return {
        code: 'step_gate_not_held',
        message: `step "${key}": its Worker acts on gate(s) the requester cannot act on now — ${consequence}`,
        stepKey: key,
        gatekeeperIds: [...(refusal.gatekeeperIds ?? [])],
      };
    }
    if (refusal.reason === 'capability') {
      return {
        code: 'step_capability_not_held',
        message: `step "${key}": ${refusal.detail} — ${consequence}`,
        stepKey: key,
        capabilityNames: [...(refusal.capabilityNames ?? [])],
      };
    }
    return null;
  }
  if (refusal.kind === 'unavailable' && refusal.reason === 'excluded') {
    return {
      code: 'step_definition_excluded',
      message: `step "${key}": the requester's agent profile excludes its Worker — ${consequence}`,
      stepKey: key,
    };
  }
  // A WorkerDefinition no longer published: the plan no longer validates — confirming and revising
  // refuse it with the problem named (`validatePlan`), so it is not a hint.
  return null;
}

/**
 * What the requester's authority would stop now, step by step (the module comment): at most one
 * `requester_cannot_start_workers` hint when they cannot start Workers at all, else one hint per
 * step that would not start. Steps pinned to the same Worker version are checked once.
 */
export async function planAuthorityHints(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  plan: GoalPlan,
): Promise<readonly PlanHint[]> {
  const hints: PlanHint[] = [];
  const seen = new Map<string, StepAttemptRefusal | null>();
  for (const step of plan.steps) {
    const nested = step.nested === true;
    const key = `${step.worker.definitionId}@${step.worker.version}:${nested}`;
    let refusal = seen.get(key);
    if (refusal === undefined) {
      const authority = await resolveStepAuthority(
        client,
        workspaceId,
        requesterId,
        step.worker,
        nested,
      );
      refusal = authority.kind === 'ok' ? null : authority.refusal;
      seen.set(key, refusal);
    }
    if (refusal === null) continue;
    if (refusal.kind === 'authority_lost' && refusal.reason === 'requester') {
      return [
        {
          code: 'requester_cannot_start_workers',
          message: `${refusal.detail}: no step of this plan can start`,
        },
      ];
    }
    const hint = stepHint(step.key, refusal);
    if (hint) hints.push(hint);
  }
  return hints;
}
