import { IllegalTransition } from '@nexttime/shared';
import type { ApprovalDrainer } from '../../governance/approval/index.js';
import { getActionRequest } from '../../governance/approval/index.js';
import { SYSTEM_ACTOR_PLACEHOLDER } from '../../governance/gatekeepers/index.js';
import type { DomainEvent } from '../../substrate/outbox/index.js';
import type { WithTransactionFn } from './action-executor.js';

/**
 * application/gateway/action-request-drain-consumer: triggers `ApprovalDrainer.drainGatekeeper`
 * whenever an ActionRequest becomes executable — `ActionRequestUpdated{status:'approved'}` (a
 * human just approved a `pending_approval` row) or `{status:'auto_approved'}` (belt-and-suspenders
 * for an `auto_approved` row nobody is synchronously waiting on — e.g. an `await_decision:false`
 * `request_action` call) — design doc §7.10 "领域事件与 outbox"; docs/development-tasks.md S2.4
 * "drain the Gatekeeper's queue after every successful approve ... prefer the outbox consumer, it
 * survives crashes".
 *
 * `ActionRequestUpdatedEvent` (packages/shared/src/events.ts) carries no `gatekeeperId` — only
 * `approval/routing.ts`'s `ActionRequestPendingEvent` does — so this consumer reads it back via an
 * admin-mode (RLS-bypassing) transaction before draining; see `packages/kernel/src/index.ts`'s own
 * doc comment on why the drainer/executor wiring is admin-mode throughout (a background process,
 * not a per-request one — the same category as the outbox dispatcher itself and the S2.3 approval-
 * expiry reaper).
 *
 * Harmless races with `request_action`'s own phase-2 execution (`request-action-handler.ts`'s
 * `tryExecuteInline`) are expected and tolerated: `startActionRequestExecution`'s row
 * locking + conditional UPDATE serializes correctly regardless of which caller wins, so a race
 * loss here surfaces as an `IllegalTransition` from deep inside `drainGatekeeper` — swallowed
 * (not passed to `onError`) since it means "already handled", not a real failure. Any *other*
 * error (a genuine DB/gate fault) is still passed to `onError` (design doc §13 "outbox 派发器崩溃
 * ... 消费者幂等" — a real failure is retried on the next `ActionRequestUpdated`/periodic tick,
 * never silently dropped).
 *
 * The drain itself runs in the background (R-52, 2026-10-02 review): the consumer only reads the
 * row's Gatekeeper and *starts* the drain, then returns. The outbox dispatcher is one serial loop
 * that delivers each row inside an open transaction, so awaiting the drain here — a gate `apply`
 * can take up to its 60 s budget per queued row — held that transaction open and stalled delivery
 * of every other event platform-wide (a `container.restart` blocking `TurnStarted` in every
 * workspace). A crash mid-drain loses nothing: the row stays `approved`/`auto_approved` (or
 * `executing`, for the stale-executing reaper) and the periodic drain tick picks it up. The
 * drain's own failures reach `onError` exactly as before.
 */

type ActionRequestUpdatedEvent = Extract<DomainEvent, { type: 'ActionRequestUpdated' }>;

export interface ActionRequestUpdatedSource {
  subscribe(
    eventType: 'ActionRequestUpdated',
    consumer: (event: ActionRequestUpdatedEvent) => Promise<void> | void,
  ): () => void;
}

const DRAINABLE_STATUSES = new Set(['auto_approved', 'approved']);

export function registerActionRequestDrainConsumer(
  dispatcher: ActionRequestUpdatedSource,
  drainer: ApprovalDrainer,
  withTransaction: WithTransactionFn,
  onError: (error: unknown) => void = () => {},
): () => void {
  return dispatcher.subscribe('ActionRequestUpdated', async (event) => {
    if (!DRAINABLE_STATUSES.has(event.status)) return;
    try {
      const actionRequest = await withTransaction(
        event.workspaceId,
        SYSTEM_ACTOR_PLACEHOLDER,
        (client) => getActionRequest(client, event.workspaceId, event.actionRequestId),
      );
      if (!actionRequest) return;
      // Started, not awaited (R-52 — see this file's doc comment); its outcome goes to `onError`.
      drainer
        .drainGatekeeper(event.workspaceId, SYSTEM_ACTOR_PLACEHOLDER, actionRequest.gatekeeperId)
        .catch(reportDrainError);
    } catch (err) {
      reportDrainError(err);
    }
  });

  function reportDrainError(err: unknown): void {
    if (err instanceof IllegalTransition) return; // lost a benign race — see this file's doc.
    onError(err);
  }
}
