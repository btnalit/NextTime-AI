import type { PlatformEventName } from '@nexttime/shared';
import type { PoolLike } from '../../adapters/db/pool.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';

/**
 * application/outbox/dispatcher: the read side of the transactional outbox (design doc §7.10
 * "领域事件与 outbox"; docs/development-tasks.md S1.4 deliverable 3). `substrate/outbox/enqueue.ts`
 * is the single write path (one row per domain event, in the same transaction as the state
 * change it describes); this module is the single read path — it polls for undelivered rows,
 * hands each one to every in-process consumer registered for its `event_type`, and marks it
 * delivered, so every other module can react to a domain event without importing the producer's
 * internals or querying its tables (§7.10 module contract).
 *
 * Delivery unit is one outbox row per short transaction (`SELECT ... FOR UPDATE SKIP LOCKED
 * LIMIT 1`, deliver, `UPDATE dispatched_at`, `COMMIT`) — not one transaction per poll batch. Two
 * reasons this module chooses the smaller unit:
 *
 *   1. A batch-wide transaction would need to hold `FOR UPDATE` row locks across every consumer
 *      call in the batch; a slow or hanging consumer for row 3 of 20 would then block delivery of
 *      the other 19 rows already selected in the same transaction (and, transitively, block any
 *      other dispatcher instance's `SKIP LOCKED` poll from reaching rows this one hasn't gotten to
 *      yet). Per-row transactions bound that blast radius to the one row.
 *   2. A consumer that throws must not prevent the *rest* of the outbox from draining (no
 *      dead-letter/retry-limit mechanism exists yet — out of S1.4 scope, design doc §18 risk
 *      register). With a per-row transaction, a consumer error rolls back only that row's
 *      `dispatched_at` update (via the throw propagating out of `processOneRow`, caught by
 *      `pollOnce`'s caller), leaving it `dispatched_at IS NULL` for the next poll to retry
 *      indefinitely — a poison-pill event only ever blocks itself, never its neighbors.
 *
 * Cross-workspace polling: outbox rows for every workspace must be visible to one dispatcher
 * instance (there is exactly one kernel process, not one per workspace), which RLS's per-request
 * `app.workspace_id` session variable cannot express — so, deliberately, this module never calls
 * `withWorkspace()` (adapters/db/pool.ts). It uses `pool.connect()` directly and stays on the
 * connection's own login role, the same "superuser bypasses RLS by design" escape hatch
 * `application/gateway/auth.ts`'s `withAdminClient` already documents and relies on (S1.1: the
 * compose Postgres login user is a superuser). This is a deliberate, narrow exception to "every
 * kernel write path goes through `withWorkspace()`" — see that module's own doc comment for why
 * the exception exists (S1.1's RLS design has no other answer for "read across every workspace").
 *
 * Idempotent consumers: a consumer that already partially acted before this row's transaction
 * rolls back (crash, or the DB connection itself dying mid-batch) *will* see the same event again
 * on the next poll — `meta.outboxId` is handed to every consumer specifically so it can dedupe
 * (design doc §13 "outbox 派发器崩溃 ... 消费者幂等"; docs/development-tasks.md S1.4: "consumers
 * idempotent (dedupe on the outbox row id)"). This module provides the id; deduping on it is each
 * consumer's own responsibility (see `application/host-bridge`'s `TurnStarted` consumer for the
 * pattern this codebase uses).
 */

export interface OutboxDeliveryMeta {
  /** `outbox.id` (bigserial, per-workspace-scoped PK alongside `workspace_id`) — the dedupe key a
   *  consumer should track to stay idempotent across a crash-and-replay. */
  readonly outboxId: string;
  readonly workspaceId: string;
}

export type OutboxConsumer<E extends DomainEvent = DomainEvent> = (
  event: E,
  meta: OutboxDeliveryMeta,
) => Promise<void> | void;

export interface OutboxDispatcherOptions {
  /** Poll interval in milliseconds when running via `start()`. Default 200 (docs/development-
   *  tasks.md S1.4: "short interval e.g. 200 ms"). */
  readonly pollIntervalMs?: number;
  /** Max outbox rows drained per `pollOnce()` call. Default 20 ("small batch"). */
  readonly batchSize?: number;
  /** Called whenever `processOneRow` throws (a consumer error, or a DB error) during the
   *  interval-driven loop started by `start()` — `pollOnce()` itself still rejects when called
   *  directly (e.g. from a test), this hook only covers the unattended `start()` path so a
   *  rejection there never becomes an unhandled promise rejection. Defaults to a no-op; callers
   *  that want visibility (structured logging, design doc §12) should pass one. */
  readonly onError?: (error: unknown) => void;
}

