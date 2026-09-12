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
      typeof object.properties.blast_radius === 'string'
        ? object.properties.blast_radius
        : undefined,
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

// -------------------------------------------------------------------------------------------
// S3.12 onboarding wizard step ④ (review operations + "propose reclassification") — needs the
// *full* Operation payload (`binding`/`params_schema`/`reversibility`/`await_decision`/`reads`/
// `writes`), not the narrow `{name, mode, blastRadius}` `OperationView` above. Neither
// `list_operations` nor `get_gatekeeper` project those fields (`gatekeeper-read-handlers.ts`'s
// `toWireOperationSummary`, on `main` as of PR #100) — `search{objectType:'Operation'}`'s raw
// `properties` is the one human-facing read that does, because `registerOperationDraftObject`
// (`substrate/ontology/meta-objects.ts`) writes the whole `Operation` object into `properties`
// verbatim, snake_case field names and all, alongside its own bookkeeping (`status`/`origin`/
// `proposedBy`/`proposedByKind`).
// -------------------------------------------------------------------------------------------

export interface OperationDetailView {
  readonly objectId: string;
  readonly gatekeeperId: string;
  readonly name: string;
  readonly status: string;
  readonly mode: string;
  readonly blastRadius: string;
  readonly autoApprovable: boolean;
  readonly paramsSchema: Readonly<Record<string, unknown>>;
  /** The raw `properties` bag, verbatim — everything `propose_operation`'s `operation` param
   *  needs beyond what this view already surfaces (`binding`/`reversibility`/`await_decision`/
   *  `reads`/`writes`/`result_mapping`), plus the Object's own bookkeeping fields that
   *  `reclassifiedOperationPayload` strips back out. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export function operationDetailFromObject(object: GraphObjectRow): OperationDetailView | undefined {
  const identity = object.identityKey ?? {};
  const gatekeeperId = identity.gatekeeperId;
  const name = identity.name ?? object.properties.name;
  if (typeof gatekeeperId !== 'string' || typeof name !== 'string') return undefined;
  const props = object.properties;
  const paramsSchema =
    props.params_schema && typeof props.params_schema === 'object'
      ? (props.params_schema as Record<string, unknown>)
      : {};
  return {
    objectId: object.id,
    gatekeeperId,
    name,
    status: typeof props.status === 'string' ? props.status : 'draft',
    mode: typeof props.mode === 'string' ? props.mode : 'observe',
    blastRadius: typeof props.blast_radius === 'string' ? props.blast_radius : 'low',
    autoApprovable: props.auto_approvable === true,
    paramsSchema,
    raw: props,
  };
}

/** Builds `propose_operation`'s `operation` param (`@nexttime/shared`'s `OperationSchema`) from a
 *  previously-read `OperationDetailView`, applying the reader's mode/blast_radius/auto_approvable
 *  overrides and stripping the Object's own bookkeeping fields (`status`/`origin`/`proposedBy`/
 *  `proposedByKind` — not part of `OperationSchema`, `registerOperationDraftObject`'s own doc
 *  comment) — everything else (`binding`/`params_schema`/`reversibility`/`await_decision`/
 *  `reads`/`writes`/`result_mapping`) passes through unchanged, since this UI never edits them. */
export function reclassifiedOperationPayload(
  detail: OperationDetailView,
  overrides: {
    readonly mode: string;
    readonly blastRadius: string;
    readonly autoApprovable: boolean;
  },
): Record<string, unknown> {
  const {
    status: _status,
    origin: _origin,
    proposedBy: _proposedBy,
    proposedByKind: _proposedByKind,
    ...rest
  } = detail.raw;
  return {
    ...rest,
    name: detail.name,
    mode: overrides.mode,
    blast_radius: overrides.blastRadius,
    auto_approvable: overrides.autoApprovable,
  };
}

/**
 * `search` returns the list envelope `{items, nextCursor?}` since W5 (docs/wire-contract-conventions.md
 * §3); before that it returned a bare array, and these pages kept reading it as one — every
 * registered-systems list on the console has shown "F.map is not a function" since (found by the
 * P-B1 e2e). Accept both shapes so an older kernel and the test fakes keep working.
 */
export function searchItems<T>(result: unknown): readonly T[] {
  if (Array.isArray(result)) return result as readonly T[];
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { items?: unknown }).items)
  ) {
    return (result as { items: readonly T[] }).items;
  }
  return [];
}
