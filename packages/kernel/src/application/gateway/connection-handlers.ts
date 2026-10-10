import {
  McpTransport,
  importMcpTools,
  importOpenApi,
  isRedirectStatus,
  redirectRefusalMessage,
} from '@nexttime/gatekeeper-base';
import type { McpToolsListResult, OpenApiDocumentLike } from '@nexttime/gatekeeper-base';
import type { Operation, PrincipalKind, Role } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type {
  GateConnectionSecrets,
  GateTarget,
  GatekeeperClient,
} from '../../adapters/gatekeeper-client/index.js';
import {
  type OutboundTargetGuard,
  createOutboundTargetGuard,
  withoutRedirects,
} from '../../adapters/outbound-target/index.js';
import type { ConnectionRequestKind } from '../../governance/connections/index.js';
import {
  ConnectionRequestNotFoundError,
  assertConnectionParamsCarryNoCredentials,
  cancelConnectionRequest,
  completeConnection,
  connectGatekeeper,
  getConnectionRequest,
  listConnectionRequests,
  requestConnection,
} from '../../governance/connections/index.js';
import {
  GatekeeperNotFoundError,
  findGatekeeperIdByConnectionSecretSalt,
  getGatekeeper,
  setGatekeeperConnectionSecretSalt,
} from '../../governance/gatekeepers/index.js';
import { scrubSecretValues } from '../../governance/redaction/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { currentPrincipalId } from '../chat/index.js';
import { readConnectorMode } from '../gates/index.js';
import { ForbiddenError } from './authorize.js';
import type { CapabilityHandler } from './capability-handler.js';
import { platformGateIdForEndpoint } from './gate-target.js';
import { toWireConnectionRequest, toWireGrant } from './resource-wire.js';

/**
 * application/gateway/connection-handlers: `request_connection`, `create_connection` (this
 * repo's `complete_connection` — governance/connections/service.ts's own doc comment has the full
 * naming crosswalk), `connect_gatekeeper`, `list_connection_requests` (design doc §5.1.4
 * Connection, §7.5, §9.3; docs/development-tasks.md S2.13 "Handlers wired"), and the two
 * connection-secret capabilities `mint_connection_secret` / `rotate_connection_secret` (R-01).
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
 * see `completeConnection`'s own doc comment for why. The `credentials` and `connectionSecret`
 * params never reach `audit_records` (`packages/shared/src/capabilities.ts`'s
 * `create_connection.redactedParamKeys`, applied generically by `dispatch.ts`) and this handler's
 * own returned `result` never echoes either back.
 *
 * **Endpoint guard (STATUS leftover 36, S5.5)**: a workspace owner who pointed a self-connected gate
 * at a *platform-catalog* instance (`gate_instances.endpoint` — a packaged gate, or `gate-host`'s
 * `/i/<id>` prefix with the administrator's shared credentials behind it) would get a Gatekeeper in
 * their own workspace that the catalog's `workspace_gate_links` rules (connector deny list,
 * `vetted`, `enabled` / `disabled`) never see. `assertEndpointIsNotAPlatformGate` refuses that
 * before any network I/O — the only door to a catalog instance is `enable_gate_instance`
 * (gate-instance-handlers.ts).
 *
 * **Per-connection secret (R-01, maintainer decision D-01, 2026-10-02 review)**: the kernel used to
 * send the platform `gate_token` to whatever endpoint an owner typed here — and with it the owner
 * could call any packaged gate or gate-host instance directly, with no ActionRequest, approval or
 * kernel audit. A self-connected gate now gets its own secret instead
 * (`adapters/gatekeeper-client/connection-secret.ts`): the owner gets one from
 * `mint_connection_secret` (shown once — the console's connect form does this), copies it into the
 * gate's `GATE_KERNEL_TOKEN_FILE`, and passes it as `connectionSecret` here; the kernel verifies it
 * was minted for this workspace, stores only its non-secret salt on the Gatekeeper, and presents the
 * re-derived secret on every call (`gate-target.ts` decides; `gate_token` goes only to catalog
 * instances). `rotate_connection_secret` replaces the salt.
 *
 * **Connector three-state (R-40, maintainer decision D-19)**: a workspace may connect a system of
 * its own only while the platform keeps the generic connector for that `kind` in `self_serve`
 * (design `platform-admin-design.md` "三态：禁用 / 可自连 / 平台预置"). `disabled` closes it to new
 * connections; `platform_preset` means the platform runs that kind's instances and a workspace
 * enables them from the catalog (`enable_gate_instance`). `assertConnectorSelfServe` refuses both
 * `create_connection` and `request_connection` otherwise, before any other check or I/O — 409
 * `connector_not_self_serve`. Existing connections are untouched (D-19: the mode gates new
 * connections; the connector's Operation deny list is the cut-off for existing ones).
 *
 * **Outbound-target predicate (R-27)**: `endpoint` and `manifestSource` are owner-supplied URLs the
 * kernel itself fetches from inside the platform's networks, so both pass `@nexttime/shared`'s
 * `outbound-target` predicate (bare/compose names, loopback, link-local, the platform subnets are
 * refused — 400 `connection_target_refused`) before any fetch, and no fetch of either follows a
 * redirect.
 */

