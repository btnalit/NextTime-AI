/**
 * budget-sync: the S6-B / leftover-19 half of I18 (design doc §5.4 I18: "到 100% 时 llm-proxy
 * 返回预算耗尽错误"; docs/STATUS.md §4 row 19). Periodically pulls the set of workspaces whose
 * daily budget the kernel has found exhausted from `GET ${KERNEL_URL}/internal/llm-budget-
 * exhausted` (packages/kernel/src/interfaces/http/internal/llm-budget.ts) into memory; proxy.ts
 * consults `isExhausted(workspaceId)` after Handle verification and answers 402
 * `budget_exhausted` instead of forwarding. Same shape as revocation.ts (no per-request kernel
 * callback; fail-open on a failed poll), with two deliberate differences:
 *
 *   - **Replace, not accumulate.** The kernel returns the *complete* current set on every poll
 *     (it is small: one row per workspace with a configured budget that is over it today), so a
 *     successful poll replaces the whole map — a workspace whose budget was raised, or whose
 *     day rolled over, is released on the next poll with no tombstone bookkeeping.
 *   - **Self-expiring rows.** Every row carries `until` (the kernel's next UTC-midnight, its own
 *     clock). If the kernel becomes unreachable, the last known set is kept (fail-open on the
 *     *sync*, like revocations) but a row past its `until` stops being enforced — so a kernel
 *     outage spanning midnight can never keep a workspace blocked into the next day.
 *
 * Why this is a signal and not the enforcement of record: the kernel's own post-hoc stop
 * (`application/task/service.ts` `recordWorkerRunUsage` — Task `failed: budget_exhausted` +
 * child Handle revoked, which this proxy already honours through revocation.ts as a 401) stays
 * the backstop. This poll only closes the window the leftover names — a workspace past its daily
 * cost budget kept getting completions until something *else* stopped it. Enforcement lag is at
 * most one usage flush (report.ts, ~2 s) plus one poll interval.
 */

export type BudgetScope = 'workspace_daily_cost' | 'workspace_daily_tokens';

export interface ExhaustedBudgetRow {
  readonly workspaceId: string;
  readonly scope: BudgetScope;
  /** The configured ceiling and today's spend, in the scope's own unit (USD or tokens) — echoed
   *  into the 402 body so the extension can surface a concrete message. */
  readonly budget: number;
  readonly spent: number;
  /** ISO instant after which this row must no longer be enforced (the kernel's next UTC
   *  midnight). */
  readonly until: string;
}

interface BudgetExhaustedResponse {
  readonly exhausted: readonly ExhaustedBudgetRow[];
  readonly now: string;
}

export interface BudgetSyncOptions {
  /** Base URL for `GET ${kernelUrl}/internal/llm-budget-exhausted`. When unset, sync is a no-op
   *  and `isExhausted` always reports `undefined`. */
  readonly kernelUrl: string | undefined;
  /** `Authorization` header value (`@nexttime/shared`'s `internalAuthorizationHeader(token)`) —
   *  index.ts supplies it whenever `kernelUrl` is set. */
  readonly authorizationHeader?: string;
  readonly intervalMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Injected clock for the `until` expiry check (tests). */
  readonly now?: () => number;
}

export interface BudgetSync {
  isExhausted(workspaceId: string): ExhaustedBudgetRow | undefined;
  /** Runs one sync attempt immediately and awaits it — what the timer calls, and what tests call
   *  instead of waiting on real timers. */
  forceSync(): Promise<void>;
  close(): void;
}

export function startBudgetSync(options: BudgetSyncOptions): BudgetSync {
  let exhausted = new Map<string, ExhaustedBudgetRow>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const log = options.log ?? ((line: string) => console.log(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  async function sync(): Promise<void> {
    if (!options.kernelUrl) return;
    try {
      const url = new URL('/internal/llm-budget-exhausted', options.kernelUrl);
      const res = await fetchImpl(url.toString(), {
        headers: options.authorizationHeader
          ? { authorization: options.authorizationHeader }
          : undefined,
      });
      if (!res.ok) throw new Error(`kernel responded ${res.status}`);
      const body = (await res.json()) as BudgetExhaustedResponse;
      const next = new Map<string, ExhaustedBudgetRow>();
      for (const row of body.exhausted) {
        // First row per workspace wins — the kernel lists the cost axis before the token axis, and
        // one 402 with one reason is all the caller needs.
        if (!next.has(row.workspaceId)) next.set(row.workspaceId, row);
      }
      const newlyBlocked = [...next.keys()].filter((id) => !exhausted.has(id));
      const released = [...exhausted.keys()].filter((id) => !next.has(id));
      exhausted = next;
      if (newlyBlocked.length > 0 || released.length > 0) {
        log(
          JSON.stringify({
            level: 'info',
            msg: 'llm-proxy: budget-exhausted set changed',
            blocked: newlyBlocked,
            released,
            total: exhausted.size,
          }),
        );
      }
    } catch (err) {
      log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: budget sync failed, keeping the last known exhausted set',
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
    isExhausted: (workspaceId: string): ExhaustedBudgetRow | undefined => {
      const row = exhausted.get(workspaceId);
      if (!row) return undefined;
      if (Date.parse(row.until) <= now()) return undefined;
      return row;
    },
    forceSync: sync,
    close: (): void => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
