import { ACTION_REQUEST_STATUS_VALUES } from '@nexttime/shared';
import type { ActionRequestStatus } from '@nexttime/shared';
import { useMemo, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { usePermissions } from '../hooks/usePermissions.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind, shortId } from '../lib/format.js';
import type { ActionRequestRow } from '../lib/governance.js';
import { type Translate, useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import { labelText, statusChipStyle } from '../lib/status-tone.js';
import { ApprovalDetail } from './approvals/ApprovalDetail.js';
import { useApprovalQueue } from './approvals/useApprovalQueue.js';
import { nameOf, useGatekeeperNames, usePrincipalNames } from './approvals/useDirectoryNames.js';
import { Button } from './kit/button.js';
import { EmptyState } from './kit/empty-state.js';
import { ErrorBanner } from './kit/error-banner.js';
import { List, ListRow } from './kit/list-row.js';
import { PageHeader } from './kit/page-header.js';
import { Select } from './kit/select.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './kit/sheet.js';
import { SkeletonRows } from './kit/skeleton.js';
import { StatusChip } from './kit/status-chip.js';
import { Tabs } from './kit/tabs.js';
// `useToast` stays on `components/ui/Toast` — `App.tsx` mounts that provider (not
// `kit/toast`'s own, separate context), so `kit/toast`'s hook would make the queue's
// 已批准 / 已拒绝 toasts a silent no-op (same reason as `AgentProfilePage.tsx`).
import { useToast } from './ui/Toast.js';

export interface ApprovalQueuePageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  /** The ActionRequest whose detail is open (`#/work/approvals/<id>`), if any — rendered in the
   *  wide layout's own detail pane, or in a `kit/sheet` at narrower widths. */
  readonly selectedId?: string;
  readonly onSelect: (actionRequestId: string | null) => void;
}

type Filter = 'pending' | 'history';
type HistoryStatusFilter = 'all' | ActionRequestStatus;

const HISTORY_PAGE_SIZE = 50;

/** ≤1179px: list only, the detail opens in a `kit/sheet`; ≥1180px: two-pane master-detail. Chosen
 *  so Playwright's default 1280×720 viewport (journeys) and the 1440px gate screenshot both land
 *  in the wide layout, and the 768px gate screenshot lands in the narrow one — see the existing
 *  1279px/960px checkpoints in `styles/pages.css`. `useMediaQuery` degrades to `false` (not
 *  narrow) where `matchMedia` is unavailable — jsdom in a test with no mock — so the default,
 *  everywhere this hasn't been explicitly mocked to the contrary, is the wide layout. */
const NARROW_APPROVALS_QUERY = '(max-width: 1179px)';

/** "等待 N 分钟" / "等待 N 小时" / "等待 N 天" — a pending row's own elapsed-wait framing (distinct
 *  from `formatRelative`'s "N 分钟前", which reads as "in the past" rather than "still waiting"). */
function waitingLabel(iso: string | undefined, t: Translate): string {
  if (!iso) return t('刚刚提出', 'Just requested');
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return t('刚刚提出', 'Just requested');
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t(`等待 ${minutes} 分钟`, `Waiting ${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`等待 ${hours} 小时`, `Waiting ${hours}h`);
  const days = Math.floor(hours / 24);
  return t(`等待 ${days} 天`, `Waiting ${days}d`);
}

/**
 * components/ApprovalQueuePage: 待我审批 Approvals — the caller's own I14-scoped queue
 * (`list_pending`, design doc §7.6/§8.5) as a master-detail layout (console redesign P3-4, V6):
 * a list pane (or, ≤1179px, a list-only page) and a detail pane/`kit/sheet` for one selected
 * ActionRequest. The queue's own state and decision handling live in `components/approvals/
 * useApprovalQueue` (console redesign P1) — it doesn't render anything.
 *
 * Selection stays URL-driven exactly as before (`selectedId`/`onSelect`, `#/work/approvals/<id>`)
 * — no auto-select. In the wide layout, nothing selected renders a `kit/empty-state` naming the
 * object instead of a blank pane.
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
  const isNarrow = useMediaQuery(NARROW_APPROVALS_QUERY);

  const detailContent = (
    <ApprovalDetailContent
      t={t}
      selectedId={selectedId}
      selectedRow={selectedRow}
      detailError={detailError}
      principalNames={principalNames}
      gatekeeperNames={gatekeeperNames}
      canAlwaysAllow={!permissions.isDenied('set_auto_approved_action_kind')}
      onApprove={queue.handleApprove}
      onReject={queue.handleReject}
      decisionError={selectedRow ? (queue.decision[selectedRow.id]?.error ?? null) : null}
      pendingConfirm={queue.pendingConfirm}
      onPendingChange={queue.setPendingConfirm}
    />
  );

  return (
    <div className="page approvals-page">
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
              aria-busy={pending.state.status === 'ready' && pending.state.refreshing}
              disabled={pending.state.status === 'ready' && pending.state.refreshing}
              onClick={() => void pending.reload()}
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

      <div className={`approvals-layout approvals-layout--${isNarrow ? 'narrow' : 'wide'}`}>
        <div className="approvals-pane approvals-list-pane">
          <div className="approvals-pane-body">
            {filter === 'pending' ? (
              <PendingList
                t={t}
                pending={pending}
                rows={rows}
                forbidden={forbidden}
                selectedId={selectedId}
                onSelect={onSelect}
                principalNames={principalNames}
                gatekeeperNames={gatekeeperNames}
              />
            ) : (
              <ApprovalHistoryTab
                http={http}
                selectedId={selectedId}
                onSelect={onSelect}
                principalNames={principalNames}
                gatekeeperNames={gatekeeperNames}
              />
            )}
          </div>
          {filter === 'pending' && rows.length > 0 ? (
            <div className="approvals-pane-footer">
              {t(
                '未处理的请求会在策略规定时间后自动过期，不会被执行。',
                'Unhandled requests automatically expire after a policy-defined window and are never executed.',
              )}
            </div>
          ) : null}
        </div>

        {!isNarrow ? (
          <div className="approvals-pane approvals-detail-pane" data-testid="approval-drawer">
            <div className="approvals-pane-body">{detailContent}</div>
          </div>
        ) : null}
      </div>

      {isNarrow ? (
        <Sheet
          open={selectedId !== undefined}
          onOpenChange={(open) => {
            if (!open) onSelect(null);
          }}
        >
          <SheetContent data-testid="approval-drawer">
            <SheetHeader>
              <SheetTitle>
                {selectedRow
                  ? humanizeKind(selectedRow.actionKindTag)
                  : t('审批请求', 'Approval request')}
              </SheetTitle>
            </SheetHeader>
            {detailContent}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

interface ApprovalDetailContentProps {
  readonly t: Translate;
  readonly selectedId: string | undefined;
  readonly selectedRow: ActionRequestRow | undefined;
  readonly detailError: unknown | null;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
  readonly canAlwaysAllow: boolean;
  readonly onApprove: Parameters<typeof ApprovalDetail>[0]['onApprove'];
  readonly onReject: Parameters<typeof ApprovalDetail>[0]['onReject'];
  readonly decisionError: unknown | null;
  readonly pendingConfirm: Parameters<typeof ApprovalDetail>[0]['pending'];
  readonly onPendingChange: Parameters<typeof ApprovalDetail>[0]['onPendingChange'];
}

/** The detail pane's (wide layout) / sheet's (narrow layout) shared content — one selected
 *  ActionRequest, an error, a loading skeleton, or (nothing selected) the "pick one" empty state.
 *  The last of those is only reachable in the wide layout — the narrow layout's `Sheet` only opens
 *  once `selectedId` is set. */
function ApprovalDetailContent({
  t,
  selectedId,
  selectedRow,
  detailError,
  principalNames,
  gatekeeperNames,
  canAlwaysAllow,
  onApprove,
  onReject,
  decisionError,
  pendingConfirm,
  onPendingChange,
}: ApprovalDetailContentProps) {
  if (selectedRow) {
    return (
      <ApprovalDetail
        key={selectedRow.id}
        row={selectedRow}
        principalNames={principalNames}
        gatekeeperNames={gatekeeperNames}
        canAlwaysAllow={canAlwaysAllow}
        onApprove={onApprove}
        onReject={onReject}
        error={decisionError}
        pending={pendingConfirm}
        onPendingChange={onPendingChange}
      />
    );
  }
  if (detailError) {
    return (
      <ErrorBanner error={detailError} title={t('无法加载该请求', 'Could not load this request')} />
    );
  }
  if (selectedId !== undefined) {
    return <SkeletonRows count={2} label="Loading request" />;
  }
  return (
    <EmptyState
      title={t('还没有选择审批请求', 'No approval request selected yet')}
      body={t(
        '选择左侧一条审批请求，查看动作、目标与策略。',
        'Pick a request on the left to see its action, target and policy.',
      )}
      testId="approval-drawer-empty"
    />
  );
}

interface PendingListProps {
  readonly t: Translate;
  readonly pending: ReturnType<typeof useApprovalQueue>['pending'];
  readonly rows: readonly ActionRequestRow[];
  readonly forbidden: boolean;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string | null) => void;
  readonly principalNames: ReadonlyMap<string, string>;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
}

function PendingList({
  t,
  pending,
  rows,
  forbidden,
  selectedId,
  onSelect,
  principalNames,
  gatekeeperNames,
}: PendingListProps) {
  if (pending.state.status === 'loading') {
    return <SkeletonRows count={4} label="Loading approvals" testId="approvals-loading" />;
  }
  if (pending.state.status === 'error') {
    if (forbidden) {
      return (
        <EmptyState
          title={t('审批需要 operator 角色', 'Approvals need the operator role')}
          body={t(
            '当前主体不能调用 list_pending；请工作区 owner 授予 operator 角色。',
            'Your principal cannot call list_pending. Ask the workspace owner for an operator-role principal to approve actions.',
          )}
          testId="approvals-forbidden"
        />
      );
    }
    return (
      <ErrorBanner
        error={pending.state.error}
        title={t('无法加载审批队列', 'Could not load approvals')}
        onRetry={() => void pending.reload()}
        testId="approvals-error"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('没有等待你审批的请求', 'Nothing pending your approval')}
        body={t(
          'Worker 提出策略路由给你的执行类动作时，请求会立刻出现在这里。',
          'Requests appear here the moment a Worker proposes an execute-class action that policy routes to you.',
        )}
        testId="approvals-empty"
      />
    );
  }
  return (
    <div className="stack-s">
      {pending.state.refreshError ? (
        <ErrorBanner error={pending.state.refreshError} onRetry={() => void pending.reload()} />
      ) : null}
      <List ariaLabel="Approval requests" testId="approvals-list">
        {rows.map((row) => {
          const gateName = nameOf(gatekeeperNames, row.gatekeeperId) ?? shortId(row.gatekeeperId);
          const principalName = row.onBehalfOf
            ? (nameOf(principalNames, row.onBehalfOf) ?? shortId(row.onBehalfOf))
            : null;
          return (
            <ListRow
              key={row.id}
              testId="approval-row"
              selected={row.id === selectedId}
              onSelect={() => onSelect(row.id)}
              accent={
                row.blastRadius === 'high'
                  ? 'danger'
                  : row.blastRadius === 'medium'
                    ? 'warn'
                    : undefined
              }
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <StatusChip
                  machine="blastRadius"
                  status={row.blastRadius}
                  size="s"
                  testId="approval-row-impact"
                />
                <time className="text-3" title={formatDateTime(row.requestedAt)}>
                  {waitingLabel(row.requestedAt, t)}
                </time>
              </span>
              <span className="truncate">
                <span>{gateName}</span>
                <span className="meta-sep" />
                <span>{humanizeKind(row.actionKindTag)}</span>
                {row.resourceScope ? (
                  <>
                    {' → '}
                    <span className="mono">{row.resourceScope}</span>
                  </>
                ) : null}
              </span>
              <span className="row-wrap text-3">
                {row.actorRuntime ? (
                  <>
                    <span>{t('提出者', 'Proposed by')}</span>
                    <span className="tag">{row.actorRuntime}</span>
                  </>
                ) : null}
                {principalName ? (
                  <>
                    <span>{t('代表', 'on behalf of')}</span>
                    <span className="truncate">{principalName}</span>
                  </>
                ) : null}
                {row.awaitDecision && row.status === 'pending_approval' ? (
                  <span className="chip chip-warn chip-s">{t('阻塞中', 'Blocking')}</span>
                ) : null}
              </span>
            </ListRow>
          );
        })}
      </List>
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
 * `useCapabilityList`'s `loadMore`. Its own component so the capability call only fires while this
 * tab is actually selected.
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
  const history = useCapabilityList<ActionRequestRow>(http, 'list_action_requests', params);
  const forbidden = history.state.status === 'error' && isForbiddenError(history.state.error);
  const rows = history.state.status === 'ready' ? history.state.data.items : [];
  const nextCursor = history.state.status === 'ready' ? history.state.data.nextCursor : undefined;

  return (
    <div className="stack">
      <div className="page-toolbar">
        <Select
          id="approval-history-status"
          label={t('状态', 'Status')}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}
          className="approvals-status-select"
        >
          <option value="all">{t('全部', 'All statuses')}</option>
          {ACTION_REQUEST_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {labelText(statusChipStyle('actionRequest', status), t)}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          aria-busy={history.state.status === 'ready' && history.state.refreshing}
          disabled={history.state.status === 'ready' && history.state.refreshing}
          onClick={() => void history.reload()}
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
          <List ariaLabel="Approval history" testId="approval-history-list">
            {rows.map((row) => {
              const decidedBy = row.decidedBy ?? null;
              const gateName =
                nameOf(gatekeeperNames, row.gatekeeperId) ?? shortId(row.gatekeeperId);
              const principalName = row.onBehalfOf
                ? (nameOf(principalNames, row.onBehalfOf) ?? shortId(row.onBehalfOf))
                : null;
              return (
                <ListRow
                  key={row.id}
                  testId="approval-history-row"
                  selected={row.id === selectedId}
                  onSelect={() => onSelect(row.id)}
                  accent={
                    row.blastRadius === 'high'
                      ? 'danger'
                      : row.blastRadius === 'medium'
                        ? 'warn'
                        : undefined
                  }
                >
                  <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                    <span className="row-wrap">
                      <StatusChip
                        machine="blastRadius"
                        status={row.blastRadius}
                        size="s"
                        testId="approval-row-impact"
                      />
                      <StatusChip
                        machine="actionRequest"
                        status={row.status}
                        size="s"
                        testId="approval-row-status"
                      />
                    </span>
                    <time className="text-3" title={formatDateTime(row.requestedAt)}>
                      {formatRelative(row.decidedAt ?? row.requestedAt)}
                    </time>
                  </span>
                  <span className="truncate">
                    <span>{gateName}</span>
                    <span className="meta-sep" />
                    <span>{humanizeKind(row.actionKindTag)}</span>
                    {row.resourceScope ? (
                      <>
                        {' → '}
                        <span className="mono">{row.resourceScope}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="row-wrap text-3">
                    {row.actorRuntime ? (
                      <>
                        <span>{t('提出者', 'Proposed by')}</span>
                        <span className="tag">{row.actorRuntime}</span>
                      </>
                    ) : null}
                    {principalName ? (
                      <>
                        <span>{t('代表', 'on behalf of')}</span>
                        <span className="truncate">{principalName}</span>
                      </>
                    ) : null}
                  </span>
                  {decidedBy ? (
                    <span className="row-wrap text-3">
                      <span>{t('决定', 'decided by')}</span>
                      {/* A plain reference, not `kit/ref-chip`: that chip's own copy button is a
                          real `<button>`, and this whole row already is one (`kit/list-row`) —
                          nesting a second interactive `<button>` inside it is invalid HTML and
                          confuses both click handling and screen readers. The full chip (with
                          copy) lives in the detail pane instead. */}
                      <span
                        className="truncate"
                        data-ref-kind="principal"
                        data-ref-id={decidedBy}
                        data-testid="approval-history-decided-by"
                      >
                        {nameOf(principalNames, decidedBy) ?? shortId(decidedBy)}
                      </span>
                      {row.decidedAt ? (
                        <time title={formatDateTime(row.decidedAt)}>
                          {formatRelative(row.decidedAt)}
                        </time>
                      ) : null}
                      {row.decisionReason ? (
                        <span
                          className="truncate"
                          title={row.decisionReason}
                          data-testid="approval-history-reason"
                        >
                          “{row.decisionReason}”
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </ListRow>
              );
            })}
          </List>
          {nextCursor !== undefined ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button
                variant="secondary"
                aria-busy={history.loadingMore}
                disabled={history.loadingMore}
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
