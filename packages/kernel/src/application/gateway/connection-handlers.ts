import { McpTransport, importMcpTools, importOpenApi } from '@nexttime/gatekeeper-base';
import type { McpToolsListResult, OpenApiDocumentLike } from '@nexttime/gatekeeper-base';
import type { Operation, PrincipalKind, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { ConnectionRequestKind } from '../../governance/connections/index.js';
import {
  ConnectionRequestNotFoundError,
  cancelConnectionRequest,
  completeConnection,
  connectGatekeeper,
  getConnectionRequest,
  listConnectionRequests,
  requestConnection,
} from '../../governance/connections/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { currentPrincipalId } from '../chat/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { toWireConnectionRequest, toWireGrant } from './resource-wire.js';

/**
 * application/gateway/connection-handlers: `request_connection`, `create_connection` (this
 * repo's `complete_connection` — governance/connections/service.ts's own doc comment has the full
 * naming crosswalk), `connect_gatekeeper`, `list_connection_requests` (design doc §5.1.4
 * Connection, §7.5, §9.3; docs/development-tasks.md S2.13 "Handlers wired").
 *
 * **Every network I/O this flow needs lives here, not in `governance/connections`** (§7.10:
 * substrate/governance may not import adapters): resolving the manifest to import (an OpenAPI
 * document fetch, an MCP `tools/list` call, or the gate's own `describe_operations`) and sending
 * the credential to the gate's ConnectedAccount store are both real HTTP calls against the target
 * Gatekeeper instance/system — `createConnectionHandler` below does them, then hands
 * `governance/connections`'s `completeConnection` only the already-resolved data. Same DI seam
 * shape `request-action-handler.ts` already uses for its own `GatekeeperClient`
 * (`setRequestActionDeps`) — `setConnectionHandlerDeps` here is set once by the composition root
 * (`packages/kernel/src/index.ts`), reusing the *same* `GatekeeperClient` instance.
 *
 * **Credential ordering (redaction + rollback)**: `createConnectionHandler` calls
 * `completeConnection` (every DB write: register the Gatekeeper, import the manifest, transition
 * the ConnectionRequest, emit `ConnectionCreated`) *before* posting the credential to the gate —
 * see `completeConnection`'s own doc comment for why. The `credentials` param itself never reaches
 * `audit_records` (`packages/shared/src/capabilities.ts`'s `create_connection.redactedParamKeys`,
 * applied generically by `dispatch.ts`) and this handler's own returned `result` never echoes it
 * back either.
 *
 * **Endpoint guard (STATUS leftover 36, S5.5)**: the kernel calls every gate with the same
 * `gate_token`, so a workspace owner who pointed a self-connected gate at a *platform-catalog*
 * instance (`gate_instances.endpoint` — a packaged gate, or `gate-host`'s `/i/<id>` prefix with the
 * administrator's shared credentials behind it) would get a Gatekeeper in their own workspace that
 * the catalog's `workspace_gate_links` rules (connector deny list, `vetted`, `enabled` /
 * `disabled`) never see. `assertEndpointIsNotAPlatformGate` refuses that before any network I/O —
 * the only door to a catalog instance is `enable_gate_instance` (gate-instance-handlers.ts).
 */

/** Upper bound on the `manifestSource` OpenAPI-document fetch — it runs inside the dispatch
 *  transaction (see `resolveManifestOperations`). Same order of magnitude as
 *  `HttpGatekeeperClient`'s own per-call timeout, which already bounds the other network calls in
 *  this handler. */
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;

export interface ConnectionHandlerDeps {
  readonly gatekeeperClient: GatekeeperClient;
  /** Injectable for tests — defaults to the global `fetch`. Only used for the `manifestSource`
   *  OpenAPI-document-fetch path (an `http` connection whose manifest is not already loaded into
   *  the running gate). */
  readonly fetchImpl?: typeof fetch;
}

let deps: ConnectionHandlerDeps | undefined;

export function setConnectionHandlerDeps(next: ConnectionHandlerDeps): void {
  deps = next;
}

function requireDeps(): ConnectionHandlerDeps {
  if (!deps) {
    throw new Error(
      'connection-handlers: gatekeeper dependencies are not wired — call setConnectionHandlerDeps() from the composition root',
    );
  }
  return deps;
}

export class ConnectionManifestFetchError extends Error {
  constructor(manifestSource: string, options?: { cause?: unknown }) {
    super(`create_connection: failed to fetch manifestSource "${manifestSource}"`, options);
    this.name = 'ConnectionManifestFetchError';
  }
}

export class ConnectionCredentialRequiredError extends Error {
  constructor() {
    super(
      "create_connection: credentialKind is (or defaults to) 'connected_account' but no " +
        "`credentials` was given — pass `credentials`, or `credentialKind: 'shared'` for a " +
        'gate already configured with a shared/env credential out-of-band',
    );
    this.name = 'ConnectionCredentialRequiredError';
  }
}

/** The endpoint is the address of a platform-catalog gate instance (module doc comment, "Endpoint
 *  guard"). `gateId` names the catalog row it collided with — the caller's remedy is
 *  `enable_gate_instance` on that id (or asking the administrator), never a different spelling of
 *  the same address. Mapped to 400 `endpoint_is_platform_gate` by interfaces/http/capability-route. */
export class ConnectionEndpointIsPlatformGateError extends Error {
  readonly code = 'endpoint_is_platform_gate' as const;
  readonly gateId: string;
  constructor(endpoint: string, gateId: string) {
    const remedy =
      'a workspace cannot connect a platform-catalog gate itself; enable it from the catalog ' +
      '(enable_gate_instance) or ask the administrator';
    super(
      `create_connection: endpoint "${endpoint}" is the address of platform gate instance "${gateId}" — ${remedy}`,
    );
    this.name = 'ConnectionEndpointIsPlatformGateError';
    this.gateId = gateId;
  }
}

/** `host` (hostname plus a non-default port) of a URL, lower-cased; `null` when the string is not
 *  a URL at all — such an endpoint is left to `HttpGatekeeperClient` to fail on downstream. */
function urlHost(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuses an endpoint whose `host` matches any catalog instance's (`gate_instances.endpoint`, every
 * status — a `disabled` instance is exactly one the administrator does not want reached). Matching
 * on the parsed host rather than the string closes trailing slashes and path variants: for
 * `gate-host` one announced instance (`http://gate-host:8083/i/<id>`) covers every `/i/*` under
 * that host, including hosted rows the host has not announced yet (their own `endpoint` is still
 * `''`, which the query skips). `gate_instances` has a `*_read_all` policy (migration core 0023),
 * so the workspace transaction can read it. Residual: an address that reaches the same container
 * by another name (an IP, a network alias) is not detected — the kernel does not resolve names
 * inside a transaction; the compose networks are the remaining boundary for that case.
 */
async function assertEndpointIsNotAPlatformGate(
  client: PoolClient,
  endpoint: string,
): Promise<void> {
  const host = urlHost(endpoint);
  if (host === null) return;
  const catalog = await client.query<{ gate_id: string; endpoint: string }>(
    "select gate_id, endpoint from gate_instances where endpoint <> ''",
  );
  for (const row of catalog.rows) {
    if (urlHost(row.endpoint) === host) {
      throw new ConnectionEndpointIsPlatformGateError(endpoint, row.gate_id);
    }
  }
}

/** `request_connection(kind, target)` — Handle channel, any member (design doc §7.5). */
export const requestConnectionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { kind, target } = params as { kind: ConnectionRequestKind; target: string };
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));
  const requesterKind: PrincipalKind = ctx?.channel === 'human' ? 'human' : 'agent';

  const row = await requestConnection(client, workspaceId, {
    kind,
    target,
    requestedBy: { id: principalId, kind: requesterKind },
  });

  return {
    result: {
      id: row.id,
      status: row.status,
      kind: row.kind,
      target: row.target,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
    },
    resourceType: 'connection_request',
    resourceId: row.id,
  };
};

