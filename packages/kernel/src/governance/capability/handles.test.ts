import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapability } from '@nexttime/shared';
import { SignJWT } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  AttenuationError,
  type CapabilityScope,
  ENTRY_CEILING_CAPABILITIES,
  HandleExpired,
  HandleInvalid,
  HandleIssuanceError,
  HandleRevoked,
  ScopeValidationError,
  attenuate,
  createDbRevocationCheck,
  entryScope,
  issueHandle,
  revokeHandle,
  revokeSession,
  verifyHandle,
} from './handles.js';
import { HANDLE_SIGNING_ALG, generateEphemeralHandleKeyPair } from './keys.js';

/**
 * governance/capability/handles.test: two suites in one file, following the pattern already
 * established by packages/kernel/src/adapters/db/{migrate,pool}.test.ts and
 * packages/kernel/src/substrate/invariants.test.ts:
 *
 *   - Unit tests (docs/development-tasks.md S1.9 "unit (ephemeral keys)"): ephemeral in-memory
 *     Ed25519 keys (never touch the filesystem) and a minimal in-memory fake `PoolClient` (same
 *     "no Postgres involved" pattern as pool.test.ts's `createFakePool`) standing in for
 *     `sessions` and `capability_handles`. Always run.
 *   - Integration tests (S1.9 "Integration (DATABASE_URL, auto-skip otherwise)"), in the
 *     `describe.runIf(DATABASE_URL !== undefined)` block near the end of this file: real
 *     Postgres, real RLS, and the real `on_behalf_of` immutability trigger — none of which the
 *     fake client can exercise.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

// -------------------------------------------------------------------------------------------
// Fake PoolClient — a tiny in-memory stand-in for `sessions` + `capability_handles`, matched
// against the exact small set of SQL statements handles.ts issues.
// -------------------------------------------------------------------------------------------

interface FakeSessionRow {
  workspaceId: string;
  onBehalfOf: string;
}

interface FakeHandleRow {
  workspace_id: string;
  session_id: string;
  on_behalf_of: string;
  parent_jti: string | null;
  scope: CapabilityScope;
  expires_at: string;
  revoked_at: string | null;
}

function createFakeCapabilityClient() {
  const sessions = new Map<string, FakeSessionRow>();
  const handles = new Map<string, FakeHandleRow>();

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.trim();

    if (sql.startsWith('select workspace_id, on_behalf_of from sessions')) {
      const [sessionId] = params as [string];
      const row = sessions.get(sessionId);
      return {
        rows: row ? [{ workspace_id: row.workspaceId, on_behalf_of: row.onBehalfOf }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith('insert into capability_handles')) {
      const [workspaceId, jti, sessionId, onBehalfOf, parentJti, scopeJson, expiresAt] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ];
      handles.set(jti, {
        workspace_id: workspaceId,
        session_id: sessionId,
        on_behalf_of: onBehalfOf,
        parent_jti: parentJti,
        scope: JSON.parse(scopeJson) as CapabilityScope,
        expires_at: expiresAt,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('select revoked_at from capability_handles')) {
      const [jti] = params as [string];
      const row = handles.get(jti);
      return { rows: row ? [{ revoked_at: row.revoked_at }] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.startsWith('update capability_handles set revoked_at = now() where jti')) {
      const [jti] = params as [string];
      const row = handles.get(jti);
      const affected = row && row.revoked_at === null;
      if (affected) row.revoked_at = new Date().toISOString();
      return { rows: [], rowCount: affected ? 1 : 0 };
    }

    if (sql.startsWith('update capability_handles set revoked_at = now() where session_id')) {
      const [sessionId] = params as [string];
      let count = 0;
      for (const row of handles.values()) {
        if (row.session_id === sessionId && row.revoked_at === null) {
          row.revoked_at = new Date().toISOString();
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`fake capability client: unhandled query: ${sql}`);
  });

  const client = { query } as unknown as PoolClient;

  function addSession(sessionId: string, row: FakeSessionRow): void {
    sessions.set(sessionId, row);
  }

  return { client, addSession, handles };
}

function neverRevoked(): boolean {
  return false;
}

// -------------------------------------------------------------------------------------------
// issue -> verify round trip
// -------------------------------------------------------------------------------------------

describe('issueHandle / verifyHandle', () => {
  it('round-trips: issued claims match the session row (obo from the session, never a param) and the token verifies', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();

    const sessionId = randomUUID();
    const workspaceId = randomUUID();
    const onBehalfOf = randomUUID();
    addSession(sessionId, { workspaceId, onBehalfOf });

    const scope: CapabilityScope = { capabilities: ['get_object', 'traverse'], resources: {} };

    const issued = await issueHandle(client, {
      sessionId,
      scope,
      ttlSeconds: 300,
      privateKey,
    });

    expect(issued.workspaceId).toBe(workspaceId);
    expect(issued.onBehalfOf).toBe(onBehalfOf);
    expect(issued.sessionId).toBe(sessionId);
    expect(issued.parentJti).toBeUndefined();

    const claims = await verifyHandle(issued.token, { publicKey, isRevoked: neverRevoked });
    expect(claims.ws).toBe(workspaceId);
    expect(claims.sid).toBe(sessionId);
    expect(claims.obo).toBe(onBehalfOf);
    expect(claims.jti).toBe(issued.jti);
    expect(claims.scope).toEqual(scope);
    expect(claims.par).toBeUndefined();
  });

  it('rejects issuance for a sessionId with no session row', async () => {
    const { client } = createFakeCapabilityClient();
    const { privateKey } = await generateEphemeralHandleKeyPair();

    await expect(
      issueHandle(client, {
        sessionId: randomUUID(),
        scope: { capabilities: [], resources: {} },
        ttlSeconds: 60,
        privateKey,
      }),
    ).rejects.toThrow(HandleIssuanceError);
  });

  it('rejects a non-positive ttlSeconds', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    await expect(
      issueHandle(client, {
        sessionId,
        scope: { capabilities: [], resources: {} },
        ttlSeconds: 0,
        privateKey,
      }),
    ).rejects.toThrow(HandleIssuanceError);
  });

  it('rejects a scope with an unknown capability name', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    await expect(
      issueHandle(client, {
        sessionId,
        scope: { capabilities: ['not_a_real_capability'], resources: {} },
        ttlSeconds: 60,
        privateKey,
      }),
    ).rejects.toThrow(ScopeValidationError);
  });

  it.each(['approve', 'grant_capability'])(
    'rejects a scope containing the human-channel-only capability "%s"',
    async (name) => {
      const { client, addSession } = createFakeCapabilityClient();
      const { privateKey } = await generateEphemeralHandleKeyPair();
      const sessionId = randomUUID();
      addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

      await expect(
        issueHandle(client, {
          sessionId,
          scope: { capabilities: [name], resources: {} },
          ttlSeconds: 60,
          privateKey,
        }),
      ).rejects.toThrow(ScopeValidationError);
    },
  );
});

// -------------------------------------------------------------------------------------------
// verifyHandle — expired / tampered / revoked
// -------------------------------------------------------------------------------------------

describe('verifyHandle — failure modes', () => {
  it('throws HandleExpired for a token whose exp claim is in the past', async () => {
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const nowSeconds = Math.floor(Date.now() / 1000);

    const expiredToken = await new SignJWT({
      ws: randomUUID(),
      sid: randomUUID(),
      obo: randomUUID(),
      scope: { capabilities: [], resources: {} },
      jti: randomUUID(),
      iat: nowSeconds - 120,
      exp: nowSeconds - 60,
    })
      .setProtectedHeader({ alg: HANDLE_SIGNING_ALG })
      .sign(privateKey);

    await expect(
      verifyHandle(expiredToken, { publicKey, isRevoked: neverRevoked }),
    ).rejects.toThrow(HandleExpired);
  });

  it('throws HandleInvalid for a tampered token (signature no longer matches)', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    const issued = await issueHandle(client, {
      sessionId,
      scope: { capabilities: [], resources: {} },
      ttlSeconds: 60,
      privateKey,
    });

    // Flip the leading character of the payload segment (middle segment of the compact JWS) —
    // tampering the claims, not the signature, guarantees the signature (computed over the
    // original bytes) no longer matches; flipping a low-order character of the signature itself
    // is not reliable, since a base64url signature's trailing character can carry unused padding
    // bits that don't affect the decoded bytes at all.
    const segments = issued.token.split('.');
    const payload = segments[1] as string;
    const flippedChar = payload[0] === 'A' ? 'B' : 'A';
    segments[1] = `${flippedChar}${payload.slice(1)}`;
    const tampered = segments.join('.');

    await expect(verifyHandle(tampered, { publicKey, isRevoked: neverRevoked })).rejects.toThrow(
      HandleInvalid,
    );
  });

  it('throws HandleInvalid for garbage input', async () => {
    const { publicKey } = await generateEphemeralHandleKeyPair();
    await expect(
      verifyHandle('not-a-jwt-at-all', { publicKey, isRevoked: neverRevoked }),
    ).rejects.toThrow(HandleInvalid);
  });

  it('throws HandleRevoked when isRevoked reports the jti as revoked', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    const issued = await issueHandle(client, {
      sessionId,
      scope: { capabilities: [], resources: {} },
      ttlSeconds: 60,
      privateKey,
    });

    await expect(verifyHandle(issued.token, { publicKey, isRevoked: () => true })).rejects.toThrow(
      HandleRevoked,
    );
  });
});

// -------------------------------------------------------------------------------------------
// revocation (fake-DB unit coverage; the real trigger/RLS path is integration-only)
// -------------------------------------------------------------------------------------------

describe('revokeHandle / revokeSession / createDbRevocationCheck', () => {
  async function issueTwoHandlesInOneSession() {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    const first = await issueHandle(client, {
      sessionId,
      scope: { capabilities: [], resources: {} },
      ttlSeconds: 60,
      privateKey,
    });
    const second = await issueHandle(client, {
      sessionId,
      scope: { capabilities: [], resources: {} },
      ttlSeconds: 60,
      privateKey,
    });

    return { client, publicKey, sessionId, first, second };
  }

  it('revokeHandle revokes only the named jti; verifyHandle then fails via createDbRevocationCheck', async () => {
    const { client, publicKey, first, second } = await issueTwoHandlesInOneSession();
    const isRevoked = createDbRevocationCheck(client);

    await revokeHandle(client, first.jti);

    await expect(verifyHandle(first.token, { publicKey, isRevoked })).rejects.toThrow(
      HandleRevoked,
    );
    await expect(verifyHandle(second.token, { publicKey, isRevoked })).resolves.toMatchObject({
      jti: second.jti,
    });
  });

  it('revokeSession revokes every handle issued under that session', async () => {
    const { client, publicKey, sessionId, first, second } = await issueTwoHandlesInOneSession();
    const isRevoked = createDbRevocationCheck(client);

    await revokeSession(client, sessionId);

    await expect(verifyHandle(first.token, { publicKey, isRevoked })).rejects.toThrow(
      HandleRevoked,
    );
    await expect(verifyHandle(second.token, { publicKey, isRevoked })).rejects.toThrow(
      HandleRevoked,
    );
  });

  it('createDbRevocationCheck fails closed on an unknown jti', async () => {
    const { client } = createFakeCapabilityClient();
    const isRevoked = createDbRevocationCheck(client);
    await expect(isRevoked(randomUUID())).resolves.toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// attenuate — subset rules (capabilities, resources, ttl)
// -------------------------------------------------------------------------------------------

describe('attenuate', () => {
  async function issueParentHandle(scope: CapabilityScope, ttlSeconds = 3600) {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    const parent = await issueHandle(client, { sessionId, scope, ttlSeconds, privateKey });
    return { client, privateKey, publicKey, sessionId, parent };
  }

  it('issues a child handle for a genuine subset, recording parentJti and inheriting on_behalf_of/session', async () => {
    const parentScope: CapabilityScope = {
      capabilities: ['get_object', 'traverse', 'invoke_worker'],
      resources: { gatekeeper: ['gk-1', 'gk-2'] },
    };
    const { client, privateKey, publicKey, sessionId, parent } =
      await issueParentHandle(parentScope);

    const childScope: CapabilityScope = {
      capabilities: ['get_object'],
      resources: { gatekeeper: ['gk-1'] },
    };

    const child = await attenuate(client, parent.token, childScope, {
      privateKey,
      publicKey,
      isRevoked: neverRevoked,
    });

    expect(child.parentJti).toBe(parent.jti);
    expect(child.sessionId).toBe(sessionId);
    expect(child.onBehalfOf).toBe(parent.onBehalfOf);
    expect(child.scope).toEqual(childScope);

    const childClaims = await verifyHandle(child.token, { publicKey, isRevoked: neverRevoked });
    expect(childClaims.par).toBe(parent.jti);
  });

  it('rejects a capability not present in the parent scope', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle({
      capabilities: ['get_object'],
      resources: {},
    });

    await expect(
      attenuate(
        client,
        parent.token,
        { capabilities: ['traverse'], resources: {} },
        { privateKey, publicKey, isRevoked: neverRevoked },
      ),
    ).rejects.toThrow(AttenuationError);
  });

  it('rejects a resource id not present in the parent scope', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle({
      capabilities: ['get_object'],
      resources: { gatekeeper: ['gk-1'] },
    });

    await expect(
      attenuate(
        client,
        parent.token,
        { capabilities: ['get_object'], resources: { gatekeeper: ['gk-2'] } },
        { privateKey, publicKey, isRevoked: neverRevoked },
      ),
    ).rejects.toThrow(AttenuationError);
  });

  it('rejects a resource key entirely absent from the parent scope', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle({
      capabilities: ['get_object'],
      resources: {},
    });

    await expect(
      attenuate(
        client,
        parent.token,
        { capabilities: ['get_object'], resources: { gatekeeper: ['gk-1'] } },
        { privateKey, publicKey, isRevoked: neverRevoked },
      ),
    ).rejects.toThrow(AttenuationError);
  });

  it('rejects a requested ttlSeconds greater than the parent handle’s remaining ttl', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle(
      { capabilities: ['get_object'], resources: {} },
      120,
    );

    await expect(
      attenuate(
        client,
        parent.token,
        { capabilities: ['get_object'], resources: {} },
        { privateKey, publicKey, isRevoked: neverRevoked, ttlSeconds: 10_000 },
      ),
    ).rejects.toThrow(AttenuationError);
  });

  it('accepts a requested ttlSeconds within the parent’s remaining ttl', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle(
      { capabilities: ['get_object'], resources: {} },
      3600,
    );

    const child = await attenuate(
      client,
      parent.token,
      { capabilities: ['get_object'], resources: {} },
      { privateKey, publicKey, isRevoked: neverRevoked, ttlSeconds: 60 },
    );

    expect(child.expiresAt.getTime()).toBeLessThan(parent.expiresAt.getTime());
  });

  it('rejects attenuating an already-revoked parent handle', async () => {
    const { client, privateKey, publicKey, parent } = await issueParentHandle({
      capabilities: ['get_object'],
      resources: {},
    });
    await revokeHandle(client, parent.jti);
    const isRevoked = createDbRevocationCheck(client);

    await expect(
      attenuate(
        client,
        parent.token,
        { capabilities: ['get_object'], resources: {} },
        { privateKey, publicKey, isRevoked },
      ),
    ).rejects.toThrow(HandleRevoked);
  });
});

// -------------------------------------------------------------------------------------------
// entryScope — the fixed entry-agent ceiling
// -------------------------------------------------------------------------------------------

describe('entryScope', () => {
  it('contains no execute-mode capability and never request_action or the gate execute pattern', () => {
    const scope = entryScope();

    expect(scope.capabilities).not.toContain('request_action');
    expect(scope.capabilities).not.toContain('<gate>.<op>:execute');

    for (const name of scope.capabilities) {
      const capability = getCapability(name);
      expect(capability, `expected "${name}" to be a registered capability`).toBeDefined();
      expect(capability?.mode, `expected "${name}" to not be execute-mode`).not.toBe('execute');
      expect(capability?.channel).toBe('handle');
    }
  });

  it('includes the fixed task/connection/epistemic/find_* capabilities named in design doc §5.1.4', () => {
    const scope = entryScope();
    for (const name of [
      'get_task',
      'get_entry_context',
      'report_turn',
      'invoke_worker',
      'request_connection',
      'record_decision',
      'find_operations',
      'find_workers',
      'find_procedures',
      // S2.12 fix: the capability behind every projected `<gate>.<op>` observe tool.
      'observe_operation',
      // S2.6 bug fix: platform-extension's entry mode already registers `explain` as one of its
      // five S1 observe-group tools (design doc §5.1.2/§7.4) and calls it through the entry
      // Handle — it belongs on the ceiling even though its registry `group` is `'epistemic'`, not
      // `'graph'` (see ENTRY_CEILING_EXTRA_CAPABILITY_NAMES's own doc comment in handles.ts).
      'explain',
    ]) {
      expect(scope.capabilities).toContain(name);
    }
  });

  it('passes assertRegistryConsistent-style validation: every scope capability round-trips through issueHandle', async () => {
    const { client, addSession } = createFakeCapabilityClient();
    const { privateKey } = await generateEphemeralHandleKeyPair();
    const sessionId = randomUUID();
    addSession(sessionId, { workspaceId: randomUUID(), onBehalfOf: randomUUID() });

    await expect(
      issueHandle(client, { sessionId, scope: entryScope(), ttlSeconds: 60, privateKey }),
    ).resolves.toBeDefined();
  });

  it('merges definition.resources into the returned scope, leaving capabilities unchanged', () => {
    const withResources = entryScope({ resources: { gatekeeper: ['gk-1'] } });
    expect(withResources.resources).toEqual({ gatekeeper: ['gk-1'] });
    expect(withResources.capabilities).toEqual([...ENTRY_CEILING_CAPABILITIES]);
  });
});

// -------------------------------------------------------------------------------------------
// Integration (real Postgres, auto-skip without DATABASE_URL) — docs/development-tasks.md S1.9:
// "row written with obo from the session; revoke → verify fails via isRevoked lookup;
// revokeSession revokes all; attempting to UPDATE on_behalf_of fails (trigger)".
// -------------------------------------------------------------------------------------------

describe.runIf(DATABASE_URL !== undefined)(
  'capability_handles — integration (real Postgres)',
  () => {
    let pool: Pool;
    let workspaceId: string;
    let ownerId: string;
    let otherPrincipalId: string;
    let sessionId: string;
    let onBehalfOf: string;

    async function adminInsertWorkspace(name: string): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: id, principalId: randomUUID() },
        async (client) => {
          await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function adminInsertPrincipal(
      ws: string,
      opts: { role: string; displayName: string },
    ): Promise<string> {
      const id = randomUUID();
      await withWorkspace(
        pool,
        { workspaceId: ws, principalId: id },
        async (client) => {
          await client.query(
            "insert into principals (workspace_id, id, kind, role, display_name) values ($1, $2, 'human', $3, $4)",
            [ws, id, opts.role, opts.displayName],
          );
        },
        { skipRoleSwitch: true },
      );
      return id;
    }

    async function insertSession(ws: string, principalId: string, obo: string): Promise<string> {
      return withWorkspace(pool, { workspaceId: ws, principalId }, async (client) => {
        const id = randomUUID();
        await client.query(
          `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, 'entry', $4, 'ready')`,
          [ws, id, principalId, obo],
        );
        return id;
      });
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);

      workspaceId = await adminInsertWorkspace('capability-handles-test-workspace');
      ownerId = await adminInsertPrincipal(workspaceId, { role: 'owner', displayName: 'owner' });
      otherPrincipalId = await adminInsertPrincipal(workspaceId, {
        role: 'member',
        displayName: 'other',
      });
      onBehalfOf = ownerId;
      sessionId = await insertSession(workspaceId, ownerId, onBehalfOf);
    });

    afterAll(async () => {
      await pool.end();
    });

    it('issueHandle writes a capability_handles row with on_behalf_of copied from the session', async () => {
      const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
      const scope: CapabilityScope = { capabilities: ['get_object'], resources: {} };

      const issued = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        issueHandle(client, { sessionId, scope, ttlSeconds: 300, privateKey }),
      );

      expect(issued.onBehalfOf).toBe(onBehalfOf);

      const row = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{
            on_behalf_of: string;
            session_id: string;
            revoked_at: Date | null;
          }>(
            'select on_behalf_of, session_id, revoked_at from capability_handles where workspace_id = $1 and jti = $2',
            [workspaceId, issued.jti],
          );
          return result.rows[0];
        },
      );

      expect(row?.on_behalf_of).toBe(onBehalfOf);
      expect(row?.session_id).toBe(sessionId);
      expect(row?.revoked_at).toBeNull();

      const claims = await verifyHandle(issued.token, {
        publicKey,
        isRevoked: async (jti) =>
          withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) =>
            createDbRevocationCheck(client)(jti),
          ),
      });
      expect(claims.obo).toBe(onBehalfOf);
    });

    it('revokeHandle revokes the row; verifyHandle then fails via a real isRevoked lookup', async () => {
      const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
      const scope: CapabilityScope = { capabilities: ['get_object'], resources: {} };

      const issued = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        issueHandle(client, { sessionId, scope, ttlSeconds: 300, privateKey }),
      );

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        revokeHandle(client, issued.jti),
      );

      const isRevoked = (jti: string): Promise<boolean> =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          createDbRevocationCheck(client)(jti),
        );

      await expect(verifyHandle(issued.token, { publicKey, isRevoked })).rejects.toThrow(
        HandleRevoked,
      );
    });

    it('revokeSession revokes every handle issued under that session', async () => {
      const { privateKey, publicKey } = await generateEphemeralHandleKeyPair();
      const scope: CapabilityScope = { capabilities: ['get_object'], resources: {} };

      const localSessionId = await insertSession(workspaceId, ownerId, onBehalfOf);
      const { first, second } = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const a = await issueHandle(client, {
            sessionId: localSessionId,
            scope,
            ttlSeconds: 300,
            privateKey,
          });
          const b = await issueHandle(client, {
            sessionId: localSessionId,
            scope,
            ttlSeconds: 300,
            privateKey,
          });
          return { first: a, second: b };
        },
      );

      await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        revokeSession(client, localSessionId),
      );

      const isRevoked = (jti: string): Promise<boolean> =>
        withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
          createDbRevocationCheck(client)(jti),
        );

      await expect(verifyHandle(first.token, { publicKey, isRevoked })).rejects.toThrow(
        HandleRevoked,
      );
      await expect(verifyHandle(second.token, { publicKey, isRevoked })).rejects.toThrow(
        HandleRevoked,
      );
    });

    it('UPDATE of on_behalf_of fails — I13, enforced by the capability_handles trigger', async () => {
      const { privateKey } = await generateEphemeralHandleKeyPair();
      const scope: CapabilityScope = { capabilities: ['get_object'], resources: {} };

      const issued = await withWorkspace(pool, { workspaceId, principalId: ownerId }, (client) =>
        issueHandle(client, { sessionId, scope, ttlSeconds: 300, privateKey }),
      );

      await expect(
        withWorkspace(pool, { workspaceId, principalId: ownerId }, async (client) => {
          await client.query(
            'update capability_handles set on_behalf_of = $1 where workspace_id = $2 and jti = $3',
            [otherPrincipalId, workspaceId, issued.jti],
          );
        }),
      ).rejects.toThrow();

      // Sanity: otherPrincipalId is a real, valid principal in this workspace (so the rejection
      // above is the trigger firing, not an incidental foreign-key violation on a bogus id).
      const stillOwner = await withWorkspace(
        pool,
        { workspaceId, principalId: ownerId },
        async (client) => {
          const result = await client.query<{ on_behalf_of: string }>(
            'select on_behalf_of from capability_handles where workspace_id = $1 and jti = $2',
            [workspaceId, issued.jti],
          );
          return result.rows[0]?.on_behalf_of;
        },
      );
      expect(stillOwner).toBe(onBehalfOf);
    });
  },
);
