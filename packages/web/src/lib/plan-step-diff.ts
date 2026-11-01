import {
  DEFAULT_MAX_ATTEMPTS,
  type GoalPlan,
  type PlanStep,
  type StepAcceptanceCheck,
  type StepBinding,
  type WorkerSpec,
} from '@nexttime/shared';
import { actionLabel } from './capability-labels.js';
import { shortId } from './format.js';
import {
  bindingSentence,
  filesFromSentence,
  planCheckSentence,
  skillRefShown,
  stableJson,
} from './goals.js';
import type { Translate } from './i18n.js';

/**
 * lib/plan-step-diff (S11 GO15a; `s11-w2/go15-default-plan.md` F5): what a revision changed in each
 * step it kept the key of but redefined — field by field, from what to what — read from the two
 * plans alone (a pure projection; nothing is stored). The planner's proposal card, the plan's
 * version timeline and the revise confirm all read it, each choosing how much to show: so a
 * redefined step says 「改读 side、fetch-2 留下的文件」 rather than only that it changed.
 */

/** The WorkerSpec lists a change names entry by entry. */
export type SpecListField = 'skills' | 'gates' | 'capabilities' | 'observeScope';

/** One field of a step a revision changed. A WorkerSpec field `undefined` is one the step leaves
 *  to its Worker (for `observeScope`: no limit). */
