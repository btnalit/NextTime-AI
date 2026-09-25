import type { ConnectionRequestStatus, PublishableStatus } from '@nexttime/shared';
import { PUBLISHABLE_STATUS_VALUES } from '@nexttime/shared';
import type { Translate } from './i18n.js';

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

// -------------------------------------------------------------------------------------------
// S8 W3-K1 (leftover 79): the console-side mirror of the kernel's own loosened/tightened
// classification (`governance/gatekeepers/manifest.ts`'s `classifyOperationGovernanceChange`) —
// used only to pick the `Confirm` tier (`medium` vs `irreversible`) *before* the owner confirms,
// since the kernel's own authoritative classification is only known from the call's result,
// after the fact. Never writes, never overrides the kernel's own audited classification.
// -------------------------------------------------------------------------------------------

export interface OperationGovernanceFieldsView {
  readonly mode: string;
  readonly blastRadius: string;
  readonly autoApprovable: boolean;
}

const GOVERNANCE_MODE_STRICTNESS: Readonly<Record<string, number>> = { observe: 0, execute: 1 };
const GOVERNANCE_BLAST_RADIUS_STRICTNESS: Readonly<Record<string, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** `true` when moving from `existing` to `announced` reduces governance friction on any field
 *  (lower blast radius, `autoApprovable` false→true, `execute`→`observe`) — same direction rule
 *  as the kernel's own `classifyOperationGovernanceChange`, just a boolean rather than a full
 *  loosened/tightened/mixed classification (the console only needs "does this need the
 *  irreversible tier", not the kernel's own per-field breakdown). */
export function isLooseningGovernanceChange(
  existing: OperationGovernanceFieldsView,
  announced: OperationGovernanceFieldsView,
): boolean {
  const existingMode = GOVERNANCE_MODE_STRICTNESS[existing.mode] ?? 0;
  const announcedMode = GOVERNANCE_MODE_STRICTNESS[announced.mode] ?? 0;
  if (announcedMode < existingMode) return true;
  const existingBlast = GOVERNANCE_BLAST_RADIUS_STRICTNESS[existing.blastRadius] ?? 0;
  const announcedBlast = GOVERNANCE_BLAST_RADIUS_STRICTNESS[announced.blastRadius] ?? 0;
  if (announcedBlast < existingBlast) return true;
  if (announced.autoApprovable && !existing.autoApprovable) return true;
  return false;
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

// -------------------------------------------------------------------------------------------
// S6-C / C26 (docs/console-completion-plan.md §5.6, §6): `cancel_connection_request` — the
// `requested → cancelled` edge the kernel finally wired (S2.13's own "known deviation", runbook
// web-console.md 已知缺口 8). Its two expected refusals map to bilingual copy here rather than
// in `lib/platform-errors.ts` (a platform-plane table, another lane's file); anything else falls
// through to `ErrorBanner` with the kernel's own message.
// -------------------------------------------------------------------------------------------

/** The kernel's answer: the same row with `status: 'cancelled'` (0005 has no `cancelled_at`
 *  column — who / when is on the `connection.request_cancelled` audit row). */
export type CancelConnectionRequestResult = ConnectionRequestRow;

const CONNECTION_ERROR_MESSAGES: Readonly<
  Record<string, { readonly zh: string; readonly en: string }>
> = {
  forbidden: {
    zh: '只能取消自己发起的申请；工作区所有者可以取消任何申请',
    en: 'Only your own request can be cancelled — the workspace owner may cancel any',
  },
  illegal_transition: {
    zh: '该申请已不在「已申请」状态，刷新后再看',
    en: 'This request is no longer in the requested state — refresh to see its current status',
  },
  not_found: { zh: '找不到该连接申请', en: 'No such connection request' },
};

/** The bilingual one-liner for a `cancel_connection_request` failure, or `null` when the code is
 *  not one of the three it can raise (callers then fall back to `ErrorBanner`). Takes the already
 *  normalized code so it stays transport-agnostic (`describeError(err).code`, HTTP or WS). A pure
 *  helper — takes `t` from its caller. */
export function cancelConnectionRequestMessage(code: string, t: Translate): string | null {
  const entry = CONNECTION_ERROR_MESSAGES[code];
  return entry ? t(entry.zh, entry.en) : null;
}
