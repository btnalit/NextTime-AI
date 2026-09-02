import type { PoolLike } from '../../adapters/db/pool.js';
import { publishChatPushEvent } from './push.js';

/**
 * application/chat/recovery: kernel-restart Turn recovery (design doc §13 "内核重启：无内存态；扫描
 * executing 超时项与 running Turn"; docs/development-tasks.md S1.4 deliverable 7). On startup,
 * marks any `agent_turn` Activity still `status = 'running'` from *before* this process started —
 * i.e. left running by a kernel process that died or was killed mid-Turn, since the only writer
 * that ever sets `status = 'running'` (`application/chat`'s `sendChatMessage`) and the only
 * writers that ever move it out of `running` (`application/chat/event-sink.ts`'s `turnEnded`
 * handler; `application/gateway/handlers.ts`'s `report_turn`) are both this same kernel process —
 * as `interrupted`, and pushes `chat.metadata` so a client with that chat open right now finds out
 * immediately rather than only on its next `get_chat_history` read.
 *
 * Cross-workspace scan, same reasoning as `application/outbox/dispatcher.ts`: exactly one kernel
 * process, not one per workspace, so this deliberately never calls `withWorkspace()` — see that
 * module's own doc comment for the "superuser bypasses RLS by design" pattern this reuses.
 *
 * What "interrupted" means for the next Turn (documented per this task's deliverable — the
 * *injection* itself is S1.5+ scope): §13 says the next Turn's `context` should tell the entry
 * agent "the previous Turn was interrupted" so it can recover gracefully (e.g. re-check whether a
 * half-finished action actually completed) rather than silently continuing as if nothing happened.
 * S1's `get_entry_context` (application/gateway/handlers.ts) does not yet surface this — its S1
 * scope is `{pendingApprovals: [], tasks: [], facts, precedents: []}`, with no per-Turn
 * continuity field. Wiring "was my last Turn interrupted" into that context read (most naturally:
 * one more field alongside `facts`, populated by looking up the caller's most recent `agent_turn`
 * Activity and checking `status = 'interrupted'`) is left for S1.5, alongside the rest of the
 * "上轮中断" injection story described in §7.2.
 */

export const DEFAULT_STALE_TURN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface InterruptStaleRunningTurnsOptions {
  readonly pool: PoolLike;
  /** A `running` Turn older than this (by `activities.created_at`) is considered abandoned by a
   *  prior kernel process. Default `DEFAULT_STALE_TURN_TIMEOUT_MS` (15 minutes) — configurable per
   *  design doc S1.4 deliverable 7 ("configurable timeout"); the composition root reads
   *  `TURN_INTERRUPT_TIMEOUT_MS` from the environment (packages/kernel/src/index.ts). */
  readonly timeoutMs?: number;
}

interface InterruptedTurnRow {
  id: string;
  workspace_id: string;
  chat_id: string | null;
}

/**
 * Marks every stale `running` `agent_turn` Activity as `interrupted` and pushes `chat.metadata`
 * for each one that has a `chat_id` (every Turn does, in practice — see migrations/core/
 * 0008_chat_messages.sql's own note on why `chat_id` is nonetheless nullable on `activities` in
 * general). Resolves with the number of Turns interrupted. Intended to run once, at kernel
 * startup, before the outbox dispatcher and any request traffic begin — see `packages/kernel/src/
 * index.ts`'s `createBackgroundServices`.
 */
export async function interruptStaleRunningTurns(
  options: InterruptStaleRunningTurnsOptions,
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STALE_TURN_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<InterruptedTurnRow>(
      `update activities
       set status = 'interrupted', ended_at = now()
       where kind = 'agent_turn' and status = 'running' and created_at < $1::timestamptz
       returning id, workspace_id, chat_id`,
      [cutoff],
    );
    await client.query('COMMIT');

    for (const row of result.rows) {
      if (row.chat_id) {
        publishChatPushEvent({
          type: 'chat.metadata',
          chatId: row.chat_id,
          metadata: { turnId: row.id, turnStatus: 'interrupted' },
        });
      }
    }

    return result.rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Best-effort: the connection may already be unusable. The original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}