// -------------------------------------------------------------------------------------------
// create_connection ("complete_connection") — manifest resolution (network) + completeConnection
// (DB) + credential POST (network, last — see this file's own module doc comment).
// -------------------------------------------------------------------------------------------

interface CreateConnectionParams {
  readonly connectionRequestId?: string;
  readonly kind: ConnectionRequestKind;
  readonly target: string;
  readonly endpoint: string;
  readonly credentials?: unknown;
  readonly credentialKind?: 'shared' | 'connected_account';
  readonly onBehalfOf?: string;
  readonly manifestSource?: string;
}

/** Resolves the manifest to import as drafts (design doc §7.5 "http 从 OpenAPI URL 导入清单草稿，
 *  mcp 从 tools/list 导入"): `manifestSource` given → fetch it directly (`http`: parse as an
 *  OpenAPI document, `importOpenApi`; `mcp`: `tools/list` against that endpoint,
 *  `importMcpTools`); omitted (any kind, including `cli`/`ssh`, which have no `manifestSource`
 *  concept) → the already-running gate's own `describe_operations` (same path
 *  `cli/bootstrap.ts`'s `registerGatekeeperFromCli` already uses — a gate started with
 *  `GATE_MANIFEST_FILE` set). */
async function resolveManifestOperations(
  params: CreateConnectionParams,
  gatekeeperClient: GatekeeperClient,
  fetchImpl: typeof fetch,
): Promise<readonly Operation[]> {
  const { kind, endpoint, manifestSource, credentials } = params;

  if (manifestSource && kind === 'http') {
    let document: OpenApiDocumentLike;
    try {
      // Bounded: this runs inside dispatch.ts's open DB transaction (see the module doc comment on
      // ordering), so an unresponsive manifest URL must not pin a pool connection indefinitely.
      const response = await fetchImpl(manifestSource, {
        signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`responded ${response.status}`);
      }
      document = (await response.json()) as OpenApiDocumentLike;
    } catch (err) {
      throw new ConnectionManifestFetchError(manifestSource, { cause: err });
    }
    return importOpenApi(document);
  }

  if (manifestSource && kind === 'mcp') {
    let toolsList: McpToolsListResult;
    try {
      const transport = new McpTransport({ endpoint: manifestSource, fetchImpl });
      toolsList = await transport.listTools(credentials);
    } catch (err) {
      throw new ConnectionManifestFetchError(manifestSource, { cause: err });
    }
    return importMcpTools(toolsList);
  }

  const described = await gatekeeperClient.describeOperations(endpoint);
  return described.operations;
}

