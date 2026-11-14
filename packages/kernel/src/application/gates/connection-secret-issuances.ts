import type { PoolClient } from 'pg';

/**
 * application/gates/connection-secret-issuances (legacy 711): the ledger of connection-secret
 * salts the kernel issued (core 0058, which has the lifecycle and why). A connection secret is
 * verified statelessly (`saltOf` — minted here, for this workspace), and this ledger adds what that
 * cannot: that the secret is fresh. Every salt `mint_connection_secret` hands out gets a row,
 * usable once, within 24 hours, by `create_connection` or `propose_gate_address_change`;
 * `rotate_connection_secret`'s goes straight onto its gate and is recorded consumed. Only the salt
 * is stored, never the secret.
 */

/** The capability that issued a salt. */
export type ConnectionSecretIssuer = 'mint_connection_secret' | 'rotate_connection_secret';

/** The capability that bound a salt to a gate (or a proposal to move one). */
export type ConnectionSecretConsumer =
  | 'create_connection'
  | 'propose_gate_address_change'
  | 'rotate_connection_secret';

/** Where a presented salt stands: usable by a binding call, already bound, or past its use. */
export type ConnectionSecretIssuanceState =
  | { readonly state: 'usable' }
  | { readonly state: 'consumed'; readonly consumedBy: ConnectionSecretConsumer }
  /** Minted more than 24 hours ago and not used — or minted before the ledger, or deleted by a
   *  later mint once expired: no row says it is fresh. */
  | { readonly state: 'expired' };

/** `mint_connection_secret`: records `salt` as issued and usable for 24 hours, and first deletes
 *  the workspace's issued salts that expired unused (none of them can be consumed any more — the
 *  next presentation of one finds no row and is refused the same way). */
export async function recordMintedConnectionSecret(
  client: PoolClient,
  workspaceId: string,
  salt: string,
  issuedBy: string,
): Promise<void> {
  await client.query(
    `delete from connection_secret_issuances
      where workspace_id = $1 and consumed_at is null and expires_at <= now()`,
    [workspaceId],
  );
  await client.query(
    `insert into connection_secret_issuances (workspace_id, salt, issued_via, issued_by)
     values ($1, $2, 'mint_connection_secret', $3)`,
    [workspaceId, salt, issuedBy],
  );
}

/** `rotate_connection_secret`: records `salt` as issued and bound at once — the rotation sets it
 *  on the gate in the same transaction. */
export async function recordRotatedConnectionSecret(
  client: PoolClient,
  workspaceId: string,
  salt: string,
  issuedBy: string,
): Promise<void> {
  await client.query(
    `insert into connection_secret_issuances
       (workspace_id, salt, issued_via, issued_by, consumed_at, consumed_by)
     values ($1, $2, 'rotate_connection_secret', $3, now(), 'rotate_connection_secret')`,
    [workspaceId, salt, issuedBy],
  );
}

/** Where `salt` stands in this workspace's ledger, without changing it (a preview's check). */
export async function connectionSecretIssuanceState(
  client: PoolClient,
  workspaceId: string,
  salt: string,
): Promise<ConnectionSecretIssuanceState> {
  const result = await client.query<{
    consumed_by: ConnectionSecretConsumer | null;
    live: boolean;
  }>(
    `select consumed_by, expires_at > now() as live
       from connection_secret_issuances where workspace_id = $1 and salt = $2`,
    [workspaceId, salt],
  );
  const row = result.rows[0];
  if (!row) return { state: 'expired' };
  if (row.consumed_by !== null) return { state: 'consumed', consumedBy: row.consumed_by };
  return row.live ? { state: 'usable' } : { state: 'expired' };
}

/** Binds `salt` for `consumer`: one conditional update, so of two transactions presenting the same
 *  secret exactly one consumes it — the other waits on the row lock and then finds it consumed.
 *  Returns `usable` when this call consumed it (it rolls back with the caller's transaction), or
 *  where the salt stands instead. */
export async function consumeConnectionSecret(
  client: PoolClient,
  workspaceId: string,
  salt: string,
  consumer: Exclude<ConnectionSecretConsumer, 'rotate_connection_secret'>,
): Promise<ConnectionSecretIssuanceState> {
  const result = await client.query(
    `update connection_secret_issuances set consumed_at = now(), consumed_by = $3
      where workspace_id = $1 and salt = $2 and consumed_at is null and expires_at > now()`,
    [workspaceId, salt, consumer],
  );
  if ((result.rowCount ?? 0) === 1) return { state: 'usable' };
  return connectionSecretIssuanceState(client, workspaceId, salt);
}
