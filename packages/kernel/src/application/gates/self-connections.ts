import type { PoolClient } from 'pg';

/**
 * application/gates/self-connections: the origin record of a gate a workspace connected itself
 * (`workspace_self_connections`, migration core 0045; S10 W2 P0b, STATUS leftover 118 remainder
 * ①). The catalog twin is `workspace_gate_links` (store.ts). Written by the landing only
 * (`landing.ts`), read by the platform policy (`readGatekeeperPlatformPolicy`, store.ts) and by the
 * platform's `list_self_connections` / `suspend_self_connection` / `resume_self_connection`
 * (application/gateway/platform-gates-handlers.ts).
 *
 * RLS (core 0045): a workspace transaction reads and inserts its own rows and deletes an
 * unsuspended one; only a platform transaction updates a row. `setSelfConnectionSuspension` is
 * therefore a platform-plane call — from a workspace transaction it would match no row.
 */

export interface SelfConnectionRow {
  readonly workspaceId: string;
  readonly gatekeeperObjectId: string;
  readonly connector: string;
  readonly target: string;
  readonly endpoint: string;
  readonly connectedBy: string | null;
  readonly connectedAt: Date;
  readonly suspendedAt: Date | null;
  readonly suspendedByUserId: string | null;
  readonly suspensionReason: string | null;
}

/** A row plus the names the platform list shows instead of ids. */
export interface SelfConnectionListRow extends SelfConnectionRow {
  readonly workspaceName: string;
  /** The connecting Principal's display name; `null` when `connectedBy` is (core 0045 backfill). */
  readonly connectedByName: string | null;
  readonly suspendedByLogin: string | null;
}

interface SelfConnectionDbRow {
  workspace_id: string;
  gatekeeper_object_id: string;
  connector: string;
  target: string;
  endpoint: string;
  connected_by: string | null;
  connected_at: Date;
  suspended_at: Date | null;
  suspended_by_user_id: string | null;
  suspension_reason: string | null;
}

const SELF_CONNECTION_COLUMNS = `s.workspace_id, s.gatekeeper_object_id, s.connector, s.target,
  s.endpoint, s.connected_by, s.connected_at, s.suspended_at, s.suspended_by_user_id,
  s.suspension_reason`;

function mapSelfConnection(row: SelfConnectionDbRow): SelfConnectionRow {
  return {
    workspaceId: row.workspace_id,
    gatekeeperObjectId: row.gatekeeper_object_id,
    connector: row.connector,
    target: row.target,
    endpoint: row.endpoint,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    suspendedAt: row.suspended_at,
    suspendedByUserId: row.suspended_by_user_id,
    suspensionReason: row.suspension_reason,
  };
}

export async function insertSelfConnection(
  client: PoolClient,
  input: {
    readonly workspaceId: string;
    readonly gatekeeperObjectId: string;
    readonly connector: string;
    readonly target: string;
    readonly endpoint: string;
    readonly connectedBy: string;
  },
): Promise<void> {
  await client.query(
    `insert into workspace_self_connections
       (workspace_id, gatekeeper_object_id, connector, target, endpoint, connected_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.workspaceId,
      input.gatekeeperObjectId,
      input.connector,
      input.target,
      input.endpoint,
      input.connectedBy,
    ],
  );
}

export async function findSelfConnection(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
): Promise<SelfConnectionRow | null> {
  const result = await client.query<SelfConnectionDbRow>(
    `select ${SELF_CONNECTION_COLUMNS} from workspace_self_connections s
      where s.workspace_id = $1 and s.gatekeeper_object_id = $2`,
    [workspaceId, gatekeeperObjectId],
  );
  const row = result.rows[0];
  return row ? mapSelfConnection(row) : null;
}

/** The landing's origin conversion (a self-connected Gatekeeper linked to the platform instance at
 *  its address). `false` when no unsuspended row was deleted — RLS never lets a workspace delete a
 *  suspended one, and the landing refuses that case before it gets here. */
export async function deleteSelfConnection(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
): Promise<boolean> {
  const result = await client.query(
    `delete from workspace_self_connections
      where workspace_id = $1 and gatekeeper_object_id = $2 and suspended_at is null`,
    [workspaceId, gatekeeperObjectId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Platform plane: every self connection, newest first, optionally one connector's, one
 *  workspace's or one Gatekeeper's. */
export async function listSelfConnections(
  client: PoolClient,
  filter: {
    readonly connector?: string;
    readonly workspaceId?: string;
    readonly gatekeeperId?: string;
  } = {},
): Promise<SelfConnectionListRow[]> {
  const result = await client.query<
    SelfConnectionDbRow & {
      workspace_name: string;
      connected_by_name: string | null;
      suspended_by_login: string | null;
    }
  >(
    `select ${SELF_CONNECTION_COLUMNS}, w.name as workspace_name,
            p.display_name as connected_by_name, u.login as suspended_by_login
       from workspace_self_connections s
       join workspaces w on w.id = s.workspace_id
       left join principals p on p.workspace_id = s.workspace_id and p.id = s.connected_by
       left join users u on u.id = s.suspended_by_user_id
      where ($1::text is null or s.connector = $1::text)
        and ($2::uuid is null or s.workspace_id = $2::uuid)
        and ($3::uuid is null or s.gatekeeper_object_id = $3::uuid)
      order by s.connected_at desc, s.workspace_id, s.gatekeeper_object_id`,
    [filter.connector ?? null, filter.workspaceId ?? null, filter.gatekeeperId ?? null],
  );
  return result.rows.map((row) => ({
    ...mapSelfConnection(row),
    workspaceName: row.workspace_name,
    connectedByName: row.connected_by_name,
    suspendedByLogin: row.suspended_by_login,
  }));
}

/** Platform plane: suspend (`suspend` given) or resume (`null`) one self connection. Returns the
 *  row as it stands afterwards — unchanged when it already was in that state (`changed: false`) —
 *  or `null` when the platform has no such row. */
export async function setSelfConnectionSuspension(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
  suspend: { readonly byUserId: string; readonly reason: string | null } | null,
): Promise<{ readonly row: SelfConnectionRow; readonly changed: boolean } | null> {
  const updated = await client.query<SelfConnectionDbRow>(
    suspend
      ? `update workspace_self_connections s
            set suspended_at = now(), suspended_by_user_id = $3, suspension_reason = $4
          where s.workspace_id = $1 and s.gatekeeper_object_id = $2 and s.suspended_at is null
          returning ${SELF_CONNECTION_COLUMNS}`
      : `update workspace_self_connections s
            set suspended_at = null, suspended_by_user_id = null, suspension_reason = null
          where s.workspace_id = $1 and s.gatekeeper_object_id = $2 and s.suspended_at is not null
          returning ${SELF_CONNECTION_COLUMNS}`,
    suspend
      ? [workspaceId, gatekeeperObjectId, suspend.byUserId, suspend.reason]
      : [workspaceId, gatekeeperObjectId],
  );
  const changedRow = updated.rows[0];
  if (changedRow) return { row: mapSelfConnection(changedRow), changed: true };
  const current = await client.query<SelfConnectionDbRow>(
    `select ${SELF_CONNECTION_COLUMNS} from workspace_self_connections s
      where s.workspace_id = $1 and s.gatekeeper_object_id = $2`,
    [workspaceId, gatekeeperObjectId],
  );
  const row = current.rows[0];
  return row ? { row: mapSelfConnection(row), changed: false } : null;
}
