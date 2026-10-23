import {
  type GoalDetailWire,
  MAX_REVISION_REASON_CHARS,
  MAX_STEP_ATTEMPTS,
  type ReviseGoalResultWire,
  SECRET_FIELD_MASK,
  type StepRunWire,
} from '@nexttime/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../../hooks/useCapability.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type CheckDraft,
  DEFAULT_ATTEMPTS,
  type FieldKey,
  type PlanDraft,
  type StepDraft,
  budgetOf,
  draftFromDetail,
  draftProblems,
  emptyStep,
  fieldOfProblem,
  fieldOfRefusal,
  hasRequesterConfirm,
  liveRuns,
  originalPrompt,
  planOf,
  prettyInput,
  releasableActions,
  removalsOf,
  requesterConfirmDraft,
  shownOnly,
  stepEnded,
  supersededLiveSteps,
  taskLive,
  workerChanged,
} from '../../lib/goal-plan-draft.js';
import {
  goalBudgetRows,
  isStepAuthorityHint,
  planCheckSentence,
  planDiff,
  planHintText,
  stepRemovalText,
} from '../../lib/goals.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import {
  type WorkerDefinitionSummary,
  definitionVersions,
  distinctDefinitionName,
  latestPerDefinition,
  workerDefinitionChoices,
} from '../../lib/tasks.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Field, describedBy } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { DashboardCard } from '../kit/section.js';
import { Select } from '../kit/select.js';
import { StatusChip } from '../kit/status-chip.js';
import { Textarea } from '../kit/textarea.js';
import { ActionChip } from './ActionChip.js';
import {
  type GoalOperationOutcome,
  goalOperationErrors,
  useOperationDone,
} from './GoalOperationsBar.js';

