import { useCallback, useEffect, useState } from 'react';
import { type ActionRequestRowLike, actionCardFromRow } from '../lib/action-card.js';
import { errorMessage } from '../lib/errors.js';
import type { HttpClient } from '../lib/http-client.js';
import type { WsClient } from '../lib/ws-client.js';
import { ActionRequestCard } from './ActionRequestCard.js';
import { NavBar } from './NavBar.js';

export interface ApprovalQueuePageProps {
  readonly httpClient: HttpClient;
  readonly wsClient: WsClient;
  readonly onForgetKey: () => void;
}

interface CardCallState {
  readonly busy: boolean;
  readonly error: string | null;
}

const IDLE_CARD_STATE: CardCallState = { busy: false, error: null };

/**
 * components/ApprovalQueuePage: `list_pending` — the caller's own I14-scoped queue (design doc
 * §7.6, §8.5; docs/development-tasks.md S2.10 deliverable 3: "approval queue view ... refreshes on
 * action.pending/action.updated"). Every row here is always `isHolder: true` (§9.3 "list_pending
 * returns ActionRequests pending the caller's own approval") — this page never renders the
 * status-only variant `ActionRequestCard` supports for a requester who is not a holder.
 */
export function ApprovalQueuePage({ httpClient, wsClient, onForgetKey }: ApprovalQueuePageProps) {
  const [rows, setRows] = useState<readonly ActionRequestRowLike[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cardState, setCardState] = useState<Readonly<Record<string, CardCallState>>>({});

  const refresh = useCallback(async () => {
    try {
      const result = await httpClient.call<readonly ActionRequestRowLike[]>('list_pending');
      setRows(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [httpClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubPending = wsClient.onActionPending(() => void refresh());
    const unsubUpdated = wsClient.onActionUpdated(() => void refresh());
    return () => {
      unsubPending();
      unsubUpdated();
    };
  }, [wsClient, refresh]);

  function setCardBusy(actionRequestId: string, busy: boolean): void {
    setCardState((prev) => ({
      ...prev,
      [actionRequestId]: { busy, error: prev[actionRequestId]?.error ?? null },
    }));
  }

  function setCardError(actionRequestId: string, error: string | null): void {
    setCardState((prev) => ({ ...prev, [actionRequestId]: { busy: false, error } }));
  }

  async function handleApprove(actionRequestId: string): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      await httpClient.call('approve', { actionRequestId });
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
      await refresh();
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  async function handleReject(actionRequestId: string, reason: string | undefined): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      await httpClient.call('reject', {
        actionRequestId,
        ...(reason !== undefined ? { reason } : {}),
      });
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
      await refresh();
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  async function handleAlwaysApprove(actionRequestId: string, actionKind: string): Promise<void> {
    setCardBusy(actionRequestId, true);
    try {
      await httpClient.call('set_auto_approved_action_kind', { actionKind });
      setCardState((prev) => ({ ...prev, [actionRequestId]: IDLE_CARD_STATE }));
    } catch (err) {
      setCardError(actionRequestId, errorMessage(err));
    }
  }

  return (
    <div className="page">
      <NavBar active="approvals" />
      <header className="page-header">
        <h1>Approvals</h1>
        <div className="header-actions">
          <button type="button" className="secondary" onClick={onForgetKey}>
            Forget key
          </button>
        </div>
      </header>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}

      {rows === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint">Nothing pending your approval.</p>
      ) : (
        <ul className="approval-queue-list">
          {rows.map((row) => {
            const state = cardState[row.id] ?? IDLE_CARD_STATE;
            return (
              <li key={row.id}>
                <ActionRequestCard
                  card={actionCardFromRow(row)}
                  busy={state.busy}
                  error={state.error}
                  onApprove={(id) => void handleApprove(id)}
                  onReject={(id, reason) => void handleReject(id, reason)}
                  onAlwaysApprove={(actionKind) => void handleAlwaysApprove(row.id, actionKind)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
