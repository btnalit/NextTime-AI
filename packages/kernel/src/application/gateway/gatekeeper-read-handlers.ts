import type { PoolClient } from 'pg';
import {
  GatekeeperClientError,
  HttpGatekeeperClient,
} from '../../adapters/gatekeeper-client/index.js';
import type { GatekeeperClient } from '../../adapters/gatekeeper-client/index.js';
import { getOperationStats } from '../../governance/approval/index.js';
import type { OperationStatsRow } from '../../governance/approval/index.js';
import {
  type GatekeeperListEntry,
  GatekeeperNotFoundError,
  type OperationRecord,
  countOperationsByGatekeeper,
  getGatekeeper,
  listGatekeepers,
  listOperations,
} from '../../governance/gatekeepers/index.js';
import type { GateLinkPolicyView } from '../gates/index.js';
import { operationPlatformStatus, readGateLinkPolicy } from '../gates/index.js';
import type { CapabilityHandler } from './capability-handler.js';

/**
 * application/gateway/gatekeeper-read-handlers: the S3.11 "系统接入" directory reads
 * (docs/development-tasks.md "中台控制面") — `list_gatekeepers` / `get_gatekeeper` /
 * `list_operations`. Read-only projections over `governance/gatekeepers`'s own service interface;
 * `get_gatekeeper`'s live health probe is the one piece of IO this file adds on top.
 */

export { GatekeeperNotFoundError };

// -------------------------------------------------------------------------------------------
// Health probe — a short-timeout, never-throws call to the gate's own `/gate/health`. Deliberately
// its own `HttpGatekeeperClient` instance, not the one shared `gatekeeperClient`
// `packages/kernel/src/index.ts`'s `createServer()` already builds and wires into
// `setRequestActionDeps`/`setConnectionHandlerDeps` (that instance's own `buildGatekeeperExecutionDeps`
// doc comment: "the single shared executor path") — this task's own dispatch calls for "a short
// timeout" specifically for this interactive, human-facing probe, distinct from the 15s default
// (`adapters/gatekeeper-client/index.ts`'s `DEFAULT_TIMEOUT_MS`) `request_action`/`create_connection`
// need for a real (possibly slow) upstream call; reusing the long-timeout instance would make a
// down gate hang the console for up to 15s instead of failing fast. Same "module-level singleton,
// overridable for tests" seam shape `connection-handlers.ts`/`request-action-handler.ts` each
// already established for their own gatekeeper client, kept as its own seam rather than reaching
// into either of those files' private module state.
// -------------------------------------------------------------------------------------------

export type GatekeeperHealth = 'ok' | 'unreachable' | 'unauthorized';

const HEALTH_PROBE_TIMEOUT_MS = 3_000;

export interface GatekeeperReadHandlerDeps {
  readonly gatekeeperClient?: GatekeeperClient;
}

let overrideClient: GatekeeperClient | undefined;
let lazyDefaultClient: GatekeeperClient | undefined;

/** Composition-root/test seam — omit `gatekeeperClient` to fall back to a lazily-constructed
 *  `HttpGatekeeperClient` (reads the gate token from `NEXTTIME_GATE_TOKEN_FILE` the same way
 *  every other production gatekeeper client in this codebase does); production wiring needs no
 *  call to this function at all. */
export function setGatekeeperReadHandlerDeps(deps: GatekeeperReadHandlerDeps): void {
  overrideClient = deps.gatekeeperClient;
}

function resolveClient(): GatekeeperClient {
  if (overrideClient) return overrideClient;
  if (!lazyDefaultClient) {
    lazyDefaultClient = new HttpGatekeeperClient({ timeoutMs: HEALTH_PROBE_TIMEOUT_MS });
  }
  return lazyDefaultClient;
}

/**
 * `get_gatekeeper`'s live health field — task brief: "call the existing gatekeeper client health
 * with a short timeout; health: 'ok' | 'unreachable' | 'unauthorized', never throw on failure".
 * The gate's own `/gate/health` reports a finer three-way `ok | degraded | down`
 * (`@nexttime/gatekeeper-base`'s `HealthResponseSchema`) — collapsed here to this capability's
 * fixed three-value contract: `degraded`/`down` both read as `unreachable` (the gate answered,
 * but is not confirmed fully healthy; a future revision could surface the finer value once a
 * console actually distinguishes them). A 401 from the gate's own auth layer is `unauthorized`;
 * any other failure (timeout, network error, non-401 gate error) is `unreachable`. Never throws.
 */
