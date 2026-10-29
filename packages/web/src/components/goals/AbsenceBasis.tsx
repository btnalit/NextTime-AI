import type {
  GoalAbsenceBaselineWire,
  GoalPlan,
  GoalRunStatus,
  OperationSummaryWire,
} from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import {
  absenceOperationKey,
  checkErrorLabel,
  observationSentence,
  planAbsenceChecks,
} from '../../lib/goals.js';
import { absentAnswersWhenText } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { AbsentAnswersReviewedLine } from '../catalog/AbsentAnswersReview.js';
import { CopyButton } from '../kit/copy-button.js';
import {
  ABSENCE_OPERATION_UNREADABLE,
  type AbsenceOperation,
  type AbsenceOperations,
} from './useAbsenceOperations.js';

/**
 * components/goals/AbsenceBasis (S11 「门确认不存在」 B): beside an absence check, what its "not
 * there" rests on, as the Operation's version in force says now (`useAbsenceOperations`) — which
 * of the target's answers it declares mean that, and who confirmed, publishing it, that the gate's
 * credentials can see what it looks up (the catalog's `AbsentAnswersReviewedLine`). Without either
 * the platform does not make the check (`absence_not_declared` / `absence_not_reviewed`), and the
 * line says so before anyone confirms the goal or waits on it. `undefined`: still being read; a
 * read that failed says only that, since it tells nothing about the check.
 */
export function AbsenceBasis({
  http,
  operation,
}: {
  readonly http: CapabilityCaller;
  readonly operation: AbsenceOperation | undefined;
}) {
  const t = useT();
  if (operation === undefined) return null;
  if (operation === ABSENCE_OPERATION_UNREADABLE) {
    return (
      <span
        className="w-full text-small text-warn"
        data-testid="goal-absence-basis"
        data-basis="unreadable"
      >
        {t(
          '这个 Operation 没读出来，看不到这条检查依据什么。刷新页面再试。',
          'The Operation could not be read, so what this check rests on is not shown. Reload the page to try again.',
        )}
      </span>
    );
  }
  if (operation === null || operation.absentAnswers === undefined) {
    return (
      <span
        className="w-full text-small text-warn"
        data-testid="goal-absence-basis"
        data-basis="none"
      >
        {operation === null
          ? t(
              '这个 Operation 现在没有已发布版本，平台做不了这条检查。',
              'The Operation has no published version now; the platform cannot make this check.',
            )
          : t(
              '这个 Operation 现在的版本没有声明哪些回答表示不存在，平台做不了这条检查。',
              'The Operation’s version in force declares no answer that means “not there”; the platform cannot make this check.',
            )}
      </span>
    );
  }
  const confirmed = operation.absentAnswersReview !== undefined;
  return (
    <span
      className="w-full stack-s text-small"
      data-testid="goal-absence-basis"
      data-basis={confirmed ? 'confirmed' : 'unconfirmed'}
    >
      <span className="text-3">
        {t(
          `${absentAnswersWhenText(operation.absentAnswers, t)}，门回答“不存在”。`,
          `The gate answers “not there” ${absentAnswersWhenText(operation.absentAnswers, t)}.`,
        )}
      </span>
      <AbsentAnswersReviewedLine http={http} row={operation} />
      {confirmed ? null : (
        <span className="text-warn">
          {t('所以平台不做这条检查。', 'So the platform does not make this check.')}
        </span>
      )}
    </span>
  );
}

/**
 * components/goals/AbsenceBaselineLine (S11 「门确认不存在」 B-c): beside an absence check of the
 * plan in force, the platform's look with the same call before the work it judges — the check can
 * pass only after a look that saw the thing there, so params that name something never there pause
 * the run instead of passing with nothing removed. `baseline` is get_goal's latest look of the check
 * whose call the plan in force makes (`absenceBaselines`); none yet: what will happen, while the run
 * has not ended. A look that did not see the thing says what the requester can do. `firstAttemptAt`
 * (`goalFirstAttemptAt`): a look made after the run's first attempt came once the work had begun —
 * a revision added or re-called the check (#786 review #501) — so it says when it was made, and
 * that a thing not there may be an earlier step's doing.
 */
