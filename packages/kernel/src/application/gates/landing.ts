import type { GateInstanceWire, Operation, PrincipalKind } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  type ConnectionRequestKind,
  type ConnectionRequestRow,
  claimConnectionRequest,
  markConnectionRequestCompleted,
} from '../../governance/connections/index.js';
import {
  type GateOwnedParamDraft,
  type GatekeeperByEndpointEntry,
  findGatekeepersByEndpoint,
  importManifest,
  normalizeGateEndpoint,
  publishImportedDrafts,
  registerGatekeeper,
} from '../../governance/gatekeepers/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { endActivity, startActivity } from '../../substrate/epistemic/index.js';
import { enqueue } from '../../substrate/outbox/index.js';
import {
  deleteSelfConnection,
  findSelfConnection,
  insertSelfConnection,
} from './self-connections.js';
import { insertGateLink } from './store.js';

/**
 * application/gates/landing: **the one landing path** (S10 W2 P0b; leftover 73's root fix) — the
 * only code that puts a Gatekeeper into a workspace. Both ways in call it:
 *
 *   - `catalog` — `enable_gate_instance` (application/gateway/gate-instance-handlers.ts): a
 *     platform gate instance the administrator enabled and adopted the manifest of (R-18);
 *   - `self` — `create_connection` (application/gateway/connection-handlers.ts): a gate the
 *     workspace runs itself, under the generic connector of its kind in `self_serve` (D-19), with
 *     its own connection secret (D-01).
 *
 * The CLI `register-gatekeeper` was the third way and is gone: it wrote a Gatekeeper with no origin
 * and no audit row (STATUS leftover 123, L1-14 remainder). Whatever the source, one landing does,
 * in one transaction: one Activity; `registerGatekeeper` (or, for the catalog, the existing
 * Gatekeeper at the same endpoint — leftover 73); `importManifest` (origin `import`); the
 * source's publish rule; **the origin record** — a `workspace_gate_links` row for the catalog, a
 * `workspace_self_connections` row for a self connection (core 0045), so every Gatekeeper has
 * exactly one, and the platform's rules (`readGatekeeperPlatformPolicy`) reach every Gatekeeper;
 * the request card resolved (self); `ConnectionCreated`.
 *
 * What differs by source, and stays different on purpose:
 *   - **publish**: the catalog publishes what it imported (`publishImportedDrafts` — an
 *     administrator adopted that manifest and the owner previewed it); a self connection's import
 *     stays draft until an owner publishes it in the catalog (I17), and a later re-sync of it opens
 *     revisions for anything it loosens (legacy 214, `refreshOperationGovernance` source `'gate'`);
 *   - **an endpoint that already has a Gatekeeper**: the catalog links it (leftover 73 — the caller
 *     decides which one with `resolveGateLinkTarget` and passes it as `existing`); a self connection
 *     is refused (`endpoint_already_connected`): its gate carries one connection secret, and the
 *     existing Gatekeeper re-syncs with `preview_gatekeeper_resync` / rotates with
 *     `rotate_connection_secret` instead. A second Gatekeeper at the same address was the duplicate
 *     leftover 73 was about.
 *
 * Linking an existing Gatekeeper that the workspace connected itself (its address became a platform
 * instance's, or a registration from the removed CLI) converts its origin: the self-connection row
 * is deleted and the link written, with a `gatekeeper.self_connection_linked` audit row. A
 * suspended self connection is never converted (`self_connection_suspended`): the platform cut it
 * off, and enabling a catalog instance must not be a way around that.
 *
 * Preconditions stay with the callers, before any I/O they would gate: the connector mode (D-19),
 * the catalog address guard, the connection secret and the outbound-target predicate (R-01, R-27)
 * for `create_connection`; the instance's availability and the manifest digest (R-18) for
 * `enable_gate_instance`. The landing re-checks what it writes against: the endpoint (self), the
 * self-connection state (catalog link).
 */

export interface LandingActor {
  readonly id: string;
  readonly kind: PrincipalKind;
}

export interface CatalogLandingSource {
  readonly kind: 'catalog';
  /** An available instance (`requireAvailable`, gate-instance-handlers.ts). */
  readonly instance: GateInstanceWire;
  /** The instance's manifest in effect, read under the caller's digest check (R-18). */
  readonly operations: readonly Operation[];
  /** The one existing Gatekeeper at the instance's endpoint to link (`resolveGateLinkTarget`), or
   *  `null` to register a new one. */
  readonly existing: GatekeeperByEndpointEntry | null;
}

