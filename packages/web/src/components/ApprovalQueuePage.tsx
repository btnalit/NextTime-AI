import { ACTION_REQUEST_STATUS_VALUES } from '@nexttime/shared';
import type { ActionRequestStatus } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind } from '../lib/format.js';
import type { ActionRequestRow } from '../lib/governance.js';
import { useT } from '../lib/i18n.js';
import { breadcrumbFor } from '../lib/nav.js';
import {
  type ApprovalDecisionInput,
  ApprovalDetail,
  type PendingConfirm,
} from './approvals/ApprovalDetail.js';
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

interface DecisionState {
  readonly busy: boolean;
  readonly error: unknown | null;
}

const IDLE: DecisionState = { busy: false, error: null };

function byNewest(a: ActionRequestRow, b: ActionRequestRow): number {
  return (b.requestedAt ?? '').localeCompare(a.requestedAt ?? '');
}

/**
 * components/ApprovalQueuePage: 待我审批 Approvals — the caller's own I14-scoped queue
 * (`list_pending`, design doc §7.6/§8.5; S2.10 deliverable 3) with a detail drawer per request.
 * States: skeleton → error (code + Retry) → empty → list. Live: `action.pending` reloads the
 * queue; `action.updated` moves the row out of Pending into the session-local "decided" set
 * immediately and reconciles that one row with `get_action` (C7: no full `list_pending` reload on
 * top — the push already names the row, and the queue itself only ever loses rows on
 * `action.updated`). Decisions are optimistic — the row leaves Pending on click and comes back
 * with the kernel's error if the call fails.
 *
 * S6-A (B2 / C25 / B3 / B4, docs/console-completion-plan.md §5.8, §5.9 "待我审批"), S8 W1-A7
 * (audit S13): the drawer renders `approvals/ApprovalDetail`, which owns its own `kit/confirm`
 * `medium` popover (anchored to the shared `ui/ApprovalCard`) — a high-blast-radius Approve and
 * every Reject pass through it before the call; low/medium Approve is the card's one click (§5.9
 * principle 4). `approve{reason?}` / `reject{reason?}` carry the reason the card collected
 * (mandatory for high, validated by the card in front of the kernel's own 400 `reason_required`).
 * This page hands `ApprovalDetail` only the two confirmed mutations (`handleApprove`/
 * `handleReject` below) — the confirm/no-confirm decision and its popover live entirely inside
 * `ApprovalDetail` now, nested in the same detail `Drawer` rather than a page-level sibling of it
 * (the popover's own Escape handler stops the keydown from also reaching the drawer's — see
 * `kit/confirm.tsx`'s own doc comment). Bare ids are `RefChip`s with names from `list_principals` /
 * `list_gatekeepers` (`approvals/useDirectoryNames`).
 *
 * "History" (S5.5 leftover 21, docs/STATUS.md row 21) — `list_action_requests` (same I14
 * visibility as `list_pending`, every status, keyset-paginated) is a real server-backed read.
 * Split into its own `ApprovalHistoryTab` component, mounted only while that tab is selected —
 * same "one tab, one child component, one `useCapabilityList`" convention `CatalogPage.tsx`'s
 * per-tab components use. `decided` (below) is unrelated to that tab; it only keeps the drawer's
 * subject resolvable between an optimistic decision and the next `list_pending` reload — a
 * selection in neither `pendingRows` nor `decided` (e.g. a row opened from History) falls through
 * to the plain `get_action` fetch below, which is workspace-scoped and not I14-narrowed (§9.3).
 */
