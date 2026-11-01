import {
  type GoalDetailWire,
  type PlanRevisionSummaryWire,
  type PlanRevisionWire,
  visibleLines,
} from '@nexttime/shared';
import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { type PlanDiff, planDiff, stepRemovalText } from '../../lib/goals.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { RefChip } from '../kit/ref-chip.js';
import { DashboardCard } from '../kit/section.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { PlanSource, PlanSourceParameters } from './PlanSource.js';

export interface GoalRevisionsSectionProps {
  readonly detail: GoalDetailWire;
  readonly http: CapabilityCaller;
}

/**
 * components/goals/GoalRevisionsSection (S11 GO6): 计划版本 — the plan's revisions, newest first:
 * who made each and why, who decided it, what it decided about the steps it removed, and — opened
 * on demand (`get_goal_revision` for it and the one it was based on) — which steps it added,
 * removed or redefined. Which accepted revision is in force is the goal's `currentRevision`.
 */
export function GoalRevisionsSection({ detail, http }: GoalRevisionsSectionProps) {
  const t = useT();
  const revisions = [...detail.revisions].reverse();
  return (
    <DashboardCard title={t('计划版本', 'Plan revisions')} data-testid="goal-revisions">
      <ol className="stack">
        {revisions.map((revision) => (
          <RevisionItem
            key={revision.id}
            revision={revision}
            current={detail.currentRevision}
            detail={detail}
            http={http}
            t={t}
          />
        ))}
      </ol>
    </DashboardCard>
  );
}

