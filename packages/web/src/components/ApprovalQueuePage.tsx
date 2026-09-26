import { ACTION_REQUEST_STATUS_VALUES } from '@nexttime/shared';
import type { ActionRequestStatus } from '@nexttime/shared';
import { useMemo, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind } from '../lib/format.js';
import type { ActionRequestRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { ApprovalDetail } from './approvals/ApprovalDetail.js';
import { useApprovalQueue } from './approvals/useApprovalQueue.js';
import { nameOf, useGatekeeperNames, usePrincipalNames } from './approvals/useDirectoryNames.js';
import { PageHeader } from './kit/page-header.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Icon } from './ui/Icon.js';
import { RefChip } from './ui/RefChip.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface ApprovalQueuePageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  /** The ActionRequest whose detail drawer is open (`#/work/approvals/<id>`), if any. */
  readonly selectedId?: string;
  readonly onSelect: (actionRequestId: string | null) => void;
}

type Filter = 'pending' | 'history';
type HistoryStatusFilter = 'all' | ActionRequestStatus;

const HISTORY_PAGE_SIZE = 50;

/**
 * components/ApprovalQueuePage: 待我审批 Approvals — the caller's own I14-scoped queue
 * (`list_pending`, design doc §7.6/§8.5; S2.10 deliverable 3) with a detail drawer per request.
 * States: skeleton → error (code + Retry) → empty → list. The queue's own state and decision
 * handling live in `components/approvals/useApprovalQueue` (console redesign P1) — it doesn't
 * render anything and needs nothing from `components/ui/*`, so it moved to its own file; this page
 * still needs `components/ui/*` throughout for its own rendering (no kit equivalents exist yet for
 * `DataList`/`EmptyState`/`SkeletonRows`/`Icon`/`Tabs`/`Drawer`, `scripts/guards/
 * legacy-ui-importers.json`).
 *
 * S6-A (B2 / C25 / B3 / B4, docs/console-completion-plan.md §5.8, §5.9 "待我审批"), S8 W1-A7
 * (audit S13): the drawer renders `approvals/ApprovalDetail`, which owns its own `kit/confirm`
 * `medium` popover (anchored to the shared `ui/ApprovalCard`) — a high-blast-radius Approve and
 * every Reject pass through it before the call; low/medium Approve is the card's one click (§5.9
 * principle 4). `approve{reason?}` / `reject{reason?}` carry the reason the card collected
 * (mandatory for high, validated by the card in front of the kernel's own 400 `reason_required`).
 * This page hands `ApprovalDetail` only the two confirmed mutations (`useApprovalQueue`'s
 * `handleApprove`/`handleReject`) — the confirm/no-confirm decision and its popover live entirely
 * inside `ApprovalDetail` now, nested in the same detail `Drawer` rather than a page-level sibling
 * of it. Bare ids are `RefChip`s with names from `list_principals` / `list_gatekeepers`
 * (`approvals/useDirectoryNames`).
 *
 * "History" (S5.5 leftover 21, docs/STATUS.md row 21) — `list_action_requests` (same I14
 * visibility as `list_pending`, every status, keyset-paginated) is a real server-backed read.
 * Split into its own `ApprovalHistoryTab` component below, mounted only while that tab is selected
 * — same "one tab, one child component, one `useCapabilityList`" convention `CatalogPage.tsx`'s
 * per-tab components use.
 */
