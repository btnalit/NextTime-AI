import { randomUUID } from 'node:crypto';
import type { HandleClaims } from '@nexttime/shared';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { InvalidCapabilityParamsError, dispatchCapability } from './dispatch.js';
import { MAX_PARAMS_VALUES, exceedsValueBudget } from './params-budget.js';

const neverConnectPool: PoolLike = {
  connect(): Promise<PoolClient> {
    throw new Error('a refused call must not touch the database');
  },
};

function handleCaller(capabilities: readonly string[]) {
  const claims: HandleClaims = {
    ws: randomUUID(),
    sid: randomUUID(),
    obo: randomUUID(),
    scope: { capabilities: [...capabilities], resources: {} },
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return { channel: 'handle' as const, claims };
}

async function refusal(params: unknown): Promise<InvalidCapabilityParamsError> {
  const caught = await dispatchCapability(
    { pool: neverConnectPool },
    handleCaller(['list_goals']),
    'list_goals',
    params,
  ).catch((err: unknown) => err);
  expect(caught).toBeInstanceOf(InvalidCapabilityParamsError);
  return caught as InvalidCapabilityParamsError;
}

describe('exceedsValueBudget', () => {
  it('counts every array element and object member at any depth, plus the value itself', () => {
    // 1 (object) + 1 (a) + 3 (b) + 1 (b[2]) + 1 (c) = 7 values
    const value = { a: 1, b: [1, 2, { c: 'x' }] };
    expect(exceedsValueBudget(value, 7)).toBe(false);
    expect(exceedsValueBudget(value, 6)).toBe(true);
    expect(exceedsValueBudget(null, 1)).toBe(false);
    expect(exceedsValueBudget(undefined, 1)).toBe(false);
  });

  it('refuses a call past the budget before Zod sees it: one issue, not one per element', async () => {
    const err = await refusal({ status: new Array(MAX_PARAMS_VALUES + 1).fill(0) });
    expect(err.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: [], maximum: MAX_PARAMS_VALUES }),
    ]);
  });

  it('leaves a call within the budget to the schema, which still names every bad element', async () => {
    const err = await refusal({ status: [0, 1, 2] });
    expect(err.issues).toHaveLength(3);
  });
});
