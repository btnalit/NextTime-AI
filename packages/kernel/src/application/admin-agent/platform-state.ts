import {
  CAPABILITY_REGISTRY,
  CONNECTOR_NAME_PATTERN,
  ConnectorModeWireSchema,
  type ConnectorWire,
  GateHealthWireSchema,
  GateInstanceStatusWireSchema,
  type GateInstanceWire,
  GateTransportKindWireSchema,
  GateTrustWireSchema,
  PLATFORM_STATE_AUDIT_ACTION_PATTERN,
  PLATFORM_STATE_AUDIT_RECENT_LIMIT,
  PLATFORM_STATE_AUDIT_SCAN_ROWS,
  PLATFORM_STATE_AUDIT_WINDOW_HOURS,
  PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT,
  PLATFORM_STATE_GATES_LIMIT,
  PLATFORM_STATE_GATE_ID_PATTERN,
  PLATFORM_STATE_OPERATION_NAME_PATTERN,
  PLATFORM_STATE_RESOURCE_TYPE_PATTERN,
  type PendingGateManifestWire,
  type PlatformStateAuditActorWire,
  type PlatformStateAuditWire,
  type PlatformStateConnectorWire,
  type PlatformStateConnectorsWire,
  type PlatformStateGateWire,
  type PlatformStateGatesWire,
  type PlatformStatePendingManifestWire,
  capabilityHasSideEffects,
  isGenericConnector,
  isIpLiteral,
} from '@nexttime/shared';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { withPlatform } from '../../adapters/db/platform-context.js';
import type { PoolLike } from '../../adapters/db/pool.js';
import { ADMIN_AGENT_SESSION_KIND } from '../../governance/capability/index.js';
import { findSuspectedSecrets } from '../../governance/redaction/index.js';
import { writeAudit } from '../../substrate/audit/index.js';
import { listConnectors, listGateInstances } from '../gates/index.js';
import {
  AdminAgentRefused,
  adminAgentEnabled,
  adminAgentRefusalOf,
  readAdminAgentAuthorityFacts,
} from './identity.js';

/**
 * application/admin-agent/platform-state (S11 AA2; docs/goal-orchestration-and-admin-agent-plan-
 * 2026-10-16.md §5.2, §5.7): what an admin agent reads of the platform — the `platform_state_*`
 * capabilities (`adminAgentOnly`; wire/platform-state.ts in `@nexttime/shared`).
 *
 * The read is the call's second phase (`afterCommit`, dispatch.ts): the first, in the agent's own
 * workspace, checked its session and authority (I-A3) and wrote that workspace's audit row. Here
 * {@link readPlatformStateForAdminAgent} opens a platform transaction as the agent's administrator,
 * `READ ONLY` (Postgres refuses any write in it, whatever policy would admit one), checks the
 * authority again inside it — closing the window between the two phases — and reads. Then a
 * separate short platform transaction records the read on the platform's audit (who, which admin
 * agent session, which section, how many items — never what): what the agent read is the
 * platform's, so the platform's audit shows it, under the same correlation id as the workspace
 * row. If that record cannot be written the agent gets nothing.
 *
 * What it reads is projected field by field, never spread (`project*` below, pure): a string passes
 * only in its shape (an enum, a pattern, an ISO timestamp) and is dropped or nulled otherwise, so a
 * field added to a source later never reaches the agent by accident. No address, command,
 * credential, free text, other workspace's identity or other person's login is in any output.
 */

/** Who the read is for: the call's workspace and Principal, the admin agent's session, and the
 *  platform user the first phase checked it acts for. */
