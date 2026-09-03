import type { PoolClient } from 'pg';
import type { ContextItemKind } from './types.js';

/**
 * application/linkage/store: the one read/write path for `pending_context_items`
 * (migrations/linkage/0001_pending_context_items.sql) — see that migration's own doc comment and
 * `application/linkage/index.ts`'s module doc comment for the full design.
 */

export interface InsertPendingContextItemInput {
  readonly principalId: string;
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
       (workspace_id, principal_id, kind, subject_id, payload, source_outbox_id)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (workspace_id, principal_id, source_outbox_id) do nothing`,
    [
      workspaceId,
      input.principalId,
      input.kind,
      input.subjectId,
      JSON.stringify(input.payload),
      input.sourceOutboxId,
    ],
  );
}

export interface DrainedContextItems {
  /** `payload`s of every undelivered non-`action_request_update` item, oldest first. */
  readonly tasks: readonly Record<string, unknown>[];
  /** `payload`s of every undelivered `action_request_update` item, oldest first. */
  readonly pendingApprovals: readonly Record<string, unknown>[];
}

/**
 * Reads every undelivered `pending_context_items` row for `principalId` and marks them delivered
 * — in the same transaction `client` belongs to, so a downstream failure in the caller (e.g.
 * `get_entry_context`'s Fact read) rolls this back too and the items remain undelivered for the
 * next call, never silently lost. Called exactly once per `get_entry_context` invocation
 * (`application/gateway/handlers.ts`).
 */
export async function drainPendingContextItems(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
): Promise<DrainedContextItems> {
  const result = await client.query<{
    id: string;
    kind: ContextItemKind;
    payload: Record<string, unknown>;
  }>(
    `select id, kind, payload from pending_context_items
     where workspace_id = $1 and principal_id = $2 and delivered_at is null
     order by created_at asc`,
    [workspaceId, principalId],
  );
  if (result.rows.length === 0) return { tasks: [], pendingApprovals: [] };

  const ids = result.rows.map((row) => row.id);
  await client.query(
    `update pending_context_items set delivered_at = now()
     where workspace_id = $1 and id = any($2::uuid[])`,
    [workspaceId, ids],
  );

  const tasks: Record<string, unknown>[] = [];
  const pendingApprovals: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    if (row.kind === 'action_request_update') pendingApprovals.push(row.payload);
    else tasks.push(row.payload);
  }
  return { tasks, pendingApprovals };
}
