import type {
  AvailableGateInstanceWire,
  ConnectorWire,
  ExternalRuntimeWire,
  GateHostedDefinitionWire,
  GateInstanceWire,
  Operation,
} from '@nexttime/shared';
import { GateHostedDefinitionWireSchema, OperationSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { setWorkspaceContext } from '../../adapters/db/platform-context.js';
import { revokeEntrySessionHandles, revokeSession } from '../../governance/capability/index.js';
import { isOperationDisabled } from '../../governance/gatekeepers/index.js';

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
  hosted: boolean;
  definition: unknown;
}

const GATE_INSTANCE_SELECT = `
  select g.gate_id, g.connector, g.display_name, g.transport_kind, g.target, g.endpoint,
         g.health_endpoint, g.operations, g.status, g.trust, g.health, g.last_seen_at,
         g.last_checked_at, g.created_at, g.updated_at, g.hosted, g.definition,
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

export function hostedDefinitionOf(value: unknown): GateHostedDefinitionWire | null {
  if (value === null || value === undefined) return null;
  const parsed = GateHostedDefinitionWireSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** S8 W1-C (leftover 48 "GateInstanceWire 只有 enabledWorkspaceCount 无工作区列表"): the bound on
 *  `enablingWorkspaces` — `enabledWorkspaceCount` stays the true, untruncated total either way. */
export const ENABLING_WORKSPACES_LIMIT = 20;

export function toWireGateInstance(
  row: GateInstanceDbRow,
  enablingWorkspaces: readonly { readonly id: string; readonly name: string }[] = [],
): GateInstanceWire {
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
    enablingWorkspaces: enablingWorkspaces.map((w) => ({ id: w.id, name: w.name })),
    hosted: row.hosted,
    definition: hostedDefinitionOf(row.definition),
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
  /** The announced identity fields (connector / transport kind / endpoint) differ from what an
   *  `enabled` / `disabled` instance was recorded with — the stored values were kept. */
  readonly identityMismatch: boolean;
  readonly status: GateInstanceStatus;
  /** P-B2a: a never-seen gate-host instance was announced with a connector / transport kind other
   *  than its own definition — nothing was written (the host derives both from the definition, so
   *  this can only be a stray or hostile announcement). */
  readonly rejected?: boolean;
}

/**
 * Upsert from `POST /internal/gates/announce`. A new id lands as `discovered`. An instance the
 * administrator already decided on (`enabled` / `disabled`) keeps that status **and its identity**
 * — connector, transport kind and endpoint are frozen once decided, so a second container reusing
 * an enabled `GATE_ID` cannot redirect where later enables point (design §6.3 "防止第二个容器用同名
 * 顶替已启用的门"; the announcing token is shared by the whole internal plane, not per gate). Such
 * an announcement still counts as a heartbeat but marks health `unknown` and is reported to the
 * caller (`identityMismatch`) for the log. The manifest (`operations`) and the human-readable
 * `target` may change on every announce: a newer gate build legitimately adds Operations. A `lost`
 * instance that reappears returns to the status it had before it was lost (`status_before_lost`).
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
  const existing = await client.query<{
    status: GateInstanceStatus;
    status_before_lost: GateInstanceStatus | null;
    connector: string;
    transport_kind: GateTransportKind;
    endpoint: string;
    hosted: boolean;
    last_seen_at: Date | null;
  }>(
    `select status, status_before_lost, connector, transport_kind, endpoint, hosted, last_seen_at
       from gate_instances where gate_id = $1 for update`,
    [body.gateId],
  );
  const before = existing.rows[0];
  const decided =
    before !== undefined && (before.status === 'enabled' || before.status === 'disabled');
  const restoredStatus =
    before?.status === 'lost' ? (before.status_before_lost ?? 'discovered') : undefined;
  const decidedAfterLost = restoredStatus === 'enabled' || restoredStatus === 'disabled';
  // P-B2a (决定 ⑧): a gate-host instance is created by the administrator with an empty endpoint; its
  // *first* announcement (never seen yet) fills the identity in, so the freeze starts once it has
  // been seen (relevant when the administrator enabled / disabled it before the host spoke). Every
  // other decided instance is frozen from the decision on (P-B1).
  const neverSeenHosted = before?.hosted === true && before.last_seen_at === null;
  if (
    neverSeenHosted &&
    before !== undefined &&
    (before.connector !== body.connector || before.transport_kind !== body.transportKind)
  ) {
    // Only the endpoint is unknown until the host speaks; kind and connector come from the
    // administrator's definition and must match — refuse rather than let the first announce redefine them.
    return {
      gateId: body.gateId,
      created: false,
      identityMismatch: true,
      status: before.status,
      rejected: true,
    };
  }
  const frozen = (decided || decidedAfterLost) && !neverSeenHosted;
  const identityMismatch =
    frozen &&
    before !== undefined &&
    (before.connector !== body.connector ||
      before.transport_kind !== body.transportKind ||
      before.endpoint !== body.endpoint);
  const status: GateInstanceStatus = !before
    ? 'discovered'
    : before.status === 'lost'
      ? (restoredStatus ?? 'discovered')
      : before.status;
  const displayName = body.displayName ?? body.gateId;
  if (!before) {
    await client.query(
      `insert into gate_instances
         (gate_id, connector, display_name, transport_kind, target, endpoint, health_endpoint,
          operations, status, health, last_seen_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'discovered', 'ok', now(), now())`,
      [
        body.gateId,
        body.connector,
        displayName,
        body.transportKind,
        body.target ?? '',
        body.endpoint,
        body.healthEndpoint ?? null,
        JSON.stringify(body.operations),
      ],
    );
  } else if (frozen) {
    await client.query(
      `update gate_instances
          set target = $2,
              operations = $3::jsonb,
              health_endpoint = case when $4 then health_endpoint else $5 end,
              status = $6,
              status_before_lost = null,
              health = case when $4 then 'unknown' else 'ok' end,
              last_seen_at = now(),
              updated_at = now()
        where gate_id = $1`,
      [
        body.gateId,
        body.target ?? '',
        JSON.stringify(body.operations),
        identityMismatch,
        body.healthEndpoint ?? null,
        status,
      ],
    );
  } else {
    await client.query(
      `update gate_instances
          set connector = $2,
              transport_kind = $3,
              target = $4,
              endpoint = $5,
              health_endpoint = $6,
              operations = $7::jsonb,
              status = $8,
              status_before_lost = null,
              health = 'ok',
              last_seen_at = now(),
              updated_at = now()
        where gate_id = $1`,
      [
        body.gateId,
        body.connector,
        body.transportKind,
        body.target ?? '',
        body.endpoint,
        body.healthEndpoint ?? null,
        JSON.stringify(body.operations),
        status,
      ],
    );
  }
  return { gateId: body.gateId, created: !before, identityMismatch, status };
}

/** Liveness (决定 ⑤): instances whose heartbeat is older than `thresholdSeconds` become `lost`
 *  (from `enabled` / `discovered` only — an administrator's `disabled` stays). Returns the ids. */
export async function markLostGateInstances(
  client: PoolClient,
  thresholdSeconds: number,
): Promise<string[]> {
  const result = await client.query<{ gate_id: string }>(
    `update gate_instances
        set status_before_lost = status, status = 'lost', health = 'unreachable', updated_at = now()
      where status in ('enabled', 'discovered')
        and last_seen_at is not null
        and last_seen_at < now() - make_interval(secs => $1)
      returning gate_id`,
    [thresholdSeconds],
  );
  return result.rows.map((row) => row.gate_id);
}

/** The workspaces that enabled each of `gateIds`, newest link first, capped at
 *  `ENABLING_WORKSPACES_LIMIT` per gate — one query for the whole batch (never per gate id), same
 *  "bounded query count" convention `resolve_refs` (`application/gateway/resolve-refs-handler.ts`)
 *  follows. `[]` for a `gateIds` no link references (nothing enabled it, or every link is against
 *  a since-purged workspace — `workspace_gate_links`/`workspaces` share no ON DELETE that would
 *  leave a dangling row, so this is simply "no rows matched"). */
async function listEnablingWorkspaces(
  client: PoolClient,
  gateIds: readonly string[],
): Promise<ReadonlyMap<string, readonly { readonly id: string; readonly name: string }[]>> {
  if (gateIds.length === 0) return new Map();
  const result = await client.query<{ gate_id: string; id: string; name: string }>(
    `select l.gate_id, w.id, w.name
       from workspace_gate_links l
       join workspaces w on w.id = l.workspace_id
      where l.gate_id = any($1::text[])
      order by l.gate_id, l.enabled_at desc`,
    [gateIds],
  );
  const map = new Map<string, { readonly id: string; readonly name: string }[]>();
  for (const row of result.rows) {
    let bucket = map.get(row.gate_id);
    if (!bucket) {
      bucket = [];
      map.set(row.gate_id, bucket);
    }
    if (bucket.length < ENABLING_WORKSPACES_LIMIT) bucket.push({ id: row.id, name: row.name });
  }
  return map;
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
  const enablingByGate = await listEnablingWorkspaces(
    client,
    result.rows.map((row) => row.gate_id),
  );
  return result.rows.map((row) => toWireGateInstance(row, enablingByGate.get(row.gate_id) ?? []));
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
  if (!row) return null;
  const enablingByGate = await listEnablingWorkspaces(client, [gateId]);
  return toWireGateInstance(row, enablingByGate.get(gateId) ?? []);
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
// P-B2a gate-host instances (决定 ⑦): rows the administrator creates; the host pulls and announces
// -------------------------------------------------------------------------------------------

export interface HostedGateDefinition {
  readonly gateId: string;
  readonly displayName: string;
  readonly status: GateInstanceStatus;
  readonly definition: GateHostedDefinitionWire;
}

/** Inserts a never-seen instance: `discovered`, `endpoint ''`, `health 'unknown'`, no heartbeat. It
 *  lands `discovered` — not `enabled` — on purpose (review finding): the administrator enables it
 *  after the host has taken it over and the endpoint / Operations are visible, exactly the packaged-
 *  gate path, so an internal-token holder racing the host's first announce cannot hand workspaces a
 *  live endpoint nobody reviewed. The connector is the generic kind (`http` / `mcp`, seeded by
 *  0023). Returns `false` on an id clash. */
export async function createHostedGateInstance(
  client: PoolClient,
  input: { gateId: string; displayName: string; definition: GateHostedDefinitionWire },
): Promise<boolean> {
  const result = await client.query(
    `insert into gate_instances
       (gate_id, connector, display_name, transport_kind, target, endpoint, health_endpoint,
        operations, status, health, hosted, definition, updated_at)
     values ($1, $2, $3, $2, $4, '', null, '[]'::jsonb, 'discovered', 'unknown', true, $5::jsonb, now())
     on conflict (gate_id) do nothing`,
    [
      input.gateId,
      input.definition.transportKind,
      input.displayName,
      input.definition.target,
      JSON.stringify(input.definition),
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Removes a hosted instance nobody linked. `'in_use'` when a workspace still has a link (an
 *  administrator disables it instead — design §8: platform changes never tear down links). */
export async function deleteHostedGateInstance(
  client: PoolClient,
  gateId: string,
): Promise<'deleted' | 'not_found' | 'not_hosted' | 'in_use'> {
  const row = await client.query<{ hosted: boolean; links: number }>(
    `select g.hosted,
            (select count(*)::int from workspace_gate_links l where l.gate_id = g.gate_id) as links
       from gate_instances g where g.gate_id = $1 for update`,
    [gateId],
  );
  const found = row.rows[0];
  if (!found) return 'not_found';
  if (!found.hosted) return 'not_hosted';
  if (found.links > 0) return 'in_use';
  await client.query('delete from gate_instances where gate_id = $1', [gateId]);
  return 'deleted';
}

/** What the gate host pulls (`GET /internal/gate-host/instances`, 决定 ⑥): every hosted row with its
 *  definition. Status comes along so the host can log it; enforcement stays in the kernel. */
export async function listHostedGateDefinitions(
  client: PoolClient,
): Promise<HostedGateDefinition[]> {
  const result = await client.query<{
    gate_id: string;
    display_name: string;
    status: GateInstanceStatus;
    definition: unknown;
  }>(
    `select gate_id, display_name, status, definition
       from gate_instances where hosted order by created_at, gate_id`,
  );
  const items: HostedGateDefinition[] = [];
  for (const row of result.rows) {
    const definition = hostedDefinitionOf(row.definition);
    if (!definition) continue;
    items.push({
      gateId: row.gate_id,
      displayName: row.display_name,
      status: row.status,
      definition,
    });
  }
  return items;
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

/** The reverse of `findGateLinkByGate` — from a workspace Gatekeeper Object id back to the
 *  platform gate instance it was enabled from, `null` for a Gatekeeper registered outside the
 *  platform catalog (the legacy `register-gatekeeper` CLI path, `create_connection`) or one this
 *  workspace never linked. S8 W3-K1 (leftover 79): `refresh_operation_governance`'s own
 *  `no_announced_manifest` refusal is exactly this `null` case — there is no `gate_instances.
 *  operations` manifest to refresh from. `workspace_gate_links` has no unique index on
 *  `gatekeeper_object_id` alone, but `insertGateLink`'s only two callers (`enableGateInstanceHandler`'s
 *  create and link branches) each write at most one row per `(workspaceId, gatekeeperObjectId)` — a
 *  fresh registration mints a new Gatekeeper id, and the link branch's own `resolveGateLinkTarget`
 *  only ever finds one existing Gatekeeper per endpoint before writing this row for it — so `limit 1`
 *  is a defensive bound, not evidence multiple rows are an expected shape. */
export async function findGateLinkByGatekeeper(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
): Promise<GateLinkRow | null> {
  const result = await client.query<GateLinkDbRow>(
    `select workspace_id, gate_id, gatekeeper_object_id, enabled_by, enabled_at
       from workspace_gate_links where workspace_id = $1 and gatekeeper_object_id = $2
       limit 1`,
    [workspaceId, gatekeeperObjectId],
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

/** `readGateLinkPolicy`, batched across every workspace Gatekeeper this workspace has ever linked
 *  in one query — for a caller that must check the whole workspace at once
 *  (`computeCapabilityReachability`, `list_allowed_operations`) rather than one Gatekeeper at a
 *  time. Keyed by `gatekeeper_object_id`; a Gatekeeper this workspace connected itself has no row
 *  in the returned map — the same "no link, no deny list" meaning `readGateLinkPolicy`'s own `null`
 *  return carries, just via `Map.get` returning `undefined` instead. */
export async function readGateLinkPoliciesForWorkspace(
  client: PoolClient,
  workspaceId: string,
): Promise<ReadonlyMap<string, GateLinkPolicyView>> {
  const result = await client.query<{
    gatekeeper_object_id: string;
    gate_id: string;
    connector: string;
    trust: GateTrust;
    status: GateInstanceStatus;
    disabled_operations: unknown;
  }>(
    `select l.gatekeeper_object_id, l.gate_id, g.connector, g.trust, g.status, c.disabled_operations
       from workspace_gate_links l
       join gate_instances g on g.gate_id = l.gate_id
       join connectors c on c.name = g.connector
      where l.workspace_id = $1`,
    [workspaceId],
  );
  const byGatekeeperId = new Map<string, GateLinkPolicyView>();
  for (const row of result.rows) {
    byGatekeeperId.set(row.gatekeeper_object_id, {
      gateId: row.gate_id,
      connector: row.connector,
      trust: row.trust,
      instanceStatus: row.status,
      disabledOperations: stringList(row.disabled_operations),
    });
  }
  return byGatekeeperId;
}

/** The one place that decides "is Operation `operationName` disabled by the platform for this
 *  workspace Gatekeeper, and if so which connector disabled it" — production incident 2026-09-26:
 *  before this function existed, `assertOperationEnabled` (enforcement, request-action-handler.ts),
 *  `disabledOperationsFor` (the read projections, gatekeeper-read-handlers.ts) and
 *  `computeCapabilityReachability` (the console's own reachability read model,
 *  application/gateway/capability-reachability.ts) each re-derived this decision — the third one
 *  never consulted the deny list at all, so the console told a member a gate was usable while every
 *  call to it was refused. All three (plus `list_allowed_operations`'s own tool-list projection and
 *  `action-executor.ts`'s execution-time re-check) now call this function; `null`/`undefined` for
 *  `gateLink` (a gate the workspace connected itself, or a workspace Gatekeeper absent from a
 *  `readGateLinkPoliciesForWorkspace` batch) always means "no platform deny list applies" —
 *  `isOperationDisabled`'s own exact-name-match semantics (governance/gatekeepers/trust.ts) are
 *  unchanged, just no longer inlined at each call site. */
export interface OperationPlatformStatus {
  readonly disabled: boolean;
  /** Present only when `disabled` is `true` — the connector whose deny list named this Operation. */
  readonly connector?: string;
}

export function operationPlatformStatus(
  gateLink: GateLinkPolicyView | null | undefined,
  operationName: string,
): OperationPlatformStatus {
  if (!gateLink || !isOperationDisabled(gateLink.disabledOperations, operationName)) {
    return { disabled: false };
  }
  return { disabled: true, connector: gateLink.connector };
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
  if ((result.rowCount ?? 0) === 0) return false;
  // Handle verification checks `capability_handles.revoked_at` by jti, not `sessions.status`
  // (governance/capability/handles.ts) — revoke the Handles under the session too, the same
  // primitive `revokeEntrySessionHandles` uses (review finding). `capability_handles` has only
  // the workspace-isolation policy (governance 0001), so the platform transaction scopes this
  // one statement to the session's workspace explicitly (`setWorkspaceContext`), then clears it.
  await setWorkspaceContext(client, workspaceId, PLATFORM_PLACEHOLDER_PRINCIPAL);
  try {
    await revokeSession(client, sessionId);
  } finally {
    await client.query("select set_config('app.workspace_id', '', true)");
    await client.query("select set_config('app.principal_id', '', true)");
  }
  return true;
}

const PLATFORM_PLACEHOLDER_PRINCIPAL = '00000000-0000-0000-0000-000000000000';

/**
 * P-B1 propagation fix (production incident 2026-09-26): a connector deny-list edit that newly
 * disables an Operation must reach every already-issued entry-agent Handle, not just wait for the
 * next unrelated Grant/AgentProfile change in the same workspace to happen to revoke it —
 * `assertOperationEnabled` already refuses the call regardless of what the Handle carries, but a
 * stale Handle otherwise keeps advertising the (now-refused) Operation as a projected tool for as
 * long as that entry session lives (S2.13's own ~21.6h ceiling, `revokeEntrySessionHandles`'s own
 * doc comment). `setConnectorModeHandler` calls this whenever the deny list (or mode) actually
 * changed — every workspace with a `workspace_gate_links` row for an instance of `connector` has
 * every principal's own `kind='entry'` session Handles revoked, forcing a fresh Handle (and a fresh
 * `find_operations`/tool projection) on that principal's very next Turn.
 *
 * `workspace_gate_links` and `gate_instances` both carry an `app_platform()` policy (core/0023), so
 * the affected-workspace query and the entry-session lookup run directly in the caller's own
 * platform transaction with no workspace switch needed; `capability_handles` has only the
 * workspace-isolation policy (governance/0001), so the actual revocation (`revokeEntrySessionHandles`,
 * which updates that table) switches `app.workspace_id` first, one workspace at a time — the same
 * `setWorkspaceContext` technique `revokeExternalRuntime` above already uses for exactly this
 * reason, reset to empty afterward so it never leaks into whatever the caller's transaction does
 * next. `linkedWorkspaceCount` is every workspace this connector reaches at all;
 * `revokedWorkspaceCount` is the subset that actually had a live `kind='entry'` session to revoke —
 * a workspace with none yet needs no revocation, but is still linked (and will pick up the deny
 * list the first time it ever mints an entry Handle, same as always).
 */
export async function revokeEntryHandlesForConnector(
  client: PoolClient,
  connector: string,
): Promise<{ readonly linkedWorkspaceCount: number; readonly revokedWorkspaceCount: number }> {
  const linked = await client.query<{ workspace_id: string }>(
    `select distinct l.workspace_id
       from workspace_gate_links l
       join gate_instances g on g.gate_id = l.gate_id
      where g.connector = $1`,
    [connector],
  );
  let revokedWorkspaceCount = 0;
  for (const row of linked.rows) {
    const entryPrincipals = await client.query<{ principal_id: string }>(
      `select distinct principal_id from sessions
        where workspace_id = $1 and principal_id = on_behalf_of and kind = 'entry'`,
      [row.workspace_id],
    );
    if (entryPrincipals.rows.length === 0) continue;
    await setWorkspaceContext(client, row.workspace_id, PLATFORM_PLACEHOLDER_PRINCIPAL);
    try {
      for (const principal of entryPrincipals.rows) {
        await revokeEntrySessionHandles(client, row.workspace_id, principal.principal_id);
      }
    } finally {
      await client.query("select set_config('app.workspace_id', '', true)");
      await client.query("select set_config('app.principal_id', '', true)");
    }
    revokedWorkspaceCount += 1;
  }
  return { linkedWorkspaceCount: linked.rows.length, revokedWorkspaceCount };
}