export function AbsenceBaselineLine({
  baseline,
  goalStatus,
  firstAttemptAt,
}: {
  readonly baseline: GoalAbsenceBaselineWire | undefined;
  readonly goalStatus: GoalRunStatus;
  readonly firstAttemptAt: string | null;
}) {
  const t = useT();
  const take =
    baseline !== undefined && baseline.take > 1
      ? t(`（第 ${baseline.take} 次看）`, ` (look ${baseline.take})`)
      : '';
  if (baseline === undefined) {
    if (goalStatus !== 'proposed' && goalStatus !== 'running' && goalStatus !== 'paused') {
      return null;
    }
    return (
      <span
        className="w-full text-small text-3"
        data-testid="goal-absence-baseline"
        data-baseline="none"
      >
        {goalStatus === 'proposed'
          ? t(
              '确认后、第一步开始前，平台会用同样的参数先看一次：看到它在，这条检查以后才可能通过。',
              'Once confirmed, before the first step starts, the platform makes the same call first: only if it sees the thing there can this check pass later.',
            )
          : firstAttemptAt === null
            ? t(
                '第一步开始前平台会先看一次它在不在，还没看。',
                'Before the first step starts the platform looks once whether it is there; it has not looked yet.',
              )
            : t(
                '目标往下做之前，平台会先看一次它在不在，还没看。',
                'Before the goal goes on, the platform looks once whether it is there; it has not looked yet.',
              )}
      </span>
    );
  }
  const afterWork =
    firstAttemptAt !== null && Date.parse(firstAttemptAt) < Date.parse(baseline.createdAt);
  switch (baseline.status) {
    case 'pending':
      return (
        <span
          className="w-full text-small text-3"
          data-testid="goal-absence-baseline"
          data-baseline="pending"
        >
          {afterWork
            ? t(
                `平台正在先看它在不在${take}：看到它在之后，目标才往下做。`,
                `The platform is looking whether it is there first${take}; the goal goes on once it has seen it.`,
              )
            : t(
                `平台正在先看它在不在${take}：看到它在之后，步骤才开始。`,
                `The platform is looking whether it is there first${take}; the steps start once it has seen it.`,
              )}
          {baseline.lastError
            ? t(
                ` 上次没看成：${checkErrorLabel(baseline.lastError, t)}，稍后再试。`,
                ` The last try did not get an answer: ${checkErrorLabel(baseline.lastError, t)}; it tries again shortly.`,
              )
            : null}
        </span>
      );
    case 'seen_present':
      return (
        <span
          className="w-full row-wrap text-small text-3"
          data-testid="goal-absence-baseline"
          data-baseline="seen_present"
        >
          <span>
            {afterWork
              ? t(
                  `目标的步骤开始之后（计划改了这条检查）平台看到它在${take}，所以它后来不在了，说明是在这之后被删掉的。`,
                  `After the goal’s steps had started (the plan changed this check) the platform saw it there${take}, so its absence later shows it was removed since.`,
                )
              : t(
                  `开始前平台看到它在${take}，所以它后来不在了，说明是在目标运行期间被删掉的。`,
                  `Before the work the platform saw it there${take}, so its absence later shows it was removed while the goal ran.`,
                )}
          </span>
          {baseline.settledAt ? (
            <time title={formatDateTime(baseline.settledAt)}>
              {formatRelative(baseline.settledAt)}
            </time>
          ) : null}
          {baseline.observationId ? (
            <span className="row-wrap">
              {t('观察', 'Observation')}
              <span className="mono">{shortId(baseline.observationId)}</span>
              <CopyButton
                value={baseline.observationId}
                label={t('复制观察 ID', 'Copy observation id')}
              />
            </span>
          ) : null}
        </span>
      );
    case 'never_seen_present':
      return (
        <span
          className="w-full text-small text-warn"
          data-testid="goal-absence-baseline"
          data-baseline="never_seen_present"
        >
          {afterWork
            ? t(
                `平台在目标的步骤开始之后才看（计划改了这条检查），门回答它已经不在${take}：可能是前面的步骤删掉了它，也可能参数没指向要删的东西。这条检查证明不了是这个目标删掉的，所以目标暂停，没有往下做。核对参数后修订计划（比如去掉或改写这条检查）、继续运行再看一次，或者取消。`,
                `The platform looked only after the goal’s steps had started (the plan changed this check), and the gate answered that it is not there${take}: an earlier step may have removed it, or the params name something else. This check could not show this goal removed it, so the goal paused and did not go on. Check the params, then revise the plan (dropping or rewriting this check, say), resume to look again, or cancel.`,
              )
            : t(
                `开始前门就回答它不在${take}：这条检查证明不了是这个目标删掉的，所以目标暂停，步骤没有开始。核对参数是不是正好指向要删的东西，然后修订计划、继续运行再看一次，或者取消。`,
                `Before the work the gate already answered that it is not there${take}: this check could not show this goal removed it, so the goal paused before any step. Check that the params name exactly what the goal removes, then revise the plan, resume to look again, or cancel.`,
              )}
        </span>
      );
    case 'unavailable': {
      const reason = baseline.lastError
        ? checkErrorLabel(baseline.lastError, t)
        : t('没有记下原因', 'no reason recorded');
      return (
        <span
          className="w-full text-small text-warn"
          data-testid="goal-absence-baseline"
          data-baseline="unavailable"
        >
          {afterWork
            ? t(
                `平台没能看它在不在${take}（${reason}），所以目标暂停，没有往下做。继续运行会再看一次。`,
                `The platform could not look whether it is there${take} (${reason}), so the goal paused and did not go on. Resuming looks again.`,
              )
            : t(
                `开始前平台没能看它在不在${take}（${reason}），所以目标暂停，步骤没有开始。继续运行会再看一次。`,
                `Before the work the platform could not look whether it is there${take} (${reason}), so the goal paused before any step. Resuming looks again.`,
              )}
        </span>
      );
    }
    case 'superseded':
      return (
        <span
          className="w-full text-small text-3"
          data-testid="goal-absence-baseline"
          data-baseline="superseded"
        >
          {t(
            '目标停下时平台还没看完它在不在；继续运行后会再看。',
            'The goal stopped before the platform finished looking whether it is there; it looks again once resumed.',
          )}
        </span>
      );
  }
}
/** The goal's confirm card (S11 「门确认不存在」 B): each absence check of the plan — the goal's
 *  and its steps' — in a sentence, with what its "not there" rests on, so the requester sees what
 *  the goal will be judged by before it starts. Nothing when the plan has none. */
