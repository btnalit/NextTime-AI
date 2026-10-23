import type {
  AcceptanceCheck,
  GoalAcceptanceCheckWire,
  GoalAcceptanceRoundWire,
  GoalDetailWire,
} from '@nexttime/shared';
import { auditHref } from '../../lib/audit.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import {
  checkKindLabel,
  factCheckSentence,
  observationSentence,
  planHintText,
} from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { CopyButton } from '../kit/copy-button.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { DashboardCard } from '../kit/section.js';
import { StatusChip } from '../kit/status-chip.js';

export interface GoalAcceptanceSectionProps {
  readonly detail: GoalDetailWire;
  readonly gateNames: ReadonlyMap<string, string>;
}

/**
 * components/goals/GoalAcceptanceSection (S11 GO6): how the goal is verified (plan §4.6) — the
 * plan's acceptance checks read as sentences, what the person confirming was told about them
 * (hints), every verification round with each check's status and evidence (a Fact or a Decision
 * opens its provenance; an Observation shows its id), and — when the requester declared the goal
 * achieved over checks that had not passed — those checks.
 */
export function GoalAcceptanceSection({ detail, gateNames }: GoalAcceptanceSectionProps) {
  const t = useT();
  const planChecks = detail.planRevision.plan.acceptance ?? [];
  const rounds = [...detail.acceptance.rounds].reverse();
  const [latest, ...older] = rounds;
  const overridden = detail.acceptance.overriddenChecks;
  return (
    <DashboardCard title={t('验收', 'Acceptance')} data-testid="goal-acceptance">
      <div className="stack">
        {detail.planRevision.hints.map((hint) => (
          <Notice key={hint.code} tone="warn" testId="goal-plan-hint">
            {planHintText(hint, t)}
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
                    {check.lastError ? <span className="text-3">{check.lastError}</span> : null}
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
                  <span>{planCheckSentence(check, gateNames, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {latest ? (
          <Round round={latest} gateNames={gateNames} t={t} />
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
                <Round key={round.round} round={round} gateNames={gateNames} t={t} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </DashboardCard>
  );
}

function planCheckSentence(
  check: AcceptanceCheck,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string {
  switch (check.kind) {
    case 'observe_predicate':
      return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
    case 'fact_predicate':
      return factCheckSentence(check.fact, t);
    case 'requester_confirm':
      return check.prompt;
  }
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
  t,
}: {
  readonly round: GoalAcceptanceRoundWire;
  readonly gateNames: ReadonlyMap<string, string>;
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
          <CheckRow key={check.checkKey} check={check} gateNames={gateNames} t={t} />
        ))}
      </ul>
    </div>
  );
}

function checkSentence(
  check: GoalAcceptanceCheckWire,
  gateNames: ReadonlyMap<string, string>,
  t: Translate,
): string {
  if (check.check) {
    return observationSentence(check.check, gateNames.get(check.check.gatekeeperId) ?? null, t);
  }
  if (check.fact) return factCheckSentence(check.fact, t);
  return check.prompt ?? '';
}

function CheckRow({
  check,
  gateNames,
  t,
}: {
  readonly check: GoalAcceptanceCheckWire;
  readonly gateNames: ReadonlyMap<string, string>;
  readonly t: Translate;
}) {
  return (
    <li className="stack-s" data-testid="goal-acceptance-check" data-check-key={check.checkKey}>
      <span className="row-wrap">
        <StatusChip machine="goalCheck" status={check.status} size="s" />
        <span className="mono">{check.checkKey}</span>
        <span className="text-3 text-small">{checkKindLabel(check.kind, t)}</span>
        {check.overridden ? (
          <span className="text-warn text-small">
            {t('被请求人推翻', 'Overridden by the requester')}
          </span>
        ) : null}
      </span>
      <span>{checkSentence(check, gateNames, t)}</span>
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
      {check.lastError ? <span className="text-small text-danger">{check.lastError}</span> : null}
    </li>
  );
}
