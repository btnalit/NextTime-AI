import { canonicalJson } from '@nexttime/gatekeeper-base';
import type { GoalPlan, PlanHint, PlanStep } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { connectedAccountPresence } from '../gateway/credential-presence.js';
import {
  type RunConfigSnapshot,
  type StepAttemptRefusal,
  type StepTrialApprovalCandidate,
  previousAttemptSkillsRefusal,
  resolveStepAuthority,
  trialDraftsMatch,
  workerSpecComponentRefusals,
  workerSpecDigest,
  workerSpecModelRefusal,
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
 * for a person's approval), a deprecated one, or a model the workspace does not allow or — with a
 * `modelCatalog`, a read of a proposal or of a paused run — the llm-proxy catalog no longer offers
 * (refused; confirming the proposal would fail its validation), one hint each. A Skill that is not
 * there is not a hint: the plan no longer validates. A step of a paused run waiting to be tried
 * again (`retried`) is checked the way a later attempt is: its authority and its model, and the
 * Skills it would mount again — the ones its last attempt mounted (`previousAttempts`, that
 * attempt's snapshot), not the ones its WorkerSpec names.
 *
 * Legacy 544: a step whose WorkerDefinition version is no longer published (deprecated, or not
 * there) is hinted too (`step_worker_unavailable`) — the plan no longer validates, so a proposal's
 * confirmation would be refused, and a paused run's step would not start — and so is a retried
 * step whose pinned Skill versions can no longer be mounted (`step_skill_version_unavailable`,
 * named 「name v<version>」): the pause and the card say which step, and why.
 *
 * S11 GO8b: a step that would wait for a person's approval of its draft Skills says what one trial
 * of it would mount (`trial`: its WorkerSpec digest and each draft, its content digest) — what
 * `approve_step_trial` approves. A step with no single trial to approve (a reference naming more
 * than one draft, two drafts of one name, a draft named like a published Skill) says why instead.
 * A step whose trial a person approved (`trialApprovals`) and still is what it was approved for
 * is not hinted: its first attempt starts with that approval.
 *
 * Legacy 513: a read served to a person (`checkAccounts`) also asks each gate a step that would
 * start declares whether the requester has connected their own account there
 * (`application/gateway/credential-presence.ts`): on a `connected_account` gate without one, the
 * step would start and the gate would refuse its calls (`credential_unavailable`), which no
 * approval can change. Never in a result an agent or a Handle receives.
 */

const consequence = 'the step would not start, and the goal would pause there for a person';

function stepHint(step: PlanStep, refusal: StepAttemptRefusal): PlanHint | null {
  const key = step.key;
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
  if (refusal.kind === 'unavailable' && refusal.reason === 'definition') {
    return {
      code: 'step_worker_unavailable',
      message: `step "${key}": ${refusal.detail} — ${consequence}; a plan naming it is refused when confirmed or revised, so it names another Worker or drops the step`,
      stepKey: key,
    };
  }
  if (refusal.kind === 'unavailable' && refusal.reason === 'skills') {
    return {
      code: 'step_skill_version_unavailable',
      message: `step "${key}": ${refusal.detail}, which trying it again would mount — ${consequence}; revising the plan starts the step afresh`,
      stepKey: key,
      skillRefs: [...(refusal.skillRefs ?? [])],
    };
  }
  if (refusal.kind === 'admission') {
    if (refusal.reason === 'skill_draft') {
      const trial = refusal.trial;
      const specDigest = workerSpecDigest(step.spec ?? null);
      return {
        code: 'step_skill_draft',
        message:
          trial?.kind === 'none'
            ? `step "${key}": ${refusal.detail} — ${trial.detail}, so no trial of it can be approved; the step would not start, and the goal would pause there`
            : `step "${key}": ${refusal.detail} — the step would not start until a person approves, and the goal would pause there`,
        stepKey: key,
        skillRefs: [...(refusal.skillRefs ?? [])],
        ...(trial?.kind === 'drafts' && specDigest !== null
          ? {
              trial: {
                specDigest,
                drafts: trial.drafts.map((draft) => ({
                  skillId: draft.skillId,
                  version: draft.version,
                  name: draft.name,
                  draftDigest: draft.draftDigest,
                  proposedBy: draft.proposedBy,
                })),
              },
            }
          : {}),
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
      code:
        refusal.reason === 'model_not_offered'
          ? 'step_model_not_offered'
          : 'step_model_not_allowed',
      message: `step "${key}": ${refusal.detail} — ${consequence}`,
      stepKey: key,
      ...(refusal.model !== undefined ? { model: refusal.model } : {}),
    };
  }
  // A Skill a WorkerSpec names that is not there: the plan no longer validates — confirming and
  // revising refuse it with the problem named (`validatePlan`), so it is not a hint.
  return null;
}

/** What one step is checked as: as a first or a later attempt, its Worker version, whether it is
 *  nested, its WorkerSpec. */
function checkKey(step: PlanStep, retried: boolean): string {
  return `${retried ? 'later' : 'first'}:${step.worker.definitionId}@${step.worker.version}:${step.nested === true}:${canonicalJson(step.spec ?? null)}`;
}

/** What a step's check found: the gates an attempt would start on, or why it would not (with the
 *  gates it would start on when only its WorkerSpec's components stop it — GO8b: a trial approved
 *  lifts the draft refusal). */
type StepCheck =
  | { readonly kind: 'starts'; readonly gatekeeperIds: readonly string[] }
  | {
      readonly kind: 'refused';
      readonly refusals: readonly StepAttemptRefusal[];
      readonly gatekeeperIds: readonly string[];
    };

/** Whether `refusal` is a step's draft Skills waiting for a person, and one of `approvals` is for
 *  the trial it would mount now — `createStepAttemptTask` starts the attempt with that approval. */
function approvedTrial(
  refusal: StepAttemptRefusal,
  approvals: readonly StepTrialApprovalCandidate[],
): boolean {
  if (refusal.kind !== 'admission' || refusal.reason !== 'skill_draft') return false;
  const current = refusal.trial;
  return (
    current?.kind === 'drafts' &&
    approvals.some((approval) => trialDraftsMatch(approval.drafts, current.drafts))
  );
}

export interface PlanAuthorityHintOptions {
  /** Legacy 513: also ask the gates about the requester's own accounts — only on a read served to
   *  a person (`servesPerson`). */
  readonly checkAccounts?: boolean;
  /** S11 GO8a: the keys of `plan`'s steps whose next attempt is a later one — checked as that
   *  attempt is admitted (the module comment). */
  readonly retried?: ReadonlySet<string>;
  /** S11 GO8a: the llm-proxy catalog a WorkerSpec's model is checked against — read once, only
   *  when a step checked sets a model; `null` from it (unreadable) or absent: not checked. A plan
   *  is validated against it when proposed, confirmed or revised (`validatePlan`), so only a read
   *  passes it — of a proposal (confirming it would be refused, UX on #853) or of a paused run —
   *  for a catalog that changed since. */
  readonly modelCatalog?: () => Promise<ReadonlySet<string> | null>;
  /** S11 GO8b: by step key, the approvals of a trial its first attempt would start with
   *  (`trialApprovalsFor`) — the module comment. */
  readonly trialApprovals?: ReadonlyMap<string, readonly StepTrialApprovalCandidate[]>;
  /** Legacy 544: by the key of a `retried` step, its last attempt's snapshot — the Skills a later
   *  attempt would mount again (`previousAttemptSkillsRefusal`). A retried step without one is
   *  not checked for its Skills (the advancer pauses it for its unreadable snapshot). */
  readonly previousAttempts?: ReadonlyMap<string, RunConfigSnapshot>;
  /** Legacy 544: by Skill id, the names the drafts of the run's approved trials had — a discarded
   *  draft's rows are gone, and a retry's hint still names it. */
  readonly knownSkillNames?: ReadonlyMap<string, string>;
}

/**
 * What the requester's authority would stop now, step by step (the module comment): at most one
 * `requester_cannot_start_workers` hint when they cannot start Workers at all, else one hint per
 * step that would not start (one per reason of its WorkerSpec's admission) — and, with
 * `checkAccounts`, one per step that would start on a gate where the requester has not connected
 * their account. Steps pinned to the same Worker version with the same WorkerSpec are checked
 * once. `plan`'s steps are the ones checked (`views.ts` passes a paused run's steps that have not
 * started, or wait to be tried again).
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
  const offered =
    options.modelCatalog && plan.steps.some((step) => step.spec?.model !== undefined)
      ? await options.modelCatalog()
      : null;
  for (const step of plan.steps) {
    const retried = options.retried?.has(step.key) === true;
    const key = checkKey(step, retried);
    let checked = seen.get(key);
    if (checked === undefined) {
      checked = await checkStep(client, workspaceId, requesterId, step, retried, offered);
      seen.set(key, checked);
    }
    const approvals = retried ? [] : (options.trialApprovals?.get(step.key) ?? []);
    const refusals: StepAttemptRefusal[] =
      checked.kind === 'refused'
        ? checked.refusals.filter((refusal) => !approvedTrial(refusal, approvals))
        : [];
    // A later attempt mounts what its last one did: checked per step, past the shared check (two
    // steps pinned alike ran apart). Only once its authority would let it start at all.
    const previous = retried ? options.previousAttempts?.get(step.key) : undefined;
    if (previous && !refusals.some((refusal) => refusal.kind !== 'admission')) {
      const pinned = await previousAttemptSkillsRefusal(
        client,
        workspaceId,
        previous,
        options.knownSkillNames,
      );
      if (pinned) refusals.push(pinned);
    }
    if (refusals.length === 0) {
      if (checked.gatekeeperIds.length > 0) {
        startingGates.push({ stepKey: step.key, gatekeeperIds: checked.gatekeeperIds });
      }
      continue;
    }
    for (const refusal of refusals) {
      if (refusal.kind === 'authority_lost' && refusal.reason === 'requester') {
        return [
          {
            code: 'requester_cannot_start_workers',
            message: `${refusal.detail}: no step of this plan can start`,
          },
        ];
      }
      const hint = stepHint(step, refusal);
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

/** One step as its next attempt would be admitted now: the requester's authority over what it
 *  declares (with its WorkerSpec), then its WorkerSpec's components — for a later attempt
 *  (`retried`), its model only (`createStepAttemptTask`). */
async function checkStep(
  client: PoolClient,
  workspaceId: string,
  requesterId: string,
  step: PlanStep,
  retried: boolean,
  offered: ReadonlySet<string> | null,
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
  if (authority.kind === 'refused') {
    return { kind: 'refused', refusals: [authority.refusal], gatekeeperIds: [] };
  }
  const model = retried ? workerSpecModelRefusal(authority.parent, spec, offered) : null;
  const refusals = retried
    ? model
      ? [model]
      : []
    : await workerSpecComponentRefusals(client, workspaceId, authority.parent, spec, offered);
  return refusals.length > 0
    ? { kind: 'refused', refusals, gatekeeperIds: authority.declaredGates }
    : { kind: 'starts', gatekeeperIds: authority.declaredGates };
}
