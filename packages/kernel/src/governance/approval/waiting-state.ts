import { clipCodePoints, visibleText } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { redactSuspectedSecrets } from '../redaction/index.js';
import { ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION } from './execution.js';
import type { ActionRequestRow } from './types.js';

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
 *   - Queued behind: an `approved` / `auto_approved` row that has not run because an earlier row
 *     on the same Gatekeeper stops the queue (`drainer.ts`: a `pending_approval` row awaiting a
 *     human, or an `executing` one — R-50's barrier, often in doubt). Only the blocking row's status
 *     and whether it is in doubt are given, never its id or content: the caller may not be allowed
 *     to see that row (I14), only that something ahead of theirs holds the queue.
 *
 * Both are derived on read, never stored on the row: the audit row is the record (I11), and the
 * queue position changes with every transition on the Gatekeeper.
 */

export interface ActionRequestInDoubt {
  /** When the first `gate/apply` without an answer was recorded. */
  readonly since: Date;
  /** The kernel's reason, as audited (`reasonAuditFields`); `null` if the audit row has none. */
  readonly reason: string | null;
}

/** The earliest row ahead of a waiting one on its Gatekeeper that the drain stops at. */
export interface ActionRequestQueueBlocker {
  readonly id: string;
  readonly status: 'pending_approval' | 'executing';
}

/** Keyed by ActionRequest id: the in-doubt record of each of `ids` that has one. Empty input
 *  short-circuits without a round trip. Callers pass only rows that are `executing` — the audit
 *  row stays after the row is resolved. */
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
     order by resource_id, created_at asc`,
    [workspaceId, ACTION_REQUEST_IN_DOUBT_AUDIT_ACTION, unique],
  );
  return new Map(
    result.rows.map((row) => [
      row.resource_id,
      {
        since: row.created_at,
        // Written through `reasonAuditFields` already; read back through the same rule as
        // `readTerminalOutcome` applies to a terminal reason, so this read never shows more.
        reason:
          typeof row.reason === 'string'
            ? (redactSuspectedSecrets(row.reason, { secretFields: true }).value as string)
            : null,
      },
    ]),
  );
}

/** Keyed by ActionRequest id: for each of `waitingIds` (callers pass `approved` /
 *  `auto_approved` rows), the earliest `pending_approval` / `executing` row on its Gatekeeper
 *  ordered before it — `listExecutableQueue`'s order, `(requested_at, id)` — when there is one. */
export async function readQueueBlockers(
  client: PoolClient,
  workspaceId: string,
  waitingIds: readonly string[],
): Promise<ReadonlyMap<string, ActionRequestQueueBlocker>> {
  const unique = [...new Set(waitingIds)];
  if (unique.length === 0) return new Map();
  const result = await client.query<{
    waiting_id: string;
    id: string;
    status: ActionRequestQueueBlocker['status'];
  }>(
    `select waiting.id as waiting_id, blocker.id, blocker.status
     from action_requests waiting
     cross join lateral (
       select ahead.id, ahead.status from action_requests ahead
       where ahead.workspace_id = waiting.workspace_id
         and ahead.gatekeeper_id = waiting.gatekeeper_id
         and ahead.status in ('pending_approval', 'executing')
         and (ahead.requested_at, ahead.id) < (waiting.requested_at, waiting.id)
       order by ahead.requested_at asc, ahead.id asc
       limit 1
     ) blocker
     where waiting.workspace_id = $1 and waiting.id = any($2::uuid[])`,
    [workspaceId, unique],
  );
  return new Map(result.rows.map((row) => [row.waiting_id, { id: row.id, status: row.status }]));
}

/** What the wire projection says about one row (`ActionRequestWireSchema.outcomeInDoubt` /
 *  `queuedBehind`). */
export interface ActionRequestWaitingState {
  readonly outcomeInDoubt: { readonly since: string; readonly reason: string | null } | null;
  readonly queuedBehind: {
    readonly status: ActionRequestQueueBlocker['status'];
    readonly outcomeInDoubt: boolean;
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
            ? { status: blocker.status, outcomeInDoubt: inDoubt.has(blocker.id) }
            : null,
        },
      ];
    }),
  );
}

/** The most code points of a failure reason the wire carries (legacy 329): enough for a gate's or a
 *  target system's error sentence, never a whole response body. */
export const FAILURE_REASON_MAX = 1000;

/**
 * Legacy 329: why each `failed` / `compensated` row of `rows` failed —
 * the reason the kernel audited with `action_request.fail` (`markActionRequestFailed`, written
 * through `reasonAuditFields`), the newest one per row. Read back through the same redaction as
 * `readActionRequestsInDoubt`, then made safe to show: clipped to {@link FAILURE_REASON_MAX} code
 * points, and every character a reader cannot see (a bidi override, a zero-width or control
 * character) shown as `\u{XXXX}`; line breaks stay. Derived on read, like the waiting state: the
 * audit row is the record (I11). Keyed by row id; a row with no audited reason is absent.
 * `truncated` (legacy 340): the shown text is the head of a longer reason, whose whole lives in
 * the audit record.
 */
export interface ActionRequestFailureReason {
  readonly text: string;
  readonly truncated: boolean;
}

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
     order by resource_id, created_at desc`,
    [workspaceId, ids],
  );
  const reasons = new Map<string, ActionRequestFailureReason>();
  for (const row of result.rows) {
    if (typeof row.reason !== 'string' || row.reason.trim() === '') continue;
    const redacted = redactSuspectedSecrets(row.reason, { secretFields: true }).value as string;
    reasons.set(row.resource_id, {
      text: shownReason(redacted),
      truncated: [...redacted].length > FAILURE_REASON_MAX,
    });
  }
  return reasons;
}

/** Clipped, with unseen characters made visible line by line, so a line break still reads as one. */
function shownReason(reason: string): string {
  return clipCodePoints(reason, FAILURE_REASON_MAX)
    .split('\n')
    .map((line) => visibleText(line.replace(/\r$/, '')))
    .join('\n');
}
