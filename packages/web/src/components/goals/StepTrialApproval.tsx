import type { ApproveStepTrialResultWire, GoalDetailWire } from '@nexttime/shared';
import { useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { reviewFieldNames, usePublishCredentialReview } from '../../lib/credential-review.js';
import type { GoalViewer } from '../../lib/goal-actions.js';
import {
  type StepTrial,
  mayApproveTrial,
  trialApproverText,
  trialDraftLabel,
} from '../../lib/goal-trials.js';
import { HttpError } from '../../lib/http-client.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { CredentialReview } from '../kit/credential-review.js';
import { RouteLink } from '../kit/route-link.js';
import {
  type GoalOperationOutcome,
  goalOperationErrors,
  useOperationDone,
} from './GoalOperationsBar.js';

export interface StepTrialApprovalProps {
  readonly goal: Pick<GoalDetailWire, 'id' | 'status' | 'updatedAt'>;
  readonly stepKey: string;
  /** What one trial of the step mounts — its `step_skill_draft` hint's `trial`. */
  readonly trial: StepTrial;
  readonly viewer: GoalViewer;
  readonly http: CapabilityCaller;
  readonly onDone: (outcome: GoalOperationOutcome) => void;
}

/**
 * components/goals/StepTrialApproval (S11 GO8b): under a step whose Worker would use Skills that
 * are only drafts, the 「批准试用」 button and its confirm — each draft by name and version (a link
 * to it in Catalog), and what the approval does and does not do: it lets this step's next run use
 * these exact drafts once, lapses if a draft changes, and does not resume a paused goal (its
 * requester does). A draft carrying suspected credentials asks the approver to confirm them, as a
 * publish would (`kit/credential-review`). Shown to the workspace owner, or to the person who
 * proposed every draft (`mayApproveTrial`); to anyone else, who may approve instead.
 */
export function StepTrialApproval({
  goal,
  stepKey,
  trial,
  viewer,
  http,
  onDone,
}: StepTrialApprovalProps) {
  const t = useT();
  const can = useRoleCan(http);
  const [open, setOpen] = useState(false);
  const run = useOperationDone(onDone, goal);
  const credentialReview = usePublishCredentialReview(
    `${goal.id}:${stepKey}:${trial.specDigest}:${trial.drafts.map((draft) => draft.draftDigest).join(',')}`,
  );
  if (can('approve_step_trial') === false || !mayApproveTrial(trial, viewer)) {
    return (
      <span className="text-small text-3" data-testid="goal-step-trial-approver">
        {trialApproverText(trial, t)}
      </span>
    );
  }
  const one = trial.drafts.length === 1;
  const anchor = (
    <Button
      variant="secondary"
      size="s"
      onClick={() => setOpen(true)}
      data-testid="goal-step-trial-approve"
    >
      {t('批准试用', 'Approve trial')}
    </Button>
  );
  async function approve(): Promise<void> {
    try {
      await run(
        http.call<ApproveStepTrialResultWire>('approve_step_trial', {
          goalRunId: goal.id,
          stepKey,
          specDigest: trial.specDigest,
          drafts: trial.drafts.map((draft) => ({
            skillId: draft.skillId,
            version: draft.version,
            draftDigest: draft.draftDigest,
          })),
          ...credentialReview.params(),
        }),
        () =>
          goal.status === 'paused'
            ? t(
                `已批准步骤「${stepKey}」试用 Skill 草稿。目标不会自己继续：请求人按「继续」后这一步开始。`,
                `Trial approved for step “${stepKey}”. The goal does not go on by itself: once its requester resumes it, the step starts.`,
              )
            : t(
                `已批准步骤「${stepKey}」试用 Skill 草稿：确认目标后，这一步用批准的草稿开始。`,
                `Trial approved for step “${stepKey}”: once the goal is confirmed, the step starts with the drafts approved.`,
              ),
      );
    } catch (err) {
      // The kernel's credential question — answered in this confirm, which stays open.
      credentialReview.capture(err);
      if (err instanceof HttpError && err.code === 'draft_changed') {
        onDone({
          kind: 'done',
          message: t(
            `步骤「${stepKey}」的草稿或设定在你打开之后改过了，什么也没批准。页面已刷新，请在「步骤」里重新查看。`,
            `Step “${stepKey}”’s drafts or settings changed since you opened it, so nothing was approved. The page has been refreshed; look again under Steps.`,
          ),
        });
      }
      throw err;
    }
  }
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={anchor}
      title={t(
        `批准步骤「${stepKey}」试用 Skill 草稿`,
        `Approve step “${stepKey}” trying draft Skills`,
      )}
      description={t(
        `这一步的 Worker 会用下面${one ? '这份还没发布的草稿' : '这些还没发布的草稿'}运行一次（失败重试沿用同一份）。`,
        `This step’s Worker runs once with the ${one ? 'draft below, which is not published' : 'drafts below, which are not published'} (its retries use the same ${one ? 'draft' : 'drafts'}).`,
      )}
      impact={[
        t(
          '只对这一步的这一次运行有效；修订计划替换了这一步，或者草稿改动、丢弃、发布之后，批准失效',
          'Holds for this step’s one run only; it lapses if a revision replaces the step, or a draft is changed, discarded or published',
        ),
        goal.status === 'paused'
          ? t(
              '批准不会让目标继续：之后请求人按「继续」，这一步才开始',
              'Approving does not resume the goal: the step starts once its requester resumes it',
            )
          : t(
              '批准不会确认目标：请求人确认之后，这一步用批准的草稿开始',
              'Approving does not confirm the goal: once its requester confirms it, the step starts with these drafts',
            ),
        t('批准记入审计', 'The approval is recorded in the audit log'),
      ]}
      confirmLabel={t('批准试用', 'Approve trial')}
      confirmDisabled={credentialReview.blocked}
      errorOverrides={{
        ...goalOperationErrors(t),
        credentials_review_required: t(
          '草稿内容里有疑似凭据：核对下面列出的位置，勾选确认后再批准。',
          'A draft’s content looks like it carries credentials: check the places listed below, tick the confirmation and approve again.',
        ),
        draft_changed: t(
          '草稿或这一步的设定已经变了，什么也没批准。关掉这个框，在刷新后的「步骤」里重新查看。',
          'The drafts or the step’s settings changed, so nothing was approved. Close this and look again under Steps, now refreshed.',
        ),
        not_proposer: t(
          '只有每份草稿的提议者或工作区所有者能批准试用，什么也没批准。',
          'Only the proposer of every draft, or a workspace owner, can approve the trial; nothing was approved.',
        ),
      }}
      onConfirm={approve}
      testId="goal-step-trial-confirm"
    >
      <ul className="stack-s m-0 p-0 list-none" data-testid="goal-step-trial-drafts">
        {trial.drafts.map((draft) => (
          <li key={draft.skillId} className="row-wrap text-small">
            <span className="chip chip-warn chip-s">{t('草稿', 'Draft')}</span>
            <RouteLink
              href={hrefs.catalog('skills', draft.skillId)}
              className="link-inline"
              testId="goal-step-trial-draft"
            >
              {trialDraftLabel(draft)}
            </RouteLink>
          </li>
        ))}
      </ul>
      <CredentialReview
        count={credentialReview.count}
        paths={credentialReview.paths}
        fieldNames={reviewFieldNames('skill', t)}
        subject="trial"
        where={t(
          '点上面的草稿名，在「能力目录」里查看它的内容。',
          'Open a draft above to see its content in Catalog.',
        )}
        checked={credentialReview.checked}
        onChange={credentialReview.setChecked}
      />
    </Confirm>
  );
}
