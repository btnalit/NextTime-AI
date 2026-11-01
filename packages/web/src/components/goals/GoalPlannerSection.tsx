import {
  DEFAULT_MAX_ATTEMPTS,
  type DecidePlanRevisionResultWire,
  type GoalDetailWire,
  type GoalPlan,
  type PlanRevisionSummaryWire,
  type PlanRevisionWire,
  type PlanStep,
  type PlannerRevisionClassReasonWire,
  type PlanningRoundWire,
  visibleLines,
} from '@nexttime/shared';
import { type ReactNode, useCallback, useState } from 'react';
import { useResource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  formatDateTime,
  formatRelative,
  prettyJsonVisible,
  redactSensitive,
  shortId,
} from '../../lib/format.js';
import type { GoalViewer } from '../../lib/goal-actions.js';
import {
  adoptedRoundInForce,
  currentPlanningConclusion,
  majorReasonTexts,
  mayDecidePlannerProposal,
  pendingPlannerProposal,
  plannerRoundsUsedUpText,
  planningOutcomeText,
  runningPlanningRound,
  showsRoundDetail,
  stepMajorReasons,
} from '../../lib/goal-planner.js';
import {
  type AcceptanceDiff,
  type PlanDiff,
  acceptanceDiff,
  bindingSentence,
  checkKindLabel,
  filesFromSentence,
  isStepAuthorityHint,
  isStepContractHint,
  planCheckSentence,
  planDiff,
  planHintText,
  reconcileCheckSentence,
  stepFailureText,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { type StepChange, planStepDiff, stepChangeLine } from '../../lib/plan-step-diff.js';
import { hrefs } from '../../lib/router.js';
import { stepAdmissionView } from '../../lib/worker-spec-detail.js';
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
import { StepAdmissionLine } from './GoalStepsSection.js';
import { OutputContractFields } from './OutputContract.js';
import { StepChangeList } from './StepChangeList.js';
import { WorkerSpecFields } from './WorkerSpecFields.js';

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
 * decides. GO9b: under an `apply_minor` leave the platform adopts a minor revision for the
 * requester while the goal runs (the round reads 已按授权采用); a revision it leaves to them says
 * why (`classReasons`). GO10b: a round may be for the goal's verification round that did not pass
 * instead of a failed step (`point`); what it proposes is always the requester's to decide.
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
  const conclusion = currentPlanningConclusion(goal);
  const adopted = adoptedRoundInForce(goal);
  const rounds = [...goal.planningRounds].reverse();
  // S11 GO10: what the planner spent so far — its rounds, against the limit they have the same as
  // the plan revisions (counted apart, UX P3-1 on #870), and its tokens (part of the goal's).
  const ran = goal.usage.plannerRounds;
  const spent =
    ran > 0
      ? t(
          `到目前规划器跑了 ${ran} 轮（最多 ${goal.budget.maxRevisions} 轮，上限和计划修订次数相同），用了 ${goal.usage.plannerTokens.toLocaleString()} token。`,
          `So far the planner ran ${ran} of at most ${goal.budget.maxRevisions} ${goal.budget.maxRevisions === 1 ? 'round' : 'rounds'} (the same limit as plan revisions) and used ${goal.usage.plannerTokens.toLocaleString()} tokens.`,
        )
      : null;
  return (
    <DashboardCard title={t('目标规划器', 'Goal planner')} data-testid="goal-planner">
      <div className="stack">
        <span
          className="text-small text-3"
          data-testid="goal-planner-mode"
          data-mode={goal.planner ?? 'none'}
        >
          {goal.planner === 'apply_minor'
            ? t(
                '确认这个目标时，请求人允许目标规划器在步骤失败时换一条路，并允许平台替自己采用小修订：只换 Worker、输入、顺序或重试次数、验收不变的修订，目标不停；其余的修订暂停目标，等请求人决定。所有步骤都成功但目标的验收没通过时，规划器只提议，修订由请求人决定。规划器看不到外部系统，也不能发起动作；用掉的 token 计入目标的预算。',
                'When confirming this goal, its requester let the goal planner find another way when a step fails, and the platform adopt minor revisions for them: one that only changes the Worker, input, order or retry limit, on unchanged checks, goes on without stopping the goal; any other pauses the goal for the requester to decide. When every step succeeded and the goal’s acceptance did not pass, the planner only proposes and the requester decides. The planner sees no outside system and cannot act; the tokens it uses count against the goal’s budget.',
              )
            : t(
                '确认这个目标时，请求人允许目标规划器在步骤失败、需要人决定时，或所有步骤都成功但目标的验收没通过时，提一个修订。规划器只提议：它看不到外部系统，也不能发起动作；它提的修订要请求人接受才生效，用掉的 token 计入目标的预算。',
                'When confirming this goal, its requester let the goal planner propose a revision when a step fails and a person must decide, or when every step succeeded and the goal’s acceptance did not pass. The planner only proposes: it sees no outside system and cannot act; what it proposes takes effect only once the requester accepts it, and the tokens it uses count against the goal’s budget.',
              )}
        </span>
        {spent ? (
          <span className="text-small text-3" data-testid="goal-planner-spent">
            {spent}
          </span>
        ) : null}
        {running ? <RunningRound round={running} http={http} t={t} /> : null}
        {adopted ? (
          <AdoptedRevision goal={goal} round={adopted} http={http} gateNames={gateNames} t={t} />
        ) : null}
        {conclusion ? <Conclusion goal={goal} round={conclusion} t={t} /> : null}
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
                <RoundItem key={round.id} goal={goal} round={round} http={http} t={t} />
              ))}
            </ol>
          </details>
        ) : (
          <span className="text-small text-3" data-testid="goal-planner-none">
            {/* UX P3-2 on #866: under apply_minor the planner runs on any failure it can take. */}
            {goal.planner === 'apply_minor'
              ? t(
                  '还没有步骤失败，目标的验收也没有不通过，规划器还没跑过。',
                  'No step has failed and the goal’s acceptance has not failed yet, so the planner has not run.',
                )
              : t(
                  '还没有步骤失败到要人决定，目标的验收也没有不通过，规划器还没跑过。',
                  'No step has failed to the point of a person deciding and the goal’s acceptance has not failed yet, so the planner has not run.',
                )}
          </span>
        )}
      </div>
    </DashboardCard>
  );
}

