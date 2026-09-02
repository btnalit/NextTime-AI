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
}

export interface LlmUsageReporterOptions {
  /** `KERNEL_URL`; when unset the reporter only logs to stdout and never queues/POSTs. */
  kernelUrl?: string;
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
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.baseFlushIntervalMs = options.flushIntervalMs ?? 2000;
    this.maxFlushIntervalMs = options.maxFlushIntervalMs ?? 60_000;
    this.currentFlushIntervalMs = this.baseFlushIntervalMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
  }

  record(record: LlmUsageRecord): void {
    this.log(JSON.stringify(record));
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
    try {
      const res = await this.fetchImpl(`${this.kernelUrl}/internal/llm-usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`kernel responded ${res.status}`);
      this.currentFlushIntervalMs = this.baseFlushIntervalMs;
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'llm-proxy: failed to report usage to kernel, will retry',
          error: String(err),
        }),
      );
      const requeued = [...batch, ...this.queue];
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

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
