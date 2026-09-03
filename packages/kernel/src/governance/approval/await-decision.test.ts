import { describe, expect, it, vi } from 'vitest';
import { awaitActionRequestResolution } from './await-decision.js';
import type { ActionRequestRow } from './types.js';

/**
 * governance/approval/await-decision.test: `await_decision=true`'s wait-until-timeout primitive
 * (docs/development-tasks.md S2.3 acceptance "`await_decision=true` 时...超时后工具得到
 * `pending_approval`"). Pure unit tests — a fake `read`, an injectable clock/sleep, no Postgres and
 * no real timers (deterministic and fast).
 */

function actionRequest(overrides: Partial<ActionRequestRow> = {}): ActionRequestRow {
  return {
    workspaceId: 'ws1',
    id: 'ar1',
    status: 'pending_approval',
    gatekeeperId: 'gk1',
    actionKind: 'test.action',
    resourceScope: null,
    blastRadius: 'medium',
    policyDecision: 'require_approval',
    approvalDecisionId: null,
    awaitDecision: true,
    onBehalfOf: 'p1',
    parentWorkerRunId: null,
    actorRuntime: 'pi',
    idempotencyKey: null,
    requestedAt: new Date('2026-01-01T00:00:00Z'),
    executedAt: null,
    failedAt: null,
    ...overrides,
  };
}

/** A fake clock + no-op-fast sleep: `sleep` advances the fake clock by the requested amount
 *  instead of actually waiting, so the whole test suite runs in milliseconds. */
function fakeClock(startMs = 0) {
  let current = startMs;
  const now = () => current;
  const sleep = vi.fn(async (ms: number) => {
    current += ms;
  });
  return { now, sleep };
}

describe('awaitActionRequestResolution', () => {
  it('resolves immediately when the row is already resolved (no polling)', async () => {
    const resolved = actionRequest({ status: 'approved' });
    const read = vi.fn().mockResolvedValue(resolved);
    const { now, sleep } = fakeClock();

    const result = await awaitActionRequestResolution(read, { timeoutMs: 5000, now, sleep });

    expect(result).toEqual(resolved);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until the row leaves pending_approval, then returns it', async () => {
    const pending = actionRequest({ status: 'pending_approval' });
    const approved = actionRequest({ status: 'approved' });
    const read = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(approved);
    const { now, sleep } = fakeClock();

    const result = await awaitActionRequestResolution(read, {
      timeoutMs: 5000,
      pollIntervalMs: 100,
      now,
      sleep,
    });

    expect(result?.status).toBe('approved');
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('times out and returns the row still pending_approval', async () => {
    const pending = actionRequest({ status: 'pending_approval' });
    const read = vi.fn().mockResolvedValue(pending);
    const { now, sleep } = fakeClock();

    const result = await awaitActionRequestResolution(read, {
      timeoutMs: 500,
      pollIntervalMs: 200,
      now,
      sleep,
    });

    expect(result?.status).toBe('pending_approval');
  });

  it('returns null if read() reports the row no longer exists', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const { now, sleep } = fakeClock();

    const result = await awaitActionRequestResolution(read, { timeoutMs: 1000, now, sleep });

    expect(result).toBeNull();
  });

  it('caps the final sleep to the remaining time budget, not the full pollIntervalMs', async () => {
    const pending = actionRequest({ status: 'pending_approval' });
    const read = vi.fn().mockResolvedValue(pending);
    const { now, sleep } = fakeClock();

    await awaitActionRequestResolution(read, { timeoutMs: 150, pollIntervalMs: 1000, now, sleep });

    // Only ever slept up to the remaining budget (150ms), never the full 1000ms interval.
    for (const call of sleep.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(150);
    }
  });
});