/** A step's round: the attempt it was for (an autonomous round is always one, I-P6). */
function failedStepText(round: PlanningRoundWire, t: Translate): string {
  const category = round.failureCategory ? stepFailureText(round.failureCategory, t).short : '';
  return t(
    `步骤 ${round.stepKey} 第 ${round.stepAttempt} 次尝试（${category}）`,
    `step ${round.stepKey}, attempt ${round.stepAttempt} (${category})`,
  );
}

/** What a round was for, as the planning record lists it — the failed attempt of a step, or (S11
 *  GO10b) the goal's verification round that did not pass. */
function roundSubjectText(round: PlanningRoundWire, t: Translate): string {
  return round.point === 'goal_acceptance'
    ? t(
        `目标第 ${round.acceptanceRound} 轮验收没通过`,
        `the goal’s verification round ${round.acceptanceRound} did not pass`,
      )
    : failedStepText(round, t);
}

/** S11 GO10b: what the requester does next once the planner left this pause to them. */
function nextStepsText(round: PlanningRoundWire, t: Translate): string {
  return round.point === 'goal_acceptance'
    ? t(
        '接下来由请求人决定：继续以再验收一次、自己修订计划，或结束目标。',
        'It is up to the requester now: resume to verify again, revise the plan, or end the goal.',
      )
    : t(
        '接下来由请求人重试失败的步骤、自己修订计划或取消。',
        'It is up to the requester now: retry the failed step, revise the plan, or cancel.',
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
          {round.kind === 'autonomous'
            ? t(
                `规划器正在为${failedStepText(round, t)}换一条路，这期间不开始新的尝试，已经在跑的照常进行。小修订平台会替请求人采用，其余的修订暂停目标等请求人决定。你也可以暂停或取消目标，那样这一轮就作废。`,
                `The planner is looking for another way past ${failedStepText(round, t)}; meanwhile no new attempt starts, and those already running go on. A minor revision the platform adopts for the requester; any other pauses the goal for them to decide. You may pause or cancel the goal meanwhile; this round is then dropped.`,
              )
            : round.point === 'goal_acceptance'
              ? t(
                  `所有步骤都成功了，但目标第 ${round.acceptanceRound} 轮验收没通过。规划器正在看为什么，准备提一个修订：加一步、换个方式重做，或改验收检查。它跑完前你也可以自己继续（再验收一次）、修订或取消，那样这一轮就作废。`,
                  `Every step succeeded but the goal’s verification round ${round.acceptanceRound} did not pass. The planner is looking at why, to propose a revision: a step added, work redone another way, or a check changed. You may still resume (to verify again), revise or cancel the goal yourself meanwhile; this round is then dropped.`,
                )
              : t(
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

/** UX P2-2 on #864: what the planner concluded about this pause when it proposed nothing — the
 *  decision is the requester's again, and this is what they were waiting for. */
function Conclusion({
  goal,
  round,
  t,
}: {
  readonly goal: GoalDetailWire;
  readonly round: PlanningRoundWire;
  readonly t: Translate;
}) {
  // UX P2-1 on #870: the planner rounds used up say so, with their count, as the page's top does.
  const usedUp = plannerRoundsUsedUpText(goal, round, t);
  const outcome = usedUp ? null : planningOutcomeText(round, t, goal);
  return (
    <Notice tone="warn" testId="goal-planner-conclusion">
      <span className="stack-s">
        <span>
          {round.point === 'goal_acceptance'
            ? usedUp
              ? t(
                  `${usedUp}，目标第 ${round.acceptanceRound} 轮验收没通过，规划器没有运行。${nextStepsText(round, t)}`,
                  `${usedUp}, so no planner ran for the goal’s verification round ${round.acceptanceRound}, which did not pass. ${nextStepsText(round, t)}`,
                )
              : round.status === 'no_revision'
                ? t(
                    `规划器看过目标第 ${round.acceptanceRound} 轮验收为什么没通过，没有可行的修订。${nextStepsText(round, t)}`,
                    `The planner looked at why the goal’s verification round ${round.acceptanceRound} did not pass and found no revision that would do. ${nextStepsText(round, t)}`,
                  )
                : t(
                    `目标第 ${round.acceptanceRound} 轮验收没通过，规划器没能给出修订。${nextStepsText(round, t)}`,
                    `The planner gave no revision for the goal’s verification round ${round.acceptanceRound}, which did not pass. ${nextStepsText(round, t)}`,
                  )
            : usedUp
              ? t(
                  `${usedUp}，规划器没有为${failedStepText(round, t)}的失败运行。${nextStepsText(round, t)}`,
                  `${usedUp}, so no planner ran for the failure of ${failedStepText(round, t)}. ${nextStepsText(round, t)}`,
                )
              : round.status === 'no_revision'
                ? t(
                    `规划器看过${failedStepText(round, t)}的失败，没有可行的修订。${nextStepsText(round, t)}`,
                    `The planner looked at the failure of ${failedStepText(round, t)} and found no revision that would do. ${nextStepsText(round, t)}`,
                  )
                : t(
                    `规划器没能为${failedStepText(round, t)}的失败给出修订。${nextStepsText(round, t)}`,
                    `The planner gave no revision for the failure of ${failedStepText(round, t)}. ${nextStepsText(round, t)}`,
                  )}
        </span>
        {outcome ? <span className="text-small text-3">{outcome}</span> : null}
        {showsRoundDetail(round) && round.detail ? (
          <p className="pre-wrap text-small" data-testid="goal-planner-conclusion-detail">
            {round.status === 'no_revision'
              ? t('规划器的说明：', 'The planner says: ')
              : t('平台发现：', 'The platform found: ')}
            {visibleLines(round.detail)}
          </p>
        ) : null}
      </span>
    </Notice>
  );
}

/** UX P2-2 on #866: the revision the platform adopted for the requester, while it is the plan in
 *  force — shown open, as a proposal is: what the planner said, what it changed against the plan
 *  it replaced (each step added or redefined as it runs), and what a person who disagrees does. */
function AdoptedRevision({
  goal,
  round,
  http,
  gateNames,
  t,
}: {
  readonly goal: GoalDetailWire;
  readonly round: PlanningRoundWire;
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}) {
  const revision = round.revision ?? goal.currentRevision;
  const load = useCallback(
    () =>
      Promise.all([
        http.call<PlanRevisionWire>('get_goal_revision', { goalRunId: goal.id, revision }),
        http.call<PlanRevisionWire>('get_goal_revision', {
          goalRunId: goal.id,
          revision: round.basedOnRevision,
        }),
      ]),
    [http, goal.id, revision, round.basedOnRevision],
  );
  const plans = useResource(load);
  return (
    <section className="stack-s" data-testid="goal-planner-adopted" data-revision={revision}>
      <span className="row-wrap">
        <strong>
          {t(
            `平台按请求人的授权采用了规划器的第 ${revision} 版修订`,
            `The platform adopted the planner’s v${revision} on the requester’s leave`,
          )}
        </strong>
        <StatusChip machine="planningRound" status="applied" size="s" />
        {round.settledAt ? (
          <time className="text-3 text-small" title={formatDateTime(round.settledAt)}>
            {formatRelative(round.settledAt)}
          </time>
        ) : null}
      </span>
      <span className="text-small text-3">
        {t(
          `针对${failedStepText(round, t)}的失败；这是小修订，目标没有停。`,
          `For the failure of ${failedStepText(round, t)}; a minor revision, so the goal did not stop.`,
        )}
      </span>
      {plans.state.status === 'ready' ? (
        <>
          {plans.state.data[0].reason ? (
            <p className="pre-wrap" data-testid="goal-planner-adopted-reason">
              {visibleLines(plans.state.data[0].reason)}
            </p>
          ) : null}
          <ProposalChanges
            diff={planDiff(plans.state.data[1].plan, plans.state.data[0].plan)}
            before={plans.state.data[1].plan}
            plan={plans.state.data[0]}
            reasons={[]}
            http={http}
            gateNames={gateNames}
            t={t}
          />
        </>
      ) : plans.state.status === 'error' ? (
        <ErrorBanner
          error={plans.state.error}
          title={t('无法读取平台采用的计划', 'Could not read the adopted plan')}
          onRetry={() => void plans.reload()}
        />
      ) : (
        <SkeletonRows count={2} label={t('正在读取平台采用的计划', 'Loading the adopted plan')} />
      )}
      <span className="text-small text-3" data-testid="goal-planner-adopted-disagree">
        {t(
          '如果不同意，可以暂停目标后修订计划。',
          'To undo it, pause the goal and revise the plan.',
        )}
      </span>
    </section>
  );
}

/** UX P3-4 on #864: what became of the revision a round proposed. */
function proposedFate(
  goal: GoalDetailWire,
  revision: number,
  t: Translate,
): { readonly zh: string; readonly en: string } | null {
  const row = goal.revisions.find((candidate) => candidate.revision === revision);
  if (!row) return null;
  if (row.status === 'accepted') return { zh: '已接受', en: 'accepted' };
  if (row.status === 'rejected') return { zh: '已拒绝', en: 'rejected' };
  return row.basedOnRevision === goal.currentRevision
    ? { zh: '等请求人决定', en: 'waiting for the requester' }
    : null;
}

function RoundItem({
  goal,
  round,
  http,
  t,
}: {
  readonly goal: GoalDetailWire;
  readonly round: PlanningRoundWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  const outcome = planningOutcomeText(round, t, goal);
  const fate = round.revision !== null ? proposedFate(goal, round.revision, t) : null;
  return (
    <li className="stack-s" data-testid="goal-planner-round" data-status={round.status}>
      <span className="row-wrap text-small">
        <StatusChip machine="planningRound" status={round.status} size="s" />
        <span data-testid="goal-planner-round-subject" data-point={round.point}>
          {roundSubjectText(round, t)}
        </span>
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
        <span className="text-small" data-testid="goal-planner-round-proposed">
          {fate
            ? t(
                `提了第 ${round.revision} 版修订（${fate.zh}）。`,
                `Proposed revision v${round.revision} (${fate.en}).`,
              )
            : t(`提了第 ${round.revision} 版修订。`, `Proposed revision v${round.revision}.`)}
        </span>
      ) : null}
      {round.status === 'applied' && round.revision !== null ? (
        <span className="text-small" data-testid="goal-planner-round-applied">
          {t(
            `提了第 ${round.revision} 版修订，是小修订，平台按请求人的授权采用了它，目标没有停。`,
            `Proposed revision v${round.revision}, a minor one: the platform adopted it on the requester’s leave, and the goal did not stop.`,
          )}
        </span>
      ) : null}
      {outcome ? <span className="text-small text-3">{outcome}</span> : null}
      {showsRoundDetail(round) && round.detail ? (
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
          .filter((hint) => isStepAuthorityHint(hint) || isStepContractHint(hint))
          .map((hint) => planHintText(hint, t, gateNames, 'revision')),
    );
  const openProps = (decision: Decision) => ({
    open: open === decision,
    onOpenChange: (next: boolean) => setOpen(next ? decision : null),
    errorOverrides: errors,
    testId: `goal-planner-${decision}-confirm`,
  });
  const changeLines =
    diff && proposed.state.status === 'ready'
      ? diffImpact(
          diff,
          planStepDiff(goal.planRevision.plan, proposed.state.data.plan),
          acceptanceDiff(goal.planRevision.plan, proposed.state.data.plan),
          goal,
          gateNames,
          t,
        )
      : [];
  // S11 GO10b: a revision for the goal's acceptance not passing leads to verifying it again.
  const forAcceptance = round?.point === 'goal_acceptance';
  const verifiesAgain = forAcceptance
    ? [
        t(
          '所有步骤都完成后，平台重新验收目标（新的一轮）',
          'Once every step is done, the platform verifies the goal again, in a new round',
        ),
      ]
    : [];
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
              ...verifiesAgain,
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
              ...verifiesAgain,
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
              forAcceptance
                ? t(
                    '规划器不会为这一轮验收再提修订：之后由你继续以再验收一次、自己修订计划或结束目标',
                    'The planner does not propose again for this verification round: resume to verify again, revise the plan yourself, or end the goal',
                  )
                : t(
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
        {/* UX P3-8 on #864: not the goal's own 「待确认」 — whose decision it waits for. */}
        <span className="chip chip-accent chip-s" data-testid="goal-planner-proposal-state">
          {decides
            ? t('等你决定', 'Yours to decide')
            : t('等请求人决定', 'Waiting for the requester')}
        </span>
        <time className="text-3 text-small" title={formatDateTime(proposal.createdAt)}>
          {formatRelative(proposal.createdAt)}
        </time>
      </span>
      {round ? (
        <span className="text-small text-3" data-testid="goal-planner-proposal-for">
          {round.point === 'goal_acceptance'
            ? t(
                `针对目标第 ${round.acceptanceRound} 轮验收没通过。`,
                `For the goal’s verification round ${round.acceptanceRound}, which did not pass.`,
              )
            : t(
                `针对${failedStepText(round, t)}的失败。`,
                `For the failure of ${failedStepText(round, t)}.`,
              )}
        </span>
      ) : null}
      {round && round.revisionClass === 'major' && round.classReasons.length > 0 ? (
        <div className="stack-s" data-testid="goal-planner-major-reasons">
          <span className="text-small">
            {round.kind === 'autonomous'
              ? t(
                  '这不是小修订，平台没有替请求人采用，目标为此暂停：',
                  'This is not a minor revision, so the platform did not adopt it for the requester and the goal paused for it:',
                )
              : t('接受前请留意：', 'Before accepting, note:')}
          </span>
          <ul className="text-small">
            {majorReasonTexts(round.classReasons, t, gateNames).map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {proposal.reason ? (
        <p className="pre-wrap" data-testid="goal-planner-reason">
          {visibleLines(proposal.reason)}
        </p>
      ) : null}
      {proposed.state.status === 'ready' && diff ? (
        <ProposalChanges
          diff={diff}
          before={goal.planRevision.plan}
          plan={proposed.state.data}
          reasons={round?.revisionClass === 'major' ? round.classReasons : []}
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

/** What accepting changes, one confirm line each: the step keys added, removed (naming the ones
 *  whose work is still running and stops — UX P3-5 on #864) and redefined — S11 GO15a: each with
 *  what changed in it — and each acceptance check of the goal added, dropped or changed (UX P2-1
 *  on #866). */
function diffImpact(
  diff: PlanDiff,
  steps: readonly StepChange[],
  acceptance: AcceptanceDiff,
  goal: GoalDetailWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string[] {
  const lines: string[] = [];
  if (diff.added.length > 0)
    lines.push(t(`新增步骤：${diff.added.join('、')}`, `Steps added: ${diff.added.join(', ')}`));
  if (diff.removed.length > 0) {
    const running = diff.removed.filter((key) =>
      goal.steps.some(
        (step) =>
          step.stepKey === key &&
          step.supersededInRevision === null &&
          (step.status === 'running' || step.status === 'waiting'),
      ),
    );
    lines.push(
      running.length > 0
        ? t(
            `去掉步骤：${diff.removed.join('、')}（${running.join('、')} 还在运行，会停下）`,
            `Steps removed: ${diff.removed.join(', ')} (${running.join(', ')} still running, and stop)`,
          )
        : t(`去掉步骤：${diff.removed.join('、')}`, `Steps removed: ${diff.removed.join(', ')}`),
    );
  }
  for (const change of steps) {
    lines.push(
      t(
        `改动步骤 ${change.key}：${stepChangeLine(change, { gateNames }, t)}（按新定义重来）`,
        `Step ${change.key} redefined: ${stepChangeLine(change, { gateNames }, t)} (it starts over as redefined)`,
      ),
    );
  }
  if (diff.acceptanceChanged) lines.push(...acceptanceLines(acceptance, gateNames, t));
  return lines;
}

/** UX P2-1 on #866: each acceptance check of the goal a revision added, dropped or changed, as
 *  its sentence (a changed one before and after). */
function acceptanceLines(
  acceptance: AcceptanceDiff,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string[] {
  const sentence = (check: AcceptanceDiff['added'][number]) =>
    planCheckSentence(check, gateNames, t);
  return [
    ...acceptance.added.map((check) =>
      t(`目标的验收新增：${sentence(check)}`, `Goal check added: ${sentence(check)}`),
    ),
    ...acceptance.removed.map((check) =>
      t(`目标的验收去掉：${sentence(check)}`, `Goal check dropped: ${sentence(check)}`),
    ),
    ...acceptance.changed.map(({ before, after }) =>
      t(
        `目标的验收 ${after.key} 改了：原来「${sentence(before)}」，改为「${sentence(after)}」`,
        `Goal check ${after.key} changed: was “${sentence(before)}”, now “${sentence(after)}”`,
      ),
    ),
  ];
}

function ProposalChanges({
  diff,
  before,
  plan,
  reasons,
  http,
  gateNames,
  t,
}: {
  readonly diff: PlanDiff;
  /** The plan the revision replaces, for what it changed in the goal's checks. */
  readonly before: GoalPlan;
  readonly plan: PlanRevisionWire;
  /** Why the platform classed it major (none for a minor one), each shown on its step. */
  readonly reasons: readonly PlannerRevisionClassReasonWire[];
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}) {
  const steps = new Map(plan.plan.steps.map((step) => [step.key, step]));
  const stepChanges = planStepDiff(before, plan.plan);
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
          {stepChanges.length > 0 ? (
            <li className="stack-s" data-diff="fields">
              <span className="text-3">
                {t('改动的步骤里改了什么：', 'What changed in each step redefined:')}
              </span>
              <StepChangeList
                changes={stepChanges}
                http={http}
                gateNames={gateNames}
                t={t}
                testId="goal-planner-step-diff"
              />
            </li>
          ) : null}
          {diff.acceptanceChanged ? (
            <li className="stack-s" data-diff="acceptance">
              <span className="text-3">
                {t('目标的验收检查改了：', 'The goal’s acceptance checks changed:')}
              </span>
              <ul className="stack-s" data-testid="goal-planner-acceptance-diff">
                {acceptanceLines(acceptanceDiff(before, plan.plan), gateNames, t).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ) : null}
        </ul>
      )}
      {/* UX P2-3 on #864: what the platform would run for each step added or redefined — the
          planner's reason is the model's word, this is the plan's. */}
      {[...diff.added, ...diff.changed].map((key) => {
        const step = steps.get(key);
        return step ? (
          <ProposedStep
            key={key}
            step={step}
            plan={plan}
            reasons={stepMajorReasons(reasons, key)}
            http={http}
            gateNames={gateNames}
            t={t}
          />
        ) : null;
      })}
      {plan.hints.map((hint) => (
        <Notice key={`${hint.code}:${hint.stepKey ?? ''}`} tone="warn" testId="goal-planner-hint">
          {planHintText(hint, t, gateNames, 'revision')}
        </Notice>
      ))}
    </div>
  );
}

/** One step of the proposed plan as the platform would run it: what it waits for, its Worker's
 *  settings, the inputs it takes from earlier steps, its output contract, its checks and its
 *  input (UX P2-3 on #864). UX P2-1 on #866: first, what in it made the revision major, and what
 *  lets it act — child Workers (`nested`), actions the platform reconciles (`reconcile`). */
function ProposedStep({
  step,
  plan,
  reasons,
  http,
  gateNames,
  t,
}: {
  readonly step: PlanStep;
  /** The revision the step is of — S11 GO15a: its hints and the steps a paused run's read checked
   *  (`checkedStepKeys`), for what admission would say of the step now. */
  readonly plan: PlanRevisionWire;
  readonly reasons: readonly PlannerRevisionClassReasonWire[];
  readonly http: CapabilityCaller;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}) {
  const dependsOn = step.dependsOn ?? [];
  // S11 GO15a: only a verdict the read checked — one it did not check (the goal is not paused, or
  // the revision is not one to decide on) would not start as it stands.
  const admission = stepAdmissionView(plan, step.key, null, []);
  return (
    <details className="disclosure" data-testid="goal-planner-step" data-step-key={step.key}>
      <summary>
        {t(`步骤 ${step.key} 会怎么跑`, `How step ${step.key} would run`)}
        {/* In the summary, so a step that would not start says so while it is closed. */}
        {admission.kind === 'checked' ? (
          <>
            <span className="meta-sep" />
            <StepAdmissionLine view={admission} t={t} />
          </>
        ) : null}
      </summary>
      <div className="disclosure-body stack-s">
        <span className="text-3">
          {dependsOn.length > 0
            ? t(`在这些步骤之后：${dependsOn.join('、')}`, `After: ${dependsOn.join(', ')}`)
            : t('没有前置步骤', 'No earlier step')}
          {t(
            ` · 最多尝试 ${step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS} 次`,
            ` · at most ${step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS} attempts`,
          )}
        </span>
        {reasons.length > 0 ? (
          <div className="stack-s" data-testid="goal-planner-step-reasons">
            <span className="text-3">
              {t(
                '平台没有替请求人采用，因为这一步：',
                'The platform did not adopt it, as this step:',
              )}
            </span>
            <ul className="stack-s">
              {majorReasonTexts(reasons, t, gateNames).map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {step.nested === true ? (
          <span data-testid="goal-planner-step-nested">
            {t(
              '可以起子 Worker：它的 Worker 能让别的 Worker 替它做事',
              'Starts child Workers: its Worker may have other Workers work for it',
            )}
          </span>
        ) : null}
        {step.reconcile && step.reconcile.length > 0 ? (
          <div className="stack-s" data-testid="goal-planner-step-reconcile">
            <span>
              {t(
                '会发起动作（带核对）：结果不明时平台这样核对',
                'Requests actions (reconciled): when an outcome is unknown the platform checks',
              )}
            </span>
            <ul className="stack-s">
              {step.reconcile.map((declaration, index) => (
                <li
                  key={`${declaration.action.gatekeeperId}-${declaration.action.operation}-${index}`}
                  className="text-3"
                >
                  {t(
                    `对门「${gateNames.get(declaration.action.gatekeeperId) ?? shortId(declaration.action.gatekeeperId)}」上的 ${declaration.action.operation}：`,
                    `For ${declaration.action.operation} on gate “${gateNames.get(declaration.action.gatekeeperId) ?? shortId(declaration.action.gatekeeperId)}”: `,
                  )}
                  {reconcileCheckSentence(
                    declaration.check,
                    gateNames.get(declaration.check.gatekeeperId) ?? null,
                    t,
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {step.spec ? (
          <WorkerSpecFields
            spec={step.spec}
            worker={step.worker}
            http={http}
            gateNames={gateNames}
            t={t}
          />
        ) : null}
        {step.bindings && step.bindings.length > 0 ? (
          <ul className="stack-s">
            {step.bindings.map((binding, index) => (
              <li key={`${binding.to}-${index}`} className="text-3">
                {bindingSentence(binding, t)}
              </li>
            ))}
          </ul>
        ) : null}
        {step.filesFrom && step.filesFrom.length > 0 ? (
          <span className="text-3" data-testid="goal-planner-step-files-from">
            {filesFromSentence(step.filesFrom, t)}
          </span>
        ) : null}
        {step.outputSchema ? (
          <div className="stack-s">
            <span className="text-3">{t('输出约定', 'Output contract')}</span>
            <OutputContractFields schema={step.outputSchema} t={t} />
          </div>
        ) : null}
        {step.acceptance && step.acceptance.length > 0 ? (
          <ul className="stack-s" data-testid="goal-planner-step-checks">
            {step.acceptance.map((check) => (
              <li key={check.key} className="row-wrap">
                <span className="text-3">{checkKindLabel(check.kind, t)}</span>
                <span>{planCheckSentence(check, gateNames, t)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {step.input !== undefined ? (
          <div className="stack-s">
            <span className="text-3">{t('输入', 'Input')}</span>
            <pre className="code-block" data-testid="goal-planner-step-input">
              {prettyJsonVisible(redactSensitive(step.input))}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
