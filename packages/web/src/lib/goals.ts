import type {
  AcceptanceCheck,
  ActionFailureCode,
  ActionRequestFailureKind,
  ActionRequestReconciliation,
  FactCheck,
  FactObjectRef,
  GoalAbsenceBaselineWire,
  GoalAcceptanceCheckKind,
  GoalAcceptanceCheckWire,
  GoalDetailWire,
  GoalOutcomeBasis,
  GoalPlan,
  GoalRunChange,
  GoalRunPauseReason,
  GoalRunStatus,
  GoalRunWire,
  ObjectiveOutcome,
  ObservationAbsenceCheck,
  ObservationCheck,
  OutputJsonValue,
  OutputSchema,
  OutputSchemaType,
  PlanHint,
  PlanSourceProcedureWire,
  PlanStep,
  Predicate,
  PredicateJsonValue,
  StepAcceptanceState,
  StepBinding,
  StepRemoval,
  StepRunFailureCategory,
  StepRunWaitingReason,
  StepRunWire,
  UnresolvedGoalActionWire,
  WorkerSpec,
} from '@nexttime/shared';
import { visibleText } from '@nexttime/shared';
import { actionLabel } from './capability-labels.js';
import { clipMiddle, redactSensitive, shortId } from './format.js';
import { pendingTrialStepKeys } from './goal-trials.js';
import { isUuidLike } from './graph-view.js';
import type { Translate } from './i18n.js';

/**
 * lib/goals (S11 GO6): what the console's goal pages (`components/goals/*`) read out of the
 * `goal` capability group's one wire shape (`wire/goal.ts`) — the sentences for its sub-states, a
 * plan's predicates, its budget, and the difference between two plan revisions. No capability
 * calls and no React: the pages call and render. What a person may do to a goal is
 * `lib/goal-actions.ts`'s, so nothing here names a button.
 *
 * Words follow the design (plan §9 "语义一致"): 目标 is the GoalRun, 步骤 a StepRun, 任务 a Task one
 * attempt of a step ran as; 执行状态 (how far it ran) and 目标结果 (whether it was achieved) stay
 * apart; 请求人 is the principal the goal acts for.
 */

/** Legacy 470: 「名字 · 类型」 by Object id (`useObjectLabels`). */
export type ObjectNames = ReadonlyMap<string, string>;

const NO_NAMES: ObjectNames = new Map();

export type GoalFilter = 'all' | 'active' | 'done';

const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalRunStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export function isTerminalGoalStatus(status: GoalRunStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

export function goalMatchesFilter(goal: GoalRunWire, filter: GoalFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'done' ? isTerminalGoalStatus(goal.status) : !isTerminalGoalStatus(goal.status);
}

/** Steps of the plan in force that have finished, of all of them (superseded ones left out). */
export function goalStepProgress(goal: GoalRunWire): {
  readonly done: number;
  readonly total: number;
} {
  const counts = goal.stepCounts;
  const total =
    counts.pending +
    counts.ready +
    counts.running +
    counts.waiting +
    counts.succeeded +
    counts.failed +
    counts.cancelled +
    counts.skipped;
  return { done: counts.succeeded + counts.skipped, total };
}

const PAUSE_REASON: Readonly<Record<GoalRunPauseReason, readonly [string, string]>> = {
  requested: ['有人暂停了它', 'Someone paused it'],
  budget_exhausted: ['预算用完', 'Budget used up'],
  no_progress: ['连续没有进展', 'No progress'],
  authority_lost: ['请求人缺少授权', 'Requester lacks authority'],
  needs_decision: ['需要人决定', 'Needs a decision'],
  awaiting_reconcile: ['等人核对', 'Waiting for a check'],
};

/** Why a goal is paused, in a few words (the list row, the chip beside the status). */
export function goalPauseReasonLabel(reason: GoalRunPauseReason, t: Translate): string {
  const [zh, en] = PAUSE_REASON[reason];
  return t(zh, en);
}

const WAITING_REASON: Readonly<Record<StepRunWaitingReason, readonly [string, string]>> = {
  approval: ['等动作审批或执行', 'Waiting on an action’s approval or run'],
  reconcile: ['等核对动作是否生效', 'Waiting to learn whether an action took effect'],
  external: ['等平台之外的事', 'Waiting on something outside the platform'],
  acceptance: ['平台正在验收这一步', 'The platform is checking this step'],
  acceptance_unavailable: [
    '无法验收：检查做不了，等人决定',
    'Could not be checked: waits on a person',
  ],
};

export function stepWaitingReasonLabel(reason: StepRunWaitingReason, t: Translate): string {
  const [zh, en] = WAITING_REASON[reason];
  return t(zh, en);
}

const FAILURE: Readonly<
  Record<
    StepRunFailureCategory,
    { readonly short: readonly [string, string]; readonly detail: readonly [string, string] }
  >
> = {
  transient: {
    short: ['运行出错', 'Run error'],
    detail: [
      '任务没能运行或中途退出，或动作没有送达；平台会在尝试次数内自动重试。',
      'The task could not run or died, or an action was not delivered; the platform retries within the attempt limit.',
    ],
  },
  authority_lost: {
    short: ['缺少授权', 'Authority lost'],
    detail: [
      '请求人已经没有这一步需要的授权，需要人决定。',
      'The requester no longer holds what this step needs; a person decides.',
    ],
  },
  contract_violation: {
    short: ['结果不合约定', 'Result broke its contract'],
    detail: [
      'Worker 没有交回平台接受的结果：输出始终不符合这一步的输出约定，或没有报告结果。第一次平台会自动返工一次，并把被拒的原因告诉 Worker；返工后仍是这样，需要人决定。',
      'The Worker never handed back a result the platform accepted: its output never met the step’s output contract, or it reported none. The first time, the platform redoes the step once and tells the Worker what was refused; if the rework ends the same way, a person decides.',
    ],
  },
  verification_failed: {
    short: ['验收没通过', 'Verification failed'],
    detail: [
      '这一步的验收检查做了，结果不符合期望。重试会重做这一步的工作，所以只由人重试。',
      'A check of this step was made and did not pass. A retry redoes the work, so only a person retries it.',
    ],
  },
  outcome_unknown: {
    short: ['结果不明', 'Outcome unknown'],
    detail: [
      '动作可能已经执行，核对也没能确认，平台不会自动重试。',
      'An action may have run and the check could not tell; never retried on its own.',
    ],
  },
  action_refused: {
    short: ['动作被拒', 'Action refused'],
    detail: [
      '动作被门或目标系统拒绝、被审批人拒绝、过期或被策略否决；原样再提也会得到同样的答复。',
      'An action was refused by the gate or its target, rejected, expired or denied; asking again unchanged gets the same answer.',
    ],
  },
};

export function stepFailureText(
  category: StepRunFailureCategory,
  t: Translate,
): { readonly short: string; readonly detail: string } {
  const entry = FAILURE[category];
  return { short: t(entry.short[0], entry.short[1]), detail: t(entry.detail[0], entry.detail[1]) };
}

// ---------------------------------------------------------------------------------------------
// A step's output contract, and the inputs it takes from earlier steps (S11 GO5d-1)
// ---------------------------------------------------------------------------------------------

/** 「输入 host 来自步骤 scan 输出的 hosts[0]」 — one of a step's bindings, as a sentence. */
export function bindingSentence(binding: StepBinding, t: Translate): string {
  return t(
    `输入 ${binding.to} 来自步骤 ${binding.from} 输出的 ${binding.path}`,
    `Input ${binding.to} comes from ${binding.path} of step ${binding.from}’s output`,
  );
}

const OUTPUT_TYPE: Readonly<Record<OutputSchemaType, readonly [string, string]>> = {
  string: ['文本', 'text'],
  integer: ['整数', 'integer'],
  number: ['数字', 'number'],
  boolean: ['是/否', 'yes/no'],
  object: ['对象', 'object'],
  array: ['列表', 'list'],
  null: ['空值', 'null'],
};

const typeWord = (name: string, t: Translate): string => {
  const pair = Object.hasOwn(OUTPUT_TYPE, name) ? OUTPUT_TYPE[name as OutputSchemaType] : undefined;
  return pair ? t(pair[0], pair[1]) : name;
};

/** What `@nexttime/shared` `validateOutput` / `outputContractProblems` say of one place, each
 *  message a fixed English template, put in Chinese. The English stays as sent — it is what the
 *  Worker read — and a message no template matches is shown as sent in either language. */
const OUTPUT_PROBLEM_ZH: readonly (readonly [
  RegExp,
  (match: RegExpExecArray, t: Translate) => string,
])[] = [
  [
    /^expected (.+), got (\w+)$/,
    (m, t) =>
      `应为${(m[1] ?? '')
        .split(' or ')
        .map((type) => typeWord(type, t))
        .join('或')}，实际是${typeWord(m[2] ?? '', t)}`,
  ],
  [/^must be one of (.+)$/s, (m) => `应为其中之一：${m[1]}`],
  [/^must be (.+)$/s, (m) => `应为 ${m[1]}`],
  [/^shorter than (\d+) characters$/, (m) => `少于 ${m[1]} 个字符`],
  [/^longer than (\d+) characters$/, (m) => `多于 ${m[1]} 个字符`],
  [/^less than (\S+)$/, (m) => `小于下限 ${m[1]}`],
  [/^greater than (\S+)$/, (m) => `大于上限 ${m[1]}`],
  [/^fewer than (\d+) items$/, (m) => `少于 ${m[1]} 项`],
  [/^more than (\d+) items$/, (m) => `多于 ${m[1]} 项`],
  [/^required, missing$/, () => '必填，但没有'],
  [
    /^not declared by the schema \(additionalProperties is false\)$/,
    () => '约定里没有这个字段，且约定不允许多出的字段',
  ],
  [/^too large to check: more than (\d+) values$/, (m) => `太大，无法检查：超过 ${m[1]} 个值`],
  [
    /^missing: this step declares an output schema/,
    () => '没有带 output：这一步声明了输出约定，结果要放在 output 里',
  ],
];

/** One output-contract problem's message for the reader — see {@link OUTPUT_PROBLEM_ZH}. */
export function outputProblemText(message: string, t: Translate): string {
  for (const [pattern, zh] of OUTPUT_PROBLEM_ZH) {
    const match = pattern.exec(message);
    if (match) return t(zh(match, t), message);
  }
  return message;
}

/** How many of an `enum`'s values a field's kind spells out before 「等 N 个」. */
const ENUM_SHOWN = 5;

function enumValue(value: OutputJsonValue): string {
  return clipMiddle(JSON.stringify(value) ?? 'null', 40);
}

/** What one node of an output schema asks for, in a few words: 「文本列表」, 「整数」,
 *  「取值之一："fast"、"safe"」. Its bounds and nested fields are in the schema itself. */
export function outputKindText(schema: OutputSchema, t: Translate): string {
  if (schema.const !== undefined) {
    return t(`固定为 ${enumValue(schema.const)}`, `always ${enumValue(schema.const)}`);
  }
  if (schema.enum !== undefined) {
    const shown = schema.enum.slice(0, ENUM_SHOWN).map(enumValue);
    const more = schema.enum.length - shown.length;
    return more > 0
      ? t(
          `取值之一：${shown.join('、')} 等 ${schema.enum.length} 个`,
          `one of ${shown.join(', ')} and ${more} more`,
        )
      : t(`取值之一：${shown.join('、')}`, `one of ${shown.join(', ')}`);
  }
  const types =
    schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0) return t('任意值', 'any value');
  return types
    .map((type: OutputSchemaType) => {
      if (type === 'array' && schema.items !== undefined) {
        const inner = outputKindText(schema.items, t);
        return t(`列表（每项：${inner}）`, `list of ${inner}`);
      }
      const [zh, en] = OUTPUT_TYPE[type];
      return t(zh, en);
    })
    .join(t(' 或 ', ' or '));
}

