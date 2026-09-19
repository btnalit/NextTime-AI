import { ACTION_REQUEST_STATUS_VALUES } from '@nexttime/shared';
import type { ActionRequestStatus } from '@nexttime/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import { type ActionRequestRowLike, actionCardFromRow } from '../lib/action-card.js';
import type { CapabilityCaller, PushSource } from '../lib/clients.js';
import { isForbiddenError } from '../lib/errors.js';
import { formatDateTime, formatRelative, humanizeKind, shortId } from '../lib/format.js';
import { ActionRequestDetail } from './ActionRequestDetail.js';
import { Button } from './ui/Button.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
import { SkeletonRows } from './ui/Skeleton.js';
import { StatusChip } from './ui/StatusChip.js';
import { Tabs } from './ui/Tabs.js';
import { useToast } from './ui/Toast.js';

export interface ApprovalQueuePageProps {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  /** The ActionRequest whose detail drawer is open (`#/approvals/<id>`), if any. */
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

function byNewest(a: ActionRequestRowLike, b: ActionRequestRowLike): number {
  return (b.requestedAt ?? '').localeCompare(a.requestedAt ?? '');
}

/**
 * components/ApprovalQueuePage: the caller's own I14-scoped queue (`list_pending`, design doc
 * §7.6/§8.5; S2.10 deliverable 3) with a detail drawer per request. States: skeleton → error
 * (code + Retry) → empty → list. Live: `action.pending` reloads the queue; `action.updated`
 * moves the row out of Pending into the session-local "decided" set immediately and reconciles
 * that one row with `get_action` (C7: no full `list_pending` reload on top — the push already
 * names the row, and the queue itself only ever loses rows on `action.updated`). Decisions are
 * optimistic — the row leaves Pending on click and comes back with the kernel's error if the
 * call fails.
 *
 * "History" (S5.5 leftover 21, docs/STATUS.md row 21) replaces the earlier session-only "All" tab
 * — `list_action_requests` (same I14 visibility as `list_pending`, every status, keyset-paginated)
 * is a real server-backed read, not a client-side cache of requests this session happened to
 * observe. Split into its own `ApprovalHistoryTab` component, mounted only while that tab is
 * selected — same "one tab, one child component, one `useCapabilityList`" convention
 * `CatalogPage.tsx`'s `OperationsTab`/`SkillsTab`/etc. already use, so History's own capability
 * call never fires while the caller is only looking at Pending. `decided` (below) is unrelated to
 * that tab; it only keeps the drawer's subject resolvable for the brief window between an
 * optimistic decision and the next `list_pending` reload picking it up — a selection that belongs
 * to neither `pendingRows` nor `decided` (e.g. a row opened from the History tab) falls through to
 * the plain `get_action` fetch below, which is workspace-scoped and not I14-narrowed (§9.3).
 */
export function ApprovalQueuePage({ http, pushes, selectedId, onSelect }: ApprovalQueuePageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const load = useCallback(
    () =>
      http
        .call<{ items: readonly ActionRequestRowLike[] }>('list_pending')
        .then((page) => page.items),
    [http],
  );
  const pending = useResource(load);
  const [filter, setFilter] = useState<Filter>('pending');
  const [decided, setDecided] = useState<Readonly<Record<string, ActionRequestRowLike>>>({});
  const [decision, setDecision] = useState<Readonly<Record<string, DecisionState>>>({});
  const [fetchedDetail, setFetchedDetail] = useState<ActionRequestRowLike | null>(null);
  const [detailError, setDetailError] = useState<unknown | null>(null);

  const forbidden = pending.state.status === 'error' && isForbiddenError(pending.state.error);
  useEffect(() => {
    if (forbidden) permissions.markDenied('list_pending');
  }, [forbidden, permissions]);

  const refreshRow = useCallback(
    async (actionRequestId: string): Promise<ActionRequestRowLike | null> => {
      try {
        return await http.call<ActionRequestRowLike>('get_action', { actionRequestId });
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

  // Deep link (`#/approvals/<id>`) to a request that is not in the Pending list: fetch it by id
  // (covers a History-tab selection too — `get_action` is workspace-scoped, not I14-narrowed).
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
      .call<ActionRequestRowLike>('get_action', { actionRequestId: selectedId })
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
  const selectedRow = selectedFromList ?? fetchedDetail;

  function setBusy(id: string, busy: boolean): void {
    setDecision((prev) => ({
      ...prev,
      [id]: { busy, error: busy ? null : (prev[id]?.error ?? null) },
    }));
  }

  function settle(id: string, error: unknown | null): void {
    setDecision((prev) => ({ ...prev, [id]: { busy: false, error } }));
  }

  function moveToDecided(row: ActionRequestRowLike, status: string): void {
    setDecided((prev) => ({ ...prev, [row.id]: { ...row, status } }));
    pending.mutate((current) => current.filter((candidate) => candidate.id !== row.id));
  }

  async function handleApprove(id: string, options: { alwaysAllow: boolean }): Promise<void> {
    const row = rows.find((candidate) => candidate.id === id) ?? selectedRow;
    if (!row) return;
    setBusy(id, true);
    moveToDecided(row, 'approved');
    try {
      const result = await http.call<{ status: string }>('approve', { actionRequestId: id });
      setDecided((prev) => ({ ...prev, [id]: { ...row, status: result.status } }));
      settle(id, null);
      toast.push({ tone: 'ok', title: `Approved ${humanizeKind(row.actionKindTag)}` });
      if (options.alwaysAllow) {
        try {
          await http.call('set_auto_approved_action_kind', { actionKindTag: row.actionKindTag });
          toast.push({
            tone: 'info',
            title: `${row.actionKindTag} will be auto-approved from now on`,
          });
        } catch (err) {
          if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
          toast.push({
            tone: 'warn',
            title: 'Approved, but the auto-approval rule was not written',
          });
        }
      }
    } catch (err) {
      setDecided((prev) => {
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      });
      settle(id, err);
      await pending.reload();
    }
  }

  async function handleReject(id: string, reason: string | undefined): Promise<void> {
    const row = rows.find((candidate) => candidate.id === id) ?? selectedRow;
    if (!row) return;
    setBusy(id, true);
    moveToDecided(row, 'rejected');
    try {
      const result = await http.call<{ status: string }>('reject', {
        actionRequestId: id,
        ...(reason !== undefined ? { reason } : {}),
      });
      setDecided((prev) => ({ ...prev, [id]: { ...row, status: result.status } }));
      settle(id, null);
      toast.push({ tone: 'info', title: `Rejected ${humanizeKind(row.actionKindTag)}` });
    } catch (err) {
      setDecided((prev) => {
        const { [id]: _dropped, ...rest } = prev;
        return rest;
      });
      settle(id, err);
      await pending.reload();
    }
  }

  const pendingCount = pendingRows.length;

  return (
    <div className="page">
      <PageHeader
        title="Approvals"
        description="Execute-class actions Workers proposed within your scope. Approving lets the Gatekeeper run them."
        actions={
          filter === 'pending' ? (
            <Button
              variant="ghost"
              icon="refresh"
              onClick={() => void pending.reload()}
              loading={pending.state.status === 'ready' && pending.state.refreshing}
            >
              Refresh
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
            { value: 'pending', label: 'Pending', count: pendingCount },
            { value: 'history', label: 'History' },
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
              title="Approvals need the operator role"
              body="Your API key's principal cannot call list_pending. Ask the workspace owner for an operator-role principal to approve actions."
              testId="approvals-forbidden"
            />
          ) : (
            <ErrorBanner
              error={pending.state.error}
              title="Could not load approvals"
              onRetry={() => void pending.reload()}
              testId="approvals-error"
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon="approvals"
            title="Nothing pending your approval"
            body="Requests appear here the moment a Worker proposes an execute-class action that policy routes to you."
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
                    </>
                  }
                  meta={
                    <>
                      {row.actorRuntime ? <span>{row.actorRuntime}</span> : null}
                      {row.onBehalfOf ? (
                        <>
                          <span className="meta-sep" />
                          <span title={row.onBehalfOf}>for {shortId(row.onBehalfOf)}</span>
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
                      {row.blastRadius !== 'low' ? (
                        <>
                          <span className="meta-sep" />
                          <span className={row.blastRadius === 'high' ? 'text-danger' : ''}>
                            {row.blastRadius} blast radius
                          </span>
                        </>
                      ) : null}
                      {row.awaitDecision && row.status === 'pending_approval' ? (
                        <>
                          <span className="meta-sep" />
                          <span>blocking a Worker</span>
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
        <ApprovalHistoryTab http={http} selectedId={selectedId} onSelect={onSelect} />
      )}

      <Drawer
        open={selectedId !== undefined}
        onClose={() => onSelect(null)}
        title={selectedRow ? humanizeKind(selectedRow.actionKindTag) : 'Approval request'}
        subtitle={selectedId ? <span className="mono">{selectedId}</span> : undefined}
        testId="approval-drawer"
      >
        {selectedRow ? (
          <ActionRequestDetail
            key={selectedRow.id}
            card={actionCardFromRow(selectedRow)}
            busy={decision[selectedRow.id]?.busy ?? IDLE.busy}
            error={decision[selectedRow.id]?.error ?? IDLE.error}
            onApprove={(id, options) => void handleApprove(id, options)}
            onReject={(id, reason) => void handleReject(id, reason)}
            canAlwaysAllow={!permissions.isDenied('set_auto_approved_action_kind')}
          />
        ) : detailError ? (
          <ErrorBanner error={detailError} title="Could not load this request" />
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
}

/**
 * `list_action_requests` (S5.5 leftover 21) — every ActionRequest regardless of status, same I14
 * visibility as `list_pending`/Pending above, status-filterable, keyset-paginated via
 * `useCapabilityList`'s `loadMore` (the same "加载更多" pattern `PlatformAuditPage.tsx`/
 * `PlatformUsersPage.tsx` already use for their own cursor-paged governance lists). Its own
 * component (not inlined in `ApprovalQueuePage` above) so the capability call only fires while
 * this tab is actually selected — same convention `CatalogPage.tsx`'s per-tab components use.
 *
 * `decidedBy` (the approving/rejecting principal) is not shown: `ActionRequestWireSchema`
 * (packages/shared/src/wire/governance.ts) carries `approvalDecisionId` — an opaque reference into
 * `decisions`, not the decider's identity — and this task's own scope keeps `list_action_requests`
 * returning that exact existing wire shape rather than inventing a richer one (dispatch: "reuse
 * the existing ActionRequest wire schema ... do not invent a new shape"). Requester
 * (`onBehalfOf`), gatekeeper, and every timestamp the wire shape does carry are shown instead.
 */
function ApprovalHistoryTab({ http, selectedId, onSelect }: ApprovalHistoryTabProps) {
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>('all');
  const params = useMemo(() => {
    const next: Record<string, unknown> = { limit: HISTORY_PAGE_SIZE };
    if (statusFilter !== 'all') next.status = statusFilter;
    return next;
  }, [statusFilter]);
  // `useCapabilityList` marks `list_action_requests` allowed/denied on `usePermissions` itself
  // (hooks/useCapability.ts) — no manual `markDenied` effect needed here.
  const history = useCapabilityList<ActionRequestRowLike>(http, 'list_action_requests', params);
  const forbidden = history.state.status === 'error' && isForbiddenError(history.state.error);
  const rows = history.state.status === 'ready' ? history.state.data.items : [];
  const nextCursor = history.state.status === 'ready' ? history.state.data.nextCursor : undefined;

  return (
    <div className="stack">
      <div className="page-toolbar">
        <Field id="approval-history-status" label="Status">
          <Select
            id="approval-history-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}
          >
            <option value="all">All statuses</option>
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
          Refresh
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
            title="Approval history needs the operator role"
            body="Your API key's principal cannot call list_action_requests. Ask the workspace owner for an operator-role principal."
            testId="approval-history-forbidden"
          />
        ) : (
          <ErrorBanner
            error={history.state.error}
            title="Could not load approval history"
            onRetry={() => void history.reload()}
            testId="approval-history-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="approvals"
          title="No approval history yet"
          body="Decided and executed ActionRequests will appear here."
          testId="approval-history-empty"
        />
      ) : (
        <>
          {history.state.refreshError ? (
            <ErrorBanner error={history.state.refreshError} onRetry={() => void history.reload()} />
          ) : null}
          <DataList ariaLabel="Approval history" testId="approval-history-list">
            {rows.map((row) => (
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
                    {row.gatekeeperId ? (
                      <span className="mono truncate" title={row.gatekeeperId}>
                        {shortId(row.gatekeeperId)}
                      </span>
                    ) : null}
                    {row.onBehalfOf ? (
                      <>
                        <span className="meta-sep" />
                        <span title={row.onBehalfOf}>for {shortId(row.onBehalfOf)}</span>
                      </>
                    ) : null}
                    <span className="meta-sep" />
                    <time title={formatDateTime(row.requestedAt)}>
                      requested {formatRelative(row.requestedAt)}
                    </time>
                    {row.executedAt ? (
                      <>
                        <span className="meta-sep" />
                        <time title={formatDateTime(row.executedAt)}>
                          executed {formatRelative(row.executedAt)}
                        </time>
                      </>
                    ) : row.failedAt ? (
                      <>
                        <span className="meta-sep" />
                        <time className="text-danger" title={formatDateTime(row.failedAt)}>
                          failed {formatRelative(row.failedAt)}
                        </time>
                      </>
                    ) : null}
                  </>
                }
                trailing={<Icon name="chevron-right" />}
              />
            ))}
          </DataList>
          {nextCursor !== undefined ? (
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button
                variant="secondary"
                loading={history.loadingMore}
                onClick={() => void history.loadMore()}
              >
                Load more
              </Button>
            </div>
          ) : null}
          {history.loadMoreError !== null ? (
            <ErrorBanner
              error={history.loadMoreError}
              title="Could not load more approval history"
              testId="approval-history-load-more-error"
            />
          ) : null}
        </>
      )}
    </div>
  );
}
