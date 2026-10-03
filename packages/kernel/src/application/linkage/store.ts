import type { PoolClient } from 'pg';
import type { ContextItemKind } from './types.js';

/**
 * application/linkage/store: the one read/write path for `pending_context_items`
 * (migrations/linkage/0001_pending_context_items.sql, 0002_context_item_chat_lease.sql) — see those
 * migrations' own doc comments and `application/linkage/index.ts`'s module doc comment for the full
 * design.
 *
 * Delivery (2026-10-02 review R-57, maintainer decision D-23): an item belongs to one Chat and is
 * shown to that Chat's Turns until a Turn that saw it is acknowledged by `report_turn`.
 *   - `leaseContextItemsToTurn` (`get_entry_context` with a `turnId`) returns the same items for
 *     every call of one Turn — each LLM call, a provider-error retry — and never consumes them.
 *   - `acknowledgeTurnContextItems` (`report_turn`) is the only thing that does.
 *   - `peekContextItems` (`get_entry_context` without a Turn: interactive / MCP sessions) reads
 *     and writes nothing.
 * So no read without an acknowledgement loses an item, and a Chat only sees its own items.
 */

export interface InsertPendingContextItemInput {
  readonly principalId: string;
  /** The Chat this item belongs to (R-57, D-23) — the Chat whose Turn invoked the Task / whose
   *  Task's Worker raised the ActionRequest, i.e. the Chat the matching system message went to
   *  (`application/linkage/chat-targets.ts`). Only that Chat's Turns lease it. */
  readonly chatId: string;
  readonly kind: ContextItemKind;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  /** `OutboxDeliveryMeta.outboxId` — the dedupe key (`pending_context_items_dedupe_uidx`). */
  readonly sourceOutboxId: string;
}

/**
 * Inserts one pending context item, or silently does nothing if a row for this exact
 * `(principalId, sourceOutboxId)` already exists (`on conflict ... do nothing` against the unique
 * index) — makes a redelivered outbox row (dispatcher crash between this row's own COMMIT and the
 * outbox row's `dispatched_at` UPDATE) a no-op instead of a duplicate context item.
 */
export async function insertPendingContextItem(
  client: PoolClient,
  workspaceId: string,
  input: InsertPendingContextItemInput,
): Promise<void> {
  await client.query(
    `insert into pending_context_items
       (workspace_id, principal_id, chat_id, kind, subject_id, payload, source_outbox_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (workspace_id, principal_id, source_outbox_id) do nothing`,
    [
      workspaceId,
      input.principalId,
      input.chatId,
      input.kind,
      input.subjectId,
      JSON.stringify(input.payload),
      input.sourceOutboxId,
    ],
  );
}

export interface EntryContextItems {
  /** `payload`s of the non-`action_request_update` items, oldest first. */
  readonly tasks: readonly Record<string, unknown>[];
  /** `payload`s of the `action_request_update` items, oldest first. */
  readonly pendingApprovals: readonly Record<string, unknown>[];
}

function toEntryContextItems(
  rows: readonly { kind: ContextItemKind; payload: Record<string, unknown> }[],
): EntryContextItems {
  const tasks: Record<string, unknown>[] = [];
  const pendingApprovals: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.kind === 'action_request_update') pendingApprovals.push(row.payload);
    else tasks.push(row.payload);
  }
  return { tasks, pendingApprovals };
}

/** The Turn a `get_entry_context` call is serving: its `activities.id` and that Activity's Chat. */
export interface EntryContextTurn {
  readonly turnId: string;
  readonly chatId: string | null;
}

/**
 * Leases every unacknowledged item of `principalId` that belongs to `turn`'s Chat (or to no Chat —
 * rows written before migration 0002) to `turn`, and returns every item leased to it, oldest first.
 * Nothing is marked delivered: the same call for the same Turn returns the same items (plus any
 * that arrived since) until `acknowledgeTurnContextItems` runs for it.
 *
 * `lease_turn_id is distinct from $3` takes over a lease held by another Turn. That Turn is of the
 * same Chat, and a Chat runs one Turn at a time (`activities_one_running_turn_per_chat_uidx`;
 * agent-host runs one per user), so it has ended — without `report_turn`, or the item would be
 * acknowledged — and showing the item again is the at-least-once side of "no read loses an item".
 *
 * Concurrency: a second call for the same Turn while the first is open blocks on the rows the first
 * UPDATE locked, re-checks them once it commits (now leased to this Turn, so skipped), and its
 * SELECT then sees the committed leases — both calls return the full set, never a duplicate row.
 */
export async function leaseContextItemsToTurn(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  turn: EntryContextTurn,
): Promise<EntryContextItems> {
  await client.query(
    `update pending_context_items set lease_turn_id = $3::uuid
     where workspace_id = $1 and principal_id = $2 and delivered_at is null
       and (chat_id = $4::uuid or chat_id is null)
       and lease_turn_id is distinct from $3::uuid`,
    [workspaceId, principalId, turn.turnId, turn.chatId],
  );
  const result = await client.query<{ kind: ContextItemKind; payload: Record<string, unknown> }>(
    `select kind, payload from pending_context_items
     where workspace_id = $1 and principal_id = $2 and lease_turn_id = $3::uuid
       and delivered_at is null
     order by created_at asc, id asc`,
    [workspaceId, principalId, turn.turnId],
  );
  return toEntryContextItems(result.rows);
}

/**
 * Upper bound on a peek's items. A peek spans every Chat of the principal, and an item now stays
 * until a Turn of its own Chat is acknowledged — items of a Chat nobody returns to would otherwise
 * grow every interactive session's context without limit. The most recent ones are kept.
 */
export const PEEK_CONTEXT_ITEM_LIMIT = 50;

/**
 * Every unacknowledged item of `principalId`, in any Chat (the newest `PEEK_CONTEXT_ITEM_LIMIT`),
 * oldest first. Read-only: no lease, no acknowledgement — an interactive or MCP session's read
 * never takes an item away from the Chat it belongs to.
 */
export async function peekContextItems(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<EntryContextItems> {
  const result = await client.query<{ kind: ContextItemKind; payload: Record<string, unknown> }>(
    `select kind, payload from (
       select kind, payload, created_at, id from pending_context_items
       where workspace_id = $1 and principal_id = $2 and delivered_at is null
       order by created_at desc, id desc
       limit $3
     ) recent
     order by created_at asc, id asc`,
    [workspaceId, principalId, PEEK_CONTEXT_ITEM_LIMIT],
  );
  return toEntryContextItems(result.rows);
}

/**
 * Acknowledges (`delivered_at = now()`) every item of `principalId` currently leased to `turnId` —
 * called by `report_turn`, in its transaction. Items that arrived after the Turn's last
 * `get_entry_context` call were never leased to it and stay for the next Turn; an item another Turn
 * has since taken over is not touched. Idempotent: a second `report_turn` acknowledges only what
 * was leased in between. Returns the number of rows acknowledged.
 */
export async function acknowledgeTurnContextItems(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  turnId: string,
): Promise<number> {
  const result = await client.query(
    `update pending_context_items set delivered_at = now()
     where workspace_id = $1 and principal_id = $2 and lease_turn_id = $3::uuid
       and delivered_at is null`,
    [workspaceId, principalId, turnId],
  );
  return result.rowCount ?? 0;
}
