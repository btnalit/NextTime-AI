import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmUsageRecord } from './report.js';
import { LlmUsageReporter } from './report.js';

function record(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
  return {
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    jti: 'jti-1',
    provider: 'example-provider',
    model: 'example-model',
    inputTokens: 10,
    outputTokens: 5,
    startedAt: new Date(0).toISOString(),
    status: 'completed',
    requestId: 'request-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LlmUsageReporter', () => {
  it('always logs a JSON line to stdout, even without a kernelUrl', () => {
    const lines: string[] = [];
    const reporter = new LlmUsageReporter({ log: (line) => lines.push(line) });
    reporter.record(record());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ provider: 'example-provider' });
    reporter.close();
  });

  // Leftover 87: the correlation id is in the log line only — the kernel wire shape is unchanged.
  it('logs the correlation id with the record but never sends it to the kernel', async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: (line) => lines.push(line),
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record(), { correlationId: 'turn-abcd-0001' });
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ correlationId: 'turn-abcd-0001' });
    await vi.advanceTimersByTimeAsync(100);
    const body = String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body);
    expect(body).not.toContain('correlationId');
    reporter.close();
  });

  it('does not queue or fetch when kernelUrl is unset', async () => {
    const fetchImpl = vi.fn();
    const reporter = new LlmUsageReporter({ log: () => {}, fetchImpl });
    reporter.record(record());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    reporter.close();
  });

  it('batches queued records into one POST of a bare JSON array to /internal/llm-usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record({ model: 'model-a' }));
    reporter.record(record({ model: 'model-b' }));

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://kernel.internal:8080/internal/llm-usage');
    const body = JSON.parse(String(init.body)) as LlmUsageRecord[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r) => r.model)).toEqual(['model-a', 'model-b']);
    reporter.close();
  });

  it('sends the configured Authorization header on the flush POST (fix/internal-plane-auth)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      authorizationHeader: 'Bearer test-token',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record());

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    reporter.close();
  });

  it('omits the Authorization header when none is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record());

    await vi.advanceTimersByTimeAsync(100);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    reporter.close();
  });

  it('never throws or blocks the caller when the POST fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    expect(() => reporter.record(record())).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    reporter.close();
  });

  it('retries a failed batch with backoff and eventually delivers it — the "kernel is down, then up" acceptance case', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record());

    await vi.advanceTimersByTimeAsync(100); // first attempt fails (kernel down)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reporter.pending).toBe(1);

    await vi.advanceTimersByTimeAsync(200); // backoff doubled to 200ms; kernel back up, retry succeeds
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reporter.pending).toBe(0);

    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(secondInit.body)) as LlmUsageRecord[];
    expect(body).toHaveLength(1);
    reporter.close();
  });

  // R-68 (L1-11): the kernel answers per workspace group; one poisoned workspace must not keep
  // every other workspace's usage in the queue.
  it('requeues only the groups the kernel asks to retry, and drops the ones it rejected for good', async () => {
    const lines: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({
          ok: false,
          error: {
            code: 'internal_error',
            message: 'failed to record usage for some workspaces — retry those groups',
            details: {
              groups: [
                { workspaceId: 'ws-recorded', outcome: 'recorded', inserted: 1, rejected: 0 },
                { workspaceId: 'ws-retry', outcome: 'retry' },
                { workspaceId: 'ws-gone', outcome: 'rejected', reason: 'workspace_not_found' },
              ],
            },
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: (line) => lines.push(line),
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record({ workspaceId: 'ws-recorded', requestId: 'r-1' }));
    reporter.record(record({ workspaceId: 'ws-retry', requestId: 'r-2' }));
    reporter.record(record({ workspaceId: 'ws-gone', requestId: 'r-3' }));
    reporter.record(record({ workspaceId: 'ws-gone', requestId: 'r-4' }));
    // In the batch but missing from the kernel's answer: retried, never assumed recorded.
    reporter.record(record({ workspaceId: 'ws-unanswered', requestId: 'r-5' }));

    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reporter.pending).toBe(2);
    const dropped = lines
      .map((line) => JSON.parse(line) as { msg?: string; workspaceId?: string; dropped?: number })
      .filter((line) => line.msg?.includes('rejected usage'));
    expect(dropped).toEqual([expect.objectContaining({ workspaceId: 'ws-gone', dropped: 2 })]);

    await vi.advanceTimersByTimeAsync(200); // backoff doubled; the retry carries only those two
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const retried = JSON.parse(String(retryInit.body)) as LlmUsageRecord[];
    expect(retried.map((r) => r.requestId)).toEqual(['r-2', 'r-5']);
    expect(reporter.pending).toBe(0);
    reporter.close();
  });

  it('settles the whole batch on a 200 and logs records the kernel rejected inside a recorded group', async () => {
    const lines: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          inserted: 1,
          groups: [{ workspaceId: 'ws-1', outcome: 'recorded', inserted: 1, rejected: 1 }],
        },
      }),
    } as unknown as Response);
    const reporter = new LlmUsageReporter({
      log: (line) => lines.push(line),
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record({ requestId: 'r-1' }));
    reporter.record(record({ requestId: 'r-2' }));

    await vi.advanceTimersByTimeAsync(100);
    expect(reporter.pending).toBe(0);
    expect(
      lines.some((line) => line.includes('rejected usage') && line.includes('"dropped":1')),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    reporter.close();
  });

  it('requeues the whole batch on an error response without per-group results (an older kernel)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: { code: 'internal_error', message: 'x' } }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(record({ workspaceId: 'ws-a', requestId: 'r-1' }));
    reporter.record(record({ workspaceId: 'ws-b', requestId: 'r-2' }));

    await vi.advanceTimersByTimeAsync(100);
    expect(reporter.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    const [, retryInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const retried = JSON.parse(String(retryInit.body)) as LlmUsageRecord[];
    expect(retried.map((r) => r.requestId)).toEqual(['r-1', 'r-2']);
    reporter.close();
  });

  it('drops the oldest entries once the bounded queue is full', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new LlmUsageReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
      maxQueueSize: 2,
    });
    reporter.record(record({ model: 'one' }));
    reporter.record(record({ model: 'two' }));
    reporter.record(record({ model: 'three' }));

    await vi.advanceTimersByTimeAsync(100);
    const [, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as LlmUsageRecord[];
    expect(body.map((r) => r.model)).toEqual(['two', 'three']);
    reporter.close();
  });
});
