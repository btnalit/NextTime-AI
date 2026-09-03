import { McpTransport, importMcpTools, importOpenApi } from '@nexttime/gatekeeper-base';
import type { McpToolsListResult, OpenApiDocumentLike } from '@nexttime/gatekeeper-base';
import type { Operation, PrincipalKind } from '@nexttime/shared';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import type { ConnectionRequestKind } from '../../governance/connections/index.js';
import {
  completeConnection,
  connectGatekeeper,
  listConnectionRequests,
  requestConnection,
} from '../../governance/connections/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { currentPrincipalId } from '../chat/index.js';
import type { CapabilityHandler } from './capability-handler.js';

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
    result: { connectionRequestId: row.id, status: row.status },
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

  return { result: grant, resourceType: 'capability_grant', resourceId: grant.id };
};

/** `list_connection_requests` — owner's queue (§9.3). */
export const listConnectionRequestsHandler: CapabilityHandler = async (
  client,
  workspaceId,
  params,
) => {
  const { status } = params as { status?: 'requested' | 'completed' | 'cancelled' };
  const rows = await listConnectionRequests(client, workspaceId, { status });
  return { result: { connectionRequests: rows } };
};