export interface AdminAgentPlatformReader {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/** A section's read: its result, and how many items it returned (what the audit records). */
export interface PlatformStateRead<T> {
  readonly result: T;
  readonly returned: number;
}

/**
 * Runs `read` for an admin agent in a read-only platform transaction as its administrator, after
 * checking its authority again there (throws {@link AdminAgentRefused}), then records the read on
 * the platform's audit as `action` in a transaction of its own. Resolves with the read's result
 * only once that record is written.
 */
export async function readPlatformStateForAdminAgent<T>(
  pool: PoolLike,
  reader: AdminAgentPlatformReader,
  action: string,
  read: (client: PoolClient) => Promise<PlatformStateRead<T>>,
): Promise<T> {
  const done = await withPlatform(
    pool,
    { userId: reader.userId },
    async (client) => {
      const facts = await readAdminAgentAuthorityFacts(
        client,
        reader.workspaceId,
        reader.principalId,
      );
      const refusal = adminAgentRefusalOf(facts, adminAgentEnabled());
      if (refusal !== null) throw new AdminAgentRefused(refusal, reader.principalId);
      if (facts?.userId !== reader.userId) {
        throw new AdminAgentRefused('user_changed', reader.principalId);
      }
      return read(client);
    },
    { readOnly: true },
  );
  await withPlatform(pool, { userId: reader.userId }, (client) =>
    writeAudit(client, {
      workspaceId: null,
      actorPrincipalId: null,
      actorUserId: reader.userId,
      action,
      payload: {
        channel: 'handle',
        sessionKind: ADMIN_AGENT_SESSION_KIND,
        sessionId: reader.sessionId,
        workspaceId: reader.workspaceId,
        onBehalfOf: reader.principalId,
        returned: done.returned,
      },
    }),
  );
  return done.result;
}

// -------------------------------------------------------------------------------------------
// shapes
// -------------------------------------------------------------------------------------------

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** `value` when it is a string of `pattern`'s shape that is neither an IP literal nor looks like
 *  a credential (the redactor's value patterns) — a dotted address or a vendor key can be a plain
 *  identifier too — else `null`. */
function shaped(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' &&
    pattern.test(value) &&
    !isIpLiteral(value) &&
    findSuspectedSecrets(value).count === 0
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  return shaped(value, ISO_TIMESTAMP);
}

/** `value` when `schema` (an enum) accepts it, else `null`. */
function member<T extends string>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

// -------------------------------------------------------------------------------------------
// gates
// -------------------------------------------------------------------------------------------

function projectPendingManifest(
  pending: PendingGateManifestWire | null | undefined,
): PlatformStatePendingManifestWire | null {
  if (pending === null || pending === undefined) return null;
  const announcedAt = timestamp(pending.announcedAt);
  if (announcedAt === null) return null;
  return {
    announcedAt,
    operationCount: count(pending.operationCount),
    addedCount: lengthOf(pending.added),
    removedCount: lengthOf(pending.removed),
    changedCount: lengthOf(pending.changed),
    refusedOperationCount: lengthOf(pending.refusedOperations),
  };
}

/** One gate instance as an admin agent sees it, or `null` when its identity, kind, state or
 *  timestamps are out of shape (never in a row the store wrote; checked, not trusted). */
export function projectGateInstance(instance: GateInstanceWire): PlatformStateGateWire | null {
  const gateId = shaped(instance.gateId, PLATFORM_STATE_GATE_ID_PATTERN);
  const transportKind = member(GateTransportKindWireSchema, instance.transportKind);
  const status = member(GateInstanceStatusWireSchema, instance.status);
  const trust = member(GateTrustWireSchema, instance.trust);
  const health = member(GateHealthWireSchema, instance.health);
  const createdAt = timestamp(instance.createdAt);
  const updatedAt = timestamp(instance.updatedAt);
  if (
    gateId === null ||
    transportKind === null ||
    status === null ||
    trust === null ||
    health === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const definition = instance.definition;
  const credentialMode = definition?.credentialMode;
  return {
    gateId,
    connector: shaped(instance.connector, CONNECTOR_NAME_PATTERN),
    transportKind,
    hosted: instance.hosted === true,
    preset: shaped(definition?.preset, CONNECTOR_NAME_PATTERN),
    credentialMode:
      credentialMode === 'shared' || credentialMode === 'connected_account' ? credentialMode : null,
    status,
    trust,
    health,
    lastSeenAt: timestamp(instance.lastSeenAt),
    lastCheckedAt: timestamp(instance.lastCheckedAt),
    operationCount: count(instance.operationCount),
    enabledWorkspaceCount: count(instance.enabledWorkspaceCount),
    pendingManifest: projectPendingManifest(instance.pendingManifest),
    createdAt,
    updatedAt,
  };
}

/** `platform_state_gates`' result from every gate instance, in the order given. */
export function projectGateInstances(
  instances: readonly GateInstanceWire[],
  checkedAt: string,
): PlatformStateGatesWire {
  const projected = instances
    .map(projectGateInstance)
    .filter((gate): gate is PlatformStateGateWire => gate !== null);
  return {
    instances: projected.slice(0, PLATFORM_STATE_GATES_LIMIT),
    total: instances.length,
    truncated: projected.length > PLATFORM_STATE_GATES_LIMIT,
    checkedAt,
  };
}

// -------------------------------------------------------------------------------------------
// connectors
// -------------------------------------------------------------------------------------------

/** One connector as an admin agent sees it, or `null` when its name, kind or mode is out of
 *  shape. */
export function projectConnector(connector: ConnectorWire): PlatformStateConnectorWire | null {
  const name = shaped(connector.name, CONNECTOR_NAME_PATTERN);
  const kind = member(GateTransportKindWireSchema, connector.kind);
  const mode = member(ConnectorModeWireSchema, connector.mode);
  if (name === null || kind === null || mode === null) return null;
  const disabled = Array.isArray(connector.disabledOperations) ? connector.disabledOperations : [];
  return {
    name,
    kind,
    packaged: connector.packaged === true,
    generic: isGenericConnector(name),
    mode,
    disabledOperationCount: disabled.length,
    disabledOperations: disabled
      .map((operation) => shaped(operation, PLATFORM_STATE_OPERATION_NAME_PATTERN))
      .filter((operation): operation is string => operation !== null)
      .slice(0, PLATFORM_STATE_DISABLED_OPERATIONS_LIMIT),
    operationCount: count(connector.operationCount),
    instanceCount: count(connector.instanceCount),
    selfConnectionCount: count(connector.selfConnectionCount),
    suspendedSelfConnectionCount: count(connector.suspendedSelfConnectionCount),
    updatedAt: timestamp(connector.updatedAt),
  };
}

/** `platform_state_connectors`' result, in the order given. */
export function projectConnectors(
  connectors: readonly ConnectorWire[],
  checkedAt: string,
): PlatformStateConnectorsWire {
  return {
    connectors: connectors
      .map(projectConnector)
      .filter((connector): connector is PlatformStateConnectorWire => connector !== null),
    checkedAt,
  };
}

// -------------------------------------------------------------------------------------------
// audit
// -------------------------------------------------------------------------------------------

/** One platform audit row, as much of it as the summary reads: never its params, resource id or
 *  actor login (the query below selects none of them). */
export interface PlatformAuditSummaryRow {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly resourceType: string | null;
  readonly createdAt: Date;
}

/** Actions that are reads: capabilities without side effects, audited under their own names — the
 *  rule the console's "recent platform audit" uses to leave reads out (`queryRecentPlatformWrites`,
 *  application/gateway/platform-handlers.ts). An action the registry does not know is a write. */
const READ_ACTIONS: ReadonlySet<string> = new Set(
  CAPABILITY_REGISTRY.filter((capability) => !capabilityHasSideEffects(capability)).map(
    (capability) => capability.name,
  ),
);

function actorOf(actorUserId: string | null, selfUserId: string): PlatformStateAuditActorWire {
  if (actorUserId === null) return 'unattributed';
  return actorUserId === selfUserId ? 'self' : 'another_administrator';
}

/**
 * `platform_state_audit`'s result from the platform audit rows of the window, newest first — at
 * most one more than `PLATFORM_STATE_AUDIT_SCAN_ROWS`, which only says the window holds more.
 * `selfUserId` is the agent's administrator.
 */
export function summarizePlatformAudit(
  rows: readonly PlatformAuditSummaryRow[],
  selfUserId: string,
  checkedAt: string,
): PlatformStateAuditWire {
  const scanned = rows.slice(0, PLATFORM_STATE_AUDIT_SCAN_ROWS);
  const writes = scanned.filter((row) => !READ_ACTIONS.has(row.action));
  const byAction = new Map<string, number>();
  let unrecognizedWrites = 0;
  const recent: PlatformStateAuditWire['recent'] = [];
  for (const row of writes) {
    const action = shaped(row.action, PLATFORM_STATE_AUDIT_ACTION_PATTERN);
    if (action === null) {
      unrecognizedWrites += 1;
      continue;
    }
    byAction.set(action, (byAction.get(action) ?? 0) + 1);
    if (recent.length < PLATFORM_STATE_AUDIT_RECENT_LIMIT) {
      recent.push({
        action,
        createdAt: row.createdAt.toISOString(),
        resourceType: shaped(row.resourceType, PLATFORM_STATE_RESOURCE_TYPE_PATTERN),
        actor: actorOf(row.actorUserId, selfUserId),
      });
    }
  }
  return {
    windowHours: PLATFORM_STATE_AUDIT_WINDOW_HOURS,
    scannedRows: scanned.length,
    truncated: rows.length > PLATFORM_STATE_AUDIT_SCAN_ROWS,
    writesByAction: [...byAction.entries()]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .map(([action, n]) => ({ action, count: n })),
    unrecognizedWrites,
    recent,
    checkedAt,
  };
}

// -------------------------------------------------------------------------------------------
// reads (inside the read-only platform transaction)
// -------------------------------------------------------------------------------------------

export async function readGatesState(
  client: PoolClient,
  checkedAt: string,
): Promise<PlatformStateRead<PlatformStateGatesWire>> {
  const result = projectGateInstances(await listGateInstances(client), checkedAt);
  return { result, returned: result.instances.length };
}

export async function readConnectorsState(
  client: PoolClient,
  checkedAt: string,
): Promise<PlatformStateRead<PlatformStateConnectorsWire>> {
  const result = projectConnectors(await listConnectors(client), checkedAt);
  return { result, returned: result.connectors.length };
}

export async function readAuditState(
  client: PoolClient,
  selfUserId: string,
  checkedAt: string,
): Promise<PlatformStateRead<PlatformStateAuditWire>> {
  const rows = await client.query<{
    action: string;
    actor_user_id: string | null;
    resource_type: string | null;
    created_at: Date;
  }>(
    `select a.action, a.actor_user_id, a.resource_type, a.created_at
       from audit_records a
      where a.workspace_id is null
        and a.created_at > now() - make_interval(hours => $1)
      order by a.created_at desc, a.id desc
      limit $2`,
    [PLATFORM_STATE_AUDIT_WINDOW_HOURS, PLATFORM_STATE_AUDIT_SCAN_ROWS + 1],
  );
  const result = summarizePlatformAudit(
    rows.rows.map((row) => ({
      action: row.action,
      actorUserId: row.actor_user_id,
      resourceType: row.resource_type,
      createdAt: row.created_at,
    })),
    selfUserId,
    checkedAt,
  );
  return { result, returned: result.recent.length };
}
