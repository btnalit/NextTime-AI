import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_VALUES,
  HARD_MAX_DEPTH,
  InvalidQuotaValueError,
  UnknownQuotaKeyError,
  resolveQuotas,
  setQuotaValue,
} from './quotas.js';

/**
 * application/task/quotas.test: pure/no-real-DB unit tests — a fake `PoolClient` (a `.query()`
 * stub returning canned rows) stands in for Postgres, matching the "unit with fakes" style
 * docs/development-tasks.md S2.7 calls for (quota depth clamping, set_quota validation).
 */

function fakeClient(rows: readonly { key: string; value: unknown }[]): PoolClient {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as PoolClient;
}

describe('resolveQuotas', () => {
  it('falls back to compiled-in defaults when the workspace has no overrides', async () => {
    const resolved = await resolveQuotas(fakeClient([]), 'ws1');
    expect(resolved).toEqual({
      maxDepth: DEFAULT_QUOTA_VALUES['task.max_depth'],
      maxConcurrentWorkerRunsPerUser:
        DEFAULT_QUOTA_VALUES['task.max_concurrent_worker_runs_per_user'],
      defaultTokenBudget: DEFAULT_QUOTA_VALUES['task.default_token_budget'],
      defaultDurationLimitSec: DEFAULT_QUOTA_VALUES['task.default_duration_limit_sec'],
      dailyCostBudgetUsd: DEFAULT_QUOTA_VALUES['task.daily_cost_budget_usd'],
    });
  });

  it('applies a workspace override for one key, leaving the rest at defaults', async () => {
    const resolved = await resolveQuotas(
      fakeClient([{ key: 'task.max_concurrent_worker_runs_per_user', value: 2 }]),
      'ws1',
    );
    expect(resolved.maxConcurrentWorkerRunsPerUser).toBe(2);
    expect(resolved.maxDepth).toBe(HARD_MAX_DEPTH);
  });

  it('clamps task.max_depth to HARD_MAX_DEPTH even if a stored override somehow exceeds it', async () => {
    const resolved = await resolveQuotas(fakeClient([{ key: 'task.max_depth', value: 99 }]), 'ws1');
    expect(resolved.maxDepth).toBe(HARD_MAX_DEPTH);
  });

  it('a workspace override may tighten max_depth below the hard ceiling', async () => {
    const resolved = await resolveQuotas(fakeClient([{ key: 'task.max_depth', value: 1 }]), 'ws1');
    expect(resolved.maxDepth).toBe(1);
  });

  it('an explicit null override for a nullable key means unlimited', async () => {
    const resolved = await resolveQuotas(
      fakeClient([{ key: 'task.default_token_budget', value: null }]),
      'ws1',
    );
    expect(resolved.defaultTokenBudget).toBeNull();
  });
});

describe('setQuotaValue', () => {
  function capturingClient(): { client: PoolClient; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const client = {
      query: async (text: string, values: unknown[]) => {
        calls.push([text, values]);
        return {
          rows: [
            {
              workspace_id: 'ws1',
              key: values[1],
              value: JSON.parse(values[2] as string),
              updated_by: values[3],
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as PoolClient;
    return { client, calls };
  }

  it('rejects an unknown key', async () => {
    const { client } = capturingClient();
    await expect(
      setQuotaValue(client, 'ws1', { key: 'not_a_real_key', value: 1, updatedBy: 'p1' }),
    ).rejects.toThrow(UnknownQuotaKeyError);
  });

  it('rejects task.max_depth above the hard ceiling', async () => {
    const { client } = capturingClient();
    await expect(
      setQuotaValue(client, 'ws1', {
        key: 'task.max_depth',
        value: HARD_MAX_DEPTH + 1,
        updatedBy: 'p1',
      }),
    ).rejects.toThrow(InvalidQuotaValueError);
  });

  it('rejects a non-numeric value for a numeric key', async () => {
    const { client } = capturingClient();
    await expect(
      setQuotaValue(client, 'ws1', {
        key: 'task.max_concurrent_worker_runs_per_user',
        value: 'not-a-number',
        updatedBy: 'p1',
      }),
    ).rejects.toThrow(InvalidQuotaValueError);
  });

  it('accepts a valid value and upserts it', async () => {
    const { client, calls } = capturingClient();
    const result = await setQuotaValue(client, 'ws1', {
      key: 'task.max_depth',
      value: 2,
      updatedBy: 'p1',
    });
    expect(result.value).toBe(2);
    expect(calls).toHaveLength(1);
    const [, values] = calls[0] as [string, unknown[]];
    expect(values[1]).toBe('task.max_depth');
  });

  it('accepts an explicit null for a nullable key', async () => {
    const { client } = capturingClient();
    const result = await setQuotaValue(client, 'ws1', {
      key: 'task.daily_cost_budget_usd',
      value: null,
      updatedBy: 'p1',
    });
    expect(result.value).toBeNull();
  });
});
