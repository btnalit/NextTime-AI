import type { PoolClient } from 'pg';
import { ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION } from './execution.js';
import { type QueueHold, planGatekeeperQueue } from './queue.js';
import {
  type ShownAuditReason,
  shownAuditReason,
  shownAuditReasonWithTruncation,
} from './shown-reason.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/waiting-state (legacy 287, review of #586): why an ActionRequest that has not
 * finished is still waiting — read for the wire projection (`application/gateway/handlers.ts`,
 * `request-action-handler.ts`), so the console and an agent can say so instead of showing a bare
 * "running" or "approved".
 *
 *   - Outcome in doubt: an `executing` row whose `gate/apply` got no answer (the connection broke
 *     after the request may have been sent, a timeout, an answer that is not the gate's protocol)
 *     — `recordActionRequestInDoubt` wrote an `action_request.outcome_in_doubt` audit row with the
 *     reason, and the stale-executing reaper asks the gate (`gate/apply_lookup`) once the row is
 *     past `DEFAULT_STALE_EXECUTING_TIMEOUT_MS`.
 *   - Queued behind: an `approved` / `auto_approved` row that has not run because another row on
 *     the same Gatekeeper it conflicts with holds it back (`drainer.ts`): a `pending_approval` row
 *     ahead of it awaiting a human, directly or through rows in between (S11 GO12, `queue.ts`), or
 *     an `executing` one — R-50's barrier, often in doubt — usually ahead of it, but behind it when
 *     that one started before this row's request committed (STATUS legacy 565: mutual exclusion,
 *     not `requested_at` order). Only the blocking row's status, whether it is in doubt and whether
 *     it holds this row back on its instance or on the whole Gatekeeper are given, never its id or
 *     content: the caller may not be allowed to see that row (I14), only that something holds
 *     theirs back.
 *
 * Both are derived on read, never stored on the row: the audit row is the record (I11), and the
 * queue position changes with every transition on the Gatekeeper.
 */

export interface ActionRequestInDoubt {
  /** When the first `gate/apply` without an answer was recorded. */
  readonly since: Date;
  /** The kernel's reason, as audited (`reasonAuditFields`) and shown (`shownAuditReason`): redacted,
   *  clipped, unseen characters made visible. `null` if the audit row has none. */
  readonly reason: string | null;
}

/** The row on a waiting one's Gatekeeper that holds it back (`QueueHold.root`: one ahead of it, or
 *  an `executing` one behind it — legacy 565), and whether on its instance or on the whole
 *  Gatekeeper (`QueueHold.scope`). */
export interface ActionRequestQueueBlocker {
  readonly id: string;
  readonly status: 'pending_approval' | 'executing';
  readonly scope: QueueHold['scope'];
}

/** Keyed by ActionRequest id: the in-doubt record of each of `ids` that has one. Empty input
 *  short-circuits without a round trip. Callers pass only rows that are `executing` — the audit
 *  row stays after the row is resolved. Two records written in one transaction share
 *  `created_at` (`now()`), so `id` breaks the tie: the same row is picked on every read (legacy
 *  340). */
export async function readActionRequestsInDoubt(
  client: PoolClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ActionRequestInDoubt>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const result = await client.query<{ resource_id: string; created_at: Date; reason: unknown }>(
    `select distinct on (resource_id) resource_id, created_at, payload -> 'reason' as reason
     from audit_records
     where workspace_id = $1 and resource_type = 'action_request' and action = $2
       and resource_id = any($3::uuid[])
     order by resource_id, created_at asc, id asc`,
    [workspaceId, ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION, unique],
  );
  return new Map(
    result.rows.map((row) => [
      row.resource_id,
      // Legacy 338: the same rule as a failure reason and `readTerminalOutcome`'s, so this read
      // never shows more, nor shows it differently.
      { since: row.created_at, reason: shownAuditReason(row.reason) },
    ]),
  );
}

/** Keyed by ActionRequest id: for each of `waitingIds` (callers pass `approved` /
 *  `auto_approved` rows) that a row awaiting approval or executing holds back, that row — as
 *  `planGatekeeperQueue` plans the queue of its Gatekeeper, the one the drainer runs by, so what a
 *  reader is told waits is what the drain waits for. A waiting row absent from the map is held back
 *  by nothing but earlier approved rows, or runs next. One query for the queues of every Gatekeeper
 *  the rows are on. */
