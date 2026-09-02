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
