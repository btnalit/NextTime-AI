import type { TurnAttributionWire, TurnStatus } from '@nexttime/shared';
import { useEffect, useMemo, useRef } from 'react';
import { type ListEnvelope, useCapability } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';

export interface TurnAttributions {
  /** Turn id → its attribution, for the newest {@link TURN_PAGE_LIMIT} Turns of the chat. */
  readonly byTurn: ReadonlyMap<string, TurnAttributionWire>;
  /** Replaces one Turn after a `mark_turn_outcome` result (no refetch round-trip). */
  readonly apply: (turn: TurnAttributionWire) => void;
}

/** `list_chat_turns`'s own max page. A chat longer than this shows the outcome control on its
 *  newest Turns only — older ones read 未记录 on the Task detail, never a wrong value. */
const TURN_PAGE_LIMIT = 500;

/**
 * components/chat/useTurnAttributions (S10 E1 结果归因): the per-Turn attribution of one chat —
 * the Procedure the entry agent said it followed and the requester's objective outcome
 * (`list_chat_turns`). Refetched whenever the live Turn's status changes (a Turn that just ended
 * becomes markable); a 403 (an auditor-less custom role, say) leaves the map empty, so no control
 * renders.
 */
export function useTurnAttributions(
  http: CapabilityCaller,
  chatId: string,
  liveTurnStatus: TurnStatus | 'idle' | string,
): TurnAttributions {
  const turns = useCapability<ListEnvelope<TurnAttributionWire>>(http, 'list_chat_turns', {
    chatId,
    limit: TURN_PAGE_LIMIT,
  });
  const reloadRef = useRef(turns.reload);
  reloadRef.current = turns.reload;
  const lastStatus = useRef(liveTurnStatus);
  useEffect(() => {
    if (lastStatus.current === liveTurnStatus) return;
    lastStatus.current = liveTurnStatus;
    void reloadRef.current();
  }, [liveTurnStatus]);

  const items = turns.state.status === 'ready' ? turns.state.data.items : undefined;
  const byTurn = useMemo(() => new Map((items ?? []).map((turn) => [turn.id, turn])), [items]);
  const mutateRef = useRef(turns.mutate);
  mutateRef.current = turns.mutate;
  const apply = useMemo(
    () => (turn: TurnAttributionWire) =>
      mutateRef.current((data) => ({
        ...data,
        items: data.items.map((existing) => (existing.id === turn.id ? turn : existing)),
      })),
    [],
  );
  return { byTurn, apply };
}
