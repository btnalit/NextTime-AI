import type { GateAddressChangeImpactWire, GateAddressChangeStatusWire } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { shownFreeText } from '../../governance/redaction/index.js';

/**
 * application/gates/gate-address-changes: the proposals to move a gate a workspace connected itself
 * to a new address (`gate_address_changes`, migration core 0057; legacy 701). Persistence only —
 * what may be proposed, and when a proposal is applied, is
 * `application/gateway/gate-address-change-handlers.ts`.
 *
 * Who writes what (RLS, core 0057): a workspace transaction inserts its own `proposed` rows and
 * moves them to `withdrawn`, or to `expired` once `expires_at` has passed; only a platform
 * transaction moves one to `applied` or `rejected`. The table's trigger refuses any other change
 * (a proposal's own fields, a final state, `applied` after `expires_at`, `expired` before it).
 */

export interface GateAddressChangeRow {
  readonly workspaceId: string;
  readonly id: string;
  readonly gatekeeperId: string;
  readonly fromEndpoint: string;
  readonly toEndpoint: string;
  readonly toEndpointKey: string;
  readonly newSalt: string;
  readonly manifestDigest: string;
  readonly previewDigest: string;
  readonly impact: GateAddressChangeImpactWire;
  readonly status: GateAddressChangeStatusWire;
  readonly proposedBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByUserId: string | null;
  readonly withdrawnBy: string | null;
  readonly rejectionReason: string | null;
}

/** A row plus the names the platform list shows instead of ids, and what the platform keeps about
 *  the self connection it belongs to. */
export interface PlatformGateAddressChangeRow extends GateAddressChangeRow {
  readonly workspaceName: string;
  readonly proposedByName: string | null;
  readonly decidedByLogin: string | null;
  readonly connector: string;
  readonly target: string;
  readonly suspended: boolean;
  /** `proposed` and past `expires_at` (by the database's clock): it can no longer be applied, and
   *  the next decision or proposal for the gate records it as `expired`. */
  readonly lapsed: boolean;
}

interface GateAddressChangeDbRow {
  workspace_id: string;
  id: string;
  gatekeeper_object_id: string;
  from_endpoint: string;
  to_endpoint: string;
  to_endpoint_key: string;
  new_salt: string;
  manifest_digest: string;
  preview_digest: string;
  impact: GateAddressChangeImpactWire;
  status: GateAddressChangeStatusWire;
  proposed_by: string;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_by_user_id: string | null;
  withdrawn_by: string | null;
  rejection_reason: string | null;
}

const COLUMNS = `c.workspace_id, c.id, c.gatekeeper_object_id, c.from_endpoint, c.to_endpoint,
  c.to_endpoint_key, c.new_salt, c.manifest_digest, c.preview_digest, c.impact, c.status,
  c.proposed_by, c.created_at, c.expires_at, c.decided_at, c.decided_by_user_id, c.withdrawn_by,
  c.rejection_reason`;

function mapRow(row: GateAddressChangeDbRow): GateAddressChangeRow {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    gatekeeperId: row.gatekeeper_object_id,
    fromEndpoint: row.from_endpoint,
    toEndpoint: row.to_endpoint,
    toEndpointKey: row.to_endpoint_key,
    newSalt: row.new_salt,
    manifestDigest: row.manifest_digest,
    previewDigest: row.preview_digest,
    impact: row.impact,
    status: row.status,
    proposedBy: row.proposed_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    withdrawnBy: row.withdrawn_by,
    // The administrator's own words, kept as written and shown as every free text is.
    rejectionReason: shownFreeText(row.rejection_reason),
  };
}

/** Whether a `proposed` row is past its expiry — by the database's clock, which the trigger uses
 *  too, so the two never disagree. */
export async function isExpired(client: PoolClient, row: GateAddressChangeRow): Promise<boolean> {
  const result = await client.query<{ expired: boolean }>('select now() >= $1 as expired', [
    row.expiresAt,
  ]);
  return result.rows[0]?.expired === true;
}

export interface InsertGateAddressChangeInput {
  readonly workspaceId: string;
  readonly gatekeeperId: string;
  readonly fromEndpoint: string;
  readonly toEndpoint: string;
  readonly toEndpointKey: string;
  readonly newSalt: string;
  readonly manifestDigest: string;
  readonly previewDigest: string;
  readonly impact: GateAddressChangeImpactWire;
  readonly proposedBy: string;
}

