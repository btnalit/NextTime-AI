import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseConfigError,
  InvalidWorkspaceContextError,
  type PoolLike,
  createPool,
  withWorkspace,
} from './pool.js';

const DATABASE_URL = process.env.DATABASE_URL;

/**
 * A minimal fake `pg` client/pool pair used to unit-test withWorkspace's transaction
 * orchestration (BEGIN / set_config / COMMIT / ROLLBACK) with no Postgres involved.
 */
function createFakePool() {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  let released = false;

  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(() => {
      released = true;
    }),
  };

  const pool: PoolLike = {
    connect: vi.fn(async () => client as unknown as PoolClient),
  };

  return { pool, client, calls, isReleased: () => released };
}

describe('createPool', () => {
  it('throws DatabaseConfigError when DATABASE_URL is unset and no override is given', () => {
    const original = process.env.DATABASE_URL;
    // biome-ignore lint/performance/noDelete: process.env coerces `= undefined` to the string "undefined" instead of unsetting the var; delete is the only way to make it actually absent.
    delete process.env.DATABASE_URL;
    try {
      expect(() => createPool()).toThrow(DatabaseConfigError);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });

  it('builds a Pool without connecting when a connectionString is provided', () => {
    const pool = createPool({
      connectionString: 'postgres://example:example@localhost:5432/example',
    });
    try {
      expect(typeof pool.connect).toBe('function');
    } finally {
      // The pool never connected (no query was issued), so end() resolves immediately.
      void pool.end();
    }
  });

  it('prefers the explicit connectionString over DATABASE_URL', () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://from-env/should-not-be-used';
    try {
      const pool = createPool({ connectionString: 'postgres://explicit/example' });
      expect(typeof pool.connect).toBe('function');
      void pool.end();
    } finally {
      // biome-ignore lint/performance/noDelete: same reason as above — delete is required to make DATABASE_URL actually absent.
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});

describe('withWorkspace — validation', () => {
  it('rejects with InvalidWorkspaceContextError when workspaceId is missing, without connecting', async () => {
    const { pool } = createFakePool();
    await expect(
      withWorkspace(pool, { workspaceId: '', principalId: 'p1' }, async () => 'unused'),
    ).rejects.toThrow(InvalidWorkspaceContextError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects with InvalidWorkspaceContextError when principalId is missing, without connecting', async () => {
    const { pool } = createFakePool();
    await expect(
      withWorkspace(pool, { workspaceId: 'w1', principalId: '' }, async () => 'unused'),
    ).rejects.toThrow(InvalidWorkspaceContextError);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('withWorkspace — transaction orchestration (fake client, no Postgres)', () => {
  it('runs BEGIN, both set_config calls, fn, then COMMIT, and releases the client', async () => {
    const { pool, client, calls } = createFakePool();

    const result = await withWorkspace(
      pool,
      { workspaceId: 'w1', principalId: 'p1' },
      async (c) => {
        expect(c).toBe(client);
        return 'ok';
      },
    );

    expect(result).toBe('ok');
    expect(calls.map((c) => c.text)[0]).toBe('BEGIN');
    expect(calls[1]).toEqual({
      text: "select set_config('app.workspace_id', $1, true)",
      values: ['w1'],
    });
    expect(calls[2]).toEqual({
      text: "select set_config('app.principal_id', $1, true)",
      values: ['p1'],
    });
    expect(calls[3]).toEqual({ text: 'set local role nexttime_app', values: undefined });
    expect(calls.map((c) => c.text).at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('skips the role switch when skipRoleSwitch is set, for admin/bootstrap operations', async () => {
    const { pool, calls } = createFakePool();

    await withWorkspace(pool, { workspaceId: 'w1', principalId: 'p1' }, async () => 'ok', {
      skipRoleSwitch: true,
    });

    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      "select set_config('app.workspace_id', $1, true)",
      "select set_config('app.principal_id', $1, true)",
      'COMMIT',
    ]);
  });

  it('rolls back and rethrows the original error when fn throws, and still releases the client', async () => {
    const { pool, client, calls, isReleased } = createFakePool();
    const boom = new Error('boom');

    await expect(
      withWorkspace(pool, { workspaceId: 'w1', principalId: 'p1' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls.map((c) => c.text)).toEqual([
      'BEGIN',
      "select set_config('app.workspace_id', $1, true)",
      "select set_config('app.principal_id', $1, true)",
      'set local role nexttime_app',
      'ROLLBACK',
    ]);
    expect(isReleased()).toBe(true);
  });

  it('does not swallow a ROLLBACK failure — the original error is still what rejects', async () => {
    const { pool, client } = createFakePool();
    const boom = new Error('fn failed');
    client.query.mockImplementation(async (text: string) => {
      if (text === 'ROLLBACK') throw new Error('connection already closed');
      return { rows: [], rowCount: 0 };
    });

    await expect(
      withWorkspace(pool, { workspaceId: 'w1', principalId: 'p1' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(DATABASE_URL !== undefined)('withWorkspace — integration (real Postgres)', () => {
  // Deferred to beforeAll: describe callbacks run during collection even for a skipped suite,
  // so calling createPool() here directly would throw (no DATABASE_URL) before runIf takes effect.
  // max: 1 forces every pool.connect() in this block onto the same physical connection, which is
  // exactly what the leak-prevention test below needs to prove.
  let pool!: Pool;

  beforeAll(async () => {
    pool = createPool({ poolConfig: { max: 1 } });
    // withWorkspace's default `SET LOCAL ROLE nexttime_app` (S1.1) needs that role to exist.
    // Deliberately not a full `runMigrations()` call here (that's migrate.test.ts's and
    // invariants.test.ts's job, against the same database, and running it a third time from
    // this file too would race table-creation statements that have no `IF NOT EXISTS` guard —
    // see PR body "假设"). Creating just the role is safe under that same concurrency because
    // `CREATE ROLE` is atomic and migrations/core/0001_identity.sql's own
    // `EXCEPTION WHEN duplicate_object` idiom is mirrored here.
    const client = await pool.connect();
    try {
      await client.query(`
        do $$
        begin
          create role nexttime_app nologin;
        exception
          when duplicate_object then
            null;
        end
        $$;
      `);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('switches the transaction onto the non-login nexttime_app role by default (S1.1)', async () => {
    const workspaceId = randomUUID();
    const principalId = randomUUID();

    const currentRole = await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
      const result = await client.query<{ current_user: string }>('select current_user');
      return result.rows[0]?.current_user;
    });

    expect(currentRole).toBe('nexttime_app');
  });

  it('stays on the login role when skipRoleSwitch is set', async () => {
    const workspaceId = randomUUID();
    const principalId = randomUUID();

    const currentRole = await withWorkspace(
      pool,
      { workspaceId, principalId },
      async (client) => {
        const result = await client.query<{ current_user: string }>('select current_user');
        return result.rows[0]?.current_user;
      },
      { skipRoleSwitch: true },
    );

    expect(currentRole).not.toBe('nexttime_app');
  });

  it('makes app.workspace_id and app.principal_id visible inside the transaction', async () => {
    const workspaceId = randomUUID();
    const principalId = randomUUID();

    const seenInside = await withWorkspace(pool, { workspaceId, principalId }, async (client) => {
      const result = await client.query<{ workspace_id: string; principal_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id, current_setting('app.principal_id', true) as principal_id",
      );
      return result.rows[0];
    });

    expect(seenInside).toEqual({ workspace_id: workspaceId, principal_id: principalId });
  });

  it('is_local = true means the setting does not leak into a later request on a reused pooled connection', async () => {
    const workspaceId = randomUUID();
    const principalId = randomUUID();

    await withWorkspace(pool, { workspaceId, principalId }, async () => {});

    // With max: 1, this is guaranteed to be the same physical connection withWorkspace just
    // used above. A session-wide (is_local = false) set_config would still show workspaceId
    // here; Postgres returns '' (not null) for a custom GUC with no local value, hence '??'.
    const client = await pool.connect();
    try {
      const result = await client.query<{ workspace_id: string }>(
        "select current_setting('app.workspace_id', true) as workspace_id",
      );
      const seen = result.rows[0]?.workspace_id ?? '';
      expect(seen).not.toBe(workspaceId);
      expect(seen).toBe('');
    } finally {
      client.release();
    }
  });

  it('rolls back on error — no partial writes survive', async () => {
    const workspaceId = randomUUID();
    const principalId = randomUUID();

    await expect(
      withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await client.query('create temporary table t2 (x int)');
        await client.query('insert into t2 values (1)');
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    // The temp table from the rolled-back transaction must not exist in a fresh transaction.
    await expect(
      withWorkspace(pool, { workspaceId, principalId }, async (client) => {
        await client.query('select * from t2');
      }),
    ).rejects.toThrow();
  });
});
