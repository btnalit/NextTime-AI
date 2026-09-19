import { KernelClientError } from './kernel-client.js';

/**
 * failure-streak: the interval loop's consecutive-failure bookkeeping (S6, docs/STATUS.md
 * leftover 41 後半 — "采集器连续 N 轮 401 / 非零错误要可见"). The loop in `index.ts` deliberately
 * survives a single failed cycle (a transient Docker / kernel-network hiccup must not kill a
 * long-running collector), which is exactly what let a collector 401 against a disabled
 * acceptance workspace for a week while its log showed one "collection cycle failed" line every
 * 15 minutes, indistinguishable from a hiccup. Every failed cycle's log line now carries the
 * streak length and, for a kernel refusal, the HTTP status and error code; when the streak
 * reaches `HOST_INVENTORY_FAILURE_STREAK_ALERT` (default 3) the line is logged at `error` with
 * `message: 'collector failing repeatedly'` — the single string an operator greps for or alerts on
 * in `docker compose logs collector-host-inventory`. The kernel-side twin is the
 * `ops.collector_silent` check in `/internal/metrics` (a Source the kernel stopped hearing from).
 *
 * Pure: no IO, no timers — `index.ts` owns the loop, this owns the arithmetic and the log shape.
 */

export const DEFAULT_FAILURE_STREAK_ALERT = 3;

export interface FailureStreakState {
  /** Consecutive failed cycles ending at the most recent one; 0 after a success. */
  readonly consecutiveFailures: number;
}

export const INITIAL_FAILURE_STREAK: FailureStreakState = { consecutiveFailures: 0 };

export function recordSuccess(_state: FailureStreakState): FailureStreakState {
  return INITIAL_FAILURE_STREAK;
}

export function recordFailure(state: FailureStreakState): FailureStreakState {
  return { consecutiveFailures: state.consecutiveFailures + 1 };
}

export interface FailureLogLine {
  readonly level: 'warn' | 'error';
  readonly message: 'collection cycle failed' | 'collector failing repeatedly';
  readonly error: string;
  readonly consecutiveFailures: number;
  /** The kernel's HTTP status / error code when the failure was a refused kernel call (a 401
   *  `unauthorized` is the leftover-41 signature); absent for any other failure. */
  readonly kernelStatus?: number;
  readonly kernelErrorCode?: string;
}

/** The structured line for one failed cycle, given the streak *after* recording it. */
export function describeFailure(
  err: unknown,
  state: FailureStreakState,
  alertAt: number = DEFAULT_FAILURE_STREAK_ALERT,
): FailureLogLine {
  const repeated = state.consecutiveFailures >= alertAt;
  const kernel =
    err instanceof KernelClientError ? { kernelStatus: err.status, kernelErrorCode: err.code } : {};
  return {
    level: repeated ? 'error' : 'warn',
    message: repeated ? 'collector failing repeatedly' : 'collection cycle failed',
    error: err instanceof Error ? err.message : String(err),
    consecutiveFailures: state.consecutiveFailures,
    ...kernel,
  };
}

/** `HOST_INVENTORY_FAILURE_STREAK_ALERT`: unset → the default; anything else must be a positive
 *  integer (fail fast at startup, the `config.ts` convention). */
export function parseFailureStreakAlert(raw: string | undefined): number {
  if (!raw) return DEFAULT_FAILURE_STREAK_ALERT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    throw new Error(`HOST_INVENTORY_FAILURE_STREAK_ALERT must be a positive integer, got "${raw}"`);
  }
  return parsed;
}
