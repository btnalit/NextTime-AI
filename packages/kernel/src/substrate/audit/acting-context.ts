import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActingThrough } from '@nexttime/shared';

/**
 * substrate/audit/acting-context: what the audit rows written right now act through (batch D3,
 * docs/test-coverage-gaps-2026-11-06.md G11; migration core 0054 `audit_records.acting_through` /
 * `acting_session_id`; `@nexttime/shared` `AUDIT_ACTING_THROUGH_VALUES` has what each value means).
 *
 * One `AsyncLocalStorage`, like substrate/correlation's, read by `writeAudit` (writer.ts) for every
 * row — `AuditRecordInput` has no field for either column, so no handler can choose them. Set in
 * exactly three places:
 *
 *   - `dispatchCapability` (application/gateway/dispatch.ts), derived from the call's caller and,
 *     for a Handle, from the kind of the session it was issued under, around the whole call: every
 *     row the call writes — its own, its handler's, an `afterCommit`'s, a refusal's in its own
 *     transaction — carries the same values;
 *   - the composition root's background services (`createBackgroundServices().start()`, index.ts),
 *     `system` for every scheduled loop started there;
 *   - `ApprovalDrainer.drainGatekeeper` (governance/approval/drainer.ts), `system` for a drain a
 *     call started: the queue it drains holds other callers' requests too.
 *
 * {@link runWithActingContext} closes the context when the call it wraps settles. Work the call
 * left running behind it (a promise nobody awaited, a timer it set) inherits the store but finds it
 * closed, and its rows carry neither column: they were written after the call ended, so nothing
 * says the call's caller did them. Outside both places (sign-in and identity routes, the llm-proxy's
 * administrator reports, the operator CLI) there is no context and both columns stay `null`.
 *
 * "Only those three places" is held by `acting-context.test.ts`, which fails when any other
 * non-test kernel file names {@link runWithActingContext} or {@link runWithStandingActingContext}.
 */

export interface ActingContext {
  readonly actingThrough: AuditActingThrough;
  /** Only with an `actingThrough` a Handle is issued under (`AUDIT_ACTING_THROUGH_WITH_SESSION_VALUES`,
   *  CHECK `audit_records_acting_session_shape`). */
  readonly actingSessionId?: string;
}

/** The kernel's own work: background loops, and a drain whoever started it. */
export const SYSTEM_ACTING_CONTEXT: ActingContext = { actingThrough: 'system' };

/** The store: mutable on purpose. `actingThrough` is filled in once the caller is known (a Handle
 *  call reads its session's kind inside its own transaction, before anything is written), and
 *  `open` turns false when the wrapped call settles. */
interface ActingContextCell {
  value: ActingContext | undefined;
  open: boolean;
}

const storage = new AsyncLocalStorage<ActingContextCell>();

/** A handle on the context {@link runWithActingContext} opened, for the one caller that learns the
 *  values only part-way through (dispatch, from the Handle's session kind). */
export interface ActingContextHandle {
  /** Sets (or replaces) what rows written from now on in this call act through. */
  set(value: ActingContext | undefined): void;
}

/**
 * Runs `fn` with a fresh acting context — `initial`, which `fn` may refine through the handle it
 * receives — and closes that context when `fn` settles, whatever the outcome. A nested call opens
 * its own context and the outer one is back in force when it returns.
 */
export async function runWithActingContext<T>(
  initial: ActingContext | undefined,
  fn: (context: ActingContextHandle) => Promise<T>,
): Promise<T> {
  const cell: ActingContextCell = { value: initial, open: true };
  const handle: ActingContextHandle = {
    set(value) {
      cell.value = value;
    },
  };
  try {
    return await storage.run(cell, () => fn(handle));
  } finally {
    cell.open = false;
  }
}

/**
 * Runs `fn` with a context that never closes — for long-lived work that starts timers and keeps
 * writing for as long as the process runs (the background services' scheduled loops).
 */
export function runWithStandingActingContext<T>(value: ActingContext, fn: () => T): T {
  return storage.run({ value, open: true }, fn);
}

/** What a row written now acts through: `undefined` outside every context and after the call that
 *  opened the current one has settled. */
export function currentActingContext(): ActingContext | undefined {
  const cell = storage.getStore();
  if (cell === undefined || !cell.open) return undefined;
  return cell.value;
}
