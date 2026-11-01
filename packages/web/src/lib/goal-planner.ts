import type {
  GoalDetailWire,
  PlanRevisionSummaryWire,
  PlannerRevisionClassReasonWire,
  PlannerRevisionMajorReason,
  PlanningRoundOutcomeReason,
  PlanningRoundWire,
} from '@nexttime/shared';
import type { GoalViewer } from './goal-actions.js';
import type { Translate } from './i18n.js';

/**
 * lib/goal-planner (S11 GO9a): what the goal page shows of a run's goal planner — the leave its
 * requester gave it, its rounds, and the revision it proposed that waits for them
 * (`decide_plan_revision`). The kernel decides every part of it again (`application/goal/
 * decide.ts`); this only keeps the console from offering a decision its reader would be refused.
 */

/** The planner's proposal the requester may decide now: proposed by the planner, still
 *  `proposed`, based on the revision in force. At most one (a new round opens only once none
 *  waits); `null` when there is none. */
export function pendingPlannerProposal(goal: GoalDetailWire): PlanRevisionSummaryWire | null {
  return (
    goal.revisions.find(
      (revision) =>
        revision.proposer === 'planner' &&
        revision.status === 'proposed' &&
        revision.basedOnRevision === goal.currentRevision,
    ) ?? null
  );
}

/** The round running now, if any (at most one per run). */
export function runningPlanningRound(goal: GoalDetailWire): PlanningRoundWire | null {
  return goal.planningRounds.find((round) => round.status === 'running') ?? null;
}

/** Whether the reader decides the planner's proposal: only the requester, only while the run is
 *  paused (the kernel's rule — the planner acts for them, so nobody else puts its plan in force). */
export function mayDecidePlannerProposal(goal: GoalDetailWire, viewer: GoalViewer): boolean {
  return (
    viewer.principalId !== null &&
    viewer.principalId === goal.onBehalfOf &&
    goal.status === 'paused'
  );
}

const OUTCOME: Readonly<Record<PlanningRoundOutcomeReason, readonly [string, string]>> = {
  revision_budget_exhausted: [
    '这个目标的修订次数已经用完，规划器不再提修订。',
    'The goal has used every revision its budget allows, so the planner proposes none.',
  ],
  token_budget_exhausted: [
    '目标剩下的 token 不够规划器跑一轮。',
    'What is left of the goal’s tokens is too little for a planner round.',
  ],
  planner_unavailable: [
    '工作区现在没有可用的目标规划器（所有者停用了它的 Worker 定义）。',
    'The workspace has no goal planner to run now (a workspace owner deprecated its Worker definition).',
  ],
  requester_cannot_start: [
    '请求人现在不能启动 Worker（账号停用、角色不允许、评测封存或当日额度用完），规划器没能开始。',
    'The requester cannot start a Worker now (disabled, a role that does not, the evaluation seal or a daily quota), so the planner could not start.',
  ],
  task_failed: [
    '规划器的任务没有交回可用的结果。',
    'The planner’s task ended without a usable result.',
  ],
  invalid_revision: [
    '规划器提的修订没通过平台的复查，没有留下。',
    'What the planner proposed did not pass the platform’s checks, so it was not kept.',
  ],
  run_left_pause: [
    '目标已经不在这次暂停里（继续、取消或被所有者锁定），这一轮作废。',
    'The goal left the pause this round was for (resumed, cancelled or held by an owner), so the round was dropped.',
  ],
  run_not_running: [
    '目标已经不在运行（被暂停、锁定或取消），这一轮作废。',
    'The goal stopped running (paused, held or cancelled), so the round was dropped.',
  ],
  step_keeps_failing: [
    '平台已经替你改过这一步两次，它还是失败；这次不再自动换路，等你决定。',
    'The platform already changed this step twice for you and it still fails, so it does not try another way on its own this time: it waits for your decision.',
  ],
  plan_revised: [
    '计划已经换成另一个版本，这一轮作废。',
    'Another revision was put in force, so the round was dropped.',
  ],
};

/** Why a round ended the way it did, in a sentence — `null` for a round that has no reason (one
 *  running, one that proposed, one that found nothing to change). */
export function planningOutcomeText(round: PlanningRoundWire, t: Translate): string | null {
  if (round.outcomeReason === null) return null;
  const entry = OUTCOME[round.outcomeReason];
  return t(entry[0], entry[1]);
}

const MAJOR_REASON: Readonly<Record<PlannerRevisionMajorReason, readonly [string, string]>> = {
  goal_acceptance_changed: ['改了目标的验收', 'It changes what the goal is accepted on'],
  step_acceptance_changed: ['去掉或放宽了一步的验收', 'It drops or loosens a check of a step'],
  execution_step: [
    '新增或改动的步骤能执行动作或启动别的 Worker',
    'A step it adds or changes can act or start Workers of its own',
  ],
  admission_blocked: [
    '新增或改动的步骤要有人批准才能开始',
    'A step it adds or changes would need a person before it starts',
  ],
  stops_live_work: ['会停下还在运行的工作', 'It would stop work that is still running'],
  unresolvable: [
    '平台判断不了新增或改动的步骤能做什么',
    'The platform could not work out what a step it adds or changes could do',
  ],
};

/** S11 GO9b: why the platform left a planner revision for the requester to decide, one line per
 *  reason, naming the step a reason is about. */
export function majorReasonTexts(
  reasons: readonly PlannerRevisionClassReasonWire[],
  t: Translate,
): readonly string[] {
  return reasons.map((reason) => {
    const entry = MAJOR_REASON[reason.code];
    const text = t(entry[0], entry[1]);
    return reason.stepKey === null
      ? text
      : t(`${text}（步骤 ${reason.stepKey}）`, `${text} (step ${reason.stepKey})`);
  });
}

/** S11 GO9b: the round that proposed `revision`, if a planning round did. */
export function roundOfRevision(goal: GoalDetailWire, revision: number): PlanningRoundWire | null {
  return goal.planningRounds.find((round) => round.revision === revision) ?? null;
}