/** P-B1 `test_gate_instance`: the gate's live `describe_operations`, through the same client. */
export async function describeGateOperations(endpoint: string) {
  return resolveClient().describeOperations(endpoint);
}

/** P-B1 (design §6.3 "按 Operation 开关"): the connector deny-list link for a workspace Gatekeeper
 *  — `null` for a gate the workspace connected itself (no platform link). Read projections hide a
 *  disabled Operation via `operationPlatformStatus` (application/gates/index.ts) below, the same
 *  shared predicate `request_action` / `observe_operation` refuse it with per call. */
async function gateLinkPolicyFor(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GateLinkPolicyView | null> {
  return readGateLinkPolicy(client, workspaceId, gatekeeperId);
}

export async function probeGatekeeperHealth(endpoint: string): Promise<GatekeeperHealth> {
  try {
    const response = await resolveClient().health(endpoint);
    return response.status === 'ok' ? 'ok' : 'unreachable';
  } catch (err) {
    if (err instanceof GatekeeperClientError && err.status === 401) return 'unauthorized';
    return 'unreachable';
  }
}

// -------------------------------------------------------------------------------------------
// Wire projection
// -------------------------------------------------------------------------------------------

/** No Gatekeeper lifecycle state exists yet in the domain model (unlike Operations, which have a
 *  real draft/published/deprecated status, §5.5) — a registered instance has no deactivation
 *  mechanism yet, so this always reports `'active'` until a real Gatekeeper lifecycle is added. */
const GATEKEEPER_STATUS = 'active';

function toWireGatekeeperSummary(entry: GatekeeperListEntry, operationCount: number) {
  return {
    id: entry.gatekeeperId,
    name: entry.name,
    kind: entry.transportKind,
    status: GATEKEEPER_STATUS,
    // manifestVersion is omitted, not fabricated: no per-manifest version counter exists in the
    // domain model (an imported/published Operation is upserted in place, §5.5) — left optional
    // on the wire (docs/development-tasks.md S3.11 "manifestVersion?") for when one does.
    operationCount,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Shared by both `get_gatekeeper`'s embedded `operations[]` (task brief's own listed shape:
 * `{name, mode, blastRadius, autoApprovable, version, status}`) and `list_operations`'s cross-gate
 * `{items}`. `gatekeeperId` is additive on top of that listed shape — `get_gatekeeper` already
 * identifies the gate by context (harmless extra field there), but `list_operations` is
 * explicitly the "按门分组" (grouped by gate) human directory *across* gates (task brief), which is
 * not actually groupable without knowing which gate each item belongs to; omitting it would make
 * that directory unusable the moment more than one Gatekeeper is registered.
 */
function toWireOperationSummary(record: OperationRecord) {
  return {
    gatekeeperId: record.gatekeeperId,
    name: record.name,
    mode: record.operation.mode,
    blastRadius: record.operation.blast_radius,
    autoApprovable: record.operation.auto_approvable,
    // S3.12: a real per-identity revision counter now exists (`propose_operation`'s
    // published→draft revision path, `governance/gatekeepers/manifest.ts`'s own module doc
    // comment) — no longer hardcoded to `1`. See `countOperationsByGatekeeper`'s own doc comment
    // for the sibling `manifestVersion?` decision at the Gatekeeper level, which is unaffected.
    version: record.version,
    status: record.status,
    // S8 W3-K1 (leftover 81, audit CO1): the catalog page needs the current description both to
    // render "未填写描述" for a blank one and to prefill the edit dialog — absent (never an empty
    // string) mirrors `OperationSchema.description`'s own optionality.
    ...(record.operation.description !== undefined
      ? { description: record.operation.description }
      : {}),
  };
}

// -------------------------------------------------------------------------------------------
// Capability handlers
// -------------------------------------------------------------------------------------------

// S8 W1-C (selector data source, F6 item 3): `q` filters in application code, after the
// pre-existing full read — a workspace's Gatekeeper directory is small (operator-managed
// connections, not user-generated data), so this stays a plain in-memory substring match rather
// than adding a SQL-level filter to `governance/gatekeepers/registry.ts`'s own query for a picker
// list this size.
function matchesQuery(name: string, q: string | undefined): boolean {
  return q === undefined || name.toLowerCase().includes(q.toLowerCase());
}

export const listGatekeepersHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { q } = params as { q?: string };
  // S5.5 leftover 34: one client, one query at a time (pg@9 rejects concurrent queries on a client).
  const entries = await listGatekeepers(client, workspaceId);
  const operationCounts = await countOperationsByGatekeeper(client, workspaceId);
  return {
    result: {
      items: entries
        .filter((entry) => matchesQuery(entry.name, q))
        .map((entry) =>
          toWireGatekeeperSummary(entry, operationCounts.get(entry.gatekeeperId) ?? 0),
        ),
    },
  };
};

export const getGatekeeperHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId } = params as { gatekeeperId: string };
  const record = await getGatekeeper(client, workspaceId, gatekeeperId);
  if (!record) throw new GatekeeperNotFoundError(gatekeeperId);

  // The health probe is a network call, so it may overlap the reads; the two reads share one
  // client and run one after the other (S5.5 leftover 34).
  const healthProbe = probeGatekeeperHealth(record.endpoint);
  const allOperations = await listOperations(client, workspaceId, { gatekeeperId });
  const gateLink = await gateLinkPolicyFor(client, workspaceId, gatekeeperId);
  const health = await healthProbe;
  const operations = allOperations.filter(
    (op) => !operationPlatformStatus(gateLink, op.name).disabled,
  );

  const summary = toWireGatekeeperSummary(
    {
      gatekeeperId: record.gatekeeperId,
      name: record.name,
      transportKind: record.transportKind,
      endpoint: record.endpoint,
      createdAt: record.createdAt,
    },
    operations.length,
  );

  return {
    result: {
      ...summary,
      operations: operations.map(toWireOperationSummary),
      health,
    },
    resourceType: 'gatekeeper',
    resourceId: gatekeeperId,
  };
};

