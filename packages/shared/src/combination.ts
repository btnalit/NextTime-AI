import type { WorkerSpec, WorkerSpecField } from './goal-plan.js';
import { WORKER_HINT_WINDOW_DAYS } from './wire/worker-discovery.js';
import type { WorkerWorkerDefinitionContent } from './worker-definition.js';

/**
 * combination (S11 GO16b; docs/global-roadmap-2026-10-16.md W4 GO16, plan §4.4 末句): a
 * combination is a published worker-kind WorkerDefinition version run with one goal step's
 * WorkerSpec — `(definitionId, version, specDigest)`, the digest a step attempt's run
 * configuration keeps (`workerSpecDigest`). The same digest is the same WorkerSpec, whichever goal
 * it came from. One that kept working may be proposed as a WorkerDefinition of its own, which then
 * goes through the usual review and publish like any other draft (GO16 forks F1–F7 = A,
 * coordinator 2026-11-07):
 *
 *   - Which combinations qualify (F1): over the Tasks of ordinary work that ran as it and ended in
 *     the last {@link COMBINATION_WINDOW_DAYS} days, at least {@link COMBINATION_MIN_ACHIEVED}
 *     primary outcomes achieved (the requester's word, a platform check — never the executor's
 *     own report), from at least {@link COMBINATION_MIN_GOALS} different goals, an attainment rate
 *     of at least {@link COMBINATION_MIN_RATE}, and no 「建议复核」 on it. Only a published base
 *     version: a deprecated one was set aside, and what is derived from it would bring it back.
 *     Judged when read and again when proposed; never stored.
 *   - Who starts it (F2): a person, from the console — the platform lists the candidates, an agent
 *     never proposes one.
 *   - What is written (F3, F4): a new family's first draft, {@link mergeCombinationDefinition}.
 *     The step-only fields ({@link COMBINATION_STEP_ONLY_FIELDS}) have no place in a definition
 *     and are left for the plan steps that use it.
 *   - Where it came from (F5): the kernel records the base version, the digest and the evidence
 *     for the new family once, never changed (`worker/0014`).
 *   - Who sees the content (F7): a WorkerSpec's text lives only in goal plans, which their
 *     requester and the workspace owner read. Its content, and proposing it, are for those who can
 *     read a goal it ran in.
 */

/** F1: the window the evidence is counted over — GO13's hint window. */
export const COMBINATION_WINDOW_DAYS = WORKER_HINT_WINDOW_DAYS;
/** F1: primary outcomes achieved, at least. */
export const COMBINATION_MIN_ACHIEVED = 3;
/** F1: the different goals those outcomes came from, at least. */
export const COMBINATION_MIN_GOALS = 2;
/** F1: achieved over achieved and not achieved (primary), at least. */
export const COMBINATION_MIN_RATE = 0.8;

/** F4: what a WorkerSpec sets for one step only — no WorkerDefinition field holds it. */
export const COMBINATION_STEP_ONLY_FIELDS = [
  'observeScope',
  'tokenBudget',
] as const satisfies readonly WorkerSpecField[];

/** What a combination that qualifies has behind it, counted as {@link COMBINATION_WINDOW_DAYS}
 *  says. `rate` is `achieved / (achieved + notAchieved)`, `null` with neither. */
export interface CombinationEvidence {
  readonly achieved: number;
  readonly notAchieved: number;
  readonly goals: number;
  readonly rate: number | null;
  readonly reviewSuggested: boolean;
}

/** Why a combination does not qualify, in the order {@link combinationShortfalls} checks. */
export const COMBINATION_SHORTFALL_VALUES = [
  'base_not_published',
  'too_few_achieved',
  'too_few_goals',
  'rate_too_low',
  'review_suggested',
] as const;
export type CombinationShortfall = (typeof COMBINATION_SHORTFALL_VALUES)[number];

/** F1: everything that keeps a combination from qualifying; `[]` when it does. */
export function combinationShortfalls(
  evidence: CombinationEvidence,
  basePublished: boolean,
): CombinationShortfall[] {
  const shortfalls: CombinationShortfall[] = [];
  if (!basePublished) shortfalls.push('base_not_published');
  if (evidence.achieved < COMBINATION_MIN_ACHIEVED) shortfalls.push('too_few_achieved');
  if (evidence.goals < COMBINATION_MIN_GOALS) shortfalls.push('too_few_goals');
  if (evidence.rate === null || evidence.rate < COMBINATION_MIN_RATE) {
    shortfalls.push('rate_too_low');
  }
  if (evidence.reviewSuggested) shortfalls.push('review_suggested');
  return shortfalls;
}

/**
 * F4: the definition a combination becomes — the base version's content with what the WorkerSpec
 * sets, as the step ran it: `instructions` follows the base's `systemPrompt` after a blank line
 * (it adds to the prompt, never replaces it); `skills`, `gates`, `capabilities` and `model`
 * replace the base's; everything else (`description`, `egressDeny`, `inputSchema`,
 * `outputSchema`) is the base's; `name` is the one given. {@link COMBINATION_STEP_ONLY_FIELDS}
 * are not carried.
 */
export function mergeCombinationDefinition(
  base: WorkerWorkerDefinitionContent,
  spec: WorkerSpec,
  name: string,
): WorkerWorkerDefinitionContent {
  const instructions = spec.instructions?.trim();
  return {
    ...base,
    systemPrompt:
      instructions !== undefined && instructions.length > 0
        ? `${base.systemPrompt}\n\n${instructions}`
        : base.systemPrompt,
    ...(spec.skills !== undefined ? { skills: [...spec.skills] } : {}),
    ...(spec.gates !== undefined ? { gates: [...spec.gates] } : {}),
    ...(spec.capabilities !== undefined ? { capabilities: [...spec.capabilities] } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    name,
  };
}
