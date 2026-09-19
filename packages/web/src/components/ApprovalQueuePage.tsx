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
import { hrefs } from '../lib/router.js';
import { type ApprovalDecisionInput, ApprovalDetail } from './approvals/ApprovalDetail.js';
import { nameOf, useGatekeeperNames, usePrincipalNames } from './approvals/useDirectoryNames.js';
import { Button } from './ui/Button.js';
import { ConfirmTier } from './ui/ConfirmTier.js';
import { DataList, DataRow } from './ui/DataList.js';
import { Drawer } from './ui/Drawer.js';
import { EmptyState } from './ui/EmptyState.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { Field, Select } from './ui/Field.js';
import { Icon } from './ui/Icon.js';
import { PageHeader } from './ui/PageHeader.js';
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

/** A decision waiting in the `ConfirmTier` drawer (§5.8 "确认态": Approve on a high blast
 *  radius and every Reject go through the tier-`high` confirmation listing the impact). */
interface PendingConfirm {
  readonly kind: 'approve' | 'reject';
  readonly row: ActionRequestRow;
  readonly reason: string | undefined;
  readonly alwaysAllow: boolean;
}

function byNewest(a: ActionRequestRow, b: ActionRequestRow): number {
  return (b.requestedAt ?? '').localeCompare(a.requestedAt ?? '');
}

