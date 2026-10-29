import type { GoalPlan, OperationSummaryWire } from '@nexttime/shared';
import type { CapabilityCaller } from '../../lib/clients.js';
import { absenceOperationKey, observationSentence, planAbsenceChecks } from '../../lib/goals.js';
import { absentAnswersWhenText } from '../../lib/governance.js';
import { useT } from '../../lib/i18n.js';
import { AbsentAnswersReviewedLine } from '../catalog/AbsentAnswersReview.js';
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
          '确认前核对每条检查的参数：要正好指向这个目标要删掉的那个东西。参数写错、指向一个本来就没有的东西，门同样回答“不存在”，检查第一次就会通过。',
          'Before confirming, check each one’s params: they must name exactly the thing this goal removes. Params that name something that was never there get the same “not there”, and the check passes on its first try.',
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
