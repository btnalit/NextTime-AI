import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Icon } from './ui/Icon.js';
import { Notice } from './ui/Notice.js';
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

type Filter = 'pending' | 'all';

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
 * with a reload. Decisions are optimistic — the row leaves Pending on click and comes back with
 * the kernel's error if the call fails.
 *
 * "All" is bounded by what the kernel exposes: `list_pending` only returns `pending_approval` rows
 * and there is no list capability for decided ActionRequests (`get_action` is by id) — so "All"
 * is pending ∪ the requests this session watched get decided (kernel gap, see the PR report).
 */
export function ApprovalQueuePage({ http, pushes, selectedId, onSelect }: ApprovalQueuePageProps) {
  const permissions = usePermissions();
  const toast = useToast();
  const load = useCallback(
    () => http.call<readonly ActionRequestRowLike[]>('list_pending'),
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

  useEffect(() => {
    const unsubPending = pushes.onActionPending(() => void pending.reload());
    const unsubUpdated = pushes.onActionUpdated((event) => {
      pending.mutate((rows) => {
        const row = rows.find((candidate) => candidate.id === event.actionRequestId);
        if (row) {
          setDecided((prev) => ({ ...prev, [row.id]: { ...row, status: event.status } }));
        }
        return rows.filter((candidate) => candidate.id !== event.actionRequestId);
      });
      setDecided((prev) => {
        const existing = prev[event.actionRequestId];
        return existing
          ? { ...prev, [event.actionRequestId]: { ...existing, status: event.status } }
          : prev;
      });
      void refreshRow(event.actionRequestId).then((row) => {
        if (row && row.status !== 'pending_approval') {
          setDecided((prev) => ({ ...prev, [row.id]: row }));
        }
      });
      void pending.reload();
    });
    return () => {
      unsubPending();
      unsubUpdated();
    };
  }, [pushes, pending.reload, pending.mutate, refreshRow]);

  const pendingRows = pending.state.status === 'ready' ? pending.state.data : [];
  const rows = useMemo(() => {
    const pendingIds = new Set(pendingRows.map((row) => row.id));
    const decidedRows = Object.values(decided).filter((row) => !pendingIds.has(row.id));
    const all = filter === 'pending' ? [...pendingRows] : [...pendingRows, ...decidedRows];
    return all.sort(byNewest);
  }, [pendingRows, decided, filter]);

  // Deep link (`#/approvals/<id>`) to a request that is not in the list: fetch it by id.
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
    setDecision((prev) => ({ ...prev, [id]: { busy, error: busy ? null : (prev[id]?.error ?? null) } }));
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
      toast.push({ tone: 'ok', title: `Approved ${humanizeKind(row.actionKind)}` });
      if (options.alwaysAllow) {
        try {
          await http.call('set_auto_approved_action_kind', { actionKind: row.actionKind });
          toast.push({ tone: 'info', title: `${row.actionKind} will be auto-approved from now on` });
        } catch (err) {
          if (isForbiddenError(err)) permissions.markDenied('set_auto_approved_action_kind');
          toast.push({ tone: 'warn', title: 'Approved, but the auto-approval rule was not written' });
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
      toast.push({ tone: 'info', title: `Rejected ${humanizeKind(row.actionKind)}` });
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
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() => void pending.reload()}
            loading={pending.state.status === 'ready' && pending.state.refreshing}
          >
            Refresh
          </Button>
        }
      />

      <div className="page-toolbar">
        <Tabs<Filter>
          ariaLabel="Filter approvals"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'pending', label: 'Pending', count: pendingCount },
            { value: 'all', label: 'All', count: pendingCount + Object.keys(decided).length },
          ]}
        />
      </div>

      {pending.state.status === 'loading' ? (
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
          title={filter === 'pending' ? 'Nothing pending your approval' : 'No approvals seen this session'}
          body="Requests appear here the moment a Worker proposes an execute-class action that policy routes to you."
          testId="approvals-empty"
        />
      ) : (
        <>
          {pending.state.refreshError ? (
            <ErrorBanner error={pending.state.refreshError} onRetry={() => void pending.reload()} />
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
                    <span className="truncate">{humanizeKind(row.actionKind)}</span>
                    <span className="tag">{row.actionKind}</span>
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
                    <time title={formatDateTime(row.requestedAt)}>{formatRelative(row.requestedAt)}</time>
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
          {filter === 'all' ? (
            <Notice>
              The kernel lists pending requests only; decided requests shown here are the ones this
              session observed. A history view needs a list capability for decided ActionRequests.
            </Notice>
          ) : null}
        </>
      )}

      <Drawer
        open={selectedId !== undefined}
        onClose={() => onSelect(null)}
        title={selectedRow ? humanizeKind(selectedRow.actionKind) : 'Approval request'}
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
