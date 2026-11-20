import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandleWire, Role, SessionKind } from '@nexttime/shared';
import { generateKeyPair } from 'jose';
import type { CryptoKey } from 'jose';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import type {
  TaskSpawnInput,
  TaskSpawnOutcome,
  TaskSupervisorClientPort,
  TaskSupervisorStatus,
} from '../../adapters/supervisor-client/index.js';
import { HANDLE_SIGNING_ALG, HandleRevoked } from '../../governance/capability/index.js';
import { queryAudit } from '../../substrate/audit/index.js';
import { configureTaskRuntime } from '../task/index.js';
import { ForbiddenError } from './authorize.js';
import { dispatchCapability } from './dispatch.js';
import { authenticateHandle } from './handle-auth.js';
import { HandleRevokeError } from './handles-handlers.js';
import type { ResolvedCaller } from './resolve-caller.js';
import { fixtureApiKeyHash } from './traversal-fixture.js';

/**
 * application/gateway/handles-handlers.integration.test (legacy 168): `list_handles` and
 * `revoke_handle` against real Postgres — who sees which Handles, how each is held, ending a
 * bearer Handle's session (and only a bearer one), and that the ended Handle no longer
 * authenticates.
 */

class UnusedSupervisorClient implements TaskSupervisorClientPort {
  spawn(_input: TaskSpawnInput): Promise<TaskSpawnOutcome> {
    throw new Error('handles tests never spawn a Task');
  }
  terminate(_workerRunId: string): Promise<boolean> {
    throw new Error('handles tests never terminate a Task');
  }
  status(_workerRunId: string): Promise<TaskSupervisorStatus | undefined> {
    throw new Error('handles tests never poll Task status');
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');

function humanCaller(workspaceId: string, principalId: string, role: Role): ResolvedCaller {
  return {
    channel: 'human',
    apiKeyHash: fixtureApiKeyHash(principalId),
    principal: { workspaceId, id: principalId, kind: 'human', role, displayName: null },
    session: {
      workspaceId,
      id: randomUUID(),
      principalId,
      kind: 'web',
      onBehalfOf: principalId,
      status: 'active',
      createdAt: new Date(),
      expiresAt: null,
    },
  };
}

interface Page {
  items: HandleWire[];
  nextCursor?: string;
  truncated?: true;
}

describe.runIf(DATABASE_URL !== undefined)('list_handles / revoke_handle (integration)', () => {
  let pool: Pool;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let ownerId: string;
  let memberId: string;
  let auditorId: string;
  let serviceId: string;
  let handlePublicKey: CryptoKey;

  async function asAdmin<T>(ws: string, fn: Parameters<typeof withWorkspace<T>>[2]): Promise<T> {
    return withWorkspace(pool, { workspaceId: ws, principalId: randomUUID() }, fn, {
      skipRoleSwitch: true,
    });
  }

  async function insertWorkspace(name: string): Promise<string> {
    const id = randomUUID();
    await asAdmin(id, async (client) => {
      await client.query('insert into workspaces (id, name) values ($1, $2)', [id, name]);
    });
    return id;
  }

  async function insertPrincipal(
    ws: string,
    kind: 'human' | 'service',
    role: Role,
    displayName: string,
  ): Promise<string> {
    const id = randomUUID();
    await asAdmin(ws, (client) =>
      client.query(
        `insert into principals (workspace_id, id, kind, role, display_name, api_key_hash)
         values ($1, $2, $3, $4, $5, $6)`,
        [ws, id, kind, role, displayName, fixtureApiKeyHash(id)],
      ),
    );
    return id;
  }

  /** A session of `kind` acting for `principalId` with one Handle under it — seeded directly, as
   *  each kind's own issuer would leave it. */
  async function seedHandle(
    principalId: string,
    kind: SessionKind,
    options: {
      ws?: string;
      createdAt?: Date;
      expiresAt?: Date;
      revoked?: boolean;
      capabilities?: string[];
    } = {},
  ): Promise<{ jti: string; sessionId: string }> {
    const ws = options.ws ?? workspaceId;
    const sessionId = randomUUID();
    const jti = randomUUID();
    await asAdmin(ws, async (client) => {
      await client.query(
        `insert into sessions (workspace_id, id, principal_id, kind, on_behalf_of, status)
         values ($1, $2, $3, $4, $3, 'active')`,
        [ws, sessionId, principalId, kind],
      );
      await client.query(
        `insert into capability_handles
           (workspace_id, jti, session_id, on_behalf_of, scope, expires_at, created_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ws,
          jti,
          sessionId,
          principalId,
          JSON.stringify({ capabilities: options.capabilities ?? ['search'], resources: {} }),
          options.expiresAt ?? new Date(Date.now() + 3_600_000),
          options.createdAt ?? new Date(),
          options.revoked ? new Date() : null,
        ],
      );
    });
    return { jti, sessionId };
  }

  async function list(
    principalId: string,
    role: Role,
    params: Record<string, unknown> = {},
  ): Promise<Page> {
    return (await dispatchCapability(
      { pool },
      humanCaller(workspaceId, principalId, role),
      'list_handles',
      params,
    )) as Page;
  }

  async function revoke(principalId: string, role: Role, jti: string): Promise<unknown> {
    return dispatchCapability(
      { pool },
      humanCaller(workspaceId, principalId, role),
      'revoke_handle',
      { jti },
    );
  }

  async function sessionStatus(sessionId: string): Promise<string | undefined> {
    const result = await asAdmin(workspaceId, (client) =>
      client.query<{ status: string }>('select status from sessions where id = $1', [sessionId]),
    );
    return result.rows[0]?.status;
  }

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool, MIGRATIONS_DIR);
    const { privateKey, publicKey } = await generateKeyPair(HANDLE_SIGNING_ALG, {
      crv: 'Ed25519',
      extractable: true,
    });
    handlePublicKey = publicKey;
    configureTaskRuntime({ pool, privateKey, supervisorClient: new UnusedSupervisorClient() });

    workspaceId = await insertWorkspace(`handles-${randomUUID().slice(0, 8)}`);
    otherWorkspaceId = await insertWorkspace(`handles-other-${randomUUID().slice(0, 8)}`);
    ownerId = await insertPrincipal(workspaceId, 'human', 'owner', 'handles owner');
    memberId = await insertPrincipal(workspaceId, 'human', 'member', 'handles member');
    auditorId = await insertPrincipal(workspaceId, 'human', 'auditor', 'handles auditor');
    serviceId = await insertPrincipal(workspaceId, 'service', 'member', 'handles service');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('a member sees the live Handles acting for them, of every kind, and nobody else’s', async () => {
    const mcp = await seedHandle(memberId, 'mcp_session', { capabilities: ['search', 'explain'] });
    const entry = await seedHandle(memberId, 'entry');
    const worker = await seedHandle(memberId, 'worker_run');
    const revoked = await seedHandle(memberId, 'mcp_session', { revoked: true });
    const expired = await seedHandle(memberId, 'mcp_session', {
      createdAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const owners = await seedHandle(ownerId, 'mcp_session');
    const services = await seedHandle(serviceId, 'service');

    const { items } = await list(memberId, 'member');
    const jtis = items.map((item) => item.jti);
    expect(jtis).toEqual(expect.arrayContaining([mcp.jti, entry.jti, worker.jti]));
    for (const hidden of [revoked, expired, owners, services]) {
      expect(jtis).not.toContain(hidden.jti);
    }
    expect(items.every((item) => item.onBehalfOf === memberId)).toBe(true);

    expect(items.find((item) => item.jti === mcp.jti)).toEqual({
      jti: mcp.jti,
      sessionId: mcp.sessionId,
      sessionKind: 'mcp_session',
      holder: 'bearer',
      onBehalfOf: memberId,
      onBehalfOfKind: 'human',
      onBehalfOfName: 'handles member',
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
      capabilities: ['search', 'explain'],
      revocable: true,
    });
    expect(items.find((item) => item.jti === entry.jti)).toMatchObject({
      holder: 'container',
      revocable: false,
    });
    expect(items.find((item) => item.jti === worker.jti)).toMatchObject({
      sessionKind: 'worker_run',
      holder: 'container',
      revocable: false,
    });
  });

  it('an owner also sees the service Principals’ Handles — never another member’s', async () => {
    const own = await seedHandle(ownerId, 'mcp_session');
    const services = await seedHandle(serviceId, 'service');
    const members = await seedHandle(memberId, 'mcp_session');
    const elsewhere = await seedHandle(
      await insertPrincipal(otherWorkspaceId, 'service', 'member', 'elsewhere'),
      'service',
      { ws: otherWorkspaceId },
    );

    const { items } = await list(ownerId, 'owner');
    const jtis = items.map((item) => item.jti);
    expect(jtis).toEqual(expect.arrayContaining([own.jti, services.jti]));
    expect(jtis).not.toContain(members.jti);
    expect(jtis).not.toContain(elsewhere.jti);
    expect(items.find((item) => item.jti === services.jti)).toMatchObject({
      sessionKind: 'service',
      holder: 'bearer',
      onBehalfOf: serviceId,
      onBehalfOfKind: 'service',
      revocable: true,
    });

    // The member, on the other hand, never sees the service Principal's.
    expect((await list(memberId, 'member')).items.map((item) => item.jti)).not.toContain(
      services.jti,
    );
  });

  it('an owner neither sees nor ends the platform’s internal service Principals’ Handles', async () => {
    // Named the way the platform names its own (members-handlers.ts `isInternalPrincipalDisplayName`).
    const internalId = await insertPrincipal(
      workspaceId,
      'service',
      'member',
      '__handles_internal_service__',
    );
    const heldByPlatform = await seedHandle(internalId, 'worker_run');
    const bearer = await seedHandle(internalId, 'service');
    // A workspace service Principal whose name only looks a little like one stays listed.
    const lookalikeId = await insertPrincipal(workspaceId, 'service', 'member', '__lookalike');
    const lookalike = await seedHandle(lookalikeId, 'service');

    const { items } = await list(ownerId, 'owner');
    const jtis = items.map((item) => item.jti);
    expect(jtis).not.toContain(heldByPlatform.jti);
    expect(jtis).not.toContain(bearer.jti);
    expect(jtis).toContain(lookalike.jti);
    expect(items.some((item) => item.onBehalfOf === internalId)).toBe(false);
    expect(items.some((item) => /^__.+__$/.test(item.onBehalfOfName ?? ''))).toBe(false);

    for (const hidden of [heldByPlatform, bearer]) {
      await expect(revoke(ownerId, 'owner', hidden.jti)).rejects.toMatchObject({
        code: 'handle_not_found',
        status: 404,
      });
      expect(await sessionStatus(hidden.sessionId)).toBe('active');
    }
  });

  it('pages newest first; a cursor that does not decode reads from the start', async () => {
    const principal = await insertPrincipal(workspaceId, 'human', 'member', 'pager');
    const base = Date.now() - 60_000;
    const seeded = [];
    for (let i = 0; i < 3; i += 1) {
      seeded.push(await seedHandle(principal, 'mcp_session', { createdAt: new Date(base + i) }));
    }
    const newestFirst = seeded.map((handle) => handle.jti).reverse();

    const walked: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(principal, 'member', { limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(1);
      walked.push(...page.items.map((item) => item.jti));
      cursor = page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(newestFirst);

    const fromStart = await list(principal, 'member', { limit: 1, cursor: 'not-a-cursor' });
    expect(fromStart.items.map((item) => item.jti)).toEqual([newestFirst[0]]);
  });

  it('a limit over 500 reads 500 and says it was cut (truncated); the rest is on the next page', async () => {
    // Legacy 897 (#493's P13 on #1539): 501 live Handles — one session's, its attenuated children.
    const principal = await insertPrincipal(workspaceId, 'human', 'member', 'capped');
    const root = await seedHandle(principal, 'mcp_session');
    await asAdmin(workspaceId, (client) =>
      client.query(
        `insert into capability_handles
           (workspace_id, jti, session_id, on_behalf_of, scope, expires_at, parent_jti)
         select $1, gen_random_uuid(), $2, $3, $4, now() + interval '30 minutes', $5
           from generate_series(1, 500)`,
        [
          workspaceId,
          root.sessionId,
          principal,
          JSON.stringify({ capabilities: ['search'], resources: {} }),
          root.jti,
        ],
      ),
    );

    const capped = await list(principal, 'member', { limit: 501 });
    expect(capped.items).toHaveLength(500);
    expect(capped.truncated).toBe(true);
    expect(capped.nextCursor).toBeDefined();
    const rest = await list(principal, 'member', { limit: 501, cursor: capped.nextCursor });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    expect(new Set([...capped.items, ...rest.items].map((item) => item.jti)).size).toBe(501);

    // At the cap, nothing is cut.
    const atCap = await list(principal, 'member', { limit: 500 });
    expect(atCap.items).toHaveLength(500);
    expect(atCap.truncated).toBeUndefined();
  });

  it('a member ends their own MCP session: its session is revoked with every Handle under it, audited; a second call finds nothing', async () => {
    const own = await seedHandle(memberId, 'mcp_session');
    // A second Handle under the same session (an attenuated child) ends with it.
    const sibling = randomUUID();
    await asAdmin(workspaceId, (client) =>
      client.query(
        `insert into capability_handles
           (workspace_id, jti, session_id, on_behalf_of, scope, expires_at, parent_jti)
         values ($1, $2, $3, $4, $5, now() + interval '30 minutes', $6)`,
        [
          workspaceId,
          sibling,
          own.sessionId,
          memberId,
          JSON.stringify({ capabilities: ['search'], resources: {} }),
          own.jti,
        ],
      ),
    );

    expect(await revoke(memberId, 'member', own.jti)).toEqual({
      jti: own.jti,
      sessionId: own.sessionId,
      sessionKind: 'mcp_session',
      revokedHandleCount: 2,
    });
    expect(await sessionStatus(own.sessionId)).toBe('revoked');
    const live = await asAdmin(workspaceId, (client) =>
      client.query(
        'select jti from capability_handles where session_id = $1 and revoked_at is null',
        [own.sessionId],
      ),
    );
    expect(live.rows).toEqual([]);
    const listed = (await list(memberId, 'member')).items.map((item) => item.jti);
    expect(listed).not.toContain(own.jti);
    expect(listed).not.toContain(sibling);

    const audit = await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
      queryAudit(client, workspaceId, { action: 'revoke_handle', resourceId: own.sessionId }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorPrincipalId).toBe(memberId);
    expect(audit[0]?.payload).toMatchObject({
      sessionKind: 'mcp_session',
      onBehalfOf: memberId,
      revokedHandleCount: 2,
    });

    await expect(revoke(memberId, 'member', own.jti)).rejects.toMatchObject({
      code: 'handle_not_found',
      status: 404,
    });
  });

  it('two revocations of one Handle at once: one ends it, the other finds nothing — one audit row', async () => {
    // A double click on the console's revoke button: both calls see the live Handle; the one that
    // takes the session row second finds it revoked. The row is held here until both are waiting
    // on it, so the two always race (otherwise the second may simply start after the first ended).
    const own = await seedHandle(memberId, 'mcp_session');
    let both: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await asAdmin(workspaceId, async (client) => {
      await client.query('select 1 from sessions where id = $1 for no key update', [own.sessionId]);
      const holder = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      both = Promise.allSettled([
        revoke(memberId, 'member', own.jti),
        revoke(memberId, 'member', own.jti),
      ]);
      await vi.waitFor(
        async () => {
          // Waiting on this transaction, or queued behind a call that is (a row lock's second
          // waiter waits on the first).
          const waiting = await pool.query<{ n: string }>(
            `with recursive waiting(pid) as (
               select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
               union
               select a.pid from pg_stat_activity a
                 join waiting w on w.pid = any(pg_blocking_pids(a.pid))
             )
             select count(*)::text as n from waiting`,
            [holder],
          );
          expect(waiting.rows[0]?.n).toBe('2');
        },
        { timeout: 10_000, interval: 20 },
      );
    });
    const outcomes = await (both as Promise<PromiseSettledResult<unknown>[]>);

    const ended = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.value).toEqual({
      jti: own.jti,
      sessionId: own.sessionId,
      sessionKind: 'mcp_session',
      revokedHandleCount: 1,
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(HandleRevokeError);
    expect(refused[0]?.reason).toMatchObject({ code: 'handle_not_found', status: 404 });
    expect(await sessionStatus(own.sessionId)).toBe('revoked');

    const audit = await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
      queryAudit(client, workspaceId, { action: 'revoke_handle', resourceId: own.sessionId }),
    );
    expect(audit).toHaveLength(1);
  });

  it('a Handle issued under the session while the revocation starts is counted with the Handles it ends — in the result and the audit row', async () => {
    // Legacy 897 (#493's P11b on #1539). Issuing a Handle holds its session row `for share` until
    // it commits (governance 0042, part 3). The revocation takes that row (`lockSessions`) before
    // it counts, so it waits for the issuer and counts the new child, which 0042's trigger then
    // revokes with the session. Counting before the lock would read one Handle fewer than ended —
    // the audit row would under-report what the revocation did.
    const own = await seedHandle(memberId, 'mcp_session');
    const child = randomUUID();
    let revoking: Promise<PromiseSettledResult<unknown>[]> | undefined;
    await asAdmin(workspaceId, async (client) => {
      await client.query(
        `insert into capability_handles
           (workspace_id, jti, session_id, on_behalf_of, scope, expires_at, parent_jti)
         values ($1, $2, $3, $4, $5, now() + interval '30 minutes', $6)`,
        [
          workspaceId,
          child,
          own.sessionId,
          memberId,
          JSON.stringify({ capabilities: ['search'], resources: {} }),
          own.jti,
        ],
      );
      const issuer = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]
        ?.pid;
      revoking = Promise.allSettled([revoke(memberId, 'member', own.jti)]);
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ n: string }>(
            'select count(*)::text as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
            [issuer],
          );
          expect(waiting.rows[0]?.n).toBe('1');
        },
        { timeout: 10_000, interval: 20 },
      );
    });
    const [outcome] = await (revoking as Promise<PromiseSettledResult<unknown>[]>);

    expect(outcome).toEqual({
      status: 'fulfilled',
      value: {
        jti: own.jti,
        sessionId: own.sessionId,
        sessionKind: 'mcp_session',
        revokedHandleCount: 2,
      },
    });
    const live = await asAdmin(workspaceId, (client) =>
      client.query(
        'select jti from capability_handles where session_id = $1 and revoked_at is null',
        [own.sessionId],
      ),
    );
    expect(live.rows).toEqual([]);
    const audit = await withWorkspace(pool, { workspaceId, principalId: memberId }, (client) =>
      queryAudit(client, workspaceId, { action: 'revoke_handle', resourceId: own.sessionId }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({ revokedHandleCount: 2 });
  });

  it('a container-held Handle is refused (409 handle_container_held) and nothing changes', async () => {
    for (const kind of ['entry', 'worker_run', 'admin_agent'] as const) {
      const held = await seedHandle(ownerId, kind);
      await expect(revoke(ownerId, 'owner', held.jti)).rejects.toMatchObject({
        code: 'handle_container_held',
        status: 409,
      });
      expect(await sessionStatus(held.sessionId)).toBe('active');
    }
  });

  it('a Handle the caller cannot see is not found: another member’s, a service Principal’s for a member, another workspace’s', async () => {
    const owners = await seedHandle(ownerId, 'mcp_session');
    const services = await seedHandle(serviceId, 'service');
    const elsewhere = await seedHandle(
      await insertPrincipal(otherWorkspaceId, 'human', 'owner', 'elsewhere owner'),
      'mcp_session',
      { ws: otherWorkspaceId },
    );
    for (const hidden of [owners, services, elsewhere]) {
      const refusal = await revoke(memberId, 'member', hidden.jti).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(HandleRevokeError);
      expect(refusal).toMatchObject({ code: 'handle_not_found' });
    }
    expect(await sessionStatus(owners.sessionId)).toBe('active');
    expect(await sessionStatus(services.sessionId)).toBe('active');
  });

  it('an owner ends a service Principal’s Handle issued on the page, and it no longer authenticates', async () => {
    const issued = (await dispatchCapability(
      { pool },
      humanCaller(workspaceId, ownerId, 'owner'),
      'issue_service_handle',
      { principalId: serviceId, scope: ['search'] },
    )) as { handle: string; sessionId: string };
    const claims = await authenticateHandle(pool, issued.handle, { publicKey: handlePublicKey });
    expect(claims.obo).toBe(serviceId);

    const listed = (await list(ownerId, 'owner')).items.find(
      (item) => item.sessionId === issued.sessionId,
    );
    expect(listed).toMatchObject({ jti: claims.jti, holder: 'bearer', revocable: true });

    await expect(revoke(ownerId, 'owner', claims.jti)).resolves.toMatchObject({
      sessionId: issued.sessionId,
      sessionKind: 'service',
      revokedHandleCount: 1,
    });
    await expect(
      authenticateHandle(pool, issued.handle, { publicKey: handlePublicKey }),
    ).rejects.toThrow(HandleRevoked);
  });

  it('an auditor lists its own Handles but cannot revoke one', async () => {
    const own = await seedHandle(auditorId, 'entry');
    expect((await list(auditorId, 'auditor')).items.map((item) => item.jti)).toEqual([own.jti]);
    await expect(revoke(auditorId, 'auditor', own.jti)).rejects.toThrow(ForbiddenError);
  });
});
