import type { GateAddressChangeStatusWire, PlatformGateAddressChangeWire } from '@nexttime/shared';
import { useEffect, useRef } from 'react';
import { type CapabilityListResult, useCapabilityList } from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../../lib/format.js';
import { type Translate, useT } from '../../../lib/i18n.js';
import { transportKindLabel } from '../../../lib/labels.js';
import { Button } from '../../kit/button.js';
import { ErrorBanner } from '../../kit/error-banner.js';
import { SkeletonRows } from '../../kit/skeleton.js';

/** A page of the history: a platform has few of these, and the list is opened to look back. */
const HISTORY_PAGE = 20;

const ENDED_CHANGES: Readonly<Record<string, unknown>> = { ended: true, limit: HISTORY_PAGE };

export interface GateAddressChangeHistoryProps {
  readonly http: CapabilityCaller;
  /** Bumped when a proposal above was approved or rejected: an opened history reads again. */
  readonly revision: number;
}

/**
 * components/platform/integrations/GateAddressChangeHistory (legacy 717): 集成 → 自己接入的门, at
 * the end — the moves that ended (`list_gate_address_changes {ended: true}`, newest first):
 * applied, rejected with the reason, withdrawn by the workspace, or expired undecided. Collapsed,
 * its header naming the latest one's outcome and when (UX of #1191, legacy 668 — so the first page
 * is read up front); 加载更多 pages it. The platform audit keeps the same decisions, one row per
 * act; this is the list by proposal, with both addresses and how it ended — three short lines a
 * row (four with a rejection's reason), so a page stays short at phone width.
 *
 * Addresses show their scheme, host and port only, as the rest of the page does.
 */
export function GateAddressChangeHistory({ http, revision }: GateAddressChangeHistoryProps) {
  const t = useT();
  const history = useCapabilityList<PlatformGateAddressChangeWire>(
    http,
    'list_gate_address_changes',
    ENDED_CHANGES,
  );
  // A decision above ends a proposal: the history reads again (the first page and every page the
  // reader had loaded), so the move just decided is on top, and in the header.
  const reload = history.reload;
  const seen = useRef(revision);
  useEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    void reload();
  }, [revision, reload]);
  const latest = history.state.status === 'ready' ? history.state.data.items[0] : undefined;

  return (
    <details className="disclosure" data-testid="gate-address-change-history">
      <summary>
        {t('已结束的换地址申请', 'Ended moves to a new address')}
        {latest !== undefined ? (
          <span className="text-3" data-testid="gate-address-change-history-latest">
            {t('（最近一条：', ' (latest: ')}
            {`${latest.workspaceName} · ${outcomeChip(latest.status, t).label} · `}
            <When at={endedAt(latest)} />
            {t('）', ')')}
          </span>
        ) : null}
      </summary>
      <div className="disclosure-body stack-s">
        <p className="text-3 text-small" style={{ margin: 0 }}>
          {t(
            '批准、驳回、被工作区撤回或没人审批而过期的申请，最新的在前。每一次批准和驳回也记在平台审计里。',
            'Moves approved, rejected, withdrawn by their workspace, or expired undecided, newest first. Each approval and rejection is also in the platform audit.',
          )}
        </p>
        <HistoryBody history={history} t={t} />
      </div>
    </details>
  );
}

