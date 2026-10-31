import {
  type DecidePlanRevisionResultWire,
  type GoalDetailWire,
  type PlanRevisionSummaryWire,
  type PlanRevisionWire,
  type PlanningRoundWire,
  visibleLines,
} from '@nexttime/shared';
import { type ReactNode, useCallback, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { GoalViewer } from '../../lib/goal-actions.js';
import {
  mayDecidePlannerProposal,
  pendingPlannerProposal,
  planningOutcomeText,
  runningPlanningRound,
} from '../../lib/goal-planner.js';
import {
  type PlanDiff,
  isStepAuthorityHint,
  planDiff,
  planHintText,
  stepFailureText,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { Notice } from '../kit/notice.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import {
  type GoalOperationOutcome,
  goalOperationErrors,
  useOperationDone,
} from './GoalOperationsBar.js';

export interface GoalPlannerSectionProps {
  readonly goal: GoalDetailWire;
  readonly viewer: GoalViewer;
  readonly http: CapabilityCaller;
  /** Gatekeeper names, for the hints of the proposed plan. */
  readonly gateNames: ReadonlyMap<string, string>;
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

/**
 * components/goals/GoalPlannerSection (S11 GO9a): 目标规划器 on a goal whose requester let the
 * planner propose revisions when they confirmed it — what it is doing now (a round running for a
 * failed step), the revision it proposed with what that changes against the plan in force, and the
 * requester's decision about it (`decide_plan_revision`: 接受并继续, 只接受, 拒绝); then every
 * round so far, each with why it ended as it did. Nothing here runs anything by itself: what the
 * planner proposes takes effect only once the requester accepts it, and anyone else reads who
 * decides.
 */
export function GoalPlannerSection({
  goal,
  viewer,
  http,
  gateNames,
  onDone,
}: GoalPlannerSectionProps) {
  const t = useT();
  if (goal.planner === null && goal.planningRounds.length === 0) return null;
  const proposal = pendingPlannerProposal(goal);
  const running = runningPlanningRound(goal);
  const rounds = [...goal.planningRounds].reverse();
  return (
    <DashboardCard title={t('目标规划器', 'Goal planner')} data-testid="goal-planner">
      <div className="stack">
        <span className="text-small text-3">
          {t(
            '确认这个目标时，请求人允许目标规划器在步骤失败、需要人决定时提一个修订。规划器只提议：它看不到外部系统，也不能发起动作；它提的修订要请求人接受才生效，用掉的 token 计入目标的预算。',
            'When confirming this goal, its requester let the goal planner propose a revision when a step fails and a person must decide. The planner only proposes: it sees no outside system and cannot act; what it proposes takes effect only once the requester accepts it, and the tokens it uses count against the goal’s budget.',
          )}
        </span>
        {running ? <RunningRound round={running} http={http} t={t} /> : null}
        {proposal ? (
          <PlannerProposal
            goal={goal}
            proposal={proposal}
            round={goal.planningRounds.find((round) => round.revision === proposal.revision)}
            viewer={viewer}
            http={http}
            gateNames={gateNames}
            onDone={onDone}
          />
        ) : null}
        {rounds.length > 0 ? (
          <details className="disclosure" data-testid="goal-planner-rounds">
            <summary>
              {t(`规划记录（${rounds.length} 轮）`, `Planning rounds (${rounds.length})`)}
            </summary>
            <ol className="disclosure-body stack-s">
              {rounds.map((round) => (
                <RoundItem key={round.id} round={round} http={http} t={t} />
              ))}
            </ol>
          </details>
        ) : (
          <span className="text-small text-3" data-testid="goal-planner-none">
            {t(
              '还没有步骤因为需要人决定而失败，规划器没有跑过。',
              'No step has failed for a person yet, so the planner has not run.',
            )}
          </span>
        )}
      </div>
    </DashboardCard>
  );
}

function failedStepText(round: PlanningRoundWire, t: Translate): string {
  const category = stepFailureText(round.failureCategory, t).short;
  return t(
    `步骤 ${round.stepKey} 第 ${round.stepAttempt} 次尝试（${category}）`,
    `step ${round.stepKey}, attempt ${round.stepAttempt} (${category})`,
  );
}

function RunningRound({
  round,
  http,
  t,
}: {
  readonly round: PlanningRoundWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  return (
    <Notice tone="info" testId="goal-planner-running">
      <span className="stack-s">
        <span>
          {t(
            `规划器正在看${failedStepText(round, t)}为什么失败，准备提一个修订。它跑完前你也可以自己继续、修订或取消，那样这一轮就作废。`,
            `The planner is looking at why ${failedStepText(round, t)} failed, to propose a revision. You may still resume, revise or cancel the goal yourself meanwhile; this round is then dropped.`,
          )}
        </span>
        {round.taskId ? (
          <span className="row-wrap text-small">
            <span className="text-3">{t('规划任务', 'Planning task')}</span>
            <RefChip
              kind="task"
              id={round.taskId}
              http={http}
              href={hrefs.task(round.taskId)}
              size="s"
              testId="goal-planner-running-task"
            />
          </span>
        ) : null}
      </span>
    </Notice>
  );
}

function RoundItem({
  round,
  http,
  t,
}: {
  readonly round: PlanningRoundWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  const outcome = planningOutcomeText(round, t);
  return (
    <li className="stack-s" data-testid="goal-planner-round" data-status={round.status}>
      <span className="row-wrap text-small">
        <StatusChip machine="planningRound" status={round.status} size="s" />
        <span>{failedStepText(round, t)}</span>
        <span className="text-3">
          {t(`基于第 ${round.basedOnRevision} 版`, `on v${round.basedOnRevision}`)}
        </span>
        <time className="text-3" title={formatDateTime(round.createdAt)}>
          {formatRelative(round.createdAt)}
        </time>
        {round.taskId ? (
          <RefChip
            kind="task"
            id={round.taskId}
            http={http}
            href={hrefs.task(round.taskId)}
            size="s"
          />
        ) : null}
      </span>
      {round.status === 'proposed' && round.revision !== null ? (
        <span className="text-small">
          {t(`提了第 ${round.revision} 版修订。`, `Proposed revision v${round.revision}.`)}
        </span>
      ) : null}
      {outcome ? <span className="text-small text-3">{outcome}</span> : null}
      {round.detail ? (
        <p className="pre-wrap text-small" data-testid="goal-planner-round-detail">
          {round.status === 'no_revision'
            ? t('规划器的说明：', 'The planner says: ')
            : t('平台发现：', 'The platform found: ')}
          {visibleLines(round.detail)}
        </p>
      ) : null}
    </li>
  );
}

type Decision = 'acceptResume' | 'accept' | 'reject';

function PlannerProposal({
  goal,
  proposal,
  round,
  viewer,
  http,
  gateNames,
  onDone,
}: {
  readonly goal: GoalDetailWire;
  readonly proposal: PlanRevisionSummaryWire;
  readonly round: PlanningRoundWire | undefined;
  readonly viewer: GoalViewer;
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const [open, setOpen] = useState<Decision | null>(null);
  const run = useOperationDone(onDone, goal);
  const loadPlan = useCallback(
    () =>
      http.call<PlanRevisionWire>('get_goal_revision', {
        goalRunId: goal.id,
        revision: proposal.revision,
      }),
    [http, goal.id, proposal.revision],
  );
  const proposed = useResource(loadPlan);
  const diff =
    proposed.state.status === 'ready'
      ? planDiff(goal.planRevision.plan, proposed.state.data.plan)
      : null;
  const decides = mayDecidePlannerProposal(goal, viewer) && can('decide_plan_revision') !== false;
  const held = goal.pausedByAuthority === 'owner';
  const errors = {
    ...goalOperationErrors(t),
    invalid_params: t(
      '这个修订复查没通过（比如它用到的 Worker 已经停用，或修订次数已经用完），不能接受了，什么也没改；具体问题见技术细节。可以拒绝它，或自己修订计划。',
      'This revision no longer passes its checks (a Worker it uses was deprecated, or the goal has used its revisions), so it cannot be accepted and nothing changed; the problems are under technical details. Reject it, or revise the plan yourself.',
    ),
  };
  const decide = (decision: Decision) =>
    run(
      http.call<DecidePlanRevisionResultWire>('decide_plan_revision', {
        goalRunId: goal.id,
        revision: proposal.revision,
        decision: decision === 'reject' ? 'reject' : 'accept',
        ...(decision === 'acceptResume' ? { resume: true } : {}),
      }),
      (result) =>
        result.decision === 'reject'
          ? t(
              `已拒绝规划器的第 ${proposal.revision} 版修订。目标仍然暂停：你可以重试失败的步骤、自己修订计划或取消。`,
              `The planner’s revision v${proposal.revision} was rejected. The goal is still paused: retry the failed step, revise the plan yourself, or cancel.`,
            )
          : result.resumed
            ? t(
                `计划已改为第 ${result.revision} 版，目标继续执行。`,
                `The plan is now v${result.revision} and the goal is running again.`,
              )
            : t(
                `计划已改为第 ${result.revision} 版。目标仍然暂停：要接着执行，按「继续」。`,
                `The plan is now v${result.revision}. The goal is still paused: resume it to go on.`,
              ),
      (result) =>
        result.hints
          .filter(isStepAuthorityHint)
          .map((hint) => planHintText(hint, t, gateNames, 'revision')),
    );
  const openProps = (decision: Decision) => ({
    open: open === decision,
    onOpenChange: (next: boolean) => setOpen(next ? decision : null),
    errorOverrides: errors,
    testId: `goal-planner-${decision}-confirm`,
  });
  const changeLines = diff ? diffImpact(diff, t) : [];
  const anchor = (decision: Decision, label: string, variant: 'primary' | 'secondary') => (
    <Button
      variant={variant}
      size="s"
      disabled={decision === 'acceptResume' && held}
      aria-describedby={decision === 'acceptResume' && held ? 'goal-planner-held' : undefined}
      onClick={() => setOpen(decision)}
      data-testid={`goal-planner-${decision}`}
    >
      {label}
    </Button>
  );
  let actions: ReactNode;
  if (decides) {
    actions = (
      <div className="stack-s">
        <div className="row-wrap">
          <Confirm
            tier="medium"
            {...openProps('acceptResume')}
            anchor={anchor('acceptResume', t('接受并继续', 'Accept and resume'), 'primary')}
            title={t(
              `接受第 ${proposal.revision} 版并继续`,
              `Accept v${proposal.revision} and resume`,
            )}
            impact={[
              t(
                `计划改为规划器提的第 ${proposal.revision} 版，计入目标的修订次数`,
                `The plan becomes the planner’s v${proposal.revision}, counted against the goal’s revisions`,
              ),
              ...changeLines,
              t(
                '目标马上继续，以你的授权花费预算、发起动作；需要审批的动作仍然逐个审批',
                'The goal moves on at once, spending its budget and acting with your authority; actions that need approval are still approved one by one',
              ),
            ]}
            confirmLabel={t('接受并继续', 'Accept and resume')}
            onConfirm={() => decide('acceptResume')}
          />
          <Confirm
            tier="medium"
            {...openProps('accept')}
            anchor={anchor('accept', t('只接受', 'Accept only'), 'secondary')}
            title={t(`接受第 ${proposal.revision} 版`, `Accept v${proposal.revision}`)}
            impact={[
              t(
                `计划改为规划器提的第 ${proposal.revision} 版，计入目标的修订次数`,
                `The plan becomes the planner’s v${proposal.revision}, counted against the goal’s revisions`,
              ),
              ...changeLines,
              t('目标保持暂停，由你之后按「继续」', 'The goal stays paused until you resume it'),
            ]}
            confirmLabel={t('接受', 'Accept')}
            onConfirm={() => decide('accept')}
          />
          <Confirm
            tier="medium"
            danger
            {...openProps('reject')}
            anchor={anchor('reject', t('拒绝', 'Reject'), 'secondary')}
            title={t(`拒绝第 ${proposal.revision} 版`, `Reject v${proposal.revision}`)}
            impact={[
              t(
                '这个提议被拒绝，计划和目标都不变，目标保持暂停',
                'The proposal is turned down; the plan and the goal stay as they are, paused',
              ),
              t(
                '规划器不会为同一次失败再提修订：之后由你重试失败的步骤、自己修订计划或取消',
                'The planner does not propose again for the same failure: retry the failed step, revise the plan yourself, or cancel',
              ),
            ]}
            confirmLabel={t('拒绝', 'Reject')}
            onConfirm={() => decide('reject')}
          />
        </div>
        {held ? (
          <span id="goal-planner-held" className="text-small text-3">
            {t(
              '接受并继续：工作区所有者锁定了这个目标，现在只能接受或拒绝，解除锁定后再继续。',
              'Accept and resume: a workspace owner holds this goal, so for now accept or reject it, and resume once the hold is lifted.',
            )}
          </span>
        ) : null}
      </div>
    );
  } else {
    actions = (
      <span className="row-wrap text-small text-3" data-testid="goal-planner-decider">
        {t('由目标的请求人决定：', 'Decided by the goal’s requester: ')}
        <RefChip kind="principal" id={goal.onBehalfOf} http={http} size="s" />
      </span>
    );
  }
  return (
    <section
      className="stack-s"
      data-testid="goal-planner-proposal"
      data-revision={proposal.revision}
    >
      <span className="row-wrap">
        <strong>
          {t(
            `规划器提了第 ${proposal.revision} 版修订`,
            `The planner proposed v${proposal.revision}`,
          )}
        </strong>
        <StatusChip machine="planRevision" status={proposal.status} size="s" />
        <time className="text-3 text-small" title={formatDateTime(proposal.createdAt)}>
          {formatRelative(proposal.createdAt)}
        </time>
      </span>
      {round ? (
        <span className="text-small text-3">
          {t(
            `针对${failedStepText(round, t)}的失败。`,
            `For the failure of ${failedStepText(round, t)}.`,
          )}
        </span>
      ) : null}
      {proposal.reason ? (
        <p className="pre-wrap" data-testid="goal-planner-reason">
          {visibleLines(proposal.reason)}
        </p>
      ) : null}
      {proposed.state.status === 'ready' && diff ? (
        <ProposalChanges
          diff={diff}
          plan={proposed.state.data}
          http={http}
          gateNames={gateNames}
          t={t}
        />
      ) : proposed.state.status === 'error' ? (
        <ErrorBanner
          error={proposed.state.error}
          title={t('无法读取规划器提的计划', 'Could not read the proposed plan')}
          onRetry={() => void proposed.reload()}
        />
      ) : (
        <SkeletonRows count={2} label={t('正在读取提议的计划', 'Loading the proposed plan')} />
      )}
      {actions}
    </section>
  );
}

/** What accepting changes, one confirm line each: the step keys added, removed (their Workers
 *  stopped) and redefined, and whether the goal's acceptance checks changed. */
function diffImpact(diff: PlanDiff, t: Translate): string[] {
  const lines: string[] = [];
  if (diff.added.length > 0)
    lines.push(t(`新增步骤：${diff.added.join('、')}`, `Steps added: ${diff.added.join(', ')}`));
  if (diff.removed.length > 0)
    lines.push(
      t(
        `去掉步骤：${diff.removed.join('、')}（还在运行的会停下）`,
        `Steps removed: ${diff.removed.join(', ')} (any still running stop)`,
      ),
    );
  if (diff.changed.length > 0)
    lines.push(
      t(
        `改动步骤：${diff.changed.join('、')}（按新定义重来）`,
        `Steps redefined: ${diff.changed.join(', ')} (they start over as redefined)`,
      ),
    );
  if (diff.acceptanceChanged)
    lines.push(t('目标的验收检查也改了', 'The goal’s acceptance checks change too'));
  return lines;
}

function ProposalChanges({
  diff,
  plan,
  http,
  gateNames,
  t,
}: {
  readonly diff: PlanDiff;
  readonly plan: PlanRevisionWire;
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}) {
  const steps = new Map(plan.plan.steps.map((step) => [step.key, step]));
  const rows: { key: string; label: string; keys: readonly string[] }[] = [
    { key: 'added', label: t('新增步骤', 'Steps added'), keys: diff.added },
    { key: 'removed', label: t('去掉步骤', 'Steps removed'), keys: diff.removed },
    { key: 'changed', label: t('改动的步骤', 'Steps redefined'), keys: diff.changed },
  ].filter((row) => row.keys.length > 0);
  return (
    <div className="stack-s text-small" data-testid="goal-planner-changes">
      {rows.length === 0 && !diff.acceptanceChanged ? (
        <span className="text-3">
          {t(
            '和在用的计划相比，步骤和验收检查都没变。',
            'No step or check differs from the plan in force.',
          )}
        </span>
      ) : (
        <ul className="stack-s">
          {rows.map((row) => (
            <li key={row.key} className="row-wrap" data-diff={row.key}>
              <span className="text-3">{row.label}</span>
              {row.keys.map((key) => {
                const step = steps.get(key);
                return (
                  <span key={key} className="row-wrap">
                    <span className="mono">{key}</span>
                    {step && row.key !== 'removed' ? (
                      <>
                        <RefChip
                          kind="workerDefinition"
                          id={step.worker.definitionId}
                          http={http}
                          size="s"
                        />
                        <span className="text-3">v{step.worker.version}</span>
                      </>
                    ) : null}
                  </span>
                );
              })}
            </li>
          ))}
          {diff.acceptanceChanged ? (
            <li>{t('目标的验收检查改了。', 'The goal’s acceptance checks changed.')}</li>
          ) : null}
        </ul>
      )}
      {plan.hints.map((hint) => (
        <Notice key={`${hint.code}:${hint.stepKey ?? ''}`} tone="warn" testId="goal-planner-hint">
          {planHintText(hint, t, gateNames, 'revision')}
        </Notice>
      ))}
    </div>
  );
}