export interface SelfLandingSource {
  readonly kind: 'self';
  /** The generic connector of the gate's transport kind — the one the caller checked `self_serve`. */
  readonly connector: ConnectionRequestKind;
  readonly target: string;
  readonly endpoint: string;
  readonly connectionSecretSalt: string;
  readonly operations: readonly Operation[];
  /** The `request_connection` card this resolves, when there is one. */
  readonly connectionRequestId?: string;
}

export type LandingSource = CatalogLandingSource | SelfLandingSource;

export interface LandingResult {
  readonly gatekeeperId: string;
  /** Catalog: the existing Gatekeeper at the endpoint was linked instead of registering one. */
  readonly linkedExisting: boolean;
  /** Catalog: that existing Gatekeeper was a self connection, whose origin row was replaced. */
  readonly convertedSelfConnection: boolean;
  readonly importedOperationNames: readonly string[];
  readonly skippedOperationNames: readonly string[];
  /** Catalog only (a self connection publishes nothing). */
  readonly publishedOperationNames: readonly string[];
  readonly gateOwnedParamDrafts: readonly GateOwnedParamDraft[];
  /** Self: the resolved `request_connection` card, when one was given. */
  readonly connectionRequest: ConnectionRequestRow | null;
}

export class GatekeeperLandingRefusedError extends Error {
  readonly code: 'endpoint_already_connected' | 'self_connection_suspended';
  readonly gatekeeperId: string;
  constructor(code: GatekeeperLandingRefusedError['code'], gatekeeperId: string, message: string) {
    super(message);
    this.name = 'GatekeeperLandingRefusedError';
    this.code = code;
    this.gatekeeperId = gatekeeperId;
  }
}

/**
 * The self-connection rule on an address (module doc comment): refused when this workspace already
 * has a Gatekeeper at `endpoint` (same comparison as leftover 73's association,
 * `findGatekeepersByEndpoint`). `create_connection` calls it before any network I/O; the landing
 * calls it again under its lock, where it decides.
 */
export async function assertEndpointFreeForSelfConnection(
  client: PoolClient,
  workspaceId: string,
  endpoint: string,
): Promise<void> {
  const [existing] = await findGatekeepersByEndpoint(client, workspaceId, endpoint);
  if (!existing) return;
  throw new GatekeeperLandingRefusedError(
    'endpoint_already_connected',
    existing.gatekeeperId,
    `this workspace already has Gatekeeper "${existing.name}" (${existing.gatekeeperId}) at endpoint "${endpoint}" — re-sync it (preview_gatekeeper_resync) or give its gate a new secret (rotate_connection_secret) instead of connecting it again`,
  );
}

/** Refuses linking a self-connected Gatekeeper the platform suspended (module doc comment). The
 *  preview calls it too, so it never offers a link the enable would refuse. */
