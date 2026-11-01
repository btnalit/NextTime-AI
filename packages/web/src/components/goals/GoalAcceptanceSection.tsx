import type {
  GoalAcceptanceCheckWire,
  GoalAcceptanceRoundWire,
  GoalDetailWire,
} from '@nexttime/shared';
import { auditHref } from '../../lib/audit.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import {
  absenceBaselineOf,
  absenceOperationKey,
  checkErrorLabel,
  checkKindLabel,
  confirmCheckOrigin,
  goalFirstAttemptAt,
  goalPlanSource,
  isStepAuthorityHint,
  isStepContractHint,
  planCheckSentence,
  planHintKey,
  planHintText,
  roundCheckSentence,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { CopyButton } from '../kit/copy-button.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { DashboardCard } from '../kit/section.js';
import { StatusChip } from '../kit/status-chip.js';
import { AbsenceBaselineLine, AbsenceBasis } from './AbsenceBasis.js';
import type { AbsenceOperations } from './useAbsenceOperations.js';

export interface GoalAcceptanceSectionProps {
  readonly detail: GoalDetailWire;
  readonly gateNames: ReadonlyMap<string, string>;
  /** Legacy 470: the Objects the checks name by id, 「名字 · 类型」 (`useObjectLabels`). */
  readonly objectNames?: ReadonlyMap<string, string>;
  /** S11 「门确认不存在」 B: what each absence check rests on (`useAbsenceOperations`); with
   *  `http`, said under the check. */
  readonly absenceOperations?: AbsenceOperations;
  readonly http?: CapabilityCaller;
}

/**
 * components/goals/GoalAcceptanceSection (S11 GO6): how the goal is verified (plan §4.6) — the
 * plan's acceptance checks read as sentences, what the person confirming was told about them
 * (hints), every verification round with each check's status and evidence (a Fact or a Decision
 * opens its provenance; an Observation shows its id), and — when the requester declared the goal
 * achieved over checks that had not passed — those checks. Under an absence check of the plan, what
 * its "not there" rests on (`AbsenceBasis`) and the platform's look before the goal's work
 * (`AbsenceBaselineLine`, S11 「门确认不存在」 B-c).
 */
