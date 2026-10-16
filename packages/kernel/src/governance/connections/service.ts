import type { PrincipalKind } from '@nexttime/shared';
import { CONNECTION_REQUEST_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { CapabilityGrantRow } from '../../governance/capability/index.js';
import { grantCapability } from '../../governance/capability/index.js';
import { GatekeeperNotFoundError, getGatekeeper } from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import { redactedForAudit } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import { assertConnectionParamsCarryNoCredentials } from './credentials.js';
import {
  CONNECTION_REQUEST_ROW_COLUMNS,
  type ConnectionRequestKind,
  ConnectionRequestNotFoundError,
  type ConnectionRequestRow,
  mapConnectionRequestRow,
} from './types.js';

/**
 * governance/connections/service: `request_connection` → connection-request card →
 * `create_connection` → registered Gatekeeper → `connect_gatekeeper` Grant (design doc §5.1.4
 * Connection, §7.5 连接流程, §9.3; docs/development-tasks.md S2.13).
 *
 * **`complete_connection` naming crosswalk**: the S2.13 brief names the owner-facing completion
 * capability `complete_connection`; `packages/shared/src/capabilities.ts` already registered
 * `create_connection` for exactly this step (design doc §9.3's own name), so that capability's
 * params were extended additively instead of registering a competing name. The brief's
 * `complete_connection` and this repo's `create_connection` name the same thing.
 *
 * **What this module owns of a connection** (P0b): the `request_connection` card and its
 * lifecycle (`claimConnectionRequest` → `markConnectionRequestCompleted`, or
 * `cancelConnectionRequest`) and the `connect_gatekeeper` Grant. Landing the Gatekeeper itself —
 * registering it, importing its manifest, recording its origin — is the one landing path every way
 * into a workspace goes through (`application/gates/landing.ts`), which calls the two request
 * functions around its own writes.
 *
 * **Layering — this module does no network I/O** (`.dependency-cruiser.cjs`
 * `kernel-adapters-imported-only-by-application-or-interfaces`): the manifest fetch and the
 * credential POST to the gate happen in `application/gateway/connection-handlers.ts`.
 *
 * **Sibling-module calls, not internals**: `grantCapability` (`governance/capability`) is called
 * through its published service interface — the same pattern `governance/approval` uses for
 * `governance/policy`/`governance/capability` (§7.10 module contract: modules "互相调用公开接口，不
 * 互相读表").
 *
 * This module owns its own table (migrations/governance/0005_connection_requests.sql,
 * `connection_requests`) and exposes only this service interface.
 */

export interface RequestConnectionInput {
  readonly kind: ConnectionRequestKind;
  readonly target: string;
  readonly requestedBy: { readonly id: string; readonly kind: PrincipalKind };
}

/** `request_connection(kind, target)` — Handle channel, any member (design doc §7.5): inserts one
 *  `requested` ConnectionRequest row and emits `ConnectionRequested` so a future chat/linkage
 *  consumer can surface it as a card (this task does not add that consumer — out of scope, see PR
 *  body). */
export async function requestConnection(
  client: PoolClient,
  workspaceId: string,
  input: RequestConnectionInput,
): Promise<ConnectionRequestRow> {
  // Legacy 186: the target is stored, pushed and shown as given — never with a credential in it.
  assertConnectionParamsCarryNoCredentials('request_connection', { target: input.target });
  const result = await client.query(
    `insert into connection_requests (workspace_id, kind, target, requested_by)
     values ($1, $2, $3, $4)
     returning ${CONNECTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, input.kind, input.target, input.requestedBy.id],
  );
  const row = result.rows[0];
  if (!row) throw new Error('requestConnection: INSERT ... RETURNING produced no row');
  const mapped = mapConnectionRequestRow(row);

  await enqueue(client, {
    type: 'ConnectionRequested',
    workspaceId,
    connectionRequestId: mapped.id,
    kind: mapped.kind,
    target: mapped.target,
    requestedBy: mapped.requestedBy,
  });

  return mapped;
}

export async function getConnectionRequest(
  client: PoolClient,
  workspaceId: string,
  connectionRequestId: string,
): Promise<ConnectionRequestRow | null> {
  const result = await client.query(
    `select ${CONNECTION_REQUEST_ROW_COLUMNS} from connection_requests
     where workspace_id = $1 and id = $2`,
    [workspaceId, connectionRequestId],
  );
  const row = result.rows[0];
  return row ? mapConnectionRequestRow(row) : null;
}

export interface ListConnectionRequestsInput {
  readonly status?: ConnectionRequestRow['status'];
}

/** `list_connection_requests` — owner's queue (§9.3), newest first. */
export async function listConnectionRequests(
  client: PoolClient,
  workspaceId: string,
  input: ListConnectionRequestsInput = {},
): Promise<readonly ConnectionRequestRow[]> {
  const result = await client.query(
    `select ${CONNECTION_REQUEST_ROW_COLUMNS} from connection_requests
     where workspace_id = $1 and ($2::text is null or status = $2)
     order by requested_at desc`,
    [workspaceId, input.status ?? null],
  );
  return result.rows.map(mapConnectionRequestRow);
}

// -------------------------------------------------------------------------------------------
// The request half of `create_connection` (this repo's `complete_connection`, see module doc
// comment). Registering the Gatekeeper, importing its manifest and recording its origin is the one
// landing path (`application/gates/landing.ts`, P0b), which calls these two around its writes:
// `claimConnectionRequest` before anything is written, `markConnectionRequestCompleted` after the
// Gatekeeper exists — same transaction.
// -------------------------------------------------------------------------------------------

/**
 * Locks the `request_connection` card being resolved and checks it can still be completed (I6:
 * via `CONNECTION_REQUEST_TRANSITIONS`, throws `IllegalTransition` unless it is `requested`).
 * `for update`: two owners completing the same card concurrently must not both pass the check and
 * each land a Gatekeeper — the second blocks here until the first commits, then reads `completed`
 * and fails I6 (same row-lock discipline as governance/approval's `decide`). Runs before any write,
 * so a stale or replayed call never lands a second Gatekeeper.
 */
export async function claimConnectionRequest(
  client: PoolClient,
  workspaceId: string,
  connectionRequestId: string,
): Promise<ConnectionRequestRow> {
  const locked = await client.query(
    `select ${CONNECTION_REQUEST_ROW_COLUMNS} from connection_requests
     where workspace_id = $1 and id = $2
     for update`,
    [workspaceId, connectionRequestId],
  );
  const existing = locked.rows[0] ? mapConnectionRequestRow(locked.rows[0]) : null;
  if (!existing) {
    throw new ConnectionRequestNotFoundError(workspaceId, connectionRequestId);
  }
  transition(CONNECTION_REQUEST_TRANSITIONS, existing.status, 'complete');
  return existing;
}

/** Resolves a claimed card to `completed`, naming the Gatekeeper the landing registered. */
export async function markConnectionRequestCompleted(
  client: PoolClient,
  workspaceId: string,
  input: {
    readonly connectionRequestId: string;
    readonly gatekeeperId: string;
    readonly completedBy: string;
  },
): Promise<ConnectionRequestRow> {
  const result = await client.query(
    `update connection_requests
     set status = 'completed', gatekeeper_id = $3, completed_by = $4, completed_at = now()
     where workspace_id = $1 and id = $2 and status = 'requested'
     returning ${CONNECTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, input.connectionRequestId, input.gatekeeperId, input.completedBy],
  );
  const row = result.rows[0];
  // Unreachable while `claimConnectionRequest`'s row lock is held — kept as the conditional-UPDATE
  // belt to the lock's braces (governance/approval's status-transition.ts uses the same pair).
  if (!row) {
    throw new Error(
      'markConnectionRequestCompleted: connection request left `requested` under lock',
    );
  }
  return mapConnectionRequestRow(row);
}

// -------------------------------------------------------------------------------------------
// cancelConnectionRequest — `cancel_connection_request(connectionRequestId)` (S6-A C26,
// docs/console-completion-plan.md §5.6 / §6; S2.13's own "known deviation"): the `requested →
// cancelled` edge of `CONNECTION_REQUEST_TRANSITIONS` this module's migration (governance/0005)
// already reserved — "a future task can wire a `cancel_connection_request` capability onto
// without a further migration". Same lock → transition → conditional-UPDATE discipline as
// `claimConnectionRequest`; the row's `completed_*` columns stay null (0005's CHECK), so the wire row
// signals cancellation through `status` alone (there is no `cancelled_at` column — the
// `connection.request_cancelled` audit row carries who and when). No outbox event: the shared
// event vocabulary (packages/shared/src/events.ts) has no `ConnectionCancelled` type and nothing
// consumes one yet — the audit row is the durable record.
// -------------------------------------------------------------------------------------------

export interface CancelConnectionRequestInput {
  readonly connectionRequestId: string;
  readonly cancelledBy: string;
}

/**
 * Throws `ConnectionRequestNotFoundError` (404) when the id does not resolve in this workspace,
 * `IllegalTransition` (409) when the row is not currently `requested` — a completed request has
 * a registered Gatekeeper behind it and cannot be un-done here; an already-cancelled one is not
 * silently re-cancelled either, so a stale button press is visible as such. Who may call this
 * (the requester, or the workspace owner) is `application/gateway/connection-handlers.ts`'s
 * check, made on the row it reads first.
 */
export async function cancelConnectionRequest(
  client: PoolClient,
  workspaceId: string,
  input: CancelConnectionRequestInput,
): Promise<ConnectionRequestRow> {
  const locked = await client.query(
    `select ${CONNECTION_REQUEST_ROW_COLUMNS} from connection_requests
     where workspace_id = $1 and id = $2
     for update`,
    [workspaceId, input.connectionRequestId],
  );
  const existing = locked.rows[0] ? mapConnectionRequestRow(locked.rows[0]) : null;
  if (!existing) {
    throw new ConnectionRequestNotFoundError(workspaceId, input.connectionRequestId);
  }
  // I6: throws IllegalTransition unless `existing.status` is `requested`.
  const nextStatus = transition(CONNECTION_REQUEST_TRANSITIONS, existing.status, 'cancel');

  const result = await client.query(
    `update connection_requests
     set status = $3
     where workspace_id = $1 and id = $2 and status = 'requested'
     returning ${CONNECTION_REQUEST_ROW_COLUMNS}`,
    [workspaceId, existing.id, nextStatus],
  );
  const row = result.rows[0];
  // Unreachable while the row lock above is held — the conditional-UPDATE belt to the lock's
  // braces, same as `markConnectionRequestCompleted`.
  if (!row) {
    throw new Error('cancelConnectionRequest: connection request left `requested` under lock');
  }
  const cancelled = mapConnectionRequestRow(row);

  await writeAudit(client, {
    workspaceId,
    actorPrincipalId: input.cancelledBy,
    action: 'connection.request_cancelled',
    resourceType: 'connection_request',
    resourceId: cancelled.id,
    payload: {
      resultingStatus: cancelled.status,
      kind: cancelled.kind,
      // The audit copy of an owner-supplied URL (a password in it is replaced), like the dispatch
      // row's `params`.
      ...redactedForAudit({ target: cancelled.target }),
      requestedBy: cancelled.requestedBy,
    },
  });

  return cancelled;
}

// -------------------------------------------------------------------------------------------
// connectGatekeeper — `connect_gatekeeper(gatekeeperId, principalId)` (design doc §5.1.4
// Connection "授权"): a CapabilityGrant, `resourceType = GATEKEEPER_RESOURCE_SCOPE_KEY`
// (`governance/policy`'s existing `'gatekeeper'` resources-scope-key convention, reused rather
// than inventing a second one — see this function's own doc comment), `resourceId =
// gatekeeperId`. This is what `application/host-bridge/agent-host-runtime.ts`'s
// `ensureEntryHandle` reads (`governance/capability/grants.ts`'s `listActiveGrantResourceScopes`)
// to populate a freshly issued entry Handle's own `resources.gatekeeper`.
// -------------------------------------------------------------------------------------------

/** The same class `application/gateway/request-action-handler.ts` throws — owned by
 *  `governance/gatekeepers` (registry.ts) so both transports map one `instanceof` to 404.
 *  Re-exported here for this module's own consumers/tests. */
export { GatekeeperNotFoundError };

export interface ConnectGatekeeperInput {
  readonly gatekeeperId: string;
  readonly principalId: string;
  readonly grantedBy: string;
}

/**
 * Grants `input.principalId`'s entry agent use of an existing Gatekeeper. Reuses
 * `GATEKEEPER_RESOURCE_SCOPE_KEY` (`'gatekeeper'`) as the `capability_grants.resource_type` value —
 * the same string `computeChildHandleScope`/`request-action-handler.ts` already read as the
 * `resources` key on a `CapabilityScope` — so this Grant is directly consumable by the existing
 * `hasActiveGrant`/`listGrantHolderPrincipalIds` SQL (I14) with no new query shape, and by this
 * task's own `listActiveGrantResourceScopes` addition (entry-Handle issuance) with no second
 * resource-type convention to keep in sync. `resourceId = gatekeeperId` is the one Gatekeeper this
 * Grant covers — a wildcard (`resourceId` omitted) grant is never created here, since "every
 * Gatekeeper this workspace will ever register" is not what "grant a user this one connection"
 * means.
 *
 * Throws `GatekeeperNotFoundError` if `gatekeeperId` does not name a registered Gatekeeper Object
 * — this Grant would otherwise silently name a resource that can never exist.
 */
export async function connectGatekeeper(
  client: PoolClient,
  workspaceId: string,
  input: ConnectGatekeeperInput,
): Promise<CapabilityGrantRow> {
  const gatekeeper: GatekeeperRecord | null = await getGatekeeper(
    client,
    workspaceId,
    input.gatekeeperId,
  );
  if (!gatekeeper) throw new GatekeeperNotFoundError(input.gatekeeperId);

  return grantCapability(client, workspaceId, {
    principalId: input.principalId,
    resourceType: GATEKEEPER_RESOURCE_SCOPE_KEY,
    resourceId: input.gatekeeperId,
    grantedBy: input.grantedBy,
  });
}