export async function assertSelfConnectionNotSuspended(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<void> {
  const selfConnection = await findSelfConnection(client, workspaceId, gatekeeperId);
  if (selfConnection?.suspendedAt) throw selfConnectionSuspended(gatekeeperId);
}

function selfConnectionSuspended(gatekeeperId: string): GatekeeperLandingRefusedError {
  return new GatekeeperLandingRefusedError(
    'self_connection_suspended',
    gatekeeperId,
    `Gatekeeper ${gatekeeperId} is a self connection the platform administrator suspended — it cannot be linked to a platform gate instance or re-synced until the administrator resumes it`,
  );
}

export async function landGatekeeper(
  client: PoolClient,
  workspaceId: string,
  actor: LandingActor,
  source: LandingSource,
): Promise<LandingResult> {
  if (source.kind === 'self') {
    // Serializes self connections to one address in this workspace, so the check below is exact.
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
      `land_self:${workspaceId}:${normalizeGateEndpoint(source.endpoint)}`,
    ]);
    await assertEndpointFreeForSelfConnection(client, workspaceId, source.endpoint);
  }
  const connectionRequest =
    source.kind === 'self' && source.connectionRequestId
      ? await claimConnectionRequest(client, workspaceId, source.connectionRequestId)
      : null;

  let convertedSelfConnection = false;
  if (source.kind === 'catalog' && source.existing) {
    await assertSelfConnectionNotSuspended(client, workspaceId, source.existing.gatekeeperId);
  }

  const activity = await startActivity(
    client,
    workspaceId,
    source.kind === 'catalog'
      ? {
          kind: 'governance.enable_gate_instance',
          principalId: actor.id,
          metadata: source.existing
            ? {
                gateId: source.instance.gateId,
                linkedExisting: true,
                gatekeeperId: source.existing.gatekeeperId,
              }
            : { gateId: source.instance.gateId },
        }
      : {
          kind: 'governance.create_connection',
          principalId: actor.id,
          metadata: { kind: source.connector, target: source.target },
        },
  );

  let gatekeeperId: string;
  if (source.kind === 'catalog' && source.existing) {
    // No `registerGatekeeper` — no new Gatekeeper, no new `ConnectedSystem` (leftover 73). The
    // existing Object's name / target / transportKind are left as they were.
    gatekeeperId = source.existing.gatekeeperId;
  } else if (source.kind === 'catalog') {
    const { instance } = source;
    ({ gatekeeperId } = await registerGatekeeper(client, workspaceId, {
      name: instance.displayName,
      transportKind: instance.transportKind,
      target: instance.target || instance.displayName,
      endpoint: instance.endpoint,
      activityId: activity.id,
      registeredBy: actor,
    }));
  } else {
    ({ gatekeeperId } = await registerGatekeeper(client, workspaceId, {
      name: source.target,
      transportKind: source.connector,
      target: source.target,
      endpoint: source.endpoint,
      connectionSecretSalt: source.connectionSecretSalt,
      activityId: activity.id,
      registeredBy: actor,
    }));
  }

  const imported = await importManifest(client, workspaceId, {
    gatekeeperId,
    operations: source.operations,
    proposedBy: actor,
    activityId: activity.id,
  });
  const published =
    source.kind === 'catalog'
      ? await publishImportedDrafts(client, workspaceId, gatekeeperId, imported.imported)
      : { publishedOperationNames: [], gateOwnedParamDrafts: [] };

  // The origin record — exactly one per Gatekeeper.
  let resolvedRequest: ConnectionRequestRow | null = null;
  if (source.kind === 'catalog') {
    // The link first: core 0045 lets a workspace delete its self-connection row only once the
    // Gatekeeper has a link, so it never drops out of the platform's view (#620 review P3-1).
    await insertGateLink(client, {
      workspaceId,
      gateId: source.instance.gateId,
      gatekeeperObjectId: gatekeeperId,
      enabledBy: actor.id,
    });
    const before = source.existing
      ? await findSelfConnection(client, workspaceId, gatekeeperId)
      : null;
    if (before) {
      // `assertSelfConnectionNotSuspended` ran before the import; a suspension committed since
      // leaves the row undeletable (RLS: only unsuspended rows), and linking anyway would put a
      // catalog link next to a suspended connection (#620 review M1) — refuse, so the whole
      // landing rolls back.
      if (!(await deleteSelfConnection(client, workspaceId, gatekeeperId))) {
        throw selfConnectionSuspended(gatekeeperId);
      }
      convertedSelfConnection = true;
      await writeAudit(client, {
        workspaceId,
        actorPrincipalId: actor.id,
        action: 'gatekeeper.self_connection_linked',
        resourceType: 'gatekeeper',
        resourceId: gatekeeperId,
        payload: {
          gateId: source.instance.gateId,
          connector: source.instance.connector,
          selfConnection: {
            connector: before.connector,
            target: before.target,
            endpoint: before.endpoint,
            connectedBy: before.connectedBy,
            connectedAt: before.connectedAt.toISOString(),
          },
        },
      });
    }
  } else {
    await insertSelfConnection(client, {
      workspaceId,
      gatekeeperObjectId: gatekeeperId,
      connector: source.connector,
      target: source.target,
      endpoint: source.endpoint,
      connectedBy: actor.id,
    });
    if (connectionRequest) {
      resolvedRequest = await markConnectionRequestCompleted(client, workspaceId, {
        connectionRequestId: connectionRequest.id,
        gatekeeperId,
        completedBy: actor.id,
      });
    }
  }
  await endActivity(client, workspaceId, activity.id, 'completed');

  await enqueue(client, {
    type: 'ConnectionCreated',
    workspaceId,
    gatekeeperId,
    kind: source.kind === 'catalog' ? source.instance.transportKind : source.connector,
    target:
      source.kind === 'catalog'
        ? source.instance.target || source.instance.displayName
        : source.target,
  });

  return {
    gatekeeperId,
    linkedExisting: source.kind === 'catalog' && source.existing !== null,
    convertedSelfConnection,
    importedOperationNames: imported.imported.map((record) => record.name),
    skippedOperationNames: imported.skipped.map((entry) => entry.name),
    publishedOperationNames: published.publishedOperationNames,
    gateOwnedParamDrafts: published.gateOwnedParamDrafts,
    connectionRequest: resolvedRequest,
  };
}