export interface GoalPlanEditorProps {
  readonly goal: GoalDetailWire;
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  /** Leaves the editor, nothing sent. */
  readonly onCancel: () => void;
  /** After the revision — or a refusal because the goal had moved on: the page says so, re-reads
   *  the goal and leaves the editor. */
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

/**
 * components/goals/GoalPlanEditor (S11 GO6, plan editor): the requester revising the plan of a
 * paused goal (`revise_goal`, GO5b) — the plan in force as the page read it, step by step, with
 * what may change chosen where it can be (`lib/goal-plan-draft.ts`): the Worker and its version
 * from the published ones, dependencies from the plan's own steps, attempts within the limit. A
 * step that has ended cannot change (the kernel refuses), so it reads as it is and may only be
 * removed. Checks the platform makes stay as they are (a person adds or changes those through the
 * entry agent); the requester's own confirmation is written here. The budget is prefilled and
 * sent only when changed; a live step this revision removes or changes is terminated unless the
 * person lets it finish and releases some of its requests.
 *
 * Every problem shows on its field: the editor's own before sending (a text still holding the
 * `[redacted]` mark a read put where a credential stood is one — the original is never shown
 * again, so it must be written anew), and the kernel's after (400 `credentials_in_text` /
 * `redacted_text_submitted` on `details.field`, `invalid_params` with `details.problems`). A 409
 * (another revision since, or the goal moved on) leaves the editor and the page says where things
 * stand.
 */
export function GoalPlanEditor({
  goal: latest,
  http,
  gateNames,
  onCancel,
  onDone,
}: GoalPlanEditorProps) {
  const t = useT();
  const can = useRoleCan(http);
  // The revision this draft is made against, as the page showed it when the editor opened. A
  // re-read meanwhile (a push, a retry) moves the steps' states, never the base: sending against
  // the newest revision would overwrite one this draft was never made from (I-G3).
  const [base] = useState(() => latest.planRevision);
  const baseRevision = useState(() => latest.currentRevision ?? latest.planRevision.revision)[0];
  const goal = useMemo(() => ({ ...latest, planRevision: base }), [latest, base]);
  const newer =
    (latest.currentRevision ?? latest.planRevision.revision) !== baseRevision
      ? (latest.currentRevision ?? latest.planRevision.revision)
      : null;
  const [draft, setDraft] = useState<PlanDraft>(() => draftFromDetail(goal));
  // The editor takes the page's place: focus moves to its title so the change is announced.
  const titleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [refused, setRefused] = useState<ReadonlyMap<FieldKey, string>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const definitions = useCapabilityList<WorkerDefinitionSummary>(
    http,
    'list_worker_definitions',
    { kind: 'worker' },
    { autoLoadAll: true },
  );
  const run = useOperationDone(onDone, latest);
  const runs = useMemo(() => liveRuns(goal), [goal]);
  if (can('revise_goal') === false) return null;

  const problems = draftProblems(draft, goal, t);
  const errorOf = (key: FieldKey): string | null => refused.get(key) ?? problems.get(key) ?? null;
  /** A change to the draft; it clears the kernel's refusals on what it touches (`scope`: a field
   *  key, or a step's / check's key prefix) and the one about the plan as a whole. */
  const change = (scope: string, next: (current: PlanDraft) => PlanDraft) => {
    setDraft(next);
    setRefused((current) => {
      const left = new Map(
        [...current].filter(
          ([key]) => key !== 'plan' && key !== scope && !key.startsWith(`${scope}:`),
        ),
      );
      return left.size === current.size ? current : left;
    });
  };
  const changeStep = (uid: string, patch: Partial<StepDraft>) =>
    change(`step:${uid}`, (current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.uid === uid) return { ...step, ...patch };
        // A renamed new step: the steps that depended on it follow the new key.
        const renamed = current.steps.find((other) => other.uid === uid);
        if (patch.key !== undefined && renamed && step.dependsOn.includes(renamed.key)) {
          return {
            ...step,
            dependsOn: step.dependsOn.map((dep) =>
              dep === renamed.key ? (patch.key ?? dep) : dep,
            ),
          };
        }
        return step;
      }),
    }));
  const changeCheck = (uid: string, patch: Partial<CheckDraft>) =>
    change(`check:${uid}`, (current) => ({
      ...current,
      acceptance: current.acceptance.map((check) =>
        check.uid === uid ? { ...check, ...patch } : check,
      ),
    }));

  const plan = planOf(draft);
  const diff = plan === null ? null : planDiff(goal.planRevision.plan, plan);
  const budget = budgetOf(draft, goal.budget);
  const live = supersededLiveSteps(draft, goal);
  const unchanged =
    diff !== null &&
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.acceptanceChanged &&
    budget === null;
  const blocking = problems.size + refused.size;
  const edited = !unchanged || draft.reason.trim() !== '';
  const waitReason =
    newer !== null
      ? t(
          `计划已经有了第 ${newer} 版，这份修订不能再提交。`,
          `The plan is at v${newer} now; this revision can no longer be sent.`,
        )
      : blocking > 0
        ? t(
            `还有 ${blocking} 处要改，见标红的地方。`,
            `${blocking} thing(s) to fix, marked in red.`,
          )
        : unchanged
          ? t('计划和预算都还没有改动。', 'Nothing in the plan or the budget has changed yet.')
          : null;
  const planProblem = errorOf('plan');
  const defs = definitions.state.status === 'ready' ? definitions.state.data.items : undefined;
  const published = defs?.filter((row) => row.status === 'published');

  const submit = async () => {
    if (plan === null) return;
    const removals = removalsOf(draft, goal);
    const reason = draft.reason.trim();
    try {
      await run(
        http.call<ReviseGoalResultWire>('revise_goal', {
          goalRunId: goal.id,
          basedOnRevision: baseRevision,
          plan,
          ...(reason === '' ? {} : { reason }),
          ...(budget === null ? {} : { budget }),
          ...(removals === null ? {} : { removals }),
        }),
        (result) =>
          t(
            `计划已改为第 ${result.revision} 版。目标仍然暂停：要接着执行，按「继续」。`,
            `The plan is now v${result.revision}. The goal is still paused: resume it to go on.`,
          ),
        // S11 GO5c: a step still to start that the requester's authority would not start pauses
        // the run when it gets there. Only this result says so: a read of a run past its proposal
        // carries the plan's own hints, which the acceptance card already shows.
        (result) =>
          result.hints.filter(isStepAuthorityHint).map((hint) => planHintText(hint, t, gateNames)),
      );
    } catch (error) {
      const fields = refusalFields(error, draft, t);
      if (fields === null) throw error;
      setRefused(fields);
      setConfirmOpen(false);
    }
  };

  return (
    <DashboardCard
      title={
        <span ref={titleRef} tabIndex={-1}>
          {t(
            `修订计划（基于第 ${goal.planRevision.revision} 版）`,
            `Revise the plan (from v${goal.planRevision.revision})`,
          )}
        </span>
      }
      data-testid="goal-plan-editor"
    >
      <div className="stack">
        <Notice tone="info">
          {t(
            '改好后提交，计划立即换成新的一版，目标仍然暂停，回到详情页按「继续」才接着执行。没改的步骤沿用原来的进度。',
            'Once sent, the new version is in force at once and the goal stays paused; resume it on the goal page to go on. Steps left as they were keep their progress.',
          )}
        </Notice>
        {newer !== null ? (
          <Notice tone="warn" testId="goal-plan-newer">
            {t(
              `你在改的是第 ${base.revision} 版，这期间计划已经改成第 ${newer} 版：这份修订提交会被拒绝。放弃修改，回到详情页看看新的一版，再决定要不要重新修订。`,
              `You are editing v${base.revision}, and the plan has become v${newer} meanwhile: this revision would be refused. Discard it and look at the new version on the goal page before revising again.`,
            )}
          </Notice>
        ) : null}
        {refused.size > 0 ? (
          <Notice tone="danger" testId="goal-plan-refused">
            {t(
              '没有提交，什么也没改：下面标红的地方要先改。',
              'Nothing was sent or changed: fix what is marked in red below first.',
            )}
          </Notice>
        ) : null}
        {planProblem ? (
          <Notice tone="danger" testId="goal-plan-problem">
            {planProblem}
          </Notice>
        ) : null}

        <section className="stack-s" aria-label={t('步骤', 'Steps')}>
          <span className="section-title">{t('步骤', 'Steps')}</span>
          {draft.steps.map((step) => (
            <StepEditor
              key={step.uid}
              step={step}
              draft={draft}
              run={step.original ? runs.get(step.original.key) : undefined}
              definitions={published}
              allDefinitions={defs}
              errorOf={errorOf}
              onChange={(patch) => changeStep(step.uid, patch)}
              onRemove={() =>
                step.original === null
                  ? change(`step:${step.uid}`, (current) => ({
                      ...current,
                      steps: current.steps.filter((item) => item.uid !== step.uid),
                    }))
                  : changeStep(step.uid, { removed: true })
              }
              onRestore={() => changeStep(step.uid, { removed: false })}
            />
          ))}
          <div>
            <Button
              variant="secondary"
              size="s"
              onClick={() =>
                change('plan', (current) => ({
                  ...current,
                  steps: [...current.steps, emptyStep()],
                }))
              }
              data-testid="goal-plan-add-step"
            >
              {t('加一个步骤', 'Add a step')}
            </Button>
          </div>
        </section>

        {live.length > 0 ? (
          <RemovalEditor
            keys={live}
            draft={draft}
            runs={runs}
            http={http}
            onChange={(key, removal) =>
              change('plan', (current) => {
                const removals = { ...current.removals };
                if (removal === null) delete removals[key];
                else removals[key] = removal;
                return { ...current, removals };
              })
            }
          />
        ) : null}

        <section className="stack-s" aria-label={t('验收', 'Acceptance')}>
          <span className="section-title">{t('验收检查', 'Acceptance checks')}</span>
          {draft.acceptance.length === 0 ? (
            <span className="text-3 text-small">
              {t('计划里没有验收检查。', 'The plan has no acceptance checks.')}
            </span>
          ) : null}
          {draft.acceptance.map((check) => (
            <CheckEditor
              key={check.uid}
              check={check}
              gateNames={gateNames}
              errorOf={errorOf}
              onChange={(patch) => changeCheck(check.uid, patch)}
              onRemove={() =>
                check.original === null
                  ? change(`check:${check.uid}`, (current) => ({
                      ...current,
                      acceptance: current.acceptance.filter((item) => item.uid !== check.uid),
                    }))
                  : changeCheck(check.uid, { removed: true })
              }
              onRestore={() => changeCheck(check.uid, { removed: false })}
            />
          ))}
          <span className="text-3 text-small">
            {t(
              '平台观察和图谱事实这两类检查要在对话里让入口智能体加或改；这里可以移除它们，或者写请求人确认。',
              'Checks the platform observes or judges on the graph are added or changed by the entry agent in a chat; here they can be removed, and the requester’s confirmation written.',
            )}
          </span>
          {hasRequesterConfirm(draft) ? null : (
            <div>
              <Button
                variant="secondary"
                size="s"
                onClick={() =>
                  change('plan', (current) => ({
                    ...current,
                    acceptance: [...current.acceptance, requesterConfirmDraft(current)],
                  }))
                }
                data-testid="goal-plan-add-confirm"
              >
                {t('加一条请求人确认', 'Add a requester confirmation')}
              </Button>
            </div>
          )}
        </section>

        <BudgetEditor
          goal={goal}
          draft={draft}
          errorOf={errorOf}
          onChange={(patch) =>
            change('budget', (current) => ({ ...current, budget: { ...current.budget, ...patch } }))
          }
        />

        <ReasonField
          value={draft.reason}
          error={errorOf('reason')}
          onChange={(reason) => change('reason', (current) => ({ ...current, reason }))}
        />

        <div className="row-wrap">
          <Confirm
            tier="medium"
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            anchor={
              <Button
                variant="primary"
                size="s"
                disabled={waitReason !== null}
                aria-describedby={waitReason !== null ? 'goal-plan-wait' : undefined}
                onClick={() => setConfirmOpen(true)}
                data-testid="goal-plan-submit"
              >
                {t('提交修订…', 'Send the revision…')}
              </Button>
            }
            title={t('提交这次修订', 'Send this revision')}
            impact={impactLines(draft, goal, t)}
            confirmLabel={t('提交修订', 'Send revision')}
            errorOverrides={{
              ...goalOperationErrors(t),
              illegal_transition: t(
                '计划在这期间有了新的版本，或者目标的状态变了，这次修订没有提交。页面已经重读，回到详情页看看现在的计划，再决定要不要重新修订。',
                'The plan got a newer version meanwhile, or the goal moved on, so this revision was not sent. The page has been read again: look at the plan now in force before revising again.',
              ),
            }}
            onConfirm={submit}
            testId="goal-plan-confirm"
          />
          <Confirm
            tier="medium"
            open={discardOpen}
            onOpenChange={setDiscardOpen}
            anchor={
              <Button
                variant="ghost"
                size="s"
                onClick={() => (edited ? setDiscardOpen(true) : onCancel())}
                data-testid="goal-plan-cancel"
              >
                {t('放弃修改', 'Discard changes')}
              </Button>
            }
            title={t('放弃这份修订？', 'Discard this revision?')}
            impact={[
              t(
                '改动不会保存，计划仍是现在的这一版。',
                'Nothing is saved; the plan stays as it is.',
              ),
            ]}
            confirmLabel={t('放弃修改', 'Discard changes')}
            cancelLabel={t('接着改', 'Keep editing')}
            danger
            onConfirm={onCancel}
            testId="goal-plan-discard"
          />
        </div>
        {waitReason !== null ? (
          <p className="text-3 text-small" id="goal-plan-wait" data-testid="goal-plan-wait">
            {waitReason}
          </p>
        ) : null}
      </div>
    </DashboardCard>
  );
}