export function ApprovalQueuePage({ http, pushes, selectedId, onSelect }: ApprovalQueuePageProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const principalNames = usePrincipalNames(http);
  const gatekeeperNames = useGatekeeperNames(http);
  const [filter, setFilter] = useState<Filter>('pending');
  const queue = useApprovalQueue({ http, pushes, selectedId, permissions, toast, t });
  const { pending, rows, pendingCount, forbidden, selectedRow, detailError } = queue;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('approvals')}
        title={t('待我审批', 'Approvals')}
        description={t(
          'Worker 在你的授权范围内提出的执行类动作；批准后由门执行。',
          'Execute-class actions Workers proposed within your scope. Approving lets the Gatekeeper run them.',
        )}
        actions={
          filter === 'pending' ? (
            <Button
              variant="ghost"
              icon="refresh"
              onClick={() => void pending.reload()}
              loading={pending.state.status === 'ready' && pending.state.refreshing}
            >
              {t('刷新', 'Refresh')}
            </Button>
          ) : undefined
        }
      />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter approvals"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: t('待处理', 'Pending'), count: pendingCount },
            { value: 'history', label: t('历史', 'History') },
          ]}
        />
      </div>

      {filter === 'pending' ? (
        pending.state.status === 'loading' ? (
          <SkeletonRows count={4} label="Loading approvals" testId="approvals-loading" />
        ) : pending.state.status === 'error' ? (
          forbidden ? (
            <EmptyState
              icon="shield"
              title={t('审批需要 operator 角色', 'Approvals need the operator role')}
              body={t(
                '当前主体不能调用 list_pending；请工作区 owner 授予 operator 角色。',
                'Your principal cannot call list_pending. Ask the workspace owner for an operator-role principal to approve actions.',
              )}
              testId="approvals-forbidden"
            />
          ) : (
            <ErrorBanner
              error={pending.state.error}
              title={t('无法加载审批队列', 'Could not load approvals')}
              onRetry={() => void pending.reload()}
              testId="approvals-error"
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon="approvals"
            title={t('没有等待你审批的请求', 'Nothing pending your approval')}
            body={t(
              'Worker 提出策略路由给你的执行类动作时，请求会立刻出现在这里。',
              'Requests appear here the moment a Worker proposes an execute-class action that policy routes to you.',
            )}
            testId="approvals-empty"
          />
        ) : (
          <>
            {pending.state.refreshError ? (
              <ErrorBanner
                error={pending.state.refreshError}
                onRetry={() => void pending.reload()}
              />
            ) : null}
            <DataList ariaLabel="Approval requests" testId="approvals-list">
              {rows.map((row) => (
                <DataRow
                  key={row.id}
                  testId="approval-row"
                  selected={row.id === selectedId}
                  onSelect={() => onSelect(row.id)}
                  leading={<StatusChip machine="actionRequest" status={row.status} size="s" />}
                  title={
                    <>
                      <span className="truncate">{humanizeKind(row.actionKindTag)}</span>
                      <span className="tag">{row.actionKindTag}</span>
                      {row.blastRadius !== 'low' ? (
                        <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />
                      ) : null}
                    </>
                  }
                  meta={
                    <>
                      <RefChip
                        kind="gatekeeper"
                        id={row.gatekeeperId}
                        name={nameOf(gatekeeperNames, row.gatekeeperId)}
                        size="s"
                      />
                      {row.onBehalfOf ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-3">{t('代表', 'for')}</span>
                          <RefChip
                            kind="principal"
                            id={row.onBehalfOf}
                            name={nameOf(principalNames, row.onBehalfOf)}
                            size="s"
                          />
                        </>
                      ) : null}
                      {row.resourceScope ? (
                        <>
                          <span className="meta-sep" />
                          <span className="mono truncate">{row.resourceScope}</span>
                        </>
                      ) : null}
                      <span className="meta-sep" />
                      <time title={formatDateTime(row.requestedAt)}>
                        {formatRelative(row.requestedAt)}
                      </time>
                      {row.awaitDecision && row.status === 'pending_approval' ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-danger">
                            {t('阻塞', 'Worker blocking a Worker')}
                          </span>
                        </>
                      ) : null}
                    </>
                  }
                  trailing={<Icon name="chevron-right" />}
                />
              ))}
            </DataList>
          </>
        )
      ) : (
        <ApprovalHistoryTab
          http={http}
          selectedId={selectedId}
          onSelect={onSelect}
          principalNames={principalNames}
          gatekeeperNames={gatekeeperNames}
        />
      )}

      <Drawer
        open={selectedId !== undefined}
        onClose={() => onSelect(null)}
        title={
          selectedRow ? humanizeKind(selectedRow.actionKindTag) : t('审批请求', 'Approval request')
        }
        subtitle={
          selectedId ? (
            <RefChip kind="actionRequest" id={selectedId} name={null} size="s" />
          ) : undefined
        }
        testId="approval-drawer"
      >
        {selectedRow ? (
          <ApprovalDetail
            key={selectedRow.id}
            row={selectedRow}
            principalNames={principalNames}
            gatekeeperNames={gatekeeperNames}
            canAlwaysAllow={!permissions.isDenied('set_auto_approved_action_kind')}
            onApprove={queue.handleApprove}
            onReject={queue.handleReject}
            error={queue.decision[selectedRow.id]?.error ?? null}
            pending={queue.pendingConfirm}
            onPendingChange={queue.setPendingConfirm}
          />
        ) : detailError ? (
          <ErrorBanner
            error={detailError}
            title={t('无法加载该请求', 'Could not load this request')}
          />
        ) : (
          <SkeletonRows count={2} label="Loading request" />
        )}
      </Drawer>
    </div>
  );
}

