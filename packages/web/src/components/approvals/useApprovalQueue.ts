import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Permissions } from '../../hooks/usePermissions.js';
import { type Resource, useResource } from '../../hooks/useResource.js';
import type { CapabilityCaller, PushSource } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { humanizeKind } from '../../lib/format.js';
import type { ActionRequestRow } from '../../lib/governance.js';
import type { Translate } from '../../lib/i18n.js';
import type { ApprovalDecisionInput, PendingConfirm } from './ApprovalDetail.js';

/** The minimum shape `useApprovalQueue` needs from `useToast()` — kept local (not `ToastApi` from
 *  `components/ui/Toast`) so this file imports nothing from `components/ui/*`
 *  (S8 §5e risk ①, `scripts/guards/css-tokens.mjs`). Structurally compatible with the real
 *  `ToastApi`, so passing it straight through from `ApprovalQueuePage` needs no adapter. */
export interface ToastPusher {
  readonly push: (input: {
    readonly tone?: 'info' | 'ok' | 'warn' | 'danger';
    readonly title: string;
    readonly description?: string;
  }) => number;
}

interface DecisionState {
  readonly busy: boolean;
  readonly error: unknown | null;
}

const IDLE: DecisionState = { busy: false, error: null };

function byNewest(a: ActionRequestRow, b: ActionRequestRow): number {
  return (b.requestedAt ?? '').localeCompare(a.requestedAt ?? '');
}

export interface ApprovalQueueState {
  readonly pending: Resource<readonly ActionRequestRow[]>;
  readonly rows: readonly ActionRequestRow[];
  readonly pendingCount: number;
  readonly forbidden: boolean;
  readonly selectedRow: ActionRequestRow | undefined;
  readonly detailError: unknown | null;
  readonly pendingConfirm: PendingConfirm | null;
  readonly setPendingConfirm: Dispatch<SetStateAction<PendingConfirm | null>>;
  readonly decision: Readonly<Record<string, DecisionState>>;
  readonly handleApprove: (input: ApprovalDecisionInput) => Promise<void>;
  readonly handleReject: (input: Omit<ApprovalDecisionInput, 'alwaysAllow'>) => Promise<void>;
}

/**
 * components/approvals/useApprovalQueue: `ApprovalQueuePage`'s own I14-scoped queue (`list_pending`,
 * design doc §7.6/§8.5) and decision handling — split out of the page itself (console redesign P1)
 * because none of it renders JSX and it does not need anything from `components/ui/*`. Live:
 * `action.pending` reloads the queue; `action.updated` moves the row out of Pending into the
 * session-local "decided" set immediately and reconciles that one row with `get_action` (C7: no
 * full `list_pending` reload on top — the push already names the row, and the queue itself only
 * ever loses rows on `action.updated`). Decisions are optimistic — the row leaves Pending on click
 * and comes back with the kernel's error if the call fails.
 *
 * S8 W1-A7: the drawer's own confirm state (`pendingConfirm`) is owned here rather than inside
 * `ApprovalDetail` — that component can remount mid-decision, and state kept there would be lost
 * when it does. Reset whenever the open request (`selectedId`) changes so a stale confirm from a
 * previous selection can never reopen against the wrong row.
 *
 * "History" (S5.5 leftover 21) is a separate, purely server-backed read — see
 * `ApprovalHistoryTab` in `ApprovalQueuePage.tsx` itself, which still needs `components/ui/*` for
 * its own rendering and so cannot move here.
 */
export function useApprovalQueue({
  http,
  pushes,
  selectedId,
  permissions,
  toast,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly pushes: PushSource;
  readonly selectedId: string | undefined;
  readonly permissions: Permissions;
  readonly toast: ToastPusher;
  readonly t: Translate;
}): ApprovalQueueState {
  const load = useCallback(
    () =>
      http.call<{ items: readonly ActionRequestRow[] }>('list_pending').then((page) => page.items),
    [http],
  );
  const pending = useResource(load);
  const [decided, setDecided] = useState<Readonly<Record<string, ActionRequestRow>>>({});
  const [decision, setDecision] = useState<Readonly<Record<string, DecisionState>>>({});
  const [fetchedDetail, setFetchedDetail] = useState<ActionRequestRow | null>(null);
  const [detailError, setDetailError] = useState<unknown | null>(null);
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
  // `selectedRow` fell all the way through to `undefined` and the page swapped in a skeleton,
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
   *  this hook only ever hands it the confirmed mutation, and always lets it throw: for a
   *  confirmed call `ApprovalDetail`'s own `runConfirm` re-throws into `Confirm`'s `onConfirm`,
   *  which shows the error inline and keeps the popover open; for the direct (no-confirm) path
   *  `ApprovalDetail` swallows the rejection itself (its own comment explains why) and relies on
   *  `decision[id].error` instead. */
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

  return {
    pending,
    rows,
    pendingCount,
    forbidden,
    selectedRow,
    detailError,
    pendingConfirm,
    setPendingConfirm,
    decision,
    handleApprove,
    handleReject,
  };
}

export { IDLE };
export type { DecisionState };