/** A refusal the editor shows on its fields — `null` for any other error (the confirm shows it).
 *  GO5c names the first place in `details.field` and every place (at most 20) in
 *  `details.suspectedSecretPaths` / `details.paths`; each lands on its field. */
function refusalFields(
  error: unknown,
  draft: PlanDraft,
  t: Translate,
): ReadonlyMap<FieldKey, string> | null {
  if (!(error instanceof HttpError)) return null;
  if (error.code === 'credentials_in_text' || error.code === 'redacted_text_submitted') {
    const credential = error.code === 'credentials_in_text';
    const listed = error.details?.[credential ? 'suspectedSecretPaths' : 'paths'];
    const paths = [
      ...new Set(
        [error.details?.field, ...(Array.isArray(listed) ? listed : [])].filter(
          (path): path is string => typeof path === 'string',
        ),
      ),
    ];
    const fields = new Map<FieldKey, string>();
    for (const path of paths.length > 0 ? paths : [null]) {
      const at = path === null ? 'plan' : fieldOfRefusal(path, draft);
      if (!fields.has(at)) fields.set(at, refusalText(credential, at, path, t));
    }
    return fields;
  }
  if (error.code === 'invalid_params' && Array.isArray(error.details?.problems)) {
    const fields = new Map<FieldKey, string>();
    for (const problem of error.details.problems) {
      if (typeof problem !== 'string') continue;
      const at = fieldOfProblem(problem, draft);
      fields.set(at, fields.has(at) ? `${fields.get(at)}；${problem}` : problem);
    }
    return fields.size > 0 ? fields : null;
  }
  return null;
}

