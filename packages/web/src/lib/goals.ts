import type {
  AcceptanceCheck,
  ActionRequestFailureKind,
  ActionRequestReconciliation,
  FactCheck,
  FactObjectRef,
  GoalAcceptanceCheckKind,
  GoalAcceptanceCheckWire,
  GoalDetailWire,
  GoalOutcomeBasis,
  GoalPlan,
  GoalRunPauseReason,
  GoalRunStatus,
  GoalRunWire,
  ObservationCheck,
  OutputJsonValue,
  OutputSchema,
  OutputSchemaType,
  PlanHint,
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
} from '@nexttime/shared';
import { visibleText } from '@nexttime/shared';
import { actionLabel } from './capability-labels.js';
import { clipMiddle, redactSensitive, shortId } from './format.js';
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

/** The fields an output contract asks the step's Worker to hand back, in the schema's order — the
 *  root is always an object (`StepOutputSchemaSchema`). */
export function outputContractFields(schema: OutputSchema, t: Translate): readonly OutputField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, node]) => ({
    name,
    kind: outputKindText(node, t),
    required: required.has(name),
    description: node.description ?? null,
  }));
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

const CHECK_KIND: Readonly<Record<GoalAcceptanceCheckKind, readonly [string, string]>> = {
  observe_predicate: ['平台观察', 'Platform observation'],
  fact_predicate: ['事实判定', 'Fact check'],
  requester_confirm: ['请求人确认', 'Requester confirms'],
};

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

/** What a step's hint (S11 GO5c) says would happen — the run pauses at the step for a person. */
const STEP_HINT_CONSEQUENCE = [
  '这一步不会开始，目标会停在这里等人处理。',
  'the step would not start, and the goal would pause there for a person.',
] as const;

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

/** A list in a sentence: each name in 「」 joined by 、 (zh), in quotes joined by commas (en). */
function namesIn(names: readonly string[]): readonly [string, string] {
  return [
    names.map((name) => `「${name}」`).join('、'),
    names.map((name) => `“${name}”`).join(', '),
  ];
}

interface PlanHintArgs {
  readonly step: string;
  /** What to do about a missing grant, where the hint is read. */
  readonly next: readonly [string, string];
  /** The gates a `step_gate_not_held` step needs, by name where known. */
  readonly gates: readonly string[];
  /** The execute permissions a `step_capability_not_held` step needs, by their console names. */
  readonly capabilities: readonly (readonly [string, string])[];
}

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
  step_gate_not_held: ({ step, gates, next }) => {
    const [zh, en] = namesIn(gates);
    return [
      `步骤「${step}」的 Worker 要操作门${zh}，请求人现在没有${gates.length === 1 ? '这个门' : '这些门'}的权限：${STEP_HINT_CONSEQUENCE[0]}${next[0]}`,
      `Step “${step}”: its Worker acts on ${gates.length === 1 ? 'gate' : 'gates'} ${en}, which the requester cannot act on now — ${STEP_HINT_CONSEQUENCE[1]} ${next[1]}`,
    ];
  },
  step_capability_not_held: ({ step, capabilities, next }) => {
    if (capabilities.length === 0) {
      return [
        `步骤「${step}」的 Worker 需要请求人现在没有的执行权限：${STEP_HINT_CONSEQUENCE[0]}${next[0]}`,
        `Step “${step}”: its Worker needs an execute permission the requester does not hold now — ${STEP_HINT_CONSEQUENCE[1]} ${next[1]}`,
      ];
    }
    const [zh] = namesIn(capabilities.map(([name]) => name));
    const [, en] = namesIn(capabilities.map(([, name]) => name));
    return [
      `步骤「${step}」的 Worker 需要执行权限${zh}，请求人现在没有：${STEP_HINT_CONSEQUENCE[0]}${next[0]}`,
      `Step “${step}”: its Worker needs the execute ${capabilities.length === 1 ? 'permission' : 'permissions'} ${en}, which the requester does not hold now — ${STEP_HINT_CONSEQUENCE[1]} ${next[1]}`,
    ];
  },
  step_definition_excluded: ({ step }) => [
    `请求人的智能体设置排除了步骤「${step}」的 Worker：${STEP_HINT_CONSEQUENCE[0]}请求人可以在「我的智能体」里调整设置。`,
    `The requester’s agent profile excludes the Worker of step “${step}” — ${STEP_HINT_CONSEQUENCE[1]} The requester can change it in My Agent.`,
  ],
};

const inZh: Translate = (zh) => zh;
const inEn: Translate = (_, en) => en;

