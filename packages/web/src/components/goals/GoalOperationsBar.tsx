import {
  type AuditRecordWire,
  type CancelGoalResultWire,
  type GoalDetailWire,
  type GoalOperationResultWire,
  type GoalPlannerMode,
  MAX_GOAL_NOTE_CHARS,
  type ResumeGoalResultWire,
} from '@nexttime/shared';
import { type ReactNode, useCallback, useId, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { ErrorOverrides } from '../../lib/errors.js';
import {
  type GoalViewer,
  type OverriddenCheck,
  checksOverriddenByEnding,
  goalOperations,
  holdPlacedAt,
  retryableStepKeys,
  revisionsSince,
} from '../../lib/goal-actions.js';
import {
  confirmCheckOrigin,
  confirmRefusedText,
  goalBudgetRows,
  goalPlanSource,
  planHintText,
  planSourceParameterText,
  planSourceParameters,
} from '../../lib/goals.js';
import { HttpError } from '../../lib/http-client.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { Select } from '../kit/select.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { Textarea } from '../kit/textarea.js';
import { AbsenceChecksBasis } from './AbsenceBasis.js';
import type { AbsenceOperations } from './useAbsenceOperations.js';
import { useProcedureParameterDescriptions } from './useProcedureParameterDescriptions.js';

export interface GoalOperationsBarProps {
  readonly goal: GoalDetailWire;
  readonly viewer: GoalViewer;
  readonly http: CapabilityCaller;
  /** Gatekeeper names, for the checks an ending overrides. */
  readonly gateNames: ReadonlyMap<string, string>;
  /** Legacy 470: the Objects the checks name by id, 「名字 · 类型」 (`useObjectLabels`). */
  readonly objectNames?: ReadonlyMap<string, string>;
  /** S11 「门确认不存在」 B: what the plan's absence checks rest on (`useAbsenceOperations`) —
   *  listed on the confirm card. */
  readonly absenceOperations?: AbsenceOperations;
  /** Opens the plan editor (`revise_goal`); the button shows only when given. */
  readonly onRevise?: () => void;
  /** After an operation — or a refusal because the goal had already moved on — for the page to
   *  say what happened and re-read the goal (and its unresolved actions). */
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

type OpenOp =
  | 'confirm'
  | 'reject'
  | 'pause'
  | 'hold'
  | 'resume'
  | 'cancel'
  | 'release'
  | 'end'
  | 'confirmAcceptance'
  | null;

/** The goal as an operation found it — to tell, once re-read, whether a 409 meant it had moved on. */
export interface GoalMark {
  readonly status: string;
  readonly updatedAt: string;
}

/** What the page says after an operation: what it did, or that it was refused for the state of
 *  things (a 409 `illegal_transition`) and the goal was read again — with the goal as the
 *  operation found it, so the page can say whether the goal itself had moved on or something of it
 *  (a step, a Task, an action) was not yet where the operation needs it. */
export type GoalOperationOutcome =
  | {
      readonly kind: 'done';
      readonly message: string;
      /** What the result says to watch for (a revision's hints), each shown under the message. */
      readonly notes?: readonly string[];
    }
  | { readonly kind: 'stale'; readonly before: GoalMark };

/** The copy an operation's refusal gets in place of the generic one (`kit/confirm`'s inline error;
 *  the kernel's own text stays under 技术细节). */
export function goalOperationErrors(t: Translate): ErrorOverrides {
  return {
    illegal_transition: t(
      '这个操作此刻不能执行，什么也没改。页面已经刷新，原因写在页面的操作按钮下方，关掉这个框就能看到。',
      'This cannot be done right now, and nothing changed. The page has been refreshed; the reason is under the page’s buttons — close this to see it.',
    ),
    credentials_in_text: t(
      '备注里有像凭据的写法（token、key、密码的值，或 Bearer、Authorization、名称=值 这样的写法），已拒绝，什么也没保存。把它改成描述发生了什么，比如「token 过期了」「密码不对」，或者清空备注再提交。',
      'The note looks like it carries a credential (a token, key or password value, or a Bearer, Authorization or name=value form), so it was refused and nothing was saved. Describe what happened instead — "the token expired", "the password is wrong" — or clear the note and submit again.',
    ),
  };
}

/**
 * components/goals/GoalOperationsBar (S11 GO6, operations): the buttons for what the reader may do
 * to this goal now (`lib/goal-actions.ts` `goalOperations`), each behind a confirm sized to what it
 * does (`kit/confirm`): confirming a proposal (the confirm card), rejecting it, pausing — for an
 * owner on someone else's goal, a hold — resuming with the failed steps to retry, cancelling,
 * lifting a hold (showing whether the plan changed while it was held), ending on the requester's
 * word and confirming the acceptance. Each re-reads the goal on the same page afterwards.
 * Revising the plan opens the plan editor in place of the page (`GoalPlanEditor`, via `onRevise`).
 */
export function GoalOperationsBar({
  goal,
  viewer,
  http,
  gateNames,
  objectNames,
  absenceOperations,
  onRevise,
  onDone,
}: GoalOperationsBarProps) {
  const t = useT();
  const can = useRoleCan(http);
  // Legacy 474: the start parameters by what the Procedure says they are.
  const parameterDescriptions = useProcedureParameterDescriptions(
    http,
    goalPlanSource(goal.revisions),
  );
  const ops = goalOperations(goal, viewer, t);
  const [open, setOpen] = useState<OpenOp>(null);
  // S11 GO9a: let the goal planner propose a revision when a step fails — on by default here (an
  // API caller that omits it gets none); given once, with the confirmation. GO9b: or let the
  // platform apply its minor revisions for the requester while the goal keeps running.
  const [planner, setPlanner] = useState<PlannerChoiceValue>('propose');
  const errors = goalOperationErrors(t);
  const goalRunId = goal.id;
  const run = useOperationDone(onDone, goal);

  const buttons: ReactNode[] = [];
  const waits: { op: string; reason: string }[] = [];
  const confirmFor = (
    op: Exclude<OpenOp, null>,
    label: string,
    variant: 'primary' | 'secondary' | 'danger',
    disabledReason: string | null,
    body: (anchor: ReactNode) => ReactNode,
  ) => {
    const anchor = (
      <Button
        variant={variant}
        size="s"
        disabled={disabledReason !== null}
        aria-describedby={disabledReason !== null ? `goal-op-${op}-wait` : undefined}
        onClick={() => setOpen(op)}
        data-testid={`goal-op-${op}`}
      >
        {label}
      </Button>
    );
    buttons.push(<span key={op}>{body(anchor)}</span>);
    if (disabledReason !== null) waits.push({ op, reason: `${label}：${disabledReason}` });
  };
  const openProps = (op: Exclude<OpenOp, null>) => ({
    open: open === op,
    onOpenChange: (next: boolean) => setOpen(next ? op : null),
    errorOverrides: errors,
    testId: `goal-op-${op}-confirm`,
  });

  if (ops.confirm && can('confirm_goal') !== false) {
    const budget = goalBudgetRows(goal, t);
    // Legacy 454: a plan made from a Procedure — what it was started with, and which acceptance
    // check will come back to the requester and why.
    const source = goalPlanSource(goal.revisions);
    const parameters = planSourceParameters(source, parameterDescriptions);
    const confirmOrigin = source?.confirmCheck
      ? confirmCheckOrigin(source, source.confirmCheck.key, t)
      : null;
    // Say what is confirmed in the check's own words; its key alone tells the requester nothing.
    const confirmPrompt = (() => {
      const key = source?.confirmCheck?.key;
      const check = (goal.planRevision.plan.acceptance ?? []).find((item) => item.key === key);
      return check?.kind === 'requester_confirm' && check.prompt.trim() !== ''
        ? check.prompt
        : null;
    })();
    confirmFor('confirm', t('确认并开始', 'Confirm and start'), 'primary', null, (anchor) => (
      <Confirm
        tier="medium"
        {...openProps('confirm')}
        anchor={anchor}
        title={t('确认这个目标', 'Confirm this goal')}
        description={t(
          '确认后目标按下面的计划开始执行，以你的授权花费预算、发起动作；需要审批的动作仍然逐个审批。',
          'Once confirmed, the goal runs the plan below, spending its budget and acting with your authority; actions that need approval are still approved one by one.',
        )}
        impact={[
          t(
            `按计划第 ${goal.planRevision.revision} 版执行 ${goal.planRevision.plan.steps.length} 个步骤`,
            `Runs the ${goal.planRevision.plan.steps.length} steps of plan v${goal.planRevision.revision}`,
          ),
          t(
            `预算上限：${budget.map((row) => `${row.label} ${row.maxText}`).join('，')}`,
            `Budget: ${budget.map((row) => `${row.label} ${row.maxText}`).join(', ')}`,
          ),
          ...(source && parameters.length > 0
            ? [
                t(
                  `用这些启动参数从流程 ${source.name} v${source.version} 生成：${parameters.map((row) => planSourceParameterText(row, t)).join('，')}`,
                  `Made from the Procedure ${source.name} v${source.version} with: ${parameters.map((row) => planSourceParameterText(row, t)).join(', ')}`,
                ),
              ]
            : []),
          ...(source?.confirmCheck && confirmOrigin
            ? [
                confirmPrompt
                  ? t(
                      `所有步骤完成后，要你亲自确认「${confirmPrompt}」（验收检查 ${source.confirmCheck.key}），${confirmOrigin}`,
                      `Once every step is done, you confirm “${confirmPrompt}” (acceptance check ${source.confirmCheck.key}), ${confirmOrigin}`,
                    )
                  : t(
                      `所有步骤完成后，验收检查 ${source.confirmCheck.key} 要你亲自确认，${confirmOrigin}`,
                      `Once every step is done, acceptance check ${source.confirmCheck.key} asks you to confirm: ${confirmOrigin}`,
                    ),
              ]
            : []),
          // S11 GO5c: what the plan's checks leave to your word, and any step your authority
          // would not start now (the kernel works it out on every read of a proposal) — marked, so
          // they do not read like the lines above.
          ...goal.planRevision.hints.map(
            (hint) => `${t('注意：', 'Note: ')}${planHintText(hint, t, gateNames)}`,
          ),
        ]}
        confirmLabel={t('确认并开始', 'Confirm and start')}
        errorOverrides={{
          ...errors,
          // S11 GO8a: a model the catalog dropped since the proposal can be offered again, and the
          // proposal confirmed then — not "cannot be confirmed any more" (UX on #853).
          invalid_params:
            confirmRefusedText(goal.planRevision.hints, t) ??
            t(
              '计划复查没通过（比如用到的 Worker 已经停用），具体问题见技术细节。这个提议不能再确认了，请在对话里让入口智能体重新提一个目标。',
              'The plan no longer passes its checks (a Worker it uses was deprecated, for example); the problems are under technical details. This proposal cannot be confirmed any more: ask the entry agent in a chat for a new goal.',
            ),
        }}
        onConfirm={() =>
          run(
            http.call<GoalOperationResultWire>('confirm_goal', {
              goalRunId,
              revision: goal.planRevision.revision,
              ...(planner !== 'off' ? { planner } : {}),
            }),
            () =>
              planner === 'propose'
                ? t(
                    '目标已确认，开始执行。步骤失败、需要你决定时，目标规划器会先提一个修订给你看。',
                    'Goal confirmed: it is starting. When a step fails and the goal waits for you, the goal planner proposes a revision for you to look at first.',
                  )
                : planner === 'apply_minor'
                  ? t(
                      '目标已确认，开始执行。步骤失败时，目标规划器会先换一条路；小修订由平台按你的授权采用，其余的修订等你决定。',
                      'Goal confirmed: it is starting. When a step fails, the goal planner looks for another way first; minor revisions are adopted by the platform on your leave, any other waits for your decision.',
                    )
                  : t('目标已确认，开始执行', 'Goal confirmed: it is starting'),
          )
        }
      >
        <PlannerChoice value={planner} onChange={setPlanner} />
        {absenceOperations ? (
          <AbsenceChecksBasis
            http={http}
            plan={goal.planRevision.plan}
            gateNames={gateNames}
            absenceOperations={absenceOperations}
          />
        ) : null}
      </Confirm>
    ));
  }

  if (ops.reject && can('reject_goal') !== false) {
    confirmFor('reject', t('驳回', 'Reject'), 'secondary', null, (anchor) => (
      <Confirm
        tier="medium"
        danger
        {...openProps('reject')}
        anchor={anchor}
        title={t('驳回这个目标', 'Reject this goal')}
        impact={[
          t(
            '提议被驳回，目标取消；它没有执行过，什么也不会发生',
            'The proposal is rejected and the goal cancelled; it never ran and nothing happens',
          ),
          t(
            '想换个做法，在对话里让入口智能体重新提一个目标',
            'For another approach, ask the entry agent in a chat for a new goal',
          ),
        ]}
        confirmLabel={t('驳回', 'Reject')}
        onConfirm={() =>
          run(
            http.call<GoalOperationResultWire>('reject_goal', {
              goalRunId,
              revision: goal.planRevision.revision,
            }),
            () => t('目标已驳回', 'Goal rejected'),
          )
        }
      />
    ));
  }

  if (ops.confirmAcceptance && can('confirm_goal_acceptance') !== false) {
    const check = ops.confirmAcceptance.check;
    confirmFor(
      'confirmAcceptance',
      t('确认达成', 'Confirm achieved'),
      'primary',
      ops.confirmAcceptance.disabledReason,
      (anchor) => (
        <NoteConfirm
          {...openProps('confirmAcceptance')}
          anchor={anchor}
          title={t('确认目标达成', 'Confirm the goal is achieved')}
          description={
            check.prompt ??
            t(
              '平台的检查都通过了，最后由你确认。',
              'The platform’s checks passed; you confirm last.',
            )
          }
          impact={[
            t(
              '记为你的判定：目标达成；目标随后结束',
              'Recorded as your decision — achieved; the goal then ends',
            ),
          ]}
          confirmLabel={t('确认达成', 'Confirm achieved')}
          onConfirm={(note) =>
            run(
              http.call<GoalOperationResultWire>('confirm_goal_acceptance', {
                goalRunId,
                checkKey: check.checkKey,
                ...note,
              }),
              () => t('已确认目标达成', 'Confirmed achieved'),
            )
          }
        />
      ),
    );
  }

  if (ops.resume && can('resume_goal') !== false) {
    confirmFor('resume', t('继续', 'Resume'), 'primary', ops.resume.disabledReason, (anchor) => (
      <ResumeConfirm
        {...openProps('resume')}
        anchor={anchor}
        goal={goal}
        onResume={(retrySteps) =>
          run(
            http.call<ResumeGoalResultWire>('resume_goal', {
              goalRunId,
              ...(retrySteps.length > 0 ? { retrySteps } : {}),
            }),
            (result) =>
              result.retriedStepRunIds.length > 0
                ? t(
                    `目标已继续，重试 ${result.retriedStepRunIds.length} 个步骤`,
                    `Goal resumed, retrying ${result.retriedStepRunIds.length} steps`,
                  )
                : t('目标已继续', 'Goal resumed'),
          )
        }
      />
    ));
  }

  if (ops.revise && onRevise && can('revise_goal') !== false) {
    buttons.push(
      <Button
        key="revise"
        variant="secondary"
        size="s"
        onClick={onRevise}
        data-testid="goal-op-revise"
      >
        {t('修订计划…', 'Revise plan…')}
      </Button>,
    );
  }

  if (ops.pause && can('pause_goal') !== false) {
    const holds = ops.pause.holds;
    confirmFor(
      'pause',
      holds ? t('暂停并锁定', 'Pause and hold') : t('暂停', 'Pause'),
      'secondary',
      null,
      (anchor) => (
        <Confirm
          tier="medium"
          {...openProps('pause')}
          anchor={anchor}
          title={
            holds
              ? t('暂停并锁定这个目标', 'Pause and hold this goal')
              : t('暂停这个目标', 'Pause this goal')
          }
          impact={[
            t(
              '不再开始新的步骤尝试；正在运行的会跑完并记录，它们发起的动作照常审批和执行',
              'No new step attempt starts; running ones finish and are recorded, their actions still approved and run',
            ),
            ...(holds
              ? [
                  t(
                    '这是别人的目标，你的暂停是锁定：请求人不能自己继续，要等工作区所有者解除',
                    'This is someone else’s goal, so your pause is a hold: its requester cannot resume it until a workspace owner lifts the hold',
                  ),
                ]
              : []),
            t('要立刻停下所有动作，用「取消」', 'To stop everything now, cancel instead'),
          ]}
          confirmLabel={holds ? t('暂停并锁定', 'Pause and hold') : t('暂停', 'Pause')}
          onConfirm={() =>
            run(http.call<GoalOperationResultWire>('pause_goal', { goalRunId }), () =>
              holds
                ? t('目标已暂停并锁定', 'Goal paused and held')
                : t('目标已暂停', 'Goal paused'),
            )
          }
        />
      ),
    );
  }

  if (ops.hold && can('pause_goal') !== false) {
    confirmFor('hold', t('锁定', 'Hold'), 'secondary', null, (anchor) => (
      <Confirm
        tier="medium"
        {...openProps('hold')}
        anchor={anchor}
        title={t('锁定这个目标', 'Hold this goal')}
        impact={[
          t(
            '目标已经暂停；锁定后请求人不能自己继续，要等工作区所有者解除',
            'The goal is already paused; once held, its requester cannot resume it until a workspace owner lifts the hold',
          ),
          t('请求人仍可改计划、结束或取消', 'Its requester can still revise, end or cancel it'),
        ]}
        confirmLabel={t('锁定', 'Hold')}
        onConfirm={() =>
          run(http.call<GoalOperationResultWire>('pause_goal', { goalRunId }), () =>
            t('目标已锁定', 'Goal held'),
          )
        }
      />
    ));
  }

  if (ops.release && can('release_goal_hold') !== false) {
    confirmFor('release', t('解除锁定', 'Lift hold'), 'secondary', null, (anchor) => (
      <Confirm
        tier="medium"
        {...openProps('release')}
        anchor={anchor}
        title={t('解除锁定', 'Lift the hold')}
        impact={[
          t(
            '目标仍然暂停：由请求人决定继续、改计划、结束或取消，解除本身不会让任何东西运行',
            'The goal stays paused: its requester decides to resume, revise, end or cancel it; lifting the hold runs nothing',
          ),
        ]}
        confirmLabel={t('解除锁定', 'Lift hold')}
        onConfirm={() =>
          run(http.call<GoalOperationResultWire>('release_goal_hold', { goalRunId }), () =>
            t('锁定已解除', 'Hold lifted'),
          )
        }
      >
        {open === 'release' ? <HoldPlanChanges goal={goal} http={http} /> : null}
      </Confirm>
    ));
  }

  if (ops.end && can('end_goal') !== false) {
    const endOp = ops.end;
    confirmFor('end', t('结束目标…', 'End goal…'), 'secondary', endOp.disabledReason, (anchor) => (
      <EndConfirm
        {...openProps('end')}
        anchor={anchor}
        achievedAllowed={endOp.achieved}
        overridden={checksOverriddenByEnding(goal, gateNames, t, objectNames)}
        onEnd={(outcome, note) =>
          run(
            http.call<GoalOperationResultWire>('end_goal', { goalRunId, outcome, ...note }),
            () =>
              outcome === 'achieved'
                ? t('目标已结束：达成', 'Goal ended: achieved')
                : t('目标已结束：未达成', 'Goal ended: not achieved'),
          )
        }
      />
    ));
  }

  if (ops.cancel && can('cancel_goal') !== false) {
    const notEnded = goal.steps.filter(
      (step) =>
        step.supersededInRevision === null &&
        !['succeeded', 'superseded', 'cancelled', 'skipped'].includes(step.status),
    ).length;
    confirmFor('cancel', t('取消目标', 'Cancel goal'), 'danger', null, (anchor) => (
      <Confirm
        tier="irreversible"
        {...openProps('cancel')}
        anchor={anchor}
        title={t('取消这个目标', 'Cancel this goal')}
        impact={[
          t(`${notEnded} 个没结束的步骤会被取消`, `${notEnded} steps not yet ended are cancelled`),
          t(
            '还没开始执行的动作会被撤回；正在执行的动作停不下来，会自己结束，结束前目标显示「取消中」',
            'Actions not yet started are withdrawn; ones already executing cannot be stopped and end on their own — until then the goal reads Cancelling',
          ),
          t(
            '取消后不能恢复；需要时重新提一个目标',
            'Cannot be undone — propose a new goal if needed',
          ),
        ]}
        confirmLabel={t('取消目标', 'Cancel goal')}
        onConfirm={() =>
          run(http.call<CancelGoalResultWire>('cancel_goal', { goalRunId }), (result) =>
            t(
              `目标已取消：${result.cancelledStepRunIds.length} 个步骤取消，${result.withdrawnActionRequestIds.length} 个动作撤回`,
              `Goal cancelled: ${result.cancelledStepRunIds.length} steps cancelled, ${result.withdrawnActionRequestIds.length} actions withdrawn`,
            ),
          )
        }
      />
    ));
  }

  if (buttons.length === 0) return null;
  return (
    <div className="stack-s" data-testid="goal-operations">
      <div className="row-wrap">{buttons}</div>
      {waits.map((wait) => (
        <p
          key={wait.op}
          id={`goal-op-${wait.op}-wait`}
          className="text-small text-3"
          data-testid="goal-op-wait"
        >
          {wait.reason}
        </p>
      ))}
    </div>
  );
}

/** Awaits an operation's call and tells the page what it did — or that nothing changed, the
 *  operation having already been so (`changed: false`). A refusal throws on into `kit/confirm`,
 *  which shows it inline and stays open; one because the goal had moved on (409
 *  `illegal_transition`) also has the page read it again and say where it stands, since the button
 *  that was pressed may not be there any more. */
export function useOperationDone(onDone: (outcome: GoalOperationOutcome) => void, goal: GoalMark) {
  const t = useT();
  const { status, updatedAt } = goal;
  return useCallback(
    async <R extends { readonly changed: boolean }>(
      call: Promise<R>,
      done: (result: R) => string,
      notes?: (result: R) => readonly string[],
    ): Promise<void> => {
      let result: R;
      try {
        result = await call;
      } catch (error) {
        if (error instanceof HttpError && error.code === 'illegal_transition') {
          onDone({ kind: 'stale', before: { status, updatedAt } });
        }
        throw error;
      }
      onDone(
        result.changed
          ? { kind: 'done', message: done(result), notes: notes?.(result) ?? [] }
          : { kind: 'done', message: t('它已经是这样了，没有变化', 'Already so: nothing changed') },
      );
    },
    [onDone, t, status, updatedAt],
  );
}

interface OpenControl {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly errorOverrides: ErrorOverrides;
  readonly testId: string;
  readonly anchor: ReactNode;
}

/** The optional note a decision keeps, and its field. */
export function useNote(): {
  readonly value: string;
  readonly params: { note?: string };
  readonly field: ReactNode;
  readonly tooLong: boolean;
} {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_GOAL_NOTE_CHARS;
  return {
    value,
    params: trimmed === '' ? {} : { note: trimmed },
    tooLong,
    field: (
      <Field
        id={id}
        label={t('备注（可选）', 'Note (optional)')}
        hint={t(
          `和你的判定一起记下，最多 ${MAX_GOAL_NOTE_CHARS} 字。写发生了什么，不要写凭据的值。`,
          `Kept with your decision, at most ${MAX_GOAL_NOTE_CHARS} characters. Say what happened, never a credential’s value.`,
        )}
        error={
          tooLong
            ? t(
                `超出 ${trimmed.length - MAX_GOAL_NOTE_CHARS} 字`,
                `${trimmed.length - MAX_GOAL_NOTE_CHARS} characters too long`,
              )
            : undefined
        }
      >
        <Textarea
          id={id}
          aria-label={t('备注', 'Note')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          minRows={2}
          maxRows={5}
          invalid={tooLong}
          data-testid="goal-op-note"
        />
      </Field>
    ),
  };
}

function NoteConfirm({
  title,
  description,
  impact,
  confirmLabel,
  onConfirm,
  ...control
}: OpenControl & {
  readonly title: string;
  readonly description: string;
  readonly impact: readonly string[];
  readonly confirmLabel: string;
  readonly onConfirm: (note: { note?: string }) => Promise<void>;
}) {
  const note = useNote();
  return (
    <Confirm
      tier="medium"
      {...control}
      title={title}
      description={description}
      impact={impact}
      confirmLabel={confirmLabel}
      confirmDisabled={note.tooLong}
      onConfirm={() => onConfirm(note.params)}
    >
      {note.field}
    </Confirm>
  );
}

type PlannerChoiceValue = 'off' | GoalPlannerMode;

/** S11 GO9a: the confirm card's goal planner choice — what saying yes lets it do, and what not.
 *  GO9b: three ways — no planner, its proposals for the requester to decide, or minor revisions
 *  the platform adopts for them (`@nexttime/shared` `GOAL_PLANNER_MODE_VALUES`). */
function PlannerChoice({
  value,
  onChange,
}: {
  readonly value: PlannerChoiceValue;
  readonly onChange: (value: PlannerChoiceValue) => void;
}) {
  const t = useT();
  const name = useId();
  const hintId = useId();
  const options: readonly { value: PlannerChoiceValue; label: string }[] = [
    {
      value: 'off',
      label: t(
        '不用目标规划器：步骤失败时由我自己处理',
        'No goal planner: I handle a failed step myself',
      ),
    },
    {
      value: 'propose',
      label: t(
        '步骤失败、需要我决定时，让目标规划器提一个修订，由我决定',
        'When a step fails and the goal waits for me, let the goal planner propose a revision for me to decide',
      ),
    },
    {
      value: 'apply_minor',
      label: t(
        '步骤失败时让目标规划器换一条路，小修订由平台替我采用、目标不停',
        'When a step fails, let the goal planner find another way, and the platform adopt minor revisions for me without stopping the goal',
      ),
    },
  ];
  return (
    <fieldset className="stack-s" data-testid="goal-op-confirm-planner" aria-describedby={hintId}>
      <legend className="text-small">{t('目标规划器', 'Goal planner')}</legend>
      {options.map((option) => (
        <label key={option.value} className="row-wrap text-small">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            data-testid={`goal-op-confirm-planner-${option.value}`}
          />
          <span>{option.label}</span>
        </label>
      ))}
      <span id={hintId} className="text-small text-3">
        {value === 'apply_minor'
          ? t(
              '小修订只换 Worker、输入、顺序或重试次数，做的事只读、思考和汇报，验收不变；凡是改验收、新增能执行动作的步骤、需要有人批准才能开始、或会停下还在跑的工作的修订，都会暂停目标等你决定。同一步平台最多替你改两次。规划器看不到外部系统，也不能发起动作；它用掉的 token 计入这个目标的预算。确认后不能再改这个选择。',
              'A minor revision only changes the Worker, input, order or retry limit of work that reads, thinks and reports, on unchanged checks. A revision that changes acceptance, adds a step that can act, needs a person to start, or would stop work still running pauses the goal for your decision. The platform changes one step at most twice for you. The planner sees no outside system and cannot act; the tokens it uses count against this goal’s budget. This choice cannot be changed after confirming.',
            )
          : t(
              '规划器只提议、不执行：它看不到外部系统，也不能发起动作；它提的修订要你接受才生效。它用掉的 token 计入这个目标的预算。确认后不能再改这个选择。',
              'The planner only proposes and runs nothing: it sees no outside system and cannot act; what it proposes takes effect only once you accept it. The tokens it uses count against this goal’s budget. This choice cannot be changed after confirming.',
            )}
      </span>
    </fieldset>
  );
}

function ResumeConfirm({
  goal,
  onResume,
  ...control
}: OpenControl & {
  readonly goal: GoalDetailWire;
  readonly onResume: (retrySteps: string[]) => Promise<void>;
}) {
  const t = useT();
  const failed = retryableStepKeys(goal);
  const [retry, setRetry] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setRetry((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <Confirm
      tier="medium"
      {...control}
      title={t('继续这个目标', 'Resume this goal')}
      description={t(
        '目标马上继续推进，以你的授权花费预算、发起动作；继续前会再检查一遍预算和计划。',
        'The goal moves on at once, spending its budget and acting with your authority; its budget and plan are checked again first.',
      )}
      confirmLabel={t('继续', 'Resume')}
      onConfirm={() => onResume(failed.filter((key) => retry.has(key)))}
    >
      {failed.length > 0 ? (
        <fieldset className="stack-s" data-testid="goal-op-resume-retry">
          <legend className="text-small">
            {t(
              '同时重试这些失败的步骤（不选的保持失败）',
              'Also retry these failed steps (unticked ones stay failed)',
            )}
          </legend>
          {failed.map((key) => (
            <label key={key} className="row-wrap text-small">
              <input type="checkbox" checked={retry.has(key)} onChange={() => toggle(key)} />
              <span className="mono">{key}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </Confirm>
  );
}

type EndOutcome = 'not_achieved' | 'achieved';

function EndConfirm({
  achievedAllowed,
  overridden,
  onEnd,
  ...control
}: OpenControl & {
  readonly achievedAllowed: boolean;
  /** The acceptance checks that ending as achieved records as the requester's decision. */
  readonly overridden: readonly OverriddenCheck[];
  readonly onEnd: (outcome: EndOutcome, note: { note?: string }) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const [outcome, setOutcome] = useState<EndOutcome>('not_achieved');
  const note = useNote();
  return (
    <Confirm
      tier="medium"
      {...control}
      title={t('按你的判定结束目标', 'End the goal on your word')}
      impact={[
        t(
          '还没开始的步骤会被跳过；目标结束后不能再继续',
          'Steps not started are skipped; the goal cannot go on afterwards',
        ),
        ...(outcome === 'achieved'
          ? [
              overridden.length > 0
                ? t(
                    `这些验收检查没通过或还没做，会记为「请求人判定通过」并写进审计：${overridden.map((check) => `${check.key}（${check.sentence}）`).join('；')}`,
                    `These acceptance checks did not pass or have not run, and are recorded as passed on the requester’s decision, in the audit trail: ${overridden.map((check) => `${check.key} (${check.sentence})`).join('; ')}`,
                  )
                : t('验收检查都已通过', 'Every acceptance check has passed'),
            ]
          : []),
      ]}
      confirmLabel={t('结束目标', 'End goal')}
      confirmDisabled={note.tooLong}
      onConfirm={() => onEnd(outcome, note.params)}
    >
      <Field id={id} label={t('结果', 'Outcome')}>
        <Select
          id={id}
          aria-label={t('结果', 'Outcome')}
          className="select-fit"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as EndOutcome)}
          data-testid="goal-op-end-outcome"
        >
          <option value="not_achieved">{t('未达成', 'Not achieved')}</option>
          {achievedAllowed ? <option value="achieved">{t('达成', 'Achieved')}</option> : null}
        </Select>
      </Field>
      {note.field}
    </Confirm>
  );
}

/** Inside the 解除锁定 confirm: whether the requester changed the plan while the goal was held
 *  (review #493 on #685) — the hold's time from the goal's audit trail, then the revisions
 *  accepted since. */
function HoldPlanChanges({
  goal,
  http,
}: { readonly goal: GoalDetailWire; readonly http: CapabilityCaller }) {
  const t = useT();
  const can = useRoleCan(http);
  const mayReadAudit = can('audit_query') === true;
  const load = useCallback(async () => {
    if (!mayReadAudit) return null;
    // By action, not the goal's whole trail: every read of the goal writes an audit row too, so a
    // page of the trail can hold none of the hold (review #501 on #697).
    const query = (action: string, limit: number) =>
      http.call<{ items: readonly AuditRecordWire[] }>('audit_query', {
        filter: { resourceType: 'goal_run', resourceId: goal.id, action },
        limit,
      });
    const [holds, pauses] = await Promise.all([
      query('goal_run.hold', 1),
      query('goal_run.pause', 50),
    ]);
    return holdPlacedAt([...holds.items, ...pauses.items]);
  }, [http, goal.id, mayReadAudit]);
  const heldAt = useResource(load);
  if (can('audit_query') === null || heldAt.state.status === 'loading') {
    return <SkeletonRows count={1} label={t('读取锁定时间', 'Reading when it was held')} />;
  }
  const since = heldAt.state.status === 'ready' ? heldAt.state.data : null;
  if (since === null) {
    return (
      <Notice tone="info" testId="goal-hold-plan">
        {t(
          `没查到锁定的时间；当前生效的是计划第 ${goal.currentRevision ?? 1} 版，下面的「计划版本」列出了每一版的时间。`,
          `Could not find when it was held; plan v${goal.currentRevision ?? 1} is in force; Plan revisions below lists when each version came.`,
        )}
      </Notice>
    );
  }
  const changed = revisionsSince(goal.revisions, since);
  if (changed.length === 0) {
    return (
      <Notice tone="info" testId="goal-hold-plan">
        {t('锁定后计划没有改过。', 'The plan has not changed since the hold.')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" testId="goal-hold-plan">
      {t(
        `锁定后请求人改过计划：${changed.map((revision) => `第 ${revision.revision} 版`).join('、')}。解除前先在下面的「计划版本」里看看改了什么。`,
        `Its requester revised the plan while it was held: ${changed.map((revision) => `v${revision.revision}`).join(', ')}. Look at what changed under Plan revisions below before lifting the hold.`,
      )}
    </Notice>
  );
}