function HistoryBody({
  history,
  t,
}: {
  readonly history: CapabilityListResult<PlatformGateAddressChangeWire>;
  readonly t: Translate;
}) {
  if (history.state.status === 'loading') {
    return (
      <SkeletonRows
        count={2}
        label={t('正在读取已结束的换地址申请…', 'Reading the ended moves')}
        testId="gate-address-change-history-loading"
      />
    );
  }
  if (history.state.status === 'error') {
    return (
      <ErrorBanner
        error={history.state.error}
        title={t('无法读取已结束的换地址申请', 'Could not read the ended moves')}
        onRetry={() => void history.reload()}
        testId="gate-address-change-history-error"
      />
    );
  }
  const { items, nextCursor } = history.state.data;
  if (items.length === 0) {
    return (
      <p
        className="text-3 text-small"
        style={{ margin: 0 }}
        data-testid="gate-address-change-history-empty"
      >
        {t('还没有已结束的换地址申请。', 'No move has ended yet.')}
      </p>
    );
  }
  return (
    <>
      <ul className="stack-s" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((change) => (
          <HistoryRow key={change.id} change={change} t={t} />
        ))}
      </ul>
      {nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            size="s"
            disabled={history.loadingMore}
            aria-busy={history.loadingMore}
            onClick={() => void history.loadMore()}
            data-testid="gate-address-change-history-more"
          >
            {history.loadingMore ? t('正在加载…', 'Loading…') : t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {history.loadMoreError !== null ? (
        <ErrorBanner
          error={history.loadMoreError}
          title={t('无法加载更多换地址申请', 'Could not load more moves')}
          onRetry={() => void history.loadMore()}
          testId="gate-address-change-history-more-error"
        />
      ) : null}
    </>
  );
}

/** How a move ended, as a short chip, and its tone. */
function outcomeChip(
  status: GateAddressChangeStatusWire,
  t: Translate,
): { readonly label: string; readonly tone: string } {
  switch (status) {
    case 'applied':
      return { label: t('已换址', 'Moved'), tone: 'chip-ok' };
    case 'rejected':
      return { label: t('已驳回', 'Rejected'), tone: 'chip-danger' };
    case 'withdrawn':
      return { label: t('已撤回', 'Withdrawn'), tone: 'chip-neutral' };
    case 'expired':
      return { label: t('已过期', 'Expired'), tone: 'chip-warn' };
    case 'proposed':
      // Not listed here (`ended: true`); kept so the switch covers the type.
      return { label: t('待审批', 'Awaiting approval'), tone: 'chip-info' };
  }
}

function When({ at }: { readonly at: string }) {
  const t = useT();
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {formatRelative(at, t)}
    </time>
  );
}

/** When a move ended: its decision or withdrawal; an expired one at its expiry, whenever a later
 *  act recorded it so (`decidedAt`). */
function endedAt(change: PlatformGateAddressChangeWire): string {
  return change.status === 'expired' ? change.expiresAt : (change.decidedAt ?? change.expiresAt);
}

function HistoryRow({
  change,
  t,
}: {
  readonly change: PlatformGateAddressChangeWire;
  readonly t: Translate;
}) {
  const rowId = change.id;
  const chip = outcomeChip(change.status, t);
  const proposer = change.proposedByName ?? t('工作区所有者', 'a workspace owner');
  const decider = change.decidedByLogin ?? t('平台管理员', 'a platform administrator');
  // UX of #1191 (legacy 668): who proposed it and how it ended, on one line.
  const how =
    change.status === 'applied'
      ? t(`${decider} 批准`, `approved by ${decider}`)
      : change.status === 'rejected'
        ? t(`${decider} 驳回`, `rejected by ${decider}`)
        : change.status === 'withdrawn'
          ? t('工作区所有者撤回', 'withdrawn by a workspace owner')
          : change.status === 'expired'
            ? t('没人审批，过期', 'expired undecided')
            : null;
  const showEnd = change.status === 'expired' || change.decidedAt !== null;

  return (
    <li className="data-row" data-testid={`gate-address-change-history-row-${rowId}`}>
      <div className="data-row-main stack-s">
        <div className="data-row-title">
          <strong>{`${change.workspaceName} · ${change.target}`}</strong>
          <span className="tag">{transportKindLabel(change.connector, t)}</span>
          <span
            className={`chip chip-s ${chip.tone}`}
            data-testid={`gate-address-change-history-outcome-${rowId}`}
          >
            {chip.label}
          </span>
        </div>
        <span
          className="mono text-small wrap-anywhere"
          aria-label={t(
            `原地址 ${change.fromEndpoint}，新地址 ${change.toEndpoint}`,
            `From ${change.fromEndpoint} to ${change.toEndpoint}`,
          )}
          data-testid={`gate-address-change-history-addresses-${rowId}`}
        >
          {`${change.fromEndpoint} → ${change.toEndpoint}`}
        </span>
        <span
          className="text-3 text-small"
          data-testid={`gate-address-change-history-who-${rowId}`}
        >
          {t(`${proposer} 申请 · `, `Proposed by ${proposer} · `)}
          <When at={change.createdAt} />
          {how !== null && showEnd ? (
            <>
              {t('；', '; ')}
              {how}
              {' · '}
              <When at={endedAt(change)} />
            </>
          ) : how !== null ? (
            <>
              {t('；', '; ')}
              {how}
            </>
          ) : null}
        </span>
        {change.status === 'rejected' ? (
          <span className="text-small wrap-anywhere">
            {change.rejectionReason
              ? t(`原因：${change.rejectionReason}`, `Reason: ${change.rejectionReason}`)
              : t('没有写原因', 'No reason given')}
          </span>
        ) : null}
      </div>
    </li>
  );
}
