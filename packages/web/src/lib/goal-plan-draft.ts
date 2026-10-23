import {
  type AcceptanceCheck,
  DEFAULT_MAX_ATTEMPTS,
  type GoalBudget,
  type GoalDetailWire,
  type GoalPlan,
  MAX_ACCEPTANCE_PROMPT_CHARS,
  MAX_REVISION_REASON_CHARS,
  type PlanStep,
  SECRET_FIELD_MASK,
  STEP_KEY_PATTERN,
  type StepRemoval,
  type StepRunWire,
} from '@nexttime/shared';
import { planDiff } from './goals.js';
import type { Translate } from './i18n.js';

/**
 * lib/goal-plan-draft (S11 GO6, plan editor): a revision of a GoalRun's plan as the console edits
 * it (`revise_goal`, GO5b) — seeded from the plan in force as the page read it, so nothing the
 * person did not touch changes: a step keeps every field the editor does not offer (its reconcile
 * declarations, its own acceptance checks, `nested`), an input left as it was keeps its value, an
 * unchanged dependency list keeps its order. What the editor offers is chosen where it can be (a
 * Worker and its version from the published ones, dependencies from the plan's own steps, attempts
 * within the platform's limit); only a new step's key, its input and the texts are typed.
 *
 * The kernel decides (400 `invalid_params` with `details.problems`, 409 for a stale base or a step
 * that cannot change); `draftProblems` only keeps a revision the kernel would certainly refuse
 * from being sent, and says where. Every problem — the editor's and the kernel's — is keyed by
 * the field it is about (`FieldKey`), so it shows on that field.
 */

/** Where a problem shows: one field of the editor, or the plan as a whole. */
export type FieldKey =
  | `step:${string}:${'key' | 'worker' | 'dependsOn' | 'maxAttempts' | 'input'}`
  | `step:${string}`
  | `check:${string}:prompt`
  | `check:${string}`
  | `budget:${keyof GoalBudget}`
  | 'reason'
  | 'plan';

export interface StepDraft {
  /** Stable across renames: the React key and the problems' anchor. */
  readonly uid: string;
  /** The step as the plan in force has it; `null` for a step this revision adds. */
  readonly original: PlanStep | null;
  readonly key: string;
  readonly definitionId: string;
  /** The version as the select holds it (`''` until a definition is picked). */
  readonly version: string;
  readonly dependsOn: readonly string[];
  /** `''`: the platform's default. */
  readonly maxAttempts: string;
  /** The input as JSON text; `''`: no input. */
  readonly inputText: string;
  readonly removed: boolean;
}

export interface CheckDraft {
  readonly uid: string;
  /** The check as the plan in force has it; `null` for a confirmation this revision adds. */
  readonly original: AcceptanceCheck | null;
  readonly key: string;
  /** A `requester_confirm` check's prompt; the editor changes no other kind of check. */
  readonly prompt: string;
  readonly removed: boolean;
}

/** Budget fields as typed; wall clock in minutes. */
export interface BudgetDraft {
  readonly maxTokens: string;
  readonly maxSteps: string;
  readonly maxRevisions: string;
  readonly maxWallClockMinutes: string;
}

export interface PlanDraft {
  readonly steps: readonly StepDraft[];
  readonly acceptance: readonly CheckDraft[];
  readonly budget: BudgetDraft;
  readonly reason: string;
  /** Per live step this revision removes or changes: terminate (absent) or let it finish. */
  readonly removals: Readonly<Record<string, StepRemoval>>;
}

/** Statuses of a step after which its definition cannot change (the kernel's `ENDED`). */
const ENDED_STEP_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'superseded',
  'cancelled',
  'skipped',
]);

/** Step statuses with a Task that may still be running — where terminating or letting it finish
 *  differ. */
const TASK_LIVE_STEP_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting']);

/** A step's requests a revision letting it finish may release (the kernel's withdrawable set). */
const RELEASABLE_ACTION_STATUSES: ReadonlySet<string> = new Set([
  'pending_approval',
  'approved',
  'auto_approved',
]);

export function prettyInput(input: unknown): string {
  return input === undefined ? '' : JSON.stringify(input, null, 2);
}

