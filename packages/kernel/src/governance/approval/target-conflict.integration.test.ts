import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionTargetsConflict } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool } from '../../adapters/db/pool.js';

/**
 * governance/approval/target-conflict.integration (STATUS legacy 565): I-Q1's conflict rule lives
 * twice — `@nexttime/shared` `actionTargetsConflict`, which the drainer's queue planner reads, and
 * `governance/0031`'s `action_request_targets_conflict`, which the execution guard checks. One
 * table of cases runs through both and each must give the expected answer: change one side and
 * not the other and this file fails. The inputs are JSON text, read by each side as it reads a
 * stored `target` (the TypeScript side after `JSON.parse`, the SQL side as `jsonb`).
 *
 * Identity values are what a target declaration allows (I-Q4): strings and safe integers.
 *
 * In CI this file must run against Postgres, not skip: a CI run without `DATABASE_URL` fails it.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

const container = (...identity: unknown[]) =>
  JSON.stringify({ type: 'Container', params: ['id'], identity });

/** `[case, a, b, conflicts]`; `null` is a call on the whole Gatekeeper. Each case runs both ways. */
const CASES: ReadonlyArray<readonly [string, string | null, string | null, boolean]> = [
  ['both on the whole gate', null, null, true],
  ['one on the whole gate', null, container('web'), true],
  ['the same instance', container('web'), container('web'), true],
  ['another instance', container('web'), container('db'), false],
  [
    'another type, the same identity',
    container('web'),
    JSON.stringify({ type: 'Volume', params: ['id'], identity: ['web'] }),
    false,
  ],
  [
    'the same type named by other params',
    container('web'),
    JSON.stringify({ type: 'Container', params: ['name'], identity: ['db'] }),
    true,
  ],
  [
    'the same type named by more params',
    container('web'),
    JSON.stringify({ type: 'Container', params: ['id', 'host'], identity: ['web', 'a'] }),
    true,
  ],
  [
    'the same params, identity arrays of different length',
    container('web'),
    container('web', 'extra'),
    true,
  ],
  ['a number and its string are one instance', container(5), container('5'), true],
  [
    '5 and 5.0 are one instance',
    container(5),
    '{"type":"Container","params":["id"],"identity":[5.0]}',
    true,
  ],
  ['a number and another string', container(5), container('05'), false],
  ['the largest safe integer', container(9007199254740991), container('9007199254740991'), true],
  ['an empty identity under the same params', container(), container(), true],
  [
    'two params, all equal',
    JSON.stringify({ type: 'Record', params: ['zone', 'id'], identity: ['z1', 7] }),
    JSON.stringify({ type: 'Record', params: ['zone', 'id'], identity: ['z1', '7'] }),
    true,
  ],
  [
    'two params, one differs',
    JSON.stringify({ type: 'Record', params: ['zone', 'id'], identity: ['z1', 7] }),
    JSON.stringify({ type: 'Record', params: ['zone', 'id'], identity: ['z2', 7] }),
    false,
  ],
  [
    'two params in another order',
    JSON.stringify({ type: 'Record', params: ['zone', 'id'], identity: ['z1', 7] }),
    JSON.stringify({ type: 'Record', params: ['id', 'zone'], identity: [7, 'z1'] }),
    true,
  ],
];

function typescriptSide(a: string | null, b: string | null): boolean {
  return actionTargetsConflict(
    a === null ? null : JSON.parse(a),
    b === null ? null : JSON.parse(b),
  );
}

describe('I-Q1 conflict rule: the TypeScript and SQL copies agree', () => {
  it('runs against Postgres in CI', () => {
    if (process.env.CI !== undefined && process.env.CI !== 'false') {
      expect(DATABASE_URL, 'CI must set DATABASE_URL so the SQL side is checked').toBeDefined();
    }
  });

  it.each(CASES)('TypeScript: %s', (_name, a, b, expected) => {
    expect(typescriptSide(a, b)).toBe(expected);
    expect(typescriptSide(b, a)).toBe(expected);
  });

  describe.runIf(DATABASE_URL !== undefined)('SQL (real Postgres)', () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
    });

    afterAll(async () => {
      await pool.end();
    });

    async function sqlSide(a: string | null, b: string | null): Promise<boolean> {
      const { rows } = await pool.query<{ conflicts: boolean }>(
        'select action_request_targets_conflict($1::jsonb, $2::jsonb) as conflicts',
        [a, b],
      );
      return rows[0]?.conflicts as boolean;
    }

    it.each(CASES)('SQL: %s', async (_name, a, b, expected) => {
      expect(await sqlSide(a, b)).toBe(expected);
      expect(await sqlSide(b, a)).toBe(expected);
    });
  });
});