export interface OutputField {
  readonly name: string;
  readonly kind: string;
  readonly required: boolean;
  readonly description: string | null;
}

/** The fields an output contract (or a Procedure's parameters) asks for — the root is always an
 *  object (`StepOutputSchemaSchema`) — the required ones first, each part by name: the schema's
 *  own order does not survive storage (jsonb orders an object's keys its own way). */
export function outputContractFields(schema: OutputSchema, t: Translate): readonly OutputField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .map(([name, node]) => ({
      name,
      kind: outputKindText(node, t),
      required: required.has(name),
      description: node.description ?? null,
    }))
    .sort((a, b) =>
      a.required === b.required ? a.name.localeCompare(b.name) : a.required ? -1 : 1,
    );
}

const OUTCOME_BASIS: Readonly<Record<GoalOutcomeBasis, readonly [string, string]>> = {
  verified_by_check: ['依据平台验收检查', 'Based on the platform’s checks'],
  requester: ['依据请求人确认', 'On the requester’s word'],
  reviewer_assessed: ['依据独立评审', 'Based on an independent review'],
};

export function outcomeBasisLabel(basis: GoalOutcomeBasis, t: Translate): string {
  const [zh, en] = OUTCOME_BASIS[basis];
  return t(zh, en);
}

// ---------------------------------------------------------------------------------------------
// A goal's milestone in the chat it was proposed from (S11 GO5e-2)
// ---------------------------------------------------------------------------------------------

/** The fields of a `system.goal_update` message a milestone line reads (`lib/system-status`). */
export interface GoalMilestone {
  readonly change: GoalRunChange | null;
  readonly status: GoalRunStatus;
  readonly pauseReason: GoalRunPauseReason | null;
  readonly heldByOwner: boolean;
  readonly outcome: ObjectiveOutcome | null;
  readonly outcomeBasis: GoalOutcomeBasis | null;
  readonly cleanupPending: boolean;
  readonly revision: number | null;
}

/**
 * One goal milestone, in a sentence the chat's reader — the goal's requester, whose chat it is —
 * reads beside the status chip. Built from the message's fields, never its kernel text (English)
 * and never the goal's statement (free text, read masked with `get_goal`).
 */
export function goalMilestoneText(milestone: GoalMilestone, t: Translate): string {
  const reason = milestone.pauseReason ? goalPauseReasonLabel(milestone.pauseReason, t) : null;
  switch (milestone.change) {
    case 'propose':
      return t('目标已提出，等你确认后才开始', 'Goal proposed; it starts once you confirm it');
    case 'confirm':
      return t('目标已确认，开始执行', 'Goal confirmed; its steps are starting');
    case 'reject':
      return t('目标在开始前被拒绝', 'Goal rejected before it started');
    case 'pause':
      return reason
        ? t(`目标已暂停：${reason}`, `Goal paused: ${reason}`)
        : t('目标已暂停', 'Goal paused');
    case 'hold':
      return t(
        '目标被工作区所有者锁定：所有者解除之后才能继续',
        'A workspace owner holds the goal: it can resume only once an owner lifts the hold',
      );
    case 'release_hold':
      // Lifting the hold leaves the pause it took over: say why it is still paused, so nobody
      // resumes a goal that would stop again at once (#737 UX P3-1).
      return reason
        ? t(
            `锁定已解除；目标仍暂停：${reason}`,
            `The hold was lifted; the goal is still paused: ${reason}`,
          )
        : t('锁定已解除，你可以继续这个目标', 'The hold was lifted; you can resume the goal');
    case 'resume':
      return t('目标已继续', 'Goal resumed');
    case 'revise':
      return milestone.revision
        ? t(
            `目标计划已修订为第 ${milestone.revision} 版，继续之前仍是暂停`,
            `Goal plan revised to revision ${milestone.revision}; it stays paused until resumed`,
          )
        : t('目标计划已修订，继续之前仍是暂停', 'Goal plan revised; it stays paused until resumed');
    case 'verify':
      return t('所有步骤都已完成，平台正在验收', 'Every step is done; the platform is checking it');
    case 'complete': {
      // Worded as the goal's page words it (`goalStateNote`): an end "not achieved" is never
      // "completed" (#737 UX P2-1); the line's outcome chip carries the colour.
      const basis = milestone.outcomeBasis ? outcomeBasisLabel(milestone.outcomeBasis, t) : null;
      if (milestone.outcome === 'achieved') {
        return basis
          ? t(`目标已达成 · ${basis}`, `Goal achieved · ${basis}`)
          : t('目标已达成', 'Goal achieved');
      }
      if (milestone.outcome === 'not_achieved') {
        return basis
          ? t(`目标按未达成结束 · ${basis}`, `Goal ended as not achieved · ${basis}`)
          : t('目标按未达成结束', 'Goal ended as not achieved');
      }
      return t('目标已结束', 'Goal ended');
    }
    case 'cancel':
      return t(
        '目标正在取消：不再开始新步骤，正在停止运行中的步骤',
        'Goal being cancelled: no new step starts, running ones are being stopped',
      );
    case 'finish_cancel':
      return milestone.cleanupPending
        ? t(
            '目标已取消，还有遗留要清理',
            'Goal cancelled; some of what it started is left to clean up',
          )
        : t('目标已取消', 'Goal cancelled');
    case 'cleanup_finished':
      return t('已取消目标的遗留已清理完', 'What the cancelled goal left behind is cleaned up');
    case 'fail':
      return t('目标因平台错误停止', 'Goal stopped on a platform error');
    case null:
      return reason
        ? t(`目标状态有变化：${reason}`, `Goal status changed: ${reason}`)
        : t('目标状态有变化', 'Goal status changed');
  }
}

const CHECK_KIND: Readonly<Record<GoalAcceptanceCheckKind, readonly [string, string]>> = {
  observe_predicate: ['平台观察', 'Platform observation'],
  observe_absent: ['平台确认不存在', 'Platform confirms it is not there'],
  fact_predicate: ['事实判定', 'Fact check'],
  requester_confirm: ['请求人确认', 'Requester confirms'],
};

/** Legacy 454: the Procedure a goal's plan was made from — revision 1's, the only one that can be
 *  (a later revision is the requester's own edit); `null` for a plan written as it is. */
export function goalPlanSource(
  revisions: readonly {
    readonly revision: number;
    readonly fromProcedure: PlanSourceProcedureWire | null;
  }[],
): PlanSourceProcedureWire | null {
  return revisions.find((revision) => revision.revision === 1)?.fromProcedure ?? null;
}

/** Legacy 454: the start parameters a plan was made with, as `name = value` rows (a value that is
 *  not text as JSON); none when none were kept. Values come masked from the read. Legacy 474:
 *  each with its `description` from the Procedure's parameters schema, when `descriptions` has
 *  one (`useProcedureParameterDescriptions`). */