export type StepFieldChange =
  | {
      readonly kind: 'worker';
      readonly before: PlanStep['worker'];
      readonly after: PlanStep['worker'];
    }
  /** Where the step's static input differs — places only, never values; `total` counts them all,
   *  `paths` lists the first {@link MAX_INPUT_PATHS}. `''` is the input as a whole. */
  | { readonly kind: 'input'; readonly paths: readonly string[]; readonly total: number }
  | {
      readonly kind: 'dependsOn';
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | { readonly kind: 'maxAttempts'; readonly before: number; readonly after: number }
  | { readonly kind: 'nested'; readonly after: boolean }
  | {
      readonly kind: 'specList';
      readonly field: SpecListField;
      readonly before: readonly string[] | undefined;
      readonly after: readonly string[] | undefined;
    }
  | {
      readonly kind: 'specModel';
      readonly before: string | undefined;
      readonly after: string | undefined;
    }
  | {
      readonly kind: 'specInstructions';
      readonly before: string | undefined;
      readonly after: string | undefined;
    }
  | {
      readonly kind: 'specTokenBudget';
      readonly before: number | undefined;
      readonly after: number | undefined;
    }
  | {
      readonly kind: 'bindings';
      readonly added: readonly StepBinding[];
      readonly removed: readonly StepBinding[];
    }
  | {
      readonly kind: 'filesFrom';
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | { readonly kind: 'outputSchema'; readonly before: boolean; readonly after: boolean }
  | {
      readonly kind: 'acceptance';
      readonly added: readonly StepAcceptanceCheck[];
      readonly removed: readonly StepAcceptanceCheck[];
      readonly changed: readonly {
        readonly before: StepAcceptanceCheck;
        readonly after: StepAcceptanceCheck;
      }[];
    }
  | { readonly kind: 'reconcile' }
  /** The entry differs only in how it is written — a list reordered, a default spelled out. The
   *  platform still compares entries as written, so the step starts over all the same. */
  | { readonly kind: 'notation' };

/** A step the revision redefined, with what changed in it, in the order the fields are read. */
export interface StepChange {
  readonly key: string;
  readonly changes: readonly StepFieldChange[];
}

/** The input places a change lists at most. */
export const MAX_INPUT_PATHS = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function inputPaths(before: unknown, after: unknown, at: string, out: string[]): void {
  if (stableJson(before) === stableJson(after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) inputPaths(before[key], after[key], at ? `${at}.${key}` : key, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      inputPaths(before[index], after[index], `${at}[${index}]`, out);
    }
    return;
  }
  out.push(at);
}

const listDiff = (before: readonly string[], after: readonly string[]) => ({
  added: after.filter((item) => !before.includes(item)),
  removed: before.filter((item) => !after.includes(item)),
});

const SPEC_LISTS: readonly SpecListField[] = ['skills', 'gates', 'capabilities', 'observeScope'];

function specChanges(before: WorkerSpec | undefined, after: WorkerSpec | undefined) {
  const changes: StepFieldChange[] = [];
  const was = before ?? {};
  const now = after ?? {};
  if (was.instructions !== now.instructions) {
    changes.push({ kind: 'specInstructions', before: was.instructions, after: now.instructions });
  }
  for (const field of SPEC_LISTS) {
    if (field === 'observeScope') continue;
    if (stableJson(was[field]) !== stableJson(now[field])) {
      changes.push({ kind: 'specList', field, before: was[field], after: now[field] });
    }
  }
  if (was.model !== now.model) {
    changes.push({ kind: 'specModel', before: was.model, after: now.model });
  }
  if (stableJson(was.observeScope) !== stableJson(now.observeScope)) {
    changes.push({
      kind: 'specList',
      field: 'observeScope',
      before: was.observeScope,
      after: now.observeScope,
    });
  }
  if (was.tokenBudget !== now.tokenBudget) {
    changes.push({ kind: 'specTokenBudget', before: was.tokenBudget, after: now.tokenBudget });
  }
  return changes;
}

/** What changed in one step kept under its key — empty when nothing did. */
export function stepFieldChanges(before: PlanStep, after: PlanStep): readonly StepFieldChange[] {
  const changes: StepFieldChange[] = [];
  if (stableJson(before.worker) !== stableJson(after.worker)) {
    changes.push({ kind: 'worker', before: before.worker, after: after.worker });
  }
  const paths: string[] = [];
  inputPaths(before.input, after.input, '', paths);
  if (paths.length > 0) {
    changes.push({ kind: 'input', paths: paths.slice(0, MAX_INPUT_PATHS), total: paths.length });
  }
  const dependsOn = listDiff(before.dependsOn ?? [], after.dependsOn ?? []);
  if (dependsOn.added.length > 0 || dependsOn.removed.length > 0) {
    changes.push({ kind: 'dependsOn', ...dependsOn });
  }
  const attempts = [
    before.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    after.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  ] as const;
  if (attempts[0] !== attempts[1]) {
    changes.push({ kind: 'maxAttempts', before: attempts[0], after: attempts[1] });
  }
  if ((before.nested === true) !== (after.nested === true)) {
    changes.push({ kind: 'nested', after: after.nested === true });
  }
  changes.push(...specChanges(before.spec, after.spec));
  const bindingKeys = (bindings: readonly StepBinding[] | undefined) =>
    new Map((bindings ?? []).map((binding) => [stableJson(binding), binding]));
  const [oldBindings, newBindings] = [bindingKeys(before.bindings), bindingKeys(after.bindings)];
  const bindings = {
    added: [...newBindings].filter(([key]) => !oldBindings.has(key)).map(([, b]) => b),
    removed: [...oldBindings].filter(([key]) => !newBindings.has(key)).map(([, b]) => b),
  };
  if (bindings.added.length > 0 || bindings.removed.length > 0) {
    changes.push({ kind: 'bindings', ...bindings });
  }
  if (stableJson(before.filesFrom ?? []) !== stableJson(after.filesFrom ?? [])) {
    changes.push({
      kind: 'filesFrom',
      before: before.filesFrom ?? [],
      after: after.filesFrom ?? [],
    });
  }
  if (stableJson(before.outputSchema) !== stableJson(after.outputSchema)) {
    changes.push({
      kind: 'outputSchema',
      before: before.outputSchema !== undefined,
      after: after.outputSchema !== undefined,
    });
  }
  const oldChecks = new Map((before.acceptance ?? []).map((check) => [check.key, check]));
  const newChecks = new Map((after.acceptance ?? []).map((check) => [check.key, check]));
  const checks = {
    added: [...newChecks.values()].filter((check) => !oldChecks.has(check.key)),
    removed: [...oldChecks.values()].filter((check) => !newChecks.has(check.key)),
    changed: [...newChecks.values()].flatMap((check) => {
      const was = oldChecks.get(check.key);
      return was && stableJson(was) !== stableJson(check) ? [{ before: was, after: check }] : [];
    }),
  };
  if (checks.added.length + checks.removed.length + checks.changed.length > 0) {
    changes.push({ kind: 'acceptance', ...checks });
  }
  if (stableJson(before.reconcile) !== stableJson(after.reconcile)) {
    changes.push({ kind: 'reconcile' });
  }
  return changes;
}

/** Every step of `after` kept under its key from `before` but redefined, in `after`'s order — the
 *  same steps `planDiff` lists as changed. */
export function planStepDiff(before: GoalPlan, after: GoalPlan): readonly StepChange[] {
  const old = new Map(before.steps.map((step) => [step.key, step]));
  return after.steps.flatMap((step) => {
    const was = old.get(step.key);
    if (!was) return [];
    if (stableJson(was) === stableJson(step)) return [];
    const changes = stepFieldChanges(was, step);
    return [{ key: step.key, changes: changes.length > 0 ? changes : [{ kind: 'notation' }] }];
  });
}

// ---------------------------------------------------------------------------------------------
// As the page says it
// ---------------------------------------------------------------------------------------------

/** What a change's sentence names by name: gates and Workers. */
export interface StepChangeNames {
  readonly gateNames: ReadonlyMap<string, string>;
  /** WorkerDefinition names by id, where the page has them. */
  readonly workerNames?: ReadonlyMap<string, string>;
}

const joinZh = (items: readonly string[]) => items.join('、');
const joinEn = (items: readonly string[]) => items.join(', ');

const SPEC_LIST_LABEL: Readonly<Record<SpecListField, readonly [string, string]>> = {
  skills: ['Skill', 'Skills'],
  gates: ['门', 'Gatekeepers'],
  capabilities: ['能力范围', 'Capabilities'],
  observeScope: ['观察范围', 'Observation scope'],
};

function listItemsShown(
  field: SpecListField,
  items: readonly string[],
  names: StepChangeNames,
  t: Translate,
): readonly string[] {
  switch (field) {
    case 'skills':
      return items.map(skillRefShown);
    case 'capabilities':
      return items.map((name) => actionLabel(name, t));
    case 'gates':
    case 'observeScope':
      return items.map((id) => names.gateNames.get(id) ?? shortId(id));
  }
}

/** UX P3-2 on #889: what a list set to nothing means for the step, field by field. */
function specListEmpty(field: SpecListField, t: Translate): string {
  switch (field) {
    case 'skills':
      return t('这一步不装载 Skill', 'the step mounts no Skill');
    case 'gates':
      return t('这一步不作用于任何门', 'the step acts on no gatekeeper');
    case 'capabilities':
      return t(
        '这一步只有每个 Worker 都有的几项基础能力',
        'the step holds only what every Worker has',
      );
    case 'observeScope':
      return t('这一步不能观察任何门', 'the step may observe no gatekeeper');
  }
}

function specListText(
  change: Extract<StepFieldChange, { kind: 'specList' }>,
  names: StepChangeNames,
  t: Translate,
): string {
  const [label, en] = SPEC_LIST_LABEL[change.field];
  // A Latin label (Skill) keeps the space before Chinese that follows it; a Chinese one takes none.
  const zh = /[A-Za-z]$/.test(label) ? `${label} ` : label;
  const empty = specListEmpty(change.field, t);
  const shown = (items: readonly string[]) => listItemsShown(change.field, items, names, t);
  const scope = change.field === 'observeScope';
  if (change.after === undefined) {
    return scope
      ? t('观察范围改回不限', 'Observation scope lifted: no limit')
      : t(`${zh}改回沿用 Worker 定义`, `${en} back to the Worker’s own`);
  }
  if (change.before === undefined) {
    if (change.after.length === 0) {
      return scope
        ? `${t('观察范围改为空：', 'Observation scope set to none: ')}${empty}${t('（原来不限）', ' (no limit before)')}`
        : `${t(`${zh}改为空：`, `${en} set to none: `)}${empty}${t('（原来沿用 Worker 定义）', ' (the Worker’s own before)')}`;
    }
    return scope
      ? t(
          `观察范围限定为门 ${joinZh(shown(change.after))}（原来不限）`,
          `Observation scope limited to ${joinEn(shown(change.after))} (no limit before)`,
        )
      : t(
          `${zh}改为 ${joinZh(shown(change.after))}（原来沿用 Worker 定义）`,
          `${en} set to ${joinEn(shown(change.after))} (the Worker’s own before)`,
        );
  }
  if (change.after.length === 0) {
    return `${t(`${zh}改为空：`, `${en} set to none: `)}${empty}`;
  }
  const { added, removed } = listDiff(change.before, change.after);
  if (added.length === 0 && removed.length === 0) {
    return t(`${zh}的顺序改了`, `${en} reordered`);
  }
  const zhParts = [
    ...(added.length > 0 ? [`加上 ${joinZh(shown(added))}`] : []),
    ...(removed.length > 0 ? [`去掉 ${joinZh(shown(removed))}`] : []),
  ];
  const enParts = [
    ...(added.length > 0 ? [`adds ${joinEn(shown(added))}`] : []),
    ...(removed.length > 0 ? [`drops ${joinEn(shown(removed))}`] : []),
  ];
  return t(`${zh}${zhParts.join('，')}`, `${en}: ${enParts.join('; ')}`);
}

function workerShown(ref: PlanStep['worker'], names: StepChangeNames): string {
  const name = names.workerNames?.get(ref.definitionId) ?? shortId(ref.definitionId);
  return `${name} v${ref.version}`;
}

/** One change as a sentence (no full stop): 「改读 side、fetch-2 留下的文件（原来读 fetch）」. */
export function stepFieldChangeText(
  change: StepFieldChange,
  names: StepChangeNames,
  t: Translate,
): string {
  switch (change.kind) {
    case 'worker':
      return change.before.definitionId === change.after.definitionId
        ? t(
            `Worker 改用第 ${change.after.version} 版（原来第 ${change.before.version} 版）`,
            `Worker version v${change.before.version} → v${change.after.version}`,
          )
        : t(
            `换了 Worker：${workerShown(change.before, names)} → ${workerShown(change.after, names)}`,
            `Another Worker: ${workerShown(change.before, names)} → ${workerShown(change.after, names)}`,
          );
    case 'input': {
      const places = change.paths.map((path) =>
        path === '' ? t('整个输入', 'the whole input') : path,
      );
      const more = change.total - change.paths.length;
      return t(
        `输入改了：${joinZh(places)}${more > 0 ? ` 等 ${change.total} 处` : ''}`,
        `Input changed at ${joinEn(places)}${more > 0 ? ` and ${more} more` : ''}`,
      );
    }
    case 'dependsOn': {
      const zh = [
        ...(change.added.length > 0 ? [`加上 ${joinZh(change.added)}`] : []),
        ...(change.removed.length > 0 ? [`去掉 ${joinZh(change.removed)}`] : []),
      ];
      const en = [
        ...(change.added.length > 0 ? [`adds ${joinEn(change.added)}`] : []),
        ...(change.removed.length > 0 ? [`drops ${joinEn(change.removed)}`] : []),
      ];
      return t(`前置步骤${zh.join('，')}`, `Earlier steps: ${en.join('; ')}`);
    }
    case 'maxAttempts':
      return t(
        `最多尝试次数 ${change.before} → ${change.after}`,
        `At most ${change.before} → ${change.after} attempts`,
      );
    case 'nested':
      return change.after
        ? t('改为可以起子 Worker', 'Now starts child Workers')
        : t('不再起子 Worker', 'No longer starts child Workers');
    case 'specList':
      return specListText(change, names, t);
    case 'specModel':
      if (change.after === undefined) {
        return t('模型改回沿用 Worker 定义', 'Model back to the Worker’s own');
      }
      return change.before === undefined
        ? t(
            `模型设为 ${change.after}（原来沿用 Worker 定义）`,
            `Model set to ${change.after} (the Worker’s own before)`,
          )
        : t(`模型 ${change.before} → ${change.after}`, `Model ${change.before} → ${change.after}`);
    case 'specInstructions':
      return change.before === undefined
        ? t('加上这一步的职责说明', 'Adds a responsibility for this step')
        : change.after === undefined
          ? t('去掉这一步的职责说明', 'Drops the step’s responsibility')
          : t('这一步的职责说明改了', 'The step’s responsibility changed');
    case 'specTokenBudget':
      if (change.after === undefined) {
        return t(
          '去掉每次尝试的 Token 上限（只受目标预算限制）',
          'Drops the token cap per attempt (only the goal’s budget caps it)',
        );
      }
      return change.before === undefined
        ? t(
            `每次尝试的 Token 上限设为 ${change.after.toLocaleString()}`,
            `Token cap per attempt set to ${change.after.toLocaleString()}`,
          )
        : t(
            `每次尝试的 Token 上限 ${change.before.toLocaleString()} → ${change.after.toLocaleString()}`,
            `Token cap per attempt ${change.before.toLocaleString()} → ${change.after.toLocaleString()}`,
          );
    case 'bindings': {
      const zh = [
        ...change.added.map((binding) => `加上「${bindingSentence(binding, t)}」`),
        ...change.removed.map((binding) => `去掉「${bindingSentence(binding, t)}」`),
      ];
      const en = [
        ...change.added.map((binding) => `adds “${bindingSentence(binding, t)}”`),
        ...change.removed.map((binding) => `drops “${bindingSentence(binding, t)}”`),
      ];
      return t(
        `取自前面步骤的输入：${zh.join('，')}`,
        `Inputs from earlier steps: ${en.join('; ')}`,
      );
    }
    case 'filesFrom':
      if (change.after.length === 0) {
        return t(
          `不再读取步骤 ${joinZh(change.before)} 留下的文件`,
          `No longer reads the files left by ${joinEn(change.before)}`,
        );
      }
      return change.before.length === 0
        ? filesFromSentence(change.after, t)
        : t(
            `改读 ${joinZh(change.after)} 留下的文件（原来读 ${joinZh(change.before)}）`,
            `Reads the files left by ${joinEn(change.after)} instead (was ${joinEn(change.before)})`,
          );
    case 'outputSchema':
      return !change.before
        ? t('设了输出约定', 'Sets an output contract')
        : !change.after
          ? t('去掉输出约定', 'Drops its output contract')
          : t('输出约定改了', 'Its output contract changed');
    case 'acceptance': {
      const sentence = (check: StepAcceptanceCheck) => planCheckSentence(check, names.gateNames, t);
      const zh = [
        ...change.added.map((check) => `新增「${sentence(check)}」`),
        ...change.removed.map((check) => `去掉「${sentence(check)}」`),
        ...change.changed.map(
          ({ before, after }) => `${after.key} 从「${sentence(before)}」改为「${sentence(after)}」`,
        ),
      ];
      const en = [
        ...change.added.map((check) => `adds “${sentence(check)}”`),
        ...change.removed.map((check) => `drops “${sentence(check)}”`),
        ...change.changed.map(
          ({ before, after }) => `${after.key} from “${sentence(before)}” to “${sentence(after)}”`,
        ),
      ];
      return t(`这一步的验收：${zh.join('，')}`, `The step’s checks: ${en.join('; ')}`);
    }
    case 'reconcile':
      return t('动作的核对声明改了', 'How its actions are reconciled changed');
    case 'notation':
      return t(
        '只改了写法（比如顺序，或写明了默认值），内容没变',
        'Only how it is written changed (an order, or a default spelled out)',
      );
  }
}

/** A redefined step's changes in one line, for a confirm: 「改读 side 留下的文件；模型 a → b」. */
export function stepChangeLine(change: StepChange, names: StepChangeNames, t: Translate): string {
  return change.changes.map((field) => stepFieldChangeText(field, names, t)).join(t('；', '; '));
}
