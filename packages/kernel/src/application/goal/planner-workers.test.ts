import { describe, expect, it } from 'vitest';
import { PLANNER_WORKERS_MAX_BYTES, fitPlannerWorkers } from './planner.js';

/**
 * application/goal/planner `fitPlannerWorkers` (S11 GO13, fork F5 = A): the planner's `workers`
 * stay within {@link PLANNER_WORKERS_MAX_BYTES} by dropping contracts, last Worker first, each
 * such Worker marked `contractOmitted` — never by dropping a Worker. The log line the planner
 * writes when it does is `goal-planner.integration.test.ts`'.
 */

/** A contract of about `bytes` bytes serialized: one property with a long description. */
function contractOf(bytes: number) {
  return {
    type: 'object',
    properties: { note: { type: 'string', description: 'x'.repeat(bytes) } },
  };
}

function worker(index: number, contractBytes?: number): Record<string, unknown> {
  return {
    definitionId: `w${index}`,
    version: 1,
    startable: true,
    ...(contractBytes === undefined
      ? {}
      : { inputSchema: contractOf(contractBytes), outputSchema: contractOf(contractBytes) }),
  };
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('fitPlannerWorkers', () => {
  it('within the limit: unchanged', () => {
    const workers = [worker(0, 1_000), worker(1)];
    const fitted = fitPlannerWorkers(workers);
    expect(fitted.workers).toEqual(workers);
    expect(fitted.omitted).toBe(0);
    expect(fitted.bytesAfter).toBe(fitted.bytesBefore);
  });

  it('past the limit: contracts dropped from the last Worker back until it fits, each marked', () => {
    // Five Workers with ~20 KB of contract each (~100 KB); a Worker without one at the end.
    const workers = [0, 1, 2, 3, 4].map((index) => worker(index, 10_000)).concat(worker(5));
    expect(size(workers)).toBeGreaterThan(PLANNER_WORKERS_MAX_BYTES);
    const fitted = fitPlannerWorkers(workers);

    expect(fitted.workers).toHaveLength(6);
    expect(fitted.bytesBefore).toBe(size(workers));
    expect(fitted.bytesAfter).toBe(size(fitted.workers));
    expect(fitted.bytesAfter).toBeLessThanOrEqual(PLANNER_WORKERS_MAX_BYTES);
    // ~100 KB to under 64 KiB: two contracts go, from the end; the one with none is untouched.
    expect(fitted.omitted).toBe(2);
    expect(fitted.workers[5]).toEqual(worker(5));
    for (const index of [3, 4]) {
      expect(fitted.workers[index]).toEqual({
        definitionId: `w${index}`,
        version: 1,
        startable: true,
        contractOmitted: true,
      });
    }
    for (const index of [0, 1, 2]) expect(fitted.workers[index]).toEqual(workers[index]);
  });

  it('every contract dropped and still too large: what is left is offered as it is', () => {
    const many = Array.from({ length: 2_000 }, (_, index) => worker(index));
    const fitted = fitPlannerWorkers(many);
    expect(fitted.omitted).toBe(0);
    expect(fitted.workers).toHaveLength(2_000);
  });
});