export const createConnectionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const params = rawParams as CreateConnectionParams;
  const { gatekeeperClient, fetchImpl } = requireDeps();
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const effectiveCredentialKind: 'shared' | 'connected_account' =
    params.credentialKind ?? (params.credentials !== undefined ? 'connected_account' : 'shared');
  if (effectiveCredentialKind === 'connected_account' && params.credentials === undefined) {
    throw new ConnectionCredentialRequiredError();
  }

  // Before the manifest resolution below: that is the first call the kernel would make *to* the
  // endpoint with its gate token (`describeOperations`), and the whole point is never to make it.
  await assertEndpointIsNotAPlatformGate(client, params.endpoint);

  const operations = await resolveManifestOperations(params, gatekeeperClient, fetchImpl ?? fetch);

  const activity = await startActivity(client, workspaceId, {
    kind: 'governance.create_connection',
    principalId,
    metadata: { kind: params.kind, target: params.target },
  });

  let completion: Awaited<ReturnType<typeof completeConnection>>;
  try {
    completion = await completeConnection(client, workspaceId, {
      connectionRequestId: params.connectionRequestId,
      kind: params.kind,
      target: params.target,
      endpoint: params.endpoint,
      operations,
      activityId: activity.id,
      completedBy: { id: principalId, kind: 'human' },
    });
    await endActivity(client, workspaceId, activity.id, 'completed');
  } catch (err) {
    await endActivity(client, workspaceId, activity.id, 'failed');
    throw err;
  }

  // Credential POST — deliberately last (this file's + completeConnection's own doc comments): a
  // failure here throws out of this handler, and dispatch.ts's withWorkspace transaction rolls
  // back every DB write completeConnection just made.
  if (effectiveCredentialKind === 'connected_account') {
    const onBehalfOf =
      params.onBehalfOf ?? completion.connectionRequest?.requestedBy ?? principalId;
    await gatekeeperClient.storeConnectedAccount(params.endpoint, {
      onBehalfOf,
      credential: params.credentials as Record<string, unknown>,
    });
  }

  return {
    result: {
      gatekeeperId: completion.gatekeeperId,
      importedOperationNames: completion.importedOperationNames,
      skippedOperationNames: completion.skippedOperationNames,
      connectionRequestId: completion.connectionRequest?.id ?? null,
    },
    resourceType: 'gatekeeper',
    resourceId: completion.gatekeeperId,
  };
};