export function ApprovalQueuePage({ http, pushes, selectedId, onSelect }: ApprovalQueuePageProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const load = useCallback(
    () =>
      http.call<{ items: readonly ActionRequestRow[] }>('list_pending').then((page) => page.items),
    [http],
  );
  const pending = useResource(load);
  const principalNames = usePrincipalNames(http);
  const gatekeeperNames = useGatekeeperNames(http);
  const [filter, setFilter] = useState<Filter>('pending');
  const [decided, setDecided] = useState<Readonly<Record<string, ActionRequestRow>>>({});
  const [decision, setDecision] = useState<Readonly<Record<string, DecisionState>>>({});
  const [fetchedDetail, setFetchedDetail] = useState<ActionRequestRow | null>(null);
  const [detailError, setDetailError] = useState<unknown | null>(null);
  // The confirm's own state, owned here rather than inside `ApprovalDetail` — see that prop's own
  // doc comment (S8 W1-A7): `ApprovalDetail` can remount mid-decision, and state kept there would
  // be lost when it does. Reset whenever the open request changes so a stale confirm from a
  // previous selection can never reopen against the wrong row.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedId is the intentional reset trigger, not read in the effect body.
  useEffect(() => {
    setPendingConfirm(null);
  }, [selectedId]);
  const forbidden = pending.state.status === 'error' && isForbiddenError(pending.state.error);
  useEffect(() => {
    if (forbidden) permissions.markDenied('list_pending');
  }, [forbidden, permissions]);

  const refreshRow = useCallback(
    async (actionRequestId: string): Promise<ActionRequestRow | null> => {
      try {
        return await http.call<ActionRequestRow>('get_action', { actionRequestId });
      } catch {
        return null;
      }
    },
    [http],
  );

  const pendingRows = pending.state.status === 'ready' ? pending.state.data : [];
  // Mirror of the current Pending rows for the push handler below (C3): the handler reads the
  // row it is moving from here rather than from inside `pending.mutate`'s updater, which must
  // stay a pure function of its argument (React runs updaters twice under StrictMode, and a
  // `setDecided` inside one is a side effect even when it happens to be idempotent).
  const pendingRowsRef = useRef(pendingRows);
  pendingRowsRef.current = pendingRows;

  useEffect(() => {
    const unsubPending = pushes.onActionPending(() => void pending.reload());
    const unsubUpdated = pushes.onActionUpdated((event) => {
      const row = pendingRowsRef.current.find((candidate) => candidate.id === event.id);
      if (row) {
        setDecided((prev) => ({ ...prev, [row.id]: { ...row, status: event.status } }));
        pending.mutate((rows) => rows.filter((candidate) => candidate.id !== event.id));
      } else {
        setDecided((prev) => {
          const existing = prev[event.id];
          return existing ? { ...prev, [event.id]: { ...existing, status: event.status } } : prev;
        });
      }
      // C7: one `get_action` for the row the push named is the whole reconciliation — the
      // former unconditional `pending.reload()` doubled every push into a full list fetch.
      void refreshRow(event.id).then((fresh) => {
        if (fresh && fresh.status !== 'pending_approval') {
          setDecided((prev) => ({ ...prev, [fresh.id]: fresh }));
        }
      });
    });
    return () => {
      unsubPending();
      unsubUpdated();
    };
  }, [pushes, pending.reload, pending.mutate, refreshRow]);

  const rows = useMemo(() => [...pendingRows].sort(byNewest), [pendingRows]);

  // Deep link (`#/work/approvals/<id>`) to a request that is not in the Pending list: fetch it by
  // id (covers a History-tab selection too — `get_action` is workspace-scoped, not I14-narrowed).
  const selectedFromList =
    selectedId === undefined
      ? undefined
      : (pendingRows.find((row) => row.id === selectedId) ?? decided[selectedId]);
  useEffect(() => {
    setFetchedDetail(null);
    setDetailError(null);
    if (!selectedId || selectedFromList || pending.state.status === 'loading') return;
    let cancelled = false;
    http
      .call<ActionRequestRow>('get_action', { actionRequestId: selectedId })
      .then((row) => {
        if (!cancelled) setFetchedDetail(row);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedFromList, http, pending.state.status]);
  // S8 W1-A7: an optimistic decision (`moveToDecided`) can, for one render, leave the row
  // findable in neither `pendingRows` nor `decided` — `moveToDecided`'s removal and `revert`'s
  // undo of it land in separate renders around the awaited kernel call. Previously that render's
  // `selectedRow` fell all the way through to `undefined` and this page swapped in a skeleton,
  // unmounting `ApprovalDetail` (and, now that the confirm is anchored inside it rather than a
  // page-level sibling, whatever confirm popover happened to be open, along with its own inline
  // error). Caching the last row resolved for the *current* `selectedId` and falling back to it
  // keeps `ApprovalDetail` mounted through that one-render gap; a genuine selection change (a
  // different id) never reads a stale cache, since the id guard below only matches the same one.
  const lastRowForSelection = useRef<{
    readonly id: string;
    readonly row: ActionRequestRow;
  } | null>(null);
  if (selectedId !== undefined && selectedFromList !== undefined) {
    lastRowForSelection.current = { id: selectedId, row: selectedFromList };
  }
  const selectedRow =
    selectedFromList ??
    fetchedDetail ??
    (selectedId !== undefined && lastRowForSelection.current?.id === selectedId
      ? lastRowForSelection.current.row
      : undefined);

  function setBusy(id: string, busy: boolean): void {
    setDecision((prev) => ({
      ...prev,
      [id]: { busy, error: busy ? null : (prev[id]?.error ?? null) },
    }));
  }

  function settle(id: string, error: unknown | null): void {
    setDecision((prev) => ({ ...prev, [id]: { busy: false, error } }));
  }

  function moveToDecided(row: ActionRequestRow, status: string): void {
    setDecided((prev) => ({ ...prev, [row.id]: { ...row, status } }));
    pending.mutate((current) => current.filter((candidate) => candidate.id !== row.id));
  }

  function revert(id: string): void {
    setDecided((prev) => {
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
  }

  function rowFor(id: string): ActionRequestRow | undefined {
    return rows.find((candidate) => candidate.id === id) ?? selectedRow ?? undefined;
  }

  /** The `approve` call itself (optimistic; throws on failure so `ApprovalDetail`'s confirm keeps
   *  its popover open with the kernel's error — the direct path catches it in `handleApprove`). */
  async function performApprove(row: ActionRequestRow, input: ApprovalDecisionInput) {
    const id = row.id;
    setBusy(id, true);
    moveToDecided(row, 'approved');
    try {
      const result = await http.call<ActionRequestRow>('approve', {
        actionRequestId: id,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      setDecided((prev) => ({ ...prev, [id]: { ...row, ...result } }));
      settle(id, null);
      toast.push({ tone: 'ok', title: `已批准 Approved · ${humanizeKind(row.actionKindTag)}` });
    } catch (err) {
      revert(id);
      settle(id, err);
      await pending.reload();
      throw err;
    }
    if (input.alwaysAllow) {
      try {
        await http.call('set_auto_approved_action_kind', { actionKindTag: row.actionKindTag });
        toast.push({
          tone: 'info',
          title: `今后自动批准 Auto-approved from now on · ${row.actionKindTag}`,
        });
      } catch (err) {
        if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
        toast.push({
          tone: 'warn',
          title: t(
            '已批准，但自动批准规则未写入',
            'Approved, but the auto-approval rule was not written',
          ),
        });
      }
    }
  }

  async function performReject(row: ActionRequestRow, reason: string | undefined) {
    const id = row.id;
    setBusy(id, true);
    moveToDecided(row, 'rejected');
    try {
      const result = await http.call<ActionRequestRow>('reject', {
        actionRequestId: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      setDecided((prev) => ({ ...prev, [id]: { ...row, ...result } }));
      settle(id, null);
      toast.push({ tone: 'info', title: `已拒绝 Rejected · ${humanizeKind(row.actionKindTag)}` });
    } catch (err) {
      revert(id);
      settle(id, err);
      await pending.reload();
      throw err;
    }
  }

  /** `ApprovalDetail` itself decides whether a confirm precedes the call (§5.9 principle 4: low /
   *  medium Approve straight through, high Approve and every Reject via its own `kit/confirm`) —
   *  this page only ever hands it the confirmed mutation, and always lets it throw: for a
   *  confirmed call `ApprovalDetail`'s own `runConfirm` re-throws into `Confirm`'s `onConfirm`,
   *  which shows the error inline and keeps the popover open; for the direct (no-confirm) path
   *  `ApprovalDetail` swallows the rejection itself (its own comment explains why) and relies on
   *  `decision[id].error` below instead. */
  async function handleApprove(input: ApprovalDecisionInput): Promise<void> {
    const row = rowFor(input.actionRequestId);
    if (!row) return;
    await performApprove(row, input);
  }

  async function handleReject(input: Omit<ApprovalDecisionInput, 'alwaysAllow'>): Promise<void> {
    const row = rowFor(input.actionRequestId);
    if (!row) return;
    await performReject(row, input.reason);
  }

  const pendingCount = pendingRows.length;

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
            onApprove={handleApprove}
            onReject={handleReject}
            error={decision[selectedRow.id]?.error ?? IDLE.error}
            pending={pendingConfirm}
            onPendingChange={setPendingConfirm}
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
          label="Loading approval history"
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
