import { randomUUID } from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PoolLike } from '../../adapters/db/pool.js';
import { HANDLE_SIGNING_ALG } from '../../governance/capability/keys.js';
import { hashApiKey } from './auth.js';
import { UnauthorizedError, resolveCaller } from './resolve-caller.js';

/**
 * application/gateway/resolve-caller.test: unit tests with a fake `pg` client (no DB — same
 * "in-memory table maps behind a `vi.fn` query matcher" pattern as
 * packages/kernel/src/governance/capability/handles.test.ts's `createFakeCapabilityClient`) plus
 * DB-gated integration tests near the end. Covers docs/development-tasks.md S1.3's "无 key 401"
 * acceptance criterion and the channel-detection fallthrough (item 2).
 */

interface FakePrincipal {
  workspace_id: string;
  id: string;
  kind: string;
  role: string;
  display_name: string | null;
  api_key_hash: string;
}

interface FakeSession {
  workspace_id: string;
  id: string;
  principal_id: string;
  kind: string;
  on_behalf_of: string;
  status: string;
  created_at: Date;
  expires_at: Date | null;
}

function createFakePool(opts: {
  principals?: FakePrincipal[];
  revokedJtis?: readonly string[];
}) {
  const principals = opts.principals ?? [];
  const revokedJtis = new Set(opts.revokedJtis ?? []);
  const sessions: FakeSession[] = [];

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('select set_config(') || sql === 'set local role nexttime_app') {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('select workspace_id, id, kind, role, display_name from principals')) {
      const [hash] = params as [string];
      const row = principals.find((p) => p.api_key_hash === hash);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (
      sql.startsWith(
        'select workspace_id, id, principal_id, kind, on_behalf_of, status, created_at, expires_at\n     from sessions',
      )
    ) {
      const [workspaceId, principalId] = params as [string, string];
      const row = sessions.find(
        (s) => s.workspace_id === workspaceId && s.principal_id === principalId,
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('insert into sessions')) {
      const [workspaceId, principalId] = params as [string, string];
      const row: FakeSession = {
        workspace_id: workspaceId,
        id: randomUUID(),
        principal_id: principalId,
        kind: 'web',
        on_behalf_of: principalId,
        status: 'active',
        created_at: new Date(),
        expires_at: null,
      };
      sessions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('select revoked_at from capability_handles')) {
      const [jti] = params as [string];
      return { rows: [{ revoked_at: revokedJtis.has(jti) ? new Date() : null }], rowCount: 1 };
    }

    throw new Error(`createFakePool: unexpected query: ${sql}`);
  });

  const client = { query, release: vi.fn() };
  const pool: PoolLike = { connect: async () => client as unknown as PoolClient };
  return { pool, query };
}

describe('resolveCaller — Authorization header parsing', () => {
  const { pool } = createFakePool({});

  it('missing header → UnauthorizedError', async () => {
    await expect(resolveCaller(undefined, { pool })).rejects.toThrow(UnauthorizedError);
  });

  it('non-Bearer scheme → UnauthorizedError', async () => {
    await expect(resolveCaller('Basic abc123', { pool })).rejects.toThrow(UnauthorizedError);
  });

  it('"Bearer" with no token → UnauthorizedError', async () => {
    await expect(resolveCaller('Bearer', { pool })).rejects.toThrow(UnauthorizedError);
    await expect(resolveCaller('Bearer   ', { pool })).rejects.toThrow(UnauthorizedError);
  });
});

describe('resolveCaller — human channel (API key)', () => {
  it('resolves a known API key to {channel:"human", ...}', async () => {
    const apiKey = 'test-api-key-1';
    const { pool } = createFakePool({
      principals: [
        {
          workspace_id: 'ws1',
          id: 'p1',
          kind: 'human',
          role: 'member',
          display_name: 'Alice',
          api_key_hash: hashApiKey(apiKey),
        },
      ],
    });

    const caller = await resolveCaller(`Bearer ${apiKey}`, { pool });

    expect(caller.channel).toBe('human');
    if (caller.channel !== 'human') throw new Error('unreachable');
    expect(caller.principal.id).toBe('p1');
    expect(caller.principal.role).toBe('member');
    expect(caller.session.onBehalfOf).toBe('p1');
  });
});

describe('resolveCaller — handle channel fallthrough', () => {
  it('an unknown API key falls through to Handle verification, and a valid Handle resolves', async () => {
    const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
      crv: 'Ed25519',
      extractable: true,
    });
    const { pool } = createFakePool({ principals: [] }); // no principal has this key
    const onBehalfOf = randomUUID();

    const token = await new SignJWT({
      ws: randomUUID(),
      sid: randomUUID(),
      obo: onBehalfOf,
      scope: { capabilities: ['get_object'], resources: {} },
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    const caller = await resolveCaller(`Bearer ${token}`, {
      pool,
      loadHandlePublicKey: async () => publicKey,
    });

    expect(caller.channel).toBe('handle');
    if (caller.channel !== 'handle') throw new Error('unreachable');
    expect(caller.claims.obo).toBe(onBehalfOf);
  });

  it('a token that is neither a known API key nor a valid Handle → UnauthorizedError (401)', async () => {
    const { publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
      crv: 'Ed25519',
      extractable: true,
    });
    const { pool } = createFakePool({ principals: [] });

    await expect(
      resolveCaller('Bearer not-a-real-key-or-handle', {
        pool,
        loadHandlePublicKey: async () => publicKey,
      }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('a revoked Handle → UnauthorizedError (401)', async () => {
    const { publicKey, privateKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
      crv: 'Ed25519',
      extractable: true,
    });
    const jti = randomUUID();
    const { pool } = createFakePool({ principals: [], revokedJtis: [jti] });

    const token = await new SignJWT({
      ws: randomUUID(),
      sid: randomUUID(),
      obo: randomUUID(),
      scope: { capabilities: [], resources: {} },
      jti,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    await expect(
      resolveCaller(`Bearer ${token}`, { pool, loadHandlePublicKey: async () => publicKey }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('when no Handle keys are configured (loader throws), a non-API-key Bearer still → 401, not a crash', async () => {
    const { pool } = createFakePool({ principals: [] });

    await expect(
      resolveCaller('Bearer something', {
        pool,
        loadHandlePublicKey: async () => {
          throw new Error('HANDLE_PRIVATE_KEY_FILE is not set');
        },
      }),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe('resolveCaller — no DB access when the header is missing', () => {
  it('never calls pool.connect() for a missing Authorization header', async () => {
    const connect = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const pool: PoolLike = { connect };

    await expect(resolveCaller(undefined, { pool })).rejects.toThrow(UnauthorizedError);
    expect(connect).not.toHaveBeenCalled();
  });
});
