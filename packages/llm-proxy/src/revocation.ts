/**
 * revocation: periodic sync of revoked Handle `jti`s from `GET
 * ${KERNEL_URL}/internal/handle-revocations?since=<iso>` into an in-memory `Set` (design doc §7.7
 * "撤销表按 jti 周期同步不逐请求回调" — no per-request callback to the kernel; docs/development-
 * tasks.md S1.7). `handle-auth.ts` consults `isRevoked(jti)` on every request; nothing here ever
 * touches Postgres directly — only the kernel's own `/internal/handle-revocations` route does
 * (packages/kernel/src/interfaces/http/internal/handle-revocations.ts).
 *
 * Fail-open on a sync failure (S1.7 acceptance: "杀掉内核后代理仍能转发" — the proxy must keep
 * forwarding while the kernel is down): a failed poll logs a warning and leaves the revoked set
 * exactly as it was, then retries on the next tick. This means a *brand-new* revocation issued
 * while the kernel is unreachable won't take effect at this proxy until sync resumes — an
 * accepted eventual-consistency window, same as the design's own periodic-sync choice over a
 * per-request callback.
 *
 * Overlap window: each poll's `since` is the *previous successful* poll's server-reported `now`
 * minus `overlapMs` (default 60s), not that `now` itself — `revoked_at = now()` is captured at
 * the moment the kernel's UPDATE statement runs, inside a transaction that might not have
 * committed yet when an earlier poll observed the kernel's clock; requesting a small overlap
 * catches a revocation whose commit landed just after the previous poll's snapshot. Re-adding an
 * already-known `jti` to the `Set` on overlap is harmless (set semantics).
 */

export interface RevokedHandleRow {
  readonly jti: string;
  readonly revokedAt: string;
}

interface HandleRevocationsResponse {
  readonly revoked: readonly RevokedHandleRow[];
  readonly now: string;
}

export interface RevocationSyncOptions {
  /** Base URL for `GET ${kernelUrl}/internal/handle-revocations`. When unset, sync is a no-op —
   *  `isRevoked` always reports `false` (the local EdDSA signature/expiry check in handle-auth.ts
   *  is still enforced regardless; this only disables the *revocation* half). */
  readonly kernelUrl: string | undefined;
  readonly intervalMs: number;
  readonly overlapMs: number;
  readonly fetchImpl?: typeof fetch;
  /** Defaults to `console.log`; overridable for tests. */
  readonly log?: (line: string) => void;
}

export interface RevocationSync {
  isRevoked(jti: string): boolean;
  /** Runs one sync attempt immediately and awaits it — what the periodic timer calls internally,
   *  and what tests call directly instead of waiting on real timers. */
  forceSync(): Promise<void>;
  close(): void;
}

/** Starts the periodic sync (first attempt fires immediately, not after the first `intervalMs`
 *  wait) and returns the handle. Never throws — a `kernelUrl`-less config or an unreachable
 *  kernel both degrade to "nothing known revoked yet", not a startup failure. */
export function startRevocationSync(options: RevocationSyncOptions): RevocationSync {
  const revoked = new Set<string>();
  let lastSyncAt: Date | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchImpl = options.fetchImpl ?? fetch;

  async function sync(): Promise<void> {
    if (!options.kernelUrl) return;

    const since = lastSyncAt ? new Date(lastSyncAt.getTime() - options.overlapMs) : new Date(0);

    try {
      const url = new URL('/internal/handle-revocations', options.kernelUrl);
      url.searchParams.set('since', since.toISOString());
      const res = await fetchImpl(url.toString());
      if (!res.ok) throw new Error(`kernel responded ${res.status}`);
      const body = (await res.json()) as HandleRevocationsResponse;
      for (const row of body.revoked) revoked.add(row.jti);
      lastSyncAt = new Date(body.now);
    } catch (err) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: handle-revocation sync failed, keeping the last known revoked set',
          error: String(err),
        }),
      );
    }
  }

  function scheduleNext(delayMs: number): void {
    if (closed) return;
    timer = setTimeout(() => {
      void sync().finally(() => scheduleNext(options.intervalMs));
    }, delayMs);
    timer.unref?.();
  }

  scheduleNext(0);

  return {
    isRevoked: (jti: string): boolean => revoked.has(jti),
    forceSync: sync,
    close: (): void => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
