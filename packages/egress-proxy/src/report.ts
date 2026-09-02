/**
 * Egress observation reporting (design doc §7.9, §5.4 I10, §7.10 `EgressObserved`).
 *
 * The wire shape below is deliberately *not* `@nexttime/shared`'s `EgressObserved` domain
 * event: this proxy only ever knows a request's `sourceId` (resolved from `SOURCE_MAP_FILE`, or
 * a future supervisor registry — design doc §7.9 "来源 ip → WorkerRun / 入口会话由 supervisor
 * 注册表解析") — never the `workspaceId` / `activityId` that event carries. Turning a `sourceId`
 * into a WorkerRun/entry-session Activity is the kernel host-bridge's job (S1.5), not this
 * proxy's, so `EgressObservation` is shaped like that event (same `type: 'EgressObserved'`
 * discriminator, a `domain` field, byte accounting) but keyed by `sourceId` — the kernel is
 * expected to lift this into the real domain event once it resolves that id.
 *
 * What *is* imported from `@nexttime/shared` is the `type` discriminator itself
 * (`PlatformEvent`'s `'EgressObserved'` member): pinning it to the canonical event vocabulary
 * means this local wire shape cannot silently drift from the domain event name it is later
 * lifted into, without pretending the rest of the shape is identical.
 */

import type { PlatformEvent } from '@nexttime/shared';

export interface EgressObservation {
  type: Extract<PlatformEvent, { type: 'EgressObserved' }>['type'];
  sourceId: string;
  clientIp: string;
  domain: string;
  port: number;
  protocol: 'http' | 'connect';
  allowed: boolean;
  reason?: string;
  bytesUp: number;
  bytesDown: number;
  observedAt: string;
}

export interface EgressReporterOptions {
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
 * Records every egress decision as a stdout JSON line (always, synchronously) and, when
 * `kernelUrl` is configured, best-effort batches it to `POST ${kernelUrl}/internal/egress`. Never
 * blocks the caller: `record()` only enqueues; delivery happens on a timer. A failed flush
 * requeues its batch (bounded) and backs off exponentially, resetting on the next success.
 */
export class EgressReporter {
  private queue: EgressObservation[] = [];
  private readonly kernelUrl: string | undefined;
  private readonly maxQueueSize: number;
  private readonly baseFlushIntervalMs: number;
  private readonly maxFlushIntervalMs: number;
  private currentFlushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  constructor(options: EgressReporterOptions = {}) {
    this.kernelUrl = options.kernelUrl;
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.baseFlushIntervalMs = options.flushIntervalMs ?? 2000;
    this.maxFlushIntervalMs = options.maxFlushIntervalMs ?? 60_000;
    this.currentFlushIntervalMs = this.baseFlushIntervalMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
  }

  record(observation: EgressObservation): void {
    this.log(JSON.stringify(observation));
    if (!this.kernelUrl) return;
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push(observation);
    this.scheduleFlush(this.currentFlushIntervalMs);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || !this.kernelUrl) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      const res = await this.fetchImpl(`${this.kernelUrl}/internal/egress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ observations: batch }),
      });
      if (!res.ok) throw new Error(`kernel responded ${res.status}`);
      this.currentFlushIntervalMs = this.baseFlushIntervalMs;
    } catch (err) {
      this.log(
        JSON.stringify({
          level: 'warn',
          msg: 'egress-proxy: failed to report observations to kernel, will retry',
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
