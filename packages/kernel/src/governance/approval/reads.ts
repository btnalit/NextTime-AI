import type { Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { hasActiveGrant } from '../capability/index.js';
import {
  ACTION_REQUEST_ROW_COLUMNS,
  type ActionRequestDbRow,
  ActionRequestNotFoundError,
  type ActionRequestRow,
  mapActionRequestRow,
} from './types.js';

/**
 * governance/approval/reads: every read-only query `service.ts`/`drainer.ts` need (design doc §9.3
 * `list_pending`/`get_action`, §5.4 I14, S2.3 drain-queue ordering). Split out per the design doc's
 * file-size guidance.
 */

export async function getActionRequest(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and id = $2`,
    [workspaceId, actionRequestId],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

export async function findActionRequestByIdempotencyKey(
  client: PoolClient,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

/**
 * `list_pending` (§9.3, I14): the caller's own queue — the workspace owner sees every
 * `pending_approval` row; a non-owner sees only rows whose `action_kind`/`resource_scope` matches
 * one of their active `capability_grants` (a correlated `exists`, not an N+1 query per row).
 */
export async function listPendingForApprover(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
): Promise<readonly ActionRequestRow[]> {
  if (approver.role === 'owner') {
    const result = await client.query<ActionRequestDbRow>(
      `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
       where workspace_id = $1 and status = 'pending_approval'
       order by requested_at asc`,
      [workspaceId],
    );
    return result.rows.map(mapActionRequestRow);
  }

  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests ar
     where ar.workspace_id = $1
       and ar.status = 'pending_approval'
       and exists (
         select 1 from capability_grants cg
         where cg.workspace_id = ar.workspace_id
           and cg.principal_id = $2
           and cg.capability = ar.action_kind
           and cg.status = 'active'
           and (cg.expires_at is null or cg.expires_at > now())
           and (cg.scope ->> 'resourceScope' is null or cg.scope ->> 'resourceScope' = ar.resource_scope)
       )
     order by ar.requested_at asc`,
    [workspaceId, approver.principalId],
  );
  return result.rows.map(mapActionRequestRow);
}

/**
 * Every ActionRequest for one Gatekeeper not yet in a terminal/execution-started state
 * (`auto_approved`/`approved`/`pending_approval`), ascending `requested_at` — `drainer.ts`'s queue:
 * it processes `auto_approved`/`approved` rows and stops at the first `pending_approval` one, so a
 * later row never executes ahead of an earlier one still awaiting a human decision (design doc
 * S2.3 "drain 每 Gatekeeper 单飞、升序、遇 pending 停").
 */
export async function listExecutableQueue(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<readonly ActionRequestRow[]> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests
     where workspace_id = $1 and gatekeeper_id = $2
       and status in ('auto_approved', 'approved', 'pending_approval')
     order by requested_at asc`,
    [workspaceId, gatekeeperId],
  );
  return result.rows.map(mapActionRequestRow);
}

/** I14: the workspace owner counts as holding every scope; every other role must hold a matching
 *  active `capability_grants` row. Role gates *entry to the queue*
 *  (`application/gateway/authorize.ts`'s `minRole: 'operator'` on `approve`/`reject` — a `member`
 *  never reaches this function); this decides *which* pending ActionRequests that operator/owner
 *  may actually approve (§5.8 "角色 operator 只是进队列；能批哪条由 capability 范围决定"). */
export async function approverHasScope(
  client: PoolClient,
  workspaceId: string,
  approver: { readonly principalId: string; readonly role: Role },
  target: { readonly actionKind: string; readonly resourceScope: string | null },
): Promise<boolean> {
  if (approver.role === 'owner') return true;
  return hasActiveGrant(client, workspaceId, {
    principalId: approver.principalId,
    actionKind: target.actionKind,
    resourceScope: target.resourceScope,
  });
}

export async function getActionRequestOrThrow(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  const row = await getActionRequest(client, workspaceId, actionRequestId);
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return row;
}

/**
 * I6/I11 concurrency hardening: same read as `getActionRequest`, but takes `SELECT ... FOR UPDATE`
 * — a row-level lock held for the rest of the caller's transaction. Every governed transition that
 * mutates an *existing* row (`decide.ts`'s `approve`/`reject`, `execution.ts`'s `start_execution`/
 * `mark_executed`/`mark_failed`/`compensate`/`expire`) must read through this (or the null-tolerant
 * `expire` case, which locks first and then decides "not found" is a benign no-op rather than an
 * error) before computing its next status — never the lock-free `getActionRequest`/
 * `getActionRequestOrThrow` above. Locking here makes a second concurrent caller on the same row
 * block until the first commits, then see the *already-updated* status and fail at the ordinary
 * `transition()` table-lookup step (a plain `IllegalTransition`) instead of wastefully writing an
 * Approval Decision that the conditional UPDATE (`status-transition.ts`) would then discard.
 * `drainer.ts`'s per-Gatekeeper queue read (`listExecutableQueue` above) is deliberately excluded
 * — it only decides *what to process next*, never mutates a row itself.
 */
export async function getActionRequestForUpdate(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow | null> {
  const result = await client.query<ActionRequestDbRow>(
    `select ${ACTION_REQUEST_ROW_COLUMNS} from action_requests where workspace_id = $1 and id = $2 for update`,
    [workspaceId, actionRequestId],
  );
  const row = result.rows[0];
  return row ? mapActionRequestRow(row) : null;
}

export async function getActionRequestForUpdateOrThrow(
  client: PoolClient,
  workspaceId: string,
  actionRequestId: string,
): Promise<ActionRequestRow> {
  const row = await getActionRequestForUpdate(client, workspaceId, actionRequestId);
  if (!row) throw new ActionRequestNotFoundError(workspaceId, actionRequestId);
  return row;
}