interface OutboxRow {
  id: string;
  workspace_id: string;
  event_type: string;
  payload: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_BATCH_SIZE = 20;

/**
 * In-process outbox dispatcher over one `PoolLike` (a real `pg.Pool` in production; a fake with
 * just `.connect()` in unit tests). `subscribe()` registers a consumer for one event type;
 * `start()`/`stop()` drive an interval-based poll loop; `pollOnce()` drains up to
 * `batchSize` rows immediately (used directly by tests and by the S1.4 "replay everything
 * undelivered on startup" requirement — a plain `start()` already replays on its very first tick,
 * but callers that need the replay to have *finished* before proceeding, e.g. an integration
 * test, should call `pollOnce()` in a loop instead).
 */
export class OutboxDispatcher {
  private readonly pool: PoolLike;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly onError: (error: unknown) => void;
  private readonly consumers = new Map<string, Set<OutboxConsumer>>();
  private timer: NodeJS.Timeout | undefined;
  /** Reentrancy guard: a slow poll must not overlap the next interval tick. */
  private polling = false;

  constructor(pool: PoolLike, options: OutboxDispatcherOptions = {}) {
    this.pool = pool;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.onError = options.onError ?? (() => {});
  }

  /** Registers `consumer` for every outbox row whose `event_type` is `eventType`. Returns an
   *  unsubscribe function. Multiple consumers may subscribe to the same event type; each is
   *  called (in registration order) for every matching row. */
  subscribe<T extends PlatformEventName>(
    eventType: T,
    consumer: OutboxConsumer<Extract<DomainEvent, { type: T }>>,
  ): () => void {
    const set = this.consumers.get(eventType) ?? new Set<OutboxConsumer>();
    set.add(consumer as OutboxConsumer);
    this.consumers.set(eventType, set);
    return () => {
      set.delete(consumer as OutboxConsumer);
    };
  }

  /** Starts the interval-driven poll loop. Idempotent — a second call while already running is a
   *  no-op. The timer is `unref()`'d so an otherwise-idle process (e.g. a test runner) is not kept
   *  alive solely by this dispatcher. */
  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      this.pollOnce().catch((error: unknown) => this.onError(error));
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stops the poll loop. Does not wait for an in-flight `pollOnce()` to finish — safe, since each
   *  row is delivered inside its own committed-or-rolled-back transaction. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Drains up to `batchSize` undelivered rows right now, delivering each in its own transaction.
   * Resolves with the number of rows delivered. A row whose delivery throws (a consumer error, or
   * a DB error) is left undelivered (its own transaction rolled back) for a later poll to retry —
   * it does not stop this call from continuing on to the *next* row (the "a poison-pill event only
   * ever blocks itself, never its neighbors" guarantee in this class's own doc comment holds
   * within one `pollOnce()` call, not just across separate polls). If one or more rows failed,
   * `pollOnce()` still rejects after attempting the rest of the batch, with the first error
   * encountered (`cause` on later ones, if any, is not preserved individually — callers that need
   * per-row error detail should pass `onError` to the constructor instead of relying on this
   * rejection).
   */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      let delivered = 0;
      let firstError: unknown;
      // Rows that failed earlier *in this call* — excluded from the next SELECT so a retry within
      // the same pollOnce() moves on to a different row instead of immediately re-selecting the
      // one that just failed (its transaction rolled back, so `dispatched_at` is still null and
      // `order by id` would otherwise hand it straight back).
      const failedIds: string[] = [];
      for (let i = 0; i < this.batchSize; i += 1) {
        let didDeliver: boolean;
        try {
          didDeliver = await this.processOneRow(failedIds);
        } catch (err) {
          firstError ??= err;
          continue;
        }
        if (!didDeliver) break;
        delivered += 1;
      }
      if (firstError !== undefined) throw firstError;
      return delivered;
    } finally {
      this.polling = false;
    }
  }

  /** Delivers exactly one undelivered row not in `excludeIds`, or returns `false` if none remain
   *  right now. On failure, appends the row's id to `excludeIds` before rethrowing, so the caller's
   *  next attempt (within the same `pollOnce()` batch) skips it. */
  private async processOneRow(excludeIds: string[]): Promise<boolean> {
    const client = await this.pool.connect();
    let selectedId: string | undefined;
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRow>(
        `select id, workspace_id, event_type, payload
         from outbox
         where dispatched_at is null
           and not (id = any($1::bigint[]))
         order by id
         limit 1
         for update skip locked`,
        [excludeIds],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return false;
      }
      selectedId = row.id;

      const consumers = this.consumers.get(row.event_type);
      if (consumers && consumers.size > 0) {
        const event = row.payload as DomainEvent;
        const meta: OutboxDeliveryMeta = {
          outboxId: String(row.id),
          workspaceId: row.workspace_id,
        };
        for (const consumer of consumers) {
          await consumer(event, meta);
        }
      }

      await client.query(
        'update outbox set dispatched_at = now(), attempts = attempts + 1 where workspace_id = $1 and id = $2',
        [row.workspace_id, row.id],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // Best-effort: the connection may already be unusable. The original error is what matters.
      });
      if (selectedId !== undefined) excludeIds.push(selectedId);
      throw err;
    } finally {
      client.release();
    }
  }
}
