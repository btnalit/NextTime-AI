import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/await-decision: the `await_decision=true` "wait until timeout" mode (design
 * doc §5.5, §8.2; docs/development-tasks.md S2.3 acceptance "`await_decision=true` 时 Task 进
 * `waiting_approval` 且超时后工具得到 `pending_approval`").
 *
 * Decoupled from the DB/pool entirely: `awaitActionRequestResolution` takes a caller-supplied
 * `read` (poll one ActionRequest) and an injectable clock/sleep, so it is unit-testable with no
 * Postgres and no real timers. The real wiring —
 * `read = () => withWorkspace(pool, {workspaceId, principalId}, (client) =>
 * getActionRequest(client, workspaceId, actionRequestId))`, and updating a Task's own status to
 * `waiting_approval` around the wait — is S2.7's job (`invoke_worker`'s tool-call wait): this
 * module cannot do that itself (`application/task` does not exist yet, and governance may not
 * depend on the application layer either way, §7.10). What this module *does* guarantee, and what
 * S2.3's own acceptance criterion actually tests, is the timeout-vs-resolution race: given a
 * `read` callback, resolve as soon as the row leaves `pending_approval`, or after `timeoutMs`
 * elapses — still `pending_approval` — whichever comes first.
 */

export interface AwaitActionRequestResolutionOptions {
  readonly timeoutMs: number;
  /** Default 200ms — mirrors `application/outbox/dispatcher.ts`'s own default poll interval. */
  readonly pollIntervalMs?: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable sleep, for deterministic tests. Defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `read()` until it returns a row whose `status` is no longer `pending_approval`, or until
 * `options.timeoutMs` elapses — whichever happens first. Returns the last-read row (still
 * `pending_approval` on a timeout) or `null` if `read()` ever reports the row does not exist
 * (deleted/never existed — this module never deletes ActionRequest rows itself, but `read` is
 * caller-supplied and might reflect a different reality in a test double).
 */
export async function awaitActionRequestResolution(
  read: () => Promise<ActionRequestRow | null>,
  options: AwaitActionRequestResolutionOptions,
): Promise<ActionRequestRow | null> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const row = await read();
    if (!row || row.status !== 'pending_approval') return row;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return row;

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}