const BLAST_LABEL: Readonly<Record<string, string>> = {
  low: '低 low',
  medium: '中 medium',
  high: '高 high',
};

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
 * S6-A (B2 / C25 / B3 / B4, docs/console-completion-plan.md §5.8, §5.9 "待我审批"): the drawer
 * renders `approvals/ApprovalDetail` on the shared `ui/ApprovalCard`; a high-blast-radius Approve
 * and every Reject pass through `ui/ConfirmTier` (tier `high`, impact list = the target resource,
 * gate, requester, blast radius) before the call — low / medium Approve is the card's one click
 * (§5.9 principle 4). `approve{reason?}` / `reject{reason?}` carry the reason the card collected
 * (mandatory for high, validated by the card in front of the kernel's own 400 `reason_required`).
 * The `ConfirmTier` drawer is a *sibling* of the detail drawer, never nested inside it: both
 * register Escape on `document`, so the detail drawer's `onClose` is a stable callback that
 * no-ops while a confirmation is open (read through a ref — `Drawer` keys its focus-trap effect
 * on `onClose` identity). Bare ids are `RefChip`s with names from `list_principals` /
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
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

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
  const selectedRow = selectedFromList ?? fetchedDetail;

  // Stable for `Drawer`'s focus-trap effect; ignores Escape / overlay clicks that reach the
  // detail drawer while the `ConfirmTier` drawer is on top of it (see the component doc).
  const confirmOpenRef = useRef(false);
  confirmOpenRef.current = confirm !== null;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const closeDetail = useCallback(() => {
    if (confirmOpenRef.current) return;
    onSelectRef.current(null);
  }, []);

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

  /** The `approve` call itself (optimistic; throws on failure so a `ConfirmTier` caller keeps
   *  its drawer open with the kernel's error — the direct path catches it below). */
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
          title:
            '已批准，但自动批准规则未写入 Approved, but the auto-approval rule was not written',
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

  /** From the card: low / medium → straight to the call (§5.9 principle 4 "中 · 可逆 → 一键批准");
   *  high → the tier-`high` confirmation first. */
  async function handleApprove(input: ApprovalDecisionInput): Promise<void> {
    const row = rowFor(input.actionRequestId);
    if (!row) return;
    if (row.blastRadius === 'high') {
      setConfirm({ kind: 'approve', row, reason: input.reason, alwaysAllow: input.alwaysAllow });
      return;
    }
    try {
      await performApprove(row, input);
    } catch {
      // Shown through `decision[id].error` in the drawer.
    }
  }

  async function handleReject(input: Omit<ApprovalDecisionInput, 'alwaysAllow'>): Promise<void> {
    const row = rowFor(input.actionRequestId);
    if (!row) return;
    setConfirm({ kind: 'reject', row, reason: input.reason, alwaysAllow: false });
  }

  async function runConfirm(): Promise<void> {
    if (!confirm) return;
    if (confirm.kind === 'approve') {
      await performApprove(confirm.row, {
        actionRequestId: confirm.row.id,
        reason: confirm.reason,
        alwaysAllow: confirm.alwaysAllow,
      });
    } else {
      await performReject(confirm.row, confirm.reason);
    }
  }

  const pendingCount = pendingRows.length;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: '工作 Work', href: hrefs.chats() }, { label: '待我审批 Approvals' }]}
        title="待我审批 Approvals"
        description="Worker 在你的授权范围内提出的执行类动作；批准后由门执行。 Execute-class actions Workers proposed within your scope. Approving lets the Gatekeeper run them."
        actions={
          filter === 'pending' ? (
            <Button
              variant="ghost"
              icon="refresh"
              onClick={() => void pending.reload()}
              loading={pending.state.status === 'ready' && pending.state.refreshing}
            >
              刷新 Refresh
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
            { value: 'pending', label: '待处理 Pending', count: pendingCount },
            { value: 'history', label: '历史 History' },
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
              title="审批需要 operator 角色 Approvals need the operator role"
              body="当前主体不能调用 list_pending；请工作区 owner 授予 operator 角色。 Your principal cannot call list_pending. Ask the workspace owner for an operator-role principal to approve actions."
              testId="approvals-forbidden"
            />
          ) : (
            <ErrorBanner
              error={pending.state.error}
              title="无法加载审批队列 Could not load approvals"
              onRetry={() => void pending.reload()}
              testId="approvals-error"
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            icon="approvals"
            title="没有等待你审批的请求 Nothing pending your approval"
            body="Worker 提出策略路由给你的执行类动作时，请求会立刻出现在这里。 Requests appear here the moment a Worker proposes an execute-class action that policy routes to you."
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
                          <span className="text-3">代表 for</span>
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
                          <span className="text-danger">阻塞 Worker blocking a Worker</span>
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
        onClose={closeDetail}
        title={selectedRow ? humanizeKind(selectedRow.actionKindTag) : '审批请求 Approval request'}
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
          />
        ) : detailError ? (
          <ErrorBanner error={detailError} title="无法加载该请求 Could not load this request" />
        ) : (
          <SkeletonRows count={2} label="Loading request" />
        )}
      </Drawer>

      <ConfirmTier
        tier="high"
        open={confirm !== null}
        title={
          confirm?.kind === 'reject'
            ? `拒绝 Reject · ${confirm ? humanizeKind(confirm.row.actionKindTag) : ''}`
            : `批准高影响动作 Approve a high-impact action · ${confirm ? humanizeKind(confirm.row.actionKindTag) : ''}`
        }
        description={
          confirm?.kind === 'reject'
            ? '拒绝后 Worker 不会执行该动作；请求进入历史，理由写入审计。 The Worker will not run this action; the request moves to History and the reason is audited.'
            : '批准后门立即执行该动作，无法撤回；理由写入审计。 The Gatekeeper executes this immediately after approval; it cannot be recalled. The reason is audited.'
        }
        target={confirm ? (confirm.row.resourceScope ?? confirm.row.actionKindTag) : undefined}
        impact={confirm ? confirmImpact(confirm, principalNames, gatekeeperNames) : undefined}
        confirmLabel={confirm?.kind === 'reject' ? '确认拒绝 Reject' : '确认批准 Approve'}
        danger={confirm?.kind === 'reject' || confirm?.row.blastRadius === 'high'}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
        testId="approval-confirm"
      >
        {confirm ? (
          <dl className="definition-list">
            <dt>请求 Request</dt>
            <dd>
              <RefChip kind="actionRequest" id={confirm.row.id} name={null} size="s" />
            </dd>
            <dt>理由 Reason</dt>
            <dd className="pre-wrap" data-testid="approval-confirm-reason">
              {confirm.reason ?? <span className="text-3">（无 none）</span>}
            </dd>
            {confirm.alwaysAllow ? (
              <>
                <dt>总是允许 Always allow</dt>
                <dd>
                  <code>{confirm.row.actionKindTag}</code> 今后自动批准 will be auto-approved
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </ConfirmTier>
    </div>
  );
}

/** The `ConfirmTier` impact lines (§5.8 "Approve 高影响时确认文案列出目标资源"). */
function confirmImpact(
  confirm: PendingConfirm,
  principalNames: ReadonlyMap<string, string>,
  gatekeeperNames: ReadonlyMap<string, string>,
): readonly string[] {
  const { row } = confirm;
  const lines: string[] = [
    `动作 Action: ${row.actionKindTag}`,
    `目标资源 Target: ${row.resourceScope ?? '未限定 (no resource scope)'}`,
    `门 Gatekeeper: ${gatekeeperNames.get(row.gatekeeperId) ?? row.gatekeeperId}`,
    `影响范围 Blast radius: ${BLAST_LABEL[row.blastRadius] ?? row.blastRadius}`,
  ];
  if (row.onBehalfOf) {
    lines.push(`代表 On behalf of: ${principalNames.get(row.onBehalfOf) ?? row.onBehalfOf}`);
  }
  if (row.awaitDecision) {
    lines.push(
      confirm.kind === 'approve'
        ? '被阻塞的 Worker 将继续运行 The blocked Worker resumes'
        : '被阻塞的 Worker 将收到拒绝 The blocked Worker is told no',
    );
  }
  return lines;
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
        <Field id="approval-history-status" label="状态 Status">
          <Select
            id="approval-history-status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}
          >
            <option value="all">全部 All statuses</option>
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
          刷新 Refresh
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
            title="审批历史需要 operator 角色 Approval history needs the operator role"
            body="当前主体不能调用 list_action_requests。 Your principal cannot call list_action_requests. Ask the workspace owner for an operator-role principal."
            testId="approval-history-forbidden"
          />
        ) : (
          <ErrorBanner
            error={history.state.error}
            title="无法加载审批历史 Could not load approval history"
            onRetry={() => void history.reload()}
            testId="approval-history-error"
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon="approvals"
          title="还没有审批历史 No approval history yet"
          body="已决定、已执行的请求会出现在这里。 Decided and executed ActionRequests will appear here."
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
                          <span className="text-3">代表 for</span>
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
                        请求 requested {formatRelative(row.requestedAt)}
                      </time>
                      {decidedBy ? (
                        <>
                          <span className="meta-sep" />
                          <span className="text-3">决定 decided by</span>
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
                            执行 executed {formatRelative(row.executedAt)}
                          </time>
                        </>
                      ) : row.failedAt ? (
                        <>
                          <span className="meta-sep" />
                          <time className="text-danger" title={formatDateTime(row.failedAt)}>
                            失败 failed {formatRelative(row.failedAt)}
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
                加载更多 Load more
              </Button>
            </div>
          ) : null}
          {history.loadMoreError !== null ? (
            <ErrorBanner
              error={history.loadMoreError}
              title="无法加载更多审批历史 Could not load more approval history"
              testId="approval-history-load-more-error"
            />
          ) : null}
        </>
      )}
    </div>
  );
}