/** What a credential or masked-text refusal says where it lands: on a text the person writes here,
 *  how to write it instead; on a part of a step or check the editor sends as it is, that it cannot
 *  change here and what can be done. */
function refusalText(credential: boolean, at: FieldKey, path: string | null, t: Translate): string {
  const fixed =
    /^step:[^:]+$/.test(at) || /^check:[^:]+$/.test(at)
      ? at.startsWith('step:')
        ? t(
            '这一处在这一步的动作核对声明或步骤验收检查里，这里改不了：把这一步移除（它的记录仍然保留），或者在对话里让入口智能体修订。',
            'This is in the step’s reconcile declarations or acceptance checks, which cannot change here: remove the step (its record stays), or ask the entry agent to revise it in a chat.',
          )
        : t(
            '这一处在这条检查里，这里改不了：移除它，或者在对话里让入口智能体修订。',
            'This is inside the check, which cannot change here: remove it, or ask the entry agent to revise it in a chat.',
          )
      : null;
  const where = at === 'plan' && path ? t(`（位置：${path}）`, ` (at ${path})`) : '';
  if (credential) {
    return (
      t(
        '这里有像凭据的写法（token、key、密码的值，或 Bearer、Authorization、名称=值 这样的写法），已拒绝，什么也没改。',
        'This looks like it carries a credential (a token, key or password value, or a Bearer, Authorization or name=value form), so nothing was changed.',
      ) +
      (fixed ??
        t(
          '把它改成描述，比如「用 deploy 账号的令牌」「密码见运维手册」，不要写值本身。',
          ' Describe it instead — "the deploy account’s token", "password per the runbook" — never the value itself.',
        )) +
      where
    );
  }
  return (
    t(
      `此处原文已遮蔽，请重新填写：${SECRET_FIELD_MASK} 是读出时遮住的疑似凭据，原样提交会把原文换成这个标记，所以已拒绝。`,
      `The original here was masked; write it again: ${SECRET_FIELD_MASK} stands for what looked like a credential, and sending it back would replace the original with the mark, so it was refused.`,
    ) +
    (fixed ?? '') +
    where
  );
}

/** For a text shown as read with what only stands for its original (`shownOnly`): left alone, the
 *  original is kept (GO5c takes an entry equal to its stored one as shown as unchanged). */
function keptAsRead(shown: 'mask' | 'escape' | null, t: Translate): string | null {
  if (shown === null) return null;
  return shown === 'mask'
    ? t(
        `这里有遮蔽的原文（${SECRET_FIELD_MASK}）：不改这一项，提交时原文原样保留；改了就要整段重写，不能留着 ${SECRET_FIELD_MASK}。`,
        `This holds masked text (${SECRET_FIELD_MASK}): left as it is, the original is kept; once changed, write it whole, without ${SECRET_FIELD_MASK}.`,
      )
    : t(
        '这里有显示成 \\u{…} 的看不见的字符：不改这一项，提交时原文原样保留；改了就要把它们删掉或换成真正的字符。',
        'This holds characters nobody can see, shown as \\u{…}: left as it is, the original is kept; once changed, delete them or type the real character.',
      );
}