function minutesText(seconds: number): string {
  return String(Math.round((seconds / 60) * 100) / 100);
}

let uidCounter = 0;
export function newUid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

export function draftFromDetail(detail: GoalDetailWire): PlanDraft {
  const plan = detail.planRevision.plan;
  return {
    steps: plan.steps.map((step) => ({
      uid: newUid('step'),
      original: step,
      key: step.key,
      definitionId: step.worker.definitionId,
      version: String(step.worker.version),
      dependsOn: step.dependsOn ?? [],
      maxAttempts: step.maxAttempts === undefined ? '' : String(step.maxAttempts),
      inputText: prettyInput(step.input),
      removed: false,
    })),
    acceptance: (plan.acceptance ?? []).map((check) => ({
      uid: newUid('check'),
      original: check,
      key: check.key,
      prompt: check.kind === 'requester_confirm' ? check.prompt : '',
      removed: false,
    })),
    budget: {
      maxTokens: String(detail.budget.maxTokens),
      maxSteps: String(detail.budget.maxSteps),
      maxRevisions: String(detail.budget.maxRevisions),
      maxWallClockMinutes: minutesText(detail.budget.maxWallClockSeconds),
    },
    reason: '',
    removals: {},
  };
}

export function emptyStep(): StepDraft {
  return {
    uid: newUid('step'),
    original: null,
    key: '',
    definitionId: '',
    version: '',
    dependsOn: [],
    maxAttempts: '',
    inputText: '',
    removed: false,
  };
}

export function requesterConfirmDraft(draft: PlanDraft): CheckDraft {
  const taken = new Set(draft.acceptance.map((check) => check.key));
  let key = 'requester-confirm';
  for (let n = 2; taken.has(key); n += 1) key = `requester-confirm-${n}`;
  return { uid: newUid('check'), original: null, key, prompt: '', removed: false };
}

/** Whether the draft holds a `requester_confirm` check that stays (a plan has at most one). */
export function hasRequesterConfirm(draft: PlanDraft): boolean {
  return draft.acceptance.some(
    (check) =>
      !check.removed && (check.original === null || check.original.kind === 'requester_confirm'),
  );
}

/** The live StepRun of each key of the plan in force. */
export function liveRuns(detail: GoalDetailWire): ReadonlyMap<string, StepRunWire> {
  return new Map(
    detail.steps
      .filter((run) => run.supersededInRevision === null)
      .map((run) => [run.stepKey, run] as const),
  );
}

/** Whether a step of the plan in force has ended — its definition is then fixed (it may only be
 *  dropped, staying as history). */
export function stepEnded(run: StepRunWire | undefined): boolean {
  return run !== undefined && ENDED_STEP_STATUSES.has(run.status);
}

/** The requests of a step a revision letting it finish may release. */
export function releasableActions(run: StepRunWire | undefined): readonly string[] {
  return (run?.actions ?? [])
    .filter((action) => RELEASABLE_ACTION_STATUSES.has(action.status))
    .map((action) => action.actionRequestId);
}

