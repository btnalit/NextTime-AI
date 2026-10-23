import {
  type OutputSchema,
  PROCEDURE_PARAMS_SOURCE,
  type ProcedureBinding,
  type ProcedureStep,
  ProcedureStepSchema,
  type StepBinding,
  StepOutputSchemaSchema,
} from '@nexttime/shared';
import { bindingSentence } from './goals.js';
import type { Translate } from './i18n.js';

/**
 * lib/procedure-template (S11 GO5d-2): a Procedure as the template a goal's plan is made from
 * (`propose_goal`'s `fromProcedure`; the kernel's `application/goal/from-procedure.ts`), in the
 * sentences the catalog's Procedure page shows — which step of the plan each `worker` step becomes
 * and what it waits for, where its inputs come from (an earlier step's output, or the parameters
 * the goal is proposed with), and who checks each `verify` step. The defaults are the kernel's: a
 * `worker` step's key is `step-<n>` (n its place among all the Procedure's steps) and it waits for
 * the `worker` step before it.
 */

/** Each step parsed, or `null` for one that does not parse (shown as it is). */
export function parsedProcedureSteps(steps: readonly unknown[]): readonly (ProcedureStep | null)[] {
  return steps.map((step) => {
    const parsed = ProcedureStepSchema.safeParse(step);
    return parsed.success ? parsed.data : null;
  });
}

/** The parameters schema, or `null` when there is none (or it does not parse). */
export function parsedProcedureParameters(parameters: unknown): OutputSchema | null {
  if (parameters === undefined || parameters === null) return null;
  const parsed = StepOutputSchemaSchema.safeParse(parameters);
  return parsed.success ? parsed.data : null;
}

/** What a `worker` step is in the goal's plan: its key, and the steps it waits for. */
export interface ProcedurePlanPlace {
  readonly key: string;
  readonly dependsOn: readonly string[];
  /** The kernel's default (the `worker` step before it), not the step's own `dependsOn`. */
  readonly defaulted: boolean;
}

/** By the index of each `worker` step (the steps as {@link parsedProcedureSteps} gives them). */
export function procedurePlanPlaces(
  steps: readonly (ProcedureStep | null)[],
): ReadonlyMap<number, ProcedurePlanPlace> {
  const places = new Map<number, ProcedurePlanPlace>();
  let previous: string | null = null;
  for (const [index, step] of steps.entries()) {
    if (step?.kind !== 'worker') continue;
    const key = step.key ?? `step-${index + 1}`;
    places.set(index, {
      key,
      dependsOn: step.dependsOn ?? (previous !== null ? [previous] : []),
      defaulted: step.dependsOn === undefined,
    });
    previous = key;
  }
  return places;
}

export function procedureDependencySentence(place: ProcedurePlanPlace, t: Translate): string {
  if (place.dependsOn.length === 0) {
    return place.defaulted
      ? t('最先开始', 'Starts first')
      : t('不等其他步骤，一开始就运行', 'Waits for no other step: runs from the start');
  }
  const list = place.dependsOn.join(t('、', ', '));
  return place.defaulted
    ? t(
        `等上一个 Worker 步骤 ${list} 完成后开始`,
        `Starts once the Worker step before it, ${list}, is done`,
      )
    : t(
        `等步骤 ${list} 完成后开始`,
        `Starts once ${list} ${place.dependsOn.length > 1 ? 'are' : 'is'} done`,
      );
}

/** 「输入 site 来自启动参数的 site」, or a plan binding's sentence. */
export function procedureBindingSentence(binding: ProcedureBinding, t: Translate): string {
  if (binding.from === PROCEDURE_PARAMS_SOURCE) {
    return t(
      `输入 ${binding.to} 来自启动参数的 ${binding.path}`,
      `Input ${binding.to} comes from ${binding.path} of the parameters`,
    );
  }
  return bindingSentence(binding as StepBinding, t);
}

/** Why the Procedure makes no goal plan — a step the kernel cannot make a goal step of, or no
 *  `worker` step — or `null` when it makes one (subject to the plan's checks then). */
export function procedureNoPlanReason(
  steps: readonly (ProcedureStep | null)[],
): 'manual_step' | 'no_worker' | null {
  if (steps.some((step) => step?.kind === 'operation' || step?.kind === 'approval')) {
    return 'manual_step';
  }
  return steps.some((step) => step?.kind === 'worker') ? null : 'no_worker';
}