/** `connect_gatekeeper(gatekeeperId, principalId)` — human, owner (design doc §5.1.4 Connection
 *  "授权"): a CapabilityGrant. */
export const connectGatekeeperHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { gatekeeperId, principalId } = params as { gatekeeperId: string; principalId: string };
  const grantedBy = ctx?.principalId ?? (await currentPrincipalId(client));

  const grant = await connectGatekeeper(client, workspaceId, {
    gatekeeperId,
    principalId,
    grantedBy,
  });

  return {
    result: toWireGrant(grant),
    resourceType: 'capability_grant',
    resourceId: grant.id,
  };
};

/** `list_connection_requests` — owner's queue (§9.3). */
export const listConnectionRequestsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { status } = params as { status?: 'requested' | 'completed' | 'cancelled' };
  const rows = await listConnectionRequests(client, workspaceId, { status });
  return { result: { items: rows.map(toWireConnectionRequest) } };
};

/**
 * `cancel_connection_request(connectionRequestId)` — S6-A C26 (docs/console-completion-plan.md
 * §5.6, §6; runbook web-console.md 已知缺口 8). `minRole: 'member'` gates entry; *which* request a
 * member may cancel is decided here: their own (`requested_by`), or any if they hold the
 * workspace `owner` role (`ctx.principal.role`, resolved by dispatch.ts for every human call;
 * one `principals` read as the fallback when no ctx was passed). `connection_requests`' RLS is
 * workspace-wide (governance/0005's own comment), so another member's request *is* visible and
 * a wrong caller gets a clean 403, never a misleading 404. The `requested`-only rule and the
 * `connection.request_cancelled` audit row are `governance/connections`'s
 * `cancelConnectionRequest` (409 `illegal_transition` otherwise — `completeConnection` on the
 * same table already answers that way for a non-`requested` row).
 */
export const cancelConnectionRequestHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { connectionRequestId } = params as { connectionRequestId: string };
  const existing = await getConnectionRequest(client, workspaceId, connectionRequestId);
  if (!existing) throw new ConnectionRequestNotFoundError(workspaceId, connectionRequestId);

  const caller = ctx?.principal
    ? { id: ctx.principal.id, role: ctx.principal.role }
    : await currentPrincipalWithRole(client, workspaceId);
  if (existing.requestedBy !== caller.id && caller.role !== 'owner') {
    throw new ForbiddenError(
      `cancel_connection_request: ConnectionRequest ${connectionRequestId} was requested by another principal; only the requester or the workspace owner may cancel it`,
    );
  }

  const cancelled = await cancelConnectionRequest(client, workspaceId, {
    connectionRequestId,
    cancelledBy: caller.id,
  });
  return {
    result: toWireConnectionRequest(cancelled),
    resourceType: 'connection_request',
    resourceId: cancelled.id,
  };
};

/** Fallback for a call with no `ctx` (a unit test driving the handler directly): the RLS session
 *  principal plus its `role` — the same two reads handlers.ts's own `currentPrincipalRole` makes. */
async function currentPrincipalWithRole(
  client: PoolClient,
  workspaceId: string,
): Promise<{ id: string; role: Role }> {
  const id = await currentPrincipalId(client);
  const result = await client.query<{ role: Role }>(
    'select role from principals where workspace_id = $1 and id = $2',
    [workspaceId, id],
  );
  const role = result.rows[0]?.role;
  if (!role) {
    throw new Error(
      `cancel_connection_request: principal ${id} not found in workspace ${workspaceId}`,
    );
  }
  return { id, role };
}