/** Upper bound on the `manifestSource` OpenAPI-document fetch — it runs inside the dispatch
 *  transaction (see `resolveManifestOperations`). Same order of magnitude as
 *  `HttpGatekeeperClient`'s own per-call timeout, which already bounds the other network calls in
 *  this handler. */
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;

export interface ConnectionHandlerDeps {
  readonly gatekeeperClient: GatekeeperClient;
  /** R-01: issues and verifies connection secrets (holds the gate token; the handlers never do). */
  readonly connectionSecrets: GateConnectionSecrets;
  /** Injectable for tests — defaults to the global `fetch`. Only used for the `manifestSource`
   *  OpenAPI-document-fetch path (an `http` connection whose manifest is not already loaded into
   *  the running gate) and the `mcp` `tools/list` import. */
  readonly fetchImpl?: typeof fetch;
  /** R-27: the owner-supplied-URL predicate — defaults to `createOutboundTargetGuard()` over
   *  `process.env`. Injectable for tests. */
  readonly outboundTargetGuard?: OutboundTargetGuard;
}

let deps: ConnectionHandlerDeps | undefined;
let defaultGuard: OutboundTargetGuard | undefined;

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

function outboundTargetGuard(current: ConnectionHandlerDeps): OutboundTargetGuard {
  if (current.outboundTargetGuard) return current.outboundTargetGuard;
  defaultGuard ??= createOutboundTargetGuard();
  return defaultGuard;
}

/** The most characters of a manifest URL an error repeats — as `redirectTargetForDisplay`. */
const MAX_SHOWN_MANIFEST_SOURCE_CHARS = 300;

/** `manifestSource` as an error repeats it (review of #538, item 2): origin and path only, quoted —
 *  never the userinfo, query or fragment, where an owner-supplied URL carries a key
 *  (`?api_key=…`); the same rule as a refused redirect's target (`redirectTargetForDisplay`). */
function manifestSourceForDisplay(manifestSource: string): string {
  let url: URL;
  try {
    url = new URL(manifestSource);
  } catch {
    return 'an unparseable URL';
  }
  const shown = `${url.origin}${url.pathname}`;
  return JSON.stringify(
    shown.length > MAX_SHOWN_MANIFEST_SOURCE_CHARS
      ? `${shown.slice(0, MAX_SHOWN_MANIFEST_SOURCE_CHARS)}…`
      : shown,
  );
}

export class ConnectionManifestFetchError extends Error {
  constructor(manifestSource: string, options?: { cause?: unknown }) {
    // The cause says why — a status, a redirect and where it pointed, a timeout — which the owner
    // needs to fix the URL; it used to be dropped. Scrubbed: an MCP server's error or a body the
    // JSON parser quotes can echo the credentials sent with the fetch.
    const cause =
      options?.cause instanceof Error ? `: ${scrubSecretValues(options.cause.message).value}` : '';
    super(
      `create_connection: failed to fetch manifestSource ${manifestSourceForDisplay(manifestSource)}${cause}`,
      options,
    );
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

/** `create_connection` without a usable `connectionSecret` (R-01): missing, or not minted by this
 *  kernel for this workspace. Mapped to 400 `invalid_params`. */
export class ConnectionSecretInvalidError extends Error {
  constructor(missing: boolean) {
    super(
      missing
        ? 'create_connection: connectionSecret is required — get one with mint_connection_secret, put it in the gate’s GATE_KERNEL_TOKEN_FILE (restart the gate), then connect it'
        : 'create_connection: connectionSecret was not issued for this workspace — get a new one with mint_connection_secret and put it in the gate’s GATE_KERNEL_TOKEN_FILE',
    );
    this.name = 'ConnectionSecretInvalidError';
  }
}

/** A connection secret that cannot apply here (R-01): already used by another Gatekeeper in this
 *  workspace, or `rotate_connection_secret` on a platform-catalog gate (the kernel authenticates to
 *  those with the platform credential). Mapped to 409 `conflict`. */
export class ConnectionSecretConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionSecretConflictError';
  }
}

/** R-40 (D-19): the generic connector for the connection's `kind` is not `self_serve` (or has no
 *  row) — the platform administrator has disabled self-connection for that kind, or runs it as a
 *  platform preset. Mapped to 409 `connector_not_self_serve` by interfaces/http/capability-route. */
