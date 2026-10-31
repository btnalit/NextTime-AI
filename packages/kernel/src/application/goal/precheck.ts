import { canonicalJson } from '@nexttime/gatekeeper-base';
import type { GoalPlan, PlanHint, PlanStep } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { connectedAccountPresence } from '../gateway/credential-presence.js';
import {
  type StepAttemptRefusal,
  resolveStepAuthority,
  workerSpecComponentRefusals,
} from '../task/index.js';

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
 *
 * S11 GO8a: a step's WorkerSpec is checked the way its first attempt's admission checks it — its
 * gates and capabilities as the requester's authority (`resolveStepAuthority` with the WorkerSpec),
 * then its components (`workerSpecComponentRefusals`): a draft Skill it names (the step would wait
 * for a person's approval), a deprecated one or a model the workspace does not allow (refused), one
 * hint each. A Skill that is not there is not a hint: the plan no longer validates.
 *
 * Legacy 513: a read served to a person (`checkAccounts`) also asks each gate a step that would
 * start declares whether the requester has connected their own account there
 * (`application/gateway/credential-presence.ts`): on a `connected_account` gate without one, the
 * step would start and the gate would refuse its calls (`credential_unavailable`), which no
 * approval can change. Never in a result an agent or a Handle receives.
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
  if (refusal.kind === 'admission') {
    if (refusal.reason === 'skill_draft') {
      return {
        code: 'step_skill_draft',
        message: `step "${key}": ${refusal.detail} — the step would not start until a person approves, and the goal would pause there`,
        stepKey: key,
        skillRefs: [...(refusal.skillRefs ?? [])],
      };
    }
    if (refusal.reason === 'skill_deprecated') {
      return {
        code: 'step_skill_deprecated',
        message: `step "${key}": ${refusal.detail} — ${consequence}`,
        stepKey: key,
        skillRefs: [...(refusal.skillRefs ?? [])],
      };
    }
    return {
      code: 'step_model_not_allowed',
      message: `step "${key}": ${refusal.detail} — ${consequence}`,
      stepKey: key,
      ...(refusal.model !== undefined ? { model: refusal.model } : {}),
    };
  }
  // A WorkerDefinition no longer published, or a Skill a WorkerSpec names that is not there: the
  // plan no longer validates — confirming and revising refuse it with the problem named
  // (`validatePlan`), so it is not a hint.
  return null;
}

/** What one step is checked as: its Worker version, whether it is nested, its WorkerSpec. */
function checkKey(step: PlanStep): string {
  return `${step.worker.definitionId}@${step.worker.version}:${step.nested === true}:${canonicalJson(step.spec ?? null)}`;
}

/** What a step's check found: the gates an attempt would start on, or why it would not. */
type StepCheck =
  | { readonly kind: 'starts'; readonly gatekeeperIds: readonly string[] }
  | { readonly kind: 'refused'; readonly refusals: readonly StepAttemptRefusal[] };

export interface PlanAuthorityHintOptions {
  /** Legacy 513: also ask the gates about the requester's own accounts — only on a read served to
   *  a person (`servesPerson`). */
  readonly checkAccounts?: boolean;
}

/**
 * What the requester's authority would stop now, step by step (the module comment): at most one
 * `requester_cannot_start_workers` hint when they cannot start Workers at all, else one hint per
 * step that would not start (one per reason of its WorkerSpec's admission) — and, with
 * `checkAccounts`, one per step that would start on a gate where the requester has not connected
 * their account. Steps pinned to the same Worker version with the same WorkerSpec are checked
 * once. `plan`'s steps are the ones checked (`views.ts` passes a paused run's steps that have not
 * started).
 */
export async function planAuthorityHints(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  plan: GoalPlan,
  options: PlanAuthorityHintOptions = {},
): Promise<readonly PlanHint[]> {
  const hints: PlanHint[] = [];
  const startingGates: { readonly stepKey: string; readonly gatekeeperIds: readonly string[] }[] =
    [];
  const seen = new Map<string, StepCheck>();
  for (const step of plan.steps) {
    const key = checkKey(step);
    let checked = seen.get(key);
    if (checked === undefined) {
      checked = await checkStep(client, workspaceId, requesterId, step);
      seen.set(key, checked);
    }
    if (checked.kind === 'starts') {
      if (checked.gatekeeperIds.length > 0) {
        startingGates.push({ stepKey: step.key, gatekeeperIds: checked.gatekeeperIds });
      }
      continue;
    }
    for (const refusal of checked.refusals) {
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
  }
  if (options.checkAccounts && startingGates.length > 0) {
    const presence = await connectedAccountPresence(
      client,
      workspaceId,
      requesterId,
      startingGates.flatMap((entry) => entry.gatekeeperIds),
    );
    for (const entry of startingGates) {
      const missing = entry.gatekeeperIds.filter((id) => presence.get(id) === 'not_connected');
      if (missing.length === 0) continue;
      hints.push({
        code: 'step_account_not_connected',
        message: `step "${entry.stepKey}": the requester has not connected their own account on gate(s) ${missing.join(', ')} — the gate would refuse any call the step makes there (credential_unavailable)`,
        stepKey: entry.stepKey,
        gatekeeperIds: missing,
      });
    }
  }
  return hints;
}

/** One step as its first attempt would be admitted now: the requester's authority over what it
 *  declares (with its WorkerSpec), then its WorkerSpec's components. */
async function checkStep(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  step: PlanStep,
): Promise<StepCheck> {
  const spec = step.spec ?? null;
  const authority = await resolveStepAuthority(
    client,
    workspaceId,
    requesterId,
    step.worker,
    step.nested === true,
    spec,
  );
  if (authority.kind === 'refused') return { kind: 'refused', refusals: [authority.refusal] };
  const refusals = await workerSpecComponentRefusals(client, workspaceId, authority.parent, spec);
  return refusals.length > 0
    ? { kind: 'refused', refusals }
    : { kind: 'starts', gatekeeperIds: authority.declaredGates };
}
