import type { Operation, PrincipalKind } from '@nexttime/shared';
import { CONNECTION_REQUEST_TRANSITIONS, transition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { CapabilityGrantRow } from '../../governance/capability/index.js';
import { grantCapability } from '../../governance/capability/index.js';
import {
  getGatekeeper,
  importManifest,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import type { GatekeeperRecord } from '../../governance/gatekeepers/index.js';
import { GATEKEEPER_RESOURCE_SCOPE_KEY } from '../../governance/policy/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
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
 * **`complete_connection` naming crosswalk** (see final report / PR body "已知偏离"): the task
 * brief's Deliverable 2 names the owner-facing completion capability `complete_connection`, e.g.
 * `complete_connection {connectionRequestId, endpoint, credential?, credentialKind,
 * manifestSource?}`. By the time this task started, `packages/shared/src/capabilities.ts` already
 * registered `create_connection` for exactly this step (design doc §9.3's own name, added before
 * S2.13 began) — this module extends *that* capability's params additively (every new field
 * optional, `credentials` loosened from required to optional) rather than registering a second,
 * competing capability name for the same action. `completeConnection` below is this module's own
 * function name for the service half of that capability — the task brief's `complete_connection`
 * and this repo's `create_connection`/`completeConnection` name the same thing.
 *
 * **Layering — this module does no network I/O** (`.dependency-cruiser.cjs`
 * `kernel-adapters-imported-only-by-application-or-interfaces`: substrate/governance may not
 * import `adapters`, and `fetch`/`GatekeeperClient ` calls belong there in spirit even where not
 * literally an adapter import). `completeConnection` below takes an already-resolved
 * `operations: readonly Operation[]` — the manifest fetch (an OpenAPI document, an MCP
 * `tools/list` call, or the gate's own `describe_operations`) and the "send the credential to the
 * gate" step both happen in `application/gateway/connection-handlers.ts`, which is allowed to
 * import `adapters/gatekeeper-client`. This mirrors `governance/gatekeepers/registry.ts`'s own
 * module boundary (it never touches a gate over the network either) and
 * `cli/bootstrap.ts`'s `registerGatekeeperFromCli`, which already does the "fetch, then hand pure
 * data to a DB-only service function" split at the CLI layer for the same reason.
 *
 * **Sibling-module calls, not internals**: `registerGatekeeper`/`importManifest`
 * (`governance/gatekeepers`) and `grantCapability` (`governance/capability`) are called through
 * their published service interfaces — the same pattern `governance/approval` uses for
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
// completeConnection — `create_connection` (this repo's `complete_connection`, see module doc
// comment). Pure DB: registers the Gatekeeper, imports the already-resolved manifest as drafts
// (I17), resolves/transitions the ConnectionRequest (if one was given), and emits
// `ConnectionCreated`. The credential POST to the gate itself is the caller's job, and must run
// *after* this returns (see this function's own doc comment below for why).
// -------------------------------------------------------------------------------------------

export interface CompleteConnectionInput {
  /** The `request_connection` card being resolved, when there is one (owner may also call this
   *  directly with no prior request — S2.4's own precedent for owner-channel testing). */
  readonly connectionRequestId?: string;
  readonly kind: ConnectionRequestKind;
  readonly target: string;
  readonly endpoint: string;
  /** Already resolved by the caller (OpenAPI import, MCP `tools/list`, or the gate's own
   *  `describe_operations` — application/gateway/connection-handlers.ts). Always imported as
   *  drafts regardless of what the transport suggested (I17) — same contract as
   *  `governance/gatekeepers`'s own `importManifest`. */
  readonly operations: readonly Operation[];
  readonly activityId: string;
  readonly completedBy: { readonly id: string; readonly kind: PrincipalKind };
}

export interface CompleteConnectionResult {
  readonly gatekeeperId: string;
  readonly importedOperationNames: readonly string[];
  readonly connectionRequest: ConnectionRequestRow | null;
}

/**
 * Registers a Gatekeeper instance (+ its `connects_to` system Object, `governance/gatekeepers`'s
 * own placeholder-`ConnectedSystem` path when no richer system Object exists yet — S2.4's own
 * documented, expected-to-be-superseded-by-S2.13 branch, exercised here), imports `input.operations`
 * as draft Operations, resolves the ConnectionRequest to `completed` (I6: via
 * `CONNECTION_REQUEST_TRANSITIONS`, throws `IllegalTransition` if it is not currently
 * `requested`), and emits `ConnectionCreated`.
 *
 * **Never sends the credential** — that is the caller's job, and must happen *after* this
 * function returns, still inside the same DB transaction/handler call
 * (`application/gateway/connection-handlers.ts`'s own doc comment has the full ordering
 * argument): if this function's writes all commit but the credential POST that follows fails, the
 * whole transaction rolls back — no Gatekeeper is left registered with no working credential, and
 * no ConnectionRequest is left `completed` with nothing behind it. Reversing the order (POST
 * first) would instead risk an orphaned credential sitting in a gate the kernel has no record of,
 * with no transactional way to undo an already-sent HTTP call.
 */
export async function completeConnection(
  client: PoolClient,
  workspaceId: string,
  input: CompleteConnectionInput,
): Promise<CompleteConnectionResult> {
  let connectionRequest: ConnectionRequestRow | null = null;
  if (input.connectionRequestId) {
    const existing = await getConnectionRequest(client, workspaceId, input.connectionRequestId);
    if (!existing) {
      throw new ConnectionRequestNotFoundError(workspaceId, input.connectionRequestId);
    }
    // I6: throws IllegalTransition if `existing.status` is not `requested` — a completed or
    // cancelled request can never be completed a second time, and this check runs *before* any
    // write below, so a stale/replayed call never double-registers a Gatekeeper.
    transition(CONNECTION_REQUEST_TRANSITIONS, existing.status, 'complete');
    connectionRequest = existing;
  }

  const { gatekeeperId } = await registerGatekeeper(client, workspaceId, {
    name: input.target,
    transportKind: input.kind,
    target: input.target,
    endpoint: input.endpoint,
    activityId: input.activityId,
    registeredBy: input.completedBy,
  });

  const imported = await importManifest(client, workspaceId, {
    gatekeeperId,
    operations: input.operations,
    proposedBy: input.completedBy,
    activityId: input.activityId,
  });

  if (connectionRequest) {
    const result = await client.query(
      `update connection_requests
       set status = 'completed', gatekeeper_id = $3, completed_by = $4, completed_at = now()
       where workspace_id = $1 and id = $2
       returning ${CONNECTION_REQUEST_ROW_COLUMNS}`,
      [workspaceId, connectionRequest.id, gatekeeperId, input.completedBy.id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('completeConnection: UPDATE ... RETURNING produced no row');
    connectionRequest = mapConnectionRequestRow(row);
  }

  await enqueue(client, {
    type: 'ConnectionCreated',
    workspaceId,
    gatekeeperId,
    kind: input.kind,
    target: input.target,
  });

  return {
    gatekeeperId,
    importedOperationNames: imported.map((record) => record.name),
    connectionRequest,
  };
}

// -------------------------------------------------------------------------------------------
// connectGatekeeper — `connect_gatekeeper(gatekeeperId, principalId)` (design doc §5.1.4
// Connection "授权"): a CapabilityGrant, `capability = GATEKEEPER_RESOURCE_SCOPE_KEY`
// (`governance/policy`'s existing `'gatekeeper'` resources-scope-key convention, reused rather
// than inventing a second one — see this function's own doc comment), `scope.resourceScope =
// gatekeeperId`. This is what `application/host-bridge/agent-host-runtime.ts`'s
// `ensureEntryHandle` reads (`governance/capability/grants.ts`'s `listActiveGrantResourceScopes`)
// to populate a freshly issued entry Handle's own `resources.gatekeeper`.
// -------------------------------------------------------------------------------------------

/** Mirrors `application/gateway/request-action-handler.ts`'s own local `GatekeeperNotFoundError`
 *  (`governance/gatekeepers` exports no such class of its own — `getGatekeeper` simply returns
 *  `null` — so each consuming module declares its own, same precedent). */
export class GatekeeperNotFoundError extends Error {
  constructor(gatekeeperId: string) {
    super(`Gatekeeper not found: ${gatekeeperId}`);
    this.name = 'GatekeeperNotFoundError';
  }
}

export interface ConnectGatekeeperInput {
  readonly gatekeeperId: string;
  readonly principalId: string;
  readonly grantedBy: string;
}

/**
 * Grants `input.principalId`'s entry agent use of an existing Gatekeeper. Reuses
 * `GATEKEEPER_RESOURCE_SCOPE_KEY` (`'gatekeeper'`) as the `capability_grants.capability` value —
 * the same string `computeChildHandleScope`/`request-action-handler.ts` already read as the
 * `resources` key on a `CapabilityScope` — so this Grant is directly consumable by the existing
 * `hasActiveGrant`/`listGrantHolderPrincipalIds` SQL (I14) with no new query shape, and by this
 * task's own `listActiveGrantResourceScopes` addition (entry-Handle issuance) with no second
 * capability-name convention to keep in sync. `scope.resourceScope = gatekeeperId` is the one
 * Gatekeeper this Grant covers — a wildcard (`resourceScope` omitted) grant is never created here,
 * since "every Gatekeeper this workspace will ever register" is not what "grant a user this one
 * connection" means.
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
    capability: GATEKEEPER_RESOURCE_SCOPE_KEY,
    scope: { resourceScope: input.gatekeeperId },
    grantedBy: input.grantedBy,
  });
}
