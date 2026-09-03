import type { PoolClient } from 'pg';
import {
  markActionRequestExecuted,
  markActionRequestFailed,
  startActionRequestExecution,
} from './execution.js';
import { listExecutableQueue } from './reads.js';
import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/drainer: per-Gatekeeper single-flight drain (design doc §7.4/§8.1;
 * docs/development-tasks.md S2.3 "drain 每 Gatekeeper 单飞、升序、遇 pending 停；执行去经过一个注入的
 * ActionExecutor 端口"). Execution goes through the injected `ActionExecutor` port below — the
 * real Gatekeeper client is S2.4 (out of this task's scope, per its "Must NOT" list); this file
 * defines the interface plus the drain loop, tested against a fake `ActionExecutor`.
 */

export interface ActionExecutorResult {
  readonly ok: boolean;
  /** Free-form result metadata on success — S2.4 defines the real shape (Gatekeeper `apply`
   *  response); this module only threads it through to `markActionRequestExecuted`. */
  readonly resultMetadata?: Record<string, unknown>;
  /** Failure reason on `ok: false` — threaded through to `markActionRequestFailed`. */
  readonly reason?: string;
}

/** The port `drainGatekeeper` calls to actually perform one `executing` ActionRequest's effect
 *  against its Gatekeeper (§5.1.4 "门" protocol `apply`). */
export interface ActionExecutor {
  execute(actionRequest: ActionRequestRow): Promise<ActionExecutorResult>;
}

export interface ApprovalDrainerDeps {
  readonly executor: ActionExecutor;
  /**
   * Opens one short-lived DB transaction scoped to `(workspaceId, principalId)` and passes its
   * client to `fn`, committing on success / rolling back on throw — the drainer calls this once
   * per DB write (listing the queue; starting execution; marking executed/failed), never once for
   * the whole `drainGatekeeper()` call, so a slow or failing external Gatekeeper call
   * (`deps.executor.execute`, called *outside* any of these transactions) never holds a DB
   * transaction open across network I/O, and a failure on row N never rolls back row N-1's
   * already-committed execution.
   *
   * Composition-root-supplied: this module cannot import `adapters/db/pool.ts`'s `withWorkspace`
   * itself (§7.10 layering — governance may not depend on adapters); the real implementation the
   * composition root binds here *is* `withWorkspace` under the hood. Tests pass a fake, or (as this
   * module's own test file does, being excluded from the layering rule like every `*.test.ts`)
   * `withWorkspace` directly against real Postgres.
   */
  readonly withTransaction: <T>(
    workspaceId: string,
    principalId: string,
    fn: (client: PoolClient) => Promise<T>,
  ) => Promise<T>;
}

export interface DrainResult {
  readonly processed: number;
  /** `true` if the drain stopped because it reached a `pending_approval` row before exhausting the
   *  queue (§8.1 "遇 pending 停"). */
  readonly stoppedAtPending: boolean;
  /** `true` if this call was a no-op because another drain for the same
   *  `(workspaceId, gatekeeperId)` was already in flight (single-flight, per-Gatekeeper). */
  readonly skippedInFlight: boolean;
}

/**
 * Drains one Gatekeeper's executable ActionRequest queue: `auto_approved`/`approved` rows execute
 * in ascending `requested_at` order; a `pending_approval` row (still awaiting a human decision)
 * stops the drain immediately, before touching it or anything after it in the queue.
 * Per-`(workspaceId, gatekeeperId)` single-flight — a second concurrent call for the same pair
 * while one is already running returns immediately with `skippedInFlight: true` rather than
 * queueing or racing.
 */
export class ApprovalDrainer {
  private readonly deps: ApprovalDrainerDeps;
  private readonly inFlight = new Set<string>();

  constructor(deps: ApprovalDrainerDeps) {
    this.deps = deps;
  }

  async drainGatekeeper(
    workspaceId: string,
    principalId: string,
    gatekeeperId: string,
  ): Promise<DrainResult> {
    const key = `${workspaceId}:${gatekeeperId}`;
    if (this.inFlight.has(key)) {
      return { processed: 0, stoppedAtPending: false, skippedInFlight: true };
    }
    this.inFlight.add(key);

    try {
      const queue = await this.deps.withTransaction(workspaceId, principalId, (client) =>
        listExecutableQueue(client, workspaceId, gatekeeperId),
      );

      let processed = 0;
      for (const row of queue) {
        if (row.status === 'pending_approval') {
          return { processed, stoppedAtPending: true, skippedInFlight: false };
        }

        const executing = await this.deps.withTransaction(workspaceId, principalId, (client) =>
          startActionRequestExecution(client, workspaceId, row.id),
        );

        const result = await this.deps.executor.execute(executing);

        await this.deps.withTransaction(workspaceId, principalId, (client) =>
          result.ok
            ? markActionRequestExecuted(client, workspaceId, row.id, {
                resultMetadata: result.resultMetadata,
              })
            : markActionRequestFailed(client, workspaceId, row.id, { reason: result.reason }),
        );

        processed += 1;
      }

      return { processed, stoppedAtPending: false, skippedInFlight: false };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