export function planHintText(
  hint: PlanHint,
  t: Translate,
  gateNames: ReadonlyMap<string, string> = new Map(),
  context: PlanHintContext = 'proposal',
): string {
  const entry = PLAN_HINT[hint.code];
  if (!entry) return hint.message;
  const [zh, en] = entry({
    step: hint.stepKey ?? '',
    next: GRANT_NEXT_STEP[context],
    gates: (hint.gatekeeperIds ?? []).map((id) => gateNames.get(id) ?? shortId(id)),
    capabilities: (hint.capabilityNames ?? []).map(
      (name) => [actionLabel(name, inZh), actionLabel(name, inEn)] as const,
    ),
  });
  return t(zh, en);
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
    default:
      return null;
  }
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

/** An observation check as a sentence; `gateName` is the gatekeeper's name when known. */
export function observationSentence(
  check: ObservationCheck,
  gateName: string | null,
  t: Translate,
): string {
  const gate = gateName ?? shortId(check.gatekeeperId);
  const expect = predicateSentence(check.expect, t);
  // Two checks of one operation differ only in their params, so the sentence names them —
  // secret-named fields masked, though the kernel has masked them already.
  const params =
    check.params && Object.keys(check.params).length > 0
      ? visibleText(clipMiddle(JSON.stringify(redactSensitive(check.params)), OBSERVE_PARAMS_MAX))
      : null;
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
};

/** What went wrong at a check's last attempt (`lastError`, a short code the kernel keeps): the
 *  common ones in words, any other as its code. */
export function checkErrorLabel(code: string, t: Translate): string {
  const known = CHECK_ERROR[code];
  if (known) return t(known[0], known[1]);
  const shown = visibleText(code);
  return t(`上次没成功（代码 ${shown}）`, `The last attempt did not succeed (code ${shown})`);
}

function objectRefText(ref: FactObjectRef, t: Translate): string {
  if ('objectId' in ref)
    return t(`对象 ${shortId(ref.objectId)}`, `object ${shortId(ref.objectId)}`);
  const identity = Object.entries(ref.identity)
    .map(([key, value]) => `${key}=${jsonValue(value as PredicateJsonValue)}`)
    .join(', ');
  return `${ref.objectType}（${identity}）`;
}

/** A Fact check as a sentence. */
export function factCheckSentence(fact: FactCheck, t: Translate): string {
  const source = objectRefText(fact.source, t);
  const target = objectRefText(fact.target, t);
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
): string {
  switch (check.kind) {
    case 'observe_predicate':
      return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
    case 'fact_predicate':
      return factCheckSentence(check.fact, t);
    case 'requester_confirm':
      return check.prompt;
  }
}

/** A check of an acceptance round as a sentence. */
export function roundCheckSentence(
  check: GoalAcceptanceCheckWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string {
  if (check.check) {
    return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
  }
  if (check.fact) return factCheckSentence(check.fact, t);
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
 * a goal paused for a check whose findings are all recorded says it can go on.
 */
export function goalStateNote(
  goal: GoalRunWire,
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
  goal: GoalRunWire,
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
    case 'authority_lost':
      return {
        tone: 'warn',
        text: t(
          '请求人已经没有下一步需要的授权，目标暂停了。授权恢复或改计划之后才能继续。',
          'The requester no longer holds what the next step needs; the goal is paused until that authority is back or the plan changes.',
        ),
      };
    case 'needs_decision':
      return {
        tone: 'warn',
        text: t(
          '需要人决定：验收没通过、动作被拒绝或过期，或核对发现动作没生效。见下面标出的步骤。',
          'A person must decide: a check did not pass, an action was rejected or expired, or a check found an action did not take effect. See the steps marked below.',
        ),
      };
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
        '这一步没有声明平台核对，只能由人核对。像删除这样的动作，效果是“查不到”，平台不把“查不到”当成证据，所以总是交给人核对。',
        'This step declared no platform check, so only a person can check it. An action like a deletion leaves only “nothing found”, which the platform does not take as evidence, so it always goes to a person.',
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
        check: t(
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

const RECONCILIATION: Readonly<Record<ActionRequestReconciliation, readonly [string, string]>> = {
  effect_seen: ['核对：已生效', 'Checked: took effect'],
  effect_absent: ['核对：未见效果', 'Checked: no effect found'],
};

/** What a check found about an action whose outcome was unknown (`reconciliation`). */
export function reconciliationLabel(finding: ActionRequestReconciliation, t: Translate): string {
  const [zh, en] = RECONCILIATION[finding];
  return t(zh, en);
}