export function AbsenceChecksBasis({
  http,
  plan,
  gateNames,
  absenceOperations,
}: {
  readonly http: CapabilityCaller;
  readonly plan: GoalPlan;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly absenceOperations: AbsenceOperations;
}) {
  const t = useT();
  const checks = planAbsenceChecks(plan);
  if (checks.length === 0) return null;
  return (
    <div className="stack-s text-13 text-text" data-testid="goal-confirm-absence">
      <span>
        {t(
          '下面的检查只在门回答“要查的东西不存在”时才算通过：',
          'These checks pass only when the gate answers that the thing looked up does not exist:',
        )}
      </span>
      <span className="text-warn" data-testid="goal-confirm-absence-params">
        {t(
          '确认前核对每条检查的参数：要正好指向这个目标要删掉的那个东西。第一步开始前，平台会用同样的参数先看一次；门说它本来就不在时，目标会暂停等你处理，不会让检查在什么都没删的情况下通过。',
          'Before confirming, check each one’s params: they must name exactly the thing this goal removes. Before the first step starts the platform makes the same call; if the gate says it is not there already, the goal pauses for you rather than letting the check pass with nothing removed.',
        )}
      </span>
      <ul className="stack-s">
        {checks.map((ref) => (
          <li
            key={`${ref.stepKey ?? ''}/${ref.key}`}
            className="stack-s"
            data-testid="goal-confirm-absence-check"
          >
            <span>
              {ref.stepKey === null
                ? t(`验收检查 ${ref.key}：`, `Acceptance check ${ref.key}: `)
                : t(
                    `步骤 ${ref.stepKey} 的检查 ${ref.key}：`,
                    `Step ${ref.stepKey}’s check ${ref.key}: `,
                  )}
              {observationSentence(ref.check, gateNames.get(ref.check.gatekeeperId) ?? null, t)}
            </span>
            <AbsenceBasis
              http={http}
              operation={absenceOperations.get(absenceOperationKey(ref.check))}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
