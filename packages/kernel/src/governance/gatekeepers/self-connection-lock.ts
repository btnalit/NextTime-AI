import type { PoolClient } from 'pg';

/**
 * Serializes the platform's changes to one self connection — a suspend / resume
 * (`application/gates/self-connections.ts`), an approved address change (legacy 701,
 * `gate-address-change-handlers.ts`) — with every workspace path that checks it before acting on
 * it: the catalog claim, the re-sync, and (legacy 701, I-A3) a new ActionRequest reading the
 * address it is bound to. What such a check saw still holds when its transaction commits (#620
 * review M1, and the same check-then-act class). Shared for a check (many at once), exclusive for a
 * change. A held check delays a change by at most that transaction.
 *
 * Here, below `governance/approval` and `application/gates` alike, so both take the one lock.
 */
export async function lockSelfConnectionState(
  client: PoolClient,
  workspaceId: string,
  gatekeeperObjectId: string,
  mode: 'check' | 'change',
): Promise<void> {
  await client.query(
    mode === 'change'
      ? 'select pg_advisory_xact_lock(hashtext($1::text))'
      : 'select pg_advisory_xact_lock_shared(hashtext($1::text))',
    [`self_connection:${workspaceId}:${gatekeeperObjectId}`],
  );
}
