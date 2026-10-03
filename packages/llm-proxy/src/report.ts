/**
 * report: usage reporting to the kernel (design doc §7.7, §13 "用量上报有 outbox 式重放";
 * docs/development-tasks.md S1.7 "失败本地队列重放"). Mirrors `packages/egress-proxy/src/
 * report.ts`'s `EgressReporter` pattern exactly (bounded in-memory queue, batched flush,
 * exponential backoff resetting on success) — the two proxies share the same "must keep working
 * while the kernel is down, then catch up" requirement (design doc §13's fault-recovery table
 * lists both under the same row).
 *
 * Wire body: a bare JSON array of `LlmUsageRecord` (S1.7 task brief: "JSON array of records,
 * batched" — not wrapped in an envelope object, unlike egress's `{observations: [...]}`). Field
 * names are camelCase, matching this codebase's established wire-schema convention
 * (packages/shared/src/events.ts; the kernel's own `governance/llm-usage/service.ts`
 * `LlmUsageRecordSchema`, which this shape must match field-for-field) — see that kernel file's
 * doc comment for why the task prose's snake_case naming is read as describing DB columns, not
 * a wire-format mandate.
 *
 * Settling a batch (R-68): the kernel answers per workspace group (`LlmUsageGroupResult`). Only
 * `retry` groups go back on the queue; a group the kernel refused for good (its workspace,
 * session or Handle no longer exists) is dropped with a warn line. A response without per-group
 * results (an older kernel, a network error, any other failure) requeues the whole batch, as
 * before — safe, because every record carries its `requestId` and the kernel skips a replay.
 */

export interface LlmUsageRecord {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** `'completed'` or `'error'` — see index.ts's call sites for exactly when each is used. */
  readonly status: string;
  /** R-67: a UUID minted for the one upstream request this record meters (proxy.ts), resent
   *  unchanged on every retry — the kernel's dedupe key, so concurrent requests under one Handle
   *  that start in the same millisecond stay separate records. */
  readonly requestId: string;
}

/**
 * One workspace group's outcome in the kernel's `/internal/llm-usage` response (R-68) — mirrors
 * the kernel's `LlmUsageGroupResult` (interfaces/http/internal/llm-usage.ts). Only `retry` is
 * requeued; `recorded` (with any `rejected` records) and `rejected` are done.
 */
export type LlmUsageGroupResult =
  | { readonly workspaceId: string; readonly outcome: 'recorded'; readonly rejected?: number }
  | { readonly workspaceId: string; readonly outcome: 'rejected'; readonly reason?: string }
  | { readonly workspaceId: string; readonly outcome: 'retry' };

/** The per-group outcomes in a kernel response body — `result.groups` on a 200,
 *  `error.details.groups` on a 500 — or `undefined` when the body carries none (a kernel that
 *  predates R-68, a non-JSON body, any other error). */
async function readGroupResults(res: Response): Promise<LlmUsageGroupResult[] | undefined> {
  if (typeof res.json !== 'function') return undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  const container = body as {
    result?: { groups?: unknown };
    error?: { details?: { groups?: unknown } };
  } | null;
  const groups = container?.result?.groups ?? container?.error?.details?.groups;
  if (!Array.isArray(groups)) return undefined;
  return groups.filter(
    (group): group is LlmUsageGroupResult =>
      typeof group === 'object' &&
      group !== null &&
      typeof (group as { workspaceId?: unknown }).workspaceId === 'string' &&
      ['recorded', 'rejected', 'retry'].includes(
        (group as { outcome?: unknown }).outcome as string,
      ),
  );
}

/** Per-record context that is logged but never sent to the kernel (leftover 87). */
export interface LlmUsageRecordContext {
  /** The request's correlation id — in the usage log line only; `/internal/llm-usage`'s wire
   *  shape is unchanged. */
  readonly correlationId?: string;
}

export interface LlmUsageReporterOptions {
  /** `KERNEL_URL`; when unset the reporter only logs to stdout and never queues/POSTs. */
  kernelUrl?: string;
  /** `Authorization` header value sent on every flush POST (`@nexttime/shared`'s
   *  `internalAuthorizationHeader(token)`, i.e. `Bearer <token>`) — `index.ts` supplies this
   *  whenever `kernelUrl` is set (fix/internal-plane-auth, 2026-09: the kernel's `/internal/*`
   *  routes 401 without it). Omitted only in tests that talk to an unguarded fake kernel. */
  authorizationHeader?: string;
  /** Bounded in-memory queue size — oldest entries are dropped once full. Default 1000. */
  maxQueueSize?: number;
  /** Delay before a batch flush attempt. Default 2000ms. */
  flushIntervalMs?: number;
  /** Cap for the backoff a failed flush grows the delay to. Default 60000ms. */
  maxFlushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Defaults to `console.log`; overridable for tests. */
  log?: (line: string) => void;
}