/** What sending does, for the confirm. */
function impactLines(draft: PlanDraft, goal: GoalDetailWire, t: Translate): string[] {
  const plan = planOf(draft);
  if (plan === null) return [];
  const diff = planDiff(goal.planRevision.plan, plan);
  const removals = removalsOf(draft, goal) ?? {};
  const live = new Set(supersededLiveSteps(draft, goal));
  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(t(`新增步骤：${diff.added.join('、')}`, `Steps added: ${diff.added.join(', ')}`));
  }
  for (const key of diff.removed) {
    lines.push(
      live.has(key)
        ? t(
            `移除 ${key}：${stepRemovalText(removals[key], t)}`,
            `Remove ${key}: ${stepRemovalText(removals[key], t)}`,
          )
        : t(`移除 ${key}`, `Remove ${key}`),
    );
  }
  for (const key of diff.changed) {
    lines.push(
      live.has(key)
        ? t(
            `改动 ${key}：按新定义重新开始；正在跑的：${stepRemovalText(removals[key], t)}`,
            `Change ${key}: starts again on its new definition; what runs now: ${stepRemovalText(removals[key], t)}`,
          )
        : t(`改动 ${key}：按新定义重新开始`, `Change ${key}: starts again on its new definition`),
    );
  }
  if (diff.acceptanceChanged) lines.push(t('验收检查有改动', 'The acceptance checks change'));
  const budget = budgetOf(draft, goal.budget);
  if (budget !== null) {
    const rows = goalBudgetRows({ ...goal, budget }, t);
    lines.push(
      t(
        `预算改为：${rows.map((row) => `${row.label} ${row.maxText}`).join('，')}`,
        `Budget becomes: ${rows.map((row) => `${row.label} ${row.maxText}`).join(', ')}`,
      ),
    );
  }
  lines.push(
    t(
      `用掉一次计划修订（第 ${goal.usage.revisions + 1} 次）；目标仍然暂停，按「继续」才接着执行`,
      `Uses a plan revision (number ${goal.usage.revisions + 1}); the goal stays paused until resumed`,
    ),
  );
  return lines;
}

