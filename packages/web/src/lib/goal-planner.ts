import type {
  GoalDetailWire,
  PlanRevisionSummaryWire,
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

/** UX P2-1 on #864: what a person's own resume, revision or cancel does to the planner's work —
 *  a proposal waiting is rejected (the planner proposes nothing more for that failure), a round
 *  running is dropped and its planning Task stopped. Empty when nothing of the planner's is in
 *  flight. */
export function plannerWorkDropped(goal: GoalDetailWire, t: Translate): string[] {
  const lines: string[] = [];
  const proposal = pendingPlannerProposal(goal);
  if (proposal) {
    lines.push(
      t(
        `规划器提的第 ${proposal.revision} 版修订会被拒绝，规划器不会再为这次失败提修订`,
        `The planner’s proposed v${proposal.revision} is rejected, and the planner proposes nothing more for this failure`,
      ),
    );
  }
  if (runningPlanningRound(goal)) {
    lines.push(
      t(
        '正在进行的这一轮规划会作废，它的规划任务会停下',
        'The planning round under way is dropped, and its planning task stopped',
      ),
    );
  }
  return lines;
}

/** UX P2-2 on #864: the planner's last word on the pause the run is in, when it proposed nothing —
 *  the latest round, ended without a proposal, on the revision in force, while the run is paused.
 *  `null` otherwise (a round running or a proposal waiting say so themselves). */
export function currentPlanningConclusion(goal: GoalDetailWire): PlanningRoundWire | null {
  if (goal.status !== 'paused') return null;
  const latest = goal.planningRounds.at(-1);
  if (!latest) return null;
  if (latest.status !== 'no_revision' && latest.status !== 'failed') return null;
  if (latest.basedOnRevision !== goal.currentRevision) return null;
  // The pause it answered: its step still failed on the attempt it planned for (a retry since, or a
  // later failure the planner did not get to, is another pause).
  const step = goal.steps.find((candidate) => candidate.id === latest.stepRunId);
  return step && step.status === 'failed' && step.attemptCount === latest.stepAttempt
    ? latest
    : null;
}

/** Whether the planner's card holds something to act on or read first — a round running, a
 *  proposal waiting, or a conclusion about this pause: the page shows it above the overview then,
 *  and below it otherwise (UX P3-7 on #864). */
export function plannerNeedsAttention(goal: GoalDetailWire): boolean {
  return (
    runningPlanningRound(goal) !== null ||
    pendingPlannerProposal(goal) !== null ||
    currentPlanningConclusion(goal) !== null
  );
}

/** UX P3-3 on #864: whether a settled round's `detail` is worth showing — the platform's own note
 *  on a planning Task that failed only repeats its outcome, in the kernel's words. */
export function showsRoundDetail(round: PlanningRoundWire): boolean {
  return (
    round.detail !== null && !(round.status === 'failed' && round.outcomeReason === 'task_failed')
  );
}