/** Whether a JSON value shows the `[redacted]` mark anywhere. */
export function showsMask(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(SECRET_FIELD_MASK);
  if (value === null || typeof value !== 'object') return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(showsMask);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/** The plan the draft stands for — `null` while an input is not JSON (`draftProblems` says
 *  where). */
export function planOf(draft: PlanDraft): GoalPlan | null {
  const steps: PlanStep[] = [];
  for (const step of draft.steps) {
    if (step.removed) continue;
    // A field set to `undefined` is left out: on the wire (JSON) and in `planDiff` alike.
    const next: Record<string, unknown> = { ...(step.original ?? {}) };
    next.key = step.key;
    next.worker = { definitionId: step.definitionId, version: Number(step.version) };
    const originalDeps = step.original?.dependsOn ?? [];
    if (step.dependsOn.length === 0) next.dependsOn = undefined;
    else
      next.dependsOn = sameSet(step.dependsOn, originalDeps) ? originalDeps : [...step.dependsOn];
    if (step.maxAttempts === '') next.maxAttempts = undefined;
    else next.maxAttempts = Number(step.maxAttempts);
    if (step.inputText !== prettyInput(step.original?.input)) {
      if (step.inputText.trim() === '') next.input = undefined;
      else {
        const parsed = parseJson(step.inputText);
        if (!parsed.ok) return null;
        next.input = parsed.value;
      }
    }
    steps.push(next as PlanStep);
  }
  const acceptance: AcceptanceCheck[] = draft.acceptance
    .filter((check) => !check.removed)
    .map((check) =>
      check.original === null
        ? { kind: 'requester_confirm', key: check.key, prompt: check.prompt }
        : check.original.kind === 'requester_confirm'
          ? { ...check.original, prompt: check.prompt }
          : check.original,
    );
  const original = draft.acceptance.some((check) => check.original !== null);
  return acceptance.length > 0 || original ? { steps, acceptance } : { steps };
}

/** The budget the draft brings — `null` when it is the current one (none is sent). */
export function budgetOf(draft: PlanDraft, current: GoalBudget): GoalBudget | null {
  const minutes = draft.budget.maxWallClockMinutes;
  const budget: GoalBudget = {
    maxTokens: Number(draft.budget.maxTokens),
    maxSteps: Number(draft.budget.maxSteps),
    maxRevisions: Number(draft.budget.maxRevisions),
    maxWallClockSeconds:
      minutes === minutesText(current.maxWallClockSeconds)
        ? current.maxWallClockSeconds
        : Math.round(Number(minutes) * 60),
  };
  const same =
    budget.maxTokens === current.maxTokens &&
    budget.maxSteps === current.maxSteps &&
    budget.maxRevisions === current.maxRevisions &&
    budget.maxWallClockSeconds === current.maxWallClockSeconds;
  return same ? null : budget;
}

/** The live steps (a Task may still run) this revision removes or changes — the ones a person
 *  decides about: terminate, or let finish and release some of their requests. */
export function supersededLiveSteps(draft: PlanDraft, detail: GoalDetailWire): readonly string[] {
  const plan = planOf(draft);
  if (plan === null) return [];
  const diff = planDiff(detail.planRevision.plan, plan);
  const runs = liveRuns(detail);
  return [...diff.removed, ...diff.changed].filter((key) => {
    const run = runs.get(key);
    return run !== undefined && TASK_LIVE_STEP_STATUSES.has(run.status);
  });
}

/** The removals to send: only the steps let to finish (terminate is the default), and only
 *  steps this revision does supersede. */
export function removalsOf(
  draft: PlanDraft,
  detail: GoalDetailWire,
): Record<string, StepRemoval> | null {
  const live = new Set(supersededLiveSteps(draft, detail));
  const entries = Object.entries(draft.removals).filter(
    ([key, removal]) => live.has(key) && removal.mode === 'let_finish',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

const positiveInt = (text: string) => /^\d+$/.test(text.trim()) && Number(text) > 0;

/**
 * What would certainly be refused, by field: a key that is not one or is taken, no Worker or
 * version, a dependency on a step that is not (or no longer) in the plan, a cycle, an input that
 * is not JSON, text that still holds the `[redacted]` mark a read put where a credential stood, a
 * blank or too long text, a budget that is not a positive number or allows no further revision.
 */
export function draftProblems(
  draft: PlanDraft,
  detail: GoalDetailWire,
  t: Translate,
): ReadonlyMap<FieldKey, string> {
  const problems = new Map<FieldKey, string>();
  const masked = t(
    `此处原文已遮蔽，请重新填写：${SECRET_FIELD_MASK} 是读出时遮住的疑似凭据，原文不会再显示；把它改成不带凭据的写法。`,
    `The original here was masked; write it again: ${SECRET_FIELD_MASK} stands for what looked like a credential when it was read, and the original is never shown again. Write it without the credential.`,
  );
  const kept = draft.steps.filter((step) => !step.removed);
  const keys = new Map<string, number>();
  for (const step of kept) keys.set(step.key, (keys.get(step.key) ?? 0) + 1);
  if (kept.length === 0) {
    problems.set('plan', t('计划至少要有一个步骤。', 'A plan needs at least one step.'));
  }
  const runs = liveRuns(detail);
  for (const step of kept) {
    const at = (field: 'key' | 'worker' | 'dependsOn' | 'maxAttempts' | 'input') =>
      `step:${step.uid}:${field}` as const;
    if (!STEP_KEY_PATTERN.test(step.key)) {
      problems.set(
        at('key'),
        t(
          '步骤名用字母或数字开头，只含字母、数字、. _ -，最长 64 个字符。',
          'A step key starts with a letter or digit and holds only letters, digits, . _ - (at most 64).',
        ),
      );
    } else if ((keys.get(step.key) ?? 0) > 1) {
      problems.set(at('key'), t('和另一个步骤同名。', 'Another step has this key.'));
    } else if (
      step.original === null &&
      detail.planRevision.plan.steps.some((other) => other.key === step.key) &&
      stepEnded(runs.get(step.key))
    ) {
      problems.set(
        at('key'),
        t(
          '已结束的步骤名不能复用：换一个新名字。',
          'An ended step’s key cannot be reused: pick a new one.',
        ),
      );
    }
    if (step.definitionId === '' || step.version === '') {
      problems.set(at('worker'), t('选一个 Worker 和版本。', 'Pick a Worker and its version.'));
    }
    const missing = step.dependsOn.filter(
      (dep) => !kept.some((other) => other.key === dep && other.uid !== step.uid),
    );
    if (missing.length > 0) {
      problems.set(
        at('dependsOn'),
        t(
          `依赖的步骤不在计划里了：${missing.join('、')}。取消勾选，或者恢复那一步。`,
          `Depends on steps no longer in the plan: ${missing.join(', ')}. Untick them, or restore the step.`,
        ),
      );
    }
    if (step.inputText !== prettyInput(step.original?.input) && step.inputText.trim() !== '') {
      const parsed = parseJson(step.inputText);
      if (!parsed.ok) {
        problems.set(
          at('input'),
          t(`输入不是合法的 JSON：${parsed.error}`, `The input is not valid JSON: ${parsed.error}`),
        );
      } else if (showsMask(parsed.value)) {
        problems.set(at('input'), masked);
      }
    } else if (showsMask(step.original?.input) && step.inputText.trim() !== '') {
      problems.set(
        at('input'),
        stepEnded(runs.get(step.key))
          ? t(
              `这一步已结束，定义不能再改，可它的输入里有遮蔽的原文（${SECRET_FIELD_MASK}），不能原样再提交：把它从计划里移除（它的记录仍然保留）。`,
              `This step has ended, so it cannot change, yet its input holds masked text (${SECRET_FIELD_MASK}) that cannot be sent back as it is: remove it from the plan (its record stays).`,
            )
          : masked,
      );
    }
  }
  const cycle = dependencyCycle(kept);
  if (cycle !== null) {
    const first = kept.find((step) => step.key === cycle[0]);
    if (first) {
      problems.set(
        `step:${first.uid}:dependsOn`,
        t(
          `依赖成环：${cycle.join(' → ')}。去掉其中一条依赖。`,
          `The dependencies form a cycle: ${cycle.join(' → ')}. Drop one of them.`,
        ),
      );
    }
  }
  for (const check of draft.acceptance) {
    if (check.removed) continue;
    const isConfirm = check.original === null || check.original.kind === 'requester_confirm';
    if (!isConfirm) continue;
    const at = `check:${check.uid}:prompt` as const;
    if (check.prompt.trim() === '') {
      problems.set(at, t('写上要请求人确认什么。', 'Say what the requester confirms.'));
    } else if (check.prompt.length > MAX_ACCEPTANCE_PROMPT_CHARS) {
      problems.set(
        at,
        t(
          `最多 ${MAX_ACCEPTANCE_PROMPT_CHARS} 个字符。`,
          `At most ${MAX_ACCEPTANCE_PROMPT_CHARS} characters.`,
        ),
      );
    } else if (check.prompt.includes(SECRET_FIELD_MASK)) {
      problems.set(at, masked);
    }
  }
  if (draft.reason.length > MAX_REVISION_REASON_CHARS) {
    problems.set(
      'reason',
      t(
        `最多 ${MAX_REVISION_REASON_CHARS} 个字符。`,
        `At most ${MAX_REVISION_REASON_CHARS} characters.`,
      ),
    );
  } else if (draft.reason.includes(SECRET_FIELD_MASK)) {
    problems.set('reason', masked);
  }
  const { budget } = draft;
  const notPositive = t('填一个大于 0 的整数。', 'A whole number above 0.');
  if (!positiveInt(budget.maxTokens)) problems.set('budget:maxTokens', notPositive);
  if (!positiveInt(budget.maxSteps)) problems.set('budget:maxSteps', notPositive);
  if (!(Number(budget.maxWallClockMinutes) > 0)) {
    problems.set('budget:maxWallClockSeconds', t('填一个大于 0 的数。', 'A number above 0.'));
  }
  const needed = detail.usage.revisions + 1;
  if (!/^\d+$/.test(budget.maxRevisions.trim())) {
    problems.set('budget:maxRevisions', t('填一个整数。', 'A whole number.'));
  } else if (Number(budget.maxRevisions) < needed) {
    problems.set(
      'budget:maxRevisions',
      t(
        `这是第 ${needed} 次修订，上限至少要 ${needed}。`,
        `This is revision ${needed}; the limit must be at least ${needed}.`,
      ),
    );
  }
  return problems;
}

/** A cycle among the kept steps' dependencies, as keys, the first repeated at the end; `null`
 *  when none. */
export function dependencyCycle(steps: readonly StepDraft[]): string[] | null {
  const deps = new Map(steps.map((step) => [step.key, step.dependsOn] as const));
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'open') return [...path.slice(path.indexOf(key)), key];
    state.set(key, 'open');
    path.push(key);
    for (const dep of deps.get(key) ?? []) {
      if (!deps.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    state.set(key, 'done');
    return null;
  };
  for (const step of steps) {
    const found = visit(step.key);
    if (found) return found;
  }
  return null;
}

/**
 * The field a refusal's `details.field` names (GO5c's `credentials_in_text` /
 * `redacted_text_submitted` on `revise_goal`): `reason`, `plan.steps.<i>…` (the i-th step sent,
 * `…input…` its input), `plan.acceptance.<i>…` (the i-th check sent). Anything else: the plan.
 */
export function fieldOfRefusal(field: string, draft: PlanDraft): FieldKey {
  if (field === 'reason') return 'reason';
  const step = /^(?:plan\.)?steps(?:\.|\[)(\d+)\]?(?:\.(.*))?$/.exec(field);
  if (step) {
    const sent = draft.steps.filter((item) => !item.removed)[Number(step[1])];
    if (sent === undefined) return 'plan';
    const rest = step[2] ?? '';
    if (rest.startsWith('input')) return `step:${sent.uid}:input`;
    if (rest === 'key') return `step:${sent.uid}:key`;
    return `step:${sent.uid}`;
  }
  const check = /^(?:plan\.)?acceptance(?:\.|\[)(\d+)\]?(?:\.(.*))?$/.exec(field);
  if (check) {
    const sent = draft.acceptance.filter((item) => !item.removed)[Number(check[1])];
    if (sent === undefined) return 'plan';
    return check[2]?.startsWith('prompt') ? `check:${sent.uid}:prompt` : `check:${sent.uid}`;
  }
  return 'plan';
}

/** Where one of the kernel's plan problems (`details.problems`, `path: message`) belongs: the
 *  step or check its path or wording names, else the plan. */
export function fieldOfProblem(problem: string, draft: PlanDraft): FieldKey {
  const path = /^(?:plan\.)?((?:steps|acceptance)\.\d+(?:\.[\w.]+)?):/.exec(problem);
  if (path?.[1]) return fieldOfRefusal(path[1], draft);
  const named = /step "([^"]+)"/.exec(problem);
  if (named) {
    const step = draft.steps.find((item) => !item.removed && item.key === named[1]);
    if (step) return `step:${step.uid}`;
  }
  return 'plan';
}

/** The plan's default attempts per step, for the select's first option. */
export const DEFAULT_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