export async function readQueueBlockers(
  client: PoolClient,
  workspaceId: string,
  waitingIds: readonly string[],
): Promise<ReadonlyMap<string, ActionRequestQueueBlocker>> {
  const unique = [...new Set(waitingIds)];
  if (unique.length === 0) return new Map();
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
     where workspace_id = $1
       and gatekeeper_id in (
         select gatekeeper_id from action_requests where workspace_id = $1 and id = any($2::uuid[])
       )
       and status in ('auto_approved', 'approved', 'pending_approval', 'executing')
     order by gatekeeper_id, requested_at asc, id asc`,
    [workspaceId, unique],
  );
  const queues = new Map<string, ActionRequestRow[]>();
  for (const row of result.rows.map(mapActionRequestRow)) {
    const queue = queues.get(row.gatekeeperId);
    if (queue) queue.push(row);
    else queues.set(row.gatekeeperId, [row]);
  }
  const wanted = new Set(unique);
  const blockers = new Map<string, ActionRequestQueueBlocker>();
  for (const queue of queues.values()) {
    for (const [id, hold] of planGatekeeperQueue(queue).holds) {
      if (wanted.has(id)) blockers.set(id, { ...hold.root, scope: hold.scope });
    }
  }
  return blockers;
}

/** What the wire projection says about one row (`ActionRequestWireSchema.outcomeInDoubt` /
 *  `queuedBehind`). */
export interface ActionRequestWaitingState {
  readonly outcomeInDoubt: { readonly since: string; readonly reason: string | null } | null;
  readonly queuedBehind: {
    readonly status: ActionRequestQueueBlocker['status'];
    readonly outcomeInDoubt: boolean;
    readonly scope: ActionRequestQueueBlocker['scope'];
  } | null;
}

/** `readActionRequestsInDoubt` + `readQueueBlockers` for a page of rows, in at most three round
 *  trips; keyed by row id, one entry per row. */
export async function readActionRequestWaitingStates(
  client: PoolClient,
  workspaceId: string,
  rows: readonly Pick<ActionRequestRow, 'id' | 'status'>[],
): Promise<ReadonlyMap<string, ActionRequestWaitingState>> {
  const executingIds = rows.filter((row) => row.status === 'executing').map((row) => row.id);
  const waitingIds = rows
    .filter((row) => row.status === 'approved' || row.status === 'auto_approved')
    .map((row) => row.id);
  const blockers = await readQueueBlockers(client, workspaceId, waitingIds);
  const inDoubt = await readActionRequestsInDoubt(client, workspaceId, [
    ...executingIds,
    ...[...blockers.values()]
      .filter((blocker) => blocker.status === 'executing')
      .map((blocker) => blocker.id),
  ]);
  return new Map(
    rows.map((row) => {
      const doubt = row.status === 'executing' ? inDoubt.get(row.id) : undefined;
      const blocker = blockers.get(row.id);
      return [
        row.id,
        {
          outcomeInDoubt: doubt ? { since: doubt.since.toISOString(), reason: doubt.reason } : null,
          queuedBehind: blocker
            ? {
                status: blocker.status,
                outcomeInDoubt: inDoubt.has(blocker.id),
                scope: blocker.scope,
              }
            : null,
        },
      ];
    }),
  );
}

/**
 * Legacy 329: why each `failed` / `compensated` row of `rows` failed —
 * the reason the kernel audited with `action_request.fail` (`markActionRequestFailed`, written
 * through `reasonAuditFields`), the newest one per row, as `shownAuditReason` shows it: redacted,
 * clipped, every character a reader cannot see shown as `\u{XXXX}`, line breaks kept. Derived on
 * read, like the waiting state: the audit row is the record (I11). Keyed by row id; a row with no
 * audited reason is absent. `truncated` (legacy 339) comes out of the same call as the text.
 * Records sharing `created_at` (one transaction's `now()`) are ordered by `id`, so every read
 * shows the same one (legacy 340, review #493 on #609).
 */
export type ActionRequestFailureReason = ShownAuditReason;

export async function readActionRequestFailureReasons(
  client: PoolClient,
  workspaceId: string,
  rows: readonly Pick<ActionRequestRow, 'id' | 'status'>[],
): Promise<ReadonlyMap<string, ActionRequestFailureReason>> {
  const ids = [
    ...new Set(
      rows
        .filter((row) => row.status === 'failed' || row.status === 'compensated')
        .map((row) => row.id),
    ),
  ];
  if (ids.length === 0) return new Map();
  const result = await client.query<{ resource_id: string; reason: unknown }>(
    `select distinct on (resource_id) resource_id, payload -> 'reason' as reason
     from audit_records
     where workspace_id = $1 and resource_type = 'action_request' and action = 'action_request.fail'
       and resource_id = any($2::uuid[])
     order by resource_id, created_at desc, id desc`,
    [workspaceId, ids],
  );
  const reasons = new Map<string, ActionRequestFailureReason>();
  for (const row of result.rows) {
    const reason = shownAuditReasonWithTruncation(row.reason);
    if (reason !== null) reasons.set(row.resource_id, reason);
  }
  return reasons;
}