/** Postgres's unique-violation constraint names a proposal insert can hit. */
export const GATE_ADDRESS_CHANGE_SALT_CONSTRAINT = 'gate_address_changes_new_salt_uniq';
export const GATE_ADDRESS_CHANGE_ONE_OPEN_CONSTRAINT = 'gate_address_changes_one_open_uniq';

/** A workspace's new `proposed` row. A unique violation — the secret already served a proposal
 *  (`GATE_ADDRESS_CHANGE_SALT_CONSTRAINT`), or the gate already has an open one
 *  (`GATE_ADDRESS_CHANGE_ONE_OPEN_CONSTRAINT`) — is the caller's to map. */
export async function insertGateAddressChange(
  client: PoolClient,
  input: InsertGateAddressChangeInput,
): Promise<GateAddressChangeRow> {
  const result = await client.query<GateAddressChangeDbRow>(
    `insert into gate_address_changes as c
       (workspace_id, gatekeeper_object_id, from_endpoint, to_endpoint, to_endpoint_key, new_salt,
        manifest_digest, preview_digest, impact, proposed_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     returning ${COLUMNS}`,
    [
      input.workspaceId,
      input.gatekeeperId,
      input.fromEndpoint,
      input.toEndpoint,
      input.toEndpointKey,
      input.newSalt,
      input.manifestDigest,
      input.previewDigest,
      JSON.stringify(input.impact),
      input.proposedBy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertGateAddressChange: INSERT ... RETURNING produced no row');
  return mapRow(row);
}

/** One proposal, `for update` when the caller is about to decide it. In a workspace transaction a
 *  locking read sees an open proposal only (core 0057's update policy applies to it, and admits
 *  `proposed` rows alone): read without the lock to tell a decided proposal from none. */
export async function findGateAddressChange(
  client: PoolClient,
  workspaceId: string,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<GateAddressChangeRow | null> {
  const result = await client.query<GateAddressChangeDbRow>(
    `select ${COLUMNS} from gate_address_changes c
      where c.workspace_id = $1 and c.id = $2${options.forUpdate ? ' for update' : ''}`,
    [workspaceId, id],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The gate's open proposal (at most one, I-A2), past its expiry or not. */
export async function findOpenGateAddressChange(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GateAddressChangeRow | null> {
  const result = await client.query<GateAddressChangeDbRow>(
    `select ${COLUMNS} from gate_address_changes c
      where c.workspace_id = $1 and c.gatekeeper_object_id = $2 and c.status = 'proposed'`,
    [workspaceId, gatekeeperId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Legacy 715: the gate's latest proposal that is no longer open — final, or `proposed` and past
 *  `expires_at` by the database's clock (`lapsed`, not recorded as `expired` yet). One proposal is
 *  open at a time and a new one records a lapsed one first (I-A2, `expireStaleGateAddressChange`),
 *  so a gate's proposals follow one another: the latest created is the latest ended. */
export async function findLatestEndedGateAddressChange(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<{ readonly row: GateAddressChangeRow; readonly lapsed: boolean } | null> {
  const result = await client.query<GateAddressChangeDbRow>(
    `select ${COLUMNS} from gate_address_changes c
      where c.workspace_id = $1 and c.gatekeeper_object_id = $2
        and (c.status <> 'proposed' or now() >= c.expires_at)
      order by c.created_at desc, c.id desc
      limit 1`,
    [workspaceId, gatekeeperId],
  );
  const row = result.rows[0];
  return row ? { row: mapRow(row), lapsed: row.status === 'proposed' } : null;
}

/** Whether a proposal of this workspace ever carried `salt` — a secret serves one proposal,
 *  whatever became of it. */
export async function gateAddressChangeSaltUsed(
  client: PoolClient,
  workspaceId: string,
  salt: string,
): Promise<boolean> {
  const result = await client.query(
    'select 1 from gate_address_changes where workspace_id = $1 and new_salt = $2',
    [workspaceId, salt],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Lazy expiry: the gate's open proposal, once past `expires_at`, becomes `expired` — on the next
 *  proposal for the gate, so I-A2's one-open index never holds a gate for good. Returns the expired
 *  row, if any. */
export async function expireStaleGateAddressChange(
  client: PoolClient,
  workspaceId: string,
  gatekeeperId: string,
): Promise<GateAddressChangeRow | null> {
  const result = await client.query<GateAddressChangeDbRow>(
    `update gate_address_changes c set status = 'expired', decided_at = now()
      where c.workspace_id = $1 and c.gatekeeper_object_id = $2 and c.status = 'proposed'
        and now() >= c.expires_at
      returning ${COLUMNS}`,
    [workspaceId, gatekeeperId],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** One `proposed` row to a final state — `withdrawn` (`withdrawnBy`), `rejected` / `applied`
 *  (`decidedByUserId`, a platform transaction), or `expired`. `null` when it was not `proposed`
 *  any more (the caller read it first, `for update`, so this is a lost race only for a caller that
 *  did not). The trigger refuses `applied` past `expires_at` and `expired` before it. */
export async function settleGateAddressChange(
  client: PoolClient,
  workspaceId: string,
  id: string,
  outcome:
    | { readonly status: 'withdrawn'; readonly withdrawnBy: string }
    | { readonly status: 'applied'; readonly decidedByUserId: string }
    | {
        readonly status: 'rejected';
        readonly decidedByUserId: string;
        readonly reason: string | null;
      }
    | { readonly status: 'expired' },
): Promise<GateAddressChangeRow | null> {
  const result = await client.query<GateAddressChangeDbRow>(
    `update gate_address_changes c
        set status = $3, decided_at = now(), withdrawn_by = $4, decided_by_user_id = $5,
            rejection_reason = $6
      where c.workspace_id = $1 and c.id = $2 and c.status = 'proposed'
      returning ${COLUMNS}`,
    [
      workspaceId,
      id,
      outcome.status,
      outcome.status === 'withdrawn' ? outcome.withdrawnBy : null,
      outcome.status === 'applied' || outcome.status === 'rejected'
        ? outcome.decidedByUserId
        : null,
      outcome.status === 'rejected' ? outcome.reason : null,
    ],
  );
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Platform plane: proposals newest first, optionally one status's or one workspace's — or one
 *  proposal (`id`). */
export async function listGateAddressChanges(
  client: PoolClient,
  filter: {
    readonly status?: GateAddressChangeStatusWire;
    readonly workspaceId?: string;
    readonly id?: string;
  } = {},
): Promise<PlatformGateAddressChangeRow[]> {
  const result = await client.query<
    GateAddressChangeDbRow & {
      workspace_name: string;
      proposed_by_name: string | null;
      decided_by_login: string | null;
      connector: string | null;
      target: string | null;
      suspended: boolean;
      lapsed: boolean;
    }
  >(
    `select ${COLUMNS}, w.name as workspace_name, p.display_name as proposed_by_name,
            u.login as decided_by_login, s.connector, s.target,
            (s.suspended_at is not null) as suspended,
            (c.status = 'proposed' and now() >= c.expires_at) as lapsed
       from gate_address_changes c
       join workspaces w on w.id = c.workspace_id
       left join principals p on p.workspace_id = c.workspace_id and p.id = c.proposed_by
       left join users u on u.id = c.decided_by_user_id
       left join workspace_self_connections s
         on s.workspace_id = c.workspace_id and s.gatekeeper_object_id = c.gatekeeper_object_id
      where ($1::text is null or c.status = $1::text)
        and ($2::uuid is null or c.workspace_id = $2::uuid)
        and ($3::uuid is null or c.id = $3::uuid)
      order by c.created_at desc, c.workspace_id, c.id`,
    [filter.status ?? null, filter.workspaceId ?? null, filter.id ?? null],
  );
  return result.rows.map((row) => ({
    ...mapRow(row),
    workspaceName: row.workspace_name,
    proposedByName: row.proposed_by_name,
    decidedByLogin: row.decided_by_login,
    // A self connection the landing converted into a catalog link (deleted it) leaves its
    // proposals behind; they are shown with no connector or target.
    connector: row.connector ?? '',
    target: row.target ?? '',
    suspended: row.suspended === true,
    lapsed: row.lapsed === true,
  }));
}
