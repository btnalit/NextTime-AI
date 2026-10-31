import type {
  GoalDetailWire,
  PlanHint,
  StepRunWire,
  StepTrialApprovalLapse,
  StepTrialApprovalWire,
} from '@nexttime/shared';
import type { GoalViewer } from './goal-actions.js';
import type { Translate } from './i18n.js';

/**
 * lib/goal-trials (S11 GO8b): a step whose WorkerSpec names Skills that are only drafts, and a
 * person's approval of one trial of it (`approve_step_trial`) — who may approve, where an approval
 * stands, and how the page says it. The kernel decides all of it again (`application/goal/
 * trial-approvals.ts`); this only keeps the console from offering a button its reader would be
 * refused.
 */

/** What one trial of a step mounts, as its `step_skill_draft` hint carries it. */
export type StepTrial = NonNullable<PlanHint['trial']>;

/** The trial a step's `step_skill_draft` hint offers to approve — none when the hint has none (a
 *  reference naming more than one draft, two drafts of one name, a draft named like a published
 *  Skill). */
export function hintTrial(hint: PlanHint): StepTrial | null {
  return hint.code === 'step_skill_draft' ? (hint.trial ?? null) : null;
}

/**
 * Whether the reader could approve `trial` now, as the kernel would decide (`publish_skill`'s rule
 * for every draft): the workspace owner, or the person who proposed every one of the drafts. The
 * role (`approve_step_trial`: builder and up) is the caller's own `useRoleCan` check.
 */
export function mayApproveTrial(trial: StepTrial, viewer: GoalViewer): boolean {
  if (viewer.principalId === null) return false;
  if (viewer.isOwner) return true;
  return trial.drafts.every((draft) => draft.proposedBy === viewer.principalId);
}

/** Who besides a workspace owner may approve `trial` — the one person who proposed every draft
 *  (`publish_skill`'s rule for each), or `null` when different people proposed them. */
export function trialProposer(trial: StepTrial): string | null {
  const proposers = new Set(trial.drafts.map((draft) => draft.proposedBy));
  const [only] = proposers;
  return proposers.size === 1 && only !== undefined ? only : null;
}

/** A draft as the approval names it: 「名称 v1」. */
export function trialDraftLabel(draft: StepTrial['drafts'][number]): string {
  return `${draft.name} v${draft.version}`;
}

type TrialApprovalsOf = Pick<GoalDetailWire, 'trialApprovals'>;
type TrialStepRun = Pick<StepRunWire, 'id' | 'supersededInRevision'>;

/** The approvals the page shows under a step: those of its StepRun (`run`), and — for the step of
 *  the plan in force — those made on the proposal that name no StepRun yet. */
export function stepTrialApprovals(
  detail: TrialApprovalsOf,
  stepKey: string,
  run: TrialStepRun | null,
): readonly StepTrialApprovalWire[] {
  return detail.trialApprovals.filter((approval) =>
    approval.stepRunId !== null
      ? approval.stepRunId === run?.id
      : approval.stepKey === stepKey && (run === null || run.supersededInRevision === null),
  );
}

const LAPSE: Readonly<Record<StepTrialApprovalLapse, readonly [string, string]>> = {
  draft_changed: [
    '草稿改过了（被丢弃、重新提议或已发布），批准不再适用，要用就得重新批准。',
    'a draft changed since (discarded, proposed again, or published), so it no longer applies; approve again to use it.',
  ],
  step_changed: [
    '这一步被修订替换了，或者在没有用它的情况下开始了，批准不再适用。',
    'the step was replaced by a revision, or started without it, so it no longer applies.',
  ],
  run_ended: ['目标已经结束，批准没有用上。', 'the goal ended before it was used.'],
};

/** Where an approval stands, as one line (the approver and the time are shown beside it). */
export function trialApprovalText(approval: StepTrialApprovalWire, t: Translate): string {
  const drafts = approval.drafts.map(trialDraftLabel);
  const [zh, en] = [drafts.map((name) => `「${name}」`).join('、'), drafts.join(', ')];
  const skillsEn = drafts.length === 1 ? 'draft Skill' : 'draft Skills';
  switch (approval.state) {
    case 'pending':
      return t(
        `已批准试用 Skill 草稿${zh}：只对这一步的下一次运行有效，草稿改动后失效。`,
        `Trial of ${skillsEn} ${en} approved: it holds for this step’s next run only, and lapses if a draft changes.`,
      );
    case 'used':
      return t(
        `已批准试用 Skill 草稿${zh}，这一步的第一次尝试用上了它（重试沿用同一份草稿）。`,
        `Trial of ${skillsEn} ${en} approved and used by this step’s first attempt (its retries mount the same ${drafts.length === 1 ? 'draft' : 'drafts'}).`,
      );
    case 'lapsed': {
      const [whyZh, whyEn] = LAPSE[approval.lapsedBecause ?? 'step_changed'];
      return t(
        `曾批准试用 Skill 草稿${zh}，但${whyZh}`,
        `Trial of ${skillsEn} ${en} was approved, but ${whyEn}`,
      );
    }
  }
}

/** The steps of a paused run whose trial is approved and waits to be used — the pause note says
 *  the requester resumes (approving never resumes a run). */
export function pendingTrialStepKeys(
  detail: Partial<Pick<GoalDetailWire, 'trialApprovals'>>,
): readonly string[] {
  return [
    ...new Set(
      (detail.trialApprovals ?? [])
        .filter((approval) => approval.state === 'pending')
        .map((approval) => approval.stepKey),
    ),
  ];
}
