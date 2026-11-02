import type { AdminProposalStatus, AdminProposalSummaryWire } from '@nexttime/shared';
import { ADMIN_PROPOSAL_STATUS_VALUES } from '@nexttime/shared';
import { useState } from 'react';
import { invalidateCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { breadcrumbFor } from '../../lib/nav.js';
import type { PlatformProposalsTab } from '../../lib/router.js';
import { ADMIN_PROPOSAL_TONES, labelText } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { List, ListRow } from '../kit/list-row.js';
import { MasterDetail } from '../kit/master-detail.js';
import { PageHeader } from '../kit/page-header.js';
import { Select } from '../kit/select.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { Tabs } from '../kit/tabs.js';
import { ChangeRecordsTab } from './admin-proposals/ChangeRecords.js';
import { ProposalDetail } from './admin-proposals/ProposalDetail.js';
import { ADMIN_PROPOSAL_STALE_READS } from './admin-proposals/stale-reads.js';
import { proposerText, segmentCountsText } from './admin-proposals/text.js';

export interface PlatformAdminProposalsPageProps {
  readonly http: CapabilityCaller;
  /** `#/platform/admin-proposals` (管理员提案) or `…/records` (平台变更记录). */
  readonly tab: PlatformProposalsTab;
  /** The open proposal's id, or the open platform change record's. */
  readonly itemId: string | undefined;
  readonly onNavigate: (tab: PlatformProposalsTab, itemId: string | null) => void;
}

/**
 * components/platform/PlatformAdminProposalsPage: 平台 · 管理员提案 (`#/platform/admin-proposals`,
 * S11 AA4b; the AA4 plan F7). A platform administrator's 管理员智能体 tries a change out in a trial
 * workspace and proposes it as an 管理员提案: at most one 平台部分 (new gate-host instances, decided
 * here by a platform administrator) and a 工作区部分 for each workspace it changes (decided by that
 * workspace's owner in their 能力目录 · 管理员提案 — this page shows only how each stands and the
 * owner's reason, never what it changes in the workspace).
 *
 * Two tabs:
 * - 管理员提案: every proposal (`list_admin_proposals`), and in its detail the platform part's
 *   review — `preview_platform_segment`, item by item with each authority-widening item ticked —
 *   apply, reject with a reason, the record its apply left, and withdrawing the whole proposal.
 * - 平台变更记录: what applying platform parts changed (`list_platform_change_segments`), each with
 *   how it stands now (read live from the rollback dry run every time it opens) and its rollback.
 *   Changes made by hand are in 平台审计, not here.
 */
export function PlatformAdminProposalsPage({
  http,
  tab,
  itemId,
  onNavigate,
}: PlatformAdminProposalsPageProps) {
  const t = useT();
  // 刷新: every read below is dropped from the cache and the tab mounts again, reading afresh.
  const [epoch, setEpoch] = useState(0);
  function refresh(): void {
    for (const name of ADMIN_PROPOSAL_STALE_READS) invalidateCapability(http, name);
    setEpoch((value) => value + 1);
  }

  return (
    <div className="page" data-testid="platform-admin-proposals-page">
      <PageHeader
        title={t('管理员提案', 'Admin proposals')}
        description={t(
          '平台管理员的管理员智能体在试验工作区里试好改动后提出的管理员提案。平台部分（新建门宿主实例）在这里审阅、应用或拒绝；工作区部分由各工作区的所有者在他们的「能力目录」里决定，这里只看状态。',
          'The admin proposals platform administrators’ admin agents make once they have tried a change out in a trial workspace. The platform part (new gate-host instances) is reviewed, applied or rejected here; each workspace part is decided by that workspace’s owner in their Catalog, and only its status shows here.',
        )}
        breadcrumb={breadcrumbFor('platformAdminProposals')}
        actions={
          <Button variant="ghost" onClick={refresh} data-testid="platform-admin-proposals-refresh">
            {t('刷新', 'Refresh')}
          </Button>
        }
      />
      <Tabs<PlatformProposalsTab>
        ariaLabel={t('管理员提案页签', 'Admin proposal tabs')}
        value={tab}
        onChange={(next) => onNavigate(next, null)}
        options={[
          {
            value: 'proposals',
            label: t('管理员提案', 'Admin proposals'),
            testId: 'admin-proposals-tab-proposals',
          },
          {
            value: 'records',
            label: t('平台变更记录', 'Platform change records'),
            testId: 'admin-proposals-tab-records',
          },
        ]}
      />
      {tab === 'proposals' ? (
        <ProposalsTab
          key={epoch}
          http={http}
          itemId={itemId}
          onSelectItem={(id) => onNavigate('proposals', id)}
        />
      ) : (
        <ChangeRecordsTab
          key={epoch}
          http={http}
          itemId={itemId}
          onSelectItem={(id) => onNavigate('records', id)}
        />
      )}
    </div>
  );
}

type StatusFilter = AdminProposalStatus | 'all';

function ProposalsTab({
  http,
  itemId,
  onSelectItem,
}: {
  readonly http: CapabilityCaller;
  readonly itemId: string | undefined;
  readonly onSelectItem: (id: string | null) => void;
}) {
  const t = useT();
  // Every proposal by default: this page is where the whole of each one is read, not only the
  // platform's to-do (a proposal with no platform part is still withdrawn from here).
  const [filter, setFilter] = useState<StatusFilter>('all');
  const proposals = useCapabilityList<AdminProposalSummaryWire>(
    http,
    'list_admin_proposals',
    filter === 'all' ? {} : { status: filter },
  );
  const rows = proposals.state.status === 'ready' ? proposals.state.data.items : [];

  const list =
    proposals.state.status === 'loading' ? (
      <SkeletonRows count={3} label={t('正在加载管理员提案…', 'Loading admin proposals')} />
    ) : proposals.state.status === 'error' ? (
      <ErrorBanner
        error={proposals.state.error}
        title={t('无法加载管理员提案', 'Could not load admin proposals')}
        onRetry={() => void proposals.reload()}
        testId="platform-admin-proposals-error"
      />
    ) : (
      <div className="stack-s">
        <Select
          aria-label={t('按状态筛选', 'Filter by status')}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value as StatusFilter)}
          data-testid="platform-admin-proposals-filter"
        >
          <option value="all">{t('全部', 'All')}</option>
          {ADMIN_PROPOSAL_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {labelText(ADMIN_PROPOSAL_TONES[status], t)}
            </option>
          ))}
        </Select>
        {rows.length === 0 ? (
          <EmptyState
            title={
              filter === 'all'
                ? t('还没有管理员提案', 'No admin proposals yet')
                : t('没有这个状态的管理员提案', 'No admin proposals in this status')
            }
            body={t(
              '平台管理员的管理员智能体在试验工作区里试好改动、提出管理员提案后，会出现在这里。',
              'Once a platform administrator’s admin agent has tried a change out in a trial workspace and proposed it, the admin proposal shows up here.',
            )}
            testId="platform-admin-proposals-empty"
          />
        ) : (
          <List
            ariaLabel={t('管理员提案', 'Admin proposals')}
            testId="platform-admin-proposals-list"
          >
            {rows.map((proposal) => (
              <ListRow
                key={proposal.id}
                testId={`platform-admin-proposal-row-${proposal.id}`}
                selected={proposal.id === itemId}
                onSelect={() => onSelectItem(proposal.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="truncate">{proposal.title}</span>
                  <StatusChip machine="adminProposal" status={proposal.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {proposerText(proposal.proposedBy, t)}
                  {' · '}
                  <time
                    dateTime={proposal.proposedAt}
                    title={formatDateTime(proposal.proposedAt)}
                    data-volatile=""
                  >
                    {formatRelative(proposal.proposedAt)}
                  </time>
                </span>
                <span className="truncate text-3 text-small">
                  {segmentCountsText(proposal.segmentCounts, t)}
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {proposals.state.data.truncated ? (
          <span className="text-3 text-small" data-testid="platform-admin-proposals-truncated">
            {t(
              '只列出最新的 100 份；按状态筛选可以看到其余的。',
              'Only the newest 100 are listed; filter by status to see the rest.',
            )}
          </span>
        ) : null}
      </div>
    );

  const detail =
    itemId === undefined ? (
      rows.length > 0 ? (
        <EmptyState
          title={t(
            '选择左侧一份管理员提案，查看它的平台部分和各工作区部分',
            'Select an admin proposal on the left to see its platform part and workspace parts',
          )}
          testId="platform-admin-proposal-detail-empty"
        />
      ) : null
    ) : (
      <ProposalDetail
        key={itemId}
        http={http}
        proposalId={itemId}
        onChanged={() => void proposals.reload()}
      />
    );

  return (
    <MasterDetail
      list={list}
      detail={detail}
      open={itemId !== undefined}
      onClose={() => onSelectItem(null)}
      sheetTitle={t('管理员提案', 'Admin proposal')}
      detailTestId="platform-admin-proposal-pane"
    />
  );
}
