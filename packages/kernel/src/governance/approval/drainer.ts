import { type ActionRequestFailureKind, IllegalTransition } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import {
  markActionRequestExecuted,
  markActionRequestFailed,
  recordActionRequestInDoubt,
  startActionRequestExecution,
} from './execution.js';
import { planGatekeeperQueue } from './queue.js';
import { listExecutableQueue } from './reads.js';
import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/drainer: per-Gatekeeper single-flight drain (design doc §7.4/§8.1;
 * docs/development-tasks.md S2.3 "drain 每 Gatekeeper 单飞、升序、遇 pending 停；执行去经过一个注入的
 * ActionExecutor 端口"). Execution goes through the injected `ActionExecutor` port below — the
 * real Gatekeeper client is S2.4 (out of this task's scope, per its "Must NOT" list); this file
 * defines the interface plus the drain loop, tested against a fake `ActionExecutor`.
 */

/**
 * What one `ActionExecutor.execute` (or the reaper's replay) came back with. A union, so a failure
 * always says which kind it is — the row's `failure_kind` (S11 GO1) is decided where the call was
 * made, never guessed later from its reason text:
 *
 *   - `ok: true`: the gate ran it. `resultMetadata` is the gate's `apply` response — S2.4 defines
 *     its shape; this module only threads it through to `markActionRequestExecuted`.
 *   - `ok: false`, `indeterminate: true`: the effect's outcome is *unknown*, not failed — the gate
 *     call timed out and the gate may still finish (real-model regression 2026-10-02: an
 *     ActionRequest marked `failed` whose container restart completed anyway), or the connection
 *     failed after the request may have reached the gate (legacy 287). The drainer then writes no
 *     terminal state, leaves the row `executing`, records why (`recordActionRequestInDoubt`, an
 *     audit row) and goes on (R-50: the row is now a barrier for the rest of this Gatekeeper's
 *     queue that conflicts with it, S11 GO12); the stale-executing reaper (`application/gateway/action-executor.ts`'s
 *     `reapStaleExecutingActionRequests`) asks the gate later under the same `actionRequestId`, and
 *     the gate's idempotency store answers.
 *   - `ok: false` otherwise: a terminal failure of `failureKind` (`not_delivered` / `refused` /
 *     `outcome_unknown`), threaded through to `markActionRequestFailed` with its `reason`.
 */
export type ActionExecutorResult =
  | { readonly ok: true; readonly resultMetadata?: Record<string, unknown> }
  | { readonly ok: false; readonly indeterminate: true; readonly reason?: string }
  | {
      readonly ok: false;
      readonly indeterminate?: false;
      readonly failureKind: ActionRequestFailureKind;
      readonly reason?: string;
    };

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
  /** `true` if the drain ended with a `pending_approval` row still in the queue (§8.1 "遇 pending
   *  停"): nothing after it that conflicts with it runs until it is decided (S11 GO12, I-Q1). */
  readonly stoppedAtPending: boolean;
  /** R-50: `true` if the drain ended with an `executing` row in the queue — an `apply` still in
   *  flight on another drain trigger, or one whose outcome is unknown (this drain may just have left
   *  it so). Nothing after it that conflicts with it runs until it resolves. */
  readonly stoppedAtExecuting: boolean;
  /** `true` if this call was a no-op because another drain for the same
   *  `(workspaceId, gatekeeperId)` was already in flight (single-flight, per-Gatekeeper). */
  readonly skippedInFlight: boolean;
}

/**
 * Drains one Gatekeeper's executable ActionRequest queue: `auto_approved`/`approved` rows execute
 * in ascending `requested_at` order, one at a time; a `pending_approval` row (still awaiting a
 * human decision) holds back every later row that conflicts with it, never touched by the drain.
 *
 * R-50 (maintainer decision D-10), narrowed by S11 GO12 to what conflicts (I-Q1,
 * `governance/approval/queue.ts`): a row starts only when no earlier row of its Gatekeeper that
 * conflicts with it — one acting on the whole Gatekeeper, or on the same instance — is still in
 * the queue. Rows that declare no target conflict with every row, so for them the order is the
 * per-Gatekeeper serial one it always was. It is enforced by the database rather than by this
 * object: an `executing` row (another trigger's `apply` in flight, or an earlier outcome unknown)
 * holds back what conflicts with it the same way, and an indeterminate result leaves its row
 * `executing`, holding back its own conflict domain while the drain goes on with the rest. Every
 * drain trigger — the request path's phase 2, the outbox consumer, the periodic tick, each with
 * its own drainer instance — sees the same `executing` row, and `startActionRequestExecution`'s
 * conditional UPDATE lets only one of them start any given row; two instances may so apply two
 * rows of one Gatekeeper at once, when the two do not conflict. The queue is re-read after every
 * row, so a row approved while this drain was applying an earlier one is picked up here rather
 * than waiting for the next tick.
 *
 * Per-`(workspaceId, gatekeeperId)` single-flight within this instance — a second concurrent call
 * for the same pair while one is already running returns immediately with `skippedInFlight: true`
 * rather than queueing or racing. That set only saves a redundant drain; the barrier above is what
 * keeps the order.
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
      return {
        processed: 0,
        stoppedAtPending: false,
        stoppedAtExecuting: false,
        skippedInFlight: true,
      };
    }
    this.inFlight.add(key);

    try {
      let processed = 0;

      for (;;) {
        // Re-read every round (R-50): the queue as the database has it now.
        const queue = await this.deps.withTransaction(workspaceId, principalId, (client) =>
          listExecutableQueue(client, workspaceId, gatekeeperId),
        );
        const row = planGatekeeperQueue(queue).next;
        if (!row) {
          return {
            processed,
            stoppedAtPending: queue.some((queued) => queued.status === 'pending_approval'),
            stoppedAtExecuting: queue.some((queued) => queued.status === 'executing'),
            skippedInFlight: false,
          };
        }

        // Legacy 330: the row can move between the read above and this start — withdrawn with
        // its goal step (S11 GO3a), or started by another trigger. `startActionRequestExecution`
        // re-checks the row under its lock and refuses (`IllegalTransition`); read the queue again
        // rather than end the drain, or the rows behind a withdrawn one wait for the next tick
        // whenever the withdrawal's own drain was skipped as in flight. Bounded: every refusal is
        // a row that left the approved statuses for good — terminal, or now `executing`, which the
        // next read plans around.
        let executing: ActionRequestRow;
        try {
          executing = await this.deps.withTransaction(workspaceId, principalId, (client) =>
            startActionRequestExecution(client, workspaceId, row.id),
          );
        } catch (err) {
          if (err instanceof IllegalTransition) continue;
          throw err;
        }

        const result = await this.deps.executor.execute(executing);

        // Outcome unknown (see `ActionExecutorResult.indeterminate`): no terminal transition —
        // the row stays `executing` for the stale-executing reaper to resolve by idempotent
        // replay, and it is a barrier: nothing after it on this Gatekeeper that conflicts with it
        // runs first (R-50, I-Q1). The next read plans around it — rows on other instances go on.
        if (!result.ok && result.indeterminate === true) {
          await this.deps.withTransaction(workspaceId, principalId, (client) =>
            recordActionRequestInDoubt(client, workspaceId, row.id, { reason: result.reason }),
          );
          processed += 1;
          continue;
        }

        await this.deps.withTransaction(workspaceId, principalId, (client) =>
          result.ok
            ? markActionRequestExecuted(client, workspaceId, row.id, {
                resultMetadata: result.resultMetadata,
              })
            : markActionRequestFailed(client, workspaceId, row.id, {
                failureKind: result.failureKind,
                reason: result.reason,
              }),
        );

        processed += 1;
      }
    } finally {
      this.inFlight.delete(key);
    }
  }
}