/**
 * Records every usage record as a stdout JSON line (always, synchronously) and, when `kernelUrl`
 * is configured, best-effort batches it to `POST ${kernelUrl}/internal/llm-usage`. Never blocks
 * the caller: `record()` only enqueues; delivery happens on a timer. A failed flush requeues its
 * batch (bounded) and backs off exponentially, resetting on the next success — this is what keeps
 * the proxy forwarding requests while the kernel is down and lets it catch up once the kernel is
 * back (S1.7 acceptance).
 */
export class LlmUsageReporter {
  private queue: LlmUsageRecord[] = [];
  private readonly kernelUrl: string | undefined;
  private readonly authorizationHeader: string | undefined;
  private readonly maxQueueSize: number;
  private readonly baseFlushIntervalMs: number;
  private readonly maxFlushIntervalMs: number;
  private currentFlushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(options: LlmUsageReporterOptions = {}) {
    this.kernelUrl = options.kernelUrl;
    this.authorizationHeader = options.authorizationHeader;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.baseFlushIntervalMs = options.flushIntervalMs ?? 2000;
    this.maxFlushIntervalMs = options.maxFlushIntervalMs ?? 60_000;
    this.currentFlushIntervalMs = this.baseFlushIntervalMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
  }

  record(record: LlmUsageRecord, context: LlmUsageRecordContext = {}): void {
    this.log(
      JSON.stringify(
        context.correlationId !== undefined
          ? { ...record, correlationId: context.correlationId }
          : record,
      ),
    );
    if (!this.kernelUrl) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push(record);
    this.scheduleFlush(this.currentFlushIntervalMs);
  }

  /** Queued-but-not-yet-flushed record count. Test/observability hook. */
  get pending(): number {
    return this.queue.length;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Attempts one flush immediately, awaiting it — for tests, in place of waiting on the real
   *  timer. Also what the internal timer calls. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || !this.kernelUrl) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    // What goes back on the queue when this attempt does not settle it: the whole batch, unless
    // the kernel answers per workspace group (R-68).
    let unsettled: readonly LlmUsageRecord[] = batch;
    try {
      const res = await this.fetchImpl(`${this.kernelUrl}/internal/llm-usage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authorizationHeader ? { authorization: this.authorizationHeader } : {}),
        },
        body: JSON.stringify(batch),
      });
      const groups = await readGroupResults(res);
      if (groups) this.logRejected(groups, batch);
      if (res.ok) {
        unsettled = [];
      } else if (groups) {
        // Requeue only the groups the kernel could not record. One poisoned workspace no longer
        // holds every other workspace's usage hostage, and a workspace missing from the answer
        // is retried rather than assumed recorded.
        const settled = new Set(
          groups.filter((group) => group.outcome !== 'retry').map((group) => group.workspaceId),
        );
        unsettled = batch.filter((record) => !settled.has(record.workspaceId));
      }
      if (unsettled.length === 0) {
        this.currentFlushIntervalMs = this.baseFlushIntervalMs;
        return;
      }
      throw new Error(`kernel responded ${res.status}`);
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: failed to report usage to kernel, will retry',
          error: String(err),
          retrying: unsettled.length,
        }),
      );
      const requeued = [...unsettled, ...this.queue];
      this.queue = requeued.slice(Math.max(0, requeued.length - this.maxQueueSize));
      this.currentFlushIntervalMs = Math.min(
        this.currentFlushIntervalMs * 2,
        this.maxFlushIntervalMs,
      );
      this.scheduleFlush(this.currentFlushIntervalMs);
    } finally {
      this.flushing = false;
    }
  }

  /** One warn line per workspace whose usage the kernel refused for good — the workspace (or the
   *  session / Handle a record names) no longer exists. Those records are dropped, not retried. */
  private logRejected(
    groups: readonly LlmUsageGroupResult[],
    batch: readonly LlmUsageRecord[],
  ): void {
    for (const group of groups) {
      const dropped =
        group.outcome === 'rejected'
          ? batch.filter((record) => record.workspaceId === group.workspaceId).length
          : group.outcome === 'recorded'
            ? (group.rejected ?? 0)
            : 0;
      if (dropped === 0) continue;
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: kernel rejected usage whose workspace, session or Handle no longer exists; dropped',
          workspaceId: group.workspaceId,
          dropped,
        }),
      );
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