export function planSourceParameters(
  source: PlanSourceProcedureWire | null,
  descriptions: ReadonlyMap<string, string> = NO_NAMES,
): readonly { readonly name: string; readonly value: string; readonly description?: string }[] {
  if (!source?.parameters) return [];
  return Object.entries(source.parameters).map(([name, value]) => {
    const description = descriptions.get(name);
    return {
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/** A start parameter as one line of text: 「说明（name） = value」 when it has a description. */
export function planSourceParameterText(
  row: { readonly name: string; readonly value: string; readonly description?: string },
  t: Translate,
): string {
  if (row.description === undefined) return `${row.name} = ${row.value}`;
  return t(
    `${row.description}（${row.name}） = ${row.value}`,
    `${row.description} (${row.name}) = ${row.value}`,
  );
}

/** Legacy 454: where the requester's confirmation check of a plan made from a Procedure came
 *  from — the Procedure's `verify` steps without a check of their own — or `null` for any other
 *  check (or a plan not made from one). */
export function confirmCheckOrigin(
  source: PlanSourceProcedureWire | null,
  checkKey: string,
  t: Translate,
): string | null {
  const confirm = source?.confirmCheck;
  if (!confirm || confirm.key !== checkKey) return null;
  const steps = confirm.procedureSteps.join(t('、', ', '));
  return t(
    `来自流程第 ${steps} 步（没有自带检查的验证步骤）`,
    `From Procedure step${confirm.procedureSteps.length > 1 ? 's' : ''} ${steps} (verify steps without a check of their own)`,
  );
}

export function checkKindLabel(kind: GoalAcceptanceCheckKind, t: Translate): string {
  const [zh, en] = CHECK_KIND[kind];
  return t(zh, en);
}

const STEP_ACCEPTANCE: Readonly<Record<StepAcceptanceState, readonly [string, string]>> = {
  verifying: ['验收中', 'Verifying'],
  unavailable: ['无法验收', 'Could not check'],
  failed: ['验收未通过', 'Failed its checks'],
  passed: ['验收通过', 'Passed its checks'],
};

export function stepAcceptanceLabel(state: StepAcceptanceState, t: Translate): string {
  const [zh, en] = STEP_ACCEPTANCE[state];
  return t(zh, en);
}

/** What a step's hint (S11 GO5c) says would happen — the run pauses at the step for a person.
 *  S11 GO8a: a step of a paused run waiting to be tried again would not be tried again (UX on
 *  #853 — the pause note says the same, `heldWording`). */
const STEP_HINT_CONSEQUENCE = {
  first: [
    '这一步不会开始，目标会停在这里等人处理。',
    'the step would not start, and the goal would pause there for a person.',
  ],
  retried: [
    '这一步不会再试，目标会停在这里等人处理。',
    'the step would not be tried again, and the goal would pause there for a person.',
  ],
} as const satisfies Record<string, readonly [string, string]>;

/** Where a plan hint is read: on the card that confirms a proposal, or under a revision the
 *  requester made, which is in force already and has nothing to turn down. */
export type PlanHintContext = 'proposal' | 'revision';

/** What to do about a missing grant: the hints do not stop confirming or revising, so each says
 *  what comes next — get it granted first, or turn the plan down for another (a proposal), or
 *  revise it again without the step (a revision). */
const GRANT_NEXT_STEP: Readonly<Record<PlanHintContext, readonly [string, string]>> = {
  proposal: [
    '可以请工作区所有者在「成员与授权」给请求人开通，或者驳回，让助手换个做法。',
    'A workspace owner can grant it in Members, or turn the plan down so the assistant tries another way.',
  ],
  revision: [
    '可以请工作区所有者在「成员与授权」给请求人开通，或者再修订计划，换掉或移除这一步。',
    'A workspace owner can grant it in Members, or revise the plan again to change or remove the step.',
  ],
};

/** Legacy 513: what to do about an account the requester has not connected — only they can
 *  connect it (「录入我的凭证」 on the gate's row in Systems & access); then confirm, or turn the plan
 *  down (a proposal), or revise it again (a revision). */
const ACCOUNT_NEXT_STEP: Readonly<Record<PlanHintContext, readonly [string, string]>> = {
  proposal: [
    '请求人可以先在「系统与授权」里给这个门「录入我的凭证」再确认，或者驳回，让助手换个做法。',
    'The requester can first use “Enter my credential” for the gate in Systems & access and then confirm, or turn the plan down so the assistant tries another way.',
  ],
  revision: [
    '请求人可以在「系统与授权」里给这个门「录入我的凭证」，或者再修订计划，换掉或移除这一步。',
    'The requester can use “Enter my credential” for the gate in Systems & access, or revise the plan again to change or remove the step.',
  ],
};

/** A list in a sentence: each name in 「」 joined by 、 (zh), in quotes joined by commas (en). */
function namesIn(names: readonly string[]): readonly [string, string] {
  return [
    names.map((name) => `「${name}」`).join('、'),
    names.map((name) => `“${name}”`).join(', '),
  ];
}

interface PlanHintArgs {
  readonly step: string;
  /** Where the hint is read: a proposal can be turned down, a revision is in force already. */
  readonly context: PlanHintContext;
  /** What to do about a missing grant, where the hint is read. */
  readonly next: readonly [string, string];
  /** What to do about an account the requester has not connected, where the hint is read. */
  readonly accountNext: readonly [string, string];
  /** The gates a `step_gate_not_held` step needs, by name where known. */
  readonly gates: readonly string[];
  /** The execute permissions a `step_capability_not_held` step needs, by their console names. */
  readonly capabilities: readonly (readonly [string, string])[];
  /** S11 GO8a: the Skills a `step_skill_draft` / `step_skill_deprecated` step names, as shown;
   *  legacy 544, the Skill versions a `step_skill_version_unavailable` step would mount again. */
  readonly skills: readonly string[];
  /** S11 GO8a: the model a `step_model_not_offered` / `step_model_not_allowed` step sets. */
  readonly model: string;
  /** What would happen to the step: it would not start, or not be tried again. */
  readonly consequence: readonly [string, string];
  /** S11 GO8b: whether a `step_skill_draft` step has one trial a person may approve (`trial`). */
  readonly trial: boolean;
}

/** S11 GO8a: how the plan changes when what a step's WorkerSpec names cannot be used — a proposal
 *  is turned down for another; a revision is revised again, by the entry agent in chat for the
 *  WorkerSpec (the console's 「修订计划…」 keeps it as it is, UX on #853) or there without the step. */
const CHANGE_PLAN: Readonly<Record<PlanHintContext, readonly [string, string]>> = {
  proposal: ['驳回，让助手换个做法', 'turn the plan down so the assistant tries another way'],
  revision: [
    '在对话里让入口智能体修订计划换掉它，或者在「修订计划…」里移除这一步',
    'ask the entry agent in chat to revise the plan and change it, or remove the step under “Revise plan…”',
  ],
};

/**
 * A plan hint as a sentence. `requester_confirm_only` is about the plan; the S11 GO5c codes are the
 * confirmation card's check of the requester's authority, worked out whenever the proposal is read:
 * what would stop a step, and what to do about it.
 */
const PLAN_HINT: Readonly<
  Record<PlanHint['code'], (args: PlanHintArgs) => readonly [string, string]>
> = {
  requester_confirm_only: () => [
    '这个计划没有平台能做的验收检查：目标是否达成只凭请求人确认。',
    'No check the platform makes: the goal is achieved only on the requester’s word.',
  ],
  requester_cannot_start_workers: () => [
    '请求人现在不能启动 Worker（角色不允许，或已被停用）：这个计划的步骤都不会开始，目标会在第一步就停下等人处理。可以请工作区所有者在「成员与授权」查看请求人的角色和状态。',
    'The requester cannot start Workers now (their role, or they are disabled): no step of this plan would start, and the goal would pause at its first step for a person. A workspace owner can check the requester’s role and status in Members.',
  ],
  step_gate_not_held: ({ step, gates, next, consequence }) => {
    const [zh, en] = namesIn(gates);
    return [
      `步骤「${step}」的 Worker 要操作门${zh}，请求人现在没有${gates.length === 1 ? '这个门' : '这些门'}的权限：${consequence[0]}${next[0]}`,
      `Step “${step}”: its Worker acts on ${gates.length === 1 ? 'gate' : 'gates'} ${en}, which the requester cannot act on now — ${consequence[1]} ${next[1]}`,
    ];
  },
  step_capability_not_held: ({ step, capabilities, next, consequence }) => {
    if (capabilities.length === 0) {
      return [
        `步骤「${step}」的 Worker 需要请求人现在没有的执行权限：${consequence[0]}${next[0]}`,
        `Step “${step}”: its Worker needs an execute permission the requester does not hold now — ${consequence[1]} ${next[1]}`,
      ];
    }
    const [zh] = namesIn(capabilities.map(([name]) => name));
    const [, en] = namesIn(capabilities.map(([, name]) => name));
    return [
      `步骤「${step}」的 Worker 需要执行权限${zh}，请求人现在没有：${consequence[0]}${next[0]}`,
      `Step “${step}”: its Worker needs the execute ${capabilities.length === 1 ? 'permission' : 'permissions'} ${en}, which the requester does not hold now — ${consequence[1]} ${next[1]}`,
    ];
  },
  step_definition_excluded: ({ step, consequence }) => [
    `请求人的智能体设置排除了步骤「${step}」的 Worker：${consequence[0]}请求人可以在「我的智能体」里调整设置。`,
    `The requester’s agent profile excludes the Worker of step “${step}” — ${consequence[1]} The requester can change it in My Agent.`,
  ],
  // Legacy 513: asked of the gate when a person reads the proposal — the step would start, and the
  // gate would refuse its calls for want of the requester's own credential.
  step_account_not_connected: ({ step, gates, accountNext }) => {
    const [zh, en] = namesIn(gates);
    return [
      `步骤「${step}」要用请求人自己的账户操作门${zh}，请求人还没有在${gates.length === 1 ? '这个门' : '这些门'}上连接账户：这一步开始后，门会因为没有可用凭证拒绝它的调用，批准也改变不了。${accountNext[0]}`,
      `Step “${step}” acts on ${gates.length === 1 ? 'gate' : 'gates'} ${en} with the requester’s own account, which they have not connected there: once the step starts, the gate refuses its calls for want of a credential, and no approval changes that. ${accountNext[1]}`,
    ];
  },
  // S11 GO8a: what the admission of a step's WorkerSpec says. A draft waits for a person: publishing
  // the Skill or changing the plan moves it — and, S11 GO8b, approving one trial of the step.
  step_skill_draft: ({ step, skills, context, consequence, trial }) => {
    const [zh, en] = namesIn(skills);
    const one = skills.length === 1;
    const [changeZh, changeEn] = CHANGE_PLAN[context];
    if (trial) {
      return [
        `步骤「${step}」的 Worker 要用 Skill${zh}，${one ? '它' : '它们'}还只是草稿，没有发布：没人批准的话，${consequence[0]}能发布${one ? '它' : '它们'}的人（提议者或工作区所有者）可以在「步骤」里这一步的提示下批准试用，只让这一步用草稿试一次；也可以先在「能力目录」发布，或者${changeZh}。`,
        `Step “${step}”: its Worker uses ${one ? 'Skill' : 'Skills'} ${en}, ${one ? 'which is only a draft' : 'which are only drafts'}, not published — unless someone approves, ${consequence[1]} Someone who may publish ${one ? 'it' : 'them'} (the proposer or a workspace owner) can approve a trial from the step’s note in Steps, for this step to try the ${one ? 'draft' : 'drafts'} once; or publish in Catalog first, or ${changeEn}.`,
      ];
    }
    return [
      `步骤「${step}」的 Worker 要用 Skill${zh}，${one ? '它' : '它们'}还只是草稿，没有发布：${consequence[0]}这一步没法只批准试用一次（一个引用对上了不止一份草稿，或者草稿和已发布的 Skill 同名）。有发布权的人可以先在「能力目录」发布${one ? '它' : '它们'}${context === 'proposal' ? '再确认' : ''}，或者${changeZh}。`,
      `Step “${step}”: its Worker uses ${one ? 'Skill' : 'Skills'} ${en}, ${one ? 'which is only a draft' : 'which are only drafts'}, not published — ${consequence[1]} No single trial of it can be approved (a reference matches more than one draft, or a draft is named like a published Skill). Someone who may publish ${one ? 'it' : 'them'} can do so in Catalog${context === 'proposal' ? ' before you confirm' : ''}, or ${changeEn}.`,
    ];
  },
  step_skill_deprecated: ({ step, skills, context, consequence }) => {
    const [zh, en] = namesIn(skills);
    const one = skills.length === 1;
    return [
      `步骤「${step}」的 Worker 要用的 Skill${zh}已经弃用，没有能用的版本：${consequence[0]}${context === 'proposal' ? '可以驳回，让助手换一个已发布的 Skill。' : '可以在对话里让入口智能体修订计划，换一个已发布的 Skill，或者在「修订计划…」里移除这一步。'}`,
      `Step “${step}”: its Worker uses ${one ? 'Skill' : 'Skills'} ${en}, deprecated with no version left to use — ${consequence[1]} ${context === 'proposal' ? 'Turn the plan down so the assistant picks a published Skill.' : 'Ask the entry agent in chat to revise the plan to a published Skill, or remove the step under “Revise plan…”.'}`,
    ];
  },
  // Legacy 544: the Worker version a step is pinned to is no longer published — a plan naming it
  // does not validate, so a proposal cannot be confirmed and a revision has to change or drop it.
  step_worker_unavailable: ({ step, context, consequence }) => {
    if (context === 'proposal') {
      return [
        `步骤「${step}」用的 Worker 版本已经不再发布（弃用了，或者不存在）：现在确认会被拒绝。可以驳回，让助手换一个已发布的 Worker。`,
        `Step “${step}” uses a Worker version that is no longer published (deprecated, or not there) — confirming would be refused now. Turn the plan down so the assistant picks a published Worker.`,
      ];
    }
    const [changeZh, changeEn] = CHANGE_PLAN[context];
    return [
      `步骤「${step}」用的 Worker 版本已经不再发布（弃用了，或者不存在）：${consequence[0]}可以${changeZh}。`,
      `Step “${step}” uses a Worker version that is no longer published (deprecated, or not there) — ${consequence[1]} You can ${changeEn}.`,
    ];
  },
  // Legacy 544: a step tried again mounts the Skill versions its last attempt did — one gone since
  // (deprecated, or a trial's draft changed, discarded or deprecated) holds it until the plan
  // changes the step, which then starts afresh with the Skills as they are now.
  step_skill_version_unavailable: ({ step, skills, consequence }) => {
    const [zh, en] = namesIn(skills);
    const one = skills.length === 1;
    return [
      `步骤「${step}」上一次尝试用的 Skill${zh}现在不能再用了（已弃用，或者试用的草稿改过、被丢弃或弃用）。重试要用同一个版本，所以${consequence[0]}在对话里让入口智能体修订计划改动这一步，它会按现在的 Skill 重新开始；或者在「修订计划…」里移除这一步。`,
      `Step “${step}”: ${one ? 'the Skill version' : 'the Skill versions'} ${en} its last attempt used can no longer be used (deprecated, or a trial’s draft changed, discarded or deprecated). A retry uses the same ${one ? 'version' : 'versions'}, so ${consequence[1]} Ask the entry agent in chat to revise the plan and change the step, which then starts afresh with the Skills as they are now; or remove the step under “Revise plan…”.`,
    ];
  },
  // A plan is validated against the catalog when proposed, confirmed or revised: the hint says the
  // catalog dropped the model since — confirming the proposal would be refused (UX on #853).
  step_model_not_offered: ({ step, model, context, consequence }) => {
    if (context === 'proposal') {
      return [
        `步骤「${step}」给 Worker 设定的模型「${model}」已经不在模型目录里：现在确认会被拒绝。平台管理员可以在「平台 → 模型与供应商」里重新提供它再确认，或者驳回，让助手换个做法。`,
        `Step “${step}” sets its Worker’s model to “${model}”, which the model catalog no longer offers — confirming would be refused now. A platform administrator can offer it again under Platform → Models & providers before you confirm, or turn the plan down so the assistant tries another way.`,
      ];
    }
    const [changeZh, changeEn] = CHANGE_PLAN[context];
    return [
      `步骤「${step}」给 Worker 设定的模型「${model}」已经不在模型目录里：${consequence[0]}平台管理员可以在「平台 → 模型与供应商」里重新提供它，或者${changeZh}。`,
      `Step “${step}” sets its Worker’s model to “${model}”, which the model catalog no longer offers — ${consequence[1]} A platform administrator can offer it again under Platform → Models & providers, or ${changeEn}.`,
    ];
  },
  step_model_not_allowed: ({ step, model, context, consequence }) => {
    const [changeZh, changeEn] = CHANGE_PLAN[context];
    return [
      `步骤「${step}」给 Worker 设定的模型「${model}」不在这个工作区允许的模型里：${consequence[0]}平台管理员可以在「平台 → 工作区」里允许它，或者${changeZh}。`,
      `Step “${step}” sets its Worker’s model to “${model}”, which this workspace does not allow — ${consequence[1]} A platform administrator can allow it under Platform → Workspaces, or ${changeEn}.`,
    ];
  },
};

const inZh: Translate = (zh) => zh;
const inEn: Translate = (_, en) => en;

/** `retried`: the hint is about a step of a paused run waiting to be tried again
 *  (`retriedStepKeys`) — it would not be tried again, rather than not start. */
export function planHintText(
  hint: PlanHint,
  t: Translate,
  gateNames: ReadonlyMap<string, string> = new Map(),
  context: PlanHintContext = 'proposal',
  retried = false,
): string {
  const entry = PLAN_HINT[hint.code];
  if (!entry) return hint.message;
  const [zh, en] = entry({
    step: hint.stepKey ?? '',
    context,
    next: GRANT_NEXT_STEP[context],
    accountNext: ACCOUNT_NEXT_STEP[context],
    gates: (hint.gatekeeperIds ?? []).map((id) => gateNames.get(id) ?? shortId(id)),
    capabilities: (hint.capabilityNames ?? []).map(
      (name) => [actionLabel(name, inZh), actionLabel(name, inEn)] as const,
    ),
    skills: hintSkillsShown(hint),
    model: hint.model ?? '',
    consequence: STEP_HINT_CONSEQUENCE[retried ? 'retried' : 'first'],
    trial: hint.trial !== undefined,
  });
  return t(zh, en);
}

/** S11 GO8a: why confirming a proposal was refused, when its read already said so — a model the
 *  catalog no longer offers (`step_model_not_offered`): offered again, it can be confirmed (UX on
 *  #853); legacy 544, a step's Worker version no longer published (`step_worker_unavailable`),
 *  which no one can bring back for this proposal. `null` otherwise: the plan's other problems are
 *  under technical details. */
export function confirmRefusedText(hints: readonly PlanHint[], t: Translate): string | null {
  const workerSteps = stepKeysOf(hints.filter((hint) => hint.code === 'step_worker_unavailable'));
  if (workerSteps.length > 0) {
    const [zh, en] = namesIn(workerSteps);
    const one = workerSteps.length === 1;
    return t(
      `步骤${zh}用的 Worker 版本已经不再发布，确认没有通过，这个提议不能再确认了。驳回它，或者在对话里让入口智能体重新提一个目标。`,
      `${one ? 'Step' : 'Steps'} ${en} ${one ? 'uses a Worker version' : 'use Worker versions'} no longer published, so confirming was refused and this proposal cannot be confirmed any more. Turn it down, or ask the entry agent in a chat for a new goal.`,
    );
  }
  const models = [
    ...new Set(
      hints.flatMap((hint) =>
        hint.code === 'step_model_not_offered' && hint.model !== undefined ? [hint.model] : [],
      ),
    ),
  ];
  if (models.length === 0) return null;
  const [zh, en] = namesIn(models);
  const one = models.length === 1;
  return t(
    `计划用到的模型${zh}现在不在模型目录里，确认没有通过。平台管理员在「平台 → 模型与供应商」里重新提供${one ? '它' : '它们'}之后，可以再确认；也可以驳回，让助手换个做法。`,
    `The plan sets ${one ? 'model' : 'models'} ${en}, which the model catalog does not offer now, so confirming was refused. Once a platform administrator offers ${one ? 'it' : 'them'} again under Platform → Models & providers, confirm again; or turn the plan down so the assistant tries another way.`,
  );
}

/** S11 GO8a: the keys of a run's steps waiting to be tried again — `ready` after an attempt, in the
 *  revision in force; a paused run's read hints them as a later attempt is admitted (`views.ts`). */
export function retriedStepKeys(goal: Partial<Pick<GoalDetailWire, 'steps'>>): ReadonlySet<string> {
  return new Set(
    (goal.steps ?? [])
      .filter(
        (step) =>
          step.status === 'ready' && step.attemptCount > 0 && step.supersededInRevision === null,
      )
      .map((step) => step.stepKey),
  );
}

/** Whether a plan hint is about the requester's authority over a step (S11 GO5c) — the steps card
 *  shows those; `requester_confirm_only`, about how the goal is verified, stays with acceptance. */
export function isStepAuthorityHint(hint: PlanHint): boolean {
  return hint.code !== 'requester_confirm_only';
}

/** The chip a step row carries for its own authority hint. */
export function stepHintChipLabel(hint: PlanHint, t: Translate): string | null {
  switch (hint.code) {
    case 'step_gate_not_held':
    case 'step_capability_not_held':
      return t('请求人无权限', 'Requester lacks access');
    case 'step_definition_excluded':
      return t('智能体设置已排除', 'Excluded by agent settings');
    case 'step_account_not_connected':
      return t('请求人未连接账户', 'Requester’s account not connected');
    case 'step_skill_draft':
      return t('Skill 还是草稿', 'Draft Skill');
    case 'step_skill_deprecated':
      return t('Skill 已弃用', 'Skill deprecated');
    case 'step_model_not_offered':
      return t('模型不在目录里', 'Model not in catalog');
    case 'step_model_not_allowed':
      return t('模型不允许', 'Model not allowed');
    case 'step_worker_unavailable':
      return t('Worker 已不再发布', 'Worker no longer published');
    case 'step_skill_version_unavailable':
      return t('上次的 Skill 版本不可用', 'Last Skill version gone');
    default:
      return null;
  }
}

/** S11 GO8a: a Skill as a WorkerSpec names it — a name as written, an id cut short (never bare). */
export function skillRefShown(ref: string): string {
  return isUuidLike(ref) ? shortId(ref) : ref;
}

/** Legacy 544: a pinned Skill version as the kernel names it, 「name v<version>」 — its name part
 *  shown as {@link skillRefShown} shows a reference (an id when the version's row is gone). */
export function skillVersionShown(ref: string): string {
  const match = /^(.*) v(\d+)$/.exec(ref);
  return match ? `${skillRefShown(match[1] ?? '')} v${match[2]}` : skillRefShown(ref);
}

/** A hint's Skills as shown: references as a WorkerSpec names them, or pinned versions. */
function hintSkillsShown(hint: PlanHint): readonly string[] {
  return (hint.skillRefs ?? []).map(
    hint.code === 'step_skill_version_unavailable' ? skillVersionShown : skillRefShown,
  );
}

/** S11 GO8a: what a step's WorkerSpec sets differently from its Worker, in the order a reader
 *  takes it in — the fields set, each named as the console names it. */
const WORKER_SPEC_FIELD: Readonly<Record<keyof WorkerSpec, readonly [string, string]>> = {
  instructions: ['职责说明', 'Responsibility'],
  skills: ['Skill', 'Skills'],
  gates: ['门', 'Gates'],
  capabilities: ['能力范围', 'Capabilities'],
  model: ['模型', 'Model'],
  observeScope: ['观察范围', 'Observation scope'],
  tokenBudget: ['每次尝试的 Token 上限', 'Token cap per attempt'],
};
const WORKER_SPEC_FIELD_ORDER = Object.keys(WORKER_SPEC_FIELD) as readonly (keyof WorkerSpec)[];

export function workerSpecFields(spec: WorkerSpec): readonly (keyof WorkerSpec)[] {
  return WORKER_SPEC_FIELD_ORDER.filter((field) => spec[field] !== undefined);
}

export function workerSpecFieldLabel(field: keyof WorkerSpec, t: Translate): string {
  const [zh, en] = WORKER_SPEC_FIELD[field];
  return t(zh, en);
}

/** 「这一步对 Worker 的调整：职责说明、Skill」 — what a step's WorkerSpec sets, in a line. */
export function workerSpecSummary(spec: WorkerSpec, t: Translate): string {
  const fields = workerSpecFields(spec).map((field) => workerSpecFieldLabel(field, t));
  return t(
    `这一步对 Worker 的调整：${fields.join('、')}`,
    `Set differently for this step: ${fields.join(', ')}`,
  );
}

/** The fields a WorkerSpec replaces outright, as a sentence names them (en). */
const REPLACED_FIELD_EN: Readonly<Partial<Record<keyof WorkerSpec, string>>> = {
  skills: 'the Skills',
  gates: 'the gates',
  capabilities: 'the capabilities',
  model: 'the model',
};

/** S11 GO8a (UX on #853 P3-1): how what a step's WorkerSpec sets combines with its Worker — said
 *  only of the fields it sets. */
export function workerSpecCombination(spec: WorkerSpec, t: Translate): string {
  const fields = workerSpecFields(spec);
  const replaced = fields.filter((field) => REPLACED_FIELD_EN[field] !== undefined);
  const zh: string[] = [];
  const en: string[] = [];
  if (replaced.length > 0) {
    const listedZh = replaced.map((field) => WORKER_SPEC_FIELD[field][0]).join('、');
    // A Latin word before Chinese takes a space (「Skill 替换」), as the console writes it elsewhere.
    zh.push(`${listedZh}${/[A-Za-z]$/.test(listedZh) ? ' ' : ''}替换 Worker 原有的设定`);
    const names = replaced.map((field) => REPLACED_FIELD_EN[field] as string);
    const listed =
      names.length === 1
        ? (names[0] as string)
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    en.push(
      `${listed} ${replaced.length === 1 && replaced[0] === 'model' ? 'replaces' : 'replace'} the Worker’s own`,
    );
  }
  if (spec.instructions !== undefined) {
    zh.push('职责说明加在 Worker 原有的系统提示之后');
    en.push('the responsibility is added after the Worker’s system prompt');
  }
  if (spec.observeScope !== undefined) {
    zh.push('观察范围限定这一步的任务能读取哪些门');
    en.push('the observation scope is the gatekeepers this step’s task may read through');
  }
  if (spec.gates !== undefined || spec.capabilities !== undefined) {
    zh.push('这一步能做的不会超出 Worker 能有的上限和请求人现在的权限');
    en.push(
      'what the step may do never goes past what a Worker may hold and what the requester holds now',
    );
  }
  if (spec.tokenBudget !== undefined) {
    zh.push('Token 上限不会超出目标剩下的预算');
    en.push('its token cap never goes past what is left of the goal’s budget');
  }
  const sentence = en.join('; ');
  return t(`${zh.join('；')}。`, `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
}

/** A key for a plan hint in a list: a step's hints share their code. */
export function planHintKey(hint: PlanHint): string {
  return hint.stepKey === undefined ? hint.code : `${hint.code}:${hint.stepKey}`;
}

/** A removed step's fate in a revision (`removals`; a removed step not listed was terminated). */
export function stepRemovalText(removal: StepRemoval | undefined, t: Translate): string {
  if (removal === undefined || removal.mode === 'terminate') {
    return t(
      '终止它的任务，撤回它未执行的动作',
      'Its task terminated, its pending actions withdrawn',
    );
  }
  const released = removal.release?.length ?? 0;
  return released > 0
    ? t(
        `让它跑完，结果只记录，不再推进后面的步骤；放行 ${released} 条已提交的动作`,
        `Let it finish: its result is recorded, and nothing after it moves on; ${released} submitted action(s) released`,
      )
    : t(
        '让它跑完，结果只记录，不再推进后面的步骤',
        'Let it finish: its result is recorded, and nothing after it moves on',
      );
}

// ---------------------------------------------------------------------------------------------
// Budget (I-G6)
// ---------------------------------------------------------------------------------------------

export interface BudgetRow {
  readonly key: 'tokens' | 'steps' | 'revisions' | 'wallClock';
  readonly label: string;
  readonly used: number;
  readonly max: number;
  readonly usedText: string;
  readonly maxText: string;
}

function durationText(seconds: number, t: Translate): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t(`${s} 秒`, `${s}s`);
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m} 分钟`, `${m} min`);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48)
    return rest > 0 ? t(`${h} 小时 ${rest} 分`, `${h} h ${rest} min`) : t(`${h} 小时`, `${h} h`);
  return t(`${Math.floor(h / 24)} 天`, `${Math.floor(h / 24)} d`);
}

/** What the goal has spent of each budget dimension. Wall clock runs from confirmation to the end
 *  (or now); before confirmation it is 0. */
export function goalBudgetRows(
  goal: GoalRunWire,
  t: Translate,
  now: number = Date.now(),
): readonly BudgetRow[] {
  const { budget, usage } = goal;
  const start = goal.confirmedAt ? Date.parse(goal.confirmedAt) : null;
  const end = goal.endedAt ? Date.parse(goal.endedAt) : now;
  const wallSeconds = start === null ? 0 : Math.max(0, (end - start) / 1000);
  return [
    {
      key: 'tokens',
      label: 'Token',
      used: usage.tokens,
      max: budget.maxTokens,
      usedText: usage.tokens.toLocaleString(),
      maxText: budget.maxTokens.toLocaleString(),
    },
    {
      key: 'steps',
      label: t('步骤尝试', 'Step attempts'),
      used: usage.steps,
      max: budget.maxSteps,
      usedText: String(usage.steps),
      maxText: String(budget.maxSteps),
    },
    {
      key: 'revisions',
      label: t('计划修订', 'Plan revisions'),
      used: usage.revisions,
      max: budget.maxRevisions,
      usedText: String(usage.revisions),
      maxText: String(budget.maxRevisions),
    },
    {
      key: 'wallClock',
      label: t('用时', 'Wall clock'),
      used: wallSeconds,
      max: budget.maxWallClockSeconds,
      usedText: durationText(wallSeconds, t),
      maxText: durationText(budget.maxWallClockSeconds, t),
    },
  ];
}

/** The budget dimensions used up (`used ≥ max`; a revision budget of 0 is not "used up" — it only
 *  means no revision is allowed). */
export function exhaustedBudget(rows: readonly BudgetRow[]): readonly BudgetRow[] {
  return rows.filter((row) => row.max > 0 && row.used >= row.max);
}

// ---------------------------------------------------------------------------------------------
// Predicates, observations, Fact checks — read as sentences (plan §4.6 "可读句子")
// ---------------------------------------------------------------------------------------------

const OPS: Readonly<Record<string, readonly [string, string]>> = {
  eq: ['等于', 'equals'],
  ne: ['不等于', 'does not equal'],
  gt: ['大于', 'is greater than'],
  gte: ['不小于', 'is at least'],
  lt: ['小于', 'is less than'],
  lte: ['不大于', 'is at most'],
  contains: ['包含', 'contains'],
};

/** A predicate's comparison as the sentences say it (`exists`: 有值). */
export function predicateOpLabel(op: string, t: Translate): string {
  if (op === 'exists') return t('有值', 'is present');
  const [zh, en] = OPS[op] ?? [op, op];
  return t(zh, en);
}

function jsonValue(value: PredicateJsonValue): string {
  return JSON.stringify(value);
}

/** A predicate as one sentence: `status 等于 "running"`, `以下全部成立：…；…`. */
export function predicateSentence(predicate: Predicate, t: Translate): string {
  if ('all' in predicate) {
    return t(
      `以下全部成立：${predicate.all.map((p) => predicateSentence(p, t)).join('；')}`,
      `all of: ${predicate.all.map((p) => predicateSentence(p, t)).join('; ')}`,
    );
  }
  if ('any' in predicate) {
    return t(
      `以下任一成立：${predicate.any.map((p) => predicateSentence(p, t)).join('；')}`,
      `any of: ${predicate.any.map((p) => predicateSentence(p, t)).join('; ')}`,
    );
  }
  if ('not' in predicate) {
    const inner = predicateSentence(predicate.not, t);
    return t(`并非（${inner}）`, `not (${inner})`);
  }
  if (predicate.op === 'exists') return t(`${predicate.path} 有值`, `${predicate.path} is present`);
  const op = OPS[predicate.op] ?? [predicate.op, predicate.op];
  return t(
    `${predicate.path} ${op[0]} ${jsonValue(predicate.value)}`,
    `${predicate.path} ${op[1]} ${jsonValue(predicate.value)}`,
  );
}

/** An observation check as a sentence; `gateName` is the gatekeeper's name when known. An absence
 *  check (S11 「门确认不存在」 B, no predicate) passes only when the gate answers that the thing
 *  looked up does not exist — which answers mean that is the Operation's (`AbsenceBasis`). */
export function observationSentence(
  check: ObservationCheck | ObservationAbsenceCheck,
  gateName: string | null,
  t: Translate,
): string {
  const gate = gateName ?? shortId(check.gatekeeperId);
  const params = observeParamsText(check);
  if (!('expect' in check)) {
    return params === null
      ? t(
          `在门「${gate}」上调用 ${check.operation}，门回答“要查的东西不存在”才算通过`,
          `Call ${check.operation} on gate “${gate}”; passes only when the gate answers that the thing looked up does not exist`,
        )
      : t(
          `在门「${gate}」上以参数 ${params} 调用 ${check.operation}，门回答“要查的东西不存在”才算通过`,
          `Call ${check.operation} with ${params} on gate “${gate}”; passes only when the gate answers that the thing looked up does not exist`,
        );
  }
  const expect = predicateSentence(check.expect, t);
  return params === null
    ? t(
        `在门「${gate}」上观察 ${check.operation}，期望 ${expect}`,
        `Observe ${check.operation} on gate “${gate}”, expecting ${expect}`,
      )
    : t(
        `在门「${gate}」上以参数 ${params} 观察 ${check.operation}，期望 ${expect}`,
        `Observe ${check.operation} with ${params} on gate “${gate}”, expecting ${expect}`,
      );
}

/** Two checks of one operation differ only in their params, so a sentence names them —
 *  secret-named fields masked, though the kernel has masked them already. */
function observeParamsText(check: ObservationCheck | ObservationAbsenceCheck): string | null {
  return check.params && Object.keys(check.params).length > 0
    ? visibleText(clipMiddle(JSON.stringify(redactSensitive(check.params)), OBSERVE_PARAMS_MAX))
    : null;
}

/** A step's reconcile declaration check (S11 GO3d), read as what the platform looks at when the
 *  action's outcome is unknown. A predicate reads as any observation; an absence call (S11
 *  「门确认不存在」 reconcile) says what it asks — not the acceptance check's "passes only when":
 *  what "not there" counts for is the note under it (#799 UX P3-2). */
export function reconcileCheckSentence(
  check: ObservationCheck | ObservationAbsenceCheck,
  gateName: string | null,
  t: Translate,
): string {
  if ('expect' in check) return observationSentence(check, gateName, t);
  const gate = gateName ?? shortId(check.gatekeeperId);
  const params = observeParamsText(check);
  return params === null
    ? t(
        `在门「${gate}」上调用 ${check.operation}，看要查的东西还在不在`,
        `Call ${check.operation} on gate “${gate}” to see whether the thing looked up is still there`,
      )
    : t(
        `在门「${gate}」上以参数 ${params} 调用 ${check.operation}，看要查的东西还在不在`,
        `Call ${check.operation} with ${params} on gate “${gate}” to see whether the thing looked up is still there`,
      );
}

/** How long the params of an observation may read inline before they are clipped. */
const OBSERVE_PARAMS_MAX = 160;

const CHECK_ERROR: Readonly<Record<string, readonly [string, string]>> = {
  predicate_unsatisfied: ['结果不符合期望', 'The result did not meet the expectation'],
  predicate_undetermined: [
    '结果里没有要检查的值，判断不了',
    'The result lacked the value to check, so it could not be judged',
  ],
  attempts_exhausted: ['试满了次数仍没有结论', 'Ran out of attempts without an answer'],
  fact_not_observed: [
    '没看到能作证据的事实：要在这一轮开始之后观察到，而且不是这个目标自己造成的',
    'No fact that can serve as evidence was seen: it must be observed after this round began, and not be this goal’s own doing',
  ],
  requester_may_not_read_facts: [
    '请求人读不到图谱里的事实',
    'The requester cannot read facts in the graph',
  ],
  // S11 「门确认不存在」 B: an absence check's.
  target_still_present: [
    '它还在：门返回了它，而不是回答它不存在',
    'It is still there: the gate returned it rather than answering that it does not exist',
  ],
  absence_not_declared: [
    '这个 Operation 现在的版本没有声明哪些回答表示不存在，检查做不了',
    'The Operation’s version in force declares no answer that means “not there”, so the check cannot be made',
  ],
  absence_not_reviewed: [
    '这个 Operation 现在的版本发布时没有人确认门用的凭据看得到要查的东西，它的“不存在”证明不了什么，检查不做',
    'Nobody confirmed, when the Operation’s version in force was published, that the gate’s credentials can see what it looks up; its “not there” proves nothing, so the check is not made',
  ],
  // A gate call that got no answer, or a refusal (#786 UX P3: said, not shown as a code).
  gate_unreachable: ['连不上门', 'The gate could not be reached'],
  gate_connection_lost: [
    '和门的连接断了，没收到回答',
    'The connection to the gate dropped before it answered',
  ],
  operation_refused: ['门拒绝了这次调用', 'The gate refused the call'],
  // Legacy 507: a look before the work whose answer did not show the thing.
  presence_not_confirmed: [
    '门回答了，但回答里看不出它在（空结果，或者不符合 Operation 声明的结果映射）',
    'The gate answered, but its answer does not show the thing there (an empty result, or not the shape the Operation’s result mapping declares)',
  ],
  // S11 「门确认不存在」 B-c.
  never_seen_present: [
    '平台用同样的调用没有一次看到过它在：现在它不在，证明不了是这个目标删掉的，检查不做',
    'No look of the platform’s with the same call ever saw it there: its absence now does not show this goal removed it, so the check is not made',
  ],
};

/** What went wrong at a check's last attempt (`lastError`, a short code the kernel keeps): the
 *  common ones in words, any other as its code. */
export function checkErrorLabel(code: string, t: Translate): string {
  const known = CHECK_ERROR[code];
  if (known) return t(known[0], known[1]);
  const shown = visibleText(code);
  return t(`上次没成功（代码 ${shown}）`, `The last attempt did not succeed (code ${shown})`);
}

/** Why a try did not succeed, for a sentence that already says it did not (#786 UX P3): the
 *  label of a known code, else just the code — not 「上次没成功」 again. */
export function checkErrorReason(code: string, t: Translate): string {
  const known = CHECK_ERROR[code];
  if (known) return t(known[0], known[1]);
  const shown = visibleText(code);
  return t(`代码 ${shown}`, `code ${shown}`);
}

/** Legacy 470: an end given as an Object already in the graph reads as `objectNames`' 「名字 ·
 *  类型」 for it (`useObjectLabels`), as the editor shows it; only one not read (yet) falls back to
 *  its short id. */
function objectRefText(ref: FactObjectRef, t: Translate, objectNames: ObjectNames): string {
  if ('objectId' in ref) {
    const name = objectNames.get(ref.objectId);
    if (name !== undefined) return name;
    return t(`对象 ${shortId(ref.objectId)}`, `object ${shortId(ref.objectId)}`);
  }
  const identity = Object.entries(ref.identity)
    .map(([key, value]) => `${key}=${jsonValue(value as PredicateJsonValue)}`)
    .join(', ');
  return `${ref.objectType}（${identity}）`;
}

/** The Objects a Fact check names by id, for `useObjectLabels`. */
export function factCheckObjectIds(fact: FactCheck | null | undefined): string[] {
  if (!fact) return [];
  return [fact.source, fact.target].flatMap((ref) => ('objectId' in ref ? [ref.objectId] : []));
}

/** The Objects a goal's checks name by id — the plan's, every acceptance round's and every
 *  step's — for `useObjectLabels`. */
export function goalCheckObjectIds(detail: GoalDetailWire): string[] {
  const ids = new Set<string>();
  const add = (fact: FactCheck | null | undefined) => {
    for (const id of factCheckObjectIds(fact)) ids.add(id);
  };
  for (const check of detail.planRevision.plan.acceptance ?? []) {
    if (check.kind === 'fact_predicate') add(check.fact);
  }
  for (const round of detail.acceptance.rounds) for (const check of round.checks) add(check.fact);
  for (const step of detail.planRevision.plan.steps) {
    for (const check of step.acceptance ?? []) if (check.kind === 'fact_predicate') add(check.fact);
  }
  return [...ids];
}

/** A Fact check as a sentence. */
export function factCheckSentence(
  fact: FactCheck,
  t: Translate,
  objectNames: ObjectNames = NO_NAMES,
): string {
  const source = objectRefText(fact.source, t, objectNames);
  const target = objectRefText(fact.target, t, objectNames);
  if (fact.expect === undefined) {
    return t(
      `图谱里出现从 ${source} 到 ${target} 的「${fact.linkType}」事实`,
      `A “${fact.linkType}” fact from ${source} to ${target} appears in the graph`,
    );
  }
  const expect = predicateSentence(fact.expect, t);
  return t(
    `图谱里出现从 ${source} 到 ${target} 的「${fact.linkType}」事实，且 ${expect}`,
    `A “${fact.linkType}” fact from ${source} to ${target} appears in the graph, with ${expect}`,
  );
}

/** A check of the plan as a sentence; `gateNames` names the gatekeepers known so far. */
export function planCheckSentence(
  check: AcceptanceCheck,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
  objectNames: ObjectNames = NO_NAMES,
): string {
  switch (check.kind) {
    case 'observe_predicate':
    case 'observe_absent':
      return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
    case 'fact_predicate':
      return factCheckSentence(check.fact, t, objectNames);
    case 'requester_confirm':
      return check.prompt;
  }
}

/** An absence check of the plan in force (S11 「门确认不存在」 B) — the goal's (`stepKey` null) or
 *  a step's. */
export interface AbsenceCheckRef {
  readonly key: string;
  readonly stepKey: string | null;
  readonly check: ObservationAbsenceCheck;
}

/** The plan's absence checks, the goal's first and then each step's in plan order. */
export function planAbsenceChecks(plan: GoalPlan): AbsenceCheckRef[] {
  const found: AbsenceCheckRef[] = [];
  for (const check of plan.acceptance ?? []) {
    if (check.kind === 'observe_absent') {
      found.push({ key: check.key, stepKey: null, check: check.check });
    }
  }
  for (const step of plan.steps) {
    for (const check of step.acceptance ?? []) {
      if (check.kind === 'observe_absent') {
        found.push({ key: check.key, stepKey: step.key, check: check.check });
      }
    }
  }
  return found;
}

/** S11 「门确认不存在」 B-c: the platform's latest look, before the work it judges, for the absence
 *  check `checkKey` of the goal (`stepKey` null) or of step `stepKey` — get_goal lists only looks
 *  with the call the plan in force makes. */
export function absenceBaselineOf(
  detail: Pick<GoalDetailWire, 'acceptance'>,
  stepKey: string | null,
  checkKey: string,
): GoalAbsenceBaselineWire | undefined {
  return detail.acceptance.absenceBaselines.find(
    (baseline) => baseline.stepKey === stepKey && baseline.checkKey === checkKey,
  );
}

/** S11 「门确认不存在」 reconcile: the absence check whose look a step's reconcile declaration goes
 *  by when its check is an absence call — the step's own `observe_absent` check with the same call,
 *  else the goal's (the kernel refuses a plan with neither) — or `null` for a declaration with a
 *  predicate, or none found. */
export function reconcileAbsenceCheckOf(
  goalAcceptance: readonly AcceptanceCheck[],
  stepAcceptance: readonly {
    readonly kind: string;
    readonly key: string;
    readonly check?: unknown;
  }[],
  check: ObservationCheck | ObservationAbsenceCheck,
): { readonly key: string; readonly ofGoal: boolean } | null {
  if ('expect' in check) return null;
  const same = (candidate: { readonly kind: string; readonly check?: unknown }) =>
    candidate.kind === 'observe_absent' && canonicalJson(candidate.check) === canonicalJson(check);
  const own = stepAcceptance.find(same);
  if (own) return { key: own.key, ofGoal: false };
  const goal = goalAcceptance.find(same);
  return goal ? { key: goal.key, ofGoal: true } : null;
}

/** `value` as JSON with object keys sorted — two calls compare equal whatever order their params
 *  were written in, as the kernel compares them. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** S11 「门确认不存在」 B-c (#786 review #501): when the run's first attempt started — of any step,
 *  superseded ones too — or `null` while none has. A look made after it came once the work had
 *  begun (a revision changed the check), so a thing it did not see may be an earlier step's doing. */
export function goalFirstAttemptAt(detail: Pick<GoalDetailWire, 'steps'>): string | null {
  let first: string | null = null;
  for (const step of detail.steps) {
    for (const attempt of step.attempts) {
      if (first === null || Date.parse(attempt.createdAt) < Date.parse(first)) {
        first = attempt.createdAt;
      }
    }
  }
  return first;
}

/** The key the Operation an absence check calls is read under (`useAbsenceOperations`). */
export function absenceOperationKey(
  check: Pick<ObservationAbsenceCheck, 'gatekeeperId' | 'operation'>,
): string {
  return `${check.gatekeeperId}::${check.operation}`;
}

/** A check of an acceptance round as a sentence. */
export function roundCheckSentence(
  check: GoalAcceptanceCheckWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
  objectNames: ObjectNames = NO_NAMES,
): string {
  if (check.check) {
    return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
  }
  if (check.fact) return factCheckSentence(check.fact, t, objectNames);
  return check.prompt ?? '';
}

// ---------------------------------------------------------------------------------------------
// Steps and revisions
// ---------------------------------------------------------------------------------------------

export interface StepView {
  readonly key: string;
  /** The step as the plan in force defines it — `null` for a StepRun no longer in that plan. */
  readonly planStep: PlanStep | null;
  /** The step's live StepRun — `null` until the goal is confirmed. */
  readonly run: StepRunWire | null;
}

/** The plan in force's steps in plan order, each with its live StepRun, and the StepRuns a
 *  revision replaced (oldest first). */
export function goalSteps(detail: GoalDetailWire): {
  readonly current: readonly StepView[];
  readonly superseded: readonly StepRunWire[];
} {
  const live = new Map<string, StepRunWire>();
  const superseded: StepRunWire[] = [];
  for (const run of detail.steps) {
    if (run.supersededInRevision === null) live.set(run.stepKey, run);
    else superseded.push(run);
  }
  const current: StepView[] = detail.planRevision.plan.steps.map((step) => ({
    key: step.key,
    planStep: step,
    run: live.get(step.key) ?? null,
  }));
  // A live StepRun whose key the plan in force does not name (should not happen): still shown.
  const named = new Set(detail.planRevision.plan.steps.map((step) => step.key));
  for (const run of live.values()) {
    if (!named.has(run.stepKey)) current.push({ key: run.stepKey, planStep: null, run });
  }
  return { current, superseded };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export interface PlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly acceptanceChanged: boolean;
}

/** What a revision changed against the one it was based on: steps added, removed or redefined
 *  (by key), and whether the goal's acceptance checks changed. */
export function planDiff(before: GoalPlan, after: GoalPlan): PlanDiff {
  const beforeSteps = new Map(before.steps.map((step) => [step.key, stableJson(step)]));
  const afterSteps = new Map(after.steps.map((step) => [step.key, stableJson(step)]));
  const added = [...afterSteps.keys()].filter((key) => !beforeSteps.has(key));
  const removed = [...beforeSteps.keys()].filter((key) => !afterSteps.has(key));
  const changed = [...afterSteps.entries()]
    .filter(([key, json]) => beforeSteps.has(key) && beforeSteps.get(key) !== json)
    .map(([key]) => key);
  return {
    added,
    removed,
    changed,
    acceptanceChanged: stableJson(before.acceptance ?? []) !== stableJson(after.acceptance ?? []),
  };
}

// ---------------------------------------------------------------------------------------------
// The goal's state, in a sentence or two
// ---------------------------------------------------------------------------------------------

export interface GoalStateNote {
  readonly tone: 'info' | 'warn' | 'danger';
  readonly text: string;
}

/**
 * What the goal is doing or waiting on, for the top of its page. `unresolved` is
 * `list_goal_unresolved_actions` when it was read (`undefined` while loading or refused): with it,
 * a goal paused for a check whose findings are all recorded says it can go on. With the run's
 * `acceptance` (get_goal), a goal paused because the platform's look before its work did not see
 * what an absence check removes says so (S11 「门确认不存在」 B-c). With its `planRevision`, a goal
 * paused at a step that would not start says which step and why (S11 GO8a: a paused run's read
 * carries the hints of its steps that have not started).
 */
export function goalStateNote(
  goal: GoalRunWire &
    Partial<Pick<GoalDetailWire, 'acceptance' | 'steps' | 'planRevision' | 'trialApprovals'>>,
  unresolved: readonly UnresolvedGoalActionWire[] | undefined,
  budget: readonly BudgetRow[],
  t: Translate,
): GoalStateNote | null {
  switch (goal.status) {
    case 'proposed':
      return {
        tone: 'warn',
        text: t(
          '等请求人确认计划、验收检查和预算；确认之后才开始。',
          'Waiting for the requester to confirm the plan, its checks and budget; nothing starts before that.',
        ),
      };
    case 'running':
      return null;
    case 'verifying':
      return {
        tone: 'info',
        text: t(
          '所有步骤都已完成，平台正在做目标的验收检查。',
          'Every step is done; the platform is making the goal’s acceptance checks.',
        ),
      };
    case 'paused':
      return pausedNote(goal, unresolved, budget, t);
    case 'cancelling':
      return {
        tone: 'warn',
        text: t(
          '正在取消：不再开始新的步骤，等仍在运行的任务和执行中的动作结束。',
          'Cancelling: no new step starts; waiting for running tasks and executing actions to end.',
        ),
      };
    case 'cancelled':
      return goal.cleanupPending
        ? {
            tone: 'warn',
            text: t(
              '已取消，但有残留：取消时还有任务或动作在运行，动作执行了就撤不回，它们会自己结束。下面列出了它们。',
              'Cancelled with leftovers: tasks or actions were still running when it was cancelled; an executing action cannot be taken back and ends on its own. They are listed below.',
            ),
          }
        : null;
    case 'completed':
      return completedNote(goal, t);
    case 'failed':
      return {
        tone: 'danger',
        text: t(
          '平台推进这个目标时出了无法恢复的错误，目标失败。已执行的动作和写入的事实不受影响。',
          'The platform hit an error it could not recover from while advancing this goal. Actions already run and facts written stay.',
        ),
      };
  }
}

function pausedNote(
  goal: GoalRunWire &
    Partial<Pick<GoalDetailWire, 'acceptance' | 'steps' | 'planRevision' | 'trialApprovals'>>,
  unresolved: readonly UnresolvedGoalActionWire[] | undefined,
  budget: readonly BudgetRow[],
  t: Translate,
): GoalStateNote {
  switch (goal.pauseReason) {
    case 'requested':
      return goal.pausedByAuthority === 'owner'
        ? {
            tone: 'warn',
            text: t(
              '这个目标已被工作区所有者锁定（谁锁定的见概览里的「暂停人」）：请求人要等所有者解除锁定才能继续，在此之前仍可以改计划、结束或取消它。',
              'A workspace owner holds this goal (who, under Paused by in the overview): its requester can resume it once an owner lifts the hold, and can still revise, end or cancel it meanwhile.',
            ),
          }
        : {
            tone: 'info',
            text: t(
              '请求人暂停了这个目标，继续之前不会开始新的步骤。',
              'The requester paused this goal; no step starts until it resumes.',
            ),
          };
    case 'budget_exhausted': {
      const spent = exhaustedBudget(budget)
        .map((row) => row.label)
        .join(t('、', ', '));
      return {
        tone: 'warn',
        text: spent
          ? t(
              `预算用完（${spent}），目标暂停了，这不是失败。`,
              `Budget used up (${spent}); the goal is paused, not failed.`,
            )
          : t(
              '预算用完，目标暂停了，这不是失败。',
              'Budget used up; the goal is paused, not failed.',
            ),
      };
    }
    case 'no_progress':
      return {
        tone: 'warn',
        text: t(
          '连续几次推进都没有进展，平台把它暂停了，需要人决定下一步。',
          'Several rounds made no progress, so the platform paused it; a person decides what next.',
        ),
      };
    case 'authority_lost': {
      const hints = pauseHints(goal, AUTHORITY_PAUSE_HINTS);
      if (hints.some((hint) => hint.code === 'requester_cannot_start_workers')) {
        return {
          tone: 'warn',
          text: t(
            '请求人现在不能启动 Worker（角色不允许，或已被停用），目标暂停了。可以请工作区所有者在「成员与授权」查看请求人的角色和状态；恢复之后才能继续。',
            'The requester cannot start Workers now (their role, or they are disabled), so the goal is paused. A workspace owner can check their role and status in Members; it goes on once that is back.',
          ),
        };
      }
      const steps = stepKeysOf(hints);
      if (steps.length > 0) {
        const [zh, en] = namesIn(steps);
        const one = steps.length === 1;
        const held = heldWording(goal, steps);
        return {
          tone: 'warn',
          text: t(
            `请求人已经没有步骤${zh}需要的授权，${one ? '这一步' : '这些步骤'}${held.zh}，目标暂停了。授权恢复或改计划之后才能继续，见下面「步骤」里的说明。`,
            `The requester no longer holds what ${one ? 'step' : 'steps'} ${en} ${one ? 'needs, so it' : 'need, so they'} ${held.en(!one)} and the goal is paused until that authority is back or the plan changes. See the notes under Steps.`,
          ),
        };
      }
      return {
        tone: 'warn',
        text: t(
          '请求人已经没有下一步需要的授权，目标暂停了。授权恢复或改计划之后才能继续。',
          'The requester no longer holds what the next step needs; the goal is paused until that authority is back or the plan changes.',
        ),
      };
    }
    case 'needs_decision': {
      if (
        goal.acceptance?.absenceBaselines.some(
          (baseline) =>
            baseline.status === 'never_seen_present' || baseline.status === 'unavailable',
        )
      ) {
        return {
          tone: 'warn',
          text: t(
            '需要人决定：平台事先看某条“不存在”检查要删的东西时，没看到它在（或者没能看），所以目标没有往下做。见下面验收和步骤里标出的检查。',
            'A person must decide: when the platform looked first for what an absence check removes, it did not see it there (or could not look), so the goal did not go on. See the checks marked under Acceptance and Steps.',
          ),
        };
      }
      // #780 UX P3-5: the goal's own checks did not pass, and no step failed — nothing is marked
      // among the steps; what is marked is under Acceptance.
      if (
        goal.acceptance?.rounds
          .at(-1)
          ?.checks.some((check) => check.status === 'failed' || check.status === 'unavailable') &&
        !goal.steps?.some((step) => step.status === 'failed')
      ) {
        return {
          tone: 'warn',
          text: t(
            '需要人决定：目标的验收检查没通过，或者做不了。见下面「验收」里标出的检查。',
            'A person must decide: the goal’s acceptance checks did not pass, or could not be made. See the checks marked under Acceptance.',
          ),
        };
      }
      // S11 GO8a: a step that would not start as the plan has it — what its WorkerSpec names cannot
      // be used, or the requester's agent settings exclude its Worker — while no step failed.
      if (!goal.steps?.some((step) => step.status === 'failed')) {
        const admission = admissionPauseText(goal, pauseHints(goal, ADMISSION_PAUSE_HINTS), t);
        if (admission) return { tone: 'warn', text: admission };
        // S11 GO8b: nothing stops the step any more but the pause — approving never resumes.
        const approved = pendingTrialStepKeys(goal);
        if (approved.length > 0) {
          const [zh, en] = namesIn(approved);
          return {
            tone: 'info',
            text: t(
              `步骤${zh}的 Skill 草稿已批准试用。目标不会自己继续：请求人按「继续」后，${approved.length === 1 ? '这一步' : '这些步骤'}用批准的草稿开始。`,
              `The trial of step ${en}’s draft Skills is approved. The goal does not go on by itself: once the requester resumes it, ${approved.length === 1 ? 'the step starts' : 'the steps start'} with the drafts approved.`,
            ),
          };
        }
      }
      return {
        tone: 'warn',
        text: t(
          '需要人决定：验收没通过、动作被拒绝或过期，或核对发现动作没生效。见下面标出的步骤。',
          'A person must decide: a check did not pass, an action was rejected or expired, or a check found an action did not take effect. See the steps marked below.',
        ),
      };
    }
    case 'awaiting_reconcile': {
      const findingsLeft = unresolved?.filter((action) => action.needs === 'finding').length;
      if (findingsLeft === 0) {
        return {
          tone: 'info',
          text: t('核对已记录，可以继续。', 'The checks are recorded; the goal can go on.'),
        };
      }
      return {
        tone: 'warn',
        text: t(
          '有动作结果不明：要先有人去目标系统核对它是否生效，其他步骤才会继续。见下面的「待核对的动作」。',
          'An action’s outcome is unknown: someone has to check the target system first, before anything else runs. See “Actions to check” below.',
        ),
      };
    }
    default:
      return { tone: 'warn', text: t('目标已暂停。', 'The goal is paused.') };
  }
}

/** The hints a pause of `authority_lost` names (S11 GO8a): the requester's authority over a step. */
const AUTHORITY_PAUSE_HINTS: ReadonlySet<PlanHint['code']> = new Set([
  'requester_cannot_start_workers',
  'step_gate_not_held',
  'step_capability_not_held',
]);

/** The hints a pause of `needs_decision` names (S11 GO8a): a step that would not start as it is. */
const ADMISSION_PAUSE_HINTS: ReadonlySet<PlanHint['code']> = new Set([
  'step_skill_draft',
  'step_skill_deprecated',
  'step_model_not_offered',
  'step_model_not_allowed',
  'step_definition_excluded',
  'step_worker_unavailable',
  'step_skill_version_unavailable',
]);

/** Why a step did not go on, as a pause note lists several reasons of one step (UX on #853 P3-2):
 *  the step's chip (zh) and a clause (en). */
const ADMISSION_REASON: Readonly<Partial<Record<PlanHint['code'], readonly [string, string]>>> = {
  step_skill_draft: ['Skill 还是草稿', 'a Skill is still a draft'],
  step_skill_deprecated: ['Skill 已弃用', 'a Skill was deprecated'],
  step_model_not_offered: ['模型不在目录里', 'its model is not in the catalog'],
  step_model_not_allowed: ['模型不允许', 'its model is not allowed'],
  step_definition_excluded: ['智能体设置已排除', 'the agent settings exclude its Worker'],
  step_worker_unavailable: ['Worker 已不再发布', 'its Worker is no longer published'],
  step_skill_version_unavailable: [
    '上次用的 Skill 版本不可用',
    'a Skill version its last attempt used is gone',
  ],
};

/** How a pause note says the steps it names were held: before their first attempt (`没有开始`),
 *  or before being tried again (`没有再试` — a later attempt is admitted too, its authority and
 *  its model; `views.ts` hints those steps). */
function heldWording(
  goal: Partial<Pick<GoalDetailWire, 'steps'>>,
  stepKeys: readonly string[],
): { readonly zh: string; readonly en: (plural: boolean) => string } {
  const tried = stepKeys.map(
    (key) =>
      (goal.steps ?? []).find((step) => step.stepKey === key && step.supersededInRevision === null)
        ?.attemptCount ?? 0,
  );
  if (tried.every((count) => count === 0)) {
    return { zh: '没有开始', en: () => 'did not start' };
  }
  if (tried.every((count) => count > 0)) {
    return {
      zh: '没有再试',
      en: (plural) => (plural ? 'were not tried again' : 'was not tried again'),
    };
  }
  return { zh: '没有往下做', en: () => 'did not go on' };
}

/** The hints of `codes` that say why the run paused: of the steps the advancer tried to start —
 *  `ready`, in the revision in force — or about the requester as a whole. A step still pending
 *  waits for others first: its hint is in the steps card, not the reason for this pause. */
function pauseHints(
  goal: Partial<Pick<GoalDetailWire, 'steps' | 'planRevision'>>,
  codes: ReadonlySet<PlanHint['code']>,
): readonly PlanHint[] {
  const ready = new Set(
    (goal.steps ?? [])
      .filter((step) => step.status === 'ready' && step.supersededInRevision === null)
      .map((step) => step.stepKey),
  );
  return (goal.planRevision?.hints ?? []).filter(
    (hint) => codes.has(hint.code) && (hint.stepKey === undefined ? true : ready.has(hint.stepKey)),
  );
}

function stepKeysOf(hints: readonly PlanHint[]): readonly string[] {
  return [...new Set(hints.flatMap((hint) => (hint.stepKey === undefined ? [] : [hint.stepKey])))];
}

/** Why a step did not start (or was not tried again) as the plan has it, for a run paused
 *  `needs_decision` (S11 GO8a): the one step and its reason, every reason when it has several. */
function admissionPauseText(
  goal: Partial<Pick<GoalDetailWire, 'steps'>>,
  hints: readonly PlanHint[],
  t: Translate,
): string | null {
  const steps = stepKeysOf(hints);
  if (steps.length === 0) return null;
  const [hint] = hints;
  if (steps.length > 1 || hint === undefined) {
    const [zh, en] = namesIn(steps);
    return t(
      `需要人决定：步骤${zh}不能照计划往下做。见下面「步骤」里的说明。`,
      `A person must decide: steps ${en} cannot go on as the plan has them. See the notes under Steps.`,
    );
  }
  const step = hint.stepKey ?? '';
  if (hints.length > 1) {
    const reasons = hints.flatMap((each) => {
      const reason = ADMISSION_REASON[each.code];
      return reason ? [reason] : [];
    });
    return t(
      `需要人决定：步骤「${step}」不能照计划往下做：${reasons.map(([zh]) => zh).join('、')}。见下面「步骤」里的说明。`,
      `A person must decide: step “${step}” cannot go on as the plan has it: ${reasons.map(([, en]) => en).join(', ')}. See the notes under Steps.`,
    );
  }
  const held = heldWording(goal, [step]);
  const heldEn = held.en(false);
  const [skillsZh, skillsEn] = namesIn(hintSkillsShown(hint));
  switch (hint.code) {
    case 'step_skill_draft':
      return hint.trial !== undefined
        ? t(
            `需要人决定：步骤「${step}」的 Worker 要用的 Skill${skillsZh}还只是草稿，这一步${held.zh}。能发布它的人可以在下面「步骤」里这一步的提示下批准试用，之后请求人按「继续」；也可以在「能力目录」发布之后按「继续」，或者在对话里让入口智能体修订计划换掉它。`,
            `A person must decide: the Worker of step “${step}” uses Skill ${skillsEn}, still a draft, so the step ${heldEn}. Someone who may publish it can approve a trial from the step’s note under Steps, and the requester then resumes; or publish it in Catalog and resume, or ask the entry agent in chat to revise the plan and change it.`,
          )
        : t(
            `需要人决定：步骤「${step}」的 Worker 要用的 Skill${skillsZh}还只是草稿，这一步${held.zh}。在「能力目录」发布之后按「继续」，或者在对话里让入口智能体修订计划换掉它，见下面「步骤」里的说明。`,
            `A person must decide: the Worker of step “${step}” uses Skill ${skillsEn}, still a draft, so the step ${heldEn}. Once it is published in Catalog, resume the goal, or ask the entry agent in chat to revise the plan and change it. See the note under Steps.`,
          );
    case 'step_skill_deprecated':
      return t(
        `需要人决定：步骤「${step}」的 Worker 要用的 Skill${skillsZh}已经弃用，这一步${held.zh}。在对话里让入口智能体修订计划，换一个已发布的 Skill 之后才能继续，见下面「步骤」里的说明。`,
        `A person must decide: the Worker of step “${step}” uses Skill ${skillsEn}, which was deprecated, so the step ${heldEn}. It goes on once the entry agent, asked in chat, revises the plan to a published Skill. See the note under Steps.`,
      );
    case 'step_worker_unavailable':
      return t(
        `需要人决定：步骤「${step}」用的 Worker 版本已经不再发布，这一步${held.zh}。在对话里让入口智能体修订计划换一个已发布的 Worker，或者在「修订计划…」里移除这一步，见下面「步骤」里的说明。`,
        `A person must decide: step “${step}” uses a Worker version that is no longer published, so the step ${heldEn}. Ask the entry agent in chat to revise the plan to a published Worker, or remove the step under “Revise plan…”. See the note under Steps.`,
      );
    case 'step_skill_version_unavailable':
      return t(
        `需要人决定：步骤「${step}」上一次尝试用的 Skill${skillsZh}现在不能再用了，重试要用同一个版本，所以这一步${held.zh}。在对话里让入口智能体修订计划改动这一步，它会按现在的 Skill 重新开始；或者在「修订计划…」里移除这一步，见下面「步骤」里的说明。`,
        `A person must decide: the Skill ${skillsEn} the last attempt of step “${step}” used can no longer be used, and a retry uses the same version, so the step ${heldEn}. Ask the entry agent in chat to revise the plan and change the step, which then starts afresh with the Skills as they are now; or remove the step under “Revise plan…”. See the note under Steps.`,
      );
    case 'step_model_not_offered':
      return t(
        `需要人决定：步骤「${step}」给 Worker 设定的模型「${hint.model ?? ''}」已经不在模型目录里，这一步${held.zh}。见下面「步骤」里的说明。`,
        `A person must decide: step “${step}” sets its Worker’s model to “${hint.model ?? ''}”, which the model catalog no longer offers, so the step ${heldEn}. See the note under Steps.`,
      );
    case 'step_model_not_allowed':
      return t(
        `需要人决定：步骤「${step}」给 Worker 设定的模型「${hint.model ?? ''}」不在这个工作区允许的模型里，这一步${held.zh}。见下面「步骤」里的说明。`,
        `A person must decide: step “${step}” sets its Worker’s model to “${hint.model ?? ''}”, which this workspace does not allow, so the step ${heldEn}. See the note under Steps.`,
      );
    default:
      return t(
        `需要人决定：请求人的智能体设置排除了步骤「${step}」的 Worker，这一步${held.zh}。见下面「步骤」里的说明。`,
        `A person must decide: the requester’s agent settings exclude the Worker of step “${step}”, so the step ${heldEn}. See the note under Steps.`,
      );
  }
}

function completedNote(goal: GoalRunWire, t: Translate): GoalStateNote | null {
  if (goal.outcome === null) return null;
  const basis = goal.outcomeBasis ? outcomeBasisLabel(goal.outcomeBasis, t) : null;
  if (goal.outcome === 'achieved') {
    return {
      tone: 'info',
      text: basis
        ? t(`目标已达成，${basis}。`, `Achieved — ${basis.toLowerCase()}.`)
        : t('目标已达成。', 'Achieved.'),
    };
  }
  return {
    tone: 'warn',
    text: basis
      ? t(`目标按未达成结束，${basis}。`, `Ended as not achieved — ${basis.toLowerCase()}.`)
      : t('目标按未达成结束。', 'Ended as not achieved.'),
  };
}

/** What one unresolved action still needs, and — when its step declared one — where the
 *  platform's own check of it stands. `paused`: the goal is paused or held, so no check runs
 *  (GO3d: a pending check waits for the goal to go on). */
/** The line under an unresolved action's check sentence naming the platform check's last error —
 *  none where that sentence already says what the code means: `never_seen_present` there is the
 *  runner not asking the gate at all, which the acceptance-check label would contradict (#799 UX
 *  P2-2). */
export function unresolvedCheckErrorText(
  action: UnresolvedGoalActionWire,
  t: Translate,
): string | null {
  const code = action.platformCheck?.lastError;
  if (!code || code === 'never_seen_present') return null;
  return checkErrorLabel(code, t);
}

export function unresolvedActionText(
  action: UnresolvedGoalActionWire,
  paused: boolean,
  t: Translate,
): { readonly needs: string; readonly check: string } {
  const needs =
    action.needs === 'finding'
      ? t(
          '要有人去目标系统核对：它生效了吗？',
          'Someone has to check the target system: did it take effect?',
        )
      : t(
          '已核对为没有生效：要决定重新执行，或者改计划。',
          'Found not to have taken effect: decide to run it again, or change the plan.',
        );
  const check = action.platformCheck;
  if (check === null) {
    return {
      needs,
      check: t(
        '这一步没有为它声明平台核对，只能由人核对。删除这类动作也能交给平台核对：在这一步加一条核对声明，用门查“不存在”的调用；计划里还要有同一个调用的“不存在”验收检查，平台在动作之前用它看到过它在，之后门回答不在才算生效。',
        'This step declared no platform check for it, so only a person can check it. A removal can be checked by the platform too: give this step a reconcile declaration that asks the gate whether the thing is gone, and give the plan an absence check with the same call. The platform looks with that check before the action, and the gate answering "not there" counts as the action having taken effect only if that look saw the thing there.',
      ),
    };
  }
  switch (check.status) {
    case 'pending':
      return {
        needs,
        check: paused
          ? t('核对已暂停，继续后再核对。', 'Checking is paused; it resumes when the goal goes on.')
          : t(
              `平台核对中（已试 ${check.attempts} 次）；核对出结果会自己记下，不用人做。`,
              `The platform is checking (${check.attempts} attempt(s) so far); a result is recorded on its own.`,
            ),
      };
    case 'seen':
      return { needs, check: t('平台已看到效果。', 'The platform saw the effect.') };
    case 'not_seen':
      return {
        needs,
        check: t(
          '平台没看到效果：要有人核对后记下结果，平台不会自己重新执行。',
          'The platform did not see the effect: a person records what they find; it never runs again on its own.',
        ),
      };
    case 'unavailable':
      return {
        needs,
        check:
          check.lastError === 'never_seen_present'
            ? t(
                '平台核对不了：动作之前平台没有看到过它在，就算门回答它不在，也证明不了是这个动作删掉的，所以平台没有去问门。要有人核对后记下结果。',
                'The platform could not check: it never saw the thing there before the action, so even the gate answering that it is not there would not show this action removed it, and the platform did not ask the gate. A person records what they find.',
              )
            : t(
                '平台核对不了（观察被拒绝或一直没有答复）：要有人核对后记下结果。',
                'The platform could not check (the observation was refused or never answered): a person records what they find.',
              ),
      };
    case 'preempted':
      return { needs, check: t('已由人核对。', 'A person recorded a finding first.') };
  }
}

const ACTION_FAILURE: Readonly<Record<ActionRequestFailureKind, readonly [string, string]>> = {
  not_delivered: ['没有送达，没执行', 'Not delivered — nothing ran'],
  refused: ['被拒绝', 'Refused'],
  outcome_unknown: ['结果不明', 'Outcome unknown'],
};

/** How an action of a step failed (`StepActionWire.failureKind`). */
export function actionFailureLabel(kind: ActionRequestFailureKind, t: Translate): string {
  const [zh, en] = ACTION_FAILURE[kind];
  return t(zh, en);
}

/** Legacy 513: why a step's action was refused or not delivered, by its code
 *  (`StepActionWire.failureCode`) — the reason's text stays with the request (its approval page). */
const ACTION_FAILURE_CODE: Readonly<Record<ActionFailureCode, readonly [string, string]>> = {
  gate_unreachable: ['连不上门', 'The gate could not be reached'],
  gate_token_unavailable: [
    '平台没有调用这个门的凭据',
    'The platform holds no token to call this gate',
  ],
  connection_secret_missing: [
    '这个门还没有连接密钥，所有者可以在门的详情里签发',
    'The gate has no connection secret yet; an owner can issue one on the gate’s page',
  ],
  gate_not_found: ['门的地址上没有这个门', 'No gate answered at its address'],
  apply_not_received: ['门上没有它执行过的记录', 'The gate has no record of running it'],
  operation_disabled: ['这个动作在平台上被停用了', 'The Operation is disabled on the platform'],
  operation_definition_unavailable: ['没有批准过的定义', 'No approved definition'],
  target_refused: ['门的地址不是允许的目标', 'The gate’s address is not an allowed target'],
  redirect_refused: [
    '门要求跳转到别处，平台不跟随',
    'The gate answered with a redirect the platform does not follow',
  ],
  unauthorized: ['门不接受平台的身份', 'The gate did not accept the platform’s credentials'],
  operation_not_found: ['门上没有这个动作', 'The gate has no such Operation'],
  invalid_params: ['门认为参数不对', 'The gate found the parameters invalid'],
  invalid_operation_schema: ['动作的参数定义无效', 'The Operation’s parameter schema is invalid'],
  operation_definition_mismatch: [
    '门运行的定义和批准的不一样',
    'The gate runs another definition than the approved one',
  ],
  operation_refused: ['门拒绝了这次调用', 'The gate refused the call'],
  credential_unavailable: [
    '门上没有这次调用可用的凭证：按成员连接账户的门，是请求人还没有在「系统与授权」里「录入我的凭证」',
    'The gate holds no credential for this call: on a gate where members connect their own account, the requester has not used “Enter my credential” in Systems & access yet',
  ],
};

/** Why a step's action was refused or not delivered, as a sentence. */
export function actionFailureCodeText(code: ActionFailureCode, t: Translate): string {
  const [zh, en] = ACTION_FAILURE_CODE[code];
  return t(zh, en);
}

const RECONCILIATION: Readonly<Record<ActionRequestReconciliation, readonly [string, string]>> = {
  effect_seen: ['核对：已生效', 'Checked: took effect'],
  effect_absent: ['核对：未见效果', 'Checked: no effect found'],
};

/** What a check found about an action whose outcome was unknown (`reconciliation`). */
export function reconciliationLabel(finding: ActionRequestReconciliation, t: Translate): string {
  const [zh, en] = RECONCILIATION[finding];
  return t(zh, en);
}