function StepEditor({
  step,
  draft,
  run,
  definitions,
  allDefinitions,
  errorOf,
  onChange,
  onRemove,
  onRestore,
}: {
  readonly step: StepDraft;
  readonly draft: PlanDraft;
  readonly run: StepRunWire | undefined;
  /** The published Worker definitions (`undefined` until read, or when they could not be). */
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly allDefinitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly errorOf: (key: FieldKey) => string | null;
  readonly onChange: (patch: Partial<StepDraft>) => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}) {
  const t = useT();
  const id = useId();
  const title = step.key === '' ? t('新步骤', 'New step') : step.key;
  if (step.removed) {
    return (
      <div className="row-wrap goal-plan-step" data-testid="goal-plan-step" data-removed="">
        <span className="mono text-3">{title}</span>
        <span className="text-3 text-small">{t('已移除', 'Removed')}</span>
        <Button variant="ghost" size="s" onClick={onRestore} data-testid="goal-plan-step-restore">
          {t('恢复', 'Restore')}
        </Button>
      </div>
    );
  }
  const ended = step.original !== null && stepEnded(run);
  const stepError = errorOf(`step:${step.uid}`);
  const workerName =
    distinctDefinitionName(allDefinitions, step.definitionId, Number(step.version)) ??
    step.definitionId;
  const others = draft.steps.filter(
    (other) =>
      other.uid !== step.uid &&
      other.key !== '' &&
      (!other.removed || step.dependsOn.includes(other.key)),
  );
  const kept = [
    step.original?.reconcile
      ? t(
          `${step.original.reconcile.length} 条动作核对声明`,
          `${step.original.reconcile.length} reconcile declaration(s)`,
        )
      : null,
    step.original?.acceptance
      ? t(
          `${step.original.acceptance.length} 条步骤验收检查`,
          `${step.original.acceptance.length} step acceptance check(s)`,
        )
      : null,
  ].filter((part): part is string => part !== null);
  const inputError = errorOf(`step:${step.uid}:input`);
  return (
    <div className="stack-s goal-plan-step" data-testid="goal-plan-step" data-step-key={step.key}>
      <div className="row-wrap">
        {step.original === null ? (
          <span className="text-small">{t('新步骤', 'New step')}</span>
        ) : (
          <span className="mono">{step.key}</span>
        )}
        {run ? <StatusChip machine="stepRun" status={run.status} size="s" /> : null}
        <Button variant="ghost" size="s" onClick={onRemove} data-testid="goal-plan-step-remove">
          {t('移除', 'Remove')}
        </Button>
      </div>
      {stepError ? (
        <Notice tone="danger" testId="goal-plan-step-problem">
          {stepError}
        </Notice>
      ) : null}
      {ended ? (
        <>
          <span className="text-3 text-small">
            {t(
              `这一步已结束，定义不能再改（Worker ${workerName} v${step.version}）。可以移除它，记录仍然保留；要重做，加一个新名字的步骤。`,
              `This step has ended, so it cannot change (Worker ${workerName} v${step.version}). It can be removed, its record staying; to do it again, add a step with a new key.`,
            )}
          </span>
          {inputError ? (
            <p className="field-error" role="alert" data-testid="goal-plan-step-input-error">
              {inputError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {step.original === null ? (
            <Field
              id={`${id}-key`}
              label={t('步骤名', 'Step key')}
              required
              hint={t(
                '字母或数字开头，只含字母、数字、. _ -；其他步骤按这个名字依赖它。',
                'Starts with a letter or digit; letters, digits, . _ - only. Other steps depend on it by this key.',
              )}
              error={errorOf(`step:${step.uid}:key`)}
            >
              <input
                id={`${id}-key`}
                className="input input-mono"
                value={step.key}
                onChange={(event) => onChange({ key: event.target.value })}
                aria-invalid={errorOf(`step:${step.uid}:key`) !== null}
                aria-describedby={describedBy(
                  `${id}-key`,
                  true,
                  errorOf(`step:${step.uid}:key`) !== null,
                )}
                autoComplete="off"
                spellCheck={false}
                data-testid="goal-plan-step-key"
              />
            </Field>
          ) : null}
          {step.original !== null ? (
            <span className="text-3 text-small" data-testid="goal-plan-step-restart">
              {taskLive(run)
                ? t(
                    '改动这一步的任何一项（包括尝试次数），它都会按新定义从头开始；它正在跑的任务怎么处理，在下面「这些步骤还在跑」里选。',
                    'Changing anything in this step (its attempts too) starts it again on its new definition; what happens to its running task is chosen under “These steps still run” below.',
                  )
                : t(
                    '改动这一步的任何一项（包括尝试次数），它都会按新定义从头开始。',
                    'Changing anything in this step (its attempts too) starts it again on its new definition.',
                  )}
            </span>
          ) : null}
          <WorkerPicker
            id={id}
            step={step}
            definitions={definitions}
            error={errorOf(`step:${step.uid}:worker`)}
            onChange={onChange}
          />
          <fieldset className="stack-s" data-testid="goal-plan-step-depends">
            <legend className="text-small">{t('在这些步骤之后', 'After these steps')}</legend>
            {others.length === 0 ? (
              <span className="text-3 text-small">
                {t('没有别的步骤可选', 'No other step to pick')}
              </span>
            ) : (
              <div className="row-wrap">
                {others.map((other) => (
                  <label key={other.uid} className="row-wrap text-small">
                    <input
                      type="checkbox"
                      checked={step.dependsOn.includes(other.key)}
                      onChange={(event) =>
                        onChange({
                          dependsOn: event.target.checked
                            ? [...step.dependsOn, other.key]
                            : step.dependsOn.filter((dep) => dep !== other.key),
                        })
                      }
                    />
                    <span className="mono">{other.key}</span>
                    {other.removed ? (
                      <span className="text-3">{t('（已移除）', ' (removed)')}</span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
            {errorOf(`step:${step.uid}:dependsOn`) ? (
              <p className="field-error" role="alert">
                {errorOf(`step:${step.uid}:dependsOn`)}
              </p>
            ) : null}
          </fieldset>
          <Field id={`${id}-attempts`} label={t('最多尝试次数', 'Attempts at most')}>
            <Select
              id={`${id}-attempts`}
              aria-label={t('最多尝试次数', 'Attempts at most')}
              className="select-fit"
              value={step.maxAttempts}
              onChange={(event) => onChange({ maxAttempts: event.target.value })}
              data-testid="goal-plan-step-attempts"
            >
              <option value="">
                {t(`默认（${DEFAULT_ATTEMPTS} 次）`, `Default (${DEFAULT_ATTEMPTS})`)}
              </option>
              {Array.from({ length: MAX_STEP_ATTEMPTS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {t(`${n} 次`, String(n))}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={`${id}-input`}
            label={t('输入（JSON，可空）', 'Input (JSON, optional)')}
            hint={[
              t(
                '交给 Worker 的参数。不要写凭据的值：Worker 用的凭据由平台配置。',
                'What the Worker is given. Never a credential’s value: the credentials Workers use are configured on the platform.',
              ),
              keptAsRead(
                step.original !== null &&
                  step.inputText === prettyInput(step.original.input) &&
                  !workerChanged(step)
                  ? shownOnly(step.original.input)
                  : null,
                t,
              ),
            ]
              .filter((part) => part !== null)
              .join(' ')}
            error={inputError}
          >
            <Textarea
              id={`${id}-input`}
              aria-label={t('输入', 'Input')}
              className="input-mono"
              value={step.inputText}
              onChange={(event) => onChange({ inputText: event.target.value })}
              minRows={3}
              maxRows={12}
              invalid={inputError !== null}
              spellCheck={false}
              data-testid="goal-plan-step-input"
            />
          </Field>
          {kept.length > 0 ? (
            <span className="text-3 text-small">
              {t(
                `${kept.join('、')}保持不变（要改，在对话里让入口智能体修订）。`,
                `${kept.join(', ')} stay as they are (to change them, ask the entry agent in a chat).`,
              )}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function WorkerPicker({
  id,
  step,
  definitions,
  error,
  onChange,
}: {
  readonly id: string;
  readonly step: StepDraft;
  readonly definitions: readonly WorkerDefinitionSummary[] | undefined;
  readonly error: string | null;
  readonly onChange: (patch: Partial<StepDraft>) => void;
}) {
  const t = useT();
  const rows = definitions ?? [];
  const versions = definitionVersions(rows, step.definitionId);
  const listed = rows.some((row) => row.id === step.definitionId);
  return (
    <div className="row-wrap">
      <Field id={`${id}-worker`} label="Worker" required error={error}>
        <Select
          id={`${id}-worker`}
          aria-label="Worker"
          value={step.definitionId}
          onChange={(event) => {
            const newest = definitionVersions(rows, event.target.value)[0];
            onChange({
              definitionId: event.target.value,
              version: newest ? String(newest.version) : '',
            });
          }}
          invalid={error !== null}
          data-testid="goal-plan-step-worker"
        >
          <option value="">
            {definitions === undefined
              ? t('正在读取 Worker…', 'Reading Workers…')
              : t('选一个 Worker…', 'Choose a Worker…')}
          </option>
          {step.definitionId !== '' && !listed ? (
            <option value={step.definitionId}>
              {t(
                '当前的 Worker（已不在已发布列表里）',
                'The current Worker (no longer among the published)',
              )}
            </option>
          ) : null}
          {workerDefinitionChoices(latestPerDefinition(rows), t).map((choice) => (
            <option key={choice.id} value={choice.id}>
              {[choice.label, choice.distinguisher]
                .filter((part) => part !== undefined)
                .join(' · ')}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-version`} label={t('版本', 'Version')} required>
        <Select
          id={`${id}-version`}
          aria-label={t('版本', 'Version')}
          value={step.version}
          onChange={(event) => onChange({ version: event.target.value })}
          data-testid="goal-plan-step-version"
        >
          {step.definitionId === '' ? (
            <option value="">{t('先选 Worker', 'Pick a Worker first')}</option>
          ) : null}
          {step.version !== '' && !versions.some((row) => String(row.version) === step.version) ? (
            <option value={step.version}>
              {t(
                `v${step.version}（不在已发布列表里）`,
                `v${step.version} (not among the published)`,
              )}
            </option>
          ) : null}
          {versions.map((row) => (
            <option key={row.version} value={String(row.version)}>
              {`v${row.version}`}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function CheckEditor({
  check,
  gateNames,
  errorOf,
  onChange,
  onRemove,
  onRestore,
}: {
  readonly check: CheckDraft;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly errorOf: (key: FieldKey) => string | null;
  readonly onChange: (patch: Partial<CheckDraft>) => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}) {
  const t = useT();
  const id = useId();
  const isConfirm = check.original === null || check.original.kind === 'requester_confirm';
  if (check.removed) {
    return (
      <div className="row-wrap" data-testid="goal-plan-check" data-removed="">
        <span className="mono text-3">{check.key}</span>
        <span className="text-3 text-small">{t('已移除', 'Removed')}</span>
        <Button variant="ghost" size="s" onClick={onRestore} data-testid="goal-plan-check-restore">
          {t('恢复', 'Restore')}
        </Button>
      </div>
    );
  }
  const promptError = errorOf(`check:${check.uid}:prompt`);
  const checkError = errorOf(`check:${check.uid}`);
  return (
    <div className="stack-s" data-testid="goal-plan-check" data-check-key={check.key}>
      <div className="row-wrap">
        <span className="mono">{check.key}</span>
        {isConfirm ? (
          <span className="text-3 text-small">{t('请求人确认', 'Requester confirms')}</span>
        ) : check.original ? (
          <span className="text-small">{planCheckSentence(check.original, gateNames, t)}</span>
        ) : null}
        <Button variant="ghost" size="s" onClick={onRemove} data-testid="goal-plan-check-remove">
          {t('移除', 'Remove')}
        </Button>
      </div>
      {checkError ? <Notice tone="danger">{checkError}</Notice> : null}
      {isConfirm ? (
        <Field
          id={`${id}-prompt`}
          label={t('要请求人确认什么', 'What the requester confirms')}
          hint={[
            t(
              '平台检查都通过后，请求人看着这句话确认目标达成。',
              'Once the platform’s checks pass, the requester confirms the goal against this.',
            ),
            keptAsRead(check.prompt === originalPrompt(check) ? shownOnly(check.prompt) : null, t),
          ]
            .filter((part) => part !== null)
            .join(' ')}
          error={promptError}
        >
          <Textarea
            id={`${id}-prompt`}
            aria-label={t('确认提示', 'Prompt')}
            value={check.prompt}
            onChange={(event) => onChange({ prompt: event.target.value })}
            minRows={2}
            maxRows={6}
            invalid={promptError !== null}
            data-testid="goal-plan-check-prompt"
          />
        </Field>
      ) : null}
    </div>
  );
}

function BudgetEditor({
  goal,
  draft,
  errorOf,
  onChange,
}: {
  readonly goal: GoalDetailWire;
  readonly draft: PlanDraft;
  readonly errorOf: (key: FieldKey) => string | null;
  readonly onChange: (patch: Partial<PlanDraft['budget']>) => void;
}) {
  const t = useT();
  const id = useId();
  const used = new Map(goalBudgetRows(goal, t).map((row) => [row.key, row.usedText] as const));
  const fields = [
    { key: 'maxTokens', field: 'maxTokens', label: 'Token', used: used.get('tokens'), step: 1 },
    {
      key: 'maxSteps',
      field: 'maxSteps',
      label: t('步骤尝试', 'Step attempts'),
      used: used.get('steps'),
      step: 1,
    },
    {
      key: 'maxRevisions',
      field: 'maxRevisions',
      label: t('计划修订', 'Plan revisions'),
      used: used.get('revisions'),
      step: 1,
    },
    {
      key: 'maxWallClockMinutes',
      field: 'maxWallClockSeconds',
      label: t('用时（分钟）', 'Wall clock (minutes)'),
      used: used.get('wallClock'),
      step: 'any',
    },
  ] as const;
  return (
    <section className="stack-s" aria-label={t('预算', 'Budget')}>
      <span className="section-title">{t('预算上限', 'Budget')}</span>
      <div className="row-wrap">
        {fields.map((item) => {
          const error = errorOf(`budget:${item.field}`);
          return (
            <Field
              key={item.key}
              id={`${id}-${item.key}`}
              label={item.label}
              hint={t(`已用 ${item.used ?? '—'}`, `Used ${item.used ?? '—'}`)}
              error={error}
            >
              <input
                id={`${id}-${item.key}`}
                className="input"
                type="number"
                min={item.key === 'maxRevisions' ? 0 : 1}
                step={item.step}
                inputMode="numeric"
                value={draft.budget[item.key]}
                onChange={(event) => onChange({ [item.key]: event.target.value })}
                aria-invalid={error !== null}
                aria-describedby={describedBy(`${id}-${item.key}`, true, error !== null)}
                data-testid={`goal-plan-budget-${item.field}`}
              />
            </Field>
          );
        })}
      </div>
    </section>
  );
}

function RemovalEditor({
  keys,
  draft,
  runs,
  http,
  onChange,
}: {
  readonly keys: readonly string[];
  readonly draft: PlanDraft;
  readonly runs: ReadonlyMap<string, StepRunWire>;
  readonly http: CapabilityCaller;
  readonly onChange: (key: string, removal: PlanDraft['removals'][string] | null) => void;
}) {
  const t = useT();
  return (
    <section className="stack-s" aria-label={t('正在跑的步骤', 'Steps still running')}>
      <span className="section-title">
        {t('这些步骤还在跑，被移除或改动后怎么处理', 'These steps still run: what happens to them')}
      </span>
      {keys.map((key) => {
        const removal = draft.removals[key];
        const finish = removal?.mode === 'let_finish';
        const releasable = releasableActions(runs.get(key));
        const released = new Set(removal?.release ?? []);
        return (
          <fieldset
            key={key}
            className="stack-s"
            data-testid="goal-plan-removal"
            data-step-key={key}
          >
            <legend className="mono">{key}</legend>
            <label className="goal-plan-choice text-small">
              <input
                type="radio"
                name={`removal-${key}`}
                checked={!finish}
                onChange={() => onChange(key, null)}
              />
              <span>
                {t(
                  '终止它的任务，撤回它还没执行的动作（默认）',
                  'Terminate its task and withdraw its actions not yet run (default)',
                )}
              </span>
            </label>
            <label className="goal-plan-choice text-small">
              <input
                type="radio"
                name={`removal-${key}`}
                checked={finish}
                onChange={() => onChange(key, { mode: 'let_finish' })}
                data-testid="goal-plan-removal-finish"
              />
              <span>
                {t(
                  '让它跑完：结果只记录，不再推进后面的步骤',
                  'Let it finish: its result is recorded, and nothing after it moves on',
                )}
              </span>
            </label>
            {finish && releasable.length > 0 ? (
              <div className="stack-s">
                <span className="text-small">
                  {t(
                    '它已提交、还没执行的动作默认撤回；勾选的照常审批和执行：',
                    'Its submitted actions not yet run are withdrawn; the ones ticked are approved and run as usual:',
                  )}
                </span>
                {releasable.map((actionRequestId) => (
                  <label key={actionRequestId} className="row-wrap text-small">
                    <input
                      type="checkbox"
                      checked={released.has(actionRequestId)}
                      onChange={(event) => {
                        const next = new Set(released);
                        if (event.target.checked) next.add(actionRequestId);
                        else next.delete(actionRequestId);
                        onChange(key, {
                          mode: 'let_finish',
                          ...(next.size > 0 ? { release: [...next] } : {}),
                        });
                      }}
                    />
                    <ActionChip actionRequestId={actionRequestId} http={http} />
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>
        );
      })}
    </section>
  );
}

function ReasonField({
  value,
  error,
  onChange,
}: {
  readonly value: string;
  readonly error: string | null;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <Field
      id={id}
      label={t('修订原因（可选）', 'Why (optional)')}
      hint={t(
        `显示在计划版本的时间线上，最多 ${MAX_REVISION_REASON_CHARS} 字。写为什么改，不要写凭据的值。`,
        `Shown on the plan’s revision timeline, at most ${MAX_REVISION_REASON_CHARS} characters. Say why, never a credential’s value.`,
      )}
      error={error}
    >
      <Textarea
        id={id}
        aria-label={t('修订原因', 'Reason')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        minRows={2}
        maxRows={5}
        invalid={error !== null}
        data-testid="goal-plan-reason"
      />
    </Field>
  );
}
