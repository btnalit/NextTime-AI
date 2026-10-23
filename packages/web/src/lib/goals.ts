import type {
  ActionRequestFailureKind,
  ActionRequestReconciliation,
  FactCheck,
  FactObjectRef,
  GoalAcceptanceCheckKind,
  GoalDetailWire,
  GoalOutcomeBasis,
  GoalPlan,
  GoalRunPauseReason,
  GoalRunStatus,
  GoalRunWire,
  ObservationCheck,
  PlanHint,
  PlanStep,
  Predicate,
  PredicateJsonValue,
  StepAcceptanceState,
  StepRemoval,
  StepRunFailureCategory,
  StepRunWaitingReason,
  StepRunWire,
  UnresolvedGoalActionWire,
} from '@nexttime/shared';
import { shortId } from './format.js';
import type { Translate } from './i18n.js';

/**
 * lib/goals (S11 GO6): what the console's goal pages (`components/goals/*`) read out of the
 * `goal` capability group's one wire shape (`wire/goal.ts`) — the sentences for its sub-states, a
 * plan's predicates, its budget, and the difference between two plan revisions. No capability
 * calls and no React: the pages call and render. Read-only for now — the operations (confirm,
 * pause, resume, cancel, revise) arrive with GO5b, so nothing here names a button.
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
      'Worker 的结果不符合约定的格式，或没有报告结果，需要人决定。',
      'The Worker’s result did not match its schema, or none was reported; a person decides.',
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

const PLAN_HINT: Readonly<Record<PlanHint['code'], readonly [string, string]>> = {
  requester_confirm_only: [
    '这个计划没有平台能做的验收检查：目标是否达成只凭请求人确认。',
    'No check the platform makes: the goal is achieved only on the requester’s word.',
  ],
};

export function planHintText(hint: PlanHint, t: Translate): string {
  const entry = PLAN_HINT[hint.code];
  return entry ? t(entry[0], entry[1]) : hint.message;
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
        `让它跑完（结果只入库不推进），放行 ${released} 条已提交的动作`,
        `Let it finish (result recorded, not advanced); ${released} submitted action(s) released`,
      )
    : t('让它跑完（结果只入库不推进）', 'Let it finish (result recorded, not advanced)');
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
  return t(
    `在门「${gate}」上观察 ${check.operation}，期望 ${expect}`,
    `Observe ${check.operation} on gate “${gate}”, expecting ${expect}`,
  );
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
              '工作区所有者暂停了这个目标（锁定）：请求人不能自己继续，要等所有者解除。',
              'A workspace owner paused this goal (a hold): the requester cannot resume it until an owner lifts it.',
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
