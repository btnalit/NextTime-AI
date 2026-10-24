import type { GoalDetailWire } from '@nexttime/shared';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import type { Translate } from '../../lib/i18n.js';

/** One goal as this chat read it with `get_goal` (masked like every read). */
export type ChatGoalRead =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly goal: GoalDetailWire }
  | { readonly status: 'error'; readonly error: unknown };

/**
 * components/chat/useChatGoals (S11 GO5e-2, #737 UX P2-2): the goals a chat's messages are about,
 * each read once with `get_goal` however many lines name it — the proposal card shows the goal, and
 * every milestone line and goal-step line says which goal it belongs to. A goal is read when the
 * chat first names it; later milestones say how it moved on, so it is not read again.
 */
export function useChatGoals(
  http: CapabilityCaller,
  goalRunIds: readonly string[],
): ReadonlyMap<string, ChatGoalRead> {
  const [reads, setReads] = useState<ReadonlyMap<string, ChatGoalRead>>(() => new Map());
  const requested = useRef<{ http: CapabilityCaller; ids: Set<string> }>({ http, ids: new Set() });
  const key = goalRunIds.join(',');

  useEffect(() => {
    // Another session's caller reads afresh: what this one could see says nothing for the next.
    if (requested.current.http !== http) {
      requested.current = { http, ids: new Set() };
      setReads(new Map());
    }
    const asked = requested.current.ids;
    const set = (goalRunId: string, read: ChatGoalRead) => {
      if (requested.current.http !== http) return;
      setReads((prev) => new Map(prev).set(goalRunId, read));
    };
    for (const goalRunId of key === '' ? [] : key.split(',')) {
      if (asked.has(goalRunId)) continue;
      asked.add(goalRunId);
      set(goalRunId, { status: 'loading' });
      http.call<GoalDetailWire>('get_goal', { goalRunId }).then(
        (goal) => set(goalRunId, { status: 'ready', goal }),
        (error: unknown) => set(goalRunId, { status: 'error', error }),
      );
    }
  }, [http, key]);

  return reads;
}

/** Which goal a line is about, on one line: its statement (whitespace folded), or that it cannot
 *  be read; `null` while the read is on its way. */
export function chatGoalLabel(read: ChatGoalRead | undefined, t: Translate): string | null {
  if (read === undefined || read.status === 'loading') return null;
  if (read.status === 'error') return t('一个读不到的目标', 'a goal that cannot be read');
  const statement = read.goal.statement.replace(/\s+/g, ' ').trim();
  return statement === '' ? t('（没有目标陈述）', '(no statement)') : statement;
}
