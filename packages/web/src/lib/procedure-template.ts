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

type WorkerStep = Extract<ProcedureStep, { kind: 'worker' }>;

/** The `worker` steps by the key each has in the plan ({@link procedurePlanPlaces}). */
export function procedureWorkersByKey(
  steps: readonly (ProcedureStep | null)[],
  places: ReadonlyMap<number, ProcedurePlanPlace>,
): ReadonlyMap<string, WorkerStep> {
  const workers = new Map<string, WorkerStep>();
  for (const [index, place] of places) {
    const step = steps[index];
    if (step?.kind === 'worker') workers.set(place.key, step);
  }
  return workers;
}

/**
 * UX acceptance of #722 (P3-1): what the page can already tell is wrong with a binding — publishing
 * is refused for it, using the Procedure would be too — or `null`. Only what is certain from the
 * Procedure itself: a binding from the parameters when it declares none, or from a field its
 * parameters close off (`additionalProperties: false`); one from a step that is not a `worker`
 * step of it, that the step does not wait for, or that declares no output contract. The rest (a
 * path's syntax, deeper fields) is the kernel's to say when the draft is published.
 */
export function procedureBindingIssue(
  binding: ProcedureBinding,
  place: ProcedurePlanPlace,
  workers: ReadonlyMap<string, WorkerStep>,
  parameters: OutputSchema | null,
  t: Translate,
): string | null {
  if (binding.from === PROCEDURE_PARAMS_SOURCE) {
    if (parameters === null) {
      return t(
        '这个流程没有声明启动参数，取不到值。',
        'This Procedure declares no parameters, so there is nothing to take.',
      );
    }
    const field = /^[A-Za-z_][A-Za-z0-9_]*/.exec(binding.path)?.[0];
    if (
      field !== undefined &&
      parameters.additionalProperties === false &&
      !Object.hasOwn(parameters.properties ?? {}, field)
    ) {
      return t(`启动参数里没有声明 ${field}。`, `The parameters do not declare ${field}.`);
    }
    return null;
  }
  const upstream = workers.get(binding.from);
  if (!upstream) {
    return t(
      `这个流程没有叫 ${binding.from} 的 Worker 步骤。`,
      `This Procedure has no Worker step named ${binding.from}.`,
    );
  }
  if (!place.dependsOn.includes(binding.from)) {
    return t(
      `这一步不等步骤 ${binding.from} 完成，拿不到它的输出：要把它加进 dependsOn。`,
      `This step does not wait for ${binding.from}, so it cannot take its output: add it to dependsOn.`,
    );
  }
  if (upstream.outputSchema === undefined) {
    return t(
      `步骤 ${binding.from} 没有声明输出约定，绑定只能取自声明过的输出。`,
      `Step ${binding.from} declares no output contract; a binding takes only from a declared output.`,
    );
  }
  return null;
}

const PLAN_PREFIX = 'the plan it makes: ';

/** A binding's reason as the kernel words it (`plan.ts`, `from-procedure.ts`, the binding path
 *  checks), in Chinese — `raw`, the kernel's whole problem, in English — or `null` for a reason it
 *  does not know. */
