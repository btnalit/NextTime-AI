import {
  type ActionRequestStatus,
  type ActionTarget,
  actionTargetsConflict,
} from '@nexttime/shared';

/**
 * governance/approval/queue (S11 GO12, docs/goal-orchestration-and-admin-agent-plan-2026-10-16.md
 * §4.10; the shared plan s11-w2/go12-default-plan.md): what may run next on one Gatekeeper, and
 * what holds back each request that may not. One pure function, read by the drainer (`next`) and
 * by the waiting state shown to people and agents (`holds`), so the two never tell it apart.
 *
 * I-Q1 (R-50 / D-10, narrowed to what conflicts): two requests of one Gatekeeper, a ordered before
 * b, that conflict — either acts on the whole Gatekeeper (`target` null), or both act on the same
 * instance (`actionTargetsConflict`) — b does not start before a is terminal. So a request may
 * start only when no earlier request in the queue conflicts with it: every row the queue holds is
 * not terminal (`listExecutableQueue`). Rows that declare no target conflict with every row, so a
 * queue of them runs exactly as before GO12: one at a time, in order, stopping at the first one
 * awaiting approval or executing.
 *
 * The order is read from the database, not kept by this function: an `executing` row stays in
 * the queue until it is terminal, and `startActionRequestExecution`'s conditional update lets one
 * trigger start a given row. A drain that read the queue before another trigger started an
 * earlier conflicting row picks that earlier row, never one behind it. One gap is older than GO12
 * and still open (review #493 on #876, in the STATUS legacy list): `requested_at` is the inserting
 * transaction's start time, so a row can commit after a later-stamped conflicting row has already
 * started; the next read plans it *ahead* of that `executing` row, and a second trigger can run
 * the two together. Closing it takes a check where a row enters `executing`, not this function.
 */

/** A row of one Gatekeeper's queue, in `listExecutableQueue`'s order — `auto_approved`,
 *  `approved`, `pending_approval` or `executing`; a row in any other status is not in the queue
 *  and is passed over. */
export interface QueueEntry {
  readonly id: string;
  readonly status: ActionRequestStatus;
  readonly target: ActionTarget | null;
}

/** What an approved row waits for, when a row that is not approved holds it back. */
export interface QueueHold {
  /** The row awaiting approval or executing that holds it back — directly, or through approved
   *  rows it holds back in turn. */
  readonly root: { readonly id: string; readonly status: 'pending_approval' | 'executing' };
  /** `target`: the row and everything between it and `root` act on one and the same instance;
   *  `gate`: the row itself, `root`, or a row in between acts on the whole Gatekeeper. */
  readonly scope: 'target' | 'gate';
}

export interface QueuePlan<T extends QueueEntry> {
  /** The first approved row no earlier row conflicts with — what to start now; `null` when none
   *  may start. */
  readonly next: T | null;
  /** By row id, for every approved row held back by a row awaiting approval or executing. An
   *  approved row that is neither `next` nor here waits only for earlier approved rows to run. */
  readonly holds: ReadonlyMap<string, QueueHold>;
}

/** Plans one Gatekeeper's queue (`rows` in `listExecutableQueue`'s order: `requested_at`, `id`). */
export function planGatekeeperQueue<T extends QueueEntry>(rows: readonly T[]): QueuePlan<T> {
  let next: T | null = null;
  const holds = new Map<string, QueueHold>();
  const queued = rows.filter((row) => QUEUED.has(row.status));
  queued.forEach((row, index) => {
    if (row.status === 'pending_approval' || row.status === 'executing') {
      holds.set(row.id, {
        root: { id: row.id, status: row.status },
        scope: row.target === null ? 'gate' : 'target',
      });
      return;
    }
    let conflicts = false;
    let hold: QueueHold | undefined;
    for (const earlier of queued.slice(0, index)) {
      if (!actionTargetsConflict(earlier.target, row.target)) continue;
      conflicts = true;
      const held = holds.get(earlier.id);
      if (held === undefined) continue;
      hold = {
        root: held.root,
        scope: row.target === null || held.scope === 'gate' ? 'gate' : 'target',
      };
      break;
    }
    if (hold !== undefined) holds.set(row.id, hold);
    else if (!conflicts && next === null) next = row;
  });
  // The rows awaiting approval or executing are in `holds` only to pass their hold on; the map
  // says what holds back an approved row.
  for (const row of queued) {
    if (row.status === 'pending_approval' || row.status === 'executing') holds.delete(row.id);
  }
  return { next, holds };
}

const QUEUED: ReadonlySet<ActionRequestStatus> = new Set([
  'auto_approved',
  'approved',
  'pending_approval',
  'executing',
]);