export function GoalAcceptanceSection({
  detail,
  gateNames,
  objectNames,
  absenceOperations,
  http,
}: GoalAcceptanceSectionProps) {
  const t = useT();
  const planChecks = detail.planRevision.plan.acceptance ?? [];
  const rounds = [...detail.acceptance.rounds].reverse();
  const [latest, ...older] = rounds;
  const overridden = detail.acceptance.overriddenChecks;
  // Legacy 454: the requester's confirmation made from a Procedure's verify steps says which.
  const source = goalPlanSource(detail.revisions);
  const origin = (key: string) => confirmCheckOrigin(source, key, t);
  return (
    <DashboardCard title={t('验收', 'Acceptance')} data-testid="goal-acceptance">
      <div className="stack">
        {/* What the plan's checks leave to the requester's word; hints about a step's authority
            (S11 GO5c) are the steps card's. */}
        {detail.planRevision.hints
          .filter((hint) => !isStepAuthorityHint(hint) && !isStepContractHint(hint))
          .map((hint) => (
            <Notice key={planHintKey(hint)} tone="warn" testId="goal-plan-hint">
              {planHintText(hint, t, gateNames)}
            </Notice>
          ))}
        {overridden.length > 0 ? (
          <Notice tone="warn" testId="goal-overridden-checks">
            <div className="stack-s">
              <span>
                {t(
                  '请求人在下面这些检查没有通过时宣布了达成：',
                  'The requester declared the goal achieved while these checks had not passed:',
                )}
              </span>
              <ul>
                {overridden.map((check) => (
                  <li key={`${check.checkKey}-${check.round ?? 'none'}`} className="row-wrap">
                    <span className="mono">{check.checkKey}</span>
                    <span className="text-3">{checkKindLabel(check.kind, t)}</span>
                    <span>{overriddenStatusText(check.status, t)}</span>
                    {check.lastError ? (
                      <span className="text-3">{checkErrorLabel(check.lastError, t)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </Notice>
        ) : null}

        <div className="stack-s">
          <span className="section-title">{t('计划里的检查', 'Checks in the plan')}</span>
          {planChecks.length === 0 ? (
            <span className="text-small text-3" data-testid="goal-acceptance-implicit">
              {t(
                '计划没有写验收检查：所有步骤完成后，由请求人确认目标是否达成。',
                'The plan names no check: once every step is done, the requester says whether the goal was achieved.',
              )}
            </span>
          ) : (
            <ul className="stack-s">
              {planChecks.map((check) => (
                <li key={check.key} className="row-wrap" data-testid="goal-plan-check">
                  <span className="mono">{check.key}</span>
                  <span className="text-3 text-small">{checkKindLabel(check.kind, t)}</span>
                  <span>{planCheckSentence(check, gateNames, t, objectNames)}</span>
                  <CheckOrigin text={origin(check.key)} />
                  {check.kind === 'observe_absent' && http ? (
                    <AbsenceBasis
                      http={http}
                      operation={absenceOperations?.get(absenceOperationKey(check.check))}
                    />
                  ) : null}
                  {check.kind === 'observe_absent' ? (
                    <AbsenceBaselineLine
                      baseline={absenceBaselineOf(detail, null, check.key)}
                      goalStatus={detail.status}
                      firstAttemptAt={goalFirstAttemptAt(detail)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {latest ? (
          <Round
            round={latest}
            gateNames={gateNames}
            objectNames={objectNames}
            origin={origin}
            t={t}
          />
        ) : (
          <span className="text-small text-3" data-testid="goal-acceptance-not-started">
            {t(
              '还没开始验收：所有步骤完成后，平台才做这些检查。',
              'Verification has not started: the platform makes these checks once every step is done.',
            )}
          </span>
        )}
        {older.length > 0 ? (
          <details className="disclosure">
            <summary>
              {t(`更早的验收轮次（${older.length}）`, `Earlier rounds (${older.length})`)}
            </summary>
            <div className="disclosure-body stack">
              {older.map((round) => (
                <Round
                  key={round.round}
                  round={round}
                  gateNames={gateNames}
                  objectNames={objectNames}
                  origin={origin}
                  t={t}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </DashboardCard>
  );
}

function overriddenStatusText(
  status: 'failed' | 'unavailable' | 'superseded' | 'not_run',
  t: Translate,
): string {
  switch (status) {
    case 'failed':
      return t('未通过', 'failed');
    case 'unavailable':
      return t('无法验收', 'could not be checked');
    case 'superseded':
      return t('那一轮先结束了，没有结论', 'its round ended first, with no result');
    case 'not_run':
      return t('当前计划没有跑过验收', 'never checked on the current plan');
  }
}

function Round({
  round,
  gateNames,
  objectNames,
  origin,
  t,
}: {
  readonly round: GoalAcceptanceRoundWire;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly objectNames: ReadonlyMap<string, string> | undefined;
  readonly origin: (checkKey: string) => string | null;
  readonly t: Translate;
}) {
  return (
    <div className="stack-s" data-testid="goal-acceptance-round" data-round={round.round}>
      <span className="section-title">
        {t(
          `第 ${round.round} 轮验收（计划第 ${round.planRevision} 版）`,
          `Round ${round.round} (plan v${round.planRevision})`,
        )}
        <span className="text-3 text-small">
          {' · '}
          <time title={formatDateTime(round.openedAt)}>{formatRelative(round.openedAt)}</time>
        </span>
      </span>
      <ul className="stack-s">
        {round.checks.map((check) => (
          <CheckRow
            key={check.checkKey}
            check={check}
            gateNames={gateNames}
            objectNames={objectNames}
            origin={origin(check.checkKey)}
            t={t}
          />
        ))}
      </ul>
    </div>
  );
}

function CheckRow({
  check,
  gateNames,
  objectNames,
  origin,
  t,
}: {
  readonly check: GoalAcceptanceCheckWire;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly objectNames: ReadonlyMap<string, string> | undefined;
  readonly origin: string | null;
  readonly t: Translate;
}) {
  return (
    <li className="stack-s" data-testid="goal-acceptance-check" data-check-key={check.checkKey}>
      <span className="row-wrap">
        <StatusChip machine="goalCheck" status={check.status} size="s" />
        <span className="mono">{check.checkKey}</span>
        <span className="text-3 text-small">{checkKindLabel(check.kind, t)}</span>
        <CheckOrigin text={origin} />
        {check.overridden ? (
          <span className="text-warn text-small">
            {t('被请求人推翻', 'Overridden by the requester')}
          </span>
        ) : null}
      </span>
      <span>{roundCheckSentence(check, gateNames, t, objectNames)}</span>
      <span className="row-wrap text-small text-3">
        {check.kind !== 'requester_confirm' ? (
          <span className="tabular">
            {t(`已试 ${check.attempts} 次`, `${check.attempts} attempt(s)`)}
          </span>
        ) : null}
        {check.nextAttemptAt ? (
          <span>
            {t('下次', 'next')}{' '}
            <time title={formatDateTime(check.nextAttemptAt)}>
              {formatRelative(check.nextAttemptAt)}
            </time>
          </span>
        ) : null}
        {check.settledAt ? (
          <span>
            {t('有结论于', 'settled')}{' '}
            <time title={formatDateTime(check.settledAt)}>{formatRelative(check.settledAt)}</time>
          </span>
        ) : null}
        {check.factId ? (
          <RouteLink
            href={auditHref({ nodeId: check.factId })}
            whenRefused="hide"
            testId="goal-check-fact"
          >
            {t('查看依据的事实', 'View the evidence fact')}
          </RouteLink>
        ) : null}
        {check.decisionId ? (
          <RouteLink
            href={auditHref({ nodeId: check.decisionId })}
            whenRefused="hide"
            testId="goal-check-decision"
          >
            {t('查看请求人的决定', 'View the requester’s decision')}
          </RouteLink>
        ) : null}
        {check.observationId ? (
          <span className="row-wrap">
            {t('观察', 'Observation')}
            <span className="mono">{shortId(check.observationId)}</span>
            <CopyButton
              value={check.observationId}
              label={t('复制观察 ID', 'Copy observation id')}
            />
          </span>
        ) : null}
      </span>
      {check.lastError ? (
        <span className="text-small text-danger">{checkErrorLabel(check.lastError, t)}</span>
      ) : null}
    </li>
  );
}

/** Legacy 454: which Procedure steps a requester's confirmation came from (`confirmCheckOrigin`). */
function CheckOrigin({ text }: { readonly text: string | null }) {
  if (text === null) return null;
  return (
    <span className="text-3 text-small" data-testid="goal-check-procedure-steps">
      {text}
    </span>
  );
}