export const listOperationsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId, q } = params as { gatekeeperId?: string; q?: string };
  const records = await listOperations(client, workspaceId, { gatekeeperId });
  // P-B1: hide connector-disabled Operations, per gatekeeper (one deny-list read each).
  const linksByGatekeeper = new Map<string, GateLinkPolicyView | null>();
  const visible = [];
  for (const record of records) {
    if (!matchesQuery(record.name, q)) continue;
    let link = linksByGatekeeper.get(record.gatekeeperId);
    if (link === undefined) {
      link = await gateLinkPolicyFor(client, workspaceId, record.gatekeeperId);
      linksByGatekeeper.set(record.gatekeeperId, link);
    }
    if (!operationPlatformStatus(link, record.name).disabled) visible.push(record);
  }
  return { result: { items: visible.map(toWireOperationSummary) } };
};

/** `get_operation_stats` (S3.12 catalog-usage follow-up) — no existence check on `gatekeeperId`,
 *  same choice `listOperationsHandler` above already makes: an unknown/mistyped id simply narrows
 *  to zero rows rather than a 404, since this is a filter, not a single-resource lookup. */
const DEFAULT_OPERATION_STATS_DAYS = 30;

function toWireOperationStats(row: OperationStatsRow) {
  return {
    gatekeeperId: row.gatekeeperId,
    operationName: row.operationName,
    calls: row.calls,
    approved: row.approved,
    rejected: row.rejected,
    autoApproved: row.autoApproved,
    failed: row.failed,
    observeCalls: row.observeCalls,
    lastCalledAt: row.lastCalledAt.toISOString(),
  };
}

export const getOperationStatsHandler: CapabilityHandler = async (client, workspaceId, params) => {
  const { gatekeeperId, days } = params as { gatekeeperId?: string; days?: number };
  const stats = await getOperationStats(client, workspaceId, {
    gatekeeperId,
    days: days ?? DEFAULT_OPERATION_STATS_DAYS,
  });
  return { result: { items: stats.map(toWireOperationStats) } };
};
