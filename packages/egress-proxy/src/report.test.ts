import { PLATFORM_EVENT_NAMES } from '@nexttime/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressObservation } from './report.js';
import { EgressReporter } from './report.js';

function observation(overrides: Partial<EgressObservation> = {}): EgressObservation {
  return {
    type: 'EgressObserved',
    sourceId: 'source-1',
    clientIp: '198.51.100.2',
    domain: 'example.com',
    port: 443,
    protocol: 'connect',
    allowed: true,
    bytesUp: 10,
    bytesDown: 20,
    observedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('EgressObservation type discriminator', () => {
  // Value-level (not type-only) import of a runtime export from `@nexttime/shared` — proves the
  // workspace source-resolution guarantee at test time, not just at typecheck time:
  // `EgressObservation` deliberately isn't the shared `EgressObserved` domain event (see
  // report.ts), but its `type` discriminator must still be a real member of the canonical event
  // vocabulary.
  it("stays inside @nexttime/shared's canonical event vocabulary", () => {
    expect(PLATFORM_EVENT_NAMES).toContain(observation().type);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EgressReporter', () => {
  it('always logs a JSON line to stdout, even without a kernelUrl', () => {
    const lines: string[] = [];
    const reporter = new EgressReporter({ log: (line) => lines.push(line) });
    reporter.record(observation());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      type: 'EgressObserved',
      domain: 'example.com',
    });
    reporter.close();
  });

  it('does not queue or fetch when kernelUrl is unset', async () => {
    const fetchImpl = vi.fn();
    const reporter = new EgressReporter({ log: () => {}, fetchImpl });
    reporter.record(observation());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    reporter.close();
  });

  it('batches queued observations into one POST to /internal/egress', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new EgressReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(observation({ domain: 'a.example.com' }));
    reporter.record(observation({ domain: 'b.example.com' }));

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://kernel.internal:8080/internal/egress');
    const body = JSON.parse(String(init.body)) as { observations: EgressObservation[] };
    expect(body.observations.map((o) => o.domain)).toEqual(['a.example.com', 'b.example.com']);
    reporter.close();
  });

  it('never throws or blocks the caller when the POST fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const reporter = new EgressReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    expect(() => reporter.record(observation())).not.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    reporter.close();
  });

  it('retries a failed batch with backoff and eventually delivers it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);
    const reporter = new EgressReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
    });
    reporter.record(observation());

    await vi.advanceTimersByTimeAsync(100); // first attempt fails
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200); // backoff doubled to 200ms, retry succeeds
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(secondInit.body)) as { observations: EgressObservation[] };
    expect(body.observations).toHaveLength(1);
    reporter.close();
  });

  it('drops the oldest entries once the bounded queue is full', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true } as Response);
    const reporter = new EgressReporter({
      log: () => {},
      kernelUrl: 'http://kernel.internal:8080',
      fetchImpl,
      flushIntervalMs: 100,
      maxQueueSize: 2,
    });
    reporter.record(observation({ domain: 'one.example.com' }));
    reporter.record(observation({ domain: 'two.example.com' }));
    reporter.record(observation({ domain: 'three.example.com' }));

    await vi.advanceTimersByTimeAsync(100);
    const [, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { observations: EgressObservation[] };
    expect(body.observations.map((o) => o.domain)).toEqual([
      'two.example.com',
      'three.example.com',
    ]);
    reporter.close();
  });
});