export class ConnectorNotSelfServeError extends Error {
  readonly code = 'connector_not_self_serve' as const;
  readonly connector: string;
  readonly mode: string | null;
  constructor(connector: string, mode: string | null) {
    const why =
      mode === 'platform_preset'
        ? 'the platform provides it as a preset — enable one of its instances from the catalog (enable_gate_instance)'
        : mode === 'disabled'
          ? 'the platform administrator has disabled it'
          : 'no such connector is configured';
    super(
      `"${connector}" systems cannot be connected by a workspace itself right now: ${why}. Ask the platform administrator if you need it.`,
    );
    this.name = 'ConnectorNotSelfServeError';
    this.connector = connector;
    this.mode = mode;
  }
}

/** R-40 (D-19): see the module doc comment ("Connector three-state"). */
async function assertConnectorSelfServe(
  client: PoolClient,
  kind: ConnectionRequestKind,
): Promise<void> {
  const mode = await readConnectorMode(client, kind);
  if (mode !== 'self_serve') throw new ConnectorNotSelfServeError(kind, mode);
}

/**
 * Refuses an endpoint whose `host` matches any catalog instance's (`gate_instances.endpoint`, every
 * status — a `disabled` instance is exactly one the administrator does not want reached) — the
 * shared host rule is `gate-target.ts`'s `platformGateIdForEndpoint`. Residual: an address that
 * reaches the same container by another name (an IP, a network alias) is not detected here; the
 * outbound-target predicate below refuses every address inside the platform's subnets.
 */
async function assertEndpointIsNotAPlatformGate(
  client: PoolClient,
  endpoint: string,
): Promise<void> {
  const gateId = await platformGateIdForEndpoint(client, endpoint);
  if (gateId !== null) throw new ConnectionEndpointIsPlatformGateError(endpoint, gateId);
}

/** `request_connection(kind, target)` — Handle channel, any member (design doc §7.5). */
export const requestConnectionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
  ctx,
) => {
  const { kind, target } = params as { kind: ConnectionRequestKind; target: string };
  // R-40: a request the owner could never complete is refused up front, with the reason.
  await assertConnectorSelfServe(client, kind);
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
  readonly connectionSecret?: string;
  readonly credentials?: unknown;
  readonly credentialKind?: 'shared' | 'connected_account';
  readonly onBehalfOf?: string;
  readonly manifestSource?: string;
}

/** Whether `manifestSource` is fetched at all for `kind` (`cli`/`ssh` ignore it). */
function usesManifestSource(params: CreateConnectionParams): params is CreateConnectionParams & {
  readonly manifestSource: string;
} {
  return Boolean(params.manifestSource) && (params.kind === 'http' || params.kind === 'mcp');
}

/** Resolves the manifest to import as drafts (design doc §7.5 "http 从 OpenAPI URL 导入清单草稿，
 *  mcp 从 tools/list 导入"): `manifestSource` given → fetch it directly (`http`: parse as an
 *  OpenAPI document, `importOpenApi`; `mcp`: `tools/list` against that endpoint,
 *  `importMcpTools`); omitted (any kind, including `cli`/`ssh`, which have no `manifestSource`
 *  concept) → the already-running gate's own `describe_operations` (same path
 *  `cli/bootstrap.ts`'s `registerGatekeeperFromCli` already uses — a gate started with
 *  `GATE_MANIFEST_FILE` set). Both `manifestSource` fetches refuse redirects (R-27). */
async function resolveManifestOperations(
  params: CreateConnectionParams,
  gate: GateTarget,
  gatekeeperClient: GatekeeperClient,
  fetchImpl: typeof fetch,
): Promise<readonly Operation[]> {
  const { kind, manifestSource, credentials } = params;
  const ownerFetch = withoutRedirects(fetchImpl);

  if (manifestSource && kind === 'http') {
    let document: OpenApiDocumentLike;
    try {
      // Bounded: this runs inside dispatch.ts's open DB transaction (see the module doc comment on
      // ordering), so an unresponsive manifest URL must not pin a pool connection indefinitely.
      const response = await ownerFetch(manifestSource, {
        signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      });
      if (isRedirectStatus(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          redirectRefusalMessage('GET', response, manifestSource, {
            follower: 'The kernel does not follow redirects for an owner-supplied URL',
            fix: 'set manifestSource to the final address',
          }),
        );
      }
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
      const transport = new McpTransport({ endpoint: manifestSource, fetchImpl: ownerFetch });
      toolsList = await transport.listTools(credentials);
    } catch (err) {
      throw new ConnectionManifestFetchError(manifestSource, { cause: err });
    }
    return importMcpTools(toolsList);
  }

  const described = await gatekeeperClient.describeOperations(gate);
  return described.operations;
}

