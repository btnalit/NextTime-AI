import type {
  AvailableGateInstanceWire,
  ConnectorWire,
  ExternalRuntimeWire,
  GateInstanceWire,
  Operation,
} from '@nexttime/shared';
import { OperationSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * application/gates/store: the P-B1 integration catalog — `connectors`, `gate_instances`,
 * `workspace_gate_links` (migration core 0023; docs/platform-admin-design.md §6.3). Plain SQL
 * helpers used by three callers with three transaction shapes:
 *   - `interfaces/http/internal/gates.ts` (`POST /internal/gates/announce`, admin client — a gate
 *     has no user and no Principal; the announcement carries endpoints and manifests only);
 *   - the platform handlers (`withPlatform`: reads and every write to the two catalog tables);
 *   - the workspace handlers and the approval decision (a workspace transaction: reads through the
 *     `*_read_all` policies, link rows through the workspace-isolation policy).
 */

export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const CONNECTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const GENERIC_CONNECTOR_NAMES: readonly string[] = ['http', 'mcp', 'cli', 'ssh'];

export type GateTransportKind = 'http' | 'mcp' | 'cli' | 'ssh';
export type ConnectorMode = 'disabled' | 'self_serve' | 'platform_preset';
export type GateInstanceStatus = 'discovered' | 'enabled' | 'disabled' | 'lost';
export type GateTrust = 'byo' | 'vetted';
export type GateHealth = 'ok' | 'unreachable' | 'unauthorized' | 'unknown';

export const AnnounceBodySchema = z
  .object({
    gateId: z.string().regex(GATE_ID_PATTERN),
    connector: z.string().regex(CONNECTOR_NAME_PATTERN),
    transportKind: z.enum(['http', 'mcp', 'cli', 'ssh']),
    /** Human-readable target (the external system's base URL or API address, an MCP server URL). Never
     *  a credential. */
    target: z.string().max(500).optional(),
    /** The gate's own base URL as the kernel must call it (compose service name + port). */
    endpoint: z.string().min(1).max(500),
    healthEndpoint: z.string().max(500).optional(),
    displayName: z.string().min(1).max(120).optional(),
    operations: z.array(OperationSchema).max(500),
  })
  .strict();
export type AnnounceBody = z.infer<typeof AnnounceBodySchema>;

interface ConnectorDbRow {
  name: string;
  kind: GateTransportKind;
  packaged: boolean;
  mode: ConnectorMode;
  disabled_operations: unknown;
  updated_at: Date | null;
  operation_count: number;
  instance_count: number;
}

interface GateInstanceDbRow {
  gate_id: string;
  connector: string;
  display_name: string;
  transport_kind: GateTransportKind;
  target: string;
  endpoint: string;
  health_endpoint: string | null;
  operations: unknown;
  status: GateInstanceStatus;
  trust: GateTrust;
  health: GateHealth;
  last_seen_at: Date | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
  enabled_workspace_count: number;
}

const GATE_INSTANCE_SELECT = `
  select g.gate_id, g.connector, g.display_name, g.transport_kind, g.target, g.endpoint,
         g.health_endpoint, g.operations, g.status, g.trust, g.health, g.last_seen_at,
         g.last_checked_at, g.created_at, g.updated_at,
         (select count(*)::int from workspace_gate_links l where l.gate_id = g.gate_id)
           as enabled_workspace_count
    from gate_instances g`;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function operationsOf(value: unknown): Operation[] {
  if (!Array.isArray(value)) return [];
  const parsed: Operation[] = [];
  for (const entry of value) {
    const result = OperationSchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

export function toWireConnector(row: ConnectorDbRow): ConnectorWire {
  return {
    name: row.name,
    kind: row.kind,
    packaged: row.packaged,
    mode: row.mode,
    disabledOperations: stringList(row.disabled_operations),
    operationCount: row.operation_count,
    instanceCount: row.instance_count,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

export function toWireGateInstance(row: GateInstanceDbRow): GateInstanceWire {
  const operations = operationsOf(row.operations);
  return {
    gateId: row.gate_id,
    connector: row.connector,
    displayName: row.display_name,
    transportKind: row.transport_kind,
    target: row.target,
    endpoint: row.endpoint,
    status: row.status,
    trust: row.trust,
    health: row.health,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    operationCount: operations.length,
    enabledWorkspaceCount: row.enabled_workspace_count,
    operations: operations.map((op) => ({
      name: op.name,
      mode: op.mode,
      blastRadius: op.blast_radius,
      autoApprovable: op.auto_approvable,
      readOnlyHint: op.read_only_hint ?? null,
      destructiveHint: op.destructive_hint ?? null,
      idempotentHint: op.idempotent_hint ?? null,
    })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// -------------------------------------------------------------------------------------------
// connectors
// -------------------------------------------------------------------------------------------

const CONNECTOR_SELECT = `
  select c.name, c.kind, c.packaged, c.mode, c.disabled_operations, c.updated_at,
         (select count(distinct op->>'name')::int
            from gate_instances g, jsonb_array_elements(g.operations) op
           where g.connector = c.name) as operation_count,
         (select count(*)::int from gate_instances g where g.connector = c.name) as instance_count
    from connectors c`;

export async function listConnectors(client: PoolClient): Promise<ConnectorWire[]> {
  const result = await client.query<ConnectorDbRow>(
    `${CONNECTOR_SELECT} order by c.packaged desc, c.name`,
  );
  return result.rows.map(toWireConnector);
}

export async function getConnector(
  client: PoolClient,
  name: string,
): Promise<ConnectorWire | null> {
  const result = await client.query<ConnectorDbRow>(`${CONNECTOR_SELECT} where c.name = $1`, [
    name,
  ]);
  const row = result.rows[0];
  return row ? toWireConnector(row) : null;
}

export async function updateConnector(
  client: PoolClient,
  name: string,
  patch: { mode?: ConnectorMode; disabledOperations?: readonly string[] },
): Promise<void> {
  await client.query(
    `update connectors
        set mode = coalesce($2, mode),
            disabled_operations = coalesce($3::jsonb, disabled_operations),
            updated_at = now()
      where name = $1`,
    [
      name,
      patch.mode ?? null,
      patch.disabledOperations === undefined ? null : JSON.stringify(patch.disabledOperations),
    ],
  );
}

/** The connector's deny list as seen from any transaction (`connectors_read_all`). */
export async function readDisabledOperations(
  client: PoolClient,
  connector: string,
): Promise<string[]> {
  const result = await client.query<{ disabled_operations: unknown }>(
    'select disabled_operations from connectors where name = $1',
    [connector],
  );
  return stringList(result.rows[0]?.disabled_operations);
}

// -------------------------------------------------------------------------------------------
// gate instances
// -------------------------------------------------------------------------------------------

export interface AnnounceOutcome {
  readonly gateId: string;
  readonly created: boolean;
  /** The announced endpoint differs from the stored one on an already-enabled instance. */
  readonly endpointChanged: boolean;
  readonly status: GateInstanceStatus;
}

/**
 * Upsert from `POST /internal/gates/announce`. A new id lands as `discovered`; an `enabled` or
 * `disabled` instance keeps its status (a heartbeat never flips the administrator's decision);
 * a `lost` instance that reappears goes back to `enabled` if it had been enabled before it was
 * lost — recorded in `operations`? No: `lost` is only ever set from `enabled`/`discovered` by the
 * liveness timer, so on reappearance we restore to `enabled` when it has at least one workspace
 * link, else `discovered`. The connector row is created on first sight (`platform_preset`).
 */
export async function upsertAnnouncement(
  client: PoolClient,
  body: AnnounceBody,
): Promise<AnnounceOutcome> {
  await client.query(
    `insert into connectors (name, kind, packaged, mode)
     values ($1, $2, $3, 'platform_preset')
     on conflict (name) do nothing`,
    [body.connector, body.transportKind, !GENERIC_CONNECTOR_NAMES.includes(body.connector)],
  );
  const existing = await client.query<{ status: GateInstanceStatus; endpoint: string }>(
    'select status, endpoint from gate_instances where gate_id = $1 for update',
    [body.gateId],
  );
  const before = existing.rows[0];
  const links = await client.query<{ n: string }>(
    'select count(*)::text as n from workspace_gate_links where gate_id = $1',
    [body.gateId],
  );
  const hasLinks = Number(links.rows[0]?.n ?? '0') > 0;
  let status: GateInstanceStatus;
  if (!before) status = 'discovered';
  else if (before.status === 'lost') status = hasLinks ? 'enabled' : 'discovered';
  else status = before.status;
  const displayName = body.displayName ?? body.gateId;
  await client.query(
    `insert into gate_instances
       (gate_id, connector, display_name, transport_kind, target, endpoint, health_endpoint,
        operations, status, health, last_seen_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'ok', now(), now())
     on conflict (gate_id) do update set
       connector = excluded.connector,
       transport_kind = excluded.transport_kind,
       target = excluded.target,
       endpoint = excluded.endpoint,
       health_endpoint = excluded.health_endpoint,
       operations = excluded.operations,
       status = $9,
       health = 'ok',
       last_seen_at = now(),
       updated_at = now()`,
    [
      body.gateId,
      body.connector,
      displayName,
      body.transportKind,
      body.target ?? '',
      body.endpoint,
      body.healthEndpoint ?? null,
      JSON.stringify(body.operations),
      status,
    ],
  );
  return {
    gateId: body.gateId,
    created: !before,
    endpointChanged: before !== undefined && before.endpoint !== body.endpoint,
    status,
  };
}

/** Liveness (决定 ⑤): instances whose heartbeat is older than `thresholdSeconds` become `lost`
 *  (from `enabled` / `discovered` only — an administrator's `disabled` stays). Returns the ids. */
export async function markLostGateInstances(
  client: PoolClient,
  thresholdSeconds: number,
): Promise<string[]> {
  const result = await client.query<{ gate_id: string }>(
    `update gate_instances
        set status = 'lost', health = 'unreachable', updated_at = now()
      where status in ('enabled', 'discovered')
        and last_seen_at is not null
        and last_seen_at < now() - make_interval(secs => $1)
      returning gate_id`,
    [thresholdSeconds],
  );
  return result.rows.map((row) => row.gate_id);
}

export async function listGateInstances(
  client: PoolClient,
  filter: { status?: GateInstanceStatus; connector?: string } = {},
): Promise<GateInstanceWire[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    where.push(`g.status = $${params.length}`);
  }
  if (filter.connector) {
    params.push(filter.connector);
    where.push(`g.connector = $${params.length}`);
  }
  const result = await client.query<GateInstanceDbRow>(
    `${GATE_INSTANCE_SELECT}${where.length > 0 ? ` where ${where.join(' and ')}` : ''}
      order by g.created_at, g.gate_id`,
    params,
  );
  return result.rows.map(toWireGateInstance);
}

export async function getGateInstance(
  client: PoolClient,
  gateId: string,
): Promise<GateInstanceWire | null> {
  const result = await client.query<GateInstanceDbRow>(
    `${GATE_INSTANCE_SELECT} where g.gate_id = $1`,
    [gateId],
  );
  const row = result.rows[0];
  return row ? toWireGateInstance(row) : null;
}

export async function updateGateInstance(
  client: PoolClient,
  gateId: string,
  patch: { displayName?: string; status?: 'enabled' | 'disabled'; trust?: GateTrust },
): Promise<void> {
  await client.query(
    `update gate_instances
        set display_name = coalesce($2, display_name),
            status = coalesce($3, status),
            trust = coalesce($4, trust),
            updated_at = now()
      where gate_id = $1`,
    [gateId, patch.displayName ?? null, patch.status ?? null, patch.trust ?? null],
  );
}

export async function recordGateInstanceCheck(
  client: PoolClient,
  gateId: string,
  health: GateHealth,
): Promise<void> {
  await client.query(
    'update gate_instances set health = $2, last_checked_at = now() where gate_id = $1',
    [gateId, health],
  );
}

// -------------------------------------------------------------------------------------------
// workspace links
// -------------------------------------------------------------------------------------------

export interface GateLinkRow {
  readonly workspaceId: string;
  readonly gateId: string;
  readonly gatekeeperObjectId: string;
  readonly enabledBy: string;
  readonly enabledAt: Date;
}

interface GateLinkDbRow {
  workspace_id: string;
  gate_id: string;
  gatekeeper_object_id: string;
  enabled_by: string;
  enabled_at: Date;
}

function mapLink(row: GateLinkDbRow): GateLinkRow {
  return {
    workspaceId: row.workspace_id,
    gateId: row.gate_id,
    gatekeeperObjectId: row.gatekeeper_object_id,
    enabledBy: row.enabled_by,
    enabledAt: row.enabled_at,
  };
}

export async function insertGateLink(
  client: PoolClient,
  input: { workspaceId: string; gateId: string; gatekeeperObjectId: string; enabledBy: string },
): Promise<void> {
  await client.query(
    `insert into workspace_gate_links (workspace_id, gate_id, gatekeeper_object_id, enabled_by)
     values ($1, $2, $3, $4)`,
    [input.workspaceId, input.gateId, input.gatekeeperObjectId, input.enabledBy],
  );
}

export async function findGateLinkByGate(
  client: PoolClient,
  workspaceId: string,
  gateId: string,
): Promise<GateLinkRow | null> {
  const result = await client.query<GateLinkDbRow>(
    `select workspace_id, gate_id, gatekeeper_object_id, enabled_by, enabled_at
       from workspace_gate_links where workspace_id = $1 and gate_id = $2`,
    [workspaceId, gateId],
  );
  return result.rows[0] ? mapLink(result.rows[0]) : null;
}

/** The link plus the two facts the per-call rules need — the connector's deny list and the
 *  instance's trust — for a workspace Gatekeeper object; `null` for a gate the workspace connected
 *  itself (no link: no deny list applies, trust is `byo`). */
export interface GateLinkPolicyView {
  readonly gateId: string;
  readonly connector: string;
  readonly trust: GateTrust;
  readonly instanceStatus: GateInstanceStatus;
  readonly disabledOperations: string[];
}

export async function readGateLinkPolicy(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
): Promise<GateLinkPolicyView | null> {
  const result = await client.query<{
    gate_id: string;
    connector: string;
    trust: GateTrust;
    status: GateInstanceStatus;
    disabled_operations: unknown;
  }>(
    `select l.gate_id, g.connector, g.trust, g.status, c.disabled_operations
       from workspace_gate_links l
       join gate_instances g on g.gate_id = l.gate_id
       join connectors c on c.name = g.connector
      where l.workspace_id = $1 and l.gatekeeper_object_id = $2`,
    [workspaceId, gatekeeperObjectId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    gateId: row.gate_id,
    connector: row.connector,
    trust: row.trust,
    instanceStatus: row.status,
    disabledOperations: stringList(row.disabled_operations),
  };
}

/** Workspace side: enabled platform instances of `platform_preset` connectors, plus this
 *  workspace's link when it has one. */
export async function listAvailableGateInstances(
  client: PoolClient,
  workspaceId: string,
): Promise<AvailableGateInstanceWire[]> {
  const result = await client.query<
    GateInstanceDbRow & { gatekeeper_object_id: string | null; connector_mode: ConnectorMode }
  >(
    `select g.gate_id, g.connector, g.display_name, g.transport_kind, g.target, g.endpoint,
            g.health_endpoint, g.operations, g.status, g.trust, g.health, g.last_seen_at,
            g.last_checked_at, g.created_at, g.updated_at, 0 as enabled_workspace_count,
            l.gatekeeper_object_id, c.mode as connector_mode
       from gate_instances g
       join connectors c on c.name = g.connector
       left join workspace_gate_links l on l.gate_id = g.gate_id and l.workspace_id = $1
      where c.mode = 'platform_preset' and (g.status = 'enabled' or l.gate_id is not null)
      order by g.created_at, g.gate_id`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    gateId: row.gate_id,
    connector: row.connector,
    displayName: row.display_name,
    transportKind: row.transport_kind,
    target: row.target,
    status: row.status,
    trust: row.trust,
    health: row.health,
    operationCount: operationsOf(row.operations).length,
    gatekeeperId: row.gatekeeper_object_id,
  }));
}

// -------------------------------------------------------------------------------------------
// external runtimes (design §6.3 "外部运行时"): service Principals' live sessions, across workspaces
// -------------------------------------------------------------------------------------------

export async function listExternalRuntimes(
  client: PoolClient,
  filter: { workspaceId?: string } = {},
): Promise<ExternalRuntimeWire[]> {
  const result = await client.query<{
    workspace_id: string;
    workspace_name: string;
    principal_id: string;
    display_name: string | null;
    session_id: string;
    kind: string;
    status: string;
    created_at: Date;
    expires_at: Date | null;
  }>(
    `select s.workspace_id, w.name as workspace_name, p.id as principal_id, p.display_name,
            s.id as session_id, s.kind, s.status, s.created_at, s.expires_at
       from sessions s
       join principals p on p.workspace_id = s.workspace_id and p.id = s.principal_id
       join workspaces w on w.id = s.workspace_id
      where p.kind = 'service' and s.status = 'active'
        and (s.expires_at is null or s.expires_at > now())
        ${filter.workspaceId ? 'and s.workspace_id = $1' : ''}
      order by s.created_at desc`,
    filter.workspaceId ? [filter.workspaceId] : [],
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    principalId: row.principal_id,
    displayName: row.display_name,
    sessionId: row.session_id,
    sessionKind: row.kind,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  }));
}

export async function revokeExternalRuntime(
  client: PoolClient,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await client.query(
    `update sessions s
        set status = 'revoked', expires_at = now()
       from principals p
      where p.workspace_id = s.workspace_id and p.id = s.principal_id and p.kind = 'service'
        and s.workspace_id = $1 and s.id = $2 and s.status = 'active'`,
    [workspaceId, sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}