interface ApprovalHistoryTabProps {
  readonly http: CapabilityCaller;
  readonly selectedId?: string;
  readonly onSelect: (actionRequestId: string | null) => void;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
}

/**
 * `list_action_requests` (S5.5 leftover 21) — every ActionRequest regardless of status, same I14
 * visibility as `list_pending`/Pending above, status-filterable, keyset-paginated via
 * `useCapabilityList`'s `loadMore` (the same "加载更多" pattern `PlatformAuditPage.tsx`/
 * `PlatformUsersPage.tsx` already use for their own cursor-paged governance lists). Its own
 * component (not inlined in `ApprovalQueuePage` above) so the capability call only fires while
 * this tab is actually selected — same convention `CatalogPage.tsx`'s per-tab components use.
 * Kept in this file rather than moved to `components/approvals/` (console redesign P1): it renders
 * `Button`/`DataList`/`EmptyState`/`ErrorBanner`/`Field`/`Select`/`SkeletonRows`/`StatusChip`/
 * `Icon`/`RefChip`, none of which have an identical-rendering `components/kit/*` replacement yet
 * (`scripts/guards/legacy-ui-importers.json`).
 *
 * S6-A C25: rows now carry `decisionReason` / `decidedBy` / `decidedAt` (packages/shared/src/
 * wire/governance.ts) — the decider is a principal `RefChip`, the reason is shown inline; a row
 * without a human decision (auto-approved, denied, expired, or pending) shows neither.
 */
