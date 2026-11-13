import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityScope } from '@nexttime/shared';
import type { CryptoKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../adapters/db/migrate.js';
import { createPool, withWorkspace } from '../../adapters/db/pool.js';
import { authenticateHandle } from '../../application/gateway/handle-auth.js';
import { runInvariantChecks } from '../../substrate/audit/invariant-checks.js';
import {
  HandleIssuanceError,
  type IssuanceBasis,
  type IssuedHandle,
  issueHandle,
  revokeHandle,
  revokeSession,
} from './handles.js';
import { generateEphemeralHandleKeyPair } from './keys.js';

/**
 * governance/capability/session-revocation.integration.test (legacy 699 and 707; I-H1: a revoked
 * session has no valid Handle). Every write here runs as the kernel does, through `withWorkspace`
 * (`set local role nexttime_app`): a test that connects as the table owner bypasses row level
 * security and cannot see the bug this closes (a trigger that, run as the caller, reaches no row).
 * The platform-plane caller is covered by platform-workspaces.integration.test.ts
 * (`set_workspace_status`) and platform-capabilities.integration.test.ts (`set_membership_role`).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = path.join(KERNEL_ROOT, 'migrations');
const MIGRATION_0042 = path.join(
  MIGRATIONS_DIR,
  'governance',
  '0042_session_revocation_revokes_handles.sql',
);

const SCOPE: CapabilityScope = { capabilities: ['search'], resources: {} };

type SessionKind = 'entry' | 'worker_run' | 'mcp_session';

describe.runIf(DATABASE_URL !== undefined)(
  'governance/capability — a revoked session has no valid Handle (integration, real Postgres)',
  () => {
    let pool: Pool;
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let workspaceId: string;
    let personId: string;

    const asApp = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: personId }, fn);
    const asOwner = <T>(fn: (client: PoolClient) => Promise<T>) =>
      withWorkspace(pool, { workspaceId, principalId: personId }, fn, { skipRoleSwitch: true });

    async function openSession(kind: SessionKind, status = 'active'): Promise<string> {
      return asApp(async (client) => {
        const result = await client.query<{ id: string }>(
          `insert into sessions (workspace_id, principal_id, kind, on_behalf_of, status)
           values ($1, $2, $3, $2, $4) returning id`,
          [workspaceId, personId, kind, status],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('openSession: no row');
        return id;
      });
    }

    /** Issued on the person's role (the fixture's owner) unless `basis` says otherwise: a child
     *  names its parent as `parentJti`, and as its basis only when it is issued on that parent's
     *  authority (legacy 702). */
    function issue(
      client: PoolClient,
      sessionId: string,
      parentJti?: string,
      basis: IssuanceBasis = { kind: 'role', role: 'owner' },
    ): Promise<IssuedHandle> {
      return issueHandle(client, {
        sessionId,
        scope: SCOPE,
        ttlSeconds: 3600,
        privateKey,
        ...(parentJti !== undefined ? { parentJti } : {}),
        basis,
      });
    }

    async function handleState(jti: string): Promise<'valid' | 'revoked' | 'expired'> {
      const result = await asOwner((client) =>
        client.query<{ revoked: boolean; expired: boolean }>(
          `select revoked_at is not null as revoked, expires_at <= now() as expired
             from capability_handles where jti = $1`,
          [jti],
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

    /** A raw insert the way `issueHandle` writes one — what the DB trigger alone decides. */
    function rawInsert(client: PoolClient, sessionId: string, parentJti: string | null) {
      return client.query(
        `insert into capability_handles
           (workspace_id, jti, session_id, on_behalf_of, parent_jti, scope, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
        [workspaceId, randomUUID(), sessionId, personId, parentJti, JSON.stringify(SCOPE)],
      );
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

    beforeAll(async () => {
      pool = createPool();
      await runMigrations(pool, MIGRATIONS_DIR);
      const pair = await generateEphemeralHandleKeyPair();
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;

      workspaceId = randomUUID();
      personId = randomUUID();
      await asOwner(async (client) => {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [
          workspaceId,
          'session-revocation-test-workspace',
        ]);
        await client.query(
          `insert into principals (workspace_id, id, kind, role, display_name)
           values ($1, $2, 'human', 'owner', 'Revocation Fixture')`,
          [workspaceId, personId],
        );
      });
    });

    afterAll(async () => {
      await pool.end();
    });

    it('a session marked revoked revokes its valid Handles, leaves an expired one as it is and touches no other session', async () => {
      const ending = await openSession('mcp_session');
      const other = await openSession('mcp_session');
      const valid = await asApp((client) => issue(client, ending));
      const bystander = await asApp((client) => issue(client, other));
      const expiredJti = randomUUID();
      // Written by hand: an issuer never writes an expiry in the past.
      await asOwner((client) =>
        client.query(
          `insert into capability_handles
             (workspace_id, jti, session_id, on_behalf_of, scope, expires_at)
           values ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
          [workspaceId, expiredJti, ending, personId, JSON.stringify(SCOPE)],
        ),
      );

      await asApp((client) =>
        client.query(`update sessions set status = 'revoked' where id = $1`, [ending]),
      );

      expect(await handleState(valid.jti)).toBe('revoked');
      expect(await handleState(expiredJti)).toBe('expired');
      expect(await handleState(bystander.jti)).toBe('valid');
    });

    it('issueHandle refuses a revoked session (session_revoked), and the DB refuses the row', async () => {
      const revoked = await openSession('mcp_session', 'revoked');

      const thrown = await refusal(() => asApp((client) => issue(client, revoked)));
      expect(thrown).toBeInstanceOf(HandleIssuanceError);
      expect((thrown as HandleIssuanceError).code).toBe('session_revoked');

      await expect(asApp((client) => rawInsert(client, revoked, null))).rejects.toThrow(/I-H1/);
    });

    it('a revoked parent issues no child under its own session or a new one of another kind (parent_revoked); a child under a new Worker run session — a crash retry — is still issued', async () => {
      const entry = await openSession('entry', 'starting');
      const parent = await asApp((client) => issue(client, entry));
      await asApp((client) => revokeHandle(client, parent.jti));

      // `attenuate`: on the parent's authority, under its session.
      const thrown = await refusal(() =>
        asApp((client) =>
          issue(client, entry, parent.jti, { kind: 'parent', parentJti: parent.jti }),
        ),
      );
      expect(thrown).toBeInstanceOf(HandleIssuanceError);
      expect((thrown as HandleIssuanceError).code).toBe('parent_revoked');
      await expect(asApp((client) => rawInsert(client, entry, parent.jti))).rejects.toThrow(/I-H1/);

      // #501 on §7: only a Worker run opens a session from a parent Handle; any other new session
      // from a revoked one is refused, in code and by the trigger.
      const other = await openSession('mcp_session');
      const otherThrown = await refusal(() => asApp((client) => issue(client, other, parent.jti)));
      expect((otherThrown as HandleIssuanceError).code).toBe('parent_revoked');
      await expect(asApp((client) => rawInsert(client, other, parent.jti))).rejects.toThrow(/I-H1/);

      // `lifecycle.ts`'s crash retry mints the new run's Handle from the failed run's, revoked
      // when that run failed: the parent is lineage there, not authority.
      const retryRun = await openSession('worker_run');
      const child = await asApp((client) => issue(client, retryRun, parent.jti));
      expect(child.parentJti).toBe(parent.jti);
      expect(await handleState(child.jti)).toBe('valid');
    });

    it('a child stays usable when its parent’s session is revoked — the Handle check reads no parent chain', async () => {
      const entry = await openSession('entry', 'starting');
      const parent = await asApp((client) => issue(client, entry));
      const run = await openSession('worker_run');
      // `invoke_worker` from a Handle: on the parent's authority, under a new session.
      const child = await asApp((client) =>
        issue(client, run, parent.jti, { kind: 'parent', parentJti: parent.jti }),
      );

      await asApp((client) =>
        client.query(`update sessions set status = 'revoked' where id = $1`, [entry]),
      );

      expect(await handleState(parent.jti)).toBe('revoked');
      const claims = await authenticateHandle(pool, child.token, { publicKey }, 'source');
      expect(claims.jti).toBe(child.jti);
    });

    describe('issuing and revoking serialise on the session row', () => {
      it('revokeSession waits for an issuer holding the session and then revokes the Handle it issued', async () => {
        const sessionId = await openSession('mcp_session');
        const issued = latch();
        const commit = latch();
        let handle: IssuedHandle | undefined;
        const issuer = asApp(async (client) => {
          handle = await issue(client, sessionId);
          issued.open();
          await commit.wait;
        });
        await issued.wait;

        const revoker = asApp((client) => revokeSession(client, sessionId));
        await waitUntilBlocked('for no key update');
        commit.open();
        await issuer;
        await revoker;

        if (!handle) throw new Error('no Handle issued');
        expect(await handleState(handle.jti)).toBe('revoked');
      });

      it('marking the session revoked waits for an issuer holding it, and the trigger revokes the new Handle', async () => {
        const sessionId = await openSession('worker_run');
        const issued = latch();
        const commit = latch();
        let handle: IssuedHandle | undefined;
        const issuer = asApp(async (client) => {
          handle = await issue(client, sessionId);
          issued.open();
          await commit.wait;
        });
        await issued.wait;

        const revoker = asApp((client) =>
          client.query(`update sessions set status = 'revoked' where id = $1`, [sessionId]),
        );
        await waitUntilBlocked(`set status = 'revoked'`);
        commit.open();
        await issuer;
        await revoker;

        if (!handle) throw new Error('no Handle issued');
        expect(await handleState(handle.jti)).toBe('revoked');
      });

      it('an issuer that comes second waits for the revoking transaction and then refuses', async () => {
        const sessionId = await openSession('mcp_session');
        const revoked = latch();
        const commit = latch();
        const revoker = asApp(async (client) => {
          await client.query(`update sessions set status = 'revoked' where id = $1`, [sessionId]);
          revoked.open();
          await commit.wait;
        });
        await revoked.wait;

        const issuer = refusal(() => asApp((client) => issue(client, sessionId)));
        await waitUntilBlocked('for share');
        commit.open();
        await revoker;

        const thrown = await issuer;
        expect(thrown).toBeInstanceOf(HandleIssuanceError);
        expect((thrown as HandleIssuanceError).code).toBe('session_revoked');
      });
    });

    describe('Handles left valid under a session revoked before this release', () => {
      // 0042's remediation statements, run on this workspace's rows only.
      const migration = readFileSync(MIGRATION_0042, 'utf8');
      const audit = /^insert into audit_records[\s\S]*?;$/m.exec(migration)?.[0];
      const revoke = /^update capability_handles h\n[\s\S]*?;$/m.exec(migration)?.[0];
      const scoped = (statement: string) =>
        statement.replace("s.status = 'revoked'", "h.workspace_id = $1 and s.status = 'revoked'");

      it('I-H1 reports one, and the remediation revokes it with one audit record per person', async () => {
        expect(audit).toBeDefined();
        expect(revoke).toBeDefined();
        const sessionId = await openSession('mcp_session');
        const left = await asApp((client) => issue(client, sessionId));
        const leftToo = await asApp((client) => issue(client, sessionId));
        // A session revoked the way a release before 0042 did it: with no trigger.
        await asOwner(async (client) => {
          await client.query('set local session_replication_role = replica');
          await client.query(`update sessions set status = 'revoked' where id = $1`, [sessionId]);
        });
        expect(await handleState(left.jti)).toBe('valid');

        const before = await runInvariantChecks(pool);
        const ih1 = before.find((result) => result.invariant === 'I-H1');
        expect(ih1?.violations ?? 0).toBeGreaterThanOrEqual(2);
        expect(ih1?.sample).toEqual(
          expect.arrayContaining([`${workspaceId}:${left.jti}`, `${workspaceId}:${leftToo.jti}`]),
        );

        await asOwner(async (client) => {
          await client.query(scoped(audit as string), [workspaceId]);
          await client.query(scoped(revoke as string), [workspaceId]);
        });

        expect(await handleState(left.jti)).toBe('revoked');
        expect(await handleState(leftToo.jti)).toBe('revoked');
        const records = await asOwner((client) =>
          client.query<{ actor: string; resource_id: string; payload: Record<string, unknown> }>(
            `select actor_principal_id as actor, resource_id, payload from audit_records
              where workspace_id = $1 and action = 'principal.revoked_session_handles_revoked'`,
            [workspaceId],
          ),
        );
        expect(records.rows).toHaveLength(1);
        expect(records.rows[0]).toMatchObject({ actor: personId, resource_id: personId });
        expect(records.rows[0]?.payload).toMatchObject({
          by: 'migration governance/0042_session_revocation_revokes_handles',
          revokedHandleCount: 2,
        });

        const after = await runInvariantChecks(pool);
        expect(after.find((result) => result.invariant === 'I-H1')?.sample ?? []).not.toEqual(
          expect.arrayContaining([`${workspaceId}:${left.jti}`]),
        );
      });
    });
  },
);
