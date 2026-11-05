import {
  INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  INVOKE_WORKER_SPAWN_BUDGET_SECONDS,
} from '@nexttime/shared';

/** Extra headroom (ms) layered on top of the kernel's own spawn budget and wait window (see
 *  `resolveInvokeWorkerCallPlan` below) for this client's per-call HTTP timeout on an
 *  invoke_worker call — enough slack for the kernel's own database work and response
 *  transit/serialization, without making the client wait meaningfully longer than the kernel
 *  already promises to. */
export const WAIT_TIMEOUT_HEADROOM_MS = 10_000;

export interface InvokeWorkerCallPlan {
  readonly params: unknown;
  /** `KernelClient.call`'s per-call timeout override — set on every invoke_worker call so it
   *  outlasts the kernel's phase 1 plus its `wait:true` window; `undefined` otherwise (the
   *  client's own constructor default applies, same as every other capability). */
  readonly timeoutMs?: number;
}

/**
 * How every mode that registers `invoke_worker` as a tool calls it — entry, interactive and (S11
 * AA5a-1) admin, one rule in one place.
 *
 * Lane-6 review P2-4: `invoke_worker`'s own `wait` param (`@nexttime/shared`'s `capabilities.ts`)
 * asks the kernel to hold the request open until the invoked Worker settles, up to
 * `params.timeout ?? 90` seconds (`INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS`, design doc §8.2
 * "默认 90 秒"). This `KernelClient`'s *default* per-call HTTP timeout is a flat 30s
 * (`DEFAULT_KERNEL_CLIENT_TIMEOUT_MS`, kernel-client.ts) — shorter than the kernel's own wait
 * window — so an unmodified `wait:true` call would always abort client-side before the kernel's
 * wait could ever resolve, and pi's own retry-on-tool-error behavior would then re-issue a
 * *second* `invoke_worker` for a Task that may already be running (duplicate invokes).
 *
 * `wait` *defaults* to `false` (chat is asynchronous — a Task card plus a follow-up turn is the
 * right UX for a blocking tool call, not blocking the whole turn on it; a caller that wants
 * completion status polls `get_task`), but an agent that explicitly asks for `wait:true` gets it,
 * honoured with a per-call `KernelClient` timeout override (`kernel-client.ts`'s `call()`)
 * computed to always outlast the kernel's own wait — rather than being silently downgraded to
 * `wait:false`. Every other capability's params pass through unmodified, no timeout override.
 *
 * 2026-10-02 review R-54: the override also counts the kernel's phase 1 — creating the Task and
 * waiting up to `INVOKE_WORKER_SPAWN_BUDGET_SECONDS` (30s) for worker-supervisor to start the
 * Worker — and applies to `wait:false` too: `30s + (wait ? min(params.timeout ?? 90, 90) : 0) +
 * 10s`. Before, a `wait:false` call used the flat 30s default and a `wait:true` call only the wait
 * window, so a slow spawn made the client give up while the kernel was still starting the Worker,
 * and the model's retry started a second one. (A retry that does happen now collapses onto the
 * running Task — the kernel's derived `idempotencyKey`, `capabilities.ts`.)
 */
export function resolveInvokeWorkerCallPlan(
  capabilityName: string,
  params: unknown,
): InvokeWorkerCallPlan {
  if (capabilityName !== 'invoke_worker') return { params };
  const base = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const spawnBudgetMs = INVOKE_WORKER_SPAWN_BUDGET_SECONDS * 1000;
  if (base.wait !== true) {
    return {
      params: { ...base, wait: false },
      timeoutMs: spawnBudgetMs + WAIT_TIMEOUT_HEADROOM_MS,
    };
  }

  const requestedTimeoutSeconds =
    typeof base.timeout === 'number' ? base.timeout : INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS;
  const clampedTimeoutSeconds = Math.min(
    requestedTimeoutSeconds,
    INVOKE_WORKER_MAX_WAIT_TIMEOUT_SECONDS,
  );
  return {
    params: base,
    timeoutMs: spawnBudgetMs + clampedTimeoutSeconds * 1000 + WAIT_TIMEOUT_HEADROOM_MS,
  };
}