function ApprovalHistoryTab({
  http,
  selectedId,
  onSelect,
  principalNames,
  gatekeeperNames,
}: ApprovalHistoryTabProps) {
  const t = useT();
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>('all');
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: HISTORY_PAGE_SIZE };
    if (statusFilter !== 'all') next.status = statusFilter;
    return next;
  }, [statusFilter]);
  // `useCapabilityList` marks `list_action_requests` allowed/denied on `usePermissions` itself
  // (hooks/useCapability.ts) — no manual `markDenied` effect needed here.
  const history = useCapabilityList<ActionRequestRow>(http, 'list_action_requests', params);
  const forbidden = history.state.status === 'error' && isForbiddenError(history.state.error);
  const rows = history.state.status === 'ready' ? history.state.data.items : [];
  const nextCursor = history.state.status === 'ready' ? history.state.data.nextCursor : undefined;

  return (
    <div className="stack">
      <div className="page-toolbar">
        <Field id="approval-history-status" label={t('状态', 'Status')}>
          <Select
            id="approval-history-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}
          >
            <option value="all">{t('全部', 'All statuses')}</option>
            {ACTION_REQUEST_STATUS_VALUES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="ghost"
          icon="refresh"
          onClick={() => void history.reload()}
          loading={history.state.status === 'ready' && history.state.refreshing}
        >
          {t('刷新', 'Refresh')}
        </Button>
      </div>

      {history.state.status === 'loading' ? (
        <SkeletonRows
          count={4}
          label={t('正在加载审批历史…', 'Loading approval history')}
          testId="approval-history-loading"
        />
      ) : history.state.status === 'error' ? (
        forbidden ? (
          <EmptyState
            icon="shield"
            title={t('审批历史需要 operator 角色', 'Approval history needs the operator role')}
            body={t(
              '当前主体不能调用 list_action_requests。',
              'Your principal cannot call list_action_requests. Ask the workspace owner for an operator-role principal.',
            )}
            testId="approval-history-forbidden"
          />
        ) : (
          <ErrorBanner
            error={history.state.error}
            title={t('无法加载审批历史', 'Could not load approval history')}
            onRetry={() => void history.reload()}
            testId="approval-history-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="approvals"
          title={t('还没有审批历史', 'No approval history yet')}
          body={t(
            '已决定、已执行的请求会出现在这里。',
            'Decided and executed ActionRequests will appear here.',
          )}
          testId="approval-history-empty"
        />
      ) : (
        <>
          {history.state.refreshError ? (
            <ErrorBanner error={history.state.refreshError} onRetry={() => void history.reload()} />
          ) : null}
          <DataList ariaLabel="Approval history" testId="approval-history-list">
            {rows.map((row) => {
              const decidedBy = row.decidedBy ?? null;
              return (
                <DataRow
                  key={row.id}
                  testId="approval-history-row"
                  selected={row.id === selectedId}
                  onSelect={() => onSelect(row.id)}
                  leading={<StatusChip machine="actionRequest" status={row.status} size="s" />}
                  title={
                    <>
                      <span className="truncate">{humanizeKind(row.actionKindTag)}</span>
                      <span className="tag">{row.actionKindTag}</span>
                    </>
                  }
                  meta={
                    <>
                      <RefChip
                        kind="gatekeeper"
                        id={row.gatekeeperId}
                        name={nameOf(gatekeeperNames, row.gatekeeperId)}
                        size="s"
                      />
                      {row.onBehalfOf ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-3">{t('代表', 'for')}</span>
                          <RefChip
                            kind="principal"
                            id={row.onBehalfOf}
                            name={nameOf(principalNames, row.onBehalfOf)}
                            size="s"
                          />
                        </>
                      ) : null}
                      <span className="meta-sep" />
                      <time title={formatDateTime(row.requestedAt)}>
                        {t('请求', 'requested')} {formatRelative(row.requestedAt)}
                      </time>
                      {decidedBy ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-3">{t('决定', 'decided by')}</span>
                          <RefChip
                            kind="principal"
                            id={decidedBy}
                            name={nameOf(principalNames, decidedBy)}
                            size="s"
                            testId="approval-history-decided-by"
                          />
                          {row.decidedAt ? (
                            <time title={formatDateTime(row.decidedAt)}>
                              {formatRelative(row.decidedAt)}
                            </time>
                          ) : null}
                        </>
                      ) : null}
                      {row.decisionReason ? (
                        <>
                          <span className="meta-sep" />
                          <span
                            className="truncate"
                            title={row.decisionReason}
                            data-testid="approval-history-reason"
                          >
                            “{row.decisionReason}”
                          </span>
                        </>
                      ) : null}
                      {row.executedAt ? (
                        <>
                          <span className="meta-sep" />
                          <time title={formatDateTime(row.executedAt)}>
                            {t('执行', 'executed')} {formatRelative(row.executedAt)}
                          </time>
                        </>
                      ) : row.failedAt ? (
                        <>
                          <span className="meta-sep" />
                          <time className="text-danger" title={formatDateTime(row.failedAt)}>
                            {t('失败', 'failed')} {formatRelative(row.failedAt)}
                          </time>
                        </>
                      ) : null}
                    </>
                  }
                  trailing={<Icon name="chevron-right" />}
                />
              );
            })}
          </DataList>
          {nextCursor !== undefined ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button
                variant="secondary"
                loading={history.loadingMore}
                onClick={() => void history.loadMore()}
              >
                {t('加载更多', 'Load more')}
              </Button>
            </div>
          ) : null}
          {history.loadMoreError !== null ? (
            <ErrorBanner
              error={history.loadMoreError}
              title={t('无法加载更多审批历史', 'Could not load more approval history')}
              testId="approval-history-load-more-error"
            />
          ) : null}
        </>
      )}
    </div>
  );
}
