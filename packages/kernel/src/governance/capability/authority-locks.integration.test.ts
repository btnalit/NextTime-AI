import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope, Role } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { withPlatform } from '../../adapters/db/platform-context.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import {
  disablePrincipalHandler,
  setPrincipalRoleHandler,
} from '../../application/gateway/members-handlers.js';
import {
  mergeUserHandler,
  setWorkspaceStatusHandler,
} from '../../application/gateway/platform-handlers.js';
import { revokeUserCredentials } from '../../application/identity/credentials.js';
import { runInvariantChecks } from '../../substrate/audit/invariant-checks.js';
import {
  HandleIssuanceError,
  type IssuanceBasis,
  type IssuedHandle,
  issueHandle,
  lockIssuingAuthority,
  revokeGateGrantScopedSessionHandles,
} from './handles.js';
import { generateEphemeralHandleKeyPair } from './keys.js';

/**
 * governance/capability/authority-locks.integration.test (legacy 702; I-H2: a disabled workspace,
 * user or Principal has no valid Handle acting for it). Issuing and changing an authority serialise
 * on governance 0043's advisory locks: whichever comes second waits, and either the issuer refuses
 * on its re-read or the change revokes what the issuer committed. Every concurrent case runs on two
 * connections and really blocks (`waitUntilBlocked`). Kernel writers run through their handlers —
 * which take the locks before any row — and hand-written SQL through 0043's triggers alone.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0043 = path.join(MIGRATIONS_DIR, 'governance', '0043_authority_locks.sql');

const SCOPE: CapabilityScope = { capabilities: ['search'], resources: {} };

type SessionKind = 'entry' | 'worker_run' | 'mcp_session';

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly role: Role;
}

describe.runIf(DATABASE_URL !== undefined)(
  'governance/capability — issuing and changing an authority serialise; a disabled authority has no valid Handle (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;

    /** As the table owner (no RLS): fixtures, and SQL "written by hand" outside the kernel. */
    const asOwner = <T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: randomUUID() }, fn, { skipRoleSwitch: true });
    /** As the kernel runs a workspace call: `nexttime_app`, RLS on. */
    const asApp = <T>(at: Member, fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId: at.workspaceId, principalId: at.principalId }, fn);
    /** As the kernel runs a platform call: `nexttime_app`, `app.platform = on`. */
    const asPlatform = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withPlatform(pool, { userId: randomUUID() }, fn);

    async function workspace(): Promise<string> {
      const id = randomUUID();
      await asOwner(id, (client) =>
        client.query('insert into workspaces (id, name) values ($1, $2)', [
          id,
          `authority-locks-${id}`,
        ]),
      );
      return id;
    }

    async function user(platformRole: 'admin' | 'user' = 'user'): Promise<string> {
      const result = await asOwner(randomUUID(), (client) =>
        client.query<{ id: string }>(
          `insert into users (login, display_name, platform_role)
           values ($1, 'Authority Fixture', $2) returning id`,
          [`authority-locks-${randomUUID()}`, platformRole],
        ),
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('user: no row');
      return id;
    }

    async function member(
      options: { role?: Role; workspaceId?: string; userId?: string } = {},
    ): Promise<Member> {
      const workspaceId = options.workspaceId ?? (await workspace());
      const userId = options.userId ?? (await user());
      const role = options.role ?? 'builder';
      const principalId = randomUUID();
      await asOwner(workspaceId, (client) =>
        client.query(
          `insert into principals (workspace_id, id, kind, role, display_name, user_id)
           values ($1, $2, 'human', $3, 'Authority Fixture', $4)`,
          [workspaceId, principalId, role, userId],
        ),
      );
      return { workspaceId, principalId, userId, role };
    }

    async function openSession(at: Member, kind: SessionKind = 'mcp_session'): Promise<string> {
      return asApp(at, async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, 'active') returning id`,
          [at.workspaceId, at.principalId, kind],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('openSession: no row');
        return id;
      });
    }

    function issue(
      client: PoolClient,
      at: Member,
      sessionId: string,
      basis: IssuanceBasis = { kind: 'role', role: at.role },
    ): Promise<IssuedHandle> {
      return issueHandle(client, { sessionId, scope: SCOPE, ttlSeconds: 3600, privateKey, basis });
    }

    async function handleState(at: Member, jti: string): Promise<'valid' | 'revoked' | 'expired'> {
      const result = await asOwner(at.workspaceId, (client) =>
        client.query<{ revoked: boolean; expired: boolean }>(
          `select revoked_at is not null as revoked, expires_at <= now() as expired
             from capability_handles where workspace_id = $1 and jti = $2`,
          [at.workspaceId, jti],
        ),
      );
      const row = result.rows[0];
      if (!row) throw new Error(`no Handle ${jti}`);
      if (row.revoked) return 'revoked';
      return row.expired ? 'expired' : 'valid';
    }

    async function refusal(call: () => Promise<unknown>): Promise<unknown> {
      return call().then(
        () => {
          throw new Error('expected the call to be refused, but it resolved');
        },
        (err: unknown) => err,
      );
    }

    function refusalCode(thrown: unknown): string | undefined {
      expect(thrown).toBeInstanceOf(HandleIssuanceError);
      return (thrown as HandleIssuanceError).code;
    }

    /** Polls until a backend of this database waits on a lock while running a statement that
     *  contains `fragment`. */
    async function waitUntilBlocked(fragment: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await pool.query<{ waiting: number }>(
          `select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and position($1 in query) > 0`,
          [fragment],
        );
        if ((rows[0]?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no statement containing "${fragment}" ever waited on a lock`);
    }

    /** A gate the test opens by hand. */
    function latch(): { readonly wait: Promise<void>; readonly open: () => void } {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    }

    /** Issues on `sessionId` in a transaction that stays open until the returned `commit` is
     *  called — the issuer holding its shared locks. */
    async function issuerHolding(
      at: Member,
      sessionId: string,
    ): Promise<{ readonly handle: IssuedHandle; readonly commit: () => Promise<void> }> {
      const issued = latch();
      const release = latch();
      let handle: IssuedHandle | undefined;
      const transaction = asApp(at, async (client) => {
        handle = await issue(client, at, sessionId);
        issued.open();
        await release.wait;
      });
      await Promise.race([issued.wait, transaction]);
      if (!handle) throw new Error('issuerHolding: no Handle issued');
      return {
        handle,
        commit: async () => {
          release.open();
          await transaction;
        },
      };
    }

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      privateKey = (await generateEphemeralHandleKeyPair()).privateKey;
    });

    afterAll(async () => {
      await pool.end();
    });

    describe('the issuer re-reads the authority it issues under', () => {
      it.each(['principal', 'user', 'workspace'] as const)(
        'refuses a Principal whose %s is disabled (acting_principal_disabled), on a session opened after the disable',
        async (what) => {
          const at = await member();
          await asOwner(at.workspaceId, async (client) => {
            if (what === 'principal') {
              await client.query(
                'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
                [at.workspaceId, at.principalId],
              );
            } else if (what === 'user') {
              await client.query(`update users set status = 'disabled' where id = $1`, [at.userId]);
            } else {
              await client.query(`update workspaces set status = 'disabled' where id = $1`, [
                at.workspaceId,
              ]);
            }
          });
          const sessionId = await openSession(at, 'worker_run');

          const thrown = await refusal(() => asApp(at, (client) => issue(client, at, sessionId)));
          expect(refusalCode(thrown)).toBe('acting_principal_disabled');
        },
      );

      it('refuses a role basis the Principal no longer holds (authority_changed)', async () => {
        const at = await member({ role: 'builder' });
        const sessionId = await openSession(at, 'worker_run');

        const thrown = await refusal(() =>
          asApp(at, (client) => issue(client, at, sessionId, { kind: 'role', role: 'owner' })),
        );
        expect(refusalCode(thrown)).toBe('authority_changed');

        const issued = await asApp(at, (client) => issue(client, at, sessionId));
        expect(await handleState(at, issued.jti)).toBe('valid');
      });

      it('refuses a parent basis whose parent was revoked, under a new session too (parent_revoked) — a role basis there is a crash retry and is issued', async () => {
        const at = await member();
        const parent = await asApp(at, async (client) => issue(client, at, await openSession(at)));
        await asOwner(at.workspaceId, (client) =>
          client.query('update capability_handles set revoked_at = now() where jti = $1', [
            parent.jti,
          ]),
        );
        const run = await openSession(at, 'worker_run');

        const thrown = await refusal(() =>
          asApp(at, (client) =>
            issueHandle(client, {
              sessionId: run,
              scope: SCOPE,
              // Shorter than the parent's, as a child's always is (0042's I13).
              ttlSeconds: 1800,
              privateKey,
              parentJti: parent.jti,
              basis: { kind: 'parent', parentJti: parent.jti },
            }),
          ),
        );
        expect(refusalCode(thrown)).toBe('parent_revoked');

        const retry = await asApp(at, (client) =>
          issueHandle(client, {
            sessionId: run,
            scope: SCOPE,
            ttlSeconds: 1800,
            privateKey,
            parentJti: parent.jti,
            basis: { kind: 'role', role: at.role },
          }),
        );
        expect(await handleState(at, retry.jti)).toBe('valid');
      });

      it('refuses to issue in a transaction above READ COMMITTED — a snapshot taken before the lock would hide a disable committed while it waited (#1152 review P3-1)', async () => {
        const at = await member();
        const sessionId = await openSession(at, 'worker_run');

        const client = await pool.connect();
        let thrown: unknown;
        try {
          await client.query('begin isolation level repeatable read');
          await client.query("select set_config('app.workspace_id', $1, true)", [at.workspaceId]);
          await client.query("select set_config('app.principal_id', $1, true)", [at.principalId]);
          await client.query('set local role nexttime_app');
          thrown = await refusal(() => issue(client, at, sessionId));
        } finally {
          await client.query('rollback');
          client.release();
        }
        expect(String((thrown as Error).message)).toMatch(/READ COMMITTED/);

        const { rows } = await asOwner(at.workspaceId, (owner) =>
          owner.query<{ n: number }>(
            'select count(*)::int as n from capability_handles where session_id = $1',
            [sessionId],
          ),
        );
        expect(rows[0]?.n).toBe(0);
      });
    });

    describe('a disable revokes the sessions acting for what it disabled, whoever writes it (0043 triggers)', () => {
      it('a Principal disabled by hand on the workspace plane', async () => {
        const at = await member();
        const colleague = await member({ workspaceId: at.workspaceId });
        const mine = await asApp(at, async (client) => issue(client, at, await openSession(at)));
        const theirs = await asApp(colleague, async (client) =>
          issue(client, colleague, await openSession(colleague)),
        );

        await asApp(at, (client) =>
          client.query(
            'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
            [at.workspaceId, at.principalId],
          ),
        );

        expect(await handleState(at, mine.jti)).toBe('revoked');
        expect(await handleState(colleague, theirs.jti)).toBe('valid');
      });

      it('a user disabled by hand on the platform plane: every membership, in every workspace', async () => {
        const at = await member();
        const elsewhere = await member({ userId: at.userId });
        const colleague = await member({ workspaceId: at.workspaceId });
        const here = await asApp(at, async (client) => issue(client, at, await openSession(at)));
        const there = await asApp(elsewhere, async (client) =>
          issue(client, elsewhere, await openSession(elsewhere, 'worker_run')),
        );
        const theirs = await asApp(colleague, async (client) =>
          issue(client, colleague, await openSession(colleague)),
        );

        await asPlatform((client) =>
          client.query(`update users set status = 'disabled' where id = $1`, [at.userId]),
        );

        expect(await handleState(at, here.jti)).toBe('revoked');
        expect(await handleState(elsewhere, there.jti)).toBe('revoked');
        expect(await handleState(colleague, theirs.jti)).toBe('valid');
      });

      it('a workspace disabled by hand on the platform plane: every session in it', async () => {
        const at = await member();
        const colleague = await member({ workspaceId: at.workspaceId });
        const other = await member();
        const mine = await asApp(at, async (client) => issue(client, at, await openSession(at)));
        const theirs = await asApp(colleague, async (client) =>
          issue(client, colleague, await openSession(colleague, 'worker_run')),
        );
        const outside = await asApp(other, async (client) =>
          issue(client, other, await openSession(other)),
        );

        await asPlatform((client) =>
          client.query(`update workspaces set status = 'disabled' where id = $1`, [at.workspaceId]),
        );

        expect(await handleState(at, mine.jti)).toBe('revoked');
        expect(await handleState(colleague, theirs.jti)).toBe('revoked');
        expect(await handleState(other, outside.jti)).toBe('valid');
      });
    });

    describe('issuing and changing an authority serialise on its lock', () => {
      it('a role change that comes first makes the issuer wait, and the issuer then refuses (authority_changed)', async () => {
        const at = await member({ role: 'builder' });
        // A Worker's session: the role change leaves it alone while it holds no Handle, so the
        // refusal is the issuer's own re-read and not a revoked session.
        const sessionId = await openSession(at, 'worker_run');
        const changed = latch();
        const commit = latch();
        const writer = asApp(at, async (client) => {
          await setPrincipalRoleHandler(client, at.workspaceId, {
            principalId: at.principalId,
            role: 'member',
          });
          changed.open();
          await commit.wait;
        });
        await changed.wait;

        const issuer = refusal(() => asApp(at, (client) => issue(client, at, sessionId)));
        await waitUntilBlocked('lock_issuing_authority');
        commit.open();
        await writer;

        expect(refusalCode(await issuer)).toBe('authority_changed');
      });

      it('an issuer that comes first makes set_principal_role wait, and the change then revokes the Handle it issued', async () => {
        const at = await member({ role: 'builder' });
        const holding = await issuerHolding(at, await openSession(at, 'mcp_session'));

        const writer = asApp(at, (client) =>
          setPrincipalRoleHandler(client, at.workspaceId, {
            principalId: at.principalId,
            role: 'member',
          }),
        );
        await waitUntilBlocked('lock_authorities');
        await holding.commit();
        await writer;

        expect(await handleState(at, holding.handle.jti)).toBe('revoked');
      });

      it('an issuer that comes first makes disable_principal wait, and the disable then revokes the Handle it issued', async () => {
        const at = await member();
        const owner = await member({ workspaceId: at.workspaceId, role: 'owner' });
        const holding = await issuerHolding(at, await openSession(at, 'worker_run'));

        const writer = asApp(owner, (client) =>
          disablePrincipalHandler(
            client,
            at.workspaceId,
            { principalId: at.principalId },
            { channel: 'human', principalId: owner.principalId },
          ),
        );
        await waitUntilBlocked('lock_authorities');
        await holding.commit();
        await writer;

        expect(await handleState(at, holding.handle.jti)).toBe('revoked');
      });

      it('a hand-written disable waits on its trigger’s lock, and the trigger then revokes the Handle', async () => {
        const at = await member();
        const holding = await issuerHolding(at, await openSession(at, 'entry'));

        const writer = asOwner(at.workspaceId, (client) =>
          client.query(
            'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
            [at.workspaceId, at.principalId],
          ),
        );
        await waitUntilBlocked('set disabled_at');
        await holding.commit();
        await writer;

        expect(await handleState(at, holding.handle.jti)).toBe('revoked');
      });

      // The triggers alone, with nothing else between the two transactions: the issuer holds only
      // its shared locks (it has read no session yet), and a change written by hand must wait.
      const handWritten: readonly {
        readonly change: string;
        readonly fragment: string;
        readonly write: (client: PoolClient, at: Member) => Promise<unknown>;
      }[] = [
        {
          change: 'a Principal’s role',
          fragment: 'set role',
          write: (client, at) =>
            client.query(
              `update principals set role = 'member' where workspace_id = $1 and id = $2`,
              [at.workspaceId, at.principalId],
            ),
        },
        {
          change: 'a Principal’s user',
          fragment: 'set user_id',
          write: async (client, at) => {
            const other = await user();
            return client.query(
              'update principals set user_id = $3 where workspace_id = $1 and id = $2',
              [at.workspaceId, at.principalId, other],
            );
          },
        },
        {
          change: 'a user’s status',
          fragment: 'set status',
          write: (client, at) =>
            client.query(`update users set status = 'disabled' where id = $1`, [at.userId]),
        },
        {
          change: 'a user’s platform role (what an admin agent’s Handle is issued under)',
          fragment: 'set platform_role',
          write: (client, at) =>
            client.query(`update users set platform_role = 'user' where id = $1`, [at.userId]),
        },
        {
          change: 'a workspace’s status',
          fragment: 'set status',
          write: (client, at) =>
            client.query(`update workspaces set status = 'disabled' where id = $1`, [
              at.workspaceId,
            ]),
        },
      ];

      it.each(handWritten)(
        '$change, written by hand, waits for an issuer’s shared locks',
        async ({ fragment, write }) => {
          const at = await member({ userId: await user('admin') });
          const locked = latch();
          const release = latch();
          const issuer = asApp(at, async (client) => {
            await lockIssuingAuthority(client, at.workspaceId, at.principalId);
            locked.open();
            await release.wait;
          });
          await locked.wait;
          let written = false;

          const writer = asOwner(at.workspaceId, (client) => write(client, at)).then(() => {
            written = true;
          });
          await waitUntilBlocked(fragment);
          expect(written).toBe(false);
          release.open();
          await issuer;
          await writer;
          expect(written).toBe(true);
        },
      );

      it('set_workspace_status waits for an issuer in that workspace — no deadlock — and revokes the Handle it issued', async () => {
        const at = await member();
        const holding = await issuerHolding(at, await openSession(at, 'worker_run'));

        const writer = asPlatform((client) =>
          setWorkspaceStatusHandler(client, at.workspaceId, {
            workspaceId: at.workspaceId,
            status: 'disabled',
          }),
        );
        await waitUntilBlocked('lock_authorities');
        await holding.commit();
        await expect(writer).resolves.toBeDefined();

        expect(await handleState(at, holding.handle.jti)).toBe('revoked');
      });

      it('merge_user that comes first: an issuer for a moved membership waits, re-reads the new user and refuses (authority_changed)', async () => {
        const at = await member();
        const target = await user();
        const sessionId = await openSession(at, 'worker_run');
        const merged = latch();
        const commit = latch();
        const writer = asPlatform(async (client) => {
          await mergeUserHandler(client, '', { sourceUserId: at.userId, targetUserId: target });
          merged.open();
          await commit.wait;
        });
        await merged.wait;

        const issuer = refusal(() => asApp(at, (client) => issue(client, at, sessionId)));
        await waitUntilBlocked('lock_issuing_authority');
        commit.open();
        await writer;

        expect(refusalCode(await issuer)).toBe('authority_changed');
      });
    });

    describe('the lock order: authority locks, then sessions by id, then Handles (#1150 review)', () => {
      // A bulk revocation (one statement over every session acting for a Principal or in a
      // workspace: governance 0043's triggers, a role change) and a per-session one (a gate Grant change revoking
      // the Principal's entry Handles, which takes no authority lock) on the same two sessions.
      // Their ids run against the order they are stored in, so a revoker that took rows in storage
      // order would meet them the other way round from one that takes them by id. A third
      // transaction holds one of the two first, so both revokers queue behind it and then race.
      // The bulk writer plans its scans as sequential ones (`scanInStorageOrder`): through the
      // primary key (workspace_id, id) the planner would meet one workspace's rows in id order by
      // chance, and a writer missing its `order by id` pre-lock would pass here and still deadlock
      // where the planner scans the table (#1152 review P2-1).
      async function scanInStorageOrder(client: PoolClient): Promise<void> {
        await client.query('set local enable_indexscan = off');
        await client.query('set local enable_bitmapscan = off');
      }
      const bulk: readonly {
        readonly writer: string;
        readonly fragment: string;
        readonly write: (at: Member, owner: Member) => Promise<unknown>;
      }[] = [
        {
          writer: 'disable_principal',
          fragment: 'set disabled_at',
          write: (at, owner) =>
            asApp(owner, async (client) => {
              await scanInStorageOrder(client);
              return disablePrincipalHandler(
                client,
                at.workspaceId,
                { principalId: at.principalId },
                { channel: 'human', principalId: owner.principalId },
              );
            }),
        },
        {
          writer: 'set_principal_role',
          fragment: 'and on_behalf_of = $2',
          write: (at) =>
            asApp(at, async (client) => {
              await scanInStorageOrder(client);
              return setPrincipalRoleHandler(client, at.workspaceId, {
                principalId: at.principalId,
                role: 'member',
              });
            }),
        },
        {
          writer: 'set_workspace_status',
          fragment: 'update workspaces',
          write: (at) =>
            asPlatform(async (client) => {
              await scanInStorageOrder(client);
              return setWorkspaceStatusHandler(client, at.workspaceId, {
                workspaceId: at.workspaceId,
                status: 'disabled',
              });
            }),
        },
        // #1152 review P2-1: the users trigger's own pre-lock, and revokeUserCredentials'.
        {
          writer: 'a user disabled by hand (users trigger)',
          fragment: "set status = 'disabled'",
          write: (at) =>
            asOwner(at.workspaceId, async (client) => {
              await scanInStorageOrder(client);
              return client.query(`update users set status = 'disabled' where id = $1`, [
                at.userId,
              ]);
            }),
        },
        {
          writer: 'revokeUserCredentials (platform plane)',
          // In its pre-lock, and in the per-Principal UPDATE a writer without one would block on.
          fragment: 'on_behalf_of = ',
          write: (at) =>
            asPlatform(async (client) => {
              await scanInStorageOrder(client);
              return revokeUserCredentials(client, at.userId);
            }),
        },
      ];
      const cases = bulk.flatMap((b) =>
        (['lower', 'higher'] as const).map((held) => ({ ...b, held })),
      );

      it.each(cases)(
        '$writer and a gate Grant change on the same sessions both complete, the $held id held first — no deadlock (40P01)',
        async ({ fragment, write, held }) => {
          const at = await member();
          const owner = await member({ workspaceId: at.workspaceId, role: 'owner' });
          const [low, high] = [randomUUID(), randomUUID()].sort() as [string, string];
          // One statement, so both rows go to the same page in that order (two transactions may
          // land on different pages through the free-space map, and a revoker that scans would
          // meet them in id order after all — the deadlock this guards against then never forms).
          await asApp(at, (client) =>
            client.query(
              `insert into sessions (id, workspace_id, principal_id, kind, on_behalf_of, status)
               values ($1, $3, $4, 'entry', $4, 'active'), ($2, $3, $4, 'entry', $4, 'active')`,
              [high, low, at.workspaceId, at.principalId],
            ),
          );
          const stored = await asOwner(at.workspaceId, (client) =>
            client.query<{ id: string }>(
              'select id from sessions where id = any($1::uuid[]) order by ctid',
              [[low, high]],
            ),
          );
          expect(stored.rows.map((row) => row.id)).toEqual([high, low]);
          const handles = [
            await asApp(at, (client) => issue(client, at, low)),
            await asApp(at, (client) => issue(client, at, high)),
          ];

          const locked = latch();
          const release = latch();
          const blocker = asOwner(at.workspaceId, async (client) => {
            await client.query('select 1 from sessions where id = $1 for share', [
              held === 'lower' ? low : high,
            ]);
            locked.open();
            await release.wait;
          });
          await locked.wait;

          const perSession = asApp(owner, (client) =>
            revokeGateGrantScopedSessionHandles(client, at.workspaceId, at.principalId),
          );
          await waitUntilBlocked('order by id for no key update');
          const bulkWrite = write(at, owner);
          await waitUntilBlocked(fragment);
          release.open();
          await blocker;

          const outcomes = await Promise.allSettled([perSession, bulkWrite]);
          expect(
            outcomes.map((outcome) =>
              outcome.status === 'fulfilled'
                ? 'completed'
                : `failed: ${(outcome.reason as { code?: string }).code ?? String(outcome.reason)}`,
            ),
          ).toEqual(['completed', 'completed']);
          for (const handle of handles) expect(await handleState(at, handle.jti)).toBe('revoked');
          const sessions = await asOwner(at.workspaceId, (client) =>
            client.query<{ status: string }>(
              'select status from sessions where id = any($1::uuid[])',
              [[low, high]],
            ),
          );
          expect(sessions.rows.map((row) => row.status)).toEqual(['revoked', 'revoked']);
        },
      );
    });

    describe('Handles left valid under an authority disabled before this release', () => {
      // 0043's remediation statements, run on this test's workspaces only.
      const migration = readFileSync(MIGRATION_0043, 'utf8');
      const audit = /^insert into audit_records[\s\S]*?;$/m.exec(migration)?.[0];
      const revoke = /^update sessions s\n[\s\S]*?;$/m.exec(migration)?.[0];

      function scoped(statement: string, anchor: string, column: string): string {
        const narrowed = statement.replace(
          anchor,
          anchor.replace('where ', `where ${column} = any($1::uuid[]) and `),
        );
        if (narrowed === statement) throw new Error(`scoped: "${anchor}" not found`);
        return narrowed;
      }

      it('I-H2 reports each, and the remediation revokes them with one audit record per Principal', async () => {
        expect(audit).toBeDefined();
        expect(revoke).toBeDefined();
        const disabled = {
          principal: await member(),
          user: await member(),
          workspace: await member(),
        };
        const handles = new Map<keyof typeof disabled, IssuedHandle>();
        for (const [what, at] of Object.entries(disabled) as [keyof typeof disabled, Member][]) {
          handles.set(
            what,
            await asApp(at, async (client) => issue(client, at, await openSession(at))),
          );
        }
        // Disabled the way a release before 0043 could leave it: with no trigger.
        const workspaceIds = Object.values(disabled).map((at) => at.workspaceId);
        await asOwner(disabled.principal.workspaceId, async (client) => {
          await client.query('set local session_replication_role = replica');
          await client.query(
            'update principals set disabled_at = now() where workspace_id = $1 and id = $2',
            [disabled.principal.workspaceId, disabled.principal.principalId],
          );
          await client.query(`update users set status = 'disabled' where id = $1`, [
            disabled.user.userId,
          ]);
          await client.query(`update workspaces set status = 'disabled' where id = $1`, [
            disabled.workspace.workspaceId,
          ]);
        });
        for (const [what, at] of Object.entries(disabled) as [keyof typeof disabled, Member][]) {
          expect(await handleState(at, handles.get(what)?.jti ?? '')).toBe('valid');
        }

        const expected = (Object.entries(disabled) as [keyof typeof disabled, Member][]).map(
          ([what, at]) => `${at.workspaceId}:${handles.get(what)?.jti} (${what} disabled)`,
        );
        const before = await runInvariantChecks(pool);
        const ih2 = before.find((result) => result.invariant === 'I-H2');
        expect(ih2?.violations ?? 0).toBeGreaterThanOrEqual(3);
        expect(ih2?.sample).toEqual(expect.arrayContaining(expected));

        await asOwner(disabled.principal.workspaceId, async (client) => {
          await client.query(
            scoped(audit as string, 'where (p.disabled_at is not null', 'h.workspace_id'),
            [workspaceIds],
          );
          await client.query(
            scoped(revoke as string, 'where s.workspace_id = p.workspace_id', 's.workspace_id'),
            [workspaceIds],
          );
        });

        for (const [what, at] of Object.entries(disabled) as [keyof typeof disabled, Member][]) {
          expect(await handleState(at, handles.get(what)?.jti ?? '')).toBe('revoked');
          const records = await asOwner(at.workspaceId, (client) =>
            client.query<{ actor: string; resource_id: string; payload: Record<string, unknown> }>(
              `select actor_principal_id as actor, resource_id, payload from audit_records
                where workspace_id = $1 and action = 'principal.disabled_authority_handles_revoked'`,
              [at.workspaceId],
            ),
          );
          expect(records.rows).toHaveLength(1);
          expect(records.rows[0]).toMatchObject({
            actor: at.principalId,
            resource_id: at.principalId,
          });
          expect(records.rows[0]?.payload).toMatchObject({
            by: 'migration governance/0043_authority_locks',
            revokedHandleCount: 1,
          });
        }

        const after = await runInvariantChecks(pool);
        const remaining = after.find((result) => result.invariant === 'I-H2')?.sample ?? [];
        for (const line of expected) expect(remaining).not.toContain(line);
      });
    });
  },
);
