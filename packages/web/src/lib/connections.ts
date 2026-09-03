import type { ConnectionRequestStatus, PublishableStatus } from '@nexttime/shared';
import { PUBLISHABLE_STATUS_VALUES } from '@nexttime/shared';

/**
 * lib/connections: wire shapes of the S2.13 connection flow as the web reads them —
 * `list_connection_requests` rows (`governance/connections/types.ts` `ConnectionRequestRow`),
 * `create_connection`'s result (`application/gateway/connection-handlers.ts`), and the graph
 * Objects `search` returns for `Gatekeeper`/`Operation` (`substrate/graph/store.ts` `GraphObject`;
 * properties written by `substrate/ontology/meta-objects.ts`).
 */
export const CONNECTION_KIND_VALUES = ['http', 'mcp', 'cli', 'ssh'] as const;
export type ConnectionKind = (typeof CONNECTION_KIND_VALUES)[number];

export interface ConnectionRequestRow {
  readonly id: string;
  readonly status: ConnectionRequestStatus;
  readonly kind: ConnectionKind;
  readonly target: string;
  readonly requestedBy: string;
  readonly gatekeeperId: string | null;
  readonly completedBy: string | null;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

export interface CreateConnectionParams {
  readonly connectionRequestId?: string;
  readonly kind: ConnectionKind;
  readonly target: string;
  readonly endpoint: string;
  readonly credentials?: unknown;
  readonly credentialKind?: 'shared' | 'connected_account';
  readonly onBehalfOf?: string;
  readonly manifestSource?: string;
}

export interface CreateConnectionResult {
  readonly gatekeeperId: string;
  readonly importedOperationNames: readonly string[];
  readonly connectionRequestId: string | null;
}

/** `substrate/graph/store.ts` `GraphObject` over the wire. */
export interface GraphObjectRow {
  readonly id: string;
  readonly objectType: string;
  readonly identityKey: Readonly<Record<string, unknown>> | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GatekeeperView {
  readonly id: string;
  readonly name: string;
  readonly transportKind: string;
  readonly target: string;
  readonly endpoint: string | undefined;
  readonly updatedAt: string;
}

export interface OperationView {
  readonly objectId: string;
  readonly gatekeeperId: string;
  readonly name: string;
  readonly status: PublishableStatus | string;
  readonly mode: string | undefined;
  readonly blastRadius: string | undefined;
}

export function gatekeeperFromObject(object: GraphObjectRow): GatekeeperView {
  const props = object.properties;
  return {
    id: object.id,
    name: typeof props.name === 'string' ? props.name : object.id,
    transportKind: typeof props.transportKind === 'string' ? props.transportKind : 'unknown',
    target: typeof props.target === 'string' ? props.target : '',
    endpoint: typeof props.endpoint === 'string' ? props.endpoint : undefined,
    updatedAt: object.updatedAt,
  };
}

/** `Operation` Objects carry `{gatekeeperId, name}` as identity and the manifest entry plus
 *  `status` as properties (`registerOperationDraftObject`). */
export function operationFromObject(object: GraphObjectRow): OperationView | undefined {
  const identity = object.identityKey ?? {};
  const gatekeeperId = identity.gatekeeperId;
  const name = identity.name ?? object.properties.name;
  if (typeof gatekeeperId !== 'string' || typeof name !== 'string') return undefined;
  const status = object.properties.status;
  return {
    objectId: object.id,
    gatekeeperId,
    name,
    status: typeof status === 'string' ? status : 'draft',
    mode: typeof object.properties.mode === 'string' ? object.properties.mode : undefined,
    blastRadius:
      typeof object.properties.blast_radius === 'string' ? object.properties.blast_radius : undefined,
  };
}

/** Operations grouped by lifecycle status in the shared enum's order (draft, published, deprecated). */
export function groupOperationsByStatus(
  operations: readonly OperationView[],
): readonly { readonly status: string; readonly operations: readonly OperationView[] }[] {
  const known = PUBLISHABLE_STATUS_VALUES.map((status) => ({
    status,
    operations: operations.filter((operation) => operation.status === status),
  }));
  const other = operations.filter(
    (operation) => !(PUBLISHABLE_STATUS_VALUES as readonly string[]).includes(operation.status),
  );
  const groups = [...known];
  if (other.length > 0) groups.push({ status: 'unknown' as PublishableStatus, operations: other });
  return groups.filter((group) => group.operations.length > 0);
}

/** Whether `manifestSource` means anything for a kind (`connection-handlers.ts`: http → OpenAPI
 *  document URL, mcp → MCP endpoint; ignored for cli/ssh). */
export function supportsManifestSource(kind: ConnectionKind): boolean {
  return kind === 'http' || kind === 'mcp';
}