/** Throws `ConnectionSecretConflictError` when another Gatekeeper in this workspace already holds
 *  `salt` — one secret per connection, so rotating one gate never breaks another. */
async function assertConnectionSecretUnused(
  client: PoolClient,
  workspaceId: string,
  salt: string,
): Promise<void> {
  const holder = await findGatekeeperIdByConnectionSecretSalt(client, workspaceId, salt);
  if (holder !== null) {
    throw new ConnectionSecretConflictError(
      `create_connection: this connectionSecret already belongs to Gatekeeper "${holder}" — every connection gets its own; get a new one with mint_connection_secret`,
    );
  }
}

export const createConnectionHandler: CapabilityHandler = async (
  client,
  workspaceId,
  rawParams,
  ctx,
) => {
  const params = rawParams as CreateConnectionParams;
  const current = requireDeps();
  const { gatekeeperClient, connectionSecrets, fetchImpl } = current;
  // R-40 (D-19): first — whether this workspace may self-connect this kind at all.
  await assertConnectorSelfServe(client, params.kind);
  // Legacy 186: before the endpoint is checked, called, echoed in an error or stored.
  assertConnectionParamsCarryNoCredentials('create_connection', {
    target: params.target,
    endpoint: params.endpoint,
  });
  const principalId = ctx?.principalId ?? (await currentPrincipalId(client));

  const effectiveCredentialKind: 'shared' | 'connected_account' =
    params.credentialKind ?? (params.credentials !== undefined ? 'connected_account' : 'shared');
  if (effectiveCredentialKind === 'connected_account' && params.credentials === undefined) {
    throw new ConnectionCredentialRequiredError();
  }

  // Before the manifest resolution below: that is the first call the kernel would make *to* the
  // endpoint (`describeOperations`), and the whole point is never to make it.
  await assertEndpointIsNotAPlatformGate(client, params.endpoint);

  // R-01: the gate's own secret, verified before anything is sent to it.
  if (params.connectionSecret === undefined || params.connectionSecret.trim() === '') {
    throw new ConnectionSecretInvalidError(true);
  }
  const salt = connectionSecrets.saltOf(workspaceId, params.connectionSecret);
  if (salt === null) throw new ConnectionSecretInvalidError(false);
  await assertConnectionSecretUnused(client, workspaceId, salt);

  // R-27: both owner-supplied URLs, before any fetch of either.
  const guard = outboundTargetGuard(current);
  await guard(params.endpoint, 'endpoint');
  if (usesManifestSource(params)) await guard(params.manifestSource, 'manifestSource');

  const gate: GateTarget = {
    endpoint: params.endpoint,
    credential: { kind: 'connection', workspaceId, salt },
  };
  const operations = await resolveManifestOperations(
    params,
    gate,
    gatekeeperClient,
    fetchImpl ?? fetch,
  );

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
      connectionSecretSalt: salt,
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
    await gatekeeperClient.storeConnectedAccount(gate, {
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

// -------------------------------------------------------------------------------------------
// mint_connection_secret / rotate_connection_secret (R-01, D-01) — the only two places a
// connection secret is ever shown, each exactly once (the result; never the audit row).
// -------------------------------------------------------------------------------------------

/** `mint_connection_secret()` — human, owner: a fresh secret for a gate about to be connected with
 *  `create_connection`. Stores nothing: the secret carries its own salt, and only a
 *  `create_connection` that presents it records that salt. */
export const mintConnectionSecretHandler: CapabilityHandler = async (_client, workspaceId) => {
  const { secret } = requireDeps().connectionSecrets.mint(workspaceId);
  return { result: { connectionSecret: secret } };
};

/** `rotate_connection_secret(gatekeeperId)` — human, owner: a new secret for a self-connected gate
 *  (also how a gate connected before D-01 gets its first). The old one stops working when this
 *  commits; the gate needs the new one in its `GATE_KERNEL_TOKEN_FILE`. Refused (409) for a
 *  platform-catalog gate — the kernel authenticates to those with the platform credential. */
export const rotateConnectionSecretHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { gatekeeperId } = params as { gatekeeperId: string };
  const record = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!record) throw new GatekeeperNotFoundError(gatekeeperId);
  const platformGateId = await platformGateIdForEndpoint(client, record.endpoint);
  if (platformGateId !== null) {
    throw new ConnectionSecretConflictError(
      `rotate_connection_secret: Gatekeeper "${gatekeeperId}" is platform gate instance "${platformGateId}" — it has no connection secret (the kernel authenticates to it with the platform credential)`,
    );
  }
  const { secret, salt } = requireDeps().connectionSecrets.mint(workspaceId);
  await setGatekeeperConnectionSecretSalt(client, workspaceId, gatekeeperId, salt);
  return {
    result: { gatekeeperId, connectionSecret: secret },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
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
