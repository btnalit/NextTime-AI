import { type PlatformEvent, type PlatformEventName, PlatformEventSchema } from '@nexttime/shared';
import type { PoolClient } from 'pg';

/**
 * adapters/db/outbox: a tiny `enqueue(client, event)` helper over the `outbox` table
 * (migrations/core/0005_outbox.sql; design doc §7.10 "领域事件与 outbox") — the transactional-
 * outbox write side. Meant for the application/interfaces layers (chat/task/host-bridge, S1.4
 * onward), which `.dependency-cruiser.cjs` permits to import `adapters/*`; `substrate` and
 * `governance` may not (see substrate/graph/sql-store.ts's module doc for how its own
 * `FactAsserted` write works around that with an inline insert instead of this helper).
 *
 * Like `withWorkspace()` (./pool.ts), this takes an already-open `PoolClient` and does not open
 * a `Pool` or manage a transaction itself — call it inside the same transaction as the write
 * whose effect the event describes, so the two commit or roll back together.
 */

/**
 * `PlatformEvent` (packages/shared/src/events.ts) is one discriminated union for two families:
 * the nine domain/outbox events (§7.10 vocabulary — `workspaceId`-bearing, this table's payload
 * shape) and the chat WebSocket push events (§9.4 — no `workspaceId`, never written to this
 * table). `DomainEvent` narrows to just the former via `PlatformEventName`
 * (`PLATFORM_EVENT_NAMES`), so `enqueue()` can't be called with a WS-only event by mistake.
 */
export type DomainEvent = Extract<PlatformEvent, { type: PlatformEventName }>;

/** Validates `event` against `PlatformEventSchema` (throws on shape mismatch) and appends it to
 *  `outbox` for `event.workspaceId`. */
export async function enqueue(client: PoolClient, event: DomainEvent): Promise<void> {
  PlatformEventSchema.parse(event);
  await client.query(
    'insert into outbox (workspace_id, event_type, payload) values ($1, $2, $3::jsonb)',
    [event.workspaceId, event.type, JSON.stringify(event)],
  );
}