function bindingReasonText(reason: string, t: Translate, raw: string): string | null {
  if (reason === 'takes from $params, but the Procedure declares no parameters') {
    return t('取自启动参数，但这个流程没有声明启动参数', raw);
  }
  const undeclared =
    /^path "(.+)": the (output|parameters) schema does not declare "(.+)" in (.+?)(?: of step "([^"]+)")?$/.exec(
      reason,
    );
  if (undeclared) {
    const [, path, subject, field, where, step] = undeclared;
    const schema =
      subject === 'parameters'
        ? where === 'the parameters'
          ? t('启动参数里', raw)
          : t(`启动参数的 ${where} 里`, raw)
        : where === 'the output'
          ? t(`步骤 ${step ?? ''} 的输出约定里`, raw)
          : t(`步骤 ${step ?? ''} 输出的 ${where} 里`, raw);
    return t(`路径 ${path} 取不到值：${schema}没有声明 ${field}`, raw);
  }
  const notShaped =
    /^path "(.+)": (.+?) is not (an object|a list) in the (output|parameters) schema(?: of step "([^"]+)")?$/.exec(
      reason,
    );
  if (notShaped) {
    const [, path, where, shape, subject, step] = notShaped;
    const owner =
      subject === 'parameters' ? t('启动参数', raw) : t(`步骤 ${step ?? ''} 的输出`, raw);
    const what = where === `the ${subject}` ? owner : t(`${owner}的 ${where}`, raw);
    // A space after a field name, none after Chinese.
    const gap = /[\w\]"]$/.test(what) ? ' ' : '';
    return t(
      `路径 ${path} 取不到值：${what}${gap}不是${shape === 'a list' ? '列表' : '对象'}`,
      raw,
    );
  }
  const notWaited =
    /^takes from step "([^"]+)", which this step does not depend on — add it to dependsOn$/.exec(
      reason,
    );
  if (notWaited) {
    return t(`取自步骤 ${notWaited[1]}，但这一步不等它完成：要把它加进 dependsOn`, raw);
  }
  const noContract =
    /^step "([^"]+)" declares no outputSchema — a binding takes only from a declared output$/.exec(
      reason,
    );
  if (noContract) {
    return t(`步骤 ${noContract[1]} 没有声明输出约定，绑定只能取自声明过的输出`, raw);
  }
  const clash =
    /^puts its value at "([^"]+)", where (?:bindings\[(\d+)\]|the binding from step "([^"]+)") puts its own at "([^"]+)"$/.exec(
      reason,
    );
  if (clash) {
    const [, to, index, step, other] = clash;
    const whose =
      index !== undefined
        ? t(`第 ${Number(index) + 1} 个绑定`, raw)
        : t(`取自步骤 ${step} 的绑定`, raw);
    return t(`放到 ${to}，和${whose}放的 ${other} 重叠`, raw);
  }
  const written =
    /^the input already has a value at "([^"]+)" — take it out of the input, or bind another field$/.exec(
      reason,
    );
  if (written) {
    return t(`写定的输入在 ${written[1]} 已经有值：把它从输入里去掉，或者绑到别的字段`, raw);
  }
  return null;
}

/** A problem the kernel refused publishing for, in Chinese when it is one the kernel words the
 *  same way each time (`raw` in English) — else `null`. */
function templateProblemText(problem: string, t: Translate, raw: string): string | null {
  const binding = /^step "([^"]+)": bindings\[(\d+)\]: (.+)$/.exec(problem);
  if (binding) {
    const [, key, index, reason] = binding;
    const text = bindingReasonText(reason ?? '', t, raw);
    return text === null ? null : t(`步骤 ${key} 的第 ${Number(index) + 1} 个绑定：${text}`, raw);
  }
  const step = /^step "([^"]+)": (.+)$/.exec(problem);
  if (step) {
    const [, key, reason] = step;
    if (
      reason ===
      'the input must be an object when the step has bindings — a binding fills a field of it'
    ) {
      return t(`步骤 ${key}：有绑定时，写定的输入必须是对象，绑定是往它的字段里填值`, raw);
    }
    const missing = /^depends on "([^"]+)", which is not in the plan$/.exec(reason ?? '');
    if (missing) return t(`步骤 ${key}：要等的步骤 ${missing[1]} 不在计划里`, raw);
    return null;
  }
  if (problem === "the Procedure has no worker step — a goal's plan runs at least one Worker") {
    return t('这个流程没有 Worker 步骤：目标的计划至少要运行一个 Worker', raw);
  }
  return null;
}

/**
 * UX acceptance of #722 (P2-1): one of the problems the kernel refused publishing a Procedure for
 * (`publish_procedure`'s 400 `invalid_params`, `details.problems`), as the person reads it — in
 * Chinese when the kernel words it the same way each time, with the step's key in the plan
 * (shown on the page) and the binding's place among the step's own (1-based); otherwise as the
 * kernel wrote it. A step key or a binding counts the same in the plan it makes (`the plan it
 * makes: …`) as in the Procedure.
 */
export function procedureTemplateProblemText(problem: string, t: Translate): string {
  const own = problem.startsWith(PLAN_PREFIX) ? problem.slice(PLAN_PREFIX.length) : problem;
  return templateProblemText(own, t, problem) ?? problem;
}
