import type { PoolClient } from 'pg';

/**
 * application/gates/availability (legacy 254): the lock that orders "can a workspace still enable
 * this platform gate instance?" against the platform changing the answer.
 *
 * `request_gate_instance_enable` and `enable_gate_instance` read the instance and its connector
 * (`requireAvailable`) and then write; `update_gate_instance` (→ disabled), `delete_gate_instance`
 * and `set_connector_mode` (out of platform-preset) change the answer and end the open requests
 * for it. Without an order, a request read just before the platform's change commits would be
 * inserted after the platform cancelled the open ones and stay open for a gate no one can enable.
 * So the readers hold the instance's key shared and the platform holds it exclusive, both to the
 * end of the transaction: a request either commits first (and the platform's cancel, waiting on
 * the lock, then ends it) or reads the platform's change after it committed (and is refused).
 *
 * Lock order: a workspace call takes `enable_gate:<workspace>:<gate>` (gate-instance-handlers)
 * first and this one second; the platform takes only this one, for several gates in `gate_id`
 * order. No cycle.
 */

function availabilityKey(gateId: string): string {
  return `gate_instance_availability:${gateId}`;
}

/** A workspace call that decides on the instance being available holds this until it commits. */
export async function lockGateInstanceAvailabilityShared(
  client: PoolClient,
  gateId: string,
): Promise<void> {
  await client.query('select pg_advisory_xact_lock_shared(hashtext($1::text))', [
    availabilityKey(gateId),
  ]);
}

/** A platform call about to make these instances unavailable — taken before it changes anything. */
export async function lockGateInstancesAvailabilityExclusive(
  client: PoolClient,
  gateIds: readonly string[],
): Promise<void> {
  for (const gateId of [...new Set(gateIds)].sort()) {
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [
      availabilityKey(gateId),
    ]);
  }
}