function RevisionItem({
  revision,
  current,
  detail,
  http,
  t,
}: {
  readonly revision: PlanRevisionSummaryWire;
  readonly current: number | null;
  readonly detail: GoalDetailWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  const inForce = revision.status === 'accepted' && revision.revision === current;
  const replaced =
    revision.status === 'accepted' && current !== null && revision.revision < current;
  const removals = Object.entries(revision.removals);
  return (
    <li className="stack-s" data-testid="goal-revision" data-revision={revision.revision}>
      <span className="row-wrap">
        <strong>{t(`第 ${revision.revision} 版`, `v${revision.revision}`)}</strong>
        <StatusChip machine="planRevision" status={revision.status} size="s" />
        {inForce ? <span className="text-small">{t('生效中', 'In force')}</span> : null}
        {replaced ? (
          <span className="text-small text-3">{t('已被后来的版本取代', 'Replaced since')}</span>
        ) : null}
        <time className="text-3 text-small" title={formatDateTime(revision.createdAt)}>
          {formatRelative(revision.createdAt)}
        </time>
      </span>
      <span className="row-wrap text-small">
        <span className="text-3">
          {revision.proposer === 'planner'
            ? t('提议', 'Proposed by')
            : revision.revision === 1
              ? t('提出', 'Proposed by')
              : t('修订', 'Revised by')}
        </span>
        {/* S11 GO9a: the goal planner's Principal reads as 「目标规划器」 (`lib/labels.ts`). */}
        <RefChip kind="principal" id={revision.proposedBy} http={http} size="s" />
        {revision.proposer === 'planner' ? (
          <span className="chip chip-s" data-testid="goal-revision-planner">
            {t('规划器提议', 'Planner proposal')}
          </span>
        ) : null}
        {revision.decidedBy ? (
          <>
            <span className="meta-sep" />
            <span className="text-3">
              {revision.status === 'rejected'
                ? t('拒绝', 'Rejected by')
                : revision.acceptedBy === 'platform'
                  ? t('代为接受，授权人', 'Accepted on the leave of')
                  : revision.proposer === 'planner'
                    ? t('接受', 'Accepted by')
                    : t('确认', 'Confirmed by')}
            </span>
            <RefChip kind="principal" id={revision.decidedBy} http={http} size="s" />
            {/* S11 GO9b: the platform accepted it for the requester, under their apply_minor leave. */}
            {revision.acceptedBy === 'platform' ? (
              <span className="chip chip-s" data-testid="goal-revision-platform">
                {t(
                  '小修订，平台按请求人的授权采用',
                  'Minor revision, adopted by the platform on the requester’s leave',
                )}
              </span>
            ) : null}
            {revision.decidedAt ? (
              <time className="text-3" title={formatDateTime(revision.decidedAt)}>
                {formatRelative(revision.decidedAt)}
              </time>
            ) : null}
          </>
        ) : null}
      </span>
      {revision.fromProcedure ? (
        <span className="text-small">
          <PlanSource source={revision.fromProcedure} testId="goal-revision-from-procedure" />
          <PlanSourceParameters
            http={http}
            source={revision.fromProcedure}
            testId="goal-revision-parameters"
          />
        </span>
      ) : null}
      {revision.status === 'proposed' && revision.proposer === 'planner' ? (
        <span className="text-small text-3">
          {revision.basedOnRevision === current
            ? t(
                '等请求人在上面的「目标规划器」里决定。',
                'Waiting for the requester to decide, under Goal planner above.',
              )
            : t(
                '它基于的版本已经不在用了，不能再接受。',
                'The revision it was based on is no longer in force, so it can no longer be accepted.',
              )}
        </span>
      ) : null}
      {revision.reason ? (
        <p className="pre-wrap">{visibleLines(revision.reason)}</p>
      ) : revision.revision > 1 ? (
        <span className="text-small text-3">{t('没有写修订原因。', 'No reason given.')}</span>
      ) : null}
      {removals.length > 0 ? (
        <ul className="stack-s text-small" data-testid="goal-revision-removals">
          {removals.map(([key, removal]) => (
            <li key={key} className="row-wrap">
              <span>{t('移除', 'Removed')}</span>
              <span className="mono">{key}</span>
              <span className="text-3">{stepRemovalText(removal, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {revision.basedOnRevision !== null ? (
        <RevisionDiff
          goalRunId={revision.goalRunId}
          revision={revision.revision}
          basedOn={revision.basedOnRevision}
          detail={detail}
          http={http}
          t={t}
        />
      ) : null}
    </li>
  );
}

type DiffState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'ready'; readonly diff: PlanDiff };

function RevisionDiff({
  goalRunId,
  revision,
  basedOn,
  detail,
  http,
  t,
}: {
  readonly goalRunId: string;
  readonly revision: number;
  readonly basedOn: number;
  readonly detail: GoalDetailWire;
  readonly http: CapabilityCaller;
  readonly t: Translate;
}) {
  const [state, setState] = useState<DiffState>({ status: 'idle' });

  async function read(number: number): Promise<PlanRevisionWire> {
    if (detail.planRevision.revision === number) return detail.planRevision;
    return http.call<PlanRevisionWire>('get_goal_revision', { goalRunId, revision: number });
  }

  async function load(): Promise<void> {
    setState({ status: 'loading' });
    try {
      const [before, after] = await Promise.all([read(basedOn), read(revision)]);
      setState({ status: 'ready', diff: planDiff(before.plan, after.plan) });
    } catch (error) {
      setState({ status: 'error', error });
    }
  }

  return (
    <details
      className="disclosure"
      data-testid="goal-revision-diff"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && state.status === 'idle')
          void load();
      }}
    >
      <summary>{t(`相对第 ${basedOn} 版改了什么`, `What changed since v${basedOn}`)}</summary>
      <div className="disclosure-body">
        {state.status === 'ready' ? (
          <DiffBody diff={state.diff} t={t} />
        ) : state.status === 'error' ? (
          <ErrorBanner
            error={state.error}
            title={t('无法读取这两版计划', 'Could not read the two revisions')}
            onRetry={() => void load()}
          />
        ) : (
          <SkeletonRows count={2} label={t('正在读取两版计划', 'Loading the revisions')} />
        )}
      </div>
    </details>
  );
}

function DiffBody({ diff, t }: { readonly diff: PlanDiff; readonly t: Translate }) {
  const lines: {
    readonly key: string;
    readonly label: string;
    readonly keys: readonly string[];
  }[] = [
    { key: 'added', label: t('新增步骤', 'Steps added'), keys: diff.added },
    { key: 'removed', label: t('移除步骤', 'Steps removed'), keys: diff.removed },
    { key: 'changed', label: t('改动的步骤', 'Steps redefined'), keys: diff.changed },
  ].filter((line) => line.keys.length > 0);
  if (lines.length === 0 && !diff.acceptanceChanged) {
    return (
      <span className="text-small text-3">
        {t('步骤和验收检查都没变。', 'No step or check changed.')}
      </span>
    );
  }
  return (
    <ul className="stack-s text-small" data-testid="goal-revision-diff-body">
      {lines.map((line) => (
        <li key={line.key} className="row-wrap" data-diff={line.key}>
          <span className="text-3">{line.label}</span>
          {line.keys.map((key) => (
            <span key={key} className="mono">
              {key}
            </span>
          ))}
        </li>
      ))}
      {diff.acceptanceChanged ? (
        <li>{t('目标的验收检查改了。', 'The goal’s acceptance checks changed.')}</li>
      ) : null}
    </ul>
  );
}
